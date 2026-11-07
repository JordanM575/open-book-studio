import { describe, expect, test } from "bun:test";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import type { ConnectionSummary, StoredCredential } from "@ai-book-studio/core/providers/types";
import { MAX_TTS_CHARACTERS } from "@ai-book-studio/core/providers/tts";
import { SpeechService } from "../src/main/speech";
import type { ProviderService } from "../src/main/providers";

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
  } as unknown as ProviderService;
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

function service(fetchImpl: typeof fetch, selected: VoicePreferences = preferences(), selectedProviders = providers()): SpeechService {
  return new SpeechService(selectedProviders, fetchImpl, () => selected);
}

interface Seen {
  url: string;
  authorization: string | undefined;
  body: { model?: string; input?: string; voice?: string; response_format?: string; speed?: number };
}

function recorder(reply: () => Response = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? {});
    seen.push({
      url,
      authorization: headers.get("authorization") ?? undefined,
      body: JSON.parse(String(init?.body ?? "{}"))
    });
    return reply();
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe("the speaking service", () => {
  test("speaks one short passage in one request", async () => {
    const { seen, fetchImpl } = recorder(
      () =>
        new Response(new Uint8Array([9, 9, 9]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" }
        })
    );
    const result = await service(fetchImpl).speak({ text: "The door was open." });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(seen[0]?.authorization).toBe("Bearer sk-test");
    expect(seen[0]?.body).toMatchObject({ input: "The door was open.", response_format: "mp3" });
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.bytes.byteLength).toBe(3);
    expect(result.chunks).toBe(1);
  });

  test("splits a long passage and joins the audio back into one sound", async () => {
    const { seen, fetchImpl } = recorder(
      () => new Response(new Uint8Array([7, 7]), { status: 200, headers: { "content-type": "audio/mpeg" } })
    );
    const text = "The storm came in low and the lamp would not turn. ".repeat(150);
    const result = await service(fetchImpl).speak({ text });
    expect(seen.length).toBeGreaterThan(1);
    for (const call of seen) {
      expect((call.body.input ?? "").length).toBeLessThanOrEqual(MAX_TTS_CHARACTERS);
    }
    expect(result.chunks).toBe(seen.length);
    // Two bytes per chunk, joined into one buffer.
    expect(result.bytes.byteLength).toBe(seen.length * 2);
  });

  test("passes the chosen voice and speed", async () => {
    const { seen, fetchImpl } = recorder();
    await service(fetchImpl, preferences(connection.id, "gpt-4o-mini-tts", "onyx")).speak({ text: "Hello.", speed: 0.9 });
    expect(seen[0]?.body.voice).toBe("onyx");
    expect(seen[0]?.body.speed).toBe(0.9);
  });

  test("says plainly when no voice service is connected", async () => {
    const { fetchImpl } = recorder();
    await expect(service(fetchImpl, preferences(null), providers([])).speak({ text: "Hello." })).rejects.toThrow(
      /Choose a speaking connection/i
    );
  });

  test("refuses nothing to say", async () => {
    const { fetchImpl } = recorder();
    await expect(service(fetchImpl).speak({ text: "   " })).rejects.toThrow(
      /nothing to say/i
    );
  });

  test("reports an empty audio reply rather than playing silence", async () => {
    const { fetchImpl } = recorder(() => new Response(new Uint8Array(), { status: 200 }));
    await expect(service(fetchImpl).speak({ text: "Hello." })).rejects.toThrow(
      /no audio/i
    );
  });

  test("turns a refused key into a sentence the author can act on", async () => {
    const { fetchImpl } = recorder(() => new Response("unauthorized", { status: 401 }));
    await expect(service(fetchImpl).speak({ text: "Hello." })).rejects.toMatchObject({
      code: "auth"
    });
  });

  test("turns an unreachable service into an offline sentence", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(service(fetchImpl).speak({ text: "Hello." })).rejects.toMatchObject({
      code: "offline"
    });
  });

  test("lists only the connections that can speak", async () => {
    const meta: ConnectionSummary = { ...connection, id: "conn_meta0001", provider: "meta" };
    const voiceService = service(recorder().fetchImpl, preferences(), providers([connection, meta]));
    const speakers = await voiceService.connections();
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
    const result = await service(fetchImpl, selected, providers([openRouterConnection], [openRouterCredential])).speak({ text: "One. ".repeat(900) });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      url: "https://openrouter.ai/api/v1/audio/speech",
      body: {
        model: "heygen/heygen-voice-1",
        voice: "meredith",
        response_format: "pcm"
      }
    });
    expect(result.mimeType).toBe("audio/wav");
    expect(result.voice).toBe("meredith");
    expect(result.costUsd).toBeNull();
    expect(result.bytes.byteLength).toBe(52);
    expect(String.fromCharCode(...result.bytes.slice(0, 4))).toBe("RIFF");
    expect(new DataView(result.bytes.buffer).getUint32(24, true)).toBe(44_100);
    expect([...result.bytes.slice(44)]).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
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
      await expect(service(fetchImpl, selected, providers([openRouterConnection], [openRouterCredential]))
        .speak({ text: "Hello." })).rejects.toThrow(/audio|pcm/i);
    }
  });

  test("rejects a truncated 16-bit PCM sample", async () => {
    const openRouterConnection: ConnectionSummary = { ...connection, id: "conn_openrouter01", provider: "openrouter", label: "Router" };
    const openRouterCredential: StoredCredential = { ...credential, id: openRouterConnection.id, provider: "openrouter", label: "Router" };
    const { fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/pcm" }
    }));
    await expect(service(fetchImpl, preferences(openRouterConnection.id, "heygen/heygen-voice-1", "weston"),
      providers([openRouterConnection], [openRouterCredential])).speak({ text: "Hello." })).rejects.toThrow(/audio|pcm/i);
  });

  test("does not join PCM chunks with different reported rates", async () => {
    const openRouterConnection: ConnectionSummary = { ...connection, id: "conn_openrouter01", provider: "openrouter", label: "Router" };
    const openRouterCredential: StoredCredential = { ...credential, id: openRouterConnection.id, provider: "openrouter", label: "Router" };
    let replies = 0;
    const { seen, fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { "content-type": `audio/pcm; rate=${++replies === 1 ? 44100 : 24000}` }
    }));
    await expect(service(fetchImpl, preferences(openRouterConnection.id, "heygen/heygen-voice-1", "weston"),
      providers([openRouterConnection], [openRouterCredential])).speak({ text: "One. ".repeat(900) }))
      .rejects.toThrow(/audio|pcm/i);
    expect(seen).toHaveLength(2);
  });

  test("does not join a PCM response to an MP3 response", async () => {
    let replies = 0;
    const { seen, fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { "content-type": ++replies === 1 ? "audio/mpeg" : "audio/pcm; rate=44100" }
    }));
    await expect(service(fetchImpl).speak({ text: "One. ".repeat(900) })).rejects.toThrow(/audio|mp3/i);
    expect(seen).toHaveLength(2);
  });

  test("does not try another connection when the saved one was removed", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(service(fetchImpl, preferences("conn_removed01"), providers([])).speak({ text: "Hello." }))
      .rejects.toMatchObject({ code: "not-found" });
    expect(calls).toBe(0);
  });

  test("retired saved models and voices stop before sending any text", async () => {
    for (const selected of [
      preferences(connection.id, "retired/model", "retired-voice"),
      preferences(connection.id, "gpt-4o-mini-tts", "retired-voice")
    ]) {
      const { seen, fetchImpl } = recorder();
      await expect(service(fetchImpl, selected).speak({ text: "Private words." }))
        .rejects.toMatchObject({ code: "invalid-request" });
      expect(seen).toHaveLength(0);
    }
  });
});
