import { MemoryVault } from "@ai-book-studio/core/providers/credentials";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import type { StoredCredential } from "@ai-book-studio/core/providers/types";
import { chunkForSpeech } from "@ai-book-studio/core/providers/tts";
import type {
  VoiceOperationView,
  VoiceSpokenOutcome,
  VoiceTranscriptionOutcome
} from "@ai-book-studio/core/ipc";
import { ProviderService } from "../../src/main/providers";
import { VoiceCancelRegistry } from "../../src/main/voice-cancel-registry";
import { VoiceRequestHost, VoiceRouteAuthority, type VoiceRequestScope } from "../../src/main/voice-request";
import { VoiceService } from "../../src/main/voice";
import { SpeechService } from "../../src/main/speech";

/*
 * Shared fixture for voice service/host tests. Everything is synthetic: an in-memory vault, an
 * injected fetch that never leaves the process, and a recording emitter for operation views.
 */

export const META_SELECTION = { connectionId: "conn_meta0000001", model: "muse-voice-transcribe-1.0" } as const;

type ProviderFacts = Pick<ProviderService, "list" | "credential">;

export interface VoiceTestHost {
  host: VoiceRequestHost;
  registry: VoiceCancelRegistry;
  routes: VoiceRouteAuthority;
  events: VoiceOperationView[];
}

/** Build a host over any provider-facts source (a real ProviderService or a duck-typed fake). */
export function hostFor(
  providers: ProviderFacts,
  preferences: VoicePreferences,
  emit?: (ownerWindowId: number, view: VoiceOperationView) => void
): VoiceTestHost {
  const routes = new VoiceRouteAuthority({ voicePreferences: () => preferences }, providers);
  const registry = new VoiceCancelRegistry();
  const events: VoiceOperationView[] = [];
  const host = new VoiceRequestHost({
    registry,
    routes,
    emit: emit ?? ((_owner, view) => { events.push(view); }),
    isOwnerCurrent: () => true
  });
  return { host, registry, routes, events };
}

export interface VoiceFixture extends VoiceTestHost {
  providers: ProviderService;
  fetchImpl: typeof fetch;
  preferences: VoicePreferences;
  providersListCalls: () => number;
  service: {
    transcribe: VoiceService["transcribe"];
    speak: SpeechService["speak"];
  };
}

export function voiceFixture(options: {
  stored?: StoredCredential[];
  preferences?: VoicePreferences;
  fetchImpl: typeof fetch;
}): VoiceFixture {
  const vault = new MemoryVault();
  for (const credential of options.stored ?? [metaCredential()]) void vault.set(credential);
  let listCalls = 0;
  const providers = new ProviderService(vault, async () => {}, (async () => {
    throw new Error("provider catalogue must not be called");
  }) as unknown as typeof fetch);
  const originalList = providers.list.bind(providers);
  providers.list = async () => {
    listCalls += 1;
    return originalList();
  };
  const preferences: VoicePreferences = options.preferences ?? {
    ...DEFAULT_VOICE_PREFERENCES,
    transcription: { connectionId: "conn_meta0000001", model: "muse-voice-transcribe-1.0" }
  };
  const base = hostFor(providers, preferences);
  const stt = new VoiceService(providers, options.fetchImpl);
  const tts = new SpeechService(providers, options.fetchImpl);
  return {
    ...base,
    providers,
    fetchImpl: options.fetchImpl,
    preferences,
    providersListCalls: () => listCalls,
    service: {
      transcribe: stt.transcribe.bind(stt),
      speak: tts.speak.bind(tts)
    }
  };
}

export function metaCredential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    id: "conn_meta0000001",
    provider: "meta",
    label: "Meta",
    kind: "api-key",
    createdAt: "2026-11-07T00:00:00.000Z",
    secret: "synthetic-meta-key",
    metadata: { baseUrl: "https://api.meta.ai/v1" },
    ...overrides
  };
}

/** Drive the STT path exactly as the IPC handler does, minus the IPC envelope. */
export async function runTranscription(
  host: VoiceRequestHost,
  service: { transcribe(input: { audio: Uint8Array }, scope: VoiceRequestScope): Promise<VoiceTranscriptionOutcome> },
  input: { audio: Uint8Array; expectedSelection?: { connectionId: string; model: string } }
): Promise<VoiceTranscriptionOutcome> {
  const reservation = host.reserve("stt", 1, 1, input.expectedSelection);
  if (!reservation) {
    return { status: "refusal", message: "The studio is already starting another voice request. Wait for it to finish.", receipt: null };
  }
  const begun = await host.begin(reservation);
  if (!begun.ok) return { status: begun.status, message: begun.message, receipt: begun.receipt };
  const outcome = await service.transcribe({ audio: input.audio }, begun.scope);
  if (outcome.receipt) host.emitSettled(1, outcome.receipt);
  return outcome;
}

/** Drive the TTS path exactly as the IPC handler does, minus the IPC envelope. */
export async function runSpeaking(
  host: VoiceRequestHost,
  service: { speak(input: { text: string }, scope: VoiceRequestScope): Promise<VoiceSpokenOutcome> },
  text: string
): Promise<VoiceSpokenOutcome> {
  const planned = Math.max(1, chunkForSpeech(text).length);
  const reservation = host.reserve("tts", planned, 1);
  if (!reservation) {
    return { status: "refusal", message: "The studio is already starting another voice request. Wait for it to finish.", receipt: null };
  }
  const begun = await host.begin(reservation);
  if (!begun.ok) return { status: begun.status, message: begun.message, receipt: begun.receipt };
  const outcome = await service.speak({ text }, begun.scope);
  if (outcome.receipt) host.emitSettled(1, outcome.receipt);
  return outcome;
}
