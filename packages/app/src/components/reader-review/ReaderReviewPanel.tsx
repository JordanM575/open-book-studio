import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { assertReviewData } from "@ai-book-studio/core/review/contract";
import type { CurrentSource, ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import { readerSourceState, type Citation, type ReaderRun, type ReaderSourceSummary } from "@ai-book-studio/core/review/findings";
import type { ReaderReviewStopResult } from "@ai-book-studio/core/review/reader-api";
import { Button } from "@ai-book-studio/ui/button";
import {
  acceptPreparation, acceptRun, citationNavigationCopy, completedRerunCopy,
  failureCopy, failureMessage, maxVolatileAttempts, attemptCapCopy, refusalCopy, refusalMessage,
  revalidationFailureCopy, sourceCheckCopy,
  type PreparedReaderReview, type ReaderReviewProps, type ReaderSourceCheck, type VolatileReaderRun
} from "./contracts";
import { ReviewDisclosure, reviewActionClass } from "./ReviewDisclosure";
import { navigationDetail, navigationKey, ReaderReviewResults } from "./ReaderReviewResults";

type Phase = "idle" | "preparing" | "ready" | "running" | "completed" | "failed" | "stopped";
type Operation = { controller: AbortController; requestId: string | null; revision: string; stop: ReaderReviewProps["onStop"] };
const stoppedCopy = "Review stopped · Incomplete. Stopping prevents later dispatch best-effort; text already sent cannot be recalled. Prepare a new request to try again.";
const stopRequestedCopy = "Review stop requested · Incomplete. Stopping prevents later dispatch best-effort; text already sent cannot be recalled. Awaiting stop confirmation.";
const cancelCopy = "Preparation cancelled · No provider request started. Prepare again when ready.";
const unconfirmedStopCopy = "Stop could not be confirmed · Incomplete. Late results are ignored here, but the provider may still be processing text already sent. That text cannot be recalled.";

function stopMessage(outcome: ReaderReviewStopResult): string {
  return outcome === "stopped" ? stoppedCopy : outcome === "not-started" ? cancelCopy : unconfirmedStopCopy;
}

function acceptSourceCheck(value: unknown): ReaderSourceCheck {
  if (!value || typeof value !== "object") return { kind: "failed" };
  const candidate = value as { kind?: unknown; byScopeDigest?: unknown };
  if (candidate.kind === "failed") return { kind: "failed" };
  if (candidate.kind !== "checked" || !(candidate.byScopeDigest instanceof Map)) return { kind: "failed" };
  const byScopeDigest = new Map<string, readonly CurrentSource[]>();
  for (const [key, sources] of candidate.byScopeDigest) {
    if (typeof key !== "string" || !Array.isArray(sources)) return { kind: "failed" };
    byScopeDigest.set(key, sources as readonly CurrentSource[]);
  }
  return { kind: "checked", byScopeDigest };
}

function summaryFor(envelope: ReviewEnvelope, check: ReaderSourceCheck): ReaderSourceSummary | null {
  if (check.kind !== "checked") return null;
  const sources = check.byScopeDigest.get(envelope.scopeDigest);
  if (!sources) return null;
  try { return readerSourceState(envelope, sources); } catch { return null; }
}

function withoutScope(check: ReaderSourceCheck | null, scopeDigest: string | undefined): ReaderSourceCheck | null {
  if (check?.kind !== "checked" || !scopeDigest) return check;
  const byScopeDigest = new Map(check.byScopeDigest);
  return byScopeDigest.delete(scopeDigest) ? { kind: "checked", byScopeDigest } : check;
}

function boundedFailureReason(reason: unknown): "provider" | "overflow" | "malformed" | "refused" {
  return typeof reason === "string" && Object.hasOwn(failureCopy, reason) ? reason as "provider" | "overflow" | "malformed" | "refused" : "provider";
}

function appendAttempt(attempts: readonly VolatileReaderRun[], attempt: VolatileReaderRun): readonly VolatileReaderRun[] {
  // The Start path is guarded by maxVolatileAttempts; never evict an earlier attempt to make room.
  return attempts.length >= maxVolatileAttempts ? attempts : [...attempts, attempt];
}

/** Injected execution and explicit validated persistence; never dispatches a provider on Save. */
export function ReaderReviewPanel(props: ReaderReviewProps) {
  // A→B→A creates a new lifetime, even if a host reuses book IDs. Closing also drops all volatile data.
  return props.open ? <ReaderReviewSession key={JSON.stringify([props.bookId, props.viewKey])} {...props} /> : null;
}

function ReaderReviewSession(props: ReaderReviewProps) {
  const heading = useId();
  const capNoteId = useId();
  const [prepared, setPrepared] = useState<PreparedReaderReview | null>(null);
  const [attempts, setAttempts] = useState<readonly VolatileReaderRun[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("Prepare the selected saved scope to inspect it. Nothing starts automatically.");
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [navigationRefusals, setNavigationRefusals] = useState<ReadonlyMap<string, "stale" | "unavailable">>(new Map());
  const [sourceCheck, setSourceCheck] = useState<ReaderSourceCheck | null>(null);
  const [checkingSources, setCheckingSources] = useState(false);
  const status = useRef<HTMLParagraphElement>(null);
  const alive = useRef(false);
  const active = useRef<Operation | null>(null);
  const checkController = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const currentRevision = useRef(props.disclosureRevision);
  const seenRequests = useRef(new Set<string>());
  const startedRequests = useRef(new Set<string>());
  const cancellation = useRef<{ message: string } | null>(null);
  const hadPrepared = useRef(false);
  hadPrepared.current = prepared !== null;
  const completedRuns = attempts.flatMap((attempt) => attempt.outcome.kind === "completed" ? [attempt.outcome.run] : []);
  const attemptsFull = attempts.length >= maxVolatileAttempts;

  const retire = useCallback((): Promise<ReaderReviewStopResult> => {
    generation.current++;
    checkController.current?.abort();
    checkController.current = null;
    setCheckingSources(false);
    const operation = active.current;
    active.current = null;
    operation?.controller.abort();
    if (!operation) return Promise.resolve("stopped");
    const notice = { message: operation.requestId ? stopRequestedCopy : cancelCopy };
    cancellation.current = notice;
    const fallback: ReaderReviewStopResult = operation.requestId ? "stopped" : "not-started";
    let result: Promise<ReaderReviewStopResult>;
    try {
      result = Promise.resolve(operation.stop({ requestId: operation.requestId })).then(
        (outcome) => outcome ?? fallback,
        () => "unconfirmed" as const
      );
    } catch { result = Promise.resolve("unconfirmed"); }
    return result.then((outcome) => {
      notice.message = stopMessage(outcome);
      // Passive fact changes retain this notice; a new operation or closed view retires ownership.
      if (alive.current && cancellation.current === notice && !active.current) setMessage(notice.message);
      return outcome;
    });
  }, []);

  // Layout cleanup invalidates old callbacks before controls for a new disclosure become usable.
  useLayoutEffect(() => {
    alive.current = true;
    currentRevision.current = props.disclosureRevision;
    checkController.current?.abort();
    checkController.current = null;
    setCheckingSources(false);
    setPrepared(null);
    setPhase(cancellation.current ? "stopped" : "idle");
    setNavigationBusy(false);
    const initial = props.supported
      ? (hadPrepared.current ? refusalCopy.changed : "Prepare a fresh disclosure and inspect it before starting.")
      : "Reader review is unavailable on this host. No source preparation or provider request can start.";
    setMessage(cancellation.current?.message ?? initial);
    hadPrepared.current = false;
    return () => {
      alive.current = false;
      void retire();
    };
  }, [props.disclosureRevision, props.supported, retire]);

  // A disclosure revision retires only that prepared scope's check; completed-run checks remain.
  const preparedScope = useRef<string | undefined>(undefined);
  preparedScope.current = prepared?.envelope.scopeDigest;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is the explicit boundary; the prepared digest is read from a ref.
  useLayoutEffect(() => {
    setSourceCheck((current) => withoutScope(current, preparedScope.current));
    // The prepared envelope itself is cleared by the revision effect above.
  }, [props.disclosureRevision]);

  function begin(requestId: string | null = null): Operation {
    generation.current++;
    cancellation.current = null;
    const operation = { controller: new AbortController(), requestId, revision: props.disclosureRevision, stop: props.onStop };
    active.current = operation;
    return operation;
  }
  function isCurrent(operation: Operation) {
    return alive.current && active.current === operation && operation.revision === currentRevision.current && !operation.controller.signal.aborted;
  }
  function focusStatus() { status.current?.focus(); }

  async function prepare() {
    if (!props.supported || active.current || checkController.current || attemptsFull) return;
    const operation = begin();
    setSourceCheck((current) => withoutScope(current, prepared?.envelope.scopeDigest));
    setPrepared(null);
    setPhase("preparing");
    setMessage("Preparing the selected saved scope · No provider request has started.");
    focusStatus();
    try {
      const result = await props.onPrepare({ bookId: props.bookId, signal: operation.controller.signal, previousRunId: attempts.at(-1)?.requestId ?? null });
      if (!isCurrent(operation)) return;
      assertReviewData(result);
      if (result.kind === "blocked") {
        setPhase("idle");
        setMessage(`${refusalMessage(result.reason)}${result.detail ? ` ${result.detail}` : ""}`);
      } else if (result.kind === "ready") {
        const value = acceptPreparation(result.prepared, props.bookId);
        if (seenRequests.current.has(value.envelope.requestId)) throw new Error("Reused request");
        seenRequests.current.add(value.envelope.requestId);
        setPrepared(value);
        setPhase("ready");
        setMessage("Disclosure ready · Inspect the exact scope, reader, destination and terms before Start.");
      } else throw new Error("Invalid preparation");
    } catch {
      if (!isCurrent(operation)) return;
      setPhase("failed");
      setMessage("The disclosure could not be validated. Check the selected saved scope and terms, then prepare again. No provider request started.");
    } finally {
      if (isCurrent(operation)) active.current = null;
    }
  }

  const environment = prepared?.envelope.environment;
  const consentReady = prepared?.envelope.books.every((book) => book.consentSatisfied) === true;
  const destinationReady = environment?.hostSupported === true && environment.connectionAvailable === true && environment.modelSupported === true;
  const canStart = props.supported && phase === "ready" && consentReady && destinationReady && !attemptsFull;

  async function start() {
    if (!canStart || !prepared || attemptsFull || active.current || checkController.current || startedRequests.current.has(prepared.envelope.requestId)) return;
    const envelope = prepared.envelope;
    const connection = prepared.connection;
    startedRequests.current.add(envelope.requestId);
    const operation = begin(envelope.requestId);
    setPhase("running");
    setMessage(`Review in progress · ${envelope.destination.provider} · ${envelope.destination.model}. Text already sent cannot be recalled.`);
    focusStatus();
    try {
      const outcome = await props.onStart({ envelope, signal: operation.controller.signal });
      if (!isCurrent(operation)) return;
      assertReviewData(outcome);
      if (outcome.kind === "completed") {
        let run: ReaderRun;
        try {
          run = await acceptRun(outcome.run, envelope);
        } catch {
          if (isCurrent(operation)) {
            setAttempts((previous) => appendAttempt(previous, { requestId: envelope.requestId, envelope, connection, outcome: { kind: "invalid-result" } }));
            setPhase("failed");
            setMessage(revalidationFailureCopy);
          }
          return;
        }
        if (!isCurrent(operation)) return;
        const completedAfter = attempts.filter((attempt) => attempt.outcome.kind === "completed").length + 1;
        setAttempts((previous) => appendAttempt(previous, { requestId: run.runId, envelope: run.envelope, connection, outcome: { kind: "completed", run } }));
        setPhase("completed");
        setMessage(completedAfter >= 2 ? completedRerunCopy
          : "Review completed · Subjective findings, with historical evidence. A rerun requires a new disclosure and Start.");
      } else if (outcome.kind === "blocked") {
        setPhase("idle");
        setMessage(`${refusalMessage(outcome.reason)}${outcome.detail ? ` ${outcome.detail}` : ""}`);
      } else if (outcome.kind === "failed") {
        setAttempts((previous) => appendAttempt(previous, { requestId: envelope.requestId, envelope, connection, outcome: { kind: "failed", reason: boundedFailureReason(outcome.reason) } }));
        setPhase("failed");
        setMessage(failureMessage(outcome.reason));
      } else if (outcome.kind === "stopped") {
        setAttempts((previous) => appendAttempt(previous, { requestId: envelope.requestId, envelope, connection, outcome: { kind: "stopped" } }));
        setPhase("stopped");
        setMessage(stoppedCopy);
      } else throw new Error("Invalid result");
    } catch {
      if (!isCurrent(operation)) return;
      setAttempts((previous) => appendAttempt(previous, { requestId: envelope.requestId, envelope, connection, outcome: { kind: "unknown" } }));
      setPhase("failed");
      setMessage("The request failed or its result could not be validated · Incomplete. Text already sent cannot be recalled. Prepare a new request to try again; it may incur cost.");
    } finally {
      if (isCurrent(operation)) {
        active.current = null;
        setPrepared(null);
      }
    }
  }

  function stop() {
    const wasRunning = active.current?.requestId !== null && active.current?.requestId !== undefined;
    // The attempt is recorded at stop time with its prepared envelope: the in-flight Start's late
    // resolution is intentionally ignored, and a stopped attempt must stay visible for attribution.
    const pendingEnvelope = wasRunning ? prepared?.envelope : undefined;
    const pendingConnection = wasRunning ? prepared?.connection : undefined;
    const result = retire();
    if (pendingEnvelope) {
      const envelope = pendingEnvelope;
      const connection = pendingConnection;
      setAttempts((previous) => appendAttempt(previous, connection
        ? { requestId: envelope.requestId, envelope, connection, outcome: { kind: "stopped" } }
        : { requestId: envelope.requestId, envelope, outcome: { kind: "stopped" } }));
    }
    const stoppedGeneration = generation.current;
    setPrepared(null);
    setPhase("stopped");
    setNavigationBusy(false);
    setMessage(wasRunning ? stopRequestedCopy : cancelCopy);
    focusStatus();
    void result.then((outcome) => {
      if (alive.current && generation.current === stoppedGeneration && !active.current) {
        setMessage(stopMessage(outcome));
      }
    });
  }

  async function checkCurrentSources() {
    const check = props.onCheckSources;
    if (!check || !props.supported || active.current || checkController.current || navigationBusy) return;
    const envelopes: ReviewEnvelope[] = [];
    const add = (envelope: ReviewEnvelope) => {
      if (!envelopes.some((candidate) => candidate.scopeDigest === envelope.scopeDigest)) envelopes.push(envelope);
    };
    if (prepared) add(prepared.envelope);
    for (const run of completedRuns) add(run.envelope);
    if (envelopes.length === 0) return;
    const controller = new AbortController();
    checkController.current = controller;
    const revision = currentRevision.current;
    setCheckingSources(true);
    setMessage(sourceCheckCopy.checking);
    focusStatus();
    try {
      const result = await check({ envelopes, signal: controller.signal });
      if (!alive.current || controller.signal.aborted || checkController.current !== controller || revision !== currentRevision.current) return;
      const accepted = acceptSourceCheck(result);
      setSourceCheck(accepted);
      const preparedSummary = prepared && accepted.kind === "checked" ? summaryFor(prepared.envelope, accepted) : null;
      if (prepared && preparedSummary?.status === "stale") {
        setPrepared(null);
        setPhase("idle");
        setMessage(refusalCopy.changed);
      } else if (prepared && preparedSummary?.status === "unavailable") {
        setPrepared(null);
        setPhase("idle");
        setMessage(refusalCopy.unavailable);
      } else if (accepted.kind === "failed") {
        setMessage(prepared ? sourceCheckCopy.failedPrepared : sourceCheckCopy.failedHistorical);
      } else if (!completedRuns.every((run) => summaryFor(run.envelope, accepted)?.status === "current")) {
        setMessage(sourceCheckCopy.staleOrUnavailable);
      } else if (prepared && preparedSummary?.status === "current") {
        setMessage(sourceCheckCopy.currentPrepared);
      } else {
        setMessage(sourceCheckCopy.currentHistorical);
      }
    } catch {
      if (!alive.current || controller.signal.aborted || checkController.current !== controller || revision !== currentRevision.current) return;
      setSourceCheck({ kind: "failed" });
      setMessage(prepared ? sourceCheckCopy.failedPrepared : sourceCheckCopy.failedHistorical);
    } finally {
      if (checkController.current === controller) {
        checkController.current = null;
        if (alive.current && revision === currentRevision.current) setCheckingSources(false);
      }
    }
  }

  async function navigate(run: ReaderRun, citation: Citation) {
    const key = navigationKey(run, citation);
    const sources = sourceCheck?.kind === "checked" ? sourceCheck.byScopeDigest.get(run.envelope.scopeDigest) ?? null : null;
    if (active.current || checkController.current || navigationRefusals.has(key) || !sources ||
        navigationDetail(run, citation, sources, props.editor).status !== "ready") return;
    const operation = begin();
    setNavigationBusy(true);
    setMessage(citationNavigationCopy.checking);
    try {
      const result = await props.onNavigate({ run, citation, signal: operation.controller.signal });
      if (!isCurrent(operation)) return;
      if (result !== "selected") {
        setNavigationRefusals((previous) => new Map(previous).set(key, result === "stale" ? "stale" : "unavailable"));
        focusStatus();
      }
      setMessage(result === "selected" ? citationNavigationCopy.selected
        : result === "stale" ? citationNavigationCopy.stale : citationNavigationCopy.unavailable);
    } catch {
      if (isCurrent(operation)) {
        setMessage(citationNavigationCopy.failed);
        focusStatus();
      }
    } finally {
      if (isCurrent(operation)) {
        active.current = null;
        setNavigationBusy(false);
      }
    }
  }

  const busy = phase === "preparing" || phase === "running";
  const checkAvailable = Boolean(props.onCheckSources) && props.supported && (prepared !== null || completedRuns.length > 0);
  return <section aria-labelledby={heading} className="space-y-4 p-4 text-(length:--text-body-size) text-foreground">
    <h3 id={heading} data-reader-review-heading tabIndex={-1} className="text-(length:--text-title-3-size) font-semibold">Structured reader review</h3>
    <p className="text-muted-foreground">Suggestion-only · Saved selected sources · Volatile by default. Closing this view discards unsaved snapshots, profiles and results. Explicitly saved feedback remains in Saved reviews.</p>
    <p ref={status} role="status" aria-live="polite" tabIndex={-1} className="rounded-[var(--corner-md)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]">{message}</p>
    {prepared ? <ReviewDisclosure prepared={prepared} /> : null}
    {phase === "ready" && !consentReady ? <p>{refusalCopy.consent}</p> : null}
    {phase === "ready" && !destinationReady ? <p>{refusalCopy.unavailable}</p> : null}
    <div className="flex flex-wrap gap-2">
      {phase === "ready" && prepared ? <Button variant="primary" className={reviewActionClass} disabled={!canStart || navigationBusy || checkingSources} onClick={() => void start()}>Start with {prepared.envelope.destination.provider}</Button> : null}
      {!busy ? <Button variant={phase === "ready" ? "secondary" : "primary"} className={reviewActionClass} disabled={!props.supported || props.prepareDisabled === true || navigationBusy || checkingSources || attemptsFull} aria-describedby={attemptsFull ? capNoteId : undefined} onClick={() => void prepare()}>
        {phase === "ready" ? "Refresh disclosure" : attempts.length ? "Prepare rerun" : "Prepare review"}
      </Button> : <Button className={reviewActionClass} onClick={stop}>{phase === "running" ? "Stop review" : "Cancel preparation"}</Button>}
      <Button variant="secondary" className={reviewActionClass} disabled={!checkAvailable || busy || checkingSources || navigationBusy} onClick={() => void checkCurrentSources()}>Check current sources</Button>
      <Button variant="ghost" className={reviewActionClass} onClick={() => { void retire(); cancellation.current = null; setPrepared(null); setAttempts([]); setNavigationRefusals(new Map()); setSourceCheck(null); setPhase("idle"); props.onClose(); }}>Close review</Button>
    </div>
    {attemptsFull ? <p id={capNoteId}>{attemptCapCopy}</p> : null}
    <ReaderReviewResults attempts={attempts} sourceCheck={sourceCheck} editor={props.editor} navigationBusy={busy || checkingSources || navigationBusy || !props.supported} navigationRefusals={navigationRefusals} onNavigate={(run, citation) => void navigate(run, citation)}
      persistence={props.persistence?.scope.bookId === props.bookId && props.persistence.scope.viewId === props.viewKey ? props.persistence : undefined} />
  </section>;
}
