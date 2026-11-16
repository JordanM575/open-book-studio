import { DRAFT_FLUSH_CHANNEL, type DraftFlushRequest, type DraftInput } from "@ai-book-studio/core/ipc";
import type { SaveChapterResult } from "@ai-book-studio/core/schema";
import type { Library } from "./library/store";
import { normalizeBody } from "@ai-book-studio/core/markdown";

/** How long a close or quit waits for the window's newest text before it saves the drafts it holds. */
export const FLUSH_REQUEST_TIMEOUT_MS = 1500;

/** The part of a window's web contents a flush request needs. */
export interface FlushTarget {
  isDestroyed(): boolean;
  isCrashed(): boolean;
  send(channel: string, request: DraftFlushRequest): void;
}

/** A draft a flush could not save, and the reason the library gave. The buffer still holds it. */
export interface FlushFailure {
  draft: DraftInput;
  reason: string;
}

/**
 * Keeps the newest text of an open chapter in memory so closing the window, quitting, or a crash
 * in the renderer cannot lose the last few seconds of typing. The renderer still saves on its own;
 * this is the safety net, and it is flushed before the app exits.
 *
 * The editor sends a draft only after a 300 ms pause, so the buffer alone trails the last keystrokes.
 * Before a close or quit the window is asked for its newest text first (`requestNewest`); the drafts
 * already held are the fallback when it does not answer. A draft the library refuses is handed back
 * rather than dropped, and the studio keeps it in its profile for recovery (`recovery.ts`).
 */
export class DraftBuffer {
  private readonly drafts = new Map<string, DraftInput>();
  private readonly requests = new Map<string, () => void>();
  private nextRequest = 0;

  private key(bookId: string, chapterId: string): string {
    return `${bookId}:${chapterId}`;
  }

  set(input: DraftInput): void {
    this.drafts.set(this.key(input.bookId, input.chapterId), { ...input });
  }

  clear(bookId: string, chapterId: string): void {
    this.drafts.delete(this.key(bookId, chapterId));
  }

  /**
   * Let go of a draft that is kept for recovery once the author has chosen to close or quit, so the
   * next flush has nothing left to ask about. A newer draft for the same chapter stays.
   */
  release(draft: DraftInput): void {
    const key = this.key(draft.bookId, draft.chapterId);
    const held = this.drafts.get(key);
    if (held && held.content === draft.content && held.baseHash === draft.baseHash) this.drafts.delete(key);
  }

  get size(): number {
    return this.drafts.size;
  }

  /** Chapter ids with unsaved text, for the drift detector's `both-changed` check. */
  dirtyChapterIds(): string[] {
    const ids: string[] = [];
    for (const draft of this.drafts.values()) ids.push(draft.chapterId);
    return ids;
  }

  /** Whether this chapter's newest unsaved text is still held. Chapter ids alone are not enough. */
  holds(bookId: string, chapterId: string): boolean {
    return this.drafts.has(this.key(bookId, chapterId));
  }

  /**
   * Save one chapter's draft through the normal checked path. Returns the save outcome so the
   * drift dialog can report a conflict instead of assuming the write landed. The draft clears
   * either way: a conflict preserves the text as a conflict copy and the renderer still holds it.
   */
  async flushOne(
    library: Library,
    bookId: string,
    chapterId: string
  ): Promise<SaveChapterResult | null> {
    const draft = this.drafts.get(this.key(bookId, chapterId));
    if (!draft) return null;
    const disk = await library.readChapter(draft.bookId, draft.chapterId);
    if (disk.content === normalizeBody(draft.content)) {
      this.drafts.delete(this.key(bookId, chapterId));
      return {
        status: "saved",
        chapter: disk
      };
    }
    const result = await library.saveChapter(draft.bookId, draft.chapterId, draft.content, {
      baseVersion: draft.baseVersion,
      baseHash: draft.baseHash
    });
    this.drafts.delete(this.key(bookId, chapterId));
    return result;
  }

  /**
   * Ask the window to save its newest text, and wait until it answers or `timeoutMs` passes. A window
   * that is gone or crashed is not asked.
   */
  requestNewest(target: FlushTarget | null, timeoutMs = FLUSH_REQUEST_TIMEOUT_MS): Promise<"answered" | "timed-out" | "no-window"> {
    if (!target || target.isDestroyed() || target.isCrashed()) return Promise.resolve("no-window");
    this.nextRequest += 1;
    const requestId = `flush-${this.nextRequest}`;
    return new Promise((resolve) => {
      const settle = (outcome: "answered" | "timed-out" | "no-window"): void => {
        clearTimeout(timer);
        this.requests.delete(requestId);
        resolve(outcome);
      };
      const timer = setTimeout(() => settle("timed-out"), timeoutMs);
      this.requests.set(requestId, () => settle("answered"));
      try {
        target.send(DRAFT_FLUSH_CHANNEL, { requestId });
      } catch {
        settle("no-window");
      }
    });
  }

  /** The window answered a flush request: its newest text is saved, or held here. */
  answered(requestId: string): void {
    this.requests.get(requestId)?.();
  }

  /**
   * Before a close or quit: ask the window for its newest text, then save every draft held. Returns
   * the drafts that could not be saved, which the buffer still holds.
   */
  async flushBeforeExit(
    library: Library,
    target: FlushTarget | null,
    timeoutMs = FLUSH_REQUEST_TIMEOUT_MS
  ): Promise<FlushFailure[]> {
    await this.requestNewest(target, timeoutMs);
    return this.flush(library);
  }

  /**
   * Best effort: a conflict here preserves the draft next to the chapter instead of overwriting it.
   * A draft that cannot be saved is kept in the buffer and returned with the reason, so a close or
   * quit can keep its words for recovery instead of only logging them.
   */
  async flush(library: Library): Promise<FlushFailure[]> {
    const failures: FlushFailure[] = [];
    for (const [key, draft] of [...this.drafts]) {
      try {
        const disk = await library.readChapter(draft.bookId, draft.chapterId);
        if (disk.content === normalizeBody(draft.content)) {
          this.drafts.delete(key);
          continue;
        }
        await library.saveChapter(draft.bookId, draft.chapterId, draft.content, {
          baseVersion: draft.baseVersion,
          baseHash: draft.baseHash
        });
        this.drafts.delete(key);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[drafts] Could not flush ${key}:`, reason);
        failures.push({ draft: { ...draft }, reason });
      }
    }
    return failures;
  }
}
