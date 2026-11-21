import { describe, expect, test } from "bun:test";
import { META_SPEECH_MODEL, type VoiceTranscript } from "@ai-book-studio/core/providers/speech";
import { ProviderError } from "@ai-book-studio/core/providers/types";
import type { TransportEvent } from "../../../packages/core/src/voice-session/transport";
import { SpeechService, type SpeakResult } from "../src/main/speech";
import { VoiceService } from "../src/main/voice";
import { hostFor, voiceFixture } from "./support/voice-request-host";
import { DEFAULT_VOICE_PREFERENCES } from "@ai-book-studio/core/providers/voice-preferences";
import type { ConnectionSummary, StoredCredential } from "@ai-book-studio/core/providers/types";
import type { ProviderService } from "../src/main/providers";

const TTS_CONNECTION: ConnectionSummary = {
  id: "conn_openai01", provider: "openai", label: "OpenAI", kind: "api-key", createdAt: "2026-10-26T12:00:00.000Z"
};
const TTS_CREDENTIAL: StoredCredential = {
  ...TTS_CONNECTION, secret: "synthetic-openai-key"
};
const TTS_PREFERENCES = {
  ...DEFAULT_VOICE_PREFERENCES,
  speaking: { connectionId: "conn_openai01", model: "gpt-4o-mini-tts", voice: "nova" }
};
const TTS_PROVIDERS = {
  list: async () => [TTS_CONNECTION],
  credential: async (id: string) => {
    if (id !== TTS_CONNECTION.id) throw new Error("no such connection");
    return TTS_CREDENTIAL;
  }
} as unknown as ProviderService;
import {
  reportedCharge, requestSignal, settlementForFailure, settlementForSpeech, settlementForTranscript,
} from "../src/main/voice-transport";

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

describe("voice transport charge vocabulary", () => {
  test("only a provider-reported finite, non-negative amount is a report", () => {
    expect(reportedCharge(0.12)).toEqual({ state: "reported", usd: 0.12 });
    expect(reportedCharge(0)).toEqual({ state: "reported", usd: 0 });
    for (const unknown of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(reportedCharge(unknown)).toEqual({ state: "unknown" });
    }
  });

  test("reported results keep the reported amount; an absent amount stays unknown", () => {
    const transcript = {
      text: "Synthetic.", provider: "meta", connectionLabel: "Meta", model: META_SPEECH_MODEL,
      durationMs: 1_000, costUsd: 0.02, turns: [],
    } satisfies VoiceTranscript;
    expect(settlementForTranscript(transcript)).toEqual({ outcome: "success", costUsd: 0.02 });
    expect(settlementForTranscript({ ...transcript, costUsd: null }))
      .toEqual({ outcome: "success", costUsd: null });

    const speech = {
      bytes: new Uint8Array(), mimeType: "audio/mpeg", characters: 10,
      connectionLabel: "OpenAI", model: "gpt-4o-mini-tts", voice: "nova", chunks: 1, costUsd: null,
    } satisfies SpeakResult;
    expect(settlementForSpeech(speech)).toEqual({ outcome: "success", costUsd: null });
  });
});

describe("voice transport failure settlement", () => {
  test("distinguishes local refusal, provider failure and cancellation", () => {
    for (const code of ["invalid-request", "not-found", "unsupported"] as const) {
      expect(settlementForFailure(new ProviderError(code, "Refused before sending.")).outcome).toBe("refusal");
    }
    for (const code of ["auth", "offline", "rate-limit", "unknown"] as const) {
      expect(settlementForFailure(new ProviderError(code, "May have been sent.")).outcome).toBe("failure");
    }
    expect(settlementForFailure(new DOMException("Aborted", "AbortError")).outcome).toBe("cancellation");
    expect(settlementForFailure(new ProviderError("unknown", "Cancelled.", {
      cause: new DOMException("Aborted", "AbortError"),
    })).outcome).toBe("cancellation");
  });

  test("a dispatched request is never labelled a pre-send refusal", () => {
    expect(settlementForFailure(new ProviderError("invalid-request", "Provider said 400."),
      { dispatched: true })).toEqual({ outcome: "failure", failure: "Provider said 400." });
    expect(settlementForFailure(new ProviderError("not-found", "404."), { dispatched: true }).outcome)
      .toBe("failure");
    // The settlement type composes with the ledger's settle event without a cast.
    const local: TransportEvent = {
      type: "settle", operationId: 1, chunkId: 1,
      outcome: settlementForFailure(new ProviderError("invalid-request", "Local check.")).outcome,
      failure: "Local check."
    };
    expect(local.outcome).toBe("refusal");
  });

  test("keeps the message bounded and never substitutes a zero charge", () => {
    expect(settlementForFailure(new ProviderError("offline", "Connection refused.")))
      .toEqual({ outcome: "failure", failure: "Connection refused." });
    expect(settlementForFailure(new ProviderError("offline", "x".repeat(65_537))).failure)
      .toBe("The external operation failed. Review its host receipt before continuing.");
    expect(settlementForFailure(new ProviderError("offline", "  ")).failure)
      .toBe("The external operation failed. Review its host receipt before continuing.");
  });
});

describe("cancellable service seams", () => {
  test("the deadline stays local and host abort closes it immediately", () => {
    const controller = new AbortController();
    const signal = requestSignal(60_000, controller.signal);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
    expect(requestSignal(60_000).aborted).toBe(false);
  });

  test("VoiceService forwards host cancellation and settles as a cancellation", async () => {
    const fx = voiceFixture({
      fetchImpl: (async () => {
        throw new Error("unused");
      }) as unknown as typeof fetch
    });
    const reservation = fx.host.reserve("stt", 1, 1, { connectionId: "conn_meta0000001", model: META_SPEECH_MODEL });
    if (!reservation) throw new Error("reserve refused");
    const publicId = reservation.publicId;
    let seen: AbortSignal | null = null;
    const abortingFetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen = init?.signal ?? null;
      fx.host.cancel(1, publicId);
      throw new DOMException("Aborted", "AbortError");
    }) as unknown as typeof fetch;
    const begun = await fx.host.begin(reservation);
    if (!begun.ok) throw new Error("begin refused");
    const service = new VoiceService(fx.providers, abortingFetch);
    const outcome = await service.transcribe({ audio: wav() }, begun.scope);
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    expect(outcome.status).toBe("cancellation");
    expect(outcome.receipt?.status).toBe("cancellation");
    expect(outcome.receipt?.dispatchedChunks).toBe(1);
    expect(outcome.receipt?.charge).toEqual({ state: "unknown" });
  });

  test("SpeechService stops before the next chunk after an author stop", async () => {
    let calls = 0;
    let reservationId = -1;
    const holder: { current: ReturnType<typeof hostFor> | null } = { current: null };
    const fetchImpl = (async () => {
      calls += 1;
      // The first chunk is dispatched; the author stops before the second is sent.
      if (calls === 1 && holder.current) holder.current.host.cancel(1, reservationId);
      return new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    const fx = hostFor(TTS_PROVIDERS, TTS_PREFERENCES);
    holder.current = fx;
    const reservation = fx.host.reserve("tts", 2, 1);
    reservationId = reservation?.publicId ?? -1;
    if (!reservation) throw new Error("reserve refused");
    const begun = await fx.host.begin(reservation);
    if (!begun.ok) throw new Error("begin refused");
    const speech = new SpeechService(TTS_PROVIDERS, fetchImpl);
    const outcome = await speech.speak({ text: "One. ".repeat(900) }, begun.scope);
    expect(calls).toBe(1);
    expect(outcome.status).toBe("cancellation");
    expect(outcome.receipt?.status).toBe("cancellation");
    // The first chunk settled (success) before the stop took effect; the second never went out.
    expect(outcome.receipt?.settledChunks).toBe(1);
    expect(outcome.receipt?.unsentChunks).toBe(1);
  });

  test("a deadline, not a host stop, settles as a failure with unknown charge", () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    expect(settlementForFailure(timeout)).toEqual({
      outcome: "failure",
      failure: "The request timed out. It may have reached the provider; the cost is unknown."
    });
  });

  test("a local host abort still settles as cancellation, not as a timeout", () => {
    expect(settlementForFailure(new DOMException("Aborted", "AbortError")).outcome).toBe("cancellation");
  });
});

test("a custom abort reason still settles as cancellation", () => {
  // The services wrap any host abort with an explicit AbortError marker, because the host reason
  // may be an arbitrary string or Error.
  const wrapped = new ProviderError("unknown", "The speaking request was cancelled.", {
    cause: new DOMException("Aborted", "AbortError")
  });
  expect(settlementForFailure(wrapped).outcome).toBe("cancellation");
});

describe("aborts that land while the body is read", () => {
  test("VoiceService treats a stop after headers as a cancellation", async () => {
    let publicId = -1;
    const fx = voiceFixture({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "",
        json: async () => {
          fx.host.cancel(1, publicId);
          throw new DOMException("Aborted", "AbortError");
        }
      })) as unknown as typeof fetch
    });
    const reservation = fx.host.reserve("stt", 1, 1, { connectionId: "conn_meta0000001", model: META_SPEECH_MODEL });
    if (!reservation) throw new Error("reserve refused");
    publicId = reservation.publicId;
    const begun = await fx.host.begin(reservation);
    if (!begun.ok) throw new Error("begin refused");
    const service = new VoiceService(fx.providers, fx.fetchImpl);
    const outcome = await service.transcribe({ audio: wav() }, begun.scope);
    expect(outcome.status).toBe("cancellation");
    expect(outcome.receipt?.status).toBe("cancellation");
  });

  test("SpeechService treats a stop after headers as a cancellation", async () => {
    let publicId = -1;
    const fx = hostFor(TTS_PROVIDERS, TTS_PREFERENCES);
    const abortingFetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/mpeg" }),
      text: async () => "",
      arrayBuffer: async () => {
        fx.host.cancel(1, publicId);
        throw new DOMException("Aborted", "AbortError");
      }
    })) as unknown as typeof fetch;
    const reservation = fx.host.reserve("tts", 1, 1);
    if (!reservation) throw new Error("reserve refused");
    publicId = reservation.publicId;
    const begun = await fx.host.begin(reservation);
    if (!begun.ok) throw new Error("begin refused");
    const service = new SpeechService(TTS_PROVIDERS, abortingFetch);
    const outcome = await service.speak({ text: "One sentence." }, begun.scope);
    expect(outcome.status).toBe("cancellation");
    expect(outcome.receipt?.status).toBe("cancellation");
  });
});
