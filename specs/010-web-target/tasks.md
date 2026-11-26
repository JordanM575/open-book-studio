# Tasks: browser storage and portability

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

Tasks are ordered. `[P]` means safe to do in parallel with another `[P]` task in the same phase. Tests are required at the storage, archive and privacy boundaries. Cross-spec integration tasks reference specs 011, 013 and 014 rather than duplicating their ownership.

## Phase 1 — Checked library port (blocks browser storage)

- [x] T001 Define validated `LibraryPath` construction/serialization, `LibraryPort`, `FileSnapshot`, `CommitResult`, and typed adapter errors in `packages/core/src/library/path.ts`, `port.ts` and `errors.ts`.
- [x] T002 Add an in-memory `LibraryPort` with deterministic identity/time/hash injection in `packages/core/tests/support/in-memory-port.ts`.
- [x] T003 Extract shared library operations, schema checks, path policy, catalog rebuild, chapter save/conflict handling and trash policy into `packages/core/src/library/service.ts`, `packages/core/src/library/paths.ts` and `packages/core/src/library/port.ts`; import no Node or DOM APIs.
- [x] T004 Implement the Electron `LibraryPort` using the existing atomic writer in `apps/desktop/src/main/library/fs-port.ts`; keep all desktop file access in the main process.
- [x] T005 Route `apps/desktop/src/main/studio.ts` and `apps/desktop/src/main/ipc.ts` through the shared service without changing the `Result` envelope, Zod validation or renderer contract.
- [x] T006 Add port conformance tests for format round-trips, same-content no-op saves, stale version/hash conflicts, external edit conflicts, trash/restore, schema rejection, path traversal and injected write failure in `packages/core/tests/library-service.test.ts` against the in-memory port, plus the unchanged filesystem suite in `apps/desktop/tests/library.test.ts`.
- [x] T007 Re-run existing filesystem tests and hidden smoke; prove a failed write preserves the previous file and that the smoke fixture never opens the author's profile in `apps/desktop/tests/` and `apps/desktop/src/main/smoke.ts`.

## Phase 2 — Browser storage tiers (User Story 1)

- [x] T008 Define browser storage selection and `StorageSummary` types in `packages/core/src/library/storage-summary.ts`; expose no directory handles or host paths to shared UI.
- [x] T009 Implement the user-selected-folder adapter in `apps/web/src/storage/fsa.ts` and `directory-port.ts`; require a secure context and user gesture, persist only the directory handle, re-request permission on reopen, and report permission loss without switching tiers.
- [x] T010 Implement IndexedDB storage for browser library metadata/handles and an OPFS adapter with the ordinary library directory layout in `apps/web/src/storage/indexeddb.ts` and `apps/web/src/storage/opfs.ts`.
- [x] T011 Implement capability detection and cross-tab lock handling in `apps/web/src/storage/capabilities.ts` and the `webLock` wrapper in `directory-port.ts`; use feature detection, retain version/hash checks, and report when locking is unavailable.
- [x] T012 Request origin-storage persistence where supported and report granted/not-granted/not-supported plus quota failures in `apps/web/src/storage/opfs.ts`; the summary warning is shared from `packages/core/src/library/storage.ts`.
- [ ] T013 Add isolated real-browser adapter tests for picker cancellation, permission re-grant/revocation, OPFS restart, persistence denial, quota exhaustion, two tabs and no silent tier switch in `apps/web/tests/storage/`.
  Unit tests with fake handles cover commit expectations, moves, device identity, picker cancellation,
  permission mapping, save failures, draft buffering, capability detection, persistence denial,
  unsupported and error paths, and the cross-tab Web Lock request and fallback.
  The strict `apps/web/check/` run passed 16/16 each in Playwright Chromium, Firefox and WebKit
  on `8c7b2fb` from [PR #129](https://github.com/JordanM575/open-book-studio/pull/129).
  The fixtures use a simulated picker for folder selection and cancellation. The checks cover a
  denied permission that keeps the pending folder and OPFS page restart. Where Web Locks are
  available, the lock check verifies serialization for two requests in one page.
  The stamped production web build also reopened the same saved
  chapter revision and hash after restarting Firefox and Playwright WebKit. Two-tab Web Lock
  serialization, native folder selection, permission re-grant and revocation, and standalone Safari
  and Firefox target qualification remain open.

## Phase 3 — Honest save and recovery (User Story 2)

- [x] T014 Expose browser save lifecycle results through the existing `SaveChapterResult` and storage summary contracts in `packages/core/src/ipc.ts`, without creating a second save-status enum. `LibraryInfo.storage` now carries the existing `StorageSummary`; confirmed saves update `lastCommittedAt`, and Settings shows the tier, last confirmed save, permission and browser warning. The web smoke run asserts the contract.
- [x] T015 Ensure browser writes commit complete files only; re-check current bytes/hash before commit and return a conflict result when the expected base differs. `DirectoryHandleLibraryPort` in `apps/web/src/storage/directory-port.ts` serves both the folder and OPFS tiers: it writes through the swap file, re-reads the target immediately before `close()`, aborts on a concurrent change, and verifies the read-back hash so a mismatch is `changed`, never `written`.
- [x] T016 Add injected permission, read-only, quota, interrupted-write and external-edit tests; assert old bytes remain intact and user text is not silently discarded. `apps/web/tests/storage/save-failures.test.ts` uses a shared fake handle with failure and after-write hooks; it covers stale bases, a concurrent edit during the swap, a concurrent create, permission loss, read-only folders, quota exhaustion, an interrupted close, a read-back mismatch, and a service-level save conflict that keeps both texts.
- [x] T017 Add best-effort page-hide flushing and an explicit “not confirmed saved” state contract in `apps/web/src/storage/drafts.ts`; test that an aborted flush never reports success. `BrowserDraftBuffer` reports `confirmed` / `conflict` / `unconfirmed` / `empty`, keeps a failed draft, holds text typed during a save, and drives the page-hide listener. Surfacing the state in the interface rides on T014.

## Phase 4 — Portable archive (User Story 3)

- [x] T018 Add `fflate` as a direct dependency of `packages/core` and define `ArchiveManifestV1` plus path/size validators in `packages/core/src/archive/manifest.ts`.
- [x] T019 Implement streaming library export in `packages/core/src/archive/export.ts`; preserve exact source bytes and unknown files, include author-owned conflicts/trash, and omit catalog/device/lock/temp files and credentials.
- [x] T020 Implement streaming archive preflight/import in `packages/core/src/archive/import.ts`; reject unsafe/duplicate paths, symlinks, unsupported format/schema versions, over-limit entries/bytes, insufficient capacity and hash mismatches before publishing.
- [x] T021 Implement new/empty-destination import and safe cleanup using the shared library service in `packages/core/src/archive/import-library.ts`; never merge or overwrite an existing library.
- [x] T022 Expose desktop archive export/import through validated main-process IPC in `packages/core/src/ipc.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/library/archive.ts`, the preload bridge and the library view actions.
- [x] T023 Add browser archive file picker/download adapters in `apps/web/src/storage/archive-io.ts`; it streams to a save picker when available and otherwise downloads a Blob, never a server request.
- [x] T024 Add archive tests for exact byte/ID round-trips, unknown files, credential exclusion, traversal, duplicate paths, symlinks, malformed manifest, bad hash, future versions, size limits, low quota and failed-write cleanup in `packages/core/tests/archive.test.ts` and `apps/desktop/tests/archive-io.test.ts`; browser archive I/O tests remain with T023.

## Phase 5 — Cross-target integration and verification (User Story 4)

- [x] T025 Update spec 011 web tasks to consume the accepted D-105 vault decision and the storage abstractions; keep OAuth/provider access gated by D-101 and do not add a proxy in `specs/011-model-access/tasks.md`. The Phase 8 tasks now record that the storage boundary and web shell landed; T037/T038 are implementation work and T039 remains blocked on D-101.
- [x] T026 Add browser end-to-end journeys for folder mode, origin-storage mode, save conflict, archive transfer and permission recovery. `scripts/web-smoke.mjs` covers origin storage, create, save, reopen, build metadata, a stale-save conflict and a portable archive export; `fsa.test.ts` covers picker cancellation and permission mapping; `archive-picker.test.ts` covers archive import selection/cancel; `folder-mode.test.ts` opens a picked fake folder, creates a book/chapter and saves; `permission-recovery.test.ts` covers a re-granted folder and a denied re-grant that keeps the pending folder. The real-browser folder-picker matrix remains T013/T027.
  Hardened: the UI typing journey now proves the keystrokes landed in the editor and the
  save committed a newer chapter version via the bridge, instead of trusting a bare
  "Saved" status that also shows when nothing changed. A no-op save returns "saved"
  without a version bump (`LibraryService.saveChapter`), so the version check is what
  distinguishes a real commit. Verified 18/18 across three consecutive runs.
- [ ] T027 Run the full Playwright/Node browser matrix plus `bun run typecheck`, `bun test`, `bun run build`, `bun run smoke` and packaged desktop smoke.
  [PR #129](https://github.com/JordanM575/open-book-studio/pull/129) passed all eight Linux verify
  stages with 5,503 tests passing and one skip. Its strict browser matrix passed 48/48 across
  Chromium, Firefox and WebKit in Playwright. Earlier packaged smoke passed 16/16 on its original
  build. Matching desktop and packaged smoke and the remaining T013 cases still gate completion.
- [x] T028 Update `docs/FORMAT.md`, `docs/ARCHITECTURE.md`, `specs/README.md`, `CHANGELOG.md`, and specs 011/013/014 links to match the delivered storage/archive behavior. The browser-storage commit contract, save-failure tests, web smoke journeys and spec 011 Phase 8 status are now documented.

## Dependencies and delivery

- Phase 1 blocks Phases 2–5: no browser adapter may duplicate the desktop library policy.
- Phase 4 archive service can be developed after the port contract and tested against the in-memory adapter.
- Spec 011 owns provider OAuth, browser credential UI and provider-specific direct access; spec 010 supplies the accepted storage policy and browser capability boundaries.
- Spec 013 owns shared UI extraction, `apps/web` entry, Vite/static output, build metadata and deployment. Its web shell consumes the adapters produced here.
- Spec 014 owns Capacitor native setup, safe areas, orientation, native iOS storage, protected credentials, lifecycle, permissions and capability/refusal integration; it consumes the shared port/capability contracts and the real renderer from spec 013. Native decisions and target evidence remain separate.

## MVP scope

Complete Phases 1–3 first, then archive import/export in Phase 4. Browser-provider and UI end-to-end acceptance is not complete until the dependent spec 011 and spec 013 tasks pass.
