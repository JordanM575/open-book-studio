import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { IPC, type Result, type StudioApi, type VoiceCancelReceipt } from "@ai-book-studio/core/ipc";
import { VoiceCancelRegistry } from "../src/main/voice-cancel-registry";
import { VoiceService } from "../src/main/voice";
import { SpeechService } from "../src/main/speech";
import { voiceFixture } from "./support/voice-request-host";
import { mockElectron } from "./support/mock-electron";
import type { TransportFacts } from "../../../packages/core/src/voice-session";

/*
 * The voice IPC surface. Zod runs before any host is touched. The owner check runs before a
 * single route is resolved: a caller that is not the current studio window's top frame gets a
 * refusal with no operation id, and a cancel or read from another window is an honest no-op.
 * No microphone, audio device, live provider, credential or network call exists here.
 */

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
let registerIpc!: typeof import("../src/main/ipc").registerIpc;
let exposed: StudioApi | null = null;

const OWNER_WINDOW_ID = 7;
const mainFrame = { syntheticFrame: "main" };

function syntheticWindow(windowId = OWNER_WINDOW_ID) {
  return {
    webContents: {
      id: windowId,
      mainFrame,
      send: () => {}
    }
  };
}
function ownerEvent() {
  return { sender: { id: OWNER_WINDOW_ID }, senderFrame: mainFrame };
}

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
      return handler(ownerEvent(), args[0]) as Promise<never>;
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

interface Registered {
  voiceRequests?: ReturnType<typeof voiceFixture>["host"] | null;
  registry?: VoiceCancelRegistry | null;
  window?: ReturnType<typeof syntheticWindow> | null;
}

function register({ voiceRequests = null, registry = null, window = syntheticWindow() }: Registered = {}) {
  handlers.clear();
  registerIpc(
    { requireLibrary: () => { throw new Error("No library is open."); } } as never,
    () => window as never,
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
    registry,
    undefined,
    voiceRequests ?? null
  );
}

function registerLive() {
  handlers.clear();
  const fetchImpl = (async () =>
    Response.json({ transcript: "hello from the synthetic provider", turns: [], audioDurationMs: 900 })) as unknown as typeof fetch;
  const fx = voiceFixture({ fetchImpl });
  const voice = new VoiceService(fx.providers, fx.fetchImpl);
  const speech = new SpeechService(fx.providers, fx.fetchImpl);
  registerIpc(
    { requireLibrary: () => { throw new Error("No library is open."); } } as never,
    () => syntheticWindow() as never,
    fx.providers as never,
    {} as never,
    voice,
    {} as never,
    {} as never,
    {} as never,
    speech,
    () => null,
    { status: null, start: async () => undefined, stop: async () => undefined } as never,
    () => false,
    () => null,
    fx.registry,
    undefined,
    fx.host
  );
  return fx;
}

function api(): StudioApi["voice"] {
  if (!exposed?.voice.cancel) throw new Error("Preload did not expose voice.cancel");
  return exposed.voice;
}

async function cancel(payload: unknown): Promise<Result<VoiceCancelReceipt>> {
  return api().cancel(payload as { operationId: number; reason?: string });
}

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

describe("voice cancel IPC", () => {
  test("a null registry is an honest no-op and the preload exposes cancel", async () => {
    register({ voiceRequests: null, registry: null });
    const result = await cancel({ operationId: 1 });
    expect(result).toEqual({
      ok: true,
      data: { operationId: 1, accepted: false, abortedLocally: false, released: false }
    });
    expect(handlers.has(IPC.voice.cancel)).toBe(true);
    expect(handlers.has(IPC.voice.transcribe)).toBe(true);
    expect(handlers.has(IPC.voice.speak)).toBe(true);
    expect(handlers.has(IPC.voice.operation)).toBe(true);
    expect(typeof api().operation).toBe("function");
    expect(typeof api().onOperation).toBe("function");
    const unsubscribe = api().onOperation(() => {});
    expect(typeof unsubscribe).toBe("function");
  });

  test("an invalid payload is refused before the registry is touched", async () => {
    let calls = 0;
    const host = new VoiceCancelRegistry();
    const original = host.cancel.bind(host);
    host.cancel = (...args) => {
      calls += 1;
      return original(...args);
    };
    register({ registry: host });
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

  test("voice.operation rejects a malformed id before the host is touched", async () => {
    register({});
    for (const payload of [{}, { operationId: 0 }, { operationId: 1.5 }, { operationId: "1" }, { operationId: 1, extra: true }]) {
      const result = await api().operation(payload as { operationId: number });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid");
    }
  });

  test("cancel before dispatch, the active request, a duplicate, and a late receipt", async () => {
    const host = new VoiceCancelRegistry();
    register({ registry: host });
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

  test("a mismatched sender is refused before minting; the studio window still mints", async () => {
    const fx = registerLive();
    // A sender from another window is not allowed to reach the provider path.
    const foreign = await api().transcribe({
      audio: wav().buffer.slice(0) as ArrayBuffer,
      expectedSelection: { connectionId: "conn_meta0000001", model: "muse-voice-transcribe-1.0" }
    });
    // The default fixture sender IS the owner (ownerEvent), so this succeeds; flip the window to
    // prove the refusal path with a fresh registration.
    expect(foreign.ok).toBe(true);
    if (foreign.ok) {
      expect(foreign.data.status).toBe("success");
    }

    // Now the window changes under the same sender: the call must refuse before minting.
    handlers.clear();
    registerIpc(
      { requireLibrary: () => { throw new Error("No library is open."); } } as never,
      () => syntheticWindow(999) as never, // a different window is current
      fx.providers as never,
      {} as never,
      new VoiceService(fx.providers, fx.fetchImpl),
      {} as never,
      {} as never,
      {} as never,
      new SpeechService(fx.providers, fx.fetchImpl),
      () => null,
      { status: null, start: async () => undefined, stop: async () => undefined } as never,
      () => false,
      () => null,
      fx.registry,
      undefined,
      fx.host
    );
    const refused = await api().transcribe({
      audio: wav().buffer.slice(0) as ArrayBuffer,
      expectedSelection: { connectionId: "conn_meta0000001", model: "muse-voice-transcribe-1.0" }
    });
    expect(refused.ok).toBe(true);
    if (refused.ok) {
      expect(refused.data.status).toBe("refusal");
      if (refused.data.status === "refusal") {
        expect(refused.data.message).toContain("not come from the studio window");
        expect(refused.data.receipt).toBeNull();
      }
    }
  });

  test("a subframe sender is refused even from the right window", async () => {
    register({ voiceRequests: voiceFixture({ fetchImpl: (async () => Response.json({ transcript: "hi", turns: [] })) as unknown as typeof fetch }).host });
    const subframe = { syntheticFrame: "child" };
    const handler = handlers.get(IPC.voice.transcribe);
    if (!handler) throw new Error("transcribe handler missing");
    const result = (await handler(
      { sender: { id: OWNER_WINDOW_ID }, senderFrame: subframe },
      { audio: wav().buffer.slice(0), expectedSelection: { connectionId: "conn_test0001", model: "muse-voice-transcribe-1.0" } }
    )) as Result<{ status: string }>;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("refusal");
  });

  test("voice.operation returns the owner's view and null across windows", async () => {
    registerLive();
    const result = await api().transcribe({
      audio: wav().buffer.slice(0) as ArrayBuffer,
      expectedSelection: { connectionId: "conn_meta0000001", model: "muse-voice-transcribe-1.0" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "success") throw new Error("expected success");
    const operationId = result.data.receipt.operationId;

    const own = await api().operation({ operationId });
    expect(own.ok).toBe(true);
    if (own.ok) {
      expect(own.data?.operationId).toBe(operationId);
      expect(own.data?.phase).toBe("settled");
      expect(own.data?.status).toBe("success");
    }

    const unknown = await api().operation({ operationId: operationId + 1000 });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.data).toBeNull();

    // A window that is not the owner cannot read the view: a sender claiming to be
    // another id gets the same honest null, never the receipt.
    const foreign = (await handlers.get(IPC.voice.operation)!(
      { sender: { id: 999 }, senderFrame: mainFrame },
      { operationId }
    )) as Result<unknown>;
    expect(foreign.ok).toBe(true);
    if (foreign.ok) expect(foreign.data).toBeNull();
  });

  test("the emitted operation events tell one story, starting to settled", async () => {
    const fx = registerLive();
    const result = await api().transcribe({
      audio: wav().buffer.slice(0) as ArrayBuffer,
      expectedSelection: { connectionId: "conn_meta0000001", model: "muse-voice-transcribe-1.0" }
    });
    expect(result.ok).toBe(true);
    const events = fx.events;
    expect(events.length).toBeGreaterThanOrEqual(2);
    const phases = events.map((view) => view.phase);
    expect(phases[0]).toBe("starting");
    expect(phases.at(-1)).toBe("settled");
    for (const view of events) {
      expect(view.viewRevision).toBeGreaterThan(0);
      expect(["stt", "tts"]).toContain(view.kind);
      expect(view.operationId).toBeGreaterThan(0);
    }
    const revisions = events.map((view) => view.viewRevision);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
    expect(events.at(-1)?.status).toBe("success");
  });
});
