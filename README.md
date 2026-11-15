# Open Book Studio

**Your book. Your files. Your agent.**

Open Book Studio is a local-first desktop writing studio for long-form fiction. Your book is a folder of
Markdown and JSON on your own disk, in iCloud Drive, Google Drive, Dropbox or any folder you choose,
with no account, no server and no database that can quietly disagree with your prose. A writing agent
works on that folder directly: it reads the Story Bible and the chapters, edits through checked saves
you can undo, and can keep working after you close the window.
The agent works on the actual book, and the author keeps the actual files. The writing model is
yours to choose: OpenRouter, OpenAI, Anthropic, Google Gemini, or a Meta connection. No provider
is the product.

[![Watch the Open Book Studio demo](https://img.youtube.com/vi/0RsFzUq97xU/hqdefault.jpg)](https://youtu.be/0RsFzUq97xU)

[Watch the current demo](https://youtu.be/0RsFzUq97xU)

## Current state

As of November 9, 2026, Open Book Studio is a working desktop writing studio; macOS is the reference
environment. This summary reflects public `main` at `c603095`, after PR #63 merged. The feature
status table below says what is complete, in progress and planned.

- **Name.** The product is Open Book Studio wherever an author or a tool sees it. The packaged
  app bundle, its profile folder, the bundle identifier and the stored keys keep their earlier
  internal names on purpose, so existing profiles and installs keep working.
- **File safety.** Damaged chapter files are named and block incomplete manuscript exports. Chapter
  moves and restores preserve concurrent edits. Book details merge non-overlapping field changes,
  retain overlapping edits as visible conflict copies, preserve unknown nested fields and refuse
  writes to a newer book schema. Failed close/quit saves have recoverable draft copies.
- **Voice choices.** Desktop Settings now saves separate dictation and speaking connections, models
  and voices. The selected transcription and speech adapters use those explicit choices; a failure
  never silently switches to another paid provider.
- **Models.** The writing agent uses the connection and model saved on the book. OpenRouter is the
  usual way to reach models from more than one company. A Meta connection remains available, and
  Muse Wonder 1.0 is recognised as a tool-capable writing model alongside Muse Spark 1.3.
- **Checks.** The November 7 integrated macOS baseline passed 2,280 unit/component tests, coverage
  and 47 hidden-app smoke checks. Linux `verify` and `e2e` both passed on `55b55b8`; either job
  failing now fails the workflow. See the [dated evidence](docs/TESTING.md#recorded-baseline).
- **Still ahead.** Signed and notarised releases, Android, character voices and audiobooks,
  dedicated cover design, named chapter history, library organization and scoped model review.
  Routing already has an offline advisory preview; automatic dispatch and autonomous multi-turn
  authoring remain planned. The [next-work plan](docs/PRODUCT-COMPLETION.md#current-next-work)
  names the first slices and their decision gates.

## What it does

### Feature status

**Complete** means implemented in the source with automated coverage. It does not imply a signed
release, a live-provider check on every platform, or approval by an app store. **In progress** means
there is a working slice with remaining work; **planned** means it is not available yet.

| Feature | Status | Available today / remaining work |
| --- | --- | --- |
| Local library, manuscript editing and autosave | Complete | Markdown and JSON files; checked version/hash saves, conflict copies, trash and recovery |
| Story Bible, characters and memories | Complete | Book-scoped context used by the writing agent; richer world-building records are planned |
| Writing agent and tool approvals | Complete | 22 manuscript tools, visible actions, conversation history and one-turn undo |
| Model choice and usage | Complete | Per-turn provider/model attribution, reported usage/cost and informational spending warnings; unknown cost is not a free turn |
| Protected desktop credentials | Complete | Electron safeStorage, macOS login Keychain protection, encrypted profile file, explicit keychain status/check and no plaintext fallback |
| Dictation / speech-to-text (STT) | Complete for the desktop adapters | Choose a transcription model on the saved connection, including Meta Muse Voice Transcribe or a curated OpenRouter Whisper model; audio stays in memory, and missing/stale choices are refused before sending |
| Read aloud / text-to-speech (TTS) | Complete for the current adapters | OpenRouter and OpenAI speech output, sentence-based chunking and playback controls; disclosed device speech only when no provider is selected |
| Voice provider, model and agent-voice preferences | Implemented; acceptance record open | Spec 038 merged in PR #26: profile-local Settings choices, model-specific voices and no provider probes; T022 remains unchecked at the author's direction |
| Character voices, narrator casting and audiobooks | Planned / coming soon | Assign distinct voices to characters and a narrator, then create an audiobook; this is a roadmap item, not current export functionality |
| Background agent turns | Complete on desktop | Explicit opt-in, reopening the active conversation, and notification when a reply or approval is ready |
| Illustrations | Complete on desktop | Image generation through this build's Meta image adapter, chapter attachments and embedded Word illustrations; no SAM cutout claim |
| Dedicated cover design | Planned | Image records can describe covers, but the current generation interface is for chapter illustrations |
| Word, Markdown, PDF and EPUB export | Complete on desktop | Formatting and ordered front/back matter; an export refuses a book that has unreadable chapter files rather than leave them out; KDP, EPUBCheck and PDF/UA conformance remain unproven |
| Markdown folder export | In progress; merged and usable on desktop | Ordered folder of Markdown files with matter and verified images from the saved book; broader publication checks remain open |
| Manuscript and library import | In progress | TXT, Markdown and DOCX manuscript import on macOS; portable archives and earlier-studio migration; other platform conformance remains |
| External-edit / sync review | In progress | Folder drift detection and conflict review; cloud storage supplies transport, while device trust and app lock remain planned |
| CLI and MCP integration | Complete | Local `bookwriter`, loopback authentication, read-only defaults and explicit write permission |
| Structured manuscript review | In progress | Saved-text report and evidence links; additional signals, report persistence and export remain planned |
| Inline editorial critique | Contracts accepted; implementation pending | Exact-current underlines, accessible feedback, explicit suggestion application and saved reviews selected in ADR 0020 |
| Hands-free authoring | Session controls mounted; capture and acoustic acceptance pending | Bound sessions, interruption, confirmation and spoken check-ins selected in ADR 0021. The Discuss panel mounts explicit start/transcript/correct/confirm/stop controls bound to the open book, chapter and conversation, but this build has no capture adapter or audio grant, so the bar says so instead of recording; integrated and acoustic acceptance remain |
| Guided/autonomous authoring and task-aware routing | Contracts accepted; continuation seams merged, coordinator runtime pending | ADR 0019 selects short-brief onboarding, bounded asynchronous drafting toward ~70,000 saved words, revision and character check-ins; continuation storage and counted check-in surface are merged, but no real coordinator session exists yet so check-ins refuse truthfully; no full-book delivery claimed |
| Named chapter history and library organization | In progress | Core merged in PR #33; restore/UI correction accepted and merged in PR #34; planning/goal leaves accepted, host/API integration and remaining organization open |
| Signed releases, online updates and store delivery | Planned | Packaging configuration exists; signing, distribution and device verification are separate gates |

### Delivery mechanisms

| Surface / distribution | Current state | Boundaries |
| --- | --- | --- |
| Desktop from source | Working Electron app; macOS is the reference environment | Editing, writing agent, protected credentials, dictation, speech and exports |
| Desktop packages | macOS DMG/ZIP, Windows NSIS and Linux AppImage targets are configured | Configuration is not proof of signed, notarized or tested installers on every OS |
| Browser | Working web build with a picked Chromium folder or browser-origin storage | Editing and archive portability; agent, provider dictation and manuscript export remain desktop-only |
| iPhone / iPad | Responsive layouts and a Capacitor iOS shell, exercised in Simulator | No App Store/TestFlight release or real-device validation is claimed |
| Android | Planned | No Android app or Play Store release is claimed |
| CLI / MCP | Standalone `bookwriter` talks to the open desktop studio | Loopback only; no hosted copy of a manuscript and no remote access by default |
| Glasses / companion | Status surface and integration groundwork | A concept/prototype surface, not a verified glasses release or native cross-device sync |

The [spec roadmap](specs/README.md) records acceptance criteria and unfinished tasks. The
[expanded authoring requirements](docs/EXPANDED-AUTHORING-REQUIREMENTS.md) track the full-book,
hands-free and inline-review journeys and the current five-agent development queue. The
[voice pipeline](docs/VOICE.md) distinguishes transcription from synthesis, and the
[keychain runbook](docs/KEYCHAIN.md) explains protected storage and its platform limits.
App store and release-download links will be posted in this repository when ready.

### Write

- **Your library is a folder.** Each book is a folder of `book.json` and one Markdown file per chapter.
- **A manuscript sheet** with a chapter rail, autosave, a visible save state and book search.
- **A Story Bible** for the description, outline, three-act arc, characters and memories.
- **Dictation** at the caret with the transcription connection chosen in **Settings → Voice**,
  independently of the writing model. The recording is never written to disk.

### Work with the agent

- **A writing agent** on the model's connection saved for the book: OpenRouter, OpenAI, Anthropic,
  Google Gemini or Meta. It reads the Story Bible and chapters through 22 tools, and every edit is
  a checked save.
- **Contributor consent.** Muse Spark 1.3 Contributor may train on what you send, so the studio
  refuses it until the book opts in.
- **Approvals and undo.** Destructive edits, such as deleting or merging chapters, wait for your
  approval, and one undo restores every chapter a turn changed.
- **Background turns.** Tick **Background** and close the window; a macOS notification tells you
  when the reply is ready or needs your approval.
- **The ambient strip** says where you are, what changed and what the agent would do next. It uses
  the saved dictation and speaking choices. Speaking is supplied by OpenRouter/OpenAI or an explicitly
  disclosed device voice, not a Meta speech model. A 600×600 glasses page shows the same status;
  it has not been run on glasses.
- **Plain reporting.** Each turn names its model and shows its usage, with spending warnings, offline
  and rate-limit notes, and hand-typed model ids that are checked before they are kept.
- **Your rules.** Per book, turn any tool off for every agent, see per-tool call counts and give the
  agent house rules in a `SKILLS.md`. A folder of TypeScript plugins can add tools.

### Illustrate and export

- **Illustrations** through this build's Meta image adapter (Muse Image 1.0), priced on the button
  (about $0.01) before you generate. Other writing providers do not generate images in this build.
- **Exports:** Word with illustrations embedded, plus Markdown, PDF and EPUB from the Format dialog,
  and an ordered Markdown folder from the saved book. No KDP, EPUBCheck or PDF/UA acceptance is claimed.
- **Images and archives:** every image in a book as a JPEG, or the whole library as an archive.

### Bring a book in

- **Manuscript import** (macOS): a Word, text or Markdown file becomes a new book, after a preview and
  in one atomic step, with a report of anything a Word file could not carry across.
- **Backup import** from an earlier studio. Running it twice adds nothing.

### Other agents

- **`bookwriter`**, a CLI and MCP server, gives other agents the built-in agent's tools over a
  loopback-only backend with a per-run token: read-only by default, writes behind flags.
- **One tool contract for every agent.** External agents use the same book context, tool policies,
  checked writes and undo boundary as the studio agent. The CLI never needs its own provider key.

### Speak with the ambient agent

The compact ambient panel provides the voice-first, hands-free reply workflow: start a recording,
speak your request and stop recording. The transcript appears in the panel and starts an agent turn;
the completed reply is spoken automatically as well as shown on screen. Read aloud, pause, resume
and stop keep the manuscript usable without staying in the full chat panel.

Recording is explicitly started and stopped by the author. Continuous listening, wake words and
speaking over an active reply are not implemented. Transcription and speaking are separate services:
Meta or OpenRouter handles the selected dictation path; OpenRouter/OpenAI supplies provider speech.
When no speaking provider is selected, a disclosed device voice may be used. A failed or unavailable
saved provider choice is reported rather than replaced. Persistent choices are available in Settings.
See [docs/VOICE.md](docs/VOICE.md) for the exact supported flow.

### Hands-free controls in Discuss

The Discuss panel mounts the explicit session controls: start, the words as heard, correction
before sending, one explicit confirm, and stop. A confirmed turn uses the same checked turn start as
a typed message and is bound to the book, chapter and conversation that were on screen; changing
any of them ends the session and keeps the unsent words visible. Stop is reported as stopping until
the host confirms, and a late transcript can never send. This build ships no capture adapter and no
audio grant for that bar, so it says hands-free audio is not connected and records nothing. Nothing
is sent without the author pressing Confirm and send.

### Trust

- **No overwritten text.** Saves carry the version and hash they were based on; if the file changed
  elsewhere, your text is kept in `conflicts/` and you see both versions.
- **Nothing lost.** Atomic writes, a trash for chapters and books, and unsaved typing flushed on quit.
- **Sync review.** If a file changes outside the studio, keep yours, keep the one on disk or open both.
- **Plain warnings** for a library location or provider that needs attention; one studio per profile.
- **Licenses.** Settings lists every open-source package each build ships, with its license text.

## Models

OpenRouter, OpenAI, Anthropic, Google Gemini and Meta can each supply the writing agent. Pick the
connection in Settings, then the model for the book. A Meta connection is one choice, not the default.

| Need | Model | How the studio uses it |
| --- | --- | --- |
| Planning, drafting, revision | Muse Spark 1.3 | The writing agent, through your own Meta connection (Meta Model API) |
| Larger writing model | Muse Wonder 1.0 | Recognised as a tool-capable writing model, using its documented context size and Standard-mode prices when the catalogue omits them; Wonder Full and unverified Contributor variants are not enabled |
| Cheap agent testing | Muse Spark 1.3 Contributor | Off by default and refused until the book opts in, because it may train on prompts and outputs; intended for the sample only |
| Illustration | Muse Image 1.0 | Chapter illustrations, priced on the button before you generate |
| Dictation and listening | Muse Voice Transcribe 1.0 | Dictation at the caret, and questions spoken to the ambient strip |
| Spoken replies | Selected OpenRouter/OpenAI speech model, or device voice when no provider is selected | **Not a Meta model.** Configured separately from dictation and writing |

The cutout feature is not in the build. SAM 3.1 cutouts were built, but every request returned no
records, so they were removed ([D-158](docs/DECISIONS.md)).

Keys are encrypted with Electron's safeStorage under a master key in your macOS login keychain. The
app's profile holds only ciphertext, and no key is written to your library, logs or exports.

## Try it

You need macOS on Apple Silicon or Intel, [Bun](https://bun.sh) 1.4 or later, and Node 22.12 or later
for Electron's tooling.

```bash
git clone https://github.com/JordanM575/open-book-studio.git
cd open-book-studio
bun install
bun run dev
```

1. Click **Choose a library folder** and select `samples/the-salt-road` (later, use **File → Open
   library…**). The studio adds a derived `library.json` and `.studio/` there, so copy the sample out
   of the clone first if you want the clone to stay clean.
2. Open **Settings** from the library's header. Under **Provider connections**, **Connect** signs you
   in to OpenRouter in your browser. For Meta, use **Add a key**: choose **Meta**, paste the base URL
   from Meta's developer console and your key, then choose **Add connection**.
3. Open *The Salt Road*, choose a model in the header, and ask the writing agent for the next scene.
   Without a connection you can still open, edit and export the sample.

> If `ELECTRON_RUN_AS_NODE=1` is set, Electron starts as plain Node; run `env -u ELECTRON_RUN_AS_NODE bun run dev`.

### The `bookwriter` CLI

With the studio open on a library ([docs/TOOLKIT.md](docs/TOOLKIT.md) has every command):

```bash
bun run toolkit:build                       # builds apps/toolkit/dist/bookwriter
export PATH="$PWD/apps/toolkit/dist:$PATH"
bookwriter books                            # the books in the open library
bookwriter mcp                              # an MCP server on stdio, read-only by default
```

## How it is put together

```text
apps/desktop/     Electron app; its main process owns the files and is the only writer
apps/web/         the browser build and its storage adapters
apps/toolkit/     the bookwriter CLI and MCP server
apps/mobile/      a Capacitor iOS shell, run in the Simulator, not yet on a device
packages/core/    schemas, the book format, the IPC contract and the agent's message format
packages/app/     the React interface every build shares
packages/ui/      shared components and the Liquid Glass styles
design/           vendored design tokens, compiled by scripts/build-tokens.mjs
docs/  specs/     format, architecture, decisions, ADRs and the spec-driven history
```

The interface never touches the filesystem. It asks the main process, which validates every call with
Zod, writes atomically through one `Library` and returns data or a typed error. The agent runs there
too, on the Vercel AI SDK, and its tools call the same `Library`, so its edits are checked like yours.
Electron 45, React 19, TypeScript 7, Tailwind 4 and Zod 4, in a Bun workspace. The browser build
keeps books in browser storage or a folder you pick; the agent, dictation and export are desktop-only.

## Where your book lives

```text
<your library folder>/
  library.json                   derived catalog, safe to delete
  books/
    book_…/
      book.json                  idea, outline, cast, memories, settings
      chapters/0001-the-door.md  YAML front matter and Markdown prose
      images/  images.json       illustrations and where each one came from
      threads/                   agent conversations, one JSON file each
      conflicts/                 versions kept when two writers disagreed
      SKILLS.md                  optional house rules for the agent
      .studio/checkpoints/       one undo point per agent turn
  .studio/                       this machine's identity, and trash/ for deleted chapters and books
```

[docs/FORMAT.md](docs/FORMAT.md) is the exact schema and the conflict protocol.

## Privacy

There is no account, no telemetry and no server-side copy. Your text leaves the computer only when you
ask: an agent turn sends what the agent needs to the provider you chose, dictation sends the
recording to the selected Meta or OpenRouter service, an illustration sends its prompt to Muse Image,
and a spoken reply sends its text to the voice service you connected. Keys never appear in the library,
logs or exports. The browser
build keeps an OpenRouter sign-in in that browser's own storage and does not run the agent yet.

## Verification

The checks run locally, and none needs a provider key. The repository also has a manually started
GitHub Actions workflow, `verify`: one job runs `bun run verify` and the coverage floor on Linux,
and an end-to-end job drives the built app under a virtual display. Either job failing fails the
workflow. It is manual-dispatch only, not an enforced pull-request merge gate. The end-to-end smoke
skips the manuscript-import checks off macOS, because only macOS offers the import, and when a smoke check fails there the job
keeps its screenshot and console log for seven days.

| Command | What it proves |
| --- | --- |
| `bun run verify` | Lint, typecheck, the quarantine and waiver ledgers, every unit and component test, and both production builds |
| `bun run smoke` | The built app, driven through its real interface in a hidden window on a throwaway profile, through to an autosave on disk |
| `bun run e2e` | The desktop and browser builds end to end: the CLI and MCP server against the running app, one agent turn against a fake provider on loopback, writing through export with outbound connections denied (macOS), and a refused second copy |
| `bun run coverage` | Function and line coverage stay at or above a floor that only moves up |

The current recorded results and their limits are in [docs/TESTING.md](docs/TESTING.md#recorded-baseline).
The [submission packet](hackathon/SUBMISSION.md#verification-and-limits) retains the historical event evidence.

## Documentation

- [docs/FORMAT.md](docs/FORMAT.md) — the library format, normative
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — processes, the save protocol and the sync model
- [docs/TOOLKIT.md](docs/TOOLKIT.md) — the `bookwriter` CLI and MCP server
- [docs/AGENT-CAPABILITIES.md](docs/AGENT-CAPABILITIES.md) — tool switches, `SKILLS.md`, plugins
- [docs/VOICE.md](docs/VOICE.md) — how the studio listens and speaks
- [docs/KEYCHAIN.md](docs/KEYCHAIN.md) — how keys are stored, and testing with a throwaway profile
- [docs/TESTING.md](docs/TESTING.md) — the test layers and what each proves
- [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/adr/](docs/adr/) — settled and open decisions
- [specs/README.md](specs/README.md) — the spec index and roadmap
- [docs/PRODUCT-COMPLETION.md](docs/PRODUCT-COMPLETION.md) — remaining work, lane dependencies and completion gates
- [docs/CONCURRENT-DELIVERY.md](docs/CONCURRENT-DELIVERY.md) — concurrent work packages, ownership and delivery sequence
- [hackathon/SUBMISSION.md](hackathon/SUBMISSION.md) — the submission packet
- [samples/README.md](samples/README.md) — the sample library

## Repository

```bash
git clone https://github.com/JordanM575/open-book-studio.git
```

Read [AGENTS.md](AGENTS.md) before changing code, [docs/DECISIONS.md](docs/DECISIONS.md) before
choosing an approach, and [CHANGELOG.md](CHANGELOG.md) before committing.

## License

The code is licensed under the Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). The
books you write with it remain yours. The sample's text and images are dedicated to the public domain
under CC0 1.0; see [samples/README.md](samples/README.md).

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) is generated from the build and lists every package
each build ships, with its license. Every one passes the license gate without an exception.
