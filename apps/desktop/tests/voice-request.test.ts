import { describe, expect, test } from "bun:test";
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";
import { VOICE_BUSY_KIND_MESSAGE } from "../src/main/voice-request";
import { hostFor, metaCredential, voiceFixture, runSpeaking, runTranscription, META_SELECTION } from "./support/voice-request-host";
import { SpeechService } from "../src/main/speech";

/*
 * The host is the only place where a public, renderer-visible id exists. These tests pin down
 * minting, cancellation races, ownership and the pre-begin refusal paths. Nothing here reads a
 * real keychain, opens a socket or touches the microphone.
 */

const SPOKEN: VoicePreferences = {
  ...DEFAULT_VOICE_PREFERENCES,
  speaking: { connectionId: "conn_openai01", model: "gpt-4o-mini-tts", voice: "nova" }
};

const openAiProviders = {
  list: async () => [
    { id: "conn_openai01", provider: "openai" as const, label: "OpenAI", kind: "api-key" as const, createdAt: "2026-10-26T12:00:00.000Z" }
  ],
  credential: async (id: string) => {
    if (id !== "conn_openai01") throw new Error("no such connection");
    return {
      id,
      provider: "openai" as const,
      label: "OpenAI",
      kind: "api-key" as const,
      createdAt: "2026-10-26T12:00:00.000Z",
      secret: "synthetic-openai-key"
    };
  }
};

function openAiFixture() {
  return hostFor(openAiProviders, SPOKEN);
}

describe("VoiceRequestHost reservations", () => {
  test("mints monotonically increasing public ids and emits starting", () => {
    const fixture = hostFor(
      {
        list: async () => [],
        credential: async () => { throw new Error("no credential"); }
      },
      DEFAULT_VOICE_PREFERENCES
    );
    const first = fixture.host.reserve("stt", 1, 1);
    const second = fixture.host.reserve("tts", 2, 1);
    expect(first?.publicId).toBe(1);
    expect(second?.publicId).toBe(2);
    const starts = fixture.events.filter((view) => view.phase === "starting");
    expect(starts.map((view) => view.operationId)).toEqual([1, 2]);
    expect(starts.every((view) => view.charge.state === "pending")).toBe(true);
  });

  test("caps concurrent reservations at eight and mints nothing past the cap", () => {
    const fixture = hostFor(
      {
        list: async () => [],
        credential: async () => { throw new Error("no credential"); }
      },
      DEFAULT_VOICE_PREFERENCES
    );
    const made = Array.from({ length: 9 }, () => fixture.host.reserve("stt", 1, 1));
    expect(made.filter(Boolean)).toHaveLength(8);
    expect(made[8]).toBeNull();
    expect(fixture.host.operation(1, 1 + 8)).toBeNull();
  });

  test("a reservation cancelled before resolution sends nothing and leaves no view behind", async () => {
    const fixture = voiceFixture({
      fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch
    });
    const reservation = fixture.host.reserve("stt", 1, 1, { ...META_SELECTION });
    if (!reservation) throw new Error("reserve refused");
    const cancel = fixture.host.cancel(1, reservation.publicId, "Stop.");
    expect(cancel).toEqual({ operationId: reservation.publicId, accepted: true, abortedLocally: false, released: true });

    const begun = await fixture.host.begin(reservation);
    expect(begun.ok).toBe(false);
    if (!begun.ok) {
      expect(begun.status).toBe("cancellation");
      expect(begun.receipt?.status).toBe("cancellation");
      expect(begun.receipt?.charge).toEqual({ state: "none" });
    }
    expect(fixture.events.some((view) => view.phase === "starting")).toBe(true);
    expect(fixture.registry.accounting().slots.stt).toBeNull();
    expect(fixture.registry.accounting().receipts).toHaveLength(0);
    expect(fixture.host.operation(1, reservation.publicId)).toBeNull();
  });

  test("a foreign window cannot cancel or read another window's reservation", async () => {
    const fixture = voiceFixture({
      fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch
    });
    const reservation = fixture.host.reserve("stt", 1, 1, { ...META_SELECTION });
    if (!reservation) throw new Error("reserve refused");

    expect(fixture.host.operation(2, reservation.publicId)).toBeNull();
    const foreign = fixture.host.cancel(2, reservation.publicId, "Stop.");
    expect(foreign).toEqual({ operationId: reservation.publicId, accepted: false, abortedLocally: false, released: false });
    // Still alive for the owner: cancel works and settles locally.
    const own = fixture.host.cancel(1, reservation.publicId, "Stop.");
    expect(own.accepted).toBe(true);
    expect(own.released).toBe(true);
  });

  test("a resolution refusal is minted, visible and charge-free", async () => {
    const fixture = voiceFixture({
      stored: [metaCredential({ id: "conn_meta0000001" })],
      preferences: {
        ...DEFAULT_VOICE_PREFERENCES,
        transcription: { connectionId: "conn_gone0000001", model: "muse-voice-transcribe-1.0" }
      },
      fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch
    });
    const outcome = await runTranscription(fixture.host, fixture.service, {
      audio: new Uint8Array([1, 2, 3]),
      expectedSelection: { connectionId: "conn_gone0000001", model: "muse-voice-transcribe-1.0" }
    });
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") {
      expect(outcome.message).toMatch(/unavailable/i);
      expect(outcome.receipt).not.toBeNull();
      expect(outcome.receipt?.charge).toEqual({ state: "none" });
      const seen = fixture.host.operation(1, outcome.receipt?.operationId ?? -1);
      expect(seen?.status).toBe("refusal");
    }
  });

  test("the speaking route never substitutes another connection", async () => {
    const fixture = openAiFixture();
    const speech = new SpeechService(
      openAiProviders as never,
      (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch
    );
    const outcome = await runSpeaking(fixture.host, speech, "Hello.");
    expect(outcome.status).toBe("success");
    expect(fixture.events.every((view) => view.connectionLabel === "" || view.connectionLabel === "OpenAI")).toBe(true);
    expect(fixture.events.at(-1)?.connectionLabel).toBe("OpenAI");
  });
});

describe("VoiceRequestHost route pinning", () => {
  test("the destination is a non-secret hash and the view never carries a URL", async () => {
    const fixture = voiceFixture({
      fetchImpl: (async () => Response.json({ transcript: "Words.", turns: [] })) as unknown as typeof fetch
    });
    const outcome = await runTranscription(fixture.host, fixture.service, {
      audio: wav(),
      expectedSelection: { ...META_SELECTION }
    });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.receipt.connectionLabel).toBe("Meta");
    expect(JSON.stringify(outcome.receipt)).not.toContain("https://");
    expect(JSON.stringify(outcome.receipt)).not.toContain("api.meta.ai");
  });

  test("the pinned destination changes with the base URL but never appears in the view", async () => {
    const first = voiceFixture({
      fetchImpl: (async () => Response.json({ transcript: "Words.", turns: [] })) as unknown as typeof fetch
    });
    const second = voiceFixture({
      stored: [metaCredential({ metadata: { baseUrl: "https://api.meta.ai/v2" } })],
      fetchImpl: (async () => Response.json({ transcript: "Words.", turns: [] })) as unknown as typeof fetch
    });
    const reservationA = first.host.reserve("stt", 1, 1, { ...META_SELECTION });
    const reservationB = second.host.reserve("stt", 1, 1, { ...META_SELECTION });
    const begunA = await first.host.begin(reservationA!);
    const begunB = await second.host.begin(reservationB!);
    if (!begunA.ok || !begunB.ok) throw new Error("begin refused");
    const routeA = (begunA.scope as unknown as { pinned: { route: { destination: string } } }).pinned.route;
    const routeB = (begunB.scope as unknown as { pinned: { route: { destination: string } } }).pinned.route;
    expect(routeA.destination).toMatch(/^endpoint:[0-9a-f]{16}$/);
    expect(routeB.destination).toMatch(/^endpoint:[0-9a-f]{16}$/);
    expect(routeA.destination).not.toBe(routeB.destination);
  });

  test("a voice-settings write between reservation and dispatch refuses with zero fetch", async () => {
    let fetches = 0;
    const fixture = voiceFixture({
      fetchImpl: (async () => {
        fetches += 1;
        return Response.json({ text: "never", turns: [] });
      }) as unknown as typeof fetch
    });
    const reservation = fixture.host.reserve("stt", 1, 1, { ...META_SELECTION });
    if (!reservation) throw new Error("reserve refused");
    const begun = await fixture.host.begin(reservation);
    if (!begun.ok) throw new Error("begin refused");
    // Author saves any voice setting between resolution and dispatch.
    fixture.routes.bump();
    const outcome = await fixture.service.transcribe({ audio: wav() }, begun.scope);
    expect(outcome.status).toBe("refusal");
    expect(fetches).toBe(0);
  });

  test("a busy kind refuses instead of overlapping an uncertain request", async () => {
    const fixture = openAiFixture();
    const firstReservation = fixture.host.reserve("tts", 1, 1);
    if (!firstReservation) throw new Error("reserve refused");
    const firstBegin = fixture.host.begin(firstReservation);
    const second = fixture.host.reserve("tts", 1, 1);
    if (!second) throw new Error("reserve refused");
    const first = await firstBegin;
    if (!first.ok) throw new Error("first begin refused");
    const secondBegin = await fixture.host.begin(second);
    expect(secondBegin.ok).toBe(false);
    if (!secondBegin.ok) {
      expect(secondBegin.status).toBe("refusal");
      expect(secondBegin.message).toBe(VOICE_BUSY_KIND_MESSAGE);
      expect(secondBegin.receipt?.charge).toEqual({ state: "none" });
    }
  });

  test("a foreign sender cannot read or cancel through the host", async () => {
    const fixture = openAiFixture();
    const reservation = fixture.host.reserve("tts", 1, 7);
    if (!reservation) throw new Error("reserve refused");
    expect(fixture.host.operation(8, reservation.publicId)).toBeNull();
    const cancelled = fixture.host.cancel(8, reservation.publicId);
    expect(cancelled.accepted).toBe(false);
    const own = fixture.host.cancel(7, reservation.publicId);
    expect(own.accepted).toBe(true);
  });
});

function wav(): Uint8Array {
  const sampleRate = 16_000;
  const dataBytes = sampleRate * 2;
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
