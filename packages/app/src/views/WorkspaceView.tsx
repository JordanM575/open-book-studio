import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Bot, ChevronLeft, Cpu, Download, FileSearch, FileText, Image as ImageIcon, List, MessageSquare, Monitor, Moon, MoreHorizontal, Plus, Search, Settings2, Sun, Type, type LucideIcon } from "lucide-react";
import type {
  BookDetail,
  Chapter,
  ChapterConflict,
  ChapterReadIssueReason,
  ReorderChapterResult
} from "@ai-book-studio/core/schema";
import type { ImageRecord } from "@ai-book-studio/core/images/schema";
import type { RecoveredDraft } from "@ai-book-studio/core/ipc";
import { plainSaveReason } from "@ai-book-studio/core/library/errors";
import { modelDisplayName } from "@ai-book-studio/core/providers/compatibility";
import type { StorageSummary } from "@ai-book-studio/core/library/storage";
import { Button } from "@ai-book-studio/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@ai-book-studio/ui/dialog";
import { ChapterRail } from "../components/ChapterRail";
import { ModelPickerDialog } from "../components/ModelPickerDialog";
import { IllustrationDialog } from "../components/IllustrationDialog";
import { AgentDialog } from "../components/AgentDialog";
import { AmbientPanel } from "../components/AmbientPanel";
import { StoryBibleDialog } from "../components/StoryBibleDialog";
import { SearchDialog } from "../components/SearchDialog";
import { FormatDialog, type FormatChange } from "../components/FormatDialog";
import { ChatPanel } from "../components/ChatPanel";
import { SettingsDialog, type SettingsSection } from "../components/SettingsDialog";
import {
  analyzeReviewCoverageAsync,
  buildReviewReport,
  revalidateReviewEvidence,
  reviewNoSourceResult,
  reviewReportFreshness,
  reviewSourceSnapshotFromBookDetail,
  runReviewWork
} from "@ai-book-studio/core/review";
import {
  ManuscriptEditor,
  saveProblem,
  statusLabel,
  type EditorHandle,
  type EditorSelection,
  type SaveStatus
} from "../components/ManuscriptEditor";
import { RecoveryPanel } from "../components/RecoveryPanel";
import { ReviewGateDialog, type ReviewGateView } from "../components/ReviewGateDialog";
import { ReviewReportDialog, type ReviewRunView } from "../components/ReviewReportDialog";
import { exportBlockedMessage } from "../lib/export-save";
import { runAfterReviewSave } from "../lib/review-save-gate";
import { mustCompatible, SchemaRefusalError } from "../lib/schema-refusal";
import { clearEditorHistory } from "../lib/editor-history";
import { editBook, formatCount, formatWords, keptCopyText, must, pluralize } from "../lib/utils";
import type { ThemeChoice } from "../hooks/use-theme";

export interface ChapterRequest {
  bookId: string;
  chapterId?: string | undefined;
  nonce: number;
  /** Drop unsent text and reload the chapter from disk instead of just selecting it. */
  revert: boolean;
}

/** Open the writing agent on one conversation, as a window reopened after a background turn does. */
export interface ConversationRequest {
  bookId: string;
  threadId: string;
  nonce: number;
}

interface Props {
  bookId: string;
  theme: { choice: ThemeChoice; set: (choice: ThemeChoice) => void; cycle: () => void };
  libraryRoot: string;
  libraryStorage?: StorageSummary | undefined;
  deviceName?: string | null | undefined;
  chapterRequest?: ChapterRequest | null | undefined;
  onChapterRequestHandled?: (() => void) | undefined;
  conversationRequest?: ConversationRequest | null | undefined;
  onConversationRequestHandled?: (() => void) | undefined;
  onCheckForChanges?: (() => Promise<{ dirty: boolean }>) | undefined;
  onBack: () => void;
  onNotice: (error: unknown) => void;
  onSchemaRefusal: (refusal: { detectedSchema: number | null }) => void;
}

const EMPTY_STATUS: SaveStatus = { kind: "saved", at: Date.now() };

/** A short, always-visible label. The full label (with time) stays in aria-label. */
function compactStatus(status: SaveStatus): string {
  switch (status.kind) {
    case "saved":
      return status.afterRetry ? "Saved after retrying" : "Saved";
    case "dirty":
      return "Unsaved";
    case "saving":
      return "Saving…";
    case "conflict":
    case "error":
      return "Not saved";
  }
}

const readIssueReasonCopy: Record<ChapterReadIssueReason, string> = {
  "file-missing": "missing",
  "permission-needed": "needs permission",
  "invalid-format": "invalid format",
  unreadable: "unreadable"
};

/** Plain sentence-case account of the chapter files the saved read had to skip. */
function readIssueCopy(issues: BookDetail["chapterReadIssues"]): string {
  if (issues.length === 1) {
    const issue = issues[0]!;
    return `Chapter file ${issue.fileName} was skipped (${readIssueReasonCopy[issue.reason]}). The rest of the book is unchanged.`;
  }
  const names = issues.map((issue) => `${issue.fileName} (${readIssueReasonCopy[issue.reason]})`);
  return `${issues.length} chapter files were skipped (${names.join(", ")}). The rest of the book is unchanged.`;
}

export function WorkspaceView({
  bookId,
  theme,
  libraryRoot,
  libraryStorage,
  deviceName,
  chapterRequest,
  onChapterRequestHandled,
  conversationRequest,
  onConversationRequestHandled,
  onCheckForChanges,
  onBack,
  onNotice,
  onSchemaRefusal
}: Props) {
  const handledRequest = useRef<number | null>(null);
  const handledConversation = useRef<number | null>(null);
  const [detail, setDetail] = useState<BookDetail | null>(null);
  /**
   * The newest copy this view knows of each book it has shown, so a save that was waiting starts from what
   * the one before it returned. The workspace can move to another book without remounting, so a book's
   * baseline is kept apart from the others'.
   */
  const latestBooks = useRef<Map<string, BookDetail["book"]>>(new Map());
  if (detail) latestBooks.current.set(detail.book.id, detail.book);
  /** The book on screen now, which a save that finishes later checks before it touches the screen. */
  const shownBookId = useRef(bookId);
  shownBookId.current = bookId;
  /** Format saves run one at a time: the dialog sends a change per control change, without waiting for the last. */
  const formatSaves = useRef<Promise<unknown>>(Promise.resolve());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>(EMPTY_STATUS);
  const [conflicts, setConflicts] = useState<ChapterConflict[]>([]);
  const [recovered, setRecovered] = useState<RecoveredDraft[]>([]);
  const [recovering, setRecovering] = useState(false);
  const [externalChange, setExternalChange] = useState<{ paths: string[]; at: string } | null>(null);
  const [issuesDismissed, setIssuesDismissed] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Chapter | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelMode, setModelMode] = useState<"book" | "turn">("book");
  const [turnModel, setTurnModel] = useState<{ connectionId: string; modelId: string } | null>(null);
  const [bibleOpen, setBibleOpen] = useState(false);
  const [illustrationOpen, setIllustrationOpen] = useState(false);
  const [illustration, setIllustration] = useState<ImageRecord | null>(null);
  const [illustrationData, setIllustrationData] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // The conversation the agent opens on when a request asked for one; otherwise the newest.
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const chatWasOpen = useRef(chatOpen);
  const [agentOpen, setAgentOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceStatusRevision, setVoiceStatusRevision] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  // Cleared on unmount, so the note's timer never fires into a workspace that is gone.
  const exportNoteTimer = useRef<number | undefined>(undefined);
  const [formatOpen, setFormatOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewView, setReviewView] = useState<ReviewGateView | ReviewRunView>({ kind: "choice" });
  const [evidenceSelection, setEvidenceSelection] = useState<(EditorSelection & { chapterId: string }) | null>(null);
  const runController = useRef<AbortController | null>(null);
  const editorRef = useRef<EditorHandle>(null);
  const isMac = window.studio.platform === "darwin";

  const openSettings = useCallback((next?: SettingsSection) => {
    setSettingsSection(next);
    setSettingsOpen(true);
  }, []);

  const openModelPicker = useCallback((mode: "book" | "turn" = "book") => {
    setModelMode(mode);
    setModelOpen(true);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bookId is the trigger, not a closure value — the panel resets in place when the author switches books without a remount
  useEffect(() => {
    setTurnModel(null);
    setIssuesDismissed(false);
  }, [bookId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bookId is the trigger, not a closure value — the run-local report discards in place on a book switch
  useEffect(() => {
    // The report is run-local: switching books discards it without writing anything anywhere.
    runController.current?.abort();
    runController.current = null;
    setReviewOpen(false);
    setReviewView({ kind: "choice" });
    setEvidenceSelection(null);
  }, [bookId]);

  useEffect(() => {
    // New keystrokes supersede a highlighted evidence span.
    if (status.kind === "dirty") setEvidenceSelection(null);
  }, [status]);

  const load = useCallback(
    async (preferId?: string): Promise<BookDetail | null> => {
      try {
        const next = await mustCompatible(window.studio.books.open(bookId));
        setDetail(next);
        setConflicts(await must(window.studio.conflicts.list(bookId)));
        setSelectedId((current) => {
          const wanted = preferId ?? current;
          return next.chapters.some((chapter) => chapter.id === wanted) ? (wanted ?? null) : (next.chapters[0]?.id ?? null);
        });
        return next;
      } catch (error) {
        // A newer-schema refusal opens the recovery journey instead of a toast: the
        // library stays open, the book stays unread, and nothing is written.
        if (error instanceof SchemaRefusalError) {
          onSchemaRefusal({ detectedSchema: error.detectedSchema });
          return null;
        }
        onNotice(error);
        return null;
      }
    },
    [bookId, onNotice, onSchemaRefusal]
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** List the conflict copies again after the editor or an agent tool kept one, so the banner counts what is on disk. */
  const refreshConflicts = useCallback(async () => {
    try {
      setConflicts(await must(window.studio.conflicts.list(bookId)));
    } catch (error) {
      onNotice(error);
    }
  }, [bookId, onNotice]);

  useEffect(() => {
    if (status.kind === "conflict") void refreshConflicts();
  }, [status, refreshConflicts]);

  // Words a close or quit could not save to this book are offered as soon as it opens.
  const loadRecovered = useCallback(async () => {
    try {
      setRecovered(await must(window.studio.recovery.list(bookId)));
    } catch (error) {
      onNotice(error);
    }
  }, [bookId, onNotice]);

  useEffect(() => {
    void loadRecovered();
  }, [loadRecovered]);

  useEffect(() => {
    // The main process reports only another writer's changes: it recognises the studio's own saves,
    // Story Bible, image and agent writes by their bytes, so every change that arrives is announced,
    // however soon it follows a local save.
    return window.studio.library.onChange((change) => setExternalChange(change));
  }, []);

  const selected = detail?.chapters.find((chapter) => chapter.id === selectedId) ?? null;
  const readIssues = detail?.chapterReadIssues ?? [];
  const ordinal = selected ? detail!.chapters.filter((chapter) => chapter.order <= selected.order).length : 0;

  /** The next chapter, for the agent's "next chapter" action. */
  const nextChapter = useCallback(() => {
    const chapters = detail?.chapters ?? [];
    if (chapters.length === 0) return;
    const index = selected ? chapters.findIndex((chapter) => chapter.id === selected.id) : -1;
    const next = chapters[(index + 1) % chapters.length];
    if (next) setSelectedId(next.id);
  }, [detail, selected]);

  const loadIllustration = useCallback(
    async (chapterId: string | null) => {
      if (!chapterId) {
        setIllustration(null);
        setIllustrationData(null);
        return;
      }
      try {
        const listed = await must(window.studio.images.list(bookId));
        const attached = listed.manifest.images.find((image) => image.chapterId === chapterId) ?? null;
        if (!attached) {
          setIllustration(null);
          setIllustrationData(null);
          return;
        }
        const stored = await must(window.studio.images.read(bookId, attached.id));
        setIllustration(attached);
        setIllustrationData(stored?.dataUrl ?? null);
      } catch {
        setIllustration(null);
        setIllustrationData(null);
      }
    },
    [bookId]
  );

  useEffect(() => {
    void loadIllustration(selectedId);
  }, [selectedId, loadIllustration]);

  const select = async (chapterId: string): Promise<void> => {
    if (chapterId === selectedId) return;
    await editorRef.current?.flush();
    setStatus(EMPTY_STATUS);
    setEvidenceSelection(null);
    setSelectedId(chapterId);
  };

  // The drift review navigates here: select the chapter, or drop unsent text and reload it
  // from disk when the author kept the disk version. Runs once per request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chapterRequest is the trigger; the nonce ref keeps this to one run per request, and select is an inline helper with a stable purpose
  useEffect(() => {
    if (!chapterRequest || chapterRequest.bookId !== bookId) return;
    if (handledRequest.current === chapterRequest.nonce) return;
    handledRequest.current = chapterRequest.nonce;
    const { chapterId, revert } = chapterRequest;
    void (async () => {
      try {
        if (revert && chapterId) {
          await must(window.studio.drafts.clear(bookId, chapterId));
          clearEditorHistory(chapterId);
          await load(chapterId);
          setReloadKey((key) => key + 1);
        } else if (chapterId) {
          await select(chapterId);
        }
      } catch (error) {
        onNotice(error);
      } finally {
        onChapterRequestHandled?.();
      }
    })();
  }, [chapterRequest, bookId, load, onNotice, onChapterRequestHandled]);

  // A window reopened after a background turn opens the agent on that turn's conversation. Runs once
  // per request; once the author closes the panel, opening it again shows the newest conversation.
  useEffect(() => {
    if (!conversationRequest || conversationRequest.bookId !== bookId) return;
    if (handledConversation.current === conversationRequest.nonce) return;
    handledConversation.current = conversationRequest.nonce;
    setChatThreadId(conversationRequest.threadId);
    setChatOpen(true);
    onConversationRequestHandled?.();
  }, [conversationRequest, bookId, onConversationRequestHandled]);

  useEffect(() => {
    if (chatWasOpen.current && !chatOpen) setChatThreadId(null);
    chatWasOpen.current = chatOpen;
  }, [chatOpen]);

  const addChapter = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await editorRef.current?.flush();
      const chapter = await must(window.studio.chapters.create(bookId, {}));
      setDetail((current) =>
        current ? { ...current, chapters: [...current.chapters, chapter].sort((a, b) => a.order - b.order) } : current
      );
      setSelectedId(chapter.id);
      setStatus(EMPTY_STATUS);
    } catch (error) {
      onNotice(error);
    } finally {
      setBusy(false);
    }
  };

  /**
   * A move from the rail, the keyboard or a drag. It rewrites `order` in every chapter file it shifts,
   * the open one's included, without touching their words (QA D5). The newest words save first, and
   * the editor's saves wait while the move runs; the open chapter's new file then becomes the editor's
   * base, so the author's next words save normally and the caret, focus and undo stay. This is the
   * turn reload's rule below for a file whose front matter alone changed: no remount is needed.
   */
  const runMove = useCallback(
    async (chapter: Chapter, write: () => Promise<ReorderChapterResult>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      try {
        const editor = editorRef.current;
        await editor?.flush();
        const move = async (): Promise<void> => {
          const result = await write();
          if (result.status === "conflict") {
            onNotice(
              new Error(
                `The chapter order changed outside the studio. ${result.conflict.savedAs ? `Your version is in ${result.conflict.savedAs}.` : "Reopen the book and try again."}`
              )
            );
            // Putting the move back rewrote files too.
            const next = await load(chapter.id);
            if (next) editor?.rebase(next.chapters);
            return;
          }
          editor?.rebase(result.chapters);
          setDetail((current) => (current ? { ...current, chapters: result.chapters } : current));
          setSelectedId(chapter.id);
        };
        await (editor ? editor.hold(move) : move());
      } catch (error) {
        onNotice(error);
      } finally {
        setBusy(false);
      }
    },
    [busy, load, onNotice]
  );

  const moveChapter = useCallback(
    (chapter: Chapter, direction: "up" | "down") =>
      runMove(chapter, () => must(window.studio.chapters.reorder(bookId, chapter.id, direction))),
    [runMove, bookId]
  );

  const moveChapterTo = (chapter: Chapter, targetIndex: number): Promise<void> =>
    runMove(chapter, () => must(window.studio.chapters.move(bookId, chapter.id, targetIndex)));

  /**
   * Show the chapter as it is on disk: Refresh on the outside-change banner, and "Load the version on
   * disk" on the conflict banner. The flush comes first, so words typed since a conflict get their own
   * copy and the copies are listed after every write; words a copy already holds are not saved again.
   */
  const refreshFromDisk = async (): Promise<void> => {
    try {
      await editorRef.current?.flush();
      setExternalChange(null);
      // The disk version is the new baseline; undo must not jump back across an external edit.
      if (selectedId) clearEditorHistory(selectedId);
      await load(selectedId ?? undefined);
      // Remount after the new detail is in state; remounting first would seed the editor with the
      // old chapter and leave it there when the hash arrives.
      setReloadKey((key) => key + 1);
    } catch (error) {
      onNotice(error);
    }
  };

  /**
   * Put kept words back through the checked save. The editor saves its own text first, so kept words
   * for the open chapter land as a conflict copy rather than replacing what the author typed since;
   * then the workspace reloads what is on disk, as refreshFromDisk does. A failed restore keeps them.
   */
  const restoreRecovered = async (entry: RecoveredDraft): Promise<void> => {
    if (recovering) return;
    setRecovering(true);
    const title = detail?.chapters.find((chapter) => chapter.id === entry.chapterId)?.title.trim() || "the chapter";
    try {
      await editorRef.current?.flush();
      const result = await must(window.studio.recovery.restore(entry.id));
      clearEditorHistory(entry.chapterId);
      await load(result.status === "saved" ? entry.chapterId : (selectedId ?? undefined));
      setReloadKey((key) => key + 1);
      onNotice(
        result.status === "saved"
          ? `Your words are back in “${title}”.`
          : `“${title}” changed after you typed these words, so they were kept as a separate copy instead of replacing it.`
      );
    } catch (error) {
      onNotice(
        `Your words are still kept, because they could not be restored. ${plainSaveReason(error instanceof Error ? error.message : String(error))}`
      );
    } finally {
      await loadRecovered();
      setRecovering(false);
    }
  };

  /** Let kept words go, once the author has confirmed it in the panel. */
  const discardRecovered = async (entry: RecoveredDraft): Promise<void> => {
    if (recovering) return;
    setRecovering(true);
    try {
      await must(window.studio.recovery.discard(entry.id));
    } catch (error) {
      onNotice(error);
    } finally {
      await loadRecovered();
      setRecovering(false);
    }
  };

  /**
   * After an agent turn or its undo, from the chat or the ambient strip. The turn may have rewritten
   * the open chapter, and the library watcher stays quiet for the studio's own writes, so the
   * workspace reloads itself, with the editor's saves held. A file whose words and title are still the
   * editor's, such as one a move renumbered, becomes its base; then the author's unsaved words are
   * kept, saved against it. The editor remounts only when the file's words or title changed, and only
   * once the new text is in state, as refreshFromDisk does: remounting first would seed it with the old
   * chapter and its old hash. A turn that changed no words keeps the caret and the undo history.
   */
  const reloadAfterAgent = useCallback(async () => {
    const editor = editorRef.current;
    const reload = async (): Promise<Chapter | null> => {
      const next = await load(selectedId ?? undefined);
      const open = next?.chapters.find((chapter) => chapter.id === selectedId);
      return open && !editor?.rebase(next?.chapters ?? []) ? open : null;
    };
    const changed = await (editor ? editor.hold(reload) : reload());
    await editor?.flush();
    if (!changed) return;
    clearEditorHistory(changed.id);
    setReloadKey((key) => key + 1);
  }, [load, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!selected || busy) return;
      if (!(event.metaKey || event.ctrlKey) || !event.altKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void moveChapter(selected, event.key === "ArrowUp" ? "up" : "down");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, busy, moveChapter]);

  useEffect(() => () => window.clearTimeout(exportNoteTimer.current), []);

  /** Saves the open chapter, runs one export and names the written file for a few seconds. */
  const runExport = async (request: () => ReturnType<typeof window.studio.books.exportDocx>): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    try {
      // An export reads the saved files, so a chapter whose latest text did not save would leave the
      // author's newest words out without a word. Stop and say so instead.
      const flushed = await editorRef.current?.flush();
      if (flushed?.kind === "conflict" || flushed?.kind === "error") {
        onNotice(new Error(exportBlockedMessage(flushed)));
        return;
      }
      const path = await must(request());
      if (!path) return;
      const name = path.split(/[\\/]/).pop() ?? path;
      setExportNote(`Saved ${name}`);
      window.clearTimeout(exportNoteTimer.current);
      exportNoteTimer.current = window.setTimeout(() => setExportNote(null), 8000);
    } catch (error) {
      onNotice(error);
    } finally {
      setExporting(false);
    }
  };

  const exportDocx = (): Promise<void> => runExport(() => window.studio.books.exportDocx(bookId));
  const exportMarkdown = (): Promise<void> => runExport(() => window.studio.books.exportMarkdown(bookId));

  const saveFormatSettings = ({ patch, from }: FormatChange): Promise<void> => {
    // The book the author changed the setting in, which the save belongs to even if the workspace has
    // moved to another book by the time it runs.
    const originId = bookId;
    const run = async (): Promise<void> => {
      // Each save applies only the fields its control changed, to the book the one before it returned,
      // so a field changed outside meanwhile is not put back to what the dialog showed. Those fields
      // start from the value the author saw, not the returned one: if another writer changed the same
      // field, it is a clash and the author's choice becomes a copy.
      const base = latestBooks.current.get(originId);
      if (!base) return;
      try {
        // Merged with the settings as they are on disk, so an agent setting changed meanwhile is kept.
        const startedFrom = { ...base, settings: { ...base.settings, manuscript: { ...base.settings.manuscript, ...from } } };
        const manuscript = { ...base.settings.manuscript, ...patch };
        const result = await editBook(startedFrom, { settings: { ...base.settings, manuscript } });
        latestBooks.current.set(originId, result.book);
        // Only the book on screen changes on screen; another book's save leaves the one shown alone.
        setDetail((current) => (current && current.book.id === result.book.id ? { ...current, book: result.book } : current));
        if (result.status === "conflict") {
          // The author's version is on disk: list it so the saved-copies banner can show it.
          if (shownBookId.current === originId) await refreshConflicts();
          throw new Error(keptCopyText("The format settings"));
        }
      } catch (error) {
        onNotice(error);
        throw error;
      }
    };
    const next = formatSaves.current.then(run, run);
    formatSaves.current = next.catch(() => {});
    return next;
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete || busy) return;
    setBusy(true);
    try {
      await editorRef.current?.flush();
      await must(window.studio.chapters.delete(bookId, pendingDelete.id));
      clearEditorHistory(pendingDelete.id);
      const remaining = detail?.chapters.filter((chapter) => chapter.id !== pendingDelete.id) ?? [];
      setDetail((current) => (current ? { ...current, chapters: remaining } : current));
      if (selectedId === pendingDelete.id) setSelectedId(remaining[0]?.id ?? null);
      setPendingDelete(null);
      setStatus(EMPTY_STATUS);
    } catch (error) {
      onNotice(error);
    } finally {
      setBusy(false);
    }
  };

  const closeReview = useCallback(() => {
    setReviewOpen(false);
    setReviewView((current) =>
      current.kind === "report" || current.kind === "stopped" || current.kind === "failed"
        ? current
        : { kind: "choice" }
    );
  }, []);

  /**
   * Spec 034 T011–T014: read the current saved chapters and analyze them in memory, keeping the
   * report run-local. The read itself is cancellable: an abort before or during it lands the
   * stopped state instead of starting analysis. A changed source marks the report stale instead
   * of navigating to an unverified span.
   */
  const startAnalysis = useCallback(
    async () => {
      const requestedAt = new Date().toISOString();
      const controller = new AbortController();
      runController.current = controller;
      setReviewView({ kind: "running" });
      let snapshotDetail: BookDetail;
      try {
        snapshotDetail = await must(window.studio.books.open(bookId));
      } catch (error) {
        onNotice(error);
        setReviewView({
          kind: "failed",
          message: "The saved chapters could not be read. Your manuscript was not changed."
        });
        return;
      }
      if (controller.signal.aborted) {
        setReviewView({ kind: "stopped" });
        return;
      }
      setDetail(snapshotDetail);
      const snapshot = reviewSourceSnapshotFromBookDetail(snapshotDetail, requestedAt);
      // Sliced analysis yields between chunks, so Cancel stays clickable on long books and
      // an abort discards partial counts instead of finishing behind a blocked thread.
      const analysisOutcome = await analyzeReviewCoverageAsync(snapshot, controller.signal);
      if (analysisOutcome.status !== "complete" || controller.signal.aborted) {
        runController.current = null;
        setReviewView({ kind: "stopped" });
        return;
      }
      const analysis = analysisOutcome.value;
      if (analysis.status === "failed") {
        const failure = reviewNoSourceResult(snapshot.scope, requestedAt, analysis.coverage);
        setReviewView({ kind: "failed", message: failure.message });
        return;
      }
      const outcome = await runReviewWork({ requestedAt, source: snapshot }, controller.signal, async () =>
        buildReviewReport(snapshot, analysis, { requestedAt, completedAt: new Date().toISOString() })
      );
      runController.current = null;
      if (outcome.status === "complete") {
        setReviewView({ kind: "report", report: outcome.value, freshness: { status: "current" } });
      } else if (outcome.status === "cancelled") {
        setReviewView({ kind: "stopped" });
      } else {
        setReviewView({ kind: "failed", message: outcome.message });
      }
    },
    [bookId, onNotice]
  );

  /**
   * Spec 034 T006: a review reads only saved chapter text. The dialog offers the normal save
   * path or cancel; analysis starts only after a confirmed save and a fresh snapshot re-read.
   * Cancel leaves pending text untouched and never flushes.
   */
  const confirmReviewSave = useCallback(
    async (decision: "save" | "cancel", currentStatus: SaveStatus) => {
      if (decision === "cancel") {
        closeReview();
        return;
      }
      setReviewView({ kind: "saving" });
      try {
        // The gate confirms the save; the cancellable analysis reads its own fresh snapshot.
        const result = await runAfterReviewSave(
          currentStatus,
          decision,
          () => editorRef.current?.flush() ?? Promise.resolve(currentStatus),
          async () => {}
        );
        if (result.status === "ready") await startAnalysis();
        else if (result.status === "blocked") setReviewView({ kind: "blocked", saveStatus: result.saveStatus });
        else closeReview();
      } catch (error) {
        onNotice(error);
        closeReview();
      }
    },
    [onNotice, closeReview, startAnalysis]
  );

  const openReview = useCallback(() => {
    setReviewOpen(true);
    // Read the live buffer status: the mirrored state can lag a fast keystroke by an effect.
    const live = editorRef.current?.getStatus() ?? status;
    if (reviewView.kind === "report") {
      // The report is run-local; re-check it against the current saved chapters on every open.
      void (async () => {
        try {
          const fresh = await must(window.studio.books.open(bookId));
          setDetail(fresh);
          const snapshot = reviewSourceSnapshotFromBookDetail(fresh, new Date().toISOString());
          setReviewView({ kind: "report", report: reviewView.report, freshness: reviewReportFreshness(reviewView.report, snapshot) });
        } catch (error) {
          onNotice(error);
        }
      })();
      return;
    }
    // A clean buffer skips the choice and goes straight to the save confirmation.
    if (live.kind === "saved") void confirmReviewSave("save", live);
    else setReviewView({ kind: "choice" });
  }, [status, reviewView, bookId, onNotice, confirmReviewSave]);

  /** Start over the current saved chapters, keeping the previous report until the new run lands. */
  const runAgain = useCallback(() => {
    const live = editorRef.current?.getStatus() ?? status;
    if (live.kind === "saved") void confirmReviewSave("save", live);
    else setReviewView({ kind: "choice" });
  }, [status, confirmReviewSave]);

  const cancelRun = useCallback(() => {
    runController.current?.abort();
  }, []);

  /**
   * Spec 034 T012: open a finding's exact saved span only while the report is current. A
   * changed source marks the report stale instead of selecting a different passage.
   */
  const navigateToEvidence = useCallback(
    async (findingId: string, evidenceIndex: number) => {
      if (reviewView.kind !== "report") return;
      const current = reviewView.report;
      try {
        const fresh = await must(window.studio.books.open(bookId));
        setDetail(fresh);
        const snapshot = reviewSourceSnapshotFromBookDetail(fresh, new Date().toISOString());
        const navigation = revalidateReviewEvidence(current, snapshot, findingId, evidenceIndex);
        if (navigation.status === "ready") {
          setSelectedId(navigation.evidence.chapterId);
          setEvidenceSelection({
            chapterId: navigation.evidence.chapterId,
            start: navigation.evidence.startOffset,
            end: navigation.evidence.endOffset,
            nonce: Date.now()
          });
          setReviewOpen(false);
          return;
        }
        if (navigation.status === "stale") {
          setReviewView({ kind: "report", report: current, freshness: navigation });
          return;
        }
        onNotice(new Error("That passage is no longer available. Run the review again for current results."));
      } catch (error) {
        onNotice(error);
      }
    },
    [reviewView, bookId, onNotice]
  );

  const onSaved = useCallback((saved: Chapter) => {
    setDetail((current) =>
      current
        ? {
            ...current,
            chapters: current.chapters
              .map((chapter) => (chapter.id === saved.id ? saved : chapter))
              .sort((a, b) => a.order - b.order)
          }
        : current
    );
  }, []);

  const wordTotal = detail?.chapters.reduce((total, chapter) => total + chapter.wordCount, 0) ?? 0;
  const conflict = status.kind === "conflict" ? status.conflict : null;

  return (
    <div className="window-wash flex h-full flex-col" data-testid="workspace-view">
      <header className={`titlebar-drag flex h-14 shrink-0 items-center justify-between gap-3 pr-2 pl-3 min-[700px]:h-16 min-[700px]:gap-4 min-[700px]:pr-4 ${isMac ? "min-[700px]:pl-[92px]" : "min-[700px]:pl-5"}`}>
        <div className="flex min-w-0 items-center gap-1.5 min-[700px]:gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to library" title="Back to library" className="shrink-0">
            <ChevronLeft size={18} />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-(length:--text-headline-size) leading-tight font-semibold">{detail?.book.title || "Loading…"}</h1>
            <p className="tabular text-[11px] text-muted-foreground min-[700px]:text-(length:--text-caption-size)">
              {detail ? `${formatCount(detail.chapters.length)} ${pluralize(detail.chapters.length, "chapter")} · ${formatWords(wordTotal)}` : "Opening book…"}
            </p>
          </div>
        </div>

        <div className="titlebar-no-drag flex shrink-0 items-center gap-2">
          <span
            className="flex min-w-0 items-center gap-1.5 text-(length:--text-caption-size) text-muted-foreground"
            role="status"
            aria-label={statusLabel(status)}
            title={status.kind === "error" ? statusLabel(status) : undefined}
            data-testid="save-status"
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                status.kind === "saved"
                  ? "bg-[var(--success)]"
                  : status.kind === "conflict" || status.kind === "error"
                    ? "bg-[var(--destructive)]"
                    : "bg-[var(--warning)]"
              }`}
              aria-hidden
            />
            <span className="shrink-0 text-(length:--text-caption-2-size) min-[700px]:text-(length:--text-caption-size)">
              {compactStatus(status)}
            </span>
            {status.kind === "error" ? (
              // The reason the library gave; the full sentence, with the retry, is the status's label.
              <span
                className="max-w-[16ch] truncate text-(length:--text-caption-2-size) min-[700px]:max-w-[34ch] min-[700px]:text-(length:--text-caption-size)"
                data-testid="save-problem"
              >
                · {saveProblem(status.message)}
              </span>
            ) : null}
          </span>

          <div className="hidden items-center gap-2 min-[700px]:flex">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSearchOpen(true)}
              aria-label="Search the book"
              title="Search the book"
              data-testid="open-search"
            >
              <Search size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setBibleOpen(true)}
              aria-label="Story Bible"
              title="Story Bible"
              data-testid="open-story-bible"
            >
              <BookOpen size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIllustrationOpen(true)}
              aria-label="Illustration"
              title="Illustration"
              data-testid="open-illustration"
            >
              <ImageIcon size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={openReview}
              aria-label="Review manuscript"
              title="Review manuscript"
              data-testid="review-manuscript"
            >
              <FileSearch size={16} />
            </Button>
            {exportNote ? (
              <span className="max-w-[180px] truncate text-(length:--text-caption-size) text-muted-foreground" title={exportNote}>
                {exportNote}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setFormatOpen(true)}
              aria-label="Format book"
              title="Format book"
              data-testid="format-book"
            >
              <Type size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void exportDocx()}
              aria-label="Export Word document"
              title="Export Word document"
              data-testid="export-docx"
              disabled={exporting}
            >
              <Download size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void exportMarkdown()}
              aria-label="Export Markdown"
              title="Export Markdown"
              data-testid="export-markdown"
              disabled={exporting}
            >
              <FileText size={16} />
            </Button>
            <Button variant="ghost" size="icon" onClick={theme.cycle} aria-label={`Theme: ${theme.choice}`} title={`Theme: ${theme.choice}`}>
              {theme.choice === "light" ? <Sun size={16} /> : theme.choice === "dark" ? <Moon size={16} /> : <Monitor size={16} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => openSettings()}
              aria-label="Settings"
              title="Settings"
              data-testid="open-settings"
            >
              <Settings2 size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setChatOpen((open) => !open)}
              aria-label={chatOpen ? "Hide the writing agent" : "Show the writing agent"}
              title="Writing agent"
              data-testid="toggle-chat"
            >
              <MessageSquare size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAgentOpen(true)}
              aria-label="Agent settings"
              title="Agent settings"
              data-testid="open-agent"
            >
              <Bot size={16} />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openModelPicker("book")}
              title={
                detail?.book.defaultModelId
                  ? `${modelDisplayName(detail.book.defaultModelId)}. Choose the model for this book`
                  : "Choose the model for this book"
              }
              data-testid="open-model-picker"
            >
              <Cpu size={15} />
              <span className="max-w-[208px] truncate">{detail?.book.defaultModelId ? modelDisplayName(detail.book.defaultModelId) : "Choose a model"}</span>
            </Button>
          </div>
        </div>
      </header>

      {readIssues.length > 0 && !issuesDismissed ? (
        <p
          role="status"
          data-testid="chapter-read-issues"
          className="mx-3 mt-3 rounded-[var(--corner-md)] bg-[var(--secondary)] px-3 py-2 text-(length:--text-subheadline-size) text-muted-foreground min-[700px]:mx-4"
        >
          {readIssueCopy(readIssues)}{" "}
          <button
            type="button"
            onClick={() => setIssuesDismissed(true)}
            data-testid="dismiss-read-issues"
            className="font-medium text-foreground underline underline-offset-2"
          >
            Dismiss
          </button>
        </p>
      ) : null}

      <main className="relative flex min-h-0 flex-1 gap-3 px-3 pb-3 min-[700px]:gap-4 min-[700px]:px-4 min-[700px]:pb-4">
        <div className="hidden min-[700px]:flex">
          <ChapterRail
            chapters={detail?.chapters ?? []}
            selectedId={selectedId}
            busy={busy}
            onSelect={select}
            onAdd={addChapter}
            onMove={moveChapter}
            onMoveTo={moveChapterTo}
            onDelete={setPendingDelete}
          />
        </div>

        {railOpen ? (
          <div className="fixed inset-0 z-30 flex min-[700px]:hidden">
            <button
              type="button"
              className="absolute inset-0 bg-black/25 backdrop-blur-[2px]"
              aria-label="Close chapters"
              onClick={() => setRailOpen(false)}
            />
            <ChapterRail
              className="relative z-10 m-3 w-[280px]"
              chapters={detail?.chapters ?? []}
              selectedId={selectedId}
              busy={busy}
              onSelect={async (chapterId) => {
                await select(chapterId);
                setRailOpen(false);
              }}
              onAdd={addChapter}
              onMove={moveChapter}
              onMoveTo={moveChapterTo}
              onDelete={setPendingDelete}
              onClose={() => setRailOpen(false)}
            />
          </div>
        ) : null}

        <section className="thin-scroll min-w-0 flex-1 overflow-y-auto">
          <RecoveryPanel
            entries={recovered}
            chapters={detail?.chapters ?? []}
            busy={recovering}
            onRestore={(entry) => void restoreRecovered(entry)}
            onDiscard={(entry) => void discardRecovered(entry)}
          />

          {conflict ? (
            <div className="glass mb-4 rounded-[var(--corner-lg)] p-4">
              <p className="text-(length:--text-callout-size) font-semibold text-[var(--destructive-text)]">
                {conflict.reason === "placeholder" ? "This chapter is not downloaded yet" : "This chapter was saved somewhere else"}
              </p>
              <p className="mt-1 text-(length:--text-subheadline-size) leading-[var(--text-subheadline-leading)] text-muted-foreground">
                {conflict.reason === "placeholder"
                  ? "The file on disk could not be read. It may still be downloading, so your text was kept as a separate copy instead of overwriting it."
                  : conflict.reason === "external-edit"
                    ? "The file changed on disk while you were writing, so your text was kept as a separate copy instead of overwriting the change."
                    : "A newer version of this chapter exists on disk, so your text was kept as a separate copy instead of overwriting it."}
              </p>
              <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={conflict.savedAs}>
                {conflict.savedAs}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    void must(window.studio.conflicts.reveal(bookId, conflict.savedAs)).catch((error) => onNotice(error))
                  }
                >
                  Show the saved copy
                </Button>
                <Button variant="primary" size="sm" onClick={() => void refreshFromDisk()}>
                  Load the version on disk
                </Button>
              </div>
            </div>
          ) : null}

          {conflicts.length > 0 && !conflict ? (
            <div className="glass mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--corner-lg)] px-4 py-3">
              <p className="text-(length:--text-subheadline-size) text-muted-foreground">
                {formatCount(conflicts.length)} saved {pluralize(conflicts.length, "copy", "copies")} from earlier sync conflicts.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void must(window.studio.conflicts.reveal(bookId, conflicts[0]!.savedAs)).catch((error) => onNotice(error))}
              >
                Show in folder
              </Button>
            </div>
          ) : null}

          {externalChange ? (
            <div
              className="glass mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--corner-lg)] px-4 py-3"
              data-testid="external-change"
              role="status"
            >
              <div className="min-w-0">
                <p className="text-(length:--text-subheadline-size) font-medium">The library changed outside the studio</p>
                <p className="mt-0.5 truncate text-(length:--text-caption-size) text-muted-foreground" title={externalChange.paths.join(", ")}>
                  {externalChange.paths.length === 1
                    ? externalChange.paths[0]
                    : `${formatCount(externalChange.paths.length)} files changed`}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" size="sm" onClick={() => void refreshFromDisk()}>
                  Refresh
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setExternalChange(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          ) : null}

          {!detail ? (
            <div className="mx-auto w-full max-w-[760px] animate-pulse rounded-[var(--corner-xl)] bg-[var(--manuscript-bg)] p-14 shadow-[var(--elevation-2)]">
              <div className="h-6 w-1/3 rounded bg-[var(--secondary)]" />
              <div className="mt-10 space-y-3">
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <div key={n} className="h-4 rounded bg-[var(--secondary)]" style={{ width: `${88 - n * 6}%` }} />
                ))}
              </div>
            </div>
          ) : selected ? (
            <ManuscriptEditor
              key={`${selected.id}:${reloadKey}`}
              ref={editorRef}
              bookId={bookId}
              chapter={selected}
              ordinal={ordinal}
              onSaved={onSaved}
              onStatus={setStatus}
              illustration={illustration}
              illustrationData={illustrationData}
              voiceStatusRevision={voiceStatusRevision}
              selection={
                evidenceSelection && evidenceSelection.chapterId === selected.id
                  ? { start: evidenceSelection.start, end: evidenceSelection.end, nonce: evidenceSelection.nonce }
                  : null
              }
            />
          ) : (
            <div className="glass mx-auto mt-10 max-w-[520px] rounded-[var(--corner-xl)] px-8 py-12 text-center">
              <h2 className="text-(length:--text-title-3-size) font-semibold">An empty book</h2>
              <p className="mx-auto mt-2 max-w-[34ch] text-(length:--text-subheadline-size) leading-[var(--text-subheadline-leading)] text-muted-foreground">
                Add the first chapter and start writing. Each chapter is its own file in your library.
              </p>
              <Button variant="primary" className="mt-5" onClick={() => void addChapter()}>
                <Plus size={15} />
                Add chapter
              </Button>
            </div>
          )}
        </section>

        {chatOpen ? (
          <ChatPanel
            className="chat-sheet"
            bookId={bookId}
            chapterId={selectedId}
            openThreadId={chatThreadId}
            onClose={() => setChatOpen(false)}
            onBeforeSend={async () => {
              await editorRef.current?.flush();
            }}
            onReconnect={() => openSettings("providers")}
            onChooseModel={() => openModelPicker("book")}
            onChooseTurnModel={() => openModelPicker("turn")}
            turnModel={turnModel}
            onTurnModelUsed={() => setTurnModel(null)}
            onChanged={reloadAfterAgent}
            onConflictCopy={refreshConflicts}
            onNotice={onNotice}
          />
        ) : null}
      </main>

      <AmbientPanel
        bookId={bookId}
        chapterId={selected?.id ?? null}
        chapterTitle={selected?.title ?? ""}
        chapterContent={selected?.content ?? ""}
        voiceStatusRevision={voiceStatusRevision}
        onNextChapter={nextChapter}
        onChanged={reloadAfterAgent}
        onNotice={onNotice}
      />

      <nav
        className="glass mx-3 mb-3 flex items-center justify-around gap-2 rounded-[var(--corner-xl)] px-1.5 py-1.5 min-[700px]:hidden"
        aria-label="Workspace actions"
      >
        <MobileTab icon={List} label="Chapters" testid="mobile-chapters" onClick={() => setRailOpen(true)} />
        <MobileTab icon={Search} label="Search" testid="mobile-search" onClick={() => setSearchOpen(true)} />
        <MobileTab icon={MessageSquare} label="Agent" testid="mobile-agent" active={chatOpen} onClick={() => setChatOpen((open) => !open)} />
        <MobileTab icon={MoreHorizontal} label="More" testid="mobile-more" onClick={() => setMoreOpen(true)} />
      </nav>

      {detail ? (
        <ModelPickerDialog
          open={modelOpen}
          book={detail.book}
          initial={modelMode === "turn" ? turnModel : null}
          onPick={modelMode === "turn" ? (choice) => setTurnModel(choice) : undefined}
          onSaved={
            modelMode === "book"
              ? (book) => {
                  setTurnModel(null);
                  setDetail((current) => (current ? { ...current, book } : current));
                }
              : undefined
          }
          onClose={() => setModelOpen(false)}
          onConflictCopy={refreshConflicts}
          onOpenSettings={() => {
            setModelOpen(false);
            openSettings("providers");
          }}
        />
      ) : null}

      {detail ? (
        <>
          <SearchDialog
            open={searchOpen}
            bookId={bookId}
            onClose={() => setSearchOpen(false)}
            onOpenChapter={(chapterId) => {
              setSelectedId(chapterId);
              setSearchOpen(false);
            }}
          />
          <StoryBibleDialog
            open={bibleOpen}
            book={detail.book}
            onClose={() => setBibleOpen(false)}
            onSaved={(book) => setDetail((current) => (current ? { ...current, book } : current))}
            onConflictCopy={refreshConflicts}
            onNotice={onNotice}
          />
          <FormatDialog
            // One dialog per loaded book: its saved matter and waiting edits never cross to another.
            key={detail.book.id}
            open={formatOpen}
            onClose={() => setFormatOpen(false)}
            bookId={bookId}
            bookTitle={detail.book.title}
            book={detail.book}
            onBookSaved={(book) => setDetail((current) => (current?.book.id === book.id ? { ...current, book } : current))}
            onNotice={onNotice}
            settings={detail.book.settings.manuscript}
            chapters={detail.chapters}
            onSaveSettings={saveFormatSettings}
            onFlush={() => editorRef.current?.flush() ?? Promise.resolve(null)}
          />
        </>
      ) : null}

      <IllustrationDialog
        open={illustrationOpen}
        bookId={bookId}
        chapter={selected}
        onClose={() => setIllustrationOpen(false)}
        onChanged={() => loadIllustration(selectedId)}
        onOpenSettings={() => openSettings("providers")}
      />

      <AgentDialog
        open={agentOpen}
        bookId={bookId}
        onClose={() => setAgentOpen(false)}
        onNotice={onNotice}
      />

      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent title="More" description="Book tools, settings, and appearance.">
          <div className="grid gap-1">
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="more-settings"
              onClick={() => {
                setMoreOpen(false);
                openSettings();
              }}
            >
              <Settings2 size={16} />
              Settings
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="more-agent"
              onClick={() => {
                setMoreOpen(false);
                setAgentOpen(true);
              }}
            >
              <Bot size={16} />
              Agent
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="more-story-bible"
              onClick={() => {
                setMoreOpen(false);
                setBibleOpen(true);
              }}
            >
              <BookOpen size={16} />
              Story Bible
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="more-illustration"
              onClick={() => {
                setMoreOpen(false);
                setIllustrationOpen(true);
              }}
            >
              <ImageIcon size={16} />
              Illustration
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="more-search"
              onClick={() => {
                setMoreOpen(false);
                setSearchOpen(true);
              }}
            >
              <Search size={16} />
              Search the book
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="more-review"
              onClick={() => {
                setMoreOpen(false);
                openReview();
              }}
            >
              <FileSearch size={16} />
              Review manuscript
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              disabled={exporting}
              data-testid="more-export"
              onClick={() => {
                setMoreOpen(false);
                void exportDocx();
              }}
            >
              <Download size={16} />
              Export Word document
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              disabled={exporting}
              data-testid="more-export-markdown"
              onClick={() => {
                setMoreOpen(false);
                void exportMarkdown();
              }}
            >
              <FileText size={16} />
              Export Markdown
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="more-format"
              onClick={() => {
                setMoreOpen(false);
                setFormatOpen(true);
              }}
            >
              <Type size={16} />
              Format book
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="more-model-picker"
              onClick={() => {
                setMoreOpen(false);
                openModelPicker("book");
              }}
            >
              <Cpu size={16} />
              Choose a model
            </Button>
            <Button variant="ghost" className="justify-start" onClick={theme.cycle}>
              {theme.choice === "light" ? <Sun size={16} /> : theme.choice === "dark" ? <Moon size={16} /> : <Monitor size={16} />}
              Theme: {theme.choice}
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="more-back"
              onClick={() => {
                setMoreOpen(false);
                onBack();
              }}
            >
              <ChevronLeft size={16} />
              Back to library
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsSection(undefined);
        }}
        onNotice={onNotice}
        theme={theme}
        libraryRoot={libraryRoot}
        storage={libraryStorage}
        deviceName={deviceName}
        onCheckForChanges={onCheckForChanges}
        section={settingsSection}
        onVoiceConfigurationChanged={() => setVoiceStatusRevision((revision) => revision + 1)}
      />

      {reviewView.kind === "choice" || reviewView.kind === "saving" || reviewView.kind === "blocked" ? (
        <ReviewGateDialog
          open={reviewOpen}
          view={reviewView}
          onSave={() => void confirmReviewSave("save", editorRef.current?.getStatus() ?? status)}
          onCancel={() => void confirmReviewSave("cancel", editorRef.current?.getStatus() ?? status)}
          onClose={closeReview}
          onOpenChange={(open) => {
            if (!open) closeReview();
          }}
        />
      ) : (
        <ReviewReportDialog
          open={reviewOpen}
          view={reviewView}
          bookTitle={detail?.book.title || "Manuscript"}
          onCancelRun={cancelRun}
          onRunAgain={runAgain}
          onClose={closeReview}
          onNavigate={(findingId, evidenceIndex) => void navigateToEvidence(findingId, evidenceIndex)}
          onOpenChange={(open) => {
            if (!open) closeReview();
          }}
        />
      )}

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => (open ? undefined : setPendingDelete(null))}>
        <DialogContent
          title="Delete this chapter?"
          description="The chapter file moves to the library's trash folder. You can bring it back by moving it into the chapters folder again."
        >
          <p className="rounded-[var(--corner-md)] bg-[var(--secondary)] px-3 py-2 text-(length:--text-subheadline-size)">
            {pendingDelete?.title || "Untitled chapter"}
            <span className="tabular text-muted-foreground"> · {formatWords(pendingDelete?.wordCount ?? 0)}</span>
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Keep chapter
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void confirmDelete()}>
              Delete chapter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MobileTab({
  icon: Icon,
  label,
  onClick,
  active = false,
  testid
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  testid?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testid}
      className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-[var(--corner-md)] px-1 py-1.5 text-[10px] font-medium transition-colors duration-[var(--duration-fast)] ${
        active ? "bg-[var(--rail-item-selected)] text-[var(--primary)]" : "text-muted-foreground hover:bg-[var(--accent)]"
      }`}
    >
      <Icon size={19} />
      <span className="truncate">{label}</span>
    </button>
  );
}
