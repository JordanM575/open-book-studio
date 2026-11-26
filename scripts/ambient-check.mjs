#!/usr/bin/env node
/**
 * Proves the ambient agent on the control plane, against a real studio.
 *
 * It asks the running app where the author is, and it runs a real turn through the same runtime
 * the app uses, then reads the answer back.
 *
 *   bun run build
 *   node scripts/ambient-check.mjs
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

const temp = await mkdtemp(join(tmpdir(), "studio-ambient-check-"));
const profile = join(temp, "profile");
const libraryRoot = join(temp, "library");
const backendFile = join(temp, "backend.json");

await mkdir(join(profile), { recursive: true });
await mkdir(join(libraryRoot, "books", "book_amb000001", "chapters"), { recursive: true });

const now = "2026-10-26T12:00:00.000Z";
await writeFile(
  join(libraryRoot, "books", "book_amb000001", "book.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: "book_amb000001",
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
  join(libraryRoot, "books", "book_amb000001", "chapters", "0001-the-light.md"),
  "The storm came in low and the lamp would not turn.\n"
);
await writeFile(join(profile, "studio.json"), `${JSON.stringify({ libraryRoot }, null, 2)}\n`);

const env = headlessDesktopEnvironment(process.env, profile);
env.STUDIO_BACKEND = "1";
env.STUDIO_BACKEND_FILE = backendFile;

const electronPath = createRequire(join(appDir, "package.json"))("electron");
const { _electron } = await import("playwright");
const app = await _electron.launch({ executablePath: electronPath, args: [...mockKeychainArgs(), appDir], cwd: appDir, env });
await app.firstWindow();

let locator = null;
for (let attempt = 0; attempt < 40 && !locator; attempt += 1) {
  await new Promise((wait) => setTimeout(wait, 250));
  try {
    locator = JSON.parse(await readFile(backendFile, "utf8"));
  } catch {
    locator = null;
  }
}

const notes = [];
const problems = [];
function check(what, ok) {
  if (ok) notes.push(what);
  else problems.push(what);
}

if (!locator) {
  console.error("[ambient] the backend never wrote its locator file");
  await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
  process.exit(1);
}

const auth = { authorization: `Bearer ${locator.token}` };

const ambient = await (
  await fetch(`${locator.url}/v1/books/book_amb000001/ambient`, { headers: auth })
).json();
check("the studio says where the author is", Boolean(ambient?.ambient?.say));
check(
  "the line names the book and the chapter",
  /The Salt Road/.test(ambient?.ambient?.say ?? "") && /Chapter One/.test(ambient?.ambient?.say ?? "")
);
check(
  "the line offers to read it",
  /shall I read it to you/i.test(ambient?.ambient?.say ?? "")
);
check(
  "the actions are the studio's own verbs",
  (ambient?.ambient?.actions ?? []).some((action) => action.id === "read_aloud")
);

// The turn route needs a model, so the honest check is what it says when there is none.
const turn = await fetch(`${locator.url}/v1/books/book_amb000001/turn`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ prompt: "Carry on with the next scene." })
});
const turnBody = await turn.json();
check(
  "a turn with no model says so, in one sentence",
  turn.status >= 400 && typeof turnBody?.error?.message === "string" && turnBody.error.message.length > 0
);
check(
  "the refusal names the model, not the machinery",
  /model/i.test(turnBody?.error?.message ?? "")
);

// The toolkit can say the same thing.
const cli = join(root, "apps", "toolkit", "dist", "bookwriter");
const out = await new Promise((resolve) => {
  const child = spawn(cli, ["where", "book_amb000001", "--url", locator.url, "--token", locator.token], {
    cwd: root
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => (buffer += chunk));
  child.stderr.on("data", (chunk) => (buffer += chunk));
  child.on("close", () => resolve(buffer));
});
check("the toolkit can say it too", /The Salt Road/.test(out));

// The ambient status offers undo, so the command line must be able to perform it. There is no
// checkpoint in this fixture, so the honest answer is a refusal that says so.
const undoOut = await new Promise((resolve) => {
  const child = spawn(cli, ["undo", "book_amb000001", "--url", locator.url, "--token", locator.token], {
    cwd: root
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => (buffer += chunk));
  child.stderr.on("data", (chunk) => (buffer += chunk));
  child.on("close", (code) => resolve({ code, buffer }));
});
check(
  "the toolkit can undo, and says plainly when there is nothing to undo",
  undoOut.code !== 0 && /undo/i.test(undoOut.buffer),
  undoOut.buffer.trim().slice(0, 80)
);

await app.close().catch(() => {});
await rm(temp, { recursive: true, force: true });

for (const line of notes) console.log(`[ambient] ok    ${line}`);
for (const line of problems) console.log(`[ambient] fix   ${line}`);
console.log(problems.length === 0 ? "[ambient] no dead ends found" : "[ambient] needs attention");
process.exit(problems.length === 0 ? 0 : 1);
