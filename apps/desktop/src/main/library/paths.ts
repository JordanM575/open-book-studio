import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";

/**
 * Host-path helpers for the desktop adapter and its tests.
 *
 * The format's layout lives in `@ai-book-studio/core/library/paths`; these functions only turn
 * the same names into absolute paths for Node. They are never exposed to the renderer.
 */
export function resolveLibraryRoot(root: string): string {
  const absolute = resolve(root);
  if (absolute === sep) throw new Error("The library folder cannot be the filesystem root.");
  return absolute;
}

/** Joins a library-relative path, refusing anything that would escape the library. */
export function safeJoin(root: string, ...parts: string[]): string {
  const target = resolve(root, ...parts);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`Path escapes the library: ${parts.join("/")}`);
  }
  return target;
}

export function bookFile(root: string, bookId: string): string {
  return safeJoin(root, "books", bookId, "book.json");
}

export function chaptersDir(root: string, bookId: string): string {
  return safeJoin(root, "books", bookId, "chapters");
}

export function newId(prefix: "book" | "ch" | "char" | "mem" | "thread" | "cp" | "msg" | "turn" | "plan"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function isoNow(): string {
  return new Date().toISOString();
}
