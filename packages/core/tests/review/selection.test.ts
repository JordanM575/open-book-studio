import { describe, expect, test } from "bun:test";
import type { BookDetail, BookMeta } from "../../src/schema";
import { captureReaderSelection } from "../../src/review/selection";

const stamp = "2026-11-07T12:00:00Z";
const hash = "a".repeat(64);

function chapter(id: string, content: string, overrides: Partial<BookDetail["chapters"][number]> = {}): BookDetail["chapters"][number] {
  return {
    id, title: `Chapter ${id.slice(-1)}`, order: Number(id.slice(-1)) || 1, arc: "middle", purpose: "", synopsis: "", notes: "",
    isPrologue: false, color: null, version: 3, createdAt: stamp, updatedAt: stamp,
    content, path: `${id}.md`, wordCount: content.trim().split(/\s+/).filter(Boolean).length, hash, ...overrides
  };
}

function detail(chapters: BookDetail["chapters"], issues: BookDetail["chapterReadIssues"] = []): BookDetail {
  return {
    book: { id: "book_123456", title: "Synthetic book" } as BookMeta,
    chapters,
    chapterReadIssues: issues
  };
}

function select(chapters: Array<{ chapterId: string; ranges: Array<{ start: number; end: number }> }>, book = detail([chapter("ch_123456", "ADJACENT_BEFORE\nSelected 😀 exact.\nADJACENT_AFTER")])) {
  return captureReaderSelection({
    selection: { bookId: "book_123456", chapters }, book, capturedAt: stamp
  });
}

describe("explicit saved-chapter selection", () => {
  test("captures the exact saved identity, body length and selected substring only", () => {
    const body = "ADJACENT_BEFORE\nSelected 😀 exact.\nADJACENT_AFTER";
    const result = select([{ chapterId: "ch_123456", ranges: [{ start: body.indexOf("Selected"), end: body.indexOf("\nADJACENT_AFTER") }] }]);
    expect(result.selection).toEqual({
      bookId: "book_123456",
      chapters: [{ chapterId: "ch_123456", sourceId: "chapter:ch_123456", ranges: [{ start: 16, end: 34 }] }]
    });
    const source = result.sources[0];
    expect(source?.kind).toBe("chapter");
    if (source?.kind !== "chapter") throw new Error("Missing chapter source");
    expect(source.sourceId).toBe("chapter:ch_123456");
    expect(source.identity).toEqual({ bookId: "book_123456", chapterId: "ch_123456", version: 3, hash });
    expect(source.bodyLength).toBe(body.length);
    expect(source.segments).toHaveLength(1);
    expect(source.segments[0]?.text).toBe("Selected 😀 exact.");
    expect(JSON.stringify(result)).not.toContain("ADJACENT_BEFORE");
    expect(JSON.stringify(result)).not.toContain("ADJACENT_AFTER");
  });

  test("merges overlapping and adjacent ranges but never bridges a gap", () => {
    const result = select([
      { chapterId: "ch_123456", ranges: [{ start: 0, end: 4 }, { start: 3, end: 7 }, { start: 7, end: 9 }, { start: 12, end: 15 }] }
    ], detail([chapter("ch_123456", "one two three four")]));
    expect(result.selection.chapters[0]?.ranges).toEqual([{ start: 0, end: 9 }, { start: 12, end: 15 }]);
    expect(result.sources[0]?.segments.map((segment) => segment.text)).toEqual(["one two t", "e f"]);
  });

  test("a partial Unicode range stays scalar-safe and exact", () => {
    const body = "A😀B";
    const result = select([{ chapterId: "ch_123456", ranges: [{ start: 1, end: 3 }] }], detail([chapter("ch_123456", body)]));
    expect(result.sources[0]?.segments[0]?.text).toBe("😀");
    expect(() => select([{ chapterId: "ch_123456", ranges: [{ start: 2, end: 3 }] }], detail([chapter("ch_123456", body)])))
      .toThrow("invalid-selected-range");
  });

  test("wrong book, duplicate, missing and unreadable chapters refuse whole", () => {
    const book = detail([chapter("ch_123456", "Saved body")], [{ fileName: "chapter-02.md", order: 2, reason: "unreadable" }]);
    expect(() => captureReaderSelection({ selection: { bookId: "book_654321", chapters: [{ chapterId: "ch_123456", ranges: [{ start: 0, end: 2 }] }] }, book, capturedAt: stamp }))
      .toThrow("selection-book-mismatch");
    expect(() => captureReaderSelection({ selection: { bookId: "book_123456", chapters: [
      { chapterId: "ch_123456", ranges: [{ start: 0, end: 2 }] }, { chapterId: "ch_123456", ranges: [{ start: 2, end: 4 }] }
    ] }, book, capturedAt: stamp })).toThrow("duplicate-selected-chapter");
    expect(() => captureReaderSelection({ selection: { bookId: "book_123456", chapters: [{ chapterId: "ch_654321", ranges: [{ start: 0, end: 2 }] }] }, book, capturedAt: stamp }))
      .toThrow("missing-selected-chapter");
    // The issue names a file, never an id; it is not promoted into a selectable source.
    expect(() => captureReaderSelection({ selection: { bookId: "book_123456", chapters: [{ chapterId: "ch_654321", ranges: [{ start: 0, end: 2 }] }] }, book, capturedAt: stamp }))
      .toThrow("missing-selected-chapter");
    expect(() => captureReaderSelection({ selection: { bookId: "book_123456", chapters: [] }, book, capturedAt: stamp })).toThrow();
  });

  test("invalid ranges, extra fields and a non-UTC capture time refuse", () => {
    const book = detail([chapter("ch_123456", "Saved body")]);
    for (const ranges of [[{ start: -1, end: 2 }], [{ start: 0, end: 0 }], [{ start: 3, end: 2 }], [{ start: 0, end: 200 }], [{ start: 0.5, end: 2 }]]) {
      expect(() => captureReaderSelection({ selection: { bookId: "book_123456", chapters: [{ chapterId: "ch_123456", ranges }] }, book, capturedAt: stamp })).toThrow();
    }
    expect(() => captureReaderSelection({ selection: { bookId: "book_123456", chapters: [{ chapterId: "ch_123456", ranges: [{ start: 0, end: 2 }], path: "/tmp/other" }] }, book, capturedAt: stamp })).toThrow();
    expect(() => captureReaderSelection({ selection: { bookId: "book_123456", chapters: [{ chapterId: "ch_123456", ranges: [{ start: 0, end: 2 }] }] }, book, capturedAt: "not-a-time" })).toThrow();
  });

  test("64 merged source items pass and 65 refuse before any envelope is built", () => {
    const body = "a ".repeat(65);
    const ranges = Array.from({ length: 64 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }));
    expect(select([{ chapterId: "ch_123456", ranges }], detail([chapter("ch_123456", body)])).sources[0]?.segments).toHaveLength(64);
    expect(() => select([{ chapterId: "ch_123456", ranges: [...ranges, { start: 128, end: 129 }] }], detail([chapter("ch_123456", body)])))
      .toThrow("source-item-limit");
  });
});
