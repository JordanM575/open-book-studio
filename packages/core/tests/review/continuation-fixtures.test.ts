import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bookFilePath } from "../../src/library/paths";
import { planReviewCampaign, type CampaignPlan, type CampaignPlanInput } from "../../src/review/campaign-planner";
import { normalizeBody } from "../../src/markdown";
import { buildCampaignContinuation } from "../../src/review/campaign-continuation-build";
import {
  inspectCampaignContinuationCompatibility, serveCampaignContinuation,
  CAMPAIGN_PLANNER_SEMANTICS, COMPATIBLE_CAMPAIGN_PLANNER_SEMANTICS
} from "../../src/review/campaign-continuation-replan";
import { readContinuationManifest } from "../../src/review/campaign-continuation-wire";
import {
  CampaignContinuationStore, ContinuationStorageError,
  continuationIntentPath, continuationManifestPath, continuationSegmentPath,
  continuationSegmentsPath, continuationTrashSegmentsPath, continuationGroupMoveIntentPath,
  type CampaignContinuationHost, type ContinuationCandidate, type ContinuationStorageErrorCode
} from "../../src/review/campaign-continuation-store";
import { reportRecordBytes, decodeReviewRecord, buildReviewReport, buildCampaignRecord, campaignBytes } from "../../src/review/record-format";
import { buildReaderRun } from "../../src/review/findings";
import { encodeCanonicalJson } from "../../src/review/record-json";
import { InMemoryLibraryPort } from "../support/in-memory-port";
import { campaignInput, planned, withSynthesis } from "./campaign-fixtures";
import { reportPath } from "../../src/review/record-store";

/** T014 §7 fixture matrix — schema-2 (continuation) substrate rows. Synthetic fixtures only. */
const time = "2026-11-08T12:00:00.000Z";
const owner = "book_123456";
const otherOwner = "book_654321";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function writeBook(port: InMemoryLibraryPort, bookId: string) {
  const bytes = encoder.encode(JSON.stringify({
    schemaVersion: 1, id: bookId, title: "Synthetic book", description: "", outline: "",
    createdAt: time, updatedAt: time
  }));
  await port.commitFile(bookFilePath(bookId), bytes, { kind: "absent" });
}

function at(root: unknown, path: readonly (string | number)[]): unknown {
  let value = root;
  for (const part of path) {
    if (value === null || typeof value !== "object") throw new Error("Bad fixture path");
    value = Object.getOwnPropertyDescriptor(value, String(part))?.value;
  }
  return value;
}

/** A schema-1 review-campaign document, built to fail reading by the schema-2 wire reader. */
function buildCampaignRecordShallow(): Uint8Array {
  const record = buildCampaignRecord({
    bookId: owner, id: "campaign-schema1", revision: 1, base: { kind: "absent", revision: 0 },
    draft: {
      status: "planned", plannedAt: time, sourceBytes: 10,
      profile: { id: "reader-alpha", version: 1, digest: "a".repeat(64) },
      sources: [{
        sourceId: "source-1", bookId: owner, chapterId: "ch_123456", title: "Synthetic chapter",
        position: 1, version: 3, hash: "b".repeat(64), planned: [{ start: 0, end: 10 }]
      }],
      stages: [{
        stageId: "stage-1", kind: "range", sourceIds: ["source-1"], planned: [{ start: 0, end: 10 }],
        status: "planned", report: null, at: time
      }],
      synthesis: []
    },
    createdAt: time, updatedAt: time
  });
  return campaignBytes(record);
}

interface Faults {
  immutableCalls: number;
  failImmutableAt: number | null;
  failManifest: boolean;
}

function makeHarness() {
  const port = new InMemoryLibraryPort({ id: "device_fixture01", name: "Fixture device", createdAt: time }, () => time);
  const faults: Faults = { immutableCalls: 0, failImmutableAt: null, failManifest: false };
  const host: CampaignContinuationHost = {
    storage: port, runtime: port, deviceId: "device_fixture01",
    withBook: async (_bookId, work) => work(),
    commitFile: async (path, bytes, expected) => {
      if (faults.failManifest) throw new Error("simulated crash before manifest");
      return port.commitFile(path, bytes, expected);
    },
    createImmutableFile: async (path, bytes) => {
      faults.immutableCalls += 1;
      if (faults.failImmutableAt === faults.immutableCalls) throw new Error("simulated crash");
      return port.createImmutableFile(path, bytes);
    }
  };
  const store = new CampaignContinuationStore(host);
  return { port, store, host, faults };
}

async function fixture(withCheckpoint = true) {
  const body = normalizeBody("Synthetic chapter prose for storage.\nSecond synthetic line.\n");
  const input = withSynthesis(await campaignInput(body));
  const source = input.sources[0];
  if (!source) throw new Error("Missing fixture source");
  const rawBytes = encoder.encode(body);
  source.saved = { ...source.saved, hash: sha256(rawBytes) };
  const plan = await planned(input);
  const checkpoint = withCheckpoint
    ? { checkpointVersion: 1, owner: { bookId: plan.ownerBookId }, campaignId: plan.campaignId, planDigest: plan.digest,
        capturedAt: time, stages: plan.stages.map((stage) => ({ stageId: stage.stageId, receipt: null })) }
    : null;
  const built = await buildCampaignContinuation(plan, { operationId: "operation-one", createdAt: time, updatedAt: time, checkpoint });
  const candidate: ContinuationCandidate = { manifestBytes: built.manifestBytes, intentBytes: built.intentBytes, segments: built.segments };
  return { plan, built, candidate };
}

async function expectCode(promise: Promise<unknown>, code: ContinuationStorageErrorCode) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ContinuationStorageError);
    expect((error as ContinuationStorageError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ContinuationStorageError ${code}`);
}

/** Apply a mutation to a built candidate's manifest and re-embed it in the intent. */
function forgeCandidate(built: Awaited<ReturnType<typeof buildCampaignContinuation>>, mutate: (manifest: Record<string, unknown>) => void): ContinuationCandidate {
  const manifest = JSON.parse(decoder.decode(built.manifestBytes)) as Record<string, unknown>;
  mutate(manifest);
  const manifestBytes = encodeCanonicalJson(manifest);
  const intent = JSON.parse(decoder.decode(built.intentBytes)) as Record<string, unknown>;
  intent.candidate = {
    encoding: "base64",
    bytes: manifestBytes.length,
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    data: Buffer.from(manifestBytes).toString("base64")
  };
  intent.expectedBase = manifest.base;
  const intentBytes = encodeCanonicalJson(intent);
  return { manifestBytes, intentBytes, segments: built.segments };
}

describe("M1 — schema dispatch between generations", () => {
  test("M1 — a schema-1 campaign document is refused by the schema-2 reader and vice versa", async () => {
    const { port } = makeHarness();
    await writeBook(port, owner);
    const f = await fixture(false);
    const schema1 = buildCampaignRecordShallow();
    try {
      readContinuationManifest(schema1, { ownerBookId: owner, campaignId: "campaign-schema1" });
      throw new Error("schema-1 bytes were read as schema-2");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("unsupported");
    }
    const schema2 = f.built.manifestBytes;
    try {
      decodeReviewRecord(schema2, { kind: "review-campaign", bookId: owner });
      throw new Error("schema-2 bytes were read as schema-1");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("newer-schema");
    }
  });

  test("M1 — a compatible-but-different planner label yields replan-required, never serve-unchanged", async () => {
    const { port, store } = makeHarness();
    await writeBook(port, owner);
    const f = await fixture(false);
    expect(CAMPAIGN_PLANNER_SEMANTICS).toBe("review-campaign-planner-v1");
    expect(COMPATIBLE_CAMPAIGN_PLANNER_SEMANTICS).toContain("review-campaign-planner-v0");
    // Honest control: the exact recorded semantics dispatch to serve-unchanged.
    expect(inspectCampaignContinuationCompatibility(f.built.manifestBytes))
      .toEqual({ decision: "serve-unchanged", plannerSemantics: CAMPAIGN_PLANNER_SEMANTICS });
    // A compatible-but-different label must never be served unchanged, through any door.
    const downgraded = JSON.parse(decoder.decode(f.built.manifestBytes)) as Record<string, unknown>;
    downgraded.plannerSemantics = "review-campaign-planner-v0";
    const downgradedBytes = encodeCanonicalJson(downgraded);
    expect(inspectCampaignContinuationCompatibility(downgradedBytes))
      .toEqual({ decision: "replan-required", plannerSemantics: "review-campaign-planner-v0" });
    const { digest: _digest, ...content } = f.plan;
    const served = await serveCampaignContinuation(downgradedBytes, f.plan,
      (id) => f.built.segments.find((segment) => segment.reference.id === id)?.bytes,
      ({ path }) => at(content, path));
    expect(served).toEqual({ status: "refused", code: "replan-required" });
    // Through the store's inspect and load doors as well.
    await port.commitFile(continuationManifestPath(owner, f.plan.campaignId), downgradedBytes, { kind: "any" });
    const inspected = await store.inspectContinuation(owner, f.plan.campaignId);
    expect(inspected).toMatchObject({ status: "replan-required", recordedPlannerSemantics: "review-campaign-planner-v0" });
    const loaded = await store.loadContinuation(owner, f.plan.campaignId, f.plan, ({ path }) => at(content, path));
    expect(loaded).toEqual({ status: "refused", code: "replan-required" });
    // An unknown future label refuses outright.
    const future = JSON.parse(decoder.decode(f.built.manifestBytes)) as Record<string, unknown>;
    future.plannerSemantics = "review-campaign-planner-v99";
    const futureBytes = encodeCanonicalJson(future);
    expect(inspectCampaignContinuationCompatibility(futureBytes))
      .toEqual({ decision: "refuse", code: "unsupported" });
  });
});

describe("P2 — crash between campaign publish phases", () => {
  test("P2 — crash before the intent leaves only an incomplete draft; both locations retained", async () => {
    const { port, store, faults } = makeHarness();
    await writeBook(port, owner);
    const f = await fixture(false);
    faults.failImmutableAt = 1; // the intent is the first immutable create
    await expectCode(store.publishContinuation(owner, f.plan.campaignId, f.candidate), "uncertain");
    expect(await port.readFile(continuationIntentPath(owner, f.plan.campaignId, "operation-one"))).toBeNull();
    expect(await port.readFile(continuationManifestPath(owner, f.plan.campaignId))).toBeNull();
    const recovery = await store.inspectContinuationRecovery(owner, f.plan.campaignId, "operation-one");
    expect(recovery.classifications[0]).toMatchObject({
      status: "recoverable", code: "incomplete-draft", candidateRetained: false, manifestState: "absent"
    });
  });

  test("P2 — crash mid-segments retains the intent and names what is missing; nothing is replayed", async () => {
    const { port, store, faults } = makeHarness();
    await writeBook(port, owner);
    const f = await fixture(false);
    faults.failImmutableAt = 2; // intent lands; the first segment does not
    await expectCode(store.publishContinuation(owner, f.plan.campaignId, f.candidate), "uncertain");
    const segment = f.built.segments[0];
    if (!segment) throw new Error("Missing fixture segment");
    expect(await port.readFile(continuationIntentPath(owner, f.plan.campaignId, "operation-one")))
      .toEqual({ bytes: f.candidate.intentBytes, sha256: sha256(f.candidate.intentBytes), createdAt: time, modifiedAt: time });
    expect(await port.readFile(continuationManifestPath(owner, f.plan.campaignId))).toBeNull();
    expect(await port.readFile(continuationSegmentPath(owner, f.plan.campaignId, segment.reference.id))).toBeNull();
    const recovery = await store.inspectContinuationRecovery(owner, f.plan.campaignId, "operation-one");
    expect(recovery.classifications[0]?.status).toBe("recoverable");
    expect(recovery.classifications[0]?.code).toBe("incomplete-draft");
    expect(recovery.classifications[0]?.candidateRetained).toBe(true);
    expect(recovery.classifications[0]?.missingSegmentIds).toContain(segment.reference.id);
  });

  test("P2 — crash after the segments but before the manifest classifies as prepared; explicit retry publishes", async () => {
    const { port, store, faults } = makeHarness();
    await writeBook(port, owner);
    const f = await fixture(false);
    faults.failManifest = true;
    await expectCode(store.publishContinuation(owner, f.plan.campaignId, f.candidate), "uncertain");
    // Everything except the manifest is retained, byte for byte.
    expect((await port.readFile(continuationIntentPath(owner, f.plan.campaignId, "operation-one")))?.bytes)
      .toEqual(f.candidate.intentBytes);
    for (const segment of f.built.segments) {
      expect((await port.readFile(continuationSegmentPath(owner, f.plan.campaignId, segment.reference.id)))?.bytes)
        .toEqual(segment.bytes);
    }
    expect(await port.readFile(continuationManifestPath(owner, f.plan.campaignId))).toBeNull();
    const recovery = await store.inspectContinuationRecovery(owner, f.plan.campaignId, "operation-one");
    expect(recovery.classifications[0]).toMatchObject({
      status: "recoverable", code: "prepared", candidateRetained: true, manifestState: "expected-base"
    });
    // Nothing replays by itself: the fault clears and the same candidate is explicitly re-published.
    faults.failManifest = false;
    const retried = await store.publishContinuation(owner, f.plan.campaignId, f.candidate);
    expect(retried.status).toBe("published");
    expect((await port.readFile(continuationManifestPath(owner, f.plan.campaignId)))?.bytes)
      .toEqual(f.candidate.manifestBytes);
  });
});

describe("P3 — crash mid trash-group move", () => {
  test("P3 — segments moved, manifest not: partial is surfaced, nothing resumes implicitly, restore refuses safely", async () => {
    const port = new InMemoryLibraryPort({ id: "device_fixture01", name: "Fixture device", createdAt: time }, () => time);
    await writeBook(port, owner);
    const f = await fixture(false);
    let moveCalls = 0;
    const host: CampaignContinuationHost = {
      storage: port, runtime: port, deviceId: "device_fixture01",
      withBook: async (_bookId, work) => work(),
      commitFile: async (path, bytes, expected) => port.commitFile(path, bytes, expected),
      createImmutableFile: async (path, bytes) => port.createImmutableFile(path, bytes),
      moveFile: async (from, to) => port.moveFile(from, to),
      moveDirectory: async (from, to) => {
        moveCalls += 1;
        if (moveCalls === 2) throw new Error("simulated crash during group move");
        return port.moveDirectory(from, to);
      }
    };
    const store = new CampaignContinuationStore(host);
    await store.publishContinuation(owner, f.plan.campaignId, f.candidate);
    const groupId = "group-partial";
    await expectCode(store.trashContinuationGroup(owner, f.plan.campaignId, {
      operationId: "group-trash-partial", groupId, createdAt: time
    }), "uncertain");
    // No success is claimed and no torn state is hidden: the manifest stayed in place,
    // the segments moved, and the group is classified partial — never complete.
    expect((await port.readFile(continuationManifestPath(owner, f.plan.campaignId)))?.bytes)
      .toEqual(f.candidate.manifestBytes);
    const trashSegments = await port.listDirectory(continuationTrashSegmentsPath(owner, f.plan.campaignId, groupId));
    expect(trashSegments.length).toBeGreaterThan(0);
    expect((await port.listDirectory(continuationSegmentsPath(owner, f.plan.campaignId))).length).toBe(0);
    const inspection = await store.inspectContinuationGroup(owner, f.plan.campaignId, { groupId });
    expect(inspection.state).toBe("partial");
    // The move intent was retained for the operator; it is never replayed automatically.
    expect(await port.readFile(continuationGroupMoveIntentPath(owner, "group-trash-partial"))).not.toBeNull();
    // An explicit restore from this half-moved state refuses without moving anything.
    await expectCode(store.restoreContinuationGroup(owner, f.plan.campaignId, {
      operationId: "group-restore", groupId, createdAt: "2026-11-08T12:05:00.000Z"
    }), "not-found");
    expect((await port.readFile(continuationManifestPath(owner, f.plan.campaignId)))?.bytes)
      .toEqual(f.candidate.manifestBytes);
    expect((await port.listDirectory(continuationTrashSegmentsPath(owner, f.plan.campaignId, groupId))).length)
      .toBeGreaterThan(0);
  });
});

describe("X5 — pre-existing immutable bytes are never rewritten", () => {
  test("X5 — a segment exists with different bytes: conflict, never overwritten, manifest never published", async () => {
    const { port, store } = makeHarness();
    await writeBook(port, owner);
    const f = await fixture(false);
    const segment = f.built.segments[0];
    if (!segment) throw new Error("Missing segment");
    const divergent = new Uint8Array(segment.bytes);
    divergent[0] = (divergent[0] ?? 0) ^ 0xff;
    await port.commitFile(continuationSegmentPath(owner, f.plan.campaignId, segment.reference.id), divergent, { kind: "absent" });
    await expectCode(store.publishContinuation(owner, f.plan.campaignId, f.candidate), "conflict");
    expect((await port.readFile(continuationSegmentPath(owner, f.plan.campaignId, segment.reference.id)))?.bytes).toEqual(divergent);
    expect(await port.readFile(continuationManifestPath(owner, f.plan.campaignId))).toBeNull();
  });

  test("X5 — an intent exists with different bytes: conflict before anything else exists", async () => {
    const { port, store } = makeHarness();
    await writeBook(port, owner);
    const f = await fixture(false);
    const squatter = encoder.encode("{\"squatter\":true}");
    await port.commitFile(continuationIntentPath(owner, f.plan.campaignId, "operation-one"), squatter, { kind: "absent" });
    await expectCode(store.publishContinuation(owner, f.plan.campaignId, f.candidate), "conflict");
    expect((await port.readFile(continuationIntentPath(owner, f.plan.campaignId, "operation-one")))?.bytes).toEqual(squatter);
    expect(await port.listDirectory(continuationSegmentsPath(owner, f.plan.campaignId))).toHaveLength(0);
    expect(await port.readFile(continuationManifestPath(owner, f.plan.campaignId))).toBeNull();
  });
});

describe("X8 — campaign admission and bounds", () => {
  const totalScalars = (plan: CampaignPlan) =>
    plan.stages.filter((stage) => stage.kind === "range")
      .flatMap((stage) => stage.primary)
      .reduce((total, span) => total + (span.end - span.start), 0);
  const rangeStagesContiguous = (plan: CampaignPlan, total: number) => {
    const spans = plan.stages.filter((stage) => stage.kind === "range").flatMap((stage) => stage.primary);
    let cursor = 0;
    for (const span of spans) {
      if (span.start !== cursor) return false;
      cursor = span.end;
    }
    return cursor === total;
  };

  async function singleChapterInput(body: string, policy?: { maxPrimaryScalars?: number }) {
    const input = await campaignInput(body);
    if (policy?.maxPrimaryScalars !== undefined) {
      input.policy = { ...input.policy, maxPrimaryScalars: policy.maxPrimaryScalars };
    }
    return input;
  }

  test("X8 — a 70k-scalar single chapter (over one stage's window) splits without losing coverage", async () => {
    const body = `${"x".repeat(70_000)}\n`;
    const input = await singleChapterInput(body);
    const result = await planReviewCampaign(input);
    if (result.status === "refused") throw new Error(`Unexpected refusal ${result.code}`);
    const { plan } = result;
    expect(plan.stages.length).toBeGreaterThanOrEqual(2);
    expect(totalScalars(plan)).toBe(body.length);
    expect(rangeStagesContiguous(plan, body.length)).toBe(true);
    expect(plan.persistence.status).toBe("within-current-limits");
  });

  test("X8 — a 250k-scalar selection plans completely; nothing is truncated or refused", async () => {
    const body = `${"x".repeat(250_000)}\n`;
    const input = await singleChapterInput(body);
    const result = await planReviewCampaign(input);
    if (result.status === "refused") throw new Error(`Unexpected refusal ${result.code}`);
    const { plan } = result;
    expect(plan.stages.length).toBeGreaterThanOrEqual(4);
    expect(totalScalars(plan)).toBe(body.length);
    expect(rangeStagesContiguous(plan, body.length)).toBe(true);
    expect(plan.persistence.status).toBe("within-current-limits");
  }, 30_000);

  test("X8 — a policy window beyond the format cap is refused, never clamped", async () => {
    const input = await singleChapterInput(`${"x".repeat(1_000)}\n`, { maxPrimaryScalars: 70_000 });
    const result = await planReviewCampaign(input);
    expect(result.status).toBe("refused");
  });

  test("X8 — a 120-chapter selection is named non-persistable with every source listed, never silently truncated", async () => {
    const base = await campaignInput("Synthetic chapter body.\n");
    const first = base.sources[0];
    if (!first) throw new Error("Missing fixture source");
    const sources = Array.from({ length: 120 }, (_, index) => ({
      ...first,
      sourceId: `source-${String(index + 1).padStart(3, "0")}`,
      saved: { ...first.saved, chapterId: `ch_${String(index + 100000).slice(0, 6)}` },
      title: `Synthetic chapter ${index + 1}`,
      position: index + 1
    }));
    const input: CampaignPlanInput = { ...base, sources };
    const result = await planReviewCampaign(input);
    if (result.status === "refused") throw new Error(`Unexpected refusal ${result.code}`);
    expect(result.status).toBe("non-persistable");
    expect(result.plan.persistence.reasons).toContain("campaign-source-limit");
    expect(result.plan.sources).toHaveLength(120);
  }, 30_000);
});

describe("X9 — forged manifests are refused at digest recomputation", () => {
  test("X9 — a forged plannedUnionDigest is accepted by the wire but refused at plan comparison", async () => {
    const { port, store } = makeHarness();
    await writeBook(port, owner);
    const f = await fixture(false);
    const forged = forgeCandidate(f.built, (manifest) => {
      manifest.plannedUnionDigest = createHash("sha256").update("forged-union").digest("hex");
    });
    const published = await store.publishContinuation(owner, f.plan.campaignId, forged);
    expect(published.status).toBe("published");
    const { digest: _digest, ...content } = f.plan;
    const loaded = await store.loadContinuation(owner, f.plan.campaignId, f.plan, ({ path }) => at(content, path));
    expect(loaded.status).toBe("refused");
    if (loaded.status === "refused") expect(loaded.code).toBe("corrupt");
    // Nothing was registered or rewritten: the forged bytes remain exactly as planted.
    expect((await port.readFile(continuationManifestPath(owner, f.plan.campaignId)))?.bytes).toEqual(forged.manifestBytes);
  });

  test("X9 — a fully re-hashed candidate for a different plan never matches the provenanced local plan", async () => {
    const { port, store } = makeHarness();
    const secondOwner = "book_654321";
    await writeBook(port, secondOwner);
    const owned = async (body: string, campaignId: string) => {
      const input = await campaignInput(body);
      const source = input.sources[0];
      if (!source) throw new Error("Missing fixture source");
      return {
        ...input,
        campaignId,
        ownerBookId: secondOwner,
        request: { ...input.request, books: [{ ...input.request.books[0]!, bookId: secondOwner }] },
        sources: [{ ...source, saved: { ...source.saved, bookId: secondOwner, hash: sha256(encoder.encode(body)) } }]
      };
    };
    // Control: the honest candidate for a locally provenanced plan matches.
    const honestBody = "Honest synthetic chapter body.\n";
    const honestInput = await owned(honestBody, "campaign-honest");
    const honestPlan = await planned(honestInput);
    const honestBuilt = await buildCampaignContinuation(honestPlan, {
      operationId: "operation-honest", createdAt: time, updatedAt: time, checkpoint: null
    });
    await store.publishContinuation(secondOwner, "campaign-honest", {
      manifestBytes: honestBuilt.manifestBytes, intentBytes: honestBuilt.intentBytes, segments: honestBuilt.segments
    });
    const { digest: _honestDigest, ...honestContent } = honestPlan;
    const control = await store.loadContinuation(secondOwner, "campaign-honest", honestPlan, ({ path }) => at(honestContent, path));
    expect(control.status).toBe("matched-local-plan-only");

    // A different plan, honestly re-hashed end to end, published under its own id.
    const foreignBody = "Entirely different synthetic chapter.\n";
    const foreignInput = await owned(foreignBody, "campaign-foreign");
    const foreignPlan = await planned(foreignInput);
    expect(foreignPlan.digest).not.toBe(honestPlan.digest);
    const foreign = await buildCampaignContinuation(foreignPlan, {
      operationId: "operation-foreign", createdAt: time, updatedAt: time, checkpoint: null
    });
    await store.publishContinuation(secondOwner, "campaign-foreign", {
      manifestBytes: foreign.manifestBytes, intentBytes: foreign.intentBytes, segments: foreign.segments
    });
    // Serving the foreign manifest against the provenanced honest plan refuses at digest recomputation.
    const loaded = await store.loadContinuation(secondOwner, "campaign-foreign", honestPlan, ({ path }) => at(honestContent, path));
    expect(loaded.status).toBe("refused");
    if (loaded.status === "refused") expect(loaded.code).toBe("corrupt");
  });
});

describe("X10 — foreign reports in a checkpoint stay bounded references", () => {
  test("X10 — a checkpoint citing another book's report resolves as bounded foreign; never adopted, never merged", async () => {
    const { port, store } = makeHarness();
    await writeBook(port, owner);
    await writeBook(port, otherOwner);
    const bodyA = normalizeBody("First book synthetic prose.\n");
    const bodyB = normalizeBody("Second book synthetic prose.\n");
    const base = await campaignInput(bodyA);
    const firstBook = base.request.books[0];
    if (!firstBook) throw new Error("Missing fixture book");
    const input = {
      ...base,
      campaignId: "campaign-foreign-ref",
      request: {
        ...base.request,
        books: [
          firstBook,
          { ...firstBook, bookId: otherOwner, title: "Second synthetic book" }
        ]
      },
      sources: [
        { ...base.sources[0]!, saved: { ...base.sources[0]!.saved, body: bodyA, hash: sha256(encoder.encode(bodyA)) } },
        {
          sourceId: "source-2",
          saved: { bookId: otherOwner, chapterId: "ch_654321", version: 3, hash: sha256(encoder.encode(bodyB)), body: bodyB },
          bookTitle: "Second synthetic book", title: "Second chapter", position: 2,
          ranges: [{ start: 0, end: bodyB.length }]
        }
      ],
      policy: { ...base.policy, synthesis: null }
    };
    const plan = await planned(input);
    expect(plan.stages.length).toBeGreaterThanOrEqual(2);
    // Save one honest schema-1 report per stage under its recorded owner.
    const receipts: Array<Record<string, unknown>> = [];
    const foreignHashes = new Map<string, string>();
    for (const stage of plan.stages) {
      const stageOwner = stage.envelope.books[0]?.bookId;
      const profile = stage.envelope.profile;
      if (!stageOwner || !profile) throw new Error("Missing stage attribution");
      const run = await buildReaderRun({
        runId: stage.stageId, startedAt: time, completedAt: time, envelope: stage.envelope,
        output: JSON.stringify({ runId: stage.stageId, readerId: profile.id, readerVersion: profile.version, findings: [] })
      });
      const report = await buildReviewReport({
        ownerBookId: stageOwner, run, savedAt: time, sha256: async (text) => sha256(encoder.encode(text))
      });
      const bytes = reportRecordBytes(report);
      await port.commitFile(reportPath(stageOwner, stage.stageId), bytes, { kind: "absent" });
      const hash = sha256(bytes);
      if (stageOwner === otherOwner) foreignHashes.set(stage.stageId, hash);
      receipts.push({
        status: "completed", completedCategories: [], at: time,
        actualScopeDigest: stage.envelope.scopeDigest,
        report: { ownerBookId: stageOwner, runId: stage.stageId, sha256: hash }
      });
    }
    const checkpoint = {
      checkpointVersion: 1, owner: { bookId: plan.ownerBookId }, campaignId: plan.campaignId,
      planDigest: plan.digest, capturedAt: time,
      stages: plan.stages.map((stage, index) => ({ stageId: stage.stageId, receipt: receipts[index] ?? null }))
    };
    const built = await buildCampaignContinuation(plan, {
      operationId: "operation-foreign", createdAt: time, updatedAt: time, checkpoint
    });
    await store.publishContinuation(owner, plan.campaignId, {
      manifestBytes: built.manifestBytes, intentBytes: built.intentBytes, segments: built.segments
    });
    const resolved = await store.resolveContinuationReports(owner, plan.campaignId);
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    const foreign = resolved.entries.filter((entry) => entry.disposition === "foreign");
    expect(foreign.length).toBeGreaterThan(0);
    for (const entry of foreign) {
      expect(entry.reference.ownerBookId).toBe(otherOwner);
      expect(Object.keys(entry.reference).sort()).toEqual(["ownerBookId", "runId", "sha256"]);
      expect(entry.code).toBe("resolved");
      // Never adopted into the owning book…
      expect(await port.readFile(reportPath(owner, entry.reference.runId))).toBeNull();
      // …and never mutated at the source either.
      const atSource = await port.readFile(reportPath(otherOwner, entry.reference.runId));
      expect(atSource?.sha256).toBe(foreignHashes.get(entry.reference.runId));
    }
    expect(resolved.owned + resolved.foreign + resolved.unavailable).toBe(resolved.entries.length);
    // A tampered foreign report degrades to a bounded unavailable entry, never to an adoption.
    const victim = foreign[0];
    if (!victim) throw new Error("Missing foreign entry");
    const victimPath = reportPath(otherOwner, victim.reference.runId);
    const original = (await port.readFile(victimPath))?.bytes;
    if (!original) throw new Error("Missing foreign report");
    const changed = new Uint8Array(original);
    changed[changed.length - 2] = (changed[changed.length - 2] ?? 0) ^ 0xff;
    await port.commitFile(victimPath, changed, { kind: "any" });
    const again = await store.resolveContinuationReports(owner, plan.campaignId);
    expect(again.status).toBe("resolved");
    if (again.status === "resolved") {
      const entry = again.entries.find((item) => item.reference.runId === victim.reference.runId);
      expect(entry?.disposition).toBe("unavailable");
      expect(entry?.code).toBe("external-mismatch");
      expect(again.entries.length).toBe(resolved.entries.length);
    }
  });
});

describe("P4 — disk full during continuation publication", () => {
  function ENOSPCHarness() {
    const port = new InMemoryLibraryPort({ id: "device_fixture01", name: "Fixture device", createdAt: time }, () => time);
    let full = true;
    const host: CampaignContinuationHost = {
      storage: port, runtime: port, deviceId: "device_fixture01",
      withBook: async (_bookId, work) => work(),
      commitFile: async (path, bytes, expected) => {
        if (full) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        return port.commitFile(path, bytes, expected);
      },
      createImmutableFile: async (path, bytes) => {
        if (full) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        return port.createImmutableFile(path, bytes);
      }
    };
    return { port, host, setFull: (value: boolean) => { full = value; } };
  }

  test("P4 — ENOSPC at the intent leaves nothing behind; explicit retry after space frees succeeds", async () => {
    const { port, host, setFull } = ENOSPCHarness();
    await writeBook(port, owner);
    const store = new CampaignContinuationStore(host);
    const f = await fixture(false);
    await expectCode(store.publishContinuation(owner, f.plan.campaignId, f.candidate), "uncertain");
    expect(await port.readFile(continuationIntentPath(owner, f.plan.campaignId, "operation-one"))).toBeNull();
    expect(await port.readFile(continuationSegmentsPath(owner, f.plan.campaignId))).toBeNull();
    expect(await port.readFile(continuationManifestPath(owner, f.plan.campaignId))).toBeNull();
    setFull(false);
    const retry = await store.publishContinuation(owner, f.plan.campaignId, f.candidate);
    expect(retry.status).toBe("published");
  });

  test("P4 — ENOSPC at a segment keeps the intent, publishes nothing, and retries explicitly", async () => {
    const { port, host, setFull } = ENOSPCHarness();
    setFull(false); // the intent may land; the disk fills before the segment write
    await writeBook(port, owner);
    const store = new CampaignContinuationStore(host);
    const f = await fixture(false);
    // Let the intent land, then the disk fills before the segment can be written.
    let calls = 0;
    const originalCreate = host.createImmutableFile;
    if (!originalCreate) throw new Error("Missing createImmutableFile");
    host.createImmutableFile = async (path, bytes) => {
      calls += 1;
      if (calls === 2) setFull(true);
      return originalCreate(path, bytes);
    };
    await expectCode(store.publishContinuation(owner, f.plan.campaignId, f.candidate), "uncertain");
    expect(await port.readFile(continuationIntentPath(owner, f.plan.campaignId, "operation-one")))
      .toEqual({ bytes: f.candidate.intentBytes, sha256: sha256(f.candidate.intentBytes), createdAt: time, modifiedAt: time });
    expect(await port.readFile(continuationManifestPath(owner, f.plan.campaignId))).toBeNull();
    setFull(false);
    const retry = await store.publishContinuation(owner, f.plan.campaignId, f.candidate);
    expect(retry.status).toBe("published");
  });
});
