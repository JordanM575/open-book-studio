/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import type { AgentEvent } from "@ai-book-studio/core/agent";
import type { DraftInput, LibraryChangeEvent, SaveChapterInput } from "@ai-book-studio/core/ipc";
import type { Chapter, ReorderChapterResult, ReorderDirection } from "@ai-book-studio/core/schema";
import { DraftBuffer } from "../src/main/drafts";
import { Library } from "../src/main/library/store";
import { mountDom, unmountDom } from "./support/dom";

let testing!: typeof import("@testing-library/react/pure");
let WorkspaceView!: typeof import("@ai-book-studio/app/views/WorkspaceView").WorkspaceView;

beforeAll(async () => {
  testing = await mountDom();
  ({ WorkspaceView } = await import("@ai-book-studio/app/views/WorkspaceView"));
});
afterAll(async () => {
  await unmountDom();
});

const roots: string[] = [];

afterEach(async () => {
  testing.cleanup();
  // The editor saves on unmount; let that land before its library folder goes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/*
 * Moving chapters while one is open (QA D5). A move rewrites `order` in every chapter file it shifts,
 * the open chapter's included, so that file's version and hash change although its words do not. The
 * workspace, the rail, the editor and the chat are the real components; the bridge behind them
 * answers from a real library in a temporary folder, the way the main process does, so every save
 * below is checked against the file's version and hash, and a stale base becomes a conflict copy.
 */

const TURN = "turn_move000001";

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

interface Workspace {
  root: string;
  library: Library;
  bookId: string;
  chapters: Chapter[];
  notices: unknown[];
  start: ReturnType<typeof mock>;
  reorder: ReturnType<typeof mock>;
  move: ReturnType<typeof mock>;
  emitAgent: (event: AgentEvent) => void;
}

interface MountOptions {
  /** Hold each move's answer this long after the library has written it, like a long book on a slow disk. */
  moveReplyDelayMs?: number;
  /** Replace the library's reorder, for example with one that meets an outside edit. */
  reorder?: (workspace: Workspace, chapterId: string, direction: ReorderDirection) => Promise<ReorderChapterResult>;
  /** Chapter titles and text, opened on the first. */
  book?: Array<{ title: string; content: string }>;
}

const SALT_ROAD = [
  { title: "One", content: "The tide was out.\n" },
  { title: "Two", content: "Mara walked on.\n" },
  { title: "Three", content: "The gate was shut.\n" }
];

async function mountWorkspace({ moveReplyDelayMs = 0, reorder, book = SALT_ROAD }: MountOptions = {}): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "studio-move-open-"));
  roots.push(root);
  const library = await Library.open(root);
  const created = await library.createBook({ title: "The Salt Road" });
  const chapters: Chapter[] = [];
  for (const chapter of book) chapters.push(await library.createChapter(created.id, chapter));
  const drafts = new DraftBuffer();
  const agentListeners = new Set<(event: AgentEvent) => void>();
  const start = mock(async (_request: unknown) => ok({ turnId: TURN, threadId: "thread_move000001" }));
  const reply = async <T,>(result: T): Promise<{ ok: true; data: T }> => {
    if (moveReplyDelayMs) await new Promise((resolve) => setTimeout(resolve, moveReplyDelayMs));
    return ok(result);
  };
  const workspace: Workspace = {
    root,
    library,
    bookId: created.id,
    chapters,
    notices: [],
    start,
    reorder: mock(async (bookId: string, chapterId: string, direction: ReorderDirection) =>
      reply(await (reorder ? reorder(workspace, chapterId, direction) : library.reorderChapter(bookId, chapterId, direction)))
    ),
    move: mock(async (bookId: string, chapterId: string, targetIndex: number) =>
      reply(await library.moveChapterTo(bookId, chapterId, targetIndex))
    ),
    emitAgent: (event) => {
      for (const listener of [...agentListeners]) listener(event);
    }
  };

  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    books: { open: async (bookId: string) => ok(await library.readBook(bookId)) },
    chapters: {
      save: async (input: SaveChapterInput) =>
        ok(
          await library.saveChapter(input.bookId, input.chapterId, input.content, {
            baseVersion: input.baseVersion,
            baseHash: input.baseHash
          })
        ),
      create: async (bookId: string) => ok(await library.createChapter(bookId, {})),
      reorder: workspace.reorder,
      move: workspace.move,
      delete: mock(async () => ok(null))
    },
    conflicts: {
      list: async (bookId: string) => ok(await library.listConflicts(bookId)),
      reveal: mock(async () => ok(null))
    },
    drafts: {
      set: async (input: DraftInput) => {
        drafts.set(input);
        return ok(null);
      },
      clear: async (bookId: string, chapterId: string) => {
        drafts.clear(bookId, chapterId);
        return ok(null);
      },
      onFlushRequest: () => () => {}
    },
    recovery: { list: async () => ok([]) },
    images: { list: async () => ok({ manifest: { images: [] } }) },
    library: { onChange: (_callback: (change: LibraryChangeEvent) => void) => () => {} },
    agent: {
      onEvent: (callback: (event: AgentEvent) => void) => {
        agentListeners.add(callback);
        return () => agentListeners.delete(callback);
      },
      ambient: async () => ok(null),
      start,
      stop: mock(async () => ok(null)),
      approve: mock(async () => ok(null)),
      undoLast: mock(async () => ok({ restored: 0, skipped: 0 })),
      threads: {
        list: async () => ok([]),
        read: async () => ok({ thread: null, planRuntime: null }),
        fork: mock(async () => ok(null)),
        remove: mock(async () => ok(null)),
        rename: mock(async () => ok(null))
      }
    },
    voice: {
      connections: async () => ok([]),
      speakers: async () => ok({ available: false, connectionLabel: null, endpoint: null, model: null, voices: [] })
    }
  };

  testing.render(
    React.createElement(WorkspaceView, {
      bookId: created.id,
      theme: { choice: "light" as const, set: () => {}, cycle: () => {} },
      libraryRoot: root,
      libraryStorage: undefined,
      onBack: () => {},
      onNotice: (error: unknown) => workspace.notices.push(error),
      onSchemaRefusal: () => {}
    })
  );
  await testing.waitFor(() => expect(editorText()).toBe(book[0]?.content ?? ""));
  return workspace;
}

function view(): ReturnType<typeof testing.within> {
  return testing.within(document.body);
}

function textarea(): HTMLTextAreaElement {
  return view().getByTestId("manuscript-text") as HTMLTextAreaElement;
}

function editorText(): string {
  return textarea().value;
}

function type(text: string): void {
  testing.fireEvent.change(textarea(), { target: { value: editorText() + text } });
}

function railTitles(): string[] {
  return view()
    .getAllByTestId("chapter-row")
    .map((row: HTMLElement) => row.querySelector(".truncate")?.textContent ?? "");
}

function saveStatus(): string {
  return view().getByTestId("save-status").getAttribute("aria-label") ?? "";
}

async function settle(ms: number): Promise<void> {
  await testing.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function chapterFile(workspace: Workspace, chapter: Chapter): Promise<string> {
  return readFile(join(workspace.root, "books", workspace.bookId, "chapters", chapter.path), "utf8");
}

async function conflictFiles(workspace: Workspace): Promise<string[]> {
  const names = await readdir(join(workspace.root, "books", workspace.bookId, "conflicts")).catch(() => []);
  return names.filter((name) => name.endsWith(".md")).sort();
}

/** Wait until the open chapter's file holds `text`, then prove it got there by an ordinary save. */
async function expectSavedNormally(workspace: Workspace, chapter: Chapter, text: string): Promise<void> {
  await testing.waitFor(
    async () => {
      expect(await chapterFile(workspace, chapter)).toContain(text);
    },
    { timeout: 4000 }
  );
  await testing.waitFor(() => expect(saveStatus()).toStartWith("Saved"));
  expect(await conflictFiles(workspace)).toEqual([]);
  expect(await workspace.library.listConflicts(workspace.bookId)).toHaveLength(0);
  expect(view().queryByText("This chapter was saved somewhere else")).toBeNull();
  expect(workspace.notices).toEqual([]);
}

/** The drag the rail listens for: pick up one row, hold it over another and let go. */
async function drag(fromIndex: number, toIndex: number): Promise<void> {
  const items = view().getAllByTestId("chapter-item");
  const source = items[fromIndex];
  const target = items[toIndex];
  if (!source || !target) throw new Error("the rail lost a chapter");
  const store = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "uninitialized",
    dropEffect: "none",
    setData: (format: string, value: string) => void store.set(format, value),
    getData: (format: string) => store.get(format) ?? ""
  };
  await testing.act(async () => {
    testing.fireEvent.dragStart(source, { dataTransfer });
  });
  await testing.act(async () => {
    testing.fireEvent.dragOver(target, { dataTransfer });
    testing.fireEvent.drop(target, { dataTransfer });
  });
}

describe("moving the open chapter keeps the editor's base (QA D5)", () => {
  test("type, move the open chapter with its button, type again: both save, with no conflict copy", async () => {
    const workspace = await mountWorkspace();
    const [one] = workspace.chapters;
    if (!one) throw new Error("no first chapter");
    const editor = textarea();

    type("Mara counted the gulls.\n");
    testing.fireEvent.click(view().getAllByTestId("move-chapter-down")[0] as HTMLElement);
    await testing.waitFor(() => expect(railTitles()).toEqual(["Two", "One", "Three"]));
    expect(workspace.reorder).toHaveBeenCalledTimes(1);

    type("The road showed through the sand.\n");
    await expectSavedNormally(workspace, one, "The road showed through the sand.");
    const saved = await workspace.library.readChapter(workspace.bookId, one.id);
    expect(saved.content).toBe("The tide was out.\nMara counted the gulls.\nThe road showed through the sand.\n");
    // Two saves and the move's own rewrite.
    expect(saved.version).toBe(one.version + 3);
    expect(saved.order).toBe(2);
    // The editor was never swapped out: the caret and undo stay where the author left them.
    expect(textarea()).toBe(editor);
  }, 15_000);

  test("the same with ⌘⌥↓ pressed while writing, and the text keeps the focus", async () => {
    const workspace = await mountWorkspace();
    const [one] = workspace.chapters;
    if (!one) throw new Error("no first chapter");
    const editor = textarea();
    editor.focus();

    type("Mara counted the gulls.\n");
    testing.fireEvent.keyDown(editor, { key: "ArrowDown", metaKey: true, altKey: true });
    await testing.waitFor(() => expect(railTitles()).toEqual(["Two", "One", "Three"]));
    expect(workspace.reorder).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor);

    type("The road showed through the sand.\n");
    await expectSavedNormally(workspace, one, "The road showed through the sand.");
    expect((await workspace.library.readChapter(workspace.bookId, one.id)).content).toContain("Mara counted the gulls.");
    expect(textarea()).toBe(editor);
  }, 15_000);

  test("the same when the open chapter is dragged to a new place", async () => {
    const workspace = await mountWorkspace();
    const [one] = workspace.chapters;
    if (!one) throw new Error("no first chapter");

    type("Mara counted the gulls.\n");
    await drag(0, 2);
    await testing.waitFor(() => expect(railTitles()).toEqual(["Two", "Three", "One"]));
    expect(workspace.move).toHaveBeenCalledTimes(1);
    expect(workspace.move.mock.calls[0]?.slice(1)).toEqual([one.id, 2]);

    type("The road showed through the sand.\n");
    await expectSavedNormally(workspace, one, "The road showed through the sand.");
    expect((await workspace.library.readChapter(workspace.bookId, one.id)).order).toBe(3);
  }, 15_000);

  test("words typed in the open chapter while another chapter is dragged past it are kept", async () => {
    const workspace = await mountWorkspace({ moveReplyDelayMs: 1200 });
    const [one, , three] = workspace.chapters;
    if (!one || !three) throw new Error("no chapters");

    // Chapter Three goes to the top, which renumbers the open chapter One too.
    type("Mara counted the gulls.\n");
    await drag(2, 0);
    await settle(100);
    type("She stopped at the gate.\n");
    await settle(900);

    // The dragged chapter opens once it lands; One's last words are saved on the way out.
    await testing.waitFor(() => expect(railTitles()).toEqual(["Three", "One", "Two"]), { timeout: 3000 });
    await testing.waitFor(() => expect(editorText()).toBe(three.content));
    await testing.waitFor(
      async () => {
        expect(await chapterFile(workspace, one)).toContain("She stopped at the gate.");
      },
      { timeout: 4000 }
    );
    await settle(100);
    expect(await conflictFiles(workspace)).toEqual([]);
    const saved = await workspace.library.readChapter(workspace.bookId, one.id);
    expect(saved.content).toBe("The tide was out.\nMara counted the gulls.\nShe stopped at the gate.\n");
    expect(saved.version).toBe(one.version + 3);
    expect(workspace.notices).toEqual([]);
  }, 15_000);

  test("words typed while a move is on its way are kept and save after it, with no conflict copy", async () => {
    // The move answers 1.2 s after the library wrote it, so the 0.7 s autosave falls inside the move.
    const workspace = await mountWorkspace({ moveReplyDelayMs: 1200 });
    const [one] = workspace.chapters;
    if (!one) throw new Error("no first chapter");

    type("Mara counted the gulls.\n");
    testing.fireEvent.click(view().getAllByTestId("move-chapter-down")[0] as HTMLElement);
    await settle(100);
    type("She stopped at the gate.\n");
    await settle(900);
    expect(railTitles()).toEqual(["One", "Two", "Three"]);
    expect(editorText()).toContain("She stopped at the gate.");

    await testing.waitFor(() => expect(railTitles()).toEqual(["Two", "One", "Three"]), { timeout: 3000 });
    await expectSavedNormally(workspace, one, "She stopped at the gate.");
    const saved = await workspace.library.readChapter(workspace.bookId, one.id);
    expect(saved.content).toBe("The tide was out.\nMara counted the gulls.\nShe stopped at the gate.\n");
    expect(saved.version).toBe(one.version + 3);
    expect(editorText()).toBe(saved.content);
  }, 15_000);

  test("a move that meets an outside edit and is undone again leaves the editor saving normally", async () => {
    const workspace = await mountWorkspace({
      // What the library does when the second file of a swap changed on disk: it moved the first
      // file, then put it back, and reports the conflict.
      reorder: async ({ library, bookId }, chapterId) => {
        const current = await library.readChapter(bookId, chapterId);
        const there = await library.updateChapterMeta(bookId, chapterId, { order: 2 }, {
          baseVersion: current.version,
          baseHash: current.hash
        });
        if (there.status !== "saved") throw new Error("the first write should have landed");
        const back = await library.updateChapterMeta(bookId, chapterId, { order: 1 }, {
          baseVersion: there.chapter.version,
          baseHash: there.chapter.hash
        });
        if (back.status !== "saved") throw new Error("the rollback should have landed");
        const result: ReorderChapterResult = {
          status: "conflict",
          conflict: {
            bookId,
            chapterId,
            chapterTitle: "Two",
            savedAs: `books/${bookId}/conflicts/0002-two.conflict-external-edit.md`,
            reason: "external-edit",
            diskVersion: 2,
            localVersion: 2
          }
        };
        return result;
      }
    });
    const [one] = workspace.chapters;
    if (!one) throw new Error("no first chapter");

    testing.fireEvent.click(view().getAllByTestId("move-chapter-down")[0] as HTMLElement);
    await testing.waitFor(() => expect(workspace.notices).toHaveLength(1));
    expect(String(workspace.notices[0])).toContain("The chapter order changed outside the studio.");
    workspace.notices.splice(0);
    expect(railTitles()).toEqual(["One", "Two", "Three"]);

    type("The road showed through the sand.\n");
    await expectSavedNormally(workspace, one, "The road showed through the sand.");
    expect((await workspace.library.readChapter(workspace.bookId, one.id)).version).toBe(one.version + 3);
  }, 15_000);
});

/** Ask the agent for a change from the chat, let the turn write, then end it. */
async function runTurn(workspace: Workspace, write: () => Promise<unknown>): Promise<void> {
  testing.fireEvent.click(view().getByTestId("toggle-chat"));
  const input = await testing.waitFor(() => view().getByTestId("chat-input"));
  testing.fireEvent.change(input, { target: { value: "Move this chapter after the next one." } });
  testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
  await testing.waitFor(() => expect(workspace.start).toHaveBeenCalledTimes(1));
  // The turn id lands once start resolves; events for it are only heard after that.
  await settle(20);
  await write();
  await testing.act(async () => {
    workspace.emitAgent({
      type: "done",
      turnId: TURN,
      text: "I moved the chapter.",
      model: { provider: "openrouter", modelId: "test-model", connectionLabel: "Test connection", name: "Test Model" },
      inputTokens: 100,
      outputTokens: 12,
      costUsd: 0.0012,
      costBasis: "reported",
      contextLength: 1000,
      context: {
        estimated: true as const,
        sections: [{ id: "chapters", label: "Chapters", characters: 400, estimatedTokens: 100 }],
        conversationTokens: 0,
        totalTokens: 100
      },
      changed: 1,
      undoAvailable: true
    } as AgentEvent);
  });
}

describe("an agent's structural change to the open chapter (QA D5)", () => {
  test("words typed during a turn that moves the open chapter save normally when it ends, in the same editor", async () => {
    const workspace = await mountWorkspace();
    const [one] = workspace.chapters;
    if (!one) throw new Error("no first chapter");
    const editor = textarea();

    await runTurn(workspace, async () => {
      // The author writes on while the agent works; the autosave has not run when the turn moves the chapter.
      await testing.act(async () => {
        type("Mara counted the gulls.\n");
      });
      await workspace.library.moveChapterTo(workspace.bookId, one.id, 1);
    });

    await expectSavedNormally(workspace, one, "Mara counted the gulls.");
    expect(railTitles()).toEqual(["Two", "One", "Three"]);
    expect(textarea()).toBe(editor);
    expect((await workspace.library.readChapter(workspace.bookId, one.id)).version).toBe(one.version + 2);
  }, 15_000);

  test("after a turn moves the open chapter, the author's next words save normally", async () => {
    const workspace = await mountWorkspace();
    const [one] = workspace.chapters;
    if (!one) throw new Error("no first chapter");

    await runTurn(workspace, () => workspace.library.moveChapterTo(workspace.bookId, one.id, 2));
    await testing.waitFor(() => expect(railTitles()).toEqual(["Two", "Three", "One"]), { timeout: 3000 });

    type("The road showed through the sand.\n");
    await expectSavedNormally(workspace, one, "The road showed through the sand.");
    expect((await workspace.library.readChapter(workspace.bookId, one.id)).version).toBe(one.version + 2);
  }, 15_000);

  test("after a turn merges the next chapter into the open one, the editor shows it and the next words save normally", async () => {
    const workspace = await mountWorkspace();
    const [one, two] = workspace.chapters;
    if (!one || !two) throw new Error("no chapters");

    await runTurn(workspace, async () => {
      // What merge_chapters does: the second chapter goes to the trash and its text joins the first.
      await workspace.library.deleteChapter(workspace.bookId, two.id);
      await workspace.library.saveChapter(workspace.bookId, one.id, "The tide was out.\n\nMara walked on.\n", {
        baseVersion: one.version,
        baseHash: one.hash
      });
    });
    await testing.waitFor(() => expect(editorText()).toBe("The tide was out.\n\nMara walked on.\n"), { timeout: 3000 });
    expect(railTitles()).toEqual(["One", "Three"]);

    type("The road showed through the sand.\n");
    await expectSavedNormally(workspace, one, "The road showed through the sand.");
    expect((await workspace.library.readChapter(workspace.bookId, one.id)).content).toContain("Mara walked on.");
  }, 15_000);
});
