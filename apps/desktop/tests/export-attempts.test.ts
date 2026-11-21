import { describe, expect, test } from "bun:test";
import { ExportAttemptRegistry } from "../src/main/export-attempts";

/*
 * Spec 035 T016: the main-process single-file attempt registry. Keys only; no filesystem.
 */

const BOOK = "book_attempt01";
const OTHER = "book_attempt02";
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

describe("single-file export attempt registry", () => {
  test("begin returns a signal and settles accepted, too-late and already-settled exactly", () => {
    const registry = new ExportAttemptRegistry();
    const begun = registry.begin(BOOK, "docx", ATTEMPT);
    if (!begun.ok) throw new Error("expected begin to succeed");
    expect(begun.signal.aborted).toBe(false);
    expect(registry.cancel(BOOK, ATTEMPT)).toEqual({ status: "accepted", attemptId: ATTEMPT });
    expect(begun.signal.aborted).toBe(true);
    // A second cancel while the export is still settling is idempotent.
    expect(registry.cancel(BOOK, ATTEMPT)).toEqual({ status: "accepted", attemptId: ATTEMPT });
    begun.onPublishStart();
    expect(registry.cancel(BOOK, ATTEMPT)).toEqual({ status: "too-late", attemptId: ATTEMPT });
    registry.settle(ATTEMPT);
    expect(registry.cancel(BOOK, ATTEMPT)).toEqual({ status: "already-settled", attemptId: ATTEMPT });
  });

  test("a duplicate attempt id is refused", () => {
    const registry = new ExportAttemptRegistry();
    expect(registry.begin(BOOK, "docx", ATTEMPT).ok).toBe(true);
    expect(registry.begin(BOOK, "markdown", ATTEMPT)).toEqual({ ok: false, reason: "duplicate" });
    registry.settle(ATTEMPT);
  });

  test("one active attempt per book and target, while another target is allowed", () => {
    const registry = new ExportAttemptRegistry();
    expect(registry.begin(BOOK, "docx", ATTEMPT).ok).toBe(true);
    expect(registry.begin(BOOK, "docx", SECOND)).toEqual({ ok: false, reason: "busy" });
    expect(registry.begin(BOOK, "pdf", SECOND).ok).toBe(true);
    registry.settle(ATTEMPT);
    registry.settle(SECOND);
    expect(registry.begin(BOOK, "docx", SECOND).ok).toBe(true);
    registry.settle(SECOND);
  });

  test("a wrong book never aborts or reveals another book's attempt", () => {
    const registry = new ExportAttemptRegistry();
    const begun = registry.begin(BOOK, "epub", ATTEMPT);
    if (!begun.ok) throw new Error("expected begin to succeed");
    expect(registry.cancel(OTHER, ATTEMPT)).toEqual({ status: "already-settled", attemptId: ATTEMPT });
    expect(begun.signal.aborted).toBe(false);
    expect(registry.cancel(BOOK, ATTEMPT)).toEqual({ status: "accepted", attemptId: ATTEMPT });
    registry.settle(ATTEMPT);
  });

  test("settle removes both the attempt and its book-and-target slot", () => {
    const registry = new ExportAttemptRegistry();
    const begun = registry.begin(BOOK, "markdown", ATTEMPT);
    if (!begun.ok) throw new Error("expected begin to succeed");
    registry.settle(ATTEMPT);
    expect(registry.cancel(BOOK, ATTEMPT)).toEqual({ status: "already-settled", attemptId: ATTEMPT });
    expect(registry.begin(BOOK, "markdown", SECOND).ok).toBe(true);
    registry.settle(SECOND);
  });
});
