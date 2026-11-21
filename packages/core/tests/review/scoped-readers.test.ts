import { describe, expect, test } from "bun:test";
import { ReviewContractError, REVIEW_LIMITS, utf8Bytes } from "../../src/review/contract";
import { buildReviewEnvelope, checkReviewStart, sourceCurrency, type EnvelopeInput, type ReviewEnvelope } from "../../src/review/envelope";
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
    expect(compareReaderRuns(first, second)).toEqual({ sourceChanged: false, profileChanged: false, destinationChanged: false,
      promptOrFeedbackChanged: false, interpretationChanged: true, modelVariation: true });
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
      "not JSON", "```json\n{}\n```", `\uFEFF${JSON.stringify(output(value))}`, `\`\`\`json\n${JSON.stringify(output(value))}\n\`\`\``, `${JSON.stringify(output(value))} trailing`,
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

describe("injection resistance at the findings boundary", () => {
  test("I-12 markup in an interpretation is stored as an inert string, never as elements", async () => {
    const value = await readerEnvelope();
    const payload = '<img src=x onerror=alert(1)> <script>globalThis.pwned = true</script>';
    const report = await run(value, output(value, [finding(value, { interpretation: payload })]));
    const result = item(report.findings);
    expect(result.interpretation).toBe(payload);
    expect(result.subjective).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("I-13 a quote copied from unselected adjacent bytes is refused as out of range", async () => {
    const value = await readerEnvelope();
    const quote = saved.body.slice(selectedEnd);
    expect(verifyReviewCitation(value, { ...citation(), start: selectedEnd, end: selectedEnd + quote.length, quote }))
      .toEqual({ status: "invalid", reason: "range" });
    // The same bytes are perfectly valid inside the selection, proving it is the range, not the text.
    const inside = saved.body.slice(selectedStart, selectedEnd);
    expect(verifyReviewCitation(value, citation())).toMatchObject({ status: "verified-captured" });
    expect(inside).toBe(citation().quote);
  });

  test("I-14 bidi controls, zero-width joiners and homoglyphs never satisfy byte equality", async () => {
    const value = await readerEnvelope();
    const exact = citation().quote;
    const variants = [
      `\u202E${exact}`,
      `${exact.slice(0, 3)}\u200B${exact.slice(3)}`,
      exact.replace("e", "\u0435"),
      exact.replace("e", "е")
    ];
    for (const quote of variants) {
      const start = citation().start;
      const end = start + [...quote].length;
      expect(verifyReviewCitation(value, { ...citation(), start, end, quote }).status).toBe("invalid");
    }
    expect(verifyReviewCitation(value, citation()).status).toBe("verified-captured");
  });

  test("I-15 a citation spanning a selection gap is withheld and counted, never relocated", async () => {
    const body = "onePRIVATEtwo";
    const gapped = captureChapterSource({ sourceId: "source-1", saved: { ...saved, body }, bookTitle: "Synthetic book",
      title: "Synthetic chapter", position: 1, capturedAt: stamp, ranges: [{ start: 0, end: 3 }, { start: 10, end: 13 }] });
    const value = await readerEnvelope({ sources: [gapped] });
    const crossing = { kind: "chapter" as const, sourceId: "source-1", identity: gapped.identity, start: 0, end: 13, quote: body };
    expect(verifyReviewCitation(value, crossing)).toEqual({ status: "invalid", reason: "range" });
    const report = await run(value, output(value, [finding(value, { evidence: [crossing] })]));
    const result = item(report.findings);
    expect(result.evidence).toHaveLength(0);
    expect(item(result.invalidEvidence).reason).toBe("range");
    expect(result.evidenceState).toBe("insufficient-evidence");
  });
});
