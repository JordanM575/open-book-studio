import { ProviderError, type ProviderId } from "./types";

/**
 * Speaking.
 *
 * `speech.ts` handles transcription; this module describes the curated OpenAI and OpenRouter
 * speaking models, their model-specific voices and audio formats, and the shared request helpers.
 */

/** The OpenAI voices. Each one is a different speaker, not a different tone of the same one. */
export const TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse"
] as const;

export type TtsVoice = (typeof TTS_VOICES)[number];

/** The default voice. Warm and clear, and it does not sound like a narrator. */
export const DEFAULT_TTS_VOICE: TtsVoice = "nova";

/**
 * The models that can speak.
 *
 * `gpt-4o-mini-tts` is the one to use: it understands a plain instruction about how to read, so
 * the studio can say "read this slowly" rather than only choosing a voice.
 */
export const TTS_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const;

export type TtsModel = (typeof TTS_MODELS)[number];

/**
 * The voices each model can speak with. `gpt-4o-mini-tts` offers all of them; `tts-1` and `tts-1-hd`
 * support a smaller set, without `ballad` or `verse`, so a request that pairs those models with the
 * other voices is refused by the provider.
 */
export function openAiVoices(model: string): readonly TtsVoice[] {
  return model === "tts-1" || model === "tts-1-hd"
    ? TTS_VOICES.filter((voice) => voice !== "ballad" && voice !== "verse")
    : TTS_VOICES;
}

export const DEFAULT_TTS_MODEL: TtsModel = "gpt-4o-mini-tts";

/**
 * The most characters one request may carry.
 *
 * A chapter is far longer than this, so the pipeline splits the text at sentence boundaries and
 * joins the audio back together. MP3 frames concatenate cleanly, so the caller gets one sound.
 */
export const MAX_TTS_CHARACTERS = 4_000;

/**
 * The curated OpenRouter choices. This local snapshot is not a promise of provider availability;
 * each model lists only its own voices and expected response format.
 */
export const OPENROUTER_TTS_MODELS = [
  {
    id: "heygen/heygen-voice-1",
    label: "HeyGen Voice",
    voices: ["nadine", "tabitha", "bram", "gareth", "noelle", "meredith", "sabrina", "lucian", "weston", "vincent"],
    responseFormat: "pcm",
    sampleRate: 44_100
  },
  {
    id: "heygen/heygen-voice-1-turbo",
    label: "HeyGen Voice Turbo",
    voices: ["nadine", "tabitha", "bram", "gareth", "noelle", "meredith", "sabrina", "lucian", "weston", "vincent"],
    responseFormat: "pcm",
    sampleRate: 44_100
  },
  {
    id: "mistralai/voxtral-mini-tts-2603",
    label: "Mistral Voxtral Mini TTS",
    voices: [
      "en_paul_sad", "en_paul_neutral", "en_paul_happy", "en_paul_frustrated", "en_paul_cheerful",
      "gb_oliver_sad", "gb_oliver_confident", "gb_jane_sarcasm", "gb_jane_sad", "gb_jane_frustrated",
      "fr_marie_sad", "fr_marie_excited", "fr_marie_curious", "fr_marie_angry"
    ],
    responseFormat: "mp3",
    sampleRate: null
  }
] as const;

/** Backwards-compatible name for the first curated OpenRouter choice. */
export const OPENROUTER_TTS_MODEL = OPENROUTER_TTS_MODELS[0].id;
export const OPENROUTER_TTS_VOICES = OPENROUTER_TTS_MODELS[0].voices;
export const OPENROUTER_TTS_SAMPLE_RATE = OPENROUTER_TTS_MODELS[0].sampleRate;

/** OpenAI's slowest and fastest speaking rates. */
export const MIN_TTS_SPEED = 0.25;
export const MAX_TTS_SPEED = 4;

export interface TtsCapability {
  provider: ProviderId;
  endpoint: string;
  model: string;
  /** The voices worth offering. Empty when the provider picks its own. */
  voices: readonly string[];
  /**
   * A catalog default for callers that need one. Saved author preferences are checked separately
   * and a failed or unavailable saved selection must not silently use this default.
   */
  defaultVoice?: string;
  /** The sample rate of raw PCM, when a provider may answer with that instead of a file. */
  sampleRate?: number;
  responseFormat: "mp3" | "pcm";
}

export interface TtsModelChoice {
  id: string;
  label: string;
  voices: readonly string[];
}

export function ttsModels(provider: ProviderId): TtsModelChoice[] {
  if (provider === "openai") {
    return TTS_MODELS.map((id) => ({ id, label: id, voices: openAiVoices(id) }));
  }
  if (provider === "openrouter") {
    return OPENROUTER_TTS_MODELS.map(({ id, label, voices }) => ({ id, label, voices }));
  }
  return [];
}

export function isTtsChoice(provider: ProviderId, model: string, voice: string): boolean {
  return ttsModels(provider).some((choice) => choice.id === model && choice.voices.includes(voice));
}

/**
 * Where a connection's speech requests go.
 *
 * Both services use OpenAI's `audio/speech` shape — OpenRouter added the same endpoint — so there
 * is one request and one set of responses to handle, not two. What differs is the model, and
 * whether a voice has to be named.
 */
export function ttsCapability(provider: ProviderId, baseUrl?: string, model?: string): TtsCapability | null {
  if (provider === "openai") {
    const selectedModel = model ?? DEFAULT_TTS_MODEL;
    if (!TTS_MODELS.includes(selectedModel as TtsModel)) return null;
    return {
      provider,
      endpoint: `${normalizeTtsBase(baseUrl, "https://api.openai.com/v1")}/audio/speech`,
      model: selectedModel,
      voices: openAiVoices(selectedModel),
      defaultVoice: DEFAULT_TTS_VOICE,
      responseFormat: "mp3"
    };
  }
  if (provider === "openrouter") {
    const selected = OPENROUTER_TTS_MODELS.find((choice) => choice.id === (model ?? OPENROUTER_TTS_MODEL));
    if (!selected) return null;
    return {
      provider,
      endpoint: `${normalizeTtsBase(baseUrl, "https://openrouter.ai/api/v1")}/audio/speech`,
      model: selected.id,
      voices: selected.voices,
      defaultVoice: selected.voices[0],
      ...(selected.sampleRate ? { sampleRate: selected.sampleRate } : {}),
      responseFormat: selected.responseFormat
    };
  }
  return null;
}

/** Whether the provider can speak at all. Used to decide whether to offer a voice. */
export function canSpeak(provider: ProviderId): boolean {
  return ttsCapability(provider) !== null;
}

function normalizeTtsBase(baseUrl: string | undefined, fallback: string): string {
  const raw = baseUrl?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("invalid-request", "The voice service's base URL is not a valid address.");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new ProviderError("invalid-request", "Use an https address for the voice service's base URL.");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export interface TtsOptions {
  voice?: string | undefined;
  /** The model to use. Each provider names its own, so this is not limited to OpenAI's three. */
  model?: string | undefined;
  /** 0.25 to 4. */
  speed?: number | undefined;
  /**
   * How to read it, in plain words, for a model that understands them.
   *
   * "Read this slowly, and pause at the full stops." Ignored by the `tts-1` models.
   */
  instructions?: string;
  responseFormat?: "mp3" | "pcm";
}

/** The JSON body OpenAI documents. */
export function ttsRequestBody(text: string, options: TtsOptions = {}): Record<string, unknown> {
  const input = text.trim();
  if (!input) throw new ProviderError("invalid-request", "There is nothing to say.");
  if (input.length > MAX_TTS_CHARACTERS) {
    throw new ProviderError(
      "invalid-request",
      `One request may carry at most ${MAX_TTS_CHARACTERS} characters. Split the text first.`
    );
  }
  const model = options.model ?? DEFAULT_TTS_MODEL;
  return {
    model,
    input,
    // Some providers require a voice and others reject one they do not know, so it is only sent
    // when the caller named it. The capability supplies the default where one is required.
    ...(options.voice ? { voice: options.voice } : {}),
    response_format: options.responseFormat ?? "mp3",
    ...(options.speed !== undefined
      ? { speed: clampSpeed(options.speed) }
      : {}),
    // The instruction field only exists on the model that understands it.
    ...(options.instructions && model === "gpt-4o-mini-tts"
      ? { instructions: options.instructions.trim() }
      : {})
  };
}

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(MAX_TTS_SPEED, Math.max(MIN_TTS_SPEED, speed));
}

/**
 * Split text into what one request can carry, at sentence boundaries where possible.
 *
 * A paragraph or a chapter both come out as a list that can be sent in order and joined back into
 * one sound. Nothing is dropped: a single sentence longer than the limit is split on a word
 * boundary rather than truncated, because a truncated sentence is a wrong sentence.
 */
export function chunkForSpeech(text: string, limit: number = MAX_TTS_CHARACTERS): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  if (cleaned.length <= limit) return [cleaned];

  const sentences = splitSentences(cleaned);
  const chunks: string[] = [];
  let current = "";

  const push = (): void => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      // A single enormous sentence: split it on word boundaries so nothing is lost.
      push();
      for (const piece of splitLong(sentence, limit)) {
        chunks.push(piece);
      }
      continue;
    }
    if (current.length + sentence.length + 1 > limit) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return chunks;
}

/** Sentences, with their punctuation, without losing the space between them. */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?\n]+[.!?]*\s*/g);
  if (!parts) return [text];
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** One sentence that is longer than the limit. Split it on words; never truncate it. */
function splitLong(sentence: string, limit: number): string[] {
  const words = sentence.split(/\s+/).filter(Boolean);
  const pieces: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > limit) {
      // A single word longer than the limit. Cut it rather than loop forever; it is not prose.
      if (current) pieces.push(current);
      for (let index = 0; index < word.length; index += limit) {
        pieces.push(word.slice(index, index + limit));
      }
      current = "";
      continue;
    }
    if (current.length + word.length + 1 > limit) {
      pieces.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

export interface SpokenAudio {
  bytes: Uint8Array;
  mimeType: string;
  /** How many characters were spoken, so the caller can report it. */
  characters: number;
}

/** Join the per-chunk audio into one sound. MP3 frames concatenate; nothing else is assumed. */
export function joinAudio(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

/**
 * Wrap raw PCM in a RIFF/WAVE header, so the renderer can play it as one sound.
 *
 * The service streams samples; it does not send a file. A WAV header is 44 bytes and turns the
 * samples into something an `<audio>` element accepts.
 */
export function wrapPcmAsWav(
  pcm: Uint8Array,
  options: { sampleRate: number; channels?: number; bitsPerSample?: number }
): Uint8Array {
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const byteRate = (options.sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);

  const ascii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) header[offset + index] = value.charCodeAt(index);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, options.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);

  const wav = new Uint8Array(header.byteLength + pcm.byteLength);
  wav.set(header, 0);
  wav.set(pcm, header.byteLength);
  return wav;
}
