import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  AgentTurnRefusedError,
  type AgentEvent,
  type AgentTurnInput
} from "@ai-book-studio/core/agent";
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

let root: string;
let library: Library;
let bookId: string;
let chapterId: string;
let callId: number;

const PLAN_ID = "plan-pause-1";
const PLAN_PARENT_ID = "msg_planpause01";
const PLAN_TURN_ID = "turn_planpause01";
const OLD_APPROVAL = "approval-old";
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-plan-pause-"));
  library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic plan pause" });
  bookId = book.id;
  chapterId = (await library.createChapter(bookId, {
    title: "Light",
    content: "A synthetic lantern shone.\n"
  })).id;
  await library.updateBook(bookId, { defaultConnectionId: "conn_synthetic", defaultModelId: "synthetic-model" });
  callId = 0;
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

function stats() {
  return { name: "chapter_stats", input: { chapterId } };
}

function runtimeFor(model: MockLanguageModelV4) {
  const events: AgentEvent[] = [];
  let factoryCalls = 0;
  const runtime = new AgentRuntime(
    { library, requireLibrary: () => library } as unknown as Studio,
    {
      credential: async () => {
        return { id: "conn_synthetic", provider: "openrouter", label: "Synthetic", kind: "api-key", secret: "synthetic-only" };
      },
      models: async () => {
        return { models: [{ id: "synthetic-model", name: "Synthetic model", supportsTools: true, supportsImages: false, contextLength: 10000 }] };
      }
    } as unknown as ProviderService,
    (event) => events.push(event),
    () => { factoryCalls++; return model; },
    () => {}
  );
  return { runtime, events, factoryCalls: () => factoryCalls };
}

type Terminal = Extract<AgentEvent, { type: "done" | "error" | "stopped" }>;
type ApprovalEvent = Extract<AgentEvent, { type: "approval" }>;
type PlanNotice = Extract<AgentEvent, { type: "plan" }>;

function nextTerminal(runtime: AgentRuntime): Promise<Terminal> {
  return new Promise<Terminal>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The synthetic plan turn did not finish.")), 8000);
    const stop = runtime.onEvent((event) => {
      if (event.type !== "done" && event.type !== "error" && event.type !== "stopped") return;
      clearTimeout(timer);
      stop();
      resolve(event);
    });
  });
}

function waitFor<T extends AgentEvent>(
  events: AgentEvent[],
  match: (event: AgentEvent) => event is T,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void (async () => {
      for (let waited = 0; waited < 8000; waited += 10) {
        const found = events.find(match);
        if (found) {
          resolve(found);
          return;
        }
        await new Promise((pause) => setTimeout(pause, 10));
      }
      reject(new Error(`${label} did not arrive.`));
    })();
  });
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  for (let waited = 0; waited < 8000; waited += 10) {
    if (condition()) return;
    await new Promise((pause) => setTimeout(pause, 10));
  }
  throw new Error(`${label} did not arrive.`);
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function planParent(withApproval = false): AgentMessage {
  return agentMessageSchema.parse({
    id: PLAN_PARENT_ID,
    role: "assistant",
    parts: [
      { type: "text", text: "Here is the plan." },
      ...(withApproval
        ? [{
            type: "approval",
            approvalId: OLD_APPROVAL,
            turnId: PLAN_TURN_ID,
            name: "overwrite_chapter",
            input: { chapterId, content: "Replaced by an old approval.\n" },
            status: "pending",
            requestedAt: new Date().toISOString()
          }]
        : [])
    ],
    mode: "edit",
    turnId: PLAN_TURN_ID,
    createdAt: new Date().toISOString()
  });
}

async function seedPlan(options: {
  steps?: string[];
  withApproval?: boolean;
  state?: "proposed" | "running" | "paused" | "paused-in-progress";
} = {}): Promise<string> {
  const thread = await library.threads.create(bookId, "Plan conversation");
  await library.threads.appendMessage(bookId, thread.id, planParent(options.withApproval === true));
  await library.threads.addPlan(bookId, thread.id, {
    id: PLAN_ID,
    purpose: "Revise the lantern scene",
    steps: options.steps ?? ["Write the opening", "Write the close"],
    parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID }
  });
  const state = options.state ?? "proposed";
  if (state !== "proposed") {
    await library.threads.applyPlanEvent(bookId, thread.id, PLAN_ID, { type: "start", revision: 1 });
  }
  if (state === "paused-in-progress") {
    await library.threads.applyPlanEvent(bookId, thread.id, PLAN_ID, {
      type: "step", revision: 1, index: 0, state: "in-progress"
    });
  }
  if (state === "paused" || state === "paused-in-progress") {
    await library.threads.applyPlanEvent(bookId, thread.id, PLAN_ID, { type: "request-pause" });
    await library.threads.applyPlanEvent(bookId, thread.id, PLAN_ID, { type: "confirm-pause" });
  }
  return thread.id;
}

async function planOf(threadId: string): Promise<AgentPlan | null> {
  const thread = await library.threads.read(bookId, threadId);
  return thread?.plans.find((plan) => plan.id === PLAN_ID) ?? null;
}

function states(plan: AgentPlan): AgentPlanStepState[] {
  return plan.steps.map((entry) => entry.state);
}

function startInput(threadId: string, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    bookId,
    threadId,
    mode: "edit",
    prompt: "Start the reviewed plan.",
    plan: { id: PLAN_ID, revision: 1, action: "start" },
    ...overrides
  };
}

function resumeInput(threadId: string, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    bookId,
    threadId,
    mode: "edit",
    prompt: "Resume the reviewed plan.",
    plan: { id: PLAN_ID, revision: 1, action: "resume" },
    ...overrides
  };
}

function pauseSequence(events: AgentEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "stopping") return ["stopping"];
    if (event.type === "stopped") return ["stopped"];
    if (event.type === "plan" && (event.change === "request-pause" || event.change === "confirm-pause")) {
      return [`plan:${event.change}`];
    }
    return [];
  });
}

describe("plan pause boundary", () => {
  test("pause before any tool writes once each pause and confirms before the one stopped event", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening", "Write the close"] });
    const model = modelFor([toolStream([step(1)]), replyStream()]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const started = await runtime.start(startInput(threadId));

    await runtime.stop(started.turnId);
    const stopped = await terminal;
    expect(stopped.type).toBe("stopped");
    if (stopped.type === "stopped") expect(stopped.changed).toBe(0);

    expect(pauseSequence(events)).toEqual([
      "stopping",
      "plan:request-pause",
      "plan:confirm-pause",
      "stopped"
    ]);
    expect(events.some((event) => event.type === "plan-error")).toBe(false);

    const plan = await planOf(threadId);
    expect(plan?.status).toBe("paused");
    expect(states(plan!)).not.toContain("completed");
    expect(states(plan!)).not.toContain("not-completed");
  });

  test("pause with a tool in flight keeps its receipt and change but writes no step outcome", async () => {
    const threadId = await seedPlan({ steps: ["Write the opening", "Write the close"] });
    const entered = gate();
    const held = gate();
    const save = library.saveChapter.bind(library);
    library.saveChapter = async (...args) => {
      entered.release();
      await held.promise;
      return save(...args);
    };
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: "First passage." } }]),
      toolStream([step(2)]),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: "Second passage." } }]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const started = await runtime.start(startInput(threadId));
    await waitFor(events, (event): event is Extract<AgentEvent, { type: "tool" }> =>
      event.type === "tool" && event.name === "append_to_chapter" && event.status === "start",
    "the in-flight tool start");
    await entered.promise;

    await runtime.stop(started.turnId);
    await waitFor(events, (event): event is PlanNotice =>
      event.type === "plan" && event.change === "request-pause", "the request-pause notice");
    expect((await planOf(threadId))?.status).toBe("pause-requested");
    expect(events.some((event) => event.type === "stopped")).toBe(false);
    expect(events.some((event) => event.type === "plan" && event.change === "confirm-pause")).toBe(false);
    expect(events.filter((event) => event.type === "stopping")).toHaveLength(1);

    held.release();
    const stopped = await terminal;
    expect(stopped.type).toBe("stopped");
    if (stopped.type === "stopped") {
      expect(stopped.changed).toBe(1);
      expect(stopped.undoAvailable).toBe(true);
    }
    const plan = await planOf(threadId);
    expect(plan?.status).toBe("paused");
    expect(states(plan!)).toEqual(["in-progress", "pending"]);
    expect((await library.readChapter(bookId, chapterId)).content).toContain("First passage.");
    expect((await library.readChapter(bookId, chapterId)).content).not.toContain("Second passage.");
    expect(model.doStreamCalls).toHaveLength(2);
    expect(events.filter((event) => event.type === "plan-step").map((event) =>
      event.type === "plan-step" ? `${event.index}:${event.state}` : "")).toEqual(["0:in-progress"]);
    const thread = await library.threads.read(bookId, threadId);
    const receipts = thread?.messages.at(-1)?.parts.filter((part) =>
      part.type === "tool-result" && part.name === "append_to_chapter");
    expect(receipts).toHaveLength(1);
    expect(receipts?.[0]).toMatchObject({ name: "append_to_chapter", output: expect.objectContaining({ ok: true }) });
  });

  test("no later tool starts after the stop gate and the open step stays in progress", async () => {
    const threadId = await seedPlan({ steps: ["Write the opening"] });
    const save = spyOn(library, "saveChapter");
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: "Too late." } }])
    ]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const stopOnAppend = runtime.onEvent((event) => {
      if (event.type === "tool" && event.name === "append_to_chapter" && event.status === "start") {
        void runtime.stop(event.turnId);
      }
    });
    await runtime.start(startInput(threadId));
    const stopped = await terminal;
    stopOnAppend();
    expect(stopped.type).toBe("stopped");
    if (stopped.type === "stopped") expect(stopped.changed).toBe(0);

    const stoppingIndex = events.findIndex((event) => event.type === "stopping");
    expect(events.slice(stoppingIndex + 1).some((event) => event.type === "plan-step")).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(2);
    expect((await planOf(threadId))?.status).toBe("paused");
    expect(states((await planOf(threadId))!)).toEqual(["in-progress"]);
    expect((await library.readChapter(bookId, chapterId)).content).toBe("A synthetic lantern shone.\n");
  });

  for (const order of ["stop-first", "approve-first"] as const) {
    test(`${order} expires a pending approval without running the destructive action`, async () => {
      const threadId = await seedPlan({ steps: ["Replace the opening"] });
      const model = modelFor([
        toolStream([step(1)]),
        toolStream([{ name: "overwrite_chapter", input: { chapterId, content: "Replaced opening.\n" } }])
      ]);
      const { runtime, events } = runtimeFor(model);
      const terminal = nextTerminal(runtime);
      const started = await runtime.start(startInput(threadId));
      const approval = await waitFor(events, (event): event is ApprovalEvent =>
        event.type === "approval" && event.turnId === started.turnId, "the approval request");
      expect(approval.planId).toBe(PLAN_ID);
      expect((await planOf(threadId))?.status).toBe("waiting-for-approval");
      expect(states((await planOf(threadId))!)).toEqual(["in-progress"]);

      let answering: Promise<null> | undefined;
      let held: ReturnType<typeof gate> | undefined;
      if (order === "approve-first") {
        held = gate();
        const entered = gate();
        const update = library.threads.updateApproval.bind(library.threads);
        library.threads.updateApproval = async (...args) => {
          entered.release();
          await held!.promise;
          return update(...args);
        };
        answering = runtime.approve(started.turnId, approval.approvalId, true);
        await entered.promise;
        await runtime.stop(started.turnId);
        held.release();
        await expect(answering).rejects.toThrow(/approval could not be saved/);
      } else {
        await runtime.stop(started.turnId);
      }

      const stopped = await terminal;
      expect(stopped.type).toBe("stopped");
      if (stopped.type === "stopped") expect(stopped.changed).toBe(0);
      await expect(runtime.approve(started.turnId, approval.approvalId, true)).rejects.toThrow(/no longer waiting/);
      expect((await library.readChapter(bookId, chapterId)).content).toBe("A synthetic lantern shone.\n");
      const plan = await planOf(threadId);
      expect(plan?.status).toBe("paused");
      expect(states(plan!)).toEqual(["in-progress"]);
      const thread = await library.threads.read(bookId, threadId);
      const stored = thread?.messages.flatMap((message) => message.parts)
        .find((part) => part.type === "approval" && part.approvalId === approval.approvalId);
      expect(stored).toMatchObject({
        type: "approval",
        status: order === "approve-first" ? "approved" : "expired"
      });
      const stoppingIndex = events.findIndex((event) => event.type === "stopping");
      expect(events.slice(stoppingIndex + 1).some((event) => event.type === "approval")).toBe(false);
      expect(model.doStreamCalls).toHaveLength(2);
    });
  }
});

describe("plan resume", () => {
  test("resume is a new Edit turn with a fresh approval and no inherited guidance", async () => {
    const threadId = await seedPlan({
      steps: ["Replace the opening"],
      withApproval: true,
      state: "paused"
    });
    const before = await planOf(threadId);
    expect(before?.status).toBe("paused");
    const startedAt = before?.startedAt;
    const messagesBefore = (await library.threads.read(bookId, threadId))?.messages.length ?? 0;

    const model = modelFor([
      toolStream([step(1)]),
      toolStream([{ name: "overwrite_chapter", input: { chapterId, content: "Replaced opening.\n" } }]),
      replyStream()
    ]);
    const { runtime, events, factoryCalls } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const started = await runtime.start(resumeInput(threadId));
    expect(started.turnId).not.toBe(PLAN_TURN_ID);
    expect(started.plan).toMatchObject({ id: PLAN_ID, revision: 1, status: "running" });

    const approval = await waitFor(events, (event): event is ApprovalEvent =>
      event.type === "approval" && event.turnId === started.turnId, "the resumed turn's approval");
    expect(approval).toMatchObject({ planId: PLAN_ID, planRevision: 1, name: "overwrite_chapter" });
    expect(approval.turnId).toBe(started.turnId);
    expect((await planOf(threadId))?.status).toBe("waiting-for-approval");
    expect((await library.readChapter(bookId, chapterId)).content).toBe("A synthetic lantern shone.\n");
    expect(factoryCalls()).toBe(1);

    const pausedThread = await library.threads.read(bookId, threadId);
    expect(pausedThread?.messages.flatMap((message) => message.parts)
      .find((part) => part.type === "approval" && part.approvalId === OLD_APPROVAL))
      .toMatchObject({ type: "approval", status: "expired" });
    await expect(runtime.approve(PLAN_TURN_ID, OLD_APPROVAL, true)).rejects.toThrow(/no longer waiting/);

    await runtime.approve(started.turnId, approval.approvalId, true);
    const finished = await terminal;
    expect(finished.type).toBe("done");
    const plan = await planOf(threadId);
    expect(plan).toMatchObject({ status: "completed", revision: 1, startedAt });
    expect(states(plan!)).toEqual(["completed"]);
    expect((await library.readChapter(bookId, chapterId)).content).toBe("Replaced opening.\n");
    expect(model.doStreamCalls).toHaveLength(3);

    const thread = await library.threads.read(bookId, threadId);
    expect(thread?.messages.length).toBe(messagesBefore + 2);
    const user = thread?.messages.findLast((message) => message.role === "user");
    expect(user?.parts).toEqual([{ type: "text", text: "Resume the reviewed plan." }]);
    expect(thread?.messages.flatMap((message) => message.parts)
      .find((part) => part.type === "approval" && part.turnId === started.turnId))
      .toMatchObject({ type: "approval", turnId: started.turnId, status: "approved" });
  });

  test("resume re-enters an in-progress step without a second in-progress notice", async () => {
    const threadId = await seedPlan({
      steps: ["Read the opening", "Rewrite the door"],
      state: "paused-in-progress"
    });
    const revision = (await planOf(threadId))?.revision;
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats()]),
      toolStream([step(2)]),
      toolStream([stats()]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    await runtime.start(resumeInput(threadId));
    expect((await terminal).type).toBe("done");

    const plan = await planOf(threadId);
    expect(plan).toMatchObject({ status: "completed", revision });
    expect(states(plan!)).toEqual(["completed", "completed"]);
    expect(events.filter((event) => event.type === "plan-step").map((event) =>
      event.type === "plan-step" ? `${event.index}:${event.state}` : ""))
      .toEqual(["0:completed", "1:in-progress", "1:completed"]);
    const stepResult = events.find((event): event is Extract<AgentEvent, { type: "tool" }> =>
      event.type === "tool" && event.name === "plan_step" && event.status === "end" &&
      (event.output as { step?: number } | undefined)?.step === 1);
    expect(stepResult?.output).toMatchObject({ ok: true, step: 1, text: "Read the opening" });
  });

  test("a duplicate resume is refused before the provider with one turn and one user message", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening"], state: "paused" });
    const messagesBefore = (await library.threads.read(bookId, threadId))?.messages.length ?? 0;
    const held = gate();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        await held.promise;
        return replyStream();
      }
    });
    const { runtime, events: runtimeEvents } = runtimeFor(model);
    try {
      const results = await Promise.allSettled([
        runtime.start(resumeInput(threadId)),
        runtime.start(resumeInput(threadId))
      ]);
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<AgentRuntime["start"]>>> =>
        result.status === "fulfilled");
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(AgentTurnRefusedError);
      expect((rejected[0]!.reason as AgentTurnRefusedError).refusal).toBe("plan-not-resumable");
      await waitUntil(() => calls === 1, "the resumed provider stream");
      expect(calls).toBe(1);
      expect((await planOf(threadId))?.status).toBe("running");
      const thread = await library.threads.read(bookId, threadId);
      expect(thread?.messages.length).toBe(messagesBefore + 1);
      expect(thread?.messages.at(-1)).toMatchObject({
        role: "user",
        parts: [{ type: "text", text: "Resume the reviewed plan." }]
      });

      await runtime.stop(fulfilled[0]!.value.turnId);
      held.release();
      await waitFor(runtimeEvents, (event): event is Extract<AgentEvent, { type: "stopped" }> =>
        event.type === "stopped", "stopped");
    } finally {
      held.release();
    }
  });
});

describe("plan pause failures and races", () => {
  test("a request-pause write failure reports once, attempts no confirm and keeps the last status", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening"] });
    const held = gate();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        if (calls === 1) return toolStream([step(1)]);
        await held.promise;
        return replyStream();
      }
    });
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    let requestCalls = 0;
    let confirmCalls = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "request-pause") {
        requestCalls++;
        throw new ThreadStoreError("io", "Synthetic request-pause write failure");
      }
      if (event.type === "confirm-pause") confirmCalls++;
      return original.call(store, book, thread, plan, event);
    };
    try {
      const terminal = nextTerminal(runtime);
      const started = await runtime.start(startInput(threadId));
      await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan-step" }> =>
        event.type === "plan-step" && event.state === "in-progress", "the first step boundary");
      await runtime.stop(started.turnId);
      held.release();
      const stopped = await terminal;
      expect(stopped.type).toBe("stopped");
      if (stopped.type === "stopped") {
        expect(stopped.persistenceError).toContain("The plan's pause could not be saved. The plan remains at its last confirmed state.");
      }
      expect(requestCalls).toBe(1);
      expect(confirmCalls).toBe(0);
      expect(events.some((event) => event.type === "plan" && event.change === "request-pause")).toBe(false);
      expect(events.some((event) => event.type === "plan" && event.change === "confirm-pause")).toBe(false);
      expect(events.filter((event) => event.type === "plan-error" && event.change === "request-pause")).toHaveLength(1);
      const errorIndex = events.findIndex((event) => event.type === "plan-error" && event.change === "request-pause");
      const stoppingIndex = events.findIndex((event) => event.type === "stopping");
      expect(errorIndex).toBeGreaterThan(stoppingIndex);
      expect((await planOf(threadId))?.status).toBe("running");
      expect(states((await planOf(threadId))!)).toEqual(["in-progress"]);
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("a confirm-pause failure emits one error before stopped and never claims Paused", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening"] });
    const held = gate();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        if (calls === 1) return toolStream([step(1)]);
        await held.promise;
        return replyStream();
      }
    });
    const { runtime, events, factoryCalls } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    let requestCalls = 0;
    let confirmCalls = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "confirm-pause") {
        confirmCalls++;
        throw new ThreadStoreError("io", "Synthetic confirm-pause write failure");
      }
      if (event.type === "request-pause") requestCalls++;
      return original.call(store, book, thread, plan, event);
    };
    try {
      const terminal = nextTerminal(runtime);
      const started = await runtime.start(startInput(threadId));
      await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan-step" }> =>
        event.type === "plan-step" && event.state === "in-progress", "the first step boundary");
      await runtime.stop(started.turnId);
      await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan" }> =>
        event.type === "plan" && event.change === "request-pause", "the request-pause notice");
      held.release();
      const stopped = await terminal;
      expect(stopped.type).toBe("stopped");
      if (stopped.type === "stopped") {
        expect(stopped.persistenceError).toContain("The plan's pause could not be saved. The plan remains at its last confirmed state.");
      }
      expect(requestCalls).toBe(1);
      expect(confirmCalls).toBe(1);
      expect(events.some((event) => event.type === "plan" && event.change === "confirm-pause")).toBe(false);
      expect(events.filter((event) => event.type === "plan-error" && event.change === "confirm-pause")).toHaveLength(1);
      const errorIndex = events.findIndex((event) => event.type === "plan-error" && event.change === "confirm-pause");
      const stoppedIndex = events.findIndex((event) => event.type === "stopped");
      expect(errorIndex).toBeGreaterThanOrEqual(0);
      expect(errorIndex).toBeLessThan(stoppedIndex);
      expect((await planOf(threadId))?.status).toBe("pause-requested");

      const streams = model.doStreamCalls.length;
      const factories = factoryCalls();
      const resume = runtime.start(resumeInput(threadId));
      await expect(resume).rejects.toThrow(/cannot be resumed/);
      await expect(resume).rejects.toBeInstanceOf(AgentTurnRefusedError);
      expect(model.doStreamCalls.length).toBe(streams);
      expect(factoryCalls()).toBe(factories);
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("a duplicate Pause writes one request, one confirm and one stopped", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening"] });
    const held = gate();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        if (calls === 1) return toolStream([step(1)]);
        await held.promise;
        return replyStream();
      }
    });
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    const entered = gate();
    const requestHeld = gate();
    let requestCalls = 0;
    let confirmCalls = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "request-pause") {
        requestCalls++;
        entered.release();
        await requestHeld.promise;
      }
      if (event.type === "confirm-pause") confirmCalls++;
      return original.call(store, book, thread, plan, event);
    };
    try {
      const terminal = nextTerminal(runtime);
      const started = await runtime.start(startInput(threadId));
      await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan-step" }> =>
        event.type === "plan-step" && event.state === "in-progress", "the first step boundary");
      const first = runtime.stop(started.turnId);
      const second = runtime.stop(started.turnId);
      await Promise.all([first, second]);
      await entered.promise;
      expect(requestCalls).toBe(1);
      held.release();
      requestHeld.release();
      const stopped = await terminal;
      expect(stopped.type).toBe("stopped");
      expect(events.filter((event) => event.type === "stopping")).toHaveLength(1);
      expect(events.filter((event) => event.type === "plan" && event.change === "request-pause")).toHaveLength(1);
      expect(events.filter((event) => event.type === "plan" && event.change === "confirm-pause")).toHaveLength(1);
      expect(events.filter((event) => event.type === "stopped")).toHaveLength(1);
      expect(requestCalls).toBe(1);
      expect(confirmCalls).toBe(1);
      expect((await planOf(threadId))?.status).toBe("paused");
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("a plan that completes during the stop race stays completed and is never paused", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening"] });
    const model = modelFor([toolStream([step(1)]), toolStream([stats()]), replyStream()]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    const entered = gate();
    const held = gate();
    let completeCalls = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "complete") {
        completeCalls++;
        entered.release();
        await held.promise;
      }
      return original.call(store, book, thread, plan, event);
    };
    try {
      const terminal = nextTerminal(runtime);
      const started = await runtime.start(startInput(threadId));
      await entered.promise;
      await runtime.stop(started.turnId);
      held.release();
      const stopped = await terminal;
      expect(stopped.type).toBe("stopped");
      expect(completeCalls).toBe(1);
      const plan = await planOf(threadId);
      expect(plan?.status).toBe("completed");
      expect(states(plan!)).toEqual(["completed"]);
      expect(events.some((event) => event.type === "plan" && event.change === "confirm-pause")).toBe(false);
      expect(events.some((event) => event.type === "plan-error")).toBe(false);
      const completeNotice = events.findIndex((event) => event.type === "plan" && event.change === "complete");
      expect(completeNotice).toBeGreaterThanOrEqual(0);
      expect(events.some((event) => event.type === "plan" && event.change === "confirm-pause")).toBe(false);
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("a failed in-flight write stores an error receipt without rewriting the step", async () => {
    const threadId = await seedPlan({ steps: ["Write the opening", "Write the close"] });
    const entered = gate();
    const held = gate();
    library.saveChapter = async () => {
      entered.release();
      await held.promise;
      throw new Error("Synthetic rejected save");
    };
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: "Late passage." } }])
    ]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const started = await runtime.start(startInput(threadId));
    await entered.promise;
    await runtime.stop(started.turnId);
    held.release();
    const stopped = await terminal;
    expect(stopped.type).toBe("stopped");
    if (stopped.type === "stopped") expect(stopped.changed).toBe(0);
    const plan = await planOf(threadId);
    expect(plan?.status).toBe("paused");
    expect(states(plan!)).toEqual(["in-progress", "pending"]);
    const thread = await library.threads.read(bookId, threadId);
    const receipts = thread?.messages.at(-1)?.parts.filter((part) =>
      part.type === "tool-result" && part.name === "append_to_chapter");
    expect(receipts).toHaveLength(1);
    expect(receipts?.[0]).toMatchObject({
      name: "append_to_chapter",
      isError: true,
      output: expect.objectContaining({ ok: false })
    });
    expect(events.filter((event) => event.type === "plan-step").map((event) =>
      event.type === "plan-step" ? `${event.index}:${event.state}` : "")).toEqual(["0:in-progress"]);
    expect(events.some((event) => event.type === "plan-error")).toBe(false);
    expect((await library.readChapter(bookId, chapterId)).content).toBe("A synthetic lantern shone.\n");
  });
});
