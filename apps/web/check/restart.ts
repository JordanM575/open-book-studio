import "./csp-validation";
import { LibraryService } from "@ai-book-studio/core/library/service";
import { browserRuntime } from "../src/runtime/browser-libraries";
import {
  newBrowserLibraryId,
  openBrowserLibrary,
  removeBrowserLibrary
} from "../src/storage/opfs";

const PHASE = "check:restart:phase";
const LIBRARY = "check:restart:library";
const BOOK = "check:restart:book";
const CHAPTER = "check:restart:chapter";
const CONTENT = "Survives a page restart.\n";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function render(check: Check): void {
  const list = document.querySelector("#checks");
  if (list) {
    list.innerHTML = `<li class="${check.ok ? "pass" : "fail"}"><strong>${check.ok ? "Pass" : "Fail"} · ${escapeHtml(check.name)}</strong><span>${escapeHtml(check.detail)}</span></li>`;
  }
  const summary = document.querySelector("#summary");
  if (summary) summary.textContent = check.ok ? "1 passed · 0 failed" : "0 passed · 1 failed";
  document.body.dataset.result = check.ok ? "pass" : "fail";
  document.body.dataset.complete = "true";
  document.title = check.ok ? "PASS · OPFS restart" : "FAIL · OPFS restart";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);
}

async function run(): Promise<void> {
  document.body.dataset.complete = "false";
  let libraryId: string | null = null;
  let cleanup = true;
  try {
    if (localStorage.getItem(PHASE) !== "verify") {
      libraryId = newBrowserLibraryId();
      localStorage.setItem(LIBRARY, libraryId);
      const library = await openBrowserLibrary(libraryId);
      const service = await LibraryService.open({ storage: library.port, runtime: browserRuntime });
      const book = await service.createBook({ title: "Restart Check", description: "Written before reload." });
      const chapter = await service.createChapter(book.id, { title: "One", content: "Before reload.\n" });
      localStorage.setItem(BOOK, book.id);
      localStorage.setItem(CHAPTER, chapter.id);
      const saved = await service.saveChapter(book.id, chapter.id, CONTENT, {
        baseVersion: chapter.version,
        baseHash: chapter.hash
      });
      if (saved.status !== "saved") throw new Error(`The first save was ${saved.status}.`);
      const before = await service.readBook(book.id);
      if (before.chapters[0]?.content !== CONTENT) throw new Error("The first read-back did not contain the saved text.");
      await new Promise((resolve) => setTimeout(resolve, 250));
      localStorage.setItem(PHASE, "verify");
      cleanup = false;
      location.replace("restart.html?verify=1");
      return;
    }

    libraryId = localStorage.getItem(LIBRARY);
    const bookId = localStorage.getItem(BOOK);
    const chapterId = localStorage.getItem(CHAPTER);
    if (!libraryId || !bookId || !chapterId) throw new Error("The restart fixture is incomplete.");
    const library = await openBrowserLibrary(libraryId);
    const service = await LibraryService.open({ storage: library.port, runtime: browserRuntime });
    const detail = await service.readBook(bookId).catch(async (error) => {
      const books = await service.listBooks();
      throw new Error(`${error instanceof Error ? error.message : String(error)} (library ${libraryId}; books ${books.map((item) => item.id).join(",") || "none"})`);
    });
    const chapter = detail.chapters.find((item) => item.id === chapterId);
    if (!chapter) throw new Error("The chapter did not survive the restart.");
    if (chapter.content !== CONTENT) throw new Error("The chapter text changed across the restart.");
    render({ name: "OPFS survives a page restart", ok: true, detail: `version ${chapter.version}` });
  } catch (error) {
    render({
      name: "OPFS survives a page restart",
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (cleanup) {
      if (libraryId) await removeBrowserLibrary(libraryId).catch(() => {});
      for (const key of [PHASE, LIBRARY, BOOK, CHAPTER]) localStorage.removeItem(key);
    }
  }
}

void run();
