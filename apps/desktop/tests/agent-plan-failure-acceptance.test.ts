import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import type { ProviderService } from "../src/main/providers";
import type { Studio } from "../src/main/studio";
import { Library } from "../src/main/library/store";
import { AgentRuntime } from "../src/main/agent/runtime";
import { CheckpointStore } from "../src/main/agent/checkpoints";
import { PLAN_STATE_ERROR_MESSAGE } from "../src/main/agent/plan-tools";

/*
 * T018's cross-slice failure matrix. Every row drives a whole synthetic plan turn through the
 * merged runtime and asserts the terminal event, the stored plan, the chapter bytes, the
 * checkpoint facts and the plan notices together. No network, credential, live provider or real
 * manuscript is used, and nothing here adds a retry, rollback or new lifecycle.
 */

let root: string;
let library: Library;
let bookId: string;
let chapterA: string;
let chapterB: string;
let callId: number;
/** Fixture plans seeded directly through the store, so this test's runtime can own them. */
const seededPlans = new Map<string, string>();

const PLAN_ID = "plan-failure-1";
const PLAN_PARENT_ID = "msg_planfail01";
const PLAN_TURN_ID = "turn_planfail01";
const PLAN_PURPOSE = "Revise the lantern scene";
const CHAPTER_A = "A synthetic lantern shone.\n";
const CHAPTER_B = "The door was shut.\n";
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-plan-failure-"));
  library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic plan failure acceptance" });
  bookId = book.id;
  chapterA = (await library.createChapter(bookId, { title: "Light", content: CHAPTER_A })).id;
  chapterB = (await library.createChapter(bookId, { title: "Door", content: CHAPTER_B })).id;
  await library.updateBook(bookId, {
    defaultConnectionId: "conn_synthetic",
    defaultModelId: "synthetic-model"
  });
  callId = 0;
  seededPlans.clear();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function toolStream(calls: Array<{ name: string; input: unknown }>) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...calls.map((call) => ({
          type: "tool-call" as const,
          toolCallId: `call-${callId++}`,
          toolName: call.name,
          input: JSON.stringify(call.input)
        })),
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: USAGE }
      ]
    })
  };
}

function replyStream(text = "Synthetic reply.") {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE }
      ]
    })
  };
}

type StreamEntry = ReturnType<typeof toolStream> | ReturnType<typeof replyStream>;

function modelFor(entries: StreamEntry[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: entries });
}

function step(stepNumber: number) {
  return { name: "plan_step", input: { step: stepNumber } };
}

function appendA(text = "The lantern flared.") {
  return { name: "append_to_chapter", input: { chapterId: chapterA, text } };
}

function overwriteB(content: string) {
  return { name: "overwrite_chapter", input: { chapterId: chapterB, content } };
}

function runtimeFor(model: MockLanguageModelV4) {
  const events: AgentEvent[] = [];
  const runtime = new AgentRuntime(
    { library, requireLibrary: () => library } as unknown as Studio,
    {
      credential: async () => ({
        id: "conn_synthetic",
        provider: "openrouter",
        label: "Synthetic",
        kind: "api-key",
        secret: "synthetic-only"
      }),
      models: async () => ({
        models: [{
          id: "synthetic-model",
          name: "Synthetic model",
          supportsTools: true,
          supportsImages: false,
          contextLength: 10000
        }]
      })
    } as unknown as ProviderService,
    (event) => events.push(event),
    () => model,
    () => {}
  );
  // A fixture plan is seeded directly through the store. Record it as owned by this test's
  // runtime, exactly as the product proposal/start path would, so the T017 sweep does not treat
  // the fixture as a plan from a lost runtime.
  for (const [threadId, planId] of seededPlans) {
    (runtime as unknown as { ownedPlans: Set<string> }).ownedPlans.add(
      JSON.stringify([bookId, threadId, planId])
    );
  }
  return { runtime, events };
}

type Terminal = Extract<AgentEvent, { type: "done" | "error" | "stopped" }>;
type Approval = Extract<AgentEvent, { type: "approval" }>;

function terminalFor(runtime: AgentRuntime): { terminal: Promise<Terminal>; off: () => void } {
  let resolveTerminal!: (event: Terminal) => void;
  const terminal = new Promise<Terminal>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The synthetic plan turn did not finish.")), 4000);
    resolveTerminal = (event) => {
      clearTimeout(timer);
      resolve(event);
    };
  });
  const off = runtime.onEvent((event) => {
    if (event.type === "done" || event.type === "error" || event.type === "stopped") resolveTerminal(event);
  });
  return { terminal, off };
}

function approvalFor(runtime: AgentRuntime): { approval: Promise<Approval>; off: () => void } {
  let resolveApproval!: (event: Approval) => void;
  const approval = new Promise<Approval>((resolve) => { resolveApproval = resolve; });
  const off = runtime.onEvent((event) => { if (event.type === "approval") resolveApproval(event); });
  return { approval, off };
}

async function startPlan(
  runtime: AgentRuntime,
  threadId: string,
  overrides: Partial<AgentTurnInput> = {}
): Promise<{ started: Awaited<ReturnType<AgentRuntime["start"]>>; terminal: Terminal }> {
  const { terminal, off } = terminalFor(runtime);
  try {
    const started = await runtime.start({
      bookId,
      threadId,
      mode: "edit",
      prompt: "Start the reviewed plan.",
      plan: { id: PLAN_ID, revision: 1, action: "start" },
      ...overrides
    });
    return { started, terminal: await terminal };
  } finally {
    off();
  }
}

function planParent(): AgentMessage {
  return agentMessageSchema.parse({
    id: PLAN_PARENT_ID,
    role: "assistant",
    parts: [{ type: "text", text: "Here is the plan." }],
    mode: "edit",
    turnId: PLAN_TURN_ID,
    createdAt: new Date().toISOString()
  });
}

async function seedPlan(steps: string[]): Promise<string> {
  const thread = await library.threads.create(bookId, "Plan conversation");
  await library.threads.appendMessage(bookId, thread.id, planParent());
  await library.threads.addPlan(bookId, thread.id, {
    id: PLAN_ID,
    purpose: PLAN_PURPOSE,
    steps,
    parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID }
  });
  seededPlans.set(thread.id, PLAN_ID);
  return thread.id;
}

async function planOf(threadId: string): Promise<AgentPlan | null> {
  const thread = await library.threads.read(bookId, threadId);
  return thread?.plans.find((plan) => plan.id === PLAN_ID) ?? null;
}

function states(plan: AgentPlan): AgentPlanStepState[] {
  return plan.steps.map((entry) => entry.state);
}

function planNotices(events: AgentEvent[]) {
  return events.filter((event) =>
    event.type === "plan" || event.type === "plan-step" || event.type === "plan-error"
  );
}

function planChanges(events: AgentEvent[]): string[] {
  return events
    .filter((event): event is Extract<AgentEvent, { type: "plan" }> => event.type === "plan")
    .map((event) => event.change);
}

describe("plan failure acceptance", () => {
  test("M1: a provider failure after a real write keeps the write and reports real change and undo", async () => {
    const threadId = await seedPlan(["Append the lantern", "Revise the door"]);
    const streams = [
      toolStream([step(1)]),
      toolStream([appendA()]),
      toolStream([step(2)])
    ];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        const entry = streams[calls - 1];
        if (!entry) throw new Error("Synthetic provider failure");
        return entry;
      }
    });
    const { runtime, events } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);

    expect(calls).toBe(4);
    expect(terminal.type).toBe("error");
    if (terminal.type !== "error") throw new Error("Expected a terminal error");
    expect(terminal.code).toBe("unknown");
    expect(terminal.message).toContain("Synthetic provider failure");
    expect(terminal.changed).toBe(1);
    expect(terminal.undoAvailable).toBe(true);
    expect(terminal.persistenceError).toBeUndefined();

    const plan = await planOf(threadId);
    expect(plan?.status).toBe("failed");
    expect(states(plan!)).toEqual(["completed", "not-completed"]);
    expect((await library.readChapter(bookId, chapterA)).content).toContain("The lantern flared.");
    expect((await library.readChapter(bookId, chapterB)).content).toBe(CHAPTER_B);

    const notices = planNotices(events);
    expect(notices.filter((event) => event.type === "plan-step").map((event) =>
      event.type === "plan-step" ? `${event.index}:${event.state}` : null
    )).toEqual(["0:in-progress", "0:completed", "1:in-progress", "1:not-completed"]);
    expect(planChanges(events)).toEqual(["fail"]);
    expect(events.some((event) => event.type === "plan-error")).toBe(false);
    const failIndex = events.findIndex((event) => event.type === "plan" && event.change === "fail");
    const terminalIndex = events.findIndex((event) => event.type === "error");
    expect(failIndex).toBeGreaterThanOrEqual(0);
    expect(failIndex).toBeLessThan(terminalIndex);

    const thread = await library.threads.read(bookId, threadId);
    const assistant = thread?.messages.find((message) => message.turnId === terminal.turnId);
    expect(assistant?.parts.some((part) => part.type === "error")).toBe(true);
    expect(thread?.checkpointTurns).toContain(terminal.turnId);

    const undone = await runtime.undoLast(bookId, terminal.turnId);
    expect(undone).toEqual({ restored: 1, skipped: 0 });
    expect((await library.readChapter(bookId, chapterA)).content).toBe(CHAPTER_A);
  });

  test("M2: a save conflict keeps the author's words and the replacement copy, and fails the plan", async () => {
    const threadId = await seedPlan(["Append the lantern", "Replace the door"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([appendA()]),
      toolStream([step(2)]),
      toolStream([overwriteB("The door opened.\n")]),
      replyStream("The door changed, so I left it.")
    ]);
    const { runtime, events } = runtimeFor(model);
    const { terminal, off: offTerminal } = terminalFor(runtime);
    const { approval, off: offApproval } = approvalFor(runtime);
    let started: Awaited<ReturnType<AgentRuntime["start"]>>;
    try {
      started = await runtime.start({
        bookId,
        threadId,
        mode: "edit",
        prompt: "Start the reviewed plan.",
        plan: { id: PLAN_ID, revision: 1, action: "start" }
      });
      const request = await approval;
      const current = await library.readChapter(bookId, chapterB);
      const saved = await library.saveChapter(bookId, chapterB, "The author's line.\n", {
        baseVersion: current.version,
        baseHash: current.hash
      });
      expect(saved.status).toBe("saved");
      await runtime.approve(started.turnId, request.approvalId, true);
    } finally {
      offApproval();
    }
    const finished = await terminal;
    offTerminal();

    expect(finished.type).toBe("done");
    if (finished.type !== "done") throw new Error("Expected a terminal done");
    expect(finished.changed).toBe(1);
    expect(finished.undoAvailable).toBe(true);
    expect(finished.persistenceError).toBeUndefined();

    const plan = await planOf(threadId);
    expect(plan?.status).toBe("failed");
    expect(states(plan!)).toEqual(["completed", "not-completed"]);
    expect((await library.readChapter(bookId, chapterA)).content).toContain("The lantern flared.");
    expect((await library.readChapter(bookId, chapterB)).content).toBe("The author's line.\n");

    const overwrite = events.find(
      (event): event is Extract<AgentEvent, { type: "tool" }> =>
        event.type === "tool" && event.name === "overwrite_chapter" && event.status === "end"
    );
    expect(overwrite).toBeDefined();
    const output = overwrite!.output as { ok: boolean; changedSinceRead: boolean; savedAs: string };
    expect(output).toMatchObject({ ok: false, changedSinceRead: true });
    expect(typeof output.savedAs).toBe("string");
    expect(await readFile(join(root, output.savedAs), "utf8")).toContain("The door opened.");
    expect(overwrite!.detail).toContain("changed since you read it, so nothing was overwritten");

    expect(planNotices(events).filter((event) => event.type === "plan-step").map((event) =>
      event.type === "plan-step" ? `${event.index}:${event.state}` : null
    )).toEqual(["0:in-progress", "0:completed", "1:in-progress", "1:not-completed"]);
    expect(planChanges(events)).toEqual(["request-approval", "approval-settled", "fail"]);
    expect(events.some((event) => event.type === "plan-error")).toBe(false);

    const thread = await library.threads.read(bookId, threadId);
    const approvalPart = thread?.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "approval");
    expect(approvalPart?.type === "approval" ? approvalPart.status : null).toBe("approved");

    const undone = await runtime.undoLast(bookId, finished.turnId);
    expect(undone).toEqual({ restored: 1, skipped: 0 });
    expect((await library.readChapter(bookId, chapterA)).content).toBe(CHAPTER_A);
    expect((await library.readChapter(bookId, chapterB)).content).toBe("The author's line.\n");
  });

  test("M3: a checkpoint failure leaves the write and the confirmed completion but no undo", async () => {
    const threadId = await seedPlan(["Append the lantern"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([appendA()]),
      replyStream("The lantern flared.")
    ]);
    const { runtime, events } = runtimeFor(model);
    const saving = spyOn(CheckpointStore.prototype, "save")
      .mockRejectedValue(new Error("Synthetic checkpoint failure"));
    try {
      const { terminal } = await startPlan(runtime, threadId);
      expect(terminal.type).toBe("done");
      if (terminal.type !== "done") throw new Error("Expected a terminal done");
      expect(terminal.changed).toBe(1);
      expect(terminal.undoAvailable).toBe(false);
      expect(terminal.persistenceError).toBeUndefined();

      const plan = await planOf(threadId);
      expect(plan?.status).toBe("completed");
      expect(states(plan!)).toEqual(["completed"]);
      expect(planChanges(events)).toEqual(["complete"]);
      expect(events.some((event) => event.type === "plan-error")).toBe(false);
      expect((await library.readChapter(bookId, chapterA)).content).toContain("The lantern flared.");

      const thread = await library.threads.read(bookId, threadId);
      expect(thread?.checkpointTurns).toEqual([]);
      expect(await new CheckpointStore(root).latest(bookId)).toBeNull();
      await expect(runtime.undoLast(bookId, terminal.turnId)).rejects
        .toThrow(/No agent turn is left to undo/);
    } finally {
      saving.mockRestore();
    }
  });

  test("M4: a failed complete and a failed fail leave the plan running and never claim Completed", async () => {
    const threadId = await seedPlan(["Append the lantern"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([appendA()]),
      replyStream("Finished.")
    ]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "complete") {
        throw new ThreadStoreError("io", "Synthetic complete write failure");
      }
      if (event.type === "fail") {
        throw new ThreadStoreError("io", "Synthetic fail write failure");
      }
      return original.call(store, book, thread, plan, event);
    };
    let terminal: Terminal;
    try {
      ({ terminal } = await startPlan(runtime, threadId));
    } finally {
      store.applyPlanEvent = original;
    }

    expect(terminal.type).toBe("error");
    if (terminal.type !== "error") throw new Error("Expected a terminal error");
    expect(terminal.code).toBe("plan-state");
    expect(terminal.message).toBe(PLAN_STATE_ERROR_MESSAGE);
    expect(terminal.changed).toBe(1);
    expect(terminal.undoAvailable).toBe(true);
    expect(terminal.persistenceError).toBeUndefined();

    const plan = await planOf(threadId);
    expect(plan?.status).toBe("running");
    expect(states(plan!)).toEqual(["completed"]);
    expect(planChanges(events)).toEqual([]);
    const planErrors = events.filter(
      (event): event is Extract<AgentEvent, { type: "plan-error" }> => event.type === "plan-error"
    );
    expect(planErrors.map((event) => event.change)).toEqual(["complete", "fail"]);
    expect(planErrors.map((event) => event.message)).toEqual([
      "Synthetic complete write failure",
      "Synthetic fail write failure"
    ]);
    expect(events.some((event) => event.type === "plan" && event.change === "complete")).toBe(false);
    expect(events.some((event) => event.type === "plan" && event.change === "fail")).toBe(false);
    expect(events.some((event) => event.type === "stopped")).toBe(false);
    expect(events.some((event) => event.type === "plan" &&
      (event.change === "confirm-pause" || event.change === "cancel"))).toBe(false);

    expect((await library.readChapter(bookId, chapterA)).content).toContain("The lantern flared.");
    const checkpoint = await new CheckpointStore(root).latest(bookId);
    expect(checkpoint?.turnId).toBe(terminal.turnId);
    const undone = await runtime.undoLast(bookId, terminal.turnId);
    expect(undone).toEqual({ restored: 1, skipped: 0 });
    expect((await library.readChapter(bookId, chapterA)).content).toBe(CHAPTER_A);
  });

  test("M5a: a close failure after a real step write leaves no completed step and no undo claim", async () => {
    const threadId = await seedPlan(["Append the lantern", "Revise the door"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([appendA()]),
      toolStream([step(2)]),
      replyStream("Stopped after the append.")
    ]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "step" && event.state === "completed") {
        throw new ThreadStoreError("io", "Synthetic step write failure");
      }
      return original.call(store, book, thread, plan, event);
    };
    let terminal: Terminal;
    try {
      ({ terminal } = await startPlan(runtime, threadId));
    } finally {
      store.applyPlanEvent = original;
    }

    expect(terminal.type).toBe("error");
    if (terminal.type !== "error") throw new Error("Expected a terminal error");
    expect(terminal.code).toBe("plan-state");
    expect(terminal.message).toBe(PLAN_STATE_ERROR_MESSAGE);
    expect(terminal.changed).toBe(1);
    expect(terminal.undoAvailable).toBe(true);
    expect(terminal.persistenceError).toBeUndefined();

    const plan = await planOf(threadId);
    expect(plan?.status).toBe("failed");
    expect(states(plan!)).toEqual(["not-completed", "not-completed"]);
    expect(events.some((event) =>
      event.type === "plan-step" && event.index === 0 && event.state === "completed"
    )).toBe(false);
    const stepError = events.find(
      (event): event is Extract<AgentEvent, { type: "plan-error" }> =>
        event.type === "plan-error" && event.change === "step"
    );
    expect(stepError?.message).toBe("Synthetic step write failure");
    expect(events.some((event) => event.type === "plan" && event.change === "complete")).toBe(false);
    expect((await library.readChapter(bookId, chapterA)).content).toContain("The lantern flared.");

    const undone = await runtime.undoLast(bookId, terminal.turnId);
    expect(undone).toEqual({ restored: 1, skipped: 0 });
    expect((await library.readChapter(bookId, chapterA)).content).toBe(CHAPTER_A);
  });

  test("M5b: a store conflict at the step boundary changes nothing and adds no undo claim", async () => {
    const threadId = await seedPlan(["Append the lantern"]);
    const model = modelFor([
      toolStream([step(1)]),
      replyStream("The boundary could not be saved.")
    ]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    const conflict = new ThreadStoreError(
      "conflict",
      "That conversation changed since it was read. Your version was kept as a copy; nothing was overwritten.",
      `books/${bookId}/conflicts/thread_planfail01.conflict-external-edit.json`
    );
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "step" && event.state === "in-progress") throw conflict;
      return original.call(store, book, thread, plan, event);
    };
    let terminal: Terminal;
    try {
      ({ terminal } = await startPlan(runtime, threadId));
    } finally {
      store.applyPlanEvent = original;
    }

    expect(terminal.type).toBe("error");
    if (terminal.type !== "error") throw new Error("Expected a terminal error");
    expect(terminal.code).toBe("plan-state");
    expect(terminal.message).toBe(PLAN_STATE_ERROR_MESSAGE);
    expect(terminal.changed).toBe(0);
    expect(terminal.undoAvailable).toBe(true);
    expect(terminal.persistenceError).toBeUndefined();

    const plan = await planOf(threadId);
    expect(plan?.status).toBe("failed");
    expect(states(plan!)).toEqual(["not-completed"]);
    expect(events.some((event) =>
      event.type === "plan-step" && event.state === "in-progress"
    )).toBe(false);
    const stepError = events.find(
      (event): event is Extract<AgentEvent, { type: "plan-error" }> =>
        event.type === "plan-error" && event.change === "step"
    );
    expect(stepError?.message).toBe(conflict.message);
    expect(events.some((event) => event.type === "plan" && event.change === "complete")).toBe(false);
    expect((await library.readChapter(bookId, chapterA)).content).toBe(CHAPTER_A);
    expect(await new CheckpointStore(root).latest(bookId)).toBeNull();
  });
});
