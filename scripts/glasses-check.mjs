#!/usr/bin/env node
/**
 * Drives the glasses page in a real browser, at 600x600, against the real studio.
 *
 * The page is the same one the glasses load, so this proves the whole loop without the hardware:
 * the page is served by the studio, it reads the real book, it calls the real tools, and it says
 * plainly what it cannot do rather than failing quietly.
 *
 *   bun run build
 *   node scripts/glasses-check.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headlessDesktopEnvironment, headlessEnvironment, mockKeychainArgs } from "./headless-environment.mjs";
import { chromium } from "playwright";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = join(root, "apps", "desktop");

const temp = await mkdtemp(join(tmpdir(), "studio-glasses-check-"));
const profile = join(temp, "profile");
const libraryRoot = join(temp, "library");
const backendFile = join(temp, "backend.json");

await mkdir(join(profile), { recursive: true });
await mkdir(join(libraryRoot, "books", "book_glass0001", "chapters"), { recursive: true });

const now = "2026-10-26T12:00:00.000Z";
await writeFile(
  join(libraryRoot, "books", "book_glass0001", "book.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: "book_glass0001",
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
  join(libraryRoot, "books", "book_glass0001", "chapters", "0001-the-light.md"),
  "The storm came in low and the lamp would not turn.\n"
);
await writeFile(
  join(libraryRoot, "books", "book_glass0001", "chapters", "0002-the-door.md"),
  "The door under the stairs opened onto a colder shore.\n"
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

const problems = [];
const notes = [];
function check(what, ok) {
  if (ok) notes.push(what);
  else problems.push(what);
}

if (!locator) {
  console.error("[glasses] the backend never wrote its locator file");
  await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
  process.exit(1);
}

const browser = await chromium.launch({ env: headlessEnvironment(process.env) });
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

const glassesUrl = `${locator.url}/glasses#token=${locator.token}`;
await page.goto(glassesUrl, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

check("the page loads", (await page.title()) === "Open Book Studio");
check("the book is on the display", (await page.textContent("#book"))?.includes("The Salt Road") === true);
// The page opens where the status line says the author is. With no chapter open on the desktop,
// that is the last chapter, which is how far through the book the writing has got.
check(
  "the current chapter is on the display",
  /the door/i.test((await page.textContent("#chapter")) ?? "")
);
const passage = (await page.textContent("#passage")) ?? "";
check("the passage is on the display", passage.includes("The door under the stairs"));
check(
  "the passage fits the display without scrolling",
  await page.evaluate(() => {
    const body = document.body;
    return body.scrollHeight <= 600 && body.scrollWidth <= 600;
  })
);

// The page must say what it cannot do. Plain Chromium has no model context, and that is the
// normal case until the glasses turn WebMCP on.
const note = (await page.textContent("#note")) ?? "";
check(
  "the page says plainly that this device cannot be spoken to",
  /buttons only|cannot be spoken to/i.test(await page.textContent("#status")) ||
    /buttons only|cannot be spoken to/i.test(note)
);

// The agent's own sentence, the same one the desktop's minimal mode says.
const statusLine = (await page.textContent("#note")) ?? "";
check(
  "the page shows the agent's own status line",
  statusLine.includes("The Salt Road") && /chapter/i.test(statusLine),
  statusLine.slice(0, 84)
);
const shownChapter = ((await page.textContent("#chapter")) ?? "").replace(/^\d+\.\s*/, "").split(" · ")[0];
check(
  "the passage on display is the chapter the status line names",
  shownChapter.length > 0 && statusLine.toLowerCase().includes(shownChapter.toLowerCase()),
  `${shownChapter} / ${statusLine.slice(0, 60)}`
);

// The D-pad is the pointer, so the arrow keys must move the focus.
await page.keyboard.press("ArrowDown");
const focused = await page.evaluate(() => document.activeElement?.id ?? "");
check("the arrow keys move the focus", focused !== "" && focused !== "composer");

// Every action must also be reachable by hand.
await page.click("#next-chapter");
await page.waitForTimeout(400);
check(
  "the next chapter is reachable by hand",
  /the light/i.test((await page.textContent("#chapter")) ?? "")
);

await page.click("#story-bible");
await page.waitForTimeout(400);
check(
  "the Story Bible is reachable by hand",
  ((await page.textContent("#passage")) ?? "").includes("lighthouse keeper")
);

// A write must ask the wearer first.
await page.fill("#composer", "A line the author dictated.");
await page.click("#append");
await page.waitForTimeout(400);
check(
  "a write asks the wearer before it happens",
  (await page.evaluate(() => document.getElementById("confirm")?.classList.contains("open") === true))
);
await page.click("#confirm-no");
await page.waitForTimeout(300);
check(
  "the write is not made when the wearer says no",
  ((await page.textContent("#passage")) ?? "").includes("A line the author dictated.") === false
);

/*
 * The half that only runs on the glasses.
 *
 * WebMCP is off by default and the browser here does not have it, so the page's normal path is the
 * buttons-only one above. That leaves the interesting half untested: what the page hands the
 * assistant when the device *can* be spoken to. A stub model context, installed before the page's
 * own script runs, records what it is given and lets the check call it.
 */
const assistant = await browser.newPage({ viewport: { width: 600, height: 600 } });
const assistantErrors = [];
const glassesOrigin = new URL(glassesUrl).origin;
let toolCatalogResponse;
assistant.on("response", (response) => {
  const { origin, pathname } = new URL(response.url());
  if (origin === glassesOrigin &&
      pathname === "/v1/books/book_glass0001/tools" &&
      response.ok() && response.request().method() === "GET") {
    toolCatalogResponse = response;
  }
});
assistant.on("console", (message) => {
  if (message.type() === "error") assistantErrors.push(message.text());
});
assistant.on("pageerror", (error) => assistantErrors.push(error.message));
await assistant.addInitScript(() => {
  window.__tools = [];
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: {
      registerTool: async (tool) => {
        window.__tools.push(tool);
      }
    }
  });
});
await assistant.goto(glassesUrl, { waitUntil: "networkidle" });
await assistant.waitForTimeout(700);

const toolCatalog = await toolCatalogResponse?.json().catch(() => null);
const catalogTiers = new Map((Array.isArray(toolCatalog?.tools) ? toolCatalog.tools : [])
  .map((tool) => [tool.name, tool.tier]));
const registered = await assistant.evaluate(() =>
  (window.__tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations,
    hasSchema: Boolean(tool.inputSchema && tool.inputSchema.type === "object"),
    hasExecute: typeof tool.execute === "function"
  }))
);
const names = registered.map((tool) => tool.name);

check("the page gives the assistant the studio's tools", registered.length >= 5, `${registered.length} tools`);
check(
  "the read verbs are among them",
  ["table_of_contents", "read_story_bible", "read_chapter"].every((name) => names.includes(name)),
  names.slice(0, 6).join(", ")
);
check(
  "the write verb is offered, marked as a write",
  (() => {
    const append = registered.find((tool) => tool.name === "append_to_chapter");
    return Boolean(append) && append.annotations.readOnlyHint === false;
  })()
);
check(
  "the assistant only receives read and non-destructive write tools",
  [...catalogTiers.values()].includes("destructive") && registered.every(({ name, annotations }) => {
    const tier = catalogTiers.get(name);
    return (tier === "read" || tier === "write") &&
      annotations?.readOnlyHint === (tier === "read") && annotations?.consequentialHint === false;
  })
);
check(
  "every tool carries a schema and an executable handler",
  registered.every((tool) => tool.hasSchema && tool.hasExecute && tool.description.length > 20)
);
check(
  "a read tool is marked read-only",
  registered.find((tool) => tool.name === "read_story_bible")?.annotations.readOnlyHint === true
);

// Calling one has to reach the studio and come back as something worth saying.
const spoken = await assistant.evaluate(async () => {
  const tool = (window.__tools ?? []).find((entry) => entry.name === "read_story_bible");
  if (!tool) return null;
  try {
    const value = await tool.execute({});
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch (error) {
    return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
});
check(
  "calling a tool from the assistant reaches the book",
  typeof spoken === "string" && spoken.includes("The Salt Road"),
  typeof spoken === "string" ? spoken.slice(0, 74) : "no answer"
);
check("the assistant page logged no errors", assistantErrors.length === 0);
for (const error of assistantErrors) problems.push(`assistant console: ${error}`);

check("the page logged no errors", consoleErrors.length === 0);
for (const error of consoleErrors) problems.push(`console: ${error}`);

await browser.close();
await app.close().catch(() => {});
await rm(temp, { recursive: true, force: true });

for (const line of notes) console.log(`[glasses] ok    ${line}`);
for (const line of problems) console.log(`[glasses] fix   ${line}`);
console.log(problems.length === 0 ? "[glasses] no dead ends found" : "[glasses] needs attention");
process.exit(problems.length === 0 ? 0 : 1);
