import { describe, expect, test } from "bun:test";
import type { FinishReason, LanguageModel } from "ai";
import { ProviderError, type StoredCredential } from "@ai-book-studio/core/providers/types";
import { buildReviewEnvelope, serializeProviderRequest } from "@ai-book-studio/core/review/envelope";
import { builtinReaderProfile } from "@ai-book-studio/core/review/profiles";
import { input, stamp } from "../../../packages/core/tests/review/scoped-fixtures";
import { AiSdkReviewTransport, type ReviewGenerate, type ReviewGenerateOptions } from "../src/main/review/transport";

const credential: StoredCredential = {
  id: "conn_123456", provider: "meta", label: "Synthetic work account", kind: "api-key",
  createdAt: stamp, secret: "synthetic-secret"
};

async function readerEnvelope() {
  return buildReviewEnvelope({ ...input(), kind: "reader-review", profile: await builtinReaderProfile("alpha") });
}

function harness(reason: FinishReason = "stop", text = '{"findings":[]}') {
  const calls: ReviewGenerateOptions[] = [];
  const models: Array<{ credential: StoredCredential; modelId: string }> = [];
  const model = { provider: "synthetic", modelId: "synthetic/model" } as unknown as LanguageModel;
  const generate: ReviewGenerate = async (options) => {
    calls.push(options);
    return { text, finishReason: reason };
  };
  const transport = new AiSdkReviewTransport(generate, (selected, modelId) => {
    models.push({ credential: selected, modelId });
    return model;
  });
  return { calls, models, model, transport };
}

describe("one AI SDK reader transport call", () => {
  test("sends the exact validated messages once with empty tools, no retry and the abort signal", async () => {
    const envelope = await readerEnvelope();
    const wire = JSON.parse(serializeProviderRequest(envelope)) as { messages: ReviewGenerateOptions["messages"]; tools: unknown[] };
    const { calls, models, model, transport } = harness("stop", "exact synthetic text");
    const controller = new AbortController();
    const result = await transport.run({ envelope, credential, signal: controller.signal });
    expect(result).toEqual({ output: "exact synthetic text" });
    expect(calls).toHaveLength(1);
    const options = calls[0];
    if (!options) throw new Error("Missing synthetic generator call");
    expect(wire.tools).toEqual([]);
    expect(options.messages).toEqual(wire.messages);
    expect(options.messages).toHaveLength(2);
    expect(options.tools).toEqual({});
    expect(Array.isArray(options.tools)).toBe(false);
    expect(options.maxRetries).toBe(0);
    expect(options.abortSignal).toBe(controller.signal);
    expect(options.model).toBe(model);
    expect(models).toEqual([{ credential, modelId: envelope.destination.model }]);
    for (const unsupported of ["output", "outputMode", "stopWhen", "toolChoice", "maxSteps", "prepareStep", "experimental_repairToolCall"]) {
      expect(Object.hasOwn(options, unsupported)).toBe(false);
    }
  });

  test("the wire carries the schema in the system message and no responseContract", async () => {
    const envelope = await readerEnvelope();
    const wire = JSON.parse(serializeProviderRequest(envelope)) as { messages: { role: string; content: string }[]; tools: unknown[]; responseContract?: unknown };
    expect(wire.tools).toEqual([]);
    expect(Object.hasOwn(wire, "responseContract")).toBe(false);
    expect(wire.messages).toHaveLength(2);
    expect(wire.messages[0]?.content).toContain('"findingId"');
    expect(wire.messages[0]?.content).toContain("Return exactly one JSON object");
  });

  test.each([
    ["stop", "stop text", { output: "stop text" }],
    ["other", "other text", { output: "other text" }],
    ["tool-calls", "ignored tool text", { output: "" }]
  ] as const)("finish reason %s returns %o without another call", async (reason, text, expected) => {
    const { calls, transport } = harness(reason, text);
    await expect(transport.run({ envelope: await readerEnvelope(), credential, signal: new AbortController().signal })).resolves.toEqual(expected);
    expect(calls).toHaveLength(1);
  });

  test.each([
    ["content-filter", "refusal"],
    ["length", "context"],
    ["error", "unknown"],
    ["interrupted", "unknown"]
  ] as const)("finish reason %s throws %s after one call", async (reason, code) => {
    const { calls, transport } = harness(reason, "PRIVATE_PROVIDER_TEXT_SENTINEL");
    const failure = transport.run({ envelope: await readerEnvelope(), credential, signal: new AbortController().signal });
    const error = await failure.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain("PRIVATE_PROVIDER_TEXT_SENTINEL");
    expect(calls).toHaveLength(1);
  });

  test("a generator exception is not retried, repaired or completed", async () => {
    let calls = 0;
    const transport = new AiSdkReviewTransport(async () => {
      calls++;
      throw new ProviderError("rate-limit", "PRIVATE_GENERATOR_FAILURE");
    }, () => ({} as unknown as LanguageModel));
    await expect(transport.run({ envelope: await readerEnvelope(), credential, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "rate-limit" });
    expect(calls).toBe(1);
  });
});
