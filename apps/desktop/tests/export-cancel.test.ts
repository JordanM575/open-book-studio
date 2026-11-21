import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookDetail } from "@ai-book-studio/core/schema";
import { Library } from "../src/main/library/store";
import {
  cancelledExportOutcome,
  collectManuscriptImages,
  exportManuscriptDocx,
  exportManuscriptEpub,
  exportManuscriptMarkdown,
  exportManuscriptPdf,
  type ExportDeps
} from "../src/main/export";
import { ExportAttemptRegistry } from "../src/main/export-attempts";

/*
 * Spec 035 T016: attempt-bound cancellation for the four single-file targets, at the
 * boundary where publication is decided. Synthetic bytes in isolated temporary folders.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==", "base64"));
const CANCELLED = "The export was cancelled before it was published. Nothing was written.";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "studio-export-cancel-"));
  roots.push(root);
  const library = await Library.open(join(root, "library"));
  const book = await library.createBook({ title: "Synthetic export" });
  const chapter = await library.createChapter(book.id, { title: "First", content: "SYNTHETIC_SAVED_BODY\n" });
  const image = await library.addImage(book.id, { bytes: PNG, kind: "chapter", prompt: "Synthetic pixel", provider: "fixture", model: "fixture" });
  await library.attachImage(book.id, image.id, chapter.id);
  const detail = await library.readBook(book.id);
  const out = await mkdtemp(join(tmpdir(), "studio-export-cancel-out-"));
  roots.push(out);
  return { library, detail, out };
}

type Kind = "docx" | "markdown" | "pdf" | "epub";

function dependencies(path: string, overrides: Partial<ExportDeps> = {}): ExportDeps {
  return {
    pickDestination: async () => path,
    confirmReplace: async () => true,
    statDestination: async (file) => {
      try { const value = await stat(file); return { size: value.size, mtimeMs: value.mtimeMs }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    ...overrides
  };
}

/** Abort when the atomic writer syncs the staged bytes, after the write and before rename. */
function abortAtSync(controller: AbortController): ExportDeps["atomic"] {
  return {
    open: async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (!String(args[0]).endsWith(".tmp")) return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "sync") {
            return async () => {
              controller.abort();
              await target.sync();
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  };
}

async function publish(
  kind: Kind,
  detail: BookDetail,
  library: Library,
  deps: ExportDeps
): Promise<string | null> {
  const { illustrations } = await collectManuscriptImages(detail, library);
  if (kind === "docx") return exportManuscriptDocx(detail, illustrations, library.root, deps);
  if (kind === "markdown") return exportManuscriptMarkdown(detail, library.root, deps);
  if (kind === "pdf") {
    return exportManuscriptPdf(detail, illustrations, library.root, {
      ...deps,
      renderPdf: async (html) => Buffer.from(`%PDF-SYNTHETIC\n${html}`)
    });
  }
  return exportManuscriptEpub(detail, illustrations, library.root, deps);
}

describe("single-file export cancellation", () => {
  for (const kind of ["docx", "markdown", "epub"] as const) {
    test(`${kind}: an accepted cancel at the staging sync leaves the prior file untouched and no temp`, async () => {
      const { library, detail, out } = await fixture();
      const destination = join(out, `prior.${kind}`);
      await writeFile(destination, "SYNTHETIC_PRIOR_OUTPUT");
      const controller = new AbortController();
      const error = await publish(
        kind,
        detail,
        library,
        dependencies(destination, { signal: controller.signal, atomic: abortAtSync(controller) })
      ).catch((e: unknown) => e);
      expect(cancelledExportOutcome(error)).toEqual({ status: "cancelled", message: CANCELLED });
      expect(await readFile(destination, "utf8")).toBe("SYNTHETIC_PRIOR_OUTPUT");
      expect(await readdir(out)).toEqual([`prior.${kind}`]);
    });
  }

  test("pdf: a cancel before the build never renders, never asks to replace and writes nothing", async () => {
    const { library, detail, out } = await fixture();
    const destination = join(out, "prior.pdf");
    await writeFile(destination, "SYNTHETIC_PRIOR_OUTPUT");
    const controller = new AbortController();
    controller.abort();
    let renders = 0;
    let confirmed = 0;
    const error = await exportManuscriptPdf(detail, new Map(), library.root, {
      ...dependencies(destination, { signal: controller.signal }),
      confirmReplace: async () => {
        confirmed += 1;
        return true;
      },
      renderPdf: async () => {
        renders += 1;
        return Buffer.from("%PDF-SYNTHETIC");
      }
    }).catch((e: unknown) => e);
    expect(renders).toBe(0);
    expect(confirmed).toBe(0);
    expect(cancelledExportOutcome(error)).toEqual({ status: "cancelled", message: CANCELLED });
    expect(await readFile(destination, "utf8")).toBe("SYNTHETIC_PRIOR_OUTPUT");
    expect(await readdir(out)).toEqual(["prior.pdf"]);
  });

  test("a temp that cannot be unlinked still settles cancelled and names the exact path", async () => {
    const { library, detail, out } = await fixture();
    const destination = join(out, "prior.docx");
    await writeFile(destination, "SYNTHETIC_PRIOR_OUTPUT");
    const controller = new AbortController();
    const error = await publish("docx", detail, library, dependencies(destination, {
      signal: controller.signal,
      atomic: {
        ...abortAtSync(controller),
        unlink: async () => {
          throw Object.assign(new Error("synthetic unlink failure"), { code: "EACCES" });
        }
      }
    })).catch((e: unknown) => e);
    const outcome = cancelledExportOutcome(error);
    expect(outcome?.status).toBe("cancelled");
    const names = await readdir(out);
    const leftover = names.find((name) => name !== "prior.docx");
    expect(typeof leftover).toBe("string");
    expect(outcome?.message).toContain(join(out, leftover ?? ""));
    expect(outcome?.message).toContain("Temporary output could not be removed");
    expect(await readFile(destination, "utf8")).toBe("SYNTHETIC_PRIOR_OUTPUT");
  });

  test("a cancel after the publish start is too late and the file is published", async () => {
    const { library, detail, out } = await fixture();
    const destination = join(out, "published.docx");
    const registry = new ExportAttemptRegistry();
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const begun = registry.begin(detail.book.id, "docx", attemptId);
    if (!begun.ok) throw new Error("expected begin to succeed");
    const late: Array<ReturnType<ExportAttemptRegistry["cancel"]>> = [];
    const path = await exportManuscriptDocx(detail, new Map(), library.root, {
      ...dependencies(destination),
      signal: begun.signal,
      onPublishStart: begun.onPublishStart,
      atomic: {
        rename: async (from, to) => {
          late.push(registry.cancel(detail.book.id, attemptId));
          await rename(from, to);
        }
      }
    });
    registry.settle(attemptId);
    expect(path).toBe(destination);
    expect(late).toEqual([{ status: "too-late", attemptId }]);
    expect((await readFile(destination)).subarray(0, 2).toString()).toBe("PK");
  });

  test("an untouched destination parent has no staging debris after a cancel", async () => {
    const { library, detail, out } = await fixture();
    const destination = join(out, "fresh.epub");
    const controller = new AbortController();
    const error = await publish("epub", detail, library, dependencies(destination, {
      signal: controller.signal,
      // Abort after the first staging write but before rename: the same atomic gate refuses.
      atomic: abortAtSync(controller)
    })).catch((e: unknown) => e);
    expect(cancelledExportOutcome(error)?.status).toBe("cancelled");
    expect(await readdir(out)).toEqual([]);
    await expect(lstat(destination)).rejects.toThrow();
  });
});
