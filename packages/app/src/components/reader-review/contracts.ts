import { assertReviewData, freeze, REVIEW_LIMITS, timestampSchema } from "@ai-book-studio/core/review/contract";
import { reviewDisclosure, validateReviewEnvelope, type CurrentSource, type ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import { buildReaderRun, type Citation, type ReaderRun } from "@ai-book-studio/core/review/findings";
import type {
  ReaderReviewConnection, ReaderReviewPriceFacts, ReaderReviewStopResult, ReaderReviewTerms
} from "@ai-book-studio/core/review/reader-api";
import type { SavedIdentity } from "@ai-book-studio/core/review/sources";
import type { ReviewPersistence } from "./SaveReviewControl";

export type ReaderRunOutcome =
  | { readonly kind: "completed"; readonly run: ReaderRun }
  | { readonly kind: "failed"; readonly reason: ReviewFailure }
  | { readonly kind: "stopped" }
  | { readonly kind: "invalid-result" }
  | { readonly kind: "unknown" };

/**
 * One volatile attempt in the open review view. `envelope` is the accepted prepared disclosure for
 * non-completed attempts and the accepted run envelope for completed attempts. `connection` is the
 * accepted preparation's display facts, captured before Start; it is renderer memory only and is
 * never serialized, saved or sent. Absent only for the legacy `runs` compatibility path.
 */
export interface VolatileReaderRun {
  readonly requestId: string;
  readonly envelope: ReviewEnvelope;
  readonly connection?: ReaderReviewConnection;
  readonly outcome: ReaderRunOutcome;
}

/** Append-only bound for the open view; a ninth attempt is refused locally and never evicts. */
export const maxVolatileAttempts = 8;
export const attemptCapCopy = "This view keeps up to 8 attempts, including failed and stopped attempts. Close the review to discard this volatile history and start a new view. Nothing is prepared or sent.";
export const completedRerunCopy = "Review completed · Subjective findings, with historical evidence. The latest two completed runs are compared below; earlier runs remain in this view.";

export const attemptOutcomeHeading: Record<Exclude<ReaderRunOutcome["kind"], "completed">, string> = {
  failed: "Failed",
  stopped: "Stopped",
  "invalid-result": "Result not accepted",
  unknown: "Outcome unknown"
};

export const comparisonCopy = {
  noAttempts: "No runs yet · No comparison. Prepare the selected saved scope and inspect the disclosure before Start.",
  oneCompleted: "One completed run · No comparison yet. A second completed run in this view compares sources, profile, provider and request facts.",
  oneCompletedWithAttempts: (attempts: number) =>
    `One completed run and ${attempts === 1 ? "one attempt" : `${attempts} attempts`} without findings · No comparison. A second completed run compares the input facts.`,
  noneCompleted: "No completed runs to compare. Attempts remain listed with their disclosure and attribution.",
  latestNotCompleted: (id: string) =>
    `The latest attempt (${id}) did not complete. This comparison uses the latest two completed runs; the attempt remains listed below with its attribution.`,
  heading: "Compare the latest two runs",
  intro: (beforeId: string, afterId: string, completed: number) =>
    `Run ${beforeId} → Run ${afterId} · ${completed} completed runs in this view. Earlier runs remain below and are not replaced.`,
  identicalNoVisibleChange: "Inputs: Identical · No visible difference in the returned findings.",
  identicalChanged: "Inputs: Identical · Interpretation or evidence changed. Same-input model variation, not an improvement score.",
  changed: (facets: string) => `Inputs: Changed · ${facets}. This compares input facts; it is not an improvement score.`,
  partialEvidence: (count: number) =>
    `Partial evidence · ${count} quotations withheld or insufficient across these runs. Counts describe returned findings, not manuscript coverage.`,
  standardNote: "Counts describe returned findings, not manuscript coverage or quality.",
  capturedOnly: "Compared from captured revisions · Check current sources separately.",
  notComparable: "Not comparable · The run facts could not be validated here. No delta is shown; attribution and historical quotations remain."
} as const;

export type ReviewRefusal =
  | "unavailable" | "permission" | "no-model" | "invalid-selection" | "scope-too-large" | "consent" | "terms" | "changed";
export type ReviewFailure = "provider" | "overflow" | "malformed" | "refused";
export type ReviewTerms = ReaderReviewTerms;
export interface PreparedReaderReview {
  readonly envelope: ReviewEnvelope;
  /** Host-resolved text for each book's exact bound terms revision, never an implicit acceptance. */
  readonly terms: readonly ReviewTerms[];
  /** Exact provider/model/connection attribution shown before Start. */
  readonly connection: ReaderReviewConnection;
  /** Known unit prices or an explicitly unknown price class; never a dollar cap. */
  readonly priceFacts: ReaderReviewPriceFacts;
}
export type PreparationOutcome = { kind: "ready"; prepared: PreparedReaderReview } |
  { kind: "blocked"; reason: ReviewRefusal; detail?: string };
export type StartOutcome = { kind: "completed"; run: ReaderRun } |
  { kind: "blocked"; reason: ReviewRefusal; detail?: string } |
  { kind: "failed"; reason: ReviewFailure } |
  { kind: "stopped" };
export interface ReaderReviewProps {
  persistence?: ReviewPersistence;
  open: boolean;
  bookId: string;
  /** Changes for every host view lifetime, including returning to the same book. */
  viewKey: string;
  /** Change whenever selection, profile, destination, terms, consent or capability facts change. */
  disclosureRevision: string;
  supported: boolean;
  /** True when the host has no explicit selection or another host operation owns the surface. */
  prepareDisabled?: boolean;
  editor?: { clean: boolean; identity: SavedIdentity };
  /** No provider call or durable write. Resolve only the host's explicitly selected saved scope. */
  onPrepare(input: { bookId: string; signal: AbortSignal; previousRunId: string | null }): Promise<PreparationOutcome>;
  /** Host must revalidate after awaits, consume the request once, and use scoped execution only. */
  onStart(input: { envelope: ReviewEnvelope; signal: AbortSignal }): Promise<StartOutcome>;
  /** `requestId` is null while a disclosure is prepared but no provider request has started. */
  onStop(input: { requestId: string | null }): Promise<ReaderReviewStopResult> | ReaderReviewStopResult;
  /** Revalidate exact source AND actual clean editor immediately before selecting; no fuzzy search. */
  onNavigate(input: { run: ReaderRun; citation: Citation; signal: AbortSignal }): Promise<"selected" | "stale" | "unavailable">;
  /**
   * One explicit, read-only comparison for the prepared envelope and completed runs. Never called
   * automatically and never a provider call. The map is keyed by `scopeDigest`.
   */
  onCheckSources?(input: { envelopes: readonly ReviewEnvelope[]; signal: AbortSignal }): Promise<ReaderSourceCheck> | ReaderSourceCheck;
  onClose(): void;
}

/** Renderer-only, per-scope current sources or one failed comparison. No durable state. */
export type ReaderCurrentSourcesByScope = ReadonlyMap<string, readonly CurrentSource[]>;
export type ReaderSourceCheck =
  | { readonly kind: "checked"; readonly byScopeDigest: ReaderCurrentSourcesByScope }
  | { readonly kind: "failed" };

export const revalidationFailureCopy = "The review result could not be revalidated here. No result was added to this view. The review is incomplete; prepare a new request to try again.";

export const sourceCheckCopy = {
  checking: "Checking the saved sources · No provider request.",
  currentPrepared: "Saved sources checked · Current. The disclosure is unchanged; Start revalidates before sending.",
  currentHistorical: "Saved sources checked · Current. Historical quotations remain historical.",
  staleOrUnavailable: "Saved sources checked · Stale or unavailable. Historical quotations remain; navigation is disabled.",
  failedPrepared: "The saved sources could not be checked. The disclosure is unchanged; Start revalidates before sending. No additional provider request started.",
  failedHistorical: "The saved sources could not be checked. The report remains historical; no additional provider request started."
} as const;

export const citationNavigationCopy = {
  checking: "Checking the current source and editor before showing the exact passage…",
  selected: "The host confirmed the exact current passage was selected.",
  stale: "The passage is stale or the editor is not ready. Its historical quotation remains here; no replacement passage was selected. Save or finish editing, then check current sources.",
  unavailable: "The passage is unavailable. Its historical quotation remains here; no replacement passage was selected.",
  failed: "The passage could not be opened. Its historical quotation remains here. Try again after checking the source."
} as const;

export const sourceStatusCopy = {
  notChecked: "Source status: Not checked · Check current sources before navigating. Historical quotations remain.",
  checkFailed: "Source status: Check failed · The saved sources could not be compared. Historical quotations remain; navigation is disabled.",
  current: "Source status: Current at the last check · Interpretations are subjective. Source changes after that check are not watched; check again before navigating."
} as const;

export function staleSourceStatusCopy(stale: number, total: number): string {
  return `Source status: Stale at the last check (${stale} of ${total}) · This report is historical. Quotations remain; navigation is disabled for changed sources.`;
}
export function unavailableSourceStatusCopy(unavailable: number, total: number): string {
  return `Source status: Unavailable at the last check (${unavailable} of ${total}) · This report is historical. Quotations remain; navigation is disabled.`;
}

export const refusalCopy: Record<ReviewRefusal, string> = {
  unavailable: "The selected source or destination is unavailable. Check your selection and connection, then prepare again.",
  permission: "This connection is connected but cannot use its plan for review. Check the plan permission, then prepare again.",
  "no-model": "The selected model is unavailable on this connection. Choose a model in the model picker, then prepare again.",
  "invalid-selection": "The selection is not a valid saved range. Choose the saved chapters again. Nothing was sent.",
  "scope-too-large": "The selected scope is too large. Choose a smaller selection, then prepare again. Nothing was shortened or sent.",
  consent: "This model may use the selected text for training. Allow training for this book in the model picker, then prepare again.",
  terms: "Applicable data-use or training terms are unavailable. Check the provider terms, then prepare again.",
  changed: "The disclosure changed. Prepare a fresh disclosure and inspect it before starting."
};
export const failureCopy: Record<ReviewFailure, string> = {
  provider: "The provider request failed. The review is incomplete. Prepare a new request to try again; another request may incur cost.",
  overflow: "The provider's context or output limit was exceeded. The review is incomplete. Choose a smaller scope and prepare again.",
  malformed: "The review result could not be validated. The review is incomplete. Prepare a new request to try again.",
  refused: "The provider refused this request. The review is incomplete. Review your scope before preparing a new request."
};

export const attemptOutcomeCopy = {
  failed: (reason: ReviewFailure): string =>
    `${failureCopy[reason]} No findings were retained for this attempt. Its disclosure and attribution remain; nothing was replaced.`,
  stopped: "Stopped · Incomplete. Stopping prevents later dispatch best-effort; text already sent cannot be recalled. No findings were retained for this attempt.",
  invalidResult: `${revalidationFailureCopy} Its disclosure remains for attribution; no findings were retained.`,
  unknown: "The request outcome is unknown. The request may have been sent; text already sent cannot be recalled. No findings were retained here."
} as const;

export function refusalMessage(reason: unknown): string {
  return typeof reason === "string" && Object.hasOwn(refusalCopy, reason) ? refusalCopy[reason as ReviewRefusal] : refusalCopy.unavailable;
}
export function failureMessage(reason: unknown): string {
  return typeof reason === "string" && Object.hasOwn(failureCopy, reason) ? failureCopy[reason as ReviewFailure] : failureCopy.provider;
}

function boundedName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Invalid reader connection");
  return value;
}
function unitPrice(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid reader price");
  return value;
}

/** Only core-registered envelopes enter disclosure. This does not establish host provenance. */
export function acceptPreparation(value: PreparedReaderReview, bookId: string): PreparedReaderReview {
  assertReviewData(value);
  const envelope = reviewDisclosure(value.envelope);
  if (envelope.kind !== "reader-review" || !envelope.profile || envelope.books.length !== 1 ||
      envelope.books[0]?.bookId !== bookId || !Array.isArray(value.terms) || value.terms.length !== 1) {
    throw new Error("Invalid reader disclosure");
  }
  const connection = value.connection;
  if (!connection || connection.id !== envelope.destination.connectionId) throw new Error("Invalid reader connection");
  const acceptedConnection = {
    id: boundedName(connection.id),
    label: boundedName(connection.label),
    providerName: boundedName(connection.providerName),
    modelName: boundedName(connection.modelName)
  };
  const priceFacts = value.priceFacts;
  if (!priceFacts || !["plan", "metered", "unknown"].includes(priceFacts.kind)) throw new Error("Invalid reader price facts");
  const acceptedPriceFacts = {
    kind: priceFacts.kind,
    inputPerMillion: unitPrice(priceFacts.inputPerMillion),
    cachedInputPerMillion: unitPrice(priceFacts.cachedInputPerMillion),
    outputPerMillion: unitPrice(priceFacts.outputPerMillion),
    asOf: priceFacts.asOf === null ? null : timestampSchema.parse(priceFacts.asOf)
  };
  const terms = value.terms.map((term) => {
    const book = envelope.books.find((entry) => entry.bookId === term.bookId);
    if (!book || term.termsRevision !== book.termsRevision ||
        typeof term.dataUse !== "string" || !term.dataUse.trim() || term.dataUse.length > 16000 ||
        typeof term.training !== "string" || !term.training.trim() || term.training.length > 16000) {
      throw new Error("Invalid reader terms");
    }
    return { bookId: term.bookId, termsRevision: term.termsRevision, dataUse: term.dataUse, training: term.training };
  });
  return freeze({ envelope, terms, connection: acceptedConnection, priceFacts: acceptedPriceFacts });
}

/** Recompute evidence/subjectivity from the core run; never trust display labels or verified flags. */
export async function acceptRun(run: ReaderRun, envelope: ReviewEnvelope): Promise<ReaderRun> {
  assertReviewData(run);
  if (run.kind !== "reader-review" || !Array.isArray(run.findings) || run.findings.length > REVIEW_LIMITS.findings) {
    throw new Error("Invalid reader result");
  }
  // IPC copies the envelope. Validate its content and digest in this renderer before comparing scope.
  const returnedEnvelope = await validateReviewEnvelope(run.envelope);
  if (returnedEnvelope.scopeDigest !== envelope.scopeDigest) throw new Error("Invalid reader result scope");
  const findings = run.findings.map((finding) => {
    if (!Array.isArray(finding.evidence) || !Array.isArray(finding.invalidEvidence) ||
        finding.evidence.length + finding.invalidEvidence.length > REVIEW_LIMITS.evidence) throw new Error("Invalid evidence");
    return {
      findingId: finding.findingId, category: finding.category, readerId: finding.readerId,
      readerVersion: finding.readerVersion, runId: finding.runId, interpretation: finding.interpretation,
      claim: finding.claim,
      evidence: [...finding.evidence.map((entry: ReaderRun["findings"][number]["evidence"][number]) => entry.citation), ...finding.invalidEvidence.map(() => null)]
    };
  });
  return buildReaderRun({ runId: run.runId, startedAt: run.startedAt, completedAt: run.completedAt, envelope,
    output: JSON.stringify({ runId: run.runId, readerId: envelope.profile?.id,
      readerVersion: envelope.profile?.version, findings }) });
}
