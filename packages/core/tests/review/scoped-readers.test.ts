import { describe, expect, test } from "bun:test";
import { ReviewContractError, REVIEW_LIMITS, utf8Bytes } from "../../src/review/contract";
import { buildReviewEnvelope, checkReviewStart, reviewResourceUsage, sourceCurrency, type EnvelopeInput, type ReviewEnvelope } from "../../src/review/envelope";
import { buildReaderRun, compareReaderRuns, parseReaderOutput, readerCurrentSources, readerSourceState, reviewCitationNavigation, verifyReviewCitation } from "../../src/review/findings";
import { builtinReaderProfile, editReaderProfile, validateReaderProfile, type ProfileContent } from "../../src/review/profiles";
import { captureBibleSource, captureChapterSource } from "../../src/review/sources";
import type { BookDetail } from "../../src/schema";
import { citation, currentFacts, currentSources, hash, input, item, saved, selectedEnd, selectedStart, source, stamp } from "./scoped-fixtures";

const content: ProfileContent = { name: "Same name", purpose: "A fictional editorial lens", focus: ["clarity"], guidance: "Be concise." };
async function readerEnvelope(overrides: Partial<EnvelopeInput> = {}) {
  return buildReviewEnvelope({ ...input(), kind: "reader-review", profile: await builtinReaderProfile("alpha"), ...overrides });
}
function finding(value: ReviewEnvelope, overrides: Record<string, unknown> = {}) {
  return { findingId: "finding-1", category: "clarity", readerId: value.profile?.id, readerVersion: value.profile?.version,
    runId: value.requestId, interpretation: "This passage seems clear to this fictional lens.", claim: "observation", evidence: [citation()], ...overrides };
}
function output(value: ReviewEnvelope, findings = [finding(value)]) {
  return { runId: value.requestId, readerId: value.profile?.id, readerVersion: value.profile?.version, findings };
}
function run(value: ReviewEnvelope, result: unknown = output(value)) {
  return buildReaderRun({ runId: value.requestId, startedAt: stamp, completedAt: stamp, envelope: value,
    output: typeof result === "string" ? result : JSON.stringify(result) });
}

describe("versioned fictional reader attribution", () => {
  test("built-in lenses are fixed; editing forks identity then increments author lineage", async () => {
    const alpha = await builtinReaderProfile("alpha");
    const beta = await builtinReaderProfile("beta");
    expect(alpha.name).toBe("Alpha reader"); expect(beta.name).toBe("Beta reader");
    expect(alpha.id).not.toBe(beta.id);
    expect(alpha.purpose).toContain("fictional");
    const fork = await editReaderProfile(alpha, content, "author-1");
    const next = await editReaderProfile(fork, { ...content, guidance: "Changed." });
    expect(fork).toMatchObject({ id: "author-1", version: 1, origin: "author" });
    expect(next).toMatchObject({ id: "author-1", version: 2 });
    expect(next.digest).not.toBe(fork.digest);
    expect(fork.guidance).toBe(content.guidance);
    expect(Object.isFrozen(fork.focus)).toBe(true);
    await expect(editReaderProfile(alpha, content)).rejects.toThrow();
    await expect(editReaderProfile(alpha, content, "reader-alpha")).rejects.toThrow();
    await expect(editReaderProfile(fork, content, "other-lineage")).rejects.toThrow();
    await expect(validateReaderProfile({ ...alpha, version: 2 })).rejects.toThrow();
    await expect(validateReaderProfile({ ...alpha, guidance: "Edit the book" })).rejects.toThrow();
    await expect(editReaderProfile(alpha, { ...content, tools: ["overwrite_chapter"] } as ProfileContent, "author-2")).rejects.toThrow();
  });
  test("same names are not identity; current profile change invalidates disclosure", async () => {
    const alpha = await builtinReaderProfile("alpha");
    const one = await editReaderProfile(alpha, content, "author-1");
    const two = await editReaderProfile(alpha, content, "author-2");
    expect(one.name).toBe(two.name); expect(one.id).not.toBe(two.id);
    const value = await readerEnvelope({ profile: structuredClone(one) });
    const facts = currentFacts(value); facts.profile = structuredClone(two);
    expect(await checkReviewStart(value, { kind: "start", requestId: value.requestId, scopeDigest: value.scopeDigest }, facts, currentSources(value))).toContain("profile-changed");
  });
  test("guidance scalar bound accepts 2000 astral characters, refuses 2001 and unpaired surrogates", async () => {
    const alpha = await builtinReaderProfile("alpha");
    await expect(editReaderProfile(alpha, { ...content, guidance: "😀".repeat(2_000) }, "author-1")).resolves.toBeDefined();
    await expect(editReaderProfile(alpha, { ...content, guidance: "😀".repeat(2_001) }, "author-1")).rejects.toThrow();
    await expect(editReaderProfile(alpha, { ...content, guidance: "\ud800" }, "author-1")).rejects.toThrow();
    const author = await editReaderProfile(alpha, content, "author-1");
    const max = await validateReaderProfile({ ...author, version: Number.MAX_SAFE_INTEGER });
    await expect(editReaderProfile(max, content)).rejects.toThrow();
    await expect(validateReaderProfile({ ...author, version: 0 })).rejects.toThrow();
  });
  test("profile content counts in the shared 131072 byte bound", async () => {
    const profile = await builtinReaderProfile("alpha");
    const bytes = utf8Bytes(profile.name + profile.purpose + profile.guidance + profile.focus.join(""));
    const request = { profile: structuredClone(profile), sources: [structuredClone(source("x", 0, 1))], prompt: "a".repeat(REVIEW_LIMITS.contentBytes - bytes - 1) };
    await expect(readerEnvelope(request)).resolves.toBeDefined();
    await expect(readerEnvelope({ ...request, prompt: `${request.prompt}a` })).rejects.toThrow("content-byte-limit");
  });
});

describe("hostile structured findings and exact citations", () => {
  test("only valid evidence is navigable, errors counted, interpretation always subjective", async () => {
    const value = await readerEnvelope();
    const report = await run(value, output(value, [finding(value, { evidence: [citation(), { ...citation(), quote: "invented" }, { ...citation(), verified: true }, null] })]));
    const result = item(report.findings);
    expect(result.subjective).toBe(true);
    expect(result.evidenceState).toBe("incomplete-evidence");
    expect(result.evidence).toHaveLength(1); expect(result.invalidEvidence).toHaveLength(3);
    expect(item(result.evidence).label).toContain("Synthetic book · Chapter 1: Synthetic chapter · lines 2–2 · saved version 3");
    expect(item(result.evidence).label).not.toContain(hash);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(report.envelope.profile).toEqual(value.profile);
    expect(verifyReviewCitation(value, { ...citation(), quote: "\ud800" })).toEqual({ status: "invalid", reason: "shape" });
  });
  test("wrong/ambiguous source, revision and range are refused; gaps never become evidence", async () => {
    const value = await readerEnvelope();
    for (const invalid of [
      { ...citation(), sourceId: "absent" },
      { ...citation(), identity: { ...citation().identity, version: 4 } },
      { ...citation(), identity: { ...citation().identity, bookId: "book_654321" } },
      { ...citation(), identity: { ...citation().identity, chapterId: "ch_654321" } },
      { ...citation(), identity: { ...citation().identity, hash: "b".repeat(64) } },
      { ...citation(), start: selectedStart - 1, quote: saved.body.slice(selectedStart - 1, selectedEnd) },
      { ...citation(), end: selectedEnd + 1, quote: `${citation().quote}\n` },
      { ...citation(), start: 0.5 }, { ...citation(), start: selectedEnd },
      { ...citation(), end: Number.MAX_SAFE_INTEGER }, { ...citation(), current: true }
    ]) expect(verifyReviewCitation(value, invalid).status).toBe("invalid");
    const ambiguous = { ...value, sources: [...value.sources, ...value.sources] };
    expect(verifyReviewCitation(ambiguous, citation()).status).toBe("invalid");
  });
  test("continuity contradictions require two distinct valid references", async () => {
    const value = await readerEnvelope();
    const contradicted = (evidence: unknown[]) => output(value, [finding(value, { category: "continuity", claim: "contradiction", evidence })]);
    expect(item((await run(value, contradicted([citation(), citation()]))).findings).evidenceState).toBe("insufficient-evidence");
    const smaller = { ...citation(), end: selectedStart + 8, quote: "Selected" };
    expect(item((await run(value, contradicted([citation(), smaller]))).findings).evidenceState).toBe("complete");
    expect(item((await run(value, contradicted([citation(), { ...smaller, quote: "wrong" }]))).findings).evidenceState).toBe("insufficient-evidence");
  });
  test("malformed top-level output, self-certified flags and wrong reader/run fail the run", async () => {
    const value = await readerEnvelope();
    for (const malformed of ["not JSON", "null", [], { ...output(value), verified: true },
      { ...output(value), readerId: "wrong" }, { ...output(value), readerVersion: 2 }, { ...output(value), runId: "old-run" },
      output(value, [finding(value, { readerId: "wrong" })]), output(value, [finding(value, { runId: "old-run" })]),
      output(value, [finding(value, { readerVersion: 2 })]), output(value, [finding(value, { subjective: false })]),
      output(value, [finding(value), finding(value)])]) await expect(run(value, malformed)).rejects.toThrow();
    await expect(buildReaderRun({ runId: "different", startedAt: stamp, completedAt: stamp, envelope: value, output: JSON.stringify(output(value)) })).rejects.toThrow("run-request-identity");
  });
  test("output bytes accept exactly 262144, including whitespace, and reject one more", async () => {
    const value = await readerEnvelope();
    const json = JSON.stringify(output(value, []));
    const exact = json + " ".repeat(REVIEW_LIMITS.outputBytes - utf8Bytes(json));
    await expect(run(value, exact)).resolves.toBeDefined();
    await expect(run(value, `${exact} `)).rejects.toThrow("output-byte-limit");
  });
  test("50 findings, 2000 interpretation scalars and 8 evidence items are exact upper bounds", async () => {
    const value = await readerEnvelope();
    const findings = Array.from({ length: 50 }, (_, i) => finding(value, { findingId: `f-${i}`, evidence: [] }));
    expect((await run(value, output(value, findings))).findings).toHaveLength(50);
    await expect(run(value, output(value, [...findings, finding(value, { findingId: "f-extra" })]))).rejects.toThrow();
    await expect(run(value, output(value, [finding(value, { interpretation: "😀".repeat(2_000) })]))).resolves.toBeDefined();
    await expect(run(value, output(value, [finding(value, { interpretation: "😀".repeat(2_001) })]))).rejects.toThrow();
    await expect(run(value, output(value, [finding(value, { interpretation: "\ud800" })]))).rejects.toThrow();
    expect(item((await run(value, output(value, [finding(value, { evidence: Array(8).fill(citation()) })]))).findings).evidence).toHaveLength(8);
    await expect(run(value, output(value, [finding(value, { evidence: Array(9).fill(citation()) })]))).rejects.toThrow();
  });
  test("500 quote scalars valid; 501 fails without truncation, even in malformed evidence", async () => {
    const text = "😀".repeat(501);
    const value = await readerEnvelope({ sources: [structuredClone(source(text, 0, text.length))] });
    const exact = { ...citation(), start: 0, end: 1_000, quote: "😀".repeat(500) };
    expect(verifyReviewCitation(value, exact).status).toBe("verified-captured");
    await expect(run(value, output(value, [finding(value, { evidence: [exact] })]))).resolves.toBeDefined();
    await expect(run(value, output(value, [finding(value, { evidence: [{ ...exact, end: 1_002, quote: text }] })]))).rejects.toThrow("quote-scalar-limit");
    await expect(run(value, output(value, [finding(value, { evidence: [{ quote: text }] })]))).rejects.toThrow("quote-scalar-limit");
  });
  test("Story Bible evidence has field identity/digest, never fabricated chapter versions", async () => {
    const bible = await captureBibleSource({ sourceId: "bible", bookId: saved.bookId, bookTitle: "Synthetic book", field: { section: "outline" },
      label: "Outline", containingFileHash: hash, capturedAt: stamp, text: "Known outline" });
    const value = await readerEnvelope({ sources: [structuredClone(bible)] });
    const quote = { kind: "story-bible", sourceId: "bible", bookId: saved.bookId, field: bible.field,
      valueDigest: bible.valueDigest, containingFileHash: hash, start: 0, end: 5, quote: "Known" };
    const verified = verifyReviewCitation(value, quote);
    expect(verified.status).toBe("verified-captured");
    if (verified.status === "verified-captured") expect(verified.evidence.label).toContain("Story Bible · Outline");
    expect(verifyReviewCitation(value, { ...quote, version: 1 }).status).toBe("invalid");
    expect(verifyReviewCitation(value, { ...quote, field: { section: "memory", recordId: "mem_123456", field: "text" } }).status).toBe("invalid");
    expect(verifyReviewCitation(value, { ...quote, valueDigest: "b".repeat(64) }).status).toBe("invalid");
    expect(reviewCitationNavigation(value, quote, currentSources(value)).status).toBe("unavailable");
  });
  test("stale/unavailable navigation retains historical quote and never selects a guessed location", async () => {
    const value = await readerEnvelope();
    const editor = { clean: true, identity: citation().identity };
    expect(reviewCitationNavigation(value, citation(), currentSources(value), editor).status).toBe("ready");
    expect(reviewCitationNavigation(value, citation(), currentSources(value), { ...editor, clean: false }).status).toBe("stale");
    expect(reviewCitationNavigation(value, citation(), currentSources(value), { ...editor, identity: { ...editor.identity, chapterId: "ch_654321" } }).status).toBe("stale");
    const changed = { ...source(), identity: { ...citation().identity, hash: "b".repeat(64) } };
    const stale = reviewCitationNavigation(value, citation(), [{ sourceId: "source-1", status: "available", source: changed }], editor);
    expect(stale.status).toBe("stale"); expect(stale.evidence?.citation.quote).toBe(citation().quote);
    expect(reviewCitationNavigation(value, citation(), [], editor).status).toBe("unavailable");
    expect(reviewCitationNavigation(value, citation(), [...currentSources(value), ...currentSources(value)], editor).status).toBe("unavailable");
  });
  test("rereads retain both identities and separate input changes from model variation", async () => {
    const before = await readerEnvelope(); const first = await run(before);
    const after = await readerEnvelope({ requestId: "request-2" });
    const second = await run(after, output(after, [finding(after, { interpretation: "A different impression." })]));
    expect(compareReaderRuns(first, second)).toMatchObject({ sourceChanged: false, profileChanged: false, destinationChanged: false,
      promptOrFeedbackChanged: false, interpretationChanged: true, modelVariation: true, status: "comparable", kind: "identical-input", changedFacets: [] });
    const changedProfile = await editReaderProfile(await builtinReaderProfile("alpha"), content, "author-1");
    const changedSource = { ...structuredClone(source()), identity: { ...citation().identity, version: 4 } };
    const thirdEnvelope = await readerEnvelope({ requestId: "request-3", profile: structuredClone(changedProfile), sources: [changedSource],
      destination: { ...before.destination, model: "another-model" }, priorFeedback: [{ id: "feedback-1", runId: before.requestId, label: "Selected feedback", text: "This is explicit feedback." }] });
    const third = await run(thirdEnvelope);
    expect(compareReaderRuns(first, third)).toMatchObject({ sourceChanged: true, profileChanged: true, destinationChanged: true, promptOrFeedbackChanged: true, interpretationChanged: false, modelVariation: false });
    expect(first.envelope.profile?.id).toBe("reader-alpha"); expect(first.runId).toBe("request-1");
    expect(first.envelope.priorFeedback).toHaveLength(0); expect(second.runId).toBe("request-2");
    const aliasEnvelope = await readerEnvelope({ requestId: "request-4", sources: [{ ...source(), sourceId: "new-request-alias" }] });
    const aliasRun = await run(aliasEnvelope, output(aliasEnvelope, [finding(aliasEnvelope, { evidence: [{ ...citation(), sourceId: "new-request-alias" }] })]));
    expect(compareReaderRuns(first, aliasRun)).toMatchObject({ sourceChanged: false, interpretationChanged: false });
  });
});

describe("one bounded provider-output parser", () => {
  test("valid empty and one-finding objects parse; every malformed shape fails with output-malformed", async () => {
    const value = await readerEnvelope();
    expect(parseReaderOutput(JSON.stringify(output(value, [])))).toEqual(output(value, []));
    expect(parseReaderOutput(JSON.stringify(output(value)))).toEqual(output(value));
    const malformed = [
      undefined, null, 42, {}, new String(JSON.stringify(output(value))),
      "not JSON", "```json\n{}\n```", `${JSON.stringify(output(value))} trailing`,
      JSON.stringify(null), JSON.stringify([]), JSON.stringify("text"), JSON.stringify(42),
      JSON.stringify({ ...output(value), extra: true }),
      JSON.stringify({ runId: output(value).runId, readerId: output(value).readerId, readerVersion: output(value).readerVersion }),
      JSON.stringify(output(value, [finding(value, { evidence: [citation()], extra: true })])),
      JSON.stringify(output(value, [finding(value, { category: "unknown-category" })])),
      JSON.stringify(output(value, [finding(value, { interpretation: "😀".repeat(2_001) })])),
      JSON.stringify(output(value, [finding(value, { interpretation: "\ud800" })])),
      JSON.stringify(output(value, Array.from({ length: 51 }, (_, index) => finding(value, { findingId: `f-${index}`, evidence: [] })))),
      JSON.stringify(output(value, [finding(value, { evidence: Array(9).fill(citation()) })]))
    ];
    for (const item of malformed) {
      try {
        parseReaderOutput(item);
        throw new Error("Expected an output-malformed refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewContractError);
        if (error instanceof ReviewContractError) expect(error.code).toBe("output-malformed");
      }
    }
  });

  test("the byte bound is exact and counts multibyte output", async () => {
    const value = await readerEnvelope();
    const result = output(value, [finding(value, { interpretation: "😀".repeat(2_000) })]);
    const json = JSON.stringify(result);
    const exact = json + " ".repeat(REVIEW_LIMITS.outputBytes - utf8Bytes(json));
    expect(utf8Bytes(exact)).toBe(REVIEW_LIMITS.outputBytes);
    expect(parseReaderOutput(exact)).toEqual(result);
    await expect(run(value, exact)).resolves.toBeDefined();
    await expect(run(value, `${exact} `)).rejects.toThrow("output-byte-limit");
    await expect(run(value, "😀".repeat(REVIEW_LIMITS.outputBytes / 4 + 1))).rejects.toThrow("output-byte-limit");
  });
});

describe("exact captured quotation spans", () => {
  test("a range across a selected gap and a split surrogate are invalid, not relocated", async () => {
    const body = "onePRIVATEtwo";
    const gappedSource = captureChapterSource({ sourceId: "source-1", saved: { ...saved, body }, bookTitle: "Synthetic book",
      title: "Synthetic chapter", position: 1, capturedAt: stamp, ranges: [{ start: 0, end: 3 }, { start: 10, end: 13 }] });
    const gapped = await readerEnvelope({ sources: [gappedSource] });
    const identity = { bookId: saved.bookId, chapterId: saved.chapterId, version: saved.version, hash };
    expect(verifyReviewCitation(gapped, { kind: "chapter", sourceId: "source-1", identity, start: 0, end: 13, quote: body }))
      .toEqual({ status: "invalid", reason: "range" });
    expect(verifyReviewCitation(gapped, { kind: "chapter", sourceId: "source-1", identity, start: 3, end: 4, quote: "P" }))
      .toEqual({ status: "invalid", reason: "range" });
    const emojiSource = captureChapterSource({ sourceId: "source-1", saved: { ...saved, body: "a😀b" }, bookTitle: "Synthetic book",
      title: "Synthetic chapter", position: 1, capturedAt: stamp, ranges: [{ start: 0, end: 4 }] });
    const emoji = await readerEnvelope({ sources: [emojiSource] });
    for (const span of [{ start: 0, end: 2, quote: "a" }, { start: 2, end: 4, quote: "b" }]) {
      expect(verifyReviewCitation(emoji, { kind: "chapter", sourceId: "source-1", identity, ...span }))
        .toEqual({ status: "invalid", reason: "range" });
    }
    expect(verifyReviewCitation(emoji, { kind: "chapter", sourceId: "source-1", identity, start: 0, end: 1, quote: "a" }))
      .toMatchObject({ status: "verified-captured" });
  });
});

describe("explicit current saved-source checks", () => {
  function detail(overrides: { content?: string; version?: number; hash?: string; title?: string; order?: number; chapters?: unknown[] } = {}): BookDetail {
    return {
      book: { id: saved.bookId, title: "Synthetic book" },
      chapters: overrides.chapters ?? [{
        id: saved.chapterId, title: overrides.title ?? "Synthetic chapter", order: overrides.order ?? 1,
        content: overrides.content ?? saved.body, version: overrides.version ?? saved.version, hash: overrides.hash ?? hash
      }],
      chapterReadIssues: []
    } as unknown as BookDetail;
  }

  test("exact current bytes are available; version, hash, body, title and order changes are stale", async () => {
    const value = await readerEnvelope();
    const exact = readerCurrentSources(value, detail(), stamp);
    expect(exact).toHaveLength(1);
    expect(item(exact)).toMatchObject({ sourceId: "source-1", status: "available" });
    expect(sourceCurrency(item(value.sources), exact)).toBe("current");
    for (const changed of [
      detail({ version: 4 }), detail({ hash: "b".repeat(64) }),
      detail({ content: saved.body.replace("Selected", "selected") }),
      detail({ title: "Renamed chapter" }), detail({ order: 2 })
    ]) {
      const current = readerCurrentSources(value, changed, stamp);
      expect(item(current)).toEqual({ sourceId: "source-1", status: "stale" });
      expect(sourceCurrency(item(value.sources), current)).toBe("stale");
    }
  });

  test("a shortened body or capture refusal is stale; a deleted chapter is missing; duplicate IDs are ambiguous", async () => {
    const value = await readerEnvelope();
    expect(item(readerCurrentSources(value, detail({ content: "short" }), stamp))).toEqual({ sourceId: "source-1", status: "stale" });
    expect(item(readerCurrentSources(value, detail({ chapters: [] }), stamp))).toEqual({ sourceId: "source-1", status: "missing" });
    const duplicate = [{ id: saved.chapterId, title: "One", order: 1, content: saved.body, version: 3, hash },
      { id: saved.chapterId, title: "Two", order: 2, content: saved.body, version: 3, hash }];
    expect(item(readerCurrentSources(value, detail({ chapters: duplicate }), stamp))).toEqual({ sourceId: "source-1", status: "ambiguous" });
  });

  test("malformed details and non-chapter sources are missing without throwing", async () => {
    const value = await readerEnvelope();
    for (const malformed of [null, {}, { book: {}, chapters: [] }, { book: { id: saved.bookId }, chapters: "not-an-array" }, "detail"]) {
      expect(readerCurrentSources(value, malformed, stamp)).toEqual([{ sourceId: "source-1", status: "missing" }]);
    }
    const bible = await captureBibleSource({ sourceId: "bible", bookId: saved.bookId, bookTitle: "Synthetic book",
      field: { section: "outline" }, label: "Outline", containingFileHash: hash, capturedAt: stamp, text: "Known outline" });
    const bibleEnvelope = await readerEnvelope({ sources: [bible] });
    expect(item(readerCurrentSources(bibleEnvelope, detail(), stamp))).toEqual({ sourceId: "bible", status: "missing" });
  });

  test("fresh capture time does not make an unchanged source stale", async () => {
    const value = await readerEnvelope();
    const current = readerCurrentSources(value, detail(), "2026-11-08T09:00:00Z");
    expect(sourceCurrency(item(value.sources), current)).toBe("current");
  });

  test("readerSourceState counts current, stale and unavailable sources per envelope", async () => {
    const value = await readerEnvelope();
    const current = readerCurrentSources(value, detail(), stamp);
    expect(readerSourceState(value, current)).toEqual({ status: "current", current: 1, stale: 0, unavailable: 0, total: 1 });
    expect(readerSourceState(value, [{ sourceId: "source-1", status: "stale" }]))
      .toEqual({ status: "stale", current: 0, stale: 1, unavailable: 0, total: 1 });
    expect(readerSourceState(value, [{ sourceId: "source-1", status: "missing" }]))
      .toEqual({ status: "unavailable", current: 0, stale: 0, unavailable: 1, total: 1 });
    const second = { ...structuredClone(source()), sourceId: "source-2", identity: { ...citation().identity, chapterId: "ch_654321" } };
    const mixed = await readerEnvelope({ sources: [structuredClone(source()), second] });
    expect(readerSourceState(mixed, [{ sourceId: "source-1", status: "available", source: item(mixed.sources) },
      { sourceId: "source-2", status: "missing" }]))
      .toEqual({ status: "unavailable", current: 1, stale: 0, unavailable: 1, total: 2 });
  });

  test("navigation reasons distinguish kind, editor, stale, missing and ambiguous without dropping the quote", async () => {
    const value = await readerEnvelope();
    const editor = { clean: true, identity: citation().identity };
    expect(reviewCitationNavigation(value, citation(), currentSources(value))).toEqual({ status: "ready", evidence: expect.anything() });
    expect(reviewCitationNavigation(value, citation(), currentSources(value), { ...editor, clean: false }))
      .toMatchObject({ status: "stale", reason: "editor" });
    expect(reviewCitationNavigation(value, citation(), [], editor)).toMatchObject({ status: "unavailable", reason: "missing" });
    expect(reviewCitationNavigation(value, citation(), [...currentSources(value), ...currentSources(value)], editor))
      .toMatchObject({ status: "unavailable", reason: "ambiguous" });
    const changed = { ...source(), identity: { ...citation().identity, hash: "b".repeat(64) } };
    const stale = reviewCitationNavigation(value, citation(), [{ sourceId: "source-1", status: "available", source: changed }], editor);
    expect(stale).toMatchObject({ status: "stale", reason: "stale" });
    expect(stale.evidence?.citation.quote).toBe(citation().quote);
    const bible = await captureBibleSource({ sourceId: "bible", bookId: saved.bookId, bookTitle: "Synthetic book",
      field: { section: "outline" }, label: "Outline", containingFileHash: hash, capturedAt: stamp, text: "Known outline" });
    const bibleEnvelope = await readerEnvelope({ sources: [bible] });
    const quote = { kind: "story-bible", sourceId: "bible", bookId: saved.bookId, field: bible.field,
      valueDigest: bible.valueDigest, containingFileHash: hash, start: 0, end: 5, quote: "Known" };
    expect(reviewCitationNavigation(bibleEnvelope, quote, [], editor)).toMatchObject({ status: "unavailable", reason: "kind" });
  });
});

describe("volatile rerun comparison", () => {
  const content: ProfileContent = { name: "Same name", purpose: "A fictional editorial lens", focus: ["clarity"], guidance: "Be concise." };

  test("identical input with different interpretation is model variation, never improvement", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const second = await readerEnvelope({ requestId: "request-2" });
    const before = await run(first, output(first, [finding(first, { interpretation: "One reading." })]));
    const after = await run(second, output(second, [finding(second, { interpretation: "Another reading." })]));
    const comparison = compareReaderRuns(before, after);
    expect(comparison.status).toBe("comparable");
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.kind).toBe("identical-input");
    expect(comparison.changedFacets).toEqual([]);
    expect(comparison.modelVariation).toBe(true);
    expect(comparison.interpretationChanged).toBe(true);
    expect(comparison.evidenceChanged).toBe(false);
    expect(comparison.partial).toBe(false);
    expect(comparison.before.total).toBe(1);
    expect(comparison.after.total).toBe(1);
  });

  test("identical input with identical findings reports no variation", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const second = await readerEnvelope({ requestId: "request-2" });
    const before = await run(first);
    const after = await run(second);
    const comparison = compareReaderRuns(before, after);
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.kind).toBe("identical-input");
    expect(comparison.modelVariation).toBe(false);
    expect(comparison.interpretationChanged).toBe(false);
    expect(comparison.evidenceChanged).toBe(false);
    expect(comparison.changedFacets).toEqual([]);
  });

  test("order-only finding reordering does not set interpretationChanged", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const second = await readerEnvelope({ requestId: "request-2" });
    const one = finding(first, { findingId: "finding-1", interpretation: "First impression." });
    const two = finding(first, { findingId: "finding-2", category: "pacing", interpretation: "Second impression." });
    const before = await run(first, output(first, [one, two]));
    const after = await run(second, output(second, [
      { ...two, runId: second.requestId, readerId: second.profile?.id, readerVersion: second.profile?.version },
      { ...one, runId: second.requestId, readerId: second.profile?.id, readerVersion: second.profile?.version }
    ]));
    const comparison = compareReaderRuns(before, after);
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.interpretationChanged).toBe(false);
    expect(comparison.modelVariation).toBe(false);
  });

  test("same interpretation with a different captured span sets evidenceChanged only", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const second = await readerEnvelope({ requestId: "request-2" });
    const narrower = { ...citation(), end: selectedStart + "Selected".length, quote: "Selected" };
    const before = await run(first);
    const after = await run(second, output(second, [finding(second, { evidence: [narrower] })]));
    const comparison = compareReaderRuns(before, after);
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.interpretationChanged).toBe(false);
    expect(comparison.evidenceChanged).toBe(true);
    expect(comparison.modelVariation).toBe(true);
    expect(comparison.kind).toBe("identical-input");
  });

  test("a saved-version revision reports one revision source change and nothing else", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const revised = captureChapterSource({ sourceId: "source-1", saved: { ...saved, version: 4, hash: "b".repeat(64) },
      bookTitle: "Synthetic book", title: "Synthetic chapter", position: 1, capturedAt: stamp,
      ranges: [{ start: selectedStart, end: selectedEnd }] });
    const second = await readerEnvelope({ requestId: "request-2", sources: [revised] });
    const before = await run(first);
    const after = await run(second);
    const comparison = compareReaderRuns(before, after);
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.kind).toBe("changed-source");
    expect(comparison.changedFacets).toEqual(["sources"]);
    expect(comparison.sources).toHaveLength(1);
    expect(comparison.sources[0]).toEqual({ kind: "revision", label: "Synthetic book · Chapter 1: Synthetic chapter",
      fromVersion: 3, toVersion: 4, hashChanged: true });
    expect(comparison.profile.changed).toBe(false);
    expect(comparison.destination.changed).toBe(false);
    expect(comparison.request.changed).toBe(false);
    expect(comparison.promptOrFeedbackChanged).toBe(false);
  });

  test("a same-version content change reports content with no version transition", async () => {
    const changedBody = "ADJACENT_BEFORE\nSelected 😀 exact.\nADJACENT_AFTER!";
    const first = await readerEnvelope({ requestId: "request-1" });
    const contentSource = captureChapterSource({ sourceId: "source-1", saved: { ...saved, body: changedBody, hash: "b".repeat(64) },
      bookTitle: "Synthetic book", title: "Synthetic chapter", position: 1, capturedAt: stamp,
      ranges: [{ start: selectedStart, end: selectedEnd }] });
    const second = await readerEnvelope({ requestId: "request-2", sources: [contentSource] });
    const comparison = compareReaderRuns(await run(first), await run(second));
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.kind).toBe("changed-source");
    expect(comparison.sources[0]).toMatchObject({ kind: "content", fromVersion: 3, toVersion: 3, hashChanged: true });
  });

  test("a same-version selection change reports selection and keeps the hash", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const reselected = captureChapterSource({ sourceId: "source-1", saved,
      bookTitle: "Synthetic book", title: "Synthetic chapter", position: 1, capturedAt: stamp,
      ranges: [{ start: selectedStart, end: selectedEnd - 3 }] });
    const second = await readerEnvelope({ requestId: "request-2", sources: [reselected] });
    const comparison = compareReaderRuns(await run(first), await run(second));
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.kind).toBe("changed-source");
    expect(comparison.sources[0]).toMatchObject({ kind: "selection", hashChanged: false, fromVersion: 3, toVersion: 3 });
  });

  test("a same-version title or position change reports a label change", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const renamed = captureChapterSource({ sourceId: "source-1", saved,
      bookTitle: "Synthetic book", title: "Renamed chapter", position: 1, capturedAt: stamp,
      ranges: [{ start: selectedStart, end: selectedEnd }] });
    const second = await readerEnvelope({ requestId: "request-2", sources: [renamed] });
    const comparison = compareReaderRuns(await run(first), await run(second));
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.sources[0]).toMatchObject({ kind: "label", hashChanged: false });
    expect(comparison.kind).toBe("changed-source");
  });

  test("added and removed sources report one-sided versions without hash text", async () => {
    const bible = await captureBibleSource({ sourceId: "bible", bookId: saved.bookId, bookTitle: "Synthetic book",
      field: { section: "outline" }, label: "Outline", containingFileHash: hash, capturedAt: stamp, text: "Known outline" });
    const first = await readerEnvelope({ requestId: "request-1" });
    const added = await readerEnvelope({ requestId: "request-2", sources: [structuredClone(source()), bible] });
    const addedComparison = compareReaderRuns(await run(first), await run(added));
    if (addedComparison.status !== "comparable") throw new Error("expected comparable");
    expect(addedComparison.sources).toHaveLength(1);
    expect(addedComparison.sources[0]).toMatchObject({ kind: "added", label: "Synthetic book · Story Bible · Outline",
      fromVersion: null, toVersion: null, hashChanged: false });
    expect(JSON.stringify(addedComparison.sources)).not.toContain(hash);
    const removedComparison = compareReaderRuns(await run(added), await run(first));
    if (removedComparison.status !== "comparable") throw new Error("expected comparable");
    expect(removedComparison.sources).toHaveLength(1);
    expect(removedComparison.sources[0]).toMatchObject({ kind: "removed", label: "Synthetic book · Story Bible · Outline" });
  });

  test("a built-in to author fork reports changed-profile with fork identity", async () => {
    const alpha = await builtinReaderProfile("alpha");
    const author = await editReaderProfile(alpha, content, "author-1");
    const first = await readerEnvelope({ requestId: "request-1" });
    const second = await readerEnvelope({ requestId: "request-2", profile: structuredClone(author) });
    const comparison = compareReaderRuns(await run(first), await run(second));
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.kind).toBe("changed-profile");
    expect(comparison.changedFacets).toEqual(["profile"]);
    expect(comparison.profile).toMatchObject({ changed: true, sameId: false, versionChanged: false, digestChanged: true });
    expect(comparison.profile.from).toMatchObject({ id: "reader-alpha", version: 1, origin: "builtin" });
    expect(comparison.profile.to).toMatchObject({ id: "author-1", version: 1, origin: "author" });
    expect(first.profile?.id).toBe("reader-alpha");
    expect(first.profile?.version).toBe(1);
    expect(comparison.modelVariation).toBe(false);
  });

  test("an author v1 to v2 edit reports the version transition with the same id", async () => {
    const alpha = await builtinReaderProfile("alpha");
    const author = await editReaderProfile(alpha, content, "author-1");
    const next = await editReaderProfile(author, { ...content, guidance: "Changed guidance." });
    const first = await readerEnvelope({ requestId: "request-1", profile: structuredClone(author) });
    const second = await readerEnvelope({ requestId: "request-2", profile: structuredClone(next) });
    const comparison = compareReaderRuns(await run(first), await run(second));
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.kind).toBe("changed-profile");
    expect(comparison.profile).toMatchObject({ changed: true, sameId: true, versionChanged: true, digestChanged: true });
  });

  test("provider, model, connection and endpoint changes are independent destination facets", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const destinationOf = async (destination: Partial<ReviewEnvelope["destination"]>, id = "request-2") => {
      const value = await readerEnvelope({ requestId: id, destination: { ...input().destination, ...destination } });
      const comparison = compareReaderRuns(await run(first), await run(value));
      if (comparison.status !== "comparable") throw new Error("expected comparable");
      return comparison;
    };
    expect((await destinationOf({ provider: "Other provider" })).destination).toMatchObject({ providerChanged: true, modelChanged: false, connectionChanged: false, endpointChanged: false, changed: true });
    expect((await destinationOf({ model: "other/model" })).destination).toMatchObject({ modelChanged: true, providerChanged: false, connectionChanged: false, endpointChanged: false });
    expect((await destinationOf({ connectionId: "connection-2" })).destination).toMatchObject({ connectionChanged: true, providerChanged: false, modelChanged: false, endpointChanged: false });
    expect((await destinationOf({ endpointIdentity: "endpoint-revision-2" })).destination).toMatchObject({ endpointChanged: true, providerChanged: false, modelChanged: false, connectionChanged: false, changed: true });
    expect((await destinationOf({})).destination.changed).toBe(false);
    expect((await destinationOf({ provider: "Other provider" })).kind).toBe("changed-destination");
  });

  test("a capability revision or price fact is not a destination change", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const base = input();
    const second = await readerEnvelope({ requestId: "request-2",
      environment: { ...base.environment, capabilityRevision: "capability-2", priceAsOf: stamp, catalogContextTokens: 128000, catalogAsOf: stamp } });
    const comparison = compareReaderRuns(await run(first), await run(second));
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.destination.changed).toBe(false);
    expect(comparison.kind).toBe("identical-input");
  });

  test("prompt, prior feedback and book policy changes are request facets; a title-only change is not", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const prompted = await readerEnvelope({ requestId: "request-2", prompt: "A different request." });
    const promptedComparison = compareReaderRuns(await run(first), await run(prompted));
    if (promptedComparison.status !== "comparable") throw new Error("expected comparable");
    expect(promptedComparison.kind).toBe("changed-request");
    expect(promptedComparison.request.changed).toBe(true);
    expect(promptedComparison.request.promptChanged).toBe(true);
    expect(promptedComparison.request.priorFeedbackChanged).toBe(false);
    expect(promptedComparison.request.bookPolicyChanged).toBe(false);

    const fed = await readerEnvelope({ requestId: "request-3",
      priorFeedback: [{ id: "feedback-1", runId: "request-1", label: "Earlier note", text: "An explicit earlier impression." }] });
    const fedComparison = compareReaderRuns(await run(first), await run(fed));
    if (fedComparison.status !== "comparable") throw new Error("expected comparable");
    expect(fedComparison.kind).toBe("changed-request");
    expect(fedComparison.request.priorFeedbackChanged).toBe(true);
    expect(fedComparison.request.promptChanged).toBe(false);

    const base = input();
    const retitledSource = captureChapterSource({ sourceId: "source-1", saved,
      bookTitle: "Renamed book", title: "Synthetic chapter", position: 1, capturedAt: stamp,
      ranges: [{ start: selectedStart, end: selectedEnd }] });
    const retitled = await readerEnvelope({ requestId: "request-4",
      books: base.books.map((book) => ({ ...book, title: "Renamed book" })), sources: [retitledSource] });
    const retitledComparison = compareReaderRuns(await run(first), await run(retitled));
    if (retitledComparison.status !== "comparable") throw new Error("expected comparable");
    expect(retitledComparison.request.bookPolicyChanged).toBe(false);

    const repoliced = await readerEnvelope({ requestId: "request-5",
      books: base.books.map((book) => ({ ...book, termsRevision: "terms-2" })) });
    const repolicedComparison = compareReaderRuns(await run(first), await run(repoliced));
    if (repolicedComparison.status !== "comparable") throw new Error("expected comparable");
    expect(repolicedComparison.request.bookPolicyChanged).toBe(true);
    expect(repolicedComparison.kind).toBe("changed-request");
  });

  test("request scope counts are exact UTF-8/UTF-16 accounting and flag only real differences", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const second = await readerEnvelope({ requestId: "request-2" });
    const usage = reviewResourceUsage(first);
    const comparison = compareReaderRuns(await run(first), await run(second));
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.request.before).toEqual(usage);
    expect(comparison.request.after).toEqual(usage);
    expect(comparison.request.scopeCountsChanged).toBe(false);
    const fed = await readerEnvelope({ requestId: "request-3",
      priorFeedback: [{ id: "feedback-1", runId: "request-1", label: "Earlier note", text: "An explicit earlier impression." }] });
    const withFeedback = compareReaderRuns(await run(first), await run(fed));
    if (withFeedback.status !== "comparable") throw new Error("expected comparable");
    expect(withFeedback.request.scopeCountsChanged).toBe(true);
    expect(withFeedback.request.after.combinedBytes).toBeGreaterThan(withFeedback.request.before.combinedBytes);
  });

  test("multiple facets are all listed and never collapsed into one cause", async () => {
    const alpha = await builtinReaderProfile("alpha");
    const author = await editReaderProfile(alpha, content, "author-1");
    const first = await readerEnvelope({ requestId: "request-1" });
    const changedSource = captureChapterSource({ sourceId: "source-1", saved: { ...saved, version: 4, hash: "b".repeat(64) },
      bookTitle: "Synthetic book", title: "Synthetic chapter", position: 1, capturedAt: stamp,
      ranges: [{ start: selectedStart, end: selectedEnd }] });
    const second = await readerEnvelope({ requestId: "request-2", profile: structuredClone(author),
      sources: [changedSource], destination: { ...input().destination, model: "other/model" }, prompt: "A different request." });
    const comparison = compareReaderRuns(await run(first), await run(second));
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.kind).toBe("multiple-changes");
    expect(comparison.changedFacets).toEqual(["sources", "profile", "destination", "request"]);
    expect(comparison.modelVariation).toBe(false);
  });

  test("counts are exact, category-complete and never a score", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const second = await readerEnvelope({ requestId: "request-2" });
    const findings = [
      finding(first, { findingId: "f-1", category: "clarity", claim: "observation", evidence: [citation()] }),
      finding(first, { findingId: "f-2", category: "continuity", claim: "contradiction",
        evidence: [citation(), { ...citation(), end: selectedStart + 8, quote: "Selected" }] }),
      finding(first, { findingId: "f-3", category: "pacing", claim: "question", evidence: [{ ...citation(), quote: "invented" }] }),
      finding(first, { findingId: "f-4", category: "character-motivation", claim: "observation",
        evidence: [citation(), { ...citation(), quote: "invented" }] })
    ];
    const before = await run(first, output(first, findings));
    const after = await run(second, output(second, []));
    const comparison = compareReaderRuns(before, after);
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.before).toMatchObject({ total: 4, observations: 2, questions: 1, contradictions: 1,
      verifiedEvidence: 4, withheldEvidence: 2, insufficientFindings: 1, incompleteEvidenceFindings: 1 });
    expect(comparison.before.byCategory).toEqual({
      "reader-impression": 0, clarity: 1, pacing: 1, "character-motivation": 1, continuity: 1
    });
    expect(comparison.after).toMatchObject({ total: 0, observations: 0, questions: 0, contradictions: 0,
      verifiedEvidence: 0, withheldEvidence: 0, insufficientFindings: 0, incompleteEvidenceFindings: 0 });
    expect(comparison.partial).toBe(true);
  });

  test("a zero-finding run is comparable with exact zeros", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const second = await readerEnvelope({ requestId: "request-2" });
    const before = await run(first, output(first, []));
    const after = await run(second, output(second, []));
    const comparison = compareReaderRuns(before, after);
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.kind).toBe("identical-input");
    expect(comparison.before.total).toBe(0);
    expect(comparison.after.total).toBe(0);
    expect(comparison.partial).toBe(false);
  });

  test("an unregistered envelope or a mismatched run fails closed with no counts", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const before = await run(first);
    const mismatched = { ...before, runId: "request-other" };
    const byId = compareReaderRuns(before, mismatched);
    expect(byId).toEqual({ status: "not-comparable", reason: "invalid-run" });
    const detached = { ...before, envelope: JSON.parse(JSON.stringify(before.envelope)) as typeof before.envelope };
    const byEnvelope = compareReaderRuns(before, detached);
    expect(byEnvelope).toEqual({ status: "not-comparable", reason: "invalid-envelope" });
    expect("before" in byEnvelope).toBe(false);
    expect("after" in byEnvelope).toBe(false);
    expect("changedFacets" in byEnvelope).toBe(false);
  });

  test("a complete 50-finding and 8-evidence boundary count is exact", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const second = await readerEnvelope({ requestId: "request-2" });
    const many = Array.from({ length: 50 }, (_, index) => finding(first, { findingId: `f-${index}`,
      evidence: Array.from({ length: 8 }, () => citation()) }));
    const before = await run(first, output(first, many));
    const after = await run(second, output(second, []));
    const comparison = compareReaderRuns(before, after);
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.before.total).toBe(50);
    expect(comparison.before.verifiedEvidence).toBe(400);
    expect(comparison.before.byCategory.clarity).toBe(50);
    expect(comparison.partial).toBe(false);
  });

  test("capture time and request-local aliases never register as source changes", async () => {
    const first = await readerEnvelope({ requestId: "request-1" });
    const aliased = captureChapterSource({ sourceId: "renamed-alias", saved,
      bookTitle: "Synthetic book", title: "Synthetic chapter", position: 1, capturedAt: "2026-11-08T00:00:00Z",
      ranges: [{ start: selectedStart, end: selectedEnd }] });
    const second = await readerEnvelope({ requestId: "request-2", sources: [aliased] });
    const aliasedRun = await run(second, output(second, [
      finding(second, { evidence: [{ ...citation(), sourceId: "renamed-alias" }] })
    ]));
    const comparison = compareReaderRuns(await run(first), aliasedRun);
    if (comparison.status !== "comparable") throw new Error("expected comparable");
    expect(comparison.sourceChanged).toBe(false);
    expect(comparison.kind).toBe("identical-input");
  });
});
