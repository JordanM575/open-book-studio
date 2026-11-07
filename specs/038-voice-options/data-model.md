# Data model: Voice preferences

## App profile

The existing desktop `studio.json` may contain one optional, strict `voicePreferences` object:

```text
voicePreferences
├── transcription
│   ├── connectionId: connection ID | null
│   └── model: saved model ID | null
└── speaking
    ├── connectionId: connection ID | null
    ├── model: saved model ID | null
    └── voice: saved voice ID | null
```

All fields are present when a preference object is saved. `null` means no selection. An absent object in an older profile means no voice preference. This is disposable machine-local profile state; it is never copied into a library, book, chapter, archive, thread or agent chat-model configuration.

## Validation

- Connection IDs follow the shared `conn_…` grammar. A new or changed non-null selection must resolve to a currently connected summary. An unchanged saved selection that has become unavailable or mismatched may remain while the author repairs the other selection; it cannot be introduced or edited in that state.
- A new or changed transcription model ID must occur in the local catalog for the selected connection's provider. Meta has one fixed Muse model; OpenRouter has the three research-recorded Whisper models.
- A new or changed speaking model ID must occur in the local catalog for the selected provider. Speaking voice IDs must match that exact model's local voice list.
- A `null` connection requires its dependent model and voice to be `null`; a non-null connection requires a non-null model and, for speaking, a non-null voice.
- Loading checks the complete structural shape, not current catalog membership: a saved model or voice retired since the last run stays visible and unavailable rather than erasing either preference or enabling device speech. Store updates compare each choice against the latest serialized state; changed choices must be in a local catalog, and IPC additionally checks the chosen connection's provider.
- Reads from a malformed profile drop only the invalid preference object and leave all unrelated profile settings intact.
- Voice request handlers re-resolve the saved connection and revalidate its provider/model/voice before any network call. A removed connection produces a safe, actionable error and no provider request.

## State transitions

1. Initial/legacy profile: all choices are unset; no paid provider is auto-selected.
2. Author selects a connection: Settings chooses that provider's local default model and first documented voice where applicable, then persists the preference.
3. Author changes model: Settings replaces the voice with a voice from the newly selected model and persists both together.
4. Author clears connection: dependent model and voice are cleared in the same atomic preference update.
5. Connection removed outside the preference update: the saved ID remains visible as unavailable; operations stop before sending; the author explicitly chooses another connection or clears it.
6. Both connections removed or models/voices retired: each choice can be cleared or replaced separately, without silently modifying the other; overlapping saves cannot reintroduce an already-cleared unavailable selection.

## Request result usage

- Meta transcript: provider duration when present, otherwise validated WAV duration; no reported cost means unknown.
- OpenRouter transcript: provider `usage.seconds` and `usage.cost` when present; missing values remain `null`/unknown.
- TTS: the model, voice and connection are returned; documented raw-audio responses do not include cost/usage, so cost remains unknown. No catalogue-price estimate is made.
