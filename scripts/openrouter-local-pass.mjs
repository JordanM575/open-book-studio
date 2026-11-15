#!/usr/bin/env node
/**
 * One opted-in writing turn through the built app, on the author's own OpenRouter key.
 *
 * This is not part of `bun run e2e` or `bun run verify`. It does nothing unless
 * `OPENROUTER_LOCAL_PASS=1` and `OPENROUTER_API_KEY` are both set, and it decides that
 * before Electron is launched. The key is given to the app through its own connection
 * channel, into the in-memory test vault, and is then removed from the app's environment.
 * The chapter must change on disk. Illustrations stay on this build's Meta image adapter;
 * this pass does not claim otherwise and does not generate an image.
 *
 *   bun run build
 *   OPENROUTER_LOCAL_PASS=1 OPENROUTER_API_KEY=… node scripts/openrouter-local-pass.mjs
 *
 * `OPENROUTER_MODEL` overrides the default `openai/gpt-4o-mini`. A missing flag or key
 * exits 0. A bad key or model id exits 1 before any provider request.
 */
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_PASS_BOOK, writeLocalPassFixture } from "./openrouter-local-fixture.mjs";
import { planOpenRouterLocalPass } from "./openrouter-local-plan.mjs";

const plan = planOpenRouterLocalPass({
  flag: process.env.OPENROUTER_LOCAL_PASS,
  apiKey: process.env.OPENROUTER_API_KEY,
  model: process.env.OPENROUTER_MODEL
});

if (plan.action === "skip") {
  console.log(`[local-pass] ${plan.reason}`);
  process.exit(0);
}
if (plan.action === "fail") {
  console.error(`[local-pass] ${plan.reason}`);
  process.exit(1);
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = join(root, "apps", "desktop");
const BOOK = LOCAL_PASS_BOOK;
const MODEL = plan.model;
const PROMPT =
  "Read the opening chapter and add exactly one new sentence at the end about the lamp. Do not replace the chapter.";
const key = process.env.OPENROUTER_API_KEY.trim();

const temp = await mkdtemp(join(tmpdir(), "studio-openrouter-local-pass-"));
const { profile, backendFile, bookDir } = await writeLocalPassFixture(temp);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.OPENROUTER_API_KEY;
delete env.OPENAI_API_KEY;
delete env.ANTHROPIC_API_KEY;
delete env.GEMINI_API_KEY;
delete env.META_API_KEY;
delete env.META_API_BASE_URL;
for (const name of Object.keys(env)) {
  if (name.startsWith("HEADROOM_") || /^(https?|all|no)_proxy$/i.test(name)) delete env[name];
}
env.STUDIO_TEST = "1";
env.STUDIO_HEADLESS = "1";
env.STUDIO_BACKEND = "1";
env.STUDIO_TEST_MEMORY_VAULT = "1";
env.STUDIO_USER_DATA = profile;
env.STUDIO_BACKEND_FILE = backendFile;

let app = null;
let finished = false;

async function closeApp() {
  if (!app) return;
  const closing = app;
  app = null;
  const child = closing.process();
  const closed = await Promise.race([
    closing.close().then(
      () => true,
      () => false
    ),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 15_000))
  ]);
  if (!closed && child.exitCode === null) child.kill("SIGKILL");
}

async function cleanUp() {
  await closeApp();
  if (process.env.OPENROUTER_LOCAL_PASS_KEEP === "1") console.log(`[local-pass] kept ${temp}`);
  else await rm(temp, { recursive: true, force: true }).catch(() => {});
}

const watchdog = setTimeout(() => {
  if (finished) return;
  console.error("[local-pass] Timed out after 240s; stopping the run.");
  void cleanUp().finally(() => process.exit(1));
}, 240_000);

function fail(message) {
  throw new Error(message);
}

try {
  const electronPath = createRequire(join(appDir, "package.json"))("electron");
  const { _electron } = await import("playwright");
  app = await _electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.studio?.connections), null, { timeout: 30_000 });

  async function studio(path, ...args) {
    const result = await page.evaluate(
      async ({ path: method, args: input }) => {
        const parts = method.split(".");
        const name = parts.pop();
        let target = window.studio;
        for (const part of parts) target = target[part];
        return await target[name](...input);
      },
      { path, args }
    );
    if (!result?.ok) fail(`${path} failed: ${result?.error?.message ?? "no answer"}`);
    return result.data;
  }

  const status = await studio("connections.status");
  if (status?.backend !== "In-memory test vault" || status.available !== true) {
    fail(`The app is not using the in-memory test vault (${status?.backend ?? "no status"}).`);
  }

  const connection = await studio("connections.addKey", {
    provider: "openrouter",
    secret: key,
    label: "OpenRouter local pass"
  });
  if (connection?.provider !== "openrouter") fail("The OpenRouter connection was not added.");
  const listed = JSON.stringify(await studio("connections.list"));
  if (listed.includes(key)) fail("The connection list included the key.");

  await studio("books.update", BOOK, {
    defaultProvider: "openrouter",
    defaultConnectionId: connection.id,
    defaultModelId: MODEL
  });

  const locator = await new Promise((resolveLocator) => {
    const started = Date.now();
    const readLocator = async () => {
      try {
        resolveLocator(JSON.parse(await readFile(backendFile, "utf8")));
      } catch {
        if (Date.now() - started > 30_000) resolveLocator(null);
        else setTimeout(readLocator, 200);
      }
    };
    void readLocator();
  });
  if (!locator?.url || !locator.token) fail("The control plane never wrote its locator file.");

  const created = await fetch(`${locator.url}/v1/books/${BOOK}/chapters`, {
    method: "POST",
    headers: { authorization: `Bearer ${locator.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "The Light",
      content: "The lighthouse keeper counted the gulls and wrote the number in the margin."
    })
  });
  const createdBody = await created.json().catch(() => null);
  if (!created.ok) fail(`Creating the chapter failed: ${createdBody?.error?.message ?? created.status}`);
  const chapter = createdBody.chapter;
  const chapterFile = join(bookDir, "chapters", chapter.path);
  const before = await readFile(chapterFile, "utf8");

  const turned = await fetch(`${locator.url}/v1/books/${BOOK}/turn`, {
    method: "POST",
    headers: { authorization: `Bearer ${locator.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: PROMPT, chapterId: chapter.id })
  });
  const turnedBody = await turned.json().catch(() => null);
  if (!turned.ok) fail(`The writing turn failed: ${turnedBody?.error?.message ?? turned.status}`);
  const after = await readFile(chapterFile, "utf8");
  if (after === before) fail("The agent replied, but the chapter file did not change.");
  if ((turnedBody?.result?.changed ?? 0) < 1) fail("The turn did not report a changed chapter.");

  const threads = (await readdir(join(bookDir, "threads")).catch(() => [])).filter((name) => name.endsWith(".json"));
  if (threads.length !== 1) fail(`Expected one stored conversation, found ${threads.length}.`);
  const thread = JSON.parse(await readFile(join(bookDir, "threads", threads[0]), "utf8"));
  const stored = JSON.stringify(thread);
  if (!stored.includes(MODEL) || !stored.includes("openrouter")) {
    fail("The stored conversation does not name the OpenRouter model.");
  }

  console.log(
    `[local-pass] OpenRouter ${MODEL} changed the chapter (${before.length} → ${after.length} characters) and stored the turn.`
  );
  console.log("[local-pass] Illustrations in this build still use the Meta image adapter. This pass did not generate one.");
  finished = true;
} catch (error) {
  console.error(`[local-pass] ${error instanceof Error ? error.message : String(error)}`);
  await cleanUp();
  process.exit(1);
}

clearTimeout(watchdog);
await cleanUp();
