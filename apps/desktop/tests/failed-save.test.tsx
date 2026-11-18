/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import type { DraftInput, SaveChapterInput } from "@ai-book-studio/core/ipc";
import { LibraryPortError } from "@ai-book-studio/core/library/errors";
import type { Chapter, ChapterConflict } from "@ai-book-studio/core/schema";
import type { EditorHandle, SaveStatus } from "@ai-book-studio/app/components/ManuscriptEditor";
import { DraftBuffer } from "../src/main/drafts";
import { ExitGuard } from "../src/main/exit-guard";
import { Library } from "../src/main/library/store";
import { RecoveryStore, restoreKept } from "../src/main/recovery";
import { Studio } from "../src/main/studio";
import { createFlushRequests } from "../src/preload/flush-requests";
import { mountDom, unmountDom } from "./support/dom";

let testing!: typeof import("@testing-library/react/pure");
let WorkspaceView!: typeof import("@ai-book-studio/app/views/WorkspaceView").WorkspaceView;
let ManuscriptEditor!: typeof import("@ai-book-studio/app/components/ManuscriptEditor").ManuscriptEditor;

beforeAll(async () => {
  testing = await mountDom();
  ({ WorkspaceView } = await import("@ai-book-studio/app/views/WorkspaceView"));
  ({ ManuscriptEditor } = await import("@ai-book-studio/app/components/ManuscriptEditor"));
});
afterAll(async () => {
  await unmountDom();
});

const cleanups: Array<() => Promise<unknown> | void> = [];

afterEach(async () => {
  testing.cleanup();
  // The editor saves on unmount; let that land before its library folder goes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/*
 * What the author sees when a save fails (spec 002 FR-012), and what happens to the words when a close
 * or quit cannot save them (FR-013). The workspace and the editor are the real components; the bridge
 * behind them answers from a real library and a real recovery store in temporary folders, the way the
 * main process does, and a full disk is a library that refuses every chapter write.
 */

const FULL = "The disk is full. Nothing was replaced.";

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

/** What the IPC layer answers when the library throws. */
function refused(error: unknown): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: "io", message: error instanceof Error ? error.message : String(error) } };
}

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface Setup {
  root: string;
  library: Library;
  store: RecoveryStore;
  bookId: string;
  one: Chapter;
  /** Set to make the library refuse every chapter write, as a full disk does. */
  disk: { full: boolean };
}

async function setup(): Promise<Setup> {
  const root = await temp("studio-failed-save-library-");
  const profile = await temp("studio-failed-save-profile-");
  const library = await Library.open(root);
  const book = await library.createBook({ title: "The Salt Road" });
  const one = await library.createChapter(book.id, { title: "One", content: "The tide was out.\n" });
  const disk = { full: false };
  const save = library.saveChapter.bind(library);
  const refuse = spyOn(library, "saveChapter").mockImplementation((...args) =>
    disk.full ? Promise.reject(new LibraryPortError("storage-full", FULL, true)) : save(...args)
  );
  cleanups.push(() => refuse.mockRestore());
  return { root, library, store: new RecoveryStore(join(profile, "recovery")), bookId: book.id, one, disk };
}

interface Workspace {
  drafts: DraftBuffer;
  notices: string[];
  /** How many chapter saves the editor sent. */
  saves: () => number;
  /** A quit in a hidden run: the window is asked for its newest text, then what is left is kept. */
  quit: () => Promise<"stay" | "leave">;
}

/** One launch of the studio over the library and its profile: a fresh draft buffer, the same store. */
async function mountWorkspace({ root, library, store, bookId }: Setup): Promise<Workspace> {
  const drafts = new DraftBuffer();
  const flushRequests = createFlushRequests((requestId) => drafts.answered(requestId));
  const studio = new Studio({} as never, drafts, store);
  studio.library = library;
  const notices: string[] = [];
  let saves = 0;

  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    books: { open: async (id: string) => ok(await library.readBook(id)) },
    chapters: {
      save: async (input: SaveChapterInput) => {
        saves += 1;
        try {
          return ok(
            await library.saveChapter(input.bookId, input.chapterId, input.content, {
              baseVersion: input.baseVersion,
              baseHash: input.baseHash
            })
          );
        } catch (error) {
          return refused(error);
        }
      },
      create: async (id: string) => ok(await library.createChapter(id, {})),
      reorder: mock(async () => ok({ status: "saved", chapters: [] })),
      move: mock(async () => ok({ status: "saved", chapters: [] })),
      delete: mock(async () => ok(null))
    },
    conflicts: {
      list: async (id: string) => ok(await library.listConflicts(id)),
      reveal: mock(async () => ok(null))
    },
    drafts: {
      set: async (input: DraftInput) => {
        drafts.set(input);
        return ok(null);
      },
      clear: async (id: string, chapterId: string) => {
        drafts.clear(id, chapterId);
        return ok(null);
      },
      onFlushRequest: (handler: () => Promise<unknown>) => flushRequests.subscribe(handler)
    },
    recovery: {
      list: async (id: string) => ok(await store.list(id)),
      restore: async (id: string) => {
        try {
          return ok(await restoreKept(store, library, id));
        } catch (error) {
          return refused(error);
        }
      },
      discard: async (id: string) => {
        await store.remove(id);
        return ok(null);
      }
    },
    images: { list: async () => ok({ manifest: { images: [] } }) },
    library: { onChange: () => () => {} },
    agent: {
      onEvent: () => () => {},
      // Without a status the ambient strip stays on "Looking at your book…".
      ambient: async () => ok(null),
      start: mock(async () => ok({ turnId: "turn_failed0001", threadId: "thread_failed0001" })),
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
      bookId,
      theme: { choice: "light" as const, set: () => {}, cycle: () => {} },
      libraryRoot: root,
      libraryStorage: undefined,
      onBack: () => {},
      onNotice: (notice: unknown) => notices.push(notice instanceof Error ? notice.message : String(notice)),
      onSchemaRefusal: () => {}
    })
  );
  // The chapter as it is on disk now, which another writer may have changed before this launch.
  const opened = (await library.readChapter(bookId, (await library.readBook(bookId)).chapters[0]!.id)).content;
  await testing.waitFor(() => expect(editorText()).toBe(opened));
  return {
    drafts,
    notices,
    saves: () => saves,
    quit: () =>
      new ExitGuard(studio, { headless: true, ask: async () => 0 }).check(
        {
          isDestroyed: () => false,
          isCrashed: () => false,
          send: (_channel, request) => void flushRequests.handle(request.requestId)
        },
        "quit"
      )
  };
}

function view(): ReturnType<typeof testing.within> {
  return testing.within(document.body);
}

function editorText(): string {
  return (view().getByTestId("manuscript-text") as HTMLTextAreaElement).value;
}

/**
 * Whether an element is on the page. Inside `waitFor` this beats `expect(element).toBeNull()`: each
 * failed try of that prints the whole element, which takes long enough to stall the timers it waits on.
 */
function shown(testId: string): boolean {
  return view().queryByTestId(testId) !== null;
}

function type(text: string): void {
  testing.fireEvent.change(view().getByTestId("manuscript-text"), { target: { value: editorText() + text } });
}

function saveStatus(): { text: string; label: string } {
  const status = view().getByTestId("save-status");
  return { text: status.textContent ?? "", label: status.getAttribute("aria-label") ?? "" };
}

async function chapterFile(at: Setup): Promise<string> {
  return readFile(join(at.root, "books", at.bookId, "chapters", at.one.path), "utf8");
}

/** Run with the expected warnings and the hidden run's log line silenced. */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    return await run();
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
}

describe("the save status after a failed save (D8)", () => {
  test(
    "a failed save names the reason, tries again by itself, and says when it worked",
    async () => {
      const at = await setup();
      at.disk.full = true;
      const workspace = await mountWorkspace(at);

      type(" The road showed.");
      await testing.waitFor(() => expect(saveStatus().text).toContain(FULL), { timeout: 2_000 });
      expect(saveStatus().text.startsWith("Not saved")).toBe(true);
      expect(saveStatus().label).toBe(
        `Not saved. ${FULL} Your words are still here, and the studio keeps trying to save them.`
      );
      const failed = workspace.saves();

      // The disk has room again. Nobody types: the retry alone saves the words.
      at.disk.full = false;
      await testing.waitFor(() => expect(saveStatus().text).toBe("Saved after retrying"), { timeout: 4_000 });
      expect(workspace.saves()).toBe(failed + 1);
      expect(saveStatus().label.startsWith("Saved ")).toBe(true);
      expect(saveStatus().label.endsWith(" after retrying")).toBe(true);
      expect(await chapterFile(at)).toContain("The tide was out.\n The road showed.");
      expect(shown("save-problem")).toBe(false);

      // A conflict is not a failure: another writer saves first, and the status reads only Not saved.
      const disk = await at.library.readChapter(at.bookId, at.one.id);
      await at.library.saveChapter(at.bookId, at.one.id, "Their version of the tide.\n", {
        baseVersion: disk.version,
        baseHash: disk.hash
      });
      type(" My version.");
      await testing.waitFor(() => expect(saveStatus().text).toBe("Not saved"), { timeout: 2_000 });
      expect(shown("save-problem")).toBe(false);
    },
    { timeout: 10_000 }
  );

  test(
    "a chapter file that went missing is named in plain words, never by its id",
    async () => {
      const at = await setup();
      await mountWorkspace(at);
      const file = join(at.root, "books", at.bookId, "chapters", at.one.path);
      await rename(file, `${file}.away`);
      cleanups.push(() => rename(`${file}.away`, file).catch(() => {}));

      type(" The road showed.");
      const plain = "This chapter's file is not in your library folder. It may have been moved, renamed or deleted.";
      await testing.waitFor(() => expect(saveStatus().text).toContain(plain), { timeout: 2_000 });
      expect(saveStatus().label).toContain(plain);
      expect(saveStatus().label).not.toContain(at.one.id);

      // The file comes back, as a sync service puts it back, and the retry saves the words.
      await rename(`${file}.away`, file);
      await testing.waitFor(() => expect(saveStatus().text).toBe("Saved after retrying"), { timeout: 4_000 });
      expect(await chapterFile(at)).toContain("The tide was out.\n The road showed.");
    },
    { timeout: 10_000 }
  );
});

describe("the editor's retry and its flush before a close or quit", () => {
  const BOOK = "book_retry000001";
  const CHAPTER: Chapter = {
    id: "ch_retry0000001",
    title: "One",
    order: 1,
    arc: "middle",
    purpose: "",
    synopsis: "",
    notes: "",
    isPrologue: false,
    color: null,
    version: 3,
    createdAt: "2026-11-04T07:00:00.000Z",
    updatedAt: "2026-11-04T07:00:00.000Z",
    content: "Original.\n",
    path: "0001-one.md",
    wordCount: 1,
    hash: "c".repeat(64)
  };
  const SAVED: Chapter = { ...CHAPTER, version: 4, content: "Original.\nNew words.", hash: "d".repeat(64) };

  function mountEditor(replies: unknown[], retryDelaysMs: number[]) {
    const times: number[] = [];
    const save = mock(async () => {
      times.push(Date.now());
      return replies.shift() ?? replies.at(-1);
    });
    const setDraft = mock(async (_input: DraftInput) => ok(null));
    const answered: string[] = [];
    const flushRequests = createFlushRequests((requestId) => answered.push(requestId));
    (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
      chapters: { save, updateMeta: mock(async () => ok(null)) },
      drafts: {
        set: setDraft,
        clear: mock(async () => ok(null)),
        onFlushRequest: (handler: () => Promise<unknown>) => flushRequests.subscribe(handler)
      }
    };
    const statuses: SaveStatus[] = [];
    const editor = React.createRef<EditorHandle>();
    testing.render(
      React.createElement(ManuscriptEditor, {
        ref: editor,
        bookId: BOOK,
        chapter: CHAPTER,
        ordinal: 1,
        onSaved: () => {},
        onStatus: (status: SaveStatus) => statuses.push(status),
        retryDelaysMs
      })
    );
    return { save, times, setDraft, answered, flushRequests, statuses, editor };
  }

  const failure = { ok: false, error: { code: "io", message: FULL } };
  const conflict: ChapterConflict = {
    bookId: BOOK,
    chapterId: CHAPTER.id,
    chapterTitle: CHAPTER.title,
    savedAs: "books/book_retry000001/conflicts/0001-one.conflict-newer-version.md",
    reason: "newer-version",
    diskVersion: 5,
    localVersion: 5
  };

  test("each retry waits longer than the last, they stop once a save lands, and a conflict is never retried", async () => {
    const delays = [40, 80, 160];
    const { save, times, statuses, editor } = mountEditor(
      [failure, failure, failure, ok({ status: "saved", chapter: SAVED }), ok({ status: "conflict", conflict })],
      delays
    );

    type("New words.");
    await testing.act(async () => {
      await editor.current!.flush();
    });
    await testing.waitFor(() => expect(save).toHaveBeenCalledTimes(4), { timeout: 2_000 });
    // Timers never fire early; a little slack covers rounding to the millisecond.
    for (const [index, delay] of delays.entries()) {
      expect(times[index + 1]! - times[index]!).toBeGreaterThanOrEqual(delay - 2);
    }
    await testing.waitFor(() => expect(statuses.at(-1)).toMatchObject({ kind: "saved", afterRetry: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(save).toHaveBeenCalledTimes(4);

    // Another writer got there first: the author resolves a conflict, so nothing tries again.
    type(" More words.");
    await testing.act(async () => {
      await editor.current!.flush();
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(save).toHaveBeenCalledTimes(5);
    expect(statuses.at(-1)?.kind).toBe("conflict");
  });

  test("a close or quit whose save fails hands the newest words to the main process", async () => {
    const { setDraft, answered, flushRequests } = mountEditor([failure], [60_000]);

    // Typed and closed at once: the 300 ms draft copy has not gone yet.
    type("New words.");
    await testing.act(async () => {
      await flushRequests.handle("flush-1");
    });

    expect(answered).toEqual(["flush-1"]);
    expect(setDraft).toHaveBeenCalledTimes(1);
    expect(setDraft.mock.calls[0]?.[0]).toEqual({
      bookId: BOOK,
      chapterId: CHAPTER.id,
      content: "Original.\nNew words.",
      baseVersion: CHAPTER.version,
      baseHash: CHAPTER.hash
    });
  });
});

describe("words kept from a failed close or quit (D2)", () => {
  test("a quit on a full disk keeps the newest words, and the next launch offers them back", async () => {
    const at = await setup();
    at.disk.full = true;
    const before = await chapterFile(at);
    const first = await mountWorkspace(at);

    // Typed just before quitting, with no pause for the draft copy.
    type(" The road showed, and the gulls came back.");
    expect(await quietly(() => first.quit())).toBe("leave");

    const kept = await at.store.all();
    expect(kept.map((entry) => entry.content)).toEqual(["The tide was out.\n The road showed, and the gulls came back."]);
    expect(kept[0]).toMatchObject({ bookId: at.bookId, chapterId: at.one.id, baseVersion: at.one.version, baseHash: at.one.hash, reason: FULL });
    expect(await chapterFile(at)).toBe(before);
    expect(first.drafts.size).toBe(0);

    // The app is gone. Its editor's last save on the way out fails on the same full disk.
    await quietly(async () => {
      testing.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    at.disk.full = false;
    const second = await mountWorkspace(at);

    const offer = await testing.waitFor(() => view().getByTestId("recovery-offer"));
    expect(offer.textContent).toContain("Words the studio could not save");
    expect(testing.within(offer).getByTestId("recovered-draft").textContent).toContain("One");
    expect(testing.within(offer).getByTestId("recovered-draft").textContent).toContain("the gulls came back.");
    // Nothing goes back until the author asks.
    expect(await chapterFile(at)).toBe(before);

    testing.fireEvent.click(view().getByTestId("recovery-restore"));
    await testing.waitFor(() => expect(second.notices).toContain("Your words are back in “One”."));
    expect(await chapterFile(at)).toContain("The tide was out.\n The road showed, and the gulls came back.");
    await testing.waitFor(() => expect(editorText()).toContain("and the gulls came back."));
    expect(shown("recovery-offer")).toBe(false);
    expect(await at.library.listConflicts(at.bookId)).toEqual([]);
    expect(await at.store.all()).toEqual([]);
  });

  test("kept words typed on an older version become a conflict copy, and the workspace says so", async () => {
    const at = await setup();
    await at.store.keep(
      { bookId: at.bookId, chapterId: at.one.id, content: "My kept version of the tide.\n", baseVersion: at.one.version, baseHash: at.one.hash },
      FULL,
      at.root
    );
    await at.library.saveChapter(at.bookId, at.one.id, "Their version of the tide.\n", {
      baseVersion: at.one.version,
      baseHash: at.one.hash
    });
    const workspace = await mountWorkspace(at);

    testing.fireEvent.click(await testing.waitFor(() => view().getByTestId("recovery-restore")));

    await testing.waitFor(() =>
      expect(workspace.notices).toContain(
        "“One” changed after you typed these words, so they were kept as a separate copy instead of replacing it."
      )
    );
    expect(await chapterFile(at)).toContain("Their version of the tide.");
    const [copy] = await at.library.listConflicts(at.bookId);
    expect(await readFile(join(at.root, copy!.savedAs), "utf8")).toContain("My kept version of the tide.");
    await testing.waitFor(() => expect(shown("recovery-offer")).toBe(false));
    expect(await at.store.all()).toEqual([]);
  });

  test("discarding asks first, and only the author's confirmation lets the words go", async () => {
    const at = await setup();
    const kept = await at.store.keep(
      { bookId: at.bookId, chapterId: at.one.id, content: "Words to let go.\n", baseVersion: at.one.version, baseHash: at.one.hash },
      FULL,
      at.root
    );
    await mountWorkspace(at);

    testing.fireEvent.click(await testing.waitFor(() => view().getByTestId("recovery-discard")));
    await testing.waitFor(() => expect(view().getByText("Discard these words?")).toBeTruthy());
    testing.fireEvent.click(view().getByRole("button", { name: "Keep words" }));
    await testing.waitFor(() => expect(view().queryByText("Discard these words?") !== null).toBe(false));
    expect(await at.store.read(kept.id)).not.toBeNull();

    testing.fireEvent.click(view().getByTestId("recovery-discard"));
    testing.fireEvent.click(await testing.waitFor(() => view().getByTestId("recovery-discard-confirm")));
    await testing.waitFor(() => expect(shown("recovery-offer")).toBe(false));
    expect(await at.store.read(kept.id)).toBeNull();
    // Discarding never touches the library.
    expect(await chapterFile(at)).not.toContain("Words to let go.");
    expect(await at.library.listConflicts(at.bookId)).toEqual([]);
  });

  test("a restore that still cannot write keeps the words and says why", async () => {
    const at = await setup();
    const kept = await at.store.keep(
      { bookId: at.bookId, chapterId: at.one.id, content: "Still waiting for room.\n", baseVersion: at.one.version, baseHash: at.one.hash },
      FULL,
      at.root
    );
    at.disk.full = true;
    const workspace = await mountWorkspace(at);

    testing.fireEvent.click(await testing.waitFor(() => view().getByTestId("recovery-restore")));

    await testing.waitFor(() =>
      expect(workspace.notices).toContain(`Your words are still kept, because they could not be restored. ${FULL}`)
    );
    expect(view().getByTestId("recovery-offer")).toBeTruthy();
    expect((await at.store.read(kept.id))?.content).toBe("Still waiting for room.\n");
  });

  test("words kept for a chapter that is gone stay kept, and the reason is in plain words", async () => {
    const at = await setup();
    const kept = await at.store.keep(
      { bookId: at.bookId, chapterId: "ch_gone00000001", content: "Words for a lost chapter.\n", baseVersion: 1, baseHash: "e".repeat(64) },
      FULL,
      at.root
    );
    const workspace = await mountWorkspace(at);

    const offer = await testing.waitFor(() => view().getByTestId("recovery-offer"));
    expect(offer.textContent).toContain("A chapter that is no longer in this book");
    testing.fireEvent.click(view().getByTestId("recovery-restore"));

    await testing.waitFor(() =>
      expect(workspace.notices).toContain(
        "Your words are still kept, because they could not be restored. This chapter's file is not in your library folder. It may have been moved, renamed or deleted."
      )
    );
    expect(workspace.notices.join("\n")).not.toContain("ch_gone00000001");
    expect((await at.store.read(kept.id))?.content).toBe("Words for a lost chapter.\n");
  });
});
