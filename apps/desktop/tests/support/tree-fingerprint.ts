/**
 * Test-support only. Never imported by product code.
 *
 * Whole-tree byte fingerprint for synthetic fixture libraries. Walks every entry under
 * `root`, hashes every regular file, and records symlinks (without following them) and
 * anything else as typed markers, so a changed, created, deleted or repointed entry all
 * fail the comparison. Empty directories are not content and are not recorded.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Deterministic, sorted `relative/posix/path:sha256` entries for every file under root. */
export async function treeFingerprint(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const full = join(dir, child.name);
      const rel = relative(root, full).split(sep).join("/");
      if (child.isDirectory()) {
        await walk(full);
        continue;
      }
      if (child.isSymbolicLink()) {
        entries.push(`${rel}:symlink:${await readlink(full)}`);
        continue;
      }
      if (!child.isFile()) {
        entries.push(`${rel}:other`);
        continue;
      }
      const bytes = await readFile(full);
      entries.push(`${rel}:${createHash("sha256").update(bytes).digest("hex")}`);
    }
  }
  await walk(root);
  return entries.sort();
}

/** The first differing entry between two fingerprints, or null when they are identical. */
export function firstTreeDifference(before: readonly string[], after: readonly string[]): string | null {
  const total = Math.max(before.length, after.length);
  for (let index = 0; index < total; index++) {
    const a = before[index];
    const b = after[index];
    if (a === b) continue;
    if (a === undefined) return `only in after: ${b}`;
    if (b === undefined) return `only in before: ${a}`;
    return `before: ${a}\nafter:  ${b}`;
  }
  return null;
}

/** Throws with the first differing path when the tree changed in any way (modified, created, deleted or repointed). */
export function expectTreeUnchanged(before: readonly string[], after: readonly string[]): void {
  const difference = firstTreeDifference(before, after);
  if (difference) {
    throw new Error(`Library tree changed unexpectedly.\n${difference}`);
  }
}
