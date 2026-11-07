# Quickstart: Voice provider and speaking options

## Prerequisites

- Bun workspace dependencies and the Electron binary are already installed.
- Use only mocked provider connections and fetch responses. Do not use a live provider, key, keychain, microphone, notification or foreground app.

## Focused checks

In the original forward-port, do **not** run the repository-wide `bun run verify` below: its lint and test discovery could traverse the protected root `json` entry. A separate disposable-checkout run passed with a one-path test-output redirection; its snapshot, evidence and limitations are recorded in `tasks.md`. T022 remains open while that qualified gate and the earlier smoke evidence are reconciled.

```bash
bun test packages/core/tests/speech.test.ts packages/core/tests/tts.test.ts
bun test apps/desktop/tests/voice-service.test.ts apps/desktop/tests/speech.test.ts apps/desktop/tests/settings-store.test.ts apps/desktop/tests/ipc-handlers.test.ts
bun test apps/desktop/tests/voice-settings.test.tsx
bun run typecheck
bun run verify
bun run smoke
```

## Expected scenarios

1. A temporary profile stores and reloads selected transcription and speaking preferences exactly.
2. A mocked Meta request remains multipart; a mocked OpenRouter transcription request contains raw WAV base64 and the selected model in JSON.
3. OpenRouter TTS uses the saved model and exact voice. PCM results are wrapped with a 44-byte RIFF header whose sample rate is 44.1 kHz; MP3 results remain joined MP3 bytes.
4. Missing/removed connections, invalid model/voice pairs, malformed WAV and provider errors produce no unintended network call, no retained audio file and no key in errors.
5. Settings is exercised through its visible connection/model/voice selects; changing and reloading choices uses mocks only.
6. The hidden smoke run starts its throwaway profile and confirms the Settings/voice choice route without contacting a real provider.

No test in this guide enables live-provider checks or adjusts baselines, skips or gates.
