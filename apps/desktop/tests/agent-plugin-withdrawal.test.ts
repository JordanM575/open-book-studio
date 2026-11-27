import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentEvent } from "@ai-book-studio/core/agent";
import { AgentRuntime } from "../src/main/agent/runtime";
import { Library } from "../src/main/library/store";
import type { ProviderService } from "../src/main/providers";
import type { Studio } from "../src/main/studio";

const TOOL = "record_fixture_call";

function pluginCallModel() {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined }
  };
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "fixture-call", toolName: TOOL, input: "{}" },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage }
          ]
        })
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "reply" },
            { type: "text-delta", id: "reply", delta: "Fixture turn complete." },
            { type: "text-end", id: "reply" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }
          ]
        })
      }
    ]
  });
}

test("a plugin withdrawn for one book stays unavailable in that book's Edit turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-plugin-withdrawal-"));
  try {
    const pluginPath = join(root, "plugin.ts");
    await writeFile(pluginPath, `
export const calls: string[] = [];
export default {
  name: "Fixture plugin",
  tools: [{
    name: "${TOOL}",
    description: "Record which fixture book called the tool.",
    parameters: { type: "object", properties: {} },
    handler: (_input: unknown, context: { bookId: string }) => {
      calls.push(context.bookId);
      return { bookId: context.bookId };
    }
  }]
};
`);
    const library = await Library.open(join(root, "library"));
    const enabled = await library.createBook({ title: "Plugin enabled" });
    const withdrawn = await library.createBook({ title: "Plugin withdrawn" });
    const modelChoice = { defaultConnectionId: "conn_synthetic", defaultModelId: "synthetic-model" };
    await library.updateBook(enabled.id, modelChoice);
    await library.updateBook(withdrawn.id, {
      ...modelChoice,
      settings: {
        ...withdrawn.settings,
        agent: { ...withdrawn.settings.agent, disabledTools: [TOOL] }
      }
    });

    const events: AgentEvent[] = [];
    let model = pluginCallModel();
    const runtime = new AgentRuntime(
      { library, requireLibrary: () => library } as unknown as Studio,
      {
        credential: async () => ({ provider: "openrouter", label: "Synthetic fixture" }),
        models: async () => ({ models: [] })
      } as unknown as ProviderService,
      (event) => events.push(event),
      () => model,
      () => {},
      () => root
    );

    await runtime.runToCompletion({ bookId: enabled.id, mode: "edit", prompt: "Run the fixture tool." });
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toContain(TOOL);

    // The same runtime loads the same plugin folder, and the model sends the same valid call.
    model = pluginCallModel();
    const turn = await runtime.runToCompletion({ bookId: withdrawn.id, mode: "edit", prompt: "Run the fixture tool." });
    const offered = model.doStreamCalls[0]?.tools?.map((tool) => tool.name);
    expect(offered).toContain("read_chapter");
    expect(offered).not.toContain(TOOL);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool",
      turnId: turn.turnId,
      id: "fixture-call",
      name: TOOL,
      status: "end",
      output: expect.objectContaining({ ok: false })
    }));

    const { calls } = (await import(pathToFileURL(pluginPath).href)) as { calls: string[] };
    expect(calls).toEqual([enabled.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
