/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import {
  AGENT_PLAN_LIMITS,
  agentThreadSchema,
  type AgentMode,
  type AgentPlan,
  type AgentThread
} from "@ai-book-studio/core/agent/messages";
import type { AgentEvent } from "@ai-book-studio/core/agent";

let testing!: typeof import("@testing-library/react/pure");
let PlanFirstControl!: typeof import("@ai-book-studio/app/components/PlanFirstControl").PlanFirstControl;
let ChatPanel!: typeof import("@ai-book-studio/app/components/ChatPanel").ChatPanel;

beforeAll(async () => {
  testing = await mountDom();
  ({ PlanFirstControl } = await import("@ai-book-studio/app/components/PlanFirstControl"));
  ({ ChatPanel } = await import("@ai-book-studio/app/components/ChatPanel"));
});
afterAll(async () => {
  await unmountDom();
});
afterEach(() => testing.cleanup());

/**
 * Plan first asks the agent for one proposal, then reviews the stored plan. Start is a separate
 * explicit turn. These tests read only what the author sees plus stable test ids; no writer is
 * passed and no plan is fabricated locally.
 */

const AT = "2026-01-01T00:00:00.000Z";
const BOOK = "book_plan000001";
const CHAPTER = "ch_plan000001";
const THREAD = "thread_plan000001";
const PLAN_ID = "plan_plan000001";
const PROPOSAL_TURN = "turn_plan000001";
const START_TURN = "turn_start000001";

type CapturedTurn = { prompt?: unknown; [key: string]: unknown };

function makePlan(options: {
  status?: AgentPlan["status"];
  revision?: number;
  guidance?: string | null;
  steps?: AgentPlan["steps"];
} = {}): AgentPlan {
  const status = options.status ?? "proposed";
  const terminal = status === "completed" || status === "cancelled" || status === "failed" || status === "expired";
  const started = status !== "proposed";
  return {
    id: PLAN_ID,
    mode: "edit",
    status,
    purpose: "Revise the opening chapter",
    steps: options.steps ?? [
      { text: "Read the current opening", state: "pending" },
      { text: "Revise the door scene", state: "pending" }
    ],
    revision: options.revision ?? 3,
    ...(options.guidance === null
      ? {}
      : { guidance: options.guidance ?? "Keep the names" }),
    parent: { messageId: "msg_plan000002", turnId: PROPOSAL_TURN },
    createdAt: AT,
    updatedAt: AT,
    ...(started ? { startedAt: AT } : {}),
    ...(terminal ? { terminalAt: AT } : {})
  };
}

function planThread(plan: AgentPlan | null): AgentThread {
  return agentThreadSchema.parse({
    schemaVersion: 1,
    id: THREAD,
    bookId: BOOK,
    title: "A plan conversation",
    createdAt: AT,
    updatedAt: AT,
    messages: [
      {
        id: "msg_plan000001",
        role: "user",
        parts: [{ type: "text", text: "Propose a plan for the opening chapter." }],
        mode: "edit",
        createdAt: AT
      },
      {
        id: "msg_plan000002",
        role: "assistant",
        parts: [
          { type: "text", text: "Here is the plan." },
          { type: "tool-call", id: "call_plan000001", name: "propose_plan", input: {} },
          { type: "tool-result", id: "call_plan000001", name: "propose_plan", output: { ok: true } }
        ],
        mode: "edit",
        turnId: PROPOSAL_TURN,
        createdAt: AT
      }
    ],
    plans: plan ? [plan] : [],
    checkpointTurns: []
  });
}

function countingOnPropose(result: { ok: boolean; reason?: string } = { ok: true }) {
  return mock(async (_request: unknown) => result);
}

function countingOnStart(result: { ok: boolean; reason?: string } = { ok: true }) {
  return mock(async (_ref: unknown) => result);
}

function countingOnPause() {
  return mock((_event?: unknown) => {});
}

function countingOnResume(result: { ok: boolean; reason?: string } = { ok: true }) {
  return mock(async (_ref: unknown) => result);
}

function renderPlan(options: {
  mode?: AgentMode;
  running?: boolean;
  proposing?: boolean;
  plan?: AgentPlan | null;
  notice?: string | null;
  live?: boolean;
  stopping?: boolean;
  resuming?: boolean;
  pauseSummary?: { changed: number; undoAvailable?: boolean } | null;
  onPropose?: ReturnType<typeof countingOnPropose>;
  onStart?: ReturnType<typeof countingOnStart>;
  onPause?: ReturnType<typeof countingOnPause>;
  onResume?: ReturnType<typeof countingOnResume>;
} = {}) {
  const onPropose = options.onPropose ?? countingOnPropose();
  const onStart = options.onStart ?? countingOnStart();
  const onPause = options.onPause ?? countingOnPause();
  const onResume = options.onResume ?? countingOnResume();
  const props = {
    mode: options.mode ?? "edit" as AgentMode,
    running: options.running ?? false,
    proposing: options.proposing ?? false,
    plan: options.plan ?? null,
    modelLabel: "Model: book default",
    onPropose,
    onStart,
    onPause,
    onResume,
    live: options.live ?? false,
    stopping: options.stopping ?? false,
    resuming: options.resuming ?? false,
    ...(options.notice !== undefined ? { notice: options.notice } : {}),
    ...(options.pauseSummary !== undefined ? { pauseSummary: options.pauseSummary } : {})
  };
  const view = testing.render(React.createElement(PlanFirstControl, props));
  return {
    ...view,
    onPropose,
    onStart,
    onPause,
    onResume,
    rerenderWith(next: Partial<typeof props>) {
      view.rerender(React.createElement(PlanFirstControl, { ...props, ...next }));
    }
  };
}

function cardOf(view: { container: HTMLElement }) {
  return testing.within(testing.within(view.container).getByTestId("plan-current"));
}

function fillPlan(
  view: ReturnType<typeof testing.within>,
  request: string,
  steps: readonly string[],
  guidance?: string
): void {
  testing.fireEvent.change(view.getByTestId("plan-purpose"), { target: { value: request } });
  const first = view.getAllByTestId("plan-step")[0];
  if (!first) throw new Error("missing step");
  testing.fireEvent.change(first, { target: { value: steps[0] ?? "" } });
  for (let index = 1; index < steps.length; index += 1) {
    testing.fireEvent.click(view.getByRole("button", { name: "Add step" }));
    const field = view.getAllByTestId("plan-step")[index];
    if (!field) throw new Error("missing added step");
    testing.fireEvent.change(field, { target: { value: steps[index] ?? "" } });
  }
  if (guidance !== undefined) {
    testing.fireEvent.change(view.getByTestId("plan-guidance"), { target: { value: guidance } });
  }
}

function renderChat(options: {
  thread?: AgentThread;
  start?: ReturnType<typeof mock>;
} = {}) {
  let stored = options.thread ?? planThread(null);
  let emit: ((event: AgentEvent) => void) | null = null;
  const start = options.start ?? mock(async (_request: CapturedTurn) => ({
    ok: true,
    data: { turnId: START_TURN, threadId: THREAD, mode: "edit" }
  }));
  const stop = mock(async (_turnId: string) => ({ ok: true, data: null }));
  const read = mock(async () => ({ ok: true, data: stored }));
  const listed = [
    {
      id: THREAD,
      title: stored.title,
      createdAt: AT,
      updatedAt: AT,
      messageCount: stored.messages.length,
      preview: ""
    }
  ];
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    agent: {
      threads: {
        list: mock(async () => ({ ok: true, data: listed })),
        read,
        fork: mock(async () => ({ ok: true, data: stored })),
        remove: mock(async () => ({ ok: true, data: null })),
        rename: mock(async () => ({ ok: true, data: null }))
      },
      start,
      stop,
      approve: mock(async () => ({ ok: true, data: null })),
      undoLast: mock(async () => ({ ok: true, data: null })),
      onEvent: mock((handler: (event: AgentEvent) => void) => {
        emit = handler;
        return () => {
          emit = null;
        };
      })
    }
  };
  testing.render(React.createElement(ChatPanel, {
    bookId: BOOK,
    chapterId: CHAPTER,
    onClose: () => {},
    onBeforeSend: async () => {},
    onChanged: () => {},
    onReconnect: () => {},
    onChooseModel: () => {},
    onChooseTurnModel: () => {},
    turnModel: null,
    onTurnModelUsed: () => {},
    onNotice: () => {}
  }));
  return {
    start,
    stop,
    read,
    view: testing.within(document.body),
    setStored(next: AgentThread) {
      stored = next;
    },
    fire(event: AgentEvent) {
      emit?.(event);
    }
  };
}

describe("plan first control", () => {
  test("asks for a proposal with the request, suggestions and one-turn guidance", async () => {
    const onPropose = countingOnPropose();
    renderPlan({ onPropose });
    const view = testing.within(document.body);
    fillPlan(view, "Revise the opening chapter", ["Read the opening", "Revise the door scene"], "Keep the names");

    expect(view.queryByTestId("plan-current")).toBeNull();
    expect(view.queryByTestId("plan-start")).toBeNull();
    expect(view.getByTestId("plan-propose").textContent).toBe("Ask for plan");
    expect(view.getByTestId("plan-purpose").getAttribute("aria-invalid")).toBe("false");

    await testing.act(async () => testing.fireEvent.click(view.getByTestId("plan-propose")));

    expect(onPropose).toHaveBeenCalledWith({
      request: "Revise the opening chapter",
      steps: ["Read the opening", "Revise the door scene"],
      guidance: "Keep the names"
    });
    expect(view.getByTestId("plan-purpose")).toHaveProperty("value", "Revise the opening chapter");
    expect(view.getByTestId("plan-guidance")).toHaveProperty("value", "Keep the names");
  });

  test("bounds the request fields without clearing the author's text", () => {
    const onPropose = countingOnPropose();
    const { onStart } = renderPlan({ onPropose });
    const view = testing.within(document.body);

    const longRequest = "r".repeat(AGENT_PLAN_LIMITS.purpose + 1);
    testing.fireEvent.change(view.getByTestId("plan-purpose"), { target: { value: longRequest } });
    expect(view.getByTestId("plan-purpose")).toHaveProperty("value", longRequest);
    expect(view.getByTestId("plan-purpose").getAttribute("aria-invalid")).toBe("true");
    expect(view.getByTestId("plan-propose")).toHaveProperty("disabled", true);
    expect(view.getByTestId("plan-refusal").textContent).toContain("Your text is kept");

    testing.fireEvent.change(view.getByTestId("plan-purpose"), { target: { value: "Revise the opening" } });
    const longStep = "s".repeat(AGENT_PLAN_LIMITS.stepText + 1);
    testing.fireEvent.change(view.getByTestId("plan-step"), { target: { value: longStep } });
    expect(view.getByTestId("plan-step")).toHaveProperty("value", longStep);
    expect(view.getByTestId("plan-propose")).toHaveProperty("disabled", true);

    testing.fireEvent.change(view.getByTestId("plan-step"), { target: { value: "Read the opening" } });
    const longGuidance = "g".repeat(AGENT_PLAN_LIMITS.guidance + 1);
    testing.fireEvent.change(view.getByTestId("plan-guidance"), { target: { value: longGuidance } });
    expect(view.getByTestId("plan-guidance")).toHaveProperty("value", longGuidance);
    expect(view.getByTestId("plan-guidance").getAttribute("aria-invalid")).toBe("true");
    expect(view.getByTestId("plan-propose")).toHaveProperty("disabled", true);
    expect(onPropose).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  test("disables the request while proposing and keeps the words on failure", async () => {
    let resolve: ((value: { ok: boolean; reason?: string }) => void) | null = null;
    const pending = new Promise<{ ok: boolean; reason?: string }>((done) => {
      resolve = done;
    });
    const onPropose = mock(() => pending);
    renderPlan({ onPropose });
    const view = testing.within(document.body);
    fillPlan(view, "Revise the opening chapter", ["Read the opening"]);

    testing.fireEvent.click(view.getByTestId("plan-propose"));
    expect(view.getByTestId("plan-proposing").textContent).toBe("Proposing a plan…");
    expect(view.getByTestId("plan-purpose")).toHaveProperty("disabled", true);
    expect(view.getByTestId("plan-step")).toHaveProperty("disabled", true);
    expect(view.getByTestId("plan-guidance")).toHaveProperty("disabled", true);
    expect(view.getByTestId("plan-propose")).toHaveProperty("disabled", true);

    await testing.act(async () => {
      resolve?.({ ok: false, reason: "The plan could not be proposed. Your request is kept." });
      await pending;
    });

    expect(view.getByTestId("plan-purpose")).toHaveProperty("value", "Revise the opening chapter");
    expect(view.getByTestId("plan-refusal").textContent).toBe("The plan could not be proposed. Your request is kept.");
    expect(view.queryByTestId("plan-current")).toBeNull();
  });

  test("shows the stored plan and sends the reviewed identity on Start", async () => {
    const plan = makePlan();
    const onStart = countingOnStart();
    renderPlan({ plan, onStart });
    const view = testing.within(document.body);
    const card = testing.within(view.getByTestId("plan-current"));

    expect(card.getByTestId("plan-status").textContent).toBe("Proposed");
    expect(card.getByTestId("plan-revision").textContent).toBe("Revision 3 · Edit plan");
    expect(card.getByTestId("plan-model").textContent).toBe("Model: book default");
    expect(card.getByTestId("plan-purpose-text").textContent).toBe("Revise the opening chapter");
    expect(card.getAllByTestId("plan-step-text").map((node) => node.textContent)).toEqual([
      "Read the current opening",
      "Revise the door scene"
    ]);
    expect(card.getByTestId("plan-guidance-text").textContent).toBe("Keep the names");
    expect(view.getByTestId("plan-first").textContent).not.toContain(plan.id);
    expect(view.getByTestId("plan-first").textContent).not.toContain(plan.parent.turnId);
    expect(view.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(view.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(view.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(view.queryByRole("button", { name: "Reject" })).toBeNull();

    await testing.act(async () => testing.fireEvent.click(card.getByTestId("plan-start")));

    expect(onStart).toHaveBeenCalledWith({ id: plan.id, revision: 3, action: "start" });
  });

  test("labels every confirmed step state and distinguishes running from approval wait", () => {
    const labels = makePlan({
      status: "running",
      steps: [
        { text: "Finished work", state: "completed" },
        { text: "Current work", state: "in-progress" },
        { text: "Later work", state: "pending" },
        { text: "Skipped work", state: "not-completed" }
      ]
    });
    const running = renderPlan({ plan: labels, running: true });
    const card = cardOf(running);
    expect(card.getAllByTestId("plan-step-state").map((node) => node.textContent)).toEqual([
      "Completed",
      "In progress",
      "Pending",
      "Not completed"
    ]);
    expect(card.getByTestId("plan-status").textContent).toBe("Running");
    expect(card.queryByTestId("plan-start")).toBeNull();

    running.rerenderWith({ plan: makePlan({ status: "waiting-for-approval", steps: labels.steps }) });
    const waiting = testing.within(testing.within(document.body).getByTestId("plan-current"));
    expect(waiting.getByTestId("plan-status").textContent).toBe("Waiting for approval");
    expect(waiting.queryByTestId("plan-start")).toBeNull();
    // A running or waiting plan never gains step progress without a confirmed notice.
    expect(waiting.getAllByTestId("plan-step-state").map((node) => node.textContent)).toEqual([
      "Completed",
      "In progress",
      "Pending",
      "Not completed"
    ]);
  });

  test("keeps a refused request and shows no local plan", async () => {
    const onPropose = countingOnPropose({ ok: false, reason: "The plan could not be proposed. Nothing was stored." });
    renderPlan({ onPropose });
    const view = testing.within(document.body);
    fillPlan(view, "Revise the opening chapter", ["Read the opening"], "Keep the names");

    await testing.act(async () => testing.fireEvent.click(view.getByTestId("plan-propose")));

    expect(view.getByTestId("plan-refusal").textContent).toBe("The plan could not be proposed. Nothing was stored.");
    expect(view.getByTestId("plan-purpose")).toHaveProperty("value", "Revise the opening chapter");
    expect(view.getByTestId("plan-step")).toHaveProperty("value", "Read the opening");
    expect(view.getByTestId("plan-guidance")).toHaveProperty("value", "Keep the names");
    expect(view.queryByTestId("plan-current")).toBeNull();
    expect(view.queryByTestId("plan-start")).toBeNull();
  });

  test("the composer asks for a proposal and only shows the stored plan afterwards", async () => {
    const start = mock(async (_request: CapturedTurn) => ({
      ok: true,
      data: { turnId: PROPOSAL_TURN, threadId: THREAD, mode: "edit" }
    }));
    const chat = renderChat({ thread: planThread(null), start });
    const view = chat.view;
    await view.findByTestId("chat-input");
    expect(view.queryByTestId("plan-first")).toBeNull();

    testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
    const plan = testing.within(view.getByTestId("plan-first"));
    expect(plan.getByTestId("plan-turn-model").textContent).toBe("Model: book default");
    fillPlan(plan, "Revise the opening chapter", ["Read the opening"], "Keep the names");
    expect(view.getByTestId("agent-guidance")).toHaveProperty("value", "");

    await testing.act(async () => testing.fireEvent.click(plan.getByTestId("plan-propose")));

    expect(start).toHaveBeenCalledTimes(1);
    const request = start.mock.calls[0]?.[0];
    if (!request) throw new Error("the proposal request was not sent");
    expect(request).toMatchObject({
      bookId: BOOK,
      threadId: THREAD,
      mode: "edit",
      planProposal: true,
      guidance: "Keep the names"
    });
    expect(request).not.toHaveProperty("plan");
    expect(String(request.prompt)).toContain("Revise the opening chapter");
    expect(String(request.prompt)).toContain("Steps to consider:");
    expect(String(request.prompt)).toContain("Read the opening");
    expect(view.getByTestId("agent-guidance")).toHaveProperty("value", "");
    expect(view.getByTestId("plan-purpose")).toHaveProperty("value", "Revise the opening chapter");
    expect(view.getByTestId("plan-proposing").textContent).toBe("Proposing a plan…");
    expect(view.getByTestId("agent-mode")).toHaveProperty("value", "edit");
    expect(view.queryByTestId("plan-region")).toBeNull();

    const storedPlan = makePlan();
    chat.setStored(planThread(storedPlan));
    await testing.act(async () => {
      chat.fire({
        type: "plan",
        turnId: PROPOSAL_TURN,
        planId: PLAN_ID,
        revision: 1,
        status: "proposed",
        change: "proposed"
      });
    });

    const region = await view.findByTestId("plan-region");
    const card = testing.within(region);
    expect(card.getByTestId("plan-purpose-text").textContent).toBe("Revise the opening chapter");
    expect(card.getByTestId("plan-status").textContent).toBe("Proposed");
    expect(view.getByTestId("agent-mode")).toHaveProperty("value", "discuss");
    expect(view.queryByTestId("plan-first")).toBeNull();
    expect(view.queryByText("propose_plan")).toBeNull();
    expect(view.queryByText("plan_step")).toBeNull();
    expect(document.body.textContent).not.toContain(PLAN_ID);
  });

  test("Start sends the fixed prompt and empty guidance, then waits for the acknowledgement", async () => {
    const plan = makePlan();
    const start = mock(async (_request: CapturedTurn) => ({
      ok: true,
      data: {
        turnId: START_TURN,
        threadId: THREAD,
        mode: "edit",
        plan: { id: PLAN_ID, revision: plan.revision, status: "running" }
      }
    }));
    const chat = renderChat({ thread: planThread(plan), start });
    const view = chat.view;
    const region = await view.findByTestId("plan-region");
    expect(testing.within(region).getByTestId("plan-status").textContent).toBe("Proposed");
    expect(testing.within(region).getAllByTestId("plan-step-state").map((node) => node.textContent))
      .toEqual(["Pending", "Pending"]);

    await testing.act(async () => testing.fireEvent.click(testing.within(region).getByTestId("plan-start")));

    expect(start).toHaveBeenCalledTimes(1);
    const request = start.mock.calls[0]?.[0];
    if (!request) throw new Error("the proposal request was not sent");
    expect(request).toMatchObject({
      bookId: BOOK,
      threadId: THREAD,
      mode: "edit",
      prompt: "Start the reviewed plan.",
      plan: { id: PLAN_ID, revision: plan.revision, action: "start" }
    });
    expect(request).not.toHaveProperty("guidance");
    expect(request).not.toHaveProperty("planProposal");

    await testing.waitFor(() => {
      expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent).toBe("Running");
    });
    expect(testing.within(view.getByTestId("plan-region")).queryByTestId("plan-start")).toBeNull();
    // The acknowledgement carries no step progress, so the steps stay Pending until a notice.
    expect(testing.within(view.getByTestId("plan-region")).getAllByTestId("plan-step-state")
      .map((node) => node.textContent)).toEqual(["Pending", "Pending"]);

    await testing.act(async () => {
      chat.fire({
        type: "plan-step",
        turnId: START_TURN,
        planId: PLAN_ID,
        revision: plan.revision,
        status: "running",
        index: 0,
        state: "in-progress"
      });
    });
    expect(testing.within(view.getByTestId("plan-region")).getAllByTestId("plan-step-state")
      .map((node) => node.textContent)).toEqual(["In progress", "Pending"]);

    await testing.act(async () => {
      chat.fire({
        type: "plan-step",
        turnId: START_TURN,
        planId: PLAN_ID,
        revision: plan.revision,
        status: "running",
        index: 0,
        state: "completed"
      });
      chat.fire({
        type: "plan-step",
        turnId: START_TURN,
        planId: PLAN_ID,
        revision: plan.revision,
        status: "running",
        index: 1,
        state: "not-completed"
      });
    });
    expect(testing.within(view.getByTestId("plan-region")).getAllByTestId("plan-step-state")
      .map((node) => node.textContent)).toEqual(["Completed", "Not completed"]);

    await testing.act(async () => {
      chat.fire({
        type: "plan-error",
        turnId: START_TURN,
        planId: PLAN_ID,
        revision: plan.revision,
        change: "step",
        message: "The plan's progress could not be saved. Nothing was marked complete."
      });
    });
    expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-notice").textContent)
      .toContain("Nothing was marked complete");
    expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent).toBe("Running");
  });

  test("a refused Start removes its optimistic rows and leaves the plan proposed", async () => {
    const plan = makePlan();
    const start = mock(async (_request: CapturedTurn) => ({
      ok: false as const,
      error: { code: "invalid-request", message: "That plan is not in this conversation. Nothing was started." }
    }));
    const chat = renderChat({ thread: planThread(plan), start });
    const view = chat.view;
    const region = await view.findByTestId("plan-region");

    await testing.act(async () => testing.fireEvent.click(testing.within(region).getByTestId("plan-start")));

    expect(start).toHaveBeenCalledTimes(1);
    expect(view.queryByText("Start the reviewed plan.")).toBeNull();
    const after = testing.within(view.getByTestId("plan-region"));
    expect(after.getByTestId("plan-status").textContent).toBe("Proposed");
    expect(after.getByTestId("plan-start")).toBeDefined();
    expect(after.getByTestId("plan-action-error").textContent).toContain("not in this conversation");
    expect(view.queryByText("Reading and thinking…")).toBeNull();
  });

  test("a new conversation starts without a stored plan region", async () => {
    const chat = renderChat({ thread: planThread(makePlan()) });
    const view = chat.view;
    await view.findByTestId("plan-region");

    testing.fireEvent.click(view.getByTestId("agent-new-thread"));

    expect(view.queryByTestId("plan-region")).toBeNull();
    expect(view.queryByTestId("plan-current")).toBeNull();
  });
});

describe("plan pause and resume controls", () => {
  test("offers Pause only on a live running or waiting plan", () => {
    const onPause = countingOnPause();
    const running = renderPlan({ plan: makePlan({ status: "running" }), running: true, live: true, onPause });
    const runningCard = cardOf(running);
    expect(runningCard.getByTestId("plan-status").textContent).toBe("Running");
    expect(runningCard.getByTestId("plan-pause")).toBeDefined();
    expect(runningCard.queryByTestId("plan-resume")).toBeNull();
    expect(runningCard.queryByTestId("plan-start")).toBeNull();

    const waiting = renderPlan({
      plan: makePlan({ status: "waiting-for-approval" }),
      running: true,
      live: true,
      onPause
    });
    const waitingCard = cardOf(waiting);
    expect(waitingCard.getByTestId("plan-status").textContent).toBe("Waiting for approval");
    expect(waitingCard.getByTestId("plan-pause")).toBeDefined();

    waiting.rerenderWith({ live: false });
    expect(cardOf(waiting).queryByTestId("plan-pause")).toBeNull();
  });

  test("keeps Pause mounted and disabled with the Stopping name while the stop is open", () => {
    const view = renderPlan({
      plan: makePlan({ status: "running" }),
      running: true,
      live: true,
      stopping: true,
      onPause: countingOnPause()
    });
    const card = cardOf(view);
    expect(card.getByTestId("plan-status").textContent).toBe("Stopping…");
    const pause = card.getByTestId("plan-pause");
    expect(pause).toHaveProperty("disabled", true);
    expect(pause.getAttribute("aria-label")).toBe("Stopping… Waiting for in-flight work to settle.");
    expect(card.queryByTestId("plan-resume")).toBeNull();
    expect(card.queryByTestId("plan-start")).toBeNull();

    // The request-pause notice moves the stored status to pause-requested; the open stop keeps
    // the control mounted and disabled until the terminal event.
    view.rerenderWith({ plan: makePlan({ status: "pause-requested" }) });
    expect(card.getByTestId("plan-status").textContent).toBe("Stopping…");
    expect(card.getByTestId("plan-pause")).toHaveProperty("disabled", true);
  });

  test("shows Paused with the stopped facts and sends the reviewed resume identity", async () => {
    const plan = makePlan({
      status: "paused",
      steps: [
        { text: "Read the current opening", state: "in-progress" },
        { text: "Revise the door scene", state: "pending" }
      ]
    });
    const onResume = countingOnResume();
    const view = renderPlan({
      plan,
      running: false,
      pauseSummary: { changed: 1, undoAvailable: true },
      onResume
    });
    const card = cardOf(view);
    expect(card.getByTestId("plan-status").textContent).toBe("Paused · 1 chapter changed · undo available");
    expect(card.getAllByTestId("plan-step-state").map((node) => node.textContent))
      .toEqual(["In progress", "Pending"]);
    expect(card.getByTestId("plan-resume")).toBeDefined();
    expect(card.queryByTestId("plan-pause")).toBeNull();
    expect(card.queryByTestId("plan-start")).toBeNull();
    expect(testing.within(view.container).getByTestId("plan-current").textContent).toContain("nothing is pre-approved");

    await testing.act(async () => testing.fireEvent.click(card.getByTestId("plan-resume")));
    expect(onResume).toHaveBeenCalledWith({ id: plan.id, revision: plan.revision, action: "resume" });

    view.rerenderWith({ resuming: true });
    const resumingCard = cardOf(view);
    expect(resumingCard.getByTestId("plan-status").textContent)
      .toBe("Paused · 1 chapter changed · undo available · Resuming…");
    expect(resumingCard.queryByTestId("plan-resume")).toBeNull();
    expect(resumingCard.queryByTestId("plan-pause")).toBeNull();
  });

  test("reports a pause request that was never confirmed and offers no Resume", () => {
    const view = renderPlan({
      plan: makePlan({ status: "pause-requested" }),
      notice: "The plan's pause could not be confirmed. The plan remains at its last confirmed state."
    });
    const card = cardOf(view);
    expect(card.getByTestId("plan-status").textContent).toBe("Pause not confirmed");
    expect(card.getByTestId("plan-notice").textContent).toContain("could not be confirmed");
    expect(card.queryByTestId("plan-pause")).toBeNull();
    expect(card.queryByTestId("plan-resume")).toBeNull();
    expect(card.queryByTestId("plan-start")).toBeNull();
  });

  test("offers Start on proposed and no action on any terminal plan", () => {
    const proposed = renderPlan({ plan: makePlan({ status: "proposed" }) });
    const proposedCard = cardOf(proposed);
    expect(proposedCard.getByTestId("plan-start")).toBeDefined();
    expect(proposedCard.queryByTestId("plan-pause")).toBeNull();
    expect(proposedCard.queryByTestId("plan-resume")).toBeNull();

    for (const status of ["completed", "failed", "cancelled", "expired"] as const) {
      const view = renderPlan({ plan: makePlan({ status }) });
      const card = cardOf(view);
      for (const testId of ["plan-start", "plan-pause", "plan-resume", "plan-cancel"]) {
        expect(card.queryByTestId(testId)).toBeNull();
      }
      expect(card.queryByRole("button", { name: /cancel/i })).toBeNull();
    }
  });

  test("offers no Cancel control on a live or paused plan", () => {
    const running = renderPlan({
      plan: makePlan({ status: "running" }),
      running: true,
      live: true,
      onPause: countingOnPause()
    });
    const runningCard = cardOf(running);
    expect(runningCard.queryByTestId("plan-cancel")).toBeNull();
    expect(runningCard.queryByRole("button", { name: /cancel/i })).toBeNull();

    const paused = renderPlan({ plan: makePlan({ status: "paused" }), onResume: countingOnResume() });
    const pausedCard = cardOf(paused);
    expect(pausedCard.queryByTestId("plan-cancel")).toBeNull();
    expect(pausedCard.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  test("Pause waits for stopped, then Resume sends one new Edit turn", async () => {
    const plan = makePlan({ status: "proposed" });
    const start = mock(async (_request: CapturedTurn) => ({
      ok: true,
      data: {
        turnId: START_TURN,
        threadId: THREAD,
        mode: "edit",
        plan: { id: PLAN_ID, revision: plan.revision, status: "running" }
      }
    }));
    const chat = renderChat({ thread: planThread(plan), start });
    const view = chat.view;
    const region = await view.findByTestId("plan-region");
    expect(testing.within(region).queryByTestId("plan-pause")).toBeNull();

    await testing.act(async () => testing.fireEvent.click(testing.within(region).getByTestId("plan-start")));
    await testing.waitFor(() => {
      expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent).toBe("Running");
      expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-pause")).toBeDefined();
    });
    expect(view.getByTestId("chat-stop").textContent).toContain("Stop");
    expect(view.getByTestId("chat-stop").textContent).not.toContain("Cancel");

    await testing.act(async () => {
      testing.fireEvent.click(testing.within(view.getByTestId("plan-region")).getByTestId("plan-pause"));
    });
    expect(chat.stop).toHaveBeenCalledTimes(1);
    expect(chat.stop.mock.calls[0]?.[0]).toBe(START_TURN);
    expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent).toBe("Stopping…");
    expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-pause")).toHaveProperty("disabled", true);

    // The confirmed request-pause notice moves the stored status to pause-requested. The open stop
    // keeps Pause mounted and disabled, and the card still says Stopping.
    chat.setStored(planThread(makePlan({ status: "pause-requested", revision: plan.revision })));
    await testing.act(async () => {
      chat.fire({
        type: "plan",
        turnId: START_TURN,
        planId: PLAN_ID,
        revision: plan.revision,
        status: "pause-requested",
        change: "request-pause"
      });
    });
    await testing.waitFor(() => {
      expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent).toBe("Stopping…");
      expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-pause")).toHaveProperty("disabled", true);
    });

    // A confirm-pause notice is not the author-visible boundary: no Paused, no stored-plan read.
    const readsBeforeConfirm = chat.read.mock.calls.length;
    await testing.act(async () => {
      chat.fire({
        type: "plan",
        turnId: START_TURN,
        planId: PLAN_ID,
        revision: plan.revision,
        status: "paused",
        change: "confirm-pause"
      });
    });
    expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent).toBe("Stopping…");
    expect(chat.read.mock.calls.length).toBe(readsBeforeConfirm);

    chat.setStored(planThread(makePlan({ status: "paused", revision: plan.revision })));
    await testing.act(async () => {
      chat.fire({ type: "stopped", turnId: START_TURN, changed: 1, undoAvailable: true });
    });
    await testing.waitFor(() => {
      expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent)
        .toBe("Paused · 1 chapter changed · undo available");
    });
    const pausedCard = testing.within(view.getByTestId("plan-region"));
    expect(pausedCard.getByTestId("plan-resume")).toBeDefined();
    expect(pausedCard.queryByTestId("plan-pause")).toBeNull();

    await testing.act(async () => {
      testing.fireEvent.click(testing.within(view.getByTestId("plan-region")).getByTestId("plan-resume"));
    });
    expect(start).toHaveBeenCalledTimes(2);
    const resumeRequest = start.mock.calls[1]?.[0];
    if (!resumeRequest) throw new Error("the resume request was not sent");
    expect(resumeRequest).toMatchObject({
      bookId: BOOK,
      threadId: THREAD,
      mode: "edit",
      prompt: "Resume the reviewed plan.",
      plan: { id: PLAN_ID, revision: plan.revision, action: "resume" }
    });
    expect(resumeRequest).not.toHaveProperty("guidance");
    expect(resumeRequest).not.toHaveProperty("planProposal");
    await testing.waitFor(() => {
      expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent).toBe("Running");
    });
    expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-pause")).toBeDefined();
  });

  test("a failed confirm shows Pause not confirmed after stopped and never Paused", async () => {
    const plan = makePlan({ status: "proposed" });
    const start = mock(async (_request: CapturedTurn) => ({
      ok: true,
      data: {
        turnId: START_TURN,
        threadId: THREAD,
        mode: "edit",
        plan: { id: PLAN_ID, revision: plan.revision, status: "running" }
      }
    }));
    const chat = renderChat({ thread: planThread(plan), start });
    const view = chat.view;
    await view.findByTestId("plan-region");
    await testing.act(async () => {
      testing.fireEvent.click(testing.within(view.getByTestId("plan-region")).getByTestId("plan-start"));
    });
    await testing.waitFor(() => {
      expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-pause")).toBeDefined();
    });
    await testing.act(async () => {
      testing.fireEvent.click(testing.within(view.getByTestId("plan-region")).getByTestId("plan-pause"));
    });
    await testing.waitFor(() => {
      expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent).toBe("Stopping…");
    });

    const notice = "The plan's pause could not be confirmed. The plan remains at its last confirmed state.";
    chat.setStored(planThread(makePlan({ status: "pause-requested", revision: plan.revision })));
    await testing.act(async () => {
      chat.fire({
        type: "plan-error",
        turnId: START_TURN,
        planId: PLAN_ID,
        revision: plan.revision,
        change: "confirm-pause",
        message: notice
      });
      chat.fire({ type: "stopped", turnId: START_TURN, changed: 0 });
    });
    await testing.waitFor(() => {
      expect(testing.within(view.getByTestId("plan-region")).getByTestId("plan-status").textContent)
        .toBe("Pause not confirmed");
    });
    const stoppedCard = testing.within(view.getByTestId("plan-region"));
    expect(stoppedCard.getByTestId("plan-notice").textContent).toBe(notice);
    expect(stoppedCard.queryByTestId("plan-pause")).toBeNull();
    expect(stoppedCard.queryByTestId("plan-resume")).toBeNull();
  });

  test("a stored paused plan offers Resume without a live turn", async () => {
    const chat = renderChat({ thread: planThread(makePlan({ status: "paused" })) });
    const view = chat.view;
    const region = await view.findByTestId("plan-region");
    expect(testing.within(region).getByTestId("plan-status").textContent).toBe("Paused");
    expect(testing.within(region).getByTestId("plan-resume")).toBeDefined();
    expect(testing.within(region).queryByTestId("plan-pause")).toBeNull();
    expect(testing.within(region).queryByTestId("plan-start")).toBeNull();
    expect(testing.within(region).queryByRole("button", { name: /cancel/i })).toBeNull();
  });
});
