import { ProviderError, type ProviderId } from "./types";

/**
 * Meta's file transcription endpoint and model. The endpoint is not the OpenAI
 * `/audio/transcriptions` shape: it takes a JSON `request` part and an `audio` WAV part.
 * Docs: https://dev.meta.ai/docs/speech-to-text
 */
export const META_SPEECH_HOST = "https://api.meta.ai";
export const META_SPEECH_MODEL = "muse-voice-transcribe-1.0";
export const MAX_SPEECH_BYTES = 32 * 1024 * 1024;
export const MAX_SPEECH_DURATION_MS = 10 * 60 * 1000;
export const SPEECH_SAMPLE_RATES = [16_000, 24_000] as const;
export const MAX_LANGUAGE_BIASES = 4;
export const MAX_KEYWORDS = 50;

export const OPENROUTER_SPEECH_HOST = "https://openrouter.ai/api/v1";
export const OPENROUTER_STT_MODELS = [
  "openai/whisper-1",
  "openai/whisper-large-v3",
  "openai/whisper-large-v3-turbo"
] as const;
export const META_STT_MODELS = [META_SPEECH_MODEL] as const;

export interface SpeechModelChoice {
  id: string;
  label: string;
}

export function speechModels(provider: ProviderId): SpeechModelChoice[] {
  if (provider === "meta") return [{ id: META_SPEECH_MODEL, label: "Muse Voice Transcribe" }];
  if (provider === "openrouter") {
    return [
      { id: "openai/whisper-1", label: "Whisper 1" },
      { id: "openai/whisper-large-v3", label: "Whisper Large v3" },
      { id: "openai/whisper-large-v3-turbo", label: "Whisper Large v3 Turbo" }
    ];
  }
  return [];
}

export function isSpeechModel(provider: ProviderId, model: string): boolean {
  return speechModels(provider).some((choice) => choice.id === model);
}

export interface SpeechCapability {
  provider: ProviderId;
  endpoint: string;
  model: string;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

export type WavCheck = { ok: true; info: WavInfo } | { ok: false; reason: string };

export interface SpeechSettings {
  mode?: "PUSH_TO_TALK" | "ENDPOINTING" | "DIARIZATION";
  languageBias?: string[];
  keywords?: string[];
}

export interface SpeechTurn {
  turnId: number;
  startMs: number;
  endMs: number;
  transcript: string;
  speaker?: string;
}

export interface VoiceTranscript {
  text: string;
  provider: ProviderId;
  connectionLabel: string;
  model: string;
  durationMs: number;
  /** Provider-reported cost only; absent reports remain unknown. */
  costUsd: number | null;
  turns: SpeechTurn[];
}

/**
 * Resolve the documented transcription endpoint for a provider and a locally listed model.
 */
export function speechCapability(provider: ProviderId, baseUrl?: string, model?: string): SpeechCapability | null {
  const choices = speechModels(provider);
  const selectedModel = model ?? choices[0]?.id;
  if (!selectedModel || !isSpeechModel(provider, selectedModel)) return null;
  if (provider === "openrouter") {
    const base = normalizeSpeechBase(baseUrl, OPENROUTER_SPEECH_HOST);
    return {
      provider,
      endpoint: `${base}/audio/transcriptions`,
      model: selectedModel
    };
  }
  if (provider !== "meta") return null;
  const base = normalizeSpeechBase(baseUrl, `${META_SPEECH_HOST}/v1`);
  return {
    provider,
    endpoint: base.endsWith("/v1") ? `${base}/asr/transcribe` : `${base}/v1/asr/transcribe`,
    model: selectedModel
  };
}

function normalizeSpeechBase(baseUrl: string | undefined, fallback: string): string {
  const raw = baseUrl?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("invalid-request", "The speech service's base URL is not a valid address.");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new ProviderError("invalid-request", "Use an https address for the speech service's base URL.");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export interface OpenRouterSpeechRequest {
  model: string;
  input_audio: { data: string; format: "wav" };
}

/** OpenRouter's documented STT contract: JSON with base64 WAV, not Meta's multipart form. */
export function openRouterSpeechRequest(audio: Uint8Array, model: string): OpenRouterSpeechRequest {
  if (!OPENROUTER_STT_MODELS.includes(model as (typeof OPENROUTER_STT_MODELS)[number])) {
    throw new ProviderError("invalid-request", "Choose a supported OpenRouter transcription model in Settings.");
  }
  return { model, input_audio: { data: bytesToBase64(audio), format: "wav" } };
}

/** Bytes per slice: a multiple of three, so only the last slice can need base64 padding. */
const BASE64_SLICE = 3 * 8192;
/** Characters handed to `String.fromCharCode` at once, well under the engine's argument limit. */
const CHAR_BATCH = 8192;

/**
 * Standard base64 with padding, built a bounded slice at a time. A recording can be many megabytes,
 * and appending four characters per three bytes makes millions of short-lived string pieces in the
 * main process, which holds hundreds of megabytes while it runs. `btoa` is available in Node, Bun
 * and browsers, so this needs no `Buffer`.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_SLICE) {
    const slice = bytes.subarray(offset, Math.min(offset + BASE64_SLICE, bytes.length));
    let binary = "";
    for (let index = 0; index < slice.length; index += CHAR_BATCH) {
      binary += String.fromCharCode(...slice.subarray(index, index + CHAR_BATCH));
    }
    parts.push(btoa(binary));
  }
  return parts.join("");
}

/**
 * Validate the container the provider accepts before spending a request. Meta requires a RIFF/WAVE
 * file with mono, 16-bit integer PCM at 16 kHz or 24 kHz, up to 10 minutes and 32 MB.
 */
export function inspectWav(bytes: Uint8Array): WavCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: "The recording is empty." };
  if (bytes.byteLength > MAX_SPEECH_BYTES) {
    return { ok: false, reason: "The recording is larger than 32 MB. Record a shorter clip." };
  }
  if (bytes.byteLength < 44) return { ok: false, reason: "The recording is not a complete WAV file." };
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    return { ok: false, reason: "The recording is not a WAV file. Meta accepts WAV audio only." };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > bytes.byteLength) {
      return { ok: false, reason: "The recording is truncated." };
    }
    if (id === "fmt ") {
      if (size < 16) return { ok: false, reason: "The WAV format header is incomplete." };
      format = {
        audioFormat: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bitsPerSample: view.getUint16(start + 14, true)
      };
    } else if (id === "data") {
      dataBytes = size;
      break;
    }
    offset = start + size + (size % 2);
  }

  if (!format) return { ok: false, reason: "The WAV file has no format header." };
  if (dataBytes === null) return { ok: false, reason: "The WAV file has no audio data." };
  if (format.audioFormat !== 1) {
    return { ok: false, reason: "The recording must be 16-bit PCM, not compressed WAV." };
  }
  if (format.channels !== 1) return { ok: false, reason: "The recording must be mono." };
  if (format.bitsPerSample !== 16) return { ok: false, reason: "The recording must be 16-bit audio." };
  if (!SPEECH_SAMPLE_RATES.includes(format.sampleRate as (typeof SPEECH_SAMPLE_RATES)[number])) {
    return { ok: false, reason: "The recording must be sampled at 16 kHz or 24 kHz." };
  }
  if (dataBytes <= 0) return { ok: false, reason: "The recording contains no audio." };

  const durationMs = (dataBytes / (format.sampleRate * format.channels * 2)) * 1000;
  if (durationMs > MAX_SPEECH_DURATION_MS) {
    return { ok: false, reason: "The recording is longer than 10 minutes. Record a shorter clip." };
  }

  return {
    ok: true,
    info: {
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitsPerSample: format.bitsPerSample,
      dataBytes,
      durationMs: Math.round(durationMs)
    }
  };
}

/** The multipart body Meta documents. It is deliberately not the OpenAI `file`/`model` shape. */
export function speechForm(audio: Uint8Array, options: SpeechSettings = {}): FormData {
  const request = {
    mode: options.mode ?? "PUSH_TO_TALK",
    model: META_SPEECH_MODEL,
    audioEncoding: "WAV",
    ...(options.languageBias?.length ? { languageBias: options.languageBias } : {}),
    ...(options.keywords?.length ? { keywords: options.keywords } : {})
  };
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }), "request.json");
  const copy = new Uint8Array(audio.byteLength);
  copy.set(audio);
  form.append("audio", new Blob([copy], { type: "audio/wav" }), "dictation.wav");
  return form;
}

export interface ParsedSpeech {
  text: string;
  turns: SpeechTurn[];
  providerDurationMs: number | null;
}

export interface ParsedOpenRouterSpeech {
  text: string;
  durationMs: number | null;
  costUsd: number | null;
}

export function parseOpenRouterSpeechResponse(payload: unknown): ParsedOpenRouterSpeech {
  if (!payload || typeof payload !== "object") {
    throw new ProviderError("unknown", "OpenRouter returned a response without a transcript.");
  }
  const body = payload as { text?: unknown; usage?: { seconds?: unknown; cost?: unknown } };
  if (typeof body.text !== "string") {
    throw new ProviderError("unknown", "OpenRouter returned a response without a transcript.");
  }
  const seconds = body.usage?.seconds;
  const cost = body.usage?.cost;
  return {
    text: body.text.trim(),
    durationMs: typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
    costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null
  };
}

/** Parse the documented JSON response without inventing fields the provider did not send. */
export function parseSpeechResponse(payload: unknown): ParsedSpeech {
  const body = payload as { transcript?: unknown; turns?: unknown; audioDurationMs?: unknown } | null;
  if (!body || typeof body !== "object" || typeof body.transcript !== "string") {
    throw new ProviderError("unknown", "Meta returned a response without a transcript.");
  }
  const turns: SpeechTurn[] = [];
  if (Array.isArray(body.turns)) {
    for (const entry of body.turns) {
      const raw = entry as Record<string, unknown>;
      if (
        typeof raw.turnId !== "number" ||
        typeof raw.startMs !== "number" ||
        typeof raw.endMs !== "number" ||
        typeof raw.transcript !== "string"
      ) {
        continue;
      }
      turns.push({
        turnId: raw.turnId,
        startMs: raw.startMs,
        endMs: raw.endMs,
        transcript: raw.transcript,
        ...(typeof raw.speaker === "string" ? { speaker: raw.speaker } : {})
      });
    }
  }
  return {
    text: body.transcript.trim(),
    turns,
    providerDurationMs:
      typeof body.audioDurationMs === "number" && Number.isFinite(body.audioDurationMs) && body.audioDurationMs >= 0
        ? Math.round(body.audioDurationMs)
        : null
  };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index] ?? 0);
  return value;
}
