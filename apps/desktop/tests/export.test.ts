import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Library } from "../src/main/library/store";
import { buildEpub } from "../src/main/epub";
import {
  buildDocx,
  buildMarkdown,
  collectDocxImages,
  collectManuscriptImages,
  exportBookImages,
  exportManuscriptDocx,
  exportManuscriptEpub,
  exportManuscriptMarkdown,
  exportManuscriptPdf,
  isInsideLibrary,
  planImageFiles,
  suggestDocxName,
  suggestImageFolderName,
  suggestMarkdownName,
  UNREADABLE_CHAPTERS_EXPORT_MESSAGE,
  assertNoUnreadableChapters,
  type DocxExportDeps,
  type DocxExportState,
  type DocxImage,
  type ImageExportDeps
} from "../src/main/export";
import { writeFileAtomic as atomicWrite } from "../src/main/library/atomic";
import { bookSchema, chapterMetaSchema, manuscriptSettingsSchema, type BookDetail } from "@ai-book-studio/core/schema";
import { imageRecordSchema, type ImageRecord } from "@ai-book-studio/core/images";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ library: Library; bookId: string; chapterIds: [string, string] }> {
  const root = await mkdtemp(join(tmpdir(), "abs-export-"));
  cleanups.push(root);
  const library = await Library.open(root);
  const book = await library.createBook({ title: "The Salt Road", description: "A crossing at low tide." });
  const first = await library.createChapter(book.id, {
    title: "The Door",
    content: "The hall was cold.\n\nMara closed the door.\n"
  });
  const second = await library.createChapter(book.id, { title: "The Gate", content: "Morning came slowly.\n" });
  expect(first.title).toBe("The Door");
  return { library, bookId: book.id, chapterIds: [first.id, second.id] };
}

async function snapshotBook(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        snapshot[relative] = createHash("sha256").update(bytes).digest("hex");
      }
    }
  }
  await walk(root, "");
  return snapshot;
}

describe("docx export", () => {
  test("builds a Word document for a book", async () => {
    const { library, bookId } = await fixture();
    const detail = await library.readBook(bookId);
    const data = await buildDocx(detail);
    expect(data.length).toBeGreaterThan(1_000);
    expect(Buffer.from(data).subarray(0, 2).toString()).toBe("PK");
  });

  test("builds a document for an empty book", async () => {
    const root = await mkdtemp(join(tmpdir(), "abs-export-empty-"));
    cleanups.push(root);
    const library = await Library.open(root);
    const book = await library.createBook({ title: "Blank" });
    const detail = await library.readBook(book.id);
    const data = await buildDocx(detail);
    expect(data.length).toBeGreaterThan(500);
  });

  test("applies the book's canonical typography to the document", async () => {
    const { library, bookId } = await fixture();
    const manuscript = {
      ...manuscriptSettingsSchema.parse({}),
      bodyFont: "Georgia",
      bodyFontSize: 14,
      lineSpacing: "1.5",
      firstLineIndent: 0.3,
      chapterTitleAlignment: "Left"
    } as never;
    await library.updateBook(bookId, { settings: { manuscript } } as never);
    const detail = await library.readBook(bookId);
    const data = await buildDocx(detail);
    const files = unzipSync(new Uint8Array(data));
    const document = new TextDecoder().decode(files["word/document.xml"]);
    // 14pt body -> 28 half-points, 1.5 spacing -> 360 twips, 0.3in indent -> 432 twips.
    expect(document).toContain('w:ascii="Georgia"');
    expect(document).toContain('w:val="28"');
    expect(document).toContain('w:line="360"');
    expect(document).toContain('w:firstLine="432"');
    // The Left chapter-title setting left-aligns both chapter headings.
    expect(document.split('w:val="left"').length - 1).toBe(2);
    expect(document).toContain("The hall was cold.");
  });

  test("the same chapters render different runs under different manuscript settings", async () => {
    const { library, bookId } = await fixture();
    const readDocumentXml = async (): Promise<string> => {
      const detail = await library.readBook(bookId);
      const data = await buildDocx(detail);
      return new TextDecoder().decode(unzipSync(new Uint8Array(data))["word/document.xml"]);
    };
    // Read the defaults build fully before changing settings so the two documents
    // cannot observe the same settings through a concurrent read.
    const defaults = await readDocumentXml();
    const manuscript = {
      ...manuscriptSettingsSchema.parse({}),
      bodyFont: "Georgia",
      bodyFontSize: 14,
      lineSpacing: "1.5",
      firstLineIndent: 0.3,
      chapterTitleAlignment: "Left"
    } as never;
    await library.updateBook(bookId, { settings: { manuscript } } as never);
    const custom = await readDocumentXml();
    // Same prose in both documents; only the styling runs may differ.
    expect(defaults).toContain("The hall was cold.");
    expect(custom).toContain("The hall was cold.");
    // Defaults: Times New Roman, 12pt body (24 half-points), Double spacing (480
    // twips), 0.2in indent (288 twips). Custom: Georgia, 14pt (28), 1.5 (360),
    // 0.3in indent (432). Each document carries only its own settings.
    expect(defaults).toContain('w:ascii="Times New Roman"');
    expect(defaults).toContain('w:val="24"');
    expect(defaults).toContain('w:line="480"');
    expect(defaults).toContain('w:firstLine="288"');
    expect(defaults).not.toContain("Georgia");
    expect(defaults).not.toContain('w:line="360"');
    expect(defaults).not.toContain('w:firstLine="432"');
    expect(custom).toContain('w:ascii="Georgia"');
    expect(custom).toContain('w:val="28"');
    expect(custom).toContain('w:line="360"');
    expect(custom).toContain('w:firstLine="432"');
    expect(custom).not.toContain("Times New Roman");
    expect(custom).not.toContain('w:line="480"');
    expect(custom).not.toContain('w:firstLine="288"');
  });

  test("verse lines export in order with their stanza gap", async () => {
    const { library, bookId } = await fixture();
    await library.createChapter(bookId, {
      title: "Verse",
      content: "Roses are red  \nViolets are blue\n\nSugar is sweet\nAnd so are you\n"
    });
    const data = await buildDocx(await library.readBook(bookId));
    const document = new TextDecoder().decode(unzipSync(new Uint8Array(data))["word/document.xml"]);
    const lines = ["Roses are red", "Violets are blue", "Sugar is sweet", "And so are you"].map((line) =>
      document.indexOf(line)
    );
    for (const position of lines) expect(position).toBeGreaterThan(-1);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  test("exporting leaves every source file byte-identical", async () => {
    const { library, bookId } = await fixture();
    const detail = await library.readBook(bookId);
    const before = await snapshotBook(library.root);
    const illustrations = await collectDocxImages(detail, library);
    const data = await buildDocx(detail, illustrations);
    const outside = join(tmpdir(), `abs-export-outside-${Date.now().toString(36)}.docx`);
    cleanups.push(outside);
    const { writeFileAtomic } = await import("../src/main/library/atomic");
    await writeFileAtomic(outside, Buffer.from(data));
    expect(await snapshotBook(library.root)).toEqual(before);
  });

  test("embeds a chapter illustration when one is attached", async () => {
    const { library, bookId } = await fixture();
    const detail = await library.readBook(bookId);
    const png = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==",
        "base64"
      )
    );
    const image: DocxImage = {
      bytes: png,
      width: 1,
      height: 1,
      mimeType: "image/png",
      prompt: "A lighthouse in a storm"
    };
    const data = await buildDocx(detail, new Map([[detail.chapters[0]!.id, image]]));
    const files = unzipSync(new Uint8Array(data));
    expect(Object.keys(files).some((name) => /^word\/media\/.*\.png$/.test(name))).toBe(true);
  });
});

const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==",
    "base64"
  )
);

function tinyWebp(): Uint8Array {
  // Minimal VP8X container the image store accepts: RIFF + WEBP + VP8X markers, 1x1.
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  return bytes;
}

async function attachPng(library: Library, bookId: string, chapterId: string | null, prompt = "A lighthouse"): Promise<void> {
  const record = await library.addImage(bookId, {
    bytes: TINY_PNG,
    kind: "chapter",
    prompt,
    provider: "fixture",
    model: "fixture-small"
  });
  if (chapterId) await library.attachImage(bookId, record.id, chapterId);
}

describe("collectDocxImages", () => {
  test("resolves an attached PNG through the image store", async () => {
    const { library, bookId, chapterIds: [chapterId] } = await fixture();
    await attachPng(library, bookId, chapterId);
    const detail = await library.readBook(bookId);
    const collected = await collectDocxImages(detail, library);
    const image = collected.get(chapterId);
    expect(image?.mimeType).toBe("image/png");
    expect(image?.width).toBe(1);
    expect(image?.height).toBe(1);
    expect(image?.prompt).toBe("A lighthouse");
    expect(image?.bytes.length).toBeGreaterThan(0);
  });

  test("skips unattached and WebP images without failing", async () => {
    const { library, bookId, chapterIds: [chapterId] } = await fixture();
    await attachPng(library, bookId, null);
    const webp = await library.addImage(bookId, {
      bytes: tinyWebp(),
      kind: "chapter",
      prompt: "A storm",
      provider: "fixture",
      model: "fixture-small"
    });
    await library.attachImage(bookId, webp.id, chapterId);
    const detail = await library.readBook(bookId);
    expect(await collectDocxImages(detail, library)).toEqual(new Map());
  });

  test("skips unreadable images and keeps the readable ones", async () => {
    const { library, bookId, chapterIds: [chapterId] } = await fixture();
    const detail = await library.readBook(bookId);
    await attachPng(library, bookId, chapterId);
    const { manifest } = await library.listImages(bookId);
    const unreadable = {
      listImages: async () => ({ manifest, warning: null }),
      readImage: async () => {
        throw new Error("gone");
      }
    };
    expect(await collectDocxImages(detail, unreadable)).toEqual(new Map());
  });

  test("an unreadable manifest yields no illustrations instead of failing", async () => {
    const { library, bookId } = await fixture();
    const detail = await library.readBook(bookId);
    const broken = {
      listImages: async () => {
        throw new Error("no manifest");
      },
      readImage: async () => null
    };
    expect(await collectDocxImages(detail, broken)).toEqual(new Map());
  });

  test("the first readable image per chapter wins", async () => {
    const { library, bookId, chapterIds: [chapterId] } = await fixture();
    const detail = await library.readBook(bookId);
    await attachPng(library, bookId, chapterId, "First");
    const { manifest } = await library.listImages(bookId);
    const [first] = manifest.images;
    if (!first) throw new Error("expected the attached image in the manifest");
    const second = { ...first, id: "img_second", prompt: "Second" };
    const both = {
      listImages: async () => ({ manifest: { ...manifest, images: [first, second] }, warning: null }),
      readImage: async (_bookId: string, imageId: string) => ({
        record: imageId === first.id ? first : second,
        bytes: TINY_PNG
      })
    };
    const collected = await collectDocxImages(detail, both);
    expect(collected.get(chapterId)?.prompt).toBe("First");
  });
});

describe("suggestDocxName", () => {
  test("derives a safe file name from the title", () => {
    expect(suggestDocxName("The Salt Road")).toBe("the-salt-road.docx");
    expect(suggestDocxName("  ")).toBe("manuscript.docx");
    expect(suggestDocxName("Café!")).toBe("café.docx");
  });

  test("truncates a long title to a 60-character stem", () => {
    const name = suggestDocxName(`${"a".repeat(100)}!`);
    expect(name).toBe(`${"a".repeat(60)}.docx`);
  });
});

describe("isInsideLibrary", () => {
  test("refuses the library root and anything under it, allows siblings", () => {
    const root = join(tmpdir(), "abs-library-root");
    expect(isInsideLibrary(root, root)).toBe(true);
    expect(isInsideLibrary(root, join(root, "books", "book_x", "chapter.md"))).toBe(true);
    expect(isInsideLibrary(root, `${root}2`)).toBe(false);
    expect(isInsideLibrary(root, join(tmpdir(), "elsewhere.docx"))).toBe(false);
  });
});

describe("all manuscript formats reject a symlinked source directory", () => {
  for (const kind of ["docx", "markdown", "pdf", "epub"] as const) {
    test(kind, async () => {
      const { library, bookId } = await fixture();
      const detail = await library.readBook(bookId);
      const before = await snapshotBook(library.root);
      const outside = await mkdtemp(join(tmpdir(), "abs-export-alias-"));
      cleanups.push(outside);
      await symlink(join(library.root, "books", bookId), join(outside, "alias"));
      const deps = {
        pickDestination: async () => join(outside, "alias", `source.${kind}`),
        confirmReplace: async () => true,
        statDestination: async () => null,
        renderPdf: async () => new TextEncoder().encode("%PDF-synthetic")
      };
      const attempt = {
        docx: () => exportManuscriptDocx(detail, new Map(), library.root, deps),
        markdown: () => exportManuscriptMarkdown(detail, library.root, deps),
        pdf: () => exportManuscriptPdf(detail, new Map(), library.root, deps),
        epub: () => exportManuscriptEpub(detail, new Map(), library.root, deps)
      }[kind];
      await expect(attempt()).rejects.toMatchObject({ code: "invalid" });
      expect(await snapshotBook(library.root)).toEqual(before);
    });
  }
});

function realStat(path: string): Promise<DocxExportState | null> {
  return stat(path)
    .then((snapshot) => ({ mtimeMs: snapshot.mtimeMs, size: snapshot.size }))
    .catch(() => null);
}

describe("exportManuscriptDocx", () => {
  async function outside(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "abs-docx-out-"));
    cleanups.push(dir);
    return dir;
  }

  function baseDeps(dir: string, overrides: Partial<DocxExportDeps> = {}): DocxExportDeps {
    return {
      pickDestination: async (name) => join(dir, name),
      confirmReplace: async () => true,
      statDestination: realStat,
      ...overrides
    };
  }

  test("a cancelled picker returns null and writes nothing", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const written: string[] = [];
    const result = await exportManuscriptDocx(await library.readBook(bookId), new Map(), library.root, {
      ...baseDeps(dir),
      pickDestination: async () => null,
      writeFile: async (path) => {
        written.push(path);
      }
    });
    expect(result).toBeNull();
    expect(written).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a destination inside the library is refused before anything is written", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const written: string[] = [];
    const destination = join(library.root, "books", bookId, "sneaky.docx");
    const promise = exportManuscriptDocx(await library.readBook(bookId), new Map(), library.root, {
      ...baseDeps(dir),
      pickDestination: async () => destination,
      writeFile: async (path) => {
        written.push(path);
      }
    });
    await expect(promise).rejects.toMatchObject({ code: "invalid" });
    expect(written).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a declined replacement returns null and keeps the prior file", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const destination = join(dir, "prior.docx");
    await writeFile(destination, "prior-bytes");
    const result = await exportManuscriptDocx(await library.readBook(bookId), new Map(), library.root, {
      ...baseDeps(dir),
      pickDestination: async () => destination,
      confirmReplace: async () => false
    });
    expect(result).toBeNull();
    expect((await readFile(destination)).toString()).toBe("prior-bytes");
  });

  test("an accepted replacement overwrites after consent", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const destination = join(dir, "prior.docx");
    await writeFile(destination, "prior-bytes");
    let confirmed = 0;
    const result = await exportManuscriptDocx(await library.readBook(bookId), new Map(), library.root, {
      ...baseDeps(dir),
      pickDestination: async () => destination,
      confirmReplace: async () => {
        confirmed += 1;
        return true;
      }
    });
    expect(result).toBe(destination);
    expect(confirmed).toBe(1);
    expect(Buffer.from(await readFile(destination)).subarray(0, 2).toString()).toBe("PK");
  });

  test("a file that changes after consent throws and writes nothing", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const written: string[] = [];
    const states = [{ mtimeMs: 1, size: 2 }, { mtimeMs: 3, size: 2 }];
    const promise = exportManuscriptDocx(await library.readBook(bookId), new Map(), library.root, {
      ...baseDeps(dir),
      pickDestination: async () => join(dir, "changed.docx"),
      statDestination: async () => states.shift() ?? null,
      writeFile: async (path) => {
        written.push(path);
      }
    });
    await expect(promise).rejects.toMatchObject({ code: "io" });
    expect(written).toEqual([]);
  });

  test("a file created after consent throws instead of overwriting without consent", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const written: string[] = [];
    const states: (DocxExportState | null)[] = [null, { mtimeMs: 3, size: 4 }];
    const promise = exportManuscriptDocx(await library.readBook(bookId), new Map(), library.root, {
      ...baseDeps(dir),
      pickDestination: async () => join(dir, "appeared.docx"),
      statDestination: async () => states.shift() ?? null,
      writeFile: async (path) => {
        written.push(path);
      }
    });
    await expect(promise).rejects.toMatchObject({ code: "io" });
    expect(written).toEqual([]);
  });

  test("an injected write failure keeps the prior file", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const destination = join(dir, "fragile.docx");
    await writeFile(destination, "prior-bytes");
    const promise = exportManuscriptDocx(await library.readBook(bookId), new Map(), library.root, {
      ...baseDeps(dir),
      pickDestination: async () => destination,
      writeFile: async () => {
        throw new Error("disk is full");
      }
    });
    await expect(promise).rejects.toThrow("disk is full");
    expect((await readFile(destination)).toString()).toBe("prior-bytes");
  });

  test("a failed real write leaves no partial file behind", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    await chmod(dir, 0o555);
    try {
      const promise = exportManuscriptDocx(await library.readBook(bookId), new Map(), library.root, {
        ...baseDeps(dir)
      });
      await expect(promise).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  test("a failed real write keeps the prior export byte-identical", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const destination = join(dir, "the-salt-road.docx");
    await writeFile(destination, "prior-bytes");
    await chmod(dir, 0o555);
    try {
      const promise = exportManuscriptDocx(await library.readBook(bookId), new Map(), library.root, {
        ...baseDeps(dir),
        pickDestination: async () => destination
      });
      await expect(promise).rejects.toThrow();
      expect((await readFile(destination)).toString()).toBe("prior-bytes");
      expect(await readdir(dir)).toEqual(["the-salt-road.docx"]);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  test("the default writer stages through a sibling temp file and leaves no debris", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const result = await exportManuscriptDocx(await library.readBook(bookId), new Map(), library.root, baseDeps(dir));
    expect(result).toBe(join(dir, "the-salt-road.docx"));
    if (!result) throw new Error("expected an export destination");
    expect(await readdir(dir)).toEqual(["the-salt-road.docx"]);
    expect(Buffer.from(await readFile(result)).subarray(0, 2).toString()).toBe("PK");
  });
});

test("exportManuscriptEpub publishes an image-free EPUB outside the library", async () => {
  const { library, bookId } = await fixture();
  const before = await snapshotBook(library.root);
  const detail = await library.readBook(bookId);
  const { illustrations, warnings } = await collectManuscriptImages(detail, library);
  expect(illustrations.size).toBe(0);
  expect(warnings).toEqual([]);
  const expected = Buffer.from(buildEpub(detail));

  const dir = await mkdtemp(join(tmpdir(), "abs-epub-out-"));
  cleanups.push(dir);
  const fileName = "the-salt-road.epub";
  const destination = join(dir, fileName);
  const result = await exportManuscriptEpub(detail, illustrations, library.root, {
    pickDestination: async (name) => join(dir, name),
    confirmReplace: async () => false,
    statDestination: realStat
  });

  expect(result).toBe(destination);
  expect(await readdir(dir)).toEqual([fileName]);
  const written = await readFile(destination);
  expect(written).toEqual(expected);
  expect(Object.keys(unzipSync(written)).filter((path) => path.startsWith("EPUB/images/"))).toEqual([]);
  expect(await snapshotBook(library.root)).toEqual(before);
});

describe("markdown export", () => {
  async function outside(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "abs-md-out-"));
    cleanups.push(dir);
    return dir;
  }

  function baseDeps(dir: string, overrides: Partial<DocxExportDeps> = {}): DocxExportDeps {
    return {
      pickDestination: async (name) => join(dir, name),
      confirmReplace: async () => true,
      statDestination: (path) =>
        stat(path)
          .then((snapshot) => ({ mtimeMs: snapshot.mtimeMs, size: snapshot.size }))
          .catch(() => null),
      ...overrides
    };
  }

  test("joins the chapters in reading order under their titles", async () => {
    const { library, bookId } = await fixture();
    const detail = await library.readBook(bookId);
    const markdown = buildMarkdown({ ...detail, chapters: [...detail.chapters].reverse() });
    const blocks = [
      "# The Salt Road",
      "_A crossing at low tide._",
      "## The Door",
      "The hall was cold.\n\nMara closed the door.",
      "## The Gate",
      "Morning came slowly."
    ];
    expect(markdown).toBe(`${blocks.join("\n\n")}\n`);
  });

  test("suggests a file name from the book title", () => {
    expect(suggestMarkdownName("The Salt Road")).toBe("the-salt-road.md");
    expect(suggestMarkdownName("   ")).toBe("manuscript.md");
  });

  test("writes the manuscript outside the library and leaves the book untouched", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const before = await snapshotBook(library.root);
    const result = await exportManuscriptMarkdown(await library.readBook(bookId), library.root, baseDeps(dir));
    expect(result).toBe(join(dir, "the-salt-road.md"));
    expect((await readFile(join(dir, "the-salt-road.md"))).toString()).toBe(
      buildMarkdown(await library.readBook(bookId))
    );
    expect(await snapshotBook(library.root)).toEqual(before);
  });

  test("a cancelled picker returns null and writes nothing", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const result = await exportManuscriptMarkdown(await library.readBook(bookId), library.root, {
      ...baseDeps(dir),
      pickDestination: async () => null
    });
    expect(result).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  test("a destination inside the library is refused before anything is written", async () => {
    const { library, bookId } = await fixture();
    const before = await snapshotBook(library.root);
    const promise = exportManuscriptMarkdown(await library.readBook(bookId), library.root, {
      ...baseDeps(library.root),
      pickDestination: async () => join(library.root, "books", bookId, "sneaky.md")
    });
    await expect(promise).rejects.toMatchObject({ code: "invalid" });
    expect(await snapshotBook(library.root)).toEqual(before);
  });

  test("a declined replacement returns null and keeps the prior file", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const destination = join(dir, "prior.md");
    await writeFile(destination, "prior-text");
    const result = await exportManuscriptMarkdown(await library.readBook(bookId), library.root, {
      ...baseDeps(dir),
      pickDestination: async () => destination,
      confirmReplace: async () => false
    });
    expect(result).toBeNull();
    expect((await readFile(destination)).toString()).toBe("prior-text");
  });

  test("a file that changes after consent throws and writes nothing", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    const written: string[] = [];
    const states = [{ mtimeMs: 1, size: 2 }, { mtimeMs: 3, size: 2 }];
    const promise = exportManuscriptMarkdown(await library.readBook(bookId), library.root, {
      ...baseDeps(dir),
      pickDestination: async () => join(dir, "changed.md"),
      statDestination: async () => states.shift() ?? null,
      writeFile: async (path) => {
        written.push(path);
      }
    });
    await expect(promise).rejects.toMatchObject({ code: "io" });
    expect(written).toEqual([]);
  });
});

/** SOI, a baseline frame header for one pixel, EOI: enough for the image store to read its size. */
const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01,
  0x03, 0x11, 0x01, 0xff, 0xd9
]);

/** A stand-in for nativeImage: a PNG becomes a small JPEG, and anything else cannot be decoded. */
function fakeTranscoder(calls: Uint8Array[] = []): ImageExportDeps["transcode"] {
  return (bytes) => {
    calls.push(bytes);
    return bytes[0] === 0x89 ? new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]) : null;
  };
}

function imageRecord(id: string, overrides: Partial<ImageRecord> = {}): ImageRecord {
  return imageRecordSchema.parse({
    id,
    kind: "chapter",
    fileName: `${id}.png`,
    mimeType: "image/png",
    width: 1,
    height: 1,
    bytes: 1,
    sha256: "a".repeat(64),
    provider: "fixture",
    model: "fixture-small",
    source: "generated",
    createdAt: "2026-11-03T00:00:00.000Z",
    ...overrides
  });
}

function plannedBook(chapters: Array<[string, string]>, cast: Array<[string, string]> = []): BookDetail {
  const now = "2026-11-03T00:00:00.000Z";
  return {
    book: bookSchema.parse({
      id: "book_plan0001",
      title: "The Salt Road",
      characters: cast.map(([id, name]) => ({ id, name })),
      createdAt: now,
      updatedAt: now
    }),
    chapters: chapters.map(([id, title], index) => ({
      ...chapterMetaSchema.parse({ id, title, order: index + 1, createdAt: now, updatedAt: now }),
      content: "",
      path: `${index + 1}.md`,
      wordCount: 0,
      hash: "b".repeat(64)
    })),
    chapterReadIssues: []
  };
}

describe("planImageFiles", () => {
  test("names chapter pictures by reading order and title, and the rest by kind", () => {
    const detail = plannedBook(
      [
        ["ch_door0001", "The Door"],
        ["ch_gate0001", "The Gate"]
      ],
      [["char_mara0001", "Mara"]]
    );
    // Reading order comes from each chapter's order, not from the order the chapters arrive in.
    const shuffled = { ...detail, chapters: [...detail.chapters].reverse() };
    const records = [
      imageRecord("img_cover001", { kind: "cover" }),
      imageRecord("img_gate0001", { chapterId: "ch_gate0001" }),
      imageRecord("img_door0001", { chapterId: "ch_door0001" }),
      imageRecord("img_mara0001", { kind: "character", characterId: "char_mara0001" }),
      imageRecord("img_cut00001", {
        kind: "character",
        characterId: "char_mara0001",
        source: "cutout",
        cutoutOf: "img_mara0001"
      }),
      imageRecord("img_spare001"),
      imageRecord("img_other001", { kind: "other" })
    ];
    expect(planImageFiles(shuffled, records).map((entry) => entry.name)).toEqual([
      "cover.jpg",
      "02-the-gate.jpg",
      "01-the-door.jpg",
      "character-mara.jpg",
      "character-mara-cutout.jpg",
      "illustration.jpg",
      "image.jpg"
    ]);
  });

  test("gives a repeated name the next free number, ignoring case and Unicode spelling", () => {
    const detail = plannedBook(
      [],
      [
        ["char_jose0001", "José"],
        ["char_jose0002", "José"],
        ["char_mara0001", "Mara"],
        ["char_mara0002", "MARA"]
      ]
    );
    const records = [
      imageRecord("img_cover001", { kind: "cover" }),
      imageRecord("img_cover002", { kind: "cover" }),
      imageRecord("img_jose0001", { kind: "character", characterId: "char_jose0001" }),
      imageRecord("img_jose0002", { kind: "character", characterId: "char_jose0002" }),
      imageRecord("img_mara0001", { kind: "character", characterId: "char_mara0001" }),
      imageRecord("img_mara0002", { kind: "character", characterId: "char_mara0002" })
    ];
    const names = planImageFiles(detail, records).map((entry) => entry.name);
    expect(names).toEqual([
      "cover.jpg",
      "cover-2.jpg",
      "character-josé.jpg",
      "character-josé-2.jpg",
      "character-mara.jpg",
      "character-mara-2.jpg"
    ]);
    // The same book always produces the same names.
    expect(planImageFiles(detail, records).map((entry) => entry.name)).toEqual(names);
  });

  test("keeps every name safe for the filesystem", () => {
    const chapters = Array.from(
      { length: 120 },
      (_, index): [string, string] => [`ch_many${String(index).padStart(4, "0")}`, `Part ${index + 1}`]
    );
    chapters[0] = ["ch_many0000", 'What/now? <A:B> "quoted" \\ back'];
    chapters[1] = ["ch_many0001", `${"long ".repeat(40)}end`];
    chapters[2] = ["ch_many0002", "!!!"];
    const names = planImageFiles(plannedBook(chapters), [
      imageRecord("img_many0000", { chapterId: "ch_many0000" }),
      imageRecord("img_many0001", { chapterId: "ch_many0001" }),
      imageRecord("img_many0002", { chapterId: "ch_many0002" }),
      imageRecord("img_many0119", { chapterId: "ch_many0119" }),
      imageRecord("img_lost0001", { chapterId: "ch_gone0001" }),
      imageRecord("img_nobody01", { kind: "character", characterId: "char_gone0001" })
    ]).map((entry) => entry.name);
    expect(names[0]).toBe("001-what-now-a-b-quoted-back.jpg");
    expect(names[1]).toBe(`002-${Array.from({ length: 12 }, () => "long").join("-")}.jpg`);
    expect(names[2]).toBe("003-chapter.jpg");
    expect(names[3]).toBe("120-part-120.jpg");
    // A picture whose chapter or cast member is gone still exports, named for its kind.
    expect(names[4]).toBe("illustration.jpg");
    expect(names[5]).toBe("character.jpg");
    for (const name of names) expect(name).toMatch(/^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}-]*\.jpg$/u);
  });

  test("cuts a long title between whole characters and within the filesystem's byte limit", () => {
    // Fraktur capitals are letters outside the Basic Multilingual Plane: two UTF-16 units, four bytes.
    const fraktur = "\u{1D504}".repeat(70);
    const snow = "雪".repeat(100);
    const [astral, cjk] = planImageFiles(
      plannedBook([
        ["ch_wide0001", fraktur],
        ["ch_wide0002", snow]
      ]),
      [imageRecord("img_wide0001", { chapterId: "ch_wide0001" }), imageRecord("img_wide0002", { chapterId: "ch_wide0002" })]
    ).map((entry) => entry.name);
    expect(astral).toBe(`01-${"\u{1D504}".repeat(45)}.jpg`);
    expect(cjk).toBe(`02-${"雪".repeat(60)}.jpg`);
    for (const name of [astral, cjk]) {
      expect(name).not.toContain("�");
      expect(Buffer.byteLength(name ?? "")).toBeLessThanOrEqual(255);
    }
  });
});

describe("suggestImageFolderName", () => {
  test("names the folder for the book", () => {
    expect(suggestImageFolderName("The Salt Road")).toBe("the-salt-road-images");
    expect(suggestImageFolderName("   ")).toBe("untitled-book-images");
  });
});

describe("exportBookImages", () => {
  async function outside(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "abs-images-out-"));
    cleanups.push(dir);
    return dir;
  }

  function imageDeps(dir: string, overrides: Partial<ImageExportDeps> = {}): ImageExportDeps {
    return { pickFolder: async () => dir, transcode: fakeTranscoder(), ...overrides };
  }

  async function addPicture(
    library: Library,
    bookId: string,
    bytes: Uint8Array,
    kind: ImageRecord["kind"],
    chapterId?: string
  ): Promise<ImageRecord> {
    const record = await library.addImage(bookId, {
      bytes,
      kind,
      prompt: "A picture",
      provider: "fixture",
      model: "fixture-small"
    });
    if (chapterId) await library.attachImage(bookId, record.id, chapterId);
    return record;
  }

  test("saves every image as a correctly named JPEG in a new folder and leaves the book untouched", async () => {
    const { library, bookId, chapterIds } = await fixture();
    await library.updateBook(bookId, {
      characters: [{ id: "char_mara0001", name: "Mara", role: "", description: "", motivations: "", notes: "" }]
    });
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[1]);
    await addPicture(library, bookId, TINY_JPEG, "cover");
    const portrait = await addPicture(library, bookId, TINY_PNG, "character");
    await library.attachCharacterImage(bookId, portrait.id, "char_mara0001");
    const detail = await library.readBook(bookId);
    const before = await snapshotBook(library.root);
    const dir = await outside();
    const calls: Uint8Array[] = [];
    const result = await exportBookImages(detail, library, library.root, imageDeps(dir, { transcode: fakeTranscoder(calls) }));
    const folder = join(dir, "the-salt-road-images");
    expect(result).toEqual({
      status: "saved",
      folder,
      files: ["02-the-gate.jpg", "cover.jpg", "character-mara.jpg"],
      skipped: []
    });
    // Only the new folder appears: no staging folder or temp file is left beside it.
    expect(await readdir(dir)).toEqual(["the-salt-road-images"]);
    expect((await readdir(folder)).sort()).toEqual(["02-the-gate.jpg", "character-mara.jpg", "cover.jpg"]);
    for (const name of await readdir(folder)) {
      expect([...(await readFile(join(folder, name))).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    }
    // A JPEG is copied byte for byte; only the two PNGs went through the transcoder.
    expect(new Uint8Array(await readFile(join(folder, "cover.jpg")))).toEqual(TINY_JPEG);
    expect(calls).toHaveLength(2);
    expect(await snapshotBook(library.root)).toEqual(before);
  });

  test("exporting the same book twice gives the same names", async () => {
    const { library, bookId, chapterIds } = await fixture();
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[0]);
    await addPicture(library, bookId, TINY_PNG, "cover");
    await addPicture(library, bookId, TINY_PNG, "cover");
    const detail = await library.readBook(bookId);
    const first = await exportBookImages(detail, library, library.root, imageDeps(await outside()));
    const second = await exportBookImages(detail, library, library.root, imageDeps(await outside()));
    expect(first).toMatchObject({ status: "saved", files: ["01-the-door.jpg", "cover.jpg", "cover-2.jpg"] });
    expect(second).toMatchObject({ status: "saved", files: ["01-the-door.jpg", "cover.jpg", "cover-2.jpg"] });
  });

  test("a book without images says so, writes nothing and never opens the picker", async () => {
    const { library, bookId } = await fixture();
    const dir = await outside();
    let picked = 0;
    const result = await exportBookImages(
      await library.readBook(bookId),
      library,
      library.root,
      imageDeps(dir, {
        pickFolder: async () => {
          picked += 1;
          return dir;
        }
      })
    );
    expect(result).toEqual({ status: "empty" });
    expect(picked).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a cancelled picker writes nothing", async () => {
    const { library, bookId, chapterIds } = await fixture();
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[0]);
    const dir = await outside();
    const calls: Uint8Array[] = [];
    const result = await exportBookImages(await library.readBook(bookId), library, library.root, {
      pickFolder: async () => null,
      transcode: fakeTranscoder(calls)
    });
    expect(result).toEqual({ status: "cancelled" });
    expect(calls).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a destination inside the library is refused, even through a symlink", async () => {
    const { library, bookId, chapterIds } = await fixture();
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[0]);
    const detail = await library.readBook(bookId);
    const before = await snapshotBook(library.root);
    const dir = await outside();
    await symlink(join(library.root, "books"), join(dir, "shortcut"));
    for (const picked of [library.root, join(library.root, "books", bookId), join(dir, "shortcut")]) {
      const promise = exportBookImages(detail, library, library.root, imageDeps(dir, { pickFolder: async () => picked }));
      await expect(promise).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringContaining("inside the open library")
      });
    }
    expect(await snapshotBook(library.root)).toEqual(before);
    expect(await readdir(dir)).toEqual(["shortcut"]);
  });

  test("an images folder that already exists is refused and left as it was", async () => {
    const { library, bookId, chapterIds } = await fixture();
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[0]);
    const dir = await outside();
    const existing = join(dir, "the-salt-road-images");
    await mkdir(existing);
    await writeFile(join(existing, "01-the-door.jpg"), "the author's own file");
    const calls: Uint8Array[] = [];
    const promise = exportBookImages(
      await library.readBook(bookId),
      library,
      library.root,
      imageDeps(dir, { transcode: fakeTranscoder(calls) })
    );
    await expect(promise).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("already exists") });
    expect(calls).toEqual([]);
    expect(await readdir(dir)).toEqual(["the-salt-road-images"]);
    expect(await readdir(existing)).toEqual(["01-the-door.jpg"]);
    expect((await readFile(join(existing, "01-the-door.jpg"))).toString()).toBe("the author's own file");
  });

  test("a folder that appears while the images convert is refused, and the staging folder is removed", async () => {
    const { library, bookId, chapterIds } = await fixture();
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[0]);
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[1]);
    const dir = await outside();
    const appeared = join(dir, "the-salt-road-images");
    const convert = fakeTranscoder();
    const promise = exportBookImages(
      await library.readBook(bookId),
      library,
      library.root,
      imageDeps(dir, {
        transcode: async (bytes) => {
          await mkdir(appeared, { recursive: true });
          await writeFile(join(appeared, "theirs.txt"), "made meanwhile");
          return convert(bytes);
        }
      })
    );
    await expect(promise).rejects.toMatchObject({ code: "invalid" });
    expect(await readdir(dir)).toEqual(["the-salt-road-images"]);
    expect(await readdir(appeared)).toEqual(["theirs.txt"]);
  });

  test("an image that cannot be decoded is skipped with a note, and the rest still export", async () => {
    const { library, bookId, chapterIds } = await fixture();
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[0]);
    await addPicture(library, bookId, tinyWebp(), "chapter", chapterIds[1]);
    const dir = await outside();
    const result = await exportBookImages(await library.readBook(bookId), library, library.root, imageDeps(dir));
    const folder = join(dir, "the-salt-road-images");
    expect(result).toEqual({
      status: "saved",
      folder,
      files: ["01-the-door.jpg"],
      skipped: [{ name: "02-the-gate.jpg", reason: "The WebP image could not be converted to JPEG." }]
    });
    expect(await readdir(folder)).toEqual(["01-the-door.jpg"]);
  });

  test("when no image can be converted, nothing is written", async () => {
    const { library, bookId, chapterIds } = await fixture();
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[0]);
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[1]);
    const dir = await outside();
    const answers: Array<() => Uint8Array | null> = [
      () => {
        throw new Error("the decoder crashed");
      },
      // A PNG is not a JPEG, so it does not count as converted.
      () => TINY_PNG
    ];
    const result = await exportBookImages(
      await library.readBook(bookId),
      library,
      library.root,
      imageDeps(dir, { transcode: () => (answers.shift() ?? (() => null))() })
    );
    expect(result).toEqual({
      status: "unconverted",
      skipped: [
        { name: "01-the-door.jpg", reason: "The PNG image could not be converted to JPEG." },
        { name: "02-the-gate.jpg", reason: "The PNG image could not be converted to JPEG." }
      ]
    });
    expect(await readdir(dir)).toEqual([]);
  });

  test("an image file changed outside the studio is skipped with the store's reason", async () => {
    const { library, bookId, chapterIds } = await fixture();
    const changed = await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[0]);
    await addPicture(library, bookId, TINY_JPEG, "cover");
    await writeFile(join(library.root, "books", bookId, "images", changed.fileName), "not the recorded bytes");
    const dir = await outside();
    const result = await exportBookImages(await library.readBook(bookId), library, library.root, imageDeps(dir));
    expect(result).toMatchObject({
      status: "saved",
      files: ["cover.jpg"],
      skipped: [{ name: "01-the-door.jpg", reason: `The image file ${changed.fileName} changed outside the studio.` }]
    });
  });

  test("a write that fails partway leaves no folder and no staging behind", async () => {
    const { library, bookId, chapterIds } = await fixture();
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[0]);
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[1]);
    const dir = await outside();
    let writes = 0;
    const promise = exportBookImages(
      await library.readBook(bookId),
      library,
      library.root,
      imageDeps(dir, {
        writeFile: async (path, data) => {
          writes += 1;
          if (writes === 2) throw new Error("disk is full");
          await atomicWrite(path, data);
        }
      })
    );
    await expect(promise).rejects.toMatchObject({ code: "io", message: expect.stringContaining("Nothing was written") });
    expect(writes).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a folder the studio cannot write to fails plainly and stays empty", async () => {
    const { library, bookId, chapterIds } = await fixture();
    await addPicture(library, bookId, TINY_PNG, "chapter", chapterIds[0]);
    const dir = await outside();
    await chmod(dir, 0o555);
    try {
      const promise = exportBookImages(await library.readBook(bookId), library, library.root, imageDeps(dir));
      await expect(promise).rejects.toMatchObject({ code: "io", message: expect.stringContaining("not allowed") });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  test("an unreadable image list fails plainly before the picker opens", async () => {
    const { library, bookId } = await fixture();
    await writeFile(join(library.root, "books", bookId, "images.json"), "{ not json");
    const dir = await outside();
    let picked = 0;
    const promise = exportBookImages(
      await library.readBook(bookId),
      library,
      library.root,
      imageDeps(dir, {
        pickFolder: async () => {
          picked += 1;
          return dir;
        }
      })
    );
    await expect(promise).rejects.toMatchObject({ code: "format", message: expect.stringContaining("images.json") });
    expect(picked).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("a manuscript export refuses a book with unreadable chapter files", () => {
  const headers = ['title: "SYNTHETIC_UNCLOSED', "order: -1"];
  const kinds = ["docx", "markdown", "pdf", "epub"] as const;
  for (const header of headers) {
    for (const kind of kinds) {
      test(`${kind} after ${JSON.stringify(header)} asks for nothing, writes nothing and leaves every file as it was`, async () => {
        const { library, bookId } = await fixture();
        const before = await library.readBook(bookId);
        const chapters = join(library.root, "books", bookId, "chapters");
        const damaged = join(chapters, before.chapters[0]!.path);
        const healthy = join(chapters, before.chapters[1]!.path);
        const bookFile = join(library.root, "books", bookId, "book.json");
        const raw = `---\n${header}\n---\nSYNTHETIC SOURCE\n`;
        await writeFile(damaged, raw);
        const beforeHealthy = await readFile(healthy);
        const beforeBook = await readFile(bookFile);
        const target = join(library.root, "..", `previous-${kind}.out`);
        const previous = Buffer.from("SYNTHETIC PREVIOUS COMPLETE EXPORT");
        await writeFile(target, previous);
        cleanups.push(target);

        const detail = await library.readBook(bookId);
        expect(detail.chapterReadIssues).toHaveLength(1);
        expect(detail.chapters).toHaveLength(1);

        const calls: string[] = [];
        const deps = {
          pickDestination: async () => { calls.push("pick"); return target; },
          confirmReplace: async () => { calls.push("confirm"); return true; },
          statDestination: async () => { calls.push("stat"); return null; },
          writeFile: async () => { calls.push("write"); },
          renderPdf: async () => { calls.push("render"); return new Uint8Array(); }
        };
        const attempt = {
          docx: () => exportManuscriptDocx(detail, new Map(), library.root, deps),
          markdown: () => exportManuscriptMarkdown(detail, library.root, deps),
          pdf: () => exportManuscriptPdf(detail, new Map(), library.root, deps),
          epub: () => exportManuscriptEpub(detail, new Map(), library.root, deps)
        }[kind];
        await expect(attempt()).rejects.toMatchObject({ code: "format", message: UNREADABLE_CHAPTERS_EXPORT_MESSAGE });

        expect(calls).toEqual([]);
        expect(await readFile(target)).toEqual(previous);
        expect(await readFile(damaged, "utf8")).toBe(raw);
        expect(await readFile(healthy)).toEqual(beforeHealthy);
        expect(await readFile(bookFile)).toEqual(beforeBook);
      });
    }
  }

  test("a healthy book still exports, and the guard is a no-op for it", async () => {
    const { library, bookId } = await fixture();
    const detail = await library.readBook(bookId);
    expect(detail.chapterReadIssues).toEqual([]);
    expect(() => assertNoUnreadableChapters(detail)).not.toThrow();
  });
});
