#!/usr/bin/env node
/**
 * Proves that a second copy of the studio on the same profile is refused, and that the open copy
 * tells the author (spec 002 FR-069).
 *
 * Copy A is the built app, hidden, on a throwaway profile whose settings point at a synthetic
 * library. It runs the control plane with its locator in the temp folder (`STUDIO_BACKEND_FILE`)
 * rather than `~/.ai-book-studio`, and it opens the fixture book in its editor. Copy B is a second
 * launch with exactly A's environment: the same profile, the same library and the same locator path.
 * A copy that got past the single-instance lock would rewrite `studio.json`, rebuild the library
 * catalog, overwrite the locator and load a renderer, so each of those is checked.
 *
 * Hidden test runs claim the lock on their own `STUDIO_USER_DATA` profile, so B can only lose to A,
 * never to the author's real studio.
 *
 *   1. B exits on its own, with status 0, within the bound, and says why.
 *   2. B wrote nothing: against a snapshot taken once A's own writes have settled, every file in the
 *      library and the profile, and the locator, keeps its bytes, size, modification time and inode
 *      when B exits, and nothing was added or removed. Only A's GPU shader cache is left out.
 *   3. A shows the notice in its renderer, the notice can be dismissed, and A's one window stays hidden.
 *   4. A still writes: typing into the open chapter autosaves to disk afterwards.
 *   5. A copy on a different throwaway profile starts and opens its own library, and A hears nothing.
 *   6. With A's window closed, a refused copy makes A create its window again, still hidden, and the
 *      new window shows the notice. A blank window that is never shown keeps A running meanwhile,
 *      standing in for macOS, where the studio keeps running after its last window closes.
 *
 *   bun run build
 *   node scripts/second-instance-check.mjs
 *   node scripts/second-instance-check.mjs --keep   # keep the temporary profiles and libraries
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capturePage, createRunDir } from "./failure-artifacts.mjs";
import { headlessDesktopEnvironment, mockKeychainArgs } from "./headless-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = join(root, "apps", "desktop");
const appArgs = [...mockKeychainArgs(), appDir];
const builtMain = join(appDir, "out", "main", "index.cjs");
const keep = process.argv.includes("--keep");

if (!existsSync(builtMain)) {
  console.error("[instance] No build found. Run `bun run build` first.");
  process.exit(1);
}

const { _electron } = await import("playwright");
const electronPath = createRequire(join(appDir, "package.json"))("electron");

/** How long a refused copy may take to start, hand over and exit. */
const EXIT_BOUND_MS = 10_000;
/** When a copy that never exits is stopped, so a broken lock fails the run instead of hanging it. */
const EXIT_GIVE_UP_MS = 30_000;
/**
 * A keeps writing its profile for a while after it opens: Chromium first commits `Local State`,
 * `Preferences` and `Network Persistent State` about ten seconds after launch. B is judged against a
 * snapshot taken once nothing has changed for longer than that.
 */
const QUIET_MS = 12_000;
/**
 * Chromium's GPU shader caches: GraphiteDawnCache on macOS, GPUPersistentCache and GPUCache on Linux.
 * A rewrites them whenever it paints something new, such as the notice, with no second copy involved;
 * B quits before it has a window and paints nothing. They are left out of the comparison, and the run
 * says when they changed.
 */
const PAINT_CACHES = ["GraphiteDawnCache", "GPUPersistentCache", "GPUCache"];
const NOTICE = "Open Book Studio is already open. The second copy closed without opening your library.";
/** What the refused copy prints before it exits, and what the open copy prints when it hears of it. */
const REFUSED_LINE = "already open in another copy";
const HEARD_LINE = "second copy started with this profile";

const temp = await mkdtemp(join(tmpdir(), "ai-book-studio-instance-"));
const profile = join(temp, "profile");
const libraryRoot = join(temp, "library");
const locator = join(temp, "backend.json");
const otherProfile = join(temp, "other-profile");
const otherLibrary = join(temp, "other-library");

const BOOK = { id: "book_instance01", chapterId: "ch_instance0001", title: "One Writer" };
const OTHER_BOOK = { id: "book_instance02", chapterId: "ch_instance0002", title: "Another Profile" };
await seedLibrary(libraryRoot, BOOK, "The keeper wrote the tide table twice, once for each harbour.");
await seedLibrary(otherLibrary, OTHER_BOOK, "A second keeper kept a second light on another coast.");
await seedProfile(profile, libraryRoot);
await seedProfile(otherProfile, otherLibrary);

const envA = studioEnv(profile, { STUDIO_BACKEND: "1", STUDIO_BACKEND_FILE: locator });
const envOther = studioEnv(otherProfile);

const results = [];
let app = null;
let page = null;
let capture = null;
let second = null;
let other = null;
let failed = false;
const mainLog = [];

const hang = setTimeout(() => {
  console.error("[instance] Timed out after 240s; stopping the run.");
  second?.kill("SIGKILL");
  other?.process().kill("SIGKILL");
  app?.process().kill("SIGKILL");
}, 240_000);

try {
  app = await _electron.launch({ executablePath: electronPath, args: appArgs, cwd: appDir, env: envA, timeout: 60_000 });
  collectLines(app.process(), mainLog);
  page = await app.firstWindow();
  capture = await capturePage(page);
  console.log(`[instance] copy A is hidden on ${relativeToTemp(profile)} with ${relativeToTemp(libraryRoot)}`);

  let before = null;
  await step("copy A opens the book and settles", async () => {
    await waitFor(() => present('[data-testid="book-card"]'), "the fixture book's card");
    await page.evaluate(() => document.querySelector('[data-testid="book-card"]')?.click());
    await waitFor(() => present('[data-testid="manuscript-text"]'), "the chapter editor");
    const pid = app.process().pid;
    await waitFor(async () => existsSync(locator) && JSON.parse(await readFile(locator, "utf8")).pid === pid, "A's locator");
    const started = Date.now();
    before = await quietState();
    return `the chapter is open, the locator names A's process, and the files held still for ${QUIET_MS / 1000}s (after ${Math.round((Date.now() - started) / 1000)}s)`;
  }, { fatal: true });

  // The default notice dismisses itself after nine seconds, so the page keeps its own record.
  await page.evaluate((notice) => {
    const state = { appearances: 0, present: false, text: null };
    window.__secondInstanceNotice = state;
    const check = () => {
      const alert = [...document.querySelectorAll('[role="alert"]')].find((node) => (node.textContent ?? "").includes(notice));
      if (alert && !state.present) {
        state.appearances += 1;
        state.text ??= alert.textContent;
      }
      state.present = Boolean(alert);
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
    check();
  }, NOTICE);

  const heardBefore = count(mainLog, HEARD_LINE);
  // B can write nothing once it has exited, so the state it is judged on is read the moment it ends.
  let afterSecond = null;
  await step("a second copy on the same profile exits by itself and says why", async () => {
    const exit = await launchSecond();
    afterSecond = await state();
    const said = exit.output.join("\n");
    if (exit.killed) throw new Error(`copy B was still running after ${EXIT_GIVE_UP_MS / 1000}s and was stopped`);
    if (exit.code !== 0 || exit.signal) throw new Error(`copy B ended with ${exit.signal ?? `status ${exit.code}`}`);
    if (exit.ms > EXIT_BOUND_MS) throw new Error(`copy B took ${exit.ms} ms, over the ${EXIT_BOUND_MS} ms bound`);
    if (!said.includes(REFUSED_LINE)) throw new Error(`copy B did not say it was refused: ${JSON.stringify(said.slice(-400))}`);
    for (const started of ["[renderer", "[backend]", "[bridge]"]) {
      if (said.includes(started)) throw new Error(`copy B printed ${started}, so it started part of the studio`);
    }
    return `status 0 after ${exit.ms} ms (bound ${EXIT_BOUND_MS} ms), with "${REFUSED_LINE}" and no renderer or control-plane output`;
  });

  await step("the second copy wrote nothing to the library, the profile or the locator", async () => {
    if (!before || !afterSecond) throw new Error("there is no snapshot from before or after copy B");
    const painted = (change) => {
      const path = change.slice(change.indexOf(" ") + 1);
      return PAINT_CACHES.some((cache) => path.startsWith(`${cache}/`));
    };
    const profileChanges = diff(before.profile, afterSecond.profile);
    const changes = [
      ...diff(before.library, afterSecond.library).map((change) => `library: ${change}`),
      ...profileChanges.filter((change) => !painted(change)).map((change) => `profile: ${change}`),
      ...diff(before.locator, afterSecond.locator).map((change) => `locator: ${change}`)
    ];
    if (changes.length > 0) throw new Error(`${changes.length} change(s): ${changes.slice(0, 12).join("; ")}`);
    const repainted = profileChanges.filter(painted).length;
    const cache = repainted > 0 ? `; A's GPU caches changed in ${repainted} place(s) as it painted, and are left out` : "; the GPU caches unchanged too";
    return `${before.library.size} library entries, ${before.profile.size} profile entries and the locator unchanged (bytes, size, mtime, inode)${cache}`;
  });

  await step("copy A shows the notice, which can be dismissed, and its window stays hidden", async () => {
    await waitFor(() => page.evaluate(() => window.__secondInstanceNotice.appearances > 0), "the notice in A", 8_000);
    const seen = await page.evaluate(() => window.__secondInstanceNotice);
    if (!seen.text?.includes(NOTICE)) throw new Error(`the notice read ${JSON.stringify(seen.text)}`);
    const dismissed = await page.evaluate((notice) => {
      const alert = [...document.querySelectorAll('[role="alert"]')].find((node) => (node.textContent ?? "").includes(notice));
      const button = alert?.querySelector('button[aria-label="Dismiss"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    }, NOTICE);
    if (!dismissed) throw new Error("the notice had already gone before Dismiss could be clicked; rerun once");
    await waitFor(() => page.evaluate(() => !window.__secondInstanceNotice.present), "the notice to close", 5_000);
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()));
    if (windows.length !== 1 || windows[0]) throw new Error(`A has ${windows.length} window(s), visible: ${JSON.stringify(windows)}`);
    const heard = count(mainLog, HEARD_LINE) - heardBefore;
    if (heard !== 1) throw new Error(`A's main process logged the second copy ${heard} times, not once`);
    return `"${NOTICE}" shown once, dismissed, 1 window, never visible`;
  });

  await step("copy A still writes the library after the refusal", async () => {
    const [chapter] = await chapterFiles(libraryRoot, BOOK.id);
    const marker = `Written after a second copy was refused ${Date.now()}`;
    await page.evaluate((text) => {
      const editor = document.querySelector('[data-testid="manuscript-text"]');
      if (!editor) throw new Error("the manuscript editor was not found");
      editor.value = `${editor.value}\n\n${text}`;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }, marker);
    let saved = chapter;
    await waitFor(async () => {
      [saved] = await chapterFiles(libraryRoot, BOOK.id);
      return saved?.text.includes(marker) ?? false;
    }, "the autosave to reach the chapter file");
    if (saved.version <= chapter.version) throw new Error(`the version did not move (${chapter.version} → ${saved.version})`);
    return `chapters/${saved.name} holds the typed line, version ${chapter.version} → ${saved.version}`;
  });

  await step("a copy on a different profile is not refused, and copy A hears nothing of it", async () => {
    const heard = count(mainLog, HEARD_LINE);
    const appearances = await page.evaluate(() => window.__secondInstanceNotice.appearances);
  other = await _electron.launch({ executablePath: electronPath, args: appArgs, cwd: appDir, env: envOther, timeout: 60_000 });
    const otherPage = await other.firstWindow();
    await waitFor(
      () =>
        otherPage.evaluate((title) =>
          [...document.querySelectorAll('[data-testid="book-card"]')].some((card) => (card.textContent ?? "").includes(title)),
        OTHER_BOOK.title),
      "the other profile's book card"
    );
    // Give a misdirected refusal time to arrive before saying none did.
    await new Promise((done) => setTimeout(done, 1_500));
    if (count(mainLog, HEARD_LINE) !== heard) throw new Error("A heard of the copy on the other profile");
    if ((await page.evaluate(() => window.__secondInstanceNotice.appearances)) !== appearances) {
      throw new Error("A showed the notice again for a copy on the other profile");
    }
    await closeElectron(other);
    other = null;
    return `the other copy opened ${OTHER_BOOK.title} from its own library; A logged and showed nothing new`;
  });

  await step("with A's window closed, a refused copy brings a window back, hidden, with the notice", async () => {
    // On macOS the studio keeps running with no window. A hidden run quits when its last window
    // closes, so a blank window that is never shown keeps A running in its place.
    const keeper = await app.evaluate(({ BrowserWindow }) => new BrowserWindow({ show: false, x: -16_000, y: -16_000 }).id);
    const closed = page.waitForEvent("close", { timeout: 20_000 });
    await app.evaluate(({ BrowserWindow }, keep) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.id !== keep) window.close();
    }, keeper);
    await closed;
    const heard = count(mainLog, HEARD_LINE);
    const exit = await launchSecond();
    if (exit.killed || exit.code !== 0 || exit.signal) throw new Error(`copy B ended with ${exit.killed ? "a kill" : exit.signal ?? `status ${exit.code}`}`);
    // Every open page is asked, the blank one included, so no window event has to be caught in time.
    await waitFor(async () => {
      for (const candidate of app.windows()) {
        if (candidate.isClosed()) continue;
        const shown = await candidate
          .evaluate(
            (notice) => [...document.querySelectorAll('[role="alert"]')].some((node) => (node.textContent ?? "").includes(notice)),
            NOTICE
          )
          .catch(() => false);
        if (shown) return true;
      }
      return false;
    }, "the notice in the new window");
    const windows = await app.evaluate(({ BrowserWindow }, keep) =>
      BrowserWindow.getAllWindows().map((window) => ({ keeper: window.id === keep, visible: window.isVisible() })),
    keeper);
    const studioWindows = windows.filter((window) => !window.keeper);
    if (studioWindows.length !== 1 || windows.some((window) => window.visible)) {
      throw new Error(`A has ${studioWindows.length} studio window(s); visible: ${JSON.stringify(windows)}`);
    }
    if (count(mainLog, HEARD_LINE) - heard !== 1) throw new Error("A's main process did not log this refusal once");
    await app.evaluate(({ BrowserWindow }, keep) => BrowserWindow.fromId(keep)?.destroy(), keeper);
    return `copy B exited with status 0 after ${exit.ms} ms; A made 1 new window, never visible, and it shows the notice`;
  });
} catch (error) {
  failed = true;
  if (!results.some((result) => !result.ok)) {
    console.error(`[instance] The run crashed: ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  clearTimeout(hang);
  const anyFailed = failed || results.some((result) => !result.ok);
  if (anyFailed && capture) {
    try {
      const dir = await createRunDir("ai-book-studio-instance");
      const saved = await capture.save(dir, "second-instance-check");
      console.error(`[instance] artifacts: ${saved.screenshot} ${saved.consoleLog}${saved.trace ? ` ${saved.trace}` : ""}`);
    } catch (error) {
      console.error(`[instance] artifact capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    await capture?.discard();
  }
  if (second && second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
  if (other) await closeElectron(other);
  if (app) await closeElectron(app);
  if (keep) console.log(`[instance] kept ${temp}`);
  else await rm(temp, { recursive: true, force: true }).catch(() => {});
}

const passed = results.filter((result) => result.ok).length;
console.log(`[instance] ${passed}/${results.length} checks passed`);
process.exit(failed || passed !== results.length ? 1 : 0);

/** Run one check. A failure is reported and the run moves on, unless later checks need this one. */
async function step(name, run, { fatal = false } = {}) {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail });
    console.log(`[instance] ok   ${name} — ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`[instance] FAIL ${name} — ${detail}`);
    if (fatal) throw error;
  }
}

/** Start copy B with A's environment and wait for it to end, or stop it once it has clearly stayed. */
function launchSecond() {
  return new Promise((done) => {
    const started = Date.now();
    const output = [];
    second = spawn(electronPath, appArgs, { cwd: appDir, env: envA, stdio: ["ignore", "pipe", "pipe"] });
    collectLines(second, output);
    let killed = false;
    const giveUp = setTimeout(() => {
      killed = true;
      second.kill("SIGKILL");
    }, EXIT_GIVE_UP_MS);
    second.once("exit", (code, signal) => {
      clearTimeout(giveUp);
      done({ code, signal, killed, ms: Date.now() - started, output });
    });
  });
}

function studioEnv(userData, extra = {}) {
  return { ...headlessDesktopEnvironment(process.env, userData), ...extra };
}

async function seedProfile(folder, library) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "studio.json"), `${JSON.stringify({ libraryRoot: library }, null, 2)}\n`);
}

async function seedLibrary(folder, book, line) {
  const now = new Date().toISOString();
  const bookDir = join(folder, "books", book.id);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(
    join(bookDir, "book.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: book.id,
        title: book.title,
        description: "A synthetic fixture for the second-copy check.",
        stage: "drafting",
        createdAt: now,
        updatedAt: now
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(bookDir, "chapters", "0001-the-tide.md"),
    `---\nid: ${book.chapterId}\ntitle: The Tide\norder: 1\nversion: 1\ncreatedAt: ${now}\nupdatedAt: ${now}\n---\n\n${line}\n`
  );
}

/** Wait until the library, profile and locator hold still for `QUIET_MS`, and return that state. */
async function quietState(timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let previous = await state();
  let stillSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 1_000));
    const current = await state();
    const changes = [...diff(previous.library, current.library), ...diff(previous.profile, current.profile), ...diff(previous.locator, current.locator)];
    if (changes.length > 0) stillSince = Date.now();
    else if (Date.now() - stillSince >= QUIET_MS) return current;
    previous = current;
  }
  throw new Error(`the files never held still for ${QUIET_MS / 1000}s within ${timeout / 1000}s`);
}

async function state() {
  return {
    library: await snapshot(libraryRoot),
    profile: await snapshot(profile),
    locator: await snapshot(temp, (path) => path === "backend.json")
  };
}

/**
 * Every entry under a folder: files by size, modification time, inode and SHA-256, links by their
 * target, folders by presence. `only` narrows it to named entries.
 */
async function snapshot(folder, only = () => true) {
  const entries = new Map();
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = join(current, entry.name);
      const name = relative(folder, path);
      if (!only(name)) continue;
      const stats = await lstat(path).catch(() => null);
      if (!stats) continue;
      if (stats.isSymbolicLink()) entries.set(name, `link ${await readlink(path).catch(() => "?")}`);
      else if (stats.isDirectory()) {
        entries.set(name, "folder");
        await walk(path);
      } else if (stats.isFile()) {
        const bytes = await readFile(path).catch(() => null);
        entries.set(name, `file ${stats.size} ${stats.mtimeMs} ${stats.ino} ${bytes ? sha256(bytes) : "unreadable"}`);
      } else entries.set(name, `other ${stats.mode}`);
    }
  }
  await walk(folder);
  return entries;
}

function diff(before, after) {
  const changes = [];
  for (const [path, value] of before) {
    if (!after.has(path)) changes.push(`removed ${path}`);
    else if (after.get(path) !== value) changes.push(`changed ${path}`);
  }
  for (const path of after.keys()) if (!before.has(path)) changes.push(`added ${path}`);
  return changes;
}

async function chapterFiles(library, bookId) {
  const folder = join(library, "books", bookId, "chapters");
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(join(folder, name), "utf8");
      const version = Number(/^version:\s*(\d+)\s*$/m.exec(text)?.[1] ?? Number.NaN);
      return { name, text, version };
    })
  );
}

function collectLines(child, lines) {
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream?.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      lines.push(...parts);
    });
    stream?.on("end", () => {
      if (pending) lines.push(pending);
    });
  }
}

function count(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

async function present(selector) {
  return page.evaluate((target) => document.querySelector(target) !== null, selector);
}

async function waitFor(predicate, what, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function closeElectron(electronApp) {
  const child = electronApp.process();
  await Promise.race([electronApp.close().catch(() => {}), new Promise((done) => setTimeout(done, 10_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function relativeToTemp(path) {
  return path.startsWith(`${temp}/`) ? path.slice(temp.length + 1) : path;
}
