# Pure authoring contracts

Internal, platform-independent leaves for 037 T021/T022/T025 and the T018 workflow wire codec,
selected by D-194–D-196/D-116 and ADR 0019. Import the local `index.ts`; no global package export is
exposed. The in-memory contracts are **not a scheduler, execution grant or wholesale persisted
`run.json`**. `wire.ts` reads and writes the schema-1 workflow records specified in `docs/FORMAT.md`;
the host-permission descriptor has its own pure codec. Shared thread migration, writers and independent review stay separate.
No dependency imports, provider, filesystem, credential, clock reader, timer, callback or host writer
exists in the implementation. All IDs, digests, clocks, receipts and host facts are supplied explicitly.

## API and invariants

| Module | Surface | Meaning |
| --- | --- | --- |
| `contracts.ts` | `Owner`, `Reference<K>`, `Graph`, `TaskDefinition`, `validateGraph`, `prepareBrief` | Readonly owner/kind/id/revision/hash references; supported version, duplicate/missing/foreign/stale dependency and DAG checks. Input descriptors are copied, not trusted as permissions. The exact brief and existing 033 goal survive; no word counter. |
| `contracts.ts` | `CheckinCadencePolicy`, `DEFAULT_CHECKIN_CADENCE_POLICY`, `CHECKIN_CADENCE_LIMITS`, `validateCheckinCadencePolicy`, `CheckinCadenceProgress`, `validateCheckinCadenceProgress`, `evaluateCheckinCadence` | Versioned check-in cadence (ADR 0019): editable adopted-chapter/saved-word intervals, first-chapter and irreversible-choice triggers, bounded validation, and a pure due evaluation over caller-counted progress. Counts nothing and reads no prose. |
| `contracts.ts` | `readCheckinWordTarget` | Copies an existing 033 goal id and its positive saved `targetWords`. Refuses a null target, any schema other than 1, a different book, and campaign `selectedUtf16` / `selectedUtf8` fields at any depth. Does not count prose or invent a goal id. |
| `contracts.ts` | `refuseCampaignStageRole` | Refuses campaign stage kinds `range` and `synthesis` as authoring roles (`campaign-stage-not-a-role`). Any other value, including a role name, refuses as `unknown-stage-kind`. Does not create a task or change `ROLES`. |
| `graph.ts` | `createRun`, `reduceRun`, `taskStatuses`, `runStatus`, `publicationEligible` | Checked command/revision/generation transitions, deterministic graph-order projection, questions/direction, preserved historical attempts, explicit author finish. Publication eligibility is only a necessary graph condition. |
| `lifecycle.ts` | `advanceAttempt`, `advanceEffect` | Prepared, intent, receiving, output-kept and completed are separate. Publication intent and actual receipt are separate. Recovery never turns possible sends/writes into known-free failure or a replay. |
| `admission.ts` | `createLedger`, `reserve`, `observeReservation`, `accountingSummary` | Finite reservations, actual receipts, pinned routes, per-attempt continuations/read limits, revision/no-progress checks and known/unknown/partial accounting. |
| `admission.ts` | `advanceAdmissionGeneration`, `parkConnection`, `continueConnection` | Preserve budgets across pause/recovery generations. Old reservations cannot dispatch. Auth/quota parks; 429 records eligibility only. Explicit Continue removes a park, never creates a request. |
| `value.ts` | `copyValue`, `AuthoringError` | Plain acyclic value admission without getters/toJSON, exact escaped JSON-size accounting, well-formed Unicode, depth 64, and checked arithmetic. This is not a wire encoder/parser. |
| `wire.ts` | `decodeWorkflowRecord`, `encodeWorkflowRecord`, `canonicalWorkflowJson`, `WORKFLOW_LIMITS` | Raw schema-1 UTF-8 JSON admission and deterministic canonical encoding for the FORMAT workflow records. Refuses invalid UTF-8/BOM, duplicate keys at any depth, lossy numeric lexemes, unsupported versions, foreign owner/kind/prefix, stale bases/links, depth and per-kind size/count overflow before returning a semantic record. Preserves supported unknown plain fields; no I/O, crypto, clock or host action. |
| `wire.ts` | `projectQuestionInbox` | Pure projection of an already listed question array, or an object whose `questions` array is used, into open questions only. Copies the id, `state: "open"`, and an explicit `irreversibleChoice` boolean; omission is absence, not false. Refuses a partial page, duplicates, foreign kind/owner, an unknown state, a non-boolean classification, and more than 10,000 inputs before inspection. No prose, store, answer, schedule, or cadence. |
| `wire.ts` | `checkVersionedAnswer` | Pure check of one already decoded open question, the revision the author named, one proposed answer, and the direction epoch that answer would create. Silence is not an answer. Exact and confirmed text stay separate. The direction origin is `answer`, its text is the confirmed text, and its question link names this open revision. No write, run step, stored answer, schedule, or cadence. |
| `wire.ts` | `projectAnsweredQuestion` | Pure next question revision after that check. The check runs first. Copies the question, sets revision plus one, a sha256 base of the caller-supplied previous digest at the open revision, state `answered`, and an answer of the checked texts, the proposed direction reference, and the caller-supplied timestamp. Does not hash, write, create a direction, schedule, or resume cadence. |
| `wire.ts` | `projectInvalidatedTasks` | Pure next task revisions for one direction's impact. An incomplete impact or a shared key matches, and then so does a dependent. Copies each affected task, sets revision plus one, a sha256 base of the caller-supplied digest at the old revision, the supplied direction reference, `retryAllowed: true`, and the caller timestamp. Drops a cached `status`. Does not hash, write, mark an attempt historical, schedule, or resume cadence. |
| `adoption-receipt.ts` | `AdoptionReceipt`, `validateAdoptionReceipt`, `countAdoptedChapters`, `ADOPTION_RECEIPT_LIMITS` | Versioned recorded adoption receipt (FR-017) and the pure adopted-chapter counter for T032 cadence. Binds one exact `artifact` candidate, `chapterId`, `resultVersion`/`resultHash`, `owner`, `grant`/`direction` references and caller-supplied `sequence`/`adoptedAt`; counts distinct chapters since an exclusive marker. No prose, clock or adoption decision. |
| `host-permission.ts` | `decodeHostPermission`, `encodeHostPermission`, `readHostPermission` | Closed schema-1 host-permission descriptor. Validates owner, host, policy digest, generation, expiry, revocation and resume. A copied descriptor is not execution permission. No storage, clock, or host resume. |

Factories and reducers defensively copy before returning recursively frozen snapshots. They never
freeze or mutate caller objects, prior snapshots, commands or receipts. Inputs and supported unknown
plain fields are preserved. Validation failures throw `AuthoringError` with a stable code and return
no changed snapshot. A same-ID command must have both the same supplied payload digest and the same
complete structural payload (including expected revision/generation). Exact replay returns the
**current** snapshot, never historical state or renewed execution permission. A reservation ID also
deduplicates its entire request, including after release. Snapshots must come from these factories/
reducers; casting deserialized or worker values to `RunSnapshot`/`AdmissionLedger` is unsupported.

External records retain depth64 admission before validation. Internal snapshot copying separately
allows the maximum three structural wrappers (`reservations[].request`); aggregate depth is at most67.
Graph/policy records add one wrapper, commands two, and reservation requests three. Extracted graph/
command references and receipt/clock projections fit within the same allowance. Repeated transitions
replace that aggregate rather than nest it again. This internal copier is not exported from the leaf
index and never admits external records or new wire formats; unknown extension values are preserved.
Explicit connection Continue copies its supplied clock before reading or comparing any property.

Plain values allow finite fractional numbers within the safe-number magnitude; all semantic revisions,
generations, bounds, times and micro-USD are separately required to be nonnegative safe integers.
Negative zero, nonfinite/unsafe numbers, lone surrogates, classes, functions, symbols, getters,
nonenumerable fields, extended/sparse arrays and cycles refuse. Shared acyclic subobjects are copied
independently. The raw reader in `wire.ts` detects duplicate JSON keys, lossy numeric **lexemes**,
invalid UTF-8 and unsupported wire versions *before* constructing values; those facts cannot be
recovered from an already parsed object. It also refuses a BOM, a lone surrogate escape, depth/size
overflow, foreign owner/kind/prefix and stale base/direction links. There is no claim to sandbox
executable JavaScript/proxies.

## Direction, completion and settlement

- Each task declares complete host-verified impact keys (source/entity keys) and exact dependency
  references. A question or direction change invalidates intersecting tasks and transitive dependants.
  Incomplete impact metadata is always affected. A worker cannot assert independence to remove edges.
- Questions remain unanswered until an explicit current-question/revision answer. Exact and confirmed
  answer text are retained separately. Direction revisions advance by one with a fresh immutable ID.
  Only affected tasks take the new direction. Proven-independent work retains its captured direction.
- Invalidated attempts keep original inputs, direction and outputs. Late output may be retained and
  settled but cannot become current. Already-started effects settle with real observations; an old
  confirmed receipt stays historical. No base or direction tokens are silently refreshed.
- Pause/cancel/revoke increments the generation and closes unfinished graph gates synchronously in
  the returned snapshot. Caller must close its real host gate **before** any awaited work, even when
  persistence or integer overflow prevents recording this transition. Pure state cannot cancel I/O.
- Live attempts/effects keep the run settling. Recovery marks possible sends/publications uncertain,
  and prepared-without-intent work known unsent. Explicit Continue may allow proven-independent work
  after recovery while uncertain branches and their dependants stay blocked. Still-live work prevents
  resume. Verified completed dependencies survive repeated pause/recovery; cancellation/revocation
  cannot be resumed. Final-review-ready requires every task completed and no open question; author
  finish is a separate command, not a literary-quality assertion.
  - A `candidate` task completes at validated output; an `adoption` task needs an actual confirmed effect
  receipt before dependants become ready. Review quality, actual output retention, exact target/base,
  first-keystroke draft protection, host grant, source scope, safety and actual write verification all
  remain host responsibilities. `publicationEligible` certifies none of them.

## Check-in cadence

ADR 0019's cadence is a versioned policy (`version: 1`) in `contracts.ts`. The named default
`DEFAULT_CHECKIN_CADENCE_POLICY` is a check-in after the first adopted chapter, then every three
more adopted chapters or 10,000 more saved words (whichever occurs first), plus major irreversible
character/ending choices. Authors may edit the intervals and toggle the two triggers;
`validateCheckinCadencePolicy` copies the input, refuses any other version (`unsupported-version`),
and bounds `adoptedChapterInterval` to 1–1,024 and `savedWordInterval` to 1–1,000,000 via
`CHECKIN_CADENCE_LIMITS` and the shared `integer` vocabulary (`invalid-integer`,
`invalid-cadence-policy`). Nothing is coerced or defaulted silently on read: string numbers,
fractions, `-0`, unsafe numbers and non-boolean triggers refuse, as values do throughout this module.

`evaluateCheckinCadence(policy, progress)` is pure: the caller supplies counted
`adoptedChaptersSinceCheckin` and `savedWordsSinceCheckin` (nonnegative safe integers; zero means
no progress, negatives refuse), `firstAdoptedChapterOccurred` and `irreversibleChoicePending`.
The evaluator counts nothing itself and reads no prose. It returns a frozen
`{ due, reasons }` where `reasons` lists every trigger that fired in the fixed order
`first-adopted-chapter`, `adopted-chapter-interval`, `saved-word-interval`, `irreversible-choice`;
progress exactly at an interval threshold is due. The caller owns counting saved words and adopted
chapters, supplying the first-chapter flag only until that first check-in is taken, and resetting the
since-check-in counters after a check-in. The policy and evaluator perform no scheduling, persistence,
inbox or host wiring; the campaign-continuation adapter now emits cadence when the caller supplies
counted progress (host wiring that supplies it is a later slice).

## Question inbox

`projectQuestionInbox(input, owner)` projects questions the caller already has. It is not a second
store and it does not read the library. The input is an array, or an object whose own `questions`
array is used — the same shapes as `readIrreversibleChoicePending`. Only `state: "open"` is kept.
Entries are sorted by id. Each entry copies that id, the open state, and an explicit boolean
`irreversibleChoice`. When the field is absent the projection omits it; absence is not stored as
`false` or `null`. Keys, options, answers, and other prose are not copied.

A duplicate id refuses as `duplicate-question`. A present kind other than `question` refuses as
`foreign-kind`. A present owner that is not the caller's owner refuses as `foreign-owner`. An
unknown state string refuses as `unknown-question-state`; a missing or non-string state refuses as
`invalid-question-state`. A present non-boolean `irreversibleChoice` refuses as
`invalid-irreversible-choice`, including on a question that would not have been kept. Answered,
superseded, and withdrawn questions are omitted after those checks, not treated as errors.

On a listing object, an own `total` must equal the number of input questions, and an own `offset`
must be `0`. Any other value, including a later page or a total that counts only the open subset,
refuses as `partial-question-list` before the entries are built. A missing `total` or `offset` is
not invented. More than 10,000 inputs refuse as `question-inbox-too-large` before any question is
inspected; exactly 10,000 may proceed. The function does not answer, write, schedule, or resume
cadence.

## Versioned answer check

`checkVersionedAnswer(question, namedRevision, answer, direction, owner)` checks one already
decoded open question against the revision the author named, one proposed answer, and the direction
epoch that answer would create. It does not write, step the run, schedule, or resume cadence.

A store snapshot unwraps only when it has its own `record` and no question `kind` or `state`. The
direction argument is the direction record itself. Silence is `null` or a missing answer and
refuses as `invalid-answer`. A missing or non-string state keeps `invalid-question-state`; an
unknown state string keeps `unknown-question-state`. Withdrawn, superseded, and answered questions
are not open and refuse as `stale-question`, as does a named revision that is not the question's
current revision. A decoded question revision is at least 1.

Exact and confirmed text are copied separately and are not required to equal each other. The
direction must be a direction record whose origin is `answer` (`invalid-question-link` otherwise),
whose question reference names this question at that same open revision (`invalid-question-link`),
and whose previous link is a new epoch under the existing rule (`stale-direction-link`,
`duplicate-direction`). Its `exactText` must be exactly the confirmed text
(`direction-text-mismatch`). The answer's direction reference must name that direction record's id
and revision (`stale-direction`). The hash on that reference is only checked as a digest; this
function does not hash the direction. Extra answer fields, including `answeredAt`, are not copied.

The result is a frozen copy of the question id, the open revision, the two texts, and the direction
id and revision. It is not a stored answer. The caller's records are not frozen or changed.
This check still does not write. Scheduling and host wiring remain open.

## Answered question projection

`projectAnsweredQuestion(question, namedRevision, answer, direction, owner, answeredAt, previousHash)`
builds the next question revision after `checkVersionedAnswer`. It does not write, create a
direction record, step the run, schedule, or resume cadence.

The existing check runs first, so its codes win before `answeredAt` or `previousHash` is read.
`answeredAt` must be a UTC timestamp (`invalid-timestamp`). `previousHash` must be a 64-hex digest
(`invalid-digest`). This function does not hash the question and does not call `saveQuestion`.

The result is a frozen copy of the unwrapped question. Its revision is the open revision plus one.
Its `base` is `{kind:"sha256", value: previousHash, revision: open revision}`. Its state is
`answered`. Its `answer` is `{exactText, confirmedText, direction, answeredAt}`: the two texts come
from the check and stay separate, and `direction` is a copy of the proposed direction reference.
`updatedAt` is that same timestamp. Generation, `createdAt`, and the question's other own data
fields are copied, not invented. The caller's question, answer, and direction are not frozen or
changed. This projection still does not create a direction. Scheduling and host wiring remain open.
The store writer is described below.

## Direction persistence

`WorkflowRecordStore.readDirection` and `createDirection` store one immutable direction epoch at
`directions/<directionId>.json`. Creation is absent-only through the existing create-only path and
uses the codec's `validateDirection`. Revision 1 has `previous: null`. A later epoch names a
different direction id whose previous reference revision is one lower. The store does not open or
hash that previous file. The same bytes are unchanged. Different bytes for the same id are kept as
a conflict copy and the active file stays. This writer does not answer a question, step the run,
schedule, resume cadence, or wire the host.

## Invalidated task projection

`projectInvalidatedTasks(tasks, keys, direction, owner, updatedAt, digests)` builds the next task
revisions for one direction's impact. It does not write, hash a task, open a task file, mark an
attempt historical, clear a live attempt, bump generation, step the run, schedule, or resume cadence.

The owner is checked first. `keys` must be a non-empty list of ids no longer than the impact-key
cap (`missing-impact`, then `record-count`). A non-array is `missing-impact`. Duplicate supplied
keys are not a task-impact duplicate. The tasks may be an array or an object whose `tasks` array
is used; other listing fields are not a cursor and this function does not read the tasks folder.
More than 1,024 tasks refuse as `record-count` before inspection. Each task is checked with the
existing task codec. A snapshot unwraps only when it has its own `record` and no own `kind`. A
task that keeps an unknown `record` object stays that task. Duplicate ids are `duplicate-task`.
A `dependsOn` id missing from the supplied set is `missing-task`.

A task matches when its impact is incomplete (`complete: false`) or one of its impact keys is in
the supplied list. A task that depends on a match matches too, including through further
dependents. A dependency that does not itself match is not included. This is the in-memory
affected-task rule. The supplied direction is not compared with the task's current direction or
with a run epoch.

The direction reference, the UTC `updatedAt`, and the digest map are checked after the match,
including when nothing matches. An empty match is `{ tasks: [] }` only after those checks. Each
affected task needs its own caller digest (`missing-digest`). A snapshot `hash` is not read, and
this function does not hash.

Each result is a frozen copy in input order. Revision is one higher. `base` is
`{kind:"sha256", value: that digest, revision: the old revision}`. The supplied direction
reference is copied on, and `retryAllowed` is true. `updatedAt` is the caller timestamp. An own
cached `status` is dropped, because status is a projection and absent means recompute.
`currentAttempt`, `needsDirection`, `generation`, `createdAt`, and `definition` are copied. The
caller's tasks, direction, and digests are not frozen or changed. The host does not call this
function. Independent continuation and stop precedence remain in-memory reducer proofs.

## Check-in word target

`readCheckinWordTarget(goal, bookId)` is the pure source for a later check-in brief's `targetWords`.
It copies `goalId` and a positive `targetWords` from a schema-1 goal for that book. A cleared goal
(`targetWords: null`) refuses as `absent-word-target`. Any other `schemaVersion` refuses as
`unsupported-version`. A different or missing `bookId` refuses as `foreign-goal`. A supplied value
that carries `selectedUtf16` or `selectedUtf8` at any depth, including inside nested objects and
arrays, refuses as `campaign-count-not-words` before the target is read. The reader never counts
manuscript words, never imports a word counter, and never fills in `goalId` from `bookId`.
`prepareBrief` does not call it, and the continuation check-in leaf still emits no `targetWords`.
Nothing here schedules a check-in or wires a host.

## Campaign stage kinds

`refuseCampaignStageRole(kind)` is the admitted relationship between a review-campaign stage kind
and an authoring role: there is none. `range` and `synthesis` refuse as `campaign-stage-not-a-role`,
and the function never returns a `Role` or `TaskDefinition`. Any other value, including an existing
role name or a stage object, refuses as `unknown-stage-kind` and is not read as an object. `ROLES`
and `validateGraph` stay as they are. The continuation check-in leaf names the refusal, does not
call it, and still emits no task graph. Nothing here wires a host or resumes cadence.

## Adoption receipts

`adoption-receipt.ts` records the state FR-017 adoption needs before cadence can count it. A
receipt (`schemaVersion: 1`, `kind: "adoption-receipt"`, id `adoption_…`) binds one exact
candidate — an `artifact` reference whose hash is the body SHA-256 and whose revision is the
artifact revision — to `chapterId` and the published chapter's `resultVersion`/`resultHash`
(the effect receipt's names), plus the adopting `owner`, a `grant` reference and a `direction`
reference, both checked by `validateReference` against that owner. Adding `grant` to
`ReferenceKind` is the only contracts change; no grant reference kind existed before. Ordering
is caller-supplied (`sequence` 1–1,000,000 and millisecond `adoptedAt`); validation reads no
clock and refuses unknown versions, foreign references and malformed hashes without coercion.
It proves a record is well-formed, exact and attributable, never that adoption was wise.

`countAdoptedChapters(receipts, owner, since?)` is the pure counter a later cadence host will
call. The marker is exclusive: only receipts strictly after the marker sequence or instant
count, so a receipt at the last taken check-in is not recounted; no marker counts from the
beginning. Chapters are distinct within the window — re-adopting one chapter counts once —
and `firstAdoptedChapterOccurred` reports any adoption at all, independent of the window.
Foreign book/run receipts refuse. Checked storage lives beside the workflow store; see
`packages/core/src/workflow/README.md`.

## Admission and accounting

The initial-policy defaults are 3 concurrent requests (configurable 1–4), 600 calls, 12 accumulated
active hours, 7 calendar days, 2 local revision cycles, 1 global pass, 4 calls/8 reads per attempt,
262,144 output bytes, and the ADR's role-specific token ceilings. Lower explicit ceilings are accepted.
Extensions above this initial envelope need a separately reviewed explicit policy-extension contract;
no caller should reset a ledger to obtain more budget. A 1,024-task phase limit does not define a
whole-book limit; linked phase-plan persistence belongs to T018/T023.

The host must serialize reservation decisions under its single admission lock, atomically retain the
new ledger before transport, and recheck all actual gates at the send boundary. Passing the same old
snapshot to two callers is **not** concurrent-safe admission. `otherHostActive`/`otherAccountActive`
exclude this ledger and include other runs; `accountLimit` is the effective limit capped by the host's
maximum four. Known account aliases share `accountKey`; unknown aliases require the conservative
provider bucket. Pin destinations to author-selected routes; no fallback is selected here.

Inject monotonic observed wall time and accumulated active time. Pause/sleep accounting belongs to the
host; the core refuses regression, impossible active time and expiry. Reserve and dispatch both check
gate, clock, capacity and accounting-durability facts. Advance the ledger generation together with the
run's gate before any new dispatch; history/charges/cycles survive, old reserved sends refuse, and old
already-dispatched receipts remain valid historical accounting. Release only `reserved` entries known
not to have crossed dispatch intent. Timeout, cancellation or uncertainty never releases a possible charge.

Every continuation consumes a call and needs a successful settled predecessor, the same immutable
attempt inputs/destination/generation, a new request digest and the next call index. Failed/stopped
attempts cannot be disguised as continuations. Repeated input/direction/review/role tuples across new
attempts, repeated exact request digests and reused/exhausted revision ordinals refuse as no progress.
An explicit Retry alone cannot bypass this; changed instructions/direction are needed for a new attempt.
Revision-writer attempts also name their exact base artifact. An output with that same artifact digest
is retained but parks the completed task as `needs-direction`, with no publication/retry eligibility.
This detects exact unchanged artifacts, not semantic quality or identical prose inside changed metadata.

Bounded operations allow unknown costs and report known subtotal, partial/unknown calls, pending calls
and reservations separately. Strict money requires the caller's **host-qualified provider-enforceable
all-charge maximum**, bound to the exact request/connection/policy. The core does not qualify an adapter
or authenticate that evidence. Catalog estimates, unknown tariff and unqualified enforcement refuse.
Safe micro-USD maxima are reserved across concurrent requests; unresolved charges block further strict
admission. Only actual complete reported receipts release unused maximum. A receipt exceeding its
maximum is retained and closes future admission as an enforcement violation. Integer-sum overflow
refuses the mutation; the host must independently retain the received accounting evidence and park.
Unknown/partial final receipts remain immutable and blocking in strict mode; a future append-only
accounting-reconciliation contract is required to attach later definitive billing evidence.

## Integration prerequisites and evidence boundaries

T018 now supplies the schema-1 workflow records and this raw codec: field-level FORMAT definitions,
exact reference/hash rules, command/receipt pagination, per-kind bounds and conflict/recovery rules.
The schema-1 host-permission descriptor and its pure codec are also present. Shared thread migration,
checked workflow writers, host-permission storage, real streaming and independent review remain open.
A snapshot here aggregates multiple records and command history; do
**not** write it wholesale as `run.json` or infer that it fits the 2.5 MB run-file limit. New graph
inputs enforce 2.5 MB/1,024 tasks and individual task/command/request values enforce 262,144 bytes.
The workflow raw codec validates hash shape but cannot compute a SHA-256, read a related file or
verify currency; the host owns that exact-byte hashing, storage and cross-file reconciliation.
The host-permission codec hashes the exact input bytes when the caller supplies an expected hash.
It does not store the descriptor, read a clock, or resume a host.

T019/T020/T022–T025/T029/T032–T035 own checked conversation/storage, pinned host permission, durable
reservation/effect receipts, lifecycle, real transport, quiescence and publication. No package global
export, SDK/runtime, Library/API/IPC/preload/Workspace or ThreadStore is changed here. FORMAT includes
the T018 workflow-record section and the schema-1 host-permission descriptor. The host-permission
section does not authorize storage or a host resume.
Host integration must prevent copied descriptors and worker text from entering privileged command/
receipt/fact inputs, retain observations before projection errors, reconcile uncertain work explicitly,
and never recreate a ledger on restart to erase charges. Source/exact-citation/context construction,
adoption receipts and 033 saved-word progress remain separate services.

Focused checks (from repository root):

```sh
bun test packages/core/tests/authoring
bunx --no-install tsc -p packages/core/tests/authoring/tsconfig.strict.json
bunx --no-install tsc -p packages/core/tests/authoring/tsconfig.pure.json
bunx --no-install biome lint packages/core/src/authoring packages/core/tests/authoring
```

`tsconfig.pure.json` gives the source no Node/Bun types. The boundary test checks local-only imports and
absence of runtime/send/write/timer primitives; all behavioral tests use synthetic in-memory values.
These tests do not establish transport overlap, actual host serialization, durable persistence,
filesystem recovery, a full-length generated book, literary quality, device behavior or a dollar-cap
adapter. Independent exact-candidate review and the parent-owned integrated gates remain required.
