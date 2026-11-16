# Pure voice-session core — D-200 / ADR 0021

This is an **unmounted, platform-independent leaf**, implementing 017 T013/T014, the pure part of
T015 and the partial T016 transport contract. Import its local `index.ts` directly in leaf tests.
The leaf itself changes no shared package export, existing PTT hook, profile preference, permission
handler or editor. The separately owned desktop host now imports these predicates for both real
permission handlers (see below), and T016 adds one typed edge that lets the two existing provider
services take a host abort signal; neither wiring upgrades the leaf's evidence to OS, microphone,
provider or device qualification.

## Selected basis and bounded implementation decisions

ADR 0021 / D-200 is the accepted policy, rather than the earlier research recommendations.
D-125 keeps audio in memory; D-192 pins explicit routes without fallback. The existing
`VoiceService` checks selected STT connection/model and the existing `SpeechService` loops TTS
chunks. T016 adds an optional abort signal to both. Neither service is this module's session
authority, and neither is the desktop cancel registry. These files do not upgrade the leaf to a
provider or device proof.

Use a synchronous immutable reducer plus **effect descriptions**, rather than embedding promises
or transports: a never-settling effect cannot delay revocation. Keep one bounded outstanding slot
for each of STT, TTS and work; canceled operations retain their slot until a matching settlement.
This intentionally favors a visible hold over overlapping an uncertain request. No timeout claims
an external operation stopped, was refunded, or cost zero. No request retry is automatic.

Failed receipts occupy a separate bounded slot per kind (STT/TTS/work), with the exact originating
request and host-redacted message. They survive Stop, lifecycle invalidation and new activations.
Reuse of that kind waits for exact `acknowledge-failure`; the reducer never overwrites or evicts an
unacknowledged receipt. Acknowledgement does not enable capture/dispatch or resume work. These are
transient presentation receipts, not a replacement for the host's durable runtime/accounting record.

Local engineering bounds (not provider or acoustic certifications): safe integer generations and
IDs; strings used as identities/routes up to 2,048 UTF-16 units; transcript/correction text up to
65,536 UTF-16 units; 64 consumed confirmations and 64 answered question projections per activation.
These lists refuse further intents at capacity; they never evict/replay. The host must retain an
oversize transcript for explicit recovery when the reducer refuses it. These are transient records,
not a new file format or durable question store. The host still owns durable idempotency and budgets.

## Session and intent contract

- Only `start` requests permission. `initialVoiceSession()` and `observe` do no activation.
  Start binds host/window/main-frame/origin/library/book/chapter/thread, actual mode, source digest,
  scope revision and exact STT/TTS/agent routes (including connection, model, destination, voice,
  revision). The host supplies a fresh opaque session ID and strictly increasing safe generation.
- The host increments scope/route revisions on **every** change, even A → B → A. Source digests
  cover the selected current source. Never derive epochs from a mutable renderer preference.
  Copy/freeze the binding and retained intents; later mutation of caller data cannot change them.
- `capture`, `status`, `dispatchInhibited` and outstanding request slots describe different facts.
  `stopped` describes the voice session, **not** terminal runtime/work settlement. UI must present
  outstanding slots as unresolved even when capture is stopped. `requesting`, `listening`,
  `processing`, `held`, `review-needed`, `speaking`, `interrupted`, `stopped`, `unavailable` are distinct.
- Stop speaking closes speech/chunk playback gates. Pause work inhibits and asks the host to pause;
  Stop work asks the host to stop and blocks further check-in answers for this activation. Stop
  listening ends capture/voice outputs, without a work-stop intent. Bare Stop silences, inhibits,
  asks for pause, closes capture and invalidates the grant. None needs confirmation.
  Successful permission completion grants capture independently: it retains an earlier Pause/Stop
  work interruption and dispatch inhibition. Only explicit Continue may reopen that work gate.
- `parseVoiceCommand` accepts only whole local commands in explicit command mode. It does not
  parse free-form story dialogue. Bare yes does not send/confirm. Structured correction and named
  undo carry explicit payloads instead of guessing targets from speech. Read/Next/Repeat emit
  presentation intents; the host resolves actual reading/navigation and invalidates scope as needed.
- Optional disclosed Discuss auto-send emits only `submit-discuss` with exact bound context.
  The host must use read-only tools and exclude unapproved plugins. Edit, destructive approvals,
  undo, destination changes and workflow grants require host-prepared immutable readback and exact
  `Confirmation`. Host `NamedAction.digest` covers **all** action/target/source/text/payload fields;
  this module compares it, it does not compute or authenticate it. Matching text is also checked
  literally. `confirmed-intent` is an intent, not a Library write, preference mutation or 037 grant.
- Before-send correction changes only pending text and holds capture. After-send correction closes
  future work and preserves `lastSentText`. Explicit Continue waits for all occupied slots, then
  emits a new-direction intent; it never recalls history or automatically sends that direction.
- Qualified onset silences and inhibits locally before STT. An interrupted/no-match state requires
  explicit Continue; a successful transcript cannot silently resume interrupted work. Ordinary
  successful Discuss submission can rearm capture to allow the next utterance/barge-in. In half-duplex,
  speech holds capture. Host loss of full-duplex qualification closes capture on observation.
- STT results, TTS-ready/playback events, confirmations and settlements match exact token/request IDs.
  Explicit `start-speaking` has a monotonic speech ID; each chunk has a monotonic ID within it.
  Stop speaking cannot be undone by a late chunk. A canceled old STT slot survives Start until actual
  settlement; old settlement can release its own slot but cannot rearm capture or replace new content.
  `playbackReady` tracks an admitted TTS result independently from display status. Work settlement
  cannot invalidate its queued playback; interruption still closes the immediate-use gate. An exact
  `playback-ended` receipt releases that admitted request even after pause, correction, Stop or a new
  generation. A canceled synthesis with no admitted result still needs generic settlement. Old/foreign
  playback receipts cannot release a replacement slot, and no receipt alone rearms held capture.
- Restart begins stopped and carries no permission. The caller must preserve visible pending text
  from the previous immutable state before replacing it with a new activation; no transcript log
  or persistence is created here. Reopening/hiding/locking/permission loss cannot implicitly Start.

## Required host adapter

Items 1–2 and 4–8 remain for the future host adapter. The Electron sender/fact extraction, both
handler decisions and the ephemeral grant registry from item 3 are now implemented in
`apps/desktop/src/main/voice-permissions.ts`; the hands-free adapter that issues and consumes a
grant is still not mounted.

1. Keep reducer state and `HostFacts` in the trusted host. Authenticate author controls separately from
   provider text and renderer claims. Validate external wire payloads before this typed internal API.
   Serialize events, publish the new state **before** executing effects, and consume each effect once.
   Effect replay is not safe merely because the reducer is pure.
2. Build `HostFacts` afresh from real host/capability/catalog/profile/source state. A renderer-supplied
   `available`, frame ID, origin, digest, grant, route revision or full-duplex flag is not authority.
   Observe all hide/close/lock/sleep/source/route/grant transitions immediately; process loss destroys
   capture ownership. A new process uses fresh session IDs. Do not persist live grants.
3. Issue an audio-only grant for the exact permission attempt/session. The desktop host now owns
   both Electron handlers in `apps/desktop/src/main/voice-permissions.ts`: it extracts the real
   sender `WebContents`, window identity, trusted top-level frame, renderer origin and media list,
   and denies missing or ambiguous facts. The origin comes from the real load path — the packaged
   `file://` renderer or the electron-vite dev server's exact `http(s)` origin — never a wildcard.
   Trusted audio-only push-to-talk keeps its existing explicit-press path and creates no grant;
   hands-free audio additionally needs the exact in-memory grant through `permitsAudio` /
   `activeAudioGrant`, and window close or quit revokes it. This is source and synthetic-test
   evidence, not an OS grant, microphone, mounted hands-free adapter or owned-track qualification.
   Missing or ambiguous callback facts always deny. A field that is present but empty,
malformed or of an unsupported scheme denies rather than deferring to the other origin field.
An unset or empty development server URL follows the real `loadFile` fallback to `file://`; a
present but unparseable or non-`http(s)` URL denies.

`VoicePermissionDecision.captureAllowed` is a **capture gate only**, not hands-free authority. The
future adapter must still require the exact active grant (`activeAudioGrant`/`permits` with the
expected token) immediately before PCM intake; the permission callback cannot distinguish
push-to-talk from hands-free `getUserMedia`.
4. Call `mayCapture` before PCM intake; `maySend` immediately before **every** external request or
   checked intent dispatch and after every await; `mayPlay` before decoded audio playback;
   `mayDeliverAnswer` immediately before the authoritative 037 checked-answer operation. Recheck the
   real action/target/source/grant again at the writer/approval boundary. A returned boolean is never
   a reusable capability. Stop/revoke must win atomically against queued answers/publications.
5. Execute track/playback stop, grant revocation and best-effort transport abort without awaiting
   settlement before honoring the closed gate. Stop **every owned** track, including streams delivered
   after permission cancellation. Do not infer machine-wide microphone shutdown or provider refund.
   A failed abort/stop Result must be visible; keep the unresolved operation until a real receipt.
6. STT success uses `transcript`; TTS success uses `tts-ready`, followed by exact `playback-ended`.
   Do not send a generic `settled` before consuming a successful result. `settled` is for final
   cancellation/failure/work receipts, has no result delivery, and never auto-resumes. Route STT
   no-match through empty `transcript`; canceled operations use settlement, never late content.
    Include a host-redacted `failure` on a failed receipt. Always present `state.failures`, including
    when stopped or showing a newer session: exact request/session/route identity stays attributable,
    messages are bounded to65,536 UTF-16 units (invalid/oversize uses fixed local copy), and duplicate
    receipts cannot replace them. A current active failure inhibits dispatch; an old-session failure
    leaves the new draft/status intact while blocking reuse of that request kind. Continue waits for
    explicit failure acknowledgement and all actual unresolved slots. Acknowledge only after the host
    has retained the real receipt and the author explicitly dismisses its presented failure; do not
    acknowledge merely on render, view closure or activation. Process-loss durability is still the
    host's responsibility. A successful work receipt derives status with other slots in view, preserving
    queued/playing speech and never reopening held capture.
7. `answer-intent` reuses run/question/character/direction/question/source/authority revisions from
   the live 037 projection. No names-as-identity, separate voice question database or scheduler.
   The host must atomically deduplicate durable answers and reject stopped/revoked/answered questions
   across activations/restarts. Session presence grants no workflow authority.
8. Present all states/questions, retained text, correction, confirmation, holds and failures in an
   accessible text/keyboard UI. Integrate actual bound Ambient/Chat/editor targets and honest W04
   settlement/persistence outcomes. `insertDictation` is only a literal pure helper; production
   insertion/replacement still needs checked editor mutation/undo. There is deliberately no unchecked
   replace-selection helper here.

## Cancellable transport ledger (T016, partial)

`transport.ts` is the pure host-neutral half of ADR 0021 item 6. It holds no audio, text, promise
or transport handle: `reduceTransport` returns `send`/`abort` effect descriptions for the trusted
host to execute once, and it never calls a provider.

- `begin` pins the exact session token and route and allocates a monotonic `operationId`. One
  operation per kind (`stt`/`tts`) may occupy its slot, including a cancelled operation whose
  dispatched chunk has not settled. A second `begin` for that kind is refused with a visible
  reason instead of silently overlapping or dropping the request.
- `chunk` allocates a monotonic `chunkId` within the operation; only one chunk may be outstanding.
  `dispatch` rechecks `TransportFacts` immediately before send: same session token, exact same
  route including revision, current audio permission and a safe clock. `mayDispatch` exposes the
  same check so the host can repeat it after every await and immediately before `fetch`. A changed
  route, revoked permission or replaced session therefore stops the next chunk locally.
- Settlement is `success | refusal | failure | cancellation`, separately from charge. A dispatched
  chunk starts `unknown`; a provider-reported finite non-negative amount becomes `reported`; a
  never-dispatched chunk is `unsent` (a local fact). A receipt keeps the exact operation snapshot,
  `reportedUsd` (known subtotal only), `unknownChunks` and `unsentChunks`. Unknown charge cannot be
  read as a fabricated zero.
- Cancellation closes the local gate immediately. Before dispatch it emits no abort and releases
  the slot at once with an `unsent` charge. After dispatch it emits a best-effort `abort` and keeps
  the owned slot until an exact settlement; a late success/failure is attributed to that request
  as `cancellation` and cannot release a newer operation's slot. Duplicate, late and foreign
  receipts change nothing. There is no automatic retry. Receipts are bounded (256); at capacity
  `begin` refuses rather than evicting attributable history, and the host keeps its durable
  accounting record separately.

`apps/desktop/src/main/voice-transport.ts` is the typed edge: it maps a provider-reported cost to
`reported`/`unknown`, maps `ProviderError`/abort to refusal, failure or cancellation with bounded
copy, and combines a host `AbortSignal` with the existing per-request deadline. `VoiceService` and
`SpeechService` accept an optional `signal`; `SpeechService` rechecks it before every chunk and
neither service retries or falls back. The desktop host now keeps a main-process registry of
cancellable speech-to-text and text-to-speech ids and exposes a best-effort local cancel through
IPC and the preload bridge. Cancellation is local: the owned slot stays until the local outcome
is recorded, an unknown charge stays unknown, and nothing here proves a provider observed the
cancel. There is still no live provider call, microphone, or device evidence. T016 remains
unchecked.

## PCM/VAD adapter and bounds

`PcmSegmenter` owns normalized mono float PCM, an injected monotonic millisecond clock and an injected
local classifier. It is **not an acoustic detector**. Only `qualified-near-end` starts an utterance;
unqualified speech/noise/echo/silence cannot create a segment. Endpoint timing uses accepted sample
counts, not a timer that would mistake a stalled capture stream for silence. Capture stalls/clock gaps
are the host's lifecycle fault to report; no fabricated silence is appended.

Defaults: 16 kHz, 1.2s end silence, 250ms preroll, 60s maximum including preroll, reads ≤100ms.
Tunable validated bounds: 8–48 kHz, 100–5,000ms silence, 0–1,000ms preroll, 1–60s utterance,
reads at most sampleRate/10; silence/preroll must be shorter than the utterance maximum.
PTT's existing ten-minute/32MB limits are untouched. Nothing here changes WAV/provider contracts.

At defaults the internal capacity is 964,000 float samples (3,856,000 bytes). Maximum configured
capacity is 2,928,000 samples (11,712,000 bytes). One emitted segment is at most 2,880,000 samples
(11,520,000 bytes); the bounded input/VAD copies add at most 38,400 bytes. Host transport encoding
and buffers are additional and require their own limits. Internal used PCM is zeroed on completion
or Stop; output ownership transfers to the caller, which must release it after transport settlement.

Process `onset` effects **before** submitting any segment returned by the same `push`. Every `push`
returns `consumed`; on a limit/end-silence boundary, preserve the unconsumed suffix and show the hold.
Held/stopped reads consume zero. Do not record an unbounded host queue while held or silently drop a
later sentence: stop intake and disclose that listening is held, retaining any already accepted suffix
within one bounded read for explicit continuation/recovery. A limit produces a labeled partial segment
and shorter-continuation instruction, not an invisibly truncated successful transcript.

One completed segment occupies the segmenter's slot until exact acknowledgement; acknowledgement
does not resume capture. The adapter resumes only when the corresponding session capture gate permits
it, and must not reuse a segmenter across unrelated scopes without the matching token. No-match/noise
interruption requires an actual author Continue. Near-end/echo accuracy, full-duplex, local recognition,
sample-rate conversion, stream gaps and actual microphone/permission behavior need separate host
qualification. Synthetic events certify none of those.

## Focused verification

```sh
bun test ./packages/core/tests/voice-session/
bunx --no-install tsc -p packages/core/tests/voice-session/tsconfig.strict.json
bunx --no-install biome lint packages/core/src/voice-session packages/core/tests/voice-session
bun test ./apps/desktop/tests/voice-permissions.test.ts
bun test ./apps/desktop/tests/voice-transport.test.ts
bun run typecheck
```

The unique strict config includes both source and tests and reuses the desktop workspace's installed
Bun types. No dependency, shared configuration, runner, schema or package export is added. Tests use
only synthetic text, PCM, clocks and unresolved promises; no real transport, microphone or device.
038 T022 and 017's host/UI/acoustic/device acceptance remain open.
