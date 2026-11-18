import "fake-indexeddb/auto";
import { afterEach, describe, expect, test } from "bun:test";
import type { Result, StudioApi } from "@ai-book-studio/core/ipc";
import { PROVIDER_LIST } from "@ai-book-studio/core/providers/registry";
import { createBrowserStudioApi } from "../../src/runtime/browser-api";
import { BrowserLibraries } from "../../src/runtime/browser-libraries";
import { FakeDirectory } from "./support/fake-directory";

/**
 * The browser build's `window.studio`, driven end to end over site storage.
 *
 * The web app is a real target: a book written here must save, conflict, reopen and report exactly
 * as it does on the desktop. Everything the browser cannot do yet (the agent, Word export,
 * illustrations, voice) must say so in plain words instead of pretending. These checks walk every
 * surface the renderer calls, the way an author's session would.
 */

type Global = { navigator?: unknown; isSecureContext?: boolean };
const globals = globalThis as Global;
const originalNavigator = globals.navigator;
const originalSecure = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");

afterEach(() => {
  if (originalNavigator === undefined) delete globals.navigator;
  else globals.navigator = originalNavigator;
  if (originalSecure) Object.defineProperty(globalThis, "isSecureContext", originalSecure);
});

function withOriginStorage(): FakeDirectory {
  const root = new FakeDirectory("root");
  Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
  globals.navigator = {
    storage: {
      getDirectory: async () => root,
      persist: async () => true,
      estimate: async () => ({ usage: 0, quota: 1_000_000 })
    }
  };
  return root;
}

async function openStudio(): Promise<{ libraries: BrowserLibraries; studio: StudioApi }> {
  withOriginStorage();
  const libraries = new BrowserLibraries();
  await libraries.openBrowserStorage();
  return { libraries, studio: createBrowserStudioApi(libraries) };
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.data;
}

/** Creates a chapter through the contract (title only), then saves its text with a checked save. */
async function chapterWith(studio: StudioApi, bookId: string, title: string, content: string) {
  const created = value(await studio.chapters.create(bookId, { title }));
  const saved = value(
    await studio.chapters.save({
      bookId,
      chapterId: created.id,
      content,
      baseVersion: created.version,
      baseHash: created.hash
    })
  );
  if (saved.status !== "saved") throw new Error("the first save of a new chapter conflicted");
  return saved.chapter;
}

function refusal(result: Result<unknown>): string {
  if (result.ok) throw new Error("expected a refusal, got success");
  expect(result.error.message.length).toBeGreaterThan(0);
  return result.error.message;
}

describe("before a library is open", () => {
  test("nothing is open, and using a book says what to do first", async () => {
    const studio = createBrowserStudioApi(new BrowserLibraries());
    expect(value(await studio.library.current())).toBeNull();
    const listed = await studio.books.list();
    expect(listed.ok).toBe(false);
    if (!listed.ok) {
      expect(listed.error.code).toBe("not-found");
      expect(listed.error.message).toContain("Choose where to keep it first");
    }
  });
});

describe("a book written in the browser", () => {
  test("is created, renamed, searched and reopened from site storage", async () => {
    const { studio } = await openStudio();
    expect(value(await studio.library.current())).not.toBeNull();

    const book = value(await studio.books.create({ title: "The Salt Road", description: "A crossing." }));
    expect(value(await studio.books.list()).map((entry) => entry.id)).toContain(book.id);

    const renamed = value(await studio.books.update(book.id, { title: "The Salt Road, again" }));
    expect(renamed.title).toBe("The Salt Road, again");

    const chapter = await chapterWith(studio, book.id, "The Door", "The tide came in at dusk.\n");
    const detail = value(await studio.books.open(book.id));
    expect(detail.chapters.map((entry) => entry.title)).toEqual(["The Door"]);

    const hits = value(await studio.books.search(book.id, "tide"));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chapterId).toBe(chapter.id);
  });

  test("a checked save lands, and a stale one keeps both texts as a conflict", async () => {
    const { studio } = await openStudio();
    const book = value(await studio.books.create({ title: "Conflicts" }));
    const chapter = await chapterWith(studio, book.id, "One", "First words.\n");

    const saved = value(
      await studio.chapters.save({
        bookId: book.id,
        chapterId: chapter.id,
        content: "First words, revised.\n",
        baseVersion: chapter.version,
        baseHash: chapter.hash
      })
    );
    expect(saved.status).toBe("saved");

    const stale = value(
      await studio.chapters.save({
        bookId: book.id,
        chapterId: chapter.id,
        content: "A writer who never saw the revision.\n",
        baseVersion: chapter.version,
        baseHash: chapter.hash
      })
    );
    expect(stale.status).toBe("conflict");

    const reopened = value(await studio.books.open(book.id));
    expect(reopened.chapters[0]?.content).toBe("First words, revised.\n");
    expect(value(await studio.conflicts.list(book.id)).length).toBeGreaterThan(0);
  });

  test("chapters are renamed, reordered, moved and deleted without losing the others", async () => {
    const { studio } = await openStudio();
    const book = value(await studio.books.create({ title: "Order" }));
    const first = await chapterWith(studio, book.id, "First", "One.\n");
    const second = await chapterWith(studio, book.id, "Second", "Two.\n");

    const retitled = value(
      await studio.chapters.updateMeta(book.id, first.id, { title: "Opening" }, {
        baseVersion: first.version,
        baseHash: first.hash
      })
    );
    expect(retitled.status).toBe("saved");
    if (retitled.status === "saved") expect(retitled.chapter.title).toBe("Opening");

    value(await studio.chapters.reorder(book.id, second.id, "up"));
    let order = value(await studio.books.open(book.id)).chapters.map((entry) => entry.title);
    expect(order).toEqual(["Second", "Opening"]);

    value(await studio.chapters.move(book.id, second.id, 1));
    order = value(await studio.books.open(book.id)).chapters.map((entry) => entry.title);
    expect(order).toEqual(["Opening", "Second"]);

    expect(value(await studio.chapters.delete(book.id, second.id))).toBeNull();
    order = value(await studio.books.open(book.id)).chapters.map((entry) => entry.title);
    expect(order).toEqual(["Opening"]);

    value(await studio.books.delete(book.id));
    expect(value(await studio.books.list()).map((entry) => entry.id)).not.toContain(book.id);
  });

  test("a held draft saves over unchanged disk text, and can be discarded", async () => {
    const { studio } = await openStudio();
    const book = value(await studio.books.create({ title: "Drafts" }));
    const chapter = await chapterWith(studio, book.id, "One", "Disk text.\n");

    expect(value(await studio.sync.keepMine(book.id, chapter.id))).toBeNull();

    value(
      await studio.drafts.set({
        bookId: book.id,
        chapterId: chapter.id,
        content: "Typed while the save was pending.\n",
        baseVersion: chapter.version,
        baseHash: chapter.hash
      })
    );
    const kept = value(await studio.sync.keepMine(book.id, chapter.id));
    expect(kept?.status).toBe("saved");
    expect(value(await studio.books.open(book.id)).chapters[0]?.content).toBe("Typed while the save was pending.\n");

    value(
      await studio.drafts.set({
        bookId: book.id,
        chapterId: chapter.id,
        content: "Never kept.\n",
        baseVersion: chapter.version,
        baseHash: chapter.hash
      })
    );
    expect(value(await studio.sync.discardDraft(book.id, chapter.id))).toBeNull();
    expect(value(await studio.drafts.clear(book.id, chapter.id))).toBeNull();
    expect(value(await studio.sync.keepMine(book.id, chapter.id))).toBeNull();
  });

  test("a drift check over a quiet library reports nothing to review", async () => {
    const { studio } = await openStudio();
    const book = value(await studio.books.create({ title: "Quiet" }));
    await chapterWith(studio, book.id, "One", "Still.\n");
    const report = value(await studio.sync.check());
    expect(report === null || report.clean).toBe(true);
    expect(value(await studio.sync.accept([]))).not.toBeUndefined();
    expect(value(await studio.library.locationHealth())).toBeTruthy();
  });

  test("the minimal mode knows where the author is without the agent", async () => {
    const { studio } = await openStudio();
    const book = value(await studio.books.create({ title: "The Salt Road" }));
    await chapterWith(studio, book.id, "The Door", "One two three.\n");
    const status = value(await studio.agent.ambient(book.id));
    expect(status.book.title).toBe("The Salt Road");
    expect(status.chapter?.title).toBe("The Door");
    expect(status.working).toBe(false);
    expect(status.say).toContain("The Salt Road");
  });

  test("a missing book is reported as not found, not as a crash", async () => {
    const { studio } = await openStudio();
    const missing = await studio.books.open("book_doesnotexist");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(["not-found", "invalid"]).toContain(missing.error.code);
  });
});

describe("what the browser build cannot do yet says so plainly", () => {
  test("desktop-only book actions name the desktop app", async () => {
    const { studio } = await openStudio();
    expect(refusal(await studio.books.exportDocx("book_any"))).toContain("desktop app");
    expect(refusal(await studio.books.exportMarkdown("book_any"))).toContain("desktop app");
    expect(refusal(await studio.books.pickImportSource())).toContain("desktop app");
    expect(refusal(await studio.library.importLegacy())).toContain("desktop app");
  });

  test("folder windows and pickers explain the browser's way instead", async () => {
    const { studio } = await openStudio();
    expect(refusal(await studio.library.open("/somewhere"))).toContain("folder picker");
    expect(refusal(await studio.library.reveal())).toContain("Export an archive");
    expect(refusal(await studio.conflicts.reveal("book_any", "conflict.md"))).toContain("desktop app");
    expect(refusal(await studio.sync.settings())).toContain("desktop app");
    expect(refusal(await studio.sync.updateSettings({ checkIntervalMinutes: 5 }))).toContain("desktop app");
  });

  test("the writing agent and its tools point to the desktop app", async () => {
    const { studio } = await openStudio();
    const agent = studio.agent;
    const refusals = [
      await agent.start({ bookId: "book_any", prompt: "Draft the next scene." } as never),
      await agent.undoLast("book_any"),
      await agent.undoLast("book_any", "turn_any"),
      await agent.approve("book_any", "approval", true),
      await agent.refreshPlanGuidance({
        bookId: "book_any",
        threadId: "thread_any",
        planId: "plan_any",
        revision: 1,
        guidance: "Past tense."
      }),
      await agent.status("book_any"),
      await agent.setSettings("book_any", {} as never),
      await agent.glassesUrl(),
      await agent.bridge(),
      await agent.setBridge(true),
      await agent.choosePluginFolder(),
      await agent.setPluginFolder(null),
      await agent.threads.list("book_any"),
      await agent.threads.read("book_any", "thread_any"),
      await agent.threads.rename("book_any", "thread_any", "Renamed"),
      await agent.threads.remove("book_any", "thread_any"),
      await agent.threads.fork("book_any", "thread_any", "message_any")
    ];
    for (const result of refusals) expect(refusal(result)).toContain("desktop app");
    expect(value(await agent.stop("book_any"))).toBeNull();
    expect(studio.platform).toBe("web");
    expect(value(await studio.books.list())).toEqual([]);
  });

  test("illustrations and voice refuse with the reason", async () => {
    const { studio } = await openStudio();
    expect(value(await studio.images.list("book_any")).manifest.images).toEqual([]);
    expect(value(await studio.images.read("book_any", "img_any"))).toBeNull();
    for (const result of [
      await studio.images.generate({} as never),
      await studio.images.attach("book_any", "img_any", "ch_any"),
      await studio.images.remove("book_any", "img_any"),
      await studio.voice.transcribe({} as never),
      await studio.voice.speak({} as never),
      await studio.voice.cancel({ operationId: 1 })
    ]) {
      expect(refusal(result)).toContain("desktop app");
    }
    expect(value(await studio.voice.connections())).toEqual([]);
    expect(value(await studio.voice.speakers()).available).toBe(false);
  });

  test("connections are listed honestly, and manual keys and tests are refused", async () => {
    const { studio } = await openStudio();
    expect(value(await studio.providers.list())).toEqual(PROVIDER_LIST);
    expect(value(await studio.providers.models("conn_any"))).toEqual({ models: [], fetchedAt: null });
    expect(value(await studio.connections.list())).toEqual([]);
    expect(typeof value(await studio.connections.available())).toBe("boolean");
    expect(value(await studio.connections.status()).connections).toBe(0);
    expect(value(await studio.connections.check()).connections).toBe(0);
    expect(refusal(await studio.connections.addKey({} as never))).toContain("browser build");
    expect(refusal(await studio.connections.test("conn_any"))).toContain("browser build");
    expect(value(await studio.connections.cancelOpenRouter())).toBeNull();
    expect(value(await studio.connections.remove("conn_missing"))).toBeNull();
    const usage = value(await studio.usage.summary("book_any"));
    expect(usage.turns).toBe(0);
    expect(usage.costUsd).toBe(0);
  });

  test("the build names itself as the web build, and listeners can be removed", async () => {
    const { studio } = await openStudio();
    const info = value(await studio.app.info());
    expect(info.platform).toBe("web");
    expect(studio.platform).toBe("web");
    for (const unsubscribe of [
      studio.library.onChange(() => {}),
      studio.sync.onDrift(() => {}),
      studio.agent.onEvent(() => {}),
      studio.menu.onOpenLibrary(() => {})
    ]) {
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
    }
  });
});
