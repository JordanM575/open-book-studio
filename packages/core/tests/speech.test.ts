import { describe, expect, test } from "bun:test";
import {
  MAX_SPEECH_DURATION_MS,
  bytesToBase64,
  inspectWav,
  openRouterSpeechRequest,
  OPENROUTER_STT_MODELS,
  parseOpenRouterSpeechResponse,
  parseSpeechResponse,
  speechCapability,
  speechModels,
  speechForm
} from "../src/providers/speech";

function wav(options: {
  sampleRate?: number;
  channels?: number;
  bits?: number;
  seconds?: number;
  format?: number;
  truncate?: number;
} = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const seconds = options.seconds ?? 1;
  const blockAlign = channels * (bits / 8);
  const dataBytes = Math.round(sampleRate * seconds) * blockAlign;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, 36 + dataBytes, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, options.format ?? 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36); // data
  view.setUint32(40, dataBytes, true);
  return options.truncate ? bytes.slice(0, options.truncate) : bytes;
}

describe("WAV validation", () => {
  test("accepts mono 16-bit PCM at 16 kHz and reports the duration", () => {
    const result = inspectWav(wav({ seconds: 2 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16, durationMs: 2000 });
    }
  });

  test("accepts 24 kHz", () => {
    const result = inspectWav(wav({ sampleRate: 24_000 }));
    expect(result.ok).toBe(true);
  });

  test("refuses a non-WAV recording before the request", () => {
    const result = inspectWav(new TextEncoder().encode("this is not audio, but it is long enough to have a header."));
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/not a WAV/i) });
  });

  test("refuses stereo, 8-bit, compressed and wrong-rate audio", () => {
    expect(inspectWav(wav({ channels: 2 }))).toMatchObject({ ok: false });
    expect(inspectWav(wav({ channels: 2 }))).toEqual({ ok: false, reason: expect.stringMatching(/mono/i) });
    expect(inspectWav(wav({ bits: 8 }))).toEqual({ ok: false, reason: expect.stringMatching(/16-bit/i) });
    expect(inspectWav(wav({ format: 3 }))).toEqual({ ok: false, reason: expect.stringMatching(/PCM/i) });
    expect(inspectWav(wav({ sampleRate: 44_100 }))).toEqual({
      ok: false,
      reason: expect.stringMatching(/16 kHz or 24 kHz/i)
    });
  });

  test("refuses a truncated recording", () => {
    expect(inspectWav(wav({ truncate: 30 }))).toEqual({
      ok: false,
      reason: expect.stringMatching(/complete WAV/i)
    });
    expect(inspectWav(wav({ truncate: 100 }))).toEqual({
      ok: false,
      reason: expect.stringMatching(/truncated/i)
    });
  });

  test("refuses audio longer than ten minutes", () => {
    const result = inspectWav(wav({ seconds: MAX_SPEECH_DURATION_MS / 1000 + 1 }));
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/longer than 10 minutes/i) });
  });
});

describe("Meta speech request", () => {
  test("builds the documented request and audio parts", async () => {
    const form = speechForm(wav(), { languageBias: ["English"], keywords: ["Muse"] });
    const request = form.get("request");
    const audio = form.get("audio");
    expect(request).toBeInstanceOf(Blob);
    expect(audio).toBeInstanceOf(Blob);
    expect(await (request as Blob).text()).toBe(
      JSON.stringify({
        mode: "PUSH_TO_TALK",
        model: "muse-voice-transcribe-1.0",
        audioEncoding: "WAV",
        languageBias: ["English"],
        keywords: ["Muse"]
      })
    );
    expect((audio as Blob).type).toBe("audio/wav");
    expect((audio as Blob).size).toBe(wav().byteLength);
  });

  test("omits empty bias and keyword lists", async () => {
    const form = speechForm(wav(), { languageBias: [], keywords: [] });
    const request = JSON.parse(await (form.get("request") as Blob).text()) as Record<string, unknown>;
    expect(request).not.toHaveProperty("languageBias");
    expect(request).not.toHaveProperty("keywords");
  });

  test("resolves the Meta endpoint with or without a /v1 base", () => {
    expect(speechCapability("meta", "https://api.meta.ai/v1")).toMatchObject({
      endpoint: "https://api.meta.ai/v1/asr/transcribe",
      model: "muse-voice-transcribe-1.0"
    });
    expect(speechCapability("meta", "https://api.meta.ai")).toMatchObject({
      endpoint: "https://api.meta.ai/v1/asr/transcribe"
    });
    expect(speechCapability("openai", "https://api.openai.com/v1")).toBeNull();
  });

  test("encodes recording bytes as standard padded base64 at every length around a slice boundary", () => {
    // The encoder works in slices of 24,576 bytes, so check lengths either side of one and two slices.
    const slice = 3 * 8192;
    for (const length of [0, 1, 2, 3, 4, 5, slice - 1, slice, slice + 1, slice + 2, 2 * slice, 2 * slice + 1]) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 17 + 3) & 255);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
    // A view into a larger buffer encodes only its own bytes.
    const whole = new Uint8Array([9, 9, 82, 73, 70, 70, 9]);
    expect(bytesToBase64(whole.subarray(2, 6))).toBe("UklGRg==");
  });

  test("encodes a ten-minute recording without a pile of short-lived strings", () => {
    // 600 s of 16 kHz 16-bit mono: the longest the provider accepts. The earlier encoder built about
    // 800 MB of heap for this and took seconds in the main process.
    const bytes = new Uint8Array(600 * 16_000 * 2).map((_, index) => (index * 31 + 7) & 255);
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    const encoded = bytesToBase64(bytes);
    const elapsed = performance.now() - started;
    const grown = process.memoryUsage().heapUsed - before;

    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    expect(encoded.startsWith(Buffer.from(bytes.subarray(0, 300)).toString("base64"))).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
    expect(grown).toBeLessThan(300_000_000);
  });

  test("lists the curated OpenRouter models and builds JSON/base64 audio requests", () => {
    expect(speechModels("openrouter").map((choice) => choice.id)).toEqual([...OPENROUTER_STT_MODELS]);
    expect(speechCapability("openrouter", undefined, "openai/whisper-large-v3-turbo")).toMatchObject({
      endpoint: "https://openrouter.ai/api/v1/audio/transcriptions",
      model: "openai/whisper-large-v3-turbo"
    });
    expect(openRouterSpeechRequest(new Uint8Array([82, 73, 70, 70]), "openai/whisper-1")).toEqual({
      model: "openai/whisper-1",
      input_audio: { data: "UklGRg==", format: "wav" }
    });
    expect(() => openRouterSpeechRequest(new Uint8Array(), "unlisted/model")).toThrow(/supported OpenRouter/i);
  });
});

describe("Meta speech response", () => {
  test("parses the transcript, turns and duration", () => {
    expect(
      parseSpeechResponse({
        transcript: " How is the weather? It is raining. ",
        audioDurationMs: 8240,
        turns: [
          { turnId: 1, startMs: 1520, endMs: 4640, transcript: "How is the weather?", speaker: "A" },
          { turnId: 2, startMs: 5900, endMs: 8240, transcript: "It is raining.", speaker: "B" }
        ]
      })
    ).toEqual({
      text: "How is the weather? It is raining.",
      providerDurationMs: 8240,
      turns: [
        { turnId: 1, startMs: 1520, endMs: 4640, transcript: "How is the weather?", speaker: "A" },
        { turnId: 2, startMs: 5900, endMs: 8240, transcript: "It is raining.", speaker: "B" }
      ]
    });
  });

  test("keeps an empty transcript instead of inventing speech", () => {
    expect(parseSpeechResponse({ transcript: "" })).toMatchObject({ text: "", turns: [] });
  });

  test("refuses a response without a transcript", () => {
    expect(() => parseSpeechResponse({ turns: [] })).toThrow(/without a transcript/);
  });
});

describe("OpenRouter speech response", () => {
  test("preserves only provider-reported usage and trims text", () => {
    expect(parseOpenRouterSpeechResponse({
      text: "  The words are here. ",
      usage: { seconds: 1.25, cost: 0.0004 }
    })).toEqual({ text: "The words are here.", durationMs: 1250, costUsd: 0.0004 });
  });

  test("leaves usage unknown when the provider did not report it", () => {
    expect(parseOpenRouterSpeechResponse({ text: "Hello." })).toEqual({
      text: "Hello.", durationMs: null, costUsd: null
    });
    expect(() => parseOpenRouterSpeechResponse({ usage: { seconds: 1 } })).toThrow(/without a transcript/i);
  });
});
