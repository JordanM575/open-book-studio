/**
 * The live plan controller for one Start or Resume turn.
 *
 * The model names a step boundary through `plan_step`; this controller validates that boundary
 * against the stored plan and is the only writer of step state. It records the observed tool
 * results between boundaries and closes a step `completed` only when at least one result succeeded
 * and none failed. Every notice follows an `applied` store write; a refusal or failed write emits
 * `plan-error` and never claims progress.
 *
 * It owns no filesystem access. All plan state goes through the thread store, and the SDK wrappers
 * at the bottom of this module only validate and delegate.
 */

import { tool, type ToolSet } from "ai";
import type { AgentPlanNotice } from "@ai-book-studio/core/agent";
import type { AgentPlan, AgentPlanStepState } from "@ai-book-studio/core/agent/messages";
import type { AgentPlanEvent } from "@ai-book-studio/core/agent/plan-state";
import {
  PLAN_STEP_DESCRIPTION,
  PLAN_STEP_TOOL_NAME,
  PLAN_TOOL_REFUSALS,
  PROPOSE_PLAN_DESCRIPTION,
  PROPOSE_PLAN_TOOL_NAME,
  isPlanControlTool,
  planStepAlreadyFinishedMessage,
  planStepEarlierOpenMessage,
  planStepInProgressMessage,
  planStepInputSchema,
  planToolResultSucceeded,
  proposePlanInputSchema,
  type ProposePlanInput
} from "@ai-book-studio/core/agent/plan-tools";
import { ThreadStoreError, type ThreadStore } from "@ai-book-studio/core/agent/threads";

/** The fixed author-safe sentence for a plan write that could not be saved. */
export const PLAN_STATE_ERROR_MESSAGE =
  "The plan's progress could not be saved. Nothing was marked complete.";

const APPROVAL_WAIT_WRITE_MESSAGE =
  "The plan's approval wait could not be saved. The action was not started.";
const APPROVAL_SETTLED_WRITE_MESSAGE =
  "The plan's approval could not be saved. The action was not started.";
const COMPLETE_WRITE_MESSAGE = "The plan could not be marked complete. Nothing was marked complete.";
const FAIL_WRITE_MESSAGE = "The plan could not be marked failed. Its last confirmed state remains.";

const STEP_WRITE_MESSAGE = "The plan step could not be saved. Nothing was marked complete.";

export type PlanStepResult =
  | { ok: true; step: number; total: number; text: string; purpose?: string }
  | { ok: false; message: string };

export type PlanWriteResult = { ok: true } | { ok: false; message: string };

export type PlanTurnEnd = { ok: true } | { ok: false; message: string };

/** A plan write failed in a path where the turn must end with the fixed plan-state error. */
export class PlanWriteError extends Error {
  constructor(
    message: string,
    readonly change: Extract<AgentPlanNotice, { type: "plan-error" }>["change"]
  ) {
    super(message);
    this.name = "PlanWriteError";
  }
}

export interface PlanProgressOptions {
  store: ThreadStore;
  bookId: string;
  threadId: string;
  turnId: string;
  /** The stored plan as reviewed and confirmed running by the start/resume write. */
  plan: AgentPlan;
  publish: (notice: AgentPlanNotice) => void;
  /** A stop or settled turn never writes plan state. */
  canWrite: () => boolean;
}

interface StepWrite {
  outcome: "applied" | "unchanged" | "failed";
  message?: string;
}

interface CloseResult {
  ok: boolean;
  message?: string;
}

function isOpen(state: AgentPlanStepState): boolean {
  return state === "pending" || state === "in-progress";
}

function writeFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof ThreadStoreError) {
    const message = error.message.trim();
    if (message) return message;
  }
  return fallback;
}

function fallbackFor(event: AgentPlanEvent): string {
  switch (event.type) {
    case "step":
      return STEP_WRITE_MESSAGE;
    case "request-approval":
      return APPROVAL_WAIT_WRITE_MESSAGE;
    case "approval-settled":
      return APPROVAL_SETTLED_WRITE_MESSAGE;
    case "complete":
      return COMPLETE_WRITE_MESSAGE;
    case "fail":
      return FAIL_WRITE_MESSAGE;
    default:
      return PLAN_STATE_ERROR_MESSAGE;
  }
}

export class PlanProgress {
  private plan: AgentPlan;
  private activeIndex: number | null = null;
  private successes = 0;
  private failures = 0;
  private blocked = false;
  private terminal = false;
  private stateError = false;

  constructor(private readonly options: PlanProgressOptions) {
    this.plan = options.plan;
  }

  get planId(): string {
    return this.plan.id;
  }

  get revision(): number {
    return this.plan.revision;
  }

  /** Refuse an ordinary tool when it cannot be attributed to a reviewed step. */
  gateRefusal(): string | null {
    if (this.terminal) return PLAN_TOOL_REFUSALS.planFinished;
    if (this.blocked) return PLAN_TOOL_REFUSALS.planBlocked;
    if (this.activeIndex === null) return PLAN_TOOL_REFUSALS.noActiveStep;
    return null;
  }

  /**
   * Name the beginning of one reviewed step. The runtime, not the model, writes `in-progress`.
   * A duplicate call for the active step is idempotent and writes no notice.
   */
  async beginStep(input: unknown): Promise<PlanStepResult> {
    const parsed = planStepInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, message: PLAN_TOOL_REFUSALS.outOfPlan };
    const step = parsed.data.step;
    if (this.terminal) return { ok: false, message: PLAN_TOOL_REFUSALS.planFinished };
    if (this.blocked) return { ok: false, message: PLAN_TOOL_REFUSALS.planBlocked };
    if (step > this.plan.steps.length) return { ok: false, message: PLAN_TOOL_REFUSALS.outOfPlan };
    if (!this.options.canWrite()) return { ok: false, message: PLAN_TOOL_REFUSALS.planBlocked };

    const index = step - 1;
    if (this.activeIndex === index) return this.stepResult(step);

    if (this.activeIndex !== null) {
      if (index < this.activeIndex) {
        const state = this.plan.steps[index]!.state;
        return {
          ok: false,
          message: state === "completed" || state === "not-completed"
            ? planStepAlreadyFinishedMessage(step)
            : planStepEarlierOpenMessage(this.activeIndex + 1)
        };
      }
      if (index > this.activeIndex + 1) {
        return { ok: false, message: planStepInProgressMessage(this.activeIndex + 1) };
      }
      // The next boundary closes the active step under the observation rule. A step with no
      // observed success never completes; the boundary is refused and the turn-end close fails
      // the plan.
      if (this.failures > 0) return { ok: false, message: PLAN_TOOL_REFUSALS.planBlocked };
      if (this.successes === 0) {
        return { ok: false, message: planStepEarlierOpenMessage(this.activeIndex + 1) };
      }
      const closed = await this.closeActiveStep("completed");
      if (!closed.ok) return { ok: false, message: closed.message ?? PLAN_TOOL_REFUSALS.planBlocked };
    }

    const current = this.plan.steps[index]!;
    if (current.state === "completed" || current.state === "not-completed") {
      return { ok: false, message: planStepAlreadyFinishedMessage(step) };
    }
    const earlier = this.plan.steps.slice(0, index).findIndex((entry) => isOpen(entry.state));
    if (earlier >= 0) return { ok: false, message: planStepEarlierOpenMessage(earlier + 1) };
    const other = this.plan.steps.findIndex(
      (entry, position) => position !== index && entry.state === "in-progress"
    );
    if (other >= 0) return { ok: false, message: planStepInProgressMessage(other + 1) };

    const write = await this.applyPlan({
      type: "step",
      revision: this.plan.revision,
      index,
      state: "in-progress"
    });
    if (write.outcome === "failed") {
      return this.failWrites("step", write.message ?? STEP_WRITE_MESSAGE);
    }
    this.activeIndex = index;
    this.successes = 0;
    this.failures = 0;
    if (write.outcome === "applied") this.publishStep(index, "in-progress");
    return this.stepResult(step);
  }

  /**
   * Record one observed tool result for the active step. The first failure closes the step
   * `not-completed` and fails the plan; later results are not allowed to reopen it.
   */
  async recordResult(name: string, output: unknown): Promise<void> {
    if (isPlanControlTool(name)) return;
    if (this.terminal || this.blocked || this.activeIndex === null) return;
    if (!this.options.canWrite()) return;
    if (planToolResultSucceeded(output)) {
      this.successes += 1;
      return;
    }
    this.failures += 1;
    if (this.failures > 1) return;
    await this.closeActiveStep("not-completed");
    this.blocked = true;
    await this.failPlan();
  }

  /** Write the approval wait before the approval is published. */
  async requestApproval(): Promise<PlanWriteResult> {
    if (this.terminal) return { ok: false, message: PLAN_TOOL_REFUSALS.planFinished };
    if (this.blocked) return { ok: false, message: PLAN_TOOL_REFUSALS.planBlocked };
    if (!this.options.canWrite()) return { ok: false, message: APPROVAL_WAIT_WRITE_MESSAGE };
    const write = await this.applyPlan({ type: "request-approval" });
    if (write.outcome === "failed") {
      this.errorNotice("request-approval", write.message ?? APPROVAL_WAIT_WRITE_MESSAGE);
      this.stateError = true;
      this.blocked = true;
      await this.failPlan();
      return { ok: false, message: APPROVAL_WAIT_WRITE_MESSAGE };
    }
    if (write.outcome === "applied") this.publishPlan("request-approval");
    return { ok: true };
  }

  /** Write the settled wait before the SDK loop resumes. A failure never resumes the action. */
  async approvalSettled(): Promise<PlanWriteResult> {
    if (this.terminal) return { ok: false, message: PLAN_TOOL_REFUSALS.planFinished };
    if (this.blocked) return { ok: false, message: PLAN_TOOL_REFUSALS.planBlocked };
    if (!this.options.canWrite()) return { ok: false, message: APPROVAL_SETTLED_WRITE_MESSAGE };
    const write = await this.applyPlan({ type: "approval-settled" });
    if (write.outcome === "failed") {
      this.errorNotice("approval-settled", write.message ?? APPROVAL_SETTLED_WRITE_MESSAGE);
      this.stateError = true;
      this.blocked = true;
      return { ok: false, message: APPROVAL_SETTLED_WRITE_MESSAGE };
    }
    if (write.outcome === "applied") this.publishPlan("approval-settled");
    return { ok: true };
  }

  /**
   * Close the turn's plan honestly. Complete only when every step is completed and both the last
   * step close and the complete write applied; otherwise fail. A write failure returns the fixed
   * plan-state error for the terminal turn event.
   */
  async endTurn(): Promise<PlanTurnEnd> {
    if (!this.options.canWrite()) return { ok: true };
    if (this.stateError) return { ok: false, message: PLAN_STATE_ERROR_MESSAGE };
    if (this.terminal) return { ok: true };

    if (this.activeIndex !== null) {
      const state = this.successes > 0 && this.failures === 0 ? "completed" : "not-completed";
      const closed = await this.closeActiveStep(state);
      if (!closed.ok) {
        await this.failPlan();
        return { ok: false, message: PLAN_STATE_ERROR_MESSAGE };
      }
      if (state === "not-completed") {
        this.blocked = true;
        await this.failPlan();
        return this.stateError ? { ok: false, message: PLAN_STATE_ERROR_MESSAGE } : { ok: true };
      }
    }

    if (this.plan.steps.every((entry) => entry.state === "completed")) {
      const write = await this.applyPlan({ type: "complete" });
      if (write.outcome === "applied") {
        this.terminal = true;
        this.publishPlan("complete");
        return { ok: true };
      }
      if (write.outcome === "unchanged") {
        this.terminal = true;
        return { ok: true };
      }
      this.errorNotice("complete", write.message ?? COMPLETE_WRITE_MESSAGE);
      this.stateError = true;
      this.blocked = true;
      await this.failPlan();
      return { ok: false, message: PLAN_STATE_ERROR_MESSAGE };
    }

    this.blocked = true;
    await this.failPlan();
    return this.stateError ? { ok: false, message: PLAN_STATE_ERROR_MESSAGE } : { ok: true };
  }

  /**
   * Close the active step by the same observation rule and fail the plan after a provider or tool
   * failure. A stop never calls this.
   */
  async settleOnFailure(): Promise<void> {
    if (!this.options.canWrite()) return;
    if (this.stateError || this.terminal) return;
    if (this.activeIndex !== null) {
      const state = this.successes > 0 && this.failures === 0 ? "completed" : "not-completed";
      await this.closeActiveStep(state);
    }
    if (!this.terminal) await this.failPlan();
  }

  private stepResult(step: number): PlanStepResult {
    const index = step - 1;
    const entry = this.plan.steps[index]!;
    return {
      ok: true,
      ...(index === 0 ? { purpose: this.plan.purpose } : {}),
      step,
      total: this.plan.steps.length,
      text: entry.text
    };
  }

  private async closeActiveStep(state: "completed" | "not-completed"): Promise<CloseResult> {
    const index = this.activeIndex;
    if (index === null) return { ok: true };
    const write = await this.applyPlan({
      type: "step",
      revision: this.plan.revision,
      index,
      state
    });
    this.activeIndex = null;
    this.successes = 0;
    this.failures = 0;
    if (write.outcome === "failed") {
      const message = write.message ?? STEP_WRITE_MESSAGE;
      this.errorNotice("step", message);
      this.stateError = true;
      this.blocked = true;
      return { ok: false, message };
    }
    if (write.outcome === "applied") this.publishStep(index, state);
    return { ok: true };
  }

  private async failWrites(
    change: Extract<AgentPlanNotice, { type: "plan-error" }>["change"],
    message: string
  ): Promise<PlanStepResult> {
    this.errorNotice(change, message);
    this.stateError = true;
    this.blocked = true;
    await this.failPlan();
    return { ok: false, message: PLAN_STATE_ERROR_MESSAGE };
  }

  /** One terminal fail attempt. A refusal is reported, never replaced with a completed claim. */
  private async failPlan(): Promise<void> {
    if (this.terminal) return;
    if (!this.options.canWrite()) return;
    const write = await this.applyPlan({ type: "fail" });
    if (write.outcome === "applied") {
      this.terminal = true;
      this.publishPlan("fail");
      return;
    }
    if (write.outcome === "unchanged") {
      this.terminal = true;
      return;
    }
    this.terminal = true;
    this.stateError = true;
    this.blocked = true;
    this.errorNotice("fail", write.message ?? FAIL_WRITE_MESSAGE);
  }

  private async applyPlan(event: AgentPlanEvent): Promise<StepWrite> {
    if (!this.options.canWrite()) {
      return { outcome: "failed", message: fallbackFor(event) };
    }
    try {
      const applied = await this.options.store.applyPlanEvent(
        this.options.bookId,
        this.options.threadId,
        this.plan.id,
        event
      );
      const stored = applied.thread.plans.find((entry) => entry.id === this.plan.id);
      if (stored) this.plan = stored;
      return { outcome: applied.outcome };
    } catch (error) {
      return { outcome: "failed", message: writeFailureMessage(error, fallbackFor(event)) };
    }
  }

  private publishPlan(change: Extract<AgentPlanNotice, { type: "plan" }>["change"]): void {
    this.options.publish({
      type: "plan",
      turnId: this.options.turnId,
      planId: this.plan.id,
      revision: this.plan.revision,
      status: this.plan.status,
      change
    });
  }

  private publishStep(
    index: number,
    state: Extract<AgentPlanNotice, { type: "plan-step" }>["state"]
  ): void {
    const status: Extract<AgentPlanNotice, { type: "plan-step" }>["status"] =
      this.plan.status === "pause-requested" ? "pause-requested" : "running";
    this.options.publish({
      type: "plan-step",
      turnId: this.options.turnId,
      planId: this.plan.id,
      revision: this.plan.revision,
      status,
      index,
      state
    });
  }

  private errorNotice(
    change: Extract<AgentPlanNotice, { type: "plan-error" }>["change"],
    message: string
  ): void {
    this.options.publish({
      type: "plan-error",
      turnId: this.options.turnId,
      planId: this.plan.id,
      revision: this.plan.revision,
      change,
      message
    });
  }
}

/** The SDK wrapper for `plan_step`. It validates and delegates; it never writes plan state. */
export function planStepTool(progress: PlanProgress): ToolSet[string] {
  return tool({
    description: PLAN_STEP_DESCRIPTION,
    inputSchema: planStepInputSchema,
    execute: async (input) => progress.beginStep(input)
  }) as unknown as ToolSet[string];
}

/** The SDK wrapper for `propose_plan`. It only hands the proposal to the runtime draft. */
export function proposePlanTool(draft: PlanProposalDraft): ToolSet[string] {
  return tool({
    description: PROPOSE_PLAN_DESCRIPTION,
    inputSchema: proposePlanInputSchema,
    execute: async (input) => draft.record(input)
  }) as unknown as ToolSet[string];
}

/** The proposal one read-only turn may produce. The first valid call wins; nothing is stored. */
export class PlanProposalDraft {
  private value: ProposePlanInput | null = null;

  record(input: unknown): { ok: true; message: string } | { ok: false; message: string } {
    if (this.value !== null) {
      return { ok: false, message: PLAN_TOOL_REFUSALS.proposalAlreadyMade };
    }
    const parsed = proposePlanInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, message: PLAN_TOOL_REFUSALS.proposalInvalid };
    }
    this.value = parsed.data;
    return {
      ok: true,
      message: "The plan proposal is ready for the author to review. Nothing was changed."
    };
  }

  get proposal(): ProposePlanInput | null {
    return this.value;
  }
}

export { PLAN_STEP_TOOL_NAME, PROPOSE_PLAN_TOOL_NAME };
