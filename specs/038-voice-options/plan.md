# Implementation Plan: Voice provider and speaking options

**Branch**: `038-voice-options` | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/038-voice-options/spec.md`

## Summary

Add profile-local transcription and speaking preferences to the existing desktop voice path. The main process reads and validates the selected connection, model and voice; the renderer receives only safe connection summaries and model choices. Meta keeps its documented multipart contract. OpenRouter transcription uses the documented JSON/base64 contract and TTS keeps its documented audio-speech route with model-specific voice IDs and audio format/sample-rate handling. Preferences write atomically to `studio.json`; voice requests remain explicit, in-memory and outside the book format. A local curated catalog avoids Settings-open provider calls.

## Technical Context

**Language/Version**: TypeScript 7, Electron 45, React 19

**Primary Dependencies**: Existing Electron, React, Zod 4, `ai` runtime and local UI primitives; no new dependencies

**Storage**: Existing Electron user profile (`studio.json`) for preferences only; no library or manuscript changes

**Testing**: Bun unit and component tests, TypeScript checks, `bun run verify`, hidden `bun run smoke`

**Target Platform**: Desktop voice operations; browser build keeps explicit refusing stubs and device-speech behavior only

**Project Type**: Electron desktop application with shared renderer and core provider adapters

**Performance Goals**: Settings uses local profile and connection data only; no catalog or provider request on open

**Constraints**: Main-process-only provider calls; Zod-validated IPC; WAV validation before spend; 32 MB and 10-minute limits; audio held only in memory; no automatic paid-provider selection/fallback; no new dependency; no changes to author files

**Scale/Scope**: One preferences object per app profile, 3 OpenRouter transcription models, 3 curated OpenRouter TTS models with verified model-specific voice lists, existing OpenAI TTS models, and Meta transcription

## Constitution Check

- **Author files remain the product**: PASS. Preferences live in the disposable local app profile; the library, manuscript and archive formats do not change.
- **One checked writer and atomic writes**: PASS. Only the main process updates SettingsStore through `writeFileAtomic`; failed writes do not replace the in-memory value.
- **Local-first and explicit provider requests**: PASS. Settings reads local state and configured capability only. Audio or text leaves the machine only after the author triggers dictation, read-aloud, or a spoken reply.
- **Honest interface**: PASS. Model/voice options come from a documented local catalog, not a claimed live inventory. Unknown usage/cost stays unknown; errors are redacted.
- **Design system and accessibility**: PASS. Use existing NativeSelect, Button, text, spacing and color tokens; retain transcript/reply text and keyboard labels.
- **Tests at boundaries**: PASS. Add catalog/service, profile persistence, IPC and happy-dom settings-flow tests; run typecheck, verify and hidden smoke.

**Gate result**: No constitution violations; no library-format decision is required. D-109 remains open outside this desktop-only scope.

## Project Structure

### Documentation (this feature)

```text
specs/038-voice-options/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/voice-profile-and-provider.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code

```text
packages/core/src/providers/speech.ts         Meta/OpenRouter STT contracts and validated local model catalog
packages/core/src/providers/tts.ts            Provider/model-specific TTS choices, voices and audio format
packages/core/src/ipc.ts                      Voice preference and operation contracts
apps/desktop/src/main/settings.ts             Profile-local preference persistence
apps/desktop/src/main/voice.ts                 Explicitly selected transcription service
apps/desktop/src/main/speech.ts                Explicitly selected speaking service
apps/desktop/src/main/ipc.ts                  Zod validation, connection/model matching and redacted IPC
apps/desktop/src/preload/index.ts             Narrow preference and voice-operation bridge
packages/app/src/components/SettingsDialog.tsx Voice preference controls using existing UI primitives
packages/app/src/hooks/use-dictation.ts        Existing author-triggered flow, now bound to profile choice
packages/app/src/hooks/use-speech.ts           Read-aloud and agent replies use current profile choice
apps/web/src/runtime/browser-api.ts            Explicit unsupported-provider-operation behavior
apps/desktop/tests/                             Service, settings, IPC and hidden-smoke coverage
packages/core/tests/                            Speech/TTS catalog and request-shape coverage
apps/desktop/tests/voice-settings.test.tsx       Happy-dom Settings and speaking-choice coverage
```

**Structure Decision**: Extend the existing core speech/TTS capability modules, the desktop main-process services/IPC and the shared Settings dialog. Keep provider secrets in `ProviderService`, profile preferences in `SettingsStore`, and speech audio in memory. No second writer, persistence layer, new package or browser adapter is introduced.

## Complexity Tracking

No constitution violations or extra architectural layers are introduced.
