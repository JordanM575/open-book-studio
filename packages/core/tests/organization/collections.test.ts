import { describe, expect, test } from "bun:test";
import { bookFilePath, booksPath, collectionsFilePath } from "../../src/library/paths";
import { libraryPathFromArchivePath, toLibraryPath, type LibraryPath } from "../../src/library/path";
import { LibraryService } from "../../src/library/service";
import { CollectionService, collectionNameKey } from "../../src/organization/collections";
import { SidecarRefusalError } from "../../src/planning/checked-sidecar";
import { decoder, encoder, SIDECAR_BYTES } from "../../src/planning/schema";
import { InMemoryLibraryPort } from "../support/in-memory-port";

async function opened() {
  const port = new InMemoryLibraryPort();
  const library = await LibraryService.open({ storage: port, runtime: port });
  const book = await library.createBook({ title: "Same title" });
  const twin = await library.createBook({ title: "Same title" });
  const other = await library.createBook({ title: "Other title" });
  const chapter = await library.createChapter(book.id, { title: "Kept", content: "One two" });
  return { port, library, book, twin, other, chapter };
}

async function filesUnder(port: InMemoryLibraryPort, root: LibraryPath): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (path: LibraryPath) => {
    for (const entry of await port.listDirectory(path)) {
      const child = toLibraryPath([...path, entry.name]);
      if (entry.kind === "directory") await walk(child);
      else {
        const snapshot = await port.readFile(child);
        found.set(child.join("/"), snapshot ? decoder.decode(snapshot.bytes) : "");
      }
    }
  };
  await walk(root);
  return found;
}

function absent() {
  return { source: { kind: "absent" as const, revision: 0 as const }, baselineJson: null };
}

describe("checked library collections", () => {
  test("create, rename, membership, archive and restore leave every manuscript byte alone", async () => {
    const { port, library, book, twin } = await opened();
    const before = await filesUnder(port, booksPath());
    const created = await library.collections.save({ ...absent(), draft: { kind: "create", name: "  Night shelf  " } });
    expect(created.status).toBe("saved");
    if (created.status !== "saved" || !created.current.data) throw new Error("Expected a collection");
    const record = created.current.data.collections[0];
    if (!record) throw new Error("Expected a record");
    expect(record).toMatchObject({ name: "Night shelf", archived: false, bookIds: [], revision: 1 });
    expect(record.id.startsWith("col_")).toBe(true);

    const renamed = await library.collections.save({
      source: created.current.source, baselineJson: created.current.baselineJson,
      draft: { kind: "rename", id: record.id, name: "Day shelf" }
    });
    expect(renamed.status).toBe("saved");
    const added = await library.collections.save({
      source: renamed.status === "saved" ? renamed.current.source : created.current.source,
      baselineJson: renamed.status === "saved" ? renamed.current.baselineJson : created.current.baselineJson,
      draft: { kind: "add-members", id: record.id, bookIds: [twin.id, book.id, book.id] }
    });
    expect(added.status).toBe("saved");
    if (added.status !== "saved" || !added.current.data) throw new Error("Expected members");
    expect(added.current.data.collections[0]?.bookIds).toEqual([book.id, twin.id].sort());

    const again = await library.collections.save({
      source: added.current.source, baselineJson: added.current.baselineJson,
      draft: { kind: "add-members", id: record.id, bookIds: [book.id] }
    });
    expect(again.status).toBe("unchanged");
    const removed = await library.collections.save({
      source: added.current.source, baselineJson: added.current.baselineJson,
      draft: { kind: "remove-members", id: record.id, bookIds: ["book_notamember1"] }
    });
    expect(removed.status).toBe("unchanged");
    const dropped = await library.collections.save({
      source: added.current.source, baselineJson: added.current.baselineJson,
      draft: { kind: "remove-members", id: record.id, bookIds: [twin.id] }
    });
    expect(dropped.status).toBe("saved");
    if (dropped.status !== "saved" || !dropped.current.data) throw new Error("Expected a removal");
    expect(dropped.current.data.collections[0]?.bookIds).toEqual([book.id]);

    const archived = await library.collections.save({
      source: dropped.current.source, baselineJson: dropped.current.baselineJson,
      draft: { kind: "archive", id: record.id }
    });
    expect(archived.status).toBe("saved");
    if (archived.status !== "saved") throw new Error("Expected an archive");
    const restored = await library.collections.save({
      source: archived.current.source, baselineJson: archived.current.baselineJson,
      draft: { kind: "restore", id: record.id }
    });
    expect(restored.status).toBe("saved");
    expect(await filesUnder(port, booksPath())).toEqual(before);
    expect(await port.readFile(bookFilePath(book.id))).not.toBeNull();
  });

  test("an active name collides after NFC and lowercase; an archived twin does not restore until renamed", async () => {
    const { library } = await opened();
    const first = await library.collections.save({ ...absent(), draft: { kind: "create", name: "E\u0301tagère" } });
    if (first.status !== "saved" || !first.current.data) throw new Error("Expected a collection");
    const occupied = first.current.data.collections[0];
    if (!occupied) throw new Error("Expected a record");
    await expect(library.collections.save({
      source: first.current.source, baselineJson: first.current.baselineJson,
      draft: { kind: "create", name: " étagère " }
    })).rejects.toBeInstanceOf(SidecarRefusalError);
    expect(collectionNameKey("E\u0301tagère")).toBe(collectionNameKey(" étagère "));

    const second = await library.collections.save({
      source: first.current.source, baselineJson: first.current.baselineJson,
      draft: { kind: "create", name: "Spare" }
    });
    if (second.status !== "saved" || !second.current.data) throw new Error("Expected a second collection");
    const spare = second.current.data.collections.find((record) => record.name === "Spare");
    if (!spare) throw new Error("Expected the spare");
    const archived = await library.collections.save({
      source: second.current.source, baselineJson: second.current.baselineJson,
      draft: { kind: "archive", id: spare.id }
    });
    if (archived.status !== "saved") throw new Error("Expected an archive");
    const taken = await library.collections.save({
      source: archived.current.source, baselineJson: archived.current.baselineJson,
      draft: { kind: "rename", id: occupied.id, name: "Spare" }
    });
    if (taken.status !== "saved") throw new Error("Expected a rename");
    await expect(library.collections.save({
      source: taken.current.source, baselineJson: taken.current.baselineJson,
      draft: { kind: "restore", id: spare.id }
    })).rejects.toBeInstanceOf(SidecarRefusalError);
    const renamed = await library.collections.save({
      source: taken.current.source, baselineJson: taken.current.baselineJson,
      draft: { kind: "rename-and-restore", id: spare.id, name: "Spare again" }
    });
    expect(renamed.status).toBe("saved");
    if (renamed.status !== "saved" || !renamed.current.data) throw new Error("Expected a restore");
    expect(renamed.current.data.collections.find((record) => record.id === spare.id)).toMatchObject({
      archived: false, name: "Spare again"
    });
  });

  test("a same-title book is not substituted, and unavailable members stay listed", async () => {
    const { port, library, book, twin } = await opened();
    const created = await library.collections.save({ ...absent(), draft: { kind: "create", name: "Shelf" } });
    if (created.status !== "saved") throw new Error("Expected a collection");
    const id = created.current.data?.collections[0]?.id;
    if (!id) throw new Error("Expected an id");
    const added = await library.collections.save({
      source: created.current.source, baselineJson: created.current.baselineJson,
      draft: { kind: "add-members", id, bookIds: [book.id, "book_missing0001"] }
    });
    if (added.status !== "saved" || !added.current.data) throw new Error("Expected members");
    expect(added.current.data.collections[0]?.bookIds).toEqual([book.id, "book_missing0001"].sort());
    expect(added.current.data.collections[0]?.bookIds).not.toContain(twin.id);
    await port.removeFile(bookFilePath(book.id));
    const current = await library.collections.read();
    expect(current.data?.collections[0]?.bookIds).toContain(book.id);
    expect(current.data?.collections[0]?.bookIds).not.toContain(twin.id);
  });

  test("a stale baseline keeps the newer file and a verified root conflict copy", async () => {
    const { port, library } = await opened();
    const created = await library.collections.save({ ...absent(), draft: { kind: "create", name: "First" } });
    if (created.status !== "saved" || !created.current.baselineJson) throw new Error("Expected a baseline");
    const stale = created.current;
    await library.collections.save({
      source: stale.source, baselineJson: stale.baselineJson, draft: { kind: "create", name: "Second" }
    });
    const conflict = await library.collections.save({
      source: stale.source, baselineJson: stale.baselineJson, draft: { kind: "create", name: "Third" }
    });
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") throw new Error("Expected a conflict");
    expect(conflict.savedAs.startsWith("conflicts/")).toBe(true);
    const copy = await port.readFile(libraryPathFromArchivePath(conflict.savedAs));
    expect(copy).not.toBeNull();
    expect(decoder.decode(copy?.bytes ?? new Uint8Array())).toBe(conflict.preserved.rawJson);
    expect(copy?.sha256).toBe(conflict.preserved.hash);
    const parsed = JSON.parse(conflict.preserved.rawJson) as { collections: Array<{ name: string }> };
    expect(parsed.collections.map((record) => record.name)).toContain("Third");
    expect((await library.collections.read()).data?.collections.map((record) => record.name)).toEqual(["First", "Second"]);
  });

  test("unknown fields survive, and an over-budget file is refused rather than rewritten", async () => {
    const { port, library } = await opened();
    const created = await library.collections.save({ ...absent(), draft: { kind: "create", name: "Shelf" } });
    if (created.status !== "saved" || !created.current.data) throw new Error("Expected a collection");
    const withFuture = { ...created.current.data, future: { literal: "  界\r\n " } };
    await port.commitFile(collectionsFilePath(), encoder.encode(`${JSON.stringify(withFuture, null, 2)}\n`), { kind: "any" });
    const current = await library.collections.read();
    const renamed = await library.collections.save({
      source: current.source, baselineJson: current.baselineJson,
      draft: { kind: "rename", id: withFuture.collections[0]?.id, name: "Kept future" }
    });
    expect(renamed.status).toBe("saved");
    expect((await library.collections.read()).data).toMatchObject({ future: { literal: "  界\r\n " } });

    const huge = encoder.encode(`${JSON.stringify({ ...withFuture, padding: "x".repeat(SIDECAR_BYTES) })}\n`);
    await port.commitFile(collectionsFilePath(), huge, { kind: "any" });
    await expect(library.collections.read()).rejects.toThrow(/2,500,000/);
    await expect(library.collections.save({
      ...absent(), draft: { kind: "create", name: "Replacement" }
    })).rejects.toThrow();
    expect((await port.readFile(collectionsFilePath()))?.bytes).toEqual(huge);
  });

  test("a newer book schema blocks that book's queue and still allows a collection save", async () => {
    const { port, library, book } = await opened();
    const bookPath = bookFilePath(book.id);
    const raw = JSON.parse(decoder.decode((await port.readFile(bookPath))?.bytes ?? new Uint8Array())) as { schemaVersion: number };
    await port.commitFile(bookPath, encoder.encode(`${JSON.stringify({ ...raw, schemaVersion: 2 }, null, 2)}\n`), { kind: "any" });
    await expect(library.createChapter(book.id, { title: "Blocked", content: "No" })).rejects.toThrow(/newer/i);
    const saved = await library.collections.save({ ...absent(), draft: { kind: "create", name: "Still library-root" } });
    expect(saved.status).toBe("saved");
    expect((await port.readFile(bookPath))?.bytes.byteLength).toBeGreaterThan(0);
  });

  test("archive and remove do not move a book, and a semantic no-op writes nothing", async () => {
    const { port, library, book } = await opened();
    const before = await filesUnder(port, booksPath());
    const journalBefore = await port.listDirectory(toLibraryPath([".studio", "sync"]));
    const created = await library.collections.save({ ...absent(), draft: { kind: "create", name: "Shelf" } });
    if (created.status !== "saved" || !created.current.data) throw new Error("Expected a collection");
    const id = created.current.data.collections[0]?.id;
    const archived = await library.collections.save({
      source: created.current.source, baselineJson: created.current.baselineJson,
      draft: { kind: "archive", id: id ?? "" }
    });
    if (archived.status !== "saved") throw new Error("Expected an archive");
    const repeat = await library.collections.save({
      source: archived.current.source, baselineJson: archived.current.baselineJson,
      draft: { kind: "archive", id: id ?? "" }
    });
    expect(repeat.status).toBe("unchanged");
    expect(await filesUnder(port, booksPath())).toEqual(before);
    expect(await port.listDirectory(toLibraryPath([".studio", "sync"]))).toEqual(journalBefore);
    expect(await port.readFile(bookFilePath(book.id))).not.toBeNull();
  });
});

void CollectionService;
