# Feature Specification: Voice provider and speaking options

**Feature Branch**: `038-voice-options`

**Created**: 2026-11-04

**Status**: In progress — isolated implementation candidate; integration and verification pending

**Input**: User description: "Add OpenRouter speech-to-text and text-to-speech, offer Meta for transcription, and let authors choose the voice used by the agent. Persist choices in the local profile; preserve the existing audio safety rules and do not change the book format."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Choose a dictation service (Priority: P1)

An author opens Voice settings, chooses a connected Meta or OpenRouter connection and one of its supported transcription models, then records dictation. The selected service and model receive that recording and the transcript is inserted or sent through the existing author-triggered flow.

**Why this priority**: Dictation is the existing voice pipeline's main input path; supporting OpenRouter alongside Meta gives authors an actual provider choice.

**Independent Test**: With mocked connections and requests, select each provider/model in settings, trigger dictation, and verify only that connection and model are used and the resulting text follows the existing editor/agent flow.

**Acceptance Scenarios**:

1. **Given** connected Meta and OpenRouter accounts, **When** the author selects either connection and one of its listed models, **Then** the selected service and model are saved and used by the next author-triggered transcription.
2. **Given** no transcription connection is selected, **When** the author requests dictation, **Then** the app explains how to choose a connection and sends no audio.
3. **Given** a saved connection has been removed, **When** the author requests dictation, **Then** the app reports that the connection is unavailable and sends no audio to another provider.
4. **Given** the selected transcription connection or model changes while a recording is in progress, **When** it is submitted and the saved choice no longer matches the choice at recording start, **Then** the app refuses the recording and asks the author to record again; it sends no audio to the new choice.

---

### User Story 2 - Choose a speaking service and voice (Priority: P1)

An author chooses a connected speaking service, model, and voice. Read-aloud and spoken agent replies use that saved selection, while the reply remains visible as text.

**Why this priority**: A selectable speaking voice is useful only when the read-aloud and agent reply paths actually use it.

**Independent Test**: Change the speaking connection, model, and voice in settings; trigger read-aloud and a mocked spoken agent reply; verify both requests contain the selected connection, model, and valid model-specific voice.

**Acceptance Scenarios**:

1. **Given** a connected OpenRouter account and a supported speech model, **When** the author chooses a listed voice, **Then** read-aloud and spoken agent replies use that exact model and voice.
2. **Given** the author changes the speaking model, **When** the model has a different voice list, **Then** settings offer only voices documented for the newly selected model.
3. **Given** a selected speaking connection is unavailable or refuses a request, **When** the author requests speech, **Then** the app reports the problem and does not send the text to a different paid connection; the on-screen words remain available.

---

### User Story 3 - Keep voice preferences local and understandable (Priority: P2)

An author closes and reopens the app and finds the same transcription and speaking choices. Settings shows configured capability without testing a provider or sending author content.

**Why this priority**: Preferences should be durable, machine-local and safe, without introducing manuscript-format changes or surprise network activity.

**Independent Test**: Save choices in a temporary profile, reload settings, and verify exact round-trip; open Settings with network spies and verify no provider request occurs.

**Acceptance Scenarios**:

1. **Given** saved voice choices, **When** the app restarts, **Then** settings and subsequent voice requests use those same choices.
2. **Given** Settings is opened, **When** the author has not explicitly started dictation, read-aloud, or a catalog refresh, **Then** no provider is contacted and no audio or prose is sent.
3. **Given** a service reports actual usage or cost, **When** the result is returned, **Then** the reported value is preserved; if no value is reported, the app leaves it unknown rather than estimating it.
4. **Given** the browser build cannot perform the selected provider operation, **When** voice controls or operations are reached, **Then** the build refuses clearly and does not claim desktop provider integration.
5. **Given** both saved voice connections, models or voices are unavailable, **When** the author clears or replaces one selection, **Then** the other remains unchanged and can be repaired separately; neither unavailable selection sends a request or silently switches to device speech.

### Edge Cases

- A stored connection ID no longer exists or now resolves to a provider that does not support the saved model.
- A voice ID is not part of the selected model's documented local catalog.
- A saved settings file has missing, malformed or unsupported voice preference values.
- A provider returns a refusal, rate limit, malformed response, empty audio or a network error containing sensitive material.
- The recording is empty, truncated, non-WAV, stereo, non-PCM, outside the accepted sample rates, over 10 minutes or over 32 MB.
- The provider returns raw PCM at a model-specific sample rate rather than a compressed audio file.
- A profile has no voice selection; no paid connection is chosen automatically.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Authors MUST be able to choose a connected transcription connection and supported model from Meta or OpenRouter.
- **FR-002**: A user-triggered dictation MUST use only the saved transcription connection and model captured before recording; an absent or removed selection or a changed selection at submission MUST stop before sending audio.
- **FR-003**: Authors MUST be able to choose a connected speaking connection, model, and a voice supported by that exact model.
- **FR-004**: Read-aloud and spoken agent replies MUST use the saved speaking connection, model, and voice; a selected connection failure MUST NOT trigger a request to a different paid connection.
- **FR-005**: Voice preferences MUST persist in the local app profile, be validated in the main process, and be written atomically; they MUST NOT be stored in a book or manuscript file.
- **FR-006**: Settings MUST NOT contact speech providers when opened. Any catalog refresh, if provided, MUST be initiated explicitly by the author.
- **FR-007**: Dictation MUST remain author-triggered, validate WAV audio before sending, keep audio in memory only, and discard it after the request; failures MUST not create audio files or alter manuscript content.
- **FR-008**: Provider failures MUST be safe to show and MUST not include API keys or raw secret-bearing error details.
- **FR-009**: Usage and cost MUST remain unknown unless the selected provider returns an actual value; the app MUST NOT estimate or substitute a catalogue price.
- **FR-010**: Unsupported browser voice operations MUST refuse clearly; this feature MUST NOT claim browser provider support.
- **FR-011**: The feature MUST NOT change library or manuscript formats, add a dependency, automatically contact providers, or silently choose another paid connection.

### Key Entities *(include if feature involves data)*

- **Voice preferences**: Machine-local choices for the transcription connection/model and speaking connection/model/voice.
- **Voice model choice**: A locally listed provider model and, for speaking, only that model's verified voice identifiers.
- **Voice request result**: The requested operation's text or audio metadata, including reported usage/cost only when the provider supplies it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Mocked tests show that every transcription request uses the exact saved provider and model, and stale or absent selections make zero provider requests.
- **SC-002**: Mocked tests show that read-aloud and spoken agent replies use the exact saved speaking provider, model and valid voice.
- **SC-003**: A voice preference survives profile reload exactly, and a failed atomic settings write leaves both the previous file and in-memory value unchanged.
- **SC-004**: Settings-open tests observe zero speech-provider requests; malformed or rejected audio creates zero disk files and does not change manuscript bytes.
- **SC-005**: Provider-error tests prove credentials and raw secret-bearing error bodies do not appear in returned messages, and missing usage/cost remains unknown.

## Assumptions

- Voice preferences are app-profile preferences shared across books on one machine, not book content and not synchronized with a library.
- Existing protected provider connections are reused; this feature does not collect keys or introduce a new account flow.
- The local model list contains only documented model IDs and exact model-specific voice IDs. Catalog refresh is not required for this release; Settings can remain network-free.
- Meta Muse Voice Transcribe remains available for transcription. OpenRouter uses the documented `/audio/transcriptions` JSON/base64 contract and `/audio/speech` TTS contract.
- The current WAV checks, 32 MB and ten-minute bounds, in-memory-only audio lifecycle, and text-visible accessibility path remain in force.
- Desktop is the supported host for provider voice operations. Existing browser refusals remain explicit and no web access is inferred from the OpenRouter desktop connection.
- The broader questions in D-109 (system voices across platforms, browser speech quality, and other premium TTS services) remain outside this feature.
