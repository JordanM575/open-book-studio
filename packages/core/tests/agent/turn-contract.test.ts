import { describe, expect, test } from "bun:test";
import {
  AGENT_TURN_REFUSAL_MESSAGES,
  AgentTurnRefusedError,
  agentPlanTurnRefSchema,
  agentTurnRefused,
  effectivePlanTurnGuidance,
  type AgentEvent,
  type AgentPlanChange,
  type AgentPlanNotice,
  type AgentTurnRefusal,
  type AgentTurnStarted
} from "../../src/agent";
import {
  AGENT_PLAN_LIMITS,
  agentPlanBoundsRefusal,
  type AgentPlanStatus
} from "../../src/agent/plan-state";
import { ProviderError } from "../../src/providers/types";

const validRef = { id: "plan-1", revision: 3, action: "start" as const };

describe("agent plan turn reference", () => {
  test("accepts identity-only Start and Resume references", () => {
    expect(agentPlanTurnRefSchema.parse(validRef)).toEqual(validRef);
    expect(agentPlanTurnRefSchema.parse({ ...validRef, action: "resume" })).toEqual({
      id: "plan-1",
      revision: 3,
      action: "resume"
    });
    expect(agentPlanTurnRefSchema.parse({ id: "p".repeat(200), revision: Number.MAX_SAFE_INTEGER, action: "start" }))
      .toEqual({ id: "p".repeat(200), revision: Number.MAX_SAFE_INTEGER, action: "start" });
  });

  test("refuses every extra key, including plan content, guidance and authority", () => {
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
      { parent: { messageId: "msg_1", turnId: "turn_1" } }
    ]) {
      expect(agentPlanTurnRefSchema.safeParse({ ...validRef, ...extra }).success).toBe(false);
    }
  });

  test("refuses a blank or over-bound id, a bad revision and an unknown action", () => {
    for (const value of [
      { ...validRef, id: "" },
      { ...validRef, id: "   " },
      { ...validRef, id: "p".repeat(AGENT_PLAN_LIMITS.id + 1) },
      { ...validRef, revision: 0 },
      { ...validRef, revision: 1.5 },
      { ...validRef, revision: Number.NaN },
      { ...validRef, action: "apply" },
      { revision: 1, action: "start" },
      { id: "plan-1", action: "start" },
      { id: 1, revision: 1, action: "start" }
    ]) {
      expect(agentPlanTurnRefSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("agent turn refusal", () => {
  test("every refusal has fixed author-facing copy and a typed error", () => {
    const refusals: AgentTurnRefusal[] = [
      "invalid-mode",
      "invalid-plan",
      "plan-in-discuss",
      "plan-without-thread",
      "plan-not-found",
      "plan-invalid",
      "plan-stale-revision",
      "plan-not-startable",
      "plan-not-resumable",
      "invalid-guidance",
      "plan-bounds",
      "plan-guidance-mismatch",
      "plan-state"
    ];
    for (const refusal of refusals) {
      const error = agentTurnRefused(refusal);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toBeInstanceOf(AgentTurnRefusedError);
      expect(error.name).toBe("AgentTurnRefusedError");
      expect(error.code).toBe("invalid-request");
      expect(error.refusal).toBe(refusal);
      expect(error.message).toBe(AGENT_TURN_REFUSAL_MESSAGES[refusal]);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message).not.toMatch(/\n|\bat .*:\d+:\d+|stack/i);
    }
  });

  test("keeps an underlying cause without exposing it in the message", () => {
    const cause = new Error("Synthetic store failure");
    const error = new AgentTurnRefusedError("plan-state", AGENT_TURN_REFUSAL_MESSAGES["plan-state"], { cause });
    expect(error.options.cause).toBe(cause);
    expect(error.message).not.toContain(cause.message);
  });
});

describe("stored plan bounds", () => {
  const valid = {
    id: "plan-1",
    purpose: "Revise the opening",
    revision: 1,
    steps: [{ text: "Read the opening" }, { text: "Rewrite the door" }],
    guidance: "Keep the lantern metaphor."
  };

  test("accepts a plan exactly at every selected bound", () => {
    expect(agentPlanBoundsRefusal(valid)).toBeNull();
    expect(agentPlanBoundsRefusal({
      id: "i".repeat(AGENT_PLAN_LIMITS.id),
      purpose: "p".repeat(AGENT_PLAN_LIMITS.purpose),
      revision: Number.MAX_SAFE_INTEGER,
      steps: Array.from({ length: AGENT_PLAN_LIMITS.steps }, () => ({
        text: "s".repeat(AGENT_PLAN_LIMITS.stepText)
      })),
      guidance: "g".repeat(AGENT_PLAN_LIMITS.guidance)
    })).toBeNull();
  });

  test("refuses blank, short and over-bound values without truncating them", () => {
    const cases = [
      { ...valid, id: "" },
      { ...valid, id: "   " },
      { ...valid, id: "i".repeat(AGENT_PLAN_LIMITS.id + 1) },
      { ...valid, purpose: "" },
      { ...valid, purpose: "   " },
      { ...valid, purpose: "p".repeat(AGENT_PLAN_LIMITS.purpose + 1) },
      { ...valid, revision: 0 },
      { ...valid, revision: 1.5 },
      { ...valid, revision: Number.NaN },
      { ...valid, steps: [] },
      { ...valid, steps: Array.from({ length: AGENT_PLAN_LIMITS.steps + 1 }, () => ({ text: "Step" })) },
      { ...valid, steps: [{ text: "" }] },
      { ...valid, steps: [{ text: "   " }] },
      { ...valid, steps: [{ text: "s".repeat(AGENT_PLAN_LIMITS.stepText + 1) }] },
      { ...valid, guidance: "" },
      { ...valid, guidance: "   " },
      { ...valid, guidance: "g".repeat(AGENT_PLAN_LIMITS.guidance + 1) }
    ];
    for (const plan of cases) expect(agentPlanBoundsRefusal(plan)).toBe("plan-bounds");
  });
});

describe("effective plan-turn guidance", () => {
  test("uses no guidance when neither the turn nor the plan names one", () => {
    expect(effectivePlanTurnGuidance(undefined, undefined)).toEqual({ ok: true, guidance: undefined });
  });

  test("uses the stored plan guidance when the turn omits it or repeats it exactly", () => {
    expect(effectivePlanTurnGuidance(undefined, "Keep the lantern metaphor."))
      .toEqual({ ok: true, guidance: "Keep the lantern metaphor." });
    expect(effectivePlanTurnGuidance("Keep the lantern metaphor.", "Keep the lantern metaphor."))
      .toEqual({ ok: true, guidance: "Keep the lantern metaphor." });
  });

  test("refuses unreviewed guidance in either direction", () => {
    expect(effectivePlanTurnGuidance("Use a different metaphor.", "Keep the lantern metaphor."))
      .toEqual({ ok: false, refusal: "plan-guidance-mismatch" });
    expect(effectivePlanTurnGuidance("Use a different metaphor.", undefined))
      .toEqual({ ok: false, refusal: "plan-guidance-mismatch" });
  });

  test("refuses blank or over-bound turn guidance as invalid-guidance", () => {
    for (const guidance of ["", "   ", "g".repeat(AGENT_PLAN_LIMITS.guidance + 1)]) {
      expect(effectivePlanTurnGuidance(guidance, undefined))
        .toEqual({ ok: false, refusal: "invalid-guidance" });
    }
    expect(effectivePlanTurnGuidance("g".repeat(AGENT_PLAN_LIMITS.guidance), undefined))
      .toEqual({ ok: false, refusal: "plan-guidance-mismatch" });
  });

  test("refuses blank or over-bound stored plan guidance as plan-bounds", () => {
    for (const guidance of ["", "   ", "g".repeat(AGENT_PLAN_LIMITS.guidance + 1)]) {
      expect(effectivePlanTurnGuidance(undefined, guidance))
        .toEqual({ ok: false, refusal: "plan-bounds" });
    }
  });
});

describe("turn and event shapes", () => {
  test("AgentTurnStarted carries the confirmed mode and only plan turns carry a running plan", () => {
    const started: AgentTurnStarted = {
      turnId: "turn_synthetic1",
      threadId: "thread_synthetic1",
      mode: "edit",
      plan: { id: "plan-1", revision: 2, status: "running" }
    };
    expect(started.mode).toBe("edit");
    expect(started.plan).toEqual({ id: "plan-1", revision: 2, status: "running" });
    const ordinary: AgentTurnStarted = {
      turnId: "turn_synthetic2",
      threadId: "thread_synthetic2",
      mode: "discuss"
    };
    expect(ordinary.plan).toBeUndefined();
  });

  test("plan notices carry only confirmed identity, status and step state", () => {
    const changes: AgentPlanChange[] = [
      "proposed",
      "request-approval",
      "approval-settled",
      "request-pause",
      "confirm-pause",
      "complete",
      "cancel",
      "fail"
    ];
    const statuses: AgentPlanStatus[] = [
      "proposed",
      "running",
      "waiting-for-approval",
      "pause-requested",
      "paused",
      "completed",
      "cancelled",
      "failed",
      "expired"
    ];
    expect(changes).toHaveLength(8);
    expect(statuses).toHaveLength(9);

    const notices: AgentPlanNotice[] = [
      {
        type: "plan",
        turnId: "turn_synthetic1",
        planId: "plan-1",
        revision: 2,
        status: "waiting-for-approval",
        change: "request-approval"
      },
      ...changes.map((change) => ({
        type: "plan" as const,
        turnId: "turn_synthetic1",
        planId: "plan-1",
        revision: 2,
        status: "running" as const,
        change
      })),
      {
        type: "plan-step",
        turnId: "turn_synthetic1",
        planId: "plan-1",
        revision: 2,
        status: "running",
        index: 0,
        state: "in-progress"
      },
      {
        type: "plan-step",
        turnId: "turn_synthetic1",
        planId: "plan-1",
        revision: 2,
        status: "pause-requested",
        index: 0,
        state: "not-completed"
      },
      {
        type: "plan-error",
        turnId: "turn_synthetic1",
        planId: "plan-1",
        revision: 2,
        change: "step",
        message: "The step could not be saved."
      }
    ];
    expect(notices.filter((notice) => notice.type === "plan")).toHaveLength(9);
    expect(notices.some((notice) => notice.type === "plan-step" && notice.state === "in-progress")).toBe(true);
    expect(notices.some((notice) => notice.type === "plan-error" && notice.change === "step")).toBe(true);
  });

  test("plan notices and plan-linked approvals are additive AgentEvents", () => {
    const events: AgentEvent[] = [
      { type: "stopping", turnId: "turn_synthetic1" },
      {
        type: "approval",
        turnId: "turn_synthetic1",
        approvalId: "approval-1",
        name: "delete_chapter",
        input: { chapterId: "ch_synthetic1" },
        planId: "plan-1",
        planRevision: 2
      },
      {
        type: "plan",
        turnId: "turn_synthetic1",
        planId: "plan-1",
        revision: 2,
        status: "completed",
        change: "complete"
      },
      {
        type: "plan-step",
        turnId: "turn_synthetic1",
        planId: "plan-1",
        revision: 2,
        status: "running",
        index: 0,
        state: "completed"
      },
      {
        type: "plan-error",
        turnId: "turn_synthetic1",
        planId: "plan-1",
        revision: 2,
        change: "complete",
        message: "The plan could not be completed."
      }
    ];
    expect(events).toHaveLength(5);
    expect(events[1]).toMatchObject({ type: "approval", planId: "plan-1", planRevision: 2 });
  });
});
