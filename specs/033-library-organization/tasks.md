# Tasks: library organization, goals and source-anchored notes

**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)

Tasks are ordered. D-166–D-168 and ADR 0017 are accepted; dependent implementation may proceed.
Implementation and acceptance tasks remain open. Tests use synthetic isolated fixtures.

### W08 first core slice — November 7, 2026

`packages/core/src/organization/goals.ts` now supplies a bounded loose goal schema and Library-owned
set/clear/read/current-no-op policy over the shared checked sidecar engine. Saved progress rechecks
complete saved chapter enumeration/identity/version/hash/body and issue sets plus the goal token;
results distinguish complete, incomplete and unavailable. Focused tests are in
`packages/core/tests/organization/goals.test.ts`; planning tests exercise the common write/failure
boundary. FORMAT documents both sidecars, raw baseline/typed-draft requests and recovery copies.

This is partial T004/T007/T012 core evidence. Parent-owned LibraryService queue/commit/saved-read
hooks, package exports, API/IPC, goal UI and integrated adapter checks remain required. The next
vertical slice can expose one explicitly saved goal and last-confirmed saved progress with dirty,
pending and conflict labels. Collections/recents are unimplemented here. Annotation persistence and
navigation wait for W10's shared saved-body-span verifier; no duplicate verifier was introduced.
All broad tasks remain unchecked because this leaf delivery does not complete their full scope.

## Phase 1 — Resolve dependent decisions

### W08 bounded goal integration — November 7, 2026

The workspace now supports set → reopen → clear through the open Library, validated desktop/browser
transport and checked dialogs. Saved progress uses fresh complete enumeration, independent raw-source
verification and invalidation on observed saved-source changes; duplicate/unreadable/omitted inspected
files cannot confirm a partial total. Pending/dirty/uncertain navigation retains the originating view.
Real Library contention, filesystem/IPC UI journeys, browser publication/readback faults and native
focus/guard probes supply bounded evidence. The library-grid goal indicator, collections, recents,
annotations and full integrated acceptance remain open; no broad task is checked off here.

### Corrected goal/editor candidate — November 7, 2026

The combined W08 follow-up independently reads each enumerated source, checks exact raw hashes,
uses fatal UTF-8 decoding and verifies its canonical body and recorded identity/version. Invalid
bytes and false port hashes cannot produce a confirmed total; valid replacement characters and
headerless text remain countable. Two detached reads retain enumeration/change detection. Goal
and planning sidecars share lossless numeric admission, including recovery baselines. **166 focused
core/component tests** pass; workspace and strict new-core-test typechecks pass; focused lint is
clean. The shared editor correction passes **14/14 native Chromium assertions**. Independent review
ACCEPTED exact `320defb`, adding 16 core probes and seven adjacent native scenarios. Real Library
composition, complete enumeration, API/IPC and workspace exposure still remain.

- [x] T001 Resolve OD-033-01 with a per-data-type storage/versioning matrix for collections, recent
  entries, goals and annotations. Keep collections, goals and annotations in ordinary library
  files; decide whether recent pointers are library-scoped or disposable local preferences. Define
  schema/version and size limits, checked atomic-write/conflict behavior,
  corruption/future-version behavior, and portable-archive and chosen-folder sync treatment.
  Record the accepted public decision and any required ADR or
  `docs/FORMAT.md` change before dependent persistence work. This gates T004 and the persistence
  portions of T005–T008; it does not block independent view-model or interaction design.
  Accepted November 7 as D-166/ADR 0017: root collections, per-book goals/annotations, scoped host
  recents, D-164/D-165 checked/bounded sidecars and complete saved-goal counts. D-190's current
  checked book writes replace the old research's unchecked-writer premise.
- [x] T002 Resolve OD-033-02: collection identity, name uniqueness, one-versus-many membership,
  idempotent add/remove behavior, and same-identity book trash/restore handling. Record the public
  decision before collection persistence. Blocks T005 only.
  Accepted November 7 as D-167/ADR 0017: immutable host-generated `col_` identity, many-to-many
  membership, NFC/lowercase active-name keys, exact-ID unavailable handling and reversible archive.
- [x] T003 Resolve OD-033-03: serialized passage anchor, source verification, stale detection,
  navigation and explicit re-anchor behavior. Test unchanged, edited, moved, repeated, missing,
  Unicode and line-ending cases with synthetic chapters. Record the public decision before
  annotation persistence/navigation. Blocks T008 only.
  Accepted November 7 as D-168/ADR 0017: exact identity/version/raw hash plus half-open UTF-16 body
  offsets and literal excerpt, rather than the historical line-only proposal; no fuzzy fallback.
  Actual source and clean destination editor must match before selection; feature tests remain T008.

## Phase 2 — Shared checked data services

- [ ] T004 After T001, define validated, versioned records and service operations for the accepted
  storage locations in the shared core/library boundary. Use the existing library port and checked
  atomic write path; refuse corrupt, unsupported-future or stale-base writes without replacing old
  bytes. Add in-memory and temporary-library tests for round-trip, idempotence, conflict, failure,
  path safety and schema refusal. Do not add a database-only source of truth.
  Partial evidence only: collection and annotation services, a library-root collection queue, and
  synthetic tests. The box stays open.

## Phase 3 — Author-facing surfaces

- [ ] T005 After T001, T002 and T004, add collection create, rename, remove, membership and empty
  states to the existing library view. Cancel preserves the last saved state; removing a collection
  never trashes a book. Test with synthetic libraries and assert every manuscript file is unchanged.
- [ ] T006 After T001 and T004, add a “Continue writing” list driven only by successful explicit
  book opens. De-duplicate by stable identity, order newest-first, make unavailable references
  dismissible, and keep the book usable when recent-data writes fail. Test reopen, missing identity,
  trash/restore and failed-write cases with synthetic libraries.
- [ ] T007 After T001 and T004, add one optional total-word goal per book and show saved words and
  remaining words in the library/workspace. Use the existing counter; show any draft estimate
  separately. Test below/met/exceeded goals plus dirty, pending, failed, conflicting and incomplete
  saved states with synthetic chapter text.
- [ ] T008 After T001, T003 and T004, add bookmark/note create, inspect, edit, open, explicit
  re-anchor and remove flows. Require a confirmed saved source; retain stale entries and their
  notes without selecting a guessed passage. Assert annotation operations do not change chapter
  bytes, version or prose. Test source changes, duplicate passages, missing chapters, cancel and
  failed writes with synthetic fixtures.

## Phase 4 — Preserve existing journeys and integrate

- [ ] T009 Integrate the new surfaces without replacing spec 002's canonical library listing,
  existing search scope, shared counts, update ordering or trash/restore. Verify deleting/restoring
  a book continues through the existing recoverable trash path and does not match another book by
  title.
- [ ] T010 Check onboarding and mobile integration against specs 002 and 014: no new onboarding
  flow or blocked create/open/import journey; no duplicate mobile shell; preserve existing
  navigation, safe areas, keyboard access and touch targets. Use synthetic content at 393 × 852,
  744 × 1133 and 1440 × 900, and check no horizontal overflow.

## Phase 5 — Boundary verification and documentation

- [ ] T011 Run the affected shared-core, component, typecheck, build and isolated smoke journeys.
  Verify storage write failures preserve the old record, stale anchors never select unrelated text,
  drafts never appear as saved goal progress, and no test touches a real profile or manuscript.
- [ ] T012 Update `docs/FORMAT.md`, the accepted public decision/ADR records and any owning spec
  integration notes to match the chosen storage, schema, archive and anchor behavior. Update the
  public roadmap and changelog only as part of a separately authorized implementation delivery.

## Dependencies

- T001 gates persistent storage work for all four data types; it does not block isolated UI design.
- T002 gates collection persistence and membership behavior only (T005).
- T003 gates source-anchor persistence, navigation and re-anchoring only (T008).
- T006, T007 and T008 use the checked services from T004 and do not add a writer for chapter text.
- T009–T010 preserve the ownership in specs 002 and 014; they do not duplicate those journeys.
- T011–T012 follow the accepted decisions and implementation; all tests remain isolated and
  synthetic unless a separate authorization changes that boundary.
