import type { ManuscriptExportCancelResult } from "@ai-book-studio/core/ipc";

/**
 * Main-process cancellation registry for single-file manuscript exports (spec 035 T016).
 *
 * Pure host state: no Electron, Library, path or persistence import. An attempt id is a
 * cancellation key only; it grants no filesystem authority and is never used as a path.
 */

export type ExportTarget = "docx" | "pdf" | "epub" | "markdown";
export type ExportCancelStatus = ManuscriptExportCancelResult["status"];

export interface ExportAttemptBegin {
  ok: true;
  signal: AbortSignal;
  /** Called once, immediately before the rename that would publish the file. */
  onPublishStart: () => void;
}

export type ExportAttemptRefusal = { ok: false; reason: "duplicate" | "busy" };

interface ActiveAttempt {
  bookId: string;
  target: ExportTarget;
  controller: AbortController;
  phase: "running" | "committing";
}

/** One active attempt per book and target, and one entry per attempt id. Holds no content. */
export class ExportAttemptRegistry {
  private attempts = new Map<string, ActiveAttempt>();
  private active = new Map<string, string>();

  private key(bookId: string, target: ExportTarget): string {
    return `${bookId}\u0000${target}`;
  }

  begin(bookId: string, target: ExportTarget, attemptId: string): ExportAttemptBegin | ExportAttemptRefusal {
    if (this.attempts.has(attemptId)) return { ok: false, reason: "duplicate" };
    const key = this.key(bookId, target);
    if (this.active.has(key)) return { ok: false, reason: "busy" };
    const attempt: ActiveAttempt = {
      bookId,
      target,
      controller: new AbortController(),
      phase: "running"
    };
    this.attempts.set(attemptId, attempt);
    this.active.set(key, attemptId);
    return {
      ok: true,
      signal: attempt.controller.signal,
      onPublishStart: () => {
        if (this.attempts.get(attemptId) === attempt) attempt.phase = "committing";
      }
    };
  }

  cancel(bookId: string, attemptId: string): ManuscriptExportCancelResult {
    const attempt = this.attempts.get(attemptId);
    // An unknown id, another book's id or a settled attempt never reveals or aborts anything.
    if (!attempt || attempt.bookId !== bookId) return { status: "already-settled", attemptId };
    if (attempt.phase === "committing") return { status: "too-late", attemptId };
    attempt.controller.abort();
    return { status: "accepted", attemptId };
  }

  settle(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return;
    this.attempts.delete(attemptId);
    const key = this.key(attempt.bookId, attempt.target);
    if (this.active.get(key) === attemptId) this.active.delete(key);
  }
}
