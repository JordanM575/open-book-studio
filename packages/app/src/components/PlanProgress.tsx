import { useState } from "react";
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
 * store returned. It never infers progress from text, a local draft, or a tool name, and it
 * offers no pause, resume, cancel or approval action. Start is a new explicit Edit turn; the
 * runtime records every step outcome.
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

export interface PlanActionOutcome {
  readonly ok: boolean;
  readonly reason?: string;
}

interface Props {
  readonly plan: AgentPlan;
  /** A turn is running, so Start waits for it to stop. */
  readonly running: boolean;
  /** The model the Start turn will use, named plainly. There is no second chooser here. */
  readonly modelLabel?: string;
  /** A confirmed plan-write error, shown without changing the last confirmed state. */
  readonly notice?: string | null | undefined;
  /** Omitted in a read-only review surface. */
  readonly onStart?: (ref: PlanStartRef) => PlanActionOutcome | Promise<PlanActionOutcome>;
}

export function PlanProgress({ plan, running, modelLabel, notice, onStart }: Props) {
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const canStart = plan.status === "proposed" && !running && Boolean(onStart);

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
          {STATUS_LABEL[plan.status]}
          {starting ? " · Starting…" : ""}
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
      {plan.guidance !== undefined ? (
        <p data-testid="plan-guidance-text" className="whitespace-pre-wrap text-xs text-muted-foreground">
          {plan.guidance}
        </p>
      ) : (
        <p data-testid="plan-guidance-omitted" className="text-xs text-muted-foreground">No plan guidance</p>
      )}
      {notice ? <p role="alert" data-testid="plan-notice" className="text-xs text-[var(--destructive-text)]">{notice}</p> : null}
      {failure ? <p role="alert" data-testid="plan-action-error" className="text-xs text-[var(--destructive-text)]">{failure}</p> : null}
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
    </article>
  );
}
