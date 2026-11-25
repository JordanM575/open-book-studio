import type { InlineSpan } from "../../../../core/src/review/inline/overlap";

/** Host-owned live refs, not a possibly delayed React save-status mirror. */
export interface InlineSource {
  readonly libraryId: string;
  readonly bookId: string;
  readonly chapterId: string;
  /** Unique per mounted visit, including A → B → A. */
  readonly viewGeneration: string;
  /** Monotonic host revision for any source/availability/save-state transition, including ABA. */
  readonly sourceEpoch: number;
  readonly version: number;
  readonly rawHash: string;
  readonly savedBody: string;
  readonly clean: boolean;
  readonly pending: boolean;
  readonly available: boolean;
}

export interface TextSelection {
  readonly anchor: number;
  readonly head: number;
}

export interface InlineSnapshot extends InlineSource {
  readonly body: string;
  readonly selection: TextSelection;
  readonly selectedText: string;
  readonly composing: boolean;
  readonly held: boolean;
  readonly revision: number;
  readonly destroyed: boolean;
}

export interface ValidatedInlineLayer {
  readonly source: InlineSource;
  readonly spans: readonly InlineSpan[];
}

/**
 * TRUSTED injected boundary, not a boolean supplied by model output. Implement using the
 * independently corrected shared verifier. It must validate the envelope/owners/raw bytes,
 * fatal UTF-8/canonical saved body, exact literal quotes, safe scalar endpoints, selected
 * scope, limits and unique finding/evidence attribution. It returns detached plain data
 * or null; no normalizing, substring searching or provider calls. The leaf never certifies
 * those facts. The final live body/token/composition check below is a separate boundary.
 */
export interface ValidatedEvidencePort {
  validate(input: unknown, target: InlineSnapshot, signal: AbortSignal): Promise<ValidatedInlineLayer | null>;
}

export type ReviewResult = "applied" | "stale" | "unavailable" | "superseded";
export type ReviewCommand = "previous" | "next" | "inspect" | "return";
export type EditOrigin = "input" | "paste" | "dictation" | "undo" | "redo" | "controlled" | "save-normalization";

export interface InlineChange {
  readonly previous: string;
  readonly text: string;
  readonly selection: TextSelection;
  readonly origin: EditOrigin;
  /** Host calls pushHistory only for new edits, never for history restoration. */
  readonly recordHistory: boolean;
  readonly isolated: boolean;
}

export interface InlineInspection {
  readonly action: ReviewCommand | "pointer";
  readonly active: InlineSpan;
  readonly choices: readonly InlineSpan[];
}

export interface InlineEditorOptions {
  readonly initialText: string;
  readonly readSource: () => InlineSource;
  readonly evidence: ValidatedEvidencePort;
  readonly onChange: (change: InlineChange) => void;
  readonly onCommand: (command: "undo" | "redo" | "save") => void;
  readonly onInspect: (inspection: InlineInspection) => void;
  readonly onReviewStatus: (status: "hidden" | "filtered" | "stale" | "ready") => void;
  readonly onComposition: (composing: boolean) => void;
  readonly onBlur: () => void;
  readonly onSelection?: (selection: TextSelection) => void;
  readonly label?: string;
  readonly describedBy?: string;
  /** Test hook id for the mounted surface; the isolated leaf keeps its own when this is absent. */
  readonly testId?: string;
  /** Shown when the chapter has no words yet. */
  readonly placeholder?: string;
}

export function sameInlineSource(a: InlineSource, b: InlineSource): boolean {
  return a.libraryId === b.libraryId && a.bookId === b.bookId && a.chapterId === b.chapterId &&
    a.viewGeneration === b.viewGeneration && a.sourceEpoch === b.sourceEpoch &&
    a.version === b.version && a.rawHash === b.rawHash && a.savedBody === b.savedBody;
}

export function isExactCurrent(snapshot: InlineSnapshot, source: InlineSource): boolean {
  return !snapshot.destroyed && !snapshot.composing && !snapshot.held &&
    snapshot.clean === true && snapshot.pending === false && snapshot.available === true &&
    sameInlineSource(snapshot, source) && snapshot.body === source.savedBody;
}
