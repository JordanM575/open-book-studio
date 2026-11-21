import { generateText, type FinishReason, type LanguageModel, type ModelMessage } from "ai";
import { serializeProviderRequest, type ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import { ProviderError, type StoredCredential } from "@ai-book-studio/core/providers/types";
import { modelFor } from "../agent/transport";

/** The one provider call a reader Start makes. It has no tools, retry, repair or fallback path. */
export interface ReviewTransport {
  run(input: { envelope: ReviewEnvelope; credential: StoredCredential; signal: AbortSignal }): Promise<{ output: string }>;
}

export type ReviewGenerateOptions = Parameters<typeof generateText>[0];
export type ReviewGenerate = (options: ReviewGenerateOptions) => Promise<{ readonly text: string; readonly finishReason: FinishReason }>;
export type ReviewModelFactory = (credential: StoredCredential, modelId: string) => LanguageModel;

type Wire = { contractVersion?: unknown; messages?: unknown; tools?: unknown };

/**
 * Sends exactly the validated provider-neutral request once. `envelope.destination.model` is the
 * only model constructor input; the caller has already performed every consent and capability check.
 *
 * A reader-review wire carries two messages, the findings schema in the system message and exactly
 * no tools. The empty array is represented as `{}` at the one SDK call. There is no output schema,
 * tool loop, retry, repair, fallback or second completion.
 */
export class AiSdkReviewTransport implements ReviewTransport {
  constructor(
    private readonly generate: ReviewGenerate = generateText as ReviewGenerate,
    private readonly modelFactory: ReviewModelFactory = modelFor
  ) {}

  async run(input: { envelope: ReviewEnvelope; credential: StoredCredential; signal: AbortSignal }): Promise<{ output: string }> {
    const wire = JSON.parse(serializeProviderRequest(input.envelope)) as Wire;
    if (wire.contractVersion !== 1 || !Array.isArray(wire.messages) || wire.messages.length !== 2 ||
        !Array.isArray(wire.tools) || wire.tools.length !== 0) {
      throw new ProviderError("invalid-request", "The review request did not match the disclosed messages and empty tools. No provider request was sent.");
    }
    const messages = wire.messages;
    for (const message of messages) {
      if (!message || typeof message !== "object") {
        throw new ProviderError("invalid-request", "The review request contained an invalid message. No provider request was sent.");
      }
      const candidate = message as { role?: unknown; content?: unknown };
      if ((candidate.role !== "system" && candidate.role !== "user") || typeof candidate.content !== "string") {
        throw new ProviderError("invalid-request", "The review request contained an invalid message. No provider request was sent.");
      }
    }
    const model = this.modelFactory(input.credential, input.envelope.destination.model);
    const result = await this.generate({
      model,
      messages: messages as ModelMessage[],
      tools: {},
      maxRetries: 0,
      abortSignal: input.signal
    });
    switch (result.finishReason) {
      case "content-filter":
        throw new ProviderError("refusal", "The provider refused this request.");
      case "length":
        throw new ProviderError("context", "The provider stopped at its context or output limit.");
      case "tool-calls":
        // No tools were offered, so no tool result can be used. The exact parser reports malformed.
        return { output: "" };
      case "error":
      case "interrupted":
        throw new ProviderError("unknown", "The provider did not finish the request.");
      case "stop":
      case "other":
        return { output: result.text };
      default:
        throw new ProviderError("unknown", "The provider returned an unknown finish reason.");
    }
  }
}
