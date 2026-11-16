# Tasks: guided and autonomous authoring

**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)

Tasks are ordered by their actual prerequisites. D-193 and D-194–D-196 accept the foreground and
full-book contracts; reviewed shared storage/host integration remains required before execution.
Decision completion does not check implementation tasks.

W10 (2026-11-07) implements the pure envelope/citation/read-facade portions in new core leaf modules;
see the plan's implementation slice. No whole runtime/UI task below is completed by those modules.

## Phase 0 — settle the Phase 1 contracts

- [x] T001 Resolve U-037-01: agree and record the exact source payload, pre-send disclosure and local
  conversation-record behavior for a model review. This blocks only the provider request and
  disclosure work in T004–T005. Accepted in D-193 / ADR 0018 (November 7): immutable explicit source
  envelope and snapshot-only tools; conversation-safety integration precedes new durable parts.
- [x] T002 Resolve U-037-02: agree and record the author-visible citation location and revision
  contract, including how the shared library detects a changed source. Accepted in D-193 / ADR 0018:
  exact source token plus UTF-16 span/quote and derived human labels. T006–T007 still implement it.

## Phase 1 — foreground, read-only guidance

- [ ] T003 Add a foreground review entry point for an author-selected passage or chapter and optional
  explicitly selected sources. Keep it in the existing agent conversation and lifecycle; do not add a
  background control or change close, quit or notification behavior.
- [ ] T004 After T001, show the selected connection/provider, model and exact source scope next to an
  explicit provider-named review action. Verify existing connection, model capability and consent
  checks run before any request; do not silently switch provider or model.
- [ ] T005 After T001, send only the disclosed selected content and explicit sources. A cancel before
  starting the action must send nothing. Use the existing provider path; do not add a proxy or new
  credential store.
- [ ] T006 After T002, capture the source revision and render each source-backed observation with an
  author-readable, resolvable citation. Do not display internal IDs, hashes or raw tool payloads.
- [ ] T007 After T002, compare the captured source revision with the current source before presenting
  the response as current. Mark changed/missing sources stale or unavailable and offer an explicit
  rerun without refreshing silently.
- [ ] T008 Restrict the review turn to enabled built-in `read`-tier tools. Exclude plugins, writes and
  destructive tools, and enforce the refusal at execution time as well as at model tool selection.
  Respect the selected scope and the book's disabled-tool settings.
- [ ] T009 Implement stop, refusal, provider failure and source-read failure states. Preserve the
  prompt/scope for retry, identify incomplete work, release the busy state and leave every manuscript
  file unchanged. Explain that already-sent content cannot be recalled.
- [ ] T010 After T001–T009, add synthetic isolated-fixture tests for request scope/disclosure, cancel-before-send,
  read-only enforcement, untrusted manuscript/tool text, valid citations, stale revisions and failure
  paths. Assert fixture files remain byte-identical; do not use real manuscripts, credentials or live
  providers.
- [ ] T011 Check the review journey with keyboard-only and accessible status announcements. Verify the
  configured provider, source scope, stale state, stop and retry actions are understandable without
  relying on color or raw identifiers.

## Phase 2 — accepted autonomy decisions

- [x] T012 Resolve U-037-03 and U-037-06: decide whether any autonomous authority is allowed, its
  permission/tool scope and revocation rules, and what independently testable evidence qualifies as
  verified. Record public decisions and synthetic/adversarial evaluation criteria. Review the
  constitution and AGENTS.md; if a principle changes, accept the required ADR and both amendments
  before dependent implementation.
- [x] T013 Resolve U-037-04: define ownership, storage, versioning, conflict handling, retention,
  author review and publication rules for any future candidate. Decide explicitly whether automatic
  publication is prohibited or may be separately authorized. No candidate implementation starts
  before acceptance.
- [x] T014 Resolve U-037-05: define worker ownership, stop/cancel, errors, close/quit, notification,
  schedule and restart/recovery contracts. Keep D-126 limited to one explicitly opted-in background
  turn; do not change current lifecycle while this remains open.
- [x] T015 Resolve U-037-07: accept cost/duration limits and the policy for remote delivery, including
  provider-reported unknown prices. D-116 Proposed and D-129 Deferred are not authorization. This
  blocks only budgeted, scheduled or remote implementation.
- [x] T016 After the applicable decisions and contracts are accepted, write or amend a public
  implementation spec for the selected autonomous capability, with measurable verification, failure,
  cancellation, safety, ownership and recovery behavior. No autonomous implementation or acceptance
  task may start before this gate.

T012–T016 resolved November 7 in D-194–D-196/ADR 0019, this spec/plan and the accompanying
constitution/AGENTS amendment. D-116 now selects two modes; D-126 retains ordinary per-turn policy
with an explicit 037 exception. Earlier open/Proposed phrasing above is the historical task question.

## Phases 3–12 — full-book implementation and evidence

- [x] T017 Record the individual authority/lifecycle/admission/evidence amendments (ADR 0019).
- [ ] T018 Specify and review every workflow/thread/host-permission wire schema in FORMAT before writers.
  **Partial (2026-11-07):** workflow record schema 1 — run/brief/policy/plans/directions/tasks/
  command journal/attempts/effects/questions/artifacts/contexts/admission records — is specified in
  FORMAT with a pure raw codec in `packages/core/src/authoring/wire.ts` and synthetic round-trip/refusal
  tests. Shared thread migration, host-permission schemas, checked writers, real streaming and
  independent review remain; T018 stays open.
  **Partial (host permission):** the schema-1 host-permission wire schema and pure codec now exist.
  A copied descriptor is not execution permission. Shared thread migration, checked writers, storage,
  streaming, and independent review remain; T018 stays open.
- [ ] T019 Implement checked/lossless shared threads, explicit migration, recoverable deletion and all callers.
  **Partial (2026-11-08):** v1 conversation storage now writes through the Library's per-book queue and
  journal-aware checked raw-hash commit, verifies readback, keeps stale intended documents as
  verified conflict copies, preserves supported unknown plain fields, treats unknown roles/parts and
  a newer `schemaVersion` as read-only, refuses malformed/lossy/oversized files without rewriting them,
  makes an equal body a no-op, and moves deletion to recoverable conversation trash with checked
  restore. Every v1 caller is migrated and a guard test fails if an unchecked writer returns. Explicit
  backed-up v2 semantic migration, restore UI/IPC, independent review and the T020+ settlement/execution
  journey remain; T019 stays open.
- [ ] T020 Integrate truthful stop settlement, consumer/persistence warnings and pinned-Library quiescence.
- [ ] T021 Implement pure versioned graph, dependency/direction invalidation, command identity and reducers.
  - Partial implementation evidence (November 7): isolated `packages/core/src/authoring/` provides
    validated immutable DAG/reference contracts, exact command replay checks, question/direction
    invalidation, historical late outcomes and distinct attempt/effect settlement. Focused adversarial
    tests live in `packages/core/tests/authoring/`; no wire writer or host execution is exposed.
  - Independent F1/F2 follow-up preserves depth64 records through aggregate wrappers and validates
    Continue clocks before property access. Cross-transition regressions accompany the correction;
    fresh exact-head independent review remains required and this broad task stays unchecked.
    Local correction gates:83 focused tests, strict source/test and platform-independent checks,
    workspace typechecks and warning-free scoped lint; no writer/host/full-book evidence inferred.
- [ ] T022 Implement host permission and durable finite admission/reservations, including unknown charges.
  - Pure portion only: finite reservation/accounting decisions, injected clock/account facts, strict
    qualified-maximum versus bounded-operation cost modes, and generation changes preserving budget
    history. Host permission, durable storage and adapter qualification remain required.
- [ ] T023 Implement immutable artifact/context and checked run/task/attempt/effect/question storage.
  **Partial (2026-11-08):** `LibraryService.workflowRecords` now owns the T023 storage slice. Checked
  `run`, `task`, `attempt`, `effect` and `question` records commit canonical schema-1 bytes with the
  exact previous raw hash/revision, readback verification, bounded conflict copies and journal-aware
  commits. `artifact` metadata plus its bounded body (≤1 MiB, `.md`/`.json`) and `context` manifests
  are absent-only immutable records; a partial or mismatched artifact pair refuses. Supported unknown
  plain fields (including own `__proto__`) survive read-modify-write and newer closed-union members
  stay read-only. Focused synthetic tests cover stale/racing/missing bases, idempotent no-ops,
  malformed/duplicate-key/lone-surrogate/lossy-number/oversized refusal, artifact size and pair
  checks, foreign book/run/kind refusal and a no-unchecked-writer guard. No scheduler, dispatch,
  provider call, publication/effect execution, command/receipt-page or admission writer, IPC/preload/
  UI, deletion or pruning is added. T023 stays unchecked pending fresh exact-head independent review;
  T020–T022, T024–T042 and 038 T022 remain open.
  **Journal correction:** a definitive prepublication refusal conditionally restores only its exact
  intent receipt, preserving prior/newer same-hash plans, intervening notes and uncertain-publication
  recovery. Overlapping refused receipts do not resurrect one another. Positive synthetic regression
  matrices cover mutable/immutable/shared writers, new/existing paths, equal/different outside bytes,
  note errors and settlement order. Fresh exact-head independent review and broad gates still precede
  acceptance; journal best-effort failure and cross-process limitations remain explicit in FORMAT.
  **Verified-note ownership correction (2026-11-08):** the initiating receipt also owns verified
  baseline updates. Later accepted scans, verified/uncertain notes, removals and moves supersede
  that claim, including previously unjournaled paths. A newer definitive refusal can restore its
  predecessor's verified snapshot. The focused core set passes 211 tests; all 30 preserved v24
  probes and 51 v22 journal controls pass, alongside 90 artifact/adapter controls and strict/workspace
  typechecks. These overlapping synthetic checks do not establish live-host timing or close T023;
  fresh exact-head review and integrated gates remain required.
- [ ] T024 Add scoped attempt execution at the existing runtime seam; no ordinary full-book prompt/plugins.
- [ ] T025 Add event-driven asynchronous scheduling, account limiter, zero automatic retries and no spin.
  - Pure portion only: ready/blocked/settling projections, pinned-route capacity decisions, no-progress/
    revision ceilings and rate-limit eligibility without resend. Actual asynchronous scheduling,
    host serialization, held-transport overlap and runtime integration remain unimplemented here.
- [ ] T026 Mount small optional New book onboarding, exact brief/choices/agreement and real 033 goal.
- [ ] T027 Run independent outline/cast proposals, reconcile them and record initial author direction.
- [ ] T028 Execute incremental scene/chapter assembly, bounded completion and causal dependencies.
- [ ] T029 Publish through one checked Library effect/safety path with first-keystroke target protection.
- [ ] T030 Run separate developmental and line/continuity reviewers with exact candidate/saved citations.
- [ ] T031 Retain bounded revision/recheck lineage and integrate exact current-source underlines.
- [ ] T032 Add durable question inbox, adoption-based cadence and checked versioned author answers.
  - Partial evidence (November 9): the pure adoption-based cadence portion now exists as the
    versioned `CheckinCadencePolicy` and `evaluateCheckinCadence` in
    `packages/core/src/authoring/contracts.ts` (ADR 0019 defaults, bounded editable intervals,
    first-chapter/irreversible-choice triggers, caller-counted progress, exact-threshold due,
    all fired reasons) with synthetic tests in `packages/core/tests/authoring/cadence.test.ts`.
    The durable question inbox, checked versioned author answers, persistence, scheduling and
    host wiring remain open, the continuation adapter does not yet emit cadence, and this task
    stays unchecked.
  - Partial evidence: the recorded adoption state cadence needs now exists in pure core as
    the versioned adoption-receipt contract and pure distinct-chapter counter
    (`packages/core/src/authoring/adoption-receipt.ts`, `countAdoptedChapters` with exclusive
    sequence/adopted-at markers) plus a checked beside-store
    (`packages/core/src/workflow/adoption-receipt-store.ts`, absent-only per candidate,
    byte-exact readback, bounded listing, foreign refusal). No publisher writes receipts, no
    host counts them, and the question inbox and checked answers remain open; this task stays
    unchecked.
  - Partial evidence (publisher): the Library publisher now records a receipt on confirmed
    adoption. `LibraryService` exposes the beside-store as `library.adoptionReceipts` and
    `recordConfirmedAdoptionReceipt` records exactly one receipt at the checked effect
    confirmation (`workflowRecords.saveEffect` with phase `confirmed`, carrying
    `resultVersion`/`resultHash`), allocating the next sequence inside the per-book queue,
    recognising a retried confirmation by adoption identity, settling uncertain writes by
    byte-exact read-back, and reporting `confirmed-unrecorded` without rolling the adoption
    back when a receipt cannot be recorded. The confirmed effect does not carry `grant` or
    `direction`, so the caller supplies those references; no host counts receipts on cadence
    resume and `irreversibleChoicePending` is not yet read from recorded question state, and
    the question inbox and checked answers remain open; this task stays unchecked.
  - Partial evidence (question inbox): `projectQuestionInbox` in
    `packages/core/src/authoring/wire.ts` projects an already listed question set into
    open questions only (id, open state, and an explicit `irreversibleChoice` boolean;
    absence is omitted, not stored as false). It refuses a partial page, duplicates,
    foreign kind or owner, an unknown state, a non-boolean classification, and more
    than 10,000 inputs before inspection. Focused synthetic coverage is
    `packages/core/tests/authoring/question-inbox.test.ts`. Checked versioned author
    answers, persistence, scheduling, and host wiring remain open. This task stays
    unchecked.
  - Partial evidence (versioned answer check): `checkVersionedAnswer` in
    `packages/core/src/authoring/wire.ts` checks one already decoded open question,
    the revision the author named, one proposed answer, and the direction epoch that
    answer would create. Silence is not an answer. Exact and confirmed text stay
    separate, and the direction text must be the confirmed text. It does not write,
    step the run, schedule, or resume cadence. Focused synthetic coverage is
    `packages/core/tests/authoring/versioned-answer.test.ts`. Persistence, scheduling,
    and host wiring remain open. This task stays unchecked.
  - Partial evidence (answered question projection): `projectAnsweredQuestion` in
    `packages/core/src/authoring/wire.ts` builds the next question revision after
    `checkVersionedAnswer`. The existing check runs first. The result is a frozen
    copy: revision plus one, a sha256 base of the caller-supplied previous digest
    at the open revision, state `answered`, and an answer of the checked texts, a
    copy of the proposed direction reference, and the caller-supplied timestamp.
    Generation, `createdAt`, and the question's other own fields are copied. It
    does not hash the question, write, create a direction, step the run, schedule,
    or resume cadence. Focused synthetic coverage is
    `packages/core/tests/authoring/answered-question.test.ts`. This projection
    still does not create a direction. Scheduling and host wiring remain open.
    This task stays unchecked.
  - Partial evidence (direction persistence): `WorkflowRecordStore.readDirection`
    and `createDirection` store one absent-only direction epoch at
    `directions/<directionId>.json` through the existing create-only path. The
    codec's `validateDirection` stays. Revision 1 has no previous direction. A
    later epoch is a different id. The store does not open or hash the previous
    direction file. Focused synthetic coverage is
    `packages/core/tests/workflow/record-store.test.ts`. The host is not wired.
    Scheduling and cadence resume remain open. This task stays unchecked.
- [ ] T033 Invalidate affected tasks on direction change; prove independent continuation and stop precedence.
  - Partial evidence (invalidated task projection): `projectInvalidatedTasks` in
    `packages/core/src/authoring/wire.ts` builds the next task revisions for one
    direction's impact. An incomplete impact or a shared impact key matches, and
    then so does a task that depends on a match. The result is a frozen copy in
    input order: revision plus one, a sha256 base of the caller-supplied digest
    at the old revision, the supplied direction reference, `retryAllowed: true`,
    and the caller-supplied timestamp. A cached `status` is dropped.
    `currentAttempt`, `needsDirection`, `generation`, `createdAt`, and
    `definition` are copied. It does not hash, write, mark an attempt historical,
    clear a live attempt, bump generation, or compare the new direction with the
    task's current direction. Focused synthetic coverage is
    `packages/core/tests/authoring/invalidated-tasks.test.ts`. The host is not
    wired. Independent continuation and stop precedence remain the in-memory
    reducer proofs. This task stays unchecked.
- [ ] T034 Wire hidden-window/sleep/quit/connection-revoke handling and privacy-preserving notifications.
- [ ] T035 Reconcile in a fresh process; default no sends, opted-in safe resume, uncertain effects blocked.
- [ ] T036 Complete hierarchical whole-book source/category coverage, boundary review and synthesis.
- [ ] T037 Show final handoff with verified saved target, completed chapters/ending and remaining decisions.
- [ ] T038 Connect typed hands-free check-in/control intents under 017/ADR 0021 without implicit capture.
- [ ] T039 Pass independent protocol/fault tests: simultaneous workers, every crash window, stale/foreign
  state, duplicates, quota/unknown charge, overflows, manual edits and archive/trash preservation.
- [ ] T040 Pass actual hidden-app brief→pipeline→~70k saved words with revisions/check-ins/restart;
  retain exact hashes, request/worker counts and coverage. Preseeded output is insufficient.
- [ ] T041 Define a literary-quality rubric before separately authorized live long-form evaluation;
  independent readers assess complete original/revised books and limitations. No paid run authorized now.
- [ ] T042 Record usability, keyboard/performance and actual platform/voice/device evidence separately;
  preserve 038 T022 and all release-approval boundaries.
