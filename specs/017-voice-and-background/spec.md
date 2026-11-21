# Voice notes and background runs

**Status:** In progress — T016 delivered at source/test level (synthetic evidence); T017 hands-free and device/packaged evidence remain open; D-200 hands-free extension accepted
**Number:** 017
**Depends on:** [011](../011-model-access/spec.md) provider connections, [002](../002-studio-v1/spec.md)
agent runtime and threads, [010](../010-web-target/spec.md) build split.

## Why

**November 7 amendment:** 038/D-192 supersedes the first slice's Meta-only/first-connection choice
with explicit profile-local routes. D-200 / ADR 0021 adds the hands-free requirements below; historical
PTT non-goals do not exclude them. D-194–D-196 separately governs durable 037 workflows; FR-014/018
remain ordinary-turn policy, not workflow authority. No microphone/device evidence is implied.

Two things separate a writing studio from a chat window. The author can speak a paragraph instead of
typing it, and the agent can keep working after the author closes the window and tell them when the
work is ready.

Both are opt-in. Neither may copy audio, prose or keys to a studio server. The desktop app is the
first target; the web build says plainly where a capability is unavailable.

## User stories

1. **Dictate a paragraph.** I put the cursor where the scene should start, press the microphone, speak,
   press stop, and the transcript appears at the cursor. I can edit it before it saves like any other
   text.
2. **Leave the agent working.** I ask for the next scene, tick "Keep working if I close this window",
   close the window, and get a system notification when the turn finishes. Opening the app shows the
   saved turn in the conversation.
3. **Know when the agent needs me.** A background turn stops at a destructive tool call. The
   notification says which action is waiting; opening the app shows the approval.
4. **Use my Meta access.** Dictation uses the Meta connection and Muse Voice Transcribe. It never uses
   a hidden studio account, and the audio is discarded after the request.
5. **Understand a refusal.** If the microphone is denied, the provider is offline, the recording is too
   long, or the audio is not a supported WAV, the studio says what failed and keeps the manuscript
   untouched.

## Requirements

### Dictation

- **FR-001** Dictation MUST use the author's connected Meta Model API credential and the
  `muse-voice-transcribe-1.0` model through `POST /v1/asr/transcribe`.
- **FR-002** The renderer MUST record with the platform microphone and convert the recording to mono,
  16-bit PCM WAV at 16 kHz or 24 kHz before upload. The Meta endpoint does not accept WebM or Opus.
- **FR-003** The app MUST enforce the provider limits before the request: 32 MB body, 10 minutes of
  audio, mono 16-bit PCM, and a supported 16/24 kHz sample rate. Invalid audio is refused locally.
- **FR-004** Audio MUST NOT be written to the library, the archive, the thread store, logs or a
  temporary file. It exists in memory for one request and is discarded.
- **FR-005** Under D-200, default dictation MUST insert at selection start while retaining selected
  text; Replace selection is an explicit action. Preserve intended newlines. Use the normal editor
  text/draft/checked-save path. Current replacement/whitespace behavior needs correction under T018.
- **FR-006** A failed transcription MUST NOT change the chapter, the draft or the save status.
- **FR-007** The request MUST send `mode: "PUSH_TO_TALK"`, `audioEncoding: "WAV"`, optional
  `languageBias` and optional `keywords`. No author prose is added to the request.
- **FR-008** The browser build MUST NOT send audio until Meta browser access is verified. It shows the
  desktop-only reason instead of a microphone that fails after recording.
- **FR-009** Microphone permission is requested only after the author presses the button. A denied or
  unavailable microphone is explained once, without a permission loop.

### Background runs

- **FR-010** A turn MAY be started with `background: true`. The Electron main process owns the turn, so
  closing the window does not stop it. The thread store remains the source of truth.
- **FR-011** When a background turn finishes, fails or pauses for approval, the main process MUST show a
  native notification. The notification names the book and the outcome and does not include manuscript
  text beyond a short preview the author can already see.
- **FR-012** Activating the notification MUST show and focus the studio window. It MUST NOT open a URL,
  send a message or run another turn.
- **FR-013** Destructive tools still require approval. A background turn that pauses MUST remain paused,
  persist the pending approval and tell the author through the notification; it MUST NOT auto-approve.
- **FR-014** Background runs are opt-in per turn. The setting is not stored on the book and does not
  change the book's default model.
- **FR-015** Background work is a desktop capability. On macOS the app stays alive when the window
  closes. The web build and a quit app do not promise background execution; the copy says so.
- **FR-016** A background turn MUST NOT contact a person, send email, post to a network or call an
  external service outside the configured model provider. "Reach out" in this spec means notify the
  author.
- **FR-017** The app MUST NOT prevent system sleep or run after the author quits. It may keep the
  process alive after the last window closes on macOS through the normal app lifecycle.
- **FR-018** A finished background turn is recorded in the existing usage store and thread exactly like
  an interactive turn. There is no second history.

### Hands-free extension — D-200 / ADR 0021

- **FR-019** Explicit Start conversation MUST bind host/frame/library/book/chapter/thread, visible
  mode and selected routes to a revocable generation; no automatic capture on open or resume.
- **FR-020** Local utterance segmentation MUST enforce memory/bounds/backpressure with visible state;
  audio remains memory-only. Silence never becomes a provider request or a command.
- **FR-021** Qualified local interruption MUST silence playback and inhibit future dispatch before
  cloud transcription. Checked effects settle truthfully; noise/no-match cannot auto-resume work.
- **FR-022** Deterministic typed commands and exact-target confirmations MUST separate questions,
  Edit, destructive approval, undo and workflow grants. Corrections cannot rewrite sent history.
- **FR-023** Host-owned STT/TTS operation IDs MUST close future sends immediately on cancellation,
  abort current transport best-effort and reject stale results/chunks. Unknown charges stay unknown.
- **FR-024** Both permission handlers MUST require the correct trusted main-frame sender and active
  audio-only grant; end every owned track on hide/lock/close/loss and require explicit reactivation.
- **FR-025** Reading MUST retain source-bound paragraph position, qualified speed/device voices and
  explicit local-input capability. All actions/states have text/keyboard equivalents and no fallback.
- **FR-026** Spoken character check-ins MUST use 037's question/direction identities and checked answers;
  silence never answers, revoke beats late confirmation and hidden windows never auto-start listening.
- **FR-027** Full-duplex/local-engine, actual microphone, device and release evidence MUST be distinct
  from synthetic contracts and historical generated-audio STT. 038 T022 remains unchecked.

## Non-goals

- Realtime WebSocket dictation, partial transcripts or live captions. v1 uploads one completed WAV.
- Speaker diarization UI. The provider may return turns; v1 uses the combined transcript.
- Always-listening wake words and unrequested capture. Voice output/commands now follow D-200/038.
- A hosted job queue, remote workers or background execution in the web build.
- Email, messaging, calendar or any other outbound integration by the agent.
- Recording while the app is quit or while the operating system suspends the process.

## Acceptance scenarios

1. **Dictation.** With a Meta connection, press the microphone, speak, stop. The transcript appears at
   the cursor, the word count updates, and the chapter saves through the normal path.
2. **Bad audio.** A fake WebM payload sent straight to the service is refused before any request; the
   chapter is unchanged.
3. **Provider failure.** The service returns 401, 429 or 500. The editor keeps the text and shows one
   provider-specific sentence; no audio or key appears in the message.
4. **Background finish.** Start a turn with the background option, close the window, wait. The turn
   completes, the thread contains the assistant message, and a notification appears.
5. **Approval pause.** A background turn requests `overwrite_chapter`. The turn waits, the approval is
   stored, and the notification says the agent needs the author.
6. **No hidden channel.** With a proxy in front of the network, dictation and a text turn contact only
   the configured provider. Closing the app ends all work.

## Open decisions

- **D-125** Audio retention: v1 keeps audio only in memory. A future "keep the recording" feature needs
  a format, a consent copy and a deletion path.
- **D-126** Background policy: v1 notifies on every background outcome and leaves destructive approvals
  paused forever. A timeout or an auto-deny policy needs a separate decision.
- **D-127** Browser dictation: blocked until Meta's browser access is verified in the D-101 table.

These original decisions are accepted. D-200 adds the explicit-session contract; D-109 platform
qualification and live hands-free acceptance remain separate implementation/evidence work.
