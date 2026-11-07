import type { BrowserWindow } from "electron";
import { app } from "electron";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renderPdfInHiddenWindow } from "./pdf";
import type { Studio } from "./studio";

/**
 * The hidden smoke run.
 *
 * `scripts/smoke.mjs` starts the built app with a throwaway profile and library, a window parked
 * off-screen, and `STUDIO_SMOKE=1`. This module drives the real renderer through that window,
 * checks the parts that unit tests cannot see (the preload bridge, the views, autosave to disk),
 * prints one line per check, and exits with a status code.
 *
 * It is a development aid, not a test suite: `pnpm test` covers the library in process.
 */

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  /** Not run on this platform: counted as neither passed nor failed. */
  skipped?: true;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Redact a failure line before it is written to an artifact file.
 *
 * Smoke prose is synthetic, but renderer errors can echo storage paths or tokens, so the same
 * value-shaped patterns the shared `failure-artifacts.mjs` helper guards are masked here too.
 * This stays a duplicate on purpose: the smoke bundle cannot import the script helper.
 */
const REDACT_PATTERNS: RegExp[] = [
  /\bsk-or-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /([?&](?:api[_-]?key|key|access_token|code|refresh_token)=)[^&\s"']+/gi,
  /("(?:apiKey|api_key|access_token|refresh_token|secret|password)"\s*:\s*")[^"]+/gi,
  /\b[A-Fa-f0-9]{64,}\b/g
];
const REDACT_REPLACEMENTS: string[] = [
  "sk-or-[redacted]",
  "sk-ant-[redacted]",
  "sk-[redacted]",
  "AIza[redacted]",
  "Bearer [redacted]",
  "Basic [redacted]",
  "$1[redacted]",
  "$1[redacted]",
  "[redacted-token]"
];

function redactLine(line: string): string {
  let result = String(line ?? "");
  for (let index = 0; index < REDACT_PATTERNS.length; index += 1) {
    try {
      const pattern = REDACT_PATTERNS[index];
      const replacement = REDACT_REPLACEMENTS[index];
      if (pattern === undefined || replacement === undefined) break;
      pattern.lastIndex = 0;
      result = result.replace(pattern, replacement);
    } catch {
      return "[redacted]";
    }
  }
  return result;
}

function windowState(win: BrowserWindow): string {
  const contents = win.webContents;
  return `destroyed=${win.isDestroyed()} contentsDestroyed=${contents.isDestroyed()} crashed=${contents.isCrashed()} url=${contents.getURL()}`;
}

/**
 * An evaluate that never hangs silently: if the renderer stops answering, the check fails with
 * the window state instead of burning the whole run's timeout. Packaged-only wedges (a dead
 * renderer, a destroyed window) surface here with something to act on.
 */
async function evaluate<T>(win: BrowserWindow, script: string, timeout = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return (await Promise.race([
      win.webContents.executeJavaScript(script, true),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the renderer did not answer within ${timeout}ms (${windowState(win)})`)),
          timeout
        );
      })
    ])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => Promise<boolean>, description: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function inPage(expression: string): string {
  return `(() => { try { return Boolean(${expression}); } catch { return false; } })()`;
}

/**
 * Read a zip's entries without a dependency.
 *
 * The central directory is scanned for each file's name and local header, then the entry is
 * inflated. A DOCX is a zip, so this is how the check reads the document a reader would open
 * rather than what the writer thought it wrote.
 */
function unzip(bytes: Buffer, inflateRaw: (input: Uint8Array) => Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("the zip has no central directory");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressed);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRaw(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function runSmoke(win: BrowserWindow, studio: Studio): Promise<void> {
  const checks: Check[] = [];
  const check = async (name: string, run: () => Promise<string | void>): Promise<void> => {
    try {
      const detail = await run();
      checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
      console.log(`[smoke] ok    ${name}${detail ? ` — ${detail}` : ""}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      checks.push({ name, ok: false, detail });
      console.error(`[smoke] FAIL  ${name} — ${detail}`);
    }
  };

  // The manuscript import is a macOS-only journey (spec 029): the library only offers it there, so off macOS
  // these checks are reported as skipped instead of failing on a button that is deliberately absent.
  const importAvailable = process.platform === "darwin";
  const checkImport = async (name: string, run: () => Promise<string | void>): Promise<void> => {
    if (importAvailable) return check(name, run);
    const detail = `manuscript import is offered on macOS only (this is ${process.platform})`;
    checks.push({ name, ok: true, skipped: true, detail });
    console.log(`[smoke] skip  ${name} — ${detail}`);
  };

  const rendererErrors: string[] = [];

  try {
    win.webContents.on("console-message", (_event, _level, message) => {
      rendererErrors.push(redactLine(message));
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error(`[smoke] render process gone: ${details.reason}`);
    });
    win.webContents.on("unresponsive", () => {
      console.error("[smoke] renderer unresponsive");
    });
    win.webContents.on("responsive", () => {
      console.error("[smoke] renderer responsive again");
    });
    win.on("closed", () => {
      console.error("[smoke] window closed mid-run");
    });
    await check("the test window stayed hidden", async () => {
      if (win.isVisible()) throw new Error("the window is visible");
      return "never shown, parked off-screen";
    });

    await check("the preload bridge is exposed", async () => {
      const shape = await evaluate<string>(
        win,
        `(() => {
          const api = window.studio;
          if (!api) return "missing";
          const missing = ["library", "books", "chapters", "conflicts", "drafts", "menu", "providers", "connections", "usage", "agent"].filter((key) => !(key in api));
          if (missing.length) return \`missing: \${missing.join(", ")}\`;
          const missingAgent = ["start", "stop", "undoLast", "approve", "threads"].filter((key) => !(key in api.agent));
          return missingAgent.length ? \`missing agent: \${missingAgent.join(", ")}\` : "library, books, chapters, conflicts, drafts, menu, providers, connections, usage, agent";
        })()`
      );
      if (shape !== "library, books, chapters, conflicts, drafts, menu, providers, connections, usage, agent") throw new Error(shape);
      return shape;
    });

    await check("the library lists the fixture book", async () => {
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="library-view"]')`)),
        "the library view"
      );
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="book-card"]')`)),
        "the book card"
      );
      const title = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="book-card"]')?.innerText ?? ""`
      );
      if (!title.includes("Smoke Test Book")) throw new Error(`card read: ${JSON.stringify(title)}`);
      return "Smoke Test Book";
    });

    await check("the library shows the location health line", async () => {
      const line = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="location-health"]')?.innerText ?? ""`
      );
      if (!line.includes("Ready")) throw new Error(`health line read: ${JSON.stringify(line)}`);
      return line;
    });

    // The grid's read through the real bridge. Only a refusal is asked of the reveal, because a
    // folder it accepted would open a Finder window.
    await check("the grid's read lists the fixture book, and an escaping folder is not shown", async () => {
      const outcome = await evaluate<string>(
        win,
        `(async () => {
          const listing = await window.studio.books.listWithIssues();
          if (!listing.ok) return "the listing failed: " + listing.error.code;
          const titles = listing.data.books.map((book) => book.title).join(", ");
          if (titles !== "Smoke Test Book" || listing.data.bookReadIssues.length !== 0) return JSON.stringify(listing.data);
          const reveal = await window.studio.books.reveal("../outside");
          if (reveal.ok) return "an escaping folder name was shown";
          return "1 book · 0 that cannot open · " + reveal.error.code;
        })()`
      );
      if (outcome !== "1 book · 0 that cannot open · invalid") throw new Error(outcome);
      return outcome;
    });

    // Refusals only: the allowed page would open a real browser and a real connection would reach a
    // provider, so a hidden run never asks for either.
    await check("the bridge refuses an unlisted page and a model id for a missing connection", async () => {
      const outcome = await evaluate<string>(
        win,
        `(async () => {
          const link = await window.studio.app.openLink("https://example.com/");
          if (link.ok) return "an unlisted page was opened";
          const model = await window.studio.providers.addModel("conn_smokemissing1", "vendor/model");
          if (model.ok) return "a model id was kept for a connection that does not exist";
          return link.error.code + " · " + model.error.code;
        })()`
      );
      if (outcome !== "invalid · auth") throw new Error(outcome);
      return "an unlisted page and a missing connection are both refused";
    });

    // Kept words live in this run's throwaway profile, so a fresh one has none; an id that is not a
    // kept copy's is refused before the store builds a path from it.
    await check("the bridge lists no kept words and refuses a malformed recovery id", async () => {
      const outcome = await evaluate<string>(
        win,
        `(async () => {
          const books = await window.studio.books.list();
          if (!books.ok || !books.data[0]) return "no book to ask about";
          const listed = await window.studio.recovery.list(books.data[0].id);
          if (!listed.ok) return "the list failed: " + listed.error.message;
          if (listed.data.length !== 0) return listed.data.length + " kept copies in a fresh profile";
          const restored = await window.studio.recovery.restore("../studio");
          return restored.ok ? "a malformed id was restored" : restored.error.code;
        })()`
      );
      if (outcome !== "invalid") throw new Error(outcome);
      return "none kept, and a malformed id is refused";
    });

    await check("opening a book shows the manuscript", async () => {
      await evaluate<boolean>(
        win,
        `(() => {
          const card = document.querySelector('[data-testid="book-card"]');
          if (!card) return false;
          card.click();
          return true;
        })()`
      );
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="manuscript-editor"]')`)),
        "the manuscript editor"
      );
      const rail = await evaluate<string>(win, `document.querySelector('[data-testid="chapter-rail"]')?.innerText ?? ""`);
      if (!rail.includes("The Light")) throw new Error(`rail read: ${JSON.stringify(rail)}`);
      const prose = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="manuscript-text"]')?.value ?? ""`
      );
      if (!prose.includes("lighthouse keeper")) throw new Error(`editor read: ${JSON.stringify(prose.slice(0, 80))}`);
      return "chapter rail and prose loaded";
    });

    await check("the model picker opens without a connection", async () => {
      const clicked = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="open-model-picker"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!clicked) throw new Error("the model picker button was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`(document.body.innerText || "").includes("No provider is connected yet")`)),
        "the empty model picker"
      );
      // An author with no key must be able to reach the place where a key is added.
      const settingsOpener = await evaluate<boolean>(
        win,
        inPage(`document.querySelector('[data-testid="open-provider-settings"]')`)
      );
      if (!settingsOpener) throw new Error("the empty model picker offered no way to open Settings");
      // A model id belongs to a connection, so the hand-entry path waits until one exists.
      const manualOffered = await evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="enter-model-id"]')`));
      if (manualOffered) throw new Error("the empty model picker offered a model id without a connection");
      const closed = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Cancel");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closed) throw new Error("the model picker had no Cancel button");
      return "explained that a connection comes first, with a way to add one";
    });

    await check("the writing agent panel opens", async () => {
      const clicked = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="toggle-chat"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!clicked) throw new Error("the chat toggle was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="chat-panel"]')`)),
        "the writing agent panel"
      );
      const copy = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="chat-panel"]')?.innerText ?? ""`
      );
      if (!copy.includes("Ask for a scene")) throw new Error(`panel read: ${JSON.stringify(copy.slice(0, 120))}`);
      const turnModel = await evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="agent-turn-model"]')`));
      if (!turnModel) throw new Error("the one-off model control was not found");
      const openedTurnPicker = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="agent-turn-model"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!openedTurnPicker) throw new Error("the one-off model picker did not open");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`(document.body.innerText || "").includes("Model for this turn")`)),
        "the one-off model picker"
      );
      const closedTurnPicker = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Cancel");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closedTurnPicker) throw new Error("the one-off model picker had no Cancel button");
      const closed = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[aria-label="Close the writing agent"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closed) throw new Error("the agent panel had no close button");
      return "empty state explained the agent";
    });

    await check("the Story Bible opens", async () => {
      const clicked = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="open-story-bible"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!clicked) throw new Error("the Story Bible button was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`(document.body.innerText || "").includes("Story Bible")`)),
        "the Story Bible dialog"
      );
      const closed = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Cancel");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closed) throw new Error("the Story Bible had no Cancel button");
      return "book fields, cast and memories in one place";
    });

    await check("an unsaved edit offers save or keep writing", async () => {
      const marker = `A hidden review check typed this ${Date.now()}.`;
      const opened = await evaluate<boolean>(
        win,
        `(() => {
          const el = document.querySelector('[data-testid="manuscript-text"]');
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
          setter.call(el, el.value + "\\n\\n" + ${JSON.stringify(marker)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          const review = document.querySelector('[data-testid="review-manuscript"]');
          if (!review) return false;
          review.click();
          return true;
        })()`
      );
      if (!opened) throw new Error("the editor or the Review manuscript button was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="review-dialog"]')`)),
        "the save choice"
      );
      const copy = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="review-dialog"]')?.innerText ?? ""`
      );
      if (!copy.includes("Save and continue") || !copy.includes("Keep writing")) {
        throw new Error(`choice read: ${JSON.stringify(copy.slice(0, 120))}`);
      }
      const kept = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll('[data-testid="review-dialog"] button')].find((item) => item.textContent?.trim() === "Keep writing");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!kept) throw new Error("the save choice had no Keep writing button");
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(
              `!document.querySelector('[data-testid="review-dialog"]') && !document.querySelector('[data-testid="review-report"]')`
            )
          ),
        "the choice to close"
      );
      const prose = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="manuscript-text"]')?.value ?? ""`
      );
      if (!prose.includes(marker)) throw new Error("Keep writing did not leave the typed text untouched");
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`(document.querySelector('[data-testid="save-status"]')?.textContent ?? "").includes("Saved")`)
          ),
        "the autosave to settle"
      );
      return "Keep writing left the typed text untouched";
    });

    await check("the manuscript review reports on saved text", async () => {
      const clicked = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="review-manuscript"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!clicked) throw new Error("the Review manuscript button was not found");
      // The dialog shell renders while the run is still reading, so wait for the report body
      // itself: the word-count definition and coverage only render with a finished report.
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(
              `(document.querySelector('[data-testid="review-report"]')?.innerText ?? "").includes("Studio word count")`
            )
          ),
        "the manuscript review report"
      );
      const copy = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="review-report"]')?.innerText ?? ""`
      );
      if (!copy.includes("Studio word count") || !copy.includes("Coverage")) {
        throw new Error(`report read: ${JSON.stringify(copy.slice(0, 160))}`);
      }
      const closed = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll('[data-testid="review-report"] button')].find((item) => item.textContent?.trim() === "Close");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closed) throw new Error("the manuscript review report had no Close button");
      return "run scope, studio counts, coverage and definitions over the fixture book";
    });

    await check("a changed chapter marks the review stale", async () => {
      const marker = `A hidden review check changed this ${Date.now()}.`;
      const typed = await evaluate<boolean>(
        win,
        `(() => {
          const el = document.querySelector('[data-testid="manuscript-text"]');
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
          setter.call(el, el.value + "\\n\\n" + ${JSON.stringify(marker)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`
      );
      if (!typed) throw new Error("the editor was not found");
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`(document.querySelector('[data-testid="save-status"]')?.textContent ?? "").includes("Saved")`)
          ),
        "the edited chapter to save"
      );
      const clicked = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="review-manuscript"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!clicked) throw new Error("the Review manuscript button was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="review-stale"]')`)),
        "the stale report"
      );
      const stale = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="review-report"]')?.innerText ?? ""`
      );
      if (!stale.includes("This report is stale") || !stale.includes("The Light")) {
        throw new Error(`stale read: ${JSON.stringify(stale.slice(0, 160))}`);
      }
      const again = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll('[data-testid="review-report"] button')].find((item) => item.textContent?.trim() === "Run again");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!again) throw new Error("the stale report offered no new run");
      // Wait for a new report generation: the run meta carries the fresh completion time,
      // so it can only match once the new run replaces the stale one. The dialog shell also
      // renders while the new run is reading, so the shell alone proves nothing.
      const staleMeta = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="review-run-meta"]')?.textContent ?? ""`
      );
      try {
        await waitUntil(
          () =>
            evaluate<boolean>(
              win,
              inPage(
                `(() => { const meta = document.querySelector('[data-testid="review-run-meta"]')?.textContent ?? ""; return meta !== "" && meta !== ${JSON.stringify(staleMeta)}; })()`
              )
            ),
          "the fresh report"
        );
      } catch {
        const state = await evaluate<string>(
          win,
          `document.querySelector('[data-testid="review-report"]')?.innerText.slice(0, 300) ?? "no report element"`
        );
        throw new Error(`the fresh report never replaced the stale one; dialog showed: ${state}`);
      }
      const closed = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll('[data-testid="review-report"] button')].find((item) => item.textContent?.trim() === "Close");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closed) throw new Error("the fresh report had no Close button");
      return "stale report named The Light, then a new run replaced it";
    });

    await check("Settings opens from the workspace", async () => {
      const clicked = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="open-settings"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!clicked) throw new Error("the Settings button was not found in the workspace header");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="theme-dark"]')`)),
        "the Settings dialog"
      );
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`(document.querySelector('[data-testid="about"]')?.textContent ?? "").includes("0.1.0")`)
          ),
        "the build metadata in About"
      );
      const copy = await evaluate<string>(win, `document.querySelector('[role="dialog"]')?.innerText ?? ""`);
      if (
        !copy.includes("Appearance") ||
        !copy.includes("Provider connections") ||
        !copy.includes("Library") ||
        !copy.includes("About")
      ) {
        throw new Error(`settings read: ${JSON.stringify(copy.slice(0, 160))}`);
      }
      const closed = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent?.trim() === "Done");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closed) throw new Error("the Settings dialog had no Done button");
      return "appearance, providers, library and build information in one place";
    });

    await check("Settings → About lists the open-source licenses this build ships", async () => {
      const opened = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="open-settings"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!opened) throw new Error("the Settings button was not found in the workspace header");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="show-licenses"]')`)),
        "the licenses button in About"
      );
      await evaluate<boolean>(win, inPage(`(document.querySelector('[data-testid="show-licenses"]').click(), true)`));
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelectorAll('[data-testid="licenses-option"]').length > 50`)),
        "more than 50 packages in the licenses view",
        15_000
      );
      const listed = await evaluate<{ names: string[]; first: string; studio: boolean }>(
        win,
        `(() => {
          const options = [...document.querySelectorAll('[data-testid="licenses-option"]')];
          return {
            names: options.map((option) => option.getAttribute("data-package")).filter(Boolean),
            first: options[0]?.textContent ?? "",
            studio: (document.querySelector('[data-testid="licenses-text"]')?.textContent ?? "").includes("Apache License")
          };
        })()`
      );
      if (listed.names.length <= 50) throw new Error(`the view listed ${listed.names.length} packages`);
      const absent = ["react", "docx", "electron"].filter((name) => !listed.names.includes(name));
      if (absent.length) throw new Error(`the view does not list ${absent.join(", ")}`);
      if (!listed.first.includes("Open Book Studio") || !listed.studio) {
        throw new Error("the studio's own license did not come first");
      }
      // docx ships as a dependency the main process loads, outside the renderer bundle.
      await evaluate<boolean>(
        win,
        inPage(`(document.querySelector('[data-testid="licenses-option"][data-package="docx"]').click(), true)`)
      );
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`(document.querySelector('[data-testid="licenses-text"]')?.textContent ?? "").includes("Permission is hereby granted")`)
          ),
        "the docx license text"
      );
      const closedView = await evaluate<boolean>(
        win,
        `(() => {
          const dialog = document.querySelector('[data-testid="licenses-dialog"]');
          const done = dialog && [...dialog.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Done");
          if (!done) return false;
          done.click();
          return true;
        })()`
      );
      if (!closedView) throw new Error("the licenses view had no Done button");
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(
              `!document.querySelector('[data-testid="licenses-dialog"]') && document.activeElement?.getAttribute("data-testid") === "show-licenses"`
            )
          ),
        "the licenses view to close and return focus to its button"
      );
      const closedSettings = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent?.trim() === "Done");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closedSettings) throw new Error("the Settings dialog had no Done button");
      await waitUntil(() => evaluate<boolean>(win, inPage(`!document.querySelector('[role="dialog"]')`)), "Settings to close");
      return `${listed.names.length} packages with react, docx and electron; docx shows its MIT text; focus returned to the button`;
    });

    // A check that opens the agent panel must not leave it open when it fails: the next check toggles it.
    const closeAgentPanelOnFailure = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        await evaluate<boolean>(
          win,
          `(() => { const button = document.querySelector('[aria-label="Close the writing agent"]'); if (button) button.click(); return true; })()`
        ).catch(() => false);
        throw error;
      }
    };
    await check("a failed turn keeps its request for retry", () => closeAgentPanelOnFailure(async () => {
      const opened = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="toggle-chat"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!opened) throw new Error("the chat toggle was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="chat-panel"]')`)),
        "the writing agent panel"
      );

      const marker = `Retry this request ${Date.now()}.`;
      const typed = await evaluate<boolean>(
        win,
        `(() => {
          const box = document.querySelector('[data-testid="chat-input"]');
          if (!box) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
          setter.call(box, ${JSON.stringify(marker)});
          box.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`
      );
      if (!typed) throw new Error("the chat input was not found");
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            `(() => { const button = document.querySelector('[data-testid="chat-send"]'); return Boolean(button && !button.disabled); })()`
          ),
        "the send button to enable"
      );
      const sent = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="chat-send"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!sent) throw new Error("the send button was not found");

      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="agent-retry-request"]')`)),
        "the retry action after a failed turn"
      );
      const copy = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="chat-panel"]')?.textContent ?? ""`
      );
      if (!copy.includes(marker)) {
        throw new Error(`the failed request was not preserved: ${JSON.stringify(copy.slice(0, 160))}`);
      }

      const retried = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="agent-retry-request"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!retried) throw new Error("the retry action was not clickable");
      await delay(2000);
      const after = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="chat-panel"]')?.textContent ?? ""`
      );
      if (!after.includes(marker)) throw new Error("retry dropped the original request");
      if (!after.includes("Retry request")) throw new Error("retry was not offered again after the second failure");

      const closed = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[aria-label="Close the writing agent"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closed) throw new Error("the agent panel had no close button");
      return "prompt preserved; retry stays available";
    }));

    await check("the chat can start a new conversation and show history", async () => {
      const opened = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="toggle-chat"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!opened) throw new Error("the chat toggle was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="chat-panel"]')`)),
        "the writing agent panel"
      );

      const started = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="agent-new-thread"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!started) throw new Error("the new-conversation button was not found");

      const history = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="agent-history"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!history) throw new Error("the conversation history button was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[role="dialog"]')`)),
        "the conversation history dialog"
      );
      const copy = await evaluate<string>(win, `document.querySelector('[role="dialog"]')?.innerText ?? ""`);
      if (!copy.includes("Conversations") || !copy.includes("No earlier conversations yet")) {
        throw new Error(`the history dialog did not explain the empty state: ${JSON.stringify(copy.slice(0, 160))}`);
      }

      await evaluate<boolean>(
        win,
        `(() => {
          const close = document.querySelector('[role="dialog"] button[aria-label="Close"]');
          if (!close) return false;
          close.click();
          return true;
        })()`
      );
      const closed = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[aria-label="Close the writing agent"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closed) throw new Error("the agent panel had no close button");
      return "new conversation and history dialog";
    });

    await check("typing is saved to disk", async () => {
      const target = await evaluate<{ bookId: string; chapterId: string } | null>(
        win,
        `(async () => {
          const books = await window.studio.books.list();
          if (!books.ok || !books.data[0]) return null;
          const opened = await window.studio.books.open(books.data[0].id);
          if (!opened.ok) return null;
          const chapter = opened.data.chapters[0];
          return chapter ? { bookId: books.data[0].id, chapterId: chapter.id } : null;
        })()`
      );
      const library = studio.library;
      if (!target || !library) throw new Error("no chapter is available to type into");

      const { bookId, chapterId } = target;
      const before = await library.readChapter(bookId, chapterId);
      const marker = `A hidden run wrote this line ${Date.now()}.`;
      const typed = await evaluate<boolean>(
        win,
        `(() => {
          const el = document.querySelector('[data-testid="manuscript-text"]');
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
          setter.call(el, el.value + "\\n\\n" + ${JSON.stringify(marker)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`
      );
      if (!typed) throw new Error("the editor was not found");

      await waitUntil(async () => {
        const chapter = await library.readChapter(bookId, chapterId);
        return chapter.content.includes(marker);
      }, "the autosave to reach the disk");

      const after = await library.readChapter(bookId, chapterId);
      if (after.version <= before.version) throw new Error(`version did not move (${before.version} → ${after.version})`);

      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`(document.querySelector('[data-testid="save-status"]')?.textContent ?? "").includes("Saved")`)
          ),
        "the save status to settle"
      );
      return `version ${before.version} → ${after.version}, status Saved`;
    });

    await check("undo survives a chapter switch", async () => {
      const rows = await evaluate<string[]>(
        win,
        `[...document.querySelectorAll('[data-testid="chapter-row"]')].map((row) => row.getAttribute('data-chapter-id') ?? '')`
      );
      if (rows.length < 2) throw new Error(`only ${rows.length} chapter row(s)`);

      await evaluate<boolean>(
        win,
        `(() => {
          document.querySelectorAll('[data-testid="chapter-row"]')[1]?.click();
          return true;
        })()`
      );
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`(document.querySelector('[data-testid="manuscript-text"]')?.value ?? "").includes("colder corridor")`)
          ),
        "the second chapter"
      );

      await evaluate<boolean>(
        win,
        `(() => {
          document.querySelectorAll('[data-testid="chapter-row"]')[0]?.click();
          return true;
        })()`
      );
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`(document.querySelector('[data-testid="manuscript-text"]')?.value ?? "").includes("lighthouse keeper")`)
          ),
        "the first chapter"
      );
      const before = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="manuscript-text"]')?.value ?? ""`
      );
      if (!before.includes("A hidden run wrote this line")) throw new Error("the typed marker is missing");

      const undone = await evaluate<boolean>(
        win,
        `(() => {
          const textarea = document.querySelector('[data-testid="manuscript-text"]');
          if (!textarea) return false;
          textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
          return true;
        })()`
      );
      if (!undone) throw new Error("the manuscript textarea was not found");
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`!(document.querySelector('[data-testid="manuscript-text"]')?.value ?? "").includes("A hidden run wrote this line")`)
          ),
        "the undo to remove the typed marker"
      );
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`(document.querySelector('[data-testid="save-status"]')?.textContent ?? "").includes("Saved")`)
          ),
        "the undo to save"
      );
      return "the typed marker was undone after returning to the chapter";
    });

    await check("words typed just before a quit reach the file", async () => {
      const library = studio.requireLibrary();
      const book = (await library.listBooks())[0];
      if (!book) throw new Error("the smoke book disappeared");
      const chapter = (await library.readBook(book.id)).chapters[0];
      if (!chapter) throw new Error("the smoke chapter disappeared");
      const before = await library.readChapter(book.id, chapter.id);
      const sentence = `The keeper wrote it down at ${Date.now()}.`;

      // A key every 60 ms at the end of the chapter: neither the 300 ms draft copy nor the 700 ms
      // autosave has run when the close and quit handlers' flush asks the window for its text.
      const lastKeyAt = await evaluate<number>(
        win,
        `(async () => {
          const el = document.querySelector('[data-testid="manuscript-text"]');
          if (!el) return 0;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
          const keys = [..."\\n" + ${JSON.stringify(sentence)}];
          for (let index = 0; index < keys.length; index += 1) {
            if (index > 0) await new Promise((resolve) => setTimeout(resolve, 60));
            setter.call(el, el.value + keys[index]);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return Date.now();
        })()`
      );
      if (!lastKeyAt) throw new Error("the editor was not found");
      const sinceLastKey = Date.now() - lastKeyAt;
      await studio.flushDrafts(win.webContents);
      // Past 250 ms the draft copy could have carried the words, and the check would prove nothing.
      if (sinceLastKey >= 250) throw new Error(`the flush began ${sinceLastKey} ms after the last key`);

      const after = await library.readChapter(book.id, chapter.id);
      if (!after.content.includes(sentence)) throw new Error("the sentence typed before the quit is not in the file");
      if (after.version <= before.version) throw new Error(`version did not move (${before.version} → ${after.version})`);
      if ((await library.listConflicts(book.id)).length > 0) throw new Error("the flush left a conflict copy");
      return `flushed ${sinceLastKey} ms after the last key, version ${before.version} → ${after.version}`;
    });

    // The audit's read-only book folder, on the built app (D-189). Nothing in the folder can be written,
    // so the quit's flush keeps the newest words in this run's profile, never in the library; the book
    // then offers them back, and restoring them is an ordinary checked save.
    await check("words a quit could not save are kept, and the book offers them back", async () => {
      const library = studio.requireLibrary();
      const book = (await library.listBooks())[0];
      if (!book) throw new Error("the smoke book disappeared");
      const first = (await library.readBook(book.id)).chapters[0];
      if (!first) throw new Error("the smoke chapter disappeared");
      const before = await library.readChapter(book.id, first.id);
      const folder = join(library.root, "books", book.id, "chapters");
      const file = join(folder, before.path);
      const bytes = await readFile(file);
      const sentence = `The lamp stayed lit at ${Date.now()}.`;

      let unsaved: Awaited<ReturnType<Studio["flushDrafts"]>> = [];
      let reason = "";
      await chmod(folder, 0o555);
      try {
        const typed = await evaluate<boolean>(
          win,
          `(() => {
            const el = document.querySelector('[data-testid="manuscript-text"]');
            if (!el) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
            setter.call(el, el.value + ${JSON.stringify(`\n${sentence}`)});
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          })()`
        );
        if (!typed) throw new Error("the editor was not found");
        // A quit straight after the last key: the editor's own save fails, so it hands its newest text
        // to the main process, which keeps what the library refuses.
        unsaved = await studio.flushDrafts(win.webContents);
        await waitUntil(
          () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="save-problem"]')`)),
          "the save status to give the reason"
        );
        reason = await evaluate<string>(win, `document.querySelector('[data-testid="save-problem"]')?.textContent ?? ""`);
        // The author's "Quit and keep the words", then the book is closed while the folder still refuses.
        studio.letGo(unsaved);
        await evaluate(win, `document.querySelector('[aria-label="Back to library"]')?.click()`);
        await waitUntil(
          () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="book-card"]')`)),
          "the library after closing the book"
        );
      } finally {
        await chmod(folder, 0o755);
      }

      const keptId = unsaved.length === 1 ? unsaved[0]?.keptId : null;
      if (!keptId) throw new Error(`expected one kept draft, got ${JSON.stringify(unsaved.map((entry) => entry.keptId))}`);
      if (!(await studio.recovery.read(keptId))?.content.includes(sentence)) throw new Error("the kept copy lacks the newest words");
      if (!(await readFile(file)).equals(bytes)) throw new Error("the chapter file changed while its folder refused writes");
      if (!reason.includes("cannot be written")) throw new Error(`the save status read ${JSON.stringify(reason)}`);

      await evaluate(win, `document.querySelector('[data-testid="book-card"]')?.click()`);
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`document.querySelector('[data-testid="recovery-offer"]') && document.querySelector('[data-testid="manuscript-text"]')`)
          ),
        "the offer of the kept words"
      );
      const shown = await evaluate<string>(win, `document.querySelector('[data-testid="manuscript-text"]')?.value ?? ""`);
      if (shown.includes(sentence)) throw new Error("the kept words reached the editor before the author restored them");
      await evaluate(win, `document.querySelector('[data-testid="recovery-restore"]')?.click()`);
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(
              `!document.querySelector('[data-testid="recovery-offer"]') && (document.querySelector('[data-testid="manuscript-text"]')?.value ?? "").includes(${JSON.stringify(sentence)})`
            )
          ),
        "the restored words in the editor"
      );

      const after = await library.readChapter(book.id, first.id);
      if (!after.content.includes(sentence)) throw new Error("the restored words are not in the file");
      if (after.version !== before.version + 1) throw new Error(`version ${before.version} → ${after.version}`);
      if ((await library.listConflicts(book.id)).length > 0) throw new Error("the restore left a conflict copy");
      if ((await studio.recovery.all()).length > 0) throw new Error("the kept copy outlived its restore");
      return `kept in the profile (${reason.replace(/^·\s*/, "")}), offered on reopening, restored as version ${after.version}`;
    });

    await check("the studio's own writes stay quiet, and an outside edit right after a save is announced", async () => {
      const library = studio.requireLibrary();
      const book = (await library.listBooks())[0];
      if (!book) throw new Error("the smoke book disappeared");
      const chapter = (await library.readBook(book.id)).chapters[0];
      if (!chapter) throw new Error("the smoke chapter disappeared");
      const path = join(library.root, "books", book.id, "chapters", chapter.path);
      const banner = (): Promise<boolean> =>
        evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="external-change"]')`));
      const typeLine = async (line: string): Promise<void> => {
        const typed = await evaluate<boolean>(
          win,
          `(() => {
            const el = document.querySelector('[data-testid="manuscript-text"]');
            if (!el) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
            setter.call(el, el.value + ${JSON.stringify(line)});
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          })()`
        );
        if (!typed) throw new Error("the editor was not found");
        await waitUntil(
          async () => (await library.readChapter(book.id, chapter.id)).content.includes(line.trim()),
          "the autosave to reach the disk"
        );
      };

      // The studio's own writes: a Story Bible change through the bridge, sent the way the dialog sends
      // it (each field with the value it started from), then a typed line it autosaves.
      const updated = await evaluate<string>(
        win,
        `(async () => {
          const id = ${JSON.stringify(book.id)};
          const opened = await window.studio.books.open(id);
          if (!opened.ok) return opened.error.message;
          const genres = opened.data.book.genres;
          const first = await window.studio.books.edit(id, { genres: { from: genres, to: ["Smoke"] } });
          if (!first.ok) return first.error.message;
          if (first.data.status !== "saved" || first.data.book.genres[0] !== "Smoke") return "the first edit did not save";
          const second = await window.studio.books.edit(id, { genres: { from: ["Smoke"], to: genres } });
          if (!second.ok) return second.error.message;
          return second.data.status === "saved" ? "ok" : "the second edit did not save";
        })()`
      );
      if (updated !== "ok") throw new Error(`the Story Bible change failed: ${updated}`);
      await typeLine("\nThe gulls settled on the rail.\n");
      await delay(1500);
      if (await banner()) throw new Error("the studio's own Story Bible change and save were announced as outside changes");

      // Another editor writes 0.3 s after the next local save, well inside the old 2 s grace period.
      await typeLine("The light turned twice.\n");
      await delay(300);
      const raw = await readFile(path, "utf8");
      await writeFile(path, `${raw}\n\nAn external editor added this line.\n`, "utf8");

      await waitUntil(banner, "the external-change banner");
      const refreshed = await evaluate<boolean>(
        win,
        `(() => {
          const banner = document.querySelector('[data-testid="external-change"]');
          const button = [...(banner?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.trim() === "Refresh");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!refreshed) throw new Error("the external-change banner had no Refresh button");
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`(document.querySelector('[data-testid="manuscript-text"]')?.value ?? "").includes("external editor")`)
          ),
        "the refreshed manuscript"
      );
      return "own writes quiet for 1.5 s; banner 0.3 s after a save, refresh and the external line";
    });

    await check("a chapter can move with the keyboard", async () => {
      const before = await evaluate<string[]>(
        win,
        `[...document.querySelectorAll('[data-testid="chapter-row"]')].map((row) => row.getAttribute('data-chapter-id') ?? '')`
      );
      if (before.length < 2) throw new Error(`only ${before.length} chapter row(s)`);
      const dispatched = await evaluate<boolean>(
        win,
        `(() => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", metaKey: true, altKey: true, bubbles: true }));
          return true;
        })()`
      );
      if (!dispatched) throw new Error("the keyboard shortcut could not be dispatched");
      await waitUntil(async () => {
        const after = await evaluate<string[]>(
          win,
          `[...document.querySelectorAll('[data-testid="chapter-row"]')].map((row) => row.getAttribute('data-chapter-id') ?? '')`
        );
        return after[0] === before[1] && after[1] === before[0];
      }, "the chapter order to change");

      const library = studio.requireLibrary();
      const book = (await library.listBooks())[0];
      if (!book) throw new Error("the smoke book disappeared");
      const detail = await library.readBook(book.id);
      if (detail.chapters[0]?.id !== before[1]) throw new Error("the file order did not follow the shortcut");

      // The move rewrote the open chapter's file; the next words still save normally (QA D5).
      const copies = (await library.listConflicts(book.id)).length;
      const sentence = `The keeper read on after the move at ${Date.now()}.`;
      const openId = await evaluate<string>(
        win,
        `(() => {
          const el = document.querySelector('[data-testid="manuscript-text"]');
          const row = document.querySelector('[data-testid="chapter-row"][aria-current="page"]');
          if (!el || !row) return "";
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
          setter.call(el, el.value + "\\n" + ${JSON.stringify(sentence)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return row.getAttribute("data-chapter-id") ?? "";
        })()`
      );
      if (openId !== before[0]) throw new Error("the moved chapter is not the open one");
      await waitUntil(
        async () => (await library.readChapter(book.id, openId)).content.includes(sentence),
        "the words typed after the move to save"
      );
      if ((await library.listConflicts(book.id)).length !== copies) throw new Error("the save after the move left a conflict copy");
      return "⌘⌥↓ moved The Light below The Door, and the next words saved with no conflict copy";
    });

    await check("a chapter can be dragged to a new position", async () => {
      const before = await evaluate<string[]>(
        win,
        `[...document.querySelectorAll('[data-testid="chapter-row"]')].map((row) => row.getAttribute('data-chapter-id') ?? '')`
      );
      if (before.length < 2) throw new Error(`only ${before.length} chapter row(s)`);
      const dropped = await evaluate<boolean>(
        win,
        `(async () => {
          const items = document.querySelectorAll('[data-testid="chapter-item"]');
          const source = items[1];
          const target = items[0];
          if (!source || !target) return false;
          const data = new DataTransfer();
          source.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data, bubbles: true, cancelable: true }));
          await new Promise((resolve) => setTimeout(resolve, 30));
          target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
          target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
          return true;
        })()`
      );
      if (!dropped) throw new Error("the chapter items were not found");
      await waitUntil(async () => {
        const after = await evaluate<string[]>(
          win,
          `[...document.querySelectorAll('[data-testid="chapter-row"]')].map((row) => row.getAttribute('data-chapter-id') ?? '')`
        );
        return after[0] === before[1] && after[1] === before[0];
      }, "the dragged chapter order");

      const book = (await studio.requireLibrary().listBooks())[0];
      if (!book) throw new Error("the smoke book disappeared");
      const detail = await studio.requireLibrary().readBook(book.id);
      if (detail.chapters[0]?.id !== before[1]) throw new Error("the file order did not follow the drag");
      return "the second chapter was dragged to the top";
    });

    await check("the format dialog shows an approximate preview", async () => {
      const clicked = await evaluate<boolean>(
        win,
        `(() => { const button = document.querySelector('[data-testid="format-book"]'); if (!button) return false; button.click(); return true; })()`
      );
      if (!clicked) throw new Error("the format control was not on screen");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`!!document.querySelector('[data-testid="format-preview"]')`)),
        "the format preview"
      );
      const disclosure = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="format-disclosure"]')?.innerText ?? ""`
      );
      if (!disclosure.includes("Approximate preview")) {
        throw new Error(`disclosure read: ${JSON.stringify(disclosure)}`);
      }
      return "preview with disclosure";
    });

    /**
     * Chooses a target in the open Format dialog, exports it and returns the file the note names,
     * once that file is on disk. The hook sends the file to STUDIO_EXPORT_PATH instead of a save
     * dialog.
     */
    const exportFromFormat = async (target: "PDF" | "EPUB", extension: string): Promise<string> => {
      const folder = process.env.STUDIO_EXPORT_PATH;
      if (!folder) throw new Error("STUDIO_EXPORT_PATH is not set");
      const chosen = await evaluate<boolean>(
        win,
        `(() => { const radio = document.querySelector('input[name="format-target"][value="${target}"]'); if (!radio) return false; radio.click(); return true; })()`
      );
      if (!chosen) throw new Error(`the ${target} target was not on screen`);
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`document.querySelector('[data-testid="format-export"]').innerText.trim() === "Export ${target}"`)
          ),
        `the Export ${target} action`
      );
      await evaluate(win, `document.querySelector('[data-testid="format-export"]').click()`);
      // Rendering a PDF in its own hidden window takes longer than a click. The note may still
      // name an earlier export, so the file it names must be on disk as well.
      let saved = "";
      let refusal = "";
      await waitUntil(
        async () => {
          const shown = await evaluate<{ note: string; error: string }>(
            win,
            `({ note: document.querySelector('[data-testid="format-export-note"]')?.innerText.trim() ?? "", error: document.querySelector('[data-testid="format-export-error"]')?.innerText ?? "" })`
          );
          refusal = shown.error;
          if (refusal) return true;
          const name = /^Saved (.+)$/.exec(shown.note)?.[1] ?? "";
          if (!name.endsWith(`.${extension}`) || !(await readdir(folder)).includes(name)) return false;
          saved = join(folder, name);
          return true;
        },
        `the ${target} export note`,
        90_000
      );
      if (refusal) throw new Error(`the dialog said: ${JSON.stringify(refusal)}`);
      return saved;
    };

    await check("the format dialog exports a PDF, and again in the same session", async () => {
      const first = await exportFromFormat("PDF", "pdf");
      const bytes = await readFile(first);
      if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("the file is not a PDF");
      if (!bytes.subarray(-1024).toString("latin1").includes("%%EOF")) throw new Error("the PDF has no end marker");
      // The fixture's chapter illustration reaches the printed page, not only the HTML.
      if (!bytes.toString("latin1").includes("/Subtype /Image")) throw new Error("the illustration is not in the PDF");
      // Every export prints in a new hidden window. The first file moves aside, so the second
      // export asks no replace question, which a hidden run cannot answer.
      await rename(first, first.replace(/\.pdf$/, "-first.pdf"));
      const second = await exportFromFormat("PDF", "pdf");
      const again = await readFile(second);
      if (again.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("the second export is not a PDF");
      return `${second.split("/").pop()} twice · ${bytes.length} and ${again.length} bytes, with the illustration`;
    });

    await check("the format dialog exports an EPUB", async () => {
      try {
        const file = await exportFromFormat("EPUB", "epub");
        const bytes = await readFile(file);
        // The first local header must be the stored `mimetype` entry with no extra field.
        if (bytes.readUInt32LE(0) !== 0x04034b50) throw new Error("the file is not a zip");
        const first = bytes.subarray(30, 30 + bytes.readUInt16LE(26)).toString("latin1");
        if (first !== "mimetype") throw new Error(`the first entry is ${JSON.stringify(first)}`);
        if (bytes.readUInt16LE(8) !== 0 || bytes.readUInt16LE(28) !== 0) {
          throw new Error("the mimetype entry is compressed or carries an extra field");
        }
        const mimetype = bytes.subarray(38, 38 + bytes.readUInt32LE(18)).toString("latin1");
        if (mimetype !== "application/epub+zip") throw new Error(`mimetype read: ${JSON.stringify(mimetype)}`);
        const { inflateRawSync } = await import("node:zlib");
        const entries = unzip(bytes, inflateRawSync);
        const pages = [...entries.keys()].filter((name) => /^EPUB\/chapter-\d+\.xhtml$/.test(name));
        const xhtml = pages.map((name) => entries.get(name)?.toString("utf8") ?? "").join("\n");
        // The chapters' saved text, as the library reads it now, must be in the e-book.
        const book = (await studio.requireLibrary().listBooks())[0];
        if (!book) throw new Error("the smoke book disappeared");
        const detail = await studio.requireLibrary().readBook(book.id);
        const asXml = (text: string): string =>
          text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        for (const chapter of detail.chapters) {
          const line = chapter.content.split("\n").find((value) => value.trim())?.trimEnd();
          if (line && !xhtml.includes(asXml(line))) throw new Error(`“${chapter.title}” is not in the e-book`);
        }
        const images = [...entries.keys()].filter((name) => name.startsWith("EPUB/images/"));
        return `${file.split("/").pop()} · ${pages.length} chapter files, ${images.length} image${images.length === 1 ? "" : "s"}`;
      } finally {
        await evaluate<boolean>(
          win,
          `(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return true; })()`
        );
        await waitUntil(
          () => evaluate<boolean>(win, inPage(`!document.querySelector('[data-testid="format-preview"]')`)),
          "the format dialog to close"
        );
      }
    });

    await check("the PDF window answers every request itself", async () => {
      // A page with no content policy asks a loopback server for a picture and a stylesheet. The
      // export session answers both itself, so the server must see nothing.
      let requests = 0;
      const server = createServer((_request, response) => {
        requests += 1;
        response.end("x");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const pdf = await renderPdfInHiddenWindow(
          `<!DOCTYPE html><html><body><p>probe</p><img src="http://127.0.0.1:${port}/probe.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/probe.css"></body></html>`
        );
        if (Buffer.from(pdf.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new Error("the probe page did not print");
        if (requests > 0) throw new Error(`the loopback server saw ${requests} request${requests === 1 ? "" : "s"}`);
        return "a page with no content policy reached nothing";
      } finally {
        server.close();
      }
    });

    await check("the manuscript exports to Word with its illustration", async () => {
      const bookId = await evaluate<string | null>(
        win,
        `(() => { const el = document.querySelector('[data-testid="book-card"]'); return el ? null : null; })()`
      );
      void bookId;
      // The export button lives in the workspace header, and the hook sends the file to a folder
      // the check can read rather than to a save dialog.
      const clicked = await evaluate<boolean>(
        win,
        `(() => { const button = document.querySelector('[data-testid="export-docx"]'); if (!button) return false; button.click(); return true; })()`
      );
      if (!clicked) throw new Error("the export control was not on screen");
      const folder = process.env.STUDIO_EXPORT_PATH;
      if (!folder) throw new Error("STUDIO_EXPORT_PATH is not set");
      let file = "";
      await waitUntil(async () => {
        const { readdir } = await import("node:fs/promises");
        const names = await readdir(folder).catch(() => [] as string[]);
        const found = names.find((name) => name.endsWith(".docx"));
        if (!found) return false;
        file = join(folder, found);
        return true;
      }, "the exported file");

      // A DOCX is a zip. The text is in document.xml and the picture is under word/media.
      const bytes = await readFile(file);
      if (bytes.subarray(0, 2).toString("latin1") !== "PK") throw new Error("the file is not a zip");
      const { inflateRawSync } = await import("node:zlib");
      const entries = unzip(bytes, inflateRawSync);
      const document = entries.get("word/document.xml")?.toString("utf8") ?? "";
      if (!/<w:t[^>]*>/.test(document)) throw new Error("the document has no text runs");
      const media = [...entries.keys()].filter((name) => name.startsWith("word/media/"));
      if (media.length === 0) throw new Error("the illustration is not in the file");
      const words = (document.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? []).length;
      return `${media.length} image${media.length === 1 ? "" : "s"}, ${words} text runs`;
    });

    await check("the manuscript exports to Markdown", async () => {
      // The Word export above may still be finishing, and both controls stay disabled until it does.
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`!document.querySelector('[data-testid="export-markdown"]').disabled`)),
        "the Markdown export control"
      );
      const clicked = await evaluate<boolean>(
        win,
        `(() => { const button = document.querySelector('[data-testid="export-markdown"]'); if (!button) return false; button.click(); return true; })()`
      );
      if (!clicked) throw new Error("the Markdown export control was not on screen");
      const folder = process.env.STUDIO_EXPORT_PATH;
      if (!folder) throw new Error("STUDIO_EXPORT_PATH is not set");
      let file = "";
      await waitUntil(async () => {
        const found = (await readdir(folder).catch(() => [] as string[])).find((name) => name.endsWith(".md"));
        if (!found) return false;
        file = join(folder, found);
        return true;
      }, "the exported Markdown file");
      const text = await readFile(file, "utf8");
      const chapters = (text.match(/^## /gm) ?? []).length;
      if (chapters === 0) throw new Error("the Markdown file has no chapter headings");
      return `${chapters} chapter heading${chapters === 1 ? "" : "s"}, ${text.length} characters`;
    });

    await check("a damaged chapter file is reported, the rest stays readable, and a manuscript export is refused", async () => {
      const library = studio.requireLibrary();
      const profile = process.env.STUDIO_USER_DATA;
      if (!profile || library.root !== resolve(dirname(profile), "library")) {
        throw new Error("the damaged-file check only runs in the disposable smoke library");
      }
      const folder = process.env.STUDIO_EXPORT_PATH;
      if (!folder) throw new Error("STUDIO_EXPORT_PATH is not set");
      const book = (await library.listBooks())[0];
      if (book?.id !== "book_smoke0001") throw new Error("the synthetic smoke book disappeared");
      const before = await library.readBook(book.id);
      if (before.chapters.length === 0) throw new Error("the smoke book has no readable chapter");
      if (before.chapterReadIssues.length > 0) throw new Error("the smoke book already had an unreadable chapter file");
      const sourcePaths = [
        join(library.root, "books", book.id, "book.json"),
        ...before.chapters.map((chapter) => join(library.root, "books", book.id, "chapters", chapter.path))
      ];
      const sourceBytes = await Promise.all(sourcePaths.map((source) => readFile(source)));
      // Everything the earlier exports left, byte for byte, so a refused export can be seen to leave it alone.
      const snapshotExports = async (): Promise<Map<string, Buffer>> => {
        const names = (await readdir(folder)).sort();
        return new Map(await Promise.all(names.map(async (name) => [name, await readFile(join(folder, name))] as const)));
      };
      const exportsBefore = await snapshotExports();
      if (![...exportsBefore.keys()].some((name) => name.endsWith(".docx"))) {
        throw new Error("the earlier complete Word export is missing");
      }

      const name = "0000-damaged-smoke.md";
      const path = join(library.root, "books", book.id, "chapters", name);
      const damagedBytes = "---\nid: [broken\n---\nSynthetic damaged text.\n";
      const bannerUp = (): Promise<boolean> =>
        evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="external-change"]')`));
      const refresh = async (): Promise<void> => {
        await waitUntil(bannerUp, "the external-change banner");
        const clicked = await evaluate<boolean>(
          win,
          `(() => {
            const banner = document.querySelector('[data-testid="external-change"]');
            const button = [...(banner?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.trim() === "Refresh");
            if (!button) return false;
            button.click();
            return true;
          })()`
        );
        if (!clicked) throw new Error("the external-change banner had no Refresh button");
      };
      const notice = `document.querySelector('[data-testid="chapter-read-issues"]')`;

      // Act like another editor, but only inside the smoke runner's temporary library, and after the
      // grace period for the studio's own writes.
      await delay(2200);
      await writeFile(path, damagedBytes, { flag: "wx" });
      let outcome = "";
      try {
        await refresh();
        await waitUntil(
          () => evaluate<boolean>(win, inPage(`(${notice}?.textContent ?? "").includes(${JSON.stringify(name)})`)),
          "the notice naming the damaged chapter file"
        );
        const detail = await library.readBook(book.id);
        if (!detail.chapterReadIssues.some((issue) => issue.fileName === name)) {
          throw new Error("the book response did not identify the damaged file");
        }
        if (detail.chapters.length !== before.chapters.length) throw new Error("a readable chapter disappeared");

        // Both manuscript exports that have a control on the workspace go through the real bridge and
        // are refused before anything is asked or written.
        for (const method of ["exportDocx", "exportMarkdown"] as const) {
          const refused = await evaluate<{ ok: boolean; code?: string; message?: string }>(
            win,
            `(async () => {
              const result = await window.studio.books.${method}(${JSON.stringify(book.id)});
              return result.ok ? { ok: true } : { ok: false, code: result.error.code, message: result.error.message };
            })()`
          );
          if (refused.ok || refused.code !== "format" || !refused.message?.includes("not exported")) {
            throw new Error(`${method} did not give the fixed refusal`);
          }
        }
        const exportsAfter = await snapshotExports();
        if (JSON.stringify([...exportsAfter.keys()]) !== JSON.stringify([...exportsBefore.keys()])) {
          throw new Error("a refused export created or removed a file");
        }
        for (const [file, bytes] of exportsBefore) {
          if (!bytes.equals(exportsAfter.get(file) ?? Buffer.alloc(0))) throw new Error(`a refused export changed ${file}`);
        }

        if ((await readFile(path, "utf8")) !== damagedBytes) throw new Error("the damaged source file changed");
        const afterBytes = await Promise.all(sourcePaths.map((source) => readFile(source)));
        if (afterBytes.some((bytes, index) => !bytes.equals(sourceBytes[index] ?? Buffer.alloc(0)))) {
          throw new Error("another source file changed while reading the book");
        }
        outcome = "the notice names the file; readable chapters, source bytes and earlier exports are untouched; both exports are refused";
      } finally {
        await rm(path, { force: true });
      }

      // Take the file's removal in too, so the next checks start from the screen they expect.
      await refresh();
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`!${notice}`)),
        "the notice to go once the damaged file was removed"
      );
      return outcome;
    });

    await check("front and back matter saves from the Format dialog and reaches the e-book in order", async () => {
      const folder = process.env.STUDIO_EXPORT_PATH;
      if (!folder) throw new Error("STUDIO_EXPORT_PATH is not set");
      // The earlier EPUB moves aside, so this export asks no replace question.
      for (const name of await readdir(folder)) {
        if (name.endsWith(".epub")) await rename(join(folder, name), join(folder, name.replace(/\.epub$/, "-before-matter.epub")));
      }
      const book = (await studio.requireLibrary().listBooks())[0];
      if (!book) throw new Error("the smoke book disappeared");
      const open = async (): Promise<void> => {
        await evaluate(win, `document.querySelector('[data-testid="format-book"]').click()`);
        await waitUntil(() => evaluate<boolean>(win, inPage(`!!document.querySelector('[data-testid="format-matter"]')`)), "the matter section");
      };
      const close = async (): Promise<void> => {
        await evaluate(win, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        await waitUntil(() => evaluate<boolean>(win, inPage(`!document.querySelector('[data-testid="format-preview"]')`)), "the format dialog to close");
      };
      // Typed as React reads a field.
      const typeAuthor = (name: string): Promise<boolean> =>
        evaluate<boolean>(
          win,
          `(() => {
            const author = [...document.querySelectorAll("label")].find((label) => label.firstChild?.textContent === "Author")?.querySelector("input");
            if (!author) return false;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(author, ${JSON.stringify(name)});
            author.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          })()`
        );
      await open();
      try {
        // A copyright page, the first kind offered, then an author, typed as React reads a field.
        const added = await evaluate<boolean>(
          win,
          `(() => { const add = [...document.querySelectorAll("button")].find((button) => button.textContent === "Add section"); add?.click(); return !!add; })()`
        );
        if (!added) throw new Error("the Add section action was not on screen");
        await waitUntil(() => evaluate<boolean>(win, inPage(`!!document.querySelector('[aria-label="Move Copyright down"]')`)), "the new copyright page");
        if (!(await typeAuthor("Smoke Author"))) throw new Error("the author field was not on screen");
      } finally {
        // Closing saves what is waiting, through the preload, the checked channel and the library.
        await close();
      }
      await waitUntil(async () => {
        const matter = (await studio.requireLibrary().readBook(book.id)).book.matter as { author?: string; sections?: unknown[] } | undefined;
        return matter?.author === "Smoke Author" && matter.sections?.length === 1;
      }, "the matter on disk");

      // A second change, saved by the export itself. Its base is the matter the first save sent back
      // across the bridge, and the main process checks it against the file: a mismatch would keep a
      // conflict copy and refuse the export.
      await open();
      try {
        if (!(await typeAuthor("Smoke Author Two"))) throw new Error("the author field was not on screen");
        const file = await exportFromFormat("EPUB", "epub");
        const saved = (await studio.requireLibrary().readBook(book.id)).book.matter as { version?: number; author?: string } | undefined;
        if (saved?.version !== 2 || saved.author !== "Smoke Author Two") throw new Error(`matter on disk: ${JSON.stringify(saved)}`);
        const kept = (await readdir(join(studio.requireLibrary().root, "books", book.id, "conflicts")).catch(() => [] as string[])).filter(
          (name) => name.startsWith("front-and-back-matter.conflict")
        );
        if (kept.length > 0) throw new Error(`a conflict copy was kept: ${kept.join(", ")}`);
        const { inflateRawSync } = await import("node:zlib");
        const entries = unzip(await readFile(file), inflateRawSync);
        const opf = entries.get("EPUB/package.opf")?.toString("utf8") ?? "";
        const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((match) => match[1]);
        // The contents page joins the reading order after the front matter when the book asks for one.
        if (spine[0] !== "title-page" || spine[1] !== "front-01" || !(spine[2] === "nav" || spine[2]?.startsWith("chapter-"))) {
          throw new Error(`spine read: ${spine.join(", ")}`);
        }
        if (!(entries.get("EPUB/title.xhtml")?.toString("utf8") ?? "").includes("Smoke Author Two")) throw new Error("the title page has no author");
        const copyright = entries.get("EPUB/front-01.xhtml")?.toString("utf8") ?? "";
        if (!copyright.includes('epub:type="copyright-page"') || !copyright.includes("All rights reserved.")) {
          throw new Error("the copyright page is not its own document");
        }
        if (!opf.includes("<dc:creator>Smoke Author Two</dc:creator>")) throw new Error("the e-book names no author");
        return `two checked saves (version 2, no conflict copy) · ${file.split("/").pop()} · ${spine.join(" → ")}`;
      } finally {
        await close();
      }
    });

    await check("the whole library exports as an archive", async () => {
      const result = await evaluate<{ ok: boolean; path?: string; error?: string }>(
        win,
        `(async () => {
          try {
            const exported = await window.studio.library.exportArchive();
            if (!exported.ok) return { ok: false, error: exported.error.message };
            return { ok: true, path: exported.data.path, entries: exported.data.entryCount };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        })()`
      );
      if (!result.ok || !result.path) throw new Error(result.error ?? "the export failed");
      const bytes = await readFile(result.path);
      if (bytes.subarray(0, 2).toString("latin1") !== "PK") throw new Error("the archive is not a zip");
      const { inflateRawSync } = await import("node:zlib");
      const entries = unzip(bytes, inflateRawSync);
      const book = [...entries.keys()].find((name) => name.endsWith("book.json"));
      if (!book) throw new Error("the archive has no book");
      const manifest = entries.get(book)?.toString("utf8") ?? "";
      if (!/"id"/.test(manifest)) throw new Error("the book in the archive has no id");
      return `${entries.size} entries, ${book.split("/").slice(-2).join("/")}`;
    });

    await check("the book's images export as JPEG files", async () => {
      // The action lives in the book's actions in the library, not in the workspace header.
      const back = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[aria-label="Back to library"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!back) throw new Error("the back button was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="book-actions"]')`)),
        "the library book actions"
      );
      try {
        await evaluate(win, `document.querySelector('[data-testid="book-actions"]').click()`);
        await waitUntil(
          () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="export-images"]')`)),
          "the Export images action"
        );
        await evaluate(win, `document.querySelector('[data-testid="export-images"]').click()`);
        await waitUntil(
          () =>
            evaluate<boolean>(
              win,
              inPage(`(document.querySelector('[data-testid="export-images-note"]')?.innerText ?? "").startsWith("Saved ")`)
            ),
          "the export note"
        );
        const note = await evaluate<string>(
          win,
          `document.querySelector('[data-testid="export-images-note"]')?.innerText ?? ""`
        );
        if (!note.includes("smoke-test-book-images")) throw new Error(`note read: ${JSON.stringify(note)}`);

        // The hook sends the folder to STUDIO_EXPORT_PATH instead of a folder picker.
        const exports = process.env.STUDIO_EXPORT_PATH;
        if (!exports) throw new Error("STUDIO_EXPORT_PATH is not set");
        const book = (await studio.requireLibrary().listBooks())[0];
        if (!book) throw new Error("the smoke book disappeared");
        const detail = await studio.requireLibrary().readBook(book.id);
        // The drag check reorders the chapters, so the illustration's number comes from the current order.
        const order = [...detail.chapters].sort((a, b) => a.order - b.order);
        const position = order.findIndex((chapter) => chapter.id === "ch_smoke0001") + 1;
        if (position === 0) throw new Error("the illustrated chapter is missing");
        const expected = `${String(position).padStart(2, "0")}-the-light.jpg`;
        const folder = join(exports, "smoke-test-book-images");
        const names = await readdir(folder);
        if (!names.includes(expected)) throw new Error(`expected ${expected}, found ${JSON.stringify(names)}`);
        for (const name of names) {
          const bytes = await readFile(join(folder, name));
          if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error(`${name} is not a JPEG`);
        }
        return `${names.join(", ")} · ${note}`;
      } finally {
        // Close the dialog so the next check starts from the library.
        await evaluate<boolean>(
          win,
          `(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return true; })()`
        );
        await waitUntil(
          () => evaluate<boolean>(win, inPage(`!document.querySelector('[data-testid="export-images"]')`)),
          "the book settings dialog to close"
        );
      }
    });

    await check("a book can be renamed and moved to the trash", async () => {
      const back = await evaluate<boolean>(
        win,
        `(() => {
          // The image export check above already returned to the library.
          if (document.querySelector('[data-testid="library-view"]')) return true;
          const button = document.querySelector('[aria-label="Back to library"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!back) throw new Error("the back button was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="book-actions"]')`)),
        "the library book actions"
      );

      const opened = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="book-actions"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!opened) throw new Error("the book actions button was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="book-title"]')`)),
        "the book settings dialog"
      );

      const renamed = await evaluate<boolean>(
        win,
        `(() => {
          const field = document.querySelector('[data-testid="book-title"]');
          if (!field) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(field, "Smoke Test Book Renamed");
          field.dispatchEvent(new Event("input", { bubbles: true }));
          const save = document.querySelector('[data-testid="save-book-settings"]');
          if (!save) return false;
          save.click();
          return true;
        })()`
      );
      if (!renamed) throw new Error("the rename field was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`(document.body.innerText || "").includes("Smoke Test Book Renamed")`)),
        "the renamed book card"
      );

      const reopened = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="book-actions"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!reopened) throw new Error("the book actions button was not found after renaming");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="delete-book"]')`)),
        "the delete action"
      );
      await evaluate(win, `document.querySelector('[data-testid="delete-book"]').click()`);
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="confirm-delete-book"]')`)),
        "the delete confirmation"
      );
      await evaluate(win, `document.querySelector('[data-testid="confirm-delete-book"]').click()`);
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelectorAll('[data-testid="book-card"]').length === 0`)),
        "the book to leave the library"
      );
      return "renamed, then moved to the trash";
    });

    await check("an empty book reports insufficient evidence", async () => {
      const creating = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "New book");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!creating) throw new Error("the New book button was not found");
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(
              `[...document.querySelectorAll('[role="dialog"] button')].some((item) => item.textContent?.trim() === "Create book")`
            )
          ),
        "the new book dialog"
      );
      const created = await evaluate<boolean>(
        win,
        `(() => {
          const dialog = [...document.querySelectorAll('[role="dialog"]')].find((entry) => (entry.textContent ?? "").includes("Create book"));
          const field = dialog?.querySelector("input");
          const create = [...(dialog?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.trim() === "Create book");
          if (!field || !create) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(field, "Smoke Empty Book");
          field.dispatchEvent(new Event("input", { bubbles: true }));
          create.click();
          return true;
        })()`
      );
      if (!created) throw new Error("the new book dialog could not be completed");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="workspace-view"]')`)),
        "the empty book workspace"
      );
      const clicked = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="review-manuscript"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!clicked) throw new Error("the Review manuscript button was not found");
      // Wait for the verdict copy, not the dialog shell: the shell renders while reading.
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(
              `(document.querySelector('[data-testid="review-report"]')?.innerText ?? "").includes("Not enough saved text to review")`
            )
          ),
        "the insufficient-evidence report"
      );
      const copy = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="review-report"]')?.innerText ?? ""`
      );
      if (!copy.includes("Not enough saved text to review")) {
        throw new Error(`report read: ${JSON.stringify(copy.slice(0, 160))}`);
      }
      const closed = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll('[data-testid="review-report"] button')].find((item) => item.textContent?.trim() === "Close");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closed) throw new Error("the report had no Close button");
      return "a book with no readable chapters says so instead of reporting no findings";
    });

    await check("a slow run can be cancelled before analysis", async () => {
      const prepared = await evaluate<{ ok: boolean; error?: string }>(
        win,
        `(async () => {
          try {
            const books = await window.studio.books.list();
            if (!books.ok || !books.data[0]) return { ok: false, error: "no book is open" };
            const created = await window.studio.chapters.create(books.data[0].id, { title: "Long" });
            if (!created.ok) return { ok: false, error: created.error.message };
            const chapter = created.data;
            const saved = await window.studio.chapters.save({
              bookId: books.data[0].id,
              chapterId: chapter.id,
              content: ("word ".repeat(3000000) + "\\n"),
              baseVersion: chapter.version,
              baseHash: chapter.hash
            });
            if (!saved.ok) return { ok: false, error: saved.error.message };
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        })()`
      );
      if (!prepared.ok) throw new Error(prepared.error ?? "the long chapter could not be written");
      const clicked = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="review-manuscript"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!clicked) throw new Error("the Review manuscript button was not found");
      // The retained report revalidates against the new chapter and turns stale; a new
      // run starts from Run again, which reads the long chapter on a cancellable path.
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="review-stale"]')`)),
        "the stale report"
      );
      const restarted = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll('[data-testid="review-report"] button')].find((item) => item.textContent?.trim() === "Run again");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!restarted) throw new Error("the stale report offered no new run");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="review-cancel-run"]')`)),
        "the running review with its cancel control"
      );
      const cancelled = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[data-testid="review-cancel-run"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!cancelled) throw new Error("the running review had no cancel control");
      // The stress chapter is 3M words; on a slow machine the stopped state can take
      // well past the default window to render after the abort lands. The assertion is
      // unchanged: only the stopped state passes, never a completed report.
      try {
        await waitUntil(
          () =>
            evaluate<boolean>(
              win,
              inPage(`(document.querySelector('[data-testid="review-report"]')?.innerText ?? "").includes("Partial results are discarded")`)
            ),
          "the stopped run",
          60_000
        );
      } catch {
        const state = await evaluate<string>(
          win,
          `document.querySelector('[data-testid="review-report"]')?.innerText.slice(0, 300) ?? "no report element"`
        );
        throw new Error(`the stopped state never rendered; the report shows: ${state}`);
      }
      const body = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="review-report"]')?.innerText ?? ""`
      );
      if (body.includes("Studio word count")) throw new Error("the cancelled run still produced a report");
      const closed = await evaluate<boolean>(
        win,
        `(() => {
          const button = [...document.querySelectorAll('[data-testid="review-report"] button')].find((item) => item.textContent?.trim() === "Close");
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!closed) throw new Error("the stopped run had no Close button");
      return "Cancel run discarded the slow read before any analysis";
    });

    // Spec 029 T013: the macOS reference journey over a synthetic fixture. The hidden
    // run answers the native picker with STUDIO_IMPORT_PATH, then drives the real
    // preview, split, confirm and result UI. The book appears only after publication.
    const fixturePath = process.env.STUDIO_IMPORT_PATH ?? "";
    const snapshotTree = async (root: string): Promise<Map<string, string>> => {
      const files = new Map<string, string>();
      const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
          else files.set(rel, createHash("sha256").update(await readFile(join(dir, entry.name))).digest("hex"));
        }
      };
      await walk(root, "");
      return files;
    };
    let libraryBefore: Map<string, string> | null = null;
    let fixtureBefore = "";
    let cardsBefore = 0;

    await checkImport("manuscript import previews the synthetic fixture without publishing", async () => {
      if (!fixturePath) throw new Error("STUDIO_IMPORT_PATH is not set for the hidden run");
      const library = studio.library;
      if (!library) throw new Error("no library is open for the import journey");
      fixtureBefore = await readFile(fixturePath, "utf8");
      libraryBefore = await snapshotTree(library.root);
      const back = await evaluate<boolean>(
        win,
        `(() => {
          const button = document.querySelector('[aria-label="Back to library"]');
          if (!button) return false;
          button.click();
          return true;
        })()`
      );
      if (!back) throw new Error("the back button was not found");
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="import-manuscript"]')`)),
        "the manuscript import action"
      );
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(
              `document.querySelectorAll('[data-testid="book-card"]').length > 0 || (document.body.innerText ?? "").includes("No books yet")`
            )
          ),
        "the library book list to settle"
      );
      cardsBefore = await evaluate<number>(win, `document.querySelectorAll('[data-testid="book-card"]').length`);
      await evaluate(win, `document.querySelector('[data-testid="import-manuscript"]').click()`);
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="import-preview-dialog"]')`)),
        "the import preview"
      );
      const preview = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="import-preview-dialog"]')?.innerText ?? ""`
      );
      for (const expected of ["manuscript.txt", "The lighthouse keeper counted the gulls.", "Lines 1 to 6"]) {
        if (!preview.includes(expected)) throw new Error(`preview read: ${JSON.stringify(preview.slice(0, 200))}`);
      }
      const cards = await evaluate<number>(win, `document.querySelectorAll('[data-testid="book-card"]').length`);
      if (cards !== cardsBefore) throw new Error(`a book appeared before confirmation (${cardsBefore} → ${cards})`);
      const tree = await snapshotTree(library.root);
      if (tree.size !== libraryBefore.size) throw new Error("choosing and previewing wrote to the library");
      return "full fixture text, source name and line range; no book, no writes";
    });

    await checkImport("confirming the preview publishes exactly one complete book", async () => {
      const edited = await evaluate<boolean>(
        win,
        `(() => {
          const title = document.querySelector('[data-testid="import-book-title"]');
          const split = document.querySelector('[data-testid="import-new-split"]');
          const add = document.querySelector('[data-testid="import-add-split"]');
          if (!(title instanceof HTMLInputElement) || !(split instanceof HTMLInputElement) || !add) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(title, "Smoke Import");
          title.dispatchEvent(new Event("input", { bubbles: true }));
          setter.call(split, "5");
          split.dispatchEvent(new Event("input", { bubbles: true }));
          add.click();
          return true;
        })()`
      );
      if (!edited) throw new Error("the title and split controls were not found");
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`(document.querySelector('[data-testid="import-chapter-lines-2"]')?.textContent ?? "").includes("Lines 5 to 6")`)
          ),
        "the split preview"
      );
      await evaluate(win, `document.querySelector('[data-testid="import-confirm"]').click()`);
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="import-result-dialog"]')`)),
        "the import result"
      );
      const result = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="import-result-dialog"]')?.innerText ?? ""`
      );
      for (const expected of ["manuscript.txt", "Smoke Import", "Lines 1 to 4", "Lines 5 to 6", "were not imported"]) {
        if (!result.includes(expected)) throw new Error(`result read: ${JSON.stringify(result.slice(0, 200))}`);
      }
      await evaluate(win, `document.querySelector('[data-testid="import-result-close"]').click()`);
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`[...document.querySelectorAll('[data-testid="book-card"]')].some((card) => (card.textContent ?? "").includes("Smoke Import"))`)
          ),
        "the imported book card"
      );
      const cards = await evaluate<number>(win, `document.querySelectorAll('[data-testid="book-card"]').length`);
      if (cards !== cardsBefore + 1) throw new Error(`expected one new book card, saw ${cardsBefore} → ${cards}`);
      return "report, then one new card for Smoke Import";
    });

    await checkImport("the published book matches the confirmed mapping on disk", async () => {
      const published = await evaluate<{ ok: boolean; error?: string } | null>(
        win,
        `(async () => {
          try {
            const books = await window.studio.books.list();
            if (!books.ok) return null;
            const match = books.data.find((book) => book.title === "Smoke Import");
            if (!match) return { ok: false, error: "the imported book is not listed" };
            const opened = await window.studio.books.open(match.id);
            if (!opened.ok) return { ok: false, error: opened.error.message };
            const chapters = opened.data.chapters;
            if (chapters.length !== 2) return { ok: false, error: chapters.length + " chapters" };
            if (chapters[0].title !== "Chapter 1" || chapters[1].title !== "Chapter 2") {
              return { ok: false, error: "chapter titles changed" };
            }
            if (chapters[0].content !== "The lighthouse keeper counted the gulls.\\n\\nBy evening the count was wrong again.\\n") {
              return { ok: false, error: "chapter 1 body changed" };
            }
            if (chapters[1].content !== "The light was the only thing that still agreed with him.\\nDawn came grey and gull-less.\\n") {
              return { ok: false, error: "chapter 2 body changed" };
            }
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        })()`
      );
      if (!published) throw new Error("the book list could not be read");
      if (!published.ok) throw new Error(published.error ?? "the published book is wrong");
      return "two chapters with the confirmed titles and bodies";
    });

    await checkImport("the fixture and the rest of the library are unchanged", async () => {
      const library = studio.library;
      const before = libraryBefore;
      if (!library || !before) throw new Error("no library snapshot to compare against");
      const fixtureAfter = await readFile(fixturePath, "utf8");
      if (fixtureAfter !== fixtureBefore) throw new Error("the source fixture changed");
      const after = await snapshotTree(library.root);
      const added = [...after.keys()].filter((path) => !before.has(path));
      const changed = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path));
      const removed = [...before.keys()].filter((path) => !after.has(path));
      const fresh = added.filter((path) => path.startsWith("books/") && path.split("/").length > 2);
      const firstFresh = fresh[0];
      if (firstFresh === undefined) throw new Error("no published book directory appeared");
      const freshRoot = firstFresh.split("/").slice(0, 2).join("/");
      const stray = added.filter((path) => !path.startsWith(`${freshRoot}/`) && path !== "library.json" && !path.startsWith(".studio/"));
      if (stray.length > 0) throw new Error(`unexpected new files: ${stray.slice(0, 3).join(", ")}`);
      if (removed.length > 0) throw new Error(`files disappeared: ${removed.slice(0, 3).join(", ")}`);
      const touched = changed.filter((path) => !path.startsWith(`${freshRoot}/`) && path !== "library.json" && !path.startsWith(".studio/"));
      if (touched.length > 0) throw new Error(`existing files changed: ${touched.slice(0, 3).join(", ")}`);
      return `one new book directory, fixture identical, ${changed.length} derived file(s) refreshed`;
    });

    // D-183: the same journey for a synthetic Word document. The picker is answered with
    // the DOCX fixture; the checks take their own baselines, read the heading chapters and
    // the loss report, and compare the published bodies with the preview exactly.
    const docxPath = process.env.STUDIO_IMPORT_DOCX_PATH ?? "";
    const wordChapters = [
      ["The Harbour", "The keeper **counted** the boats.\n\n- Rope\n- Lamp oil\n"],
      ["The Storm", "Rain came *sideways*.\n\nnorth\nsouth\n\nA picture follows.\n"]
    ];
    const fileHash = async (path: string): Promise<string> =>
      createHash("sha256").update(await readFile(path)).digest("hex");
    let wordLibraryBefore: Map<string, string> | null = null;
    let wordFixtureBefore = "";
    let wordCardsBefore = 0;

    await checkImport("a Word manuscript previews heading chapters and its losses without publishing", async () => {
      if (!docxPath) throw new Error("STUDIO_IMPORT_DOCX_PATH is not set for the hidden run");
      const library = studio.library;
      if (!library) throw new Error("no library is open for the Word import journey");
      process.env.STUDIO_IMPORT_PATH = docxPath;
      wordFixtureBefore = await fileHash(docxPath);
      wordLibraryBefore = await snapshotTree(library.root);
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`document.querySelector('[data-testid="import-manuscript"]') && !document.querySelector('[data-testid="import-manuscript"]').disabled`)
          ),
        "the manuscript import action"
      );
      wordCardsBefore = await evaluate<number>(win, `document.querySelectorAll('[data-testid="book-card"]').length`);
      await evaluate(win, `document.querySelector('[data-testid="import-manuscript"]').click()`);
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="import-loss"]')`)),
        "the Word import preview"
      );
      const seen = await evaluate<{ book: string; chapters: string[][]; loss: string[] }>(
        win,
        `(() => {
          const value = (id) => document.querySelector('[data-testid="' + id + '"]');
          const chapters = [];
          for (let order = 1; value('import-chapter-title-' + order); order += 1) {
            chapters.push([value('import-chapter-title-' + order).value, value('import-chapter-body-' + order).textContent]);
          }
          return {
            book: value('import-book-title')?.value ?? "",
            chapters,
            loss: [...document.querySelectorAll('[data-testid^="import-loss-"]')].map((item) => item.getAttribute('data-testid'))
          };
        })()`
      );
      if (seen.book !== "Smoke Voyage") throw new Error(`the book title read ${JSON.stringify(seen.book)}`);
      if (JSON.stringify(seen.chapters) !== JSON.stringify(wordChapters)) {
        throw new Error(`the preview read ${JSON.stringify(seen.chapters)}`);
      }
      for (const kind of ["table", "image", "footnote"]) {
        if (!seen.loss.includes(`import-loss-${kind}`)) throw new Error(`the loss report lacks ${kind}: ${seen.loss.join(", ")}`);
      }
      const cards = await evaluate<number>(win, `document.querySelectorAll('[data-testid="book-card"]').length`);
      if (cards !== wordCardsBefore) throw new Error(`a book appeared before confirmation (${wordCardsBefore} → ${cards})`);
      const tree = await snapshotTree(library.root);
      if (tree.size !== wordLibraryBefore.size) throw new Error("choosing and previewing a Word document wrote to the library");
      return "two heading chapters with exact bodies; table, image and footnote listed; no writes";
    });

    await checkImport("confirming the Word preview publishes exactly those chapters", async () => {
      await evaluate(win, `document.querySelector('[data-testid="import-confirm"]').click()`);
      await waitUntil(
        () => evaluate<boolean>(win, inPage(`document.querySelector('[data-testid="import-result-dialog"]')`)),
        "the Word import result"
      );
      const result = await evaluate<string>(
        win,
        `document.querySelector('[data-testid="import-result-dialog"]')?.innerText ?? ""`
      );
      for (const expected of ["manuscript.docx", "Smoke Voyage", "The Harbour", "The Storm", "1 table", "1 image", "1 footnote"]) {
        if (!result.includes(expected)) throw new Error(`result read: ${JSON.stringify(result.slice(0, 300))}`);
      }
      await evaluate(win, `document.querySelector('[data-testid="import-result-close"]').click()`);
      await waitUntil(
        () =>
          evaluate<boolean>(
            win,
            inPage(`[...document.querySelectorAll('[data-testid="book-card"]')].some((card) => (card.textContent ?? "").includes("Smoke Voyage"))`)
          ),
        "the imported Word book card"
      );
      const cards = await evaluate<number>(win, `document.querySelectorAll('[data-testid="book-card"]').length`);
      if (cards !== wordCardsBefore + 1) throw new Error(`expected one new book card, saw ${wordCardsBefore} → ${cards}`);
      const published = await evaluate<{ ok: boolean; error?: string; chapters?: string[][] } | null>(
        win,
        `(async () => {
          const books = await window.studio.books.list();
          if (!books.ok) return null;
          const match = books.data.find((book) => book.title === "Smoke Voyage");
          if (!match) return { ok: false, error: "the imported Word book is not listed" };
          const opened = await window.studio.books.open(match.id);
          if (!opened.ok) return { ok: false, error: opened.error.message };
          return { ok: true, chapters: opened.data.chapters.map((chapter) => [chapter.title, chapter.content]) };
        })()`
      );
      if (!published) throw new Error("the book list could not be read");
      if (!published.ok) throw new Error(published.error ?? "the published Word book is wrong");
      if (JSON.stringify(published.chapters) !== JSON.stringify(wordChapters)) {
        throw new Error(`published ${JSON.stringify(published.chapters)}`);
      }
      return "result report with the loss list, one new card, the previewed bodies on disk";
    });

    await checkImport("the Word fixture and the rest of the library are unchanged", async () => {
      const library = studio.library;
      const before = wordLibraryBefore;
      if (!library || !before) throw new Error("no library snapshot to compare against");
      if ((await fileHash(docxPath)) !== wordFixtureBefore) throw new Error("the Word fixture changed");
      const after = await snapshotTree(library.root);
      const added = [...after.keys()].filter((path) => !before.has(path));
      const removed = [...before.keys()].filter((path) => !after.has(path));
      const freshRoots = new Set(added.filter((path) => path.startsWith("books/")).map((path) => path.split("/").slice(0, 2).join("/")));
      if (freshRoots.size !== 1) throw new Error(`expected one new book directory, saw ${freshRoots.size}`);
      const [freshRoot] = [...freshRoots];
      const outside = (path: string): boolean =>
        !path.startsWith(`${freshRoot}/`) && path !== "library.json" && !path.startsWith(".studio/");
      const stray = added.filter(outside);
      if (stray.length > 0) throw new Error(`unexpected new files: ${stray.slice(0, 3).join(", ")}`);
      if (removed.length > 0) throw new Error(`files disappeared: ${removed.slice(0, 3).join(", ")}`);
      const touched = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path) && outside(path));
      if (touched.length > 0) throw new Error(`existing files changed: ${touched.slice(0, 3).join(", ")}`);
      process.env.STUDIO_IMPORT_PATH = fixturePath;
      return "one new book directory, Word fixture identical by hash";
    });

  } finally {
    await finish(win, checks, rendererErrors);
  }
}

async function finish(win: BrowserWindow, checks: Check[], rendererErrors: string[]): Promise<void> {
  const skipped = checks.filter((entry) => entry.skipped).length;
  const ran = checks.length - skipped;
  const passed = checks.filter((entry) => entry.ok && !entry.skipped).length;
  const ok = passed === ran && ran > 0;
  console.log(`[smoke] ${passed}/${ran} checks passed${skipped ? `, ${skipped} skipped on this platform` : ""}`);
  if (!ok) {
    try {
      const runDir = join(tmpdir(), `ai-book-studio-smoke-${process.pid}`);
      await mkdir(runDir, { recursive: true });
      const shot = join(runDir, "smoke-failure.png");
      await writeFile(shot, await win.webContents.capturePage().then((image) => image.toPNG()));
      const log = join(runDir, "smoke-console.log");
      await writeFile(log, `${rendererErrors.map((line) => redactLine(line)).join("\n")}\n`, "utf8");
      console.error(`[smoke] artifacts: ${shot} ${log}`);
    } catch (error) {
      console.error(`[smoke] artifact capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`[smoke] result ${JSON.stringify({ ok, checks })}`);
  app.exit(ok ? 0 : 1);
}
