import { useEffect, useId, useRef, useState } from "react";
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
  /**
   * This process could not mark the stored plan expired. Start and Resume stay off while it is
   * unresolved, and Cancel remains available only where the direct path already allows it.
   */
  readonly stale?: boolean;
  /** Omitted in a read-only review surface. */
  readonly onStart?: (ref: PlanStartRef) => PlanActionOutcome | Promise<PlanActionOutcome>;
  /** Pause the live plan turn through the existing Stop path. */
  readonly onPause?: () => void;
  /** Resume a paused plan as one explicit new Edit turn. */
  readonly onResume?: (ref: PlanResumeRef) => PlanActionOutcome | Promise<PlanActionOutcome>;
  /** Cancel this plan terminally. A live turn stops; completed edits stay. */
  readonly onCancel?: (ref: PlanCancelRef) => PlanActionOutcome | Promise<PlanActionOutcome>;
  /** The conversation stored a new proposal: put focus on this card's stable heading. */
  readonly focusRequest?: number;
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

function pauseAnnouncement(summary: PlanPauseSummary | null | undefined): string {
  if (!summary) return "Plan paused.";
  if (summary.changed <= 0) return "Plan paused. No book changes.";
  const chapters = summary.changed === 1 ? "chapter" : "chapters";
  return `Plan paused. ${summary.changed} ${chapters} changed; ${summary.undoAvailable
    ? "undo available"
    : "no undo checkpoint"}.`;
}

function cancelAnnouncement(
  plan: AgentPlan,
  cancelling: boolean,
  summary: PlanCancelSummary | null | undefined
): string {
  if (cancelling) return "Plan cancelled. Finishing in-flight work. Completed edits stay.";
  const completed = plan.steps.filter((step) => step.state === "completed").length;
  const total = plan.steps.length;
  const steps = `Plan cancelled. ${completed} of ${total} ${total === 1 ? "step" : "steps"} completed.`;
  if (!summary) return `${steps} Completed edits stay.`;
  if (summary.changed <= 0) return `${steps} No book changes. Completed edits stay.`;
  const chapters = summary.changed === 1 ? "chapter" : "chapters";
  const changes = `${summary.changed} ${chapters} changed; ${summary.undoAvailable
    ? "undo available"
    : "no undo checkpoint"}.`;
  return `${steps} ${changes} Completed edits stay.`;
}

/** The confirmed status sentence only. Requests and failures have their own paths. */
function confirmedAnnouncement(
  plan: AgentPlan,
  cancelling: boolean,
  pauseSummary: PlanPauseSummary | null | undefined,
  cancelSummary: PlanCancelSummary | null | undefined
): string {
  switch (plan.status) {
    case "running":
      return "Plan running.";
    case "waiting-for-approval":
      return "Plan waiting for approval. The agent will not act until you answer the approval request.";
    case "pause-requested":
      return "Pause requested. The plan is not paused until the turn stops.";
    case "paused":
      return pauseAnnouncement(pauseSummary);
    case "cancelled":
      return cancelAnnouncement(plan, cancelling, cancelSummary);
    case "completed":
      return "Plan completed.";
    case "failed":
      return "Plan failed. No further step will run. Completed steps stay.";
    case "expired":
      return "Plan expired. This plan cannot be started, resumed or replayed. Completed steps stay.";
    default:
      return "";
  }
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
  stale = false,
  onStart,
  onPause,
  onResume,
  onCancel,
  focusRequest = 0
}: Props) {
  const headingId = useId();
  const statusId = useId();
  const cancelDescriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const resumeButtonRef = useRef<HTMLButtonElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const focusInsideCard = useRef(false);
  const previousFocusRequest = useRef(0);
  const previousStatus = useRef(plan.status);
  const previousSteps = useRef(plan.steps);
  const previousStopping = useRef(stopping);
  const previousCancelling = useRef(cancelling);
  const previousCancelSummary = useRef(cancelSummary);
  const [announcement, setAnnouncement] = useState("");
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [resumeFailure, setResumeFailure] = useState<string | null>(null);
  const [cancelFailure, setCancelFailure] = useState<string | null>(null);
  const [cancelConfirming, setCancelConfirming] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const restoreCancelFocus = useRef(false);
  const canStart = plan.status === "proposed" && !running && Boolean(onStart) && !stale;
  // Pause stays mounted while its stop is open, disabled, so focus and the state stay announced.
  // The request-pause notice changes the stored status to `pause-requested`; the open stop keeps
  // the control mounted until the terminal event.
  const pauseOffered = Boolean(onPause) && live &&
    (plan.status === "running" || plan.status === "waiting-for-approval" ||
      (stopping && plan.status === "pause-requested"));
  const canPause = pauseOffered && !stopping && !starting && !resuming && !cancelling;
  const resumeAvailable = Boolean(onResume) && plan.status === "paused" && !running && !stopping && !stale;
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

  // The card owns the heading as its stable focus target after an action removes or disables the
  // pressed control. Track whether the author's focus was inside the card before that happens.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      focusInsideCard.current = cardRef.current?.contains(event.target as Node) ?? false;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // A proposal is stored while the composer is still mounted but the card is not: the conversation
  // asks the new card to take focus once it appears.
  useEffect(() => {
    if (focusRequest <= 0 || focusRequest === previousFocusRequest.current) return;
    previousFocusRequest.current = focusRequest;
    headingRef.current?.focus();
  }, [focusRequest]);

  // One polite region announces only confirmed changes. Status wins over steps, and the request
  // sentences are only for changes after mount; a reattach never replays an old status.
  useEffect(() => {
    const statusChanged = previousStatus.current !== plan.status;
    const stoppingStarted = !previousStopping.current && stopping;
    const cancellingStarted = !previousCancelling.current && cancelling;
    const cancellingSettled = previousCancelling.current && !cancelling;
    const summaryChanged = previousCancelSummary.current !== cancelSummary;
    let changedStep = -1;
    plan.steps.forEach((step, index) => {
      const before = previousSteps.current[index];
      if (before && before.state !== step.state) changedStep = index;
    });

    previousStatus.current = plan.status;
    previousSteps.current = plan.steps;
    previousStopping.current = stopping;
    previousCancelling.current = cancelling;
    previousCancelSummary.current = cancelSummary;

    if (statusChanged) {
      setAnnouncement(confirmedAnnouncement(plan, cancelling, pauseSummary, cancelSummary));
      return;
    }
    if (stoppingStarted) {
      setAnnouncement("Pause requested. Waiting for in-flight work to settle.");
      return;
    }
    if (cancellingStarted) {
      setAnnouncement("Cancel requested. Waiting for in-flight work to settle.");
      return;
    }
    if (plan.status === "cancelled" && cancelSummary && (summaryChanged || cancellingSettled)) {
      setAnnouncement(cancelAnnouncement(plan, false, cancelSummary));
      return;
    }
    const step = changedStep >= 0 ? plan.steps[changedStep] : undefined;
    if (step) {
      setAnnouncement(`Step ${changedStep + 1} of ${plan.steps.length}: ${STEP_LABEL[step.state]}.`);
    }
  }, [cancelling, cancelSummary, pauseSummary, plan, plan.status, plan.steps, stopping]);

  // A refused action is an alert, not a status repeat: the region is cleared and the pressed
  // control takes focus back after it is enabled again.
  useEffect(() => {
    if (!failure || starting) return;
    startButtonRef.current?.focus();
  }, [failure, starting]);

  useEffect(() => {
    if (!resumeFailure || resuming) return;
    resumeButtonRef.current?.focus();
  }, [resumeFailure, resuming]);

  useEffect(() => {
    if (!cancelFailure || cancelSubmitting) return;
    cancelButtonRef.current?.focus();
  }, [cancelFailure, cancelSubmitting]);

  useEffect(() => {
    if (cancelConfirming) keepButtonRef.current?.focus();
  }, [cancelConfirming]);

  // An external terminal status that removed the focused control returns focus to the heading,
  // but only when focus was inside this card. Focus elsewhere is never stolen.
  useEffect(() => {
    if (!isTerminalStatus(plan.status) || !focusInsideCard.current) return;
    focusInsideCard.current = false;
    if (!cardRef.current?.contains(document.activeElement)) headingRef.current?.focus();
  }, [plan.status]);

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
    setAnnouncement("Starting the plan. Waiting for the running acknowledgement.");
    headingRef.current?.focus();
    try {
      const outcome = await onStart({ id: plan.id, revision: plan.revision, action: "start" });
      if (outcome && !outcome.ok) {
        setFailure(outcome.reason ?? "The plan could not be started. Nothing changed.");
        setAnnouncement("");
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The plan could not be started. Nothing changed.");
      setAnnouncement("");
    } finally {
      setStarting(false);
    }
  };

  const pause = (): void => {
    if (!canPause) return;
    // The parent's `stopping` prop will repeat this fact; it is not a second event.
    previousStopping.current = true;
    setAnnouncement("Pause requested. Waiting for in-flight work to settle.");
    headingRef.current?.focus();
    onPause?.();
  };

  const resume = async (): Promise<void> => {
    if (!onResume || !canResume || resuming) return;
    setResumeFailure(null);
    setAnnouncement("Resume requested. Waiting for the running acknowledgement.");
    headingRef.current?.focus();
    try {
      const outcome = await onResume({ id: plan.id, revision: plan.revision, action: "resume" });
      if (outcome && !outcome.ok) {
        setResumeFailure(outcome.reason ?? "The plan could not be resumed. Nothing changed.");
        setAnnouncement("");
      }
    } catch (error) {
      setResumeFailure(error instanceof Error ? error.message : "The plan could not be resumed. Nothing changed.");
      setAnnouncement("");
    }
  };

  const keepPlan = (): void => {
    restoreCancelFocus.current = true;
    setCancelConfirming(false);
    setAnnouncement("Cancel closed. The plan is unchanged.");
  };

  const cancel = async (): Promise<void> => {
    if (!onCancel || !canCancel || cancelBusy) return;
    setCancelConfirming(false);
    setCancelFailure(null);
    setCancelSubmitting(true);
    // The parent's `cancelling` prop is the same request, not a second announcement.
    previousCancelling.current = true;
    setAnnouncement("Cancel requested. Waiting for in-flight work to settle.");
    headingRef.current?.focus();
    try {
      const outcome = await onCancel({ id: plan.id });
      if (outcome && !outcome.ok) {
        setCancelFailure(outcome.reason ?? "The plan could not be cancelled. Nothing changed.");
        setAnnouncement("");
      }
    } catch (error) {
      setCancelFailure(error instanceof Error ? error.message : "The plan could not be cancelled. Nothing changed.");
      setAnnouncement("");
    } finally {
      setCancelSubmitting(false);
    }
  };

  return (
    <article
      ref={cardRef}
      data-testid="plan-card"
      data-plan-id={plan.id}
      data-plan-status={plan.status}
      aria-labelledby={headingId}
      aria-describedby={statusId}
      onFocusCapture={() => {
        focusInsideCard.current = true;
      }}
      className="space-y-2 rounded-[var(--corner-md)] border border-[var(--border)] bg-[var(--card)] p-3 text-sm text-foreground"
    >
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="plan-announcement"
        className="sr-only"
      >
        {announcement}
      </p>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          aria-describedby={statusId}
          className="font-medium"
        >
          Stored plan
        </h3>
        <p id={statusId} data-testid="plan-status" className="text-xs text-muted-foreground">
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
      {plan.status === "expired" ? (
        <p data-testid="plan-expired-note" className="text-xs text-muted-foreground">
          This plan cannot be started, resumed or replayed. Completed steps stay; no further step will run.
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
          ref={startButtonRef}
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
          onClick={pause}
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
          ref={resumeButtonRef}
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
              aria-describedby={cancelDescriptionId}
              data-testid="plan-cancel-confirmation"
              className="border-0 p-0"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                keepPlan();
              }}
            >
              <p id={cancelDescriptionId} className="text-xs">Cancel this plan? Completed edits stay; Cancel does not undo them.</p>
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
                  ref={keepButtonRef}
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
                setAnnouncement("Cancel this plan? Completed edits stay; Cancel does not undo them.");
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
