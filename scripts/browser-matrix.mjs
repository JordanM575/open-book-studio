#!/usr/bin/env node
/**
 * Run the real-browser storage harness in isolated Playwright engines.
 *
 *   node scripts/browser-matrix.mjs
 *
 * Builds `apps/web/check`, serves it over localhost, runs the OPFS/conflict/archive/IndexedDB checks
 * in a headless browser and exits non-zero on any failure or page error. No author profile or library
 * is used; the page creates and removes temporary browser libraries.
 */
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { capturePage, createRunDir, redactLine } from "./failure-artifacts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkDir = join(root, "apps", "web", "check");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const build = spawnSync("bun", ["--filter", "@ai-book-studio/web", "build:check"], {
  cwd: root,
  stdio: "inherit"
});
if (build.status !== 0) process.exit(build.status ?? 1);

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = resolve(checkDir, relative);
  if (!file.startsWith(checkDir) || !existsSync(file)) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;

const engines = [
  ["Chromium", chromium],
  ["Firefox", firefox],
  ["WebKit", webkit]
];
let allPassed = true;
let chromiumPassed = true;
const strict = process.argv.includes("--strict");

async function openContext(name, engine) {
  if (name === "WebKit") {
    // WebKit's temporary contexts refuse OPFS at getDirectory. Use a fresh, owned profile.
    const profile = await mkdtemp(join(tmpdir(), "studio-matrix-webkit-"));
    try {
      const context = await engine.launchPersistentContext(profile, { headless: true });
      return {
        context,
        async close() {
          await context.close();
          await rm(profile, { recursive: true });
        }
      };
    } catch (error) {
      // A launch timeout can reject before Playwright's child finishes shutdown.
      console.error(`[matrix] WebKit launch left the disposable profile at ${profile} for cleanup after exit.`);
      throw error;
    }
  }
  const browser = await engine.launch({ headless: true });
  try {
    return { context: await browser.newContext(), close: () => browser.close() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function saveFailureArtifacts(name, capture) {
  try {
    const artifacts = await capture.save(await createRunDir("matrix"), `matrix-${name.toLowerCase()}`);
    console.error(
      `[matrix] artifacts: ${artifacts.screenshot}${artifacts.trace ? ` ${artifacts.trace}` : ""} ${artifacts.consoleLog}`
    );
  } catch (error) {
    console.error(`[matrix] ${name} failure artifacts could not be saved: ${redactLine(error instanceof Error ? error.message : error)}`);
  }
}

const twoTabCheckName = "two tabs serialize requests with Web Locks";

async function queueTabLock(page, name, hold) {
  await page.evaluate(({ name, hold }) => {
    let release = () => {};
    const gate = hold ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
    const state = { entries: 0, completed: false, error: null, release };
    window.browserMatrixLockState = state;
    void window.browserMatrixWebLock(name, async () => {
      state.entries += 1;
      await gate;
    }).then(
      () => { state.completed = true; },
      (error) => { state.error = error instanceof Error ? error.message : String(error); }
    );
  }, { name, hold });
}

async function checkTwoTabLocks(page, peer) {
  const tabs = [page, peer];
  const key = "check:two-tabs";
  const wait = { polling: 50, timeout: 5_000 };
  try {
    const supported = await Promise.all(tabs.map((tab) => tab.evaluate(() =>
      typeof navigator.locks?.query === "function" && typeof window.browserMatrixWebLock === "function"
    )));
    if (!supported.every(Boolean)) throw new Error("Both tabs must expose Web Locks and the fixture adapter.");

    await queueTabLock(page, key, true);
    await page.waitForFunction(() => window.browserMatrixLockState.entries === 1, null, wait);
    await queueTabLock(peer, key, false);
    await page.waitForFunction(async (name) => {
      const { held, pending } = await navigator.locks.query();
      return held.some((lock) => lock.name === name && lock.mode === "exclusive") &&
        pending.some((lock) => lock.name === name && lock.mode === "exclusive");
    }, `ai-book-studio:${key}`, wait);

    const peerWaiting = await peer.evaluate(() => {
      const state = window.browserMatrixLockState;
      return state.entries === 0 && !state.completed && state.error === null;
    });
    if (!peerWaiting) throw new Error("The second tab entered while the first held the lock.");

    await page.evaluate(() => window.browserMatrixLockState.release());
    for (const tab of tabs) {
      await tab.waitForFunction(() => {
        const state = window.browserMatrixLockState;
        return state.completed || state.error !== null;
      }, null, wait);
      const state = await tab.evaluate(() => {
        const { entries, completed, error } = window.browserMatrixLockState;
        return { entries, completed, error };
      });
      if (state.error !== null) throw new Error(state.error);
      if (!state.completed || state.entries !== 1) throw new Error("Each tab must complete the lock callback once.");
    }
    return { name: twoTabCheckName, ok: true, detail: "second tab waited for the first to release the lock" };
  } catch (error) {
    return { name: twoTabCheckName, ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await page.evaluate(() => window.browserMatrixLockState?.release()).catch(() => {});
  }
}

async function checkEngine(name, context) {
  const page = context.pages()[0] ?? await context.newPage();
  const capture = await capturePage(page);
  const errors = capture.errors;

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.dataset.complete === "true", null, { timeout: 60_000 });

    const checks = await page.$$eval("#checks li", (items) =>
      items.map((item) => ({
        name: item.querySelector("strong")?.textContent ?? "check",
        detail: item.querySelector("span")?.textContent ?? "",
        ok: item.classList.contains("pass")
      }))
    );
    for (const check of checks) {
      console.log(`[matrix] ${name} ${check.ok ? "ok  " : "FAIL"} ${check.name} — ${check.detail}`);
    }

    const originCheck = checks.find((check) => check.name.includes("origin storage opens"));
    let restartCheck;
    let twoTabCheck = {
      name: twoTabCheckName,
      detail: "skipped: second fixture page unavailable",
      ok: false
    };
    if (originCheck && !originCheck.ok) {
      restartCheck = {
        name: "OPFS survives a page restart",
        detail: "skipped: origin storage unavailable",
        ok: false
      };
    } else {
      const restartPage = await context.newPage();
      const restartCapture = await capturePage(restartPage);
      try {
        await restartPage.goto(`http://127.0.0.1:${port}/restart.html`, { waitUntil: "domcontentloaded" });
        try {
          await restartPage.waitForFunction(() => document.body.dataset.complete === "true", null, {
            timeout: 60_000
          });
        } catch {
          await restartPage.waitForTimeout(250);
          await restartPage.waitForFunction(() => document.body.dataset.complete === "true", null, {
            timeout: 60_000
          });
        }
        const found = await restartPage.$$eval("#checks li", (items) =>
          items.map((item) => ({
            name: item.querySelector("strong")?.textContent ?? "check",
            detail: item.querySelector("span")?.textContent ?? "",
            ok: item.classList.contains("pass")
          }))
        );
        restartCheck = found[0];
        if (!restartCheck) throw new Error("The restart page produced no check.");
        twoTabCheck = await checkTwoTabLocks(page, restartPage);
      } catch (error) {
        restartCheck = {
          name: "OPFS survives a page restart",
          detail: error instanceof Error ? error.message : String(error),
          ok: false
        };
      } finally {
        for (const error of restartCapture.errors) errors.push(error);
        await restartCapture.discard();
        await restartPage.close();
      }
    }
    checks.push(restartCheck, twoTabCheck);
    for (const check of [restartCheck, twoTabCheck]) {
      console.log(`[matrix] ${name} ${check.ok ? "ok  " : "FAIL"} ${check.name} — ${check.detail}`);
    }

    if (errors.length > 0) {
      for (const error of errors) console.error(`[matrix] ${name} page error: ${error}`);
    }
    const passed = checks.filter((check) => check.ok).length;
    const result = await page.evaluate(() => document.body.dataset.result);
    const ok = result === "pass" && errors.length === 0 && checks.every((check) => check.ok);
    console.log(`[matrix] ${name} ${passed}/${checks.length} checks passed${ok ? "" : " (finding)"}`);
    if (!ok) {
      await saveFailureArtifacts(name, capture);
    } else {
      await capture.discard();
    }
    return ok;
  } catch (error) {
    await saveFailureArtifacts(name, capture);
    throw error;
  }
}

try {
  for (const [name, engine] of engines) {
    let ok = false;
    try {
      const owned = await openContext(name, engine);
      try {
        ok = await checkEngine(name, owned.context);
      } finally {
        await owned.close();
      }
    } catch (error) {
      ok = false;
      console.error(`[matrix] ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    allPassed &&= ok;
    if (name === "Chromium") chromiumPassed = ok;
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log(`[matrix] ${strict ? "strict: all engines required" : "Chromium is the required gate; other engines are findings"}`);
process.exitCode = (strict ? allPassed : chromiumPassed) ? 0 : 1;
