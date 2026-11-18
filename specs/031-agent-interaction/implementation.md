# W03 — Discuss, Edit and one-turn guidance

The subsequent [W04 terminal-stop prerequisite](stop-boundary.md) records the bounded D-178
implementation, focused evidence, unresolved-adapter behavior and additional interaction runbook.

## Candidate behavior

The composer defaults each new request to **Discuss**. Choose **Edit** explicitly
for a request that should change the book. Discuss can use only the six built-in
read tools still enabled for that book. It loads no plugins. Neither prompt text,
guidance nor a fabricated tool call can grant write permission.

Each submitted request keeps its mode and optional guidance in the conversation;
assistant outcomes keep the actual mode on completion, failure, stop and approval
wait. Historical messages with no mode show **Mode unrecorded**. A retry keeps its
original mode and guidance. The same prompt with changed guidance or mode is a new
request. Failed attempts remain recorded rather than being deleted.

Open **One-turn guidance (optional)** to add up to 2,000 characters. Over-limit text
stays in the field and blocks both Enter and Send. **Clear guidance** removes it.
After sending, the next request starts with empty guidance and Discuss selected.
While a request runs, its mode and guidance are fixed; stop it and explicitly send
a new request to revise them. No new request starts automatically.

Book tone (up to 500 characters) and answer length retain their existing settings
and prompt inclusion. Reply length does not constrain manuscript prose. Current
guidance joins only the current user request; earlier guidance stays inspectable
in the conversation but is not replayed to the model. Context accounting includes
it. Existing selected-provider/model attribution, destructive approval, checked
writer, checkpoint and undo behavior remain in use.

## Focused evidence

- `agent-modes.test.ts`: actual scripted SDK calls, all 16 non-read built-ins plus
  plugin/future/prototype names refused in Discuss; enabled read and withdrawn read;
  unchanged book bytes and chapter raw hash/content; zero plugin loading; direct
  bridge policy; invalid mode/guidance rejected before provider access; saved tone
  refusal preserves bytes; request snapshot; 500/2,000 boundaries; no guidance
  carryover; actual failed-attempt retry and Edit write/undo.
- `agent-runtime.test.ts`: existing destructive approvals/denials, checked conflicts,
  stop and undo regressions; added mode/guidance persistence on approval and stop,
  and mode/error persistence before any reply exists.
- `chat-composer.test.tsx`: default/reset mode, historical/legacy attribution,
  verbatim guidance limit, Enter refusal, fixed retry, clear-on-send and focusable
  native controls. Existing approval and undo UI regressions remain covered.
- `agent-tone-prompt.test.ts`: unchanged 4,000-token system budget including maximum
  tone and fixed mode. One-turn guidance is current user-request content, not part
  of the static system prompt. Research and alternatives are recorded in
  [the implementation decision](research/first-slice-implementation.md).

## Required interaction runbook and integrated acceptance

This is a source/test candidate, not a replacement recording. D-177–D-179's November 7
delivery update requires exact-candidate runtime/UI checks, independent review and this runbook.
The coordinator must update existing writing journeys to select Edit before each write request;
otherwise those requests now correctly remain read-only. Use this script for the
new interaction portion, with synthetic data and the isolated mock provider:

1. Open a synthetic book and a new conversation. Show **Discuss** selected. Ask
   about the opening, including a scripted attempted write. Show the refusal and
   the instruction to send a new Edit turn; verify source hashes remain unchanged.
2. Choose **Edit** explicitly. Open guidance, enter a short instruction, and submit
   an ordinary edit. Show the recorded **Edit** label and guidance disclosure.
   Show the checked change and undo restoring the previous prose.
3. Choose **Edit** again and request a destructive change. Show the existing
   Allow/Deny card; mode selection does not answer it. Deny or stop the request.
4. Show the next request back in **Discuss** with empty guidance. Reopen the
   conversation and show the recorded modes, including **Mode unrecorded** for a
   genuinely old synthetic message.
5. Paste 2,001 synthetic characters into guidance. Show the visible limit error,
   retained text and blocked Send/Enter. Shorten to 2,000 or clear it.

For integrated hidden checks, retain current test-only credential isolation; never
use an author profile/keychain or live provider. No recording/upload, packaged app,
light/dark visual pass or whole-application accessibility pass was performed by W03.
T019–T021 were delivered with the integrated plan slices. Plan-first, pause/resume plans and
guided execution are delivered at the source/test level; 037 autonomy remains separate work.

## Integration seams

- FORMAT already defines optional message mode and guidance parts. Clarify that the
  submitted user message also records mode, including requests whose model fails.
  No new field or legacy migration is introduced.
- ToolBridge accepts an optional captured mode and enforces it directly. Existing
  mode-less CLI/toolkit calls retain their separate established policy. Public
  tool-run schemas do not yet expose mode; any future mode-aware external caller
  needs the coordinator's IPC/backend contract wiring. The internal writing agent
  is independently enforced by its filtered and execution-guarded SDK tool set.
- Oversized hand-edited tone is preserved and runtime refusal explains the bound.
  The existing strict book parser can prevent opening that book; tolerant settings
  repair is a central Library/schema/UI seam, not silently added here.
