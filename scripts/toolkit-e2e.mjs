#!/usr/bin/env node
/**
 * Proves the `bookwriter` toolkit against a real studio.
 *
 * It launches the built app hidden, with its own profile, library and locator file, then drives the
 * compiled CLI and `bookwriter mcp` over stdio against it. Every answer is checked against the bytes
 * on disk, because the thing that goes wrong is never the toolkit's opinion of what it did.
 *
 * It backs two things the film says:
 *
 *   - a tool the author switches off for a book, in the Agent dialog, is refused by the command line
 *     and by an MCP client;
 *   - the command line and MCP read and save the same open book with the same version and hash
 *     checks, and nothing is written without `--allow-writes`.
 *
 * The fixture is synthetic and lives in a temporary folder. No provider is called.
 *
 *   bun run build && bun run toolkit:build
 *   node scripts/toolkit-e2e.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { headlessDesktopEnvironment, headlessEnvironment, mockKeychainArgs } from "./headless-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = join(root, "apps", "desktop");
const cli = join(root, "apps", "toolkit", "dist", "bookwriter");

if (!existsSync(join(appDir, "out", "main", "index.cjs"))) {
  console.error("[toolkit] No build found. Run `bun run build` first.");
  process.exit(1);
}
if (!existsSync(cli)) {
  console.error("[toolkit] No toolkit build found. Run `bun run toolkit:build` first.");
  process.exit(1);
}

const BOOK = "book_7e2e5a1c0d9b3f48";
// The workspace opens the first chapter, so the editor holds it. Every save lands on the second.
const LAMP = "ch_7e2e5a1c0d9b3f01";
const TIDE = "ch_7e2e5a1c0d9b3f02";
const WITHDRAWN = "find_in_chapter";
const REFUSAL = `${WITHDRAWN} is turned off for this book. The author withdrew it.`;
const WRITE_TOOLS = [
  "append_to_chapter",
  "replace_in_chapter",
  "insert_at_line",
  "create_chapter",
  "studio_ask",
  "studio_undo",
  "studio_stop"
];
const DESTRUCTIVE_TOOLS = ["overwrite_chapter", "delete_chapter", "delete_lines_in_chapter", "remove_memory"];

const LAMP_BODY = "The keeper trimmed the lamp at dusk.\nThe lamp would not turn until the tide did.\n";
const TIDE_BODY = "The tide clock struck eleven.\nNobody in the house had wound it for a year.\n";
const REVISED =
  "The tide clock struck twelve.\nNobody in the house had wound it for a year.\nSomeone had wound it tonight.\n";
const STALE = "The tide clock struck one.\nThis line comes from an old read and must not replace the newer text.\n";
const FIND = "Someone had wound it tonight.";
const REPLACE = "Someone had wound it tonight, and left the key in the lock.";
const STALE_AGAIN = "The tide clock struck two.\nThis line was read before the MCP write and must not replace it.\n";

const temp = await mkdtemp(join(tmpdir(), "studio-toolkit-e2e-"));
const profile = join(temp, "profile");
const libraryRoot = join(temp, "library");
const scratch = join(temp, "scratch");
const backendFile = join(temp, "backend.json");
const bookDir = join(libraryRoot, "books", BOOK);
const tidePath = join(bookDir, "chapters", "0002-the-tide-clock.md");

const now = "2026-10-26T12:00:00.000Z";
function chapterFile(id, title, order, body) {
  return `---\nid: ${id}\ntitle: ${title}\norder: ${order}\nversion: 1\ncreatedAt: ${now}\nupdatedAt: ${now}\n---\n\n${body}`;
}

await mkdir(profile, { recursive: true });
await mkdir(scratch, { recursive: true });
await mkdir(join(bookDir, "chapters"), { recursive: true });
await writeFile(
  join(bookDir, "book.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: BOOK,
      title: "The Tide Clock",
      description: "A synthetic book for the toolkit check.",
      stage: "drafting",
      createdAt: now,
      updatedAt: now
    },
    null,
    2
  )}\n`
);
await writeFile(join(bookDir, "chapters", "0001-the-lamp.md"), chapterFile(LAMP, "The Lamp", 1, LAMP_BODY));
await writeFile(tidePath, chapterFile(TIDE, "The Tide Clock", 2, TIDE_BODY));
await writeFile(join(profile, "studio.json"), `${JSON.stringify({ libraryRoot }, null, 2)}\n`);

/*
 * Both processes inherit just the host fields they need. The toolkit is pinned to the fixture's
 * locator and receives its URL and token explicitly.
 */
const toolEnv = { ...headlessEnvironment(process.env), STUDIO_BACKEND_FILE: backendFile };

const appEnv = {
  ...headlessDesktopEnvironment(process.env, profile),
  STUDIO_BACKEND_FILE: backendFile,
  STUDIO_BACKEND: "1",
  STUDIO_WINDOW_SIZE: "1440x900"
};

const notes = [];
const problems = [];
const gaps = [];
function check(what, ok, detail) {
  if (ok) notes.push(what);
  else problems.push(detail ? `${what} — ${String(detail).trim().slice(0, 200)}` : what);
}

/**
 * Something the film says that the product does not do yet. It is reported on every run and never
 * as a pass while it is open; the day the product does it, it becomes an ordinary pass. It does not
 * fail the run, because what spec 025 asks for (FR-004, FR-013, scenario 3) is the refusal, and the
 * checks prove that.
 */
function gap(what, kept, why) {
  if (kept) notes.push(what);
  else gaps.push(`${what} — ${why}`);
}

const children = new Set();
let locator = null;

/** Run the compiled CLI against this run's studio. */
function bookwriter(args) {
  return new Promise((done) => {
    const child = spawn(cli, [...args, "--url", locator.url, "--token", locator.token], {
      cwd: root,
      env: toolEnv
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 30_000);
    const finish = (code) => {
      clearTimeout(timer);
      children.delete(child);
      done({ code, stdout, stderr });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (error) => {
      stderr += String(error);
      finish(-1);
    });
  });
}

/** Start `bookwriter mcp` and speak newline-delimited JSON-RPC to it, as an MCP client would. */
async function mcpServer(flags) {
  const child = spawn(cli, ["mcp", ...flags, "--url", locator.url, "--token", locator.token], {
    cwd: root,
    env: toolEnv
  });
  children.add(child);
  const waiting = new Map();
  let stderr = "";
  let next = 0;
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    waiting.get(message.id)?.(message);
  });
  child.on("close", () => {
    children.delete(child);
    for (const settle of [...waiting.values()]) settle({ error: { code: 0, message: "the MCP server exited" } });
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method, params = {}) =>
    new Promise((done) => {
      next += 1;
      const id = next;
      const timer = setTimeout(() => settle({ error: { code: 0, message: `${method} timed out` } }), 30_000);
      function settle(message) {
        clearTimeout(timer);
        waiting.delete(id);
        done(message);
      }
      waiting.set(id, settle);
      send({ id, method, params });
    });
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "toolkit-e2e", version: "0.1.0" }
  });
  // A notification has no reply, so nothing waits for one.
  send({ method: "notifications/initialized" });
  return {
    initialized,
    request,
    stderr: () => stderr,
    close: () =>
      new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        const timer = setTimeout(() => child.kill(), 5_000);
        child.once("close", () => {
          clearTimeout(timer);
          done();
        });
        child.stdin.end();
      })
  };
}

const toolNames = (response) => (response.result?.tools ?? []).map((tool) => tool.name);
function toolJson(response) {
  try {
    return JSON.parse(response.result?.content?.[0]?.text ?? "");
  } catch {
    return null;
  }
}
function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const versionOf = (bytes) => Number(/^version: (\d+)$/m.exec(bytes.toString("utf8"))?.[1] ?? Number.NaN);
async function conflictCopies() {
  const folder = join(bookDir, "conflicts");
  const files = existsSync(folder) ? (await readdir(folder)).filter((name) => name.endsWith(".md")) : [];
  return Promise.all(files.map(async (name) => ({ name, text: await readFile(join(folder, name), "utf8") })));
}

async function waitForLocator() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      return JSON.parse(await readFile(backendFile, "utf8"));
    } catch {
      await delay(250);
    }
  }
  return null;
}

/**
 * Turn the tool off the way the author does: open the book, open the Agent dialog, flip the switch.
 * Returns why it could not, or null.
 */
async function withdrawInTheDialog(page) {
  const wait = (selector) =>
    page.waitForSelector(selector, { state: "attached", timeout: 30_000 }).then(
      () => true,
      () => false
    );
  const click = (selector) =>
    page.evaluate((target) => {
      const element = document.querySelector(target);
      if (!element) return false;
      element.click();
      return true;
    }, selector);
  if (!(await wait('[data-testid="book-card"]'))) return "the library never listed the book";
  await click('[data-testid="book-card"]');
  if (!(await wait('[data-testid="open-agent"]'))) return "the workspace never offered the Agent dialog";
  await click('[data-testid="open-agent"]');
  const toggle = `[data-testid="agent-tool-${WITHDRAWN}"]`;
  if (!(await wait(toggle))) return `the Agent dialog has no switch for ${WITHDRAWN}`;
  if (!(await page.evaluate((target) => document.querySelector(target)?.getAttribute("aria-checked") === "true", toggle))) {
    return `${WITHDRAWN} was already off`;
  }
  await click(toggle);
  const off = await page
    .waitForFunction(
      (name) => document.querySelector('[data-testid="agent-withdrawn-tools"]')?.textContent?.includes(name) === true,
      WITHDRAWN,
      { timeout: 30_000 }
    )
    .then(
      () => true,
      () => false
    );
  return off ? null : "the dialog never said the tool was off";
}

async function prove(page) {
  // The toolkit is talking to this run's studio, over the library it opened, and to nothing else.
  const library = json((await bookwriter(["info", "--json"])).stdout);
  const sameRoot =
    typeof library?.root === "string" &&
    (await realpath(library.root).catch(() => "")) === (await realpath(libraryRoot));
  check("the toolkit reaches the hidden studio and the library it opened", sameRoot, JSON.stringify(library));
  const books = json((await bookwriter(["books", "--json"])).stdout);
  check("bookwriter books lists the book", Array.isArray(books) && books.some((book) => book.id === BOOK));

  // One MCP server, started before anything changes and kept running to the end.
  const reader = await mcpServer([]);
  check(
    "the MCP server initializes over stdio",
    reader.initialized.result?.serverInfo?.name === "ai-book-studio",
    JSON.stringify(reader.initialized)
  );
  check("the MCP server says it is read-only", /\(read-only\)/.test(reader.stderr()), reader.stderr());
  const readOnly = toolNames(await reader.request("tools/list"));
  check(
    "MCP lists the read tools",
    ["read_chapter", WITHDRAWN, "find_in_chapters", "table_of_contents", "studio_status"].every((name) =>
      readOnly.includes(name)
    ),
    readOnly.join(", ")
  );
  check(
    "a read-only MCP server leaves every write and destructive tool out",
    readOnly.length > 0 && [...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS].every((name) => !readOnly.includes(name)),
    readOnly.join(", ")
  );

  // Before the switch, both surfaces run the tool, so the refusal later is the switch's doing.
  const findArgs = { chapterId: LAMP, query: "lamp" };
  const cliBefore = await bookwriter(["call", BOOK, WITHDRAWN, "--allow-writes", "--args", JSON.stringify(findArgs)]);
  check(
    `before the switch, bookwriter call runs ${WITHDRAWN}`,
    cliBefore.code === 0 && json(cliBefore.stdout)?.total === 2,
    cliBefore.stderr || cliBefore.stdout
  );
  const mcpBefore = await reader.request("tools/call", { name: WITHDRAWN, arguments: { bookId: BOOK, ...findArgs } });
  check(
    `before the switch, MCP tools/call runs ${WITHDRAWN}`,
    !mcpBefore.error && mcpBefore.result?.isError !== true && toolJson(mcpBefore)?.total === 2,
    JSON.stringify(mcpBefore)
  );

  // The CLI reads what is on disk, and its hash is the hash of those exact bytes.
  const original = await readFile(tidePath);
  const read = await bookwriter(["read", BOOK, TIDE, "--json"]);
  const chapter = json(read.stdout);
  check("bookwriter read returns the chapter", read.code === 0 && chapter?.content === TIDE_BODY, read.stderr);
  check(
    "the read's version and hash are the file's: version 1, SHA-256 of the bytes on disk",
    chapter?.version === 1 && chapter?.hash === sha256(original)
  );
  const plain = await bookwriter(["read", BOOK, TIDE]);
  check(
    "the plain read prints the prose to stdout and the version and hash to stderr",
    plain.code === 0 && plain.stdout === TIDE_BODY && plain.stderr.includes(`version 1 · hash ${chapter?.hash}`),
    plain.stderr
  );
  const baseHash = chapter?.hash ?? "0".repeat(64);

  // Nothing writes without --allow-writes.
  const revisedFile = join(scratch, "revised.md");
  await writeFile(revisedFile, REVISED);
  const withoutFlag = await bookwriter([
    "save",
    BOOK,
    TIDE,
    "--content-file",
    revisedFile,
    "--base-version",
    "1",
    "--base-hash",
    baseHash
  ]);
  check(
    "save without --allow-writes is refused and the file is untouched",
    withoutFlag.code !== 0 &&
      /requires --allow-writes/.test(withoutFlag.stderr) &&
      (await readFile(tidePath)).equals(original),
    withoutFlag.stderr
  );
  const createWithoutFlag = await bookwriter(["create-chapter", BOOK, "--title", "Three", "--content-file", revisedFile]);
  check(
    "create-chapter without --allow-writes is refused and no chapter appears",
    createWithoutFlag.code !== 0 &&
      /requires --allow-writes/.test(createWithoutFlag.stderr) &&
      (await readdir(join(bookDir, "chapters"))).length === 2,
    createWithoutFlag.stderr
  );
  const callWithoutFlag = await bookwriter(["call", BOOK, "find_in_chapters", "--args", JSON.stringify({ query: "tide" })]);
  check(
    "call without --allow-writes is refused",
    callWithoutFlag.code !== 0 && /requires --allow-writes/.test(callWithoutFlag.stderr),
    callWithoutFlag.stderr
  );

  // A checked save with the read's version and hash changes the bytes on disk.
  const saved = await bookwriter([
    "save",
    BOOK,
    TIDE,
    "--allow-writes",
    "--content-file",
    revisedFile,
    "--base-version",
    "1",
    "--base-hash",
    baseHash
  ]);
  const afterSave = await readFile(tidePath);
  const savedLine = /^Saved (\S+) · version (\d+) · hash ([a-f0-9]{64})$/m.exec(saved.stdout);
  check(
    "a checked save with the read's version and hash succeeds",
    saved.code === 0 && savedLine?.[1] === TIDE && savedLine?.[2] === "2",
    saved.stderr || saved.stdout
  );
  check(
    "the save changes the bytes on disk to the new text, at version 2",
    !afterSave.equals(original) && afterSave.toString("utf8").endsWith(`\n\n${REVISED}`) && versionOf(afterSave) === 2
  );
  check("the hash the save prints is the SHA-256 of the new bytes", savedLine?.[3] === sha256(afterSave));

  // A stale save with the old version and hash becomes a conflict copy and never overwrites.
  const staleFile = join(scratch, "stale.md");
  await writeFile(staleFile, STALE);
  const stale = await bookwriter([
    "save",
    BOOK,
    TIDE,
    "--allow-writes",
    "--content-file",
    staleFile,
    "--base-version",
    "1",
    "--base-hash",
    baseHash
  ]);
  const staleCopy = /^Not saved: newer-version · your text is in (\S+)$/m.exec(stale.stderr)?.[1];
  check("a stale save with the old version and hash is refused (exit 2, newer-version)", stale.code === 2 && Boolean(staleCopy), stale.stderr);
  check("the stale save leaves the newer text byte for byte", (await readFile(tidePath)).equals(afterSave));
  const firstCopies = await conflictCopies();
  check(
    "the stale text is kept as one conflict copy in conflicts/",
    firstCopies.length === 1 &&
      firstCopies[0].name.includes(".conflict-newer-version.") &&
      firstCopies[0].text.endsWith(`\n\n${STALE}`) &&
      staleCopy === `books/${BOOK}/conflicts/${firstCopies[0].name}`,
    firstCopies.map((copy) => copy.name).join(", ")
  );
  const listed = json((await bookwriter(["conflicts", BOOK, "--json"])).stdout);
  check(
    "bookwriter conflicts lists the copy",
    Array.isArray(listed) && listed.some((conflict) => conflict.savedAs === staleCopy),
    JSON.stringify(listed)
  );

  // MCP reads the same book: the text the CLI saved, not a copy of its own.
  const mcpRead = await reader.request("tools/call", { name: "read_chapter", arguments: { bookId: BOOK, chapterId: TIDE } });
  check("MCP read_chapter returns the text the CLI saved", toolJson(mcpRead)?.text === REVISED, JSON.stringify(mcpRead));
  const refusedWrite = await reader.request("tools/call", {
    name: "append_to_chapter",
    arguments: { bookId: BOOK, chapterId: TIDE, text: "This line must not land." }
  });
  check(
    "a read-only MCP server refuses a write tool, and the file is untouched",
    refusedWrite.error?.message === "Unknown tool: append_to_chapter" && (await readFile(tidePath)).equals(afterSave),
    JSON.stringify(refusedWrite)
  );

  /*
   * With --allow-writes, an MCP write goes through the same checked save. MCP clients do not hold a
   * version or a hash (read_chapter returns neither): the tool reads and saves inside the studio. So
   * the stale writer here is the CLI, holding the version and hash from before the MCP write.
   */
  const writer = await mcpServer(["--allow-writes"]);
  const writable = toolNames(await writer.request("tools/list"));
  check(
    "--allow-writes adds the write tools to MCP, and not the destructive ones",
    ["append_to_chapter", "replace_in_chapter", "create_chapter"].every((name) => writable.includes(name)) &&
      DESTRUCTIVE_TOOLS.every((name) => !writable.includes(name)),
    writable.join(", ")
  );
  const replaced = await writer.request("tools/call", {
    name: "replace_in_chapter",
    arguments: { bookId: BOOK, chapterId: TIDE, find: FIND, replace: REPLACE }
  });
  await writer.close();
  const afterMcp = await readFile(tidePath);
  check(
    "an MCP write lands on disk through the studio, at version 3",
    toolJson(replaced)?.ok === true && afterMcp.toString("utf8").includes(REPLACE) && versionOf(afterMcp) === 3,
    JSON.stringify(replaced)
  );
  const staleAgainFile = join(scratch, "stale-again.md");
  await writeFile(staleAgainFile, STALE_AGAIN);
  const staleAgain = await bookwriter([
    "save",
    BOOK,
    TIDE,
    "--allow-writes",
    "--content-file",
    staleAgainFile,
    "--base-version",
    "2",
    "--base-hash",
    savedLine?.[3] ?? "0".repeat(64)
  ]);
  check(
    "a CLI save from before the MCP write is refused, and the MCP write survives",
    staleAgain.code === 2 && /newer-version/.test(staleAgain.stderr) && (await readFile(tidePath)).equals(afterMcp),
    staleAgain.stderr
  );
  const secondCopies = await conflictCopies();
  check(
    "both stale texts are kept as conflict copies",
    secondCopies.length === 2 && secondCopies.some((copy) => copy.text.endsWith(`\n\n${STALE_AGAIN}`))
  );
  const reread = json((await bookwriter(["read", BOOK, TIDE, "--json"])).stdout);
  check(
    "the CLI reads the MCP write: version 3 and the hash of the bytes on disk",
    reread?.version === 3 && reread?.hash === sha256(afterMcp) && reread?.content.includes(REPLACE)
  );

  // The switch, in the real Agent dialog.
  const failure = await withdrawInTheDialog(page);
  check("the Agent dialog's switch turns the tool off for this book", failure === null, failure);
  if (failure) {
    // Carry on through the app's own bridge, so one broken click does not hide the checks below.
    await page.evaluate(
      ({ bookId, name }) => window.studio.agent.setSettings(bookId, { disabledTools: [name] }),
      { bookId: BOOK, name: WITHDRAWN }
    );
  }
  const book = json(await readFile(join(bookDir, "book.json"), "utf8"));
  check(
    "the book records the withdrawn tool in book.json",
    JSON.stringify(book?.settings?.agent?.disabledTools) === JSON.stringify([WITHDRAWN]),
    JSON.stringify(book?.settings?.agent ?? null)
  );

  const cliAfter = await bookwriter(["call", BOOK, WITHDRAWN, "--allow-writes", "--args", JSON.stringify(findArgs)]);
  check(
    `bookwriter call refuses it: “${REFUSAL}”`,
    cliAfter.code !== 0 && cliAfter.stderr.includes(REFUSAL) && cliAfter.stdout === "",
    cliAfter.stderr || cliAfter.stdout
  );
  const perBook = await fetch(`${locator.url}/v1/books/${BOOK}/tools`, {
    headers: { authorization: `Bearer ${locator.token}` }
  })
    .then((response) => response.json())
    .catch(() => null);
  const perBookNames = (perBook?.tools ?? []).map((tool) => tool.name);
  check(
    "the studio's list for this book leaves it out and keeps the rest",
    perBookNames.includes("find_in_chapters") && !perBookNames.includes(WITHDRAWN),
    perBookNames.join(", ")
  );
  // The same server that ran the tool before the switch: the check is made on every call.
  const mcpAfter = await reader.request("tools/call", { name: WITHDRAWN, arguments: { bookId: BOOK, ...findArgs } });
  check(`MCP tools/call refuses it: “${REFUSAL}”`, mcpAfter.error?.message === REFUSAL, JSON.stringify(mcpAfter));
  const sibling = await bookwriter(["call", BOOK, "find_in_chapters", "--allow-writes", "--args", JSON.stringify({ query: "lamp" })]);
  check(
    "the other tools still run: withdrawing one tool withdraws only that one",
    sibling.code === 0 && json(sibling.stdout)?.ok === true,
    sibling.stderr
  );
  await reader.close();

  // The lists. Neither names a book, so neither can leave a book's withdrawn tool out.
  const fresh = await mcpServer([]);
  const freshList = toolNames(await fresh.request("tools/list"));
  await fresh.close();
  check("a server started after the switch still lists the read tools", freshList.includes("find_in_chapters"), freshList.join(", "));
  gap(
    `MCP tools/list leaves ${WITHDRAWN} out`,
    !freshList.includes(WITHDRAWN),
    "a server started after the switch still lists it: tools/list names no book, so only tools/call refuses it"
  );
  const catalog = json((await bookwriter(["tools", "--json"])).stdout);
  const catalogNames = Array.isArray(catalog) ? catalog.map((tool) => tool.name) : [];
  check("bookwriter tools prints the studio's catalog", catalogNames.includes("find_in_chapters"), catalogNames.join(", "));
  gap(
    `bookwriter tools leaves ${WITHDRAWN} out`,
    !catalogNames.includes(WITHDRAWN),
    "it prints the library-wide catalog, not the book's"
  );
}

const electronPath = createRequire(join(appDir, "package.json"))("electron");
const { _electron } = await import("playwright");
let app = null;
try {
  app = await _electron.launch({ executablePath: electronPath, args: [...mockKeychainArgs(), appDir], cwd: appDir, env: appEnv });
  const page = await app.firstWindow();
  locator = await waitForLocator();
  if (!locator) problems.push("the backend never wrote its locator file");
  else await prove(page);
} catch (error) {
  problems.push(`the check stopped early: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const child of children) child.kill();
  if (app) {
    const closed = await Promise.race([
      app.close().then(
        () => true,
        () => false
      ),
      delay(20_000).then(() => false)
    ]);
    if (!closed) app.process()?.kill("SIGKILL");
  }
  await rm(temp, { recursive: true, force: true });
}

for (const line of notes) console.log(`[toolkit] ok    ${line}`);
for (const line of gaps) console.log(`[toolkit] gap   ${line}`);
for (const line of problems) console.log(`[toolkit] fix   ${line}`);
if (gaps.length > 0) {
  console.log(`[toolkit] ${gaps.length} known gap${gaps.length === 1 ? "" : "s"}: reported, not failed`);
}
console.log(problems.length === 0 ? "[toolkit] the CLI and MCP keep the author's rules" : "[toolkit] needs attention");
process.exit(problems.length === 0 ? 0 : 1);
