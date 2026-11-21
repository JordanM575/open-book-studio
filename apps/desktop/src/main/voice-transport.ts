import { ProviderError } from "@ai-book-studio/core/providers/types";
import type { TransportCharge, TransportOutcome } from "../../../../packages/core/src/voice-session";
import type { SpeakResult } from "./speech";
import type { VoiceTranscript } from "@ai-book-studio/core/providers/speech";

/*
 * Typed edge between the pure transport ledger (`core/voice-session/transport.ts`) and the two
 * existing provider services. It adds no provider call, retry, IPC or persistence.
 *
 * The services already refuse before spending when a saved route is missing or retired, and they
 * already carry the provider's own cost field. This file only translates those facts into the
 * ledger's settlement and charge vocabulary so a host cannot turn "not reported" into "free".
 */

/** What one dispatched request can honestly say about money. */
export function reportedCharge(costUsd: number | null | undefined): TransportCharge {
  return typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0
    ? { state: "reported", usd: costUsd }
    : { state: "unknown" };
}

export interface FailureSettlement {
  readonly outcome: Extract<TransportOutcome, "refusal" | "failure" | "cancellation">;
  readonly failure: string;
}

const MAX_FAILURE = 65_536;
const FALLBACK = "The external operation failed. Review its host receipt before continuing.";
const CANCELLED = "The request was cancelled before a reply arrived.";
/** A local deadline, distinct from a host stop. The provider may still have received the request. */
export const TIMEOUT_FAILURE = "The request timed out. It may have reached the provider; the cost is unknown.";

/** Which local clock ended the request, if any. The provider is never told which it was. */
function abortCause(error: unknown): "abort" | "timeout" | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (name === "AbortError") return "abort";
    if (name === "TimeoutError") return "timeout";
    current = (current as { options?: { cause?: unknown } }).options?.cause ??
      (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Refusal means the host/local policy stopped it before a provider request; failure means a
 * request may have been sent or attempted. Neither outcome implies a charge or a refund.
 */
/**
 * Map a thrown provider/service error. `refusal` means the request was stopped before anything was
 * sent, so a caller that has already dispatched a chunk must pass `dispatched: true`: a provider 400
 * after sending is a failure (with an unknown charge), never a pre-send refusal.
 */
export function settlementForFailure(
  error: unknown,
  options: { dispatched?: boolean } = {}
): FailureSettlement {
  const cause = abortCause(error);
  if (cause === "abort") return { outcome: "cancellation", failure: CANCELLED };
  if (cause === "timeout") return { outcome: "failure", failure: TIMEOUT_FAILURE };
  const code = error instanceof ProviderError ? error.code : null;
  const localRefusal = options.dispatched !== true &&
    (code === "invalid-request" || code === "not-found" || code === "unsupported");
  const outcome = localRefusal ? "refusal" : "failure";
  const message = error instanceof Error ? error.message.trim() : "";
  return {
    outcome,
    failure: message && message.length <= MAX_FAILURE ? message : FALLBACK,
  };
}

export interface ResultSettlement {
  readonly outcome: "success";
  /** Provider-reported only. Null stays unknown at the ledger edge. */
  readonly costUsd: number | null;
}

export function settlementForTranscript(result: VoiceTranscript): ResultSettlement {
  return {
    outcome: "success",
    costUsd: typeof result.costUsd === "number" && Number.isFinite(result.costUsd) ? result.costUsd : null,
  };
}

export function settlementForSpeech(result: SpeakResult): ResultSettlement {
  return {
    outcome: "success",
    costUsd: typeof result.costUsd === "number" && Number.isFinite(result.costUsd) ? result.costUsd : null,
  };
}

/**
 * One abortable deadline per external request. Host cancellation wins immediately; the timeout is
 * still enforced for a request the host has forgotten. This is a local gate, not proof that the
 * provider stopped work or waived a charge.
 */
export function requestSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}
