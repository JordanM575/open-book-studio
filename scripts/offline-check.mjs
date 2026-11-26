#!/usr/bin/env node
/**
 * Proves that writing, planning, importing and exporting need no network (spec 002 FR-060).
 *
 * It starts the built desktop app hidden, in a throwaway profile with a synthetic library, inside a
 * macOS Seatbelt profile (`sandbox-exec`) that denies every outbound connection, loopback included.
 * Playwright can still drive the window, because it connects in to the app's debugging ports and
 * inbound connections stay allowed. Before and after the journey, the app's own main process tries
 * to connect out, through Node and through Chromium's network service, and the operating system
 * must refuse each attempt with a permission error. A timeout or "unreachable" would mean the denial
 * was not in force, so the check fails rather than proving nothing.
 *
 * The journey, with every step asserted on disk:
 *
 *   1. create a book in the New book dialog and add a chapter
 *   2. type into the manuscript and let autosave write the chapter file
 *   3. edit the Story Bible and save it to book.json
 *   4. import a synthetic TXT manuscript through the macOS import path, with STUDIO_IMPORT_PATH
 *      answering the native picker as it does in the smoke run
 *   5. export the book to Word and to Markdown, with STUDIO_EXPORT_PATH naming the folder
 *
 * Chromium's own renderer sandbox cannot start inside an outer Seatbelt profile, so this run passes
 * `--no-sandbox`. The outer profile still applies to every process the app starts.
 *
 *   bun run build
 *   node scripts/offline-check.mjs
 *   node scripts/offline-check.mjs --keep   # keep the temporary profile and library
 *
 * `sandbox-exec` exists only on macOS. Anywhere else the check says it was skipped and proves nothing.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headlessDesktopEnvironment, mockKeychainArgs } from "./headless-environment.mjs";
import { capturePage, createRunDir } from "./failure-artifacts.mjs";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) {
  console.log(`[offline] skipped: the network denial needs macOS sandbox-exec, and this is ${process.platform}`);
  process.exit(0);
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = join(root, "apps", "desktop");
const builtMain = join(appDir, "out", "main", "index.cjs");
const keep = process.argv.includes("--keep");

if (!existsSync(builtMain)) {
  console.error("[offline] No build found. Run `bun run build` first.");
  process.exit(1);
}

const { _electron } = await import("playwright");
const electronPath = createRequire(join(appDir, "package.json"))("electron");

const temp = await mkdtemp(join(tmpdir(), "ai-book-studio-offline-"));
const profile = join(temp, "profile");
const libraryRoot = join(temp, "library");
const exports = join(temp, "exports");
const manuscriptPath = join(temp, "manuscript.txt");
await mkdir(profile, { recursive: true });
await mkdir(libraryRoot, { recursive: true });
await mkdir(exports, { recursive: true });
await writeFile(join(profile, "studio.json"), `${JSON.stringify({ libraryRoot }, null, 2)}\n`);

// A synthetic manuscript for the import step. Nothing here resembles an author's manuscript.
const paragraphs = [
  "The ferry left without its bell.",
  "Nobody on the quay could say who had taken it, and nobody wanted to.",
  "By noon the harbour master had written the loss in the book twice."
];
await writeFile(manuscriptPath, `${paragraphs.join("\n\n")}\n`);
const manuscriptHash = sha256(await readFile(manuscriptPath));

/*
 * Every outbound connection is denied, loopback included, so not even a relay listening on this
 * machine (a coding agent's proxy, say) could carry the app's traffic. Inbound stays allowed:
 * Playwright drives the app by connecting in to its debugging ports.
 */
const policy = join(temp, "offline.sb");
await writeFile(policy, "(version 1)\n(allow default)\n(deny network-outbound)\n");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const launcher = join(temp, "electron-offline.sh");
// Playwright puts its own switches first, so the wrapper places them after the sandboxed binary.
await writeFile(launcher, `#!/bin/sh\nexec ${SANDBOX_EXEC} -f ${quote(policy)} ${quote(electronPath)} "$@"\n`);
await chmod(launcher, 0o755);

const env = headlessDesktopEnvironment(process.env, profile);
env.STUDIO_IMPORT_PATH = manuscriptPath;
env.STUDIO_EXPORT_PATH = exports;

// A local listener the sandboxed app must not reach. Any accepted connection fails the run.
let accepted = 0;
const listener = createServer((socket) => {
  accepted += 1;
  socket.destroy();
});
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const loopbackPort = listener.address().port;

const BOOK_TITLE = "Offline Journey";
const IMPORT_TITLE = "Offline Import";
const marker = `Written with the network denied ${Date.now()}`;
const premise = `A ferry town that keeps losing its bells ${Date.now()}`;

const results = [];
let app = null;
let page = null;
let capture = null;
let failed = false;

const hang = setTimeout(() => {
  console.error("[offline] Timed out after 240s; stopping the run.");
  app?.process().kill("SIGKILL");
}, 240_000);

try {
  app = await _electron.launch({
    executablePath: launcher,
    args: ["--no-sandbox", ...mockKeychainArgs(), appDir],
    cwd: appDir,
    env,
    timeout: 60_000
  });
  page = await app.firstWindow();
  capture = await capturePage(page);
  console.log(`[offline] hidden run under sandbox-exec · profile ${profile}`);

  await step("outbound connections are refused before the journey", () => provedDenied());

  await step("a book and its first chapter are created", async () => {
    await waitFor(() => present('[data-testid="library-view"]'), "the library view");
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "New book");
      if (!button) throw new Error("the New book button was not found");
      button.click();
    });
    await waitFor(
      () =>
        page.evaluate(() =>
          [...document.querySelectorAll('[role="dialog"] button')].some((item) => item.textContent?.trim() === "Create book")
        ),
      "the new book dialog"
    );
    await page.evaluate((title) => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find((entry) => (entry.textContent ?? "").includes("Create book"));
      const field = dialog?.querySelector("input");
      const create = [...(dialog?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.trim() === "Create book");
      if (!field || !create) throw new Error("the new book dialog has no title field or Create book button");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(field, title);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      create.click();
    }, BOOK_TITLE);
    await waitFor(() => present('[data-testid="workspace-view"]'), "the new book's workspace");
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.getAttribute("aria-label") === "Add chapter" || item.textContent?.trim() === "Add chapter"
      );
      if (!button) throw new Error("the Add chapter button was not found");
      button.click();
    });
    await waitFor(() => present('[data-testid="manuscript-text"]'), "the new chapter's editor");
    const book = await bookOnDisk(BOOK_TITLE);
    const chapters = await chapterFiles(book.dir);
    if (chapters.length !== 1) throw new Error(`expected one chapter file, found ${chapters.length}`);
    return `${relative(book.dir)}/book.json and chapters/${chapters[0].name}`;
  });

  await step("typing is autosaved to the chapter file", async () => {
    const book = await bookOnDisk(BOOK_TITLE);
    const [before] = await chapterFiles(book.dir);
    await page.evaluate((text) => {
      const editor = document.querySelector('[data-testid="manuscript-text"]');
      if (!editor) throw new Error("the manuscript editor was not found");
      editor.value = editor.value ? `${editor.value}\n\n${text}` : text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }, marker);
    let after = before;
    await waitFor(async () => {
      [after] = await chapterFiles(book.dir);
      return after?.text.includes(marker) ?? false;
    }, "the autosave to reach the chapter file");
    await waitFor(
      () => page.evaluate(() => (document.querySelector('[data-testid="save-status"]')?.textContent ?? "").includes("Saved")),
      "the save status to settle"
    );
    if (after.version <= before.version) throw new Error(`the version did not move (${before.version} → ${after.version})`);
    return `chapters/${after.name} holds the typed line, version ${before.version} → ${after.version}`;
  });

  await step("the Story Bible saves to book.json", async () => {
    const clicked = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="open-story-bible"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    });
    if (!clicked) throw new Error("the Story Bible button was not found");
    await waitFor(() => present('[data-testid="save-story-bible"]'), "the Story Bible dialog");
    await page.evaluate((text) => {
      // The first text area is "What it is about", the premise the agent and the studio keep.
      const field = document.querySelector('[role="dialog"] textarea');
      if (!(field instanceof HTMLTextAreaElement)) throw new Error("the Story Bible has no premise field");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }, premise);
    await page.evaluate(() => document.querySelector('[data-testid="save-story-bible"]')?.click());
    await waitFor(async () => !(await present('[data-testid="save-story-bible"]')), "the Story Bible to close after saving");
    let saved = "";
    await waitFor(async () => {
      saved = (await bookOnDisk(BOOK_TITLE)).meta.description;
      return saved === premise;
    }, "the premise to reach book.json");
    return "book.json carries the new premise";
  });

  await step("a TXT manuscript imports through the picker path", async () => {
    const back = await page.evaluate(() => {
      const button = document.querySelector('[aria-label="Back to library"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    });
    if (!back) throw new Error("the Back to library button was not found");
    await waitFor(() => present('[data-testid="import-manuscript"]'), "the manuscript import action");
    await page.evaluate(() => document.querySelector('[data-testid="import-manuscript"]')?.click());
    await waitFor(() => present('[data-testid="import-preview-dialog"]'), "the import preview");
    const preview = await page.evaluate(() => document.querySelector('[data-testid="import-preview-dialog"]')?.textContent ?? "");
    for (const expected of ["manuscript.txt", paragraphs[0]]) {
      if (!preview.includes(expected)) throw new Error(`the preview read ${JSON.stringify(preview.slice(0, 200))}`);
    }
    await page.evaluate((title) => {
      const field = document.querySelector('[data-testid="import-book-title"]');
      if (!(field instanceof HTMLInputElement)) throw new Error("the import title field was not found");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(field, title);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }, IMPORT_TITLE);
    await page.evaluate(() => document.querySelector('[data-testid="import-confirm"]')?.click());
    await waitFor(() => present('[data-testid="import-result-dialog"]'), "the import result");
    await page.evaluate(() => document.querySelector('[data-testid="import-result-close"]')?.click());
    await waitFor(
      () =>
        page.evaluate((title) =>
          [...document.querySelectorAll('[data-testid="book-card"]')].some((card) => (card.textContent ?? "").includes(title)),
        IMPORT_TITLE),
      "the imported book's card"
    );
    const book = await bookOnDisk(IMPORT_TITLE);
    const chapters = await chapterFiles(book.dir);
    const bodies = chapters.map((chapter) => chapter.text).join("\n");
    const missing = paragraphs.filter((paragraph) => !bodies.includes(paragraph));
    if (missing.length > 0) throw new Error(`the imported chapters lack ${JSON.stringify(missing[0])}`);
    if (sha256(await readFile(manuscriptPath)) !== manuscriptHash) throw new Error("the source manuscript changed");
    const files = chapters.length === 1 ? "1 chapter file carries" : `${chapters.length} chapter files carry`;
    return `${files} every paragraph under ${relative(book.dir)}; the source is unchanged`;
  });

  await step("the book exports to Word and Markdown", async () => {
    await page.evaluate((title) => {
      const card = [...document.querySelectorAll('[data-testid="book-card"]')].find((entry) => (entry.textContent ?? "").includes(title));
      if (!(card instanceof HTMLElement)) throw new Error(`the ${title} card was not found`);
      card.click();
    }, BOOK_TITLE);
    await waitFor(() => present('[data-testid="manuscript-text"]'), "the book's manuscript");
    await waitFor(() => enabled('[data-testid="export-docx"]'), "the Word export control");
    await page.evaluate(() => document.querySelector('[data-testid="export-docx"]')?.click());
    const docx = await waitForExport(".docx");
    // A DOCX is a zip; the prose is in word/document.xml.
    const unzipped = spawnSync("unzip", ["-p", docx, "word/document.xml"], { encoding: "utf8" });
    if (unzipped.status !== 0) throw new Error(`the Word file is not a readable zip: ${unzipped.stderr.trim()}`);
    if (!unzipped.stdout.includes(marker)) throw new Error("the Word file does not carry the typed line");
    // The Word export may still be finishing, and both controls stay disabled until it does.
    await waitFor(() => enabled('[data-testid="export-markdown"]'), "the Markdown export control");
    await page.evaluate(() => document.querySelector('[data-testid="export-markdown"]')?.click());
    const markdown = await waitForExport(".md");
    if (!(await readFile(markdown, "utf8")).includes(marker)) throw new Error("the Markdown file does not carry the typed line");
    return `${relative(docx)} and ${relative(markdown)} both carry the typed line`;
  });

  await step("the whole library exports as an archive", async () => {
    const back = await page.evaluate(() => {
      const button = document.querySelector('[aria-label="Back to library"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    });
    if (!back) throw new Error("the Back to library button was not found");
    await waitFor(() => enabled('[data-testid="export-archive"]'), "the archive export control");
    await page.evaluate(() => document.querySelector('[data-testid="export-archive"]')?.click());
    const archive = await waitForExport(".zip");
    // The library reports the export once the archive is complete, so the zip is read after that.
    await waitFor(() => page.evaluate(() => (document.body.textContent ?? "").includes("to library.zip")), "the archive export note");
    const listing = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8" });
    if (listing.status !== 0) throw new Error(`the archive is not a readable zip: ${listing.stderr.trim()}`);
    const entries = listing.stdout.split("\n").filter(Boolean);
    for (const title of [BOOK_TITLE, IMPORT_TITLE]) {
      const book = await bookOnDisk(title);
      const id = book.dir.split("/").pop();
      if (!entries.some((entry) => entry.includes(`${id}/book.json`))) throw new Error(`the archive lacks ${title}`);
    }
    return `${relative(archive)} holds ${entries.length} entries, both books included`;
  });

  await step("outbound connections are still refused after the journey", () => provedDenied());

  await step("no account, no connection and no renderer error along the way", async () => {
    if (accepted > 0) throw new Error(`the local listener accepted ${accepted} connection(s) from the sandboxed app`);
    if (existsSync(join(profile, "credentials.json"))) throw new Error("the run saved a provider credential");
    // A feature that quietly reached for the network would usually leave an error in the console.
    if (capture.errors.length > 0) throw new Error(`the renderer reported ${capture.errors.length} error(s): ${capture.errors[0]}`);
    return "no credential file in the profile, 0 connections at the local listener, 0 renderer errors";
  });
} catch (error) {
  failed = true;
  if (!results.some((result) => !result.ok)) {
    console.error(`[offline] The run crashed: ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  clearTimeout(hang);
  if (failed && capture) {
    try {
      const dir = await createRunDir("ai-book-studio-offline");
      const saved = await capture.save(dir, "offline-check");
      console.error(`[offline] artifacts: ${saved.screenshot} ${saved.consoleLog}${saved.trace ? ` ${saved.trace}` : ""}`);
    } catch (error) {
      console.error(`[offline] artifact capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    await capture?.discard();
  }
  await closeApp();
  listener.close();
  if (keep) console.log(`[offline] kept ${temp}`);
  else await rm(temp, { recursive: true, force: true }).catch(() => {});
}

const passed = results.filter((result) => result.ok).length;
console.log(`[offline] ${passed}/${results.length} checks passed`);
process.exit(failed || passed !== results.length ? 1 : 0);

async function step(name, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail });
    console.log(`[offline] ok   ${name} — ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`[offline] FAIL ${name} — ${detail}`);
    // Each step builds on the one before, so the journey stops at the first failure.
    throw error;
  }
}

/**
 * The denial must be in force, or the journey proves nothing. Node's sockets run in the app's main
 * process; `net.fetch` runs in Chromium's network service, a separate process the app starts.
 * 192.0.2.1 is TEST-NET-1 (RFC 5737), which is never routed, so no probe can reach a real host.
 */
async function provedDenied() {
  for (const [host, port] of [
    ["192.0.2.1", 80],
    ["127.0.0.1", loopbackPort]
  ]) {
    const outcome = await app.evaluate(
      async (_electron, target) => {
        const net = process.getBuiltinModule("node:net");
        return new Promise((done) => {
          const socket = net.connect({ host: target.host, port: target.port });
          const timer = setTimeout(() => {
            socket.destroy();
            done({ code: "TIMEOUT" });
          }, 5_000);
          socket.once("connect", () => {
            clearTimeout(timer);
            socket.destroy();
            done({ code: "CONNECTED" });
          });
          socket.once("error", (error) => {
            clearTimeout(timer);
            done({ code: error.code ?? error.message });
          });
        });
      },
      { host, port }
    );
    if (outcome.code !== "EPERM") throw new Error(`a socket to ${host}:${port} ended with ${outcome.code}, not EPERM`);
  }
  for (const url of ["http://192.0.2.1/", `http://127.0.0.1:${loopbackPort}/`]) {
    const outcome = await app.evaluate(async ({ net }, target) => {
      try {
        const response = await net.fetch(target, { signal: AbortSignal.timeout(5_000) });
        return `HTTP ${response.status}`;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, url);
    if (!outcome.includes("ERR_ACCESS_DENIED")) throw new Error(`net.fetch(${url}) ended with ${outcome}, not ERR_ACCESS_DENIED`);
  }
  return "EPERM from Node sockets and ERR_ACCESS_DENIED from the network service, to TEST-NET and to loopback";
}

async function present(selector) {
  return page.evaluate((target) => document.querySelector(target) !== null, selector);
}

async function enabled(selector) {
  return page.evaluate((target) => {
    const element = document.querySelector(target);
    return element instanceof HTMLButtonElement && !element.disabled;
  }, selector);
}

async function waitFor(predicate, what, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function bookOnDisk(title) {
  const books = join(libraryRoot, "books");
  for (const entry of await readdir(books, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const file = join(books, entry.name, "book.json");
    if (!existsSync(file)) continue;
    const meta = JSON.parse(await readFile(file, "utf8"));
    if (meta.title === title) return { dir: join(books, entry.name), meta };
  }
  throw new Error(`no book titled ${JSON.stringify(title)} on disk`);
}

async function chapterFiles(bookDir) {
  const folder = join(bookDir, "chapters");
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(join(folder, name), "utf8");
      const version = Number(/^version:\s*(\d+)\s*$/m.exec(text)?.[1] ?? Number.NaN);
      return { name, text, version };
    })
  );
}

async function waitForExport(extension) {
  let found = "";
  await waitFor(async () => {
    const name = (await readdir(exports)).find((entry) => entry.endsWith(extension));
    if (name) found = join(exports, name);
    return Boolean(name);
  }, `the ${extension} export`);
  return found;
}

async function closeApp() {
  if (!app) return;
  const child = app.process();
  await Promise.race([app.close().catch(() => {}), new Promise((done) => setTimeout(done, 10_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function relative(path) {
  return path.startsWith(`${temp}/`) ? path.slice(temp.length + 1) : path;
}
