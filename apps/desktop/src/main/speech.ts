import { normalizeProviderError } from "@ai-book-studio/core/providers/errors";
import {
  chunkForSpeech,
  joinAudio,
  ttsModels,
  ttsRequestBody,
  wrapPcmAsWav,
  type SpokenAudio,
} from "@ai-book-studio/core/providers/tts";
import type { VoiceSpokenOutcome } from "@ai-book-studio/core/ipc";
import { ProviderError, type ConnectionSummary } from "@ai-book-studio/core/providers/types";
import type { ProviderService } from "./providers";
import { redact } from "@ai-book-studio/core/providers/redact";
import { requestSignal, settlementForFailure } from "./voice-transport";
import { VoiceRefusal, type ResolvedVoiceRoute, type VoiceRequestScope } from "./voice-request";
import type { TtsCapability } from "@ai-book-studio/core/providers/tts";

const SPEAK_TIMEOUT_MS = 120_000;
const CANCELLED_MESSAGE = "The speaking request was cancelled.";

/** OpenRouter documents audio/pcm as signed 16-bit little-endian, not audio/L16 (big-endian). */
function isExpectedPcm(contentType: string, sampleRate: number): boolean {
  const [mediaType, ...parameters] = contentType.split(";");
  if (mediaType?.trim().toLowerCase() !== "audio/pcm") return false;
  const seen = new Set<string>();
  for (const parameter of parameters) {
    const match = /^\s*([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|([^\s";]+))\s*$/.exec(parameter);
    if (!match?.[1]) return false;
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3];
    if (seen.has(key)) return false;
    seen.add(key);
    // Unknown format parameters cannot safely be interpreted as 16-bit mono samples.
    if (key === "rate" ? value !== String(sampleRate) : key === "channels" ? value !== "1" : true) return false;
  }
  return true;
}

export interface SpeakInput {
  text: string;
  speed?: number;
  instructions?: string;
}

export interface SpeakResult extends SpokenAudio {
  connectionLabel: string;
  model: string;
  voice: string;
  /** How many requests it took, because a chapter is more than one. */
  chunks: number;
  /** What the request cost, when the service reported it. */
  costUsd: number | null;
}

/**
 * The speaking half of the voice pipeline.
 *
 * `VoiceService` listens: it sends a recording to a transcription service and returns words. This
 * speaks: it sends words to a voice service and returns audio. Together they close the loop the
 * ambient agent needs — the author talks, the agent answers, and the answer comes back in a voice
 * rather than as a silent line of text.
 *
 * It only speaks through the saved pinned route the host resolved. The route is re-checked before
 * every chunk; a change stops the run with a refusal, never a substitute. Provider failures never
 * trigger a second paid request.
 *
 * The text is split at sentence boundaries before it is sent, because one request carries a few
 * thousand characters and a chapter is far longer, and the audio is joined back into one sound.
 */
export class SpeechService {
  constructor(
    private readonly providers: ProviderService,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Connections that can speak, for the panel that offers a voice. */
  async connections(): Promise<ConnectionSummary[]> {
    return (await this.providers.list()).filter((connection) => ttsModels(connection.provider).length > 0);
  }

  async speak(input: SpeakInput, scope: VoiceRequestScope): Promise<VoiceSpokenOutcome> {
    const text = input.text.trim();
    if (!text) {
      scope.refuse("There is nothing to say.");
      return { status: "refusal", message: "There is nothing to say.", receipt: scope.view() };
    }

    let firstRoute: ResolvedVoiceRoute;
    try {
      firstRoute = await scope.recheck();
    } catch (error) {
      return this.refused(scope, error);
    }

    const chunks = chunkForSpeech(text);
    if (chunks.length === 0) {
      scope.refuse("There is nothing to say.");
      return { status: "refusal", message: "There is nothing to say.", receipt: scope.view() };
    }

    const parts: Uint8Array[] = [];
    let fetched = 0;
    for (const chunkText of chunks) {
      let route: ResolvedVoiceRoute;
      try {
        route = await scope.recheck();
      } catch (error) {
        // Chunks already fetched are discarded; none of them is played.
        return this.refused(scope, error);
      }
      const capability = route.capability as TtsCapability;
      const next = scope.chunk();
      if (!next) return this.stopped(scope);

      const body = ttsRequestBody(chunkText, {
        // The capability names the model: OpenRouter's ids are not OpenAI's.
        model: capability.model,
        voice: route.route.voice as string,
        responseFormat: capability.responseFormat,
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {})
      });

      let response: Response;
      try {
        response = await this.fetchImpl(capability.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${route.credential.secret}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(body),
          signal: requestSignal(SPEAK_TIMEOUT_MS, next.signal)
        });
      } catch (error) {
        if (scope.signal.aborted) return this.cancelled(scope, next.chunkId);
        const offline = new ProviderError("offline", "Could not reach the voice service. Check your connection.", {
          provider: route.credential.provider,
          cause: error
        });
        return this.failed(scope, next.chunkId, offline);
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        if (scope.signal.aborted) return this.cancelled(scope, next.chunkId);
        const normalized = normalizeProviderError({
          provider: route.credential.provider,
          status: response.status,
          body: detail
        });
        return this.failed(scope, next.chunkId, normalized);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (scope.signal.aborted) return this.cancelled(scope, next.chunkId);
        return this.failed(scope, next.chunkId, error);
      }
      if (bytes.byteLength === 0) {
        return this.failed(scope, next.chunkId, new ProviderError("unknown", "The voice service returned no audio."));
      }

      if (capability.responseFormat === "pcm") {
        if (!capability.sampleRate || !isExpectedPcm(contentType, capability.sampleRate) || bytes.byteLength % 2 !== 0) {
          return this.failed(scope, next.chunkId, new ProviderError("unknown", "The voice service returned incompatible or incomplete PCM audio."));
        }
      } else {
        // Preserve the existing direct-OpenAI behavior for an absent header, but never join an
        // explicitly different format (including PCM or a successful JSON error) as MP3.
        if (type && type !== "audio/mpeg" && type !== "audio/mp3") {
          return this.failed(scope, next.chunkId, new ProviderError("unknown", "The voice service did not return MP3 audio."));
        }
      }
      parts.push(bytes);
      fetched += 1;
      // TTS reports no per-chunk cost today; the ledger records the dispatch with unknown charge.
      scope.settle(next.chunkId, { outcome: "success", costUsd: null });
      if (scope.signal.aborted) return this.cancelled(scope, null);
    }

    let bytes = joinAudio(parts);
    const pinned = firstRoute;
    const ttsCapability = pinned.capability as TtsCapability;
    if (ttsCapability.responseFormat === "pcm") {
      if (!ttsCapability.sampleRate) {
        return {
          status: "failure",
          message: "The voice service returned incompatible or incomplete PCM audio.",
          receipt: scope.view()
        };
      }
      bytes = wrapPcmAsWav(bytes, {
        sampleRate: ttsCapability.sampleRate,
        channels: 1,
        bitsPerSample: 16
      });
    }

    const mimeType = ttsCapability.responseFormat === "pcm" ? "audio/wav" : "audio/mpeg";
    const reply = {
      dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
      mimeType,
      characters: text.length,
      chunks: fetched,
      connectionLabel: pinned.connectionLabel,
      model: pinned.route.model,
      ...(pinned.route.voice !== null ? { voice: pinned.route.voice } : {})
    };
    const receipt = scope.view();
    if (scope.signal.aborted) {
      return { status: "cancellation", message: CANCELLED_MESSAGE, receipt };
    }
    return { status: "success", reply, receipt: receipt ?? unreachableView(scope) };
  }

  private refused(scope: VoiceRequestScope, error: unknown): VoiceSpokenOutcome {
    if (scope.signal.aborted) return this.cancelled(scope, null);
    const reason = error instanceof VoiceRefusal
      ? error.message
      : "The speaking request could not be prepared. Try again.";
    scope.refuse(reason);
    return { status: "refusal", message: reason, receipt: scope.view() };
  }

  private cancelled(scope: VoiceRequestScope, chunkId: number | null): VoiceSpokenOutcome {
    if (chunkId !== null) {
      scope.settle(chunkId, { outcome: "cancellation", failure: CANCELLED_MESSAGE });
    }
    return { status: "cancellation", message: CANCELLED_MESSAGE, receipt: scope.view() };
  }

  private failed(scope: VoiceRequestScope, chunkId: number, error: unknown): VoiceSpokenOutcome {
    const settlement = settlementForFailure(error, { dispatched: true });
    const failure = redact(settlement.failure);
    scope.settle(chunkId, { outcome: settlement.outcome, failure });
    return { status: "failure", message: failure, receipt: scope.view() };
  }

  private stopped(scope: VoiceRequestScope): VoiceSpokenOutcome {
    const view = scope.view();
    const status = view?.status;
    if (status === "cancellation") return { status: "cancellation", message: CANCELLED_MESSAGE, receipt: view };
    return {
      status: "refusal",
      message: view?.message ?? "The speaking request stopped before it could be sent.",
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
