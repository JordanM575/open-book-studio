# Specs

Each directory is one feature: `spec.md` (why and what), `plan.md` (how), `tasks.md` (ordered work,
`[x]` when done). See ADR 0005 for the process and `.specify/memory/constitution.md` for the rules
every spec must satisfy.

Status reconciled November 9, 2026 against public `main` at `0fc19f3` (PR #45), plus explicitly
labelled candidate contracts and accepted ADRs 0019–0021. See the
[dated verification evidence](../docs/TESTING.md#recorded-baseline) and
[remaining-work sequence](../docs/PRODUCT-COMPLETION.md#next-work). The
[foundation register](../docs/FOUNDATION-EVIDENCE.md) attributes exact heads, merges and public
receipts, including their limits. A merged implementation, an accepted decision, an automated pass,
independent acceptance and release approval are separate facts.
The [concurrent delivery DAG](../docs/CONCURRENT-DELIVERY.md) records active-slot policy, package
dependencies, decision gates and coverage of all retained features.

| Spec | Title | State |
| --- | --- | --- |
| [001](001-foundation/spec.md) | Foundation: library, format, editor | Implemented (retroactive) |
| [002](002-studio-v1/spec.md) | AI Book Studio v1: the whole product, white-room | In progress (current) — library, editor, Story Bible, provider connections, a first agent loop, Word export, legacy import and book search |
| [003](003-earlier-studio-import/spec.md) | Earlier studio import: an export into the new library | In progress — backup parser, importer, library import button and tests |
| 004 | Story Bible: returnable planning, cast, outline, memories | Folded into 002 |
| 005 | Writing agent: runtime, keychain, tool edits, checkpoints | Folded into 002 |
| 006 | Index: SQLite cache for search, conversations and usage | Folded into 002 |
| 007 | Export: DOCX, PDF and EPUB with KDP settings | Folded into 002 |
| 008 | Sync surface: conflict review, device names, library health | Folded into 002 |
| [009](009-packaging-release/spec.md) | Packaging and release: signing, notarisation, updates and installed-product lifecycle ([plan](009-packaging-release/plan.md), [tasks](009-packaging-release/tasks.md)) | Draft — machine release record, unsigned-path audit, artifact scan, release checklist and build-metadata identity implemented (T001–T004, T026); signing, notarisation and online updates remain gated by D-115; whether it also gates user-driven local install/upgrade is proposed in D-172 (research recorded, awaiting acceptance) |
| [010](010-web-target/spec.md) | Browser target: local libraries and portable storage ([plan](010-web-target/plan.md), [tasks](010-web-target/tasks.md)) | In progress — shared library service, desktop port, portable archive, browser storage/archive I/O, save-failure tests and web smoke journeys implemented; folder/permission journeys and archive import picker covered by tests; Playwright Chromium passes the real storage harness 16/16, with Firefox/WebKit OPFS findings; native folder-picker matrix remains (shared UI extraction landed in 013) |
| [011](011-model-access/spec.md) | Model access: OpenRouter SSO, provider keys, ChatGPT plan, usage | In progress — connections, picker, usage, vault and browser sign-in exist; T036 remains informational. D-116 now selects bounded operations versus qualified strict money; enforcement/adapter qualification and live browser access remain; [plan](011-model-access/plan.md), [tasks](011-model-access/tasks.md) |
| [012](012-automated-verification/spec.md) | Automated verification: unit, contract, end-to-end, live provider checks ([plan](012-automated-verification/plan.md), [tasks](012-automated-verification/tasks.md)) | In progress — lint, coverage, performance, security, accessibility/visual, hidden smoke and e2e gates implemented; November 7 integrated macOS baseline: 2,280 tests, smoke 47/47. Linux verify/e2e pass and both fail the manual workflow on failure; enforced merge gating, Gitea runner and remaining opt-in/live/manual evidence stay open |
| [013](013-builds-and-deployment/spec.md) | Builds and deployment: shared core, desktop and web builds, staging | In progress — web shell built and smoke-tested; build metadata, capability table, environments, runbook and CI workflow added; `packages/ui` carries the primitives and stylesheet, `packages/app` the shared shell, and T014's light/dark gallery is measured; [plan](013-builds-and-deployment/plan.md), [tasks](013-builds-and-deployment/tasks.md) |
| [014](014-mobile/spec.md) | Mobile: iPhone and iPad mini layouts, Capacitor shell ([plan](014-mobile/plan.md), [tasks](014-mobile/tasks.md)) | In progress — responsive layouts and Capacitor web shell, touch-target audit and scoped iPad mini Simulator rotation/accessibility checks are recorded; native iOS storage, protected credentials, lifecycle, permissions and capability/refusal integration remain open in T019–T027. D-117 is proposed; native Simulator, separately authorized real-device and release evidence remain distinct; depends on 010/013 |
| [016](016-sync/spec.md) | Sync and device trust: two-device folders, drift detection, local app lock ([plan](016-sync/plan.md), [tasks](016-sync/tasks.md), [research](016-sync/research.md)) | In progress — journal, read-only drift detector, library scan, two-system harness and docs (T001–T005, T013) implemented; drift report dialog and Settings section (T006–T007) implemented on the recommended baseline; lock waits on D-121, device identity on D-124 |
| [017](017-voice-and-background/spec.md) | Voice notes, background runs and hands-free sessions ([plan](017-voice-and-background/plan.md), [tasks](017-voice-and-background/tasks.md)) | In progress — T016 delivered at source/test level (synthetic evidence); T017 hands-free and device/packaged evidence remain open. D-200/ADR 0021 selects bound sessions, interruption, confirmation, local input and reading. T013–T024 track expansion; generated-audio tests do not establish actual microphone/acoustic evidence |
| [018](018-agent-toolkit/spec.md) | Agent toolkit: standalone `bookwriter` CLI, MCP server and the loopback backend ([plan](018-agent-toolkit/plan.md), [tasks](018-agent-toolkit/tasks.md)) | Implemented — loopback backend with per-run token, CLI read/write commands, read-only MCP server with opt-in writes and tests; the manual desktop/MCP pass (T011) ran against a real backend and MCP client with reads verified on disk |
| [019](019-illustrations/spec.md) | Illustrations: `images.json`, the image store and Muse Image generation ([plan](019-illustrations/plan.md), [tasks](019-illustrations/tasks.md)) | In progress — manifest schema, atomic image store, Muse Image service, IPC, editor attachment and DOCX embedding implemented; the live-key manual pass remains |
| [020](020-sam-cutout/spec.md) | SAM 3.1 character cutouts: concept prompts, mask parsing and transparent PNGs ([plan](020-sam-cutout/plan.md), [tasks](020-sam-cutout/tasks.md)) | **Superseded by D-158** — a live request is accepted and returns nothing, so the implementation was removed from the build on 2026-11-04 |
| [021](021-product-film/spec.md) | Product film and voiceover: three-minute master, social cuts, narration and motion plates ([plan](021-product-film/plan.md), [tasks](021-product-film/tasks.md)) | In progress — original submission published; later captures, Weston narration and edits exist, and the author supplied the current README demo link on November 7. Remaining cuts/captions/credits and exact-upload acceptance need artifact reconciliation |
| [022](022-provider-compatibility/spec.md) | Provider compatibility and the Contributor test model: one AI SDK seam, Muse Spark 1.3 Contributor facts and book-level training consent ([plan](022-provider-compatibility/plan.md), [tasks](022-provider-compatibility/tasks.md)) | Implemented — adapter registry, catalogue presets, Contributor guard, picker warning/checkbox and tests; the live Contributor pass waits on a Meta key |
| [023](023-submission/spec.md) | Submission package: sample library, packet, secret scan and readiness check ([plan](023-submission/plan.md), [tasks](023-submission/tasks.md)) | Submitted — packet records public repository, original video and pre-deadline portal confirmation at `f3541f6`; sample/clean-clone evidence retained. Remaining private-window, captions and short-cut checks are not closed by the newer README link |
| [024](024-agent-tool-parity/spec.md) | Tool parity: the studio's own writing tools over the loopback backend and the MCP server, plus a UI audit ([plan](024-agent-tool-parity/plan.md), [tasks](024-agent-tool-parity/tasks.md)) | In progress — the catalog, the bridge, the backend routes, the MCP mirror, the CLI commands and the end-to-end test are done; two interface dead ends are fixed |
| [025](025-agent-capabilities/spec.md) | Agent capabilities: cacheable prompt prefix and hit rate, per-tool metrics, per-book tool control, `SKILLS.md` and a plugin folder of TypeScript tools ([plan](025-agent-capabilities/plan.md), [tasks](025-agent-capabilities/tasks.md)) | Implemented — the cache prefix, the metrics log, the withdrawn-tool filter across the model, the backend and MCP, the skills file, the plugin loader and the agent panel are done; a live cache hit rate needs a provider that reports one |
| [026](026-glasses/spec.md) | The glasses: the same backbone, a second surface — WebMCP and the Meta AI connector shapes for the studio's tool catalog ([plan](026-glasses/plan.md), [tasks](026-glasses/tasks.md)) | In progress — manifests, toolkit flags, same-origin status page and 600×600 browser/stub-assistant checks implemented; phone companion, approved transport and real-glasses acceptance remain |
| [028](028-integration-health/spec.md) | Integration health: one derived state per location and per provider, and a single warning component with a severity and a safe action ([plan](028-integration-health/plan.md), [tasks](028-integration-health/tasks.md)) | In progress — derived health/Notice, library health, explicit-test provider status, configured voice availability and placeholder-save preservation implemented; real-folder probes remain author-gated |
| [029](029-manuscript-import/spec.md) | Manuscript-file import ([plan](029-manuscript-import/plan.md), [tasks](029-manuscript-import/tasks.md)) | Draft — desktop UTF-8 TXT/Markdown and Word (DOCX, D-183) import implemented with staged atomic publication and hidden-smoke conformance on macOS; ODT validated but unenabled, DOC/RTF refused, browser/mobile specified and refused; Windows/Linux conformance remains open |
| [030](030-story-bible-extensions/spec.md) | Story Bible extensions ([plan](030-story-bible-extensions/plan.md), [tasks](030-story-bible-extensions/tasks.md)) | In progress — worldbuilding/goal Library/API/Workspace integration and #44 manual recovery corrections are merged under ADR 0017; built-adapter/native and full Bible/series/relationships/templates/generated planning acceptance remain |
| [031](031-agent-interaction/spec.md) | Agent interaction and guidance ([plan](031-agent-interaction/plan.md), [tasks](031-agent-interaction/tasks.md)) | Delivered at the source/test level — T001–T021 are checked: Discuss/Edit and guidance, the proposed-plan guidance refresh, the visible plan lifecycle, pause/resume, cancel, restart expiry, the failure matrix, accessibility and the synthetic author journey. Live provider, real manuscript, device, packaged-build and release acceptance remain separate. ADR 0019's durable workflow is distinct from ordinary restart-expiring plans |
| [032](032-chapter-history/spec.md) | Chapter history: named saved-text snapshots ([plan](032-chapter-history/plan.md), [tasks](032-chapter-history/tasks.md)) | In progress — saved-only history in #33 and checked restore/undo core plus isolated injected UI in #34 are merged. The [#34 body](https://github.com/JordanM575/open-book-studio/pull/34) attributes acceptance/gates to `56c7b7d`; reviewed host/editor contracts, draft gates, validated API/Workspace mounting, confirmation/recovery and retention remain |
| [033](033-library-organization/spec.md) | Library organization, goals and source-anchored notes ([plan](033-library-organization/plan.md), [tasks](033-library-organization/tasks.md)) | In progress — saved-word goal integration and #44 manual planning/recovery corrections are merged; built-adapter/native acceptance, collections/scoped recents and complete source-note journeys remain |
| [034](034-manuscript-review/spec.md) | Manuscript review: evidence-linked report on saved text ([plan](034-manuscript-review/plan.md), [tasks](034-manuscript-review/tasks.md)) | In progress — repetition scanner/navigation merged in #45 with lazy selected-evidence verification and expressly unverified worker aggregates. T016 passed all six manuscript review controls in official unpackaged macOS smoke. T018 inline viewing and T019 retained reports remain open, along with packaged and other-host evidence |
| [035](035-book-formatting/spec.md) | Book formatting and export ([plan](035-book-formatting/plan.md), [tasks](035-book-formatting/tasks.md)) | In progress — Phase 1 Format journey (target selector, typography binding, approximate preview) implemented and contract-tested; DOCX boundary (T004–T005) done; D-108 accepted, so all four targets export; D-169 and D-170 accepted (2026-11-04), and ordered front and back matter (T007–T013) is edited in the Format dialog and exported by all four targets; the Markdown folder contract is recorded by [D-202](../docs/DECISIONS.md#d-202--markdown-folder-export-pure-planner-contract-and-saved-source-bundle) with [its folder format](../docs/formats/markdown-folder.md); the Markdown folder export is implemented and exposed on the desktop local-folder target; T014 remains open pending T016/T017/T019, as do replacement of an existing folder and other destination classes |
| [036](036-task-aware-model-routing/spec.md) | Task-aware model routing ([plan](036-task-aware-model-routing/plan.md), [tasks](036-task-aware-model-routing/tasks.md)) | In progress — D-204–D-207 accept three author-selected writing-task profiles requiring tools and a known catalogue context, no ranking or single suggestion, no request-size estimator or total cost, and only a two-step handoff to the existing one-turn picker. T016's narrow author-chosen-candidate handoff is delivered at the source/test level (implementation `eb876f0`, exact-head review ACCEPT, merged `a246d5d` via PR #118); the preview is mounted from the writing-agent composer and consumes only catalogues the explicit picker already loaded. T015/T017 and T018's total are deliberately not selected; T019 remains unchecked. No live/packaged/provider claim; separate workflow routing remains open |
| [037](037-guided-autonomous-authoring/spec.md) | Guided and autonomous authoring ([plan](037-guided-autonomous-authoring/plan.md), [tasks](037-guided-autonomous-authoring/tasks.md)) | In progress — checked v1 threads, pure graph/admission and #43 workflow storage are merged under D-193–D-196. Host permission, durable admission, scheduling, execution, onboarding/adoption, recovery and separate full-book/quality acceptance remain in T018–T042; T023 is partial |
| [038](038-voice-options/spec.md) | Voice provider and speaking options ([plan](038-voice-options/plan.md), [tasks](038-voice-options/tasks.md), [research](038-voice-options/research.md)) | In progress — implementation merged in PR #26 under D-192: profile-local choices, model-specific catalogs, Settings, explicit requests and browser refusals. Automated integrated results recorded; T022 remains unchecked at author direction, and live acceptance is separate |
| [039](039-reader-continuity-review/spec.md) | Structured reader and continuity review ([plan](039-reader-continuity-review/plan.md), [tasks](039-reader-continuity-review/tasks.md)) | In progress — editor/evidence, saved-record controls/recovery and pure all-range planner foundations are merged under D-193/D-197–D-199. T003/T004/T005/T008 are delivered at the source/test level: disclosed volatile selected-source prepare/start with the accepted U-039-04 bounds, then exact schema/quotation validation, withheld citations, explicit source check, citation navigation and stale/unavailable states, then volatile per-run profile/provider/model/connection attribution with an append-only attempt history and explicit comparison of the latest two completed runs, then the read-only enforcement proof (whole-tree fingerprints, injection corpus, static boundary scan). T009 passed five desktop cases and the built-web refusal on matching unpackaged macOS artifacts. T006 and T010–T019 remain open. T006 still carries U-039-04 |
| [040](040-android/spec.md) | Android product target ([plan](040-android/plan.md), [tasks](040-android/tasks.md)) | Draft / Planned — storage, credentials, lifecycle and release matrix need Android-specific decisions/evidence |
| [041](041-cover-design/spec.md) | Book-level cover design ([plan](041-cover-design/plan.md), [tasks](041-cover-design/tasks.md)) | Draft / Planned — composition, source preservation and measurable target output; storage/output decisions open |
| [042](042-audiobook-casting/spec.md) | Narrator and character casting with audiobook creation ([plan](042-audiobook-casting/plan.md), [tasks](042-audiobook-casting/tasks.md)) | Draft / Planned — stock casting, explicit chapter generation, recovery and packaging; authority/storage/output decisions open |

Spec numbers 004–008 were reserved in the foundation roadmap and are now requirements inside
[002](002-studio-v1/spec.md) rather than separate specs, because the white-room specification covers
them as one product. Numbers are not reused.

The browser build is 010 on purpose: it depends on the core/port split in ADR 0009, which is a refactor
of 001, and on the storage-tier requirements added to 002 as FR-071…FR-076. Specs 011–013 are the
hackathon delivery track: model access, the verification suite and the two build targets. They refine
002 rather than replace it; where they disagree, the newer spec wins and 002 is amended. The agent harness runtimes
(`@ai-sdk/harness`) are deferred in ADR 0007 rather than given a spec number; no work is planned until a
local sandbox and a stable API exist.

Agent coverage is audited in [`docs/AGENTIC-COVERAGE.md`](../docs/AGENTIC-COVERAGE.md): 002 and 011
cover a v1 writing assistant, not the full agentic suite. The audit lists the implemented requirements,
the specified-but-missing ones and the behaviour no spec has decided. The harness and interface phases are in the specification set.

## Status vocabulary

- **Planned** — spec exists, not started.
- **In progress** — tasks being executed; `tasks.md` shows what remains.
- **Implemented** — the named implementation scope exists with tests and a changelog entry; any
  remaining live/manual/platform acceptance is listed explicitly and stays open in `tasks.md`.
- **Superseded** — replaced by another spec; keep the file, link the replacement.

## Retroactive specs

`001-foundation` was written after the code, to give the repository a complete record from its first
commit. It is held to the same standard as any other spec: requirements, acceptance criteria,
non-goals, and tasks that actually correspond to the code.

## Follow-on scope

The [completion spec map and DAG](../docs/SPEC-DAG.md) assign all 19 distilled requirements and all
25 completion lanes to existing or new specs. New drafts do not accept decisions or prove features.
038 is now integrated; it owns general voice preferences and is reused by the proposed audiobook
work rather than recreated. 039 is In progress; 040–042 remain Draft/Planned with all tasks unchecked.
[Retained follow-through](../docs/RETAINED-DELIVERY.md) owns original capabilities beyond the small first slices.

Specs 029–037 mix implemented slices, accepted decisions and still-proposed capabilities; use the
individual status and task list rather than treating the whole range as unbuilt or complete.
Existing intent in spec 002 is not implementation evidence: 029 remains distinct from the legacy
migration in 003 and portable archive in 010; 035 distinguishes the broader export intent from the
current four-target export behavior. Specs 034 and 037 define separate structured-report and conversational-review
journeys.
