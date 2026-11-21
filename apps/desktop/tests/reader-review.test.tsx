/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mountDom, unmountDom } from "./support/dom";
import { buildReviewEnvelope, type CurrentSource, type EnvelopeInput, type ReviewEnvelope } from "@ai-book-studio/core/review/envelope";
import { buildReaderRun, type ReaderRun } from "@ai-book-studio/core/review/findings";
import { builtinReaderProfile, editReaderProfile } from "@ai-book-studio/core/review/profiles";
import { captureBibleSource, captureChapterSource } from "@ai-book-studio/core/review/sources";
import { citation, currentSources, input, saved, selectedEnd, selectedStart, source, stamp } from "../../../packages/core/tests/review/scoped-fixtures";
import { citationNavigationCopy, failureCopy, revalidationFailureCopy, sourceCheckCopy, sourceStatusCopy, staleSourceStatusCopy, unavailableSourceStatusCopy, type PreparationOutcome, type PreparedReaderReview, type ReaderReviewProps, type ReaderSourceCheck, type StartOutcome } from "../../../packages/app/src/components/reader-review/contracts";

let testing!: typeof import("@testing-library/react/pure");
let ReaderReviewPanel!: typeof import("@ai-book-studio/app/components/reader-review/ReaderReviewPanel").ReaderReviewPanel;
let navigationState!: typeof import("@ai-book-studio/app/components/reader-review/ReaderReviewResults").navigationState;
beforeAll(async () => {
  testing = await mountDom();
  ({ ReaderReviewPanel } = await import("@ai-book-studio/app/components/reader-review/ReaderReviewPanel"));
  ({ navigationState } = await import("@ai-book-studio/app/components/reader-review/ReaderReviewResults"));
});
afterEach(() => testing.cleanup());
afterAll(async () => { await unmountDom(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function envelope(requestId = "request-1", overrides: Partial<EnvelopeInput> = {}) {
  return buildReviewEnvelope({ ...input(), kind: "reader-review", profile: await builtinReaderProfile("alpha"), requestId, ...overrides });
}
function prepared(value: ReviewEnvelope): PreparedReaderReview {
  return { envelope: value,
    terms: value.books.map((book) => ({ bookId: book.bookId, termsRevision: book.termsRevision,
      dataUse: "Synthetic data-use terms: sent to the named provider.", training: "Synthetic training terms: no training for this destination." })),
    connection: { id: value.destination.connectionId, label: "Synthetic work account",
      providerName: value.destination.provider, modelName: value.destination.model },
    priceFacts: { kind: "metered", inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10, asOf: stamp } };
}
async function run(value: ReviewEnvelope, evidence: unknown[] = [citation()], interpretation = "The scene may feel abrupt."): Promise<ReaderRun> {
  return buildReaderRun({ envelope: value, runId: value.requestId, startedAt: stamp, completedAt: stamp,
    output: JSON.stringify({ runId: value.requestId, readerId: value.profile?.id, readerVersion: value.profile?.version,
      findings: [{ findingId: "finding-1", category: "clarity", readerId: value.profile?.id,
        readerVersion: value.profile?.version, runId: value.requestId, interpretation, claim: "observation", evidence }] }) });
}
function checked(value: ReviewEnvelope, sources: readonly CurrentSource[] = currentSources(value)): ReaderSourceCheck {
  return { kind: "checked", byScopeDigest: new Map([[value.scopeDigest, sources]]) };
}
function render(value: ReviewEnvelope, overrides: Partial<ReaderReviewProps> = {}) {
  const onPrepare = mock(async (): Promise<PreparationOutcome> => ({ kind: "ready", prepared: prepared(value) }));
  const onStart = mock(async (): Promise<StartOutcome> => ({ kind: "completed", run: await run(value) }));
  const onStop = mock(async (_request: Parameters<ReaderReviewProps["onStop"]>[0]) =>
    _request.requestId ? "stopped" as const : "not-started" as const);
  const onNavigate = mock(async () => "selected" as const);
  const onCheckSources = mock(async (_input: Parameters<NonNullable<ReaderReviewProps["onCheckSources"]>>[0]) => checked(value));
  const onClose = mock(() => {});
  let props: ReaderReviewProps = { open: true, bookId: saved.bookId, viewKey: "view-1", disclosureRevision: "facts-1",
    supported: true, editor: { clean: true, identity: citation().identity },
    onPrepare, onStart, onStop, onNavigate, onCheckSources, onClose, ...overrides };
  const view = testing.render(<ReaderReviewPanel {...props} />);
  return { ...view, onPrepare, onStart, onStop, onNavigate, onCheckSources, onClose,
    update(next: Partial<ReaderReviewProps>) { props = { ...props, ...next }; view.rerender(<ReaderReviewPanel {...props} />); }
  };
}
function body() { return testing.within(document.body); }
function click(name: string) { testing.fireEvent.click(body().getByRole("button", { name })); }
function evidenceButton(index = 0) {
  const button = body().getAllByRole("button", { name: /^Show exact passage for / })[index];
  if (!button) throw new Error("Missing exact-passage button");
  return button;
}
function clickEvidence(index = 0) { testing.fireEvent.click(evidenceButton(index)); }
async function disclose() {
  click("Prepare review");
  await testing.waitFor(() => expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy());
}
async function complete() {
  await disclose();
  click("Start with Synthetic provider");
  await testing.waitFor(() => expect(body().getByRole("article", { name: "Reader run request-1" })).toBeTruthy());
}
async function checkSources() {
  click("Check current sources");
  await testing.waitFor(() => expect(statusText()).toMatch(/Saved sources checked|saved sources could not be checked|disclosure changed|selected source or destination is unavailable/));
}
function statusText() { return body().getByRole("status").textContent ?? ""; }

describe("reviewed disclosure and cancellation regressions", () => {
  test.each(["clean", "identity"] as const)("editor %s accessors are refused without reads by navigation and mounted Strict Mode", async (field) => {
    const { StrictMode } = await import("react");
    const value = await envelope();
    const completed = await run(value);
    let reads = 0;
    const editor: NonNullable<ReaderReviewProps["editor"]> = { clean: true, identity: citation().identity };
    Object.defineProperty(editor, field, { enumerable: true, get() { reads++; return field === "clean" ? true : citation().identity; } });
    const validEditor = { clean: true, identity: citation().identity };
    const sources = currentSources(value);
    // Exercise malformed → valid → malformed facts without React's development prop-diff instrumentation.
    expect(navigationState(completed, citation(), sources, editor)).toBe("stale");
    expect(navigationState(completed, citation(), sources, validEditor)).toBe("ready");
    expect(navigationState(completed, citation(), sources, editor)).toBe("stale");
    expect(reads).toBe(0);
    const onNavigate = mock(async () => "selected" as const);
    const props: ReaderReviewProps = { open: true, bookId: saved.bookId, viewKey: "accessor-view", disclosureRevision: "facts-1",
      supported: true, editor,
      onPrepare: async () => ({ kind: "ready", prepared: prepared(value) }),
      onStart: async () => ({ kind: "completed", run: completed }), onStop: async () => "stopped" as const,
      onNavigate, onCheckSources: async () => checked(value, sources), onClose: () => {} };
    const view = testing.render(<StrictMode><ReaderReviewPanel {...props} /></StrictMode>);
    await complete();
    await checkSources();
    expect(reads).toBe(0);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    clickEvidence();
    expect(onNavigate).not.toHaveBeenCalled();
    view.unmount();
    expect(reads).toBe(0);
    // Separate mount: React development tracks inspect replaced nested props, outside our verifier.
    // Keep the mounted positive control without claiming framework-wide getter-free prop replacement.
    testing.render(<StrictMode><ReaderReviewPanel {...props} editor={validEditor} /></StrictMode>);
    await complete();
    await checkSources();
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(false);
    clickEvidence();
    await testing.waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    expect(reads).toBe(0);
  });

  test("sparse and inherited terms never expose Start", async () => {
    const value = await envelope();
    const data = prepared(value);
    const term = data.terms[0];
    if (!term) throw new Error("Missing fixture terms");
    for (const terms of [Array(1), [Object.create(term)]]) {
      const view = render(value, { onPrepare: async () => ({ kind: "ready", prepared: { ...data, terms } }) });
      click("Prepare review");
      await testing.waitFor(() => expect(statusText()).toContain("disclosure could not be validated"));
      expect(body().queryByRole("button", { name: /Start with/ })).toBeNull();
      expect(view.onStart).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  test.each(["__proto__", "constructor", "toString", "unknown-category"])("malformed reason %s keeps every outcome renderable", async (reason) => {
    const value = await envelope();
    for (const stage of ["prepare", "blocked", "failed"]) {
      const malformed = { kind: stage === "failed" ? "failed" : "blocked", reason } as never;
      const view = render(value, stage === "prepare" ? { onPrepare: async () => malformed } : { onStart: async () => malformed });
      if (stage === "prepare") click("Prepare review");
      else { await disclose(); click("Start with Synthetic provider"); }
      await testing.waitFor(() => expect(statusText()).toContain(stage === "failed" ? "provider request failed" : "unavailable"));
      expect(body().getByRole("button", { name: stage === "failed" ? "Prepare rerun" : "Prepare review" })).toBeTruthy();
      if (stage === "failed") expect(body().getByRole("region", { name: "Reader attempt request-1" })).toBeTruthy();
      expect(body().queryByRole("article")).toBeNull();
      view.unmount();
    }
  });

  test("accessor outcome is refused without invoking callback getters", async () => {
    let reads = 0;
    const result = Object.defineProperty({}, "kind", { enumerable: true, get() { reads++; return "blocked"; } });
    render(await envelope(), { onPrepare: async () => result as PreparationOutcome });
    click("Prepare review");
    await testing.waitFor(() => expect(statusText()).toContain("disclosure could not be validated"));
    expect(reads).toBe(0);
  });

  test.each(["facts", "support"])("%s invalidation retains pending and failed stop through repeated passive changes", async (kind) => {
    const value = await envelope();
    const pending = deferred<StartOutcome>();
    const stopResult = deferred<"unconfirmed">();
    const onStart = mock((_request: Parameters<ReaderReviewProps["onStart"]>[0]) => pending.promise);
    const onStop = mock(() => stopResult.promise);
    const view = render(value, { onStart, onStop });
    await disclose(); click("Start with Synthetic provider");
    view.update(kind === "facts" ? { disclosureRevision: "facts-2" } : { supported: false });
    expect(onStart.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("Awaiting stop confirmation");
    view.update({ disclosureRevision: "facts-3", supported: true });
    await testing.act(async () => stopResult.reject(new Error("PRIVATE_STOP_FAILURE")));
    expect(statusText()).toContain("Stop could not be confirmed");
    view.update({ disclosureRevision: "facts-1" });
    expect(statusText()).toContain("provider may still be processing");
    await testing.act(async () => pending.resolve({ kind: "completed", run: await run(value) }));
    expect(body().queryByRole("article")).toBeNull();
    expect(document.body.textContent).not.toContain("PRIVATE_STOP_FAILURE");
  });

  test("old automatic stop and completion cannot overwrite a newer running request", async () => {
    const first = await envelope();
    const second = await envelope("request-2");
    const oldStart = deferred<StartOutcome>();
    const oldStop = deferred<"stopped">();
    const newStart = deferred<StartOutcome>();
    const view = render(first, { onStart: () => oldStart.promise, onStop: () => oldStop.promise });
    await disclose(); click("Start with Synthetic provider");
    view.update({ disclosureRevision: "facts-2", onPrepare: async () => ({ kind: "ready", prepared: prepared(second) }), onStart: () => newStart.promise });
    await disclose(); click("Start with Synthetic provider");
    await testing.act(async () => {
      oldStop.reject(new Error("old stop failure"));
      oldStart.resolve({ kind: "completed", run: await run(first) });
    });
    expect(statusText()).toContain("Review in progress");
    expect(body().queryByRole("article")).toBeNull();
    await testing.act(async () => newStart.resolve({ kind: "completed", run: await run(second) }));
    await testing.waitFor(() => expect(body().getByRole("article", { name: "Reader run request-2" })).toBeTruthy());
    expect(body().queryByRole("article", { name: "Reader run request-1" })).toBeNull();
  });
});

describe("reader disclosure and explicit authority", () => {
  test("open, rerender, close and reopen never prepare or start automatically", async () => {
    const view = render(await envelope());
    view.update({ disclosureRevision: "facts-2" });
    view.update({ open: false });
    view.update({ open: true });
    expect(view.onPrepare).not.toHaveBeenCalled();
    expect(view.onStart).not.toHaveBeenCalled();
    expect(view.onStop).not.toHaveBeenCalled();
    expect(body().queryByRole("button", { name: /Start with/ })).toBeNull();
  });

  test("discloses only exact scope, profile, feedback, destination and unknown accounting", async () => {
    const value = await envelope("request-1", { priorFeedback: [{ id: "feedback-1", runId: "old-run", label: "Selected feedback", text: "Synthetic earlier impression" }] });
    const view = render(value);
    await disclose();
    const disclosure = body().getByRole("region", { name: "Outgoing review disclosure" });
    expect(disclosure.textContent).toContain("Selected 😀 exact.");
    expect(disclosure.textContent).not.toContain("ADJACENT_BEFORE");
    expect(disclosure.textContent).not.toContain("ADJACENT_AFTER");
    expect(disclosure.textContent).toContain("Saved version 3");
    expect(disclosure.textContent).toContain("Lines 2–2");
    expect(disclosure.textContent).toContain("synthetic/model");
    expect(disclosure.textContent).toContain("endpoint-revision-1");
    expect(disclosure.textContent).toContain("Estimated cost: Unknown");
    expect(disclosure.textContent).toContain("Context fit: Unknown");
    expect(disclosure.textContent).toContain("Catalog context: Unknown");
    expect(disclosure.textContent).toContain("Alpha reader");
    expect(disclosure.textContent).toContain("reader-alpha");
    expect(disclosure.textContent).toContain("Synthetic earlier impression");
    expect(disclosure.textContent).toContain("Synthetic data-use terms");
    expect(disclosure.textContent).toContain("Required consent: Satisfied");
    expect(view.onStart).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(body().getByRole("status"));
  });

  test("known zero cost and catalog size do not imply a cost cap or proven context fit", async () => {
    render(await envelope("request-1", { environment: { ...input().environment, estimatedCostUsd: 0, priceAsOf: stamp, catalogContextTokens: 32000, catalogAsOf: stamp } }));
    await disclose();
    expect(body().getByText("Estimated cost: USD 0 · Not a spending cap")).toBeTruthy();
    expect(body().getByText(/Context fit: Unknown/)).toBeTruthy();
    expect(body().getByText(/Catalog context: 32000 tokens/)).toBeTruthy();
  });

  test("merged chapter selections and selected Bible fields are disclosed literally", async () => {
    const chapter = captureChapterSource({ sourceId: "merged-source", saved: { ...saved, body: "One two three" },
      bookTitle: "Synthetic book", title: "Merged selection", position: 1, capturedAt: stamp,
      ranges: [{ start: 0, end: 4 }, { start: 3, end: 7 }, { start: 8, end: 13 }] });
    const bible = await captureBibleSource({ sourceId: "bible-source", bookId: saved.bookId, bookTitle: "Synthetic book",
      field: { section: "outline" }, label: "Selected outline", containingFileHash: "b".repeat(64), capturedAt: stamp,
      text: "<script>synthetic untrusted text</script>" });
    render(await envelope("request-1", { sources: [chapter, bible] }));
    await disclose();
    const scope = body().getByRole("list", { name: "Exact selected saved scope" });
    expect(scope.querySelectorAll("pre")).toHaveLength(3);
    expect(scope.textContent).toContain("UTF-16 range [0, 7)");
    expect(scope.textContent).toContain("UTF-16 range [8, 13)");
    expect(scope.textContent).toContain("Story Bible · Selected outline");
    expect(scope.querySelector("script")).toBeNull();
  });

  test("the first leaf refuses multi-book preparation", async () => {
    const base = input();
    const second = captureChapterSource({ sourceId: "other-source", saved: { ...saved, bookId: "book_other123" },
      bookTitle: "Other synthetic book", title: "Other chapter", position: 1, capturedAt: stamp, ranges: [{ start: 0, end: 8 }] });
    const book = base.books[0];
    if (!book) throw new Error("Missing fixture book");
    const value = await envelope("request-1", { books: [...base.books, { ...book, bookId: "book_other123", title: "Other synthetic book" }], sources: [source(), second] });
    const view = render(value);
    click("Prepare review");
    await testing.waitFor(() => expect(statusText()).toContain("disclosure could not be validated"));
    expect(view.onStart).not.toHaveBeenCalled();
  });

  test("a fresh refresh replaces disclosure without starting and detaches the terms text", async () => {
    const first = await envelope();
    const second = await envelope("request-2");
    const view = render(first);
    await disclose();
    const data = prepared(second);
    const mutable = data.terms.map((term) => ({ ...term }));
    view.update({ onPrepare: async () => ({ kind: "ready", prepared: { ...data, terms: mutable } }) });
    click("Refresh disclosure");
    await testing.waitFor(() => expect(statusText()).toContain("Disclosure ready"));
    const term = mutable[0];
    if (!term) throw new Error("Missing fixture terms");
    term.training = "MUTATED_TERMS_SENTINEL";
    view.update({});
    expect(document.body.textContent).not.toContain("MUTATED_TERMS_SENTINEL");
    expect(view.onStart).not.toHaveBeenCalled();
  });

  test("unsupported hosts refuse before preparation", async () => {
    const view = render(await envelope(), { supported: false });
    expect((body().getByRole("button", { name: "Prepare review" }) as HTMLButtonElement).disabled).toBe(true);
    click("Prepare review");
    expect(statusText()).toContain("unavailable on this host");
    expect(view.onPrepare).not.toHaveBeenCalled();
    expect(view.onStart).not.toHaveBeenCalled();
  });

  test.each(["consent", "destination"])("missing %s blocks Start", async (which) => {
    const base = input();
    const value = await envelope("request-1", which === "consent" ? { books: base.books.map((book) => ({ ...book, consentSatisfied: false })) } : { environment: { ...base.environment, connectionAvailable: false } });
    const view = render(value);
    await disclose();
    expect((body().getByRole("button", { name: /Start with/ }) as HTMLButtonElement).disabled).toBe(true);
    click("Start with Synthetic provider");
    expect(view.onStart).not.toHaveBeenCalled();
  });

  test.each(["missing", "revision", "blank"])("%s terms fail disclosure without a start", async (which) => {
    const value = await envelope();
    const data = prepared(value);
    const terms = which === "missing" ? [] : data.terms.map((term) => ({ ...term,
      ...(which === "revision" ? { termsRevision: "wrong" } : { training: " " }) }));
    const view = render(value, { onPrepare: async () => ({ kind: "ready", prepared: { ...data, terms } }) });
    click("Prepare review");
    await testing.waitFor(() => expect(statusText()).toContain("disclosure could not be validated"));
    expect(body().queryByRole("button", { name: /Start with/ })).toBeNull();
    expect(view.onStart).not.toHaveBeenCalled();
  });

  test.each(["unregistered", "wrong-book", "guided"])("rejects %s envelopes", async (which) => {
    const value = await envelope();
    const bad = which === "unregistered" ? JSON.parse(JSON.stringify(value)) : which === "guided" ? await buildReviewEnvelope(input()) : value;
    const view = render(value, { ...(which === "wrong-book" ? { bookId: "book_other123" } : {}), onPrepare: async () => ({ kind: "ready", prepared: prepared(bad) }) });
    click("Prepare review");
    await testing.waitFor(() => expect(statusText()).toContain("disclosure could not be validated"));
    expect(view.onStart).not.toHaveBeenCalled();
  });

  test("refresh consumes no Start and refuses a reused request identity", async () => {
    const view = render(await envelope());
    await disclose();
    click("Refresh disclosure");
    await testing.waitFor(() => expect(statusText()).toContain("disclosure could not be validated"));
    expect(view.onPrepare).toHaveBeenCalledTimes(2);
    expect(view.onStart).not.toHaveBeenCalled();
  });

  test("closing a prepared disclosure sends nothing and immediately clears it", async () => {
    const view = render(await envelope());
    await disclose();
    click("Close review");
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(view.onStart).not.toHaveBeenCalled();
    expect(view.onStop).not.toHaveBeenCalled();
    expect(body().queryByRole("region", { name: "Outgoing review disclosure" })).toBeNull();
  });

  test("explicit preparation refusal and exceptions release busy state without echoing raw failures", async () => {
    const value = await envelope();
    const view = render(value, { onPrepare: async () => ({ kind: "blocked", reason: "scope-too-large" }) });
    click("Prepare review");
    await testing.waitFor(() => expect(statusText()).toContain("Choose a smaller selection"));
    view.update({ onPrepare: async () => { throw new Error("PRIVATE_FAILURE_SENTINEL"); } });
    click("Prepare review");
    await testing.waitFor(() => expect(statusText()).toContain("could not be validated"));
    expect(document.body.textContent).not.toContain("PRIVATE_FAILURE_SENTINEL");
    expect(view.onStart).not.toHaveBeenCalled();
  });
});

describe("cancellation and disclosure lifetime races", () => {
  test("double clicks cause one preparation and one Start, using the disclosed immutable envelope", async () => {
    const value = await envelope();
    const pendingPreparation = deferred<PreparationOutcome>();
    const pendingStart = deferred<StartOutcome>();
    const onPrepare = mock(() => pendingPreparation.promise);
    const onStart = mock((_request: Parameters<ReaderReviewProps["onStart"]>[0]) => pendingStart.promise);
    render(value, { onPrepare, onStart });
    const prepareButton = body().getByRole("button", { name: "Prepare review" });
    testing.act(() => { testing.fireEvent.click(prepareButton); testing.fireEvent.click(prepareButton); });
    expect(onPrepare).toHaveBeenCalledTimes(1);
    await testing.act(async () => pendingPreparation.resolve({ kind: "ready", prepared: prepared(value) }));
    const startButton = body().getByRole("button", { name: /Start with/ });
    testing.act(() => { testing.fireEvent.click(startButton); testing.fireEvent.click(startButton); });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]?.[0].envelope).toBe(value);
    expect(Object.isFrozen(onStart.mock.calls[0]?.[0].envelope.sources)).toBe(true);
    await testing.act(async () => pendingStart.resolve({ kind: "completed", run: await run(value) }));
    await testing.waitFor(() => expect(body().getByRole("article", { name: "Reader run request-1" })).toBeTruthy());
  });

  test("cancel preparation aborts its signal and ignores its late response", async () => {
    const value = await envelope();
    const pending = deferred<PreparationOutcome>();
    const onPrepare = mock((_request: Parameters<ReaderReviewProps["onPrepare"]>[0]) => pending.promise);
    const view = render(value, { onPrepare });
    click("Prepare review");
    click("Cancel preparation");
    expect(onPrepare.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await testing.act(async () => pending.resolve({ kind: "ready", prepared: prepared(value) }));
    expect(statusText()).toContain("No provider request started");
    expect(body().queryByRole("button", { name: /Start with/ })).toBeNull();
    expect(view.onStart).not.toHaveBeenCalled();
    expect(view.onStop).toHaveBeenCalledTimes(1);
    expect(view.onStop.mock.calls[0]?.[0]).toEqual({ requestId: null });
  });

  test("an explicit stale check clears disclosure; restoring current sources cannot revive authorization", async () => {
    const value = await envelope();
    const view = render(value);
    await disclose();
    view.update({ onCheckSources: async () => checked(value, [{ sourceId: "source-1", status: "stale" }]) });
    click("Check current sources");
    await testing.waitFor(() => expect(statusText()).toContain("disclosure changed"));
    expect(body().queryByRole("button", { name: /Start with/ })).toBeNull();
    view.update({ onCheckSources: async () => checked(value) });
    expect(body().queryByRole("button", { name: /Start with/ })).toBeNull();
    expect((body().getByRole("button", { name: "Check current sources" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.onStart).not.toHaveBeenCalled();
  });

  test.each(["book", "view", "facts", "open"])("late A→B→A preparation is ignored across %s changes", async (which) => {
    const value = await envelope();
    const pending = deferred<PreparationOutcome>();
    const onPrepare = mock((_request: Parameters<ReaderReviewProps["onPrepare"]>[0]) => pending.promise);
    const view = render(value, { onPrepare });
    click("Prepare review");
    const away = which === "book" ? { bookId: "book_other123" } : which === "view" ? { viewKey: "view-2" } : which === "facts" ? { disclosureRevision: "facts-2" } : { open: false };
    view.update(away);
    view.update({ bookId: saved.bookId, viewKey: "view-1", disclosureRevision: "facts-1", open: true });
    expect(onPrepare.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await testing.act(async () => pending.resolve({ kind: "ready", prepared: prepared(value) }));
    expect(body().queryByRole("button", { name: /Start with/ })).toBeNull();
    expect(view.onStart).not.toHaveBeenCalled();
  });

  test.each(["book", "view", "facts", "open", "stop"])("late completion is ignored after %s; stop is best-effort only", async (which) => {
    const value = await envelope();
    const pending = deferred<StartOutcome>();
    const onStart = mock((_request: Parameters<ReaderReviewProps["onStart"]>[0]) => pending.promise);
    const view = render(value, { onStart });
    await disclose();
    click("Start with Synthetic provider");
    if (which === "stop") click("Stop review");
    else {
      view.update(which === "book" ? { bookId: "book_other123" } : which === "view" ? { viewKey: "view-2" } : which === "facts" ? { disclosureRevision: "facts-2" } : { open: false });
      view.update({ bookId: saved.bookId, viewKey: "view-1", disclosureRevision: "facts-1", open: true });
    }
    expect(onStart.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(view.onStop).toHaveBeenCalledTimes(1);
    expect(view.onStop.mock.calls[0]?.[0]).toEqual({ requestId: value.requestId });
    await testing.act(async () => pending.resolve({ kind: "completed", run: await run(value) }));
    expect(body().queryByRole("article")).toBeNull();
    expect(onStart).toHaveBeenCalledTimes(1);
    if (which === "stop") expect(statusText()).toContain("text already sent cannot be recalled");
  });

  test("unmount stops a running request and rejects its late failure without updating a new view", async () => {
    const value = await envelope();
    const pending = deferred<StartOutcome>();
    const view = render(value, { onStart: () => pending.promise });
    await disclose();
    click("Start with Synthetic provider");
    view.unmount();
    expect(view.onStop).toHaveBeenCalledTimes(1);
    render(value);
    await testing.act(async () => pending.reject(new Error("late provider failure")));
    expect(statusText()).toContain("Prepare a fresh disclosure");
  });

  test("stop failure is honest and cannot overwrite a subsequent preparation", async () => {
    const value = await envelope();
    const pending = deferred<StartOutcome>();
    const stopResult = deferred<"unconfirmed">();
    const view = render(value, { onStart: () => pending.promise, onStop: () => stopResult.promise });
    await disclose();
    click("Start with Synthetic provider");
    click("Stop review");
    await testing.act(async () => stopResult.reject(new Error("stop failed")));
    expect(statusText()).toContain("Stop could not be confirmed");
    view.update({ onPrepare: async () => ({ kind: "blocked", reason: "consent" }) });
    click("Prepare rerun");
    await testing.waitFor(() => expect(statusText()).toContain("This model may use the selected text for training"));
  });
});

describe("results, exact historical evidence and explicit reruns", () => {
  test.each(["provider", "overflow", "malformed", "refused"] as const)("%s failure does not retry or fake completion", async (reason) => {
    const onStart = mock(async (): Promise<StartOutcome> => ({ kind: "failed", reason }));
    render(await envelope(), { onStart });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(statusText()).toBe(failureCopy[reason]));
    expect(body().queryByRole("article")).toBeNull();
    expect(body().getByRole("button", { name: "Prepare rerun" })).toBeTruthy();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("host pre-send revalidation refusal requires fresh disclosure", async () => {
    const onStart = mock(async (): Promise<StartOutcome> => ({ kind: "blocked", reason: "changed" }));
    render(await envelope(), { onStart });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(statusText()).toContain("disclosure changed"));
    expect(body().queryByRole("button", { name: /Start with/ })).toBeNull();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("immutable attribution, subjective finding and exact historical quotation survive navigation", async () => {
    const value = await envelope();
    const result = await run(value);
    const onNavigate = mock(async (_request: Parameters<ReaderReviewProps["onNavigate"]>[0]) => "stale" as const);
    render(value, { onStart: async () => ({ kind: "completed", run: result }), onNavigate });
    await complete();
    const article = body().getByRole("article");
    expect(article.textContent).toContain("Alpha reader · Version 1");
    expect(article.textContent).toContain("Subjective observation");
    expect(article.textContent).toContain("saved version 3, captured");
    expect(article.querySelector("blockquote")?.textContent).toBe(citation().quote);
    await checkSources();
    clickEvidence();
    await testing.waitFor(() => expect(statusText()).toContain("passage is stale or the editor is not ready"));
    expect(onNavigate.mock.calls[0]?.[0].citation).toEqual(citation());
    expect(Object.isFrozen(onNavigate.mock.calls[0]?.[0].run)).toBe(true);
    expect(article.querySelector("blockquote")?.textContent).toBe(citation().quote);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    clickEvidence();
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  test.each(["missing", "changed", "dirty", "malformed-clean"])("%s evidence keeps its historical quote but cannot navigate", async (which) => {
    const value = await envelope();
    const view = render(value);
    await complete();
    if (which === "missing") view.update({ onCheckSources: async () => checked(value, [{ sourceId: "source-1", status: "missing" }]) });
    else if (which === "changed") view.update({ onCheckSources: async () => checked(value, [{ sourceId: "source-1", status: "available", source: { ...source(), identity: { ...citation().identity, version: 4 } } }]) });
    else view.update({ editor: { clean: which === "dirty" ? false : "false" as unknown as boolean, identity: citation().identity } });
    await checkSources();
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    expect(body().getByRole("article").textContent).toContain(which === "dirty" || which === "malformed-clean"
      ? "Historical quotation · Editor not ready — save or finish editing, then try again"
      : which === "missing" ? "Historical quotation · Source unavailable — navigation disabled"
        : "Historical quotation · Stale saved source — navigation disabled");
    clickEvidence();
    expect(view.onNavigate).not.toHaveBeenCalled();
    expect(body().getByRole("article").querySelector("blockquote")?.textContent).toBe(citation().quote);
  });

  test("forged verified flags and malformed quotations are withheld and counted", async () => {
    const value = await envelope();
    const valid = await run(value);
    const finding = valid.findings[0];
    if (!finding) throw new Error("Missing fixture finding");
    const forged = { ...valid, findings: [{ ...finding, evidence: [{ citation: { ...citation(), quote: "INVENTED_QUOTE_SENTINEL" }, label: "verified current" }] }] };
    const view = render(value, { onStart: async () => ({ kind: "completed", run: forged }) });
    await complete();
    expect(body().getByText(/1 unverified quotations withheld/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("INVENTED_QUOTE_SENTINEL");
    expect(body().queryByRole("button", { name: /^Show exact passage for / })).toBeNull();
    expect(view.onNavigate).not.toHaveBeenCalled();
  });

  test("wrong run identity fails without displaying its findings", async () => {
    const value = await envelope();
    const invalid = { ...await run(value), runId: "wrong-request" };
    render(value, { onStart: async () => ({ kind: "completed", run: invalid }) });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(statusText()).toContain(revalidationFailureCopy));
    expect(body().queryByRole("article")).toBeNull();
  });

  test("rerun is a new disclosure and Start; compares source, profile and destination without relabelling earlier results", async () => {
    const first = await envelope();
    const view = render(first);
    await complete();
    const alpha = await builtinReaderProfile("alpha");
    const author = await editReaderProfile(alpha, { name: "Alpha reader", purpose: "Author's synthetic lens", focus: ["pacing"], guidance: "Read slowly." }, "author-profile-1");
    const changedSource = captureChapterSource({ sourceId: "source-2", saved: { ...saved, version: 4, body: "Revised scene." }, bookTitle: "Synthetic book", title: "Synthetic chapter", position: 1, capturedAt: stamp, ranges: [{ start: 0, end: 14 }] });
    const second = await envelope("request-2", { profile: author, sources: [changedSource], destination: { ...input().destination, provider: "Second synthetic provider", model: "second/model" } });
    const onPrepare = mock(async (_request: Parameters<ReaderReviewProps["onPrepare"]>[0]): Promise<PreparationOutcome> => ({ kind: "ready", prepared: prepared(second) }));
    const onStart = mock(async (): Promise<StartOutcome> => ({ kind: "completed", run: await run(second, [], "The revised scene may feel slower.") }));
    view.update({ disclosureRevision: "facts-2", onPrepare, onStart });
    expect(body().getAllByRole("article")).toHaveLength(1);
    click("Prepare rerun");
    await testing.waitFor(() => expect(body().getByRole("button", { name: "Start with Second synthetic provider" })).toBeTruthy());
    expect(onStart).not.toHaveBeenCalled();
    expect(onPrepare.mock.calls[0]?.[0].previousRunId).toBe("request-1");
    click("Start with Second synthetic provider");
    await testing.waitFor(() => expect(body().getAllByRole("article")).toHaveLength(2));
    const comparison = body().getByRole("region", { name: "Latest run comparison" });
    expect(comparison.textContent).toContain("Run request-1 → Run request-2 · 2 completed runs in this view");
    expect(comparison.textContent).toContain("Sources: Changed · 1 of 1 sources differ");
    expect(comparison.textContent).toContain("Profile: Changed · Alpha reader (reader-alpha) · v1 · Built-in → Alpha reader (author-profile-1) · v1 · Author");
    expect(comparison.textContent).toContain("Provider: Changed · Synthetic provider → Second synthetic provider");
    expect(comparison.textContent).toContain("Model: Changed · synthetic/model → second/model");
    expect(comparison.textContent).toContain("saved version 3 → 4");
    expect(comparison.textContent).toContain("not an improvement score");
    expect(body().getByRole("article", { name: "Reader run request-1" }).textContent).toContain("reader-alpha");
    expect(body().getByRole("article", { name: "Reader run request-2" }).textContent).toContain("author-profile-1");
    expect(body().getByRole("article", { name: "Reader run request-2" }).textContent).toContain("Author profile");
    view.update({ bookId: "book_other123" });
    view.update({ bookId: saved.bookId });
    expect(body().queryByRole("article")).toBeNull();
  });

  test("Beta attribution is distinct and late navigation cannot leak into a returned view", async () => {
    const value = await envelope("request-1", { profile: await builtinReaderProfile("beta") });
    const pending = deferred<"selected" | "stale" | "unavailable">();
    const onNavigate = mock((_request: Parameters<ReaderReviewProps["onNavigate"]>[0]) => pending.promise);
    const view = render(value, { onNavigate });
    await complete();
    expect(body().getByRole("article").textContent).toContain("Beta reader · Version 1");
    await checkSources();
    clickEvidence();
    view.update({ viewKey: "view-2" });
    view.update({ viewKey: "view-1" });
    expect(onNavigate.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await testing.act(async () => pending.resolve("selected"));
    expect(statusText()).not.toContain("selected");
    expect(body().queryByRole("article")).toBeNull();
  });

  test("same-input rereads label model variation and preserve both immutable interpretations", async () => {
    const first = await envelope();
    const view = render(first);
    await complete();
    const second = await envelope("request-2");
    view.update({ onPrepare: async () => ({ kind: "ready", prepared: prepared(second) }),
      onStart: async () => ({ kind: "completed", run: await run(second, [citation()], "Another subjective reading.") }) });
    click("Prepare rerun");
    await testing.waitFor(() => expect(body().getByRole("button", { name: /Start with/ })).toBeTruthy());
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getAllByRole("article")).toHaveLength(2));
    expect(body().getByRole("region", { name: "Latest run comparison" }).textContent).toContain("Same-input model variation");
    expect(body().getByRole("article", { name: "Reader run request-1" }).textContent).toContain("The scene may feel abrupt.");
    expect(body().getByRole("article", { name: "Reader run request-2" }).textContent).toContain("Another subjective reading.");
  });

  test("Story Bible historical evidence is displayed without inventing editor navigation", async () => {
    const bible = await captureBibleSource({ sourceId: "bible-source", bookId: saved.bookId, bookTitle: "Synthetic book",
      field: { section: "outline" }, label: "Selected outline", containingFileHash: "b".repeat(64), capturedAt: stamp, text: "A synthetic outline." });
    const value = await envelope("request-1", { sources: [bible] });
    const evidence = { kind: "story-bible", sourceId: bible.sourceId, bookId: bible.bookId, field: bible.field,
      valueDigest: bible.valueDigest, containingFileHash: bible.containingFileHash, start: 0, end: bible.text.length, quote: bible.text };
    const view = render(value, { onStart: async () => ({ kind: "completed", run: await run(value, [evidence]) }) });
    await complete();
    await checkSources();
    expect(body().getByRole("article").querySelector("blockquote")?.textContent).toBe(bible.text);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    expect(body().getByText(/This source kind has no editor navigation/)).toBeTruthy();
    expect(view.onNavigate).not.toHaveBeenCalled();
  });

  test("navigation failure releases its busy state without claiming selection", async () => {
    const value = await envelope();
    const onNavigate = mock(async () => { throw new Error("PRIVATE_NAVIGATION_FAILURE"); });
    render(value, { onNavigate });
    await complete();
    await checkSources();
    clickEvidence();
    await testing.waitFor(() => expect(statusText()).toContain("could not be opened"));
    expect(document.body.textContent).not.toContain("PRIVATE_NAVIGATION_FAILURE");
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(false);
  });

  test("synthetic journey uses no global conversation, persistence or network capability", async () => {
    const value = await envelope();
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalStudio = Object.getOwnPropertyDescriptor(window, "studio");
    const originalSetItem = Storage.prototype.setItem;
    globalThis.fetch = Object.assign(() => { calls.push("fetch"); throw new Error("Network forbidden"); }, { preconnect: originalFetch.preconnect });
    Storage.prototype.setItem = () => { calls.push("storage"); throw new Error("Persistence forbidden"); };
    Object.defineProperty(window, "studio", { configurable: true, get() { calls.push("studio"); throw new Error("Global IPC forbidden"); } });
    try {
      render(value);
      await complete();
      await checkSources();
      clickEvidence();
      await testing.waitFor(() => expect(statusText()).toContain("host confirmed"));
      click("Close review");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      Storage.prototype.setItem = originalSetItem;
      if (originalStudio) Object.defineProperty(window, "studio", originalStudio);
      else Reflect.deleteProperty(window, "studio");
    }
  });
});

describe("provider-named start and truthful stop states", () => {
  test.each([
    ["stopped", "Review stopped · Incomplete"],
    ["not-started", "Preparation cancelled · No provider request started."],
    ["unconfirmed", "Stop could not be confirmed · Incomplete"]
  ] as const)("onStop %s is displayed truthfully without recalling sent text", async (result, copy) => {
    const value = await envelope();
    const pending = deferred<StartOutcome>();
    const onStart = mock(() => pending.promise);
    const onStop = mock(async () => result);
    render(value, { onStart, onStop });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(statusText()).toContain("Review in progress"));
    click("Stop review");
    await testing.waitFor(() => expect(statusText()).toContain(copy));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("a host-stopped outcome is not a completed run", async () => {
    const value = await envelope();
    render(value, { onStart: async () => ({ kind: "stopped" }) });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(statusText()).toContain("Review stopped · Incomplete"));
    expect(body().queryByRole("article")).toBeNull();
    const attempt = body().getByRole("region", { name: "Reader attempt request-1" });
    expect(attempt.textContent).toContain("Stopped");
    expect(attempt.textContent).toContain("No findings were retained for this attempt.");
    expect(attempt.querySelector("button")).toBeNull();
  });

  test("bounded overflow details appear beside the exact refusal and failure copy", async () => {
    const value = await envelope();
    const prepareView = render(value, { onPrepare: async () => ({ kind: "blocked", reason: "scope-too-large",
      detail: "The selected source text is over 65,536 bytes." }) });
    click("Prepare review");
    await testing.waitFor(() => expect(statusText()).toContain("Nothing was shortened or sent."));
    expect(statusText()).toContain("The selected source text is over 65,536 bytes.");
    prepareView.unmount();

    render(value, { onStart: async () => ({ kind: "blocked", reason: "changed",
      detail: "Prepare a fresh disclosure and inspect it before starting." }) });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(statusText()).toContain("disclosure changed"));
    expect(statusText()).toContain("Prepare a fresh disclosure and inspect it before starting.");
  });

  test("the Start button names the provider and is disabled when the host marks preparation disabled", async () => {
    const value = await envelope();
    const preparedView = render(value);
    await disclose();
    expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy();
    preparedView.update({ prepareDisabled: true });
    expect((body().getByRole("button", { name: "Refresh disclosure" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("explicit current-source checks and exact navigation states", () => {
  test("no check runs automatically on open, prepare, rerender or completion; one check covers the volatile envelopes", async () => {
    const value = await envelope();
    const view = render(value);
    expect(view.onCheckSources).not.toHaveBeenCalled();
    await disclose();
    expect(view.onCheckSources).not.toHaveBeenCalled();
    view.update({});
    expect(view.onCheckSources).not.toHaveBeenCalled();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getByRole("article", { name: "Reader run request-1" })).toBeTruthy());
    expect(view.onCheckSources).not.toHaveBeenCalled();
    click("Check current sources");
    await testing.waitFor(() => expect(statusText()).toBe(sourceCheckCopy.currentHistorical));
    expect(view.onCheckSources).toHaveBeenCalledTimes(1);
    const request = view.onCheckSources.mock.calls[0]?.[0];
    expect(request?.envelopes).toHaveLength(1);
    expect(request?.envelopes[0]?.scopeDigest).toBe(value.scopeDigest);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(view.onStart).toHaveBeenCalledTimes(1);
  });

  test("not checked disables the exact-passage control; a checked-current report enables it and announces selection", async () => {
    const value = await envelope();
    const view = render(value);
    await complete();
    const article = body().getByRole("article", { name: "Reader run request-1" });
    expect(article.textContent).toContain(sourceStatusCopy.notChecked);
    expect(article.textContent).toContain("Historical quotation · Source currency not checked — navigation disabled");
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    clickEvidence();
    expect(view.onNavigate).not.toHaveBeenCalled();
    await checkSources();
    expect(article.textContent).toContain(sourceStatusCopy.current);
    expect(article.textContent).toContain("Historical quotation · Current navigation available");
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(false);
    clickEvidence();
    await testing.waitFor(() => expect(statusText()).toBe(citationNavigationCopy.selected));
    expect(view.onNavigate).toHaveBeenCalledTimes(1);
    expect(article.querySelector("blockquote")?.textContent).toBe(citation().quote);
  });

  test("stale and unavailable runs stay historical; a failed check disables navigation and a later exact check clears it", async () => {
    const value = await envelope();
    const view = render(value);
    await complete();
    view.update({ onCheckSources: async () => checked(value, [{ sourceId: "source-1", status: "stale" }]) });
    await checkSources();
    expect(body().getByRole("article").textContent).toContain(staleSourceStatusCopy(1, 1));
    expect(body().getByRole("article").textContent).toContain("Historical quotation · Stale saved source — navigation disabled");
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);

    view.update({ onCheckSources: async () => ({ kind: "failed" }) });
    await checkSources();
    expect(body().getByRole("article").textContent).toContain(sourceStatusCopy.checkFailed);
    expect(body().getByRole("article").textContent).toContain("Historical quotation · Source currency could not be checked — navigation disabled");
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);

    view.update({ onCheckSources: async () => checked(value) });
    await checkSources();
    expect(body().getByRole("article").textContent).toContain(sourceStatusCopy.current);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(false);

    view.update({ onCheckSources: async () => checked(value, [{ sourceId: "source-1", status: "missing" }]) });
    await checkSources();
    expect(body().getByRole("article").textContent).toContain(unavailableSourceStatusCopy(1, 1));
    expect(body().getByRole("article").textContent).toContain("Historical quotation · Source unavailable — navigation disabled");
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
  });

  test("two citations with the same captured label get distinct accessible names", async () => {
    const value = await envelope();
    const second = { ...citation(), end: selectedStart + 8, quote: "Selected" };
    const view = render(value, { onStart: async () => ({ kind: "completed", run: await run(value, [citation(), second]) }) });
    await complete();
    await checkSources();
    const buttons = body().getAllByRole("button", { name: /^Show exact passage for finding-1/ });
    expect(buttons).toHaveLength(2);
    const names = buttons.map((button) => button.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toContain("evidence 1");
    expect(names[1]).toContain("evidence 2");
    expect(view.onNavigate).not.toHaveBeenCalled();
  });

  test("one results region, one polite status and no Apply, Reject or model chooser", async () => {
    const value = await envelope();
    render(value);
    await complete();
    expect(body().getAllByRole("region", { name: "Volatile reader results" })).toHaveLength(1);
    expect(body().getAllByRole("region", { name: "Latest run comparison" })).toHaveLength(1);
    expect(body().getAllByRole("status")).toHaveLength(1);
    expect(body().queryByRole("button", { name: /^(Apply|Reject|Accept|Ignore)/ })).toBeNull();
    expect(body().queryByRole("button", { name: /model chooser/i })).toBeNull();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  test("a failed check keeps a prepared disclosure and its zero-send authority", async () => {
    const value = await envelope();
    const view = render(value);
    await disclose();
    view.update({ onCheckSources: async () => ({ kind: "failed" }) });
    click("Check current sources");
    await testing.waitFor(() => expect(statusText()).toBe(sourceCheckCopy.failedPrepared));
    expect(body().getByRole("region", { name: "Outgoing review disclosure" })).toBeTruthy();
    expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy();
    expect(view.onStart).not.toHaveBeenCalled();
  });

  test("a host refusal after a click keeps the historical quote and disables only that link", async () => {
    const value = await envelope();
    const onNavigate = mock(async (_request: Parameters<ReaderReviewProps["onNavigate"]>[0]) => "unavailable" as const);
    render(value, { onNavigate });
    await complete();
    await checkSources();
    clickEvidence();
    await testing.waitFor(() => expect(statusText()).toBe(citationNavigationCopy.unavailable));
    expect(body().getByRole("article").querySelector("blockquote")?.textContent).toBe(citation().quote);
    expect((evidenceButton() as HTMLButtonElement).disabled).toBe(true);
    expect(body().getByRole("article").textContent).toContain("Historical quotation · Unavailable — navigation disabled");
    clickEvidence();
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("volatile attempt history, attribution and explicit rerun comparison", () => {
  test("a completed attempt shows provider, model, connection, times, profile and collapsed exact attribution", async () => {
    const value = await envelope();
    render(value);
    await complete();
    const article = body().getByRole("article", { name: "Reader run request-1" });
    expect(article.textContent).toContain("Run request-1 · Completed");
    expect(article.textContent).toContain("Provider: Synthetic provider · Model: synthetic/model");
    expect(article.textContent).toContain("Connection: Synthetic work account");
    expect(article.textContent).toMatch(/Started \d{4}-\d{2}-\d{2}T.*Completed \d{4}-\d{2}-\d{2}T/);
    expect(article.textContent).toContain("Alpha reader · Version 1 · Fictional built-in lens");
    expect(article.textContent).toContain("Profile identity: reader-alpha");
    const exact = Array.from(article.querySelectorAll("details")).find((node) => node.querySelector("summary")?.textContent === "Exact attribution");
    expect(exact?.textContent).toContain("Model id: synthetic/model");
    expect(exact?.textContent).toContain("Connection id: connection-1");
    expect(exact?.textContent).toContain("Endpoint identity: endpoint-revision-1");
    expect(exact?.textContent).toContain("Scope digest: ");
    expect(exact?.textContent).toContain("Profile digest: ");
  });

  test("a failed attempt remains with its disclosure and attribution and grants no findings or Save", async () => {
    const onStart = mock(async (): Promise<StartOutcome> => ({ kind: "failed", reason: "malformed" }));
    render(await envelope(), { onStart });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(statusText()).toBe(failureCopy.malformed));
    const attempt = body().getByRole("region", { name: "Reader attempt request-1" });
    expect(attempt.textContent).toContain("Run request-1 · Failed");
    expect(attempt.textContent).toContain(failureCopy.malformed);
    expect(attempt.textContent).toContain("No findings were retained for this attempt.");
    expect(attempt.textContent).toContain("Disclosure captured 2026-11-07T12:00:00Z · No completed result");
    expect(attempt.textContent).toContain("Alpha reader · Version 1");
    expect(attempt.textContent).toContain("Provider: Synthetic provider · Model: synthetic/model");
    expect(attempt.textContent).toContain("Connection: Synthetic work account");
    expect(attempt.querySelector("article")).toBeNull();
    expect(attempt.querySelector("button")).toBeNull();
    expect(body().queryByRole("article")).toBeNull();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(body().getByRole("button", { name: "Prepare rerun" })).toBeTruthy();
  });

  test("an invalid result attempt names the revalidation copy without showing findings", async () => {
    const value = await envelope();
    const invalid = { ...(await run(value)), runId: "wrong-request" };
    render(value, { onStart: async () => ({ kind: "completed", run: invalid }) });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(statusText()).toBe(revalidationFailureCopy));
    const attempt = body().getByRole("region", { name: "Reader attempt request-1" });
    expect(attempt.textContent).toContain("Run request-1 · Result not accepted");
    expect(attempt.textContent).toContain(revalidationFailureCopy);
    expect(attempt.textContent).toContain("No findings were retained for this attempt.");
    expect(attempt.textContent).not.toContain("The scene may feel abrupt.");
    expect(body().queryByRole("article")).toBeNull();
  });

  test("an unknown outcome after Start stays visible, redacted and inert", async () => {
    render(await envelope(), { onStart: async () => { throw new Error("PRIVATE_IPC_SENTINEL"); } });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(statusText()).toContain("The request failed or its result could not be validated"));
    const attempt = body().getByRole("region", { name: "Reader attempt request-1" });
    expect(attempt.textContent).toContain("Run request-1 · Outcome unknown");
    expect(attempt.textContent).toContain("The request outcome is unknown. The request may have been sent; text already sent cannot be recalled. No findings were retained here.");
    expect(document.body.textContent).not.toContain("PRIVATE_IPC_SENTINEL");
    expect(body().queryByRole("article")).toBeNull();
  });

  test("a stopped attempt stays attributable with one Start and one Stop", async () => {
    const value = await envelope();
    const pending = deferred<StartOutcome>();
    const onStart = mock(() => pending.promise);
    const onStop = mock(async () => "stopped" as const);
    render(value, { onStart, onStop });
    await disclose();
    click("Start with Synthetic provider");
    click("Stop review");
    await testing.act(async () => pending.resolve({ kind: "stopped" }));
    await testing.waitFor(() => expect(statusText()).toContain("Review stopped · Incomplete"));
    const attempt = body().getByRole("region", { name: "Reader attempt request-1" });
    expect(attempt.textContent).toContain("Run request-1 · Stopped");
    expect(attempt.textContent).toContain("Stopped · Incomplete. Stopping prevents later dispatch best-effort; text already sent cannot be recalled. No findings were retained for this attempt.");
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(body().queryByRole("article")).toBeNull();
  });

  test("empty, single and no-completed states use the exact comparison copy", async () => {
    const value = await envelope();
    const view = render(value);
    expect(body().getByRole("region", { name: "Latest run comparison" }).textContent)
      .toContain("No runs yet · No comparison. Prepare the selected saved scope and inspect the disclosure before Start.");
    view.update({ onStart: mock(async (): Promise<StartOutcome> => ({ kind: "failed", reason: "provider" })) });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getByRole("region", { name: "Latest run comparison" }).textContent)
      .toContain("No completed runs to compare. Attempts remain listed with their disclosure and attribution."));
    view.unmount();

    const second = render(value, { onStart: async () => ({ kind: "completed", run: await run(value) }) });
    await complete();
    expect(body().getByRole("region", { name: "Latest run comparison" }).textContent)
      .toContain("One completed run · No comparison yet. A second completed run in this view compares sources, profile, provider and request facts.");
    second.unmount();

    const third = render(value, { onStart: async () => ({ kind: "failed", reason: "provider" }) });
    await disclose();
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getByRole("region", { name: "Reader attempt request-1" })).toBeTruthy());
    const secondValue = await envelope("request-2");
    third.update({ onPrepare: async () => ({ kind: "ready", prepared: prepared(secondValue) }),
      onStart: async () => ({ kind: "completed", run: await run(secondValue) }) });
    click("Prepare rerun");
    await testing.waitFor(() => expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy());
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getByRole("region", { name: "Latest run comparison" }).textContent)
      .toContain("One completed run and one attempt without findings · No comparison. A second completed run compares the input facts."));
    third.unmount();
  });

  test("a second completed run is compared with the first and both remain immutable", async () => {
    const first = await envelope("request-1");
    const view = render(first);
    await complete();
    const firstArticleBefore = body().getByRole("article", { name: "Reader run request-1" }).textContent;
    const second = await envelope("request-2");
    view.update({ onPrepare: async () => ({ kind: "ready", prepared: prepared(second) }),
      onStart: async () => ({ kind: "completed", run: await run(second, [citation()], "A second, equally subjective reading.") }) });
    click("Prepare rerun");
    await testing.waitFor(() => expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy());
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getAllByRole("article")).toHaveLength(2));
    expect(body().getByRole("article", { name: "Reader run request-1" }).textContent).toBe(firstArticleBefore);
    const comparison = body().getByRole("region", { name: "Latest run comparison" });
    expect(comparison.textContent).toContain("Inputs: Identical · Interpretation or evidence changed. Same-input model variation, not an improvement score.");
    expect(comparison.textContent).toContain("Run request-1 → Run request-2 · 2 completed runs in this view");
    expect(comparison.textContent).toContain("Findings: 1 → 1");
    expect(comparison.textContent).toContain("Interpretation: Changed · Not a quality judgment");
    expect(comparison.textContent).toContain("Counts describe returned findings, not manuscript coverage or quality.");
    expect(comparison.textContent).toContain("Compared from captured revisions · Check current sources separately.");
    expect(comparison.querySelector("button")).toBeNull();
    expect(comparison.querySelector("select, textarea, input, a[href]")).toBeNull();
  });

  test("a latest failed attempt still compares the two completed runs and keeps its own section", async () => {
    const first = await envelope("request-1");
    const view = render(first);
    await complete();
    const second = await envelope("request-2");
    view.update({ onPrepare: async () => ({ kind: "ready", prepared: prepared(second) }),
      onStart: async () => ({ kind: "completed", run: await run(second, [], "Second impression.") }) });
    click("Prepare rerun");
    await testing.waitFor(() => expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy());
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getAllByRole("article")).toHaveLength(2));
    const third = await envelope("request-3");
    view.update({ onPrepare: async () => ({ kind: "ready", prepared: prepared(third) }),
      onStart: async () => ({ kind: "failed", reason: "provider" }) });
    click("Prepare rerun");
    await testing.waitFor(() => expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy());
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getByRole("region", { name: "Reader attempt request-3" })).toBeTruthy());
    const comparison = body().getByRole("region", { name: "Latest run comparison" });
    expect(comparison.textContent).toContain("The latest attempt (request-3) did not complete. This comparison uses the latest two completed runs; the attempt remains listed below with its attribution.");
    expect(comparison.textContent).toContain("Run request-1 → Run request-2");
    expect(body().queryByRole("article", { name: "Reader run request-3" })).toBeNull();
  });

  test("the 8-attempt cap disables Prepare and never evicts or silently accepts a ninth attempt", async () => {
    const envelopes = await Promise.all(Array.from({ length: 9 }, (_, index) => envelope(`request-${index + 1}`)));
    let next = 0;
    const onPrepare = mock(async (): Promise<PreparationOutcome> => {
      const current = envelopes[next];
      if (!current) throw new Error("ran out of envelopes");
      return { kind: "ready", prepared: prepared(current) };
    });
    const onStart = mock(async (): Promise<StartOutcome> => {
      const current = envelopes[next];
      next += 1;
      if (!current) throw new Error("ran out of envelopes");
      return { kind: "completed", run: await run(current) };
    });
    const view = render(envelopes[0] as (typeof envelopes)[number]);
    view.update({ onPrepare, onStart });
    for (let round = 0; round < 8; round += 1) {
      click(round === 0 ? "Prepare review" : "Prepare rerun");
      await testing.waitFor(() => expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy());
      click("Start with Synthetic provider");
      await testing.waitFor(() => expect(body().getByRole("article", { name: `Reader run request-${round + 1}` })).toBeTruthy());
    }
    expect(onPrepare).toHaveBeenCalledTimes(8);
    const capNote = body().getByText("This view keeps up to 8 attempts, including failed and stopped attempts. Close the review to discard this volatile history and start a new view. Nothing is prepared or sent.");
    const prepareButton = body().getByRole("button", { name: "Prepare rerun" }) as HTMLButtonElement;
    expect(prepareButton.disabled).toBe(true);
    expect(prepareButton.getAttribute("aria-describedby")).toBe(capNote.id);
    expect(body().getAllByRole("article")).toHaveLength(8);
    testing.fireEvent.click(prepareButton);
    expect(onPrepare).toHaveBeenCalledTimes(8);
    expect(body().getAllByRole("article")).toHaveLength(8);
    click("Close review");
    view.update({ open: false });
    view.update({ open: true, viewKey: "view-2" });
    expect(body().queryByRole("article")).toBeNull();
    expect(body().queryByRole("region", { name: "Reader attempt request-1" })).toBeNull();
    expect((body().getByRole("button", { name: "Prepare review" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("the comparison region holds no controls and the source-change list is labelled", async () => {
    const first = await envelope("request-1");
    const view = render(first);
    await complete();
    const revised = captureChapterSource({ sourceId: "source-1", saved: { ...saved, version: 4, hash: "b".repeat(64) },
      bookTitle: "Synthetic book", title: "Synthetic chapter", position: 1, capturedAt: stamp,
      ranges: [{ start: selectedStart, end: selectedEnd }] });
    const second = await envelope("request-2", { sources: [revised] });
    view.update({ onPrepare: async () => ({ kind: "ready", prepared: prepared(second) }),
      onStart: async () => ({ kind: "completed", run: await run(second) }) });
    click("Prepare rerun");
    await testing.waitFor(() => expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy());
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getAllByRole("article")).toHaveLength(2));
    const comparison = body().getByRole("region", { name: "Latest run comparison" });
    expect(comparison.querySelectorAll("button, a[href], input, select, textarea")).toHaveLength(0);
    expect(comparison.querySelectorAll("[tabindex]")).toHaveLength(0);
    const changes = body().getByRole("list", { name: "Source changes between the latest two runs" });
    expect(changes.textContent).toContain("saved version 3 → 4");
    expect(body().getByText("Counts by category")).toBeTruthy();
  });
});
describe("injection resistance at the results surface", () => {
  test("I-12 markup in an interpretation renders as inert text, never as elements or handlers", async () => {
    const value = await envelope();
    const payload = '<img src=x onerror=alert(1)> <script>globalThis.__pwned = true</script>';
    const hostile = await run(value, [citation()], payload);
    const marker = globalThis as Record<string, unknown>;
    delete marker.__pwned;
    render(value, { onStart: async () => ({ kind: "completed", run: hostile }) });
    await complete();
    const article = body().getByRole("article", { name: "Reader run request-1" });
    expect(article.textContent).toContain(payload);
    expect(article.querySelector("img")).toBeNull();
    expect(article.querySelector("script")).toBeNull();
    expect(article.querySelector("[onerror]")).toBeNull();
    expect(marker.__pwned).toBeUndefined();
  });

  test("I-21 a navigation refusal is keyed to its run and is not replayed onto a rerun", async () => {
    const value = await envelope();
    const second = await envelope("request-2");
    const bothChecked = () => ({ kind: "checked" as const, byScopeDigest: new Map([
      [value.scopeDigest, currentSources(value)], [second.scopeDigest, currentSources(second)]
    ]) });
    const onNavigate = mock(async (_request: Parameters<ReaderReviewProps["onNavigate"]>[0]) => "unavailable" as const);
    const view = render(value, { onNavigate });
    await complete();
    await checkSources();
    clickEvidence();
    await testing.waitFor(() => expect(statusText()).toBe(citationNavigationCopy.unavailable));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect((evidenceButton(0) as HTMLButtonElement).disabled).toBe(true);

    // A rerun discloses a new request; its evidence starts unblocked even with identical citation bytes.
    view.update({
      disclosureRevision: "facts-2",
      onPrepare: async () => ({ kind: "ready", prepared: prepared(second) }),
      onStart: async () => ({ kind: "completed", run: await run(second, [citation()]) }),
      onCheckSources: async () => bothChecked()
    });
    click("Prepare rerun");
    await testing.waitFor(() => expect(body().getByRole("button", { name: "Start with Synthetic provider" })).toBeTruthy());
    click("Start with Synthetic provider");
    await testing.waitFor(() => expect(body().getAllByRole("article")).toHaveLength(2));
    await checkSources();
    const buttons = body().getAllByRole("button", { name: /^Show exact passage for / });
    expect(buttons).toHaveLength(2);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
    testing.fireEvent.click(buttons[1] as HTMLButtonElement);
    await testing.waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(2));
    expect(onNavigate.mock.calls[1]?.[0].run.runId).toBe("request-2");
    expect(onNavigate.mock.calls[1]?.[0].citation).toEqual(citation());
  });
});
