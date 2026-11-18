import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentEvent } from "@ai-book-studio/core/agent";
import {
  agentMessageSchema,
  type AgentMessage,
  type AgentPlan,
  type AgentPlanStatus
} from "@ai-book-studio/core/agent/messages";
import type { AgentPlanEvent } from "@ai-book-studio/core/agent/plan-state";
import { ThreadStoreError } from "@ai-book-studio/core/agent/threads";
import type { ProviderService } from "../src/main/providers";
import type { Studio } from "../src/main/studio";
import { Library } from "../src/main/library/store";
import { AgentRuntime } from "../src/main/agent/runtime";

/*
 * T012's plan-record refresh, driven through the real runtime and a temporary library. The model
 * is a stub that must never be asked to stream: the refresh is a plan write, not a turn.
 */

let root: string;
let library: Library;
let bookId: string;
let chapterId: string;
let chapterPath: string;
let bookPath: string;
let providerReads: { credential: number; models: number };

const PLAN_ID = "plan-1";
const PLAN_PARENT_ID = "msg_plan0001";
const PLAN_TURN_ID = "turn_plan0001";
const PLAN_PURPOSE = "Revise the opening scene";
const PLAN_STEPS = ["Read the opening", "Rewrite the door"];
const STALE = "The plan changed since you opened its guidance. Review the current revision before saving.";
const NOT_PROPOSED = "Only a proposed plan can receive guidance. Nothing was changed.";
const NOT_HERE = "That plan is not in this conversation. Nothing was changed.";
const NO_CONVERSATION = "That conversation no longer exists. Nothing was changed.";
const OVER_BOUND = "Shorten guidance to 2,000 characters. Your text is kept.";
const UNCONFIRMED = "The guidance change could not be confirmed. The last confirmed proposal is unchanged.";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-plan-guidance-refresh-"));
  library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic plan guidance" });
  bookId = book.id;
  const chapter = await library.createChapter(bookId, {
    title: "Light",
    content: "A synthetic lantern shone.\n"
  });
  chapterId = chapter.id;
  chapterPath = join(root, "books", bookId, "chapters", chapter.path);
  bookPath = join(root, "books", bookId, "book.json");
  await library.updateBook(bookId, {
    defaultConnectionId: "conn_synthetic",
    defaultModelId: "synthetic-model"
  });
  providerReads = { credential: 0, models: 0 };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runtimeFor(model = new MockLanguageModelV4({ doStream: [] })) {
  const events: AgentEvent[] = [];
  let factoryCalls = 0;
  const runtime = new AgentRuntime(
    { library, requireLibrary: () => library } as unknown as Studio,
    {
      credential: async () => {
        providerReads.credential += 1;
        return {
          id: "conn_synthetic",
          provider: "openrouter",
          label: "Synthetic",
          kind: "api-key",
          secret: "synthetic-only"
        };
      },
      models: async () => {
        providerReads.models += 1;
        return {
          models: [{
            id: "synthetic-model",
            name: "Synthetic model",
            supportsTools: true,
            supportsImages: false,
            contextLength: 10000
          }]
        };
      }
    } as unknown as ProviderService,
    (event) => events.push(event),
    () => {
      factoryCalls += 1;
      return model;
    },
    () => {}
  );
  return { runtime, events, factoryCalls: () => factoryCalls, model };
}

async function errorOf(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the refresh to be refused");
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
            approvalId: "approval-old",
            turnId: PLAN_TURN_ID,
            name: "delete_chapter",
            input: { chapterId },
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
  id?: string;
  guidance?: string;
  withApproval?: boolean;
} = {}): Promise<string> {
  const thread = await library.threads.create(bookId, "Plan conversation");
  await library.threads.appendMessage(bookId, thread.id, planParent(options.withApproval === true));
  await library.threads.addPlan(bookId, thread.id, {
    id: options.id ?? PLAN_ID,
    purpose: PLAN_PURPOSE,
    steps: PLAN_STEPS,
    parent: { messageId: PLAN_PARENT_ID, turnId: PLAN_TURN_ID },
    ...(options.guidance !== undefined ? { guidance: options.guidance } : {})
  });
  return thread.id;
}

async function movePlan(threadId: string, event: AgentPlanEvent, planId = PLAN_ID): Promise<void> {
  await library.threads.applyPlanEvent(bookId, threadId, planId, event);
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

async function bytesOf(threadId: string): Promise<string> {
  return readFile(join(root, "books", bookId, "threads", `${threadId}.json`), "utf8");
}

async function storedPlanOf(threadId: string, planId = PLAN_ID): Promise<AgentPlan | null> {
  return (await library.threads.read(bookId, threadId))?.plans.find((plan) => plan.id === planId) ?? null;
}

function captureWrites(): Array<{ revision: number; guidance?: string }> {
  const written: Array<{ revision: number; guidance?: string }> = [];
  const original = library.threads.refreshPlanProposal.bind(library.threads);
  library.threads.refreshPlanProposal = async (targetBook, targetThread, targetPlan, input) => {
    written.push({ ...input });
    return original(targetBook, targetThread, targetPlan, input);
  };
  return written;
}

describe("plan guidance refresh runtime", () => {
  test("R1: a proposed plan stores its next revision and keeps every other field", async () => {
    const { runtime, events, factoryCalls, model } = runtimeFor();
    const threadId = await seedPlan({ guidance: "Keep the lantern." });
    const beforeThread = await library.threads.read(bookId, threadId);
    if (!beforeThread) throw new Error("missing seeded thread");
    const beforePlan = beforeThread.plans[0];
    if (!beforePlan) throw new Error("missing seeded plan");
    const beforeChapter = await readFile(chapterPath, "utf8");
    const beforeBook = await readFile(bookPath, "utf8");
    const writes = captureWrites();
    const start = spyOn(runtime, "start");

    const confirmed = await runtime.refreshPlanGuidance(
      bookId,
      threadId,
      PLAN_ID,
      1,
      "Past tense."
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ revision: 2, guidance: "Past tense." });
    expect(confirmed).toEqual(expect.objectContaining({
      id: PLAN_ID,
      mode: "edit",
      status: "proposed",
      revision: 2,
      guidance: "Past tense.",
      purpose: beforePlan.purpose,
      steps: beforePlan.steps,
      parent: beforePlan.parent,
      createdAt: beforePlan.createdAt
    }));
    expect(confirmed.startedAt).toBeUndefined();
    expect(confirmed.terminalAt).toBeUndefined();
    expect(await storedPlanOf(threadId)).toEqual(confirmed);

    const afterThread = await library.threads.read(bookId, threadId);
    if (!afterThread) throw new Error("missing refreshed thread");
    expect(afterThread.messages).toEqual(beforeThread.messages);
    expect(afterThread.checkpointTurns).toEqual(beforeThread.checkpointTurns);
    expect(afterThread.messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "approval")).toEqual(
      beforeThread.messages.flatMap((message) => message.parts)
        .filter((part) => part.type === "approval")
    );

    expect(factoryCalls()).toBe(0);
    expect(providerReads).toEqual({ credential: 0, models: 0 });
    expect(model.doStreamCalls).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(await readFile(chapterPath, "utf8")).toBe(beforeChapter);
    expect(await readFile(bookPath, "utf8")).toBe(beforeBook);
  });

  test("R2: blank, whitespace-only and 2,000-whitespace values clear without a blank string", async () => {
    const { runtime } = runtimeFor();
    const threadId = await seedPlan({ guidance: "Keep the names." });
    const writes = captureWrites();

    const blank = await runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 1, "");
    expect(blank.revision).toBe(2);
    expect(blank.guidance).toBeUndefined();

    const whitespace = await runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 2, "  \n\t ");
    expect(whitespace.revision).toBe(3);
    expect(whitespace.guidance).toBeUndefined();

    const longWhitespace = " ".repeat(2_000);
    const wide = await runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 3, longWhitespace);
    expect(wide.revision).toBe(4);
    expect(wide.guidance).toBeUndefined();

    expect(writes).toEqual([{ revision: 2 }, { revision: 3 }, { revision: 4 }]);
    expect(writes.every((entry) => entry.guidance === undefined)).toBe(true);
    const stored = await storedPlanOf(threadId);
    expect(stored?.revision).toBe(4);
    expect(stored?.guidance).toBeUndefined();
  });

  test("R3: 2,000 characters are stored exactly and 2,001 are refused without truncation", async () => {
    const { runtime } = runtimeFor();
    const threadId = await seedPlan();
    const exact = "x".repeat(2_000);

    const accepted = await runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 1, exact);
    expect(accepted.revision).toBe(2);
    expect(accepted.guidance).toBe(exact);
    expect(accepted.guidance?.length).toBe(2_000);

    const before = await bytesOf(threadId);
    const refused = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 2, "y".repeat(2_001))
    );
    expect(refused.message).toBe(OVER_BOUND);
    expect(await bytesOf(threadId)).toBe(before);

    const stored = await storedPlanOf(threadId);
    expect(stored?.revision).toBe(2);
    expect(stored?.guidance).toBe(exact);
    expect(stored?.guidance).not.toContain("y");
  });

  test("R4: every non-proposed status is refused and writes nothing", async () => {
    const { runtime } = runtimeFor();
    const statuses: AgentPlanStatus[] = [
      "running",
      "waiting-for-approval",
      "pause-requested",
      "paused",
      "completed",
      "cancelled",
      "failed",
      "expired"
    ];
    for (const status of statuses) {
      const threadId = await threadWithStatus(status);
      const before = await bytesOf(threadId);
      const refused = await errorOf(
        runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 1, "New guidance.")
      );
      expect({ status, message: refused.message }).toEqual({ status, message: NOT_PROPOSED });
      expect(await bytesOf(threadId)).toBe(before);
      expect((await storedPlanOf(threadId))?.guidance).toBeUndefined();
    }
  });

  test("R5: one increment per call; a stale base and a skipped revision are refused", async () => {
    const { runtime } = runtimeFor();
    const threadId = await seedPlan();

    const first = await runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 1, "First.");
    expect(first.revision).toBe(2);

    const stale = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 1, "Second.")
    );
    expect(stale.message).toBe(STALE);

    const second = await runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 2, "Second.");
    expect(second.revision).toBe(3);

    const skipped = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 4, "Skip.")
    );
    expect(skipped.message).toBe(STALE);
    const repeated = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 2, "Repeat.")
    );
    expect(repeated.message).toBe(STALE);

    const stored = await storedPlanOf(threadId);
    expect(stored?.revision).toBe(3);
    expect(stored?.guidance).toBe("Second.");
  });

  test("R6: a missing plan, a foreign plan and a missing conversation are refused", async () => {
    const { runtime } = runtimeFor();
    const threadId = await seedPlan();
    const otherThreadId = await seedPlan({ id: "plan-2" });
    const before = await bytesOf(threadId);
    const otherBefore = await bytesOf(otherThreadId);

    const missing = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, "plan-missing", 1, "Text.")
    );
    expect(missing.message).toBe(NOT_HERE);

    const foreign = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, "plan-2", 1, "Text.")
    );
    expect(foreign.message).toBe(NOT_HERE);

    const noConversation = await errorOf(
      runtime.refreshPlanGuidance(bookId, "thread_absent0001", PLAN_ID, 1, "Text.")
    );
    expect(noConversation.message).toBe(NO_CONVERSATION);

    expect(await bytesOf(threadId)).toBe(before);
    expect(await bytesOf(otherThreadId)).toBe(otherBefore);
    expect((await storedPlanOf(threadId))?.revision).toBe(1);
    expect((await storedPlanOf(otherThreadId, "plan-2"))?.revision).toBe(1);
  });

  test("R7: store conflict, IO and a plan-state race surface the stored truth", async () => {
    const { runtime } = runtimeFor();
    const threadId = await seedPlan({ guidance: "Keep the names." });
    const conflictSentence =
      "That conversation changed since it was read. Your version was kept as a copy; nothing was overwritten.";
    const ioSentence = "The conversation could not be written. Nothing was changed.";
    const original = library.threads.refreshPlanProposal.bind(library.threads);
    const before = await bytesOf(threadId);

    library.threads.refreshPlanProposal = async () => {
      throw new ThreadStoreError("conflict", conflictSentence);
    };
    const conflict = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 1, "Past tense.")
    );
    expect(conflict.message).toBe(conflictSentence);
    expect(await bytesOf(threadId)).toBe(before);
    expect((await storedPlanOf(threadId))?.revision).toBe(1);

    library.threads.refreshPlanProposal = async () => {
      throw new ThreadStoreError("io", ioSentence);
    };
    const io = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 1, "Past tense.")
    );
    expect(io.message).toBe(ioSentence);
    expect((await storedPlanOf(threadId))?.revision).toBe(1);
    expect((await storedPlanOf(threadId))?.guidance).toBe("Keep the names.");

    // A competing refresh wins between the read and the write. The runtime names the winner with
    // its one classification read and never retries the requested value.
    let raced = false;
    library.threads.refreshPlanProposal = async (targetBook, targetThread, targetPlan, input) => {
      if (!raced) {
        raced = true;
        await original(targetBook, targetThread, targetPlan, { revision: 2, guidance: "Winner." });
        throw new ThreadStoreError(
          "plan-state",
          "The plan changed since this update was prepared. Nothing was written."
        );
      }
      return original(targetBook, targetThread, targetPlan, input);
    };
    const race = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 1, "Loser.")
    );
    expect(race.message).toBe(STALE);
    const winner = await storedPlanOf(threadId);
    expect(winner?.revision).toBe(2);
    expect(winner?.guidance).toBe("Winner.");
  });

  test("R8: no model, tool, book write, checkpoint, approval or event", async () => {
    const { runtime, events, factoryCalls, model } = runtimeFor();
    const threadId = await seedPlan({ withApproval: true });
    const beforeThread = await library.threads.read(bookId, threadId);
    if (!beforeThread) throw new Error("missing seeded thread");
    const beforeChapter = await readFile(chapterPath, "utf8");
    const beforeBook = await readFile(bookPath, "utf8");
    const start = spyOn(runtime, "start");

    const confirmed = await runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 1, "Past tense.");
    expect(confirmed.status).toBe("proposed");

    expect(factoryCalls()).toBe(0);
    expect(providerReads).toEqual({ credential: 0, models: 0 });
    expect(model.doStreamCalls).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(await readFile(chapterPath, "utf8")).toBe(beforeChapter);
    expect(await readFile(bookPath, "utf8")).toBe(beforeBook);

    const afterThread = await library.threads.read(bookId, threadId);
    if (!afterThread) throw new Error("missing refreshed thread");
    expect(afterThread.messages).toEqual(beforeThread.messages);
    expect(afterThread.checkpointTurns).toEqual(beforeThread.checkpointTurns);
    expect(afterThread.messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "approval")).toEqual(
      beforeThread.messages.flatMap((message) => message.parts)
        .filter((part) => part.type === "approval")
    );
    expect(afterThread.plans).toHaveLength(1);
    expect(afterThread.plans[0]?.revision).toBe(2);
    expect(afterThread.plans[0]?.guidance).toBe("Past tense.");
  });

  test("R9: only the confirmed stored plan is returned; a mismatched return is refused", async () => {
    const { runtime } = runtimeFor();
    const threadId = await seedPlan();
    const confirmed = await runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 1, "Past tense.");
    const storedConfirmed = await storedPlanOf(threadId);
    if (!storedConfirmed) throw new Error("missing stored plan");
    expect(confirmed).toEqual(storedConfirmed);

    const stored = await library.threads.read(bookId, threadId);
    if (!stored) throw new Error("missing refreshed thread");
    library.threads.refreshPlanProposal = async () => ({
      ...stored,
      plans: stored.plans.map((plan) =>
        plan.id === PLAN_ID ? { ...plan, revision: 3, guidance: "Substituted." } : plan
      )
    });
    const mismatch = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 2, "Requested.")
    );
    expect(mismatch.message).toBe(UNCONFIRMED);

    library.threads.refreshPlanProposal = async () => ({ ...stored, plans: [] });
    const absent = await errorOf(
      runtime.refreshPlanGuidance(bookId, threadId, PLAN_ID, 2, "Requested.")
    );
    expect(absent.message).toBe(UNCONFIRMED);

    const storedAgain = await storedPlanOf(threadId);
    expect(storedAgain?.revision).toBe(2);
    expect(storedAgain?.guidance).toBe("Past tense.");
  });
});
