/**
 * The main-process turn contract for plan identity, mode and one-turn guidance.
 *
 * A plan turn is an ordinary explicit Edit turn that names an existing stored plan by id,
 * reviewed revision and an explicit `start` or `resume`. The reference carries identity only:
 * a strict schema refuses purpose, steps, guidance, model, tools or approval keys, so a caller
 * cannot smuggle plan content or authority into a turn. The pure helpers here are shared by the
 * IPC schema, the runtime pre-flight and the contract tests; they never read a clock or write.
 */

import { z } from "zod";
import { ProviderError } from "../providers/types";
import { AGENT_PLAN_LIMITS } from "./plan-state";

/**
 * One continuation of a stored plan. Absent on an ordinary turn. Never new plan content: the
 * stored plan owns its purpose, steps and guidance.
 */
export const agentPlanTurnRefSchema = z
  .object({
    /** The stored plan this turn continues. Never new plan content. */
    id: z
      .string()
      .min(1)
      .max(AGENT_PLAN_LIMITS.id)
      .refine((value) => value.trim().length > 0, "empty plan id"),
    /** The revision the author reviewed. Must equal the stored plan revision. */
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    /** Start a proposed plan or resume a paused one. */
    action: z.enum(["start", "resume"])
  })
  .strict();

export type AgentPlanTurnRef = z.infer<typeof agentPlanTurnRefSchema>;

/**
 * The in-process refusal codes. `plan-state` covers a start/resume write that refused,
 * conflicted, was uncertain or failed; the plan stays at its last confirmed state.
 */
export type AgentTurnRefusal =
  | "invalid-mode"
  | "invalid-plan"
  | "plan-in-discuss"
  | "plan-without-thread"
  | "plan-not-found"
  | "plan-invalid"
  | "plan-stale-revision"
  | "plan-not-startable"
  | "plan-not-resumable"
  | "invalid-guidance"
  | "plan-bounds"
  | "plan-guidance-mismatch"
  | "plan-state";

/**
 * Fixed, author-facing sentences for each refusal. The runtime may keep a store's more specific
 * author-safe sentence for `plan-invalid` and `plan-state`; it never exposes a raw path or stack.
 */
export const AGENT_TURN_REFUSAL_MESSAGES = {
  "invalid-mode": "Choose Discuss or Edit before sending this turn.",
  "invalid-plan": "That plan reference is not valid. Reload the conversation and try again.",
  "plan-in-discuss": "A plan is only available for an Edit turn. Choose Edit, or send this request without a plan.",
  "plan-without-thread": "A plan belongs to a conversation. Open the conversation that holds it before starting it.",
  "plan-not-found": "That plan is not in this conversation. Nothing was started.",
  "plan-invalid": "That plan could not be read. The conversation was left untouched.",
  "plan-stale-revision": "The plan changed since you reviewed it. Review the current revision before starting.",
  "plan-not-startable": "That plan cannot be started. Only a proposed plan can start; a paused plan resumes.",
  "plan-not-resumable": "That plan cannot be resumed. Only a paused plan resumes; a proposed plan starts.",
  "invalid-guidance": "One-turn guidance must contain 1–2,000 characters. Shorten it before sending.",
  "plan-bounds": "That plan is outside the supported size. Nothing was started.",
  "plan-guidance-mismatch": "The plan's guidance does not match this turn. Review the current proposal before starting.",
  "plan-state": "The plan's state could not be saved. The turn did not start; reload before continuing."
} as const satisfies Record<AgentTurnRefusal, string>;

/**
 * A turn refused before it could construct a model, write a user message or call a provider.
 *
 * It extends `ProviderError` so the existing IPC result envelope maps it to `invalid-request`
 * without a new channel; in-process callers and tests read the precise `refusal` code.
 */
export class AgentTurnRefusedError extends ProviderError {
  constructor(
    readonly refusal: AgentTurnRefusal,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super("invalid-request", message, options);
    this.name = "AgentTurnRefusedError";
  }
}

/** Build a refusal with the fixed author-facing sentence for its code. */
export function agentTurnRefused(
  refusal: AgentTurnRefusal,
  options: { cause?: unknown } = {}
): AgentTurnRefusedError {
  return new AgentTurnRefusedError(refusal, AGENT_TURN_REFUSAL_MESSAGES[refusal], options);
}

/** The one-turn guidance a plan turn will use, or the refusal that prevents it. */
export type EffectivePlanTurnGuidance =
  | { readonly ok: true; readonly guidance: string | undefined }
  | {
      readonly ok: false;
      readonly refusal: "invalid-guidance" | "plan-bounds" | "plan-guidance-mismatch";
    };

/**
 * Select the effective guidance for a plan turn.
 *
 * The stored plan guidance is the reviewed proposal's guidance. A plan turn may omit the
 * top-level guidance or repeat the stored text exactly; anything else requires T012's proposal
 * refresh and is refused here. A blank or over-bound value is refused, never truncated.
 */
export function effectivePlanTurnGuidance(
  turnGuidance: string | undefined,
  planGuidance: string | undefined
): EffectivePlanTurnGuidance {
  if (turnGuidance !== undefined && !boundedGuidance(turnGuidance)) {
    return { ok: false, refusal: "invalid-guidance" };
  }
  if (planGuidance !== undefined && !boundedGuidance(planGuidance)) {
    return { ok: false, refusal: "plan-bounds" };
  }
  if (planGuidance === undefined) {
    // Adding unreviewed guidance at Start would change the displayed proposal.
    return turnGuidance === undefined
      ? { ok: true, guidance: undefined }
      : { ok: false, refusal: "plan-guidance-mismatch" };
  }
  if (turnGuidance !== undefined && turnGuidance !== planGuidance) {
    return { ok: false, refusal: "plan-guidance-mismatch" };
  }
  return { ok: true, guidance: planGuidance };
}

function boundedGuidance(value: string): boolean {
  return value.length >= 1 && value.length <= AGENT_PLAN_LIMITS.guidance && value.trim().length > 0;
}
