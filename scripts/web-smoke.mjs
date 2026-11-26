#!/usr/bin/env node
/**
 * Runs the built web app in a hidden Chromium window with a throwaway profile.
 *
 *   bun run build:web
 *   node scripts/web-smoke.mjs
 *   GIT_COMMIT="$(git rev-parse HEAD)" bun run build:web
 *   node scripts/web-smoke.mjs --reader-review-refusal
 *
 * It opens browser storage, writes a book and chapter, saves prose, reopens it and reports
 * one line per check. No author profile or library is touched.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { headlessEnvironment, mockKeychainArgs } from "./headless-environment.mjs";
import readerRefusal from "./web-smoke/reader-review-refusal.cjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "apps", "web", "dist");
const args = process.argv.slice(2);
const readerCheck = args.length === 1 && args[0] === "--reader-review-refusal";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
async function buildManifest() {
  const files = [];
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const file = join(directory, name);
      const info = await lstat(file);
      if (info.isDirectory()) await walk(file);
      else {
        assert(info.isFile(), "Expected a regular web artifact");
        files.push(file);
      }
    }
  }
  assert((await lstat(dist)).isDirectory());
  await walk(dist);
  const assets = new Map(await Promise.all(files.sort().map(async (file) => [relative(dist, file), await readFile(file)])));
  const entries = [...assets].map(([file, bytes]) => [file, hash(bytes)]);
  return { assets, digest: hash(JSON.stringify(entries)), files: entries.length };
}

function staticServer(assets) {
  return createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const file = resolve(dist, requested);
      const bytes = assets?.get(requested);
      if (!["GET", "HEAD"].includes(request.method) || !file.startsWith(dist + sep) ||
          (assets ? bytes === undefined : !(await stat(file)).isFile())) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      if (assets) {
        response.end(bytes);
        return;
      }
      const stream = createReadStream(file);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
}

async function waitForGroup(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      // A permission error cannot establish that the group exited.
      return error.code === "ESRCH";
    }
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
}

async function runChild(electron, appDir, env) {
  const ownGroup = readerCheck && process.platform !== "win32";
  const child = spawn(electron, [...mockKeychainArgs(), appDir], { cwd: root, env, stdio: "inherit", detached: ownGroup });
  const terminate = () => {
    if (ownGroup && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group settlement remains authoritative. */ }
    } else child.kill("SIGKILL");
  };
  const direct = await new Promise((resolveChild) => {
    let failed = false;
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      terminate();
    }, 60_000);
    child.once("error", () => { failed = true; });
    // The child owns normal exit. Wait for exit and pipe closure before reading or deleting its files.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveChild({ code, signal, forced, failed });
    });
  });
  let groupEmpty = !ownGroup || !child.pid || await waitForGroup(child.pid, 1_000);
  if (!groupEmpty) {
    direct.forced = true;
    terminate();
    groupEmpty = await waitForGroup(child.pid, 2_000);
  }
  return { ...direct, groupEmpty };
}

const receipt = { scenario: readerRefusal.scenario, ok: false, phase: "launch", commit: null, artifact: null,
  childExit: null, result: null, profileRemoved: false, listenerClosed: false };
let temp;
let identity;
let profile;
let server;
let startedChild = false;
let failure;
try {
  assert(readerCheck || args.length === 0, "Unknown web smoke option");
  if (!existsSync(join(dist, "index.html"))) throw new Error("No web build found. Run bun run build:web first.");
  let artifact;
  if (readerCheck) {
    receipt.phase = "exact web build";
    receipt.commit = git("rev-parse", "HEAD");
    assert.match(receipt.commit, /^[a-f0-9]{40}$/);
    assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "");
    artifact = await buildManifest();
    receipt.artifact = { digest: artifact.digest, files: artifact.files };
  }
  receipt.phase = "isolated profile and static listener";
  const appDir = join(root, "scripts", "web-smoke");
  const electron = createRequire(join(root, "apps", "desktop", "package.json"))("electron");
  temp = await mkdtemp(join(await realpath(tmpdir()), "ai-book-studio-web-smoke-"));
  identity = await lstat(temp);
  profile = join(temp, "profile");
  await mkdir(profile, { mode: 0o700 });
  const resultPath = join(temp, "result.json");
  server = staticServer(artifact?.assets);
  await new Promise((listening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", listening);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const env = {
    ...headlessEnvironment(process.env), WEB_SMOKE_URL: url, WEB_SMOKE_PROFILE: profile, WEB_SMOKE_RESULT: resultPath,
    ...(readerCheck ? { WEB_SMOKE_SCENARIO: readerRefusal.scenario, WEB_SMOKE_COMMIT: receipt.commit } : {})
  };
  console.log(`[web-smoke] hidden run · ${url}`);
  receipt.phase = "child exit and result";
  startedChild = true;
  receipt.childExit = await runChild(electron, appDir, env);
  const info = await lstat(resultPath);
  assert(info.isFile() && info.size > 0 && info.size <= 65_536);
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  if (readerCheck) {
    const checks = readerRefusal.projectChecks(result, receipt.commit);
    if (!result.ok) {
      receipt.result = { ok: false, checks };
      throw new Error("A reader check failed");
    }
    receipt.result = readerRefusal.validateReceipt(result, receipt.commit);
    receipt.phase = "unchanged web artifact";
    const after = await buildManifest();
    assert.equal(after.digest, artifact.digest);
    assert.equal(git("rev-parse", "HEAD"), receipt.commit);
    assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "");
  } else {
    for (const check of result.checks) {
      console.log(`[web-smoke] ${check.ok ? "ok  " : "FAIL"} ${check.name} — ${check.detail}`);
    }
    if (result.consoleErrors.length > 0) {
      for (const message of result.consoleErrors) console.error(`[web-smoke] page error: ${message}`);
    }
    const passed = result.checks.filter((check) => check.ok).length;
    console.log(`[web-smoke] ${passed}/${result.checks.length} checks passed`);
    assert(result.ok);
  }
  receipt.phase = "child clean exit";
  assert.deepEqual(receipt.childExit, { code: 0, signal: null, forced: false, failed: false, groupEmpty: true });
} catch (error) {
  failure = receipt.phase;
  if (!readerCheck) console.error(`[web-smoke] ${error.message}`);
} finally {
  try {
    if (server?.listening) {
      await new Promise((done, reject) => {
        server.close((error) => error ? reject(error) : done());
        server.closeAllConnections();
      });
      assert(!server.listening);
      receipt.listenerClosed = true;
    }
  } catch {
    failure ??= "static listener cleanup";
  }
  try {
    if (temp) {
      assert(!startedChild || receipt.childExit?.groupEmpty === true);
      const info = await lstat(temp);
      assert(info.isDirectory() && info.dev === identity.dev && info.ino === identity.ino);
      await rm(temp, { recursive: true });
      await assert.rejects(lstat(profile), { code: "ENOENT" });
      await assert.rejects(lstat(temp), { code: "ENOENT" });
      receipt.profileRemoved = true;
    }
  } catch {
    failure ??= "profile cleanup";
  }
}
receipt.ok = !failure && receipt.listenerClosed && receipt.profileRemoved;
receipt.phase = failure ?? "complete";
if (readerCheck) console.log("[web-smoke] reader-review-refusal " + JSON.stringify(receipt));
process.exitCode = receipt.ok ? 0 : 1;
