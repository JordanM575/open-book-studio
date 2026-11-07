import { normalizeProviderError } from "@ai-book-studio/core/providers/errors";
import {
  chunkForSpeech,
  joinAudio,
  ttsCapability,
  ttsModels,
  ttsRequestBody,
  wrapPcmAsWav,
  type SpokenAudio,
} from "@ai-book-studio/core/providers/tts";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import { ProviderError, type ConnectionSummary } from "@ai-book-studio/core/providers/types";
import type { ProviderService } from "./providers";

const SPEAK_TIMEOUT_MS = 120_000;

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
 * `VoiceService` listens: it sends a recording to Meta and returns words. This speaks: it sends
 * words to a voice service and returns audio. Together they close the loop the ambient agent
 * needs — the author talks, the agent answers, and the answer comes back in a voice rather than
 * as a silent line of text.
 *
 * It only speaks through the profile's explicit connection/model/voice choice. Provider or
 * playback failures never trigger a second paid request.
 *
 * The text is split at sentence boundaries before it is sent, because one request carries a few
 * thousand characters and a chapter is far longer, and the audio is joined back into one sound.
 */
export class SpeechService {
  constructor(
    private readonly providers: ProviderService,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly getPreferences: () => VoicePreferences = () => DEFAULT_VOICE_PREFERENCES
  ) {}

  /** Connections that can speak, for the panel that offers a voice. */
  async connections(): Promise<ConnectionSummary[]> {
    return (await this.providers.list()).filter((connection) => ttsModels(connection.provider).length > 0);
  }

  async speak(input: SpeakInput): Promise<SpeakResult> {
    const text = input.text.trim();
    if (!text) throw new ProviderError("invalid-request", "There is nothing to say.");

    const selected = this.getPreferences().speaking;
    if (!selected.connectionId || !selected.model || !selected.voice) {
      throw new ProviderError("invalid-request", "Choose a speaking connection, model and voice in Settings before asking the studio to speak.");
    }
    const available = await this.providers.list();
    const connection = available.find((entry) => entry.id === selected.connectionId);
    if (!connection) {
      throw new ProviderError("not-found", "That speaking connection is unavailable. Choose another in Settings.");
    }

    const credential = await this.providers.credential(connection.id);
    const capability = ttsCapability(credential.provider, credential.metadata?.baseUrl, selected.model);
    if (!capability) {
      throw new ProviderError("invalid-request", "The saved speaking model does not match that connection. Choose a supported model in Settings.");
    }
    if (!capability.voices.includes(selected.voice)) {
      throw new ProviderError("invalid-request", "The saved voice is not supported by that model. Choose a voice in Settings.");
    }
    const voice = selected.voice;

    const chunks = chunkForSpeech(text);
    const parts: Uint8Array[] = [];

    for (const chunk of chunks) {
      const body = ttsRequestBody(chunk, {
        // The capability names the model: OpenRouter's ids are not OpenAI's.
        model: capability.model,
        voice,
        responseFormat: capability.responseFormat,
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {})
      });

      let response: Response;
      try {
        response = await this.fetchImpl(capability.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.secret}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS)
        });
      } catch (error) {
        throw new ProviderError("offline", "Could not reach the voice service. Check your connection.", {
          provider: credential.provider,
          cause: error
        });
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw normalizeProviderError({
          provider: credential.provider,
          status: response.status,
          body: detail
        });
      }

      const contentType = response.headers.get("content-type") ?? "";
      const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new ProviderError("unknown", "The voice service returned no audio.");
      }

      if (capability.responseFormat === "pcm") {
        if (!capability.sampleRate || !isExpectedPcm(contentType, capability.sampleRate) || bytes.byteLength % 2 !== 0) {
          throw new ProviderError("unknown", "The voice service returned incompatible or incomplete PCM audio.");
        }
      } else {
        // Preserve the existing direct-OpenAI behavior for an absent header, but never join an
        // explicitly different format (including PCM or a successful JSON error) as MP3.
        if (type && type !== "audio/mpeg" && type !== "audio/mp3") {
          throw new ProviderError("unknown", "The voice service did not return MP3 audio.");
        }
      }
      parts.push(bytes);
    }

    let bytes = joinAudio(parts);
    if (capability.responseFormat === "pcm") {
      if (!capability.sampleRate) {
        throw new ProviderError("unknown", "The voice service returned incompatible or incomplete PCM audio.");
      }
      bytes = wrapPcmAsWav(bytes, {
        sampleRate: capability.sampleRate,
        channels: 1,
        bitsPerSample: 16
      });
    }

    return {
      bytes,
      mimeType: capability.responseFormat === "pcm" ? "audio/wav" : "audio/mpeg",
      characters: text.length,
      connectionLabel: connection.label,
      model: capability.model,
      voice,
      chunks: chunks.length,
      costUsd: null
    };
  }
}
