import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentEvent, AgentTurnInput } from "@ai-book-studio/core/agent";
import { DEFAULT_AGENT_SETTINGS } from "@ai-book-studio/core/agent/settings";
import type { ProviderService } from "../src/main/providers";
import type { Studio } from "../src/main/studio";
import { Library } from "../src/main/library/store";
import { AgentRuntime, prepareThread } from "../src/main/agent/runtime";
import { buildToolSet } from "../src/main/agent/tool-set";
import { ToolBridge } from "../src/main/agent/tool-bridge";
import { chapterToolCatalog, READ_TOOL_NAMES } from "../src/main/agent/tools";
import { DISCUSS_NEXT_STEP } from "../src/main/agent/mode";

let root: string;
let library: Library;
let bookId: string;
let chapterId: string;
let providerReads: number;
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-mode-synthetic-"));
  library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic lantern" });
  bookId = book.id;
  chapterId = (await library.createChapter(bookId, { title: "Light", content: "A synthetic lantern shone.\n" })).id;
  await library.updateBook(bookId, { defaultConnectionId: "conn_synthetic", defaultModelId: "synthetic-model" });
  providerReads = 0;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function reply() {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "text" },
    { type: "text-delta" as const, id: "text", delta: "Synthetic reply." },
    { type: "text-end" as const, id: "text" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage }
  ] }) };
}

function modelFor(calls: Array<{ name: string; args: unknown }> = []) {
  return new MockLanguageModelV4({ doStream: calls.length ? [
    { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      ...calls.map((call, index) => ({ type: "tool-call" as const, toolCallId: `call-${index}`, toolName: call.name, input: JSON.stringify(call.args) })),
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage }
    ] }) }, reply()
  ] : [reply()] });
}

function runtimeFor(model: MockLanguageModelV4, pluginFolder: () => string | null = () => null) {
  const events: AgentEvent[] = [];
  const runtime = new AgentRuntime(
    { library, requireLibrary: () => library } as unknown as Studio,
    {
      credential: async () => {
        providerReads++;
        return { id: "conn_synthetic", provider: "openrouter", label: "Synthetic", kind: "api-key", secret: "synthetic-only" };
      },
      models: async () => ({ models: [{ id: "synthetic-model", name: "Synthetic model", supportsTools: true, supportsImages: false, contextLength: 10000 }] })
    } as unknown as ProviderService,
    (event) => events.push(event), () => model, () => {}, pluginFolder
  );
  return { runtime, events };
}

async function finish(runtime: AgentRuntime, input: AgentTurnInput) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off = () => {};
  const done = new Promise<AgentEvent>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Synthetic turn did not finish")), 4000);
    off = runtime.onEvent((event) => {
      if (event.type === "done" || event.type === "stopped") resolve(event);
      if (event.type === "error" || event.type === "approval") reject(new Error(`Unexpected ${event.type}`));
    });
  });
  try {
    const started = await runtime.start(input);
    await done;
    return started;
  } finally { clearTimeout(timer); off(); }
}

async function sourceBytes() {
  const chapter = await library.readChapter(bookId, chapterId);
  return { book: await readFile(join(root, "books", bookId, "book.json"), "utf8"), chapter };
}

describe("Discuss runtime boundary", () => {
  test("offers only the six enabled reads, refuses every mutation and unknown name, and never loads plugins", async () => {
    const before = await sourceBytes();
    const denied = [...chapterToolCatalog().filter((tool) => tool.tier !== "read").map((tool) => tool.name), "plugin_write", "future_read", "constructor"];
    const model = modelFor(denied.map((name) => ({ name, args: { chapterId, text: "overwrite", content: "overwrite" } })));
    const { runtime, events } = runtimeFor(model, () => { throw new Error("Discuss loaded a plugin folder"); });
    const started = await finish(runtime, { bookId, prompt: "Change everything", mode: "discuss" });
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name).sort()).toEqual([...READ_TOOL_NAMES].sort());
    expect(await sourceBytes()).toEqual(before);
    expect(events.some((event) => event.type === "approval")).toBe(false);
    for (const name of denied) {
      expect(events.some((event) => event.type === "tool" && event.name === name && event.status === "end" && event.detail === DISCUSS_NEXT_STEP)).toBe(true);
    }
    const thread = await library.threads.read(bookId, started.threadId);
    expect(thread?.messages.map((message) => message.mode)).toEqual(["discuss", "discuss"]);
    expect(thread?.checkpointTurns).toEqual([]);
  });

  test("a permitted read works while a withdrawn read remains unoffered and refused", async () => {
    await library.updateBook(bookId, { settings: { ...(await library.readBook(bookId)).book.settings, agent: { ...DEFAULT_AGENT_SETTINGS, disabledTools: ["table_of_contents"] } } });
    const model = modelFor([{ name: "read_chapter", args: { chapterId } }, { name: "table_of_contents", args: {} }]);
    const { runtime, events } = runtimeFor(model);
    const before = await sourceBytes();
    await finish(runtime, { bookId, mode: "discuss", prompt: "Read it" });
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name).sort()).toEqual(READ_TOOL_NAMES.filter((name) => name !== "table_of_contents").sort());
    expect(JSON.stringify(events.find((event) => event.type === "tool" && event.name === "read_chapter" && event.status === "end"))).toContain("synthetic lantern");
    expect(await sourceBytes()).toEqual(before);
  });

  test("tool-set and bridge deny plugins, disabled tools and mutations even with destructive opt-in", async () => {
    const before = await sourceBytes();
    let pluginCalls = 0;
    const tools = buildToolSet(library, bookId, { mode: "discuss", pluginTools: [{ name: "plugin_write", description: "Synthetic", parameters: { type: "object" }, handler: () => { pluginCalls++; } }] });
    expect(Object.keys(tools).sort()).toEqual([...READ_TOOL_NAMES].sort());
    const bridge = new ToolBridge(() => library, () => { throw new Error("Discuss loaded plugins"); });
    expect((await bridge.catalogFor(bookId, "discuss")).map((tool) => tool.name).sort()).toEqual([...READ_TOOL_NAMES].sort());
    for (const name of [...chapterToolCatalog().filter((tool) => tool.tier !== "read").map((tool) => tool.name), "plugin_write", "future_read"]) {
      await expect(bridge.run({ bookId, mode: "discuss", name, args: { chapterId }, allowDestructive: true })).rejects.toThrow(DISCUSS_NEXT_STEP);
    }
    expect(pluginCalls).toBe(0);
    expect(await sourceBytes()).toEqual(before);
    await library.updateBook(bookId, { settings: { ...(await library.readBook(bookId)).book.settings, agent: { ...DEFAULT_AGENT_SETTINGS, disabledTools: ["read_chapter"] } } });
    await expect(bridge.run({ bookId, mode: "discuss", name: "read_chapter", args: { chapterId } })).rejects.toThrow("turned off");
  });

  test("rejects invalid mode, guidance and plan boundaries before provider or thread access", async () => {
    const { runtime } = runtimeFor(modelFor());
    const plan = { id: "plan-1", revision: 1, action: "start" as const };
    const cases: Array<[unknown, string]> = [
      [{ bookId, prompt: "Read", mode: "invalid" }, "invalid-mode"],
      [{ bookId, prompt: "Read" }, "invalid-mode"],
      [{ bookId, prompt: "Read", mode: "edit", guidance: "x".repeat(2001) }, "invalid-guidance"],
      [{ bookId, prompt: "Read", mode: "edit", guidance: "" }, "invalid-guidance"],
      [{ bookId, prompt: "Read", mode: "edit", guidance: "   " }, "invalid-guidance"],
      [{ bookId, prompt: "Read", mode: "discuss", plan }, "plan-in-discuss"],
      [{ bookId, prompt: "Read", mode: "edit", plan }, "plan-without-thread"]
    ];
    for (const [input, refusal] of cases) {
      await expect(runtime.start(input as AgentTurnInput)).rejects.toMatchObject({
        code: "invalid-request",
        refusal
      });
    }
    expect(providerReads).toBe(0);
    expect(await library.threads.list(bookId)).toEqual([]);
  });

  test("an overlong saved tone is refused without rewriting source or contacting a provider", async () => {
    const path = join(root, "books", bookId, "book.json");
    const book = JSON.parse(await readFile(path, "utf8"));
    book.settings.agent.tone = "t".repeat(501);
    const raw = JSON.stringify(book);
    await writeFile(path, raw);
    const { runtime } = runtimeFor(modelFor());
    await expect(runtime.start({ bookId, mode: "discuss", prompt: "Read" })).rejects.toThrow(/tone/);
    expect(providerReads).toBe(0);
    expect(await readFile(path, "utf8")).toBe(raw);
  });
});

describe("fixed guidance and Edit compatibility", () => {
  test("captures mode and exact bounded guidance before awaiting; the next turn gets no old guidance", async () => {
    const tone = "t".repeat(500);
    await library.updateBook(bookId, { settings: { ...(await library.readBook(bookId)).book.settings, agent: { ...DEFAULT_AGENT_SETTINGS, tone, answerLength: "detailed" } } });
    const guidance = `Only this request ${"g".repeat(1982)}`;
    expect(guidance.length).toBe(2000);
    const first = modelFor();
    const { runtime } = runtimeFor(first);
    const input: AgentTurnInput = { bookId, mode: "discuss", prompt: "Read", guidance };
    const pending = finish(runtime, input);
    input.mode = "edit";
    input.guidance = "MUTATED AFTER SUBMISSION";
    const started = await pending;
    const sent = JSON.stringify(first.doStreamCalls[0]?.prompt);
    expect(sent).toContain(guidance);
    expect(sent).toContain(tone);
    expect(sent).toContain("Answer length: detailed");
    expect(sent).not.toContain("MUTATED AFTER SUBMISSION");
    expect(first.doStreamCalls[0]?.prompt.find((message) => message.role === "system")?.content).not.toContain(guidance);
    expect(JSON.stringify(first.doStreamCalls[0]?.prompt.find((message) => message.role === "user"))).toContain(guidance);
    const stored = await library.threads.read(bookId, started.threadId);
    expect(stored?.messages[0]?.parts).toContainEqual({ type: "guidance", text: guidance });
    expect(stored?.messages[1]?.mode).toBe("discuss");
    expect(stored?.messages[1]?.model).toMatchObject({ modelId: "synthetic-model", connectionLabel: "Synthetic" });
    const second = modelFor();
    await finish(runtimeFor(second).runtime, { bookId, threadId: started.threadId, mode: "discuss", prompt: "Read again" });
    expect(JSON.stringify(second.doStreamCalls[0]?.prompt)).not.toContain(guidance);
    expect(second.doStreamCalls[0]?.tools).toEqual(first.doStreamCalls[0]?.tools);
  });

  test("retries reuse only the same prompt, mode and guidance, preserving earlier requests", async () => {
    const input = { bookId, prompt: "Read", mode: "discuss" as const, guidance: "Be brief" };
    const first = await prepareThread(library.threads, input);
    const again = await prepareThread(library.threads, { ...input, threadId: first.thread.id });
    expect(again.reused).toBe(true);
    const changed = await prepareThread(library.threads, { ...input, mode: "edit", threadId: first.thread.id });
    expect(changed.reused).toBe(false);
    const revised = await prepareThread(library.threads, { ...input, guidance: "Be detailed", threadId: first.thread.id });
    expect(revised.reused).toBe(false);
    expect(revised.thread.messages).toHaveLength(3);
    expect(revised.thread.messages[0]?.mode).toBe("discuss");
  });

  test("Edit applies an ordinary checked write and one-turn undo restores it", async () => {
    const before = await library.readChapter(bookId, chapterId);
    const model = modelFor([{ name: "append_to_chapter", args: { chapterId, text: "A second synthetic light." } }]);
    const { runtime } = runtimeFor(model);
    const started = await finish(runtime, { bookId, mode: "edit", prompt: "Append", guidance: "Use plain words" });
    expect((await library.readChapter(bookId, chapterId)).content).toContain("second synthetic light");
    const thread = await library.threads.read(bookId, started.threadId);
    expect(thread?.messages[1]?.mode).toBe("edit");
    expect(await runtime.undoLast(bookId, started.turnId)).toMatchObject({ restored: 1, skipped: 0 });
    expect((await library.readChapter(bookId, chapterId)).content).toBe(before.content);
  });

  test("a failed runtime attempt keeps attribution; actual retry reuses its request without losing guidance", async () => {
    const failedModel = new MockLanguageModelV4({ doStream: async () => { throw new Error("Synthetic failure"); } });
    const input: AgentTurnInput = { bookId, mode: "discuss", prompt: "Read", guidance: "Stay concise" };
    await expect(finish(runtimeFor(failedModel).runtime, input)).rejects.toThrow("Unexpected error");
    const threadId = (await library.threads.list(bookId))[0]?.id;
    if (!threadId) throw new Error("Missing failed turn's conversation");
    const first = await library.threads.read(bookId, threadId);
    expect(first?.messages.map((message) => message.mode)).toEqual(["discuss", "discuss"]);
    expect(first?.messages[0]?.parts).toContainEqual({ type: "guidance", text: "Stay concise" });
    expect(first?.messages[1]?.parts.some((part) => part.type === "error")).toBe(true);
    const retryModel = modelFor();
    await finish(runtimeFor(retryModel).runtime, { ...input, threadId });
    const retried = await library.threads.read(bookId, threadId);
    expect(retried?.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(JSON.stringify(retryModel.doStreamCalls[0]?.prompt)).toContain("Stay concise");
    expect(retried?.messages[1]).toEqual(first?.messages[1]);
    const changed = modelFor();
    await finish(runtimeFor(changed).runtime, { ...input, mode: "edit", guidance: "New guidance", threadId });
    const final = await library.threads.read(bookId, threadId);
    expect(final?.messages.slice(-2).map((message) => message.mode)).toEqual(["edit", "edit"]);
    expect(final?.messages.at(-2)?.parts).toContainEqual({ type: "guidance", text: "New guidance" });
    expect(JSON.stringify(changed.doStreamCalls[0]?.prompt)).not.toContain("Stay concise");
  });
});
