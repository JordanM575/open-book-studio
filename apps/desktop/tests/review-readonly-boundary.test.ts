import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Static and surface checks for the reader-review read-only boundary.
 *
 * The dynamic half of the proof lives in review-service.test.ts (writer spies over the whole
 * Library surface plus a whole-tree fingerprint) and in reader-review-journey.test.tsx. This file
 * pins the static half: the review data-plane modules must not import storage, mutation or host
 * capabilities, and the three host surfaces (preload, browser stub, IPC map) must expose exactly
 * the five bounded reader-review operations and nothing else.
 */

const repoRoot = join(import.meta.dir, "..", "..", "..");

/** The reader-review data plane: every module on the prepare/start/stop/cancel path. */
const CORE_REVIEW_FILES = [
  "packages/core/src/review/contract.ts",
  "packages/core/src/review/envelope.ts",
  "packages/core/src/review/facade.ts",
  "packages/core/src/review/findings.ts",
  "packages/core/src/review/host-facts.ts",
  "packages/core/src/review/profiles.ts",
  "packages/core/src/review/reader-api.ts",
  "packages/core/src/review/selection.ts",
  "packages/core/src/review/sources.ts",
  "packages/core/src/review/wire-schema.ts",
  "packages/core/src/review/shared-verifier.ts"
] as const;

const DESKTOP_MAIN_FILES = [
  "apps/desktop/src/main/review/service.ts",
  "apps/desktop/src/main/review/transport.ts"
] as const;

const APP_READER_REVIEW_COMPONENTS = [
  "packages/app/src/components/reader-review/ReaderReviewHost.tsx",
  "packages/app/src/components/reader-review/ReaderReviewPanel.tsx",
  "packages/app/src/components/reader-review/ReaderReviewResults.tsx",
  "packages/app/src/components/reader-review/ReviewDisclosure.tsx",
  "packages/app/src/components/reader-review/SaveReviewControl.tsx",
  "packages/app/src/components/reader-review/contracts.ts"
] as const;

const STATIC_SCAN_FILES = [...CORE_REVIEW_FILES, ...DESKTOP_MAIN_FILES, ...APP_READER_REVIEW_COMPONENTS] as const;

/**
 * Narrow, documented exceptions: SaveReviewControl is the explicit "Save review" seam. It renders
 * only when the host injects a persistence handle (this slice's hosts never do). It references the
 * review-record API for types and failure copy; no other reader-review component may touch it.
 */
const IMPORT_ALLOWLIST: Readonly<Record<string, readonly RegExp[]>> = {
  "packages/app/src/components/reader-review/SaveReviewControl.tsx": [/library\/review-record-api/]
};

/** Import specifiers that are never legitimate anywhere on the reader-review path. */
const FORBIDDEN_IMPORT = [
  /^(?:node:)?fs(\/promises)?$/i,
  /^(?:node:)?os$/i,
  /^(?:node:)?child_process$/i,
  /(^|\/)atomic(\.|$|\/)/i,
  /record-store|record-format|record-recovery|record-intent|review-record-api/i,
  /campaign-continuation-(store|wire|checkpoint|tokens|segments|group|resolve|metrics|replan|fixed-history|match|build|checkin)/i,
  /thread-store|ThreadStore/i,
  /image-store|ImageStore/i,
  /\/agent\/(runtime|tools)(\/|$)/i,
  /\/tools(\/|$)/i,
  /\/plugins?(\/|$)/i,
  /library\/atomic|library\/store|library\/service/i,
  /browser-fs|node-fetch|undici/i
] as const;

/** Call-shaped or environment tokens that must not appear in the scanned files at all. */
const FORBIDDEN_TEXT = [
  /\bchild_process\b/,
  /\bexecSync\s*\(/,
  /\bspawnSync?\s*\(/,
  /\bwriteFile(Sync)?\s*\(/,
  /\bappendFile(Sync)?\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\bunlink(Sync)?\s*\(/,
  /\brm(Sync)?\s*\(/,
  /\brmdir(Sync)?\s*\(/,
  /\bmkdir(Sync)?\s*\(/,
  /\brename(Sync)?\s*\(/,
  /\bprocess\.env\b/,
  /\bipcMain\b/,
  /\bipcRenderer\b/,
  /\bwebContents\b/,
  /\bBrowserWindow\b/,
  /\bXMLHttpRequest\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bnavigator\.sendBeacon\b/,
  /\bnew Function\b/,
  /\beval\s*\(/,
  /\bfetch\s*\(/
] as const;

/** The browser host legitimately wires Saved reviews; it must still not touch storage engines or node builtins. */
const BROWSER_FORBIDDEN_IMPORT = [
  /^(?:node:)?fs(\/promises)?$/i,
  /^(?:node:)?os$/i,
  /^(?:node:)?child_process$/i,
  /(^|\/)atomic(\.|$|\/)/i,
  /record-store|record-format|record-recovery/i,
  /campaign-continuation-(store|wire|checkpoint|tokens|segments|group|resolve|metrics|replan|fixed-history|match|build|checkin)/i,
  /thread-store|ThreadStore/i,
  /image-store|ImageStore/i,
  /\/agent\/(runtime|tools)(\/|$)/i,
  /library\/atomic|library\/store|library\/service/i
] as const;

/** Files with a legitimate narrower contract than the blanket text ban. */
const IPC_RENDERER_ALLOWED = new Set(["apps/desktop/src/preload/index.ts"]);

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [/import[\s\S]*?from\s*["']([^"']+)["']/g, /import\s*\(\s*["']([^"']+)["']\s*\)/g, /import\s*["']([^"']+)["']/g, /export[\s\S]*?from\s*["']([^"']+)["']/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) specifiers.push(specifier);
    }
  }
  return specifiers;
}

const sources = new Map<string, string>();
async function sourceOf(relative: string): Promise<string> {
  let cached = sources.get(relative);
  if (cached === undefined) {
    cached = await readFile(join(repoRoot, relative), "utf8");
    sources.set(relative, cached);
  }
  return cached;
}

describe("reader-review read-only boundary: static scan", () => {
  for (const file of STATIC_SCAN_FILES) {
    test(`${file} imports no storage, mutation or host capability`, async () => {
      const source = await sourceOf(file);
      const allowlist = IMPORT_ALLOWLIST[file] ?? [];
      for (const specifier of importSpecifiers(source)) {
        if (allowlist.some((pattern) => pattern.test(specifier))) continue;
        for (const pattern of FORBIDDEN_IMPORT) {
          expect(pattern.test(specifier), `${file} imports forbidden module ${JSON.stringify(specifier)}`).toBe(false);
        }
      }
    });

    test(`${file} contains no process, fs, ipc or network capability`, async () => {
      const source = await sourceOf(file);
      for (const pattern of FORBIDDEN_TEXT) {
        if (IPC_RENDERER_ALLOWED.has(file) && pattern.source === "\\bipcRenderer\\b") continue;
        const match = pattern.exec(source);
        expect(match === null, `${file} contains forbidden pattern ${pattern} at ${match?.index ?? -1}`).toBe(true);
      }
    });
  }

  test("the preload exposes its API only through contextBridge and keeps ipcRenderer internal", async () => {
    const source = await sourceOf("apps/desktop/src/preload/index.ts");
    expect(source).toContain("contextBridge");
    // The exposed object literal handed to contextBridge must not leak the raw bridge or require.
    expect(source).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
    expect(source).toMatch(/readerReview:\s*createReaderReviewApi/);
    // No storage or spawn capability in the preload at all.
    for (const pattern of FORBIDDEN_TEXT) {
      if (pattern.source === "\\bipcRenderer\\b") continue;
      expect(pattern.test(source), `preload contains forbidden pattern ${pattern}`).toBe(false);
    }
  });

  test("the browser stub refuses every operation and imports no storage engine", async () => {
    const source = await sourceOf("apps/web/src/runtime/browser-api.ts");
    expect(source).toContain("unsupportedReaderReviewApi");
    const wiring = source.split("\n").filter((line) => /readerReview\s*:/.test(line));
    expect(wiring).toHaveLength(1);
    expect(wiring[0]).toContain("unsupportedReaderReviewApi");
    for (const pattern of BROWSER_FORBIDDEN_IMPORT) {
      for (const specifier of importSpecifiers(source)) {
        expect(pattern.test(specifier), `browser-api imports forbidden module ${JSON.stringify(specifier)}`).toBe(false);
      }
    }
    for (const pattern of [/\bipcMain\b/, /\bipcRenderer\b/, /\bBrowserWindow\b/, /\bwebContents\b/, /\bcontextBridge\b/]) {
      expect(pattern.test(source), `browser-api contains forbidden token ${pattern}`).toBe(false);
    }
  });

  test("the desktop main process wires the reader review to exactly one channel", async () => {
    const source = await sourceOf("apps/desktop/src/main/ipc.ts");
    const registrations = source.match(/ipcMain\.handle\(\s*readerReviewChannel/g) ?? [];
    expect(registrations).toHaveLength(1);
    // The reader-review block must not name any writer or store.
    const block = source.slice(source.indexOf("const handleReaderReview"), source.indexOf("const handleReaderReview") + 400);
    expect(block).not.toMatch(/createChapter|saveChapter|updateBook|deleteChapter|deleteBook|saveMatter|captureChapterHistory|restoreChapterHistory|undoChapterHistory|appendToThread|putThread|addImage|writeFile/);
  });

  test("the IPC channel map names exactly one reader-review channel and no review-writer channel", async () => {
    const { IPC } = await import("@ai-book-studio/core/ipc");
    const values: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") { values.push(node); return; }
      if (node && typeof node === "object") for (const child of Object.values(node)) walk(child);
    };
    walk(IPC);
    const reviewChannels = values.filter((value) => /review/i.test(value)).sort();
    expect(reviewChannels).toEqual(["readerReview:request", "reviewRecords:request"]);
    expect(values.filter((value) => /reader/i.test(value))).toEqual(["readerReview:request"]);
    // No channel name anywhere in the map may name a review write or record mutation for the reader path.
    expect(values.filter((value) => /readerReview/i.test(value))).toHaveLength(1);
  });

  test("the reader-review components never reference fetch, storage or IPC globals", async () => {
    for (const file of APP_READER_REVIEW_COMPONENTS) {
      const source = await sourceOf(file);
      for (const pattern of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bipcRenderer\b/, /\bipcMain\b/]) {
        expect(pattern.test(source), `${file} contains forbidden pattern ${pattern}`).toBe(false);
      }
    }
  });

  test("SaveReviewControl is the only reader-review component that touches the review-record API", async () => {
    for (const file of APP_READER_REVIEW_COMPONENTS) {
      const source = await sourceOf(file);
      const references = /library\/review-record-api/.test(source);
      const isSaveControl = file.endsWith("SaveReviewControl.tsx");
      expect(references, `${file} references review-record-api (allowed only in SaveReviewControl.tsx)`).toBe(isSaveControl);
    }
  });
});

describe("reader-review read-only boundary: browser stub behaviour", () => {
  test("every browser operation refuses with unsupported and support() reports unsupported", async () => {
    const { unsupportedReaderReviewApi } = await import("@ai-book-studio/core/review/reader-api");
    const api = unsupportedReaderReviewApi();
    expect(await api.support()).toEqual({ ok: true, data: { supported: false, reason: "unsupported-host" } });
    const prepare = await api.prepare({ prepareId: "p-1", bookId: "book_123456", profileId: "reader-alpha",
      chapters: [{ chapterId: "ch_123456", ranges: [{ start: 0, end: 1 }] }], prompt: "Synthetic." });
    for (const result of [prepare, await api.start({ requestId: "r-1", scopeDigest: "a".repeat(64) }),
      await api.stop({ requestId: "r-1" }), await api.cancelPrepare({ prepareId: "p-1" })]) {
      expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
    }
  });
});

describe("reader-review read-only boundary: no network during the boundary path", () => {
  test("the reader-review service handler chain performs no fetch and completes in-process", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((() => { calls.push("fetch"); return Promise.reject(new Error("network forbidden")); }) as unknown) as typeof fetch;
    try {
      const { readerReviewHandler } = await import("@ai-book-studio/core/review/reader-api");
      const handler = readerReviewHandler({
        support: async () => ({ supported: false, reason: "unsupported-host" }),
        prepare: async () => ({ kind: "blocked" as const, reason: "unavailable" as const }),
        start: async () => ({ kind: "blocked" as const, reason: "unavailable" as const }),
        stop: async () => "unconfirmed" as const,
        cancelPrepare: async () => "not-found" as const
      });
      const result = await handler({ operation: "prepare", prepareId: "p-1", bookId: "book_123456", profileId: "reader-alpha",
        chapters: [{ chapterId: "ch_123456", ranges: [{ start: 0, end: 1 }] }], prompt: "Synthetic." });
      expect(result.ok).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
