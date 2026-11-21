import type { z } from "zod";
import type { BookDetail } from "../schema";
import {
  assertReviewData, canonicalJson, checkBytes, freeze, idSchema, isReviewData, requireContract, ReviewContractError,
  REVIEW_LIMITS, timestampSchema, validSpan, type Immutable
} from "./contract";
import {
  reviewDisclosure, sourceComparisonKey, sourceCurrency, validateReviewEnvelope, type CurrentSource, type ReviewEnvelope
} from "./envelope";
import { captureChapterSource, sameSavedIdentity, savedEditorSchema, type ChapterSource, type ReviewSource, type SavedIdentity } from "./sources";
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

export function compareReaderRuns(before: ReaderRun, after: ReaderRun) {
  const sourceChanged = canonicalJson(before.envelope.sources.map(sourceComparisonKey)) !== canonicalJson(after.envelope.sources.map(sourceComparisonKey));
  const profileChanged = canonicalJson(before.envelope.profile) !== canonicalJson(after.envelope.profile);
  const destinationChanged = canonicalJson(before.envelope.destination) !== canonicalJson(after.envelope.destination);
  const promptOrFeedbackChanged = canonicalJson([before.envelope.prompt, before.envelope.priorFeedback]) !== canonicalJson([after.envelope.prompt, after.envelope.priorFeedback]);
  const interpretations = (run: ReaderRun) => run.findings.map((finding) => ({ category: finding.category, claim: finding.claim,
    interpretation: finding.interpretation }));
  const interpretationChanged = canonicalJson(interpretations(before)) !== canonicalJson(interpretations(after));
  return freeze({ sourceChanged, profileChanged, destinationChanged, promptOrFeedbackChanged, interpretationChanged,
    modelVariation: interpretationChanged && !sourceChanged && !profileChanged && !destinationChanged && !promptOrFeedbackChanged });
}
