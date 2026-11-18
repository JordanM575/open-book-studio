/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import type { AgentEvent } from "@ai-book-studio/core/agent";
import type { DraftInput, LibraryChangeEvent, SaveChapterInput } from "@ai-book-studio/core/ipc";
import type { Chapter } from "@ai-book-studio/core/schema";
import { DraftBuffer } from "../src/main/drafts";
import { Library } from "../src/main/library/store";
import { createFlushRequests } from "../src/preload/flush-requests";
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
 * Where the open editor meets the files on disk. The workspace, the editor and the chat are the real
 * components; the bridge behind them answers from a real library in a temporary folder, the way the
 * main process does, so every save below is checked against the file's version and hash.
 */

const TURN = "turn_sync000001";

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

interface Workspace {
  root: string;
  library: Library;
  bookId: string;
  first: Chapter;
  second: Chapter;
  drafts: DraftBuffer;
  notices: unknown[];
  start: ReturnType<typeof mock>;
  emitAgent: (event: AgentEvent) => void;
  emitChange: (change: LibraryChangeEvent) => void;
  /** What the main process does on a close or quit: ask the window for its newest text, then save every draft. */
  quit: () => Promise<unknown>;
  /** How many times the workspace has listed conflicts: the last step of every book load. */
  loads: () => number;
}

interface MountOptions {
  undo?: (workspace: Workspace) => Promise<unknown>;
  /** What the ambient strip is told about the book; only its actions matter here. */
  ambient?: unknown;
  /** Hold each chapter save this long before the library sees it, like a slow synced folder. */
  saveDelayMs?: number;
}

async function mountWorkspace({ undo, ambient = null, saveDelayMs = 0 }: MountOptions = {}): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "studio-editor-sync-"));
  roots.push(root);
  const library = await Library.open(root);
  const book = await library.createBook({ title: "The Salt Road" });
  const first = await library.createChapter(book.id, { title: "One", content: "The tide was out.\n" });
  const second = await library.createChapter(book.id, { title: "Two", content: "Mara walked on.\n" });
  const drafts = new DraftBuffer();
  // The preload bridge's half of the flush, answering into the main process's draft buffer.
  const flushRequests = createFlushRequests((requestId) => drafts.answered(requestId));
  let loads = 0;
  const agentListeners = new Set<(event: AgentEvent) => void>();
  const changeListeners = new Set<(change: LibraryChangeEvent) => void>();
  const start = mock(async (_request: unknown) => ok({ turnId: TURN, threadId: "thread_sync000001" }));
  const workspace: Workspace = {
    root,
    library,
    bookId: book.id,
    first,
    second,
    drafts,
    notices: [],
    start,
    emitAgent: (event) => {
      for (const listener of [...agentListeners]) listener(event);
    },
    emitChange: (change) => {
      for (const listener of [...changeListeners]) listener(change);
    },
    quit: () =>
      drafts.flushBeforeExit(library, {
        isDestroyed: () => false,
        isCrashed: () => false,
        send: (_channel, request) => void flushRequests.handle(request.requestId)
      }),
    loads: () => loads
  };
  const undoLast = mock(async () => ok(await (undo ? undo(workspace) : Promise.resolve({ restored: 0, skipped: 0 }))));

  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    books: { open: async (bookId: string) => ok(await library.readBook(bookId)) },
    chapters: {
      save: async (input: SaveChapterInput) => {
        if (saveDelayMs) await new Promise((resolve) => setTimeout(resolve, saveDelayMs));
        return ok(
          await library.saveChapter(input.bookId, input.chapterId, input.content, {
            baseVersion: input.baseVersion,
            baseHash: input.baseHash
          })
        );
      },
      create: async (bookId: string) => ok(await library.createChapter(bookId, {})),
      reorder: mock(async () => ok({ status: "saved", chapters: [] })),
      move: mock(async () => ok({ status: "saved", chapters: [] })),
      delete: mock(async () => ok(null))
    },
    conflicts: {
      list: async (bookId: string) => {
        const conflicts = await library.listConflicts(bookId);
        loads += 1;
        return ok(conflicts);
      },
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
      onFlushRequest: (handler: () => Promise<unknown>) => flushRequests.subscribe(handler)
    },
    recovery: { list: async () => ok([]) },
    images: { list: async () => ok({ manifest: { images: [] } }) },
    library: {
      onChange: (callback: (change: LibraryChangeEvent) => void) => {
        changeListeners.add(callback);
        return () => changeListeners.delete(callback);
      }
    },
    agent: {
      onEvent: (callback: (event: AgentEvent) => void) => {
        agentListeners.add(callback);
        return () => agentListeners.delete(callback);
      },
      // Without a status the ambient strip stays on "Looking at your book…".
      ambient: async () => ok(ambient),
      start,
      stop: mock(async () => ok(null)),
      approve: mock(async () => ok(null)),
      undoLast,
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
      bookId: book.id,
      theme: { choice: "light" as const, set: () => {}, cycle: () => {} },
      libraryRoot: root,
      libraryStorage: undefined,
      onBack: () => {},
      onNotice: (error: unknown) => workspace.notices.push(error),
      onSchemaRefusal: () => {}
    })
  );
  await testing.waitFor(() => expect(editorText()).toContain("The tide was out."));
  return workspace;
}

function view(): ReturnType<typeof testing.within> {
  return testing.within(document.body);
}

function editorText(): string {
  return (view().getByTestId("manuscript-text") as HTMLTextAreaElement).value;
}

function type(text: string): void {
  testing.fireEvent.change(view().getByTestId("manuscript-text"), { target: { value: editorText() + text } });
}

function saveStatus(): string {
  return view().getByTestId("save-status").getAttribute("aria-label") ?? "";
}

async function chapterFile(workspace: Workspace, chapter: Chapter): Promise<string> {
  return readFile(join(workspace.root, "books", workspace.bookId, "chapters", chapter.path), "utf8");
}

/** The event that ends a turn which changed one chapter. */
type TurnEnd = "done" | "stopped" | "error";

/**
 * Ask the agent for a change, as the author does, from the chat or from the ambient strip, and let the
 * turn write the open chapter before it ends.
 */
async function runTurn(
  workspace: Workspace,
  write: () => Promise<unknown>,
  { from = "chat", end = "done" }: { from?: "chat" | "ambient"; end?: TurnEnd } = {}
): Promise<void> {
  if (from === "chat") {
    testing.fireEvent.click(view().getByTestId("toggle-chat"));
    const input = await testing.waitFor(() => view().getByTestId("chat-input"));
    testing.fireEvent.change(input, { target: { value: "Add a line about the gulls." } });
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
  } else {
    testing.fireEvent.click(view().getByTestId("ambient-toggle"));
    const input = await testing.waitFor(() => view().getByTestId("ambient-input"));
    testing.fireEvent.change(input, { target: { value: "Add a line about the gulls." } });
    testing.fireEvent.click(view().getByTestId("ambient-send"));
  }
  await testing.waitFor(() => expect(workspace.start).toHaveBeenCalledTimes(1));
  // The turn id lands once start resolves; events for it are only heard after that.
  await testing.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await write();
  await testing.act(async () => {
    if (end === "stopped") {
      workspace.emitAgent({ type: "stopped", turnId: TURN, changed: 1, undoAvailable: true });
      return;
    }
    if (end === "error") {
      workspace.emitAgent({
        type: "error",
        turnId: TURN,
        code: "provider",
        message: "The provider stopped answering.",
        changed: 1,
        undoAvailable: true
      });
      return;
    }
    workspace.emitAgent({
      type: "done",
      turnId: TURN,
      text: "I added a line about the gulls.",
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

describe("the agent's edits reach the open editor (A2)", () => {
  test("after a turn changes the open chapter, the editor shows it and the author's next words save normally", async () => {
    const workspace = await mountWorkspace();
    const { library, bookId, first } = workspace;

    await runTurn(workspace, () =>
      library.saveChapter(bookId, first.id, "The tide was out.\n\nThe gulls came back at noon.\n", {
        baseVersion: first.version,
        baseHash: first.hash
      })
    );

    await testing.waitFor(() => expect(editorText()).toContain("The gulls came back at noon."), { timeout: 3000 });
    type("\nMara counted them twice.\n");
    await testing.waitFor(
      async () => {
        expect(await chapterFile(workspace, first)).toContain("Mara counted them twice.");
      },
      { timeout: 3000 }
    );
    const saved = await library.readChapter(bookId, first.id);
    expect(saved.content).toContain("The gulls came back at noon.");
    expect(saved.version).toBe(first.version + 2);
    expect(await library.listConflicts(bookId)).toHaveLength(0);
    await testing.waitFor(() => expect(saveStatus()).toStartWith("Saved"));
    expect(workspace.notices).toEqual([]);
  }, 15_000);

  test("after undo restores the open chapter, the editor shows it and the author's next words save normally", async () => {
    const workspace = await mountWorkspace({
      undo: async ({ library, bookId, first }) => {
        const current = await library.readChapter(bookId, first.id);
        await library.saveChapter(bookId, first.id, first.content, { baseVersion: current.version, baseHash: current.hash });
        return { restored: 1, skipped: 0 };
      }
    });
    const { library, bookId, first } = workspace;

    await runTurn(workspace, () =>
      library.saveChapter(bookId, first.id, "The tide was out.\n\nThe gulls came back at noon.\n", {
        baseVersion: first.version,
        baseHash: first.hash
      })
    );
    await testing.waitFor(() => expect(editorText()).toContain("The gulls came back at noon."), { timeout: 3000 });

    const undo = await testing.waitFor(() => view().getByTestId("agent-undo-turn"));
    await testing.act(async () => {
      testing.fireEvent.click(undo);
    });
    await testing.waitFor(() => expect(editorText()).not.toContain("The gulls came back at noon."), { timeout: 3000 });
    expect(editorText()).toContain("The tide was out.");

    type("The road showed through the sand.\n");
    await testing.waitFor(
      async () => {
        expect(await chapterFile(workspace, first)).toContain("The road showed through the sand.");
      },
      { timeout: 3000 }
    );
    expect((await library.readChapter(bookId, first.id)).version).toBe(first.version + 3);
    expect(await library.listConflicts(bookId)).toHaveLength(0);
    expect(workspace.notices).toEqual([]);
  }, 15_000);

  test("after a chat turn that changed the open chapter fails, the editor shows the change and the next words save normally", async () => {
    const workspace = await mountWorkspace();
    const { library, bookId, first } = workspace;

    await runTurn(
      workspace,
      () =>
        library.saveChapter(bookId, first.id, "The tide was out.\n\nThe gulls came back at noon.\n", {
          baseVersion: first.version,
          baseHash: first.hash
        }),
      { end: "error" }
    );

    await testing.waitFor(() => expect(editorText()).toContain("The gulls came back at noon."), { timeout: 3000 });
    type("\nMara counted them twice.\n");
    await testing.waitFor(
      async () => {
        expect(await chapterFile(workspace, first)).toContain("Mara counted them twice.");
      },
      { timeout: 3000 }
    );
    expect((await library.readChapter(bookId, first.id)).version).toBe(first.version + 2);
    expect(await library.listConflicts(bookId)).toHaveLength(0);
  }, 15_000);

  test("after a turn from the ambient strip changes the open chapter, the editor shows it and the next words save normally", async () => {
    const workspace = await mountWorkspace();
    const { library, bookId, first } = workspace;

    await runTurn(
      workspace,
      () =>
        library.saveChapter(bookId, first.id, "The tide was out.\n\nThe gulls came back at noon.\n", {
          baseVersion: first.version,
          baseHash: first.hash
        }),
      { from: "ambient" }
    );

    await testing.waitFor(() => expect(editorText()).toContain("The gulls came back at noon."), { timeout: 3000 });
    type("\nMara counted them twice.\n");
    await testing.waitFor(
      async () => {
        expect(await chapterFile(workspace, first)).toContain("Mara counted them twice.");
      },
      { timeout: 3000 }
    );
    expect((await library.readChapter(bookId, first.id)).version).toBe(first.version + 2);
    expect(await library.listConflicts(bookId)).toHaveLength(0);
    expect(workspace.notices).toEqual([]);
  }, 15_000);

  test("after the ambient strip's undo rewrites the open chapter, the editor shows it and the next words save normally", async () => {
    const workspace = await mountWorkspace({
      ambient: {
        say: "You are in chapter one.",
        working: false,
        actions: [{ id: "undo", label: "Undo the last change", spoken: "Undo the last change.", available: true }]
      },
      undo: async ({ library, bookId, first }) => {
        await library.saveChapter(bookId, first.id, "The tide was in again.\n", {
          baseVersion: first.version,
          baseHash: first.hash
        });
        return { restored: 1, skipped: 0 };
      }
    });
    const { library, bookId, first } = workspace;

    testing.fireEvent.click(view().getByTestId("ambient-toggle"));
    const undo = await testing.waitFor(() => view().getByTestId("ambient-action-undo"));
    await testing.act(async () => {
      testing.fireEvent.click(undo);
    });
    await testing.waitFor(() => expect(editorText()).toContain("The tide was in again."), { timeout: 3000 });

    type("The road showed through the sand.\n");
    await testing.waitFor(
      async () => {
        expect(await chapterFile(workspace, first)).toContain("The road showed through the sand.");
      },
      { timeout: 3000 }
    );
    expect((await library.readChapter(bookId, first.id)).version).toBe(first.version + 2);
    expect(await library.listConflicts(bookId)).toHaveLength(0);
    expect(workspace.notices).toEqual([]);
  }, 15_000);

  test("a turn that leaves the open chapter alone keeps the editor as it is, with its caret and undo", async () => {
    const workspace = await mountWorkspace();
    const textarea = view().getByTestId("manuscript-text");

    // A question: the turn writes its conversation, not the chapter.
    await runTurn(workspace, () => workspace.library.threads.create(workspace.bookId, "A question"), { from: "ambient" });
    await testing.waitFor(() => expect(workspace.start).toHaveBeenCalledTimes(1));
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(view().getByTestId("manuscript-text")).toBe(textarea);
    expect(editorText()).toBe("The tide was out.\n");
    expect(workspace.notices).toEqual([]);
  }, 15_000);
});

describe("an outside edit right after a local save is announced (A3)", () => {
  test("a change to another chapter 0.3 s after an autosave shows the banner, and Refresh brings its text", async () => {
    const workspace = await mountWorkspace();
    const { library, bookId, first, second } = workspace;

    type("The road showed through the sand.\n");
    await testing.waitFor(
      async () => {
        expect(await chapterFile(workspace, first)).toContain("The road showed through the sand.");
      },
      { timeout: 3000 }
    );
    await testing.waitFor(() => expect(saveStatus()).toStartWith("Saved"));

    // Another writer adds a paragraph to chapter two a moment after the local save.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const path = `books/${bookId}/chapters/${second.path}`;
    const raw = await chapterFile(workspace, second);
    await writeFile(join(workspace.root, path), `${raw}\nA paragraph from another writer.\n`, "utf8");
    await testing.act(async () => {
      workspace.emitChange({ paths: [path], at: new Date().toISOString() });
    });

    const banner = await testing.waitFor(() => view().getByTestId("external-change"), { timeout: 3000 });
    expect(banner.textContent ?? "").toContain("The library changed outside the studio");
    expect(banner.textContent ?? "").toContain(path);

    const loaded = workspace.loads();
    testing.fireEvent.click(testing.within(banner).getByText("Refresh"));
    await testing.waitFor(() => expect(view().queryByTestId("external-change")).toBeNull());
    // Let the refresh finish before choosing a chapter: its load ends by selecting the open one again.
    await testing.waitFor(() => expect(workspace.loads()).toBeGreaterThan(loaded));
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The rail counts the other writer's words once the refreshed book is in.
    const row = view().getAllByTestId("chapter-row")[1];
    if (!row) throw new Error("the rail lost chapter two");
    expect(row.textContent ?? "").toContain("8 words");
    testing.fireEvent.click(row);
    await testing.waitFor(() => expect(editorText()).toContain("A paragraph from another writer."));

    type("Mara walked faster.\n");
    await testing.waitFor(
      async () => {
        expect(await chapterFile(workspace, second)).toContain("Mara walked faster.");
      },
      { timeout: 3000 }
    );
    const saved = await library.readChapter(bookId, second.id);
    expect(saved.content).toContain("A paragraph from another writer.");
    expect(await library.listConflicts(bookId)).toHaveLength(0);
    expect(workspace.notices).toEqual([]);
  }, 15_000);
});

/** Type `text` one key at a time, `gapMs` apart, and return when the last key landed. */
async function typeKeys(text: string, gapMs: number): Promise<number> {
  for (const [index, key] of [...text].entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
    await testing.act(async () => {
      type(key);
    });
  }
  return Date.now();
}

describe("words typed just before a quit reach the file (A1)", () => {
  test("a sentence typed at a normal pace and quit within 50 ms of the last key is saved", async () => {
    const workspace = await mountWorkspace();
    const { library, bookId, first } = workspace;

    // A key every 60 ms restarts both the 300 ms draft copy and the 700 ms autosave, so neither
    // has run when the author quits.
    const lastKey = await typeKeys("The road showed.", 60);
    expect(workspace.drafts.size).toBe(0);
    const sinceLastKey = Date.now() - lastKey;
    await workspace.quit();
    expect(sinceLastKey).toBeLessThan(50);

    const saved = await library.readChapter(bookId, first.id);
    expect(saved.content).toBe("The tide was out.\nThe road showed.\n");
    expect(saved.version).toBe(first.version + 1);
    expect(await library.listConflicts(bookId)).toHaveLength(0);
    expect(workspace.notices).toEqual([]);
  }, 15_000);

  test("a quit while an autosave is still in flight saves the newest words, not a conflict copy", async () => {
    const workspace = await mountWorkspace({ saveDelayMs: 200 });
    const { library, bookId, first } = workspace;

    type("The road showed.");
    // The autosave starts after 700 ms and is still on its way when the author types on and quits.
    await new Promise((resolve) => setTimeout(resolve, 760));
    const lastKey = await typeKeys(" Mara ran.", 5);
    const sinceLastKey = Date.now() - lastKey;
    await workspace.quit();
    expect(sinceLastKey).toBeLessThan(50);

    const saved = await library.readChapter(bookId, first.id);
    expect(saved.content).toBe("The tide was out.\nThe road showed. Mara ran.\n");
    expect(saved.version).toBe(first.version + 2);
    expect(await library.listConflicts(bookId)).toHaveLength(0);
    expect(workspace.notices).toEqual([]);
  }, 15_000);
});

/** The conflict copies in the book's folder, sorted by name. */
async function conflictFiles(workspace: Workspace): Promise<string[]> {
  const names = await readdir(join(workspace.root, "books", workspace.bookId, "conflicts")).catch(() => []);
  return names.filter((name) => name.endsWith(".md")).sort();
}

async function conflictText(workspace: Workspace, name: string): Promise<string> {
  return readFile(join(workspace.root, "books", workspace.bookId, "conflicts", name), "utf8");
}

/** Another writer, such as the CLI, saves the open chapter before the editor's autosave runs. */
async function outsideSave(workspace: Workspace): Promise<void> {
  const { library, bookId, first } = workspace;
  const saved = await library.saveChapter(bookId, first.id, "The tide was out.\nThe gulls came back.\n", {
    baseVersion: first.version,
    baseHash: first.hash
  });
  expect(saved.status).toBe("saved");
}

async function settle(ms: number): Promise<void> {
  await testing.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/*
 * QA C4: one conflicted edit wrote three identical copies. The editor kept the author's draft after
 * the conflict, so the remount for "Load the version on disk" saved the same words again, and the main
 * process saved its leftover draft once more at quit.
 */
describe("a conflicted edit keeps one copy (C4)", () => {
  test("loading the version on disk and quitting add no copy, and the banner counts the copies on disk", async () => {
    const workspace = await mountWorkspace();
    const { library, bookId, first } = workspace;

    type("Mara wrote on.\n");
    await outsideSave(workspace);
    await testing.waitFor(() => expect(view().getByText("This chapter was saved somewhere else")).toBeTruthy(), {
      timeout: 3000
    });
    const copies = await conflictFiles(workspace);
    expect(copies).toHaveLength(1);
    expect(await conflictText(workspace, copies[0] ?? "")).toContain("Mara wrote on.");

    testing.fireEvent.click(view().getByText("Load the version on disk"));
    await testing.waitFor(() => expect(editorText()).toBe("The tide was out.\nThe gulls came back.\n"), { timeout: 3000 });
    await settle(150);
    expect(await conflictFiles(workspace)).toEqual(copies);
    expect(view().getByText("1 saved copy from earlier sync conflicts.")).toBeTruthy();

    await workspace.quit();
    expect(await conflictFiles(workspace)).toEqual(copies);
    expect((await library.readChapter(bookId, first.id)).content).toBe("The tide was out.\nThe gulls came back.\n");
    expect(workspace.notices).toEqual([]);
  }, 15_000);

  test("quitting and closing with the conflict still showing write no second copy", async () => {
    const workspace = await mountWorkspace();

    type("Mara wrote on.\n");
    await outsideSave(workspace);
    await testing.waitFor(() => expect(view().getByText("This chapter was saved somewhere else")).toBeTruthy(), {
      timeout: 3000
    });
    const copies = await conflictFiles(workspace);
    expect(copies).toHaveLength(1);

    await workspace.quit();
    expect(await conflictFiles(workspace)).toEqual(copies);
    // Closing the window unmounts the editor, which saves any words it still holds.
    testing.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await conflictFiles(workspace)).toEqual(copies);
  }, 15_000);

  test("a save that conflicts before the draft copy is taken leaves no draft to save again at quit", async () => {
    const workspace = await mountWorkspace();

    type("Mara wrote on.\n");
    await outsideSave(workspace);
    // Leaving the text saves at once, before the 300 ms draft copy.
    testing.fireEvent.blur(view().getByTestId("manuscript-text"));
    await testing.waitFor(() => expect(view().getByText("This chapter was saved somewhere else")).toBeTruthy(), {
      timeout: 3000
    });
    await settle(400);
    expect(workspace.drafts.size).toBe(0);

    await workspace.quit();
    expect(await conflictFiles(workspace)).toHaveLength(1);
  }, 15_000);

  test("words typed after the conflict are kept in one more copy, which the banner counts", async () => {
    const workspace = await mountWorkspace();

    type("Mara wrote on.\n");
    await outsideSave(workspace);
    await testing.waitFor(() => expect(view().getByText("This chapter was saved somewhere else")).toBeTruthy(), {
      timeout: 3000
    });
    const [firstCopy] = await conflictFiles(workspace);

    // The author writes on in the conflicted editor; those words are new, so they get a copy of their own.
    type("She stopped at the gate.\n");
    await testing.waitFor(
      async () => {
        expect(await conflictFiles(workspace)).toHaveLength(2);
      },
      { timeout: 3000 }
    );
    const copies = await conflictFiles(workspace);
    const newest = copies.find((name) => name !== firstCopy) ?? "";
    expect(await conflictText(workspace, newest)).toContain("She stopped at the gate.");
    await testing.waitFor(() => expect(view().getByText("This chapter was saved somewhere else")).toBeTruthy(), {
      timeout: 3000
    });

    testing.fireEvent.click(view().getByText("Load the version on disk"));
    await testing.waitFor(() => expect(editorText()).toBe("The tide was out.\nThe gulls came back.\n"), { timeout: 3000 });
    await settle(150);
    expect(await conflictFiles(workspace)).toEqual(copies);
    expect(view().getByText("2 saved copies from earlier sync conflicts.")).toBeTruthy();

    await workspace.quit();
    expect(await conflictFiles(workspace)).toEqual(copies);
  }, 15_000);
});

/*
 * QA Q13: an approved overwrite that found the chapter saved during its pause keeps its text as a
 * conflict copy. The chat says so on the step, and the workspace counts the copy before the turn ends.
 */
describe("a refused overwrite's copy is counted at once (Q13)", () => {
  test("the banner counts the copy while the turn is still running, and the chapter keeps the author's words", async () => {
    const workspace = await mountWorkspace();
    const { library, bookId, first } = workspace;

    await runTurn(workspace, async () => {
      // What the overwrite's checked save does when the chapter moved on during the pause.
      const kept = await library.saveChapter(bookId, first.id, "The lamp was out.\n", {
        baseVersion: first.version - 1,
        baseHash: first.hash
      });
      if (kept.status !== "conflict") throw new Error("The overwrite should have kept a conflict copy.");
      await testing.act(async () => {
        workspace.emitAgent({
          type: "tool",
          turnId: TURN,
          id: "call_1",
          name: "overwrite_chapter",
          status: "end",
          output: {
            ok: false,
            message: "“One” changed since you read it, so nothing was overwritten.",
            chapterId: first.id,
            savedAs: kept.conflict.savedAs,
            changedSinceRead: true
          }
        });
      });
      await testing.waitFor(() => expect(view().getByText("1 saved copy from earlier sync conflicts.")).toBeTruthy(), {
        timeout: 2000
      });
      expect(view().getByText("Left the chapter as you wrote it. The replacement is kept as a conflict copy.")).toBeTruthy();
    });

    expect(editorText()).toBe("The tide was out.\n");
    expect(await conflictFiles(workspace)).toHaveLength(1);
    expect(workspace.notices).toEqual([]);
  }, 15_000);
});
