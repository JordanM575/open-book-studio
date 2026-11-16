import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PLAN_GUIDANCE_LIMIT,
  PLAN_STATUSES,
  PLAN_STEP_STATES,
  createProposedPlan,
  planStartIntent,
  refreshProposedPlanGuidance,
  type ManuscriptWriter,
  type PlanResult,
  type ProposedPlan
} from "../../src/agent/proposed-plan";

const sourceUrl = new URL("../../src/agent/proposed-plan.ts", import.meta.url);

function countingWriter(): { writer: ManuscriptWriter; calls(): number } {
  let calls = 0;
  return {
    writer: {
      write(request: unknown): never {
        calls += 1;
        throw new Error(`writer called with ${JSON.stringify(request)}`);
      }
    },
    calls: () => calls
  };
}

function using<T>(run: (writer: ManuscriptWriter) => T): T {
  const pen = countingWriter();
  const result = run(pen.writer);
  expect(pen.calls()).toBe(0);
  return result;
}

function take<T>(result: PlanResult<T>): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "plan-1",
    mode: "edit",
    purpose: "Revise the opening chapter",
    steps: ["Name the chapter", "Revise the opening"],
    ...overrides
  };
}

function proposal(writer: ManuscriptWriter, overrides: Record<string, unknown> = {}): ProposedPlan {
  return take(createProposedPlan(draft(overrides), writer));
}

describe("proposed plan source", () => {
  test("loads nothing, reads no clock, and does not call the writer", () => {
    const source = readFileSync(sourceUrl, "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bfrom\s+["']/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bDate\.now\b|\bnew Date\b/);
    expect(source).not.toMatch(/\bperformance\.now\b/);
    expect(source).not.toMatch(/\bcrypto\b|\brandomUUID\b|\bMath\.random\b/);
    expect(source).not.toMatch(/\bnode:/);
    expect(source).not.toMatch(/\.write\s*\(/);
    expect(source).not.toMatch(/\bsetTimeout\b|\bsetInterval\b|\bfetch\s*\(/);
    const messages = readFileSync(new URL("../../src/agent/messages.ts", import.meta.url), "utf8");
    expect(messages).toContain("export const agentGuidanceTextSchema = z.string().min(1).max(2_000);");
    expect(PLAN_GUIDANCE_LIMIT).toBe(2_000);
  });
});

describe("createProposedPlan", () => {
  test("freezes an Edit proposal with ordered pending steps", () => {
    using((writer) => {
      const steps = ["Revise the opening", "Name the chapter"];
      const created = proposal(writer, {
        id: " plan 1 ",
        purpose: "  Revise the opening chapter  ",
        steps
      });
      steps.push("Add a closing scene");
      const first = steps[0];
      if (first !== undefined) steps[0] = "Changed";
      expect(created).toEqual({
        id: " plan 1 ",
        mode: "edit",
        purpose: "  Revise the opening chapter  ",
        steps: [
          { text: "Revise the opening", state: "pending" },
          { text: "Name the chapter", state: "pending" }
        ],
        revision: 1,
        status: "proposed"
      });
      expect(Object.isFrozen(created)).toBe(true);
      expect(Object.isFrozen(created.steps)).toBe(true);
      const step = created.steps[0];
      expect(step).toBeDefined();
      expect(Object.isFrozen(step)).toBe(true);
      expect(Object.getOwnPropertyNames(step).sort()).toEqual(["state", "text"]);
      expect(() => {
        (created as { purpose: string }).purpose = "Changed";
      }).toThrow();
      expect(created.purpose).toBe("  Revise the opening chapter  ");
    });
  });

  test("accepts a purpose longer than the guidance bound", () => {
    using((writer) => {
      const purpose = `Revise ${"the opening ".repeat(400)}`;
      expect(purpose.length).toBeGreaterThan(PLAN_GUIDANCE_LIMIT);
      const created = proposal(writer, { purpose });
      expect(created.purpose).toBe(purpose);
    });
  });

  test("keeps a long ordered step list as supplied", () => {
    using((writer) => {
      const steps = ["zeta", "alpha", "mu", "beta", "omega", "delta", "gamma", "epsilon"];
      const created = proposal(writer, { steps });
      expect(created.steps.map((step) => step.text)).toEqual(steps);
      expect(created.steps.every((step) => step.state === "pending")).toBe(true);
    });
  });

  test("stores verbatim guidance and omits a blank value", () => {
    using((writer) => {
      const text = ` ${"a".repeat(PLAN_GUIDANCE_LIMIT - 1)}`;
      const created = proposal(writer, { guidance: text });
      expect(created.guidance).toBe(text);
      const cleared = proposal(writer, { guidance: " \n\t " });
      expect("guidance" in cleared).toBe(false);
      const absent = proposal(writer, { guidance: null });
      expect("guidance" in absent).toBe(false);
    });
  });

  test("refuses an empty purpose or an empty step list", () => {
    using((writer) => {
      expect(createProposedPlan(draft({ purpose: "" }), writer)).toEqual({
        ok: false,
        code: "empty-purpose"
      });
      expect(createProposedPlan(draft({ purpose: " \n\t " }), writer)).toEqual({
        ok: false,
        code: "empty-purpose"
      });
      expect(createProposedPlan(draft({ steps: [] }), writer)).toEqual({
        ok: false,
        code: "empty-steps"
      });
      expect(createProposedPlan(draft({ steps: ["Name the chapter", " "] }), writer)).toEqual({
        ok: false,
        code: "empty-step"
      });
    });
  });

  test("refuses Discuss and does not build a proposal", () => {
    using((writer) => {
      expect(createProposedPlan(draft({ mode: "discuss", purpose: "" }), writer)).toEqual({
        ok: false,
        code: "discuss-mode"
      });
      expect(createProposedPlan(draft({ mode: "Discuss" }), writer)).toEqual({
        ok: false,
        code: "invalid-proposal"
      });
    });
  });

  test("refuses authority fields and a step that is not pending", () => {
    using((writer) => {
      for (const key of ["model", "tools", "toolPermissions", "approvals", "reasoning"]) {
        const input = draft();
        Object.defineProperty(input, key, { value: undefined, enumerable: true });
        expect(createProposedPlan(input, writer)).toEqual({ ok: false, code: "unexpected-authority" });
      }
      expect(createProposedPlan(draft({
        steps: [{ text: "Revise the opening", reasoning: "hidden" }]
      }), writer)).toEqual({ ok: false, code: "unexpected-authority" });
      expect(createProposedPlan(draft({
        steps: [{ text: "Revise the opening", state: "completed" }]
      }), writer)).toEqual({ ok: false, code: "invalid-proposal" });
      expect(createProposedPlan(draft({
        steps: [{ text: "Revise the opening", tool: "overwrite_chapter" }]
      }), writer)).toEqual({ ok: false, code: "invalid-proposal" });
    });
  });

  test("refuses guidance over the bound without truncating it", () => {
    using((writer) => {
      const text = "a".repeat(PLAN_GUIDANCE_LIMIT + 1);
      const result = createProposedPlan(draft({ guidance: text }), writer);
      expect(result).toEqual({ ok: false, code: "guidance-too-long" });
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("aaa");
      const spaces = " ".repeat(PLAN_GUIDANCE_LIMIT + 1);
      const spacesResult = createProposedPlan(draft({ guidance: spaces }), writer);
      expect(spacesResult).toEqual({ ok: false, code: "guidance-too-long" });
      expect("value" in spacesResult).toBe(false);
      expect(JSON.stringify(spacesResult)).not.toContain(spaces);
    });
  });

  test("refuses a plan that is not proposed and a writer that cannot write", () => {
    using((writer) => {
      expect(createProposedPlan(draft({ status: "running" }), writer)).toEqual({
        ok: false,
        code: "not-proposed"
      });
      expect(createProposedPlan(draft({ status: "started" }), writer)).toEqual({
        ok: false,
        code: "not-proposed"
      });
      expect(createProposedPlan(draft(), { write: "no" } as unknown as ManuscriptWriter)).toEqual({
        ok: false,
        code: "invalid-proposal"
      });
      expect(createProposedPlan([], writer)).toEqual({ ok: false, code: "invalid-proposal" });
    });
  });
});

describe("refreshProposedPlanGuidance", () => {
  test("returns a new frozen revision and leaves the previous proposal unchanged", () => {
    using((writer) => {
      const created = proposal(writer, { guidance: "Keep the voice" });
      const before = JSON.stringify(created);
      const revised = take(refreshProposedPlanGuidance(created, "  Shorter sentences  ", writer));
      const cleared = take(refreshProposedPlanGuidance(revised, null, writer));
      expect(JSON.stringify(created)).toBe(before);
      expect(created.revision).toBe(1);
      expect(created.guidance).toBe("Keep the voice");
      expect(revised).not.toBe(created);
      expect(revised.revision).toBe(2);
      expect(revised.guidance).toBe("  Shorter sentences  ");
      expect(revised.mode).toBe("edit");
      expect(revised.status).toBe("proposed");
      expect(revised.steps.map((step) => step.text)).toEqual(created.steps.map((step) => step.text));
      expect(revised.steps[0]).not.toBe(created.steps[0]);
      expect(cleared.revision).toBe(3);
      expect("guidance" in cleared).toBe(false);
      expect(revised.guidance).toBe("  Shorter sentences  ");
      expect(Object.isFrozen(revised)).toBe(true);
      expect(Object.isFrozen(cleared.steps)).toBe(true);
    });
  });

  test("refuses guidance over the bound and does not change the proposal", () => {
    using((writer) => {
      const created = proposal(writer);
      const before = JSON.stringify(created);
      const text = "b".repeat(PLAN_GUIDANCE_LIMIT + 1);
      const result = refreshProposedPlanGuidance(created, text, writer);
      expect(result).toEqual({ ok: false, code: "guidance-too-long" });
      expect(JSON.stringify(result)).not.toContain("bbb");
      expect(JSON.stringify(created)).toBe(before);
      const tabs = "\t".repeat(PLAN_GUIDANCE_LIMIT + 1);
      const tabsResult = refreshProposedPlanGuidance(created, tabs, writer);
      expect(tabsResult).toEqual({ ok: false, code: "guidance-too-long" });
      expect(JSON.stringify(tabsResult)).not.toContain(tabs);
      expect(JSON.stringify(created)).toBe(before);
      expect(created.revision).toBe(1);
    });
  });

  test("refuses every status except proposed, including a started plan", () => {
    using((writer) => {
      const created = proposal(writer);
      expect([...PLAN_STATUSES]).toEqual([
        "proposed",
        "running",
        "waiting-for-approval",
        "pause-requested",
        "paused",
        "started",
        "completed",
        "cancelled",
        "failed",
        "expired"
      ]);
      expect([...PLAN_STEP_STATES]).toEqual(["pending", "in-progress", "completed", "not-completed"]);
      for (const status of PLAN_STATUSES) {
        if (status === "proposed") continue;
        expect(refreshProposedPlanGuidance({ ...created, status }, "Keep the voice", writer)).toEqual({
          ok: false,
          code: "not-proposed"
        });
      }
    });
  });

  test("refuses Discuss and any authority or mode change", () => {
    using((writer) => {
      const created = proposal(writer);
      expect(refreshProposedPlanGuidance({ ...created, mode: "discuss" }, "Keep the voice", writer)).toEqual({
        ok: false,
        code: "discuss-mode"
      });
      expect(refreshProposedPlanGuidance(
        { ...created, mode: "discuss", status: "running" },
        "Keep the voice",
        writer
      )).toEqual({ ok: false, code: "discuss-mode" });
      for (const key of ["model", "tools", "toolPermissions", "approvals", "reasoning"]) {
        expect(refreshProposedPlanGuidance({ ...created, [key]: "changed" }, "Keep the voice", writer)).toEqual({
          ok: false,
          code: "unexpected-authority"
        });
      }
      const revised = take(refreshProposedPlanGuidance(created, "Keep the voice", writer));
      expect(Object.getOwnPropertyNames(revised).sort()).toEqual([
        "guidance",
        "id",
        "mode",
        "purpose",
        "revision",
        "status",
        "steps"
      ]);
      expect(revised.mode).toBe("edit");
    });
  });
});

describe("planStartIntent", () => {
  test("names a new turn for the visible revision and carries no approval", () => {
    using((writer) => {
      const created = proposal(writer, { guidance: "Keep the voice" });
      const revised = take(refreshProposedPlanGuidance(created, "Shorter sentences", writer));
      const before = JSON.stringify(revised);
      const intent = take(planStartIntent(revised, writer));
      const earlier = take(planStartIntent(created, writer));
      expect(JSON.stringify(revised)).toBe(before);
      expect(revised.status).toBe("proposed");
      expect(intent).toEqual({
        turn: "new",
        proposalId: "plan-1",
        revision: 2,
        carriedApproval: false
      });
      expect(earlier.revision).toBe(1);
      expect(earlier.carriedApproval).toBe(false);
      expect(Object.isFrozen(intent)).toBe(true);
      expect(Object.getOwnPropertyNames(intent).sort()).toEqual([
        "carriedApproval",
        "proposalId",
        "revision",
        "turn"
      ]);
      expect(() => {
        (intent as { carriedApproval: boolean }).carriedApproval = true;
      }).toThrow();
      expect(intent.carriedApproval).toBe(false);
    });
  });

  test("refuses Discuss, a plan that is not proposed, and carried approval", () => {
    using((writer) => {
      const created = proposal(writer);
      expect(planStartIntent({ ...created, mode: "discuss" }, writer)).toEqual({
        ok: false,
        code: "discuss-mode"
      });
      for (const status of ["running", "paused", "started", "completed", "cancelled", "failed", "expired"] as const) {
        expect(planStartIntent({ ...created, status }, writer)).toEqual({
          ok: false,
          code: "not-proposed"
        });
      }
      expect(planStartIntent({ ...created, carriedApproval: true }, writer)).toEqual({
        ok: false,
        code: "invalid-proposal"
      });
      expect(planStartIntent({ ...created, approvals: ["prior"] }, writer)).toEqual({
        ok: false,
        code: "unexpected-authority"
      });
      expect(planStartIntent({ ...created, model: "other" }, writer)).toEqual({
        ok: false,
        code: "unexpected-authority"
      });
    });
  });
});
