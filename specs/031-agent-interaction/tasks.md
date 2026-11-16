# Tasks: agent interaction and guidance

**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)
**Status:** Draft / In progress — decision tasks T001–T003 reconciled to accepted D-177–D-179;
T004 and T010 implemented. W03 implements T007–T009 and T011 plus the mode/guidance
portion of T006; plan/lifecycle and integrated delivery verification remain open.

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
  terminal-stop prerequisite; see [stop-boundary evidence](stop-boundary.md). Plan lifecycle remains open.
  The consumer correction adds terminal ownership in Ambient, usage/conversation/approval warning
  accumulation and completion/background/toolkit propagation. Its 271-test focused pass and
  workspace typechecks do not close plan, host lifecycle or integrated delivery tasks.
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
- [ ] T005 Add validated plan and step state to the thread contract, with explicit parent-turn
  binding and allowed transitions. Persist proposed, active and terminal state through the existing
  thread store. Malformed or incompatible plan state must be reported without deleting the thread.
  Test with synthetic thread files.
- [ ] T006 Add mode, plan and guidance fields to the main-process turn/event contract. Reject
  invalid modes, oversized guidance and plans that exceed the selected bounds before a provider
  call or write can start. Test through the model factory seam without a network.
  W03: mode/guidance validation and request snapshots are implemented; actual user guidance
  and user/assistant mode persist, including failed, stopped and approval-waiting attempts.
  Retry identity includes prompt, mode and guidance. Plan/event expansion remains open.

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
- [ ] T012 Add guidance to a proposed plan and require a refreshed visible proposal before **Start
  plan**. No tool may write during this refresh. Keep live steering disabled under D-179.
  Partial: `packages/core/src/agent/proposed-plan.ts` refreshes guidance on a proposed Edit plan
  only. A blank value is omitted. More than 2,000 characters is refused without truncation or a
  write. The refresh returns a new frozen revision and does not change the previous proposal,
  mode, model, tool permissions, or approvals. A running, paused, started, or terminal plan is
  refused. No Plan first control is mounted and this task stays open.

## Phase 4 — Visible plan lifecycle

- [ ] T013 Add the explicit Plan first control for Edit turns and show a bounded, readable plan with
  ordered steps. Persist the proposed state and prove with a synthetic fixture that no write occurs
  before **Start plan**.
  Partial: the same pure contract builds an Edit proposal from a caller-supplied purpose and one
  or more ordered steps, each pending. Discuss is refused. Preparing a start names a new turn,
  the proposal id, and the current revision, and carries no approval. It does not call a writer,
  start a turn, or persist the plan. The Plan first control is not mounted and this task stays open.
- [ ] T014 Add Start plan and confirmed per-step progress using D-178's accepted new-turn continuation
  semantics. The model/runtime must report only observed outcomes; tests cover completed, skipped
  and not-completed steps using scripted events.
- [ ] T015 Add Pause and Resume according to T002. A requested pause is not shown as complete until
  the runtime confirms the boundary; no later tool may start while paused. Use a synthetic in-flight
  tool fixture to cover the chosen boundary.
  W04 prerequisite: the existing Stop now closes dispatch synchronously, retains settling ownership
  beyond five seconds, records late tool results and publishes one terminal outcome after persistence
  attempts. This does not implement plan Pause/Resume or complete this task.
- [ ] T016 Add terminal cancellation. Cancel stops later tool dispatch, does not roll back completed
  writes, expires any pending approval under 002 and reports the actual checkpoint/undo state. Test
  cancellation before a write, between steps and while approval is pending.
- [ ] T017 Add restart/reload expiry handling. A simulated new runtime must mark old non-terminal
  plans expired and refuse resume/replay; a renderer reload may reattach only to a plan-linked turn
  confirmed live by the same main process. Verify that partial work and checkpoint status remain
  visible.
- [ ] T018 Cover provider failure, save conflict, checkpoint failure and plan-state persistence
  failure. The synthetic tests must show the affected step and preserve existing checked-writer and
  recovery behavior without claiming a successful save or undo.

## Phase 5 — Accessibility and acceptance

- [ ] T019 Add component tests for keyboard-only mode selection, guidance controls, plan actions,
  approval distinction and announced progress/status. Check visible focus and status text without
  relying on color.
- [ ] T020 Complete the synthetic author journey: Discuss with no writes, a new Edit turn, a
  Plan-first proposal and explicit start, an approval pause, cancellation with partial work, and
  inspection of the stored outcome. Confirm no generic Apply/Reject edit card or duplicate model
  chooser appears.
- [ ] T021 Run the relevant type checks and test suites, update the format documentation and
  changelog when implementation is authorized, and review the final behavior against 002, 011,
  017, 024 and 025. Keep this task unchecked until that future work is actually performed.
