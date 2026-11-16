/**
 * A proposed Edit plan before Start plan.
 *
 * The caller supplies the id, the purpose, and the ordered steps. Every new
 * step is pending. Purpose text is kept as supplied; this contract states no
 * purpose character maximum, so none is applied. Guidance uses the same
 * 2,000-character bound as agentGuidanceTextSchema. A string longer than that
 * bound is refused before a blank check, including whitespace, and is not
 * truncated. A blank string within the bound is omitted. A refresh returns a
 * new frozen revision and does not change the previous proposal. A start
 * intent names a new turn for that id and revision and carries no approval.
 * It does not start the turn.
 *
 * The supplied writer is required and is never called. This module does not
 * write, read a clock, or mint a token.
 */

export const PLAN_GUIDANCE_LIMIT = 2_000;

export const PLAN_STEP_STATES = ["pending", "in-progress", "completed", "not-completed"] as const;
export type PlanStepState = (typeof PLAN_STEP_STATES)[number];

export const PLAN_STATUSES = [
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
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_REFUSALS = [
  "empty-purpose",
  "empty-steps",
  "empty-step",
  "discuss-mode",
  "guidance-too-long",
  "not-proposed",
  "unexpected-authority",
  "invalid-proposal"
] as const;
export type PlanRefusal = (typeof PLAN_REFUSALS)[number];

export type ManuscriptWriter = {
  readonly write: (request: unknown) => unknown;
};

export type ProposedPlanStep = {
  readonly text: string;
  readonly state: "pending";
};

export type ProposedPlan = {
  readonly id: string;
  readonly mode: "edit";
  readonly purpose: string;
  readonly steps: readonly ProposedPlanStep[];
  readonly revision: number;
  readonly status: "proposed";
  readonly guidance?: string;
};

export type PlanStartIntent = {
  readonly turn: "new";
  readonly proposalId: string;
  readonly revision: number;
  readonly carriedApproval: false;
};

export type PlanSuccess<T> = {
  readonly ok: true;
  readonly value: T;
};

export type PlanRefusalResult = {
  readonly ok: false;
  readonly code: PlanRefusal;
};

export type PlanResult<T> = PlanSuccess<T> | PlanRefusalResult;

const AUTHORITY_KEYS = ["model", "tools", "toolPermissions", "approvals", "reasoning"] as const;
const CREATE_KEYS = ["id", "mode", "purpose", "steps", "guidance", "status"] as const;
const SNAPSHOT_KEYS = ["id", "mode", "purpose", "steps", "revision", "status", "guidance"] as const;
const STEP_KEYS = ["text", "state"] as const;

type Snapshot = {
  id: string;
  purpose: string;
  steps: readonly string[];
  revision: number;
  guidance: string | null;
};

type GuidanceRead =
  | { kind: "omit" }
  | { kind: "keep"; text: string }
  | { kind: "refuse"; code: PlanRefusal };

function refusal(code: PlanRefusal): PlanRefusalResult {
  return Object.freeze({ ok: false, code });
}

function accepted<T extends object>(value: T): PlanSuccess<T> {
  return Object.freeze({ ok: true, value });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function allows(keys: readonly string[], name: string): boolean {
  return keys.includes(name);
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && allows(PLAN_STATUSES, value);
}

function isPending(value: unknown): boolean {
  const pending = PLAN_STEP_STATES[0];
  return pending !== undefined && value === pending;
}

function writerReady(writer: ManuscriptWriter): boolean {
  if (typeof writer !== "object" || writer === null) return false;
  const own = Object.getOwnPropertyDescriptor(writer, "write");
  const described = own ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(writer), "write");
  if (!described || !("value" in described)) return false;
  return typeof described.value === "function";
}

function screenNames(value: object, keys: readonly string[]): PlanRefusal | null {
  if (Object.getOwnPropertySymbols(value).length > 0) return "invalid-proposal";
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    if (allows(AUTHORITY_KEYS, name)) return "unexpected-authority";
  }
  for (const name of names) {
    if (!allows(keys, name)) return "invalid-proposal";
  }
  return null;
}

function screenList(steps: readonly unknown[]): PlanRefusal | null {
  if (Object.getOwnPropertySymbols(steps).length > 0) return "invalid-proposal";
  const names = Object.getOwnPropertyNames(steps);
  for (const name of names) {
    if (allows(AUTHORITY_KEYS, name)) return "unexpected-authority";
  }
  for (const name of names) {
    if (name === "length") continue;
    if (/^(0|[1-9][0-9]*)$/.test(name) && Number(name) < steps.length) continue;
    return "invalid-proposal";
  }
  return null;
}

function readMode(value: unknown): "edit" | PlanRefusal {
  if (value === "discuss") return "discuss-mode";
  if (value === "edit") return "edit";
  return "invalid-proposal";
}

function readId(value: unknown): string | null {
  if (typeof value !== "string" || blank(value)) return null;
  return value;
}

function readPurpose(value: unknown): { ok: true; purpose: string } | { ok: false; code: PlanRefusal } {
  if (typeof value !== "string") return { ok: false, code: "invalid-proposal" };
  if (blank(value)) return { ok: false, code: "empty-purpose" };
  return { ok: true, purpose: value };
}

function readRevision(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

function readGuidance(value: unknown): GuidanceRead {
  if (value === undefined || value === null) return { kind: "omit" };
  if (typeof value !== "string") return { kind: "refuse", code: "invalid-proposal" };
  if (value.length > PLAN_GUIDANCE_LIMIT) return { kind: "refuse", code: "guidance-too-long" };
  if (blank(value)) return { kind: "omit" };
  return { kind: "keep", text: value };
}

function readStep(value: unknown, stored: boolean): { ok: true; text: string } | { ok: false; code: PlanRefusal } {
  if (!stored && typeof value === "string") {
    if (blank(value)) return { ok: false, code: "empty-step" };
    return { ok: true, text: value };
  }
  if (!isRecord(value)) return { ok: false, code: "invalid-proposal" };
  const screened = screenNames(value, STEP_KEYS);
  if (screened) return { ok: false, code: screened };
  if (stored && !has(value, "state")) return { ok: false, code: "invalid-proposal" };
  if (has(value, "state") && !isPending(value.state)) return { ok: false, code: "invalid-proposal" };
  if (typeof value.text !== "string") return { ok: false, code: "invalid-proposal" };
  if (blank(value.text)) return { ok: false, code: "empty-step" };
  return { ok: true, text: value.text };
}

function readSteps(value: unknown, stored: boolean): { ok: true; texts: string[] } | { ok: false; code: PlanRefusal } {
  if (!Array.isArray(value)) return { ok: false, code: "invalid-proposal" };
  const steps = value as readonly unknown[];
  const screened = screenList(steps);
  if (screened) return { ok: false, code: screened };
  if (steps.length === 0) return { ok: false, code: "empty-steps" };
  const texts: string[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    if (!has(steps, String(index))) return { ok: false, code: "invalid-proposal" };
    const step: unknown = steps[index];
    const read = readStep(step, stored);
    if (!read.ok) return read;
    texts.push(read.text);
  }
  return { ok: true, texts };
}

function sealPlan(input: Snapshot): ProposedPlan {
  const steps = input.steps.map((text) => Object.freeze({
    text,
    state: "pending" as const
  }));
  const frozenSteps = Object.freeze(steps);
  if (input.guidance === null) {
    return Object.freeze({
      id: input.id,
      mode: "edit",
      purpose: input.purpose,
      steps: frozenSteps,
      revision: input.revision,
      status: "proposed"
    });
  }
  return Object.freeze({
    id: input.id,
    mode: "edit",
    purpose: input.purpose,
    steps: frozenSteps,
    revision: input.revision,
    status: "proposed",
    guidance: input.guidance
  });
}

function readCreateStatus(record: Record<string, unknown>): PlanRefusal | null {
  if (!has(record, "status")) return null;
  if (!isPlanStatus(record.status)) return "invalid-proposal";
  if (record.status !== "proposed") return "not-proposed";
  return null;
}

function readSnapshot(value: unknown): { ok: true; snapshot: Snapshot } | { ok: false; code: PlanRefusal } {
  if (!isRecord(value)) return { ok: false, code: "invalid-proposal" };
  const screened = screenNames(value, SNAPSHOT_KEYS);
  if (screened) return { ok: false, code: screened };
  const mode = readMode(value.mode);
  if (mode !== "edit") return { ok: false, code: mode };
  if (!isPlanStatus(value.status)) return { ok: false, code: "invalid-proposal" };
  if (value.status !== "proposed") return { ok: false, code: "not-proposed" };
  const id = readId(value.id);
  if (id === null) return { ok: false, code: "invalid-proposal" };
  const purpose = readPurpose(value.purpose);
  if (!purpose.ok) return purpose;
  const revision = readRevision(value.revision);
  if (revision === null) return { ok: false, code: "invalid-proposal" };
  const steps = readSteps(value.steps, true);
  if (!steps.ok) return steps;
  let guidance: string | null = null;
  if (has(value, "guidance")) {
    if (typeof value.guidance !== "string" || blank(value.guidance) || value.guidance.length > PLAN_GUIDANCE_LIMIT) {
      return { ok: false, code: "invalid-proposal" };
    }
    guidance = value.guidance;
  }
  return {
    ok: true,
    snapshot: { id, purpose: purpose.purpose, steps: steps.texts, revision, guidance }
  };
}

export function createProposedPlan(draft: unknown, writer: ManuscriptWriter): PlanResult<ProposedPlan> {
  if (!writerReady(writer)) return refusal("invalid-proposal");
  if (!isRecord(draft)) return refusal("invalid-proposal");
  const screened = screenNames(draft, CREATE_KEYS);
  if (screened) return refusal(screened);
  const mode = readMode(draft.mode);
  if (mode !== "edit") return refusal(mode);
  const status = readCreateStatus(draft);
  if (status) return refusal(status);
  const id = readId(draft.id);
  if (id === null) return refusal("invalid-proposal");
  const purpose = readPurpose(draft.purpose);
  if (!purpose.ok) return refusal(purpose.code);
  const steps = readSteps(draft.steps, false);
  if (!steps.ok) return refusal(steps.code);
  let guidance: string | null = null;
  if (has(draft, "guidance")) {
    const read = readGuidance(draft.guidance);
    if (read.kind === "refuse") return refusal(read.code);
    if (read.kind === "keep") guidance = read.text;
  }
  return accepted(sealPlan({
    id,
    purpose: purpose.purpose,
    steps: steps.texts,
    revision: 1,
    guidance
  }));
}

export function refreshProposedPlanGuidance(
  proposal: unknown,
  guidance: unknown,
  writer: ManuscriptWriter
): PlanResult<ProposedPlan> {
  if (!writerReady(writer)) return refusal("invalid-proposal");
  const snapshot = readSnapshot(proposal);
  if (!snapshot.ok) return refusal(snapshot.code);
  const read = readGuidance(guidance);
  if (read.kind === "refuse") return refusal(read.code);
  if (snapshot.snapshot.revision === Number.MAX_SAFE_INTEGER) return refusal("invalid-proposal");
  return accepted(sealPlan({
    id: snapshot.snapshot.id,
    purpose: snapshot.snapshot.purpose,
    steps: snapshot.snapshot.steps,
    revision: snapshot.snapshot.revision + 1,
    guidance: read.kind === "keep" ? read.text : null
  }));
}

export function planStartIntent(proposal: unknown, writer: ManuscriptWriter): PlanResult<PlanStartIntent> {
  if (!writerReady(writer)) return refusal("invalid-proposal");
  const snapshot = readSnapshot(proposal);
  if (!snapshot.ok) return refusal(snapshot.code);
  return accepted(Object.freeze({
    turn: "new",
    proposalId: snapshot.snapshot.id,
    revision: snapshot.snapshot.revision,
    carriedApproval: false
  }));
}
