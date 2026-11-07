import { normalizeProviderError } from "@ai-book-studio/core/providers/errors";
import {
  inspectWav,
  openRouterSpeechRequest,
  parseOpenRouterSpeechResponse,
  parseSpeechResponse,
  speechCapability,
  speechForm,
  speechModels,
  type VoiceTranscript
} from "@ai-book-studio/core/providers/speech";
import { DEFAULT_VOICE_PREFERENCES, type TranscriptionSelection, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import { ProviderError, type ConnectionSummary } from "@ai-book-studio/core/providers/types";
import type { ProviderService } from "./providers";

const TRANSCRIBE_TIMEOUT_MS = 120_000;

export interface TranscribeInput {
  audio: Uint8Array;
  expectedSelection: TranscriptionSelection;
  languageBias?: string[];
  keywords?: string[];
}

/**
 * The only place audio leaves the studio. It reads the explicitly selected secret in the main
 * process, validates WAV before spending a request, and keeps audio in memory only.
 */
export class VoiceService {
  constructor(
    private readonly providers: ProviderService,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly getPreferences: () => VoicePreferences = () => DEFAULT_VOICE_PREFERENCES
  ) {}

  /** Connections that can transcribe audio, for the editor's microphone state. */
  async connections(): Promise<ConnectionSummary[]> {
    return (await this.providers.list()).filter((connection) => speechModels(connection.provider).length > 0);
  }

  async transcribe(input: TranscribeInput): Promise<VoiceTranscript> {
    const check = inspectWav(input.audio);
    if (!check.ok) throw new ProviderError("invalid-request", check.reason);

    const selected = { ...this.getPreferences().transcription };
    if (!selected.connectionId || !selected.model) {
      throw new ProviderError("invalid-request", "Choose a transcription connection and model in Settings before using dictation.");
    }
    if (selected.connectionId !== input.expectedSelection.connectionId || selected.model !== input.expectedSelection.model) {
      throw new ProviderError("invalid-request", "The transcription selection changed during dictation. Record again with the current selection.");
    }
    const available = await this.providers.list();
    const connection = available.find((entry) => entry.id === selected.connectionId);
    if (!connection) {
      throw new ProviderError("not-found", "That transcription connection is unavailable. Choose another in Settings.");
    }

    const credential = await this.providers.credential(connection.id);
    const capability = speechCapability(credential.provider, credential.metadata?.baseUrl, selected.model);
    if (!capability) {
      throw new ProviderError("invalid-request", "The saved transcription model does not match that connection. Choose a supported model in Settings.");
    }

    const isMeta = credential.provider === "meta";
    const body = isMeta
      ? speechForm(input.audio, {
          mode: "PUSH_TO_TALK",
          ...(input.languageBias?.length ? { languageBias: input.languageBias } : {}),
          ...(input.keywords?.length ? { keywords: input.keywords } : {})
        })
      : JSON.stringify(openRouterSpeechRequest(input.audio, capability.model));

    let response: Response;
    try {
      response = await this.fetchImpl(capability.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.secret}`,
          ...(isMeta ? {} : { "content-type": "application/json" })
        },
        body,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
      });
    } catch (error) {
      throw new ProviderError("offline", "Could not reach the transcription service. Check your connection.", {
        provider: credential.provider,
        cause: error
      });
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw normalizeProviderError({ provider: credential.provider, status: response.status, body: errorBody });
    }

    const payload = await response.json().catch(() => null);
    const transcript = isMeta
      ? (() => {
          const parsed = parseSpeechResponse(payload);
          return {
            text: parsed.text,
            durationMs: parsed.providerDurationMs ?? check.info.durationMs,
            costUsd: null,
            turns: parsed.turns
          };
        })()
      : (() => {
          const parsed = parseOpenRouterSpeechResponse(payload);
          return {
            text: parsed.text,
            durationMs: parsed.durationMs ?? check.info.durationMs,
            costUsd: parsed.costUsd,
            turns: []
          };
        })();
    return {
      text: transcript.text,
      provider: credential.provider,
      connectionLabel: credential.label,
      model: capability.model,
      durationMs: transcript.durationMs,
      costUsd: transcript.costUsd,
      turns: transcript.turns
    };
  }
}
