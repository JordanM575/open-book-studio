# Isolated inline manuscript adapter

## Decision before implementation — November 7, 2026

Implement ADR 0020 / D-197 with a minimal CodeMirror 6 state/view leaf and plain-text
editing commands, omitting history, language extensions and basicSetup. React owns
mount/cleanup only; the host retains draft, save, title and custom undo ownership.
An injected evidence-validation port must establish envelope/source/quote validity;
this leaf separately checks the exact live editor at the final application boundary.
The mount followed the coordinator's November 8 slice decision after the leaf and shared
verifier were accepted on `main`; see “Mounted surface” below for what that mount covers
and what stays open.

Evidence: official https://codemirror.net/docs/ref/ (state lineSeparator, UTF-16 Text,
transactions, decorations, composition and view teardown) and
https://react.dev/reference/react/useLayoutEffect (external DOM lifecycle, cleanup,
Strict Mode replay), accessed November 7, 2026. Context7 resolution for both libraries
failed with monthly quota exceeded; official documentation is the fallback.
The existing wrapper has serialized version/hash saves, 700ms autosave, 300ms drafts,
failure retry, hold/rebase, explicit paste normalization and transcript spacing, with
100-snapshot / 500ms-coalesced custom history. These stay host responsibilities.

Rejected alternatives: rich-text serialization changes source coordinates; an overlay
duplicates layout; enabling CodeMirror history competes with the existing undo owner.
This is a bounded implementation decision under already accepted D-197, not a new
central policy. API details and measured verification follow below before handoff.

## Surface and proof contracts

- `InlineTextSurface({ options, onReady })` mounts one `InlineEditor` and destroys it
  on cleanup. Keep both props stable for the visit; callbacks should read host refs.
  React Strict Mode replay is covered. Use a unique key for each library/book/chapter/
  view visit; ordinary host rerenders must not recreate options and discard the view.
- `getSnapshot()` returns a frozen exact body, selected text, backward-capable UTF-16
  selection, library/book/chapter/view identity, saved version/raw hash/body, host
  epoch/clean/pending/availability, local revision, composition, hold and destruction.
  Source `clean`, `pending` and `available` use strict booleans. No whole-body hashing
  occurs here. This snapshot does not verify raw bytes or report envelopes.
- `showEvidence(input)` invokes the **trusted** `ValidatedEvidencePort` with that
  immutable target and AbortSignal. The reviewed candidate seam is now
  `packages/core/src/review/shared-verifier.ts` (`createSharedEvidencePort`): one
  saved-chapter snapshot, raw byte/text SHA-256 and fatal UTF-8, canonical saved-body
  and id/version equality, envelope/scope attribution, exact literal quotes,
  scalar-safe endpoints, quote limits, evidence uniqueness and abort racing. Return
  detached data or null. Never install an uncorrected scoped candidate or a boolean
  from model output as this port. Mounting the seam still needs its own review.
- After the await, the leaf checks request ownership, local revision, library/book/
  chapter/view generation, host source epoch, version/raw hash, exact saved/current
  body, clean/not-pending/available, non-composing and non-held state. No await occurs
  between that check and installation. Throws/refusals use fixed result enums, not
  raw errors. New requests, edits, holds, source sync and destroy defeat old replies.
- `syncSource()` must be called **synchronously** whenever the host base, pending/
  clean state, availability or source epoch changes, including metadata-only saves.
  Increment `sourceEpoch` for every such transition, including A→B→A. Checking only
  final equal values cannot detect an unreported ABA. Async operations still perform
  the final live comparison even if a sync notification was missed. The host must
  notify to remove already-painted marks immediately on non-text source changes.
- Text transactions clear marks before `onChange`, without position mapping. No mark
  is restored merely because undo returns the text to its previous value. A new
  validated installation is needed against the still-current clean saved token.
- The overlap index is pure endpoint sweep, with batched coincident endpoints and
  O(n log n + emitted memberships) work. Every run/finding/evidence/span membership
  survives. Each discontinuous piece has its own `spanId`; tuple keys never depend
  on quotation search. Point lookup is binary, half-open and gap-preserving. Choice
  order is category/run/finding/evidence/span (code-unit order, not locale order);
  navigation order is start/end then that choice order. No truncation or cap is used.
- Evidence installation keeps an immutable complete index. Filter changes rebuild
  only the visible index; active navigation reuses it. CodeMirror's viewport renderer
  paints the direct mark ranges. This is not a full-book virtualized findings list.

## Editing, history, focus and inspection APIs

`replaceText(text, expectedRevision, origin, selection?)` is compare-and-set; it
refuses a stale revision, another visit, composition or hold. It preserves exact
text with LF configured as the sole line separator; it does not normalize Markdown,
quotes, trailing spaces or intentional newlines. No-op controlled echoes emit no
text change. Programmatic selections reject fractional/out-of-range offsets and
surrogate splits. Scalar-safe partial grapheme selections are not expanded.

`paste(text)` reuses `normalizePasteText`; the clipboard path handles plain text.
User-origin paste is typing, not a controlled replacement: during a hold it
inserts the normalized text through the normal change path with the same
isolated history unit as paste outside a hold. Controlled `replaceText`,
dictation and evidence installation remain refused during a hold.
`insertDictation(text, expectedRevision)` inserts at the start of the selection
and keeps the selected text. `replaceDictation(text, expectedRevision)` removes
only that range. Both keep line breaks, still add joining spaces when the
neighboring prose needs them, go through `replaceText` with origin `dictation`,
and report one isolated history unit. Dictation refusal leaves ownership of the
uninserted transcript with the host for retry.
Composition-time programmatic changes refuse; browser composition text itself
continues through ordinary input/change notifications. Composition end/cancel waits
for the native final input/observer turn before releasing the guard.

`onChange` supplies previous/new text, selection, origin, `recordHistory` and
`isolated`. The host alone calls `pushHistory`; undo/redo restoration sets
`recordHistory: false`. `onCommand` delegates Ctrl/Cmd-S/Z, Shift-Z and Ctrl-Y,
plus native beforeinput history commands, to that one owner. Empty-stack commands
are still consumed so native contenteditable undo cannot compete. Enter inserts
one literal LF with no code indentation. Tab remains ordinary focus navigation.

`hold()` returns an idempotent release closure and supports nesting. It suspends
evidence/programmatic replacement but permits native typing. It is **not** the
wrapper's serialized save queue. Pair it with the existing wrapper hold. `rebase`
only acknowledges a same-body metadata-source transition and preserves the draft;
the wrapper still checks title/base semantics and owns all saves.

`setSelection`, `focus`, `reviewCommand(previous|next|inspect|return)` and `inspectAt`
are imperative. Only the review commands/point inspection use the validated layer;
generic `setSelection` is for ordinary editing and is not evidence authorization.
Inspect selects/reveals the full exact occurrence and focuses the editor; next/
previous select/reveal while keeping a sidebar control focused. Pointer inspection
preserves caret placement and drag selection. `onInspect` carries the active span
and all ordered overlap choices. The host supplies the overlap chooser and full
accessible details; no inline mark receives a tab stop. Return emits a callback
for the host to focus its finding row. `InlineReviewControls` provides four named,
44px native buttons with the same commands, without new global review shortcuts.

`setVisibility(keys|null, hidden)` changes only visible membership/marks. It retains
the full layer and selected item when still visible, clears filtered selection with
an explicit status callback, and never moves focus. The host owns filtered/total
counts, historical findings/dispositions, paging, polite announcements and fallback
focus if it removes a sidebar row. After staleness, the host's historical Return/
Inspect controls remain independent of this current-evidence-only toolbar.

## Migration checklist for the named integration owner

1. Obtain independent exact-candidate review of this leaf and the shared core verifier
   candidate (`packages/core/src/review/shared-verifier.ts`). Add an accepted core
   subpath export if needed and prove structural use as `ValidatedEvidencePort`; this
   isolated leaf uses an explicit relative core import to avoid changing the
   coordinator-owned export map. The verifier is host-neutral; it does not read a
   Library or dispatch a provider on the leaf's behalf.
2. Keep ManuscriptEditor's title, custom history, latest/base refs, save queue,
   700ms save and 300ms draft debounce, retry/conflict/flush, illustration and voice
   ownership. Replace only the textarea after fidelity gates, not before. Scope the
   history key by library/book/chapter lifecycle, without losing intended chapter
   revisit history or sharing snapshots across libraries.
3. Bridge `onChange` to the existing applyText path exactly once. Use its flags for
   pushHistory. Bridge undo/redo to existing history and one `replaceText` transaction.
   Remove the former textarea's key/paste interception at the new surface boundary
   to avoid double-handling. Route blur/save commands to the existing save owner.
4. Supply live source refs and monotonic epoch; body equality and pending state must
   account for edits made during a save and metadata/title writes. Do not let a late
   save response certify a newer draft. Keep failed/conflicted buffers intact.
5. Pair wrapper hold/rebase with leaf hold/source sync. No external chapter load or
   publication may silently call replaceText over a dirty draft. Use normal conflict
   handling, not a convenient editor reset.
6. After target mount/navigation awaits, call `showEvidence` on that exact handle;
   continue only for `applied`, then use review commands. Abort obsolete navigation.
   Inject shared verified evidence, never unvalidated offsets into generic selection.
7. Mount the named aside, overlap choice/full details, run/filter controls, historical
   status, focus return and polite announcements. Filtering has no provider or writer
   callbacks here; actual host no-send/no-write assertions remain required.
8. Run the existing real-wrapper save/draft/undo/conflict/close/switch/retry regressions,
   hidden no-keychain app checks, whole-app bundle/license gates and performance
   fixtures on the integrated candidate. This leaf does not authorize those writes
   or constitute their evidence.

## Mounted surface — November 8, 2026 (039 T012 partial)

`ManuscriptEditor` now mounts `InlineTextSurface` in place of its textarea. The wrapper still owns
the title, save queue, 700/300 ms timers, retry/conflict/flush, hold/rebase, voice and the custom
undo history; the leaf owns no save, file or network access. The mounted content element carries
`data-testid="manuscript-text"` and `aria-label="Chapter text"`.

Small additive leaf APIs made the mount honest:

- `typeText(text, expectedRevision, selection?)` is a compare-and-set **user-origin** commit for an
  input method or the mount's automation contract. It keeps one isolated history unit and is
  allowed during a hold exactly as native typing is; `replaceText`, dictation and evidence stay
  refused during a hold.
- `getLayer()` returns the current validated layer (or null once it is not exact-current) so the
  host can build its own accessible finding list without certifying anything.
- `testId` and `placeholder` options let the host keep its existing smoke hook and empty-chapter
  prompt without a second editor.

The mount keeps a textarea-shaped automation contract on the content element: reading `value`
returns the exact editor text, assigning it applies that text through `typeText`, and
`selectionStart`/`selectionEnd` map to the leaf selection. It is not a second editor, save path or
undo stack; native typing never uses it. The hidden smoke and the existing DOM suites drive the
same mounted surface through it.

A minimal aside appears only when the host supplies an untrusted `reviewRequest`: the shared
verifier (`createSharedEvidencePort`, or an injected port in tests) validates it against the live
source facts, marks are painted only after `applied`, and the list offers named Previous/Next/
Inspect/Return controls, focus return, a category filter and filtered/total counts. Editing hides
current marks and removes the list. No provider call, persistence, disposition or full sidebar is
implemented; 039 T011–T013 stay partial, and the native-IME, screen-reader, connected-provider,
saved-review and 120-chapter/250k-word performance gates remain open.

## Reproducible focused checks

From repository root (Bun dependencies installed):

```sh
bun test packages/core/tests/inline-overlap.test.ts apps/desktop/tests/inline-editor.test.tsx apps/desktop/tests/editor-mount.test.tsx
node packages/app/src/components/inline-editor/probes/native.mjs
node packages/app/src/components/inline-editor/probes/bundle.mjs
bun run typecheck
bunx biome lint packages/app/src/components/inline-editor packages/core/src/review/inline packages/core/tests/inline-overlap.test.ts apps/desktop/tests/inline-editor.test.tsx apps/desktop/tests/inline-editor-native-fixture.tsx
```

Native probes use an installed Playwright Chromium, fresh headless context, aborted
network routes, synthetic fixture and temporary compiled bundle removed in finally.
They launch no app, server, persistent profile, keychain, microphone or native device.
Set TMPDIR to an approved temporary directory where required. The fixture is in the
desktop test workspace so it uses that workspace's existing react-dom dependency.

At handoff: **20 new focused tests**, **64 tests / 801 assertions** when run alongside
the existing manuscript editor, history, failed-save and move/rebase regressions,
and **9 native Chromium probes**
(Chromium 156.0.8078.4), strict desktop node/web + web + toolkit typechecks and focused
lint pass. The native probes check exact Markdown/LF/UTF-16, emoji/bidi/combining/ZWJ,
native typing/Enter/history, clipboard event paste and copy, synthetic dictation,
CDP-driven native IME commit/cancel, overlap click/keyboard/return/drag, immediate
invalidation, filter focus/source ABA, 700 lines plus a 20,000-character unbroken
line, offscreen scrolling, 200% CSS zoom/reflow, both token themes, forced colors,
reduced motion and Tab exit. These are isolated probes, not the full e2e runner.

Standalone Bun 1.4.4 minified ESM build of `InlineTextSurface.tsx`, with existing
`react` and `react/jsx-runtime` external: **274,211 bytes**, **88,578 gzip bytes**,
SHA-256 `35b6c291cb157672ce3219b6d5e80063feed05465921095db906ecfe7e313ef9`.
This conservatively exposes both component exports and includes the leaf/editor
dependency code. It excludes the existing React runtime and test harness. It is not
a Vite whole-app delta or a pass of the total-JavaScript gate. Twelve MIT dependency
license records were read and hashed; see `LICENSES.md` and the reproduction script.

### Observed fidelity limits and remaining acceptance

Chromium **collapses the native painted selection for a combining mark alone and
a ZWJ alone**. The CodeMirror selection and intercepted copy retain their exact
UTF-16 text; the probe records both differences, does not expand the quote, and
verifies the clipboard result. An accessible exact quote in the host sidebar is
essential. Independent fidelity review must decide whether additional affordances
are needed before mounting. Do not describe this as exact native glyph selection.

The clipboard test dispatches a synthetic ClipboardEvent; it does not read or write
the system clipboard. CDP composition is real Chromium input, not evidence for every
OS input method, dead key, spelling/autocorrect service, screen reader, Safari,
Firefox or mobile/WebView EditContext path. Those remain host qualification gates.
The long-line/reflow checks are focused correctness probes, not manuscript-scale
latency, retained-memory or the existing 120-chapter/250k-word performance acceptance.
No saved-review store, dispositions, suggestion application, provider, connected
Review workspace or real save path is implemented here. 039 T011/T012 stay partial.
