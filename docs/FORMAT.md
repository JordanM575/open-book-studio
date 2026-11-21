# The studio file format

A library is an ordinary folder. Everything the app knows can be read, diffed and edited with a text
editor; nothing important lives in a database or in an opaque blob. The app's profile holds settings,
and words a close or quit could not save until the author restores or discards them (see
[Words kept after a failed close or quit](#words-kept-after-a-failed-close-or-quit)).

```
<library>/
  library.json                 derived catalog — safe to delete
  books/
    book_1f4c8a2b9d3e5a71/
      book.json                idea, outline, cast, memories, settings
      chapters/
        0001-the-door.md       YAML front matter + Markdown prose
        0002-the-lighthouse.md
      images/                  illustrations and character images owned by this book
        img_….png
      images.json              image provenance and chapter attachments
      conflicts/               versions kept when two writers disagreed
      threads/                 agent conversations, one JSON file per thread
      checkpoints/             reserved for draft checkpoints
      .studio/
        checkpoints/           undo points, one JSON file per agent turn
  .studio/
    device.json                identity of this machine
    files.json                 reserved index metadata
    sync/
      device_…json             this device's last scan; never exported
    trash/
      book_…/1719340000000-0002-the-lighthouse.md
      book_…/threads/mw84o1sb-thread_855661fbeed74ce0.json
```

The library folder can live anywhere: locally, in iCloud Drive, in Google Drive, in Dropbox, on a
network share. The studio makes no attempt to merge providers' conflict files; it surfaces them
(see below).

### Browser storage

The browser build keeps the same tree either in origin-private storage or in a folder the author picks.
The directory-handle adapter writes through a swap file and re-checks the whole-file hash before the
commit point; if another writer changed the file, the old bytes stay and the author's text is preserved
in `conflicts/`. Browser storage can be cleared by the browser; export a portable archive to keep a copy.

## Accepted reservations awaiting detailed schemas

ADRs [0019](adr/0019-bounded-autonomous-authoring.md) and
[0020](adr/0020-inline-editorial-review.md) reserve the following locations. **These are not yet
writable formats.** Pure graph/permission/editor contracts can proceed; no writer may infer a wire
schema from these directory names or from an unchecked TypeScript object.

| Reserved location | Accepted ownership / prerequisite |
| --- | --- |
| `books/<bookId>/workflows/<runId>/` | Book-owned run/brief/policy/plans/directions/tasks/commands/attempts/effects/questions/artifacts/contexts/admission records. Schema 1 is defined in [Workflow records](#workflow-records-schema-1); checked writers for `run`, `task`, `attempt`, `effect`, `question`, `artifact` and `context` exist, and an absent-only `direction` writer exists, while command/admission writers and independent storage review remain separate. |
| `books/<bookId>/reviews/<runId>.json` | Immutable absent-only explicit saved report; analyzer/profile/source/coverage/findings attribution, bounded quotes, no full source bodies. Schema 1 is defined in [Saved review records](#saved-review-records-schema-1); checked writer and saved-record IPC/UI exist, export and independent review remain open. |
| `books/<bookId>/reviews/dispositions/`, `profiles/`, `campaigns/<campaignId>.json` | Checked author-owned records. The existing schema-1 writer is defined in [Saved review records](#saved-review-records-schema-1). The same campaign path is also reserved for the distinct [schema-2 manifest](#saved-campaign-continuation-manifest-schema-2-segment-and-intent-schema-1), not implemented by that writer. |
| `books/<bookId>/reviews/campaigns/<campaignId>.segments/`, `<campaignId>.intents/`, and `reviews/campaign-moves/` | D-201 [schema and recovery rules](formats/campaign-continuation.md); pure segment/intent candidate encoding and inspection exist, a checked storage slice publishes and recovers one campaign's manifest, segments and intents, and a checked group slice now trashes/restores the whole campaign group under an immutable group intent and resolves checkpoint reports across their recorded owners. A checked fixed-history slice additionally moves the owner book's `history/` tree with that campaign group under an immutable fixed-history intent in `reviews/fixed-history-moves/`. No host execution or portable-archive claim is added. |
| Existing `books/<bookId>/threads/` v2 | Explicit backed-up migration for new semantic parts only. V1 checked whole-document revisions/raw hashes, lossless supported unknown fields, future/unknown-semantic read-only behavior and recoverable trash/restore are current; see [Conversation files](#conversation-files). |
| Host-local workflow permission (outside library/archive) | Separate selected-host protected/disclosed store; registration/book/run/policy/generation/expiry/revoke/resume, no prose or credential; missing or copied descriptor grants no execution |

The workflow row is now specified in [Workflow records (schema 1)](#workflow-records-schema-1);
the T023 checked record writers exist on `LibraryService.workflowRecords`, while command/admission
writers and independent storage review remain open. The saved-review rows are now
specified in [Saved review records (schema 1)](#saved-review-records-schema-1); their checked writer
and saved-record IPC/UI exist but export/archive and independent review remain open. D-201 has
pure in-memory continuation codec and compatible-replan leaves plus checked storage slices for
one campaign's manifest, segments and intents and for whole-group trash/restore with cross-book
report resolution; occurrence/disposition continuation, host execution, portable archive/export
and independent review remain open. The host-local workflow permission
row remains a reservation.

Each detailed format must name every field and optional/default rule; schema/kind/owner/host-issued ID;
safe revisions/generations; raw-byte and semantic limits (including unknown fields); supported JSON/
Unicode/number domain; absent/current/stale no-op semantics; exact publication/readback and failure
receipts; issue-bearing list/read; conflict preservation; explicit migration; archive/sync and recoverable
trash/restore. Cross-file operations are recoverable sequences. No automatic pruning or replay of
uncertain dispatch/publication. Adopt the ADR-specific byte bounds without inventing eviction.
Changing a reservation requires updating its ADR and owning spec. Existing v1 thread behavior below
is current format evidence: its checked-write migration covers every v1 caller, while an explicit v2
semantic migration remains unimplemented.

## Checked planning and goal sidecars

D-163–D-168 / [ADR 0017](adr/0017-planning-and-organization.md) define these optional
book-owned files. Worldbuilding, timeline events, beats, optional story notes, explicit ordering,
record archive/restore and goal set/clear use the current Library's shared queue and validated
desktop/browser transport. Workspace planning controls expose those manual operations; full native
host/visual acceptance and the remaining organization journeys retain their separate delivery gates.

### `books/<bookId>/planning.json` (schema 1)

All listed fields are required except `storyNotes`. Objects are loose: supported unknown JSON
fields at every depth survive known-field edits literally, including whitespace inside strings.
Validation never inserts defaults into an existing document. No trimming or Unicode normalization
is applied. The following is a complete minimal saved example:

```json
{
  "schemaVersion": 1,
  "bookId": "book_1f4c8a2b9d3e5a71",
  "revision": 1,
  "worldbuilding": [
    {
      "id": "wb_1234567890abcdef",
      "kind": "worldbuilding",
      "bookId": "book_1f4c8a2b9d3e5a71",
      "revision": 1,
      "archived": false,
      "name": "The salt road",
      "category": "Place",
      "description": "A road beside the sea.",
      "notes": ""
    }
  ],
  "timeline": [],
  "timelineOrder": [],
  "beats": [],
  "beatOrder": []
}
```

Every record has immutable `id`, `kind`, `bookId`, positive safe-integer `revision`, and boolean
`archived`. In addition to the worldbuilding shape above:

| Field | Record kind / ID prefix | Required authored fields |
| --- | --- | --- |
| `timeline[]` | `timeline` / `tl_` | `title`, `when`, `description`, `notes` |
| `beats[]` | `beat` / `beat_` | `title`, `summary`, `notes` |
| `storyNotes` (optional single object) | `story-notes` / `sn_` | `workingNotes`, `styleNotes`, `synopsis` |

`timelineOrder` and `beatOrder` each contain exactly the corresponding retained record IDs once,
including archived records; hiding archived entries never destroys their position. Lists retain
at most 200 records each, active and archived combined. Names/titles must be nonblank; names,
titles, categories and literal `when` labels have at most 200 **UTF-16 code units**. All other
authored text fields have at most 20,000 code units. IDs have prefix-specific suffixes matching
`[A-Za-z0-9-]{6,40}`; hosts generate them, never the editor. IDs are unique across all retained
records. Every record owner equals the file owner and the actual owning `book.json` ID.

### `books/<bookId>/goals.json` (schema 1)

```json
{
  "schemaVersion": 1,
  "bookId": "book_1f4c8a2b9d3e5a71",
  "revision": 1,
  "targetWords": 50000
}
```

`targetWords` is a positive safe integer or `null`. Clearing an existing goal saves `null`,
preserving unknown fields; it does not delete the file. Clearing an absent goal is a no-write
operation. Counts are derived, never stored here: complete verified saved chapter snapshots yield
`savedWords` and `remaining` (null without a target, otherwise floored at zero). Unreadable chapters
yield `incomplete` with an issue count and no total/remaining; changed or unverifiable sources yield
`unavailable`. Two saved reads must agree on book identity, chapter enumeration, IDs, paths,
versions, raw hashes, bodies and read issues; the goal token is rechecked too. Each enumerated source
is independently read and its exact raw SHA-256 recomputed, decoded with fatal UTF-8, and compared
against its canonical saved body and recorded identity/version. History's quiet plain-value front
matter reader is reused; unsupported metadata makes this count unavailable without changing the
ordinary chapter view. Valid headerless saved text remains countable. Empty books are a complete
zero. The host owns complete enumeration. This is point-in-time verification, not a filesystem
transaction or draft count.

The integrated reader uses fresh directory enumeration, retains duplicate-ID files as read issues
instead of silently counting only the preferred copy, and compares the filesystem adapter's inspected
entries to the readable listing. Unsupported chapter entries, omitted inspected files and iCloud
placeholders cannot confirm a total. A recorded chapter `bookId`, when present, must match the owner.
Valid headerless and partial-metadata chapters retain the existing deterministic fallback identity.
Observed external changes, saved chapter hashes/enumeration/read issues, explicit refresh, window
focus and planning write outcomes invalidate displayed progress. Dirty/pending/failed/conflicting
editor state is separately labelled and never supplies the saved count.

### Sidecar mutation and recovery

Both files have an exact **2,500,000 UTF-8 byte** budget, including unknown fields, two-space
indentation and a final newline in new serialized output. Reads check stat and actual returned
bytes; writes check the baseline input and complete proposed output separately. Unknown fields
are never dropped to make room. Missing means empty without creating directories or files.
Malformed, over-budget, foreign-owner, newer-schema and copy-only documents in an active location
are unavailable and write-refused. An invalid sidecar does not invalidate the rest of the book.

The core save envelope is `{bookId, source, baselineJson, draft}`. `source` is exactly
`{kind:"absent", revision:0}` with `baselineJson:null`, or
`{kind:"sha256", value:<64 lowercase hex>, revision:<positive safe integer>}` with the exact raw
UTF-8 JSON string returned by read. The service checks that string's hash/revision/owner. `draft`
is one of these strict typed intents:

- `create-worldbuilding` / `edit-worldbuilding`: `{name,category,description,notes}` fields; edits
  also carry the existing `id`.
- `create-timeline` / `edit-timeline`: `{title,when,description,notes}` fields, with existing `id`
  for edits. `create-beat` / `edit-beat`: `{title,summary,notes}` fields and existing `id` for edits.
- `set-story-notes`: `{workingNotes,styleNotes,synopsis}` fields. `clear-story-notes` clears those
  known strings but retains the singleton's identity and unknown supported data. An absent singleton
  plus clear or an all-empty set writes nothing.
- `order-timeline` / `order-beats`: `ids`, an exact permutation of all retained corresponding IDs.
- `archive-worldbuilding` / `archive-timeline` / `archive-beat`: existing `id` and `archived` boolean;
  false restores. Archive retains content and order position. Editing an archived list record requires
  restore first. New timeline/beat IDs append to their order. Order-only edits increment the file
  revision, not record revisions; changed content or archive state advances the affected record too.
- For goals, `set-goal` with `targetWords`.

No path, generated ID, revision, owner, arbitrary document replacement or unrelated field patch is
accepted in a draft. The full intended document is constructed from that bounded
baseline plus draft; this preserves unknown/unrelated fields without trusting an editor to resend
them correctly. The request carries only one full baseline and bounded authored fields, within
the ADR's two-document allowance: the raw baseline and serialized `{bookId,draft}` are each capped
at 2,500,000 bytes. Strict control validation rejects additional keys. Each unquoted JSON number
must retain its exact mathematical decimal value when parsed and serialized as a JavaScript Number.
Overflow, underflow, rounded decimals/integers and negative zero are refused before mutation,
including in nested unknown fields and recovery baselines. Supported numeric spelling may change
(for example, `1.00` to `1`); numeric-looking strings remain literal. Known revision/target fields
additionally require safe integers. Refusal leaves the original bytes intact.

Under the owning Library's existing book queue, validate the actual book and independently
supported sidecar, then compare exact absence/hash **and** revision. Only a current semantic
no-op writes nothing. A real operation increments the file revision once and its edited record
revision once; host-created records start at 1. Incrementing `Number.MAX_SAFE_INTEGER` is refused.
One checked absent/SHA commit is allowed, through the Library's existing journal-aware commit
hook. There is no retry, rebase, merge, catalog update or book timestamp change.
A current semantic no-op keeps even a compact source whose pretty-printed form would exceed the
budget: it does not reserialize or publish that form.

A stale request (even a same-content request), missing-after-read or commit race preserves its
complete intended document under
`books/<bookId>/conflicts/<planning|goals>.conflict-<external-edit|missing-file>.<deviceId>.<timestamp>[-N].json`.
The copy adds a reserved `conflictMetadata` object with `reason`, original `baseline` token,
`observed` token, `requestHash` and, for transported saves, `attempt: {requestId,publicationId}`.
`requestHash` is SHA-256 of the UTF-8 `JSON.stringify` output of
`{bookId,source,draft}`, in that key order with the strict schema-parsed source and typed draft;
the source's raw hash already binds the complete original baseline bytes. Older copies without
`requestHash` or an attempt binding remain inspectable but cannot confirm a new transported save. Recovery copies are bounded
to 5,000,000 bytes. Colliding names use absent-only
suffix attempts; returned bytes and their hash must verify before reporting `conflict`/`savedAs`.
Only conflict-copy names may be retried, never the active-file commit. A copy cannot be loaded as
an active baseline; eventual explicit recovery must remove the copy-only context and create a
fresh reviewed edit. Both the active write and copy publication can be uncertain after an adapter
error or mismatching readback: report `uncertain`, keep the editor draft and reread storage; never
replay automatically or remove a possibly published file. Copy failure never claims a durable copy.
Owner/schema checks run again before copy creation and each publication attempt.

Transport preserves exact raw baselines, validates strict request/result envelopes and verifies reply
owner, raw hash, revision and the complete projected document, including unknown own JSON fields.
Data correspondence checks dense array lengths and own data properties; sparse or non-JSON transport
values cannot stand in for the raw document. Changed `saved` replies must contain the exact writer
serialization (two-space indentation, original property order and final newline) and its hash.
Valid compact reads and current `unchanged` replies keep their original bytes without canonicalizing.
For each explicit API save, the client generates a fresh UUID request ID in the internal wire
envelope; the handler independently generates a fresh UUID publication ID, even if the caller repeats
its request ID. Both IDs accompany every success/no-op/conflict receipt. Host-created planning IDs
are `<kind-prefix>_<publicationId>` for transported creates, so the handler reconstructs the expected
identity from its private attempt snapshot rather than learning it from the response. The client
checks its request ID and reconstructs from the returned host publication ID; the handler checks both
against its pinned values. Request/attempt validation snapshots are separate from mutable objects
passed to services/transports. Direct service calls may omit transport binding and retain runtime-
generated IDs; their unbound receipts cannot confirm a transported save. No session registry or
hidden durable authority is introduced.

A `conflict` result carries `preserved: {rawJson,hash}`: the complete recovery bytes verified at
publication, not an echoed nonce. Handler and client independently validate the intended operation,
baseline, observed token, reason, attempt binding, created identity, full projected draft and exact recovery
serialization against that receipt. Before returning, the handler also reads the named durable copy
through the captured Library and requires its name/hash/raw bytes to match. A missing, changed or
unverifiable copy is uncertain, never a claim that this draft was kept. These are snapshot and
correspondence checks, not cryptographic transport authentication or a guarantee against later edits.

Known request-admission failures and typed deterministic preparation failures return
`outcome: "refused"` without a publication phase. The latter are constructed only while projecting,
validating and bounding the complete output, before any active or recovery commit/layout/journal
attempt. Their drafts and original baselines remain usable for correction and a later explicit save.
Read/adapter errors and unknown exceptions remain uncertain; no general `LibraryError` downgrade is
allowed after a possible publication. Write errors retain `phase: "active" |
"recovery"` and `outcome: "uncertain" | "not-kept"`. The browser adapter marks a `changed` result
after publication with `publication: "uncertain"`; planning treats that as an uncertain outcome,
never as a prepublication conflict or a collision to retry. This adds no cross-process CAS guarantee.

Workspace recovery lists planning/goal copy names in pages of 25 (a display window, not a retention
limit). Inspection verifies bounded raw bytes, hash, schema, owner and copy-only metadata; a named
copy that cannot be verified stays unavailable. Recovery is explicit manual review: inspect the
read-only document, reopen the appropriate current editor, enter the chosen fields and submit a new
checked edit. There is no whole-document restore endpoint or automatic loading of copy metadata as
active state. Every inspected text field also exposes its exact JSON-string representation for
manual re-entry. The editors offer an explicit exact-JSON-string mode; saved values containing CR
or null characters start in that mode. Only a valid decoded string can be submitted, and field
limits apply to its decoded UTF-16 length. Incomplete/invalid encoded input remains in the guarded
draft rather than falling back to an earlier valid value. Ordinary text areas support multiline
short fields but normalize line endings to LF; exact mode preserves CR, CRLF, LF and literal escapes.
The full-copy display has a separate JSON-string representation of the original raw JSON, which
decodes once to the exact verified text, including legacy formatting. Displaying or recovering fields
does not change the stored copy. Order editors show stable record IDs and associate them with move
controls, including archived rows and duplicate titles. Newer active unknown fields remain owned by
the current baseline. Native close and shell book/library navigation are blocked until the matching
dialog resolves pending/dirty/uncertain
state; after closing an editor, retry the navigation action. Abrupt process termination cannot retain
an in-memory draft or cancel a publication already sent.

Book-side files and their conflict copies travel in folder copies, portable archives and whole-book
trash/restore. Collection and annotation file writers, recents and annotation navigation are not
part of this first slice; their accepted contracts remain in ADR 0017.

## Workflow records (schema 1)

D-194–D-196 / [ADR 0019](adr/0019-bounded-autonomous-authoring.md) define the only full-book workflow
authority. This section specifies the durable schema-1 records under
`books/<bookId>/workflows/<runId>/` that the pure graph, lifecycle and admission contracts need. It
does **not** authorize a scheduler, provider call, publication or host permission. The checked writer
for the T023 record kinds, and the absent-only direction epoch writer, is
`packages/core/src/workflow/record-store.ts`, constructed as
`LibraryService.workflowRecords`; command/receipt pages, admission records, scheduling, provider
calls, publication and independent storage review remain open. The direction writer does not open
or hash the previous direction file. The pure host-neutral raw codec is
`packages/core/src/authoring/wire.ts`; it performs no I/O.

### Layout

| Path under `workflows/<runId>/` | Record kind | Mutability |
| --- | --- | --- |
| `run.json` | `run` | Checked control header. |
| `brief.json` | `brief` | Immutable exact onboarding brief and 033 goal link. |
| `policies/<policyId>.json` | `policy` | Immutable agreement/routing/limits snapshot. |
| `plans/<planId>.json` | `phase-plan` | Immutable linked phase task graph. |
| `directions/<directionId>.json` | `direction` | Immutable direction epoch. |
| `tasks/<taskId>.json` | `task` | Checked task definition and status-projection inputs. |
| `commands/<commandId>.json` | `command` | Append-only command journal entry. |
| `commands/pages/<first>-<last>.json` | `journal-page` | Immutable command pagination page. |
| `attempts/<attemptId>.json` | `attempt` | Checked dispatch, output and accounting record. |
| `effects/<effectId>.json` | `effect` | Checked publication intent and receipt. |
| `effects/receipts/pages/<first>-<last>.json` | `journal-page` | Immutable receipt pagination page. |
| `questions/<questionId>.json` | `question` | Checked question and answer. |
| `artifacts/<artifactId>.meta.json` | `artifact` | Immutable artifact attribution metadata. |
| `artifacts/<artifactId>.md` or `.json` | (body) | Immutable artifact bytes, at most 1 MiB. |
| `contexts/<contextId>.json` | `context` | Immutable captured-source manifest. |
| `admission/reservations/<reservationId>.json` | `reservation` | Checked reservation and settlement. |
| `admission/observations/<sequence>-<observationId>.json` | `observation` | Append-only host observation. |
| `admission/accounting.json` | `accounting` | Checked accounting summary input. |
| `adoptions/<receiptId>.json` | `adoption-receipt` | Absent-only recorded adoption receipt (see below); beside-store, not a schema-1 codec kind. |
| `conflicts/` | (copy) | Recoverable conflict copies; never active records. |

### Common encoding and identity

- **Exact bytes.** A saved record is UTF-8 with no byte-order mark. New checked writes use the codec's
  canonical form: compact JSON, object keys sorted by UTF-16 code-unit order, no insignificant
  whitespace and no trailing newline. The codec accepts any valid JSON spelling for inspection, but a
  checked writer must hash and commit the exact canonical bytes it intends to publish. A record's raw
  SHA-256 is over those exact file bytes.
- **Plain JSON only.** No comments, trailing commas, `NaN`, `Infinity`, `-0`, duplicate member names,
  lone surrogates or non-data JavaScript values. Strings are not trimmed or Unicode-normalized.
  Supported unknown plain fields survive at every depth. Strict control objects (`limits`, `routes`,
  `destination`, `cost`, `maximum`, `target`, `intent`, `receipt`, `facts`, `clock`, `accounting`,
  `summary` and journal entries) reject extra keys rather than silently ignoring a control.
- **Numbers.** A numeric token must parse to a finite value whose exact decimal value round-trips
  through the canonical Number spelling; the absolute value is at most `2^53-1`. `9007199254740993`,
  `1e400`, `1e-400`, `1.0000000000000001`, `-0` and equivalent lexemes are refused. Every revision,
  generation, sequence, version, count, timestamp-in-milliseconds and micro-USD amount is a
  nonnegative safe integer except where a positive minimum is stated.
- **Depth and size.** The raw reader admits at most 64 nested value wrappers. Record byte limits
  are in the bounds table below. Reads check the exact byte count before parsing; writes check the
  exact canonical byte count before commit.
- **Schema and identity.** Every record has `schemaVersion: 1`, `kind`, `owner`
  (`{libraryRegistration, bookId, runId}`), a host-issued `id`, and `revision`. `owner` must equal the
  record's actual owning registration/book/run. `id` must use the kind's prefix and a safe
  `[A-Za-z0-9][A-Za-z0-9_-]{0,127}` suffix. A missing, future or foreign record is unavailable; it is
  never rewritten or migrated on read.
- **Checked vs immutable.** Checked records carry `base` and a positive `revision`. At revision 1 the
  base is exactly `{kind:"absent", revision:0}`. At revision `n > 1` the base is exactly
  `{kind:"sha256", value:<lowercase SHA-256>, revision:n-1}` for the previous raw file. A missing,
  mismatched or stale base refuses the write. Immutable records have no `base`; their `revision` is
  exactly 1 unless the kind states otherwise. No read inserts defaults or unknown fields.
- **References.** A reference is exactly `{kind, owner, id, revision, hash}`. `kind` must match the
  named field, `owner` must equal the containing record's owner, `id` must use that kind's prefix,
  `revision` is a positive safe integer, and `hash` is the lowercase SHA-256 of the referenced exact
  raw file (for an artifact reference, the artifact body bytes, not its metadata). No supplied path,
  URL, filename or worker text is a reference.
- **Timestamps.** `createdAt`, `updatedAt`, `recordedAt`, `at`, `intentAt` and `answeredAt` are UTC ISO
  8601 with exactly millisecond precision, for example `2026-11-07T00:00:00.000Z`.
- **Default rule.** Writers emit every required field. Required nullable fields are emitted as `null`;
  the codec never invents a value. Truly optional fields are omitted when absent and keep their
  in-memory default without being written back. Unknown supported extensions are retained literally.
- **Unknown fields.** The fields listed for a record are its known fields; any other plain JSON field
  is a supported extension and survives at every depth, including `__proto__` as ordinary data.
  Strict control objects named above reject extras instead. No record silently drops an unknown field.

### `run.json` — checked run header

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `base` | yes | Common envelope; `kind:"run"`, `id:"run_…"`. |
| `generation` | yes | Positive safe integer; the current control/admission generation. |
| `mode` | yes | `running`, `pausing`, `paused`, `cancelling`, `cancelled`, `revoking`, `revoked`, `finishing` or `finished`. Pause/cancel/revoke settle separately from their request. |
| `phasePlan` | yes | Reference to the current immutable `phase-plan`. |
| `policy` | yes | Reference to the current immutable `policy`. |
| `direction` | yes | Reference to the current immutable `direction`. |
| `queue` | yes | Array of up to 64 unique `task` references; empty when nothing is queued. |
| `materialized` | yes | Array of up to 4 unique `reservation` references; empty when none are admitted. |
| `createdAt`, `updatedAt` | yes | UTC ISO timestamps. |

`run.json` is control only. It never embeds attempts, effects, questions, commands, artifacts or the
in-memory snapshot aggregate. `mode` stores the control request/settling label; the pure reducer's
`RunSnapshot.mode` uses the five stable modes and derives `pausing`/`cancelling`/`revoking` from
unsettled attempts/effects. A host maps between them; a settling label is never permission to
continue or retry. The 2,500,000-byte run bound is a file bound, not a claim that an aggregate
snapshot fits.

### `brief.json` — immutable exact brief

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision` | yes | `kind:"brief"`, `id:"brief_…"`, `revision:1`; no `base` or `generation`. |
| `text` | yes | Exact brief, at most 20,000 UTF-16 code units **and** 65,536 UTF-8 bytes. No trimming or normalization. |
| `goalId` | yes | Existing 033 goal identity; this record never counts words. |
| `targetWords` | yes | Positive safe integer. About 100 words is guidance, not a cap. |
| `genre`, `audience`, `perspective`, `tone` | no | Optional authored strings, each at most 2,000 UTF-16 units and 8,192 UTF-8 bytes. |
| `constraints` | no | Optional array of at most 64 strings, each with the same 2,000-unit/8,192-byte bound. |
| `createdAt` | yes | UTC ISO timestamp. |

The file is immutable. A corrected brief requires an explicit new run or an independently reviewed
migration; it is never rewritten in place.

### `policies/<policyId>.json` — immutable agreement snapshot

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `generation` | yes | `kind:"policy"`, `id:"policy_…"`, `revision:1`; no `base`. |
| `policyDigest` | yes | Lowercase SHA-256 of the exact agreed policy content. |
| `startedAtMs` | yes | Nonnegative safe epoch milliseconds. |
| `limits` | yes | Strict object with exactly the nine keys below. |
| `routes` | yes | 1–7 objects with unique `role` and a strict `destination`; every role is pinned, never ranked or replaced. |
| `cost` | yes | Strict `{mode:"bounded-operations"}` or `{mode:"strict-money", capMicroUsd:<positive safe integer>}`. |
| `createdAt` | yes | UTC ISO timestamp. |

`limits` requires exactly: `concurrency` 1–4; `calls` 1–600; `activeMs` 1–43,200,000;
`lifetimeMs` 1–604,800,000; `localRevisions` 0–2; `globalRevisions` 0–1; `callsPerAttempt` 1–4;
`readsPerAttempt` 1–8; `outputBytes` 1–262,144. A `destination` is exactly
`{connectionId, providerId, modelId, accountKey}`; the first, second and fourth are safe IDs, and
`modelId` is a nonblank string of at most 512 UTF-16 units and 2,048 UTF-8 bytes. A changed agreement
is a new immutable policy record with a new ID/generation, referenced by a checked `run.json` update.
Bounded operations permit unknown actual cost; strict money requires qualified provider-enforceable
all-charge maxima. No zero-cost inference or automatic renewal is part of this format.

### `plans/<planId>.json` — immutable phase plan and link

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `generation` | yes | `kind:"phase-plan"`, `id:"plan_…"`, `revision:1`; no `base`. |
| `phase` | yes | Positive safe integer; phase 1 has `previous:null`. |
| `previous` | yes | `null` for phase 1, otherwise a `phase-plan` reference. The host verifies the linked phase is exactly one lower before accepting the plan. |
| `graph` | yes | Schema-1 graph described below. |
| `createdAt` | yes | UTC ISO timestamp. |

The graph is the existing pure `Graph`: `version:1`, the same `owner`, `policyDigest`, `generation`
equal to the record's `generation`, a `direction` reference and 1–1,024 task definitions. Each task
definition has a `task` reference, a role from the accepted seven, `completion` of `candidate` or
`adoption`, unique `dependsOn` task references and complete host-validated `impact`
`{complete, keys}` with unique safe-ID keys. Every dependency must resolve to the same owner with the
same ID/revision/hash; cycles, duplicate tasks and missing/stale dependencies are refused. Supported
unknown graph/definition fields survive. A worker cannot assert independence or supply paths.
Linked phase plans allow longer work without truncation; no whole-book task limit is inferred from
the 1,024-per-plan bound.

### `directions/<directionId>.json` — immutable direction epoch

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision` | yes | `kind:"direction"`, `id:"direction_…"`; `revision` is the direction epoch (at least 1); no `base` or `generation`. |
| `exactText` | yes | Exact author/direction text, at most 262,144 UTF-16 units and 262,144 UTF-8 bytes. |
| `origin` | yes | `onboarding`, `outline`, `cast`, `answer` or `author`. |
| `previous` | yes | `null` only at revision 1; otherwise a `direction` reference whose revision is exactly one lower and whose ID differs. |
| `question` | yes | Non-null `question` reference exactly when `origin` is `answer`; otherwise `null`. |
| `createdAt` | yes | UTC ISO timestamp. |

`WorkflowRecordStore.readDirection` and `createDirection` are the absent-only writer for this file.
Creation uses the codec's `validateDirection` and commits only when the file is absent. The same
bytes are unchanged. Different bytes for the same id are kept as a conflict copy and the active
file is not replaced. A later epoch is a different id. The store does not open or hash the previous
direction file. It does not answer a question, update a question, step a run, schedule, or resume
cadence.

A confirmed answer creates immutable versioned direction, closes affected publication gates and
invalidates dependent attempts. Old directions and old-epoch outputs remain historical. No base or
direction token is silently refreshed, and a live attempt's prompt never changes.

### `tasks/<taskId>.json` — checked task and projection inputs

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `base`, `generation` | yes | `kind:"task"`, `id:"task_…"`. |
| `plan`, `phase` | yes | `phase-plan` reference and positive phase number. |
| `definition` | yes | `{role, completion, dependsOn, impact}` as in the phase plan. Supported unknown definition fields survive; `impact` is strict. |
| `direction` | yes | The `direction` reference captured for this task. |
| `currentAttempt` | yes | `null` or an `attempt` reference. |
| `retryAllowed`, `needsDirection` | yes | Booleans; an explicit retry is a new host command, never automatic. |
| `status` | no | Optional cached projection: `blocked`, `ready`, `preparing`, `executing`, `validating`, `ready-to-publish`, `completed`, `failed`, `stale`, `uncertain` or `needs-direction`. Absent means recompute from inputs. |
| `createdAt`, `updatedAt` | yes | UTC ISO timestamps. |

Task status is a projection, not an authority. The host validates dependencies, direction currency,
draft safety, grant and exact target before any dispatch or publication. `failed`, `stale` and
`uncertain` never imply free retry or no charge.

### `commands/<commandId>.json` — append-only command journal entry

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `generation` | yes | `kind:"command"`, `id:"command_…"`, `revision:1`; no `base`. |
| `sequence` | yes | Positive safe integer, unique and contiguous from 1 in the run's command journal. |
| `expectedRevision` | yes | Nonnegative safe integer expected run revision. |
| `payloadDigest` | yes | Lowercase SHA-256 of the complete command payload. |
| `action` | yes | Plain object with `type` one of `pause`, `cancel`, `revoke`, `resume`, `recover`, `finish`, `question`, `close-question`, `answer`, `direction`, `retry`, `prepare`, `attempt`, `prepare-effect` or `effect`; semantic fields are validated by the pure reducers. Supported unknown action fields survive. |
| `recordedAt` | yes | UTC ISO timestamp. |

Command IDs deduplicate only equal payloads: equal ID with the same digest/payload replays the
current snapshot; equal ID with a different payload refuses. A replay never renews execution
authority. Commands are never rewritten or reordered.

### Journal pages — command and receipt pagination

`commands/pages/<first>-<last>.json` and `effects/receipts/pages/<first>-<last>.json` use the same
strict `journal-page` record:

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision` | yes | `kind:"journal-page"`, `id:"journal_…"`, `revision:1`; no `base` or `generation`. |
| `journal` | yes | `command` or `receipt`. |
| `pageSize` | yes | 1–256. |
| `firstSequence`, `lastSequence`, `nextSequence`, `total` | yes | Positive safe integers; `nextSequence` is exactly `lastSequence + 1`; `total` is at least `lastSequence`. |
| `entries` | yes | 1–`pageSize` `{sequence, ref}` objects. Sequences are contiguous from `firstSequence` through `lastSequence`. A command page references `command`; a receipt page references `effect`. |
| `createdAt` | yes | UTC ISO timestamp. |

Pages are immutable, ordered by `firstSequence`, and never leave sequence gaps or overlap. A reader
pages by `firstSequence`/`nextSequence`; `total` reports durable entries. Receipt pages index the
`effect` records whose checked receipt is the publication result; the effect remains the authoritative
receipt holder. No page or receipt is automatically pruned or compacted.

### `attempts/<attemptId>.json` — checked attempt, dispatch and accounting

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `base`, `generation` | yes | `kind:"attempt"`, `id:"attempt_…"`. |
| `task`, `direction`, `context` | yes | Same-owner `task`, `direction` and `context` references. |
| `inputDigest` | yes | Lowercase SHA-256 of the immutable attempt input. |
| `revisionOf` | yes | `null`, or the exact base `artifact` reference for a revision-writer attempt. |
| `phase` | yes | `prepared`, `dispatch-intent`, `receiving`, `output-kept`, `completed`, `failed`, `stopped` or `uncertain`. |
| `historical`, `noProgress` | yes | Booleans. Historical attempts keep original inputs/outputs; a no-progress output cannot publish or retry. |
| `outputs` | yes | Up to 64 unique `artifact` references. |
| `dispatch` | yes | `null`, or strict `{destination, requestDigest, intentAt}`. The destination is the pinned route; `requestDigest` is a SHA-256; `intentAt` is UTC ISO. |
| `accounting` | yes | Strict `{calls, localReads, knownSubtotalMicroUsd, unknownCalls, partialCalls}`: calls 0–4, reads 0–8, amounts nonnegative safe integers, and `unknownCalls + partialCalls <= calls`. |
| `providerReceipts` | yes | Up to `calls` unique receipts, each strict `{id, reservationId, outcome, accounting}`; outcome is `succeeded`, `failed` or `stopped`; accounting is `{kind:"reported"|"partial", microUsd}` or `{kind:"unknown"}`. |
| `createdAt`, `updatedAt` | yes | UTC ISO timestamps. |

Dispatch intent and actual accounting are distinct. A persisted intent without a conclusive receipt
is uncertain, never known-unsent. Failed, stopped and uncertain never imply no charge. There is no
automatic provider retry or model/route substitution.

### `effects/<effectId>.json` — checked publication intent and receipt

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `base`, `generation` | yes | `kind:"effect"`, `id:"effect_…"`. |
| `attempt`, `candidate` | yes | Same-owner `attempt` and exact `artifact` references. |
| `phase` | yes | `prepared`, `publish-intent`, `confirmed`, `conflict`, `not-published` or `uncertain`. |
| `target` | yes | Strict `{kind, chapterId, path}`; kind is `new-chapter` or `replace-chapter`, `chapterId` is safe, and `path` is a relative library path with no leading slash, backslash or `..` segment. A new chapter preallocates an absent ID/path. |
| `intent` | yes | `null`, or strict `{at, baseVersion, baseHash, intendedHash, intendedBytes, safety}`. `intendedBytes` is 0–1,048,576. New chapters require baseVersion 0, baseHash null and safety null; replacements require baseVersion at least 1, a baseHash and a safety `artifact` reference. |
| `receipt` | yes | `null`, or strict `{outcome, at, resultVersion?, resultHash?, savedAs?}`. Confirmed requires resultVersion/resultHash; conflict requires `savedAs`; resultVersion/resultHash travel together; `savedAs` is a bounded relative path. |
| `createdAt`, `updatedAt` | yes | UTC ISO timestamps. |

`prepared` has neither intent nor receipt; `publish-intent` has an intent and no receipt; terminal
phases require a receipt whose outcome equals the phase. Exact intended serialized bytes and the
publish intent are durable before one checked commit. A receipt records the actual observation,
separately from catalog/thread/accounting projection. An uncertain intent is never replayed; finding
the exact intended bytes means the intended result was observed, not that writer identity is proven.

### `questions/<questionId>.json` — checked question and answer

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `base`, `generation` | yes | `kind:"question"`, `id:"question_…"`. |
| `keys` | yes | 1–256 unique safe-ID impact keys. |
| `affected` | yes | Up to 1,024 unique safe task IDs; unknown dependency impact is conservative. |
| `characterId` | yes | `null` or a safe character ID. |
| `evidence` | yes | Up to 64 `artifact`/`context` references; source chapter evidence lives in the context manifest. |
| `options` | yes | Up to 16 strict `{id, label, consequence}` objects; label at most 200 units/800 bytes, consequence at most 2,000 units/8,192 bytes; IDs unique. |
| `state` | yes | `open`, `answered`, `superseded` or `withdrawn`. |
| `answer` | yes | `null`, or strict `{exactText, confirmedText, direction, answeredAt}`. Exact and confirmed text are each at most 262,144 units/bytes; direction is a same-owner reference; answeredAt is UTC ISO. Non-null exactly when `state` is `answered`. |
| `createdAt`, `updatedAt` | yes | UTC ISO timestamps. |

Silence or dismissal never answers. A stale question revision refuses. A confirmed answer creates a
new immutable direction; affected publication gates close synchronously and dependent attempts are
invalidated. Provably independent work may keep its captured direction.

### Artifacts — immutable body plus metadata

`artifacts/<artifactId>.meta.json` is a strict `artifact` record:

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision` | yes | `kind:"artifact"`, `id:"artifact_…"`, `revision:1`; no `base` or `generation`. |
| `mediaType` | yes | `text/markdown` or `application/json`. |
| `bytes` | yes | 0–1,048,576; exact body byte count. |
| `hash` | yes | Lowercase SHA-256 of the exact body bytes. |
| `role` | yes | The accepted role that produced the candidate. |
| `producedBy` | yes | Same-owner `attempt` reference. |
| `createdAt` | yes | UTC ISO timestamp. |

The body is `artifacts/<artifactId>.md` for Markdown or `artifacts/<artifactId>.json` for JSON. A JSON
body is an ordinary candidate document, not a workflow record and not an envelope. Artifact references
hash the body bytes, not the metadata file. Both files are immutable. Missing, unreadable or
metadata/body hash-mismatched artifacts cannot be used; they are never rewritten or guessed.
Standalone reads distinguish `unavailable` (missing components or unknown semantics) from `corrupt`
(malformed known values or mismatching bytes/hashes). Creation and current no-op confirmation require
the final metadata and body bytes/hashes to match the intended pair exactly. A different internally
valid pair, missing/corrupt components or an I/O failure at that final read is `uncertain`, never
successful or automatically retried. Keep the intended candidate and inspect the artifact files.

### `contexts/<contextId>.json` — immutable captured-source manifest

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision` | yes | `kind:"context"`, `id:"context_…"`, `revision:1`; no `base` or `generation`. |
| `sources` | yes | 0–64 same-owner `brief`, `phase-plan`, `direction` or `artifact` references. |
| `chapters` | yes | 0–64 strict `{chapterId, version, hash}` entries; version is positive, hash is the saved chapter's raw SHA-256. |
| `envelopeDigest` | yes | Lowercase SHA-256 of the exact canonical context envelope. |
| `bytes` | yes | 0–2,500,000; exact serialized envelope bytes. |
| `createdAt` | yes | UTC ISO timestamp. |

At least one source or chapter is required. The manifest embeds no source body and accepts no
unselected content. The host builds the attempt's captured prompt only from these exact references;
a changed, missing or foreign source makes the attempt stale or unavailable rather than widening the
scope.

### `admission/reservations/<reservationId>.json` — checked reservation

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `base`, `generation` | yes | `kind:"reservation"`, `id:"reservation_…"`. |
| `request` | yes | Strict request object described below. |
| `phase` | yes | `reserved`, `dispatched`, `uncertain`, `settled` or `released`. |
| `receipt` | yes | `null`, or strict `{id, outcome, accounting}` with outcome `succeeded`/`failed`/`stopped` and the accounting union above. `released` has no receipt; `settled` requires one. |
| `createdAt`, `updatedAt` | yes | UTC ISO timestamps. |

The request is exactly `{policyDigest, attempt, role, destination, requestDigest, inputDigest,
directionDigest, reviewDigest, scopeId, localRevision, globalRevision, callIndex, localReads,
outputTokens, outputBytes, maximum}`. Digests are lowercase SHA-256; the attempt is same-owner; role
is one of the accepted seven; destination is strict; scopeId is safe; localRevision is 0–2,
globalRevision 0–1, callIndex 1–4, localReads 0–8, outputTokens 1 through the role ceiling, and
outputBytes 1–262,144. `maximum` is `null` or exactly `{qualificationId, enforcement:
"provider-all-charge", hostQualified:true, tariffKnown:true, connectionId, requestDigest, policyDigest,
microUsd}`; its request/connection/policy digests and IDs must bind the request, and microUsd is a
positive safe integer. The raw codec validates that internal binding; the immutable policy and
admission ledger enforce the mode: bounded operations require `maximum:null`, and strict money
requires the qualified maximum.

A reservation ID deduplicates its entire request, including after release; the same ID with a
different request refuses. Reservations are created and settled under the single host admission lock
and persisted before transport. Only a reservation known not to have crossed dispatch intent may be
released. Timeout, cancellation or uncertainty never releases a possible charge.

### `admission/observations/<sequence>-<observationId>.json` — append-only host observation

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `generation` | yes | `kind:"observation"`, `id:"observation_…"`, `revision:1`; no `base`. |
| `sequence` | yes | Positive safe integer, unique and contiguous from 1 across the run's observations. |
| `reservation` | yes | Same-owner `reservation` reference. |
| `type` | yes | `dispatch`, `known-unsent`, `uncertain` or `receipt`. |
| `at` | yes | UTC ISO timestamp. |
| `facts` | yes | `null`, or strict `{clock:{nowMs,activeMs}, gate:"open"|"closed", accountingDurable, otherHostActive, otherAccountActive, accountLimit}`; counts are nonnegative safe integers and accountLimit is 1–4. `dispatch` requires facts; the other types require null. |
| `receipt` | yes | `null`, or the strict reservation receipt. `receipt` requires it; other types require null. |

Observations are append-only host facts, never worker claims. They are ordered by `sequence` and
never rewritten. A receipt observation does not prove exactly-once provider execution or charging.

### `admission/accounting.json` — checked accounting summary input

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `base`, `generation` | yes | `kind:"accounting"`, `id:"accounting_…"`. |
| `summary` | yes | Strict `{knownSubtotalMicroUsd, unknownCalls, partialCalls, pendingCalls, reservedMicroUsd, consumedCalls}`; all nonnegative safe integers, pending calls 0–4, consumed calls 0–600, and `unknownCalls + partialCalls <= consumedCalls`. |
| `clock` | yes | Strict `{nowMs, activeMs}` nonnegative safe integers. |
| `enforcementViolated` | yes | Boolean; true closes future admission after a receipt exceeds its qualified maximum. |
| `updatedAt` | yes | UTC ISO timestamp. |

Known subtotal, unknown/partial calls, pending calls and reserved maxima remain distinct. Unknown cost
is never reported as zero. The summary is derived from reservations/observations but is a checked
durable input; a failed accounting persistence closes dependent admission and never relabels saved
prose.

### `adoptions/<receiptId>.json` — recorded adoption receipt

A beside-store record (`packages/core/src/workflow/adoption-receipt-store.ts`), not a schema-1
codec kind. The pure contract is `packages/core/src/authoring/adoption-receipt.ts`. It is the
recorded state that distinguishes a coordinator-adopted chapter from any other saved chapter
(FR-017); only the Library publisher writes it, through `LibraryService.adoptionReceipts` and
`recordConfirmedAdoptionReceipt` at a confirmed effect (see below).

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id` | yes | `schemaVersion: 1`, `kind:"adoption-receipt"`, `id:"adoption_…"`; `owner` is the adopting run owner. No `revision`, `base` or `generation`. |
| `chapterId` | yes | Safe chapter ID the candidate was adopted into. |
| `candidate` | yes | Exact `artifact` reference; its hash is the body SHA-256. |
| `resultVersion`, `resultHash` | yes | Published chapter version (positive) and raw-file SHA-256, as the effect receipt names them. |
| `grant`, `direction` | yes | Same-owner `grant` and `direction` references, validated by the authoring validators. |
| `sequence`, `adoptedAt` | yes | Caller-supplied ordering: sequence 1–1,000,000 and millisecond UTC instant. No clock is read on validation. |

Bytes are the canonical compact sorted-key form (262,144-byte bound), re-parsed before
publication and verified byte-exact on readback. Creation is strictly absent-only per candidate
artifact: an existing receipt for that candidate (or sequence) refuses and keeps a conflict copy;
foreign book/run receipts refuse on read and list. Listing is bounded (page at most 256, at most
10,000 per run) and ordered by sequence. The pure counter counts distinct `chapterId`s strictly
after an exclusive sequence/adopted-at marker; this format does not wire counting into any host.

The publisher sequence is allocated by the Library publisher inside the per-book queue as one
past the maximum sequence read from this store in the same queue hold. A retried confirmation
is recognised by owner, chapter, exact candidate, result version/hash, grant and direction, and
returns the stored receipt instead of creating a second one; an uncertain publisher write is
reported recorded only after byte-exact read-back.

### Size, count and depth bounds

| Bound | Value |
| --- | --- |
| Raw JSON nesting | 64 value wrappers |
| `run.json` | 2,500,000 UTF-8 bytes |
| `plans/<planId>.json` | 2,500,000 UTF-8 bytes |
| Every other record | 262,144 UTF-8 bytes |
| Artifact body | 1,048,576 bytes |
| Context envelope | 2,500,000 bytes |
| Tasks per phase plan | 1,024 |
| Queued task references in `run.json` | 64 |
| Materialized reservation references in `run.json` | 4 |
| Impact keys per task/question | 256 |
| Attempt outputs | 64 |
| Attempt calls / local reads | 4 / 8 |
| Context sources / chapters | 64 / 64 |
| Question options | 16 |
| Journal page size | 256 |

All intersecting limits apply. The desktop and browser Library adapters enforce workflow-path byte
ceilings during the actual read, including checked-commit comparisons and readbacks; an earlier
size check alone is not sufficient. Drift scans, write notes, the desktop watcher and copy fallbacks
also use the applicable limit, including for workflow files under whole-book trash. The tighter of a
caller's bound and the path's bound applies. The adapter refuses an over-limit value without returning
partial bytes; it never truncates or deletes the file. A readback failure after a possible publication
is uncertain, not proof that no write occurred, and is not automatically replayed. The 2,500,000-byte
context-envelope limit above is a format/host requirement; storing or verifying the separate envelope
is not implemented by the T023 context-manifest store.

### Ordering, retention and related-file recovery

- Commands and observations are ordered by their positive `sequence`; journal pages are ordered by
  `firstSequence` and never overlap or gap. Tasks, attempts, effects, questions, directions and
  artifacts are listed by their host-issued IDs and `createdAt`/revision metadata, never by filename
  identity or a worker-supplied path.
- There is no automatic pruning, expiry, compaction or count quota. Archive and whole-book trash carry
  the entire `workflows/<runId>/` folder, including unavailable records and conflict copies. Host
  permission is outside the library/archive and is not carried by a book copy.
- A checked write validates the actual owning book/run, the complete intended bytes, the exact
  absence/base hash **and** revision, then commits one file. Only a current semantic no-op writes
  nothing. A stale, missing or racing base preserves the complete intended record under
  `books/<bookId>/workflows/<runId>/conflicts/<kind>.<id>.conflict-<external-edit|missing-file>.<deviceId>.<timestamp>[-N].json`.
  This kind/identity convention replaces the earlier unspecified relative-name flattening. Full
  owner and record identity remain inside the copy. ASCII filenames are at most 200 bytes, reserving
  room for the atomic writer's temporary suffix; a longer name becomes
  `<kind>.conflict-<reason>.<first-12-hex-SHA256-of-id>[-N].json`. Up to 100 absent-only names are tried
  (no suffix, then `-2` through `-100`), never replacing an existing copy.
  The copy adds reserved `conflictMetadata`: `reason` is `external-edit` or `missing-file`;
  `baseline` is the original `{kind:"sha256",value,revision}` or `{kind:"absent",revision:0}`;
  `observed` is `{kind:"sha256",value}` or `{kind:"absent"}`. The whole copy is bounded to
  5,000,000 bytes. An active write or read refuses any own `conflictMetadata` field; explicit recovery
  must remove its copy-only context and create a fresh reviewed edit.
  Artifact conflicts retain an exact body first under `artifact.<id>.body.conflict-<reason>.<deviceId>.<timestamp>[-N].md|json`
  (or `artifact.body.conflict-<reason>.<id-digest>[-N].md|json` under the same name limit), then metadata.
  Metadata `conflictMetadata.bodyCopy` names that body's library-relative conflict path; its original
  artifact `bytes`, `hash` and `mediaType` verify the body independently of either filename. The
  reported `savedAs` is the metadata copy. If metadata fails, the body copy remains for recovery;
  partial copies are never automatically completed or deleted. A copy or active write can be
  uncertain after an adapter error or mismatching readback: report `uncertain`, keep the draft,
  reread storage and never replay automatically.
- Cross-file changes are recoverable sequences, not transactions. A missing, foreign, stale or
  unavailable related plan/task/attempt/effect/question/artifact/context/permission makes the
  dependent record unavailable; it never silently drops, rewrites, prunes or replays it. Persist
  dispatch/publish intent before crossing the boundary; persist the actual observation before any
  projection. A failed projection never invites another write. Default restart performs local
  recovery and requires Continue; an uncertain attempt or publication is never blindly replayed.
- In-memory run/admission snapshots are aggregates across these records. **They are never written as a
  wholesale `run.json`**, never used as a wire record and never assumed to fit a per-file bound.

## Host permission descriptor (schema 1)

D-194–D-196 / [ADR 0019](adr/0019-bounded-autonomous-authoring.md) keep host permission outside the
library and the archive. This section specifies that schema-1 descriptor. It is **not** a file under
`books/<bookId>/workflows/<runId>/`, it is not library content, and it does not travel in a folder
copy, portable archive, or whole-book trash. The workflow schema above still does not authorize host
permission.

This section does not authorize a scheduler, a provider call, publication, storage, or execution.
A copied descriptor is not execution permission. Decoding one does not grant it. The pure codec is
`packages/core/src/authoring/host-permission.ts`. It performs no I/O, reads no clock, and writes no
file. No writer, path, or host resume is specified here.

### Record

The descriptor is a closed object. Extra keys are refused, including inside `owner`. There is no
prose, path, URL, body, or credential field, and unknown fields are not preserved. A missing field
refuses. Any `schemaVersion` other than `1` refuses and is not migrated or rewritten.

| Field | Rule |
| --- | --- |
| `schemaVersion` | Exactly `1`. |
| `kind` | Exactly `host-permission`. |
| `id` | Portable id with prefix `permit_`. |
| `owner` | `{ libraryRegistration, bookId, runId }`, equal to the owner the caller expects. A mismatch is `foreign-owner`. |
| `hostId` | Opaque host id. Not a path, username, or credential. A mismatch with the caller-expected host is `foreign-host`. |
| `policyDigest` | Lowercase SHA-256, 64 hexadecimal digits. |
| `generation` | Positive safe integer, at least 1. |
| `expiresAt` | UTC instant with exactly millisecond precision: `YYYY-MM-DDTHH:mm:ss.sssZ`. |
| `revocation` | `none`, `revoked`, or `persist-failed`. |
| `resume` | `continue` or `same-host`. |

### Bytes

A descriptor is UTF-8 with no byte-order mark and at most 4,096 exact input bytes. Over-limit input
is refused before parsing. Duplicate keys, invalid UTF-8, lone surrogates, `NaN`, `Infinity`, `-0`,
and lossy numbers refuse, and no partial record is returned. Canonical bytes are compact JSON: object
keys sorted by UTF-16 code-unit order, no insignificant whitespace, and no trailing newline. Encode
does not write a file.

When the caller supplies an expected hash, it is the SHA-256 of those exact input bytes, not of a
rewritten canonical copy. A mismatch is refused as `changed` and the bytes are not rewritten. Omitting
the hash makes no claim that the bytes are unchanged.

### Reader

The reader is separate from a successful decode. It is not an execution grant: it never returns
`execute`, `authorized`, or `permission`. Expiry uses a caller-supplied instant in milliseconds.
`nowMs >= expiresAt` is expired. An earlier instant is unexpired. The codec does not read a clock.
Revocation is decided before expiry. A foreign host or owner is refused by decode, before this reader.

| Condition | Result |
| --- | --- |
| `revocation` is `revoked` | `{ outcome: "refused", reason: "revoked" }` |
| `revocation` is `persist-failed` | `{ outcome: "refused", reason: "revoke-persist-failed" }`, even when `resume` is `same-host`. Auto-resume stays disabled. |
| expired | `{ outcome: "refused", reason: "expired" }` |
| `resume` is `continue`, and the descriptor is otherwise unexpired and unrevoked on the expected host and owner | `{ outcome: "continue-required" }` |
| `resume` is `same-host`, `revocation` is `none`, unexpired, expected host and owner | `{ outcome: "fresh-work-only" }` |

`continue-required` is the default. It is not auto-resume and not execution permission.
`fresh-work-only` describes only safe fresh work. It does not retry an uncertain attempt or an
ambiguous effect.

## Saved review records (schema 1)

D-199 and the revised D-171 / [ADR 0020](adr/0020-inline-editorial-review.md) select explicit,
recoverable saved review reports. This section specifies the schema-1 records under
`books/<bookId>/reviews/`. The pure codec is
`packages/core/src/review/record-{json,format}.ts`; the only checked writer is
`packages/core/src/review/record-store.ts`, constructed as `LibraryService.reviewRecords`. No report
is written unless the author explicitly saves one. The validated desktop/browser API and Workspace
support inspection, checked dispositions and confirmed recovery. Provider wiring,
export/archive mounting, campaign execution, suggestion application and
independent exact-head review remain separate delivery work. T014 and T015 stay unchecked.
This section and its writer/recovery rules apply to schema 1 only. Schema 2 is a distinct, accepted
continuation format with partial pure codec leaves, specified [below](#saved-campaign-continuation-manifest-schema-2-segment-and-intent-schema-1).

### Layout and kinds

| Path under `reviews/` | `kind` | Mutability |
| --- | --- | --- |
| `<runId>.json` | `review-report` | Immutable, revision 1, absent-only. |
| `dispositions/<runId>.json` | `review-dispositions` | Checked revision. |
| `profiles/<profileId>.json` | `reader-profile-record` | Checked revision; author lenses only. |
| `campaigns/<campaignId>.json` | `review-campaign` | Checked revision. |

`id` is the record's own identity and exactly the file stem. It must be a portable file name:
letters, digits, dot, dash or underscore; no path separator, no `..`, no trailing dot. `owner` is
exactly `{ "bookId": … }` and must equal the folder's actual `book.json` ID. A report may name up to
four books but lives in one of them. Conflict copies live in the book-level `conflicts/` folder and
are never active records.

### Common encoding, identity and bounds

- **Exact bytes.** A saved record is UTF-8 with no byte-order mark. New checked writes use compact
  canonical JSON: object keys sorted by UTF-16 code-unit order, no insignificant whitespace and no
  trailing newline. The record's raw SHA-256 is over those exact file bytes. A reader accepts any
  valid JSON spelling for inspection; a checked writer commits only canonical bytes it has itself
  read back.
- **Plain JSON only.** No comments, trailing commas, `NaN`, `Infinity`, `-0`, duplicate member names,
  lone surrogates, getters, `toJSON`, sparse arrays or foreign prototypes. Strings are never trimmed
  or Unicode-normalized. A numeric token must round-trip exactly through its `Number` spelling and
  may not exceed `Number.MAX_SAFE_INTEGER`; `9007199254740993`, `1.0000000000000001`, `1e400` and
  `-0` are refused.
- **Schema and identity.** Every record has `schemaVersion: 1`, `kind`, `owner`, `id` and `revision`.
  A newer `schemaVersion` is refused with an "update the app" error. An unknown member of a closed
  semantic union (report kind, claim, category, evidence state, disposition state/action, campaign or
  stage status, lens origin, tool name) makes the file read-only `unsupported`; it is never
  relabelled or rewritten.
- **Checked revision.** `review-dispositions`, `reader-profile-record` and `review-campaign` carry
  `base`. Revision 1 requires exactly `{ "kind": "absent", "revision": 0 }`; revision `n > 1` requires
  exactly `{ "kind": "sha256", "value": <previous raw hash>, "revision": n-1 }`. A stale, absent or
  mismatched base refuses and keeps a conflict copy.
- **Unknown fields.** Fields listed here are known fields. Any other plain JSON field is a supported
  extension and survives read-modify-write at every depth, including `__proto__` as ordinary data.
  Control objects (`owner`, `base`, `report`, `analyzer`, `disclosure`, `coverage`, `plan`, stage
  `report` references) reject extras. A saved report is immutable, so its unknown fields are only
  read back; they are never rewritten.
- **Timestamps.** `savedAt`, `createdAt`, `updatedAt` and `at` are UTC ISO 8601 with exactly
  millisecond precision, for example `2026-11-07T12:05:00.000Z`. The run's own `startedAt` and
  `completedAt` keep the ISO 8601 spelling the run recorded.
- **Bounds.** All intersecting limits apply, and reads check the byte count before parsing.

| Bound | Value |
| --- | --- |
| Every document, including unknown fields | 2,500,000 UTF-8 bytes |
| Raw JSON nesting | 64 value wrappers |
| Books per report | 4 |
| Sources per report | 64 |
| Selected segments per chapter source | 64 |
| Findings per report | 50 |
| Evidence items per finding / withheld entries | 8 / 8 |
| Quote scalars per citation | 500 |
| Interpretation scalars per finding | 2,000 |
| Disposition findings / events per finding | 50 / 200 |
| Campaign sources / stages / synthesis entries | 64 / 64 / 64 |
| Planned spans per campaign source | 64 |
| Report list page | 1–200, default 50 |

The report also records the accepted envelope's aggregate facts: `sourceBytes` at most 65,536,
`contentBytes` at most 131,072, and `items` at most 64.

### `<runId>.json` — immutable report

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `reportKind` | yes | `kind:"review-report"`, `revision:1`, `reportKind:"reader-review"`, `id` = the run ID. No `base`. |
| `run` | yes | `{ startedAt, completedAt }` from the volatile run. |
| `savedAt` | yes | Explicit save time, not the run time. |
| `analyzer` | yes | `{ provider, model, endpointIdentity }`; provider/model attribution only, never a credential or endpoint URL. |
| `profile` | yes | Complete reader-lens snapshot used by the run: `name`, `purpose`, `focus`, `guidance`, `id`, `origin`, `version`, `digest`. A built-in lens is stored here and needs no `profiles/` file. |
| `books` | yes | 1–4 `{ bookId, title, consentRevision, termsRevision, enabledTools }`; the source books and no others. The owning book in `owner.bookId` must be one of them. |
| `disclosure` | yes | `{ contractVersion:1, requestId, scopeDigest, capturedAt, promptDigest, priorFeedback:{count, digest} }`. The prompt and feedback text are not retained; their digests keep input-change attribution. |
| `sources` | yes | Ordered source coverage, below. No source body text. |
| `coverage` | yes | `{ books, sources, items, sourceBytes, contentBytes }`; counts must equal the arrays, `items` is at most 64, and byte sums must match with `contentBytes >= sourceBytes`. |
| `findings` | yes | 0–50 bounded findings, below. |
| `verification` | yes | `"verified-at-capture"`. Currentness is computed at read/export time and is never stored as a claim. |

A chapter source coverage entry is `{ kind:"chapter", sourceId, bookId, chapterId, bookTitle, title,
position, version, hash, capturedAt, bodyLength, segments:[{start,end}], bytes, selectedScalars }`.
A Story Bible entry is `{ kind:"story-bible", sourceId, bookId, bookTitle, label, field, capturedAt,
containingFileHash, valueDigest, length, bytes, selectedScalars }`. `segments` are ordered,
non-overlapping half-open UTF-16 ranges; `bytes` counts the selected UTF-8 bytes and
`selectedScalars` the selected Unicode scalar values.

A finding is `{ findingId, category, readerId, readerVersion, runId, interpretation, subjective:true,
claim, evidence:[{citation,label}], invalidEvidence:[{index,reason}], evidenceState }`. Every citation
echoes its captured source identity and exact UTF-16 range, and `quote` is at most 500 scalar values.
The reader checks, without the source bodies, that the citation names a captured source/revision,
lies inside a selected range, has `quote.length === end - start`, and that `evidenceState` is exactly
what its evidence supports. It cannot re-prove the quoted text itself: a saved report is
`verified-at-capture`, not a fresh verification. `invalidEvidence` keeps the withheld index and a
bounded reason (`shape`, `source`, `revision`, `range`, `quote`) and never becomes a quotation.

A report conflict receipt asserts a kept copy only after the store verifies the full intended
report against its named copy and the handler independently reads that copy through the owning
book's queue. Both transport edges reconstruct the report from the validated submitted run and the
copy's `savedAt`, check its complete content, hash and conflict metadata, and bind the name to that
book's report-conflict folder. The receiver also requests a separate, scoped readback of those same
named bytes; a missing, different, unreadable or otherwise unverifiable copy yields **uncertain**,
not a kept-copy claim or an automatic retry. This narrow readback is not an arbitrary path API. These
checks bind the observed bytes to the submitted intent; they do not authenticate an arbitrarily
forged transport or guarantee that an external writer cannot later change the file.

After an uncertain report save, the result stays visible and another submission remains locked
across equivalent run/API wrapper reconstruction. The same bound view must inspect the current saved
report or an issue-free absence listing before the author can explicitly acknowledge the inspection
and allow another save. A listing of absence is not proof that no copy exists; the author is also
directed to inspect the conflicts folder. Real run, book, Library or view lifetime changes retire
old replies rather than relabelling the new view.

### `dispositions/<runId>.json` — checked author state

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `base` | yes | `kind:"review-dispositions"`, `id` = the run ID. |
| `report` | yes | `{ runId, hash, completedAt }`; `runId` equals `id` and `hash` is the owning report's exact raw hash. |
| `dispositions` | yes | 1–50 entries, ordered by `findingId`. |
| `createdAt`, `updatedAt` | yes | First and latest event time. |

An entry is `{ findingId, state, updatedAt, events }`, where `state` is `open`, `ignored`,
`author-resolved` or `reopened`. Events are append-only, ordered by `sequence` starting at 1, with
non-decreasing `at`, `from` equal to the previous `to` (`null` for the first), and an `action` of
`set`, `ignore`, `resolve` or `reopen` matching the new state. An event may carry an optional `note`
of at most 2,000 Unicode scalar values; it is part of the append-only history. `updatedAt` must equal
the last event's `at`. A request that repeats the current state with no note is a read, not a write.
An untouched blank note in the connected editor is absent; an explicitly entered note, including an
empty string or whitespace, is present and preserved exactly. If a confirmed save supersedes the
baseline of retained newer typing or another draft on the same report, that draft stays blocked until
the author explicitly adopts the inspected saved history. An unconfirmed save first requires a fresh
inspection, and blocks existing or newly typed drafts on other findings until they adopt that history;
retaining a draft is not permission to replay its previous note automatically.
Disposition is independent of freshness: a rerun never resolves or relabels an earlier finding.
The writer checks that the finding exists in the saved report and that the report hash has not
changed. The connected checked command supplies the inspected report raw JSON/hash and an absent
disposition baseline or its exact raw JSON/hash/revision. Under the one Library queue, the writer
validates both snapshots and constructs the complete intended history from that baseline, never
from a newer active file. Missing/competing/replaced bases keep that intended history and change in
a checked conflict copy, including supported unknown own fields. Invalid snapshots/findings refuse.
The receiver reconstructs the complete intended output using the returned event time and compares
all fields. Checked disposition conflict receipts include the verified copy bytes/hash and event
time; both transport edges reconstruct the intended history, verify its conflict metadata and bind
the copy location to the owning book. An external report change during publication is uncertain,
not saved success. Raw report/baseline JSON stays bounded by the existing per-record ceiling;
the transport permits up to 32,100,000 serialized request bytes (two records plus worst-case JSON
escaping), with 100,000 bytes of reply-envelope headroom. Volatile run inputs retain their separate
1,000,000-byte transport bound. Neither limit changes the saved-record or provider-request bounds.

### `profiles/<profileId>.json` — checked author lens

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `base` | yes | `kind:"reader-profile-record"`, `id` = the lens ID. |
| `profile` | yes | A complete author lens with a verified digest. `profile.id` equals `id`; `origin` is `author`; built-in lenses need no file. |
| `createdAt`, `updatedAt` | yes | Record timestamps. |

The record revision counts saves; the lens `version` counts content lineage and advances by exactly
one per edited lens. An identical lens is an unchanged read. Unknown root fields survive; the lens
object itself is closed, so an unknown member inside it makes the file unsupported rather than being
silently dropped.

### `campaigns/<campaignId>.json` — checked manifest

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion`, `kind`, `owner`, `id`, `revision`, `base` | yes | `kind:"review-campaign"`. |
| `status` | yes | `planned`, `running`, `incomplete` or `complete`. |
| `profile` | yes | `{ id, version, digest }`; a built-in lens is verified against the fixed lens, an author lens against its saved record. |
| `plan` | yes | `{ plannedAt, sources, items, sourceBytes }`; counts must equal the source array and its planned spans. |
| `sources` | yes | 1–64 `{ sourceId, bookId, chapterId, title, position, version, hash, planned:[spans] }`. |
| `stages` | yes | 1–64 `{ stageId, kind, sourceIds, planned, status, report, at }`. `report` is `{runId,hash}` or `null`. |
| `synthesis` | yes | 0–64 `{ stageId, sourceStageIds, report }`; one entry per synthesis stage, `report` is `{runId,hash}` or `null`. |
| `createdAt`, `updatedAt` | yes | Record timestamps. |

A range stage plans at least one span; a synthesis stage plans none. An unfinished synthesis
description has `report: null`; once its stage completes, the description must name the stage's exact
saved report. A completed stage names its saved report, and a completed campaign has no open stage. Each report reference resolves to an
immutable report in the same owning book whose hash matches; a missing or different report refuses.
The manifest embeds no reports and grants no execution authority: scheduling, attempts, budgets and
retries belong to 037.

### Writer, conflicts, trash and restore

- **One writer.** Every read-modify-write runs inside `LibraryService`'s per-book queue and every
  commit uses the service's journal-aware checked writer. The review codec has no filesystem access
  and the store never calls an adapter commit directly.
- **Reports are absent-only.** Creating a report uses an absent expectation. Same-ID, byte-equal
  content is an idempotent read; different bytes keep the intended report as a conflict copy and
  replace nothing. A report is never revised in place.
- **Checked updates.** The intended bytes are validated and re-parsed by this build's own reader
  before the commit, then committed against the exact previous raw hash and revision. A mismatch, a
  missing file or a racing writer keeps the complete intended record under
  `books/<bookId>/conflicts/<kind>.<id>.conflict-<external-edit|missing-file>.<deviceId>.<timestamp>[-N].json`
  and reports where it went. The copy adds a reserved `conflictMetadata` object (`reason`,
  `baseline`, `observed`) and is bounded by the same 2,500,000 bytes. Colliding names use absent-only
  suffixes. A long record ID cannot overflow the filesystem name limit: a readable name is used when
  it fits, otherwise `<kind>.conflict-<reason>.<id digest>[-N].json` is used and the complete identity
  remains inside the document. A copy cannot be read as an active record.
- **Readback.** After every write the exact bytes and SHA-256 are compared with the intended bytes.
  A mismatch or an adapter error after publication is reported as `uncertain`, never as success and
  never replayed automatically.
- **Deletion.** Trashing a report moves the report and its dispositions together into
  `.studio/trash/<bookId>/reviews/<stamp>[-N]/`, preserving their relative names. Profiles and
  campaigns use the same group shape. A destination collision gets the next suffix; nothing is
  unlinked. Restore requires both active destinations to be absent, re-verifies each record's
  identity and the disposition's owning report hash, and verifies the bytes after the move. A
  pre-move refusal leaves every file where it was. Multi-file moves are not a transaction: after a
  move is attempted, any exception or mismatched readback is uncertain, and already moved files
  stay recoverable. No rollback, automatic replay or cleanup deletes recovery material.
- **Connected recovery confirmation.** Active-group and trash-group inspection returns the exact
  report/disposition bytes, an identity/content digest and a host-issued one-use token. Trash group
  IDs are single portable components, never renderer paths. At most 64 inspections are retained
  per store; eviction expires permission only, never files. Confirmation consumes the token before
  mutation in the existing queue and rechecks every hash, absent member and group membership.
  Copying an inspected snapshot or digest cannot mint permission. Confirmed results echo the exact
  group identity/content; malformed receipts are uncertain. Every move checks source and free
  destination immediately before moving and verifies source absence/destination bytes afterwards.
  External filesystem writers are not locked by the Library queue; a race during a primitive move
  may leave partial/uncertain results and requires fresh inspection, never a success claim.
  A partially trashed disposition-only group may restore beside its exact inspected active report;
  that dependency is included in the digest and rechecked. All moved destinations must be free.
  Unknown/future/corrupt records or unexpected group members remain unavailable and untouched.
  Trash lists page at most 50 nonempty groups; unsupported names remain visible as unavailable.
- **No pruning.** There is no automatic deletion, eviction, expiry, quota, compaction or trimming.
  Trashing is the author's explicit action; a full document refuses rather than losing history.
- **Listing.** `reviews/*.json` is listed newest `completedAt` first (compared as instants, since the
  original offset spelling is preserved), then by ID, with offset/limit paging (1–200). An unreadable, newer or unsupported file is reported as a named issue and left
  untouched. Nothing in a list or read writes.
- **Continuation gap.** Segmented occurrence/disposition continuation remains unspecified. The
  accepted campaign format below now has a checked storage slice for one campaign, but no host
  integration. A document over any bound or count refuses with the draft retained; no writer
  trims history to fit. T015 remains partial until export/archive and independent review are
  delivered.

## Saved campaign continuation (manifest schema 2; segment and intent schema 1)

D-201 / [ADR 0020](adr/0020-inline-editorial-review.md#d-201-conditional-campaign-continuation)
accepts the complete field-level [campaign continuation format](formats/campaign-continuation.md),
including its canonical bytes, four external-hole paths, bounds, integrity, compatible-planner,
publication and recovery rules. That linked document is normative. It reserves new immutable segment,
publication-intent and group-intent records and a distinct `review-campaign` schema 2 at the existing
campaign path. A schema-1 reader must refuse version 2, not reinterpret it; a future version-dispatching
reader retains schema 1 under its own rules. Ordinary request, report, disposition, profile and 032
history rules are unchanged.

Pure in-memory leaves construct bounded candidates and inspect/reconstruct untrusted wire data. Exact
comparison requires a separately supplied locally provenanced plan; no decoded object gains planner
provenance. Structural reconstruction alone does not validate all plan semantics or source files.
A pure compatible-replan leaf dispatches on recorded planner semantics, validates explicitly supplied
raw current or historical sources within the format's read bounds, replans through the real planner
and accepts only its complete canonical match; differing compatible semantics are never served
unchanged. A checked storage slice (`LibraryService.campaignContinuations`) now provides the
version-dispatching storage reader, intent-first publication with genuine no-replace segment
creation and verified manifest readback, and explicit recovery classification for one campaign;
adapters without proven no-replace creation refuse publication. The same store now also moves
a whole campaign group (manifest, segment directory and publication-intent directory) to and
from `.studio/trash/<owner>/reviews/campaign-<groupId>/` under an immutable
`review-campaign-group-intent` in `reviews/campaign-moves/`: version dispatch and full wire
verification happen at the source, inventories and destination absence are preflighted under
the format's scan bounds, segments and intents move before the manifest, and a move that
cannot preserve every checked reference refuses before the first move while a later failure
is uncertain with both locations retained. Checkpoint reports resolve only from their recorded
owner's ordinary report path: the recorded owner wins, a verified foreign report is a bounded
foreign reference that is never adopted, merged or dropped, and a missing or changed report
stays unavailable. The same store now also moves the fixed-history group (the owner book's
entire 032 `history/` tree plus the campaign's segment directory, publication-intent
directory and manifest) to and from the same trash base under an immutable
`review-campaign-fixed-history-intent` in `reviews/fixed-history-moves/`: manifest dispatch
and wire verification plus per-record 032 dispatch and bounded inventories are preflighted
before the first move, history moves first with the manifest last, and partial groups
inspect as `partial`, never complete. No host integration, portable archive/export workflow
or general adapter qualification is implemented or independently accepted. Exact
continuation remains conditional on matching external values and compatible planner provenance;
missing values remain unavailable. 039 T014/T017/T018 and T015 remain open.

## `book.json`

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | number | Currently `1`. Files with a newer number are refused with an "update the app" error. |
| `id` | string | `book_` + 16 hex characters. Matches the folder name. Never reuse. |
| `title` | string | Shown in the library. May be empty while the author is still deciding. |
| `workingTitle` | string | Optional alternate title. |
| `description` | string | One-line premise. |
| `genres` | string[] | Free-form. |
| `influences` | string[] | Style influences, shown in the Story Bible. |
| `isErotica` | boolean | Gates explicit-content affordances. |
| `chapterRange` | `{ minimum, maximum }` | Planned length. |
| `outline` | string | Markdown outline of the whole book. |
| `storyArc` | object | `beginning`, `middle`, `end`, each with `overview`, `keyMoments` and `openQuestions`: text, one line per item. An array of strings, the shape this page once described, is read as one line per item and stays an array on disk until that part is edited. |
| `characters` | array | `id` (`char_…`), `name`, `role`, `description`, `motivations`, `notes`. |
| `memories` | array | `id` (`mem_…`), `text` (≤180 chars by convention), `importance`, timestamps. |
| `stage` | `onboarding` \| `drafting` | Setup or writing. |
| `settings.manuscript` | object | Export typography: `bodyFont`, `bodyFontSize`, `firstLineIndent`, `lineSpacing`, `chapterTitleAlignment`, `includeTableOfContents`, `preserveLineBreaks`. |
| `settings.agent` | object | Agent behavior: `disabledTools` (withdrawn tool names), `skillsEnabled`, `tone` (free text, at most 500 characters, empty means none), `answerLength` (`brief`, `standard` or `detailed`). Older books gain the defaults on read. |
| `defaultProvider` | string \| null | Provider chosen for this book (`openrouter`, `openai`, `anthropic`, `gemini`, `meta`), or `null` when not chosen. Older books gain `null` on read. |
| `defaultConnectionId` | string \| null | A connection id such as `conn_…`. The secret lives in the app's protected storage, never here. |
| `defaultModelId` | string \| null | Model id as the provider names it. A model that disappears stays recorded and is shown as unavailable. |
| `allowContributorTraining` | boolean | Default `false`. Explicit consent to use a training-eligible model such as Muse Spark Contributor with this book. The model picker sets it; migrations never do. |
| `frontMatter` | record | Legacy free-form pages, keyed by page id (an earlier studio's subtitle, author, dedication and so on). Kept exactly as written and never exported; the Format dialog lists what it holds and converts it into `matter` only when the author asks (D-169). |
| `matter` | object, optional | Ordered front and back matter (D-169), below. Absent in older books. |
| `createdAt`, `updatedAt` | ISO 8601 | Written by the app. |

Unknown fields are preserved when a book is written, so a newer app can add fields without the
older one silently dropping them. That holds at every level: inside each character and memory, the
story arc and its three parts, `chapterRange` and every `settings` section, as well as at the top.

### Saving `book.json`

Several writers share `book.json`: the Story Bible, the book and format settings, the model picker,
the agent's book tools, the `bookwriter` toolkit and other devices through a sync folder. It has no
`version`, so a save works field by field:

- The editor sends only the top-level fields it changed, each with the value it started from.
- The main process reads the file again under the book's write lock and merges each change onto that
  read. A field the editor did not change is never written. Unknown keys survive at every level, and
  a part nobody changed keeps the shape another writer gave it. The exception is a list of records
  that is written: each of its records is written in this build's shape, so a missing default such
  as `notes: ""` is filled in.
- Objects merge key by key. `characters` and `memories` merge record by record, by `id`, so an added
  memory and an edited character never collide. A record's `updatedAt` takes the later stamp.
- The default provider, connection and model (`defaultProvider`, `defaultConnectionId`,
  `defaultModelId`) are one choice. An editor that changes any of them sends all three, and if another
  writer changed any of them since the editor read, the file keeps all of their choice and the
  editor's whole choice goes to the copy, so a connection is never paired with a model it does not serve.
- The file is replaced atomically, and only while it is still the version that was read. If another
  writer got in between, the merge runs again on the new read.
- Where another writer changed the same part since the editor read it, the file keeps their value and
  the editor's whole version of the book is kept as
  `conflicts/book.conflict-external-edit.<deviceId>.<timestamp>.json`. The parts only the editor
  changed are saved as usual. The Story Bible says which fields overlapped and offers to show the copy;
  the agent's tools tell the model where the copy went. The copy is listed with the book's other
  conflict copies, so the workspace's saved-copies banner offers it too.

A caller with no earlier read, such as the import, replaces whole fields instead. It leaves every
part it did not change as it was written, and if the file changed while it was saving it keeps its
update as a conflict copy rather than writing over the change.

### Front and back matter

`matter` holds the pages around the chapters, in the order the author set:

```json
"matter": {
  "version": 3,
  "titlePage": true,
  "author": "Ana Reyes",
  "subtitle": "A tidewater tale",
  "sections": [
    { "id": "mat_3f9c2a1b7d4e", "kind": "copyright", "position": "front", "title": "", "text": "Copyright © 2026 Ana Reyes\nAll rights reserved." },
    { "id": "mat_8a1e0c55b2f9", "kind": "dedication", "position": "front", "title": "", "text": "For those who wait." },
    { "id": "mat_c41d7e9a0b36", "kind": "about-the-author", "position": "back", "title": "About the author", "text": "Ana lives by the sea." }
  ]
}
```

| Field | Notes |
| --- | --- |
| `version` | Incremented on every accepted save, like a chapter's `version`. |
| `titlePage` | Whether a generated title page (title, subtitle, author) opens every export. |
| `author`, `subtitle` | The title page's byline and second line, at most 300 characters each. |
| `sections[].id` | `mat_` + 6 to 40 letters, digits or hyphens; unique in the list. |
| `sections[].kind` | `copyright`, `disclaimer`, `dedication`, `epigraph`, `acknowledgements`, `about-the-author` or `other`. |
| `sections[].position` | `front` (before the chapters) or `back` (after them). |
| `sections[].title` | The page's heading, at most 200 characters; empty means the page shows none. |
| `sections[].text` | Markdown, at most 50,000 characters, set like a chapter body: a paragraph is a line. |

At most 40 sections. The app writes the front sections first, then the back ones, each side in the
author's order. Every export uses one order: the title page, the front sections, the contents page
when the book asks for one, the chapters, then the back sections. A book whose `matter` is absent,
`null`, or empty (title page on, no author, no subtitle, no sections) exports exactly as before
ordered matter existed, with the title and description on its title page. Once the matter holds
anything, the title page shows the title, subtitle and author, and the description stays out of
it (Word and EPUB files keep it in their metadata).

The app reads `matter` without stopping the book from opening: a value it cannot read is kept as it
is, the Format dialog says so, saves never write over it, and every export stops with that reason
rather than leaving the matter out. Fields inside `matter` that the app does not know are kept when it
saves. Only the matter save writes `matter`; a general book update never does. The format of
`matter` changes only with `schemaVersion`.

## Markdown folder export

**Status: implemented for the desktop local-folder target.** [D-202](DECISIONS.md#d-202--markdown-folder-export-pure-planner-contract-and-saved-source-bundle)
accepts the contract and [the folder format](formats/markdown-folder.md) is normative;
[D-203](DECISIONS.md#d-203--markdown-folder-host-protocol-and-production-policy) specifies the host
protocol and production policy. Capture, planning, owned staging, no-replace commit, attempt-bound
cancellation and the mounted Format journey are implemented and covered by synthetic tests. Replacing
an existing folder is refused and remains separately owned successor work; browser, removable, network
and synced destinations are not qualified. No publisher, measurement or device acceptance is claimed.

The export writes a one-way reading copy: `README.md`, an `images/` directory (present even when
empty) and dense uniformly numbered reading files in one order — the generated title page when matter
enables it, front sections, a contents file when settings ask for one, chapters in captured Library
order each followed by its successfully captured illustrations, then back sections. An illustration's
copied image file shares its ordinal. The folder is not a backup, archive or live manuscript, holds no
hidden manifest and makes no re-import claim. The existing single-file Markdown export is unchanged.

The output is planned from saved files collected into one frozen bundle after required saves succeed.
Collection may observe different files at different times and is never described as the book at a
single instant; once frozen, later edits cannot change the plan and a new collection invalidates
earlier consent. Generated metadata uses a reversible escape notation while chapter and section bodies
keep their captured parsed bytes exactly — parsed content, not the raw chapter file — and the
title page's trimmed subtitle and author remain deliberate projections rather than raw-value copies.
Legacy values the output does not represent are listed for an explicit **Continue without them** or
**Cancel** choice under the exact rules in the folder format, including its key classification spelled
as `key.toLowerCase().replace(/[^a-z]/g, "")`; the record itself is never changed. Selected images are
bound to verified private bytes before planning and copied exactly, with frozen omission warnings for
optional failures; copied files may carry embedded metadata and their placement text names position,
not content. Planning is bounded in every dimension — input, generated text, output, inventory,
retrieval and a conservative accounted payload that is a logical envelope, not measured memory — and
a fresh plan must allow every file to be retrieved once under all limits together. Publication and
attempt-bound cancellation are implemented for the desktop local-folder target. Replacing an existing
or nonempty folder remains separately owned successor work and is refused; browser and other
destination classes remain unqualified.

## Chapter files

One Markdown file per chapter, named `NNNN-slug.md` (`0001-the-door.md`). The numeric prefix is the
chapter's position when the file was created, and the slug comes from its title; both are only hints.
Moving a chapter rewrites `order` inside the files and never renames them, so after a reorder the
prefixes no longer follow reading order. The order that matters is the `order` field inside the file.

```markdown
---
id: ch_6a1d0f9c2b7e4d13
title: The Door
order: 1
arc: middle
purpose: Introduce the lighthouse and the keeper's routine.
synopsis: The keeper finds the door open and the light already turning.
notes: ""
isPrologue: false
version: 7
createdAt: 2026-10-24T14:02:11.000Z
updatedAt: 2026-10-24T16:41:57.000Z
---

The door had been shut when he went to bed.
```

- `id` is stable for the life of the chapter. Renaming the file or the title never changes it. One
  file is the chapter for an `id`; a sync tool's copy is not (see [Copies of a chapter](#copies-of-a-chapter)).
- `order` is an integer ≥ 1; the book reads in its order, and chapters on the same number by file
  name, so every device shows one order. The numbers need not run without gaps: deleting a chapter
  leaves one, and a move keeps them. A move gives the chapters it shifts the numbers those places
  had and rewrites only their files, so moving a chapter from 120th to 118th rewrites three files
  however long the book is. Each of those files is an atomic write checked against its hash, and
  `version` moves on. A move cut short, for example by a crash, can leave the moved chapter and its
  new neighbour on one number; the book still reads in one order, with every other chapter in its
  place, and the next move gives each chapter a number of its own.
- `version` increments on every save the studio performs. It is how the app detects that another
  writer (another device, another editor, a sync provider) changed the file.
- Front matter is written by the `yaml` package and is stable across saves; only the fields above
  are canonical, and unknown keys are preserved. Whitespace at the end of a value, including blank lines at the end of a block scalar, is part of the value and is kept.
- The body is Markdown. Line breaks are preserved as typed.

Files with **no** front matter are readable: the app derives an id from the file name, takes the
title from the slug, the order from the numeric prefix, and treats the file as version 1. This keeps
a chapter written in another editor from being invisible.

### Canonical body text

Saving normalises the body so a re-save is a no-op:

- CRLF and CR become LF.
- Leading and trailing blank lines are removed; the file always ends with exactly one newline
  (an empty chapter stays empty).
- Nothing else is touched: no wrapping, no trailing-space stripping, no Markdown rewriting.

### Imported Word documents

A Word document imported by the desktop app becomes ordinary chapter files; the format does not
change. Each body is canonical Markdown made from the document. Each Word paragraph becomes one
block, blocks are separated by one blank line, and each empty paragraph adds one more. Line breaks
are kept. Bold and italic become `**` and `*`, list items become `- ` or `1. ` lines, and quote
paragraphs become `> ` lines. Table cells become plain lines, and a heading that does not title a
chapter stays a `#` line. Text is otherwise kept as written. A chapter's title comes from the heading
that starts it.

Images, footnotes, endnotes, comments, page headers and footers, and the tracking of changes are
not stored in the library. Tracked changes are imported as if accepted. The import report lists
everything left out instead.

## Chapter history

`books/<bookId>/history/<chapterId>/<timestamp>-<label-slug>[-n].md` holds one saved-text
record per ordinary file (D-175/D-176, [ADR 0016](adr/0016-chapter-history.md)). The timestamp
is UTC ISO with milliseconds and `:`/`.` replaced by `-`; the slug is a 60-character
filename hint, never identity. Collisions append `-2`, `-3`, etc., with absent-only atomic
commits. Creating a record never replaces an existing record; intent transitions use the checked update described below. Capture is explicit and never runs on ordinary saves.
The filesystem adapter's existence check and rename are not a cross-process compare-and-swap;
an external writer racing between them is outside that guarantee. Returned bytes are checked
against the intended snapshot. A write/readback failure can leave a complete snapshot: review
history before retrying. The core never automatically retries or deletes an unconfirmed write.

Front matter is required, followed by a blank separator line and the canonical Markdown body:

| Field | Contract |
| --- | --- |
| `schemaVersion` | `1`; future versions are refused without rewriting. |
| `id` | Stable `hist_` plus at least six letters, digits or hyphens. |
| `kind` | `snapshot`, `safety`, or `intent`. The current capture operation creates only `snapshot`. |
| `bookId`, `chapterId` | Stable owning IDs; both must match the requested history directory. |
| `label` | Nonblank single line, at most 200 Unicode code points, no control characters. Explicit capture trims surrounding whitespace; reads never trim or truncate metadata. |
| `capturedAt` | UTC ISO 8601 with exactly millisecond precision. |
| `sourceVersion` | Nonnegative safe integer: version of the saved source chapter. |
| `sourceHash` | Lowercase hexadecimal SHA-256 of the raw source chapter file. Historical provenance, not a later restore base. |
| `bodyHash` | Lowercase hexadecimal SHA-256 of the UTF-8 canonical body; intents use the empty body's hash. |

Intent metadata additionally contains `selected` and `safety` references, each with
`fileName`, `id`, and `hash` (raw history-file SHA-256), and `intendedBodyHash`.
`sourceVersion`/`sourceHash` identify its checked pre-restore base. Its `state` is `prepared`,
`applied` (requires `result: { version, hash }`), or `undone` (requires both `result` and
`undoResult: { version, hash }`). Prepared intents have neither result; applied intents
have no undo result. Intent bodies are empty.

The restore core adds optional loose `plannedResult: { version, hash }` and
`plannedUndoResult: { version, hash }`. These hold the next complete serialized chapter's exact
version and raw-file SHA-256, computed before the respective write, not just its body hash.
`plannedResult` remains through applied/undone states; `plannedUndoResult` is allowed only on
applied/undone intents. When present, finalized results must equal their plans. Older records
remain readable; a prepared intent without an exact plan is uncertain. Recovery reads never replay
writes or infer ownership from matching prose. Exact identity matches permit checked undo of a
restore, including interrupted finalization; an interrupted undo plan is reported for review, not
silently retried. Identity is not authenticated provenance.

Restore verifies a visible safety record and prepared intent before starting the chapter writer.
Undo persists its plan in that intent first. Updates are expected-raw-hash guarded, with unknown
supported fields preserved. Both operations exact-check current version and raw hash within the
existing book queue, including equal bodies, and use the journal-aware checked writer. They preserve
current metadata values and replace only the body plus normal version/update-time bookkeeping;
even equal-body operations increment the version. Cancellation before history publication changes
nothing; after safety publication it retains safety and prepares the intent before stopping. Once
chapter writing starts, the actual saved/conflict/uncertain outcome wins over cancellation. Failed or
uncertain writes never delete selected, safety or intent material. IPC/UI and live host draft/save
gating are separate obligations; the core cannot observe editor state.

All known metadata objects are loose: supported unknown fields survive codec round-trips,
including nested references/results. Supported metadata contains plain string-keyed mappings,
dense arrays, strings, booleans, null and finite numbers. Integer numbers must be safe integers;
negative zero and numeric tokens whose value would round or underflow during serialization are
refused. Complex keys, unsupported YAML tags, Set/Date/Map values, cycles, `__proto__`, accessors
and other non-data/foreign JS values are refused before schema conversion; they are never silently
changed into another type. Acyclic alias values survive, without promising comments, anchor names
or object-graph identity. Serialization snapshots this validated metadata before asynchronous work.
No read writes back. Invalid YAML, missing required data,
wrong identity, unsupported schemas and body-hash mismatches are unavailable records, left
intact for recovery. Listing reports them individually. Parsing errors never include prose;
the complete history source-resolution path uses quiet parsing and fatal UTF-8 decoding.
Canonical body hashing uses the same normalization as chapter bodies; front-matter formatting
is not covered by `bodyHash`. An open result also reports the record's raw-file hash.

Capture requires a confirmed saved state and exact source version/hash, reads only the saved
file, and requires its persisted chapter ID (headerless fallback IDs cannot anchor history).
It verifies raw source hashes and refuses a changed, missing, unreadable or future-schema source. It never flushes a draft or
changes chapter bytes. Hosts must check their live draft/save state before requesting capture.
List/open work even while the chapter is in trash; comparison requires the current saved
chapter and identifies its two bodies as saved text, excluding any draft.

History follows a stable chapter ID through title, filename and order changes. Chapter trash
leaves history in the book; whole-book trash carries it with the entire folder. Portable
archives include ordinary files' exact bytes and hashes by the author-file rule, including
unknown or unavailable record contents; history validation happens when those records are read.
Filesystem links and special entries are unsupported. Direct access refuses them; metadata-only
history inspection lists unsupported `.md` entry names as unavailable without reading their
targets. They remain excluded from ordinary archive traversal.
No automatic pruning, count/size quota, expiry or compaction applies, including to intents.
List sizes come from storage stats, not a format field. Storage failures never delete recovery
material. Future explicit deletion must move a record to recoverable chapter trash and protect
restore dependencies; no deletion operation is provided by the saved-only core.

## Conversation files

`threads/<threadId>.json` stores one agent conversation. It is written through the same atomic commit
as a chapter and is not part of `library.json`; a missing or stale catalog never loses a conversation.

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | number | Currently `1`. A missing version is read as 1; a newer version is refused read-only and never migrated when the library opens. |
| `id` | string | `thread_` + at least 6 letters, digits or hyphens. Matches the file name. |
| `bookId` | string | The owning book. |
| `title` | string | Author-facing label; defaults to "New conversation". |
| `createdAt`, `updatedAt` | ISO 8601 | `updatedAt` changes when the conversation content changes. A save that changes nothing is not rewritten and keeps the stored timestamp. |
| `messages` | array | Each has `id`, `role`, `parts`, optional `model`, `mode` and `usage`, and `createdAt`. New user submissions and assistant outcomes record their fixed turn `mode` (`discuss` or `edit`); older messages have none and are shown as unrecorded, never inferred from the current composer. |
| `checkpointTurns` | string[] | Turn ids whose checkpoints belong to this conversation, newest last: each turn that changed the book and saved its checkpoint, including one stopped while it waited for approval and one that failed before it stored a reply. Undo takes the book's newest checkpoint, so the chat offers it only on the last of these, and names that turn: if another change now owns the newest checkpoint, nothing is undone (see [Agent turn checkpoints](#agent-turn-checkpoints)). An undo removes its turn from every conversation that lists it. A branch copies its source's list when it keeps the newest of these turns, and starts with none otherwise. |
| `plans` | array | Bounded plan history, oldest first, at most 50 per conversation. Each plan has `id` (1–200), `mode: "edit"`, `status`, `purpose` (1–2,000), ordered `steps` (`text` 1–2,000, `state`; 1–50 steps), `revision` (integer 1 or more), optional `guidance` (1–2,000), `parent` (`messageId`, `turnId`), `createdAt`, `updatedAt`, and optional `startedAt`/`terminalAt`. The stored statuses are `proposed`, `running`, `waiting-for-approval`, `pause-requested`, `paused`, `completed`, `cancelled`, `failed` and `expired`; `started` is not stored. Step states are `pending`, `in-progress`, `completed` and `not-completed`; a skipped step is `not-completed`. At most one plan is unfinished. Terminal plans are retained and immutable, and a terminal plan closes its unfinished steps to `not-completed`. A missing `plans` is empty. A malformed plan is reported as corrupt, and an unknown stored status or step state as unsupported; either way the file is left untouched. A fork starts with no plans. |

Message parts are `text`, `reasoning`, `tool-call`, `tool-result`, `source`, `file`, `error` and
`guidance`. Tool calls and results keep their ids, so a resumed conversation can be inspected
without replaying prose. A call that failed, including one whose tool threw, ends in a `tool-result`
with `isError: true` and an output of `{ "ok": false, "message": … }`. An approved overwrite, line
deletion, split or merge that found its chapter changed since it was proposed also carries
`"changedSinceRead": true` and the `chapterId`, and an overwrite carries `savedAs`, the library-relative
path of the conflict copy that holds its text (see [Saving and conflicts](#saving-and-conflicts)). A `guidance` part carries one turn of author instructions (1–2,000
characters, never truncated) with the submitted user message; it applies to that turn only.
The schema lives in `packages/core/src/agent/messages.ts`.

Plans are not message parts: a plan outlives the turn that proposed it, so it lives on the
conversation beside `messages` and `checkpointTurns`. The parent is the Edit assistant message that
proposed it, matched by `parent.messageId` and its stored `parent.turnId`; a later Start, Resume,
pause or cancel turn refers to the plan by id and does not become its parent. At most one plan may
be unfinished. A terminal plan is never reopened, replaced or removed, and every terminal
transition closes its remaining pending or in-progress steps to `not-completed`; a completed plan
must have at least one completed step. `plans` is additive on `schemaVersion: 1`: a thread without
it has no plans, an older build keeps it as unknown plain data, and a fork starts with none.

Stored error explanations are limited to 2,000 UTF-16 code units. Longer provider details carry an
explicit shortening marker; retry-wait explanations and checkpoint-loss warnings are retained.
The numeric `retryAfterSeconds` field supports up to 86,400 seconds. A longer provider wait is
preserved as seconds in the stored explanation instead of being clamped; the live terminal event
still carries the original wait. Conversation validation or persistence failure cannot suppress
the turn's terminal event.

A corrupt file is never rewritten or deleted by a list operation; opening it reports the error. A
conversation may carry unknown plain fields at any depth; a checked read-modify-write keeps them,
including fields on a message whose body is replaced with the same id. Unknown message roles and part
types are semantic, not plain data: this build reports the file as unsupported and leaves it
untouched rather than guessing. A newer `schemaVersion` is likewise read-only. There is no v2 writer
or automatic migration in this slice; a future v2 that adds semantic parts must ship an explicit
migration with an original-byte backup.

Thread writes are checked. A save must name the exact raw SHA-256 of the bytes it read (`readSnapshot`); a save without that base is refused rather than silently rebased on the current file, and a caller holding an older copy keeps a conflict copy. The commit refuses
to overwrite a file that changed, and keeps the caller's whole intended document as
`conflicts/<threadId>.conflict-<external-edit|missing-file>.<deviceId>.<timestamp>[-N].json` with its
bytes verified before it reports `savedAs`. A written document is read back and compared with the
bytes submitted; a different or uncertain readback is reported as uncertain, never as saved. Parsing
is fatal UTF-8 and lossless JSON: a byte-order mark, duplicate key, lone surrogate, non-finite or
negative-zero number, or an integer outside the safe range is refused rather than normalized. A
supported number keeps its exact value and strings are kept exactly, without trimming or Unicode
normalization; a literal that cannot be represented without loss is refused instead. The
materialization ceiling is 64 MiB per conversation; a larger file is reported and left untouched
(D-113). Every conversation caller writes through the Library's per-book queue and journal-aware
commit; there is no unchecked thread writer or second queue.

Deleting a conversation moves its whole file to
`.studio/trash/<bookId>/threads/<stamp>-<threadId>[-N].json`; it never unlinks the file. The source
must exist and the destination must be absent, with a collision taking the next suffix. Restoring
moves the same bytes back to `threads/<threadId>.json`, requires that destination to be absent, and
refuses a file that no longer names this book and conversation. There is no automatic pruning, quota
or expiry.

## Agent turn checkpoints

`.studio/checkpoints/<at>-<turnId>.json` inside a book folder is the undo point for one agent turn.
`<at>` is the time of the turn's first change, with `:` and `.` replaced by `-`. The turn writes the
file again, whole and atomically, each time it changes a chapter and before the tool answers the
model. A change made after an approval is covered as fully as one made before it. A turn has at most
one file; undo restores from the newest file, then removes it and takes its turn out of every
conversation's `checkpointTurns` (see [Conversation files](#conversation-files)). Each write and removal
is noted in this device's sync journal (see [Sync journals](#sync-journals)), so a drift scan does not
list the studio's own checkpoints; one written or removed by another device is still listed. The newest
file is the one whose name sorts last. An undo that names its turn, as the chat's does, goes ahead only
while the newest file is that turn's; otherwise it restores nothing, removes nothing, and says which
request and chapters the newest file holds. The control plane's undo route accepts the same turn id. The
ambient strip, the CLI, MCP and the phone name no turn and take the newest file.

| Field | Type | Notes |
| --- | --- | --- |
| `turnId`, `bookId` | string | The turn and its book. |
| `at` | ISO 8601 | When the turn first changed the book. Later saves keep it, so they rewrite the same file. |
| `prompt` | string | The author's request. |
| `entries` | array | One per chapter the turn changed. Undo walks them from last to first. |

Each entry has `chapterId`, `title` and `before`, the body text the chapter had before the turn first
wrote it. Optional fields:

- `created: true` marks a chapter the turn created. Undo moves it to the trash.
- `deleted: true` marks a chapter the turn deleted. Undo moves the chapter's own file back out of the
  trash (see `trashedAt`), so it keeps its id and front matter, then restores its text and details if
  the turn changed them too. When the file is no longer in the trash, `trashedAt` is refused, or the
  entry has no `trashedAt`, undo writes a new chapter with that title and `before` as its text, and
  says so. A
  deleted chapter that is already back in the book is left as it is and reported.
- `trashedAt` is where a deleted chapter's file went, the library-relative path
  `.studio/trash/<bookId>/<file>.md` that the delete returned. Undo accepts no other path, and only a
  file that holds this chapter's id.
- `order` is the 1-based position undo puts the chapter back at. For a deleted chapter it is where the
  chapter stood. For a moved chapter it is where the chapter stood before the turn first moved it.
- `afterHash` is the SHA-256 (hex) of the body text the turn left. Undo leaves a chapter whose body
  no longer has this hash and reports it as skipped, so it never writes over a later edit. The front
  matter is not hashed, because moving one chapter renumbers its neighbours without changing their
  text.
- `meta` holds the chapter's details before the turn first changed them: `title`, `synopsis`,
  `purpose`, `notes`, `arc`, `color` and `isPrologue`. Undo puts them back with a checked write.
- `afterMetaHash` is the SHA-256 (hex) of those seven details as the turn left them, hashed as a JSON
  array in that order. Undo leaves a chapter whose details no longer have this hash and reports it,
  as it does for text. `order`, `version` and the dates are not hashed, for the same reason.
- `outsideEdit: true` marks a chapter someone else wrote in between two of the turn's own changes,
  for example while an approval was waiting: the text or details a tool found were not the ones the
  turn had left. Undo first keeps the chapter's file, byte for byte, as a conflict copy with the
  reason `undo` (see [Saving and conflicts](#saving-and-conflicts)), then restores the chapter. If the
  copy cannot be written, undo leaves the chapter as it is. A chapter the turn created goes to the
  trash whole, so it needs no copy.

Restoring is an ordinary checked save: the body comes back exactly, and `version` and `updatedAt`
move forward. A checkpoint written before `afterHash` existed
restores over the current text, as it always did. One written before `meta`, `afterMetaHash`,
`outsideEdit` and `trashedAt` existed is read as before: it restores no details, keeps no copy, and
brings a deleted chapter back as a new one. A chapter the turn created and then deleted leaves
no entry, and a turn whose changes cancel out leaves no file.

Undo reports how many chapters it restored and how many it skipped, the conflict copies it kept, each
with the chapter's id and title and the copy's library-relative path, and one sentence for each chapter
that did not simply go back.

## Saving and conflicts

Every save carries the version and hash the editor started from. The main process, which is the only
writer, compares them with what is on disk:

| Situation | Result |
| --- | --- |
| Content equals the file | No write, no version bump. |
| `disk.version > base.version` | Conflict copy, reason `newer-version`. |
| `disk.hash ≠ base.hash` | Conflict copy, reason `external-edit`. |
| Otherwise | File replaced atomically, `version + 1`, `updatedAt` refreshed. |

A conflict never overwrites the other writer. The local text is written to
`conflicts/<name>.conflict-<reason>.<deviceId>.<timestamp>.md`, the UI shows both versions, and the
author chooses: *Show the saved copy* or *Load the version on disk*. A Story Bible or settings save
that overlaps another writer keeps the author's `book.json` the same way, as
`conflicts/book.conflict-external-edit.<deviceId>.<timestamp>.json` (see
[Saving `book.json`](#saving-bookjson)).

One conflicted save writes one copy. The editor never saves words a copy already holds against the
same base again, and drops the draft it held for them, so loading the version on disk, closing and
quitting write no second copy. Words typed after the conflict are new, so they get a copy of their own.

An agent edit that waits for the author's approval is checked the same way, against the version and
hash the chapter had when the author was asked. If the chapter was saved in between, an approved
`overwrite_chapter` keeps the file on disk and writes its text as a conflict copy with the usual reason,
and an approved line deletion, split or merge writes nothing. The chat says so on the step, and offers
the overwrite's copy.

The front and back matter saves the same way: the save carries the `version` and a SHA-256 of the
matter the author started from (its JSON as the app parsed it). When either no longer matches what is
on disk, nothing is written over it: the author's matter is kept as
`conflicts/front-and-back-matter.conflict-<reason>.<deviceId>.<timestamp>.json`, a JSON object
`{ "matter": … }` exactly as they had it, and the Format dialog shows the matter now on disk with the
copy's name and a *Show the saved copy* action. A `book.json` that another writer replaces while the matter is saving is refused, and the
author's change is saved again on their next change or when the dialog closes.

Ordinary book metadata updates also commit against the SHA-256 of the `book.json` snapshot they
read. If another writer changes that file before the commit, the newer bytes stay in place and the
studio's proposed book is kept as `conflicts/book-metadata.conflict-external-edit.<deviceId>.<timestamp>.json`
with shape `{ "book": … }`. The update reports the conflict instead of claiming it was saved.

Undo of an agent turn uses the same folder and naming with the reason `undo`. Before it restores a
chapter that someone else wrote in during the turn, it keeps the chapter's file exactly as it is, and
keeps nothing if the file changed since undo read it.

Writes go through a sibling temp file, `fsync`, and `rename`, with one retry for Windows sharing
violations. Writes for a single book are serialised, so two IPC calls cannot interleave. The temp
file is named `.<file name>.<process id>.<milliseconds in base 36>.tmp`, for example
`.book.json.4242.mhl7x2ps.tmp`. It exists only for the moment of the write; the studio's watcher never
reports a file of that shape, and nothing should sync, edit or keep one.

## Words kept after a failed close or quit

When the last save before a window closes or the studio quits cannot write a chapter (a full disk, a
read-only or locked folder, a chapter file that is missing, a library folder renamed while open), the
unsaved text is kept in the studio's own profile, never in the library, at
`<userData>/recovery/rec_<16 hex digits>.json`:

```json
{
  "version": 1,
  "id": "rec_0f3c9a1b2d4e5f60",
  "bookId": "book_1f4c8a2b9d3e5a71",
  "chapterId": "ch_6a1d0f9c2b7e4d13",
  "content": "The whole chapter text as it was in the editor.",
  "baseVersion": 4,
  "baseHash": "…",
  "keptAt": "2026-11-04T07:15:00.000Z",
  "reason": "The disk is full. Nothing was replaced.",
  "libraryRoot": "/Users/…/Writing"
}
```

- `baseVersion` and `baseHash` are the chapter's version and SHA-256 the words were typed against.
  `libraryRoot` is shown, never matched: a library folder that was renamed keeps its book ids.
- Each file is written atomically with mode `0600`, in a folder with mode `0700`. A failure that
  repeats writes a new file, so later words never replace earlier ones; an identical copy (same
  chapter, base hash and text) is written once. A file that does not read is reported and left alone.
- The author is asked before the studio closes or quits with kept words: keep it open, or leave with
  the words kept. A hidden run logs the counts and the reason instead.
- A kept copy is offered when its book opens. *Restore words* saves it through the checked save above,
  so a chapter that changed since keeps the words as a conflict copy; the file goes once that save
  returns. *Discard words* asks first, then removes the file. Nothing else removes one: not a later
  save, not a restart, not a timer.
- It is a disposable draft, not a second source of truth. Nothing reads it as the chapter, it never
  travels in a portable archive, and deleting the folder loses only words the author has not restored.
  The browser build keeps none; its drafts are flushed into storage when the page hides.

## Trash

Deleting a chapter moves its file to `.studio/trash/<bookId>/<stamp>-<original name>.md`, where `<stamp>`
is the deletion time in milliseconds since 1970, written in base 36 (`mh3k2x1c-0002-the-door.md`). Nothing
is unlinked. Restoring is a file move back into `chapters/`. Undo of an agent turn makes that move for
a chapter the turn deleted: the file goes back under its original name, or the next free one, with its
id and front matter, and only when no chapter with that id is in the book.

Deleting a book moves its whole folder to `.studio/trash/books/<stamp>-<bookId>/`, with the same stamp. The folder keeps
its `book.json`, chapters, conflicts and checkpoints, so restoring is a move back into `books/`.

## Sync journals

`.studio/sync/<deviceId>.json` is this device's baseline for drift detection: the last observed hash of
each author-owned file, the hash this device last wrote, and tombstones for deletions. It is written
after a reviewed scan, never during one. The chapters, conversations, images and agent checkpoints
the studio writes or removes are noted in it as this device's own, so a scan does not list them. For
an existing file, the intended save hash is recorded before the atomic file commit. After a service
commit, the baseline advances only when the adapter's returned snapshot has the exact intended bytes
and hash and its initiating receipt still owns that path's journal note. The verified intended hash,
not a later path observation, is recorded for both new and existing paths. An unaccepted outside
replacement or removal remains reviewable; a later accepted scan, verified note, uncertain intent or
removal cannot be undone by the older snapshot. Explicit notes from other
existing writers retain their observation-based behavior. If the process stops between the intent and
the verified note, a later scan still recognizes exact intended bytes on an existing path; a different
on-disk hash remains an outside change for review. A
conflict copy is not, because the save that made it still needs the author's review. Notes take
turns, so two made at once both land. It contains no prose or credentials, is excluded from portable
archives, and is safe to delete; the next scan rebuilds it by comparing the files and warns that it had
no baseline. A journal copied from another device is ignored by its device id.

Schema 1 file records may additionally carry `plannedWriteId`, a fresh UUID identifying the particular
intent that set `writtenSha256`; legacy records without it remain readable. This is bookkeeping, not
evidence that the file was published or permission to write it. Every planned call on an existing
journal record gets a new ID, even when the intended hash is unchanged. Absent records are not added
by intent notes. A verified post-write record no longer carries a planned ID. Live receipt ownership
is scoped to the storage-port object, device and path, including paths with no journal record. This
coordinates service instances sharing that port; it does not coordinate separate ports or processes.
Accepted scans, removal notes and moves retire affected live claims and their predecessor chains,
even when an existing tombstone's record stays unchanged. A later refusal cannot restore a retired
predecessor. Retirement remains effective in the running process if the journal update fails; this
does not claim that the failed update was persisted. A failed intent note permits a
verified update only while its exact initiating record/generation and live ownership still match.

If the adapter definitively returns `changed` without `publication: "uncertain"`, the service retracts
only that attempt's still-identical journal record and restores its prior intent, without accepting
the outside file as the observed baseline. Reconciliation shares the existing per-port journal queue;
newer same-hash intents, verified writes, accepted scans and changes to other paths are preserved.
Live receipts retain predecessor outcomes so overlapping refusals settling out of order cannot restore
an already-refused intent. If a predecessor verified while a newer intent owned the path, a definitive
refusal of that newer intent can restore the predecessor's verified snapshot only while the chain
has not been retired by a superseding decision. Settlement is one-shot.
Every pending receipt remains reachable for retirement independently of active baseline ownership,
including when a newer possible receipt settles after its intent note failed before publication.
Pending registry roots are removed on settlement or retirement; a settled receipt releases its own
references. Completed predecessors remain reachable only while a pending descendant needs them;
active ownership is retired on settlement or superseding decisions. An indefinitely pending operation
retains the receipt state it still needs. That transient bookkeeping is not a second
source of truth. Exceptions, uncertain publication and unverified written readbacks retain the
persisted intent for interrupted-write recovery. A known refusal never retracts a preexisting unresolved
same-byte attempt. Journal notes remain best effort: a failed intent/post-write note can require review,
and failed reconciliation can leave the recovery intent. No author-file retry, cross-process CAS or
cross-file transaction is implied.

## Migration record

`.studio/migrations.json` maps each imported legacy book's content fingerprint to the book it
created: `{ version: 1, books: { "<sha256>": { bookId, title, importedAt } } }`. The fingerprint is
the SHA-256 of the canonical legacy book payload, so a second run over the same export recognises
every book whose target still exists, imports nothing, and names each recognised book in the report.

It contains no prose, only ids, titles, timestamps and hashes. Like sync journals it is excluded
from portable archives: restoring an archive and re-importing the same export imports the books
again. Deleting it is safe; the next run simply imports every book in the export.

## `library.json`

A cache for the library grid: `{ schemaVersion, app: "ai-book-studio", updatedAt, books: [...] }` where
each entry is `{ id, title, description, stage, chapterCount, wordCount, updatedAt }`.

It is derived and best-effort. The app rebuilds it from `books/*/book.json` on open and after each
change, and never reads it as truth. Deleting it is safe; a stale copy in a sync folder is harmless.

## Portable archive

A whole library can travel as a ZIP with a root `manifest.json` (format version, app version,
creation time, entry count, expanded size, and each file's relative path, size and SHA-256). The
archive is a transport format, not a second source of truth: importing writes the ordinary files
back and then opens them.

- Include every author-owned file, including unknown files, images, conflicts and trash.
- Exclude `library.json`, everything under `.studio/` except `.studio/trash/`, and any temporary or
  lock file. Credentials are never in a library and are rejected if an archive claims to contain one.
- Import only into a new or empty folder; never merge with or replace an open library.
- Validate the manifest, normalized relative paths, duplicates, entry count (10,000), expanded size
  (2 GiB total, 512 MiB per file), format/schema versions and every hash before publishing.
- A failed import removes the files it wrote and leaves an existing destination untouched.

The contract is in [`specs/010-web-target/contracts/archive-v1.md`](../specs/010-web-target/contracts/archive-v1.md)
and [ADR 0012](adr/0012-portable-library-archive.md).

## Copies of a chapter

When two machines write the same file through a sync service that cannot merge them, the service
keeps both, and the copy keeps the original's front matter, `id` included. Exactly one file is a
chapter's own file. The studio lists, opens, saves, edits the details of and trashes only that file;
every other file is a copy.

A file in `chapters/` is a copy by its name when it carries one of these marks:

| Source | Example |
| --- | --- |
| iCloud Drive | `0002-the-lighthouse 2.md` |
| Google Drive | `0002-the-lighthouse (1).md` |
| Dropbox, Nextcloud | `0002-the-lighthouse (MacBook's conflicted copy 2026-11-04).md`; Dropbox's `(Case Conflict)` and `(Selective Sync Conflict)` too |
| Syncthing | `0002-the-lighthouse.sync-conflict-20261104-093000-ABCDEF1.md` |
| This studio | `0002-the-lighthouse.conflict-external-edit.<deviceId>.<timestamp>.md` |

The iCloud and Google Drive marks count only after a name the studio writes, `NNNN-slug.md`, so a
chapter named `Chapter 2.md` in another editor is still a chapter. Only the exact marks count, so
`Part Two (The Conflict).md` is a chapter too. A copy by name is never read as a chapter, whatever
its front matter says.

When several readable files without such a mark carry one `id`, the chapter's own file is chosen by
name alone:

1. a name the studio writes, `NNNN-slug.md` (`0002-the-lighthouse.md`, or `0002-the-lighthouse-2.md`
   when that name was taken);
2. then the shorter name;
3. then the first name in character order.

The rest are copies. File dates are not used, for two reasons: every device must pick the same file,
and an atomic save gives the chapter's file a new creation date, so "the oldest file" would hand the
chapter to its copy at the next save. A copy that is newer, by date or by `version`, never takes the
original's place.

The studio never writes, renames, moves or deletes a copy. It stays where the sync tool put it and is
listed beside the copies in `conflicts/`: the workspace counts them in its *saved copies from earlier
sync conflicts* line, whose *Show in folder* action opens the folder at the first copy, and the sync
review lists the copies named as such. Resolving a copy is a deliberate act by the author, not an automatic merge. Deleting a chapter
trashes only its own file, and a copy named as one stays a copy. A copy that carries no mark, such as a
Finder duplicate (`0002-the-lighthouse copy.md`), is told apart only while the original is there: once
the original is in the trash, the copy is the only file with that `id` and opens as the chapter.

## Version compatibility

`schemaVersion` is checked on read:

- Missing → the file is not ours; the error names the file.
- Greater than the app's → refused, with "This library was written by a newer version of Open Book
  Studio. Update the app to open it." The same check runs before every write into the book, because
  another device may upgrade `book.json` while the book is open. A chapter save, a new, moved,
  deleted, restored, merged or split chapter, a kept copy, the Story Bible and every settings save,
  images, conversations, moving the book to the trash, the agent's tools and the toolkit's saves are
  all refused with that message before anything is written.
- Lower → accepted; the app writes the current version on the next save.

A book folder that does not open is never hidden. The library shows it as a card that says why, with a
*Show in Finder* action on desktop (*Show in folder* off macOS), and leaves its folder exactly as it is:

| `book.json` | The card says |
| --- | --- |
| A newer `schemaVersion` | "This book was saved by a newer version of the studio", with the title it carries |
| Missing, empty, or an iCloud `.book.json.icloud` stand-in | "This book is still syncing" |
| Anything else that does not read: not JSON, no `schemaVersion`, the wrong shape, no permission | "This book's details could not be read" |

`library.json` lists only the books that open.

## Privacy

Library files are the only copy. The app has no account, no telemetry and no server-side copy. It
writes exactly four things outside the library: the library path in `studio.json`, window bounds in
the same file, an OpenRouter key (later, in the macOS Keychain), and words a close or quit could not
save, in `recovery/` in the same profile, until the author restores or discards them.

## Images

`images.json` is the source manifest for `images/`. It is versioned like `book.json`; a newer
`schemaVersion` is refused rather than rewritten. An unknown or corrupt manifest yields an empty
gallery with a warning, and the image files stay on disk.

```json
{
  "schemaVersion": 1,
  "images": [
    {
      "id": "img_6a1d0f9c2b7e4d13",
      "kind": "chapter",
      "chapterId": "ch_6a1d0f9c2b7e4d13",
      "characterId": null,
      "fileName": "img_6a1d0f9c2b7e4d13.png",
      "mimeType": "image/png",
      "width": 1024,
      "height": 1024,
      "bytes": 184320,
      "sha256": "…",
      "prompt": "a lighthouse in a storm, ink and wash",
      "provider": "meta",
      "model": "muse-image-1.0",
      "size": "1024x1024",
      "source": "generated",
      "createdAt": "2026-10-26T12:00:00.000Z",
      "cutoutOf": null,
      "costUsd": 0.01
    }
  ]
}
```

- Image bytes are written first, then the manifest, both atomically through the library port. A
  failed manifest write removes the new file when it can and otherwise reports an orphan.
- `kind` is `chapter`, `character`, `cover` or `other`; `source` is `generated` or `imported`.
  `cutout` is a legacy source: a book saved by an earlier build may hold one, and the studio still
  reads, shows and exports it, but never writes a new one (D-158).
- A chapter has at most one attached image. Attaching another clears the previous `chapterId` in the
  same manifest commit.
- `cutoutOf` is legacy too: on an earlier build's SAM cutout it points at the source image, which was
  never modified. The studio writes `null`.
- The manifest and every image are author files and travel in the portable archive. No image is stored
  in `book.json`, the catalog or the app profile.
