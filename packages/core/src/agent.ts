import type { ContextBreakdown } from "./agent/context";
import type { CostBasis } from "./providers/usage";
import type { AgentMode, AgentPlanStatus } from "./agent/messages";
import type { AgentPlanTurnRef } from "./agent/turn";

export interface AgentTurnInput {
  bookId: string;
  /** The chapter the author is looking at. The agent may still read or edit others. */
  chapterId?: string | null | undefined;
  prompt: string;
  /**
   * The permission level of this turn. Required so a turn can never run on an
   * assumed level; callers that predate modes send `edit`, which preserves
   * the previous full-tool behavior until the composer chooses otherwise.
   */
  mode: AgentMode;
  /**
   * Optional one-turn guidance, sent with the prompt and stored with the
   * turn. Bounded at the schema; oversize input is rejected, never
   * truncated, and nothing carries it into the next turn.
   */
  guidance?: string | undefined;
  /**
   * A plan continuation. Absent on an ordinary turn. A plan turn is Edit-only,
   * needs an existing thread, and carries identity only: no purpose, steps,
   * guidance, model, tool list or approval travels inside this object.
   */
  plan?: AgentPlanTurnRef | undefined;
  /**
   * Select the read-only Edit proposal turn. It offers the read tools and `propose_plan` only:
   * no book write, no checkpoint and no plan content. A plan is stored only when the proposal is
   * valid and its assistant message was saved. Never combine it with `plan`.
   */
  planProposal?: boolean | undefined;
  /** Continue this conversation. Omit to start a new one. */
  threadId?: string | null | undefined;
  /**
   * A one-off connection and model for this turn. The book default is unchanged; the runtime
   * validates the model and records it on the stored turn.
   */
  model?: { connectionId: string; modelId: string } | undefined;
  /**
   * Keep the turn running when the window closes and notify the author when it finishes. The
   * desktop main process owns the turn either way; this flag makes the intent explicit.
   */
  background?: boolean | undefined;
  /**
   * Plain text of earlier turns, used only when a new thread starts without stored history.
   * A stored thread is the source of truth once it exists.
   */
  history?: Array<{ role: "user" | "assistant"; text: string }> | undefined;
}

export interface AgentTurnStarted {
  turnId: string;
  /** The conversation that now contains this turn. */
  threadId: string;
  /** The fixed permission level this turn runs under. */
  mode: AgentMode;
  /**
   * Present only when this turn continues a stored plan. The status is the
   * confirmed stored status after the start/resume write: "running".
   * `revision` is the revision the author reviewed.
   */
  plan?: { id: string; revision: number; status: "running" } | undefined;
}

/** The answer to a turn, for a caller that waited for it rather than watching the stream. */
export interface AgentTurnResult {
  turnId: string;
  threadId: string;
  /** What the agent said. Empty when the turn was stopped. */
  text: string;
  /** How many chapters the turn changed. */
  changed: number;
  /** The turn's cost, when the provider reported one. */
  costUsd?: number | null;
  /** True when the author stopped the turn. */
  stopped?: boolean;
  /** Whether the runtime confirmed a checkpoint covering the recorded changes. */
  undoAvailable?: boolean;
  /** Local outcome/usage persistence failed; the answer and recorded book effects still stand. */
  persistenceError?: string;
}

/** What one undo of an agent turn did. */
export interface AgentUndoResult {
  /** Chapters put back the way the turn found them. */
  restored: number;
  /** Chapters left as they are, because they changed during or after the turn or could not be put back. */
  skipped: number;
  /**
   * Conflict copies undo kept before restoring a chapter someone else wrote in during the turn.
   * Present only when there is one.
   */
  kept?: Array<{ chapterId: string; title: string; savedAs: string }>;
  /** One sentence for each chapter that did not simply go back, naming it. Present only when there is one. */
  notes?: string[];
}

/** The model a turn actually ran with, independent of what is selected now. */
export interface AgentTurnModel {
  provider: string;
  modelId: string;
  connectionLabel: string;
  /** The catalogue's display name, so the conversation can name the model in plain words. */
  name?: string;
}

/**
 * The stored plan transitions a live turn may announce. `start` and `resume` are turn-start
 * acknowledgments, not mid-turn notices, and expiry has no live turn to own an event.
 */
export type AgentPlanChange =
  | "proposed"
  | "request-approval"
  | "approval-settled"
  | "request-pause"
  | "confirm-pause"
  | "complete"
  | "cancel"
  | "fail";

/**
 * A confirmed plan state change. A `plan` or `plan-step` notice is published only after the
 * matching store write applied; a refused or failed write publishes `plan-error`.
 */
export type AgentPlanNotice =
  | {
      type: "plan";
      turnId: string;
      planId: string;
      revision: number;
      status: AgentPlanStatus;
      change: AgentPlanChange;
    }
  | {
      type: "plan-step";
      turnId: string;
      planId: string;
      revision: number;
      status: "running" | "pause-requested";
      index: number;
      state: "in-progress" | "completed" | "not-completed";
    }
  | {
      type: "plan-error";
      turnId: string;
      planId: string;
      revision: number;
      change: AgentPlanChange | "step";
      message: string;
    };

export type AgentEvent =
  | { type: "stopping"; turnId: string }
  | { type: "text"; turnId: string; delta: string }
  | { type: "reasoning"; turnId: string; delta: string }
  | {
      type: "tool";
      turnId: string;
      id: string;
      name: string;
      status: "start" | "end";
      detail?: string;
      input?: unknown;
      output?: unknown;
    }
  | {
      type: "approval";
      turnId: string;
      approvalId: string;
      name: string;
      input: unknown;
      /** The plan this live approval belongs to, when the turn is plan-linked. */
      planId?: string;
      planRevision?: number;
    }
  | {
      type: "done";
      turnId: string;
      text: string;
      model: AgentTurnModel;
      inputTokens: number;
      outputTokens: number;
      costUsd: number | null;
      costBasis: CostBasis;
      contextLength: number | null;
      context: ContextBreakdown;
      changed?: number;
      undoAvailable?: boolean;
      persistenceError?: string;
    }
  | { type: "stopped"; turnId: string; changed?: number; undoAvailable?: boolean; persistenceError?: string }
  | { type: "error"; turnId: string; code: string; message: string; changed?: number; undoAvailable?: boolean; retryAfterSeconds?: number; persistenceError?: string }
  | AgentPlanNotice;

export {
  AGENT_TURN_REFUSAL_MESSAGES,
  AgentTurnRefusedError,
  agentPlanTurnRefSchema,
  agentTurnRefused,
  effectivePlanTurnGuidance,
  type AgentPlanTurnRef,
  type AgentTurnRefusal,
  type EffectivePlanTurnGuidance
} from "./agent/turn";
export type { AgentPlanStatus } from "./agent/messages";
