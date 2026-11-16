import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC, type Result, type StudioApi } from "@ai-book-studio/core/ipc";
import type { Chapter } from "@ai-book-studio/core/schema";
import { DraftBuffer } from "../src/main/drafts";
import { Library } from "../src/main/library/store";
import { RecoveryStore } from "../src/main/recovery";
import { mockElectron } from "./support/mock-electron";

/*
 * Saved chapter history across the preload bridge: Zod runs before the library
 * is opened, capture refuses a held draft or a kept failed flush without
 * writing, and list, read, and compare do not change chapter or history bytes.
 * Restore, undo, reconcile, and delete stay off this surface.
 */

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const roots: string[] = [];
let registerIpc!: typeof import("../src/main/ipc").registerIpc;
let exposed: StudioApi | null = null;

const sha256 = (bytes: Uint8Array | Buffer) => createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  mockElectron(tmpdir(), {
    handle: (channel, handler) => { handlers.set(channel, handler); },
    exposeInMainWorld: (_name, api) => { exposed = api as StudioApi; },
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) return Promise.reject(new Error(`No handler for ${channel}`));
      return handler({}, args[0]) as Promise<never>;
    }
  });
  ({ registerIpc } = await import("../src/main/ipc"));
  // The preload module is cached process-wide and may already have been
  // evaluated under another file's hooks; the query re-evaluates it under
  // this file's hooks so the exposed bridge is the one captured here.
  const preloadEntry: string = "../src/preload/index.ts?chapter-history";
  await import(preloadEntry);
});

afterAll(() => { mockElectron(tmpdir()); });
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function historyApi(): NonNullable<StudioApi["history"]> {
  if (!exposed?.history) throw new Error("Preload did not expose the history API");
  return exposed.history;
}

function register(library: Library | null, drafts = new DraftBuffer(), recoveryFolder?: string) {
  let libraryAccesses = 0;
  const recovery = new RecoveryStore(recoveryFolder ?? join(tmpdir(), "history-ipc-recovery-missing"));
  const studio = {
    library,
    drafts,
    recovery,
    requireLibrary() {
      libraryAccesses += 1;
      if (!this.library) throw new Error("No library is open. Choose a folder first.");
      return this.library;
    },
    current: () => null
  };
  registerIpc(
    studio as never, () => null, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, () => null,
    { status: null, start: async () => undefined, stop: async () => undefined } as never,
    () => false
  );
  return {
    drafts,
    recovery,
    accesses: () => libraryAccesses
  };
}

async function savedBook() {
  const root = await temp("chapter-history-ipc-");
  const library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic history book" });
  const chapter = await library.createChapter(book.id, { title: "Door", content: "Saved synthetic source" });
  const profile = await temp("chapter-history-ipc-profile-");
  const gate = register(library, new DraftBuffer(), join(profile, "recovery"));
  return { root, library, book, chapter, profile, ...gate };
}

function captureInput(bookId: string, chapter: Chapter) {
  return {
    bookId,
    chapterId: chapter.id,
    label: "Snapshot",
    source: { status: "saved" as const, version: chapter.version, hash: chapter.hash }
  };
}

async function digest(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function chapterFile(root: string, bookId: string, chapter: Chapter): string {
  return join(root, "books", bookId, "chapters", chapter.path);
}

function historyFile(root: string, bookId: string, chapterId: string, fileName: string): string {
  return join(root, "books", bookId, "history", chapterId, fileName);
}

describe("chapter history IPC", () => {
  test("capture, list, read, and compare use the preload bridge and leave the chapter unchanged", async () => {
    const { root, library, book, chapter } = await savedBook();
    const api = historyApi();
    const file = chapterFile(root, book.id, chapter);
    const before = await digest(file);
    const captured = await api.capture(captureInput(book.id, chapter));
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.data.fileName.endsWith(".md")).toBe(true);
    expect(captured.data.fileName.includes("/") || captured.data.fileName.includes("\\")).toBe(false);
    expect(JSON.stringify(captured.data)).not.toContain(library.root);
    expect(captured.data.meta.bookId).toBe(book.id);
    expect(captured.data.meta.chapterId).toBe(chapter.id);
    expect(captured.data.content).toBe(chapter.content);
    expect(await digest(file)).toBe(before);

    const scope = { bookId: book.id, chapterId: chapter.id };
    const address = { ...scope, fileName: captured.data.fileName };
    const stored = historyFile(root, book.id, chapter.id, captured.data.fileName);
    const historyBefore = await digest(stored);
    const drafts = new DraftBuffer();
    drafts.set({
      bookId: book.id,
      chapterId: chapter.id,
      content: "Unflushed draft that history must not save",
      baseVersion: chapter.version,
      baseHash: chapter.hash
    });
    const { accesses } = register(library, drafts, join(root, "unused-recovery"));
    const opened = accesses();
    const listed = await api.list(scope);
    const read = await api.read(address);
    const compared = await api.compare(address);
    expect(listed.ok && read.ok && compared.ok).toBe(true);
    if (!listed.ok || !read.ok || !compared.ok) return;
    expect(listed.data.records.map((record) => record.fileName)).toEqual([captured.data.fileName]);
    expect(listed.data.issues).toEqual([]);
    expect(read.data).toEqual(captured.data);
    expect(compared.data.basis).toBe("saved");
    expect(compared.data.equal).toBe(true);
    expect(compared.data.current.hash).toBe(chapter.hash);
    expect(compared.data.current.content).toBe(chapter.content);
    expect(await digest(file)).toBe(before);
    expect(await digest(stored)).toBe(historyBefore);
    expect(drafts.holds(book.id, chapter.id)).toBe(true);
    expect(accesses()).toBe(opened + 3);
    expect(JSON.stringify({ listed: listed.data, read: read.data, compared: compared.data })).not.toContain(library.root);
  });

  test("invalid book, chapter, label, and record identities are refused before the library is opened", async () => {
    const { accesses } = register(null);
    const bookId = "book_synthetic1";
    const chapterId = "ch_synthetic1";
    const hash = "a".repeat(64);
    const saved = { status: "saved", version: 1, hash };
    const refused: Array<[string, unknown]> = [
      [IPC.history.capture, null],
      [IPC.history.capture, 42],
      [IPC.history.capture, "../outside"],
      [IPC.history.capture, { bookId: "../outside", chapterId, label: "Snapshot", source: saved }],
      [IPC.history.capture, { bookId, chapterId: "../outside", label: "Snapshot", source: saved }],
      [IPC.history.capture, { bookId, chapterId, label: "", source: saved }],
      [IPC.history.capture, { bookId, chapterId, label: "Line\nbreak", source: saved }],
      [IPC.history.capture, { bookId, chapterId, label: "x".repeat(201), source: saved }],
      [IPC.history.capture, { bookId, chapterId, label: "Snapshot", source: { status: "draft", version: 1, hash } }],
      [IPC.history.capture, { bookId, chapterId, label: "Snapshot", source: saved, path: "/tmp/outside.md" }],
      [IPC.history.list, { bookId: "not-a-book", chapterId }],
      [IPC.history.list, { bookId, chapterId: "not-a-chapter" }],
      [IPC.history.list, { bookId, chapterId, fileName: "extra.md" }],
      [IPC.history.read, { bookId, chapterId, fileName: "../outside.md" }],
      [IPC.history.read, { bookId, chapterId, fileName: "nested/name.md" }],
      [IPC.history.read, { bookId, chapterId, fileName: ".hidden.md" }],
      [IPC.history.read, { bookId, chapterId, fileName: "no-extension" }],
      [IPC.history.read, { bookId: "../outside", chapterId, fileName: "record.md" }],
      [IPC.history.compare, { bookId, chapterId, fileName: "..\\outside.md" }],
      [IPC.history.compare, { bookId, chapterId: "../outside", fileName: "record.md" }]
    ];
    for (const [channel, payload] of refused) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing handler ${channel}`);
      const result = (await handler({}, payload)) as Result<unknown>;
      expect({ channel, payload: JSON.stringify(payload), ok: result.ok, code: result.ok ? null : result.error.code })
        .toEqual({ channel, payload: JSON.stringify(payload), ok: false, code: "invalid" });
    }
    expect(accesses()).toBe(0);
    expect(handlers.has("history:restore")).toBe(false);
    expect(handlers.has("history:undo")).toBe(false);
    expect(handlers.has("history:reconcile")).toBe(false);
    expect(handlers.has("history:delete")).toBe(false);
    expect(Object.keys(IPC.history).sort()).toEqual(["capture", "compare", "list", "read"]);
    expect(Object.keys(historyApi()).sort()).toEqual(["capture", "compare", "list", "read"]);
  });

  test("capture is refused while a draft or a kept failed flush is held, and writes nothing", async () => {
    const { root, library, book, chapter, drafts, recovery, accesses } = await savedBook();
    const api = historyApi();
    const file = chapterFile(root, book.id, chapter);
    const before = await digest(file);
    const input = captureInput(book.id, chapter);
    drafts.set({
      bookId: book.id,
      chapterId: chapter.id,
      content: "Still typing",
      baseVersion: chapter.version,
      baseHash: chapter.hash
    });
    const opened = accesses();
    const held = await api.capture(input);
    expect(held).toMatchObject({ ok: false, error: { code: "saved-source-required" } });
    if (held.ok) return;
    expect(held.error.message).not.toContain(library.root);
    expect(accesses()).toBe(opened);
    expect(await digest(file)).toBe(before);
    await expect(readdir(join(root, "books", book.id, "history"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(drafts.holds(book.id, chapter.id)).toBe(true);

    drafts.clear(book.id, chapter.id);
    await recovery.keep(
      { bookId: book.id, chapterId: chapter.id, content: "Could not flush", baseVersion: chapter.version, baseHash: chapter.hash },
      "the save failed",
      library.root
    );
    const kept = await api.capture(input);
    expect(kept).toMatchObject({ ok: false, error: { code: "saved-source-required" } });
    if (!kept.ok) expect(kept.error.message).not.toContain(library.root);
    expect(accesses()).toBe(opened);
    expect(await digest(file)).toBe(before);
    await expect(readdir(join(root, "books", book.id, "history"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a stale saved token, a missing record, and a corrupt or foreign record fail typed without a rewrite", async () => {
    const { root, library, book, chapter } = await savedBook();
    const api = historyApi();
    const captured = await api.capture(captureInput(book.id, chapter));
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const scope = { bookId: book.id, chapterId: chapter.id };
    const stored = historyFile(root, book.id, chapter.id, captured.data.fileName);
    const historyBefore = await readFile(stored);
    const saved = await library.saveChapter(book.id, chapter.id, "Changed after the token", {
      baseVersion: chapter.version,
      baseHash: chapter.hash
    });
    expect(saved.status).toBe("saved");
    const chapterAfterSave = await digest(chapterFile(root, book.id, chapter));
    const stale = await api.capture(captureInput(book.id, chapter));
    expect(stale).toMatchObject({ ok: false, error: { code: "stale-source" } });
    expect(await readFile(stored)).toEqual(historyBefore);
    expect(await digest(chapterFile(root, book.id, chapter))).toBe(chapterAfterSave);
    expect(await readdir(join(root, "books", book.id, "history", chapter.id))).toEqual([captured.data.fileName]);

    const original = historyBefore.toString("utf8");
    const damagedName = "damaged.md";
    const foreignName = "foreign.md";
    const damaged = Buffer.from(original.replace("Saved synthetic source", "Damaged synthetic source"));
    const foreign = Buffer.from(original.replace(book.id, "book_foreign1"));
    await writeFile(historyFile(root, book.id, chapter.id, damagedName), damaged);
    await writeFile(historyFile(root, book.id, chapter.id, foreignName), foreign);
    const missing = await api.read({ ...scope, fileName: "missing.md" });
    const corrupt = await api.read({ ...scope, fileName: damagedName });
    const identity = await api.read({ ...scope, fileName: foreignName });
    const corruptCompare = await api.compare({ ...scope, fileName: damagedName });
    const identityCompare = await api.compare({ ...scope, fileName: foreignName });
    expect(missing).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(corrupt).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(identity).toMatchObject({ ok: false, error: { code: "identity" } });
    expect(corruptCompare).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(identityCompare).toMatchObject({ ok: false, error: { code: "identity" } });
    for (const result of [missing, corrupt, identity, corruptCompare, identityCompare, stale]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).not.toContain(library.root);
        expect("stack" in result.error).toBe(false);
      }
    }
    expect(await readFile(historyFile(root, book.id, chapter.id, damagedName))).toEqual(damaged);
    expect(await readFile(historyFile(root, book.id, chapter.id, foreignName))).toEqual(foreign);
    expect(await readFile(stored)).toEqual(historyBefore);
    expect(await digest(chapterFile(root, book.id, chapter))).toBe(chapterAfterSave);
    const listed = await api.list(scope);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.records.map((record) => record.fileName)).toEqual([captured.data.fileName]);
    expect(listed.data.issues.map((issue) => [issue.fileName, issue.code]).sort()).toEqual([
      [damagedName, "corrupt"],
      [foreignName, "identity"]
    ]);
    await expect(readFile(historyFile(root, book.id, chapter.id, "missing.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
