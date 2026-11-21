import { normalizeProviderError } from "@ai-book-studio/core/providers/errors";
import {
  inspectWav,
  openRouterSpeechRequest,
  parseOpenRouterSpeechResponse,
  parseSpeechResponse,
  speechModels,
  speechForm,
  type SpeechCapability,
  type VoiceTranscript
} from "@ai-book-studio/core/providers/speech";
import type { VoiceTranscriptionOutcome } from "@ai-book-studio/core/ipc";
import { ProviderError, type ConnectionSummary } from "@ai-book-studio/core/providers/types";
import type { ProviderService } from "./providers";
import { redact } from "@ai-book-studio/core/providers/redact";
import { requestSignal, settlementForFailure } from "./voice-transport";
import { VoiceRefusal, type ResolvedVoiceRoute, type VoiceRequestScope } from "./voice-request";

const TRANSCRIBE_TIMEOUT_MS = 120_000;
const CANCELLED_MESSAGE = "The transcription request was cancelled.";

export interface TranscribeInput {
  audio: Uint8Array;
  languageBias?: string[];
  keywords?: string[];
}

/**
 * The only place audio leaves the studio. The saved selection, the connection and the credential
 * are resolved by the host-created scope, which re-checks them immediately before the single
 * send; this service never falls back to another connection, model or route.
 *
 * The audio is validated before any request is shaped, it stays in memory and it is discarded
 * after the call. A request cancelled mid-flight is never delivered to the caller.
 */
export class VoiceService {
  constructor(
    private readonly providers: ProviderService,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Connections that can transcribe audio, for the editor's microphone state. */
  async connections(): Promise<ConnectionSummary[]> {
    return (await this.providers.list()).filter((connection) => speechModels(connection.provider).length > 0);
  }

  async transcribe(input: TranscribeInput, scope: VoiceRequestScope): Promise<VoiceTranscriptionOutcome> {
    const check = inspectWav(input.audio);
    if (!check.ok) {
      scope.refuse(check.reason);
      return { status: "refusal", message: check.reason, receipt: scope.view() };
    }

    let route: ResolvedVoiceRoute;
    try {
      route = await scope.recheck();
    } catch (error) {
      return this.refused(scope, error);
    }

    const capability = route.capability as SpeechCapability;
    const credential = route.credential;
    const isMeta = credential.provider === "meta";
    const body = isMeta
      ? speechForm(input.audio, {
          mode: "PUSH_TO_TALK",
          ...(input.languageBias?.length ? { languageBias: input.languageBias } : {}),
          ...(input.keywords?.length ? { keywords: input.keywords } : {})
        })
      : JSON.stringify(openRouterSpeechRequest(input.audio, capability.model));

    const next = scope.chunk();
    if (!next) return this.stopped(scope);
    const { chunkId } = next;

    let response: Response;
    try {
      response = await this.fetchImpl(capability.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.secret}`,
          ...(isMeta ? {} : { "content-type": "application/json" })
        },
        body,
        signal: requestSignal(TRANSCRIBE_TIMEOUT_MS, next.signal)
      });
    } catch (error) {
      if (scope.signal.aborted) return this.cancelled(scope, chunkId);
      const offline = new ProviderError("offline", "Could not reach the transcription service. Check your connection.", {
        provider: credential.provider,
        cause: error
      });
      return this.failed(scope, chunkId, offline);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      if (scope.signal.aborted) return this.cancelled(scope, chunkId);
      const normalized = normalizeProviderError({ provider: credential.provider, status: response.status, body: errorBody });
      return this.failed(scope, chunkId, normalized);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // fetch resolved at the headers; a stop during the body read still has to settle as one.
      if (scope.signal.aborted) return this.cancelled(scope, chunkId);
      return this.failed(scope, chunkId, new ProviderError("unknown", "The transcription response could not be read.", {
        provider: credential.provider,
        cause: error
      }));
    }

    let parsedCost: number | null = null;
    let transcript: VoiceTranscript;
    try {
      if (isMeta) {
        const parsed = parseSpeechResponse(payload);
        transcript = {
          text: parsed.text,
          provider: credential.provider,
          connectionLabel: route.connectionLabel,
          model: capability.model,
          durationMs: parsed.providerDurationMs ?? check.info.durationMs,
          costUsd: null,
          turns: parsed.turns
        };
      } else {
        const parsed = parseOpenRouterSpeechResponse(payload);
        parsedCost = parsed.costUsd ?? null;
        transcript = {
          text: parsed.text,
          provider: credential.provider,
          connectionLabel: route.connectionLabel,
          model: capability.model,
          durationMs: parsed.durationMs ?? check.info.durationMs,
          costUsd: parsed.costUsd,
          turns: []
        };
      }
    } catch (error) {
      if (scope.signal.aborted) {
        // A late, unreadable reply after a stop: charge unknown, outcome failure, content dropped.
        scope.settle(chunkId, { outcome: "failure", failure: "The transcription response could not be read." });
        return this.cancelled(scope, null);
      }
      return this.failed(scope, chunkId, error);
    }
    // Record the outcome at the chunk before any content is delivered, so a late provider report
    // is never lost. If the author stopped meanwhile, the transcript is discarded but the charge
    // stays on the receipt.
    scope.settle(chunkId, { outcome: "success", costUsd: parsedCost });
    if (scope.signal.aborted) return this.cancelled(scope, null);
    return { status: "success", transcript, receipt: unreachableView(scope) };
  }

  /** The refusal path: nothing was sent, or nothing more was sent after a settled chunk. */
  private refused(scope: VoiceRequestScope, error: unknown): VoiceTranscriptionOutcome {
    if (scope.signal.aborted) return this.cancelled(scope, null);
    const reason = error instanceof VoiceRefusal
      ? error.message
      : "The transcription request could not be prepared. Try again.";
    scope.refuse(reason);
    return { status: "refusal", message: reason, receipt: scope.view() };
  }

  private cancelled(scope: VoiceRequestScope, chunkId: number | null): VoiceTranscriptionOutcome {
    if (chunkId !== null) {
      scope.settle(chunkId, { outcome: "cancellation", failure: CANCELLED_MESSAGE });
    }
    return { status: "cancellation", message: CANCELLED_MESSAGE, receipt: scope.view() };
  }

  private failed(scope: VoiceRequestScope, chunkId: number, error: unknown): VoiceTranscriptionOutcome {
    const settlement = settlementForFailure(error, { dispatched: true });
    const failure = redact(settlement.failure);
    scope.settle(chunkId, { outcome: settlement.outcome, failure });
    return { status: "failure", message: failure, receipt: scope.view() };
  }

  /** The ledger declined to open the chunk; the operation is already settled or refusing. */
  private stopped(scope: VoiceRequestScope): VoiceTranscriptionOutcome {
    const view = scope.view();
    const status = view?.status;
    if (status === "cancellation") return { status: "cancellation", message: CANCELLED_MESSAGE, receipt: view };
    return {
      status: "refusal",
      message: view?.message ?? "The transcription request stopped before it could be sent.",
      receipt: view
    };
  }
}

/** A settled view always exists after settle; this only satisfies the type checker. */
function unreachableView(scope: VoiceRequestScope) {
  const view = scope.view();
  if (!view) throw new Error("The voice request lost its operation view.");
  return view;
}
