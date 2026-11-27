import { describe, expect, spyOn, test } from "bun:test";
import { LibraryPortError } from "../../src/library/errors";
import { bookFilePath, chapterPath, chaptersPath } from "../../src/library/paths";
import { libraryPathFromArchivePath, toLibraryPath } from "../../src/library/path";
import { AnnotationService } from "../../src/organization/annotations";
import { sidecarPath, SidecarRefusalError } from "../../src/planning/checked-sidecar";
import { decoder, encoder, SIDECAR_BYTES } from "../../src/planning/schema";
import { envelope, fixture } from "../planning/fixture";

function span(content: string, excerpt: string) {
  const start = content.indexOf(excerpt);
  if (start < 0) throw new Error("Excerpt missing");
  return { startOffset: start, endOffset: start + excerpt.length, excerpt };
}

async function inspectionFixture() {
  const f = await fixture();
  const content = "😀 Salt on the floor.\nThe door was open.\nSalt on the floor.";
  const excerpt = "Salt on the floor.";
  const startOffset = content.lastIndexOf(excerpt);
  const chapter = await f.library.createChapter(f.book.id, { title: "Saved", content });
  const read = await f.library.annotations.read(f.book.id);
  const saved = await f.library.annotations.save({
    ...envelope(read),
    draft: {
      kind: "create-note", note: "  Keep the second mention.\n",
      anchor: { chapterId: chapter.id, startOffset, endOffset: startOffset + excerpt.length, excerpt }
    }
  });
  if (saved.status !== "saved" || !saved.current.data) throw new Error("Expected a saved note");
  const data = saved.current.data;
  const record = data.annotations[0];
  if (record?.kind !== "note") throw new Error("Expected a note record");
  const annotation = { id: record.id, note: record.note, excerpt };
  const chapterFile = chapterPath(f.book.id, chapter.path);
  const annotationFile = sidecarPath(f.book.id, "annotations");
  const writeRecord = (next: typeof record) => f.writeRaw(annotationFile, { ...data, annotations: [next] });
  const inspect = async (id = record.id, service = f.library.annotations) => {
    const files = [chapterFile, annotationFile];
    const before = await Promise.all(files.map((path) => f.port.readFile(path)));
    const commit = spyOn(f.port, "commitFile");
    try {
      const result = await service.inspectAnchor(f.book.id, id);
      expect(commit).not.toHaveBeenCalled();
      expect(f.commits).toHaveLength(0);
      expect(f.layouts).toHaveLength(0);
      const after = await Promise.all(files.map((path) => f.port.readFile(path)));
      expect(after.map((snapshot) => snapshot?.sha256)).toEqual(before.map((snapshot) => snapshot?.sha256));
      expect(after.map((snapshot) => snapshot?.bytes)).toEqual(before.map((snapshot) => snapshot?.bytes));
      return result;
    } finally {
      commit.mockRestore();
    }
  };
  return { ...f, chapter, chapterFile, annotationFile, record, annotation, writeRecord, inspect };
}

describe("read-only annotation anchor inspection", () => {
  test("returns the stored occurrence of a repeated quotation", async () => {
    const f = await inspectionFixture();
    expect(f.chapter.content.indexOf(f.annotation.excerpt)).toBeLessThan(f.record.anchor.startOffset);
    await f.writeRecord({ ...f.record, anchor: { ...f.record.anchor, future: "preserve on disk" } });
    expect(await f.inspect()).toEqual({ status: "verified", annotation: f.annotation, anchor: f.record.anchor });
  });

  test("a newer version makes the note stale even when the stored hash matches", async () => {
    const f = await inspectionFixture();
    await f.writeRecord({ ...f.record, anchor: { ...f.record.anchor, chapterVersion: f.chapter.version - 1 } });
    expect(await f.inspect()).toEqual({ status: "stale", annotation: f.annotation });
  });

  test("different raw line endings make the note stale despite the same version and canonical body", async () => {
    const f = await inspectionFixture();
    await f.writeRaw(f.chapterFile, (await f.raw(f.chapterFile)).replaceAll("\n", "\r\n"));
    const changed = await f.library.readChapter(f.book.id, f.chapter.id);
    expect(changed.version).toBe(f.chapter.version);
    expect(changed.content).toBe(f.chapter.content);
    expect(changed.hash).not.toBe(f.chapter.hash);
    expect(await f.inspect()).toEqual({ status: "stale", annotation: f.annotation });
  });

  test("a missing source leaves the authored note available", async () => {
    const f = await inspectionFixture();
    await f.port.removeFile(f.chapterFile);
    expect(await f.inspect()).toEqual({ status: "unavailable", annotation: f.annotation });
  });

  test("unreadable chapter bytes cannot verify a matching passage", async () => {
    const f = await inspectionFixture();
    const bytes = encoder.encode(await f.raw(f.chapterFile));
    await f.port.commitFile(f.chapterFile, new Uint8Array([...bytes, 0xff]), { kind: "any" });
    expect(await f.inspect()).toEqual({ status: "unavailable", annotation: f.annotation });
  });

  test("a source read failure after enumeration leaves the note available", async () => {
    const f = await inspectionFixture();
    f.host.storage.readFile = async (path) => {
      if (path.join("/") === f.chapterFile.join("/")) throw new LibraryPortError("permission-required", "Fixture read refused");
      return f.port.readFile(path);
    };
    expect(await f.inspect(f.record.id, new AnnotationService(f.host))).toEqual({ status: "unavailable", annotation: f.annotation });
  });

  test("a same-ID copy makes the source ambiguous in the saved-book reader", async () => {
    const f = await inspectionFixture();
    await f.writeRaw(chapterPath(f.book.id, "9000-source-copy.md"), await f.raw(f.chapterFile));
    expect(await f.inspect()).toEqual({ status: "unavailable", annotation: f.annotation });
  });

  test("a chapter claiming a different owner is unavailable", async () => {
    const f = await inspectionFixture();
    const raw = await f.raw(f.chapterFile);
    await f.writeRaw(f.chapterFile, raw.replace(/^---\n/, `---\nbookId: ${f.other.id}\n`));
    expect(await f.inspect()).toEqual({ status: "unavailable", annotation: f.annotation });
  });

  test("a mismatched owning book withholds its sidecar", async () => {
    const f = await inspectionFixture();
    await f.mutateBook({ id: f.other.id });
    expect(await f.inspect()).toEqual({ status: "unavailable", annotation: null });
  });

  test("archived and missing notes do not resolve a source", async () => {
    const f = await inspectionFixture();
    const service = new AnnotationService(f.host);
    const source = spyOn(f.host, "readSavedBook");
    await f.writeRecord({ ...f.record, archived: true });
    expect(await f.inspect(f.record.id, service)).toEqual({ status: "unavailable", annotation: null });
    expect(await f.inspect("ann_missing", service)).toEqual({ status: "unavailable", annotation: null });
    await f.port.removeFile(f.annotationFile);
    expect(await f.inspect(f.record.id, service)).toEqual({ status: "unavailable", annotation: null });
    expect(source).not.toHaveBeenCalled();
  });

  test("a literal match at a span that splits a surrogate pair is stale", async () => {
    const f = await inspectionFixture();
    const excerpt = f.chapter.content.slice(1, 2);
    await f.writeRecord({ ...f.record, anchor: { ...f.record.anchor, startOffset: 1, endOffset: 2, excerpt } });
    expect(await f.inspect()).toEqual({ status: "stale", annotation: { ...f.annotation, excerpt } });
  });

  test("a different excerpt at the stored span does not trigger a search", async () => {
    const f = await inspectionFixture();
    const { startOffset, endOffset } = f.record.anchor;
    await f.writeRecord({ ...f.record, anchor: { ...f.record.anchor, startOffset: startOffset - 1, endOffset: endOffset - 1 } });
    expect(await f.inspect()).toEqual({ status: "stale", annotation: f.annotation });
  });
});

describe("checked saved-span annotations", () => {
  test("a confirmed saved span creates a bookmark and a note without changing the chapter", async () => {
    const f = await fixture();
    const content = "Alpha beta gamma";
    const chapter = await f.library.createChapter(f.book.id, { title: "Saved", content });
    const body = (await f.library.readChapter(f.book.id, chapter.id)).content;
    const before = await f.port.readFile(chapterPath(f.book.id, chapter.path));
    const read = await f.library.annotations.read(f.book.id);
    const bookmark = await f.library.annotations.save({
      ...envelope(read), draft: { kind: "create-bookmark", anchor: { chapterId: chapter.id, ...span(body, "beta") } }
    });
    expect(bookmark.status).toBe("saved");
    if (bookmark.status !== "saved" || !bookmark.current.data) throw new Error("Expected a bookmark");
    const saved = bookmark.current.data.annotations[0];
    expect(saved).toMatchObject({
      kind: "bookmark", archived: false,
      anchor: { kind: "saved-body-span", bookId: f.book.id, chapterId: chapter.id, chapterVersion: chapter.version, chapterHash: chapter.hash, excerpt: "beta" }
    });
    const note = await f.library.annotations.save({
      bookId: f.book.id, source: bookmark.current.source, baselineJson: bookmark.current.baselineJson,
      draft: { kind: "create-note", note: "Keep this", anchor: { chapterId: chapter.id, ...span(body, "gamma") } }
    });
    expect(note.status).toBe("saved");
    const after = await f.port.readFile(chapterPath(f.book.id, chapter.path));
    expect(after?.bytes).toEqual(before?.bytes);
    expect(after?.sha256).toBe(chapter.hash);
    const current = await f.library.readChapter(f.book.id, chapter.id);
    expect(current.version).toBe(chapter.version);
    expect(current.content.startsWith(content)).toBe(true);
  });

  test("a note-only edit keeps a stale anchor, and a failed source check writes nothing", async () => {
    const f = await fixture();
    const chapter = await f.library.createChapter(f.book.id, { title: "Saved", content: "Alpha beta" });
    const body = (await f.library.readChapter(f.book.id, chapter.id)).content;
    const read = await f.library.annotations.read(f.book.id);
    const created = await f.library.annotations.save({
      ...envelope(read),
      draft: { kind: "create-note", note: "First", anchor: { chapterId: chapter.id, ...span(body, "Alpha") } }
    });
    if (created.status !== "saved" || !created.current.data) throw new Error("Expected a note");
    const note = created.current.data.annotations[0];
    if (!note) throw new Error("Expected a record");
    const path = chapterPath(f.book.id, chapter.path);
    const before = await f.port.readFile(path);
    await f.writeRaw(path, "Changed body that no longer has the old span");
    const edited = await f.library.annotations.save({
      bookId: f.book.id, source: created.current.source, baselineJson: created.current.baselineJson,
      draft: { kind: "edit-note", id: note.id, note: "Second" }
    });
    expect(edited.status).toBe("saved");
    if (edited.status !== "saved" || !edited.current.data) throw new Error("Expected an edit");
    expect(edited.current.data.annotations[0]?.anchor).toEqual(note.anchor);
    expect(edited.current.data.annotations[0]).toMatchObject({ note: "Second" });
    await expect(f.library.annotations.save({
      bookId: f.book.id, source: edited.current.source, baselineJson: edited.current.baselineJson,
      draft: { kind: "re-anchor", id: note.id, anchor: { chapterId: chapter.id, startOffset: 0, endOffset: 7, excerpt: "Changed" } }
    })).rejects.toBeInstanceOf(SidecarRefusalError);
    const after = await f.library.annotations.read(f.book.id);
    expect(after.data?.annotations[0]).toMatchObject({ note: "Second", anchor: note.anchor });
    expect((await f.port.readFile(path))?.bytes).not.toEqual(before?.bytes);
  });

  test("a surrogate boundary and a duplicate excerpt at the wrong span are refused", async () => {
    const f = await fixture();
    const content = "A😀B😀C and later A😀 again";
    const chapter = await f.library.createChapter(f.book.id, { title: "Saved", content });
    const body = (await f.library.readChapter(f.book.id, chapter.id)).content;
    const emoji = body.indexOf("😀");
    const read = await f.library.annotations.read(f.book.id);
    await expect(f.library.annotations.save({
      ...envelope(read),
      draft: { kind: "create-bookmark", anchor: { chapterId: chapter.id, startOffset: emoji + 1, endOffset: emoji + 2, excerpt: body.slice(emoji + 1, emoji + 2) } }
    })).rejects.toBeInstanceOf(SidecarRefusalError);
    const first = body.indexOf("😀");
    const second = body.indexOf("😀", first + 1);
    await expect(f.library.annotations.save({
      ...envelope(read),
      draft: { kind: "create-bookmark", anchor: { chapterId: chapter.id, startOffset: second, endOffset: second + "A😀".length, excerpt: "A😀" } }
    })).rejects.toBeInstanceOf(SidecarRefusalError);
    const saved = await f.library.annotations.save({
      ...envelope(read),
      draft: { kind: "create-bookmark", anchor: { chapterId: chapter.id, startOffset: first, endOffset: first + 2, excerpt: body.slice(first, first + 2) } }
    });
    expect(saved.status).toBe("saved");
    const kept = await f.library.annotations.read(f.book.id);
    expect(kept.data?.annotations).toHaveLength(1);
    expect(kept.data?.annotations[0]?.anchor.excerpt).toBe(body.slice(first, first + 2));
    expect((await f.port.readFile(chapterPath(f.book.id, chapter.path)))?.sha256).toBe(chapter.hash);
  });

  test("unknown fields survive, a stale save keeps a verified book conflict, and an oversized file is refused", async () => {
    const f = await fixture();
    const chapter = await f.library.createChapter(f.book.id, { title: "Saved", content: "Alpha beta" });
    const body = (await f.library.readChapter(f.book.id, chapter.id)).content;
    const read = await f.library.annotations.read(f.book.id);
    const created = await f.library.annotations.save({
      ...envelope(read), draft: { kind: "create-bookmark", anchor: { chapterId: chapter.id, ...span(body, "beta") } }
    });
    if (created.status !== "saved" || !created.current.data) throw new Error("Expected a bookmark");
    const path = sidecarPath(f.book.id, "annotations");
    const withFuture = { ...created.current.data, future: { literal: "  界\r\n " } };
    await f.writeRaw(path, withFuture);
    const current = await f.library.annotations.read(f.book.id);
    const archived = await f.library.annotations.save({
      bookId: f.book.id, source: current.source, baselineJson: current.baselineJson,
      draft: { kind: "archive", id: withFuture.annotations[0]?.id, archived: true }
    });
    expect(archived.status).toBe("saved");
    expect((await f.library.annotations.read(f.book.id)).data).toMatchObject({ future: { literal: "  界\r\n " } });

    const stale = current;
    const conflict = await f.library.annotations.save({
      bookId: f.book.id, source: stale.source, baselineJson: stale.baselineJson,
      draft: { kind: "archive", id: withFuture.annotations[0]?.id, archived: false }
    });
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") throw new Error("Expected a conflict");
    expect(conflict.savedAs.includes(`/conflicts/`)).toBe(true);
    const copy = await f.port.readFile(libraryPathFromArchivePath(conflict.savedAs));
    expect(decoder.decode(copy?.bytes ?? new Uint8Array())).toBe(conflict.preserved.rawJson);
    expect(copy?.sha256).toBe(conflict.preserved.hash);

    const huge = encoder.encode(`${JSON.stringify({ ...withFuture, padding: "x".repeat(SIDECAR_BYTES) })}\n`);
    await f.port.commitFile(path, huge, { kind: "any" });
    await expect(f.library.annotations.read(f.book.id)).rejects.toThrow(/2,500,000/);
    expect((await f.port.readFile(path))?.bytes).toEqual(huge);
    expect((await f.port.readFile(chapterPath(f.book.id, chapter.path)))?.sha256).toBe(chapter.hash);
  });

  test("annotation writes do not change chapter bytes when the book schema is current", async () => {
    const f = await fixture();
    const chapter = await f.library.createChapter(f.book.id, { title: "Saved", content: "Alpha beta" });
    const body = (await f.library.readChapter(f.book.id, chapter.id)).content;
    const files = await f.port.listDirectory(chaptersPath(f.book.id));
    const before = await Promise.all(files.map(async (entry) => f.port.readFile(toLibraryPath([...chaptersPath(f.book.id), entry.name]))));
    const read = await f.library.annotations.read(f.book.id);
    await f.library.annotations.save({
      ...envelope(read), draft: { kind: "create-note", note: "Margin", anchor: { chapterId: chapter.id, ...span(body, "Alpha") } }
    });
    const after = await Promise.all(files.map(async (entry) => f.port.readFile(toLibraryPath([...chaptersPath(f.book.id), entry.name]))));
    expect(after.map((snapshot) => snapshot?.bytes)).toEqual(before.map((snapshot) => snapshot?.bytes));
    expect((await f.library.readChapter(f.book.id, chapter.id)).version).toBe(chapter.version);
    expect(await f.raw(bookFilePath(f.book.id))).toContain(`"schemaVersion": 1`);
  });

  test("a saved excerpt may be 201 or 20,000 units, 20,001 is refused, and a note keeps the prose limit", async () => {
    const f = await fixture();
    const chapter = await f.library.createChapter(f.book.id, { title: "Saved", content: "x".repeat(20_001) });
    const body = (await f.library.readChapter(f.book.id, chapter.id)).content;
    const excerpt = (units: number) => body.slice(0, units);
    expect(excerpt(201)).toBe(body.slice(0, 201));
    expect(body.startsWith(excerpt(20_001))).toBe(true);
    const read = await f.library.annotations.read(f.book.id);
    await expect(f.library.annotations.save({
      ...envelope(read),
      draft: { kind: "create-bookmark", anchor: { chapterId: chapter.id, startOffset: 0, endOffset: 20_001, excerpt: excerpt(20_001) } }
    })).rejects.toThrow(/exceeds the field limits/);
    expect((await f.library.annotations.read(f.book.id)).data).toBeNull();

    const short = await f.library.annotations.save({
      ...envelope(read),
      draft: { kind: "create-bookmark", anchor: { chapterId: chapter.id, startOffset: 0, endOffset: 201, excerpt: excerpt(201) } }
    });
    expect(short.status).toBe("saved");
    if (short.status !== "saved" || !short.current.data) throw new Error("Expected a short excerpt");
    const proseSpan = await f.library.annotations.save({
      bookId: f.book.id, source: short.current.source, baselineJson: short.current.baselineJson,
      draft: { kind: "create-bookmark", anchor: { chapterId: chapter.id, startOffset: 0, endOffset: 20_000, excerpt: excerpt(20_000) } }
    });
    expect(proseSpan.status).toBe("saved");
    const noted = await f.library.annotations.save({
      bookId: f.book.id,
      source: proseSpan.status === "saved" ? proseSpan.current.source : short.current.source,
      baselineJson: proseSpan.status === "saved" ? proseSpan.current.baselineJson : short.current.baselineJson,
      draft: { kind: "create-note", note: "n".repeat(20_000), anchor: { chapterId: chapter.id, startOffset: 0, endOffset: 201, excerpt: excerpt(201) } }
    });
    expect(noted.status).toBe("saved");
    if (noted.status !== "saved" || !noted.current.data) throw new Error("Expected a note");
    const note = noted.current.data.annotations.find((record) => record.kind === "note");
    if (!note || note.kind !== "note") throw new Error("Expected the note");
    await expect(f.library.annotations.save({
      bookId: f.book.id, source: noted.current.source, baselineJson: noted.current.baselineJson,
      draft: { kind: "edit-note", id: note.id, note: "n".repeat(20_001) }
    })).rejects.toThrow(/exceeds the field limits/);
    const kept = await f.library.annotations.read(f.book.id);
    expect(kept.data?.annotations.map((record) => record.anchor.excerpt).sort((left, right) => left.length - right.length)).toEqual([
      excerpt(201), excerpt(201), excerpt(20_000)
    ]);
    expect(kept.data?.annotations.find((record) => record.kind === "note")).toMatchObject({ note: "n".repeat(20_000) });
    expect((await f.port.readFile(chapterPath(f.book.id, chapter.path)))?.sha256).toBe(chapter.hash);
  });
});
