import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Chapter, ChapterConflict } from "@ai-book-studio/core/schema";
import type { ImageRecord } from "@ai-book-studio/core/images/schema";
import { plainSaveReason } from "@ai-book-studio/core/library/errors";
import { pushHistory, redoHistory, undoHistory } from "../lib/editor-history";
import { countWords, formatCount, formatWords, pluralize, savedTime } from "../lib/utils";
import { insertTranscript as insertAtSelection } from "../lib/voice-text";
import { normalizePasteText } from "@ai-book-studio/core/paste";
import { VoiceButton } from "./VoiceButton";

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
  /** Changes every time a new span is requested, even for the same offsets. */
  nonce: number;
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
}

interface Base {
  version: number;
  hash: string;
  content: string;
  title: string;
}

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
    voiceStatusRevision = 0
  },
  ref
) {
  const [content, setContent] = useState(chapter.content);
  const [title, setTitle] = useState(chapter.title);
  const [status, setStatus] = useState<SaveStatus>({ kind: "saved", at: Date.now() });
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const statusRef = useRef(status);

  const base = useRef<Base>({ version: chapter.version, hash: chapter.hash, content: chapter.content, title: chapter.title });
  const latest = useRef(content);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  /** The words the last conflicted save kept as a copy, the base it was checked against, and its status. */
  const kept = useRef<{ text: string; hash: string; status: SaveStatus } | null>(null);
  /** Failed text saves since the last one that landed; it picks the next retry delay. */
  const failures = useRef(0);

  const updateStatus = useCallback((next: SaveStatus): SaveStatus => {
    statusRef.current = next;
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);

  const selectionNonce = selection?.nonce;
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectionNonce is the change token; selection is a prop whose identity may change without new content, and following it would steal focus on every render
  useEffect(() => {
    if (!selection || selectionNonce === undefined) return;
    const element = textarea.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(selection.start, selection.end);
    element.scrollIntoView({ block: "center" });
  }, [selectionNonce]);

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
          const status = updateStatus({ kind: "conflict", conflict: result.data.conflict });
          kept.current = { text, hash: base.current.hash, status };
          // The copy holds these words, so no draft of them may be saved again at quit. Words typed
          // while the copy was written keep their draft until they are saved too.
          if (latest.current === text) dropDraft();
          return status;
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
      }
    },
    [bookId, chapter.id, dropDraft, onSaved, updateStatus]
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

  // The editor remounts for another chapter, so its id is fixed for the life of these handles.
  const chapterId = chapter.id;
  useImperativeHandle(
    ref,
    () => ({
      flush: () => saveRef.current(latest.current),
      getStatus: () => statusRef.current,
      getBaseHash: () => base.current.hash,
      hold: <T,>(write: () => Promise<T>): Promise<T> => {
        const run = queue.current.then(write);
        queue.current = run.catch(() => {});
        return run;
      },
      rebase: (chapters: readonly Chapter[]) => {
        const file = chapters.find((item) => item.id === chapterId);
        if (!file) return false;
        if (file.hash === base.current.hash) return true;
        if (file.content !== base.current.content || file.title !== base.current.title) return false;
        base.current = { ...base.current, version: file.version, hash: file.hash };
        return true;
      }
    }),
    [chapterId]
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

  const onChange = (next: string): void => {
    pushHistory(chapter.id, content, Date.now(), Math.abs(next.length - content.length) > 1);
    applyText(next);
  };

  /**
   * Insert a transcript where the author left the caret. Spacing is added only when the surrounding
   * text needs it; the insert then takes the normal applyText -> draft -> save path.
   */
  const insertTranscript = (text: string): void => {
    const element = textarea.current;
    const start = element?.selectionStart ?? latest.current.length;
    const end = element?.selectionEnd ?? start;
    const current = latest.current;
    const insertion = insertAtSelection(current, text, start, end);
    if (!insertion) return;
    setVoiceError(null);
    pushHistory(chapter.id, current, Date.now(), true);
    applyText(insertion.text);
    requestAnimationFrame(() => {
      const next = textarea.current;
      if (!next) return;
      next.focus();
      next.setSelectionRange(insertion.caret, insertion.caret);
    });
  };

  /**
   * Paste through the studio normaliser: line endings, spacing and quotation marks are unified
   * before the text lands, while single breaks, stanza breaks and hard breaks pass through so
   * verse survives. The insert takes the normal applyText -> draft -> save path, and the caret
   * lands after the inserted text.
   */
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = event.clipboardData?.getData("text");
    if (!pasted) return;
    event.preventDefault();
    const element = textarea.current;
    const start = element?.selectionStart ?? latest.current.length;
    const end = element?.selectionEnd ?? start;
    const current = latest.current;
    const inserted = normalizePasteText(pasted);
    pushHistory(chapter.id, current, Date.now(), true);
    applyText(`${current.slice(0, start)}${inserted}${current.slice(end)}`);
    requestAnimationFrame(() => {
      const next = textarea.current;
      if (!next) return;
      next.focus();
      const caret = start + inserted.length;
      next.setSelectionRange(caret, caret);
    });
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
      base.current = { version: saved.version, hash: saved.hash, content: saved.content, title: saved.title };
      onSaved(saved);
      updateStatus({ kind: "saved", at: Date.now() });
    } catch (error) {
      updateStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const words = countWords(content);
  const lines = content.split("\n").filter((line) => line.trim().length > 0).length;

  return (
    <div className="mx-auto w-full max-w-[760px]" data-testid="manuscript-editor">
      <div className="rounded-[var(--corner-xl)] bg-[var(--manuscript-bg)] px-5 pt-8 pb-16 shadow-[var(--elevation-2)] min-[700px]:px-10 min-[700px]:pt-12 min-[700px]:pb-24 lg:px-14">
        <div className="tabular mb-4 flex flex-wrap items-center gap-2 whitespace-nowrap text-(length:--text-caption-size) text-muted-foreground">
          <span>{chapter.isPrologue ? "Prologue" : `Chapter ${ordinal}`}</span>
          <span className="opacity-50">·</span>
          <span>{formatWords(words)}</span>
          <span className="opacity-50">·</span>
          <span>
            {formatCount(lines)} {pluralize(lines, "line")}
          </span>
          <span className="ml-auto">
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

        <textarea
          ref={textarea}
          value={content}
          data-testid="manuscript-text"
          onChange={(event) => onChange(event.target.value)}
          onPaste={onPaste}
          onBlur={() => void saveRef.current(latest.current)}
          onKeyDown={(event) => {
            const key = event.key.toLowerCase();
            if ((event.metaKey || event.ctrlKey) && key === "s") {
              event.preventDefault();
              void saveRef.current(latest.current);
              return;
            }
            if ((event.metaKey || event.ctrlKey) && key === "z" && !event.shiftKey) {
              const previous = undoHistory(chapter.id, latest.current);
              if (previous !== null) {
                event.preventDefault();
                applyText(previous);
              }
              return;
            }
            if (
              ((event.metaKey || event.ctrlKey) && key === "z" && event.shiftKey) ||
              (event.ctrlKey && key === "y")
            ) {
              const next = redoHistory(chapter.id, latest.current);
              if (next !== null) {
                event.preventDefault();
                applyText(next);
              }
            }
          }}
          spellCheck
          aria-label="Chapter text"
          placeholder="Begin wherever you like. Nothing here is read by anyone else."
          className="manuscript thin-scroll mt-8 block min-h-[52vh] w-full resize-none border-0 bg-transparent p-0 outline-none placeholder:text-muted-foreground/60"
        />

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
});

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
