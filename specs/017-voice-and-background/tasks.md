# Tasks: voice notes and background runs

**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)

Tasks are ordered. `[P]` means it can run in parallel with the other `[P]` tasks in the same phase.
A task blocked on an open decision must not start until it is accepted.

## Phase 1 — Speech contract

- [x] T001 Add `packages/core/src/providers/speech.ts`: Meta endpoint and model constants, WAV header
  and duration validation, multipart request construction, response parsing and typed transcript.
  Export it through `./providers/*`; cover valid, truncated, stereo, wrong-rate and non-WAV input.
  `speech.test.ts` has 12 cases; `speechForm` sends the documented `request` JSON and `audio` WAV parts.
- [x] T002 Add `VoiceService` in `apps/desktop/src/main/voice.ts`. Select the first Meta connection,
  read the secret only in main, post the form with a timeout, normalize provider errors and return the
  transcript plus duration. `voice-service.test.ts` covers the form, auth mapping, non-WAV refusal and
  connection selection with a memory vault and a mocked `fetch`.

## Phase 2 — Microphone and editor

- [x] T003 Add `packages/app/src/lib/audio.ts`: decode a recorded blob, mix to mono, resample to
  16 kHz, encode 16-bit PCM WAV. `audio.test.ts` covers the header, sample conversion and linear
  resampling without a browser.
- [x] T004 Add `useDictation` and `VoiceButton` with idle, requesting, recording, transcribing and
  error states, a 10-minute cap and a visible timer. The button is unavailable in the web build with
  the desktop-only reason.
- [x] T005 Insert the transcript at the textarea selection through the existing `applyText` path.
  The pure insertion logic is in `voice-text.ts` and tested for spacing, punctuation, selections and
  silence; the editor keeps the caret and marks the chapter dirty.

## Phase 3 — IPC and builds

- [x] T006 Add `IPC.voice.connections` and `IPC.voice.transcribe` to the core contract, preload,
  desktop handler and browser refusal. The desktop handler validates the connection id, audio size,
  language list and keyword list with Zod before the service.
- [x] T007 Add the macOS microphone usage string to `electron-builder.yml`, the audio-input
  entitlement and a main-process permission handler that allows only audio capture.

## Phase 4 — Background turns

- [x] T008 Add `background?: boolean` to `AgentTurnInput` and an outcome callback to `AgentRuntime`.
  The callback fires after `done`, `error`, `stopped` and an approval pause; the existing event stream
  is unchanged.
- [x] T009 Add `BackgroundNotifier`: notification copy, visibility decision, dock badge and
  focus-on-click. `background-copy.test.ts` covers the copy, preview, approval and stop rules.
- [x] T010 Wire the notifier in `index.ts` and add a per-turn "Background" control to `ChatPanel`.
  The control resets after each send and is not persisted on the book.

## Phase 5 — Evidence and docs

- [x] T011 Add the voice/background sections to `docs/ARCHITECTURE.md`, the audio decisions to
  `docs/DECISIONS.md` (D-125–D-127), the spec link to `specs/README.md` and the changelog entry.
- [x] T012a Dictation with a real recording: the check speaks a known phrase, converts it to the
  16 kHz mono WAV Meta accepts, and transcribes it. The transcript matched all nine words. Recorded in
  `docs/research/live-meta-2026-10-26.md`.
- [ ] T012b The rest of the manual pass: deny the microphone once, force a 401, close the window
  during a turn and confirm the notification and the stored thread. Pending: a notification pass
  needs a signed or locally permitted macOS app and a person at the machine.

## Dependencies

- T001–T011 are complete and need no live Meta key; the automated suite covers the contracts.
- T012 needs a Meta key and macOS notification permission.
- Realtime dictation, diarization UI and browser dictation wait for D-125–D-127.

## Hands-free follow-through — D-200 / ADR 0021

Existing checked rows describe their original slice. T012a used generated known audio, not a person
using a microphone. New work does not close 038 T022 or the remaining manual/device gates.

- [x] T013 Add pure explicit-session, bound-target, command/confirmation and interruption reducers.
  `packages/core/src/voice-session/` contains the unmounted immutable reducer, pinned route/scope
  generations, exact named readbacks, correction/stop/settlement gates and 037 answer-intent projection.
  Its local README specifies trusted host ownership and integration requirements; no runtime authority
  or actual track/transport stop is claimed by an effect description.
  Independent-review correction adds permission/stop ordering, bounded attributable failed receipts
  with exact explicit acknowledgement, and playback completion independent from display status.
 144 pure tests pass; fresh exact-head correction review remains required before integration.
- [x] T014 Add bounded injected PCM/VAD segmentation, preroll/end-silence and one-STT backpressure tests.
  Synthetic tests cover the 1.2s/250ms/60s defaults, bounded reads/PCM, explicit held state, exact
  unconsumed suffix, noise/silence, stale results and never-settling slots. The injected classifier
  is not a certified acoustic detector; actual host intake/echo/local-engine qualification remains.
- [x] T015 Add pure trusted-main-frame/audio-grant predicates; wire both permission handlers under one owner.
  Pure `permission.ts` and synthetic sender/frame/origin/audio-only/expiry tests are implemented.
  The desktop host now owns both Electron handlers in `apps/desktop/src/main/voice-permissions.ts`.
  It derives the renderer origin from the real packaged `file://` or dev-server load path, denies
  missing/ambiguous sender, frame, origin and media facts, and preserves trusted audio-only
  push-to-talk without creating a grant. An in-memory exact hands-free grant (injected clock,
  register/replace/revoke/clear, window-close/quit revocation) is checked through pure
  `permitsAudio`/`activeAudioGrant`; 37 synthetic host tests pass. Actual OS grants/microphone,
  mounted hands-free capture, owned-track stop and T022–T024 remain unclaimed.
- [ ] T016 Add host-owned cancellable STT/TTS request IDs, per-chunk route checks and honest unknown-charge state.
  Partial: pure `voice-session/transport.ts` owns monotonic operation/chunk IDs, one-slot
  backpressure, exact session/route/permission rechecks immediately before each dispatch,
  best-effort abort with owned-slot retention, duplicate/late-receipt rejection and
  success/refusal/failure/cancellation plus unsent/reported/unknown charge. A typed edge maps
  provider cost and service failures, and `VoiceService`/`SpeechService` accept an optional host
  abort signal (TTS rechecks before every chunk). No mounted host registry, IPC/preload cancel
  surface, proof of provider-side cancellation, live call or device evidence exists yet.
- [ ] T017 Mount session/transcript/correct/confirm/stop controls with actual Discuss/book/chapter/thread binding.
  Partial: the Discuss panel mounts an explicit hands-free bar and a host-neutral controller
  (`packages/app/src/lib/hands-free.ts`, `components/HandsFreeBar.tsx`,
  `hooks/use-hands-free-session.ts`). It composes the T013 session reducer, the T015 grant predicates
  and the T016 transport ledger; a session starts only from an active audio-only grant and the
  grant's own session identity, a transcript becomes an editable draft, confirm reuses the existing
  checked Discuss turn start exactly once, and Stop reports stopping until the host settles. A
  book/chapter/thread change ends the session, keeps the unsent words visible and cannot send them to
  the new target; a transcript after Stop is ignored. Synthetic controller and component tests pass.
  No capture adapter, OS prompt, live provider, playback arbitration or device evidence is mounted:
  without a host adapter the bar states that hands-free audio is not connected and records nothing.
  Lifetime correction: capture admission rechecks after every await; original-port ownership joins
  pending acquisition and closure across Stop/disposal, with exact shutdown-attempt receipts and
  visible failed cleanup. Committed scope/port epochs revoke A–B–A intents. Attributable transcript
  receipts release matching core requests even when revoked words are discarded. ChatPanel carries
  revocable admission through its existing draft flush to the actual agent-start boundary; Stop stays
  usable during send-start and dispatched outcomes remain attributable. Positive synthetic race
  tests cover these contracts, unique status descriptions, retained correction focus and StrictMode.
  The mounted seam now accepts only the documented single-realm `synthetic-in-process-v1` contract:
  monotonic host-fact revisions and prompt notifications, independent host closure on loss/expiry,
  and synchronous admission at the actual capture/STT/agent boundary. Per-port synthetic ownership
  retains outstanding STT and exact unknown-charge/late receipts across remounts; failed partial
  acquisition is compensated and failed cleanup remains unconfirmed. A marker or renderer revision
  cannot qualify a native IPC host: trusted-process atomic admission, independent lifecycle closure,
  provider and device evidence are still required. This is synthetic source/test evidence, not native
  capture, provider or connected-host acceptance.
  Later-request history correction: pending voice words are display-only until actual host dispatch.
  Mounted tests inspect subsequent typed and newly confirmed voice requests after Stop, host refusal
  and flush failure, preserving nonempty legitimate history and local words; already-dispatched
  success/failure/rejection remains eligible. This is request-boundary evidence, not provider
  disclosure/receipt or native-host qualification. Fresh exact-head review and broad gates remain.
  T018–T024 and 038 T022 remain unchecked.
- [ ] T018 Preserve selected manuscript text and intended verse breaks by default; explicit replacement
  uses checked editor mutation/undo and exact-source confirmation.
  Partial evidence: default dictation inserts at the selection start and keeps the selected characters.
  Replace selection is an explicit one-shot control that removes only that range when the editor
  revision and selection still match. Intended line breaks stay. The insert still uses the existing
  compare-and-set path and one isolated undo. This note does not close the task.
- [ ] T019 Integrate qualified interruption/playback arbitration with real settlement; no premature Stopped
  or lost save/accounting warnings, including Result failures and never-settling effects.
- [ ] T020 Add source-bound paragraph reading/following, speed, selectable qualified local voices and
  positively local dictation capability with explicit cloud choice where local is unavailable.
- [ ] T021 Bind check-in/approval/revision commands to 037 question/epoch and exact named action identities.
- [ ] T022 Pass synthetic host/UI race, backpressure, echo/noise, permission, lifecycle and accessibility matrix.
- [ ] T023 Separately qualify actual microphone/near-end/echo/latency/local-engine behavior on each claimed host.
- [ ] T024 Record native/companion/packaged lifecycle and device evidence separately from source tests.
