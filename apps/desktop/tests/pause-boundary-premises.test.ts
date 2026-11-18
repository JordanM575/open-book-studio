import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentEvent, AgentTurnInput } from "@ai-book-studio/core/agent";
import {
  agentMessageSchema,
  type AgentMessage,
  type AgentPlan,
  type AgentPlanStepState
} from "@ai-book-studio/core/agent/messages";
import type { AgentPlanEvent } from "@ai-book-studio/core/agent/plan-state";
import { ThreadStoreError } from "@ai-book-studio/core/agent/threads";
import type { StoredCredential } from "@ai-book-studio/core/providers/types";
import type { BookMeta } from "@ai-book-studio/core/schema";
import type { ProviderService } from "../src/main/providers";
import type { Studio } from "../src/main/studio";
import { AgentRuntime, type AgentOutcome } from "../src/main/agent/runtime";
import { Library } from "../src/main/library/store";
import { CheckpointStore } from "../src/main/agent/checkpoints";
import { UsageStore } from "../src/main/usage";
import { notificationFor } from "../src/main/background-copy";
import { LocalBackend } from "../src/main/backend";
import { BackendClient } from "../../toolkit/src/backend-client";

let root = "";
let library: Library;
let book: BookMeta;

const USAGE = {
  inputTokens: { total: 120, noCache: 120, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 12, text: 12, reasoning: undefined }
};

const credential: StoredCredential = {
  id: "conn_test0001",
  provider: "openrouter",
  label: "Test connection",
  kind: "api-key",
  createdAt: "2026-10-25T00:00:00.000Z",
  secret: "sk-test"
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-pause-"));
  library = await Library.open(root);
  book = await library.createBook({ title: "The Salt Road" });
  await library.updateBook(book.id, {
    defaultProvider: "openrouter",
    defaultConnectionId: credential.id,
    defaultModelId: "test-model"
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function studioFor(): Studio {
  return { library, requireLibrary: () => library } as unknown as Studio;
}

function providersFor(): ProviderService {
  return {
    credential: async () => credential,
    models: async () => ({
      models: [
        {
          id: "test-model",
          name: "Test Model",
          contextLength: 1_000,
          supportsTools: true,
          supportsImages: false,
          inputPricePerMillion: null,
          outputPricePerMillion: null
        }
      ],
      fetchedAt: "2026-10-25T00:00:00.000Z"
    })
  } as unknown as ProviderService;
}

function textModel(text = "Noted."): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: text },
          { type: "text-end", id: "text-1" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage: USAGE }
        ]
      })
    }
  });
}

function memoryApprovalModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-1", toolName: "remove_memory", input: JSON.stringify({ memoryId: "mem_test0001" }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, logprobs: undefined, usage: USAGE }
        ]
      })
    }
  });
}

function waitForDone(events: AgentEvent[], turnId: string): Promise<Extract<AgentEvent, { type: "done" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The done event did not arrive.")), 5_000);
    void (async () => {
      for (let waited = 0; waited < 5_000; waited += 25) {
        const next = events.find(
          (event): event is Extract<AgentEvent, { type: "done" }> => event.type === "done" && event.turnId === turnId
        );
        if (next) {
          clearTimeout(timer);
          resolve(next);
          return;
        }
        await new Promise((pause) => setTimeout(pause, 25));
      }
      clearTimeout(timer);
      reject(new Error("The done event did not arrive."));
    })();
  });
}

function replaceModel(chapterId: string, destructive = false): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: destructive ? "overwrite_chapter" : "replace_in_chapter",
              input: JSON.stringify(destructive ? { chapterId, content: "The new opening.\n" }
                : { chapterId, find: "The old opening.", replace: "The new opening." })
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, logprobs: undefined, usage: USAGE }
          ]
        })
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "Sharpened." },
            { type: "text-end", id: "text-1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage: USAGE }
          ]
        })
      }
    ]
  });
}

function waitForToolStart(events: AgentEvent[], turnId: string, name: string): Promise<Extract<AgentEvent, { type: "tool" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The tool-start event did not arrive.")), 5_000);
    void (async () => {
      for (let waited = 0; waited < 5_000; waited += 25) {
        const next = events.find(
          (event): event is Extract<AgentEvent, { type: "tool" }> =>
            event.type === "tool" && event.turnId === turnId && event.name === name && event.status === "start"
        );
        if (next) {
          clearTimeout(timer);
          resolve(next);
          return;
        }
        await new Promise((pause) => setTimeout(pause, 25));
      }
      clearTimeout(timer);
      reject(new Error("The tool-start event did not arrive."));
    })();
  });
}

function waitForStopped(events: AgentEvent[], turnId: string): Promise<Extract<AgentEvent, { type: "stopped" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The stopped event did not arrive.")), 5_000);
    void (async () => {
      for (let waited = 0; waited < 5_000; waited += 25) {
        const next = events.find(
          (event): event is Extract<AgentEvent, { type: "stopped" }> => event.type === "stopped" && event.turnId === turnId
        );
        if (next) {
          clearTimeout(timer);
          resolve(next);
          return;
        }
        await new Promise((pause) => setTimeout(pause, 25));
      }
      clearTimeout(timer);
      reject(new Error("The stopped event did not arrive."));
    })();
  });
}

function waitForApproval(events: AgentEvent[], turnId: string): Promise<Extract<AgentEvent, { type: "approval" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The approval event did not arrive.")), 5_000);
    void (async () => {
      for (let waited = 0; waited < 5_000; waited += 25) {
        const next = events.find(
          (event): event is Extract<AgentEvent, { type: "approval" }> =>
            event.type === "approval" && event.turnId === turnId
        );
        if (next) {
          clearTimeout(timer);
          resolve(next);
          return;
        }
        await new Promise((pause) => setTimeout(pause, 25));
      }
      clearTimeout(timer);
      reject(new Error("The approval event did not arrive."));
    })();
  });
}

/**
 * Spec 031 T002 (pause acknowledgment and continuation semantics) premises.
 * These pin the terminal-stop facts the pause boundary rests on; they choose
 * nothing. A stopped turn answers no approval — not even to a newer turn —
 * and every start is a new turn that never resurrects a stopped one.
 */
describe("pause boundary premises", () => {
  test("a stopped turn answers nothing, not even to a newer turn", async () => {
    await library.updateBook(book.id, {
      memories: [{ id: "mem_test0001", text: "The tide.", importance: "low", createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z" }]
    });
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => {
      events.push(event);
    }, () => memoryApprovalModel());

    const first = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Forget the tide." });
    const approval = await waitForApproval(events, first.turnId);
    await runtime.stop(first.turnId);
    await waitForStopped(events, first.turnId);

    await expect(runtime.approve(first.turnId, approval.approvalId, true)).rejects.toThrow(/no longer waiting/);
    const second = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Something else." });
    // Wait until the second turn parks on its own approval: its stream is settled and
    // nothing is still in flight when the test tears the library down.
    await waitForApproval(events, second.turnId);
    await expect(runtime.approve(second.turnId, approval.approvalId, true)).rejects.toThrow(/no longer waiting/);
    await runtime.stop(second.turnId);
    await waitForStopped(events, second.turnId);
  });

  test("a stop during a write waits out the write: the file is never torn and the stop is reported", async () => {
    const chapter = await library.createChapter(book.id, { title: "The Door", content: "The old opening.\n" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalSave = library.saveChapter.bind(library);
    library.saveChapter = (async (...args: Parameters<typeof originalSave>) => {
      await gate;
      return originalSave(...args);
    }) as typeof originalSave;

    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => {
      events.push(event);
    }, () => replaceModel(chapter.id));
    try {
      const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Sharpen the opening." });
      await waitForToolStart(events, started.turnId, "replace_in_chapter");
      await runtime.stop(started.turnId);
      release();
      const stopped = await waitForStopped(events, started.turnId);
      expect(stopped.changed).toBe(1);
      expect(stopped.undoAvailable).toBe(true);

      const saved = await library.readChapter(book.id, chapter.id);
      expect(saved.content).toBe("The new opening.\n");
      const thread = await library.threads.read(book.id, started.threadId);
      const tail = thread?.messages.at(-1);
      expect(tail?.parts.some((part) => part.type === "error" && part.code === "stopped")).toBe(true);
    } finally {
      release();
    }
  });

  test("every start is a new turn; stopping never blocks the next one", async () => {
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => {
      events.push(event);
    }, () => textModel());

    const first = await runtime.start({ mode: "edit", bookId: book.id, prompt: "First." });
    await waitForDone(events, first.turnId);
    const second = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Second." });
    expect(second.turnId).not.toBe(first.turnId);
    await expect(runtime.stop(first.turnId)).resolves.toBeNull();
    await waitForDone(events, second.turnId);
    const thread = await library.threads.read(book.id, second.threadId);
    expect(thread?.messages.length).toBeGreaterThan(0);
  });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function terminals(events: AgentEvent[]) {
  return events.filter((event) => event.type === "done" || event.type === "stopped" || event.type === "error");
}

describe("D178 definitive stop boundary", () => {
  test("the real loopback completion client receives settlement warnings after request-only Stop", async () => {
    const chapter = await library.createChapter(book.id, { title: "Loopback", content: "The old opening.\n" });
    const entered = gate();
    const held = gate();
    const append = spyOn(UsageStore.prototype, "append").mockImplementation(async () => {
      entered.release();
      await held.promise;
      throw new Error("Synthetic usage failure");
    });
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => replaceModel(chapter.id));
    const backend = new LocalBackend({
      current: () => ({ root, deviceId: library.deviceId, deviceName: library.deviceName }),
      requireLibrary: () => library
    }, {
      locatorPath: join(root, "synthetic-backend.json"), token: "synthetic-stop-token", port: 0,
      agent: {
        run: (input) => runtime.runToCompletion(input),
        stop: async (bookId) => ({ stopped: await runtime.stopBook(bookId) }),
        undo: (bookId, turnId) => runtime.undoLast(bookId, turnId)
      }
    });
    const address = await backend.start();
    const client = new BackendClient({ url: address.url, token: address.token });
    const completion = client.turn(book.id, "Replace");
    try {
      await entered.promise;
      expect(await client.stop(book.id)).toEqual({ stopped: 1 });
      expect(runtime.isWorking(book.id)).toBe(true);
      expect(terminals(events)).toHaveLength(0);
      await expect(client.turn(book.id, "Another")).rejects.toThrow(/still stopping/);
      held.release();
      const result = await completion;
      expect(result).toMatchObject({ stopped: true, changed: 1, undoAvailable: true });
      expect(result.persistenceError).toContain("usage could not be saved");
      expect(runtime.isWorking(book.id)).toBe(false);
      expect((await library.readChapter(book.id, chapter.id)).content).toBe("The new opening.\n");
    } finally { held.release(); await completion; await backend.stop(); append.mockRestore(); }
  });

  for (const stop of [false, true]) {
    for (const conversationFails of [false, true]) {
      test(`usage persistence failure survives ${stop ? "Stop" : "completion"}${conversationFails ? " with a conversation failure" : ""}`, async () => {
        const chapter = await library.createChapter(book.id, { title: "Usage", content: "The old opening.\n" });
        const entered = gate();
        const held = gate();
        const append = spyOn(UsageStore.prototype, "append").mockImplementation(async () => {
          entered.release();
          await held.promise;
          throw new Error("Synthetic usage storage failure");
        });
        if (conversationFails) library.threads.upsertMessage = async () => { throw new Error("Synthetic conversation failure"); };
        const events: AgentEvent[] = [];
        const outcomes: AgentOutcome[] = [];
        const model = replaceModel(chapter.id);
        const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model,
          (outcome) => outcomes.push(outcome));
        let completed = false;
        const completion = runtime.runToCompletion({ mode: "edit", bookId: book.id, prompt: "Replace", background: true })
          .then((result) => { completed = true; return result; });
        try {
          await entered.promise;
          const turnId = events[0]!.turnId;
          if (stop) expect(await runtime.stopBook(book.id)).toBe(1); // Request count, not settled turns.
          expect(completed).toBe(false);
          expect(terminals(events)).toHaveLength(0);
          expect(runtime.isWorking(book.id)).toBe(true);
          expect(runtime.hasActiveBackgroundTurns()).toBe(true);
          await expect(runtime.start({ mode: "edit", bookId: book.id, prompt: "Another" })).rejects.toThrow(/still stopping/);
          held.release();
          const result = await completion;
          const terminal = terminals(events)[0]!;
          expect(terminals(events)).toHaveLength(1);
          expect(terminal).toMatchObject({ type: stop ? "stopped" : "done", turnId, changed: 1, undoAvailable: true });
          const warning = "persistenceError" in terminal ? terminal.persistenceError : undefined;
          expect(warning).toContain("usage could not be saved");
          expect(warning).toContain("spend history may be incomplete");
          expect(warning?.includes("conversation outcome")).toBe(conversationFails);
          if (conversationFails) expect(warning?.match(/conversation outcome/g)).toHaveLength(1);
          expect(result).toMatchObject({ text: stop ? "" : "Sharpened.", changed: 1, undoAvailable: true, persistenceError: warning });
          expect(result.stopped).toBe(stop ? true : undefined);
          expect(outcomes).toHaveLength(1);
          expect(outcomes[0]).toMatchObject({ kind: stop ? "stopped" : "done", text: "Sharpened.", changed: 1, undoAvailable: true, persistenceError: warning });
          expect(notificationFor(outcomes[0]!)?.title).toContain("save warning");
          expect(notificationFor(outcomes[0]!)?.body).toContain(warning!);
          expect(await new UsageStore(root).read(book.id)).toHaveLength(0);
          expect(runtime.isWorking(book.id)).toBe(false);
          expect(model.doStreamCalls).toHaveLength(2);
          expect((await library.readChapter(book.id, chapter.id)).content).toBe("The new opening.\n");
          expect((await runtime.undoLast(book.id, turnId)).restored).toBe(1);
        } finally { held.release(); await completion; append.mockRestore(); }
      });
    }
  }

  test("a never-settling usage write keeps completion and Stop unresolved", async () => {
    const entered = gate();
    const append = spyOn(UsageStore.prototype, "append").mockImplementation(async () => {
      entered.release();
      return new Promise(() => {});
    });
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => textModel());
    try {
      const started = await runtime.start({ mode: "discuss", bookId: book.id, prompt: "Read" });
      await entered.promise;
      await runtime.stop(started.turnId);
      expect(terminals(events)).toHaveLength(0);
      expect(runtime.isWorking(book.id)).toBe(true);
      await expect(runtime.start({ mode: "discuss", bookId: book.id, prompt: "Read again" })).rejects.toThrow(/still stopping/);
    } finally { append.mockRestore(); }
  });

  test("failed approval and final conversation writes retain both warnings", async () => {
    const events: AgentEvent[] = [];
    const model = memoryApprovalModel();
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model);
    const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Forget" });
    const approval = await waitForApproval(events, started.turnId);
    library.threads.updateApproval = async () => { throw new Error("Synthetic approval failure"); };
    library.threads.upsertMessage = async () => { throw new Error("Synthetic conversation failure"); };
    await expect(runtime.approve(started.turnId, approval.approvalId, true)).rejects.toThrow(/action was not started/);
    const stopped = await waitForStopped(events, started.turnId);
    expect(stopped.persistenceError).toContain("approval could not be saved");
    expect(stopped.persistenceError).toContain("conversation outcome could not be fully saved");
    expect(stopped.changed).toBe(0);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  test("stop after approval has dispatched preserves the destructive write's late outcome", async () => {
    const chapter = await library.createChapter(book.id, { title: "Approved", content: "The old opening.\n" });
    const entered = gate();
    const held = gate();
    const save = library.saveChapter.bind(library);
    library.saveChapter = async (...args) => { entered.release(); await held.promise; return save(...args); };
    const model = replaceModel(chapter.id, true);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model);
    const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Overwrite" });
    try {
      const approval = await waitForApproval(events, started.turnId);
      await runtime.approve(started.turnId, approval.approvalId, true);
      await entered.promise;
      await runtime.stop(started.turnId);
      expect(terminals(events)).toHaveLength(0);
      expect(runtime.isWorking(book.id)).toBe(true);
      held.release();
      expect(await waitForStopped(events, started.turnId)).toMatchObject({ changed: 1, undoAvailable: true });
      const tail = (await library.threads.read(book.id, started.threadId))?.messages.at(-1);
      expect(tail?.parts.filter((part) => part.type === "tool-result")).toEqual([
        expect.objectContaining({ id: "call-1", output: expect.objectContaining({ ok: true }) })
      ]);
      expect(tail?.parts.find((part) => part.type === "approval")).toMatchObject({ status: "approved" });
      expect(model.doStreamCalls).toHaveLength(1);
      expect(terminals(events)).toHaveLength(1);
      expect((await runtime.undoLast(book.id, started.turnId)).restored).toBe(1);
    } finally { held.release(); }
  });

  test("a stop at tool dispatch closes the execution gate synchronously", async () => {
    const chapter = await library.createChapter(book.id, { title: "Dispatch", content: "The old opening.\n" });
    const save = spyOn(library, "saveChapter");
    const events: AgentEvent[] = [];
    const model = replaceModel(chapter.id);
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => {
      events.push(event);
      if (event.type === "tool" && event.status === "start") void runtime.stop(event.turnId);
    }, () => model);
    const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Replace" });
    expect(await waitForStopped(events, started.turnId)).toMatchObject({ changed: 0 });
    expect(save).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(1);
    expect((await library.readChapter(book.id, chapter.id)).content).toBe("The old opening.\n");
    save.mockRestore();
  });

  test("a late write rejection has a definitive failure receipt without a claimed change", async () => {
    const chapter = await library.createChapter(book.id, { title: "Rejected", content: "The old opening.\n" });
    const entered = gate();
    const held = gate();
    library.saveChapter = async () => { entered.release(); await held.promise; throw new Error("Synthetic rejected save"); };
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => replaceModel(chapter.id));
    const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Replace" });
    try {
      await entered.promise;
      await runtime.stop(started.turnId);
      held.release();
      expect(await waitForStopped(events, started.turnId)).toMatchObject({ changed: 0 });
      const tail = (await library.threads.read(book.id, started.threadId))?.messages.at(-1);
      expect(tail?.parts.filter((part) => part.type === "tool-result")).toEqual([
        expect.objectContaining({ isError: true, output: expect.objectContaining({ ok: false }) })
      ]);
      expect((await library.readChapter(book.id, chapter.id)).content).toBe("The old opening.\n");
      expect(terminals(events)).toHaveLength(1);
    } finally { held.release(); }
  });

  test("a checked write held beyond five seconds retains ownership and records its late receipt exactly once", async () => {
    const chapter = await library.createChapter(book.id, { title: "Gate", content: "The old opening.\n" });
    const entered = gate();
    const held = gate();
    const save = library.saveChapter.bind(library);
    library.saveChapter = async (...args) => { entered.release(); await held.promise; return save(...args); };
    const model = replaceModel(chapter.id);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model);
    const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Replace", background: true });
    try {
      await entered.promise;
      await runtime.stop(started.turnId);
      await runtime.stop(started.turnId);
      await new Promise((resolve) => setTimeout(resolve, 5_250));
      expect(terminals(events)).toHaveLength(0);
      expect(runtime.isWorking(book.id)).toBe(true);
      expect(runtime.hasActiveBackgroundTurns()).toBe(true);
      expect(events.filter((event) => event.type === "stopping")).toHaveLength(1);
      expect((await library.readChapter(book.id, chapter.id)).content).toBe("The old opening.\n");
      await expect(runtime.start({ mode: "edit", bookId: book.id, threadId: started.threadId, prompt: "New attempt" })).rejects.toThrow(/still stopping/);
      held.release();
      const stopped = await waitForStopped(events, started.turnId);
      expect(stopped).toMatchObject({ changed: 1, undoAvailable: true });
      expect(runtime.isWorking(book.id)).toBe(false);
      expect(terminals(events)).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(1);
      expect((await library.readChapter(book.id, chapter.id)).content).toBe("The new opening.\n");
      const thread = await library.threads.read(book.id, started.threadId);
      const receipts = thread?.messages.at(-1)?.parts.filter((part) => part.type === "tool-result");
      expect(receipts).toHaveLength(1);
      expect(receipts?.[0]).toMatchObject({ id: "call-1", output: { ok: true } });
      expect(thread?.checkpointTurns).toContain(started.turnId);
      expect(events.filter((event) => event.type === "tool" && event.status === "end")).toHaveLength(1);
      expect((await runtime.undoLast(book.id, started.turnId)).restored).toBe(1);
      expect((await library.readChapter(book.id, chapter.id)).content).toBe("The old opening.\n");
    } finally { held.release(); }
  }, 10_000);

  for (const order of ["stop-first", "approve-first"] as const) {
    test(`${order} consumes approval ownership before slow persistence`, async () => {
      const model = memoryApprovalModel();
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model);
      const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Forget" });
      const approval = await waitForApproval(events, started.turnId);
      const held = gate();
      const entered = gate();
      const update = library.threads.updateApproval.bind(library.threads);
      const upsert = library.threads.upsertMessage.bind(library.threads);
      if (order === "approve-first") {
        library.threads.updateApproval = async (...args) => { entered.release(); await held.promise; return update(...args); };
      } else {
        library.threads.upsertMessage = async (...args) => { entered.release(); await held.promise; return upsert(...args); };
      }
      let answering: Promise<null> | undefined;
      try {
        if (order === "approve-first") answering = runtime.approve(started.turnId, approval.approvalId, true);
        await runtime.stop(started.turnId);
        await entered.promise;
        await expect(runtime.approve(started.turnId, approval.approvalId, true)).rejects.toThrow(/no longer waiting/);
        expect(terminals(events)).toHaveLength(0);
        expect(runtime.isWorking(book.id)).toBe(true);
        held.release();
        await answering;
        await waitForStopped(events, started.turnId);
        expect(model.doStreamCalls).toHaveLength(1);
        expect(terminals(events)).toHaveLength(1);
        const tail = (await library.threads.read(book.id, started.threadId))?.messages.at(-1);
        expect(tail?.parts.find((part) => part.type === "approval")).toMatchObject({ status: order === "approve-first" ? "approved" : "expired" });
        expect(tail?.parts.some((part) => part.type === "tool-result")).toBe(false);
      } finally { held.release(); }
    });
  }

  test("failed approval persistence never resumes a destructive action", async () => {
    const model = memoryApprovalModel();
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model);
    const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Forget" });
    const approval = await waitForApproval(events, started.turnId);
    library.threads.updateApproval = async () => { throw new Error("Synthetic disk full"); };
    await expect(runtime.approve(started.turnId, approval.approvalId, true)).rejects.toThrow(/could not be saved/);
    const stopped = await waitForStopped(events, started.turnId);
    expect(stopped.persistenceError).toContain("action was not started");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(terminals(events)).toHaveLength(1);
  });

  test("initial approval publication failure has a distinct primary error and one persistence warning", async () => {
    const model = memoryApprovalModel();
    const events: AgentEvent[] = [];
    const outcomes: AgentOutcome[] = [];
    const updateBook = spyOn(library, "updateBook");
    library.threads.upsertMessage = async () => { throw new Error("PRIVATE_SYNTHETIC_STORAGE_FAILURE"); };
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model,
      (outcome) => outcomes.push(outcome));
    try {
      const failure: unknown = await runtime.runToCompletion({ mode: "edit", bookId: book.id, prompt: "Forget", background: true })
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("Missing completion failure");
      const terminal = events.find((event) => event.type === "error");
      const outcome = outcomes.find((entry) => entry.kind === "error");
      if (terminal?.type !== "error" || !outcome) throw new Error("Missing error receipts");
      const warning = "The conversation outcome could not be fully saved. Changes to the book remain.";
      const primary = "The approval request could not be saved. The proposed action was not started.";
      expect(terminal.message).toBe(primary);
      expect(terminal.persistenceError).toBe(warning);
      expect(terminal.changed).toBe(0);
      expect(failure.message).toContain(primary);
      expect(failure.message.split(warning)).toHaveLength(2);
      const notification = notificationFor(outcome);
      expect(notification?.body).toContain(primary);
      expect(notification?.body.split(warning)).toHaveLength(2);
      expect(JSON.stringify(events)).not.toContain("PRIVATE_SYNTHETIC_STORAGE_FAILURE");
      expect(events.some((event) => event.type === "approval")).toBe(false);
      expect(terminals(events)).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(1);
      expect(updateBook).not.toHaveBeenCalled();
    } finally { updateBook.mockRestore(); }
  });

  for (const failure of ["none", "checkpoint", "conversation", "reference"] as const) {
    test(`stop waits for slow persistence with failure at: ${failure}`, async () => {
      const chapter = await library.createChapter(book.id, { title: "Checkpoint", content: "The old opening.\n" });
      const entered = gate();
      const held = gate();
      const saving = CheckpointStore.prototype.save;
      const checkpoint = spyOn(CheckpointStore.prototype, "save").mockImplementation(async function (this: CheckpointStore, ...args) {
        entered.release();
        await held.promise;
        if (failure === "checkpoint") throw new Error("Synthetic checkpoint failure");
        return saving.apply(this, args);
      });
      const events: AgentEvent[] = [];
      const model = replaceModel(chapter.id);
      const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model);
      const finalEntered = gate();
      const finalHeld = gate();
      const upsert = library.threads.upsertMessage.bind(library.threads);
      library.threads.upsertMessage = async (...args) => {
        finalEntered.release();
        await finalHeld.promise;
        if (failure === "conversation") throw new Error("Synthetic conversation failure");
        return upsert(...args);
      };
      const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Replace" });
      if (failure === "reference") {
        const addCheckpoint = library.threads.addCheckpointTurn.bind(library.threads);
        library.threads.addCheckpointTurn = async (bookId, threadId, turnId) => {
          if (turnId === started.turnId) throw new Error("Synthetic checkpoint reference failure");
          return addCheckpoint(bookId, threadId, turnId);
        };
      }
      try {
        await entered.promise;
        await runtime.stop(started.turnId);
        expect(terminals(events)).toHaveLength(0);
        expect((await library.readChapter(book.id, chapter.id)).content).toBe("The new opening.\n");
        held.release();
        await finalEntered.promise;
        expect(terminals(events)).toHaveLength(0);
        expect(runtime.isWorking(book.id)).toBe(true);
        finalHeld.release();
        const stopped = await waitForStopped(events, started.turnId);
        expect(stopped).toMatchObject({ changed: 1, undoAvailable: failure !== "checkpoint" });
        expect(Boolean(stopped.persistenceError)).toBe(failure === "conversation" || failure === "reference");
        expect(terminals(events)).toHaveLength(1);
        expect(model.doStreamCalls).toHaveLength(1);
        expect(events.filter((event) => event.type === "tool" && event.status === "end")).toHaveLength(1);
      } finally { held.release(); finalHeld.release(); checkpoint.mockRestore(); }
    });
  }

  for (const approval of [false, true]) {
    test(`stop during ${approval ? "approval" : "ordinary outcome"} persistence cannot publish a late approval or done`, async () => {
      const entered = gate();
      const held = gate();
      const upsert = library.threads.upsertMessage.bind(library.threads);
      library.threads.upsertMessage = async (...args) => { entered.release(); await held.promise; return upsert(...args); };
      const model = approval ? memoryApprovalModel() : textModel();
      const events: AgentEvent[] = [];
      const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model);
      const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Request" });
      try {
        await entered.promise;
        await runtime.stop(started.turnId);
        expect(runtime.isWorking(book.id)).toBe(true);
        expect(terminals(events)).toHaveLength(0);
        held.release();
        await waitForStopped(events, started.turnId);
        expect(terminals(events)).toHaveLength(1);
        expect(events.some((event) => event.type === "approval")).toBe(false);
        expect(model.doStreamCalls).toHaveLength(1);
        const tail = (await library.threads.read(book.id, started.threadId))?.messages.at(-1);
        expect(tail?.parts.some((part) => part.type === "error" && part.code === "stopped")).toBe(true);
        if (approval) expect(tail?.parts.find((part) => part.type === "approval")).toMatchObject({ status: "expired" });
      } finally { held.release(); }
    });
  }

  test("a never-settling adapter remains stopping with unknown outcome", async () => {
    const chapter = await library.createChapter(book.id, { title: "Hung", content: "The old opening.\n" });
    const entered = gate();
    // No delayed disk access: this adapter deliberately never returns or writes.
    library.saveChapter = async () => { entered.release(); return new Promise(() => {}); };
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => replaceModel(chapter.id));
    const started = await runtime.start({ mode: "edit", bookId: book.id, prompt: "Replace" });
    await entered.promise;
    await runtime.stop(started.turnId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runtime.isWorking(book.id)).toBe(true);
    expect(terminals(events)).toHaveLength(0);
    await expect(runtime.start({ mode: "edit", bookId: book.id, prompt: "Another" })).rejects.toThrow(/still stopping/);
    expect((await library.readChapter(book.id, chapter.id)).content).toBe("The old opening.\n");
  });
});

/**
 * T015 rows 11-13b: the plan turn's pause boundary. These extend the stop premises above to
 * plan-linked turns: the stop return is not acknowledgment, no later tool or step write starts,
 * a hung call manufactures no terminal, and a failed state write can never yield Paused.
 */

const PAUSE_PLAN_ID = "plan_pause_premise_1";
const PAUSE_PLAN_PARENT = "msg_pausepremise01";
const PAUSE_PLAN_TURN = "turn_pausepremise01";

function pausePlanParent(): AgentMessage {
  return agentMessageSchema.parse({
    id: PAUSE_PLAN_PARENT,
    role: "assistant",
    parts: [{ type: "text", text: "Here is the plan." }],
    mode: "edit",
    turnId: PAUSE_PLAN_TURN,
    createdAt: "2026-10-25T00:00:00.000Z"
  });
}

async function seedPausePlan(steps: string[]): Promise<string> {
  const thread = await library.threads.create(book.id, "Pause boundary");
  await library.threads.appendMessage(book.id, thread.id, pausePlanParent());
  await library.threads.addPlan(book.id, thread.id, {
    id: PAUSE_PLAN_ID,
    purpose: "Revise the opening",
    steps,
    parent: { messageId: PAUSE_PLAN_PARENT, turnId: PAUSE_PLAN_TURN }
  });
  return thread.id;
}

function pausePlanInput(threadId: string): AgentTurnInput {
  return {
    bookId: book.id,
    threadId,
    mode: "edit",
    prompt: "Start the reviewed plan.",
    plan: { id: PAUSE_PLAN_ID, revision: 1, action: "start" }
  };
}

async function pausePlanOf(threadId: string): Promise<AgentPlan | null> {
  const thread = await library.threads.read(book.id, threadId);
  return thread?.plans.find((plan) => plan.id === PAUSE_PLAN_ID) ?? null;
}

function pausePlanStates(plan: AgentPlan): AgentPlanStepState[] {
  return plan.steps.map((entry) => entry.state);
}

function oneTool(name: string, input: unknown, id: number) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId: `pause-call-${id}`, toolName: name, input: JSON.stringify(input) },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: USAGE }
      ]
    })
  };
}

function planAppendModel(chapterId: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      oneTool("plan_step", { step: 1 }, 1),
      oneTool("append_to_chapter", { chapterId, text: "Late passage." }, 2),
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "Finished." },
            { type: "text-end", id: "text-1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage: USAGE }
          ]
        })
      }
    ]
  });
}

function waitForPlanChange(events: AgentEvent[], turnId: string, change: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The ${change} notice did not arrive.`)), 5_000);
    void (async () => {
      for (let waited = 0; waited < 5_000; waited += 25) {
        const found = events.some((event) =>
          event.type === "plan" && event.turnId === turnId && event.change === change);
        if (found) {
          clearTimeout(timer);
          resolve();
          return;
        }
        await new Promise((pause) => setTimeout(pause, 25));
      }
      clearTimeout(timer);
      reject(new Error(`The ${change} notice did not arrive.`));
    })();
  });
}

describe("T015 plan pause boundary", () => {
  test("stop returning null is not acknowledgment on a plan turn", async () => {
    const chapter = await library.createChapter(book.id, { title: "Plan gate", content: "The old opening.\n" });
    const threadId = await seedPausePlan(["Replace the opening"]);
    const entered = gate();
    const held = gate();
    const save = library.saveChapter.bind(library);
    library.saveChapter = async (...args) => { entered.release(); await held.promise; return save(...args); };
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event),
      () => planAppendModel(chapter.id));
    const started = await runtime.start(pausePlanInput(threadId));
    await entered.promise;
    await expect(runtime.stop(started.turnId)).resolves.toBeNull();
    await waitForPlanChange(events, started.turnId, "request-pause");
    expect(runtime.isWorking(book.id)).toBe(true);
    expect(terminals(events)).toHaveLength(0);
    expect((await pausePlanOf(threadId))?.status).toBe("pause-requested");
    expect(events.some((event) => event.type === "plan" && event.change === "confirm-pause")).toBe(false);
    held.release();
    expect(await waitForStopped(events, started.turnId)).toMatchObject({ changed: 1, undoAvailable: true });
    expect((await pausePlanOf(threadId))?.status).toBe("paused");
  });

  test("a never-settling plan call manufactures no terminal and no Paused claim", async () => {
    const chapter = await library.createChapter(book.id, { title: "Plan hung", content: "The old opening.\n" });
    const threadId = await seedPausePlan(["Replace the opening"]);
    const entered = gate();
    library.saveChapter = async () => { entered.release(); return new Promise(() => {}); };
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event),
      () => planAppendModel(chapter.id));
    const started = await runtime.start(pausePlanInput(threadId));
    await entered.promise;
    await runtime.stop(started.turnId);
    await waitForPlanChange(events, started.turnId, "request-pause");
    await new Promise((pause) => setTimeout(pause, 25));
    expect(events.some((event) => event.type === "plan" && event.change === "confirm-pause")).toBe(false);
    expect(terminals(events)).toHaveLength(0);
    expect((await pausePlanOf(threadId))?.status).toBe("pause-requested");
    expect(runtime.isWorking(book.id)).toBe(true);
    await new Promise((pause) => setTimeout(pause, 5_050));
    expect(events.some((event) => event.type === "plan" && event.change === "confirm-pause")).toBe(false);
    expect(terminals(events)).toHaveLength(0);
    expect(runtime.isWorking(book.id)).toBe(true);
    await expect(runtime.start({ mode: "edit", bookId: book.id, prompt: "Another" })).rejects.toThrow(/still stopping/);
  }, 10_000);

  test("no step write happens during settlement after the stop gate", async () => {
    const chapter = await library.createChapter(book.id, { title: "Plan settlement", content: "The old opening.\n" });
    const threadId = await seedPausePlan(["Read the opening"]);
    const model = new MockLanguageModelV4({
      doStream: [
        oneTool("plan_step", { step: 1 }, 1),
        oneTool("chapter_stats", { chapterId: chapter.id }, 2),
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Read." },
              { type: "text-end", id: "text-1" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage: USAGE }
            ]
          })
        }
      ]
    });
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model);
    const entered = gate();
    const held = gate();
    const read = library.readChapter.bind(library);
    library.readChapter = async (...args) => { entered.release(); await held.promise; return read(...args); };
    let stoppingSeen = false;
    runtime.onEvent((event) => { if (event.type === "stopping") stoppingSeen = true; });
    const store = library.threads;
    const original = store.applyPlanEvent;
    let stepWritesAfterStop = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (stoppingSeen && event.type === "step") stepWritesAfterStop++;
      return original.call(store, book, thread, plan, event);
    };
    try {
      const started = await runtime.start(pausePlanInput(threadId));
      await entered.promise;
      await runtime.stop(started.turnId);
      expect(terminals(events)).toHaveLength(0);
      held.release();
      await waitForStopped(events, started.turnId);
      expect(stepWritesAfterStop).toBe(0);
      const plan = await pausePlanOf(threadId);
      expect(plan?.status).toBe("paused");
      expect(pausePlanStates(plan!)).toEqual(["in-progress"]);
    } finally {
      held.release();
      store.applyPlanEvent = original;
    }
  });

  test("a failed in-flight step close blocks confirm and never yields Paused", async () => {
    const chapter = await library.createChapter(book.id, { title: "Plan close", content: "The old opening.\n" });
    const threadId = await seedPausePlan(["Read the opening", "Rewrite the door"]);
    const model = new MockLanguageModelV4({
      doStream: [
        oneTool("plan_step", { step: 1 }, 1),
        oneTool("chapter_stats", { chapterId: chapter.id }, 2),
        oneTool("plan_step", { step: 2 }, 3),
        oneTool("chapter_stats", { chapterId: chapter.id }, 4)
      ]
    });
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(studioFor(), providersFor(), (event) => events.push(event), () => model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    const entered = gate();
    const held = gate();
    let confirmCalls = 0;
    let failCalls = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "step" && event.state === "completed") {
        entered.release();
        await held.promise;
        throw new ThreadStoreError("io", "Synthetic in-flight step close failure");
      }
      if (event.type === "confirm-pause") confirmCalls++;
      if (event.type === "fail") {
        failCalls++;
        throw new ThreadStoreError("io", "Synthetic fail write failure");
      }
      return original.call(store, book, thread, plan, event);
    };
    try {
      const started = await runtime.start(pausePlanInput(threadId));
      await entered.promise;
      await runtime.stop(started.turnId);
      held.release();
      const stopped = await waitForStopped(events, started.turnId);
      expect(events.some((event) => event.type === "plan-error" && event.change === "step")).toBe(true);
      expect(events.some((event) => event.type === "plan" && event.change === "confirm-pause")).toBe(false);
      expect(events.some((event) => event.type === "plan-error" && event.change === "confirm-pause")).toBe(false);
      expect(confirmCalls).toBe(0);
      expect(failCalls).toBe(0);
      expect(stopped.persistenceError).toContain("The plan's pause could not be saved. The plan remains at its last confirmed state.");
      const plan = await pausePlanOf(threadId);
      expect(plan?.status).toBe("pause-requested");
      expect(pausePlanStates(plan!)).toEqual(["in-progress", "pending"]);
    } finally {
      store.applyPlanEvent = original;
    }
  });
});
