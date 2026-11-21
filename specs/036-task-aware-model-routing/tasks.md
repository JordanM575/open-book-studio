# Tasks: task-aware model routing

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **State**: In progress; offline preview leaf implemented and T016's narrow handoff delivered at the source/test level (implementation `eb876f0`, exact-head review ACCEPT, merged `a246d5d` via PR #118); D-204–D-207 accepted; T015/T017 and the new-total portion of T018 remain deliberately not selected; T019 remains unchecked; no live/packaged/provider claim.

Tasks are ordered by dependency; checked rows name their evidence. A decision blocks only the task
that relies on it; offline preview work does not wait for decisions about dispatch or fallback.

## Phase 0 — Resolve only the policies needed by each slice

- [x] T001 Record a public decision for the initial author-selected writing-task taxonomy, profile
  requirements, and evidence sources. This blocks final profile data in T007 and profile-specific copy
  in T009, not the generic preview shell or unknown-state handling.
  Accepted 2026-11-20 as D-204: three author-selected version-1 profiles (Discuss the book, Draft new
  prose, Revise existing prose), each requiring tool support and a known catalogue context, with no
  quality tiers, numeric context minimum, output-size target or provider/model tier. Profile data and
  the known-context evaluator requirement remain follow-up implementation; this box records the
  decision, not that code.
- [x] T002 Record a public decision for whether candidates may be ranked or a single suggestion shown,
  including the evidence and deterministic policy. Until accepted, T007 and T009 must provide an
  unranked candidate list; this blocks T015, not eligibility explanations.
  Accepted 2026-11-20 as D-205: no ranking and no single suggestion. Zero, one or many known capability
  matches appear in stable catalogue order with statuses, reasons and a visible not-a-ranking note.
  T015 is deliberately not selected; T016's wording and dependency are amended below. The
  “Known capability match” copy and not-a-ranking note are accepted presentation follow-up, not
  implementation.
- [x] T003 Decide whether a local request-size/token estimate is in scope and how its uncertainty is
  disclosed. Until accepted, T008 may show catalogue limits and prices but must not claim actual request
  fit or compute a total without known estimate inputs.
  Accepted 2026-11-20 as D-206: no local request-size estimator and no total cost. Catalogue context
  limits and unit prices keep their provenance; actual request fit stays unknown; the preview says why
  no total is shown. The new total-estimate portion of T008 and the total-estimate scope of T018 are
  deliberately not selected.
- [x] T004 Resolve D-116 and its unknown-price policy. Accepted November 7 / ADR 0019: finite
  operation mode versus qualified strict money, unknown/unresolved-charge refusal in strict mode.
  Implementation/adapter qualification remain; ordinary warnings are not upgraded into ceilings.
- [x] T005 Record a public decision on whether a later explicit suggestion action may populate the
  existing one-turn override and whether task/route details may be persisted. Until accepted, T010 must
  remain selection-neutral and transient. This does not block a link to the existing model picker.
  Accepted 2026-11-20 as D-207: two-step handoff only. An explicit action on an author-chosen candidate
  opens the existing one-turn picker; the author confirms there; only the existing one-turn override is
  set. No book default, consent, send or persistence change. T017 is deliberately not selected; T016 is
  amended and remains unchecked.
- [x] T006 Before any future direct dispatch, automatic routing, fallback, or retry is proposed, record
  public decisions for author authorization, stop/cancel, partial edits, uncertain charges, and recovery.
  Accepted November 7 as D-196/ADR 0019 for explicitly pinned workflow roles, zero automatic retries,
  no fallback, distinct 037 grant/admission and conservative recovery. This decision does not check
  implementation or authorize preview dispatch.

## Phase 1 — Build the local preview contract

- [x] T007 Add pure candidate-evaluation types and functions under `packages/core/src/routing/`, consuming
  existing provider catalogue/capability data. Cover known match, known exclusion, unknown requirement,
  unavailable connection, retired model, and stale catalogue with synthetic fixtures. No network, key,
  manuscript, or runtime imports.
  Implemented: `profiles.ts` (versioned `TaskProfile`/`TaskRequirements` zod schemas; no settled
  taxonomy shipped at this delivery) and `evaluate.ts` (`evaluateCandidates` over per-provider catalogues,
  connections, build and optional extra ids). Status is worst-of unavailable/excluded/unknown/
  eligible with plain-language reasons; catalogue order is preserved, never ranked. Reuses the
  existing `unavailableReason`, `catalogueFreshness`, browser-availability and Contributor-warning
  copy. Covered by `packages/core/tests/routing/evaluate.test.ts` (16 pass, synthetic fixtures
  only); unknown prices stay null, the Contributor flag never changes the verdict, and a
  desktop-only provider is unavailable in the web build.
  Updated 2026-11-20: D-204 now supplies the accepted taxonomy and requires a known-context
  requirement, but adding the three profiles, that requirement and matching tests is follow-up
  work. The checked delivery above remains the generic evaluator; it is not reopened or described
  as having shipped the taxonomy.
- [x] T008 Implement honest catalogue cost/context presentation rules: preserve price provenance, keep
  missing values unknown, label any supported total as an estimate, and distinguish a catalogue context
  limit from actual request fit. Any new total estimate is **deliberately not selected by D-206**; showing catalogue unit
  prices and context limits is not. Add fixture tests; do not add ceilings or cost-based request rejection.
  Implemented: `presentation.ts` (`unitPriceViews` for input/output/cached-input unit prices,
  `contextView` for the catalogue limit with always-unknown request fit). Known prices keep their
  USD-per-million values with catalogue provenance; missing or unusable prices are unknown, never
  zero — while a published zero stays known. No total, ceiling or rejection exists in the views.
  Covered by `packages/core/tests/routing/presentation.test.ts` (8 pass, synthetic fixtures only).
  Updated 2026-11-20: D-206 deliberately does not select a total, so the optional total-estimate
  wording above is not an obligation. This checked unit-price/context delivery stands; the explicit
  why-no-total line is presentation follow-up.
- [x] T009 Build the shared task-preview surface in `packages/app/` using design tokens and accessible
  status text. It must use local catalogue data, display freshness/unknowns/reasons, keep candidates
  unranked under the accepted D-205 decision, and provide a path back to the existing model picker without preselecting anything.
  Implemented: `TaskPreviewDialog` (`packages/app/src/components/TaskPreviewDialog.tsx`) takes
  profiles, per-provider catalogues, connections and build as props and keeps only a transient
  selected-profile id. It renders the T007 evaluation with unranked catalogue-order candidates,
  per-candidate reasons, T008 price/context facts, per-catalogue freshness lines (new
  `catalogueAgeLine` contract), the FR-008 "No suitable candidate known." line when nothing is
  eligible, and a "Choose in the model picker" callback with no preselect. No settled taxonomy is
  shipped; profiles arrive as data. Covered by `apps/desktop/tests/task-preview.test.tsx` (7 pass:
  choose prompt, unranked statuses/reasons, facts/freshness/stale/warning, no-suitable, picker
  callback, reopen reset, no profiles) with synthetic fixtures only. Dedicated absent/malformed/
  error states stay with T011; neutrality proofs stay with T010.
  Updated 2026-11-20: D-204–D-207 accept the final profile set, the “Known capability match” copy,
  the not-a-ranking note, the why-no-total line and an optional two-step handoff affordance. None of
  that copy or handoff is implemented in this checked leaf delivery; the production mount also
  remains absent.
- [x] T010 Keep the initial preview transient and selection-neutral. Add component tests proving open,
  profile change, close, and cancel do not change the book default, one-turn override,
  active connection, turn history, usage, or manuscript.
  Implemented: `apps/desktop/tests/task-preview-neutrality.test.tsx` (3 pass) drives the dialog
  against a fixture host through open, two profile changes, Close-button close and Escape cancel,
  asserting the host state deep-equals its snapshot and the picker callback fires once with zero
  arguments and no in-preview choice affordance. Props are frozen, and no `window.studio` mock is
  installed, so any bridge access would throw. One product fix: the picker button now calls back
  with zero arguments instead of leaking React's click event.
- [x] T011 Add no-catalogue, stale-catalogue, malformed-catalogue, no-candidate, and preview-error states.
  Each state must say what is unknown and what the author can do next; none may silently refresh, retry,
  select a replacement, or block the existing manual flow.
  Implemented: `TaskPreviewDialog` derives a `no-catalogues` / `malformed` / `error` (unreadable
  profile or failed evaluation) / `no-candidates` outcome beside the ready list, each stating what
  is unknown with the footer Close and model-picker buttons as the only next actions; a stale
  banner labels out-of-date matches without blocking them. Covered by
  `apps/desktop/tests/task-preview-states.test.tsx` (5 pass, synthetic fixtures only), asserting
  copy, enabled manual-flow buttons and no refresh/retry/select control in any state.
- [x] T012 Add provider-call and credential-access spies proving preview open/change/cancel makes zero
  new calls and reads no credentials. If an existing explicit catalogue refresh is offered nearby, test
  that it remains a separate author action and is not duplicated by the preview.
  Implemented: `apps/desktop/tests/task-preview-calls.test.tsx` (2 pass) exercises the dialog
  through open, two profile changes, the picker path and close behind a throwing bridge proxy
  and a throwing fetch stub, asserting zero bridge touches and zero fetches. A positive control
  opens the real model picker under a recording stub and asserts `providers.list` and
  `connections.list` are called, proving the spy observes real traffic. No catalogue refresh
  exists near the unwired preview, so there is nothing to duplicate.
- [x] T013 Add a Contributor-consent regression fixture: previewing a Contributor candidate never writes
  or infers `allowContributorTraining`; the existing spec 022 warning and pre-request guard remain the
  only consent behavior.
  Implemented: `apps/desktop/tests/task-preview-consent.test.tsx` (1 pass) previews a Contributor
  candidate behind the throwing bridge, asserting the exact 022 warning copy renders, no
  checkbox or switch control exists, the fixture consent flag stays false, and no bridge
  surface is touched. Consent can still change only in the 022 picker guard and pre-request
  refusal, both outside this surface.
- [x] T014 Verify keyboard use, screen-reader labels, reduced motion/transparency, and light/dark states
  for the new preview surface using the existing design system.
  Implemented: `apps/desktop/tests/task-preview-access.test.tsx` (5 pass) asserts the dialog role
  and accessible name, a named native button for every control, toggling `aria-pressed` on task
  buttons, keyboard focusability, reasons in list markup, no inline animation/transition styles
  (motion stays under the base stylesheet's reduced-motion guard), and identical structure under
  light and dark themes with token-only styling and no raw color literals. Escape-to-cancel is
  covered in T010 rather than duplicated here.

## Phase 2 — Optional, decision-gated selection integration

- [ ] T015 **Deliberately not selected by D-205.** Neither ranking nor a single suggestion is in scope.
  Do not implement a score, ordering or advisory pick, and do not record this task as shipped. A later
  ranking policy requires a new decision naming its evidence and deterministic rule.
- [x] T016 **Unblocked by D-205 and D-207; delivered 2026-11-20.** Add only the narrow two-step handoff: an
  explicit action on an author-chosen candidate opens the existing one-turn picker, the author confirms,
  and only the existing one-turn override is set. It must not change the book default, consent, send
  behavior or persistence, and the existing Send action remains the only provider trigger. The wording
  is now “author-chosen candidate”, not “chosen suggestion”.
  Completed 2026-11-20: implemented at `eb876f08328165fd1897e8e2875eb6baae751a1c` (22 files against its
  parent; the design memo's 23-entry §7 allowlist went unused at `packages/core/src/routing/index.ts`).
  124 focused passes were recorded; the exact-head review re-ran 122 passing, 0 failing, and node
  typecheck was clean with web showing only the known pre-existing `WorkspaceView` diagnostic.
  ACCEPTed by independent exact-head review; the pre-merge `main` merge
  `0df52611d3ce60ea02ed1ddaebdd1b10a604b04c` was itself reviewed and ACCEPTed first; merged to main as
  `a246d5d2d35533882039044157bf082da19ab43f` via PR #118. The slice mounts the preview from the
  writing-agent composer (an optional “Preview models” entry, rendered only when the host wires it), fed
  exclusively by the in-memory snapshot of catalogues the explicit model picker already loaded; with an
  empty snapshot it refuses before any profile is chosen and makes no bridge call. An eligible
  candidate shows “Use for next message”, which passes exactly `{ provider, modelId }` to the existing
  one-turn picker; the picker restricts itself to that provider's usable connections (preselecting one
  only when exactly one exists — otherwise the author chooses, never the first credential), revalidates
  the connection and model on open and on confirm, and sets only the existing one-turn override
  (`turnModel`) through its existing confirm path. No IPC channel, preload method, provider call, vault
  read, persistence, ranking/score/single suggestion, request-size estimator or task/route store is
  added; the book default, connection, consent, conversation and manuscript are untouched, and Send
  remains the only dispatch trigger.
  Judgment calls recorded from the reviews: the known-context requirement is an optional
  `requiresKnownContext` per §7.1 of the design memo (an absent flag never grants eligibility; the
  shipped `WRITING_TASK_PROFILES` set it and are pinned by test; the §3.1/§7.1 wording difference is a
  recorded design-note residual); the D-206 “No total is shown because the request size is unknown.”
  sentence shipped as the §7.1/Q3-permitted static disclosure with no calculation attached; the picker's
  `handoffPendingRef` guard is inert in non-handoff mode and is covered by the mount test's exact
  `providers.models` call counts.
  Residuals: `connectionsLoaded` is not reset when the handoff picker is re-opened (cosmetic only — the
  confirm path revalidates against fresh state, so no stale write is possible; a one-line reset is a
  follow-up); live, packaged and provider-behaviour evidence, including the T009-equivalent built-app
  class, remains out of scope and no such claim is made; T016's acceptance under its design is
  implementation plus independent exact-head review plus merge — all three are now done. T015, T017,
  T018 and T019 remain unchecked; 037 T022 and 038 T022 remain unchecked.
- [ ] T017 **Deliberately not selected by D-207.** Persistent task/route details are out of scope. No
  book, thread or usage schema, route store or task record is added; a later proposal needs its own
  decision covering schema, ownership, privacy, versioning, migration and attribution.
- [ ] T018 **Deliberately not selected for any new total estimate by D-206.** No estimate is authorized
  or verified, so there is no new token/price basis to check. The unit-price and catalogue-context
  verification already covered by T008 stands. D-116's cost modes and any ceiling enforcement remain
  separate; nothing here claims a hard ceiling from catalogue math, a warning or a local reservation.

## Phase 3 — Future dispatch/fallback work is separately gated

- [ ] T019 **Blocked on T006.** Do not add direct task-router dispatch, automatic routing, fallback, or
  retry until the public authorization and recovery decisions are accepted and a separate implementation
  plan covers actual usage, uncertain charges, cancellation, and partial manuscript edits.
- [x] T020 Use only synthetic isolated fixtures for all preview, selection, and decision-record tests.
  Live-provider tests, real manuscripts, credentials, paid services, and device testing require separate
  authorization and are not acceptance evidence for this spec.
  Verified for every Phase-1 test existing now (27 routing + 24 dialog tests across 8 files):
  no `fetch`, no `LIVE_*`/environment reads, no vault/locator paths, no home-directory or
  absolute-path reads, no sample-library or temporary-directory use, no Node or network
  imports; the only `window.studio` objects are self-installed throwing bridges and one
  canned picker stub for the T012 positive control. The rule stays standing for T015–T019
  tests when those tasks unblock.
