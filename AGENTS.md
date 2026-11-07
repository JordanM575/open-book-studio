# AGENTS.md — Open Book Studio

Read this before changing code. It is short on purpose: the rules below are the ones that keep
authors' manuscripts safe.

## What this is

Open Book Studio is a local-first desktop writing studio. An author points it at a folder — iCloud
Drive, Google Drive, Dropbox, or a plain local directory — and the app reads and writes books there
as ordinary files.

- **Electron 45** (main + preload) and **React 19** (renderer), built by **electron-vite 6**.
- **TypeScript 7**, **Tailwind 4**, **Zod 4**, with **Bun** as package manager, task runner and test
  runner, in a Bun workspace (`apps/*`, `packages/*`).
- The UI is the "Liquid Glass" design system, vendored in `design/tokens.json` and compiled to
  `packages/ui/src/styles/tokens.generated.css` by `scripts/build-tokens.mjs`.

Origin: the ideas come from an earlier local prototype (Next.js, localStorage, one JSON blob). This
repository starts fresh and shares no history or code with it.

## Non-negotiables

1. **The files are the source of truth.** No feature may introduce a hidden database that the
   format cannot be rebuilt from. Indexes are derived and disposable.
2. **Only the main process writes.** The renderer has no filesystem or Node access. Every write goes
   through IPC, Zod validation, and `Library`.
3. **Never overwrite another writer's text.** Saves carry `baseVersion` and `baseHash`; a mismatch
   produces a conflict copy in `conflicts/` and a UI that shows both.
4. **Writes are atomic.** Use `writeFileAtomic` (`src/main/library/atomic.ts`). Do not call
   `writeFile` on manuscript files.
5. **Nothing is deleted permanently without the author.** Chapters go to `.studio/trash`.
6. **No telemetry, no account, no server-side copy.** Prose leaves the machine only when the author
   asks an agent to work on it.
7. **Update `CHANGELOG.md` before every commit**, and keep `docs/FORMAT.md` true when the format
   changes.
8. **Check `docs/DECISIONS.md` before choosing an approach.** A spec may rely only on an accepted
   decision or a stated assumption; if the answer is not there, add the decision as open, research it,
   and record the outcome instead of quietly picking one.

## Commands

```bash
bun run dev          # electron-vite dev; opens a window
bun run typecheck    # tsc for both projects (node + web)
bun test             # core and library tests, in-process
bun run smoke        # build, then drive the real UI in a hidden window
bun run capture:run  # screenshot the real UI at a device size (build first)
bun run build        # typecheck + production bundle to apps/desktop/out
bun run package:dir  # unpacked app in release/
bun run dist         # installers for this platform
bun run tokens       # regenerate tokens.generated.css from design/tokens.json
bun run toolkit:build # compile the `bookwriter` CLI/MCP binary into apps/toolkit/dist
bun run toolkit      # run the CLI from source
bun run keys:check   # provider key status; prints no key material
```

Quirks:

- Electron's binary is a trusted dependency of the desktop workspace. If `apps/desktop/node_modules/electron/dist`
  is missing, run `node apps/desktop/node_modules/electron/install.js`; `bun run verify` checks this
  first and prints the exact command.
- If `ELECTRON_RUN_AS_NODE=1` is set (some terminals and agent harnesses set it), Electron starts as
  plain Node and crashes in `app.isPackaged`. Launch with `env -u ELECTRON_RUN_AS_NODE bun run dev`.
- `STUDIO_TEST=1 STUDIO_VISIBLE=1 STUDIO_USER_DATA=/tmp/... bun run dev` shows an isolated, throwaway
  profile for a manual provider/keychain test; `STUDIO_TEST` alone is headless. The macOS unlock runbook
  is [`docs/KEYCHAIN.md`](docs/KEYCHAIN.md).
- `main` and `preload` must be CommonJS. `electron.vite.config.ts` emits `index.cjs` on purpose;
  changing it back to ESM breaks `BrowserWindow` imports.
- `packages/core` ships TypeScript source and is excluded from `externalizeDepsPlugin`, so
  electron-vite bundles it. Do not add a build step to it without revisiting spec 013.

**Tooling (ADR 0010).** Bun is the package manager, task runner and test runner. Electron's main and
preload processes still run on Electron's Node; Playwright and electron-builder also stay on Node. The
workspace is `apps/desktop`, `apps/web`, `apps/mobile`, `apps/toolkit`, `packages/core`, `packages/app`
and `packages/ui`.

## Layout

```
apps/desktop/src/main/index.ts        app lifecycle, window, menu, single-instance, test flags
apps/desktop/src/main/ipc.ts          every channel: Zod validation + Result envelope
apps/desktop/src/main/studio.ts       the open library, draft flush, remembered bounds
apps/desktop/src/main/settings.ts     studio.json in userData (library path, window bounds)
apps/desktop/src/main/drafts.ts       in-memory draft buffer, flushed on close/quit
apps/desktop/src/main/smoke.ts        hidden UI smoke checks (STUDIO_SMOKE)
apps/desktop/src/main/backend.ts      loopback HTTP control plane for the CLI/MCP toolkit
apps/desktop/src/main/voice.ts        Meta Muse Voice Transcribe request and provider error mapping
apps/desktop/src/main/background.ts   native notification and dock badge for background turns
apps/desktop/src/main/library/
  atomic.ts              temp file + fsync + rename
  paths.ts               layout, safeJoin, ids, schema version guard
  store.ts               Library: the only writer
  errors.ts              LibraryError codes
apps/desktop/src/preload/index.ts     contextBridge surface (window.studio)
apps/desktop/src/renderer/src/        views, components, hooks, styles
apps/desktop/tests/                   bun test, mirrors src/main/library
apps/desktop/electron-builder.yml     packaging, output ../../release
packages/core/src/schema.ts           Zod schemas + domain types
packages/core/src/ipc.ts              channel map and the StudioApi contract
packages/core/src/markdown.ts         front matter, canonical body, slugs, file names
packages/core/src/agent/messages.ts   canonical message and thread schema
packages/core/src/agent/threads.ts    thread store over the library port
packages/app/src/                     shared App shell, views, components, hooks and renderer libs
packages/ui/src/                      shared Button, Dialog, Brand, Notice and cn
packages/ui/src/styles/               base.css and generated design tokens
apps/toolkit/src/                     standalone `bookwriter` CLI, MCP server and backend client
scripts/smoke.mjs                     throwaway profile + fixture, spawns the hidden run
design/tokens.json                    vendored design kit tokens (do not hand-edit)
```

## The save protocol

`chapters.save({ bookId, chapterId, content, baseVersion, baseHash })` returns either
`{ status: "saved", chapter }` or `{ status: "conflict", conflict }`. `chapter.hash` is the SHA-256
of the raw file, so the renderer can prove exactly which bytes it edited.

The full format — front matter, canonicalisation, conflict naming, trash, catalog — is in
[docs/FORMAT.md](docs/FORMAT.md). Change the code and that document together.

## Adding an IPC channel

1. Add the channel and its input/output types to `packages/core/src/ipc.ts` (`IpcChannelMap` and
   `StudioApi`).
2. Add a Zod schema for the arguments in `apps/desktop/src/main/ipc.ts`; validate sizes and ids.
3. Implement the handler through `Library`/`Studio`; return values through `ok()`/`fail()`.
4. Expose it in `apps/desktop/src/preload/index.ts`.
5. Call it from the renderer with `must(...)` (`apps/desktop/src/renderer/src/lib/utils.ts`), which
   throws the server message instead of leaking `{ ok: false }` shapes into components.
6. Add a test at the `Library` level if it touches files, and extend
   `apps/desktop/src/main/smoke.ts` if it changes something the UI depends on.

Never expose `ipcRenderer` itself, never trust a renderer-supplied path (use `safeJoin`), and never
add `nodeIntegration: true`.

## Interface rules

Derived from the design kit's README; follow it rather than inventing new patterns.

- Neutral surfaces, one blue accent, glass only for things that float. The manuscript sheet is solid.
- Use tokens (`var(--text-body-size)`, `bg-[var(--glass)]`, `rounded-[var(--corner-lg)]`). No raw
  hex colours, no invented shadows, no gradients except `.window-wash`.
- Sentence case everywhere, including buttons and headings. Buttons are verb + object
  ("New book", "Show files"). No exclamation marks, no emoji in chrome.
- Status copy uses middle dots: `1,478 words · 243 lines`.
- Agents speak in the first person, briefly. The studio speaks plainly in the second person.
- Honor reduced transparency and reduced motion (already in `base.css`); do not add motion that
  ignores it.
- Keep `data-testid` attributes on the elements the smoke run uses (`library-view`, `book-card`,
  `workspace-view`, `chapter-rail`, `manuscript-editor`, `manuscript-text`, `save-status`).

## Testing

- **Bun tests** cover the library and the core format in process: format round-trips, version/hash
  conflicts, trash, schema rejection, path safety. Add a test for every change to `store.ts`,
  `markdown.ts` or `paths.ts`.
- **The smoke run** covers what unit tests cannot: the preload bridge, real rendering, autosave to
  disk. It runs hidden and must never touch the author's profile. It is also the packaged-app check.
- **Manual check** for visual work: `bun run dev`, light and dark, windowed at 1024×700 and 1440×900.
- **iOS and browser checks must not take over the desktop.** Park Simulator and preview windows with
  the `desktop-park` skill, then drive the simulator through `device-control` (agent-device) and
  measure pages with `visual-check`. Never click the Simulator window or switch Spaces to reach it.

`apps/desktop/tests/` mirrors `src/main/library`. Component tests render in happy-dom through
`tests/support/dom.ts`. Every file shares one bun process, so these rules keep them from breaking each other:

- Call `mountDom()` in `beforeAll` and `unmountDom()` in `afterAll`. Load `@testing-library/react` only
  through `mountDom()`, which returns the `/pure` entry.
- Import components and hooks only inside `beforeAll`, after `mountDom()`, never at module scope.
- Query through the render result or `within(document.body)`, never the cached `screen`.
- List a new DOM file in `tsconfig.web.json` `include` and in `tsconfig.node.json` `exclude`.

Test what the author sees rather than implementation details.

## Git and GitHub

- `origin` is `https://github.com/JordanM575/open-book-studio.git`. Use `gh` for issues and
  pull requests: `gh issue list`, `gh pr create`.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- Every commit includes the `CHANGELOG.md` entry that describes it.
- Keep commits small and reviewable; prefer a branch and a pull request for anything larger than a
  typo.
- Never commit library data, API keys or `.env` files.
- The project is Apache-2.0 (`LICENSE`, `NOTICE`). Keep the copyright line; do not add the legacy
  repository's Commons Clause.

## Credentials

- Keys live in the operating system's protected storage on desktop and in origin storage with a visible
  disclosure on the web. They never appear in the library, logs, crash reports, exports, URLs or the
  bundle. Tests that touch credentials assert redaction.
- `bun run keys:check` reads `.env.local` (see `.env.example`) and prints provider status, latency and
  model counts only. `--strict` exits non-zero when a configured key is rejected. A provider with no
  key is skipped, not failed.
- Which providers a build may call, and how sign-in works, is decided in spec 011. Do not add a provider
  to the web build without a browser-access check; OpenAI, for example, blocks it.
- The provider registry in `packages/core/src/providers/registry.ts` is the single capability table. The
  renderer receives `ConnectionSummary` objects only; secrets are read solely by `ProviderService` in
  `apps/desktop/src/main/providers.ts`. Every new connection channel goes through Zod, the `Result`
  envelope and `redact()` on failure.
- Desktop secrets live in `userData/credentials.json`, written atomically with mode `0600` and encrypted
  with `safeStorage` (`isAsyncEncryptionAvailable`). When protected storage is unavailable the vault
  refuses to save and the interface explains why; never add a plaintext fallback.
- The one exception is D-184's in-memory test vault. An unpackaged run started with
  `STUDIO_TEST=1 STUDIO_TEST_MEMORY_VAULT=1` keeps connections in memory only, for
  `scripts/agent-check.mjs`. It is not a fallback: the choice never reads safeStorage, and packaged
  builds and unflagged runs refuse it (`apps/desktop/tests/memory-vault.test.ts`).
- D-191's no-keychain mode is the other test-only switch. An unpackaged run started with
  `STUDIO_TEST=1 STUDIO_NO_KEYCHAIN=1` (the hidden smoke run) refuses protected storage without
  asking the operating system, so it never reaches the author's keychain. It is a refusal and not a
  fallback: nothing is written, either flag alone changes nothing, and packaged builds ignore it
  (`apps/desktop/tests/credential-isolation.test.ts`).

## Spec-driven development

Work that adds a capability starts as a spec, not as code:

```
specs/NNN-name/
  spec.md      the problem, the user-visible behaviour, acceptance criteria
  plan.md      the technical approach and the files it touches
  tasks.md     ordered, checkable steps
```

Rules:

- Number sequentially (`001-foundation`, `002-studio-v1`, …). Do not reuse numbers.
- Read `.specify/memory/constitution.md` first; a plan that breaks a principle needs an amendment, not
  an exception.
- A spec states what the author sees and what happens to their files on failure. "Handle errors"
  is not an acceptance criterion; "a failed save leaves the previous file intact and says so" is.
- Decisions that constrain future work (storage model, sync, packaging, model choice) become an ADR
  in `docs/adr/` and are linked from the plan.
- [`specs/README.md`](specs/README.md) is the index and the roadmap; update it when a spec lands.
- **Current product spec**: [`specs/002-studio-v1/spec.md`](specs/002-studio-v1/spec.md) is the
  white-room definition of v1 and supersedes the foundation roadmap's separate feature specs. The
  migration from the previous app is [`specs/003-earlier-studio-import/spec.md`](specs/003-earlier-studio-import/spec.md).
- **Delivery track**: [011](specs/011-model-access/spec.md) model access (OpenRouter SSO, keys,
  ChatGPT plan), [012](specs/012-automated-verification/spec.md) verification and
  [013](specs/013-builds-and-deployment/spec.md) builds. They refine 002; where they disagree, the newer
  spec wins and 002 is amended.
- When a requirement exists because of an inherited defect (F-001…F-050), keep the citation; a
  regression should reopen a named failure, not a generic bug.
- Spec Kit is installed (`specify`, `.opencode/commands/speckit.*`, `.specify/`). Use
  `/speckit-specify`, `/speckit-plan`, `/speckit-tasks` and `/speckit-implement` rather than inventing a
  document shape.

## Agent runtime (first loop built)

The writing agent uses **Vercel AI SDK 7** (`ai`) with `@openrouter/ai-sdk-provider` and
`ToolLoopAgent` — see [ADR 0007](docs/adr/0007-agent-runtime.md). Rules that survive the decision:

- The loop lives behind `apps/desktop/src/main/agent/runtime.ts`. Nothing outside that module imports SDK types.
- Messages and threads are studio-owned in `packages/core/src/agent/`; AI SDK `ModelMessage` and
  `UIMessage` conversions stay at the runtime edge (ADR 0013). The runtime takes a model factory so
  contract tests and provider adapters can run without a network.
- Tools are ours: name, description, Zod `inputSchema`, `execute` calling `Library`. Manuscript writes
  go through the store, never through ad-hoc `fs` calls. The loop ships `table_of_contents`, `read_story_bible`, `read_chapter`,
  `chapter_stats`, `find_in_chapter`, `find_in_chapters`, `replace_in_chapter`, `insert_at_line`,
  `delete_lines_in_chapter`, `overwrite_chapter`, `append_to_chapter`, `create_chapter`, `delete_chapter`,
  `move_chapter`, `split_chapter`, `merge_chapters`, `set_chapter_meta`, `update_book_details`,
  `update_character`, `add_memory`, `update_memory` and `remove_memory`. `remove_memory`,
  `overwrite_chapter`, `delete_chapter`, `delete_lines_in_chapter`, `move_chapter`, `split_chapter`
  and `merge_chapters` pause for the author's approval through the AI SDK tool-approval protocol
  (ADR 0014). Library replacement still needs the same policy before it lands.
- The key is stored with `safeStorage` in the main process. The renderer may set, test and forget it;
  it never reads it back.
- Usage and cost come from the provider's reported totals, not from token estimation. Each turn also
  records its provider, connection label and model id, and a model change is visible in the conversation.
- Destructive tools ask before acting; every turn is a checkpoint and one undo.
- Prompt and tool limits are stated once and checked by snapshot, budget and consistency tests.

The experimental `@ai-sdk/harness` runtimes are not used. They need a sandbox and a CLI bridge, so they
cannot run in the browser, and they write files with their own tools, which would bypass version checks
and conflict handling. They remain a possible desktop-only option behind the runtime seam; see the
harness update in ADR 0007.

The product is becoming multi-target: a shared core over a storage port, with Electron, Chromium folders
and browser storage as adapters (ADR 0009). Write new logic so it could live without `node:fs`; if you
need a new filesystem primitive, add it to the port instead of calling `fs` from a new module.

## Local backend and agent toolkit

- `apps/desktop/src/main/backend.ts` starts a loopback-only HTTP control plane in a normal app launch,
  writes `~/.ai-book-studio/backend.json` with mode `0600`, and stops before quit. It uses only
  `Studio.requireLibrary()`; never add a second library opener or writer.
- `apps/toolkit/` is the standalone `bookwriter` CLI and MCP server. It has no Electron dependency and
  no provider key. Read tools are on by default; `create_chapter` and `save_chapter` require
  `--allow-writes`, and a save carries the version and hash from the read.
- The backend rejects browser origins, non-loopback Host headers and missing/wrong bearer tokens.
  Never expose it on a LAN address or add CORS. Remote access is deferred by D-129.

## Known gaps

- The agent implements 22 tools; `remove_memory`, `overwrite_chapter`, `delete_chapter`,
  `delete_lines_in_chapter`, `move_chapter`, `split_chapter` and `merge_chapters` are approval-gated,
  and it keeps at most one checkpoint. Threads persist under `books/<bookId>/threads/`. The prompt
  carries saved memories and character detail, backed by a 4,000-token budget test;
  `read_story_bible` returns the full bible.
  `docs/AGENTIC-COVERAGE.md` maps what 002 and 011 specify against what exists.
- The agent writes each turn to `books/<bookId>/threads/` and the chat reloads the latest conversation.
  `compactHistory` summarizes old turns; stored tool parts are still not replayed to the model.
- PDF and EPUB export are not checked against KDP, EPUBCheck or PDF/UA (D-108). DOCX, Markdown, PDF
  and EPUB export, voice, illustrations, book search and the Story Bible are in.
- Renderer component tests cover the editor history and debounce paths, the manuscript dialogs, the
  dictation hook and the ambient panel's microphone; the smoke run remains the integration net.
- The design kit was the source of the tokens, but only the foundation screens have been drawn; the
  rest of the surfaces in spec 002 still need design work before they are built.
- Spec 009 (packaging and release) is a draft: signing and online updates wait on D-115. Spec 012
  (automated verification) is in progress; its Gitea runner (T021) and opt-in live checks (T024–T026)
  are still open.
