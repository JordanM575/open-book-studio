import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryService } from "@ai-book-studio/core/library/service";
import { createFileSystemEnvironment } from "../src/main/library/fs-port";
import {
  MARKDOWN_FOLDER_CONSENT_DISCLOSURE,
  MarkdownFolderHostService,
  suggestMarkdownFolderName
} from "../src/main/markdown-folder";

/*
 * Spec 035 T014-U journey at the host level: synthetic fixtures in isolated temporary
 * libraries only. Capture binds consent to the frozen bundle, cancellation before the
 * commit prevents publication, and a commit that has begun never settles as success
 * on an unconfirmed outcome.
 */

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const NOW = "2026-11-09T00:00:00.000Z";
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

async function makeHost(options: { frontMatter?: Record<string, string>; withImage?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "abs-md-folder-journey-"));
  cleanups.push(root);
  const bookId = "book_test0001";
  const bookDir = join(root, "books", bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "images"), { recursive: true });
  const chapters = [
    { id: "ch_first001", title: "The Door", order: 1, body: "The hall was cold.\n", fileName: "0001-the-door.md" },
    { id: "ch_second01", title: "The Gate", order: 2, body: "Morning came slowly.\n", fileName: "0002-the-gate.md" }
  ];
  for (const chapter of chapters) {
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
  }
  const book: Record<string, unknown> = {
    schemaVersion: 1,
    id: bookId,
    title: "The Salt Road",
    description: "A crossing at low tide.",
    settings: { manuscript: { includeTableOfContents: true } },
    frontMatter: options.frontMatter ?? {},
    createdAt: NOW,
    updatedAt: NOW
  };
  await writeFile(join(bookDir, "book.json"), `${JSON.stringify(book, null, 2)}\n`);
  const imageBytes = pngBytes();
  const images = options.withImage
    ? [
        {
          id: "img_first001",
          kind: "chapter",
          chapterId: "ch_first001",
          characterId: null,
          fileName: "img_first001.png",
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
      ]
    : [];
  await writeFile(join(bookDir, "images.json"), `${JSON.stringify({ schemaVersion: 1, images }, null, 2)}\n`);
  if (options.withImage) await writeFile(join(bookDir, "images", "img_first001.png"), imageBytes);
  const env = createFileSystemEnvironment(root);
  await LibraryService.open(env);
  const host = new MarkdownFolderHostService({ libraryRoot: root, storage: env.storage });
  const outParent = await mkdtemp(join(tmpdir(), "abs-md-folder-journey-out-"));
  cleanups.push(outParent);
  return { root, bookId, bookDir, host, outParent, imageBytes };
}

async function readyAttempt(host: MarkdownFolderHostService, bookId: string) {
  const result = await host.captureAttempt(bookId);
  if (result.status !== "ready") throw new Error(`expected ready capture, refused ${result.code}`);
  return result.attempt;
}

describe("markdown folder attempt journey", () => {
  test("suggests a folder name from the book title in the main process", () => {
    expect(suggestMarkdownFolderName("The Salt Road")).toBe("the-salt-road-markdown");
    expect(suggestMarkdownFolderName("  ")).toBe("untitled-book-markdown");
  });

  test("capture binds the exact disclosure, warnings and excluded legacy to the attempt, then publishes every file", async () => {
    const { host, bookId, bookDir, outParent } = await makeHost({
      frontMatter: { notes: "synthetic legacy text that must not be copied" },
      withImage: true
    });
    const before = await snapshotTree(bookDir);
    const attempt = await readyAttempt(host, bookId);
    expect(attempt.capture.consentDisclosure).toBe(MARKDOWN_FOLDER_CONSENT_DISCLOSURE);
    expect(attempt.capture.consentDisclosure).toContain("returned to identical bytes");
    expect(attempt.capture.consentDisclosure).toContain("not a simultaneous snapshot");
    expect(attempt.plan.excludedLegacy).toEqual([
      { position: 1, key: "notes", keyIsFallback: false, reason: "not-represented" }
    ]);
    expect(JSON.stringify(attempt.plan.excludedLegacy)).not.toContain("synthetic legacy text");
    const destination = join(outParent, "salt-road-folder");
    const settlement = await host.publishAttempt(attempt.attemptId, destination);
    expect(settlement.status).toBe("published");
    if (settlement.status !== "published") throw new Error("expected published settlement");
    expect(settlement.destinationPath).toBe(destination);
    expect(settlement.files).toEqual(attempt.plan.files.map((file) => file.path));
    expect(settlement.files).toContain("README.md");
    for (const file of settlement.files) {
      expect((await readFile(join(destination, ...file.split("/")))).byteLength).toBeGreaterThanOrEqual(0);
    }
    expect(await readFile(join(destination, "0003-chapter.md"), "utf8")).toContain("The hall was cold.");
    expect((await readdir(outParent)).sort()).toEqual(["salt-road-folder"]);
    expect(await snapshotTree(bookDir)).toEqual(before);
    expect(host.requestCancel(attempt.attemptId)).toEqual({ status: "already-settled", attemptId: attempt.attemptId });
  });

  test("a new capture supersedes consent and the earlier attempt publishes nothing", async () => {
    const { host, bookId, outParent } = await makeHost();
    const first = await readyAttempt(host, bookId);
    await readyAttempt(host, bookId);
    await expect(host.publishAttempt(first.attemptId, join(outParent, "first-folder"))).rejects.toMatchObject({
      code: "consent-superseded"
    });
    expect(await readdir(outParent)).toEqual([]);
  });

  test("a plan paired with another capture's consent refuses instead of publishing", async () => {
    const { host, bookId, outParent } = await makeHost();
    const first = await readyAttempt(host, bookId);
    const second = await readyAttempt(host, bookId);
    await expect(
      host.publish({ plan: first.plan, consent: second.consent }, join(outParent, "cross-paired"))
    ).rejects.toMatchObject({ code: "consent-superseded" });
    expect(await readdir(outParent)).toEqual([]);
  });

  test("cancelling a captured attempt prevents any later publication of it", async () => {
    const { host, bookId, outParent } = await makeHost();
    const attempt = await readyAttempt(host, bookId);
    expect(host.requestCancel(attempt.attemptId)).toEqual({ status: "accepted", attemptId: attempt.attemptId });
    await expect(host.publishAttempt(attempt.attemptId, join(outParent, "cancelled-folder"))).rejects.toMatchObject({
      code: "attempt-cancelled"
    });
    expect(await readdir(outParent)).toEqual([]);
  });

  test("cancellation accepted while publishing prevents the commit and leaves no folder", async () => {
    const { host, bookId, bookDir, outParent } = await makeHost({ withImage: true });
    const before = await snapshotTree(bookDir);
    const attempt = await readyAttempt(host, bookId);
    const destination = join(outParent, "cancelled-while-publishing");
    const pending = host.publishAttempt(attempt.attemptId, destination);
    expect(host.requestCancel(attempt.attemptId)).toEqual({ status: "accepted", attemptId: attempt.attemptId });
    const settlement = await pending;
    expect(settlement).toEqual({
      status: "cancelled",
      message: "The Markdown folder export was cancelled. Nothing was published."
    });
    expect(await readdir(outParent)).toEqual([]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("a destination that appears during staging settles as a name conflict, never as success", async () => {
    const { host, bookId, outParent } = await makeHost({ withImage: true });
    const attempt = await readyAttempt(host, bookId);
    const destination = join(outParent, "appeared-folder");
    const settlement = await host.publishAttempt(attempt.attemptId, destination, {
      afterStagingComplete: async () => {
        await mkdir(destination);
        await writeFile(join(destination, "actor.txt"), "another actor");
      }
    });
    expect(settlement.status).toBe("name-conflict");
    if (settlement.status !== "name-conflict") throw new Error("expected name-conflict settlement");
    expect(settlement.message).toContain("does not replace one");
    expect(await readFile(join(destination, "actor.txt"), "utf8")).toBe("another actor");
    expect((await readdir(destination)).sort()).toEqual(["actor.txt"]);
    expect((await readdir(outParent)).sort()).toEqual(["appeared-folder"]);
    expect(host.requestCancel(attempt.attemptId)).toEqual({ status: "accepted", attemptId: attempt.attemptId });
  });

  test("cancellation after the commit begins is too late", async () => {
    const { host, bookId } = await makeHost();
    const attempt = await readyAttempt(host, bookId);
    attempt.phase = "commit-started";
    expect(host.requestCancel(attempt.attemptId)).toEqual({ status: "too-late", attemptId: attempt.attemptId });
  });
});
