# Tasks: agent interaction and guidance

**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)
**Status:** Delivered at the source/test level — T001–T021 are recorded complete below. Live provider,
real manuscript, device, packaged-build and release acceptance remain separate.

Tasks are ordered. An unresolved decision blocks only the task that depends on it. All tests use
temporary synthetic libraries, fixture chapters and scripted model responses unless separately
authorized; no task requires a live provider, credential, paid service, real manuscript or device.

## Phase 0 — Resolve interaction semantics

- [x] T001 Decide and record the Discuss default and read-tool policy. Keep the no-write and
  deny-unknown invariant. Decide whether positively read-only built-in tools are available; plugins
  remain unavailable unless their public contract explicitly establishes a read-only capability.
  Blocks only the Discuss tool set and initial composer default.
  Accepted 2026-11-03 in D-177: `research/discuss-read-policy.md` pins the
  exact read-tier six, the `disabledTools` subset seam, bridge denial, and the plugin
  write-capable surface against five alternatives: read-only built-ins
  only with Discuss as the new-turn default, enforced by subset offer plus bridge and writer
  guards. That initial decision record preceded T007/T008; their W03 implementation is recorded
  below. The November 7 delivery update replaces the event-only re-shoot hold.
- [x] T002 Define the pause acknowledgment boundary, whether Start/Resume continue the same live
  turn or create a new explicit turn from the stored plan, and how a non-background plan behaves on
  window close. Specify what the interface says while an in-flight checked tool is settling.
  Preserve the rule that Start/Resume cannot answer a destructive approval. Blocks only plan
  execution, pause/resume continuation and non-background window-close handling.
  Accepted 2026-11-03 in D-178: `research/pause-continuation.md` pins
  terminal-stop facts, mid-write atomicity with reported outcome, and new-turn continuation
  against five alternatives: pause completes on the terminal `stopped`
  event ("Stopping…" until then), continuation is always a new turn, approvals stay per
  turn, close stops non-background turns and restart expires plans. W04 implements the bounded
  terminal-stop prerequisite; see [stop-boundary evidence](stop-boundary.md). The plan lifecycle was
  delivered by T013–T017. The consumer correction adds terminal ownership in Ambient,
  usage/conversation/approval warning accumulation and completion/background/toolkit propagation.
  Its 271-test focused pass and workspace typechecks did not close the plan, host lifecycle or
  integrated delivery tasks at that point.
- [x] T003 Decide whether new guidance can be added to a running or paused plan and whether that
  action revises the same plan or requires a new turn. Blocks only in-flight plan guidance; proposed
  plan guidance and pre-send controls can proceed.
  Accepted 2026-11-03 in D-179: `research/inflight-guidance.md` pins
  prompt fixity in-thread and the stop-plus-new-turn guidance journey against five
  alternatives: no live steering — revised guidance travels by new
  turns, with editing staying in pre-send, proposed-plan review, and `SKILLS.md`.
  Live steering is excluded by the accepted decision; this checkbox records the decision, not runtime delivery.

## Phase 1 — Persist the interaction contract

- [x] T004 Add validated, bounded mode and guidance fields to the studio-owned turn/thread schema,
  and per-book tone and answer-length fields to existing agent settings. Keep old threads readable
  with mode shown as unrecorded. Add the corresponding `docs/FORMAT.md` contract before writing the
  new fields. Test migrations and round trips with temporary synthetic libraries.
  Implemented: `AgentTurnInput` requires `mode` (`discuss`/`edit`) with optional bounded
  `guidance` (1–2,000 chars, rejected never truncated); the schema/store supports `mode` on the
  assistant message and a `guidance` part on the user message; agent settings gain `tone`
  (≤500) and `answerLength` (brief/standard/detailed, standard by default) with old books
  gaining defaults on read. In this initial schema-only slice every turn caller (composer, ambient, backend, bridge, live
  checks, tests) sends `edit`, preserving current full-tool behavior until T007 applies the accepted
  composer default. `docs/FORMAT.md` documents the thread and settings contract. Covered by
  `packages/core/tests/agent-interaction-contract.test.ts` (validation, legacy reads,
  store round-trips, defaults and bounds). No runtime permission or UI behavior changes;
  enforcement then remained with T006 and the composer with T007/T011. W03 subsequently implemented
  production mode/guidance and retry identity, as recorded below. A same-text request with changed
  mode or guidance must not silently reuse a different earlier request; schema round trips alone
  do not prove runtime population.
- [x] T005 Add validated plan and step state to the thread contract, with explicit parent-turn
  binding and allowed transitions. Persist proposed, active and terminal state through the existing
  thread store. Malformed or incompatible plan state must be reported without deleting the thread.
  Test with synthetic thread files.
  Implemented: the thread contract stores a bounded `plans` array with the nine stored statuses,
  four step states, an Edit proposal-turn parent binding, the pure lifecycle and step transition
  table, and terminal/no-removal store guards. A malformed plan is reported as corrupt and an
  unknown stored status or step state as unsupported; either way the file is left untouched.
  Runtime turn wiring, Start/Resume execution, the restart expiry sweep and the plan interface
  landed through T006 and T014–T017. The focused plan suites and the synthetic journey pass.
  Completed 2026-11-18; no new stored status or field was added.
- [x] T006 Add mode, plan and guidance fields to the main-process turn/event contract. Reject
  invalid modes, oversized guidance and plans that exceed the selected bounds before a provider
  call or write can start. Test through the model factory seam without a network.
  W03: mode/guidance validation and request snapshots are implemented; actual user guidance
  and user/assistant mode persist, including failed, stopped and approval-waiting attempts.
  Retry identity includes prompt, mode and guidance. Plan/event expansion was delivered by T014–T016.
  T006 builder: the turn contract now accepts an identity-only plan reference, returns the
  confirmed mode and running plan snapshot, refuses invalid, foreign, stale, non-startable,
  non-resumable, over-bound and mismatched plan turns before the provider, and records one
  start/resume write with a single fail compensation for a later setup failure. Additive plan
  notices are defined for T014–T018 and are emitted by those later slices. Focused synthetic tests
  pass; independent review and merge completed. Completed 2026-11-18.

## Phase 2 — Discuss and Edit permissions

- [x] T007 Add the visible per-turn Discuss/Edit control and store the selected mode with each sent
  turn. Show historical mode from stored turn data; do not infer or relabel it from the current
  composer. Apply the decided default from T001.
- [x] T008 Enforce Discuss permissions in the main-process runtime and tool construction, applying
  the exact read-only policy decided in T001. A
  synthetic model attempt to call a write, destructive or unknown capability must be refused and
  leave book and chapter fixture bytes unchanged. Keep plugin tools out of Discuss unless a
  separately accepted public capability contract permits them.
- [x] T009 Verify Edit still uses the shared 024 catalog, checked writer, existing 002 destructive
  approval and one-turn undo. A plan or mode control must not approve a destructive tool. Cover an
  ordinary write and a pending approval with scripted model responses.

## Phase 3 — Guidance controls

- [x] T010 Add author-visible per-book tone (maximum 500 characters) and answer-length controls
  (Brief, Standard, Detailed; Standard by default) to the existing agent settings, with clear/reset
  actions and a disclosure that values are included in submitted turns. Keep the values in ordinary
  book data and leave 025 `SKILLS.md` behavior unchanged. Test limits, blank, set, clear and
  archive/round-trip cases using synthetic books.
  Implemented: the existing `agent.setSettings` channel accepts and returns `tone` and
  `answerLength`, and `AgentStatus` carries both so the dialog can show them; the agent
  dialog gains a Tone and answer length section (tone input capped at 500 characters with
  Save/Clear, answer-length select defaulting to Standard, disclosure that both travel
  with submitted turns). Values stay in ordinary book data; `SKILLS.md` unchanged. Covered
  by `agent-interaction-contract.test.ts` (book persistence and archive-manifest
  round-trip) and `agent-tone.test.tsx` (dialog set/clear/disclosure/default) with
  synthetic fixtures only. Runtime inclusion of tone/answer-length in submitted turns
  stays with T011/future wiring.
- [x] T011 Add bounded one-turn guidance to the composer. Show that it applies to this turn only,
  enforce the 2,000-character limit without truncating, persist it with the turn and do not carry it
  into the next turn. Verify it cannot alter mode, tools, approvals or 011 model attribution. Use a
  synthetic thread and mock model inputs.
  W03: guidance is kept verbatim in the user message and only the current model request;
  composer and runtime reject over 2,000 characters. Existing book tone/length prompt
  wiring is retained, with pre-provider refusal of invalid saved guidance. See
  [implementation evidence and delivery runbook](implementation.md). These source/test
  completions do not close integrated runtime/UI verification and independent review. The November 7
  decision update replaces the event-only re-shoot hold; film work remains separately tracked.
- [x] T012 Add guidance to a proposed plan and require a refreshed visible proposal before **Start
  plan**. No tool may write during this refresh. Keep live steering disabled under D-179.
  Completed 2026-11-18: a proposed plan's card offers one visible Edit guidance control over a
  plan-scoped `agent.refreshPlanGuidance` channel and the existing `ThreadStore.refreshPlanProposal`.
  Saving writes exactly one new revision, keeps the plan proposed, and updates the visible revision
  and Start line; blank or whitespace-only text clears the stored guidance, 2,000 characters are
  accepted exactly, and 2,001 are refused without truncation or a write. The refresh starts no turn,
  asks no model, builds no tool set, writes no chapter or book bytes, changes no approval or
  checkpoint and publishes no event. Start sends the displayed revision with no guidance and uses
  the stored guidance. Running, waiting, pause-requested, paused, completed, cancelled, failed and
  expired plans show their guidance as a record with no editor, so live steering stays disabled.

## Phase 4 — Visible plan lifecycle

- [x] T013 Add the explicit Plan first control for Edit turns and show a bounded, readable plan with
  ordered steps. Persist the proposed state and prove with a synthetic fixture that no write occurs
  before **Start plan**.
  Completed 2026-11-18: the Plan first control sends a read-only Edit proposal; the runtime stores
  the assistant message and the plan with every step pending, and the conversation shows a stored
  plan card. Preparing a start names the plan id and current revision and carries no approval; Start
  creates the new Edit turn only after the author clicks it. The synthetic journey proves no book
  write occurs before Start and no Apply/Reject card appears.
- [x] T014 Add Start plan and confirmed per-step progress using D-178's accepted new-turn continuation
  semantics. The model/runtime must report only observed outcomes; tests cover completed, skipped
  and not-completed steps using scripted events.
  Implemented: the main-process runtime and renderer run a stored plan as one new Edit turn.
  Start keeps the identity-only ref and its pre-flight, emits no plan notice, and acknowledges the
  confirmed `running` state only through the turn-start result. A read-only Edit proposal turn
  stores its assistant message, then adds the plan and emits one `proposed` notice; a missing or
  invalid proposal and a failed add leave no plan. `plan_step` accepts one strict 1-based integer,
  writes only `in-progress`, and the runtime closes each step `completed` only from at least one
  successful observed tool result and zero failures, otherwise `not-completed`. Approval request
  and settled writes precede publishing and resuming, completion requires every step completed and
  the complete write applied, and a plan write failure ends as `plan-state` rather than completed.
  Pause, resume ownership, cancel and expiry were delivered by T015–T017. Renderer slice: Plan first sends one
  read-only Edit proposal request and reviews the stored plan from the conversation; Start sends the
  identity-only ref with the fixed prompt and no guidance, the plan card shows confirmed step labels
  and status, a refused Start removes its optimistic local rows, and the proposal and step control
  tools stay out of the author-facing tool list. The composer request fields, plan card and plan
  region no longer depend on a local proposal. The existing 20-step model loop cap remains; a longer
  plan fails honestly rather than completing in one turn, and raising it or continuing across turns
  stays with later lifecycle work. Completed 2026-11-18: the runtime and renderer slices are merged
  and independently accepted; the focused suites and the synthetic journey pass.
- [x] T015 Add Pause and Resume according to T002. A requested pause is not shown as complete until
  the runtime confirms the boundary; no later tool may start while paused. Use a synthetic in-flight
  tool fixture to cover the chosen boundary.
  Pause reuses the stop barrier: one request-pause write, in-flight settlement, one confirm-pause,
  then the terminal stopped event. No step write occurs after the gate; an open step stays
  in-progress. Resume is the existing identity-only turn with fresh approvals. The pause/boundary
  suites and the renderer states pass. Completed 2026-11-18.
- [x] T016 Add terminal cancellation. Cancel stops later tool dispatch, does not roll back completed
  writes, expires any pending approval under 002 and reports the actual checkpoint/undo state. Test
  cancellation before a write, between steps and while approval is pending.
  A plan-scoped cancel channel handles live and no-turn paths, expires a pending approval, keeps
  completed writes and reports the real change/undo facts. Cancel before a write, between steps,
  in flight, while waiting and on proposed/paused plans is covered; a failed cancel never claims
  cancelled. Completed 2026-11-18.
- [x] T017 Add restart/reload expiry handling. A simulated new runtime must mark old non-terminal
  plans expired and refuse resume/replay; a renderer reload may reattach only to a plan-linked turn
  confirmed live by the same main process. Verify that partial work and checkpoint status remain
  visible.
  A lazy thread-scoped sweep behind read and start expires unowned non-terminal plans, preserves
  terminal plans and partial work, and reattaches only a confirmed live plan turn. No clock, boot
  scan, auto-resume or replay; the runtime, renderer and IPC matrices pass. Completed 2026-11-18.
- [x] T018 Cover provider failure, save conflict, checkpoint failure and plan-state persistence
  failure. The synthetic tests must show the affected step and preserve existing checked-writer and
  recovery behavior without claiming a successful save or undo.
  The acceptance matrix covers provider failure after a write, a kept conflict copy, a checkpoint
  failure with no undo, complete+fail, boundary-close and step-store conflict. The failed-turn
  paragraph claims Undo only when the runtime confirmed it. Completed 2026-11-18.

## Phase 5 — Accessibility and acceptance

- [x] T019 Add component tests for keyboard-only mode selection, guidance controls, plan actions,
  approval distinction and announced progress/status. Check visible focus and status text without
  relying on color.
  A1–A18 cover the named card/status, one polite confirmed announcer, the focus matrix through
  Start/Pause/Resume/Cancel and refusals, described limits, one plan card in ChatPanel, the
  cross-unmount proposal announcement, reduced motion/transparency and the browser-only unsupported
  host. No control depends on color alone. Completed 2026-11-18.
- [x] T020 Complete the synthetic author journey: Discuss with no writes, a new Edit turn, a
  Plan-first proposal and explicit start, an approval pause, cancellation with partial work, and
  inspection of the stored outcome. Confirm no generic Apply/Reject edit card or duplicate model
  chooser appears.
  The hybrid ChatPanel-over-runtime journey passes: Discuss refuses its scripted write with
  unchanged bytes, Edit writes and undoes, Ask for plan writes nothing before Start, Start runs the
  observed steps, the destructive step waits at the 002 approval, Cancel keeps partial work and
  expires the approval, and a reopened library shows the stored outcome. One model chooser, one
  plan card, no Apply/Reject or plan approval control. Completed 2026-11-18.
- [x] T021 Run the relevant type checks and test suites, update the format documentation and
  changelog when implementation is authorized, and review the final behavior against 002, 011,
  017, 024 and 025.
  Completed 2026-11-18: `bun run typecheck` has a clean node project, a clean toolkit and only the
  pre-existing `WorkspaceView.tsx:1816` web diagnostic; the full `bun test` run is 4,941 pass,
  1 skip, and one pre-existing editor-sync timing failure with its unhandled error; the focused
  plan suites are 202 pass. `bun run smoke` is blocked by that pre-existing typecheck and the host's missing SUID
  sandbox, so no packaged or hidden-UI smoke claim is made. FORMAT and CHANGELOG were reviewed as
  accurate; the 002/011/017/024/025 boundaries are recorded in the verification report. No live
  provider, real manuscript, device, packaged-build or release acceptance is claimed.
