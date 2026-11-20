import { describe, expect, test } from "bun:test";
import {
  createReaderReviewApi, readerReviewChannel, readerReviewHandler, readerReviewRequestSchema, unsupportedReaderReviewApi,
  UNSUPPORTED_READER_REVIEW_COPY, type ReaderReviewService
} from "../../src/review/reader-api";

function fakeService(overrides: Partial<ReaderReviewService> = {}): ReaderReviewService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    support: async () => { calls.push("support"); return { supported: true, reason: null }; },
    prepare: async () => { calls.push("prepare"); return { kind: "blocked", reason: "unavailable" }; },
    start: async () => { calls.push("start"); return { kind: "blocked", reason: "changed" }; },
    stop: async () => { calls.push("stop"); return "not-started"; },
    cancelPrepare: async () => { calls.push("cancelPrepare"); return "cancelled"; },
    ...overrides
  };
}

const prepare = {
  operation: "prepare", prepareId: "prepare-1", bookId: "book_123456", profileId: "reader-alpha",
  chapters: [{ chapterId: "ch_123456", ranges: [{ start: 0, end: 4 }] }], prompt: "A synthetic request."
};

describe("bounded readerReview:request wire surface", () => {
  test("one channel name and strict request shapes refuse extra fields and malformed values", () => {
    expect(readerReviewChannel).toBe("readerReview:request");
    for (const payload of [
      { ...prepare, path: "/tmp/outside" },
      { ...prepare, profileId: "reader-gamma" },
      { ...prepare, prepareId: "bad/id" },
      { ...prepare, chapters: [] },
      { ...prepare, chapters: [{ chapterId: "ch_123456", ranges: [{ start: 0.5, end: 4 }] }] },
      { ...prepare, prompt: "\ud800" },
      { operation: "start", requestId: "request-1", scopeDigest: "a".repeat(64), extra: true },
      { operation: "support", extra: true },
      { operation: "unknown" }
    ]) expect(readerReviewRequestSchema.safeParse(payload).success).toBe(false);
    expect(readerReviewRequestSchema.safeParse(prepare).success).toBe(true);
    expect(readerReviewRequestSchema.safeParse({ operation: "start", requestId: "request-1", scopeDigest: "a".repeat(64) }).success).toBe(true);
  });

  test("the handler validates before dispatch and returns the Result envelope", async () => {
    const service = fakeService();
    const handle = readerReviewHandler(service);
    expect(await handle({ operation: "support" })).toEqual({ ok: true, data: { supported: true, reason: null } });
    expect(await handle({ ...prepare })).toEqual({ ok: true, data: { kind: "blocked", reason: "unavailable" } });
    expect(await handle({ operation: "stop", requestId: "request-1" })).toEqual({ ok: true, data: "not-started" });
    expect(await handle({ operation: "cancelPrepare", prepareId: "prepare-1" })).toEqual({ ok: true, data: "cancelled" });
    expect(service.calls).toEqual(["support", "prepare", "stop", "cancelPrepare"]);

    const refused = await handle({ ...prepare, secret: "PRIVATE_SENTINEL" });
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(JSON.stringify(refused)).not.toContain("PRIVATE_SENTINEL");
    expect(service.calls).toHaveLength(4);
  });

  test("service failures are redacted at the boundary", async () => {
    const service = fakeService({
      prepare: async () => { throw new Error("Provider key sk-or-v1-PRIVATEKEYMATERIAL failed"); }
    });
    const result = await readerReviewHandler(service)({ ...prepare });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("internal");
    expect(result.error.message).toContain("sk-or-[redacted]");
    expect(result.error.message).not.toContain("PRIVATEKEYMATERIAL");
  });

  test("the preload client parses its own payload and forwards the exact request", async () => {
    const seen: unknown[] = [];
    const api = createReaderReviewApi(async (payload) => {
      seen.push(payload);
      return { ok: true, data: { supported: true, reason: null } };
    });
    expect(await api.support()).toEqual({ ok: true, data: { supported: true, reason: null } });
    expect(seen).toEqual([{ operation: "support" }]);
    const invalid = await api.prepare({ ...prepare, path: "/tmp/outside" } as never);
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(seen).toHaveLength(1);
    await api.stop({ requestId: "request-1" });
    expect(seen[1]).toEqual({ operation: "stop", requestId: "request-1" });
  });

  test("the unsupported-host stub refuses support and every operation before any read", async () => {
    const api = unsupportedReaderReviewApi();
    expect(await api.support()).toEqual({ ok: true, data: { supported: false, reason: "unsupported-host" } });
    for (const result of [await api.prepare(prepare as never), await api.start({ requestId: "request-1", scopeDigest: "a".repeat(64) }),
      await api.stop({ requestId: "request-1" }), await api.cancelPrepare({ prepareId: "prepare-1" })]) {
      expect(result).toMatchObject({ ok: false, error: { code: "unsupported", message: UNSUPPORTED_READER_REVIEW_COPY } });
    }
  });
});
