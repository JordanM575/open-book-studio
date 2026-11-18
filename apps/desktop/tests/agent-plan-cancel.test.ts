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
import type { ProviderService } from "../src/main/providers";
import type { Studio } from "../src/main/studio";
import { Library } from "../src/main/library/store";
import { AgentRuntime } from "../src/main/agent/runtime";

let root: string;
let library: Library;
let bookId: string;
let chapterId: string;
let callId: number;

const PLAN_ID = "plan-cancel-1";
const PLAN_PARENT_ID = "msg_plancancel01";
const PLAN_TURN_ID = "turn_plancancel01";
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-plan-cancel-"));
  library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic plan cancel" });
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

function append(text: string) {
  return { name: "append_to_chapter", input: { chapterId, text } };
}

function runtimeFor(model: MockLanguageModelV4) {
  const events: AgentEvent[] = [];
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
    () => model,
    () => {}
  );
  return { runtime, events };
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

async function seedPlan(options: {
  steps?: string[];
  state?: "proposed" | "running" | "waiting-for-approval" | "paused" | "paused-in-progress";
} = {}): Promise<string> {
  const thread = await library.threads.create(bookId, "Plan conversation");
  await library.threads.appendMessage(bookId, thread.id, planParent());
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
  if (state === "waiting-for-approval") {
    await library.threads.applyPlanEvent(bookId, thread.id, PLAN_ID, { type: "request-approval" });
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

function cancelSequence(events: AgentEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "stopping") return ["stopping"];
    if (event.type === "stopped") return ["stopped"];
    if (event.type === "plan" && event.change === "cancel") return ["plan:cancel"];
    if (event.type === "plan" && event.change === "request-pause") return ["plan:request-pause"];
    if (event.type === "plan" && event.change === "confirm-pause") return ["plan:confirm-pause"];
    if (event.type === "plan-error" && event.change === "cancel") return ["plan-error:cancel"];
    return [];
  });
}

function indexOfSequence(events: AgentEvent[], type: string): number {
  return events.findIndex((event) => {
    if (event.type === type) return true;
    if (event.type === "plan" && type === "plan:cancel") return event.change === "cancel";
    if (event.type === "plan" && type === "plan:request-pause") return event.change === "request-pause";
    if (event.type === "plan" && type === "plan:confirm-pause") return event.change === "confirm-pause";
    if (event.type === "plan-error" && type === "plan-error:cancel") return event.change === "cancel";
    return false;
  });
}

function cancelWriteSpy(store: ThreadStoreLike) {
  const count = { cancel: 0, total: 0 };
  const original = store.applyPlanEvent;
  store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
    count.total += 1;
    if (event.type === "cancel") count.cancel += 1;
    return original.call(store, book, thread, plan, event);
  };
  return { count, restore: () => { store.applyPlanEvent = original; } };
}

type ThreadStoreLike = Library["threads"];

describe("plan cancel", () => {
  test("cancel before any book write closes dispatch, writes once and reports no changes", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening", "Write the close"] });
    const save = spyOn(library, "saveChapter");
    const model = modelFor([toolStream([step(1)]), replyStream()]);
    const { runtime, events } = runtimeFor(model);
    const writes = cancelWriteSpy(library.threads);
    try {
      const terminal = nextTerminal(runtime);
      await runtime.start(startInput(threadId));
      await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan-step" }> =>
        event.type === "plan-step" && event.state === "in-progress", "the first step boundary");

      const result = await runtime.cancelPlan(bookId, threadId, PLAN_ID);
      expect(result).toMatchObject({ outcome: "live" });
      const stopped = await terminal;
      expect(stopped.type).toBe("stopped");
      if (stopped.type === "stopped") expect(stopped.changed).toBe(0);

      expect(cancelSequence(events)).toEqual(["stopping", "plan:cancel", "stopped"]);
      expect(writes.count.cancel).toBe(1);
      const stoppingIndex = indexOfSequence(events, "stopping");
      expect(events.slice(stoppingIndex + 1).some((event) => event.type === "tool" && event.status === "start"))
        .toBe(false);
      expect(save).not.toHaveBeenCalled();
      const plan = await planOf(threadId);
      expect(plan?.status).toBe("cancelled");
      expect(states(plan!)).toEqual(["not-completed", "not-completed"]);
      expect((await library.readChapter(bookId, chapterId)).content).toBe("A synthetic lantern shone.\n");
    } finally {
      writes.restore();
    }
  });

  test("cancel at a tool start prevents the tool from executing", async () => {
    const threadId = await seedPlan({ steps: ["Write the opening"] });
    const save = spyOn(library, "saveChapter");
    const model = modelFor([toolStream([step(1)]), toolStream([append("Too late.")])]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const cancelOnAppend = runtime.onEvent((event) => {
      if (event.type === "tool" && event.name === "append_to_chapter" && event.status === "start") {
        void runtime.cancelPlan(bookId, threadId, PLAN_ID);
      }
    });
    await runtime.start(startInput(threadId));
    const stopped = await terminal;
    cancelOnAppend();

    expect(stopped.type).toBe("stopped");
    if (stopped.type === "stopped") expect(stopped.changed).toBe(0);
    expect(save).not.toHaveBeenCalled();
    const plan = await planOf(threadId);
    expect(plan?.status).toBe("cancelled");
    expect(states(plan!)).toEqual(["not-completed"]);
    const stoppingIndex = indexOfSequence(events, "stopping");
    expect(events.slice(stoppingIndex + 1).some((event) => event.type === "plan-step")).toBe(false);
    expect(cancelSequence(events)).toEqual(["stopping", "plan:cancel", "stopped"]);
  });

  test("cancel between steps keeps the completed step and stops the next tool", async () => {
    const threadId = await seedPlan({ steps: ["Write the opening", "Write the close"] });
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([append("First passage.")]),
      toolStream([step(2)]),
      toolStream([append("Second passage.")]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const cancelOnStepOne = runtime.onEvent((event) => {
      if (event.type === "plan-step" && event.index === 0 && event.state === "completed") {
        void runtime.cancelPlan(bookId, threadId, PLAN_ID);
      }
    });
    await runtime.start(startInput(threadId));
    const stopped = await terminal;
    cancelOnStepOne();

    expect(stopped.type).toBe("stopped");
    if (stopped.type === "stopped") {
      expect(stopped.changed).toBe(1);
      expect(stopped.undoAvailable).toBe(true);
    }
    const chapter = await library.readChapter(bookId, chapterId);
    expect(chapter.content).toContain("First passage.");
    expect(chapter.content).not.toContain("Second passage.");
    const plan = await planOf(threadId);
    expect(plan?.status).toBe("cancelled");
    expect(states(plan!)).toEqual(["completed", "not-completed"]);
    expect(cancelSequence(events)).toEqual(["stopping", "plan:cancel", "stopped"]);
    const stoppingIndex = indexOfSequence(events, "stopping");
    expect(events.slice(stoppingIndex + 1).some((event) =>
      event.type === "tool" && event.name === "append_to_chapter" && event.status === "start")).toBe(false);
  });

  test("cancel with a checked write in flight settles it, keeps the change and closes no step", async () => {
    const threadId = await seedPlan({ steps: ["Write the opening", "Write the close"] });
    const entered = gate();
    const held = gate();
    const save = library.saveChapter.bind(library);
    let saves = 0;
    library.saveChapter = async (...args) => {
      saves += 1;
      entered.release();
      await held.promise;
      return save(...args);
    };
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([append("First passage.")]),
      toolStream([step(2)]),
      toolStream([append("Second passage.")]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    await runtime.start(startInput(threadId));
    await entered.promise;
    await runtime.cancelPlan(bookId, threadId, PLAN_ID);
    await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan" }> =>
      event.type === "plan" && event.change === "cancel", "the cancel notice");
    expect(events.some((event) => event.type === "stopped")).toBe(false);
    expect((await planOf(threadId))?.status).toBe("cancelled");

    held.release();
    const stopped = await terminal;
    expect(stopped.type).toBe("stopped");
    if (stopped.type === "stopped") {
      expect(stopped.changed).toBe(1);
      expect(stopped.undoAvailable).toBe(true);
    }
    expect(saves).toBe(1);
    const chapter = await library.readChapter(bookId, chapterId);
    expect(chapter.content).toContain("First passage.");
    expect(chapter.content).not.toContain("Second passage.");
    const plan = await planOf(threadId);
    expect(plan?.status).toBe("cancelled");
    expect(states(plan!)).toEqual(["not-completed", "not-completed"]);
    const thread = await library.threads.read(bookId, threadId);
    const receipts = thread?.messages.at(-1)?.parts.filter((part) =>
      part.type === "tool-result" && part.name === "append_to_chapter");
    expect(receipts).toHaveLength(1);
    expect(receipts?.[0]).toMatchObject({ output: expect.objectContaining({ ok: true }) });
    expect(cancelSequence(events)).toEqual(["stopping", "plan:cancel", "stopped"]);
  });

  test("cancel while an approval is pending expires it without running the action", async () => {
    const threadId = await seedPlan({ steps: ["Replace the opening"] });
    const save = spyOn(library, "saveChapter");
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

    await runtime.cancelPlan(bookId, threadId, PLAN_ID);
    const stopped = await terminal;
    expect(stopped.type).toBe("stopped");
    if (stopped.type === "stopped") expect(stopped.changed).toBe(0);
    await expect(runtime.approve(started.turnId, approval.approvalId, true)).rejects.toThrow(/no longer waiting/);
    expect(save).not.toHaveBeenCalled();
    expect((await library.readChapter(bookId, chapterId)).content).toBe("A synthetic lantern shone.\n");
    const plan = await planOf(threadId);
    expect(plan?.status).toBe("cancelled");
    expect(states(plan!)).toEqual(["not-completed"]);
    const thread = await library.threads.read(bookId, threadId);
    expect(thread?.messages.flatMap((message) => message.parts)
      .find((part) => part.type === "approval" && part.approvalId === approval.approvalId))
      .toMatchObject({ type: "approval", status: "expired" });
    const stoppingIndex = indexOfSequence(events, "stopping");
    expect(events.slice(stoppingIndex + 1).some((event) => event.type === "approval")).toBe(false);
    expect(cancelSequence(events)).toEqual(["stopping", "plan:cancel", "stopped"]);
  });

  test("an approval answer that loses to cancel never runs the action", async () => {
    const threadId = await seedPlan({ steps: ["Replace the opening"] });
    const save = spyOn(library, "saveChapter");
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([{ name: "overwrite_chapter", input: { chapterId, content: "Replaced opening.\n" } }])
    ]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const started = await runtime.start(startInput(threadId));
    const approval = await waitFor(events, (event): event is ApprovalEvent =>
      event.type === "approval" && event.turnId === started.turnId, "the approval request");

    const entered = gate();
    const held = gate();
    const update = library.threads.updateApproval.bind(library.threads);
    library.threads.updateApproval = async (...args) => {
      entered.release();
      await held.promise;
      return update(...args);
    };
    const answering = runtime.approve(started.turnId, approval.approvalId, true);
    await entered.promise;
    await runtime.cancelPlan(bookId, threadId, PLAN_ID);
    held.release();
    await expect(answering).rejects.toThrow(/finished|approval could not be saved/);

    const stopped = await terminal;
    expect(stopped.type).toBe("stopped");
    expect(save).not.toHaveBeenCalled();
    expect((await library.readChapter(bookId, chapterId)).content).toBe("A synthetic lantern shone.\n");
    const plan = await planOf(threadId);
    expect(plan?.status).toBe("cancelled");
    const thread = await library.threads.read(bookId, threadId);
    expect(thread?.messages.flatMap((message) => message.parts)
      .find((part) => part.type === "approval" && part.approvalId === approval.approvalId))
      .toMatchObject({ type: "approval", status: "approved" });
    expect(events.filter((event) => event.type === "stopped")).toHaveLength(1);
  });

  test("a failed cancel write reports once, keeps the last plan state and still stops", async () => {
    const threadId = await seedPlan({ steps: ["Write the opening", "Write the close"] });
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([append("First passage.")]),
      toolStream([step(2)]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    let cancelCalls = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "cancel") {
        cancelCalls += 1;
        throw new ThreadStoreError("io", "Synthetic cancel write failure");
      }
      return original.call(store, book, thread, plan, event);
    };
    try {
      const terminal = nextTerminal(runtime);
      await runtime.start(startInput(threadId));
      await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan-step" }> =>
        event.type === "plan-step" && event.index === 0 && event.state === "completed", "the completed step");
      await runtime.cancelPlan(bookId, threadId, PLAN_ID);
      const stopped = await terminal;
      expect(stopped.type).toBe("stopped");
      if (stopped.type === "stopped") {
        expect(stopped.changed).toBe(1);
        expect(stopped.persistenceError).toContain(
          "The plan's cancellation could not be saved. The plan remains at its last confirmed state."
        );
      }
      expect(cancelCalls).toBe(1);
      expect(cancelSequence(events)).toEqual(["stopping", "plan-error:cancel", "stopped"]);
      const plan = await planOf(threadId);
      expect(plan?.status).toBe("running");
      expect(states(plan!)).toEqual(["completed", "in-progress"]);
      expect((await library.readChapter(bookId, chapterId)).content).toContain("First passage.");
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("duplicate live cancel writes once and publishes one terminal", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening"] });
    const model = modelFor([toolStream([step(1)]), replyStream()]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    const entered = gate();
    const held = gate();
    let cancelCalls = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "cancel") {
        cancelCalls += 1;
        entered.release();
        await held.promise;
      }
      return original.call(store, book, thread, plan, event);
    };
    try {
      const terminal = nextTerminal(runtime);
      await runtime.start(startInput(threadId));
      await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan-step" }> =>
        event.type === "plan-step" && event.state === "in-progress", "the first step boundary");

      const first = await runtime.cancelPlan(bookId, threadId, PLAN_ID);
      const second = await runtime.cancelPlan(bookId, threadId, PLAN_ID);
      expect(first).toMatchObject({ outcome: "live" });
      expect(second).toMatchObject({ outcome: "live" });
      await entered.promise;
      expect(cancelCalls).toBe(1);
      held.release();
      const stopped = await terminal;
      expect(stopped.type).toBe("stopped");
      expect(events.filter((event) => event.type === "stopping")).toHaveLength(1);
      expect(events.filter((event) => event.type === "plan" && event.change === "cancel")).toHaveLength(1);
      expect(events.filter((event) => event.type === "stopped")).toHaveLength(1);
      expect(cancelCalls).toBe(1);
      expect((await planOf(threadId))?.status).toBe("cancelled");
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("a completion that applies before cancel stays completed and is never cancelled", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening"] });
    const save = spyOn(library, "saveChapter");
    const model = modelFor([toolStream([step(1)]), toolStream([stats()]), replyStream()]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    const completeEntered = gate();
    const releaseComplete = gate();
    const completeApplied = gate();
    let completeCalls = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "complete") {
        completeCalls += 1;
        completeEntered.release();
        await releaseComplete.promise;
        const result = await original.call(store, book, thread, plan, event);
        completeApplied.release();
        return result;
      }
      if (event.type === "cancel") await completeApplied.promise;
      return original.call(store, book, thread, plan, event);
    };
    try {
      const terminal = nextTerminal(runtime);
      await runtime.start(startInput(threadId));
      await completeEntered.promise;
      await runtime.cancelPlan(bookId, threadId, PLAN_ID);
      releaseComplete.release();
      const stopped = await terminal;
      expect(["done", "stopped"]).toContain(stopped.type);
      expect(completeCalls).toBe(1);
      const plan = await planOf(threadId);
      expect(plan?.status).toBe("completed");
      expect(states(plan!)).toEqual(["completed"]);
      expect(events.some((event) => event.type === "plan" && event.change === "cancel")).toBe(false);
      expect(events.some((event) => event.type === "plan-error")).toBe(false);
      expect(save).not.toHaveBeenCalled();
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("cancel with a call that never settles leaves the turn stopping until it does", async () => {
    const threadId = await seedPlan({ steps: ["Write the opening"] });
    const entered = gate();
    const held = gate();
    const save = library.saveChapter.bind(library);
    library.saveChapter = async (...args) => {
      entered.release();
      await held.promise;
      return save(...args);
    };
    const model = modelFor([toolStream([step(1)]), toolStream([append("First passage.")])]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    await runtime.start(startInput(threadId));
    await entered.promise;
    await runtime.cancelPlan(bookId, threadId, PLAN_ID);
    await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan" }> =>
      event.type === "plan" && event.change === "cancel", "the cancel notice");
    await new Promise((pause) => setTimeout(pause, 50));
    expect(events.some((event) => event.type === "stopped")).toBe(false);
    expect((await planOf(threadId))?.status).toBe("cancelled");
    expect(runtime.isWorking(bookId)).toBe(true);
    await expect(runtime.start({ bookId, mode: "edit", prompt: "Another" })).rejects.toThrow(/still stopping/);

    held.release();
    const stopped = await terminal;
    expect(stopped.type).toBe("stopped");
    expect(events.filter((event) => event.type === "stopped")).toHaveLength(1);
    if (stopped.type === "stopped") expect(stopped.changed).toBe(1);
  });

  test("a direct cancel of a proposed plan writes once and allows a new proposal", async () => {
    const threadId = await seedPlan({ state: "proposed" });
    const before = await planOf(threadId);
    await new Promise((pause) => setTimeout(pause, 5));
    const { runtime, events } = runtimeFor(modelFor([]));
    const writes = cancelWriteSpy(library.threads);
    try {
      const result = await runtime.cancelPlan(bookId, threadId, PLAN_ID);
      expect(result.outcome).toBe("cancelled");
      if (result.outcome === "cancelled") {
        expect(result.plan.status).toBe("cancelled");
        expect(states(result.plan)).toEqual(["not-completed", "not-completed"]);
      }
      const plan = await planOf(threadId);
      expect(plan?.status).toBe("cancelled");
      expect(plan?.updatedAt).not.toBe(before?.updatedAt);
      expect(events).toHaveLength(0);
      expect(writes.count.cancel).toBe(1);
      const next = await library.threads.addPlan(bookId, threadId, {
        id: "plan-cancel-2",
        purpose: "The next plan",
        steps: ["Read the opening"],
        parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID }
      });
      expect(next.plans.at(-1)).toMatchObject({ id: "plan-cancel-2", status: "proposed" });
    } finally {
      writes.restore();
    }
  });

  test("a direct cancel write failure returns the error and keeps the confirmed plan", async () => {
    const threadId = await seedPlan({ state: "proposed" });
    const store = library.threads;
    const original = store.applyPlanEvent;
    let cancelCalls = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "cancel") {
        cancelCalls += 1;
        throw new ThreadStoreError("io", "Synthetic direct cancel failure");
      }
      return original.call(store, book, thread, plan, event);
    };
    try {
      const { runtime, events } = runtimeFor(modelFor([]));
      await expect(runtime.cancelPlan(bookId, threadId, PLAN_ID)).rejects.toThrow(/Synthetic direct cancel failure/);
      expect(cancelCalls).toBe(1);
      expect((await planOf(threadId))?.status).toBe("proposed");
      expect(events).toHaveLength(0);
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("a direct cancel of a paused plan keeps completed steps and touches no checkpoint", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening", "Write the close"] });
    await library.threads.applyPlanEvent(bookId, threadId, PLAN_ID, { type: "start", revision: 1 });
    await library.threads.applyPlanEvent(bookId, threadId, PLAN_ID, {
      type: "step", revision: 1, index: 0, state: "in-progress"
    });
    await library.threads.applyPlanEvent(bookId, threadId, PLAN_ID, {
      type: "step", revision: 1, index: 0, state: "completed"
    });
    await library.threads.applyPlanEvent(bookId, threadId, PLAN_ID, { type: "request-pause" });
    await library.threads.applyPlanEvent(bookId, threadId, PLAN_ID, { type: "confirm-pause" });
    expect((await planOf(threadId))?.status).toBe("paused");

    const save = spyOn(library, "saveChapter");
    const { runtime, events } = runtimeFor(modelFor([]));
    const result = await runtime.cancelPlan(bookId, threadId, PLAN_ID);
    expect(result.outcome).toBe("cancelled");
    const plan = await planOf(threadId);
    expect(plan?.status).toBe("cancelled");
    expect(states(plan!)).toEqual(["completed", "not-completed"]);
    expect(events).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    expect((await library.readChapter(bookId, chapterId)).content).toBe("A synthetic lantern shone.\n");
  });

  test("a direct cancel of a failed-confirm pause-requested plan writes no pause confirmation", async () => {
    const threadId = await seedPlan({ steps: ["Read the opening", "Write the close"] });
    await library.threads.applyPlanEvent(bookId, threadId, PLAN_ID, { type: "start", revision: 1 });
    await library.threads.applyPlanEvent(bookId, threadId, PLAN_ID, { type: "request-pause" });
    expect((await planOf(threadId))?.status).toBe("pause-requested");

    const store = library.threads;
    const original = store.applyPlanEvent;
    let confirmCalls = 0;
    store.applyPlanEvent = async (book, thread, plan, event: AgentPlanEvent) => {
      if (event.type === "confirm-pause") confirmCalls += 1;
      return original.call(store, book, thread, plan, event);
    };
    try {
      const { runtime, events } = runtimeFor(modelFor([]));
      const result = await runtime.cancelPlan(bookId, threadId, PLAN_ID);
      expect(result.outcome).toBe("cancelled");
      const plan = await planOf(threadId);
      expect(plan?.status).toBe("cancelled");
      expect(states(plan!)).toEqual(["not-completed", "not-completed"]);
      expect(confirmCalls).toBe(0);
      expect(events).toHaveLength(0);
    } finally {
      store.applyPlanEvent = original;
    }
  });

  test("a direct cancel refuses a runtime-loss running or waiting plan", async () => {
    const runningThread = await seedPlan({ steps: ["Read the opening"], state: "running" });
    const waitingThread = await seedPlan({ steps: ["Replace the opening"], state: "waiting-for-approval" });
    const { runtime, events } = runtimeFor(modelFor([]));
    const writes = cancelWriteSpy(library.threads);
    try {
      await expect(runtime.cancelPlan(bookId, runningThread, PLAN_ID))
        .rejects.toThrow(/not running in this app/);
      await expect(runtime.cancelPlan(bookId, waitingThread, PLAN_ID))
        .rejects.toThrow(/not running in this app/);
      expect((await planOf(runningThread))?.status).toBe("running");
      expect((await planOf(waitingThread))?.status).toBe("waiting-for-approval");
      expect(writes.count.cancel).toBe(0);
      expect(events).toHaveLength(0);
    } finally {
      writes.restore();
    }
  });

  test("a duplicate direct cancel returns the unchanged cancelled plan without a second write", async () => {
    const threadId = await seedPlan({ state: "proposed" });
    await new Promise((pause) => setTimeout(pause, 5));
    const { runtime, events } = runtimeFor(modelFor([]));
    const writes = cancelWriteSpy(library.threads);
    try {
      const first = await runtime.cancelPlan(bookId, threadId, PLAN_ID);
      expect(first.outcome).toBe("cancelled");
      const afterFirst = await planOf(threadId);
      const second = await runtime.cancelPlan(bookId, threadId, PLAN_ID);
      expect(second.outcome).toBe("cancelled");
      if (second.outcome === "cancelled") expect(second.plan.updatedAt).toBe(afterFirst!.updatedAt);
      expect((await planOf(threadId))?.updatedAt).toBe(afterFirst?.updatedAt);
      expect(writes.count.cancel).toBe(1);
      expect(events).toHaveLength(0);
    } finally {
      writes.restore();
    }
  });

  test("a stopped message that cannot be saved after cancel still publishes stopped with the conversation warning", async () => {
    const threadId = await seedPlan({ steps: ["Replace the opening"] });
    const save = spyOn(library, "saveChapter");
    const model = modelFor([
      toolStream([step(1)]),
      toolStream([{ name: "overwrite_chapter", input: { chapterId, content: "Replaced opening.\n" } }])
    ]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.upsertMessage.bind(store);
    let failStopped = false;
    let stoppedAttempts = 0;
    store.upsertMessage = async (book, thread, message) => {
      // The stopped message is the persistence point for the expired approval parts. It is
      // identified by its own stopped error part, so this is deterministic even when the cancel
      // write and the stopped message race.
      if (message.parts.some((part) => part.type === "error" && part.code === "stopped")) {
        stoppedAttempts += 1;
        throw new ThreadStoreError("io", "Synthetic stopped message failure");
      }
      return original(book, thread, message);
    };
    const armFailure = runtime.onEvent((event) => {
      if (event.type === "plan" && event.change === "cancel") failStopped = true;
    });
    try {
      const terminal = nextTerminal(runtime);
      const started = await runtime.start(startInput(threadId));
      const approval = await waitFor(events, (event): event is ApprovalEvent =>
        event.type === "approval" && event.turnId === started.turnId, "the approval request");
      await runtime.cancelPlan(bookId, threadId, PLAN_ID);
      const stopped = await terminal;
      armFailure();
      expect(failStopped).toBe(true);
      expect(stopped.type).toBe("stopped");
      if (stopped.type === "stopped") {
        expect(stopped.persistenceError).toContain(
          "The conversation outcome could not be fully saved. Changes to the book remain."
        );
      }
      expect(stoppedAttempts).toBe(1);
      expect(save).not.toHaveBeenCalled();
      expect((await planOf(threadId))?.status).toBe("cancelled");
      await expect(runtime.approve(started.turnId, approval.approvalId, true)).rejects.toThrow(/no longer waiting/);
    } finally {
      store.upsertMessage = original;
    }
  });

  test("cancel upgrades an open pause and writes no confirmation", async () => {
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
      toolStream([append("First passage.")]),
      toolStream([step(2)]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const terminal = nextTerminal(runtime);
    const started = await runtime.start(startInput(threadId));
    await entered.promise;
    await runtime.stop(started.turnId);
    await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan" }> =>
      event.type === "plan" && event.change === "request-pause", "the request-pause notice");
    await runtime.cancelPlan(bookId, threadId, PLAN_ID);
    await waitFor(events, (event): event is Extract<AgentEvent, { type: "plan" }> =>
      event.type === "plan" && event.change === "cancel", "the cancel notice");
    held.release();
    const stopped = await terminal;

    expect(stopped.type).toBe("stopped");
    if (stopped.type === "stopped") expect(stopped.changed).toBe(1);
    expect(cancelSequence(events)).toEqual(["stopping", "plan:request-pause", "plan:cancel", "stopped"]);
    expect(events.filter((event) => event.type === "stopping")).toHaveLength(1);
    expect(events.some((event) => event.type === "plan" && event.change === "confirm-pause")).toBe(false);
    const plan = await planOf(threadId);
    expect(plan?.status).toBe("cancelled");
    expect(states(plan!)).toEqual(["not-completed", "not-completed"]);
    expect((await library.readChapter(bookId, chapterId)).content).toContain("First passage.");
  });
});
