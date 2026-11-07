import { describe, expect, test } from "bun:test";
import {
  canSpeak,
  chunkForSpeech,
  clampSpeed,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  joinAudio,
  MAX_TTS_CHARACTERS,
  OPENROUTER_TTS_MODELS,
  OPENROUTER_TTS_MODEL,
  openAiVoices,
  TTS_VOICES,
  ttsModels,
  isTtsChoice,
  ttsCapability,
  ttsRequestBody,
  wrapPcmAsWav
} from "../src/providers/tts";

describe("the voice service", () => {
  test("is available for the documented OpenAI and OpenRouter adapters", () => {
    expect(canSpeak("openai")).toBe(true);
    expect(canSpeak("openrouter")).toBe(true);
    expect(canSpeak("meta")).toBe(false);
    expect(canSpeak("anthropic")).toBe(false);
  });

  test("points at the speech endpoint of the stored base URL", () => {
    const capability = ttsCapability("openai", "https://api.openai.com/v1");
    expect(capability?.endpoint).toBe("https://api.openai.com/v1/audio/speech");
    expect(capability?.model).toBe(DEFAULT_TTS_MODEL);
    expect(capability?.voices).toContain(DEFAULT_TTS_VOICE);
  });

  test("defaults to OpenAI when no base URL is stored", () => {
    expect(ttsCapability("openai")?.endpoint).toBe("https://api.openai.com/v1/audio/speech");
  });

  test("refuses a base URL that is not https", () => {
    expect(() => ttsCapability("openai", "http://api.example.com")).toThrow(/https/i);
  });

  test("trims a trailing slash rather than doubling it", () => {
    expect(ttsCapability("openai", "https://api.example.com/v1/")?.endpoint).toBe(
      "https://api.example.com/v1/audio/speech"
    );
  });
});

describe("the request", () => {
  test("asks for mp3, a voice and the model", () => {
    const body = ttsRequestBody("The door was open.");
    expect(body).toMatchObject({
      model: DEFAULT_TTS_MODEL,
      input: "The door was open.",
      response_format: "mp3"
    });
  });

  test("carries a reading instruction only for the model that understands one", () => {
    const modern = ttsRequestBody("Read this.", { instructions: "slowly, and pause" });
    expect(modern.instructions).toBe("slowly, and pause");
    const older = ttsRequestBody("Read this.", { model: "tts-1", instructions: "slowly" });
    expect(older.instructions).toBeUndefined();
  });

  test("clamps the speed to what the service accepts", () => {
    expect(clampSpeed(0.1)).toBe(0.25);
    expect(clampSpeed(10)).toBe(4);
    expect(ttsRequestBody("hi", { speed: 0.1 }).speed).toBe(0.25);
  });

  test("refuses nothing, and refuses too much", () => {
    expect(() => ttsRequestBody("   ")).toThrow(/nothing to say/i);
    expect(() => ttsRequestBody("x".repeat(MAX_TTS_CHARACTERS + 1))).toThrow(/at most/i);
  });

  test("offers real voices", () => {
    expect(TTS_VOICES.length).toBeGreaterThan(6);
    expect(TTS_VOICES).toContain("nova");
  });

  test("offers the older OpenAI models only the voices they support", () => {
    // tts-1 and tts-1-hd have a smaller set than gpt-4o-mini-tts, which also has ballad and verse.
    for (const older of ["tts-1", "tts-1-hd"]) {
      expect(openAiVoices(older)).not.toContain("ballad");
      expect(openAiVoices(older)).not.toContain("verse");
      expect(openAiVoices(older)).toContain(DEFAULT_TTS_VOICE);
      expect(ttsCapability("openai", undefined, older)?.voices).toEqual(openAiVoices(older));
      expect(isTtsChoice("openai", older, "ballad")).toBe(false);
      expect(isTtsChoice("openai", older, "verse")).toBe(false);
      expect(isTtsChoice("openai", older, "nova")).toBe(true);
    }
    expect(openAiVoices("gpt-4o-mini-tts")).toEqual(TTS_VOICES);
    expect(ttsCapability("openai", undefined, "gpt-4o-mini-tts")?.voices).toEqual(TTS_VOICES);
    expect(isTtsChoice("openai", "gpt-4o-mini-tts", "ballad")).toBe(true);
    // The catalog Settings reads says the same, model by model.
    const catalog = Object.fromEntries(ttsModels("openai").map((choice) => [choice.id, choice.voices]));
    expect(catalog["tts-1"]).toEqual(openAiVoices("tts-1"));
    expect(catalog["tts-1-hd"]).toEqual(openAiVoices("tts-1-hd"));
    expect(catalog["gpt-4o-mini-tts"]).toEqual(TTS_VOICES);
  });
});

describe("chunking a passage", () => {
  test("leaves a short passage whole", () => {
    expect(chunkForSpeech("The door was open.")).toEqual(["The door was open."]);
  });

  test("returns nothing for nothing", () => {
    expect(chunkForSpeech("   \n  ")).toEqual([]);
  });

  test("splits a long passage at sentence boundaries", () => {
    const sentence = "The storm came in low and the lamp would not turn. ";
    const text = sentence.repeat(120);
    const chunks = chunkForSpeech(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_TTS_CHARACTERS);
      // Every chunk ends at a sentence, not in the middle of one.
      expect(chunk.trimEnd().endsWith(".")).toBe(true);
    }
  });

  test("loses nothing", () => {
    const text = "One. Two. Three. ".repeat(400);
    const joined = chunkForSpeech(text).join(" ");
    const words = (value: string) => value.split(/\s+/).filter(Boolean);
    expect(words(joined).length).toBe(words(text).length);
  });

  test("splits a sentence longer than the limit on word boundaries", () => {
    const word = "lighthouse";
    const text = Array.from({ length: 900 }, () => word).join(" ");
    const chunks = chunkForSpeech(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
      // A word is never cut in half.
      expect(chunk).not.toMatch(/lighthous$/);
    }
  });

  test("does not loop forever on one enormous word", () => {
    const chunks = chunkForSpeech("x".repeat(1200), 500);
    expect(chunks.join("")).toBe("x".repeat(1200));
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
  });

  test("honours a custom limit", () => {
    const chunks = chunkForSpeech("One. Two. Three. Four.", 12);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(12);
  });
});

describe("joining the audio", () => {
  test("returns one sound from several parts", () => {
    const joined = joinAudio([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]);
    expect([...joined]).toEqual([1, 2, 3, 4, 5]);
  });

  test("handles a single part and none at all", () => {
    expect([...joinAudio([new Uint8Array([9])])]).toEqual([9]);
    expect(joinAudio([]).byteLength).toBe(0);
  });
});

describe("curated OpenRouter speech models", () => {
  test("each model uses the shared endpoint and its own documented voice and format", () => {
    const capability = ttsCapability("openrouter", undefined, "heygen/heygen-voice-1");
    expect(capability?.endpoint).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(capability).toMatchObject({
      model: "heygen/heygen-voice-1",
      responseFormat: "pcm",
      sampleRate: 44_100,
      defaultVoice: "nadine"
    });
    expect(capability?.voices).toContain("vincent");
    const mistral = ttsCapability("openrouter", undefined, "mistralai/voxtral-mini-tts-2603");
    expect(mistral).toMatchObject({ model: "mistralai/voxtral-mini-tts-2603", responseFormat: "mp3" });
    expect(mistral?.voices).toContain("gb_jane_sarcasm");
    expect(ttsCapability("openrouter", undefined, "unlisted/model")).toBeNull();
    expect(OPENROUTER_TTS_MODELS).toHaveLength(3);
  });

  test("names a default voice for every voice-selecting model", () => {
    expect(ttsCapability("openai")?.defaultVoice).toBe(DEFAULT_TTS_VOICE);
    expect(ttsCapability("openrouter")?.defaultVoice).toBe("nadine");
  });

  test("request output format is selected for the exact model", () => {
    expect(ttsRequestBody("Hello.")).not.toHaveProperty("voice");
    expect(ttsRequestBody("Hello.", { voice: "onyx" }).voice).toBe("onyx");
    expect(ttsRequestBody("Hello.", { model: OPENROUTER_TTS_MODEL, voice: "nadine", responseFormat: "pcm" })).toMatchObject({
      model: OPENROUTER_TTS_MODEL,
      voice: "nadine",
      response_format: "pcm"
    });
  });

  test("wraps raw samples in a playable WAV, for providers that answer with PCM", () => {
    const pcm = new Uint8Array([0, 1, 2, 3]);
    const wav = wrapPcmAsWav(pcm, { sampleRate: 24_000 });
    const view = new DataView(wav.buffer);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...wav.slice(offset, offset + length));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect(wav.byteLength).toBe(48);
    expect([...wav.slice(44)]).toEqual([0, 1, 2, 3]);
  });
});
