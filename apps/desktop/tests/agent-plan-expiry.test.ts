import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  AgentTurnRefusedError,
  type AgentTurnRefusal,
  type AgentEvent,
  type AgentTurnInput
} from "@ai-book-studio/core/agent";
import {
  agentMessageSchema,
  type AgentMessage,
  type AgentPlan,
  type AgentPlanStatus,
  type AgentPlanStepState
} from "@ai-book-studio/core/agent/messages";
import type { AgentPlanEvent } from "@ai-book-studio/core/agent/plan-state";
import { ThreadStoreError } from "@ai-book-studio/core/agent/threads";
import type { AgentThreadRead } from "@ai-book-studio/core/ipc";
import type { ProviderService } from "../src/main/providers";
import type { Studio } from "../src/main/studio";
import { Library } from "../src/main/library/store";
import { AgentRuntime } from "../src/main/agent/runtime";

let root: string;
let library: Library;
let bookId: string;
let chapterId: string;
let callId: number;
const restores: Array<() => void> = [];

const PLAN_ID = "plan-expiry-1";
const PLAN_PARENT_ID = "msg_planexpiry01";
const PLAN_TURN_ID = "turn_planexpiry01";
const APPROVAL_ID = "approval-planexpiry";
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-plan-expiry-"));
  library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic plan expiry" });
  bookId = book.id;
  chapterId = (await library.createChapter(bookId, {
    title: "Light",
    content: "A synthetic lantern shone.\n"
  })).id;
  await library.updateBook(bookId, { defaultConnectionId: "conn_synthetic", defaultModelId: "synthetic-model" });
  callId = 0;
});
afterEach(async () => {
  while (restores.length > 0) restores.pop()!();
  await rm(root, { recursive: true, force: true });
});

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

function append(text: string) {
  return { name: "append_to_chapter", input: { chapterId, text } };
}

function overwrite(content: string) {
  return { name: "overwrite_chapter", input: { chapterId, content } };
}

function runtimeFor(model: MockLanguageModelV4) {
  const events: AgentEvent[] = [];
  let factoryCalls = 0;
  let credentialCalls = 0;
  let modelCalls = 0;
  const runtime = new AgentRuntime(
    { library, requireLibrary: () => library } as unknown as Studio,
    {
      credential: async () => {
        credentialCalls += 1;
        return { id: "conn_synthetic", provider: "openrouter", label: "Synthetic", kind: "api-key", secret: "synthetic-only" };
      },
      models: async () => {
        modelCalls += 1;
        return { models: [{ id: "synthetic-model", name: "Synthetic model", supportsTools: true, supportsImages: false, contextLength: 10000 }] };
      }
    } as unknown as ProviderService,
    (event) => events.push(event),
    () => {
      factoryCalls += 1;
      return model;
    },
    () => {}
  );
  return {
    runtime,
    events,
    model,
    factoryCalls: () => factoryCalls,
    credentialCalls: () => credentialCalls,
    modelCalls: () => modelCalls
  };
}

type Terminal = Extract<AgentEvent, { type: "done" | "error" | "stopped" }>;
type ApprovalEvent = Extract<AgentEvent, { type: "approval" }>;

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

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function planParent(withApproval = false, planTurnId = PLAN_TURN_ID): AgentMessage {
  return agentMessageSchema.parse({
    id: PLAN_PARENT_ID,
    role: "assistant",
    parts: [
      { type: "text", text: "Here is the plan." },
      ...(withApproval
        ? [{
            type: "approval",
            approvalId: APPROVAL_ID,
            turnId: planTurnId,
            name: "overwrite_chapter",
            input: { chapterId, content: "Replaced by an old approval.\n" },
            status: "pending",
            requestedAt: new Date().toISOString()
          }]
        : [])
    ],
    mode: "edit",
    turnId: planTurnId,
    createdAt: new Date().toISOString()
  });
}

async function seedPlan(options: {
  state?: AgentPlanStatus;
  steps?: string[];
  withApproval?: boolean;
  planId?: string;
  book?: string;
  threadTitle?: string;
} = {}): Promise<string> {
  const planId = options.planId ?? PLAN_ID;
  const thread = await library.threads.create(options.book ?? bookId, options.threadTitle ?? "Plan conversation");
  await library.threads.appendMessage(options.book ?? bookId, thread.id, planParent(options.withApproval === true));
  await library.threads.addPlan(options.book ?? bookId, thread.id, {
    id: planId,
    purpose: "Revise the lantern scene",
    steps: options.steps ?? ["Write the opening", "Write the close"],
    parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID }
  });
  const state = options.state ?? "proposed";
  const book = options.book ?? bookId;
  if (state === "proposed") return thread.id;
  if (state === "running") {
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "start", revision: 1 });
    return thread.id;
  }
  if (state === "waiting-for-approval") {
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "start", revision: 1 });
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "request-approval" });
    return thread.id;
  }
  if (state === "pause-requested") {
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "start", revision: 1 });
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "request-pause" });
    return thread.id;
  }
  if (state === "paused") {
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "start", revision: 1 });
    await library.threads.applyPlanEvent(book, thread.id, planId, {
      type: "step", revision: 1, index: 0, state: "completed"
    });
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "request-pause" });
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "confirm-pause" });
    return thread.id;
  }
  if (state === "completed") {
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "start", revision: 1 });
    await library.threads.applyPlanEvent(book, thread.id, planId, {
      type: "step", revision: 1, index: 0, state: "completed"
    });
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "complete" });
    return thread.id;
  }
  if (state === "cancelled") {
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "cancel" });
    return thread.id;
  }
  if (state === "failed") {
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "start", revision: 1 });
    await library.threads.applyPlanEvent(book, thread.id, planId, { type: "fail" });
    return thread.id;
  }
  await library.threads.applyPlanEvent(book, thread.id, planId, { type: "expire" });
  return thread.id;
}

async function planOf(threadId: string, planId = PLAN_ID, book = bookId): Promise<AgentPlan | null> {
  const thread = await library.threads.read(book, threadId);
  return thread?.plans.find((plan) => plan.id === planId) ?? null;
}

function states(plan: AgentPlan): AgentPlanStepState[] {
  return plan.steps.map((entry) => entry.state);
}

function threadPath(threadId: string, book = bookId): string {
  return join(root, "books", book, "threads", `${threadId}.json`);
}

async function bytesOf(threadId: string, book = bookId): Promise<string> {
  return readFile(threadPath(threadId, book), "utf8");
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

function countPlanEvents() {
  const counts = { total: 0, expire: 0, cancel: 0 };
  const original = library.threads.applyPlanEvent;
  library.threads.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
    counts.total += 1;
    if (event.type === "expire") counts.expire += 1;
    if (event.type === "cancel") counts.cancel += 1;
    return original.call(library.threads, book, thread, plan, event);
  };
  restores.push(() => { library.threads.applyPlanEvent = original; });
  return counts;
}

function planInputOf(read: AgentThreadRead, planId = PLAN_ID): AgentPlan | null {
  return read.thread?.plans.find((plan) => plan.id === planId) ?? null;
}

/**
 * Propose one plan through the runtime under test, so the same process owns it. A plan created
 * directly through the store belongs to no runtime and is stale by design.
 */
async function proposePlan(
  runtime: AgentRuntime,
  steps: string[],
  purpose = "Revise the lantern scene",
  threadId?: string
): Promise<{ threadId: string; planId: string; revision: number }> {
  const terminal = nextTerminal(runtime);
  const started = await runtime.start({
    bookId,
    ...(threadId ? { threadId } : {}),
    mode: "edit",
    prompt: "Propose a plan for the opening.",
    planProposal: true
  });
  const finished = await terminal;
  if (finished.type !== "done") throw new Error(`The synthetic proposal ended as ${finished.type}.`);
  const thread = await library.threads.read(bookId, started.threadId);
  const plan = thread?.plans.at(-1);
  if (!plan) throw new Error("The synthetic proposal stored no plan.");
  expect(plan.status).toBe("proposed");
  expect(plan.steps.map((entry) => entry.text)).toEqual(steps);
  expect(plan.purpose).toBe(purpose);
  return { threadId: started.threadId, planId: plan.id, revision: plan.revision };
}

function proposeTool(steps: string[], purpose = "Revise the lantern scene") {
  return { name: "propose_plan", input: { purpose, steps } };
}

describe("stored plan expiry on read", () => {
  test("a new runtime expires a running plan once, with no provider, stream or event", async () => {
    const threadId = await seedPlan({ state: "running" });
    const before = await planOf(threadId);
    const model = modelFor([]);
    const counts = countPlanEvents();
    const { runtime, events, factoryCalls, credentialCalls, modelCalls } = runtimeFor(model);

    const read = await runtime.readThread(bookId, threadId);

    expect(read.expiry).toEqual({ planId: PLAN_ID, outcome: "expired" });
    expect(read.planRuntime).toBeNull();
    const after = planInputOf(read);
    expect(after).toMatchObject({
      status: "expired",
      revision: before?.revision,
      startedAt: before?.startedAt
    });
    expect(after?.terminalAt).toBeTruthy();
    expect(after?.updatedAt).toBe(after?.terminalAt);
    expect(states(after!)).toEqual(["not-completed", "not-completed"]);
    expect(counts).toEqual({ total: 1, expire: 1, cancel: 0 });
    expect(events).toEqual([]);
    expect(factoryCalls()).toBe(0);
    expect(credentialCalls()).toBe(0);
    expect(modelCalls()).toBe(0);
    expect(model.doStreamCalls).toHaveLength(0);

    const second = await runtime.readThread(bookId, threadId);
    expect(second.expiry).toBeUndefined();
    expect(counts.expire).toBe(1);
  });

  test("a waiting plan expires and leaves its pending approval part untouched", async () => {
    const threadId = await seedPlan({ state: "waiting-for-approval", withApproval: true });
    const counts = countPlanEvents();
    const model = modelFor([]);
    const { runtime, events, factoryCalls } = runtimeFor(model);

    const read = await runtime.readThread(bookId, threadId);

    expect(read.expiry).toEqual({ planId: PLAN_ID, outcome: "expired" });
    expect(planInputOf(read)?.status).toBe("expired");
    const approval = read.thread?.messages.flatMap((message) => message.parts)
      .find((part) => part.type === "approval" && part.approvalId === APPROVAL_ID);
    expect(approval).toMatchObject({ type: "approval", status: "pending" });
    expect(events.filter((event) => event.type === "approval")).toEqual([]);
    expect(counts.expire).toBe(1);
    expect(factoryCalls()).toBe(0);
  });

  test("a pause-requested plan expires", async () => {
    const threadId = await seedPlan({ state: "pause-requested" });
    const { runtime } = runtimeFor(modelFor([]));
    const read = await runtime.readThread(bookId, threadId);
    expect(read.expiry).toEqual({ planId: PLAN_ID, outcome: "expired" });
    expect(planInputOf(read)?.status).toBe("expired");
  });

  test("a paused plan expires and keeps its completed step", async () => {
    const threadId = await seedPlan({ state: "paused" });
    const before = await planOf(threadId);
    expect(before?.status).toBe("paused");
    expect(states(before!)).toEqual(["completed", "pending"]);
    const counts = countPlanEvents();
    const { runtime } = runtimeFor(modelFor([]));

    const read = await runtime.readThread(bookId, threadId);

    expect(read.expiry).toEqual({ planId: PLAN_ID, outcome: "expired" });
    expect(planInputOf(read)).toMatchObject({ status: "expired", revision: before?.revision });
    expect(states(planInputOf(read)!)).toEqual(["completed", "not-completed"]);
    expect(counts.expire).toBe(1);
  });

  test("a stale proposed plan expires and frees the one-unfinished-plan slot", async () => {
    const threadId = await seedPlan({ state: "proposed" });
    const { runtime } = runtimeFor(modelFor([]));

    const read = await runtime.readThread(bookId, threadId);
    expect(read.expiry).toEqual({ planId: PLAN_ID, outcome: "expired" });
    expect(planInputOf(read)?.status).toBe("expired");

    const thread = await library.threads.addPlan(bookId, threadId, {
      id: "plan-expiry-2",
      purpose: "A new proposal",
      steps: ["Write the new opening"],
      parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID }
    });
    expect(thread.plans.map((plan) => plan.status)).toEqual(["expired", "proposed"]);
  });

  test("a plan proposed by this process stays proposed with no write", async () => {
    const thread = await library.threads.create(bookId, "A proposal conversation");
    const model = modelFor([
      toolStream([{ name: "propose_plan", input: { purpose: "Revise the opening", steps: ["Read the opening"] } }]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const started = await runtime.start({
      bookId,
      threadId: thread.id,
      mode: "edit",
      prompt: "Propose a plan for the opening.",
      planProposal: true
    });
    expect((await terminal).type).toBe("done");
    expect(events.some((event) => event.type === "plan" && event.change === "proposed")).toBe(true);

    const counts = countPlanEvents();
    const read = await runtime.readThread(bookId, thread.id);
    const plan = read.thread?.plans.at(-1);
    expect(plan?.status).toBe("proposed");
    expect(plan?.parent.turnId).toBe(started.turnId);
    expect(read.expiry).toBeUndefined();
    expect(read.planRuntime).toBeNull();
    expect(counts.expire).toBe(0);
  });

  test("a plan started and paused by this process stays paused with no write", async () => {
    const steps = ["Read the opening", "Write the close"];
    const model = modelFor([
      toolStream([proposeTool(steps)]),
      replyStream(),
      toolStream([step(1)]),
      toolStream([append("First passage.")]),
      replyStream()
    ]);
    const { runtime } = runtimeFor(model);
    const proposed = await proposePlan(runtime, steps);

    const held = gate();
    const entered = gate();
    const originalSave = library.saveChapter.bind(library);
    library.saveChapter = (async (...args: Parameters<typeof originalSave>) => {
      entered.release();
      await held.promise;
      return originalSave(...args);
    }) as typeof library.saveChapter;
    restores.push(() => { library.saveChapter = originalSave; });

    const terminal = nextTerminal(runtime);
    const started = await runtime.start(startInput(proposed.threadId, {
      plan: { id: proposed.planId, revision: proposed.revision, action: "start" }
    }));
    await entered.promise;
    await runtime.stop(started.turnId);
    held.release();
    const stopped = await terminal;
    expect(stopped.type).toBe("stopped");
    expect((await planOf(proposed.threadId, proposed.planId))?.status).toBe("paused");

    const counts = countPlanEvents();
    const read = await runtime.readThread(bookId, proposed.threadId);
    expect(planInputOf(read, proposed.planId)?.status).toBe("paused");
    expect(read.expiry).toBeUndefined();
    expect(read.planRuntime).toBeNull();
    expect(counts.expire).toBe(0);
  });
});

describe("live plan turns are never expired", () => {
  test("a long-idle live turn is reported for reattach and left running", async () => {
    const steps = ["Write the opening"];
    const model = modelFor([
      toolStream([proposeTool(steps)]),
      replyStream(),
      toolStream([step(1)]),
      toolStream([append("Held passage.")]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const proposed = await proposePlan(runtime, steps);
    const held = gate();
    const entered = gate();
    const originalSave = library.saveChapter.bind(library);
    library.saveChapter = (async (...args: Parameters<typeof originalSave>) => {
      entered.release();
      await held.promise;
      return originalSave(...args);
    }) as typeof library.saveChapter;
    restores.push(() => { library.saveChapter = originalSave; });

    const terminal = nextTerminal(runtime);
    const started = await runtime.start(startInput(proposed.threadId, {
      plan: { id: proposed.planId, revision: proposed.revision, action: "start" }
    }));
    await entered.promise;
    const factoryBefore = model.doStreamCalls.length;

    const first = await runtime.readThread(bookId, proposed.threadId);
    await new Promise((pause) => setTimeout(pause, 25));
    const second = await runtime.readThread(bookId, proposed.threadId);

    for (const read of [first, second]) {
      expect(read.expiry).toBeUndefined();
      expect(read.planRuntime).toEqual({
        planId: proposed.planId,
        turnId: started.turnId,
        phase: "active"
      });
      expect(planInputOf(read, proposed.planId)?.status).toBe("running");
    }
    expect(model.doStreamCalls).toHaveLength(factoryBefore);
    expect(events.some((event) => event.type === "plan" && event.change === "complete")).toBe(false);

    held.release();
    expect((await terminal).type).toBe("done");
    expect((await planOf(proposed.threadId, proposed.planId))?.status).toBe("completed");
  });

  test("a live approval wait is reported for reattach and left waiting", async () => {
    const steps = ["Replace the opening"];
    const model = modelFor([
      toolStream([proposeTool(steps)]),
      replyStream(),
      toolStream([step(1)]),
      toolStream([overwrite("Replaced opening.\n")]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const proposed = await proposePlan(runtime, steps);
    const terminal = nextTerminal(runtime);
    const started = await runtime.start(startInput(proposed.threadId, {
      plan: { id: proposed.planId, revision: proposed.revision, action: "start" }
    }));
    const approval = await waitFor(events, (event): event is ApprovalEvent =>
      event.type === "approval" && event.turnId === started.turnId, "the approval request");
    expect((await planOf(proposed.threadId, proposed.planId))?.status).toBe("waiting-for-approval");
    const approvalEvents = events.filter((event) => event.type === "approval").length;

    const read = await runtime.readThread(bookId, proposed.threadId);
    expect(read.expiry).toBeUndefined();
    expect(read.planRuntime).toEqual({
      planId: proposed.planId,
      turnId: started.turnId,
      phase: "active"
    });
    expect(planInputOf(read, proposed.planId)?.status).toBe("waiting-for-approval");
    expect(events.filter((event) => event.type === "approval")).toHaveLength(approvalEvents);

    await runtime.approve(started.turnId, approval.approvalId, true);
    expect((await terminal).type).toBe("done");
    expect((await planOf(proposed.threadId, proposed.planId))?.status).toBe("completed");
    expect((await library.readChapter(bookId, chapterId)).content).toBe("Replaced opening.\n");
  });
});

describe("terminal plans and partial work", () => {
  test("completed, cancelled, failed and expired plans keep their exact bytes", async () => {
    const threadIds: Record<string, string> = {
      completed: await seedPlan({ state: "completed", planId: "plan-expiry-completed", threadTitle: "Completed" }),
      cancelled: await seedPlan({ state: "cancelled", planId: "plan-expiry-cancelled", threadTitle: "Cancelled" }),
      failed: await seedPlan({ state: "failed", planId: "plan-expiry-failed", threadTitle: "Failed" }),
      expired: await seedPlan({ state: "expired", planId: "plan-expiry-expired", threadTitle: "Expired" })
    };
    const hashes = new Map<string, string>();
    for (const threadId of Object.values(threadIds)) {
      hashes.set(threadId, (await library.threads.readSnapshot(bookId, threadId))!.baseHash);
    }
    const counts = countPlanEvents();
    const { runtime, events, factoryCalls } = runtimeFor(modelFor([]));

    for (const [status, threadId] of Object.entries(threadIds)) {
      const read = await runtime.readThread(bookId, threadId);
      expect(read.expiry).toBeUndefined();
      const plan = read.thread?.plans[0];
      expect(plan?.status).toBe(status as AgentPlanStatus);
      expect((await library.threads.readSnapshot(bookId, threadId))?.baseHash).toBe(hashes.get(threadId)!);
    }
    expect(counts.total).toBe(0);
    expect(events).toEqual([]);
    expect(factoryCalls()).toBe(0);
  });

  test("a restart keeps completed steps, checkpoint turns and the existing Undo", async () => {
    const steps = ["Read the opening", "Write the close"];
    const model = modelFor([
      toolStream([proposeTool(steps)]),
      replyStream(),
      toolStream([step(1)]),
      toolStream([append("First passage.")]),
      toolStream([step(2)]),
      toolStream([append("Second passage.")]),
      replyStream()
    ]);
    const first = runtimeFor(model);
    const proposed = await proposePlan(first.runtime, steps);
    const original = (await library.readChapter(bookId, chapterId)).content;
    let saves = 0;
    const held = gate();
    const entered = gate();
    const originalSave = library.saveChapter.bind(library);
    library.saveChapter = (async (...args: Parameters<typeof originalSave>) => {
      saves += 1;
      if (saves === 2) {
        entered.release();
        await held.promise;
      }
      return originalSave(...args);
    }) as typeof library.saveChapter;
    restores.push(() => { library.saveChapter = originalSave; });

    const terminal = nextTerminal(first.runtime);
    const started = await first.runtime.start(startInput(proposed.threadId, {
      plan: { id: proposed.planId, revision: proposed.revision, action: "start" }
    }));
    await entered.promise;
    await first.runtime.stop(started.turnId);
    held.release();
    expect((await terminal).type).toBe("stopped");
    const paused = await planOf(proposed.threadId, proposed.planId);
    expect(paused?.status).toBe("paused");
    expect(states(paused!)).toEqual(["completed", "in-progress"]);
    const threadBefore = await library.threads.read(bookId, proposed.threadId);
    expect(threadBefore?.checkpointTurns).toEqual([started.turnId]);
    const chapterBefore = (await library.readChapter(bookId, chapterId)).content;
    expect(chapterBefore).not.toBe(original);

    const counts = countPlanEvents();
    const second = runtimeFor(modelFor([]));
    const read = await second.runtime.readThread(bookId, proposed.threadId);
    expect(read.expiry).toEqual({ planId: proposed.planId, outcome: "expired" });
    expect(states(planInputOf(read, proposed.planId)!)).toEqual(["completed", "not-completed"]);
    expect((await library.readChapter(bookId, chapterId)).content).toBe(chapterBefore);
    expect((await library.threads.read(bookId, proposed.threadId))?.checkpointTurns).toEqual([started.turnId]);
    expect(counts.expire).toBe(1);

    const undo = await second.runtime.undoLast(bookId, started.turnId);
    expect(undo.restored).toBe(1);
    expect((await library.readChapter(bookId, chapterId)).content).toBe(original);
    expect((await planOf(proposed.threadId, proposed.planId))?.status).toBe("expired");
    expect((await library.threads.read(bookId, proposed.threadId))?.checkpointTurns).toEqual([]);
  });
});

describe("expiry failures and races", () => {
  test("a failed expire is reported once, never retried, and refuses a start before the provider", async () => {
    const threadId = await seedPlan({ state: "paused" });
    const before = await planOf(threadId);
    const messagesBefore = (await library.threads.read(bookId, threadId))?.messages.length ?? 0;
    let attempts = 0;
    const original = library.threads.applyPlanEvent;
    library.threads.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "expire") {
        attempts += 1;
        throw new ThreadStoreError("io", "The conversation could not be written.");
      }
      return original.call(library.threads, book, thread, plan, event);
    };
    restores.push(() => { library.threads.applyPlanEvent = original; });
    const model = modelFor([]);
    const { runtime, events, factoryCalls, credentialCalls, modelCalls } = runtimeFor(model);

    const first = await runtime.readThread(bookId, threadId);
    expect(first.expiry).toEqual({
      planId: PLAN_ID,
      outcome: "failed",
      message: "The conversation could not be written."
    });
    expect(first.thread?.plans.find((plan) => plan.id === PLAN_ID)?.status).toBe("paused");
    const second = await runtime.readThread(bookId, threadId);
    expect(second.expiry).toEqual(first.expiry);
    expect(attempts).toBe(1);
    expect(await planOf(threadId)).toMatchObject({ status: before?.status, revision: before?.revision });

    const refused = await runtime.start(resumeInput(threadId)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AgentTurnRefusedError);
    expect((refused as AgentTurnRefusedError).refusal).toBe("plan-state");
    expect((refused as AgentTurnRefusedError).message).toContain("Restart the app before continuing");
    expect(attempts).toBe(1);
    expect(factoryCalls()).toBe(0);
    expect(credentialCalls()).toBe(0);
    expect(modelCalls()).toBe(0);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(events).toEqual([]);
    expect(await planOf(threadId)).toMatchObject({ status: before?.status });
    expect((await library.threads.read(bookId, threadId))?.messages.length).toBe(messagesBefore);
  });

  test("two concurrent reads share one expire write", async () => {
    const threadId = await seedPlan({ state: "paused" });
    const entered = gate();
    const held = gate();
    let attempts = 0;
    const original = library.threads.applyPlanEvent;
    library.threads.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "expire") {
        attempts += 1;
        entered.release();
        await held.promise;
      }
      return original.call(library.threads, book, thread, plan, event);
    };
    restores.push(() => { library.threads.applyPlanEvent = original; });
    const { runtime } = runtimeFor(modelFor([]));

    const firstRead = runtime.readThread(bookId, threadId);
    await entered.promise;
    const secondRead = runtime.readThread(bookId, threadId);
    held.release();
    const [first, second] = await Promise.all([firstRead, secondRead]);

    expect(attempts).toBe(1);
    expect(first.expiry).toEqual({ planId: PLAN_ID, outcome: "expired" });
    expect(second.expiry).toEqual({ planId: PLAN_ID, outcome: "expired" });
    expect(planInputOf(second)?.status).toBe("expired");
  });

  test("direct cancel after the read expiry returns the stored terminal plan", async () => {
    const threadId = await seedPlan({ state: "paused" });
    const counts = countPlanEvents();
    const { runtime } = runtimeFor(modelFor([]));

    const read = await runtime.readThread(bookId, threadId);
    expect(read.expiry).toEqual({ planId: PLAN_ID, outcome: "expired" });
    const result = await runtime.cancelPlan(bookId, threadId, PLAN_ID);
    expect(result).toMatchObject({ outcome: "terminal", plan: { id: PLAN_ID, status: "expired" } });
    expect(counts).toEqual({ total: 1, expire: 1, cancel: 0 });
    expect((await planOf(threadId))?.status).toBe("expired");
  });

  test("direct cancel before any read writes one cancel and the read adds nothing", async () => {
    const threadId = await seedPlan({ state: "paused" });
    const counts = countPlanEvents();
    const { runtime } = runtimeFor(modelFor([]));

    const result = await runtime.cancelPlan(bookId, threadId, PLAN_ID);
    expect(result).toMatchObject({ outcome: "cancelled", plan: { id: PLAN_ID, status: "cancelled" } });
    const read = await runtime.readThread(bookId, threadId);
    expect(read.expiry).toBeUndefined();
    expect(read.thread?.plans.find((plan) => plan.id === PLAN_ID)?.status).toBe("cancelled");
    expect(counts).toEqual({ total: 1, expire: 0, cancel: 1 });
  });

  test("a cancel racing an expire returns the terminal plan instead of throwing", async () => {
    const threadId = await seedPlan({ state: "paused" });
    const expireEntered = gate();
    const releaseExpire = gate();
    let expireApplied!: () => void;
    const applied = new Promise<void>((resolve) => { expireApplied = resolve; });
    const counts = { expire: 0, cancel: 0 };
    const original = library.threads.applyPlanEvent;
    library.threads.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "expire") {
        counts.expire += 1;
        expireEntered.release();
        await releaseExpire.promise;
        const result = await original.call(library.threads, book, thread, plan, event);
        expireApplied();
        return result;
      }
      if (event.type === "cancel") {
        counts.cancel += 1;
        releaseExpire.release();
        await applied;
      }
      return original.call(library.threads, book, thread, plan, event);
    };
    restores.push(() => { library.threads.applyPlanEvent = original; });
    const { runtime } = runtimeFor(modelFor([]));

    const reading = runtime.readThread(bookId, threadId);
    await expireEntered.promise;
    const canceling = runtime.cancelPlan(bookId, threadId, PLAN_ID);
    releaseExpire.release();
    const [read, result] = await Promise.all([reading, canceling]);

    expect(read.expiry).toEqual({ planId: PLAN_ID, outcome: "expired" });
    expect(result).toMatchObject({ outcome: "terminal", plan: { id: PLAN_ID, status: "expired" } });
    expect(counts).toEqual({ expire: 1, cancel: 1 });
    expect((await planOf(threadId))?.status).toBe("expired");
  });
});

describe("thread and book scope", () => {
  test("reading one thread never expires another thread or another book", async () => {
    const first = await seedPlan({ state: "paused", threadTitle: "First thread" });
    const second = await seedPlan({ state: "paused", threadTitle: "Second thread" });
    const otherBook = await library.createBook({ title: "Other synthetic book" });
    const other = await seedPlan({
      state: "paused",
      book: otherBook.id,
      threadTitle: "Other book thread"
    });
    const secondHash = (await library.threads.readSnapshot(bookId, second))!.baseHash;
    const otherHash = (await library.threads.readSnapshot(otherBook.id, other))!.baseHash;
    const counts = countPlanEvents();
    const { runtime } = runtimeFor(modelFor([]));

    const read = await runtime.readThread(bookId, first);

    expect(read.expiry).toEqual({ planId: PLAN_ID, outcome: "expired" });
    expect((await planOf(first))?.status).toBe("expired");
    expect((await planOf(second))?.status).toBe("paused");
    expect((await library.threads.readSnapshot(bookId, second))?.baseHash).toBe(secondHash);
    expect((await planOf(other, PLAN_ID, otherBook.id))?.status).toBe("paused");
    expect((await library.threads.readSnapshot(otherBook.id, other))?.baseHash).toBe(otherHash);
    expect(counts.expire).toBe(1);
  });
});

describe("start preflight expiry", () => {
  for (const scenario of [
    { state: "paused" as const, action: "resume" as const, refusal: "plan-not-resumable" },
    { state: "proposed" as const, action: "start" as const, refusal: "plan-not-startable" }
  ]) {
    test(`a stale ${scenario.state} plan is expired and the ${scenario.action} refuses before the provider`, async () => {
      const threadId = await seedPlan({ state: scenario.state });
      const model = modelFor([]);
      const { runtime, events, factoryCalls, credentialCalls, modelCalls } = runtimeFor(model);
      const input = scenario.action === "resume" ? resumeInput(threadId) : startInput(threadId);

      const refused = await runtime.start(input).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(AgentTurnRefusedError);
      expect((refused as AgentTurnRefusedError).refusal).toBe(scenario.refusal as AgentTurnRefusal);
      expect((await planOf(threadId))?.status).toBe("expired");
      expect(factoryCalls()).toBe(0);
      expect(credentialCalls()).toBe(0);
      expect(modelCalls()).toBe(0);
      expect(model.doStreamCalls).toHaveLength(0);
      expect(events).toEqual([]);
      const thread = await library.threads.read(bookId, threadId);
      expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(0);
    });
  }

  test("a corrupt thread read rejects, writes nothing and refuses the start", async () => {
    const threadId = await seedPlan({ state: "paused" });
    const counts = countPlanEvents();
    const corrupt = "{ this is not a conversation";
    await writeFile(threadPath(threadId), corrupt, "utf8");
    const model = modelFor([]);
    const { runtime, factoryCalls, credentialCalls, modelCalls } = runtimeFor(model);

    await expect(runtime.readThread(bookId, threadId)).rejects.toBeInstanceOf(ThreadStoreError);
    const refused = await runtime.start(resumeInput(threadId)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AgentTurnRefusedError);
    expect((refused as AgentTurnRefusedError).refusal).toBe("plan-invalid");
    expect(await bytesOf(threadId)).toBe(corrupt);
    expect(counts.total).toBe(0);
    expect(factoryCalls()).toBe(0);
    expect(credentialCalls()).toBe(0);
    expect(modelCalls()).toBe(0);
    expect(model.doStreamCalls).toHaveLength(0);
  });
});
