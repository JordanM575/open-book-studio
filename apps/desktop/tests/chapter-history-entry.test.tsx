/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import { bookSchema, chapterMetaSchema } from "@ai-book-studio/core/schema";
import type { Chapter, SaveChapterResult } from "@ai-book-studio/core/schema";
import type { Result } from "@ai-book-studio/core/ipc";
import type { HistoryComparison, HistoryListing, StoredHistoryRecord } from "@ai-book-studio/core/library/history";
import type { BoundChapterHistoryApi } from "../../../packages/app/src/lib/chapter-history-host";

let testing!: typeof import("@testing-library/react/pure");
let WorkspaceView!: typeof import("@ai-book-studio/app/views/WorkspaceView").WorkspaceView;

beforeAll(async () => {
  testing = await mountDom();
  ({ WorkspaceView } = await import("@ai-book-studio/app/views/WorkspaceView"));
});
afterAll(async () => {
  await unmountDom();
});
afterEach(() => testing.cleanup());

/**
 * The desktop writing screen's own entry to saved chapter history. The history client is synthetic:
 * it records what the screen asked for, and it never stands in for a browser runtime.
 */

const NOW = "2026-11-16T00:00:00.000Z";
const BOOK = "book_hist0001";
const LIBRARY = "/tmp/studio-library";

function chapter(id: string, title: string, order: number): Chapter {
  return {
    ...chapterMetaSchema.parse({ id, title, order, createdAt: NOW, updatedAt: NOW }),
    content: `${title} line.\n`,
    path: `${String(order).padStart(4, "0")}-${title.toLowerCase()}.md`,
    wordCount: 2,
    hash: id === "ch_hist0001" ? "a".repeat(64) : "b".repeat(64)
  };
}

const FIRST = chapter("ch_hist0001", "First", 1);
const SECOND = chapter("ch_hist0002", "Second", 2);

function saved(content: string, version: number): Result<SaveChapterResult> {
  return { ok: true, data: { status: "saved", chapter: { ...FIRST, content, version, hash: "c".repeat(64), updatedAt: NOW } } };
}

const RECORD: StoredHistoryRecord = {
  fileName: "kept.md",
  hash: "d".repeat(64),
  content: "Saved history text.\n",
  meta: {
    schemaVersion: 1,
    id: "hist_kept0001",
    kind: "snapshot",
    bookId: BOOK,
    chapterId: FIRST.id,
    label: "Kept",
    sourceVersion: 1,
    sourceHash: "a".repeat(64),
    bodyHash: "e".repeat(64),
    capturedAt: NOW
  }
};

function historyClient() {
  const listing: HistoryListing = { records: [{ fileName: RECORD.fileName, hash: RECORD.hash, meta: RECORD.meta, size: 24 }], issues: [] };
  const comparison: HistoryComparison = {
    basis: "saved",
    snapshot: RECORD,
    current: { bookId: BOOK, chapterId: FIRST.id, version: 1, hash: "a".repeat(64), content: FIRST.content },
    equal: false
  };
  return {
    list: mock(async () => ({ ok: true as const, data: listing })),
    read: mock(async () => ({ ok: true as const, data: RECORD })),
    compare: mock(async () => ({ ok: true as const, data: comparison })),
    capture: mock(async () => ({ ok: true as const, data: RECORD }))
  };
}

function studio(history: ReturnType<typeof historyClient> | undefined, save = mock(async (): Promise<Result<SaveChapterResult>> => saved(FIRST.content, 1))) {
  const book = bookSchema.parse({ id: BOOK, title: "The Salt Road", outline: "Two sisters.", createdAt: NOW, updatedAt: NOW });
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    books: { open: mock(async () => ({ ok: true, data: { book, chapters: [FIRST, SECOND], chapterReadIssues: [] } })), edit: mock(async () => ({ ok: true, data: null })) },
    chapters: {
      create: mock(async () => ({ ok: true, data: FIRST })),
      reorder: mock(async () => ({ ok: true, data: { status: "saved", chapters: [FIRST, SECOND] } })),
      move: mock(async () => ({ ok: true, data: { status: "saved", chapters: [FIRST, SECOND] } })),
      delete: mock(async () => ({ ok: true, data: null })),
      save
    },
    conflicts: { list: mock(async () => ({ ok: true, data: [] })), reveal: mock(async () => ({ ok: true, data: null })) },
    drafts: { set: mock(async () => ({ ok: true, data: null })), clear: mock(async () => ({ ok: true, data: null })), onFlushRequest: mock(() => () => {}) },
    recovery: { list: mock(async () => ({ ok: true, data: [] })) },
    images: { list: mock(async () => ({ ok: true, data: { manifest: { images: [] } } })) },
    library: { onChange: mock(() => () => {}) },
    agent: { onEvent: mock(() => () => {}), ambient: mock(async () => ({ ok: true, data: null })) },
    voice: {
      connections: mock(async () => ({ ok: true, data: [] })),
      speakers: mock(async () => ({ ok: true, data: { available: false, connectionLabel: null, endpoint: null, model: null, voices: [] } }))
    },
    ...(history ? { history } : {})
  };
  return { save, history };
}

function renderWorkspace() {
  testing.render(React.createElement(WorkspaceView, {
    bookId: BOOK,
    theme: { choice: "light" as const, set: () => {}, cycle: () => {} },
    libraryRoot: LIBRARY,
    libraryStorage: undefined,
    onBack: () => {},
    onNotice: () => {},
    onSchemaRefusal: () => {}
  }));
  return testing.within(document.body);
}

async function openBook(view: ReturnType<typeof renderWorkspace>) {
  await testing.waitFor(() => expect(view.getAllByTestId("chapter-row")).toHaveLength(2));
  await testing.waitFor(() => expect(view.getByTestId("manuscript-text")).toBeTruthy());
}

function workspace(): HTMLElement & { historyApi?: BoundChapterHistoryApi } {
  return document.querySelector("[data-testid='workspace-view']") as HTMLElement & { historyApi?: BoundChapterHistoryApi };
}

function viewId(): string {
  return workspace().getAttribute("data-history-view") ?? "";
}

function revisionOf(): number {
  return Number(workspace().getAttribute("data-history-revision"));
}

function openHistory(view: ReturnType<typeof renderWorkspace>): BoundChapterHistoryApi {
  testing.fireEvent.click(view.getByTestId("mobile-more"));
  testing.fireEvent.click(view.getByTestId("more-chapter-history"));
  view.getByRole("dialog", { name: "Chapter history" });
  const api = workspace().historyApi;
  if (!api) throw new Error("The open chapter history has no adapter.");
  return api;
}

describe("desktop chapter history entry", () => {
  test("opens saved chapter history from More and lists the selected chapter", async () => {
    const history = historyClient();
    studio(history);
    const view = renderWorkspace();
    await openBook(view);

    expect(view.queryByTestId("more-chapter-history")).toBeNull();
    const api = openHistory(view);
    expect(view.queryByRole("dialog", { name: "More" })).toBeNull();
    await testing.waitFor(() => expect(view.getAllByRole("button", { name: "Open record" }).length).toBeGreaterThan(0));
    expect(history.list).toHaveBeenCalledTimes(1);
    expect(history.list).toHaveBeenCalledWith({ bookId: BOOK, chapterId: FIRST.id });
    expect(api.viewId).toBe(viewId());
    expect(view.getByText(/Current saved source · version 1/)).toBeTruthy();
    expect(view.getByText("No unsaved editor draft is reported. Comparisons use only the confirmed saved text.")).toBeTruthy();
  });

  test("a new visit gets a new id, and a late call from the old visit is refused", async () => {
    const history = historyClient();
    studio(history);
    const view = renderWorkspace();
    await openBook(view);
    const first = openHistory(view);
    const firstId = viewId();
    expect(first.viewId).toBe(firstId);
    testing.fireEvent.click(view.getByRole("button", { name: "Close" }));

    testing.fireEvent.click(view.getAllByTestId("chapter-row")[1]!);
    await testing.waitFor(() => expect(viewId()).not.toBe(firstId));
    const secondId = viewId();
    const second = openHistory(view);
    expect(second.viewId).toBe(secondId);

    const target = { libraryId: LIBRARY, bookId: BOOK, chapterId: FIRST.id, viewId: firstId };
    const callsBefore = history.list.mock.calls.length;
    await expect(first.list(target)).rejects.toThrow(/another visit/);
    expect(history.list.mock.calls).toHaveLength(callsBefore);
    await second.list({ ...target, chapterId: SECOND.id, viewId: secondId });
    expect(history.list).toHaveBeenLastCalledWith({ bookId: BOOK, chapterId: SECOND.id });
  });

  test("dirty, saving, conflict, and failed map onto the dialog, and only a confirmed save is clean", async () => {
    let reply: Result<SaveChapterResult> | Promise<Result<SaveChapterResult>> = saved("Dirty line.\n", 2);
    const save = mock(async () => reply);
    studio(historyClient(), save);
    const view = renderWorkspace();
    await openBook(view);

    testing.fireEvent.change(view.getByTestId("manuscript-text"), { target: { value: "Dirty line.\n" } });
    openHistory(view);
    expect(view.getByText("Your unsaved editor draft is excluded from history and comparisons.")).toBeTruthy();
    const dirtyRevision = revisionOf();
    testing.fireEvent.click(view.getByRole("button", { name: "Close" }));

    let releaseSave!: (value: Result<SaveChapterResult>) => void;
    reply = new Promise<Result<SaveChapterResult>>((resolve) => { releaseSave = resolve; });
    testing.fireEvent.blur(view.getByTestId("manuscript-text"));
    await testing.waitFor(() => expect(save).toHaveBeenCalled());
    openHistory(view);
    expect(view.getByText("A save is pending. Its editor text is excluded from comparisons until confirmed saved.")).toBeTruthy();
    const pendingRevision = revisionOf();
    expect(pendingRevision).toBeGreaterThan(dirtyRevision);
    testing.fireEvent.click(view.getByRole("button", { name: "Close" }));
    releaseSave(saved("Dirty line.\n", 2));
    reply = saved("Dirty line.\n", 2);
    await testing.waitFor(() => expect(view.getByTestId("save-status").getAttribute("aria-label") ?? "").toMatch(/^Saved /));
    openHistory(view);
    expect(view.getByText("No unsaved editor draft is reported. Comparisons use only the confirmed saved text.")).toBeTruthy();
    expect(view.getByText(/Current saved source · version 2/)).toBeTruthy();
    expect(revisionOf()).toBeGreaterThan(pendingRevision);
    testing.fireEvent.click(view.getByRole("button", { name: "Close" }));

    reply = { ok: true, data: { status: "conflict", conflict: { bookId: BOOK, chapterId: FIRST.id, chapterTitle: "First", savedAs: "conflicts/first.md", reason: "newer-version", diskVersion: 3, localVersion: 2 } } };
    testing.fireEvent.change(view.getByTestId("manuscript-text"), { target: { value: "Conflicting line.\n" } });
    testing.fireEvent.blur(view.getByTestId("manuscript-text"));
    await testing.waitFor(() => expect(save.mock.calls.length).toBeGreaterThan(1));
    openHistory(view);
    expect(view.getByText("A conflict is unresolved. Editor drafts and conflict copies are excluded from comparisons.")).toBeTruthy();
    testing.fireEvent.click(view.getByRole("button", { name: "Close" }));

    reply = { ok: false, error: { code: "io", message: "The disk is full." } };
    testing.fireEvent.change(view.getByTestId("manuscript-text"), { target: { value: "Failed line.\n" } });
    testing.fireEvent.blur(view.getByTestId("manuscript-text"));
    const failed = openHistory(view);
    await testing.waitFor(() => expect(view.getByText("The last save failed. Unsaved editor text is excluded from comparisons.")).toBeTruthy());
    expect(failed.viewId).toBe(viewId());
  });

  test("the same visit may list again, and a return to the chapter does not reuse the id", async () => {
    const history = historyClient();
    studio(history);
    const view = renderWorkspace();
    await openBook(view);
    const first = openHistory(view);
    await first.list({ libraryId: LIBRARY, bookId: BOOK, chapterId: FIRST.id, viewId: first.viewId });
    const listed = history.list.mock.calls.length;
    testing.fireEvent.click(view.getByRole("button", { name: "Close" }));
    const again = openHistory(view);
    expect(again.viewId).toBe(first.viewId);
    await again.list({ libraryId: LIBRARY, bookId: BOOK, chapterId: FIRST.id, viewId: again.viewId });
    expect(history.list.mock.calls.length).toBeGreaterThan(listed);
    expect(history.list).toHaveBeenLastCalledWith({ bookId: BOOK, chapterId: FIRST.id });
    testing.fireEvent.click(view.getByRole("button", { name: "Close" }));

    testing.fireEvent.click(view.getAllByTestId("chapter-row")[1]!);
    await testing.waitFor(() => expect(viewId()).not.toBe(first.viewId));
    testing.fireEvent.click(view.getAllByTestId("chapter-row")[0]!);
    await testing.waitFor(() => expect(view.getByTestId("manuscript-text")).toBeTruthy());
    const returned = openHistory(view);
    expect(returned.viewId).not.toBe(first.viewId);
    await expect(first.list({ libraryId: LIBRARY, bookId: BOOK, chapterId: FIRST.id, viewId: first.viewId })).rejects.toThrow(/another visit/);
  });

  test("without a history API the More item is absent and nothing is adapted", async () => {
    studio(undefined);
    const view = renderWorkspace();
    await openBook(view);
    testing.fireEvent.click(view.getByTestId("mobile-more"));
    expect(view.queryByTestId("more-chapter-history")).toBeNull();
    expect(view.queryByRole("dialog", { name: "Chapter history" })).toBeNull();
    expect(view.getByTestId("more-story-bible")).toBeTruthy();
  });
});
