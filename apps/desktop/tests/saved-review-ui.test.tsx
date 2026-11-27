/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReviewRecordApi, ReviewRecordResult, SavedReviewList } from "@ai-book-studio/core/library/review-record-api";
import { toLibraryFilePath } from "@ai-book-studio/core/library/path";
import type { BrowserLibraries } from "../../web/src/runtime/browser-libraries";
import { makeBook, readerRun } from "../../../packages/core/tests/review/record-fixtures";
import { mountDom, unmountDom } from "./support/dom";

let testing!: typeof import("@testing-library/react/pure");
let SavedReviewsPanel!: typeof import("@ai-book-studio/app/components/saved-review/SavedReviewsPanel").SavedReviewsPanel;
let ReaderReviewResults!: typeof import("@ai-book-studio/app/components/reader-review/ReaderReviewResults").ReaderReviewResults;
let WorkspaceView!: typeof import("@ai-book-studio/app/views/WorkspaceView").WorkspaceView;
let createBrowserStudioApi!: typeof import("../../web/src/runtime/browser-api").createBrowserStudioApi;
beforeAll(async () => {
  testing = await mountDom();
  ({ SavedReviewsPanel } = await import("@ai-book-studio/app/components/saved-review/SavedReviewsPanel"));
  ({ ReaderReviewResults } = await import("@ai-book-studio/app/components/reader-review/ReaderReviewResults"));
  ({ WorkspaceView } = await import("@ai-book-studio/app/views/WorkspaceView"));
  ({ createBrowserStudioApi } = await import("../../web/src/runtime/browser-api"));
});
afterEach(() => testing.cleanup());
afterAll(unmountDom);
const page = () => testing.within(document.body);
const click = (name: string) => testing.fireEvent.click(page().getByRole("button", { name }));
function value<T>(result: ReviewRecordResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}
function required<T>(item: T | null | undefined): T {
  if (item == null) throw new Error("Missing synthetic fixture value");
  return item;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function fixture() {
  const result = await makeBook();
  const studio = createBrowserStudioApi({ require: () => result.library } as BrowserLibraries);
  const api = required(studio.reviewRecords);
  const scope = value(await api.open(result.book.id, crypto.randomUUID()));
  const run = await readerRun(result.book.id);
  return { ...result, studio, api, scope, run };
}
async function openReview(id: string) {
  click("Saved reviews");
  testing.fireEvent.click(await page().findByRole("button", { name: `Inspect review ${id}` }));
  await page().findByText(/Review opened · Quotations/);
}

describe("saved reviews mounted over the real browser adapter and Library", () => {
  test("explicit result save/repeat/reopen, persisted disposition, confirmed recovery and unchanged manuscript", async () => {
    const { api, scope, run, book, library, port } = await fixture();
    const chapter = await library.createChapter(book.id, { title: "Synthetic manuscript", content: "Keep these synthetic words." });
    const path = toLibraryFilePath(["books", book.id, "chapters", chapter.path]);
    const before = required(await port.readFile(path)).sha256;
    const result = testing.render(<ReaderReviewResults runs={[run]} currentSources={[]} editor={undefined}
      navigationBusy={false} navigationRefusals={new Map()} onNavigate={() => { throw new Error("No navigation"); }} persistence={{ api, scope }} />);
    expect(value(await api.list(scope)).total).toBe(0);
    click("Save review");
    await page().findByText(/Review saved · Historical quotations/);
    click("Save review");
    await page().findByText(/Review already saved · Exact existing report confirmed/);
    result.unmount();
    testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic-browser" api={api} />);
    await openReview(run.runId);
    expect(page().getByText("Saved reader review · Synthetic provider · synthetic/model")).toBeTruthy();
    expect(page().getByText(/Not currently verified/)).toBeTruthy();
    expect(page().getByText("Selected 😀 exact.")).toBeTruthy();
    const note = page().getByRole("textbox", { name: "Local note for finding-1" }) as HTMLTextAreaElement;
    const disposition = page().getByRole("combobox", { name: "Local disposition for finding-1" }) as HTMLSelectElement;
    testing.fireEvent.change(note, { target: { value: "Exact local note  \n" } });
    testing.fireEvent.change(disposition, { target: { value: "ignored" } });
    click("Save disposition");
    await page().findByText(/Disposition saved · Exact history/);
    expect(disposition.value).toBe("ignored");
    const saved = required(value(await api.readDispositions(scope, run.runId, required(value(await api.list(scope)).reports[0]).hash)));
    expect(saved.record.dispositions[0]?.events[0]?.note).toBe("Exact local note  \n");
    testing.fireEvent.change(note, { target: { value: "Unsaved draft survives recovery  \n" } });
    click("Saved reviews"); click("Saved reviews");
    expect((page().getByRole("textbox", { name: "Local note for finding-1" }) as HTMLTextAreaElement).value).toBe("Unsaved draft survives recovery  \n");
    click("Move review to trash");
    await page().findByText(/Exact recovery contents inspected/);
    expect(value(await api.list(scope)).total).toBe(1);
    testing.fireEvent.click(page().getByRole("checkbox"));
    click("Confirm move to trash");
    await page().findByText(/Review moved to recoverable trash/);
    expect(value(await api.list(scope)).total).toBe(0);
    click("Inspect review trash");
    const groups = value(await api.listTrash(scope));
    testing.fireEvent.click(await page().findByRole("button", { name: `Inspect trash group ${required(groups.groups[0]).groupId}` }));
    await page().findByText(/Exact recovery contents inspected/);
    testing.fireEvent.click(page().getByRole("checkbox"));
    click("Confirm restore review");
    await page().findByText(/Review restored · Exact inspected/);
    expect(value(await api.readDispositions(scope, run.runId, saved.record.report.hash))?.rawJson).toBe(saved.rawJson);
    expect((page().getByRole("textbox", { name: "Local note for finding-1" }) as HTMLTextAreaElement).value).toBe("Unsaved draft survives recovery  \n");
    expect((await port.readFile(path))?.sha256).toBe(before);
  });

  test("real Workspace exposes Saved reviews and inspection through browser storage", async () => {
    const { api, scope, run, book, studio } = await fixture();
    value(await api.save(scope, run));
    Object.assign(window, { studio });
    const errors: unknown[] = [];
    testing.render(<WorkspaceView bookId={book.id} libraryRoot="synthetic-browser" theme={{ choice: "light", set: () => {}, cycle: () => {} }}
      onBack={() => {}} onNotice={(error) => errors.push(error)} onSchemaRefusal={() => {}} />);
    await page().findByRole("button", { name: "Saved reviews" });
    await openReview(run.runId);
    expect(page().getByRole("article", { name: `Saved review ${run.runId}` })).toBeTruthy();
    expect(page().getByText(/Structured reader generation is not connected/)).toBeTruthy();
    expect(errors).toEqual([]);
  });

  test("uncertain publication keeps the volatile result and prevents an automatic or repeated save", async () => {
    const { api, scope, run } = await fixture();
    let calls = 0;
    const lost: ReviewRecordApi = { ...api, save: async (...args) => { calls++; await api.save(...args); throw new Error("Synthetic lost receipt"); } };
    testing.render(<ReaderReviewResults runs={[run]} currentSources={[]} editor={undefined}
      navigationBusy={false} navigationRefusals={new Map()} onNavigate={() => {}} persistence={{ api: lost, scope }} />);
    click("Save review");
    await page().findByText(/Save outcome uncertain · Keep this review/);
    expect(page().getByText(required(run.findings[0]).interpretation)).toBeTruthy();
    expect((page().getByRole("button", { name: "Save review" }) as HTMLButtonElement).disabled).toBe(true);
    click("Save review");
    expect(calls).toBe(1);
    expect(value(await api.list(scope)).total).toBe(1);
  });

  test("equivalent run and API wrappers retain the in-flight latch and its actual reply", async () => {
    const { api, scope, run } = await fixture();
    const wait = deferred<void>();
    let calls = 0;
    const slow: ReviewRecordApi = { ...api, save: async (...args) => { calls++; await wait.promise; return api.save(...args); } };
    const render = (currentRun: typeof run, currentApi: ReviewRecordApi) => <ReaderReviewResults runs={[currentRun]} currentSources={[]} editor={undefined}
      navigationBusy={false} navigationRefusals={new Map()} onNavigate={() => {}} persistence={{ api: currentApi, scope: { ...scope } }} />;
    const mounted = testing.render(render(run, slow));
    click("Save review");
    mounted.rerender(render({ ...run }, { ...slow }));
    expect((page().getByRole("button", { name: "Save review" }) as HTMLButtonElement).disabled).toBe(true);
    click("Save review");
    expect(calls).toBe(1);
    await testing.act(async () => wait.resolve());
    await page().findByText(/Review saved · Historical quotations/);
  });

  test("uncertain save survives equivalent props and needs same-view read plus explicit author action", async () => {
    const { api, scope, run } = await fixture();
    let saves = 0, reads = 0;
    const lost: ReviewRecordApi = { ...api,
      save: async (...args) => { saves++; if (saves === 1) { await api.save(...args); throw new Error("Lost reply"); } return api.save(...args); },
      read: async (...args) => { reads++; expect(args[0]).toEqual(scope); return api.read(...args); }
    };
    const render = (currentRun: typeof run, currentApi: ReviewRecordApi) => <ReaderReviewResults runs={[currentRun]} currentSources={[]} editor={undefined}
      navigationBusy={false} navigationRefusals={new Map()} onNavigate={() => {}} persistence={{ api: currentApi, scope: { ...scope } }} />;
    const mounted = testing.render(render(run, lost));
    click("Save review");
    await page().findByText(/Save outcome uncertain · Keep this review/);
    mounted.rerender(render({ ...run }, { ...lost }));
    click("Save review");
    expect(saves).toBe(1);
    click("Inspect saved review for this run");
    await page().findByText(/Saved review inspected · Compare/);
    expect(reads).toBe(1);
    expect((page().getByRole("button", { name: "Save review" }) as HTMLButtonElement).disabled).toBe(true);
    expect(page().getByText(/Historical quotations verified-at-capture, not currently verified/)).toBeTruthy();
    click("I inspected the saved state · Allow another save");
    click("Save review");
    await page().findByText(/Review already saved · Exact existing report confirmed/);
    expect(saves).toBe(2);
  });

  test("failed same-view inspection leaves an uncertain report locked", async () => {
    const { api, scope, run } = await fixture();
    let calls = 0;
    const lost: ReviewRecordApi = { ...api, save: async () => { calls++; throw new Error("Lost reply"); }, list: async () => { throw new Error("No inspection"); } };
    testing.render(<ReaderReviewResults runs={[run]} currentSources={[]} editor={undefined} navigationBusy={false}
      navigationRefusals={new Map()} onNavigate={() => {}} persistence={{ api: lost, scope }} />);
    click("Save review");
    await page().findByText(/Save outcome uncertain · Keep this review/);
    click("Inspect saved review for this run");
    await page().findByText(/Inspection could not be confirmed/);
    expect(page().queryByRole("button", { name: "I inspected the saved state · Allow another save" })).toBeNull();
    expect((page().getByRole("button", { name: "Save review" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls).toBe(1);
  });

  test("empty same-view inspection warns that absence is not proof and requires confirmation", async () => {
    const { api, scope, run } = await fixture();
    let calls = 0;
    const lost: ReviewRecordApi = { ...api, save: async (...args) => { calls++; if (calls === 1) throw new Error("Lost reply"); return api.save(...args); } };
    testing.render(<ReaderReviewResults runs={[run]} currentSources={[]} editor={undefined} navigationBusy={false}
      navigationRefusals={new Map()} onNavigate={() => {}} persistence={{ api: lost, scope }} />);
    click("Save review");
    await page().findByText(/Save outcome uncertain · Keep this review/);
    click("Inspect saved review for this run");
    await page().findByText(/No readable matching report was listed; this does not prove/);
    expect((page().getByRole("button", { name: "Save review" }) as HTMLButtonElement).disabled).toBe(true);
    click("I inspected the saved state · Allow another save");
    click("Save review");
    await page().findByText(/Review saved · Historical quotations/);
    expect(calls).toBe(2);
  });

  test("late save completion cannot relabel a new view, including A → B → A", async () => {
    const { api, scope, run, book } = await fixture();
    const delayed = deferred<Awaited<ReturnType<ReviewRecordApi["save"]>>>();
    const slow = { ...api, save: () => delayed.promise };
    const render = (viewId: string) => <ReaderReviewResults runs={[run]} currentSources={[]} editor={undefined}
      navigationBusy={false} navigationRefusals={new Map()} onNavigate={() => {}} persistence={{ api: slow, scope: { ...scope, viewId } }} />;
    const mounted = testing.render(render(scope.viewId));
    click("Save review");
    mounted.rerender(render(crypto.randomUUID()));
    mounted.rerender(render(scope.viewId));
    await testing.act(async () => delayed.resolve(await api.save(scope, run)));
    expect(page().queryByText(/Review saved ·/)).toBeNull();
    expect(page().getByText(/Volatile review · Save explicitly/)).toBeTruthy();
    expect(value(await api.list(scope)).bookId).toBe(book.id);
  });

  test("late list completion cannot enter a returned book; missing API is explicit", async () => {
    const { api, scope, run, book } = await fixture();
    value(await api.save(scope, run));
    const delayed = deferred<ReviewRecordResult<SavedReviewList>>();
    let calls = 0;
    const slow: ReviewRecordApi = { ...api, list: async (...args) => { calls++; return calls === 1 ? delayed.promise : api.list(...args); } };
    const mounted = testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic-A" api={slow} />);
    click("Saved reviews");
    await testing.waitFor(() => expect(calls).toBe(1));
    mounted.rerender(<SavedReviewsPanel bookId="book_other001" libraryKey="synthetic-A" api={undefined} />);
    click("Saved reviews");
    expect(page().getByText(/Saved reviews are unavailable on this host/)).toBeTruthy();
    mounted.rerender(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic-A" api={slow} />);
    await testing.act(async () => delayed.resolve(await api.list(scope)));
    expect(page().getByRole("button", { name: "Saved reviews" }).getAttribute("aria-expanded")).toBe("false");
    expect(page().queryByRole("button", { name: `Inspect review ${run.runId}` })).toBeNull();
    await openReview(run.runId);
  });

  test("failed refresh/read retains inspected feedback, saved disposition history and exact local drafts", async () => {
    const { api, scope, run, book, library } = await fixture();
    value(await api.save(scope, run));
    await library.reviewRecords.recordDisposition(book.id, run.runId, { findingId: "finding-1", state: "ignored", note: "Previously saved author note" });
    const mutable = { ...api };
    testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic" api={mutable} />);
    await openReview(run.runId);
    const note = page().getByRole("textbox", { name: "Local note for finding-1" }) as HTMLTextAreaElement;
    testing.fireEvent.change(note, { target: { value: "Retain draft through failure" } });
    mutable.list = async () => { throw new Error("Synthetic list failure"); };
    click("Refresh saved reviews");
    await page().findByText(/Saved reviews could not be loaded/);
    expect(note.value).toBe("Retain draft through failure");
    mutable.readDispositions = async () => ({ ok: false, error: { code: "corrupt", outcome: "refused", message: "Synthetic corrupt dispositions" } });
    click(`Inspect review ${run.runId}`);
    await page().findByText(/Saved dispositions unavailable · Request refused/);
    expect(page().getByText(/Previously saved author note/)).toBeTruthy();
    expect((page().getByRole("textbox", { name: "Local note for finding-1" }) as HTMLTextAreaElement).value).toBe("Retain draft through failure");
    expect(page().getByText(required(run.findings[0]).interpretation)).toBeTruthy();
    expect((page().getByRole("button", { name: "Move review to trash" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("local filtering and keyboard-labelled inspection controls never write", async () => {
    const { api, scope, run, book, port } = await fixture();
    value(await api.save(scope, run));
    let writes = 0;
    port.commitFile = async () => { writes++; throw new Error("No writes during inspection"); };
    testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic" api={api} />);
    const opener = page().getByRole("button", { name: "Saved reviews" });
    opener.focus();
    expect(document.activeElement).toBe(opener);
    await openReview(run.runId);
    const filter = page().getByRole("textbox", { name: "Filter this page" });
    testing.fireEvent.change(filter, { target: { value: "no matching report" } });
    expect(page().queryByRole("button", { name: `Inspect review ${run.runId}` })).toBeNull();
    expect(page().getByRole("article", { name: `Saved review ${run.runId}` })).toBeTruthy();
    expect(writes).toBe(0);
  });

  test("uncertain disposition receipt preserves exact draft, locks replay and requires fresh inspection", async () => {
    const { api, scope, run, book } = await fixture();
    const report = value(await api.save(scope, run)).report;
    let calls = 0;
    const lost: ReviewRecordApi = { ...api, saveDisposition: async (input) => {
      calls++;
      const result = await api.saveDisposition(input);
      if (calls === 1) throw new Error("Lost disposition receipt");
      return result;
    } };
    testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic" api={lost} />);
    await openReview(run.runId);
    const note = page().getByRole("textbox", { name: "Local note for finding-1" }) as HTMLTextAreaElement;
    testing.fireEvent.change(note, { target: { value: "Exact uncertain note  \n" } });
    click("Save disposition");
    await page().findByText(/disposition save could not be confirmed/);
    expect(note.value).toBe("Exact uncertain note  \n");
    expect((page().getByRole("button", { name: "Save disposition" }) as HTMLButtonElement).disabled).toBe(true);
    expect((page().getByRole("button", { name: "Use inspected history for this draft" }) as HTMLButtonElement).disabled).toBe(true);
    click("Saved reviews"); click("Saved reviews"); click("Save disposition");
    expect(calls).toBe(1);
    click(`Inspect review ${run.runId}`);
    await page().findByText(/Review opened · Quotations/);
    expect((page().getByRole("button", { name: "Save disposition" }) as HTMLButtonElement).disabled).toBe(true);
    expect(value(await api.readDispositions(scope, run.runId, report.hash))?.record.dispositions[0]?.events).toHaveLength(1);
    expect(note.value).toBe("Exact uncertain note  \n");
    testing.fireEvent.change(note, { target: { value: "Explicitly revised after inspection  \n" } });
    click("Save disposition");
    expect(calls).toBe(1);
    click("Use inspected history for this draft");
    click("Save disposition");
    await page().findByText(/Disposition saved · Exact history/);
    expect(calls).toBe(2);
    expect(value(await api.readDispositions(scope, run.runId, report.hash))?.record.dispositions[0]?.events.map((event) => event.note))
      .toEqual(["Exact uncertain note  \n", "Explicitly revised after inspection  \n"]);
  });

  test("refresh does not silently rebase a draft; stale save preserves a conflict and the note", async () => {
    const { api, scope, run, book, library } = await fixture();
    value(await api.save(scope, run));
    testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic" api={api} />);
    await openReview(run.runId);
    const note = page().getByRole("textbox", { name: "Local note for finding-1" }) as HTMLTextAreaElement;
    testing.fireEvent.change(note, { target: { value: "My stale note" } });
    await library.reviewRecords.recordDisposition(book.id, run.runId, { findingId: "finding-1", state: "ignored", note: "Competing author" });
    click(`Inspect review ${run.runId}`);
    await page().findByText(/Competing author/);
    click("Save disposition");
    await page().findByText(/Conflict copy kept/);
    expect(note.value).toBe("My stale note");
    expect((await library.reviewRecords.readDispositions(book.id, run.runId))?.record.dispositions[0]?.events).toHaveLength(1);
  });

  test.each(["disposition", "recovery"])("late %s completion cannot revive a collapsed or ABA view", async (kind) => {
    const { api, scope, run, book } = await fixture();
    value(await api.save(scope, run));
    const wait = deferred<void>();
    let calls = 0;
    const slow: ReviewRecordApi = { ...api,
      saveDisposition: async (input) => { calls++; await wait.promise; return api.saveDisposition(input); },
      moveGroup: async (...args) => { calls++; await wait.promise; return api.moveGroup(...args); }
    };
    const mounted = testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="A" api={slow} />);
    await openReview(run.runId);
    if (kind === "disposition") {
      testing.fireEvent.change(page().getByRole("textbox", { name: "Local note for finding-1" }), { target: { value: "Late exact draft" } });
      click("Save disposition");
    } else {
      click("Move review to trash");
      await page().findByText(/Exact recovery contents inspected/);
      testing.fireEvent.click(page().getByRole("checkbox"));
      click("Confirm move to trash");
    }
    await testing.waitFor(() => expect(calls).toBe(1));
    click("Saved reviews"); click("Saved reviews");
    mounted.rerender(<SavedReviewsPanel bookId={book.id} libraryKey="B" api={slow} />);
    mounted.rerender(<SavedReviewsPanel bookId={book.id} libraryKey="A" api={slow} />);
    await testing.act(async () => wait.resolve());
    expect(page().queryByText(/Disposition saved ·|Review moved to recoverable trash ·/)).toBeNull();
    expect(calls).toBe(1);
  });

  test("uncertain recovery preserves inspected contents and cannot replay confirmation", async () => {
    const { api, scope, run, book } = await fixture();
    value(await api.save(scope, run));
    let calls = 0;
    const lost: ReviewRecordApi = { ...api, moveGroup: async (...args) => { calls++; await api.moveGroup(...args); throw new Error("Lost move receipt"); } };
    testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic" api={lost} />);
    await openReview(run.runId);
    click("Move review to trash");
    await page().findByText(/Exact recovery contents inspected/);
    testing.fireEvent.click(page().getByRole("checkbox"));
    click("Confirm move to trash");
    await page().findByText(/Recovery outcome could not be confirmed/);
    expect(page().getByRole("region", { name: "Inspected recovery contents" })).toBeTruthy();
    expect((page().getByRole("button", { name: "Confirm move to trash" }) as HTMLButtonElement).disabled).toBe(true);
    click("Confirm move to trash");
    expect(calls).toBe(1);
    expect(value(await api.listTrash(scope)).total).toBe(1);
  });

  test("an exact disposition success never discards newer typing during the await", async () => {
    const { api, scope, run, book } = await fixture();
    const report = value(await api.save(scope, run)).report;
    const wait = deferred<void>();
    const slow: ReviewRecordApi = { ...api, saveDisposition: async (input) => { await wait.promise; return api.saveDisposition(input); } };
    testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic" api={slow} />);
    await openReview(run.runId);
    const note = page().getByRole("textbox", { name: "Local note for finding-1" }) as HTMLTextAreaElement;
    testing.fireEvent.change(note, { target: { value: "Submitted exact note" } });
    click("Save disposition");
    testing.fireEvent.change(note, { target: { value: "Newer typing stays  \n" } });
    await testing.act(async () => wait.resolve());
    await page().findByText(/Disposition saved · Exact history/);
    expect(note.value).toBe("Newer typing stays  \n");
    expect(value(await api.readDispositions(scope, run.runId, report.hash))?.record.dispositions[0]?.events[0]?.note).toBe("Submitted exact note");
    expect((page().getByRole("button", { name: "Save disposition" }) as HTMLButtonElement).disabled).toBe(true);
    click("Use inspected history for this draft");
    click("Save disposition");
    await testing.waitFor(async () => expect(value(await api.readDispositions(scope, run.runId, report.hash))?.record.revision).toBe(2));
    const saved = required(value(await api.readDispositions(scope, run.runId, report.hash)));
    expect(saved.record.dispositions[0]?.events.map((event) => event.note)).toEqual(["Submitted exact note", "Newer typing stays  \n"]);
  });

  test("a confirmed disposition blocks a different retained draft until its inspected baseline is adopted", async () => {
    const { api, scope, run, book } = await fixture();
    const first = required(run.findings[0]);
    const twoFindings = { ...run, findings: [first, { ...first, findingId: "finding-2", interpretation: "Another synthetic finding." }] };
    const report = value(await api.save(scope, twoFindings)).report;
    const wait = deferred<void>();
    let calls = 0;
    const slow: ReviewRecordApi = { ...api, saveDisposition: async (input) => {
      calls++;
      if (calls === 1) await wait.promise;
      return api.saveDisposition(input);
    } };
    testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic" api={slow} />);
    await openReview(run.runId);
    const firstPanel = () => testing.within(page().getByRole("region", { name: "Saved finding finding-1" }));
    const secondPanel = () => testing.within(page().getByRole("region", { name: "Saved finding finding-2" }));
    testing.fireEvent.change(firstPanel().getByRole("textbox", { name: "Local note for finding-1" }), { target: { value: "First finding note" } });
    testing.fireEvent.click(firstPanel().getByRole("button", { name: "Save disposition" }));
    testing.fireEvent.change(secondPanel().getByRole("textbox", { name: "Local note for finding-2" }), { target: { value: "Retained second note  \n" } });
    await testing.act(async () => wait.resolve());
    await page().findByText(/Disposition saved · Exact history/);
    expect((secondPanel().getByRole("button", { name: "Save disposition" }) as HTMLButtonElement).disabled).toBe(true);
    expect((secondPanel().getByRole("textbox", { name: "Local note for finding-2" }) as HTMLTextAreaElement).value).toBe("Retained second note  \n");
    testing.fireEvent.click(secondPanel().getByRole("button", { name: "Use inspected history for this draft" }));
    testing.fireEvent.click(secondPanel().getByRole("button", { name: "Save disposition" }));
    await testing.waitFor(async () => expect(value(await api.readDispositions(scope, run.runId, report.hash))?.record.revision).toBe(2));
    const saved = required(value(await api.readDispositions(scope, run.runId, report.hash)));
    expect(saved.record.dispositions.map((entry) => entry.events[0]?.note)).toEqual(["First finding note", "Retained second note  \n"]);
    expect(calls).toBe(2);
  });

  test.each(["before", "during", "after"] as const)("an uncertain disposition blocks another draft edited %s its lost reply", async (when) => {
    const { api, scope, run, book } = await fixture();
    const first = required(run.findings[0]);
    const twoFindings = { ...run, findings: [first, { ...first, findingId: "finding-2", interpretation: "Another synthetic finding." }] };
    const report = value(await api.save(scope, twoFindings)).report;
    const wait = deferred<void>();
    let calls = 0;
    const lost: ReviewRecordApi = { ...api, saveDisposition: async (input) => {
      calls++;
      const result = await api.saveDisposition(input);
      if (calls === 1) { if (when === "during") await wait.promise; throw new Error("Lost disposition receipt"); }
      return result;
    } };
    testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic" api={lost} />);
    await openReview(run.runId);
    const firstPanel = () => testing.within(page().getByRole("region", { name: "Saved finding finding-1" }));
    const secondPanel = () => testing.within(page().getByRole("region", { name: "Saved finding finding-2" }));
    const editSecond = () => testing.fireEvent.change(secondPanel().getByRole("textbox", { name: "Local note for finding-2" }), { target: { value: "Other retained draft  \n" } });
    if (when === "before") editSecond();
    testing.fireEvent.change(firstPanel().getByRole("textbox", { name: "Local note for finding-1" }), { target: { value: "First saved without receipt" } });
    testing.fireEvent.click(firstPanel().getByRole("button", { name: "Save disposition" }));
    if (when === "during") { editSecond(); await testing.act(async () => wait.resolve()); }
    await page().findByText(/disposition save could not be confirmed/);
    if (when === "after") editSecond();
    testing.fireEvent.click(page().getByRole("button", { name: `Inspect review ${run.runId}` }));
    await page().findByText(/Review opened · Quotations/);
    expect((secondPanel().getByRole("button", { name: "Save disposition" }) as HTMLButtonElement).disabled).toBe(true);
    expect((secondPanel().getByRole("textbox", { name: "Local note for finding-2" }) as HTMLTextAreaElement).value).toBe("Other retained draft  \n");
    testing.fireEvent.click(secondPanel().getByRole("button", { name: "Use inspected history for this draft" }));
    testing.fireEvent.click(secondPanel().getByRole("button", { name: "Save disposition" }));
    await testing.waitFor(async () => expect(value(await api.readDispositions(scope, run.runId, report.hash))?.record.revision).toBe(2));
    expect(required(value(await api.readDispositions(scope, run.runId, report.hash))).record.dispositions.map((entry) => entry.events[0]?.note))
      .toEqual(["First saved without receipt", "Other retained draft  \n"]);
    expect(calls).toBe(2);
  });

  test("untouched blank note with edit/revert is a zero-write repeat; explicitly entered whitespace stays exact", async () => {
    const { api, scope, run, book, library, port } = await fixture();
    const report = value(await api.save(scope, run)).report;
    const seeded = await library.reviewRecords.recordDisposition(book.id, run.runId, { findingId: "finding-1", state: "ignored" });
    let writes = 0;
    const commit = port.commitFile.bind(port);
    port.commitFile = async (...args) => { if (args[0].includes("dispositions")) writes++; return commit(...args); };
    testing.render(<SavedReviewsPanel bookId={book.id} libraryKey="synthetic" api={api} />);
    await openReview(run.runId);
    const choice = page().getByRole("combobox", { name: "Local disposition for finding-1" });
    testing.fireEvent.change(choice, { target: { value: "author-resolved" } });
    testing.fireEvent.change(choice, { target: { value: "ignored" } });
    click("Save disposition");
    await page().findByText(/Disposition saved · Exact history/);
    const repeated = required(value(await api.readDispositions(scope, run.runId, report.hash)));
    expect(repeated.hash).toBe(seeded.record.hash);
    expect(repeated.record.dispositions[0]?.events).toHaveLength(1);
    expect(writes).toBe(0);
    testing.fireEvent.change(page().getByRole("textbox", { name: "Local note for finding-1" }), { target: { value: "  \n" } });
    click("Save disposition");
    await testing.waitFor(async () => expect(value(await api.readDispositions(scope, run.runId, report.hash))?.record.revision).toBe(2));
    const after = required(value(await api.readDispositions(scope, run.runId, report.hash)));
    expect(after.record.dispositions[0]?.events.at(-1)?.note).toBe("  \n");
    expect(writes).toBe(1);
    // The storage write can be visible before its receipt settles the panel.
    await testing.waitFor(() => expect(page().getByText(/Saved disposition: ignored · No local changes/)).toBeTruthy());
    const note = page().getByRole("textbox", { name: "Local note for finding-1" });
    testing.fireEvent.change(note, { target: { value: "temporarily entered" } });
    testing.fireEvent.change(note, { target: { value: "" } });
    click("Save disposition");
    await testing.waitFor(async () => expect(value(await api.readDispositions(scope, run.runId, report.hash))?.record.revision).toBe(3));
    expect(value(await api.readDispositions(scope, run.runId, report.hash))?.record.dispositions[0]?.events.at(-1)?.note).toBe("");
    expect(writes).toBe(2);
  });
});
