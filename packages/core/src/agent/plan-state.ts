/**
 * The durable state of one Edit plan on a conversation.
 *
 * The thread store owns the file; this module owns only the meaning of a status, a step state
 * and the transitions between them. It never reads a clock, never writes, and imports nothing
 * from `messages.ts`, so the schema and the store can share one table without a cycle.
 *
 * A plan begins `proposed`, may start once, and then moves through running, approval waiting,
 * pause request, pause confirmation and resume. Completion, cancellation, failure and expiry are
 * terminal and immutable. Every forward step closes or records observed work; a terminal plan
 * leaves no pending or in-progress step behind.
 */

import { PLAN_GUIDANCE_LIMIT } from "./proposed-plan";

/** The nine stored statuses. `started` is not stored: it has no distinct meaning here. */
export const AGENT_PLAN_STATUSES = [
  "proposed",
  "running",
  "waiting-for-approval",
  "pause-requested",
  "paused",
  "completed",
  "cancelled",
  "failed",
  "expired"
] as const;
export type AgentPlanStatus = (typeof AGENT_PLAN_STATUSES)[number];

/** The four stored step states. A skipped step is `not-completed`; there is no fifth state. */
export const AGENT_PLAN_STEP_STATES = ["pending", "in-progress", "completed", "not-completed"] as const;
export type AgentPlanStepState = (typeof AGENT_PLAN_STEP_STATES)[number];

export const AGENT_PLAN_LIMITS = Object.freeze({
  id: 200,
  purpose: 2_000,
  stepText: 2_000,
  steps: 50,
  plansPerThread: 50,
  guidance: PLAN_GUIDANCE_LIMIT,
  turnId: 80
});

/** The structural part a transition needs; a full stored plan is assignable to it. */
export interface AgentPlanState {
  readonly status: AgentPlanStatus;
  readonly revision: number;
  readonly steps: readonly { readonly text: string; readonly state: AgentPlanStepState }[];
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly terminalAt?: string | undefined;
}

export type AgentPlanEvent =
  | { type: "start"; revision: number }
  | { type: "request-approval" }
  | { type: "approval-settled" }
  | { type: "request-pause" }
  | { type: "confirm-pause" }
  | { type: "resume" }
  | { type: "complete" }
  | { type: "cancel" }
  | { type: "fail" }
  | { type: "expire" }
  | { type: "step"; revision: number; index: number; state: "in-progress" | "completed" | "not-completed" };

export type AgentPlanRefusal =
  | "terminal-plan"
  | "wrong-status"
  | "stale-revision"
  | "step-out-of-range"
  | "step-order"
  | "step-already-in-progress"
  | "step-backward"
  | "no-completed-step"
  | "invalid-revision"
  | "invalid-guidance";

export type AgentPlanEventResult<T extends AgentPlanState> =
  | { outcome: "applied"; plan: T }
  | { outcome: "unchanged" }
  | { outcome: "refused"; reason: AgentPlanRefusal };

const TERMINAL_STATUSES = new Set<AgentPlanStatus>(["completed", "cancelled", "failed", "expired"]);
const STARTABLE_STATUSES = new Set<AgentPlanStatus>(["running", "waiting-for-approval", "pause-requested"]);

const unchanged = <T extends AgentPlanState>(): AgentPlanEventResult<T> => ({ outcome: "unchanged" });

const refused = <T extends AgentPlanState>(reason: AgentPlanRefusal): AgentPlanEventResult<T> => ({
  outcome: "refused",
  reason
});

function isTerminal(status: AgentPlanStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isOpen(step: { readonly state: AgentPlanStepState }): boolean {
  return step.state === "pending" || step.state === "in-progress";
}

/** Spread the previous plan and replace only the fields this transition owns. */
function advance<T extends AgentPlanState>(
  plan: T,
  at: string,
  fields: {
    status: AgentPlanStatus;
    startedAt?: string;
    terminalAt?: string;
    steps?: readonly { readonly text: string; readonly state: AgentPlanStepState }[];
  }
): AgentPlanEventResult<T> {
  return { outcome: "applied", plan: { ...plan, ...fields, updatedAt: at } as T };
}

/** Close every open step to `not-completed` in the same terminal transition. */
function closeSteps<T extends AgentPlanState>(plan: T): T["steps"] {
  return plan.steps.map((step) =>
    step.state === "completed" ? step : { ...step, state: "not-completed" as const }
  ) as T["steps"];
}

function finish<T extends AgentPlanState>(
  plan: T,
  at: string,
  status: "completed" | "cancelled" | "failed" | "expired"
): AgentPlanEventResult<T> {
  if (status === "completed" && !plan.steps.some((step) => step.state === "completed")) {
    return refused("no-completed-step");
  }
  return advance(plan, at, { status, steps: closeSteps(plan), terminalAt: at });
}

function stepEvent<T extends AgentPlanState>(
  plan: T,
  event: Extract<AgentPlanEvent, { type: "step" }>,
  at: string
): AgentPlanEventResult<T> {
  if (event.revision !== plan.revision) return refused("stale-revision");
  if (isTerminal(plan.status)) return refused("terminal-plan");
  if (plan.status !== "running" && plan.status !== "pause-requested") return refused("wrong-status");
  if (!Number.isInteger(event.index) || event.index < 0 || event.index >= plan.steps.length) {
    return refused("step-out-of-range");
  }
  const step = plan.steps[event.index]!;
  if (step.state === event.state) return unchanged();
  if (step.state === "completed" || step.state === "not-completed") return refused("step-backward");
  if (event.state !== "in-progress" && event.state !== "completed" && event.state !== "not-completed") {
    return refused("step-backward");
  }
  if (event.state === "in-progress") {
    if (plan.steps.some((entry, index) => index !== event.index && entry.state === "in-progress")) {
      return refused("step-already-in-progress");
    }
  }
  if (plan.steps.slice(0, event.index).some(isOpen)) return refused("step-order");
  const steps = plan.steps.map((entry, index) =>
    index === event.index ? { ...entry, state: event.state } : entry
  );
  return advance(plan, at, { status: plan.status, steps });
}

export function applyAgentPlanEvent<T extends AgentPlanState>(
  plan: T,
  event: AgentPlanEvent,
  at: string
): AgentPlanEventResult<T> {
  switch (event.type) {
    case "start": {
      if (event.revision !== plan.revision) return refused("stale-revision");
      if (plan.status === "running") return unchanged();
      if (isTerminal(plan.status)) return refused("terminal-plan");
      if (plan.status !== "proposed") return refused("wrong-status");
      return advance(plan, at, { status: "running", startedAt: plan.startedAt ?? at });
    }
    case "request-approval": {
      if (plan.status === "waiting-for-approval") return unchanged();
      if (isTerminal(plan.status)) return refused("terminal-plan");
      if (plan.status !== "running") return refused("wrong-status");
      return advance(plan, at, { status: "waiting-for-approval" });
    }
    case "approval-settled": {
      if (plan.status === "waiting-for-approval") return advance(plan, at, { status: "running" });
      if (plan.status === "proposed") return refused("wrong-status");
      return unchanged();
    }
    case "request-pause": {
      if (plan.status === "pause-requested") return unchanged();
      if (isTerminal(plan.status)) return refused("terminal-plan");
      if (plan.status !== "running" && plan.status !== "waiting-for-approval") {
        return refused("wrong-status");
      }
      return advance(plan, at, { status: "pause-requested" });
    }
    case "confirm-pause": {
      if (plan.status === "paused") return unchanged();
      if (isTerminal(plan.status)) return refused("terminal-plan");
      if (plan.status !== "pause-requested") return refused("wrong-status");
      return advance(plan, at, { status: "paused" });
    }
    case "resume": {
      if (plan.status === "running") return unchanged();
      if (isTerminal(plan.status)) return refused("terminal-plan");
      if (plan.status !== "paused") return refused("wrong-status");
      return advance(plan, at, { status: "running" });
    }
    case "complete": {
      if (plan.status === "completed") return unchanged();
      if (isTerminal(plan.status)) return refused("terminal-plan");
      if (!STARTABLE_STATUSES.has(plan.status)) return refused("wrong-status");
      return finish(plan, at, "completed");
    }
    case "fail": {
      if (plan.status === "failed") return unchanged();
      if (isTerminal(plan.status)) return refused("terminal-plan");
      if (!STARTABLE_STATUSES.has(plan.status)) return refused("wrong-status");
      return finish(plan, at, "failed");
    }
    case "cancel": {
      if (plan.status === "cancelled") return unchanged();
      if (isTerminal(plan.status)) return refused("terminal-plan");
      return finish(plan, at, "cancelled");
    }
    case "expire": {
      if (isTerminal(plan.status)) return unchanged();
      return finish(plan, at, "expired");
    }
    case "step":
      return stepEvent(plan, event, at);
    default:
      return refused("wrong-status");
  }
}

type GuidanceRead = { kind: "omit" } | { kind: "keep"; text: string } | { kind: "refuse" };

function readGuidance(value: string | undefined): GuidanceRead {
  if (value === undefined) return { kind: "omit" };
  if (value.length > AGENT_PLAN_LIMITS.guidance) return { kind: "refuse" };
  if (value.trim().length === 0) return { kind: "refuse" };
  return { kind: "keep", text: value };
}

/**
 * T012's guidance refresh, kept separate from the lifecycle event union: it is the one allowed
 * transition while a plan is still `proposed`. The revision increments by exactly one; a blank or
 * over-bound value and an overflow are refused. The returned plan keeps every field the caller
 * did not change, including unknown plain fields.
 */
export function refreshAgentPlanProposal<T extends AgentPlanState>(
  plan: T,
  input: { revision: number; guidance?: string },
  at: string
): AgentPlanEventResult<T> {
  if (plan.status !== "proposed") return refused("wrong-status");
  if (plan.revision >= Number.MAX_SAFE_INTEGER) return refused("invalid-revision");
  if (input.revision !== plan.revision + 1) return refused("invalid-revision");
  const guidance = readGuidance(input.guidance);
  if (guidance.kind === "refuse") return refused("invalid-guidance");
  const next = { ...plan, status: "proposed" as const, revision: input.revision, updatedAt: at };
  if (guidance.kind === "keep") {
    return { outcome: "applied", plan: { ...next, guidance: guidance.text } as T };
  }
  delete (next as { guidance?: string }).guidance;
  return { outcome: "applied", plan: next as T };
}
