import { reviewDisclosure, type CurrentSource } from "@ai-book-studio/core/review/envelope";
import {
  compareReaderRuns, readerSourceState, reviewCitationNavigation, type Citation, type CitationNavigation, type ReaderRun
} from "@ai-book-studio/core/review/findings";
import { Button } from "@ai-book-studio/ui/button";
import {
  sourceStatusCopy, staleSourceStatusCopy, unavailableSourceStatusCopy,
  type ReaderReviewProps, type ReaderSourceCheck
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

export function ReaderReviewResults({ runs, sourceCheck, editor, navigationBusy, navigationRefusals, onNavigate, persistence }: {
  persistence?: ReviewPersistence | undefined;
  runs: readonly ReaderRun[];
  /** Optional compatibility input for existing callers; it never counts as a currency check. */
  currentSources?: readonly CurrentSource[];
  sourceCheck?: ReaderSourceCheck | null;
  editor: ReaderReviewProps["editor"];
  navigationBusy: boolean;
  navigationRefusals: ReadonlyMap<string, "stale" | "unavailable">;
  onNavigate(run: ReaderRun, citation: Citation): void;
}) {
  const before = runs.at(-2);
  const after = runs.at(-1);
  const comparison = before && after ? compareReaderRuns(before, after) : null;
  return <section aria-label="Volatile reader results" className="space-y-6">
    {comparison && before && after ? <section aria-label="Latest run comparison" className="space-y-2">
      <h3 className="font-semibold">Compare the latest two runs</h3>
      <p>Run {before.runId} → Run {after.runId}</p>
      <p>Sources: {comparison.sourceChanged ? "Changed" : "Unchanged"} · Profile: {comparison.profileChanged ? "Changed" : "Unchanged"}</p>
      <p>Provider or destination: {comparison.destinationChanged ? "Changed" : "Unchanged"} · Request or feedback: {comparison.promptOrFeedbackChanged ? "Changed" : "Unchanged"}</p>
      <p>Interpretation: {comparison.interpretationChanged ? "Changed" : "Unchanged"}</p>
      <p>{comparison.modelVariation ? "Same-input model variation. " : ""}Changes are not improvement scores.</p>
    </section> : null}
    {runs.map((run) => {
      const sources = checkedSources(run, sourceCheck);
      return <article key={run.runId} aria-label={`Reader run ${run.runId}`} className="space-y-4 border-t border-[var(--border)] pt-4">
      <h3 className="font-semibold">Run {run.runId} · {run.envelope.destination.provider} · {run.envelope.destination.model}</h3>
      <p className="text-muted-foreground">Started {run.startedAt} · Completed {run.completedAt}</p>
      {run.envelope.profile ? <ProfileAttribution profile={run.envelope.profile} /> : null}
      <SaveReviewControl run={run} persistence={persistence} />
      <p>{runSourceStatus(run, sourceCheck)}</p>
      <details><summary className={reviewActionClass}>Inspect this run's historical scope</summary><SelectedScope envelope={run.envelope} /></details>
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
