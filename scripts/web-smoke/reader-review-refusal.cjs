const assert = require("node:assert/strict");
const { existsSync, lstatSync, readdirSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const scenario = "reader-review-refusal";
const copy = "Reader review is unavailable on this host. No source preparation or provider request can start.";
const checks = [
  "isolated web build", "welcome API refusal", "browser storage and workspace",
  "storage observer calibration", "workspace keyboard refusal", "unchanged library", "guarded window teardown"
];
const counterNames = ["bookReads", "handleReads", "fileReads", "storageReads", "writes", "permissions", "providers", "requests"];
const workspaceStages = {
  baseline: "capture the workspace baseline",
  open: "activate Open reader review by keyboard",
  panel: "verify the unsupported panel and controls",
  heading: "verify focus on the unsupported heading",
  close: "activate Close review by keyboard",
  opener: "verify the panel closed and focus returned",
  counters: "verify zero workspace side effects",
  adapter: "verify the original reader API"
};
const digest = /^[a-f0-9]{64}$/;

function privateDirectory(path) {
  const info = lstatSync(path);
  assert(info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700);
  assert.equal(realpathSync(path), path);
}

function admit({ app, env, profile, resultPath, url }) {
  assert(!app.isPackaged && env.WEB_SMOKE_SCENARIO === scenario);
  assert.match(env.WEB_SMOKE_COMMIT, /^[a-f0-9]{40}$/);
  const origin = new URL(url);
  assert(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.port && url === origin.origin + "/");
  const scratch = dirname(profile);
  assert(basename(profile) === "profile" && basename(scratch).startsWith("ai-book-studio-web-smoke-"));
  assert.equal(dirname(scratch), realpathSync(tmpdir()));
  assert.equal(resultPath, join(scratch, "result.json"));
  privateDirectory(scratch);
  privateDirectory(profile);
  assert.deepEqual(readdirSync(profile), []);
  assert(!existsSync(resultPath));
}

function quiet(counters) {
  return counterNames.every((name) => counters?.[name] === 0);
}

function projectChecks(result, commit) {
  assert(result?.scenario === scenario && typeof result.ok === "boolean");
  assert(Array.isArray(result.checks) && result.checks.length > 0 && result.checks.length <= checks.length);
  if (result.ok || result.target !== null || result.commit !== null) {
    assert(result.target === "web" && result.commit === commit);
  }
  const names = new Set();
  return result.checks.map((check) => {
    assert(checks.includes(check.name) && !names.has(check.name) && typeof check.ok === "boolean");
    names.add(check.name);
    const projected = { name: check.name, ok: check.ok };
    if (check.phase !== undefined) {
      assert(check.name === checks[4] && !check.ok && Object.values(workspaceStages).includes(check.phase));
      projected.phase = check.phase;
      if (check.nonzeroCounters !== undefined) {
        const counters = check.nonzeroCounters;
        assert(check.phase === workspaceStages.counters && Array.isArray(counters) && counters.length > 0 &&
          new Set(counters).size === counters.length && counters.every((name) => counterNames.includes(name)));
        projected.nonzeroCounters = counters;
      }
    }
    return projected;
  });
}

function validateReceipt(result, commit) {
  const projected = projectChecks(result, commit);
  assert(result.ok === true);
  assert.deepEqual(projected, checks.map((name) => ({ name, ok: true })));
  assert(quiet(result.welcome) && quiet(result.workspace));
  assert.equal(result.calibration.bookReads, 1);
  for (const name of ["handleReads", "fileReads"]) {
    assert(Number.isSafeInteger(result.calibration[name]) && result.calibration[name] > 0);
  }
  assert.match(result.library.before, digest);
  assert.equal(result.library.after, result.library.before);
  assert.match(result.library.chapterHash, digest);
  assert.equal(result.library.chapterVersion, 2);
  assert(Number.isSafeInteger(result.library.files) && result.library.files > 0);
  assert.equal(result.library.commitTimePreserved, true);
  assert.equal(result.externalAttempts, 0);
  assert.equal(result.consoleErrors, 0);
  const counters = (value) => Object.fromEntries(counterNames.map((name) => [name, value[name]]));
  return {
    scenario, target: "web", commit, ok: true, checks: projected,
    welcome: counters(result.welcome), workspace: counters(result.workspace),
    calibration: { bookReads: 1, handleReads: result.calibration.handleReads, fileReads: result.calibration.fileReads },
    library: {
      before: result.library.before, after: result.library.after, files: result.library.files,
      chapterHash: result.library.chapterHash, chapterVersion: 2, commitTimePreserved: true
    },
    externalAttempts: 0, consoleErrors: 0
  };
}

// Run in the page after storage restoration. Wrap the actual port's prototypes, including handles
// it already holds. Browser setup and fingerprinting run outside the two reader intervals.
function observeStorage() {
  const counts = { bookReads: 0, handleReads: 0, fileReads: 0, storageReads: 0, writes: 0, permissions: 0, providers: 0, requests: 0 };
  const reader = window.studio.readerReview;
  const readerMethods = Object.entries(reader);
  function wrap(target, key, group, required = true) {
    const original = target?.[key];
    if (typeof original !== "function") {
      if (required) throw new Error("Missing web storage observer target");
      return;
    }
    const observe = function (...args) {
      counts[typeof group === "function" ? group(args) : group]++;
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(target, key, { configurable: true, writable: true, value: observe });
    if (target[key] !== observe) throw new Error("The web storage observer was not installed");
  }
  wrap(window.studio.books, "open", "bookReads");
  const directory = globalThis.FileSystemDirectoryHandle?.prototype;
  for (const method of ["getDirectoryHandle", "getFileHandle"]) {
    wrap(directory, method, (args) => args[1]?.create ? "writes" : "handleReads");
  }
  for (const method of ["entries", "keys", "values", Symbol.asyncIterator]) wrap(directory, method, "handleReads");
  wrap(directory, "removeEntry", "writes");
  const file = globalThis.FileSystemFileHandle?.prototype;
  wrap(file, "getFile", "fileReads");
  wrap(file, "createWritable", "writes");
  const writable = globalThis.FileSystemWritableFileStream?.prototype;
  for (const method of ["write", "truncate", "close"]) wrap(writable, method, "writes");
  wrap(navigator.storage, "getDirectory", "storageReads");
  wrap(navigator.storage, "persist", "permissions");
  for (const method of ["persisted", "estimate"]) wrap(navigator.storage, method, "storageReads");
  const idb = globalThis.IDBFactory?.prototype;
  wrap(idb, "open", "storageReads");
  wrap(idb, "deleteDatabase", "writes");
  wrap(globalThis.IDBDatabase?.prototype, "transaction", (args) => args[1] === "readwrite" ? "writes" : "storageReads");
  const store = globalThis.IDBObjectStore?.prototype;
  for (const method of ["add", "put", "delete", "clear"]) wrap(store, method, "writes");
  for (const method of ["get", "getAll", "openCursor"]) wrap(store, method, "storageReads");
  for (const method of ["update", "delete"]) wrap(globalThis.IDBCursor?.prototype, method, "writes");
  wrap(globalThis.Storage?.prototype, "getItem", "storageReads");
  for (const method of ["setItem", "removeItem", "clear"]) wrap(globalThis.Storage?.prototype, method, "writes");
  wrap(globalThis.Permissions?.prototype, "query", "permissions");
  for (const method of ["queryPermission", "requestPermission"]) {
    wrap(globalThis.FileSystemHandle?.prototype, method, "permissions", false);
  }
  for (const method of ["showDirectoryPicker", "showOpenFilePicker", "showSaveFilePicker"]) wrap(window, method, "permissions", false);
  for (const method of Object.keys(window.studio.providers)) wrap(window.studio.providers, method, "providers");
  wrap(window, "fetch", "requests");
  wrap(globalThis.XMLHttpRequest?.prototype, "send", "requests");
  wrap(navigator, "sendBeacon", "requests");
  Object.defineProperty(window, Symbol.for("studio.web-reader-check"), {
    value: Object.freeze({
      snapshot: () => ({ ...counts }),
      readerUnchanged: () => window.studio.readerReview === reader && readerMethods.every(([key, method]) => reader[key] === method)
    })
  });
}

async function fingerprintLibrary() {
  const root = await navigator.storage.getDirectory();
  const entries = [];
  async function sha(bytes) {
    const result = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(result)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  async function walk(directory, prefix) {
    for await (const [name, handle] of directory.entries()) {
      const path = prefix + name;
      if (handle.kind === "directory") await walk(handle, path + "/");
      else if (handle.kind === "file") entries.push([path, await sha(await (await handle.getFile()).arrayBuffer())]);
      else throw new Error("Unexpected web library entry");
    }
  }
  await walk(root, "");
  entries.sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1);
  return { files: entries.length, hash: await sha(new TextEncoder().encode(JSON.stringify(entries))) };
}

function observeWindow(contents, origin) {
  const counts = { requests: 0, permissions: 0, external: 0, consoleErrors: 0 };
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    counts.requests++;
    const target = new URL(details.url);
    const allowed = target.origin === origin && ["GET", "HEAD"].includes(details.method);
    if (!allowed) counts.external++;
    callback({ cancel: !allowed });
  });
  contents.session.setPermissionCheckHandler(() => { counts.permissions++; return false; });
  contents.session.setPermissionRequestHandler((_contents, _permission, reply) => { counts.permissions++; reply(false); });
  contents.setWindowOpenHandler(() => {
    counts.external++;
    return { action: "deny" };
  });
  contents.on("console-message", (event) => { if (event.level === "error") counts.consoleErrors++; });
  return counts;
}

async function run({ window, app, url, profile, commit }) {
  const contents = window.webContents;
  const result = { scenario, ok: false, target: null, commit: null, checks: [], welcome: null, workspace: null,
    calibration: null, library: null, externalAttempts: null, consoleErrors: null };
  let workspaceStage = workspaceStages.baseline;
  let nonzeroCounters;
  const web = observeWindow(contents, new URL(url).origin);
  const evaluate = (fn, arg) => contents.executeJavaScript("(" + fn.toString() + ")(" + JSON.stringify(arg) + ")");
  async function waitFor(fn, arg) {
    const deadline = Date.now() + 10_000;
    do {
      if (await evaluate(fn, arg)) return;
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error("Expected web control did not appear");
  }
  async function snapshot() {
    const observed = await evaluate(() => window[Symbol.for("studio.web-reader-check")].snapshot());
    return { ...observed, permissions: observed.permissions + web.permissions, requests: observed.requests + web.requests };
  }
  async function since(initial, accounted = {}) {
    const final = await snapshot();
    return Object.fromEntries(counterNames.map((name) => [name, final[name] - initial[name] - (accounted[name] ?? 0)]));
  }
  async function step(check, run) {
    try {
      await run();
      result.checks.push({ name: check, ok: true });
    } catch (error) {
      const failed = { name: check, ok: false };
      if (check === checks[4]) {
        failed.phase = workspaceStage;
        if (nonzeroCounters?.length) failed.nonzeroCounters = nonzeroCounters;
      }
      result.checks.push(failed);
      throw error;
    }
  }
  async function keypress(key, code) {
    const event = { key, code: key, windowsVirtualKeyCode: code };
    const down = key === "Enter" ? { type: "keyDown", text: "\r", unmodifiedText: "\r" } : { type: "rawKeyDown" };
    await contents.debugger.sendCommand("Input.dispatchKeyEvent", { ...down, ...event });
    await contents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  }
  async function keyboardButton(name) {
    for (let attempt = 0; attempt < 90; attempt++) {
      const matches = await evaluate((text) =>
        document.activeElement?.matches("button:not(:disabled)") && document.activeElement.textContent.trim() === text, name);
      if (matches) {
        await keypress("Enter", 13);
        return;
      }
      await keypress("Tab", 9);
    }
    throw new Error("Web reader control was not reachable by keyboard");
  }

  let fixture;
  let before;
  let readbackCounts;
  let workspaceStart;
  let nativeStart;
  async function readback() {
    const library = await evaluate(fingerprintLibrary);
    const chapter = await evaluate(async ({ bookId, chapterId }) => {
      const opened = await window.studio.books.open(bookId);
      const selected = await window.studio.library.current();
      if (!opened.ok || !selected.ok || selected.data.storage?.tier !== "browser") {
        throw new Error("Could not verify saved web fixture");
      }
      const saved = opened.data.chapters.find((item) => item.id === chapterId);
      return { hash: saved?.hash, version: saved?.version, committedAt: selected.data.storage.lastCommittedAt };
    }, fixture);
    return { files: library.files, libraryHash: library.hash, ...chapter };
  }
  try {
    await step(checks[0], async () => {
      assert.equal(app.getPath("userData"), profile);
      assert(!window.isVisible());
      await window.loadURL(url);
      await waitFor(() => document.querySelector("[data-testid=web-welcome]") && Boolean(window.studio?.readerReview));
      assert(await evaluate(() => typeof process === "undefined" && typeof require === "undefined"));
      const info = await evaluate(() => window.studio.app.info());
      assert(info.ok && info.data.target === "web" && info.data.commit === commit);
      result.target = info.data.target;
      result.commit = info.data.commit;
      await evaluate(observeStorage);
    });
    await step(checks[1], async () => {
      const initial = await snapshot();
      assert(await evaluate(async (copy) => {
        const api = window.studio.readerReview;
        const support = await api.support();
        if (!support.ok || support.data.supported !== false || support.data.reason !== "unsupported-host") return false;
        const prepareId = "web-reader-039";
        const start = { requestId: "review-web-reader-039", scopeDigest: "a".repeat(64) };
        const outcomes = await Promise.all([
          api.prepare({ prepareId, bookId: "book_webreader039", profileId: "reader-alpha", prompt: "",
            chapters: [{ chapterId: "ch_webreader039", ranges: [{ start: 0, end: 1 }] }] }),
          api.start(start), api.stop({ requestId: start.requestId }), api.cancelPrepare({ prepareId })
        ]);
        return outcomes.every((item) => item.ok === false && item.error.code === "unsupported" && item.error.message === copy);
      }, copy));
      result.welcome = await since(initial);
      assert(quiet(result.welcome));
      assert(await evaluate(() => window[Symbol.for("studio.web-reader-check")].readerUnchanged()));
    });
    await step(checks[2], async () => {
      await evaluate(() => document.querySelector("[data-testid=use-browser-storage]").click());
      await waitFor(() => Boolean(document.querySelector("[data-testid=library-view]")));
      const created = await evaluate(async () => {
        const data = (result) => { if (!result.ok) throw new Error("Web fixture setup failed"); return result.data; };
        const book = data(await window.studio.books.create({ title: "Web reader fixture", description: "Synthetic browser storage check" }));
        const chapter = data(await window.studio.chapters.create(book.id, { title: "Arrival" }));
        return { bookId: book.id, chapterId: chapter.id, version: chapter.version, hash: chapter.hash };
      });
      // Reload first so the confirmed commit time is set in the measured session.
      await window.loadURL(url);
      await waitFor(() => [...document.querySelectorAll("[data-testid=book-card]")]
        .some((node) => node.textContent.includes("Web reader fixture")));
      fixture = await evaluate(async ({ bookId, chapterId, version, hash }) => {
        const data = (result) => { if (!result.ok) throw new Error("Web fixture setup failed"); return result.data; };
        const saved = data(await window.studio.chapters.save({
          bookId, chapterId, content: "The ferry reached the quay.\n", baseVersion: version, baseHash: hash
        }));
        if (saved.status !== "saved") throw new Error("Synthetic chapter save did not commit");
        const library = data(await window.studio.library.current());
        if (library.storage?.tier !== "browser" || !library.storage.lastCommittedAt) {
          throw new Error("Expected real browser storage and commit time");
        }
        return { bookId, chapterId, hash: saved.chapter.hash, version: saved.chapter.version,
          committedAt: library.storage.lastCommittedAt };
      }, created);
      assert.equal(fixture.version, 2);
      assert.match(fixture.hash, digest);
      assert(typeof fixture.committedAt === "string" && Number.isFinite(Date.parse(fixture.committedAt)));
      await evaluate(() => [...document.querySelectorAll("[data-testid=book-card]")]
        .find((node) => node.textContent.includes("Web reader fixture")).click());
      await waitFor(() => Boolean(document.querySelector("[data-testid=manuscript-text]") &&
        [...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Open reader review")));
      await evaluate(observeStorage);
    });
    await step(checks[3], async () => {
      const initial = await snapshot();
      const opened = await evaluate((bookId) => window.studio.books.open(bookId), fixture.bookId);
      assert(opened.ok && opened.data.chapters.some((chapter) => chapter.id === fixture.chapterId && chapter.hash === fixture.hash));
      result.calibration = await since(initial);
      assert.equal(result.calibration.bookReads, 1);
      assert(result.calibration.handleReads > 0 && result.calibration.fileReads > 0);
      const beforeReadback = await snapshot();
      before = await readback();
      readbackCounts = await since(beforeReadback);
      assert(before.files > 0);
      assert.equal(before.committedAt, fixture.committedAt);
      assert.equal(readbackCounts.bookReads, 1);
      assert(readbackCounts.fileReads > 0 && readbackCounts.handleReads > 0 && readbackCounts.storageReads > 0);
      for (const name of ["writes", "permissions", "providers", "requests"]) assert.equal(readbackCounts[name], 0);
      contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    });
    await step(checks[4], async () => {
      workspaceStart = await snapshot();
      nativeStart = { requests: web.requests, permissions: web.permissions };
      workspaceStage = workspaceStages.open;
      await keyboardButton("Open reader review");
      const unsupportedPanel = ({ copy, focus }) => {
        const heading = document.querySelector("[data-reader-review-heading]");
        const panel = heading?.closest("section");
        const reader = panel?.parentElement?.closest("section");
        const buttons = [...(panel?.querySelectorAll("button") ?? [])];
        return heading?.textContent.trim() === "Structured reader review" && (!focus || document.activeElement === heading) &&
          panel.querySelector("[role=status]")?.textContent.trim() === copy &&
          buttons.some((button) => button.textContent.trim() === "Prepare review" && button.disabled) &&
          !buttons.some((button) => /^Start with\b/.test(button.textContent.trim())) &&
          !reader?.querySelector("fieldset") && !panel.querySelector('[aria-label^="Reader attempt "], [aria-label^="Reader run "]');
      };
      workspaceStage = workspaceStages.panel;
      await waitFor(unsupportedPanel, { copy, focus: false });
      workspaceStage = workspaceStages.heading;
      await waitFor(unsupportedPanel, { copy, focus: true });
      workspaceStage = workspaceStages.close;
      await keyboardButton("Close review");
      workspaceStage = workspaceStages.opener;
      await waitFor(() => !document.querySelector("[data-reader-review-heading]") &&
        document.activeElement?.textContent.trim() === "Open reader review");
      workspaceStage = workspaceStages.counters;
      const delta = await since(workspaceStart);
      nonzeroCounters = counterNames.filter((name) => delta[name] !== 0);
      assert.equal(nonzeroCounters.length, 0);
      workspaceStage = workspaceStages.adapter;
      assert(await evaluate(() => window[Symbol.for("studio.web-reader-check")].readerUnchanged()));
    });
    await step(checks[5], async () => {
      const after = await readback();
      assert.deepEqual(after, before);
      assert.equal(after.hash, fixture.hash);
      assert.equal(after.version, fixture.version);
      result.library = { before: before.libraryHash, after: after.libraryHash, files: after.files,
        chapterHash: after.hash, chapterVersion: after.version, commitTimePreserved: true };
    });
  } catch {
    // The fixed check names identify the failed step without echoing page or storage data.
  }
  try {
    await step(checks[6], async () => {
      try {
        if (result.library) {
          // Allow queued reader effects to settle with the observers still installed.
          await delay(250);
          result.workspace = await since(workspaceStart, readbackCounts);
          assert(quiet(result.workspace));
        }
      } finally {
        if (contents.debugger.isAttached()) contents.debugger.detach();
        window.destroy();
      }
      if (nativeStart) {
        assert.equal(web.requests, nativeStart.requests);
        assert.equal(web.permissions, nativeStart.permissions);
      }
      result.externalAttempts = web.external;
      result.consoleErrors = web.consoleErrors;
      assert.equal(web.external, 0);
      assert.equal(web.consoleErrors, 0);
    });
  } catch {
    // An incomplete teardown is a failed receipt.
  }
  result.ok = result.checks.length === checks.length && result.checks.every((check) => check.ok);
  return result;
}

module.exports = { scenario, admit, run, projectChecks, validateReceipt };
