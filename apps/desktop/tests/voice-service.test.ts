import { describe, expect, test } from "bun:test";
import type { StoredCredential } from "@ai-book-studio/core/providers/types";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import { META_SELECTION, metaCredential, voiceFixture, runTranscription } from "./support/voice-request-host";
import { VoiceService } from "../src/main/voice";

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
  const base = metaCredential({ provider, id });
  if (provider === "meta") return base;
  const { metadata: _dropped, ...rest } = base;
  return rest;
}

function preferences(provider: "meta" | "openrouter" | null, connectionId: string | null): VoicePreferences {
  if (provider === "meta") {
    return { ...DEFAULT_VOICE_PREFERENCES, transcription: { connectionId, model: "muse-voice-transcribe-1.0" } };
  }
  if (provider === "openrouter") {
    return { ...DEFAULT_VOICE_PREFERENCES, transcription: { connectionId, model: "openai/whisper-1" } };
  }
  return DEFAULT_VOICE_PREFERENCES;
}

const neverFetch = (async () => {
  throw new Error("the provider must not be called");
}) as unknown as typeof fetch;

describe("VoiceService", () => {
  test("posts the documented Meta form and returns the transcript", async () => {
    const captured: { url?: string; init?: RequestInit | undefined } = {};
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return Response.json({ transcript: " Hello there. ", audioDurationMs: 3000, turns: [] });
    }) as typeof fetch;
    const fx = voiceFixture({ fetchImpl });
    const service = new VoiceService(fx.providers, fx.fetchImpl);
    const outcome = await runTranscription(fx.host, fx.service, { audio: wav(), expectedSelection: { ...META_SELECTION } });

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.transcript).toMatchObject({
      text: "Hello there.",
      provider: "meta",
      connectionLabel: "Meta",
      model: "muse-voice-transcribe-1.0",
      durationMs: 3000
    });
    expect(outcome.receipt.status).toBe("success");
    expect(captured?.url).toBe("https://api.meta.ai/v1/asr/transcribe");
    const init = captured.init;
    if (!init) throw new Error("the provider was never called");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer synthetic-meta-key");
    const form = init.body as FormData;
    const request = JSON.parse(await (form.get("request") as Blob).text()) as Record<string, unknown>;
    expect(request).toMatchObject({ mode: "PUSH_TO_TALK", model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" });
    expect(form.get("audio")).toBeInstanceOf(Blob);
    expect(fx.events.map((view) => view.phase)).toEqual(["starting", "in-flight", "settled"]);
    void service;
  });

  test("refuses non-WAV audio before any request", async () => {
    const fx = voiceFixture({ fetchImpl: neverFetch });
    const outcome = await runTranscription(fx.host, fx.service, { audio: new TextEncoder().encode("not audio") });
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") {
      expect(outcome.receipt?.charge).toEqual({ state: "none" });
    }
    expect(fx.events.some((view) => view.phase === "in-flight")).toBe(false);
  });

  test("normalizes an auth failure without leaking the key", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid key synthetic-meta-key" }), { status: 401 })) as unknown as typeof fetch;
    const fx = voiceFixture({ fetchImpl });
    const outcome = await runTranscription(fx.host, fx.service, { audio: wav(), expectedSelection: { ...META_SELECTION } });
    expect(outcome.status).toBe("failure");
    if (outcome.status !== "failure") return;
    expect(outcome.message).toBe("The provider rejected this connection. Reconnect or check the key.");
    expect(outcome.message).not.toContain("synthetic-meta-key");
    expect(outcome.receipt?.charge).toEqual({ state: "unknown" });
    expect(outcome.receipt?.message ?? "").not.toContain("synthetic-meta-key");
  });

  test("requires an explicit saved transcription connection", async () => {
    const fx = voiceFixture({
      fetchImpl: neverFetch,
      stored: [],
      preferences: DEFAULT_VOICE_PREFERENCES
    });
    const outcome = await runTranscription(fx.host, fx.service, { audio: wav(), expectedSelection: { ...META_SELECTION } });
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") {
      expect(outcome.message).toMatch(/Choose a transcription connection/i);
    }
  });

  test("lists only speech-capable connections", async () => {
    const fx = voiceFixture({
      fetchImpl: neverFetch,
      stored: [credential("openai", "conn_openai00001"), credential("meta", "conn_meta0000001")]
    });
    const service = new VoiceService(fx.providers, fx.fetchImpl);
    const connections = await service.connections();
    expect(connections.map((entry) => entry.provider)).toEqual(["meta"]);
  });

  test("refuses when the saved connection is not speech-capable", async () => {
    const fx = voiceFixture({
      fetchImpl: neverFetch,
      stored: [credential("openai", "conn_openai00001")],
      preferences: preferences("meta", "conn_openai00001")
    });
    const outcome = await runTranscription(fx.host, fx.service, {
      audio: wav(),
      expectedSelection: { connectionId: "conn_openai00001", model: "muse-voice-transcribe-1.0" }
    });
    expect(outcome.status).toBe("refusal");
  });

  test("uses only the selected OpenRouter model and documented JSON/base64 body", async () => {
    const selected = { ...preferences("openrouter", "conn_openrouter01") };
    selected.transcription.model = "openai/whisper-large-v3-turbo";
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.url = String(url);
      if (init) seen.init = init;
      return Response.json({ text: " spoken words ", usage: { seconds: 1.5, cost: 0.0002 } });
    }) as typeof fetch;
    const fx = voiceFixture({
      fetchImpl,
      stored: [credential("openrouter", "conn_openrouter01")],
      preferences: selected
    });
    const outcome = await runTranscription(fx.host, fx.service, {
      audio: wav(),
      expectedSelection: { connectionId: "conn_openrouter01", model: "openai/whisper-large-v3-turbo" }
    });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.transcript).toMatchObject({
      text: "spoken words",
      provider: "openrouter",
      model: "openai/whisper-large-v3-turbo",
      durationMs: 1500,
      costUsd: 0.0002
    });
    expect(outcome.receipt.charge).toEqual({ state: "reported", usd: 0.0002 });
    expect(seen?.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(new Headers(seen?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(seen?.init?.body))).toMatchObject({
      model: "openai/whisper-large-v3-turbo",
      input_audio: { format: "wav", data: expect.any(String) }
    });
  });

  test("a removed saved connection stops before any fetch", async () => {
    const fx = voiceFixture({ fetchImpl: neverFetch, stored: [], preferences: preferences("meta", "conn_meta0000001") });
    const outcome = await runTranscription(fx.host, fx.service, { audio: wav(), expectedSelection: { ...META_SELECTION } });
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") expect(outcome.message).toMatch(/unavailable/i);
  });

  test("a retired transcription model stops before sending audio", async () => {
    const selected = preferences("meta", "conn_meta0000001");
    selected.transcription.model = "retired/transcription";
    const fx = voiceFixture({ fetchImpl: neverFetch, stored: [credential()], preferences: selected });
    const outcome = await runTranscription(fx.host, fx.service, {
      audio: wav(),
      expectedSelection: { connectionId: "conn_meta0000001", model: "retired/transcription" }
    });
    expect(outcome.status).toBe("refusal");
  });

  test("a changed connection or model refuses the recording before any provider request", async () => {
    const selected = preferences("openrouter", "conn_openrouter01");
    const fx = voiceFixture({
      fetchImpl: neverFetch,
      stored: [credential(), credential("openrouter", "conn_openrouter01")],
      preferences: selected
    });
    for (const expectedSelection of [
      { ...META_SELECTION },
      { connectionId: "conn_openrouter01", model: "openai/whisper-large-v3" }
    ]) {
      const outcome = await runTranscription(fx.host, fx.service, { audio: wav(), expectedSelection });
      expect(outcome.status).toBe("refusal");
      if (outcome.status === "refusal") expect(outcome.message).toMatch(/changed during dictation/i);
    }
  });

  test("a route revision bump during the request refuses before dispatch", async () => {
    const fx = voiceFixture({ fetchImpl: neverFetch });
    const reservation = fx.host.reserve("stt", 1, 1, { ...META_SELECTION });
    if (!reservation) throw new Error("reserve refused");
    const begun = await fx.host.begin(reservation);
    if (!begun.ok) throw new Error("begin refused");
    // Any voice-settings write or connection removal bumps the revision; an A→B→A round trip still refuses.
    fx.routes.bump();
    const service = new VoiceService(fx.providers, fx.fetchImpl);
    const outcome = await service.transcribe({ audio: wav() }, begun.scope);
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") {
      expect(outcome.message).toMatch(/changed/i);
      expect(outcome.receipt?.charge).toEqual({ state: "none" });
    }
  });

  test("the selection is not redirected when it changes while the request is resolving", async () => {
    const fx = voiceFixture({
      fetchImpl: neverFetch,
      stored: [credential(), credential("openrouter", "conn_openrouter01")],
      preferences: preferences("meta", "conn_meta0000001")
    });
    // Simulate the author switching the selection while the resolution is in flight.
    const originalList = fx.providers.list.bind(fx.providers);
    fx.providers.list = async () => {
      fx.preferences.transcription = { connectionId: "conn_openrouter01", model: "openai/whisper-1" };
      fx.routes.bump();
      return originalList();
    };
    const outcome = await runTranscription(fx.host, fx.service, { audio: wav(), expectedSelection: { ...META_SELECTION } });
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") expect(outcome.message).toMatch(/changed/i);
  });

  test("a refusal after pinning never reaches the provider", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({ transcript: "never" });
    }) as unknown as typeof fetch;
    const fx = voiceFixture({ fetchImpl });
    const outcome = await runTranscription(fx.host, fx.service, {
      audio: wav(),
      expectedSelection: { connectionId: "conn_meta0000001", model: "retired/transcription" }
    });
    expect(outcome.status).toBe("refusal");
    expect(calls).toBe(0);
  });
});
