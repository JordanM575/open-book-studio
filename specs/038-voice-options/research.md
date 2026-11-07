# Research: Voice provider and speaking options

**Research date**: 2026-11-04

## Decisions

### D-192: Voice preferences and provider/model choices

**Decision**: Store transcription connection/model and speaking connection/model/voice in the desktop app profile, separate from book files and chat-model settings. Settings reads the connection list and a curated local catalog only. Opening Settings does not query a speech provider or model catalog. The author explicitly chooses a connection; missing or removed choices stop before any provider request. Do not automatically try another paid connection. Keep Meta's existing multipart transcription request, add OpenRouter's documented JSON/base64 transcription request, and use OpenRouter's documented speech endpoint for selected TTS models. Offer only locally listed, documented model IDs and exact model-specific voice IDs; do not offer arbitrary/custom voice names. Preserve provider-reported usage/cost only and otherwise return unknown.

**Rationale**: This matches the requested local preferences and the existing D-006/D-125 boundaries. It also avoids moving independent speech choices into the agent's chat-model setting, makes voice selection reproducible, and prevents a catalog/settings read from sending content or creating provider spend. OpenRouter documents both dedicated audio endpoints and a public `output_modalities` catalog filter; the model catalog's `supported_voices` field is the source for exact voice IDs.

**Alternatives considered**:

- Choose the first connected provider: rejected because connection order can silently change which provider receives author audio/text and may cause paid requests.
- Use the chat model as the speech model: rejected because chat and speech use different model identifiers, endpoints, pricing and capability metadata.
- Fetch the catalog automatically when Settings opens: rejected by D-161's no-probe rule and the requirement that Settings stay offline/local.
- Accept arbitrary voice identifiers or promise custom voices: rejected because the ID is model-specific and cannot be verified from a local catalog.
- Reuse Meta multipart for OpenRouter: rejected because OpenRouter documents a different JSON/base64 body; the current Meta payload is not OpenAI-compatible.
- Estimate voice cost from advertised model pricing: rejected because model prices can change and TTS returns an audio byte stream without a documented usage/cost response.

### Meta Muse Voice Transcribe

**Decision**: Keep the existing Meta multipart adapter and endpoint. It validates a RIFF/WAVE file with mono 16-bit PCM at 16 kHz or 24 kHz, no more than 10 minutes and 32 MB, sends an `application/json` request part plus the WAV part, and reads transcript/turn data from the buffered JSON response.

**Rationale**: The official current Meta docs specify exactly this contract. Keeping the Meta adapter separate avoids silently converting its `request`/`audio` form into another service's `file`/`model` shape.

**Alternatives considered**: No new Meta endpoint or live probe. The existing runtime and mocked tests already use the documented Meta service. Meta browser access remains unverified.

### OpenRouter transcription

**Decision**: Use `POST https://openrouter.ai/api/v1/audio/transcriptions` with `Content-Type: application/json`, a selected model and `input_audio: { data: <raw base64>, format: "wav" }`. Parse `text`, `usage.seconds` and `usage.cost` when present. Seed the local list with `openai/whisper-1`, `openai/whisper-large-v3` and `openai/whisper-large-v3-turbo`; offer no arbitrary model ID.

**Rationale**: OpenRouter's official STT guide and API reference document this body and response, and its current unauthenticated model catalog lists these three models under `output_modalities=transcription`. Base64 avoids incorrectly reusing Meta's multipart field names. The WAV is already bounded and validated before this serialization.

**Alternatives considered**: OpenRouter's documented OpenAI-style multipart `file` path is valid but is not used here, keeping one bounded in-memory request shape for this app and avoiding a 25 MB multipart-only limit. Audio URLs are rejected because they require the provider to fetch an external resource.

### OpenRouter speaking models and voices

**Decision**: Use `POST https://openrouter.ai/api/v1/audio/speech` with an explicitly selected model, voice and output format. Seed the local model/voice list from the official `supported_voices` catalog field. Include:

| Model | Verified voices | Output handling |
| --- | --- | --- |
| `heygen/heygen-voice-1` | `nadine`, `tabitha`, `bram`, `gareth`, `noelle`, `meredith`, `sabrina`, `lucian`, `weston`, `vincent` | PCM, mono 16-bit, 44.1 kHz; wrap joined samples once in a WAV header |
| `heygen/heygen-voice-1-turbo` | Same 10 documented voice IDs | PCM, mono 16-bit, 44.1 kHz; wrap joined samples once in a WAV header |
| `mistralai/voxtral-mini-tts-2603` | `en_paul_sad`, `en_paul_neutral`, `en_paul_happy`, `en_paul_frustrated`, `en_paul_cheerful`, `gb_oliver_sad`, `gb_oliver_confident`, `gb_jane_sarcasm`, `gb_jane_sad`, `gb_jane_frustrated`, `fr_marie_sad`, `fr_marie_excited`, `fr_marie_curious`, `fr_marie_angry` | MP3; join MP3 frames as existing pipeline does |

Retain the existing direct OpenAI TTS route and its existing model/voice families. A change to the speaking model resets the saved voice to the first documented voice for that model; a connection change selects that provider's local default model/voice. Both are user-triggered settings changes, never a provider request. TTS cost remains `null` because the documented endpoint returns raw audio bytes and no usage/cost body.

**Rationale**: OpenRouter's official model catalog returned the exact IDs above with `output_modalities=speech` and per-model `supported_voices` on 2026-11-04. Its TTS guide says HeyGen Voice is PCM-only and 44.1 kHz, while Mistral Voxtral Mini TTS is MP3-only. The 4,000-character application chunk bound remains below each selected provider's documented/request-supported limit.

**Alternatives considered**:

- Keep only `fish-audio/s2.1-pro-free:free`: rejected because the current catalog has no `supported_voices` for that model, so it cannot fulfill a verified speaking-voice choice and its promotion/availability can change.
- Offer every current speech model: rejected because models with no verified voice list or uncertain output/sample-rate behavior should not be presented as supported.
- Include the free HeyGen Turbo variant: deferred because its official page describes a time-limited free offer through 2026-11-30; avoid making a transient promotional model a shipped default.
- Offer custom names such as “Neville”: rejected because no verified OpenRouter or Meta voice ID was found.

## Sources

- OpenRouter, [Speech-to-Text guide](https://openrouter.ai/docs/guides/overview/multimodal/stt), read 2026-11-04. Dedicated endpoint, base64 JSON body, transcription response/usage and model discovery.
- OpenRouter, [Create transcription API reference](https://openrouter.ai/docs/api/api-reference/stt/create-transcription), read 2026-11-04. Request fields and response contract.
- OpenRouter, [Text-to-Speech guide](https://openrouter.ai/docs/guides/overview/multimodal/tts), read 2026-11-04. Dedicated speech endpoint, model-specific voices, output formats, HeyGen PCM and model discovery.
- OpenRouter, [Create speech API reference](https://openrouter.ai/docs/api/api-reference/tts/create-speech), read 2026-11-04. Request and raw-audio response contract.
- OpenRouter public unauthenticated catalog, [`/api/v1/models?output_modalities=transcription`](https://openrouter.ai/api/v1/models?output_modalities=transcription), queried 2026-11-04. Three selected Whisper models.
- OpenRouter public unauthenticated catalog, [`/api/v1/models?output_modalities=speech`](https://openrouter.ai/api/v1/models?output_modalities=speech), queried 2026-11-04. Selected TTS model IDs, exact `supported_voices`, endpoint and pricing metadata. Catalogue prices are not treated as request usage.
- OpenRouter, [HeyGen Voice model page](https://openrouter.ai/heygen/heygen-voice-1), read 2026-11-04. Ten built-in presets and PCM behavior.
- Meta Model API, [Speech-to-text documentation](https://dev.meta.ai/docs/speech-to-text/), read 2026-11-04. Supported WAV shape, endpoint and size/duration bounds.
- Meta Model API, [Transcribe API reference](https://dev.meta.ai/docs/api-reference/voice/transcribe), read 2026-11-04. Multipart request and buffered response.
- Current runtime: `packages/core/src/providers/speech.ts`, `packages/core/src/providers/tts.ts`, `apps/desktop/src/main/voice.ts`, `apps/desktop/src/main/speech.ts`, and `specs/017-voice-and-background`.

## Research limitations

- No live provider inference, test key, microphone, keychain or user profile was used. The only network requests were public, unauthenticated documentation/catalog reads.
- The OpenRouter catalog is mutable. The app ships a local curated snapshot; it does not promise live availability or check on Settings open.
- OpenRouter TTS does not document a usage/cost response. Its cost is therefore unknown even when the public model catalog advertises a rate.
- Context7's documentation service could not be used because the environment reported its quota exceeded; official provider documentation and the unauthenticated official catalog were used instead.
