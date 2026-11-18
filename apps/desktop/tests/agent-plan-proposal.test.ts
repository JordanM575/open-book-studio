import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { agentMessageSchema, messageText, type AgentMessage } from "@ai-book-studio/core/agent/messages";
import { ThreadStoreError } from "@ai-book-studio/core/agent/threads";
import { READ_TOOL_NAMES } from "../src/main/agent/tools";
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
/** Fixture plans seeded directly through the store, so this test's runtime can own them. */
const seededPlans = new Map<string, string>();

const PURPOSE = "Revise the opening scene";
const STEPS = ["Read the opening", "Rewrite the door"];
const GUIDANCE = "Keep the lantern metaphor.";
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-plan-proposal-"));
  library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic plan proposal" });
  bookId = book.id;
  chapterId = (await library.createChapter(bookId, {
    title: "Light",
    content: "A synthetic lantern shone.\n"
  })).id;
  await library.updateBook(bookId, { defaultConnectionId: "conn_synthetic", defaultModelId: "synthetic-model" });
  providerReads = 0;
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

function replyStream(text = "The plan is ready for your review.") {
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
  // A fixture plan is seeded directly through the store. Record it as owned by this test's
  // runtime, exactly as the product proposal/start path would, so the T017 sweep does not treat
  // the fixture as a plan from a lost runtime.
  for (const [threadId, planId] of seededPlans) {
    (runtime as unknown as { ownedPlans: Set<string> }).ownedPlans.add(
      JSON.stringify([bookId, threadId, planId])
    );
  }
  return { runtime, events, factoryCalls: () => factoryCalls };
}

type Terminal = Extract<AgentEvent, { type: "done" | "error" | "stopped" }>;

async function runProposal(
  runtime: AgentRuntime,
  overrides: Partial<AgentTurnInput> = {}
): Promise<{ started: Awaited<ReturnType<AgentRuntime["start"]>>; terminal: Terminal }> {
  let resolveTerminal!: (event: Terminal) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const terminal = new Promise<Terminal>((resolve, reject) => {
    resolveTerminal = resolve;
    timer = setTimeout(() => reject(new Error("The synthetic proposal turn did not finish.")), 4000);
  });
  const off = runtime.onEvent((event) => {
    if (event.type === "done" || event.type === "error" || event.type === "stopped") resolveTerminal(event);
  });
  try {
    const started = await runtime.start({
      bookId,
      mode: "edit",
      prompt: "Propose a plan for the opening.",
      planProposal: true,
      ...overrides
    });
    return { started, terminal: await terminal };
  } finally {
    if (timer) clearTimeout(timer);
    off();
  }
}

function proposalParent(): AgentMessage {
  return agentMessageSchema.parse({
    id: "msg_proposal0001",
    role: "assistant",
    parts: [{ type: "text", text: "Earlier plan." }],
    mode: "edit",
    turnId: "turn_proposal0001",
    createdAt: new Date().toISOString()
  });
}

async function seedLivePlan(): Promise<string> {
  const thread = await library.threads.create(bookId, "Plan conversation");
  await library.threads.appendMessage(bookId, thread.id, proposalParent());
  await library.threads.addPlan(bookId, thread.id, {
    id: "plan-live-1",
    purpose: "An existing plan",
    steps: ["Do the existing work"],
    parent: { messageId: "msg_proposal0001", turnId: "turn_proposal0001" }
  });
  seededPlans.set(thread.id, "plan-live-1");
  return thread.id;
}

describe("read-only proposal turn", () => {
  test("offers the six reads plus propose_plan, changes no book bytes and stores the reviewed plan", async () => {
    const before = (await library.readChapter(bookId, chapterId)).content;
    const model = modelFor([
      toolStream([{ name: "propose_plan", input: { purpose: PURPOSE, steps: STEPS } }]),
      replyStream()
    ]);
    const { runtime, events, factoryCalls } = runtimeFor(model);
    const { started, terminal } = await runProposal(runtime, { guidance: GUIDANCE });

    expect(terminal.type).toBe("done");
    expect(factoryCalls()).toBe(1);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name).sort())
      .toEqual([...READ_TOOL_NAMES, "propose_plan"].sort());
    for (const name of ["append_to_chapter", "overwrite_chapter", "create_chapter", "read_chapter", "delete_chapter"]) {
      if (name === "read_chapter") continue;
      expect(model.doStreamCalls[0]?.tools?.some((tool) => tool.name === name)).toBe(false);
    }
    expect((await library.readChapter(bookId, chapterId)).content).toBe(before);
    expect(started.plan).toBeUndefined();
    if (terminal.type === "done") expect(terminal.changed).toBe(0);

    const thread = await library.threads.read(bookId, started.threadId);
    expect(thread?.messages).toHaveLength(2);
    const user = thread?.messages[0];
    expect(user?.parts).toContainEqual({ type: "guidance", text: GUIDANCE });
    const assistant = thread?.messages[1];
    expect(assistant).toMatchObject({ role: "assistant", mode: "edit" });
    expect(assistant?.turnId).toBeTruthy();
    expect(assistant?.parts.some((part) => part.type === "tool-call" && part.name === "propose_plan"))
      .toBe(true);
    expect(messageText(assistant!)).toContain("ready for your review");

    expect(thread?.plans).toHaveLength(1);
    const plan = thread!.plans[0]!;
    expect(plan).toMatchObject({
      mode: "edit",
      status: "proposed",
      purpose: PURPOSE,
      revision: 1,
      parent: { messageId: assistant!.id, turnId: assistant!.turnId }
    });
    expect(plan.steps.map((entry) => entry.text)).toEqual(STEPS);
    expect(plan.steps.map((entry) => entry.state)).toEqual(["pending", "pending"]);
    expect(plan.guidance).toBeUndefined();
    expect(plan.startedAt).toBeUndefined();
    expect(plan.terminalAt).toBeUndefined();
    expect(thread?.checkpointTurns).toEqual([]);

    const notices = events.filter((event) => event.type === "plan");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      type: "plan",
      planId: plan.id,
      revision: 1,
      status: "proposed",
      change: "proposed"
    });
    expect(notices[0]!.type === "plan" ? notices[0]!.planId : null).toMatch(/^plan_/);
    const proposalIndex = events.findIndex((event) => event.type === "plan");
    const doneIndex = events.findIndex((event) => event.type === "done");
    expect(proposalIndex).toBeLessThan(doneIndex);

    const reloaded = await library.threads.read(bookId, started.threadId);
    expect(reloaded?.plans.map((entry) => entry.id)).toEqual([plan.id]);
  });

  test("a missing propose_plan ends in error with no plan and keeps the assistant message", async () => {
    const model = modelFor([replyStream("I forgot to propose a plan.")]);
    const { runtime, events } = runtimeFor(model);
    const { started, terminal } = await runProposal(runtime);
    expect(terminal.type).toBe("error");
    if (terminal.type === "error") expect(terminal.code).toBe("plan-state");
    const thread = await library.threads.read(bookId, started.threadId);
    expect(thread?.plans).toEqual([]);
    expect(thread?.messages).toHaveLength(2);
    expect(events.some((event) => event.type === "plan")).toBe(false);
  });

  test("an invalid propose_plan ends in error with no plan", async () => {
    const model = modelFor([
      toolStream([{ name: "propose_plan", input: { purpose: "", steps: [] } }]),
      replyStream("The proposal was refused.")
    ]);
    const { runtime, events } = runtimeFor(model);
    const { started, terminal } = await runProposal(runtime);
    expect(terminal.type).toBe("error");
    const thread = await library.threads.read(bookId, started.threadId);
    expect(thread?.plans).toEqual([]);
    expect(events.some((event) => event.type === "plan")).toBe(false);
  });

  test("an unfinished plan refuses before the provider and writes no user message", async () => {
    const threadId = await seedLivePlan();
    const before = (await library.threads.read(bookId, threadId))!;
    const model = modelFor([replyStream()]);
    const { runtime, factoryCalls } = runtimeFor(model);
    let error: unknown;
    try {
      await runProposal(runtime, { threadId });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AgentTurnRefusedError);
    expect((error as AgentTurnRefusedError).refusal).toBe("plan-state");
    expect((error as Error).message).toBe("Finish or cancel the current plan before proposing another.");
    expect(providerReads).toBe(0);
    expect(factoryCalls()).toBe(0);
    expect(model.doStreamCalls).toHaveLength(0);
    const after = await library.threads.read(bookId, threadId);
    expect(after?.messages).toHaveLength(before.messages.length);
    expect(after?.plans).toHaveLength(1);
  });

  test("a failed addPlan leaves the assistant message, no plan and no proposed notice", async () => {
    const model = modelFor([
      toolStream([{ name: "propose_plan", input: { purpose: PURPOSE, steps: STEPS } }]),
      replyStream()
    ]);
    const { runtime, events } = runtimeFor(model);
    const store = library.threads;
    const original = store.addPlan;
    store.addPlan = async () => {
      throw new ThreadStoreError("io", "Synthetic plan write failure.");
    };
    try {
      const { started, terminal } = await runProposal(runtime);
      expect(terminal.type).toBe("error");
      if (terminal.type === "error") expect(terminal.message).toContain("Synthetic plan write failure");
      const thread = await library.threads.read(bookId, started.threadId);
      expect(thread?.plans).toEqual([]);
      expect(thread?.messages).toHaveLength(2);
      expect(events.some((event) => event.type === "plan")).toBe(false);
    } finally {
      store.addPlan = original;
    }
  });
});

describe("proposal pre-flight", () => {
  test("refuses a proposal in Discuss and a proposal combined with a plan reference", async () => {
    const { runtime, factoryCalls } = runtimeFor(modelFor([]));
    for (const [input, refusal] of [
      [{ bookId, mode: "discuss", prompt: "Propose", planProposal: true }, "plan-in-discuss"],
      [{
        bookId,
        mode: "edit",
        prompt: "Propose",
        threadId: "thread_absent1",
        planProposal: true,
        plan: { id: "plan-1", revision: 1, action: "start" }
      }, "invalid-plan"]
    ] as const) {
      let error: unknown;
      try {
        await runtime.start(input as AgentTurnInput);
      } catch (caught) {
        error = caught;
      }
      expect((error as AgentTurnRefusedError).refusal).toBe(refusal);
    }
    expect(providerReads).toBe(0);
    expect(factoryCalls()).toBe(0);
    expect(await library.threads.list(bookId)).toEqual([]);
  });
});
