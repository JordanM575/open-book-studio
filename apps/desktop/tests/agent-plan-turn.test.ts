import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type AgentPlanStatus
} from "@ai-book-studio/core/agent/messages";
import type { AgentPlanEvent } from "@ai-book-studio/core/agent/plan-state";
import { ThreadStoreError } from "@ai-book-studio/core/agent/threads";
import { ProviderError } from "@ai-book-studio/core/providers/types";
import type { ProviderService } from "../src/main/providers";
import type { Studio } from "../src/main/studio";
import { Library } from "../src/main/library/store";
import { AgentRuntime } from "../src/main/agent/runtime";

let root: string;
let library: Library;
let bookId: string;
let chapterId: string;
let providerReads: number;

const PLAN_ID = "plan-1";
const PLAN_PARENT_ID = "msg_plan0001";
const PLAN_TURN_ID = "turn_plan0001";
const PLAN_PURPOSE = "Revise the opening scene";
const PLAN_STEPS = ["Read the opening", "Rewrite the door"];
const PLAN_GUIDANCE = "Keep the lantern metaphor in every scene.";
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-plan-turn-"));
  library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic plan" });
  bookId = book.id;
  chapterId = (await library.createChapter(bookId, { title: "Light", content: "A synthetic lantern shone.\n" })).id;
  await library.updateBook(bookId, { defaultConnectionId: "conn_synthetic", defaultModelId: "synthetic-model" });
  providerReads = 0;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function reply() {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "text" },
    { type: "text-delta" as const, id: "text", delta: "Synthetic reply." },
    { type: "text-end" as const, id: "text" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE }
  ] }) };
}

function modelFor() {
  return new MockLanguageModelV4({ doStream: [reply()] });
}

function planCall(name: string, input: unknown, id: number) {
  return {
    stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-call" as const, toolCallId: `plan-call-${id}`, toolName: name, input: JSON.stringify(input) },
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: USAGE }
    ] })
  };
}

/** A reviewed two-step plan: each step observes one successful read, then the turn ends. */
function planModel() {
  return new MockLanguageModelV4({ doStream: [
    planCall("plan_step", { step: 1 }, 1),
    planCall("chapter_stats", { chapterId }, 2),
    planCall("plan_step", { step: 2 }, 3),
    planCall("chapter_stats", { chapterId }, 4),
    reply()
  ] });
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

async function finish(runtime: AgentRuntime, input: AgentTurnInput) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off = () => {};
  const done = new Promise<AgentEvent>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Synthetic turn did not finish")), 4000);
    off = runtime.onEvent((event) => {
      if (event.type === "done" || event.type === "stopped") resolve(event);
      if (event.type === "error" || event.type === "approval") reject(new Error(`Unexpected ${event.type}`));
    });
  });
  try {
    const started = await runtime.start(input);
    await done;
    return started;
  } finally {
    clearTimeout(timer);
    off();
  }
}

async function refusalOf(pending: Promise<unknown>): Promise<AgentTurnRefusedError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof AgentTurnRefusedError) return error;
    throw error;
  }
  throw new Error("Expected the turn to be refused");
}

async function errorOf(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the turn to fail");
}

function threadPath(threadId: string): string {
  return join(root, "books", bookId, "threads", `${threadId}.json`);
}

async function bytesOf(threadId: string): Promise<string> {
  return readFile(threadPath(threadId), "utf8");
}

function planInput(
  threadId: string | null | undefined,
  action: "start" | "resume",
  overrides: Partial<AgentTurnInput> = {}
): AgentTurnInput {
  return {
    bookId,
    prompt: "Start the plan",
    mode: "edit",
    ...(threadId !== undefined ? { threadId } : {}),
    plan: { id: PLAN_ID, revision: 1, action },
    ...overrides
  };
}

function planParent(withApproval = false): AgentMessage {
  return agentMessageSchema.parse({
    id: PLAN_PARENT_ID,
    role: "assistant",
    parts: [
      { type: "text", text: "Here is the plan." },
      ...(withApproval ? [{
        type: "approval",
        approvalId: "approval-old",
        turnId: PLAN_TURN_ID,
        name: "delete_chapter",
        input: { chapterId },
        status: "pending",
        requestedAt: new Date().toISOString()
      }] : [])
    ],
    mode: "edit",
    turnId: PLAN_TURN_ID,
    createdAt: new Date().toISOString()
  });
}

async function seedPlan(options: {
  guidance?: string;
  withApproval?: boolean;
  failedAttempt?: boolean;
} = {}): Promise<string> {
  const thread = await library.threads.create(bookId, "Plan conversation");
  await library.threads.appendMessage(bookId, thread.id, planParent(options.withApproval === true));
  await library.threads.addPlan(bookId, thread.id, {
    id: PLAN_ID,
    purpose: PLAN_PURPOSE,
    steps: PLAN_STEPS,
    parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID },
    ...(options.guidance !== undefined ? { guidance: options.guidance } : {})
  });
  if (options.failedAttempt) {
    await library.threads.appendMessage(bookId, thread.id, agentMessageSchema.parse({
      id: "msg_failed0001",
      role: "user",
      mode: "edit",
      parts: [{ type: "text", text: "Start the plan" }, { type: "guidance", text: PLAN_GUIDANCE }],
      createdAt: new Date().toISOString()
    }));
    await library.threads.appendMessage(bookId, thread.id, agentMessageSchema.parse({
      id: "msg_failed0002",
      role: "assistant",
      mode: "edit",
      parts: [
        { type: "text", text: "Partial answer." },
        { type: "error", code: "unknown", message: "Synthetic failure" }
      ],
      turnId: "turn_failed0001",
      createdAt: new Date().toISOString()
    }));
  }
  return thread.id;
}

async function movePlan(threadId: string, event: AgentPlanEvent): Promise<void> {
  await library.threads.applyPlanEvent(bookId, threadId, PLAN_ID, event);
}

async function threadWithStatus(status: AgentPlanStatus): Promise<string> {
  const threadId = await seedPlan();
  if (status === "proposed") return threadId;
  if (status === "cancelled" || status === "expired") {
    await movePlan(threadId, { type: status === "cancelled" ? "cancel" : "expire" });
    return threadId;
  }
  await movePlan(threadId, { type: "start", revision: 1 });
  if (status === "running") return threadId;
  if (status === "waiting-for-approval") {
    await movePlan(threadId, { type: "request-approval" });
    return threadId;
  }
  if (status === "pause-requested") {
    await movePlan(threadId, { type: "request-pause" });
    return threadId;
  }
  if (status === "paused") {
    await movePlan(threadId, { type: "request-pause" });
    await movePlan(threadId, { type: "confirm-pause" });
    return threadId;
  }
  if (status === "failed") {
    await movePlan(threadId, { type: "fail" });
    return threadId;
  }
  await movePlan(threadId, { type: "step", revision: 1, index: 0, state: "in-progress" });
  await movePlan(threadId, { type: "step", revision: 1, index: 0, state: "completed" });
  await movePlan(threadId, { type: "complete" });
  return threadId;
}

function planOf(thread: { plans: AgentPlan[] } | null): AgentPlan | null {
  return thread?.plans.find((plan) => plan.id === PLAN_ID) ?? null;
}

describe("plan turn pre-flight", () => {
  test("refuses a missing or unknown mode before any provider read or thread write", async () => {
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    const bookPath = join(root, "books", bookId, "book.json");
    const before = await readFile(bookPath, "utf8");
    for (const mode of [undefined, "invalid"]) {
      const input = { bookId, prompt: "Start", ...(mode ? { mode } : {}) } as unknown as AgentTurnInput;
      expect((await refusalOf(runtime.start(input))).refusal).toBe("invalid-mode");
    }
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
    expect(await library.threads.list(bookId)).toEqual([]);
    expect(await readFile(bookPath, "utf8")).toBe(before);
  });

  test("refuses every extra plan key before any provider read or thread write", async () => {
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    for (const extra of [
      { steps: ["Read"] },
      { purpose: "Rewrite the opening" },
      { guidance: "Keep it short" },
      { model: { connectionId: "conn", modelId: "model" } },
      { tools: ["delete_chapter"] },
      { approval: { approvalId: "approval-1" } },
      { approvals: [] },
      { approved: true },
      { mode: "edit" },
      { parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID } }
    ]) {
      const input = {
        bookId,
        prompt: "Start",
        mode: "edit",
        threadId: "thread_absent1",
        plan: { id: PLAN_ID, revision: 1, action: "start", ...extra }
      } as unknown as AgentTurnInput;
      expect((await refusalOf(runtime.start(input))).refusal).toBe("invalid-plan");
    }
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
    expect(await library.threads.list(bookId)).toEqual([]);
  });

  test("refuses a blank or over-bound id, a bad revision and an unknown action", async () => {
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    for (const plan of [
      { id: "", revision: 1, action: "start" },
      { id: "   ", revision: 1, action: "start" },
      { id: "p".repeat(201), revision: 1, action: "start" },
      { id: PLAN_ID, revision: 0, action: "start" },
      { id: PLAN_ID, revision: 1.5, action: "start" },
      { id: PLAN_ID, revision: 1, action: "apply" }
    ]) {
      const input = { bookId, prompt: "Start", mode: "edit", threadId: "thread_absent1", plan } as unknown as AgentTurnInput;
      expect((await refusalOf(runtime.start(input))).refusal).toBe("invalid-plan");
    }
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
    expect(await library.threads.list(bookId)).toEqual([]);
  });

  test("refuses a plan in Discuss and a plan without a conversation", async () => {
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    for (const input of [
      planInput("thread_absent1", "start", { mode: "discuss" }),
      planInput(undefined, "start"),
      planInput(null, "start")
    ]) {
      const expected = input.mode === "discuss" ? "plan-in-discuss" : "plan-without-thread";
      expect((await refusalOf(runtime.start(input))).refusal).toBe(expected);
    }
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
    expect(await library.threads.list(bookId)).toEqual([]);
  });

  test("refuses a plan id that is absent from the named conversation without writing it", async () => {
    const threadId = await seedPlan();
    const before = await bytesOf(threadId);
    const empty = await library.threads.create(bookId, "Empty conversation");
    const emptyBefore = await bytesOf(empty.id);
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    for (const target of [threadId, empty.id]) {
      const input = planInput(target, "start", { plan: { id: "plan-unknown", revision: 1, action: "start" } });
      expect((await refusalOf(runtime.start(input))).refusal).toBe("plan-not-found");
    }
    expect(await bytesOf(threadId)).toBe(before);
    expect(await bytesOf(empty.id)).toBe(emptyBefore);
    expect((await library.threads.read(bookId, threadId))?.messages).toHaveLength(1);
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
  });

  test("never looks a plan up in another conversation", async () => {
    const threadA = await seedPlan();
    const threadB = await library.threads.create(bookId, "Other conversation");
    const aBefore = await bytesOf(threadA);
    const bBefore = await bytesOf(threadB.id);
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    expect((await refusalOf(runtime.start(planInput(threadB.id, "start")))).refusal).toBe("plan-not-found");
    expect(await bytesOf(threadA)).toBe(aBefore);
    expect(await bytesOf(threadB.id)).toBe(bBefore);
    expect(planOf(await library.threads.read(bookId, threadA))?.status).toBe("proposed");
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
  });

  test("refuses a stale reviewed revision and leaves the refreshed plan proposed", async () => {
    const threadId = await seedPlan();
    await library.threads.refreshPlanProposal(bookId, threadId, PLAN_ID, { revision: 2 });
    const before = await bytesOf(threadId);
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    expect((await refusalOf(runtime.start(planInput(threadId, "start")))).refusal).toBe("plan-stale-revision");
    const thread = await library.threads.read(bookId, threadId);
    expect(planOf(thread)).toMatchObject({ status: "proposed", revision: 2 });
    expect(thread?.messages).toHaveLength(1);
    expect(await bytesOf(threadId)).toBe(before);
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
  });

  test("refuses Start on every status that is not proposed", async () => {
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    for (const status of [
      "running",
      "waiting-for-approval",
      "pause-requested",
      "paused",
      "completed",
      "cancelled",
      "failed",
      "expired"
    ] as const) {
      const threadId = await threadWithStatus(status);
      const messagesBefore = (await library.threads.read(bookId, threadId))?.messages.length;
      expect((await refusalOf(runtime.start(planInput(threadId, "start")))).refusal).toBe("plan-not-startable");
      const thread = await library.threads.read(bookId, threadId);
      expect(planOf(thread)?.status).toBe(status);
      expect(thread?.messages.length).toBe(messagesBefore);
    }
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
  });

  test("refuses Resume on every status that is not paused", async () => {
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    for (const status of [
      "proposed",
      "running",
      "waiting-for-approval",
      "pause-requested",
      "completed",
      "cancelled",
      "failed",
      "expired"
    ] as const) {
      const threadId = await threadWithStatus(status);
      expect((await refusalOf(runtime.start(planInput(threadId, "resume")))).refusal).toBe("plan-not-resumable");
      expect(planOf(await library.threads.read(bookId, threadId))?.status).toBe(status);
    }
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
  });

  test("refuses a duplicate Start with one turn, one user message and one factory call", async () => {
    const threadId = await seedPlan();
    const model = planModel();
    const { runtime, factoryCalls } = runtimeFor(model);
    const started = await finish(runtime, planInput(threadId, "start"));
    expect(started.plan).toMatchObject({ id: PLAN_ID, revision: 1, status: "running" });
    expect((await refusalOf(runtime.start(planInput(threadId, "start")))).refusal).toBe("plan-not-startable");
    const thread = await library.threads.read(bookId, threadId);
    expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(planOf(thread)?.status).toBe("completed");
    expect(factoryCalls()).toBe(1);
    expect(model.doStreamCalls).toHaveLength(5);
  });

  test("refuses blank or over-bound turn guidance before any provider read", async () => {
    const threadId = await seedPlan();
    const before = await bytesOf(threadId);
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    for (const guidance of ["x".repeat(2001), "", "   "]) {
      expect((await refusalOf(runtime.start(planInput(threadId, "start", { guidance })))).refusal)
        .toBe("invalid-guidance");
    }
    const thread = await library.threads.read(bookId, threadId);
    expect(thread?.messages).toHaveLength(1);
    expect(planOf(thread)).toMatchObject({ status: "proposed", revision: 1 });
    expect(await bytesOf(threadId)).toBe(before);
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
  });

  test("refuses an over-bound stored plan at read and leaves the file untouched", async () => {
    const threadId = await seedPlan();
    const raw = JSON.parse(await bytesOf(threadId)) as { plans: Array<Record<string, unknown>> };
    raw.plans[0]!.purpose = "p".repeat(2001);
    const overBound = `${JSON.stringify(raw, null, 2)}\n`;
    await writeFile(threadPath(threadId), overBound, "utf8");
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    expect((await refusalOf(runtime.start(planInput(threadId, "start")))).refusal).toBe("plan-invalid");
    expect(await bytesOf(threadId)).toBe(overBound);
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
  });

  test("refuses guidance that differs from the reviewed proposal", async () => {
    const withGuidance = await seedPlan({ guidance: PLAN_GUIDANCE });
    const withoutGuidance = await seedPlan();
    const before = await bytesOf(withGuidance);
    const { runtime, factoryCalls } = runtimeFor(modelFor());
    expect((await refusalOf(runtime.start(planInput(withGuidance, "start", {
      guidance: "Use a different metaphor."
    })))).refusal).toBe("plan-guidance-mismatch");
    expect((await refusalOf(runtime.start(planInput(withoutGuidance, "start", {
      guidance: "Unreviewed guidance."
    })))).refusal).toBe("plan-guidance-mismatch");
    expect(planOf(await library.threads.read(bookId, withGuidance))?.guidance).toBe(PLAN_GUIDANCE);
    expect((await library.threads.read(bookId, withGuidance))?.messages).toHaveLength(1);
    expect(await bytesOf(withGuidance)).toBe(before);
    expect(factoryCalls()).toBe(0);
    expect(providerReads).toBe(0);
  });
});

describe("plan start and resume", () => {
  test("uses the stored plan guidance once without carrying it to the next turn", async () => {
    const threadId = await seedPlan({ guidance: PLAN_GUIDANCE });
    const model = planModel();
    const { runtime, events } = runtimeFor(model);
    const started = await finish(runtime, planInput(threadId, "start", { guidance: undefined }));
    expect(started).toMatchObject({ mode: "edit", plan: { id: PLAN_ID, revision: 1, status: "running" } });
    const thread = await library.threads.read(bookId, threadId);
    const user = thread?.messages.findLast((message) => message.role === "user");
    expect(user?.parts).toContainEqual({ type: "guidance", text: PLAN_GUIDANCE });
    expect(thread?.messages.at(-1)?.mode).toBe("edit");
    const sent = model.doStreamCalls[0]?.prompt;
    expect(JSON.stringify(sent?.find((message) => message.role === "system"))).not.toContain(PLAN_GUIDANCE);
    expect(JSON.stringify(sent?.find((message) => message.role === "user"))).toContain(PLAN_GUIDANCE);
    expect(model.doStreamCalls).toHaveLength(5);
    expect(events.filter((event) => event.type === "plan").map((event) => event.type === "plan" ? event.change : null))
      .toEqual(["complete"]);
    expect(events.some((event) => event.type === "plan-error")).toBe(false);

    const next = modelFor();
    await finish(runtimeFor(next).runtime, {
      bookId,
      threadId,
      mode: "edit",
      prompt: "Continue the work"
    });
    expect(JSON.stringify(next.doStreamCalls[0]?.prompt)).not.toContain(PLAN_GUIDANCE);
  });

  test("accepts the reviewed guidance repeated exactly once and keeps the Edit tool set plus plan_step", async () => {
    const baselineModel = modelFor();
    const baseline = runtimeFor(baselineModel);
    await finish(baseline.runtime, { bookId, mode: "edit", prompt: "An ordinary edit" });
    const baselineDone = baseline.events.find((event) => event.type === "done");
    const threadId = await seedPlan({ guidance: PLAN_GUIDANCE });
    const model = planModel();
    const run = runtimeFor(model);
    const started = await finish(run.runtime, planInput(threadId, "start", { guidance: PLAN_GUIDANCE }));
    const thread = await library.threads.read(bookId, threadId);
    const user = thread?.messages.findLast((message) => message.role === "user");
    expect(user?.parts.filter((part) => part.type === "guidance")).toEqual([
      { type: "guidance", text: PLAN_GUIDANCE }
    ]);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(PLAN_GUIDANCE);
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name).sort())
      .toEqual([...(baselineModel.doStreamCalls[0]?.tools?.map((tool) => tool.name) ?? []), "plan_step"].sort());
    expect(started.mode).toBe("edit");
    const planDone = run.events.find((event) => event.type === "done");
    expect(planDone?.type === "done" ? planDone.model.modelId : null)
      .toBe(baselineDone?.type === "done" ? baselineDone.model.modelId : null);
  });

  test("omits guidance when neither the turn nor the plan names one", async () => {
    const threadId = await seedPlan();
    const model = planModel();
    const { runtime } = runtimeFor(model);
    await finish(runtime, planInput(threadId, "start"));
    const thread = await library.threads.read(bookId, threadId);
    const user = thread?.messages.findLast((message) => message.role === "user");
    expect(user?.parts.some((part) => part.type === "guidance")).toBe(false);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain("Author guidance for this turn only");
  });

  test("ordinary Discuss and Edit turns carry mode, no plan and their own guidance", async () => {
    for (const mode of ["discuss", "edit"] as const) {
      for (const guidance of [undefined, "Only this turn."]) {
        const model = modelFor();
        const { runtime, factoryCalls, events } = runtimeFor(model);
        const started = await finish(runtime, {
          bookId,
          mode,
          prompt: `An ordinary ${mode} turn`,
          ...(guidance !== undefined ? { guidance } : {})
        });
        expect(started).toMatchObject({ mode });
        expect(started.plan).toBeUndefined();
        const thread = await library.threads.read(bookId, started.threadId);
        expect(thread?.messages.map((message) => message.mode)).toEqual([mode, mode]);
        expect(thread?.plans).toEqual([]);
        expect(thread?.messages[0]?.parts.some((part) => part.type === "guidance"))
          .toBe(guidance !== undefined);
        expect(model.doStreamCalls).toHaveLength(1);
        expect(factoryCalls()).toBe(1);
        expect(events.some((event) => event.type === "plan")).toBe(false);
      }
    }
  });

  test("Start appends a new user message even when an earlier failed attempt matches", async () => {
    const threadId = await seedPlan({ guidance: PLAN_GUIDANCE, failedAttempt: true });
    const before = await library.threads.read(bookId, threadId);
    const model = planModel();
    const { runtime, events } = runtimeFor(model);
    const started = await finish(runtime, planInput(threadId, "start", { guidance: PLAN_GUIDANCE }));
    const thread = await library.threads.read(bookId, threadId);
    expect(thread?.messages.length).toBe((before?.messages.length ?? 0) + 2);
    expect(thread?.messages.at(-2)).toMatchObject({ role: "user", mode: "edit" });
    expect(thread?.messages.at(-1)).toMatchObject({ role: "assistant", mode: "edit" });
    expect(planOf(thread)).toMatchObject({ status: "completed", revision: 1 });
    expect(planOf(thread)?.startedAt).toBeTruthy();
    expect(started.plan).toMatchObject({ id: PLAN_ID, revision: 1, status: "running" });
    expect(model.doStreamCalls).toHaveLength(5);
    expect(events.filter((event) => event.type === "plan").map((event) => event.type === "plan" ? event.change : null))
      .toEqual(["complete"]);
    expect(events.some((event) => event.type === "plan-error")).toBe(false);
  });

  test("Resume appends a fresh turn, preserves the plan and inherits no approval", async () => {
    const threadId = await seedPlan({ guidance: PLAN_GUIDANCE, withApproval: true });
    await movePlan(threadId, { type: "start", revision: 1 });
    await movePlan(threadId, { type: "request-pause" });
    await movePlan(threadId, { type: "confirm-pause" });
    const paused = await library.threads.read(bookId, threadId);
    const startedAt = planOf(paused)?.startedAt;
    expect(planOf(paused)).toMatchObject({ status: "paused", revision: 1, startedAt });
    const messagesBefore = paused?.messages.length ?? 0;

    const model = planModel();
    const { runtime, events } = runtimeFor(model);
    const started = await finish(runtime, planInput(threadId, "resume", { guidance: PLAN_GUIDANCE }));
    const thread = await library.threads.read(bookId, threadId);
    expect(planOf(thread)).toMatchObject({ status: "completed", revision: 1, startedAt });
    expect(thread?.messages.length).toBe(messagesBefore + 2);
    expect(thread?.messages.at(-2)?.parts).toContainEqual({ type: "guidance", text: PLAN_GUIDANCE });
    expect(started.plan).toMatchObject({ id: PLAN_ID, revision: 1, status: "running" });
    const approval = thread?.messages.flatMap((message) => message.parts)
      .find((part) => part.type === "approval" && part.approvalId === "approval-old");
    expect(approval).toMatchObject({ type: "approval", status: "expired" });
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain("approval-old");
    expect(events.some((event) => event.type === "approval")).toBe(false);
    expect(model.doStreamCalls).toHaveLength(5);
  });

  test("captures mode, guidance, plan id and revision before the first await", async () => {
    const threadId = await seedPlan({ guidance: PLAN_GUIDANCE });
    const model = planModel();
    const { runtime } = runtimeFor(model);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let off = () => {};
    const done = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Synthetic turn did not finish")), 4000);
      off = runtime.onEvent((event) => {
        if (event.type === "done" || event.type === "stopped") resolve();
        if (event.type === "error" || event.type === "approval") reject(new Error(`Unexpected ${event.type}`));
      });
    });
    const input = planInput(threadId, "start", { guidance: PLAN_GUIDANCE });
    try {
      const pending = runtime.start(input);
      input.mode = "discuss";
      input.guidance = "MUTATED AFTER SUBMISSION";
      input.plan!.id = "plan-mutated";
      input.plan!.revision = 99;
      const started = await pending;
      await done;
      expect(started).toMatchObject({ mode: "edit", plan: { id: PLAN_ID, revision: 1, status: "running" } });
      const thread = await library.threads.read(bookId, threadId);
      const user = thread?.messages.findLast((message) => message.role === "user");
      expect(user).toMatchObject({ mode: "edit" });
      expect(user?.parts).toContainEqual({ type: "guidance", text: PLAN_GUIDANCE });
      expect(planOf(thread)).toMatchObject({ id: PLAN_ID, status: "completed", revision: 1 });
      expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain("MUTATED AFTER SUBMISSION");
    } finally {
      clearTimeout(timer);
      off();
    }
  });

  test("an ordinary turn ignores a stored plan without changing it", async () => {
    const threadId = await seedPlan();
    const before = planOf(await library.threads.read(bookId, threadId));
    const model = modelFor();
    const { runtime, events } = runtimeFor(model);
    const started = await finish(runtime, {
      bookId,
      threadId,
      mode: "edit",
      prompt: "An ordinary edit beside a plan"
    });
    expect(started.plan).toBeUndefined();
    expect(planOf(await library.threads.read(bookId, threadId))).toEqual(before);
    expect(events.some((event) => event.type === "plan" || event.type === "plan-step" || event.type === "plan-error"))
      .toBe(false);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

describe("plan write failure", () => {
  test("refuses plan-state without a user message, provider stream or retry", async () => {
    for (const code of ["io", "conflict", "uncertain"] as const) {
      const threadId = await seedPlan();
      const before = await bytesOf(threadId);
      const model = modelFor();
      const { runtime } = runtimeFor(model);
      const store = library.threads;
      const original = store.applyPlanEvent;
      let calls = 0;
      store.applyPlanEvent = async () => {
        calls++;
        throw new ThreadStoreError(code, `Synthetic ${code} plan write`);
      };
      try {
        const refusal = await refusalOf(runtime.start(planInput(threadId, "start")));
        expect(refusal.refusal).toBe("plan-state");
        expect(refusal.message).toBe(`Synthetic ${code} plan write`);
        expect(calls).toBe(1);
        expect(model.doStreamCalls).toHaveLength(0);
        expect(await bytesOf(threadId)).toBe(before);
        const thread = await library.threads.read(bookId, threadId);
        expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(0);
        expect(planOf(thread)).toMatchObject({ status: "proposed", revision: 1 });
      } finally {
        store.applyPlanEvent = original;
      }
    }
  });

  test("an uncertain write is reported, never treated as started", async () => {
    const threadId = await seedPlan();
    const model = modelFor();
    const { runtime } = runtimeFor(model);
    const store = library.threads;
    const original = store.applyPlanEvent;
    store.applyPlanEvent = async () => {
      throw new ThreadStoreError(
        "uncertain",
        "The conversation file may have been published, but the adapter could not confirm it."
      );
    };
    try {
      expect((await refusalOf(runtime.start(planInput(threadId, "start")))).refusal).toBe("plan-state");
      expect(planOf(await library.threads.read(bookId, threadId))?.status).toBe("proposed");
      expect(model.doStreamCalls).toHaveLength(0);
    } finally {
      store.applyPlanEvent = original;
    }
  });
});

describe("start-path setup failure", () => {
  test("attempts one fail transition after the plan write and reports the turn did not start", async () => {
    const threadId = await seedPlan();
    const model = modelFor();
    const { runtime, factoryCalls } = runtimeFor(model);
    const store = library.threads;
    const originalAppend = store.appendMessage;
    const originalApply = store.applyPlanEvent;
    let failCalls = 0;
    store.appendMessage = async () => { throw new Error("Synthetic setup failure"); };
    store.applyPlanEvent = async (book, thread, plan, event) => {
      if (event.type === "fail") failCalls++;
      return originalApply.call(store, book, thread, plan, event);
    };
    try {
      const error = await errorOf(runtime.start(planInput(threadId, "start")));
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).toContain("did not start");
      expect(error.message).toContain("marked failed");
      expect(failCalls).toBe(1);
      expect(factoryCalls()).toBe(1);
      expect(model.doStreamCalls).toHaveLength(0);
      const thread = await library.threads.read(bookId, threadId);
      expect(planOf(thread)).toMatchObject({ status: "failed" });
      expect(planOf(thread)?.terminalAt).toBeTruthy();
      expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(0);
    } finally {
      store.appendMessage = originalAppend;
      store.applyPlanEvent = originalApply;
    }
  });

  test("reports both the setup failure and a failed compensation without a false failed plan", async () => {
    const threadId = await seedPlan();
    const model = modelFor();
    const { runtime } = runtimeFor(model);
    const store = library.threads;
    const originalAppend = store.appendMessage;
    const originalApply = store.applyPlanEvent;
    store.appendMessage = async () => { throw new Error("Synthetic setup failure"); };
    store.applyPlanEvent = async (book, thread, plan, event) => {
      if (event.type === "fail") throw new ThreadStoreError("io", "Synthetic fail write");
      return originalApply.call(store, book, thread, plan, event);
    };
    try {
      const error = await errorOf(runtime.start(planInput(threadId, "start")));
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).toContain("did not start");
      expect(error.message).toContain("could not be marked failed");
      const thread = await library.threads.read(bookId, threadId);
      expect(planOf(thread)).toMatchObject({ status: "running" });
      expect(model.doStreamCalls).toHaveLength(0);
    } finally {
      store.appendMessage = originalAppend;
      store.applyPlanEvent = originalApply;
    }
  });
});
