import { toLibraryFilePath, toLibraryPath, type LibraryPath } from "./path";

/** Names from docs/FORMAT.md. They are format constants, not preferences. */
export const LIBRARY_DIRS = {
  books: "books",
  studio: ".studio",
  trash: "trash",
  chapters: "chapters",
  conflicts: "conflicts",
  images: "images",
  threads: "threads",
  checkpoints: "checkpoints",
  sync: "sync"
} as const;

export const LIBRARY_FILES = {
  index: "library.json",
  device: "device.json",
  fileIndex: "files.json",
  images: "images.json",
  migrations: "migrations.json",
  collections: "collections.json"
} as const;

export const studioPath = (): LibraryPath => toLibraryPath([LIBRARY_DIRS.studio]);
export const booksPath = (): LibraryPath => toLibraryPath([LIBRARY_DIRS.books]);
export const bookPath = (bookId: string): LibraryPath => toLibraryPath([LIBRARY_DIRS.books, bookId]);
export const bookFilePath = (bookId: string): LibraryPath => toLibraryPath([LIBRARY_DIRS.books, bookId, "book.json"]);
export const chaptersPath = (bookId: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.books, bookId, LIBRARY_DIRS.chapters]);
export const chapterPath = (bookId: string, fileName: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.books, bookId, LIBRARY_DIRS.chapters, fileName]);
export const conflictsPath = (bookId: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.books, bookId, LIBRARY_DIRS.conflicts]);
export const conflictPath = (bookId: string, fileName: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.books, bookId, LIBRARY_DIRS.conflicts, fileName]);
export const imagesPath = (bookId: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.books, bookId, LIBRARY_DIRS.images]);
export const imageManifestPath = (bookId: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.books, bookId, LIBRARY_FILES.images]);
export const imageFilePath = (bookId: string, fileName: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.books, bookId, LIBRARY_DIRS.images, fileName]);
export const threadsPath = (bookId: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.books, bookId, LIBRARY_DIRS.threads]);
/** Deleted conversations, kept whole under this book's trash so restore can move the same file back. */
export const threadsTrashPath = (bookId: string): LibraryPath =>
  toLibraryFilePath([...trashPath(bookId), LIBRARY_DIRS.threads]);
export const checkpointsPath = (bookId: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.books, bookId, LIBRARY_DIRS.checkpoints]);
/** Device-local sync baselines; never exported in the portable archive. */
/**
 * Unpublished import staging. A staged book becomes visible only when the whole
 * directory is moved under `books/`; until then readers never see it.
 */
export const stagingPath = (stagingId: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.studio, "staging", stagingId]);
export const stagingBookFilePath = (stagingId: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.studio, "staging", stagingId, "book.json"]);
export const stagingChapterPath = (stagingId: string, fileName: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.studio, "staging", stagingId, LIBRARY_DIRS.chapters, fileName]);
export const syncPath = (): LibraryPath => toLibraryPath([LIBRARY_DIRS.studio, LIBRARY_DIRS.sync]);
export const syncJournalPath = (deviceId: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.studio, LIBRARY_DIRS.sync, `${deviceId}.json`]);
/** Deleted books live beside chapter trash, under their own folder so ids never collide. */
export const bookTrashPath = (stamp: string, bookId: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.studio, LIBRARY_DIRS.trash, LIBRARY_DIRS.books, `${stamp}-${bookId}`]);
export const trashPath = (bookId?: string): LibraryPath =>
  bookId === undefined
    ? toLibraryPath([LIBRARY_DIRS.studio, LIBRARY_DIRS.trash])
    : toLibraryPath([LIBRARY_DIRS.studio, LIBRARY_DIRS.trash, bookId]);
export const collectionsFilePath = (): LibraryPath => toLibraryPath([LIBRARY_FILES.collections]);
/** Library-root conflict copies for records that do not belong to one book. */
export const rootConflictsPath = (): LibraryPath => toLibraryPath([LIBRARY_DIRS.conflicts]);
export const rootConflictPath = (fileName: string): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.conflicts, fileName]);
export const libraryIndexPath = (): LibraryPath => toLibraryPath([LIBRARY_FILES.index]);
export const devicePath = (): LibraryPath => toLibraryPath([LIBRARY_DIRS.studio, LIBRARY_FILES.device]);
export const migrationsPath = (): LibraryPath =>
  toLibraryPath([LIBRARY_DIRS.studio, LIBRARY_FILES.migrations]);
export const fileIndexPath = (): LibraryPath => toLibraryPath([LIBRARY_DIRS.studio, LIBRARY_FILES.fileIndex]);

/** A human-readable path for a chapter's metadata fallback and for logs. Never used as a host path. */
export function chapterDisplayPath(bookId: string, fileName: string): string {
  return `${LIBRARY_DIRS.books}/${bookId}/${LIBRARY_DIRS.chapters}/${fileName}`;
}

export function conflictDisplayPath(bookId: string, fileName: string): string {
  return `${LIBRARY_DIRS.books}/${bookId}/${LIBRARY_DIRS.conflicts}/${fileName}`;
}
