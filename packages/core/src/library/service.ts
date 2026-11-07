import {
  bookSchema,
  chapterMetaSchema,
  SCHEMA_VERSION,
  type BookChanges,
  type BookDetail,
  type BookEditResult,
  type BookListing,
  type BookMeta,
  type BookReadIssue,
  type BookSummary,
  type Chapter,
  type ChapterReadIssue,
  type ChapterReadIssueReason,
  type ChapterConflict,
  type ChapterMeta,
  type ReorderChapterResult,
  type ReorderDirection,
  type SearchHit,
  type SaveChapterResult
} from "../schema";
import {
  FormatError,
  chapterFileName,
  compareChapterFileNames,
  countWords,
  isConflictCopyName,
  normalizeBody,
  parseChapterFile,
  parseOrderFromFileName,
  serializeChapter
} from "../markdown";
import {
  matterHash,
  matterSchema,
  orderSections,
  readMatter,
  type BookMatter,
  type SaveMatterResult
} from "../matter";
import { LibraryError, LibraryPortError } from "./errors";
import { atomicOverlaps, mergeValue, rewrite, sameValue } from "./book-merge";
import { assertBookWritable, assertSchemaVersion } from "./schema-guard";
import { planMove } from "./order";
import { libraryPathFromArchivePath, libraryPathToArchivePath, toLibraryFilePath } from "./path";
import type { LibraryPath } from "./path";
import {
  bookFilePath,
  bookPath,
  bookTrashPath,
  booksPath,
  chapterDisplayPath,
  chapterPath,
  chaptersPath,
  checkpointsPath,
  conflictDisplayPath,
  conflictPath,
  conflictsPath,
  libraryIndexPath,
  stagingBookFilePath,
  stagingChapterPath,
  stagingPath,
  studioPath,
  syncJournalPath,
  threadsPath,
  trashPath
} from "./paths";
import type {
  CommitFileResult,
  FileExpectation,
  LibraryDeviceInfo,
  LibraryEnvironment,
  LibraryFileSnapshot
} from "./port";
import { locationHealth, type LocationHealth } from "../sync/health";
import {
  acceptDriftPaths,
  journalForScan,
  noteMovedPrefix,
  notePlannedWrite,
  noteRemovedFiles,
  noteWrittenFiles,
  readSyncJournal,
  updateSyncJournal,
  writeSyncJournal
} from "../sync/journal";
import { scanLibrary } from "../sync/scan";
import { detectDrift } from "../sync/detector";
import type { DriftReport } from "../sync/types";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * The product's library rules, independent of where the bytes live.
 *
 * A host supplies a `LibraryPort` (filesystem, folder handle, origin storage) and runtime
 * primitives. Everything promised about the format — checked saves, conflict copies, trash,
 * the derived catalog — is implemented here once.
 */
/**
 * A chapter field change where "leave it alone" and "clear it" are different things.
 *
 * `Partial<Pick<…>>` says a key may be missing; this says a key may also be present and
 * undefined, which is what a parsed request body actually produces.
 */
export type ChapterMetaPatch = {
  [K in "title" | "synopsis" | "purpose" | "notes" | "arc" | "order" | "isPrologue" | "color"]?:
    | ChapterMeta[K]
    | undefined;
};

/** A book field change where a key may be missing *or* present and undefined. */
export type BookPatch = { [K in keyof BookMeta]?: BookMeta[K] | undefined };

/** Where a kept conflict copy went, or that the chapter was no longer the version read. */
export type KeepConflictCopyResult = { status: "kept"; savedAs: string } | { status: "changed" };

export class LibraryService {
  private readonly writes = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly env: LibraryEnvironment,
    private readonly device: LibraryDeviceInfo
  ) {}

  static async open(env: LibraryEnvironment): Promise<LibraryService> {
    await ensureLayout(env.storage);
    const device = await env.storage.deviceInfo();
    const service = new LibraryService(env, device);
    await service.rebuildCatalog();
    return service;
  }

  get deviceId(): string {
    return this.device.id;
  }

  get deviceName(): string {
    return this.device.name;
  }

  /**
   * Watch author-owned paths for changes made outside this service. The adapter may not support
   * watching; then this returns a no-op and the studio keeps its save-time conflict checks.
   */
  watch(onChange: (path: string) => void): () => void {
    const storage = this.env.storage;
    if (!storage.watch) return () => {};
    const stops = [booksPath(), trashPath()].map((root) =>
      storage.watch!(root, (changed) => {
        try {
          onChange(libraryPathToArchivePath(changed));
        } catch {
          // A provider event on the root or an unsafe name is not a book file.
        }
      })
    );
    return () => {
      for (const stop of stops) stop();
    };
  }

  /**
   * Derive the location health line from a fresh read-only scan. The scan never
   * reads placeholders as content and never writes; the journal keeps reviewed
   * conflict copies from being reported again.
   */
  async locationHealth(): Promise<LocationHealth> {
    const { files } = await scanLibrary(this.env.storage);
    const journal = await readSyncJournal(this.env.storage, this.device.id);
    return locationHealth(files, journal);
  }

  /**
   * The drift report for the review dialog. Read-only: the scan never writes, placeholders are
   * never mistaken for content, and a second scan reports the same entries until the author
   * accepts them. Chapter ids with unsaved editor text turn an outside edit into `both-changed`.
   */
  /**
   * Record the first baseline for a library that has never been scanned. Only writes when no
   * journal file exists at all: a corrupt, foreign or newer journal is left alone for the author
   * to review and rebuild through `acceptDrift`. Returns whether a baseline was written.
   */
  establishBaseline(): Promise<boolean> {
    const { storage } = this.env;
    return updateSyncJournal(storage, async () => {
      const existing = await storage.readFile(syncJournalPath(this.device.id));
      if (existing) return false;
      const { files } = await scanLibrary(storage);
      const now = this.env.runtime.now();
      await writeSyncJournal(
        storage,
        journalForScan({ deviceId: this.device.id, previous: null, files, now })
      );
      return true;
    });
  }

  async checkDrift(dirtyChapterIds?: Iterable<string>): Promise<DriftReport> {
    const { files } = await scanLibrary(this.env.storage);
    const journal = await readSyncJournal(this.env.storage, this.device.id);
    const now = this.env.runtime.now();
    if (dirtyChapterIds === undefined) return detectDrift({ journal, files, now });
    return detectDrift({ journal, files, dirtyChapterIds, now });
  }

  /**
   * Fold reviewed paths into this device's baseline and return the fresh report. Only the listed
   * paths change: accepting one change never reviews another. Call after the author has reviewed
   * the report, never during detection.
   */
  acceptDrift(paths: string[]): Promise<DriftReport> {
    return updateSyncJournal(this.env.storage, async () => {
      const { files } = await scanLibrary(this.env.storage);
      const previous = await readSyncJournal(this.env.storage, this.device.id);
      const now = this.env.runtime.now();
      const next = acceptDriftPaths({ deviceId: this.device.id, previous, files, accept: paths, now });
      await writeSyncJournal(this.env.storage, next);
      return detectDrift({ journal: next, files, now });
    });
  }

  /**
   * Note files this device wrote or removed beside the service, such as an agent turn's undo
   * checkpoints, in its sync baseline, so the next drift scan reads them as its own. Archive-form
   * paths. Best-effort, like every other note: a failed note leaves a reviewable report.
   */
  async noteOwnFiles(files: { written?: string[]; removed?: string[] }): Promise<void> {
    const now = this.env.runtime.now();
    await noteWrittenFiles({ storage: this.env.storage, deviceId: this.device.id, paths: files.written ?? [], now });
    await noteRemovedFiles({ storage: this.env.storage, deviceId: this.device.id, paths: files.removed ?? [], now });
  }

  /* -------------------------------------------------------------------- books */

  async listBooks(): Promise<BookSummary[]> {
    return (await this.listBooksWithIssues()).books;
  }

  /**
   * Every book that opens, newest first, and every book folder that does not, with the reason. A
   * newer, half-synced or damaged book must not hide the rest of the library, and must not vanish
   * either: the grid says why it cannot open. Its folder is never changed or deleted automatically.
   */
  async listBooksWithIssues(): Promise<BookListing> {
    const books: BookSummary[] = [];
    const bookReadIssues: BookReadIssue[] = [];
    for (const entry of await this.env.storage.listDirectory(booksPath())) {
      if (entry.kind !== "directory" || entry.name.startsWith(".")) continue;
      try {
        books.push(summarize(await this.readBook(entry.name)));
      } catch (error: unknown) {
        bookReadIssues.push(await this.bookReadIssue(entry.name, error));
      }
    }
    books.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    bookReadIssues.sort((a, b) => a.folder.localeCompare(b.folder));
    return { books, bookReadIssues };
  }

  async createBook(input: {
    title: string;
    description?: string | undefined;
    outline?: string | undefined;
  }): Promise<BookMeta> {
    const now = this.env.runtime.now();
    const id = this.env.runtime.newId("book");
    const book = bookSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id,
      title: input.title.trim() || "Untitled book",
      description: input.description ?? "",
      outline: input.outline ?? "",
      createdAt: now,
      updatedAt: now
    });
    await this.ensureBookLayout(id);
    const result = await this.commitText(bookFilePath(id), `${JSON.stringify(book, null, 2)}\n`, { kind: "absent" });
    if (result.status !== "written") {
      throw new LibraryError("io", "A book with this identity already exists. Nothing was overwritten.");
    }
    await this.rebuildCatalog();
    return book;
  }

  async readBook(bookId: string): Promise<BookDetail> {
    const { book } = await this.readBookFile(bookId);
    const { chapters, chapterReadIssues } = await this.readChaptersWithIssues(bookId);
    return { book, chapters, chapterReadIssues };
  }

  /** `book.json` as stored, and the book it holds. */
  private async readBookFile(bookId: string): Promise<{ snapshot: LibraryFileSnapshot; book: BookMeta }> {
    const path = bookFilePath(bookId);
    const snapshot = await this.env.storage.readFile(path);
    if (!snapshot) throw new LibraryError("not-found", `No book called ${bookId} in this library.`);
    return { snapshot, book: parseBookJson(textDecoder.decode(snapshot.bytes), libraryPathToArchivePath(path)) };
  }

  async updateBook(bookId: string, patch: BookPatch): Promise<BookMeta> {
    // The matter changes only through `saveMatter`, which checks what the author edited.
    const { matter: _matter, ...fields } = patch;
    return this.serializeWrite(bookId, async () => {
      const { snapshot, book: current } = await this.readBookFile(bookId);
      const next = bookSchema.parse({
        ...current,
        ...fields,
        id: current.id,
        schemaVersion: current.schemaVersion,
        createdAt: current.createdAt,
        updatedAt: this.env.runtime.now()
      });
      // Only the parts this patch changed are rewritten; the rest keep the shape another writer gave them.
      const out = rewrite(JSON.parse(textDecoder.decode(snapshot.bytes)), current, next);
      const result = await this.commitText(bookFilePath(bookId), `${JSON.stringify(out, null, 2)}\n`, {
        kind: "sha256",
        value: snapshot.sha256
      });
      if (result.status === "changed") {
        await this.keepBookMetadataCopy(bookId, next);
        throw new LibraryError("io", "The book changed while saving. Your metadata update was kept as a conflict copy.");
      }
      await this.rebuildCatalog();
      return next;
    });
  }

  /**
   * Save the fields an editor changed, each with the value it started from. They are merged onto a
   * fresh read of `book.json`: a field the editor did not change is never written, and the cast and
   * memories merge record by record. Where another writer changed the same thing since the editor's
   * read, the file keeps that writer's value and the editor's whole version goes to `conflicts/`.
   * `updateBook` is for a caller that holds no earlier read, such as the import.
   */
  async editBook(bookId: string, changes: BookChanges): Promise<BookEditResult> {
    return this.serializeWrite(bookId, async () => {
      const overlaps: string[] = [];
      const { book, savedAs } = await this.writeBook(bookId, (fresh) => {
        overlaps.length = 0;
        const next: Record<string, unknown> = { ...fresh };
        const mine: Record<string, unknown> = { ...fresh };
        for (const [key, change] of Object.entries(changes)) {
          if (!change) continue;
          const merged = mergeValue(change.from, change.to, next[key], [key], overlaps);
          next[key] = merged.value;
          mine[key] = merged.mine;
        }
        // A choice made of several fields, such as the default model, comes from one writer: where
        // another writer changed any part of it, the file keeps all of theirs and the copy all of ours.
        for (const key of atomicOverlaps(changes, fresh)) {
          next[key] = (fresh as Record<string, unknown>)[key];
          mine[key] = changes[key as keyof BookChanges]?.to;
          overlaps.push(key);
        }
        return overlaps.length > 0 ? { next, copy: mine } : { next };
      });
      if (savedAs === undefined) return { status: "saved", book };
      return { status: "conflict", book, savedAs, fields: [...new Set(overlaps.map((path) => path.split(".")[0] ?? path))] };
    });
  }

  /**
   * The one writer of `book.json` for `editBook`. It reads the file, builds the next version from that
   * read, and commits only while the file is still the read; if another writer got in between, it
   * builds again from the new read. Only the fields that changed are rewritten. A `copy` is the
   * editor's own version where it overlapped another writer, kept after the commit so a retry never
   * leaves two.
   */
  private async writeBook(
    bookId: string,
    build: (fresh: BookMeta) => { next: Record<string, unknown>; copy?: Record<string, unknown> }
  ): Promise<{ book: BookMeta; savedAs?: string }> {
    const path = bookFilePath(bookId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { snapshot, book: fresh } = await this.readBookFile(bookId);
      const text = textDecoder.decode(snapshot.bytes);
      const { next, copy } = build(fresh);
      const fixed = { id: fresh.id, schemaVersion: fresh.schemaVersion, createdAt: fresh.createdAt };
      let book = bookSchema.parse({ ...next, ...fixed, updatedAt: fresh.updatedAt });
      const now = this.env.runtime.now();
      // Both versions are checked before anything is written.
      const kept = copy ? bookSchema.parse({ ...copy, ...fixed, updatedAt: now }) : null;
      if (!sameValue(book, fresh)) {
        const out = rewrite(JSON.parse(text), fresh, { ...book, updatedAt: now });
        book = bookSchema.parse(out);
        const result = await this.commitText(path, `${JSON.stringify(out, null, 2)}\n`, { kind: "sha256", value: snapshot.sha256 });
        if (result.status === "changed") continue;
        await this.rebuildCatalog();
      }
      if (!kept) return { book };
      await this.ensureBookLayout(bookId);
      const stamp = now.replace(/[:.]/g, "-");
      const name = await this.writeConflictCopy(
        bookId,
        `book.conflict-external-edit.${this.device.id}.${stamp}`,
        ".json",
        `${JSON.stringify(kept, null, 2)}\n`
      );
      return { book, savedAs: conflictDisplayPath(bookId, name) };
    }
    throw new LibraryError("io", "book.json kept changing while it was being saved. Nothing was written; try again.");
  }

  private async keepBookMetadataCopy(bookId: string, book: BookMeta): Promise<void> {
    await this.ensureBookLayout(bookId);
    const stamp = this.env.runtime.now().replace(/[:.]/g, "-");
    // The shared helper retries an occupied name and verifies the saved bytes, so the copy is only
    // reported as kept when it was written; it throws otherwise.
    await this.writeConflictCopy(
      bookId,
      `book-metadata.conflict-external-edit.${this.device.id}.${stamp}`,
      ".json",
      `${JSON.stringify({ book }, null, 2)}\n`
    );
  }

  /**
   * Saves the book's front and back matter (spec 035, D-169). Like a chapter save it carries the
   * version and hash of the matter the author edited. When the saved matter has moved on since,
   * nothing is written over it: the author's version is kept as a JSON copy in `conflicts/`
   * and the book is returned with the newer matter. Sections are written front first, then back.
   */
  async saveMatter(
    bookId: string,
    matter: BookMatter,
    expected: { baseVersion: number; baseHash: string }
  ): Promise<SaveMatterResult> {
    return this.serializeWrite(bookId, async () => {
      const { snapshot, book: current } = await this.readBookFile(bookId);
      const disk = readMatter(current);
      if (disk.issue) throw new LibraryError("format", `The book's front and back matter could not be read, so nothing was saved over it. ${disk.issue}`);
      const version = disk.matter?.version ?? 0;
      if (version > expected.baseVersion) return this.keepMatterCopy(bookId, matter, "newer-version", current);
      if ((await matterHash(disk.matter)) !== expected.baseHash) {
        return this.keepMatterCopy(bookId, matter, "external-edit", current);
      }
      const next = bookSchema.parse({
        ...current,
        matter: matterSchema.parse({ ...matter, version: version + 1, sections: orderSections(matter.sections) }),
        updatedAt: this.env.runtime.now()
      });
      const result = await this.commitText(bookFilePath(bookId), `${JSON.stringify(next, null, 2)}\n`, {
        kind: "sha256",
        value: snapshot.sha256
      });
      // Another writer replaced book.json between the read and the write. Their change may not touch
      // the matter at all, so the author's edit stays in the dialog and the next save checks again.
      if (result.status === "changed") throw new LibraryError("io", "The book changed while saving. Nothing was saved; try again.");
      await this.rebuildCatalog();
      return { status: "saved", book: next };
    });
  }

  private async keepMatterCopy(
    bookId: string,
    matter: BookMatter,
    reason: "newer-version" | "external-edit",
    book: BookMeta
  ): Promise<SaveMatterResult> {
    await this.ensureBookLayout(bookId);
    const stamp = this.env.runtime.now().replace(/[:.]/g, "-");
    // JSON, as `book.json` holds it, so nothing the author wrote is reshaped on the way.
    const base = `front-and-back-matter.conflict-${reason}.${this.device.id}.${stamp}`;
    const savedName = await this.writeConflictCopy(bookId, base, ".json", `${JSON.stringify({ matter }, null, 2)}\n`);
    return { status: "conflict", reason, savedAs: conflictDisplayPath(bookId, savedName), book };
  }

  /* ----------------------------------------------------------------- chapters */

  async readChapter(bookId: string, chapterId: string): Promise<Chapter> {
    return (await this.locateChapter(bookId, chapterId)).chapter;
  }

  async createChapter(
    bookId: string,
    input: { title?: string | undefined; content?: string | undefined } = {}
  ): Promise<Chapter> {
    return this.serializeWrite(bookId, async () => {
      const existing = await this.readChapters(bookId);
      const order = existing.reduce((max, chapter) => Math.max(max, chapter.order), 0) + 1;
      const title = input.title?.trim() || `Chapter ${order}`;
      const now = this.env.runtime.now();
      const meta = chapterMetaSchema.parse({
        id: this.env.runtime.newId("ch"),
        title,
        order,
        version: 1,
        createdAt: now,
        updatedAt: now
      });
      await this.ensureBookLayout(bookId);
      const content = normalizeBody(input.content ?? "");
      const text = serializeChapter(meta, content);

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const fileName = this.uniqueChapterFileName(order, title, attempt);
        const result = await this.commitText(chapterPath(bookId, fileName), text, { kind: "absent" });
        if (result.status === "written") {
          await this.rebuildCatalog();
          return chapterFrom(meta, content, fileName, result.snapshot.sha256);
        }
      }
      throw new LibraryError("io", "Could not find a free chapter file name. Nothing was written.");
    });
  }

  async saveChapter(
    bookId: string,
    chapterId: string,
    content: string,
    expected: { baseVersion: number; baseHash: string }
  ): Promise<SaveChapterResult> {
    return this.serializeWrite(bookId, async () => {
      const normalized = normalizeBody(content);
      const located = await this.locateChapterForWrite(bookId, chapterId);
      if ("unreadableFileName" in located) {
        return this.preserveUnreadableVersion(
          bookId,
          chapterId,
          located.unreadableFileName,
          normalized,
          expected.baseVersion + 1
        );
      }
      const { chapter: disk, fileName } = located;

      if (disk.content === normalized) {
        return { status: "saved", chapter: disk };
      }

      const conflict = (reason: ChapterConflict["reason"], localVersion: number): Promise<SaveChapterResult> =>
        this.preserveConflictingVersion(bookId, disk, fileName, normalized, reason, localVersion);

      if (disk.version > expected.baseVersion) {
        return conflict("newer-version", expected.baseVersion + 1);
      }
      if (disk.hash !== expected.baseHash) {
        return conflict("external-edit", expected.baseVersion + 1);
      }

      const { content: _content, path: _path, wordCount: _wordCount, hash: _hash, ...stored } = disk;
      const meta: ChapterMeta = {
        ...stored,
        version: disk.version + 1,
        updatedAt: this.env.runtime.now()
      };
      const result = await this.commitText(chapterPath(bookId, fileName), serializeChapter(meta, normalized), {
        kind: "sha256",
        value: disk.hash
      });
      if (result.status === "changed") {
        const current = await this.chapterFromSnapshot(bookId, fileName, result.current);
        return this.preserveConflictingVersion(bookId, current, fileName, normalized, "external-edit", expected.baseVersion + 1);
      }
      await this.rebuildCatalog();
      return { status: "saved", chapter: chapterFrom(meta, normalized, fileName, result.snapshot.sha256) };
    });
  }

  async updateChapterMeta(
    bookId: string,
    chapterId: string,
    patch: ChapterMetaPatch,
    expected: { baseVersion: number; baseHash: string }
  ): Promise<SaveChapterResult> {
    return this.serializeWrite(bookId, () => this.updateChapterMetaUnlocked(bookId, chapterId, patch, expected));
  }

  /**
   * Move one chapter past its neighbour: the rail's up and down controls and ⌘⌥↑/↓. File names stay
   * as they are: the order field is the source of truth, and renaming would invalidate every open editor.
   */
  async reorderChapter(bookId: string, chapterId: string, direction: ReorderDirection): Promise<ReorderChapterResult> {
    return this.serializeWrite(bookId, async () => {
      const chapters = await this.readChapters(bookId);
      const index = chapters.findIndex((chapter) => chapter.id === chapterId);
      if (index === -1) throw new LibraryError("not-found", "That chapter was not found.");
      return this.moveUnlocked(bookId, chapters, index, direction === "up" ? index - 1 : index + 1);
    });
  }

  /** Move one chapter to a position in the current order: the rail's drag, the agent and undo. */
  async moveChapterTo(bookId: string, chapterId: string, targetIndex: number): Promise<ReorderChapterResult> {
    return this.serializeWrite(bookId, async () => {
      const chapters = await this.readChapters(bookId);
      const from = chapters.findIndex((chapter) => chapter.id === chapterId);
      if (from === -1) throw new LibraryError("not-found", "That chapter was not found.");
      const to = Number.isFinite(targetIndex) ? Math.max(0, Math.min(chapters.length - 1, Math.trunc(targetIndex))) : from;
      return this.moveUnlocked(bookId, chapters, from, to);
    });
  }

  /**
   * Rewrite `order` in the chapter files a move shifts and in no others (`planMove`), each over the
   * file as this move read it, then rebuild the catalog once. A conflict or a failed write puts the
   * earlier writes back; if the app stops part way, the book still reads in one order and the next
   * move repairs it.
   */
  private async moveUnlocked(bookId: string, chapters: Chapter[], from: number, to: number): Promise<ReorderChapterResult> {
    const writes = planMove(chapters, from, to);
    if (writes.length === 0) return { status: "saved", chapters };
    const written: Array<{ before: Chapter; after: Chapter }> = [];
    const putBack = async (): Promise<void> => {
      for (const { before, after } of written.reverse()) {
        await this.commitChapterMeta(bookId, after, { order: before.order }, after.version + 1).catch(() => {});
      }
    };
    try {
      for (const { chapter, order } of writes) {
        const result = await this.commitChapterMeta(bookId, chapter, { order }, chapter.version + 1);
        if (result.status === "conflict") {
          await putBack();
          return result;
        }
        written.push({ before: chapter, after: result.chapter });
      }
    } catch (error) {
      await putBack();
      throw error;
    } finally {
      await this.rebuildCatalog();
    }
    return { status: "saved", chapters: await this.readChapters(bookId) };
  }

  private async updateChapterMetaUnlocked(
    bookId: string,
    chapterId: string,
    patch: ChapterMetaPatch,
    expected: { baseVersion: number; baseHash: string }
  ): Promise<SaveChapterResult> {
    const { chapter: disk, fileName } = await this.locateChapter(bookId, chapterId);
    const conflict = (reason: ChapterConflict["reason"], localVersion: number) =>
      this.preserveConflictingVersion(bookId, disk, fileName, disk.content, reason, localVersion);

    if (disk.version > expected.baseVersion) return conflict("newer-version", expected.baseVersion + 1);
    if (disk.hash !== expected.baseHash) return conflict("external-edit", expected.baseVersion + 1);

    const result = await this.commitChapterMeta(bookId, disk, patch, expected.baseVersion + 1);
    if (result.status === "saved") await this.rebuildCatalog();
    return result;
  }

  /**
   * Write `patch` into the front matter of a chapter file as it was read: one atomic write checked
   * against that file's hash, so a file another writer changed since is kept as a conflict copy and
   * never written over. The catalog is the caller's to rebuild.
   */
  private async commitChapterMeta(
    bookId: string,
    disk: Chapter,
    patch: ChapterMetaPatch,
    localVersion: number
  ): Promise<SaveChapterResult> {
    const { content, path: fileName, wordCount: _wordCount, hash: _hash, ...stored } = disk;
    const meta = chapterMetaSchema.parse({
      ...stored,
      ...patch,
      id: disk.id,
      version: disk.version + 1,
      updatedAt: this.env.runtime.now()
    });
    const result = await this.commitText(chapterPath(bookId, fileName), serializeChapter(meta, content), {
      kind: "sha256",
      value: disk.hash
    });
    if (result.status === "changed") {
      const current = await this.chapterFromSnapshot(bookId, fileName, result.current);
      return this.preserveConflictingVersion(bookId, current, fileName, content, "external-edit", localVersion);
    }
    return { status: "saved", chapter: chapterFrom(meta, content, fileName, result.snapshot.sha256) };
  }

  async deleteChapter(bookId: string, chapterId: string): Promise<{ trashedAt: string }> {
    return this.serializeWrite(bookId, async () => {
      const { fileName } = await this.locateChapter(bookId, chapterId);
      await this.ensureBookLayout(bookId);
      const stamp = this.stamp();

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
        const destination = toLibraryFilePath([
          ...trashPath(bookId),
          `${stamp}-${fileName.replace(/\.md$/, "")}${suffix}.md`
        ]);
        try {
          await this.env.storage.moveFile(chapterPath(bookId, fileName), destination);
          await noteMovedPrefix({
            storage: this.env.storage,
            deviceId: this.device.id,
            from: libraryPathToArchivePath(chapterPath(bookId, fileName)),
            to: libraryPathToArchivePath(destination),
            now: this.env.runtime.now()
          });
          await this.rebuildCatalog();
          return { trashedAt: libraryPathToArchivePath(destination) };
        } catch (error) {
          if (error instanceof LibraryPortError && error.code === "already-exists") continue;
          throw error;
        }
      }
      throw new LibraryError("io", "Could not move the chapter to the trash folder. Nothing was deleted.");
    });
  }

  /**
   * Move a chapter back out of the trash: the very file `deleteChapter` moved there, so the chapter
   * keeps its id, front matter and text. `trashedAt` is the path `deleteChapter` returned. It must
   * name a file in this book's trash that holds this chapter, and the chapter must not be in the book
   * already. The file goes back under the name it had, or the next free one.
   */
  async restoreChapter(bookId: string, chapterId: string, trashedAt: string): Promise<Chapter> {
    return this.serializeWrite(bookId, async () => {
      if ((await this.readChapters(bookId)).some((chapter) => chapter.id === chapterId)) {
        throw new LibraryError("invalid", "That chapter is already in the book. Nothing was moved.");
      }
      const source = trashedChapterPath(bookId, trashedAt);
      const trashName = source[source.length - 1] ?? "";
      const snapshot = await this.env.storage.readFile(source);
      if (!snapshot) throw new LibraryError("not-found", "That chapter is no longer in the trash.");
      const trashed = await this.chapterFromSnapshot(bookId, trashName, snapshot);
      if (trashed.id !== chapterId) {
        throw new LibraryError("invalid", "That file in the trash is another chapter. Nothing was moved.");
      }
      await this.ensureBookLayout(bookId);

      // The trash name is `<stamp>-<original name>`; a name that is not a plain chapter file is rebuilt.
      const original = trashName.replace(/^[a-z0-9]+-/, "");
      const base = (
        original.endsWith(".md") && original !== ".md" && !isConflictCopyName(original)
          ? original
          : chapterFileName(trashed.order, trashed.title)
      ).replace(/\.md$/, "");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const fileName = attempt === 0 ? `${base}.md` : `${base}-${attempt + 1}.md`;
        const destination = chapterPath(bookId, fileName);
        try {
          await this.env.storage.moveFile(source, destination);
        } catch (error) {
          if (error instanceof LibraryPortError && error.code === "already-exists") continue;
          throw error;
        }
        await noteMovedPrefix({
          storage: this.env.storage,
          deviceId: this.device.id,
          from: libraryPathToArchivePath(source),
          to: libraryPathToArchivePath(destination),
          now: this.env.runtime.now()
        });
        await this.rebuildCatalog();
        return this.readChapterFile(bookId, fileName);
      }
      throw new LibraryError("io", "Could not find a free chapter file name. Nothing was moved.");
    });
  }

  /**
   * Keep a chapter's file, exactly as it is now, in `conflicts/`, named like every other conflict
   * copy with the reason `undo`, so its text survives what replaces it next. Nothing is kept when the
   * file is no longer the version the caller read, because the caller has not seen that text.
   */
  async keepConflictCopy(
    bookId: string,
    chapterId: string,
    expected: { baseVersion: number; baseHash: string }
  ): Promise<KeepConflictCopyResult> {
    return this.serializeWrite(bookId, async () => {
      const { fileName } = await this.locateChapter(bookId, chapterId);
      const snapshot = await this.env.storage.readFile(chapterPath(bookId, fileName));
      const disk = await this.chapterFromSnapshot(bookId, fileName, snapshot);
      if (!snapshot || disk.version !== expected.baseVersion || disk.hash !== expected.baseHash) {
        return { status: "changed" };
      }
      await this.ensureBookLayout(bookId);
      const stamp = this.env.runtime.now().replace(/[:.]/g, "-");
      const base = `${fileName.replace(/\.md$/, "")}.conflict-undo.${this.device.id}.${stamp}`;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const savedName = attempt === 0 ? `${base}.md` : `${base}-${attempt + 1}.md`;
        const result = await this.commitText(conflictPath(bookId, savedName), textDecoder.decode(snapshot.bytes), {
          kind: "absent"
        });
        if (result.status === "written") return { status: "kept", savedAs: conflictDisplayPath(bookId, savedName) };
      }
      throw new LibraryError("io", "Could not find a free name for the conflict copy. Nothing was kept.");
    });
  }

  /** Move a whole book folder into the trash. The folder stays readable and restorable. */
  async deleteBook(bookId: string): Promise<{ trashedAt: string }> {
    return this.serializeWrite(bookId, async () => {
      const entries = await this.env.storage.listDirectory(bookPath(bookId));
      if (entries.length === 0) throw new LibraryError("not-found", "That book was not found.");
      const stamp = this.stamp();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
        const destination = bookTrashPath(`${stamp}${suffix}`, bookId);
        try {
          await this.env.storage.moveDirectory(bookPath(bookId), destination);
          await noteMovedPrefix({
            storage: this.env.storage,
            deviceId: this.device.id,
            from: libraryPathToArchivePath(bookPath(bookId)),
            to: libraryPathToArchivePath(destination),
            now: this.env.runtime.now()
          });
          await this.rebuildCatalog();
          return { trashedAt: libraryPathToArchivePath(destination) };
        } catch (error) {
          if (error instanceof LibraryPortError && error.code === "already-exists") continue;
          throw error;
        }
      }
      throw new LibraryError("io", "Could not move the book to the trash folder. Nothing was deleted.");
    });
  }

  async search(bookId: string, query: string, limit = 100): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const chapters = await this.readChapters(bookId);
    const hits: SearchHit[] = [];
    for (const chapter of chapters) {
      const lines = chapter.content.split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.toLowerCase().includes(needle)) continue;
        hits.push({
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          order: chapter.order,
          line: index + 1,
          text: line.slice(0, 240)
        });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  /* ------------------------------------------------------------------- import */

  /**
   * Publish a complete imported manuscript as one book (spec 029 T009).
   *
   * The book is written under a unique unpublished staging path, read back and
   * checked file by file, then published with a single directory move — never as
   * sequential visible `createBook`/`createChapter` calls. Any failure before the
   * move leaves no visible book; the staging area is removed on the way out.
   */
  async importManuscript(input: {
    bookTitle: string;
    chapters: Array<{ title: string; content: string }>;
  }): Promise<BookDetail> {
    const title = input.bookTitle.trim() || "Untitled book";
    if (input.chapters.length === 0) {
      throw new LibraryError("format", "An import needs at least one chapter. Nothing was written.");
    }
    const now = this.env.runtime.now();
    const bookId = this.env.runtime.newId("book");
    return this.serializeWrite(bookId, () => this.importManuscriptUnlocked(bookId, title, input.chapters, now));
  }

  private async importManuscriptUnlocked(
    bookId: string,
    title: string,
    drafts: Array<{ title: string; content: string }>,
    now: string
  ): Promise<BookDetail> {
    const stagedChapters: Array<{ fileName: string; meta: ChapterMeta; content: string }> = [];
    try {
      const book = bookSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: bookId,
        title,
        description: "",
        outline: "",
        createdAt: now,
        updatedAt: now
      });
      await this.env.storage.ensureDirectory(stagingPath(bookId));
      const bookResult = await this.env.storage.commitFile(
        stagingBookFilePath(bookId),
        textEncoder.encode(`${JSON.stringify(book, null, 2)}\n`),
        { kind: "absent" }
      );
      if (bookResult.status !== "written") {
        throw new LibraryError("io", "The import staging area is already in use. Nothing was published.");
      }
      let order = 0;
      for (const draft of drafts) {
        order += 1;
        const meta = chapterMetaSchema.parse({
          id: this.env.runtime.newId("ch"),
          title: draft.title.trim() || `Chapter ${order}`,
          order,
          version: 1,
          createdAt: now,
          updatedAt: now
        });
        const content = normalizeBody(draft.content);
        const text = serializeChapter(meta, content);
        let fileName: string | null = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const candidate = this.uniqueChapterFileName(order, meta.title, attempt);
          const result = await this.env.storage.commitFile(
            stagingChapterPath(bookId, candidate),
            textEncoder.encode(text),
            { kind: "absent" }
          );
          if (result.status === "written") {
            fileName = candidate;
            break;
          }
        }
        if (fileName === null) {
          throw new LibraryError("io", "Could not find a free chapter file name. Nothing was published.");
        }
        stagedChapters.push({ fileName, meta, content });
      }
      await this.verifyStagedImport(bookId, title, stagedChapters);
      await this.env.storage.moveDirectory(stagingPath(bookId), bookPath(bookId));
    } catch (error) {
      throw await this.failStagedImport(bookId, error);
    }
    await this.ensureBookLayout(bookId);
    await this.rebuildCatalog();
    return this.readBook(bookId);
  }

  /** Read the staged book and every staged chapter back; anything unexpected fails the import. */
  private async verifyStagedImport(
    bookId: string,
    title: string,
    stagedChapters: Array<{ fileName: string; meta: ChapterMeta; content: string }>
  ): Promise<void> {
    const stagingId = bookId;
    const fail = (detail: string): LibraryError =>
      new LibraryError("io", `The staged import did not read back ${detail}. Nothing was published.`);
    const bookSnapshot = await this.env.storage.readFile(stagingBookFilePath(stagingId));
    if (!bookSnapshot) throw fail("its book record");
    let stored: unknown;
    try {
      stored = JSON.parse(textDecoder.decode(bookSnapshot.bytes));
    } catch {
      throw fail("its book record as valid JSON");
    }
    const parsed = bookSchema.safeParse(stored);
    if (!parsed.success || parsed.data.id !== bookId || parsed.data.title !== title) {
      throw fail("its book record unchanged");
    }
    for (const staged of stagedChapters) {
      const snapshot = await this.env.storage.readFile(stagingChapterPath(stagingId, staged.fileName));
      if (!snapshot) throw fail(`chapter ${staged.meta.order}`);
      let read: { meta: ChapterMeta; content: string };
      try {
        const file = parseChapterFile(
          textDecoder.decode(snapshot.bytes),
          stagingChapterPath(stagingId, staged.fileName).join("/"),
          staged.meta
        );
        read = { meta: file.meta, content: file.content };
      } catch {
        throw fail(`chapter ${staged.meta.order} in its written form`);
      }
      if (
        read.meta.id !== staged.meta.id ||
        read.meta.order !== staged.meta.order ||
        read.meta.title !== staged.meta.title ||
        read.meta.version !== 1 ||
        read.content !== staged.content
      ) {
        throw fail(`chapter ${staged.meta.order} unchanged`);
      }
    }
  }

  /** Remove unpublished staging after a failure. The original error surfaces unless cleanup fails. */
  private async failStagedImport(stagingId: string, error: unknown): Promise<Error> {
    try {
      await this.env.storage.removeDirectory(stagingPath(stagingId));
    } catch {
      const reason = error instanceof Error ? error.message : String(error);
      const staging = stagingPath(stagingId).join("/");
      return new LibraryError(
        "io",
        `The import failed (${reason}) and its unpublished staging at ${staging} could not be removed. No book was published.`
      );
    }
    return error instanceof Error ? error : new LibraryError("io", "The import failed. No book was published.");
  }

  /* ---------------------------------------------------------------- conflicts */

  async listConflicts(bookId: string): Promise<ChapterConflict[]> {
    const { chapters, copies } = await this.readChaptersWithIssues(bookId);
    const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));
    // A second file with a chapter's id comes first, so the banner's "Show in folder" opens the
    // chapters folder at the copy, beside the chapter it copies.
    const conflicts: ChapterConflict[] = copies.map((copy) => ({
      bookId,
      chapterId: copy.id,
      chapterTitle: copy.title,
      savedAs: chapterDisplayPath(bookId, copy.path),
      reason: "provider-conflict-copy",
      diskVersion: byId.get(copy.id)?.version ?? 0,
      localVersion: copy.version
    }));

    const directories: Array<{ path: LibraryPath; display: (name: string) => string }> = [
      { path: chaptersPath(bookId), display: (name) => chapterDisplayPath(bookId, name) },
      { path: conflictsPath(bookId), display: (name) => conflictDisplayPath(bookId, name) }
    ];

    for (const directory of directories) {
      for (const entry of await this.env.storage.listDirectory(directory.path)) {
        // A `.json` copy is the Story Bible's: an editor's `book.json` kept beside another writer's.
        if (entry.kind !== "file" || !/\.(md|json)$/.test(entry.name)) continue;
        if (!isConflictCopyName(entry.name)) continue;
        // Never read: a copy named as one is a copy whatever it holds, and is never a chapter.
        conflicts.push({
          bookId,
          chapterId: "",
          chapterTitle: entry.name.replace(/\.(md|json)$/, ""),
          savedAs: directory.display(entry.name),
          reason: "provider-conflict-copy",
          diskVersion: 0,
          localVersion: 0
        });
      }
    }
    return conflicts;
  }

  /** `library.json` is a convenience catalog. It is derived and rebuilt, never read as truth. */
  async rebuildCatalog(): Promise<void> {
    try {
      const summaries = await this.listBooks();
      const catalog = {
        schemaVersion: SCHEMA_VERSION,
        app: "ai-book-studio",
        updatedAt: this.env.runtime.now(),
        books: summaries
      };
      await this.commitText(libraryIndexPath(), `${JSON.stringify(catalog, null, 2)}\n`, { kind: "any" });
    } catch (error) {
      console.warn("[library] Could not refresh library.json:", (error as Error).message);
    }
  }

  /* ------------------------------------------------------------------ private */

  private async ensureBookLayout(bookId: string): Promise<void> {
    for (const path of [
      bookPath(bookId),
      chaptersPath(bookId),
      conflictsPath(bookId),
      threadsPath(bookId),
      checkpointsPath(bookId)
    ]) {
      await this.env.storage.ensureDirectory(path);
    }
  }

  /**
   * Why a book folder did not open, as a stable category with no parser or adapter text. Read only
   * after `readBook` failed, so a healthy library pays nothing for it.
   */
  private async bookReadIssue(folder: string, error: unknown): Promise<BookReadIssue> {
    let snapshot: LibraryFileSnapshot | null;
    let names: string[];
    try {
      snapshot = await this.env.storage.readFile(bookFilePath(folder));
      names = (await this.env.storage.listDirectory(bookPath(folder))).map((entry) => entry.name);
    } catch {
      return { folder, title: null, reason: "unreadable" };
    }
    if (error instanceof LibraryError && error.code === "newer-schema") {
      return { folder, title: snapshot ? titleOf(snapshot.bytes) : null, reason: "newer-schema" };
    }
    // The folder has arrived but its `book.json` has not, or is still an empty or online-only stand-in.
    if (!snapshot || snapshot.bytes.byteLength === 0 || names.includes(".book.json.icloud")) {
      return { folder, title: null, reason: "syncing" };
    }
    return { folder, title: null, reason: "unreadable" };
  }

  private async commitText(
    path: LibraryPath,
    text: string,
    expected: FileExpectation
  ): Promise<CommitFileResult> {
    const bytes = textEncoder.encode(text);
    await notePlannedWrite({
      storage: this.env.storage,
      deviceId: this.device.id,
      paths: [libraryPathToArchivePath(path)],
      sha256: await this.env.runtime.sha256(bytes),
      now: this.env.runtime.now()
    });
    const result = await this.env.storage.commitFile(path, bytes, expected);
    if (result.status === "written") {
      // The journal records what this device wrote, so the next scan reads it as local, not
      // remote. After the prose commit, never before; best-effort so a note failure cannot fail
      // the save it follows.
      await noteWrittenFiles({
        storage: this.env.storage,
        deviceId: this.device.id,
        paths: [libraryPathToArchivePath(path)],
        now: this.env.runtime.now()
      });
    }
    return result;
  }

  /**
   * Locate a chapter's own file, never a copy that carries its id. Another chapter's unreadable file
   * does not stop the search; when no readable file has the id, the first unreadable file's error is
   * the answer, because the chapter may be that file.
   */
  private async locateChapter(bookId: string, chapterId: string): Promise<{ chapter: Chapter; fileName: string }> {
    const found = await this.findChapterFile(bookId, chapterId);
    if ("chapter" in found) return found;
    if (found.unreadable) throw found.unreadable.error;
    throw new LibraryError("not-found", `No chapter ${chapterId} in this book.`);
  }

  /**
   * Locate a chapter for a write. A file that is listed but cannot be read is
   * an online-only placeholder (or an unreadable file): the write must not
   * proceed or fail raw. The caller preserves the author's version as a
   * placeholder conflict copy instead. A genuinely absent chapter keeps the
   * not-found error.
   */
  private async locateChapterForWrite(
    bookId: string,
    chapterId: string
  ): Promise<{ chapter: Chapter; fileName: string } | { unreadableFileName: string }> {
    const found = await this.findChapterFile(bookId, chapterId);
    if ("chapter" in found) return found;
    if (found.unreadable) return { unreadableFileName: found.unreadable.fileName };
    throw new LibraryError("not-found", `No chapter ${chapterId} in this book.`);
  }

  /**
   * The first readable file with this id in ranked order, which is the chapter's own file and never
   * a copy (docs/FORMAT.md, "Copies of a chapter"); otherwise the first file that could not be read.
   */
  private async findChapterFile(
    bookId: string,
    chapterId: string
  ): Promise<{ chapter: Chapter; fileName: string } | { unreadable: { fileName: string; error: unknown } | null }> {
    let unreadable: { fileName: string; error: unknown } | null = null;
    for (const fileName of await this.chapterFileNames(bookId)) {
      let chapter: Chapter;
      try {
        chapter = await this.readChapterFile(bookId, fileName);
      } catch (error) {
        unreadable ??= { fileName, error };
        continue;
      }
      if (chapter.id === chapterId) return { chapter, fileName };
    }
    return { unreadable };
  }

  /**
   * The book's chapter file names, ranked so that the first readable file with an id is that
   * chapter's file. A name a sync tool gives its copies is never a candidate.
   */
  private async chapterFileNames(bookId: string): Promise<string[]> {
    const names: string[] = [];
    for (const entry of await this.env.storage.listDirectory(chaptersPath(bookId))) {
      if (entry.kind === "file" && entry.name.endsWith(".md") && !isConflictCopyName(entry.name)) names.push(entry.name);
    }
    return names.sort(compareChapterFileNames);
  }

  /**
   * Preserve the author's version when the chapter on disk cannot be read. The
   * stand-in carries the known identity; the unreadable file name seeds the
   * copy name and the display title, which is best-effort by design.
   */
  private async preserveUnreadableVersion(
    bookId: string,
    chapterId: string,
    unreadableFileName: string,
    localContent: string,
    localVersion: number
  ): Promise<SaveChapterResult> {
    await this.ensureBookLayout(bookId);
    const now = this.env.runtime.now();
    const stamp = now.replace(/[:.]/g, "-");
    const base = unreadableFileName.replace(/\.md$/, "");
    const copyBase = `${base}.conflict-placeholder.${this.device.id}.${stamp}`;
    const title = base.replace(/^\d+-/, "").replace(/[-_]+/g, " ").trim() || "Untitled chapter";
    const text = serializeChapter(
      {
        id: chapterId,
        title,
        order: 1,
        arc: "middle",
        purpose: "",
        synopsis: "",
        notes: "",
        isPrologue: false,
        color: null,
        version: localVersion,
        createdAt: now,
        updatedAt: now
      },
      localContent
    );
    const savedName = await this.writeConflictCopy(bookId, copyBase, ".md", text);

    return {
      status: "conflict",
      conflict: {
        bookId,
        chapterId,
        chapterTitle: title,
        savedAs: conflictDisplayPath(bookId, savedName),
        reason: "placeholder",
        diskVersion: localVersion - 1,
        localVersion
      }
    };
  }

  private async readChapters(bookId: string): Promise<Chapter[]> {
    return (await this.readChaptersWithIssues(bookId)).chapters;
  }

  private async readChaptersWithIssues(
    bookId: string
  ): Promise<{ chapters: Chapter[]; chapterReadIssues: ChapterReadIssue[]; copies: Chapter[] }> {
    const chapters: Chapter[] = [];
    const chapterReadIssues: ChapterReadIssue[] = [];
    // Files whose id a higher-ranked file already holds: copies, listed as conflicts and never written.
    const copies: Chapter[] = [];
    const claimed = new Set<string>();
    for (const fileName of await this.chapterFileNames(bookId)) {
      let chapter: Chapter;
      try {
        chapter = await this.readChapterFile(bookId, fileName);
      } catch (error: unknown) {
        const issue = chapterReadIssue(fileName, error);
        chapterReadIssues.push(issue);
        console.warn(`[library] Skipping unreadable chapter (${issue.reason}).`);
        continue;
      }
      if (claimed.has(chapter.id)) {
        copies.push(chapter);
        continue;
      }
      claimed.add(chapter.id);
      chapters.push(chapter);
    }
    // Two chapters on one number, which a move cut short can leave, read by file name: the same on
    // every device, and unchanged by a rename (docs/FORMAT.md).
    chapters.sort((a, b) => a.order - b.order || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    chapterReadIssues.sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
        a.fileName.localeCompare(b.fileName)
    );
    return { chapters, chapterReadIssues, copies };
  }

  private async readChapterFile(bookId: string, fileName: string): Promise<Chapter> {
    const snapshot = await this.env.storage.readFile(chapterPath(bookId, fileName));
    if (!snapshot) throw new LibraryError("not-found", `The chapter file ${fileName} is missing.`);
    return this.chapterFromSnapshot(bookId, fileName, snapshot);
  }

  private async chapterFromSnapshot(
    bookId: string,
    fileName: string,
    snapshot: LibraryFileSnapshot | null
  ): Promise<Chapter> {
    if (!snapshot) throw new LibraryError("not-found", `The chapter file ${fileName} is missing.`);
    const raw = textDecoder.decode(snapshot.bytes);
    const displayPath = chapterDisplayPath(bookId, fileName);
    const fallback = await this.fallbackMeta(fileName, snapshot.createdAt, snapshot.modifiedAt);
    const parsed = parseChapterFile(raw, displayPath, fallback);
    return chapterFrom(parsed.meta, parsed.content, fileName, snapshot.sha256);
  }

  private async preserveConflictingVersion(
    bookId: string,
    disk: Chapter,
    fileName: string,
    localContent: string,
    reason: ChapterConflict["reason"],
    localVersion: number
  ): Promise<SaveChapterResult> {
    await this.ensureBookLayout(bookId);
    const stamp = this.env.runtime.now().replace(/[:.]/g, "-");
    const base = `${fileName.replace(/\.md$/, "")}.conflict-${reason}.${this.device.id}.${stamp}`;
    const { content: _content, path: _path, wordCount: _wordCount, hash: _hash, ...stored } = disk;
    const text = serializeChapter({ ...stored, version: localVersion, updatedAt: this.env.runtime.now() }, localContent);
    const savedName = await this.writeConflictCopy(bookId, base, ".md", text);

    return {
      status: "conflict",
      conflict: {
        bookId,
        chapterId: disk.id,
        chapterTitle: disk.title,
        savedAs: conflictDisplayPath(bookId, savedName),
        reason,
        diskVersion: disk.version,
        localVersion
      }
    };
  }

  private async writeConflictCopy(bookId: string, base: string, extension: string, text: string): Promise<string> {
    const intended = textEncoder.encode(text);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = `${base}${attempt === 0 ? "" : `-${attempt + 1}`}${extension}`;
      const result = await this.commitText(conflictPath(bookId, name), text, { kind: "absent" });
      if (result.status === "written") {
        // Some adapters read back after publication. Do not call a different writer's bytes our
        // saved copy, or remove them. This verifies that snapshot, not any later external change.
        if (result.snapshot.bytes.length !== intended.length || !intended.every((byte, index) => result.snapshot.bytes[index] === byte)) {
          throw new LibraryError("io", "The conflict copy could not be verified. Keep your changes and try again.");
        }
        return name;
      }
    }
    throw new LibraryError("io", "Could not keep a conflict copy. Your changes were not saved; keep them and try again.");
  }

  /**
   * Keeps one writer per book, so two calls cannot interleave a read and a write. Every write first
   * checks the book's schema, so a book another device upgraded is refused before anything is written.
   */
  private serializeWrite<T>(bookId: string, work: () => Promise<T>): Promise<T> {
    const checked = async () => {
      await assertBookWritable(this.env.storage, bookId);
      return work();
    };
    const previous = this.writes.get(bookId) ?? Promise.resolve();
    const next = previous.then(checked, checked);
    this.writes.set(
      bookId,
      next.catch(() => {})
    );
    return next;
  }

  private uniqueChapterFileName(order: number, title: string, attempt: number): string {
    const base = chapterFileName(order, title).replace(/\.md$/, "");
    if (attempt === 0) return `${base}.md`;
    return `${base}-${attempt + 1}.md`;
  }

  private async fallbackMeta(fileName: string, created: string | null, modified: string | null): Promise<ChapterMeta> {
    const now = this.env.runtime.now();
    const order = parseOrderFromFileName(fileName) ?? 1;
    const slug = fileName.replace(/^\d+-/, "").replace(/\.md$/, "");
    const title = slug.replace(/-/g, " ").replace(/^\w/, (character) => character.toUpperCase()) || `Chapter ${order}`;
    const digest = (await this.env.runtime.sha256(textEncoder.encode(fileName))).slice(0, 16);
    return chapterMetaSchema.parse({
      id: `ch_${digest}`,
      title,
      order,
      version: 1,
      createdAt: validDate(created, now),
      updatedAt: validDate(modified, now)
    });
  }

  private stamp(): string {
    const millis = Date.parse(this.env.runtime.now());
    return Number.isFinite(millis) ? millis.toString(36) : this.env.runtime.now().replace(/\D/g, "").slice(-10);
  }
}

/* -------------------------------------------------------------------- helpers */

function summarize(detail: BookDetail): BookSummary {
  return {
    id: detail.book.id,
    title: detail.book.title,
    description: detail.book.description,
    stage: detail.book.stage,
    chapterCount: detail.chapters.length,
    wordCount: detail.chapters.reduce((total, chapter) => total + chapter.wordCount, 0),
    updatedAt: detail.book.updatedAt
  };
}

function chapterReadIssue(fileName: string, error: unknown): ChapterReadIssue {
  let reason: ChapterReadIssueReason = "unreadable";
  if (error instanceof FormatError || (error instanceof LibraryError && (error.code === "format" || error.code === "invalid"))) {
    reason = "invalid-format";
  } else if (
    (error instanceof LibraryError && error.code === "not-found") ||
    (error instanceof LibraryPortError && error.code === "not-found")
  ) {
    reason = "file-missing";
  } else if (error instanceof LibraryPortError && error.code === "permission-required") {
    reason = "permission-needed";
  }

  return { fileName, order: parseOrderFromFileName(fileName), reason };
}

/**
 * The trash file `deleteChapter` moved a chapter to, from the path it returned. The path comes back
 * from a checkpoint on disk, so anything but a Markdown file directly in this book's trash is refused.
 */
function trashedChapterPath(bookId: string, trashedAt: string): LibraryPath {
  const refused = () => new LibraryError("invalid", "That is not a chapter in this book's trash. Nothing was moved.");
  let path: LibraryPath;
  try {
    path = libraryPathFromArchivePath(trashedAt);
  } catch {
    throw refused();
  }
  const trash = trashPath(bookId);
  const inTrash = path.length === trash.length + 1 && trash.every((segment, index) => path[index] === segment);
  if (!inTrash || !path[trash.length]?.endsWith(".md")) throw refused();
  return path;
}

function chapterFrom(meta: ChapterMeta, content: string, fileName: string, hash: string): Chapter {
  return {
    ...meta,
    content,
    path: fileName,
    wordCount: countWords(content),
    hash
  };
}

/** The title a newer studio wrote, so its card can name the book. Nothing else is read from it. */
function titleOf(bytes: Uint8Array): string | null {
  try {
    const title = (JSON.parse(textDecoder.decode(bytes)) as { title?: unknown } | null)?.title;
    return typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

function parseBookJson(raw: string, path: string): BookMeta {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new LibraryError("format", `book.json is not valid JSON: ${(error as Error).message}`);
  }
  assertSchemaVersion((data as { schemaVersion?: unknown } | null)?.schemaVersion, path);
  const parsed = bookSchema.safeParse(data);
  if (!parsed.success) {
    throw new LibraryError(
      "format",
      `book.json does not match the book schema: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`
    );
  }
  return parsed.data;
}

function validDate(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

/** Layout is created through the port, so every target creates the same ordinary folders. */
async function ensureLayout(storage: LibraryEnvironment["storage"]): Promise<void> {
  for (const path of [studioPath(), booksPath(), trashPath()]) {
    await storage.ensureDirectory(path);
  }
}
