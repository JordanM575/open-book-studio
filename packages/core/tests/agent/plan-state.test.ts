import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PLAN_GUIDANCE_LIMIT, PLAN_STATUSES, PLAN_STEP_STATES } from "../../src/agent/proposed-plan";
import {
  AGENT_PLAN_LIMITS,
  AGENT_PLAN_STATUSES,
  AGENT_PLAN_STEP_STATES,
  applyAgentPlanEvent,
  refreshAgentPlanProposal,
  type AgentPlanEvent,
  type AgentPlanEventResult,
  type AgentPlanState,
  type AgentPlanStatus,
  type AgentPlanStepState
} from "../../src/agent/plan-state";

const CREATED = "2026-11-17T10:00:00.000Z";
const STARTED = "2026-11-17T11:00:00.000Z";
const AT = "2026-11-17T12:00:00.000Z";

interface TestPlan extends AgentPlanState {
  id: string;
  mode: "edit";
  purpose: string;
  steps: { text: string; state: AgentPlanStepState; futureStep?: string }[];
  parent: { messageId: string; turnId: string; futureParent?: string };
  guidance?: string;
  futurePlan?: string;
  startedAt?: string;
  terminalAt?: string;
}

interface StatusShape {
  steps: AgentPlanStepState[];
  started: boolean;
  terminal: boolean;
}

const SHAPES: Record<AgentPlanStatus, StatusShape> = {
  proposed: { steps: ["pending", "pending"], started: false, terminal: false },
  running: { steps: ["completed", "pending"], started: true, terminal: false },
  "waiting-for-approval": { steps: ["completed", "pending"], started: true, terminal: false },
  "pause-requested": { steps: ["completed", "pending"], started: true, terminal: false },
  paused: { steps: ["completed", "pending"], started: true, terminal: false },
  completed: { steps: ["completed", "completed"], started: true, terminal: true },
  cancelled: { steps: ["completed", "not-completed"], started: true, terminal: true },
  failed: { steps: ["completed", "not-completed"], started: true, terminal: true },
  expired: { steps: ["not-completed", "not-completed"], started: false, terminal: true }
};

function planFor(status: AgentPlanStatus, overrides: Partial<TestPlan> = {}): TestPlan {
  const shape = SHAPES[status];
  return {
    id: `plan-${status}`,
    mode: "edit",
    status,
    purpose: "Revise the opening",
    steps: shape.steps.map((state, index) => ({ text: `Step ${index + 1}`, state })),
    revision: 1,
    parent: { messageId: "msg_test0001", turnId: "turn_test0001" },
    createdAt: CREATED,
    updatedAt: AT,
    ...(shape.started ? { startedAt: STARTED } : {}),
    ...(shape.terminal ? { terminalAt: AT } : {}),
    ...overrides
  };
}

function take<T extends AgentPlanState>(result: AgentPlanEventResult<T>): T {
  if (result.outcome !== "applied") throw new Error(`expected applied, got ${result.outcome}`);
  return result.plan;
}

function reasonOf<T extends AgentPlanState>(result: AgentPlanEventResult<T>): string | null {
  return result.outcome === "refused" ? result.reason : null;
}

type Expected = "applied" | "unchanged" | "refused";

const EVENTS: AgentPlanEvent[] = [
  { type: "start", revision: 1 },
  { type: "request-approval" },
  { type: "approval-settled" },
  { type: "request-pause" },
  { type: "confirm-pause" },
  { type: "resume" },
  { type: "complete" },
  { type: "cancel" },
  { type: "fail" },
  { type: "expire" },
  { type: "step", revision: 1, index: 1, state: "in-progress" }
];

const EXPECTED: Record<AgentPlanStatus, Record<AgentPlanEvent["type"], Expected>> = {
  proposed: {
    start: "applied",
    "request-approval": "refused",
    "approval-settled": "refused",
    "request-pause": "refused",
    "confirm-pause": "refused",
    resume: "refused",
    complete: "refused",
    cancel: "applied",
    fail: "refused",
    expire: "applied",
    step: "refused"
  },
  running: {
    start: "unchanged",
    "request-approval": "applied",
    "approval-settled": "unchanged",
    "request-pause": "applied",
    "confirm-pause": "refused",
    resume: "unchanged",
    complete: "applied",
    cancel: "applied",
    fail: "applied",
    expire: "applied",
    step: "applied"
  },
  "waiting-for-approval": {
    start: "refused",
    "request-approval": "unchanged",
    "approval-settled": "applied",
    "request-pause": "applied",
    "confirm-pause": "refused",
    resume: "refused",
    complete: "applied",
    cancel: "applied",
    fail: "applied",
    expire: "applied",
    step: "refused"
  },
  "pause-requested": {
    start: "refused",
    "request-approval": "refused",
    "approval-settled": "unchanged",
    "request-pause": "unchanged",
    "confirm-pause": "applied",
    resume: "refused",
    complete: "applied",
    cancel: "applied",
    fail: "applied",
    expire: "applied",
    step: "applied"
  },
  paused: {
    start: "refused",
    "request-approval": "refused",
    "approval-settled": "unchanged",
    "request-pause": "refused",
    "confirm-pause": "unchanged",
    resume: "applied",
    complete: "refused",
    cancel: "applied",
    fail: "refused",
    expire: "applied",
    step: "refused"
  },
  completed: {
    start: "refused",
    "request-approval": "refused",
    "approval-settled": "unchanged",
    "request-pause": "refused",
    "confirm-pause": "refused",
    resume: "refused",
    complete: "unchanged",
    cancel: "refused",
    fail: "refused",
    expire: "unchanged",
    step: "refused"
  },
  cancelled: {
    start: "refused",
    "request-approval": "refused",
    "approval-settled": "unchanged",
    "request-pause": "refused",
    "confirm-pause": "refused",
    resume: "refused",
    complete: "refused",
    cancel: "unchanged",
    fail: "refused",
    expire: "unchanged",
    step: "refused"
  },
  failed: {
    start: "refused",
    "request-approval": "refused",
    "approval-settled": "unchanged",
    "request-pause": "refused",
    "confirm-pause": "refused",
    resume: "refused",
    complete: "refused",
    cancel: "refused",
    fail: "unchanged",
    expire: "unchanged",
    step: "refused"
  },
  expired: {
    start: "refused",
    "request-approval": "refused",
    "approval-settled": "unchanged",
    "request-pause": "refused",
    "confirm-pause": "refused",
    resume: "refused",
    complete: "refused",
    cancel: "refused",
    fail: "refused",
    expire: "unchanged",
    step: "refused"
  }
};

describe("the plan lifecycle table", () => {
  test("every stored status and lifecycle event match the design table", () => {
    for (const status of AGENT_PLAN_STATUSES) {
      for (const event of EVENTS) {
        const result = applyAgentPlanEvent(planFor(status), event, AT);
        expect({
          status,
          event: event.type,
          outcome: result.outcome
        }).toEqual({ status, event: event.type, outcome: EXPECTED[status][event.type] });
      }
    }
  });

  test("every applied transition records the new status and update time only", () => {
    const started = take(applyAgentPlanEvent(planFor("proposed"), { type: "start", revision: 1 }, AT));
    expect(started.status).toBe("running");
    expect(started.startedAt).toBe(AT);
    expect(started.terminalAt).toBeUndefined();
    expect(started.updatedAt).toBe(AT);

    const waiting = take(
      applyAgentPlanEvent(planFor("running"), { type: "request-approval" }, AT)
    );
    expect(waiting.status).toBe("waiting-for-approval");
    expect(waiting.startedAt).toBe(STARTED);

    const completed = take(
      applyAgentPlanEvent(planFor("waiting-for-approval"), { type: "complete" }, AT)
    );
    expect(completed.status).toBe("completed");
    expect(completed.terminalAt).toBe(AT);
    expect(completed.updatedAt).toBe(AT);
  });
});

describe("pause and resume", () => {
  test("a pause request only moves running and waiting plans", () => {
    expect(take(applyAgentPlanEvent(planFor("running"), { type: "request-pause" }, AT)).status).toBe(
      "pause-requested"
    );
    expect(
      take(
        applyAgentPlanEvent(planFor("waiting-for-approval"), { type: "request-pause" }, AT)
      ).status
    ).toBe("pause-requested");
    expect(applyAgentPlanEvent(planFor("paused"), { type: "request-pause" }, AT).outcome).toBe(
      "refused"
    );
    expect(
      applyAgentPlanEvent(planFor("pause-requested"), { type: "request-pause" }, AT).outcome
    ).toBe("unchanged");
  });

  test("only a confirmed stopped boundary pauses a requested plan", () => {
    expect(
      take(applyAgentPlanEvent(planFor("pause-requested"), { type: "confirm-pause" }, AT)).status
    ).toBe("paused");
    expect(
      reasonOf(applyAgentPlanEvent(planFor("running"), { type: "confirm-pause" }, AT))
    ).toBe("wrong-status");
    expect(
      reasonOf(applyAgentPlanEvent(planFor("waiting-for-approval"), { type: "confirm-pause" }, AT))
    ).toBe("wrong-status");
    expect(
      applyAgentPlanEvent(planFor("paused"), { type: "confirm-pause" }, AT).outcome
    ).toBe("unchanged");
  });

  test("a settling plan can still finish, cancel or fail", () => {
    expect(take(applyAgentPlanEvent(planFor("pause-requested"), { type: "complete" }, AT)).status).toBe(
      "completed"
    );
    expect(take(applyAgentPlanEvent(planFor("pause-requested"), { type: "fail" }, AT)).status).toBe(
      "failed"
    );
    expect(take(applyAgentPlanEvent(planFor("pause-requested"), { type: "cancel" }, AT)).status).toBe(
      "cancelled"
    );
  });

  test("resume keeps the first start time and the revision", () => {
    const resumed = take(applyAgentPlanEvent(planFor("paused"), { type: "resume" }, AT));
    expect(resumed.status).toBe("running");
    expect(resumed.startedAt).toBe(STARTED);
    expect(resumed.revision).toBe(1);
    expect(applyAgentPlanEvent(planFor("running"), { type: "resume" }, AT).outcome).toBe("unchanged");
    expect(reasonOf(applyAgentPlanEvent(planFor("proposed"), { type: "resume" }, AT))).toBe(
      "wrong-status"
    );
    expect(reasonOf(applyAgentPlanEvent(planFor("pause-requested"), { type: "resume" }, AT))).toBe(
      "wrong-status"
    );
    expect(reasonOf(applyAgentPlanEvent(planFor("completed"), { type: "resume" }, AT))).toBe(
      "terminal-plan"
    );
    expect(reasonOf(applyAgentPlanEvent(planFor("paused"), { type: "complete" }, AT))).toBe(
      "wrong-status"
    );
    expect(reasonOf(applyAgentPlanEvent(planFor("paused"), { type: "fail" }, AT))).toBe("wrong-status");
  });
});

describe("cancel, failure and expiry", () => {
  test("cancel closes every unfinished plan and keeps completed steps", () => {
    for (const status of ["proposed", "running", "waiting-for-approval", "pause-requested", "paused"] as const) {
      const cancelled = take(applyAgentPlanEvent(planFor(status), { type: "cancel" }, AT));
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.terminalAt).toBe(AT);
      expect(cancelled.steps.every((step) => step.state !== "pending" && step.state !== "in-progress")).toBe(
        true
      );
      expect(cancelled.steps.some((step) => step.state === "completed")).toBe(
        status !== "proposed"
      );
    }
    expect(applyAgentPlanEvent(planFor("cancelled"), { type: "cancel" }, AT).outcome).toBe("unchanged");
    for (const status of ["completed", "failed", "expired"] as const) {
      expect(reasonOf(applyAgentPlanEvent(planFor(status), { type: "cancel" }, AT))).toBe(
        "terminal-plan"
      );
    }
  });

  test("failure closes open steps and expires only a live plan", () => {
    for (const status of ["running", "waiting-for-approval", "pause-requested"] as const) {
      const failed = take(applyAgentPlanEvent(planFor(status), { type: "fail" }, AT));
      expect(failed.status).toBe("failed");
      expect(failed.terminalAt).toBe(AT);
      expect(failed.steps.every((step) => step.state !== "pending" && step.state !== "in-progress")).toBe(
        true
      );
    }
    expect(applyAgentPlanEvent(planFor("failed"), { type: "fail" }, AT).outcome).toBe("unchanged");
    expect(reasonOf(applyAgentPlanEvent(planFor("proposed"), { type: "fail" }, AT))).toBe(
      "wrong-status"
    );
    expect(reasonOf(applyAgentPlanEvent(planFor("paused"), { type: "fail" }, AT))).toBe("wrong-status");

    for (const status of ["proposed", "running", "waiting-for-approval", "pause-requested", "paused"] as const) {
      const expired = take(applyAgentPlanEvent(planFor(status), { type: "expire" }, AT));
      expect(expired.status).toBe("expired");
      expect(expired.terminalAt).toBe(AT);
    }
    for (const status of ["completed", "cancelled", "failed", "expired"] as const) {
      expect(applyAgentPlanEvent(planFor(status), { type: "expire" }, AT).outcome).toBe("unchanged");
    }
  });
});

describe("step forward rules", () => {
  function running(states: AgentPlanStepState[]): TestPlan {
    return planFor("running", {
      steps: states.map((state, index) => ({ text: `Step ${index + 1}`, state }))
    });
  }

  test("pending and in-progress steps may report an observed outcome", () => {
    for (const state of ["in-progress", "completed", "not-completed"] as const) {
      const result = take(
        applyAgentPlanEvent(running(["pending", "pending"]), { type: "step", revision: 1, index: 0, state }, AT)
      );
      expect(result.steps[0]?.state).toBe(state);
      expect(result.status).toBe("running");
      expect(result.updatedAt).toBe(AT);
    }
    for (const state of ["completed", "not-completed"] as const) {
      const result = take(
        applyAgentPlanEvent(
          running(["in-progress", "pending"]),
          { type: "step", revision: 1, index: 0, state },
          AT
        )
      );
      expect(result.steps[0]?.state).toBe(state);
    }
  });

  test("a finished step never changes and a duplicate event is a no-op", () => {
    for (const state of ["completed", "not-completed"] as const) {
      expect(
        reasonOf(
          applyAgentPlanEvent(
            running([state, "pending"]),
            { type: "step", revision: 1, index: 0, state: "in-progress" },
            AT
          )
        )
      ).toBe("step-backward");
    }
    expect(
      applyAgentPlanEvent(
        running(["in-progress", "pending"]),
        { type: "step", revision: 1, index: 0, state: "in-progress" },
        AT
      ).outcome
    ).toBe("unchanged");
  });

  test("only one step may be in progress and earlier steps must finish first", () => {
    expect(
      reasonOf(
        applyAgentPlanEvent(
          running(["in-progress", "pending"]),
          { type: "step", revision: 1, index: 1, state: "in-progress" },
          AT
        )
      )
    ).toBe("step-already-in-progress");
    expect(
      reasonOf(
        applyAgentPlanEvent(
          running(["pending", "pending"]),
          { type: "step", revision: 1, index: 1, state: "completed" },
          AT
        )
      )
    ).toBe("step-order");
    expect(
      reasonOf(
        applyAgentPlanEvent(
          running(["pending", "pending"]),
          { type: "step", revision: 1, index: 1, state: "in-progress" },
          AT
        )
      )
    ).toBe("step-order");
  });

  test("an index outside the plan is refused", () => {
    for (const index of [-1, 2, 1.5]) {
      expect(
        reasonOf(
          applyAgentPlanEvent(
            running(["pending", "pending"]),
            { type: "step", revision: 1, index, state: "in-progress" },
            AT
          )
        )
      ).toBe("step-out-of-range");
    }
  });

  test("a settling plan records a late in-flight outcome but a waiting plan waits first", () => {
    const settled = take(
      applyAgentPlanEvent(
        planFor("pause-requested"),
        { type: "step", revision: 1, index: 1, state: "completed" },
        AT
      )
    );
    expect(settled.status).toBe("pause-requested");
    expect(settled.steps[1]?.state).toBe("completed");
    expect(
      reasonOf(
        applyAgentPlanEvent(
          planFor("waiting-for-approval"),
          { type: "step", revision: 1, index: 1, state: "completed" },
          AT
        )
      )
    ).toBe("wrong-status");
    expect(
      reasonOf(
        applyAgentPlanEvent(
          planFor("paused"),
          { type: "step", revision: 1, index: 1, state: "completed" },
          AT
        )
      )
    ).toBe("wrong-status");
  });
});

describe("terminal closure and completion", () => {
  test("each terminal transition closes pending and in-progress steps", () => {
    for (const [event, status] of [
      [{ type: "complete" }, "completed"],
      [{ type: "cancel" }, "cancelled"],
      [{ type: "fail" }, "failed"],
      [{ type: "expire" }, "expired"]
    ] as [AgentPlanEvent, AgentPlanStatus][]) {
      const plan = planFor("running", {
        steps: [
          { text: "Done", state: "completed" },
          { text: "Open", state: "in-progress" },
          { text: "Waiting", state: "pending" }
        ]
      });
      const result = take(applyAgentPlanEvent(plan, event, AT));
      expect(result.status).toBe(status);
      expect(result.steps.map((step) => step.state)).toEqual([
        "completed",
        "not-completed",
        "not-completed"
      ]);
      expect(result.steps.every((step) => step.state !== "pending" && step.state !== "in-progress")).toBe(
        true
      );
    }
  });

  test("completion needs one confirmed step", () => {
    expect(
      reasonOf(
        applyAgentPlanEvent(
          planFor("running", {
            steps: [
              { text: "One", state: "pending" },
              { text: "Two", state: "pending" }
            ]
          }),
          { type: "complete" },
          AT
        )
      )
    ).toBe("no-completed-step");
    const result = take(
      applyAgentPlanEvent(
        planFor("running", {
          steps: [
            { text: "One", state: "completed" },
            { text: "Two", state: "pending" }
          ]
        }),
        { type: "complete" },
        AT
      )
    );
    expect(result.status).toBe("completed");
    expect(result.steps.map((step) => step.state)).toEqual(["completed", "not-completed"]);
  });
});

describe("revision and guidance", () => {
  test("start and step events name the current revision", () => {
    expect(
      reasonOf(applyAgentPlanEvent(planFor("proposed"), { type: "start", revision: 2 }, AT))
    ).toBe("stale-revision");
    expect(
      reasonOf(
        applyAgentPlanEvent(
          planFor("running"),
          { type: "step", revision: 2, index: 1, state: "in-progress" },
          AT
        )
      )
    ).toBe("stale-revision");
  });

  test("a refresh increments exactly one revision and keeps the proposal", () => {
    const original = planFor("proposed", { guidance: "Keep the tense." });
    const refreshed = take(refreshAgentPlanProposal(original, { revision: 2, guidance: "Past tense." }, AT));
    expect(refreshed.revision).toBe(2);
    expect(refreshed.status).toBe("proposed");
    expect(refreshed.guidance).toBe("Past tense.");
    expect(refreshed.updatedAt).toBe(AT);
    expect(refreshed.id).toBe(original.id);
    expect(refreshed.purpose).toBe(original.purpose);
    expect(refreshed.steps).toEqual(original.steps);
    expect(refreshed.parent).toEqual(original.parent);
    expect(refreshed.createdAt).toBe(original.createdAt);

    const withoutGuidance = take(refreshAgentPlanProposal(original, { revision: 2 }, AT));
    expect(withoutGuidance.guidance).toBeUndefined();
  });

  test("a stale, overflowing or non-proposed refresh is refused", () => {
    const original = planFor("proposed");
    expect(reasonOf(refreshAgentPlanProposal(original, { revision: 1 }, AT))).toBe("invalid-revision");
    expect(reasonOf(refreshAgentPlanProposal(original, { revision: 3 }, AT))).toBe("invalid-revision");
    expect(
      reasonOf(
        refreshAgentPlanProposal(
          planFor("proposed", { revision: Number.MAX_SAFE_INTEGER }),
          { revision: Number.MAX_SAFE_INTEGER, guidance: "Too late." },
          AT
        )
      )
    ).toBe("invalid-revision");
    expect(reasonOf(refreshAgentPlanProposal(planFor("running"), { revision: 2 }, AT))).toBe(
      "wrong-status"
    );
    expect(reasonOf(refreshAgentPlanProposal(planFor("completed"), { revision: 2 }, AT))).toBe(
      "wrong-status"
    );
  });

  test("blank and over-bound guidance is refused without truncation", () => {
    const original = planFor("proposed");
    expect(
      reasonOf(refreshAgentPlanProposal(original, { revision: 2, guidance: "   " }, AT))
    ).toBe("invalid-guidance");
    expect(
      reasonOf(
        refreshAgentPlanProposal(original, { revision: 2, guidance: "x".repeat(2_001) }, AT)
      )
    ).toBe("invalid-guidance");
    const exact = take(
      refreshAgentPlanProposal(original, { revision: 2, guidance: "x".repeat(2_000) }, AT)
    );
    expect(exact.guidance).toHaveLength(2_000);
  });
});

describe("unknown fields", () => {
  test("unknown plan, step and parent fields survive every transition", () => {
    const plan = planFor("running", {
      futurePlan: "keep the plan field",
      steps: [
        { text: "One", state: "completed", futureStep: "keep the step field" },
        { text: "Two", state: "pending", futureStep: "and this one" }
      ],
      parent: {
        messageId: "msg_test0001",
        turnId: "turn_test0001",
        futureParent: "keep the parent field"
      }
    });
    const stepped = take(
      applyAgentPlanEvent(plan, { type: "step", revision: 1, index: 1, state: "in-progress" }, AT)
    ) as TestPlan;
    expect(stepped.futurePlan).toBe("keep the plan field");
    expect(stepped.parent.futureParent).toBe("keep the parent field");
    expect(stepped.steps[0]?.futureStep).toBe("keep the step field");
    expect(stepped.steps[1]?.futureStep).toBe("and this one");
    expect(stepped.steps[1]?.state).toBe("in-progress");

    const cancelled = take(applyAgentPlanEvent(stepped, { type: "cancel" }, AT)) as TestPlan;
    expect(cancelled.futurePlan).toBe("keep the plan field");
    expect(cancelled.parent.futureParent).toBe("keep the parent field");
    expect(cancelled.steps[1]?.futureStep).toBe("and this one");
  });
});

describe("the module boundary", () => {
  const source = readFileSync(new URL("../../src/agent/plan-state.ts", import.meta.url), "utf8");

  test("loads only the shared guidance bound and reads no clock", () => {
    expect(source.match(/^import\b/gm)?.length ?? 0).toBe(1);
    expect(source).toMatch(/^import \{ PLAN_GUIDANCE_LIMIT \} from "\.\/proposed-plan";$/m);
    expect(source).not.toMatch(/from\s+["'][^"']*messages/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/runtime\.now/);
    expect(source).not.toMatch(/\bnode:/);
    expect(source).not.toMatch(/\bwriteFile\b|\bcommitFile\b/);
  });

  test("the durable vocabulary is one status narrower than the proposal vocabulary", () => {
    const proposals = PLAN_STATUSES.filter((status) => status !== "started");
    expect([...AGENT_PLAN_STATUSES]).toEqual([...proposals]);
    expect(AGENT_PLAN_STATUSES).not.toContain("started");
    expect([...AGENT_PLAN_STEP_STATES]).toEqual([...PLAN_STEP_STATES]);
    expect(AGENT_PLAN_LIMITS.guidance).toBe(PLAN_GUIDANCE_LIMIT);
    expect(Object.isFrozen(AGENT_PLAN_LIMITS)).toBe(true);
  });
});
