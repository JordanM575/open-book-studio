import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DraftInput, RecoveredDraft } from "@ai-book-studio/core/ipc";
import { idSchema, type SaveChapterResult } from "@ai-book-studio/core/schema";
import { countWords } from "@ai-book-studio/core/words";
import { writeFileAtomic } from "./library/atomic";
import { LibraryError, type Library } from "./library/store";

/** A kept copy's id: `rec_` and 16 hex digits. Its file is `<id>.json`, and nothing else is read. */
export const recoveryIdSchema = z.string().regex(/^rec_[a-f0-9]{16}$/, "invalid recovery id");

const keptSchema = z.object({
  version: z.literal(1),
  id: recoveryIdSchema,
  bookId: idSchema,
  chapterId: idSchema,
  content: z.string().max(20_000_000),
  baseVersion: z.number().int().min(0),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  keptAt: z.string().datetime(),
  reason: z.string().max(2_000),
  /** Where the words were typed. Shown, never matched: a renamed library keeps its book ids. */
  libraryRoot: z.string().max(4_096)
});

/** Words a close or quit could not save, as they are kept on disk. */
export type KeptWords = z.infer<typeof keptSchema>;

const FILE = /^(rec_[a-f0-9]{16})\.json$/;
const ENDING_LENGTH = 120;

/**
 * Words a close or quit could not save to the library, kept in the studio's own profile
 * (`userData/recovery/`) until the author restores or discards them.
 *
 * It is a disposable draft, not a second database: a kept copy only ever goes back through the
 * normal checked save, and nothing reads it as the chapter. Each failed flush writes a new file, so
 * a later failure never replaces earlier words, and an identical copy is not written twice. Files
 * are owner-only, because they hold prose.
 */
export class RecoveryStore {
  constructor(
    readonly folder: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Keep a draft that could not be saved. Returns the copy on disk, which may be one kept before. */
  async keep(draft: DraftInput, reason: string, libraryRoot: string): Promise<KeptWords> {
    const same = (await this.all()).find(
      (entry) =>
        entry.bookId === draft.bookId &&
        entry.chapterId === draft.chapterId &&
        entry.baseHash === draft.baseHash &&
        entry.content === draft.content
    );
    if (same) return same;
    const entry: KeptWords = {
      version: 1,
      id: `rec_${randomBytes(8).toString("hex")}`,
      bookId: draft.bookId,
      chapterId: draft.chapterId,
      content: draft.content,
      baseVersion: draft.baseVersion,
      baseHash: draft.baseHash,
      keptAt: this.now().toISOString(),
      reason: reason.slice(0, 2_000),
      libraryRoot
    };
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.path(entry.id), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
    return entry;
  }

  /** Every copy that reads, newest first. A file that does not read is reported and left alone. */
  async all(): Promise<KeptWords[]> {
    let names: string[];
    try {
      names = await readdir(this.folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: KeptWords[] = [];
    for (const name of names) {
      const id = FILE.exec(name)?.[1];
      if (!id) continue;
      try {
        const entry = await this.read(id);
        if (entry) entries.push(entry);
      } catch (error) {
        console.warn(`[recovery] Skipped ${name}:`, (error as Error).message);
      }
    }
    return entries.sort((a, b) => b.keptAt.localeCompare(a.keptAt));
  }

  /** What the workspace offers for one book, without the text itself. */
  async list(bookId: string): Promise<RecoveredDraft[]> {
    return (await this.all()).filter((entry) => entry.bookId === bookId).map(summarize);
  }

  /** Whether a failed flush for this chapter is already kept. The text stays in the store. */
  async holds(bookId: string, chapterId: string): Promise<boolean> {
    return (await this.all()).some((entry) => entry.bookId === bookId && entry.chapterId === chapterId);
  }

  /** One kept copy, or null when it was restored or discarded already. */
  async read(id: string): Promise<KeptWords | null> {
    const checked = recoveryIdSchema.parse(id);
    let text: string;
    try {
      text = await readFile(this.path(checked), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const entry = keptSchema.parse(JSON.parse(text));
    if (entry.id !== checked) throw new Error("its id does not match its file name");
    return entry;
  }

  async remove(id: string): Promise<void> {
    try {
      await unlink(this.path(recoveryIdSchema.parse(id)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private path(id: string): string {
    return join(this.folder, `${id}.json`);
  }
}

/**
 * Put kept words back through the checked save, against the version and hash they were typed on. A
 * chapter that changed since keeps them as a conflict copy instead of being overwritten. The kept
 * copy goes only once the words are in the library; a save that throws leaves it where it was.
 */
export async function restoreKept(store: RecoveryStore, library: Library, id: string): Promise<SaveChapterResult> {
  const entry = await store.read(id);
  if (!entry) throw new LibraryError("not-found", "Those words were already restored or discarded.");
  const result = await library.saveChapter(entry.bookId, entry.chapterId, entry.content, {
    baseVersion: entry.baseVersion,
    baseHash: entry.baseHash
  });
  await store.remove(entry.id);
  return result;
}

function summarize(entry: KeptWords): RecoveredDraft {
  const collapsed = entry.content.replace(/\s+/g, " ").trim();
  return {
    id: entry.id,
    bookId: entry.bookId,
    chapterId: entry.chapterId,
    keptAt: entry.keptAt,
    reason: entry.reason,
    wordCount: countWords(entry.content),
    ending: collapsed.length <= ENDING_LENGTH ? collapsed : `…${collapsed.slice(-(ENDING_LENGTH - 1)).trimStart()}`
  };
}
