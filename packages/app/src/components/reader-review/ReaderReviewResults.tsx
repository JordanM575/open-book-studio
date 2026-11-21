import { reviewDisclosure, type CurrentSource } from "@ai-book-studio/core/review/envelope";
import {
  compareReaderRuns, readerSourceState, reviewCitationNavigation, sourceChangeKey,
  type Citation, type CitationNavigation, type ReaderRun, type ReaderSourceChange
} from "@ai-book-studio/core/review/findings";
import { Button } from "@ai-book-studio/ui/button";
import {
  attemptOutcomeCopy, attemptOutcomeHeading, comparisonCopy,
  sourceStatusCopy, staleSourceStatusCopy, unavailableSourceStatusCopy,
  type ReaderReviewProps, type ReaderSourceCheck, type VolatileReaderRun
} from "./contracts";
import { ProfileAttribution, reviewActionClass, reviewTextClass, SelectedScope } from "./ReviewDisclosure";
import { SaveReviewControl, type ReviewPersistence } from "./SaveReviewControl";

export function navigationKey(run: ReaderRun, citation: Citation): string {
  return JSON.stringify([run.runId, citation]);
}

/** Descriptor-first current-source check; malformed data never enables a selection. */
export function navigationDetail(
  run: ReaderRun,
  citation: Citation,
  currentSources: readonly CurrentSource[],
  editor: ReaderReviewProps["editor"]
): CitationNavigation {
  try {
    return reviewCitationNavigation(reviewDisclosure(run.envelope), citation, currentSources, editor);
  } catch {
    return { status: "unavailable", reason: "source" };
  }
}

export function navigationState(
  run: ReaderRun,
  citation: Citation,
  currentSources: readonly CurrentSource[],
  editor: ReaderReviewProps["editor"]
) {
  return navigationDetail(run, citation, currentSources, editor).status;
}

function evidenceCopy(value: CitationNavigation): string {
  if (value.status === "ready") return "Current navigation available";
  if (value.status === "stale") {
    return value.reason === "editor"
      ? "Editor not ready — save or finish editing, then try again"
      : "Stale saved source — navigation disabled";
  }
  return value.reason === "kind" ? "This source kind has no editor navigation" : "Source unavailable — navigation disabled";
}

function evidenceStateCopy(
  sourceCheck: ReaderSourceCheck | null | undefined,
  sources: readonly CurrentSource[] | null,
  navigation: CitationNavigation | null,
  refusal: "stale" | "unavailable" | undefined
): string {
  if (refusal) return refusal === "stale" ? "Stale — navigation disabled" : "Unavailable — navigation disabled";
  if (!sourceCheck) return "Source currency not checked — navigation disabled";
  if (sourceCheck.kind === "failed") return "Source currency could not be checked — navigation disabled";
  if (!sources) return "Source currency not checked — navigation disabled";
  return evidenceCopy(navigation ?? { status: "unavailable", reason: "source" });
}

function checkedSources(run: ReaderRun, sourceCheck: ReaderSourceCheck | null | undefined): readonly CurrentSource[] | null {
  if (sourceCheck?.kind !== "checked") return null;
  return sourceCheck.byScopeDigest.get(run.envelope.scopeDigest) ?? null;
}

function runSourceStatus(run: ReaderRun, sourceCheck: ReaderSourceCheck | null | undefined): string {
  if (!sourceCheck) return sourceStatusCopy.notChecked;
  if (sourceCheck.kind === "failed") return sourceStatusCopy.checkFailed;
  const sources = checkedSources(run, sourceCheck);
  if (!sources) return sourceStatusCopy.notChecked;
  try {
    const summary = readerSourceState(run.envelope, sources);
    if (summary.status === "current") return sourceStatusCopy.current;
    if (summary.status === "stale") return staleSourceStatusCopy(summary.stale, summary.total);
    return unavailableSourceStatusCopy(summary.unavailable || summary.total, summary.total);
  } catch {
    return sourceStatusCopy.checkFailed;
  }
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function scopeCounts(usage: { books: number; items: number; sourceBytes: number; requestBytes: number }): string {
  return `${usage.books} ${usage.books === 1 ? "book" : "books"} · ${usage.items} ${usage.items === 1 ? "item" : "items"} · ${count(usage.sourceBytes)} source bytes · ${count(usage.requestBytes)} request bytes`;
}

function sourceChangeSuffix(change: ReaderSourceChange): string {
  switch (change.kind) {
    case "added": return "added";
    case "removed": return "removed";
    case "revision": return `saved version ${change.fromVersion ?? "?"} → ${change.toVersion ?? "?"}`;
    case "selection": return `selected ranges changed at saved version ${change.toVersion ?? "?"}`;
    case "label": return `title or position changed at saved version ${change.toVersion ?? change.fromVersion ?? "?"}`;
    case "content":
      return change.toVersion === null ? "content changed" : `content changed at saved version ${change.toVersion}`;
  }
}

function profileSummary(profile: { id: string; origin: "builtin" | "author"; version: number; name: string }): string {
  return `${profile.name} (${profile.id}) · v${profile.version} · ${profile.origin === "builtin" ? "Built-in" : "Author"}`;
}

function exactAttribution(attempt: VolatileReaderRun) {
  const envelope = attempt.envelope;
  const profile = envelope.profile;
  return <details>
    <summary className={reviewActionClass}>Exact attribution</summary>
    <p>Model id: {envelope.destination.model}</p>
    <p>Connection id: {envelope.destination.connectionId}</p>
    <p>Endpoint identity: {envelope.destination.endpointIdentity}</p>
    <p>Scope digest: {envelope.scopeDigest}</p>
    {profile ? <>
      <p>Profile id: {profile.id} · Version {profile.version} · {profile.origin === "builtin" ? "Built-in" : "Author"}</p>
      <p>Profile digest: {profile.digest}</p>
    </> : null}
  </details>;
}

function namedFacts(attempt: VolatileReaderRun): { provider: string; model: string } {
  return {
    provider: attempt.connection?.providerName ?? attempt.envelope.destination.provider,
    model: attempt.connection?.modelName ?? attempt.envelope.destination.model
  };
}

function ComparisonRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-x-2"><dt className="font-semibold">{label}:{" "}</dt><dd>{children}</dd></div>;
}

function completedComparisonBody(before: VolatileReaderRun, after: VolatileReaderRun) {
  const beforeRun = before.outcome.kind === "completed" ? before.outcome.run : null;
  const afterRun = after.outcome.kind === "completed" ? after.outcome.run : null;
  if (!beforeRun || !afterRun) return null;
  const comparison = compareReaderRuns(beforeRun, afterRun);
  if (comparison.status === "not-comparable") {
    return <p>{comparisonCopy.notComparable}</p>;
  }
  const beforeNames = namedFacts(before);
  const afterNames = namedFacts(after);
  const facets: string[] = [];
  if (comparison.sourceChanged) facets.push("Sources");
  if (comparison.profileChanged) facets.push("Profile");
  if (comparison.destinationChanged) {
    if (comparison.destination.providerChanged) facets.push("Provider");
    if (comparison.destination.modelChanged) facets.push("Model");
    if (comparison.destination.connectionChanged) facets.push("Connection");
    if (comparison.destination.endpointChanged) facets.push("Destination identity");
  }
  if (comparison.request.changed) facets.push("Request");
  const inputsLine = facets.length === 0
    ? (comparison.interpretationChanged || comparison.evidenceChanged
      ? comparisonCopy.identicalChanged
      : comparisonCopy.identicalNoVisibleChange)
    : comparisonCopy.changed(facets.join(" · "));
  const union = new Set([
    ...beforeRun.envelope.sources.map(sourceChangeKey),
    ...afterRun.envelope.sources.map(sourceChangeKey)
  ]);
  const profileValue = !comparison.profile.changed
    ? "Unchanged"
      : comparison.profile.sameId || comparison.profile.versionChanged || comparison.profile.digestChanged
        ? `Changed · ${profileSummary(comparison.profile.from)} → ${profileSummary(comparison.profile.to)}`
        : "Changed · Profile snapshot changed";
  const providerValue = comparison.destination.providerChanged
    ? `Changed · ${beforeNames.provider} → ${afterNames.provider}`
    : `${afterNames.provider} · Unchanged`;
  const modelValue = comparison.destination.modelChanged
    ? `Changed · ${beforeNames.model} → ${afterNames.model}`
    : `${afterNames.model} · Unchanged`;
  const beforeLabel = before.connection?.label;
  const afterLabel = after.connection?.label;
  let connectionValue: string;
  if (beforeLabel === undefined || afterLabel === undefined) {
    connectionValue = comparison.destination.connectionChanged ? "Changed" : "Unchanged";
  } else if (comparison.destination.connectionChanged) {
    connectionValue = beforeLabel === afterLabel ? "Changed" : `Changed · ${beforeLabel} → ${afterLabel}`;
  } else if (beforeLabel === afterLabel) {
    connectionValue = `${afterLabel} · Unchanged`;
  } else {
    connectionValue = `Label changed · ${beforeLabel} → ${afterLabel} (same connection)`;
  }
  const requestParts: string[] = [];
  if (comparison.request.promptChanged) requestParts.push("Prompt");
  if (comparison.request.priorFeedbackChanged) requestParts.push("Prior feedback");
  if (comparison.request.bookPolicyChanged) requestParts.push("Book policy");
  const requestValue = comparison.request.changed ? `Changed · ${requestParts.join(" · ")}` : "Unchanged";
  const withheldOrInsufficient = comparison.before.withheldEvidence + comparison.after.withheldEvidence
    + comparison.before.insufficientFindings + comparison.after.insufficientFindings;
  const categoryKeys = ["reader-impression", "clarity", "pacing", "character-motivation", "continuity"] as const;
  return <>
    <p>{inputsLine}</p>
    <dl className="space-y-1">
      <ComparisonRow label="Sources">
        {comparison.sourceChanged ? `Changed · ${comparison.sources.length} of ${union.size} sources differ` : "Unchanged"}
      </ComparisonRow>
      <ComparisonRow label="Profile">{profileValue}</ComparisonRow>
      <ComparisonRow label="Provider">{providerValue}</ComparisonRow>
      <ComparisonRow label="Model">{modelValue}</ComparisonRow>
      <ComparisonRow label="Connection">{connectionValue}</ComparisonRow>
      <ComparisonRow label="Request">{requestValue}</ComparisonRow>
      {comparison.request.scopeCountsChanged ? <ComparisonRow label="Request scope">
        {scopeCounts(comparison.request.before)} → {scopeCounts(comparison.request.after)}
      </ComparisonRow> : null}
      <ComparisonRow label="Findings">{comparison.before.total} → {comparison.after.total}</ComparisonRow>
      <ComparisonRow label="Claims">
        {`${comparison.before.observations} observations · ${comparison.before.questions} questions · ${comparison.before.contradictions} contradictions → ${comparison.after.observations} observations · ${comparison.after.questions} questions · ${comparison.after.contradictions} contradictions`}
      </ComparisonRow>
      <ComparisonRow label="Evidence">
        {`${comparison.before.verifiedEvidence} verified · ${comparison.before.withheldEvidence} withheld → ${comparison.after.verifiedEvidence} verified · ${comparison.after.withheldEvidence} withheld`}
      </ComparisonRow>
      <ComparisonRow label="Interpretation">{comparison.interpretationChanged ? "Changed · Not a quality judgment" : "Unchanged"}</ComparisonRow>
      <ComparisonRow label="Evidence text">{comparison.evidenceChanged ? "Changed · Quotations or spans differ" : "Unchanged"}</ComparisonRow>
    </dl>
    {comparison.sources.length > 0 ? <ul aria-label="Source changes between the latest two runs" className="list-disc pl-5">
      {comparison.sources.map((change, index) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: The comparison derives changes deterministically oldest-first; labels may repeat across books, so index is the stable tiebreak.
        <li key={`${index}-${change.kind}-${change.label}`}>{change.label} · {sourceChangeSuffix(change)}</li>)}
    </ul> : null}
    <details>
      <summary className={reviewActionClass}>Counts by category</summary>
      <dl className="space-y-1">
        {categoryKeys.map((category) => <ComparisonRow key={category} label={category.replaceAll("-", " ")}>
          {comparison.before.byCategory[category]} → {comparison.after.byCategory[category]}
        </ComparisonRow>)}
      </dl>
    </details>
    {comparison.partial ? <p>{comparisonCopy.partialEvidence(withheldOrInsufficient)}</p> : null}
    <p>{comparisonCopy.standardNote}</p>
    <p>{comparisonCopy.capturedOnly}</p>
  </>;
}

function comparisonRegion(attempts: readonly VolatileReaderRun[]) {
  const completed = attempts.filter((attempt) => attempt.outcome.kind === "completed");
  const latest = attempts.at(-1);
  const latestIncomplete = latest && latest.outcome.kind !== "completed" ? latest : null;
  if (completed.length < 2) {
    let body: string;
    if (completed.length === 0) {
      body = attempts.length === 0 ? comparisonCopy.noAttempts : comparisonCopy.noneCompleted;
    } else {
      const others = attempts.length - completed.length;
      body = others === 0 ? comparisonCopy.oneCompleted : comparisonCopy.oneCompletedWithAttempts(others);
    }
    return <section aria-label="Latest run comparison" className="space-y-2">
      <p>{body}</p>
    </section>;
  }
  const before = completed.at(-2);
  const after = completed.at(-1);
  if (!before || !after) return null;
  return <section aria-label="Latest run comparison" className="space-y-2 border-t border-[var(--border)] pt-4">
    {latestIncomplete ? <p>{comparisonCopy.latestNotCompleted(latestIncomplete.requestId)}</p> : null}
    <h3 className="font-semibold">{comparisonCopy.heading}</h3>
    <p>{comparisonCopy.intro(
      before.outcome.kind === "completed" ? before.outcome.run.runId : before.requestId,
      after.outcome.kind === "completed" ? after.outcome.run.runId : after.requestId,
      completed.length)}</p>
    {completedComparisonBody(before, after)}
  </section>;
}

export function ReaderReviewResults({ runs, attempts, sourceCheck, editor, navigationBusy, navigationRefusals, onNavigate, persistence }: {
  persistence?: ReviewPersistence | undefined;
  /** Legacy completed-run list for saved-review callers; renders without the comparison region. */
  runs?: readonly ReaderRun[];
  /** Panel path: the full volatile attempt history, oldest first. */
  attempts?: readonly VolatileReaderRun[];
  /** Optional compatibility input for existing callers; it never counts as a currency check. */
  currentSources?: readonly CurrentSource[];
  sourceCheck?: ReaderSourceCheck | null;
  editor: ReaderReviewProps["editor"];
  navigationBusy: boolean;
  navigationRefusals: ReadonlyMap<string, "stale" | "unavailable">;
  onNavigate(run: ReaderRun, citation: Citation): void;
}) {
  const panelMode = attempts !== undefined;
  const items: readonly VolatileReaderRun[] = attempts
    ?? (runs ?? []).map((run) => ({ requestId: run.runId, envelope: run.envelope, outcome: { kind: "completed" as const, run } }));
  return <section aria-label="Volatile reader results" className="space-y-6">
    {panelMode ? comparisonRegion(items) : null}
    {items.map((attempt) => {
      if (attempt.outcome.kind !== "completed") {
        const { envelope, connection, outcome } = attempt;
        const names = namedFacts(attempt);
        const copy = outcome.kind === "failed" ? attemptOutcomeCopy.failed(outcome.reason)
          : outcome.kind === "stopped" ? attemptOutcomeCopy.stopped
            : outcome.kind === "invalid-result" ? attemptOutcomeCopy.invalidResult
              : attemptOutcomeCopy.unknown;
        return <section key={attempt.requestId} aria-label={`Reader attempt ${attempt.requestId}`} className="space-y-4 border-t border-[var(--border)] pt-4">
          <h3 className="font-semibold">Run {attempt.requestId} · {attemptOutcomeHeading[outcome.kind]}</h3>
          <p>Provider: {names.provider} · Model: {names.model}</p>
          {connection ? <p>Connection: {connection.label}</p> : null}
          <p className="text-muted-foreground">Disclosure captured {envelope.capturedAt} · No completed result</p>
          {envelope.profile ? <ProfileAttribution profile={envelope.profile} /> : null}
          <p>{copy}</p>
          <details><summary className={reviewActionClass}>Inspect what this attempt disclosed</summary><SelectedScope envelope={envelope} /></details>
          {exactAttribution(attempt)}
          <p>No findings were retained for this attempt.</p>
        </section>;
      }
      const run = attempt.outcome.run;
      const sources = checkedSources(run, sourceCheck);
      const names = namedFacts(attempt);
      return <article key={run.runId} aria-label={`Reader run ${run.runId}`} className="space-y-4 border-t border-[var(--border)] pt-4">
        {panelMode ? <>
          <h3 className="font-semibold">Run {run.runId} · Completed</h3>
          <p>Provider: {names.provider} · Model: {names.model}</p>
          {attempt.connection ? <p>Connection: {attempt.connection.label}</p> : null}
        </> : <h3 className="font-semibold">Run {run.runId} · {names.provider} · {names.model}</h3>}
        <p className="text-muted-foreground">Started {run.startedAt} · Completed {run.completedAt}</p>
        {run.envelope.profile ? <ProfileAttribution profile={run.envelope.profile} /> : null}
        <SaveReviewControl run={run} persistence={persistence} />
        <p>{runSourceStatus(run, sourceCheck)}</p>
        <details><summary className={reviewActionClass}>Inspect this run's historical scope</summary><SelectedScope envelope={run.envelope} /></details>
        {exactAttribution(attempt)}
        {run.findings.length === 0 ? <p>No findings returned. This does not establish that the manuscript has no issues.</p> : null}
        {run.findings.map((finding) => {
        const labelCounts = new Map<string, number>();
        for (const item of finding.evidence) labelCounts.set(item.label, (labelCounts.get(item.label) ?? 0) + 1);
        return <section key={finding.findingId} aria-label={`${finding.category.replaceAll("-", " ")} finding`} className="space-y-2">
          <h4 className="font-semibold">{finding.category.replaceAll("-", " ")} · Subjective {finding.claim === "contradiction" && finding.evidenceState !== "complete" ? "question" : finding.claim}</h4>
          <p className={reviewTextClass}>{finding.interpretation}</p>
          <p>Evidence: {finding.evidenceState.replaceAll("-", " ")} · {finding.invalidEvidence.length} unverified quotations withheld</p>
          {finding.evidence.map((evidence, index) => {
            const refusal = navigationRefusals.get(navigationKey(run, evidence.citation));
            const navigation = !refusal && sources ? navigationDetail(run, evidence.citation, sources, editor) : null;
            const copy = evidenceStateCopy(sourceCheck, sources, navigation, refusal);
            const ready = !refusal && navigation?.status === "ready";
            const duplicateLabel = (labelCounts.get(evidence.label) ?? 0) > 1;
            const accessibleName = `Show exact passage for ${finding.findingId}, ${evidence.label}${duplicateLabel ? `, evidence ${index + 1}` : ""}`;
            // biome-ignore lint/suspicious/noArrayIndexKey: An immutable run fixes evidence order for its entire lifetime, including duplicate quotes.
            return <div key={`${finding.findingId}-${index}`} className="space-y-2">
              <blockquote className={reviewTextClass}>{evidence.citation.quote}</blockquote>
              <p className="text-muted-foreground">{evidence.label} · Historical quotation · {copy}</p>
              <Button className={reviewActionClass} aria-label={accessibleName} disabled={navigationBusy || !ready} onClick={() => onNavigate(run, evidence.citation)}>
                Show exact passage
              </Button>
            </div>;
          })}
        </section>;
        })}
      </article>;
    })}
  </section>;
}
