# Voice

AI Book Studio has two separate voice paths: dictation sends an author-triggered recording for
transcription, while speaking turns visible text into audio. Their provider choices are independent
of the writing agent's chat model.

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
Cancelling before the transcription call prevents sending; cancelling after a request has started
ignores its result but cannot recall audio already sent.

## Read-aloud and spoken agent replies

In Settings → **Voice → Read-aloud and agent replies**, choose a connected speaking account, model and
one of that model's listed voices. OpenAI's existing `gpt-4o-mini-tts`, `tts-1` and `tts-1-hd` models
remain available with their documented voice family. The curated OpenRouter catalog offers:

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
- `bun test apps/desktop/tests/voice-service.test.ts apps/desktop/tests/speech.test.ts apps/desktop/tests/voice-settings.test.tsx` — selected providers, safe failures, preference controls and no provider probes from Settings.
- `bun run typecheck`, `bun run verify` and `bun run smoke` — repository checks and hidden desktop
  profile/preload round-trip.

No live provider, provider key, microphone or user profile is needed for these automated checks.
