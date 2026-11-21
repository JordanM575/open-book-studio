# Voice

Open Book Studio has two separate voice paths: dictation sends an author-triggered recording for
transcription, while speaking turns visible text into audio. Their provider choices are independent
of the writing agent's chat model. Persistent desktop choices shipped in
[PR #26](https://github.com/JordanM575/open-book-studio/pull/26) on November 7, 2026
(spec 038, D-192, ADR 0015).

## Dictation

In desktop Settings → **Voice → Dictation**, choose a connected Meta or OpenRouter account and a
supported transcription model. Meta offers Muse Voice Transcribe. OpenRouter's local catalog lists
Whisper 1, Whisper Large v3 and Whisper Large v3 Turbo. The saved connection and model are used only
when the author starts dictation; an empty or removed selection stops before audio is sent, rather
than selecting another account. If the saved connection or model has changed by submission, the
recording is refused and the author can record again with the current choice.

Before a request, the desktop app checks the recording is a complete RIFF/WAVE file containing mono,
16-bit PCM at 16 kHz or 24 kHz, no longer than ten minutes or larger than 32 MB. Meta receives its
documented multipart `request` and WAV parts. OpenRouter receives its documented JSON/base64 WAV
request. Audio stays in memory and is discarded after the request; it is not saved to a book, profile
or temporary file. The transcript follows the existing author-triggered insertion flow.

Every voice request is minted by the main process before it can touch the network, and the button
that started it stays a Stop control while it runs. The renderer can ask the host to cancel; it
cannot cancel anything else, and it cannot see the route, the credential or the internal ids.
Cancellation before a request is sent stops it without a charge. Cancellation after a request was
sent asks the host to stop it locally; the provider may still have received it, and whether it cost
anything stays unknown. A late reply is recorded against the request but never delivered to the
editor or played aloud. Cancelling a recording before it becomes a request simply discards it.

## Read-aloud and spoken agent replies

In Settings → **Voice → Read-aloud and agent replies**, choose a connected speaking account, model and
one of that model's listed voices. OpenAI's existing `gpt-4o-mini-tts`, `tts-1` and `tts-1-hd` models
remain available with model-specific local voice lists. `gpt-4o-mini-tts` offers `alloy`, `ash`,
`ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer` and `verse`; `tts-1` and
`tts-1-hd` use that list without `ballad` and `verse`. `marin` and `cedar` are not enabled pending
a separate catalog decision. These describe the checked-in catalog, not a fresh live-provider probe.
The curated OpenRouter catalog offers:

| Model | Voices | Audio returned |
| --- | --- | --- |
| `heygen/heygen-voice-1` | `nadine`, `tabitha`, `bram`, `gareth`, `noelle`, `meredith`, `sabrina`, `lucian`, `weston`, `vincent` | Raw mono 16-bit PCM at 44.1 kHz |
| `heygen/heygen-voice-1-turbo` | The same ten voices | Raw mono 16-bit PCM at 44.1 kHz |
| `mistralai/voxtral-mini-tts-2603` | `en_paul_sad`, `en_paul_neutral`, `en_paul_happy`, `en_paul_frustrated`, `en_paul_cheerful`, `gb_oliver_sad`, `gb_oliver_confident`, `gb_jane_sarcasm`, `gb_jane_sad`, `gb_jane_frustrated`, `fr_marie_sad`, `fr_marie_excited`, `fr_marie_curious`, `fr_marie_angry` | MP3 |

Only the exact model/voice pairs in the local catalog are offered. Choosing a speaking connection
selects its first listed model and voice; changing the model selects that model's first listed voice.
These are local defaults, not provider probes. The models and voices are a curated snapshot, not a
promise of current provider availability.

Text longer than one request is split at sentence boundaries where possible and sent in order. The
audio is joined into one playable result. Raw PCM chunks are joined first and receive one WAV header
at the model's sample rate. TTS endpoints return audio bytes without request usage or cost, so TTS
cost remains unknown; transcription usage and cost are retained only when the selected provider
actually supplies them.

The selected speaking provider is used for both read-aloud and spoken agent replies. A missing
selection may use the computer's local speech synthesis, which is separate from a provider voice. A
saved selection that has become unavailable, a provider refusal, or a playback failure does **not**
silently switch to another provider or voice. The safe error is shown and the words remain visible.

## Stop controls and what a request costs

While a dictation or a spoken reply is in flight, its button reads **Stop**. Stop asks the desktop
host to cancel the request; it does not call anything else and it does not promise the provider
stopped. Before anything was sent, the receipt says no request was sent and there is no provider
charge. After a request was sent, the receipt keeps the unknown honest: either no amount was
reported, a reported subtotal for the parts that reported one, or an exact amount the provider
reported. An unknown charge is never shown as `$0.00`, and a reported zero is shown as
`Provider-reported cost: $0.00.` because the provider said so. A request that was split into parts
reports what was sent, what was not, and which parts remain uncharged. Stopping during playback
stops playback only; the settled receipt stays. TTS endpoints that report no usage keep reporting an
unknown cost; nothing is estimated and no cap is implied.

## Local preferences and browser behavior

Voice preferences are stored in the desktop app's local `studio.json` profile, not in book files,
manuscripts, archives or chat-model settings. Settings reads the local connection list and curated
catalog only: opening it sends no audio or prose and does not test a voice provider. Adding or testing
a provider connection remains a separate, explicit action.

Provider voice controls and operations are desktop-only. The browser build explains that provider
voice integration is unavailable and refuses those operations; its existing device speech synthesis
is separate and does not imply browser access to provider credentials.

## Verification

- `bun test packages/core/tests/speech.test.ts packages/core/tests/tts.test.ts` — catalogs, request
  contracts, WAV validation and audio handling.
- `bun test packages/core/tests/voice-session/` — pure ledger contracts, including refusal and charge projection.
- `bun test apps/desktop/tests/voice-service.test.ts apps/desktop/tests/speech.test.ts apps/desktop/tests/voice-transport.test.ts apps/desktop/tests/voice-request.test.ts apps/desktop/tests/voice-cancel-registry.test.ts apps/desktop/tests/voice-cancel-ipc.test.ts apps/desktop/tests/voice-settings.test.tsx` — selected providers, safe failures, preference controls and no provider probes from Settings.
- `bun test apps/desktop/tests/dictation-hook.test.ts apps/desktop/tests/ambient-panel.test.ts apps/desktop/tests/voice-receipt.test.ts apps/desktop/tests/voice-cancel-journey.test.tsx` — the renderer stop, receipt line and cancellation journeys.
- `bun run typecheck`, `bun run verify` and `bun run smoke` — repository checks and hidden desktop
  profile/preload round-trip.

No live provider, provider key, microphone or user profile is needed for these automated checks.

The [November 7 integrated baseline](TESTING.md#recorded-baseline) records passing automated checks.
[038 T022](../specs/038-voice-options/tasks.md) remains unchecked at the author's direction: it is
the final automated-verification record, not a newly added live-provider task. Live availability,
microphone permissions and audible playback need their own evidence; the merge does not establish them.
