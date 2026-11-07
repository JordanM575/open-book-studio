# ADR 0015: Explicit voice provider and model choices

- **Status:** Accepted (2026-11-04, on the author's direction)
- **Decision record:** [D-192](../DECISIONS.md#d-192--voice-provider-model-and-voice-choices)
- **Spec:** [038 — Voice provider and speaking options](../../specs/038-voice-options/spec.md)

## Context

The desktop studio already records author-triggered WAV dictation and can read text aloud. Before
this decision, it selected the first capable connection at request time, offered a single
OpenRouter speech model, and let a speaking failure fall back to the computer's voice. Those
defaults made the destination depend on connection order and could hide that a selected service had
failed. Transcription and speaking also use separate provider catalogs and request formats.

## Decision

Store the transcription connection/model and speaking connection/model/voice in the desktop app's
local `studio.json` profile. Do not put these preferences in book files or agent chat-model settings.
Opening Settings reads local connections and a curated local catalog only; it never contacts a voice
provider. The author explicitly chooses a connection, and a missing or removed choice stops before
any provider request. No operation automatically selects or retries another paid connection.

Keep Meta's documented multipart WAV transcription adapter. Add OpenRouter transcription through its
documented JSON/base64 WAV contract. Use OpenRouter's speech endpoint for the curated models whose
voice IDs and output formats are documented, while retaining the direct OpenAI TTS adapter. Validate
the saved provider/model/voice combination in the main process before each request. Preserve only
provider-reported usage; cost remains unknown when the response does not report it.

Audio remains in memory only. Validate the existing mono, 16-bit PCM WAV bounds before transcription.
On TTS failure, surface the safe error and keep the reply text visible; do not switch to another paid
provider or silently change the requested voice. When no speaking provider is selected, the existing
device speech remains an explicitly local option. The browser build refuses provider voice settings
and operations, while its device speech remains separate.

## Consequences

- Voice choices survive app restarts but are not synced or archived with the manuscript.
- A connection change chooses a documented local default model and voice as part of that explicit
  settings change; changing model resets the voice to one supported by that model.
- Provider outages and removed connections are visible and terminal for that request. Retrying is an
  explicit author action after changing or restoring the selected connection.
- Model/voice availability is the curated snapshot documented by the feature research, not a promise
  of current provider availability. Settings remains network-free.
- TTS price is never inferred from catalog pricing. Raw PCM is joined first, then wrapped once as a
  WAV at the selected model's documented sample rate.

## Rejected alternatives

- Select the first capable connection: connection ordering could change where author audio or text is
  sent, including to a paid provider.
- Reuse the agent's chat model: speech uses different model identifiers, endpoints, voices and
  request/response contracts.
- Fetch live catalogs on Settings open: that adds network activity without author intent and makes
  settings availability depend on provider uptime.
- Accept arbitrary voice names or custom voices: their support is model-specific and cannot be
  verified from a curated local catalog.
- Estimate cost from published model pricing: a catalog rate is not a per-request usage report.
- Fall back to another provider or another voice after a selected service fails: this hides failure
  and can disclose text to another paid destination.
