/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { BookDetail, BookMeta } from "@ai-book-studio/core/schema";
import { buildReviewEnvelope, reviewResourceUsage, type ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import { buildReaderRun, type ReaderRun } from "@ai-book-studio/core/review/findings";
import { builtinReaderProfile } from "@ai-book-studio/core/review/profiles";
import type { ReaderReviewApi, ReaderReviewPrepareResult } from "@ai-book-studio/core/review/reader-api";
import type { Result } from "@ai-book-studio/core/ipc";
import { captureChapterSource } from "@ai-book-studio/core/review/sources";
import { citation, input, saved, selectedEnd, selectedStart, stamp } from "../../../packages/core/tests/review/scoped-fixtures";
import { citationNavigationCopy, sourceCheckCopy, sourceStatusCopy, staleSourceStatusCopy } from "../../../packages/app/src/components/reader-review/contracts";
import { mountDom, unmountDom } from "./support/dom";

let testing!: typeof import("@testing-library/react/pure");
import type { ReaderReviewHostProps } from "@ai-book-studio/app/components/reader-review/ReaderReviewHost";

let ReaderReviewHost!: typeof import("@ai-book-studio/app/components/reader-review/ReaderReviewHost").ReaderReviewHost;

beforeAll(async () => {
  testing = await mountDom();
  ({ ReaderReviewHost } = await import("@ai-book-studio/app/components/reader-review/ReaderReviewHost"));
});
afterEach(() => testing.cleanup());
afterAll(async () => { await unmountDom(); });

const details: BookDetail = {
  book: { id: saved.bookId, title: "Synthetic book" } as BookMeta,
  chapters: [
    { id: saved.chapterId, title: "The arrival", order: 1, arc: "middle", purpose: "", synopsis: "", notes: "",
      isPrologue: false, color: null, version: 3, createdAt: stamp, updatedAt: stamp, content: saved.body,
      path: "chapter-01.md", wordCount: 1_478, hash: saved.hash },
    { id: "ch_654321", title: "The gate", order: 2, arc: "middle", purpose: "", synopsis: "", notes: "",
      isPrologue: false, color: null, version: 1, createdAt: stamp, updatedAt: stamp, content: "The gate opened.\n",
      path: "chapter-02.md", wordCount: 902, hash: "b".repeat(64) }
  ],
  chapterReadIssues: [{ fileName: "chapter-03.md", order: 3, reason: "unreadable" }]
};

async function envelope(consent = true): Promise<ReviewEnvelope> {
  const base = input();
  const chapter = captureChapterSource({
    sourceId: "source-1",
    saved: { bookId: saved.bookId, chapterId: saved.chapterId, version: 3, hash: saved.hash, body: saved.body },
    bookTitle: "Synthetic book", title: "The arrival", position: 1, capturedAt: stamp,
    ranges: [{ start: selectedStart, end: selectedEnd }]
  });
  return buildReviewEnvelope({
    ...base, kind: "reader-review", profile: await builtinReaderProfile("alpha"),
    books: base.books.map((book) => ({ ...book, consentSatisfied: consent })), sources: [chapter]
  });
}

async function completed(value: ReviewEnvelope): Promise<ReaderRun> {
  return buildReaderRun({
    envelope: value, runId: value.requestId, startedAt: stamp, completedAt: stamp,
    output: JSON.stringify({ runId: value.requestId, readerId: value.profile?.id, readerVersion: value.profile?.version,
      findings: [{ findingId: "finding-1", category: "clarity", readerId: value.profile?.id,
        readerVersion: value.profile?.version, runId: value.requestId, interpretation: "The arrival may feel abrupt.",
        claim: "observation", evidence: [citation()] }] })
  });
}

function prepareResult(value: ReviewEnvelope): ReaderReviewPrepareResult {
  return {
    kind: "ready", prepareId: "prepare-1", requestId: value.requestId, scopeDigest: value.scopeDigest,
    envelope: value,
    terms: [{ bookId: saved.bookId, termsRevision: value.books[0]?.termsRevision ?? "terms-1",
      dataUse: "Selected text is sent to Synthetic provider for this one review.",
      training: "The provider reports that this model does not train on prompts and completions." }],
    connection: { id: "connection-1", label: "Work account", providerName: "Synthetic provider", modelName: "Synthetic model" },
    priceFacts: { kind: "metered", inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10, asOf: stamp },
    usage: reviewResourceUsage(value)
  };
}

function render(options: { value?: ReviewEnvelope; supported?: boolean; startData?: unknown; onNavigate?: Parameters<typeof ReaderReviewHost>[0]["onNavigate"] } = {}) {
  const value = options.value;
  const loadBook = mock(async () => details);
  const prepare = mock(async (): Promise<Result<ReaderReviewPrepareResult>> => value
    ? { ok: true, data: prepareResult(value) }
    : { ok: false, error: { code: "internal", message: "No prepared value" } });
  const start = mock(async () => ({ ok: true as const, data: (options.startData ?? { kind: "blocked" as const, reason: "changed" as const }) }));
  const stop = mock(async () => ({ ok: true as const, data: "not-started" as const }));
  const cancelPrepare = mock(async () => ({ ok: true as const, data: "cancelled" as const }));
  const support = mock(async () => ({ ok: true as const, data: { supported: options.supported ?? true, reason: (options.supported ?? true) ? null : "unsupported-host" as const } }));
  const api: ReaderReviewApi = {
    support,
    prepare: prepare as unknown as ReaderReviewApi["prepare"],
    start: start as unknown as ReaderReviewApi["start"],
    stop: stop as unknown as ReaderReviewApi["stop"],
    cancelPrepare: cancelPrepare as unknown as ReaderReviewApi["cancelPrepare"]
  };
  const view = testing.render(<ReaderReviewHost bookId={saved.bookId} api={api} loadBook={loadBook} onNavigate={options.onNavigate} />);
  return { ...view, api, loadBook, prepare, start, stop, cancelPrepare, support };
}
function body() { return testing.within(document.body); }
function click(name: string) { testing.fireEvent.click(body().getByRole("button", { name })); }
function evidenceButton() {
  const button = body().getByRole("button", { name: /^Show exact passage for / });
  return button;
}

async function openAndWait(view: ReturnType<typeof render>) {
  click("Open reader review");
  await testing.waitFor(() => expect(body().getByRole("group", { name: "Saved chapters" })).toBeTruthy());
  return view;
}

describe("mounted reader review entry and selected-source picker", () => {
  test("closed entry opens the picker, moves focus to the heading and calls no prepare or start", async () => {
    const view = render({ value: await envelope() });
    expect(body().getByRole("button", { name: "Open reader review" })).toBeTruthy();
    expect(view.prepare).not.toHaveBeenCalled();
    expect(view.start).not.toHaveBeenCalled();
    await openAndWait(view);
    const heading = body().getByRole("heading", { name: "Structured reader review" });
    expect(document.activeElement).toBe(heading);
    expect(document.activeElement?.textContent).toContain("Structured reader review");
    expect(body().getByText(/Chapter 1: The arrival/)).toBeTruthy();
    expect(body().getByText(/Saved version 3 · 1,478 words/)).toBeTruthy();
    expect(body().getByText(/Saved version 1 · 902 words/)).toBeTruthy();
    expect(body().getByText("Unavailable · chapter-03.md · This file could not be read. It is not included.")).toBeTruthy();
    expect((body().getByRole("button", { name: "Prepare review" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.prepare).not.toHaveBeenCalled();
    expect(view.start).not.toHaveBeenCalled();
  });

  test("Alpha is the default lens; Beta and chapters are native controls with no automatic action", async () => {
    const view = render({ value: await envelope() });
    await openAndWait(view);
    expect((body().getByRole("radio", { name: /Alpha reader/ }) as HTMLInputElement).checked).toBe(true);
    expect((body().getByRole("radio", { name: /Beta reader/ }) as HTMLInputElement).checked).toBe(false);
    testing.fireEvent.click(body().getByRole("radio", { name: /Beta reader/ }));
    expect((body().getByRole("radio", { name: /Beta reader/ }) as HTMLInputElement).checked).toBe(true);
    testing.fireEvent.click(body().getByRole("checkbox", { name: /Chapter 1/ }));
    expect((body().getByRole("button", { name: "Prepare review" }) as HTMLButtonElement).disabled).toBe(false);
    expect(view.prepare).not.toHaveBeenCalled();
    expect(view.start).not.toHaveBeenCalled();
  });

  test("Prepare shows the exact disclosure and provider-named Start; missing consent disables Start", async () => {
    const view = render({ value: await envelope(false) });
    await openAndWait(view);
    testing.fireEvent.click(body().getByRole("checkbox", { name: /Chapter 1/ }));
    click("Prepare review");
    await testing.waitFor(() => expect(body().getByText("Start with Synthetic provider")).toBeTruthy());
    const disclosure = body().getByRole("region", { name: "Outgoing review disclosure" });
    expect(disclosure.textContent).toContain("Provider: Synthetic provider · Model: Synthetic model");
    expect(disclosure.textContent).toContain("Connection: Work account");
    expect(disclosure.textContent).toContain("Estimated cost: Unknown · Not a spending cap");
    expect(disclosure.textContent).toContain("Input $1.25 per million tokens");
    expect(disclosure.textContent).toContain("Context fit: Unknown");
    expect(disclosure.textContent).toContain("Tools: None offered; the selected text is included up front.");
    expect(disclosure.textContent).toContain("Selected scope: 1 book · 1 source item");
    expect(disclosure.textContent).toContain("Required consent: Missing");
    expect(disclosure.textContent).toContain("not a legal guarantee");
    expect((body().getByRole("button", { name: "Start with Synthetic provider" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.start).not.toHaveBeenCalled();
  });

  test("an unsupported host refuses before reading the book list", async () => {
    const view = render({ supported: false });
    click("Open reader review");
    await testing.waitFor(() => expect(body().getByText(/unavailable on this host/)).toBeTruthy());
    expect(view.loadBook).not.toHaveBeenCalled();
    expect(view.prepare).not.toHaveBeenCalled();
  });

  test("closing discards the volatile surface and returns focus to the opener", async () => {
    const view = render({ value: await envelope() });
    await openAndWait(view);
    testing.fireEvent.click(body().getByRole("checkbox", { name: /Chapter 1/ }));
    click("Prepare review");
    await testing.waitFor(() => expect(body().getByRole("region", { name: "Outgoing review disclosure" })).toBeTruthy());
    click("Close review");
    expect(body().queryByRole("region", { name: "Outgoing review disclosure" })).toBeNull();
    await testing.waitFor(() => expect(document.activeElement).toBe(body().getByRole("button", { name: "Open reader review" })));
    expect(view.cancelPrepare).toHaveBeenCalledWith({ prepareId: "prepare-1" });
    expect(view.start).not.toHaveBeenCalled();
  });

  test("changing the selected scope clears a disclosure and cancels the prepared request", async () => {
    const view = render({ value: await envelope() });
    await openAndWait(view);
    testing.fireEvent.click(body().getByRole("checkbox", { name: /Chapter 1/ }));
    click("Prepare review");
    await testing.waitFor(() => expect(body().getByRole("region", { name: "Outgoing review disclosure" })).toBeTruthy());
    testing.fireEvent.click(body().getByRole("checkbox", { name: /Chapter 2/ }));
    await testing.waitFor(() => expect(body().queryByRole("region", { name: "Outgoing review disclosure" })).toBeNull());
    expect(body().getByRole("status").textContent).toContain("disclosure changed");
    expect(view.cancelPrepare).toHaveBeenCalledWith({ prepareId: "prepare-1" });
    expect(view.start).not.toHaveBeenCalled();
  });

  test("a host prepare refusal shows its exact copy and detail without starting", async () => {
    const value = await envelope();
    const view = render({ value });
    await openAndWait(view);
    view.prepare.mockImplementationOnce(async () => ({ ok: true, data: { kind: "blocked", reason: "scope-too-large",
      detail: "The selected source text is over 65,536 bytes." } }));
    testing.fireEvent.click(body().getByRole("checkbox", { name: /Chapter 1/ }));
    click("Prepare review");
    await testing.waitFor(() => expect(body().getByRole("status").textContent).toContain("Nothing was shortened or sent."));
    expect(body().getByRole("status").textContent).toContain("The selected source text is over 65,536 bytes.");
    expect(body().queryByRole("button", { name: /Start with/ })).toBeNull();
    expect(view.start).not.toHaveBeenCalled();
  });
});

describe("explicit saved-source checks and navigation forwarding", () => {
  async function started(options: { onNavigate?: Parameters<typeof ReaderReviewHost>[0]["onNavigate"] } = {}) {
    const value = await envelope();
    const run = await completed(value);
    const view = render({ value, startData: { kind: "completed", run }, ...options });
    await openAndWait(view);
    testing.fireEvent.click(body().getByRole("checkbox", { name: /Chapter 1/ }));
    click("Prepare review");
    await testing.waitFor(() => expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy());
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getByRole("article", { name: "Reader run request-1" })).toBeTruthy());
    return { view, value, run };
  }

  test("no check reads the book automatically; the explicit check performs one read and no provider call", async () => {
    const { view } = await started();
    expect(view.loadBook).toHaveBeenCalledTimes(1);
    expect(view.start).toHaveBeenCalledTimes(1);
    click("Check current sources");
    await testing.waitFor(() => expect(body().getByRole("status").textContent).toBe(sourceCheckCopy.currentHistorical));
    expect(view.loadBook).toHaveBeenCalledTimes(2);
    expect(view.start).toHaveBeenCalledTimes(1);
    expect(body().getByRole("article").textContent).toContain(sourceStatusCopy.current);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(false);
  });

  test("a changed or failed check marks the report historical and disables navigation without a provider call", async () => {
    const { view } = await started();
    view.loadBook.mockImplementationOnce(async () => ({
      ...details,
      chapters: details.chapters.map((chapter) => chapter.id === saved.chapterId ? { ...chapter, version: 4 } : chapter)
    }));
    click("Check current sources");
    await testing.waitFor(() => expect(body().getByRole("status").textContent).toBe(sourceCheckCopy.staleOrUnavailable));
    expect(body().getByRole("article").textContent).toContain(staleSourceStatusCopy(1, 1));
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    expect(view.start).toHaveBeenCalledTimes(1);

    view.loadBook.mockImplementationOnce(async () => { throw new Error("PRIVATE_CHECK_FAILURE_SENTINEL"); });
    click("Check current sources");
    await testing.waitFor(() => expect(body().getByRole("status").textContent).toBe(sourceCheckCopy.failedHistorical));
    expect(body().getByRole("article").textContent).toContain(sourceStatusCopy.checkFailed);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain("PRIVATE_CHECK_FAILURE_SENTINEL");
  });

  test("a checked-current citation forwards one navigation request to the host seam", async () => {
    const onNavigate = mock(async (_input: Parameters<NonNullable<ReaderReviewHostProps["onNavigate"]>>[0]) => "selected" as const);
    const { view } = await started({ onNavigate });
    click("Check current sources");
    await testing.waitFor(() => expect(body().getByRole("status").textContent).toBe(sourceCheckCopy.currentHistorical));
    testing.fireEvent.click(evidenceButton());
    await testing.waitFor(() => expect(body().getByRole("status").textContent).toBe(citationNavigationCopy.selected));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0]?.[0].citation).toEqual(citation());
    expect(onNavigate.mock.calls[0]?.[0].run.runId).toBe("request-1");
    expect(onNavigate.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(view.start).toHaveBeenCalledTimes(1);
  });
});
