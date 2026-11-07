# Tasks: automated verification

**Plan**: [plan.md](plan.md) · **Spec**: [spec.md](spec.md)

Tasks are ordered. `[x]` means the behavior exists and has been exercised; it does not mean every
future test case in that row is complete. Counts move, so they live in one place: `docs/TESTING.md`.
At this writing the suite is 835 Bun tests, `bun run e2e` is 8/8, the desktop smoke is 18/18, the web
smoke is 13/13, and coverage is 86.0% of functions and 93.0% of lines.

## Phase 1 — Inventory and fast truth

- [x] T001 Record the actual test inventory, layer owners, commands and known gaps in
      `tests/requirement-map.md`; map every current spec FR in 002, 010–014 and 016 to a test, a manual
      check or an explicit open gap. Current evidence: `tests/requirement-map.md` holds the layer
      inventory (owners, commands) and all 272 FRs — 148 covered, 14 manual, 110 gaps — mapped by
      seven parallel research passes with every cited path existence-checked, including the
      002 cross-references inside spec 010. Gaps cluster on the unbuilt ChatGPT plan flow, the
      unbuilt device lock, unregistered CI, unenforced workspace hygiene (T002 lint), export-format
      scope and timing budgets (T029). (Full suite 1042 pass, typecheck clean.)
- [x] T002 Make one fast command the local source of truth: build-info, lint, typecheck, Bun tests,
      desktop bundle and web bundle. Add the chosen linter and fail on lint errors without autofixing
      in CI. Keep Playwright, packaging and provider calls out of the fast path. Current evidence:
      Biome 2 is the linter (D-162); `bun run lint` fails on errors and runs first in `bun run verify`
      and as a `.gitea/workflows/verify.yml` step, with no autofix anywhere. Landing it fixed 40
      errors: a hook-after-early-return in `ImportPreviewDialog`, a hook-named plain method
      (`useBrowserStorage` → `openBrowserStorage`), unstable effect deps corrected or documented as
      intentional triggers, `moveChapter` wrapped in `useCallback`, content-derived React keys,
      `role="status"` on the save-status line, control-character security regexes kept and
      suppression-annotated, and explicit guards replacing assertions in tests and line-drain loops.
      The gate is zero errors; 163 warnings (mostly non-null assertions) stay visible advisory debt.
      (Full suite 1042 pass, typecheck clean.)
- [x] T003 Add a coverage report and thresholds: 90% lines/branches for core, library, archive, sync
      and browser storage; 70% lines for the interface. Publish the actual numbers; do not invent a
      passing baseline. **Evidence:** `bun run coverage` measures the whole suite and fails below a
      floor that only moves up — 85% of functions and 92% of lines at the time of writing, against a
      measured 86.0 and 93.0. The per-area 90% target is met for library, archive, sync and browser
      storage; a few interface modules (the editor, the voice button) are still below 70% lines and
      are listed in `docs/TESTING.md` rather than rounded up.
- [x] T004 Add the fast result summary (passed/failed/skipped/quarantined) and a non-zero exit on any
      failed gate. Keep output redacted for credentials and manuscript text. Current evidence:
      `bun run verify` is now `node scripts/verify.mjs`, which runs build-info, lint, typecheck,
      quarantine:check, the Bun suite and both bundles fail-fast with each gate's output streamed,
      then prints the single summary (per-gate ok/FAIL/not-run with durations, test
      pass/fail/skip, quarantined count, overall PASS/FAIL) and exits with the first failed
      gate's code. Pure parse/format logic lives in `scripts/verify-summary.mjs` (typed via
      `.d.mts`) with `apps/desktop/tests/verify-summary.test.ts` covering counts, unknown
      counts shown as `?` never guessed, and a key-shaped leak proving the summary echoes
      nothing captured. Negative control (rigged lint failure): exit 3, FAIL row with code,
      later gates not run. (Full verify green: 1048 pass, both bundles built.)

## Phase 2 — Data-loss and format boundaries

- [x] T005 Core/format/library tests cover schema parsing, Markdown/front matter round-trips, version
      and hash conflicts, trash/restore, path traversal and search. Current evidence: `bun test` — 308
      passing across 45 files, including `packages/core/tests/library-service.test.ts`.
- [x] T006 Storage and archive fault injection covers stale bases, interrupted writes, permission loss,
      read-only folders, quota exhaustion, external edits, bad hashes, traversal and failed cleanup.
      Current evidence: `apps/web/tests/storage/save-failures.test.ts` and `packages/core/tests/archive.test.ts`.
- [x] T007 Add property-based tests for Markdown/front-matter round-trips, slug generation, version
      increments and conflict decisions. Keep generated inputs synthetic and deterministic.
      Implemented without a sampling library: fixed-seed mulberry32 generators in
      `packages/core/tests/markdown-properties.test.ts` (250-case front-matter round-trips over
      adversarial metadata/bodies, normalizeBody idempotence and shape, slug safety/bounds/
      determinism, order round-trip within the four-digit file-name bound, conflict-name
      classification both ways, word-count invariance under normalization) and
      `packages/core/tests/save-decision-properties.test.ts` (version moves by exactly one,
      wrong-hash conflicts as external-edit without landing, stale versions conflict as
      newer-version, one winner per base). 10 tests, ~4,100 assertions, same cases every run.
- [x] T008 Add a damaged-file isolation test: a truncated/malformed chapter fails alone, the rest of
      the book remains readable, and the app explains the affected file. **Done:** the library-open
      path is proven by `packages/core/tests/damaged-file-isolation.test.ts` (malformed files fail
      alone with per-file `invalid-format` issues while the book lists and healthy chapters save;
      prose without front matter stays readable, never an issue), and the workspace names the
      skipped file with its reason in a dismissible line while the healthy chapter stays usable
      (`apps/desktop/tests/chapter-read-issues.test.tsx` drives the real `WorkspaceView`). The
      pre-existing partial work stands: the sync drift detector and the browser folder port report
      an unreadable file per file, and `apps/web/tests/storage/directory-port-contract.test.ts`
      covers a damaged identity file being replaced.
- [x] T009 Add a failed-write/rename/disk-full test at the desktop adapter boundary with a real
      temporary library, proving the previous complete file remains and temp files are removed.
      **Evidence:** `apps/desktop/tests/atomic-write.test.ts` — a target that cannot be replaced, a
      folder that disappears, a read-only folder and two writers racing. The rename-retry path and
      the best-effort directory fsync are the two lines still uncovered, because they only happen on
      a platform failure that a test cannot provoke portably.

## Phase 3 — Contracts and interfaces

- [x] T010 Provider contract tests replay committed fixtures for OpenRouter and the other registered
      providers, including usage/cost metadata and unknown fields. Current evidence:
      `packages/core/tests/providers-contract.test.ts` and `apps/desktop/tests/providers-service.test.ts`.
- [x] T011 Add OAuth state, expiry, duplicate-exchange and cancellation tests for every sign-in flow,
      with no network and no real account identifier. Done for the OpenRouter SSO flow, the only
      sign-in flow the product implements: `packages/core/tests/openrouter-callback.test.ts`
      (state match/mismatch/missing/expiry, provider decline, missing code, malformed address,
      refusal messages carry no code; PKCE shape and an independent SHA-256 challenge check;
      authorize address parameters) and `apps/desktop/tests/oauth-signin.test.ts` (real loopback
      server with stubbed browser and key exchange: mismatched callbacks exchange nothing and
      free the flow, the first callback wins and a duplicate never connects, cancellation
      rejects/exchanges nothing/frees, a second waiting start is refused, exchange posts only to
      the OpenRouter key endpoint with the S256 verifier). The key-exchange fetch is injected and
      counted; no packet leaves localhost. The deprecated ChatGPT-plan manual pass (T025) is not
      a sign-in flow and stays manual.
- [x] T012 Add component tests for the composer, editor, chapter rail, connection cards and conflict
      banner, including keyboard and focus behavior. Editor history/debounce
      were already covered; now `apps/desktop/tests/chapter-rail.test.tsx` drives the real
      `ChapterRail` (list, empty state, select + `aria-current`, add, move with edge/busy
      disabling, delete, native keyboard focus) and
      `apps/desktop/tests/chapter-reorder-conflict.test.tsx` drives the real `WorkspaceView`
      (Command/Ctrl+Alt+Arrow moves the selected chapter, an open dialog suppresses the shortcut,
      a lost autosave shows the save-conflict banner with the honest reason, the saved copy path
      and both working actions, and earlier sync copies show the folder action). The conflict
      test records that switching chapters resets the banner by design, so the banner is asserted
      on the stayed-on chapter. Plus `apps/desktop/tests/chat-composer.test.tsx` (Enter to send,
      Shift+Enter newline, turn-model carry-over, running Stop, keyboard focus) and
      `apps/desktop/tests/connection-cards.test.tsx` (kind copy, on-demand Test with busy
      disabling, Models catalogue with context sizes, two-step Remove, keyboard focus).
      Editor history/debounce were already covered. T012 is now complete: composer, rail,
      connection cards and both conflict banners are driven through the real components.
- [x] T013 Add browser E2E for welcome → storage → create → write → save → reload → conflict → archive,
      plus folder permission loss/recovery and no silent tier switch. Current evidence: web smoke 18/18 —
      the API journey plus the interface journey in `scripts/web-smoke/main.cjs` (library card opens the
      book, real keystrokes in the editor reach Saved, a page reload keeps the typed prose, a stale UI
      save reports Not saved with the conflict copy named after reopen, and the export button produces
      the archive). Denied/cancelled folder handling stays silent-switch-free in the storage harness
      (`apps/web/check/main.ts`) and `permission-recovery.test.ts`/`folder-mode.test.ts`; the native
      folder-picker clicks remain a manual pass (a user-initiated dialog cannot be driven headless).
      Agent edit/undo/export journeys remain.
- [x] T014 Add packaged desktop E2E for launch → fixture library → write → save → reopen → agent panel,
      using throwaway paths. Current evidence: packaged smoke 27/27 on the current tree. The Settings-open
      stall is fixed and documented: opening Settings called the synchronous keychain round-trip, which
      wedged the packaged app when macOS wanted confirmation (main thread sampled in
      `SecItemCopyMatching`; dev passed only because its keychain item was already allowed). Per D-161,
      opening Settings never probes: `status()` is now a fast availability read on desktop and web, and
      the round-trip moved to an explicit `connections:check` channel behind the Check control
      (`FileCredentialVault.check`, `BrowserCredentialVault.check`, `ProviderService.check`, preload,
      `SettingsDialog.checkKeychain`). `evaluate()` in `apps/desktop/src/main/smoke.ts` now fails with
      window state after 15s instead of burning the run, and crash/unresponsive listeners name a dead
      renderer. `scripts/smoke.mjs` accepts `SMOKE_APP` to point the packaged run at any build.
      (Full suite 1022 pass, typecheck clean, hidden smoke 27/27.)
- [x] T015 Add a CSP test per served route and an Electron fuse check for production builds; assert the
      renderer cannot access Node or arbitrary filesystem paths. Current evidence: web `index.html`
      connect-src narrowed to `'self' https://openrouter.ai` (the only external host the browser
      build contacts; the bare `https:` wildcard is gone) and the three loopback check harnesses
      carry a `connect-src 'self'` policy; `apps/web/tests/csp.test.ts` asserts every served route
      against the registry capability table (`no`/`unknown` providers stay out). `scripts/flip-fuses.mjs`
      runs as the builder `afterPack` hook with all nine V1 fuses explicit: RunAsNode, node-options
      env and CLI inspect off, OnlyLoadAppFromAsar on; cookie encryption, asar integrity, the
      file-protocol privilege and the snapshot/wasm defaults stay documented in the hook.
      `apps/desktop/tests/fuses.test.ts` guards the hook table, the builder wiring (`afterPack`,
      `asar: true`) and the sandboxed window flags. A packaged readback confirms the shipped states
      (full suite 1017 pass, typecheck clean, hidden smoke 27/27).

## Phase 4 — Human-facing checks

- [x] T016 Add axe-core accessibility checks on welcome, library, workspace, chat, Story Bible, settings
      and conflict views at 393×852, 744×1133, 1024×700 and 1440×900. Fail critical/serious findings and
      assert focus order for composer/editor. Current evidence: `bun run a11y`
      (`scripts/accessibility-check.mjs` + Playwright + axe-core) scans all seven views at all four widths
      in headless Chromium (28 scans), asserts the editor is tab-reachable, the composer is tab-reachable
      with no keyboard trap, and fails on critical/serious findings only. Fixed en route: the icon-only
      New book button had no accessible name at 393px (now `aria-label="New book"` with the visible label
      hidden from the tree), the archive buttons' `aria-label`s did not contain their visible text
      (removed in favour of the visible label), and the welcome view had no `main` landmark. Pure gate
      logic lives in `scripts/accessibility-gate.mjs` (typed via `.d.mts`) with committed tests in
      `apps/desktop/tests/accessibility-gate.test.ts`. (Full suite 1029 pass, typecheck clean.)
- [x] T017 Add visual baselines for the same screens in light/dark, reduced motion and reduced
      transparency. Update baselines only with an explicit command; no retries to hide a diff.
      Current evidence: `bun run visual` (`scripts/visual-check.mjs` + Playwright screenshots) captures
      welcome, library, workspace, chat, settings, Story Bible and conflict at four widths in four
      variants (light, dark, light+reduced-motion via context option, light+reduced-transparency via
      CDP emulation) — 112 committed PNGs under `scripts/visual-baseline/`, failing past a hair of
      pixels with the actual kept for inspection and no retry anywhere. Pure comparison logic lives in
      `scripts/visual-compare.mjs` (typed via `.d.mts`) with committed tests in
      `apps/desktop/tests/visual-gate.test.ts`. Save times and the random library identity are masked;
      everything else gates. Baselines are machine-rendered and re-accepted with `--update-baseline`.
      (Full suite 1033 pass, typecheck clean; gate re-ran green after a delay.)
- [x] T018 Add performance checks: open a 120-chapter/250,000-word book, switch chapters, save, and
      measure initial web bundle size/time-to-interactive. Fail only at the spec's regression thresholds.
      Current evidence: `bun run perf` (`scripts/perf-check.ts`) builds a deterministic 120-chapter /
      ~250,000-word library in a temp dir, times cold open, chapter reads and saves through the real
      filesystem port, measures the built web bundle (+gzip) and the welcome render in headless Chromium,
      and gates only SC-009 (book open ≥2× baseline or bundle >1.2× baseline); every other number is
      reported. `scripts/perf-baseline.json` is committed and rewritten only by the explicit
      `--update-baseline` flag. `apps/desktop/tests/perf-gate.test.ts` covers the threshold math,
      determinism and the baseline shape; the gate itself was proven by collapsing the baseline and
      watching it fail. (Full suite 1027 pass, typecheck clean.)
- [x] T019 Add a repository/artifact secret scan, source-map check and manuscript-like text scan. Fail
      without printing the matching value. Current evidence: `scripts/submission-check.ts` exports
      `scanTrackedSecrets` (tracked text plus a `books/` forbidden path; the curated `samples/`
      corpus is secret-scanned only), `scanArtifactDir`/`scanArtifacts` (present `release/`, `out/`,
      `dist/`, `coverage/` bundles, flagging `*.map` files), `enablesSourceMaps` plus
      `sourceMapConfigProblems` (bundler configs must not enable maps), and `proseProblems`
      (chapter-format files outside `samples/`/`docs/FORMAT.md`, and runs of 12+ story-prose lines
      in code). Every finding names the file and reason only, never the value.
      `apps/desktop/tests/secret-scan.test.ts` covers synthetic positives, no-value-leak
      assertions, and the clean real tree (full suite 1010 pass, typecheck clean).

## Phase 5 — CI and release gates

- [x] T020 Add the Gitea verify workflow file (install, build-info, typecheck, tests, desktop/web
      bundles). Current evidence: `.gitea/workflows/verify.yml` exists. No runner is registered, so the
      gate is not yet enforced.
- [ ] T021 Register a Gitea runner, enforce the named gates on merge requests and upload failure traces,
      screenshots, logs and fixtures with redaction. Until this lands, local `bun run verify` is the
      source of truth and the README makes no passing-badge claim.
- [x] T022 Add lint, coverage, browser E2E, desktop smoke, accessibility, visual and security to the
      required merge/release gate list; make a waiver name a reason, owner and expiry. Current
      evidence: `.gitea/workflows/verify.yml` now gates the verify job on lint (added T002),
      quarantine, waiver, coverage (`bun run coverage`) and security (`bun run submission:check`)
      plus desktop/web bundles, with a `browser` job (`smoke:web`, `a11y`, `visual` in headless
      Chromium) and a `smoke` job (hidden desktop smoke under xvfb). `docs/WAIVERS.md` is the
      single-source waiver ledger (ID, gate, reason, owner, waived, expires; empty today) with
      the process (one live row per gate, 30-day max, expiry fails); `bun run waiver:check`
      (`scripts/waiver-check.ts`) fails on expired or malformed rows and runs inside
      `bun run verify`; `apps/desktop/tests/waiver.test.ts` covers the empty, live, expired,
      malformed, duplicate and headerless cases with fixed dates. The release job that consumes
      the ledger stays T023. (Full suite 1053 pass, typecheck clean, verify PASS.)
- [x] T023 Add the release job that runs the full suite, packaged E2E and artifact checks; block on any
      failing gate or unexpired waiver. Current evidence: `.gitea/workflows/release.yml` (tag
      `v*` + manual dispatch, install, Chromium, `xvfb-run bun run release`; signing excluded per
      D-115) and `bun run release` (`scripts/release.ts`): clean-tree check, `bun run verify`,
      desktop/web/packaged smoke against those exact artifacts, web + desktop tarballs with
      sha256, post-packaging artifact scan, waiver-aware verdict, and a `releases/` record
      (commit, version, schema, gates, waivers, checksums, capability diff, unsigned status,
      pending manual checklist). Enforcement logic lives in `scripts/release-enforce.ts` with
      `apps/desktop/tests/release-enforce.test.ts` (go/waived/blocked/expired/malformed plus
      gate parsing, artifact discovery, capability diff and record rendering). Verified:
      enforcement and record unit tests pass; the dirty-tree negative control blocks with exit 1
      before writing anything; lint/typecheck clean; full suite 1062 pass. The full positive
      release run still needs a clean tree (and a runner for the workflow); packaged smoke last
      passed in the T014 era on the same smoke module. The ledger now maps 012 FR-033 as covered.
- [x] T033 Make the coverage gate measure the repository's own files. `bun test --coverage` also lists
      the TypeScript plugin fixtures that tests write into temporary folders (`studio-capabilities-*`,
      `studio-plugins-*`), most at 0% of functions and a different set each run, and bun's "All files"
      line averages them in. So `bun run coverage` failed at 84.83% of functions and 90.69% of lines
      while the repository's own 179 files stood at 87.58% and 90.65%. Current evidence:
      `scripts/coverage-check.mjs` parses bun's per-file rows and keeps the files inside the
      repository root (by `path.relative`, so a sibling folder sharing the root's prefix is outside).
      It prints the count and paths it left out and checks that bun's summary is still the unweighted
      mean of its rows. It fails on a missing, malformed or truncated table. The method and the 85/92
      floor are unchanged. `apps/desktop/tests/coverage-check.test.ts` covers the parser, the filter
      and the verdicts with synthetic tables. Line coverage then rose through tests of existing
      behaviour:
      - IPC handlers through `registerIpc`, covering refusals, envelopes, library results on disk and
        dialogs;
      - the live check against stubbed providers;
      - the desktop credential vault, the draft buffer and the settings store;
      - the ambient "last said" line and damaged Word files;
      - the search, book settings, new book and blocked-review dialogs.

      Verified: `bun run coverage` PASS at 90.70% of functions and 93.26% of lines over 180 files
      (bun's summary 87.85/93.21); full suite 1566 pass, twice; `bun run verify` PASS. Two product
      defects were found and are left for a product change:
      - `DesktopCredentialVault.status()` tests `safeStorage.isAsyncEncryptionAvailable()` without
        awaiting the promise, so the status read always reports protected storage as available;
      - `library:importLegacy` passes the backup's text to `importLegacyBackup`, whose parser expects
        the parsed object, so every desktop backup import is refused as not a backup.

## Phase 6 — Live providers

- [ ] T024 Add opt-in live checks behind `LIVE_PROVIDER_TESTS`, one cheapest read-only call per
      configured provider, with `LIVE_SPEND_CAP_CENTS` as a hard stop. Skip absent keys with a reason;
      classify auth, quota, network and provider errors separately.
- [ ] T025 Record the manual ChatGPT plan pass and the release-day provider checklist; do not automate a
      browser session or store a real account identifier.
- [ ] T026 Add a live-test failure artifact showing the provider, model, request shape with authorization
      redacted, latency and error class.

## Phase 7 — Diagnostics, quarantine and budgets

- [x] T027 Add Playwright traces/screenshots/console logs and Electron main/renderer logs to failing
      runs, with the existing redaction helper. Current evidence: `scripts/failure-artifacts.mjs`
      (`capturePage` starts the Playwright trace at page creation, collects redacted console/page
      errors, and saves screenshot + redacted log + trace only on failure; green runs discard) is
      wired into `scripts/accessibility-check.mjs`, `scripts/visual-check.mjs`,
      `scripts/browser-matrix.mjs` (per-engine save on failed checks, errors merged from the
      restart page) and `scripts/perf-check.ts` (welcome leg). `scripts/web-smoke/main.cjs` saves a
      redacted screenshot + console log on failure and redacts collected console errors; desktop
      `apps/desktop/src/main/smoke.ts` collects renderer console messages and saves a screenshot +
      redacted log on failure (its pattern list mirrors the helper, guarded by a parity test).
      `apps/desktop/tests/failure-artifacts.test.ts` covers lockstep redaction, prose passthrough
      and the helper/smoke parity. Verified: negative control with a real browser saved all three
      artifacts with the secret redacted; full suite 1042 pass, typecheck clean; a11y, visual,
      perf, matrix (exit 0, Chromium gate), desktop smoke 27/27 and web smoke 18/18 green with no
      artifact output. Note: the matrix run surfaced a Firefox-only finding — the web build's
      `eval` use trips that engine's script-src CSP (OPFS also unavailable there); both engines
      stay informational findings, Chromium stays the gate.
- [x] T028 Add a quarantine ledger with owner, reason and removal date; no retry-based fixes. Fail when
      an entry is past its removal date. Current evidence: `docs/QUARANTINE.md` holds the single-source
      ledger table (ID, test, owner, reason, quarantined and remove-by dates; empty today) plus the
      process (skip with ledger ID, weekly review, one extension with a new reason, never a retry).
      `bun run quarantine:check` (`scripts/quarantine-check.ts`) fails on expired or malformed rows and
      runs inside `bun run verify`; `apps/desktop/tests/quarantine.test.ts` covers the empty, live,
      expired, malformed and duplicate cases with fixed dates. (Full suite 1038 pass, typecheck clean.)
- [x] T029 Enforce the fast budget under 5 minutes and the full suite under 20 minutes on the reference
      machine; keep slow checks marked and excluded from the fast command. Current evidence:
      `scripts/verify-summary.mjs` exports the budgets (`FAST_BUDGET_MS`, `SUITE_BUDGET_MS`) and
      a pure `budgetVerdict`; `scripts/verify.mjs` prints the budget line on every run and exits
      1 when green gates breach either budget. `apps/desktop/tests/verify-summary.test.ts` covers
      within-budget pass, fast and suite breaches with synthetic durations, and exact-boundary
      acceptance. `docs/TESTING.md` names the budgets and marks each slow check with its command.
      Verified: focused tests 9 pass; full suite 1065 pass; lint/typecheck clean; a live verify
      run shows `budget: within 5m00s fast / 20m00s suite (total 0m12s, suite 0m09s)`, PASS. A
      real breach cannot be staged without a 5-minute run, so enforcement of the failure path
      rests on the synthetic-duration tests plus the always-printed live measurement.
- [x] T030 Add the single passed/failed/skipped/quarantined summary to every suite and release run.
      Current evidence: `scripts/verify-summary.mjs` carries one format with a tag (`[verify]`
      default, `[release]`), and `bun run release` prints the tagged summary — per-stage
      results with durations, test pass/fail/skip scraped from the verify output, quarantined
      count, overall verdict — as the last line on both the go and the blocked paths. Existing
      callers are unchanged (the tag defaults). `apps/desktop/tests/verify-summary.test.ts`
      covers the tagged shape and the absence of the verify tag. Verified: focused tests 10
      pass; `bun run lint` exits 0 with no diagnostics in the touched files; typecheck clean;
      full suite 1066 pass; diff clean. Ad-hoc `bun test` keeps its native summary; every
      orchestrated run (verify, release) ends with the unified one. The ledger now maps 012
      FR-038 as covered.

## Phase 8 — Launch requirements from 002

- [x] T031 Prove 002 FR-060 (no account, server or network for writing, planning, import or export)
      against the built app. Current evidence: `scripts/offline-check.mjs`, registered as `bun run e2e
      offline` (macOS only; `e2e` reports it skipped elsewhere), runs the hidden app inside a
      `sandbox-exec` profile that denies every outbound connection, loopback included. It creates a
      book and a chapter, autosaves typing, saves a Story Bible edit, imports a TXT manuscript and
      exports Word, Markdown and a library archive, reading each result back from disk. The denial is
      proved from the app's own processes before and after the journey (Node sockets get EPERM,
      `net.fetch` gets ERR_ACCESS_DENIED), and a weaker profile that allows loopback makes the check
      fail. Chromium's own sandbox cannot start inside the outer profile, so the run passes
      `--no-sandbox`. Verified on macOS: `node scripts/offline-check.mjs` 9/9; `bun run e2e` 9/9 with
      every entry (smoke 30/30, web 18/18, offline 9/9); `bun run verify` PASS, 1,387 tests passing.
- [x] T032 Prove 002 FR-069 (a second copy on the same profile is refused, with a warning) against the
      built app. The product change came first. A hidden test run now claims the single-instance lock
      when it has its own `STUDIO_USER_DATA` profile (`apps/desktop/src/main/instance.ts`), so its lock
      lives in the throwaway folder. A refused copy quits before it reads settings, opens the library or
      starts the control plane. The holder brings its window forward through `showStudioWindow()`,
      creating it again if it was closed, and sends `app:second-instance` once the page has loaded. The
      preload holds that signal until the shell listens, and the shell shows it as a dismissible notice.
      Current evidence: `scripts/second-instance-check.mjs`, registered as `bun run e2e instance`, starts
      a hidden copy with the control plane and a temp locator, waits until the profile has held still
      for 12 s, then starts a second copy with the same environment. The second copy exits 0 in about
      0.3 s (bound 10 s). Every library, profile and locator file keeps its bytes, size, mtime and
      inode; only Chromium's GPU shader cache, which the first copy rewrites as it paints, is left out
      and reported. The first copy shows the notice once, the notice dismisses, its window stays hidden
      and typing still autosaves. A copy on another profile opens. With the first copy's window closed,
      a refused copy makes it create a hidden window that shows the notice. Negative controls: against
      the unchanged build, and with the hidden-run lock rule switched off, the second copy stays up and
      rewrites `library.json` and `studio.json`, so the check fails. Without `showStudioWindow()` in the
      handler, the closed-window step fails. Sending at once instead of after the page loads still
      passed, so that wait is defensive rather than proven. Verified on macOS:
      `node scripts/second-instance-check.mjs` 7/7; `bun run e2e` 11/11 with every entry (smoke 30/30,
      web 18/18, offline 9/9, instance 7/7); `bun run smoke` 30/30; `bun run verify` PASS, 1,402 tests
      passing. `tests/requirement-map.md` lists what stays unproven.

## Phase 9 — The agent loop, end to end

- [x] T034a Keep the hidden smoke run away from the author's keychain (D-191). An unpackaged run
      started with `STUDIO_TEST=1` and `STUDIO_NO_KEYCHAIN=1` uses a cipher that refuses protected
      storage without asking the operating system, through the desktop vault's constructor, so its
      availability and status reads never reach `safeStorage`. It is a refusal and not a fallback.
      `scripts/smoke.mjs` sets both flags and passes only allowlisted host fields to the app.
      `apps/desktop/tests/credential-isolation.test.ts` (4 tests) proves the truth table, zero
      safeStorage calls, nothing written and a packaged build keeping its storage;
      `credentials.test.ts` covers the cipher choice and `headless-environment.test.ts` the allowlist.
- [x] T034 Prove one real agent turn through the built app without the author's keychain (D-184).
      Current evidence: `createDesktopVault` (`apps/desktop/src/main/credentials.ts`) returns an
      in-memory vault only for an unpackaged run started with `STUDIO_TEST=1` and
      `STUDIO_TEST_MEMORY_VAULT=1`. A packaged build or a run without `STUDIO_TEST` refuses the flag
      with one log line and keeps protected storage. The choice never reads safeStorage, so the
      in-memory vault is no fallback. `apps/desktop/tests/memory-vault.test.ts` (10 tests) runs
      through the shared Electron mock, which gains an `isPackaged` hook and a safeStorage call
      recorder. It proves the truth table, zero safeStorage calls and an empty profile after a real
      `ProviderService.addKey`, the unchanged refusal without protected storage, and the `index.ts`
      wiring. `scripts/agent-check.mjs` (`bun run e2e agent`) adds a Meta connection through
      `connections:addKey`, with its base URL pointing at a fake OpenAI-compatible server on
      127.0.0.1. It makes `muse-spark-1.3` the book's default through `books:update` and runs a
      turn through `POST /v1/books/:id/turn`: `read_chapter`, `append_to_chapter`, then a reply. Its
      46 checks read the result from disk: the reply text, chapter version 1 → 2 with no conflict
      copy, the thread's tool parts and `checkpointTurns`, the model named `Muse Spark 1.3` with its
      account, and 690/74 tokens summed over three steps with the cost recorded as unknown. Undo
      restores the body byte for byte; only `version` and `updatedAt` move on. An
      `overwrite_chapter` turn started through `agent:start` leaves the file untouched until
      `agent:approve`. The fake received exactly `GET /v1/models` ×2 and `POST /v1/chat/completions`
      ×5, each with the run's key. The main process's observer (Node fetch and http, from window
      creation on) saw the same seven requests and nothing else, and the renderer made no request
      after load. No `credentials.json` exists, and the key appears in no file of the profile,
      library or backend file (UTF-8, UTF-16 or base64) and no log line. Inside the hidden app,
      notifications are off and safeStorage is guarded; the run asked to notify three times.
      Observed, not changed: a hidden window counts as away, so without that guard every finished
      turn in a hidden run would post a real desktop notification. The approved resume also sends
      the model only the system, assistant and tool messages, not the author's prompt. Both were
      fixed afterwards: a hidden run now logs its notifications instead of posting them
      (`launch-mode.ts`), so the run asks to notify 0 times, and the resume sends the whole
      conversation (ADR 0014 decision 3). (`bun run verify` PASS with 1397 pass, `bun run e2e` 9/9,
      hidden smoke 30/30.)

## Completion condition

The spec is complete when the fast command is green without network or keys, every required gate is
enforced by a registered runner or an explicit manual waiver, the browser/desktop journeys cover the
primary author path, and a release produces artifacts plus redacted failure evidence and a requirement
map with no unmapped FR.
