#!/usr/bin/env node
/**
 * One real agent turn through the built app, against a fake provider on loopback (spec 012 T034,
 * D-184).
 *
 * The app runs hidden with the in-memory credential vault, so the author's keychain is never asked
 * and no key can reach the disk. A Meta connection points at an OpenAI-compatible server this
 * script starts on 127.0.0.1. The server plays the model: it reads the chapter, appends a sentence
 * and replies, and later asks to overwrite the chapter, which must wait for approval. The check
 * reads what happened from the library on disk: the chapter and its version, the stored
 * conversation, the usage line and the undo. A background turn then finishes after the window has
 * closed, and the window the dock makes again opens on that conversation, with no review of the
 * studio's own files over it (017 FR-012). Last, it proves the fake was the only place a request
 * went, and that the key is in no file and no log line.
 *
 * A hidden window is never visible, so a finished turn would post a real desktop notification. The
 * check turns notifications off inside the app before the first turn, and stops if it cannot.
 *
 *   bun run build
 *   node scripts/agent-check.mjs                      # or: bun run e2e agent
 *   AGENT_CHECK_KEEP=1 node scripts/agent-check.mjs   # keep the temp folder for inspection
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headlessDesktopEnvironment, mockKeychainArgs } from "./headless-environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "desktop");

if (!existsSync(join(appDir, "out", "main", "index.cjs"))) {
  console.error("[agent] No build found. Run `bun run build` first.");
  process.exit(1);
}

const BOOK = "book_agentcheck01";
const MODEL = "muse-spark-1.3";
const MODEL_NAME = "Muse Spark 1.3";
const LABEL = "Meta (fake e2e server)";
// A dummy key, new every run, so finding it anywhere on disk can only mean this run leaked it.
const KEY = `agent-check-${randomBytes(16).toString("hex")}`;

const OPENING = [
  "The lighthouse keeper counted the gulls and wrote the number in the margin.",
  "By evening the count was wrong again, and the lamp was the only thing that still agreed with him."
];
const PROSE_MARK = "counted the gulls";
const SENTENCE = "At midnight the lamp turned once, as if someone below had remembered it.";
const SHORT_VERSION = "The lamp turned once at midnight, and the keeper wrote it down.";
const TURN_ONE = "Read the opening chapter and add one sentence about the lamp at the end.";
const TURN_TWO = "Replace the whole opening chapter with the short version.";
const TURN_THREE = "Keep going while I am away: add one line about the gulls.";
const REPLY_ONE = "I read “The Light” and added one sentence about the lamp at the end.";
const REPLY_TWO = "I replaced “The Light” with the short version you approved.";
const GULLS = "By morning the gulls had settled, and the count finally held.";
const REPLY_THREE = "The scene is ready. I added one line about the gulls to “The Light”.";

/** What the fake reports for each scripted step; the turn's usage must be their sum. */
const USAGE = {
  read: { prompt: 120, completion: 14 },
  append: { prompt: 260, completion: 38 },
  reply: { prompt: 310, completion: 22 },
  overwrite: { prompt: 300, completion: 60 },
  approved: { prompt: 360, completion: 18 },
  background: { prompt: 280, completion: 30 },
  "background reply": { prompt: 330, completion: 20 }
};
const TURN_ONE_STEPS = ["read", "append", "reply"];
const sum = (steps, field) => steps.reduce((total, step) => total + USAGE[step][field], 0);

const notes = [];
const problems = [];
function check(what, ok, detail) {
  const line = detail === undefined || detail === "" ? what : `${what} — ${detail}`;
  if (ok) notes.push(line);
  else problems.push(line);
}

/** Never print the key, even inside an error a failing step passed through. */
function redact(text) {
  return String(text).split(KEY).join("[dummy key]");
}

/** Wait for something to become true, or give up. */
async function waitFor(read, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((wait) => setTimeout(wait, 200));
  }
  return null;
}

/* ------------------------------------------------------------------ the fake provider */

const CREATED = 1_767_225_600;

function chunk(delta, finish = null) {
  return {
    id: "chatcmpl-agent-check",
    object: "chat.completion.chunk",
    created: CREATED,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }]
  };
}

function usageChunk(step) {
  const { prompt, completion } = USAGE[step];
  return {
    id: "chatcmpl-agent-check",
    object: "chat.completion.chunk",
    created: CREATED,
    model: MODEL,
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  };
}

function toolCall(step, name, args) {
  return {
    step,
    events: [
      chunk({
        role: "assistant",
        content: null,
        tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      }),
      chunk({}, "tool_calls"),
      usageChunk(step)
    ]
  };
}

function reply(step, text) {
  const middle = Math.floor(text.length / 2);
  return {
    step,
    events: [
      chunk({ role: "assistant", content: text.slice(0, middle) }),
      chunk({ content: text.slice(middle) }),
      chunk({}, "stop"),
      usageChunk(step)
    ]
  };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  return "";
}

function toolNameFor(messages, callId) {
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) if (call?.id === callId) return call.function?.name ?? null;
  }
  return null;
}

/** The script, read from the conversation's last message rather than from a request counter. */
function nextStep(messages, chapterId) {
  const last = messages.at(-1);
  if (!chapterId) return { step: "before the chapter existed" };
  const asked = textOf(messages.findLast((message) => message?.role === "user")?.content);
  if (asked.includes(TURN_THREE)) {
    if (last?.role === "user") return toolCall("background", "append_to_chapter", { chapterId, text: GULLS });
    if (last?.role === "tool") return reply("background reply", REPLY_THREE);
  }
  if (last?.role === "tool") {
    const name = toolNameFor(messages, last.tool_call_id);
    if (name === "read_chapter") return toolCall("append", "append_to_chapter", { chapterId, text: SENTENCE });
    if (name === "append_to_chapter") return reply("reply", REPLY_ONE);
    if (name === "overwrite_chapter") return reply("approved", REPLY_TWO);
    return { step: `after a result from ${name ?? "an unknown tool"}` };
  }
  if (last?.role === "user") {
    return textOf(last.content).includes("short version")
      ? toolCall("overwrite", "overwrite_chapter", { chapterId, content: SHORT_VERSION })
      : toolCall("read", "read_chapter", { chapterId });
  }
  return { step: `after a ${last?.role ?? "missing"} message` };
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

/**
 * An OpenAI-compatible server on loopback: `GET /v1/models` and a streaming
 * `POST /v1/chat/completions`, the two paths the studio's Meta adapter calls. It records each
 * request's method, path, whether it carried authorization (and whether that was this run's key,
 * as a yes or no), and its size. It never keeps a header value or a body.
 */
async function startFakeProvider() {
  const requests = [];
  // `hold`, while set, keeps the background turn's first answer back, so the window can close first.
  const state = { chapterId: null, hold: null };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (part) => chunks.push(part));
    request.on("end", async () => {
      const body = Buffer.concat(chunks);
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const authorization = request.headers.authorization;
      const entry = {
        method: request.method ?? "",
        path,
        authorization: authorization ? "present" : "absent",
        keyMatches: authorization === `Bearer ${KEY}`,
        bytes: body.length,
        step: null
      };
      requests.push(entry);
      if (request.method === "GET" && path === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: [{ id: MODEL, object: "model", created: CREATED, owned_by: "meta" }]
        });
        return;
      }
      if (request.method === "POST" && path === "/v1/chat/completions") {
        let payload = null;
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          entry.step = "unreadable body";
          sendJson(response, 400, { error: { message: "The fake provider could not read the request." } });
          return;
        }
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        entry.stream = payload?.stream === true;
        entry.tools = (payload?.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
        entry.roles = messages.map((message) => message?.role);
        entry.prose = body.includes(Buffer.from(PROSE_MARK));
        const scripted = nextStep(messages, state.chapterId);
        entry.step = scripted.step;
        if (!scripted.events) {
          sendJson(response, 500, { error: { message: `The fake provider has no script ${scripted.step}.` } });
          return;
        }
        if (scripted.step === "background" && state.hold) await state.hold;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for (const event of scripted.events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      entry.step = "unknown route";
      sendJson(response, 404, { error: { message: "Unknown route." } });
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    requests,
    state,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      })
  };
}

/* ------------------------------------------------------------------------ files on disk */

/** The front matter and body of a chapter file, and its version. */
function chapterParts(bytes) {
  const end = bytes.indexOf("\n---\n", 3);
  const front = bytes.subarray(0, end).toString("utf8");
  const body = bytes.subarray(end + "\n---\n".length);
  return { body, text: body.toString("utf8"), version: Number(/^version:\s*(\d+)\s*$/m.exec(front)?.[1]) };
}

/** True when two files differ only on lines that start with one of `prefixes`. */
function differOnlyOn(a, b, prefixes) {
  const left = a.toString("utf8").split("\n");
  const right = b.toString("utf8").split("\n");
  if (left.length !== right.length) return false;
  return left.every(
    (line, index) =>
      line === right[index] ||
      prefixes.some((prefix) => line.startsWith(prefix) && right[index].startsWith(prefix))
  );
}

async function filesUnder(dir) {
  const files = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Every file under `dir` that holds the key as UTF-8, UTF-16 or base64. */
async function keyLeaks(dir) {
  const needles = [
    Buffer.from(KEY, "utf8"),
    Buffer.from(KEY, "utf16le"),
    Buffer.from(Buffer.from(KEY, "utf8").toString("base64"), "utf8")
  ];
  const leaks = [];
  for (const file of await filesUnder(dir)) {
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      continue;
    }
    if (needles.some((needle) => bytes.includes(needle))) leaks.push(relative(dir, file));
  }
  return leaks;
}

/* ---------------------------------------------------------------------------- the run */

const temp = await mkdtemp(join(tmpdir(), "studio-agent-check-"));
const profile = join(temp, "profile");
const libraryRoot = join(temp, "library");
const backendFile = join(temp, "backend.json");
const bookDir = join(libraryRoot, "books", BOOK);

await mkdir(profile, { recursive: true });
await mkdir(join(bookDir, "chapters"), { recursive: true });
const now = "2026-11-03T12:00:00.000Z";
await writeFile(
  join(bookDir, "book.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: BOOK,
      title: "The Salt Road",
      description: "A synthetic fixture for the agent check.",
      stage: "drafting",
      createdAt: now,
      updatedAt: now
    },
    null,
    2
  )}\n`
);
await writeFile(join(profile, "studio.json"), `${JSON.stringify({ libraryRoot }, null, 2)}\n`);

const env = headlessDesktopEnvironment(process.env, profile, "memory");
env.STUDIO_BACKEND = "1";
env.STUDIO_BACKEND_FILE = backendFile;

const fake = await startFakeProvider();
const electronPath = createRequire(join(appDir, "package.json"))("electron");
const { _electron } = await import("playwright");

let app = null;
let appOutput = "";
const rendererRequests = [];
let observed = null;
let safeStorageGuarded = false;
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
  await fake.close();
  if (process.env.AGENT_CHECK_KEEP) console.log(`[agent] kept ${temp}`);
  else await rm(temp, { recursive: true, force: true }).catch(() => {});
}

// A wedged run must still leave nothing behind.
const watchdog = setTimeout(() => {
  if (finished) return;
  console.error("[agent] Timed out after 240s; stopping the run.");
  void cleanUp().finally(() => process.exit(1));
}, 240_000);

async function journey() {
  app = await _electron.launch({ executablePath: electronPath, args: [...mockKeychainArgs(), appDir], cwd: appDir, env });
  const child = app.process();
  child.stdout?.on("data", (part) => {
    appOutput += part.toString("utf8");
  });
  child.stderr?.on("data", (part) => {
    appOutput += part.toString("utf8");
  });
  const page = await app.firstWindow();

  /*
   * Inside the app, before anything reaches a provider:
   * - notifications off, read back, because a hidden window always counts as "away";
   * - every safeStorage method replaced by one that refuses and counts, so the keychain cannot be
   *   asked even by mistake;
   * - an observer on the main process's outbound HTTP, so "only the fake" is measured, not assumed.
   */
  const guards = await app.evaluate(({ Notification, safeStorage }) => {
    const record = { asked: 0, safeStorage: [], guarded: [], outbound: [] };
    globalThis.__agentCheck = record;
    Notification.isSupported = () => {
      record.asked += 1;
      return false;
    };
    const notificationsOff = Notification.isSupported() === false;
    record.asked = 0;

    const names = new Set([
      "isEncryptionAvailable",
      "isAsyncEncryptionAvailable",
      "encryptString",
      "decryptString",
      "encryptStringAsync",
      "decryptStringAsync",
      ...Object.keys(safeStorage)
    ]);
    for (const name of names) {
      if (typeof safeStorage[name] !== "function") continue;
      const refuse = () => {
        record.safeStorage.push(name);
        throw new Error("The agent check does not allow safeStorage.");
      };
      try {
        safeStorage[name] = refuse;
      } catch {
        // A method that cannot be replaced stays unguarded; the check reports it.
      }
      if (safeStorage[name] === refuse) record.guarded.push(name);
    }

    const channels = process.getBuiltinModule?.("node:diagnostics_channel") ?? null;
    if (channels) {
      const fetches = channels.channel("undici:request:create");
      const requests = channels.channel("http.client.request.start");
      const onFetch = ({ request }) => {
        record.outbound.push({ origin: String(request.origin), method: String(request.method), path: String(request.path).split("?")[0] });
      };
      const onRequest = ({ request }) => {
        const host = request.getHeader?.("host") ?? request.host;
        record.outbound.push({ origin: `${request.protocol}//${host}`, method: String(request.method), path: String(request.path).split("?")[0] });
      };
      fetches.subscribe(onFetch);
      requests.subscribe(onRequest);
      // Held so the subscriptions live as long as the run.
      globalThis.__agentCheckChannels = [fetches, onFetch, requests, onRequest];
    }
    return { notificationsOff, guarded: record.guarded, observing: channels !== null };
  });
  if (!guards.notificationsOff) {
    throw new Error("Could not turn desktop notifications off inside the app, so no turn was run.");
  }
  // The vault never reaches safeStorage; the guard is extra evidence, so a method it cannot
  // replace leaves that claim unproven rather than failing the run.
  safeStorageGuarded = guards.guarded.length > 0;
  notes.push(
    safeStorageGuarded
      ? `inside the app, desktop notifications are off and ${guards.guarded.length} safeStorage methods refuse every call`
      : "inside the app, desktop notifications are off; safeStorage could not be guarded, so “nothing called it” is unproven"
  );
  check("the main process's outbound requests are observed", guards.observing);

  const recordRequest = (request) => {
    const url = request.url();
    if (/^(https?|wss?):/i.test(url)) rendererRequests.push(url);
  };
  page.on("request", recordRequest);
  // A window the studio makes again, after a background turn, is watched from its first request.
  app.on("window", (opened) => opened.on("request", recordRequest));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.studio?.connections), null, { timeout: 30_000 });

  /** Call the preload bridge the way the interface does, and unwrap its result envelope. */
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
    if (!result?.ok) throw new Error(`${path} failed: ${redact(result?.error?.message ?? "no answer")}`);
    return result.data;
  }

  const locator = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(backendFile, "utf8"));
    } catch {
      return null;
    }
  }, 30_000);
  if (!locator) throw new Error("The control plane never wrote its locator file.");

  async function backend(method, path, body) {
    const response = await fetch(`${locator.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${locator.token}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`${method} ${path} answered ${response.status}: ${redact(payload?.error?.message ?? "no message")}`);
    }
    return payload;
  }

  // The chapter goes in through the library, so its file is canonical before the turn touches it.
  const { chapter } = await backend("POST", `/v1/books/${BOOK}/chapters`, {
    title: "The Light",
    content: OPENING.join("\n\n")
  });
  fake.state.chapterId = chapter.id;
  const chapterFile = join(bookDir, "chapters", chapter.path);
  const original = await readFile(chapterFile);
  const originalParts = chapterParts(original);

  // 1. The vault, then a Meta connection whose base URL is the fake, through the app's own channel.
  const status = await studio("connections.status");
  check(
    "the app keeps connections in the in-memory test vault",
    status?.backend === "In-memory test vault" && status.available === true,
    status?.backend
  );
  const connection = await studio("connections.addKey", {
    provider: "meta",
    secret: KEY,
    label: LABEL,
    baseUrl: fake.baseUrl
  });
  check("a Meta connection is added through the app's own channel", connection?.provider === "meta" && connection.label === LABEL);
  check("the interface receives a summary, never the key", !JSON.stringify(await studio("connections.list")).includes(KEY));

  // 2. The fake model becomes the book's default.
  await studio("books.update", BOOK, { defaultProvider: "meta", defaultConnectionId: connection.id, defaultModelId: MODEL });
  const book = JSON.parse(await readFile(join(bookDir, "book.json"), "utf8"));
  check(
    "the fake model is the book's default on disk",
    book.defaultProvider === "meta" && book.defaultConnectionId === connection.id && book.defaultModelId === MODEL
  );

  // 3. One real turn, through the control plane.
  const { result: turn } = await backend("POST", `/v1/books/${BOOK}/turn`, { prompt: TURN_ONE, chapterId: chapter.id });
  check("the reply text arrives", turn?.text === REPLY_ONE, redact(turn?.text ?? ""));
  check("the turn reports one changed chapter", turn?.changed === 1);

  const afterTurn = await readFile(chapterFile);
  const afterParts = chapterParts(afterTurn);
  check(
    "the chapter file on disk now ends with the sentence",
    afterParts.text === `${originalParts.text.replace(/\s+$/, "")}\n\n${SENTENCE}\n`
  );
  check(
    "its version went up by exactly one",
    afterParts.version === originalParts.version + 1,
    `${originalParts.version} → ${afterParts.version}`
  );
  const { conflicts } = await backend("GET", `/v1/books/${BOOK}/conflicts`);
  check("the save was a checked one: no conflict copy", Array.isArray(conflicts) && conflicts.length === 0);

  const threadsDir = join(bookDir, "threads");
  const threadFiles = (await readdir(threadsDir).catch(() => [])).filter((name) => name.endsWith(".json"));
  check(
    "one conversation is stored under books/<bookId>/threads/",
    threadFiles.length === 1 && threadFiles[0] === `${turn?.threadId}.json`,
    threadFiles.join(", ")
  );
  const thread = JSON.parse(await readFile(join(threadsDir, `${turn.threadId}.json`), "utf8"));
  const answer = thread.messages.find((message) => message.role === "assistant" && message.turnId === turn.turnId);
  const shape = (answer?.parts ?? []).map((part) => (part.name ? `${part.type} ${part.name}` : part.type));
  check(
    "the stored answer keeps its tool parts in order",
    JSON.stringify(shape) ===
      JSON.stringify([
        "tool-call read_chapter",
        "tool-result read_chapter",
        "tool-call append_to_chapter",
        "tool-result append_to_chapter",
        "text"
      ]),
    shape.join(" · ")
  );
  check("the stored text is the reply", answer?.parts?.at(-1)?.text === REPLY_ONE);
  check(
    "the turn names its provider, account and model",
    answer?.model?.provider === "meta" &&
      answer.model.modelId === MODEL &&
      answer.model.connectionLabel === LABEL &&
      answer.model.name === MODEL_NAME,
    answer?.model?.name
  );
  const turnInput = sum(TURN_ONE_STEPS, "prompt");
  const turnOutput = sum(TURN_ONE_STEPS, "completion");
  check(
    "the stored usage is the whole turn's reported tokens",
    answer?.usage?.inputTokens === turnInput && answer.usage.outputTokens === turnOutput,
    `${answer?.usage?.inputTokens} in · ${answer?.usage?.outputTokens} out`
  );
  check(
    "Meta reports no price, so the cost is recorded as unknown, not zero",
    answer?.usage?.costUsd === null && answer.usage.costBasis === "unknown"
  );
  check("the turn is a checkpoint in its conversation", thread.checkpointTurns?.includes(turn.turnId));

  // The done event goes out before the usage line is appended, so wait for the line.
  const usagePath = join(libraryRoot, ".studio", "usage", `${BOOK}.jsonl`);
  const usageLines = await waitFor(async () => {
    try {
      const lines = (await readFile(usagePath, "utf8")).split("\n").filter(Boolean);
      return lines.length > 0 ? lines : null;
    } catch {
      return null;
    }
  }, 15_000);
  const usage = usageLines ? JSON.parse(usageLines.at(-1)) : null;
  check(
    "the usage line names the provider, the account and the model",
    usage?.provider === "meta" && usage.connectionId === connection.id && usage.connectionLabel === LABEL && usage.modelId === MODEL
  );
  check(
    "the usage line carries the whole turn",
    usage?.inputTokens === turnInput && usage.outputTokens === turnOutput && usage.costUsd === null && usage.steps === TURN_ONE_STEPS.length,
    `${usage?.steps} steps`
  );

  // 4. Undo, through the control plane.
  const { result: undone } = await backend("POST", `/v1/books/${BOOK}/undo`);
  check("undo restores the chapter the turn changed", undone?.restored === 1 && undone.skipped === 0);
  const restored = await readFile(chapterFile);
  const restoredParts = chapterParts(restored);
  check("after undo the chapter body bytes are exactly the original", restoredParts.body.equals(originalParts.body));
  const reread = await backend("GET", `/v1/books/${BOOK}/chapters/${chapter.id}`);
  check("the library reads the original text back", reread.chapter?.content === chapter.content);
  check(
    "only the version and updatedAt lines differ from the original file",
    differOnlyOn(original, restored, ["version:", "updatedAt:"])
  );
  check(
    "the restore is a new checked save: the version moves on, never back",
    restoredParts.version === afterParts.version + 1,
    `${afterParts.version} → ${restoredParts.version}`
  );

  // 5. A destructive call waits for the author, the way the interface drives it.
  await page.evaluate(() => {
    window.__agentCheckEvents = [];
    window.studio.agent.onEvent((event) => window.__agentCheckEvents.push(event));
  });
  const started = await studio("agent.start", {
    bookId: BOOK,
    chapterId: chapter.id,
    prompt: TURN_TWO,
    mode: "edit",
    threadId: turn.threadId
  });
  const eventOf = (types) =>
    page.evaluate(
      ({ turnId, wanted }) => window.__agentCheckEvents.find((event) => event.turnId === turnId && wanted.includes(event.type)) ?? null,
      { turnId: started.turnId, wanted: types }
    );
  const paused = await waitFor(() => eventOf(["approval", "done", "error", "stopped"]), 30_000);
  check(
    "a turn that asks to overwrite the chapter pauses for approval",
    paused?.type === "approval" && paused.name === "overwrite_chapter",
    paused ? `${paused.type}${paused.name ? ` ${paused.name}` : ""}` : "no event"
  );
  check("while it waits, the chapter file is untouched", (await readFile(chapterFile)).equals(restored));
  const waiting = JSON.parse(await readFile(join(threadsDir, `${turn.threadId}.json`), "utf8"));
  const pending = waiting.messages
    .find((message) => message.turnId === started.turnId)
    ?.parts.find((part) => part.type === "approval");
  check("the waiting approval is stored with the conversation", pending?.status === "pending" && pending.name === "overwrite_chapter");

  if (paused?.type === "approval") {
    await studio("agent.approve", started.turnId, paused.approvalId, true);
    const done = await waitFor(() => eventOf(["done", "error", "stopped"]), 30_000);
    check("after approval the turn finishes with its reply", done?.type === "done" && done.text === REPLY_TWO, done?.type ?? "no event");
    const replaced = chapterParts(await readFile(chapterFile));
    check(
      "only after approval is the chapter replaced, in one checked save",
      replaced.text.trim() === SHORT_VERSION && replaced.version === restoredParts.version + 1,
      `${restoredParts.version} → ${replaced.version}`
    );
    const approvedThread = JSON.parse(await readFile(join(threadsDir, `${turn.threadId}.json`), "utf8"));
    const approved = approvedThread.messages
      .find((message) => message.turnId === started.turnId)
      ?.parts.find((part) => part.type === "approval");
    check("the stored approval now reads approved", approved?.status === "approved");
    const { result: second } = await backend("POST", `/v1/books/${BOOK}/undo`);
    const back = await readFile(chapterFile);
    check(
      "one undo takes the approved overwrite back to the original body",
      second?.restored === 1 && chapterParts(back).body.equals(originalParts.body)
    );
  }

  // 6. A background turn that finishes with the window closed: reopening from the dock lands on its
  // conversation, with no review of the studio's own files over it (017 FR-012, filmed at 1:29).
  let release = () => {};
  fake.state.hold = new Promise((resolveHold) => {
    release = resolveHold;
  });
  const away = await studio("agent.start", { bookId: BOOK, chapterId: chapter.id, prompt: TURN_THREE, mode: "edit", background: true });
  // On macOS the studio keeps running with no window. A hidden run quits when its last window closes,
  // so a blank window that is never shown keeps it running in its place.
  const keeper = await app.evaluate(({ BrowserWindow }) => new BrowserWindow({ show: false, x: -16_000, y: -16_000 }).id);
  await app.evaluate(({ BrowserWindow }, keep) => {
    for (const window of BrowserWindow.getAllWindows()) if (window.id !== keep) window.close();
  }, keeper);
  const closed = await waitFor(
    () => app.evaluate(({ BrowserWindow }, keep) => BrowserWindow.getAllWindows().every((window) => window.id === keep), keeper),
    15_000
  );
  check("the studio's window closed while the background turn waited on the model", closed === true);
  release();
  const awayReply = await waitFor(async () => {
    try {
      const stored = JSON.parse(await readFile(join(bookDir, "threads", `${away.threadId}.json`), "utf8"));
      const answer = stored.messages.find((message) => message.role === "assistant" && message.turnId === away.turnId);
      return answer?.parts?.at(-1)?.text === REPLY_THREE ? answer : null;
    } catch {
      return null;
    }
  }, 30_000);
  check("with no window open, the background turn finishes and its conversation is saved", awayReply !== null);
  // A hidden run logs what it would have posted; the first turn logged a "ready" line of its own.
  const notice = `[notification] would post ${JSON.stringify({ title: "The Salt Road — ready", body: REPLY_THREE })}`;
  const posted = await waitFor(() => appOutput.includes(notice), 15_000);
  check("its notification names the book, says it is ready and previews the reply", posted === true);

  await app.evaluate(({ app: shell }) => {
    shell.emit("activate");
  });
  const reopened = await waitFor(
    () => app.windows().find((candidate) => candidate !== page && !candidate.isClosed() && candidate.url().endsWith("/renderer/index.html")) ?? null,
    30_000
  );
  check("the dock's activate makes the studio's window again", reopened !== null);
  if (reopened) {
    const landed = await waitFor(async () => {
      try {
        return await reopened.evaluate(() => {
          const chat = document.querySelector('[data-testid="chat-panel"]');
          if (!chat || !document.querySelector('[data-testid="workspace-view"]')) return null;
          return {
            conversation: chat.textContent ?? "",
            library: document.querySelector('[data-testid="library-view"]') !== null
          };
        });
      } catch {
        // The page is still loading.
        return null;
      }
    }, 30_000);
    check("the reopened window opens the book's workspace with the agent open", landed !== null);
    check("the agent shows the conversation the background turn finished in", landed?.conversation.includes(REPLY_THREE) === true);
    check("the library is not what the reopened window shows", landed?.library === false);
    const review = await reopened.evaluate(() => window.studio.sync.check());
    const listed = (review?.data?.entries ?? []).map((entry) => `${entry.kind} ${entry.path}`);
    check(
      "the review lists none of the studio's own files: conversations, chapter, checkpoints",
      review?.ok === true && review.data?.clean === true && listed.length === 0,
      listed.slice(0, 3).join(", ")
    );
    check(
      "no review dialog covers the conversation",
      !(await reopened.evaluate(() => document.querySelector('[data-testid="drift-entries"]') !== null))
    );
  }

  // 7. Where every request went, the background turn's included.
  const sequence = fake.requests.map((request) => `${request.method} ${request.path}${request.step ? ` ${request.step}` : ""}`);
  const expected = [
    "GET /v1/models",
    "GET /v1/models",
    "POST /v1/chat/completions read",
    "POST /v1/chat/completions append",
    "POST /v1/chat/completions reply",
    "POST /v1/chat/completions overwrite",
    "POST /v1/chat/completions approved",
    "POST /v1/chat/completions background",
    "POST /v1/chat/completions background reply"
  ];
  check(
    "the fake provider received exactly the expected requests",
    JSON.stringify(sequence) === JSON.stringify(expected),
    `${fake.requests.length} of ${expected.length}`
  );
  check("every provider request carried this run's key", fake.requests.length > 0 && fake.requests.every((request) => request.keyMatches));
  const chats = fake.requests.filter((request) => request.path === "/v1/chat/completions");
  check("every model call streamed", chats.length > 0 && chats.every((request) => request.stream));
  check(
    "the model was offered the studio's own tools",
    ["read_chapter", "append_to_chapter", "overwrite_chapter"].every((name) => chats[0]?.tools?.includes(name)),
    `${chats[0]?.tools?.length ?? 0} tools`
  );
  check("the chapter's prose reached the chosen provider", chats.some((request) => request.prose));
  const turnOneChats = chats.filter((request) => TURN_ONE_STEPS.includes(request.step));
  check("every step the studio counted reached the fake", usage?.steps === turnOneChats.length);

  observed = await app.evaluate(() => {
    const record = globalThis.__agentCheck;
    return record ? { asked: record.asked, safeStorage: [...record.safeStorage], outbound: [...record.outbound] } : null;
  });
  const outbound = observed?.outbound ?? [];
  check(
    "the main process sent every outbound request to the fake, and nowhere else",
    outbound.length === fake.requests.length && outbound.every((request) => request.origin === fake.origin),
    `${outbound.length} observed · ${fake.requests.length} received`
  );
  check("the renderer made no network request", rendererRequests.length === 0, rendererRequests.slice(0, 3).join(", "));
  if (safeStorageGuarded) {
    check(
      "nothing in the run called safeStorage",
      (observed?.safeStorage ?? []).length === 0,
      (observed?.safeStorage ?? []).join(", ")
    );
  }
  notes.push(`the studio asked to notify ${observed?.asked ?? 0} times; every one stayed off the desktop`);
}

try {
  await journey();
} catch (error) {
  problems.push(`the run stopped early — ${redact(error instanceof Error ? error.message : error)}`);
}

// After the app has exited, every file it could have written is on disk.
await closeApp();
const leaks = await keyLeaks(temp);
check("the key is in no file in the profile, the library or the backend file", leaks.length === 0, leaks.join(", "));
check("no credentials.json was written", !existsSync(join(profile, "credentials.json")));
// The app prints this line at startup. The output is attached once the launch has returned, and on Linux that is after
// the line was printed (a Linux run captured 1,061 characters, none of them this line, even when it waited), so it can
// only be observed on macOS, where this stays a real check. Everywhere the line itself is asserted by
// apps/desktop/tests/memory-vault.test.ts, and the check before this one proves the in-memory vault is the one in use.
const vaultLine = await waitFor(() => appOutput.includes("[credentials] This test run keeps connections in memory only"), 10_000);
if (vaultLine === true || process.platform === "darwin") {
  check(
    "the app says so in one line of its log",
    vaultLine === true,
    vaultLine === true ? undefined : `not in the ${appOutput.length} characters captured since launch returned, which begin ${JSON.stringify(redact(appOutput).slice(0, 200))}`
  );
} else {
  check(
    "the app says so in one line of its log (not observable off macOS)",
    true,
    `printed before the output is attached here; ${appOutput.length} characters captured, none of them the line; the unit test asserts it`
  );
}
check("the key is in no line the app printed", appOutput.length > 0 && !appOutput.includes(KEY));

console.log("[agent] requests the fake provider received:");
for (const [index, request] of fake.requests.entries()) {
  console.log(
    `[agent]   ${String(index + 1).padStart(2)}  ${request.method.padEnd(4)} ${request.path.padEnd(22)} authorization ${request.authorization} · ${request.bytes.toLocaleString("en-US")} bytes${request.step ? ` · ${request.step}` : ""}`
  );
}
const resumed = fake.requests.find((request) => request.step === "approved");
if (resumed) console.log(`[agent]   the approved resume sent: ${resumed.roles.join(", ")}`);

finished = true;
clearTimeout(watchdog);
await cleanUp();

for (const line of notes) console.log(`[agent] ok    ${line}`);
for (const line of problems) console.log(`[agent] fix   ${line}`);
if (problems.length > 0) {
  const tail = redact(appOutput).trim().split("\n").slice(-30);
  if (tail.length > 0) console.log(`[agent] the app's last lines:\n${tail.map((line) => `[agent]   ${line}`).join("\n")}`);
}
console.log(problems.length === 0 ? `[agent] ${notes.length} checks passed` : `[agent] ${problems.length} of ${notes.length + problems.length} checks need attention`);
process.exit(problems.length === 0 ? 0 : 1);
