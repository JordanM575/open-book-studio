#!/usr/bin/env node
/**
 * The phone's half of the bridge, proved without a phone.
 *
 * The bridge exists because the phone is on the local network and cannot reach the studio's
 * loopback. That is a claim about two processes on different addresses, so it is tested the same
 * way the phone will use it: the app runs headless with the bridge on, and **a separate process**
 * speaks to it over the local network with the per-run token.
 *
 * What it proves:
 *
 * - the ambient status comes back with the real book in it;
 * - a tool runs and returns the real chapter text;
 * - a turn reaches the agent and answers with the studio's own sentence when no model is chosen;
 * - a request without the token, from a browser origin, or to a route the bridge does not serve,
 *   is refused.
 *
 *   bun run build
 *   node scripts/bridge-probe.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headlessDesktopEnvironment, mockKeychainArgs } from "./headless-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = join(root, "apps", "desktop");
const builtMain = join(appDir, "out", "main", "index.cjs");

const temp = await mkdtemp(join(tmpdir(), "studio-bridge-probe-"));
const profile = join(temp, "profile");
const libraryRoot = join(temp, "library");
const backendFile = join(temp, "backend.json");

const BOOK = "book_bridge001";
const CHAPTER = "ch_bridge0001";

await mkdir(join(profile), { recursive: true });
await mkdir(join(libraryRoot, "books", BOOK, "chapters"), { recursive: true });

const now = "2026-10-26T12:00:00.000Z";
await writeFile(
  join(libraryRoot, "books", BOOK, "book.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: BOOK,
      title: "The Salt Road",
      description: "A lighthouse keeper keeps light for a ship that may never come.",
      stage: "drafting",
      createdAt: now,
      updatedAt: now
    },
    null,
    2
  )}\n`
);
await writeFile(
  join(libraryRoot, "books", BOOK, "chapters", "0001-the-light.md"),
  `---\nid: ${CHAPTER}\ntitle: The Light\n---\n\nThe storm came in low and the lamp would not turn.\n`
);
await writeFile(join(profile, "studio.json"), `${JSON.stringify({ libraryRoot }, null, 2)}\n`);

const env = headlessDesktopEnvironment(process.env, profile);
env.STUDIO_BACKEND = "1";
env.STUDIO_BRIDGE = "1";
env.STUDIO_BACKEND_FILE = backendFile;

const electronPath = createRequire(join(appDir, "package.json"))("electron");
const child = spawn(electronPath, [...mockKeychainArgs(), appDir], { cwd: appDir, env, stdio: ["inherit", "pipe", "inherit"] });

const problems = [];
const notes = [];
function check(what, ok, detail) {
  if (ok) notes.push(detail ? `${what} — ${detail}` : what);
  else problems.push(detail ? `${what} — ${detail}` : what);
}

let bridgeUrl = null;
let buffered = "";
child.stdout.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  let newline = buffered.indexOf("\n");
  while (newline !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf("\n");
    if (line.startsWith("[bridge] result ")) {
      try {
        bridgeUrl = JSON.parse(line.slice("[bridge] result ".length)).url;
      } catch {
        bridgeUrl = null;
      }
    }
  }
});

/**
 * Stop the app and remove its throwaway folder. SIGKILL is not instant, and the dying app (or its GPU
 * process) can still be writing into the profile while the folder is removed, which made the removal
 * fail with ENOTEMPTY after every check had already passed. So wait for the exit, retry the removal,
 * and never let a cleanup failure turn a passing probe into a failing one.
 */
async function stopApp() {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch((error) => {
    console.error(`[bridge] could not remove ${temp}: ${error.code ?? error.message}`);
  });
}

/** Wait for something the app prints, or give up. */
async function waitFor(read, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((wait) => setTimeout(wait, 200));
  }
  return null;
}

const locator = await waitFor(async () => {
  try {
    return JSON.parse(await readFile(backendFile, "utf8"));
  } catch {
    return null;
  }
});

if (!locator) {
  console.error("[bridge] the backend never started");
  await stopApp();
  process.exit(1);
}

const url = await waitFor(async () => bridgeUrl);
if (!url) {
  console.error("[bridge] the bridge never reported an address");
  await stopApp();
  process.exit(1);
}

check("the bridge listens on a local address, not the loopback", /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(url), url);

const auth = { authorization: `Bearer ${locator.token}` };

try {
  // 1. The ambient status, which is what the lenses would show.
  const ambientResponse = await fetch(`${url}/v1/ambient?book=${BOOK}`, { headers: auth });
  const ambient = await ambientResponse.json();
  check("a separate process can read the ambient status", ambientResponse.status === 200);
  const say = ambient?.ambient?.say ?? "";
  check("the status is about the real book", /The Salt Road/.test(say), say.slice(0, 90));
  check(
    "the status offers the studio's own verbs",
    (ambient?.ambient?.actions ?? []).some((action) => action.id === "read_aloud")
  );

  // 2. A tool, which is how a tap on the lenses becomes an action.
  const toolResponse = await fetch(`${url}/v1/tool`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ bookId: BOOK, name: "read_chapter", args: { chapterId: CHAPTER } })
  });
  const tool = await toolResponse.json();
  check("a tool runs over the bridge", toolResponse.status === 200);
  check(
    "the tool returned the real prose",
    /storm came in low/.test(JSON.stringify(tool)),
    JSON.stringify(tool).slice(0, 80)
  );

  // 3. A turn reaches the agent. With no model chosen it must answer with the studio's sentence
  //    rather than hang or fail silently.
  const turnResponse = await fetch(`${url}/v1/turn`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ bookId: BOOK, prompt: "Carry on with the next scene." })
  });
  const turn = await turnResponse.json();
  check(
    "a turn reaches the agent and refuses cleanly with no model",
    turnResponse.status >= 400 && /model/i.test(turn?.error?.message ?? ""),
    turn?.error?.message?.slice(0, 70)
  );

  // 4. Undo, because the ambient status offers it. There is no checkpoint here, so the honest
  //    answer is a refusal that says so rather than a route that does not exist.
  const undoResponse = await fetch(`${url}/v1/undo`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ bookId: BOOK })
  });
  const undo = await undoResponse.json();
  check(
    "undo is reachable and says plainly when there is nothing to undo",
    undoResponse.status >= 400 && /undo/i.test(undo?.error?.message ?? ""),
    undo?.error?.message?.slice(0, 70)
  );

  // 5. Stop, because the status reports whether the agent is working.
  const stopResponse = await fetch(`${url}/v1/stop`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ bookId: BOOK })
  });
  const stop = await stopResponse.json();
  check(
    "stop is reachable, and reports nothing to stop when the agent is idle",
    stopResponse.status === 200 && stop?.result?.stopped === 0,
    `stopped ${stop?.result?.stopped ?? "?"}`
  );

  // 6. The bridge is not the library API, and it is not open.
  check("a route the bridge does not serve is refused", (await fetch(`${url}/v1/books`, { headers: auth })).status === 404);
  check("a request without the token is refused", (await fetch(`${url}/v1/ambient?book=${BOOK}`)).status === 401);
  check(
    "a browser origin is refused",
    (await fetch(`${url}/v1/ambient?book=${BOOK}`, { headers: { ...auth, origin: "https://evil.example" } })).status === 403
  );
} catch (error) {
  problems.push(`the probe crashed: ${error instanceof Error ? error.message : String(error)}`);
}

await stopApp();

for (const line of notes) console.log(`[bridge] ok    ${line}`);
for (const line of problems) console.log(`[bridge] fix   ${line}`);
console.log(problems.length === 0 ? "[bridge] no dead ends found" : "[bridge] needs attention");
process.exit(problems.length === 0 ? 0 : 1);
