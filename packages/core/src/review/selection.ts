import { z } from "zod";
import type { BookDetail } from "../schema";
import {
  assertReviewData, bookIdSchema, chapterIdSchema, freeze, requireContract, REVIEW_LIMITS, spanSchema,
  timestampSchema, type Immutable, type Span
} from "./contract";
import { captureChapterSource, type ChapterSource } from "./sources";

/**
 * The renderer's explicit saved-chapter selection. It names no host path, quote, label or source
 * alias: chapter identity and exact half-open UTF-16 ranges are the whole input.
 */
export const readerSelectionRequestSchema = z.strictObject({
  bookId: bookIdSchema,
  chapters: z.array(z.strictObject({
    chapterId: chapterIdSchema,
    ranges: z.array(spanSchema).min(1).max(REVIEW_LIMITS.items * 4)
  })).min(1).max(REVIEW_LIMITS.items)
});
export type ReaderSelectionRequest = Immutable<z.infer<typeof readerSelectionRequestSchema>>;

/** A captured selection. The service assigns `sourceId`; the renderer never chooses one. */
export interface ReaderSelectionChapter {
  readonly chapterId: string;
  readonly sourceId: string;
  readonly ranges: readonly Span[];
}
export interface ReaderSelection {
  readonly bookId: string;
  readonly chapters: readonly ReaderSelectionChapter[];
}
export interface CapturedReaderSelection {
  readonly selection: ReaderSelection;
  readonly sources: readonly ChapterSource[];
}

const capturedAtSchema = timestampSchema;

/**
 * Resolves only the explicitly named saved chapters of one already-read book. It never promotes a
 * chapter read issue, searches by title/path/quote, or bridges an unselected gap. Overlapping and
 * adjacent ranges merge through the existing saved-source capture; a selection that does not resolve
 * to exactly one readable chapter refuses whole.
 */
export function captureReaderSelection(input: {
  selection: unknown;
  book: BookDetail;
  capturedAt: string;
}): CapturedReaderSelection {
  assertReviewData(input);
  const selection = readerSelectionRequestSchema.parse(input.selection);
  const capturedAt = capturedAtSchema.parse(input.capturedAt);
  const book = input.book;
  requireContract(book.book.id === selection.bookId, "selection-book-mismatch");
  requireContract(new Set(selection.chapters.map((chapter) => chapter.chapterId)).size === selection.chapters.length,
    "duplicate-selected-chapter");

  const chapters: ReaderSelectionChapter[] = [];
  const sources: ChapterSource[] = [];
  for (const selected of selection.chapters) {
    const matches = book.chapters.filter((chapter) => chapter.id === selected.chapterId);
    const chapter = matches[0];
    requireContract(matches.length === 1 && chapter, matches.length === 0 ? "missing-selected-chapter" : "ambiguous-selected-chapter");
    const sourceId = `chapter:${chapter.id}`;
    const source = captureChapterSource({
      sourceId,
      saved: { bookId: book.book.id, chapterId: chapter.id, version: chapter.version, hash: chapter.hash, body: chapter.content },
      bookTitle: book.book.title,
      title: chapter.title,
      position: chapter.order,
      capturedAt,
      ranges: selected.ranges
    });
    sources.push(source);
    chapters.push({ chapterId: chapter.id, sourceId, ranges: source.segments.map(({ start, end }) => ({ start, end })) });
  }
  const items = sources.reduce((total, source) => total + source.segments.length, 0);
  requireContract(items <= REVIEW_LIMITS.items, "source-item-limit");
  return freeze({
    selection: { bookId: selection.bookId, chapters },
    sources
  });
}
