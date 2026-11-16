import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement, StrictMode } from "react";
import { mountDom, unmountDom } from "./support/dom";
import type { InlineEditor as Editor } from "../../../packages/app/src/components/inline-editor/editor";
import type { InlineChange, InlineEditorOptions, InlineInspection, InlineSource, ValidatedInlineLayer } from "../../../packages/app/src/components/inline-editor/contracts";
import type { InlineSpan } from "../../../packages/core/src/review/inline/overlap";
import { clearEditorHistory, pushHistory, undoHistory } from "../../../packages/app/src/lib/editor-history";

let testing: Awaited<ReturnType<typeof mountDom>>;
let InlineEditor: typeof import("../../../packages/app/src/components/inline-editor/editor").InlineEditor;
let Surface: typeof import("../../../packages/app/src/components/inline-editor/InlineTextSurface");
const editors: Editor[] = [];
const body = "A😀 café repeats. A😀 café repeats.\n";
const source: InlineSource = { libraryId: "library", bookId: "book", chapterId: "chapter", viewGeneration: "visit-1", sourceEpoch: 1, version: 1, rawHash: "a".repeat(64), savedBody: body, clean: true, pending: false, available: true };
const spans: InlineSpan[] = [
  { runId: "r", findingId: "a", evidenceId: "e", spanId: "1", category: "clarity", from: 1, to: 9, quote: body.slice(1, 9) },
  { runId: "r", findingId: "b", evidenceId: "e", spanId: "1", category: "clarity", from: 4, to: 12, quote: body.slice(4, 12) }
];

beforeAll(async () => {
  testing = await mountDom();
  ({ InlineEditor } = await import("../../../packages/app/src/components/inline-editor/editor"));
  Surface = await import("../../../packages/app/src/components/inline-editor/InlineTextSurface");
});
afterEach(() => {
  testing.cleanup();
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});
afterAll(unmountDom);

function fixture(validate?: InlineEditorOptions["evidence"]["validate"]) {
  let live = { ...source };
  const changes: InlineChange[] = [];
  const commands: string[] = [];
  const inspections: InlineInspection[] = [];
  const statuses: string[] = [];
  const options: InlineEditorOptions = {
    initialText: body, readSource: () => live,
    // A trusted synthetic proof stub. Production must inject the reviewed shared verifier.
    evidence: { validate: validate ?? (async () => ({ source: live, spans })) },
    onChange: (change) => { changes.push(change); }, onCommand: (command) => { commands.push(command); },
    onInspect: (item) => { inspections.push(item); }, onReviewStatus: (status) => { statuses.push(status); },
    onComposition: () => {}, onBlur: () => {}
  };
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = new InlineEditor(parent, options);
  editors.push(editor);
  return { editor, options, parent, changes, commands, inspections, statuses, setSource: (next: Partial<InlineSource>) => { live = { ...live, ...next }; } };
}

describe("isolated exact-current editor", () => {
  test("exact UTF-16 text and backward selection; navigation/filtering do not emit text changes", async () => {
    const { editor, changes, parent, inspections } = fixture();
    expect(editor.getSnapshot().body).toBe(body);
    expect(editor.setSelection({ anchor: 9, head: 1 })).toBe(true);
    expect(editor.getSnapshot().selectedText).toBe("😀 café");
    expect(await editor.showEvidence({})).toBe("applied");
    expect(parent.querySelectorAll(".inline-review-mark").length).toBeGreaterThan(0);
    expect(editor.inspectAt(5)).toBe(true);
    expect(inspections.at(-1)?.choices.map((item) => item.findingId)).toEqual(["a", "b"]);
    editor.setVisibility(null, true);
    expect(parent.querySelectorAll(".inline-review-mark").length).toBe(0);
    editor.setVisibility(null, false);
    expect(editor.reviewCommand("next")).toBe(true);
    expect(editor.getSnapshot().selectedText).toBe(body.slice(4, 12));
    expect(changes).toHaveLength(0);
  });

  test("an edit removes marks before the host onChange/debounce can run; undo needs fresh proof", async () => {
    const f = fixture();
    await f.editor.showEvidence({});
    const previousRevision = f.editor.getSnapshot().revision;
    expect(f.editor.replaceText(`${body}new`, previousRevision)).toBe(true);
    expect(f.parent.querySelectorAll(".inline-review-mark")).toHaveLength(0);
    expect(await f.editor.showEvidence({})).toBe("stale");
    expect(f.editor.replaceText("late echo", previousRevision)).toBe(false);
    expect(f.editor.replaceText(body, f.editor.getSnapshot().revision, "undo")).toBe(true);
    expect(f.changes.at(-1)?.recordHistory).toBe(false);
    expect(f.parent.querySelectorAll(".inline-review-mark")).toHaveLength(0);
    expect(await f.editor.showEvidence({})).toBe("applied");
  });

  test("saved status cannot certify dirty text, pending writes, unavailable source or truthy clean", async () => {
    const f = fixture();
    for (const next of [{ clean: false }, { clean: true, pending: true }, { pending: false, available: false }, { available: true, clean: 1 as unknown as boolean }]) {
      f.setSource(next);
      expect(await f.editor.showEvidence({})).toBe("stale");
    }
  });

  test("final post-await gate rejects identity, version/hash/body, view and source-epoch ABA", async () => {
    for (const change of [
      { libraryId: "other" }, { bookId: "other" }, { chapterId: "other" }, { viewGeneration: "visit-2" },
      { sourceEpoch: 3 }, { version: 2 }, { rawHash: "b".repeat(64) }, { savedBody: `${body}other` }, { clean: false }, { pending: true }
    ]) {
      let resolve!: (proof: ValidatedInlineLayer) => void;
      const f = fixture(() => new Promise((done) => { resolve = done; }));
      const promise = f.editor.showEvidence({});
      f.setSource(change);
      resolve({ source, spans });
      expect(await promise).toBe("stale");
      expect(f.parent.querySelectorAll(".inline-review-mark")).toHaveLength(0);
    }
  });

  test("edit, hold, destroy and superseding requests defeat late validation", async () => {
    for (const operation of ["edit", "hold", "destroy", "request"] as const) {
      const resolvers: Array<(proof: ValidatedInlineLayer) => void> = [];
      const f = fixture(() => new Promise((done) => { resolvers.push(done); }));
      const pending = f.editor.showEvidence({});
      let second: Promise<unknown> | undefined;
      if (operation === "edit") f.editor.replaceText("changed", f.editor.getSnapshot().revision);
      if (operation === "hold") f.editor.hold()();
      if (operation === "destroy") f.editor.destroy();
      if (operation === "request") second = f.editor.showEvidence({});
      const resolveFirst = resolvers[0];
      if (!resolveFirst) throw new Error("Missing first validation");
      resolveFirst({ source, spans });
      expect(await pending).toBe("superseded");
      if (second) {
        const resolveSecond = resolvers[1];
        if (!resolveSecond) throw new Error("Missing second validation");
        resolveSecond({ source, spans });
        expect(await second).toBe("applied");
      }
    }
  });

  test("unverified evidence is withheld; proof-port failures never display raw errors", async () => {
    for (const validator of [async () => null, async () => { throw new Error("private sentinel"); }]) {
      const f = fixture(validator);
      expect(await f.editor.showEvidence({ quote: "invented" })).toBe("unavailable");
      expect(f.parent.textContent).not.toContain("private sentinel");
    }
  });

  test("a former visit's imperative handles cannot replace, select or rebase another visit", () => {
    const f = fixture();
    const old = f.editor.getSnapshot();
    f.setSource({ viewGeneration: "visit-2" });
    expect(f.editor.replaceText("late transcript", old.revision, "dictation")).toBe(false);
    expect(f.editor.setSelection({ anchor: 1, head: 9 }, true)).toBe(false);
    expect(f.editor.rebase({ ...source, viewGeneration: "visit-2" })).toBe(false);
    expect(f.editor.getSnapshot().body).toBe(body);
    expect(f.changes).toHaveLength(0);
  });

  test("the port receives immutable exact buffer/identity and detached results cannot be retargeted", async () => {
    let targetSeen: unknown;
    const mutable = spans.map((span) => ({ ...span }));
    const f = fixture(async (_input, target) => {
      targetSeen = target;
      return { source, spans: mutable };
    });
    expect(await f.editor.showEvidence({ envelope: "synthetic" })).toBe("applied");
    expect(Object.isFrozen(targetSeen)).toBe(true);
    const first = mutable[0];
    if (!first) throw new Error("Missing fixture");
    first.from = 20;
    first.quote = "changed after proof";
    f.editor.reviewCommand("next");
    expect(f.editor.getSnapshot().selectedText).toBe("😀 café");
    expect(f.inspections.at(-1)?.active.quote).toBe("😀 café");
  });

  test("metadata rebase preserves dirty draft and stales marks; hold is nested/idempotent", async () => {
    const f = fixture();
    await f.editor.showEvidence({});
    f.editor.replaceText(`${body}draft`, f.editor.getSnapshot().revision);
    f.setSource({ version: 2, rawHash: "b".repeat(64), sourceEpoch: 2 });
    expect(f.editor.rebase(source)).toBe(true);
    expect(f.editor.getSnapshot().body).toBe(`${body}draft`);
    const first = f.editor.hold(); const second = f.editor.hold();
    first(); first();
    expect(f.editor.replaceText("blocked", f.editor.getSnapshot().revision)).toBe(false);
    second();
    expect(f.editor.getSnapshot().held).toBe(false);
  });

  test("refused changed-body rebase also removes old marks without replacing the buffer", async () => {
    const f = fixture();
    await f.editor.showEvidence({});
    f.setSource({ savedBody: "different saved source", sourceEpoch: 2 });
    expect(f.editor.rebase(source)).toBe(false);
    expect(f.parent.querySelectorAll(".inline-review-mark")).toHaveLength(0);
    expect(f.editor.getSnapshot().body).toBe(body);
    expect(f.changes).toHaveLength(0);
  });

  test("paste/voice use existing text policies with isolated history; save/undo/redo delegate once", () => {
    const f = fixture();
    f.editor.setSelection({ anchor: 0, head: body.length });
    expect(f.editor.paste("“Verse”\r\nline  \r\n\r\n\r\nend")).toBe(true);
    expect(f.editor.getSnapshot().body).toBe('"Verse"\nline  \n\nend');
    expect(f.changes.at(-1)?.isolated).toBe(true);
    f.editor.setSelection({ anchor: 0, head: 0 });
    expect(f.editor.insertDictation("  spoken\nwords ", f.editor.getSnapshot().revision)).toBe(true);
    expect(f.editor.getSnapshot().body).toStartWith('spoken\nwords "Verse"');
    expect(f.changes.at(-1)).toMatchObject({ origin: "dictation", isolated: true, recordHistory: true });
    const content = f.parent.querySelector(".cm-content");
    if (!content) throw new Error("Missing editor");
    for (const inputType of ["historyUndo", "historyRedo"]) testing.fireEvent(content, new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }));
    testing.fireEvent.keyDown(content, { key: "s", ctrlKey: true });
    expect(f.commands).toEqual(["undo", "redo", "save"]);
  });

  test("default dictation keeps a selection and a line break; replace is one isolated undo", () => {
    const chapterId = "dictation-selection";
    clearEditorHistory(chapterId);
    const f = fixture();
    const remember = (): void => {
      const change = f.changes.at(-1);
      if (change?.recordHistory) pushHistory(chapterId, change.previous, 5_000, change.isolated);
    };

    expect(f.editor.replaceText("One old two", f.editor.getSnapshot().revision)).toBe(true);
    f.editor.setSelection({ anchor: 4, head: 7 });
    expect(f.editor.getSnapshot().selectedText).toBe("old");
    expect(f.editor.insertDictation("new", f.editor.getSnapshot().revision)).toBe(true);
    expect(f.editor.getSnapshot().body).toBe("One new old two");
    expect(f.editor.getSnapshot().selection).toEqual({ anchor: 8, head: 8 });
    expect(f.changes.at(-1)).toMatchObject({ origin: "dictation", isolated: true, recordHistory: true, previous: "One old two" });

    expect(f.editor.replaceText("One old two", f.editor.getSnapshot().revision)).toBe(true);
    f.editor.setSelection({ anchor: 4, head: 7 });
    expect(f.editor.replaceDictation("new", f.editor.getSnapshot().revision)).toBe(true);
    expect(f.editor.getSnapshot().body).toBe("One new two");
    expect(f.editor.getSnapshot().selection).toEqual({ anchor: 7, head: 7 });
    expect(f.changes.at(-1)).toMatchObject({ origin: "dictation", isolated: true, recordHistory: true, previous: "One old two" });
    remember();
    const restored = undoHistory(chapterId, f.editor.getSnapshot().body);
    expect(restored).toBe("One old two");
    expect(f.editor.replaceText(restored ?? "", f.editor.getSnapshot().revision, "undo")).toBe(true);
    expect(f.editor.getSnapshot().body).toBe("One old two");
    expect(f.changes.at(-1)?.recordHistory).toBe(false);

    f.editor.setSelection({ anchor: 0, head: 0 });
    expect(f.editor.insertDictation("  line\nbreak ", f.editor.getSnapshot().revision)).toBe(true);
    expect(f.editor.getSnapshot().body).toBe("line\nbreak One old two");
    const quiet = f.editor.getSnapshot();
    expect(f.editor.insertDictation("   ", quiet.revision)).toBe(false);
    expect(f.editor.getSnapshot().body).toBe(quiet.body);
    f.editor.setSelection({ anchor: 0, head: 0 });
    expect(f.editor.replaceDictation("\n", quiet.revision)).toBe(true);
    expect(f.editor.getSnapshot().body).toBe("\nline\nbreak One old two");

    const release = f.editor.hold();
    const held = f.editor.getSnapshot().body;
    expect(f.editor.insertDictation("nope", f.editor.getSnapshot().revision)).toBe(false);
    expect(f.editor.replaceDictation("nope", f.editor.getSnapshot().revision)).toBe(false);
    expect(f.editor.getSnapshot().body).toBe(held);
    release();

    const stale = f.editor.getSnapshot().revision;
    expect(f.editor.insertDictation("later", stale)).toBe(true);
    expect(f.editor.replaceDictation("later", stale)).toBe(false);
    const visit = f.editor.getSnapshot();
    f.setSource({ viewGeneration: "visit-2" });
    expect(f.editor.insertDictation("other", visit.revision)).toBe(false);
    expect(f.editor.replaceDictation("other", visit.revision)).toBe(false);
    clearEditorHistory(chapterId);
  });

  test("user paste during hold inserts normalized text like typing; controlled changes stay refused", async () => {
    const f = fixture();
    expect(await f.editor.showEvidence({})).toBe("applied");
    const content = f.parent.querySelector(".cm-content");
    if (!content) throw new Error("Missing editor");
    const release = f.editor.hold();
    expect(f.editor.getSnapshot().held).toBe(true);
    expect(f.editor.replaceText("controlled", f.editor.getSnapshot().revision)).toBe(false);
    expect(f.editor.insertDictation("dictated", f.editor.getSnapshot().revision)).toBe(false);
    expect(f.editor.replaceDictation("dictated", f.editor.getSnapshot().revision)).toBe(false);
    expect(await f.editor.showEvidence({})).toBe("stale");
    expect(f.editor.getSnapshot().body).toBe(body);
    expect(f.changes).toHaveLength(0);
    f.editor.setSelection({ anchor: 0, head: 0 });
    testing.fireEvent.paste(content, {
      clipboardData: { getData: () => "“Held”\r\nline  \r\n\r\n\r\nend" }
    });
    const inserted = '"Held"\nline  \n\nend';
    expect(f.editor.getSnapshot().body).toBe(inserted + body);
    expect(f.editor.getSnapshot().selection).toEqual({ anchor: inserted.length, head: inserted.length });
    expect(f.changes.at(-1)).toMatchObject({ origin: "paste", isolated: true, recordHistory: true });
    release();
    expect(f.editor.getSnapshot().held).toBe(false);
    testing.fireEvent.compositionStart(content);
    expect(f.editor.getSnapshot().composing).toBe(true);
    expect(f.editor.paste("must not insert")).toBe(false);
    expect(f.editor.getSnapshot().body).toBe(inserted + body);
    testing.fireEvent.compositionEnd(content, { data: "" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.editor.getSnapshot().composing).toBe(false);
    expect(f.editor.getSnapshot().body).toBe(inserted + body);
  });

  test("composition start/cancel suspends external changes and even unchanged saved marks", async () => {
    const f = fixture();
    await f.editor.showEvidence({});
    const content = f.parent.querySelector(".cm-content");
    if (!content) throw new Error("Missing editor");
    testing.fireEvent.compositionStart(content);
    expect(f.editor.getSnapshot().composing).toBe(true);
    expect(f.editor.insertDictation("refused", f.editor.getSnapshot().revision)).toBe(false);
    expect(f.editor.replaceDictation("refused", f.editor.getSnapshot().revision)).toBe(false);
    expect(f.editor.replaceText("refused", f.editor.getSnapshot().revision)).toBe(false);
    expect(f.parent.querySelectorAll(".inline-review-mark")).toHaveLength(0);
    testing.fireEvent.compositionEnd(content, { data: "" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.editor.getSnapshot().composing).toBe(false);
    expect(f.editor.getSnapshot().body).toBe(body);
    expect(f.parent.querySelectorAll(".inline-review-mark")).toHaveLength(0);
  });

  test("React Strict Mode cleanup destroys stale handles, keeps one view and stable rerenders", () => {
    const f = fixture(); f.editor.destroy(); f.parent.remove();
    const visits: Array<Editor | null> = [];
    const ready = (editor: Editor | null) => { visits.push(editor); };
    const element = () => createElement(StrictMode, null, createElement(Surface.InlineTextSurface, { options: f.options, onReady: ready }));
    const rendered = testing.render(element());
    const current = visits.at(-1);
    if (!current) throw new Error("Missing mounted handle");
    expect(document.querySelectorAll(".cm-editor")).toHaveLength(1);
    rendered.rerender(element());
    expect(visits.at(-1)).toBe(current);
    rendered.unmount();
    expect(current.getSnapshot().destroyed).toBe(true);
    expect(document.querySelectorAll(".cm-editor")).toHaveLength(0);
  });

  test("named controls have equivalent commands and return callback without inline focus stops", async () => {
    const f = fixture(); await f.editor.showEvidence({});
    const controls = testing.render(createElement(Surface.InlineReviewControls, { editor: f.editor }));
    for (const label of ["Next evidence", "Previous evidence", "Inspect evidence", "Return to finding"]) {
      testing.fireEvent.click(controls.getByRole("button", { name: label }));
    }
    expect(f.inspections.map((item) => item.action)).toEqual(["next", "previous", "inspect", "return"]);
    expect(f.parent.querySelectorAll(".inline-review-mark[tabindex]")).toHaveLength(0);
    expect(f.changes).toHaveLength(0);
  });
});
