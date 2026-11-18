import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import type { ProviderService } from "../src/main/providers";
import type { Studio } from "../src/main/studio";
import { Library } from "../src/main/library/store";
import { AgentRuntime } from "../src/main/agent/runtime";

let root: string;
let library: Library;
let bookId: string;
let chapterId: string;
let providerReads: number;
let callId: number;

const PLAN_ID = "plan-start-1";
const PLAN_PARENT_ID = "msg_planstart01";
const PLAN_TURN_ID = "turn_planstart01";
const PLAN_PURPOSE = "Revise the lantern scene";
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-plan-start-"));
  library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic plan start" });
  bookId = book.id;
  chapterId = (await library.createChapter(bookId, {
    title: "Light",
    content: "A synthetic lantern shone.\n"
  })).id;
  await library.updateBook(bookId, { defaultConnectionId: "conn_synthetic", defaultModelId: "synthetic-model" });
  providerReads = 0;
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
        providerReads++;
        return { id: "conn_synthetic", provider: "openrouter", label: "Synthetic", kind: "api-key", secret: "synthetic-only" };
      },
      models: async () => {
        providerReads++;
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

function nextTerminal(runtime: AgentRuntime): Promise<Terminal> {
  return new Promise<Terminal>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The synthetic plan turn did not finish.")), 4000);
    const stop = runtime.onEvent((event) => {
      if (event.type !== "done" && event.type !== "error" && event.type !== "stopped") return;
      clearTimeout(timer);
      stop();
      resolve(event);
    });
  });
}

async function startPlan(
  runtime: AgentRuntime,
  threadId: string,
  overrides: Partial<AgentTurnInput> = {}
): Promise<{ started: Awaited<ReturnType<AgentRuntime["start"]>>; terminal: Terminal }> {
  let resolveTerminal!: (event: Terminal) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const terminal = new Promise<Terminal>((resolve, reject) => {
    resolveTerminal = resolve;
    timer = setTimeout(() => reject(new Error("The synthetic plan turn did not finish.")), 4000);
  });
  const off = runtime.onEvent((event) => {
    if (event.type === "done" || event.type === "error" || event.type === "stopped") resolveTerminal(event);
  });
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
    if (timer) clearTimeout(timer);
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
  return events.filter((event) => event.type === "plan" || event.type === "plan-step" || event.type === "plan-error");
}

describe("start acknowledgement and step progress", () => {
  test("acknowledges running after the write with no proposed notice and completes both reviewed steps", async () => {
    const threadId = await seedPlan([PLAN_PURPOSE, "Rewrite the door"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats()]),
      toolStream([step(2)]),
      toolStream([stats()]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const { started, terminal } = await startPlan(runtime, threadId);

    expect(started.plan).toMatchObject({ id: PLAN_ID, revision: 1, status: "running" });
    expect(terminal.type).toBe("done");
    const plan = await planOf(threadId);
    expect(plan).toMatchObject({ status: "completed", revision: 1, purpose: PLAN_PURPOSE });
    expect(states(plan!)).toEqual(["completed", "completed"]);
    expect(plan?.terminalAt).toBeTruthy();

    const notices = planNotices(events);
    expect(notices.filter((event) => event.type === "plan").map((event) => event.type === "plan" ? event.change : null))
      .toEqual(["complete"]);
    expect(notices.filter((event) => event.type === "plan-step").map((event) => event.type === "plan-step" ? `${event.index}:${event.state}` : null))
      .toEqual(["0:in-progress", "0:completed", "1:in-progress", "1:completed"]);
    expect(events.some((event) => event.type === "plan-error")).toBe(false);
    // Start itself emits no plan notice: the first plan notice is the terminal complete, which
    // follows the step notices, not the running acknowledgement.
    const firstStepNotice = events.findIndex((event) => event.type === "plan-step");
    const firstPlanNotice = events.findIndex((event) => event.type === "plan");
    expect(firstStepNotice).toBeGreaterThanOrEqual(0);
    expect(firstPlanNotice).toBeGreaterThan(firstStepNotice);

    // The first boundary returns the stored purpose once; the second returns only its step.
    const planStepResults = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool" }> =>
        event.type === "tool" && event.name === "plan_step" && event.status === "end"
    );
    expect(planStepResults).toHaveLength(2);
    expect(planStepResults[0]!.output).toMatchObject({ ok: true, step: 1, total: 2, purpose: PLAN_PURPOSE });
    expect(planStepResults[1]!.output).toMatchObject({ ok: true, step: 2, total: 2 });
    expect(JSON.stringify(planStepResults[1]!.output)).not.toContain("purpose");

    const thread = await library.threads.read(bookId, threadId);
    expect(thread?.checkpointTurns).toEqual([]);
  });

  test("a successful step closes only when the next boundary follows observed work", async () => {
    const threadId = await seedPlan(["Read the opening", "Rewrite the door"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats()]),
      toolStream([step(2)]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);
    expect(terminal.type).toBe("done");
    const plan = await planOf(threadId);
    expect(states(plan!)).toEqual(["completed", "not-completed"]);
    expect(plan?.status).toBe("failed");
    expect(events.some((event) => event.type === "plan" && event.change === "complete")).toBe(false);
  });

  test("a step with no tool call is not completed and fails the plan", async () => {
    const threadId = await seedPlan(["Read the opening", "Rewrite the door"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([step(2)]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);
    expect(terminal.type).toBe("done");
    const plan = await planOf(threadId);
    expect(states(plan!)).toEqual(["not-completed", "not-completed"]);
    expect(plan?.status).toBe("failed");
    const refused = events.find(
      (event) => event.type === "tool" && event.name === "plan_step" && event.status === "end" &&
        (event.output as { ok?: boolean } | undefined)?.ok === false
    );
    expect(refused?.type === "tool" ? refused.output : null).toMatchObject({ ok: false });
  });

  test("a repeated boundary for the active step is idempotent and writes one notice", async () => {
    const threadId = await seedPlan(["Read the opening"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats()]),
      toolStream([step(1)]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);
    expect(terminal.type).toBe("done");
    expect((await planOf(threadId))?.status).toBe("completed");
    const inProgress = events.filter((event) => event.type === "plan-step" && event.state === "in-progress");
    expect(inProgress).toHaveLength(1);
  });

  test("multiple calls in one step complete only when every result succeeded", async () => {
    const threadId = await seedPlan(["Read the opening"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats(), stats()]),
      replyStream()
    ]);
    const { runtime } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);
    expect(terminal.type).toBe("done");
    expect((await planOf(threadId))?.status).toBe("completed");
    expect(states((await planOf(threadId))!)).toEqual(["completed"]);
  });

  test("a failed tool closes the step, fails the plan and blocks later ordinary tools", async () => {
    const threadId = await seedPlan(["Read the opening", "Rewrite the door"]);
    const before = (await library.readChapter(bookId, chapterId)).content;
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats()]),
      toolStream([step(2)]),
      toolStream([{ name: "read_chapter", input: { chapterId: "ch_missing0001" } }]),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: "Late change." } }]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);
    expect(terminal.type).toBe("done");
    const plan = await planOf(threadId);
    expect(states(plan!)).toEqual(["completed", "not-completed"]);
    expect(plan?.status).toBe("failed");
    expect((await library.readChapter(bookId, chapterId)).content).toBe(before);
    const notices = planNotices(events);
    const failedStep = notices.findIndex(
      (event) => event.type === "plan-step" && event.index === 1 && event.state === "not-completed"
    );
    const planFail = notices.findIndex((event) => event.type === "plan" && event.change === "fail");
    expect(failedStep).toBeGreaterThanOrEqual(0);
    expect(planFail).toBeGreaterThan(failedStep);
    const blocked = events.find(
      (event) => event.type === "tool" && event.name === "append_to_chapter" && event.status === "end"
    );
    expect(blocked?.type === "tool" ? blocked.output : null).toMatchObject({ ok: false });
  });

  test("unknown and out-of-order boundaries are refused without failing a correct plan", async () => {
    const threadId = await seedPlan(["Read the opening", "Rewrite the door"]);
    const model = modelFor([
      toolStream([step(0)]),
      toolStream([step(2)]),
      toolStream([step(1)]),
      toolStream([stats()]),
      toolStream([step(2)]),
      toolStream([step(1)]),
      toolStream([stats()]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);
    expect(terminal.type).toBe("done");
    expect((await planOf(threadId))?.status).toBe("completed");
    const failedStepCalls = events.filter(
      (event) => event.type === "tool" && event.name === "plan_step" && event.status === "end" &&
        (event.output as { ok?: boolean } | undefined)?.ok === false
    );
    expect(failedStepCalls.length).toBeGreaterThanOrEqual(3);
    expect(events.some((event) => event.type === "plan-error")).toBe(false);
  });

  test("an ordinary tool before plan_step is refused without changing the book", async () => {
    const threadId = await seedPlan(["Append the lantern"]);
    const before = (await library.readChapter(bookId, chapterId)).content;
    const model = modelFor([
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: "A second lantern." } }]),
      toolStream([step(1)]),
      toolStream([stats()]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);
    expect(terminal.type).toBe("done");
    expect((await library.readChapter(bookId, chapterId)).content).toBe(before);
    const refused = events.find((event) => event.type === "tool" && event.name === "append_to_chapter" && event.status === "end");
    expect(refused?.type === "tool" ? refused.output : null).toMatchObject({
      ok: false,
      message: "Call plan_step with the next step before doing the work. Nothing changed."
    });
    expect((await planOf(threadId))?.status).toBe("completed");
  });

  test("a plan is complete only when every reviewed step completed", async () => {
    const threadId = await seedPlan(["Read the opening", "Rewrite the door"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats()]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);
    expect(terminal.type).toBe("done");
    const plan = await planOf(threadId);
    expect(states(plan!)).toEqual(["completed", "not-completed"]);
    expect(plan?.status).toBe("failed");
    expect(events.some((event) => event.type === "plan" && event.change === "complete")).toBe(false);
  });
  test("an author stop writes no plan transition and leaves the plan running", async () => {
    const threadId = await seedPlan(["Read the opening"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats()]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const started = await runtime.start({
      bookId,
      threadId,
      mode: "edit",
      prompt: "Start the reviewed plan.",
      plan: { id: PLAN_ID, revision: 1, action: "start" }
    });
    await runtime.stop(started.turnId);
    expect((await terminal).type).toBe("stopped");
    const plan = await planOf(threadId);
    expect(plan?.status).toBe("running");
    expect(states(plan!)).toEqual(["pending"]);
    expect(events.some((event) =>
      event.type === "plan" || event.type === "plan-step" || event.type === "plan-error"
    )).toBe(false);
  });
});

describe("plan approvals", () => {
  test("a failed approval-wait write publishes no approval and never runs the action", async () => {
    const threadId = await seedPlan(["Append the lantern", "Replace the opening"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: "A second lantern." } }]),
      toolStream([step(2)]),
      toolStream([{ name: "overwrite_chapter", input: { chapterId, content: "Replaced opening.\n" } }]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "request-approval") {
        throw new ThreadStoreError("io", "Synthetic approval-wait write failure");
      }
      return original.call(store, book, thread, plan, event);
    };
    try {
      const { terminal } = await startPlan(runtime, threadId);
      expect(terminal.type).toBe("error");
      if (terminal.type === "error") expect(terminal.code).toBe("plan-state");
      expect(events.some((event) => event.type === "approval")).toBe(false);
      expect(events.some((event) => event.type === "plan-error" && event.change === "request-approval"))
        .toBe(true);
      expect((await library.readChapter(bookId, chapterId)).content).not.toContain("Replaced opening");
      expect((await planOf(threadId))?.status).toBe("failed");
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("a denied destructive step fails without writing and keeps the earlier step's change", async () => {
    const threadId = await seedPlan(["Append the lantern", "Replace the opening"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: "A second lantern." } }]),
      toolStream([step(2)]),
      toolStream([{ name: "overwrite_chapter", input: { chapterId, content: "Replaced opening.\n" } }]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    let resolveApproval!: (event: Extract<AgentEvent, { type: "approval" }>) => void;
    const approval = new Promise<Extract<AgentEvent, { type: "approval" }>>((resolve) => {
      resolveApproval = resolve;
    });
    const off = runtime.onEvent((event) => { if (event.type === "approval") resolveApproval(event); });
    try {
      const started = await runtime.start({
        bookId,
        threadId,
        mode: "edit",
        prompt: "Start the reviewed plan.",
        plan: { id: PLAN_ID, revision: 1, action: "start" }
      });
      const request = await approval;
      expect(request).toMatchObject({ name: "overwrite_chapter", planId: PLAN_ID, planRevision: 1 });
      const waiting = await planOf(threadId);
      expect(waiting?.status).toBe("waiting-for-approval");
      expect(states(waiting!)).toEqual(["completed", "in-progress"]);

      const done = new Promise<Terminal>((resolve) => {
        const stop = runtime.onEvent((event) => {
          if (event.type !== "done" && event.type !== "error" && event.type !== "stopped") return;
          stop();
          resolve(event);
        });
      });
      await runtime.approve(started.turnId, request.approvalId, false);
      const terminal = await done;
      expect(terminal.type).toBe("done");
      const plan = await planOf(threadId);
      expect(states(plan!)).toEqual(["completed", "not-completed"]);
      expect(plan?.status).toBe("failed");
      const chapter = await library.readChapter(bookId, chapterId);
      expect(chapter.content).toContain("second lantern");
      expect(chapter.content).not.toContain("Replaced opening");
      expect(events.some((event) => event.type === "plan" && event.change === "complete")).toBe(false);
      expect(events.filter((event) => event.type === "plan").map((event) => event.type === "plan" ? event.change : null))
        .toEqual(["request-approval", "approval-settled", "fail"]);
      if (terminal.type === "done") {
        expect(terminal.changed).toBe(1);
        expect(terminal.undoAvailable).toBe(true);
      }
    } finally {
      off();
    }
  });

  test("an approved call completes the step and the plan after the settled write", async () => {
    const threadId = await seedPlan(["Append the lantern", "Replace the opening"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: "A second lantern." } }]),
      toolStream([step(2)]),
      toolStream([{ name: "overwrite_chapter", input: { chapterId, content: "Replaced opening.\n" } }]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    let resolveApproval!: (event: Extract<AgentEvent, { type: "approval" }>) => void;
    const approval = new Promise<Extract<AgentEvent, { type: "approval" }>>((resolve) => {
      resolveApproval = resolve;
    });
    const off = runtime.onEvent((event) => { if (event.type === "approval") resolveApproval(event); });
    try {
      const started = await runtime.start({
        bookId,
        threadId,
        mode: "edit",
        prompt: "Start the reviewed plan.",
        plan: { id: PLAN_ID, revision: 1, action: "start" }
      });
      const request = await approval;
      const completed = new Promise<Terminal>((resolve) => {
        const stop = runtime.onEvent((event) => {
          if (event.type !== "done" && event.type !== "error" && event.type !== "stopped") return;
          stop();
          resolve(event);
        });
      });
      await runtime.approve(started.turnId, request.approvalId, true);
      expect((await completed).type).toBe("done");
      const plan = await planOf(threadId);
      expect(states(plan!)).toEqual(["completed", "completed"]);
      expect(plan?.status).toBe("completed");
      expect((await library.readChapter(bookId, chapterId)).content).toBe("Replaced opening.\n");
      expect(events.filter((event) => event.type === "plan").map((event) => event.type === "plan" ? event.change : null))
        .toEqual(["request-approval", "approval-settled", "complete"]);
    } finally {
      off();
    }
  });

  test("a failed approval-settled write stops the turn without running the action", async () => {
    const threadId = await seedPlan(["Append the lantern", "Replace the opening"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: "A second lantern." } }]),
      toolStream([step(2)]),
      toolStream([{ name: "overwrite_chapter", input: { chapterId, content: "Replaced opening.\n" } }]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    let resolveApproval!: (event: Extract<AgentEvent, { type: "approval" }>) => void;
    const approval = new Promise<Extract<AgentEvent, { type: "approval" }>>((resolve) => {
      resolveApproval = resolve;
    });
    const off = runtime.onEvent((event) => { if (event.type === "approval") resolveApproval(event); });
    const store = library.threads;
    const original = store.applyPlanEvent;
    try {
      const started = await runtime.start({
        bookId,
        threadId,
        mode: "edit",
        prompt: "Start the reviewed plan.",
        plan: { id: PLAN_ID, revision: 1, action: "start" }
      });
      const request = await approval;
      store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
        if (event.type === "approval-settled") {
          throw new ThreadStoreError("io", "Synthetic approval-settled write failure");
        }
        return original.call(store, book, thread, plan, event);
      };
      const terminal = nextTerminal(runtime);
      let approvalError: Error | null = null;
      try {
        await runtime.approve(started.turnId, request.approvalId, true);
      } catch (caught) {
        approvalError = caught as Error;
      }
      expect(approvalError?.message).toContain("plan's approval could not be saved");
      expect((await terminal).type).toBe("stopped");
      expect(events.some((event) => event.type === "plan-error" && event.change === "approval-settled"))
        .toBe(true);
      expect((await library.readChapter(bookId, chapterId)).content).not.toContain("Replaced opening");
      expect((await planOf(threadId))?.status).toBe("waiting-for-approval");
    } finally {
      store.applyPlanEvent = original;
      off();
    }
  });
});

describe("plan failure paths", () => {
  test("a provider failure closes the observed step, fails the plan and ends with error", async () => {
    const threadId = await seedPlan(["Read the opening", "Rewrite the door"]);
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        if (calls === 1) return toolStream([step(1)]);
        if (calls === 2) return toolStream([stats()]);
        throw new Error("Synthetic provider failure");
      }
    });
    const { runtime, events } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);
    expect(terminal.type).toBe("error");
    expect(calls).toBe(3);
    const plan = await planOf(threadId);
    expect(states(plan!)).toEqual(["completed", "not-completed"]);
    expect(plan?.status).toBe("failed");
    const planEventIndexes = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "plan" && event.change === "fail");
    const terminalIndex = events.findIndex((event) => event.type === "error");
    expect(planEventIndexes).toHaveLength(1);
    expect(planEventIndexes[0]!.index).toBeLessThan(terminalIndex);
  });

  test("a step close write failure never emits completed and ends with plan-state", async () => {
    const threadId = await seedPlan(["Read the opening"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats()]),
      replyStream()
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
    try {
      const { terminal } = await startPlan(runtime, threadId);
      expect(terminal.type).toBe("error");
      if (terminal.type === "error") expect(terminal.code).toBe("plan-state");
      expect(events.some((event) => event.type === "plan" && event.change === "complete")).toBe(false);
      expect(events.some((event) => event.type === "plan-error" && event.change === "step")).toBe(true);
      expect((await planOf(threadId))?.status).toBe("failed");
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("a complete write failure fails the plan and never claims completed", async () => {
    const threadId = await seedPlan(["Read the opening"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats()]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "complete") {
        throw new ThreadStoreError("io", "Synthetic complete write failure");
      }
      return original.call(store, book, thread, plan, event);
    };
    try {
      const { terminal } = await startPlan(runtime, threadId);
      expect(terminal.type).toBe("error");
      if (terminal.type === "error") expect(terminal.code).toBe("plan-state");
      expect(events.some((event) => event.type === "plan" && event.change === "complete")).toBe(false);
      expect(events.some((event) => event.type === "plan-error" && event.change === "complete")).toBe(true);
      expect(events.some((event) => event.type === "plan" && event.change === "fail")).toBe(true);
      const plan = await planOf(threadId);
      expect(plan?.status).toBe("failed");
      expect(states(plan!)).toEqual(["completed"]);
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("the terminal plan notice precedes the terminal turn event", async () => {
    const threadId = await seedPlan(["Read the opening"]);
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([stats()]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const { terminal } = await startPlan(runtime, threadId);
    expect(terminal.type).toBe("done");
    const planIndex = events.findIndex((event) => event.type === "plan" && event.change === "complete");
    const doneIndex = events.findIndex((event) => event.type === "done");
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeLessThan(doneIndex);
  });
});
