# Plan: guided and autonomous authoring

**Spec:** [spec.md](spec.md) · **Tasks:** [tasks.md](tasks.md)

## Shape

> **2026-11-20 pointer (T001 reconciliation):** the merged reader-review path did not follow this
> section's seam sketch. The accepted implementation is the standalone transport in
> `apps/desktop/src/main/review/transport.ts` (a single `generateText` call, `tools: {}`,
> `maxRetries: 0`) behind the `readerReview:request` channel — not a foreground turn in
> `apps/desktop/src/main/agent/runtime.ts`, which contains no review path. That mounted review is
> owned by 039; 037's `guided-review` envelope kind has no producer or consumer anywhere, and Phase 1
> (T003–T011) remains unbuilt. This section is retained as the unbuilt foreground-journey plan, not
> as a description of merged code. Reconciling it wholesale is 037's own decision, not T001's;
> until then, do not read it as the shape of the shipped reader review.

Deliver Phase 1 as a foreground mode of the existing agent, not as a second agent runtime or report
engine. Reuse the configured provider/model path, the studio-owned tool catalog and the open Library.
Under D-193 / ADR 0018, reuse the lifecycle, not ordinary full-book prompt/history assembly. A
snapshot-backed facade provides the same read-tool names over only explicitly selected sources.
Keep the review turn read-only at both tool selection and execution boundaries. The only initial
network activity is the provider request the author explicitly starts after seeing its destination and
source scope.

The likely implementation seams are:

- `packages/app` for the author-facing review entry point, scope disclosure, citations, stale state,
  stop and retry behavior.
- `packages/core/src/agent/` and the existing agent tool catalog for the review-turn contract and
  read-only allowlist. The allowlist must respect 024 tiers and 025 per-book tool controls.
- `apps/desktop/src/main/agent/runtime.ts` and existing provider/model services for the foreground
  request. Provider credentials stay in main; renderer requests continue through the validated
  preload/IPC boundary.
- Shared library read results for source revision capture and comparison. Use the existing version
  discipline internally; render author-readable citations rather than internal identifiers.
- Synthetic core, component and mocked-runtime tests for data scope, tool refusal, stale sources,
  cancellation and failure. No real provider or manuscript is needed for these contracts.

Confirm exact module names and ownership during implementation. New review parts stay in the
existing conversation file, with a separately reviewed versioned-reader/checked-write/recoverable-delete
contract before persistence. No parallel store, backend or plugin execution path is introduced.

## Request and safety flow

1. The author chooses the passage/chapter and any additional sources. The interface identifies the
   configured provider and model and discloses what source content will be sent.
2. The provider-named review action starts one foreground turn. The request uses the selected
   connection/model and existing provider consent and capability checks; there is no silent fallback.
3. The runtime exposes only enabled built-in tools with the `read` tier. Tool execution independently
   rejects writes, destructive tools, plugins and reads outside the approved scope.
4. Each source read returns its revision with the source. The answer carries citations tied to that
   snapshot. Before the answer is treated as current, compare the current source revision; changed or
   unavailable sources produce a visible stale/unavailable state and an explicit rerun option.
5. Stop, provider failure or a read failure leaves files unchanged and the request retryable. Existing
   thread persistence is reused; no review report or candidate file is introduced.

U-037-01/02 are resolved by D-193 / ADR 0018. First build pure envelope serialization, bounded
source-facade and exact citation verification. Shared thread safety/versioning and W03's runtime
interaction changes must be integrated before durable foreground review. No implicit history replay
or prompt-equality reuse may change the recorded source/consent identity.

## Boundaries and dependencies

- 002 remains the manuscript, turn, provider-disclosure and untrusted-data contract.
- 011 remains the provider/model/consent authority. A review cannot weaken its gates or change the
  selected connection.
- 024 remains the single catalog and tool-tier source. No parallel set of review tools is introduced.
- 025 plugin loading remains unchanged; plugins are excluded from Phase 1 review turns even when
  configured for ordinary agent work.
- D-126 remains a one-background-turn opt-in. Phase 1 adds no background switch and changes no
  notification, window-close or quit behavior.
- Spec 034's deterministic structured report remains separate. No score, report schema or export is
  added here.

## Accepted full-book implementation

D-194–D-196 / ADR 0019 and the constitution/AGENTS amendment select the distinct workflow contract.
`packages/core/src/authoring/` owns pure graph/state/permission-descriptor/admission/context contracts;
it has no SDK/filesystem imports or ambient credentials. The desktop coordinator pins the current
Library and consumes IDs/events. The existing runtime remains the SDK boundary. Workflow storage
and publication compose into the existing book queue and checked writer. Workflow record schema 1
and its pure raw codec now precede workflow writers; shared thread/host-permission schemas, checked
storage, real streaming and independent review remain. Host-local permission is outside portable book
files.

Order: checked threads/settlement → pure graph/admission/artifacts → scoped attempt driver and real
async scheduler → small onboarding/goal/outline/cast → incremental scene pipeline/checked adoption →
independent reviews/revisions → versioned character questions/branch steering → lifecycle/restart →
whole-book coverage/final handoff → separately named synthetic/quality/usability/platform gates.
T017–T042 make each step explicit. Manual 030/033, standalone 034/039 and ordinary 031 continue to
use their own contracts. Shared Library/API/preload/Workspace/runtime files each have one owner.

Pure reducers and injected editor/voice interfaces can run concurrently with storage integration.
Only actual host integration and exact-candidate tests qualify execution; unmounted leaves remain
partial evidence. The complete synthetic journey must generate through the real pipeline into
verified saved text, including independent overlapping transports, revisions, questions and restart.

## Verification approach

### W10 pure-core implementation slice (2026-11-07)

New leaf modules under `packages/core/src/review/` implement D-193 envelope capture/validation,
serialization, exact saved-body citations and snapshot-only read tools. API details, trust boundaries
and integration prerequisites are in
[`SCOPED-CONTRACTS.md`](../../packages/core/src/review/SCOPED-CONTRACTS.md).
Focused synthetic tests are `scoped-sources.test.ts`, `scoped-envelope.test.ts` and
`scoped-readers.test.ts` under `packages/core/tests/review/`. This is **pure core only**: T003–T011
remain unchecked because runtime/provider/IPC/conversation/UI integration and acceptance have not
run. Existing `review/index.ts` (034), runtime, ThreadStore and global seams are not part of this slice.

- Use synthetic isolated books and mocked library/provider boundaries only.
- Assert that the provider-bound payload matches the visible, author-selected scope; a pre-send cancel
  makes no request.
- Assert that only enabled built-in read tools are registered and callable, and that prompt-injection
  text in manuscript/tool output cannot widen scope or enable a write.
- Exercise source changes, missing sources, provider refusal, tool failure and stop; fixture files must
  remain byte-identical and the request must remain retryable.
- Resolve every displayed citation against its captured source revision. Do not claim semantic review
  quality from citation-resolution tests; U-037-06 defines the evidence required for future autonomy.
- Do not run live-provider, real-manuscript, credential, paid-service or device checks under this spec.
