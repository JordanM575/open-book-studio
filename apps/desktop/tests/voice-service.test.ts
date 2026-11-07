import { describe, expect, test } from "bun:test";
import { MemoryVault } from "@ai-book-studio/core/providers/credentials";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import { META_SPEECH_MODEL } from "@ai-book-studio/core/providers/speech";
import type { ProviderId, StoredCredential } from "@ai-book-studio/core/providers/types";
import { ProviderService } from "../src/main/providers";
import { VoiceService } from "../src/main/voice";

const KEY = "meta-test-key-123456";
const META_SELECTION = { connectionId: "conn_meta0000001", model: META_SPEECH_MODEL };

function wav(seconds = 1): Uint8Array {
  const sampleRate = 16_000;
  const dataBytes = sampleRate * seconds * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + dataBytes, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function credential(provider: StoredCredential["provider"] = "meta", id = "conn_meta0000001"): StoredCredential {
  return {
    id,
    provider,
    label: "Meta",
    kind: "api-key",
    createdAt: "2026-10-26T12:00:00.000Z",
    secret: KEY,
    ...(provider === "meta" ? { metadata: { baseUrl: "https://api.meta.ai/v1" } } : {})
  };
}

function preferences(provider: ProviderId | null, connectionId: string | null): VoicePreferences {
  if (provider === "meta") {
    return { ...DEFAULT_VOICE_PREFERENCES, transcription: { connectionId, model: META_SPEECH_MODEL } };
  }
  if (provider === "openrouter") {
    return { ...DEFAULT_VOICE_PREFERENCES, transcription: { connectionId, model: "openai/whisper-1" } };
  }
  return DEFAULT_VOICE_PREFERENCES;
}

function service(
  fetchImpl: typeof fetch,
  stored: StoredCredential[] = [credential()],
  selected: VoicePreferences = preferences("meta", "conn_meta0000001")
) {
  const vault = new MemoryVault();
  for (const entry of stored) void vault.set(entry);
  const providers = new ProviderService(vault, async () => {}, (async () => {
    throw new Error("provider catalogue must not be called");
  }) as unknown as typeof fetch);
  return new VoiceService(providers, fetchImpl, () => selected);
}

describe("VoiceService", () => {
  test("posts the documented Meta form and returns the transcript", async () => {
    const captured: { url?: string; init?: RequestInit | undefined } = {};
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return Response.json({ transcript: " Hello there. ", audioDurationMs: 3000, turns: [] });
    }) as typeof fetch;

    const result = await service(fetchImpl).transcribe({ audio: wav(), expectedSelection: META_SELECTION });

    expect(result).toMatchObject({
      text: "Hello there.",
      provider: "meta",
      connectionLabel: "Meta",
      model: "muse-voice-transcribe-1.0",
      durationMs: 3000
    });
    expect(captured?.url).toBe("https://api.meta.ai/v1/asr/transcribe");
    const init = captured.init;
    if (!init) throw new Error("the provider was never called");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const form = captured?.init?.body as FormData;
    const request = JSON.parse(await (form.get("request") as Blob).text()) as Record<string, unknown>;
    expect(request).toMatchObject({ mode: "PUSH_TO_TALK", model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" });
    expect(form.get("audio")).toBeInstanceOf(Blob);
  });

  test("refuses non-WAV audio before any request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({ transcript: "never" });
    }) as unknown as typeof fetch;

    await expect(service(fetchImpl).transcribe({ audio: new TextEncoder().encode("not audio"), expectedSelection: META_SELECTION })).rejects.toMatchObject({
      code: "invalid-request"
    });
    expect(calls).toBe(0);
  });

  test("normalizes an auth failure without leaking the key", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: `invalid key ${KEY}` }), { status: 401 })) as unknown as typeof fetch;

    await expect(service(fetchImpl).transcribe({ audio: wav(), expectedSelection: META_SELECTION })).rejects.toMatchObject({
      code: "auth",
      message: "The provider rejected this connection. Reconnect or check the key."
    });
  });

  test("requires an explicit saved transcription connection", async () => {
    await expect(
      service(
        (async () => {
          throw new Error("must not call");
        }) as unknown as typeof fetch,
        [credential("openai", "conn_openai00001")],
        DEFAULT_VOICE_PREFERENCES
      ).transcribe({ audio: wav(), expectedSelection: META_SELECTION })
    ).rejects.toMatchObject({ code: "invalid-request", message: expect.stringMatching(/Choose a transcription connection/i) });
  });

  test("lists only speech-capable connections", async () => {
    const connections = await service(
      (async () => {
        throw new Error("must not call");
      }) as unknown as typeof fetch,
      [credential("openai", "conn_openai00001"), credential("meta", "conn_meta0000001")]
    ).connections();
    expect(connections.map((entry) => entry.provider)).toEqual(["meta"]);
  });

  test("refuses when the saved connection is not speech-capable", async () => {
    await expect(
      service(
        (async () => {
          throw new Error("must not call");
        }) as unknown as typeof fetch
      , [credential("openai", "conn_openai00001")], preferences(null, null)
      ).transcribe({ audio: wav(), expectedSelection: META_SELECTION })
    ).rejects.toMatchObject({ code: "invalid-request" });
  });

  test("uses only the selected OpenRouter model and documented JSON/base64 body", async () => {
    const selectedCredential = credential("openrouter", "conn_openrouter01");
    const selectedPreferences = preferences("openrouter", selectedCredential.id);
    selectedPreferences.transcription.model = "openai/whisper-large-v3-turbo";
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.url = String(url);
      if (init) seen.init = init;
      return Response.json({ text: " spoken words ", usage: { seconds: 1.5, cost: 0.0002 } });
    }) as typeof fetch;
    const result = await service(fetchImpl, [selectedCredential], selectedPreferences).transcribe({
      audio: wav(),
      expectedSelection: { connectionId: selectedCredential.id, model: "openai/whisper-large-v3-turbo" }
    });
    expect(result).toMatchObject({
      text: "spoken words",
      provider: "openrouter",
      model: "openai/whisper-large-v3-turbo",
      durationMs: 1500,
      costUsd: 0.0002
    });
    expect(seen?.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(new Headers(seen?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(seen?.init?.body))).toMatchObject({
      model: "openai/whisper-large-v3-turbo",
      input_audio: { format: "wav", data: expect.any(String) }
    });
  });

  test("a removed saved connection stops before any fetch", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({ text: "never" });
    }) as unknown as typeof fetch;
    await expect(service(fetchImpl, [], preferences("meta", "conn_meta0000001")).transcribe({ audio: wav(), expectedSelection: META_SELECTION }))
      .rejects.toMatchObject({ code: "not-found", message: expect.stringMatching(/unavailable/i) });
    expect(calls).toBe(0);
  });

  test("a retired transcription model stops before sending audio", async () => {
    const selected = preferences("meta", "conn_meta0000001");
    selected.transcription.model = "retired/transcription";
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({ text: "never" });
    }) as unknown as typeof fetch;
    await expect(service(fetchImpl, [credential()], selected).transcribe({
      audio: wav(), expectedSelection: { ...META_SELECTION, model: "retired/transcription" }
    }))
      .rejects.toMatchObject({ code: "invalid-request" });
    expect(calls).toBe(0);
  });

  test("a changed connection or model refuses the recording before any provider request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({ text: "never" });
    }) as unknown as typeof fetch;
    const openrouter = credential("openrouter", "conn_openrouter01");
    const selected = preferences("openrouter", openrouter.id);
    for (const expectedSelection of [
      META_SELECTION,
      { connectionId: openrouter.id, model: "openai/whisper-large-v3" }
    ]) {
      await expect(service(fetchImpl, [credential(), openrouter], selected).transcribe({ audio: wav(), expectedSelection }))
        .rejects.toMatchObject({ code: "invalid-request", message: expect.stringMatching(/changed during dictation/i) });
    }
    expect(calls).toBe(0);
  });

  test("a later preference update cannot redirect a request already resolving its connection", async () => {
    const selected = preferences("meta", META_SELECTION.connectionId);
    const urls: string[] = [];
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      urls.push(String(url));
      return Response.json({ transcript: "Words", turns: [] });
    }) as typeof fetch;
    const pending = service(fetchImpl, [credential(), credential("openrouter", "conn_openrouter01")], selected)
      .transcribe({ audio: wav(), expectedSelection: META_SELECTION });
    selected.transcription.connectionId = "conn_openrouter01";
    selected.transcription.model = "openai/whisper-1";
    expect((await pending).provider).toBe("meta");
    expect(urls).toEqual(["https://api.meta.ai/v1/asr/transcribe"]);
  });
});
