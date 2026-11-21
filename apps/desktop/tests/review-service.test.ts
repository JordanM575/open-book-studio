import { afterEach, describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utf8Bytes } from "@ai-book-studio/core/review/contract";
import { treeFingerprint, expectTreeUnchanged } from "./support/tree-fingerprint";
import type { Catalogue } from "@ai-book-studio/core/providers/models";
import { ProviderError, type ConnectionSummary, type ModelInfo, type StoredCredential } from "@ai-book-studio/core/providers/types";
import { REVIEW_LIMITS } from "@ai-book-studio/core/review/contract";
import type { ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import type { ReaderReviewPrepareRequest } from "@ai-book-studio/core/review/reader-api";
import { Library } from "../src/main/library/store";
import { ReaderReviewService, type ReviewProviders } from "../src/main/review/service";
import type { ReviewTransport } from "../src/main/review/transport";

const stamp = "2026-11-07T12:00:00Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function connection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return { id: "conn_123456", provider: "meta", label: "Work account", kind: "api-key", createdAt: stamp, ...overrides };
}
function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "muse-spark-1.3", name: "Muse Spark 1.3", contextLength: 1_048_576, supportsTools: true, supportsImages: true,
    inputPricePerMillion: 1.25, cachedInputPricePerMillion: 0.15, outputPricePerMillion: 4.25, trainingOnData: false,
    note: "Standard mode: prompts and completions are not used to train Meta models.", ...overrides
  };
}
function outputFor(envelope: ReviewEnvelope): string {
  return JSON.stringify({ runId: envelope.requestId, readerId: envelope.profile?.id,
    readerVersion: envelope.profile?.version, findings: [] });
}

class FakeProviders implements ReviewProviders {
  readonly calls = { list: 0, models: 0, credential: 0 };
  connections: ConnectionSummary[];
  catalogue: Catalogue;
  gate: Promise<void> | null = null;
  entered = deferred<void>();
  constructor(connections: ConnectionSummary[], catalogue: Catalogue) {
    this.connections = connections;
    this.catalogue = catalogue;
  }
  async list(): Promise<ConnectionSummary[]> { this.calls.list++; return this.connections; }
  async models(_connectionId: string): Promise<Catalogue> {
    this.calls.models++;
    if (this.gate) { this.entered.resolve(); await this.gate; }
    return this.catalogue;
  }
  async credential(connectionId: string): Promise<StoredCredential> {
    this.calls.credential++;
    const found = this.connections.find((entry) => entry.id === connectionId);
    if (!found) throw new ProviderError("not-found", "No synthetic connection.");
    return { ...found, secret: "synthetic-secret" };
  }
}

class FakeTransport implements ReviewTransport {
  readonly calls: Array<{ envelope: ReviewEnvelope; credential: StoredCredential; signal: AbortSignal }> = [];
  output: ((envelope: ReviewEnvelope) => string) | null = null;
  error: unknown = null;
  pending: Promise<{ output: string }> | null = null;
  started = deferred<void>();
  /** Test-only escape hatch: return a contract-violating shape instead of the contract. */
  rawResult: unknown = undefined;
  /** Test-only hook invoked synchronously inside run(), before it returns. */
  callDuringRun: (() => void) | undefined = undefined;
  async run(input: { envelope: ReviewEnvelope; credential: StoredCredential; signal: AbortSignal }): Promise<{ output: string }> {
    this.calls.push(input);
    this.started.resolve();
    this.callDuringRun?.();
    if (this.rawResult !== undefined) return this.rawResult as { output: string };
    if (this.pending) return this.pending;
    if (this.error) throw this.error;
    return { output: this.output ? this.output(input.envelope) : outputFor(input.envelope) };
  }
}

async function fixture(options: {
  connection?: Partial<ConnectionSummary>;
  model?: Partial<ModelInfo>;
  noDefault?: boolean;
  allowContributorTraining?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "studio-reader-service-"));
  roots.push(root);
  const library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic reader service book" });
  const chapter = await library.createChapter(book.id, { title: "The arrival", content: "Synthetic saved prose for the reader." });
  const otherBook = await library.createBook({ title: "Synthetic unselected second book" });
  await library.createChapter(otherBook.id, { title: "Other chapter", content: "Synthetic other-book prose, never selected." });
  const threadsDir = join(root, "books", book.id, "threads");
  await mkdir(threadsDir, { recursive: true });
  await writeFile(join(threadsDir, "synthetic-sentinel.json"), "{\"sentinel\":\"reader review must not touch this\"}\n");
  const conflictsDir = join(root, "books", book.id, "conflicts");
  await mkdir(conflictsDir, { recursive: true });
  await writeFile(join(conflictsDir, "chapter.conflict-external-edit.synthetic.md"), "conflict candidate bytes\n");
  const selectedConnection = connection(options.connection);
  const selectedModel = model(options.model);
  if (!options.noDefault) {
    await library.updateBook(book.id, {
      defaultProvider: selectedConnection.provider,
      defaultConnectionId: selectedConnection.id,
      defaultModelId: selectedModel.id,
      ...(options.allowContributorTraining ? { allowContributorTraining: true } : {})
    });
  }
  const providers = new FakeProviders([selectedConnection], { models: [selectedModel], fetchedAt: stamp });
  const transport = new FakeTransport();
  const service = new ReaderReviewService({ library: () => library, providers, transport, now: () => stamp });
  return { root, library, book, chapter, otherBook, providers, transport, service, selectedConnection, selectedModel };
}

function request(bookId: string, options: {
  chapterId: string; content: string; prompt?: string; prepareId?: string; profileId?: "reader-alpha" | "reader-beta";
}): ReaderReviewPrepareRequest {
  return {
    operation: "prepare", prepareId: options.prepareId ?? "prepare-1", bookId, profileId: options.profileId ?? "reader-alpha",
    chapters: [{ chapterId: options.chapterId, ranges: [{ start: 0, end: options.content.length }] }],
    prompt: options.prompt ?? "A synthetic reader request."
  };
}

async function prepared(f: Awaited<ReturnType<typeof fixture>>, prepareId = "prepare-1") {
  const result = await f.service.prepare(request(f.book.id, {
    chapterId: f.chapter.id, content: f.chapter.content, prepareId
  }));
  if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.reason}`);
  return result;
}

/**
 * Read-only method names the reader-review path may call; everything else must stay at zero.
 * The `readBook*`/`chapter*`/`fallbackMeta` entries are the private read helpers that
 * `LibraryService.readBook` is built from; verified to perform no storage writes.
 */
const READ_ONLY_METHODS = new Set([
  "readBook", "readChapter", "listBooks", "listBooksWithIssues", "listConflicts",
  "readImage", "listImages", "listChapterHistory", "readChapterHistory", "compareChapterHistory", "search",
  "readBookFile", "readChaptersWithIssues", "readChapterFile", "chapterFileNames", "chapterFromSnapshot", "fallbackMeta"
]);

interface WriterSpy {
  offenders(): string[];
}

/** Wraps every function on the named surfaces in a counting proxy, then reports non-read calls. */
function spyOnLibraryWriters(library: Library): WriterSpy {
  const targets: Array<[string, object]> = [
    ["library", library],
    ["library.service", (library as unknown as { service: object }).service],
    ["library.threads", library.threads],
    ["library.images", library.images],
    ["library.reviewRecords", library.reviewRecords],
    ["library.campaignContinuations", library.campaignContinuations]
  ];
  const counts = new Map<string, number>();
  for (const [label, target] of targets) {
    let proto: object | null = Object.getPrototypeOf(target);
    const seen = new Set<string>();
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor" || seen.has(name)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (!descriptor || typeof descriptor.value !== "function") continue;
        seen.add(name);
        if (READ_ONLY_METHODS.has(name)) continue;
        const key = `${label}.${name}`;
        counts.set(key, 0);
        const original = descriptor.value as (this: unknown, ...args: unknown[]) => unknown;
        Object.defineProperty(target, name, {
          configurable: true,
          writable: true,
          value(this: unknown, ...args: unknown[]) {
            counts.set(key, (counts.get(key) ?? 0) + 1);
            return original.apply(this, args);
          }
        });
      }
      proto = Object.getPrototypeOf(proto);
    }
  }
  return { offenders: () => [...counts].filter(([, count]) => count > 0).map(([name]) => name) };
}

function hashes(root: string, bookId: string, chapterPath: string) {
  const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  return Promise.all([
    sha(join(root, "books", bookId, "book.json")),
    sha(join(root, "books", bookId, "chapters", chapterPath))
  ]);
}

describe("volatile selected-source reader service", () => {
  test("prepare returns the exact disclosure facts, sends nothing and offers no tools", async () => {
    const f = await fixture();
    const result = await prepared(f);
    expect(f.transport.calls).toHaveLength(0);
    expect(result.usage.sourceBytes).toBe(new TextEncoder().encode(f.chapter.content).length);
    expect(result.usage.items).toBe(1);
    expect(result.envelope.books[0]?.enabledTools).toEqual([]);
    expect(result.envelope.priorFeedback).toEqual([]);
    expect(result.envelope.sources[0]).toMatchObject({ sourceId: `chapter:${f.chapter.id}` });
    expect(result.connection).toEqual({ id: "conn_123456", label: "Work account", providerName: "Meta", modelName: "Muse Spark 1.3" });
    expect(result.priceFacts).toEqual({ kind: "metered", inputPerMillion: 1.25, cachedInputPerMillion: 0.15, outputPerMillion: 4.25, asOf: stamp });
    expect(result.terms[0]?.training).toBe("The provider reports that this model does not train on prompts and completions.");
    expect(result.envelope.environment).toMatchObject({ estimatedCostUsd: null, contextFit: "unknown" });
  });

  test("a book without a default connection or model refuses before reading provider facts", async () => {
    const f = await fixture({ noDefault: true });
    const result = await f.service.prepare(request(f.book.id, { chapterId: f.chapter.id, content: f.chapter.content }));
    expect(result).toEqual({ kind: "blocked", reason: "no-model" });
    expect(f.providers.calls.list).toBe(0);
    expect(f.transport.calls).toHaveLength(0);
  });

  test("malformed selection and scope overflow refuse before any provider call", async () => {
    const malformed = await fixture();
    expect(await malformed.service.prepare(request(malformed.book.id, { chapterId: "ch_654321", content: "x" })))
      .toEqual({ kind: "blocked", reason: "invalid-selection" });
    expect(malformed.transport.calls).toHaveLength(0);

    const overflow = await fixture();
    const result = await overflow.service.prepare(request(overflow.book.id, {
      chapterId: overflow.chapter.id, content: overflow.chapter.content, prompt: "a".repeat(131_073)
    }));
    expect(result).toEqual({ kind: "blocked", reason: "scope-too-large",
      detail: "The selected text, profile and request are over 131,072 bytes." });
    expect(overflow.transport.calls).toHaveLength(0);
  });

  test("missing connection, unusable plan and missing model map to their own refusals", async () => {
    const missing = await fixture();
    missing.providers.connections = [];
    expect(await missing.service.prepare(request(missing.book.id, { chapterId: missing.chapter.id, content: missing.chapter.content })))
      .toEqual({ kind: "blocked", reason: "unavailable" });

    const permission = await fixture({ connection: { kind: "chatgpt-plan", planUsable: false, provider: "openai" } });
    expect(await permission.service.prepare(request(permission.book.id, { chapterId: permission.chapter.id, content: permission.chapter.content })))
      .toEqual({ kind: "blocked", reason: "permission" });

    const absent = await fixture();
    absent.providers.catalogue = { models: [], fetchedAt: stamp };
    expect(await absent.service.prepare(request(absent.book.id, { chapterId: absent.chapter.id, content: absent.chapter.content })))
      .toEqual({ kind: "blocked", reason: "no-model" });
    expect(absent.transport.calls).toHaveLength(0);
  });

  test("contributor consent is disclosed default-off; a forced Start sends nothing, and enabling it allows one call", async () => {
    const contributor = { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", trainingOnData: true,
      note: "Contributor mode: Meta may use this book's prompts and responses to train its models." };
    const f = await fixture({ model: contributor });
    const result = await prepared(f);
    expect(result.envelope.books[0]?.consentSatisfied).toBe(false);
    const blocked = await f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest });
    expect(blocked).toEqual({ kind: "blocked", reason: "consent" });
    expect(f.transport.calls).toHaveLength(0);

    await f.library.updateBook(f.book.id, { allowContributorTraining: true });
    const allowed = await prepared(f, "prepare-2");
    expect(allowed.envelope.books[0]?.consentSatisfied).toBe(true);
    const completed = await f.service.start({ operation: "start", requestId: allowed.requestId, scopeDigest: allowed.scopeDigest });
    expect(completed.kind).toBe("completed");
    expect(f.transport.calls).toHaveLength(1);
  });

  test("a saved source changed between Prepare and Start refuses with zero sends", async () => {
    const f = await fixture();
    const result = await prepared(f);
    await f.library.saveChapter(f.book.id, f.chapter.id, "Changed synthetic saved prose.", {
      baseVersion: f.chapter.version, baseHash: f.chapter.hash
    });
    expect(await f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .toEqual({ kind: "blocked", reason: "changed" });
    expect(f.transport.calls).toHaveLength(0);
  });

  test("revoked book consent blocks Start even when the prepared envelope said satisfied", async () => {
    const f = await fixture({ allowContributorTraining: true, model: {
      id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", trainingOnData: true,
      note: "Contributor mode: Meta may use this book's prompts and responses to train its models."
    } });
    const result = await prepared(f);
    await f.library.updateBook(f.book.id, { allowContributorTraining: false });
    expect(await f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .toEqual({ kind: "blocked", reason: "consent" });
    expect(f.transport.calls).toHaveLength(0);
  });

  test("a removed connection or model changes the pinned destination before any send", async () => {
    const removedConnection = await fixture();
    const first = await prepared(removedConnection);
    removedConnection.providers.connections = [];
    expect(await removedConnection.service.start({ operation: "start", requestId: first.requestId, scopeDigest: first.scopeDigest }))
      .toEqual({ kind: "blocked", reason: "changed" });
    expect(removedConnection.transport.calls).toHaveLength(0);

    const removedModel = await fixture();
    const second = await prepared(removedModel);
    removedModel.providers.catalogue = { models: [], fetchedAt: stamp };
    expect(await removedModel.service.start({ operation: "start", requestId: second.requestId, scopeDigest: second.scopeDigest }))
      .toEqual({ kind: "blocked", reason: "changed" });
    expect(removedModel.transport.calls).toHaveLength(0);
  });

  test("a mismatched digest, a consumed request and an unknown request all refuse without a second call", async () => {
    const f = await fixture();
    const result = await prepared(f);
    expect(await f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: "b".repeat(64) }))
      .toEqual({ kind: "blocked", reason: "changed" });
    expect(f.transport.calls).toHaveLength(0);
    expect((await f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest })).kind).toBe("completed");
    expect(await f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .toEqual({ kind: "blocked", reason: "changed" });
    expect(await f.service.start({ operation: "start", requestId: "review-unknown", scopeDigest: result.scopeDigest }))
      .toEqual({ kind: "blocked", reason: "changed" });
    expect(f.transport.calls).toHaveLength(1);
    expect(await f.service.stop({ operation: "stop", requestId: result.requestId })).toBe("unconfirmed");
  });

  test("cancel preparation before Start is a zero-send cancellation, and a second cancel says not-found", async () => {
    const f = await fixture();
    const result = await prepared(f);
    expect(await f.service.cancelPrepare({ operation: "cancelPrepare", prepareId: result.prepareId })).toBe("cancelled");
    expect(await f.service.cancelPrepare({ operation: "cancelPrepare", prepareId: result.prepareId })).toBe("not-found");
    expect(await f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .toEqual({ kind: "blocked", reason: "changed" });
    expect(f.transport.calls).toHaveLength(0);
  });

  test("Stop while Start revalidates removes the pending request and sends nothing", async () => {
    const f = await fixture();
    const result = await prepared(f);
    const gate = deferred();
    f.providers.gate = gate.promise;
    const start = f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest });
    await f.providers.entered.promise;
    expect(await f.service.stop({ operation: "stop", requestId: result.requestId })).toBe("not-started");
    gate.resolve();
    await expect(start).resolves.toEqual({ kind: "stopped" });
    expect(f.transport.calls).toHaveLength(0);
  });

  test("Stop during the one provider call aborts locally and never retries", async () => {
    const f = await fixture();
    const result = await prepared(f);
    const pending = deferred<{ output: string }>();
    f.transport.pending = pending.promise;
    const start = f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest });
    await f.transport.started.promise;
    expect(f.transport.calls).toHaveLength(1);
    expect(await f.service.stop({ operation: "stop", requestId: result.requestId })).toBe("stopped");
    expect(f.transport.calls[0]?.signal.aborted).toBe(true);
    pending.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(start).resolves.toEqual({ kind: "stopped" });
    expect(f.transport.calls).toHaveLength(1);
  });

  test.each([
    ["provider", new ProviderError("rate-limit", "PRIVATE_PROVIDER_BODY"), "provider"],
    ["refused", new ProviderError("refusal", "PRIVATE_PROVIDER_BODY"), "refused"],
    ["context", new ProviderError("context", "PRIVATE_PROVIDER_BODY"), "overflow"],
    ["api offline", new APICallError({ message: "fetch failed", url: "https://example.test", requestBodyValues: {}, isRetryable: false }), "provider"],
    ["api refused", new APICallError({ message: "Content policy", url: "https://example.test", requestBodyValues: {}, statusCode: 400, responseBody: "content policy violation", isRetryable: false }), "refused"],
    ["api context", new APICallError({ message: "Context length exceeded", url: "https://example.test", requestBodyValues: {}, statusCode: 400, responseBody: "maximum context length", isRetryable: false }), "overflow"],
    ["api 429", new APICallError({ message: "Too Many Requests", url: "https://example.test", requestBodyValues: {}, statusCode: 429, isRetryable: false }), "provider"],
    ["api 401", new APICallError({ message: "Unauthorized", url: "https://example.test", requestBodyValues: {}, statusCode: 401, isRetryable: false }), "provider"],
    ["api 400 unrelated body", new APICallError({ message: "Bad Request", url: "https://example.test", requestBodyValues: {}, statusCode: 400, responseBody: "unrelated validation detail", isRetryable: false }), "provider"],
    ["api 400 prompt-is-too-long body (not a context signal)", new APICallError({ message: "prompt is too long", url: "https://example.test", requestBodyValues: {}, statusCode: 400, responseBody: "prompt is too long", isRetryable: false }), "provider"],
    ["api refused behind a fenced JSON body", new APICallError({ message: "Request failed", url: "https://example.test", requestBodyValues: {}, statusCode: 400, responseBody: "```json\n{\"error\": \"content policy violation\"}\n```", isRetryable: false }), "refused"],
    ["bare error", new Error("boom"), "provider"]
  ] as const)("a %s transport failure ends incomplete with one call", async (_name, error, expected) => {
    const f = await fixture();
    const result = await prepared(f);
    const before = await treeFingerprint(f.root);
    f.transport.error = error;
    await expect(f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .resolves.toEqual({ kind: "failed", reason: expected });
    expect(f.transport.calls).toHaveLength(1);
    expectTreeUnchanged(before, await treeFingerprint(f.root));
  });

  test("malformed and oversized outputs fail the run without repair or retry", async () => {
    const malformed = await fixture();
    const first = await prepared(malformed);
    const malformedBefore = await treeFingerprint(malformed.root);
    malformed.transport.output = () => "not-json";
    await expect(malformed.service.start({ operation: "start", requestId: first.requestId, scopeDigest: first.scopeDigest }))
      .resolves.toEqual({ kind: "failed", reason: "malformed" });
    expect(malformed.transport.calls).toHaveLength(1);
    expectTreeUnchanged(malformedBefore, await treeFingerprint(malformed.root));

    const oversized = await fixture();
    const second = await prepared(oversized);
    const oversizedBefore = await treeFingerprint(oversized.root);
    oversized.transport.output = () => " ".repeat(REVIEW_LIMITS.outputBytes + 1);
    await expect(oversized.service.start({ operation: "start", requestId: second.requestId, scopeDigest: second.scopeDigest }))
      .resolves.toEqual({ kind: "failed", reason: "overflow" });
    expect(oversized.transport.calls).toHaveLength(1);
    expectTreeUnchanged(oversizedBefore, await treeFingerprint(oversized.root));
  });

  test("prepare, Start, Stop and cancel leave the whole tree byte-identical and call no writer", async () => {
    const f = await fixture();
    const before = await hashes(f.root, f.book.id, f.chapter.path);
    const treeBefore = await treeFingerprint(f.root);
    const writes: string[] = [];
    const target = f.library as unknown as Record<string, (...args: never[]) => unknown>;
    for (const name of ["createChapter", "saveChapter", "updateBook", "deleteChapter"] as const) {
      const original = target[name]?.bind(f.library);
      if (!original) throw new Error(`Missing Library writer ${name}`);
      target[name] = (...args: never[]) => {
        writes.push(name);
        return original(...args);
      };
    }
    const first = await prepared(f);
    expect(await f.service.start({ operation: "start", requestId: first.requestId, scopeDigest: first.scopeDigest })).toMatchObject({ kind: "completed" });
    const second = await f.service.prepare(request(f.book.id, { chapterId: f.chapter.id, content: f.chapter.content, prepareId: "prepare-2" }));
    if (second.kind !== "ready") throw new Error("Expected a second disclosure");
    expect(await f.service.stop({ operation: "stop", requestId: second.requestId })).toBe("not-started");
    const third = await f.service.prepare(request(f.book.id, { chapterId: f.chapter.id, content: f.chapter.content, prepareId: "prepare-3" }));
    if (third.kind !== "ready") throw new Error("Expected a third disclosure");
    expect(await f.service.cancelPrepare({ operation: "cancelPrepare", prepareId: third.prepareId })).toBe("cancelled");
    expect(writes).toEqual([]);
    expect(await hashes(f.root, f.book.id, f.chapter.path)).toEqual(before);
    expectTreeUnchanged(treeBefore, await treeFingerprint(f.root));
    expect(f.transport.calls).toHaveLength(1);
  });
});

describe("strict reader output acceptance", () => {
  test("extra fields, unsupported categories, over-count output and an over-limit quote fail as malformed with one call and unchanged bytes", async () => {
    const variants: Array<(value: ReviewEnvelope) => string> = [
      (value) => JSON.stringify({ ...JSON.parse(outputFor(value)), extra: "PRIVATE_EXTRA_SENTINEL" }),
      (value) => JSON.stringify({ ...JSON.parse(outputFor(value)), findings: [{
        findingId: "f-1", category: "unsupported", readerId: value.profile?.id, readerVersion: value.profile?.version,
        runId: value.requestId, interpretation: "Synthetic.", claim: "observation", evidence: []
      }] }),
      (value) => JSON.stringify({ ...JSON.parse(outputFor(value)), findings: [{
        findingId: "f-1", category: "clarity", readerId: value.profile?.id, readerVersion: value.profile?.version,
        runId: value.requestId, interpretation: "Synthetic.", claim: "observation", evidence: [], extra: true
      }] }),
      (value) => JSON.stringify({ ...JSON.parse(outputFor(value)), findings: Array.from({ length: 51 }, (_, index) => ({
        findingId: `f-${index}`, category: "clarity", readerId: value.profile?.id, readerVersion: value.profile?.version,
        runId: value.requestId, interpretation: "Synthetic.", claim: "observation", evidence: []
      })) }),
      (value) => JSON.stringify({ ...JSON.parse(outputFor(value)), findings: [{
        findingId: "f-1", category: "clarity", readerId: value.profile?.id, readerVersion: value.profile?.version,
        runId: value.requestId, interpretation: "Synthetic.", claim: "observation", evidence: Array(9).fill({})
      }] }),
      (value) => JSON.stringify({ ...JSON.parse(outputFor(value)), findings: [{
        findingId: "f-1", category: "clarity", readerId: value.profile?.id, readerVersion: value.profile?.version,
        runId: value.requestId, interpretation: "Synthetic.", claim: "observation", evidence: [{ quote: "x".repeat(501) }]
      }] })
    ];
    for (const variant of variants) {
      const f = await fixture();
      const before = await hashes(f.root, f.book.id, f.chapter.path);
      const ready = await prepared(f);
      const treeBefore = await treeFingerprint(f.root);
      f.transport.output = variant;
      await expect(f.service.start({ operation: "start", requestId: ready.requestId, scopeDigest: ready.scopeDigest }))
        .resolves.toEqual({ kind: "failed", reason: "malformed" });
      expect(f.transport.calls).toHaveLength(1);
      expect(await hashes(f.root, f.book.id, f.chapter.path)).toEqual(before);
      expectTreeUnchanged(treeBefore, await treeFingerprint(f.root));
    }
  });
});

describe("read-only enforcement across the whole library tree", () => {
  test("prepare, start, stop and cancel across the whole flow call no writer anywhere and leave the tree byte-identical", async () => {
    const f = await fixture();
    const spy = spyOnLibraryWriters(f.library);
    const before = await treeFingerprint(f.root);

    const first = await prepared(f);
    const completed = await f.service.start({ operation: "start", requestId: first.requestId, scopeDigest: first.scopeDigest });
    expect(completed.kind).toBe("completed");

    const second = await f.service.prepare(request(f.book.id, { chapterId: f.chapter.id, content: f.chapter.content, prepareId: "prepare-2" }));
    expect(second.kind).toBe("ready");
    if (second.kind !== "ready") throw new Error("Expected a second disclosure");
    expect(await f.service.stop({ operation: "stop", requestId: second.requestId })).toBe("not-started");

    const third = await f.service.prepare(request(f.book.id, { chapterId: f.chapter.id, content: f.chapter.content, prepareId: "prepare-3" }));
    expect(third.kind).toBe("ready");
    if (third.kind !== "ready") throw new Error("Expected a third disclosure");
    expect(await f.service.cancelPrepare({ operation: "cancelPrepare", prepareId: third.prepareId })).toBe("cancelled");

    expect(spy.offenders()).toEqual([]);
    expectTreeUnchanged(before, await treeFingerprint(f.root));
    // The unselected second book, the threads sentinel and the conflict candidate are all inside the fingerprint.
    expect(spy.offenders()).not.toContain("library.service.createBook");
    expect(f.transport.calls).toHaveLength(1);
  });

  test("a failure row never calls a writer and never changes the tree", async () => {
    const f = await fixture();
    const spy = spyOnLibraryWriters(f.library);
    const before = await treeFingerprint(f.root);
    const result = await prepared(f);
    f.transport.error = new ProviderError("refusal", "PRIVATE_PROVIDER_BODY");
    await expect(f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .resolves.toEqual({ kind: "failed", reason: "refused" });
    expect(f.transport.calls).toHaveLength(1);
    expect(spy.offenders()).toEqual([]);
    expectTreeUnchanged(before, await treeFingerprint(f.root));
  });

  test("a spurious AbortError with no stop signal is a provider failure, never a stop", async () => {
    const f = await fixture();
    const spy = spyOnLibraryWriters(f.library);
    const before = await treeFingerprint(f.root);
    const result = await prepared(f);
    f.transport.error = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .resolves.toEqual({ kind: "failed", reason: "provider" });
    expect(f.transport.calls).toHaveLength(1);
    expect(f.transport.calls[0]?.signal.aborted).toBe(false);
    expect(spy.offenders()).toEqual([]);
    expectTreeUnchanged(before, await treeFingerprint(f.root));
  });

  test("an output of exactly 262144 bytes completes; one byte more fails as overflow with one call", async () => {
    const exact = await fixture();
    const ready = await prepared(exact);
    const base = outputFor(ready.envelope);
    const padding = REVIEW_LIMITS.outputBytes - utf8Bytes(base);
    expect(padding).toBeGreaterThan(0);
    const exactOutput = base + " ".repeat(padding);
    expect(utf8Bytes(exactOutput)).toBe(REVIEW_LIMITS.outputBytes);
    const beforeExact = await treeFingerprint(exact.root);
    exact.transport.output = () => exactOutput;
    await expect(exact.service.start({ operation: "start", requestId: ready.requestId, scopeDigest: ready.scopeDigest }))
      .resolves.toMatchObject({ kind: "completed" });
    expect(exact.transport.calls).toHaveLength(1);
    expectTreeUnchanged(beforeExact, await treeFingerprint(exact.root));

    const over = await fixture();
    const readyOver = await prepared(over);
    const overBase = outputFor(readyOver.envelope);
    const overPadding = REVIEW_LIMITS.outputBytes + 1 - utf8Bytes(overBase);
    const overOutput = overBase + " ".repeat(overPadding);
    expect(utf8Bytes(overOutput)).toBe(REVIEW_LIMITS.outputBytes + 1);
    const beforeOver = await treeFingerprint(over.root);
    over.transport.output = () => overOutput;
    await expect(over.service.start({ operation: "start", requestId: readyOver.requestId, scopeDigest: readyOver.scopeDigest }))
      .resolves.toEqual({ kind: "failed", reason: "overflow" });
    expect(over.transport.calls).toHaveLength(1);
    expectTreeUnchanged(beforeOver, await treeFingerprint(over.root));
  });

  test("a contradiction claim outside continuity fails as malformed with one call and an unchanged tree", async () => {
    const f = await fixture();
    const spy = spyOnLibraryWriters(f.library);
    const result = await prepared(f);
    f.transport.output = (envelope) => JSON.stringify({
      runId: envelope.requestId, readerId: envelope.profile?.id, readerVersion: envelope.profile?.version,
      findings: [{ findingId: "f-1", category: "clarity", readerId: envelope.profile?.id, readerVersion: envelope.profile?.version,
        runId: envelope.requestId, interpretation: "Synthetic contradiction claim.", claim: "contradiction", evidence: [] }]
    });
    const before = await treeFingerprint(f.root);
    await expect(f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .resolves.toEqual({ kind: "failed", reason: "malformed" });
    expect(f.transport.calls).toHaveLength(1);
    expect(spy.offenders()).toEqual([]);
    expectTreeUnchanged(before, await treeFingerprint(f.root));
  });

  test("a contract-violating transport result is malformed, never a crash or a retry", async () => {
    const f = await fixture();
    const result = await prepared(f);
    f.transport.rawResult = { output: undefined };
    const before = await treeFingerprint(f.root);
    await expect(f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .resolves.toEqual({ kind: "failed", reason: "malformed" });
    expect(f.transport.calls).toHaveLength(1);
    expectTreeUnchanged(before, await treeFingerprint(f.root));
  });

  test("a refusal-shaped body delivered as a successful response fails as malformed, not refused", async () => {
    const f = await fixture();
    const result = await prepared(f);
    f.transport.output = () => JSON.stringify({ error: { message: "I cannot help with that request." } });
    const before = await treeFingerprint(f.root);
    await expect(f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .resolves.toEqual({ kind: "failed", reason: "malformed" });
    expect(f.transport.calls).toHaveLength(1);
    expectTreeUnchanged(before, await treeFingerprint(f.root));
  });

  test("stop landing during output validation discards the run deterministically", async () => {
    const f = await fixture();
    const spy = spyOnLibraryWriters(f.library);
    const result = await prepared(f);
    const before = await treeFingerprint(f.root);
    f.transport.callDuringRun = () => {
      // stop() has no awaits: its body runs synchronously, aborting the controller and removing
      // the active entry before transport.run returns control to the service.
      void f.service.stop({ operation: "stop", requestId: result.requestId });
    };
    await expect(f.service.start({ operation: "start", requestId: result.requestId, scopeDigest: result.scopeDigest }))
      .resolves.toEqual({ kind: "stopped" });
    expect(f.transport.calls).toHaveLength(1);
    expect(f.transport.calls[0]?.signal.aborted).toBe(true);
    // The in-flight stop consumed the active entry, so a late stop reports unconfirmed.
    await expect(f.service.stop({ operation: "stop", requestId: result.requestId })).resolves.toBe("unconfirmed");
    expect(spy.offenders()).toEqual([]);
    expectTreeUnchanged(before, await treeFingerprint(f.root));
  });
});
