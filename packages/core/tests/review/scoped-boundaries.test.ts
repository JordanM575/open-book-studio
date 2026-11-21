import { describe, expect, spyOn, test } from "bun:test";
import { assertReviewData, canonicalJson, digestJson } from "../../src/review/contract";
import { buildReviewEnvelope, checkReviewStart, parseReviewEnvelope, serializeProviderRequest, serializeReviewEnvelope, sourceCurrency } from "../../src/review/envelope";
import { createReviewReadFacade } from "../../src/review/facade";
import { buildReaderRun, reviewCitationNavigation, verifyReviewCitation } from "../../src/review/findings";
import { builtinReaderProfile, editReaderProfile, validateReaderProfile } from "../../src/review/profiles";
import { captureChapterSource, checkSavedQuoteNavigation, verifySavedBodyQuote } from "../../src/review/sources";
import { citation, currentFacts, currentSources, input, saved, stamp } from "./scoped-fixtures";

test("synchronous evidence refuses unchecked copies until digest-checked rehydration", async () => {
  const envelope = await buildReviewEnvelope(input());
  const serialized = serializeReviewEnvelope(envelope);
  const copy = JSON.parse(serialized);
  expect(verifyReviewCitation(copy, citation()).status).toBe("invalid");
  expect(reviewCitationNavigation(copy, citation(), currentSources(envelope)).status).toBe("unavailable");
  const validated = await parseReviewEnvelope(serialized);
  expect(verifyReviewCitation(validated, citation()).status).toBe("verified-captured");
  const segment = copy.sources[0].segments[0];
  segment.text = "X".repeat(segment.text.length);
  const forged = { ...citation(), quote: segment.text };
  expect(verifyReviewCitation(copy, forged).status).toBe("invalid");
  expect(reviewCitationNavigation(copy, forged, currentSources(copy), { clean: true, identity: forged.identity }).status).toBe("unavailable");
  await expect(parseReviewEnvelope(JSON.stringify(copy))).rejects.toThrow("scope-digest");
});

test("envelopes refuse foreign, inherited, hidden, accessor and sparse input without invoking getters", async () => {
  class Foreign {}
  let reads = 0;
  const accessor = Object.defineProperty(input(), "prompt", { enumerable: true, get() { reads++; return "hidden"; } });
  const hidden = Object.defineProperty(input(), "hidden", { value: 1 });
  const cycle = input();
  Object.defineProperty(cycle, "self", { value: cycle });
  for (const value of [Object.create(input()), Object.assign(new Foreign(), input()), hidden, cycle, accessor,
    { ...input(), sources: Array(1) }, Object.assign(input(), { [Symbol("extra")]: 1 })]) {
    await expect(buildReviewEnvelope(value)).rejects.toThrow();
  }
  expect(reads).toBe(0);
});

test("canonical JSON refuses lossy values and cycles without executing hooks", async () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { invoked++; return 1; } });
  const hook = { toJSON() { invoked++; return {}; } };
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  const values = [new Date(0), new Map([["x", 1]]), new Set([1]), new Uint8Array([1]), undefined, NaN, Infinity, -Infinity,
    -0, Number.MAX_SAFE_INTEGER + 1, 1n, Symbol("x"), { a: undefined }, [undefined], Array(1), Object.assign([], { extra: 1 }),
    Object.create({ inherited: 1 }), Object.defineProperty({}, "hidden", { value: 1 }), getter, hook, cycle];
  for (const value of values) {
    expect(() => canonicalJson(value)).toThrow();
    await expect(digestJson(value)).rejects.toThrow();
  }
  expect(invoked).toBe(0);
  expect(() => assertReviewData(cycle)).toThrow("cyclic-json");
});

test("canonical JSON preserves supported numbers, null-prototype keys, shared values and literal Unicode", async () => {
  const shared = { fractional: .125, tiny: 1e-100, maximum: Number.MAX_SAFE_INTEGER };
  const data = Object.assign(Object.create(null), JSON.parse('{"__proto__":"literal","constructor":"also literal"}'), { a: shared, b: shared });
  expect(JSON.parse(canonicalJson(data))).toEqual(data);
  expect(await digestJson({ a: 1, b: [2, 3] })).toBe(await digestJson({ b: [2, 3], a: 1 }));
  expect(await digestJson([2, 3])).not.toBe(await digestJson([3, 2]));
  expect(await digestJson("é")).not.toBe(await digestJson("e\u0301"));
  expect(JSON.parse(canonicalJson("\ud800"))).toBe("\ud800"); // Lossless JSON; text schemas still refuse evidence.
  let deep: unknown = null;
  for (let i = 0; i < 6_000; i++) deep = [deep];
  expect(canonicalJson(deep)).toBe(`${"[".repeat(6_000)}null${"]".repeat(6_000)}`);
});

test("plain-data validation bounds shared DAG visits and rechecks mutations on every call", () => {
  const leaf: Record<string, unknown> = { value: true };
  let graph: object = leaf;
  const nodes = new Set([graph]);
  for (let i = 0; i < 128; i++) {
    graph = { left: graph, right: graph };
    nodes.add(graph);
  }
  let visits = 0;
  const ownKeys = Reflect.ownKeys;
  const scan = spyOn(Reflect, "ownKeys").mockImplementation((value) => {
    if (nodes.has(value) && ++visits > nodes.size * 4) throw new Error("Unbounded shared-DAG traversal");
    return ownKeys(value);
  });
  try {
    expect(() => assertReviewData(graph)).not.toThrow();
    expect(visits).toBeLessThanOrEqual(nodes.size * 2);
  } finally { scan.mockRestore(); }

  leaf.value = -0;
  expect(() => assertReviewData(graph)).toThrow("non-json-number");
  leaf.value = graph;
  expect(() => assertReviewData(graph)).toThrow("cyclic-json");
  let invoked = 0;
  Object.defineProperty(leaf, "value", { enumerable: true, get() { invoked++; return true; } });
  expect(() => assertReviewData(graph)).toThrow("non-json-property");
  expect(invoked).toBe(0);
});

test("navigation requires actual boolean cleanliness and plain current facts", async () => {
  const envelope = await buildReviewEnvelope(input());
  const quote = citation();
  const anchor = { ...quote.identity, start: quote.start, end: quote.end, quote: quote.quote };
  for (const clean of ["false", "true", 1, {}, null]) {
    const editor = { clean: clean as boolean, identity: saved };
    expect(reviewCitationNavigation(envelope, quote, currentSources(envelope), editor).status).not.toBe("ready");
    expect(checkSavedQuoteNavigation(anchor, [saved], editor)).not.toBe("ready");
  }
  const editor = Object.create({ clean: true, identity: quote.identity });
  expect(reviewCitationNavigation(envelope, quote, currentSources(envelope), editor).status).toBe("stale");
  expect(checkSavedQuoteNavigation(anchor, [saved], editor)).toBe("stale");
  expect(verifySavedBodyQuote(Object.create(saved), anchor).status).toBe("invalid");
  expect(verifySavedBodyQuote(saved, Object.create(anchor)).status).toBe("invalid");
  expect(verifySavedBodyQuote(saved, anchor, Array(1)).status).toBe("invalid");
  const source = envelope.sources[0];
  if (!source) throw new Error("Missing fixture source");
  expect(sourceCurrency(source, Object.create(currentSources(envelope)))).toBe("unavailable");
  expect(verifyReviewCitation(envelope, Object.create(quote)).status).toBe("invalid");
});

test("Start refuses inherited or malformed action/facts and captures supplied facts before awaits", async () => {
  const envelope = await buildReviewEnvelope(input());
  const action = { kind: "start" as const, requestId: envelope.requestId, scopeDigest: envelope.scopeDigest };
  expect(await checkReviewStart(envelope, Object.create(action), currentFacts(envelope), currentSources(envelope))).not.toEqual([]);
  expect(await checkReviewStart(envelope, action, Object.create(currentFacts(envelope)), currentSources(envelope))).not.toEqual([]);
  expect(await checkReviewStart(envelope, action, currentFacts(envelope), Array(1))).not.toEqual([]);
  const facts = JSON.parse(JSON.stringify(currentFacts(envelope)));
  facts.books[0].consentSatisfied = false;
  const checking = checkReviewStart(envelope, action, facts, currentSources(envelope));
  facts.books[0].consentSatisfied = true;
  expect(await checking).toContain("consent-missing");
});

test("profile and tool input cannot normalize foreign/accessor data", async () => {
  const profile = await builtinReaderProfile("alpha");
  await expect(validateReaderProfile(Object.create(profile))).rejects.toThrow();
  const content = { name: "Reader", purpose: "Purpose", focus: ["clarity"], guidance: "Read" };
  await expect(editReaderProfile(profile, Object.create(content), "author-1")).rejects.toThrow();
  const facade = await createReviewReadFacade(await buildReviewEnvelope(input()));
  expect(() => facade.execute("read_chapter", Object.create({ bookId: saved.bookId, chapterId: saved.chapterId }))).toThrow();
  let reads = 0;
  const args = Object.defineProperty({}, "query", { enumerable: true, get() { reads++; return "x"; } });
  expect(() => facade.execute("find_in_chapters", args)).toThrow();
  expect(reads).toBe(0);
});

async function runWithQuote(quote: string) {
  const envelope = await buildReviewEnvelope({ ...input(), kind: "reader-review", profile: await builtinReaderProfile("alpha") });
  const attribution = { runId: envelope.requestId, readerId: envelope.profile?.id, readerVersion: envelope.profile?.version };
  return buildReaderRun({ envelope, runId: envelope.requestId, startedAt: stamp, completedAt: stamp,
    output: JSON.stringify({ ...attribution, findings: [{ ...attribution, findingId: "finding-1", category: "clarity",
      claim: "observation", interpretation: "Synthetic impression", evidence: [{ quote }] }] }) });
}

test.each(["\ud800", "\udfff"])("malformed Unicode %j cannot conceal 501 valid quote scalars", async (bad) => {
  for (const quote of [`${bad}${"a".repeat(501)}`, `${"😀".repeat(250)}${bad}${"a".repeat(251)}`, `${"a".repeat(501)}${bad}`]) {
    await expect(runWithQuote(quote)).rejects.toThrow("quote-scalar-limit");
  }
  expect((await runWithQuote(`short${bad}`)).findings[0]?.evidenceState).toBe("insufficient-evidence");
});

describe("injection boundary extensions", () => {
  test("I-19 a forged editor descriptor is never navigation-ready, whatever it claims", async () => {
    const envelope = await buildReviewEnvelope(input());
    const quote = citation();
    const sources = currentSources(envelope);
    const forged = [
      { clean: "yes", identity: quote.identity },
      { clean: 1, identity: quote.identity },
      { clean: true },
      { clean: "true", identity: { ...quote.identity, version: "3" } },
      { clean: true, identity: { ...quote.identity, hash: "b".repeat(64) } },
      { clean: true, identity: { ...quote.identity, chapterId: "ch_654321" } }
    ];
    for (const editor of forged) {
      expect(reviewCitationNavigation(envelope, quote, sources, editor as never).status).not.toBe("ready");
    }
    // The genuine editor still navigates, so the refusals above are about the forgeries, not the harness.
    expect(reviewCitationNavigation(envelope, quote, sources, { clean: true, identity: quote.identity }).status).toBe("ready");
  });

  test("bidi controls and zero-width data are inert data: accepted, counted and round-tripped exactly", async () => {
    const body = "alpha\u202Ebeta\u202C \u200Bgamma \u0435eta";
    const source = captureChapterSource({ sourceId: "source-1", saved: { ...saved, body }, bookTitle: "Synthetic book",
      title: "Synthetic chapter", position: 1, capturedAt: stamp, ranges: [{ start: 0, end: body.length }] });
    const envelope = await buildReviewEnvelope({ ...input(), kind: "reader-review", profile: await builtinReaderProfile("alpha"),
      books: input().books.map((book) => ({ ...book, enabledTools: [] })), sources: [source] });
    expect(source.segments[0]?.text).toBe(body);
    const wire = JSON.parse(serializeProviderRequest(envelope)) as { messages: { role: string; content: string }[] };
    const declared = JSON.parse(wire.messages[1]?.content ?? "") as { sources: [{ segments: [{ text: string }] }] };
    expect(declared.sources[0].segments[0].text).toBe(body);
    const exactQuote = { kind: "chapter" as const, sourceId: "source-1", identity: source.identity, start: 0, end: body.length, quote: body };
    expect(verifyReviewCitation(envelope, exactQuote).status).toBe("verified-captured");
    // A single flipped bidi marker breaks byte equality even though the visible glyphs match.
    const tampered = `${body.slice(0, 6)}X${body.slice(7)}`;
    expect(verifyReviewCitation(envelope, { ...exactQuote, quote: tampered }).status).toBe("invalid");
  });
});
