import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { IPC, type Result, type StudioApi, type VoiceCancelReceipt } from "@ai-book-studio/core/ipc";
import { VoiceCancelRegistry } from "../src/main/voice-cancel-registry";
import { mockElectron } from "./support/mock-electron";
import type { TransportFacts } from "../../../packages/core/src/voice-session";

/*
 * The cancel channel through the preload bridge. Zod runs before the registry.
 * An unknown or already-cancelled id, including a null registry, is an honest no-op.
 * No microphone, audio device, live provider, credential or network call.
 */

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
let registerIpc!: typeof import("../src/main/ipc").registerIpc;
let exposed: StudioApi | null = null;

const facts: TransportFacts = {
  now: 1,
  session: { sessionId: "session-1", generation: 1 },
  route: {
    connectionId: "conn_synthetic",
    provider: "synthetic",
    model: "model",
    destination: "local",
    voice: null,
    revision: 1
  },
  permitted: true
};

beforeAll(async () => {
  mockElectron(tmpdir(), {
    handle: (channel, handler) => { handlers.set(channel, handler); },
    exposeInMainWorld: (_name, api) => { exposed = api as StudioApi; },
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) return Promise.reject(new Error(`No handler for ${channel}`));
      return handler({}, args[0]) as Promise<never>;
    }
  });
  ({ registerIpc } = await import("../src/main/ipc"));
  // The preload module is cached process-wide and may already have been
  // evaluated under another file's hooks; the query re-evaluates it under
  // this file's hooks so the exposed bridge is the one captured here.
  const preloadEntry: string = "../src/preload/index.ts?voice-cancel";
  await import(preloadEntry);
});

afterAll(() => { mockElectron(tmpdir()); });

function register(voiceCancelRegistry: VoiceCancelRegistry | null = null) {
  handlers.clear();
  registerIpc(
    { requireLibrary: () => { throw new Error("No library is open."); } } as never,
    () => null,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    () => null,
    { status: null, start: async () => undefined, stop: async () => undefined } as never,
    () => false,
    () => null,
    voiceCancelRegistry
  );
}

function api(): StudioApi["voice"] {
  if (!exposed?.voice.cancel) throw new Error("Preload did not expose voice.cancel");
  return exposed.voice;
}

async function cancel(payload: unknown): Promise<Result<VoiceCancelReceipt>> {
  return api().cancel(payload as { operationId: number; reason?: string });
}

describe("voice cancel IPC", () => {
  test("a null registry is an honest no-op and the preload exposes cancel", async () => {
    register(null);
    const result = await cancel({ operationId: 1 });
    expect(result).toEqual({
      ok: true,
      data: { operationId: 1, accepted: false, abortedLocally: false, released: false }
    });
    expect(handlers.has(IPC.voice.cancel)).toBe(true);
    expect(handlers.has(IPC.voice.transcribe)).toBe(true);
    expect(handlers.has(IPC.voice.speak)).toBe(true);
  });

  test("an invalid payload is refused before the registry is touched", async () => {
    let calls = 0;
    const host = new VoiceCancelRegistry();
    const original = host.cancel.bind(host);
    host.cancel = (...args) => {
      calls += 1;
      return original(...args);
    };
    register(host);
    const tooLong = "x".repeat(2049);
    const rejected = [
      {},
      { operationId: "1" },
      { operationId: 0 },
      { operationId: -1 },
      { operationId: 1.5 },
      { operationId: Number.MAX_SAFE_INTEGER + 1 },
      { operationId: true },
      { operationId: 1, reason: "" },
      { operationId: 1, reason: tooLong },
      { operationId: 1, reason: 1 },
      { operationId: 1, extra: true }
    ];
    for (const payload of rejected) {
      const result = await cancel(payload);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("invalid");
    }
    expect(calls).toBe(0);
    const accepted = await cancel({ operationId: Number.MAX_SAFE_INTEGER, reason: "x".repeat(2048) });
    expect(accepted).toEqual({
      ok: true,
      data: {
        operationId: Number.MAX_SAFE_INTEGER,
        accepted: false,
        abortedLocally: false,
        released: false
      }
    });
    expect(calls).toBe(1);
  });

  test("cancel before dispatch, the active request, a duplicate, and a late receipt", async () => {
    const host = new VoiceCancelRegistry();
    register(host);
    const before = host.begin("stt", 1, facts);
    if (before === null) throw new Error("begin refused");
    const queued = host.queue(before);
    if (queued === null) throw new Error("queue refused");

    const released = await cancel({ operationId: before, reason: "Stop before send." });
    expect(released).toEqual({
      ok: true,
      data: { operationId: before, accepted: true, abortedLocally: false, released: true }
    });
    expect(host.accounting().slots.stt).toBeNull();
    expect(host.accounting().receipts.at(-1)?.outcome).toBe("cancellation");
    expect(host.accounting().receipts.at(-1)?.operation.chunks[0]?.charge).toEqual({ state: "unsent" });

    const active = host.begin("tts", 1, facts);
    if (active === null) throw new Error("begin refused");
    const chunkId = host.queue(active);
    if (chunkId === null) throw new Error("queue refused");
    const sent = host.dispatch(active, chunkId, facts);
    expect(sent.sent).toBe(true);

    const aborted = await cancel({ operationId: active });
    expect(aborted).toEqual({
      ok: true,
      data: { operationId: active, accepted: true, abortedLocally: true, released: false }
    });
    expect(sent.signal?.aborted).toBe(true);
    expect(host.accounting().slots.tts?.chunks[0]?.charge).toEqual({ state: "unknown" });

    const duplicate = await cancel({ operationId: active, reason: "Again." });
    expect(duplicate).toEqual({
      ok: true,
      data: { operationId: active, accepted: false, abortedLocally: false, released: false }
    });
    expect(host.accounting().slots.tts?.operationId).toBe(active);
    expect(host.accounting().slots.tts?.chunks[0]?.charge).toEqual({ state: "unknown" });

    const unknown = await cancel({ operationId: 99 });
    expect(unknown.ok && unknown.data.accepted).toBe(false);

    const newer = host.begin("stt", 1, facts);
    if (newer === null) throw new Error("begin refused");
    host.settle(active, chunkId, { outcome: "success" });
    expect(host.accounting().receipts.find((entry) => entry.operation.operationId === active)?.outcome).toBe("cancellation");
    expect(host.accounting().slots.tts).toBeNull();
    expect(host.accounting().slots.stt?.operationId).toBe(newer);

    host.settle(active, chunkId, { outcome: "failure", failure: "late" });
    expect(host.accounting().slots.stt?.operationId).toBe(newer);
  });
});
