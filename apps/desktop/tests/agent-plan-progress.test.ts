import { describe, expect, test } from "bun:test";
import type { AgentPlanNotice } from "@ai-book-studio/core/agent";
import type { AgentPlan } from "@ai-book-studio/core/agent/messages";
import type { AgentPlanEvent } from "@ai-book-studio/core/agent/plan-state";
import { ThreadStoreError, type ThreadStore } from "@ai-book-studio/core/agent/threads";
import { PLAN_STATE_ERROR_MESSAGE, PlanProgress } from "../src/main/agent/plan-tools";

const AT = "2026-11-18T00:00:00.000Z";

function runningPlan(): AgentPlan {
  return {
    id: "plan_progress_1",
    mode: "edit",
    status: "running",
    purpose: "Check the lantern scene",
    steps: [
      { text: "Read the scene", state: "pending" },
      { text: "Revise the scene", state: "pending" }
    ],
    revision: 1,
    parent: { messageId: "msg_progress1", turnId: "turn_progress1" },
    createdAt: AT,
    updatedAt: AT,
    startedAt: AT
  };
}

interface FakeOptions {
  failOnFail?: boolean;
}

function fakeStore(current: { plan: AgentPlan }, events: AgentPlanEvent[], options: FakeOptions = {}): ThreadStore {
  return {
    async applyPlanEvent(_bookId: string, _threadId: string, _planId: string, event: AgentPlanEvent) {
      events.push(event);
      if (event.type === "step" && event.state === "completed") {
        throw new ThreadStoreError("io", "Synthetic boundary close failure.");
      }
      if (event.type === "fail") {
        if (options.failOnFail) throw new ThreadStoreError("io", "Synthetic fail failure.");
        current.plan = {
          ...current.plan,
          status: "failed",
          terminalAt: AT,
          updatedAt: AT,
          steps: current.plan.steps.map((entry) => ({
            ...entry,
            state: entry.state === "completed" ? entry.state : ("not-completed" as const)
          }))
        };
        return { thread: { plans: [current.plan] }, outcome: "applied" as const };
      }
      if (event.type === "step" && event.state === "in-progress") {
        current.plan = {
          ...current.plan,
          steps: current.plan.steps.map((entry, index) => ({
            ...entry,
            state: index === event.index ? ("in-progress" as const) : entry.state
          }))
        };
        return { thread: { plans: [current.plan] }, outcome: "applied" as const };
      }
      return { thread: { plans: [current.plan] }, outcome: "unchanged" as const };
    }
  } as unknown as ThreadStore;
}

function progressFor(current: { plan: AgentPlan }, events: AgentPlanEvent[], notices: AgentPlanNotice[], options: FakeOptions = {}) {
  return new PlanProgress({
    store: fakeStore(current, events, options),
    bookId: "book_progress",
    threadId: "thread_progress",
    turnId: "turn_progress",
    plan: current.plan,
    publish: (notice) => notices.push(notice),
    canWrite: () => true
  });
}

describe("plan boundary close failure", () => {
  test("attempts one terminal fail instead of leaving the stored plan running", async () => {
    const current = { plan: runningPlan() };
    const events: AgentPlanEvent[] = [];
    const notices: AgentPlanNotice[] = [];
    const progress = progressFor(current, events, notices);

    expect(await progress.beginStep({ step: 1 })).toMatchObject({ ok: true, step: 1 });
    await progress.recordResult("chapter_stats", { ok: true });
    expect((await progress.beginStep({ step: 2 })).ok).toBe(false);

    expect(events.filter((event) => event.type === "fail")).toHaveLength(1);
    expect(current.plan.status).toBe("failed");
    expect(current.plan.steps.map((entry) => entry.state)).toEqual(["not-completed", "not-completed"]);
    expect(notices.some((notice) => notice.type === "plan-step" && notice.state === "in-progress")).toBe(true);
    expect(notices.some((notice) => notice.type === "plan" && notice.change === "fail")).toBe(true);

    expect(await progress.endTurn()).toEqual({ ok: false, message: PLAN_STATE_ERROR_MESSAGE });
    expect(events.filter((event) => event.type === "fail")).toHaveLength(1);
  });

  test("reports a fail write failure without claiming progress", async () => {
    const current = { plan: runningPlan() };
    const events: AgentPlanEvent[] = [];
    const notices: AgentPlanNotice[] = [];
    const progress = progressFor(current, events, notices, { failOnFail: true });

    expect(await progress.beginStep({ step: 1 })).toMatchObject({ ok: true, step: 1 });
    await progress.recordResult("chapter_stats", { ok: true });
    expect((await progress.beginStep({ step: 2 })).ok).toBe(false);

    expect(events.filter((event) => event.type === "fail")).toHaveLength(1);
    expect(current.plan.status).toBe("running");
    expect(notices.some((notice) => notice.type === "plan-error" && notice.change === "fail")).toBe(true);
    expect(await progress.endTurn()).toEqual({ ok: false, message: PLAN_STATE_ERROR_MESSAGE });
  });
});
