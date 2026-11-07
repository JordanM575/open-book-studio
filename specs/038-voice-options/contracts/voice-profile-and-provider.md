# Voice profile and provider contract

## Renderer-to-main preferences

The preload exposes only typed voice operations:

- `voice.settings()` reads the safe current profile preferences.
- `voice.updateSettings(preferences)` saves the complete preference object atomically after main-process shape and catalog validation. New or changed selections must match a current connection and its provider's catalog; an unchanged selection whose connection, model or voice is unavailable may remain while the author repairs the other. Saves are serialized so an overlapping update cannot reintroduce a cleared unavailable selection. Loading a structurally valid saved choice does not require it still to be in the catalog.
- `voice.connections()` returns only safe connection summaries capable of transcription.
- `voice.speakers()` reports the selected speaking connection, model, selected voice and that model's allowed voice IDs. It does not test the connection or expose its endpoint.
- `voice.transcribe({ audio, expectedSelection })` accepts an `ArrayBuffer` and the complete connection/model captured before recording. The main process validates the payload and refuses if that choice no longer matches the saved profile. Otherwise it takes a snapshot and uses only that connection/model even if preferences change while the request is resolving.
- `voice.speak({ text })` accepts text only; the main process uses the saved speaking connection/model/voice.

Secrets, base URLs, provider response bodies and API clients never cross the bridge. A `null` preference is valid and does not select a provider.

## Provider requests

### Meta transcription

- `POST {Meta base URL}/asr/transcribe`
- Bearer authorization; `multipart/form-data` with JSON `request` and `audio/wav` parts.
- WAV is RIFF/WAVE, mono, 16-bit PCM, 16 kHz or 24 kHz, at most 10 minutes and 32 MB.
- Parse the documented `transcript`, `turns` and optional `audioDurationMs` response.

### OpenRouter transcription

- `POST https://openrouter.ai/api/v1/audio/transcriptions`
- Bearer authorization and `Content-Type: application/json`.
- Body: `{ "model": "<selected local STT model>", "input_audio": { "data": "<base64 WAV bytes>", "format": "wav" } }`.
- Parse the required `text` and optional `usage.seconds`/`usage.cost`; no cost is synthesized.

### OpenRouter speech

- `POST https://openrouter.ai/api/v1/audio/speech`
- Bearer authorization and JSON containing selected `model`, chunk `input`, exact selected `voice`, and explicit model-compatible `response_format`.
- MP3 chunks are joined as before; an explicitly incompatible media type is refused. HeyGen PCM chunks are accepted only as compatible `audio/pcm`, including any rate/channel parameters, and complete 16-bit samples. They are joined as raw little-endian samples, then wrapped once as mono 16-bit WAV at the documented 44.1 kHz sample rate. Contradictory, unknown or unsupported format metadata is refused rather than relabeled.
- The response body is audio bytes. No request-cost estimate or voice fallback is returned.

## Error and refusal contract

- Invalid WAV, stale connection, changed transcription choice, model/provider mismatch or unsupported voice fails before provider fetch.
- Cancelling before the transcription call prevents it; cancelling after a provider request has started ignores its eventual result but cannot recall audio already sent.
- Provider errors use the existing `ProviderError` mapping and safe `redact()` result envelope.
- The web runtime keeps explicit refusal stubs for provider voice operations; this contract adds no browser provider request or microphone capability.
