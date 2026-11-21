# Structured reader and continuity review

**Status:** In progress — D-193 and D-197–D-199 accepted; T003's disclosed volatile selected-source prepare/start, T004's exact schema, quotation, citation-navigation and stale/unavailable states, T005's volatile profile attribution and explicit rerun comparison and T008's read-only enforcement proof are delivered at the source/test level. T001, T006, T009 and T010–T019 remain.
**Number:** 039
**Requirement:** REQ-REVIEW-003, REQ-REVIEW-004
**Depends on:** 034 saved-source evidence contracts; 037 scoped read-only provider review;
011/022 provider consent and capability contracts; 030 for optional series records.
**Completion lane:** L09. These are contract dependencies, not a requirement to finish every task
in the referenced specs. Advisory routing in 036 is optional; automatic dispatch is not required.
The 037 dependency is shared envelope/citation/execution contracts, not conversation persistence:
039 snapshots, profiles and results stay volatile with zero ThreadStore writes. Volatile 039 does
not wait for 037's conversation-retention/thread-safety work.

## Why

An author needs structured critique from named reader perspectives, repeat reviews that preserve
their attribution, and continuity findings grounded in explicitly selected books. These subjective
model reports must not masquerade as deterministic metrics (034) or conversational guidance (037).

## User stories

1. Choose a reader profile and selected saved chapters, inspect the provider/model and outgoing
  scope, known price or unknown cost and applicable data-use/training terms, and request a
  suggestion-only alpha/beta report.
2. Inspect a finding's verified quotation and revision; distinguish evidence from interpretation.
3. Reread changed chapters without overwriting or relabelling the earlier reader/run.
4. Select multiple books for continuity analysis and see which manuscript, outline or note supports
   each claimed inconsistency. A missing source is insufficient evidence, not proof of a plot hole.

## Requirements

- **FR-001** Each run MUST disclose provider, model, profile/version, selected saved sources and
  any prior feedback sent, known price facts or unknown cost, and applicable provider data-use and
  training terms before start. Existing 011/022 consent gates remain mandatory, including 022's
  default-off book-level training consent where applicable; absent consent MUST block the request.
  A provider-named start authorizes only that run; pre-start cancel sends nothing. No silent model
  fallback, additional book reads or background rereads are permitted.
- **FR-002** The boundary MUST enforce selected-source reads and exclude write, destructive,
  disabled and plugin tools. Manuscripts, profiles and earlier feedback are untrusted data and
  cannot widen permissions. All manuscript bytes MUST remain unchanged on every generation outcome.
  FR-012's separate explicit author application command does not give the review executor writes.
- **FR-003** A schema-validated finding MUST identify its category, reader/run, interpretation,
  source kind, book/chapter, captured revision and resolvable location. Quoted text MUST match the
  supplied snapshot; invalid citations MUST be withheld as unverified rather than fabricated.
- **FR-004** Reader impressions and style suggestions MUST be labelled subjective. No model score
  is an objective quality measurement. Deterministic results remain separately labelled under 034.
- **FR-005** Revisions MUST be compared before showing a report as current. Missing/changed sources
  produce unavailable/stale evidence, never silent refresh. Cross-book scope MUST name every book
  and distinguish manuscript evidence from planning records. No library-wide scan is implicit.
- **FR-006** Rerun comparison MUST attribute both runs, their source revisions and profile versions.
  It MUST distinguish changed input from changed interpretation; it MUST NOT overwrite prior feedback.
- **FR-007** Stop, malformed output, refusal, context overflow and provider failure MUST end with an
  honest incomplete/failed state and retryable scope. Already sent data cannot be recalled; retries
  need a fresh author action and may incur cost. Unknown cost stays unknown; D-116 is not a hard cap.
- **FR-008** Reports MUST default to volatile with no conversation writes. Explicit Save review and
  separately disclosed workflow retention follow D-199/D-171/ADR 0020: ordinary recoverable files,
  immutable report and checked disposition/profile/campaign state, unknown preservation, no pruning,
  truthful archive/sync quotations and safe export. Detailed formats precede their writers.
- **FR-009** Unsupported hosts MUST refuse before reading private content or calling a provider.
  The UI MUST support keyboard use, light/dark and reduced-motion/transparency preferences.
- **FR-010** Exact-current underlines MUST use D-197's verified source/editor snapshot and complete
  overlap membership. Edits immediately suspend current marks; historical quotes remain available.
  Filtering/inspection MUST NOT start providers, save records or delete findings.
- **FR-011** D-198's versioned editorial groups MUST distinguish concerns, strengths and questions,
  optional lenses, subjective triage and deterministic indicators. Disposition/freshness are separate;
  absence on rereview is not automatic resolution or measured improvement.
- **FR-012** Explicit Preview/Apply suggestion MUST show one exact replacement, recheck clean source
  and composition state, use one editor undo unit and normal checked save. Failed/conflicted saves
  retain drafts and cannot claim applied/resolved. No provider retry is caused by persistence failure.
- **FR-013** Explicit full-book campaigns MUST plan every selected primary range within existing
  per-call bounds, account for overlap/boundary context and synthesis, retain per-source/category
  coverage and attribute derived summaries. Ordinary one-run overflow still refuses; campaign data
  cannot grant execution authority. 037 owns authorized scheduling and question dependencies.

## Acceptance scenarios

Use isolated synthetic books and mocked transports, not paid calls or real manuscripts.

1. Cancel before start: zero provider requests and byte-identical library. Start one selected chapter:
   the captured request contains exactly the disclosed scope, with no adjacent chapter or secret.
   Known/unknown price and applicable data-use/training terms are shown before start; missing required
   011/022 consent produces zero calls and cannot be bypassed by a reader profile or rerun.
2. Inject instructions in prose, profile and prior feedback: no expanded reads, writes or plugin calls.
3. Supply valid, invented and wrong-revision quotations: only valid snapshot matches resolve as
   evidence. Change/delete a source mid-run: mark stale/unavailable and require an explicit rerun.
4. Run two profiles and two revisions: identity/version attribution survives comparison; no earlier
   run is relabelled. Selected cross-book findings name each source and its manuscript/planning kind.
5. Stop, overflow, refusal and malformed output leave files unchanged, release busy state and show
   incomplete coverage; no automatic retry or fallback occurs.
6. Keyboard-only scope selection, finding navigation and stop work on the claimed desktop host;
   an unsupported host sends nothing. Reduced-motion and reduced-transparency preferences are
   exercised explicitly. Persistence spies observe no report/history writes.

## Non-goals

Unrequested application, objective literary rankings, a new provider runtime, implicit routing,
real-reader impersonation or implicit 030 series scope. Read-only generation remains separate from
the author-invoked checked application and 037's independently authorized workflow.

## Open decisions

D-193 / [ADR 0018](../../docs/adr/0018-scoped-review-contracts.md) resolves the initial source, quote,
profile and overflow contracts. D-197–D-199 / ADR 0020 select the inline/application/campaign and
explicit-retention extensions. Accepted policy is not implemented behavior.

| ID | Question / required evidence | Blocks |
| --- | --- | --- |
| U-039-01 | Accepted D-193: exact selected-source UTF-16 spans/quotes, no normalization/fuzzy matching, derived verification and bounded subjective findings. | T002/T004 implementation remains |
| U-039-02 | Accepted D-193: fictional Alpha/Beta lenses, immutable IDs/versioned edits, full per-run snapshots and separate source/profile/provider change attribution. No completed user study is claimed. | T002/T005 implementation remains |
| U-039-03 | Accepted D-199/D-171: volatile default; explicit immutable save, checked dispositions/profiles, recoverable trash, no auto-pruning and ordinary archive/sync inclusion. | T007 decision resolved; T014–T015 formats/storage and acceptance remain |
| U-039-04 | Accepted D-193: four books/64 items, 65,536 source-text bytes, 131,072 combined content bytes, 262,144 complete request/output bytes. Bounds are not token-fit claims; overflow refuses without clipping/splitting/fallback. Single-book work uses the same policy. | T003 applied the bounds; T006 still carries U-039-04 for multi-book scope; no single-book exemption |
