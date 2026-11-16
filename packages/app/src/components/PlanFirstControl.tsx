import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentMode } from "@ai-book-studio/core/agent/messages";
import {
  PLAN_GUIDANCE_LIMIT,
  createProposedPlan,
  planStartIntent,
  refreshProposedPlanGuidance,
  type ManuscriptWriter,
  type PlanRefusal,
  type PlanStartIntent,
  type ProposedPlan
} from "@ai-book-studio/core/agent/proposed-plan";
import { Button } from "@ai-book-studio/ui/button";

/**
 * Visible Plan first control for one Edit turn.
 *
 * The author types a purpose, ordered steps, and optional guidance. Proposing, refreshing, and
 * starting call the pure plan contract only. The supplied writer is never called. Start plan
 * shows the resulting intent and does not start a turn, persist a plan, or approve a tool.
 */

interface Props {
  readonly mode: AgentMode;
  readonly running: boolean;
  readonly writer: ManuscriptWriter;
  /** The turn model already chosen in the composer. This control does not offer another. */
  readonly modelLabel: string;
  /** Supplies a proposal id. The control does not mint one from a clock. */
  readonly nextPlanId?: () => string;
}

interface ShownPlan {
  readonly plan: ProposedPlan;
  readonly modelLabel: string;
}

interface DraftStep {
  readonly id: string;
  readonly text: string;
}

const REFUSAL: Record<PlanRefusal, string> = {
  "empty-purpose": "Add a purpose before proposing a plan.",
  "empty-steps": "Add at least one step.",
  "empty-step": "Every step needs text.",
  "discuss-mode": "Plan first is only available for an Edit turn.",
  "guidance-too-long": "Shorten guidance to 2,000 characters. Your text is kept.",
  "not-proposed": "Only a proposed plan can be refreshed or started.",
  "unexpected-authority": "This plan cannot change the model, tools, or approvals.",
  "invalid-proposal": "This plan could not be prepared."
};

const fieldClass =
  "mt-1 block w-full rounded-[var(--corner-sm)] border border-[var(--input)] bg-[var(--card)] px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 disabled:opacity-50";

function ProposalCard({
  title,
  testId,
  shown,
  actions
}: {
  title: string;
  testId: string;
  shown: ShownPlan;
  actions?: ReactNode;
}) {
  const { plan, modelLabel } = shown;
  return (
    <article data-testid={testId} className="space-y-2 rounded-[var(--corner-sm)] border border-[var(--border)] p-2">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p data-testid="plan-revision">Revision {plan.revision}</p>
      <p data-testid="plan-id">{plan.id}</p>
      <p data-testid="plan-mode">Edit</p>
      <p data-testid="plan-model">{modelLabel}</p>
      <p data-testid="plan-purpose-text" className="whitespace-pre-wrap text-foreground">{plan.purpose}</p>
      <ol className="list-decimal space-y-1 pl-5 text-foreground">
        {plan.steps.map((step, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: contract steps have no id; the proposal id and revision scope the index
            key={`${plan.id}-${plan.revision}-${index}`}
            data-testid="plan-step-row"
          >
            <span data-testid="plan-step-text" className="whitespace-pre-wrap">{step.text}</span>
            {" "}
            <span data-testid="plan-step-state" data-state={step.state}>Pending</span>
          </li>
        ))}
      </ol>
      {plan.guidance !== undefined ? (
        <p data-testid="plan-guidance-text" className="whitespace-pre-wrap text-foreground">{plan.guidance}</p>
      ) : (
        <p data-testid="plan-guidance-omitted">No guidance</p>
      )}
      <p>Tool permissions and approvals are unchanged.</p>
      {actions}
    </article>
  );
}

export function PlanFirstControl({ mode, running, writer, modelLabel, nextPlanId }: Props) {
  const headingId = useId();
  const guidanceId = useId();
  const serial = useRef(0);
  const stepSerial = useRef(0);
  const nextStep = (text: string): DraftStep => {
    stepSerial.current += 1;
    return { id: `step-${stepSerial.current}`, text };
  };
  const [purpose, setPurpose] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>(() => [nextStep("")]);
  const [guidance, setGuidance] = useState("");
  const [current, setCurrent] = useState<ShownPlan | null>(null);
  const [previous, setPrevious] = useState<ShownPlan | null>(null);
  const [intent, setIntent] = useState<PlanStartIntent | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const guidanceTooLong = guidance.length > PLAN_GUIDANCE_LIMIT;

  const planId = (): string => {
    if (nextPlanId) return nextPlanId();
    serial.current += 1;
    return `plan-${serial.current}`;
  };

  const propose = (): void => {
    if (running) return;
    const result = createProposedPlan({
      id: planId(),
      mode,
      purpose,
      steps: steps.map((step) => step.text),
      guidance
    }, writer);
    if (!result.ok) {
      setRefusal(REFUSAL[result.code]);
      return;
    }
    setRefusal(null);
    setPrevious(null);
    setIntent(null);
    setCurrent({ plan: result.value, modelLabel });
  };

  const refresh = (): void => {
    if (running || !current) return;
    const result = refreshProposedPlanGuidance(current.plan, guidance, writer);
    if (!result.ok) {
      setRefusal(REFUSAL[result.code]);
      return;
    }
    setRefusal(null);
    setPrevious(current);
    setIntent(null);
    setCurrent({ plan: result.value, modelLabel: current.modelLabel });
  };

  const start = (): void => {
    if (running || !current) return;
    const result = planStartIntent(current.plan, writer);
    if (!result.ok) {
      setRefusal(REFUSAL[result.code]);
      return;
    }
    setRefusal(null);
    setIntent(result.value);
  };

  return (
    <section
      data-testid="plan-first"
      aria-labelledby={headingId}
      className="space-y-2 rounded-[var(--corner-md)] border border-[var(--border)] bg-[var(--secondary)] p-2 text-xs text-muted-foreground"
    >
      <h2 id={headingId} className="text-sm font-medium text-foreground">Plan first</h2>
      <p>
        Propose a purpose and ordered steps before any change. Nothing is written, and starting only names the next turn.
      </p>
      <p data-testid="plan-turn-model">{modelLabel}</p>
      <p>A new proposal uses this turn&apos;s model. Refreshing guidance does not change it.</p>
      {running ? (
        <p role="status">This turn is running. Guidance and plan refresh stay off until it stops.</p>
      ) : null}
      {mode !== "edit" ? (
        <p role="status">Plan first is only available for an Edit turn.</p>
      ) : null}
      <label className="block">
        Purpose
        <textarea
          value={purpose}
          onChange={(event) => {
            if (running) return;
            setPurpose(event.target.value);
          }}
          disabled={running}
          rows={2}
          data-testid="plan-purpose"
          className={fieldClass}
        />
      </label>
      <div className="space-y-2">
        <ol className="space-y-2">
          {steps.map((step, index) => (
            <li key={step.id} className="flex items-center gap-2">
              <label className="min-w-0 flex-1">
                Step {index + 1}
                <input
                  value={step.text}
                  onChange={(event) => {
                    if (running) return;
                    const value = event.target.value;
                    setSteps((existing) => existing.map((item) => item.id === step.id ? { ...item, text: value } : item));
                  }}
                  disabled={running}
                  aria-label={`Step ${index + 1}`}
                  data-testid="plan-step"
                  className={fieldClass}
                />
              </label>
              <Button
                variant="ghost"
                size="xs"
                disabled={running || steps.length === 1}
                aria-label={`Remove step ${index + 1}`}
                onClick={() => {
                  if (running) return;
                  setSteps((existing) => existing.filter((item) => item.id !== step.id));
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ol>
        <Button
          variant="ghost"
          size="xs"
          disabled={running}
          onClick={() => {
            if (running) return;
            setSteps((existing) => [...existing, nextStep("")]);
          }}
        >
          Add step
        </Button>
      </div>
      <label className="block">
        Plan guidance (optional)
        <textarea
          value={guidance}
          onChange={(event) => {
            if (running) return;
            setGuidance(event.target.value);
          }}
          disabled={running}
          rows={2}
          aria-invalid={guidanceTooLong}
          aria-describedby={guidanceId}
          data-testid="plan-guidance"
          className={fieldClass}
        />
      </label>
      <p id={guidanceId}>
        {guidance.length.toLocaleString()} / {PLAN_GUIDANCE_LIMIT.toLocaleString()} characters
      </p>
      <Button variant="secondary" size="sm" disabled={running} data-testid="plan-propose" onClick={propose}>
        Propose plan
      </Button>
      {refusal ? <p role="alert" data-testid="plan-refusal">{refusal}</p> : null}
      {previous ? <ProposalCard title="Previous proposal" testId="plan-previous" shown={previous} /> : null}
      {current ? (
        <ProposalCard
          title="Proposed plan"
          testId="plan-current"
          shown={current}
          actions={(
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={running} data-testid="plan-refresh" onClick={refresh}>
                Refresh guidance
              </Button>
              <Button variant="primary" size="sm" disabled={running} data-testid="plan-start" onClick={start}>
                Start plan
              </Button>
            </div>
          )}
        />
      ) : null}
      {intent ? (
        <div data-testid="plan-start-intent" role="status" className="space-y-1 text-foreground">
          <p>Start plan names a new turn only. It does not start the turn, write, or approve a tool.</p>
          <p>
            Turn <span data-testid="plan-intent-turn">{intent.turn}</span>
          </p>
          <p>
            Proposal <span data-testid="plan-intent-proposal">{intent.proposalId}</span>
          </p>
          <p>
            Revision <span data-testid="plan-intent-revision">{intent.revision}</span>
          </p>
          <p>
            Carried approval <span data-testid="plan-intent-approval">{intent.carriedApproval ? "yes" : "no"}</span>
          </p>
        </div>
      ) : null}
    </section>
  );
}
