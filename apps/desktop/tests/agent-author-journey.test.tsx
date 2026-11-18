/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadableStream, TransformStream, WritableStream } from "node:stream/web";
import React from "react";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentEvent, AgentTurnInput } from "@ai-book-studio/core/agent";
import type { AgentPlan, AgentThread } from "@ai-book-studio/core/agent/messages";
import type { ProviderService } from "../src/main/providers";
import type { Studio } from "../src/main/studio";
import { Library } from "../src/main/library/store";
import { AgentRuntime } from "../src/main/agent/runtime";
import { DISCUSS_NEXT_STEP } from "../src/main/agent/mode";
import { READ_TOOL_NAMES } from "../src/main/agent/tools";
import { mountDom, unmountDom } from "./support/dom";

/*
 * One synthetic author journey through the real chat panel, the real AgentRuntime and a temporary
 * Library. Only the provider-shaped model and the preload/IPC hop are synthetic: the bridge calls
 * the production runtime, and every file fact is read from the production store.
 */

let testing!: typeof import("@testing-library/react/pure");
let ChatPanel!: typeof import("@ai-book-studio/app/components/ChatPanel").ChatPanel;

beforeAll(async () => {
  testing = await mountDom();
  // The model streams are scripted with the AI SDK, which pipes native web streams. Happy DOM
  // registers its own constructors; the journey keeps Node's so the production runtime and the
  // SDK see one stream implementation, while the panel still renders in the DOM.
  Object.assign(globalThis, { ReadableStream, TransformStream, WritableStream });
  ({ ChatPanel } = await import("@ai-book-studio/app/components/ChatPanel"));
});
afterAll(async () => {
  await unmountDom();
});

const BOOK_TITLE = "Synthetic author journey";
const CHAPTER_TITLE = "Light";
const BASELINE = "A synthetic lantern shone.\n";
const PLAN_PURPOSE = "Revise the lantern scene";
const PLAN_STEPS = [
  "Read the current opening",
  "Add the lantern passage",
  "Replace the final scene"
] as const;
const DISCUSS_PROMPT = "Rewrite the opening and change the ending.";
const DISCUSS_WRITE = "This must never reach the page.\n";
const DISCUSS_REPLY = "I can't change the book in Discuss. Send a new turn in Edit mode to request changes.";
const EDIT_PROMPT = "Add a second light.";
const EDIT_APPEND = "A second light crossed the room.";
const EDIT_REPLY = "Added the second light.";
const PLAN_APPEND = "The lantern stayed lit.";
const DESTRUCTIVE_CONTENT = "A rewritten final scene replaced the author's words.\n";
const PROPOSAL_REPLY = "The plan is ready for your review.";
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined }
};

let callId = 0;

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

function replyStream(text: string) {
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

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "error";
    return { code, message: error.message };
  }
  return { code: "error", message: String(error) };
}

async function wrap<T>(
  run: () => Promise<T>
): Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

interface JourneyAgent {
  start(input: AgentTurnInput): Promise<unknown>;
  stop(turnId: string): Promise<unknown>;
  cancelPlan(input: { bookId: string; threadId: string; planId: string }): Promise<unknown>;
  approve(turnId: string, approvalId: string, approved: boolean): Promise<unknown>;
  undoLast(bookId: string, turnId?: string): Promise<unknown>;
  threads: {
    list(bookId: string): Promise<unknown>;
    read(bookId: string, threadId: string): Promise<unknown>;
    rename(bookId: string, threadId: string, title: string): Promise<unknown>;
    remove(bookId: string, threadId: string): Promise<unknown>;
    fork(bookId: string, threadId: string, turnId: string): Promise<unknown>;
  };
  onEvent(listener: (event: AgentEvent) => void): () => void;
}

interface RuntimeWiring {
  readonly runtime: AgentRuntime;
  readonly delivered: AgentEvent[];
  readonly factoryCalls: () => number;
  readonly subscribe: (listener: (event: AgentEvent) => void) => () => void;
}

/**
 * The runtime over one library and one scripted model. `emit` records the event immediately and
 * delivers it on a later task, standing in for the asynchronous preload hop: no event can reach
 * the panel before `agent.start` resolved and the panel recorded the acknowledged turn id.
 */
function createRuntime(library: Library, model: MockLanguageModelV4): RuntimeWiring {
  const delivered: AgentEvent[] = [];
  const listeners = new Set<(event: AgentEvent) => void>();
  let factoryCalls = 0;
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
    (event) => {
      delivered.push(event);
      setTimeout(() => {
        for (const listener of [...listeners]) listener(event);
      }, 0);
    },
    () => {
      factoryCalls += 1;
      return model;
    },
    () => {}
  );
  return {
    runtime,
    delivered,
    factoryCalls: () => factoryCalls,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

interface JourneyBridge {
  readonly agent: JourneyAgent;
  readonly starts: AgentTurnInput[];
  readonly turns: string[];
  readonly cancelPlanInputs: Array<{ bookId: string; threadId: string; planId: string }>;
  readonly cancelPlanCalls: () => number;
}

function createBridge(library: Library, wiring: RuntimeWiring): JourneyBridge {
  const starts: AgentTurnInput[] = [];
  const turns: string[] = [];
  const cancelPlanInputs: Array<{ bookId: string; threadId: string; planId: string }> = [];
  let cancelPlanCalls = 0;
  const agent: JourneyAgent = {
    start: async (input) => {
      starts.push(structuredClone(input));
      try {
        const data = await wiring.runtime.start(input);
        turns.push(data.turnId);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: failure(error) };
      }
    },
    stop: async (turnId) => wrap(() => wiring.runtime.stop(turnId)),
    cancelPlan: async (input) => {
      cancelPlanCalls += 1;
      cancelPlanInputs.push({ ...input });
      return wrap(() => wiring.runtime.cancelPlan(input.bookId, input.threadId, input.planId));
    },
    approve: async (turnId, approvalId, approved) =>
      wrap(() => wiring.runtime.approve(turnId, approvalId, approved)),
    undoLast: async (bookId, turnId) => wrap(() => wiring.runtime.undoLast(bookId, turnId)),
    threads: {
      list: async (bookId) => wrap(() => library.threads.list(bookId)),
      read: async (bookId, threadId) => wrap(() => wiring.runtime.readThread(bookId, threadId)),
      rename: async () => ({ ok: true, data: null }),
      remove: async () => ({ ok: true, data: null }),
      fork: async () => ({ ok: true, data: null })
    },
    onEvent: (listener) => wiring.subscribe(listener)
  };
  return { agent, starts, turns, cancelPlanInputs, cancelPlanCalls: () => cancelPlanCalls };
}

async function createJourney(script: (chapterId: string) => StreamEntry[]) {
  const root = await mkdtemp(join(tmpdir(), "studio-author-journey-"));
  const library = await Library.open(root);
  const book = await library.createBook({ title: BOOK_TITLE });
  const chapter = await library.createChapter(book.id, { title: CHAPTER_TITLE, content: BASELINE });
  await library.updateBook(book.id, {
    defaultConnectionId: "conn_synthetic",
    defaultModelId: "synthetic-model"
  });
  const model = new MockLanguageModelV4({ doStream: script(chapter.id) });
  const wiring = createRuntime(library, model);
  const bridge = createBridge(library, wiring);
  return {
    root,
    library,
    model,
    runtime: wiring.runtime,
    bookId: book.id,
    chapterId: chapter.id,
    delivered: wiring.delivered,
    factoryCalls: wiring.factoryCalls,
    ...bridge,
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

type Journey = Awaited<ReturnType<typeof createJourney>>;
type View = ReturnType<typeof testing.within>;

function mountChat(journey: Journey) {
  (window as unknown as { studio: unknown }).studio = {
    platform: "linux",
    agent: journey.agent
  };
  const rendered = testing.render(
    React.createElement(ChatPanel, {
      bookId: journey.bookId,
      chapterId: journey.chapterId,
      onClose: () => {},
      onBeforeSend: async () => {},
      onChanged: () => {},
      onReconnect: () => {},
      onChooseModel: () => {},
      onChooseTurnModel: () => {},
      turnModel: null,
      onTurnModelUsed: () => {},
      onNotice: () => {}
    })
  );
  return { view: testing.within(document.body), unmount: rendered.unmount };
}

async function send(
  journey: Journey,
  view: View,
  mode: "discuss" | "edit",
  text: string
): Promise<void> {
  const expectedStarts = journey.starts.length + 1;
  testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: mode } });
  const input = view.getByTestId("chat-input");
  testing.fireEvent.change(input, { target: { value: text } });
  await testing.act(async () => {
    testing.fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await testing.waitFor(() => {
    if (journey.starts.length !== expectedStarts) throw new Error("The turn was not sent.");
  }, { timeout: 5_000 });
  await testing.waitFor(() => {
    if (view.queryByTestId("chat-stop") === null) throw new Error("The turn is not running.");
  }, { timeout: 5_000 });
  await testing.waitFor(() => {
    const mode = view.getByTestId("agent-mode") as HTMLSelectElement;
    if (view.queryByTestId("chat-stop") !== null || mode.disabled) {
      throw new Error("The turn has not finished.");
    }
  }, { timeout: 5_000 });
}

async function storedThread(library: Library, bookId: string, threadId: string): Promise<AgentThread> {
  const thread = await library.threads.read(bookId, threadId);
  if (!thread) throw new Error("The journey's conversation is missing.");
  return thread;
}

async function storedPlan(library: Library, bookId: string, threadId: string): Promise<AgentPlan> {
  const plan = (await storedThread(library, bookId, threadId)).plans.at(-1);
  if (!plan) throw new Error("The journey's plan is missing.");
  return plan;
}

function assertOneModelChooser(view: View): void {
  expect(view.getAllByTestId("agent-turn-model")).toHaveLength(1);
}

function assertNoGenericCards(view: View): void {
  expect(view.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(view.queryByRole("button", { name: "Reject" })).toBeNull();
  expect(view.queryByText(/^Apply$/)).toBeNull();
  expect(view.queryByText(/^Reject$/)).toBeNull();
  const region = view.queryByTestId("plan-region");
  if (!region) return;
  const card = testing.within(region);
  for (const name of ["Apply", "Reject", "Allow", "Deny"]) {
    expect(card.queryByRole("button", { name })).toBeNull();
  }
  expect(card.queryByTestId("agent-approve")).toBeNull();
  expect(card.queryByTestId("agent-deny")).toBeNull();
  expect(card.queryByTestId("agent-approval")).toBeNull();
  expect(card.queryByRole("button", { name: /model/i })).toBeNull();
}

describe("synthetic author journey (T020)", () => {
  test("Discuss writes nothing, Edit writes and undoes, a plan proposes and starts, approval waits, cancel keeps partial work, and the stored outcome reads back", async () => {
    callId = 0;
    const journey = await createJourney((chapterId) => [
      toolStream([{ name: "overwrite_chapter", input: { chapterId, content: DISCUSS_WRITE } }]),
      replyStream(DISCUSS_REPLY),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: EDIT_APPEND } }]),
      replyStream(EDIT_REPLY),
      toolStream([{
        name: "propose_plan",
        input: { purpose: PLAN_PURPOSE, steps: [...PLAN_STEPS] }
      }]),
      replyStream(PROPOSAL_REPLY),
      toolStream([{ name: "plan_step", input: { step: 1 } }]),
      toolStream([{ name: "read_chapter", input: { chapterId } }]),
      toolStream([{ name: "plan_step", input: { step: 2 } }]),
      toolStream([{ name: "append_to_chapter", input: { chapterId, text: PLAN_APPEND } }]),
      toolStream([{ name: "plan_step", input: { step: 3 } }]),
      toolStream([{
        name: "overwrite_chapter",
        input: { chapterId, content: DESTRUCTIVE_CONTENT }
      }])
    ]);
    let close: (() => void) | null = null;
    try {
      const before = await journey.library.readChapter(journey.bookId, journey.chapterId);
      const chapterPath = join(journey.root, "books", journey.bookId, "chapters", before.path);
      const bookPath = join(journey.root, "books", journey.bookId, "book.json");
      const chapterBytes = await readFile(chapterPath, "utf8");
      const bookBytes = await readFile(bookPath, "utf8");

      // Phase 0: the Discuss default and one model control.
      const chat = mountChat(journey);
      close = chat.unmount;
      const view = chat.view;
      await testing.waitFor(() => {
        if (view.queryByTestId("agent-mode") === null) throw new Error("The panel did not mount.");
      }, { timeout: 5_000 });
      expect(view.getByTestId("agent-mode")).toHaveProperty("value", "discuss");
      expect(view.queryByTestId("plan-first")).toBeNull();
      expect(view.queryByTestId("plan-region")).toBeNull();
      assertOneModelChooser(view);
      assertNoGenericCards(view);
      expect(view.getByText("Read-only. Send a new turn in Edit mode to request changes.")).toBeTruthy();
      expect(view.queryAllByTestId("plan-card")).toHaveLength(0);

      // Phase 1: Discuss refuses the scripted write and changes no file.
      await send(journey, view, "discuss", DISCUSS_PROMPT);
      expect(view.getByText(DISCUSS_REPLY)).toBeTruthy();
      const refusedRow = view.getByText("Asked to replace a chapter");
      expect(refusedRow.closest('[data-slot="trace-line"]')?.getAttribute("data-status")).toBe("error");
      expect(view.getByTestId("agent-mode")).toHaveProperty("value", "discuss");
      expect(view.queryByTestId("plan-first")).toBeNull();
      expect(view.queryByTestId("plan-region")).toBeNull();
      assertOneModelChooser(view);
      assertNoGenericCards(view);
      expect(view.queryAllByTestId("plan-card")).toHaveLength(0);

      const discussOffered = journey.model.doStreamCalls[0]?.tools?.map((tool) => tool.name).sort() ?? [];
      expect(discussOffered).toEqual([...READ_TOOL_NAMES].sort());
      for (const withheld of ["overwrite_chapter", "append_to_chapter", "propose_plan", "plan_step"]) {
        expect(discussOffered).not.toContain(withheld);
      }

      const discussTurn = journey.turns[0];
      if (!discussTurn) throw new Error("The Discuss turn did not start.");
      const discussEvents = journey.delivered.filter((event) => event.turnId === discussTurn);
      const refusal = discussEvents.find(
        (event) => event.type === "tool" && event.name === "overwrite_chapter" && event.status === "end"
      );
      expect(refusal?.type === "tool" ? refusal.detail : null).toBe(DISCUSS_NEXT_STEP);
      expect(discussEvents.some((event) => event.type === "approval")).toBe(false);
      expect(discussEvents.some((event) => event.type === "plan" || event.type === "plan-step")).toBe(false);
      const discussDone = discussEvents.find((event) => event.type === "done");
      // undoAvailable reports that a checkpoint was saved, not that a change exists. The
      // no-change guarantee is the empty checkpoint list and the unchanged bytes below.
      expect(discussDone?.type === "done" ? {
        changed: discussDone.changed,
        undoAvailable: discussDone.undoAvailable
      } : null).toEqual({ changed: 0, undoAvailable: true });
      expect(view.queryByTestId("agent-undo-turn")).toBeNull();

      const afterDiscuss = await journey.library.readChapter(journey.bookId, journey.chapterId);
      expect(afterDiscuss.content).toBe(before.content);
      expect(afterDiscuss.hash).toBe(before.hash);
      expect(await readFile(chapterPath, "utf8")).toBe(chapterBytes);
      expect(await readFile(bookPath, "utf8")).toBe(bookBytes);

      const firstThreadId = (await journey.library.threads.list(journey.bookId))[0]?.id;
      if (!firstThreadId) throw new Error("The Discuss turn stored no conversation.");
      const discussThread = await storedThread(journey.library, journey.bookId, firstThreadId);
      expect(discussThread.messages).toHaveLength(2);
      expect(discussThread.messages.map((message) => message.mode)).toEqual(["discuss", "discuss"]);
      expect(discussThread.plans).toEqual([]);
      expect(discussThread.checkpointTurns).toEqual([]);
      expect(discussThread.messages.flatMap((message) => message.parts).some((part) => part.type === "approval"))
        .toBe(false);
      const refusedResult = discussThread.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool-result" && part.name === "overwrite_chapter");
      expect(refusedResult?.type === "tool-result" ? refusedResult.isError : null).toBe(true);
      expect(refusedResult?.type === "tool-result" ? refusedResult.output : null).toMatchObject({
        ok: false,
        message: DISCUSS_NEXT_STEP
      });
      expect(afterDiscuss.content).not.toContain(DISCUSS_WRITE);
      expect(chapterBytes).not.toContain(DISCUSS_WRITE);

      // Phase 2: a new Edit turn writes once, offers one-turn undo, and the undo restores the chapter content.
      testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
      await testing.waitFor(() => {
        if (view.queryByTestId("plan-first") === null) throw new Error("Plan first is not mounted.");
      }, { timeout: 5_000 });
      expect(view.getByText(
        "Changes use checked saves and turn undo. Destructive actions still ask for approval."
      )).toBeTruthy();
      assertOneModelChooser(view);
      await send(journey, view, "edit", EDIT_PROMPT);
      await testing.waitFor(() => {
        if (view.queryByTestId("agent-undo-turn") === null) throw new Error("Undo is not offered.");
      }, { timeout: 5_000 });

      const editTurn = journey.turns[1];
      if (!editTurn) throw new Error("The Edit turn did not start.");
      const editRequest = journey.starts[1];
      expect(editRequest).toMatchObject({ mode: "edit", threadId: firstThreadId });
      expect(editRequest).not.toHaveProperty("plan");
      const ordinaryEditCall = journey.model.doStreamCalls.find((call) =>
        call.tools?.some((tool) => tool.name === "append_to_chapter") &&
        !call.tools?.some((tool) => tool.name === "plan_step")
      );
      expect(ordinaryEditCall?.tools?.map((tool) => tool.name)).toContain("append_to_chapter");
      expect(ordinaryEditCall?.tools?.map((tool) => tool.name)).not.toContain("plan_step");

      const editEvents = journey.delivered.filter((event) => event.turnId === editTurn);
      const editDone = editEvents.find((event) => event.type === "done");
      expect(editDone?.type === "done" ? {
        changed: editDone.changed,
        undoAvailable: editDone.undoAvailable
      } : null).toEqual({ changed: 1, undoAvailable: true });
      const afterEdit = await journey.library.readChapter(journey.bookId, journey.chapterId);
      expect(afterEdit.content).toContain(EDIT_APPEND);
      expect(afterEdit.hash).not.toBe(before.hash);
      const editThread = await storedThread(journey.library, journey.bookId, firstThreadId);
      expect(editThread.messages.slice(-2).map((message) => message.mode)).toEqual(["edit", "edit"]);
      expect(editThread.checkpointTurns).toEqual([editTurn]);
      expect(editThread.plans).toEqual([]);
      expect(editThread.messages.flatMap((message) => message.parts).some((part) => part.type === "approval"))
        .toBe(false);
      expect(view.queryByTestId("plan-region")).toBeNull();
      assertOneModelChooser(view);
      assertNoGenericCards(view);
      expect(view.queryAllByTestId("plan-card")).toHaveLength(0);

      await testing.act(async () => {
        testing.fireEvent.click(view.getByTestId("agent-undo-turn"));
      });
      await testing.waitFor(() => {
        if (view.queryByTestId("agent-undo-turn") !== null) throw new Error("Undo is still offered.");
      }, { timeout: 5_000 });
      const undone = await journey.library.readChapter(journey.bookId, journey.chapterId);
      // Undo restores the content through a normal checked write, so the save counter and
      // updatedAt advance; the raw file hash is expected to differ from the pre-turn file.
      expect(undone.content).toBe(before.content);
      const undoneThread = await storedThread(journey.library, journey.bookId, firstThreadId);
      expect(undoneThread.checkpointTurns).toEqual([]);
      expect(undoneThread.messages.slice(-2).map((message) => message.mode)).toEqual(["edit", "edit"]);

      // Phase 3: Ask for plan is one read-only Edit proposal; nothing is written before Start.
      testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
      await testing.waitFor(() => {
        if (view.queryByTestId("plan-first") === null) throw new Error("Plan first is not mounted.");
      }, { timeout: 5_000 });
      const planForm = testing.within(view.getByTestId("plan-first"));
      expect(planForm.getByTestId("plan-turn-model").tagName).toBe("P");
      testing.fireEvent.change(planForm.getByTestId("plan-purpose"), { target: { value: PLAN_PURPOSE } });
      const firstStep = planForm.getAllByTestId("plan-step")[0];
      if (!firstStep) throw new Error("The plan form had no first step.");
      testing.fireEvent.change(firstStep, { target: { value: PLAN_STEPS[0] } });
      testing.fireEvent.click(planForm.getByRole("button", { name: "Add step" }));
      const secondStep = planForm.getAllByTestId("plan-step")[1];
      if (!secondStep) throw new Error("The plan form did not add a second step.");
      testing.fireEvent.change(secondStep, { target: { value: PLAN_STEPS[1] } });
      testing.fireEvent.click(planForm.getByRole("button", { name: "Add step" }));
      const thirdStep = planForm.getAllByTestId("plan-step")[2];
      if (!thirdStep) throw new Error("The plan form did not add a third step.");
      testing.fireEvent.change(thirdStep, { target: { value: PLAN_STEPS[2] } });
      expect(planForm.getByTestId("plan-propose").textContent).toBe("Ask for plan");
      expect(planForm.getByTestId("plan-propose")).toHaveProperty("disabled", false);

      await testing.act(async () => {
        testing.fireEvent.click(planForm.getByTestId("plan-propose"));
      });
      await testing.waitFor(() => {
        if (view.queryByTestId("plan-region") === null) throw new Error("The plan region is not shown.");
      }, { timeout: 5_000 });
      await testing.waitFor(() => {
        const region = view.queryByTestId("plan-region");
        if (region === null || testing.within(region).queryByTestId("plan-start") === null) {
          throw new Error("Start is not offered.");
        }
      }, { timeout: 5_000 });

      const proposalRequest = journey.starts[2];
      expect(proposalRequest).toMatchObject({
        mode: "edit",
        planProposal: true,
        threadId: firstThreadId
      });
      expect(proposalRequest).not.toHaveProperty("plan");
      expect(proposalRequest).not.toHaveProperty("guidance");
      expect(proposalRequest).not.toHaveProperty("model");
      const proposalPrompt = String(proposalRequest?.prompt);
      expect(proposalPrompt).toContain(PLAN_PURPOSE);
      expect(proposalPrompt).toContain("Steps to consider:");
      for (const step of PLAN_STEPS) expect(proposalPrompt).toContain(step);
      const proposalCall = journey.model.doStreamCalls.find((call) =>
        call.tools?.some((tool) => tool.name === "propose_plan")
      );
      expect(proposalCall?.tools?.map((tool) => tool.name).sort())
        .toEqual([...READ_TOOL_NAMES, "propose_plan"].sort());

      const proposedChapter = await journey.library.readChapter(journey.bookId, journey.chapterId);
      expect(proposedChapter.content).toBe(before.content);
      expect(proposedChapter.hash).toBe(undone.hash);
      const proposedThread = await storedThread(journey.library, journey.bookId, firstThreadId);
      const proposed = await storedPlan(journey.library, journey.bookId, firstThreadId);
      expect(proposedThread.plans).toHaveLength(1);
      expect(proposed).toMatchObject({
        purpose: PLAN_PURPOSE,
        mode: "edit",
        status: "proposed",
        revision: 1
      });
      expect(proposed.steps.map((step) => [step.text, step.state])).toEqual(
        PLAN_STEPS.map((text) => [text, "pending"])
      );
      expect(proposed.startedAt).toBeUndefined();
      expect(proposed.terminalAt).toBeUndefined();
      expect(proposed.guidance).toBeUndefined();
      expect(proposedThread.checkpointTurns).toEqual([]);
      const proposalMessage = proposedThread.messages.at(-1);
      if (!proposalMessage) throw new Error("The proposal message was not stored.");
      if (!proposalMessage.turnId) throw new Error("The proposal message has no turn id.");
      expect(proposalMessage.role).toBe("assistant");
      expect(proposalMessage.mode).toBe("edit");
      expect(proposed.parent.messageId).toBe(proposalMessage.id);
      expect(proposed.parent.turnId).toBe(proposalMessage.turnId);

      expect(view.getByTestId("agent-mode")).toHaveProperty("value", "discuss");
      expect(view.queryByTestId("plan-first")).toBeNull();
      const proposedRegion = view.getByTestId("plan-region");
      expect(view.getAllByTestId("plan-card")).toHaveLength(1);
      const proposedCard = testing.within(proposedRegion);
      expect(proposedCard.getByTestId("plan-status").textContent).toBe("Proposed");
      expect(proposedCard.getByTestId("plan-revision").textContent).toBe("Revision 1 · Edit plan");
      expect(proposedCard.getByTestId("plan-model").textContent).toBe("Model: book default");
      expect(proposedCard.getByTestId("plan-model").tagName).toBe("P");
      expect(proposedCard.getByTestId("plan-purpose-text").textContent).toBe(PLAN_PURPOSE);
      expect(proposedCard.getAllByTestId("plan-step-text").map((node) => node.textContent)).toEqual([
        ...PLAN_STEPS
      ]);
      expect(proposedCard.getAllByTestId("plan-step-state").map((node) => node.textContent)).toEqual([
        "Pending",
        "Pending",
        "Pending"
      ]);
      expect(proposedCard.getByTestId("plan-guidance-omitted").textContent).toBe("No plan guidance");
      expect(proposedCard.getByTestId("plan-start")).toBeTruthy();
      expect(proposedCard.getByTestId("plan-cancel")).toBeTruthy();
      expect(proposedCard.queryByTestId("plan-pause")).toBeNull();
      expect(proposedCard.queryByTestId("plan-resume")).toBeNull();
      assertOneModelChooser(view);
      assertNoGenericCards(view);

      // Phase 4: Start is one explicit Edit turn with observed step progress.
      await testing.act(async () => {
        testing.fireEvent.click(proposedCard.getByTestId("plan-start"));
      });
      await testing.waitFor(() => {
        expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent)
          .toBe("Running");
      }, { timeout: 5_000, interval: 1 });
      await testing.waitFor(() => {
        expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent)
          .toBe("Waiting for approval");
      }, { timeout: 5_000, interval: 1 });
      await testing.waitFor(() => {
        if (view.queryByTestId("agent-approval") === null) throw new Error("The approval is not shown.");
      }, { timeout: 5_000 });

      const startTurn = journey.turns[3];
      if (!startTurn) throw new Error("The Start turn did not start.");
      const startRequest = journey.starts[3];
      expect(startRequest).toMatchObject({
        mode: "edit",
        threadId: firstThreadId,
        prompt: "Start the reviewed plan.",
        plan: { id: proposed.id, revision: 1, action: "start" }
      });
      expect(startRequest).not.toHaveProperty("guidance");
      expect(startRequest).not.toHaveProperty("planProposal");
      expect(startRequest).not.toHaveProperty("model");
      const startCall = journey.model.doStreamCalls.find((call) =>
        call.tools?.some((tool) => tool.name === "plan_step")
      );
      const startTools = startCall?.tools?.map((tool) => tool.name) ?? [];
      expect(startTools).toContain("plan_step");
      expect(startTools).toContain("append_to_chapter");
      expect(startTools).toContain("overwrite_chapter");
      expect(view.queryByText("plan_step")).toBeNull();
      expect(view.queryByText("propose_plan")).toBeNull();

      const startEvents = journey.delivered.filter((event) => event.turnId === startTurn);
      const stepNotices = startEvents
        .filter((event): event is Extract<AgentEvent, { type: "plan-step" }> => event.type === "plan-step")
        .map((event) => `${event.index}:${event.state}`);
      expect(stepNotices).toEqual([
        "0:in-progress",
        "0:completed",
        "1:in-progress",
        "1:completed",
        "2:in-progress"
      ]);
      const planChanges = startEvents
        .filter((event): event is Extract<AgentEvent, { type: "plan" }> => event.type === "plan")
        .map((event) => event.change);
      expect(planChanges[0]).toBe("request-approval");
      expect(planChanges).not.toContain("proposed");
      expect(planChanges).not.toContain("complete");

      const waitingCard = testing.within(view.getByTestId("plan-region"));
      expect(waitingCard.getByTestId("plan-status").textContent).toBe("Waiting for approval");
      expect(waitingCard.getAllByTestId("plan-step-state").map((node) => node.textContent)).toEqual([
        "Completed",
        "Completed",
        "In progress"
      ]);
      expect(waitingCard.getByTestId("plan-pause")).toBeTruthy();
      expect(waitingCard.getByTestId("plan-cancel")).toBeTruthy();
      expect(waitingCard.queryByTestId("plan-start")).toBeNull();
      expect(waitingCard.queryByTestId("plan-resume")).toBeNull();
      expect(view.getByTestId("chat-stop")).toBeTruthy();
      assertOneModelChooser(view);
      assertNoGenericCards(view);

      const waitingPlan = await storedPlan(journey.library, journey.bookId, firstThreadId);
      expect(waitingPlan.status).toBe("waiting-for-approval");
      expect(waitingPlan.steps.map((step) => step.state)).toEqual([
        "completed",
        "completed",
        "in-progress"
      ]);
      const waitingChapter = await journey.library.readChapter(journey.bookId, journey.chapterId);
      expect(waitingChapter.content).toContain(PLAN_APPEND);
      expect(waitingChapter.content).not.toContain(DESTRUCTIVE_CONTENT);
      expect(waitingChapter.hash).not.toBe(before.hash);
      const waitingThread = await storedThread(journey.library, journey.bookId, firstThreadId);
      const waitingMessage = waitingThread.messages.find(
        (message) => message.role === "assistant" && message.turnId === startTurn
      );
      if (!waitingMessage) throw new Error("The Start turn stored no assistant message.");
      expect(waitingMessage.parts.some(
        (part) => part.type === "tool-result" && part.name === "overwrite_chapter"
      )).toBe(false);
      expect(waitingMessage.parts.find((part) => part.type === "approval")).toMatchObject({
        type: "approval",
        name: "overwrite_chapter",
        status: "pending",
        turnId: startTurn
      });

      // Phase 5: the plan card cannot answer the approval; the existing 002 card is the only answer.
      expect(waitingCard.getAllByRole("button").map((button) => button.textContent).sort()).toEqual([
        "Cancel plan",
        "Pause plan"
      ]);
      expect(waitingCard.queryByRole("button", { name: "Allow" })).toBeNull();
      expect(waitingCard.queryByRole("button", { name: "Deny" })).toBeNull();
      expect(waitingCard.getByText(/Cancel does not allow or deny any action\./)).toBeTruthy();
      expect(view.getByTestId("plan-region").contains(view.getByTestId("agent-approval"))).toBe(false);
      expect(view.getAllByTestId("agent-approval")).toHaveLength(1);
      const approvalCard = testing.within(view.getByTestId("agent-approval"));
      expect(approvalCard.getByText("Replace a chapter's text?")).toBeTruthy();
      expect(approvalCard.getByText(
        "The agent will wait for your answer before changing anything."
      )).toBeTruthy();
      expect(approvalCard.getByRole("button", { name: "Allow" })).toBeTruthy();
      expect(approvalCard.getByRole("button", { name: "Deny" })).toBeTruthy();
      const approvalEvent = startEvents.find(
        (event): event is Extract<AgentEvent, { type: "approval" }> => event.type === "approval"
      );
      expect(approvalEvent).toMatchObject({
        name: "overwrite_chapter",
        planId: proposed.id,
        planRevision: 1
      });
      expect(waitingChapter.content).not.toContain(DESTRUCTIVE_CONTENT);
      expect(waitingMessage.parts.some(
        (part) => part.type === "tool-result" && part.name === "overwrite_chapter"
      )).toBe(false);
      expect(view.queryByTestId("plan-first")).toBeNull();
      expect(view.getAllByTestId("plan-card")).toHaveLength(1);
      expect(journey.model.doStreamCalls).toHaveLength(12);

      // Phase 6: Cancel keeps the partial write, stops later work, and expires the approval.
      await testing.act(async () => {
        testing.fireEvent.click(waitingCard.getByTestId("plan-cancel"));
      });
      await testing.waitFor(() => {
        if (waitingCard.queryByTestId("plan-cancel-confirmation") === null) {
          throw new Error("Cancel did not ask for confirmation.");
        }
      }, { timeout: 5_000 });
      const confirmation = testing.within(waitingCard.getByTestId("plan-cancel-confirmation"));
      expect(confirmation.getByText(
        "Cancel this plan? Completed edits stay; Cancel does not undo them."
      )).toBeTruthy();
      expect(confirmation.getByTestId("plan-cancel-confirm").textContent).toBe("Yes, cancel plan");
      expect(confirmation.getByTestId("plan-cancel-keep").textContent).toBe("Keep plan");
      expect(journey.cancelPlanCalls()).toBe(0);

      await testing.act(async () => {
        testing.fireEvent.click(waitingCard.getByTestId("plan-cancel-confirm"));
      });
      expect(journey.cancelPlanCalls()).toBe(1);
      expect(journey.cancelPlanInputs[0]).toEqual({
        bookId: journey.bookId,
        threadId: firstThreadId,
        planId: proposed.id
      });
      await testing.waitFor(() => {
        expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent)
          .toBe("Cancelled · 2 of 3 steps completed · 1 chapter changed · undo available");
      }, { timeout: 5_000, interval: 5 });

      const cancelledCard = testing.within(view.getByTestId("plan-region"));
      expect(cancelledCard.getAllByTestId("plan-step-state").map((node) => node.textContent)).toEqual([
        "Completed",
        "Completed",
        "Not completed"
      ]);
      expect(cancelledCard.getByTestId("plan-cancel-note").textContent)
        .toBe("Completed steps stay. Cancel does not undo them.");
      expect(testing.within(view.getByTestId("agent-approval")).getByText("Expired")).toBeTruthy();
      expect(view.queryByTestId("agent-approve")).toBeNull();
      expect(view.queryByTestId("agent-deny")).toBeNull();
      expect(view.getByTestId("agent-undo-turn")).toBeTruthy();
      expect(cancelledCard.queryByTestId("plan-start")).toBeNull();
      expect(cancelledCard.queryByTestId("plan-pause")).toBeNull();
      expect(cancelledCard.queryByTestId("plan-resume")).toBeNull();
      expect(cancelledCard.queryByTestId("plan-cancel")).toBeNull();
      assertOneModelChooser(view);
      assertNoGenericCards(view);
      expect(view.getAllByTestId("plan-card")).toHaveLength(1);
      expect(journey.model.doStreamCalls).toHaveLength(12);

      const stoppingIndex = journey.delivered.findIndex(
        (event) => event.type === "stopping" && event.turnId === startTurn
      );
      const cancelIndex = journey.delivered.findIndex(
        (event) => event.type === "plan" && event.change === "cancel" && event.turnId === startTurn
      );
      const stoppedIndex = journey.delivered.findIndex(
        (event) => event.type === "stopped" && event.turnId === startTurn
      );
      expect(stoppingIndex).toBeGreaterThanOrEqual(0);
      expect(cancelIndex).toBeGreaterThan(stoppingIndex);
      expect(stoppedIndex).toBeGreaterThan(cancelIndex);
      const afterStop = journey.delivered.slice(stoppingIndex + 1);
      expect(afterStop.some((event) => event.type === "tool" && event.status === "start")).toBe(false);
      expect(afterStop.some((event) => event.type === "approval")).toBe(false);
      const stoppedEvent = journey.delivered[stoppedIndex];
      expect(stoppedEvent?.type === "stopped" ? {
        changed: stoppedEvent.changed,
        undoAvailable: stoppedEvent.undoAvailable
      } : null).toEqual({ changed: 1, undoAvailable: true });

      const cancelledPlan = await storedPlan(journey.library, journey.bookId, firstThreadId);
      expect(cancelledPlan.status).toBe("cancelled");
      expect(cancelledPlan.terminalAt).toBeTruthy();
      expect(cancelledPlan.steps.map((step) => step.state)).toEqual([
        "completed",
        "completed",
        "not-completed"
      ]);
      const cancelledThread = await storedThread(journey.library, journey.bookId, firstThreadId);
      const cancelledApproval = cancelledThread.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "approval" && part.name === "overwrite_chapter");
      expect(cancelledApproval?.type === "approval" ? cancelledApproval.status : null).toBe("expired");
      expect(cancelledThread.messages.flatMap((message) => message.parts).some(
        (part) => part.type === "approval" && (part.status === "approved" || part.status === "denied")
      )).toBe(false);
      expect(cancelledThread.checkpointTurns).toEqual([startTurn]);
      expect(cancelledThread.checkpointTurns).not.toContain(editTurn);
      const cancelledChapter = await journey.library.readChapter(journey.bookId, journey.chapterId);
      expect(cancelledChapter.content).toContain(PLAN_APPEND);
      expect(cancelledChapter.content).not.toContain(DESTRUCTIVE_CONTENT);
      expect(cancelledChapter.hash).not.toBe(before.hash);
      const bookAfterCancel = await readFile(bookPath, "utf8");
      expect(bookAfterCancel).not.toContain(proposed.id);
      const overwriteResults = cancelledThread.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool-result" && part.name === "overwrite_chapter");
      expect(overwriteResults).toHaveLength(1);
      expect(overwriteResults[0]).toMatchObject({ isError: true });
      expect(cancelledThread.messages.find(
        (message) => message.role === "assistant" && message.turnId === startTurn
      )?.parts.some((part) => part.type === "tool-result" && part.name === "overwrite_chapter")).toBe(false);

      // Phase 7: the stored outcome survives a new library read and a new runtime with no replay.
      chat.unmount();
      close = null;
      const reopened = await Library.open(journey.root);
      const secondWiring = createRuntime(reopened, journey.model);
      const second = createBridge(reopened, secondWiring);
      const secondRead = await secondWiring.runtime.readThread(journey.bookId, firstThreadId);
      expect(secondRead.planRuntime).toBeNull();
      expect(secondRead.expiry).toBeUndefined();
      expect(secondWiring.factoryCalls()).toBe(0);
      expect(second.starts).toEqual([]);
      expect(secondWiring.delivered).toEqual([]);

      const secondChat = mountChat({ ...journey, agent: second.agent });
      close = secondChat.unmount;
      const secondView = secondChat.view;
      await testing.waitFor(() => {
        if (secondView.queryAllByTestId("plan-card").length !== 1) {
          throw new Error("The stored plan card is not shown once.");
        }
      }, { timeout: 5_000 });
      const reopenedRegion = testing.within(secondView.getByTestId("plan-region"));
      expect(reopenedRegion.getByTestId("plan-status").textContent)
        .toBe("Cancelled · 2 of 3 steps completed");
      expect(reopenedRegion.getAllByTestId("plan-step-state").map((node) => node.textContent)).toEqual([
        "Completed",
        "Completed",
        "Not completed"
      ]);
      expect(reopenedRegion.getByTestId("plan-cancel-note")).toBeTruthy();
      expect(reopenedRegion.queryByTestId("plan-start")).toBeNull();
      expect(reopenedRegion.queryByTestId("plan-pause")).toBeNull();
      expect(reopenedRegion.queryByTestId("plan-resume")).toBeNull();
      expect(reopenedRegion.queryByTestId("plan-cancel")).toBeNull();
      expect(secondView.getByTestId("agent-undo-turn").textContent).toBe("Undo this turn");
      expect(testing.within(secondView.getByTestId("agent-approval")).getByText("Expired")).toBeTruthy();
      expect(secondView.queryByTestId("agent-approve")).toBeNull();
      expect(secondView.queryByTestId("agent-deny")).toBeNull();
      expect(secondView.getAllByTestId("agent-message-mode").map((node) => node.textContent)).toEqual([
        "Discuss",
        "Discuss",
        "Edit",
        "Edit",
        "Edit",
        "Edit",
        "Edit",
        "Edit"
      ]);
      assertOneModelChooser(secondView);
      assertNoGenericCards(secondView);
      expect(secondView.getAllByTestId("plan-card")).toHaveLength(1);
      expect(secondView.queryByText("plan_step")).toBeNull();
      expect(secondView.queryByText("propose_plan")).toBeNull();
      expect(document.body.textContent).not.toContain(proposed.id);

      const reopenedThread = await storedThread(reopened, journey.bookId, firstThreadId);
      const reopenedPlan = reopenedThread.plans.at(-1);
      expect(reopenedPlan).toEqual(cancelledPlan);
      expect(reopenedThread.checkpointTurns).toEqual(cancelledThread.checkpointTurns);
      expect(reopenedThread.messages.flatMap((message) => message.parts).find(
        (part) => part.type === "approval" && part.name === "overwrite_chapter"
      )).toMatchObject({ status: "expired" });
      const reopenedChapter = await reopened.readChapter(journey.bookId, journey.chapterId);
      expect(reopenedChapter.content).toBe(cancelledChapter.content);
      expect(reopenedChapter.hash).toBe(cancelledChapter.hash);
      expect(secondWiring.factoryCalls()).toBe(0);
      expect(second.starts).toEqual([]);
      expect(secondWiring.delivered).toEqual([]);
    } finally {
      close?.();
      await journey.cleanup();
    }
  }, 20_000);
});
