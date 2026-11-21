import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Download, Trash2 } from "lucide-react";
import type {
  ManuscriptExportOutcome,
  MarkdownFolderCaptureResult,
  MarkdownFolderWarningView,
  Result
} from "@ai-book-studio/core/ipc";
import { validateMarkdownFolderName } from "@ai-book-studio/core/markdown-folder/name";
import {
  MATTER_KINDS,
  MATTER_LIMITS,
  MATTER_STYLE,
  NO_MATTER,
  convertLegacyMatter,
  isEmptyMatter,
  kindLabel,
  kindPosition,
  matterHash,
  matterPlan,
  matterTemplate,
  newMatterSection,
  orderSections,
  pendingLegacyMatter,
  readMatter,
  sectionName,
  type BookMatter,
  type LegacyEntry,
  type MatterKind,
  type MatterSection
} from "@ai-book-studio/core/matter";
import type { BookMeta, Chapter, ManuscriptSettings } from "@ai-book-studio/core/schema";
import { Button } from "@ai-book-studio/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@ai-book-studio/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@ai-book-studio/ui/components/native-select";
import { Textarea } from "@ai-book-studio/ui/components/textarea";
import { exportBlockedMessage, exportReceipt, isCancelledOutcome } from "../lib/export-save";
import { must } from "../lib/utils";
import type { SaveStatus } from "./ManuscriptEditor";

/**
 * The Format journey (spec 035). A local approximate preview bound to
 * `settings.manuscript` as the single canonical source: every control reads
 * and writes the saved settings, nothing duplicates them, and the preview
 * never calls a provider or writes chapters. Export saves the open chapter,
 * then writes the chosen target through the main process (D-108); the
 * workspace header keeps its own Word and Markdown buttons. The front and
 * back matter (D-169) is edited here and saves itself shortly after each
 * change, with the version and hash of the matter it started from.
 */
export type FormatTarget = "DOCX" | "PDF" | "EPUB" | "Markdown" | "Markdown folder";

const TARGETS: FormatTarget[] = ["DOCX", "PDF", "EPUB", "Markdown", "Markdown folder"];

/** What each target is called on its Export button, and what it does with the settings below. */
const TARGET_COPY: Record<FormatTarget, { name: string; note: string }> = {
  DOCX: { name: "Word document", note: "Uses the typography below. Word export does not add a table of contents yet." },
  PDF: { name: "PDF", note: "A4 pages with a title page and each chapter on a new page, in the typography below." },
  EPUB: { name: "EPUB", note: "An EPUB 3 e-book with one file per chapter. E-readers may change the font and size." },
  Markdown: { name: "Markdown", note: "Plain text with chapter headings. The typography below does not apply." },
  "Markdown folder": {
    name: "Markdown folder",
    note: "A folder of Markdown files in book order, with copied images. The typography below does not apply. Creates a new folder. An existing folder is not replaced."
  }
};

type SingleFileTarget = Exclude<FormatTarget, "Markdown folder">;

const EXPORTS: Record<
  SingleFileTarget,
  (bookId: string, attemptId: string) => Promise<Result<ManuscriptExportOutcome | null>>
> = {
  DOCX: (bookId, attemptId) => window.studio.books.exportDocx(bookId, attemptId),
  PDF: (bookId, attemptId) => window.studio.books.exportPdf(bookId, attemptId),
  EPUB: (bookId, attemptId) => window.studio.books.exportEpub(bookId, attemptId),
  Markdown: (bookId, attemptId) => window.studio.books.exportMarkdown(bookId, attemptId)
};

type ReadyFolderCapture = Extract<MarkdownFolderCaptureResult, { status: "ready" }>;

type FolderPhase =
  | { kind: "idle" }
  | { kind: "capturing" }
  | { kind: "consent"; capture: ReadyFolderCapture; superseded: boolean }
  | { kind: "publishing"; capture: ReadyFolderCapture }
  | {
      kind: "published";
      capture: ReadyFolderCapture;
      destinationPath: string;
      files: string[];
      warnings: MarkdownFolderWarningView[];
      cleanupLeftover?: { name: string; path: string };
    }
  | { kind: "cancelled"; message: string }
  | { kind: "unknown"; message: string; destinationPath: string | null }
  | { kind: "error"; message: string };

function folderWarningText(warning: MarkdownFolderWarningView, chapters: Chapter[]): string {
  if (warning.kind === "list") return "The image list could not be read, so attached images were not included.";
  const chapter = chapters.find((item) => item.id === warning.chapterId);
  const where = chapter ? `Chapter ${chapter.order}: ${chapter.title}` : "a chapter";
  const position = warning.selectedPosition ? `, image ${warning.selectedPosition}` : "";
  if (warning.code === "image-missing") return `An attached image was missing and was not included (${where}${position}).`;
  if (warning.code === "image-unreadable") return `An attached image could not be read and was not included (${where}${position}).`;
  return `An attached image did not match its record and was not included (${where}${position}).`;
}

function legacyReasonText(reason: ReadyFolderCapture["excludedLegacy"][number]["reason"]): string {
  if (reason === "title-page-off") return "The title page is off, so this value has nowhere to appear.";
  if (reason === "projected-value-not-emitted") return "The title page value it could match was not included.";
  return "No included section or title page value matches it.";
}



type ExportNote =
  | { kind: "saved"; message: string; path: string; warnings: string[]; target: string }
  | { kind: "error"; message: string }
  | { kind: "cancelled"; message: string }
  | { kind: "status"; message: string };

const LINE_HEIGHT: Record<ManuscriptSettings["lineSpacing"], number> = {
  Single: 1,
  "1.15": 1.15,
  "1.5": 1.5,
  Double: 2
};

const FONT_FALLBACK: Record<string, string> = {
  "Courier New": "monospace",
  Arial: "sans-serif",
  Helvetica: "sans-serif",
  Calibri: "sans-serif"
};

const SIDES = { front: "Front matter", back: "Back matter" } as const;
// The studio's own field, as in the Story Bible: packages/ui has no shadcn Input yet.
const FIELD =
  "h-9 w-full rounded-[var(--corner-md)] bg-card px-3 text-(length:--text-body-size) shadow-[inset_0_0_0_1px_var(--input-border),var(--elevation-1)] outline-none focus:shadow-[inset_0_0_0_2px_var(--input-focus)]";
const LABEL = "flex flex-col gap-1 text-(length:--text-body-size)";
const CHOICE = "flex items-center gap-1.5 text-(length:--text-body-size)";
const LEGEND = "text-(length:--text-callout-size) font-medium";
const SMALL = "text-(length:--text-subheadline-size)";
const ALERT = `${SMALL} text-[var(--destructive-text)]`;
const BOX = "space-y-2 rounded-[var(--corner-lg)] border border-border p-3";

const newId = (): string => `mat_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** Where an entry of the older record goes when the author adds it. */
function destination({ target }: LegacyEntry): string {
  if (target === "author" || target === "subtitle") return `title page ${target}`;
  return target ? `${kindLabel(target)}, ${kindPosition(target)} matter` : "not placed; copy it in by hand";
}

/**
 * One control change: the fields it sets, and the value each had when the author changed it (the
 * saved value, or an earlier change of the same control that is still waiting to save). The save
 * applies `patch` and treats `from` as the settings the author started from, so another writer's
 * change to the same field meanwhile is a clash and not something to write over.
 */
export interface FormatChange {
  patch: Partial<ManuscriptSettings>;
  from: Partial<ManuscriptSettings>;
}

interface FormatDialogProps {
  open: boolean;
  onClose: () => void;
  bookId: string;
  bookTitle: string;
  /** The saved book, for its matter, its older front matter record and its description. */
  book: BookMeta;
  /** The book after a matter save, with the matter that is now on disk. */
  onBookSaved: (book: BookMeta) => void;
  /** Says why a save made after the dialog closed did not land. */
  onNotice: (error: unknown) => void;
  /** Last saved settings. The dialog reverts to these when a write fails. */
  settings: ManuscriptSettings;
  /** Saved chapter text. The dialog never edits or writes chapters. */
  chapters: Chapter[];
  /** Persists one manuscript change; rejects when the write fails. */
  onSaveSettings: (change: FormatChange) => Promise<void>;
  /** Saves the open chapter before an export; null when no chapter is open. */
  onFlush: () => Promise<SaveStatus | null>;
  /** Gives the header the same format/matter save preflight even after this dialog closes. */
  onExportPreflight?: (check: () => Promise<void>) => () => void;
}

export const FORMAT_LABELS: Record<string, string> = {
  bodyFont: "Font",
  bodyFontSize: "Size",
  firstLineIndent: "First-line indent",
  lineSpacing: "Line spacing",
  chapterTitleAlignment: "Chapter titles",
  includeTableOfContents: "Table of contents",
  preserveLineBreaks: "Keep line breaks"
};

export function FormatDialog({
  open,
  onClose,
  bookId,
  bookTitle,
  book,
  onBookSaved,
  onNotice,
  settings,
  chapters,
  onSaveSettings,
  onFlush,
  onExportPreflight
}: FormatDialogProps) {
  const [target, setTarget] = useState<FormatTarget>("DOCX");
  const [draft, setDraft] = useState<ManuscriptSettings>(settings);
  const settingsOut = useRef(0);
  const settingsFailures = useRef(new Map<string, string>());
  const [answered, setAnswered] = useState(0);
  const [exporting, setExporting] = useState(false);
  const exportPending = useRef(false);
  const exportGeneration = useRef(0);
  const shownBookId = useRef(bookId);
  shownBookId.current = bookId;
  const [note, setNote] = useState<ExportNote | null>(null);
  const [folder, setFolder] = useState<FolderPhase>({ kind: "idle" });
  const folderPending = useRef<string | null>(null);
  const [folderCancelling, setFolderCancelling] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const singleAttemptId = useRef<string | null>(null);
  const [singleAttemptActive, setSingleAttemptActive] = useState(false);
  const [exportCancelling, setExportCancelling] = useState(false);
  const [matter, setMatter] = useState<BookMatter | null>(() => readMatter(book).matter);
  const [kind, setKind] = useState<MatterKind>("copyright");
  const [removing, setRemoving] = useState<string | null>(null);
  const [matterError, setMatterError] = useState<string | null>(null);
  const matterFailure = useRef<string | null>(null);
  // The matter as saved (the base of the next save), the latest edit (ahead of the render that
  // shows it, so two quick changes both land), the change waiting to be saved, and the save chain.
  const savedMatter = useRef<BookMatter | null>(matter);
  const latest = useRef<BookMatter | null>(matter);
  // Whether a save has gone out, so emptying the matter again is saved too.
  const sent = useRef(false);
  // Where the author's version went after the last conflict.
  const copy = useRef<string | null>(null);
  const pending = useRef<BookMatter | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<boolean>>(Promise.resolve(true));
  const focusAfter = useRef<string | null>(null);
  const isOpen = useRef(open);
  isOpen.current = open;
  // Exports write files through the main process, which the browser build does not have.
  const canExport = window.studio.platform !== "web";
  const unreadable = readMatter(book).issue;
  const current = matter ?? NO_MATTER;
  const plan = matterPlan(book, matter);
  const legacy = unreadable ? [] : pendingLegacyMatter(book.frontMatter, matter);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each dialog/book visit owns its export continuation
  useEffect(() => {
    exportGeneration.current++;
    exportPending.current = false;
    setExporting(false);
    setNote(null);
    setFolder({ kind: "idle" });
    folderPending.current = null;
    setFolderCancelling(false);
    setFolderName("");
    setFolderNotice(null);
    singleAttemptId.current = null;
    setSingleAttemptActive(false);
    setExportCancelling(false);
    return () => { exportGeneration.current++; };
  }, [open, bookId]);

  // Only the draft follows saved settings while open.
  // While a save is out the draft keeps what the author chose, so the next change to the same control
  // starts from the author's own earlier choice and not from an older acknowledgement; once every save
  // is answered the draft follows the saved settings again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answered` only makes this run again when a save is answered
  useEffect(() => {
    if (settingsOut.current === 0) setDraft(settings);
  }, [settings, answered]);

  // The target and the last export's note are this visit's alone: every open starts at DOCX. The
  // matter is read from the saved book on open, and a change still waiting is saved on close.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening is the trigger; following the book while open would drop the author's unsaved typing
  useEffect(() => {
    if (!open) {
      setTarget("DOCX");
      setNote(null);
      void persist();
      return;
    }
    setRemoving(null);
    // After any save still running from the last visit, the newer of the book's matter and the
    // matter that save wrote; an unsaved change, or one typed meanwhile, stays as it is.
    void saving.current.then(() => {
      if (pending.current) return;
      const fromBook = readMatter(book).matter;
      if ((fromBook?.version ?? 0) >= (savedMatter.current?.version ?? 0)) savedMatter.current = fromBook;
      show(savedMatter.current);
    });
  }, [open]);

  // Leaving the book saves a change that is still waiting, and the workspace says if that fails.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on unmount
  useEffect(
    () => () => {
      isOpen.current = false;
      void persist();
    },
    []
  );

  // A keyboard move keeps focus on the moved section's button, or its other one at an end; asking
  // to remove a section moves focus to Keep section, and keeping it returns focus to Remove.
  useEffect(() => {
    const wanted = focusAfter.current;
    focusAfter.current = null;
    if (!wanted) return;
    const button = (selector: string) => document.querySelector<HTMLElement>(`[data-move${selector}]:not([disabled])`);
    (button(`="${wanted}"`) ?? button(`^="${wanted.split(":")[0]}:"`))?.focus();
  });

  const change = (patch: Partial<ManuscriptSettings>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    // Only the fields this change touched are sent, each with the value the author started from, so a
    // save waiting its turn neither carries a stale value for another field nor forgets which value
    // of this one the author was looking at.
    const from = Object.fromEntries(Object.keys(patch).map((key) => [key, draft[key as keyof ManuscriptSettings]]));
    settingsOut.current += 1;
    onSaveSettings({ patch, from: from as Partial<ManuscriptSettings> })
      .then(() => {
        for (const key of Object.keys(patch)) settingsFailures.current.delete(key);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        for (const key of Object.keys(patch)) settingsFailures.current.set(key, message);
        setNote({ kind: "error", message: `The format settings could not be saved. ${message}` });
      })
      .finally(() => {
        settingsOut.current -= 1;
        setAnswered((count) => count + 1);
      });
  };

  /** Shows why the matter did not save; after the dialog has closed, the workspace says it too. */
  const fail = (message: string, savedAs: string | null = null): void => {
    copy.current = savedAs;
    matterFailure.current = message;
    setMatterError(message);
    if (!isOpen.current) onNotice(new Error(message));
  };

  /** Saves the waiting change, after any save already running. True when nothing is left unsaved. */
  const persist = (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    saving.current = saving.current.then(async () => {
      const next = pending.current;
      if (!next) return matterFailure.current === null;
      pending.current = null;
      sent.current = true;
      const base = savedMatter.current;
      try {
        const result = await must(
          window.studio.books.saveMatter({ bookId: book.id, matter: next, baseVersion: base?.version ?? 0, baseHash: await matterHash(base) })
        );
        savedMatter.current = readMatter(result.book).matter;
        onBookSaved(result.book);
        if (result.status === "saved") {
          matterFailure.current = null;
          copy.current = null;
          setMatterError(null);
          return true;
        }
        pending.current = null;
        show(savedMatter.current);
        fail(`The front and back matter changed elsewhere. Your version is kept in ${result.savedAs}.`, result.savedAs);
      } catch (error) {
        pending.current ??= next;
        fail(error instanceof Error ? error.message : String(error));
      }
      return false;
    });
    return saving.current;
  };

  const show = (next: BookMatter | null): void => {
    latest.current = next;
    setMatter(next);
  };

  /** Applies a change to the latest matter and saves it shortly after the author stops. */
  const edit = (change: (from: BookMatter) => BookMatter): void => {
    const next = change(latest.current ?? NO_MATTER);
    show(next);
    setRemoving(null);
    if (timer.current) clearTimeout(timer.current);
    // A book without matter gets none until something in it would change an export.
    pending.current = !savedMatter.current && !sent.current && isEmptyMatter(next) ? null : next;
    if (pending.current) timer.current = setTimeout(() => void persist(), 500);
  };

  const update = (id: string, patch: Partial<MatterSection>): void =>
    edit((from) => ({ ...from, sections: from.sections.map((section) => (section.id === id ? { ...section, ...patch } : section)) }));

  /**
   * Swaps a section with its neighbour on the same side. At the edge of a side it crosses the
   * chapters instead: the last front section moves down to the top of the back matter.
   */
  const move = (id: string, step: -1 | 1): void => {
    focusAfter.current = `${id}:${step < 0 ? "up" : "down"}`;
    edit((matter) => {
      const sections = orderSections(matter.sections);
      const from = sections.findIndex((section) => section.id === id);
      const [a, b] = [sections[from], sections[from + step]];
      if (a && b?.position === a.position) [sections[from], sections[from + step]] = [b, a];
      else if (a) sections[from] = { ...a, position: step < 0 ? "front" : "back" };
      return { ...matter, sections };
    });
  };

  const prepareExport = async (): Promise<void> => {
    if (settingsOut.current > 0 || settingsFailures.current.size > 0) {
      const reason = settingsOut.current > 0
        ? "Wait for the format settings to finish saving, then export again."
        : `The format settings could not be saved. ${[...new Set(settingsFailures.current.values())].join(" ")} Change the affected setting to save it again.`;
      throw new Error(`Nothing was exported. ${reason}`);
    }
    if (!(await persist())) throw new Error("The front and back matter could not be saved, so nothing was exported.");
  };

  // The preflight reads live refs. It belongs to this book's dialog, including when closed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: prepareExport reads refs, never a captured save outcome
  useEffect(() => onExportPreflight?.(prepareExport), [onExportPreflight]);

  /** Collect the saved book for a Markdown folder and show the consent bound to that collection. */
  const startFolderCapture = async (): Promise<void> => {
    if (exportPending.current || !canExport || !open) return;
    const generation = ++exportGeneration.current;
    const originId = bookId;
    const currentExport = () => exportGeneration.current === generation && isOpen.current && shownBookId.current === originId;
    const hadPending = folderPending.current;
    exportPending.current = true;
    setExporting(true);
    setNote(null);
    setFolderCancelling(false);
    setFolderNotice(null);
    setFolder({ kind: "capturing" });
    try {
      await prepareExport();
      if (!currentExport()) return;
      let saved: SaveStatus | null;
      try {
        saved = await onFlush();
      } catch {
        saved = { kind: "error", message: "The chapter could not be saved." };
      }
      if (!currentExport()) return;
      if (saved && saved.kind !== "saved") {
        setFolder({ kind: "error", message: exportBlockedMessage(saved) });
        return;
      }
      const capture = await must(window.studio.books.exportMarkdownFolderCapture(bookId));
      if (!currentExport()) return;
      if (capture.status === "refused") {
        folderPending.current = null;
        const detail = capture.dimension ? ` (${capture.dimension})` : "";
        setFolder({ kind: "error", message: `Nothing was exported. The collection was refused${detail}. ${capture.message}` });
        return;
      }
      const superseded = hadPending !== null && hadPending !== capture.attemptId;
      folderPending.current = capture.attemptId;
      setFolderName(capture.suggestedFolderName);
      setFolderNotice(null);
      setFolder({ kind: "consent", capture, superseded });
    } catch (error) {
      if (currentExport()) setFolder({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (currentExport()) {
        exportPending.current = false;
        setExporting(false);
      }
    }
  };

  /** Publish the consented collection. A cancelled picker returns to the same consent with nothing written. */
  const publishFolder = async (capture: ReadyFolderCapture): Promise<void> => {
    if (exportPending.current || !open) return;
    const validated = validateMarkdownFolderName(folderName.trim() ? folderName : capture.suggestedFolderName);
    if (!validated.ok) {
      setFolderNotice(validated.message);
      setFolder({ kind: "consent", capture, superseded: false });
      return;
    }
    const generation = ++exportGeneration.current;
    const originId = bookId;
    const currentExport = () => exportGeneration.current === generation && isOpen.current && shownBookId.current === originId;
    exportPending.current = true;
    setExporting(true);
    setFolderCancelling(false);
    setFolderNotice(null);
    setFolder({ kind: "publishing", capture });
    try {
      const outcome = await must(
        window.studio.books.exportMarkdownFolderPublish({
          bookId,
          attemptId: capture.attemptId,
          folderName: validated.name
        })
      );
      if (!currentExport()) return;
      if (outcome === null) {
        setFolder({ kind: "consent", capture, superseded: false });
        return;
      }
      if (outcome.status === "published") {
        folderPending.current = null;
        setFolder({
          kind: "published",
          capture,
          destinationPath: outcome.destinationPath,
          files: outcome.files,
          warnings: outcome.warnings,
          ...(outcome.cleanupLeftover ? { cleanupLeftover: outcome.cleanupLeftover } : {})
        });
      } else if (outcome.status === "cancelled") {
        folderPending.current = null;
        setFolder({ kind: "cancelled", message: outcome.message });
      } else if (outcome.status === "name-conflict" || outcome.status === "name-invalid") {
        setFolderNotice(outcome.message);
        setFolder({ kind: "consent", capture, superseded: false });
      } else {
        folderPending.current = null;
        setFolder({ kind: "unknown", message: outcome.message, destinationPath: outcome.destinationPath });
      }
    } catch (error) {
      if (currentExport()) setFolder({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (currentExport()) {
        exportPending.current = false;
        setExporting(false);
      }
    }
  };

  /** Cancel the consented collection before any destination is chosen. Nothing is published. */
  const cancelFolderConsent = async (capture: ReadyFolderCapture): Promise<void> => {
    try {
      const result = await must(window.studio.books.exportMarkdownFolderCancel({ bookId, attemptId: capture.attemptId }));
      folderPending.current = null;
      if (result.status === "too-late") {
        setFolder({
          kind: "unknown",
          message:
            "Cancellation arrived after publication began. The export is finishing; it will report whether the folder was published.",
          destinationPath: null
        });
        return;
      }
      setFolder({ kind: "cancelled", message: "The Markdown folder export was cancelled. Nothing was published." });
    } catch (error) {
      setFolder({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  /** Ask to stop a publishing folder before its commit begins. The publish reply settles the outcome. */
  const cancelFolderPublishing = async (capture: ReadyFolderCapture): Promise<void> => {
    setFolderCancelling(true);
    try {
      const reply = await must(window.studio.books.exportMarkdownFolderCancel({ bookId, attemptId: capture.attemptId }));
      if (reply.status === "too-late") {
        setFolderNotice(
          "Cancellation arrived after publication began. The export is finishing; it will report whether the folder was published."
        );
      }
    } catch {
      // The publish reply that is still in flight reports the real settlement.
    }
  };

  const runExport = async (): Promise<void> => {
    if (target === "Markdown folder") return startFolderCapture();
    if (exportPending.current || !canExport || !open) return;
    const generation = ++exportGeneration.current;
    const originId = bookId;
    const currentExport = () => exportGeneration.current === generation && isOpen.current && shownBookId.current === originId;
    exportPending.current = true;
    setExporting(true);
    setNote(null);
    setSingleAttemptActive(false);
    setExportCancelling(false);
    const attemptId = crypto.randomUUID();
    singleAttemptId.current = attemptId;
    try {
      await prepareExport();
      if (!currentExport()) return;
      let saved: SaveStatus | null;
      try {
        saved = await onFlush();
      } catch {
        saved = { kind: "error", message: "The chapter could not be saved." };
      }
      if (!currentExport()) return;
      if (saved && saved.kind !== "saved") {
        setNote({ kind: "error", message: exportBlockedMessage(saved) });
        return;
      }
      setSingleAttemptActive(true);
      const outcome = await must(EXPORTS[target as SingleFileTarget](bookId, attemptId));
      if (!currentExport()) return;
      if (isCancelledOutcome(outcome)) {
        setNote({ kind: "cancelled", message: outcome.message });
        return;
      }
      const receipt = exportReceipt(outcome);
      // A cancelled picker or a declined replacement wrote nothing, so there is nothing to say.
      if (receipt) setNote({ kind: "saved", message: `Saved ${receipt.path.split(/[\\/]/).pop() ?? receipt.path}`, ...receipt, target: TARGET_COPY[target].name });
    } catch (error) {
      if (currentExport()) setNote({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (currentExport()) {
        exportPending.current = false;
        singleAttemptId.current = null;
        setSingleAttemptActive(false);
        setExportCancelling(false);
        setExporting(false);
      }
    }
  };

  /** Ask the main process to stop this single-file export before publication. */
  const cancelSingleExport = async (): Promise<void> => {
    const attemptId = singleAttemptId.current;
    if (!attemptId || exportCancelling) return;
    setExportCancelling(true);
    try {
      const reply = await must(window.studio.books.exportCancel({ bookId, attemptId }));
      if (reply.status === "too-late") {
        setNote({
          kind: "status",
          message:
            "Cancellation arrived after publication began. The export is finishing; it will report whether the file was published."
        });
      }
    } catch (error) {
      // A failed cancel request claims nothing; the export reply settles the real outcome.
      setNote({ kind: "status", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const field = (label: string, value: string, max: number, onChange: (value: string) => void) => (
    <label className={`${LABEL} min-w-40 flex-1`}>
      {label}
      <input className={FIELD} value={value} maxLength={max} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
  const iconButton = (label: string, icon: ReactNode, onClick: () => void, disabled = false, moves?: string) => (
    <Button variant="ghost" size="icon-sm" aria-label={label} data-move={moves} disabled={disabled} onClick={onClick}>
      {icon}
    </Button>
  );
  const align = draft.chapterTitleAlignment === "Center" ? "center" : "left";
  /** A chapter or a section as the exports set it: its heading, then a paragraph per line. */
  const page = (id: string, title: string, text: string, style?: "centered" | "plain") => (
    <section key={id}>
      {title.trim() ? <h2 style={{ textAlign: style === "centered" ? "center" : align }}>{title}</h2> : null}
      {text.split("\n").map((line, index) => (
        <p
          // biome-ignore lint/suspicious/noArrayIndexKey: body lines have no stable identity; the chapter or section id scopes the index
          key={`${id}-${index}`}
          style={{
            textIndent: style || draft.firstLineIndent === 0 ? undefined : `${draft.firstLineIndent}in`,
            whiteSpace: draft.preserveLineBreaks ? "pre-wrap" : "normal",
            textAlign: style === "centered" ? "center" : undefined
          }}
        >
          {line === "" ? "\u00a0" : line}
        </p>
      ))}
    </section>
  );
  const section = (item: MatterSection) => page(item.id, item.title, item.text, MATTER_STYLE[item.kind]);
  const effectiveFolderName =
    folder.kind === "consent" || folder.kind === "publishing"
      ? (folderName.trim() ? folderName : folder.capture.suggestedFolderName)
      : folderName;
  const folderNameCheck = folder.kind === "consent" ? validateMarkdownFolderName(effectiveFolderName) : null;

  return (
    // The dialog stays open while an export runs, so its outcome is never shown to a closed dialog.
    <Dialog open={open} onOpenChange={(next) => !next && !exporting && onClose()}>
      <DialogContent
        title="Format"
        description={`Typography, preview and export for ${bookTitle}. An export is a copy; the book's own files do not change.`}
        className="w-[720px]"
        footer={
          <DialogFooter className="mt-0 justify-between gap-3">
            <div className="min-w-0 text-(length:--text-subheadline-size) leading-[var(--text-subheadline-leading)]">
              <p role="status" data-testid="format-export-note" className="truncate" title={note?.kind === "saved" ? note.path : undefined}>
                {canExport ? (note?.kind === "saved" ? note.message : "") : "Exporting is available in the desktop app."}
              </p>
              {note?.kind === "saved" ? (
                <div className="break-words" data-testid="format-export-details">
                  <p>{note.target} · Saved version captured when export began · {note.path}</p>
                  {note.warnings.length > 0 ? <ul role="status" aria-label="Export warnings" className="list-disc pl-4">
                    {[...new Set(note.warnings)].map((warning) => <li key={warning}>{warning}</li>)}
                  </ul> : null}
                </div>
              ) : null}
              {note?.kind === "error" ? (
                <p role="alert" data-testid="format-export-error" className="text-[var(--destructive-text)]">
                  {note.message}
                </p>
              ) : null}
              {note?.kind === "cancelled" ? (
                <p role="status" data-testid="format-export-cancelled">
                  {note.message}
                </p>
              ) : null}
              {note?.kind === "status" ? (
                <p role="status" data-testid="format-export-status">
                  {note.message}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {target !== "Markdown folder" && singleAttemptActive ? (
                <Button
                  data-testid="format-export-cancel"
                  disabled={exportCancelling}
                  onClick={() => void cancelSingleExport()}
                >
                  {exportCancelling ? "Cancelling…" : "Cancel export"}
                </Button>
              ) : null}
              <Button
                variant="primary"
                className="shrink-0"
                onClick={() => void runExport()}
                disabled={!canExport || exporting}
                data-testid="format-export"
              >
                <Download size={15} />
                {exporting ? "Exporting…" : `Export ${TARGET_COPY[target].name}`}
              </Button>
            </div>
          </DialogFooter>
        }
      >
        <div className="space-y-6">
          <fieldset disabled={exporting}>
            <legend className={LEGEND}>Target</legend>
            <div className="mt-2 flex flex-wrap gap-4" role="radiogroup" aria-label="Output target">
              {TARGETS.map((option) => (
                <label key={option} className={CHOICE}>
                  <input
                    type="radio"
                    name="format-target"
                    value={option}
                    checked={target === option}
                    disabled={exporting}
                    onChange={() => setTarget(option)}
                  />
                  {option}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-(length:--text-caption-size) text-muted-foreground" data-testid="format-target-note">
              {TARGET_COPY[target].note}
            </p>
          </fieldset>

          {target === "Markdown folder" ? (
            <section aria-label="Markdown folder export" data-testid="markdown-folder" className="space-y-3">
              <p className={LEGEND}>Markdown folder</p>
              {folder.kind === "idle" ? (
                <p className={`${SMALL} text-muted-foreground`}>
                  Use Export Markdown folder to collect the saved book. Nothing is written until you review the collection and choose a folder.
                </p>
              ) : null}
              {folder.kind === "capturing" ? (
                <p role="status" data-testid="markdown-folder-progress" className={SMALL}>
                  Collecting the saved book…
                </p>
              ) : null}
              {folder.kind === "consent" ? (
                <div className={`${BOX} space-y-3`} data-testid="markdown-folder-consent">
                  <p className="font-medium">Review this collection</p>
                  <p data-testid="markdown-folder-disclosure" className={SMALL}>
                    {folder.capture.consentDisclosure}
                  </p>
                  <p className={SMALL}>
                    Collection {folder.capture.captureSequence} · {folder.capture.policyLabel} · {folder.capture.files.length}{" "}
                    {folder.capture.files.length === 1 ? "file" : "files"}
                  </p>
                  {folder.superseded ? (
                    <p role="status" data-testid="markdown-folder-superseded" className={SMALL}>
                      A new collection replaced the previous one. The earlier choice no longer applies. Review this collection before continuing.
                    </p>
                  ) : null}
                  {folderNotice ? (
                    <p role="status" data-testid="markdown-folder-notice" className={SMALL}>
                      {folderNotice}
                    </p>
                  ) : null}
                  <label className={LABEL}>
                    Folder name
                    <input
                      className={FIELD}
                      value={folderName}
                      onChange={(event) => setFolderName(event.target.value)}
                      data-testid="markdown-folder-name"
                    />
                  </label>
                  <p className={`${SMALL} text-muted-foreground`}>
                    Creates a new folder. An existing folder is not replaced.
                  </p>
                  {folderNameCheck && !folderNameCheck.ok ? (
                    <p role="alert" data-testid="markdown-folder-name-error" className={ALERT}>
                      {folderNameCheck.message}
                    </p>
                  ) : null}
                  {folder.capture.warnings.length > 0 ? (
                    <div>
                      <p className="font-medium">Warnings</p>
                      <ul aria-label="Collection warnings" className="mt-1 list-disc space-y-1 pl-5">
                        {folder.capture.warnings.map((warning) => (
                          <li key={`${warning.kind}-${warning.code}-${warning.chapterId ?? "none"}-${warning.selectedPosition ?? "none"}-${warning.recordId ?? "none"}`} className={SMALL}>
                            {folderWarningText(warning, chapters)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className={SMALL}>No warnings for this collection.</p>
                  )}
                  {folder.capture.excludedLegacy.length > 0 ? (
                    <div data-testid="markdown-folder-excluded">
                      <p className="font-medium">Older front matter not included</p>
                      <ul aria-label="Excluded older front matter" className="mt-1 list-disc space-y-1 pl-5">
                        {folder.capture.excludedLegacy.map((entry) => (
                          <li key={entry.position} className={SMALL}>
                            {entry.key}: {legacyReasonText(entry.reason)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      data-testid="markdown-folder-continue"
                      disabled={folderNameCheck ? !folderNameCheck.ok : false}
                      onClick={() => void publishFolder(folder.capture)}
                    >
                      {folder.capture.excludedLegacy.length > 0 ? "Continue without them" : "Continue"}
                    </Button>
                    <Button data-testid="markdown-folder-cancel" onClick={() => void cancelFolderConsent(folder.capture)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
              {folder.kind === "publishing" ? (
                <div className={`${BOX} space-y-2`} data-testid="markdown-folder-progress">
                  <div className="flex flex-wrap items-center gap-3">
                    <p role="status" className={SMALL}>
                      {folderCancelling ? "Cancelling the Markdown folder export…" : "Publishing the Markdown folder…"}
                    </p>
                    <Button data-testid="markdown-folder-cancel-export" disabled={folderCancelling} onClick={() => void cancelFolderPublishing(folder.capture)}>
                      Cancel export
                    </Button>
                  </div>
                  {folderNotice ? (
                    <p role="status" data-testid="markdown-folder-cancel-note" className={SMALL}>
                      {folderNotice}
                    </p>
                  ) : null}
                  <label className={LABEL}>
                    Folder name
                    <input
                      className={FIELD}
                      value={effectiveFolderName}
                      disabled
                      data-testid="markdown-folder-name"
                    />
                  </label>
                </div>
              ) : null}
              {folder.kind === "published" ? (
                <div className={`${BOX} space-y-3`} data-testid="markdown-folder-result">
                  <p role="status" className="font-medium">
                    Markdown folder published
                  </p>
                  <p className={`${SMALL} break-words`} data-testid="markdown-folder-destination">
                    {folder.destinationPath}
                  </p>
                  <p className={SMALL}>
                    Saved data collected for this export. Changes made while collecting can mix observations, and edits after collection are not included.
                  </p>
                  {folder.cleanupLeftover ? (
                    <p role="status" data-testid="markdown-folder-cleanup" className={`${SMALL} break-words`}>
                      Published. Every listed file was written. One temporary folder could not be removed:{" "}
                      {folder.cleanupLeftover.path}. You can delete it.
                    </p>
                  ) : null}
                  <div>
                    <p className="font-medium">Written files</p>
                    <ul aria-label="Written files" data-testid="markdown-folder-files" className="mt-1 list-disc space-y-1 pl-5">
                      {folder.files.map((file) => (
                        <li key={file} className={SMALL}>
                          {file}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {folder.warnings.length > 0 ? (
                    <div>
                      <p className="font-medium">Warnings</p>
                      <ul aria-label="Export warnings" className="mt-1 list-disc space-y-1 pl-5">
                        {folder.warnings.map((warning) => (
                          <li key={`${warning.kind}-${warning.code}-${warning.chapterId ?? "none"}-${warning.selectedPosition ?? "none"}-${warning.recordId ?? "none"}`} className={SMALL}>
                            {folderWarningText(warning, chapters)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {folder.kind === "cancelled" ? (
                <p role="status" data-testid="markdown-folder-cancelled" className={SMALL}>
                  {folder.message}
                </p>
              ) : null}
              {folder.kind === "unknown" ? (
                <div role="alert" data-testid="markdown-folder-unknown" className={BOX}>
                  <p className="font-medium">Publication could not be confirmed</p>
                  <p className={`mt-1 ${SMALL}`}>{folder.message}</p>
                  {folder.destinationPath ? <p className={`mt-1 ${SMALL} break-words`}>{folder.destinationPath}</p> : null}
                </div>
              ) : null}
              {folder.kind === "error" ? (
                <p role="alert" data-testid="markdown-folder-error" className={ALERT}>
                  {folder.message}
                </p>
              ) : null}
            </section>
          ) : null}

          <fieldset disabled={exporting}>
            <legend className={LEGEND}>Typography</legend>
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3">
              <label className={LABEL}>
                {FORMAT_LABELS.bodyFont}
                <NativeSelect
                  className="w-full"
                  value={draft.bodyFont}
                  onChange={(event) => change({ bodyFont: event.target.value as ManuscriptSettings["bodyFont"] })}
                >
                  {(
                    ["Times New Roman", "Garamond", "Georgia", "Palatino Linotype", "Book Antiqua", "Cambria", "Calibri", "Bookman Old Style", "Century", "Courier New", "Arial", "Helvetica"] as const
                  ).map((font) => (
                    <NativeSelectOption key={font} value={font}>
                      {font}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label className={LABEL}>
                {FORMAT_LABELS.bodyFontSize}
                <NativeSelect
                  className="w-full"
                  value={draft.bodyFontSize}
                  onChange={(event) =>
                    change({ bodyFontSize: Number(event.target.value) as ManuscriptSettings["bodyFontSize"] })
                  }
                >
                  {[10, 11, 12, 13, 14].map((size) => (
                    <NativeSelectOption key={size} value={size}>
                      {size} pt
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label className={LABEL}>
                {FORMAT_LABELS.firstLineIndent}
                <NativeSelect
                  className="w-full"
                  value={draft.firstLineIndent}
                  onChange={(event) =>
                    change({ firstLineIndent: Number(event.target.value) as ManuscriptSettings["firstLineIndent"] })
                  }
                >
                  {[0, 0.1, 0.2, 0.3, 0.5].map((indent) => (
                    <NativeSelectOption key={indent} value={indent}>
                      {indent === 0 ? "None" : `${indent} in`}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label className={LABEL}>
                {FORMAT_LABELS.lineSpacing}
                <NativeSelect
                  className="w-full"
                  value={draft.lineSpacing}
                  onChange={(event) => change({ lineSpacing: event.target.value as ManuscriptSettings["lineSpacing"] })}
                >
                  {(["Single", "1.15", "1.5", "Double"] as const).map((spacing) => (
                    <NativeSelectOption key={spacing} value={spacing}>
                      {spacing}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-4" role="radiogroup" aria-label={FORMAT_LABELS.chapterTitleAlignment}>
              {(["Left", "Center"] as const).map((alignment) => (
                <label key={alignment} className={CHOICE}>
                  <input
                    type="radio"
                    name="format-title-alignment"
                    value={alignment}
                    checked={draft.chapterTitleAlignment === alignment}
                    onChange={() => change({ chapterTitleAlignment: alignment })}
                  />
                  {alignment}
                </label>
              ))}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <label className={CHOICE}>
                <input
                  type="checkbox"
                  checked={draft.includeTableOfContents}
                  onChange={(event) => change({ includeTableOfContents: event.target.checked })}
                />
                {FORMAT_LABELS.includeTableOfContents}
              </label>
              <label className={CHOICE}>
                <input
                  type="checkbox"
                  checked={draft.preserveLineBreaks}
                  onChange={(event) => change({ preserveLineBreaks: event.target.checked })}
                />
                {FORMAT_LABELS.preserveLineBreaks}
              </label>
            </div>
          </fieldset>

          <fieldset data-testid="format-matter" disabled={exporting}>
            <legend className={LEGEND}>Front and back matter</legend>
            {unreadable ? null : (
              <div className="mt-2 space-y-4">
                <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                  <label className={`h-9 ${CHOICE}`}>
                    <input
                      type="checkbox"
                      checked={current.titlePage}
                      onChange={(event) => edit((from) => ({ ...from, titlePage: event.target.checked }))}
                    />
                    Title page
                  </label>
                  {field("Author", current.author, MATTER_LIMITS.name, (author) => edit((from) => ({ ...from, author })))}
                  {field("Subtitle", current.subtitle, MATTER_LIMITS.name, (subtitle) => edit((from) => ({ ...from, subtitle })))}
                </div>
                {(["front", "back"] as const).map((side) => {
                  const list = current.sections.filter((section) => section.position === side);
                  return list.length > 0 ? (
                    <section key={side} aria-label={SIDES[side]}>
                      <h3 className={`${SMALL} font-medium`}>{SIDES[side]}</h3>
                      <ol className="mt-2 space-y-3">
                        {list.map((section, index) => {
                          const name = sectionName(section);
                          return (
                            <li key={section.id} className={BOX} data-testid="matter-section">
                              <div className="flex items-center gap-1">
                                <span className="flex-1 font-medium">{kindLabel(section.kind)}</span>
                                {iconButton(`Move ${name} up`, <ChevronUp size={13} />, () => move(section.id, -1), side === "front" && index === 0, `${section.id}:up`)}
                                {iconButton(
                                  `Move ${name} down`,
                                  <ChevronDown size={13} />,
                                  () => move(section.id, 1),
                                  side === "back" && index === list.length - 1,
                                  `${section.id}:down`
                                )}
                                {iconButton(
                                  `Remove ${name}`,
                                  <Trash2 size={13} />,
                                  () => {
                                    focusAfter.current = `${section.id}:keep`;
                                    setRemoving(section.id);
                                  },
                                  false,
                                  `${section.id}:remove`
                                )}
                              </div>
                              {removing === section.id ? (
                                <p className={`flex flex-wrap items-center gap-2 ${SMALL}`}>
                                  Remove {name} and its text from the book?
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    onClick={() => edit((from) => ({ ...from, sections: from.sections.filter((item) => item.id !== section.id) }))}
                                  >
                                    Remove section
                                  </Button>
                                  <Button
                                    size="sm"
                                    data-move={`${section.id}:keep`}
                                    onClick={() => {
                                      focusAfter.current = `${section.id}:remove`;
                                      setRemoving(null);
                                    }}
                                  >
                                    Keep section
                                  </Button>
                                </p>
                              ) : null}
                              {field("Heading", section.title, MATTER_LIMITS.title, (title) => update(section.id, { title }))}
                              <label className={LABEL} htmlFor={`${section.id}-text`}>
                                Text
                              </label>
                              <Textarea
                                id={`${section.id}-text`}
                                value={section.text}
                                rows={3}
                                maxLength={MATTER_LIMITS.text}
                                onChange={(event) => update(section.id, { text: event.target.value })}
                              />
                            </li>
                          );
                        })}
                      </ol>
                    </section>
                  ) : null;
                })}
                <div className="flex items-end gap-2">
                  <label className={LABEL}>
                    New section
                    <NativeSelect value={kind} onChange={(event) => setKind(event.target.value as MatterKind)}>
                      {MATTER_KINDS.map((option) => (
                        <NativeSelectOption key={option} value={option}>
                          {kindLabel(option)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </label>
                  <Button
                    disabled={current.sections.length >= MATTER_LIMITS.sections}
                    onClick={() =>
                      edit((from) => ({
                        ...from,
                        sections: [...from.sections, newMatterSection(kind, newId(), matterTemplate(kind, from.author, new Date().getFullYear()))]
                      }))
                    }
                  >
                    Add section
                  </Button>
                </div>
                {legacy.length > 0 ? (
                  <div className={`${BOX} ${SMALL}`} data-testid="matter-legacy">
                    <p>Older front matter, not exported yet. The old record stays as it is.</p>
                    <ul className="list-disc pl-5">
                      {legacy.map((entry) => (
                        <li key={entry.key}>
                          {entry.key}: {destination(entry)}
                        </li>
                      ))}
                    </ul>
                    {legacy.some((entry) => entry.target) ? (
                      <Button size="sm" onClick={() => edit((from) => convertLegacyMatter(book.frontMatter, from, newId))}>
                        Add to front and back matter
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
            {matterError || unreadable ? (
              <p role="alert" data-testid="matter-error" className={`mt-2 ${ALERT}`}>
                {matterError ?? `This book's front and back matter could not be read, so exports stop until the file is corrected. ${unreadable}`}
                {matterError && copy.current ? (
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() => void must(window.studio.conflicts.reveal(book.id, copy.current ?? "")).catch(onNotice)}
                  >
                    Show the saved copy
                  </Button>
                ) : null}
              </p>
            ) : null}
          </fieldset>

          <section aria-label="Preview">
            <div className="rounded-[var(--corner-lg)] border border-border p-4" data-testid="format-disclosure">
              <p className={LEGEND}>Approximate preview</p>
              <p className={`mt-1 ${SMALL} text-muted-foreground`}>
                Final output may differ in your word processor, PDF reader or e-reader. Nothing here measures
                pages, breaks, counts or trim, and nothing claims Kindle or publisher acceptance.
              </p>
            </div>
            <article
              className="mt-3 rounded-[var(--corner-lg)] bg-[var(--manuscript-bg)] px-5 py-6"
              data-testid="format-preview"
              style={{
                fontFamily: `'${draft.bodyFont}', ${FONT_FALLBACK[draft.bodyFont] ?? "serif"}`,
                fontSize: `${draft.bodyFontSize}pt`,
                lineHeight: LINE_HEIGHT[draft.lineSpacing]
              }}
            >
              {plan.titlePage ? (
                <section className="mb-6 text-center" data-testid="format-preview-title-page">
                  <h1 className="font-bold">{bookTitle.trim() || "Untitled book"}</h1>
                  {plan.subtitle ? <p className="italic">{plan.subtitle}</p> : null}
                  {plan.author ? <p className="mt-4">{plan.author}</p> : null}
                </section>
              ) : null}
              {plan.front.map(section)}
              {draft.includeTableOfContents ? (
                <>
                  <h3 style={{ textAlign: align }}>Contents</h3>
                  <ul>
                    {chapters.map((chapter) => (
                      <li key={chapter.id}>{chapter.title}</li>
                    ))}
                    {plan.back.map((section) => (
                      <li key={section.id}>{sectionName(section)}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {chapters.map((chapter) => page(chapter.id, chapter.title, chapter.content))}
              {plan.back.map(section)}
            </article>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
