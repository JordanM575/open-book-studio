/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import {
  agentThreadSchema,
  type AgentMode,
  type AgentPlan,
  type AgentThread
} from "@ai-book-studio/core/agent/messages";
import type { AgentEvent } from "@ai-book-studio/core/agent";
import type { AgentPlanExpiry, AgentPlanRuntime } from "@ai-book-studio/core/ipc";

let testing!: typeof import("@testing-library/react/pure");
let PlanProgress!: typeof import("@ai-book-studio/app/components/PlanProgress").PlanProgress;
let PlanFirstControl!: typeof import("@ai-book-studio/app/components/PlanFirstControl").PlanFirstControl;
let ChatPanel!: typeof import("@ai-book-studio/app/components/ChatPanel").ChatPanel;

beforeAll(async () => {
  testing = await mountDom();
  ({ PlanProgress } = await import("@ai-book-studio/app/components/PlanProgress"));
  ({ PlanFirstControl } = await import("@ai-book-studio/app/components/PlanFirstControl"));
  ({ ChatPanel } = await import("@ai-book-studio/app/components/ChatPanel"));
});
afterAll(async () => {
  await unmountDom();
});
afterEach(() => testing.cleanup());

/**
 * Spec 031 T019: the plan card, Plan-first request form and conversation panel are keyboard
 * reachable, named, described and announced from confirmed state only. These are component tests
 * over synthetic threads and plans; they do not emulate a browser's Tab or native button handling.
 */

const AT = "2026-01-01T00:00:00.000Z";
const BOOK = "book_a11y000001";
const CHAPTER = "ch_a11y000001";
const THREAD = "thread_a11y000001";
const PLAN_ID = "plan_a11y000001";
const PROPOSAL_TURN = "turn_a11y_proposal";
const START_TURN = "turn_a11y_start";
const EXPIRY_WARNING =
  "This plan's runtime is no longer available, but the plan could not be marked expired. It remains at its last confirmed state. Nothing was replayed.";
const BROWSER_REFUSAL = "The writing agent is not available in the browser build yet. Use the desktop app.";

type CapturedTurn = { prompt?: unknown; [key: string]: unknown };

function makePlan(options: {
  id?: string;
  status?: AgentPlan["status"];
  revision?: number;
  guidance?: string | null;
  steps?: AgentPlan["steps"];
} = {}): AgentPlan {
  const status = options.status ?? "proposed";
  const terminal = status === "completed" || status === "cancelled" || status === "failed" || status === "expired";
  const started = status !== "proposed";
  return {
    id: options.id ?? PLAN_ID,
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
    parent: { messageId: "msg_a11y000002", turnId: PROPOSAL_TURN },
    createdAt: AT,
    updatedAt: AT,
    ...(started ? { startedAt: AT } : {}),
    ...(terminal ? { terminalAt: AT } : {})
  };
}

function planThread(plan: AgentPlan | null, approval = false): AgentThread {
  return agentThreadSchema.parse({
    schemaVersion: 1,
    id: THREAD,
    bookId: BOOK,
    title: "An accessible plan conversation",
    createdAt: AT,
    updatedAt: AT,
    messages: [
      {
        id: "msg_a11y000001",
        role: "user",
        parts: [{ type: "text", text: "Propose a plan for the opening chapter." }],
        mode: "edit",
        createdAt: AT
      },
      {
        id: "msg_a11y000002",
        role: "assistant",
        parts: [
          { type: "text", text: "Here is the plan." },
          ...(approval
            ? [{
                type: "approval" as const,
                approvalId: "approval_a11y000001",
                turnId: PROPOSAL_TURN,
                name: "overwrite_chapter",
                input: {},
                status: "pending" as const,
                requestedAt: AT
              }]
            : [])
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

function countingOnCancel(result: { ok: boolean; reason?: string } = { ok: true }) {
  return mock(async (_ref: unknown) => result);
}

function renderPlan(options: {
  plan?: AgentPlan;
  running?: boolean;
  live?: boolean;
  stopping?: boolean;
  resuming?: boolean;
  pauseSummary?: { changed: number; undoAvailable?: boolean } | null;
  cancelling?: boolean;
  cancelSummary?: { changed: number; undoAvailable?: boolean } | null;
  notice?: string | null;
  stale?: boolean;
  focusRequest?: number;
  onStart?: ReturnType<typeof countingOnStart>;
  onPause?: ReturnType<typeof countingOnPause>;
  onResume?: ReturnType<typeof countingOnResume>;
  onCancel?: ReturnType<typeof countingOnCancel>;
} = {}) {
  const onStart = options.onStart ?? countingOnStart();
  const onPause = options.onPause ?? countingOnPause();
  const onResume = options.onResume ?? countingOnResume();
  const onCancel = options.onCancel ?? countingOnCancel();
  const props = {
    plan: options.plan ?? makePlan(),
    running: options.running ?? false,
    live: options.live ?? false,
    stopping: options.stopping ?? false,
    resuming: options.resuming ?? false,
    ...(options.pauseSummary !== undefined ? { pauseSummary: options.pauseSummary } : {}),
    ...(options.cancelling !== undefined ? { cancelling: options.cancelling } : {}),
    ...(options.cancelSummary !== undefined ? { cancelSummary: options.cancelSummary } : {}),
    ...(options.notice !== undefined ? { notice: options.notice } : {}),
    stale: options.stale ?? false,
    focusRequest: options.focusRequest ?? 0,
    onStart,
    onPause,
    onResume,
    onCancel
  };
  const view = testing.render(React.createElement(PlanProgress, props));
  return {
    ...view,
    onStart,
    onPause,
    onResume,
    onCancel,
    rerenderWith(next: Partial<typeof props>) {
      view.rerender(React.createElement(PlanProgress, { ...props, ...next }));
    }
  };
}

function renderPlanFirst(options: {
  plan?: AgentPlan | null;
  notice?: string | null;
  stale?: boolean;
  onPropose?: ReturnType<typeof countingOnPropose>;
} = {}) {
  const onPropose = options.onPropose ?? countingOnPropose();
  const props = {
    mode: "edit" as AgentMode,
    running: false,
    plan: options.plan ?? null,
    modelLabel: "Model: book default",
    onPropose,
    onStart: countingOnStart(),
    ...(options.notice !== undefined ? { notice: options.notice } : {}),
    stale: options.stale ?? false
  };
  const view = testing.render(React.createElement(PlanFirstControl, props));
  return { ...view, onPropose };
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
  planRuntime?: AgentPlanRuntime | null;
  expiry?: AgentPlanExpiry;
  start?: ReturnType<typeof mock>;
} = {}) {
  let stored = options.thread ?? planThread(null);
  const planRuntime = options.planRuntime ?? null;
  let reads = 0;
  let emit: ((event: AgentEvent) => void) | null = null;
  const start = options.start ?? mock(async (_request: CapturedTurn) => ({
    ok: true,
    data: { turnId: PROPOSAL_TURN, threadId: THREAD, mode: "edit" }
  }));
  const read = mock(async () => {
    const first = reads === 0;
    reads += 1;
    const turn = first ? planRuntime : null;
    const expiry = first ? options.expiry : undefined;
    return {
      ok: true,
      data: { thread: stored, planRuntime: turn, ...(expiry ? { expiry } : {}) }
    };
  });
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
      stop: mock(async (_turnId: string) => ({ ok: true, data: null })),
      cancelPlan: mock(async (_input: unknown) => ({ ok: true, data: null })),
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
  const view = testing.render(React.createElement(ChatPanel, {
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
    read,
    view: testing.within(document.body),
    unmount: view.unmount,
    setStored(next: AgentThread) {
      stored = next;
    },
    fire(event: AgentEvent) {
      emit?.(event);
    }
  };
}

function statusWithText(view: ReturnType<typeof testing.within>, text: string): HTMLElement {
  const status = view.getAllByRole("status").find((node: HTMLElement) => node.textContent === text);
  if (!status) throw new Error(`missing status: ${text}`);
  return status;
}

function describedByText(node: HTMLElement): string {
  const id = node.getAttribute("aria-describedby");
  if (!id) throw new Error("missing aria-describedby");
  const description = document.getElementById(id);
  if (!description) throw new Error(`missing described element: ${id}`);
  return description.textContent ?? "";
}

function expectNoPreventedKeys(...nodes: HTMLElement[]): void {
  for (const node of nodes) {
    for (const key of ["Tab", "Enter", " "]) {
      expect(testing.fireEvent.keyDown(node, { key })).toBe(true);
    }
  }
}

describe("plan accessibility", () => {
  // A1
  test("mode and guidance are labelled native controls with visible status", async () => {
    const chat = renderChat();
    const view = chat.view;
    await view.findByTestId("chat-input");

    const mode = view.getByRole("combobox", { name: "Mode for next turn" });
    expect(mode.tagName).toBe("SELECT");
    const discussStatus = statusWithText(view, "Read-only. Send a new turn in Edit mode to request changes.");
    expect(discussStatus.getAttribute("role")).toBe("status");

    mode.focus();
    expect(document.activeElement).toBe(mode);
    testing.fireEvent.change(mode, { target: { value: "edit" } });
    expect(mode).toHaveProperty("value", "edit");
    expect(document.activeElement).toBe(mode);
    expect(view.getByTestId("plan-first")).toBeDefined();
    expect(statusWithText(view, "Changes use checked saves and turn undo. Destructive actions still ask for approval."))
      .toBeDefined();

    const summary = view.getByText("One-turn guidance (optional)");
    expect(summary.tagName).toBe("SUMMARY");
    summary.focus();
    expect(document.activeElement).toBe(summary);
    const details = summary.closest("details");
    if (!details) throw new Error("missing guidance disclosure");
    if (!details.open) {
      await testing.act(async () => {
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      });
    }
    expect(details.open).toBe(true);

    const guidance = view.getByRole("textbox", { name: "Guidance for next turn" });
    expect(guidance.tagName).toBe("TEXTAREA");
    guidance.focus();
    expect(document.activeElement).toBe(guidance);
    expect(describedByText(guidance)).toBe("0 / 2,000 characters · This turn only");
    expect(guidance.getAttribute("aria-describedby")).toBe("agent-guidance-limit");

    const overLimit = "g".repeat(2_001);
    testing.fireEvent.change(guidance, { target: { value: overLimit } });
    expect(guidance).toHaveProperty("value", overLimit);
    expect(guidance.getAttribute("aria-invalid")).toBe("true");
    expect(view.getByRole("alert").textContent)
      .toBe("Shorten guidance to 2,000 characters before sending. Your text is kept.");

    expectNoPreventedKeys(mode, summary, guidance);
  });

  // A2
  test("plan request fields describe their limits and keep focus when steps change", () => {
    renderPlanFirst();
    const view = testing.within(document.body);

    const purpose = view.getByTestId("plan-purpose");
    expect(describedByText(purpose)).toBe("0 / 2,000 characters");
    const steps = view.getAllByTestId("plan-step");
    const firstStep = steps[0];
    if (!firstStep) throw new Error("missing first step");
    expect(describedByText(firstStep)).toBe("Up to 50 steps · 2,000 characters each");
    expect(describedByText(view.getByTestId("plan-guidance")))
      .toBe("0 / 2,000 characters · This request only");

    testing.fireEvent.click(view.getByRole("button", { name: "Add step" }));
    let rows = view.getAllByTestId("plan-step");
    expect(rows).toHaveLength(2);
    const second = rows[1];
    if (!second) throw new Error("missing second step");
    expect(document.activeElement).toBe(second);

    testing.fireEvent.click(view.getByRole("button", { name: "Add step" }));
    rows = view.getAllByTestId("plan-step");
    expect(rows).toHaveLength(3);
    const third = rows[2];
    if (!third) throw new Error("missing third step");
    expect(document.activeElement).toBe(third);

    testing.fireEvent.click(view.getByRole("button", { name: "Remove step 2" }));
    rows = view.getAllByTestId("plan-step");
    expect(rows).toHaveLength(2);
    const shifted = rows[1];
    if (!shifted) throw new Error("missing shifted step");
    expect(document.activeElement).toBe(shifted);
    expect(shifted.getAttribute("aria-label")).toBe("Step 2");

    testing.fireEvent.click(view.getByRole("button", { name: "Remove step 2" }));
    rows = view.getAllByTestId("plan-step");
    expect(rows).toHaveLength(1);
    const previous = rows[0];
    if (!previous) throw new Error("missing previous step");
    expect(document.activeElement).toBe(previous);
    expect(previous.getAttribute("aria-label")).toBe("Step 1");
  });

  // A3
  test("Ask for plan keeps its words and announces a pre-turn refusal", async () => {
    const onPropose = countingOnPropose({
      ok: false,
      reason: "Choose a model for this book before asking the agent to write."
    });
    renderPlanFirst({ onPropose });
    const view = testing.within(document.body);
    fillPlan(view, "Revise the opening chapter", ["Read the opening"], "Keep the names");

    const ask = view.getByRole("button", { name: "Ask for plan" });
    expect(ask.tagName).toBe("BUTTON");
    expect(ask).toHaveProperty("disabled", false);
    ask.focus();
    expect(document.activeElement).toBe(ask);

    await testing.act(async () => testing.fireEvent.click(ask));

    expect(onPropose).toHaveBeenCalledTimes(1);
    expect(onPropose).toHaveBeenCalledWith({
      request: "Revise the opening chapter",
      steps: ["Read the opening"],
      guidance: "Keep the names"
    });
    expect(view.getByRole("alert").textContent)
      .toBe("Choose a model for this book before asking the agent to write.");
    expect(view.getByTestId("plan-purpose")).toHaveProperty("value", "Revise the opening chapter");
    expect(view.getAllByTestId("plan-step")[0]).toHaveProperty("value", "Read the opening");
    expect(view.getByTestId("plan-guidance")).toHaveProperty("value", "Keep the names");
    for (const testId of ["plan-current", "plan-start", "plan-pause", "plan-resume", "plan-cancel"]) {
      expect(view.queryByTestId(testId)).toBeNull();
    }
    await testing.waitFor(() => expect(document.activeElement).toBe(ask));
  });

  // A4
  test("the plan card is named and exposes status and steps as text", () => {
    const plan = makePlan({
      status: "running",
      guidance: "Keep the names",
      steps: [
        { text: "Finished work", state: "completed" },
        { text: "Current work", state: "in-progress" },
        { text: "Later work", state: "pending" },
        { text: "Skipped work", state: "not-completed" }
      ]
    });
    const view = renderPlan({ plan, running: true });
    const card = testing.within(view.container).getByRole("article", { name: "Stored plan" });
    const status = testing.within(card).getByTestId("plan-status");
    const heading = testing.within(card).getByRole("heading", { name: "Stored plan" });

    expect(card.getAttribute("aria-describedby")).toBe(status.id);
    expect(heading.getAttribute("aria-describedby")).toBe(status.id);
    expect(status.textContent).toBe("Running");
    expect(testing.within(card).getAllByTestId("plan-step-state").map((node) => node.textContent))
      .toEqual(["Completed", "In progress", "Pending", "Not completed"]);
    expect(testing.within(card).getByTestId("plan-guidance-text").textContent).toBe("Keep the names");
    expect(testing.within(card).queryByRole("textbox")).toBeNull();
  });

  // A5
  test("Start moves focus to the plan heading and announces only the confirmed running state", async () => {
    const onStart = countingOnStart();
    const view = renderPlan({ plan: makePlan(), focusRequest: 1, onStart });
    const card = testing.within(view.container);
    const heading = card.getByRole("heading", { name: "Stored plan" });
    await testing.waitFor(() => expect(document.activeElement).toBe(heading));
    const live = card.getByTestId("plan-announcement");
    expect(live.textContent).toBe("");

    const start = card.getByTestId("plan-start");
    start.focus();
    expect(document.activeElement).toBe(start);
    await testing.act(async () => testing.fireEvent.click(start));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith({ id: PLAN_ID, revision: 3, action: "start" });
    expect(document.activeElement).toBe(heading);
    expect(live.textContent).toBe("Starting the plan. Waiting for the running acknowledgement.");

    view.rerenderWith({ plan: makePlan({ status: "running" }) });
    expect(card.getByTestId("plan-status").textContent).toBe("Running");
    expect(live.textContent).toBe("Plan running.");
    expect(card.queryByTestId("plan-start")).toBeNull();
  });

  // A6
  test("a refused Start keeps focus on Start and announces the reason", async () => {
    const reason = "The plan could not be started. Nothing changed.";
    const onStart = countingOnStart({ ok: false, reason });
    const view = renderPlan({ plan: makePlan(), onStart });
    const card = testing.within(view.container);
    const start = card.getByTestId("plan-start");
    start.focus();
    await testing.act(async () => testing.fireEvent.click(start));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(card.getByRole("alert").textContent).toBe(reason);
    expect(card.getByTestId("plan-announcement").textContent).toBe("");
    const after = card.getByTestId("plan-start");
    expect(after).toHaveProperty("disabled", false);
    await testing.waitFor(() => expect(document.activeElement).toBe(after));
    expect(card.getByTestId("plan-status").textContent).toBe("Proposed");
    expect(card.getByTestId("plan-announcement").textContent).not.toContain("Plan running.");
  });

  // A7
  test("Pause requests, waits for stopped, then lands on Paused with focus on the heading", async () => {
    const onPause = countingOnPause();
    const view = renderPlan({ plan: makePlan({ status: "running" }), running: true, live: true, onPause });
    const card = testing.within(view.container);
    const heading = card.getByRole("heading", { name: "Stored plan" });
    const live = card.getByTestId("plan-announcement");
    const pause = card.getByTestId("plan-pause");
    pause.focus();
    testing.fireEvent.click(pause);

    expect(onPause).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(heading);
    expect(live.textContent).toBe("Pause requested. Waiting for in-flight work to settle.");

    view.rerenderWith({ plan: makePlan({ status: "pause-requested" }), stopping: true });
    expect(card.getByTestId("plan-status").textContent).toBe("Stopping…");
    expect(live.textContent).toBe("Pause requested. The plan is not paused until the turn stops.");
    expect(card.getByTestId("plan-status").textContent).not.toBe("Paused");

    view.rerenderWith({
      plan: makePlan({ status: "paused" }),
      stopping: false,
      pauseSummary: { changed: 2, undoAvailable: true }
    });
    expect(card.getByTestId("plan-status").textContent).toBe("Paused · 2 chapters changed · undo available");
    expect(live.textContent).toBe("Plan paused. 2 chapters changed; undo available.");
    expect(document.activeElement).toBe(heading);

    const propView = renderPlan({ plan: makePlan({ status: "running" }), running: true, live: true, onPause });
    const propCard = testing.within(propView.container);
    const propLive = propCard.getByTestId("plan-announcement");
    expect(propLive.textContent).toBe("");
    propView.rerenderWith({ stopping: true });
    expect(propLive.textContent).toBe("Pause requested. Waiting for in-flight work to settle.");
    expect(propCard.getByTestId("plan-status").textContent).not.toBe("Paused");
  });

  // A8
  test("Resume sends the reviewed ref once and announces the running acknowledgement", async () => {
    const onResume = countingOnResume();
    const view = renderPlan({ plan: makePlan({ status: "paused" }), onResume });
    const card = testing.within(view.container);
    const heading = card.getByRole("heading", { name: "Stored plan" });
    const live = card.getByTestId("plan-announcement");
    const resume = card.getByTestId("plan-resume");
    resume.focus();
    await testing.act(async () => testing.fireEvent.click(resume));

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith({ id: PLAN_ID, revision: 3, action: "resume" });
    expect(document.activeElement).toBe(heading);
    expect(live.textContent).toBe("Resume requested. Waiting for the running acknowledgement.");

    view.rerenderWith({ plan: makePlan({ status: "running" }) });
    expect(card.getByTestId("plan-status").textContent).toBe("Running");
    expect(live.textContent).toBe("Plan running.");
    expect(card.queryByTestId("plan-resume")).toBeNull();
  });

  // A9
  test("Cancel opens on Keep, Escape and Keep return to Cancel, and confirming focuses the heading", () => {
    const onCancel = countingOnCancel();
    const view = renderPlan({ plan: makePlan(), onCancel });
    const card = testing.within(view.container);
    const live = card.getByTestId("plan-announcement");
    const heading = card.getByRole("heading", { name: "Stored plan" });
    const description = "Cancel this plan? Completed edits stay; Cancel does not undo them.";

    card.getByTestId("plan-cancel").focus();
    testing.fireEvent.click(card.getByTestId("plan-cancel"));
    const keep = card.getByTestId("plan-cancel-keep");
    expect(document.activeElement).toBe(keep);
    const group = card.getByRole("group", { name: "Cancel this plan?" });
    expect(describedByText(group)).toBe(description);
    expect(live.textContent).toBe(description);
    expect(card.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(card.queryByRole("button", { name: "Reject" })).toBeNull();

    testing.fireEvent.keyDown(group, { key: "Escape" });
    expect(card.queryByTestId("plan-cancel-confirmation")).toBeNull();
    expect(document.activeElement).toBe(card.getByTestId("plan-cancel"));
    expect(live.textContent).toBe("Cancel closed. The plan is unchanged.");

    testing.fireEvent.click(card.getByTestId("plan-cancel"));
    testing.fireEvent.click(card.getByTestId("plan-cancel-keep"));
    expect(card.queryByTestId("plan-cancel-confirmation")).toBeNull();
    expect(document.activeElement).toBe(card.getByTestId("plan-cancel"));
    expect(live.textContent).toBe("Cancel closed. The plan is unchanged.");

    testing.fireEvent.click(card.getByTestId("plan-cancel"));
    testing.fireEvent.click(card.getByTestId("plan-cancel-confirm"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith({ id: PLAN_ID });
    expect(document.activeElement).toBe(heading);
    expect(live.textContent).toBe("Cancel requested. Waiting for in-flight work to settle.");
    expect(card.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(card.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  // A10
  test("confirmed step progress and terminal status announce short text", () => {
    const longStep = "Read every sentence of the current opening and revise it carefully.";
    const running = makePlan({
      status: "running",
      steps: [
        { text: longStep, state: "completed" },
        { text: "Revise the door scene", state: "in-progress" },
        { text: "Check the ending", state: "pending" },
        { text: "Report the changes", state: "pending" }
      ]
    });
    const view = renderPlan({ plan: running, running: true });
    const card = testing.within(view.container);
    const live = card.getByTestId("plan-announcement");
    expect(live.textContent).toBe("");

    view.rerenderWith({
      plan: makePlan({
        status: "running",
        steps: [
          { text: longStep, state: "completed" },
          { text: "Revise the door scene", state: "completed" },
          { text: "Check the ending", state: "pending" },
          { text: "Report the changes", state: "pending" }
        ]
      })
    });
    expect(live.textContent).toBe("Step 2 of 4: Completed.");
    expect(live.textContent).not.toContain(longStep);

    view.rerenderWith({
      plan: makePlan({
        status: "cancelled",
        steps: [
          { text: longStep, state: "completed" },
          { text: "Revise the door scene", state: "completed" },
          { text: "Check the ending", state: "not-completed" },
          { text: "Report the changes", state: "not-completed" }
        ]
      }),
      cancelling: true
    });
    expect(live.textContent).toBe("Plan cancelled. Finishing in-flight work. Completed edits stay.");

    view.rerenderWith({
      plan: makePlan({
        status: "cancelled",
        steps: [
          { text: longStep, state: "completed" },
          { text: "Revise the door scene", state: "completed" },
          { text: "Check the ending", state: "not-completed" },
          { text: "Report the changes", state: "not-completed" }
        ]
      }),
      cancelling: false,
      cancelSummary: { changed: 2, undoAvailable: true }
    });
    expect(live.textContent).toBe(
      "Plan cancelled. 2 of 4 steps completed. 2 chapters changed; undo available. Completed edits stay."
    );
    expect(card.getByTestId("plan-cancel-note").textContent)
      .toBe("Completed steps stay. Cancel does not undo them.");
  });

  // A11
  test("plan errors, failed and expired keep text and alerts", () => {
    const notice = "The plan's progress could not be saved. Nothing was marked complete.";
    const first = renderPlan({ plan: makePlan({ status: "running" }), running: true, notice });
    const firstCard = testing.within(first.container);
    expect(firstCard.getByTestId("plan-notice").getAttribute("role")).toBe("alert");
    expect(firstCard.getByTestId("plan-notice").textContent).toBe(notice);
    expect(firstCard.getByTestId("plan-status").textContent).toBe("Running");
    expect(firstCard.getByTestId("plan-announcement").textContent).toBe("");
    first.unmount();

    const failed = renderPlan({ plan: makePlan({ status: "running" }), running: true });
    failed.rerenderWith({ plan: makePlan({ status: "failed" }) });
    const failedCard = testing.within(failed.container);
    expect(failedCard.getByTestId("plan-status").textContent).toBe("Failed");
    expect(failedCard.getByTestId("plan-announcement").textContent)
      .toBe("Plan failed. No further step will run. Completed steps stay.");
    failed.unmount();

    const expired = renderPlan({ plan: makePlan({ status: "running" }), running: true });
    expired.rerenderWith({ plan: makePlan({ status: "expired" }) });
    const expiredCard = testing.within(expired.container);
    expect(expiredCard.getByTestId("plan-status").textContent).toBe("Expired");
    expect(expiredCard.getByTestId("plan-expired-note").textContent)
      .toBe("This plan cannot be started, resumed or replayed. Completed steps stay; no further step will run.");
    expect(expiredCard.getByTestId("plan-announcement").textContent)
      .toBe("Plan expired. This plan cannot be started, resumed or replayed. Completed steps stay.");
    for (const testId of ["plan-start", "plan-resume", "plan-cancel"]) {
      expect(expiredCard.queryByTestId(testId)).toBeNull();
    }
  });

  // A12
  test("a running plan and a pending destructive approval are distinguishable by text", async () => {
    const waiting = renderChat({ thread: planThread(makePlan({ status: "waiting-for-approval" }), true) });
    const waitingRegion = await waiting.view.findByTestId("plan-region");
    const waitingCard = testing.within(waitingRegion);
    expect(waitingCard.getByTestId("plan-status").textContent).toBe("Waiting for approval");
    expect(waiting.view.getByText("The agent will wait for your answer before changing anything.")).toBeDefined();
    expect(waiting.view.getByRole("button", { name: "Allow" }).tagName).toBe("BUTTON");
    expect(waiting.view.getByRole("button", { name: "Deny" }).tagName).toBe("BUTTON");
    expect(waitingCard.getByTestId("plan-status").textContent).not.toBe("Running");
    waiting.unmount();

    const running = renderChat({ thread: planThread(makePlan({ status: "running" })) });
    const runningRegion = await running.view.findByTestId("plan-region");
    const runningCard = testing.within(runningRegion);
    expect(runningCard.getByTestId("plan-status").textContent).toBe("Running");
    expect(running.view.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(running.view.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  // A13
  test("reload and reattach never steal focus or replay old status; a lost runtime offers no action", async () => {
    const running = renderChat({
      thread: planThread(makePlan({ status: "running" })),
      planRuntime: { planId: PLAN_ID, turnId: START_TURN, phase: "active" }
    });
    const runningRegion = await running.view.findByTestId("plan-region");
    const runningCard = testing.within(runningRegion);
    await testing.waitFor(() => expect(runningCard.getByTestId("plan-pause")).toBeDefined());
    expect(runningCard.getByTestId("plan-cancel")).toBeDefined();
    expect(runningCard.getByTestId("plan-announcement").textContent).toBe("");
    expect(document.activeElement).not.toBe(runningCard.getByRole("heading", { name: "Stored plan" }));
    running.unmount();

    const stopping = renderChat({
      thread: planThread(makePlan({ status: "running" })),
      planRuntime: { planId: PLAN_ID, turnId: START_TURN, phase: "stopping" }
    });
    const stoppingRegion = await stopping.view.findByTestId("plan-region");
    const stoppingCard = testing.within(stoppingRegion);
    await testing.waitFor(() => expect(stoppingCard.getByTestId("plan-status").textContent).toBe("Stopping…"));
    expect(stoppingCard.getByTestId("plan-pause")).toHaveProperty("disabled", true);
    expect(stoppingCard.getByTestId("plan-announcement").textContent).toBe("");
    stopping.unmount();

    const noRuntime = renderChat({ thread: planThread(makePlan({ status: "running" })) });
    const noRuntimeRegion = await noRuntime.view.findByTestId("plan-region");
    const noRuntimeCard = testing.within(noRuntimeRegion);
    expect(noRuntimeCard.getByTestId("plan-status").textContent).toBe("Running");
    for (const testId of ["plan-start", "plan-pause", "plan-resume", "plan-cancel"]) {
      expect(noRuntimeCard.queryByTestId(testId)).toBeNull();
    }
    expect(noRuntimeCard.getByTestId("plan-announcement").textContent).toBe("");
  });

  // A14
  test("the browser build refuses a plan proposal by name and creates no plan", async () => {
    const onPropose = countingOnPropose({ ok: false, reason: BROWSER_REFUSAL });
    renderPlanFirst({ onPropose });
    const view = testing.within(document.body);
    fillPlan(view, "Revise the opening chapter", ["Read the opening"]);

    const ask = view.getByRole("button", { name: "Ask for plan" });
    ask.focus();
    await testing.act(async () => testing.fireEvent.click(ask));

    expect(view.getByRole("alert").textContent).toBe(BROWSER_REFUSAL);
    expect(view.queryByTestId("plan-card")).toBeNull();
    expect(view.queryByTestId("plan-current")).toBeNull();
    for (const name of ["Start plan", "Pause plan", "Resume plan", "Cancel plan"]) {
      expect(view.queryByRole("button", { name })).toBeNull();
    }
    expect(view.getByTestId("plan-purpose")).toHaveProperty("value", "Revise the opening chapter");
    await testing.waitFor(() => expect(document.activeElement).toBe(ask));
  });

  // A15
  test("reduced motion and transparency leave the plan controls usable with no local effects", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })) as typeof window.matchMedia;
    try {
      const start = mock(async (_request: CapturedTurn) => ({
        ok: true,
        data: {
          turnId: START_TURN,
          threadId: THREAD,
          mode: "edit",
          plan: { id: PLAN_ID, revision: 3, status: "running" }
        }
      }));
      const chat = renderChat({ thread: planThread(makePlan()), start });
      const view = chat.view;
      const region = await view.findByTestId("plan-region");
      testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
      const planFirst = view.getByTestId("plan-first");
      const card = testing.within(region).getByTestId("plan-card");
      const effectPattern = /(?:^|\s)(?:glass|glass-strong|glass-dialog|backdrop-\w+|blur-\w+|animate-\w+)/;

      for (const node of [region, planFirst, card]) {
        expect(node.className).not.toMatch(effectPattern);
      }
      expect(testing.within(region).getByRole("article", { name: "Stored plan" })).toBe(card);
      expect(testing.within(card).getByTestId("plan-status").textContent).toBe("Proposed");

      const mode = view.getByRole("combobox", { name: "Mode for next turn" });
      const summary = view.getByText("One-turn guidance (optional)");
      const startButton = testing.within(card).getByTestId("plan-start");
      const cancelButton = testing.within(card).getByTestId("plan-cancel");
      for (const node of [mode, summary, startButton, cancelButton]) {
        expect(node.tabIndex).toBeGreaterThanOrEqual(0);
        expect(node.getAttribute("aria-hidden")).toBeNull();
        node.focus();
        expect(document.activeElement).toBe(node);
      }

      await testing.act(async () => testing.fireEvent.click(startButton));
      expect(start).toHaveBeenCalledTimes(1);
      const heading = testing.within(card).getByRole("heading", { name: "Stored plan" });
      expect(document.activeElement).toBe(heading);
      expect(testing.within(card).getByTestId("plan-announcement").textContent).toBe("Plan running.");
      chat.unmount();

      renderPlanFirst();
      const direct = testing.within(document.body);
      const directFirst = direct.getByTestId("plan-first");
      expect(directFirst.className).not.toMatch(effectPattern);
      const purpose = direct.getByTestId("plan-purpose");
      const step = direct.getByTestId("plan-step");
      const guidance = direct.getByTestId("plan-guidance");
      for (const node of [purpose, step, guidance]) {
        expect(node.tabIndex).toBeGreaterThanOrEqual(0);
        expect(node.getAttribute("aria-hidden")).toBeNull();
        node.focus();
        expect(document.activeElement).toBe(node);
      }
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  // A16
  test("plan controls are native, tabbable and never trap Tab", async () => {
    const view = renderPlan({ plan: makePlan(), live: true, onCancel: countingOnCancel() });
    const card = testing.within(view.container).getByTestId("plan-card");
    const cancel = testing.within(card).getByTestId("plan-cancel");

    cancel.focus();
    expect(testing.fireEvent.keyDown(cancel, { key: "Escape" })).toBe(true);
    expect(testing.within(card).queryByTestId("plan-cancel-confirmation")).toBeNull();

    testing.fireEvent.click(cancel);
    const native = [
      testing.within(card).getByTestId("plan-start"),
      testing.within(card).getByTestId("plan-cancel-confirm"),
      testing.within(card).getByTestId("plan-cancel-keep")
    ];
    for (const node of native) {
      expect(node.tagName).toBe("BUTTON");
      expect(node.tabIndex).toBeGreaterThanOrEqual(0);
      expect(node.getAttribute("aria-hidden")).toBeNull();
      node.focus();
      expect(document.activeElement).toBe(node);
    }
    expectNoPreventedKeys(...native);
    expect(card.querySelector('[aria-modal="true"]')).toBeNull();
    expect(testing.within(card).queryByRole("dialog")).toBeNull();
    const group = testing.within(card).getByRole("group", { name: "Cancel this plan?" });
    expect(testing.fireEvent.keyDown(group, { key: "Escape" })).toBe(true);
    expect(testing.within(card).queryByTestId("plan-cancel-confirmation")).toBeNull();
    view.unmount();

    const chat = renderChat();
    const chatView = chat.view;
    await chatView.findByTestId("chat-input");
    testing.fireEvent.change(chatView.getByTestId("agent-mode"), { target: { value: "edit" } });
    const mode = chatView.getByRole("combobox", { name: "Mode for next turn" });
    const summary = chatView.getByText("One-turn guidance (optional)");
    expect(mode.tagName).toBe("SELECT");
    expect(summary.tagName).toBe("SUMMARY");
    const details = summary.closest("details");
    if (!details) throw new Error("missing guidance disclosure");
    if (!details.open) {
      await testing.act(async () => {
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      });
    }
    const guidance = chatView.getByRole("textbox", { name: "Guidance for next turn" });
    expect(guidance.tagName).toBe("TEXTAREA");
    for (const node of [mode, summary, guidance]) {
      node.focus();
      expect(document.activeElement).toBe(node);
      expect(node.tabIndex).toBeGreaterThanOrEqual(0);
      expect(node.getAttribute("aria-hidden")).toBeNull();
    }
    expectNoPreventedKeys(mode, summary, guidance);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  // A17
  test("a newly stored proposal focuses the plan heading and announces once", async () => {
    const chat = renderChat();
    const view = chat.view;
    await view.findByTestId("chat-input");
    testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
    const planFirst = testing.within(view.getByTestId("plan-first"));
    fillPlan(planFirst, "Revise the opening chapter", ["Read the opening"]);

    await testing.act(async () => testing.fireEvent.click(planFirst.getByTestId("plan-propose")));
    expect(chat.start).toHaveBeenCalledTimes(1);
    chat.setStored(planThread(makePlan()));
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
    await testing.act(async () => {
      chat.fire({ type: "stopped", turnId: PROPOSAL_TURN });
    });

    const region = await view.findByTestId("plan-region");
    const cards = view.getAllByTestId("plan-card");
    expect(cards).toHaveLength(1);
    const card = testing.within(region);
    const heading = card.getByRole("heading", { name: "Stored plan" });
    await testing.waitFor(() => expect(document.activeElement).toBe(heading));
    expect(view.getByTestId("plan-proposal-announcement").textContent)
      .toBe("Plan proposed. Review the stored plan before starting it.");
    expect(card.getByTestId("plan-announcement").textContent).toBe("");
    expect(view.getByTestId("agent-mode")).toHaveProperty("value", "discuss");

    testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
    expect(view.getAllByTestId("plan-card")).toHaveLength(1);
    expect(view.getByTestId("plan-first")).toBeDefined();
    expect(view.getByTestId("plan-open").textContent).toBe("Start the stored plan before asking for another.");
    expect(view.getByTestId("plan-purpose")).toBeDefined();
    expect(view.getByTestId("plan-step")).toBeDefined();
    expect(view.getByTestId("plan-guidance")).toBeDefined();
  });

  // A18
  test("a stale expiry warning is one alert, not a second live status", async () => {
    const chat = renderChat({
      thread: planThread(makePlan({ status: "paused" })),
      expiry: { planId: PLAN_ID, outcome: "failed", message: EXPIRY_WARNING }
    });
    const view = chat.view;
    const region = await view.findByTestId("plan-region");
    const card = testing.within(region);
    await testing.waitFor(() => expect(card.getByTestId("plan-notice").textContent).toBe(EXPIRY_WARNING));

    testing.fireEvent.change(view.getByTestId("agent-mode"), { target: { value: "edit" } });
    const notice = card.getByTestId("plan-notice");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toBe(EXPIRY_WARNING);
    expect(card.queryByTestId("plan-start")).toBeNull();
    expect(card.queryByTestId("plan-resume")).toBeNull();
    expect(card.getByTestId("plan-cancel")).toBeDefined();

    const open = view.getByTestId("plan-open");
    expect(open.textContent).toBe(EXPIRY_WARNING);
    expect(open.getAttribute("role")).toBeNull();

    const repeatedLive = Array.from(document.querySelectorAll('[role="status"], [aria-live]'))
      .filter((node) => node.textContent?.includes(EXPIRY_WARNING));
    expect(repeatedLive).toHaveLength(0);
    const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .filter((node) => node.textContent === EXPIRY_WARNING);
    expect(alerts).toHaveLength(1);
  });
});
