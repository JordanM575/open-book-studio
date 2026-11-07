---
description: "Task list for voice provider and speaking options"
---

# Tasks: Voice provider and speaking options

**Input**: Design documents from `/specs/038-voice-options/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`

**Tests**: Required at provider, persistence, IPC, UI and hidden-smoke boundaries by SC-001–SC-005.

**Organization**: Work is ordered by dependency and grouped by the user stories in `spec.md`.

## Phase 1: Shared contracts and catalogs

- [x] T001 [P] Add local STT model catalog, OpenRouter JSON/base64 request builder and safe response parser in `packages/core/src/providers/speech.ts`.
- [x] T002 [P] Add per-model TTS model/voice/format/sample-rate catalog and request options in `packages/core/src/providers/tts.ts`.
- [x] T003 Define typed voice preferences and voice-settings overview in `packages/core/src/ipc.ts`.
- [x] T004 Add core tests for the STT/TTS catalogs, supported voice boundaries, request shapes and raw-PCM handling in `packages/core/tests/speech.test.ts` and `packages/core/tests/tts.test.ts`.

## Phase 2: Foundational profile and IPC boundary

- [x] T005 Add strict voice-preference validation and profile loading in `apps/desktop/src/main/settings.ts`; malformed preferences must not discard unrelated settings.
- [x] T006 Make `SettingsStore.update()` assign memory only after its atomic profile write succeeds; cover round-trip, malformed preferences and failed writes in `apps/desktop/tests/settings-store.test.ts`.
- [x] T007 Add voice settings read/update IPC, strict payload schemas, current-connection/catalog validation and preload types in `packages/core/src/ipc.ts`, `apps/desktop/src/main/ipc.ts` and `apps/desktop/src/preload/index.ts`.
- [x] T008 Add IPC boundary tests proving unknown connections, mismatched models and voices are rejected without persisting in `apps/desktop/tests/ipc-handlers.test.ts`.

## Phase 3: User Story 1 — Choose a dictation service (Priority: P1)

**Goal**: The author explicitly chooses Meta or OpenRouter and its supported transcription model; dictation uses only that saved choice.

**Independent Test**: Mock requests for both providers; verify selected model, stale/empty selection refusal and no fetch for invalid WAV.

- [x] T009 [P] [US1] Extend `VoiceService` to require the saved connection/model, retain Meta multipart, and implement OpenRouter JSON/base64 STT in `apps/desktop/src/main/voice.ts`.
- [x] T010 [P] [US1] Test exact Meta/OpenRouter request selection, usage parsing, safe failures, no automatic provider selection and no request for stale selection in `apps/desktop/tests/voice-service.test.ts`.
- [x] T011 [US1] Connect `VoiceService` to `SettingsStore` and make dictation consume saved preferences only in `apps/desktop/src/main/index.ts` and `packages/app/src/hooks/use-dictation.ts`.
- [x] T012 [US1] Add accessible transcription connection/model controls and explicit clear/unavailable states in `packages/app/src/components/SettingsDialog.tsx`.

## Phase 4: User Story 2 — Choose a speaking service and voice (Priority: P1)

**Goal**: Read-aloud and spoken agent replies use the explicitly saved speaking connection, model and model-specific voice.

**Independent Test**: Mock supported providers/models and assert read-aloud and replies send the saved selection; failures do not dispatch another provider.

- [x] T013 [P] [US2] Extend `SpeechService` to resolve and validate saved speaking preferences, model-specific format and voice, and join PCM before wrapping in WAV in `apps/desktop/src/main/speech.ts`.
- [x] T014 [P] [US2] Test OpenAI/OpenRouter models, exact voices/formats, PCM joining, unknown cost, stale choices and provider failures in `apps/desktop/tests/speech.test.ts`.
- [x] T015 [US2] Return safe selected-speaking status from IPC and connect `SpeechService` to `SettingsStore` in `apps/desktop/src/main/ipc.ts` and `apps/desktop/src/main/index.ts`.
- [x] T016 [US2] Add speaking connection/model/voice controls and model-change voice reset in `packages/app/src/components/SettingsDialog.tsx`.
- [x] T017 [US2] Use the saved speaking preference for read-aloud/replies, retaining visible text and refusing provider failures without another-provider or voice fallback; local device speech remains available only when no provider is selected in `packages/app/src/hooks/use-speech.ts` and `packages/app/src/components/AmbientPanel.tsx`.

## Phase 5: User Story 3 — Keep voice preferences local and understandable (Priority: P2)

**Goal**: Profile choices survive restart, Settings reads no speech provider, and browser operations refuse clearly.

**Independent Test**: Reload a temporary profile, assert no speech network calls when Settings opens, and exercise browser refusals.

- [x] T018 [P] [US3] Add Settings UI tests for preferences, catalog-only choices, empty/stale connections, model voice changes and zero provider calls in `apps/desktop/tests/voice-settings.test.tsx`.
- [x] T019 [P] [US3] Update browser voice settings and operation stubs to return explicit unsupported messages in `apps/web/src/runtime/browser-api.ts`.
- [x] T020 [US3] Extend hidden smoke checks for the voice-settings preload contract, unset defaults and local preference round-trip in `apps/desktop/src/main/smoke.ts`.
- [x] T021 [US3] Update `docs/VOICE.md`, `docs/DECISIONS.md`, `docs/adr/0015-voice-provider-options.md`, `specs/README.md` and the Unreleased section of `CHANGELOG.md`.
- [ ] T022 Run focused tests, `bun run typecheck`, `bun run verify` and `bun run smoke` for this forward-port; record any environment limits here.

**Still open**: T022 is the final verification record for this task list: focused tests, typecheck, full `verify` and `bun run smoke`, with any environment limits written here. It is left unticked. The pull request description lists the results of those commands on its head, and the author decides when this task is recorded as done.

## Dependencies and order

- T001–T004 establish the shared catalog/contracts before profile validation and service use.
- T005–T008 establish safe durable state and the IPC boundary before either user story connects.
- US1 and US2 both depend on T001–T008; their service tests can be developed independently, then integrated through Settings and IPC.
- US3 integration, documentation and full verification depend on both provider paths and the shared Settings surface.
