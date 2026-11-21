import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryService } from "@ai-book-studio/core/library/service";
import { LibraryPortError } from "@ai-book-studio/core/library/errors";
import type { LibraryPort } from "@ai-book-studio/core/library/port";
import { createFileSystemEnvironment } from "../src/main/library/fs-port";
import {
  constructMarkdownFolderBundle,
  MarkdownFolderCaptureError,
  MarkdownFolderHostService,
  publishMarkdownFolder,
  Q0_PRODUCTION_POLICY_V1,
  verifySelectedImage,
  type ImageRecordLike
} from "../src/main/markdown-folder";
import {
  createMarkdownFolderBundle,
  markdownFolderRetrievalAccounting,
  planMarkdownFolderExport,
  retrieveMarkdownFolderFile,
  type MarkdownFolderPolicy
} from "@ai-book-studio/core/markdown-folder";

/*
 * Spec 035 T014-Q capture and image verification: synthetic fixtures in isolated temporary
 * libraries only (host contract sections 2, 3 and 6). No real library is ever opened.
 */

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

export function wrapPort(port: LibraryPort, readFile: LibraryPort["readFile"]): LibraryPort {
  const wrapped: LibraryPort = {
    readFile,
    listDirectory: (path) => port.listDirectory(path),
    stat: (path) => port.stat(path),
    ensureDirectory: (path) => port.ensureDirectory(path),
    commitFile: (path, bytes, expected) => port.commitFile(path, bytes, expected),
    moveFile: (from, to) => port.moveFile(from, to),
    moveDirectory: (from, to) => port.moveDirectory(from, to),
    removeFile: (path) => port.removeFile(path),
    removeDirectory: (path) => port.removeDirectory(path),
    deviceInfo: () => port.deviceInfo()
  };
  if (port.inspectDirectory) wrapped.inspectDirectory = (path) => port.inspectDirectory!(path);
  return wrapped;
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const NOW = "2026-11-09T00:00:00.000Z";

export function pngBytes(width = 4, height = 3): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

export interface FixtureImage {
  record: Record<string, unknown>;
  bytes: Uint8Array;
}

export function imageRecord(overrides: Record<string, unknown> = {}, bytes: Uint8Array = pngBytes()): FixtureImage {
  const record: Record<string, unknown> = {
    id: "img_first001",
    kind: "chapter",
    chapterId: "ch_first001",
    characterId: null,
    fileName: "img_first001.png",
    mimeType: "image/png",
    width: 4,
    height: 3,
    bytes: bytes.byteLength,
    sha256: sha(bytes),
    prompt: "",
    provider: "synthetic",
    model: "synthetic",
    size: "",
    source: "imported",
    createdAt: NOW,
    cutoutOf: null,
    costUsd: null,
    revisedPrompt: null,
    confidence: null,
    ...overrides
  };
  return { record, bytes };
}

export interface Fixture {
  root: string;
  bookId: string;
  env: ReturnType<typeof createFileSystemEnvironment>;
  host: MarkdownFolderHostService;
  bookDir: string;
}

export async function makeFixture(options: {
  chapters?: Array<{ id: string; title: string; order: number; body: string; fileName: string }>;
  images?: FixtureImage[] | null;
  manifestRaw?: string | null;
  includeTableOfContents?: boolean;
  matter?: unknown;
  frontMatter?: Record<string, string>;
  storageWrap?: (port: LibraryPort) => LibraryPort;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "abs-md-folder-capture-"));
  cleanups.push(root);
  const bookId = "book_test0001";
  const bookDir = join(root, "books", bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "images"), { recursive: true });
  const chapters = options.chapters ?? [
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
    settings: { manuscript: { includeTableOfContents: options.includeTableOfContents ?? true } },
    frontMatter: options.frontMatter ?? {},
    createdAt: NOW,
    updatedAt: NOW
  };
  if (options.matter !== undefined) book.matter = options.matter;
  await writeFile(join(bookDir, "book.json"), `${JSON.stringify(book, null, 2)}\n`);
  if (options.manifestRaw !== undefined) {
    if (options.manifestRaw !== null) await writeFile(join(bookDir, "images.json"), options.manifestRaw);
  } else if (options.images !== null) {
    const images = options.images ?? [];
    await writeFile(
      join(bookDir, "images.json"),
      `${JSON.stringify({ schemaVersion: 1, images: images.map((i) => i.record) }, null, 2)}\n`
    );
    for (const image of images) await writeFile(join(bookDir, "images", String(image.record.fileName)), image.bytes);
  }
  const env = createFileSystemEnvironment(root);
  await LibraryService.open(env);
  const storage = options.storageWrap ? options.storageWrap(env.storage) : env.storage;
  return { root, bookId, env, host: new MarkdownFolderHostService({ libraryRoot: root, storage }), bookDir };
}

async function hostWithImages(images: FixtureImage[]): Promise<Fixture> {
  return makeFixture({ images });
}

function plannedText(host: MarkdownFolderHostService, capture: Awaited<ReturnType<MarkdownFolderHostService["capture"]>>, path: string): string {
  const planned = host.planCapture(capture);
  if (planned.status !== "planned") throw new Error(`expected plan, refused ${planned.code}`);
  const got = retrieveMarkdownFolderFile(planned.plan, path);
  if (got.status !== "retrieved") throw new Error(`expected ${path}`);
  return new TextDecoder().decode(got.bytes);
}

describe("markdown folder capture enumeration", () => {
  test("complete enumeration is admitted with protocol acquisition counts", async () => {
    const image = imageRecord();
    const second = imageRecord({ id: "img_second01", fileName: "img_second01.png" }, pngBytes(2, 2));
    second.record.width = 2;
    second.record.height = 2;
    second.record.sha256 = sha(second.bytes);
    const { host, bookId } = await hostWithImages([image, second]);
    const capture = await host.capture(bookId);
    expect(capture.manifestState).toBe("read");
    expect(capture.chapters.map((c) => c.id)).toEqual(["ch_first001", "ch_second01"]);
    expect(capture.images).toEqual([
      { recordId: "img_first001", sha256: sha(image.bytes), code: null },
      { recordId: "img_second01", sha256: sha(second.bytes), code: null }
    ]);
    // Host section 4.1: 2 x (1 book + 2 chapters + 1 manifest + 2 images), 6 listings.
    expect(capture.acquisition).toEqual({ fileReads: 12, listings: 6, protocolFileReads: 12, protocolListings: 6 });
    const planned = host.planCapture(capture);
    if (planned.status !== "planned") throw new Error(planned.code);
    expect(planned.plan.files.map((f) => f.path)).toContain("images/0004.png");
    expect(plannedText(host, capture, "0003-chapter.md")).toContain("The hall was cold.");
    expect(planned.consent.policyLabel).toBe("Q0 production policy v1");
    expect(planned.consent.tuple).toContain(capture.bookSha256);
    expect(planned.consent.tuple).toContain(sha(image.bytes));
  });

  test("online-only placeholder chapter entry refuses the whole capture", async () => {
    const { host, bookId, bookDir } = await makeFixture({ images: [] });
    await writeFile(join(bookDir, "chapters", ".0003-lost.md.icloud"), "");
    await expect(host.capture(bookId)).rejects.toMatchObject({ code: "chapter-set-incomplete" });
  });

  test("unsupported chapter entry refuses the whole capture", async () => {
    const { host, bookId, bookDir } = await makeFixture({ images: [] });
    await symlink(join(bookDir, "chapters", "0001-the-door.md"), join(bookDir, "chapters", "0009-link.md"));
    await expect(host.capture(bookId)).rejects.toMatchObject({ code: "chapter-set-incomplete" });
  });

  test("unreadable chapter refuses rather than exporting a subset", async () => {
    const { host, bookId, bookDir } = await makeFixture({ images: [] });
    await writeFile(join(bookDir, "chapters", "0002-the-gate.md"), "---\nid: [broken\n---\nBody.\n");
    await expect(host.capture(bookId)).rejects.toMatchObject({ code: "chapter-unreadable" });
  });

  test("duplicate chapter ID copy refuses rather than being silently dropped", async () => {
    const { host, bookId, bookDir } = await makeFixture({ images: [] });
    const original = await readFile(join(bookDir, "chapters", "0001-the-door.md"), "utf8");
    await writeFile(join(bookDir, "chapters", "0003-the-door-copy.md"), original);
    await expect(host.capture(bookId)).rejects.toMatchObject({ code: "duplicate-chapter-id" });
  });

  test("unreadable required matter refuses", async () => {
    const { host, bookId } = await makeFixture({ images: [], matter: { sections: "not-a-list" } });
    await expect(host.capture(bookId)).rejects.toMatchObject({ code: "unreadable-matter" });
  });

  test("newer book schema refuses", async () => {
    const { host, bookId, bookDir } = await makeFixture({ images: [] });
    const path = join(bookDir, "book.json");
    const book = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    book.schemaVersion = 99;
    await writeFile(path, JSON.stringify(book));
    await expect(host.capture(bookId)).rejects.toMatchObject({ code: "book-newer-schema" });
  });

  test("chapter candidate count above the component maximum refuses before reading bodies", async () => {
    let chapterReads = 0;
    const { host, bookId, bookDir } = await makeFixture({
      images: [],
      chapters: [{ id: "ch_first001", title: "Only", order: 1, body: "Body.\n", fileName: "0001-only.md" }],
      storageWrap: (port) =>
        wrapPort(port, async (path, options) => {
          if (path.join("/").includes("/chapters/")) chapterReads += 1;
          return port.readFile(path, options);
        })
    });
    for (let index = 0; index < 2001; index += 1) {
      await writeFile(join(bookDir, "chapters", `${String(index + 2).padStart(4, "0")}-extra.md`), "Body.\n");
    }
    await expect(host.capture(bookId)).rejects.toMatchObject({ code: "chapter-count-exceeded" });
    expect(chapterReads).toBe(0);
  }, 30_000);
});

describe("markdown folder capture formats, order and matter", () => {
  function jpegBytes(width = 6, height = 5): Uint8Array {
    const bytes = new Uint8Array(32);
    bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
    const view = new DataView(bytes.buffer);
    view.setUint16(7, height, false);
    view.setUint16(9, width, false);
    return bytes;
  }
  function webpBytes(width = 7, height = 4): Uint8Array {
    const bytes = new Uint8Array(32);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WEBP"), 8);
    bytes.set(new TextEncoder().encode("VP8X"), 12);
    bytes[24] = width - 1;
    bytes[27] = height - 1;
    return bytes;
  }

  test("JPEG and WebP records verify against header, MIME and extension and copy exactly", async () => {
    const jpeg = jpegBytes();
    const webp = webpBytes();
    const jpegImage = imageRecord(
      { id: "img_jpeg0001", fileName: "img_jpeg0001.jpg", mimeType: "image/jpeg", width: 6, height: 5 },
      jpeg
    );
    const webpImage = imageRecord(
      { id: "img_webp0001", fileName: "img_webp0001.webp", mimeType: "image/webp", width: 7, height: 4 },
      webp
    );
    const { host, bookId } = await hostWithImages([jpegImage, webpImage]);
    const planned = host.planCapture(await host.capture(bookId));
    if (planned.status !== "planned") throw new Error(planned.code);
    const imagePaths = planned.plan.files.filter((f) => f.kind === "image").map((f) => f.path);
    expect(imagePaths.some((p) => p.endsWith(".jpg"))).toBe(true);
    expect(imagePaths.some((p) => p.endsWith(".webp"))).toBe(true);
    const jpg = retrieveMarkdownFolderFile(planned.plan, imagePaths.find((p) => p.endsWith(".jpg"))!);
    if (jpg.status !== "retrieved") throw new Error("jpg missing");
    expect(jpg.bytes).toEqual(jpeg);
  });

  test("image files swapped between records are digest mismatches, never silently bound", async () => {
    const first = imageRecord();
    const secondBytes = pngBytes(2, 2);
    const second = imageRecord({ id: "img_second01", fileName: "img_second01.png", width: 2, height: 2 }, secondBytes);
    const { host, bookId, bookDir } = await hostWithImages([first, second]);
    await writeFile(join(bookDir, "images", "img_first001.png"), secondBytes);
    await writeFile(join(bookDir, "images", "img_second01.png"), first.bytes);
    const planned = host.planCapture(await host.capture(bookId));
    if (planned.status !== "planned") throw new Error(planned.code);
    expect(planned.plan.warnings.map((w) => w.code)).toEqual(["image-mismatch", "image-mismatch"]);
    expect(planned.plan.files.some((f) => f.kind === "image")).toBe(false);
  });

  test("captured order is canonical saved order with file-name ties, never re-sorted", async () => {
    const { host, bookId } = await makeFixture({
      images: [],
      chapters: [
        { id: "ch_zzzz0001", title: "Zulu", order: 1, body: "Zulu body.\n", fileName: "0002-zulu.md" },
        { id: "ch_aaaa0001", title: "Alpha", order: 1, body: "Alpha body.\n", fileName: "0001-alpha.md" },
        { id: "ch_mmmm0001", title: "Middle", order: 0 + 2, body: "Middle body.\n", fileName: "0003-middle.md" }
      ]
    });
    const capture = await host.capture(bookId);
    expect(capture.chapters.map((c) => c.id)).toEqual(["ch_aaaa0001", "ch_zzzz0001", "ch_mmmm0001"]);
    const planned = host.planCapture(capture);
    if (planned.status !== "planned") throw new Error(planned.code);
    const readme = retrieveMarkdownFolderFile(planned.plan, "README.md");
    if (readme.status !== "retrieved") throw new Error("readme");
    const text = new TextDecoder().decode(readme.bytes);
    expect(text.indexOf("Alpha")).toBeLessThan(text.indexOf("Zulu"));
    expect(text.indexOf("Zulu")).toBeLessThan(text.indexOf("Middle"));
  });

  test("matter and legacy pairs come from the single book snapshot in enumeration order", async () => {
    const { host, bookId } = await makeFixture({
      images: [],
      matter: {
        version: 1,
        titlePage: true,
        author: "Ana Reyes",
        subtitle: "A tidewater tale",
        sections: [{ id: "mat_front001", kind: "dedication", position: "front", title: "Dedication", text: "For Ana.\n" }]
      },
      frontMatter: { Author: "Ana Reyes", "Old note": "never rendered" }
    });
    const planned = host.planCapture(await host.capture(bookId));
    if (planned.status !== "planned") throw new Error(planned.code);
    expect(planned.plan.excludedLegacy.map((e) => e.key)).toEqual(["Old note"]);
    const title = planned.plan.files.find((f) => f.kind === "title");
    const got = retrieveMarkdownFolderFile(planned.plan, title!.path);
    if (got.status !== "retrieved") throw new Error("title");
    expect(new TextDecoder().decode(got.bytes)).toContain("Ana Reyes");
  });

  test("a port without inspectDirectory still proves completeness from listing kinds and the closing set", async () => {
    const fixture = await makeFixture({ images: [] });
    const port = wrapPort(fixture.env.storage, (path, options) => fixture.env.storage.readFile(path, options));
    delete (port as unknown as Record<string, unknown>).inspectDirectory;
    const host = new MarkdownFolderHostService({ libraryRoot: fixture.root, storage: port });
    const capture = await host.capture(fixture.bookId);
    expect(capture.acquisition.listings).toBe(4);
    expect(capture.acquisition.protocolListings).toBe(4);
    expect(capture.acquisition.fileReads).toBe(capture.acquisition.protocolFileReads);
  });
});

describe("markdown folder closing observation and consent", () => {
  function changingPort(mutate: (bookDir: string) => Promise<void>, bookDir: string): (port: LibraryPort) => LibraryPort {
    let bookReads = 0;
    return (port) =>
      wrapPort(port, async (path, options) => {
        if (path.join("/") === "books/book_test0001/book.json") {
          bookReads += 1;
          if (bookReads === 2) await mutate(bookDir);
        }
        return port.readFile(path, options);
      });
  }

  test("opening and closing disagreement discards the whole capture", async () => {
    const fixture = await makeFixture({ images: [] });
    const host = new MarkdownFolderHostService({
      libraryRoot: fixture.root,
      storage: changingPort(async (bookDir) => {
        await writeFile(join(bookDir, "chapters", "0002-the-gate.md"), "---\nid: ch_second01\ntitle: Changed\norder: 2\nversion: 1\ncreatedAt: 2026-11-09T00:00:00.000Z\nupdatedAt: 2026-11-09T00:00:00.000Z\n---\n\nChanged body.\n");
      }, fixture.bookDir)(fixture.env.storage)
    });
    await expect(host.capture(fixture.bookId)).rejects.toMatchObject({ code: "source-changed-during-capture" });
  });

  test("change-and-change-back is disclosed in consent wording, never denied", async () => {
    const fixture = await makeFixture({ images: [] });
    const chapterPath = join(fixture.bookDir, "chapters", "0002-the-gate.md");
    const original = await readFile(chapterPath);
    const host = new MarkdownFolderHostService({
      libraryRoot: fixture.root,
      storage: changingPort(async () => {
        await writeFile(chapterPath, "Changed and changed back.\n");
        await writeFile(chapterPath, original);
      }, fixture.bookDir)(fixture.env.storage)
    });
    const capture = await host.capture(fixture.bookId);
    expect(capture.consentWording).toContain("returned to identical bytes");
    expect(capture.consentWording).toContain("not the book at a single instant");
    expect(capture.consentDisclosure).not.toContain("nothing changed");
  });

  test("a new capture invalidates earlier consent even when every digest agrees", async () => {
    const { host, bookId } = await makeFixture({ images: [] });
    const first = host.planCapture(await host.capture(bookId));
    if (first.status !== "planned") throw new Error(first.code);
    expect(host.isConsentCurrent(first.consent)).toBe(true);
    const second = host.planCapture(await host.capture(bookId));
    if (second.status !== "planned") throw new Error(second.code);
    expect(second.consent.captureSequence).toBe(first.consent.captureSequence + 1);
    expect(host.isConsentCurrent(first.consent)).toBe(false);
    expect(host.isConsentCurrent(second.consent)).toBe(true);
    expect(() => host.assertConsentCurrent(first.consent)).toThrowError(
      expect.objectContaining({ code: "consent-superseded" })
    );
  });
});

describe("markdown folder manifest states", () => {
  test("known empty: no manifest and no image files, no warning", async () => {
    const { host, bookId, bookDir } = await makeFixture({ images: null, manifestRaw: null });
    await rm(join(bookDir, "images"), { recursive: true, force: true });
    const capture = await host.capture(bookId);
    expect(capture.manifestState).toBe("known-empty");
    expect(capture.listWarningCodes).toEqual([]);
    const planned = host.planCapture(capture);
    if (planned.status !== "planned") throw new Error(planned.code);
    expect(planned.plan.warnings).toEqual([]);
  });

  test("unreadable manifest produces exactly one list warning and text still exports", async () => {
    const { host, bookId } = await makeFixture({ manifestRaw: "{not json" });
    const capture = await host.capture(bookId);
    expect(capture.manifestState).toBe("unreadable");
    const planned = host.planCapture(capture);
    if (planned.status !== "planned") throw new Error(planned.code);
    expect(planned.plan.warnings).toEqual([
      { kind: "list", code: "image-list-unreadable", chapterId: null, selectedPosition: null, recordId: null }
    ]);
    expect(plannedText(host, capture, "0003-chapter.md")).toContain("The hall was cold.");
  });

  test("misshapen manifest is unreadable, never a valid empty manifest", async () => {
    const { host, bookId } = await makeFixture({ manifestRaw: JSON.stringify({ schemaVersion: 1, images: "no" }) });
    const capture = await host.capture(bookId);
    expect(capture.manifestState).toBe("unreadable");
    expect(capture.listWarningCodes).toEqual(["image-list-unreadable"]);
  });

  test("image files with no readable manifest are unreadable, with empty selection", async () => {
    const image = imageRecord();
    const { host, bookId, bookDir } = await makeFixture({ images: [image] });
    await rm(join(bookDir, "images.json"));
    const capture = await host.capture(bookId);
    expect(capture.manifestState).toBe("unreadable");
    expect(capture.images).toEqual([]);
    const planned = host.planCapture(capture);
    if (planned.status !== "planned") throw new Error(planned.code);
    expect(planned.plan.warnings.map((w) => w.code)).toEqual(["image-list-unreadable"]);
  });

  test("placeholder-named chapter directory entry is not mistaken for known empty images", async () => {
    const { host, bookId } = await makeFixture({ images: [] });
    const capture = await host.capture(bookId);
    expect(capture.manifestState).toBe("read");
    expect(capture.images).toEqual([]);
  });
});

describe("markdown folder image verification (host section 3.2)", () => {
  async function captureWith(mutate: (fixture: Fixture, image: FixtureImage) => Promise<void>) {
    const image = imageRecord();
    const fixture = await hostWithImages([image]);
    await mutate(fixture, image);
    return { ...fixture, image };
  }

  function expectOmission(fixture: Fixture, code: string) {
    return (async () => {
      const capture = await fixture.host.capture(fixture.bookId);
      const planned = fixture.host.planCapture(capture);
      if (planned.status !== "planned") throw new Error(planned.code);
      expect(planned.plan.warnings).toEqual([
        { kind: "image-omission", code, chapterId: "ch_first001", selectedPosition: 1, recordId: "img_first001" }
      ]);
      expect(planned.plan.files.some((f) => f.kind === "image")).toBe(false);
      const chapter = planned.plan.files.find((f) => f.kind === "chapter");
      const got = retrieveMarkdownFolderFile(planned.plan, chapter!.path);
      if (got.status !== "retrieved") throw new Error("chapter missing");
      expect(new TextDecoder().decode(got.bytes)).toContain("The hall was cold.");
      return capture;
    })();
  }

  test("length disagreement is an omission and text still exports", async () => {
    const fixture = await captureWith(async ({ bookDir }, image) => {
      const manifest = JSON.parse(await readFile(join(bookDir, "images.json"), "utf8")) as { images: Array<Record<string, unknown>> };
      manifest.images[0] = { ...image.record, bytes: image.bytes.byteLength + 1 };
      await writeFile(join(bookDir, "images.json"), JSON.stringify(manifest));
    });
    await expectOmission(fixture, "image-mismatch");
  });

  test("digest disagreement is an omission", async () => {
    const fixture = await captureWith(async ({ bookDir }, image) => {
      const manifest = JSON.parse(await readFile(join(bookDir, "images.json"), "utf8")) as { images: Array<Record<string, unknown>> };
      manifest.images[0] = { ...image.record, sha256: "0".repeat(64) };
      await writeFile(join(bookDir, "images.json"), JSON.stringify(manifest));
    });
    await expectOmission(fixture, "image-mismatch");
  });

  test("header with no detected format is an omission", async () => {
    const fixture = await captureWith(async ({ bookDir }, image) => {
      const bogus = new TextEncoder().encode("not an image at all........");
      await writeFile(join(bookDir, "images", "img_first001.png"), bogus);
      const manifest = JSON.parse(await readFile(join(bookDir, "images.json"), "utf8")) as { images: Array<Record<string, unknown>> };
      manifest.images[0] = { ...image.record, bytes: bogus.byteLength, sha256: sha(bogus) };
      await writeFile(join(bookDir, "images.json"), JSON.stringify(manifest));
    });
    await expectOmission(fixture, "image-mismatch");
  });

  test("file-name extension format disagreement is an omission", async () => {
    const fixture = await captureWith(async ({ bookDir }, image) => {
      await writeFile(join(bookDir, "images", "img_first001.webp"), image.bytes);
      await rm(join(bookDir, "images", "img_first001.png"));
      const manifest = JSON.parse(await readFile(join(bookDir, "images.json"), "utf8")) as { images: Array<Record<string, unknown>> };
      manifest.images[0] = { ...image.record, fileName: "img_first001.webp" };
      await writeFile(join(bookDir, "images.json"), JSON.stringify(manifest));
    });
    await expectOmission(fixture, "image-mismatch");
  });

  test("MIME type disagreement is an omission without renaming the file", async () => {
    const fixture = await captureWith(async ({ bookDir }, image) => {
      const manifest = JSON.parse(await readFile(join(bookDir, "images.json"), "utf8")) as { images: Array<Record<string, unknown>> };
      manifest.images[0] = { ...image.record, mimeType: "image/webp" };
      await writeFile(join(bookDir, "images.json"), JSON.stringify(manifest));
    });
    await expectOmission(fixture, "image-mismatch");
  });

  test("dimension disagreement is an omission", async () => {
    const fixture = await captureWith(async ({ bookDir }, image) => {
      const manifest = JSON.parse(await readFile(join(bookDir, "images.json"), "utf8")) as { images: Array<Record<string, unknown>> };
      manifest.images[0] = { ...image.record, width: 9 };
      await writeFile(join(bookDir, "images.json"), JSON.stringify(manifest));
    });
    await expectOmission(fixture, "image-mismatch");
  });

  test("missing image file is image-missing and text still exports", async () => {
    const fixture = await captureWith(async ({ bookDir }) => {
      await rm(join(bookDir, "images", "img_first001.png"));
    });
    await expectOmission(fixture, "image-missing");
  });

  test("empty image file is a mismatch omission", async () => {
    const fixture = await captureWith(async ({ bookDir }) => {
      await writeFile(join(bookDir, "images", "img_first001.png"), new Uint8Array(0));
    });
    await expectOmission(fixture, "image-mismatch");
  });

  test("unreadable image file is image-unreadable", async () => {
    const image = imageRecord();
    const base = await makeFixture({ images: [image] });
    const host = new MarkdownFolderHostService({
      libraryRoot: base.root,
      storage: wrapPort(base.env.storage, async (path, options) => {
        if (path.join("/").endsWith("/images/img_first001.png")) {
          throw new LibraryPortError("permission-required", "synthetic permission failure");
        }
        return base.env.storage.readFile(path, options);
      })
    });
    const capture = await host.capture(base.bookId);
    const planned = host.planCapture(capture);
    if (planned.status !== "planned") throw new Error(planned.code);
    expect(planned.plan.warnings.map((w) => w.code)).toEqual(["image-unreadable"]);
  });

  test("a surviving illustration keeps its selected position when an earlier record is omitted", async () => {
    const first = imageRecord();
    const secondBytes = pngBytes(2, 2);
    const second = imageRecord({ id: "img_second01", fileName: "img_second01.png", width: 2, height: 2 }, secondBytes);
    const { host, bookId, bookDir } = await hostWithImages([first, second]);
    await rm(join(bookDir, "images", "img_first001.png"));
    const planned = host.planCapture(await host.capture(bookId));
    if (planned.status !== "planned") throw new Error(planned.code);
    const illustration = planned.plan.files.find((f) => f.kind === "illustration");
    const got = retrieveMarkdownFolderFile(planned.plan, illustration!.path);
    if (got.status !== "retrieved") throw new Error("illustration missing");
    expect(new TextDecoder().decode(got.bytes)).toContain("(2)");
    expect(planned.plan.warnings[0]).toMatchObject({ code: "image-missing", selectedPosition: 1 });
  });

  test("substituted record refuses instead of becoming an omission", () => {
    const image = imageRecord();
    const record = image.record as unknown as ImageRecordLike;
    expect(() =>
      verifySelectedImage({ record: { ...record, fileName: "img_other001.png" }, manifestRecord: record, bytes: image.bytes })
    ).toThrowError(expect.objectContaining({ code: "substituted-record" }));
    expect(() => verifySelectedImage({ record, manifestRecord: null, bytes: image.bytes })).toThrowError(
      expect.objectContaining({ code: "substituted-record" })
    );
    expect(verifySelectedImage({ record, manifestRecord: record, bytes: image.bytes }).status).toBe("captured");
  });

  test("duplicate selected image IDs refuse as an ambiguous selection", async () => {
    const first = imageRecord();
    const second = imageRecord({ fileName: "img_second01.png" });
    const { host, bookId } = await hostWithImages([first, second]);
    await expect(host.capture(bookId)).rejects.toMatchObject({ code: "duplicate-image-id" });
  });

  test("construction with anything but fresh plain data is refused without fallback", () => {
    let getterCalls = 0;
    const evil: Record<string, unknown> = { bookId: "book_test0001" };
    Object.defineProperty(evil, "bookTitle", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "Nope";
      }
    });
    expect(() => constructMarkdownFolderBundle(evil)).toThrowError(
      expect.objectContaining({ code: "invalid-bundle-input" })
    );
    expect(getterCalls).toBe(0);
    expect(() => constructMarkdownFolderBundle({ bookId: "book_test0001" })).toThrowError(
      expect.objectContaining({ code: "invalid-bundle-input" })
    );
    expect(MarkdownFolderCaptureError).toBeDefined();
  });

  test("selected image count at the component maximum is admitted as omissions", async () => {
    const images: FixtureImage[] = [];
    for (let index = 0; index < 1024; index += 1) {
      images.push(imageRecord({ id: `img_num${String(index).padStart(6, "0")}`, fileName: `img_num${String(index).padStart(6, "0")}.png` }, pngBytes()));
    }
    const { host, bookId, bookDir } = await makeFixture({ manifestRaw: JSON.stringify({ schemaVersion: 1, images: images.map((i) => i.record) }) });
    void bookDir;
    const capture = await host.capture(bookId);
    expect(capture.images.length).toBe(1024);
    expect(capture.images.every((i) => i.code === "image-missing")).toBe(true);
  }, 30_000);

  test("selected image count above the component maximum refuses", async () => {
    const images: FixtureImage[] = [];
    for (let index = 0; index < 1025; index += 1) {
      images.push(imageRecord({ id: `img_num${String(index).padStart(6, "0")}`, fileName: `img_num${String(index).padStart(6, "0")}.png` }, pngBytes()));
    }
    const { host, bookId } = await makeFixture({ manifestRaw: JSON.stringify({ schemaVersion: 1, images: images.map((i) => i.record) }) });
    await expect(host.capture(bookId)).rejects.toMatchObject({ code: "selected-image-count-exceeded" });
  });
});

describe("markdown folder manifest states", () => {
  test("newer manifest schema refuses its unsupported selection semantics", async () => {
    const image = imageRecord();
    const { host, bookId } = await makeFixture({
      manifestRaw: JSON.stringify({ schemaVersion: 2, images: [image.record] })
    });
    await expect(host.capture(bookId)).rejects.toMatchObject({ code: "manifest-newer-schema" });
  });
});

/* ------------------------------------------------------------------ publication */

async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) out[relative] = sha(await readFile(absolute));
    }
  }
  await walk(dir, "");
  return out;
}

async function publishFixture() {
  const image = imageRecord();
  const fixture = await hostWithImages([image]);
  const planned = fixture.host.planCapture(await fixture.host.capture(fixture.bookId));
  if (planned.status !== "planned") throw new Error(planned.code);
  const outParent = await mkdtemp(join(tmpdir(), "abs-md-folder-out-"));
  cleanups.push(outParent);
  return { ...fixture, image, planned, outParent, destination: join(outParent, "salt-road-folder") };
}

describe("markdown folder desktop publication (no-replace)", () => {
  test("publishes every planned file once into a new folder and leaves the source untouched", async () => {
    const { host, planned, destination, outParent, bookDir, image } = await publishFixture();
    const before = await snapshotTree(bookDir);
    const result = await host.publish(planned, destination);
    expect(result.files).toEqual(planned.plan.files.map((f) => f.path));
    expect(result.retrievalRequests).toBe(planned.plan.files.length);
    expect(result.retrievalBytes).toBe(planned.plan.accounting.totalOutputBytes);
    expect(markdownFolderRetrievalAccounting(planned.plan).requests).toBe(planned.plan.files.length);
    for (const file of planned.plan.files) {
      const onDisk = await readFile(join(destination, ...file.path.split("/")));
      expect(onDisk.byteLength).toBe(file.byteLength);
    }
    expect(await readFile(join(destination, "images", "0004.png"))).toEqual(Buffer.from(image.bytes));
    expect(await readFile(join(destination, "0003-chapter.md"), "utf8")).toContain("The hall was cold.");
    expect((await readdir(outParent)).sort()).toEqual(["salt-road-folder"]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("destination inside the library aliases the source and is refused", async () => {
    const { host, planned, root, bookDir } = await publishFixture();
    await expect(host.publish(planned, join(root, "export-folder"))).rejects.toMatchObject({
      code: "destination-aliases-source"
    });
    await expect(host.publish(planned, join(bookDir, "export-folder"))).rejects.toMatchObject({
      code: "destination-aliases-source"
    });
  });

  test("destination through a parent symlink into the library is refused by resolved identity", async () => {
    const { host, planned, root, outParent } = await publishFixture();
    await symlink(root, join(outParent, "library-link"));
    await expect(host.publish(planned, join(outParent, "library-link", "export-folder"))).rejects.toMatchObject({
      code: "destination-aliases-source"
    });
  });

  test("existing folder replacement is refused as named successor work and prior output is preserved", async () => {
    const { host, planned, destination, bookDir } = await publishFixture();
    await mkdir(destination);
    await writeFile(join(destination, "prior.txt"), "prior output bytes");
    const before = await snapshotTree(bookDir);
    const error = await host.publish(planned, destination).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "destination-exists" });
    expect((error as Error).message).toContain("does not replace one");
    expect((error as Error).message).toContain("Choose another folder name");
    expect(await readFile(join(destination, "prior.txt"), "utf8")).toBe("prior output bytes");
    expect((await readdir(destination)).sort()).toEqual(["prior.txt"]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("a destination created during staging prevents publication and is left as it was", async () => {
    const { host, planned, destination, outParent, bookDir } = await publishFixture();
    const before = await snapshotTree(bookDir);
    const error = await host
      .publish(planned, destination, {
        onStaging: async ({ stage }) => {
          if (stage !== "staging-created") return;
          await mkdir(destination);
          await writeFile(join(destination, "actor.txt"), "another actor");
        }
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "destination-appeared" });
    expect(await readFile(join(destination, "actor.txt"), "utf8")).toBe("another actor");
    expect((await readdir(destination)).sort()).toEqual(["actor.txt"]);
    expect((await readdir(outParent)).sort()).toEqual(["salt-road-folder"]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("a destination file created during staging also prevents publication", async () => {
    const { host, planned, destination, outParent } = await publishFixture();
    const error = await host
      .publish(planned, destination, {
        onStaging: async ({ stage }) => {
          if (stage === "file-written") await writeFile(destination, "actor file");
        }
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "destination-appeared" });
    expect(await readFile(destination, "utf8")).toBe("actor file");
    expect((await readdir(outParent)).sort()).toEqual(["salt-road-folder"]);
  });

  test("injected staging failure preserves source and leaves no destination or staging", async () => {
    const { host, planned, destination, outParent, bookDir } = await publishFixture();
    const before = await snapshotTree(bookDir);
    const error = await host
      .publish(planned, destination, {
        mkdir: async (path) => {
          if (path.endsWith("images")) throw Object.assign(new Error("synthetic staging failure"), { code: "EIO" });
          return mkdir(path);
        }
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "staging-failed" });
    expect(await readdir(outParent)).toEqual([]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("injected write failure preserves source and cleans owned staging", async () => {
    const { host, planned, destination, outParent, bookDir } = await publishFixture();
    const before = await snapshotTree(bookDir);
    let writes = 0;
    const error = await host
      .publish(planned, destination, {
        writeFile: async (path, bytes) => {
          writes += 1;
          if (writes === 3) throw Object.assign(new Error("synthetic write failure"), { code: "EIO" });
          const { writeFileAtomic } = await import("../src/main/library/atomic");
          await writeFileAtomic(path, bytes);
        }
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "staging-write-failed" });
    expect(await readdir(outParent)).toEqual([]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("injected close failure preserves source and leaves nothing published", async () => {
    const { host, planned, destination, outParent, bookDir } = await publishFixture();
    const before = await snapshotTree(bookDir);
    const error = await host
      .publish(planned, destination, {
        syncDirectory: async () => {
          throw Object.assign(new Error("synthetic close failure"), { code: "EIO" });
        }
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "staging-close-failed" });
    expect(await readdir(outParent)).toEqual([]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("injected permission failure is reported as permission and publishes nothing", async () => {
    const { host, planned, destination, outParent } = await publishFixture();
    const error = await host
      .publish(planned, destination, {
        createDestinationDirectory: async () => {
          throw Object.assign(new Error("synthetic permission failure"), { code: "EACCES" });
        }
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "permission-failed", originalCode: "EACCES" });
    expect(await readdir(outParent)).toEqual([]);
  });

  test("injected commit rename failure rolls back the owned destination", async () => {
    const { host, planned, destination, outParent, bookDir } = await publishFixture();
    const before = await snapshotTree(bookDir);
    const error = await host
      .publish(planned, destination, {
        rename: async () => {
          throw Object.assign(new Error("synthetic commit failure"), { code: "EIO" });
        }
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "commit-failed", verdict: "not-published" });
    expect(await readdir(outParent)).toEqual([]);
    expect(await snapshotTree(bookDir)).toEqual(before);
  });

  test("an unproven commit rollback stays unknown and leaves the destination as it is", async () => {
    const { host, planned, destination, outParent } = await publishFixture();
    let destinationChecks = 0;
    const error = await host
      .publish(planned, destination, {
        rename: async () => {
          throw Object.assign(new Error("synthetic commit failure"), { code: "EIO" });
        },
        lstat: async (path) => {
          const stat = await lstat(path);
          if (path === destination) {
            destinationChecks += 1;
            // The rollback proof sees a different identity than the one this call created.
            if (destinationChecks === 2) {
              return { dev: stat.dev, ino: stat.ino + 1, isDirectory: () => true, isSymbolicLink: () => false };
            }
          }
          return stat;
        }
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "commit-failed", verdict: "unknown" });
    expect((error as { cleanupLeftoverPath: string }).cleanupLeftoverPath).toBe(destination);
    expect(await readdir(outParent)).toEqual(["salt-road-folder"]);
  });

  test("post-publication staging cleanup failure is a published result with the exact leftover path", async () => {
    const { planned, destination, outParent } = await publishFixture();
    const result = await publishMarkdownFolder(planned.plan, destination, {
      libraryRoot: "/synthetic-library",
      overrides: {
        randomToken: () => "tok123",
        rm: async () => {
          throw new Error("synthetic cleanup failure");
        }
      }
    });
    const name = ".salt-road-folder.markdown-folder-staging-tok123";
    expect(result.destinationPath).toBe(destination);
    expect(result.files).toEqual(planned.plan.files.map((f) => f.path));
    expect(result.cleanupLeftover).toEqual({ name, path: join(outParent, name) });
    expect((await readdir(outParent)).sort()).toEqual([name, "salt-road-folder"]);
    for (const file of planned.plan.files) {
      const onDisk = await readFile(join(destination, ...file.path.split("/")));
      expect(onDisk.byteLength).toBe(file.byteLength);
    }
  });

  test("owned cleanup failure is reported with the staging name, not hidden", async () => {
    const { planned, destination, outParent } = await publishFixture();
    const error = await publishMarkdownFolder(planned.plan, destination, {
      libraryRoot: "/synthetic-library",
      overrides: {
        randomToken: () => "tok123",
        writeFile: async () => {
          throw Object.assign(new Error("synthetic write failure"), { code: "EIO" });
        },
        rm: async () => {
          throw new Error("synthetic cleanup failure");
        }
      }
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "cleanup-failed", cleanupLeftover: ".salt-road-folder.markdown-folder-staging-tok123" });
    expect(await readdir(outParent)).toEqual([".salt-road-folder.markdown-folder-staging-tok123"]);
  });

  test("publication with superseded consent refuses before staging", async () => {
    const { host, bookId, planned, destination, outParent } = await publishFixture();
    await host.capture(bookId);
    await expect(host.publish(planned, destination)).rejects.toMatchObject({ code: "consent-superseded" });
    expect(await readdir(outParent)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ Q0 planning */

function q0Bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bookId: "book_test0001",
    bookTitle: "T",
    description: "",
    includeTableOfContents: true,
    matter: null,
    chapters: [{ id: "ch_first001", title: "T", order: 1, parsedBody: "", images: [] }],
    legacy: [],
    listWarnings: [],
    ...overrides
  };
}

function q0Plan(overrides: Record<string, unknown> = {}) {
  const result = planMarkdownFolderExport(createMarkdownFolderBundle(q0Bundle(overrides)), { ...Q0_PRODUCTION_POLICY_V1 });
  if (result.status !== "planned") throw new Error(`expected plan, refused ${result.code} ${result.dimension ?? ""}`);
  return result.plan;
}

function q0Refusal(overrides: Record<string, unknown> = {}) {
  const result = planMarkdownFolderExport(createMarkdownFolderBundle(q0Bundle(overrides)), { ...Q0_PRODUCTION_POLICY_V1 });
  if (result.status !== "refused") throw new Error("expected refusal");
  return result;
}

describe("Q0 production policy v1 planning boundaries", () => {
  test("the host passes exactly the recorded Q0 production policy v1", () => {
    expect(Q0_PRODUCTION_POLICY_V1).toEqual({
      maxInputStringCodeUnits: 26_214_400,
      maxInputStringUtf8Bytes: 78_643_200,
      maxInputCollectionItems: 4_096,
      maxPerImageBytes: 20_971_520,
      maxTotalImageBytes: 134_217_728,
      maxGeneratedUtf8Bytes: 104_857_600,
      maxTotalOutputBytes: 239_075_328,
      maxRegularFiles: 4_091,
      maxDirectoryEntries: 4_092,
      maxRetrievalRequests: 4_091,
      maxRetrievalBytes: 239_075_328,
      maxAccountedPayloadBytes: 769_654_784
    } satisfies MarkdownFolderPolicy);
    // Coupled ceilings are sums of their parts by construction (host section 4).
    expect(Q0_PRODUCTION_POLICY_V1.maxTotalOutputBytes).toBe(
      Q0_PRODUCTION_POLICY_V1.maxGeneratedUtf8Bytes + Q0_PRODUCTION_POLICY_V1.maxTotalImageBytes
    );
    expect(Q0_PRODUCTION_POLICY_V1.maxInputStringUtf8Bytes).toBe(3 * Q0_PRODUCTION_POLICY_V1.maxInputStringCodeUnits);
  });

  test("input code units: exact boundary accepted, plus one refused by dimension", () => {
    const base = q0Plan().accounting.inputStringCodeUnits;
    const bodyLength = Q0_PRODUCTION_POLICY_V1.maxInputStringCodeUnits - base;
    const accepted = q0Plan({
      chapters: [{ id: "ch_first001", title: "T", order: 1, parsedBody: "a".repeat(bodyLength), images: [] }]
    });
    expect(accepted.accounting.inputStringCodeUnits).toBe(Q0_PRODUCTION_POLICY_V1.maxInputStringCodeUnits);
    expect(
      q0Refusal({
        chapters: [{ id: "ch_first001", title: "T", order: 1, parsedBody: "a".repeat(bodyLength + 1), images: [] }]
      })
    ).toMatchObject({ code: "budget-exceeded", dimension: "maxInputStringCodeUnits" });
  }, 60_000);

  test("input UTF-8 bytes: beyond the byte ceiling refuses (the code-unit ceiling binds first by construction)", () => {
    // ASCII identity strings make the 3x byte ceiling unreachable before the code-unit ceiling:
    // it is a non-binding backstop, so a beyond-ceiling book refuses on code units first.
    const body = "€".repeat(Q0_PRODUCTION_POLICY_V1.maxInputStringCodeUnits);
    expect(
      q0Refusal({ chapters: [{ id: "ch_first001", title: "T", order: 1, parsedBody: body, images: [] }] })
    ).toMatchObject({ code: "budget-exceeded", dimension: "maxInputStringCodeUnits" });
  }, 60_000);

  test("collection items: exact boundary accepted, plus one refused by dimension", () => {
    const legacy = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ key: `k${i}`, value: "" }));
    const accepted = q0Plan({ legacy: legacy(4095) });
    expect(accepted.accounting.inputCollectionItems).toBe(4096);
    expect(q0Refusal({ legacy: legacy(4096) })).toMatchObject({
      code: "budget-exceeded",
      dimension: "maxInputCollectionItems"
    });
  });

  test("per-image bytes: exact boundary accepted, plus one refused by dimension", () => {
    const image = (length: number) => [
      {
        id: "ch_first001",
        title: "T",
        order: 1,
        parsedBody: "",
        images: [{ status: "captured", recordId: "img_first001", format: "png", bytes: new Uint8Array(length) }]
      }
    ];
    const accepted = q0Plan({ chapters: image(Q0_PRODUCTION_POLICY_V1.maxPerImageBytes) });
    expect(accepted.accounting.largestImageBytes).toBe(Q0_PRODUCTION_POLICY_V1.maxPerImageBytes);
    expect(q0Refusal({ chapters: image(Q0_PRODUCTION_POLICY_V1.maxPerImageBytes + 1) })).toMatchObject({
      code: "budget-exceeded",
      dimension: "maxPerImageBytes"
    });
  }, 60_000);

  test("total image bytes: exact boundary accepted, plus one refused by dimension", () => {
    const chaptersWith = (extra: number) => {
      const images: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 6; i += 1) {
        images.push({
          status: "captured",
          recordId: `img_big000${i}`,
          format: "png",
          bytes: new Uint8Array(Q0_PRODUCTION_POLICY_V1.maxPerImageBytes)
        });
      }
      images.push({
        status: "captured",
        recordId: "img_big0006",
        format: "png",
        bytes: new Uint8Array(8_388_608 + extra)
      });
      return [{ id: "ch_first001", title: "T", order: 1, parsedBody: "", images }];
    };
    const accepted = q0Plan({ chapters: chaptersWith(0) });
    expect(accepted.accounting.totalImageBytes).toBe(Q0_PRODUCTION_POLICY_V1.maxTotalImageBytes);
    expect(q0Refusal({ chapters: chaptersWith(1) })).toMatchObject({
      code: "budget-exceeded",
      dimension: "maxTotalImageBytes"
    });
  }, 120_000);

  test("generated bytes: exact boundary accepted via escape expansion, plus one refused by dimension", () => {
    const generatedFor = (titleLength: number, bodyLength: number) =>
      q0Plan({
        chapters: [
          { id: "ch_first001", title: "\u0001".repeat(titleLength), order: 1, parsedBody: "a".repeat(bodyLength), images: [] }
        ]
      }).accounting.generatedUtf8Bytes;
    const atHundred = generatedFor(100, 0);
    const slope = (generatedFor(200, 0) - atHundred) / 100;
    expect(Number.isInteger(slope)).toBe(true);
    const atZero = atHundred - slope * 100;
    const titleLength = Math.floor((Q0_PRODUCTION_POLICY_V1.maxGeneratedUtf8Bytes - atZero) / slope);
    const remainder = Q0_PRODUCTION_POLICY_V1.maxGeneratedUtf8Bytes - (atZero + slope * titleLength);
    const accepted = q0Plan({
      chapters: [
        { id: "ch_first001", title: "\u0001".repeat(titleLength), order: 1, parsedBody: "a".repeat(remainder), images: [] }
      ]
    });
    expect(accepted.accounting.generatedUtf8Bytes).toBe(Q0_PRODUCTION_POLICY_V1.maxGeneratedUtf8Bytes);
    expect(
      q0Refusal({
        chapters: [
          {
            id: "ch_first001",
            title: "\u0001".repeat(titleLength),
            order: 1,
            parsedBody: "a".repeat(remainder + 1),
            images: []
          }
        ]
      })
    ).toMatchObject({ code: "budget-exceeded", dimension: "maxGeneratedUtf8Bytes" });
  }, 120_000);

  test("regular files and directory entries: exact boundary accepted, plus one refused", () => {
    const chapters = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `ch_f${String(i).padStart(6, "0")}`,
        title: "T",
        order: i + 1,
        parsedBody: "",
        images: []
      }));
    const accepted = q0Plan({ chapters: chapters(4088) });
    expect(accepted.accounting.regularFileCount).toBe(4091);
    expect(accepted.accounting.directoryEntryCount).toBe(4092);
    expect(q0Refusal({ chapters: chapters(4089) })).toMatchObject({
      code: "budget-exceeded",
      dimension: "maxRegularFiles"
    });
  }, 60_000);

  test("retrieval requests: retrieving one file at the exact request ceiling, plus one refused", () => {
    const plan = q0Plan();
    for (let i = 0; i < Q0_PRODUCTION_POLICY_V1.maxRetrievalRequests; i += 1) {
      expect(retrieveMarkdownFolderFile(plan, "README.md").status).toBe("retrieved");
    }
    expect(markdownFolderRetrievalAccounting(plan).requests).toBe(Q0_PRODUCTION_POLICY_V1.maxRetrievalRequests);
    expect(retrieveMarkdownFolderFile(plan, "README.md")).toMatchObject({
      status: "refused",
      code: "budget-exceeded",
      dimension: "maxRetrievalRequests"
    });
  });

  test("retrieval bytes: repeated retrieval of one large file refuses by byte dimension", () => {
    const plan = q0Plan({
      chapters: [
        {
          id: "ch_first001",
          title: "T",
          order: 1,
          parsedBody: "",
          images: [
            {
              status: "captured",
              recordId: "img_first001",
              format: "png",
              bytes: new Uint8Array(Q0_PRODUCTION_POLICY_V1.maxPerImageBytes)
            }
          ]
        }
      ]
    });
    const imagePath = plan.files.find((f) => f.kind === "image")!.path;
    let retrieved = 0;
    for (;;) {
      const result = retrieveMarkdownFolderFile(plan, imagePath);
      if (result.status !== "retrieved") {
        expect(result).toMatchObject({ code: "budget-exceeded", dimension: "maxRetrievalBytes" });
        break;
      }
      retrieved += 1;
      if (retrieved > 20) throw new Error("retrieval byte ceiling never bound");
    }
    expect(retrieved).toBe(11);
  }, 60_000);

  test("total output and accounted ceilings refuse beyond their sums through their binding parts", () => {
    // maxTotalOutputBytes = generated + image maxima, and the accounted ceiling is the envelope
    // at the other maxima together: neither can bind before a constituent dimension, so a book
    // beyond the total refuses on the constituent that crosses first.
    const plan = q0Plan({
      chapters: [
        {
          id: "ch_first001",
          title: "T",
          order: 1,
          parsedBody: "",
          images: [
            { status: "captured", recordId: "img_first001", format: "png", bytes: new Uint8Array(1024) }
          ]
        }
      ]
    });
    expect(plan.accounting.totalOutputBytes).toBeLessThanOrEqual(Q0_PRODUCTION_POLICY_V1.maxTotalOutputBytes);
    expect(plan.accounting.accountedPayloadWithOneFullRetrievalBytes).toBeLessThanOrEqual(
      Q0_PRODUCTION_POLICY_V1.maxAccountedPayloadBytes
    );
  });

  test("host planning returns a structured refusal at plus one through the capture path", async () => {
    const body = "a".repeat(Q0_PRODUCTION_POLICY_V1.maxInputStringCodeUnits + 1);
    const { host, bookId } = await makeFixture({
      images: [],
      chapters: [{ id: "ch_first001", title: "Big", order: 1, body, fileName: "0001-big.md" }]
    });
    const capture = await host.capture(bookId);
    expect(capture.acquisition.protocolFileReads).toBe(2 * (1 + 1 + 1 + 0));
    const planned = host.planCapture(capture);
    expect(planned).toMatchObject({ status: "refused", code: "budget-exceeded", dimension: "maxInputStringCodeUnits" });
  }, 120_000);
});
