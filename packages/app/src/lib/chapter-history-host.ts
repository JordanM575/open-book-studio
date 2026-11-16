import type { ChapterHistoryApi, ChapterHistoryTarget } from "../components/chapter-history/types";
import { must } from "./utils";

/**
 * The history methods this writing screen may call. Restore, undo, reconcile, and delete
 * are not on it. Absent when the host does not expose saved chapter history.
 */
export type ChapterHistoryClient = NonNullable<Window["studio"]["history"]>;

export interface ChapterHistoryVisit {
  /** Changes for a new library, book, selected chapter, or reload, including a return to the same chapter. */
  readonly viewId: string;
  /** True only while this visit is still the one on screen. */
  current: () => boolean;
}

/**
 * Bind list, read, compare, and capture to one library visit. A call that arrives after
 * the author has moved on is refused before any history request. Each call forwards only
 * the book, chapter, and the operation's own input. It does not save, flush, or export.
 */
export interface BoundChapterHistoryApi extends ChapterHistoryApi {
  /** The visit this adapter serves. Not sent with any history request. */
  readonly viewId: string;
}

export function createChapterHistoryApi(client: ChapterHistoryClient, visit: ChapterHistoryVisit): BoundChapterHistoryApi {
  const accept = (target: ChapterHistoryTarget): void => {
    if (target.viewId !== visit.viewId || !visit.current()) {
      throw new Error("This chapter history belongs to another visit.");
    }
  };

  return {
    viewId: visit.viewId,
    async list(target) {
      accept(target);
      return must(client.list({ bookId: target.bookId, chapterId: target.chapterId }));
    },
    async read(target, input) {
      accept(target);
      return must(client.read({ bookId: target.bookId, chapterId: target.chapterId, fileName: input.fileName }));
    },
    async compare(target, input) {
      accept(target);
      return must(client.compare({ bookId: target.bookId, chapterId: target.chapterId, fileName: input.fileName }));
    },
    async capture(target, input) {
      accept(target);
      return must(client.capture({
        bookId: target.bookId,
        chapterId: target.chapterId,
        label: input.label,
        source: input.source
      }));
    }
  };
}
