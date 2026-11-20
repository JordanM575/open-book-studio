import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { IPC, type Result, type StudioApi } from "@ai-book-studio/core/ipc";
import type {
  ReaderReviewPrepareRequest, ReaderReviewService
} from "@ai-book-studio/core/review/reader-api";
import { unsupportedReaderReviewApi } from "@ai-book-studio/core/review/reader-api";
import { mockElectron } from "./support/mock-electron";

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler[]>();
let exposed: StudioApi | null = null;
let registerIpc!: typeof import("../src/main/ipc").registerIpc;
const calls: string[] = [];

const prepareRequest: ReaderReviewPrepareRequest = {
  operation: "prepare", prepareId: "prepare-1", bookId: "book_123456", profileId: "reader-alpha",
  chapters: [{ chapterId: "ch_123456", ranges: [{ start: 0, end: 4 }] }], prompt: "Synthetic request."
};

const { operation: _prepareOperation, ...prepareInput } = prepareRequest;

const fakeService: ReaderReviewService = {
  support: async () => { calls.push("support"); return { supported: true, reason: null }; },
  prepare: async () => { calls.push("prepare"); return { kind: "blocked", reason: "permission" }; },
  start: async () => { calls.push("start"); return { kind: "blocked", reason: "changed" }; },
  stop: async () => { calls.push("stop"); return "not-started"; },
  cancelPrepare: async () => { calls.push("cancelPrepare"); return "cancelled"; }
};

beforeAll(async () => {
  mockElectron(tmpdir(), {
    handle: (channel, handler) => { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
    exposeInMainWorld: (_name, api) => { exposed = api as StudioApi; },
    invoke: (channel, ...args) => {
      const registered = handlers.get(channel)?.at(-1);
      if (!registered) return Promise.reject(new Error(`No handler for ${channel}`));
      return registered({}, args[0]) as Promise<never>;
    }
  });
  ({ registerIpc } = await import("../src/main/ipc"));
  const studio = {
    requireLibrary: () => { throw new Error("No library should be read by this fake service"); }
  };
  registerIpc(
    studio as never, () => null, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, () => null,
    { status: null, start: async () => undefined, stop: async () => undefined } as never,
    () => false, () => null, null, fakeService
  );
  const preloadEntry: string = "../src/preload/index.ts?reader-review-ipc";
  await import(preloadEntry);
});
afterAll(() => { mockElectron(tmpdir()); });

function api() {
  if (!exposed?.readerReview) throw new Error("Preload did not expose the reader-review API");
  return exposed.readerReview;
}
async function call(payload: unknown): Promise<Result<unknown>> {
  const registered = handlers.get(IPC.readerReview.request)?.at(-1);
  if (!registered) throw new Error("No reader-review handler registered");
  return (await registered({}, payload)) as Result<unknown>;
}

describe("registered readerReview:request channel and actual preload", () => {
  test("the channel is registered once and desktop support is true", async () => {
    expect(IPC.readerReview.request).toBe("readerReview:request");
    expect(handlers.get(IPC.readerReview.request)).toHaveLength(1);
    expect(await api().support()).toEqual({ ok: true, data: { supported: true, reason: null } });
  });

  test("the preload bridge delivers prepare, start, stop and cancel through the Result envelope", async () => {
    expect(await api().prepare(prepareInput)).toEqual({ ok: true, data: { kind: "blocked", reason: "permission" } });
    expect(await api().start({ requestId: "request-1", scopeDigest: "a".repeat(64) }))
      .toEqual({ ok: true, data: { kind: "blocked", reason: "changed" } });
    expect(await api().stop({ requestId: "request-1" })).toEqual({ ok: true, data: "not-started" });
    expect(await api().cancelPrepare({ prepareId: "prepare-1" })).toEqual({ ok: true, data: "cancelled" });
  });

  test("invalid payloads are refused before the service and never echo their fields", async () => {
    const before = calls.length;
    for (const payload of [
      null,
      { operation: "prepare" },
      { ...prepareRequest, path: "/tmp/outside" },
      { ...prepareRequest, profileId: "reader-gamma" },
      { ...prepareRequest, chapters: [] },
      { operation: "start", requestId: "request-1", scopeDigest: "short" },
      { operation: "stop", requestId: "../outside" }
    ]) {
      const result = await call(payload);
      expect(result).toMatchObject({ ok: false, error: { code: "invalid" } });
      expect(JSON.stringify(result)).not.toContain("/tmp/outside");
    }
    expect(calls).toHaveLength(before);
  });

  test("service failures are redacted at the IPC boundary", async () => {
    const secret = "sk-or-v1-PRIVATEKEYMATERIALPRIVATEKEYMATERIAL";
    const failing: ReaderReviewService = { ...fakeService,
      prepare: async () => { throw new Error(`Provider key ${secret} failed`); } };
    handlers.get(IPC.readerReview.request)?.pop();
    registerIpc({ requireLibrary: () => { throw new Error("never"); } } as never, () => null,
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, () => null,
      { status: null, start: async () => undefined, stop: async () => undefined } as never,
      () => false, () => null, null, failing);
    const result = await call({ ...prepareRequest });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("internal");
    expect(result.error.message).toContain("sk-or-[redacted]");
    expect(result.error.message).not.toContain("PRIVATEKEYMATERIAL");
  });

  test("the unsupported browser host reports support false and refuses every operation", async () => {
    const browser = unsupportedReaderReviewApi();
    expect(await browser.support()).toEqual({ ok: true, data: { supported: false, reason: "unsupported-host" } });
    expect(await browser.prepare(prepareInput)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await browser.start({ requestId: "request-1", scopeDigest: "a".repeat(64) })).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await browser.stop({ requestId: "request-1" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await browser.cancelPrepare({ prepareId: "prepare-1" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
});
