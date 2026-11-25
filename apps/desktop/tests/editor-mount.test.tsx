/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import { normalizeBody } from "@ai-book-studio/core/markdown";
import type { Chapter, ChapterConflict } from "@ai-book-studio/core/schema";
import type { EditorHandle, SaveStatus } from "@ai-book-studio/app/components/ManuscriptEditor";
import type { InlineEditor } from "../../../packages/app/src/components/inline-editor/editor";
import type { InlineSource } from "../../../packages/app/src/components/inline-editor/contracts";

let testing!: typeof import("@testing-library/react/pure");
let ManuscriptEditor!: typeof import("@ai-book-studio/app/components/ManuscriptEditor").ManuscriptEditor;

beforeAll(async () => {
  testing = await mountDom();
  ({ ManuscriptEditor } = await import("@ai-book-studio/app/components/ManuscriptEditor"));
});
afterAll(async () => {
  await unmountDom();
});
afterEach(() => testing.cleanup());

const BOOK = "book_mount001";
const CHAPTER_ID = "ch_mount001";
const STAMP = "2026-11-07T12:00:00Z";
const LATER = "2026-11-07T12:01:00Z";
const PASSAGE = "The gulls came back at noon.";
const SECOND = "Mara waited by the door.";
const BODY = `The lamp was out.\n${SECOND}\n${PASSAGE}\n`;

let CHAPTER: Chapter;
let RAW: string;
let HASH: string;

beforeAll(async () => {
  const { normalizeBody, serializeChapter } = await import("@ai-book-studio/core/markdown");
  const body = normalizeBody(BODY);
  RAW = serializeChapter(
    {
      id: CHAPTER_ID,
      title: "One",
      order: 1,
      arc: "middle",
      purpose: "",
      synopsis: "",
      notes: "",
      isPrologue: false,
      color: null,
      version: 3,
      createdAt: "2026-10-25T12:00:00.000Z",
      updatedAt: "2026-10-25T12:00:00.000Z"
    },
    body
  );
  HASH = await sha256(new TextEncoder().encode(RAW));
  CHAPTER = {
    id: CHAPTER_ID,
    title: "One",
    order: 1,
    arc: "middle",
    purpose: "",
    synopsis: "",
    notes: "",
    isPrologue: false,
    color: null,
    version: 3,
    createdAt: "2026-10-25T12:00:00.000Z",
    updatedAt: "2026-10-25T12:00:00.000Z",
    content: body,
    path: "0001-one.md",
    wordCount: 9,
    hash: HASH
  };
});

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function studioWithSave(
  reply: ((input: { content: string }) => unknown) | undefined = (input) => ({
    ok: true,
    data: {
      status: "saved",
      chapter: { ...CHAPTER, content: input.content, version: CHAPTER.version + 1, hash: "b".repeat(64) }
    }
  })
) {
  const save = mock(async (input: { bookId: string; chapterId: string; content: string; baseVersion: number; baseHash: string }) =>
    reply(input)
  );
  const updateMeta = mock(async () => ({ ok: true, data: { status: "saved", chapter: CHAPTER } }));
  const setDraft = mock(async () => ({ ok: true, data: null }));
  const clear = mock(async () => ({ ok: true, data: null }));
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    chapters: { save, updateMeta },
    drafts: { set: setDraft, clear, onFlushRequest: () => () => {} }
  };
  return { save, updateMeta, setDraft, clear };
}

function canonicalSave({ content }: { content: string }) {
  return {
    ok: true,
    data: {
      status: "saved",
      chapter: { ...CHAPTER, content: normalizeBody(content), version: CHAPTER.version + 1, hash: "b".repeat(64) }
    }
  };
}

interface Mounted {
  ref: React.RefObject<EditorHandle | null>;
  surface(): HTMLElement;
  editor(): InlineEditor;
  save: ReturnType<typeof studioWithSave>["save"];
  setDraft: ReturnType<typeof studioWithSave>["setDraft"];
  rerender: (extra: Record<string, unknown>) => void;
  statuses: SaveStatus[];
}

function mount(
  extra: Record<string, unknown> = {},
  reply?: (input: { content: string }) => unknown
): Mounted {
  const studio = studioWithSave(reply);
  let editor: InlineEditor | null = null;
  const ref = React.createRef<EditorHandle>();
  const statuses: SaveStatus[] = [];
  const element = (props: Record<string, unknown>) =>
    React.createElement(ManuscriptEditor, {
      ref,
      bookId: BOOK,
      chapter: CHAPTER,
      ordinal: 1,
      onSaved: () => {},
      onStatus: (status: SaveStatus) => statuses.push(status),
      onEditorReady: (next: InlineEditor | null) => {
        editor = next;
      },
      ...props
    });
  const rendered = testing.render(element(extra));
  const surface = () => testing.within(document.body).getByTestId("manuscript-text");
  return {
    ref,
    surface,
    editor: () => {
      if (!editor) throw new Error("the mounted editor never became ready");
      return editor;
    },
    save: studio.save,
    setDraft: studio.setDraft,
    rerender: (next: Record<string, unknown>) => rendered.rerender(element(next)),
    statuses
  };
}

function mountedHandle(mounted: Mounted): EditorHandle {
  const handle = mounted.ref.current;
  if (!handle) throw new Error("the editor handle is not available");
  return handle;
}

function editorText(): string {
  return (testing.within(document.body).getByTestId("manuscript-text") as HTMLElement & { value: string }).value;
}

function type(text: string): void {
  testing.fireEvent.change(testing.within(document.body).getByTestId("manuscript-text"), { target: { value: text } });
}

/** A synthetic, isolated review request; the real shared verifier checks it, no provider runs. */
async function reviewRequest(snapshot: InlineSource) {
  const { captureChapterSource } = await import("@ai-book-studio/core/review/sources");
  const { buildReviewEnvelope, reviewToolNameSchema } = await import("@ai-book-studio/core/review/envelope");
  const { builtinReaderProfile } = await import("@ai-book-studio/core/review/profiles");
  const saved = { bookId: BOOK, chapterId: CHAPTER_ID, version: CHAPTER.version, hash: HASH, body: CHAPTER.content };
  const source = captureChapterSource({
    sourceId: "source-1",
    saved,
    bookTitle: "Synthetic book",
    title: CHAPTER.title,
    position: 1,
    capturedAt: STAMP,
    ranges: [{ start: 0, end: CHAPTER.content.length }]
  });
  const profile = await builtinReaderProfile("alpha");
  const envelope = await buildReviewEnvelope({
    contractVersion: 1,
    kind: "reader-review",
    requestId: "request-1",
    capturedAt: STAMP,
    destination: {
      connectionId: "connection-1",
      provider: "Synthetic provider",
      model: "synthetic/model",
      endpointIdentity: "endpoint-revision-1"
    },
    environment: {
      hostId: "synthetic-host",
      hostSupported: true,
      connectionAvailable: true,
      modelSupported: true,
      capabilityRevision: "capability-1",
      estimatedCostUsd: null,
      priceAsOf: null,
      catalogContextTokens: null,
      catalogAsOf: null,
      contextFit: "unknown"
    },
    books: [
      {
        bookId: BOOK,
        title: "Synthetic book",
        consentSatisfied: true,
        consentRevision: "consent-1",
        termsRevision: "terms-1",
        enabledTools: [...reviewToolNameSchema.options]
      }
    ],
    prompt: "Review the selected passage.",
    profile,
    priorFeedback: [],
    sources: [source]
  });
  const identity = { bookId: BOOK, chapterId: CHAPTER_ID, version: CHAPTER.version, hash: HASH };
  const citation = (start: number, end: number, quote: string) => ({
    kind: "chapter" as const,
    sourceId: "source-1",
    identity,
    start,
    end,
    quote
  });
  const gulls = CHAPTER.content.indexOf(PASSAGE);
  const mara = CHAPTER.content.indexOf(SECOND);
  const finding = (findingId: string, category: string, start: number, quote: string) => ({
    findingId,
    category,
    readerId: "reader-alpha",
    readerVersion: 1,
    runId: "request-1",
    interpretation: "A synthetic subjective observation.",
    claim: "observation",
    evidence: [citation(start, start + quote.length, quote)]
  });
  const output = JSON.stringify({
    runId: "request-1",
    readerId: "reader-alpha",
    readerVersion: 1,
    findings: [
      finding("finding-1", "clarity", gulls, PASSAGE),
      finding("finding-2", "character-motivation", mara, SECOND)
    ]
  });
  return {
    envelope,
    raw: { text: RAW, bytes: new TextEncoder().encode(RAW) },
    scope: [{ start: 0, end: CHAPTER.content.length }],
    expected: {
      libraryId: snapshot.libraryId,
      bookId: snapshot.bookId,
      chapterId: snapshot.chapterId,
      viewGeneration: snapshot.viewGeneration,
      sourceEpoch: snapshot.sourceEpoch,
      version: snapshot.version,
      rawHash: snapshot.rawHash,
      savedBody: snapshot.savedBody,
      clean: true,
      pending: false,
      available: true
    },
    output,
    startedAt: STAMP,
    completedAt: LATER
  };
}

describe("mounted editor surface", () => {
  test("replaces the textarea with one plain-text editor and keeps the smoke hooks", () => {
    mount();
    const body = testing.within(document.body);
    expect(body.getByTestId("manuscript-editor")).toBeTruthy();
    const surface = body.getByTestId("manuscript-text");
    expect(surface.tagName).toBe("DIV");
    expect(surface.getAttribute("contenteditable")).toBe("true");
    expect(surface.getAttribute("aria-label")).toBe("Chapter text");
    expect(document.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(document.querySelector("textarea")).toBeNull();
    expect(editorText()).toBe(CHAPTER.content);
    expect(body.getByTestId("manuscript-editor").textContent).toContain("3 lines");
  });

  test("typing takes the existing debounce, draft and save path, and plain Enter adds one line break", async () => {
    const mounted = mount();
    const surface = mounted.surface();
    type(`${CHAPTER.content}Mara counted the gulls.\n`);
    expect(editorText()).toContain("Mara counted the gulls.");
    expect(mounted.statuses.at(-1)?.kind).toBe("dirty");
    expect(mounted.save).not.toHaveBeenCalled();

    await testing.waitFor(() => expect(mounted.setDraft).toHaveBeenCalledTimes(1), { timeout: 1000 });
    await testing.waitFor(() => expect(mounted.save).toHaveBeenCalledTimes(1), { timeout: 2500 });
    expect(mounted.save).toHaveBeenCalledWith({
      bookId: BOOK,
      chapterId: CHAPTER_ID,
      content: `${CHAPTER.content}Mara counted the gulls.\n`,
      baseVersion: CHAPTER.version,
      baseHash: HASH
    });

    const atEnd = editorText().length;
    (surface as HTMLElement & { selectionStart: number; selectionEnd: number }).selectionStart = atEnd;
    (surface as HTMLElement & { selectionStart: number; selectionEnd: number }).selectionEnd = atEnd;
    testing.fireEvent.keyDown(surface, { key: "Enter" });
    await testing.act(async () => {});
    expect(editorText()).toContain("Mara counted the gulls.\n\n");
  });

  test("paste normalizes and dictation inserts at the caret through the same change owner", async () => {
    const mounted = mount();
    const surface = mounted.surface();
    (surface as HTMLElement & { selectionStart: number; selectionEnd: number }).selectionStart = CHAPTER.content.length;
    (surface as HTMLElement & { selectionStart: number; selectionEnd: number }).selectionEnd = CHAPTER.content.length;
    testing.fireEvent.paste(surface, {
      clipboardData: { getData: () => "“Quoted.”\r\nline  \r\n\r\n\r\nend" }
    });
    expect(editorText()).toBe(`${CHAPTER.content}"Quoted."\nline  \n\nend`);

    const editor = mounted.editor();
    const inserted = editor.getSnapshot().body.length;
    expect(editor.insertDictation("spoken words", editor.getSnapshot().revision)).toBe(true);
    expect(editor.getSnapshot().body).toBe(`${CHAPTER.content}"Quoted."\nline  \n\nend spoken words`);
    expect(editor.getSnapshot().body.length).toBeGreaterThan(inserted);
    expect(editor.getSnapshot().selection).toEqual({
      anchor: editor.getSnapshot().body.length,
      head: editor.getSnapshot().body.length
    });
  });

  test("undo, redo and save commands delegate to the wrapper's one owner", async () => {
    const mounted = mount();
    const surface = mounted.surface();
    type(`${CHAPTER.content}Mara counted the gulls.\n`);
    expect(editorText()).toContain("Mara counted the gulls.");

    testing.fireEvent.keyDown(surface, { key: "z", metaKey: true });
    expect(editorText()).toBe(CHAPTER.content);
    testing.fireEvent.keyDown(surface, { key: "z", metaKey: true, shiftKey: true });
    expect(editorText()).toContain("Mara counted the gulls.");

    testing.fireEvent.keyDown(surface, { key: "s", metaKey: true });
    await testing.act(async () => {});
    expect(mounted.save).toHaveBeenCalledTimes(1);
  });

  test("composition and hold refuse programmatic replacement while typed words still land", async () => {
    const mounted = mount();
    const surface = mounted.surface();
    const editor = mounted.editor();

    testing.fireEvent.compositionStart(surface);
    expect(editor.getSnapshot().composing).toBe(true);
    expect(editor.replaceText("must not replace", editor.getSnapshot().revision)).toBe(false);
    expect(editorText()).toBe(CHAPTER.content);
    testing.fireEvent.compositionEnd(surface, { data: "" });
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(editor.getSnapshot().composing).toBe(false);

    await mountedHandle(mounted).hold(async () => {
      expect(editor.getSnapshot().held).toBe(true);
      expect(editor.replaceText("controlled during hold", editor.getSnapshot().revision)).toBe(false);
      // Typing is not a controlled replacement: the author's words still land during a move.
      type(`${CHAPTER.content}She stopped at the gate.\n`);
      expect(editorText()).toContain("She stopped at the gate.");
    });
    expect(editor.getSnapshot().held).toBe(false);
  });

  test("a canonical save supports exact evidence without adding an undo step", async () => {
    const mounted = mount({}, canonicalSave);
    const typed = `${CHAPTER.content}Mara wrote on.`;
    const editor = mounted.editor();
    type(typed);
    const start = typed.indexOf(PASSAGE);
    expect(editor.setSelection({ anchor: start, head: start + PASSAGE.length })).toBe(true);

    await testing.act(async () => { await mountedHandle(mounted).flush(); });

    const saved = normalizeBody(typed);
    const visit = mountedHandle(mounted).getEvidenceSnapshot();
    expect(visit?.body).toBe(saved);
    expect(editor.getSnapshot().selectedText).toBe(PASSAGE);
    expect(editor.getSnapshot().selection.anchor).toBe(saved.indexOf(PASSAGE));
    await testing.act(async () => { await mountedHandle(mounted).flush(); });
    expect(mounted.save).toHaveBeenCalledTimes(1);

    testing.fireEvent.keyDown(mounted.surface(), { key: "z", ctrlKey: true });
    expect(editor.getSnapshot().body).toBe(CHAPTER.content);
  });

  test("a canonical save leaves typing that arrived during the request dirty", async () => {
    const reply = Promise.withResolvers<unknown>();
    const mounted = mount({}, () => reply.promise);
    const submitted = `${CHAPTER.content}Mara wrote on.`;
    type(submitted);
    let saved: Promise<SaveStatus> | undefined;
    await testing.act(async () => {
      saved = mountedHandle(mounted).flush();
      await Promise.resolve();
    });
    expect(mounted.save).toHaveBeenCalledTimes(1);

    const later = `${submitted}\nThen the lamp came back on.`;
    type(later);
    await testing.act(async () => {
      reply.resolve(canonicalSave({ content: submitted }));
      await saved;
    });

    expect(mounted.editor().getSnapshot().body).toBe(later);
    expect(mountedHandle(mounted).getStatus().kind).toBe("dirty");
    expect(mountedHandle(mounted).getEvidenceSnapshot()).toBeNull();
  });

  test("a queued no-op keeps the newest text dirty and preserves its backup", async () => {
    const reply = Promise.withResolvers<unknown>();
    const mounted = mount({}, () => reply.promise);
    const handle = mountedHandle(mounted);
    const submitted = `${CHAPTER.content}Mara wrote on.`;
    type(submitted);
    const first = handle.flush();
    await testing.waitFor(() => expect(mounted.save).toHaveBeenCalledTimes(1));
    const saved = normalizeBody(submitted);
    type(saved);
    const queued = handle.flush();
    const newer = `${saved}Then the lamp came back on.`;
    type(newer);

    await testing.act(async () => {
      reply.resolve(canonicalSave({ content: submitted }));
      await Promise.all([first, queued]);
    });

    expect(handle.getStatus().kind).toBe("dirty");
    expect(editorText()).toBe(newer);
    expect(mounted.save).toHaveBeenCalledTimes(1);
    await testing.waitFor(() =>
      expect(mounted.setDraft).toHaveBeenCalledWith(expect.objectContaining({ content: newer, baseVersion: CHAPTER.version + 1 }))
    );
  });

  test.each(["hold", "composition"] as const)("an acknowledged newline settles after a %s", async (blocked) => {
    const reply = Promise.withResolvers<unknown>();
    const release = Promise.withResolvers<void>();
    const mounted = mount({}, () => reply.promise);
    const handle = mountedHandle(mounted);
    const submitted = `${CHAPTER.content}Mara wrote on.`;
    type(submitted);
    const saving = handle.flush();
    await testing.waitFor(() => expect(mounted.save).toHaveBeenCalledTimes(1));
    const holding = blocked === "hold" ? handle.hold(() => release.promise) : null;
    if (blocked === "composition") testing.fireEvent.compositionStart(mounted.surface());

    await testing.act(async () => {
      reply.resolve(canonicalSave({ content: submitted }));
      await saving;
    });
    expect(editorText()).toBe(submitted);
    expect(handle.getEvidenceSnapshot()).toBeNull();

    if (holding) {
      await testing.act(async () => {
        release.resolve();
        await holding;
      });
    } else {
      testing.fireEvent.compositionEnd(mounted.surface(), { data: "" });
    }

    await testing.waitFor(() => expect(handle.getEvidenceSnapshot()?.body).toBe(normalizeBody(submitted)));
    expect(mounted.save).toHaveBeenCalledTimes(1);
  });

  test("editing and returning to the submitted text cancels a held newline settlement", async () => {
    const reply = Promise.withResolvers<unknown>();
    const release = Promise.withResolvers<void>();
    const mounted = mount({}, () => reply.promise);
    const handle = mountedHandle(mounted);
    const submitted = `${CHAPTER.content}Mara wrote on.`;
    type(submitted);
    const saving = handle.flush();
    await testing.waitFor(() => expect(mounted.save).toHaveBeenCalledTimes(1));
    const holding = handle.hold(() => release.promise);
    await testing.act(async () => {
      reply.resolve(canonicalSave({ content: submitted }));
      await saving;
    });

    type(`${submitted} More words.`);
    type(submitted);
    await testing.act(async () => {
      release.resolve();
      await holding;
    });

    expect(editorText()).toBe(submitted);
    expect(handle.getStatus().kind).toBe("dirty");
    expect(handle.getEvidenceSnapshot()).toBeNull();
  });

  test("idle autosave preserves a paragraph break for the next words", async () => {
    const mounted = mount({}, canonicalSave);
    const handle = mountedHandle(mounted);
    const editor = mounted.editor();
    const afterEnter = `${CHAPTER.content}\n`;
    type(afterEnter);
    expect(editor.setSelection({ anchor: afterEnter.length, head: afterEnter.length })).toBe(true);
    await testing.waitFor(() => {
      expect(mounted.save).toHaveBeenCalledTimes(1);
      expect(handle.getStatus().kind).toBe("saved");
    }, { timeout: 1500 });

    const { body, selection } = editor.getSnapshot();
    expect(body).toBe(afterEnter);
    expect(selection.anchor).toBe(afterEnter.length);
    type(`${body.slice(0, selection.anchor)}A new paragraph.${body.slice(selection.head)}`);
    await testing.act(async () => { await handle.flush(); });
    expect(handle.getEvidenceSnapshot()?.body).toBe(`${afterEnter}A new paragraph.\n`);
  });

  test("a host evidence selection moves the mounted selection on each new request", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    const start = CHAPTER.content.indexOf(SECOND);
    const end = start + SECOND.length;
    const selection = () => ({ start, end, source: editor.getSnapshot(), visit: mountedHandle(mounted).getEvidenceSnapshot(),
      isCurrent: () => true, onResult: () => {} });
    mounted.rerender({ selection: selection() });
    await testing.act(async () => {});
    expect(editor.getSnapshot().selection).toEqual({ anchor: start, head: end });
    expect(editor.getSnapshot().selectedText).toBe(SECOND);

    // A new request for the same offsets still refocuses the selection.
    mounted.surface().blur();
    expect(editor.setSelection({ anchor: 0, head: 0 })).toBe(true);
    mounted.rerender({ selection: selection() });
    await testing.act(async () => {});
    expect(editor.getSnapshot().selection).toEqual({ anchor: start, head: end });
  });

  test.each(["libraryId", "bookId", "chapterId", "version", "rawHash", "savedBody"] as const)(
    "evidence selection refuses a mismatched %s without changing the text", (field) => {
      const mounted = mount();
      const editor = mounted.editor();
      const visit = mountedHandle(mounted).getEvidenceSnapshot();
      if (!visit) throw new Error("Expected a clean mounted visit");
      const source = { ...visit, [field]: field === "version" ? visit.version + 1 : "other" };
      const onResult = mock((_applied: boolean) => {});
      mounted.rerender({ selection: { start: 0, end: 3, source, visit, isCurrent: () => true, onResult } });
      expect(onResult).toHaveBeenCalledWith(false);
      expect(editor.getSnapshot().body).toBe(CHAPTER.content);
      expect(editor.getSnapshot().selection).toEqual({ anchor: 0, head: 0 });
    }
  );

  test("a dirty buffer and an edit-undo-save ABA both invalidate an earlier selection", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    const visit = mountedHandle(mounted).getEvidenceSnapshot();
    if (!visit) throw new Error("Expected a clean mounted visit");
    const onResult = mock((_applied: boolean) => {});
    const selection = () => ({ start: 0, end: 3, source: visit, visit, isCurrent: () => true, onResult });
    type(`${CHAPTER.content}unsaved words`);
    mounted.rerender({ selection: selection() });
    expect(onResult).toHaveBeenLastCalledWith(false);
    expect(editorText()).toContain("unsaved words");
    type(CHAPTER.content);
    await testing.act(async () => { await mountedHandle(mounted).flush(); });
    expect(mountedHandle(mounted).getStatus().kind).toBe("saved");
    expect(mountedHandle(mounted).getEvidenceSnapshot()).not.toBeNull();
    mounted.rerender({ selection: selection() });
    expect(onResult).toHaveBeenLastCalledWith(false);
    expect(editor.getSnapshot().body).toBe(CHAPTER.content);
    expect(editor.getSnapshot().selection).toEqual({ anchor: 0, head: 0 });
  });

  test("composition and hold, including completed ABA transitions, invalidate a captured visit", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    const first = mountedHandle(mounted).getEvidenceSnapshot();
    if (!first) throw new Error("Expected a clean mounted visit");
    const onResult = mock((_applied: boolean) => {});
    const request = (visit: typeof first) => ({ start: 0, end: 3, source: visit, visit, isCurrent: () => true, onResult });
    testing.fireEvent.compositionStart(mounted.surface());
    mounted.rerender({ selection: request(first) });
    expect(onResult).toHaveBeenLastCalledWith(false);
    testing.fireEvent.compositionEnd(mounted.surface(), { data: "" });
    await testing.act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    mounted.rerender({ selection: request(first) });
    expect(onResult).toHaveBeenLastCalledWith(false);
    const second = mountedHandle(mounted).getEvidenceSnapshot();
    if (!second) throw new Error("Expected a clean visit after composition");
    let release!: () => void;
    const held = mountedHandle(mounted).hold(() => new Promise<void>((resolve) => { release = resolve; }));
    mounted.rerender({ selection: request(second) });
    expect(onResult).toHaveBeenLastCalledWith(false);
    await testing.act(async () => { await Promise.resolve(); release(); await held; });
    mounted.rerender({ selection: request(second) });
    expect(onResult).toHaveBeenLastCalledWith(false);
    expect(editor.getSnapshot().body).toBe(CHAPTER.content);
  });

  test("saving and failed saves refuse evidence without replacing the live buffer", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    const mounted = mount({}, () => pending);
    const visit = mountedHandle(mounted).getEvidenceSnapshot();
    if (!visit) throw new Error("Expected a clean mounted visit");
    const onResult = mock((_applied: boolean) => {});
    const selection = () => ({ start: 0, end: 3, source: visit, visit, isCurrent: () => true, onResult });
    type(`${CHAPTER.content}unsaved words`);
    let save!: Promise<SaveStatus>;
    await testing.act(async () => { save = mountedHandle(mounted).flush(); await Promise.resolve(); });
    expect(mountedHandle(mounted).getStatus().kind).toBe("saving");
    mounted.rerender({ selection: selection() });
    expect(onResult).toHaveBeenLastCalledWith(false);
    await testing.act(async () => { release({ ok: false, error: { message: "synthetic failure" } }); await save; });
    expect(mountedHandle(mounted).getStatus().kind).toBe("error");
    mounted.rerender({ selection: selection() });
    expect(onResult).toHaveBeenLastCalledWith(false);
    expect(editorText()).toContain("unsaved words");
  });

  test("a captured visit cannot select in a later mount of the same chapter", () => {
    const first = mount();
    const visit = mountedHandle(first).getEvidenceSnapshot();
    if (!visit) throw new Error("Expected a clean mounted visit");
    testing.cleanup();
    const second = mount();
    const onResult = mock((_applied: boolean) => {});
    second.rerender({ selection: { start: 0, end: 3, source: visit, visit, isCurrent: () => true, onResult } });
    expect(onResult).toHaveBeenCalledWith(false);
    expect(second.editor().getSnapshot().body).toBe(CHAPTER.content);
  });

  test("a conflict keeps the author's words, reports it, and a second flush writes no new copy", async () => {
    const conflict: ChapterConflict = {
      bookId: BOOK,
      chapterId: CHAPTER_ID,
      chapterTitle: "One",
      savedAs: "books/book_mount001/conflicts/0001-one.conflict-external-edit.md",
      reason: "external-edit",
      diskVersion: 4,
      localVersion: 4
    };
    const mounted = mount({}, () => ({ ok: true, data: { status: "conflict", conflict } }));
    const studio = { save: mounted.save };
    type(`${CHAPTER.content}Mara wrote on.\n`);

    let flushed: SaveStatus | undefined;
    await testing.act(async () => {
      flushed = await mountedHandle(mounted).flush();
    });
    expect(flushed).toEqual({ kind: "conflict", conflict });
    expect(editorText()).toContain("Mara wrote on.");
    expect(mounted.statuses.at(-1)).toEqual({ kind: "conflict", conflict });

    await testing.act(async () => {
      await mountedHandle(mounted).flush();
    });
    expect(studio.save).toHaveBeenCalledTimes(1);
  });

  test("a synthetic shared-verifier layer paints underlines and lists findings accessibly", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    const request = await reviewRequest(editor.getSnapshot());
    mounted.rerender({ reviewRequest: request, reviewLabel: "Synthetic review" });

    await testing.waitFor(() => expect(document.querySelectorAll(".inline-review-mark").length).toBe(2));
    const body = testing.within(document.body);
    const aside = body.getByRole("complementary", { name: "Review findings" });
    expect(aside.textContent).toContain("Synthetic review");
    expect(body.getByTestId("review-count").textContent).toBe("2 of 2 findings shown");
    for (const name of ["Previous evidence", "Next evidence", "Inspect evidence", "Return to finding"]) {
      expect(testing.within(aside).getByRole("button", { name })).toBeTruthy();
    }
    expect(mounted.save).not.toHaveBeenCalled();

    const dbg = editor.getSnapshot();
    expect(dbg.body).toBe(dbg.savedBody);
    expect(editor.getLayer()).not.toBeNull();
    testing.fireEvent.click(testing.within(aside).getByRole("button", { name: "Previous evidence" }));
    expect(editor.getSnapshot().selectedText).toBe(PASSAGE);
    testing.fireEvent.click(testing.within(aside).getByRole("button", { name: "Inspect evidence" }));
    expect(document.activeElement).toBe(mounted.surface());

    testing.fireEvent.click(testing.within(aside).getByRole("button", { name: "Return to finding" }));
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const activeRow = aside.querySelector('button[aria-current="true"]');
    expect(activeRow).not.toBeNull();
    expect(document.activeElement).toBe(activeRow);

    testing.fireEvent.change(testing.within(aside).getByRole("combobox", { name: "Filter findings by category" }), {
      target: { value: "clarity" }
    });
    await testing.act(async () => {});
    expect(body.getByTestId("review-count").textContent).toBe("1 of 2 findings shown");
    expect(document.querySelectorAll(".inline-review-mark")).toHaveLength(1);
  });

  test("an edit hides the current marks instead of mapping them onto new text", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    const request = await reviewRequest(editor.getSnapshot());
    mounted.rerender({ reviewRequest: request });
    await testing.waitFor(() => expect(document.querySelectorAll(".inline-review-mark").length).toBe(2));

    type(`${CHAPTER.content}new words`);
    expect(document.querySelectorAll(".inline-review-mark")).toHaveLength(0);
    expect(testing.within(document.body).queryByRole("complementary", { name: "Review findings" })).toBeNull();
  });

  test("an invented layer is refused by the shared verifier and paints nothing", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    const request = await reviewRequest(editor.getSnapshot());
    mounted.rerender({ reviewRequest: { ...request, raw: { text: `${RAW}\n` } } });
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelectorAll(".inline-review-mark")).toHaveLength(0);
    expect(testing.within(document.body).queryByRole("complementary", { name: "Review findings" })).toBeNull();
  });
});

describe("review aside corrections", () => {
  test("filtering out the active finding and returning clears aria-current", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    const request = await reviewRequest(editor.getSnapshot());
    mounted.rerender({ reviewRequest: request });
    await testing.waitFor(() => expect(document.querySelectorAll(".inline-review-mark").length).toBe(2));
    const body = testing.within(document.body);
    const aside = body.getByRole("complementary", { name: "Review findings" });

    testing.fireEvent.click(testing.within(aside).getByRole("button", { name: "Inspect evidence" }));
    testing.fireEvent.click(testing.within(aside).getByRole("button", { name: "Return to finding" }));
    await testing.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(aside.querySelector('button[aria-current="true"]')).not.toBeNull();

    // Hide the active finding, then show everything again.
    const filter = testing.within(aside).getByRole("combobox", { name: "Filter findings by category" });
    testing.fireEvent.change(filter, { target: { value: "character-motivation" } });
    await testing.act(async () => {});
    testing.fireEvent.change(filter, { target: { value: "all" } });
    await testing.act(async () => {});
    expect(document.querySelectorAll(".inline-review-mark")).toHaveLength(2);
    expect(aside.querySelector('button[aria-current="true"]')).toBeNull();
  });

  test("the count names findings, not evidence spans, when a finding cites two passages", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    const request = await reviewRequest(editor.getSnapshot());
    const parsed = JSON.parse(request.output) as { findings: Array<{ evidence: unknown[] }> };
    const secondEvidence = parsed.findings[1]?.evidence[0];
    if (!secondEvidence) throw new Error("missing fixture evidence");
    parsed.findings[0]?.evidence.push(secondEvidence);

    mounted.rerender({ reviewRequest: { ...request, output: JSON.stringify(parsed) } });
    await testing.waitFor(() => expect(document.querySelectorAll(".inline-review-mark").length).toBe(2));
    const body = testing.within(document.body);
    const aside = body.getByRole("complementary", { name: "Review findings" });

    expect(body.getByTestId("review-count").textContent).toBe("2 of 2 findings shown");
    expect(aside.textContent).toContain("2 passages");
    expect(aside.querySelectorAll("li").length).toBe(2);
  });
});

describe("editor review corrections P2", () => {
  test("undo restores text after a one-character emoji edit leaves the caret at offset 1", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    type("a");
    await testing.act(async () => {});
    expect(editorText()).toBe("a");
    expect(editor.setSelection({ anchor: 1, head: 1 })).toBe(true);

    testing.fireEvent.keyDown(mounted.surface(), { key: "z", metaKey: true });
    await testing.act(async () => {});
    // The caret offset would split an emoji in the restored text; the undo must still land.
    expect(editorText()).toBe(CHAPTER.content);
  });

  test("clicking a row selects that finding by identity when two share a passage", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    const request = await reviewRequest(editor.getSnapshot());
    const parsed = JSON.parse(request.output) as { findings: Array<{ evidence: unknown[] }> };
    const shared = parsed.findings[0]?.evidence[0];
    if (!shared) throw new Error("missing fixture evidence");
    parsed.findings[1]?.evidence.splice(0, 1, shared);

    mounted.rerender({ reviewRequest: { ...request, output: JSON.stringify(parsed) } });
    await testing.waitFor(() => expect(document.querySelectorAll(".inline-review-mark").length).toBe(1));
    const body = testing.within(document.body);
    expect(body.getAllByRole("button", { name: /^Show .* finding \d in the text$/ })).toHaveLength(2);
    const motivation = () => body.getByRole("button", { name: /Show character-motivation finding/ });
    const clarity = () => body.getByRole("button", { name: /Show clarity finding/ });

    testing.fireEvent.click(motivation());
    await testing.waitFor(() => expect(motivation().getAttribute("aria-current")).toBe("true"));
    expect(clarity().getAttribute("aria-current")).toBeNull();
  });
});

describe("review request withdrawal", () => {
  test("removing the host request clears marks, list and status", async () => {
    const mounted = mount();
    const editor = mounted.editor();
    const request = await reviewRequest(editor.getSnapshot());
    mounted.rerender({ reviewRequest: request });
    await testing.waitFor(() => expect(document.querySelectorAll(".inline-review-mark").length).toBe(2));
    const body = testing.within(document.body);
    expect(body.queryByRole("complementary", { name: "Review findings" })).not.toBeNull();

    mounted.rerender({ reviewRequest: null });
    await testing.act(async () => {});
    expect(document.querySelectorAll(".inline-review-mark")).toHaveLength(0);
    expect(body.queryByRole("complementary", { name: "Review findings" })).toBeNull();
    expect(editor.getLayer()).toBeNull();
  });
});
