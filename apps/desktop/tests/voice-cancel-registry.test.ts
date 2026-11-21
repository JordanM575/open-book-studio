import { afterEach, describe, expect, test } from "bun:test";
import { VoiceCancelRegistry } from "../src/main/voice-cancel-registry";
import type { TransportFacts, TransportKind } from "../../../packages/core/src/voice-session";

/*
 * Synthetic host registry. No microphone, audio device, live provider, credential or network call.
 * The ledger still owns identity, backpressure and the settlement record. This file checks only
 * the local abort the registry executes.
 */

const route = {
  connectionId: "conn_synthetic",
  provider: "synthetic",
  model: "model",
  destination: "local",
  voice: null,
  revision: 1
} as const;

const facts: TransportFacts = {
  now: 1,
  session: { sessionId: "session-1", generation: 1 },
  route,
  permitted: true
};

const OriginalAbortController = globalThis.AbortController;
const abortCalls: unknown[][] = [];

class RecordingAbortController extends OriginalAbortController {
  override abort(...args: unknown[]): void {
    abortCalls.push(args);
    super.abort();
  }
}

afterEach(() => {
  abortCalls.length = 0;
  globalThis.AbortController = OriginalAbortController;
});

function registry(): VoiceCancelRegistry {
  globalThis.AbortController = RecordingAbortController;
  return new VoiceCancelRegistry();
}

function begin(host: VoiceCancelRegistry, kind: TransportKind, planned = 1): number {
  const operationId = host.begin(kind, planned, facts);
  if (operationId === null) throw new Error(`begin refused ${kind}`);
  return operationId;
}

function queue(host: VoiceCancelRegistry, operationId: number): number {
  const chunkId = host.queue(operationId);
  if (chunkId === null) throw new Error(`queue refused ${operationId}`);
  return chunkId;
}

describe("voice cancel registry", () => {
  test("cancel before dispatch releases the slot as unsent and emits no abort", () => {
    const host = registry();
    const operationId = begin(host, "stt");
    queue(host, operationId);

    const receipt = host.cancel(operationId, "Stop before send.");

    expect(receipt).toEqual({
      operationId,
      accepted: true,
      abortedLocally: false,
      released: true
    });
    expect(abortCalls).toEqual([]);
    expect(host.accounting().slots.stt).toBeNull();
    const recorded = host.accounting().receipts.at(-1);
    expect(recorded?.outcome).toBe("cancellation");
    expect(recorded?.unsentChunks).toBe(1);
    expect(recorded?.unknownChunks).toBe(0);
    expect(recorded?.reportedUsd).toBe(0);
    expect(recorded?.operation.chunks[0]?.charge).toEqual({ state: "unsent" });
    expect(recorded?.operation.chunks[0]?.state).toBe("unsent");
  });

  test("cancel of a dispatched request aborts once locally and keeps an unknown charge", () => {
    const host = registry();
    const operationId = begin(host, "tts");
    const chunkId = queue(host, operationId);
    const sent = host.dispatch(operationId, chunkId, facts);
    expect(sent.sent).toBe(true);
    expect(sent.signal).toBeInstanceOf(AbortSignal);
    expect(sent.signal?.aborted).toBe(false);

    const receipt = host.cancel(operationId);

    expect(receipt).toEqual({
      operationId,
      accepted: true,
      abortedLocally: true,
      released: false
    });
    expect(abortCalls).toEqual([[]]);
    expect(sent.signal?.aborted).toBe(true);
    expect(sent.signal?.reason).toBeInstanceOf(DOMException);
    expect((sent.signal?.reason as DOMException).name).toBe("AbortError");
    expect((sent.signal?.reason as DOMException).message).toBe("The operation was aborted.");
    const slot = host.accounting().slots.tts;
    expect(slot?.operationId).toBe(operationId);
    expect(slot?.cancelled).toBe(true);
    expect(slot?.chunks[0]?.state).toBe("dispatched");
    expect(slot?.chunks[0]?.charge).toEqual({ state: "unknown" });
    expect(host.accounting().receipts).toEqual([]);
  });

  test("a second cancel changes nothing", () => {
    const host = registry();
    const operationId = begin(host, "stt");
    const chunkId = queue(host, operationId);
    host.dispatch(operationId, chunkId, facts);
    expect(host.cancel(operationId).accepted).toBe(true);
    const before = structuredClone(host.accounting());

    const again = host.cancel(operationId, "Again.");

    expect(again).toEqual({
      operationId,
      accepted: false,
      abortedLocally: false,
      released: false
    });
    expect(abortCalls).toHaveLength(1);
    expect(host.accounting()).toEqual(before);
  });

  test("a late success or failure is a cancellation and does not release a newer slot", () => {
    const host = registry();
    const spoken = begin(host, "tts");
    const spokenChunk = queue(host, spoken);
    host.dispatch(spoken, spokenChunk, facts);
    expect(host.cancel(spoken).released).toBe(false);

    const heard = begin(host, "stt");
    const heardChunk = queue(host, heard);
    host.dispatch(heard, heardChunk, facts);
    expect(host.accounting().slots.stt?.operationId).toBe(heard);

    host.settle(spoken, spokenChunk, { outcome: "success", costUsd: 1.25 });

    const spokenReceipt = host.accounting().receipts.find((entry) => entry.operation.operationId === spoken);
    expect(spokenReceipt?.outcome).toBe("cancellation");
    expect(spokenReceipt?.finalChunkOutcome).toBe("success");
    expect(spokenReceipt?.unknownChunks).toBe(0);
    expect(spokenReceipt?.reportedUsd).toBe(1.25);
    expect(host.accounting().slots.tts).toBeNull();
    expect(host.accounting().slots.stt?.operationId).toBe(heard);
    expect(host.accounting().slots.stt?.cancelled).toBe(false);

    host.settle(spoken, spokenChunk, { outcome: "failure", failure: "late" });
    expect(host.accounting().slots.stt?.operationId).toBe(heard);
    expect(host.accounting().receipts.filter((entry) => entry.operation.operationId === spoken)).toHaveLength(1);

    expect(host.cancel(heard).released).toBe(false);
    host.settle(heard, heardChunk, { outcome: "failure", failure: "stopped" });
    const heardReceipt = host.accounting().receipts.find((entry) => entry.operation.operationId === heard);
    expect(heardReceipt?.outcome).toBe("cancellation");
    expect(heardReceipt?.finalChunkOutcome).toBe("failure");
    expect(heardReceipt?.unknownChunks).toBe(1);
    expect(heardReceipt?.operation.chunks[0]?.charge).toEqual({ state: "unknown" });

    const newer = begin(host, "stt");
    host.settle(heard, heardChunk, { outcome: "success" });
    expect(host.accounting().slots.stt?.operationId).toBe(newer);
    expect(host.accounting().slots.stt?.cancelled).toBe(false);
  });

  test("an unknown id is an honest no-op", () => {
    const host = registry();
    const operationId = begin(host, "stt");
    const before = structuredClone(host.accounting());

    expect(host.cancel(99)).toEqual({
      operationId: 99,
      accepted: false,
      abortedLocally: false,
      released: false
    });
    expect(abortCalls).toEqual([]);
    expect(host.accounting()).toEqual(before);
    expect(host.accounting().slots.stt?.operationId).toBe(operationId);
  });

  test("a bound public id maps to the internal id and projects a safe view", () => {
    const host = registry();
    const internalId = begin(host, "stt");
    host.bind(4242, internalId, { ownerWindowId: 7, kind: "stt", connectionLabel: "Meta", model: "muse-voice-transcribe-1.0", voice: null });

    const starting = host.view(4242);
    expect(starting).toMatchObject({
      operationId: 4242,
      kind: "stt",
      phase: "starting",
      status: null,
      cancelled: false,
      connectionLabel: "Meta",
      model: "muse-voice-transcribe-1.0",
      voice: null,
      plannedChunks: 1,
      dispatchedChunks: 0,
      settledChunks: 0,
      charge: { state: "pending" }
    });

    const chunkId = queue(host, internalId);
    host.dispatch(internalId, chunkId, facts);
    const inFlight = host.view(4242);
    expect(inFlight?.phase).toBe("in-flight");
    expect(inFlight?.dispatchedChunks).toBe(1);
    expect(inFlight?.charge).toEqual({ state: "pending" });

    host.settle(internalId, chunkId, { outcome: "success", costUsd: 0 });
    const settled = host.view(4242);
    expect(settled).toMatchObject({
      operationId: 4242,
      phase: "settled",
      status: "success",
      charge: { state: "reported", usd: 0 }
    });
    expect(settled?.message).toBeNull();
  });

  test("refuse before dispatch releases the slot and records the refusal, without an abort", () => {
    const host = registry();
    const internalId = begin(host, "tts", 2);
    queue(host, internalId);
    host.bind(4243, internalId, { ownerWindowId: 7, kind: "tts", connectionLabel: "OpenAI", model: "gpt-4o-mini-tts", voice: "nova" });
    host.refuse(internalId, "The route changed.");
    const view = host.view(4243);
    expect(view).toMatchObject({
      phase: "settled",
      status: "refusal",
      plannedChunks: 2,
      settledChunks: 0,
      unsentChunks: 2,
      charge: { state: "none" },
      message: "The route changed."
    });
    expect(abortCalls).toEqual([]);
    expect(host.accounting().slots.tts).toBeNull();
  });

  test("refuse is a no-op once a chunk is dispatched", () => {
    const host = registry();
    const internalId = begin(host, "stt");
    const chunkId = queue(host, internalId);
    host.dispatch(internalId, chunkId, facts);
    host.bind(4244, internalId, { ownerWindowId: 7, kind: "stt", connectionLabel: "Meta", model: "m", voice: null });
    host.refuse(internalId, "Too late.");
    expect(host.accounting().slots.stt?.operationId).toBe(internalId);
    expect(host.view(4244)?.status).toBeNull();
  });

  test("cancelRequest refuses a foreign owner and keeps the binding for the owner", () => {
    const host = registry();
    const internalId = begin(host, "stt");
    queue(host, internalId);
    host.bind(4245, internalId, { ownerWindowId: 7, kind: "stt", connectionLabel: "Meta", model: "m", voice: null });

    const foreign = host.cancelRequest(4245, 8);
    expect(foreign).toEqual({ operationId: 4245, accepted: false, abortedLocally: false, released: false });
    expect(host.accounting().slots.stt?.cancelled).toBe(false);

    const own = host.cancelRequest(4245, 7, "Stop.");
    expect(own).toEqual({ operationId: 4245, accepted: true, abortedLocally: false, released: true });

    // The settled view stays readable by id; the receipt names the public id.
    expect(host.view(4245)?.status).toBe("cancellation");
  });

  test("a late result cannot release a newer slot and the receipt stays cancellation", () => {
    const host = registry();
    const first = begin(host, "stt");
    const firstChunk = queue(host, first);
    host.dispatch(first, firstChunk, facts);
    host.bind(4246, first, { ownerWindowId: 7, kind: "stt", connectionLabel: "Meta", model: "m", voice: null });
    host.cancelRequest(4246, 7, "Stop.");
    // A cancelled STT op keeps its slot until its outcome lands, so a second STT waits;
    // an independent kind may start. Either way the late result must not release the newer slot.
    expect(host.begin("stt", 1, facts)).toBeNull();
    const other = begin(host, "tts");
    host.settle(first, firstChunk, { outcome: "success", costUsd: 0.5 });
    expect(host.accounting().slots.tts?.operationId).toBe(other);
    expect(host.view(4246)?.status).toBe("cancellation");
    expect(host.view(4246)?.charge).toEqual({ state: "reported", usd: 0.5 });
    expect(host.view(4246)?.finalChunkOutcome).toBe("success");
  });

  test("ledger history capacity refuses new operations instead of evicting", () => {
    const host = registry();
    for (let index = 0; index < 255; index += 1) {
      const id = begin(host, "stt", 1);
      const chunkId = host.queue(id);
      if (chunkId === null) throw new Error("queue refused");
      host.dispatch(id, chunkId, facts);
      host.settle(id, chunkId, { outcome: "success", costUsd: 0 });
    }
    expect(host.accounting().receipts).toHaveLength(255);
    // One more slot may begin; the one after is refused and nothing is evicted.
    const last = begin(host, "stt", 1);
    expect(host.begin("stt", 1, facts)).toBeNull();
    expect(host.beginRefusal()).toContain("history is full");
    expect(host.accounting().receipts).toHaveLength(255);
    host.settle(last, 1, { outcome: "success", costUsd: 0 });
  });
});
