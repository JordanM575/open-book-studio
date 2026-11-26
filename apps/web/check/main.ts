import "./csp-validation";
import { createLibraryArchive } from "@ai-book-studio/core/archive/export";
import { archiveSourceFromBytes, importLibraryArchive } from "@ai-book-studio/core/archive/import";
import { LibraryService } from "@ai-book-studio/core/library/service";
import type { LibraryRuntime } from "@ai-book-studio/core/library/port";
import { BrowserLibraries } from "../src/runtime/browser-libraries";
import { detectStorageCapabilities } from "../src/storage/capabilities";
import { webLock, webLocksAvailable } from "../src/storage/directory-port";
import { deleteStorageSetting, readStorageSetting, writeStorageSetting } from "../src/storage/indexeddb";
import {
  newBrowserLibraryId,
  openBrowserLibrary,
  removeBrowserLibrary,
  requestPersistence,
  storageEstimate,
  type BrowserLibrary
} from "../src/storage/opfs";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

const runtime: LibraryRuntime = {
  now: () => new Date().toISOString(),
  newId: (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
  sha256: async (bytes) => {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
};

async function check(name: string, work: () => Promise<string>): Promise<void> {
  try {
    checks.push({ name, ok: true, detail: await work() });
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  render();
}

function render(): void {
  const list = document.querySelector("#checks");
  if (list) {
    list.innerHTML = checks
      .map((item) => `<li class="${item.ok ? "pass" : "fail"}"><strong>${item.ok ? "Pass" : "Fail"} · ${escapeHtml(item.name)}</strong><span>${escapeHtml(item.detail)}</span></li>`)
      .join("");
  }
  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;
  const summary = document.querySelector("#summary");
  if (summary) summary.textContent = `${passed} passed · ${failed} failed`;
  document.body.dataset.result = failed === 0 ? "pass" : "fail";
  document.title = failed === 0 ? "PASS · Browser storage check" : "FAIL · Browser storage check";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function run(): Promise<void> {
  document.body.dataset.complete = "false";
  const capabilities = detectStorageCapabilities();
  const folderId = newBrowserLibraryId();
  const importId = newBrowserLibraryId();

  await check("capabilities", async () => JSON.stringify(capabilities));
  let library: BrowserLibrary | null = null;
  await check("origin storage opens", async () => {
    if (!capabilities.browserStorage) throw new Error("OPFS is unavailable in this browser.");
    library = await Promise.race([
      openBrowserLibrary(folderId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("OPFS did not open within 10 seconds.")), 10_000))
    ]);
    return "OPFS root available";
  });
  if (!library) {
    document.body.dataset.complete = "true";
    return;
  }

  const service = await LibraryService.open({ storage: library.port, runtime });
  const book = await service.createBook({ title: "Browser Check", description: "Written in OPFS." });
  const chapter = await service.createChapter(book.id, { title: "One", content: "First line.\n" });

  await check("create a book and chapter", async () => {
    const detail = await service.readBook(book.id);
    if (detail.chapters[0]?.id !== chapter.id) throw new Error("The chapter is missing after reopening the book.");
    return `${detail.book.title} · ${detail.chapters.length} chapter`;
  });

  const saved = await service.saveChapter(book.id, chapter.id, "Second line.\n", {
    baseVersion: chapter.version,
    baseHash: chapter.hash
  });
  await check("save with the base hash", async () => {
    if (saved.status !== "saved" || saved.chapter.version !== 2) throw new Error("The save did not commit a new version.");
    return `version ${saved.chapter.version}`;
  });

  await check("reopen the same OPFS library", async () => {
    const again = await openBrowserLibrary(folderId);
    const reopened = await LibraryService.open({ storage: again.port, runtime });
    const detail = await reopened.readBook(book.id);
    if (detail.chapters[0]?.content !== "Second line.\n") throw new Error("The saved text was not durable.");
    return `device ${reopened.deviceId.slice(0, 14)}…`;
  });

  await check("a stale save becomes a conflict", async () => {
    const stale = await service.saveChapter(book.id, chapter.id, "Stale device text.\n", {
      baseVersion: chapter.version,
      baseHash: chapter.hash
    });
    if (stale.status !== "conflict") throw new Error("The stale save overwrote the newer text.");
    const current = await service.readChapter(book.id, chapter.id);
    if (current.content !== "Second line.\n") throw new Error("The newer text was replaced.");
    return `${stale.conflict.reason} · ${stale.conflict.savedAs.split("/").pop()}`;
  });

  const archive = await createLibraryArchive({ storage: library.port, runtime }, { appVersion: "check" });
  const chunks: Uint8Array[] = [];
  for await (const chunk of archive.chunks) chunks.push(chunk);
  const bytes = concat(chunks);
  await check("export a portable archive", async () => {
    if (bytes.length === 0 || archive.manifest.entryCount < 2) throw new Error("The archive is empty.");
    if (!archive.manifest.entries.some((entry) => entry.path.includes("/conflicts/"))) {
      throw new Error("The conflict copy is missing from the archive.");
    }
    return `${archive.manifest.entryCount} files · ${bytes.length} bytes`;
  });

  await check("import into a second browser library", async () => {
    const target = await openBrowserLibrary(importId);
    await importLibraryArchive(archiveSourceFromBytes(bytes), target.port, runtime);
    const imported = await LibraryService.open({ storage: target.port, runtime });
    const detail = await imported.readBook(book.id);
    if (detail.book.title !== "Browser Check") throw new Error("The imported book identity changed.");
    if (detail.chapters[0]?.content !== "Second line.\n") throw new Error("The imported chapter text changed.");
    return `${detail.book.title} · ${detail.chapters.length} chapter`;
  });

  await check("IndexedDB round-trip", async () => {
    await writeStorageSetting("check", { ok: true, at: new Date().toISOString() });
    const value = await readStorageSetting<{ ok: boolean }>("check");
    await deleteStorageSetting("check");
    if (!value?.ok) throw new Error("The value did not come back.");
    return "handle store works";
  });

  await check("folder mode through a picked OPFS handle", async () => {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle("folder-mode-check", { create: true });
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => folder
    });
    const libraries = new BrowserLibraries();
    try {
      const info = await libraries.chooseFolder();
      if (!info?.root.startsWith("folder://")) throw new Error("The picked folder did not open as a folder library.");
      const folderBook = await libraries.require().createBook({ title: "Folder Check" });
      const folderChapter = await libraries.require().createChapter(folderBook.id, {
        title: "One",
        content: "Picked folder prose.\n"
      });
      const folderSave = await libraries.require().saveChapter(folderBook.id, folderChapter.id, "Updated folder prose.\n", {
        baseVersion: folderChapter.version,
        baseHash: folderChapter.hash
      });
      if (folderSave.status !== "saved") throw new Error("The folder save did not commit.");
      return `${info.root} · ${folderBook.title}`;
    } finally {
      delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
      await deleteStorageSetting("library-selection").catch(() => {});
      await root.removeEntry("folder-mode-check", { recursive: true }).catch(() => {});
    }
  });

  await check("picker cancellation leaves no library selected", async () => {
    const libraries = new BrowserLibraries();
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      }
    });
    try {
      const info = await libraries.chooseFolder();
      if (info !== null) throw new Error("A cancelled picker selected a library.");
      if (libraries.info() !== null) throw new Error("A cancelled picker left a tier selected.");
      return "cancelled · no tier switch";
    } finally {
      delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    }
  });

  await check("denied folder permission keeps the pending folder", async () => {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle("permission-check", { create: true });
    Object.defineProperty(folder, "requestPermission", {
      configurable: true,
      value: async () => "denied"
    });
    const libraries = new BrowserLibraries();
    libraries.pendingFolder = folder;
    let code = "";
    try {
      await libraries.reconnectFolder();
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    if (code !== "permission-required") throw new Error(`Unexpected result: ${code || "no error"}`);
    if (libraries.pendingFolder !== folder) throw new Error("The denied folder was discarded.");
    if (libraries.info() !== null) throw new Error("A denied folder silently switched tiers.");
    await root.removeEntry("permission-check", { recursive: true }).catch(() => {});
    return "permission-required · folder kept";
  });

  await check("two tabs serialize writes with Web Locks", async () => {
    if (!webLocksAvailable()) return "Web Locks unavailable";
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const order: string[] = [];
    const first = webLock("check:two-tabs", async () => {
      order.push("first:start");
      started();
      await gate;
      order.push("first:end");
    });
    await firstStarted;
    const second = webLock("check:two-tabs", async () => {
      order.push("second:start");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (order.includes("second:start")) throw new Error("The second tab entered while the first held the lock.");
    release();
    await Promise.all([first, second]);
    if (order.join("|") !== "first:start|first:end|second:start") {
      throw new Error(`Unexpected lock order: ${order.join("|")}`);
    }
    return "serialized";
  });

  await check("persistence and quota", async () => {
    const persistence = await requestPersistence();
    const estimate = await storageEstimate();
    return `${persistence} · ${estimate ? `${Math.round(estimate.usage / 1024)} KiB used` : "no estimate"}`;
  });

  await check("cleanup", async () => {
    await removeBrowserLibrary(folderId);
    await removeBrowserLibrary(importId);
    return "temporary libraries removed";
  });

  document.body.dataset.complete = "true";
}

void run().catch((error: unknown) => {
  checks.push({ name: "unexpected failure", ok: false, detail: error instanceof Error ? error.message : String(error) });
  render();
  document.body.dataset.complete = "true";
});
