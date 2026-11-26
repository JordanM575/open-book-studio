# Changelog

All notable changes to Open Book Studio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Update the `Unreleased` section before every commit.

## [Unreleased]
### Repository verification
- Isolate default synthetic desktop checks from protected storage. Keep the fake-provider check on its in-memory vault.
- Keep plan-step focus and dictation callback dependencies explicit, and guard persisted test values before reading their fields.
- Generate synthetic reader IPC redaction values at runtime and check for partial marker leaks.
- Drive the Markdown folder collision test at the staging-complete boundary.

### Browser reader verification
- Settle workspace startup reads before measuring the unsupported reader control's side effects.
- Add an opt-in built web check for reader review refusal at welcome and in the workspace, with storage and process cleanup checks.
- Verify the served browser build, trusted keyboard activation, and complete process exit in the reader refusal check.
- Use the same commit stamp when building the desktop and web artifacts for the reader checks.

### Reader review verification
- Check that stale passage navigation refuses and two reader lenses retain their own saved revisions in the mounted comparison.
- Exercise keyboard Stop with a late synthetic response and verify the stopped attempt remains without findings.
- Exercise an opt-in keyboard Start refusal after a checked save changes the selected source.
- Capture completed findings and their run identity before the renderer revalidates the copied envelope.
- Add an opt-in keyboard check for cancelling a prepared disclosure and refusing Start for the retired request.
- Exercise keyboard focus, light and dark appearance, and independent reduced-motion and reduced-transparency preferences in the built reader check.
- Revalidate completed reader runs copied across the desktop bridge before displaying their scoped findings.
- Record the failed step, synthetic Start outcome and bounded operation counts when reader verification stops early.
- Add an opt-in built desktop check for keyboard preparation, explicit start, current-source checking and exact passage selection with a synthetic provider and library.
- Wait for the reader check's startup scan and process group exit, and match the exact passage control and receipt to the observed run.
- Pass the disclosed reader review instructions through the SDK's instruction field so an approved review can reach the selected provider.
### Review evidence after saving
- Keep paragraph breaks and newer draft text during autosave. Apply a missing final newline from a confirmed chapter save once the unchanged editor is idle, including after metadata-only chapter changes, so exact review evidence can open.

### Review smoke evidence navigation
- Wait for the prior review dialog to close before reopening the report. Capture the displayed review status if exact evidence navigation stalls.

### Chapter history
- Open the chapter history dialog only when the selected chapter has a bound history adapter. This restores the desktop renderer typecheck and preserves the unsupported-host behavior.

### Reader review T001 reconciliation (039 T001) task record
- 039 T001 is recorded complete on documentation alone: the 034/037/039 reconciliation audit (`reader-review-t001-reconciliation.md`, 2026-11-20) is adopted as the acceptance scope, with its evidence ledger kept as builder/coordinator-reported and never re-run. Stale claims corrected: 039 spec U-039-01/02 rows (T002/T004 and T002/T005 merged and checked), the 039 plan Verification section (post-W10 merges: T003 PR #108, T004 PR #112, T005 PR #119, T008 PR #116; T006, T009, T010–T019 remain open) and its delivery-checkpoint status, the 039 plan's U-039-04 prerequisite line (T003 applied it; only T006 carries it), 034 spec's repetition-scanner and FR-005 lines (repetition-v1 shipped, T008), and the 037 plan "Shape" section (dated pointer to the merged standalone transport, not a foreground `runtime.ts` turn).
- The shared `review/` directory ownership record now lives in `packages/core/src/review/SCOPED-CONTRACTS.md` (034 owns `index.ts`/`repetition.ts`; 039 owns the scoped-contract leaves; 037 owns no module there; the `guided-review` kind remains reserved with no producer or consumer). Residuals recorded, not resolved: M-2, M-6 (check-in ownership assumption), M-7 (consent wording), M-8 (schema-1/schema-2 `review-campaign` path family), M-9 (IPC inventory drift), M-10 (duplicated record-store patterns). No product or test source changed; no excluded persistence file touched; 034 and 037 task files untouched; 038 T022 remains unchecked; no other task box moved; no live-provider, built-app, packaged-app, device or semantic-quality evidence is claimed.
### Routing handoff (036 T016) task record
- 036 T016 is recorded complete after independent exact-head review ACCEPT and merge `a246d5d` (PR #118). The implementation head `eb876f08` (22 files against its parent; the design memo's 23-entry §7 allowlist went unused at `packages/core/src/routing/index.ts`) lands the writing-agent composer's optional “Preview models” entry (rendered only when the host wires it), the in-memory snapshot of catalogues the explicit model picker already loaded, the known-context eligibility branch, and the per-candidate “Use for next message” action. The action passes only `{ provider, modelId }` to the existing one-turn picker, which restricts itself to that provider's usable connections (preselecting only when exactly one exists; otherwise the author chooses, never the first credential), revalidates the connection and the model on open and on confirm, and — only through its existing confirm — sets the one-turn override. The book default, connection, conversation, consent and manuscript are untouched, Send remains the only dispatch trigger, and no IPC channel, preload method, provider call, vault read, persistence, ranking/score, request-size estimator or task/route store is added.
- Evidence: 124 focused passes were recorded (the reviewer's exact-head re-run saw 122 passing, 0 failing; the difference is grouping), node typecheck clean, and web shows only the known pre-existing `WorkspaceView` diagnostic. The implementation head `eb876f08` was ACCEPTed by exact-head review; the pre-merge `main` merge `0df52611d3ce60ea02ed1ddaebdd1b10a604b04c` was itself reviewed and ACCEPTed first; PR #118 then merged to main as `a246d5d2d35533882039044157bf082da19ab43f`.
- Judgment calls recorded from the reviews: the known-context requirement ships as an optional `requiresKnownContext` per §7.1 of the handoff design (an absent flag never grants eligibility; the three shipped profiles set it and are pinned by test); the static D-206 sentence “No total is shown because the request size is unknown.” is the §7.1/Q3-permitted disclosure with no calculation attached; the picker's `handoffPendingRef` guard is inert outside handoff mode and is covered by the mount test's exact `providers.models` call counts. Residuals: `connectionsLoaded` is not reset on picker re-open (cosmetic; confirm revalidates, so no stale write is possible), and live, packaged and provider-behaviour evidence — the T009-equivalent built-app class — remains out of scope, so no such claim is made. T016's acceptance under its design is implementation plus exact-head review plus merge, all three now done. T015, T017, T018 and T019 remain unchecked; 037 T022 and 038 T022 remain unchecked; no other task box moved.
### Voice request ledger (017 T016, synthetic evidence only)
- PTT dictation and provider speaking now run through a host-owned request ledger. The main process mints a public operation id before any route resolution, reserves the exact saved route, and pins it in the transport ledger; the internal ledger id never leaves the host. New `VoiceRequestHost`/`VoiceRouteAuthority` (`apps/desktop/src/main/voice-request.ts`) sit behind `voice.transcribe`/`voice.speak`; the renderer can only ask to cancel, read its own window's receipt, or watch phase events (`voice:operation-event`, `VOICE_OPERATION_CHANNEL`).
- Route is re-checked before every send: saved selection, connection presence, pinned provider/model/voice, endpoint identity (`endpoint:<sha256[:16]>`), a host revision bumped on every voice-settings write and every connection removal (including A→B→A), session token and permission. Any drift refuses with zero provider calls; nothing is retried, substituted, reordered or fallen back to another provider or the device voice.
- Charges stay honest. Receipts distinguish pending/none/reported/unknown/mixed; a reported zero renders as `Provider-reported cost: $0.00.`, unknown never renders as zero, TTS stays unknown until a provider reports a finite amount, and unsent planned chunks are reported separately from unpriced ones. Stopping before send says so; stopping after send keeps the unknown open; late replies are recorded but never delivered.
- New renderer surfaces: receipt lines under the dictation and speaking controls (`voice-receipt` / `ambient-voice-receipt` test ids, `role="status"`), a Stop control while transcribing or speaking, `data-testid` on the cancelling state. Renderer keeps its own stop path; the host remains the authority on what was sent.
- Browser build refuses `voice.operation` and exposes a no-op `onOperation`; no provider claim is made there. No new persistence, no usage-store write, no library or `studio.json` change; the receipt is memory-only and restarts forget it honestly.
- New IPC additions are additive: `voice.operation` channel, `voice:operation-event`, `VoiceOperationView`/`VoiceChargeView`/`VoiceTranscriptionOutcome`/`VoiceSpokenOutcome`, `transcribe`/`speak` now return typed outcomes. `voice.cancel` keeps its existing shape. `voice:operation-event` fires only after the host mints an id.
- Evidence is synthetic source/tests only: fake mic, fake recorder, in-memory vault, scripted fetch. No live provider, microphone, device, packaged build or manuscript was touched; no task box was checked in this entry (017 T016 was left open pending independent exact-head review; 038 T022 stays open). T016 was subsequently reviewed, merged and recorded complete in the task-record entry below.
### Voice request ledger (017 T016) task record
- 017 T016 is recorded complete after independent exact-head review ACCEPT at `14e6ba7450ee0858e091fa03ac2fbfc74df88ecd` (+4319/-603, 36 files) and a merge review ACCEPT at `3cf4e48`; merged in PR #122 as `5799142c8437b725a43984f02f9636ff5631a5e8`. The build review re-ran the focused suites in a temporary sibling copy (413/413: voice-session 171, voice-cancel-registry/-ipc/-request/-service/-transport 56, speech/dictation-hook/ambient-panel/voice-receipt/voice-cancel-journey 118, ipc-handlers and browser-api 68), `tsconfig.node.json` clean, `tsconfig.web.json` failing only on the known pre-existing WorkspaceView TS2322 (`BoundChapterHistoryApi | null` vs `ChapterHistoryApi`). The merge review was read-only: 35 of 36 merged files blob-identical to the accepted build, `CHANGELOG.md` the sole difference (union of both parents, intact), no task box moved vs origin/main, and the only checkbox delta vs the accepted head (`039 T005`) arrived byte-identical from origin/main.
- What landed: host-minted public operation ids (minted before any route resolution; the renderer never sees the internal ledger id), reservation-before-mint with a bounded reservation set, per-send/per-chunk route rechecks (saved selection, connection, provider/model/voice, endpoint identity `endpoint:<sha256[:16]>`, host revision bumped on every voice-settings write and connection removal, session token and permission) that refuse with zero provider calls, typed success/refusal/failure/cancellation outcomes, honest none/reported/unknown/mixed charge states (a reported zero renders as `Provider-reported cost: $0.00.`; unknown never renders as zero), an additive `voice.operation` IPC channel plus `voice:operation-event` and a browser-build refusal, renderer Stop controls and `role="status"` receipt lines (`voice-receipt` / `ambient-voice-receipt`). No persistence was added: receipts are memory-only and a restart honestly forgets them. Disclosed deviations, all judged benign by review: the `live-checks.ts` signature-only adaptation for the manual diagnostic; the `ipc-handlers.test.ts` migration to the scope contract; the one-line tsconfig include/exclude for the new DOM journey test; and the `stateOf` type-narrowing helper in `voice-request.ts`.
- Non-blocking notes carried forward: stale `refuse` doc comments in `transport.ts`/`voice-cancel-registry.ts`; `use-speech` has no pre-`starting` cancel-arm path (UI-phase guarded); the `voice.cancel` legacy fallback without an owner check when no request host is attached; `VoiceCancelRegistry.view()` mints a fresh `viewRevision` per call. Evidence is synthetic-only: fake mic/recorder, in-memory vault, scripted fetch; no live provider, microphone, device, packaged app or real manuscript was exercised or claimed. 038 T022 remains unchecked and out of scope; T017 and the device/packaged evidence gates remain open.
### Reader review rerun comparison (039 T005) task record
- 039 T005 is recorded complete after independent exact-head review ACCEPT at `2ab19d3783c69b83ed9640d60ab1586045676dca`, an ACCEPT merge review at `c1b1582666f59f6a1b5bd5d44d0ee76efbae5b7e` and PR #119 merged as `9f78a10b22fd8908e21178677fa2b2223b9154d7`: volatile per-run profile/provider/model/connection attribution, an append-only volatile attempt history capped at 8 with no eviction, and an explicit rerun comparison of the latest two completed runs (classified changed facets, exact returned-finding counts, model-variation labeling; no score, rank or improvement claim). After the merge conflict resolution the merged reader-review suites were re-run green (builder/coordinator-reported, not re-run by the reviewers, whose re-verification was static): 15/15 journey, 131/131 reader-review+host+ipc+saved-review, 48/48 scoped-readers and 486/486 core review; the journey sentinel expectation is now `["synthetic-sentinel.json"]`. Non-blocking notes: the §7.4 "no focusable elements" wording versus the §7.2-mandated native `<details>` disclosure (the comparison region keeps exactly one focusable summary); the per-attempt "Exact attribution" disclosure adds focus stops, including on the legacy saved-review path; the rerun-comparison entry's stale "T008–T009 remain open" wording is corrected below in this record; the builder-reported scoped-readers double-run anomaly could not be reproduced and is not a defect. No live-provider, built-app, packaged-app or device evidence is claimed; those stay with T009. T001, T006, T009 and T010–T019 remain open; T006 still carries U-039-04; 038 T022 remains unchecked.
### Export safety
- The Markdown folder rechecks cancellation, consent and plan identity at the commit boundary; post-publication staging cleanup is reported as a published warning with its exact path; single-file DOCX/PDF/EPUB/Markdown exports gain attempt-bound cancellation before publication; a folder-name field makes repeat exports explicit; an existing folder is still refused. T016/T017/T019 remain unchecked.
### Reader review rerun comparison
- The volatile reader review now keeps an append-only per-session attempt history of at most 8 attempts, oldest first, covering completed, failed, stopped, invalid-result and unknown outcomes. Attempts are never edited, reordered or evicted; only Close, a book/view change or unmount discards them. At 8 attempts the Prepare action is disabled with an `aria-describedby` cap note, and no ninth attempt is created. A stopped Start records its attempt when Stop is pressed, even though the late Start resolution is ignored.
- Every attempt keeps its prepared disclosure and attribution: the complete frozen profile snapshot, provider/model/connection facts (including the renderer-only connection label, never written to the envelope, request or any record), terms and consent facts, and the scope and request identity. Failed, stopped, invalid-result and unknown attempts render as `Reader attempt {id}` sections with no findings, Save or navigation; completed attempts keep the historical article. No writer, storage, report, thread or profile path is added.
- `compareReaderRuns` now reports classified changes between the latest two completed runs: identical-input/changed source/profile/destination/request/multiple-changes/not-comparable, per-facet booleans, added/removed/revision/content/selection/label source changes matched by stable identity (never request-local ids or capture times), profile edit versus fork detection, exact UTF-8/resource counts, by-category counts, verified/withheld evidence counts and partial-evidence detection. Validation failure returns `not-comparable` with no counts. Counts describe returned findings only — no score, rank, improvement claim, cross-run finding identity or disposition carry-over; same-input variation is labelled model variation.
- The comparison is a pure render with no provider call, write or focus shift: facet rows, a labelled source-change list, collapsed per-category counts, captured-revision and not-manuscript-coverage notes, and exact copy for empty, single, no-completed, partial, identical and changed-input states. The saved-review path keeps the legacy `runs` prop and renders no comparison. 039 T005 was subsequently reviewed (build ACCEPT at `2ab19d3`; merge ACCEPT at `c1b1582`), merged in PR #119 at `9f78a10` and recorded complete. T001, T006, T009 and T010–T019 remain open; 038 T022 remains open.

### Routing handoff — author-chosen candidate
- The writing-agent composer gains an optional “Preview models” entry (rendered only when the host wires it) that opens the existing task preview. The preview is fed by an in-memory snapshot of the catalogues the model picker already loaded through its explicit open/load; it never fetches, never touches credentials and is lost on reload. With an empty snapshot it shows the no-model-list refusal before any profile is chosen and no bridge call is made.
- The accepted D-204 data lands: the three version-1 profiles (Discuss the book, Draft new prose, Revise existing prose) ship as `WRITING_TASK_PROFILES`, each requiring tool support and a known catalogue context, and `requirements.requiresKnownContext` is now part of the profile schema. A model with an unknown context size evaluates as Unknown with the existing `UNKNOWN_CONTEXT_NOTE` reason and is never eligible; `UNKNOWN_CONTEXT_NOTE` is exported from the routing module without any wording change.
- The preview shows the accepted "Known capability match" / "Does not meet known requirements" labels, a visible "Listed in catalogue order; this is not a ranking." note, the host-supplied note that all three tasks share the same requirements, and the static "No total is shown because the request size is unknown." sentence. Candidates stay in catalogue order; there is no score, price order, single suggestion, Apply or Reject control and no consent checkbox.
- An eligible candidate offers "Use for next message", which opens the existing one-turn picker seeded with only `{ provider, modelId }`. The picker reuses its explicit load path, preselects the connection and candidate only when exactly one usable connection exists (otherwise the author chooses, never the first credential), refuses with a plain reason when the candidate or every connection is unusable, revalidates on confirmation, and — only through its existing confirm — sets the one-turn override. The book default, connection, conversation, consent and manuscript are untouched, and Send remains the only dispatch trigger; cancelling leaves everything unchanged. No IPC channel, preload method, provider call, vault read, persistence or task-record write is added. T016 stayed unchecked at merge time pending independent review; it is now recorded complete (see “Routing handoff (036 T016) task record”).

### Reader review read-only verification (039 T008)
- 039 T008 is recorded complete after independent exact-head review ACCEPT and merge `8d71814` (PR #116, head `9c526879c5ffa1321e958789952163023a609720`): a test-only proof of read-only enforcement for the merged reader-review path (T002/T003/T004). Three new files (`packages/core/tests/review/injection.test.ts`, `apps/desktop/tests/review-readonly-boundary.test.ts`, `apps/desktop/tests/support/tree-fingerprint.ts`), eight extended suites and the one merge-time CHANGELOG entry; no product source, spec, task or dependency change. Reviewer re-run: 320/320 across the nine memo files, 465/465 in the core review sweep, 46/46 in the boundary suite; node/web typecheck only the known pre-existing `WorkspaceView` diagnostic. Whole-tree SHA-256 fingerprints now back prepare/start/stop/cancel and every failure row; the boundary scan enumerates the review data-plane files explicitly rather than globbing them, so a future reader-path module could escape the scan until the list is updated; one journey assertion was re-anchored after the deliberate write-and-restore, with coverage strictly increased; the T004 provider-failure/overflow hash-assertion residual is partially covered by the whole-tree service-level assertions. Live-provider, built-app and packaged-app evidence remains T009; no such claim is made here. T001, T005–T006, T009 and T010–T019 remain open; 038 T022 remains unchecked.
### Reader review verification (039 T008)
- Test and documentation only: no product source, spec or task box changed in that merge. New proof that the merged reader-review path (T002/T003/T004) is read-only, injection-resistant, overflow-safe, stop-honest and retry-free.
- Whole-tree SHA-256 fingerprinting of the synthetic library (new test-only helper, `apps/desktop/tests/support/tree-fingerprint.ts`) replaces two-file spot checks in the review journey and backs every service-level path: prepare, start, stop, cancel, and every failure row leaves the entire tree byte-identical, including a second unselected book, a `threads/` sentinel and a conflict-copy candidate. A dynamically enumerated writer spy wraps every method on the desktop `Library` facade and the wrapped service/threads/images/review-records/campaign-continuations surfaces; anything not on the small read-only allowlist must show zero calls.
- New injection corpus (`packages/core/tests/review/injection.test.ts`) pins the trusted system message byte-for-byte across hostile prompt, feedback, source, title, profile and story-bible payloads; tools stay empty, the destination and consent are re-derived, digests flip on any single-character change (64-mutation sample) and forged envelopes or mismatched story-bible digests are refused. Output-side cases cover misattribution, extra fields, unselected-quote and bidi/zero-width/homoglyph mismatch, gap-crossing citations and 501-scalar quotes.
- Service-level failure matrix extended: exact 262,144-byte output completes and one byte over fails as `overflow`; contradiction-claim mismatch, contract-violating transport output, refusal-shaped 200 bodies and unmatched 4xx bodies all end as one-call `failed` outcomes; a spurious AbortError is a provider failure, never a stop; stop during output validation deterministically discards the run. Per-class renderer copy stays pinned, a markup interpretation renders as inert text, a navigation refusal is keyed per run and is not replayed onto a rerun, provider-error bodies with instruction text never reach the DOM, and the IPC boundary is enumerated (exactly one `readerReview:request` channel, five bounded preload operations, `__proto__`/`constructor` pollution probes refused).
- Static boundary scan (`apps/desktop/tests/review-readonly-boundary.test.ts`) fails on any forbidden import or capability in the review data-plane modules, the preload, the browser stub and the reader-review components; the browser stub refuses every operation; the IPC map names exactly one reader-review channel. Residual: the post-validation stop window is covered by the transport-injected deterministic test rather than a product hook. Live-provider, built-app journey and built-bundle claims remain T009.
- 039 T008 was subsequently reviewed, merged in PR #116 at `8d71814` and recorded complete. T001, T005–T006, T009 and T010–T019 remain open.
### Review smoke evidence navigation
- The hidden desktop smoke fixture now repeats “The lighthouse keeper” in The Light, and a new check reopens the retained review, waits for an enabled evidence control, opens the first occurrence and asserts the manuscript selects exactly “The lighthouse keeper” with the chapter still saved. The existing stale check now also proves every evidence control is disabled while stale. Smoke fixture and check coverage only; no product source, review runtime or task box changed, and T016 stays unchecked until the hidden smoke passes on a capable host.

### Routing taxonomy and handoff decisions
- The 2026-11-07 delivery authority accepts spec 036's four Phase-0 decisions as D-204–D-207: three author-selected writing-task profiles requiring tools and a known catalogue context; no ranking or single suggestion; no local request-size estimator or total cost; and only a two-step handoff from an author-chosen candidate to the existing one-turn picker. T015, T017 and the new-total portions of T008/T018 are recorded as deliberately not selected, and T016 remains unchecked and unblocked only for the narrow handoff. Two acceptance conditions close the packet premises: every writing-agent profile must require a known context so the preview never marks a model eligible that `canRunAgent` would refuse, and a future production mount must use catalogues already loaded by an explicit picker/refresh or a read-only cached-summary seam rather than calling `ProviderService.models()` on open. No preview mount, provider call, route store, estimator or product code is added.

### Reader review T004 task record
- 039 T004 is recorded complete after independent exact-head review ACCEPT and merge `7ef30b5`: the reader-review request carries the requested findings schema with `tools: []` / `{}`, one `generateText` call, one-pass output validation at 262,144 bytes, exact UTF-16 quote and source checks, withheld invalid citations, an explicit Check current sources action, editor-seam navigation and stale/unavailable states. Focused seven-file 179 pass, core review 396 pass, review-ipc 5 pass, saved-review 22 pass; node typecheck clean and web only the known pre-existing `WorkspaceView` diagnostic. Non-blocking residuals remain: the mounted `WorkspaceView` keyboard journey is T009, provider-failure/overflow hash assertions are partial, source-check map completeness, and task-note wording. T001, T005–T006, T008–T009 and T010–T019 remain open.
### Reader review schema validation and citation navigation
- Reader-review provider requests now put the requested findings JSON Schema in the same sent system message, serialize `tools: []` on the wire and send `tools: {}` at the one AI SDK call with `maxRetries: 0`, the signal and no output/tool-loop options. One call, no retry, repair, fallback, model change or second completion. Guided review keeps its existing wire.
- Provider output is parsed once against the strict findings schema and the 262,144 UTF-8 byte bound. Non-string, invalid JSON, fences, trailing prose, missing/extra fields, unsupported categories, attribution/count/byte failures end incomplete as `failed` with no run displayed; invalid individual citations are withheld and counted, never fabricated.
- Exact captured UTF-16 quotation spans, book/chapter identity, saved version and raw-file SHA-256 remain the only evidence rules; there is no normalization, whitespace folding, fuzzy lookup or nearest-match relocation. Current saved sources are compared separately, with new stale/missing/ambiguous states and no throw into the renderer.
- A new explicit Check current sources action performs one read-only saved-source read for the prepared envelope and completed runs, reports per-run not-checked/current/stale/unavailable/check-failed status and disables exact-passage navigation for stale, missing or unavailable sources while historical quotes, labels, revisions and withheld counts remain. No automatic check, watcher, report write or provider call occurs.
- Show exact passage now re-reads the exact saved chapter and selects only the exact current span through the existing ManuscriptEditor evidence seam, with a same-chapter and pending-chapter-switch guard. It never flushes, saves, writes, retries or starts a provider. Failed or aborted navigation keeps the historical quote and disables that link for the session. The results leaf keeps one region and one polite status, uses unique accessible evidence names and adds no Apply/Reject or model chooser.
- 039 T004 was subsequently reviewed, merged and recorded complete. T001, T005–T006, T008–T009 and T010–T019 remain open.
### Reader review focus and provider errors
- Opening the Reader review now moves focus to the Structured reader review heading after the panel mounts, and the focus test asserts the active element instead of page text. AI SDK transport failures are normalized through the shared provider-error mapping, so context maps to overflow and refusal maps to refused; the remaining provider failures stay the generic provider reason.

### Reader review task record
- 039 T003 is recorded complete after independent exact-head review ACCEPT and merge `03622b6`: the disclosed volatile selected-source prepare/start, accepted U-039-04 bounds, known/unknown price, provider-published terms, 011/022 consent, provider-named single-use Start, zero-send cancel and one-call/no-retry path. Focused nine-file 149 pass, core review 383 pass, saved-review 26 pass; node typecheck clean and web only the pre-existing `WorkspaceView` diagnostic. Non-blocking follow-ups remain for AI SDK response contract/tools serialization, a standalone cancel-preparation control and proactive staleness. T004–T006, T008–T009 and T010–T019 remain open.

### Reader review selected-source start
- Workspace now mounts a Reader review entry above Saved reviews. The author explicitly opens it, chooses Alpha or Beta and whole saved chapters, optionally writes a request, and presses Prepare review. The review shows the exact provider, model, connection label, destination details, known unit prices or unknown cost with no dollar-cap claim, provider-published data-use/training terms, exact byte counts, profile, selected text, prior-feedback absence and required 011/022 consent before a provider-named Start. Nothing prepares or starts automatically.
- One bounded `readerReview:request` IPC surface carries support, prepare, start, stop and cancelPrepare through Zod validation and the Result envelope, with a preload bridge and a browser/unsupported-host stub that refuses before any private read. The desktop service reads one saved book through a read-only port, captures exact saved versions, raw-file SHA-256, UTF-16 ranges and text, and enforces the existing 4-book/64-item/65,536-source/131,072-combined/262,144-request/262,144-output bounds without clipping, splitting, summarizing or fuzzy matching.
- Start sends only the request id and scope digest. The main process re-reads and compares the exact source revisions, re-resolves the pinned connection and model, re-derives 011 plan/capability facts, terms and 022 default-off book consent, consumes the request once and makes one transport call with no retry, repair, fallback or model change. Missing or revoked consent, stale or deleted sources, a changed destination or digest, malformed or oversized selections and pre-Start cancel all refuse with zero provider calls. Stop is best-effort and never claims recall or rollback of sent text. Every path is volatile: no conversation, report, profile, campaign, checkpoint or manuscript write occurs. 039 T003 was subsequently reviewed and merged; T004–T006, T008–T009 and T010–T019 remain open.
### Plan notes status

- The 031 plan and implementation notes now record the delivered source/test state: T001–T021 are checked, including the proposed-plan guidance refresh and the visible plan lifecycle, with the separate live/device/release limits. 037 autonomy stays separate.

### Delivery index reconciliation

- The spec index and agentic coverage record now describe spec 031 as delivered at the source/test level: all T001–T021 tasks are checked, including the proposed-plan guidance refresh, the visible plan lifecycle, pause/resume, cancel, restart expiry, the failure matrix, accessibility and the synthetic author journey. Live provider, real manuscript, device, packaged-build and release acceptance remain separate.

### Plan task record complete

- T012 is recorded complete after the visible proposed-plan guidance refresh was independently reviewed and merged. All spec 031 tasks T001–T021 are now checked. The record claims source/test delivery only; live provider, real manuscript, device, packaged-build and release acceptance remain separate.

### Plan guidance refresh

- A proposed plan's card now offers one visible Edit guidance control. Saving writes exactly one new plan revision through a plan-scoped `agent.refreshPlanGuidance` bridge, keeps the plan proposed, and updates the visible revision and Start line; blank or whitespace-only text clears the stored guidance, 2,000 characters are accepted exactly, and 2,001 are refused without truncation or a write. The refresh starts no turn, asks no model, builds no tool set, writes no chapter or book bytes, changes no approval or checkpoint and publishes no event, and Start still sends the displayed revision with no guidance and uses the plan's stored guidance. Running, waiting, pause-requested, paused, completed, cancelled, failed and expired plans show their guidance as a record with no editor. T012 was recorded complete after independent review and merge.

### Plan delivery record

- The spec 031 task record marks T005, T006 and T013–T021 complete: the thread and turn contracts, the Plan first control and durable proposal, Start and observed step progress, pause/resume, terminal cancel, restart expiry, the failure acceptance matrix, the accessibility pass and the synthetic author journey. T012 was then still open because no visible stored-plan guidance refresh was mounted. The final verification records a clean node typecheck and toolkit typecheck, only the pre-existing `WorkspaceView.tsx:1816` web diagnostic, a full-suite result of 4,941 pass and 1 skip with one pre-existing editor-sync timing failure, and a smoke run blocked by that pre-existing typecheck plus the host's missing SUID sandbox. No live provider, real manuscript, device, packaged-build or release acceptance is claimed.

### Synthetic author journey

- A new tests-only synthetic journey drives the real chat panel, the real agent runtime and a temporary library through Discuss (a refused write with unchanged chapter and book bytes), an Edit write with one-turn undo, an Ask for plan proposal that writes nothing before Start, an explicit Start with observed step progress, a destructive step held at the existing approval where the plan card offers only Pause and Cancel, and a Cancel that keeps two completed steps and one written chapter, expires the approval and leaves the destructive text absent; reopening the library and a new runtime reads the cancelled plan, expired approval, checkpoint and mode labels, with one model chooser and no generic Apply/Reject or plan approval control. The journey passes and pins the established contracts: `undoAvailable` records that a checkpoint was saved rather than that a change exists, so the no-change Discuss turn reports `changed: 0` with no undo control and an empty checkpoint list; and the checked-writer undo restores the chapter text while the save counter and timestamp advance, so the test compares the restored content rather than the raw file hash. No product file changed and no task box is closed.

### Plan accessibility
- Plan review is now keyboard and screen-reader complete without changing plan state. The plan card is named by its heading and described by its visible status, one polite region announces confirmed status and step changes only, request text is not read into it, and status wins over step updates. Start, Pause, Resume and Cancel move focus to the card heading after acceptance; refusals return focus to the re-enabled control and stay alerts; Cancel opens on Keep plan and Escape or Keep returns to Cancel. Plan-first request and guidance limits are described by their visible counters, step add and remove keep focus in the list, a refused Ask for plan returns focus to Ask, and the composer no longer mounts a second plan card. A new proposal is announced once by the conversation and focuses the card heading, and a stale expiry warning is one alert instead of two live statuses. No CSS, runtime, persistence, permission or plan-state rule changed, and no task box is closed.
### Plan failure acceptance
- A synthetic acceptance matrix now proves the merged plan runtime stays truthful through a provider failure after a real write, a checked-writer save conflict with a kept replacement copy, a checkpoint failure that leaves the write but no undo, a complete-and-fail double write failure, a step-close failure after a real write, and a store conflict at the step boundary. Each row pins the terminal event, stored plan status and step states, chapter bytes, checkpoint facts, plan notices and the real `changed`/`undoAvailable` values; no row retries, rolls back or invents a lifecycle. The failed-turn paragraph now says “Undo it before retrying.” only when the terminal event confirmed `undoAvailable`; otherwise it says “Review the affected chapters before retrying.”, so the checkpoint-failure and skipped-undo cases no longer claim an undo the runtime cannot confirm. No task box is closed.

### Plan expiry
- A stored plan whose runtime this process lost is now settled lazily, per conversation. Opening a thread (`agent.threads.read`) or starting any turn that names a thread sweeps that thread after the book read and before plan resolution, provider credentials, models or any stream; it expires the one non-terminal plan (`proposed`, `running`, `waiting-for-approval`, `pause-requested` or `paused`) with exactly one checked `expire` transition, and writes nothing when the plan is terminal, has a matching live plan turn, or was proposed, started or resumed by this process. A process-lifetime ownership set makes a new runtime treat old plans as lost, while a renderer reload with the same runtime reattaches the confirmed live plan turn from the read result. The read now returns `{ thread, planRuntime, expiry? }`: `planRuntime` names the live plan id, turn id and phase for reattach, and `expiry` reports `expired`, the terminal winner or an honest failure message. A failed expiry is attempted once per plan per process, reported again without a retry, never deletes or relabels the plan, and refuses a start before any provider call; `stale` suppresses Start and Resume while the existing Cancel path stays available where the direct rules allow it. The expired card keeps its step states, shows Expired with a fixed no-start/no-resume/no-replay note and no Start, Pause, Resume or Cancel. The direct cancel path now re-reads once after a terminal refusal so an expire that won the race returns the stored terminal plan instead of throwing. No clock, boot scan, cross-book or cross-thread sweep, synthetic event, replay, resume, deletion, approval-part expiry or task box is added or closed.

### Plan cancel

- A stored plan can now be cancelled terminally through a new plan-scoped `agent.cancelPlan({ bookId, threadId, planId })` bridge; the turn stop channel is unchanged. A live plan turn closes the host dispatch gate before the first await, expires a pending approval through the existing approval protocol, publishes one `stopping`, writes exactly one `cancel` transition, settles every in-flight call, writes the checkpoint and stopped message, and publishes one `stopped` with the real changed-chapter count, undo availability and any fixed `planCancel` warning. No later tool starts; an already-executing write finishes and is reported; the cancel transition closes every open step to `not-completed` while completed steps stay completed, and no completed write is rolled back. A proposed, paused or failed-confirm `pause-requested` plan with no live turn is cancelled by one direct write and no synthetic turn events; a `running` or `waiting-for-approval` plan with no live turn is refused for restart expiry. Duplicate live cancel writes once, duplicate direct cancel is an unchanged no-op, a failed cancel write never claims cancelled, and a completion that wins the race stays completed. The plan card gains an inline-confirmed `Cancel plan` action with `Cancelling…` and `Cancelled` states, completed/not-completed step reporting, `Completed steps stay. Cancel does not undo them.`, and no Pause, Resume, Start or generic Apply/Reject on a cancelled plan; a new Plan-first proposal is allowed after cancellation. No status, event shape, persisted field or store method is added. No task box is closed.

### Plan pause and resume

- Stop on a live plan turn is now Pause. The runtime closes dispatch, publishes `stopping`, starts exactly one `request-pause` store write and releases any pending approval; the run's settlement barrier still waits for every in-flight call, writes the checkpoint and stopped message, attempts one `confirm-pause`, and only then publishes the terminal `stopped` event. Pause writes no step outcome: an open step stays in progress, the in-flight tool keeps its receipt and change count, and no plan-step notice is emitted after the stop gate. Request or confirm failures publish `plan-error`, leave the plan at its last confirmed status, and add the fixed `planPause` warning to `stopped`; a failed state write blocks confirmation. A never-settling call leaves the turn stopping with no terminal event, and a plan that completes during the stop race is shown terminal, never Paused. The plan card offers Pause only on a live running or waiting plan, says `Stopping…` until the terminal event, shows Paused with the stopped change and undo facts only after `stopped`, and offers Resume only on a paused plan with no live turn. Resume sends the identity-only `{ id, revision, action: "resume" }` with the fixed prompt “Resume the reviewed plan.”, mode Edit, no composer guidance and a fresh per-turn approval; it is an ordinary new turn through the existing runtime path. A `confirm-pause` notice alone never changes the label or refreshes stored plans. There is no Cancel, retry, auto-resume, replay or restart sweep, and no task box is closed.

### Plan review

- Plan first is now a proposal request, not a local plan. What the plan should cover is required and bounded to 2,000 characters; up to 50 ordered suggestions are optional, each bounded to 2,000 characters; guidance is optional and limited to the request. Ask for plan sends one read-only Edit proposal turn with `planProposal: true`, disables the request fields while it runs, says “Proposing a plan…”, and keeps the author's text when no plan is stored. No Start exists before a stored plan.
- The conversation now reviews the stored plan the thread returned. The card shows the purpose, ordered steps with the confirmed states Pending, In progress, Completed and Not completed, the reviewed revision, plan guidance when present, and a status that names Running and Waiting for approval separately. Start plan is offered only for a proposed plan while no turn runs; it sends the identity-only `{ id, revision, action: "start" }` with the fixed prompt “Start the reviewed plan.”, mode Edit and no guidance. A refused Start removes its optimistic local rows and leaves the plan proposed. The renderer never advances a step from a click or a local draft: a step changes only from a confirmed notice or a thread read. The plan region keeps its place by plan id across the composer's return to Discuss, the proposal and step control tools are hidden from the author-facing tool list, and no plan control offers Pause, Resume, Cancel, Apply or Reject. No task box is closed.

### Plan execution

- A Start or Resume turn now writes confirmed step progress through the thread store. The model names one reviewed boundary at a time with a strict `plan_step` input (a 1-based integer only); the runtime writes `in-progress`, then closes the step `completed` only after at least one successful observed tool result and no failed results, or `not-completed` otherwise. A failed or denied tool result closes the active step immediately, fails the plan, blocks later ordinary tools and leaves earlier writes undoable; a step with no tool call is not completed. Approval waits and settled waits are written before the approval is published or the SDK resumes, so a failed plan write never starts the destructive action. Completion requires every step completed and the complete write applied; a refused or failed step/complete write emits a plan error and ends the turn as `plan-state`, never as completed. The terminal plan notice precedes the terminal turn event.
- A read-only Edit proposal turn offers the six read tools plus `propose_plan`, writes no book change and no checkpoint, stores its assistant message first, then adds the plan with that message and turn as parent and emits one `proposed` notice. A missing or invalid proposal and a failed `addPlan` end in an error with no plan. Start emits no plan notice; its running snapshot is the turn-start acknowledgement. Plan and proposal system rules are fixed text, and reviewed step text reaches the model only as bounded `plan_step` data. Pause, cancel, expiry and live guidance remain later work. The renderer plan control and plan card are not changed here, and no task box is closed.
- The execution loop keeps its existing 20-model-step cap. A plan longer than the cap fails honestly rather than completing in one turn; raising the cap or continuing a plan across turns remains later lifecycle work. A failed boundary close now attempts the one terminal fail instead of leaving the stored plan running. No task box is closed.

### Plan turn contract

- The main-process turn input accepts an optional identity-only plan reference: a stored plan id, the revision the author reviewed, and an explicit `start` or `resume`. The reference is strict; purpose, steps, guidance, model, tools and approval keys are refused before any book read, model construction, user-message write or provider request. A plan turn is Edit-only and needs an existing conversation. The runtime resolves the plan from that conversation, refuses a missing or foreign id, a stale revision, a non-startable or non-resumable status, invalid or over-bound guidance, an over-bound stored plan and unreviewed guidance with a fixed author-facing sentence, and records exactly one `start` or `resume` through the thread store before the first provider request. The start acknowledgment returns the confirmed mode and a `running` plan snapshot; a duplicate or uncertain write is refused, never treated as started. If setup fails after that write and before the provider request, one `fail` transition is attempted and the caller is told whether it applied. Additive `plan`, `plan-step` and `plan-error` event shapes and optional plan identity on the approval event are defined for later execution work but are not emitted by this slice. No renderer, approval, step, pause, cancel, expiry or restart-sweep behavior is added. T006 remains open.

### Reading position

- An in-memory cursor keeps a paragraph index for one caller-supplied source id and revision, moves only inside that frozen paragraph list, and accepts a speed from 0.25 through 4 without clamping. A different revision or a changed body is refused. It does not speak, choose a voice, or close a task box. No task box is closed.

### Voice cancel

- The desktop host keeps a registry of cancellable speech-to-text and text-to-speech request ids. Cancelling before a request is sent releases that slot and records it as unsent. Cancelling after it was sent aborts only the local request, keeps the slot until the local outcome is recorded, and leaves an unknown charge unknown. A second cancel and an unknown id change nothing. A late success or failure is recorded as a cancellation and does not release a newer request. The browser build refuses this cancel. This does not show that a remote provider observed the cancel. No task box is closed.

### Recent work pointers

- An in-memory recent-work list keeps one pointer per book after a successful explicit open, newest first. A later open of the same book replaces the older pointer. Listing, refresh, import, onboarding, review, and a background read do not record an open, and replaying an intent that already succeeded does not record it again. The same scope token keeps its pointers; a different token starts an empty list and leaves the previous list unchanged. A pointer stores only a book id, the caller-supplied display time, and that scope token. The recent-pointer budget is 2,500,000 UTF-8 bytes and may drop the oldest pointers until a new pointer fits. A pointer that cannot fit alone is refused. A missing or unusable writer is a refusal and is never called. Dismissal removes one pointer and does not change a book. No library screen, settings writer, or task box is closed.

### Plan state

- Conversations gain a bounded `plans` array on thread schema 1, oldest first, with at most one unfinished plan. Each plan records its `id`, `mode: "edit"`, status, purpose, ordered steps, revision, optional guidance, the Edit assistant proposal turn as `parent`, and ordered timestamps. The nine stored statuses and four step states are fixed, `started` is not stored, and terminal plans are retained and immutable. A pure transition module owns start, step progress, approval waiting, pause request and confirmation, resume, completion, cancellation, failure and expiry; the thread store refuses an impossible change, a second live plan, a duplicate id, a fifty-first plan, removal of a plan and any change to a terminal plan without writing. An unknown stored status or step state is reported as unsupported, and malformed plan state as corrupt; neither rewrites or deletes the file. A fork starts with no plans. No provider, runtime turn, IPC channel, composer control, renderer view or task box changes.

### Proposed plan

- `createProposedPlan` builds a frozen Edit proposal from a caller-supplied id, a short purpose, and one or more ordered steps. Every new step is pending. `refreshProposedPlanGuidance` returns a new revision with that guidance and leaves the previous proposal unchanged. Blank guidance is omitted. Guidance over 2,000 characters is refused and not truncated. Guidance over 2,000 characters is refused before a blank check, including whitespace. A Discuss proposal, or a proposal that is running, paused, started, waiting, or terminal, is refused. `planStartIntent` names a new turn for the current proposal id and revision and carries no approval. The supplied writer is not called. This does not write the manuscript, start a turn, or close a task box.
- Plan first is mounted on an Edit turn. It shows a purpose and ordered pending steps, refreshes guidance onto a new revision, and leaves the previous proposal, mode, model, tool permissions, and approvals unchanged. Blank guidance is omitted. Guidance over 2,000 characters stays in the field and is refused without truncation or a write. A running turn does not accept a guidance or plan refresh. Start plan is shown only for the current proposal and only names a new turn, the proposal id, and the current revision, with no carried approval. It does not start the turn, persist the plan, or approve a tool. Durable plan persistence and start execution remain open. No task box is closed.

### Independent continuation and stop

- In-memory `reduceRun` tests prove a dispatched attempt whose impact does not share the changed direction keys stays that same live attempt: not historical, same generation, still `dispatch-intent`, and its task direction unchanged. A later `output-kept` then `completed` finishes that one attempt. Tasks whose impact matches, and a task whose impact is incomplete, take the new direction. The incomplete-impact task is projected `ready`, not `blocked`. A later `stopped` on that same attempt closes it; later `output-kept` and `completed` are refused, the task is `failed`, and another prepare is `task-not-ready`. Run-level pause, cancel, and revoke are unchanged. No reducer change. No task box is closed.

### Checked collection and annotation records

- Library-root `collections.json` and per-book `annotations.json` now save through the existing checked commit. Collections keep stable book ids, archive in place, and refuse an active-name collision until an explicit rename-and-restore. Annotations keep an exact saved-body span; a note-only edit leaves a stale anchor, and neither write changes chapter bytes. No library screen, recent-work list, or task box is closed.
- Adding a book that is already a member does not sort or rewrite a current collection. A real membership change still stores the sorted id list. Excerpts use the 20,000-unit prose limit, and membership has no id-count cap; serialized size stays within 2,500,000 bytes. No library screen, recent-work list, or task box is closed.

### Dictation insert

- Default dictation inserts at the selection start and keeps the selected text. Replace selection is a separate one-shot control. A transcript keeps its line breaks; a transcript with none still joins surrounding prose with a single space. Both paths use the existing editor compare-and-set and one isolated undo. No task box is closed.

### Host permission descriptor

- A host-local permission descriptor can be validated. A copied descriptor is not execution permission. The pure codec does not store the descriptor, resume a host, or close a task.
- The authoring boundary now says that descriptor and its format section are present. The workflow codec still does not hash bytes. The host-permission codec hashes the exact input bytes only when a caller supplies an expected hash. It still does not store the descriptor, resume a host, or close a task.

### Desktop chapter history

- The desktop writing screen can open saved chapter history from More when a chapter is selected and the host exposes history. The entry lists, opens, compares, and captures that chapter's saved history for the current visit. It does not restore, and it does not add a browser history runtime. No task box is closed.
- An open chapter history visit keeps one adapter, so an ordinary re-render does not list again or clear the record on screen. Deleting a different chapter no longer replaces the open editor's save status with a saved state. No task box is closed.
- Desktop IPC and the preload bridge expose capture, list, open, and compare for one chapter's saved history. A record is named by its stored file name. Capture is refused while that chapter's unsaved text or a kept failed save is still held, and it does not flush or save. List, open, and compare do not change chapter or history bytes. Restore, undo, reconcile, and delete stay off this surface. No task box is closed.

### Invalidated task projection

- `projectInvalidatedTasks` builds the next task revisions for one direction's impact keys. An incomplete impact or a shared key matches, and a task that depends on a match matches too. A dependency that does not match is left out. The result is a frozen copy in input order: revision plus one, a sha256 base of the caller-supplied digest at the old revision, the supplied direction reference, `retryAllowed: true`, and the caller-supplied timestamp. A cached `status` is dropped. `currentAttempt`, `needsDirection`, `generation`, `createdAt`, and `definition` are copied. It does not hash, write, mark an attempt historical, clear a live attempt, bump generation, compare the new direction with the task's current direction, step the run, schedule, or resume cadence, and the host does not call it. No task box is closed.

### Direction persistence

- `readDirection` and `createDirection` store one immutable direction epoch when `directions/<directionId>.json` is absent. The existing direction codec still checks the previous link. Revision 1 has no previous direction. A later epoch is a different id. The store does not open or hash the previous direction file. The same bytes are unchanged. Different bytes for that id are kept as a conflict copy and the active file stays. This writer does not answer a question, step the run, schedule, or resume cadence, and the host does not call it. No task box is closed.

### Answered question projection

- `projectAnsweredQuestion` builds the next question revision after `checkVersionedAnswer`. The check runs first, so a stale question or a missing answer refuses before the timestamp or previous digest is read. The timestamp must be UTC. The previous digest must be 64 hexadecimal characters; this function does not hash the question. The result is a frozen copy at the open revision plus one, with a sha256 base naming that digest and the open revision, state `answered`, and an answer of the checked texts, a copy of the proposed direction reference, and that timestamp. `updatedAt` is the same timestamp. Generation, `createdAt`, and the question's other own fields are copied. It does not write, create a direction, step the run, schedule, or resume cadence, and the host does not call it. No task box is closed.

### Versioned answer check

- `checkVersionedAnswer` checks one already decoded open question, the revision the author named, one proposed answer, and the direction epoch that answer would create. Silence (`null` or a missing answer) is not an answer. A question that is not open, or a named revision that is not the question's current revision, refuses as `stale-question`. Exact and confirmed text are copied separately and need not match. The direction must have origin `answer`, name this question at that open revision, be a new epoch under the existing previous-link rule, and its `exactText` must be the confirmed text. The answer's direction reference must name that direction record. The check returns those identities and the two texts. It does not write, step the run, schedule, or resume cadence, and no task box is closed.

### Question inbox

- `projectQuestionInbox` projects an already listed question set into open questions only. Each entry copies the id, the open state, and an explicit `irreversibleChoice` boolean. A record without that field stays unclassified: the field is omitted, not stored as false or null. A present non-boolean is refused. The projection keeps no question prose. More than 10,000 inputs refuse before inspection. A listing whose own `total` is not the question count, or whose own `offset` is not zero, refuses as a partial list. It does not answer, write, schedule, or resume cadence, and no task box is closed.

### Campaign stage documentation

- Current delivery notes no longer list a stage-kind mapping as an open authoring-contract gap. A campaign stage kind is refused as an authoring role and is not mapped onto one. The completion lane and the current review-routing gate record the same refusal. The check-in word-count source and the cadence contract remain open. No task box is closed.
- The current bounded implementation queue names those two open gaps and records the same stage-kind refusal. No task box is closed.

### Campaign stage role refusal

- `refuseCampaignStageRole` records that a campaign stage kind is not an authoring role. `range` and `synthesis` refuse as `campaign-stage-not-a-role` and never become a role or task. Any other value refuses as `unknown-stage-kind`. Existing roles are unchanged. The continuation check-in names that refusal, does not call it, and does not build a task from a stage. Cadence is not resumed and no task box is closed.

### Check-in word target

- `readCheckinWordTarget` copies an existing goal id and its positive saved word target for a later check-in. A null target, any schema other than 1, a different book, and a supplied campaign scalar or byte total (`selectedUtf16` or `selectedUtf8`, including nested) are refused. The reader does not count manuscript words, does not invent a goal id from the book id, and is not used by brief preparation or the continuation check-in. Cadence is not resumed and no task box is closed.

### Authoring question-state reading

- Question records may carry an explicit `irreversibleChoice` boolean. A record without that field stays valid and unclassified: absence is not pending, and option wording, consequences, keys, or character identity are not a classification. A present non-boolean is refused. `readIrreversibleChoicePending` counts only open questions whose recorded classification is true and returns ids and a count, not question prose. A new in-memory question stores false when its action omits the field. Blocking behavior is unchanged. Cadence is not resumed and no task box is closed.
- A question record that keeps an unknown `record` object is counted from its own `irreversibleChoice`. A store snapshot with `record` and no question `kind` or `state` still unwraps. Cadence is not resumed and no task box is closed.

### Workflow question listing

- Recorded questions can be listed without writing. `listQuestions` inspects the questions folder and treats a missing folder as an empty list. A library that cannot inspect names refuses. An unsupported name, a nested directory, a file whose name is not a question id, a record this version cannot read, or any other listing failure refuses the whole list and leaves the files untouched. The folder is classified and every question is decoded before a page is cut. A page is at most 256 questions and a run is at most 10,000. The page is store snapshots the pending-question reader can count. Cadence is not resumed and no task box is closed.

### Authoring adoption receipt publisher (037 T032 partial)

- Record adoption receipts from the Library publisher on confirmed
  adoption (037 FR-017 / ADR 0019, serving 037 T032 adoption-based
  cadence). `LibraryService` now exposes the checked beside-store as
  `library.adoptionReceipts` (`AdoptionReceiptStore`, bound to the open
  library and its per-book queue, with no second writer), and
  `library.recordConfirmedAdoptionReceipt(bookId, runId, effectId, refs)`
  records exactly one receipt at the existing confirmation point: a checked
  effect record saved through `workflowRecords.saveEffect` with phase
  `confirmed` and a receipt carrying `resultVersion`/`resultHash`. The
  publisher allocates the next monotonic sequence by reading the current
  maximum from the store inside the per-book queue, distinguishes a
  retried confirmation (`already-recorded`, compared by owner, chapter,
  exact candidate, result version/hash, grant and direction) from a
  conflicting receipt for the same candidate, and settles an uncertain
  receipt write by byte-exact read-back before reporting it recorded. A
  confirmed adoption whose receipt cannot be recorded reports
  `confirmed-unrecorded` with the recording failure's code and claims no
  receipt; the confirmed effect is never rolled back. The confirmed effect
  record does not carry `grant` or `direction` references, so the caller
  supplies them from the current host permission and direction; they are
  never derived from the effect, policy or attempt. No new adoption, grant
  issuance or candidate creation, IPC, UI, host or cadence wiring is added.
  Cadence resume counting and reading `irreversibleChoicePending` from
  recorded question state remain open. 037 T032 and all 037/038/039 boxes
  remain unchecked.

### Authoring adoption receipts (037 T032 partial)

- Add the recorded adoption-receipt contract for guided autonomous
  authoring in pure core, so a later host slice can count adoption from
  recorded state instead of chapters present (037 FR-017 / ADR 0019,
  serving 037 T032 adoption-based cadence). `packages/core/src/authoring/adoption-receipt.ts`
  defines the versioned receipt (`schemaVersion: 1`, `kind: "adoption-receipt"`):
  one exact candidate as an `artifact` reference (body hash and revision),
  `chapterId`, the published chapter's `resultVersion`/`resultHash`, the
  adopting `owner`, `grant` and `direction` references validated by
  `validateReference`, and caller-supplied ordering (`sequence` and
  `adoptedAt`, bounded, no clock read). Unknown versions and malformed
  shapes refuse without coercion; snapshots are frozen without aliasing.
  Adding the `grant` kind to `ReferenceKind` is the only contracts change;
  no prior grant reference kind existed. `countAdoptedChapters` is the pure
  counter the cadence host will later call: given validated receipts for
  one book/run and an exclusive since-marker (sequence or adopted-at of
  the last taken check-in; absent means from the beginning) it counts
  distinct adopted chapters (a re-adoption counts once per window) plus
  `firstAdoptedChapterOccurred` for any adoption at all. It reads no prose.
  Checked storage sits beside `WorkflowRecordStore` in
  `packages/core/src/workflow/adoption-receipt-store.ts` under
  `books/<bookId>/workflows/<runId>/adoptions/<receiptId>.json`, following
  the workflow record-store pattern the checked question records use
  (not the single-book review store): the same per-book queue and
  journal-aware checked commit, canonical bytes re-parsed before
  publication, hash-verified byte-exact readback, owning-book checks and
  recoverable conflict copies. Added for receipts are strict absent-only
  creation scoped to the candidate, candidate/sequence uniqueness, and a
  bounded sequence-ordered listing; foreign book/run receipts refuse on
  read and list. No adoption itself, publisher behavior, IPC, UI, host
  wiring or cadence counting is added; receipts will be recorded by a
  future publisher slice. Synthetic tests cover validation, duplicate
  refusal, readback, foreign refusal, bounded listing and counter marker
  semantics. 037 T032 and all 037/038/039 boxes remain unchecked.

### Campaign continuation check-in cadence host supply (039 T018 partial)

- Host cadence supply through the `continuation:checkin` channel is
  withheld until adoption is countable. The host reader
  (`apps/desktop/src/main/continuation-checkin.ts`) would count saved
  words only with the canonical `countWords` over chapter bodies loaded
  through the existing `Library.readBook` reader, but adoption is not
  countable from recorded state in this build: no adoption receipts or
  provenance are recorded that distinguish a coordinator-adopted chapter
  from any other saved chapter, so chapters present cannot be named
  adopted chapters and `0` is also unverified. Cadence is therefore
  withheld (no `cadence` key) in all cases until adoption is countable
  from recorded receipts/provenance; the saved-word counting code is
  retained as the honest subset that resumes then but is not emitted
  today. The 037 question store primitive exists
  (`WorkflowRecordStore.readQuestion`/`saveQuestion`), but there is no
  durable question inbox, no irreversible classification, and no
  host-readable pending-irreversible source, so when adoption becomes
  countable `irreversibleChoicePending` must also be read from recorded
  question state or supply stays withheld — supply must not resume on
  adoption receipts alone. Supply remains scoped to the pre-checkpoint
  window (a checkpoint record or an unreadable chapter also withholds),
  and withheld cadence stays distinguishable from an evaluated cadence
  with `due: false` while counted check-in inputs still succeed without
  a cadence section. The channel still validates policy input and
  refuses renderer-supplied progress: the renderer may only choose the
  versioned cadence policy (`ReadContinuationCheckinInput.cadence.policy`,
  bounds mirroring `CHECKIN_CADENCE_LIMITS`, Zod-validated before any
  Library access); renderer-supplied counted progress is refused as
  `invalid`. The production no-coordinator `unsupported` refusal is
  unchanged, and no coordinator session is fabricated. Synthetic tests
  cover withheld cadence in the pre-checkpoint window (default and
  edited policy), the `countWords` oracle at the Library level where
  the counting unit remains reachable, checkpoint and unreadable-chapter
  withholding, malformed cadence input and the no-identity refusal. No
  UI change; presenter display of cadence is a later slice, and 039
  T018 plus all 037/038 boxes remain unchecked.

### Campaign continuation check-in cadence emission (039 T018 partial)

- Extend the pure continuation check-in adapter
  (`packages/core/src/review/campaign-continuation-checkin.ts`) with an optional
  cadence input: caller-counted progress (`callerCountedProgress`, field names
  exactly as the authoring contract names them) plus an optional policy validated
  by `validateCheckinCadencePolicy`. When the supplied cadence omits its policy,
  the ADR 0019 default (`DEFAULT_CHECKIN_CADENCE_POLICY`) applies as the
  documented adapter-level choice; a supplied malformed policy is never coerced.
  When cadence input is supplied, the adapter emits the authoring evaluator's
  result verbatim (`due`, `reasons`) plus the validated policy snapshot and the
  validated caller-counted progress as `checkin.cadence`; it counts nothing
  itself, so `savedWordsSinceCheckin` is never a word count derived from campaign
  prose. Malformed policy/progress refuses with the authoring vocabulary preserved
  (`unsupported-version`, `invalid-integer`, `invalid-cadence-policy`,
  `invalid-cadence-progress`), a campaign refusal (stale/partial/cross-book/future)
  wins and suppresses the cadence section, and omitted cadence input emits no
  cadence key (byte-identical to the pre-change shape). Synthetic tests in
  `packages/core/tests/review/campaign-continuation-checkin.test.ts` cover default
  and edited policies, all-reasons emission, malformed refusals, suppression,
  omission and deep-frozen inputs. Pure core adapter only: no Brief, graph, host
  channel, preload or UI change; host wiring that supplies cadence inputs is a
  later slice. The other two gaps stay open (`Brief.targetWords` has no campaign
  word-count source, campaign stage kinds have no Role/TaskDefinition mapping),
  and 039 T018 plus all 037/038 boxes remain unchecked.

### Authoring check-in cadence contract (037 T032 partial)

- Add the pure versioned check-in cadence contract to `packages/core/src/authoring/contracts.ts`:
  `CheckinCadencePolicy` (`version: 1`, editable `adoptedChapterInterval`/`savedWordInterval`,
  `afterFirstChapter` and `onIrreversibleChoice` triggers), the named ADR 0019 default
  `DEFAULT_CHECKIN_CADENCE_POLICY` (first adopted chapter, then three more adopted chapters or
  10,000 more saved words, whichever occurs first, plus irreversible choices), bounded
  `CHECKIN_CADENCE_LIMITS` validation (`unsupported-version`/`invalid-integer` vocabulary, no
  coercion or silent defaults), and the pure `evaluateCheckinCadence` due evaluation over
  caller-counted progress that counts nothing, reads no prose, reports every fired reason and
  treats exact thresholds as due. Synthetic tests in
  `packages/core/tests/authoring/cadence.test.ts` cover the default and edited policies,
  out-of-bounds/unknown-version/malformed refusals, each trigger, exact boundaries, multiple
  reasons and zero/negative handling. Pure core only: no IPC, UI, host wiring, provider calls or
  adapter changes; the continuation adapter does not yet emit cadence. This closes one of the
  three recorded authoring-contract gaps; `Brief.targetWords` still has no campaign word-count
  source and campaign stage kinds still have no Role/TaskDefinition mapping. 037 T032 and all
  037/038/039 boxes remain unchecked.

### Delivery documentation reconciliation

- Reconcile the public completion, concurrent-delivery, forecast, retained-delivery, spec-map and
  coverage docs with the merged Markdown folder chain (PRs #49–#54, subordinate gates closed, T014
  still open pending T016/T017/T019) and the merged campaign-continuation seams through PR #63
  (codec, compatible replan, checked storage, group/archive, fixed-history move, check-in contract,
  host channel, presenter and measurement). Record truthfully that no real coordinator session
  exists yet so the check-in channel and presenter refuse until one does, that no word-count source
  for check-in targets, no cadence contract and no stage-kind mapping exist, that the browser
  editor-focus check and bundle baseline drift predate the presenter and stay with their owners,
  and that all 039, 037 and 038 gate-owner task boxes remain unchecked. No behavior, task state or
  lane structure changes.

### Campaign continuation check-in presenter (039 T018 seam 6c)

- Mount the presenter surface for continuation check-ins in the workspace
  (`packages/app/src/components/continuation-checkin/`), beside the saved
  reviews and planning panels. Opening the panel reads nothing; the author
  names a campaign and presses Load check-in, and the panel shows only the
  counted inputs from the checked campaign record through the seam 6b
  client: campaign and book identity, revision, segment and stage tallies,
  checkpoint receipt tallies, and report tallies, with scalar and byte
  tallies labelled exactly as saved. The presenter counts nothing itself
  and shows no live generation, only a stored record. Each typed refusal
  keeps its own plain sentence-case state, a partly present campaign is
  never shown as a counted result, and with no active coordinator run —
  the state of this build — the panel says so plainly instead of showing
  invented check-in data. The 6b renderer client now keeps the typed
  refusal code so the presenter can show the state that happened. The
  hidden smoke run covers the mounted panel and its no-coordinator state.
  No new channel, preload, or Library change; 039 T018/T019 plus all
  037/038 boxes remain unchecked pending measurement and independent
  review.

### Campaign continuation check-in host (039 T018 seam 6b)

- Wire the accepted seam 6a contract through the desktop host as one
  read-only channel, `continuation:checkin` (core `IPC`/`StudioApi`,
  preload bridge, and an unmounted `must(...)` client helper for the later
  presenter slice; no UI screen is added). The main process validates the
  book and campaign ids with Zod before touching the Library, loads the
  checked campaign through the existing `campaignContinuations` store
  readers, and returns the counted check-in inputs from
  `mapCampaignContinuationCheckin` through the `Result` envelope — data
  only, never a path. Refusals keep the 6a codes as typed failures
  (`conflict` stale, `uncertain` partial, `corrupt` cross-book,
  `unsupported` future, `replan-required`, `too-large`, `not-found`).
  The 037 run owner and current direction are host-supplied through a
  `registerIpc` coordinator-identity seam; this build registers no 037
  coordinator session in the main process, so the channel refuses
  truthfully (`unsupported`) instead of inventing an owner until that
  session exists. No word count, cadence or task role is derived, and
  039 T018/T019 plus all 037/038 boxes remain unchecked pending the
  presenter surface, measurement and independent review.

### Campaign continuation check-in contract (039 T018 seam 6a)

- Add the pure integration contract leaf
  (`packages/core/src/review/campaign-continuation-checkin.ts`): it maps one
  checked continuation campaign — the store readers' inspection, cross-book
  report resolution and group/fixed-history inspection results, plus a
  host-supplied 037 run owner and direction reference — into counted 037
  check-in inputs copied verbatim from the codec manifest and its `counts`
  (campaign/owner identity, revision, segment and token totals, selected
  scalar/byte counts, checkpoint receipt tallies and report dispositions). It
  refuses stale expectations (`conflict`), partial groups (`uncertain`),
  non-active groups, cross-book artifacts, refused or compatibly differing
  semantics labels, and campaigns too large for one 037 context/phase record,
  without coercion; it never recounts prose, re-encodes stored bytes or
  mutates its inputs, so supported unknown fields survive untouched. The codec
  retains no word count and the 037 contracts define no check-in cadence type,
  campaign-stage task role or `Brief.targetWords` derivation, so the leaf
  emits counted progress only. Pure core only: no IPC, preload, UI, provider
  calls or host wiring, and 039 T018/T019 plus all 037/038 boxes remain
  unchecked pending host integration and independent review.

### Campaign continuation fixed-history group trash/restore (039 T014/T015)

- Add version-dispatching fixed-history group movement to the checked store
  (`packages/core/src/review/campaign-continuation-fixed-history.ts` and
  `CampaignContinuationStore` fixed-history methods): the preserved history
  sidecar set for a campaign — the owner book's entire 032 `history/` tree
  plus the campaign's segment directory, publication-intent directory and
  manifest — moves between the active locations and
  `.studio/trash/<owner>/reviews/campaign-<groupId>/` under an immutable
  `review-campaign-fixed-history-intent` retained in
  `reviews/fixed-history-moves/`. Complete checked preflight (manifest
  `plannerSemantics` dispatch with compatibly differing labels verified only
  through a local normalized comparison copy and stored bytes never altered,
  full wire verification, bounded inventories, per-record 032
  schema/identity/body dispatch and destination absence) runs before the
  first move with source bytes preserved on refusal; the intent is created
  absent-only and read back, components move history-first with the manifest
  last, and a failure after the first move is `uncertain` with both locations
  and the intent retained. Inspection classifies the group as `active`,
  `archived`, `partial` or `absent` and never reads a partial group as
  complete; revision chains, ownership and supported unknown fields survive
  byte for byte because retained bytes are moved, never re-encoded.
- This slice is pure core plus the existing storage seams only: no IPC, UI,
  provider calls or host wiring is added, and 039 T014/T015/T017/T018 remain
  unchecked pending independent review.

### Campaign continuation group trash/restore and cross-book report resolution (039 T014/T015)

- Add campaign continuation group movement and cross-book report resolution to the checked
  store (`packages/core/src/review/campaign-continuation-group.ts` and
  `CampaignContinuationStore` group/report methods): a version-dispatching trash/restore moves
  exactly the manifest file and the whole segment and publication-intent directories between
  `books/<owner>/reviews/` and `.studio/trash/<owner>/reviews/campaign-<groupId>/` under an
  immutable `review-campaign-group-intent` retained in `reviews/campaign-moves/`, after full
  wire verification at the source and bounded inventory/destination preflight, moving segments
  and intents before the manifest last with inventory and wire readback at the destination; a
  move that cannot preserve every checked reference refuses before the first move with source
  bytes preserved, and a failure after the first move is `uncertain` with both locations and
  the intent retained and no rollback. Group inspection classifies the group as `active`,
  `archived`, `partial` or `absent`. Checkpoint reports resolve only from their recorded
  owner's ordinary report path with raw-hash, identity and disclosure-scope verification: the
  recorded owner wins, a verified foreign report is a bounded foreign reference that is never
  adopted, merged or dropped, and a missing or changed report stays an unavailable entry.
  Supported unknown fields survive byte for byte because retained bytes are never re-encoded.
- This slice is pure core plus the existing storage seams only: no IPC, UI, provider calls,
  host wiring, portable archive/export workflow or cross-book mutation is added, and
  039 T014/T015/T017/T018 remain unchecked pending independent review.

### Campaign continuation checked storage publication and recovery (039 T014/T015)

- Add checked continuation storage as `LibraryService.campaignContinuations`
  (`packages/core/src/review/campaign-continuation-store.ts`): a version-dispatching storage
  reader loads a retained continuation only through the codec wire readers plus the replan
  compatibility dispatch (current semantics served only through a locally provenanced plan,
  compatible labels returned as `replan-required`, otherwise refused; hash agreement never
  registers a deserialized plan), intent-first publication writes the exact candidate intent,
  then immutable segments in manifest order, then the checked manifest last with fresh
  readback of every reference (length, raw SHA-256 and semantic ID) before `published` is
  reported, and explicit per-intent recovery classification (`already-published` as a byte
  observation, `prepared`, `incomplete-draft`, `conflict` or `uncertain`) that never treats a
  partial write as published. Reads are owner-explicit, inventories are bounded and paged, and
  supported unknown fields survive byte for byte because candidate bytes are never re-encoded.
- Add a genuine no-replace creation seam, `LibraryPort.createImmutableFile`: the desktop
  filesystem adapter creates immutable files with exclusive creation and the in-memory test
  port with an atomic check-and-set, while adapters without the seam (including the browser
  directory adapter) refuse continuation publication before any write rather than degrading
  segment creation to check-then-rename. Segment files that already exist with different bytes
  refuse; identical bytes are the only tolerated pre-existence.
- Correction on review: publication and recovery now enforce revision continuity (the
  candidate base must name the immediate predecessor revision, so a revision-skipping
  candidate refuses as a conflict with the active manifest preserved), and recovery
  reports a present-but-unreadable manifest file as refused/uncertain instead of
  treating it as absent.
- This slice adds no IPC, UI, provider, group move/archive or cross-book report resolution,
  and 039 T014/T015/T017/T018 remain unchecked pending independent review.

### Campaign continuation compatible replan and source validation (039 T014/T017)

- Add the pure `packages/core/src/review/campaign-continuation-replan.ts` leaf (039 T014/T017 seam):
  a version-dispatching compatibility layer decides from the recorded schema version and
  `plannerSemantics` whether a retained continuation may be served by the current planner
  unchanged, must be replanned, or must refuse; bounded source validation checks explicitly
  chosen current chapter files (raw-file hash, chapter/version, canonical full body, line maps)
  or historical 032 records (metadata identity, `sourceVersion`/`sourceHash`, body hash, full
  body) against the retained identities within the format's 33,554,432-byte per-file and
  134,217,728-byte total read bounds before any planning; compatible replan runs the real
  planner from the validated bodies and the explicitly supplied base prompt/prior feedback,
  then requires the codec's complete canonical content and digest match, returning
  `matched-local-plan-only` with the freshly provenanced plan or a bounded refusal. A
  self-consistently rehashed continuation still cannot pass the match, differing compatible
  semantics are never served unchanged, and no deserialized object gains planner provenance.
  Focused synthetic tests cover same-semantics serving, compatible replan, historical sources,
  multi-source/checkpoint replan, incompatible, forged, substituted and oversized refusals, and
  provenance non-transfer.
- This is a pure core leaf only: no storage writer, version-dispatching storage reader, host,
  IPC or UI is added, and 039 T014/T017/T018 remain unchecked pending independent review.

### Markdown folder subordinate gates closed (T014-C/P/Q0/Q/U)

- Close the five T014 subordinate gates in `specs/035-book-formatting/tasks.md` on accepted
  evidence at `914794f` (PR #49), `fe2d7a3` (PR #51), `81b474e` (PR #52), `e91ac11` (PR #53)
  and `255fc77` (PR #54), each independently accepted at its exact head. T014 itself stays
  unchecked pending T016/T017/T019; no other task, requirement or wording changes.

### Markdown folder mounted journey (T014-U)

- Mount the Markdown folder journey in the Format dialog on desktop (T014-U): a new
  **Markdown folder** target collects the saved book through three validated channels
  (`books:exportMarkdownFolderCapture`, `books:exportMarkdownFolderPublish`,
  `books:exportMarkdownFolderCancel`), shows the bundle-bound consent with the exact
  change-and-change-back disclosure, the planner's frozen warnings and the excluded
  legacy references, and offers **Continue without them** / **Cancel** for that frozen
  collection only; a new collection supersedes the earlier choice and says so. The
  destination comes from the native picker in the main process (a cancelled picker is
  a clean no-op that returns to the same consent), cancellation accepted before the
  commit prevents publication, and settlement is truthful: the written-file list and
  warnings on confirmed publication, and an unconfirmed outcome stated as unknown,
  never as success. The publication fault-injection seam is never forwarded from an
  IPC payload, and a plan can no longer publish under another capture's consent.
  Synthetic evidence covers the attempt lifecycle, the IPC boundary and the dialog
  journey, and the hidden smoke run exports a Markdown folder from the real UI.
- This slice exposes the desktop journey only: T014-U and every other 035 task remain
  unchecked pending their own gates and independent review.

### Markdown folder capture, verification and desktop publication (T014-Q)

- Add the main-process Markdown folder host service in `apps/desktop/src/main/markdown-folder.ts`
  (T014-Q, desktop folder target only; no IPC channel and no UI, which remain T014-U): capture of
  the frozen saved-source bundle through the open library's port following the host contract
  section 2 enumeration and closing-observation protocol (complete candidate set with refusal,
  manifest read / known-empty / unreadable classification, whole-capture discard on disagreement,
  consent binding to the digest tuple with invalidation on any new capture, and the disclosed
  change-and-change-back limit carried in consent wording), section 3.2 verification of every
  selected image against the single manifest snapshot (membership, identity, location, length,
  SHA-256, detected header format against `mimeType` and `fileName` extension independently, MIME,
  positive dimensions) producing bounded omissions while text still exports, bundle construction
  only through the planner trusted-construction seam, planning under `Q0 production policy v1`,
  and genuine no-replace publication to a new desktop folder through owned sibling staging with
  an exclusive destination commit, protected source identities, owned cleanup reporting, and
  failure handling that preserves prior output and source bytes. Replacing an existing folder
  stays named successor work and is refused, not implemented. Synthetic-fixture tests in
  `apps/desktop/tests/markdown-folder-capture.test.ts` cover the section 6 proof list for the
  desktop target, including a destination created during staging preventing publication.
- This slice qualifies no target and exposes no journey: T014-Q and every other 035 task remain
  unchecked pending their own gates and independent review.

### Markdown folder host protocol contract (T014-Q0)

- Specify the T014-Q0 host protocol and production policy in
  `docs/formats/markdown-folder-host.md`, recorded as D-203 in `docs/DECISIONS.md`: enumeration and
  closing-sample observation for building the frozen saved-source bundle from a real library
  (including the disclosed change-and-change-back limit and consent invalidation by any new
  capture), the trusted-construction handoff into `createMarkdownFolderBundle` with per-image
  identity, length, SHA-256, header, format, MIME and dimension binding, `Q0 production policy v1`
  values for all twelve planner dimensions with synthetic planner measurements, and a per-target
  capability matrix claiming no folder capability today. Clarify in D-202 and the folder format,
  as clarification not behavior change, that the blank-title annotation applies to every navigation
  link whose label uses a blank fallback.
- Correct the T014-Q0 host contract wording (R1–R4) in `docs/formats/markdown-folder-host.md`:
  fix the `maxGeneratedUtf8Bytes` derivation to cite §4.2, disclose escape expansion and label
  repetition (generated bytes can exceed input bytes and refuse on the generated dimension),
  correct bounded-titles wording (matter titles/names are per-field bounded; book/chapter titles
  are bounded only by the retained-text envelope), define declared format via `mimeType` and
  `fileName` extension with independently breakable format/MIME checks, add the closing `images/`
  name set with narrowed compared-file wording, and state completeness proof or refusal on ports
  without `inspectDirectory`. No policy value, planner byte, capability claim, decision semantics
  or task state changes; the 100 MiB generated value is unchanged.
- This is a specification only: it implements nothing, captures nothing from a real library, and
  exposes no journey. 035 T014, T014-P, T014-Q0, T014-Q, T014-U, T016, T017 and T019 remain
  unchecked pending their own gates and independent review.

### Markdown folder pure planner

- Add the pure Markdown folder planner in `packages/core/src/markdown-folder/` (T014-P): a trusted
  bundle construction seam and `planMarkdownFolderExport` produce the complete deterministic plan
  with exact inventory and file bytes, the reversible escape notation and its inverse, blank-title
  annotations, exact parsed-body fidelity, D-202 legacy exclusion with the exact
  `key.toLowerCase().replace(/[^a-z]/g, "")` classification, frozen warnings, and per-dimension
  budget refusals including the 2 x code-units retained-input charge and a once-per-file retrieval
  that must fit under all budgets together. Retrieval returns fresh copies and charges a plan for
  its lifetime, and caller or output mutation cannot affect a plan. Export it as
  `@ai-book-studio/core/markdown-folder` following the sibling core modules.
- This is the pure planner only: no Library, host, capture, IPC, publication or interface change,
  and the folder journey is not exposed. 035 T014, T014-P, T014-Q0, T014-Q, T014-U, T016, T017 and
  T019 remain unchecked pending their own gates and independent review.

### Campaign continuation codec integration

- Integrate the accepted pure campaign continuation codec and its boundary fixtures onto public
  main, record D-201 in `docs/DECISIONS.md` alongside D-202, and reconcile the delivery forecast
  and completion map to describe D-201 as recorded with the pure codec accepted.
- This integration accepts the pure codec only. Storage writer, compatible-planner registry,
  publication/recovery and host/provider integration remain open, and 039 T014/T017/T018 and
  038 T022 remain unchecked.

### Pure campaign continuation candidate

- Add bounded in-memory campaign manifest, segment, checkpoint and publication-intent candidates,
  typed external holes, structural inspection and exact comparison with a separately provenanced
  local plan. Preserve supported mapped unknown fields and refuse unsafe rewrites; decoded data never
  gains planner provenance. Add a bounded canonical-byte visitor without raising record limits.
- Exercise synthetic large planner round-trips, real token/byte boundaries and tampering. This is
  partial pure codec work: source validation, compatible replanning, checked storage/recovery, host
  integration, adapter qualification and independent review remain open. 039 T014/T017/T018 and
  038 T022 stay unchecked.
- Add committed boundary fixtures for the combined 64-segment manifest limit (64 accepted, 65
  refused, including 32+32 and 32+33 plan/checkpoint splits through `readContinuationManifest`)
  and for a real expanded original at exactly 134,217,728 bytes with plus one refused before any
  resolver call. This is test-only evidence; no production code changed and 039 T014/T017/T018
  and 038 T022 stay unchecked.

### Markdown folder export contract

- Record D-202 in `docs/DECISIONS.md`, the Markdown folder section in `docs/FORMAT.md` and the full
  contract in `docs/formats/markdown-folder.md`: a one-way reading folder planned purely from a frozen
  saved-source bundle, with exact inventory, reversible metadata notation, content-bound legacy
  exclusions and explicit resource limits. Update spec 035's requirements, plan and tasks to match.
- This records a contract only. No planner, capture, publication or interface behavior is implemented
  or qualified, the existing exports are unchanged, and 035 T014/T016/T017/T019 remain open.
- Complete the folder contract leaf with the accepted exact escape ranges, file templates,
  title-page projection and accounted-payload charge, and name the paired legacy fixtures in 035
  T014-P. Documentation only; no task, gate or behavior changes, and 035 T014/T016/T017/T019 and
  038 T022 remain open.

### Exact-head foundation and delivery status

- Reconcile the November 9 merged foundations across the map, forecast, execution plan, JSON and
  spec index; link a public register of exact heads, merges and attributed review/check evidence.
- Preserve historical figure scopes, public-receipt limitations, receipt-lifetime and selected-only
  verification qualifications, and the remaining connected, native, provider and release gates.
- Correct next-work navigation and align the sole continuation fallback with immediate stop rules;
  retain independent review paths and both oversized-source gates.

### Completion map owner and policy follow-through

- Distinguish volatile review, durable conversations, explicit campaigns and retained continuation,
  with their own source, consent, overflow, storage and connected-journey gates.
- Link next-work owners and clarify native iOS responsibilities, voice-session/catalog evidence,
  audiobook retries and reuse, and the separate preview, pinned-routing and cost-mode contracts.
- Align the speech acceptance edge with its preference owner while retaining background boundaries,
  and state the five-child execution limit separately from coordination and broad-suite ownership.

### Platform contract follow-through

- Align the spec index and browser handoff with the mobile owner's remaining native iOS work and
  separate Simulator, real-device and release evidence.
- Carry the audiobook cost-mode and explicit failed-or-uncertain retry contract into its plan and
  unchecked tasks, including validation and reuse of successful chapter assets.

### Native and audiobook contract clarity

- Assign native iOS storage, protected credentials, lifecycle and capability/refusal integration to
  the mobile owner, with unchecked decision, implementation and separate target-evidence follow-through.
- Align audiobook retry authorization and cost-mode wording with the accepted policy while keeping
  enforcement, media decisions and provider qualification open. Explain the selected autonomous
  authoring architecture's alternatives and costs without claiming runtime acceptance.

### Completion graph acceptance contracts

- Record claim-scoped contract, evidence and refusal requirements for all 66 existing lane
  relationships, with linked owners and independent optional planning, routing and casting gates.
- Make L24's direct conjunction of all 24 retained lanes explicit without adding sequencing arrows;
  document the desktop and full-roadmap milestone tradeoffs and navigate to principal owners.
- Extend structural validation and isolated malformed-fixture tests without treating a graph pass as
  implementation, evidence, decision or release acceptance.

### Current requirements and delivery forecast

- Keep the continuation decision and format candidate-labelled until their reviewed contracts are
  incorporated; roadmap references alone do not authorize continuation writers.
- Identify the continuation work by its delivery state until a published candidate is available.
- Reconcile the accepted November 8 foundations and unmerged candidates, update the concurrent
  execution model/queue, and publish the next dependency slices through full-book acceptance.
- Describe retained editorial diagnostics, reader lenses, rereads and series continuity in
  product terms, with exact-source and separate application/quality evidence requirements.
- Keep broader history, planning, exports, media, native and release work explicitly assigned;
  implementation, automated, provider, device and release acceptance remain distinct.


### Review and workflow storage integration

- Integrate the accepted workflow storage, bounded reads and journal receipt ownership with the
  repetition review, retaining both feature histories and their independent acceptance boundaries.
- Remove inherited merge-label lines from the workflow records and mounted editor history.

### Review failure details

- Preserve fresh skipped filenames and reasons in run-local failure views, with source-read issues
  distinguished from unverified worker classifications and all-skipped conclusions. Give worker
  failures appropriate retry guidance while keeping the live manuscript and selected text intact.
- Cover fresh read failures after a clean load, dirty-buffer preservation, complete and partial
  all-skipped worker replies, startup failures and obsolete failure replies after cancellation.

### Review metadata disclosure

- Attribute worker-derived coverage, studio word counts and insufficient-text conclusions as
  unverified. Keep skipped chapters explicit and distinguish insufficient text from zero findings.
  Preserve cancellable off-thread selected-passage verification and read-only reports.
- Integrate the accepted manual planning records and retain both feature histories.

### Empty review result disclosure

- Qualify a worker's zero-finding result as unverified for both complete and partial repetition
  reports. Keep skipped-chapter and insufficient-text explanations distinct; preserve selected-passage
  verification and read-only behavior. Cover genuine empty reports and controlled omitted results.

### Review integration

- Integrate the accepted hands-free controls with the selected-evidence verification changes,
  preserving both feature histories and removing an inherited stray merge-label line.

### Selected review evidence verification

- Before opening a repetition passage, verify that it contains exactly three complete source tokens
  with the selected sequence's normalized key. Share the scanner's Unicode/apostrophe rules and run
  normalization in a disposable, cancellable worker. Re-read saved text afterward and retain the
  live-editor and view-lifetime guards before selecting anything.
- Disable evidence while navigation reads or verification are pending. A failed source read leaves
  the report unavailable with an explicit retry; a false association requires a new review. Label
  sequence names, counts and excerpts as unverified, and keep every occurrence in the paged report.
- Add synthetic token-boundary, Unicode, worker cancellation, source-change, retry and lifetime
  regressions. Native worker packaging, accessibility, retained-review and other-host acceptance
  remain open.

### Review evidence and display freshness

- Label each displayed occurrence excerpt unverified until its exact saved passage is checked when
  opened. Invalid evidence makes the report unavailable for navigation until a new run; all
  findings and occurrences remain available in the paged result.
- Check saved-source freshness on first display and reopen before enabling evidence, with disabled
  navigation while checking, a retry on read failure, stale-source feedback and cancellation during
  the initial check. These reads do not replace the live editor buffer.
- Bind malformed-page failures to the report lifetime independently of individual navigation reads,
  so current failures cancel pending navigation without affecting a replacement run. Synthetic
  regressions cover these boundaries; independent review and native/host acceptance remain open.
### Pending receipt retirement

- Keep every pending journal receipt reachable for retirement even after a newer possible write
  loses its active ownership following an intent-note failure. Remove registry roots on settlement
  or retirement and release settled receipt references while preserving needed predecessor outcomes.
- Cover three-service remove, move and accepted-deletion interleavings across before/after note and
  author publication failures, equal/different intents and unchanged tombstones. Preserve legitimate
  unsuperseded restoration and single-attempt author writes.

### Workflow storage integration

- Integrate the accepted manual planning records with workflow storage and journal-receipt retirement,
  retaining both feature histories and their checked-publication contracts.

### Retired journal receipts

- Retire pending write-receipt predecessor chains even when a removal or move leaves an existing
  tombstone unchanged. A later refused write cannot clear that tombstone through an older verified
  result. Preserve verified-predecessor restoration for unsuperseded writes and best-effort journal
  failure behavior; cover both settlement orders and equal-byte outside reappearance.

### Verified journal note ownership

- Settle verified saves through their initiating one-shot receipt so delayed snapshots cannot undo
  later accepted drift baselines, newer verified or uncertain notes, removals or moves. Track missing
  paths without inventing observed baselines, and restore verified predecessors after a newer
  definitive refusal. Keep unaccepted outside changes reviewable and journal failures best effort.
- Add synthetic workflow/shared-writer ordering and journal-failure regressions, including same-port
  service instances and strict test compilation. Cross-process atomicity and live-host timing remain
  separate evidence requirements; 037 T023 and 038 T022 stay unchecked.

### Manual planning records

- Show stable world identities beside active Edit/Archive and archived Restore controls and in the
  matching editor, with accessible control descriptions. Recover duplicate names by copied identity
  through explicit checked restore/edit while retaining other records and the original copy.
- Avoid per-character regular-expression repetition when checking numbers around long JSON strings.
  Retain exact numeric admission, syntax/byte limits and every checked-save boundary; keep the
  existing near-limit save waits and add escaped-string/numeric-boundary controls.
- Add validated exact-JSON-string editing and recovery representations for literal CR/CRLF/LF,
  control characters and escapes. Retain incomplete encoded drafts behind the existing navigation
  guard, measure decoded field limits, and expose the full verified copy without textarea line-ending
  loss. Show stable identities within both order editors and describe them on move controls so
  duplicate and archived records can be matched to inspected copies before a fresh checked save.
- Extend verified recovery-copy inspection with decoded, labelled read-only timeline, beat, order
  and story-notes values alongside world details and goals. Explain the correct fresh editor for
  each kind and retain archived identities, literal text and the complete JSON. Test actual manual
  recovery from displayed fields without replacing a newer saved document or changing the copy.
- Bind every transported save to a fresh client request and independently issued host publication
  identity. Derive created record IDs from that publication, verify the same binding in complete
  recovery bytes, and keep handler validation snapshots separate from service submissions. Reject
  identical stale-create receipt replay, including an old receipt returned after a later real write.
- Prefix planning control names with kind, retained position and action before authored titles, and
  prefix reorder names with direction and position. Action-like titles and literal generated labels
  remain distinct while preserving visible text in the accessible name. Add pending-service,
  four-kind replay and mounted collision regressions; native accessibility acceptance remains open.
- Bind conflict receipts to the exact typed intent and complete byte-verified recovery document,
  recheck the named copy in the handler, and reject replayed replies for another draft. Require
  changed-save replies to match the writer's exact serialization while retaining valid compact
  reads/no-ops and unknown own data; refuse sparse/non-JSON response arrays.
- Surface deterministic output-budget/validation refusal only before any publication attempt, so
  authors can shorten a retained draft and explicitly save again. Keep genuinely uncertain active
  and recovery outcomes paused with no retry. Disambiguate duplicate planning edit/archive/restore
  labels and keep move-control position names accurate after reorder. Add real Library/API and
  mounted regressions; native accessibility and fresh independent acceptance remain separate gates.
- Extend the existing checked planning save/API with timeline events, optional story notes, outline
  beats, explicit author ordering and reversible worldbuilding/event/beat archive controls. Mount
  these in the planning panel with literal fields, archive confirmation and the existing exact-draft
  recovery/navigation guard. Confirmed creation keeps subsequent edits on the same host-assigned ID.
- Verify full save-response correspondence and preserve unknown own `__proto__` data across reads
  and edits. Clear notes keeps the singleton identity and unknown fields; empty optional notes and
  current no-ops write nothing. Synthetic Library/handler and mounted filesystem journeys cover
  ordering, retained limits, recovery, archive/restore and untouched Bible/chapter bytes.
- Reconcile the complete typed-intent inventory in FORMAT and narrow existing worldbuilding test
  assertions across the expanded save union. Independent review and integrated visual/host checks
  remain acceptance gates.

### Saved-review receipt and draft recovery corrections

- Verify complete intended report-conflict copies at the store, handler and receiver, including a
  separate bound readback of the named file; unverifiable publication remains uncertain.
- Keep pending/uncertain report saves latched across equivalent wrappers and require same-view
  inspection plus explicit acknowledgement before another submission. Retain newer disposition
  typing but require explicit adoption of superseding history, including other drafts after an
  unconfirmed save; distinguish absent notes from intentionally entered empty or whitespace notes.
- Admit disposition inputs before reading their properties, use portable test fixture roots and the
  shared complete Electron mock, and cover these paths with focused synthetic regressions. Native,
  built-app, integrated verification and independent review remain outstanding; 039 T014/T015 and
  038 T022 stay unchecked.

### Checked saved-review dispositions and recovery

- Complete the authorized saved-record mutation slice through the existing Library queue/writer:
  desktop forwarding, inspected raw disposition baselines, complete stale-history conflict copies,
  and validated success/conflict receipts preserving supported unknown own fields.
- Connect exact-content inspection and one-use confirmed trash/free-path restore in Workspace,
  including bounded trash pages, partial-group recovery, occupied-target refusals and truthful
  uncertainty. Retain exact local drafts and prevent replay/late/ABA replies from becoming success.
- Add focused synthetic real desktop wrapper/IPC/preload and browser/mounted recovery evidence.
  Document the format/API clarification. 039 T014/T015 remain partial for production execution,
  export/archive/continuation, native and independent integrated gates; 038 T022 stays unchecked.

### Saved review inspection and explicit save

- Add a bounded saved-review API with exact request/Library/book/view binding, immutable explicit
  reader saves, checked report/disposition reads, preserved conflict-copy receipts and honest
  refusal/not-kept/uncertain outcomes. Browser storage uses the current Library's existing writer.
- Mount Saved reviews in Workspace with captured-source attribution, historical quotations,
  separately paged unavailable files and retained local disposition drafts; add explicit Save review
  to the structured reader result leaf. Opening/filtering never saves or calls a provider.
- Keep 039 T015 partial: the desktop Library forwarding getter, caller-base-checked disposition
  mutation and inspected trash/recovery seams are coordinator-owned prerequisites. Their unavailable
  state is explicit. Synthetic browser/Workspace and injected desktop IPC/preload checks do not claim
  connected reader generation, completed recovery, provider quality, export/archive or release gates.

### Pure full-book review campaign planning

- Normalize valid synthesis evidence windows within their selected segments, accepting overlap,
  adjacency, duplication and reversed order without bridging gaps or accepting invalid original
  scalar endpoints. Preserve original text/line maps and citation scope. Allocate deterministic
  collision-free summary-feedback IDs without changing retained history, and account for their
  exact serialized reservation overhead. Add focused interval/citation/history regressions.
- Retain the chosen owning book in immutable campaign plans and their digests, refusing cross-owner
  coverage receipts and synthesis summaries even for equal-length owner IDs. Check shared plain-data
  subgraphs once per validation while retaining cycle, accessor, lossy-value and fresh-call checks.
- Add explicit all-range review campaign planning with scalar-safe primary/context separation,
  exact existing-envelope admission, immutable source/profile/category attribution and deterministic
  synthesis dependencies. Actual summaries are admitted without trimming and cannot manufacture
  verified citations. Add independent primary union coverage, execution, synthesis and currency
  aggregation; retain complete non-persistable plans when current campaign record bounds overflow.
  Synthetic 70k/250k and oversized-chapter checks accompany the pure leaves. Continuation formats,
  lossless record mapping, scheduler/host integration and fresh independent review remain gated.

### Hands-free Discuss controls

- Keep confirmed voice words display-only until the actual admitted agent start. Stop, host refusal
  and draft-flush failures cannot carry those unsubmitted words into a later typed or voice request;
  legitimate stored history, dispatched outcomes and ordinary typed/retry behavior remain intact.
  Add real-panel subsequent-request regressions with nonempty history and retained local words.
  Remove an inherited stray merge-label line from this changelog section.
- Restrict mounted hands-free activation to the documented `synthetic-in-process-v1` host contract:
  monotonic fact revisions, prompt lifecycle notifications, independent host closure and synchronous
  admission at the actual capture/STT/agent boundary. Stale snapshots and unsupported subscriptions
  refuse activation; renderer checks do not qualify native IPC. Retain per-port STT slots, unique
  request IDs and honest late-settlement/unknown-charge receipts across remounts, isolating consumers
  and port replacements. Compensate failed partial acquisition through its original owner and leave
  failed cleanup unconfirmed. Starting no longer claims capture is closed while verification waits.
  Dispatched turn receipts remain visible independently of closure order or host availability.
  These are synthetic source/test changes, not a production capture host or device qualification.
- Correct the complete capture/settlement/dispatch lifetime: every capture acquisition is freshly
  admitted after awaits and owned by its original port and monotonic attempt. Stop and disposal join
  pending acquisition and close it before reporting Stopped; segment holds share native closure with
  shutdown, while only the exact shutdown receipt can settle Stop. Failed cleanup remains visibly
  unconfirmed, including port reuse after unmount. Committed scope/port changes synchronously revoke
  pending work, including A–B–A returns. Exact transcript receipts release only their matching core
  request even when permission, route, source or visibility rejects the words; unknown charges remain.
  Carry revocable voice admission through the existing ChatPanel draft flush to the final agent-start
  boundary, keep local Stop available while sending, retain actual dispatched outcomes without
  rebinding a changed panel, and give status descriptions stable unique IDs. Positive synthetic
  controller/mounted/ChatPanel race regressions preserve typed sending, correction focus and StrictMode.
  No production capture adapter is connected; 017 T017 and 038 T022 remain unchecked.
- Keep transcription queued and uncharged until capture closes and fresh session/scope/route/grant
  facts admit the exact operation immediately before the adapter call. Stop revokes queued work
  synchronously, including intents still awaiting host facts; dispatched cancellation retains
  unknown charges. Foreign/late results cannot replace another draft. Clearing a correction keeps
  the same focused editor mounted, updates its value synchronously and disables empty confirmation.
- Mount explicit hands-free controls in the Discuss panel: start, the words as heard, correction
  before sending, one explicit confirm and stop, bound to the open book, chapter and conversation.
  A host-neutral controller composes the existing session reducer, audio-grant predicates and
  transport ledger. A confirmed turn reuses the checked Discuss turn start exactly once, a
  book/chapter/conversation change ends the session and keeps the unsent words visible instead of
  sending them to the new target, and Stop reports stopping until the host settles, so a late
  transcript cannot send. No capture adapter, OS prompt, microphone, provider call, playback
  arbitration, IPC/preload change or device evidence is added: without a host adapter the bar says
  hands-free audio is not connected and records nothing. Stop during transcription settles as a
  cancellation instead of a permanent failure receipt; genuine failures are shown with an explicit
  Dismiss; late capture/send settlements carry session/request identity; a target change while
  recording tells the host to close capture; a late transcript settles its exact transport slot even
  when its text is ignored; Continue retries a held capture and is offered when interrupted; and a
  StrictMode remount re-arms the store. 017 T017 remains unchecked.

### Review navigation and worker reply safety

- Guard report reopen, run and evidence-navigation continuations against superseding actions,
  chapter/view visits, book/library changes, dismissal and unmount, including late read failures.
  A delayed chapter switch also invalidates work when the switch actually commits.
- Select evidence only after checking the mounted editor's current source and live buffer against
  the exact saved passage. Refuse dirty, saving, failed, composing or held editors instead of
  refreshing over their text; recheck both sides of a cross-chapter switch.
- Fail invalid worker envelopes and required metadata safely, validating metadata incrementally
  and occurrence spans as their pages become visible rather than scanning every span on the UI
  thread. Focused synthetic regressions cover these guards; native and retained-review gates remain.

### Cancellable deterministic review runtime

- Move interactive repetition analysis into a dedicated, run-owned module worker. Native NFC on
  valid descending-class combining marks can block for seconds despite character-scan yields;
  cancellation now terminates the worker and discards late output without changing repetition-v1,
  valid-source coverage, counts or original evidence spans. Worker startup/error/unavailable paths
  fail visibly with no main-thread analysis fallback.
- Clean up deterministic review work on cancellation, dialog dismissal, book/library change and
  Workspace unmount. The run-acquisition reads and worker replies are isolated from a fresh run;
  the separate reopen and navigation reads required the subsequent correction above.
- Add synthetic Bun-worker and Workspace regressions reaching adversarial native normalization,
  exact adversarial completion, retry, late replies, failure and lifetime cleanup, alongside complete
  120-chapter/250k-word occurrence transport. Native browser/Electron performance, packaging and
  remaining inline/retained-review acceptance remain separate gates.

### Deterministic repetition review

- Implement D-198 repetition-v1: all overlapping three-token windows, Unicode letter/number/mark
  tokens, internal apostrophes, NFC/case/apostrophe comparison keys and exact original UTF-16
  occurrences. Malformed Unicode chapters are explicitly skipped; no source text is repaired.
- Feed actual findings into the existing volatile Review manuscript report with visible metric
  version/definition, complete counts and bounded sequence/occurrence paging. Existing saved-source
  navigation now verifies literal spans as well as versions/hashes. Cancellation yields through
  scans/grouping and across chapters; fixed-slice shared word counting handles giant unbroken tokens.
- Add focused synthetic coverage for real report-to-editor navigation, stale refusal, complete paging,
  cancellation and 120-chapter/250k-word inputs. Inline review layers, retained-review mounting and
  native/release acceptance remain open.

### Workflow records
- Reconcile only the exact planned journal attempt after a definitive prepublication refusal, so
  equal outside bytes remain reviewable. Preserve prior and newer same-hash intents, concurrent
  notes and uncertain-publication recovery; out-of-order refusals cannot resurrect a refused plan.
  Add positive workflow/shared-writer race, overlap, note-failure and recovery regressions. Journal
  reconciliation remains best effort and does not retry author-file publication.
- Enforce workflow byte ceilings at desktop and browser read boundaries, including checked-commit
  comparisons/readbacks, drift scans, journal observations, watcher checks and move-copy fallbacks.
  Oversized replacements are refused without truncation; a possible post-publication failure stays
  uncertain and is never replayed. Service journal notes now record only the exact verified intended
  write, so a subsequent outside replacement remains reviewable for new and existing paths.
- Classify missing or non-string workflow envelope kinds as corrupt on read and invalid on write;
  future/foreign string kinds remain unavailable, with exact file bytes retained and no write.
- Bind final artifact readback to the exact intended metadata/body on both creation and no-op;
  changed, missing, corrupt or unreadable final pairs report uncertainty without replay. Distinguish
  future string semantics from malformed known states in workflow record reads.
- Refuse copy-only metadata before any active workflow publication and enforce the run header's
  control-only format. Document bounded conflict names and baseline tokens; artifact recovery
  metadata points to its verified retained body. Unknown artifact/target/accounting semantics stay
  unavailable and read-only. An orphan artifact is refused, never guessed or silently completed.
- Add checked schema-1 workflow storage behind `LibraryService.workflowRecords` (037 T023). Checked
  `run`, `task`, `attempt`, `effect` and `question` records require the exact previous raw hash and
  revision, are parsed by the same build's codec before publication, are committed through the
  Library's per-book queue and journal, and are verified by exact-byte readback. Immutable absent-only
  `artifact` metadata plus its bounded body (≤1 MiB, `.md`/`.json`) and `context` manifests use the
  same writer; metadata and body must agree on the exact SHA-256 and size, and a partial or
  mismatched pair refuses. Stale, missing and racing bases keep the complete intended document under
  `workflows/<runId>/conflicts/` with bounded names and full identity inside; an unverified
  publication is reported as uncertain and never replayed. Malformed, duplicate-key, lone-surrogate,
  lossy-number and oversized records are refused without rewriting; supported unknown plain fields
  (including own `__proto__`) survive read-modify-write and newer closed-union members stay read-only.
  There is no scheduler, dispatch, provider call, publication/effect execution, command/admission
  writer, IPC/UI, pruning or deletion. T023 remains unchecked pending independent storage review;
  T020–T022, T024–T042 and 038 T022 stay open.

### Saved review records
- Define schema 1 for explicit saved reviews under `books/<bookId>/reviews/`: immutable absent-only
  reader reports with analyzer/profile/source/coverage attribution, bounded quotations and no source
  bodies, plus checked disposition, author-lens and campaign records carrying the exact previous raw
  hash. Add one checked writer on `LibraryService.reviewRecords`: Library queue/journal commits,
  conflict copies, readback verification, grouped `.studio/trash` move/restore and no pruning.
  Unknown plain fields survive read-modify-write; malformed, duplicate-key, lone-surrogate,
  lossy-number and oversized documents are refused without rewriting. Review corrections: require a
  saved report to live in one of the books it reviewed, cap `coverage.items`, refuse
  `contentBytes < sourceBytes`, refuse mis-ordered dispositions, treat an unknown member inside a
  closed lens as unsupported, validate campaign synthesis stages and allow a completed synthesis to
  repeat its own stage report. An unfinished synthesis description may record `report: null`, and a
  completed one must name its stage's exact report and hash. Re-saving the same run after the clock advances stays idempotent by
  reusing the saved report's own timestamp, and a stale author-lens edit keeps its conflict copy
  instead of being rejected before the base can be compared. Unknown `__proto__` extensions are
  carried as own plain data properties in both saved review records and thread documents, so a
  readable record with that extension stays updatable. Report listings now order by the completion
  instant rather than the preserved offset spelling, so mixed offsets cannot page an older review
  ahead of a newer one. A post-publication readback mismatch (adapter `publication: "uncertain"`) is
  reported as uncertain instead of being retried under another conflict-copy name or relabelled a
  conflict. Conflict-copy names are bounded below the filesystem component limit (a maximum-length
  record ID falls back to a hashed name with the full identity inside the document), leaving room for
  the atomic writer's temporary suffix. 039 T014/T015 remain partial: segmented continuation,
  IPC/UI/export mounting and independent review are still open.
### Voice transport

- Allow `refusal` in the transport settle event (the four-way settlement the README and the
  desktop adapter already use), and require callers that have dispatched a chunk to settle a
  provider 400/404 as `failure`, not as a pre-send refusal. Reserve receipt capacity for an
  operation already in flight, and mark service-side cancellation with an explicit AbortError so a
  custom host reason still settles as cancellation. A stop that lands while the response body is
  read is converted to the same cancellation instead of a provider failure.

### Voice transport
- Add a pure host-neutral STT/TTS transport ledger: monotonic operation and chunk IDs, one
  outstanding operation per kind, exact session/route/permission rechecks immediately before every
  dispatch, best-effort abort descriptions, owned-slot retention until an exact settlement,
  duplicate/late/foreign receipt rejection and bounded receipts. Settlement separates success,
  refusal, failure and cancellation from an `unsent`, `reported` or `unknown` charge, so an
  unreported provider amount is never read as a zero.
- Map provider-reported speech cost and provider/abort failures at a typed desktop edge, and let
  `VoiceService` and `SpeechService` accept a host abort signal with a per-chunk recheck and no
  automatic retry. No request ID, cancellation surface or charge is exposed to the renderer, and
  017 T016 remains partial: no mounted host, IPC cancel path, provider-side cancellation proof or
  device evidence is claimed.

### Conversation storage

- Bind every conversation save to the exact base hash its caller read: a save without that base is
  refused instead of rebasing on the current file, and an older copy keeps a verified conflict
  copy. Internal fork/checkpoint updates go through the checked mutate path, so no production
  caller needs a blind whole-document save. Report the conflict reason from the bytes actually on
  disk, and report a create collision as `exists` without a misleading copy.
- Generate conversation titles by code point, not UTF-16 unit, and refuse a non-well-formed title
  before publishing: a prompt ending a 60-unit title in an emoji can no longer create a conversation
  the checked reader rejects.
- Refuse a non-well-formed document before publishing (any lone surrogate, not only the title), keep
  generated search snippets off a surrogate split, and carry unknown message/part fields recursively
  through same-id replacement so a normal update cannot erase them, and refuse an emitted number the
  reader would reject (non-finite, negative zero or magnitude above `Number.MAX_SAFE_INTEGER`).
  Before publishing, the built bytes are now parsed by this build's own reader, so depth and any
  other reader constraint cannot be bypassed by a generated document.

### Checked conversation storage
- Route every v1 conversation write through the Library's per-book queue and journal-aware checked
  raw-hash commit, with exact readback verification and a verified `conflicts/` copy when the file
  moved underneath the writer. Equal bodies are no-ops, stale hashes never overwrite, and uncertain
  publications are reported as uncertain.
- Parse conversation files as fatal UTF-8 and lossless JSON, preserve supported unknown plain fields
  at every depth through read-modify-write, and treat unknown roles/parts and newer schema versions as
  read-only rather than rewriting them. Refuse malformed, duplicate-key, lone-surrogate, lossy-number
  and over-64-MiB files without touching them.
- Move conversation deletion to recoverable `.studio/trash/<bookId>/threads/` and add a checked
  restore that requires an absent destination and an unchanged book/conversation identity. No
  automatic pruning, quota or expiry. 037 T019 remains partial; v2 semantic migration, restore
  UI/IPC and independent review are still open.
### Mounted editor

- Mount the exact-current CodeMirror surface in the manuscript editor: the existing wrapper keeps
  title, autosave, drafts, save queue, conflicts, custom undo and hold/rebase; shared-verifier
  evidence paints underlines only after it applies, and a minimal accessible findings aside lists
  them with keyboard navigation. Edits clear marks; no provider or persistence is added.
- Clear the aside's current finding when a category filter hides it, and count findings rather
  than evidence spans so a finding with two citations is not reported as two findings.
- Keep undo history intact when a restored selection would split a surrogate pair: clamp the
  caret to a code-point boundary and put the history transition back if the replacement is still
  refused. Select a list row's finding by identity, so two findings on one passage can each be
  chosen from the list.
- Clear marks, the findings list and any pending proof when the host withdraws its review request,
  instead of leaving stale underlines visible. Regenerate the third-party notices for the web
  closure, which now includes the editor's CodeMirror packages.

### Mounted exact-current manuscript editor
- Mount the accepted CodeMirror plain-text surface in `ManuscriptEditor` in place of the textarea.
  The wrapper keeps title, the 700 ms autosave, the 300 ms draft copy, one serialized save queue,
  the custom 100-state undo, retry/conflict/flush, hold/rebase and voice ownership; the surface
  reports every change back through that one apply path. Typing, plain Enter, paste normalization,
  dictation spacing, selection, Ctrl/Cmd-S/Z/Shift-Z/Ctrl-Y, the composition guard, hold/rebase and
  the latest-buffer flush keep their existing behaviour. The smoke `manuscript-text` hook now reads
  and writes the mounted surface through its automation contract.
- Add a minimal accessible findings aside for a host-supplied synthetic layer. The shared
  exact-source verifier (`createSharedEvidencePort`) validates it; the editor paints exact-current
  underlines; the aside lists per-finding rows with Next/Previous/Inspect/Return, focus return,
  category filtering and filtered/total counts. Editing removes current marks and the list. No
  provider request, report write, disposition, suggestion application or saved review is added.
  039 T012/T013 remain partial and 038 T022 is untouched.

### Pure authoring foundation
- Tighten the workflow codec after independent review: a `maxBytes` override may only lower the
  record-kind bound, receipt `savedAs` uses the same bounded library-relative path rule as a target,
  phase-plan graph tasks enforce the 256-key strict impact rule, and phase 1 has no predecessor while
  every later phase names one.
- Specify schema-1 workflow records in FORMAT for the durable run/brief/policy/phase-plan/direction/
  task/command-journal/attempt/effect/question/artifact/context/admission surfaces, with exact
  identity/hash/reference, base, bounds, ordering/pagination and related-file recovery rules. Add a
  pure host-neutral raw codec that refuses invalid UTF-8/BOM, duplicate keys at any depth, lossy
  numeric lexemes, unsupported versions, foreign owner/kind and depth/size overflow before
  constructing values, preserves supported unknown fields and encodes deterministically. No writer,
  scheduler, provider, host permission, runtime journey or independent review is claimed.

### Shared exact-source verifier
- Require the saved chapter file to declare its own `id` and `version`: the parser fallback no longer
  supplies the host's expected identity, so a headerless file or omitted key is refused. Also reject
  request status facts that are not clean/pending-false/available and an envelope `bodyLength` that
  disagrees with the proven saved body.
- Add one host-neutral core verifier backing the inline editor's trusted evidence port: raw byte/text
  SHA-256 and fatal UTF-8, canonical saved-body and file id/version equality, exact envelope/scope
  attribution, literal UTF-16 citations reusing the accepted review contracts, complete-overlap
  identity, frozen spans/findings or a bounded refusal, invalid-evidence withholding and abort racing.
  It imports no app, Library, filesystem, provider or IPC module. Host mounting/export,
  disposition/rerun relations and independent review remain open; 039 T011 stays partial and unchecked.

### Voice permission host owner

- Put both desktop default-session permission handlers under one deny-by-default owner. The real
  callback sender window, trusted top-level frame, renderer origin (packaged `file://` or the dev
  server's exact origin) and audio-only media list decide the result; foreign windows, subframes,
  foreign/missing origins, camera, display capture, mixed media and missing details deny. Trusted
  push-to-talk audio keeps its existing explicit-press path and creates no grant. Add an in-memory
  exact hands-free grant with an injected clock, explicit register/replace/revoke/clear and
  window-close/quit revocation, checked through the core permission predicates. 34 synthetic host
  tests cover the decisions; OS grants, microphone, mounted hands-free capture and 038 T022 remain
  unclaimed.
- Correct the permission owner after independent review: a present-but-unrecognised origin field now
  denies instead of deferring to its sibling, a same-id re-registration can no longer rebind or
  extend a live grant, and an observed expiry is latched so a clock that moves backwards cannot
  revive it. Rename the decision to `captureAllowed` and state in the README that it is a capture
  gate, not hands-free authority, with the adapter's exact-grant obligation.

### Hands-free pure core

- Keep Pause/Stop work inhibition through late permission success. Retain exact bounded failed
  receipts across stop/reactivation until explicit acknowledgement, without reviving old content.
  Separate admitted playback from display status so genuine completion releases its exact TTS slot
  after work settlement, pause or correction. Add cross-transition pure regression tests.
- Add an unmounted, platform-independent voice-session reducer with explicit activation, pinned
  scope/routes, exact named confirmations, correction/interruption, distinct stop controls and
  request/chunk gates that retain uncertain external settlement. Add trusted-frame audio-grant
  predicates, bound 037 answer intents and literal selection-preserving dictation insertion.
- Add memory-bounded injected PCM/VAD segmentation with the accepted 1.2s silence, 250ms preroll
  and 60s utterance defaults, explicit one-STT holds and unconsumed-suffix reporting. Synthetic
  tests and a local integration contract cover the pure slice; microphone, permission-handler,
  transport, UI and acoustic/device integration remain open, including 038 T022.

### Integration
- Compose the accepted pure authoring, hands-free voice, scoped reader-review and exact-current
  inline-editor leaves with the checked planning/Stop/history composition. Each leaf keeps its own
  retained host/storage/permission/mount gates; this commit adds no new runtime authority,
  provider call, microphone use or mounted review surface. Regenerate the third-party notices for
  the new CodeMirror dependency closure so the attribution file matches the built product.
- Let a planning draft refuse the unload before anything is torn down: a granted quit now only
  records intent, the agent backend stops after every window has actually gone, and a refused
  unload clears both the close permission and the quit intent so the next attempt asks again.
  Previously Keep editing could leave the studio open with its control plane stopped and later
  closes bypassing the draft flush. The post-stop re-quit is deferred to the next event-loop turn:
  Electron drops an `app.quit()` issued in the microtask right after a vetoed `will-quit`, which
  otherwise hangs the hidden-window suites.

- Compose the accepted planning vertical with bounded-authoring policy, terminal Stop delivery and
  merged chapter-history restore work. Preserve each exact candidate's bounded evidence; broad
  planning/organization scope and integrated product acceptance remain separate follow-through.
- Bundle the preload's Zod/YAML validation graph into the sandboxed preload so its validated
  planning bridge loads in the built app instead of failing on external runtime requires.
- Compose the accepted planning and bounded-authoring policy, terminal Stop delivery and merged
  chapter-history restore work in one integration candidate. Preserve each exact candidate's
  bounded evidence; connected mounting and product acceptance remain separate follow-through.
- Clarify that history record creation is absent-only while intent transitions use checked updates,
  and reconcile merged PR #34 history status across current-state records without claiming host
  mounting or whole-feature acceptance.
- Refresh current development dispatch records to Muse Wonder 1.0 at reasoning max and date-stamp
  the earlier five-slot table as historical, preserving prior model decisions as history.
- Keep history restore/undo success results complete for partial saved front matter without adding
  runtime defaults to the file. Require a post-failure history refresh to unlock uncertain capture,
  and make close notifications idempotent even when the host callback fails.
- Connect checked worldbuilding and saved-word goals to the open Library, validated desktop/browser
  transport and workspace controls. Share the existing book queue and journal boundary; verify
  complete saved chapter enumeration, block unresolved planning navigation, retain uncertain drafts,
  and expose verified recovery-copy inspection. Distinguish browser postpublication readback drift
  from a prepublication conflict without retrying. Focused synthetic integration and native guard/focus
  checks accompany this bounded slice; full planning/organization and integrated acceptance remain open.
- Accept individually researched full-book authoring, inline editorial-review and hands-free
  contracts (D-194–D-200 / ADRs 0019–0021), with the bounded workflow/session authority amendment,
  checked conversation policy, explicit cost modes and recoverable saved-review ownership.
  Reserve formats before writers and add implementation/failure/evidence tasks; no new runtime,
  microphone, provider-spend or full-book acceptance is claimed by these documentation changes.
- Reconcile current candidate/merged statuses and original retained Bible/series, local reading/input,
  illustration recovery, migration, folder export and native-target ownership. Update every current
  development dispatch instruction to GPT-6 Astra/high, preserving historical model/audit records.
- Record expanded hands-free, inline editorial review, brief-to-full-book and asynchronous
  multi-agent requirements; set the current development queue to five concurrent agents while
  preserving the historical six-agent dispatch and existing completion DAG.
- Refuse lossy JSON numbers in planning/goal active files and recovery baselines; independently
  verify saved goal source bytes, UTF-8, body and identity. Retain planning drafts after observer or
  close callback failures, keep checked save outcomes intact, and restore focus after re-enabling.
- Invalidate Format dialog export continuations after close, navigation or unmount; delayed
  chapter/matter saves cannot submit an obsolete export, and late replies cannot update a new visit.
- Bind header export receipts, errors, preflight and busy state to the originating book view;
  ignore obsolete completions after navigation or unmount, including a return to the same book.
- Keep terminal agent events deliverable when conversation validation or storage fails. Retain
  bounded, explicitly shortened error details and preserve longer provider retry waits in the
  stored explanation without clamping the live wait or losing checkpoint warnings.
- Update the hidden agent-panel check for the Discuss/Edit permission explanation and close the
  panel after a failed assertion so the later retry journey starts from a clean view.
- Connect the existing manuscript export channels to typed published-path/warning receipts, using
  the same image snapshot for rendering and omission notices. Add real-handler coverage for all
  four formats, cancellation and refusal, plus a hidden-app check of the visible Markdown warning.
- Integrate Discuss/Edit and bounded guidance with export safety; document actual user/assistant
  mode persistence while preserving legacy unrecorded turns.
- Replace the expired event-film integration hold with exact-candidate runtime/UI checks, independent
  review and the matching interaction runbook under delegated feature-first authority. Film updates
  remain tracked separately and the older demo is not evidence of the new controls.

### Agent interaction

- Give failed initial approval publication a distinct action-specific error while retaining the
  orthogonal conversation warning. Completion, visible/spoken event consumers and notifications
  no longer receive the same persistence text as both fields; no destructive action resumes.
- Keep Ambient controls owned through request-only Stop and show settled changes, undo availability
  and save warnings. Ignore late replies/events, expose failed Stop requests and retain typed input.
  Accumulate usage/conversation/approval persistence warnings without losing successful book effects;
  carry them through completion results, background notifications and plain-text toolkit replies.
- Keep stopped turns owned until in-flight tools, approval decisions, checkpoints and outcome
  persistence settle. Remove the five-second false-stop deadline, capture late tool receipts outside
  the SDK stream, close dispatch synchronously, and serialize approval versus Stop. The composer
  shows Stopping until one terminal event, with actual changes, undo and conversation-save failures.
  A never-settling adapter remains unresolved; no plan resume or background permission is added.
- Add the first Discuss/Edit interaction slice: new composer requests default to Discuss,
  whose enabled built-in read tools cannot mutate the book and never load plugins. Edit
  retains checked writes, destructive approval and turn undo. Mode is recorded per request
  and outcome; older conversations remain explicitly unrecorded.
- Add inspectable, bounded one-turn guidance with no silent truncation or later-turn reuse,
  fixed retry attribution, and runtime validation before provider access. Preserve book
  tone/answer-length guidance and the system-prompt budget. The initial candidate retained spec 031's
  demo/script condition; the subsequent delivery update above replaces its event-only re-shoot hold.

### Added

- Add bounded chapter-history restore, durable restore-specific undo and conservative read-only
  recovery through Library. Verify a visible safety snapshot and prepared exact-result intent before
  the existing journal-aware checked writer replaces a body; preserve current metadata, exact-check
  version/hash even for equal text, retain all recovery files on failures, and never replay uncertain
  writes. Add synthetic core/desktop fault, concurrency, reload, archive and racing-draft tests.
  Live draft/save gating, IPC, confirmation/recovery UI and whole-feature acceptance remain open.

- Add an isolated chapter-history dialog with named saved-only capture, per-record size and
  unavailable notices, literal read-only bodies and saved-text comparison. Bind asynchronous results
  to library/chapter/view lifetimes and exact source tokens; preserve dirty drafts, block duplicate
  submissions and require history review after unconfirmed capture. Focused synthetic UI coverage
  accompanies the leaf; parent mounting, validated host APIs, restore/undo and integrated acceptance
  remain follow-through for spec 032.
- Correct history codec admission before new recovery writers use it: reject unpreservable YAML
  metadata without changing the file, and keep all history source-resolution diagnostics quiet.
  Verify saved-source UTF-8/raw hashes, snapshot metadata before asynchronous serialization, and
  list unsupported filesystem history entries without following them or admitting them to archives.
- Clarify unconfirmed history writes after possible publication: retain the complete record,
  disable automatic retry, and direct the author to review history first. Add injected post-write
  readback-failure coverage and document the filesystem adapter's cross-process race limitation.

- Add the saved-only chapter history core: explicitly capture named versions, list/open their
  ordinary book-scoped Markdown files, and compare with current saved text through Library.
  Records validate stable identity, provenance and body hashes, preserve unknown metadata, report
  unavailable files, and survive archive/trash journeys without changing chapters or flushing drafts.
  Document the format and ADR 0016; retain every snapshot, safety record and intent without automatic
  pruning. IPC/UI, restoration, undo and explicit cleanup remain separate follow-through.
- Add isolated, callback-driven worldbuilding create/edit and saved-word goal set/clear/progress
  components. Retain exact drafts and original baselines across refusals; distinguish checked
  current no-ops, verified conflict copies and uncertain outcomes, with explicit compare/reload/
  discard choices and view-bound replies. Add focused synthetic component coverage and narrow
  planning/goal type exports. Product mounting and the reviewed core corrections remain separate.
- Add the first Library-owned planning/organization core slice: bounded loose planning and goal
  schemas, worldbuilding create/read/edit and goal set/clear with exact raw baselines, no-write
  current no-ops, owner checks, one checked commit attempt and verified complete conflict copies.
  Saved goal progress distinguishes complete, incomplete and unavailable sources. Document the
  sidecar/recovery format and add synthetic boundary/failure tests; host/API/UI integration remains
  a separate delivery slice.

### Changed
- The Linux end-to-end job is no longer allowed to fail. It had been advisory since its first Linux runs failed at
  launch on Electron's sandbox helper. After that was fixed and the browser smoke check was made to wait for the
  page, it passed three runs in a row on `main` (both the verify and the end-to-end job, read from the jobs and not
  from the run, which `continue-on-error` kept green), so a failure in it now fails the workflow like the verify job.
  The workflow comment, the README Verification paragraph and the Linux note in `docs/TESTING.md` say so.
- The hidden smoke run checks a damaged chapter file in the real app. While the book is open it writes a chapter file with
  broken front matter into the disposable smoke library, as another editor might, and confirms the workspace names the
  file in its notice, the readable chapters stay readable, a Word export and a Markdown export through the real bridge
  are refused with the fixed message, the exports already in the folder are byte for byte unchanged, and no source file
  changes. It then removes the file and takes the removal in. With the export refusal switched off the check fails.
- The hidden smoke run no longer asks the operating system for protected storage. An unpackaged run started with both
  `STUDIO_TEST=1` and `STUDIO_NO_KEYCHAIN=1` uses a cipher that reports storage as unavailable and refuses to encrypt or
  decrypt before the system is asked, including the status read Settings makes on open (D-191). It is a refusal and
  not a fallback: nothing is written, either flag alone changes nothing, and a packaged build ignores it. The smoke run
  also starts the app with an allowlisted environment, so a provider key or a STUDIO_ flag in the caller's shell never
  reaches it.
- The browser smoke check waits for the page the way an author would: it polls for the screen it expects, up to ten
  seconds, instead of sleeping 1.2 seconds after each load and looking once. After a reload it waits for whichever
  first screen the page draws, the welcome or the library, chooses browser storage only if it is the welcome, and
  then waits for the book's card, because the library draws at once and its cards when the listing comes back.
  When a wait times out, the failure now says what the page showed and how many page errors there were, so a failure
  on a slow runner can be told from a broken page. One Linux run failed the welcome check two seconds after the
  load, on a commit whose other runs passed; the cause was not reproduced locally, so this makes the check
  tolerant of a slow first draw and its next failure self-explanatory.
- Rename the product to Open Book Studio everywhere an author, a command line or a file reader sees the name: the library header, the
  window title, error and refusal messages, the `bookwriter` usage banner and MCP server text, the sign-in loopback page, the glasses page,
  open/save dialog filters, the exported EPUB creator fallback, the licenses dialog and the microphone permission text. Identifiers stay as
  they are: package names, the `studio.aibook.app` bundle id, storage keys, the `.ai-book-studio` locator directory and the packaged
  `productName` (it names the packaged app's data folder, so changing it needs a migration decision first).

### Documentation

- Resolve the contract review: scope conversation persistence to 037, explicitly keep 039 runs
  volatile, qualify whole-field book replacement semantics, and validate exact new-spec status
  tokens with an optional description rather than accepting arbitrary prefixes.

- Accept D-163–D-168 under delegated authority with ADR 0017: checked planning/organization sidecars,
  explicit bounds and identities, scoped recents, complete saved-word goals and exact source anchors.
  Reconcile current D-190 premises and the decision-only tasks without claiming feature implementation.
- Accept D-193 / ADR 0018 for initial review envelopes, exact citations, versioned reader profiles
  and shared overflow limits. Keep U-039-04 on single-book request assembly and require shared
  conversation safety before durable integration; later media, routing and autonomy work remains retained.
  Completion validation permits an explicit In progress/Implemented transition for these specs while
  continuing to reject completed tasks under a wholly Draft/Planned status.

- Address the independent delivery audit: distinguish supported turn schemas from runtime message
  population, correct the already-fixed header export refusal note, and require each advertised
  execution-stream lane to have explicitly assigned work. File-write ownership remains a separate
  coordinator responsibility; graph validation does not claim runtime or release acceptance.

- Record the author's November 7 delegated feature-delivery authority: resolve evidenced design
  recommendations and merge reviewed, validated feature PRs without routine approval stalls,
  preserving existing data-protection, spending and release-access restrictions.

- Add the all-features concurrent delivery DAG: six agent slots, explicit work-package ownership,
  first-wave deliverables, scoped decision gates and a continuation protocol. Include Story Bible/
  series work directly in L24 completion and validate both DAGs, terminal coverage and stream ownership.

- Refresh the November 7 public state at `55b55b8`: link the author's new README demo with a clickable
  thumbnail, preserve the original submitted video, and record merged voice/file-safety work and dated
  macOS/Linux verification. Reconcile integrated spec 038 ownership while leaving T022 unchecked and
  keeping live-provider/device/release evidence separate.
- Reconcile 031/032 with accepted D-175–D-179, record only completed decision tasks and the already
  documented form submission, and retain outstanding implementation and film acceptance tasks.
  Expand the remaining-work sequence and 039–042 decision packets/delivery checkpoints; preserve
  open storage, consent, lifecycle and output decisions, the U-039-04 gate and unresolved DAG scope.

- Update the README's current state: a short status section (the name, hardening since the hackathon,
  models, checks and what is still ahead), a Verification section that describes the manual GitHub Actions
  workflow instead of saying there is no public CI, Muse Wonder 1.0 in the Meta models table, and one stale
  note removed.

- Add Draft/Planned specs 039–042 for structured reader/continuity review, Android, book-level
  covers and audiobook casting, each with decision gates, acceptance scenarios, plan and unchecked
  tasks. Map all 15 completion requirements and 25 lanes to spec owners, preserve reserved 038,
  and add a validator for ownership, spec triplets, DAG acyclicity and Mermaid edge agreement.
  Record the requested OpenCode maximum-effort review and resolve its disclosure, conditional-edge,
  evidence-date, Android-anchor and reduced-motion/transparency findings without claiming acceptance.

- Distill the researched completion gaps into 15 public requirement IDs with explicit acceptance
  checks and a proposed sequence for new review, Android, cover and audiobook specifications.

- Add an evidence-scoped product-completion DAG with separate desktop-release and wider-roadmap
  milestones, explicit lane dependencies and acceptance gates for the researched feature surfaces.

- Rename the public-facing project to Open Book Studio, update repository/demo links and record
  the successful hackathon submission. Explain the built-in CLI/MCP and ambient spoken-reply flow,
  including the boundary between author-controlled recording and future continuous listening.

- Record character/narrator voice casting, audiobook creation, dedicated cover design and Android
  as planned, with future app-store links to be published in the repository when releases are ready.

- Add a README feature-status and delivery matrix covering implemented and planned capabilities,
  protected key storage, speech input/output, agent voice preferences and release limitations.

- Expand the submission packet with the earlier prototype and fresh-rewrite provenance, Spec Kit
  development workflow, dated implementation baseline, author journey and current demo limitations.
  Link the public repository and distinguish final submission evidence from historical checks.

### Fixed

- Gate the workspace More sheet's Back to library control with the same planning navigation guard as
  the header Back. A dirty, pending or uncertain planning draft now blocks that exit without queueing
  navigation; the sheet closes, the discard confirmation stays reachable, and Back works after explicit
  discard. A mounted workspace regression covers the dirty-goal path.
- W05 export safety: Word, Markdown, PDF and EPUB reject destinations that resolve inside the
  open library, including parent-directory aliases. They recheck destination identity and content
  immediately before atomic publication, preserve the supplied saved snapshot, and name any
  temporary output that could not be cleaned up while retaining the primary failure. Format and
  header exports also refuse pending/failed format saves and unresolved matter-save conflicts.
  Snapshot image-warning collection and visible structured export receipts are prepared; their
  production IPC wiring remains a coordinator integration step. Synthetic focused tests cover
  source/prior-output bytes, alias changes, filesystem failures and save/status behavior.
- W01 F3 adapter repair: apply the existing no-symlinks/no-special-files policy to direct library
  operations, both move endpoints, device metadata and watch callbacks. Preserve selected-root
  platform aliases, atomic writes and own-write bookkeeping; a failed identity read no longer
  triggers replacement. Synthetic history-shaped fixtures prove refusal without outside writes
  and normal archive inclusion. This is a static-path check, not protection from concurrent
  hostile path replacement or OS-level compare-and-swap.
- A Story Bible save no longer wipes what another device, the agent or the toolkit wrote to `book.json`
  while the dialog was open (QA D3). The dialog sent its whole state and `book.json` was written from
  that stale copy, so a character another device added or a memory the toolkit saved disappeared with
  no conflict copy. Editors now send only the fields they changed, each with the value they started
  from, and the main process merges them onto a fresh read of the file under the book's write lock:
  objects key by key, characters and memories record by record, rewriting only the parts that changed.
  Where both sides changed the same part, the file keeps the other writer's value, the author's version
  of the book is kept as `conflicts/book.conflict-external-edit.<device>.<time>.json` and listed with
  the book's other conflict copies. The Story Bible names the fields that overlapped and offers
  "Show the copy", and the workspace's saved-copies banner offers it too. The format settings, a rename, the model
  picker, the agent settings and the agent's book tools (and so the toolkit's) merge the same way, and
  a story arc written as lists stays as written until that part is edited. The default provider,
  connection and model merge as one choice, so a new connection is never saved beside a model another
  writer picked for the old one, and an agent setting that overlaps another writer's is refused with a
  note that says where the author's version went, instead of answering as if it had been saved.
  Changing a format control several times before the first save returns saves in turn, each from the
  settings the one before returned, so the last choice stays and an earlier one is not mistaken for another
  writer's change.
  Each of those saves carries only the field its control changed, so a field changed outside meanwhile is
  kept, and a format change that clashes with an outside one lists the author's copy so the saved-copies
  banner can show it. A change still waiting its turn keeps the value the author saw for its own field, so an
  outside change to that same field meanwhile is a clash and not written over.
  While any of those saves is out the dialog keeps the values the author chose, so a third change starts from
  the author's own last choice and does not clash with it.
  A format save waiting its turn belongs to the book it was made in: if the workspace moves to another book
  meanwhile, that save still goes to its own book, and the next one starts from the book now shown.
- The book settings dialog no longer closes behind a plain notice when a title or description edit clashes with an
  outside change. It stays open, names the fields whose version was kept as a copy, and offers Show the copy.
  After a save that applied one field and kept the other as a copy, the dialog measures its next save against what
  that save left, so changing the applied field back is saved and not dropped as no change.
  A field the author left alone follows the book that save returned, so the retry sends only what was edited and
  does not put the old text back over another writer's change.
- Choosing the book's default model when another writer changed it first lists the author's copy, so the
  saved-copies banner and Show in folder appear, instead of leaving only a notice.
- A book that another device upgraded to a newer schema while it was open is no longer written by this
  build (QA D6). The schema was checked only when the book was opened or its details were saved, so a
  chapter save, a new, moved, deleted, restored or split chapter, a chapter's details, a kept conflict
  copy, moving the book to the trash, an image, a conversation, the agent's chapter tools and the
  toolkit's saves all went ahead in a book whose new fields this build does not know. Now every write
  into a book reads `book.json` first and refuses a newer `schemaVersion` with "was written by a newer
  version of Open Book Studio" before anything changes, and leaves every byte as it was.
- A field a newer build adds to `book.json` survives a save at every level (QA D7). A character, a
  memory, the story arc and its three parts, the chapter range and every settings section lost any
  field this build did not know the next time the book was saved; they are now kept and written back
  as they were read, as `docs/FORMAT.md` already promised.
- A book whose story arc was written the way `docs/FORMAT.md` used to describe it, with `keyMoments`
  and `openQuestions` as lists of strings, opens again, one line per item. It used to fail the book
  schema, so the book showed as unreadable. `docs/FORMAT.md` now describes the text shape the app writes.
- Moving the chapter you are writing no longer turns your next save into a conflict (QA D5). A move
  rewrites `order` in every chapter file it shifts, so the open chapter's version and hash moved on
  while the editor kept the ones it loaded. Its next autosave was refused as a newer version, and
  your words went to a conflict copy you had not caused. This happened with the rail's **Move up**
  and **Move down**, ⌘⌥↑ and ⌘⌥↓, a drag, a drag of another chapter past the open one, and an
  agent's `move_chapter`, `split_chapter` or `merge_chapters`. Now the editor's saves wait while a
  move runs, and when the open chapter's file comes back with its words and title unchanged, it
  becomes the editor's base. Words typed while the move was on its way stay in the editor and save
  normally afterwards, with the caret, focus and undo where they were. After an agent turn the
  workspace does the same before it saves your unsaved words, and remounts the editor only when the
  turn changed the chapter's words or title. A move that meets an outside edit and is put back
  leaves the editor on the right base too.
- Moving a chapter in a long book no longer renumbers the chapters behind a gap (QA D10). After a
  chapter had been deleted, dragging a chapter two places in a 300-chapter book rewrote 295 files,
  and a move rebuilt the library catalog once for every file it wrote, 300 times for a drag from
  first to last, all while the book's saves waited. Now the chapters between the two places share
  out the numbers those places had and keep the gap, so that drag rewrites three files and every
  move rebuilds the catalog once. A merge across a deleted chapter is no longer refused, and the
  agent's split puts the new half right after its chapter in a book with a gap, because both now go
  by place in the book. A move cut short, for example by a crash, leaves at most the moved chapter
  and its new neighbour on one number; the book reads in one order, ties broken by file name as
  `docs/FORMAT.md` says, with every other chapter in place, and the next move, from the buttons as
  well as a drag, gives each chapter its own number instead of refusing with "Two chapters share
  the same order".
- An export no longer hands over a book with chapters missing. When some chapter files cannot be read (the workspace
  already reports them), the Word, Markdown, PDF and EPUB exports now refuse before asking for a destination, building
  a file or writing anything, and say "The manuscript was not exported because some chapter files could not be read.
  Reopen the book and review the affected files." Source files and any earlier export stay exactly as they were. The
  plain `bookwriter read` chapter list now says "(readable files only)" for such a book, names the affected files on
  stderr and exits 1; `--json` keeps its payload. Eight export tests (two kinds of damaged front matter across the four
  exports, each checking that nothing was asked or written) and three toolkit tests cover it.
- The release record script no longer replaces a record that already exists: a second run for the same path is
  refused (exit 3) and the earlier record is left as it was. A new record is written to a temporary file beside the
  target and hard-linked into place, so the final path never holds a half-written record. On a file system that
  cannot hard-link, nothing is published and the script says so, rather than writing the record in place. Five
  tests cover the refusal, the absence of a leftover temporary file, the new `publishRecord` helper, the
  fail-closed case and a failed write or sync, which also removes its temporary file.
- The bridge end-to-end probe no longer fails after its checks have passed. It killed the app with SIGKILL and removed
  the throwaway profile at once; the dying app could still be writing into the profile, so the removal threw
  `ENOTEMPTY` as an uncaught exception and the stage exited 1 on one Linux run in four. It now waits for the app to
  exit, retries the removal, and reports a cleanup failure on stderr without failing a probe whose checks passed.
- The manual Linux workflow's end-to-end job now installs only Chromium, the one browser its stages drive, and the step
  has its own ten-minute limit. It used to install Chromium, Firefox and WebKit with all their system packages; that
  step stalled for the whole 45-minute job limit on two of the last six runs and cancelled the job. Firefox and WebKit
  are only needed by `bun run matrix:web`, which the job does not run.

- The manual Linux workflow's end-to-end job now uploads the smoke's failure screenshot and console log when a check
  fails (kept for seven days). The job still fails 9 of the 44 smoke checks on Linux while it passes on macOS, and
  the cause could not be seen without those files.

- Saving a chapter keeps trailing whitespace in front-matter values written by another editor or by an
  older version, such as a block scalar ending in spaces or blank lines. The studio used to trim it
  on write and not restore the final newline on read, so a save could change text it did not own.
  Seeded round-trip tests cover the serializer, the parser, CRLF headers and a save through the library service.

- Keep concurrent local profile saves in order, and allow an author to repair removed voice
  connections one at a time without introducing an unavailable choice or switching providers.
  Reject incompatible, contradictory or truncated PCM speech responses instead of wrapping them
  in a misleading WAV header; do not join explicitly non-MP3 responses as MP3. Refresh the
  workspace's speaking status after Settings changes and distinguish unavailable choices from
  a device that cannot speak; do not use a superseded status read to select a voice. Check the
  selected transcription connection and model before opening the microphone, and refresh the
  editor's dictation indicator when Settings changes. Bind each recording to its starting choice,
  refuse a changed choice at submission, and isolate cancelled recording callbacks from later ones.
- Recognize Meta's listed Muse Wonder 1.0 as a tool-capable writing model using the documented
  context size and Standard-mode prices when the catalogue omits metadata. Existing turn attribution
  is preserved; Wonder Full and unverified Contributor variants are not enabled by this preset.

- Give the writing composer more room, let its model/background controls wrap in narrow panels,
  and present Background as a labelled On/Off control with keyboard focus and disabled states.

- The manual Linux workflow's end-to-end job now fetches Electron and gives its sandbox helper the owner and mode it
  requires before running, so the app can launch there with the sandbox on. Before, the smoke, web, bridge and
  second-instance checks aborted at launch. The job is still allowed to fail until it has been watched passing.
- The smoke no longer fails on Linux for what Linux does not offer. The seven manuscript-import checks (spec 029's
  macOS reference journey; the library only shows that button on macOS) are reported as skipped off macOS and counted
  as neither passed nor failed. The failed-turn check reads the chat panel's text without depending on rendering and
  closes the agent panel when it fails, so one failure no longer takes the next check down with it. macOS still runs
  all 44 checks. The second-instance check also leaves Chromium's Linux GPU caches (GPUPersistentCache, GPUCache)
  out of its profile comparison, as it already did for macOS's GraphiteDawnCache, and the agent check
  no longer asks Linux to see the startup line about the in-memory test vault: the app prints it before the check's
  output is attached there, so it stays a real check on macOS and is asserted by the unit test everywhere else. The
  Linux job stays allowed to fail until it has been watched passing.
- A library kept in browser storage is no longer described as a folder: the library header names
  the browser, a book that cannot open no longer says its folder was left unchanged, and the
  closing note explains the storage instead of inviting the author to open files in an editor. A
  folder chosen in the browser keeps the folder wording.
- A save now records the hash it is about to commit in the sync journal before the atomic file commit, as well as
  the observed hash after it. If the process stops between the commit and the post-save journal update, the next
  scan still recognises the exact committed bytes as this device's own save instead of reporting an outside
  change. A different on-disk hash remains an outside change for review.
- A backup the legacy importer refuses now reaches the author as `invalid` input instead of an
  internal error, and is not written to the console as one.
- The Format dialog and the workspace header export now share one failed-save sentence, from a
  single source, so an export stopped by a chapter that could not be saved reads the same wherever
  it was started.
- Desktop OpenRouter sign-in consumes its loopback callback once and no longer trusts a late reply. A
  reused or cancelled sign-in link now answers that it has already been used, an expired request or a
  cancelled sign-in aborts an in-flight key exchange and discards its response, and a credential written
  by a sign-in that is cancelled or expires during the vault write is removed again. The providers
  service tests cover duplicate callbacks, late responses, cancellation at each await and a write that races
  cancellation.
- Reopening the studio while a background turn is still running opens that turn's conversation and
  the chapter that was open when its window closed, instead of the library and the first chapter.
  The window remembers both when it closes, so a turn that finishes after the reopen is already
  there, and one that finished while no window was open opens on the same chapter.
- Editing a book's details no longer discards the author's change when the book file was changed outside the
  studio while the update was saving. The update is kept as a conflict copy, the outside edit stays in place and
  the studio says so, instead of failing with nothing saved. Two such conflicts in the same instant each keep their own copy.
- The per-book tone and answer length now travel with every agent turn, as the Agent dialog
  promises: both are in the turn's system prompt, proven inside the 4,000-token prompt budget at
  the maximum tone length for every answer length. At 1024×700 with the writing agent open, the
  chat panel takes a responsive width instead of a fixed 400px, so the manuscript keeps room and
  the book title ellipsizes.
- Atomic writes use exclusively created, random sibling temporary files, preserve existing ordinary
  permission bits when no mode is specified, and respect the process umask for new files. Temporary
  files start private; transient rename retries retain the same complete file, and failed cleanup
  does not hide the original error. This does not provide compare-and-swap against external writers
  or preserve ACLs, ownership, extended attributes or symlink identity.
- Conflict copies retry occupied names, including when the device and clock are unchanged, and never
  report a saved copy when storage rejected the write. Book detail updates check the snapshot they
  read rather than requesting an unconditional replacement.
- A failed chapter merge restores the second chapter's original file and identity instead of
  recreating its text. Recovery distinguishes save failure from a version conflict and recognizes
  a chapter already returned to the book. Agent undo also checks for a chapter returned during
  recovery and refuses a trash reference to another chapter rather than creating a duplicate.
- Browser OpenRouter sign-in consumes its callback once and no longer trusts a late reply. A duplicate
  callback cannot exchange the same code, a failed exchange cannot be replayed, an expired request or a
  cancelled popup discards an exchange response that arrives afterwards, and a credential written by a
  sign-in that is cancelled or fails mid-write is removed again. A browser that denies site storage now
  rejects the sign-in instead of leaving Settings waiting, because storage cleanup can no longer throw before
  the promise settles. Synthetic regressions cover each case.

### Added

- Add local voice preferences for choosing Meta or OpenRouter transcription and OpenAI or
  OpenRouter speaking models and their supported voices. Settings reads a local catalog without
  probing providers; requests use only the author's selected connection, and browser provider
  voice operations remain unsupported (spec 038, D-192).
  The OpenAI models `tts-1` and `tts-1-hd` are offered only the voices they support (not `ballad` or `verse`, which
  only `gpt-4o-mini-tts` has), in Settings, in saved choices and in the check before a request, so a pairing the
  provider would refuse is never offered, saved or reported as available.
  OpenRouter transcription encodes the recording a slice at a time instead of appending four characters per three
  bytes, so a ten-minute dictation no longer holds about 800 MB of strings or stalls the main process while it is
  encoded (about 1 s and 820 MB before, 40 ms and 60 MB after in a Node measurement of 19 MB).
- Front and back matter for every export (spec 035 T007–T013, D-169 and D-170, accepted on the
  author's delegation). The Format dialog has a **Front and back matter** section. The author turns
  the generated title page on or off and gives it an author and a subtitle. They add copyright,
  disclaimer, dedication, epigraph, acknowledgements, about-the-author and other pages; the
  copyright and disclaimer pages start from editable text that claims no legal advice. Headings
  and Markdown text are edited in place. **Move up** and **Move down** reorder the pages from the
  keyboard, keep focus on the moved page, and cross the chapters at the end of a side. Removing a
  page asks first. The approximate preview shows everything in export order.
  - Every export uses one order: the title page, the front pages, the contents page when the book
    asks for one, the chapters, then the back pages.
    - Word gives each page its own page, and the generated title page its own section, centred
      vertically; the document's author property names the author.
    - The EPUB gives each page its own XHTML document with its structural semantics
      (`titlepage`, `copyright-page`, `dedication`, `epigraph`, `acknowledgments`, or the front or
      back partition), listed in the spine and navigation in order, with the author as
      `dc:creator`.
    - The PDF prints the same order, and its contents page lists the back pages.
    - Markdown puts each page under its heading.
  - The matter lives in a new optional `matter` value in `book.json`, documented in
    `docs/FORMAT.md`.
    - It saves only through the new checked `books:saveMatter` channel. The save carries the
      version and hash it started from and is validated by Zod for ids and sizes.
    - A stale save keeps the author's matter as JSON in `conflicts/`. The dialog shows the newer
      matter on disk, names the copy and offers **Show the saved copy**.
    - A save made as the dialog closes reports through the workspace if it fails.
    - The general book update never writes the matter.
    - A value the studio cannot read never stops the book from opening; it is never saved over,
      and exports stop with the reason.
  - A book without matter, or with matter that holds nothing, exports exactly as before. Once the
    matter holds anything, the generated title page shows the title, subtitle and author instead of
    the description, and the preview shows it.
  - The older free-form `frontMatter` record is kept exactly as written and is never exported. The
    dialog lists its entries that no export includes, with where each would go, and adds the ones
    it can place only when the author asks, without adding anything twice or overwriting an author
    or subtitle.
  - Format settings persist per book; the export target stays a choice for each export.
- A test pins how a book without front or back matter exports, before ordered matter is built
  (spec 035 T013). Five synthetic books were rendered by the current exporters into goldens: every
  Word part, the EPUB's exact bytes, the Markdown text, and the HTML Chromium prints to PDF with
  the text a reader sees in it. They cover a contents page on and off, an empty title, no chapters,
  verse and blank lines, text that needs escaping, PNG and JPEG illustrations, both title
  alignments and a populated legacy `frontMatter` record, which no export includes.
  `no-matter-identity.test.ts` requires the same output from today's code. The Word build time
  and the `docx` library's drawing counter, which numbers pictures for as long as the process
  lives, are not content and are left out of the comparison.

- The Format dialog now exports all four targets, with an Export action for the chosen one (002
  FR-051, D-108). PDF prints the manuscript's own HTML through Electron's built-in Chromium in a
  hidden window that runs no script, on a private in-memory session that answers every web request
  itself, under a content policy that refuses anything remote: a title page, a contents page
  when the book asks for one, each chapter on a new A4 page, the book's font, size, first-line
  indent, line spacing, chapter title alignment and line-break setting, and the chapter
  illustrations in the Word export's order, inlined only in the page being printed. EPUB 3 is
  assembled with `fflate`: the `mimetype` entry first and stored, a package document with its
  manifest and spine, a navigation document, one XHTML file per chapter, a stylesheet and the
  unmodified images under `images/`, with fixed entry dates and an identifier from the book's id,
  so the same book always gives the same bytes. Both go through the Word export's publication
  boundary: a cancelled picker or a declined replacement writes nothing, a destination inside the
  library is refused, a file that changed after consent is refused, and the write is atomic. Word
  and Markdown export from the dialog through their existing channels; the header's buttons are
  unchanged. The dialog saves the open chapter first, exports nothing when that save fails, names
  the saved file the way the header does, and says why an export was refused. The browser build
  explains that exporting is a desktop feature. Fonts are requested by name, not bundled, so a
  font the computer lacks prints in a similar one. Nothing claims KDP or other publisher
  acceptance, EPUBCheck validity, PDF/UA or exact pagination, and PDFs are not byte-identical,
  because Chromium writes a creation date into each one.
- The product film now assembles with one command. `video/edit/film.json` is the edit list: one
  segment per row of the approved script, with its times, the voiceover and on-screen text copied
  exactly, its event tag, what the shot needs live, its picture (motion plates, footage clips with
  in and out points, and cards), whether it is cut, and the script's cut order.
  `node video/edit/assemble.mjs` renders any missing plates and caption cards, then builds a
  1920×1080, 30 fps H.264 master no longer than 3:00. Each segment's picture is fitted to its slot,
  with its lower third and event tag laid over it. The sound is the matching slice of
  `video/footage/narration.wav`, or silence. It also writes an `.srt` of the voiceover. A clip that
  has not been recorded is a slate that says "Footage pending" and names the file, so the timing can
  be checked before any footage exists. `--cut30` builds the plan's 0:30 cut. `--check` prints each
  segment's planned and built duration, and fails when the film runs over 3:00 or the edit list
  drifts from `video/script.md`. The caption cards (`video/cards/`) are a deterministic page in the
  studio tokens, rendered frame by frame through Playwright like the motion plates.
  `video/footage/README.md` names every clip and the 1440×900 @2×, 30 fps capture. Footage and
  renders stay out of git.
- The product film can play a clip's own sound. A clip in `video/edit/film.json` may set `sound`, a
  gain from 0 to 1 (absent means muted), and its audio then plays in sync with its picture: from its
  `in` point, after any earlier sources in the segment, and only inside the beat the 0:30 cut takes.
  It is mixed with the narration at that gain, without amix's normalization, and a mono clip plays in
  both channels; a clip without audio, or a slate, adds nothing. Only the strip
  (`shot-04-strip.mov`, 1:15–1:29) has `"sound": 1`, so “it answers out loud” is heard; the other
  clips stay muted. The master and the 0:30 cut are now normalized in two loudnorm passes to about
  −14 LUFS integrated with a true peak at or under −1 dBTP (spec 021 FR-010), and the sound still
  ends on the same sample inside the last frame. Segment intermediates carry float PCM, so a line and
  a clip that add up past full scale do not clip before that pass. `--check` measures each build with
  ffmpeg's EBU R128 meter and, when the build had narration, fails outside −15 to −13 LUFS or above
  −0.5 dBTP.
- An end-to-end check of the agent toolkit, `scripts/toolkit-e2e.mjs` (`bun run e2e toolkit`). It
  launches the built app hidden over a synthetic library, drives the compiled `bookwriter` CLI and
  `bookwriter mcp` over stdio, and checks every answer against the bytes on disk. A tool switched
  off in the Agent dialog is refused by `bookwriter call` and by MCP `tools/call` with the author's
  words; a checked save changes the file, and a stale one leaves a conflict copy and the newer text
  untouched; nothing writes without `--allow-writes`, and a read-only MCP server lists no write tool.
  It also reports, without failing, that MCP `tools/list` and `bookwriter tools` still list a
  withdrawn tool, because neither names a book.
- `bun run e2e offline` (`scripts/offline-check.mjs`) proves 002 FR-060 on macOS: the built app runs
  hidden inside a `sandbox-exec` profile that denies every outbound connection, loopback included,
  and still creates a book and a chapter, autosaves typing, saves a Story Bible edit, imports a TXT
  manuscript and exports Word, Markdown and a library archive, each read back from disk. The check
  fails unless the app's own processes are refused when they try to connect out, before and after
  the journey. `e2e` now reports a platform-bound check as skipped instead of passed. 002 FR-069,
  which this check left open, is now met: a second copy on the same profile is refused, and
  `bun run e2e instance` proves it (see Fixed).
- Word documents (.docx) now import on the macOS desktop app (D-183, spec 029). The importer
  first checks that the file really is a Word document and refuses, in plain words, a
  password-protected, macro-enabled, older .doc, OpenDocument or damaged file; it reads at most
  5 MiB of file, 50 MiB of document XML and 5 MiB of resulting text. Paragraphs, bold and italic,
  line breaks, lists, quotes and scene breaks become canonical Markdown, and empty paragraphs stay
  as blank lines. The document's top-level headings are proposed as chapters titled by their text,
  a Title paragraph names the book, and the existing preview lets the author keep, move or remove
  each split before anything is written. Tables, images, footnotes, endnotes, comments, tracked
  changes, text boxes, fields, page headers and footers, links, underline and strikethrough are
  listed with a count and where they were, in the preview and in the result report. Images are
  never stored, as base64 or otherwise. Publishing uses the same staged atomic write as text
  imports. The browser and mobile builds still refuse, now naming Word documents among the
  desktop-only formats.
- Settings → About → Show open-source licenses lists what the build ships: the studio's own
  Apache-2.0 license and notice first, then every package with its version and license, searchable,
  with each package's full license text (D-186). The build generates the list: a Vite plugin
  collects every package in the renderer, main, preload and web bundles; the desktop adds the
  production dependencies electron-vite leaves external, and Electron with a pointer to its Chromium
  credits. Each build writes `licenses.json` (the desktop serves it read-only over `app:licenses`,
  the browser fetches it from its own origin) and regenerates its own section of
  `THIRD_PARTY_NOTICES.md`, which is no longer kept by hand. `bun run submission:check` now fails
  when a shipped package has no license, an unknown license, `UNLICENSED` or a copyleft license that
  `scripts/license-allow.json` does not allow with a reason; its one exception is the desktop SAM
  parser under D-137. The Gitea security scan now runs after the bundles, so the gate reads them,
  and the accessibility gate scans the licenses view at all four widths.
- The book's actions in the library now export every image as a JPEG in one action, separately
  from the manuscript (002 FR-050). Export images asks for a folder and creates a new
  `<book>-images` folder in it. A chapter's picture is named for its place in reading order and
  its title (`01-the-door.jpg`), and other pictures for what they are (`cover.jpg`,
  `character-mara.jpg`, `illustration.jpg`, `image.jpg`). A repeated name gets `-2`, compared
  without case. JPEG pictures are copied byte for byte. PNG and WebP pictures are converted with
  Electron's `nativeImage` at quality 90, and a picture that cannot be read or converted is skipped
  and named with its reason. A book without images says so and opens no picker. A cancelled picker
  writes nothing, and a destination inside the library is refused, including through a symlink. If
  a folder with that name already exists, the export is refused rather than merged. The files are
  staged in a hidden folder beside it, which is renamed into place only once every file is written,
  so a failure leaves nothing behind. The dialog then says, for example, "Saved 3 images to
  the-salt-road-images". The browser build does not offer it and explains that it is a desktop
  feature. The Word and Markdown file names now use the same naming rule, which cuts a long title
  between whole characters, within 180 bytes, and drops a hyphen left at the cut.
- An end-to-end check runs one real agent turn through the built app without the author's
  keychain (D-184, spec 012 T034). An unpackaged run started with `STUDIO_TEST=1` and
  `STUDIO_TEST_MEMORY_VAULT=1` keeps connections in memory only: nothing calls safeStorage and
  nothing is written to disk. A packaged build, or a run without `STUDIO_TEST`, refuses the flag and
  logs one line, and a computer without protected storage still refuses to save a key
  (`apps/desktop/tests/memory-vault.test.ts`). `bun run e2e agent` (`scripts/agent-check.mjs`)
  points a Meta connection at a fake OpenAI-compatible server on loopback. The turn reads the
  chapter, appends a sentence through a checked save and replies. The check then proves from disk
  the chapter's new version, the stored conversation with its tool parts, the usage line naming the
  model, an undo that restores the body byte for byte, and an overwrite that writes nothing until it
  is approved. Every provider request reaches the fake, and an observer inside the app sees no
  other outbound request. The key is in no file of the run's profile or library and in no line the
  app printed. The check turns desktop notifications off inside the app, because a hidden window
  would otherwise announce every finished turn; a hidden run now logs them instead (see Fixed).
- A model the connection does not list, or a connection whose list cannot be read, can now be
  entered by hand (011 FR-007). Enter a model id in the model picker; the path opens by itself when
  the list fails. The main process sends that model one short request through the same adapter a turn
  uses, so it goes only to the connection's own endpoint and base URL, with no book text and no
  retries, and keeps the id only if the model answers. A refusal says why: not found, no access,
  rate limited or unreachable. Kept ids live in the connection's record beside its base URL, so they
  survive a restart and go when the connection is removed. The picker marks them "Entered by hand"
  and says "not reported" for every fact the provider did not give; unknown tool support still keeps
  a model from the writing agent, while Meta's Muse Spark presets, Contributor opt-in included, still
  apply. The browser build does not offer it, because it cannot run the writing agent yet. Removing
  an OpenRouter connection now also says that the key exists in the author's OpenRouter account and
  can be revoked there, with Open OpenRouter keys (FR-013); a new `app:openLink` channel opens exactly
  https://openrouter.ai/settings/keys and refuses any other address.
- The workspace exports the manuscript as one Markdown file beside the Word export: the book
  title, then each chapter in reading order under its own heading with its text unchanged. It
  goes through the same publication boundary as Word (a cancelled picker or a declined
  replacement writes nothing, a destination inside the library is refused, a file that changes
  after consent is never overwritten) and the header names the saved file. The Word button now
  reads "Export Word document" so the two are told apart. The browser build explains that it
  is a desktop feature. PDF and EPUB now export from the Format dialog (002 FR-051, D-108).
- Each model card now names its capabilities in plain words beside price and context: whether
  it uses tools and reads pictures, or that the provider did not report them.
- A finished turn now shows its whole usage line in the conversation: tokens in and out, the
  reported cost or its estimate/unknown mark, the share of context used, and the model that
  answered in plain words.
- A mid-conversation model change now reads in plain words: the turn records the catalogue's
  display name, and the divider says "Now answering with {account} · {name}" instead of the
  raw model id (older turns without a recorded name still show the id).
- A failed turn that changed chapters now checkpoints before it reports: the error names the
  changed chapters, Retry stays hidden until they are undone, and undoing restores the prose
  and returns the Retry request. When no checkpoint could be saved the turn says the chapters
  need review and offers neither retry nor undo. (Undoing a failed turn previously updated
  nothing on screen; it now patches the turn's message by id.)
- A rate-limited turn says how long to wait and never retries in a loop: the provider's
  `Retry-After` travels from the transport failure to the failed turn, its event and its
  stored message, and the chat names the wait in plain words ("Try again in about 2 minutes")
  beside the existing Retry request. Each attempt makes exactly one provider request.
- An unreachable provider now says so in plain offline words: the failed turn keeps the
  provider message, adds that writing, planning and exporting all still work, and keeps its
  Retry request, so the next prompt sends as a new turn.
- The model picker now shows which account is active: with several accounts on one provider,
  each keeps its label and the book's connection is marked Book default, with a one-off turn
  override named This turn when it differs. Browsing another account never moves the mark.
- A turn that reads before it replies now costs the whole turn: every provider step's reported
  price is summed instead of keeping only the last step's, and the done event and stored
  message carry the summed cost with whole-turn tokens.
- Removing a provider connection is now proven safe: its cached models are dropped (a
  reconnected account fetches again), and the manuscript, its conversation history and every
  library file survive byte-identical.
- Reading aloud can now be held and gone on with: a Pause reading button appears while the
  chapter is said and becomes Resume reading until it ends, for the computer's own voice and
  the voice service alike. A fresh read starts unpaused; ending, cancelling or a new read
  clears the held state.
- Added migration field-carry coverage: `apps/desktop/tests/legacy-import.test.ts` now proves
  outline, story arc (including string and list normalisation), front matter and scene
  purpose/notes survive a legacy import byte-for-byte. `idea` is still silently dropped with no
  skipped-item report; that product work stays open under spec 003
  (FR-026, SC-004). No product code changed.
- Made legacy migration idempotent (003 FR-030): each legacy book is fingerprinted with SHA-256
  over canonical JSON and recorded in `.studio/migrations.json`; a second run over the same export
  creates nothing and names each recognised book, and the library view says so instead of
  reporting a new import. A deleted book re-imports, and an unreadable record warns and imports
  everything again. Match design recorded as D-180; the record format is documented in
  `docs/FORMAT.md`, including the archive-restore caveat.
- Proved author typing survives a live agent turn: text saved while a turn waits on approval
  applies the approved overwrite, and one undo restores the typed text.
- Removing a provider connection is now proven terminal: a later request for that connection
  throws before any network call is made.
- A turn the provider's content policy declines now says so in plain words and offers Try
  another model, which opens the model picker. (Image-generation refusals stay open: that flow
  has no refusal path yet.)
- Provider failures now distinguish a valid key that lacks permission from a rejected key: 403
  and permission-signal failures report `permission` with a needs-permission status and a
  check-the-scopes message, while 401 stays `auth` and content-policy refusals still win.
- Reveal-in-Finder is now driven through the real main-process handlers in a test: the library
  reveals the open folder, a conflict reveals its saved file, and a renderer-supplied escape path
  is refused without touching the shell.
- A failed studio voice no longer means silence or a stale voice label: read-aloud falls back
  to the computer's own voice on service refusal, errors, playback failure and blocked playback,
  and the panel says which voice actually read. The fallback note clears on the next utterance.
- A rendering crash no longer leaves a blank window: an error boundary around the shared app
  shows a plain screen with a Reload studio button on desktop and web. Errors in event handlers
  still report through inline notes.
- Pinned the agent reply contract in a test: the shipped instructions hold the model to two or
  three sentences, no tool names, ids, JSON or process talk, and chapters by number and title.
  Model wording itself is untestable with a mock; no runtime truncation exists by design.
- Pasting into the manuscript now normalises the text on the way in: Windows and old Mac line
  endings, non-breaking spaces and curly quotes are unified (quotes match what the author types,
  keeping pasted and typed prose searchable as one corpus), and runaway blank lines collapse to
  one. Single breaks, stanza breaks, trailing hard breaks, tabs and dashes pass through, so verse
  survives. The shared `normalizePasteText` ships as `@ai-book-studio/core/paste`.
- The agent now checks an author-stated word limit after a rewrite: `replace_in_chapter` and
  `overwrite_chapter` accept an optional `maxWords`, verify the rewritten passage after saving,
  and report within/over with the saved chapter count. A miss is reported, never silently
  reverted. The new bound satisfies the tool limits contract.
- Proved the library grid stats: `listBooks` summaries carry word counts summed from chapters,
  stage, description and chapter counts, and the `library.json` catalog matches. The grid still
  reads all chapter files per the documented catalog-never-truth design; lazy open stays open
  (D-182).
- A previous run's approval can never resume: starting any turn expires stored pending approvals
  no live turn holds (persisted as expired), answering the old turn explains it is no longer
  waiting, and the new turn runs fresh. Approvals held by a live turn are untouched.
- Legacy migration now carries pictures (003 FR-020/FR-024, SC-004): every image version present
  in the export's image map is decoded and stored in the book's image folder byte-identical, with
  prompt, model and cost where the export has them and dimensions and MIME read from the bytes.
  Cover-flagged pages import as cover pictures; missing, unreadable and oversized pictures become
  warnings and never fail the book; per-book picture counts join the report and the library note.
  Page versions, current-version marking, anchor rebinding, cover export inclusion and image style
  stay open (D-181).

- Spec 011 T036: informational spending hooks. The agent dialog has a Spending section with a
  per-turn ceiling and a monthly warning level per book (both unset by default), the month-to-date
  spend with a lower-bound note when turns went unpriced, and both warnings. Warnings never stop
  the agent; enforcement waits on decision D-116, which stays proposed.
- Spec 016 T006/T007: the drift review dialog and the Settings sync section. The main process scans
  on library open and on throttled window focus; the dialog reviews each change with keep-disk,
  keep-mine, open-both and export actions, and the Settings section shows the device, last scan and
  interval. Own saves, trash moves, threads and images note themselves into the sync baseline so
  they never report as someone else's edit. D-120 stays proposed.
- Component tests for the writing agent's shadcn/ui and AI Elements parts (D-185), in
  `apps/desktop/tests/chat-elements.test.tsx` and `chat-tools.test.tsx`. They cover what the author
  sees:
  - a tool step while it runs, once it is done and when it fails, and its detail opening in place;
  - the checkpoint that undoes a turn, and its hint on keyboard focus;
  - Allow and Deny only while a confirmation waits;
  - the context card's share, its bar, and a tap that opens and closes it;
  - the composer's Enter, Shift Enter, Stop and footer click;
  - the Message Scroller following a reply, keeping the author's place, and returning to the end;
  - the Badge, Native Select and Switch.

  With the unused copied code deleted, coverage over the repository's own files (216 before, 214
  after) rose from 91.05% to 93.59% of lines and from 87.31% to 90.91% of functions. The floor is
  unchanged. The Story Bible's visual baselines at 1440 points now show the arc sections' chevrons;
  the migration had re-accepted only the 744-point captures, so the wider ones still drew the old ▶
  markers (779 to 790 pixels, under the threshold).

### Changed

- Restoring a chapter from the trash checks whether that chapter is already in the book inside the book's write
  lock, before it reads the trash file. A restore that races another one, or an undo that finds the chapter
  already returned, now gets "that chapter is already in the book" and nothing is moved, instead of a missing-file
  error. A test also covers a merge whose first save conflicts: the second chapter comes back from the trash
  with its id, synopsis and notes, and the author's combined text is kept as a conflict copy.
- The film script's 0:00 capture note also removes the copy's empty `checkpoints/`, `conflicts/` and
  `threads/` folders, so Finder shows only what existed before the event.
- The web build leaves out code the browser never runs, so the SC-009 perf gate has room again
  (D-188). A resolver in `apps/web/vite.config.ts` swaps five modules for stubs in
  `apps/web/src/desktop-only/`. The first two are zod's JSON Schema emitter and processors (17,483
  bytes): zod hangs them on every schema, but only the desktop agent's tool definitions use them.
  The other three are the manuscript import flow, which the library offers only on the macOS desktop
  (spec 029 T004, T016): the core import module and its preview and result dialogs, with the loss
  list they share (12,654 bytes). Each stub refuses plainly if anything reaches it.
  `apps/web/tests/desktop-only.test.ts` checks that the zod stubs export every name of the modules
  they replace. The web bundle goes from 917,120 to 886,906 bytes, 1.15 times the baseline instead
  of 1.19; the limit stays at 923,592. The web build's features, its CSS and the desktop build are
  unchanged.
- The film script's capture setup films 0:00 on a copy without the event's `images/` and `images.json`,
  and opens the illustration dialog at 1:45 on a chapter with no illustration yet.
- The SAM 3.1 cutout is removed from the build (D-158), so the app matches the submission, which
  claims no cutout. The Illustration dialog no longer offers "Cut out a character", its object search
  or its cast picker when a Meta connection exists; generating an illustration and attaching it to a
  chapter are unchanged. Gone with it: the `segmentation:segment`, `images:saveCutout` and
  `images:attachCharacter` channels, the main-process segmentation service, the core prompt rules,
  the renderer's mask compositing, the live check's SAM step and the `@meta-sam/parser` dependency.
  The desktop build now ships 129 packages and the web build 49, every one passing the license gate
  without an exception, so `scripts/license-allow.json` is empty and D-137 is superseded. A book saved
  by an earlier build keeps its `cutout` image records: they still read, show and export, and the
  image store can no longer write one (`docs/FORMAT.md`). The sample's 512×512 figure of Mara, drawn
  in code by the film fixture generator, is now recorded as `imported`, with the same bytes.
- The GitHub workflow runs only when started by hand, with Bun pinned to 1.4.4, until a Linux run has
  been watched passing. Verification runs locally with `bun run verify`, as the README says.
- The README is the public front page: the pitch and tagline, a plain account of the pre-event base
  and the labelled baseline commit, what an author can do with the Meta model each feature uses, the
  Meta models table, a quick start on the sample and the `bookwriter` CLI, the local verification
  commands and the public clone URL. It drops the stale status line that listed the sync review as
  still to do, the sample cutout and the development repository notes. It now says Bun 1.4 or later,
  that keys are ciphertext in the app's profile under a keychain master key, that the browser build
  holds an OpenRouter sign-in but does not run the agent, that the illustration dialog's SAM 3.1
  cutout returns no records and is not claimed (D-158), and that the desktop build ships one
  package under the SAM License (D-137). The sample's README calls its 512×512 image a figure drawn
  by the fixture generator, not a cutout or a generated image, and names the real buttons for
  opening it.
- The requirement map's tallies are recounted from its rows: 002 reads 65 covered, 3 partial and 10
  gaps, 012 reads 26 covered and 16 gaps, and the totals read 182 covered, 4 partial, 14 manual and
  72 gaps of 272. Export formats leave its list of gap clusters. The submission packet's list of
  event work adds image export, the refusal of a second copy, the end-to-end agent check, approvals
  that resume the whole conversation and one undo for a whole turn, and its latest re-check shows
  1,701 tests, smoke 38/38, e2e 12/12 and coverage of 89.69% of functions and 92.63% of lines.
  AGENTS.md no longer says specs 009 and 012 have no task list. The agent check's notes in
  `docs/TESTING.md`, spec 012 T034 and its entry above now say that a hidden run logs its
  notifications and that an approval resumes the whole conversation.
- The submission packet describes the public history: one labelled baseline commit at the October 26
  cut, then every event commit in order. It no longer cites commit hashes the public repository will
  not have.
- The docs no longer depend on anything the public repository will not have. The hackathon README
  states the decisions (Indie, solo, a labelled baseline plus the event commits, a public
  repository) instead of the planning-stage worktree and mirror plan; the four links to the removed
  feedback disposition are reworded; commit hashes that will not exist publicly are dropped or
  marked as pre-event; and the last "legacy port" titles now say earlier-studio import.
- The film script is approved for recording. The opening motion plates now show only what existed
  before the event (`book.json` and the chapters), so the segment labelled "Built before the event"
  no longer shows the event's image files or a cutout. The retired SAM plate is marked as not in the
  film.
- The opening plate's chat card no longer clips its last line, and both opening plates name the
  sample book's real chapter files. The script describes the plate's copy · paste arrow as drawn.
- A file that is not an old-app backup is now refused with "This file is not a backup from the old
  app.", which no longer names the earlier app. The refusal for a damaged backup now asks you to
  export it again "from the old app" as well.
- D-161 now records that the protected-storage status read on opening Settings waits at most 2
  seconds.
- The submission packet's latest re-check now shows the current numbers: 1,567 tests, smoke 34/34,
  e2e 10/10, and coverage of 90.70% of functions and 93.27% of lines, above the unchanged floor.
- The submission packet's list of event work now includes Word import, the generated open-source
  licenses, and the end-to-end checks of the toolkit and offline writing.
- Decisions accepted on the author's delegation (2026-11-03). D-108 chooses the export renderers: PDF
  through Electron's print-to-PDF and EPUB assembled with `fflate`, with no publisher-acceptance
  claim. D-175 and D-176 accept chapter history, to be built after the submission. D-177 to D-179
  accept the agent-interaction rules, to be built with a re-shoot. New decisions:
  - D-183 enables Word import through `mammoth`;
  - D-184 allows an in-memory credential vault for end-to-end tests only, never in packaged builds;
  - D-185 adopts shadcn/ui and AI Elements components;
  - D-186 generates open-source attribution from the build.
- Film script draft 2 and a truth pass on the submission packet, which follow the event's
  demo-scope rule. All pre-event context is in one opening segment labelled "Built before the
  event". Every later shot names only event work and marks whether it needs a live Meta call. A
  capture order with per-shot fallbacks replaces the SAM shot.
- The packet, the hackathon README and spec 021 no longer claim SAM cutouts (retired, D-158), Muse
  Wonder or open weights. The packet names OpenRouter's voice as a non-Meta service, no longer claims
  a cache-hit rate, follows the film in its demo runbook, and lists the event work since the October
  26 cut. Its evidence table now holds fields to fill from the final clean clone, with today's numbers
  shown separately. That includes coverage below the floor.
- `AGENTS.md` no longer refers to a document that was removed, and four research notes now say
  "locally" instead of process jargon.
- Interface components now come from shadcn/ui, Radix flavour, themed with the Liquid Glass tokens
  (D-185). `packages/ui` has a `components.json` for the shadcn CLI and package-local `#components`,
  `#lib` and `#ai-elements` imports. `src/styles/shadcn.css` adds only what the tokens do not name:
  `--radius`, a `dark:` variant on `data-theme`, shadcn's state variants, and the type scale for
  `text-xs` to `text-lg`. Button and Dialog keep their props and look and gain shadcn's parts.
  Floating surfaces (menus, tooltips, hover cards) are glass. shadcn's animations, shimmer, gradient
  fades and computed tints are removed. The AI Elements patterns live in `packages/ui/src/ai-elements`:
  Chat, Tool, Confirmation, Context, Checkpoint, Prompt Input and Suggestion. New dependency:
  `radix-ui` (MIT). `@radix-ui/react-dialog` is no longer a direct dependency of `packages/ui`.
- The writing agent's chat is rebuilt on those patterns, adapted from the studio's own message parts
  rather than AI SDK types (ADR 0013). Turns are messages in a Message Scroller that follows a
  streaming reply. Tool lines are Trace steps whose raw detail opens in place, and a failed tool
  reads as an error. Approvals use Confirmation. Undo is a Checkpoint after the turn. The context
  share is a Context card that opens on hover, tap or keyboard. The composer is a Prompt Input. The
  empty state offers three suggestions, and choosing one fills the field without sending it. The
  model divider, offline note, rate-limit wait, content-policy notice, retry, failed-turn checkpoints,
  background turns and every test id are unchanged. Reasoning stays hidden. Hints on the chat's icon
  buttons are Tooltips, so they also appear on keyboard focus.
- Other surfaces use shadcn/ui controls where one fits. Each tool's on or off control in the Agent
  dialog, the prompt-cache option and the SKILLS.md option are Switches. Selects in the Agent, Settings,
  Story Bible, Format, Illustration and ambient panels are Native Selects in the studio's field style.
  Native Select was chosen over Radix Select because it keeps the platform picker, form semantics and
  keyboard behaviour. The Story Bible's arc sections are Collapsibles, and the browser-access note in
  Settings is a Badge. The theme picker keeps its pressed buttons: a Toggle Group would add about 16 kB
  of Radix roving-focus code and push the web bundle past the SC-009 limit of 1.2 times the perf
  baseline. A switch keeps its own size on touch layouts (`base.css`), and `biome.json` lists `Switch`
  and `NativeSelect` as form controls. Text fields stay at body size at every width. An off switch's
  track is outlined in the secondary text colour, so its edge meets 3:1 against the dialog as the native
  checkbox did, and increased contrast strengthens the outline.
- The new components follow the type scale: `text-xs`, `text-sm` and `text-base` map to the caption,
  subheadline and body tokens. Chat prose and the composer stay at body size. Secondary chat text (tool
  lines, the approval card, the model divider, the composer's controls and hint) is at the caption or
  subheadline step. Before, the app's `text-[var(--text-*-size)]` classes compiled to `color`
  declarations under Tailwind 4, so that text inherited body size. This migration found the problem and
  fixed it only where the new components replaced those classes; the fix for the rest of the app is
  under Fixed.
- The chat's Message Scroller keeps shadcn/ui's parts, slots and classes, but the scrolling under it is
  the studio's own rather than `@shadcn/react`'s. That package's 19 kB took the web bundle to 1.21
  times the perf baseline, past the SC-009 limit of 1.2. The studio's version follows a reply while
  the author is at the end, keeps their place when they scroll up to reread, returns to the end when
  they send, and offers a button back to the end. The copied Bubble, Badge, Marker and Input Group
  keep only the variants and rules the studio uses. Copied code that nothing imports is deleted:
  Model Selector, Dropdown Menu, Reasoning, Input and Separator, and the unused parts of Bubble,
  Message, Item, Input Group, Native Select, Trace and Confirmation. The web bundle is now 913,538
  bytes, 1.19 times the baseline; it was 934,462 with `@shadcn/react` and 842,826 (1.10) before the
  migration. Without `@shadcn/react` the desktop app ships 130 packages and the web build 49.

### Fixed

- Linux directory-move watcher events now recognize the files the studio just moved to trash as its
  own writes. Browser-storage tests also restore built-in globals by descriptor and clear the saved
  library choice between tests, keeping Bun's shared Linux test process isolated.
- A chapter with no illustration opens the Illustration dialog empty. It used to show another chapter's
  picture with "Use for this chapter"; it now falls back only to a picture no chapter uses yet.
- A dialog whose first field takes focus as it opens (New book, Book settings, Search) returns focus
  to the button that opened it when it closes; the opener is read before the field takes focus.
- The Contributor warning in the model picker no longer repeats its own "Contributor mode" heading.
- Words that could not be saved when the studio closed or quit are no longer lost (002 FR-013, D-189).
  When the last save cannot write a chapter (a full disk, a read-only or Finder-locked book folder, a
  chapter file that is briefly missing, a library folder renamed while open), the studio writes the
  unsaved text atomically, owner-only, to `recovery/` in its own profile, never to the library, with
  the book and chapter ids, the version and hash it was typed against, the reason and the time. Then it
  asks before going: keep the studio open, where it keeps trying, or quit (or close the window) with the
  words kept. If even the profile refuses them, the button says the words will be lost. A hidden run
  logs the counts and the reason instead of asking. The editor now hands its newest text to the main
  process when its own last save fails, so words typed just before quitting are kept too. The next
  time the book opens, the workspace offers each kept copy. *Restore words* goes through the checked
  save, so a chapter that changed since keeps them as a conflict copy, and *Discard words* asks first.
  A quit now decides before it stops the agent toolkit service, it no longer flushes the window a
  second time as it closes it, and a close and a quit at once ask one question. The smoke run makes
  the built app's book folder read-only, flushes as a quit does, and restores the kept words when the
  book reopens.
- A failed save now says why and tries again by itself (002 FR-012). The save status shows the main
  process's reason, for example "Not saved · The disk is full. Nothing was replaced.", and its label
  adds that your words are still in the editor and the studio keeps trying. It retries after 2 s, 5 s
  and 10 s, then every 30 s while the text is unsaved, without waiting for a keystroke, and reads
  "Saved after retrying" when a retry lands. A conflict still reads "Not saved" and is never retried.
  A chapter file that went missing, or a library folder renamed while open, is described in plain
  words in the save status and the quit question, never by the chapter's id.
- Reopening the studio after a background turn opens that book with the writing agent on the turn's
  conversation, instead of on the library (017 FR-012). When a turn finishes, fails or stops for your
  approval while no window is open, the main process remembers its book and conversation. The next
  window it makes, from the notification's click or the dock, opens on them once, over a new
  `app:open-conversation` event whose ids are checked with Zod before they are sent. A window opened
  with nothing waiting still opens on the library. The dock now looks for the studio's own window
  rather than any window, so a hidden PDF export window no longer stops it reopening. The agent
  check (`bun run e2e agent`) now closes the window during a background turn and reopens it from the
  dock on the built app.
- After a turn, "Review changes" no longer lists the agent's own undo checkpoints
  (`books/<id>/.studio/checkpoints/…`) as new files (016 FR-005). The checkpoint store wrote them beside
  the library service and never told this device's sync baseline. Each checkpoint the studio writes or
  removes is now noted as its own, like a chapter, a conversation or an image. The notes also take
  turns: two at once, as when a turn's tool calls finish together, used to drop one another's paths.
  A file another device or editor changes is still listed. Checkpoints written before this fix were
  never noted, so a library that has them lists them once more, until you keep the disk version.
- "Undo this turn" takes back only the turn it was offered on. Undo restores the book's newest
  checkpoint, and the chat can be behind: reopened while a turn runs, answering a stale approval after
  a relaunch, after an undo from the strip, the CLI or the phone, or with a newer change from the
  toolkit or another conversation. Each of these could revert another turn's writes. The chat now names
  its turn (`agent.undoLast(bookId, turnId)`, checked by Zod), and the main process refuses unless that
  turn owns the newest checkpoint. The refusal changes nothing and says so on the turn: "The book
  changed since that turn, so nothing was undone. The newest change is “…” in “…”." The chat then
  rereads the conversation's undo turns, so a turn undone elsewhere hands the offer to the turn before
  it. The control plane's `POST /v1/books/:bookId/undo` takes the same optional `turnId` in an optional
  body and answers a refusal with `409`. The strip, the CLI, MCP and the phone still undo the newest
  change on purpose and name no turn. Undo stays a stack.
- A refused destructive call says what happened on its step (QA Q13). An approved overwrite, line
  deletion, split or merge that found the chapter saved during its pause showed only an error line,
  "Asked to replace a chapter", with the reason behind its closed detail. The step now reads "Left the
  chapter as you wrote it. The replacement is kept as a conflict copy." (or "No lines were deleted.",
  "Nothing was split.", "Nothing was merged."), with *Show the saved copy* for the overwrite's copy,
  live and in a reopened conversation. The results carry `changedSinceRead`, and the workspace counts
  the overwrite's copy as soon as its result arrives instead of when the turn ends.
- Undo's note for a chapter it left alone says "changed during or after the turn". It said "after the
  turn" even for words the author saved while the turn waited for approval; the checkpoint cannot tell
  the two apart.
- One conflicted edit keeps one conflict copy (QA C4). The editor kept the author's draft after a
  conflict, so "Load the version on disk" saved the same words again within milliseconds, and the main
  process saved the leftover draft once more at quit: three identical copies, while the banner counted
  one. A conflicted save now drops its draft, in the editor and in the main process, and the editor
  never saves words a copy already holds against the same base, from a flush, a remount or a quit.
  "Load the version on disk" saves words typed since the conflict first, as a copy of their own, then
  lists the copies, so the banner counts the files on disk; it also recounts them when a conflict
  happens. Like Refresh, it now clears the chapter's typing history, so undo cannot step back across
  the version on disk.
- A sync tool's copy of a chapter is no longer a second chapter that the studio writes into (QA D1).
  When iCloud Drive made `0002-the-door 2.md` or Google Drive made `0002-the-door (1).md` beside
  `0002-the-door.md`, both files carried the chapter's id. The studio listed both, opened the copy,
  autosaved into it and trashed it on delete, while the original stayed byte-identical and came back.
  A Syncthing `.sync-conflict-` copy was listed as a chapter too, though `docs/FORMAT.md` said it was
  not. Now exactly one file is the chapter for an id. A name with a sync tool's copy mark never is;
  among the other files with that id, the studio-shaped `NNNN-slug.md` name wins, then the shorter
  name, then character order (D-187). Only names decide, so every device picks the same file and a
  save never hands the chapter to its copy, even a newer one. Every other file is listed with the
  conflict copies, so the workspace's saved-copies line counts it and Show in folder opens the folder
  at it; the studio never writes, renames, moves or deletes it. Another chapter's unreadable file no
  longer stops a details change, move or delete from finding its chapter.
- A book whose `book.json` is newer, still syncing or unreadable no longer disappears from the library
  without a word (QA D9). It keeps a card that says "This book was saved by a newer version of the
  studio", "This book is still syncing" or "This book's details could not be read", names its folder,
  and offers Show in Finder on desktop (Show in folder elsewhere). Nothing in its folder is changed.
  The library no longer says "No books yet" when the only book cannot open.
- A refused or unreachable connection (`ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH`, `ECONNRESET`)
  now reads as offline, with the offline note, instead of "The provider's content policy declined this
  request". The refusal pattern matched "ECONNREFUSED".
- Dialogs that stay mounted while closed, which is how the workspace keeps them, now return focus to
  the button that opened them; the opener is read each time a dialog opens. A dialog with its own
  trigger, such as the licenses view, keeps Radix's return to that trigger.
- The ambient strip catches up when a chat turn finishes, and "Say where you are" reads the status
  fresh before speaking it, so it never repeats a line from before the last change.
- After generating or attaching an illustration, its size and model stay in the caption beside the
  note (`1024×1024 · muse-image-1.0 · Saved to this book`).
- The header's model button has room for "Muse Spark 1.3 Contributor" and its tooltip names the model;
  the composer names a one-turn model the same way instead of by its raw id.
- The sync review counts "2 new files" and "3 conflict copies" in the plural.
- "Undo this turn" no longer undoes a different turn. Undo always takes the book's newest checkpoint,
  but every turn that changed the book kept the button, so undoing an older turn reverted the newest
  one and named the wrong turn. Now only the turn that owns the newest checkpoint offers it, and after
  its undo the turn before it does. No turn offers it while another turn runs, or at or before a turn
  waiting for approval, as in a chat opened from the approval notification, because either may already
  own the newest checkpoint. An undo takes its turn out of every conversation's
  `checkpointTurns`, so a reopened chat no longer offers an undo already used. A turn stopped while it
  waited for approval, or one that failed before it stored a reply, is now listed there too. A branch
  that leaves out the newest checkpoint turn lists none, so it never offers an older turn's undo
  (QA B2).
- "Branch from here" is hidden while the turn waits for approval, live or reopened, because a branch
  cannot answer it (QA B13).
- Allow or Deny pressed from the keyboard leaves focus on the answered card instead of dropping it to
  the page, since the buttons go away once the question is answered (QA B12).
- An answered approval card stays with the turn's tool steps, before the reply that followed it,
  instead of after it, live and in a reopened chat (QA B11).
- Switching a tool off in the Agent dialog keeps its row, now reading Off, and keyboard focus stays on
  its switch, so the same switch turns it back on. The dialog listed only enabled tools, so the row
  vanished under the pointer and focus fell to the dialog. A tool changed while the dialog is open
  stays listed until it closes, and the switches are no longer disabled while a save is on its way,
  which also dropped focus in Chromium (QA B5).
- A tool that throws, such as `read_chapter` with a chapter id the book does not have, now ends as a
  failed step: the chat shows its red dot instead of a running one that never stopped, the
  conversation stores it as failed so a reopened chat shows the same, and the Agent dialog counts it
  as a failed call instead of saying the agent had not called a tool. Its detail is the library's own
  message, such as "No chapter … in this book."; any other exception reads "The tool failed.", so its
  text, which can name paths on this computer, stays out of the conversation (QA B3).
- A saved connection that has not been tested in this Settings session now reads "Saved · not checked
  yet" instead of "Unavailable", which suggested a working key was broken.
- A rate limit names one wait. When the provider says how long, the chat gives that time without a
  second "Try again shortly".
- The approval notification says what the agent would do ("…waiting for your approval to replace a
  chapter's text") instead of naming the tool's internal id.
- Settings › About no longer says "No library open" while a library is open.
- Allowing Contributor training in the model picker now reaches the book. The book update kept the
  chosen Contributor model but dropped the consent, so every Contributor turn was refused with a
  request to allow it in the picker.
- An approved agent edit no longer writes over words you saved while it waited for your approval.
  Before, `overwrite_chapter`, `delete_lines_in_chapter`, `split_chapter` and `merge_chapters` read the
  chapter again when they ran, after the approval. The checked save then saw no conflict, so your
  edit was replaced or the wrong lines went. If the turn had written that chapter earlier, undo's
  conflict copy held the agent's text, and your words were nowhere.
  - The runtime now notes the version and hash of each chapter such a call names before it shows the
    approval, and the approved call checks against those. If you saved the chapter in between, an
    overwrite keeps your text and saves its replacement as an ordinary conflict copy in `conflicts/`.
    A line deletion, split or merge changes nothing. The tool tells the agent the chapter changed
    since it read it, that nothing was overwritten, and where the copy is, so it reads again.
  - A refused call is not counted as a change, and the turn's undo checkpoint leaves it out. Undo
    afterwards leaves your words in place and names the chapter.
  - `delete_chapter` and `move_chapter` are unchanged: they rewrite no text, and a deleted chapter's
    file keeps your words in the trash. A save that lands while the model is still writing the call,
    before the approval shows, is part of what you approve (ADR 0014 decision 6).
  - `apps/desktop/tests/turn-checkpoint.test.ts` and `agent-runtime.test.ts` cover the overwrite, line
    deletion, split and both sides of a merge, and undo afterwards. Each fails without the fix. A
    test with nothing saved during the pause shows the approval still writes, with no conflict. The
    runtime test that expected the approved overwrite to land on your typing now expects your typing
    to stay. A checkpoint test reached its `conflict-undo` copy through an approved line deletion over
    your line. It now gets there through an ordinary edit after an approval on another chapter, and
    what it proves is unchanged.
- The ambient strip now says where you are in the chapter on screen. It always named the book's last
  chapter and its word count, and "Say where you are" spoke that; it now follows the open chapter, a
  chapter switch and a saved change.
- The header's model button shows the model's own name ("Muse Spark 1.3"), as the conversation
  does, instead of its raw id.
- Closing a dialog puts keyboard focus back on the button that opened it, instead of the page, so the
  next Tab continues where you were. This covers every dialog the workspace opens.
- `docs/FORMAT.md` now says that moving a chapter never renames its file, so the numeric prefixes stop
  following reading order after a reorder, and gives the trash's real base-36 stamp.
- Words typed just before quitting or closing the window are no longer lost. The editor sends its
  draft copy only after a 300 ms pause, and quitting saved only that copy, so a sentence finished
  less than 300 ms before the quit never reached the file. A close or quit now asks the window for
  its newest text first: the open editor saves it through the normal checked path, and the preload
  bridge always answers, so the quit waits at most 1.5 s and the drafts already held stay the
  fallback. Saves from one editor now run one at a time, so a quit while an autosave is still on its
  way saves the newest words instead of a conflict copy.
- After an agent turn or its undo, the open editor shows the chapter as it now is. Before, the
  workspace remounted the editor before it reloaded the book, so it kept the old text, and the
  author's next words were refused and went to `conflicts/` as a `newer-version` copy. The editor
  now keeps any unsaved words, reloads, and then remounts on the new text. The same reload follows a
  turn or an undo from the ambient strip, which never reloaded the editor, and a turn that failed
  after it changed a chapter. A turn that left the open chapter alone, such as a question, no longer
  remounts the editor, so the caret and the undo history stay.
- An outside edit that lands soon after a local save is announced. The workspace used to drop every
  library change within 2 s of a local action, and every autosave restarted that window, so another
  writer's paragraph could go unannounced and the author's next typing became a conflict copy. The
  window is gone: the main process now tells the studio's own writes from another writer's by their
  bytes, so nothing is dropped by time.
- The studio's own saves are no longer announced as changes made outside the studio. The library
  watcher now ignores the studio's atomic temp files, matched by their exact name, and recognises a
  Story Bible, settings, image, conversation, checkpoint, trash or agent write as the studio's own
  because the file still holds the bytes the studio wrote. A genuine outside edit or deletion is still
  announced, and so is a change the studio makes for the toolkit or the phone bridge, which the
  window did not see.

- After an undo, the chat, the ambient strip and `bookwriter undo` now say which chapters did not simply
  go back and why, and where a copy of words written during the turn was kept. The notes were
  returned by undo but never shown.
- Undoing an agent turn no longer throws away your words, a deleted chapter's identity or a chapter's
  details. A turn's checkpoint still has one file and one undo.
  - Text you wrote during a turn is no longer silently discarded. Before, if the agent wrote a
    chapter, you edited it while an approval waited, and the agent wrote it again, undo restored the
    pre-turn text and your words were gone. Each change now records when a tool finds text or
    details the turn did not leave. Undo keeps that chapter's file byte for byte as a conflict copy,
    `conflicts/<name>.conflict-undo.<deviceId>.<timestamp>.md`, before restoring it. If the copy
    cannot be written, the chapter is left alone. The undo result names the chapter and the copy.
  - Undoing `delete_chapter` or a merge now brings back the chapter itself. Before, it came back
    under a new id without its synopsis, purpose or notes, and the original file stayed in the trash.
    The checkpoint now records where the file went, and the new `Library.restoreChapter` moves it
    back atomically. It refuses a path outside the book's trash, a file that holds another chapter,
    and a chapter that is already in the book. If the file has left the trash, or the recorded path
    is refused, undo writes the chapter again as before and says so.
  - `set_chapter_meta` is now checkpointed. The checkpoint holds a chapter's title, synopsis,
    purpose, notes, arc, colour and prologue flag from before the turn, and undo restores them. It
    skips a chapter whose details changed after the turn, and names it, as it already did for text.
  - Checkpoint entries gain four optional fields: `meta`, `afterMetaHash`, `outsideEdit` and
    `trashedAt` (`docs/FORMAT.md`). Older checkpoints restore as before.
  - The undo result gains optional `kept` and `notes`. A skipped chapter is now named in `notes`.
    The chat and the minimal mode still show only the counts.
  - The book's details, cast and memories are still not checkpointed (ADR 0014 and D-113 amended).
  - `apps/desktop/tests/turn-checkpoint.test.ts` and `apps/desktop/tests/library.test.ts` cover each
    case and fail without the fix.
- Type sizes render at their designed sizes across the studio. Tailwind 4 reads an untyped arbitrary
  value by its shape, and a `var()` has none, so the 360 `text-[var(--text-*-size)]` classes compiled
  to `color` declarations the browser ignored: captions, footnotes, headings and titles all inherited
  the 15 px body size. Four `font-[var(--font-code)]` and `font-[var(--font-ui)]` classes compiled to
  a font weight, so the API key and manual model fields were never monospaced. A codemod rewrote them
  to the typed forms `text-(length:--text-…-size)` and `font-(family-name:--font-…)`, which compile to
  `font-size` and `font-family`. Dialog titles are now 22 px, the library title 34 px from 700 px wide
  and book titles on their cards 20 px; secondary text sits at the callout, subheadline or caption
  step. Designed colours arrive with the sizes, because an invalid colour acts as `inherit` and
  outranked a colour written earlier in the stylesheet: error and warning lines that also carry a size
  (Settings' storage warning, the chapter conflict notice, the Search, Licenses, Illustration and
  Agent dialogs, a failed chat message and the browser welcome) are now red, and the chapter and word
  count under the book title is muted. tailwind-merge read the old classes as colours too, so it
  dropped the muted colour from the chat's tool lines and the size from every dialog description; both
  now survive the merge. The newer-format refusal named a token that does not exist,
  `--text-caption-1-size`, and now uses the caption size.
  `apps/desktop/tests/type-size-classes.test.ts` fails on the old forms, naming the fix, and on any
  type token missing from `tokens.generated.css`. No layout needed a fix at 1440×900 or 1024×700,
  light or dark, nor at the phone and tablet widths; the visual baselines are regenerated for the new
  sizes.
- Typing in a chapter and then undoing back to the saved text no longer leaves it marked unsaved. The
  Format dialog refused every export ("The chapter has not finished saving") until you typed again;
  the chapter now reads as saved, with nothing written, because the file already matches.
- Settings now says when this computer's protected storage is unavailable. Electron 45 answers
  that question with a promise, and the status read took the promise itself for a yes, so Settings
  always showed the keychain as unlocked. It now waits for the answer, at most two seconds. If the
  system has not answered by then, Settings says so and points you to Check keychain. An answer
  that fails reads as unavailable, so storage is never shown as available without a yes. Opening
  Settings still makes no keychain round trip (D-161).
  `apps/desktop/tests/credentials-desktop.test.ts` covers available, unavailable, failing and
  silent storage.
- Importing an old backup now works with the file you choose. The import passed the file's text to
  a reader that expected the backup already parsed, so every real backup was refused as not a Mom's
  AI Book Studio backup. The importer now reads the backup from the text first. A damaged or
  cut-off file is refused in plain words, and nothing in the library changes.
  `apps/desktop/tests/ipc-handlers.test.ts` now imports a backup from a file on disk through the
  real dialog handler, and refuses a damaged one.
- The live check of a real Meta key now finishes promptly when a writing turn cannot start, and
  records the turn as failed with the reason. Before, the turn's four-minute timer stayed armed and
  kept the check running, and a later error from the turn became an unhandled rejection.
  `apps/desktop/tests/live-checks.test.ts` covers a start that fails and an error reported while
  the turn is still starting.
- The header's Word and Markdown export buttons no longer export when the open chapter's latest text
  failed to save. An export reads the saved files, so it would have left the newest words out
  without saying so. Now a save that failed or hit a conflict stops the export with a plain notice
  ("…so nothing was exported"). A component test covers this and fails without the fix.
- The coverage gate now measures the repository's own code. `bun test --coverage` also lists the
  TypeScript plugin fixtures that tests write into temporary folders, most at 0% of functions and a
  different set on every run, and bun's summary averages them in. So `bun run coverage` failed at
  84.83% of functions and 90.69% of lines, and the number moved from run to run.
  `scripts/coverage-check.mjs` now:
  - reads bun's per-file rows and keeps only the files inside the repository root;
  - prints how many files it left out, and which;
  - checks that bun's summary is still the unweighted mean of its rows;
  - fails loudly on a table it cannot read in full.

  The averaging method and the floor (85% of functions, 92% of lines) are unchanged.
  `apps/desktop/tests/coverage-check.test.ts` covers the parser with synthetic tables. New tests of
  existing behaviour then raised line coverage. They cover:
  - the IPC handlers through `registerIpc`: refusals, envelopes, results on disk and dialogs;
  - the live check against stubbed providers;
  - the desktop credential vault, the draft buffer and the settings store;
  - the ambient "last said" line and damaged Word files;
  - the search, book settings, new book and blocked-review dialogs.

  The shared Electron mock gained per-file answers for safeStorage and the native dialogs. Over
  the repository's own 180 files, coverage rose from 87.58% to 90.70% of functions and from 90.65%
  to 93.26% of lines; bun's own summary now reads 87.85% and 93.21%. Writing the tests exposed two
  product defects, which are reported rather than fixed in this test-only change:
  - the desktop vault's status read always says protected storage is available;
  - importing an old backup from the desktop dialog always refuses it as not a backup.
- One undo now restores every chapter an agent turn changed, including changes made after an
  approval. The turn saved its checkpoint once, at its first approval pause, and never again. When a
  turn appended to one chapter and then overwrote a second after the author approved, it reported two
  chapters changed and offered undo, but undo restored only the first; the second kept the overwrite.
  Each change is now added to the checkpoint as soon as it is saved, before the tool answers the
  model. A turn still has one checkpoint file and one undo.
  - The changed count now matches what undo restores or skips. A save that conflicted no longer
    counts as a change.
  - Undo no longer writes over a chapter the author edited after the turn. It skips that chapter and
    restores the rest. The chat and the minimal mode both say how many were skipped; the minimal mode
    used to say there was nothing to restore.
  - Creating, deleting and moving a chapter are now undoable. A deleted chapter returns with its
    title and text at its old place, under a new id; its file stays in the trash. Merge undo also
    finds the right place when chapter numbers have gaps.
  - Undo goes back through a turn's changes from last to first. Each checkpoint entry gains an
    optional `afterHash`. Older checkpoints still load and restore as before (`docs/FORMAT.md`
    documents the file, ADR 0014 decision 4 is amended).
- The browser build's `window.studio` is now tested end to end over site storage
  (`apps/web/tests/storage/browser-api.test.ts`). The test covers:
  - creating, renaming, searching and reopening a book;
  - checked saves, with a stale save kept as a conflict;
  - chapter rename, reorder, move and delete;
  - held drafts and drift checks;
  - the minimal mode's status;
  - that every desktop-only surface refuses in plain words.

  Coverage of that file rose from 5% to 96% of functions. Writing it exposed a leak between test
  files: `browser-libraries.test.ts` stubbed `window` with only a folder picker and never removed it,
  so later files saw a fake page. It now restores `window` after each test.
- After the author approves or denies a destructive tool, the agent hears the whole conversation
  again. The resume sent only the paused step's reply and the approval, so the model lost the
  author's prompt and the earlier turns, and a multi-step request lost the rest of its instructions
  after an approval. A fake OpenAI-compatible provider recorded the resumed request as
  `system, assistant, tool`. It now repeats the paused request message for message (the system
  prompt, the history and the author's prompt), then the tool call and its result or denial. A second
  approval in the same turn no longer sends a tool result without its call, and each approved call
  still runs once. Approvals stay per turn, a denial still writes nothing, and usage and cost still sum
  every leg. ADR 0014 decision 3 now says the same.
- A hidden test run no longer posts real desktop notifications. Its window is never visible, so every
  finished turn counted as "away" and notified on the author's own desktop. A hidden run
  (`STUDIO_TEST=1` without `STUDIO_VISIBLE=1`, or `STUDIO_HEADLESS=1`) now writes the title and body
  to its log as `[notification] would post {…}` instead. A visible test run, the way the film is
  recorded, and the app itself notify exactly as before. The window and the notifier read one rule,
  `launchMode` in `apps/desktop/src/main/launch-mode.ts`.
- The glasses page now opens the chapter its status line names. Before, it always opened the first
  chapter while the agent's sentence below said "You're in Chapter Two", so the display and the
  sentence disagreed about where the author was. Its chapter heading also reads "1 word" for a
  one-word chapter. The glasses check now asserts that the passage on the display is the chapter the
  status line names.
- A second copy of the studio on the same profile is now refused before it can write, and the open
  copy tells the author (spec 002 FR-069). Before, only visible runs took the single-instance lock, so
  two hidden copies on one profile both opened the library and both wrote. A visible second copy
  closed silently: the open studio focused its window without a word, and did nothing if the author
  had closed the window. Now the refused copy quits before it reads settings, opens the library or
  starts the control plane. The open copy brings its window forward, creating it again if it was
  closed, and shows "AI Book Studio is already open. The second copy closed without opening your
  library." Hidden test runs take the lock on their own throwaway `STUDIO_USER_DATA` profile, where
  it cannot refuse the author's studio. The new `bun run e2e instance` check
  (`scripts/second-instance-check.mjs`) proves it on the built app: the second copy exits in about
  0.3 s and changes nothing in the library, the profile or the control plane's locator; the notice
  appears and can be dismissed; the open copy keeps saving and recreates a closed window with the
  notice; and a copy on another profile still opens.
- The film script's 0:43 line now says a switched-off tool is refused everywhere, rather than that it
  disappears everywhere. The new toolkit end-to-end check shows the CLI and MCP refuse the tool, but
  `bookwriter tools` and MCP `tools/list` still list it, because neither lists tools for one book.
- A fresh clone builds again. The `release/` ignore rule also matched `scripts/release/`, so the
  release record and checklist scripts were never committed while the tests that import them were,
  and a clean clone failed typecheck. Now the ignore rule and `submission:check`'s forbidden-path
  rule match only the root `release/` folder the packager writes. The scripts are committed, and a
  test pins both rules.
- The manuscript status line now uses singular counts: a one-line chapter reads "1 line", and a
  one-word chapter reads "1 word". The illustration dialog's description now reads "Make or choose an
  image" instead of describing a saved image that may not exist yet. Its no-connection notice no
  longer says you already added a Meta connection; it says Muse Image uses the writing agent's Meta
  connection and to add one in Settings.
- The chat composer no longer squeezes its controls in the desktop chat panel. The send hint now has
  its own line, so "Model: book default" and "Background" read in full. Before, the model read
  "Mod…" and the hint wrapped onto three lines. The manuscript status line now keeps each item whole
  and wraps whole items when the sheet is narrow. Before, the items broke inside, for example
  "Chapter / 1". The twelve chat baselines were updated after locating each diff in the composer and
  the status line.
- The full test run is green again (four failures and two errors, each file passing alone).
  Three leaks between files caused them: the agent runtime tests left five-second deadlines
  running after each test, the workspace's "Saved" note timer fired after the workspace
  unmounted, and two different Electron mocks raced to define the module. The deadlines are
  now cleared after every test; the note's timer is cleared on unmount, a real fix that also
  stops a state update into a closed view; and every file registers the one complete
  Electron mock in `tests/support`. The DOM teardown also lets React finish work it
  scheduled outside `act()` before the window closes, which had intermittently failed a
  later file and once hung the run. Nothing was quarantined.
- The accessibility and visual gates run to the end again. After their conflict step, opening
  the library now shows the drift report (016 acceptance scenario 2), and both scripts close it
  before opening the book. Before recapturing 76 of the 112 visual baselines, each diff was
  located: the library's location line moves the grid, and the workspace header gains the
  Format book and Export Markdown buttons. Nothing else differs.
- Corrected the 010 roadmap row: shared UI extraction landed in 013 (`packages/ui`,
  `packages/app`); only the native folder-picker matrix remains there.
- Hardened the web smoke UI typing journey: it now proves the keystrokes landed in the
  editor and the save committed a newer chapter version, instead of trusting a bare
  "Saved" status that also shows when nothing changed. No product code changed.
- Fixed the desktop smoke slow-run cancel check on slow machines: the stopped-state
  wait is now 60s (was 10s) with the outer hang guard at 180s, and a timeout now
  names the state the report is stuck in. The cancel contract itself was proven
  instant in-process; only the gate window was too tight for the 3M-word stress
  fixture. Verified 29/29 twice. No product code changed.
- Fixed manuscript review cancellation on long books (spec 034 T010/T016): the
  word-count analysis ran synchronously on the run thread, so on a fast machine a
  cancel click always landed after the run finished and on a large book the
  interface froze with a Cancel button that could not act. The analysis now
  counts in whitespace-aligned slices and yields between 256KB budgets, so
  Cancel stays clickable, an abort discards partial counts, and small books
  analyze with no added latency. This supersedes the earlier slow-machine
  diagnosis: the gate window was never the fault. The smoke review checks now
  wait for report content rather than the dialog shell, and the stale re-run
  waits for a new report generation instead of the shell losing its banner.
  Verified 29/29 in the desktop smoke with the cancel check green.
- Corrected the 018 roadmap row: the manual desktop/MCP pass (T011) ran against a
  real backend and MCP client with reads verified on disk; it is not pending.
- Fixed the WebMCP `untrustedContentHint` polarity: every studio tool output is
  author-supplied prose (which may embed imported or quoted third-party text), so
  the annotation is now `true` on every tier — in `surfaces.ts`, the
  `bookwriter tools --format webmcp` output, and the glasses page registration.
  The value was `false` while the code comments and the WebMCP semantics both
  describe output the caller must treat as data. No behavior or gate changes.
- Unified the studio word counter (spec 002 FR-016): one dependency-free
  `countWords` in `packages/core/src/words.ts`, re-exported by
  `packages/core/src/markdown.ts` and `packages/app/src/lib/utils.ts`, so the
  editor's live count can never disagree with chapter metadata, the manuscript
  review or import mapping again. Covered by a single-implementation pin plus
  behavior cases and an editor header-count agreement test. No behavior change.
- Proved failed DOCX exports keep the previous file and leave no partial output
  (spec 002 FR-055): real-writer failures into an unwritable folder throw with
  an empty directory for fresh exports and a byte-identical prior file plus no
  staging droppings for replacements. No product change; the boundary already
  threw through the atomic writer.
- Proved DOCX export honors manuscript settings (spec 002 FR-052): the same
  chapters built under default and custom settings produce documents that carry
  only their own font, body size, line spacing and first-line indent runs with
  identical prose. No product change; the existing typography test already
  covered one custom profile and chapter-title alignment.
- Covered the Story Bible dialog (spec 002 FR-019): staged character and memory
  edits save together, Cancel discards a staged removal without writing, blank
  title disables save, and a failed save keeps the dialog open and reports. No
  product change; the tool-level add/update/remove paths were already covered.
- Pinned verse preservation (spec 002 FR-015): a stanza round-trips byte-identical
  through chapter save and read, the counter counts across its breaks, and the
  exported DOCX keeps the stanza lines in order. No product change; the
  canonicaliser already preserved interior breaks.
- Pinned tool limit honesty (spec 002 FR-022): every stated limit resolves to
  an enforced input maximum or a proven execute cap, the two 200-match result
  caps truncate behaviorally with full counts reported, and the system prompt
  policy sections state no numeric limits. No product change; descriptions
  interpolate the enforced constants and the schema carries every exact bound.
- The context card's bar now tells assistive technology how much of the window a turn used. The
  copied shadcn/ui Progress drew the bar but never passed its value to Radix, so a screen reader heard
  an indeterminate bar. A second tap on the card's trigger now closes the card, as the first opens it;
  before, the tap counted as a press outside the card, which closed it, and the click then reopened
  it.

### Added

- Spec 026 T015/T016: connector application material. `specs/026-glasses/connector-application.md`
  records the fixed manifest head, the 22-tool classification with the 7 sensitive names,
  per-tier side effects, the refusal contract, the unwired account-linking story and a
  credentials-free test story; `docs/TOOLKIT.md` records the tier-to-shape mapping and
  points at the note. No application sent: no public endpoint exists. All quoted
  strings verified against the real surface functions with synthetic fixtures only.
- Spec 036 T007: pure task-preview candidate evaluation. `packages/core/src/routing/`
  adds versioned task-profile schemas and `evaluateCandidates`, a deterministic pure
  function over per-provider catalogues, connections and build that reports eligible,
  excluded, unknown or unavailable status with plain-language reasons. No settled task
  taxonomy is shipped; no network, key, manuscript or runtime import exists. Covered by
  `packages/core/tests/routing/evaluate.test.ts` with synthetic fixtures only.
- Spec 036 T008: honest cost/context presentation rules. `unitPriceViews` shows
  catalogue input, output and cached-input unit prices with provenance; missing or
  unusable prices stay unknown, never zero, while a published zero stays known.
  `contextView` shows the catalogue limit with request fit always unknown. No total,
  ceiling or rejection exists. Covered by
  `packages/core/tests/routing/presentation.test.ts` with synthetic fixtures only.
- Spec 036 T009: shared task-preview surface. `TaskPreviewDialog` renders the
  evaluation over caller-supplied profiles and local catalogues: unranked candidates
  in catalogue order with statuses, reasons, price/context facts and per-catalogue
  freshness lines. Only a transient selected-profile id is kept; a "Choose in the
  model picker" callback replaces selection with no preselect. Covered by
  `apps/desktop/tests/task-preview.test.tsx` with synthetic fixtures only.
- Spec 036 T010: preview neutrality proofs. `task-preview-neutrality.test.tsx` drives
  the dialog through open, profile changes, Close-button close and Escape cancel
  against a fixture host, proving book default, one-turn override, connection,
  history, usage and manuscript stay unchanged and the picker callback carries no
  model. No `window.studio` mock is installed, so bridge access would throw.
- Spec 036 T011: dedicated preview states. The dialog shows no-catalogue, malformed,
  unreadable-profile, no-candidate and stale-catalogue states, each stating what is
  unknown with Close and the model picker as the only next actions; no refresh,
  retry, replacement choice or manual-flow block exists. Covered by
  `apps/desktop/tests/task-preview-states.test.tsx` with synthetic fixtures only.
- Spec 036 T012: preview call/credential spies. `task-preview-calls.test.tsx`
  exercises the dialog behind a throwing bridge proxy and fetch stub, proving open,
  profile changes, the picker path and close make zero provider calls, read no
  credentials and fetch nothing; a positive control opens the real model picker and
  observes its provider and connection listing.
- Spec 036 T013: preview consent regression. `task-preview-consent.test.tsx` proves
  previewing a Contributor candidate shows the existing 022 warning, offers no
  consent control, leaves the training-consent flag alone and touches no bridge
  surface.
- Spec 036 T014: preview access pass. `task-preview-access.test.tsx` verifies the
  dialog role and name, named native buttons, pressed-state exposure, focusability,
  list markup for reasons, no inline motion styles, and identical token-only
  structure under light and dark themes.
- Spec 036 T020: synthetic-fixture rule verified. All 51 existing preview,
  neutrality, states, calls, consent and access tests audited: no live providers,
  real manuscripts, credentials, paid services, devices, Node or network access;
  bridge objects are self-installed throwing proxies or one canned stub. The rule
  stays standing for the gated T015–T019 tests.
- Spec 031 T010: per-book tone and answer-length settings UI. The existing agent settings
  channel accepts and returns `tone` (500 characters maximum) and `answerLength`
  (Brief/Standard/Detailed, Standard by default); the agent dialog shows both with
  Save/Clear actions and a disclosure that the values travel with submitted turns.
  Values stay in ordinary book data and `SKILLS.md` is unchanged. Covered by
  `agent-interaction-contract.test.ts` and `agent-tone.test.tsx` with synthetic
  fixtures only. Runtime inclusion in submitted turns stays with later tasks.
- Spec 031 T004: interaction contract fields. Turn input requires `mode` with optional
  bounded one-turn `guidance`; stored turns record `mode` and carry a `guidance` part;
  per-book agent settings gain `tone` and `answer-length` with defaults for older books.
  All existing callers send `edit`, preserving behavior; covered by
  `agent-interaction-contract.test.ts` with synthetic fixtures only. No permission or UI
  changes; enforcement and the composer default stay with later tasks.
- Spec 031 T003 (research only): in-flight guidance semantics. `research/inflight-guidance.md`
  pins prompt fixity and the stop-plus-new-turn journey and D-179 proposes no live
  steering, with guidance staying pre-send, in proposed-plan review, and in `SKILLS.md`.
  In-flight guidance remains blocked. No behavior changes.
- Spec 031 T002 (research only): pause acknowledgment and continuation semantics.
  `research/pause-continuation.md` pins terminal-stop facts and mid-write atomicity and
  D-178 proposes event-boundary pause, new-turn continuation, per-turn approvals, and
  close-stops/restart-expires. Pause/resume controls remain blocked. No behavior changes.
- Spec 031 T001 (research only): Discuss default and read-tool policy. `research/discuss-read-policy.md`
  pins the exact read-tier six, the withdrawal subset seam, bridge denial and the plugin
  write-capable surface; D-177 proposes read-only built-ins only with Discuss as the new-turn
  default. The Discuss tool set and composer default remain blocked. No behavior changes.
- Spec 032 T001/T002 (research only): chapter-history storage and retention. `research/storage-layouts.md`
  compares six layouts against the book/trash/archive facts and D-175 proposes book-scoped
  `history/` records mirroring chapter files; `research/retention.md` pins unbounded trash/conflicts
  and failure preservation and D-176 proposes no automatic pruning with trash-based deletion.
  Dependent persistence work remains blocked. No behavior changes.
- Spec 009 T029: schema refusal and manual recovery journey. Opening a book written by a
  newer build now refuses before any write and shows a recovery dialog instead of a toast:
  detected vs supported schema, the compatible-build next step and the FR-047 no-migration
  guarantee. The local support summary reuses the About build metadata with the compatibility
  outcome; it holds no manuscript text, no credentials and no absolute paths, and is copied
  only on request. Covered by `schema-refusal.test.tsx` with synthetic fixtures only.
- Spec 009 T025 (research only): profile cleanup on uninstall. `research/profile-cleanup.md`
  inventories the two-file profile and proves pointer-not-prose storage, missing-file defaults
  and the shared root; D-174 proposes a uniform in-app optional cleanup with itemized
  confirmation, never default-on, library never in scope. Nothing is deleted; dependent work
  remains blocked. No behavior changes.
- Spec 009 T024 (research only): lifecycle support matrix. `research/lifecycle-matrix.md`
  declares the three builder targets with standing, survey-only native methods and per-OS
  profile paths, deferring exact OS floors to upstream confirmation; D-173 proposes the matrix
  with macOS release-blocking, profile-stays-on-uninstall and Settings discovery. Dependent
  work remains blocked. No behavior changes.
- Spec 009 T023 (research only): D-115 scope over user-driven local install and upgrade.
  `research/local-install-upgrade.md` pins the version-free shared settings file, write
  confinement to the profile root, no app version in profile or library files, side-effect-free
  opens and pre-write schema refusal; D-172 proposes D-115 does not gate manual local
  install/compatible upgrade under override disclosure, unsigned labeling, same-schema-only
  and no feed/automation conditions. Nothing installs; dependent work remains blocked. No
  behavior changes except a pure settings-path helper with identical behavior.
- Spec 009 T026: build-metadata identity in About. The metadata now carries observed
  platform and architecture (desktop reports OS/CPU, web reports `web`/`unknown`); About
  shows an Architecture row, `Unknown` when undetectable, alongside version, commit, schema,
  target, platform and signing. Covered by metadata and About dialog tests.
- Spec 009 T004: release checklist. `scripts/release/check.mjs` re-hashes the served
  artifact and compares hash, bytes, version, commit and signing status against the record
  and the About values, naming only the mismatched field. Covered by checklist tests with
  tamper, drift and secret non-disclosure.
- Spec 009 T003: release-artifact scan. `scripts/artifact-scan.ts` refuses credentials,
  environment files, source maps and manuscript-like content in served artifacts, naming file
  and class only; tarballs are extracted and scanned, opaque containers name-checked. Wired as
  the `release-artifact-scan` gate that blocks publication. Covered by new scan tests including
  secret non-disclosure.
- Spec 009 T002: unsigned-path audit. About (Settings) now carries a Signing row from the
  build metadata, unsigned on every target until D-115; the release record already states the
  unsigned status, and no public download page exists yet (testers receive the artifact plus the
  record directly). Covered by the new About dialog tests and build metadata tests.
- Spec 009 T001: machine-readable release record. `scripts/release/record.mjs` hashes exactly
  the served files in a flat artifact directory (streaming SHA-256; names, sizes and hashes
  only, never contents) and writes the plan's JSON shape with version, commit, library schema,
  platform, architecture, gates and signing status; it refuses empty, missing or nested
  directories, `--expect` file-set mismatches and bare `signed` claims without an identity.
  Covered by `apps/desktop/tests/release-record.test.ts`, including secret non-disclosure.
- Spec 034 T003 (research only): report save, export, retention and deletion compared with
  synthetic evidence. `research/report-retention.md` pins the report shape (source references and
  excerpts, never bodies; unbounded excerpts; computed freshness) against the volatile baseline;
  D-171 proposes narrow clipboard/Markdown export with capped excerpts and markings, JSON save
  under `books/<bookId>/reviews/` with a 20-per-book cap, explicit and book-fate deletion, and
  archive/sync exclusion. No persistence work; dependent work remains blocked. No behavior changes.
- Spec 035 T008 (research only): format-profile persistence and physical-layout controls
  compared with synthetic evidence. `research/format-profiles.md` pins the settings-nesting strip
  hazard (unknown nested sections are dropped by supported saves), top-level survival across the
  FormatDialog full-settings merge, transient target state and library-default A4/1-inch page
  geometry; D-170 proposes transient per-export now, a reserved top-level `formatProfiles` shape
  later, and no physical controls until D-108 acceptance. Nothing persists; dependent work remains
  blocked. No behavior changes.
- Spec 035 T007 (research only): ordered-matter schema and legacy conversion compared with
  synthetic evidence. `research/matter-schema.md` pins whole-record replace, ordered string
  survival, the strict-open brick on rich values and failed-patch byte preservation; D-169 proposes
  the key-function kind table, additive `matterOrder` with a deterministic fallback, order-only
  confirmed conversion, clear-to-rollback and tolerant carry for unreadable records. No migration,
  no reinterpretation; dependent work remains blocked. No behavior changes.
- Spec 035 T006 (research only): export renderer and determinism alternatives compared with
  synthetic evidence. `research/export-renderers.md` verifies the `docx` pipeline's deterministic
  content parts and fixed zip entry dates (only `docProps/core.xml` wall-clock timestamps vary)
  and surveys LibreOffice headless, `pdf-lib`, Typst and EPUB assemblers from documentation only;
  D-108 proposes the determinism requirements and per-target illustration/packaging contract with
  KDP acceptance, pagination/trim, font embedding and validator tooling explicitly unresolved. No
  renderer selected, no conformance claimed; dependent work remains blocked. No behavior changes.
- Spec 035 T004–T005: DOCX journey characterized and its safe-publication boundary built. T004
  pins the current journey with synthetic evidence: canonical typography reaches the document
  (OOXML anchors), attached images resolve through the image store with skip rules, source files
  stay byte-identical, and dirty editor input saves before `books.exportDocx` runs. T005 adds
  `exportManuscriptDocx` with picker-cancel, in-library alias refusal, explicit replacement
  consent, destination recheck, atomic staged writes and prior-file preservation on failure; the
  IPC contract and headless hook are unchanged. `ManuscriptEditor` unmount now also clears its
  pending draft timer.
- Spec 035 T001–T003: Format journey designed, built and contract-tested. A Format dialog
  (`Format book` toolbar/overflow entry) binds `settings.manuscript` as the canonical source with
  immediate full-settings-merge saves, offers DOCX with PDF/EPUB/Markdown visibly planned, and shows
  a local approximate preview with a persistent disclosure making no page or publisher claims.
  `apps/desktop/tests/format-dialog.test.tsx` pins binding, merge, disclosure, targets, schema
  parity, failure revert and no chapter writes; hidden smoke covers the preview in the real UI.
- Spec 033 T003 (research only): source-anchor representation and verification compared with
  synthetic evidence. `research/source-anchors.md` and premise tests propose exact ordered
  verification (version+hash equality, excerpt-at-range equality, no fuzzy fallback) (D-168,
  awaiting author acceptance); T008 remains blocked. No behavior changes.
- Spec 033 T002 (research only): collection identity and membership compared with synthetic
  evidence. `research/collection-identity.md` and premise tests propose many-to-many id-ref
  membership, unique names, stable identities and id-lookup trash handling (D-167, awaiting
  author acceptance); T005 remains blocked. No behavior changes.
- Spec 033 T001 (research only): organization data storage matrix compared with synthetic evidence.
  `research/storage-matrix.md` and premise tests propose library-root collections, disposable
  recent-work pointers and per-book goal/annotation sidecars (D-166, awaiting author acceptance);
  D-167/D-168 stay Open and T004–T008 remain blocked. No behavior changes.
- Spec 030 T001 (research only): Story Bible extension storage alternatives compared with synthetic
  evidence. `research/storage-alternatives.md` and premise tests propose a separate versioned
  `planning.json` (D-163, awaiting author acceptance); D-164/D-165 stay Open and T002–T008 remain
  blocked. No behavior changes.
- Spec 028 T007: placeholder-save block. Saving over a chapter whose file is listed but unreadable
  preserves the author's text as a `conflict-placeholder` copy with a new `placeholder` reason and
  shows the existing conflict choices with placeholder-specific copy, instead of overwriting or
  failing raw. Meta-only edits are unchanged (no body text to preserve).
- Spec 028 T005: location health in the library list. A `library:locationHealth` channel
  serves the derived state from a fresh read-only scan, and `LibraryView` shows a
  `location-health` line under the library root until the 016 settings section lands.
- Spec 029 T016: browser/mobile import capability specified and kept refused.
  `research/browser-mobile-import.md` records the per-target verdict (web folders and
  browser storage fail the publication contract — every web port publishes with
  copy+delete, never an atomic rename; iOS/Android inherit the web refusal through the
  Capacitor shell), proven by `apps/web/tests/storage/manuscript-import-refusal.test.ts`
  pinning the honest desktop-app refusal on both channels. Enabling any target needs its
  own source-read, failure-clean publish and hidden-journey conformance.
- Spec 029 T015: other-format intake evaluation. `research/other-formats-intake.md`
  records the per-format verdicts: RTF rejected (`rtf-parser` throws on images and legal
  escaped spaces, inlines headers/footnotes, flattens tables), ODT validated but not
  enabled (`fflate` plus `fast-xml-parser` with mandatory `preserveOrder`/`trimValues:false`;
  enabling needs the format decision, transform, wiring and T013 conformance), legacy
  `.doc` refused with no validated reader. Proven by
  `apps/desktop/tests/other-formats-intake-validation.test.ts` with synthesised fixtures;
  the product path still refuses `.doc`, `.rtf` and `.odt`.
- Spec 029 T014: DOCX intake validation. `research/docx-intake.md` records the evaluated
  contract (mammoth plus zip sniffing; chapter split on non-title top-level headings; body
  fidelity; image refusal instead of base64; table text in order; silent drops reported),
  proven by `apps/desktop/tests/docx-intake-validation.test.ts` with synthesised documents.
  The feature is not enabled: `.docx` is still refused.
- Spec 012 T030: unified summary. The single pass/fail/skip/quarantined summary format now
  carries a tag, and `bun run release` prints the `[release]` summary — per-stage results,
  test counts, quarantined count, verdict — as the last line on both the go and blocked
  paths. Ad-hoc `bun test` keeps its native output.
- Spec 012 T029: fast-command budgets. `bun run verify` prints a budget line every run and
  fails when the whole command exceeds 5 minutes or the suite gate exceeds 20 minutes on the
  reference machine; `docs/TESTING.md` names the budgets and marks the slow checks that stay
  out of the fast command.
- Spec 012 T023: release job. `.gitea/workflows/release.yml` and `bun run release` run the
  full suite, desktop/web/packaged smoke, artifact checksums and a waiver-aware verdict, then
  write a `releases/` record with gates, waivers, checksums and capability differences.
  Signing stays out per D-115; the manual checklist stays T025.
- Spec 012 T022: required gates and waivers. The Gitea workflow now gates on lint,
  quarantine, waiver, coverage and security plus both bundles, with browser (web journey,
  accessibility, visual) and desktop-smoke jobs. `docs/WAIVERS.md` is the waiver ledger and
  `bun run waiver:check` fails on expired or malformed rows; it runs inside `bun run verify`.
- Spec 012 T004: fast result summary. `bun run verify` is now `node scripts/verify.mjs`,
  which runs every fast gate fail-fast with output streamed, then prints one summary (per-gate
  results with durations, test pass/fail/skip, quarantined count, overall verdict) and exits
  with the failed gate's code. The summary carries counts only, never captured output.
- Spec 012 T002: lint gate. Biome is the configured linter (D-162); `bun run lint` fails on
  errors and runs first in `bun run verify` and in the Gitea workflow. Landing it fixed 40
  errors across the app, tests and scripts, including a hook-after-early-return, a
  hook-misnamed plain method, intentional trigger deps documented in place, and explicit guards
  replacing non-null assertions; the remaining warnings stay visible advisory debt.
- Spec 012 T001: requirement map. `tests/requirement-map.md` records the layer inventory
  (owners, commands) and maps all 272 functional requirements in specs 002, 010–014 and 016 to
  covering tests, manual checks or explicit gaps (148 covered, 14 manual, 110 gaps, with the gaps
  clustering on the unbuilt plan flow, device lock, CI registration, lint and timing budgets).
- Spec 012 T027: failure artifacts. `scripts/failure-artifacts.mjs` starts the Playwright trace
  when the page is created, collects redacted console/page errors, and saves a screenshot, a
  redacted console log and the trace only when a run fails; green runs discard everything. Wired
  into the a11y, visual, browser-matrix and perf checks, the web smoke and the desktop smoke
  (screenshot plus redacted renderer log on failure). A real-browser negative control confirmed
  all three artifacts save with secrets redacted.
- Spec 012 T028: quarantine ledger. `docs/QUARANTINE.md` records quarantined tests with owner,
  reason and removal date (empty today); `bun run quarantine:check` fails on expired or malformed
  rows and runs inside `bun run verify`. Skips reference the ledger ID; no test is fixed with a retry.
- Spec 012 T017: visual baselines. `bun run visual` captures the seven product views at four
  widths in light, dark, reduced-motion and reduced-transparency variants (112 committed PNGs),
  failing past a hair of pixels with no retries; volatile timestamps and the random library
  identity are masked. Re-accept with the explicit `--update-baseline`.
- Spec 012 T016: accessibility gate. `bun run a11y` scans welcome, library, workspace, chat,
  settings, Story Bible and conflict views at four widths in headless Chromium, failing on
  critical/serious axe findings and asserting editor/composer tab order with no trap. Fixed en
  route: unnamed icon-only New book button at phone width, mismatched archive button labels, and
  the welcome landmark.
- Spec 012 T018: performance gate. `bun run perf` times cold open, chapter reads and saves
  on a synthetic 120-chapter / 250,000-word library, measures the web bundle and welcome render,
  and fails only the SC-009 regressions (book open doubles, bundle grows past 20%) against the
  committed baseline, rewritten only by `--update-baseline`.
- Spec 012 T014: packaged Settings-open stall fixed. Opening Settings no longer runs the
  synchronous keychain round-trip (it wedged the packaged app when macOS wanted confirmation);
  `status()` is a fast availability read per D-161 and the probe moved to an explicit
  `connections:check` channel behind the Check control. Packaged smoke passes 27/27; the smoke
  runner fails loudly with window state instead of hanging and accepts `SMOKE_APP` overrides.
- Spec 012 T013: browser end-to-end interface journey. The web smoke now opens the book
  through the library card, types with real keystrokes to a Saved status, proves a page reload
  keeps the prose, forces a two-writer conflict through the UI save path with the copy named on
  reopen, and exports through the UI button (18/18). Denied/cancelled folder handling stays
  covered by the storage harness and permission unit tests; native picker clicks stay manual.
- Spec 012 T015: per-route content security policy and production fuse hardening. The web
  page may contact only OpenRouter, the loopback check harnesses nothing external
  (`apps/web/tests/csp.test.ts` guards every served route against the provider registry), and the
  packaged app ships with RunAsNode, node-options and CLI inspect off and asar-only loading on via
  the `scripts/flip-fuses.mjs` afterPack hook (`apps/desktop/tests/fuses.test.ts`; fuse states
  confirmed by packaged readback, hidden smoke 27/27).
- Spec 012 T019: maintained repository/artifact secret scan, source-map check and
  manuscript-like text scan. `scripts/submission-check.ts` now exports `scanTrackedSecrets`,
  `scanArtifactDir`/`scanArtifacts`, `enablesSourceMaps`/`sourceMapConfigProblems` and
  `proseProblems`; every finding names the file and reason, never the matched value, and the
  `submission:check` summary reports the artifact count. Covered by
  `apps/desktop/tests/secret-scan.test.ts` with runtime-built fixtures plus clean-tree
  assertions (full suite 1010 pass, typecheck clean).

- Spec 029 T006, T008: manuscript import parsing and the main-process boundary. Shared core gains
  `refuseUnsupportedExtension` wording plus determinism and span-reconstruction invariants (every
  chapter body equals its source span minus the reported edge blanks, and split order never changes
  the preview). New `apps/desktop/src/main/import.ts` picks through an injected dialog (macOS-gated,
  cancel stays a cancel) and reads through `stat`-first size refusal, an extension pre-check and
  strict shared-core validation; every refusal names only the file, never a host path. Covered by
  `apps/desktop/tests/manuscript-import.test.ts` alongside the parser invariants
  (full suite 919 pass, typecheck clean).
- Spec 029 T007: a presentational import preview dialog shows the full chapter text with line
  ranges, editable book and chapter titles, add/move/remove split controls that re-derive chapters
  from the same source bytes, honest refusal copy for unsupported input, and normalization notes.
  It reports the confirmed mapping through `onConfirm` only and never touches the library before
  the author confirms. Covered by `apps/desktop/tests/manuscript-import-preview.test.tsx`
  (full suite 928 pass, typecheck clean).
- Spec 029 T009: `LibraryService.importManuscript` stages a complete book under a unique
  unpublished `.studio/staging/` path, reads back and checks `book.json` and every chapter, then
  publishes with one atomic directory move — never as sequential visible calls. Any failure before
  the move leaves no visible book and removes staging; a cleanup failure names the remaining
  staging path. Covered by fault-injection tests over a recording in-memory port
  (full suite 934 pass, typecheck clean).
- Spec 029 T010: the `books:importManuscript` channel carries the author's confirmed mapping
  (titles + full bodies, never a path) through a strict shared-core schema to
  `LibraryService.importManuscript`. The preload bridge exposes it; the web runtime refuses it
  as desktop-only. Covered by schema contract tests and a dialog-to-contract test
  (full suite 941 pass, typecheck clean).
- Spec 029 T011: the library offers a macOS-only Import manuscript journey — choose a file in the
  main process, inspect the exact preview with title and split edits, confirm to publish one
  complete book, cancel before the commit with nothing added, and see published, cancelled and
  failed outcomes truthfully (the publish cannot be cancelled into a different result). Covered by
  journey tests over a mocked bridge (full suite 948 pass, typecheck clean).
- Spec 029 T012: after each manuscript publish the library shows a result report with the source
  file name, book title, per-chapter split lines and word counts, normalization notes and the
  explicit note that planning data, images and other metadata were not imported. Every count is
  derived from the committed book, proven by tests that feed the report different committed text
  (full suite 951 pass, typecheck clean).
- Spec 029 T013, T017: the manuscript import journey is covered end to end on the macOS reference
  target. The hidden smoke run stages a synthetic manuscript, drives the real preview, split,
  confirm and result UI, and proves the book appears only after publication while the fixture and
  the rest of the library stay unchanged. Recorded acceptance: full suite 951 pass, typecheck
  clean, hidden smoke 27/27 with synthetic fixtures only (not packaged or release acceptance).
- Spec 012 T007: deterministic property tests for the format core and save decisions. Fixed-seed
  generators prove front-matter round-trips, normalization idempotence, slug safety, order
  round-trips, conflict-name classification, word-count invariance, exact version increments and
  the conflict-decision matrix — 10 tests, ~4,100 assertions, no new dependencies
  (full suite 961 pass, typecheck clean).
- Spec 012 T008: damaged-file isolation at the library-open path. Malformed chapter files fail
  alone with per-file reasons while the book lists and healthy chapters keep saving; prose
  without front matter stays readable. The workspace names each skipped file with its reason in
  a dismissible line (full suite 965 pass, typecheck clean).
- Spec 012 T012 (partial): chapter rail and conflict-banner component coverage. The real
  `ChapterRail` is driven through list, select, add, move, delete and keyboard focus; the real
  `WorkspaceView` proves the reorder shortcut with dialog suppression and both conflict banners
  with working actions (full suite 977 pass, typecheck clean).
- Spec 012 T012 (complete): chat composer and connection-card coverage. Enter sends with the
  continued thread and optional turn model, Shift+Enter adds a newline, the running turn offers
  Stop; cards show kind copy, test on demand with busy disabling, list models with context
  sizes, and remove only after confirm (full suite 988 pass, typecheck clean).
- Spec 012 T011: OAuth sign-in guards for the OpenRouter SSO flow with no network beyond
  localhost and no real account. Callback state, expiry, decline and malformed input are
  refused without echoing the code; the loopback flow proves a mismatched callback exchanges
  nothing, the first callback wins, cancellation frees the flow and a waiting second start is
  refused (full suite 1002 pass, typecheck clean).

- Spec 034 T001, T002, T015: the first report measures saved words and coverage only. Decided with
  the author after synthetic normalization examples: the repeated three-token phrase signal is
  deferred (a future signal unifies curly and straight apostrophes), and desktop ships first with
  browser and mobile reusing the shared component. The report copy, spec decisions, tasks and the
  deferred T008 record the outcome; acceptance tests cover every scenario except the deferred
  repeatable-phrase case, and no provider or network call exists on the run path.
- Spec 034 T011–T014, T017: the Review manuscript action now produces a read-only, run-local report
  over the confirmed saved snapshot (`packages/app/src/components/ReviewReportDialog.tsx`). It shows
  run scope and time, studio word counts, per-chapter coverage with skip reasons, the word-count
  definition, and an empty-findings state that does not imply the proposed phrase signal ran. Evidence
  navigation rechecks the saved version and hash, selects the exact span in the editor, and stays
  disabled while a report is stale; a new run replaces the report and switching books discards it.
  Running, stopped, failed, partial and insufficient-evidence states each name the next safe action.
  Covered by `apps/desktop/tests/review-report.test.tsx` (dialog states, synthetic evidence, and a
  workspace integration run that performs no manuscript writes) and smoke checks that run the
  report over the fixture book, keep writing through the save gate without touching typed text, and
  mark a changed chapter stale before a new run replaces it (21/21 smoke checks). Live phrase
  findings still wait on the metric decision (T008).
- Fixed the review gate reading mirrored React state, which could lag a fast keystroke by an effect
  and skip the save choice. The gate now reads the editor's live buffer status
  (`EditorHandle.getStatus()`), pinned by a fast-click renderer test.
- Spec 034 T016: the smoke run covers an empty book reporting "Not enough saved text to review"
  instead of a false no-findings result, and cancelling a slow run during the snapshot read so no
  analysis starts (23/23 checks). The analysis now reads its own fresh snapshot on the cancellable
  path with abort checks instead of reusing the gate's read. Still open: evidence navigation (needs
  live findings from the deferred phrase scanner).
- Spec 028 T006 (D-161): provider settings shows each connection's health from the author's last
  explicit Test, with a volatile check time that clears whenever Settings opens; opening Settings
  never probes. Voice shows configured read-aloud/dictation availability with no check time and
  states it is never tested automatically. A rejected key renders the redacted safe message, never
  the secret. Covered by `apps/desktop/tests/settings-status.test.tsx`.
- Spec 029 T001–T003, T005: manuscript import decisions recorded with the author (whole-file
  default with line-boundary splits, Markdown literal, filename-derived editable title; 5 MiB
  strict-UTF-8 source with one BOM strip, NUL/control rejection, empty refusal). New pure parser
  `packages/core/src/manuscript-import/` (`validateSource`, `previewImport` with canonical bodies
  and per-chapter edge-blank-line accounting) covered by 11 synthetic-fixture tests. Publication
  verified: the desktop adapter atomically publishes a staged tree with one same-filesystem rename,
  refuses cross-device moves, and gained `removeDirectory` for staging cleanup (desktop, in-memory
  and web stubs) with contract and conformance tests. Web copy+delete does not qualify, so the
  first profile's publisher stays desktop-gated.
- Spec 034 T006: the workspace has a Review manuscript action (header and mobile menu) wired to live
  editor state. A dirty chapter opens a save gate with Save and continue or Keep writing; the save
  path flushes the editor and re-reads a fresh snapshot before anything runs, while a conflict,
  failure or cancel never starts the review and leaves typed text untouched
  (`packages/app/src/components/ReviewGateDialog.tsx`,
  `apps/desktop/tests/review-gate.test.tsx`).

### Changed

- Removed the competitor branding research and its references from the event branch, and stopped
  tracking Spec Kit's machine-local extension cache. A public repository should not carry another
  product's name or 240 KB of someone's tool state.

- The live check now runs the Contributor model the spec names. It used to take the first id in the
  catalogue containing "contributor", which was `muse-spark-1.2-contributor` while spec 022 and the
  submission described 1.3 — a check that measures a different model than the document names reads as
  proof of something it never tested. It prefers the preset, then the newest version the key offers,
  and the run records which one it used (`apps/desktop/tests/live-model-choice.test.ts`).
- The glasses decision is **D-160**, not D-158. Spec 026 had reused the number that
  `docs/DECISIONS.md` gives to the SAM retirement, so the same id named two unrelated decisions.
  `docs/DECISIONS.md` now carries both rows.
- Spec 012's ledger is brought up to date with evidence: the coverage ratchet (T003) and the
  failed-write test (T009) are done; T002's lint and T008's damaged-file test are recorded as partly
  done rather than left ambiguous, and the stale test counts are replaced by a pointer to
  `docs/TESTING.md`.
- `specs/README.md` gains a "Beyond the event" table for the four capabilities that are deliberately
  out of hackathon scope — import wizard, review engine, formatting and KDP export, task-aware model
  routing — and says plainly that spec 007's EPUB and print PDF were folded into 002 as intent and
  never built.

### Added

- One line in the README that places the studio in time: it began two days before the event and this
  repository is the edition submitted. It is a fact a reader would otherwise have to infer from the
  first commit's size.

- Spec 028, integration health: one derived state per location and per provider, and one warning
  component with a severity and a safe action. Planned, indexed, not built.

- The desktop component tests render in a DOM that `apps/desktop/tests/support/dom.ts` registers for
  one file and restores after it, so later files see Node's globals again. React loads only once that
  DOM exists, and its scheduling uses Node's timers, which is what lets the next file render.
- Archived the inherited repository (private, read-only) instead of forking its history. This repository
  starts from a clean initial commit and contains none of its fixtures, exports or branding.
- Moved to Bun workspaces: `apps/desktop` holds the Electron app and `packages/core` holds the schemas,
  the IPC contract and the Markdown format, imported by both sides as `@ai-book-studio/core/*`. Root
  scripts delegate with `bun --filter`; `bun.lock` replaces `pnpm-lock.yaml`.
- Migrated the library tests from Vitest to `bun:test` with the same 13 cases and assertions, and removed
  the Vitest configuration and dependency.
- Repointed the token generator, the smoke runner and the packaging configuration at the workspace
  layout. The smoke runner resolves Electron from the desktop workspace.
- Scrubbed the inherited product's name and design-kit paths from the docs, the changelog and the
  vendored tokens. The one remaining reference is the legacy export's wire marker
  `moms-ai-book-studio`, which the port must recognise; it is documented as a format constant, not as
  the product name. The type specimen in `tokens.json` no longer uses a personal book title.
- The book's `settings` now carry the agent's own settings, and every setting is defaulted on the
  *input*, so a book written before a setting existed still opens. The committed sample library
  proves it, and a test guards it.
- The usage log now records whether the provider reported its cache at all, so a measured cache of
  zero is never shown as a provider that measures no cache.

### Added

- Added the studio's tool catalog in Meta's two interchange shapes (spec 026): a WebMCP tool list,
  which a page on Meta's Ray-Ban Display glasses registers so the wearer can ask for it by voice,
  and a Meta AI connector manifest, with every tool classified Read or Write and the destructive
  ones marked sensitive. `bookwriter tools --format webmcp` and `--format connector` produce them
  from a live studio. The studio's own tier was already the classification Meta asks for, so this
  is a renaming rather than a translation.
- Added a minimal mode to the workspace: a strip that knows where you are in the book, says it
  out loud when you ask, offers to read the prose, and takes a sentence when you have something to
  say. It has a microphone for the hands-free loop: press it, say a sentence, and it is shown as
  heard and sent to the agent, and the answer is read back. Speech goes through a connected voice
  service when there is one and through the system voices when there is not, and every word it says
  is also on the screen.
- Added the agent's own capabilities (spec 025): a cacheable prompt prefix where the provider
  supports one, with the hit rate, the cached and fresh token counts and the turns that hit it
  shown per book, and a switch to turn the prefix off; per-tool call, success and failure counts; a
  switch per built-in tool, per book, that withdraws the tool from the model, the backend and the
  MCP server alike; an optional `SKILLS.md` in the book folder, given to the agent as the author's
  own instructions; and a plugin folder of TypeScript tools the author points the app at.
  Documented in [`docs/AGENT-CAPABILITIES.md`](docs/AGENT-CAPABILITIES.md), and proved in the built
  app by `bun run plugin:probe`.
- A plugin's arguments are a JSON Schema, or a Zod schema when the plugin's own folder can resolve
  it: a plugin folder usually sits outside the app, where the app's packages cannot be resolved, so
  a plugin that needed an import would simply fail to load.
- Recorded the toolkit manual pass in `docs/research/toolkit-2026-10-26.md`: the compiled
  `bookwriter` binary and a separate MCP client process against a real backend over a real library,
  with every change read back from the file.
- Recorded the glasses assessment in `docs/research/glasses-2026-10-26.md`: Meta's three surfaces
  for the Ray-Ban Display, the Web App's documented constraints, the one constraint that decides
  the design, and the live check that rendered the studio's 22 tools into both the WebMCP and the
  connector shapes.
- Proved the glasses page's assistant half without the hardware. The page's normal path in a
  browser is the buttons-only one, which left WebMCP — the part that only runs on the glasses —
  untested. A stub model context installed before the page's own script records what it is given:
  the read verbs are there with their schemas and handlers, the write verb is marked as a write, the
  destructive tools are not offered to an assistant at all, and calling one through the assistant's
  path comes back with the book.
- Added the phone-width walk to the end-to-end gate: the same dead-end and accessibility audit at
  390×844, because the phone layout is a surface people use and it strands people differently.
- Added `.github/workflows/verify.yml`: the typecheck, tests, builds and the coverage floor on every
  push, and the end-to-end checks under a virtual display. The e2e job is marked allowed-to-fail
  until it has been watched passing on Linux, because every check so far has been run on macOS and
  claiming otherwise would be a guess.
- Added the ambient agent, the voice pipeline, the bridge and the glasses page to
  `docs/ARCHITECTURE.md`, and marked the SAM section superseded where it is described rather than
  leaving it looking live.
- Added the studio's session verbs to the MCP server: `studio_status`, `studio_ask`,
  `studio_undo` and `studio_stop`. Without them a third-party agent could edit a book it could not
  describe, and could not undo what it had just done. The status is readable on a read-only server;
  the three that change the book need `--allow-writes`. The tier filter now applies to every tool
  rather than only to the mirrored catalog, which a test caught: the new write verbs had been
  sitting in the always-included list.
- Added a coverage ratchet, `bun run coverage`: 81.5% of functions and 88.3% of lines, with a floor
  of 80 and 87 that only moves up. Coverage had never been measured, so nobody could tell whether a
  change made it worse.
- Added the archive export to the smoke run, so both export paths are proven end to end: the Word
  file is unzipped and checked for its illustration and its text, and the archive is read back for
  its entries and the book inside it. Spec 019 T010b closes.
- Made the glasses page show the agent's own status line, the same sentence the desktop's minimal
  mode says, rather than composing its own summary of the book. What the device cannot do — being
  spoken to, when WebMCP is off — moved to the header, so the agent's line keeps the display.
- Made the ambient status say the truth about `working`. It was always `false`, so the minimal
  mode never offered Stop, and a phone would have shown a Stop it could not honour. The status now
  asks the runtime, and the control plane and the bridge both grew `POST /v1/books/:bookId/stop`.
- Fixed the minimal mode in the browser build. It showed an error on every book because the ambient
  status was a desktop-only stub, but the status is a pure function over the book, so this build now
  computes it from the library it already has. The web smoke proves the line and the six actions.
- Added undo to the control plane and the bridge, and `bookwriter undo`. The ambient status offers
  the action whenever a checkpoint exists, so a client that shows the status must be able to perform
  it; a route that offers an action it cannot do is a dead end in a pair of glasses. The bridge probe
  and the ambient check both drive the refusal that says there is nothing to undo.
- Added one end-to-end gate, `bun run e2e`, which builds the app, the web build and the toolkit and
  then runs seven checks against them: the built app through its own renderer, the browser build over
  its own storage, the real window for dead ends, the 600×600 glasses page, the ambient agent and the
  toolkit, a folder of plugins, and the phone's bridge **from a separate process**. Documented in
  [`docs/TESTING.md`](docs/TESTING.md).
- Added an accessibility pass to the UI audit: every control has an accessible name, is at least
  20 px to hit, every image has an `alt`, the view has exactly one `h1`, and one Tab reaches a control
  with a visible focus ring. The app passes all of them (33 controls).
- Added a real Word-export check to the smoke run, which needed a way to export without a save
  dialog: `STUDIO_EXPORT_PATH` names a folder for a headless run. The check unzips the file it
  produced and looks for the text and the picture, because the thing that goes wrong is never the
  writer's opinion of what it wrote. The fixture now carries an illustration.
- Added the voice pipeline (spec D-159): a text-to-speech seam in `packages/core/src/providers/tts.ts`
  with two services behind it, both using OpenAI's `audio/speech` shape — OpenAI directly for the
  studio's voice, and OpenRouter, whose free `fish-audio/s2.1-pro-free:free` makes a check that runs
  on every change cost nothing. OpenRouter has fifteen dedicated TTS models, discoverable with
  `GET /api/v1/models?output_modalities=speech`; they are listed under `"speech"`, not `"audio"`,
  which is easy to miss. A provider that answers with raw `audio/pcm` is wrapped in a WAV. A chapter
  is longer than one request, so the text is split at sentence boundaries and the audio is joined
  back into one sound. The minimal mode speaks through it, offers the voices, and falls back to the
  device's own voice when no service is connected. Documented in [`docs/VOICE.md`](docs/VOICE.md).
- Retired the SAM cutout (D-158): the request reaches Meta and is accepted, but returns no records
  and no usage on real and synthetic images alike, so nothing is built on it and spec 020 is marked
  superseded. The implementation and its tests stay where they are.
- Recorded the live Meta pass in `docs/research/live-meta-2026-10-26.md`: the model catalogue, a real
  writing turn with a Contributor model on a temporary copy of the sample (the pass condition was that
  the file on disk changed), dictation scored against a spoken phrase (all nine words), and a live
  Muse Image. SAM 3.1 answers `200 completed` with no records and no usage on every image and prompt
  tried, so it is recorded as blocked on the model's availability rather than on the studio.
- The check scripts now clear `NODE_OPTIONS` and the `HEADROOM_*` variables before spawning the app.
  A coding agent's shell can install a `fetch` shim that routes requests through a proxy that
  authorises only the agent, and an app that inherits it sees `{"error":"unauthorized"}` from every
  provider — an error indistinguishable from a bad key. The checks must measure the product, not the
  agent's proxy.
- Added the ambient agent: a status the studio keeps whether or not anyone is looking, and two
  ways to reach it. `GET /v1/books/:bookId/ambient` says where the author is, what changed last
  and what can be said or done; `POST /v1/books/:bookId/turn` runs a turn and waits for the
  answer, through the same runtime the app uses. The toolkit gained `bookwriter where` and
  `bookwriter ask`. The glasses' phone app needs exactly these two routes.
- Added the glasses page (spec 026): a 600×600 interface for Meta Ray-Ban Display glasses, served
  by the studio itself so it is the same origin as the API. It is dark because the display is an
  additive waveguide, it never scrolls because there is no scrollbar the wearer can see, it moves
  focus with the D-pad, it speaks through `speechSynthesis` while keeping the text visible, it
  registers the studio's own read tools with the browser's model context so an assistant on the
  glasses can call them by voice, it asks the wearer before every write, and it says plainly when
  the device cannot do something. `bun run glasses:check` drives it in a real browser at 600×600
  against the real studio: twelve checks, no dead ends.
- Recorded the plugin manual pass in `docs/research/plugins-2026-10-26.md`: the built app pointed at
  a folder of TypeScript plugins, the plugin's tool listed in the backend's catalog, the tool run
  against the open book, and a plugin that cannot resolve its imports left the others working.
  `bun run plugin:probe` repeats it.
- Added the studio's own writing tools to the loopback backend and the MCP server (spec 024): the
  backend serves `GET /v1/tools` and `POST /v1/books/:bookId/tools/:tool`, and `bookwriter mcp`
  mirrors the built-in agent's tools with a `bookId` argument, so a third-party agent gets the same
  verbs. Read tools are always available, write tools need `--allow-writes` and destructive tools
  need `--allow-destructive` on both the client and the request.
- Added `bookwriter tools` and `bookwriter call`, so a script can run one studio tool against the
  open book.
- Fixed two dead ends in the interface: the model picker without a connection pointed at a
  "Connections window" that does not exist and offered no way to add a key, and a failed turn in the
  writing agent offered only "Retry request", stranding the author's prompt when no model was
  chosen. Both now offer the action that resolves them.
- Added `bun run ui:audit`, which drives the real app through the main flows and reports any dead
  end, missing control or console error it finds.
- Added the submission package (spec 023): a committed original sample library at
  `samples/the-salt-road`, `hackathon/SUBMISSION.md` with the form fields, event-built disclosure, model
  list, demo runbook and judge map, and `bun run submission:check` for branch/tree, required files,
  forbidden paths, secret patterns and sample integrity.
- Added the film motion plates (spec 021 T007): eight HTML/CSS scenes using the studio tokens, a
  deterministic `window.renderAt(ms)` timeline, and a Playwright renderer for 1920×1080 preview stills or
  30 fps PNG sequences. Previews checked for problem, files, trust, background, visuals, voice, interop
  and close.
- Added a credential-vault health check and macOS runbook: `connections:status`, a non-secret
  `safeStorage` encrypt/decrypt probe, a **Check keychain** action in Settings, `STUDIO_VISIBLE=1` for a
  visible throwaway profile, and [`docs/KEYCHAIN.md`](docs/KEYCHAIN.md) covering unlock, locked-state
  testing, recovery and the legacy-keychain limits.
- Added the provider compatibility layer (spec 022): one `modelFor` AI SDK adapter registry, Meta model
  presets for Muse Spark 1.3 Contributor/Standard, cached prices and reasoning facts, and a per-book
  Contributor training consent with a model-picker warning and an agent guard.
- Added the film fixture generator (spec 021 T004): `bun run film:fixture` builds an original short
  book with a Story Bible, two chapters, a deterministic 1024×1024 illustration and a 512×512
  transparent character cutout through the real library and image store. The fixture is ignored by git;
  the generator and its test are committed.
- Added the product-film plan (spec 021): a positioning review of the category, a positioned script,
  a shot-by-shot storyboard and the voice, music
  and motion-plate production plan. Added the brand-positioning paragraph to `docs/DESIGN.md`.
- Added SAM 3.1 character cutouts (spec 020): prompt validation, the official `@meta-sam/parser` for the
  mask grammar, a `segmentation:segment` IPC route, the renderer `applyCutoutMask`/PNG compositor and
  cutout mode in the Illustration dialog. Cutouts save as `character` images with `cutoutOf`; a cutout
  can be attached to a cast member at save time or from the image list, and the character id is stored on
  the image record.
- Added the illustration pipeline (spec 019): a versioned `images.json`, an atomic image store over
  `LibraryPort`, PNG/WebP/JPEG inspection, Muse Image generation through Meta at a visible `$0.01`
  per-image estimate, IPC, an Illustration dialog, an attached image below the chapter and DOCX
  embedding with the prompt as a caption. The dialog’s missing-connection, attached-image, generation,
  attach and SAM-match states are covered under happy-dom.
- Added specs 019 and 020 for illustrations and SAM 3.1 cutouts, including the documented Meta
  endpoints, the mask grammar and the renderer-side compositor plan.
- Added the standalone `bookwriter` toolkit (spec 018): a loopback-only desktop backend with a per-run
  token, a CLI for info/books/read/search/conflicts/create/save, and an MCP stdio server whose read
  tools are on by default and whose write tools require `--allow-writes`. Saves carry the version and
  hash from the read and use the existing conflict path.
- Added Muse Voice Transcribe dictation (spec 017): a Meta ASR service in the main process, strict
  mono 16-bit PCM WAV validation, browser-side decode/resample/encode, a microphone button with a
  ten-minute cap, and insertion at the editor caret through the normal save path.
- Added background agent turns: an opt-in per-turn flag, an outcome callback after finish, failure,
  stop or approval pause, native notifications with a short preview, a dock badge and focus-on-click.
  Destructive approvals still wait for the author.
- Recorded the Meta participant guide in `hackathon/EVENT.md`: the full schedule and Discord channels,
  the four-person team cap, the open-source and event-only-work rules, the anti-project list, the $150
  credit and partner offers, the three-stage judging rubric, both prize tracks and the bonus prizes, and
  the submission requirements including the three-minute demo video.
- Added spec 009 for desktop packaging, signing, notarisation, release provenance and the gated
  update path; D-115 keeps signing and updates deferred.
- Added the automated-verification plan and task ledger for spec 012, covering the existing Bun,
  smoke, browser-matrix, gallery and key-check evidence and the remaining lint, coverage,
  accessibility, performance, security, CI and live-provider gaps.
- The browser storage harness reloads a saved OPFS library in the same tab and verifies the chapter,
  alongside the picker and two-tab checks. Chromium passes 16/16 real-browser checks.
- The browser storage harness now covers picker cancellation, a denied folder re-grant that keeps the
  pending folder, and two-tab Web Lock serialization. Chromium passes 15/15 real-browser checks; the
  native picker and real Safari/Firefox remain open.
- The writing agent now treats manuscript, Story Bible and tool text as untrusted data: the prompt
  wraps it in a labelled block and tool descriptions mark returned text as data.
- The chat composer can choose a model for the next message only. The runtime validates it, records
  it on the turn, and leaves the book default unchanged.
- A turn that pauses for approval stores the request on its assistant message. Reloading the
  conversation shows the same Allow/Deny card; allow, deny and stop update the stored decision, and a
  request left by a closed app reports that it expired when answered.
- A context-overflow error now names the model's context limit and offers **Choose a larger model** and
  **Start a new conversation** instead of a dead-end retry.
- The assistant message stores a per-section estimated context breakdown (instructions, book, outline,
  characters, memories, chapters, active chapter and conversation) and the chat shows it in a closed
  Context disclosure.
- The turn usage line now shows input tokens as a percentage of the selected model's context window
  when the catalogue reports one; the context length is stored with the assistant message and usage.
- The chat can start a new conversation and list stored conversations in a history dialog; choosing
  one reloads its messages and checkpoints. Conversations can be renamed inline, branched from an
  assistant turn into a new thread, or deleted behind an explicit confirmation. The smoke run now
  covers the new/history controls (16/16).
- OpenRouter's reported final-step cost is read from provider metadata and shown per turn; a missing,
  negative or non-numeric value stays unknown instead of becoming zero. Other providers stay unknown.
- Tool activity now carries its input and output, and the chat keeps the main line plain while a
  closed Details disclosure shows the raw call and result. The stored-message conversion moved to
  `packages/app/src/lib/chat-view.ts` with tests.
- Added a provider-registry contract suite: every provider has a complete entry and unique hosts,
  keys stay in headers, base URLs are normalized, provider catalogue payloads parse consistently, and
  model capabilities and selection never guess an unreported field.
- Moved the studio shell into `packages/app`: `App`, views, product components, hooks and renderer
  utilities. The desktop renderer keeps a one-line re-export; the web imports `@ai-book-studio/app`
  directly, and the `@renderer` alias is gone from the build and typecheck configs.
- Moved the Liquid Glass stylesheet and generated tokens into `packages/ui/src/styles/`; both build
  entry points import `@ai-book-studio/ui/styles/base.css`. `build:info` now checks the app, core and
  UI package versions too.
- Added `merge_chapters`: merges adjacent chapters into the first, pauses for approval, and records the
  deleted chapter in the checkpoint so undo recreates it in its original position.
- Added `split_chapter`: splits a chapter at a 1-based line into two ordered chapters. It pauses for
  approval and records the created chapter in the turn checkpoint, so undo removes it as well.
- Added `insert_at_line`, `delete_lines_in_chapter` and `move_chapter` to the writing agent. Line
  delete and chapter move pause for approval; line insert and delete are checkpointed, while a move
  changes chapter order only.
- Added `overwrite_chapter` and `delete_chapter` to the writing agent. Both pause for the author's
  approval; overwrite is checkpointed and undoable, delete moves the chapter to the trash.
- Added the first approval-gated agent tool: `remove_memory` now pauses the turn with an Allow/Deny
  card, resumes with a `tool-approval-response`, and passes a denial back to the model. The pause and
  denial are covered by mock-model tests; ADR 0014 records the protocol.
- Added a model-factory seam to `AgentRuntime` and two contract tests using AI SDK mock models: a full
  text turn persists its thread and usage, and a tool call runs through the same `ToolLoopAgent`.
- Added `compactHistory`: the runtime keeps the last six user turns verbatim and summarizes older
  tool activity before sending, while the stored thread remains complete. This closes 002 FR-030.
- Added `find_in_chapter`, `find_in_chapters` and `update_memory` to the writing agent. Search returns
  line numbers and matching text; memory updates keep the Story Bible current without removing a
  memory (removal still needs the approval flow).
- Added the `hackathon/` folder with the Meta Global AI Developer Hackathon brief, the AI Book Studio
  Meta Edition plan and the 10-day milestones.
- The writing agent now stores each turn under `books/<bookId>/threads/` and the chat reloads the
  latest conversation. A failed turn keeps its user message for Retry; a stopped turn keeps its
  partial text, reasoning and tool parts.
- Adopted the Apache License 2.0 (`LICENSE`, `NOTICE`) and declared it in every workspace package.
- Added the canonical agent message/thread format in `packages/core/src/agent/` and a `ThreadStore`
  over the shared library port, with 8 tests. Conversations have a file format under
  `books/<bookId>/threads/`; the runtime and chat do not write it yet. Recorded in ADR 0013 and
  `docs/FORMAT.md`.
- The writing agent now reads the Story Bible: the prompt carries saved memories and each character's
  description, motivations and notes; `read_story_bible` returns the full bible; `update_character` can
  change motivations and notes; and a snapshot plus a 4,000-token budget test guard the prompt. The
  worst-case fixture is 3,384 tokens.
- Added `docs/AGENTIC-COVERAGE.md`, an audit of specs 002/011/012 against the agent runtime: 19
  requirements implemented, 5 specified but missing, and conversation persistence, approvals, context
  assembly, injection safety and agent evals unspecified. Corrected the stale known-gaps list in
  `AGENTS.md`.
- Added T014's shared-component gallery at `apps/web/check/gallery.html`. It renders the shared Button,
  Brand, Notice and Dialog, compares browser-storage and folder disclosures, and was measured in light
  and dark at phone, tablet and desktop sizes. Also taught the web stylesheet to scan `packages/ui`.
- Moved `Brand` and `Notice` into `packages/ui`; the desktop renderer re-exports them, and the web
  welcome imports the shared Brand and Button instead of the `@renderer` alias.
- Added the first `packages/ui` extractions: `Button`, `Dialog` and `cn` now live in the shared package,
  the desktop renderer re-exports them, and both apps depend on the package. Remaining components and
  the visual check page are still open.
- Added `bun run smoke:packaged`: it builds the unpacked macOS app, starts the packaged binary with a
  throwaway profile and fixture library, and runs the full hidden suite against it. Passed 16/16.
- Added a Playwright cross-browser matrix for the real storage harness: Chromium passes 12/12, including folder mode through a picked OPFS handle; Firefox
  and WebKit OPFS openings are recorded findings. Browser storage now times out after five seconds and
  tells the author to choose a folder or export an archive instead of waiting indefinitely.
- Added unit coverage for the cross-tab Web Lock request and its no-lock fallback; the real-browser
  two-tab matrix remains.
- Completed the mobile accessibility pass: touch controls, accessibility labels and visual order on the
  iPad mini shell, reduced motion/transparency enabled and relaunched, and a web smoke check that
  emulates both media features and asserts no transition duration or backdrop filter.
- Added browser OpenRouter sign-in: a same-origin popup with PKCE and checked state, code exchange,
  storage in the browser vault, and list/remove in Settings. The live browser-access pass remains
  T040/T041; manual keys and the other providers stay gated.
- Added unit coverage for browser capability detection and persistence denial, unsupported and failure
  paths; the real-browser Playwright matrix remains.
- Added browser permission-recovery tests: a re-granted folder opens as `folder://`, and a denied
  re-grant keeps the folder pending without switching storage tiers. All T026 browser journeys now have
  automated coverage; the real-browser picker matrix remains T013/T027.
- Added a browser folder-mode integration test: a picked fake folder opens as `folder://`, creates a
  book and chapter, and saves through the shared library service.
- Added the browser credential vault (D-105): an origin-scoped IndexedDB store that returns summaries
  without secrets, supports touch/remove/re-open, and shows a Settings disclosure that it is not the OS
  keychain and can be cleared with site data. The browser OpenRouter flow stores its connection here.
- Added a DOM test for the browser archive import picker, covering both a selected archive and a
  cancelled picker. The core import path and the web export journey remain covered separately.
- Added a real DOM component-test setup (happy-dom and Testing Library) and editor tests for the 700 ms
  autosave debounce and the conflict state. The legacy import is recorded as delivered with its parser
  and importer tests.
- Chapters can be dragged to a new position in the rail. The move renumbers only the affected orders,
  checks both versions and hashes, rolls back a conflicting write, and is covered by the hidden smoke
  run. The rail buttons and keyboard move remain.
- Documented the sync journal, read-only scanner and drift detector, the two-system harness results and
  the D-124 device-identity caveat in the architecture and decision records. No drift UI or app lock has
  shipped; both remain behind D-121–D-124.
- Verified the iPad mini rotation path in the Capacitor shell: a chapter keeps its selected state, typed
  text and `Saved` status across portrait and landscape. The procedure, accessible names and remaining
  VoiceOver/reduced-motion checks are recorded in `docs/research/mobile-layouts.md`.
- Undo and redo now survive switching chapters. The editor keeps a per-chapter in-memory history,
  coalesces a typing burst into one step, clears it when the disk version is refreshed, and the hidden
  smoke run switches chapters and undoes the typed marker.
- Each agent turn records its provider, connection label and model id with its usage, and the
  conversation shows the model when it changes between turns.
- The studio now notices changes made outside it. The desktop filesystem port watches `books/**` and
  `.studio/trash/**`, the main process debounces them into one event, and the workspace offers a refresh
  that flushes unsaved text before reloading the chapter. Chapters can also move with ⌘⌥↑/⌘⌥↓
  (Ctrl+Alt on Windows) beside the rail buttons.
- Added browser smoke journeys for a stale-save conflict and a portable archive export, plus fake-handle
  tests for folder-picker cancellation and permission mapping. Updated the storage architecture/format
  docs and the spec 011 web tasks to record the landed storage boundary and the remaining decisions.
- Added shared build metadata and a capability table. Settings → About now reports the target, version,
  commit, format version, platform, storage and whether each capability is available, with a reason for
  every unavailable one. Vite and electron-vite inject the same version and commit as `bun run build:info`.
- Added one build-info source (`bun run build:info`) for version, commit, schema and target; it fails when
  the workspace package versions disagree. Desktop artifacts now carry the product, version, OS and
  architecture in their names. Added a deployment, promotion and five-minute rollback runbook, a Gitea
  verify workflow, and an honest README note that no runner is registered yet.
- Chapters can be moved up and down from the chapter rail. The move swaps order metadata only, leaves
  file names in place, checks both chapters' versions and hashes, rolls back a half-applied move, and is
  covered by the hidden smoke run.
- Added the two-system sync harness and read-only library scan from spec 016 (T004–T005). The scan hashes
  `books/**` and `.studio/trash/**`, probes online-only placeholders before reading, skips provider sidecars
  and transient files, and reads book schema and chapter identity from the same bytes. Ten scenarios cover
  clean propagation, concurrent and offline edits, deletion/tombstones, placeholders, interrupted copies,
  corrupt journals, repeated scans, provider conflict copies and renames. The harness found and fixed a
  detector bug where a chapter moved to the trash was paired as a rename instead of a deletion.
- Added the sync baseline and read-only drift detector from spec 016 (T001–T003): a per-device journal
  with tombstones, rename pairing, placeholder/unreadable/newer-schema reporting, and 14 tests. No UI or
  provider integration yet.
- Captured spec 016, sync and device trust: two-device folder sync, read-only drift detection with
  tombstones, an optional Face ID/Touch ID or keychain-PIN app lock, and a two-system transport harness.
  No sync code ships yet; decisions D-120–D-123 are open.
- The browser build now reports its storage summary through `LibraryInfo`, including the tier,
  persistence and the last confirmed save time, and Settings shows it with the browser warning.
- The browser build keeps unsaved chapter text in a draft buffer and flushes it once when the page
  is hidden. The flush reports `confirmed`, `conflict`, `unconfirmed` or `empty`; a write that does
  not land is never reported as saved, and the held text stays available.
- Books can be renamed and moved to the library trash from the library grid. Deletion preserves the
  whole folder under `.studio/trash/books/<timestamp>-<bookId>/`; the browser build moves the folder
  through the same storage port, so a deleted book survives in site storage and in archives.

### Fixed

- Speech says the words, not the Markdown. Emphasis, links, images, headings, lists, tables, rules and
  code fences are converted before anything is spoken, by the spoken answer, read-aloud and the device
  voice alike (`packages/core/src/speech-text.ts`). The stored text is never changed.
- Provider names and connection ids now share Zod schemas between the core contract and the IPC
  boundary; malformed connection ids and unknown providers are rejected in tests.
- The credential vault repairs a world-readable file to owner-only permissions at startup and reports
  when the platform cannot confirm the mode. A scan test proves a stored connection leaves no plaintext
  secret in `studio.json` or the library.
- Browser saves now re-check the target hash immediately before the commit point and abort the swap file
  when another tab or folder writer changed the file. A read-back hash mismatch is reported as a conflict,
  never as saved. Injected permission, read-only, quota, interrupted-close and concurrent-edit tests assert
  that the previous bytes stay intact and the author's text survives in a conflict copy.
- A chapter whose title contains `conflict` is no longer hidden from the chapter list or treated as a
  provider conflict copy. The rule now matches only `.conflict-<reason>` and `(conflicted copy)` names,
  and the library and the sync scan share it.
- In the browser build, a successful save no longer discards newer draft text that was typed while
  the save was in flight; the draft is cleared only when its content is the content that was written.
- A failed agent turn keeps its original prompt and history for an explicit retry. Auth failures also
  offer Reconnect, which opens Settings on the provider-connections section without clearing the turn.
  Partial writes are checkpointed before the error is shown, and retry waits until the author undoes
  the changed chapters. The hidden smoke run covers the no-model retry path.
- Settings is now reachable from the workspace, from both the header gear and the phone More
  sheet. The old Connections dialog became a shared Settings surface covering appearance,
  provider connections, and where the library lives, and the Library gear is labelled Settings.
- The workspace save state shows a short text label at every width instead of only a coloured
  dot. The chapter delete action is visible on touch instead of hover-only. Settings and Story
  Bible keep Done/Save visible while their bodies scroll. Recorded in
  `docs/research/ui-audit-2026-10-25.md`.

### Added

- Added the Capacitor iOS shell (`apps/mobile`) around the real web build. It runs on the iPhone 17 Pro
  and iPad mini simulators with no native plugins, honors safe-area insets, and hides or explains
  actions WebKit cannot support instead of failing at the moment of use. `bun run ios:iphone`,
  `bun run ios:ipad` and `bun run ios:pair` build and open the devices.

- Polished the web shell: a plain-language storage welcome, and a phone-width library card that no
  longer wraps onto a third metadata line.
- Added the `apps/web` static shell: the real renderer runs in a browser with a storage-choice welcome screen, OPFS or chosen-folder libraries, archive import/export, and desktop-only actions explained instead of failing silently. `bun run build:web` emits `apps/web/dist`, and `bun run smoke:web` drives the built app in a hidden Chromium window (6/6 checks).

- Added a browser storage self-check harness at `apps/web/check/` that runs the real OPFS adapter, checked saves, a stale-save conflict, archive round-trip and IndexedDB in a browser and reports pass or fail without touching an author library.

- Added browser archive I/O: export streams into the browser's save picker when one exists and otherwise downloads a Blob; import reads a chosen File twice, so the core validator can check every path and hash before writing. No archive byte or credential is sent to a server.

- Added the browser storage layer in `apps/web`: one `LibraryPort` over a browser directory handle serves both chosen folders and OPFS; IndexedDB keeps only the handle and library id; folder permission, persistence, quota and cross-tab lock state are reported through the shared storage summary.

- Added library archive actions to the desktop library view: export writes a complete ZIP beside the chosen file and only replaces an older export after success; import validates the archive, requires an empty destination, never merges into the open library, and opens the imported library on success.

- Added the portable library archive in `packages/core`: a versioned, hash-validated ZIP manifest; streaming export that excludes credentials, catalogs, device identity, temporary and lock files; and a two-pass import that validates every path, size and hash before writing, refuses a non-empty destination and cleans up its own partial writes.

- The hidden smoke runner now reads the app's machine-readable result, so a passing run is not reported as a timeout when Electron closes the window but leaves the main process alive (recorded as a known issue in spec 012).
- Moved the library rules into `packages/core`: `LibraryService`, validated library-relative paths and the `LibraryPort` contract now own checked saves, conflict copies, trash, search and the derived catalog. `apps/desktop/src/main/library/fs-port.ts` is the reference filesystem adapter and `store.ts` is a thin facade, so the desktop IPC surface and its tests are unchanged. The in-memory conformance suite covers external edits, stale versions, trash/restore, newer schemas and failed writes.

- Added spec 010 for the browser storage/portable archive prerequisite, including a researched decision for browser credentials and the archive format, and a task plan that records the missing storage-port implementation instead of assuming ADR 0009 is already landed.
- Added the first target-neutral `LibraryPort` contract, validated relative/archive paths and in-memory tests for compare-before-write, byte isolation, directory listing and non-overwriting moves.
- Corrected the architecture status: the port contract exists, but shared library logic and production adapters are still pending in spec 010.
- Added plan and task tracking for spec 014; the 44px touch-target audit, safe-area work, orientation checks and real Capacitor renderer integration are now explicit open tasks.
- Finished the spec 014 touch-target pass: coarse-pointer layouts enlarge hit areas without changing icon size, the chapter delete action is reachable without hover, the agent Send button no longer overflows at 393px, long library paths truncate, and tall dialogs scroll inside the viewport.
- `capture.mjs --coarse` now emulates touch and fails on any visible control below 44 × 44 or on horizontal document overflow; the measured audit is recorded in `specs/014-mobile/checklists/touch-targets.md`.

- Model access, Phases 1–4 of spec 011: the provider contract and static registry (OpenRouter, OpenAI,
  Anthropic, Gemini, Meta with browser-access status), catalogue freshness and merge rules,
  `capabilitiesFor` with explicit unknown, `normalizeProviderError` (including `Retry-After`) and
  redaction for keys, bearer headers and query strings. `packages/core/tests/providers.test.ts` covers
  the contract.
- Desktop provider layer: a testable `FileCredentialVault` behind the operating system's protected
  storage (`userData/credentials.json`, `0600`, no plaintext), an OpenRouter loopback sign-in with PKCE
  S256, state checking, a ten-minute timeout and cancel, code exchange, labelled connections, a cached
  model catalogue and a key test. The Connections dialog connects, tests, lists models and removes a
  connection, and refuses to save when protected storage is unavailable. D-104 is accepted for desktop.
- Direct API keys for OpenAI, Anthropic, Gemini and Meta: the key is validated against the provider
  before it is stored, a rejected or unreachable key is never saved, keys travel in headers rather than
  query strings, Meta's base URL is configuration, multiple labelled accounts per provider are allowed,
  and removing a connection drops its secret and cached catalogue together.
- Optional provider, connection and model fields on `book.json`; books written before them still parse.
- Model selection per book: a turn override wins, then the book's saved choice, then the first usable
  connection. A saved model that can no longer run the agent falls back and explains why. The model
  picker lists every connection's models with context size and price, searches them, disables models
  that cannot use tools with a one-sentence reason, and warns when the saved model has vanished.
- The renderer's content security policy now allows only local connections. Model requests and keys
  stay in the main process, and a test fails if a registered provider host appears in the policy.
- A single transport module builds the AI SDK model for every provider: OpenRouter, the native OpenAI,
  Anthropic and Gemini factories, and Meta through an OpenAI-compatible client with its configured base
  URL. Nothing else in the app constructs a provider client.
- Usage is recorded per turn in `.studio/usage/<bookId>.jsonl` with reported or estimated cost. Cost is
  labelled reported, estimated, included in a plan, or unknown; an unknown cost never appears as $0.00.
  A usage summary channel reads the file without ever uploading it.
- Provider errors are normalised to auth, rate limit, quota, context, refusal, offline or unknown, with
  the provider's retry delay carried through.
- The first writing-agent loop: a `ToolLoopAgent` in the main process reads the book, the chapter list
  and the active chapter into a compact prompt, then edits through five tools (chapter list, read a
  chapter, count words, replace one unique passage, append text). Each edit goes through the same
  version-and-hash save protocol as the editor, so a conflict becomes a refusal rather than data loss.
  The chat panel streams text and tool progress, can stop a turn, and reloads the manuscript when the
  agent finishes. A turn's usage is appended to the book's usage file.
- The Story Bible: one dialog edits the book's title and description, genres and influences,
  outline, the three-act story arc, the cast and saved memories, all through the same book update
  channel and validated schema.
- A turn that edits chapters writes a checkpoint before its first change. The chat offers “Undo this
  turn”, which restores every chapter the turn touched through the same version and hash save
  protocol; checkpoints live under the book's `.studio/checkpoints` folder.
- The writing agent can also shape the book: it creates chapters, updates chapter titles, synopses
  and purposes, revises the book's description, outline or genres, keeps characters current and
  saves short memories. All of these go through the same book and chapter store.
- Export to Word: a book becomes a `.docx` with a title page, a page break per chapter, and the
  manuscript's font, size, line spacing and first-line indent, written atomically to a location the
  author chooses.
- Legacy import: a backup from the earlier app becomes books, chapters, characters, memories and
  manuscript settings in the open library. Chapters keep their text, the old conversations are left
  behind, and a damaged book is reported instead of stopping the rest.
- Book search: a search window finds matching lines across every chapter, ignores case, and opens
  the chapter from a result.
- Mobile path recorded: Capacitor for the iOS and Android shell, Expo Simulators or the Device hub for
  device testing. Expo is not adopted as the app framework (D-117, D-118).
- Local iOS simulator ready: Xcode 26.6 installed the iOS 26.5 runtime, iPhone 17 Pro boots and
  screenshots, and `Simulator.app` opens. Device hub agent access still needs to be enabled for the
  T3 simulator tools; `simctl` works without it.
- Capacitor shell spike: Capacitor 8.5.3 built through Swift Package Manager and launched a bundled
  page on the iPhone 17 Pro simulator, proving the WKWebView path without Expo or React Native. The
  real renderer and the Filesystem, SQLite, Keychain and iCloud plugins wait for spec 010. Recorded in
  `docs/research/capacitor-ios-spike.md`.
- Mobile-first layouts for the iPhone (393 × 852) and iPad mini (744 × 1133): a compact header, a
  bottom action bar, a chapter drawer, a full-screen agent sheet and a two-pane tablet workspace.
  The 700px and 1000px breakpoints, responsive manuscript type and dialog widths are recorded in
  `docs/DESIGN.md`; spec 014 defines the acceptance criteria and D-119 records the reference devices.
  Captures are in `docs/research/mobile-layouts.md`.
- A capture harness for the real renderer: `STUDIO_WINDOW_SIZE` and `STUDIO_CAPTURE` in the main
  process, plus `bun run capture:run 393x852 out.png` and an optional selector to open a book or panel.
- 107 tests pass (13 library, 26 provider contract, 5 credential file, 13 provider flow, 5 selection,
  2 content security policy, 4 transport, 6 usage contracts, 5 usage storage, 8 agent tools and
  prompt, 5 checkpoints and undo, 5 planning tools, 2 export, 4 legacy import, 4 search).
- `docs/DECISIONS.md`: a decision register with 16 settled decisions and 16 open ones (D-101…D-116),
  each naming the evidence needed and the spec or task it blocks, plus the rule that a spec relies only
  on an accepted decision or a stated assumption.
- Plan and tasks for spec 013: the six-phase workspace, packaging, shared UI, web target, environments
  and CI sequence (T001–T021), with T001–T012 complete.
- Packaging spike: `bun run package:dir` builds `release/mac-arm64/AI Book Studio.app`, and the packaged
  binary passes all five hidden smoke checks against a fixture library, including a saved edit. The
  build is unsigned and uses the default icon, as expected for this stage.
- Hidden test runs: `STUDIO_TEST`, `STUDIO_HEADLESS` and `STUDIO_SMOKE` launch an off-screen window
  with its own profile, and `bun run smoke` drives the real UI through the preload bridge, the library,
  opening a book and an autosave reaching the disk.
- Spec-driven record: `.specify/memory/constitution.md` with seven principles, `specs/README.md` with
  the roadmap, and `specs/001-foundation/` (spec, plan, tasks) describing the foundation as built.
- `docs/ARCHITECTURE.md` (process split, save protocol, sync model, testing seams) and
  `docs/DESIGN.md` (Liquid Glass rules, type scale, voice, accessibility checklist).
- ADRs 0001–0006: local-first Electron, Markdown as source of truth, user-chosen sync folder, token
  pipeline, spec-driven development, and AI calls plus secrets in the main process.
- White-room product specification `specs/002-studio-v1/` covering writing, the Story Bible, the agent,
  import and migration, voice, illustrations, export, sync and trust (76 requirements, 16 measurable
  outcomes), with its quality checklist.
- Import specification `specs/003-earlier-studio-import/` for an earlier studio's JSON export, mapped
  book by book, with idempotency, atomic publication, a migration report and rollback.
- `docs/FEEDBACK-DISPOSITION.md`: all fifty inherited defects (F-001…F-050), nineteen follow-up themes
  and fifteen unresolved design decisions given a disposition and a target requirement.
- Browser build requirements in spec 002: one shared book format, real-folder access in Chromium,
  origin-private storage in Safari and Firefox, explicit degraded guarantees, direct provider calls,
  and archive portability (FR-071…FR-076, SC-015, SC-016, user story 10).
- `docs/adr/0009-multi-target-storage.md`: the core/port/adapter design, the verified File System Access
  and OpenRouter CORS facts, and the three storage tiers. Electron becomes one adapter rather than the
  owner of the format.
- Harness evaluation appended to ADR 0007: `@ai-sdk/harness` cannot run in a browser, would bypass the
  save protocol, and is experimental, so harness runtimes are deferred behind the runtime seam.
- `docs/adr/0010-bun-and-workspaces.md`: Bun as package manager, task runner and test runner; a Bun
  workspaces layout for desktop, web, core, UI and shared config; Electron keeps its Node runtime and
  builder/Playwright stay on Node. Electrobun rejected for v1.
- Deep specs 011 (model access: OpenRouter SSO, provider keys, ChatGPT plan, capability rules),
  012 (automated verification: unit, contract, web and Electron end-to-end, live checks, gates) and
  013 (builds and deployment: shared core, desktop and web targets, staging). Each has a passing
  requirements checklist.
- `.env.example` and `bun run keys:check`, which verifies OpenRouter, OpenAI, Anthropic, Gemini and a
  configurable Meta endpoint without printing key material.
- Spec 011 plan and task list: provider registry and capability rules, a credential vault with desktop
  and web adapters, OpenRouter PKCE connection, API-key validation for four providers, the ChatGPT plan
  phase gated on D-102, model selection and runtime wiring, cost labelling and error recovery, and the
  web-enablement phase gated on spec 010. Forty-two tasks across nine phases.
- ADR 0007 picks the Vercel AI SDK 7 `ToolLoopAgent` with the OpenRouter provider as the agent runtime
  (rejecting the OpenRouter Agent SDK, OpenAI Agents SDK and Claude Agent SDK); ADR 0008 makes the
  one-way import through the export file.
- Spec Kit initialised for OpenCode with the `git`, `agent-context`, `bug` and `assess` extensions;
  `/speckit-*` commands are available in `.opencode/commands/`.

## [0.1.0] — 2026-10-24

The first foundation: a local-first studio that opens a folder of files, writes chapters atomically,
and shows them in the Liquid Glass interface from the design kit. No agent, exports or packaging yet.

### Added

- Electron 45 application scaffolded with electron-vite, React 19, Tailwind 4 and TypeScript.
- Library format: `book.json` per book, one Markdown file per chapter with YAML front matter, and a
  derived `library.json` catalog that is never read as truth.
- `Library` store with create/read/update for books, chapters and chapter metadata; chapter order,
  slugged file names, deterministic fallback ids for files written by other tools.
- Atomic writes (temp file, fsync, rename, retry for Windows sharing violations) and per-book write
  serialization.
- Optimistic concurrency: every save carries the version and SHA-256 hash it was based on. A newer
  version or an edited file produces a conflict copy in `conflicts/` instead of an overwrite.
- Draft buffer in the main process, flushed on window close and on quit.
- Deleted chapters move to `.studio/trash/<bookId>/` rather than being unlinked.
- Schema versioning that refuses files from a newer app with an explicit "update the app" error.
- Typed IPC contract (`src/shared/ipc.ts`) with a `Result` envelope and Zod validation on every
  channel; context isolation, sandboxed renderer and a restrictive CSP.
- Design tokens generated from the local design kit (`design/tokens.json` → 38 primitives,
  96 semantic colors) plus the glass, window-wash and manuscript styles.
- Welcome, Library and Workspace views: 248 px chapter rail, 760 px manuscript sheet, save status,
  conflict banner with "Show the saved copy" and "Load the version on disk", theme cycle.
- 13 Vitest tests covering the format, atomic saves, conflicts, trash, schema rejection and path
  safety.
- electron-builder configuration for macOS (dmg, zip), Windows (nsis) and Linux (AppImage), with
  hardened-runtime entitlements.

### Notes

- This repository starts fresh. It replaces an earlier local prototype and shares no history, no
  Next.js server and no localStorage library.
