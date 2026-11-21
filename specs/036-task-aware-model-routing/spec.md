# Feature Specification: Task-aware model routing

**Scope amendment, November 7:** D-196/D-116 / ADR 0019 selects pinned, explicitly chosen workflow
role routes and finite admission under a 037 grant. FR-016/017/019 and the no-dispatch/non-persistence
clauses remain binding for this offline preview. Workflow execution/attribution is a distinct path;
no automatic model replacement, ranking, fallback or ambiguous retry is selected. The preview leaf
still needs its production mount; policy acceptance is not runtime evidence.

**Decision record, November 20:** under the 2026-11-07 delivery authority, the four Phase-0 decisions
are accepted as D-204–D-207. The initial taxonomy is three author-selected profiles, each requiring
tools and a known catalogue context (D-204); candidates stay unranked with no single suggestion (D-205);
there is no local request-size estimator or total cost (D-206); and only a two-step handoff to the
existing one-turn picker is allowed, with no persistence (D-207). T015, T017 and the new-total portions
of T008/T018 are deliberately not selected; T016 remains unchecked and unblocked only for the narrow
author-chosen-candidate handoff. T019 stays separately gated, and the preview still has no production
mount. These decisions do not add a mount, provider call, route store or estimator.

**Feature Branch**: `036-task-aware-model-routing`  
**Status**: In progress — offline preview leaf exists; D-204–D-207 accepted; T015/T017 and the new-total portion of T018 deliberately not selected, T016 narrow handoff unchecked; production mount and selected workflow routing remain open.
**Depends on**: [011](../011-model-access/spec.md) provider access and model selection; [022](../022-provider-compatibility/spec.md) provider compatibility and Contributor consent; [002](../002-studio-v1/spec.md) writing-agent behavior.

## Overview

Authors should be able to understand which connected models appear suitable for a writing task without
studying provider catalogues or trusting an unexplained “best model” label. This feature proposes a
task-aware, author-visible preview over the model facts the studio already has.

The first deliverable is deliberately advisory and local: the author chooses a writing-task profile,
then sees applicable catalogue facts, unknowns, and any candidate limitations. Opening or closing the
preview does not refresh a provider catalogue, inspect manuscript text, change the book default or
one-turn override, save a route decision, or send a request. The author remains in control of the
existing model picker and existing Send action.

Choosing a profile confirms only which task the author wants to inspect. It is not consent to send
content, select a model, or run a turn.

This is not permission to dispatch automatically. Ranked recommendations, direct application of a
suggestion, route persistence, automatic routing, fallback, retries, spending ceilings, and any new
provider path require their own accepted public decisions before dependent work starts.

## Current public behavior and boundaries

- Spec 011 already defines the provider registry and model catalogue, per-book default, one-turn model
  override, actual provider/model/connection attribution for a turn, capability handling, and usage
  reporting. This feature MUST preserve those behaviors rather than define a second selection system.
- Spec 022 already defines the shared provider compatibility seam and the book-level Contributor
  training-consent guard. Contributor consent is not general permission to route manuscript content,
  train a model, or conduct a review; this feature MUST NOT set, broaden, infer, or transfer that consent.
- D-116 now selects two cost modes under ADR 0019; enforcement remains open. Existing warnings are informational,
  not enforceable ceilings. A missing or unknown price remains unknown and MUST NOT be treated as zero.
- The writing agent and its editing tools are defined in spec 002. Import, illustration, voice, export,
  and any future review journeys remain separate; this spec does not route those jobs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Preview models for a writing task (Priority: P1)

An author opens a task preview, chooses a task profile explicitly, and sees which connected catalogue
entries have the known capabilities relevant to that profile. The preview explains unknown or missing
facts rather than guessing.

**Why this priority**: The author can compare available options before making the existing manual
selection, without a new provider request or a hidden change to the book.

**Independent Test**: With a synthetic cached catalogue and fixture connections, open the preview for
each supported profile. Assert that the displayed facts and exclusions match the fixture, no network or
credential access occurs, and selection state and fixture chapter contents are unchanged.

**Acceptance Scenarios**:

1. **Given** a supported profile and a cached catalogue, **When** the author opens its preview,
   **Then** the studio shows the catalogue timestamp, known context and capability facts, price basis,
   and any limitations for each candidate.
2. **Given** a required catalogue fact is missing or unknown, **When** candidates are evaluated,
   **Then** the preview labels the fact unknown and does not claim that the model is eligible for a
   requirement that depends on it.
3. **Given** the author has not chosen a task profile, **When** the preview opens, **Then** the studio
   asks the author to choose one and does not infer it from chat text, manuscript content, or history.
4. **Given** the author closes the preview, **When** they return to the book, **Then** the book default,
   one-turn override, conversation, and manuscript are unchanged.

### User Story 2 — Understand a suggestion without handing over control (Priority: P1)

An author can inspect a candidate suggestion, its evidence, and its unknowns, then decide whether to
continue using the existing model-selection flow. A suggestion is advice, not a dispatch instruction.

**Why this priority**: A model recommendation is useful only when the author can see why it was made
and retain control of the model that will receive a request.

**Independent Test**: Use synthetic catalogue fixtures with zero, one, and multiple eligible models.
Assert that the preview reports no candidate, a candidate, or an unranked set as appropriate; it never
changes the current selection or starts a turn.

**Acceptance Scenarios**:

1. **Given** no accepted public ranking policy, **When** multiple candidates satisfy known hard
   requirements, **Then** the preview presents them as candidates, not as a scored or “best” model.
2. **Given** a public ranking policy is later accepted, **When** it yields a suggestion, **Then** the
   preview shows the policy-relevant evidence and unknowns, labels the result as a suggestion, and
   requires a separate author action in the existing model picker before any selection changes.
3. **Given** the author opens the existing model picker from the preview, **When** the picker appears,
   **Then** the existing book-default and one-turn-override rules apply; the preview does not preselect,
   save, or dispatch the suggested model.
4. **Given** no model meets known requirements, **When** the preview is shown, **Then** it says no
   suitable candidate is known and gives the reasons; it does not choose a random model or prevent the
   author from using the existing manual flow subject to spec 011's checks.

### User Story 3 — See honest cost and context information (Priority: P1)

An author can compare the catalogue's context limit, capability facts, and price information without
mistaking a catalogue estimate for a guaranteed bill or a context-fit check.

**Why this priority**: Routing advice must not create a false impression of free use, guaranteed
affordability, or a prompt that will fit.

**Independent Test**: Use synthetic catalogue and token-estimate fixtures covering known, partial, and
unknown prices and context. Assert the exact labels and that unknown values never become zero or a
positive fit claim.

**Acceptance Scenarios**:

1. **Given** a known catalogue price and a documented token estimate, **When** a total is displayed,
   **Then** it is labelled an estimate and its inputs are inspectable.
2. **Given** a missing input or output price, **When** cost is displayed, **Then** that cost is unknown,
   not `$0.00`, and no cheaper-than-known claim is made.
3. **Given** a model has a published context limit but the preview has no reliable estimate of the
   actual request size, **When** context is shown, **Then** the limit is shown as catalogue data and
   context fit is labelled unknown.
4. **Given** an existing cost-helper warning is shown, **When** the author reads it, **Then** it is
   clearly informational and is not described as a spending limit or a guarantee that a request will
   stay below a price.

### User Story 4 — Keep the preview private and recover safely (Priority: P1)

An author can open, cancel, or encounter an unavailable preview without exposing manuscript text,
changing model selection, losing work, or triggering an extra provider call.

**Why this priority**: The preview must not expand what leaves the author's device or disturb the
existing safe writing path.

**Independent Test**: Use an isolated synthetic library and a provider-call spy. Open, change profile,
cancel, simulate absent/stale/corrupt catalogue data, and close the preview. Assert zero new calls,
zero writes, and unchanged fixture selection and chapter contents.

**Acceptance Scenarios**:

1. **Given** the preview is opened or a profile is changed, **When** the candidate list is computed,
   **Then** it uses the existing local catalogue and does not contact a provider, refresh a catalogue,
   read manuscript content, or send a prompt.
2. **Given** the catalogue is stale, **When** the preview opens, **Then** its timestamp and stale
   status are visible; any refresh remains a separate, explicitly labelled existing action.
3. **Given** the catalogue is absent, unreadable, or invalid, **When** the preview cannot compute,
   **Then** it explains that no preview is available, suggests the existing catalogue-refresh path if
   appropriate, and leaves the book and current selection untouched.
4. **Given** the author cancels or the preview closes unexpectedly, **When** the feature exits,
   **Then** there is no queued request, retry, fallback, saved preference, or partial selection change.

## Requirements *(mandatory)*

### Task profiles and candidate preview

- **FR-001**: The feature MUST offer only author-selected task profiles for writing-agent work already
  described in spec 002. It MUST NOT classify a task by reading prompts, manuscript text, tool output,
  or conversation history.
- **FR-002**: Task profiles MUST be data with a display name, plain-language purpose, and explicit
  capability/context requirements. D-204 records the initial names, scope, and evidence source; no
  unapproved taxonomy may be presented as settled policy.
- **FR-003**: Candidate evaluation MUST consume the existing spec 011 provider registry, catalogue,
  connection availability, and capability facts. It MUST NOT create another provider registry or
  override provider-reported facts.
- **FR-004**: A missing or unknown required capability MUST remain unknown and MUST NOT qualify a model
  as suitable for a requirement that depends on that capability. The preview MUST show the reason.
- **FR-005**: A model's displayed context limit MUST be identified as catalogue data. The preview MUST
  not claim that the current request fits unless a separately accepted and tested estimator provides
  the actual request-size basis.
- **FR-006**: Until a public ranking policy is accepted, the preview MUST show compatible candidates
  without a single “best” claim, quality score, speed claim, or price-based rank. Model names and
  marketing tiers are not evidence of quality.
- **FR-007**: If a later accepted policy produces a suggestion, the studio MUST show its rationale,
  evidence source, and relevant unknowns. The suggestion MUST remain advisory and MUST NOT be applied
  without a separate author action in the existing model-selection flow.
- **FR-008**: If no candidate is known to satisfy the profile, the preview MUST show “no suitable
  candidate known” with rejection reasons. It MUST NOT substitute a random model or silently weaken a
  requirement.

### Cost, catalogue freshness, and eligibility

- **FR-009**: Price data MUST come from the existing catalogue and retain its provenance. Missing or
  unknown input/output prices MUST remain unknown and MUST NOT be interpreted as zero or free.
- **FR-010**: A total price estimate MAY be shown only when both the price basis and a documented token
  estimate are available. It MUST be labelled an estimate and MUST identify its basis. D-206 deliberately
  does not select a total for this preview; this clause governs only a future separately accepted estimate.
- **FR-011**: Under accepted D-116, this offline preview MUST NOT implement or
  claim an enforceable per-turn/session ceiling, reject a turn based on an estimated amount, or describe
  an informational cost-helper warning as a ceiling.
- **FR-012**: Opening the preview MUST use only the catalogue data already available under spec 011.
  It MUST NOT trigger a catalogue refresh or any additional provider call. A separately initiated
  existing refresh MUST remain visibly separate from the preview.
- **FR-013**: A stale catalogue MUST be labelled with its age/timestamp when available. An absent or
  invalid catalogue MUST produce an unavailable preview rather than guessed values or a network retry.
- **FR-014**: Provider/build availability and capability restrictions from specs 011 and 010 remain in
  force. This preview MUST NOT make a provider available in a build where it is currently unavailable.

### Selection, dispatch, and privacy boundaries

- **FR-015**: Opening, changing task profile, closing, or cancelling the
  preview MUST NOT change the book default, the current one-turn override, the active connection, or
  the selected model.
- **FR-016**: The preview MUST NOT dispatch a model request, create an agent turn, or call a provider.
  Actual dispatch remains behind the existing author-requested flow in spec 011.
- **FR-017**: This feature MUST NOT add automatic model routing, fallback, cross-provider retry,
  background work, a credential path, or a proxy. Each requires explicit accepted public decisions
  before its dependent implementation.
- **FR-018**: The preview MUST NOT read or send manuscript text, prompt text, Story Bible content,
  conversation history, credentials, or tool results to compute a task profile or recommendation.
- **FR-019**: The preview MUST NOT persist a task choice or route decision in the book, library,
  conversation, or usage log. A future persistent decision record requires a separate public decision
  and must not contain prompts, manuscript text, credentials, or hidden reasoning.
- **FR-020**: Existing actual-turn attribution from spec 011 remains authoritative for what ran. A
  previewed or suggested model MUST never be presented as the model actually used.
- **FR-021**: If a suggested candidate has the Contributor training property, the preview MUST use the
  existing spec 022 warning and book-scoped consent rules. Previewing or accepting a suggestion MUST
  NOT grant or alter consent.
- **FR-022**: Cancellation, preview errors, stale data, and no-route results MUST leave manuscript data,
  conversation history, usage records, and current model selection unchanged. The author MUST be able
  to return to the existing manual selection flow.

## Success Criteria *(mandatory)*

- **SC-001**: In synthetic-fixture tests, opening or changing a task preview creates zero provider
  requests, catalogue refreshes, credential reads, library writes, and agent turns.
- **SC-002**: In all tested catalogue fixtures, missing capability, context, and price fields are shown
  as unknown; no unknown price is shown as zero or free.
- **SC-003**: In 100% of open, cancel, error, and close scenarios, the book default, one-turn override,
  active connection, manuscript, and existing conversation remain unchanged.
- **SC-004**: Before a public ranking decision is accepted, 100% of multi-candidate previews show an
  unranked candidate list and no quality, speed, or “best model” claim.
- **SC-005**: No previewed model is recorded as used; any completed turn continues to show the actual
  provider, model, and connection under spec 011.
- **SC-006**: No preview or suggestion bypasses spec 011's provider availability/capability rules or
  spec 022's Contributor consent guard.

## Public decision status

These decisions constrain the feature. The four Phase-0 decisions were accepted on 2026-11-20 under
the 2026-11-07 delivery authority; dependent implementation remains separate.

1. **Task taxonomy and profile evidence — accepted (D-204).** Three author-selected version-1 profiles:
   Discuss the book, Draft new prose and Revise existing prose. Each requires tool support and a known
   catalogue context; none has a quality tier, numeric context minimum, output-size target or
   provider/model tier. Final profile data, the known-context requirement and profile-specific tests
   remain follow-up work.
2. **Suggestion and ranking policy — accepted as no ranking (D-205).** Zero, one or many known
   capability matches appear in stable catalogue order with statuses, reasons and a visible
   not-a-ranking note. No score, quality/speed/price order or single suggestion is shown. T015 is
   deliberately not selected; a later ranking needs a new decision naming its evidence and
   deterministic rule.
3. **Context and estimate basis — accepted as no estimator or total (D-206).** Catalogue context limits
   and unit prices are shown with provenance; actual request fit stays unknown; missing prices stay
   unknown and a published zero stays a known zero. No total, range, ceiling or rejection is shown, and
   the preview says the request size is unknown. The new total-estimate portion of T008 and the
   total-estimate scope of T018 are deliberately not selected.
4. **Suggestion confirmation and persistence — accepted as a two-step handoff only (D-207).** An explicit
   action on an author-chosen candidate opens the existing one-turn picker; author confirmation is
   required; only the existing one-turn override is set. No book default, consent, send or persistence
   change. T017 is deliberately not selected; T016 remains unchecked and unblocked only for this narrow
   handoff.
5. **D-116 cost enforcement**: Accepted ADR 0019 distinguishes finite operation mode (not a money
   cap) from qualified strict money with conservative durable reservations and provider-enforceable
   all-charge limits. Unknown/unresolved charges block strict mode. Implementation and adapter
   qualification remain; current informational warnings/catalog estimates are not ceilings.
6. **Dispatch and recovery policy — T019 separately gated**: Whether future task routing may dispatch
   directly, automatically switch models, retry, or fall back, and how stop, partial writes, uncertain
   charges, and provider failures are handled. D-196 selects explicitly pinned workflow-role dispatch,
   zero automatic retries and no fallback under the separate 037 grant. Ordinary preview authority stays
   unchanged, and T019 still requires its own implementation plan.

**Acceptance conditions.** Every writing-agent profile must require a known catalogue context, so the
preview never marks a model eligible that `canRunAgent` would refuse (D-204). A future production mount
must use catalogues already loaded by an explicit picker or refresh action, or a read-only cached-summary
seam; calling `ProviderService.models()` when the preview opens would fetch on a cache miss and violate
FR-012 and SC-001. Neither condition is implemented here.

## Assumptions

- The provider catalogue, current connection availability, model capabilities, actual-turn attribution,
  and one-turn override from spec 011 remain the source of truth.
- The initial preview is available only for the existing writing-agent journey. Other workflows retain
  their own model selection and cost disclosures.
- The preview may show catalogue facts without claiming that those facts prove model quality or fit for
  the current prompt.
- Existing author-requested provider behavior remains as documented by spec 011; this feature adds no
  provider calls beyond that disclosed behavior.
- All acceptance tests use synthetic, isolated fixtures. Live-provider calls, paid services, real
  manuscripts, and real credentials are outside this specification's verification scope.

## Non-Goals

- Automatic model selection, dispatch, fallback, retry, or background routing.
- Changing or replacing spec 011's book default, one-turn override, provider registry, credential
  storage, connection UI, or actual-turn attribution.
- Adding providers, credentials, sign-in, a hosted service, a proxy, or another network path.
- Enforcing a spending ceiling or guaranteeing the actual cost of a request.
- Inferring task intent from manuscript or prompt content, or claiming quality from model names.
- Routing illustration, voice, import, export, or future review/reader journeys.
- Changing Contributor consent or treating that consent as general training, review, or routing
  permission.
