import { useEffect, useId, useRef, useState } from "react";
import type { AgentMode, AgentPlan } from "@ai-book-studio/core/agent/messages";
import { AGENT_PLAN_LIMITS } from "@ai-book-studio/core/agent/messages";
import { Button } from "@ai-book-studio/ui/button";
import {
  PlanProgress,
  type PlanActionOutcome,
  type PlanCancelRef,
  type PlanCancelSummary,
  type PlanGuidanceOutcome,
  type PlanGuidanceRef,
  type PlanPauseSummary,
  type PlanResumeRef,
  type PlanStartRef
} from "./PlanProgress";

/**
 * Plan first asks the agent for one reviewed proposal and shows the stored result.
 *
 * The request fields are the author's suggestions for the agent, not durable plan content and not
 * permission. Asking for a plan sends one read-only Edit proposal turn. The durable plan is the
 * stored agent proposal shown by PlanProgress; Start is a separate explicit Edit turn and is only
 * offered for a proposed plan while no turn runs.
 */

export interface PlanProposalRequest {
  /** What the plan should cover. Required, up to 2,000 characters. */
  readonly request: string;
  /** Ordered suggestions the agent may adopt or improve. Up to 50, each up to 2,000 characters. */
  readonly steps: readonly string[];
  /** Guidance for the proposal turn only. */
  readonly guidance?: string;
}

interface Props {
  readonly mode: AgentMode;
  readonly running: boolean;
  /** The proposal turn is in flight; the request fields stay disabled. */
  readonly proposing?: boolean;
  /** The latest stored plan, read from the conversation or updated by a confirmed notice. */
  readonly plan: AgentPlan | null;
  /** A confirmed plan-write error, shown without changing the last confirmed state. */
  readonly notice?: string | null;
  /** This process could not mark the open plan expired; Start and Resume stay off. */
  readonly stale?: boolean;
  /** The model the proposal and Start turns will use. This control offers no model chooser. */
  readonly modelLabel: string;
  readonly onPropose: (request: PlanProposalRequest) => PlanActionOutcome | Promise<PlanActionOutcome>;
  readonly onStart: (ref: PlanStartRef) => PlanActionOutcome | Promise<PlanActionOutcome>;
  /** A live plan turn held by this window, so the plan card may offer Pause. */
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
  readonly onPause?: () => void;
  readonly onResume?: (ref: PlanResumeRef) => PlanActionOutcome | Promise<PlanActionOutcome>;
  readonly onCancel?: (ref: PlanCancelRef) => PlanActionOutcome | Promise<PlanActionOutcome>;
  /** The conversation's plan-scoped guidance refresh, shared with the one stored-plan card. */
  readonly onRefreshGuidance?: (ref: PlanGuidanceRef) => PlanGuidanceOutcome | Promise<PlanGuidanceOutcome>;
  /** A guidance refresh is in flight. */
  readonly refreshing?: boolean;
  /** The conversation owns the one plan card; the composer keeps its guard without a second card. */
  readonly showStoredPlan?: boolean;
}

interface DraftStep {
  readonly id: string;
  readonly text: string;
}

const OPEN_PLAN_STATUSES: ReadonlySet<AgentPlan["status"]> = new Set([
  "proposed",
  "running",
  "waiting-for-approval",
  "pause-requested",
  "paused"
]);

const fieldClass =
  "mt-1 block w-full rounded-[var(--corner-sm)] border border-[var(--input)] bg-[var(--card)] px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 disabled:opacity-50";

export function PlanFirstControl({
  mode,
  running,
  proposing = false,
  plan,
  notice,
  stale = false,
  modelLabel,
  onPropose,
  onStart,
  live = false,
  stopping = false,
  resuming = false,
  pauseSummary = null,
  cancelling = false,
  cancelSummary = null,
  onPause,
  onResume,
  onCancel,
  onRefreshGuidance,
  refreshing = false,
  showStoredPlan = true
}: Props) {
  const headingId = useId();
  const requestId = useId();
  const stepsId = useId();
  const guidanceId = useId();
  const purposeCountId = useId();
  const stepLimitId = useId();
  const guidanceCountId = useId();
  const askRef = useRef<HTMLButtonElement>(null);
  const stepInputs = useRef(new Map<string, HTMLInputElement>());
  const pendingStepFocus = useRef<string | null>(null);
  const stepSerial = useRef(0);
  const nextStep = (text: string): DraftStep => {
    stepSerial.current += 1;
    return { id: `step-${stepSerial.current}`, text };
  };
  const [request, setRequest] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>(() => [nextStep("")]);
  const [guidance, setGuidance] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const requestTooLong = request.length > AGENT_PLAN_LIMITS.purpose;
  const guidanceTooLong = guidance.length > AGENT_PLAN_LIMITS.guidance;
  const stepTooLong = steps.some((step) => step.text.length > AGENT_PLAN_LIMITS.stepText);
  const stepCountFull = steps.length >= AGENT_PLAN_LIMITS.steps;
  const openPlan = plan !== null && OPEN_PLAN_STATUSES.has(plan.status);
  const busy = running || proposing || submitting;
  const editable = mode === "edit" && !busy && !openPlan;
  const canPropose =
    editable && request.trim().length > 0 && !requestTooLong && !guidanceTooLong && !stepTooLong;

  useEffect(() => {
    if (!failure || submitting) return;
    askRef.current?.focus();
  }, [failure, submitting]);

  // Add and Remove replace the pressed button with another row. Focus stays in the step list.
  useEffect(() => {
    const id = pendingStepFocus.current;
    if (!id) return;
    const input = stepInputs.current.get(id);
    if (!input) return;
    pendingStepFocus.current = null;
    input.focus();
  }, [steps]);

  const addStep = (): void => {
    const step = nextStep("");
    pendingStepFocus.current = step.id;
    setSteps((existing) => [...existing, step]);
  };

  const removeStep = (index: number): void => {
    const target = steps[index + 1] ?? steps[index - 1];
    if (target) pendingStepFocus.current = target.id;
    setSteps((existing) => existing.filter((_, position) => position !== index));
  };

  const propose = async (): Promise<void> => {
    if (!canPropose) return;
    const suggested = steps
      .map((step) => step.text.trim())
      .filter((text) => text.length > 0);
    setSubmitting(true);
    setFailure(null);
    try {
      const outcome = await onPropose({
        request: request.trim(),
        steps: suggested,
        ...(guidance.trim().length > 0 ? { guidance } : {})
      });
      if (outcome && !outcome.ok) {
        setFailure(outcome.reason ?? "The plan could not be proposed. Your request is kept.");
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The plan could not be proposed. Your request is kept.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      data-testid="plan-first"
      aria-labelledby={headingId}
      className="space-y-2 rounded-[var(--corner-md)] border border-[var(--border)] bg-[var(--secondary)] p-2 text-xs text-muted-foreground"
    >
      <h2 id={headingId} className="text-sm font-medium text-foreground">Plan first</h2>
      <p>
        Ask the agent for an ordered plan before any change. The agent proposes it in one Edit turn;
        you review the stored plan before starting it.
      </p>
      <p data-testid="plan-turn-model">{modelLabel}</p>
      {mode !== "edit" ? (
        <p role="status">Plan first is only available for an Edit turn.</p>
      ) : null}
      {proposing || submitting ? (
        <p role="status" data-testid="plan-proposing">Proposing a plan…</p>
      ) : running ? (
        <p role="status">A turn is running. Plan controls stay off until it stops.</p>
      ) : openPlan ? (
        stale ? (
          notice ? (
            <p data-testid="plan-open">{notice}</p>
          ) : (
            <p role="status" data-testid="plan-open">
              This plan's runtime is no longer available, but the plan could not be marked expired. It remains at its last confirmed state. Nothing was replayed.
            </p>
          )
        ) : (
          <p role="status" data-testid="plan-open">Start the stored plan before asking for another.</p>
        )
      ) : null}
      {mode === "edit" ? (
        <>
          <label className="block" htmlFor={requestId}>
            What should the plan cover?
            <textarea
              id={requestId}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              disabled={!editable}
              rows={3}
              aria-invalid={requestTooLong}
              aria-describedby={purposeCountId}
              data-testid="plan-purpose"
              className={fieldClass}
            />
          </label>
          <p id={purposeCountId}>{request.length.toLocaleString()} / {AGENT_PLAN_LIMITS.purpose.toLocaleString()} characters</p>
          <div className="space-y-2">
            <p id={stepsId}>Steps to consider (optional)</p>
            <p>The agent may propose different or better-ordered steps.</p>
            <ol aria-labelledby={stepsId} className="space-y-2">
              {steps.map((step, index) => (
                <li key={step.id} className="flex items-center gap-2">
                  <label className="min-w-0 flex-1">
                    Step {index + 1}
                    <input
                      ref={(node) => {
                        if (node) stepInputs.current.set(step.id, node);
                        else stepInputs.current.delete(step.id);
                      }}
                      value={step.text}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSteps((existing) => existing.map((item) => item.id === step.id ? { ...item, text: value } : item));
                      }}
                      disabled={!editable}
                      aria-invalid={step.text.length > AGENT_PLAN_LIMITS.stepText}
                      aria-label={`Step ${index + 1}`}
                      aria-describedby={stepLimitId}
                      data-testid="plan-step"
                      className={fieldClass}
                    />
                  </label>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!editable || steps.length === 1}
                    aria-label={`Remove step ${index + 1}`}
                    onClick={() => removeStep(index)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ol>
            <Button
              variant="ghost"
              size="xs"
              disabled={!editable || stepCountFull}
              onClick={addStep}
            >
              Add step
            </Button>
            <p id={stepLimitId}>
              Up to {AGENT_PLAN_LIMITS.steps} steps · {AGENT_PLAN_LIMITS.stepText.toLocaleString()} characters each
            </p>
          </div>
          <label className="block" htmlFor={guidanceId}>
            Guidance for this request (optional)
            <textarea
              id={guidanceId}
              value={guidance}
              onChange={(event) => setGuidance(event.target.value)}
              disabled={!editable}
              rows={2}
              aria-invalid={guidanceTooLong}
              aria-describedby={guidanceCountId}
              data-testid="plan-guidance"
              className={fieldClass}
            />
          </label>
          <p id={guidanceCountId}>
            {guidance.length.toLocaleString()} / {AGENT_PLAN_LIMITS.guidance.toLocaleString()} characters · This request only
          </p>
          {requestTooLong ? (
            <p role="alert" data-testid="plan-refusal">Shorten the request to 2,000 characters. Your text is kept.</p>
          ) : null}
          {stepTooLong ? (
            <p role="alert" data-testid="plan-refusal">Shorten each step to 2,000 characters. Your text is kept.</p>
          ) : null}
          {guidanceTooLong ? (
            <p role="alert" data-testid="plan-refusal">Shorten guidance to 2,000 characters. Your text is kept.</p>
          ) : null}
          {failure ? <p role="alert" data-testid="plan-refusal">{failure}</p> : null}
          <Button
            ref={askRef}
            variant="secondary"
            size="sm"
            disabled={!canPropose}
            data-testid="plan-propose"
            onClick={() => void propose()}
          >
            Ask for plan
          </Button>
          {showStoredPlan && plan ? (
            <div data-testid="plan-current">
              <PlanProgress
                plan={plan}
                running={running}
                live={live}
                stopping={stopping}
                resuming={resuming}
                pauseSummary={pauseSummary}
                cancelling={cancelling}
                cancelSummary={cancelSummary}
                modelLabel={modelLabel}
                notice={notice}
                stale={stale}
                onStart={onStart}
                {...(onPause ? { onPause } : {})}
                {...(onResume ? { onResume } : {})}
                {...(onCancel ? { onCancel } : {})}
                {...(onRefreshGuidance ? { onRefreshGuidance } : {})}
                refreshing={refreshing}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
