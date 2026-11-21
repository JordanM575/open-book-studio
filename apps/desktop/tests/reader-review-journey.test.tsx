/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalogue } from "@ai-book-studio/core/providers/models";
import { ProviderError, type ConnectionSummary, type ModelInfo, type StoredCredential } from "@ai-book-studio/core/providers/types";
import type { ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import type { ReaderReviewApi } from "@ai-book-studio/core/review/reader-api";
import { Library } from "../src/main/library/store";
import { ReaderReviewService, type ReviewProviders } from "../src/main/review/service";
import type { ReviewTransport } from "../src/main/review/transport";
import { citationNavigationCopy, sourceCheckCopy, sourceStatusCopy, staleSourceStatusCopy, unavailableSourceStatusCopy } from "../../../packages/app/src/components/reader-review/contracts";
import { mountDom, unmountDom } from "./support/dom";

const stamp = "2026-11-07T12:00:00Z";
const roots: string[] = [];
let testing!: typeof import("@testing-library/react/pure");
import type { ReaderReviewHostProps } from "@ai-book-studio/app/components/reader-review/ReaderReviewHost";

let ReaderReviewHost!: typeof import("@ai-book-studio/app/components/reader-review/ReaderReviewHost").ReaderReviewHost;

beforeAll(async () => {
  testing = await mountDom();
  ({ ReaderReviewHost } = await import("@ai-book-studio/app/components/reader-review/ReaderReviewHost"));
});
afterEach(() => testing.cleanup());
afterAll(async () => {
  await unmountDom();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
  connections: ConnectionSummary[];
  catalogue: Catalogue;
  constructor(connections: ConnectionSummary[], catalogue: Catalogue) { this.connections = connections; this.catalogue = catalogue; }
  async list(): Promise<ConnectionSummary[]> { return this.connections; }
  async models(_connectionId: string): Promise<Catalogue> { return this.catalogue; }
  async credential(connectionId: string): Promise<StoredCredential> {
    const found = this.connections.find((entry) => entry.id === connectionId);
    if (!found) throw new ProviderError("not-found", "No synthetic connection.");
    return { ...found, secret: "synthetic-secret" };
  }
}

class FakeTransport implements ReviewTransport {
  readonly calls: Array<{ envelope: ReviewEnvelope; credential: StoredCredential; signal: AbortSignal }> = [];
  error: unknown = null;
  pending: Promise<{ output: string }> | null = null;
  output: ((envelope: ReviewEnvelope) => string) | null = null;
  started = deferred<void>();
  async run(input: { envelope: ReviewEnvelope; credential: StoredCredential; signal: AbortSignal }): Promise<{ output: string }> {
    this.calls.push(input);
    this.started.resolve();
    if (this.pending) return this.pending;
    if (this.error) throw this.error;
    return { output: this.output ? this.output(input.envelope) : outputFor(input.envelope) };
  }
}

function evidenceFor(envelope: ReviewEnvelope) {
  const source = envelope.sources[0];
  if (source?.kind !== "chapter") throw new Error("Missing synthetic chapter source");
  const segment = source.segments[0];
  if (!segment) throw new Error("Missing synthetic selected segment");
  return { kind: "chapter" as const, sourceId: source.sourceId, identity: source.identity,
    start: segment.start, end: segment.end, quote: segment.text };
}
function outputWithEvidence(envelope: ReviewEnvelope): string {
  return JSON.stringify({ runId: envelope.requestId, readerId: envelope.profile?.id, readerVersion: envelope.profile?.version,
    findings: [{ findingId: "finding-1", category: "clarity", readerId: envelope.profile?.id,
      readerVersion: envelope.profile?.version, runId: envelope.requestId,
      interpretation: "Synthetic reader impression.", claim: "observation", evidence: [evidenceFor(envelope)] }] });
}

async function fixture(options: { model?: Partial<ModelInfo>; allowContributorTraining?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "studio-reader-journey-"));
  roots.push(root);
  const library = await Library.open(root);
  const book = await library.createBook({ title: "Synthetic journey book" });
  const chapter = await library.createChapter(book.id, { title: "The arrival", content: "Synthetic journey prose for the selected chapter." });
  const selectedConnection = connection();
  const selectedModel = model(options.model);
  await library.updateBook(book.id, {
    defaultProvider: selectedConnection.provider, defaultConnectionId: selectedConnection.id, defaultModelId: selectedModel.id,
    ...(options.allowContributorTraining ? { allowContributorTraining: true } : {})
  });
  const providers = new FakeProviders([selectedConnection], { models: [selectedModel], fetchedAt: stamp });
  const transport = new FakeTransport();
  const service = new ReaderReviewService({ library: () => library, providers, transport, now: () => stamp });
  const calls = { prepare: 0, start: 0, stop: 0, cancelPrepare: 0, loadBook: 0 };
  const api: ReaderReviewApi = {
    support: async () => ({ ok: true, data: await service.support() }),
    prepare: async (request) => { calls.prepare++; return { ok: true, data: await service.prepare({ operation: "prepare", ...request }) }; },
    start: async (request) => { calls.start++; return { ok: true, data: await service.start({ operation: "start", ...request }) }; },
    stop: async (request) => { calls.stop++; return { ok: true, data: await service.stop({ operation: "stop", ...request }) }; },
    cancelPrepare: async (request) => { calls.cancelPrepare++; return { ok: true, data: await service.cancelPrepare({ operation: "cancelPrepare", ...request }) }; }
  };
  return { root, library, book, chapter, providers, transport, service, api, calls };
}

function body() { return testing.within(document.body); }
function click(name: string) { testing.fireEvent.click(body().getByRole("button", { name })); }
function status() { return body().getByRole("status").textContent ?? ""; }

function evidenceButton() {
  return body().getByRole("button", { name: /^Show exact passage for / });
}
async function openAndSelect(f: Awaited<ReturnType<typeof fixture>>, options: { onNavigate?: Parameters<typeof ReaderReviewHost>[0]["onNavigate"] } = {}) {
  testing.render(<ReaderReviewHost bookId={f.book.id} api={f.api} onNavigate={options.onNavigate}
    loadBook={async (bookId) => { f.calls.loadBook++; return f.library.readBook(bookId); }} />);
  click("Open reader review");
  await testing.waitFor(() => expect(body().getByRole("group", { name: "Saved chapters" })).toBeTruthy());
  testing.fireEvent.click(body().getByRole("checkbox", { name: /Chapter 1/ }));
}
async function disclose() {
  click("Prepare review");
  await testing.waitFor(() => expect(body().getByRole("button", { name: /Start with/ })).toBeTruthy());
}
async function start() {
  click("Start with Meta");
  await testing.waitFor(() => expect(status()).toContain("completed"));
}
async function hashes(f: Awaited<ReturnType<typeof fixture>>) {
  const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  return Promise.all([
    sha(join(f.root, "books", f.book.id, "book.json")),
    sha(join(f.root, "books", f.book.id, "chapters", f.chapter.path))
  ]);
}

describe("mounted selected-source reader journey", () => {
  test("open, select a saved chapter, prepare, inspect, Start and complete with unchanged bytes", async () => {
    const f = await fixture();
    const before = await hashes(f);
    await openAndSelect(f);
    await disclose();
    const disclosure = body().getByRole("region", { name: "Outgoing review disclosure" });
    expect(disclosure.textContent).toContain(f.chapter.content.trim());
    expect(disclosure.textContent).toContain("Provider: Meta · Model: Muse Spark 1.3");
    expect(disclosure.textContent).toContain("Estimated cost: Unknown · Not a spending cap");
    expect(disclosure.textContent).toContain("Required consent: Satisfied");
    expect(f.transport.calls).toHaveLength(0);
    await start();
    expect(body().getByRole("article", { name: /Reader run review-/ })).toBeTruthy();
    expect(f.transport.calls).toHaveLength(1);
    expect(f.calls.start).toBe(1);
    expect(await hashes(f)).toEqual(before);
  });

  test("closing a prepared disclosure cancels it without a provider call", async () => {
    const f = await fixture();
    const before = await hashes(f);
    await openAndSelect(f);
    await disclose();
    click("Close review");
    await testing.waitFor(() => expect(body().getByRole("button", { name: "Open reader review" })).toBeTruthy());
    expect(f.calls.cancelPrepare).toBe(1);
    expect(f.transport.calls).toHaveLength(0);
    expect(await hashes(f)).toEqual(before);
  });

  test("missing contributor consent keeps the disclosure but sends nothing", async () => {
    const f = await fixture({ model: { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor",
      trainingOnData: true, note: "Contributor mode: Meta may use this book's prompts and responses to train its models." } });
    const before = await hashes(f);
    await openAndSelect(f);
    await disclose();
    const startButton = body().getByRole("button", { name: "Start with Meta" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    testing.fireEvent.click(startButton);
    expect(f.calls.start).toBe(0);
    expect(f.transport.calls).toHaveLength(0);
    expect(body().getByRole("region", { name: "Outgoing review disclosure" }).textContent).toContain("Required consent: Missing");
    expect(await hashes(f)).toEqual(before);
  });

  test("a saved source changed after Prepare refuses Start with zero sends", async () => {
    const f = await fixture();
    await openAndSelect(f);
    await disclose();
    await f.library.saveChapter(f.book.id, f.chapter.id, "Changed after the disclosure.", {
      baseVersion: f.chapter.version, baseHash: f.chapter.hash
    });
    click("Start with Meta");
    await testing.waitFor(() => expect(status()).toContain("disclosure changed"));
    expect(f.transport.calls).toHaveLength(0);
    expect(body().queryByRole("button", { name: /Start with/ })).toBeNull();
  });

  test("a provider failure is incomplete, redacted and not retried", async () => {
    const f = await fixture();
    await openAndSelect(f);
    await disclose();
    f.transport.error = new ProviderError("rate-limit", "PRIVATE_PROVIDER_SENTINEL");
    click("Start with Meta");
    await testing.waitFor(() => expect(status()).toContain("provider request failed"));
    expect(document.body.textContent).not.toContain("PRIVATE_PROVIDER_SENTINEL");
    expect(body().queryByRole("article")).toBeNull();
    expect(f.transport.calls).toHaveLength(1);
  });

  test("Stop during the one provider call is honest, one call and no retry", async () => {
    const f = await fixture();
    await openAndSelect(f);
    await disclose();
    const pending = deferred<{ output: string }>();
    f.transport.pending = pending.promise;
    click("Start with Meta");
    await testing.waitFor(() => expect(status()).toContain("Review in progress"));
    await f.transport.started.promise;
    click("Stop review");
    await testing.waitFor(() => expect(status()).toContain("text already sent cannot be recalled"));
    await testing.waitFor(() => expect(f.transport.calls[0]?.signal.aborted).toBe(true));
    expect(f.calls.stop).toBe(1);
    expect(f.transport.calls).toHaveLength(1);
    pending.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await testing.act(async () => { await pending.promise.catch(() => undefined); });
    expect(f.transport.calls).toHaveLength(1);
    expect(body().queryByRole("article")).toBeNull();
  });

  test("keyboard-only selection and Prepare use native controls and keep focus in the review", async () => {
    const f = await fixture();
    await openAndSelect(f);
    const prepare = body().getByRole("button", { name: "Prepare review" }) as HTMLButtonElement;
    expect(prepare.disabled).toBe(false);
    prepare.focus();
    testing.fireEvent.click(prepare);
    await testing.waitFor(() => expect(body().getByRole("region", { name: "Outgoing review disclosure" })).toBeTruthy());
    expect(document.activeElement).toBe(body().getByRole("status"));
    expect(body().getAllByRole("radio")).toHaveLength(2);
    expect(body().getAllByRole("checkbox").length).toBeGreaterThan(0);
  });
});

describe("explicit source check and editor navigation seam", () => {
  test("no automatic check; one explicit read enables the exact current passage with one transport call and unchanged bytes", async () => {
    const f = await fixture();
    f.transport.output = outputWithEvidence;
    const onNavigate = mock(async (_input: Parameters<NonNullable<ReaderReviewHostProps["onNavigate"]>>[0]) => "selected" as const);
    const before = await hashes(f);
    await openAndSelect(f, { onNavigate });
    expect(f.calls.loadBook).toBe(1);
    await disclose();
    expect(f.calls.loadBook).toBe(1);
    await start();
    expect(f.calls.loadBook).toBe(1);
    expect(f.transport.calls).toHaveLength(1);
    expect(body().getByRole("article").textContent).toContain(sourceStatusCopy.notChecked);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    click("Check current sources");
    await testing.waitFor(() => expect(status()).toBe(sourceCheckCopy.currentHistorical));
    expect(f.calls.loadBook).toBe(2);
    expect(f.transport.calls).toHaveLength(1);
    expect(body().getByRole("article").textContent).toContain(sourceStatusCopy.current);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(false);
    testing.fireEvent.click(evidenceButton());
    await testing.waitFor(() => expect(status()).toBe(citationNavigationCopy.selected));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0]?.[0].run.runId).toBe(f.transport.calls[0]?.envelope.requestId);
    expect(body().getByRole("article").querySelector("blockquote")?.textContent).toBe(f.chapter.content);
    expect(await hashes(f)).toEqual(before);
    expect(f.transport.calls).toHaveLength(1);
  });

  test("stale, restored and missing sources stay historical; navigation disables without another provider call", async () => {
    const f = await fixture();
    f.transport.output = outputWithEvidence;
    const onNavigate = mock(async (_input: Parameters<NonNullable<ReaderReviewHostProps["onNavigate"]>>[0]) => "selected" as const);
    const chapterPath = join(f.root, "books", f.book.id, "chapters", f.chapter.path);
    const originalBytes = await readFile(chapterPath);
    const before = await hashes(f);
    await openAndSelect(f, { onNavigate });
    await disclose();
    await start();
    const quote = body().getByRole("article").querySelector("blockquote")?.textContent;
    click("Check current sources");
    await testing.waitFor(() => expect(status()).toBe(sourceCheckCopy.currentHistorical));

    await f.library.saveChapter(f.book.id, f.chapter.id, "Changed synthetic journey prose.", {
      baseVersion: f.chapter.version, baseHash: f.chapter.hash
    });
    click("Check current sources");
    await testing.waitFor(() => expect(status()).toBe(sourceCheckCopy.staleOrUnavailable));
    expect(body().getByRole("article").textContent).toContain(staleSourceStatusCopy(1, 1));
    expect(body().getByRole("article").querySelector("blockquote")?.textContent).toBe(quote);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);

    await writeFile(chapterPath, originalBytes);
    click("Check current sources");
    await testing.waitFor(() => expect(status()).toBe(sourceCheckCopy.currentHistorical));
    expect(body().getByRole("article").querySelector("blockquote")?.textContent).toBe(quote);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(false);
    expect(await hashes(f)).toEqual(before);

    await f.library.deleteChapter(f.book.id, f.chapter.id);
    click("Check current sources");
    await testing.waitFor(() => expect(status()).toBe(sourceCheckCopy.staleOrUnavailable));
    expect(body().getByRole("article").textContent).toContain(unavailableSourceStatusCopy(1, 1));
    expect(body().getByRole("article").querySelector("blockquote")?.textContent).toBe(quote);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(f.transport.calls).toHaveLength(1);
  });

  test("a host navigation refusal disables the link, keeps the quote and never sends again", async () => {
    const f = await fixture();
    f.transport.output = outputWithEvidence;
    const onNavigate = mock(async (_input: Parameters<NonNullable<ReaderReviewHostProps["onNavigate"]>>[0]) => "stale" as const);
    const before = await hashes(f);
    await openAndSelect(f, { onNavigate });
    await disclose();
    await start();
    click("Check current sources");
    await testing.waitFor(() => expect(status()).toBe(sourceCheckCopy.currentHistorical));
    testing.fireEvent.click(evidenceButton());
    await testing.waitFor(() => expect(status()).toBe(citationNavigationCopy.stale));
    expect(body().getByRole("article").querySelector("blockquote")?.textContent).toBe(f.chapter.content);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(f.transport.calls).toHaveLength(1);
    expect(await hashes(f)).toEqual(before);
  });
});
