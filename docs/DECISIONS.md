# Decision record

Every decision that shapes the product is written down before it is built. This file is the index and
the working register; an Architecture Decision Record in [`adr/`](adr/) is written when a decision is
significant, hard to reverse, or likely to be relitigated.

**Rule:** a spec may depend only on a decision that is `Accepted` or on an assumption listed in the
spec's Assumptions section. An `Open` decision blocks the task that needs it, not the whole spec.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `Open` | A question exists; nobody has chosen. Research may be needed first. |
| `Researching` | Someone is gathering evidence; the decision is not made. |
| `Proposed` | A recommendation exists with its alternatives; awaiting acceptance. |
| `Accepted` | Chosen. Implementations may rely on it. |
| `Deferred` | Deliberately not decided now; the trigger for revisiting is written down. |
| `Superseded` | Replaced; the old entry stays and links forward. |

## Settled decisions

| ID | Decision | Record |
| --- | --- | --- |
| D-001 | Local-first Electron application; the main process owns files | ADR 0001 |
| D-002 | Markdown plus YAML front matter per chapter; SQLite is a derived index | ADR 0002, `docs/FORMAT.md` |
| D-003 | Sync through a folder the author chooses; conflict copies, no server | ADR 0003 |
| D-004 | Design tokens are vendored and compiled, never hand-copied | ADR 0004 |
| D-005 | Spec before code; ADRs for hard-to-reverse choices | ADR 0005 |
| D-006 | AI calls and secrets live in the main process | ADR 0006 |
| D-007 | Agent runtime is Vercel AI SDK 7 `ToolLoopAgent`; harness runtimes deferred | ADR 0007 |
| D-008 | Importing an earlier studio's export is one-way and file-based | ADR 0008 |
| D-009 | One core over a storage port; Electron, Chromium folders and browser storage are adapters | ADR 0009 |
| D-010 | Bun is package manager, task runner and test runner; Electron keeps Node | ADR 0010 |
| D-011 | Paragraphs are lines; no 66-character virtual wrap | spec 002 Assumptions |
| D-012 | Agent edits apply during a turn and the turn is one undo; no Apply/Reject cards | spec 002 Assumptions |
| D-013 | No emoji in application copy | spec 002 Assumptions |
| D-014 | One illustration per chapter on its own page, plus separate image files | spec 002 Assumptions |
| D-015 | No telemetry, ever | Constitution, FR-061 |
| D-016 | Fresh repository, inherited app archived rather than forked | CHANGELOG `[Unreleased]` |
| D-104 | OpenRouter web sign-in uses same-origin OAuth callback with PKCE and checked state | ADR 0011 |
| D-105 | Browser credentials use disclosed origin-scoped storage; no passphrase or encryption claim in v1 | ADR 0011 |
| D-112 | Portable libraries use a versioned, hash-validated ZIP archive; import never merges silently | ADR 0012 |
| D-114 | Bun tests core/adapters; Playwright on Node for browser and Electron E2E; live-provider tests opt in | spec 012 |
| D-161 | Provider settings shows each connection's status from the author's last explicit Test only, with a volatile check time that clears when Settings closes; opening Settings never probes. Voice shows configured availability from `voice.connections()`/`voice.speakers()` with no check time and states it is never tested automatically. A stored health fact would need its own sync (FR-001), background checks would violate the no-background-network-call non-goal, and probing voice via TTS/transcribe would send author text or audio. The protected-storage availability read on open is awaited, but for at most 2 seconds; an answer that has not arrived, or that fails, reads as unavailable and points at Check keychain. | spec 028 |
| D-162 | Biome is the configured linter; `bun run lint` fails on errors and runs first in `verify`. Warnings stay advisory debt, headed by non-null assertions; suppressions name the reason and sit on the diagnostic line. | spec 012 T002 |

## Open decisions

These are the questions we already know we cannot answer by assumption. Each one names the evidence
needed and the spec or task it blocks.

### D-101 · Browser access per model provider

| | |
| --- | --- |
| **Status** | Researching |
| **Question** | Which providers can the web build call directly, with the author's key, without a proxy? |
| **Known** | OpenRouter: yes, verified CORS. OpenAI: no (preflight fails). Anthropic: only with `anthropic-dangerous-direct-browser-access`. Gemini and Meta: unverified. |
| **Needed** | A repeatable browser-access check per provider, run from the built web app, recorded with date and result. |
| **Blocks** | spec 011 tasks for web provider adapters; spec 010 provider UI |
| **Owner** | spec 011 |

### D-102 · Sign in with ChatGPT eligibility and licence

| | |
| --- | --- |
| **Status** | Researching |
| **Question** | May this app ship the `@siwc/*` devkit, and does the hackathon build qualify as an eligible project? |
| **Known** | Devkit exists with Electron support; eligibility covers open-source and local personal projects, selected private apps, and identity-only partnerships. Paid or hosted use needs OpenAI approval. |
| **Needed** | Licence review, eligibility answer from OpenAI, and a decision on whether desktop-only ChatGPT access ships in v1. |
| **Blocks** | spec 011 ChatGPT story; credentials UI |
| **Owner** | spec 011 |

### D-103 · Meta and Gemini endpoints

| | |
| --- | --- |
| **Status** | Researching |
| **Question** | Which Meta API endpoint and model family is current, and does Gemini's API allow browser calls? |
| **Known** | `api.llama.com` was shut down in July 2026; `dev.meta.ai` exists. Google's browser guidance assumes a proxy. |
| **Needed** | Current official docs, a live probe with a key, and a capability entry rather than a hard-coded base URL. |
| **Blocks** | spec 011 provider registry entries |
| **Owner** | spec 011 |

### D-106 · Bun workspaces with electron-vite and electron-builder

| | |
| --- | --- |
| **Status** | Accepted |
| **Question** | Does `bun install` plus workspace linking survive electron-vite's dependency externalisation and electron-builder's packaging on macOS? |
| **Evidence** | `bun install` linked `@ai-book-studio/core` into the desktop app; electron-vite bundled the core package with no unresolved import; `bun run package:dir` produced `release/mac-arm64/AI Book Studio.app` (unsigned, default icon) and the packaged binary passed all five hidden smoke checks, including a save reaching disk. electron-builder warned that it could not read Bun's dependency tree, then used its file-traversal collector successfully. |
| **Decision** | Keep Bun as package manager and task runner, Electron as the desktop runtime, and electron-builder on Node. Record `trustedDependencies` for Electron; check for the binary in `scripts/check-electron.mjs`. |
| **Blocks** | spec 013 T001–T012 (done) |

### D-107 · Index engine per build

| | |
| --- | --- |
| **Status** | Open |
| **Question** | SQLite in Electron (`node:sqlite`, `bun:sqlite` or `better-sqlite3`) and IndexedDB in the browser — or one portable engine? |
| **Tension** | `bun:sqlite` does not exist in Electron's Node. Native modules need an ABI rebuild per Electron version. |
| **Needed** | A spike on the Electron 45 / Node 22 combination; a schema that can be rebuilt from files either way. |
| **Blocks** | spec 002 search/index tasks; spec 010 browser index |
| **Owner** | spec 002 / 010 |

### D-108 · Export libraries and determinism

| | |
| --- | --- |
| **Status** | Accepted (2026-11-03, on the author's delegation) |
| **Decision** | DOCX stays on `docx` 9.x. PDF renders the manuscript's own HTML through Electron's built-in Chromium print-to-PDF (`webContents.printToPDF`) in a hidden window, so the desktop needs no external binary. EPUB 3 is assembled with the `fflate` dependency the studio already uses: an OPF manifest, one XHTML file per chapter, a navigation document, `images/` sidecars and no remote resources, with fixed zip entry dates. The packaging follows the recommendation below. Determinism is content determinism. PDF container bytes vary with Chromium's creation date, and the studio does not claim byte-identical PDFs. No KDP or other publisher acceptance, EPUBCheck validity, PDF/UA or exact pagination is claimed. |
| **Question** | Which DOCX, PDF and EPUB implementations produce KDP-acceptable output and deterministic files? |
| **Recommendation** | Select no renderer yet. Keep `docx` 9.x for DOCX (verified: deterministic content parts, fixed zip entry dates; only `docProps/core.xml` wall-clock timestamps vary), LibreOffice headless, `pdf-lib` (assembly only, needs a layout pass), Typst and an EPUB container assembler in play — none of the latter were evaluated locally (no binaries present, none installed) and no publisher upload is verifiable locally. Proposed acceptance: same book bytes in, byte-identical container out (normalized container metadata, fixed entry dates, unmodified image bytes), enforced by a two-build premise test; shelled-out renderers pin their binary version in the export. Proposed packaging: DOCX keeps inline `word/media` after the body with captions and alt text; PDF is single-file with embedded images in DOCX order; EPUB is OPF manifest + one XHTML per chapter with `images/` sidecars and no remote resources. Rationale: content determinism is already proven for the current pipeline, so the decision can demand container determinism without new infrastructure; KDP acceptance, exact pagination/trim (needs T008), font embedding, PDF/UA and EPUBCheck remain explicitly unresolved with no conformance claim allowed. |
| **Evidence** | `specs/035-book-formatting/research/export-renderers.md`; `apps/desktop/tests/export-renderers-premises.test.ts` (content determinism, fixed entry dates, core-timestamp shape). |
| **Needed** | Author acceptance of the determinism requirements and per-target packaging contract, or a narrower alternative with its own conformance plan. |
| **Blocks** | spec 002 export tasks; spec 035 renderer selection, per-target image placement/packaging and conformance tasks (T013–T014 wait on the accepted decision alongside matter and profile decisions) |
| **Owner** | spec 035 |

### D-109 · Voice stack

| | |
| --- | --- |
| **Status** | Open |
| **Question** | Which system voices are reachable from Electron on each OS, and is browser `speechSynthesis` good enough for the web build? Is premium TTS (ElevenLabs) in scope for v1? |
| **Needed** | Platform probes; a matrix of voice, offline behaviour and cost; dictation fallback. |
| **Blocks** | spec 002 voice requirements |
| **Owner** | spec 002 |

### D-110 · Image generation providers and policy

| | |
| --- | --- |
| **Status** | Open |
| **Question** | Which OpenRouter image models are suitable for book illustration, what do they cost, and how are refusals surfaced? |
| **Needed** | Model survey with per-image cost, size and content-policy behaviour; a budget model for a 40-image book. |
| **Blocks** | spec 002 illustration tasks |
| **Owner** | spec 002 |

### D-111 · Conflict UX across sync providers

| | |
| --- | --- |
| **Status** | Open |
| **Question** | How do iCloud, Drive and Dropbox name conflicted copies, and what does the review screen show for each? |
| **Needed** | Observed file naming per provider on macOS and Windows; a comparison and merge flow that never chooses silently. |
| **Blocks** | spec 002 sync tasks |
| **Owner** | spec 002 |

### D-113 · Conversations and checkpoints on disk

| | |
| --- | --- |
| **Status** | Open |
| **Question** | One JSONL file per thread, plus per-turn checkpoints as patch files? What are the retention and size limits for a 250k-word book? |
| **Tension** | Full snapshots are simple but huge; patches are small but fragile if a later turn rewrites the same lines. |
| **Known** | Today a turn's checkpoint is one JSON file of whole chapter texts, written again after each change the turn makes ([FORMAT.md](FORMAT.md#agent-turn-checkpoints), 2026-11-04). Undo removes the newest file; nothing prunes older ones. Later the same day each entry gained, additively, the chapter's details before the turn and a hash of the details it left, the trash path of a deleted chapter, and a mark for text written by someone else mid-turn. Undo now brings a deleted chapter's own file back from the trash and keeps a `conflict-undo` copy before restoring marked text. The size question is unchanged: a deleted chapter's text is still also held whole in `before`. |
| **Needed** | A storage spike with a realistic turn sequence, plus a pruning rule the author can see. |
| **Blocks** | spec 002 agent history tasks |
| **Owner** | spec 002 |

### D-115 · Updates and signing for the hackathon

| | |
| --- | --- |
| **Status** | Deferred |
| **Question** | Do we notarise, and do we ship auto-updates in the hackathon build? |
| **Trigger to revisit** | A public download page, or the first external tester on macOS. Until then builds are unsigned and labelled as such. |
| **Blocks** | nothing in v1; spec 009 |

### D-116 · Cost and usage cap enforcement

| | |
| --- | --- |
| **Status** | Proposed |
| **Recommendation** | Show provider-reported cost per turn; enforce a per-turn and per-session ceiling the author sets; refuse to start a batch (images, long agent runs) whose estimate exceeds the remaining ceiling. |
| **Needed** | Acceptance, plus what to do when the provider reports no price. |
| **Blocks** | spec 011 usage tasks, spec 002 image batch |
| **Owner** | spec 011 |

**Update (2026-11-03).** The informational hooks landed via 011 T036 and stay unenforced: per-book
`perTurnCeilingUsd`/`monthlyWarningUsd` settings (null by default), pure per-turn and monthly
evaluators, and a display-only Spending section in the agent dialog. Nothing blocks or refuses a turn.
Acceptance — the unknown-price policy and the enforcement itself — is still open.

### D-117 · iOS through Capacitor

| | |
| --- | --- |
| **Status** | Proposed |
| **Recommendation** | Ship iOS later by wrapping the planned web build in Capacitor, which runs the same React app in WKWebView. Add a native storage adapter: the Filesystem plugin keeps the library in the app's Documents folder, SQLite holds the rebuildable index, and Keychain holds provider keys. Authors reach the folder through the Files app and iCloud Drive, so sync still needs no account with us. Reuse the core and UI; no Electron code reaches iOS. |
| **Needed** | After spec 010 produces a web build: point Capacitor's `webDir` at it, then spike the Filesystem, SQLite and Keychain plugins, iCloud container and security-scoped bookmark behaviour, WebView storage durability under pressure, OpenRouter from the Capacitor origin, and Apple review notes for a local-first writing app. |
| **Blocks** | nothing in v1; spec 010 (web build) is the prerequisite; a future spec 014-mobile |
| **Owner** | later |

**Update (2026-10-24).** Expo Simulators can host any `iphonesimulator` `.app` or Android `.apk`, so it can test a Capacitor build without adding Expo or React Native to the app. It is a limited-access preview for select partners, billed per session, and not included with Expo plans. Use it as a remote device lab when access is granted; otherwise use the local Device hub after installing a simulator runtime.

**Update (2026-10-24, later).** The shell spike passed. Capacitor 8.5.3 built with Swift Package Manager, installed and launched on the iPhone 17 Pro simulator with the iOS 26.5 runtime; the bundled page rendered in WKWebView. See [the spike note](research/capacitor-ios-spike.md). This validates the shell, not the studio renderer or the Filesystem, SQLite, Keychain and iCloud plugins, which wait for spec 010's web build.

### D-118 · Mobile device testing (Device hub and Expo Simulators)

| | |
| --- | --- |
| **Status** | Proposed |
| **Recommendation** | Keep Expo out of the app stack: the studio is a DOM app and ships through Capacitor, not React Native. Use Expo Simulators only as a remote device lab when access is granted; it installs any `iphonesimulator` `.app` or `.apk`, gives agent control and a browser preview, and needs no Expo dependency in the app. A local iOS runtime is now installed (iOS 26.5 under Xcode 26.6); use it through `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl` or the Simulator app. Android still needs Java, the emulator package and a system image. |
| **Needed** | Agent device access enabled in Device hub for the T3 simulator tools; Expo Simulators waitlist or partner access and billing approval if a remote lab is wanted; a Capacitor iOS build from the web target. |
| **Blocks** | nothing in v1; spec 010 (web build) is the prerequisite; a future spec 014-mobile |
| **Owner** | later |

**Update (2026-10-24, later).** The local iOS path is ready: Xcode 26.6 installed the **iOS 26.5 (23F77)** simulator runtime, `simctl` created the standard device set, and **iPhone 17 Pro** boots and screenshots successfully. `Simulator.app` is open. The runtime lives under `/Applications/Xcode.app`; commands need `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` because `xcode-select` still points at Command Line Tools. Agent device access in Device hub remains off, so T3's `device_*` tools cannot drive the simulator yet; CLI `simctl` works without it. Disk headroom after cleanup is about 61 GiB.

### D-119 · Mobile reference devices

| | |
| --- | --- |
| **Status** | Accepted |
| **Decision** | Design and verify against **iPhone 393 × 852** and **iPad mini 744 × 1133** first; desktop remains supported at 1440 × 900. The layout breakpoints are 700px and 1000px: below 700px is one column with a bottom bar and drawer, 700–999px keeps the chapter rail, and 1000px and above is the three-pane desktop workspace. The mobile shell is Capacitor; Expo and React Native are not part of the stack. |
| **Evidence** | Responsive layouts implemented and captured at all three sizes; Capacitor 8.5.3 shell launched on the iPhone 17 Pro simulator. Spec [014-mobile](../specs/014-mobile/spec.md). |
| **Blocks** | nothing; the web build (spec 010) is still required before the real renderer runs in Capacitor |
| **Owner** | spec 014 |

### D-120 · Sync journal and drift baseline

| | |
| --- | --- |
| **Status** | Proposed (implemented as recommended) |
| **Question** | What is the baseline for “changed on another device”, and how are deletions, renames and placeholders represented without a server? |
| **Recommendation** | A per-device journal under `.studio/sync/<deviceId>.json` records the last observed hash and the hash this device last wrote. Drift is a read-only comparison; deletions are tombstones; a missing/corrupt journal falls back to a full comparison with a warning. Timestamps are display-only. |
| **Needed** | Author acceptance. The harness results and corrupt/stale-journal tests are recorded below. |
| **Evidence** | `packages/core/src/sync/` journal, scan and detector; 14 unit tests; 10 two-system scenarios in `apps/desktop/tests/sync/`; a trash move is a deletion, not a rename; a copied journal with another device id is ignored. Device identity inside a synced folder is tracked as D-124. |
| **Blocks** | spec 016 T006–T007 (the review UI — implemented 2026-11-03 on the recommendation; acceptance still open) |
| **Owner** | spec 016 |

**Update (2026-11-03).** T006–T007 are implemented on the recommended baseline: the review dialog with
keep-disk/keep-mine/open-both/export, the Settings sync section, own-write journal notes at save
time, and the first-scan baseline. The decision itself stays proposed — no timestamp logic, no
enforcement, and the D-124 device-identity question stands.

### D-121 · App lock scope and PIN policy

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | Is the lock a UI gate or an encrypted vault, and which biometric/passcode/PIN policy applies on macOS and iOS? |
| **Recommendation** | A UI gate using LocalAuthentication at launch and resume. Optional 6+ digit PIN verifier in the keychain (`ThisDeviceOnly`, random salt, slow KDF, attempt limit). No encryption-at-rest claim in v1; files remain readable by Finder/CLI/agent. No recovery code. The iOS plugin choice is part of this decision. |
| **Needed** | macOS LocalAuthentication probe from Electron main, Capacitor/iOS plugin review, security review of the PIN verifier, and a UX check of cancel/lockout states. |
| **Blocks** | spec 016 T008–T011; spec 014 device checks |
| **Owner** | spec 016 |

### D-122 · Sync providers and placeholders

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | Which locations ship in v1: iCloud Drive, Google Drive mounted folder, local folder — and how are online-only files handled? |
| **Recommendation** | v1 is folder-based: local, iCloud Drive (macOS/iOS Files), and Google Drive through its desktop-mounted folder. No OAuth/API. Placeholders are materialized or reported as “not downloaded”; never read as empty. Direct cloud APIs wait for a separate decision. |
| **Needed** | Real probes for iCloud eviction and Google Drive placeholders, iOS security-scoped bookmark persistence, and the exact conflict-copy names. |
| **Blocks** | spec 016 T012; spec 014 iOS folder access |
| **Owner** | spec 016 |

### D-123 · Drift conflict resolution UX

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | When both devices changed a chapter, does the studio keep file copies, offer a chapter-level review, or attempt an automatic merge? |
| **Recommendation** | Preserve both versions, group the report at chapter level, and offer review / keep disk / keep mine / open both / export. No automatic prose merge in v1; agent-assisted merge is a later opt-in. |
| **Needed** | Author testing with concurrent edits and a check against the existing save-conflict and agent-checkpoint flows. |
| **Blocks** | spec 016 T006 |
| **Owner** | spec 016 |

### D-124 · Device identity in a synced folder

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | `.studio/device.json` lives inside the folder the provider copies. If two installs read the same identity, both write `.studio/sync/<deviceId>.json` and the baseline stops being per-device. Where does identity belong? |
| **Recommendation** | Keep the authoritative device id in the host profile (Electron `userData`, browser origin storage), keyed by library; treat `.studio/device.json` as display metadata regenerated per install. The archive already excludes and regenerates it, so the rule stays consistent. |
| **Needed** | A desktop profile identity store with a migration from the current file, a browser adapter check, and a harness run that copies `.studio/device.json` and asserts the journals stay separate. |
| **Blocks** | Nothing yet; it constrains T006–T007 and the iOS pass. Until it is accepted, the drift report must not claim the journal is per-device. |
| **Owner** | spec 016 |

### D-163 · Story Bible extension storage

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | Do optional planning records live in an extension of `book.json` or in a separate versioned book-level file, and with what versioning, compatibility, unknown-field and archive behavior? |
| **Recommendation** | A separate versioned `planning.json` beside `book.json`: `looseObject` schema with spread-on-write (like `book.json`, explicitly unlike `images.json`, which strips unknown keys), newer-schema refusal, write refusal while the on-disk shape is unsupported (never reset to empty), lazy creation on the first record, and `bookId` ownership validation. Rationale: failure isolation (a corrupt planning file never bricks the book — verified with the repo's zod that a nested strict section would fail the whole `book.json` parse) and conflict granularity (planning saves commit one file, disjoint from book edits). |
| **Evidence** | `specs/030-story-bible-extensions/research/storage-alternatives.md`; `packages/core/tests/story-bible-storage-premises.test.ts` (unknown-field survival, no-rewrite opens). |
| **Needed** | Author acceptance of the recommendation or the one-file alternative with section-tolerant book parsing. |
| **Blocks** | spec 030 T002–T008 (format, schema, storage, IPC, UI) |
| **Owner** | spec 030 |

### D-164 · Planning revision and conflict representation

| | |
| --- | --- |
| **Status** | Open |
| **Question** | Which file/snapshot is the baseline for a planning save, how do entity revisions relate to that source, and where is a stale draft retained for review — within the existing expected-hash commit and common adapter contract? |
| **Needed** | D-163 acceptance first (the baseline depends on the file decision), then a two-writer synthetic plus injected-failure suite against the chosen file, reusing the chapter-conflict copy conventions. |
| **Blocks** | spec 030 storage, IPC and UI tasks |
| **Owner** | spec 030 |

### D-165 · Planning bounds and identity rules

| | |
| --- | --- |
| **Status** | Open |
| **Question** | Are the proposed bounds (200 records per kind, 200-unit names/labels, 20,000-unit bodies), identity grammar/uniqueness and revision representation confirmed against validation, archive and user-visible error needs? |
| **Needed** | D-163 acceptance (schema shape follows the file decision), then boundary fixtures proving over-limit rejection without partial writes and duplicate/foreign-identity refusal. |
| **Blocks** | spec 030 schema and UI tasks |
| **Owner** | spec 030 |

### D-166 · Organization data storage matrix

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | For collections, recent entries, goals and annotations, which records are ordinary library files and which are disposable preferences — with scope, schema/version, limits, checked writes, conflict behavior, archive and sync treatment? |
| **Recommendation** | Collections in library-root `collections.json`; recent entries as disposable host-profile preferences (desktop `studio.json`, web origin storage); per-book `goals.json` and `annotations.json` sidecars. All files validated, versioned, loose schemas with spread round-trip; corrupt/unsupported-future refused, never reset; lazy creation; every write through the expected-hash commit (never `updateBook`'s `kind: "any"` path). Rationale: failure isolation per book, no false conflicts between goal/book edits, machine-local resume state, archive travel by construction. |
| **Evidence** | `specs/033-library-organization/research/storage-matrix.md`; `packages/core/tests/organization-storage-premises.test.ts` (sidecar trash/restore travel, root-file archive ride + trash independence); existing pins for expected-hash refusal, unknown-file archive round-trip and whole-book trash moves. |
| **Needed** | Author acceptance of the matrix or a named alternative, plus numeric caps for record counts, field sizes and file bytes. |
| **Blocks** | spec 033 T004–T008 (services, surfaces, integration) |
| **Owner** | spec 033 |

### D-167 · Collection identity and membership

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | Can a book belong to one or multiple collections? Are collection names unique? Which stable collection identity survives rename, and how are references handled on trash/restore of the same versus a different book identity? |
| **Recommendation** | Many-to-many membership by stable book id; case-insensitive unique collection names; stable `col_` identity surviving renames (needs an `idSchema` prefix extension at implementation); idempotent add/remove that rewrite nothing on no-ops; trash/restore handled by id lookup (dangling = unavailable, never substituted, same-id restore revalidates). |
| **Evidence** | `specs/033-library-organization/research/collection-identity.md`; `packages/core/tests/collection-identity-premises.test.ts` (rename preserves id/paths, trashed ids unresolvable and never substituted, restore keeps identity). |
| **Needed** | Author acceptance of the membership/name/identity rules (or the exclusive-shelf alternative) plus numeric caps. |
| **Blocks** | spec 033 T005 (collection persistence and CRUD) |
| **Owner** | spec 033 |

### D-168 · Source-anchor representation and verification

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | How is a passage encoded against saved chapter text, and what exact evidence suffices to open it or mark it stale after edits, moves, duplicate text, line-ending changes, Unicode, reorder, rename or restore — never retargeting by guess? |
| **Recommendation** | Anchor = `bookId`, `chapterId`, `chapterVersion`, whole-file `chapterHash`, 1-based inclusive body line range plus verbatim excerpt, taken only from a confirmed saved source. Verification is exact and ordered: resolvable chapter, version+hash equality, excerpt-at-range equality — any failure is visibly stale with excerpt retained and nothing selected. No fuzzy fallback, no passage-hash-only or file-offset variants (documented rejections). |
| **Evidence** | `specs/033-library-organization/research/source-anchors.md`; `packages/core/tests/annotation-anchor-premises.test.ts` (version/hash advance on any edit, stable on no-op re-save, deterministic body lines, trashed chapters unresolvable). |
| **Needed** | Author acceptance of the serialization and rule (point-anchor and wording details stay with T008 implementation). |
| **Blocks** | spec 033 annotation persistence, navigation and re-anchoring (T008) |
| **Owner** | spec 033 |

### D-169 · Ordered matter schema and legacy conversion

| | |
| --- | --- |
| **Status** | Accepted (2026-11-04, on the author's delegation) |
| **Question** | How are populated `frontMatter` records classified, ordered, preserved, reviewed and rolled back — including 003-imported subtitle/author/dedication/disclaimer/about-author keys — without migrating or reinterpreting existing records before acceptance? |
| **Decision** | Supersede the record rather than build on it. Ordered matter is a new optional top-level `matter` value in `book.json`: `version` (a save counter, as a chapter's), `titlePage`, `author`, `subtitle`, and an ordered list of `sections`, each with a `mat_…` id, a `kind` (`copyright`, `disclaimer`, `dedication`, `epigraph`, `acknowledgements`, `about-the-author`, `other`), a `position` (`front` or `back`), a `title` and Markdown `text`. Every export uses one order: the generated title page when it is on, the front sections, the contents page when the book asks for one, the chapters, the back sections. An absent, `null` or empty value (title page on, no author, subtitle or sections) means no matter, and the book exports exactly as before: goldens captured from the exporters before matter existed prove it. Once the matter holds anything, the title page shows the title, subtitle and author; the book's description leaves it (Word and EPUB files keep it in their metadata), and the subtitle is not filled from the description, because a premise is not a subtitle. The preview shows the change before any export. `matter` is carried as it is and read tolerantly, so a hand edit never stops a book from opening; saves never write over an unreadable value, and exports stop with the reason instead of leaving it out. Only the matter save writes it. The save carries `baseVersion` and `baseHash`, the SHA-256 of the matter's JSON as parsed; a mismatch keeps the author's matter as JSON in `conflicts/` and returns the newer one. The general book update ignores a `matter` patch. The format of `matter` changes only with `schemaVersion`. `frontMatter` stays exactly as written: never enumerated as ordered, never exported, never migrated, and still parsed strictly. The Format dialog lists every non-empty entry no export includes, with where it would go: `subtitle` and `author` to the title page when it has none, and `copyright`, `disclaimer`, `dedication`, `epigraph`, `acknowledgements`/`acknowledgments` and `aboutAuthor`/`about the author`/`authorBio` to a section of that kind in its usual place; anything else is not placed. Converting happens only when the author asks, places only what has a place (an author or subtitle the title page already has is listed as not placed), never adds an entry the matter already holds, and leaves the record untouched. Rolling back is removing the added sections. |
| **Recommendation** | As decided. A separate ordered value is what FR-007 asks for, and it can carry what the record cannot: two sides, author order, titles, several pages of one kind, and a version for checked saves. The empty-means-none rule keeps a book that never uses matter, or whose author toggles the title page off and on, byte-identical in every export. |
| **Rejected** | The earlier proposal, an additive `matterOrder: string[]` over the record with kinds derived from keys: no front or back position, no titles, one page per key, and FR-007 asks for a value separate from the record. Title as a section kind: a book has one title page, it is generated rather than written, and as a free section it could be ordered after the copyright page. A format version inside the value: `schemaVersion` already refuses a newer format, and a second version would need its own refusal path. Tolerant carry for `frontMatter`: deferred, because the record keeps its strict parse until a repair interface exists and the 003 importer writes only strings. Converting automatically on open or export: FR-010 forbids it. A Markdown conflict copy: JSON keeps exactly what the author had, and a `.md` copy would surface in the chapter conflict list as a chapter. |
| **Evidence** | `specs/035-book-formatting/research/matter-schema.md`; `packages/core/tests/matter-schema-premises.test.ts`; `packages/core/tests/matter.test.ts` (schema limits and round trip, tolerant read, plan, conversion including repeats, checked save, conflict copy, unreadable value, concurrent writer); `apps/desktop/tests/no-matter-identity.test.ts` and `apps/desktop/tests/export-matter.test.ts`; `apps/desktop/tests/format-matter.test.tsx`; `apps/desktop/tests/ipc-handlers.test.ts` (sizes and ids at the boundary). |
| **Unblocks** | spec 035 T009–T013. The Markdown folder export (T014) stays open. |
| **Owner** | spec 035 |

### D-170 · Format-profile persistence and physical-layout controls

| | |
| --- | --- |
| **Status** | Accepted (2026-11-04, on the author's delegation) |
| **Question** | Do target-specific format profiles persist per book or per export, and which physical-layout controls, if any, are modeled? |
| **Decision** | Format settings persist per book. The typography lives in `settings.manuscript` and the front and back matter in `matter`, both in `book.json`, and every export target reads them; an export never keeps its own copy. The target (Word, PDF, EPUB or Markdown) stays a choice made for each export, transient dialog state that starts at Word. No target-specific profile persists, because the four renderers read the same typography; `formatProfiles` stays reserved as a top-level field (never under `settings`, whose strict object strips unknown sections) for when a renderer honours a value of its own. No physical-layout control is modeled: PDF pages stay A4 with one-inch margins, as the Word export inherits, and nothing claims a measurement. |
| **Recommendation** | As decided. Per book keeps every export rebuildable from the files and gives the author one place to change the book's look, and the matter is content rather than an export option. |
| **Rejected** | Per-export settings: an export could no longer be rebuilt from the files, the author would make the same choices again for each export, and matter in particular is the book's content. Persisting per-target profiles now: no renderer reads them, so they would be dead settings that look live. Nesting profiles under `settings`: proven to be stripped on every save. Trim, margin or page-size controls: D-108 makes no measurement claim and no renderer could honour them. |
| **Evidence** | `specs/035-book-formatting/research/format-profiles.md`; `packages/core/tests/format-profile-premises.test.ts`; `apps/desktop/tests/export-renderers-premises.test.ts`; `apps/desktop/tests/format-dialog.test.tsx` (target transient, typography bound to `settings.manuscript`). |
| **Update** | 2026-11-06 (D-190): the settings object no longer strips unknown nested sections, because every object in `book.json` is loose, and the premise test now pins that a nested section survives a supported save. Keeping `formatProfiles` top-level still works and is still the reserved shape; the reasons above that say `settings` strips unknown sections, and that nesting profiles is stripped on every save, no longer hold. The decision is otherwise unchanged. |
| **Unblocks** | spec 035 T008. Persistent target-specific settings and physical-size controls still need a new decision. |
| **Owner** | spec 035 |

### D-171 · Report save, export, retention and deletion

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | After the disposable first milestone, may authors save or export review reports, where do saved reports live, what manuscript excerpts may they contain, and how are they deleted and retained? |
| **Recommendation** | Allow both narrowly. Export a human-readable summary (scope, timestamps, counts, coverage, findings with excerpts) to the clipboard and to one author-chosen Markdown file via the safe-publication pattern; excerpts capped at 500 characters with an ellipsis marker, plus captured-at and may-have-changed markings. Save JSON beside the book under `books/<bookId>/reviews/<runId>.json` — additive per-book derived file, no library format field, nothing in profile/index/threads/usage/sync baselines (FR-011's exclusion list extends to saved reports). Results carry references and excerpts but never bodies, excerpts are unbounded in the type today, and freshness is computed never stored — so the decision sets the cap and requires export-time staleness marking. Retention: derived and disposable, at most 20 per book with oldest-first eviction and visible count; explicit per-report Delete plus book-fate deletion; no external registry or metadata; excluded from portable archive and sync until 016 decides. Rejected: volatile-only forever, threads/usage storage, unbounded excerpts, syncing reports. Saved reports revalidate version+hash on open and show stale when the source moved. |
| **Evidence** | `specs/034-manuscript-review/research/report-retention.md`; `packages/core/tests/review/report-persistence-premises.test.ts` (excerpts without bodies, unbounded excerpts, computed freshness); `apps/desktop/tests/review-report.test.tsx` (volatile run, no writes, discard on switch). |
| **Needed** | Author acceptance of the export cap and markings, the reviews directory with its cap and deletion rules, and the archive/sync exclusion. |
| **Blocks** | spec 034 report persistence/export implementation (no such task may begin before acceptance and any required format/ADR review) |
| **Owner** | spec 034 |

### D-172 · D-115 scope over user-driven local install and upgrade

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | Does D-115 also gate user-driven local installation and compatible local upgrade, or only signing, notarisation, update feeds and automatic updates? |
| **Recommendation** | D-115 does not gate manual local install or compatible local upgrade. Allowed now, by hand only: place an unsigned build, run it, upgrade by replacing the bundle — profile continuity is structural (one version-free `studio.json` under the per-app `userData`) and compatible upgrades touch only the bundle (library opens rewrite nothing, newer schemas refuse before writes, `book.json` carries no app version). Required every time: Gatekeeper-override disclosure (unsigned downloads are quarantined; untested locally, documented as a survey limit), the unsigned label in About and the record, same-schema only with refuse-and-guide otherwise, no update feed, no automatic behavior, no credential use, no publication. Rejected: gating everything on a certificate with no technical basis; unconditional local install without the override/label/schema conditions; deciding profile location and uninstall behavior here (T024/T025/T028 matters). D-115 keeps signing, notarisation, update feeds and automatic updates. |
| **Evidence** | `specs/009-packaging-release/research/local-install-upgrade.md`; `apps/desktop/tests/profile-stability-premises.test.ts` (shared version-free settings file, writes confined to the profile root, no app version in the file, older readers tolerate unknown keys); 030 open-rewrites-nothing premise; `assertSchemaVersion` refusing newer schemas pre-write. |
| **Needed** | Author acceptance that manual local install/upgrade proceeds under the stated conditions while D-115 keeps signing, notarisation, feeds and automatic updates. |
| **Blocks** | spec 009 local install/upgrade implementation and acceptance only (T027/T030 still wait on T024; T028 waits on T024/T025); not authorization to package or install anything |
| **Owner** | spec 009 |

### D-173 · Lifecycle support matrix

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | Which desktop targets and native install/uninstall methods are supported, what stable per-user profile path applies on each, and how do authors find that location? |
| **Recommendation** | Accept the matrix: macOS (dmg, zip, arm64/x64) release-blocking; Windows (assisted nsis, custom dir allowed) and Linux (AppImage) configured best-effort until a gate builds them. Native methods: drag-install/trash (mac), wizard/uninstaller entry (win), chmod-and-run/delete-file (linux); profile stays on uninstall (T025 owns cleanup). Per-user profile is Electron's per-app `userData` (`~/Library/Application Support/AI Book Studio`, `%APPDATA%/AI Book Studio`, `~/.config/AI Book Studio`), stable because `productName`/`appId` are version-free and one `studio.json` rule holds on every root, relocatable via `STUDIO_USER_DATA`; Settings is the discovery surface (T027). OS floors follow upstream Electron 45, confirmed at acceptance — none asserted here. Rejected: macOS-only support, per-version profile directories, deciding uninstall cleanup here. |
| **Evidence** | `specs/009-packaging-release/research/lifecycle-matrix.md`; `apps/desktop/tests/lifecycle-matrix-premises.test.ts` (version-free identity keys, one settings rule on synthetic per-OS roots); `apps/desktop/electron-builder.yml`; T023 profile premises. |
| **Needed** | Author acceptance of the matrix, plus confirming the exact upstream OS floors and the Windows uninstaller profile behavior at acceptance. |
| **Blocks** | spec 009 platform-specific lifecycle implementation/acceptance only (T027/T028/T030; T025 still needs its own decision); not authorization to package or install anything |
| **Owner** | spec 009 |

### D-174 · Profile cleanup on uninstall

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | Should any platform offer a separate optional app-profile cleanup on uninstall, and what exactly may it delete? |
| **Recommendation** | Offer a separate, optional, in-app profile cleanup (Settings), available any time — not tied to the uninstall moment, identical on all targets. The profile is exactly `studio.json` (settings pointers) and `credentials.json` (encrypted vault) under the per-app `userData` root: it holds no manuscript (proven), regenerates from defaults, and deletes closedly per file. Rules: explicit opt-in, never default-on, never bundled; itemized confirmation naming each file with its plain description and full path; cancel removes nothing; the library is never listed or touched; no telemetry of the choice. Rejected: no cleanup ever, per-platform uninstaller hooks, a single delete-everything button, any library scope. Keeping profile data and the library remains the default either way. |
| **Evidence** | `specs/009-packaging-release/research/profile-cleanup.md`; `apps/desktop/tests/profile-cleanup-premises.test.ts` (pointer-not-prose settings, missing-file defaults, vault under the same root); T023/T024 premises (shared version-free root, builder targets). |
| **Needed** | Author acceptance of the in-app optional cleanup with the itemization and cancellation rules. |
| **Blocks** | spec 009 optional cleanup implementation only (T028); preservation-only uninstall is unblocked regardless |
| **Owner** | spec 009 |

### D-175 · Chapter history storage layout and lifecycle

| | |
| --- | --- |
| **Status** | Accepted (2026-11-03, on the author's delegation) |
| **Decision** | As recommended. Building it is deferred until after the hackathon submission: it adds `books/<bookId>/history/` to the format and touches the only writer, archive and trash, so it lands with its own release and the manuscript-safety suite, not in the last day's merge queue. |
| **Question** | What author-owned file layout and schema store chapter-history snapshot bodies, provenance, safety copies, and restore-undo records, and how do they travel through archive import/export and chapter trash/restore? |
| **Recommendation** | Book-scoped `books/<bookId>/history/<chapterId>/<timestamp>-<label-slug>[-n].md`, one file per record, YAML front matter plus canonical body — the chapter-file shape. Front matter carries `schemaVersion: 1`, `kind` (`snapshot`, `safety`, `intent`), identity, `sourceVersion`/`sourceHash`/`bodyHash`/`capturedAt`, and intent state; intents carry no body. Loose schemas with spread round-trips, newer-schema refusal, never reset-to-empty. Archive and whole-book trash carry history by construction; chapter trash leaves it keyed by stable id; author deletion moves the record to chapter trash. Rejected: `.studio/history/` (archive-excluded device scope), reusing `checkpoints/` (D-113 owns it), one `history.json` per book (single-point failure), JSON-plus-body pairs (orphan risk), history inside chapter files (rewrites saved bytes). |
| **Evidence** | `specs/032-chapter-history/research/storage-layouts.md`; `packages/core/tests/chapter-history-storage-premises.test.ts` (trash/restore travel, archive manifest ride, chapter-trash separation, stable identity across rename/reorder, atomic hash-guarded record writes); FORMAT archive/trash rules; D-112 (accepted archive); D-163/D-166 loose-schema and sidecar precedents. |
| **Needed** | Author acceptance of the layout, record kinds, and lifecycle rules, or a named alternative. Field-level schema and label grammar stay with T003. |
| **Blocks** | spec 032 snapshot persistence, restore/undo persistence, and archive/trash integration (T003/T004/T007–T009) |
| **Owner** | spec 032 |

### D-176 · Chapter history retention and cleanup

| | |
| --- | --- |
| **Status** | Accepted (2026-11-03, on the author's delegation) |
| **Decision** | As recommended. Building it is deferred until after the hackathon submission: it adds `books/<bookId>/history/` to the format and touches the only writer, archive and trash, so it lands with its own release and the manuscript-safety suite, not in the last day's merge queue. |
| **Question** | What retention, size-limit, and cleanup policy applies to named and safety snapshots, given that no period or quota may be chosen by assumption? |
| **Recommendation** | No automatic pruning, quota, expiry, or compaction for snapshots, safety copies, or intents — including unapplied intents, which are recovery material. Explicit author deletion moves the record to chapter trash; storage/write failures report without deleting. Size visibility comes from storage stats at list time, not a new format field. Numeric caps only later, with measured evidence and acceptance. Rejected: count/age/quota auto-rules (assumed numbers that pick the author's loss), delete-means-unlink (violates the no-permanent-delete rule). D-171's 20-cap stays scoped to review reports. |
| **Evidence** | `specs/032-chapter-history/research/retention.md`; `packages/core/tests/chapter-history-retention-premises.test.ts` (unbounded conflicts and trash, failed writes preserve bytes); 034 T013 volatility precedent; FORMAT transport-only caps. |
| **Needed** | Author acceptance of no-automatic-pruning with trash-based deletion, or a named evidenced alternative. |
| **Blocks** | spec 032 pruning, size-limit, and cleanup implementation only (T011); capture, browse, compare, checked restore, and restore undo proceed without it |
| **Owner** | spec 032 |

### D-177 · Discuss default and read-tool policy

| | |
| --- | --- |
| **Status** | Accepted (2026-11-03, on the author's delegation) |
| **Decision** | As recommended. The implementation (spec 031 T006–T008) is held out of the hackathon build: making Discuss the new-turn default changes how every turn in the recorded demo behaves, so it merges only with a re-shoot and a matching script and runbook update. |
| **Question** | In Discuss mode, are positively read-only built-in tools available or does the model receive no tools — and what is the initial composer mode? |
| **Recommendation** | Read-only built-ins only, Discuss as the new-turn default. A Discuss turn is offered exactly the six read-tier tools (`table_of_contents`, `read_story_bible`, `read_chapter`, `chapter_stats`, `find_in_chapter`, `find_in_chapters`) and no plugin tools; write, destructive, unclassified, and future tools are unoffered and bridge-denied if invoked. Enforcement is the existing three layers: the read-only subset via the `disabledTools` seam, bridge denial of unknown/withheld names, and the checked writer below. A Discuss turn that needs a write explains the Edit-mode next step; nothing is queued or written. The submitted mode is fixed for the turn. Rejected: no tools in Discuss (forces read-only questions into Edit), write tools on a promise (not a boundary), plugins on self-declaration (no declaration field; handlers receive writers — needs 025 first), Edit as default (unsafe default). |
| **Evidence** | `specs/031-agent-interaction/research/discuss-read-policy.md`; `apps/desktop/tests/discuss-read-policy-premises.test.ts` (exact read-tier six, subset seam, plugin write default); `tool-bridge.test.ts` (unknown/destructive refusal); `tool-set.test.ts` (withdrawal, no-shadow, plugin writers); `agent-runtime.test.ts` (approval flow). |
| **Needed** | Author acceptance of the read-only six and the Discuss default, or a named alternative (no-tools Discuss, plugin inclusion with a 025 capability). |
| **Blocks** | spec 031 Discuss tool set and composer default only (T007/T008); mode persistence (T004–T006) and plan/guidance (T002/T003) are separate decisions |
| **Owner** | spec 031 |

### D-178 · Pause acknowledgment and continuation semantics

| | |
| --- | --- |
| **Status** | Accepted (2026-11-03, on the author's delegation) |
| **Decision** | As recommended. The implementation (spec 031 T006–T008) is held out of the hackathon build: making Discuss the new-turn default changes how every turn in the recorded demo behaves, so it merges only with a re-shoot and a matching script and runbook update. |
| **Question** | What counts as a completed pause, does Start/Resume continue the live turn or start a new turn, and what happens on non-background window close? |
| **Recommendation** | Pause completes on the terminal `stopped` event, not the stop call's return: by then no tool can start and the in-flight tool has its definitive outcome recorded. The composer shows "Stopping…" until the event, then "Paused" with the change count and undo availability. Continuation is always a new explicit turn from the stored plan (no live-turn continuation exists to resurrect); approvals stay strictly per turn and are re-raised, never inherited. Non-background window close stops the turn like an author stop; restart expires unfinished plans visibly, never resumable; a plan never grants background. Rejected: pause-on-return (races the settling tail), same-turn resume (no machinery; re-enters unknown tool state), approval inheritance (breaks the per-turn gate), close-as-park (frozen close/quit behavior plus a second lifecycle). |
| **Evidence** | `specs/031-agent-interaction/research/pause-continuation.md`; `apps/desktop/tests/pause-boundary-premises.test.ts` (per-turn approval death, mid-write atomic stop with reported outcome, new-turn continuation); `agent-runtime.test.ts` (approval waits, stop expiry); `AgentTurnInput.background` and 017 FR-012/FR-015/FR-017 (explicit per-turn background). |
| **Needed** | Author acceptance of the event boundary, new-turn continuation, and close-stops/restart-expires rules, or a named alternative. |
| **Blocks** | spec 031 pause/resume runtime controls only (T006); plan display, cancel, expiry, and ordinary Edit turns are not blocked |
| **Owner** | spec 031 |

### D-179 · In-flight guidance semantics

| | |
| --- | --- |
| **Status** | Accepted (2026-11-03, on the author's delegation) |
| **Decision** | As recommended. The implementation (spec 031 T006–T008) is held out of the hackathon build: making Discuss the new-turn default changes how every turn in the recorded demo behaves, so it merges only with a re-shoot and a matching script and runbook update. |
| **Question** | Can new guidance be added to a running or paused plan, and does that revise the same plan or require a new turn? |
| **Recommendation** | No live steering: a running or paused plan cannot receive new guidance. The submitted prompt is fixed in the thread for the life of the turn; revised guidance travels by stopping and starting a new turn in the same conversation, which revalidates everything it touches. Guidance editing stays in the pre-send composer, proposed-plan review, `SKILLS.md` between turns, and each new turn's prompt. Rejected: same-plan mid-run revision (no live object to revise; races dispatch), a standing guidance queue (alternative A with extra state and staleness questions), live loop steering (no channel; breaks the D-178 event boundary and approval isolation), guidance-as-approval-answers (corrupts the audit trail). |
| **Evidence** | `specs/031-agent-interaction/research/inflight-guidance.md`; `apps/desktop/tests/inflight-guidance-premises.test.ts` (prompt fixity in-thread, stop-plus-new-turn guidance journey); `agent-threads.test.ts` (retry reuse); D-178 (event boundary, new-turn continuation). |
| **Needed** | Author acceptance of new-turn-only guidance, or a named alternative with a steer-capable protocol and trust-boundary design. |
| **Blocks** | spec 031 in-flight plan guidance only; pre-send guidance and proposed-plan editing proceed now |
| **Owner** | spec 031 |

### D-180 · Legacy import idempotency by content fingerprint

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | How does the studio recognise an already-imported legacy export, given the public legacy schema carries no old book identifier for 003 FR-030's match-by-identifier to use? |
| **Recommendation** | Fingerprint each legacy book with SHA-256 over canonical JSON (sorted keys, arrays in order) and keep `{ version, books: { fingerprint: { bookId, title, importedAt } } }` in `.studio/migrations.json`, written atomically after each import that adds books. A second run skips every fingerprint whose book still exists and names each recognised book in the report (`recognised: [{ title, bookId }]`); the library view says "Already imported N books. Nothing was added." A book deleted since the first run re-imports; an unreadable record warns and imports everything again rather than refusing the migration. Rejected: matching by title (legitimate duplicate titles collide — `createBook` allows them), a BookMeta origin marker (a schema and format change for one importer; the record is derived data whose loss only costs a re-import, never data). |
| **Evidence** | `apps/desktop/tests/legacy-import.test.ts` (double-run creates zero books and zero chapter files and names the recognised book; added-book run imports only the new one; corrupt record warns and re-imports). |
| **Needed** | Author acceptance of the fingerprint record, the archive-restore caveat (the record is excluded from portable archives, so re-importing after a restore imports again), and the re-import-on-delete semantic, or a named alternative. |
| **Blocks** | Nothing further; FR-038 closes on acceptance. |
| **Owner** | spec 003 |

### D-181 · Legacy picture pages import as plain image records

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | How do legacy image pages and versions land in the studio when `ImageRecord` has no page, version, anchor or current fields and the old anchor format is unverified locally? |
| **Recommendation** | Every image version present in the export's image map is decoded and stored through `ImageStore.add` as source `imported` (kind `cover` for a cover-flagged page's pictures, `other` otherwise), with prompt, model and cost carried where the entry has them and dimensions and MIME read from the bytes, never the declaration. Missing, unreadable and oversized pictures become author-words warnings and never fail the book. Deferred: marking the current version (no model home), rebinding chapter anchors (no guessing at the unverified old format), the cover include-in-export setting (export-pipeline work), image style (003 FR-011), and a kept page with no picture (needs a page model). Rejected: importing only the current version (hides surviving bytes the author may want); inventing anchor parsing from the abstract spec (a wrong guess corrupts chapter bindings). |
| **Evidence** | `apps/desktop/tests/legacy-import.test.ts` picture tests (byte-identical round-trip, cover kind, mismatch warning, missing/unreadable warnings, picture double-run recognition). |
| **Needed** | Author acceptance of flat records now with page-model work later, or a named page model. |
| **Blocks** | 003 FR-021/022/023/024 full compliance only; the carried bytes, counts and warnings above proceed now. |
| **Owner** | spec 003 |

### D-182 · Book grid reads every chapter; the catalog stays unread

| | |
| --- | --- |
| **Status** | Proposed |
| **Question** | `listBooks` re-reads `book.json` plus every chapter file of every book to build grid stats, while `library.json` already carries `chapterCount` and `wordCount` per book but is documented as never read as truth. When, if ever, does the grid stop paying novel-scale reads? |
| **Recommendation** | Keep re-reading for now: the catalog is untrusted by design because a sync folder can hand the app a stale copy, and trusting it would trade silent stale grids for speed. Per-book stats in `book.json` would need every mutation path (save, delete, trash, restore, import, conflicts) to maintain them — a format change with wide regression surface. Revisit only with measured evidence of a slow library; local-disk reads are millisecond-scale for realistic libraries. Rejected: trusting the catalog without a staleness story (contradicts `FORMAT.md` and risks showing wrong counts after external sync); stuffing stats into `book.json` now (cost without a measured problem). |
| **Evidence** | `packages/core/src/library/service.ts` (`listBooks`, `summarize`, `rebuildCatalog`), `docs/FORMAT.md` (`library.json` "never reads it as truth"), `packages/core/tests/library-service.test.ts` (grid stats summed from chapters, catalog consistency). |
| **Needed** | Author acceptance of re-reading until measured slowness, or a named staleness story for catalog trust. |
| **Blocks** | Only the "opens without loading all" clause of 002 FR-003; the grid stats themselves are proven above. |
| **Owner** | spec 002 |

### D-183 · Word (DOCX) manuscript import

| | |
| --- | --- |
| **Status** | Accepted (2026-11-03, on the author's delegation) |
| **Question** | Should the manuscript importer accept Word documents, and through which parser? |
| **Decision** | Yes, on the macOS desktop reference target first, which is 029's platform matrix. The importer sniffs the zip container, then uses `mammoth`, which is already a dependency, as the T014 research recommends. Mammoth's HTML becomes canonical chapter bodies under `docs/FORMAT.md`'s rules. The import goes through the existing preview and the same staged atomic publication as TXT and Markdown, and headings are proposed as chapter boundaries for the author to confirm. Nothing is dropped silently: tables, images, comments and tracked changes the body cannot carry are listed in the import report. Images are never stored as base64. ODT, DOC and RTF stay refused. |
| **Evidence** | `specs/029-manuscript-import/research/docx-intake.md`; `apps/desktop/tests/docx-intake-validation.test.ts`; implemented in spec 029 T018: `apps/desktop/tests/docx-import.test.ts`, `packages/core/tests/manuscript-import-docx.test.ts` and the hidden smoke Word journey. |
| **Blocks** | 002 FR-035 and the DOCX row of spec 029's format matrix. |
| **Owner** | spec 029 |

### D-184 · An in-memory credential vault for end-to-end tests

| | |
| --- | --- |
| **Status** | Accepted (2026-11-03, on the author's delegation) |
| **Question** | How can an end-to-end test run a real agent turn through the built app without reading or writing the author's keychain? |
| **Decision** | The vault may hold credentials in memory only, under two conditions: the process is started with an explicit test flag, and the app is not packaged. It never writes a secret to disk. It is never a fallback when protected storage is unavailable; that case still refuses to save and explains why. Packaged builds and unflagged runs refuse it, and a test proves that. An end-to-end run points a connection's base URL at a fake OpenAI-compatible server on loopback, so no provider, key or network is involved. |
| **Evidence** | `apps/desktop/src/main/credentials.ts` (safeStorage vault); AGENTS.md "Credentials" (no plaintext fallback). |
| **Blocks** | End-to-end proof of the agent loop (002 agent requirements, 011 FR-051's positive case). |
| **Owner** | spec 012 |

### D-185 · Interface components from shadcn/ui and AI Elements

| | |
| --- | --- |
| **Status** | Accepted (2026-11-03, on the author's direction) |
| **Question** | Should the studio keep hand-rolled interface components, or adopt shadcn/ui components and the AI Elements patterns for the agent interface? |
| **Decision** | Adopt them. shadcn/ui components and the AI Elements patterns (Message, Tool, Confirmation, Context, Checkpoint, Prompt Input, Suggestion, Model Selector and the rest the studio needs) are copied into the repository, which is how shadcn/ui is meant to be used. Choose the Radix flavour where one exists, to match the `@radix-ui` primitives already in use. They are themed with the vendored Liquid Glass tokens and follow AGENTS.md's interface rules: tokens only, no raw colours, no invented shadows, no gradients except `.window-wash`. The renderer adapts the studio's own message parts to the components' props and never adopts AI SDK `UIMessage` (ADR 0013). Hand-rolled components remain only where no shadcn/ui component fits. |
| **Evidence** | <https://ui.shadcn.com/docs/ai-elements>; `packages/ui` (current Radix and class-variance-authority primitives). |
| **Owner** | spec 013 (`packages/ui`) |

### D-186 · Open-source attribution generated from the build

| | |
| --- | --- |
| **Status** | Accepted (2026-11-03, on the author's direction) |
| **Question** | Where does the list of third-party licenses come from, and where does the author see it? |
| **Decision** | The build generates it. It collects every package in the renderer and web bundle graphs, plus the main-process dependencies that electron-vite leaves external and the packaged app ships, with each package's name, version, license and license text. Electron's Chromium credits are included. The same data regenerates `THIRD_PARTY_NOTICES.md` and appears in Settings → About → Open-source licenses on desktop and web. A gate fails when a bundled package has no license or an unknown one. A hand-maintained list is no longer the source of truth. |
| **Evidence** | `scripts/licenses.mjs` (collector and plugin), `scripts/license-gate.mjs` and `scripts/license-allow.json` (the gate in `bun run submission:check`), the generated `THIRD_PARTY_NOTICES.md`; `apps/desktop/tests/licenses.test.ts`, `license-gate.test.ts`, `licenses-dialog.test.tsx`; D-137. |
| **Owner** | spec 009 / 013 |

### D-187 · Which file is a chapter when a sync tool copies it

| | |
| --- | --- |
| **Status** | Accepted (2026-11-04, on the author's delegation) |
| **Question** | A sync tool's copy of a chapter file (`0002-the-door 2.md`, `0002-the-door (1).md`) keeps the original's `id`. Which file is the chapter, and what happens to the other? (QA D1) |
| **Decision** | A name with a sync tool's copy mark (iCloud ` N` or Google Drive ` (N)` after a studio name, Dropbox and Nextcloud "conflicted copy", Dropbox's "(Case Conflict)" and "(Selective Sync Conflict)", Syncthing `.sync-conflict-`, the studio's `.conflict-`) is never a chapter. Among the other readable files with one `id`, the chapter's file is the studio-shaped name `NNNN-slug.md`, then the shorter name, then character order. Every other file is a copy: listed with the conflict copies, never written, renamed, moved or deleted. Rejected: the oldest file by date, which the brief offered as an example, because an atomic save gives the file a new creation date (the chapter would move to its copy at the next save) and dates differ between devices; the highest `version`, because a copy's newer text would silently replace what the author opened. |
| **Evidence** | `packages/core/src/markdown.ts` (`isConflictCopyName`, `compareChapterFileNames`), `packages/core/src/library/service.ts`; `apps/desktop/tests/sync-copies.test.ts`, `packages/core/tests/chapter-copies.test.ts`; `docs/FORMAT.md` "Copies of a chapter". |
| **Owner** | spec 016 |

### D-188 · The web build replaces modules the browser never runs with refusing stubs

| | |
| --- | --- |
| **Status** | Accepted (2026-11-04, on the author's delegation) |
| **Question** | The SC-009 perf gate counts every JavaScript byte the web build ships, so code splitting cannot make room under its limit (1.2 times the baseline). How does the browser build drop shared code it can never run, when the bundler cannot prove that code dead? |
| **Decision** | A resolver in `apps/web/vite.config.ts` swaps each listed module for a stub in `apps/web/src/desktop-only/`, in the web build only. A module is listed only when the browser cannot reach it: zod's JSON Schema emitter and processors, which zod hangs on every schema it builds but only the desktop agent's tool definitions use, and the manuscript import flow (the core import module and its preview and result dialogs), which the library offers on the macOS desktop only (spec 029 T004, T016). Every stub refuses plainly if reached. The zod stubs export every name of the modules they replace, and a test fails when a zod upgrade adds one. A stubbed zod module also takes zod's check getters (`minLength`, `format` and the like), so the studio does not read them; a shared module that needs them comes off the list. Shared code, the desktop build and the gate's limit and baseline are unchanged. Rejected: a compile-time flag in shared code, which would change the desktop bundle and still keep the import handlers; loosening the limit. |
| **Evidence** | `apps/web/src/desktop-only/` (the list and the stubs), `apps/web/tests/desktop-only.test.ts`; `bun run perf`: the web bundle went from 917,120 to 886,906 bytes (1.19 to 1.15 times the baseline), and the CSS and the desktop build are byte-identical; `bun run smoke:web`, `bun run e2e`, `bun run visual` and `bun run a11y` pass without new baselines. |
| **Owner** | spec 012 (SC-009) |

### D-189 · Words a close or quit could not save are kept in the profile

| | |
| --- | --- |
| **Status** | Accepted (2026-11-04, on the author's delegation) |
| **Question** | Where do the words go when the last save before a close or quit cannot write to the library, and how do they come back? |
| **Decision** | Into `userData/recovery/`: one owner-only JSON file per refused draft, written atomically, with its book and chapter ids, the version and hash it was typed against, the reason and the time. The author is asked before the app goes: stay, or leave with the words kept. The next time the book opens, the workspace offers each copy. Restoring goes only through the checked save, so a chapter that changed since keeps the words as a conflict copy; discarding is an explicit, confirmed choice, and nothing removes a copy automatically. The library stays the only source of truth: a kept copy is a disposable draft, never read as the chapter. Rejected: writing beside the chapter (the folder is what failed, and a sync service would spread the copy); keeping the words only in memory (lost at quit); restoring them at launch without asking (a silent overwrite risk); deleting a copy after a later save of the chapter (the editor reloads from disk, so that would delete the only copy). |
| **Evidence** | `apps/desktop/src/main/recovery.ts`, `exit-guard.ts`, `packages/app/src/components/RecoveryPanel.tsx`; `apps/desktop/tests/recovery.test.ts`, `failed-save.test.tsx`; `docs/FORMAT.md` ("Words kept after a failed close or quit"); the QA stress audit's D2. |
| **Owner** | spec 002 (FR-013) |

### D-190 · Every write into a book refuses a newer schema; every object in `book.json` is loose

| | |
| --- | --- |
| **Status** | Accepted (2026-11-06, on the author's approval of the file-safety fixes) |
| **Question** | What may a write do to a book another device has upgraded to a newer schema while the book is open? And what happens to a field this build does not know inside a character, a memory, the story arc or a settings section? |
| **Decision** | Every write into a book first reads `book.json` and refuses a newer `schemaVersion` with the standard message, before anything is written (`library/schema-guard.ts`, called from `serializeWrite`, the image store's writes and the thread store's writes). A missing or unreadable `book.json` is left to the write's own checks, so a half-synced file never blocks a save. Every object in `book.json` is loose, so a field this build does not know is kept and written back at every level. `storyArc` notes are text; the array shape FORMAT.md once described is read as one line per item. |
| **Rejected** | Checking the schema only when the book is opened: another device can upgrade `book.json` while the book is open, and a save would then write into a book this build does not understand. Refusing the documented arrays: one unknown shape would hide the whole book. Stripping unknown nested keys: silent data loss for whatever a newer build added. |
| **Evidence** | `packages/core/src/library/schema-guard.ts`; `apps/desktop/tests/book-json-safety.test.ts` (unknown fields at every level through the studio's own saves and the agent's tools, the documented arrays, and a schema-2 refusal on every write path with the bytes unchanged); `packages/core/tests/format-profile-premises.test.ts`. |
| **Owner** | spec 002 FR-008 |

### D-191 · A no-keychain mode for hidden interface checks

| | |
| --- | --- |
| **Status** | Accepted (2026-11-07, on the author's approval of the file-safety fixes) |
| **Question** | How can a hidden interface check run the real app without it ever asking the operating system's protected storage, which on macOS can reach the author's keychain? |
| **Decision** | An unpackaged run started with both `STUDIO_TEST=1` and `STUDIO_NO_KEYCHAIN=1` uses a cipher that reports protected storage as unavailable and refuses to encrypt or decrypt, before the operating system is asked (`selectTestCipher`, chosen by the desktop vault's constructor, so its availability and status reads never reach `safeStorage` either). It is a refusal and not a fallback: nothing is written, no plaintext file exists, and the interface says protected storage is unavailable as it would on a machine without it. Either flag alone, or a packaged build, keeps protected storage. `scripts/smoke.mjs` sets both flags and starts the app with an allowlisted environment (`scripts/headless-environment.mjs`), so a provider key or STUDIO_ flag from the caller's shell never reaches it. |
| **Rejected** | Reusing D-184's in-memory vault for the smoke run: it reports storage as available and holds keys, which the interface checks have no use for. A single flag: a STUDIO_TEST left in a shell would then switch protected storage off for an ordinary run. |
| **Evidence** | `apps/desktop/tests/credential-isolation.test.ts`, `apps/desktop/tests/credentials.test.ts`, `apps/desktop/tests/headless-environment.test.ts`; AGENTS.md "Credentials". |
| **Owner** | spec 012 |

## Resolved browser decisions

### D-104 · OpenRouter OAuth redirect on desktop and web

| | |
| --- | --- |
| **Status** | Accepted |
| **Decision** | Desktop uses the ephemeral loopback callback. Web uses a same-origin redirect. Both use PKCE S256, validate and consume state once, exchange the authorization code once, and remove callback parameters from the visible URL/history after handling them. Manual key entry remains the fallback where OAuth cannot complete. |
| **Evidence** | Desktop happy path, wrong state, provider failure and cancel tests exist in `apps/desktop/tests/providers-service.test.ts`. Web callback is gated by the existing D-101 browser-access table and specified in [ADR 0011](adr/0011-browser-credentials.md). |
| **Blocks** | Spec 011 web connection tasks and spec 010 browser integration. |

### D-105 · Key storage in the browser

| | |
| --- | --- |
| **Status** | Accepted |
| **Decision** | Use an origin-scoped IndexedDB vault with explicit disclosure. Do not add a passphrase or claim OS-keychain-equivalent or encrypted-at-rest protection in v1. Forget removes the credential. Never export it, place it in the library, log it, or send it anywhere except the chosen provider after an author-requested action. |
| **Evidence** | IndexedDB is origin-scoped, but same-origin scripts can access it; a Web Crypto wrapping key does not protect against compromised code running on that origin. Passphrase encryption adds a recovery secret without removing that risk. See [ADR 0011](adr/0011-browser-credentials.md), spec 011 US7 and spec 010 research. |
| **Blocks** | None. Spec 011 T037 implements this decision; spec 010 supplies the storage boundary. |

### D-112 · Portable archive format

| | |
| --- | --- |
| **Status** | Accepted |
| **Decision** | Use a versioned ZIP archive with `manifest.json`, normalized relative paths and per-file hashes. Preserve format-defined and unknown author files; omit only documented derived, transient and per-install data. Import only to a new library or empty chosen destination; reject unsafe paths, bad hashes and unsupported future versions before publication. Never merge or overwrite an existing library silently. |
| **Evidence** | See [ADR 0012](adr/0012-portable-library-archive.md), spec 010 research and contracts. The archive is a transport format; ordinary library files remain the source of truth. |
| **Blocks** | Spec 002 FR-056, spec 010 archive work and spec 013 build integration. |

### D-114 · Test runner boundaries

| | |
| --- | --- |
| **Status** | Accepted |
| **Decision** | Use Bun's test runner for pure core, adapters and component logic; use Playwright on Node for browser and Electron end-to-end runs; live provider checks stay explicit opt-in and spend-capped. |
| **Evidence** | Accepted in spec 012's 2026-10-24 clarification session. Electron packaging and Playwright remain on Node; Bun owns workspace tests. |
| **Blocks** | Spec 012 browser/Electron E2E and spec 010 adapter verification. |

## How an entry moves

1. `Open` → `Researching`: someone is gathering evidence; add findings under the entry or in `docs/research/`.
2. `Researching` → `Proposed`: write the recommendation and the alternatives considered.
3. `Proposed` → `Accepted`: the user accepts; if the decision is significant, write an ADR and link it.
4. `Accepted` → task: the spec that depends on it gets a task citing the decision ID.
5. If it later proves wrong: mark `Superseded`, keep the text, link the replacement. Do not delete history.

## Voice and background decisions (2026-10-26)

| ID | Status | Question | Decision | Evidence | Tasks |
| --- | --- | --- | --- | --- | --- |
| D-125 | Accepted | Does the studio keep the audio a dictation sends to Meta? | No. Audio exists in renderer and main memory for one request, is converted to the WAV Meta documents and is discarded. It is never written to the library, thread store, archive or a temporary file. A future kept-recording feature needs its own format, consent copy and deletion path. | `packages/core/src/providers/speech.ts`, `apps/desktop/src/main/voice.ts`, spec 017 FR-004 | 017 T001–T006 |
| D-126 | Accepted | What may a background turn do, and how does it reach the author? | A turn is background only when the author opts in for that turn. It notifies on finish, failure or an approval pause, focuses the window on click and never auto-approves a destructive tool. "Reach out" means a native notification, not email or a network message. A quit app stops all work. | `apps/desktop/src/main/background-copy.ts`, `background.ts`, `agent/runtime.ts`, spec 017 FR-010–FR-017 | 017 T008–T010 |
| D-127 | Accepted | Can the browser build dictate? | Not yet. The browser surface returns a specific refusal until Meta's browser access passes the D-101 table. Recording first and failing afterwards is forbidden. | `apps/web/src/runtime/browser-api.ts`, spec 017 FR-008 | 017 T006; D-101 browser test |

## Agent toolkit decisions (2026-10-26)

| ID | Status | Question | Decision | Evidence | Tasks |
| --- | --- | --- | --- | --- | --- |
| D-128 | Accepted | How can a standalone CLI or MCP client reach the open library without a second copy or a hosted service? | The desktop starts a loopback-only HTTP backend on a random port with a 256-bit per-run token, writes an owner-only locator at `~/.ai-book-studio/backend.json`, refuses browser origins and non-loopback Host headers, and removes the locator on quit. The toolkit is read-only by default; create and checked-save tools require `--allow-writes`. Every call goes through the open `Studio` and `Library`. | `apps/desktop/src/main/backend.ts`, `apps/toolkit/`, spec 018 FR-001–FR-014 | 018 T001–T010 |
| D-129 | Deferred | Should an agent reach the library remotely through a tunnel or hosted MCP endpoint? | Not in v1. Remote access would add authentication, custody and revocation; the loopback backend deliberately has no LAN listener. Revisit with a dedicated ADR if the toolkit needs a remote client. | spec 018 non-goals, D-128 | None |

## Illustration decisions (2026-10-26)

| ID | Status | Question | Decision | Evidence | Tasks |
| --- | --- | --- | --- | --- | --- |
| D-130 | Accepted | One image manifest or fields inside `book.json`? | A separate versioned `images.json` beside an `images/` folder. It keeps `book.json` small, gives the archive a clean diff and lets the image store serialize its own writes. | Spec 019; `packages/core/src/images/` | 019 T001–T008 |
| D-131 | Deferred | Multi-turn image editing, reference images and masks? | Not in v1. One-shot generation and the SAM cutout cover the demo; editing needs a conversation-state decision and a new cost model. | Spec 019 non-goals | None |
| D-132 | Superseded | Where is the cutout PNG composited? | In the renderer from the source image and the decoded binary mask, so the desktop adds no native image library. The result is saved through the image store as a `character` image with `cutoutOf`. Superseded by D-158: the cutout was removed from the build on 2026-11-04. | Spec 020 FR-007 | 020 T004 |
| D-133 | Deferred | Manual box/point SAM prompts? | Not in v1. Concept prompts plus an author-selected match are enough for the demo; manual prompts need a canvas coordinate UI and the documented token builder. | Spec 020 non-goals | None |

## Licensing decisions (2026-10-26)

| ID | Status | Question | Decision | Evidence | Tasks |
| --- | --- | --- | --- | --- | --- |
| D-137 | Superseded | May the desktop use Meta's `@meta-sam/parser` when the project is Apache-2.0? | Yes for the hackathon build, with the SAM License included in `THIRD_PARTY_NOTICES.md` and the distribution. The feature is optional and desktop-only. Before a public release, review compatibility or replace the parser with a clean-room implementation; do not claim the repository is Apache-2.0 while silently shipping an incompatible dependency. Superseded by D-158: the parser left the build with the cutout on 2026-11-04, so the desktop ships nothing under the SAM License and the license gate allows no exception. | `THIRD_PARTY_NOTICES.md`, spec 020 FR-013 | 020 T007 and release review |

## Provider compatibility decisions (2026-10-26)

| ID | Status | Question | Decision | Evidence | Tasks |
| --- | --- | --- | --- | --- | --- |
| D-138 | Accepted | How does the app use Muse Spark 1.3 Contributor without sending an author's private book to a training-eligible model? | Contributor is opt-in per book (`allowContributorTraining`, default false). The model picker shows the training warning, prices and reasoning limit and requires a checkbox; `AgentRuntime` refuses the model before any request until consent exists. Contributor is for the synthetic fixture/public-domain tests; Standard is the default alternative. | `packages/core/src/providers/compatibility.ts`, `AgentRuntime.start`, `ModelPickerDialog`; spec 022 | 022 T001–T008 |
| D-139 | Deferred | Should the compatibility layer also be a local OpenAI-compatible HTTP endpoint? | Not in v1. `modelFor` is the one AI SDK seam. A network gateway needs caller authentication, streaming, tool execution and approval ownership; it would be a separate spec. | Spec 022 FR-014 | None |
| D-158 | Superseded | Is SAM 3.1 the way to make a character cutout? | No. The live request reaches Meta and is accepted — `200`, `status: completed` — but the response carries no records and no usage, on two real illustrations and a synthetic disc, with four different nouns, in the shape Meta's own segmenting guide documents. Whether that is an entitlement gap or a model the account cannot use, it is not something the studio can fix, and the cutout was never on the critical path. Spec 020 is superseded. The code first stayed, tested, with nothing built on it; it was removed from the build on 2026-11-04 (the Illustration dialog's cutout, the segmentation channel and service, the live check's SAM step and the `@meta-sam/parser` dependency), so the shipped app matches the submission, which claims no cutout. An older library's `cutout` image record still reads (`docs/FORMAT.md`). | `docs/research/live-meta-2026-10-26.md`, spec 020 |
| D-159 | Accepted | How does the agent speak? | A provider seam for text-to-speech, with OpenAI's `/audio/speech` as the first adapter, and the browser's own `speechSynthesis` as the fallback when no voice service is connected. A chapter is longer than one request, so the pipeline splits the text at sentence boundaries and joins the audio back into one sound that plays and stops as a whole. The voice is a per-call choice, so a passage and a notification can sound different. | `packages/core/src/providers/tts.ts`, `apps/desktop/src/main/speech.ts`, `packages/app/src/hooks/use-speech.ts` |
| D-160 | Accepted | How does the author's own book reach the glasses? | The phone is the server and the glasses the client, through Meta's Device Access Toolkit: the toolkit sends UI content over Bluetooth and routes the interactions back. It is the only route that keeps the author's own book private (D-156, D-157): a Web App cannot read a private network, and a hosted copy is out of the question. The studio stays the only writer; the phone is a display and a remote control. | `apps/desktop/src/main/bridge.ts`, spec 026 | 026 T015–T018 (native companion) |
