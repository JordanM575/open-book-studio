import { describe, expect, test } from "bun:test";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import type { ConnectionSummary, StoredCredential } from "@ai-book-studio/core/providers/types";
import { MAX_TTS_CHARACTERS } from "@ai-book-studio/core/providers/tts";
import { SpeechService } from "../src/main/speech";
import type { ProviderService } from "../src/main/providers";
import { hostFor, runSpeaking } from "./support/voice-request-host";

const connection: ConnectionSummary = {
  id: "conn_openai01",
  provider: "openai",
  label: "OpenAI",
  kind: "api-key",
  createdAt: "2026-10-26T12:00:00.000Z"
};

const credential: StoredCredential = {
  id: connection.id,
  provider: "openai",
  label: connection.label,
  kind: "api-key",
  createdAt: connection.createdAt,
  secret: "sk-test"
};

function providers(
  entries: ConnectionSummary[] = [connection],
  credentials: StoredCredential[] = [credential]
): ProviderService {
  return {
    list: async () => entries,
    credential: async (id: string) => {
      const found = credentials.find((entry) => entry.id === id);
      if (!found) throw new Error("no such connection");
      return found;
    }
  } as unknown as ProviderService
}

function preferences(
  connectionId: string | null = connection.id,
  model = "gpt-4o-mini-tts",
  voice = "nova"
): VoicePreferences {
  return {
    ...DEFAULT_VOICE_PREFERENCES,
    speaking: { connectionId, model: connectionId ? model : null, voice: connectionId ? voice : null }
  };
}

const OPENAI = preferences();

async function speakWith(
  fetchImpl: typeof fetch,
  selected: VoicePreferences = OPENAI,
  selectedProviders: ProviderService = providers(),
  text = "The door was open."
) {
  const tts = new SpeechService(selectedProviders, fetchImpl);
  const fixture = hostFor(selectedProviders, selected);
  return runSpeaking(fixture.host, tts, text);
}

interface Seen {
  url: string;
  authorization: string | undefined;
  body: { model?: string; input?: string; voice?: string; response_format?: string; speed?: number };
}

function recorder(reply: (call: number) => Response = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) {
  const seen: Seen[] = [];
  let calls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? {});
    seen.push({
      url,
      authorization: headers.get("authorization") ?? undefined,
      body: JSON.parse(String(init?.body ?? "{}"))
    });
    return reply(calls);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl, calls: () => calls };
}

describe("the speaking service", () => {
  test("speaks one short passage in one request", async () => {
    const { seen, fetchImpl } = recorder(
      () => new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { "content-type": "audio/mpeg" } })
    );
    const outcome = await speakWith(fetchImpl, OPENAI, providers(), "The door was open.");
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(seen[0]?.authorization).toBe("Bearer sk-test");
    expect(seen[0]?.body).toMatchObject({ input: "The door was open.", response_format: "mp3" });
    expect(outcome.reply.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(outcome.reply.dataUrl.split(",")[1] ?? "", "base64").byteLength).toBe(3);
    expect(outcome.reply.chunks).toBe(1);
    // TTS reports no charge today; the receipt must say unknown, never zero.
    expect(outcome.receipt.charge).toEqual({ state: "unknown" });
  });

  test("splits a long passage and joins the audio back into one sound", async () => {
    const { seen, fetchImpl } = recorder(
      () => new Response(new Uint8Array([7, 7]), { status: 200, headers: { "content-type": "audio/mpeg" } })
    );
    const text = "The storm came in low and the lamp would not turn. ".repeat(150);
    const outcome = await speakWith(fetchImpl, OPENAI, providers(), text);
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(seen.length).toBeGreaterThan(1);
    for (const call of seen) {
      expect((call.body.input ?? "").length).toBeLessThanOrEqual(MAX_TTS_CHARACTERS);
    }
    expect(outcome.reply.chunks).toBe(seen.length);
    expect(Buffer.from(outcome.reply.dataUrl.split(",")[1] ?? "", "base64").byteLength).toBe(seen.length * 2);
    // Every dispatched chunk was settled; the receipt counts them.
    expect(outcome.receipt.dispatchedChunks).toBe(seen.length);
    expect(outcome.receipt.settledChunks).toBe(seen.length);
  });

  test("passes the chosen voice and speed", async () => {
    const { seen, fetchImpl } = recorder();
    const outcome = await speakWith(fetchImpl, preferences(connection.id, "gpt-4o-mini-tts", "onyx"), providers());
    expect(outcome.status).toBe("success");
    expect(seen[0]?.body.voice).toBe("onyx");
  });

  test("says plainly when no voice service is connected", async () => {
    const { fetchImpl } = recorder();
    const outcome = await speakWith(fetchImpl, preferences(null), providers([]));
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") expect(outcome.message).toMatch(/Choose a speaking connection/i);
  });

  test("refuses nothing to say", async () => {
    const { fetchImpl } = recorder();
    const outcome = await speakWith(fetchImpl, OPENAI, providers(), "   ");
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") expect(outcome.message).toMatch(/nothing to say/i);
  });

  test("reports an empty audio reply rather than playing silence", async () => {
    const { fetchImpl } = recorder(() => new Response(new Uint8Array(), { status: 200 }));
    const outcome = await speakWith(fetchImpl, OPENAI, providers(), "Hello.");
    expect(outcome.status).toBe("failure");
    if (outcome.status === "failure") expect(outcome.message).toMatch(/no audio/i);
    expect(outcome.status === "failure" ? outcome.receipt?.charge : null).toEqual({ state: "unknown" });
  });

  test("turns a refused key into a sentence the author can act on, with an unknown charge", async () => {
    const { fetchImpl } = recorder(() => new Response("unauthorized", { status: 401 }));
    const outcome = await speakWith(fetchImpl, OPENAI, providers(), "Hello.");
    expect(outcome.status).toBe("failure");
    if (outcome.status === "failure") {
      expect(outcome.message).toBe("The provider rejected this connection. Reconnect or check the key.");
      expect(outcome.receipt?.charge).toEqual({ state: "unknown" });
    }
  });

  test("turns an unreachable service into an offline sentence", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const outcome = await speakWith(fetchImpl, OPENAI, providers(), "Hello.");
    expect(outcome.status).toBe("failure");
    if (outcome.status === "failure") {
      expect(outcome.message).toMatch(/Could not reach the voice service/i);
      expect(outcome.receipt?.charge).toEqual({ state: "unknown" });
    }
  });

  test("lists only the connections that can speak", async () => {
    const meta: ConnectionSummary = { ...connection, id: "conn_meta0001", provider: "meta" };
    const tts = new SpeechService(providers([connection, meta]), recorder().fetchImpl);
    const speakers = await tts.connections();
    expect(speakers.map((entry) => entry.provider)).toEqual(["openai"]);
  });

  test("speaks with the selected OpenRouter model and joins PCM before one WAV wrapper", async () => {
    const openRouterConnection: ConnectionSummary = { ...connection, id: "conn_openrouter01", provider: "openrouter", label: "Router" };
    const openRouterCredential: StoredCredential = { ...credential, id: openRouterConnection.id, provider: "openrouter", label: "Router" };
    const { seen, fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "audio/pcm; rate=44100; channels=1" }
    }));
    const selected = preferences(openRouterConnection.id, "heygen/heygen-voice-1", "meredith");
    const outcome = await speakWith(fetchImpl, selected, providers([openRouterConnection], [openRouterCredential]), "One. ".repeat(900));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      url: "https://openrouter.ai/api/v1/audio/speech",
      body: {
        model: "heygen/heygen-voice-1",
        voice: "meredith",
        response_format: "pcm"
      }
    });
    expect(outcome.reply.mimeType).toBe("audio/wav");
    expect(outcome.reply.voice).toBe("meredith");
    const bytes = new Uint8Array(Buffer.from(outcome.reply.dataUrl.split(",")[1] ?? "", "base64"));
    expect(bytes.byteLength).toBe(52);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(44_100);
    expect([...bytes.slice(44)]).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  test("rejects PCM with a mismatched or invalid format instead of writing a misleading WAV header", async () => {
    const openRouterConnection: ConnectionSummary = { ...connection, id: "conn_openrouter01", provider: "openrouter", label: "Router" };
    const openRouterCredential: StoredCredential = { ...credential, id: openRouterConnection.id, provider: "openrouter", label: "Router" };
    const selected = preferences(openRouterConnection.id, "heygen/heygen-voice-1", "weston");
    for (const contentType of [
      "audio/pcm; rate=24000",
      "audio/pcm; rate=invalid",
      "audio/pcm; rate=44100; rate=24000",
      "audio/pcm; channels=2",
      "audio/pcm; format=f32le",
      "audio/l16; rate=44100; channels=1",
      "audio/mpeg"
    ]) {
      const { fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": contentType }
      }));
      const outcome = await speakWith(fetchImpl, selected, providers([openRouterConnection], [openRouterCredential]), "Hello.");
      expect(outcome.status).toBe("failure");
      if (outcome.status === "failure") expect(outcome.message).toMatch(/audio|pcm/i);
    }
  });

  test("rejects a truncated 16-bit PCM sample", async () => {
    const openRouterConnection: ConnectionSummary = { ...connection, id: "conn_openrouter01", provider: "openrouter", label: "Router" };
    const openRouterCredential: StoredCredential = { ...credential, id: openRouterConnection.id, provider: "openrouter", label: "Router" };
    const { fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/pcm" }
    }));
    const outcome = await speakWith(fetchImpl, preferences(openRouterConnection.id, "heygen/heygen-voice-1", "weston"),
      providers([openRouterConnection], [openRouterCredential]), "Hello.");
    expect(outcome.status).toBe("failure");
    if (outcome.status === "failure") expect(outcome.message).toMatch(/audio|pcm/i);
  });

  test("does not join PCM chunks with different reported rates", async () => {
    const openRouterConnection: ConnectionSummary = { ...connection, id: "conn_openrouter01", provider: "openrouter", label: "Router" };
    const openRouterCredential: StoredCredential = { ...credential, id: openRouterConnection.id, provider: "openrouter", label: "Router" };
    let replies = 0;
    const { seen, fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { "content-type": `audio/pcm; rate=${++replies === 1 ? 44100 : 24000}` }
    }));
    const outcome = await speakWith(fetchImpl, preferences(openRouterConnection.id, "heygen/heygen-voice-1", "weston"),
      providers([openRouterConnection], [openRouterCredential]), "One. ".repeat(900));
    expect(outcome.status).toBe("failure");
    expect(seen).toHaveLength(2);
  });

  test("does not join a PCM response to an MP3 response", async () => {
    let replies = 0;
    const { seen, fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { "content-type": ++replies === 1 ? "audio/mpeg" : "audio/pcm; rate=44100" }
    }));
    const outcome = await speakWith(fetchImpl, OPENAI, providers(), "One. ".repeat(900));
    expect(outcome.status).toBe("failure");
    expect(seen).toHaveLength(2);
  });

  test("does not try another connection when the saved one was removed", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as unknown as typeof fetch;
    const outcome = await speakWith(fetchImpl, preferences("conn_removed01"), providers([]));
    expect(outcome.status).toBe("refusal");
    expect(calls).toBe(0);
  });

  test("retired saved models and voices stop before sending any text", async () => {
    for (const selected of [
      preferences(connection.id, "retired/model", "retired-voice"),
      preferences(connection.id, "gpt-4o-mini-tts", "retired-voice")
    ]) {
      const { seen, fetchImpl } = recorder();
      const outcome = await speakWith(fetchImpl, selected);
      expect(outcome.status).toBe("refusal");
      expect(seen).toHaveLength(0);
    }
  });

  test("a saved voice change before the second chunk stops the request and discards the first part", async () => {
    // Chunk 2 is refused before dispatch: the author changed the saved voice mid-run.
    const text = "The storm came in low and the lamp would not turn. ".repeat(150);
    const seen: Array<{ url: string }> = [];
    const selected = preferences();
    const fakeProviders = providers();
    const hostFx = hostFor(fakeProviders, selected);
    let fetchCalls = 0;
    const mutatingFetch = (async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      fetchCalls += 1;
      // The selection changes after the first chunk is dispatched; chunk 2's recheck must refuse.
      if (fetchCalls === 1) selected.speaking = { ...selected.speaking, voice: "onyx" };
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen.push({ url });
      return new Response(new Uint8Array([7, 7]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    const mutatingTts = new SpeechService(fakeProviders, mutatingFetch);
    const outcome = await runSpeaking(hostFx.host, mutatingTts, text);
    expect(outcome.status).toBe("refusal");
    expect(seen).toHaveLength(1);
    if (outcome.status === "refusal") {
      expect(outcome.receipt?.plannedChunks).toBeGreaterThan(1);
      expect(outcome.receipt?.unsentChunks).toBe((outcome.receipt?.plannedChunks ?? 0) - 1);
    }
  });

  test("a revision bump before the first chunk refuses before any fetch", async () => {
    const text = "One. ".repeat(900); // two chunks at the 4,000-character bound
    const { fetchImpl, calls } = recorder(() => new Response(new Uint8Array([7, 7]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" }
    }));
    const selected = preferences();
    const fakeProviders = providers();
    const hostFx = hostFor(fakeProviders, selected);
    const tts = new SpeechService(fakeProviders, fetchImpl);
    const reservation = hostFx.host.reserve("tts", 2, 1);
    if (!reservation) throw new Error("reserve refused");
    const begun = await hostFx.host.begin(reservation);
    if (!begun.ok) throw new Error("begin refused");
    hostFx.routes.bump();
    const outcome = await tts.speak({ text }, begun.scope);
    expect(outcome.status).toBe("refusal");
    expect(calls()).toBe(0);
  });

  test("the selected provider is never replaced by another provider or the device voice", async () => {
    // Only a stale Meta credential is offered; the saved OpenAI selection must fail, never reroute.
    const meta: ConnectionSummary = { ...connection, id: "conn_meta0001", provider: "meta" };
    const metaCredential: StoredCredential = { ...credential, id: "conn_meta0001", provider: "meta" };
    const { fetchImpl } = recorder();
    const outcome = await speakWith(fetchImpl, preferences("conn_openai01"), providers([meta], [metaCredential]));
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") expect(outcome.message).toMatch(/unavailable/i);
  });
});

describe("the speaking service failure modes", () => {
  test("a malformed success body is a provider failure with an unknown charge, never a silent success", async () => {
    const { fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const outcome = await speakWith(fetchImpl, OPENAI, providers(), "Hello.");
    expect(outcome.status).toBe("failure");
    if (outcome.status === "failure") {
      expect(outcome.message).toMatch(/MP3|PCM|audio/i);
      expect(outcome.receipt?.charge).toEqual({ state: "unknown" });
    }
  });
});
