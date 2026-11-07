# Specs

Each directory is one feature: `spec.md` (why and what), `plan.md` (how), `tasks.md` (ordered work,
`[x]` when done). See ADR 0005 for the process and `.specify/memory/constitution.md` for the rules
every spec must satisfy.

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
| [011](011-model-access/spec.md) | Model access: OpenRouter SSO, provider keys, ChatGPT plan, usage | In progress — Phases 1–4, selection, model picker, transport, usage records, per-turn model override and metadata, credential safety and the first writing-agent loop implemented; browser credential vault, disclosure and OpenRouter sign-in added; informational spending hooks (T036) implemented with D-116 still Proposed; live browser-access pass T040/T041 remains; [plan](011-model-access/plan.md), [tasks](011-model-access/tasks.md) |
| [012](012-automated-verification/spec.md) | Automated verification: unit, contract, end-to-end, live provider checks ([plan](012-automated-verification/plan.md), [tasks](012-automated-verification/tasks.md)) | In progress — 560+ Bun tests, `bun run e2e` (7 checks: smoke, web, audit, glasses, ambient, plugins, bridge), the accessibility pass in the audit, the live provider check and `submission:check`; lint, coverage, performance, security, a CI runner and release gates remain |
| [013](013-builds-and-deployment/spec.md) | Builds and deployment: shared core, desktop and web builds, staging | In progress — web shell built and smoke-tested; build metadata, capability table, environments, runbook and CI workflow added; `packages/ui` carries the primitives and stylesheet, `packages/app` the shared shell, and T014's light/dark gallery is measured; [plan](013-builds-and-deployment/plan.md), [tasks](013-builds-and-deployment/tasks.md) |
| [014](014-mobile/spec.md) | Mobile: iPhone and iPad mini layouts, Capacitor shell ([plan](014-mobile/plan.md), [tasks](014-mobile/tasks.md)) | Implemented — responsive layouts, Capacitor shell, touch-target audit, iPad mini rotation and accessibility pass complete; signing/real-device distribution remains; depends on 010/013 |
| [016](016-sync/spec.md) | Sync and device trust: two-device folders, drift detection, local app lock ([plan](016-sync/plan.md), [tasks](016-sync/tasks.md), [research](016-sync/research.md)) | In progress — journal, read-only drift detector, library scan, two-system harness and docs (T001–T005, T013) implemented; drift report dialog and Settings section (T006–T007) implemented on the recommended baseline; lock waits on D-121, device identity on D-124 |
| [017](017-voice-and-background/spec.md) | Voice notes and background runs: Muse Voice Transcribe dictation, WAV conversion, background turns and native notifications ([plan](017-voice-and-background/plan.md), [tasks](017-voice-and-background/tasks.md)) | Implemented — voice service, WAV validation/conversion, editor insertion, background outcome callback, notification copy and tests; the live Meta-key/manual pass (T012) is pending |
| [018](018-agent-toolkit/spec.md) | Agent toolkit: standalone `bookwriter` CLI, MCP server and the loopback backend ([plan](018-agent-toolkit/plan.md), [tasks](018-agent-toolkit/tasks.md)) | Implemented — loopback backend with per-run token, CLI read/write commands, read-only MCP server with opt-in writes and tests; the manual desktop/MCP pass (T011) ran against a real backend and MCP client with reads verified on disk |
| [019](019-illustrations/spec.md) | Illustrations: `images.json`, the image store and Muse Image generation ([plan](019-illustrations/plan.md), [tasks](019-illustrations/tasks.md)) | In progress — manifest schema, atomic image store, Muse Image service, IPC, editor attachment and DOCX embedding implemented; the live-key manual pass remains |
| [020](020-sam-cutout/spec.md) | SAM 3.1 character cutouts: concept prompts, mask parsing and transparent PNGs ([plan](020-sam-cutout/plan.md), [tasks](020-sam-cutout/tasks.md)) | **Superseded by D-158** — a live request is accepted and returns nothing, so the implementation was removed from the build on 2026-11-04 |
| [021](021-product-film/spec.md) | Product film and voiceover: three-minute master, social cuts, narration and motion plates ([plan](021-product-film/plan.md), [tasks](021-product-film/tasks.md)) | In progress — brand review, script, storyboard, `film:fixture` generator and the eight Playwright motion plates are done; capture, voice, music and edit remain |
| [022](022-provider-compatibility/spec.md) | Provider compatibility and the Contributor test model: one AI SDK seam, Muse Spark 1.3 Contributor facts and book-level training consent ([plan](022-provider-compatibility/plan.md), [tasks](022-provider-compatibility/tasks.md)) | Implemented — adapter registry, catalogue presets, Contributor guard, picker warning/checkbox and tests; the live Contributor pass waits on a Meta key |
| [023](023-submission/spec.md) | Submission package: sample library, packet, secret scan and readiness check ([plan](023-submission/plan.md), [tasks](023-submission/tasks.md)) | In progress — sample library, `hackathon/SUBMISSION.md`, `submission:check` and sample tests added; clean-clone pass recorded and pre-deadline re-check recorded 2026-11-03 (T007/T008); public visibility, video links and form submission remain |
| [024](024-agent-tool-parity/spec.md) | Tool parity: the studio's own writing tools over the loopback backend and the MCP server, plus a UI audit ([plan](024-agent-tool-parity/plan.md), [tasks](024-agent-tool-parity/tasks.md)) | In progress — the catalog, the bridge, the backend routes, the MCP mirror, the CLI commands and the end-to-end test are done; two interface dead ends are fixed |
| [025](025-agent-capabilities/spec.md) | Agent capabilities: cacheable prompt prefix and hit rate, per-tool metrics, per-book tool control, `SKILLS.md` and a plugin folder of TypeScript tools ([plan](025-agent-capabilities/plan.md), [tasks](025-agent-capabilities/tasks.md)) | Implemented — the cache prefix, the metrics log, the withdrawn-tool filter across the model, the backend and MCP, the skills file, the plugin loader and the agent panel are done; a live cache hit rate needs a provider that reports one |
| [026](026-glasses/spec.md) | The glasses: the same backbone, a second surface — WebMCP and the Meta AI connector shapes for the studio's tool catalog ([plan](026-glasses/plan.md), [tasks](026-glasses/tasks.md)) | In progress — the WebMCP and connector renderings, the toolkit's `--format` flags, the connector application note and the TOOLKIT surfaces record are done; the web app, the origin allowance and the real-glasses run remain |
| [028](028-integration-health/spec.md) | Integration health: one derived state per location and per provider, and a single warning component with a severity and a safe action ([plan](028-integration-health/plan.md), [tasks](028-integration-health/tasks.md)) | In progress — pure location/provider health derivations, shared copy and severity-aware Notice are implemented and fixture-tested; provider/location UI, placeholder-save block and read-only location probes remain |
| [029](029-manuscript-import/spec.md) | Manuscript-file import ([plan](029-manuscript-import/plan.md), [tasks](029-manuscript-import/tasks.md)) | Draft — desktop UTF-8 TXT/Markdown and Word (DOCX, D-183) import implemented with staged atomic publication and hidden-smoke conformance on macOS; ODT validated but unenabled, DOC/RTF refused, browser/mobile specified and refused; Windows/Linux conformance remains open |
| [030](030-story-bible-extensions/spec.md) | Story Bible extensions ([plan](030-story-bible-extensions/plan.md), [tasks](030-story-bible-extensions/tasks.md)) | Draft / Planned — book-scoped manual records proposed; storage, revision/conflict, identity and field-limit decisions remain open |
| [031](031-agent-interaction/spec.md) | Agent interaction and guidance ([plan](031-agent-interaction/plan.md), [tasks](031-agent-interaction/tasks.md)) | Draft / Planned — Discuss read-tool policy (D-177), pause/continuation semantics (D-178), and in-flight guidance (D-179) proposed, research recorded, awaiting acceptance; interaction contract fields (T004) and tone/answer-length settings UI (T010) implemented |
| [032](032-chapter-history/spec.md) | Chapter history: named saved-text snapshots ([plan](032-chapter-history/plan.md), [tasks](032-chapter-history/tasks.md)) | Draft / Planned — storage layout (D-175) and retention (D-176) proposed, research recorded, awaiting acceptance; persistence tasks remain blocked |
| [033](033-library-organization/spec.md) | Library organization, goals and source-anchored notes ([plan](033-library-organization/plan.md), [tasks](033-library-organization/tasks.md)) | Draft / Planned — per-data storage/versioning, collection identity and source-anchor decisions remain open |
| [034](034-manuscript-review/spec.md) | Manuscript review: evidence-linked report on saved text ([plan](034-manuscript-review/plan.md), [tasks](034-manuscript-review/tasks.md)) | Draft / In progress — report entry and view, save gate, volatility, stale/cancel/insufficient states and evidence plumbing are built and fixture-tested on desktop; metric and host decisions recorded 2026-11-03 (word count first, phrase signal deferred; desktop first), report save/export/retention proposed in D-171 (research recorded, awaiting acceptance), and conversational review is separate in 037 |
| [035](035-book-formatting/spec.md) | Book formatting and export ([plan](035-book-formatting/plan.md), [tasks](035-book-formatting/tasks.md)) | In progress — Phase 1 Format journey (target selector, typography binding, approximate preview) implemented and contract-tested; DOCX boundary (T004–T005) done; D-108 accepted, so all four targets export; D-169 and D-170 accepted (2026-11-04), and ordered front and back matter (T007–T013) is edited in the Format dialog and exported by all four targets; the Markdown folder export (T014) and the remaining publication work remain open |
| [036](036-task-aware-model-routing/spec.md) | Task-aware model routing ([plan](036-task-aware-model-routing/plan.md), [tasks](036-task-aware-model-routing/tasks.md)) | Draft / In progress — the offline preview slice (T007 evaluation, T008 presentation, T009 surface, T010 neutrality, T011 states, T012 call/credential spies, T013 consent regression, T014 access pass) implemented and fixture-tested with no settled taxonomy; totals, selection integration and dispatch remain gated; D-116 is still Proposed, and no dispatch is authorized |
| [037](037-guided-autonomous-authoring/spec.md) | Guided and autonomous authoring ([plan](037-guided-autonomous-authoring/plan.md), [tasks](037-guided-autonomous-authoring/tasks.md)) | Draft / Planned — foreground read-only review proposed; autonomous authority and lifecycle remain gated; D-126 remains one-turn opt-in only |
| [038](038-voice-options/spec.md) | Voice provider and speaking options ([plan](038-voice-options/plan.md), [tasks](038-voice-options/tasks.md), [research](038-voice-options/research.md)) | In progress — isolated candidate adds profile-local choices, curated transcription and speaking catalogs, Settings controls, explicit provider requests and browser refusals; integration and forward-port verification remain pending |
| [039](039-reader-continuity-review/spec.md) | Structured reader and continuity review ([plan](039-reader-continuity-review/plan.md), [tasks](039-reader-continuity-review/tasks.md)) | Draft / Planned — scoped reader profiles, verified findings and explicit rereads; retention and schema decisions open |
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
- **Implemented** — tasks complete, tests pass, changelog updated.
- **Superseded** — replaced by another spec; keep the file, link the replacement.

## Retroactive specs

`001-foundation` was written after the code, to give the repository a complete record from its first
commit. It is held to the same standard as any other spec: requirements, acceptance criteria,
non-goals, and tasks that actually correspond to the code.

## Follow-on scope

The [completion spec map and DAG](../docs/SPEC-DAG.md) assign all 15 distilled requirements and all
25 completion lanes to existing or new specs. New drafts do not accept decisions or prove features.
038 is reserved, not a broken link or an invitation to recreate the voice-options candidate.

Specs 029–037 record public proposals for additional product capabilities. They remain Draft/Planned
until their applicable decisions are accepted and implementation and verification are completed.
Existing intent in spec 002 is not implementation evidence: 029 remains distinct from the legacy
migration in 003 and portable archive in 010; 035 distinguishes the broader export intent from the
current DOCX behavior. Specs 034 and 037 define separate structured-report and conversational-review
journeys.
