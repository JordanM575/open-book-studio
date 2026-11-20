import { assertReviewData, freeze, REVIEW_LIMITS, timestampSchema } from "@ai-book-studio/core/review/contract";
import { reviewDisclosure, type CurrentSource, type ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import { buildReaderRun, type Citation, type ReaderRun } from "@ai-book-studio/core/review/findings";
import type {
  ReaderReviewConnection, ReaderReviewPriceFacts, ReaderReviewStopResult, ReaderReviewTerms
} from "@ai-book-studio/core/review/reader-api";
import type { SavedIdentity } from "@ai-book-studio/core/review/sources";
import type { ReviewPersistence } from "./SaveReviewControl";

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
  currentSources: readonly CurrentSource[];
  editor?: { clean: boolean; identity: SavedIdentity };
  /** No provider call or durable write. Resolve only the host's explicitly selected saved scope. */
  onPrepare(input: { bookId: string; signal: AbortSignal; previousRunId: string | null }): Promise<PreparationOutcome>;
  /** Host must revalidate after awaits, consume the request once, and use scoped execution only. */
  onStart(input: { envelope: ReviewEnvelope; signal: AbortSignal }): Promise<StartOutcome>;
  /** `requestId` is null while a disclosure is prepared but no provider request has started. */
  onStop(input: { requestId: string | null }): Promise<ReaderReviewStopResult> | ReaderReviewStopResult;
  /** Revalidate exact source AND actual clean editor immediately before selecting; no fuzzy search. */
  onNavigate(input: { run: ReaderRun; citation: Citation; signal: AbortSignal }): Promise<"selected" | "stale" | "unavailable">;
  onClose(): void;
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
  if (run.kind !== "reader-review" || reviewDisclosure(run.envelope).scopeDigest !== envelope.scopeDigest ||
      !Array.isArray(run.findings) || run.findings.length > REVIEW_LIMITS.findings) throw new Error("Invalid reader result");
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
