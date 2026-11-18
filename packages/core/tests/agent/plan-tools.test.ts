import { describe, expect, test } from "bun:test";
import {
  PLAN_CONTROL_TOOL_NAMES,
  PLAN_PROPOSAL_RULE,
  PLAN_STEP_DESCRIPTION,
  PLAN_STEP_TOOL_NAME,
  PLAN_TOOL_REFUSALS,
  PLAN_TURN_RULE,
  PROPOSE_PLAN_DESCRIPTION,
  PROPOSE_PLAN_TOOL_NAME,
  isPlanControlTool,
  isPlanStepTool,
  planStepAlreadyFinishedMessage,
  planStepEarlierOpenMessage,
  planStepInProgressMessage,
  planStepInputSchema,
  planToolResultSucceeded,
  proposePlanInputSchema
} from "../../src/agent/plan-tools";
import { AGENT_PLAN_LIMITS } from "../../src/agent/plan-state";

describe("plan_step input", () => {
  test("accepts every integer from 1 through the stored-step limit", () => {
    for (const step of [1, 2, 25, AGENT_PLAN_LIMITS.steps]) {
      expect(planStepInputSchema.parse({ step })).toEqual({ step });
    }
  });

  test("refuses zero, 51, fractions, strings, blanks and every extra key", () => {
    for (const value of [
      { step: 0 },
      { step: AGENT_PLAN_LIMITS.steps + 1 },
      { step: 1.5 },
      { step: Number.NaN },
      { step: "1" },
      { step: "   " },
      { step: null },
      {},
      { step: 1, state: "completed" },
      { step: 1, outcome: "completed" },
      { step: 1, tool: "append_to_chapter" },
      { step: 1, reason: "done" }
    ]) {
      expect(planStepInputSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("propose_plan input", () => {
  const purpose = "Revise the opening scene";
  const steps = ["Read the opening", "Rewrite the door"];

  test("accepts a bounded purpose and one to fifty ordered steps", () => {
    expect(proposePlanInputSchema.parse({ purpose, steps })).toEqual({ purpose, steps });
    expect(proposePlanInputSchema.parse({ purpose: "p".repeat(2_000), steps: ["s".repeat(2_000)] }))
      .toEqual({ purpose: "p".repeat(2_000), steps: ["s".repeat(2_000)] });
    expect(proposePlanInputSchema.parse({
      purpose,
      steps: Array.from({ length: AGENT_PLAN_LIMITS.steps }, (_, index) => `Step ${index + 1}`)
    }).steps).toHaveLength(AGENT_PLAN_LIMITS.steps);
  });

  test("refuses blank, over-bound, empty and extra-key proposals", () => {
    for (const value of [
      { purpose: "", steps },
      { purpose: "   ", steps },
      { purpose: "p".repeat(AGENT_PLAN_LIMITS.purpose + 1), steps },
      { purpose, steps: [] },
      { purpose, steps: ["Read", ""] },
      { purpose, steps: ["Read", "   "] },
      { purpose, steps: ["s".repeat(AGENT_PLAN_LIMITS.stepText + 1)] },
      { purpose, steps: Array.from({ length: AGENT_PLAN_LIMITS.steps + 1 }, (_, index) => `Step ${index}`) },
      { purpose, steps, guidance: "Keep it short" },
      { purpose, steps, id: "plan-1" },
      { purpose, steps, revision: 2 },
      { purpose, steps, parent: { messageId: "msg_1", turnId: "turn_1" } }
    ]) {
      expect(proposePlanInputSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("fixed plan tool contract", () => {
  test("names are exact and both are internal control tools", () => {
    expect(PLAN_STEP_TOOL_NAME).toBe("plan_step");
    expect(PROPOSE_PLAN_TOOL_NAME).toBe("propose_plan");
    expect(PLAN_CONTROL_TOOL_NAMES).toEqual(["plan_step", "propose_plan"]);
    expect(isPlanControlTool("plan_step")).toBe(true);
    expect(isPlanControlTool("propose_plan")).toBe(true);
    expect(isPlanControlTool("append_to_chapter")).toBe(false);
    expect(isPlanStepTool("plan_step")).toBe(true);
    expect(isPlanStepTool("propose_plan")).toBe(false);
  });

  test("the fixed protocol and refusal text is present and non-empty", () => {
    expect(PLAN_STEP_DESCRIPTION.trim().length).toBeGreaterThan(0);
    expect(PROPOSE_PLAN_DESCRIPTION.trim().length).toBeGreaterThan(0);
    expect(PLAN_TURN_RULE).toContain("data, not permission");
    expect(PLAN_TURN_RULE).toContain("never claim a step is complete in text");
    expect(PLAN_PROPOSAL_RULE).toContain("Do not change the book");
    expect(PLAN_PROPOSAL_RULE).toContain("exactly once");
    for (const message of Object.values(PLAN_TOOL_REFUSALS)) {
      expect(message.trim().length).toBeGreaterThan(0);
    }
    expect(planStepEarlierOpenMessage(2)).toContain("Step 2 has not finished yet");
    expect(planStepAlreadyFinishedMessage(3)).toContain("Step 3 is already finished");
    expect(planStepInProgressMessage(4)).toContain("Step 4 is still in progress");
    expect(PLAN_TOOL_REFUSALS.noActiveStep).toContain("plan_step");
  });

  test("only an explicit ok true is a success", () => {
    expect(planToolResultSucceeded({ ok: true, message: "Done." })).toBe(true);
    for (const output of [
      { ok: false },
      { type: "execution-denied" },
      { type: "execution-denied", ok: true },
      new Error("Synthetic"),
      "ok",
      null,
      undefined,
      {},
      { result: { ok: true } }
    ]) {
      expect(planToolResultSucceeded(output)).toBe(false);
    }
  });
});
