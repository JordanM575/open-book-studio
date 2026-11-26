import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentMessageSchema,
  agentThreadSchema,
  messageText,
  serializeAgentThread,
  type AgentMessage,
  type AgentPlanEvent,
  type AgentPlanStatus,
  type AgentThread
} from "@ai-book-studio/core/agent/messages";
import { ThreadStore, ThreadStoreError, type NewAgentPlan } from "@ai-book-studio/core/agent/threads";
import { libraryPathFromArchivePath, toLibraryFilePath } from "@ai-book-studio/core/library/path";
import { conflictsPath, threadsPath } from "@ai-book-studio/core/library/paths";
import { LibraryService } from "@ai-book-studio/core/library/service";
import type { LibraryEnvironment } from "@ai-book-studio/core/library/port";
import { createFileSystemEnvironment } from "../src/main/library/fs-port";
import { prepareThread } from "../src/main/agent/runtime";

const BOOK = "book_test0001";
let root = "";
let env: LibraryEnvironment;
let store: ThreadStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-threads-"));
  env = createFileSystemEnvironment(root);
  store = new ThreadStore(env.storage, env.runtime);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function message(id: string, createdAt: string): AgentMessage {
  return agentMessageSchema.parse({
    id,
    role: "assistant",
    parts: [
      { type: "reasoning", text: "She should sound tired." },
      { type: "tool-call", id: "call_read", name: "read_chapter", input: { chapterId: "ch_test0001" } },
      { type: "tool-result", id: "call_read", name: "read_chapter", output: { ok: true, text: "The door." } },
      { type: "text", text: "I tightened the opening." }
    ],
    model: {
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
      connectionLabel: "OpenRouter"
    },
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 80,
      costUsd: 0.0012,
      costBasis: "reported"
    },
    createdAt
  });
}


/** Save the object as built, using the exact base hash currently on disk. */
async function saveWith(store: ThreadStore, thread: AgentThread): Promise<AgentThread> {
  const snapshot = await store.readSnapshot(thread.bookId, thread.id);
  if (!snapshot) throw new Error("missing thread snapshot");
  return store.save(thread, { baseHash: snapshot.baseHash });
}

describe("agent message schema", () => {
  test("round-trips every part through the thread file format", async () => {
    const thread = await store.create(BOOK, "Opening scene");
    const createdAt = new Date().toISOString();
    const saved = await saveWith(store, { ...thread, messages: [message("msg_test0001", createdAt)] });
    const read = await store.read(BOOK, thread.id);

    expect(read).not.toBeNull();
    const stored = read!;
    expect(stored.messages[0]?.parts).toHaveLength(4);
    expect(stored.messages[0]?.parts[1]).toMatchObject({ type: "tool-call", name: "read_chapter" });
    expect(stored.messages[0]?.usage?.cachedInputTokens).toBe(80);
    expect(messageText(stored.messages[0]!)).toBe("I tightened the opening.");
    expect(saved.updatedAt >= thread.updatedAt).toBe(true);
  });

  test("rejects empty parts and duplicate message ids", () => {
    const base = {
      schemaVersion: 1,
      id: "thread_test0001",
      bookId: BOOK,
      title: "A conversation",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      checkpointTurns: []
    };
    expect(agentThreadSchema.safeParse({ ...base, messages: [{ id: "msg_test0001", role: "user", parts: [] }] }).success).toBe(false);
    const one = message("msg_test0001", new Date().toISOString());
    expect(agentThreadSchema.safeParse({ ...base, messages: [one, one] }).success).toBe(false);
  });

  test("serialization is stable and validates the thread", async () => {
    const thread = await store.create(BOOK, "Stable");
    const text = serializeAgentThread(thread);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).id).toBe(thread.id);
  });
});

describe("thread store", () => {
  test("lists conversations newest first", async () => {
    let tick = 0;
    const clock = new ThreadStore(env.storage, {
      ...env.runtime,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
    });
    const first = await clock.create(BOOK, "First");
    const second = await clock.create(BOOK, "Second");
    const list = await clock.list(BOOK);
    expect(list.map((thread) => thread.id)).toEqual([second.id, first.id]);
    expect(list[0]?.title).toBe("Second");
  });

  test("upserts an approval message and records its answer", async () => {
    const thread = await store.create(BOOK, "Approval");
    const at = new Date().toISOString();
    const pending = agentMessageSchema.parse({
      id: "msg_test0002",
      role: "assistant",
      parts: [
        { type: "text", text: "I can move that chapter." },
        {
          type: "approval",
          approvalId: "appr_test0001",
          turnId: "turn_test0001",
          name: "move_chapter",
          input: { chapterId: "ch_test0001", position: 2 },
          status: "pending",
          requestedAt: at
        }
      ],
      turnId: "turn_test0001",
      createdAt: at
    });

    await store.upsertMessage(BOOK, thread.id, pending);
    const updated = await store.updateApproval(BOOK, thread.id, pending.id, "appr_test0001", "approved");
    expect(updated?.messages).toHaveLength(1);
    const part = updated?.messages[0]?.parts.find((entry) => entry.type === "approval");
    expect(part).toMatchObject({ status: "approved" });
    expect(part).toHaveProperty("resolvedAt");
    expect(await store.updateApproval(BOOK, thread.id, pending.id, "appr_missing", "denied")).toBeNull();

    const final = agentMessageSchema.parse({
      ...updated!.messages[0],
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 0,
        costUsd: null,
        costBasis: "unknown"
      }
    });
    const saved = await store.upsertMessage(BOOK, thread.id, final);
    expect(saved.messages).toHaveLength(1);
    expect(saved.messages[0]?.usage?.inputTokens).toBe(10);
  });

  test("appends a message and renames the conversation", async () => {
    const thread = await store.create(BOOK, "New");
    const appended = await store.appendMessage(BOOK, thread.id, message("msg_test0001", new Date().toISOString()));
    expect(appended.messages).toHaveLength(1);
    const renamed = await store.rename(BOOK, thread.id, "  The   door  ");
    expect(renamed.title).toBe("The door");
    expect((await store.read(BOOK, thread.id))?.title).toBe("The door");
  });

  test("forks a conversation at an assistant turn", async () => {
    const now = new Date().toISOString();
    const user = agentMessageSchema.parse({
      id: "msg_00000001",
      role: "user",
      parts: [{ type: "text", text: "Start." }],
      createdAt: now
    });
    const first = { ...message("msg_00000002", now), turnId: "turn_00000001" };
    const secondUser = agentMessageSchema.parse({
      id: "msg_00000003",
      role: "user",
      parts: [{ type: "text", text: "Continue." }],
      createdAt: now
    });
    const second = { ...message("msg_00000004", now), turnId: "turn_00000002" };
    const source = await store.create(BOOK, "Source conversation", [user, first, secondUser, second]);
    await saveWith(store, { ...source, checkpointTurns: ["turn_00000001", "turn_00000002"] });

    const branch = await store.fork(BOOK, source.id, "turn_00000001");
    expect(branch.id).not.toBe(source.id);
    expect(branch.title).toBe("Source conversation (branch)");
    expect(branch.messages).toHaveLength(2);
    // Undo takes the newest checkpoint, which this branch left out, so it offers no undo (QA B2).
    expect(branch.checkpointTurns).toEqual([]);
    const fromNewest = await store.fork(BOOK, source.id, "turn_00000002");
    expect(fromNewest.checkpointTurns).toEqual(["turn_00000001", "turn_00000002"]);
    expect((await store.read(BOOK, source.id))?.messages).toHaveLength(4);
    await expect(store.fork(BOOK, source.id, "turn_missing")).rejects.toMatchObject({ code: "not-found" });
  });

  // QA B2: once undo has used a turn's checkpoint, no conversation may offer that undo again.
  test("forgets an undone turn in every conversation that names it", async () => {
    let tick = 0;
    const clock = new ThreadStore(env.storage, {
      ...env.runtime,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
    });
    const sourceBase = await clock.create(BOOK, "Source");
    const source = await saveWith(clock, { ...sourceBase, checkpointTurns: ["turn_00000001", "turn_00000002"] });
    const branchBase = await clock.create(BOOK, "Source (branch)");
    const branch = await saveWith(clock, { ...branchBase, checkpointTurns: ["turn_00000001", "turn_00000002"] });
    const otherBase = await clock.create(BOOK, "Other");
    const other = await saveWith(clock, { ...otherBase, checkpointTurns: ["turn_00000003"] });

    await clock.forgetCheckpointTurn(BOOK, "turn_00000002");

    expect((await clock.read(BOOK, source.id))?.checkpointTurns).toEqual(["turn_00000001"]);
    expect((await clock.read(BOOK, branch.id))?.checkpointTurns).toEqual(["turn_00000001"]);
    expect(await clock.read(BOOK, other.id)).toEqual(other);
    // The branch was newer than its source, and still is.
    const order = (await clock.list(BOOK)).map((thread) => thread.id);
    expect(order.indexOf(branch.id)).toBeLessThan(order.indexOf(source.id));

    // A turn no conversation names leaves every file as it was.
    await clock.forgetCheckpointTurn(BOOK, "turn_missing01");
    expect(await clock.read(BOOK, other.id)).toEqual(other);
  });

  test("skips a corrupt file in the list and reports it when opened", async () => {
    const thread = await store.create(BOOK, "Good");
    const corrupt = "thread_bad0001";
    const path = toLibraryFilePath([...threadsPath(BOOK), `${corrupt}.json`]);
    await writeFile(join(root, ...path), "{ not json", "utf8");

    expect((await store.list(BOOK)).map((entry) => entry.id)).toEqual([thread.id]);
    await expect(store.read(BOOK, corrupt)).rejects.toMatchObject({ code: "corrupt" });
  });

  test("rejects unsafe ids before touching the filesystem", async () => {
    await expect(store.read("../book", "thread_test0001")).rejects.toBeInstanceOf(ThreadStoreError);
    await expect(store.read(BOOK, "../../etc/passwd")).rejects.toMatchObject({ code: "invalid-id" });
    await expect(store.create("book_../escape")).rejects.toMatchObject({ code: "invalid-id" });
  });

  test("removing a missing conversation is idempotent", async () => {
    expect(await store.remove(BOOK, "thread_missing01")).toEqual({ status: "missing" });
    const thread = await store.create(BOOK, "Gone");
    await store.remove(BOOK, thread.id);
    expect(await store.read(BOOK, thread.id)).toBeNull();
  });
});

describe("checked conversation writes", () => {
  function pathOf(threadId: string): string {
    return join(root, ...toLibraryFilePath([...threadsPath(BOOK), `${threadId}.json`]));
  }

  function trashPathOf(trashedAt: string): string {
    return join(root, ...libraryPathFromArchivePath(trashedAt));
  }

  test("a stale base hash keeps the intended conversation and never overwrites", async () => {
    const thread = await store.create(BOOK, "First");
    const path = pathOf(thread.id);
    const baseHash = (await env.storage.readFile(toLibraryFilePath([...threadsPath(BOOK), `${thread.id}.json`])))!
      .sha256;

    await store.rename(BOOK, thread.id, "Second");
    await expect(store.save({ ...thread, title: "Mine" }, { baseHash })).rejects.toMatchObject({
      code: "conflict"
    });

    expect((await store.read(BOOK, thread.id))?.title).toBe("Second");
    const copies = await readdir(join(root, ...conflictsPath(BOOK)));
    expect(copies.some((name) => name.includes(thread.id) && name.endsWith(".json"))).toBe(true);
    const copy = JSON.parse(await readFile(join(root, ...conflictsPath(BOOK), copies[0]!), "utf8"));
    expect(copy.title).toBe("Mine");
    expect(await readFile(path, "utf8")).toContain('"title": "Second"');
  });

  test("two writers from the same base produce one result and one kept copy", async () => {
    const service = await LibraryService.open(env);
    const thread = await store.create(BOOK, "Base");
    const first = new ThreadStore(env.storage, env.runtime, service.writeHost);
    const second = new ThreadStore(env.storage, env.runtime, service.writeHost);
    const readFirst = await first.readSnapshot(BOOK, thread.id);
    const readSecond = await second.readSnapshot(BOOK, thread.id);

    const results = await Promise.allSettled([
      first.save({ ...readFirst!.thread, title: "First writer" }, { baseHash: readFirst!.baseHash }),
      second.save({ ...readSecond!.thread, title: "Second writer" }, { baseHash: readSecond!.baseHash })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "conflict" });
    const stored = await store.read(BOOK, thread.id);
    expect(["First writer", "Second writer"]).toContain(stored?.title ?? "");
    const copies = await readdir(join(root, ...conflictsPath(BOOK)));
    expect(copies.some((name) => name.includes(thread.id))).toBe(true);
  });

  test("saving an unchanged conversation writes nothing and keeps the timestamp", async () => {
    const thread = await store.create(BOOK, "Unchanged");
    const path = pathOf(thread.id);
    const before = await readFile(path, "utf8");
    const saved = await saveWith(store, thread);
    expect(saved.updatedAt).toBe(thread.updatedAt);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("unknown plain fields survive an ordinary rename", async () => {
    const thread = await store.create(BOOK, "Extras");
    const path = pathOf(thread.id);
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.futureTop = { keep: [1, 2, 3] };
    raw.messages = [
      {
        id: "msg_test0001",
        role: "user",
        parts: [{ type: "text", text: "Hello.", futurePart: "kept" }],
        futureMessage: "kept",
        createdAt: thread.createdAt
      }
    ];
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await store.rename(BOOK, thread.id, "Renamed");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.title).toBe("Renamed");
    expect(after.futureTop).toEqual({ keep: [1, 2, 3] });
    expect(after.messages[0].futureMessage).toBe("kept");
    expect(after.messages[0].parts[0].futurePart).toBe("kept");
  });

  test("replacing a message keeps unknown fields attached to it", async () => {
    const thread = await store.create(BOOK, "Upsert");
    const path = pathOf(thread.id);
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.messages = [
      {
        id: "msg_test0002",
        role: "assistant",
        parts: [{ type: "text", text: "First", futurePart: "part extra" }],
        futureMessage: "message extra",
        createdAt: thread.createdAt
      }
    ];
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await store.upsertMessage(
      BOOK,
      thread.id,
      agentMessageSchema.parse({
        id: "msg_test0002",
        role: "assistant",
        parts: [{ type: "text", text: "Second" }],
        createdAt: thread.createdAt
      })
    );

    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.messages[0].futureMessage).toBe("message extra");
    expect(after.messages[0].parts[0].futurePart).toBe("part extra");
    expect(after.messages[0].parts[0].text).toBe("Second");
  });

  test("deletion moves the file to recoverable trash and restore brings it back", async () => {
    const thread = await store.create(BOOK, "Delete me");
    const removed = await store.remove(BOOK, thread.id);
    expect(removed.status).toBe("trashed");
    if (removed.status !== "trashed") throw new Error("expected a trashed conversation");
    expect(await store.read(BOOK, thread.id)).toBeNull();
    expect(removed.trashedAt).toContain(".studio/trash/");
    expect((await env.storage.readFile(libraryPathFromArchivePath(removed.trashedAt)))).not.toBeNull();
    expect(await readFile(trashPathOf(removed.trashedAt), "utf8")).toContain('"title": "Delete me"');

    const restored = await store.restore(BOOK, thread.id, removed.trashedAt);
    expect(restored.title).toBe("Delete me");
    expect((await store.read(BOOK, thread.id))?.title).toBe("Delete me");

    await expect(store.restore(BOOK, thread.id, removed.trashedAt)).rejects.toMatchObject({ code: "exists" });
    await expect(store.restore(BOOK, thread.id, "books/book_test0001/threads/x.json")).rejects.toMatchObject({
      code: "invalid-id"
    });
    await expect(store.restore(BOOK, "thread_other01", removed.trashedAt.replace(thread.id, "thread_other01"))).rejects.toMatchObject({
      code: "not-found"
    });
  });

  test("a future schema and an oversized record are refused without rewriting the file", async () => {
    const thread = await store.create(BOOK, "Future");
    const path = pathOf(thread.id);
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.schemaVersion = 2;
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const futureBytes = await readFile(path, "utf8");
    await expect(store.read(BOOK, thread.id)).rejects.toMatchObject({ code: "newer" });
    await expect(saveWith(store, { ...thread, title: "No" })).rejects.toMatchObject({ code: "newer" });
    expect(await readFile(path, "utf8")).toBe(futureBytes);

    const normal = await store.create(BOOK, "A normal conversation with enough bytes to exceed a small test limit.");
    const limited = new ThreadStore(env.storage, env.runtime, undefined, { maxBytes: 64 });
    const normalBytes = await readFile(pathOf(normal.id), "utf8");
    await expect(limited.read(BOOK, normal.id)).rejects.toMatchObject({ code: "too-large" });
    expect(await readFile(pathOf(normal.id), "utf8")).toBe(normalBytes);
  });

  test("the desktop Library writes conversations through the shared write host and does not migrate on open", async () => {
    const service = await LibraryService.open(env);
    const hosted = new ThreadStore(env.storage, env.runtime, service.writeHost);
    const thread = await hosted.create(BOOK, "Hosted conversation");
    const path = pathOf(thread.id);
    const before = await readFile(path, "utf8");

    // Reopening the library rebuilds the catalog; it must not migrate or rewrite a v1 conversation.
    await LibraryService.open(env);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await hosted.read(BOOK, thread.id))?.title).toBe("Hosted conversation");
  });

  test("no unchecked conversation writer remains", async () => {
    const threads = await readFile(new URL("../../../packages/core/src/agent/threads.ts", import.meta.url), "utf8");
    expect(threads).not.toMatch(/kind:\s*"any"/);
    expect(threads).not.toMatch(/removeFile\s*\(/);
    expect(threads).not.toMatch(/\bunlink\b/);
    const facade = await readFile(new URL("../src/main/library/store.ts", import.meta.url), "utf8");
    expect(facade).toMatch(/new ThreadStore\([^)]*writeHost/s);
  });
});

describe("prepareThread", () => {
  test("creates a conversation from a prompt and reuses the user message on retry", async () => {
    const prepared = await prepareThread(store, { bookId: BOOK, prompt: "Tighten the opening." });
    expect(prepared.reused).toBe(false);
    expect(prepared.thread.title).toBe("Tighten the opening.");
    expect(prepared.thread.messages).toHaveLength(1);

    const again = await prepareThread(store, {
      bookId: BOOK,
      threadId: prepared.thread.id,
      prompt: "Tighten the opening."
    });
    expect(again.reused).toBe(true);
    expect(again.thread.messages).toHaveLength(1);
    expect(messageText(again.thread.messages[0]!)).toBe("Tighten the opening.");
  });

  test("seeds a new conversation from plain text history", async () => {
    const prepared = await prepareThread(store, {
      bookId: BOOK,
      prompt: "Keep going.",
      history: [
        { role: "user", text: "Open the scene." },
        { role: "assistant", text: "The door opened." }
      ]
    });
    expect(prepared.thread.messages.map((entry) => messageText(entry))).toEqual([
      "Open the scene.",
      "The door opened.",
      "Keep going."
    ]);
  });

  test("refuses a missing conversation and an empty prompt", async () => {
    await expect(
      prepareThread(store, { bookId: BOOK, threadId: "thread_missing01", prompt: "Hello." })
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(prepareThread(store, { bookId: BOOK, prompt: "   " })).rejects.toMatchObject({
      code: "invalid-request"
    });
  });
});

describe("base-bound saves (review F1/F2)", () => {
  test("an older copy cannot overwrite a newer save", async () => {
    const thread = await store.create(BOOK, "Title A");
    const first = await store.readSnapshot(BOOK, thread.id);
    const second = await store.readSnapshot(BOOK, thread.id);
    if (!first || !second) throw new Error("missing snapshots");

    await store.save({ ...first.thread, title: "Title B" }, { baseHash: first.baseHash });
    await expect(store.save({ ...second.thread, title: "Title C" }, { baseHash: second.baseHash }))
      .rejects.toMatchObject({ code: "conflict" });

    expect((await store.read(BOOK, thread.id))?.title).toBe("Title B");
    const copies = await readdir(join(root, ...conflictsPath(BOOK)));
    expect(copies.some((name) => name.includes(thread.id))).toBe(true);
  });

  test("a store that never read the conversation cannot save it", async () => {
    const thread = await store.create(BOOK, "Unread");
    const service = await LibraryService.open(env);
    const other = new ThreadStore(env.storage, env.runtime, service.writeHost);
    await expect(other.save(thread, {} as never)).rejects.toMatchObject({ code: "missing-base" });
    expect((await store.read(BOOK, thread.id))?.title).toBe("Unread");
  });

  test("a file deleted after the queue read keeps a missing-file copy", async () => {
    const service = await LibraryService.open(env);
    const thread = await store.create(BOOK, "Vanishing");
    const snapshot = await store.readSnapshot(BOOK, thread.id);
    if (!snapshot) throw new Error("missing snapshot");
    const base = service.writeHost;
    const racing = {
      ...base,
      commitFile: async (path: Parameters<typeof base.commitFile>[0], bytes: Uint8Array,
        expected: Parameters<typeof base.commitFile>[2]) => {
        await rm(join(root, ...path), { force: true });
        return base.commitFile(path, bytes, expected);
      }
    };
    const racingStore = new ThreadStore(env.storage, env.runtime, racing);
    const error = await racingStore.save({ ...snapshot.thread, title: "Gone" }, { baseHash: snapshot.baseHash })
      .catch((reason: unknown) => reason as { code?: string; savedAs?: string });
    expect(error.code).toBe("conflict");
    expect(error.savedAs).toContain("missing-file");
  });

  test("a create collision at commit reports exists, not a conflict copy", async () => {
    const service = await LibraryService.open(env);
    const seed = await store.create(BOOK, "Seed bytes");
    const seedBytes = await readFile(join(root, ...threadsPath(BOOK), `${seed.id}.json`));
    const base = service.writeHost;
    const racing = {
      ...base,
      commitFile: async (path: Parameters<typeof base.commitFile>[0], bytes: Uint8Array,
        expected: Parameters<typeof base.commitFile>[2]) => {
        await writeFile(join(root, ...path), seedBytes);
        return base.commitFile(path, bytes, expected);
      }
    };
    const racingStore = new ThreadStore(env.storage, env.runtime, racing);
    await expect(racingStore.create(BOOK, "Collision")).rejects.toMatchObject({ code: "exists" });
  });
});

describe("generated titles at a Unicode boundary (review P2)", () => {
  test("a prompt that ends a 60-unit title in an emoji keeps a readable conversation", async () => {
    const service = await LibraryService.open(env);
    const boundary = `${"a".repeat(59)}😀 tail`;
    const prepared = await prepareThread(store, { bookId: BOOK, prompt: boundary });
    expect(prepared.thread.title.endsWith("…")).toBe(true);
    expect(prepared.thread.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);

    const reopened = await store.read(BOOK, prepared.thread.id);
    expect(reopened?.title).toBe(prepared.thread.title);
    const listed = await store.list(BOOK);
    expect(listed.some((summary) => summary.id === prepared.thread.id)).toBe(true);
    expect(service).toBeTruthy();
  });
});

function threadPath(threadId: string): string {
  return join(root, ...threadsPath(BOOK), `${threadId}.json`);
}

describe("generated content cannot corrupt a conversation (review P2)", () => {
  test("a lone surrogate anywhere in the document is refused before publishing", async () => {
    const thread = await store.create(BOOK, "Unsafe");
    const path = threadPath(thread.id);
    const before = await readFile(path, "utf8");
    await expect(store.upsertMessage(BOOK, thread.id, agentMessageSchema.parse({
      id: "msg_bad00001",
      role: "assistant",
      parts: [{ type: "text", text: "cut \ud800" }],
      createdAt: thread.createdAt
    }))).rejects.toBeTruthy();
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await store.read(BOOK, thread.id))?.messages).toHaveLength(0);
  });

  test("unknown fields nested in a replaced message survive", async () => {
    const thread = await store.create(BOOK, "Nested extras");
    const path = threadPath(thread.id);
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.messages = [{
      id: "msg_keep0001",
      role: "assistant",
      parts: [{ type: "text", text: "Before.", futurePart: 7 }],
      model: { provider: "openrouter", modelId: "openai/gpt-5-mini", connectionLabel: "OpenRouter", futureModel: 11 },
      usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, costUsd: 0, costBasis: "reported", futureUsage: 13 },
      createdAt: thread.createdAt
    }];
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await store.upsertMessage(BOOK, thread.id, agentMessageSchema.parse({
      id: "msg_keep0001",
      role: "assistant",
      parts: [{ type: "text", text: "After." }],
      model: { provider: "openrouter", modelId: "openai/gpt-5-mini", connectionLabel: "OpenRouter" },
      usage: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 0, costUsd: 0, costBasis: "reported" },
      createdAt: thread.createdAt
    }));
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.messages[0].parts[0]).toMatchObject({ text: "After.", futurePart: 7 });
    expect(after.messages[0].model).toMatchObject({ modelId: "openai/gpt-5-mini", futureModel: 11 });
    expect(after.messages[0].usage).toMatchObject({ inputTokens: 2, futureUsage: 13 });
  });
});

describe("unsupported numbers cannot corrupt a conversation (review P2)", () => {
  test("an unsafe number in a tool result is refused before publishing", async () => {
    const thread = await store.create(BOOK, "Unsafe number");
    const path = threadPath(thread.id);
    const before = await readFile(path, "utf8");
    await expect(store.appendMessage(BOOK, thread.id, agentMessageSchema.parse({
      id: "msg_bignum001",
      role: "user",
      parts: [{ type: "text", text: "Search result.", futureNumber: 1e20 }],
      createdAt: thread.createdAt
    }))).rejects.toBeTruthy();
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await store.read(BOOK, thread.id))?.messages).toHaveLength(0);
  });

  test("an unknown field past the reader's depth limit is refused", async () => {
    const thread = await store.create(BOOK, "Deep field");
    const path = threadPath(thread.id);
    const before = await readFile(path, "utf8");
    let deep: unknown = "bottom";
    for (let index = 0; index < 70; index += 1) deep = { nested: deep };
    await expect(store.appendMessage(BOOK, thread.id, agentMessageSchema.parse({
      id: "msg_deep0001",
      role: "user",
      parts: [{ type: "text", text: "Deep.", futureDeep: deep }],
      createdAt: thread.createdAt
    }))).rejects.toBeTruthy();
    expect(await readFile(path, "utf8")).toBe(before);
  });
});

const PLAN_PARENT_ID = "msg_plan0001";
const PLAN_TURN_ID = "turn_plan0001";
const PLAN_CREATED = "2026-01-01T00:00:00.000Z";
const PLAN_STARTED = "2026-01-02T00:00:00.000Z";
const PLAN_NOW = "2026-01-03T00:00:00.000Z";

function planParentMessage(overrides: Record<string, unknown> = {}): AgentMessage {
  return agentMessageSchema.parse({
    id: PLAN_PARENT_ID,
    role: "assistant",
    parts: [{ type: "text", text: "Here is the plan." }],
    mode: "edit",
    turnId: PLAN_TURN_ID,
    createdAt: new Date().toISOString(),
    ...overrides
  });
}

function newPlan(overrides: Partial<NewAgentPlan> = {}): NewAgentPlan {
  return {
    id: "plan-1",
    purpose: "Revise the opening",
    steps: ["Read the opening", "Rewrite the door"],
    parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID },
    ...overrides
  };
}

function rawPlanFor(
  status: AgentPlanStatus,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const terminal = status === "completed" || status === "cancelled" || status === "failed" || status === "expired";
  const steps =
    status === "completed"
      ? [{ text: "Read the opening", state: "completed" }]
      : terminal
        ? [{ text: "Read the opening", state: "not-completed" }]
        : status === "proposed"
          ? [{ text: "Read the opening", state: "pending" }]
          : [
              { text: "Read the opening", state: "completed" },
              { text: "Rewrite the door", state: "pending" }
            ];
  const startedAt = status === "proposed" || status === "expired" ? undefined : PLAN_STARTED;
  const terminalAt = terminal ? PLAN_NOW : undefined;
  return {
    id: "plan-1",
    mode: "edit",
    status,
    purpose: "Revise the opening",
    steps,
    revision: 1,
    parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID },
    createdAt: PLAN_CREATED,
    updatedAt: terminalAt ?? startedAt ?? PLAN_CREATED,
    ...(startedAt ? { startedAt } : {}),
    ...(terminalAt ? { terminalAt } : {}),
    ...overrides
  };
}

function rawPlanParent(createdAt: string): Record<string, unknown> {
  return {
    id: PLAN_PARENT_ID,
    role: "assistant",
    parts: [{ type: "text", text: "Here is the plan." }],
    mode: "edit",
    turnId: PLAN_TURN_ID,
    createdAt
  };
}

async function seedPlanFile(
  plans: Record<string, unknown>[],
  messages?: Record<string, unknown>[]
): Promise<string> {
  const thread = await store.create(BOOK, "Seeded plan");
  const path = threadPath(thread.id);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  raw.messages = messages ?? [rawPlanParent(thread.createdAt)];
  raw.plans = plans;
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return thread.id;
}

function seedThreadWithPlan(
  status: AgentPlanStatus,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  return seedPlanFile([rawPlanFor(status, overrides)]);
}

async function bytesOf(threadId: string): Promise<string> {
  return readFile(threadPath(threadId), "utf8");
}

describe("plan state through the thread store", () => {
  test("stores a proposed plan with its Edit proposal turn", async () => {
    const thread = await store.create(BOOK, "Plan round-trip");
    await store.appendMessage(BOOK, thread.id, planParentMessage());
    const withPlan = await store.addPlan(BOOK, thread.id, newPlan({ guidance: "   " }));

    expect(withPlan.plans).toHaveLength(1);
    const raw = JSON.parse(await bytesOf(thread.id)) as Record<string, unknown>;
    const stored = (raw.plans as Array<Record<string, unknown>>)[0];
    if (!stored) throw new Error("Expected the persisted proposal");
    expect(stored).toMatchObject({
      id: "plan-1",
      mode: "edit",
      status: "proposed",
      purpose: "Revise the opening",
      revision: 1,
      parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID }
    });
    expect((stored.steps as Array<Record<string, unknown>>).map((step) => step.state)).toEqual([
      "pending",
      "pending"
    ]);
    expect(stored?.guidance).toBeUndefined();
    expect(stored?.startedAt).toBeUndefined();
    expect(stored?.terminalAt).toBeUndefined();
    expect(stored?.createdAt).toBeTruthy();
    expect(stored?.updatedAt).toBeTruthy();

    const snapshot = await store.readSnapshot(BOOK, thread.id);
    expect(snapshot?.thread.plans[0]?.id).toBe("plan-1");
    expect((await store.read(BOOK, thread.id))?.plans[0]?.steps).toHaveLength(2);
  });

  test("moves a plan through Start, progress, approval, pause, resume and completion", async () => {
    const thread = await store.create(BOOK, "Plan lifecycle");
    await store.appendMessage(BOOK, thread.id, planParentMessage());
    await store.addPlan(BOOK, thread.id, newPlan());
    let previous = await bytesOf(thread.id);

    const started = await store.applyPlanEvent(BOOK, thread.id, "plan-1", {
      type: "start",
      revision: 1
    });
    expect(started.outcome).toBe("applied");
    expect(started.thread.plans[0]?.status).toBe("running");
    expect(started.thread.plans[0]?.startedAt).toBeTruthy();
    expect(await bytesOf(thread.id)).not.toBe(previous);
    previous = await bytesOf(thread.id);

    const progress = await store.applyPlanEvent(BOOK, thread.id, "plan-1", {
      type: "step",
      revision: 1,
      index: 0,
      state: "in-progress"
    });
    expect(progress.thread.plans[0]?.steps[0]?.state).toBe("in-progress");
    expect(await bytesOf(thread.id)).not.toBe(previous);
    previous = await bytesOf(thread.id);

    const finishedStep = await store.applyPlanEvent(BOOK, thread.id, "plan-1", {
      type: "step",
      revision: 1,
      index: 0,
      state: "completed"
    });
    expect(finishedStep.thread.plans[0]?.steps[0]?.state).toBe("completed");

    const waiting = await store.applyPlanEvent(BOOK, thread.id, "plan-1", {
      type: "request-approval"
    });
    expect(waiting.thread.plans[0]?.status).toBe("waiting-for-approval");
    const settled = await store.applyPlanEvent(BOOK, thread.id, "plan-1", {
      type: "approval-settled"
    });
    expect(settled.thread.plans[0]?.status).toBe("running");

    const requesting = await store.applyPlanEvent(BOOK, thread.id, "plan-1", {
      type: "request-pause"
    });
    expect(requesting.thread.plans[0]?.status).toBe("pause-requested");
    const paused = await store.applyPlanEvent(BOOK, thread.id, "plan-1", {
      type: "confirm-pause"
    });
    expect(paused.thread.plans[0]?.status).toBe("paused");

    const resumed = await store.applyPlanEvent(BOOK, thread.id, "plan-1", {
      type: "resume"
    });
    expect(resumed.thread.plans[0]?.status).toBe("running");
    expect(resumed.thread.plans[0]?.startedAt).toBe(started.thread.plans[0]?.startedAt);
    expect(resumed.thread.plans[0]?.revision).toBe(1);

    const completed = await store.applyPlanEvent(BOOK, thread.id, "plan-1", {
      type: "complete"
    });
    expect(completed.thread.plans[0]?.status).toBe("completed");
    expect(completed.thread.plans[0]?.terminalAt).toBeTruthy();
    expect(completed.thread.plans[0]?.steps.map((step) => step.state)).toEqual([
      "completed",
      "not-completed"
    ]);

    const terminalRecord = JSON.parse(await bytesOf(thread.id)).plans[0];
    const second = await store.addPlan(
      BOOK,
      thread.id,
      newPlan({ id: "plan-2", purpose: "A second pass" })
    );
    expect(second.plans).toHaveLength(2);
    const raw = JSON.parse(await bytesOf(thread.id)) as Record<string, unknown>;
    const plans = raw.plans as Array<Record<string, unknown>>;
    expect(plans[0]).toEqual(terminalRecord);
    expect(plans[1]).toMatchObject({ id: "plan-2", status: "proposed", revision: 1 });
  });

  test("refuses impossible transitions and leaves the file byte-identical", async () => {
    const cases: Array<{ status: AgentPlanStatus; event: AgentPlanEvent; overrides?: Record<string, unknown> }> = [
      { status: "waiting-for-approval", event: { type: "start", revision: 1 } },
      { status: "paused", event: { type: "start", revision: 1 } },
      { status: "completed", event: { type: "start", revision: 1 } },
      { status: "cancelled", event: { type: "start", revision: 1 } },
      { status: "failed", event: { type: "start", revision: 1 } },
      { status: "expired", event: { type: "start", revision: 1 } },
      { status: "proposed", event: { type: "complete" } },
      { status: "paused", event: { type: "complete" } },
      { status: "proposed", event: { type: "fail" } },
      { status: "paused", event: { type: "fail" } },
      { status: "completed", event: { type: "cancel" } },
      { status: "failed", event: { type: "cancel" } },
      { status: "expired", event: { type: "cancel" } },
      { status: "proposed", event: { type: "resume" } },
      { status: "running", event: { type: "confirm-pause" } },
      { status: "waiting-for-approval", event: { type: "confirm-pause" } },
      { status: "proposed", event: { type: "step", revision: 1, index: 0, state: "in-progress" } },
      { status: "waiting-for-approval", event: { type: "step", revision: 1, index: 0, state: "completed" } },
      { status: "paused", event: { type: "step", revision: 1, index: 0, state: "completed" } },
      { status: "proposed", event: { type: "start", revision: 2 } },
      { status: "running", event: { type: "step", revision: 2, index: 1, state: "in-progress" } },
      { status: "running", event: { type: "step", revision: 1, index: 9, state: "in-progress" } },
      { status: "running", event: { type: "step", revision: 1, index: 0, state: "in-progress" } },
      {
        status: "running",
        event: { type: "complete" },
        overrides: {
          steps: [
            { text: "Read the opening", state: "pending" },
            { text: "Rewrite the door", state: "pending" }
          ]
        }
      }
    ];

    for (const entry of cases) {
      const threadId = await seedThreadWithPlan(entry.status, entry.overrides);
      const before = await bytesOf(threadId);
      await expect(
        store.applyPlanEvent(BOOK, threadId, "plan-1", entry.event)
      ).rejects.toMatchObject({ code: "plan-state" });
      expect(await bytesOf(threadId)).toBe(before);
    }
  });

  test("a duplicate or already-settled event writes nothing", async () => {
    const cases: Array<{
      status: AgentPlanStatus;
      event: AgentPlanEvent;
      overrides?: Record<string, unknown>;
    }> = [
      { status: "running", event: { type: "start", revision: 1 } },
      { status: "running", event: { type: "resume" } },
      { status: "pause-requested", event: { type: "request-pause" } },
      { status: "paused", event: { type: "confirm-pause" } },
      { status: "running", event: { type: "approval-settled" } },
      { status: "cancelled", event: { type: "cancel" } },
      { status: "completed", event: { type: "complete" } },
      { status: "failed", event: { type: "fail" } },
      { status: "completed", event: { type: "expire" } },
      { status: "expired", event: { type: "expire" } }
    ];

    for (const entry of cases) {
      const threadId = await seedThreadWithPlan(entry.status, entry.overrides);
      const before = await bytesOf(threadId);
      const stored = await store.read(BOOK, threadId);
      if (!stored) throw new Error("missing stored thread");
      const result = await store.applyPlanEvent(BOOK, threadId, "plan-1", entry.event);
      expect(result.outcome).toBe("unchanged");
      expect(await bytesOf(threadId)).toBe(before);
      expect(result.thread.updatedAt).toBe(stored.updatedAt);
    }

    // A same-state step event is a duplicate confirmed outcome, not a step change.
    const sameState = await seedThreadWithPlan("running", {
      steps: [
        { text: "Read the opening", state: "in-progress" },
        { text: "Rewrite the door", state: "pending" }
      ]
    });
    const sameBefore = await bytesOf(sameState);
    const sameResult = await store.applyPlanEvent(BOOK, sameState, "plan-1", {
      type: "step",
      revision: 1,
      index: 0,
      state: "in-progress"
    });
    expect(sameResult.outcome).toBe("unchanged");
    expect(await bytesOf(sameState)).toBe(sameBefore);
  });

  test("binds every plan to its stored Edit proposal turn", async () => {
    const missing = await store.create(BOOK, "Missing parent");
    const missingBefore = await bytesOf(missing.id);
    await expect(store.addPlan(BOOK, missing.id, newPlan())).rejects.toMatchObject({
      code: "plan-state"
    });
    expect(await bytesOf(missing.id)).toBe(missingBefore);

    const userParent = await store.create(BOOK, "User parent");
    await store.appendMessage(
      BOOK,
      userParent.id,
      agentMessageSchema.parse({
        id: PLAN_PARENT_ID,
        role: "user",
        mode: "edit",
        turnId: PLAN_TURN_ID,
        parts: [{ type: "text", text: "Propose a plan." }],
        createdAt: new Date().toISOString()
      })
    );
    const userBefore = await bytesOf(userParent.id);
    await expect(store.addPlan(BOOK, userParent.id, newPlan())).rejects.toMatchObject({
      code: "plan-state"
    });
    expect(await bytesOf(userParent.id)).toBe(userBefore);

    const noTurn = await store.create(BOOK, "No turn");
    await store.appendMessage(
      BOOK,
      noTurn.id,
      agentMessageSchema.parse({
        id: PLAN_PARENT_ID,
        role: "assistant",
        mode: "edit",
        parts: [{ type: "text", text: "Here is the plan." }],
        createdAt: new Date().toISOString()
      })
    );
    const noTurnBefore = await bytesOf(noTurn.id);
    await expect(store.addPlan(BOOK, noTurn.id, newPlan())).rejects.toMatchObject({
      code: "plan-state"
    });
    expect(await bytesOf(noTurn.id)).toBe(noTurnBefore);

    const discuss = await store.create(BOOK, "Discuss parent");
    await store.appendMessage(
      BOOK,
      discuss.id,
      agentMessageSchema.parse({
        id: PLAN_PARENT_ID,
        role: "assistant",
        mode: "discuss",
        turnId: PLAN_TURN_ID,
        parts: [{ type: "text", text: "Let's talk it through." }],
        createdAt: new Date().toISOString()
      })
    );
    const discussBefore = await bytesOf(discuss.id);
    await expect(store.addPlan(BOOK, discuss.id, newPlan())).rejects.toMatchObject({
      code: "plan-state"
    });
    expect(await bytesOf(discuss.id)).toBe(discussBefore);
  });

  test("a direct save cannot detach a plan from its parent turn", async () => {
    const thread = await store.create(BOOK, "Parent binding");
    await store.appendMessage(BOOK, thread.id, planParentMessage());
    await store.addPlan(BOOK, thread.id, newPlan());
    const snapshot = await store.readSnapshot(BOOK, thread.id);
    if (!snapshot) throw new Error("missing snapshot");
    const before = await bytesOf(thread.id);

    const changedTurn = structuredClone(snapshot.thread);
    changedTurn.messages[0] = { ...changedTurn.messages[0]!, turnId: "turn_other01" };
    await expect(store.save(changedTurn, { baseHash: snapshot.baseHash })).rejects.toBeTruthy();
    expect(await bytesOf(thread.id)).toBe(before);

    const changedMode = structuredClone(snapshot.thread);
    delete changedMode.messages[0]!.mode;
    await expect(store.save(changedMode, { baseHash: snapshot.baseHash })).rejects.toBeTruthy();
    expect(await bytesOf(thread.id)).toBe(before);
  });

  test("refuses a second live plan, a duplicate id and a fifty-first plan", async () => {
    const live = await store.create(BOOK, "One live plan");
    await store.appendMessage(BOOK, live.id, planParentMessage());
    await store.addPlan(BOOK, live.id, newPlan());
    const liveBefore = await bytesOf(live.id);
    await expect(
      store.addPlan(BOOK, live.id, newPlan({ id: "plan-2" }))
    ).rejects.toMatchObject({ code: "plan-state" });
    expect(await bytesOf(live.id)).toBe(liveBefore);

    const duplicate = await seedThreadWithPlan("cancelled", { id: "plan-1" });
    const duplicateBefore = await bytesOf(duplicate);
    await expect(store.addPlan(BOOK, duplicate, newPlan({ id: "plan-1" }))).rejects.toMatchObject({
      code: "plan-state"
    });
    expect(await bytesOf(duplicate)).toBe(duplicateBefore);

    const full = await seedPlanFile(
      Array.from({ length: 50 }, (_, index) =>
        rawPlanFor("cancelled", { id: `plan-${index}`, purpose: `Plan ${index}` })
      )
    );
    const fullBefore = await bytesOf(full);
    await expect(store.addPlan(BOOK, full, newPlan({ id: "plan-50" }))).rejects.toMatchObject({
      code: "plan-state"
    });
    expect(await bytesOf(full)).toBe(fullBefore);
  });

  test("a direct save cannot change or remove a terminal plan", async () => {
    const threadId = await seedThreadWithPlan("completed");
    const snapshot = await store.readSnapshot(BOOK, threadId);
    if (!snapshot) throw new Error("missing snapshot");
    const before = await bytesOf(threadId);

    const changed = structuredClone(snapshot.thread);
    changed.plans[0] = { ...changed.plans[0]!, purpose: "A different purpose" };
    await expect(store.save(changed, { baseHash: snapshot.baseHash })).rejects.toMatchObject({
      code: "plan-state"
    });
    expect(await bytesOf(threadId)).toBe(before);

    const changedStep = structuredClone(snapshot.thread);
    changedStep.plans[0] = {
      ...changedStep.plans[0]!,
      steps: [{ ...changedStep.plans[0]!.steps[0]!, text: "A different step" }]
    };
    await expect(store.save(changedStep, { baseHash: snapshot.baseHash })).rejects.toMatchObject({
      code: "plan-state"
    });
    expect(await bytesOf(threadId)).toBe(before);

    const removed = structuredClone(snapshot.thread);
    removed.plans = [];
    await expect(store.save(removed, { baseHash: snapshot.baseHash })).rejects.toMatchObject({
      code: "plan-state"
    });
    expect(await bytesOf(threadId)).toBe(before);
  });

  test("reports a corrupt or unsupported plan without touching the file", async () => {
    const corrupt = await seedPlanFile(
      [rawPlanFor("proposed")],
      [{ ...rawPlanParent(PLAN_CREATED), role: "user" }]
    );
    const corruptBytes = await bytesOf(corrupt);
    await expect(store.read(BOOK, corrupt)).rejects.toMatchObject({ code: "corrupt" });
    expect((await store.list(BOOK)).some((entry) => entry.id === corrupt)).toBe(false);
    expect(await bytesOf(corrupt)).toBe(corruptBytes);

    const terminal = rawPlanFor("cancelled");
    delete terminal.terminalAt;
    const missingEnd = await seedPlanFile([terminal]);
    const missingEndBytes = await bytesOf(missingEnd);
    await expect(store.read(BOOK, missingEnd)).rejects.toMatchObject({ code: "corrupt" });
    expect(await bytesOf(missingEnd)).toBe(missingEndBytes);

    const unsupported = await seedPlanFile([rawPlanFor("proposed", { status: "paused-future" })]);
    const unsupportedBytes = await bytesOf(unsupported);
    await expect(store.read(BOOK, unsupported)).rejects.toMatchObject({ code: "unsupported" });
    expect((await store.list(BOOK)).some((entry) => entry.id === unsupported)).toBe(false);
    expect(await bytesOf(unsupported)).toBe(unsupportedBytes);
  });

  test("a branch starts with no plans", async () => {
    const sourceId = await seedPlanFile([rawPlanFor("cancelled"), rawPlanFor("proposed", { id: "plan-2" })]);
    const branch = await store.fork(BOOK, sourceId, PLAN_TURN_ID);
    expect(branch.id).not.toBe(sourceId);
    expect(branch.plans).toEqual([]);
    expect((await store.read(BOOK, branch.id))?.plans).toEqual([]);
    expect((await store.read(BOOK, sourceId))?.plans).toHaveLength(2);
  });

  test("unknown plan, step and parent fields survive a rename and a transition", async () => {
    const threadId = await seedPlanFile([
      rawPlanFor("proposed", {
        futurePlanField: "keep the plan",
        steps: [
          { text: "Read the opening", state: "pending", futureStepField: "keep the step" },
          { text: "Rewrite the door", state: "pending" }
        ],
        parent: {
          messageId: PLAN_PARENT_ID,
          turnId: PLAN_TURN_ID,
          futureParentField: "keep the parent"
        }
      })
    ]);

    await store.rename(BOOK, threadId, "Renamed plan");
    const renamed = JSON.parse(await bytesOf(threadId)) as Record<string, unknown>;
    expect((renamed.plans as Array<Record<string, unknown>>)[0]?.futurePlanField).toBe(
      "keep the plan"
    );

    await store.applyPlanEvent(BOOK, threadId, "plan-1", { type: "start", revision: 1 });
    const moved = JSON.parse(await bytesOf(threadId)) as Record<string, unknown>;
    const plan = (moved.plans as Array<Record<string, unknown>>)[0];
    if (!plan) throw new Error("Expected the persisted running plan");
    expect(plan?.status).toBe("running");
    expect(plan?.futurePlanField).toBe("keep the plan");
    expect((plan.steps as Array<Record<string, unknown>>)[0]?.futureStepField).toBe(
      "keep the step"
    );
    expect((plan.parent as Record<string, unknown>).futureParentField).toBe("keep the parent");
  });

  test("refreshPlanProposal persists the next revision and keeps the parent", async () => {
    const thread = await store.create(BOOK, "Refresh");
    await store.appendMessage(BOOK, thread.id, planParentMessage());
    await store.addPlan(BOOK, thread.id, newPlan({ guidance: "Keep the tense." }));
    const refreshed = await store.refreshPlanProposal(BOOK, thread.id, "plan-1", {
      revision: 2,
      guidance: "Past tense."
    });
    expect(refreshed.plans[0]?.revision).toBe(2);
    expect(refreshed.plans[0]?.guidance).toBe("Past tense.");
    expect(refreshed.plans[0]?.status).toBe("proposed");
    expect(refreshed.plans[0]?.parent).toEqual({
      messageId: PLAN_PARENT_ID,
      turnId: PLAN_TURN_ID
    });
    const before = await bytesOf(thread.id);
    await expect(
      store.refreshPlanProposal(BOOK, thread.id, "plan-1", { revision: 2, guidance: "Again." })
    ).rejects.toMatchObject({ code: "plan-state" });
    expect(await bytesOf(thread.id)).toBe(before);
  });

  test("refreshPlanProposal clears through omitted guidance and refuses a running plan", async () => {
    const thread = await store.create(BOOK, "Refresh clear");
    await store.appendMessage(BOOK, thread.id, planParentMessage());
    await store.addPlan(BOOK, thread.id, newPlan({ guidance: "Keep the tense." }));
    const cleared = await store.refreshPlanProposal(BOOK, thread.id, "plan-1", { revision: 2 });
    expect(cleared.plans[0]?.revision).toBe(2);
    expect(cleared.plans[0]?.guidance).toBeUndefined();
    expect(cleared.plans[0]?.status).toBe("proposed");
    expect(cleared.plans[0]?.purpose).toBe("Revise the opening");
    expect(cleared.plans[0]?.steps.map((step) => step.text)).toEqual([
      "Read the opening",
      "Rewrite the door"
    ]);
    expect(cleared.plans[0]?.parent).toEqual({
      messageId: PLAN_PARENT_ID,
      turnId: PLAN_TURN_ID
    });

    const running = await seedThreadWithPlan("running", {
      guidance: "Keep the tense."
    });
    const runningBefore = await bytesOf(running);
    await expect(
      store.refreshPlanProposal(BOOK, running, "plan-1", { revision: 2, guidance: "Past tense." })
    ).rejects.toMatchObject({ code: "plan-state" });
    expect(await bytesOf(running)).toBe(runningBefore);
  });
});
