import { Annotation, EditorState, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { insertNewline, standardKeymap } from "@codemirror/commands";
import { normalizePasteText } from "@ai-book-studio/core/paste";
import { insertTranscript, replaceTranscript } from "../../lib/voice-text";
import { buildOverlapIndex, inlineSpanKey, overlapAt, type InlineSpan, type OverlapIndex } from "../../../../core/src/review/inline/overlap";
import { isExactCurrent, sameInlineSource, type EditOrigin, type InlineEditorOptions, type InlineSnapshot, type InlineSource, type ReviewCommand, type ReviewResult, type TextSelection, type ValidatedInlineLayer } from "./contracts";

const replaceMarks = StateEffect.define<DecorationSet>();
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    // Never map saved-source marks through an edit, even one that returns identical text.
    if (transaction.docChanged) return Decoration.none;
    for (const effect of transaction.effects) if (effect.is(replaceMarks)) value = effect.value;
    return value;
  },
  provide: (field) => EditorView.decorations.from(field)
});
const editOrigin = Annotation.define<EditOrigin>();
const emptyIndex = buildOverlapIndex([], 0);

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--manuscript-bg)", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-reading)", fontSize: "var(--text-manuscript-size)", lineHeight: "var(--text-manuscript-leading)", overflow: "auto" },
  ".cm-content": { padding: "0", minHeight: "52vh", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0" },
  ".inline-review-mark": { textDecorationLine: "underline", textDecorationStyle: "dotted", textDecorationColor: "var(--primary)", textUnderlineOffset: "0.2em" },
  ".inline-review-active": { textDecorationStyle: "double" },
  ".cm-placeholder": { color: "var(--muted-foreground)", opacity: "0.6" },
  "@media (forced-colors: active)": {
    ".inline-review-mark": { textDecorationColor: "LinkText", forcedColorAdjust: "auto" },
    "&.cm-focused": { outline: "1px solid Highlight" }
  },
  "@media (prefers-reduced-motion: reduce)": { ".cm-scroller": { scrollBehavior: "auto" } }
});

/** One visit, one plain-text view. No save, filesystem, network or history stack lives here. */
export class InlineEditor {
  private readonly view: EditorView;
  private readonly identity: InlineSource;
  private revision = 0;
  private destroyed = false;
  private composing = false;
  private compositionTimer: ReturnType<typeof setTimeout> | undefined;
  private holds = 0;
  private request = 0;
  private pending: AbortController | null = null;
  private layer: ValidatedInlineLayer | null = null;
  private fullIndex: OverlapIndex = emptyIndex;
  private index: OverlapIndex = emptyIndex;
  private visibleKeys: ReadonlySet<string> | null = null;
  private hidden = false;
  private active: InlineSpan | null = null;
  private pointerStart: { x: number; y: number } | null = null;

  constructor(parent: HTMLElement, private readonly options: InlineEditorOptions) {
    this.identity = Object.freeze({ ...options.readSource() });
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: options.initialText,
        extensions: [
          EditorState.lineSeparator.of("\n"), EditorState.allowMultipleSelections.of(false),
          EditorView.lineWrapping, theme, marks,
          ...(options.placeholder ? [placeholderExtension(options.placeholder)] : []),
          EditorView.contentAttributes.of({
            "aria-label": options.label ?? "Chapter text", "aria-multiline": "true",
            ...(options.describedBy ? { "aria-describedby": options.describedBy } : {}),
            spellcheck: "true", "data-testid": options.testId ?? "inline-manuscript-text"
          }),
          keymap.of([
            { key: "Enter", run: insertNewline, shift: insertNewline },
            ...standardKeymap.filter((binding) => binding.key !== "Enter")
          ]),
          EditorView.domEventHandlers({
            keydown: (event) => this.keydown(event),
            beforeinput: (event) => {
              if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return false;
              event.preventDefault();
              if (!this.getSnapshot().composing) options.onCommand(event.inputType === "historyUndo" ? "undo" : "redo");
              return true;
            },
            paste: (event) => {
              const text = event.clipboardData?.getData("text/plain");
              if (!text) return false;
              // Do not let a paste interrupt an active composition behind the host's back.
              event.preventDefault();
              if (!this.getSnapshot().composing) this.paste(text);
              return true;
            },
            compositionstart: () => {
              if (this.compositionTimer !== undefined) clearTimeout(this.compositionTimer);
              this.composing = true;
              this.invalidate();
              options.onComposition(true);
              return false;
            },
            compositionend: () => {
              // Native final input/CM observer flush must finish before external replacements.
              this.compositionTimer = setTimeout(() => {
                this.compositionTimer = undefined;
                if (this.destroyed || this.view.compositionStarted) return;
                this.composing = false;
                this.revision += 1;
                options.onComposition(false);
              }, 0);
              return false;
            },
            blur: () => { options.onBlur(); return false; },
            pointerdown: (event) => {
              this.pointerStart = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
              return false;
            },
            click: (event) => {
              const start = this.pointerStart;
              this.pointerStart = null;
              if (!start || Math.hypot(start.x - event.clientX, start.y - event.clientY) > 4 ||
                !this.view.state.selection.main.empty || event.shiftKey || event.metaKey || event.ctrlKey ||
                !(event.target instanceof Element) || !event.target.closest(".inline-review-mark")) return false;
              const offset = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (offset !== null) this.inspectAt(offset);
              return false; // Preserve ordinary caret placement and native pointer behavior.
            }
          })
        ]
      }),
      dispatchTransactions: (transactions, view) => this.dispatch(transactions, view)
    });
    if (this.view.state.doc.toString() !== options.initialText) {
      this.view.destroy();
      throw new Error("The inline editor could not preserve the source text.");
    }
  }

  getSnapshot(): InlineSnapshot {
    const source = this.options.readSource();
    const body = this.view.state.doc.toString();
    const { anchor, head, from, to } = this.view.state.selection.main;
    return Object.freeze({
      ...source, available: source.available === true && this.sameVisit(source),
      body, selection: Object.freeze({ anchor, head }), selectedText: body.slice(from, to),
      composing: this.composing || this.view.compositionStarted, held: this.holds > 0,
      revision: this.revision, destroyed: this.destroyed
    });
  }

  private sameVisit(source: InlineSource): boolean {
    return source.libraryId === this.identity.libraryId && source.bookId === this.identity.bookId &&
      source.chapterId === this.identity.chapterId && source.viewGeneration === this.identity.viewGeneration;
  }

  private dispatch(transactions: readonly Transaction[], view: EditorView): void {
    const changed = transactions.some((transaction) => transaction.docChanged);
    const previous = view.state.doc.toString();
    if (changed) this.invalidate(false);
    view.update(transactions);
    if (changed) {
      const snapshot = this.getSnapshot();
      const explicit = transactions.map((transaction) => transaction.annotation(editOrigin)).find(Boolean);
      const pasted = transactions.some((transaction) => transaction.isUserEvent("input.paste"));
      const origin = explicit ?? (pasted ? "paste" : "input");
      this.options.onChange(Object.freeze({
        previous, text: snapshot.body, selection: snapshot.selection, origin,
        recordHistory: origin !== "undo" && origin !== "redo" && origin !== "save-normalization",
        isolated: origin === "paste" || origin === "dictation" || origin === "controlled" ||
          Math.abs(snapshot.body.length - previous.length) > 1
      }));
    }
    if (transactions.some((transaction) => transaction.selection !== undefined)) {
      this.options.onSelection?.(this.getSnapshot().selection);
    }
  }

  private keydown(event: KeyboardEvent): boolean {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
    const key = event.key.toLowerCase();
    const command = key === "s" ? "save" : key === "z" ? (event.shiftKey ? "redo" : "undo") :
      key === "y" && event.ctrlKey ? "redo" : null;
    if (!command) return false;
    // Delegate to the only undo/save owner, including empty-stack cases. Never native DOM undo.
    event.preventDefault();
    if (!event.isComposing && !this.getSnapshot().composing) this.options.onCommand(command);
    return true;
  }

  private invalidate(render = true): void {
    this.revision += 1;
    this.request += 1;
    this.pending?.abort();
    this.pending = null;
    const hadLayer = this.layer !== null;
    this.layer = null;
    this.fullIndex = emptyIndex;
    this.index = emptyIndex;
    this.active = null;
    if (render && !this.destroyed) this.view.dispatch({ effects: replaceMarks.of(Decoration.none) });
    if (hadLayer && !this.destroyed) this.options.onReviewStatus("stale");
  }

  /**
   * The host removed its review request (or closed the review surface): drop the current layer,
   * marks and any in-flight proof without claiming the text changed.
   */
  discardEvidence(): void {
    this.revision += 1;
    this.request += 1;
    this.pending?.abort();
    this.pending = null;
    this.layer = null;
    this.fullIndex = emptyIndex;
    this.index = emptyIndex;
    this.active = null;
    if (!this.destroyed) this.view.dispatch({ effects: replaceMarks.of(Decoration.none) });
  }

  /** Host must call synchronously on saved-base, clean/pending, availability or source epoch changes. */
  syncSource(): void { this.invalidate(); }

  /** Leaf hold suspends evidence/programmatic changes; typing continues, just as wrapper saves hold. */
  hold(): () => void {
    this.holds += 1;
    this.invalidate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      this.revision += 1;
    };
  }

  /** Metadata-only rebase notification never replaces a dirty buffer. Save queue stays in the host. */
  rebase(previous: InlineSource): boolean {
    const next = this.options.readSource();
    if (this.destroyed) return false;
    const accepted = this.sameVisit(next) && !this.getSnapshot().composing && next.savedBody === previous.savedBody &&
      next.libraryId === previous.libraryId && next.bookId === previous.bookId &&
      next.chapterId === previous.chapterId && next.viewGeneration === previous.viewGeneration;
    // Even a refused rebase is a source-change notification, never permission to leave old marks.
    this.syncSource();
    return accepted;
  }

  /** Compare-and-set prevents a delayed React echo/history/dictation result overwriting newer input. */
  replaceText(text: string, expectedRevision: number, origin: EditOrigin = "controlled", selection?: TextSelection): boolean {
    return this.applyReplace(text, expectedRevision, origin, selection, false);
  }

  /**
   * A user-origin commit of exact text, as an input method or the mount's automation contract
   * delivers it: compare-and-set, one isolated history unit, and allowed during a hold exactly as
   * native typing is. Controlled replacement, dictation and evidence stay refused during a hold.
   */
  typeText(text: string, expectedRevision: number, selection?: TextSelection): boolean {
    return this.applyReplace(text, expectedRevision, "input", selection, true);
  }

  private applyReplace(text: string, expectedRevision: number, origin: EditOrigin, selection: TextSelection | undefined, allowDuringHold: boolean): boolean {
    const current = this.getSnapshot();
    if (current.destroyed || !this.sameVisit(current) || current.composing || (!allowDuringHold && current.held) || current.revision !== expectedRevision) return false;
    const nextSelection = selection ?? { anchor: Math.min(current.selection.anchor, text.length), head: Math.min(current.selection.head, text.length) };
    if (!validSelection(nextSelection, text)) return false;
    this.view.dispatch({
      ...(text !== current.body ? { changes: { from: 0, to: current.body.length, insert: text } } : {}),
      selection: nextSelection, annotations: editOrigin.of(origin)
    });
    return true;
  }

  paste(text: string): boolean {
    const current = this.getSnapshot();
    const from = Math.min(current.selection.anchor, current.selection.head);
    const to = Math.max(current.selection.anchor, current.selection.head);
    const inserted = normalizePasteText(text);
    const caret = from + inserted.length;
    // User-origin paste is typing, not a controlled replacement: a hold suspends
    // programmatic replacement, so paste inserts through the normal change path.
    return this.applyReplace(current.body.slice(0, from) + inserted + current.body.slice(to), current.revision, "paste", { anchor: caret, head: caret }, true);
  }

  /** Insert at the selection start and keep the selected characters. Never removes them. */
  insertDictation(text: string, expectedRevision: number): boolean {
    return this.applyDictation(text, expectedRevision, false);
  }

  /** Remove only the selected range. An empty selection inserts. Refused during a hold. */
  replaceDictation(text: string, expectedRevision: number): boolean {
    return this.applyDictation(text, expectedRevision, true);
  }

  private applyDictation(text: string, expectedRevision: number, replace: boolean): boolean {
    const current = this.getSnapshot();
    const start = Math.min(current.selection.anchor, current.selection.head);
    const end = Math.max(current.selection.anchor, current.selection.head);
    const insertion = (replace ? replaceTranscript : insertTranscript)(current.body, text, start, end);
    return insertion !== null && this.replaceText(insertion.text, expectedRevision, "dictation", { anchor: insertion.caret, head: insertion.caret });
  }

  setSelection(selection: TextSelection, focus = false): boolean {
    const current = this.getSnapshot();
    if (current.destroyed || !this.sameVisit(current) || current.composing || !validSelection(selection, current.body)) return false;
    this.view.dispatch({ selection, scrollIntoView: true });
    if (focus) this.view.focus();
    return true;
  }

  focus(): void { if (!this.destroyed && this.sameVisit(this.options.readSource())) this.view.focus(); }

  /** Latest request wins, even if the trusted verifier ignores AbortSignal or throws. */
  async showEvidence(input: unknown): Promise<ReviewResult> {
    this.invalidate();
    const target = this.getSnapshot();
    if (!isExactCurrent(target, target)) return "stale";
    const request = this.request;
    const controller = new AbortController();
    this.pending = controller;
    let proof: ValidatedInlineLayer | null;
    try { proof = await this.options.evidence.validate(input, target, controller.signal); }
    catch { proof = null; }
    if (this.destroyed || request !== this.request || controller.signal.aborted) return "superseded";
    this.pending = null;
    if (!proof) return "unavailable";
    // No awaits after this final application check. Envelope validity is the port's separate job.
    const current = this.getSnapshot();
    if (current.revision !== target.revision || !sameInlineSource(target, proof.source) ||
      !isExactCurrent(current, proof.source)) return "stale";
    try {
      const index = buildOverlapIndex(proof.spans, current.body.length);
      this.layer = Object.freeze({ source: Object.freeze({ ...proof.source }), spans: index.spans });
      this.fullIndex = index;
      this.rebuildVisibleIndex();
      this.renderMarks();
      return "applied";
    } catch { return "unavailable"; }
  }

  /** Local visibility only. IDs and historical dispositions remain owned by the host. */
  setVisibility(keys: ReadonlySet<string> | null, hidden = false): void {
    this.visibleKeys = keys === null ? null : new Set(keys);
    this.hidden = hidden;
    this.rebuildVisibleIndex();
    this.renderMarks();
  }

  /**
   * The validated layer this visit is showing, or null once it is no longer exact-current.
   * The host uses it for its own accessible finding list; it never certifies anything itself.
   */
  getLayer(): ValidatedInlineLayer | null {
    if (!this.currentLayer()) return null;
    return this.layer;
  }

  private currentLayer(): boolean {
    if (!this.layer) return false;
    if (isExactCurrent(this.getSnapshot(), this.layer.source)) return true;
    this.invalidate();
    return false;
  }

  private renderMarks(): void {
    if (this.destroyed || !this.currentLayer() || !this.layer) return;
    const activeKey = this.active ? inlineSpanKey(this.active) : null;
    const wasFiltered = activeKey !== null && !this.index.spans.some((span) => inlineSpanKey(span) === activeKey);
    if (wasFiltered) this.active = null;
    const ranges = this.hidden ? [] : this.index.segments.map((segment) => Decoration.mark({
      class: `inline-review-mark${!wasFiltered && segment.members.some((span) => inlineSpanKey(span) === activeKey) ? " inline-review-active" : ""}`
    }).range(segment.from, segment.to));
    this.view.dispatch({ effects: replaceMarks.of(Decoration.set(ranges, true)) });
    this.options.onReviewStatus(this.hidden ? "hidden" : wasFiltered ? "filtered" : "ready");
  }

  private rebuildVisibleIndex(): void {
    this.index = this.visibleKeys === null ? this.fullIndex : buildOverlapIndex(
      this.fullIndex.spans.filter((span) => this.visibleKeys?.has(inlineSpanKey(span))),
      this.layer?.source.savedBody.length ?? 0
    );
  }

  /** Pointer inspection does not replace selection or move focus away from the text. */
  /**
   * Select one finding by identity, for a list row that names it. Resolving by offset alone picks
   * whichever overlapping member happens to be first, so two findings on one passage could not be
   * chosen separately from the list.
   */
  inspectSpan(span: InlineSpan): boolean {
    if (this.hidden || !this.currentLayer()) return false;
    // Match the finding the row names, not one evidence span: a finding can cite several passages
    // and two findings can share a passage, so evidence-level keys are not a stable row identity.
    const match = this.index.spans.find((candidate) =>
      candidate.runId === span.runId && candidate.findingId === span.findingId);
    if (!match) return false;
    this.active = match;
    this.renderMarks();
    const segment = overlapAt(this.index, match.from);
    const choices = segment?.members ?? [match];
    this.options.onInspect(Object.freeze({ action: "pointer", active: match, choices }));
    return true;
  }

  inspectAt(offset: number): boolean {
    if (this.hidden || !this.currentLayer()) return false;
    const segment = overlapAt(this.index, offset);
    if (!segment) return false;
    const active = segment.members.find((span) => this.active && inlineSpanKey(span) === inlineSpanKey(this.active)) ?? segment.members[0];
    if (!active) return false;
    this.active = active;
    this.renderMarks();
    this.options.onInspect(Object.freeze({ action: "pointer", active, choices: segment.members }));
    return true;
  }

  /** Explicit sidebar/palette commands; no review shortcuts steal typing, OS or assistive keys. */
  reviewCommand(action: ReviewCommand): boolean {
    if (!this.currentLayer() || this.index.spans.length === 0) return false;
    const activeKey = this.active ? inlineSpanKey(this.active) : null;
    const currentIndex = this.index.spans.findIndex((span) => inlineSpanKey(span) === activeKey);
    let index = currentIndex;
    if (action === "next") index = (currentIndex + 1) % this.index.spans.length;
    else if (action === "previous") index = currentIndex < 0 ? this.index.spans.length - 1 : (currentIndex + this.index.spans.length - 1) % this.index.spans.length;
    else if (index < 0) index = 0;
    const active = this.index.spans[index];
    if (!active) return false;
    this.active = active;
    if (action !== "return") {
      // Host code may have changed the source since a sidebar command was queued.
      if (!this.currentLayer()) return false;
      if (!this.setSelection({ anchor: active.from, head: active.to }, action === "inspect")) return false;
    }
    this.renderMarks();
    const choices = overlapAt(this.index, active.from)?.members;
    if (!choices) return false;
    this.options.onInspect(Object.freeze({ action, active, choices }));
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.compositionTimer !== undefined) clearTimeout(this.compositionTimer);
    this.invalidate(false);
    this.view.destroy();
  }
}

function validSelection(selection: TextSelection, text: string): boolean {
  return Number.isSafeInteger(selection.anchor) && Number.isSafeInteger(selection.head) &&
    selection.anchor >= 0 && selection.anchor <= text.length && selection.head >= 0 && selection.head <= text.length &&
    [selection.anchor, selection.head].every((offset) => {
      const before = text.charCodeAt(offset - 1);
      const after = text.charCodeAt(offset);
      return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
    });
}
