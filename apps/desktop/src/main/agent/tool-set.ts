import { jsonSchema, tool, type ToolSet } from "ai";
import {
  isZodParameters,
  validatePluginArgs,
  type PluginLibrary,
  type PluginParameters,
  type PluginTool
} from "@ai-book-studio/core/agent/plugins";
import {
  PLAN_STEP_TOOL_NAME,
  PROPOSE_PLAN_TOOL_NAME
} from "@ai-book-studio/core/agent/plan-tools";
import { createChapterTools, READ_TOOL_NAMES, type ChapterChange, type ProposedBases } from "./tools";
import type { ProviderOptions } from "./cache";
import type { Library } from "../library/store";
import type { AgentMode } from "@ai-book-studio/core/agent/messages";
import { DISCUSS_NEXT_STEP, modeAllowsTool } from "./mode";

/**
 * The agent's tool set for one book.
 *
 * It is the built-in tools the author has not withdrawn, plus the tools the loaded plugins provide
 * (FR-004, FR-007). A plugin tool may not shadow a built-in one: the built-in name wins, so a
 * plugin cannot quietly replace the tool the author expects.
 */
export function buildToolSet(
  library: Library,
  bookId: string,
  options: {
    /** Legacy direct callers use Edit; the runtime always supplies its validated mode. */
    mode?: AgentMode;
    disabledTools?: string[];
    pluginTools?: PluginTool[];
    onBeforeChange?: (change: ChapterChange) => void | Promise<void>;
    /** What each paused destructive call was proposed against, so its approved run writes against it. */
    proposed?: ProposedBases;
    /**
     * The provider options for the last tool definition.
     *
     * A provider caches the tool block as one prefix, so the marker belongs on the last tool and
     * nowhere else (FR-001).
     */
    toolProviderOptions?: ProviderOptions;
    /**
     * The plan turn's `plan_step` and its ordinary-tool gate. Present only on a Start or Resume
     * turn. The plan tools are never disabled by the author's tool settings and are never
     * shadowed by a plugin.
     */
    plan?: {
      stepTool: ToolSet[string];
      /** A fixed refusal when a book tool cannot be attributed to a reviewed step. */
      gate: () => string | null;
    };
    /**
     * The read-only proposal turn's `propose_plan`. Its presence makes the built-in set the six
     * read tools only and loads no plugins.
     */
    planProposal?: { proposeTool: ToolSet[string] };
  } = {}
): ToolSet {
  const disabled = new Set(options.disabledTools ?? []);
  const mode = options.mode ?? "edit";
  const proposal = options.planProposal !== undefined;
  const tools: ToolSet = Object.create(null);
  for (const [name, definition] of Object.entries(createChapterTools(library, bookId, options.onBeforeChange, options.proposed))) {
    if (disabled.has(name) || !modeAllowsTool(mode, name)) continue;
    if (proposal && !(READ_TOOL_NAMES as readonly string[]).includes(name)) continue;
    tools[name] = definition as ToolSet[string];
  }
  for (const plugin of mode === "edit" && !proposal ? options.pluginTools ?? [] : []) {
    if (disabled.has(plugin.name)) continue;
    if (plugin.name in tools) continue;
    tools[plugin.name] = tool({
      description: plugin.description,
      inputSchema: pluginInputSchema(plugin.parameters),
      execute: (async (input: unknown) => {
        const checked = validatePluginArgs(plugin.parameters, input);
        if (!checked.ok) {
          return { ok: false, message: `Those arguments do not fit ${plugin.name}: ${checked.reason}` } as never;
        }
        const result = await plugin.handler(checked.value as never, {
          bookId,
          library: pluginLibrary(library)
        });
        return { ok: true, message: "Done.", result } as never;
      }) as never
    }) as ToolSet[string];
  }
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute;
    if (!execute) continue;
    definition.execute = (input, context) => {
      if (disabled.has(name) || !modeAllowsTool(mode, name)) throw new Error(DISCUSS_NEXT_STEP);
      return execute(input, context);
    };
  }
  // Every ordinary book tool on a plan turn needs an active reviewed step. The refusal is a tool
  // result, so it fails the call without failing the active step or writing plan state.
  if (options.plan) {
    const gate = options.plan.gate;
    for (const [name, definition] of Object.entries(tools)) {
      if (name === PLAN_STEP_TOOL_NAME) continue;
      const execute = definition.execute;
      if (!execute) continue;
      definition.execute = async (input, context) => {
        const refusal = gate();
        if (refusal) return { ok: false, message: refusal } as never;
        return execute(input, context);
      };
    }
  }
  // The plan control tools come last: a plugin cannot shadow them, and the author's disabled-tool
  // settings never remove them.
  if (mode === "edit" && options.plan) {
    tools[PLAN_STEP_TOOL_NAME] = options.plan.stepTool;
  }
  if (mode === "edit" && options.planProposal) {
    tools[PROPOSE_PLAN_TOOL_NAME] = options.planProposal.proposeTool;
  }
  if (options.toolProviderOptions) {
    const names = Object.keys(tools);
    const last = names[names.length - 1];
    if (last) {
      tools[last] = { ...tools[last], providerOptions: options.toolProviderOptions } as ToolSet[string];
    }
  }
  return tools;
}

/**
 * The schema the AI SDK takes for a plugin tool.
 *
 * A Zod schema is passed straight through. A JSON Schema is wrapped, so a plugin file needs no
 * imports at all.
 */
export function pluginInputSchema(parameters: PluginParameters): never {
  if (isZodParameters(parameters)) return parameters as never;
  return jsonSchema(parameters as never) as never;
}

/**
 * The library a plugin may use.
 *
 * It is the narrow set from the plugin contract, so a plugin cannot reach anything the built-in
 * tools could not (FR-008).
 */
export function pluginLibrary(library: Library): PluginLibrary {
  return {
    async readBook(bookId) {
      const { book } = await library.readBook(bookId);
      return {
        title: book.title,
        description: book.description,
        characters: book.characters,
        memories: book.memories
      };
    },
    readChapter: (bookId, chapterId) => library.readChapter(bookId, chapterId),
    async listChapters(bookId) {
      const { chapters } = await library.readBook(bookId);
      return chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        order: chapter.order,
        wordCount: chapter.wordCount
      }));
    },
    async saveChapter(bookId, chapterId, content, expected) {
      const result = await library.saveChapter(bookId, chapterId, content, expected);
      return result.status === "saved"
        ? { status: "saved", chapter: result.chapter }
        : { status: "conflict" };
    },
    async appendToChapter(bookId, chapterId, text) {
      const chapter = await library.readChapter(bookId, chapterId);
      const content = chapter.content.trim()
        ? `${chapter.content.replace(/\s+$/, "")}\n\n${text.trim()}\n`
        : `${text.trim()}\n`;
      const saved = await library.saveChapter(bookId, chapterId, content, {
        baseVersion: chapter.version,
        baseHash: chapter.hash
      });
      if (saved.status === "conflict") {
        throw new Error("The chapter changed on disk. Read it again and append once more.");
      }
      return saved.chapter;
    }
  };
}
