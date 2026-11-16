# Tasks: chapter history

**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)

Tasks are ordered. `[P]` means safe to do in parallel within a phase. Storage and retention decisions
are accepted; T002 records decision completion only. W01 completes T001/T003/T004's format and
saved-only library core. W02 adds bounded T007–T009 core evidence below; IPC/UI, live draft/save
integration, cleanup and end-to-end acceptance remain open.

## Phase 0 — Resolve only the decisions needed by each task

- [x] T001 Resolve **OQ-001**: compare storage layouts and schemas for author-owned snapshot bodies,
  provenance, safety copies, and restore-undo records; decide how the data participates in the
  existing archive and chapter trash/restore lifecycle. Record a public decision (and ADR/format
  changes where needed) before starting dependent persistence work. This task does not authorize
  editing those documents as part of spec authoring.
  Accepted 2026-11-03 in D-175: `research/storage-layouts.md` pins the
  book/chapter/conflict/trash/archive facts against six alternatives:
  book-scoped `books/<bookId>/history/<chapterId>/` records mirroring chapter files (front
  matter plus body, loose schemas, newer-schema refusal), riding archive and whole-book trash
  by construction, staying keyed by stable id across chapter trash, with author deletion to
  chapter trash. Completed 2026-11-07: ADR 0016 and `docs/FORMAT.md#chapter-history` record
  the field/label/source/read/failure contracts as accepted under delegated authority before
  dependent implementation. No global decision status was changed.
- [x] T002 [P] Research and resolve **OQ-002**: decide retention, size-limit, and cleanup behavior,
  including restore-undo dependencies and safe recovery. Do not choose an age/count period by
  assumption. This decision blocks only T011; it is not a prerequisite for core snapshot and
  restore work.
  Accepted 2026-11-03 in D-176: `research/retention.md` pins unbounded
  trash/conflicts, failure preservation, and transport-only caps against auto-prune, count,
  age, and quota alternatives: no automatic pruning with trash-based
  explicit deletion and stat-based size visibility. T011's implementation remains open.

## Phase 1 — Shared snapshot contract

- [x] T003 **After T001's format/ADR work under D-175.** Define validated history record and operation types in the
  existing shared library service. Bind each record to book ID, chapter ID, source version, raw
  chapter-file hash, body hash, label, and capture time. Keep bodies and metadata in the decided
  author-owned format; reject wrong identity, unsupported schema, and corrupt bodies without
  rewriting them. Add synthetic tests through the in-memory library port.
  Completed 2026-11-07: `packages/core/src/library/history.ts` validates snapshot/safety/intent
  metadata and strict operation inputs, preserves unknown fields including nested references/results,
  and rejects malformed, foreign, future-schema and corrupt-body records without rewriting.
- [x] T004 **After T003.** Implement explicit snapshot creation and chapter-scoped list,
  open, and compare operations using only the existing checked library service/port. Verify
  creation requires a confirmed saved source and that list/open/compare do not mutate chapter
  bytes or flush drafts. Cover duplicate labels and malformed/missing records with synthetic
  fixtures.
  Completed 2026-11-07: `history-store.ts` plus the shared/desktop Library hooks capture an exact
  confirmed saved version/hash through absent-only atomic commits; list/read/compare are read-only.
  Synthetic evidence includes duplicate labels, source changes during capture, persisted identity,
  missing/unavailable records, storage failures, unverified commit responses, and real DraftBuffer
  retention beside desktop filesystem reads. The host's live save-state gate is part of T005/T006;
  the core accepts no draft text and has no flush capability.

## Phase 2 — API and author-facing history

- [ ] T005 Expose history operations through the existing validated IPC/shared-runtime boundary.
  Keep filesystem access out of the renderer and use the shared library service for desktop and
  browser targets. Add contract tests for invalid IDs, labels, and request/result errors.
  Partial desktop evidence: desktop IPC and preload for capture, list, read, and compare, with
  draft and kept-failed-flush refusal and a focused synthetic test. Browser shared runtime, the
  mounted entry point, and restore stay open. T005 stays unchecked.
- [ ] T006 Add a chapter history entry point and read-only list/open/compare UI using existing
  shared components and token conventions. Show labels, capture times, source versions, corrupt or
  unavailable states, and whether a comparison excludes an unsaved editor draft. Test author-visible
  outcomes and keyboard/focus behavior with synthetic chapters.
  Partial W02 UI delivery (2026-11-07): `packages/app/src/components/chapter-history/` provides an
  isolated injected-API dialog for saved-only capture/list/open/compare, literal bodies and changed-span
  comparison, stat sizes, individual issues, source/draft disclosure, focus/selection and asynchronous
  lifetime guards. See its README for the exact host contract. The entry point, real host draft gate,
  IPC/preload/browser adapters and light/dark/reduced-transparency visual acceptance remain parent
  integration work; T006 stays unchecked. No restore/undo or deletion action is exposed.
  Partial desktop entry (2026-11-16): the desktop writing screen opens that dialog from More for the
  selected chapter when the host exposes history. The visit id is new for each navigation lifetime,
  and the revision counts saved, draft, and save-state transitions. Browser runtime, restore, undo,
  and delete stay open. T005 and T006 stay unchecked.

## Phase 3 — Checked restore and its undo

- [ ] T007 **After snapshot storage under D-175.** Implement restore preflight and confirmation: require explicit
  resolution of pending drafts, show the saved current body and selected snapshot, and retain the
  current saved body as a visible safety snapshot before writing. If safety-snapshot creation
  fails, prove that the chapter remains unchanged.
  W02 partial core evidence: strict saved-source/selected-reference requests; exact current version
  and raw hash checks; verified visible safety snapshot and prepared intent before chapter writing.
  Host draft/save gating and author confirmation are not implemented, so this task remains open.
- [ ] T008 **After T007.** Restore only the snapshot body with the current read's
  `baseVersion` and `baseHash` through the existing checked chapter writer. Preserve metadata and
  normal conflict behavior. Test stale/external changes, cancellation before and after the safety
  snapshot, write failure, delayed result, and draft preservation with the in-memory writer and
  isolated synthetic libraries.
  W02 partial core evidence: shared unlocked journal-aware checked writer under the existing book
  queue; raw current metadata preserved, including unknown runtime-name fields; exact checks even
  for equal bodies; cancellation/failure and competing-writer tests. Desktop synthetic DraftBuffer
  test retains racing text for normal conflict handling; live host coordination remains open.
- [ ] T009 **Required with T008 before exposing restore.** Persist a restore-specific undo tied to the exact committed
  post-restore version/hash. Persist a prepared intent before chapter commit and reconcile it after
  interrupted finalization; undo through the same checked writer, refuse a stale undo, and retain
  all snapshot material. Test success, reload, interrupted finalization, stale base, second writer,
  and recovery of both versions using synthetic fixtures.
  W02 partial core evidence: exact precomputed/final result identities, expected-hash intent updates,
  reload-stable undo and read-only conservative reconciliation with no replay. Legacy prepared
  intents without exact identities cannot enable undo; interrupted undo plans require review.
  Author-facing recovery, validated IPC and complete integrated acceptance remain open.
- [ ] T010 Add explicit success, stale, canceled, and failed states to the restore UI. A confirmed
  commit may update a clean editor only as an identified restore result; a racing draft remains
  visible and is not flushed or replaced. The interface must not report a commit as canceled or
  blindly retry an uncertain result.

## Phase 4 — Retention, lifecycle, and integration

- [ ] T011 **Under accepted D-176.** Implement the accepted snapshot size/retention/cleanup
  behavior. Preserve required restore-undo data, make any destructive cleanup author-visible and
  recoverable, and test policy boundaries with synthetic snapshots. No automatic pruning, quota,
  expiry or compaction is authorized; include unapplied intents in preservation tests.
- [ ] T012 **Under accepted D-175, after storage exists.** Verify the selected snapshot layout follows chapter identity
  through rename/reorder and follows existing trash/restore behavior; verify portable archive
  export/import preserves history records and hashes without making archive import a chapter
  history action. Update format/archive documentation only as required by the accepted decision.
  W01 core evidence: actual snapshot round-trips through live-book archive, whole-book trash/archive/
  restore, chapter trash/restore, title/filename/order changes; future/unknown-field history bytes
  survive transport. Remains open for the complete safety/intent/restore journey delivered by W02.
- [ ] T013 [P] Cover storage-full, permission-loss, corrupt record, wrong identity, cancellation,
  interrupted response, and stale restore/undo paths at library boundaries. Use only the existing
  checked library writer, synthetic fixtures, the in-memory port, and isolated temporary
  libraries; never use real manuscripts, credentials, live providers, paid services, or devices.

## Phase 5 — Verification and documentation

- [ ] T014 Run relevant unit/contract tests, typecheck, and isolated desktop/browser smoke journeys.
  Confirm the existing editor undo, agent-turn checkpoint, archive, and sync-conflict journeys are
  unchanged. Record actual results; do not claim acceptance until they pass.
- [ ] T015 Update the public format, archive references, decision record, spec index, and changelog
  as required for the implemented storage choice. Keep chapter history described separately from
  editor undo, agent-turn checkpoints, whole-library archives, and sync conflicts.

## Dependency notes

### W02 bounded core evidence (2026-11-07)

- `history-restore.ts` plus narrow LibraryService/desktop facade integration implements restore,
  restore-specific undo and read-only reconciliation. No second queue/writer, automatic pruning,
  quota, deletion, draft flush, IPC or UI was added.
- Focused synthetic history/restore/library/identity/damaged-file regressions: **129 passed,
  0 failed, 832 assertions across eight files**. Includes two-writer conflicts, same-body stale
  checks, cancellation, history/chapter faults, uncertain readbacks, failed finalization, unknown
  metadata, reopen/undo, real filesystem archives carrying safety/intent through live/trash state,
  preservation of a racing desktop draft as a normal conflict copy, and quiet successful restore/
  undo despite unrelated malformed chapter candidates (no legacy catalog scan from history).
- Workspace desktop node/web, browser and toolkit typechecks passed. Strict standalone checking
  of new core/desktop tests and their imported closure passed. Focused lint has only the existing
  LibraryService watch non-null-assertion warning. Parent owns full verify/coverage/build/e2e and
  independent candidate review. T007–T009 and T014–T015 remain unticked.

### W02 isolated UI evidence (2026-11-07)

- `bun test apps/desktop/tests/chapter-history-ui.test.tsx apps/desktop/tests/dialog-focus.test.tsx`:
  **40 passed, 0 failed, 188 assertions** (36 new history UI cases and four shared focus regressions).
  Synthetic callbacks cover individual unavailable records, literal/Unicode bodies, source/draft
  disclosure, invalid labels, duplicate submission, uncertain capture review, read/compare failures,
  selection and source races, navigation ABA, close/reopen, unmount and focus return.
- Desktop `tsconfig.web.json` and `tsconfig.node.json` no-emit typechecks passed; focused Biome lint
  passed for the new leaf and test. Only the new test's desktop include/exclude entries were added.
- These are isolated component receipts, not IPC/host-gate, visual, browser or full application
  acceptance. T005/T006/T014 remain open; parent owns mounting and integrated gates. Restore/undo,
  retention cleanup and book-level size totals are not delivered by this UI leaf.

### W02 review correction evidence (2026-11-07)

- Corrected partial-front-matter restore/undo results: raw omitted/unknown fields stay intact, while
  successful runtime Chapters retain validated fallbacks. Added restore/reopen/undo regressions for
  distinct and same-body operations, including unknown fields named after runtime properties.
- Bound capture-retry release to an explicit successful refresh begun after the uncertainty. Both
  older success/failure replies keep retry blocked. Close is synchronously idempotent, including a
  throwing or re-entrant callback and a pending capture.
- **175 focused tests passed, 0 failed, 1,146 assertions across ten files**. All workspace typechecks
  and the strict core/desktop restore-test closure passed. Focused lint has one existing Library
  watch non-null warning. Five native Chromium scenarios passed: both stale-refresh outcomes,
  normal/throwing re-entrant close, and native Enter/focus trapping/Escape return.
- This combined candidate still requires fresh independent review and integrated gates. Host/API/
  workspace mounting, restoration controls, recovery/deletion journeys and T006–T009 remain open.

### W01 validation evidence (2026-11-07)

- Focused command: `bun test packages/core/tests/chapter-history.test.ts packages/core/tests/chapter-history-storage-premises.test.ts packages/core/tests/chapter-history-retention-premises.test.ts packages/core/tests/library-service.test.ts packages/core/tests/archive.test.ts apps/desktop/tests/chapter-history.test.ts apps/desktop/tests/library.test.ts`.
  Result: **82 passed, 0 failed, 445 assertions** across seven files, including the W15 follow-up
  for a commit that publishes successfully and then fails readback (retain the complete record,
  report uncertainty, no automatic retry).
- `bun run typecheck`: passed for desktop node/web, browser and toolkit. A strict standalone
  TypeScript check of the new core test also passed with desktop/root `@types` roots supplied,
  because that file is outside desktop's test include. Focused Biome lint: four new files clean.
- No full suite, hidden app, browser/device, real library, credential, live provider or release run
  is claimed. T014/T015 remain open for integrated acceptance and coordinator-owned public records.

### Coordinator codec/adapter follow-up (2026-11-07)

- Resolve W01's independent F1/F2 findings: history/source YAML parsing never emits source excerpts;
  book parser errors are safely summarized. The accepted plain-value metadata domain rejects
  unsupported tagged/reserved/cyclic/foreign values and lossy numbers before they can change type.
  Metadata is captured before asynchronous serialization; supported nested fields survive.
- Integrate the independently accepted static filesystem containment repair. Add metadata-only
  unsupported-entry inspection so a linked history record is listed unavailable without following
  it. Ordinary archive traversal keeps excluding links/special entries. No path-swap/CAS claim.
- **118 focused tests passed, 0 failed, 874 assertions across 11 files**: history codec/service,
  history storage/retention premises, real filesystem history and containment, port conformance,
  ordinary chapter identity/damaged-file handling, Library service and watcher/own-write behavior.
  Real history tests cover history-directory/chapter-directory/record links to outside, inside
  excluded storage and broken targets, plus byte-exact live/trash archive round-trips.
- All workspace typechecks passed; focused strict source/test typecheck passed. Focused lint has
  one existing Library-service non-null assertion warning. Both completion DAGs pass. A fresh
  combined-candidate review and integrated gates remain required; T014/T015 stay open.

- OQ-001 is resolved by D-175. T001's format/ADR follow-through and T003's schema still precede
  persistence; archive/trash tests accompany the first durable snapshot slice.
- OQ-002 is resolved by D-176. T011 implements that policy; all paths report storage failures
  without pruning existing data. The decision checkbox is not implementation acceptance.
- Every test fixture is synthetic and isolated. No task authorizes access to real manuscripts,
  credentials, live providers, paid services, or devices.
