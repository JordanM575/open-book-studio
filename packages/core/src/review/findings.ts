import type { z } from "zod";
import type { BookDetail } from "../schema";
import {
  assertReviewData, canonicalJson, checkBytes, freeze, idSchema, isReviewData, requireContract, ReviewContractError,
  REVIEW_LIMITS, timestampSchema, validSpan, type Immutable
} from "./contract";
import {
  reviewDisclosure, reviewResourceUsage, sourceComparisonKey, sourceCurrency, validateReviewEnvelope,
  type CurrentSource, type ReviewEnvelope, type ReviewResourceUsage
} from "./envelope";
import { captureChapterSource, sameSavedIdentity, savedEditorSchema, type ChapterSource, type ReviewSource, type SavedIdentity } from "./sources";
import type { categorySchema } from "./profiles";
import { citationSchema, findingsOutputSchema } from "./wire-schema";

export type Citation = Immutable<z.infer<typeof citationSchema>>;
export type VerifiedCitation = { readonly citation: Citation; readonly label: string };
export type CitationResult = { status: "verified-captured"; evidence: VerifiedCitation } |
  { status: "invalid"; reason: "shape" | "source" | "revision" | "range" | "quote" };

function chapterLabel(source: ChapterSource, first: number, last: number): string {
  return `${source.bookTitle} · Chapter ${source.position}: ${source.title} · lines ${first}–${last} · saved version ${source.identity.version}, captured ${source.capturedAt}`;
}

/** Validity is against captured text only. A matching quote does not prove the interpretation. */
export function verifyReviewCitation(envelope: ReviewEnvelope, input: unknown): CitationResult {
  try { reviewDisclosure(envelope); } catch { return { status: "invalid", reason: "source" }; }
  if (!isReviewData(input)) return { status: "invalid", reason: "shape" };
  const parsed = citationSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", reason: "shape" };
  const citation = parsed.data;
  const matches = envelope.sources.filter((source) => source.sourceId === citation.sourceId);
  const source = matches[0];
  if (matches.length !== 1 || !source || source.kind !== citation.kind) return { status: "invalid", reason: "source" };
  if (source.kind === "chapter" && citation.kind === "chapter") {
    if (!sameSavedIdentity(source.identity, citation.identity)) return { status: "invalid", reason: "revision" };
    const segment = source.segments.find((item) => citation.start >= item.start && citation.end <= item.end);
    const start = citation.start - (segment?.start ?? 0);
    const end = citation.end - (segment?.start ?? 0);
    if (!segment || !validSpan(segment.text, { start, end })) return { status: "invalid", reason: "range" };
    if (segment.text.slice(start, end) !== citation.quote) return { status: "invalid", reason: "quote" };
    const first = segment.startLine + segment.text.slice(0, start).split("\n").length - 1;
    const last = segment.startLine + segment.text.slice(0, end - 1).split("\n").length - 1;
    return { status: "verified-captured", evidence: freeze({ citation, label: chapterLabel(source, first, last) }) };
  }
  if (source.kind === "story-bible" && citation.kind === "story-bible") {
    if (source.bookId !== citation.bookId || source.valueDigest !== citation.valueDigest ||
      source.containingFileHash !== citation.containingFileHash || canonicalJson(source.field) !== canonicalJson(citation.field)) {
      return { status: "invalid", reason: "revision" };
    }
    if (!validSpan(source.text, citation)) return { status: "invalid", reason: "range" };
    if (source.text.slice(citation.start, citation.end) !== citation.quote) return { status: "invalid", reason: "quote" };
    return { status: "verified-captured", evidence: freeze({ citation,
      label: `${source.bookTitle} · Story Bible · ${source.label} · captured ${source.capturedAt}` }) };
  }
  return { status: "invalid", reason: "source" };
}

export type ReaderFinding = Immutable<{
  findingId: string; category: z.infer<typeof findingsOutputSchema>["findings"][number]["category"];
  readerId: string; readerVersion: number; runId: string; interpretation: string; subjective: true;
  claim: "observation" | "question" | "contradiction";
  evidence: VerifiedCitation[]; invalidEvidence: { index: number; reason: string }[];
  evidenceState: "complete" | "incomplete-evidence" | "insufficient-evidence";
}>;
export type ReaderRun = Immutable<{
  kind: "reader-review"; runId: string; startedAt: string; completedAt: string;
  envelope: ReviewEnvelope; findings: ReaderFinding[];
}>;

export type ReaderOutput = Immutable<z.infer<typeof findingsOutputSchema>>;

/**
 * The one provider-output parser. It rejects non-strings and the exact UTF-8 byte bound before
 * allocating an encoding, parses JSON once, then applies the strict findings schema once. No trim,
 * fence stripping, first-object extraction, repair or trailing prose is accepted.
 */
export function parseReaderOutput(output: unknown): ReaderOutput {
  if (typeof output !== "string") throw new ReviewContractError("output-malformed");
  // UTF-8 bytes are never fewer than UTF-16 code units, so this conservative guard cannot admit
  // a string that the exact byte check would reject.
  if (output.length > REVIEW_LIMITS.outputBytes) throw new ReviewContractError("output-byte-limit");
  checkBytes(output, REVIEW_LIMITS.outputBytes, "output-byte-limit");
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new ReviewContractError("output-malformed"); }
  const result = findingsOutputSchema.safeParse(parsed);
  if (!result.success) throw new ReviewContractError("output-malformed");
  return freeze(result.data);
}

export async function buildReaderRun(input: {
  runId: string; startedAt: string; completedAt: string; envelope: ReviewEnvelope; output: string;
}): Promise<ReaderRun> {
  assertReviewData(input);
  const runId = idSchema.parse(input.runId);
  const startedAt = timestampSchema.parse(input.startedAt);
  const completedAt = timestampSchema.parse(input.completedAt);
  requireContract(Date.parse(completedAt) >= Date.parse(startedAt), "run-time-order");
  const output = parseReaderOutput(input.output);
  const envelope = await validateReviewEnvelope(input.envelope);
  const profile = envelope.profile;
  requireContract(envelope.kind === "reader-review" && profile, "reader-profile-required");
  requireContract(runId === envelope.requestId, "run-request-identity");
  requireContract(output.runId === runId && output.readerId === profile.id && output.readerVersion === profile.version, "run-attribution");
  requireContract(new Set(output.findings.map((finding) => finding.findingId)).size === output.findings.length, "ambiguous-finding-id");
  const findings = output.findings.map((finding): ReaderFinding => {
    requireContract(finding.runId === runId && finding.readerId === profile.id && finding.readerVersion === profile.version, "finding-attribution");
    requireContract(finding.claim !== "contradiction" || finding.category === "continuity", "contradiction-category");
    const evidence: VerifiedCitation[] = [];
    const invalidEvidence: { index: number; reason: string }[] = [];
    finding.evidence.forEach((raw, index) => {
      // Resource overflow fails the run even when the remainder of a citation is malformed.
       if (raw && typeof raw === "object" && "quote" in raw && typeof raw.quote === "string") {
         let scalars = 0;
         for (const scalar of raw.quote) {
           const code = scalar.codePointAt(0) ?? 0;
           if (code < 0xd800 || code > 0xdfff) scalars++;
           requireContract(scalars <= REVIEW_LIMITS.quoteScalars, "quote-scalar-limit");
         }
       }
      const result = verifyReviewCitation(envelope, raw);
      if (result.status === "verified-captured") evidence.push(result.evidence);
      else invalidEvidence.push({ index, reason: result.reason });
    });
    const distinctEvidence = new Set(evidence.map((item) => canonicalJson(item.citation))).size;
    const insufficient = evidence.length === 0 || (finding.claim === "contradiction" && distinctEvidence < 2);
    return freeze({ ...finding, subjective: true, evidence, invalidEvidence,
      evidenceState: insufficient ? "insufficient-evidence" : invalidEvidence.length ? "incomplete-evidence" : "complete" });
  });
  return freeze({ kind: "reader-review", runId, startedAt, completedAt, envelope, findings });
}

/** Fresh saved sources for one disclosed envelope; a read-only comparison, never a provider call. */
export function readerCurrentSources(envelopeInput: ReviewEnvelope, detailInput: unknown, capturedAt: string): readonly CurrentSource[] {
  let sources: readonly ReviewSource[];
  try { sources = reviewDisclosure(envelopeInput).sources; } catch { return []; }
  const allMissing = () => freeze(sources.map((source) => ({ sourceId: source.sourceId, status: "missing" as const })));
  if (detailInput === null || typeof detailInput !== "object" || !isReviewData(detailInput)) return allMissing();
  const detail = detailInput as BookDetail;
  if (!detail.book || typeof detail.book !== "object" || typeof detail.book.id !== "string" || !Array.isArray(detail.chapters)) {
    return allMissing();
  }
  const stamp = timestampSchema.safeParse(capturedAt).success ? capturedAt : envelopeInput.capturedAt;
  const chapters = detail.chapters.filter((chapter): chapter is BookDetail["chapters"][number] =>
    chapter !== null && typeof chapter === "object" && typeof chapter.id === "string");
  const current: CurrentSource[] = [];
  for (const source of sources) {
    const sourceId = source.sourceId;
    if (source.kind !== "chapter") { current.push({ sourceId, status: "missing" }); continue; }
    if (source.identity.bookId !== detail.book.id) { current.push({ sourceId, status: "missing" }); continue; }
    const matches = chapters.filter((chapter) => chapter.id === source.identity.chapterId);
    if (matches.length === 0) { current.push({ sourceId, status: "missing" }); continue; }
    if (matches.length > 1) { current.push({ sourceId, status: "ambiguous" }); continue; }
    const chapter = matches[0];
    if (!chapter) { current.push({ sourceId, status: "missing" }); continue; }
    if (chapter.version !== source.identity.version || chapter.hash !== source.identity.hash) {
      current.push({ sourceId, status: "stale" }); continue;
    }
    try {
      const recaptured = captureChapterSource({
        sourceId,
        saved: {
          bookId: source.identity.bookId, chapterId: source.identity.chapterId,
          version: chapter.version, hash: chapter.hash, body: chapter.content
        },
        bookTitle: detail.book.title, title: chapter.title, position: chapter.order,
        capturedAt: stamp, ranges: source.segments.map(({ start, end }) => ({ start, end }))
      });
      // Capture time and the request-local alias are excluded; body/title/order changes are not.
      current.push(sourceComparisonKey(recaptured) === sourceComparisonKey(source)
        ? { sourceId, status: "available", source: recaptured }
        : { sourceId, status: "stale" });
    } catch {
      current.push({ sourceId, status: "stale" });
    }
  }
  return freeze(current);
}

export type ReaderSourceStatus = "current" | "stale" | "unavailable";
export type ReaderSourceSummary = Immutable<{
  status: ReaderSourceStatus; current: number; stale: number; unavailable: number; total: number;
}>;

/** Counts one envelope's sources against a checked current-source list. No implicit read. */
export function readerSourceState(envelopeInput: ReviewEnvelope, current: readonly CurrentSource[]): ReaderSourceSummary {
  let sources: readonly ReviewSource[];
  try { sources = reviewDisclosure(envelopeInput).sources; } catch {
    return freeze({ status: "unavailable", current: 0, stale: 0, unavailable: 0, total: 0 });
  }
  let currentCount = 0;
  let staleCount = 0;
  let unavailableCount = 0;
  for (const source of sources) {
    const currency = sourceCurrency(source, current);
    if (currency === "current") currentCount++;
    else if (currency === "stale") staleCount++;
    else unavailableCount++;
  }
  const total = sources.length;
  const status: ReaderSourceStatus = staleCount > 0 ? "stale"
    : unavailableCount > 0 || total === 0 ? "unavailable" : "current";
  return freeze({ status, current: currentCount, stale: staleCount, unavailable: unavailableCount, total });
}

/** Why a historical citation cannot currently navigate; the quote is retained either way. */
export type CitationNavigationReason =
  | "shape" | "source" | "revision" | "range" | "quote" | "kind" | "missing" | "ambiguous" | "stale" | "editor";
export type CitationNavigation = {
  readonly status: "ready" | "stale" | "unavailable";
  readonly reason?: CitationNavigationReason;
  readonly evidence?: VerifiedCitation;
};

/** Recheck immediately before displaying current evidence and again before editor selection. */
export function reviewCitationNavigation(envelope: ReviewEnvelope, citation: unknown, current: readonly CurrentSource[], editor?: {
  clean: boolean; identity: SavedIdentity;
}): CitationNavigation {
  const result = verifyReviewCitation(envelope, citation);
  if (result.status !== "verified-captured") return { status: "unavailable", reason: result.reason };
  const source = envelope.sources.find((item) => item.sourceId === result.evidence.citation.sourceId);
  if (!source) return { status: "unavailable", reason: "source" };
  // The source kind is checked before currency: a Story Bible citation never becomes a chapter link.
  if (source.kind !== "chapter") return { status: "unavailable", reason: "kind", evidence: result.evidence };
  const currency = sourceCurrency(source, current);
  if (currency === "stale") return { status: "stale", reason: "stale", evidence: result.evidence };
  if (currency !== "current") {
    const matches = current.filter((entry) => entry.sourceId === source.sourceId);
    const reason: CitationNavigationReason =
      matches.length === 0 ? "missing"
        : matches.length > 1 ? "ambiguous"
          : matches[0]?.status === "ambiguous" ? "ambiguous"
            : matches[0]?.status === "missing" ? "missing" : "source";
    return { status: "unavailable", reason, evidence: result.evidence };
  }
  const destination = isReviewData(editor) ? savedEditorSchema.safeParse(editor) : null;
  if (editor !== undefined && (!destination?.success || destination.data.clean !== true ||
      !sameSavedIdentity(source.identity, destination.data.identity))) {
    return { status: "stale", reason: "editor", evidence: result.evidence };
  }
  return { status: "ready", evidence: result.evidence };
}

export type ReaderRunFacet = "sources" | "profile" | "destination" | "request";
export type ReaderRerunKind =
  | "identical-input"
  | "changed-source"
  | "changed-profile"
  | "changed-destination"
  | "changed-request"
  | "multiple-changes"
  | "not-comparable";
export type ReaderCategory = z.infer<typeof categorySchema>;

export interface ReaderSourceChange {
  readonly kind: "added" | "removed" | "revision" | "content" | "selection" | "label";
  /** Display label only; never a source id, hash or capture time. */
  readonly label: string;
  readonly fromVersion: number | null;
  readonly toVersion: number | null;
  readonly hashChanged: boolean;
}
export interface ReaderProfileComparison {
  readonly changed: boolean;
  readonly sameId: boolean;
  readonly versionChanged: boolean;
  readonly digestChanged: boolean;
  readonly from: { readonly id: string; readonly origin: "builtin" | "author"; readonly version: number; readonly name: string };
  readonly to: { readonly id: string; readonly origin: "builtin" | "author"; readonly version: number; readonly name: string };
}
export interface ReaderDestinationComparison {
  readonly changed: boolean;
  readonly connectionChanged: boolean;
  readonly providerChanged: boolean;
  readonly modelChanged: boolean;
  readonly endpointChanged: boolean;
}
export interface ReaderRequestComparison {
  readonly changed: boolean;
  readonly promptChanged: boolean;
  readonly priorFeedbackChanged: boolean;
  readonly bookPolicyChanged: boolean;
  readonly scopeCountsChanged: boolean;
  readonly before: ReviewResourceUsage;
  readonly after: ReviewResourceUsage;
}
export interface ReaderFindingCounts {
  readonly total: number;
  readonly observations: number;
  readonly questions: number;
  readonly contradictions: number;
  readonly byCategory: Readonly<Record<ReaderCategory, number>>;
  readonly verifiedEvidence: number;
  readonly withheldEvidence: number;
  readonly insufficientFindings: number;
  readonly incompleteEvidenceFindings: number;
}
export type ReaderRerunComparison =
  | { readonly status: "not-comparable"; readonly reason: "invalid-run" | "invalid-envelope" | "invalid-profile" }
  | {
      readonly status: "comparable";
      readonly kind: Exclude<ReaderRerunKind, "not-comparable">;
      readonly changedFacets: readonly ReaderRunFacet[];
      readonly sourceChanged: boolean;
      readonly profileChanged: boolean;
      readonly destinationChanged: boolean;
      readonly promptOrFeedbackChanged: boolean;
      readonly interpretationChanged: boolean;
      readonly evidenceChanged: boolean;
      readonly modelVariation: boolean;
      readonly partial: boolean;
      readonly sources: readonly ReaderSourceChange[];
      readonly profile: ReaderProfileComparison;
      readonly destination: ReaderDestinationComparison;
      readonly request: ReaderRequestComparison;
      readonly before: ReaderFindingCounts;
      readonly after: ReaderFindingCounts;
    };

function readerCategoryCounts(): Record<ReaderCategory, number> {
  return { "reader-impression": 0, clarity: 0, pacing: 0, "character-motivation": 0, continuity: 0 };
}

function findingCounts(run: ReaderRun): ReaderFindingCounts {
  const byCategory = readerCategoryCounts();
  let observations = 0, questions = 0, contradictions = 0, verified = 0, withheld = 0, insufficient = 0, incomplete = 0;
  for (const finding of run.findings) {
    if (Object.hasOwn(byCategory, finding.category)) {
      byCategory[finding.category as ReaderCategory] += 1;
    }
    if (finding.claim === "observation") observations += 1;
    else if (finding.claim === "question") questions += 1;
    else if (finding.claim === "contradiction") contradictions += 1;
    verified += finding.evidence.length;
    withheld += finding.invalidEvidence.length;
    if (finding.evidenceState === "insufficient-evidence") insufficient += 1;
    else if (finding.evidenceState === "incomplete-evidence") incomplete += 1;
  }
  return freeze({
    total: run.findings.length, observations, questions, contradictions, byCategory: freeze(byCategory),
    verifiedEvidence: verified, withheldEvidence: withheld,
    insufficientFindings: insufficient, incompleteEvidenceFindings: incomplete
  });
}

function sortedCanonical(values: readonly string[]): string {
  return canonicalJson([...values].sort());
}

function interpretationKey(run: ReaderRun): string {
  return sortedCanonical(run.findings.map((finding) =>
    canonicalJson({ category: finding.category, claim: finding.claim, interpretation: finding.interpretation })));
}

function evidenceKey(citation: Citation): string {
  return canonicalJson(citation.kind === "chapter"
    ? { kind: citation.kind, bookId: citation.identity.bookId, chapterId: citation.identity.chapterId,
        start: citation.start, end: citation.end, quote: citation.quote }
    : { kind: citation.kind, bookId: citation.bookId, field: citation.field,
        start: citation.start, end: citation.end, quote: citation.quote });
}

function evidenceKeySet(run: ReaderRun): string {
  return sortedCanonical(run.findings.flatMap((finding) => finding.evidence.map((entry) => evidenceKey(entry.citation))));
}

/** Stable identity of a source, ignoring request-local ids and capture time. */
export function sourceChangeKey(source: ReviewSource): string {
  return source.kind === "chapter"
    ? `chapter:${source.identity.bookId}:${source.identity.chapterId}`
    : `story-bible:${source.bookId}:${canonicalJson(source.field)}`;
}

function sourceLabel(source: ReviewSource): string {
  return source.kind === "chapter"
    ? `${source.bookTitle} · Chapter ${source.position}: ${source.title}`
    : `${source.bookTitle} · Story Bible · ${source.label}`;
}

function sourceChanges(before: readonly ReviewSource[], after: readonly ReviewSource[]): ReaderSourceChange[] {
  const beforeByKey = new Map(before.map((source) => [sourceChangeKey(source), source]));
  const afterByKey = new Map(after.map((source) => [sourceChangeKey(source), source]));
  const changes: ReaderSourceChange[] = [];
  for (const [key, source] of beforeByKey) {
    const next = afterByKey.get(key);
    if (!next) {
      changes.push({ kind: "removed", label: sourceLabel(source),
        fromVersion: source.kind === "chapter" ? source.identity.version : null, toVersion: null, hashChanged: false });
    } else if (source.kind === "chapter" && next.kind === "chapter") {
      const label = sourceLabel(next);
      if (source.identity.version !== next.identity.version) {
        changes.push({ kind: "revision", label, fromVersion: source.identity.version, toVersion: next.identity.version,
          hashChanged: source.identity.hash !== next.identity.hash });
      } else if (source.identity.hash !== next.identity.hash) {
        changes.push({ kind: "content", label, fromVersion: next.identity.version, toVersion: next.identity.version, hashChanged: true });
      } else if (canonicalJson(source.segments) !== canonicalJson(next.segments)) {
        changes.push({ kind: "selection", label, fromVersion: next.identity.version, toVersion: next.identity.version, hashChanged: false });
      } else if (source.bookTitle !== next.bookTitle || source.title !== next.title || source.position !== next.position) {
        changes.push({ kind: "label", label, fromVersion: next.identity.version, toVersion: next.identity.version, hashChanged: false });
      }
    } else if (source.kind === "story-bible" && next.kind === "story-bible") {
      const label = sourceLabel(next);
      if (source.valueDigest !== next.valueDigest || source.containingFileHash !== next.containingFileHash || source.text !== next.text) {
        changes.push({ kind: "content", label, fromVersion: null, toVersion: null,
          hashChanged: source.valueDigest !== next.valueDigest || source.containingFileHash !== next.containingFileHash });
      } else if (source.bookTitle !== next.bookTitle || source.label !== next.label) {
        changes.push({ kind: "label", label, fromVersion: null, toVersion: null, hashChanged: false });
      }
    }
  }
  for (const [key, source] of afterByKey) {
    if (!beforeByKey.has(key)) {
      changes.push({ kind: "added", label: sourceLabel(source),
        fromVersion: null, toVersion: source.kind === "chapter" ? source.identity.version : null, hashChanged: false });
    }
  }
  return changes;
}

function profileComparison(before: ReaderRun, after: ReaderRun): ReaderProfileComparison {
  const from = before.envelope.profile;
  const to = after.envelope.profile;
  const shape = (profile: NonNullable<ReaderRun["envelope"]["profile"]>) =>
    ({ id: profile.id, origin: profile.origin, version: profile.version, name: profile.name });
  const changed = canonicalJson(from) !== canonicalJson(to);
  return freeze({
    changed, sameId: from?.id === to?.id, versionChanged: from?.version !== to?.version,
    digestChanged: from?.digest !== to?.digest,
    from: from ? freeze(shape(from)) : freeze({ id: "unknown", origin: "builtin", version: 0, name: "Unknown profile" }),
    to: to ? freeze(shape(to)) : freeze({ id: "unknown", origin: "builtin", version: 0, name: "Unknown profile" })
  });
}

function requestComparison(before: ReaderRun, after: ReaderRun): ReaderRequestComparison {
  const promptChanged = before.envelope.prompt !== after.envelope.prompt;
  const priorFeedbackChanged = canonicalJson(before.envelope.priorFeedback) !== canonicalJson(after.envelope.priorFeedback);
  const policy = (books: ReviewEnvelope["books"]) => books.map((book) => ({
    bookId: book.bookId, consentSatisfied: book.consentSatisfied, consentRevision: book.consentRevision,
    termsRevision: book.termsRevision, enabledTools: book.enabledTools
  }));
  const bookPolicyChanged = canonicalJson(policy(before.envelope.books)) !== canonicalJson(policy(after.envelope.books));
  const beforeUsage = reviewResourceUsage(before.envelope);
  const afterUsage = reviewResourceUsage(after.envelope);
  const scopeCounts = (usage: ReviewResourceUsage) =>
    ({ books: usage.books, items: usage.items, sourceBytes: usage.sourceBytes, combinedBytes: usage.combinedBytes, requestBytes: usage.requestBytes });
  const scopeCountsChanged = canonicalJson(scopeCounts(beforeUsage)) !== canonicalJson(scopeCounts(afterUsage));
  return freeze({
    changed: promptChanged || priorFeedbackChanged || bookPolicyChanged,
    promptChanged, priorFeedbackChanged, bookPolicyChanged, scopeCountsChanged,
    before: beforeUsage, after: afterUsage
  });
}

function validateRun(run: ReaderRun): "invalid-run" | "invalid-envelope" | "invalid-profile" | null {
  if (!isReviewData(run)) return "invalid-run";
  if (run.kind !== "reader-review") return "invalid-run";
  let envelope: ReviewEnvelope;
  try { envelope = reviewDisclosure(run.envelope); } catch { return "invalid-envelope"; }
  if (envelope.kind !== "reader-review") return "invalid-envelope";
  if (!envelope.profile) return "invalid-profile";
  if (run.runId !== envelope.requestId) return "invalid-run";
  if (!Array.isArray(run.findings)) return "invalid-run";
  for (const finding of run.findings) {
    if (!isReviewData(finding)) return "invalid-run";
    if (!Array.isArray(finding.evidence) || !Array.isArray(finding.invalidEvidence)) return "invalid-run";
  }
  return null;
}

/**
 * Descriptive comparison of the latest two completed runs: which input facts changed and how the
 * returned findings differ. It never reports improvement, causation, coverage or quality. A
 * validation failure returns `not-comparable` with no counts.
 */
export function compareReaderRuns(before: ReaderRun, after: ReaderRun): ReaderRerunComparison {
  const invalid = validateRun(before) ?? validateRun(after);
  if (invalid) return freeze({ status: "not-comparable", reason: invalid });
  const sourceChangesFound = sourceChanges(before.envelope.sources, after.envelope.sources);
  const sourceChanged = sourceChangesFound.length > 0;
  const profile = profileComparison(before, after);
  const destinationBefore = before.envelope.destination;
  const destinationAfter = after.envelope.destination;
  const destination: ReaderDestinationComparison = freeze({
    connectionChanged: destinationBefore.connectionId !== destinationAfter.connectionId,
    providerChanged: destinationBefore.provider !== destinationAfter.provider,
    modelChanged: destinationBefore.model !== destinationAfter.model,
    endpointChanged: destinationBefore.endpointIdentity !== destinationAfter.endpointIdentity,
    changed: false
  });
  const destinationChanged = destination.connectionChanged || destination.providerChanged || destination.modelChanged || destination.endpointChanged;
  const destinationFinal = freeze({ ...destination, changed: destinationChanged });
  const request = requestComparison(before, after);
  const changedFacets: ReaderRunFacet[] = [];
  if (sourceChanged) changedFacets.push("sources");
  if (profile.changed) changedFacets.push("profile");
  if (destinationChanged) changedFacets.push("destination");
  if (request.changed) changedFacets.push("request");
  const kind: Exclude<ReaderRerunKind, "not-comparable"> =
    changedFacets.length === 0 ? "identical-input"
      : changedFacets.length > 1 ? "multiple-changes"
        : changedFacets[0] === "sources" ? "changed-source"
          : changedFacets[0] === "profile" ? "changed-profile"
            : changedFacets[0] === "destination" ? "changed-destination" : "changed-request";
  const interpretationChanged = interpretationKey(before) !== interpretationKey(after);
  const evidenceChanged = evidenceKeySet(before) !== evidenceKeySet(after);
  const promptOrFeedbackChanged = request.promptChanged || request.priorFeedbackChanged;
  const beforeCounts = findingCounts(before);
  const afterCounts = findingCounts(after);
  const partial = [...before.findings, ...after.findings].some((finding) =>
    finding.invalidEvidence.length > 0 || finding.evidenceState !== "complete");
  return freeze({
    status: "comparable",
    kind,
    changedFacets: freeze(changedFacets),
    sourceChanged,
    profileChanged: profile.changed,
    destinationChanged,
    promptOrFeedbackChanged,
    interpretationChanged,
    evidenceChanged,
    modelVariation: changedFacets.length === 0 && (interpretationChanged || evidenceChanged),
    partial,
    sources: freeze(sourceChangesFound),
    profile,
    destination: destinationFinal,
    request,
    before: beforeCounts,
    after: afterCounts
  });
}
