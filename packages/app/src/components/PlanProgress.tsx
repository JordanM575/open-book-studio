import { useEffect, useRef, useState } from "react";
import type {
  AgentPlan,
  AgentPlanStatus,
  AgentPlanStepState
} from "@ai-book-studio/core/agent/messages";
import { Button } from "@ai-book-studio/ui/button";

/**
 * The stored plan as the author reviews it.
 *
 * A plan is a proposal, not a permission: this card only reads the confirmed plan the thread
 * store returned. It never infers progress from text, a local draft, or a tool name. Start,
 * Pause, Resume and Cancel are explicit author actions; Pause is the existing Stop made plan-aware
 * and Paused appears only after the turn's terminal stopped event. Cancel is terminal and never
 * claims an undo: completed steps and book changes stay.
 */

const STATUS_LABEL: Record<AgentPlanStatus, string> = {
  proposed: "Proposed",
  running: "Running",
  "waiting-for-approval": "Waiting for approval",
  "pause-requested": "Pause requested",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  expired: "Expired"
};

const STEP_LABEL: Record<AgentPlanStepState, string> = {
  pending: "Pending",
  "in-progress": "In progress",
  completed: "Completed",
  "not-completed": "Not completed"
};

export interface PlanStartRef {
  readonly id: string;
  readonly revision: number;
  readonly action: "start";
}

export interface PlanResumeRef {
  readonly id: string;
  readonly revision: number;
  readonly action: "resume";
}

export interface PlanActionOutcome {
  readonly ok: boolean;
  readonly reason?: string;
}

/** The terminal stopped event's change and undo facts, shown only on a confirmed pause. */
export interface PlanPauseSummary {
  readonly changed: number;
  readonly undoAvailable?: boolean;
}

/** The terminal stopped event's change and undo facts for a cancel this window confirmed. */
export interface PlanCancelSummary {
  readonly changed: number;
  readonly undoAvailable?: boolean;
}

export interface PlanCancelRef {
  readonly id: string;
}

interface Props {
  readonly plan: AgentPlan;
  /** A turn is running, so Start waits for it to stop. */
  readonly running: boolean;
  /** This window holds the confirmed plan turn, so Pause is offered. */
  readonly live?: boolean;
  /** A stop was requested and its terminal event has not arrived. */
  readonly stopping?: boolean;
  /** The Resume send is in flight, before the running acknowledgement. */
  readonly resuming?: boolean;
  /** The stopped event's facts for a pause this window confirmed. */
  readonly pauseSummary?: PlanPauseSummary | null;
  /** A cancel is in flight or was confirmed and its terminal event has not arrived. */
  readonly cancelling?: boolean;
  /** The stopped event's facts for a cancel this window confirmed. */
  readonly cancelSummary?: PlanCancelSummary | null;
  /** The model the Start turn will use, named plainly. There is no second chooser here. */
  readonly modelLabel?: string;
  /** A confirmed plan-write error, shown without changing the last confirmed state. */
  readonly notice?: string | null | undefined;
  /** Omitted in a read-only review surface. */
  readonly onStart?: (ref: PlanStartRef) => PlanActionOutcome | Promise<PlanActionOutcome>;
  /** Pause the live plan turn through the existing Stop path. */
  readonly onPause?: () => void;
  /** Resume a paused plan as one explicit new Edit turn. */
  readonly onResume?: (ref: PlanResumeRef) => PlanActionOutcome | Promise<PlanActionOutcome>;
  /** Cancel this plan terminally. A live turn stops; completed edits stay. */
  readonly onCancel?: (ref: PlanCancelRef) => PlanActionOutcome | Promise<PlanActionOutcome>;
}

function isTerminalStatus(status: AgentPlanStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed" || status === "expired";
}

function pauseFacts(summary: PlanPauseSummary | null | undefined): string {
  if (!summary || summary.changed <= 0) return "";
  const chapters = summary.changed === 1 ? "chapter" : "chapters";
  return ` · ${summary.changed} ${chapters} changed · ${summary.undoAvailable
    ? "undo available"
    : "no undo checkpoint"}`;
}

function cancelLabel(
  plan: AgentPlan,
  summary: PlanCancelSummary | null | undefined
): string {
  const completed = plan.steps.filter((step) => step.state === "completed").length;
  const total = plan.steps.length;
  const steps = `Cancelled · ${completed} of ${total} ${total === 1 ? "step" : "steps"} completed`;
  if (!summary) return steps;
  if (summary.changed <= 0) return `${steps} · no book changes`;
  const chapters = summary.changed === 1 ? "chapter" : "chapters";
  return `${steps} · ${summary.changed} ${chapters} changed · ${summary.undoAvailable
    ? "undo available"
    : "no undo checkpoint"}`;
}

export function PlanProgress({
  plan,
  running,
  live = false,
  stopping = false,
  resuming = false,
  pauseSummary,
  cancelling = false,
  cancelSummary,
  modelLabel,
  notice,
  onStart,
  onPause,
  onResume,
  onCancel
}: Props) {
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [resumeFailure, setResumeFailure] = useState<string | null>(null);
  const [cancelFailure, setCancelFailure] = useState<string | null>(null);
  const [cancelConfirming, setCancelConfirming] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const restoreCancelFocus = useRef(false);
  const canStart = plan.status === "proposed" && !running && Boolean(onStart);
  // Pause stays mounted while its stop is open, disabled, so focus and the state stay announced.
  // The request-pause notice changes the stored status to `pause-requested`; the open stop keeps
  // the control mounted until the terminal event.
  const pauseOffered = Boolean(onPause) && live &&
    (plan.status === "running" || plan.status === "waiting-for-approval" ||
      (stopping && plan.status === "pause-requested"));
  const canPause = pauseOffered && !stopping && !starting && !resuming && !cancelling;
  const resumeAvailable = Boolean(onResume) && plan.status === "paused" && !running && !stopping;
  const resumeOffered = resumeAvailable && !resuming;
  const canResume = resumeOffered && !starting && !cancelling;
  const paused = plan.status === "paused";
  const cancelBusy = cancelling || cancelSubmitting;
  // A live-only action is not offered after a reload: the main process is still the authority.
  const cancelOffered = Boolean(onCancel) && !isTerminalStatus(plan.status) &&
    (plan.status === "proposed" || plan.status === "paused" || plan.status === "pause-requested" ||
      ((plan.status === "running" || plan.status === "waiting-for-approval") && live));
  const canCancel = cancelOffered && !starting && !resuming && !cancelBusy;
  const cancelled = plan.status === "cancelled";

  // The inline confirmation belongs to one plan status; a new plan, a status change or a started
  // cancel closes it. The effect intentionally keys on props it does not read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the inline confirmation on a plan or cancel change
  useEffect(() => {
    setCancelConfirming(false);
  }, [plan.id, plan.status, cancelling]);

  useEffect(() => {
    if (cancelConfirming || !restoreCancelFocus.current) return;
    restoreCancelFocus.current = false;
    cancelButtonRef.current?.focus();
  }, [cancelConfirming]);

  const cancelStatus = cancelled ? cancelLabel(plan, cancelSummary) : "";
  const statusLabel = isTerminalStatus(plan.status)
    ? cancelled && cancelling
      ? "Cancelled · finishing in-flight work…"
      : cancelled
        ? cancelStatus
        : STATUS_LABEL[plan.status]
    : cancelling
      ? "Cancelling…"
      : stopping
        ? "Stopping…"
        : plan.status === "pause-requested"
          ? "Pause not confirmed"
          : STATUS_LABEL[plan.status];
  const pauseDetail = paused
    ? `${pauseFacts(pauseSummary)}${resuming ? " · Resuming…" : ""}`
    : "";

  const start = async (): Promise<void> => {
    if (!onStart || !canStart || starting) return;
    setStarting(true);
    setFailure(null);
    try {
      const outcome = await onStart({ id: plan.id, revision: plan.revision, action: "start" });
      if (outcome && !outcome.ok) {
        setFailure(outcome.reason ?? "The plan could not be started. Nothing changed.");
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The plan could not be started. Nothing changed.");
    } finally {
      setStarting(false);
    }
  };

  const resume = async (): Promise<void> => {
    if (!onResume || !canResume || resuming) return;
    setResumeFailure(null);
    try {
      const outcome = await onResume({ id: plan.id, revision: plan.revision, action: "resume" });
      if (outcome && !outcome.ok) {
        setResumeFailure(outcome.reason ?? "The plan could not be resumed. Nothing changed.");
      }
    } catch (error) {
      setResumeFailure(error instanceof Error ? error.message : "The plan could not be resumed. Nothing changed.");
    }
  };

  const keepPlan = (): void => {
    restoreCancelFocus.current = true;
    setCancelConfirming(false);
  };

  const cancel = async (): Promise<void> => {
    if (!onCancel || !canCancel || cancelBusy) return;
    setCancelConfirming(false);
    setCancelFailure(null);
    setCancelSubmitting(true);
    try {
      const outcome = await onCancel({ id: plan.id });
      if (outcome && !outcome.ok) {
        setCancelFailure(outcome.reason ?? "The plan could not be cancelled. Nothing changed.");
      }
    } catch (error) {
      setCancelFailure(error instanceof Error ? error.message : "The plan could not be cancelled. Nothing changed.");
    } finally {
      setCancelSubmitting(false);
    }
  };

  return (
    <article
      data-testid="plan-card"
      data-plan-id={plan.id}
      data-plan-status={plan.status}
      className="space-y-2 rounded-[var(--corner-md)] border border-[var(--border)] bg-[var(--card)] p-3 text-sm text-foreground"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-medium">Stored plan</h3>
        <p data-testid="plan-status" className="text-xs text-muted-foreground">
          {statusLabel}
          {starting ? " · Starting…" : ""}
          {pauseDetail}
        </p>
      </div>
      <p data-testid="plan-revision" className="text-xs text-muted-foreground">
        Revision {plan.revision} · Edit plan
      </p>
      {modelLabel ? (
        <p data-testid="plan-model" className="text-xs text-muted-foreground">
          {modelLabel}
        </p>
      ) : null}
      <p data-testid="plan-purpose-text" className="whitespace-pre-wrap">{plan.purpose}</p>
      <ol className="list-decimal space-y-1 pl-5">
        {plan.steps.map((step, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: stored plan steps have no id; the plan id and revision scope the index
            key={`${plan.id}-${plan.revision}-${index}`}
            data-testid="plan-step-row"
          >
            <span data-testid="plan-step-text" className="whitespace-pre-wrap">{step.text}</span>
            {" "}
            <span data-testid="plan-step-state" data-state={step.state} className="text-xs text-muted-foreground">
              {STEP_LABEL[step.state]}
            </span>
          </li>
        ))}
      </ol>
      {cancelled ? (
        <p data-testid="plan-cancel-note" className="text-xs text-muted-foreground">
          Completed steps stay. Cancel does not undo them.
        </p>
      ) : null}
      {plan.guidance !== undefined ? (
        <p data-testid="plan-guidance-text" className="whitespace-pre-wrap text-xs text-muted-foreground">
          {plan.guidance}
        </p>
      ) : (
        <p data-testid="plan-guidance-omitted" className="text-xs text-muted-foreground">No plan guidance</p>
      )}
      {notice ? <p role="alert" data-testid="plan-notice" className="text-xs text-[var(--destructive-text)]">{notice}</p> : null}
      {failure ? <p role="alert" data-testid="plan-action-error" className="text-xs text-[var(--destructive-text)]">{failure}</p> : null}
      {resumeFailure ? <p role="alert" data-testid="plan-resume-error" className="text-xs text-[var(--destructive-text)]">{resumeFailure}</p> : null}
      {cancelFailure ? <p role="alert" data-testid="plan-cancel-error" className="text-xs text-[var(--destructive-text)]">{cancelFailure}</p> : null}
      {canStart ? (
        <p className="text-xs text-muted-foreground">
          Start creates a new Edit turn. Your composer choice stays as it is, and destructive actions still ask for approval.
        </p>
      ) : null}
      {canStart ? (
        <Button
          variant="primary"
          size="sm"
          disabled={starting}
          data-testid="plan-start"
          onClick={() => void start()}
        >
          Start plan
        </Button>
      ) : null}
      {pauseOffered ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={!canPause}
          aria-label={stopping ? "Stopping… Waiting for in-flight work to settle." : "Pause plan"}
          data-testid="plan-pause"
          onClick={() => onPause?.()}
        >
          Pause plan
        </Button>
      ) : null}
      {resumeAvailable ? (
        <p className="text-xs text-muted-foreground">
          Resume creates a new Edit turn. Approvals are asked again; nothing is pre-approved.
        </p>
      ) : null}
      {resumeOffered ? (
        <Button
          variant="primary"
          size="sm"
          disabled={!canResume}
          data-testid="plan-resume"
          onClick={() => void resume()}
        >
          Resume plan
        </Button>
      ) : null}
      {cancelOffered ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Cancel ends this plan and stops its later steps. Completed edits stay; Cancel does not undo them.
            Cancel does not allow or deny any action.
          </p>
          {!live ? (
            <p className="text-xs text-muted-foreground">It does not stop another turn.</p>
          ) : null}
          {cancelConfirming ? (
            <fieldset
              aria-label="Cancel this plan?"
              data-testid="plan-cancel-confirmation"
              className="border-0 p-0"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                keepPlan();
              }}
            >
              <p className="text-xs">Cancel this plan? Completed edits stay; Cancel does not undo them.</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="plan-cancel-confirm"
                  onClick={() => void cancel()}
                >
                  Yes, cancel plan
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="plan-cancel-keep"
                  onClick={keepPlan}
                >
                  Keep plan
                </Button>
              </div>
            </fieldset>
          ) : (
            <Button
              ref={cancelButtonRef}
              variant="secondary"
              size="sm"
              disabled={!canCancel}
              aria-label={cancelBusy ? "Cancelling plan… Waiting for in-flight work to settle." : "Cancel plan"}
              data-testid="plan-cancel"
              onClick={() => {
                if (!canCancel) return;
                setCancelFailure(null);
                setCancelConfirming(true);
              }}
            >
              Cancel plan
            </Button>
          )}
        </div>
      ) : null}
    </article>
  );
}
