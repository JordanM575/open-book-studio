# Tasks: structured reader and continuity review

D-193 and D-197–D-199 are accepted. Isolated implementation/review evidence does not complete the
mounted journey. W10 delivers T003's disclosed volatile selected-source prepare/start with focused
synthetic tests; T004–T006, T008–T009 and T010–T019 remain. T010 retains the independent correction
gate. The policy amendment completed T007.

- [ ] T001 Reconcile 034/037 contracts, existing evidence and exact owned modules; record acceptance scope.
- [x] T002 Apply accepted D-193 / ADR 0018 for U-039-01/02; define and test finding, profile/version and run contracts. W10: new `review/profiles.ts`, `wire-schema.ts`, `findings.ts` and `scoped-readers.test.ts`; pure, volatile contracts only.
- [x] T003 Apply accepted U-039-04 / D-193 bounds; build disclosed selected-source snapshots, pre-start known/unknown price and data-use/training terms, mandatory 011/022 consent gates, and provider-named start with zero-send cancel/missing-consent tests.
  Completed 2026-11-20: one bounded `readerReview:request` surface (support, prepare, start, stop, cancelPrepare), exact saved version/SHA-256/UTF-16 snapshots, the 4-book/64-item/65,536-source/131,072-combined/262,144-request/262,144-output bounds, known or unknown price with no dollar-cap claim, provider-published data-use/training terms, the 011 plan/connection gate, 022 default-off book consent, provider-named single-use Start, zero-send cancel and one transport call with no retry. Focused nine-file suite 149 pass, core review 383 pass, saved-review 26 pass; node typecheck clean, web only the pre-existing `WorkspaceView` union diagnostic. Independent exact-head review ACCEPT and merge `03622b6`. Remaining non-blocking follow-ups: opening focus does not land on the heading, the AI SDK transport drops `responseContract` and the empty tools list, AI SDK errors are not normalized, there is no standalone cancel-preparation control, and staleness is enforced at Start. T004–T006, T008–T009 and T010–T019 remain open.
- [ ] T004 Add schema and quotation validation, citation navigation and stale/unavailable states.
- [ ] T005 Add volatile profile attribution and explicit rerun comparison without replacing prior results.
- [ ] T006 Add explicit multi-book manuscript scope and, only after 030 contracts, optional planning sources.
- [x] T007 Resolve U-039-03 / D-171 applicability; accepted November 7 as D-199 / ADR 0020, with
  explicit-save/recovery plan below. No storage implementation is claimed by this task.
- [ ] T008 Prove read-only enforcement, injection resistance, overflow, stop, failure and no automatic retries with mocked transports and file hashes.
- [ ] T009 Verify built-app keyboard/theme/reduced-motion/reduced-transparency/unsupported-host journeys; run exact-head tests/typecheck/smoke and record limitations in the index/changelog.

## Inline, retained and whole-book follow-through — ADR 0020

- [ ] T010 Correct and independently re-review the existing scoped core/UI boundary findings before integration.
  - Coordinator correction covers registered-envelope evidence, plain/lossless input and canonical
    data, strict current facts, malformed-Unicode overflow, sparse terms, malformed callback reasons
    and same-view cancellation ownership. Focused regression files accompany the change; fresh
    independent exact-head review and mounted/runtime gates remain required.
- [ ] T011 Add shared exact-source/evidence identity, complete overlap index, disposition and rerun relations.
  - Partial evidence: `packages/core/src/review/shared-verifier.ts` with
    `packages/core/tests/review/shared-verifier.test.ts` verifies one saved-chapter
    snapshot from raw bytes/text, reuses the accepted envelope/citation/overlap
    contracts and returns a frozen inline layer or a bounded refusal. Disposition and
    rerun relations, host mounting/export and independent review remain open, so this
    task stays unchecked. 038 T022 remains unchecked.
- [ ] T012 Implement a minimal CodeMirror plain-text surface/current-source handle with the existing one
  undo owner; prove canonical roundtrip, no writes on navigation, IME/paste/voice and save fidelity.
  - November 8: the accepted surface is now mounted inside `ManuscriptEditor` with the wrapper's one
    undo/save/draft owner, an automation contract that preserves the `manuscript-text` smoke hooks,
    and focused parity tests (typing, Enter, paste, dictation, selection, save/undo/redo commands,
    composition and hold guards, conflict retention, flush). The full mounted accessibility,
    native-IME, provider and performance acceptance is still open, so this task stays unchecked.
- [ ] T013 Mount accessible findings/sidebar/underlines/filters; hide current marks on edit, preserve
  historical explanations, handle overlaps/repeated passages and asynchronous navigation ABA.
- [ ] T014 Specify field-level report/profile/disposition/campaign and continuation formats/recovery first.
- [ ] T015 Implement explicit save, recoverable related-file trash/restore, archive and safe Markdown export;
  stale no-op, collision, readback/disk-full/partial-save tests, no eviction or silent truncation.
- [ ] T016 Add one exact suggestion preview/apply, isolated undo, checked save and truthful receipt;
  composition/dirty/source-change/conflict/duplicate application cannot bypass the writer.
- [ ] T017 Add a pure all-range campaign planner, versioned source/category union coverage, boundary and
  attributed synthesis stages; test 70k/250k/oversized chapters under all per-request bounds.
  - November 8, W10 v19: new pure `review/campaign-planner.ts` and `campaign-coverage.ts` implement
    explicit scalar-safe all-range planning, existing-envelope admission, bounded attributed synthesis
    reservations/actual-input admission, and exact revision/category/profile union coverage. Dedicated
    synthetic tests include 70k/250k single chapters and a 120-chapter/250k selection. Oversized durable
    plans remain whole and explicitly non-persistable under existing 64-source/64-stage limits.
    `review/CAMPAIGN-README.md` names continuation-format, lossless persistence mapping and execution
    prerequisites. T017 stays unchecked pending fresh independent exact-head review; these checks
    provide no host/provider-quality/device/release evidence and do not complete T018/T019.
  - November 8, v21 correction: the immutable plan/digest now retains the chosen owning book, with
    equal-length cross-owner receipt/summary refusal tests. Shared plain-data validation memoizes
    completed objects per call to avoid exponential malformed DAG traversal while preserving active
    cycle, accessor and lossy-value rejection. Fresh independent review remains required.
  - November 8, synthesis follow-through: individually validated evidence windows now sort/union
    inside their selected segments, preserving scalar boundaries, exact original text/line numbers
    and all genuine gaps. Generated summary-feedback IDs avoid selected-history collisions with
    deterministic bounded suffixes; actual admission retains every history field and dependency.
    Positive interval/citation/ID-collision regressions accompany both review corrections. T017 and
    connected host/continuation/provider acceptance remain open pending fresh exact-head review.
- [ ] T018 Integrate campaign/check-in artifacts into the separately authorized 037 coordinator.
  - Partial evidence (seam 6a, pure contract only): `packages/core/src/review/campaign-continuation-checkin.ts`
    maps one checked campaign (store inspection, cross-book report resolution and group
    inspection results, plus a host-supplied 037 owner/direction) into counted 037 check-in
    inputs copied verbatim from the codec manifest counters, refusing stale, partial,
    cross-book, future/compatible-label and over-037-limit shapes without coercion; unknown
    fields survive because stored bytes are never re-encoded. Focused synthetic tests cover
    counted mapping, stale/partial/cross-book/future-label refusals, unknown-field survival
    and inexpressible-shape refusal. No host wiring, coordinator execution or task box is
    completed by this slice; T018 stays unchecked.
  - Partial evidence (seam 6a cadence emission, pure adapter only): the same leaf now accepts an
    optional cadence input (caller-counted `callerCountedProgress` with the authoring contract's
    exact field names, plus an optional policy) and, when supplied, emits the authoring
    evaluator's `{ due, reasons }` verbatim plus the validated policy snapshot and validated
    caller-counted progress as `checkin.cadence`. An omitted policy uses the ADR 0019 default as
    the documented adapter-level choice; supplied malformed policy/progress refuses with the
    authoring vocabulary preserved, campaign refusals win and suppress the section, and omitted
    cadence input emits no cadence key. The adapter counts nothing itself, so
    `savedWordsSinceCheckin` is never a prose-derived word count. Focused synthetic tests cover
    default and edited policies, all-reasons emission, malformed refusals, suppression, omission
    and deep-frozen inputs. No Brief, graph, host channel, preload or UI change; the host does not
    yet supply cadence inputs, the other two gaps (`Brief.targetWords`, stage-kind task mapping)
    stay open, and T018 stays unchecked.
  - Partial evidence (seam 6b, host integration only): the desktop host wires that contract
    through one read-only `continuation:checkin` channel (core `IPC`/`StudioApi`, Zod-validated
    book/campaign ids before any Library access, preload bridge, unmounted `must(...)` client
    helper; no presenter screen). The main process loads the checked campaign through the
    existing `campaignContinuations` store readers and returns the counted inputs through the
    `Result` envelope, with the 6a refusal codes preserved as typed failures. The 037 run
    owner and direction are host-supplied through a coordinator-identity seam; this build
    registers no 037 coordinator session in the main process, so the channel refuses
    truthfully (`unsupported`) instead of inventing an owner. Focused synthetic tests cover
    the Library-level happy path and stale/partial/cross-book/future/not-found refusals plus
    IPC validation and bridge delivery. No coordinator execution, presenter surface or task
    box is completed by this slice; T018 stays unchecked.
  - Partial evidence (seam 6c, presenter surface only): the workspace mounts a continuation
    check-in panel (`packages/app/src/components/continuation-checkin/`) beside the saved
    reviews and planning panels. The author names a campaign and presses Load check-in; the
    panel shows only the counted inputs from the checked campaign record through the seam 6b
    client (identity, revision, segment/stage tallies, checkpoint receipt tallies, report
    tallies), counts nothing itself, and implies no live generation. Each typed refusal keeps
    its own plain state, a partly present campaign never renders as a counted result, and the
    production no-coordinator refusal reads as an understandable state with no invented data.
    Focused synthetic component tests cover verbatim counts, every refusal state, and the
    absence of any invented measure; the hidden smoke run covers the mounted panel and its
    no-coordinator state. No coordinator execution or task box is completed by this slice;
    T018 stays unchecked.
  - Partial evidence (cadence host supply, desktop host only): host cadence supply through
    the `continuation:checkin` channel is withheld until adoption is countable. The host
    would count saved words only with the canonical `countWords` over chapter bodies loaded
    through the existing `Library.readBook` reader, but no adoption receipts or provenance
    are recorded that distinguish a coordinator-adopted chapter from any other saved chapter,
    so chapters present cannot be named adopted chapters and `0` is also unverified. Cadence
    is therefore withheld (no `cadence` key) in all cases until adoption is countable from
    recorded receipts/provenance; the saved-word counting code is retained as the honest
    subset that resumes then but is not emitted today. The 037 question store primitive
    exists (`WorkflowRecordStore.readQuestion`/`saveQuestion`), but there is no durable
    question inbox, no irreversible classification, and no host-readable pending-irreversible
    source, so when adoption becomes countable `irreversibleChoicePending` must also be read
    from recorded question state or supply stays withheld — supply must not resume on
    adoption receipts alone. Supply remains scoped to the pre-checkpoint window; a checkpoint
    record or an unreadable chapter also withholds cadence while counted inputs still succeed,
    distinguishable from an evaluated `due: false`. The channel still validates policy input
    and refuses renderer-supplied progress: the renderer may only choose the versioned policy
    (Zod-validated before Library access); renderer-supplied progress refuses as `invalid`,
    and the production no-coordinator `unsupported` refusal is unchanged. No UI change, no
    coordinator session is fabricated, and T018 stays unchecked.
  - Partial evidence (check-in word target, pure contract only): `readCheckinWordTarget` in
    `packages/core/src/authoring/contracts.ts` copies an existing goal id and a positive saved
    `targetWords` for a later check-in brief. A null target refuses as `absent-word-target`, any
    schema other than 1 as `unsupported-version`, and a different or missing book as
    `foreign-goal`. A supplied value carrying `selectedUtf16` or `selectedUtf8` at any depth
    refuses as `campaign-count-not-words` before the target is read. The reader does not invent
    a goal id from the book id, does not import a word counter, and is not called by
    `prepareBrief` or the continuation leaf. That leaf still emits no `targetWords`. Focused
    synthetic tests cover the copy, those refusals, nested campaign totals, and a prose field
    that does not change the saved target. No host wiring, coordinator execution, or cadence
    resume is completed by this slice. That slice leaves stage kinds unmapped, and T018 stays
    unchecked.
  - Partial evidence (campaign stage role refusal, pure contract only): `refuseCampaignStageRole`
    in `packages/core/src/authoring/contracts.ts` records the only supported relationship between
    a campaign stage kind and an authoring role. `range` and `synthesis` refuse as
    `campaign-stage-not-a-role` and never become a `Role` or `TaskDefinition`. Any other value,
    including an authoring role name or a stage object, refuses as `unknown-stage-kind` first.
    `ROLES` and `validateGraph` are unchanged. The continuation leaf names the refusal and does
    not call it, and it still builds no task graph. No host wiring, coordinator session, or
    cadence resume is completed by this slice. T018 stays unchecked.
- [ ] T019 Measure the connected journey's accessibility, fidelity and existing performance/bundle gates;
  separately evaluate semantic usefulness before any model-quality claim.
  - Partial evidence (seam 6d, measurement only): `apps/desktop/tests/continuation-checkin-measurement.test.tsx`
    measures the mounted presenter at DOM level (structural axe rules per the repo's happy-dom
    pattern, roles/labels/focus order/aria associations, token usage) across idle, counted,
    no-checkpoint/no-reports, typed-refusal and the production no-coordinator states, and
    renders a synthetic fidelity matrix (zero/large counts, unknown-bearing segments,
    independent checkpoint/report absence, no-recount) byte-faithfully; counted states are
    reachable only through the injectable reader in tests and are labelled as such. The
    existing browser axe gate passes all 32 scans (workspace includes the idle panel) and
    fails its editor focus check identically at pre-6c `f02fffd`, so that failure predates
    the presenter. The existing perf gate's bundle check fails ×2.30 against its committed
    baseline at this head and ×2.29 at pre-6c, so it also predates the presenter; the
    presenter-attributable web bundle delta is +7,884 bytes (+0.45%), and the baseline was
    left for its gate owner. Semantic usefulness is evaluated separately as human
    judgement in the evidence report, with no model-quality or live-generation claim.
    Full numbers: `W10-continuation-checkin-measurement.md` in the campaign evidence.
    No task box is completed by this slice; T019 stays unchecked.

### November 8 — pure D-201 continuation candidate (T014/T017 partial)

`packages/core/src/review/campaign-continuation-*` now supplies pure in-memory manifest, segment,
checkpoint and publication-intent candidate/inspection primitives. Encoding requires a locally
provenanced plan; hole reconstruction remains untrusted, and complete comparison with a separately
supplied local plan does not register the decoded object. Focused synthetic tests cover large real
planner fixtures, exact content/union, token and byte boundaries, unknown data and tampering. The
standalone resolver does not independently establish all plan semantics, source-file identity or
verified reports. Compatible replanning, storage publication/recovery, adapter qualification,
cross-book report resolution, host integration and independent exact-head review remain open.
T014/T017/T018 stay unchecked; 038 T022 is unchanged.

### November 9 — pure compatible-replan and source-validation seam (T014/T017 partial)

`packages/core/src/review/campaign-continuation-replan.ts` now supplies the pure seam the codec
handoff ordered second: compatibility dispatch on recorded schema/`plannerSemantics`, bounded
validation of explicitly chosen current or historical raw sources, and compatible replan through
the real planner requiring the codec's complete canonical match (`matched-local-plan-only` or a
bounded refusal). Only the freshly provenanced plan is usable afterwards; hash agreement never
registers a deserialized object. Focused synthetic tests cover serving, replan, historical and
multi-source sources, checkpoint return, incompatible/forged/substituted/oversized refusals and
provenance non-transfer. Storage publication/recovery, version-dispatching storage reads,
cross-book report resolution, host integration and independent exact-head review remain open.
T014/T017/T018 stay unchecked; 038 T022 is unchanged.

### November 9 — continuation fixed-history group trash/restore (T014/T015 partial)

`packages/core/src/review/campaign-continuation-fixed-history.ts` with new
`CampaignContinuationStore` fixed-history methods now supplies the seam ordered fifth: a
version-dispatching trash/restore moves the preserved history sidecar set for a campaign —
the owner book's entire 032 `history/` tree plus the campaign's segment directory,
publication-intent directory and manifest — between the active locations and
`.studio/trash/<owner>/reviews/campaign-<groupId>/` under an immutable fixed-history intent
retained in `reviews/fixed-history-moves/`, after manifest dispatch (compatibly differing
labels only through a local normalized comparison copy, stored bytes never altered), full
wire verification, per-record 032 dispatch and bounded inventory preflight, moving history
first with the manifest last; a move that cannot preserve every checked reference refuses
before the first move with source bytes preserved, a later failure is uncertain with both
locations retained, and fixed-history inspection classifies `active`/`archived`/`partial`/
`absent` without ever reading partial as complete. Focused synthetic tests cover move
chain/readback, archive/restore classification, divergent/occupied/future-label/wrong-owner
refusals, compatible-label byte-identical moves, unknown-field survival and post-first-move
uncertainty, in memory and on the real desktop filesystem. Host integration, portable
archive/export, cross-book mutation and independent exact-head review remain open.
T014/T015/T017/T018 stay unchecked; 038 T022 is unchanged.

### November 9 — continuation group trash/restore and cross-book report resolution (T014/T015 partial)

`packages/core/src/review/campaign-continuation-group.ts` with new `CampaignContinuationStore`
group/report methods now supplies the storage seam the codec handoff ordered fourth: a
version-dispatching trash/restore moves exactly the manifest file and the whole segment and
publication-intent directories between the active reviews folder and
`.studio/trash/<owner>/reviews/campaign-<groupId>/` under an immutable group intent retained in
`reviews/campaign-moves/`, after full wire verification at the source and bounded
inventory/destination preflight, moving segments and intents before the manifest last; a move
that cannot preserve every checked reference refuses before the first move with source bytes
preserved, a later failure is uncertain with both locations retained, and group inspection
classifies `active`/`archived`/`partial`/`absent`. Checkpoint reports resolve only from their
recorded owner's ordinary report path: the recorded owner wins, a verified foreign report is a
bounded foreign reference never adopted, merged or dropped, and a missing or changed report
stays unavailable. Focused synthetic tests cover group move chain/readback, archive/restore
classification, preflight refusal, post-move partial uncertainty, mixed-ownership resolution,
wrong-owner refusal and unknown-field survival, in memory and on the real desktop filesystem.
Host integration, portable archive/export, cross-book mutation and independent exact-head
review remain open. T014/T015/T017/T018 stay unchecked; 038 T022 is unchanged.

### November 9 — checked continuation storage publication and recovery (T014/T015 partial)

`packages/core/src/review/campaign-continuation-store.ts` now supplies the storage seam the codec
handoff ordered third, as `LibraryService.campaignContinuations`: a version-dispatching storage
reader loads a retained continuation only through the codec wire readers plus the replan
compatibility dispatch (current semantics served only through a locally provenanced plan,
compatible labels returned as `replan-required`, otherwise refused, with no deserialized plan
blessed by hash); intent-first publication writes the exact candidate intent, then immutable
segments in manifest order, then the checked manifest last, verifying every reference by length,
raw hash and semantic ID on fresh readback before reporting `published`; and per-intent recovery
classifies interrupted publication as `already-published` (a byte observation),
`prepared`, `incomplete-draft`, `conflict` or `uncertain` with missing and divergent segments
named. Segments and intents are created only through a genuine no-replace seam
(`LibraryPort.createImmutableFile`; the desktop filesystem adapter uses exclusive creation), and
an adapter without it refuses before any write rather than using check-then-rename. Reads are
owner-explicit and inventories are bounded and paged. Focused synthetic tests cover the happy
path with readback, fault injection at each publication phase boundary, divergent and identical
pre-existing segments, tampered manifest/segment refusal, wrong-owner reads, unknown-field
survival and dispatch across current, compatible and future semantics, on both the in-memory
port and the real desktop Library. Cross-book report resolution, group move/archive, host
integration and independent exact-head review remain open. T014/T015/T017/T018 stay unchecked;
038 T022 is unchanged.

### November 8 — D-201 conditional continuation specification (T014 partial)

D-201 and the ADR 0020 amendment accept the conditional schema-2 campaign format; `docs/FORMAT.md`
links its field-level schema, bounds, external holes, provenance and recovery rules in
`docs/formats/campaign-continuation.md`. This is a documentation/decision slice only: no continuation
codec, compatible-replan seam, writer, adapter capability, group move or 037 host integration was
implemented or validated here. The focused planner baseline could not load `zod` because prepared
workspace dependencies were absent. Independent implementation/review and the remaining format,
execution and integration gates stay open. T014/T017/T018 remain unchecked; 038 T022 is unchanged.

### November 8 — saved review records, schema 1 (T014/T015 partial)

`packages/core/src/review/record-json.ts` and `record-format.ts` define the field-level schema-1
report, disposition, author-lens and campaign records; `record-store.ts` is the only writer and is
constructed as `LibraryService.reviewRecords`. Reports are immutable and absent-only; the other
records carry the exact previous raw hash and revision, keep conflict copies, verify readback, join
the Library queue/journal, restore from grouped `.studio/trash` only into free paths, and never
prune. Unknown plain fields survive read-modify-write; newer or unknown semantics stay read-only.
`docs/FORMAT.md` records the fields and bounds.

Candidate-local evidence: `packages/core/tests/review/record-format.test.ts` and
`record-store.test.ts` (synthetic). Still open: segmented continuation, IPC/preload/UI mounting,
Markdown/archive export, campaign scheduling/execution, cross-book campaign aggregation and fresh
independent exact-head review. T014 and T015 stay unchecked. 038 T022 is unchanged.

### November 7 — bounded T011/T012 editor candidate

The new `packages/app/src/components/inline-editor/` leaf and
`packages/core/src/review/inline/overlap.ts` provide a minimal unmounted plain-text
adapter, exact-current snapshot/final post-await gate, trusted evidence-port seam,
complete overlap membership and keyboard/pointer inspection callbacks. Existing
ManuscriptEditor and its save/draft/custom-history owner remain unchanged.

Candidate-local evidence: 20 new focused tests; 64 tests / 801 assertions including
the existing editor/history/failed-save/move-rebase regressions; nine hidden native
Chromium fidelity probes, strict desktop/web/toolkit typechecks and focused lint.
The local README records APIs, migration steps, MIT dependency notices, bundle
measurement procedure and native partial-grapheme selection/clipboard differences.
This is **partial T011/T012**, not a checked task: the corrected shared verifier,
disposition/rerun relations, mounted save fidelity, accessible full sidebar and
whole-product performance/license/bundle gates still need their named owners and
independent exact-candidate review. No mounted T013 or saved/application completion
is inferred from the isolated controls or synthetic proof port.

### November 8 — W10 v19 saved-record API and Workspace inspection (T015 partial)

`library/review-record-api.ts` adds bounded request/reply validation, per-request nonce/digest and
Library/book/view binding, explicit immutable reader saves, exact-hash report reads, bounded report
and unavailable-file pages, and report-bound disposition inspection. The browser adapter uses the
current Library service. Workspace mounts Saved reviews; the structured result leaf has an explicit
Save review control with no provider dispatch. Local choices/notes and inspected feedback survive
failed reads/refused saves; historical quotes are labelled verified-at-capture, never current.

Focused synthetic tests exercise the actual browser adapter and mounted Workspace, registered
desktop IPC/preload with an injected filesystem LibraryService, same-ID no-op, conflict `savedAs`,
refusal/not-kept/uncertain results, malformed/foreign/late/ABA replies, missing API, draft retention
and unchanged original chapter hashes. Desktop's actual `Library` wrapper lacks the forwarding
getter and is tested to refuse. Its addition remains coordinator-owned. The store also lacks
caller-base-checked disposition mutation and exact-inspection trash/recovery APIs; those controls
remain explicitly unavailable rather than using a racy read-before-write substitute. No complete
mounted recovery or persisted disposition-save journey is claimed. Production reader execution,
Markdown/export/archive acceptance, native accessibility and fresh exact-head review remain open.
T014/T015 and all other task checkboxes stay unchanged; 038 T022 stays unchecked.

### November 8 — W10 v20 checked disposition and recovery continuation (T015 partial)

The explicitly expanded store/desktop ownership closes v19's three seam prerequisites: desktop
forwards the current Library service, `recordDispositionChecked` consumes inspected raw report and
disposition bases in the existing queue, and one-use inspected group confirmation drives bounded
trash inspection and free-path restore. Complete stale histories/unknown own fields survive as
checked conflict copies; transport edges validate complete success/conflict outputs. The mounted
Workspace journey retains exact drafts on failure/uncertainty, prevents replay until inspection,
and retires late/foreign/ABA replies. Partial moves are uncertain and remain recoverable, including
disposition-only groups bound to an exact active report. FORMAT and the reader README describe the
contract before exposure; no second writer or provider dispatch was introduced.

Candidate-local automated evidence covers actual desktop wrapper/IPC/preload, browser Library/API
and mounted save/reopen/trash/restore, competing/missing/replaced bases, future/unavailable records,
occupied targets, partial/concurrent moves, uncertain receipts, unknown fields and unchanged
synthetic manuscript hashes. Production selected-source execution, safe Markdown export, archive
acceptance, segmented continuation, campaign execution, native accessibility, broad integrated
gates and fresh independent exact-head review remain open. T014/T015 stay unchecked; 038 T022 is
untouched. Final focused evidence: 147 tests / 898 assertions across six dedicated/relevant files,
workspace typechecks, strict core-test typecheck, ten-file lint and diff checks passed. Detailed
executed commands and limits are in the separate v20 finish report.

### November 8 — W10 v21 saved-review recovery corrections (T014/T015 partial)

Report conflicts now require full reconstructed intended content, verified conflict metadata and
independent reads of the named copy at the handler and receiver; an unverifiable copy or publication
stays uncertain. Pending and uncertain report saves survive equivalent prop wrappers and require
same-view inspection and explicit acknowledgement before another save. Disposition drafts retain
newer typing but cannot use a known or possibly superseded baseline without inspection and explicit
history adoption, including other drafts around an unconfirmed save; untouched blank notes are absent,
while explicit empty and whitespace notes remain exact. Caller-owned
disposition inputs are admitted before property reads. Desktop tests use the shared complete Electron
mock and portable, individually owned temporary roots.

Focused synthetic store/transport, mounted browser and mocked desktop wrapper/IPC/preload regressions
exercise these corrections and their uncertainty paths. They do not establish built Electron or native
device behavior, nor close production reader execution, export/archive, segmented continuation,
campaign, accessibility, broad integration or fresh independent exact-head review. T014/T015 stay
unchecked and 038 T022 is unchanged. Exact commands, results and limits belong to the separate v21
recovery finish report.
