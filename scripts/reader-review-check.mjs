#!/usr/bin/env node
/**
 * One keyboard journey against the exact built desktop app, inside the macOS outbound-denial
 * policy used by offline-check. Run after building with GIT_COMMIT set to the full checkout SHA.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import sample from "../apps/desktop/src/main/review/reader-review-sample.json" with { type: "json" };
import { headlessEnvironment } from "./headless-environment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const appDir = join(root, "apps", "desktop");
const build = join(appDir, "out");
const sandbox = "/usr/bin/sandbox-exec";
const childMarker = "[reader-review:child] ";
const sentinel = new RegExp(sample.sentinelPrefix + "[a-f0-9]{48}");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const quotePath = (path) => "'" + path.replaceAll("'", "'\\''") + "'";

function chapterFile(chapter) {
  return [
    "---", "id: " + chapter.id, "title: " + chapter.title, "order: " + chapter.order, "version: 1",
    "createdAt: " + sample.book.createdAt, "updatedAt: " + sample.book.updatedAt, "---", "", chapter.body
  ].join("\n");
}

async function writeFixture(scratch) {
  const profile = join(scratch, "profile");
  const libraryRoot = join(scratch, "library");
  const books = join(libraryRoot, "books");
  const book = join(books, sample.book.id);
  const chapters = join(book, "chapters");
  for (const path of [profile, libraryRoot, books, book, chapters]) await mkdir(path, { mode: 0o700 });
  const mode = { mode: 0o600, flag: "wx" };
  await writeFile(join(profile, "studio.json"), JSON.stringify({ libraryRoot }) + "\n", mode);
  await writeFile(join(book, "book.json"), JSON.stringify(sample.book) + "\n", mode);
  await writeFile(join(chapters, sample.first.filename), chapterFile(sample.first), mode);
  assert.equal(sha256(chapterFile(sample.selected)), sample.selected.hash);
  await writeFile(join(chapters, sample.selected.filename), chapterFile(sample.selected), mode);
  return { profile, libraryRoot };
}

async function filesIn(rootDir, { skipVolatile = false } = {}) {
  const files = [];
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) files.push(path);
      else assert(skipVolatile, "Unexpected non-regular fixture or artifact file");
    }
  }
  assert((await lstat(rootDir)).isDirectory());
  await walk(rootDir);
  return files.sort();
}

async function fingerprint(directory) {
  const entries = [];
  for (const file of await filesIn(directory)) {
    const bytes = await readFile(file);
    entries.push([relative(directory, file), sha256(bytes)]);
  }
  return { files: entries.length, digest: sha256(JSON.stringify(entries)) };
}

async function probeDenial(application, port) {
  const probes = await application.evaluate(async ({ session }, loopback) => {
    const net = process.getBuiltinModule("node:net");
    // This in-memory session has no renderer filter, so the result must come from Seatbelt.
    const probeSession = session.fromPartition("reader-review-denial");
    const outcomes = [];
    for (const target of [{ host: "192.0.2.1", port: 80 }, { host: "127.0.0.1", port: loopback }]) {
      const socket = await new Promise((done) => {
        const connection = net.connect(target);
        connection.setTimeout(5_000, () => { connection.destroy(); done("TIMEOUT"); });
        connection.once("connect", () => { connection.destroy(); done("CONNECTED"); });
        connection.once("error", (error) => done(error.code));
      });
      let electron = false;
      try {
        await probeSession.fetch("http://" + target.host + ":" + target.port, { signal: AbortSignal.timeout(5_000) });
      } catch (error) {
        electron = error instanceof Error && error.message.includes("ERR_ACCESS_DENIED");
      }
      outcomes.push({ socket, electron });
    }
    return outcomes;
  }, port);
  assert.deepEqual(probes, [{ socket: "EPERM", electron: true }, { socket: "EPERM", electron: true }]);
  return probes.length * 2;
}

function assertGuards(snapshot) {
  assert.equal(snapshot.guardedStorageMethods, 6);
  for (const name of ["fixtureRefusals", "outboundAttempts", "permissionAttempts", "protectedStorageAttempts"]) {
    assert.equal(snapshot[name], 0, name);
  }
}

function assertCompleted(snapshot) {
  assertGuards(snapshot);
  for (const [name, value] of Object.entries({
    catalogues: 1, preparations: 1, starts: 1, readerLists: 2, readerModels: 2, readerCredentialReads: 1, completionPosts: 1
  })) assert.equal(snapshot[name], value, name);
  assert.deepEqual(snapshot.lastStart, { kind: "completed", reason: null });
  assert.match(snapshot.preparedDigest, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.completedDigest, snapshot.preparedDigest);
  assert.match(snapshot.requestHash, /^[a-f0-9]{64}$/);
  assert.match(snapshot.requestId, /^review-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
}

function readChildObservation(payload) {
  const snapshot = JSON.parse(payload);
  const counters = [
    "catalogues", "preparations", "starts", "readerLists", "readerModels", "readerCredentialReads", "completionPosts",
    "fixtureRefusals", "outboundAttempts", "permissionAttempts", "protectedStorageAttempts", "guardedStorageMethods"
  ];
  const digests = ["preparedDigest", "completedDigest", "requestHash"];
  const fields = [...counters, ...digests, "requestId", "lastStart"];
  assert.deepEqual(Object.keys(snapshot).sort(), [...fields].sort());
  for (const name of counters) assert(Number.isSafeInteger(snapshot[name]) && snapshot[name] >= 0);
  for (const name of digests) {
    if (snapshot[name] !== null) assert.match(snapshot[name], /^[a-f0-9]{64}$/);
  }
  if (snapshot.requestId !== null) {
    assert.match(snapshot.requestId, /^review-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  }
  if (snapshot.lastStart !== null) {
    assert.deepEqual(Object.keys(snapshot.lastStart).sort(), ["kind", "reason"]);
    const { kind, reason } = snapshot.lastStart;
    const reasons = new Map([
      ["completed", [null]], ["stopped", [null]],
      ["blocked", ["unavailable", "permission", "no-model", "invalid-selection", "scope-too-large", "consent", "terms", "changed"]],
      ["failed", ["provider", "overflow", "malformed", "refused"]]
    ]);
    assert(snapshot.starts > 0 && reasons.get(kind)?.includes(reason));
  }
  return snapshot;
}

async function runJourney(page, application, libraryRoot, candidate, record) {
  page.setDefaultTimeout(10_000);
  const observe = () => application.evaluate(() => globalThis[Symbol.for("studio.reader-review-check")].snapshot());
  const activate = async (control, key = "Enter") => {
    await control.waitFor({ state: "visible" });
    assert(await control.isEnabled(), "The required keyboard control is disabled");
    for (let index = 0; index < 100; index++) {
      if (await control.evaluate((element) => element === document.activeElement)) {
        await page.keyboard.press(key);
        return;
      }
      await page.keyboard.press("Tab");
    }
    throw new Error("The required control is not keyboard-reachable");
  };
  const exactButton = (name) => page.getByRole("button", { name, exact: true });
  const activeChapter = (id) => page.locator('[data-chapter-id="' + id + '"][aria-current="page"]');

  record.phase = "built desktop and saved opening chapter";
  await page.getByTestId("library-view").waitFor();
  const info = await page.evaluate(() => window.studio.app.info());
  assert(info.ok && info.data.target === "desktop" && info.data.commit === candidate);
  await activate(page.getByTestId("book-card").filter({ hasText: sample.book.title }));
  await activeChapter(sample.first.id).waitFor();
  await page.getByTestId("manuscript-text").waitFor();
  const before = await fingerprint(libraryRoot);
  const initial = await observe();
  assertGuards(initial);
  assert.equal(initial.catalogues + initial.preparations + initial.starts + initial.readerCredentialReads + initial.completionPosts, 0);

  record.phase = "keyboard preparation and disclosure";
  const opener = exactButton("Open reader review");
  await activate(opener);
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-reader-review-heading"));
  assert(await exactButton("Prepare review").isDisabled());
  await activate(page.getByRole("checkbox", { name: /Chapter 2: The arrival/ }), "Space");
  assert(await page.getByRole("checkbox", { name: /Chapter 2: The arrival/ }).isChecked());
  assert(!(await page.getByRole("checkbox", { name: /Chapter 1: The quay/ }).isChecked()));
  await activate(exactButton("Prepare review"));
  const disclosure = page.getByRole("region", { name: "Outgoing review disclosure" });
  await disclosure.waitFor();
  await activate(disclosure.locator("summary").filter({ hasText: "Exact destination details" }));
  const disclosureText = await disclosure.innerText();
  for (const text of [
    sample.selected.title, "Saved version 1", "UTF-16 range [0, 120)", "1 book · 1 source item",
    "124 of 65,536 source-text bytes", "Provider: " + sample.providerName + " · Model: " + sample.modelName, sample.connectionLabel,
    "Model id: " + sample.book.defaultModelId, "Connection id: " + sample.book.defaultConnectionId,
    "Input $1.25", "Output $4.25", "Cached input $0.15", "Estimated cost: Unknown",
    "Tools: None offered", "Data use: Selected text is sent to Meta for this one review",
    "Training: The provider reports that this model does not train", "Required consent: Satisfied"
  ]) assert(disclosureText.includes(text), "Missing disclosure content");
  assert(!disclosureText.includes(sample.first.title) && !disclosureText.includes(sample.first.body.trim()));
  assert.equal(await disclosure.locator("pre").textContent(), sample.selected.body);
  const prepared = await observe();
  assertGuards(prepared);
  assert.equal(prepared.catalogues, 1);
  assert.equal(prepared.preparations, 1);
  assert.equal(prepared.starts, 0);
  assert.equal(prepared.readerCredentialReads, 0);
  assert.equal(prepared.completionPosts, 0);
  assert.deepEqual(await fingerprint(libraryRoot), before);

  record.phase = "activate explicit Start by keyboard";
  await activate(exactButton("Start with " + sample.providerName));
  const results = page.getByRole("region", { name: "Volatile reader results" });
  const run = results.getByRole("article", { name: "Reader run " + prepared.requestId });
  record.phase = "wait for the completed attributed run";
  try {
    await run.waitFor();
  } catch (error) {
    record.startView = await within(page.evaluate((requestId) => {
      const panel = document.querySelector("[data-reader-review-heading]")?.closest("section");
      if (!panel) return "panel closed";
      if (panel.querySelector(`[aria-label="Reader run ${requestId}"]`)) return "run present";
      if (panel.querySelector(`[aria-label="Reader attempt ${requestId}"]`)) return "incomplete attempt present";
      return [...panel.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Start with "))
        ? "disclosure present" : "no attributed run or attempt";
    }, prepared.requestId).catch(() => null), 1_000);
    throw error;
  }
  record.phase = "verify the finding, quotation and disabled historical navigation";
  const finding = run.getByRole("region", { name: "clarity finding" });
  await finding.getByText(sample.finding, { exact: true }).waitFor();
  assert.equal(await results.getByRole("article").count(), 1);
  assert.equal(await finding.locator("blockquote").textContent(), sample.quote.text);
  assert((await finding.innerText()).includes("2 unverified quotations withheld"));
  const passage = finding.getByRole("button", { name: /^Show exact passage for finding-1,/ });
  assert(await passage.isDisabled());
  record.phase = "verify the admitted synthetic completion";
  const observed = await observe();
  assertCompleted(observed);

  record.phase = "check current sources and select the second exact passage";
  await activate(exactButton("Check current sources"));
  await passage.and(finding.getByRole("button", { disabled: false })).waitFor();
  await activate(passage);
  await activeChapter(sample.selected.id).waitFor();
  await page.waitForFunction(({ start, end, text }) => {
    const editor = document.querySelector('[data-testid="manuscript-text"]');
    const selection = window.getSelection();
    if (!editor || document.activeElement !== editor || !selection || selection.rangeCount !== 1) return false;
    const range = selection.getRangeAt(0);
    const lines = [...editor.querySelectorAll(".cm-line")];
    const editorOffset = (node, offset) => {
      const index = lines.findIndex((line) => line.contains(node));
      if (index < 0) return -1;
      const line = lines[index];
      const prefix = document.createRange();
      prefix.setStart(line, 0);
      prefix.setEnd(node, offset);
      return lines.slice(0, index).reduce((total, previous) => total + previous.textContent.length + 1, 0) + prefix.toString().length;
    };
    return selection.toString() === text && editorOffset(range.startContainer, range.startOffset) === start &&
      editorOffset(range.endContainer, range.endOffset) === end &&
      document.querySelector('[data-testid="save-status"]')?.textContent?.trim() === "Saved";
  }, sample.quote);
  record.selection = { start: sample.quote.start, end: sample.quote.end, saved: true };
  await activate(exactButton("Close review"));
  await opener.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Open reader review");
  assert.deepEqual(await fingerprint(libraryRoot), before);
  record.library = before;
  return observed;
}

function observeChild(child) {
  const logs = { stdout: "", stderr: "", overflow: false };
  for (const name of ["stdout", "stderr"]) {
    child[name]?.setEncoding("utf8").on("data", (chunk) => {
      if (logs[name].length + chunk.length > 1_000_000) logs.overflow = true;
      else logs[name] += chunk;
    });
  }
  let signalled = false;
  const pid = child.pid;
  assert(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
  const exit = new Promise((resolve) => {
    const onClose = (code, signal) => resolve({ code, signal });
    child.once("close", onClose);
    if ((child.exitCode !== null || child.signalCode !== null) && child.stdout?.closed && child.stderr?.closed) {
      onClose(child.exitCode, child.signalCode);
    }
  });
  const terminateGroup = () => {
    if (signalled) return;
    signalled = true;
    // The pinned Playwright launcher spawns Electron in its own detached process group on macOS.
    try { process.kill(-pid, "SIGKILL"); } catch { /* A signal does not establish exit. */ }
  };
  async function waitForGroup(milliseconds) {
    const deadline = Date.now() + milliseconds;
    for (;;) {
      try { process.kill(-pid, 0); } catch (error) { return error.code === "ESRCH"; }
      if (Date.now() >= deadline) return false;
      await delay(50);
    }
  }
  return { logs, exit, terminateGroup, waitForGroup };
}

async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopOwnedChild(application, receipt, graceMs = 15_000, reapMs = 5_000) {
  const closing = Promise.resolve().then(() => application.close()).then(() => true, () => false);
  const settled = await within(Promise.all([closing, receipt.exit]), graceMs);
  if (settled && await receipt.waitForGroup(Math.min(reapMs, 1_000))) {
    return { graceful: settled[0], exit: settled[1], groupEmpty: true };
  }
  receipt.terminateGroup();
  const exit = settled?.[1] ?? await within(receipt.exit, reapMs);
  return { graceful: false, exit, groupEmpty: exit !== null && await receipt.waitForGroup(reapMs) };
}

const result = {
  scenario: sample.scenario, ok: false, phase: "macOS Seatbelt host prerequisite", candidate: null,
  build: null, library: null, selection: null, startView: null, observations: null, guardDenials: 0,
  childExit: null, childGroupEmpty: false, cleaned: false
};
let scratch;
let scratchIdentity;
let application;
let receipt;
let launched = false;
let observed;
let listener;
let libraryRoot;
let watchdog;
let timedOut = false;
let loopbackConnections = 0;
let failure;
try {
  assert.equal(process.platform, "darwin");
  await access(sandbox, constants.X_OK);
  result.phase = "scenario and exact built artifact prerequisite";
  assert.deepEqual(process.argv.slice(2), [sample.scenario]);
  assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "");
  result.candidate = git("rev-parse", "HEAD");
  assert.match(result.candidate, /^[a-f0-9]{40}$/);
  for (const file of ["main/index.cjs", "preload/index.cjs", "renderer/index.html"]) {
    assert((await lstat(join(build, file))).isFile());
  }
  result.build = await fingerprint(build);
  const electron = createRequire(join(appDir, "package.json"))("electron");
  await access(electron, constants.X_OK);
  const { _electron } = await import("playwright");

  result.phase = "isolated launcher and outbound denial";
  scratch = await mkdtemp(join(await realpath(tmpdir()), sample.scratchPrefix));
  scratchIdentity = await lstat(scratch);
  const fixture = await writeFixture(scratch);
  libraryRoot = fixture.libraryRoot;
  const artifacts = join(scratch, "artifacts");
  await mkdir(artifacts, { mode: 0o700 });
  const policy = join(scratch, "offline.sb");
  const launcher = join(scratch, "electron.sh");
  await writeFile(policy, "(version 1)\n(allow default)\n(deny network-outbound)\n", { mode: 0o600 });
  await writeFile(launcher, "#!/bin/sh\nexec " + sandbox + " -f " + quotePath(policy) + " " +
    quotePath(electron) + ' "$@"\n', { mode: 0o700 });
  listener = createServer((socket) => { loopbackConnections++; socket.destroy(); });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  launched = true;
  application = await _electron.launch({
    executablePath: launcher, args: ["--no-sandbox", "--use-mock-keychain", appDir], cwd: appDir,
    artifactsDir: artifacts, timeout: 40_000,
    env: {
      ...headlessEnvironment(process.env), STUDIO_READER_REVIEW_CHECK: sample.scenario, STUDIO_TEST: "1",
      STUDIO_HEADLESS: "1", STUDIO_TEST_MEMORY_VAULT: "1", STUDIO_USER_DATA: fixture.profile, STUDIO_WINDOW_SIZE: "1440x900"
    }
  });
  receipt = observeChild(application.process());
  watchdog = setTimeout(() => {
    timedOut = true;
    receipt.terminateGroup();
  }, 90_000);
  const page = await application.firstWindow({ timeout: 15_000 });
  const isolated = await application.evaluate(({ app, BrowserWindow }, profile) =>
    !app.isPackaged && app.getPath("userData") === profile &&
    BrowserWindow.getAllWindows().length === 1 && BrowserWindow.getAllWindows().every((window) => !window.isVisible()), fixture.profile);
  assert(isolated);
  result.guardDenials += await probeDenial(application, port);
  assert.equal(loopbackConnections, 0);
  observed = await runJourney(page, application, libraryRoot, result.candidate, result);
  result.phase = "confirm outbound denial after the journey";
  result.guardDenials += await probeDenial(application, port);
  assert.equal(loopbackConnections, 0);
} catch {
  failure = result.phase;
} finally {
  try {
    if (application) {
      result.phase = "child exit and final isolation";
      const stopped = await stopOwnedChild(application, receipt);
      result.childExit = stopped.exit;
      result.childGroupEmpty = stopped.groupEmpty;
      clearTimeout(watchdog);
      assert(stopped.graceful);
      assert.deepEqual(result.childExit, { code: 0, signal: null });
      const { stdout, stderr, overflow } = receipt.logs;
      assert(!overflow && !sentinel.test(stdout) && !sentinel.test(stderr));
      const summaries = stdout.split("\n").filter((line) => line.startsWith(childMarker));
      assert.equal(summaries.length, 1);
      result.observations = readChildObservation(summaries[0].slice(childMarker.length));
      assert(!timedOut && result.guardDenials === 8 && loopbackConnections === 0);
      assertCompleted(result.observations);
      assert.deepEqual(result.observations, observed);
      const profile = join(scratch, "profile");
      assert(!(await readdir(profile)).includes("credentials.json"));
      for (const file of await filesIn(scratch, { skipVolatile: true })) {
        assert(!sentinel.test((await readFile(file)).toString("latin1")));
      }
      assert.deepEqual(await fingerprint(libraryRoot), result.library);
      assert.deepEqual(await fingerprint(build), result.build);
      assert.equal(git("rev-parse", "HEAD"), result.candidate);
      assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "");
    }
  } catch {
    failure ??= result.phase;
  } finally {
    clearTimeout(watchdog);
    try {
      if (listener?.listening) await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      if (scratch) {
        assert(!launched || result.childGroupEmpty, "Child group exit must be observed before scratch removal");
        const info = await lstat(scratch);
        assert(info.isDirectory() && info.dev === scratchIdentity.dev && info.ino === scratchIdentity.ino);
        await rm(scratch, { recursive: true });
        await assert.rejects(lstat(scratch), { code: "ENOENT" });
        result.cleaned = true;
      }
    } catch {
      failure ??= "owned scratch or listener cleanup";
    }
  }
}
result.ok = !failure && result.cleaned;
result.phase = failure ?? "complete";
console.log("[reader-review] result " + JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
