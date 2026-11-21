import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LibraryService } from "../../src/library/service";
import { chapterPath } from "../../src/library/paths";
import { toLibraryFilePath, toLibraryPath, type LibraryPath } from "../../src/library/path";
import { readSyncJournal } from "../../src/sync/journal";
import { ReviewRecordError } from "../../src/review/record-error";
import {
  applyDispositionEvent, buildCampaignRecord, buildProfileRecord, buildReviewReport,
  campaignBytes, decodeReviewRecord, dispositionsBytes, encodeReviewRecord, newDispositionsRecord,
  profileRecordBytes, reportRecordBytes, REVIEW_RECORD_LIMITS, type CampaignDraft
} from "../../src/review/record-format";
import { canonicalJsonText, decodeStrictJsonBytes, REVIEW_RECORD_BYTES } from "../../src/review/record-json";
import { buildReaderRun, parseReaderOutput, readerCurrentSources, readerSourceState } from "../../src/review/findings";
import { sourceCurrency } from "../../src/review/envelope";
import { captureChapterSource } from "../../src/review/sources";
import { buildReviewEnvelope } from "../../src/review/envelope";
import {
  reportPath, dispositionPath
} from "../../src/review/record-store";
import { builtinReaderProfile } from "../../src/review/profiles";
import {
  afterRun, authorProfile, citationFor, clockAt, makeBook, readerRun, stamp
} from "./record-fixtures";

/**
 * T014 §7 fixture matrix — schema-1 substrate rows. All fixtures are synthetic: no real
 * manuscript, provider, credential or library is touched; the in-memory port is the only disk.
 * Row ids match the memo's §7 table. Matrix rows that need the schema-2 continuation substrate
 * live in continuation-fixtures.test.ts; export rows (E1–E7) are unbuilt and have no tests here.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const runId = "run_00000001";
const at = "2026-11-07T12:11:00.000Z";

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

function flipByte(bytes: Uint8Array, index: number, xor = 0x01): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[index] = (copy[index] ?? 0) ^ xor;
  return copy;
}

async function reportBytesFor(bookId: string, runIdOverride = runId) {
  const run = await readerRun(bookId, runIdOverride);
  const report = await buildReviewReport({
    ownerBookId: bookId, run, savedAt: afterRun, sha256: (text) => Promise.resolve(sha256(text))
  });
  return { report, bytes: reportRecordBytes(report) };
}

function deepEqualCanonical(left: unknown, right: unknown): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

describe("R — round-trip", () => {
  test("R1 — encode→decode→re-encode is byte-identical for all four schema-1 kinds", async () => {
    const { book } = await makeBook();
    const { report, bytes } = await reportBytesFor(book.id);
    const reportRoundTrip = decodeReviewRecord(bytes, { kind: "review-report", bookId: book.id });
    expect(encodeReviewRecord("review-report", reportRoundTrip.raw)).toEqual(bytes);
    expect(reportRoundTrip.bytes).toEqual(bytes);

    const dispositions = applyDispositionEvent(
      newDispositionsRecord({ bookId: book.id, runId, reportHash: sha256(bytes), completedAt: afterRun, at }),
      { findingId: "finding-1", state: "ignored", at }
    ).record;
    const dispositionBytes = dispositionsBytes(dispositions);
    const dispositionsRoundTrip = decodeReviewRecord(dispositionBytes, { kind: "review-dispositions", bookId: book.id });
    expect(encodeReviewRecord("review-dispositions", dispositionsRoundTrip.raw)).toEqual(dispositionBytes);

    const profile = await authorProfile();
    const profileRecord = buildProfileRecord({
      bookId: book.id, profile, revision: 1, base: { kind: "absent", revision: 0 }, createdAt: afterRun, updatedAt: afterRun
    });
    const profileBytes = profileRecordBytes(profileRecord);
    const profileRoundTrip = decodeReviewRecord(profileBytes, { kind: "reader-profile-record", bookId: book.id });
    expect(encodeReviewRecord("reader-profile-record", profileRoundTrip.raw)).toEqual(profileBytes);

    const alpha = await builtinReaderProfile("alpha");
    const draft: CampaignDraft = {
      status: "planned", plannedAt: stamp, sourceBytes: 14,
      profile: { id: alpha.id, version: alpha.version, digest: alpha.digest },
      sources: [{
        sourceId: "source-1", bookId: book.id, chapterId: "ch_123456", title: "Synthetic chapter",
        position: 1, version: 3, hash: "a".repeat(64), planned: [{ start: 0, end: 10 }]
      }],
      stages: [{
        stageId: "stage-1", kind: "range", sourceIds: ["source-1"], planned: [{ start: 0, end: 10 }],
        status: "planned", report: null, at: afterRun
      }],
      synthesis: []
    };
    const campaignRecord = buildCampaignRecord({
      bookId: book.id, id: "campaign-1", revision: 1, base: { kind: "absent", revision: 0 },
      draft, createdAt: afterRun, updatedAt: afterRun
    });
    const campaignRecordBytes = campaignBytes(campaignRecord);
    const campaignRoundTrip = decodeReviewRecord(campaignRecordBytes, { kind: "review-campaign", bookId: book.id });
    expect(encodeReviewRecord("review-campaign", campaignRoundTrip.raw)).toEqual(campaignRecordBytes);
  });

  test("R1 — unknown fields at depth 3, including an own __proto__ data key, survive re-encoding", async () => {
    const { book } = await makeBook();
    const { bytes } = await reportBytesFor(book.id);
    // Build the augmented document via JSON so every added key is an own data property.
    const augmented = JSON.parse(decoder.decode(bytes).replace(/^\{/, `{"futureRoot":{"level2":{"__proto__":{"keep":"proto-own-data"},"depth3":[1,"two",{"__proto__":{"deep":3}}]}},`)) as Record<string, unknown>;
    const reencoded = encodeReviewRecord("review-report", augmented);
    const restored = decodeReviewRecord(reencoded, { kind: "review-report", bookId: book.id });
    const future = restored.raw.futureRoot as Record<string, unknown>;
    const level2 = future?.level2 as Record<string, unknown>;
    const protoDescriptor = Object.getOwnPropertyDescriptor(level2, "__proto__");
    expect(protoDescriptor?.value).toEqual({ keep: "proto-own-data" });
    expect(Object.getPrototypeOf(level2)).toBe(Object.prototype);
    const depth3 = (level2.depth3 as Array<Record<string, unknown>>)[2];
    expect(Object.getOwnPropertyDescriptor(depth3 ?? {}, "__proto__")?.value).toEqual({ deep: 3 });
    // The augmented unknown subtree survives byte-exactly through canonical re-encoding.
    expect(canonicalJsonText(restored.raw.futureRoot)).toBe(canonicalJsonText(augmented.futureRoot));
  });

  test("R2 — key order, whitespace and CRLF variants decode to the same record and re-encode canonically", async () => {
    const { book } = await makeBook();
    const { bytes } = await reportBytesFor(book.id);
    const original = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    const shuffle = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(shuffle);
      if (value === null || typeof value !== "object") return value;
      const entries = Object.entries(value as Record<string, unknown>).reverse();
      return Object.fromEntries(entries.map(([key, child]) => [key, shuffle(child)]));
    };
    const variant = JSON.stringify(shuffle(original), null, "\r\n  ");
    expect(variant).toContain("\r\n");
    const decoded = decodeStrictJsonBytes(encoder.encode(variant));
    expect(deepEqualCanonical(decoded, original)).toBe(true);
    const record = decodeReviewRecord(encoder.encode(variant), { kind: "review-report", bookId: book.id });
    expect(encodeReviewRecord("review-report", record.raw)).toEqual(bytes);
    // A byte-order mark is never accepted.
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
    expect(() => decodeReviewRecord(withBom, { kind: "review-report", bookId: book.id }))
      .toThrow(ReviewRecordError);
    // A semantic change is a different record, never silently canonicalized back.
    const changed = { ...original, savedAt: "2026-11-07T12:30:00.000Z" };
    const changedRecord = decodeReviewRecord(encoder.encode(JSON.stringify(changed)), { kind: "review-report", bookId: book.id });
    expect(changedRecord.record.savedAt).toBe("2026-11-07T12:30:00.000Z");
  });

  test("R3 — zero-finding and fifty-finding reports round-trip; evidenceState re-derives identically", async () => {
    const { book } = await makeBook();
    const probe = await readerRun(book.id, runId);
    const envelope = probe.envelope;
    const profile = envelope.profile;
    if (!profile) throw new Error("Fixture envelope lost its lens");
    const build = (findingCount: number) => {
      const findings = Array.from({ length: findingCount }, (_, index) => ({
        findingId: `finding-${String(index).padStart(3, "0")}`,
        category: "clarity", readerId: profile.id, readerVersion: profile.version, runId,
        interpretation: `Synthetic observation ${index}.`, claim: "observation",
        evidence: Array.from({ length: 8 }, () => ({ ...citationFor(book.id) }))
      }));
      return buildReaderRun({
        runId, startedAt: stamp, completedAt: afterRun, envelope,
        output: JSON.stringify({ runId, readerId: profile.id, readerVersion: profile.version, findings })
      });
    };
    const emptyRun = await build(0);
    const fullRun = await build(50);
    for (const [run, expectedFindings] of [[emptyRun, 0], [fullRun, 50]] as const) {
      const report = await buildReviewReport({
        ownerBookId: book.id, run, savedAt: afterRun, sha256: (text) => Promise.resolve(sha256(text))
      });
      expect(report.findings).toHaveLength(expectedFindings);
      const bytes = reportRecordBytes(report);
      const decoded = decodeReviewRecord(bytes, { kind: "review-report", bookId: book.id });
      expect(encodeReviewRecord("review-report", decoded.raw)).toEqual(bytes);
      // evidenceState is re-derived, never stored: decode yields the same states as a rebuild.
      const rebuilt = await buildReviewReport({
        ownerBookId: book.id, run, savedAt: afterRun, sha256: (text) => Promise.resolve(sha256(text))
      });
      expect(rebuilt.findings.map((finding) => finding.evidenceState))
        .toEqual(decoded.record.findings.map((finding) => finding.evidenceState));
      if (expectedFindings === 50) {
        expect(decoded.record.findings.every((finding) => finding.evidenceState === "complete")).toBe(true);
        expect(decoded.record.findings.every((finding) => finding.evidence.length === 8)).toBe(true);
      }
    }
  });
});

describe("C — corruption", () => {
  test("C1 — flipped byte, truncation and garbage tail are corrupt; the file is untouched and the message carries no content", async () => {
    const { library, book, port } = await makeBook();
    const { bytes } = await reportBytesFor(book.id);
    const marker = "Selected"; // distinctive content that must never appear in an error message

    // One flipped byte inside the id field: the record no longer satisfies its own identity rules.
    const idNeedle = encoder.encode('"id":"run_00000001"');
    const idAt = bytes.findIndex((_, index) => bytes.subarray(index, index + idNeedle.length).join() === idNeedle.join());
    expect(idAt).toBeGreaterThan(-1);
    const flipped = flipByte(bytes, idAt + 6, 0x01); // mangle a character inside the id itself
    await port.commitFile(reportPath(book.id, runId), flipped, { kind: "any" });
    let caught: unknown;
    try {
      await library.reviewRecords.readReport(book.id, runId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReviewRecordError);
    expect((caught as ReviewRecordError).code).toBe("corrupt");
    expect((caught as ReviewRecordError).message).not.toContain(marker);
    expect((caught as ReviewRecordError).message).not.toContain("run_00000001");
    // The store never repairs or deletes: the exact flipped bytes are still on disk.
    expect((await port.readFile(reportPath(book.id, runId)))?.bytes).toEqual(flipped);
    // The list view names the file (never the content) and reports the stable code.
    const listing = await library.reviewRecords.listReports(book.id);
    expect(listing.reports).toHaveLength(0);
    expect(listing.issues).toEqual([
      { fileName: `${runId}.json`, code: "corrupt", message: expect.any(String) as unknown as string }
    ]);
    expect(listing.issues[0]?.message).not.toContain(marker);

    // Truncation at 40% and trailing garbage both refuse, leaving the file alone.
    for (const damaged of [bytes.subarray(0, Math.floor(bytes.byteLength * 0.4)),
      new Uint8Array([...bytes, 0x20, 0x7b, 0x7d])]) {
      await port.commitFile(reportPath(book.id, runId), damaged, { kind: "any" });
      await expect(library.reviewRecords.readReport(book.id, runId)).rejects.toMatchObject({ code: "corrupt" });
      expect((await port.readFile(reportPath(book.id, runId)))?.bytes).toEqual(damaged);
    }
    await port.commitFile(reportPath(book.id, runId), bytes, { kind: "any" });
    await expect(library.reviewRecords.readReport(book.id, runId)).resolves.not.toBeNull();
  });

  test("C2 — duplicate key, lone surrogate, -0, 1e999 and depth 65 refuse; accessor/sparse/__proto__-setter refuse at encode", () => {
    const decode = (bytes: Uint8Array) => () =>
      decodeReviewRecord(bytes, { kind: "review-report", bookId: "book_123456" });
    const corrupt = (source: string) => expect(decode(encoder.encode(source))).toThrow(ReviewRecordError);
    // Duplicate key: never silently chooses one value.
    try {
      decode(encoder.encode('{"schemaVersion":1,"schemaVersion":2}'))();
      throw new Error("duplicate key was accepted");
    } catch (error) {
      expect((error as ReviewRecordError).code).toBe("corrupt");
    }
    corrupt('{"schemaVersion":1,"a":"\\uD800"}'); // lone surrogate escape
    corrupt('{"schemaVersion":1,"a":-0}');        // negative zero loses information
    corrupt('{"schemaVersion":1,"a":1e999}');     // beyond the safe-integer ceiling
    const tooDeep = `${"[".repeat(65)}1${"]".repeat(65)}`;
    try {
      decode(encoder.encode(tooDeep))();
      throw new Error("depth 65 was accepted");
    } catch (error) {
      expect((error as ReviewRecordError).code).toBe("corrupt");
    }
    // Encode side: hostile object shapes are refused, never written.
    const sparse: unknown[] = new Array(3);
    expect(() => encodeReviewRecord("review-report", sparse as never)).toThrow(ReviewRecordError);
    let getterRan = false;
    const accessor = Object.defineProperty({}, "trap", {
      enumerable: true,
      get() { getterRan = true; return 1; }
    });
    expect(() => encodeReviewRecord("review-report", accessor as never)).toThrow(ReviewRecordError);
    expect(getterRan).toBe(false);
    let setterRan = false;
    const protoSetter = Object.defineProperty({}, "__proto__", {
      enumerable: true,
      set() { setterRan = true; }
    });
    expect(() => encodeReviewRecord("review-report", protoSetter as never)).toThrow(ReviewRecordError);
    expect(setterRan).toBe(false);
  });

  test("C3 — valid JSON with the wrong kind at a reviews path is corrupt, never reinterpreted", async () => {
    const { library, book, port } = await makeBook();
    const { bytes } = await reportBytesFor(book.id);
    expect(() => decodeReviewRecord(bytes, { kind: "review-dispositions", bookId: book.id }))
      .toThrow(ReviewRecordError);
    // A dispositions document sitting at the report path is not a report.
    const dispositions = applyDispositionEvent(
      newDispositionsRecord({ bookId: book.id, runId, reportHash: sha256(bytes), completedAt: afterRun, at }),
      { findingId: "finding-1", state: "ignored", at }
    ).record;
    await port.commitFile(reportPath(book.id, runId), dispositionsBytes(dispositions), { kind: "any" });
    await expect(library.reviewRecords.readReport(book.id, runId)).rejects.toMatchObject({ code: "corrupt" });
    // And the report bytes at the dispositions path are not dispositions either.
    await port.commitFile(dispositionPath(book.id, runId), bytes, { kind: "any" });
    await expect(library.reviewRecords.readDispositions(book.id, runId)).rejects.toMatchObject({ code: "corrupt" });
    expect((await port.readFile(reportPath(book.id, runId)))?.bytes).toEqual(dispositionsBytes(dispositions));
    expect((await port.readFile(dispositionPath(book.id, runId)))?.bytes).toEqual(bytes);
  });

  test("C4 — a document over the byte cap and over-limit collections refuse; nothing is written", async () => {
    const { library, book, port } = await makeBook();
    const oversized = new Uint8Array(REVIEW_RECORD_LIMITS.bytes + 1).fill(0x20);
    try {
      decodeStrictJsonBytes(oversized);
      throw new Error("an over-cap document was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewRecordError);
      expect((error as ReviewRecordError).code).toBe("too-large");
    }
    // The store applies the same cap to a file it finds on disk.
    await port.commitFile(reportPath(book.id, runId), oversized, { kind: "any" });
    await expect(library.reviewRecords.readReport(book.id, runId)).rejects.toMatchObject({ code: "too-large" });
    expect((await port.readFile(reportPath(book.id, runId)))?.bytes.byteLength).toBe(REVIEW_RECORD_LIMITS.bytes + 1);
    await port.commitFile(reportPath(book.id, runId), encoder.encode("{}"), { kind: "any" });

    const { bytes } = await reportBytesFor(book.id);
    const raw = JSON.parse(decoder.decode(bytes)) as {
      findings: Array<Record<string, unknown> & { evidence: unknown[] }>;
    };
    const finding = raw.findings[0];
    if (!finding) throw new Error("fixture report has no finding");
    // Nine evidence entries (the ceiling is eight).
    const nine = { ...finding, evidence: Array.from({ length: 9 }, () => finding.evidence[0]) };
    const withNine = { ...raw, findings: [nine] };
    expect(() => decodeReviewRecord(encoder.encode(JSON.stringify(withNine)), { kind: "review-report", bookId: book.id }))
      .toThrow(ReviewRecordError);
    // Fifty-one findings (the ceiling is fifty).
    const fiftyOne = Array.from({ length: 51 }, (_, index) => ({ ...finding, findingId: `finding-${index}` }));
    expect(() => decodeReviewRecord(encoder.encode(JSON.stringify({ ...raw, findings: fiftyOne })), { kind: "review-report", bookId: book.id }))
      .toThrow(ReviewRecordError);
    // A 501-scalar quote (the ceiling is 500).
    const longQuote = {
      ...finding,
      evidence: [{
        ...(finding.evidence[0] as Record<string, unknown>),
        citation: {
          ...((finding.evidence[0] as { citation: Record<string, unknown> }).citation),
          start: 0, end: 501, quote: "q".repeat(501)
        }
      }]
    };
    expect(() => decodeReviewRecord(encoder.encode(JSON.stringify({ ...raw, findings: [longQuote] })), { kind: "review-report", bookId: book.id }))
      .toThrow(ReviewRecordError);
    // The volatile boundary refuses the same overages before any record exists at all.
    const cleanFinding = {
      findingId: "bad-0", category: "clarity", readerId: "reader-alpha", readerVersion: 1, runId,
      interpretation: "Synthetic observation.", subjective: true, claim: "observation", evidence: []
    };
    const badRun = JSON.stringify({
      runId, readerId: "reader-alpha", readerVersion: 1,
      findings: Array.from({ length: 51 }, (_, index) => ({ ...cleanFinding, findingId: `bad-${index}` }))
    });
    expect(() => parseReaderOutput(badRun)).toThrow();
  });

  test("C5 — schemaVersion 2 is newer-schema; an unknown closed-union member is unsupported; files stay untouched", async () => {
    const { library, book, port } = await makeBook();
    const { bytes } = await reportBytesFor(book.id);
    const newer = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    newer.schemaVersion = 2;
    const newerBytes = encoder.encode(JSON.stringify(newer));
    await port.commitFile(reportPath(book.id, runId), newerBytes, { kind: "any" });
    await expect(library.reviewRecords.readReport(book.id, runId)).rejects.toMatchObject({ code: "newer-schema" });
    expect((await port.readFile(reportPath(book.id, runId)))?.bytes).toEqual(newerBytes);

    const wrongUnion = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    (wrongUnion.findings as Array<Record<string, unknown>>)[0]!.category = "not-a-category";
    const unionBytes = encoder.encode(JSON.stringify(wrongUnion));
    await port.commitFile(reportPath(book.id, runId), unionBytes, { kind: "any" });
    await expect(library.reviewRecords.readReport(book.id, runId)).rejects.toMatchObject({ code: "unsupported" });
    expect((await port.readFile(reportPath(book.id, runId)))?.bytes).toEqual(unionBytes);
  });

  test("C6 — a foreign owner, a base-carrying report and hash-mismatched dispositions all refuse; nothing is written", async () => {
    const { library, book, port } = await makeBook();
    const other = await library.createBook({ title: "Synthetic other book" });
    const { bytes } = await reportBytesFor(book.id);
    // Foreign owner: a report minted for book A parked at book B's path.
    const reportBytes = bytes;
    await port.commitFile(reportPath(other.id, runId), reportBytes, { kind: "any" });
    await expect(library.reviewRecords.readReport(other.id, runId)).rejects.toMatchObject({ code: "corrupt" });
    expect((await port.readFile(reportPath(other.id, runId)))?.bytes).toEqual(reportBytes);
    // A report carrying a base is not a report; nothing was rewritten.
    const withBase = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    withBase.base = { kind: "absent", revision: 0 };
    const withBaseBytes = encoder.encode(JSON.stringify(withBase));
    await port.commitFile(reportPath(book.id, runId), withBaseBytes, { kind: "any" });
    await expect(library.reviewRecords.readReport(book.id, runId)).rejects.toMatchObject({ code: "corrupt" });
    expect((await port.readFile(reportPath(book.id, runId)))?.bytes).toEqual(withBaseBytes);
    // Dispositions that name a different report hash refuse to advance; prior history is untouched.
    await port.commitFile(reportPath(book.id, runId), bytes, { kind: "any" });
    const first = await library.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "ignored" });
    const dispositionsPath = dispositionPath(book.id, runId);
    const beforeDispositions = (await port.readFile(dispositionsPath))?.bytes;
    expect(first.status).toBe("saved");
    // The report file is replaced out of band with a different revision of the same run.
    const otherSavedAt = "2026-11-07T13:00:00.000Z";
    const run = await readerRun(book.id, runId);
    const replacement = await buildReviewReport({
      ownerBookId: book.id, run, savedAt: otherSavedAt, sha256: (text) => Promise.resolve(sha256(text))
    });
    const replacementBytes = reportRecordBytes(replacement);
    expect(replacementBytes).not.toEqual(bytes);
    await port.commitFile(reportPath(book.id, runId), replacementBytes, { kind: "any" });
    await expect(library.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "author-resolved" }))
      .rejects.toMatchObject({ code: "invalid" });
    expect((await port.readFile(dispositionsPath))?.bytes).toEqual(beforeDispositions);
  });
});

describe("M2 — unknown plain fields survive read-modify-write", () => {
  test("M2 — depth-3 unknown fields including an own __proto__ data key survive a disposition save byte-exactly", async () => {
    const { library, book, port } = await makeBook(clockAt(afterRun));
    await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    await library.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "ignored" });
    const path = dispositionPath(book.id, runId);
    const original = JSON.parse(decoder.decode((await port.readFile(path))?.bytes)) as Record<string, unknown>;
    const injected = JSON.parse(
      '{"level2":{"__proto__":{"keep":"own data property"},"list":[1,"two",{"deep":true,"__proto__":{"deeper":3}}]}}'
    ) as Record<string, unknown>;
    const seeded = { ...original, future: injected };
    await port.commitFile(path, encoder.encode(JSON.stringify(seeded)), { kind: "any" });
    await library.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "author-resolved" });
    const reread = JSON.parse(decoder.decode((await port.readFile(path))?.bytes)) as Record<string, unknown>;
    const level2 = (reread.future as Record<string, unknown>).level2 as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(level2, "__proto__")?.value).toEqual({ keep: "own data property" });
    const deep = (level2.list as Array<Record<string, unknown>>)[2]!;
    expect(Object.getOwnPropertyDescriptor(deep, "__proto__")?.value).toEqual({ deeper: 3 });
    expect(Object.getPrototypeOf(level2)).toBe(Object.prototype);
    // Byte-exact survival of the unknown subtree across the write.
    expect(canonicalJsonText((reread.future as Record<string, unknown>))).toBe(canonicalJsonText(injected));
    const entries = reread.dispositions as Array<{ state: string; events: Array<{ action: string }> }>;
    expect(entries[0]?.state).toBe("author-resolved");
    expect(entries[0]?.events.map((event) => event.action)).toEqual(["ignore", "resolve"]);
  });
});

describe("X — collisions and idempotence", () => {
  test("X1 — identical re-save is an unchanged read; bytes and mtime untouched", async () => {
    const clock = clockAt(afterRun);
    const { library, book, port } = await makeBook(clock);
    const run = await readerRun(book.id);
    const first = await library.reviewRecords.createReport(book.id, run);
    expect(first.status).toBe("created");
    const before = await port.stat(reportPath(book.id, runId));
    clock.value = at;
    const again = await library.reviewRecords.createReport(book.id, run);
    expect(again.status).toBe("unchanged");
    expect(again.report.hash).toBe(first.report.hash);
    const after = await port.stat(reportPath(book.id, runId));
    expect(after?.modifiedAt).toBe(before?.modifiedAt);
    expect((await port.listDirectory(toLibraryPath(["books", book.id, "conflicts"])))).toHaveLength(0);
  });

  test("X2 — different bytes at the same id keep the active file; conflict copy names itself and is not readable as active", async () => {
    const { library, book, port } = await makeBook();
    const { bytes } = await reportBytesFor(book.id);
    const squatted = flipByte(bytes, Math.floor(bytes.length / 2));
    await port.commitFile(reportPath(book.id, runId), squatted, { kind: "any" });
    let caught: unknown;
    try {
      await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReviewRecordError);
    expect((caught as ReviewRecordError).code).toBe("conflict");
    const savedAs = (caught as ReviewRecordError).savedAs ?? "";
    expect(savedAs).toMatch(new RegExp(`^books/${book.id}/conflicts/review-report\\.${runId}\\.conflict-external-edit\\.`));
    expect(savedAs.endsWith(".json")).toBe(true);
    // The active file still holds the squatter's bytes.
    expect((await port.readFile(reportPath(book.id, runId)))?.bytes).toEqual(squatted);
    // The copy carries conflict metadata and cannot be read as an active record.
    const copy = await port.readFile(toLibraryFilePath(savedAs.split("/")));
    expect(copy).not.toBeNull();
    const decoded = decodeReviewRecord(copy!.bytes, { kind: "review-report", bookId: book.id, allowConflictMetadata: true });
    expect(decoded.raw.conflictMetadata).toMatchObject({ reason: "external-edit", observed: { kind: "sha256" } });
    expect(() => decodeReviewRecord(copy!.bytes, { kind: "review-report", bookId: book.id }))
      .toThrow(ReviewRecordError);
  });

  test("X3 — an over-long id uses a hashed stem of at most 200 bytes, and 100 occupied names yield not-kept, never an overwrite", async () => {
    const longId = `run_${"a".repeat(187)}`;
    const clock = clockAt(afterRun);
    const { library, book, port } = await makeBook(clock);
    const longRun = await readerRun(book.id, longId);
    await library.reviewRecords.createReport(book.id, longRun);
    const squatter = encoder.encode("{}");
    await port.commitFile(reportPath(book.id, longId), squatter, { kind: "any" });
    let savedAs = "";
    try {
      await library.reviewRecords.createReport(book.id, longRun);
      throw new Error("A differing long-id report was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewRecordError);
      expect((error as ReviewRecordError).code).toBe("conflict");
      savedAs = (error as ReviewRecordError).savedAs ?? "";
    }
    const name = savedAs.split("/").pop() ?? "";
    expect(encoder.encode(name).byteLength).toBeLessThanOrEqual(200);
    const expectedStem = `review-report.conflict-external-edit.${createHash("sha256").update(longId).digest("hex").slice(0, 12)}`;
    expect(name).toBe(`${expectedStem}.json`);

    // Occupy every name the allocator may try (attempts 0..99), then the next conflict must not-keep.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      await port.commitFile(
        toLibraryFilePath(["books", book.id, "conflicts", `${expectedStem}${suffix}.json`]),
        squatter, { kind: "any" }
      );
    }
    await expect(library.reviewRecords.createReport(book.id, longRun))
      .rejects.toMatchObject({ code: "not-kept" });
    expect(decoder.decode((await port.readFile(reportPath(book.id, longId)))?.bytes)).toBe("{}");
    expect((await port.listDirectory(toLibraryPath(["books", book.id, "conflicts"]))).length).toBe(100);
  });

  test("X4 — a stale disposition base keeps the intended history as a conflict copy", async () => {
    const { library, book, port } = await makeBook(clockAt(afterRun));
    await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    await library.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "ignored" });
    const rev1Bytes = (await port.readFile(dispositionPath(book.id, runId)))?.bytes;
    if (!rev1Bytes) throw new Error("Missing revision 1");
    const rev1Hash = sha256(rev1Bytes);
    const rev1RawJson = decoder.decode(rev1Bytes);
    const reportFile = await port.readFile(reportPath(book.id, runId));
    if (!reportFile) throw new Error("Missing report");
    // Advance history out of band to revision 2.
    await library.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "open" });
    const rev2Bytes = (await port.readFile(dispositionPath(book.id, runId)))?.bytes;
    // A checked write prepared against revision 1 fires against the revision-2 file.
    const intent = {
      report: { hash: reportFile.sha256, rawJson: decoder.decode(reportFile.bytes) },
      base: { kind: "sha256" as const, value: rev1Hash, revision: 1, rawJson: rev1RawJson },
      findingId: "finding-1",
      state: "author-resolved" as const
    };
    let savedAs = "";
    try {
      await library.reviewRecords.recordDispositionChecked(book.id, runId, intent);
      throw new Error("A stale base was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewRecordError);
      expect((error as ReviewRecordError).code).toBe("conflict");
      savedAs = (error as ReviewRecordError).savedAs ?? "";
    }
    // The intended history is preserved verbatim in the conflict copy.
    const copy = await port.readFile(toLibraryFilePath(savedAs.split("/")));
    expect(copy).not.toBeNull();
    const decoded = decodeReviewRecord(copy!.bytes, { kind: "review-dispositions", bookId: book.id, allowConflictMetadata: true });
    expect(decoded.raw.conflictMetadata).toMatchObject({ reason: "external-edit", baseline: { kind: "sha256", revision: 1 } });
    expect(decoded.record.dispositions[0]?.events.map((event) => event.action)).toEqual(["ignore", "resolve"]);
    // The active file is untouched by the refused write.
    expect((await port.readFile(dispositionPath(book.id, runId)))?.bytes).toEqual(rev2Bytes);
    expect((await port.readFile(reportPath(book.id, runId)))?.bytes).toEqual(reportFile.bytes);
  });

  test("X4 — a report replaced after inspection is refused and the intended history is kept", async () => {
    const { library, book, port } = await makeBook(clockAt(afterRun));
    await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    const reportFile = await port.readFile(reportPath(book.id, runId));
    if (!reportFile) throw new Error("Missing report");
    // The inspection happened against this exact revision of the report.
    const intent = {
      report: { hash: reportFile.sha256, rawJson: decoder.decode(reportFile.bytes) },
      base: { kind: "absent" as const },
      findingId: "finding-1",
      state: "ignored" as const,
      note: "kept verbatim"
    };
    // The report is replaced out of band before the checked write lands.
    const run = await readerRun(book.id, runId);
    const replacement = await buildReviewReport({
      ownerBookId: book.id, run, savedAt: at, sha256: (text) => Promise.resolve(sha256(text))
    });
    const replacementBytes = reportRecordBytes(replacement);
    await port.commitFile(reportPath(book.id, runId), replacementBytes, { kind: "any" });
    let savedAs = "";
    try {
      await library.reviewRecords.recordDispositionChecked(book.id, runId, intent);
      throw new Error("A stale report was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewRecordError);
      expect((error as ReviewRecordError).code).toBe("conflict");
      savedAs = (error as ReviewRecordError).savedAs ?? "";
    }
    // Intended history is kept as a conflict copy; nothing was written to the active paths.
    const copy = await port.readFile(toLibraryFilePath(savedAs.split("/")));
    const decoded = decodeReviewRecord(copy!.bytes, { kind: "review-dispositions", bookId: book.id, allowConflictMetadata: true });
    expect(decoded.record.dispositions[0]?.events[0]?.note).toBe("kept verbatim");
    expect(decoded.record.dispositions[0]?.events[0]?.action).toBe("ignore");
    expect(await port.readFile(dispositionPath(book.id, runId))).toBeNull();
    expect((await port.readFile(reportPath(book.id, runId)))?.bytes).toEqual(replacementBytes);
  });

  test("X6 — save → trash → restore → save yields stable bytes and no conflict copies", async () => {
    const clock = clockAt(afterRun);
    const { library, book, port } = await makeBook(clock);
    const run = await readerRun(book.id);
    const first = await library.reviewRecords.createReport(book.id, run);
    const originalHash = first.report.hash;
    const trashed = await library.reviewRecords.trashReport(book.id, runId);
    if (trashed.status !== "trashed") throw new Error("Expected trash");
    clock.value = at;
    const restored = await library.reviewRecords.restoreReport(book.id, runId, trashed.trashedAt);
    expect(restored.report?.hash).toBe(originalHash);
    clock.value = "2026-11-07T12:30:00.000Z";
    const again = await library.reviewRecords.createReport(book.id, run);
    expect(again.status).toBe("unchanged");
    expect(again.report.hash).toBe(originalHash);
    expect((await port.listDirectory(toLibraryPath(["books", book.id, "conflicts"])))).toHaveLength(0);
  });

  test("X7 — two host queues on one library: bytes never tear; outcomes stay within conflict/unchanged", async () => {
    const { port, book } = await makeBook(clockAt(afterRun));
    const run = await readerRun(book.id);
    const first = await LibraryService.open({ storage: port, runtime: port });
    const second = await LibraryService.open({ storage: port, runtime: port });
    await first.reviewRecords.createReport(book.id, run);
    const results = await Promise.allSettled([
      first.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "ignored", note: "first" }),
      second.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "author-resolved", note: "second" })
    ]);
    const saved = results.filter((r) => r.status === "fulfilled").length;
    expect(saved).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect((result.reason as ReviewRecordError).code).toBe("conflict");
      }
    }
    // The surviving file always decodes, with dense, causally-linked events.
    const finalBytes = (await port.readFile(dispositionPath(book.id, runId)))?.bytes;
    expect(finalBytes).toBeDefined();
    const decoded = decodeReviewRecord(finalBytes!, { kind: "review-dispositions", bookId: book.id });
    const events = decoded.record.dispositions[0]?.events ?? [];
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]?.from).toBe(events[index - 1]?.to);
    }
    // At most one conflict copy may exist, and it must decode with conflict metadata.
    const conflicts = await port.listDirectory(toLibraryPath(["books", book.id, "conflicts"]));
    expect(conflicts.length).toBeLessThanOrEqual(1);
    for (const entry of conflicts) {
      const copy = await port.readFile(toLibraryFilePath(["books", book.id, "conflicts", entry.name]));
      const copyDecoded = decodeReviewRecord(copy!.bytes, { kind: "review-dispositions", bookId: book.id, allowConflictMetadata: true });
      expect(copyDecoded.raw.conflictMetadata).toMatchObject({ reason: "external-edit" });
    }
  });
});

describe("S — recovery", () => {
  test("S1 — trash and restore a report+dispositions group; bytes match and the journal notes the moves", async () => {
    const clock = clockAt(afterRun);
    const { library, book, port } = await makeBook(clock);
    await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    clock.value = at;
    await library.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "ignored" });
    const reportHash = (await library.reviewRecords.readReport(book.id, runId))?.hash;
    const dispositionsHash = (await library.reviewRecords.readDispositions(book.id, runId))?.hash;
    const reportBytes = (await port.readFile(reportPath(book.id, runId)))?.bytes;
    const dispositionsBytesBefore = (await port.readFile(dispositionPath(book.id, runId)))?.bytes;
    const trashed = await library.reviewRecords.trashReport(book.id, runId);
    if (trashed.status !== "trashed") throw new Error("Expected a trashed group");
    expect(await port.readFile(reportPath(book.id, runId))).toBeNull();
    expect(await port.readFile(dispositionPath(book.id, runId))).toBeNull();
    const restored = await library.reviewRecords.restoreReport(book.id, runId, trashed.trashedAt);
    expect(restored.report?.hash).toBe(reportHash);
    expect(restored.dispositions?.hash).toBe(dispositionsHash);
    expect((await port.readFile(reportPath(book.id, runId)))?.bytes).toEqual(reportBytes);
    expect((await port.readFile(dispositionPath(book.id, runId)))?.bytes).toEqual(dispositionsBytesBefore);
    const journal = await readSyncJournal(port, "device_fixture01");
    const reportPathKey = `books/${book.id}/reviews/${runId}.json`;
    const dispositionsPathKey = `books/${book.id}/reviews/dispositions/${runId}.json`;
    expect(journal?.files[reportPathKey]?.sha256).toBe(reportHash);
    expect(journal?.files[dispositionsPathKey]?.sha256).toBe(dispositionsHash);
    const trashPrefix = trashed.trashedAt;
    expect(journal?.files[`${trashPrefix}/${runId}.json`]?.deleted).toBe(true);
    expect(journal?.files[`${trashPrefix}/dispositions/${runId}.json`]?.deleted).toBe(true);
  });

  test("S2 — restore refuses when a destination is occupied; both sides are untouched", async () => {
    const clock = clockAt(afterRun);
    const { library, book, port } = await makeBook(clock);
    await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    clock.value = at;
    await library.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "ignored" });
    const trashed = await library.reviewRecords.trashReport(book.id, runId);
    if (trashed.status !== "trashed") throw new Error("Expected trash");
    await port.commitFile(reportPath(book.id, runId), encoder.encode("occupant"), { kind: "absent" });
    await port.commitFile(dispositionPath(book.id, runId), encoder.encode("occupant"), { kind: "absent" });
    await expect(library.reviewRecords.restoreReport(book.id, runId, trashed.trashedAt))
      .rejects.toMatchObject({ code: "exists" });
    expect(decoder.decode((await port.readFile(reportPath(book.id, runId)))?.bytes)).toBe("occupant");
    expect(decoder.decode((await port.readFile(dispositionPath(book.id, runId)))?.bytes)).toBe("occupant");
    // The trash keeps both members; neither was moved.
    const group = trashed.trashedAt.split("/");
    expect((await port.readFile(toLibraryFilePath([...group, `${runId}.json`])))).not.toBeNull();
    expect((await port.readFile(toLibraryFilePath([...group, "dispositions", `${runId}.json`])))).not.toBeNull();
  });

  test("S3 — a trashed dispositions document with its report deleted cannot restore alone; report-only restore works", async () => {
    const clock = clockAt(afterRun);
    const { library, book, port } = await makeBook(clock);
    await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    await library.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "ignored" });
    const trashed = await library.reviewRecords.trashReport(book.id, runId);
    if (trashed.status !== "trashed") throw new Error("Expected trash");
    const group = trashed.trashedAt.split("/");
    const trashedReport = toLibraryFilePath([...group, `${runId}.json`]);
    const trashedDispositions = toLibraryFilePath([...group, "dispositions", `${runId}.json`]);
    // The report disappears from the trash out of band.
    await port.removeFile(trashedReport);
    await expect(library.reviewRecords.restoreReport(book.id, runId, trashed.trashedAt))
      .rejects.toMatchObject({ code: "not-found" });
    // Nothing merged anywhere: the dispositions stay in trash, both live paths stay absent.
    expect((await port.readFile(trashedDispositions))).not.toBeNull();
    expect(await port.readFile(reportPath(book.id, runId))).toBeNull();
    expect(await port.readFile(dispositionPath(book.id, runId))).toBeNull();
    // A report-only group (no dispositions anywhere) restores normally.
    const lone = await library.reviewRecords.createReport(book.id, await readerRun(book.id, "run_00000002"));
    expect(lone.status).toBe("created");
    const loneTrash = await library.reviewRecords.trashReport(book.id, "run_00000002");
    if (loneTrash.status !== "trashed") throw new Error("Expected trash");
    const loneRestore = await library.reviewRecords.restoreReport(book.id, "run_00000002", loneTrash.trashedAt);
    expect(loneRestore.report?.hash).toBe(lone.report.hash);
    expect(loneRestore.dispositions).toBeNull();
  });

  test("S4 — a corrupted member makes the group unreadable; no move is attempted", async () => {
    const clock = clockAt(afterRun);
    const { library, book, port } = await makeBook(clock);
    await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    await library.reviewRecords.recordDisposition(book.id, runId, { findingId: "finding-1", state: "ignored" });
    const trashed = await library.reviewRecords.trashReport(book.id, runId);
    if (trashed.status !== "trashed") throw new Error("Expected trash");
    const group = trashed.trashedAt.split("/");
    const groupId = group[group.length - 1] as string;
    // Capture a valid inspection first, then corrupt the report inside the group.
    const inspection = await library.reviewRecords.inspectTrashGroup(book.id, groupId);
    const trashedReport = toLibraryFilePath([...group, `${runId}.json`]);
    await port.commitFile(trashedReport, encoder.encode("{ definitely not json"), { kind: "any" });
    await expect(library.reviewRecords.inspectTrashGroup(book.id, groupId)).rejects.toMatchObject({ code: "corrupt" });
    await expect(library.reviewRecords.restoreReport(book.id, runId, trashed.trashedAt))
      .rejects.toMatchObject({ code: "corrupt" });
    await expect(library.reviewRecords.moveInspectedGroup(book.id, {
      id: inspection.id, groupId: inspection.groupId, hash: inspection.hash, token: inspection.token
    })).rejects.toMatchObject({ code: "corrupt" });
    // Neither member moved; nothing was merged or cleaned up.
    expect((await port.readFile(trashedReport))).not.toBeNull();
    expect((await port.readFile(toLibraryFilePath([...group, "dispositions", `${runId}.json`])))).not.toBeNull();
    expect(await port.readFile(reportPath(book.id, runId))).toBeNull();
    expect(await port.readFile(dispositionPath(book.id, runId))).toBeNull();
  });

  test("S5 — an inspection token is single-use and unforgeable; a stale one cannot move anything", async () => {
    const clock = clockAt(afterRun);
    const { library, book, port } = await makeBook(clock);
    await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    const trashed = await library.reviewRecords.trashReport(book.id, runId);
    if (trashed.status !== "trashed") throw new Error("Expected trash");
    const groupId = trashed.trashedAt.split("/").pop() ?? "";
    // Any move attempt consumes the token — even a refused one — so a forged or stale one cannot succeed.
    const first = await library.reviewRecords.inspectTrashGroup(book.id, groupId);
    await expect(library.reviewRecords.moveInspectedGroup(book.id, {
      id: first.id, groupId: first.groupId, hash: "0".repeat(64), token: first.token
    })).rejects.toMatchObject({ code: "invalid" });
    // The same token, presented correctly afterwards, is already spent.
    await expect(library.reviewRecords.moveInspectedGroup(book.id, {
      id: first.id, groupId: first.groupId, hash: first.hash, token: first.token
    })).rejects.toMatchObject({ code: "invalid" });
    // An invented token mints nothing.
    const second = await library.reviewRecords.inspectTrashGroup(book.id, groupId);
    await expect(library.reviewRecords.moveInspectedGroup(book.id, {
      id: second.id, groupId: second.groupId, hash: second.hash, token: "review_00000000"
    })).rejects.toMatchObject({ code: "invalid" });
    expect((await port.readFile(toLibraryFilePath([...trashed.trashedAt.split("/"), `${runId}.json`])))).not.toBeNull();
    // A fresh inspection with the untouched token restores the group exactly once.
    const restored = await library.reviewRecords.moveInspectedGroup(book.id, {
      id: second.id, groupId: second.groupId, hash: second.hash, token: second.token
    });
    expect(restored.status).toBe("restored");
    await expect(library.reviewRecords.moveInspectedGroup(book.id, {
      id: second.id, groupId: second.groupId, hash: second.hash, token: second.token
    })).rejects.toMatchObject({ code: "invalid" });
    // A fresh inspection cannot authorize a move after the group changed underneath it.
    const secondTrash = await library.reviewRecords.trashReport(book.id, runId);
    if (secondTrash.status !== "trashed") throw new Error("Expected trash");
    const secondGroupId = secondTrash.trashedAt.split("/").pop() ?? "";
    const inspection2 = await library.reviewRecords.inspectTrashGroup(book.id, secondGroupId);
    const moved = toLibraryFilePath([...secondTrash.trashedAt.split("/"), `${runId}.json`]);
    expect(await port.readFile(moved)).not.toBeNull();
    await port.commitFile(moved, encoder.encode("{ not json either"), { kind: "any" });
    await expect(library.reviewRecords.moveInspectedGroup(book.id, {
      id: inspection2.id, groupId: inspection2.groupId, hash: inspection2.hash, token: inspection2.token
    })).rejects.toMatchObject({ code: "corrupt" });
    expect(await port.readFile(reportPath(book.id, runId))).toBeNull();
  });
});

describe("V — validity ladder", () => {
  test("V1 — one fixture per §5.1 outcome, each with exactly its specified code", async () => {
    const { library, book, port } = await makeBook();
    const { bytes } = await reportBytesFor(book.id);

    // valid: a well-formed record decodes and carries its kind.
    const ok = decodeReviewRecord(bytes, { kind: "review-report", bookId: book.id });
    expect(ok.record.kind).toBe("review-report");

    // too-large: the ceiling fires before parsing.
    try {
      decodeStrictJsonBytes(new Uint8Array(REVIEW_RECORD_BYTES + 1).fill(0x20));
      throw new Error("over-cap document accepted");
    } catch (error) {
      expect((error as ReviewRecordError).code).toBe("too-large");
    }

    // corrupt: unparseable bytes are refused, never repaired.
    try {
      decodeReviewRecord(bytes.subarray(0, Math.floor(bytes.length / 2)), { kind: "review-report", bookId: book.id });
      throw new Error("truncated record accepted");
    } catch (error) {
      expect((error as ReviewRecordError).code).toBe("corrupt");
    }

    // invalid: caller input that is not a valid book id is refused before any read.
    try {
      decodeReviewRecord(bytes, { kind: "review-report", bookId: "not a book id" });
      throw new Error("invalid book id accepted");
    } catch (error) {
      expect((error as ReviewRecordError).code).toBe("invalid");
    }

    // newer-schema: a higher schemaVersion is never read by this build.
    const newer = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    newer.schemaVersion = 2;
    await port.commitFile(reportPath(book.id, runId), encoder.encode(JSON.stringify(newer)), { kind: "any" });
    await expect(library.reviewRecords.readReport(book.id, runId)).rejects.toMatchObject({ code: "newer-schema" });
    await port.commitFile(reportPath(book.id, runId), bytes, { kind: "any" });

    // unsupported: a closed-union member this build does not know.
    const foreignUnion = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    (foreignUnion.findings as Array<Record<string, unknown>>)[0]!.claim = "verdict";
    await port.commitFile(reportPath(book.id, runId), encoder.encode(JSON.stringify(foreignUnion)), { kind: "any" });
    await expect(library.reviewRecords.readReport(book.id, runId)).rejects.toMatchObject({ code: "unsupported" });
    await port.commitFile(reportPath(book.id, runId), bytes, { kind: "any" });

    // not-found: a disposition is requested for a report that does not exist.
    await expect(library.reviewRecords.recordDisposition(book.id, "run_missing01", { findingId: "finding-1", state: "ignored" }))
      .rejects.toMatchObject({ code: "not-found" });
    expect(await port.readFile(dispositionPath(book.id, "run_missing01"))).toBeNull();
  });

  test("V2 — virtual freshness: capture, edit, re-check, restore-identical; nothing writes", async () => {
    const { library, book, port } = await makeBook(clockAt(afterRun));
    const created = await library.createChapter(book.id, { title: "Synthetic chapter" });
    const chapter = await library.saveChapter(book.id, created.id, "ADJACENT_BEFORE\nSelected 😀 exact.\nADJACENT_AFTER\n", {
      baseVersion: created.version, baseHash: created.hash
    });
    if (chapter.status !== "saved") throw new Error("Synthetic chapter did not save");
    const savedChapter = chapter.chapter;
    const savedBody = savedChapter.content;
    const savedHash = savedChapter.hash;
    const start = savedBody.indexOf("Selected");
    const end = savedBody.indexOf("\nADJACENT_AFTER");
    const envelope = await buildReviewEnvelope({
      contractVersion: 1, kind: "reader-review", requestId: runId, capturedAt: stamp,
      destination: {
        connectionId: "connection-1", provider: "Synthetic provider", model: "synthetic/model",
        endpointIdentity: "endpoint-revision-1"
      },
      environment: {
        hostId: "synthetic-host", hostSupported: true, connectionAvailable: true, modelSupported: true,
        capabilityRevision: "capability-1", estimatedCostUsd: null, priceAsOf: null,
        catalogContextTokens: null, catalogAsOf: null, contextFit: "unknown"
      },
      books: [{
        bookId: book.id, title: "Synthetic review book", consentSatisfied: true,
        consentRevision: "consent-1", termsRevision: "terms-1",
        enabledTools: ["read_chapter"]
      }],
      prompt: "Review the selected passage.",
      profile: await builtinReaderProfile("alpha"),
      priorFeedback: [],
      sources: [captureChapterSource({
        sourceId: "source-1",
        saved: { bookId: book.id, chapterId: savedChapter.id, version: savedChapter.version, hash: savedHash, body: savedBody },
        bookTitle: "Synthetic review book", title: "Synthetic chapter", position: 1, capturedAt: stamp,
        ranges: [{ start, end }]
      })]
    });
    const chapterFile = chapterPath(book.id, savedChapter.path);
    const originalBytes = (await port.readFile(chapterFile))?.bytes;
    if (!originalBytes) throw new Error("Missing chapter bytes");
    const treeHash = async () => {
      const hash = createHash("sha256");
      const walk = async (path: LibraryPath): Promise<void> => {
        const entries = await port.listDirectory(path);
        for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
          const child = toLibraryPath([...path, entry.name]);
          if (entry.kind === "directory") { await walk(child); continue; }
          const file = await port.readFile(toLibraryFilePath(child));
          hash.update(child.join("/"));
          hash.update("\0");
          hash.update(file?.bytes ?? new Uint8Array());
          hash.update("\0");
        }
      };
      await walk(toLibraryPath([]));
      return hash.digest("hex");
    };
    // Unchanged on disk: current.
    const current = await library.readBook(book.id);
    expect(readerSourceState(envelope, readerCurrentSources(envelope, current, at)).status).toBe("current");
    // Edit the chapter: the captured source is now stale.
    const edited = await library.saveChapter(book.id, savedChapter.id, "Edited synthetic body.\n", {
      baseVersion: savedChapter.version, baseHash: savedHash
    });
    if (edited.status !== "saved") throw new Error("Synthetic chapter did not save");
    const afterEdit = await library.readBook(book.id);
    const staleCheck = readerCurrentSources(envelope, afterEdit, at);
    expect(sourceCurrency(envelope.sources[0]!, staleCheck)).toBe("stale");
    expect(readerSourceState(envelope, staleCheck).status).toBe("stale");
    // Delete the chapter file: the source is unavailable.
    await port.removeFile(chapterFile);
    const afterDelete = await library.readBook(book.id);
    const missingCheck = readerCurrentSources(envelope, afterDelete, at);
    expect(sourceCurrency(envelope.sources[0]!, missingCheck)).toBe("unavailable");
    expect(readerSourceState(envelope, missingCheck).status).toBe("unavailable");
    // Restore the exact original bytes: current again, with a full tree comparison around the re-checks.
    await port.commitFile(chapterFile, originalBytes, { kind: "any" });
    const restored = await library.readBook(book.id);
    const restoredCheck = readerCurrentSources(envelope, restored, at);
    expect(sourceCurrency(envelope.sources[0]!, restoredCheck)).toBe("current");
    // The freshness re-checks themselves write nothing: hash the tree around them.
    const beforeRecheck = await treeHash();
    readerSourceState(envelope, readerCurrentSources(envelope, restored, at));
    sourceCurrency(envelope.sources[0]!, readerCurrentSources(envelope, restored, at));
    expect(await treeHash()).toBe(beforeRecheck);
  });
});

describe("P — crash and disk-full", () => {
  test("P1 — commit-time fault injection never yields a torn published file nor a success", async () => {
    // The temp-create / fsync / rename phases live in apps/desktop (see the note in
    // atomic-faults.test.ts). At the core boundary the honest contract is: a fault anywhere in
    // the commit yields `uncertain`, never `saved`/`created`.
    const modes = ["commit-throws", "commit-uncertain", "commit-wrong-bytes"] as const;
    for (const mode of modes) {
      const { library, book, port } = await makeBook(clockAt(afterRun));
      const original = port.commitFile.bind(port);
      if (mode === "commit-throws") {
        port.commitFile = async () => { throw Object.assign(new Error("injected write failure"), { code: "ENOSPC" }); };
      } else if (mode === "commit-uncertain") {
        port.commitFile = async () => ({ status: "changed", current: null, publication: "uncertain" });
      } else {
        port.commitFile = async (path, bytes, expected) => {
          const result = await original(path, bytes, expected);
          if (result.status !== "written") return result;
          const wrong = new Uint8Array(result.snapshot.bytes);
          if (wrong.length > 0) wrong[0] = (wrong[0] ?? 0) ^ 0xff;
          return { ...result, snapshot: { ...result.snapshot, bytes: wrong, sha256: sha256(wrong) } };
        };
      }
      await expect(library.reviewRecords.createReport(book.id, await readerRun(book.id)))
        .rejects.toMatchObject({ code: "uncertain" });
      if (mode === "commit-throws" || mode === "commit-uncertain") {
        expect(await port.readFile(reportPath(book.id, runId))).toBeNull();
      }
      // Whatever the interleaving, a present file is a complete file or a fully absent one:
      // it is never a silent half-write trusted by the store.
      const onDisk = await port.readFile(reportPath(book.id, runId));
      if (onDisk) expect(onDisk.bytes.byteLength).toBeGreaterThan(0);
    }
  });

  test("P4 — disk full refuses the write, publishes nothing, and an explicit retry after space frees works", async () => {
    const { library, book, port } = await makeBook();
    const original = port.commitFile.bind(port);
    let full = true;
    port.commitFile = async (path, bytes, expected) => {
      if (full) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return original(path, bytes, expected);
    };
    await expect(library.reviewRecords.createReport(book.id, await readerRun(book.id)))
      .rejects.toMatchObject({ code: "uncertain" });
    expect(await port.readFile(reportPath(book.id, runId))).toBeNull();
    full = false;
    const retry = await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    expect(retry.status).toBe("created");
    expect(await port.readFile(reportPath(book.id, runId))).not.toBeNull();
  });

  test("P5 — a commit whose readback disagrees reports uncertain and never settles the journal as verified", async () => {
    const { library, book, port } = await makeBook(clockAt(afterRun));
    const original = port.commitFile.bind(port);
    port.commitFile = async (path, bytes, expected) => {
      const result = await original(path, bytes, expected);
      if (result.status !== "written") return result;
      const wrong = new Uint8Array(result.snapshot.bytes);
      wrong[0] = (wrong[0] ?? 0) ^ 0xff;
      return { ...result, snapshot: { ...result.snapshot, bytes: wrong, sha256: sha256(wrong) } };
    };
    await expect(library.reviewRecords.createReport(book.id, await readerRun(book.id)))
      .rejects.toMatchObject({ code: "uncertain" });
    const journal = await readSyncJournal(port, "device_fixture01");
    const entry = journal?.files[`books/${book.id}/reviews/${runId}.json`];
    // The write never settles as verified: no verified observation is recorded for the path.
    expect(entry === undefined || entry.plannedWriteId !== undefined || entry.writtenSha256 !== undefined).toBe(true);
    // A subsequent healthy save settles normally.
    port.commitFile = original;
    const retry = await library.reviewRecords.createReport(book.id, await readerRun(book.id));
    expect(["created", "unchanged"]).toContain(retry.status);
  });
});
