# Tasks: manuscript review

**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)

Tasks remain open unless checked below. Tests and UI journeys use synthetic text in isolated fixtures;
no real manuscript, credential, live provider, paid service or device is in scope.

## Phase 1 — Resolve only the decisions needed for the first milestone

- [x] T001 Review the proposed first metric set and repeated three-token phrase normalization using
  synthetic examples. Record the public outcome before implementing the phrase scanner or its UI
  wording. This decision blocks only the phrase scanner and its related report copy. Decided
  2026-11-03: word count and coverage only for the first report; the phrase signal is deferred, and a
  future signal unifies curly and straight apostrophes. Recorded in spec.md decision 1.
- [x] T002 Confirm the initial host surfaces and verify that each selected surface can provide saved
  chapter text plus version/hash revalidation through its existing storage boundary. This blocks only
  host-specific UI wiring; it does not block pure core contracts and tests. Decided 2026-11-03:
  desktop first through the shared app component; browser and mobile reuse it later after proving the
  same saved version/hash revalidation. Recorded in spec.md decision 2.
- [x] T003 Record a follow-on decision on whether reports may be saved/exported and what retention,
  excerpt and deletion rules apply. This is not a prerequisite for the volatile first milestone; no
  persistence work is included here.
  Research recorded 2026-11-03 (not accepted): `research/report-retention.md` pins the report
  shape (references and excerpts, never bodies; unbounded excerpts; computed freshness) against
  the volatile baseline; D-171 proposes narrow export with capped excerpts and markings, JSON
  save under `books/<bookId>/reviews/` with a 20-per-book cap, explicit and book-fate deletion,
  and archive/sync exclusion. Historical proposal replaced November 7 by D-199/D-171/ADR 0020:
  explicit save, recoverable author-owned feedback, no pruning and truthful archive/sync inclusion.
  Detailed formats and implementation remain 039 T014–T015.

## Phase 2 — Read a confirmed saved snapshot

- [x] T004 Define the core run request/result and source snapshot contracts: book scope, chapter
  identity/order/title, saved body, version/hash, run status, coverage, metric definitions and
  evidence span. Keep the result run-local and do not add a library format field.
- [x] T005 Add the smallest read-only book snapshot/revalidation operation through the current
  storage port and validated application boundary, only if existing APIs cannot provide it. Tests
  use a synthetic temporary library and assert chapter bytes, hashes, versions, checkpoints and
  other files are unchanged.
- [x] T006 Block a run while any in-scope chapter has unsaved edits. Offer the existing explicit save
  path or cancel; start only after confirmed saves. `EditorHandle.flush()` exposes saved, conflict and
  failed outcomes, and `runAfterReviewSave()` enforces the choice and refuses to run after an
  unconfirmed outcome. The workspace Review manuscript action is wired to live editor state: a dirty
  buffer opens the save gate dialog, the explicit save path flushes the editor and re-reads a fresh
  snapshot, and conflict, failure or cancel never starts the run. Tested successful save, conflict,
  failed save and cancellation with synthetic isolated fixtures.
- [x] T007 Reuse the existing shared word counter for per-chapter and book totals. Test empty text,
  whitespace-only text, punctuation tokens and the `one — two` example against the public count
  contract.

## Phase 3 — Deterministic findings and honest run states

- [x] T008 Implement D-198/FR-005 repetition v1, now accepted after T001's historical deferral:
  unify curly and straight apostrophes, keep original spans and combining marks, count every
  overlapping three-token window in pure core with deterministic occurrence ordering and exact source
  spans, covering punctuation/case normalization, repeated phrases, overlapping phrases and
  chapter-boundary behavior with synthetic fixtures.
  November 8, wave 19: `core/review/repetition.ts` scans all overlapping three-token windows,
  folds NFC/case/apostrophes only in comparison keys, retains literal UTF-16 evidence and rejects
  malformed chapters with explicit skipped coverage. Sync and yielding async analysis share the
  scanner. Dedicated synthetic tests cover Unicode, exact spans, overlap/chapter boundaries,
  deterministic ordering, cancellation, immutable inputs and 120-chapter/250k-word books.
- [x] T009 Produce coverage for every in-scope chapter: included with prose, included but empty, or
  skipped with a safe author-visible reason. Distinguish partial coverage, insufficient evidence,
  source failure and a complete report with no phrase findings.
- [x] T010 Add cancellation and source-staleness checks. Cancellation discards partial output; changed
  source versions/hashes mark the report stale and prevent navigation to old evidence. Test both
  during a run and after report completion.

## Phase 4 — Author-facing report

- [x] T011 Add the explicit Review manuscript entry and report view for the host surfaces selected
  by T002. Show run time/scope, studio word counts, metric definitions, coverage and findings. Do not
  add chat, a quality score, model calls or write actions. Shipped on desktop first (header and mobile
  menu) through the shared app component the other hosts reuse; the report shows run scope/time,
  studio counts, coverage, the word-count definition and an honest empty-findings state. No chat,
  score, model call or write action is in the path. Covered by renderer and workspace integration
  tests plus a smoke start/results check.
- [x] T012 Add exact evidence navigation from a finding to the unchanged saved chapter span. Recheck
  the version/hash before navigation; if stale, explain why and offer a new run instead of selecting
  a different passage. The findings list navigates through `revalidateReviewEvidence` against a fresh
  snapshot, selects the exact span in the editor, and disables navigation while stale. Tested with
  synthetic findings; live findings arrive with the T008 scanner.
- [x] T013 Keep the report volatile: a new run replaces it; changing books and closing/restarting the
  app discards it. Verify no report, excerpt or retention metadata is written to library, profile,
  index, thread or usage storage. The report lives in workspace state only, is replaced on a new run
  and cleared on book change; the run path calls read-only `books.open`, and the integration test
  runs with no writer mock, so a manuscript write would fail the test instead of slipping through.
- [x] T014 Add visible run progress only where it reflects real work, a cancel control, and clear
  stopped, partial, stale, insufficient-evidence and failure copy with the next safe action. The run
  shows a reading state with Cancel run, and stopped, failed, partial, stale and insufficient-evidence
  states each name the next safe action. Covered by renderer tests.

## Phase 5 — Verification

- [x] T015 Add pure-core, storage-boundary and renderer tests for the acceptance scenarios, using
  synthetic isolated fixtures only. Assert no provider/network calls and no manuscript writes.
  Covered: save-gate choice/save/conflict/failure/cancel, word-count parity including the `one — two`
  example, coverage, stale blocking, insufficient evidence, disposable replacement, and an integration
  run with no writer mock (a manuscript write would fail the test). The repeatable-phrase scenario
  stays with the deferred T008 scanner. No provider or network call exists on the run path.
- [x] T016 Add a synthetic-fixture smoke journey for start, results, evidence navigation, stale
  state, cancel and insufficient evidence on each selected host surface.
  Completed 2026-11-25 for the desktop-first scope in T002. The unpackaged macOS arm64 build
  at `e796143` passed 52/52 official smoke checks. All six manuscript review checks passed.
  Keep writing preserved the unsaved edit, and a report opened on saved text. Opening a repetition
  occurrence selected exactly “The lighthouse keeper” in The Light. A changed chapter made the
  report stale, and a new run replaced it. An empty book reported insufficient evidence, and
  Cancel run stopped a delayed read before analysis. The run used an isolated synthetic library.
  The verified tree merged in [PR #127](https://github.com/JordanM575/open-book-studio/pull/127).
  Inline viewing and retained reports have their own T018 and T019 acceptance.
- [x] T017 Review keyboard and screen-reader access for definitions, coverage, findings, status and
  cancellation; use the existing design tokens and honor reduced motion/transparency. Sections use
  labelled headings, actions are named native buttons, status and stale updates use live regions, the
  dialog traps focus via the shared dialog primitive, and no new motion was added. Covered by a
  renderer role/label test; no manual screen-reader pass was performed.

## Dependency notes

- T001 records the initial counts-only choice; D-198 now unblocks T008 and its exact metric copy.
- T002 is recorded (desktop first); browser and mobile reuse the shared component after proving the
  same saved version/hash revalidation, and T016 journeys for those surfaces wait on that.
- T003 is decided under ADR 0020. New writers still require detailed format/continuation and
  recovery review; ordinary unsaved analysis remains write-free.
- No model-backed task is included. A separate spec must settle provider disclosure, cost/unknown
  price, consent, data-use terms and no-write behavior before any such task is planned.

- [ ] T018 Connect real repetition findings to D-197's exact-current inline adapter/sidebar; test
  complete overlap/occurrence paging, long books, Unicode, dirty/stale suppression and no network.
  November 8, wave 19 partial delivery: the explicit Review manuscript journey now receives actual
  findings from async analysis. The dialog exposes repetition-v1's definition, complete coverage and
  counts, five sequences per page and ten occurrences per sequence page; paging never trims results.
  DOM tests traverse all occurrence/sequence pages and verify retained keyboard focus. The existing
  Workspace callback selects an actual finding's exact saved span and refuses a changed revision;
  synthetic spies observe no chapter/draft/metadata writes or provider sends. The local analyzer
  also runs with immutable input and a refusing network spy. Wave 21 below adds final dirty/view
  checks for this dialog navigation seam; inline-layer mounting, native accessibility and
  remaining-host acceptance remain coordinator-owned.
- [ ] T019 Complete 034 T016's real-finding navigation and retained-report adapter using 039's shared
  explicit-save/export contracts; keep analyzer/source version and actual coverage in every output.

### Wave 19 evidence boundary

T008's historical deferral in the dated T012/T015/T016 notes is now resolved by actual scanner
output. T016, T018 and T019 remain open: this candidate's evidence is pure-core and synthetic DOM,
not a new native/smoke, retained-review, provider-quality or release acceptance. Ordinary review
remains volatile and read-only. Fixed-slice word counting preserves the shared whitespace counter
even for unbroken tokens; scan/grouping and cross-chapter budgets yield for cancellation. Performance
measurements are local Bun/macOS observations, not new cross-platform performance baselines.

### Wave 20 runtime correction and evidence boundary

Independent review reproduced R1 on wave 19: a valid token containing `a`, 65,536 U+0315 marks
and 65,536 U+0300 marks blocked whole-token NFC for about 31 seconds. Scanner yields alone do
not establish T010/FR-009 responsiveness; independently normalizing arbitrary chunks would change
the accepted Unicode rule. The pure sync/cooperative entries retain their exact algorithm and now
document this limit.

Interactive Workspace analysis now uses one owned module worker per explicit run. Cancel terminates
that worker, removes listeners and discards queued replies; a rerun gets a new worker. Startup,
load/runtime/deserialization/send failures and missing startup acknowledgement fail honestly with
no heavy inline fallback. The startup deadline does not cap analysis or omit valid text. Book/library
changes, dialog dismissal and unmount abort owned work; old run-acquisition reads and worker replies
cannot update a newer run. Independent wave 21 review found that separate reopen and navigation reads
were not covered by that claim. No saved-review API, path, mount or writer is added by this correction.

Focused synthetic evidence covers real native-NFC entry in an in-process Bun worker at the reproduced
131,083-unit size, main-loop heartbeats, cancellation before NFC completion, actual Workspace Cancel
and Run again, and a smaller adversarial completion with exact native-normalized keys and all original
spans. Worker transport retains all 249,760 overlapping occurrences from 120 chapters / 250,000 words.
Protocol doubles separately cover failures and queued late-reply isolation; they are not performance
evidence. Existing core large-book/cancellation and report paging/navigation/save-gate tests pass.

T016/T018/T019 stay open. Build/CSP paths were inspected, but coordinator-owned integrated builds,
actual browser/Electron startup/cancel/performance and remaining-host/native accessibility checks
were not executed here. Full occurrence transport still has structured-clone and memory costs; there
is no arbitrary-input latency or memory ceiling. Explicit retention/continuation and inline mounting
remain separately owned. Wave 21 below corrects the dialog's final editor navigation boundary; its
native and remaining-host acceptance is still open. 038 T022 remains unchecked.

### Wave 21 navigation lifetime correction and evidence boundary

The report reopen, new-run and evidence-navigation paths now invalidate or reject obsolete reads,
late failures and selections on supersession, dialog close, book/library or committed chapter/view
change and unmount. Commit-time invalidation also covers an earlier chapter switch whose save finishes
after a newer reopen. Cancel remains available during a newer worker run. Navigation revalidates the
saved evidence and the mounted editor's visit, source epoch, version/hash/body and live clean state;
dirty, saving, failed, composing or held buffers are refused without replacing them. Cross-chapter
navigation checks the old visit at the switch and the new editor at selection. No fuzzy fallback is
introduced.

Malformed worker envelopes and required coverage/finding metadata fail closed, with incremental host
validation and lazy checks of displayed occurrence pages rather than a full UI-thread span traversal.
Focused synthetic tests and unchanged independent probes cover the reproduced races, both late read
outcomes, editor state, malformed replies, Unicode, paging and all 249,760 transported spans. These
are Bun/happy-dom observations, not native acceptance or an arbitrary latency/memory ceiling.

T016/T018/T019 remain unchecked: inline-layer mounting, retained review/continuation, real native
navigation and accessibility, browser/desktop worker URL/CSP/packaging, other hosts and release gates
still need their owners. 038 T022 remains unchecked. A fresh independent review must inspect the
corrected exact head; earlier broad gates applied to the previous head only.

### Wave 24 visible evidence and display freshness boundary

Each displayed excerpt is explicitly unverified until opening it checks its exact saved literal,
bounds, UTF-16 surrogate boundaries and source identity. A span that cannot be verified leaves the
report unavailable for evidence navigation until rerun. Bounded visible-page shape/metadata checks
and two-level paging retain the complete result; they do not synchronously inspect every span or
retain a second manuscript body in the report. Current-report malformed-page effects invalidate
pending navigation independently of navigation generation; superseded reports cannot fail newer runs.

The initial report and reopened reports check source freshness before enabling navigation; a report
already invalidated by bad evidence stays unavailable across reopen until rerun. Checking and
read-failure states are explicit; an author can cancel the initial check, retry a failed read or run
again. Changed sources are labeled stale with affected chapters. Guarded reads do not replace the
live editor. Synthetic tests cover malformed later pages, valid later-page selection, first-display
and reopen success/failure races, cancellation, view and identity changes, and unchanged buffers.

These are focused Bun/happy-dom observations, not independent exact-head, native, remaining-host,
provider or release acceptance. T016/T018/T019 and 038 T022 remain unchecked; retained-review
continuation, inline mounting, native accessibility and worker packaging/CSP remain separately gated.

### Wave 26 selected finding association and navigation reads

Opening an occurrence now verifies its association with the selected repetition-v1 comparison key
and both complete source-token boundaries. The check uses the scanner's Unicode letter/number/mark
and internal-apostrophe grammar, NFC, case folding and apostrophe normalization; it preserves the
literal source. This selected-claim check runs in a disposable worker because native NFC can be
non-cooperative. It checks neither other occurrences nor aggregate counts. Sequence names, counts
and excerpts are explicitly unverified, with all results retained through paging.

Navigation enters checking before its first saved-source read, disables evidence throughout
verification and re-reads the saved source after the worker finishes. The final saved/live editor
and visit guards still apply. Rejected reads produce a retryable read-unavailable state without
claiming the source changed; an explicit retry checks freshness but does not itself select a passage.
False associations stay evidence-unavailable across reopen until a new review. Dismissal, rerun,
book/library changes and unmount abort owned verification and ignore late replies.

Synthetic checks cover swapped evidence, forged labels, partial letter/mark/astral/apostrophe tokens,
valid normalized Unicode and punctuation, an independent regex endpoint oracle, both navigation-read
failures and explicit retry, source/live edits during verification, and obsolete replies. Real
in-process Bun workers separately demonstrate heartbeat and cancellation during native NFC for
both analysis and selected-evidence verification. These checks do not establish browser/Electron
packaging, device or release acceptance. T016/T018/T019 and 038 T022 remain unchecked.
