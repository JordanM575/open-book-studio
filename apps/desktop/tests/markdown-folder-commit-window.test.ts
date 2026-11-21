import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryService } from "@ai-book-studio/core/library/service";
import { createFileSystemEnvironment } from "../src/main/library/fs-port";
import { MarkdownFolderHostService } from "../src/main/markdown-folder";

/*
 * Spec 035 T016: the folder commit window, post-publication cleanup settlement, no-replace
 * outcome and repeat naming. Synthetic fixtures in isolated temporary libraries only.
 */

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const NOW = "2026-11-09T00:00:00.000Z";
const CANCELLED = "The Markdown folder export was cancelled. Nothing was published.";
const SUPERSEDED = "The saved book was collected again after this choice. Nothing was published.";
const CONFLICT =
  "That folder already exists. This export creates a new folder and does not replace one. Nothing was published. " +
  "Choose another folder name or another parent folder.";
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function pngBytes(width = 4, height = 3): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, name);
      else out.set(name, sha(await readFile(path)));
    }
  };
  await walk(dir, "");
  return out;
}

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), "abs-md-commit-window-"));
  cleanups.push(root);
  const bookId = "book_window001";
  const bookDir = join(root, "books", bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "images"), { recursive: true });
  const chapter = { id: "ch_window001", title: "The Door", order: 1, body: "The hall was cold.\n", fileName: "0001-the-door.md" };
  const front = [
    "---",
    `id: ${chapter.id}`,
    `title: ${chapter.title}`,
    `order: ${chapter.order}`,
    "version: 1",
    `createdAt: ${NOW}`,
    `updatedAt: ${NOW}`,
    "---",
    ""
  ].join("\n");
  await writeFile(join(bookDir, "chapters", chapter.fileName), `${front}\n${chapter.body}`);
  const book = {
    schemaVersion: 1,
    id: bookId,
    title: "The Salt Road",
    description: "A crossing at low tide.",
    settings: { manuscript: { includeTableOfContents: false } },
    frontMatter: {},
    createdAt: NOW,
    updatedAt: NOW
  };
  await writeFile(join(bookDir, "book.json"), `${JSON.stringify(book, null, 2)}\n`);
  const imageBytes = pngBytes();
  const images = [
    {
      id: "img_window001",
      kind: "chapter",
      chapterId: chapter.id,
      characterId: null,
      fileName: "img_window001.png",
      mimeType: "image/png",
      width: 4,
      height: 3,
      bytes: imageBytes.byteLength,
      sha256: sha(imageBytes),
      prompt: "",
      provider: "synthetic",
      model: "synthetic",
      size: "",
      source: "imported",
      createdAt: NOW,
      cutoutOf: null,
      costUsd: null,
      revisedPrompt: null,
      confidence: null
    }
  ];
  await writeFile(join(bookDir, "images.json"), `${JSON.stringify({ schemaVersion: 1, images }, null, 2)}\n`);
  await writeFile(join(bookDir, "images", "img_window001.png"), imageBytes);
  const env = createFileSystemEnvironment(root);
  await LibraryService.open(env);
  const host = new MarkdownFolderHostService({ libraryRoot: root, storage: env.storage });
  const outParent = await mkdtemp(join(tmpdir(), "abs-md-commit-window-out-"));
  cleanups.push(outParent);
  return { host, bookId, bookDir, outParent };
}

async function readyAttempt(host: MarkdownFolderHostService, bookId: string) {
  const result = await host.captureAttempt(bookId);
  if (result.status !== "ready") throw new Error(`expected ready capture, refused ${result.code}`);
  return result.attempt;
}

function heldWindow(): { reached: Promise<void>; release: () => void; afterStagingComplete: () => Promise<void> } {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    reached,
    release,
    afterStagingComplete: async () => {
      entered();
      await gate;
    }
  };
}

describe("markdown folder commit window", () => {
  test("a cancel held between staging-complete and commit-started prevents the destination", async () => {
    const { host, bookId, bookDir, outParent } = await makeHost();
    const before = await snapshotTree(bookDir);
    const attempt = await readyAttempt(host, bookId);
    const window = heldWindow();
    const pending = host.publishAttempt(attempt.attemptId, join(outParent, "cancelled-window"), {
      afterStagingComplete: window.afterStagingComplete
    });
    await window.reached;
    expect(host.requestCancel(attempt.attemptId)).toEqual({ status: "accepted", attemptId: attempt.attemptId });
    window.release();
    await expect(pending).resolves.toEqual({ status: "cancelled", message: CANCELLED });
    expect(await readdir(outParent)).toEqual([]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("a new capture held in the same window supersedes the attempt and publishes nothing", async () => {
    const { host, bookId, bookDir, outParent } = await makeHost();
    const before = await snapshotTree(bookDir);
    const attempt = await readyAttempt(host, bookId);
    const window = heldWindow();
    const pending = host.publishAttempt(attempt.attemptId, join(outParent, "superseded-window"), {
      afterStagingComplete: window.afterStagingComplete
    });
    await window.reached;
    await host.capture(bookId);
    window.release();
    await expect(pending).rejects.toMatchObject({ code: "consent-superseded", message: SUPERSEDED });
    expect(await readdir(outParent)).toEqual([]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("a cancel after commit-started is too late and the folder is published", async () => {
    const { host, bookId, bookDir, outParent } = await makeHost();
    const before = await snapshotTree(bookDir);
    const attempt = await readyAttempt(host, bookId);
    const destination = join(outParent, "committed-folder");
    const replies: Array<ReturnType<MarkdownFolderHostService["requestCancel"]>> = [];
    const pending = host.publishAttempt(attempt.attemptId, destination, {
      publish: {
        createDestinationDirectory: async (path) => {
          replies.push(host.requestCancel(attempt.attemptId));
          await mkdir(path);
        }
      }
    });
    const settlement = await pending;
    expect(replies).toEqual([{ status: "too-late", attemptId: attempt.attemptId }]);
    expect(settlement.status).toBe("published");
    if (settlement.status !== "published") throw new Error("expected published settlement");
    expect(settlement.destinationPath).toBe(destination);
    for (const file of attempt.plan.files) {
      expect((await readFile(join(destination, ...file.path.split("/")))).byteLength).toBe(file.byteLength);
    }
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("a post-publication staging cleanup failure is published with the exact leftover path", async () => {
    const { host, bookId, outParent } = await makeHost();
    const attempt = await readyAttempt(host, bookId);
    const destination = join(outParent, "published-with-leftover");
    const settlement = await host.publishAttempt(attempt.attemptId, destination, {
      publish: {
        rm: async () => {
          throw new Error("synthetic cleanup failure");
        }
      }
    });
    expect(settlement.status).toBe("published");
    if (settlement.status !== "published") throw new Error("expected published settlement");
    for (const file of attempt.plan.files) {
      expect((await readFile(join(destination, ...file.path.split("/")))).byteLength).toBe(file.byteLength);
    }
    const leftover = settlement.cleanupLeftover;
    if (!leftover) throw new Error("expected a cleanup leftover");
    expect(leftover.path).toBe(join(outParent, leftover.name));
    expect(leftover.path.endsWith(leftover.name)).toBe(true);
    expect(await readFile(join(outParent, leftover.name, ".markdown-folder-staging-owned"), "utf8")).toBeTruthy();
    expect(JSON.stringify(settlement)).not.toContain("could not be confirmed");
    expect(JSON.stringify(settlement)).not.toContain('"unknown"');
  });

  test("a commit rename failure with a proven rollback is a known refusal, not unknown", async () => {
    const { host, bookId, bookDir, outParent } = await makeHost();
    const before = await snapshotTree(bookDir);
    const attempt = await readyAttempt(host, bookId);
    const error = await host.publishAttempt(attempt.attemptId, join(outParent, "rolled-back"), {
      publish: {
        rename: async () => {
          throw Object.assign(new Error("synthetic commit failure"), { code: "EIO" });
        }
      }
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "commit-failed", verdict: "not-published" });
    expect(await readdir(outParent)).toEqual([]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("an unproven commit rollback settles unknown with the destination path", async () => {
    const { host, bookId, outParent } = await makeHost();
    const attempt = await readyAttempt(host, bookId);
    const destination = join(outParent, "unproven");
    let destinationChecks = 0;
    const settlement = await host.publishAttempt(attempt.attemptId, destination, {
      publish: {
        rename: async () => {
          throw Object.assign(new Error("synthetic commit failure"), { code: "EIO" });
        },
        lstat: async (path) => {
          const value = await lstat(path);
          if (path === destination) {
            destinationChecks += 1;
            if (destinationChecks === 2) {
              return { dev: value.dev, ino: value.ino + 1, isDirectory: () => true, isSymbolicLink: () => false };
            }
          }
          return value;
        }
      }
    });
    expect(settlement).toMatchObject({ status: "unknown", destinationPath: destination });
    expect((await lstat(destination)).isDirectory()).toBe(true);
    expect(await readdir(destination)).toEqual([]);
  });

  test("an existing destination with a sentinel is a name conflict, and the attempt remains cancellable", async () => {
    const { host, bookId, outParent } = await makeHost();
    const destination = join(outParent, "existing-folder");
    await mkdir(destination);
    await writeFile(join(destination, "sentinel.txt"), "prior output bytes");
    const attempt = await readyAttempt(host, bookId);
    const settlement = await host.publishAttempt(attempt.attemptId, destination);
    expect(settlement).toEqual({ status: "name-conflict", message: CONFLICT });
    expect(await readFile(join(destination, "sentinel.txt"), "utf8")).toBe("prior output bytes");
    expect((await readdir(destination)).sort()).toEqual(["sentinel.txt"]);
    expect((await readdir(outParent)).sort()).toEqual(["existing-folder"]);
    expect(host.requestCancel(attempt.attemptId)).toEqual({ status: "accepted", attemptId: attempt.attemptId });
  });

  test("a destination that appears in the held window is a name conflict and is left as it was", async () => {
    const { host, bookId, outParent } = await makeHost();
    const attempt = await readyAttempt(host, bookId);
    const destination = join(outParent, "appeared-folder");
    const settlement = await host.publishAttempt(attempt.attemptId, destination, {
      afterStagingComplete: async () => {
        await mkdir(destination);
        await writeFile(join(destination, "actor.txt"), "another actor");
      }
    });
    expect(settlement).toEqual({ status: "name-conflict", message: CONFLICT });
    expect(await readFile(join(destination, "actor.txt"), "utf8")).toBe("another actor");
    expect((await readdir(destination)).sort()).toEqual(["actor.txt"]);
    expect((await readdir(outParent)).sort()).toEqual(["appeared-folder"]);
    expect(host.requestCancel(attempt.attemptId)).toEqual({ status: "accepted", attemptId: attempt.attemptId });
  });

  test("a repeat export with a new name publishes beside the first folder", async () => {
    const { host, bookId, outParent } = await makeHost();
    const first = await readyAttempt(host, bookId);
    const firstDestination = join(outParent, "first-folder");
    const firstSettlement = await host.publishAttempt(first.attemptId, firstDestination);
    expect(firstSettlement.status).toBe("published");
    const firstBytes = await readFile(join(firstDestination, "README.md"));
    const second = await readyAttempt(host, bookId);
    const secondDestination = join(outParent, "second-folder");
    const secondSettlement = await host.publishAttempt(second.attemptId, secondDestination);
    expect(secondSettlement.status).toBe("published");
    expect((await readdir(outParent)).sort()).toEqual(["first-folder", "second-folder"]);
    expect(await readFile(join(firstDestination, "README.md"))).toEqual(firstBytes);
    if (secondSettlement.status !== "published") throw new Error("expected published settlement");
    for (const file of second.plan.files) {
      expect((await readFile(join(secondDestination, ...file.path.split("/")))).byteLength).toBe(file.byteLength);
    }
  });
});
