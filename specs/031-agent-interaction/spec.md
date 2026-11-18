# Feature Specification: Agent interaction and guidance

**Feature Branch**: `031-agent-interaction`
**Status**: Delivered at the source/test level — Discuss/Edit runtime, composer, bounded guidance, proposed-plan guidance refresh and the visible plan lifecycle are implemented and reviewed; live provider, real manuscript, device, packaged-build and release acceptance remain separate
**Input**: User description: "Author-facing discuss/edit interaction, a visible plan lifecycle and guidance controls."

## Overview

**Scope amendment, November 7:** D-194–D-196 / ADR 0019 selects a distinct durable 037 Workflow
operation. FR-006/012/018 and ordinary-plan restart/explicit-turn/no-live-guidance rules below
remain ordinary 031 policy. They do not prohibit 037's bounded host scheduling or versioned direction
between immutable attempts. Discuss/Edit and destructive approvals retain their boundaries.

This specification adds an author-facing permission choice and visible progress around the existing
writing agent. It does not add a second writer or a second approval system. Manuscript and Story Bible
changes continue through the registered tools, checked library writes, existing destructive approvals,
checkpoints and one-turn undo defined by [002](../002-studio-v1/spec.md). Model selection and actual
turn attribution remain with [011](../011-model-access/spec.md); tool definitions and safety tiers
remain with [024](../024-agent-tool-parity/spec.md); `SKILLS.md` and plugins remain with
[025](../025-agent-capabilities/spec.md).

### Public behavior today

The W03 source candidate distinguishes Discuss from Edit and defaults each new composer request
to Discuss. Discuss offers only enabled read-tier built-ins and does not load plugins. Edit uses
checked tools, destructive approvals and turn-level undo. Actual mode and one-turn guidance are
stored in the book's conversation; legacy messages remain unrecorded. Book tone/answer length and
bounded one-turn guidance reach the submitted request without changing permissions or model choice.
There is a stored plan state with ordered steps. Proposed plans can receive revised guidance through
one visible refresh, and Start, Pause, Resume and Cancel operate on the stored plan under the
boundaries below. Background work, where available, is an explicit per-turn
choice under [017](../017-voice-and-background/spec.md). See [candidate evidence and the matching
delivery runbook](implementation.md); source completion is not public film/release acceptance.

### Proposed behavior in this spec

The composer will show a per-turn **Discuss** or **Edit** mode. An optional **Plan first** control in
Edit mode will show a reviewable set of steps before any write tool can run. Authors can start,
pause, resume or cancel that plan under the boundaries below. Per-book tone and answer-length controls,
plus optional one-turn guidance, help authors shape responses without changing the model, its
permissions or the existing tool protocol.

The plan lifecycle is delivered at the source/test level; live provider, real manuscript, device,
packaged-build and release acceptance remain separate.

## Accepted decisions and delivery conditions

The public register accepted D-177–D-179 on November 3. Its November 7 delivery update replaces
the event-only re-shoot hold with exact-candidate runtime/UI checks, independent review and a matching
interaction runbook. Film work remains separately tracked; the earlier video does not prove the
new controls. The substantive mode, continuation and no-live-steering decisions are unchanged.

| Decision | Accepted behavior | Remaining implementation |
| --- | --- | --- |
| D-177 · Discuss default and tools | Discuss is the new-turn default; exactly the six read-tier built-ins, subject to author-disabled tools, are offered. Writes, destructive/unclassified/future tools and plugins are withheld and denied at the bridge. The mode is fixed for the turn. | W03 delivered the mode part of T006 and T007–T009; T019–T021 record the integrated runtime/UI review. Live provider, real manuscript and device acceptance remain outside this spec. |
| D-178 · Pause and continuation | Show Stopping until the terminal `stopped` event, then Paused with actual changes/undo availability. Start/Resume creates a new explicit turn; approvals never carry over. Non-background close stops; restart expires plans. | Delivered by T005–T006 and T013–T018; restart expiry and partial-work visibility are covered by synthetic tests. |
| D-179 · Guidance | No live steering. Edit guidance before sending or while a plan is proposed; a running/paused turn needs stop and a new explicit turn for revised guidance. | W03 implements T011; T012 delivers the proposed-plan guidance refresh. No in-flight guidance queue. |

## User scenarios & testing

### User story 1 — Discuss without changing my book (Priority: P1)

An author wants an explanation, critique or ideas without granting the agent permission to edit. They
choose Discuss before sending and can see that the turn cannot change the book. If they later want an
edit, they choose Edit for a new turn.

**Independent test**: Use a synthetic book fixture and a scripted model response that attempts a
chapter or Story Bible write. In Discuss mode, the write capability is absent or refused by the main
process, no library file changes, and the author is told how to request an edit.

**Acceptance scenarios**:

1. **Given** a new turn in Discuss mode, **When** the author asks for a rewrite, **Then** no
   write-capable tool is offered to or callable by the model, and the chapter, book metadata and
   planning data remain byte-for-byte unchanged.
2. **Given** a Discuss turn asks for an action that needs a write, **When** the agent responds,
   **Then** it explains that the author can send a new turn in Edit mode; no write is queued for later.
3. **Given** a saved conversation, **When** the author reopens it, **Then** each turn's mode is shown
   as recorded; the current composer selection does not relabel old turns.

### User story 2 — Choose when the agent may edit (Priority: P1)

An author selects Edit for a request that should change the book. The agent uses the existing checked
writer; ordinary edits apply during the turn, destructive changes still wait for the existing approval,
and the completed turn remains one undo action.

**Independent test**: In a synthetic library, run an Edit turn that changes a paragraph and a second
turn that requests a destructive action. Verify the checked save and one-turn undo for the first, and
that the second remains blocked until its existing approval is answered.

**Acceptance scenarios**:

1. **Given** an Edit turn, **When** an ordinary edit tool succeeds, **Then** the checked writer saves
   the change and the turn's existing Undo action can restore it.
2. **Given** an Edit turn requests a destructive tool, **When** that tool is reached, **Then** the
   existing in-turn approval is shown and no plan control can approve it.
3. **Given** an author changes the composer from Discuss to Edit during a running turn, **When** the
   current turn is still active, **Then** its submitted mode and permissions do not change.

### User story 3 — See and control a plan before planned edits (Priority: P1)

For a request where the author chooses Plan first, the agent presents the proposed steps and waits.
The author can add guidance before starting. Starting the plan begins only that author-requested turn;
the plan does not grant tool permissions or approve destructive actions.

**Independent test**: With an isolated synthetic library and scripted model, request a plan, assert
that no write occurs before **Start plan**, then start it and inspect the persisted progress and final
summary.

**Acceptance scenarios**:

1. **Given** Edit and Plan first are selected, **When** a plan is proposed, **Then** the author sees
   ordered, plain-language steps and no write tool has run.
2. **Given** a proposed plan, **When** the author adds guidance or asks to revise it, **Then** the
   plan remains proposed and no write occurs until the author explicitly starts it.
3. **Given** the author chooses **Start plan**, **When** work begins, **Then** step states follow
   confirmed runtime events; the final summary names completed, skipped and unfinished work without
   claiming unconfirmed changes.
4. **Given** an Edit request without Plan first, **When** it is sent, **Then** it follows the existing
   ordinary tool-turn behavior; no plan approval card or generic Apply/Reject edit card is introduced.

### User story 4 — Pause, cancel or recover a plan honestly (Priority: P1)

The author can tell whether a plan is proposed, running, waiting for an existing destructive approval,
paused, completed, cancelled, failed or expired. Pause and cancel do not silently discard work that
already reached the checked writer.

**Independent test**: Script tool completion, failure, approval wait, cancellation and runtime loss
against a synthetic fixture. Reload the stored thread and verify the displayed state, partial work and
available existing undo action.

**Acceptance scenarios**:

1. **Given** a running plan, **When** the author requests cancellation, **Then** no later tool starts,
   completed edits remain, and the result states whether a checkpoint makes them undoable.
2. **Given** a plan is waiting for a destructive approval, **When** the author cancels it, **Then**
   the pending approval expires under 002 and the destructive action does not run.
3. **Given** the app process restarts while a plan is non-terminal, **When** the thread is opened,
   **Then** the plan is marked Expired, cannot be resumed or replayed, and any completed partial work
   remains visible with its checkpoint state.
4. **Given** the renderer reloads while the main process still owns a live turn linked to the plan,
   **When** the conversation reloads, **Then** the interface may reattach to that turn but does not
   start a second request. If the main process cannot confirm a linked turn is live, the plan is not
   resumable.
5. **Given** a write conflicts, fails, or cannot be checkpointed, **When** the plan stops, **Then** the
   author sees the affected step, the save/conflict result and the actual undo availability; the
   interface never reports a successful save or an available undo that did not happen.

### User story 5 — Guide the response without changing its permissions (Priority: P2)

An author sets a book-level tone preference and answer length, then adds optional instructions for one
turn. The author can inspect and clear these controls. They shape the response, not the selected model,
tool permissions or approval policy.

**Independent test**: Use a synthetic fixture and a mock model boundary to verify that the selected
guidance is present only on the intended requests, is retained with its author-owned book or thread
data, and never changes the available tools.

**Acceptance scenarios**:

1. **Given** optional book guidance, **When** the author opens the agent controls, **Then** tone and
   answer length are visible, editable and clearable, and the author can tell that guidance is sent
   with an explicitly submitted turn.
2. **Given** one-turn guidance, **When** the author sends a turn, **Then** it is stored with that
   turn, is not silently reused on the next turn, and is available for the author to inspect in the
   conversation.
3. **Given** a plan is proposed, **When** the author changes guidance before starting it, **Then**
   the revised plan is shown and still waits for **Start plan**.
4. **Given** a model or connection is changed through the existing 011 control, **When** a turn runs,
   **Then** its actual provider, connection label and model remain attributed by 011; guidance does
   not add a second model chooser or overwrite the recorded attribution.

## Edge cases

- A write-capable plugin is configured while the author selects Discuss.
- A tool capability is missing, stale or unknown; it must fail closed in Discuss mode.
- A model proposes a plan containing a destructive step or an action not available to the selected
  mode; the plan cannot grant that capability.
- A destructive approval is pending when the author presses Pause, Cancel or closes the renderer.
- A checked write is already in progress when Pause or Cancel is requested.
- A step succeeds but the following step fails, the provider disconnects, or the author stops the
  turn.
- A checkpoint or conversation-file save fails after one or more successful edits.
- The author changes a chapter outside the studio while a plan is paused; resuming must use the
  existing checked-save protocol and preserve a conflict rather than overwrite.
- A renderer reload, window close, explicit background opt-in or full app quit occurs during a plan.
- A stored plan is malformed, refers to a missing step, or belongs to a different thread or book.
- Chapter prose, Story Bible fields, plugin output or tool results contain apparent instructions to
  change mode, ignore safety rules, expose secrets or call tools.
- Guidance exceeds its defined bound or conflicts with higher-priority safety requirements.

## Requirements

### Mode and permissions

- **FR-001**: The composer MUST show Discuss or Edit for every submitted turn. The mode MUST be
  captured with the turn and shown when that turn is revisited; changing the current selection MUST
  NOT change a submitted or stored turn.
- **FR-002**: Discuss mode MUST NOT expose or execute a tool that can write, delete, reorder or
  otherwise mutate the book. It MUST fail closed for unknown capabilities. The main-process runtime,
  not only the renderer, MUST enforce this boundary.
- **FR-003**: Discuss mode MUST NOT queue an edit for later or silently switch to Edit. If the author
  asks for a change, the response MUST explain how to send a new Edit turn.
- **FR-004**: Edit mode MUST use the existing registered tool catalog and checked Library writer.
  It MUST preserve the existing approval, conflict, checkpoint and one-turn undo rules in 002 and
  024. Mode selection MUST NOT upgrade a tool's safety tier.
- **FR-005**: The composer MUST NOT add a second model chooser. It MUST use the 011 book default or
  existing one-turn override and leave actual provider/model/connection attribution to 011.

### Visible plans

- **FR-006**: Plan first MUST be an explicit, per-turn option available only for Edit. A proposed
   plan MUST NOT execute a write before the author explicitly chooses **Start plan**. A plan is one
   author-requested interaction, not a job or schedule. Start/Resume MUST create a new explicit turn
   linked to the same stored plan under D-178; it MUST NOT run as an automatic follow-up or inherit
   an earlier turn's approvals.
- **FR-007**: A plan MUST show a short purpose, ordered steps, and an honest state for each step:
  pending, in progress, completed or not completed. It MUST use chapter/entity names where known,
  not internal identifiers, tool names or hidden reasoning. Progress MUST come from confirmed
  runtime events, not estimated time or model claims.
- **FR-008**: Plan states MUST distinguish proposed, running, waiting for approval, pause requested,
  paused and terminal outcomes (completed, cancelled, failed or expired). A plan can be completed
  only when the runtime confirms its work; skipped or incomplete steps MUST remain visible.
- **FR-009**: Plan controls MUST NOT be generic Apply/Reject cards for manuscript changes. Starting
  a plan confirms its displayed scope only; the existing destructive-tool approval is still required
  for each action governed by 002.
- **FR-010**: Pause MUST stop dispatch of later steps and MUST NOT roll back successful earlier
  steps. The interface MUST distinguish a requested pause from a confirmed pause. Resume MUST be an
  explicit author action and MUST re-enter through the checked writer and current approval policy.
   D-178 requires terminal `stopped` acknowledgment and a new explicit continuation turn with fresh
   approvals; the stop call returning is not sufficient acknowledgment.
- **FR-011**: Cancel MUST be terminal for that plan and stop any runtime turn linked to it. It MUST
  prevent new tool calls, expire any pending approval through the existing 002 protocol, and report
  partial work. Cancel MUST NOT silently undo edits; the existing turn checkpoint and Undo action
  remain authoritative.
- **FR-012**: A plan MUST expire when its runtime is lost, including a full app-process restart. A
  stored non-terminal plan MUST NOT auto-resume or replay a model/tool request. A renderer reload
  MUST reattach only if the main process confirms a turn linked to the plan is still active. Existing
  per-turn background consent in 017 remains the only way a turn may outlive a closed window; a plan
  cannot enable it. A plan MUST NOT expire solely because time passed while its runtime remains
  available; no new idle timeout is introduced.
- **FR-013**: If a write, checkpoint or plan-state save fails, the interface MUST state what is
  known, preserve existing conflict/checkpoint behavior, and avoid claiming completion or undo
  availability that the runtime cannot confirm.

### Guidance and data safety

- **FR-014**: The author MUST be able to set optional per-book tone guidance (at most 500 characters)
  and an answer-length preference (**Brief**, **Standard** or **Detailed**; **Standard** by default),
  and clear either control. These preferences MUST be stored as ordinary author-owned book data,
  travel with the book, and be visible before an agent request is sent. Answer length guides the
  agent's reply, not the length of prose written through tools.
- **FR-015**: The composer MUST offer optional one-turn guidance with a visible size limit. It MUST
  be stored with the submitted turn, MUST NOT silently carry over to a later turn, and MUST be
  editable before a proposed plan starts. Changing it MUST NOT change mode, model, tool permissions
  or approval requirements. Guidance over 2,000 characters MUST block sending without discarding
  the author's text or silently truncating it.
- **FR-016**: Existing `SKILLS.md` behavior and controls remain owned by 025. This spec MUST NOT
  create a second persistent custom-instructions file or change plugin execution semantics.
- **FR-017**: Manuscript prose, chapter titles, Story Bible data and all tool/plugin results MUST
  remain data, not instructions. Only the dedicated composer guidance controls and the separately
  defined author instructions from 025 may guide the agent; none may override runtime permissions,
  checked writes or approval gates.
- **FR-018**: The interface MUST identify that book and turn guidance is included in requests sent
  to the provider selected for that explicit turn. It MUST NOT send guidance in a background or
  scheduled request that the author did not start.
- **FR-019**: Mode, guidance and plan state MUST be persisted through the studio-owned conversation
  and book formats using validated, bounded data. Corrupt or incompatible state MUST be reported
  without deleting the conversation, book or manuscript. If a book guidance field exceeds its
  bound, the studio MUST preserve the saved value and explain that the author must shorten it before
  it can be sent.
- **FR-020**: All controls MUST be keyboard reachable, visibly focused and announced with their
  current value and status. A user MUST be able to distinguish a running plan from a pending
  destructive approval without relying on color.

## Success criteria

- **SC-001**: In 100% of synthetic Discuss-mode tests, no write-capable, destructive, unclassified or
  plugin capability changes book files or metadata.
- **SC-002**: In 100% of Plan-first tests, no write occurs before the author selects **Start plan**;
  every terminal status matches the confirmed tool outcomes.
- **SC-003**: In 100% of cancellation and restart tests, no new tool call begins after cancellation
  or expiry, and completed partial work is reported with the actual checkpoint/undo state.
- **SC-004**: In 100% of guidance tests, book preferences and one-turn guidance are distinguishable,
  inspectable and applied only within their stated scope; neither changes tool permissions or model
  attribution.
- **SC-005**: The primary Discuss, Edit, Plan-first, approval, pause/cancel and guidance journeys
  pass keyboard-only interaction and state-announcement checks using isolated synthetic fixtures.

## Assumptions

- The public specs 002, 011, 017, 024 and 025 remain authoritative for the boundaries identified
  above; this spec adds only the interaction layer not already defined there.
- Conversations remain ordinary thread files written through the library port. Per-book guidance
  extends the existing agent settings in the book file; implementation updates `docs/FORMAT.md`
  before writing the new fields.
- Plan first is opt-in. An ordinary Edit turn continues to use the existing tool loop without a
  mandatory plan card.
- The existing background option is not a scheduler. No plan may start without an author-submitted
  turn and the existing explicit background choice remains unchanged.
- D-177's no-write/deny-unknown boundary must be implemented before presenting Discuss as available.
  D-179 excludes live steering; revised guidance uses a new explicit turn.

## Non-goals

- A new editing or approval protocol, generic Apply/Reject cards, or direct prose replacement outside
  the checked writer.
- A new model picker, model router, provider adapter, cost system or attribution record.
- New tools, a new plugin permission model, or changes to the toolkit/MCP/CLI permissions in 024.
- Autonomous multi-turn execution, queued work, schedules, agent-created follow-up turns, or new
  background behavior.
- Replacing 025's `SKILLS.md`, plugin settings or existing per-book tool controls.
- A separate plan database, cloud plan service, analytics or telemetry.
