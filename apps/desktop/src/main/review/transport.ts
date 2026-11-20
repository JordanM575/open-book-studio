import { generateText } from "ai";
import { serializeProviderRequest, type ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import type { StoredCredential } from "@ai-book-studio/core/providers/types";
import { modelFor } from "../agent/transport";

/** The one provider call a reader Start makes. It has no tools, retry, repair or fallback path. */
export interface ReviewTransport {
  run(input: { envelope: ReviewEnvelope; credential: StoredCredential; signal: AbortSignal }): Promise<{ output: string }>;
}

type WireMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Sends exactly the validated provider-neutral request once. `envelope.destination.model` is the
 * only model constructor input; the caller has already performed every consent and capability check.
 */
export class AiSdkReviewTransport implements ReviewTransport {
  async run(input: { envelope: ReviewEnvelope; credential: StoredCredential; signal: AbortSignal }): Promise<{ output: string }> {
    const wire = JSON.parse(serializeProviderRequest(input.envelope)) as { messages: WireMessage[] };
    const model = modelFor(input.credential, input.envelope.destination.model);
    const result = await generateText({
      model,
      messages: wire.messages.map((message) => ({ role: message.role, content: message.content })),
      maxRetries: 0,
      abortSignal: input.signal
    });
    return { output: result.text };
  }
}
