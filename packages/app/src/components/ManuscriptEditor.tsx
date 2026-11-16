import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Chapter, ChapterConflict } from "@ai-book-studio/core/schema";
import type { ImageRecord } from "@ai-book-studio/core/images/schema";
import { plainSaveReason } from "@ai-book-studio/core/library/errors";
import { createSharedEvidencePort } from "@ai-book-studio/core/review/shared-verifier";
import { type InlineSpan, inlineSpanKey } from "@ai-book-studio/core/review/inline/overlap";
import { Button } from "@ai-book-studio/ui/button";
import { pushHistory, redoHistory, undoHistory } from "../lib/editor-history";
import { countWords, formatCount, formatWords, pluralize, savedTime } from "../lib/utils";
import { VoiceButton } from "./VoiceButton";
import { InlineReviewControls, InlineTextSurface } from "./inline-editor/InlineTextSurface";
import type { InlineEditor } from "./inline-editor/editor";
import { isExactCurrent } from "./inline-editor/contracts";
import type {
  InlineChange,
  InlineEditorOptions,
  InlineInspection,
  InlineSnapshot,
  InlineSource,
  TextSelection,
  ValidatedEvidencePort,
  ValidatedInlineLayer
} from "./inline-editor/contracts";

export type SaveStatus =
  /** `afterRetry` marks the save that ended a run of failed ones, so the status can say so. */
  | { kind: "saved"; at: number; afterRetry?: true }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "conflict"; conflict: ChapterConflict }
  | { kind: "error"; message: string };

/**
 * When a failed save tries again by itself: after 2 s, 5 s and 10 s, then every 30 s while the text
 * is unsaved. Typing still saves on its own; a conflict never retries, because the author resolves it.
 */
export const SAVE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000];

export interface EditorHandle {
  /** Flush pending chapter text and report whether the saved source is confirmed. */
  flush: () => Promise<SaveStatus>;
  /** The live buffer status, without waiting for the mirrored React state to land. */
  getStatus: () => SaveStatus;
  /** The hash of the chapter file this editor last loaded or saved. */
  getBaseHash: () => string;
  /** A live, clean visit token for a later exact evidence-selection check. */
  getEvidenceSnapshot: () => InlineSnapshot | null;
  /** Refuse even an ABA edit, composition or hold since the captured visit. */
  isEvidenceCurrent: (snapshot: InlineSnapshot) => boolean;
  /**
   * Run `write`, such as a move, with this editor's saves held until it ends: saves already on their
   * way finish first, and one asked for meanwhile is checked against the base `write` leaves.
   */
  hold: <T>(write: () => Promise<T>) => Promise<T>;
  /**
   * Take this chapter's file in `chapters` as the base when only its front matter moved on, as a move
   * leaves it: the words and title are the ones this editor last loaded or saved. Unsaved words stay
   * in the editor and save against it. False when the file's words or title changed, or it is gone.
   */
  rebase: (chapters: readonly Chapter[]) => boolean;
}

export interface EditorSelection {
  start: number;
  end: number;
  source: Pick<InlineSource, "libraryId" | "bookId" | "chapterId" | "version" | "rawHash" | "savedBody">;
  /** Captured before the read when selecting in an already mounted editor. */
  visit?: InlineSnapshot;
  /** The owning report/navigation must still be current at the actual application boundary. */
  isCurrent: () => boolean;
  onResult: (applied: boolean) => void;
}

interface Props {
  bookId: string;
  chapter: Chapter;
  ordinal: number;
  onSaved: (chapter: Chapter) => void;
  onStatus: (status: SaveStatus) => void;
  /** The chapter illustration, served from the book folder. */
  illustration?: ImageRecord | null;
  illustrationData?: string | null;
  /** An evidence span to highlight, for example from a manuscript review finding. */
  selection?: EditorSelection | null;
  /** The retry schedule after a failed save. Tests shorten it; the studio uses the default. */
  retryDelaysMs?: readonly number[];
  /** Changes when a voice selection or connection is saved in Settings. */
  voiceStatusRevision?: number;
  /** Opaque library identity for the review source facts; one studio library unless a host says otherwise. */
  libraryId?: string;
  /** The mounted plain-text leaf, for the editor mount's parity tests. */
  onEditorReady?: (editor: InlineEditor | null) => void;
  /**
   * A host-supplied, untrusted review request. This slice wires no provider and saves no report:
   * production passes nothing, so no request, mark or finding exists until a later host owns one.
   */
  reviewRequest?: unknown;
  /** Heading for the minimal findings list when a request is supplied. */
  reviewLabel?: string;
  /** Trusted validation port; the shared exact-source verifier unless a test supplies one. */
  evidencePort?: ValidatedEvidencePort;
}

interface Base {
  version: number;
  hash: string;
  content: string;
  title: string;
}

/** The shared verifier is host-neutral; one frozen port serves every mounted visit. */
const sharedEvidencePort = createSharedEvidencePort();

/** Distinct for every mounted visit, including a return to the same chapter (A → B → A). */
let visitCounter = 0;

export const ManuscriptEditor = forwardRef<EditorHandle, Props>(function ManuscriptEditor(
  {
    bookId,
    chapter,
    ordinal,
    onSaved,
    onStatus,
    illustration,
    illustrationData,
    selection,
    retryDelaysMs = SAVE_RETRY_DELAYS_MS,
    voiceStatusRevision = 0,
    libraryId = "studio-local",
    onEditorReady,
    reviewRequest,
    reviewLabel,
    evidencePort
  },
  ref
) {
  const [content, setContent] = useState(chapter.content);
  const [title, setTitle] = useState(chapter.title);
  const [status, setStatus] = useState<SaveStatus>({ kind: "saved", at: Date.now() });
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [selectionEmpty, setSelectionEmpty] = useState(true);
  const [replaceArmed, setReplaceArmed] = useState(false);
  const [editor, setEditor] = useState<InlineEditor | null>(null);
  const [layer, setLayer] = useState<ValidatedInlineLayer | null>(null);
  const [active, setActive] = useState<InlineSpan | null>(null);
  const clearActive = useCallback(() => setActive(null), []);
  const [announcement, setAnnouncement] = useState("");
  const statusRef = useRef(status);

  const base = useRef<Base>({ version: chapter.version, hash: chapter.hash, content: chapter.content, title: chapter.title });
  const latest = useRef(content);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<InlineEditor | null>(null);
  /** The armed replace is read at transcript time. useDictation keeps the onText it saw at start. */
  const replaceArmRef = useRef<{ revision: number; anchor: number; head: number } | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  /** The words the last conflicted save kept as a copy, the base it was checked against, and its status. */
  const kept = useRef<{ text: string; hash: string; status: SaveStatus } | null>(null);
  const [viewGeneration] = useState(() => `${chapter.id}:${++visitCounter}`);
  const sourceEpoch = useRef(1);
  /** Failed text saves since the last one that landed; it picks the next retry delay. */
  const failures = useRef(0);
  /** Saves on their way; a source is only clean when none is, and the buffer matches the base. */
  const savesInFlight = useRef(0);

  /** Every save-state or saved-base change is a source transition, including A → B → A. */
  const touchSource = useCallback(() => {
    sourceEpoch.current += 1;
  }, []);

  const updateStatus = useCallback((next: SaveStatus): SaveStatus => {
    statusRef.current = next;
    setStatus(next);
    touchSource();
    return next;
  }, [touchSource]);

  useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);

  const readSource = useCallback(
    (): InlineSource => ({
      libraryId,
      bookId,
      chapterId: chapter.id,
      viewGeneration,
      sourceEpoch: sourceEpoch.current,
      version: base.current.version,
      rawHash: base.current.hash,
      savedBody: base.current.content,
      clean: latest.current === base.current.content && savesInFlight.current === 0,
      pending: savesInFlight.current > 0,
      available: true
    }),
    [bookId, chapter.id, libraryId, viewGeneration]
  );
  const readSourceRef = useRef(readSource);
  readSourceRef.current = readSource;

  const evidenceSnapshot = useCallback((): InlineSnapshot | null => {
    const snapshot = editorRef.current?.getSnapshot();
    return snapshot && statusRef.current.kind === "saved" && isExactCurrent(snapshot, snapshot) ? snapshot : null;
  }, []);
  const evidenceCurrent = useCallback((expected: InlineSnapshot): boolean => {
    const current = evidenceSnapshot();
    return current !== null && current.revision === expected.revision && isExactCurrent(current, expected);
  }, [evidenceSnapshot]);

  useLayoutEffect(() => {
    if (!editor || !selection?.isCurrent()) return;
    // For a new chapter, capture its mounted visit only after it exists. For the already-open
    // chapter, retain the token captured before the saved-source read, including its revision.
    const expected = selection.visit ?? evidenceSnapshot();
    const source = selection.source;
    const applied = expected !== null && editorRef.current === editor && selection.isCurrent() &&
      expected.libraryId === source.libraryId && expected.bookId === source.bookId &&
      expected.chapterId === source.chapterId && expected.version === source.version &&
      expected.rawHash === source.rawHash && expected.savedBody === source.savedBody &&
      evidenceCurrent(expected) && editor.setSelection({ anchor: selection.start, head: selection.end }, true);
    selection.onResult(applied);
  }, [editor, selection, evidenceCurrent, evidenceSnapshot]);

  /** Nothing is left to write: drop the pending draft copy, here and in the main process. */
  const dropDraft = useCallback(() => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    void window.studio.drafts.clear(bookId, chapter.id);
  }, [bookId, chapter.id]);

  const saveNow = useCallback(
    async (text: string): Promise<SaveStatus> => {
      if (text === base.current.content) {
        if (statusRef.current.kind !== "dirty") return statusRef.current;
        // Typing and then undoing back to the saved text leaves nothing to write. The chapter on
        // disk already matches, so end where a save would: no pending draft, and saved.
        dropDraft();
        failures.current = 0;
        return updateStatus({ kind: "saved", at: Date.now() });
      }

      // These words are already in a conflict copy, checked against this same base. Saving them again,
      // from a flush, a remount or a quit, would only write the same copy twice (QA C4).
      const copy = kept.current;
      if (copy && copy.text === text && copy.hash === base.current.hash) {
        if (statusRef.current.kind !== "dirty") return statusRef.current;
        dropDraft();
        return updateStatus(copy.status);
      }

      updateStatus({ kind: "saving" });
      savesInFlight.current += 1;
      touchSource();
      try {
        const result = await window.studio.chapters.save({
          bookId,
          chapterId: chapter.id,
          content: text,
          baseVersion: base.current.version,
          baseHash: base.current.hash
        });

        if (!result.ok) {
          failures.current += 1;
          return updateStatus({ kind: "error", message: result.error.message });
        }
        if (result.data.status === "conflict") {
          failures.current = 0;
          const conflictStatus = updateStatus({ kind: "conflict", conflict: result.data.conflict });
          kept.current = { text, hash: base.current.hash, status: conflictStatus };
          // The copy holds these words, so no draft of them may be saved again at quit. Words typed
          // while the copy was written keep their draft until they are saved too.
          if (latest.current === text) dropDraft();
          return conflictStatus;
        }

        const saved = result.data.chapter;
        base.current = { version: saved.version, hash: saved.hash, content: saved.content, title: saved.title };
        onSaved(saved);
        void window.studio.drafts.clear(bookId, chapter.id);
        const afterRetry = failures.current > 0;
        failures.current = 0;
        return updateStatus(afterRetry ? { kind: "saved", at: Date.now(), afterRetry } : { kind: "saved", at: Date.now() });
      } catch (error) {
        failures.current += 1;
        return updateStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        savesInFlight.current = Math.max(0, savesInFlight.current - 1);
        touchSource();
        // A save response never certifies a newer draft: the leaf re-reads live source facts and
        // drops any marks painted against the previous saved token.
        const current = editorRef.current;
        if (current) void Promise.resolve().then(() => current.syncSource());
      }
    },
    [bookId, chapter.id, dropDraft, onSaved, touchSource, updateStatus]
  );

  // One save at a time. A save that started while another was on its way would carry the old base
  // and land as a conflict copy; queued, it compares against the base the first save left.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = useCallback(
    (text: string): Promise<SaveStatus> => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const run = queue.current.then(() => saveNow(text));
      queue.current = run.catch(() => {});
      return run;
    },
    [saveNow]
  );

  const saveRef = useRef(save);
  saveRef.current = save;

  const applyTextRef = useRef<(next: string) => void>(() => {});

  // The editor remounts for another chapter, so its id is fixed for the life of these handles.
  const chapterId = chapter.id;
  useImperativeHandle(
    ref,
    () => ({
      flush: () => saveRef.current(latest.current),
      getStatus: () => statusRef.current,
      getBaseHash: () => base.current.hash,
      getEvidenceSnapshot: evidenceSnapshot,
      isEvidenceCurrent: evidenceCurrent,
      hold: <T,>(write: () => Promise<T>): Promise<T> => {
        const release = editorRef.current?.hold();
        const run = queue.current.then(write);
        queue.current = run.catch(() => {});
        return release ? run.finally(release) : run;
      },
      rebase: (chapters: readonly Chapter[]) => {
        const file = chapters.find((item) => item.id === chapterId);
        if (!file) return false;
        if (file.hash === base.current.hash) return true;
        if (file.content !== base.current.content || file.title !== base.current.title) return false;
        const previous = readSourceRef.current();
        base.current = { ...base.current, version: file.version, hash: file.hash };
        touchSource();
        // Metadata-only acknowledgement: the leaf keeps a dirty buffer and only drops stale marks.
        editorRef.current?.rebase(previous);
        return true;
      }
    }),
    [chapterId, evidenceCurrent, evidenceSnapshot, touchSource]
  );

  // A close or quit asks for the newest text before the main process saves its drafts: the draft
  // copy below trails typing by 300 ms, so on its own it would lose the last keystrokes. When that
  // save fails, the newest text goes to the main process instead, which keeps it for recovery.
  useEffect(
    () =>
      window.studio.drafts.onFlushRequest(async () => {
        const outcome = await saveRef.current(latest.current);
        if (outcome.kind !== "error") return outcome;
        await window.studio.drafts.set({
          bookId,
          chapterId: chapter.id,
          content: latest.current,
          baseVersion: base.current.version,
          baseHash: base.current.hash
        });
        return outcome;
      }),
    [bookId, chapter.id]
  );

  // A failed save tries again by itself while the text is unsaved, instead of waiting for the next
  // keystroke. Any new status, a keystroke's included, cancels the wait; the next failure sets a longer one.
  useEffect(() => {
    // A failed title rename is not a text save; it shows its error and waits for the author.
    if (status.kind !== "error" || failures.current === 0) return;
    const delay = retryDelaysMs[Math.min(failures.current, retryDelaysMs.length) - 1];
    if (delay === undefined) return;
    const retry = setTimeout(() => {
      if (latest.current !== base.current.content) void saveRef.current(latest.current);
    }, delay);
    return () => clearTimeout(retry);
  }, [status, retryDelaysMs]);

  // Last line of defence: leaving the chapter must not drop the last keystrokes. The main process
  // also holds a draft copy and flushes it before the window closes.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      // A draft write after unmount would hit a torn-down bridge in checks and serves no author:
      // dirty text is saved above and the main process holds its own draft copy.
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (latest.current !== base.current.content) void saveRef.current(latest.current);
    };
  }, []);

  const applyText = (next: string): void => {
    setContent(next);
    latest.current = next;
    updateStatus({ kind: "dirty" });

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void saveRef.current(latest.current);
    }, 700);

    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      void window.studio.drafts.set({
        bookId,
        chapterId: chapter.id,
        content: latest.current,
        baseVersion: base.current.version,
        baseHash: base.current.hash
      });
    }, 300);
  };
  applyTextRef.current = applyText;

  const onEditorChange = useCallback(
    (change: InlineChange) => {
      // The leaf reports the pre-edit text without mapping marks through it; history is ours alone.
      if (change.recordHistory) pushHistory(chapter.id, change.previous, Date.now(), change.isolated);
      applyTextRef.current(change.text);
    },
    [chapter.id]
  );
  const onEditorChangeRef = useRef(onEditorChange);
  onEditorChangeRef.current = onEditorChange;

  const runCommand = (command: "undo" | "redo" | "save"): void => {
    if (command === "save") {
      void saveRef.current(latest.current);
      return;
    }
    const current = editorRef.current;
    if (!current) return;
    const snapshot = current.getSnapshot();
    // A refused replacement must not consume the undo snapshot: compose and move holds refuse it.
    if (snapshot.composing || snapshot.held) return;
    const next = command === "undo" ? undoHistory(chapter.id, latest.current) : redoHistory(chapter.id, latest.current);
    if (next === null) return;
    // Keep the caret off a surrogate pair split: undo after a one-character emoji edit otherwise
    // proposes offset 1 in the restored text and the whole replacement is refused.
    const selection = {
      anchor: safeTextOffset(next, snapshot.selection.anchor),
      head: safeTextOffset(next, snapshot.selection.head)
    };
    if (!current.replaceText(next, snapshot.revision, command, selection)) {
      // The replacement was refused, so put the history transition back where it was.
      if (command === "undo") redoHistory(chapter.id, next);
      else undoHistory(chapter.id, next);
    }
  };
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;

  const handleInspection = useCallback((inspection: InlineInspection) => {
    setActive(inspection.active);
    const current = editorRef.current;
    const spans = current?.getLayer()?.spans ?? [];
    const index = spans.findIndex((span) => inlineSpanKey(span) === inlineSpanKey(inspection.active));
    setAnnouncement(describeInspection(inspection, index, spans.length));
    if (inspection.action === "return") {
      const key = findingKey(inspection.active);
      requestAnimationFrame(() => rowRefs.current.get(key)?.focus());
    }
  }, []);
  const handleInspectionRef = useRef(handleInspection);
  handleInspectionRef.current = handleInspection;

  const handleReviewStatus = useCallback((next: "hidden" | "filtered" | "stale" | "ready") => {
    if (next === "stale") {
      setLayer(null);
      setActive(null);
      setAnnouncement("The review marks are hidden because the text changed. The findings are no longer current.");
      return;
    }
    if (next === "filtered") {
      // The row must not stay current once the filter hides the finding it names.
      setActive(null);
      setAnnouncement("The active finding is hidden by the filter.");
    }
  }, []);
  const handleReviewStatusRef = useRef(handleReviewStatus);
  handleReviewStatusRef.current = handleReviewStatus;

  const onSelectionRef = useRef<(selection: TextSelection) => void>(() => {});
  onSelectionRef.current = (selection) => {
    setSelectionEmpty(selection.anchor === selection.head);
  };

  const optionsRef = useRef<InlineEditorOptions | null>(null);
  if (!optionsRef.current) {
    optionsRef.current = {
      initialText: latest.current,
      readSource: () => readSourceRef.current(),
      evidence: evidencePort ?? (sharedEvidencePort as ValidatedEvidencePort),
      onChange: (change) => onEditorChangeRef.current(change),
      onCommand: (command) => runCommandRef.current(command),
      onInspect: (inspection) => handleInspectionRef.current(inspection),
      onReviewStatus: (next) => handleReviewStatusRef.current(next),
      onSelection: (selection) => onSelectionRef.current(selection),
      onComposition: () => {},
      onBlur: () => void saveRef.current(latest.current),
      label: "Chapter text",
      testId: "manuscript-text",
      placeholder: "Begin wherever you like. Nothing here is read by anyone else."
    };
  }
  const options = optionsRef.current;

  // Stable for the visit: a rerender must never recreate the view or its undo-adjacent state.
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  const onReady = useCallback((next: InlineEditor | null) => {
    editorRef.current = next;
    setEditor(next);
    onEditorReadyRef.current?.(next);
  }, []);

  useEffect(() => {
    if (!editor) return;
    const element = surface.current?.querySelector<HTMLElement>('[data-testid="manuscript-text"]');
    if (!element) return;
    return installTextareaContract(element, editor);
  }, [editor]);

  // Host-supplied synthetic request: the trusted port verifies it; nothing is sent or saved here.
  useEffect(() => {
    if (!editor) return;
    if (reviewRequest === undefined || reviewRequest === null) {
      // The host withdrew its request: no marks, no list, and no late proof may paint one.
      editor.discardEvidence();
      setLayer(null);
      setActive(null);
      setAnnouncement("");
      return;
    }
    let live = true;
    setLayer(null);
    setActive(null);
    void editor.showEvidence(reviewRequest).then((result) => {
      if (!live) return;
      if (result !== "applied") {
        setAnnouncement(
          result === "unavailable"
            ? "The review layer could not be verified for this saved text."
            : "The review layer was replaced or is no longer current."
        );
        return;
      }
      const next = editor.getLayer();
      setLayer(next);
      setAnnouncement(
        next ? `${formatCount(next.spans.length)} ${pluralize(next.spans.length, "finding")} verified for this saved text.` : ""
      );
    });
    return () => {
      live = false;
    };
  }, [editor, reviewRequest]);

  const disarmReplace = (): void => {
    replaceArmRef.current = null;
    setReplaceArmed(false);
  };

  /** Arm the next transcript only, for the revision and selection offsets at this moment. */
  const toggleReplaceSelection = (): void => {
    if (replaceArmRef.current) {
      disarmReplace();
      return;
    }
    const current = editorRef.current;
    if (!current) return;
    const snapshot = current.getSnapshot();
    if (snapshot.selection.anchor === snapshot.selection.head) return;
    replaceArmRef.current = {
      revision: snapshot.revision,
      anchor: snapshot.selection.anchor,
      head: snapshot.selection.head
    };
    setReplaceArmed(true);
  };

  /**
   * Insert a transcript where the author left the caret and keep any selected text. Spacing is added
   * only when the surrounding prose needs it, and a line break in the transcript stays a line break.
   * Replace selection, while still armed for this revision and these offsets, removes only that range.
   * Either path takes the normal applyText -> draft -> save path. A busy editor refuses and leaves
   * the transcript with the host for retry.
   */
  const insertTranscript = (text: string): void => {
    const current = editorRef.current;
    if (!current) {
      setVoiceError("The editor is not ready yet. Dictate again in a moment.");
      return;
    }
    const snapshot = current.getSnapshot();
    const arm = replaceArmRef.current;
    if (arm) {
      disarmReplace();
      const selection = snapshot.selection;
      const matches = snapshot.revision === arm.revision && selection.anchor === arm.anchor && selection.head === arm.head;
      if (!matches || !current.replaceDictation(text, snapshot.revision)) {
        setVoiceError("The transcript could not be inserted while the editor is busy. Dictate again when it is ready.");
        return;
      }
    } else if (!current.insertDictation(text, snapshot.revision)) {
      setVoiceError("The transcript could not be inserted while the editor is busy. Dictate again when it is ready.");
      return;
    }
    setVoiceError(null);
    current.focus();
  };

  const commitTitle = async (): Promise<void> => {
    const next = title.trim();
    if (!next || next === base.current.title) {
      setTitle(base.current.title);
      return;
    }
    try {
      const result = await window.studio.chapters.updateMeta(
        bookId,
        chapter.id,
        { title: next },
        { baseVersion: base.current.version, baseHash: base.current.hash }
      );
      if (!result.ok) {
        updateStatus({ kind: "error", message: result.error.message });
        return;
      }
      if (result.data.status === "conflict") {
        updateStatus({ kind: "conflict", conflict: result.data.conflict });
        return;
      }
      const saved = result.data.chapter;
      const previous = readSourceRef.current();
      base.current = { version: saved.version, hash: saved.hash, content: saved.content, title: saved.title };
      touchSource();
      editorRef.current?.rebase(previous);
      onSaved(saved);
      updateStatus({ kind: "saved", at: Date.now() });
    } catch (error) {
      updateStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const words = countWords(content);
  const lines = content.split("\n").filter((line) => line.trim().length > 0).length;

  const sheet = (
    <div
      className={layer ? "min-w-0 flex-1" : "w-full"}
      data-testid="manuscript-editor"
    >
      <div className="rounded-[var(--corner-xl)] bg-[var(--manuscript-bg)] px-5 pt-8 pb-16 shadow-[var(--elevation-2)] min-[700px]:px-10 min-[700px]:pt-12 min-[700px]:pb-24 lg:px-14">
        <div className="tabular mb-4 flex flex-wrap items-center gap-2 whitespace-nowrap text-(length:--text-caption-size) text-muted-foreground">
          <span>{chapter.isPrologue ? "Prologue" : `Chapter ${ordinal}`}</span>
          <span className="opacity-50">·</span>
          <span>{formatWords(words)}</span>
          <span className="opacity-50">·</span>
          <span>
            {formatCount(lines)} {pluralize(lines, "line")}
          </span>
          <span className="ml-auto inline-flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={replaceArmed}
              disabled={selectionEmpty}
              data-testid="replace-selection"
              onClick={toggleReplaceSelection}
            >
              Replace selection
            </Button>
            <VoiceButton
              onText={insertTranscript}
              onError={(error) => setVoiceError(error.message)}
              voiceStatusRevision={voiceStatusRevision}
            />
          </span>
        </div>
        {voiceError ? (
          <p role="alert" className="mb-3 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-destructive">
            {voiceError}
          </p>
        ) : null}

        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          maxLength={400}
          spellCheck={false}
          aria-label="Chapter title"
          placeholder="Untitled chapter"
          className="chapter-title w-full bg-transparent tracking-[-0.2px] outline-none placeholder:text-muted-foreground/60"
        />

        <div ref={surface} className="manuscript thin-scroll mt-8">
          <InlineTextSurface options={options} onReady={onReady} />
        </div>

        {illustration && illustrationData ? (
          <figure className="mt-10 border-t border-[var(--border)] pt-6" data-testid="chapter-illustration">
            <img
              src={illustrationData}
              alt={illustration.prompt || `Illustration for ${chapter.title}`}
              className="w-full rounded-[var(--corner-lg)] bg-[var(--secondary)] object-contain"
            />
            <figcaption className="mt-2 text-(length:--text-caption-size) text-muted-foreground">
              {illustration.prompt || "Chapter illustration"} · {illustration.model}
            </figcaption>
          </figure>
        ) : null}
      </div>
    </div>
  );

  if (!layer) {
    return <div className="mx-auto w-full max-w-[760px]">{sheet}</div>;
  }

  // The outer element type never changes with the layer, so painting findings never remounts the
  // editor: one view, one undo owner, one save path for the whole visit.
  return (
    <div className="mx-auto flex w-full max-w-[1120px] items-start gap-6">
      {sheet}
      <ReviewFindingsAside
        editor={editor}
        layer={layer}
        label={reviewLabel}
        active={active}
        onClearActive={clearActive}
        announcement={announcement}
        onRow={(key, element) => {
          if (element) rowRefs.current.set(key, element);
          else rowRefs.current.delete(key);
        }}
      />
    </div>
  );
});

/** The heading the findings list uses when a host gives none. */
const DEFAULT_REVIEW_LABEL = "Review findings";

/** One row per finding, in source order; each row has an equivalent control in the text toolbar. */
function ReviewFindingsAside({
  editor,
  layer,
  label,
  active,
  announcement,
  onRow,
  onClearActive
}: {
  editor: InlineEditor | null;
  layer: ValidatedInlineLayer;
  label: string | undefined;
  active: InlineSpan | null;
  announcement: string;
  onRow: (key: string, element: HTMLElement | null) => void;
  onClearActive: () => void;
}) {
  const [category, setCategory] = useState("all");
  const lastCategory = useRef(category);
  const categories = [...new Set(layer.spans.map((span) => span.category))].sort();
  const visible = category === "all" ? layer.spans : layer.spans.filter((span) => span.category === category);

  useEffect(() => {
    if (!editor) return;
    // Filtering only changes what is painted; no request, write or finding is removed. A real
    // filter change clears the transient "current" finding, so a row cannot stay current while its
    // mark is hidden; re-renders for other reasons keep it.
    if (lastCategory.current !== category) {
      lastCategory.current = category;
      onClearActive();
    }
    editor.setVisibility(
      category === "all" ? null : new Set(layer.spans.filter((span) => span.category === category).map(inlineSpanKey)),
      false
    );
  }, [category, editor, layer, onClearActive]);

  const activeKey = active ? findingKey(active) : null;

  return (
    <aside
      aria-label="Review findings"
      className="glass mt-8 w-[300px] shrink-0 rounded-[var(--corner-lg)] p-4 text-(length:--text-caption-size) min-[1000px]:sticky min-[1000px]:top-4"
    >
      <h2 className="text-(length:--text-subheadline-size) font-semibold">{label || DEFAULT_REVIEW_LABEL}</h2>
      <p className="mt-1 text-muted-foreground" data-testid="review-count">
        {formatCount(groupFindings(visible).length)} of {formatCount(groupFindings(layer.spans).length)}{" "}
        {pluralize(groupFindings(layer.spans).length, "finding")} shown
      </p>

      {categories.length > 1 ? (
        <label className="mt-3 block">
          <span className="text-muted-foreground">Show</span>
          <select
            aria-label="Filter findings by category"
            className="mt-1 w-full rounded-[var(--corner-sm)] border border-[var(--border)] bg-transparent px-2 py-1"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">All categories</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="mt-3">
        <InlineReviewControls editor={editor} />
      </div>

      <ol className="mt-3 space-y-2">
        {groupFindings(visible).map((row, index) => (
          <li key={row.key}>
            <button
              type="button"
              ref={(element) => onRow(row.key, element)}
              {...(row.key === activeKey ? { "aria-current": true as const } : {})}
              aria-label={`Show ${row.category} finding ${index + 1} in the text`}
              onClick={() => {
                if (!editor) return;
                if (!editor.inspectSpan(row.span)) editor.inspectAt(row.span.from);
              }}
              disabled={!editor}
              className="w-full rounded-[var(--corner-sm)] border border-[var(--border)] px-2 py-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--primary)] aria-[current=true]:border-[var(--primary)]"
            >
              <span className="font-medium">{row.category}</span>
              {row.count > 1 ? <span className="text-muted-foreground"> · {row.count} passages</span> : null}
              <span className="mt-1 block line-clamp-3 text-muted-foreground">“{row.quote}”</span>
            </button>
          </li>
        ))}
      </ol>

      <p role="status" aria-live="polite" className="mt-3 min-h-4 text-muted-foreground">
        {announcement}
      </p>
    </aside>
  );
}

interface FindingRow {
  key: string;
  category: string;
  quote: string;
  count: number;
  span: InlineSpan;
}

function findingKey(span: InlineSpan): string {
  return JSON.stringify([span.runId, span.findingId]);
}

/** Clamp a text offset, moving left one unit when it would split a surrogate pair. */
function safeTextOffset(text: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, text.length));
  if (at > 0 && at < text.length) {
    const before = text.charCodeAt(at - 1);
    const after = text.charCodeAt(at);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) at -= 1;
  }
  return at;
}

function groupFindings(spans: readonly InlineSpan[]): FindingRow[] {
  const rows = new Map<string, FindingRow>();
  for (const span of spans) {
    const key = findingKey(span);
    const existing = rows.get(key);
    if (existing) {
      rows.set(key, { ...existing, count: existing.count + 1 });
      continue;
    }
    rows.set(key, {
      key,
      category: span.category,
      quote: span.quote.replace(/\s+/g, " ").trim().slice(0, 120),
      count: 1,
      span
    });
  }
  return [...rows.values()];
}

function describeInspection(inspection: InlineInspection, index: number, total: number): string {
  const overlap = inspection.choices.length > 1 ? ` ${inspection.choices.length} findings overlap this passage.` : "";
  const where = index >= 0 ? `Finding ${index + 1} of ${total}: ${inspection.active.category}.` : inspection.active.category;
  return `${inspection.action === "return" ? "Returned to the finding. " : ""}${where}${overlap}`;
}

/**
 * The mount keeps the automation contract the old textarea had: reading `value` returns the exact
 * editor text, and assigning it applies that text through the editor's ordinary compare-and-set
 * change path (never through a second save, undo or persistence owner). Native typing never touches
 * this shim; the hidden smoke and the existing DOM tests drive the same mounted surface through it.
 */
function installTextareaContract(element: HTMLElement, editor: InlineEditor): () => void {
  let pending: string | null = null;

  const apply = (): void => {
    if (pending === null) return;
    const text = pending;
    pending = null;
    const snapshot = editor.getSnapshot();
    if (!snapshot.destroyed && !snapshot.composing) editor.typeText(text, snapshot.revision);
  };

  Object.defineProperty(element, "value", {
    configurable: true,
    get: () => editor.getSnapshot().body,
    set: (next: string) => {
      pending = String(next);
    }
  });
  Object.defineProperty(element, "selectionStart", {
    configurable: true,
    get: () => editor.getSnapshot().selection.anchor,
    set: (offset: number) => {
      const snapshot = editor.getSnapshot();
      editor.setSelection({ anchor: offset, head: snapshot.selection.head });
    }
  });
  Object.defineProperty(element, "selectionEnd", {
    configurable: true,
    get: () => editor.getSnapshot().selection.head,
    set: (offset: number) => {
      const snapshot = editor.getSnapshot();
      editor.setSelection({ anchor: snapshot.selection.anchor, head: offset });
    }
  });

  element.addEventListener("change", apply);
  element.addEventListener("input", apply);
  return () => {
    element.removeEventListener("change", apply);
    element.removeEventListener("input", apply);
    for (const key of ["value", "selectionStart", "selectionEnd"]) delete (element as unknown as Record<string, unknown>)[key];
  };
}

/** The save status as one plain sentence, with the reason when a save failed. */
export function statusLabel(status: SaveStatus): string {
  switch (status.kind) {
    case "saved":
      return status.afterRetry ? `Saved ${savedTime(status.at)} after retrying` : `Saved ${savedTime(status.at)}`;
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "conflict":
      return "Not saved";
    case "error":
      return `Not saved. ${saveProblem(status.message)} Your words are still here, and the studio keeps trying to save them.`;
  }
}

/** Why a save failed, as the save status shows it: the main process's sentence in plain words, never blank. */
export function saveProblem(message: string): string {
  const reason = plainSaveReason(message).trim();
  if (!reason) return "The library did not say why.";
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}
