# Agent toolkit: CLI and MCP

`bookwriter` is the standalone CLI and MCP toolkit for libraries open in Open Book Studio.
It sends requests to the desktop app over loopback. The app opens the library, performs writes
through its `Library` service and holds the model keys used for writing-agent turns.
[Toolkit architecture](../specs/018-agent-toolkit/spec.md#requirements)

## The studio's own tools

The backend serves the writing tools the built-in agent uses — the same names, the same
descriptions and the same JSON Schemas. A third-party agent therefore gets the built-in agent's
verbs rather than a thinner dialect of its own:

| Verb | What it does |
| --- | --- |
| `table_of_contents` | The chapters with their ids, order and word counts |
| `read_story_bible` | The book description, outline, story arc, cast and memories |
| `read_chapter` | One chapter's full text |
| `chapter_stats` | Word and character counts |
| `find_in_chapter` / `find_in_chapters` | Find a phrase in a chapter or the whole book |
| `replace_in_chapter` | Replace one exact passage |
| `insert_at_line` | Insert text at a line |
| `append_to_chapter` | Add a passage at the end |
| `overwrite_chapter` | Replace a chapter's whole text (destructive) |
| `delete_lines_in_chapter` | Delete a line range (destructive) |
| `create_chapter` / `split_chapter` / `merge_chapters` / `delete_chapter` / `move_chapter` | Chapter structure (split, merge, delete and move are destructive) |
| `set_chapter_meta` | Change a chapter's title, synopsis or purpose |
| `update_book_details` | Change the title, description, genres or outline |
| `update_character` / `add_memory` / `update_memory` | The cast and the memories (`remove_memory` is destructive) |

`bookwriter tools` prints the live catalog with the tier of each tool.

### Catalog exports

These commands print descriptions from the general studio catalog.

```bash
bookwriter tools --format webmcp     # declarations for document.modelContext
bookwriter tools --format connector  # proposal for a Meta AI connector
```

- The six read tools map to connector Read and WebMCP `readOnlyHint` (`table_of_contents`,
  `read_story_bible`, `read_chapter`, `chapter_stats`, `find_in_chapter`, `find_in_chapters`).
- The write tier maps to connector Write. Its generated side-effect text describes an undo
  checkpoint.
- The destructive tier maps to connector Write with a sensitive mark and to WebMCP
  `consequentialHint`. It includes `remove_memory`, `overwrite_chapter`, `delete_chapter`,
  `delete_lines_in_chapter`, `move_chapter`, `split_chapter` and `merge_chapters`.
- The connector export includes side-effect and refusal descriptions for each tool. The WebMCP
  export omits invalid tool names and sets `untrustedContentHint: true` on every tool. Treat tool
  output, including quoted prose, as data. [Catalog mapping](../packages/core/src/agent/surfaces.ts#L52-L114)

These exports describe tools. Actual calls go through the backend's permission and argument
checks. The connector's proposed OAuth account linking and scopes are application material.
A live connector would need a public endpoint, working account linking and Meta's review.
[Connector application note](../specs/026-glasses/connector-application.md)

### Safety tiers

The studio catalog gives each writing tool one of three tiers.

| Tier | Meaning |
| --- | --- |
| `read` | Reads book content. Available by default in MCP, subject to the book's tool settings. |
| `write` | Changes the book, such as appending text or creating a chapter. In MCP, enable it with `--allow-writes`. |
| `destructive` | Sensitive content or structural changes. In MCP, enable it with `--allow-destructive`, which implies `--allow-writes`. |

`bookwriter` applies these flags on the client. An authenticated local HTTP client can use
the chapter and session routes and call non-destructive studio tools under those routes'
checks. The tool bridge checks the book's settings and validates tool arguments. A direct
destructive tool call requires `"allowDestructive": true` alongside `args` in the request body.
`bookwriter call` and MCP send this opt-in when launched with `--allow-destructive`.
Interactive turns in the app ask the author before running a destructive tool.
[External write requirements](../specs/024-agent-tool-parity/spec.md#requirements) ·
[D-143](../specs/024-agent-tool-parity/spec.md#open-decisions) ·
[Backend tool bridge](../apps/desktop/src/main/agent/tool-bridge.ts#L94-L151)

### Undo

The tool bridge writes an undo checkpoint when a built-in chapter tool reports a change,
such as an append or a recoverable deletion. The author can restore that change from the app.
[Tool checkpoints](../apps/desktop/src/main/agent/tool-bridge.ts#L146-L196)

### Tools the author has withdrawn

In **More → Agent → Tools**, switch a tool off for the selected book. The book stores that
setting. The writing agent and the per-book HTTP catalog omit the tool. CLI `call`, MCP
`tools/call` and direct requests to the named tool refuse it with
`turned off for this book. The author withdrew it.`
[Per-book catalog and refusal](../apps/desktop/src/main/agent/tool-bridge.ts#L66-L115)

`bookwriter tools`, its manifest exports and MCP `tools/list` use the general catalog and
can still list a withdrawn tool. Dedicated commands such as `read`, `save` and
`create-chapter` use library routes with their own checks.
[Toolkit integration checks](TESTING.md#the-end-to-end-layer) · [Chapter routes](../apps/desktop/src/main/backend.ts#L394-L413)

## Build and install

From the repository:

```bash
bun install
bun run toolkit:build
```

The build bundles `bookwriter` for Bun at `apps/toolkit/dist/bookwriter`. Keep Bun on `PATH`
to run it. Put the bundle on `PATH` or link the workspace binary.
[Toolkit build script](../apps/toolkit/package.json#L8-L17)

```bash
cd apps/toolkit
bun link
```

`bookwriter --help` lists every command.

## Start the backend

1. Start Open Book Studio and open a library.
2. Leave the app running. It writes `~/.ai-book-studio/backend.json` with a per-run token and removes
   it on quit.
3. Run the CLI or an MCP client. If the app is closed, the toolkit says so in one sentence.

The backend binds `127.0.0.1` on a random port. API requests require a loopback `Host`
header and the per-run bearer token. If a request carries an `Origin`, its host must match
the request host by default. The app serves the `/glasses` page and web app manifest on the
same host. The page still needs the token for API calls.
[Desktop listener](../apps/desktop/src/main/backend.ts#L176-L215) ·
[Request checks](../apps/desktop/src/main/backend.ts#L242-L296) ·
[Host and origin checks](../apps/desktop/src/main/backend.ts#L434-L461)

The locator is mode `0600`. Never
commit or share it.
`STUDIO_BACKEND_FILE` moves it for tests or an isolated profile. `BOOKWRITER_URL` and
`BOOKWRITER_TOKEN` override discovery for a caller with both values. The toolkit client accepts
loopback HTTP addresses.
[Locator and permissions](../apps/desktop/src/main/backend.ts#L489-L507) · [Client discovery](../apps/toolkit/src/backend-client.ts#L40-L97)

## CLI

```bash
bookwriter info
bookwriter books
bookwriter read book_abc12345
bookwriter read book_abc12345 ch_abc12345
bookwriter search book_abc12345 "salt road"
bookwriter conflicts book_abc12345
bookwriter tools
```

`--json` returns the backend payload for scripting. `read` without a chapter prints the book and its
chapter ids; `read` with a chapter prints the Markdown to stdout and the version/hash to stderr.

`bookwriter call` runs one studio tool against one book:

```bash
bookwriter call book_abc12345 append_to_chapter \
  --args '{"chapterId":"ch_abc12345","text":"The lamp turned."}' \
  --allow-writes
```

`bookwriter call` requires `--allow-writes` even for a read-tier tool. The dedicated read
commands above are available by default. [CLI command checks](../apps/toolkit/src/cli.ts#L272-L289)

## The ambient agent

```bash
bookwriter where book_abc12345
bookwriter ask book_abc12345 "carry on with the next scene"
bookwriter undo book_abc12345
```

`where` prints the line the agent would say and the actions currently available. `ask` starts
an Edit turn in the app, which can use the configured model and change the book. `undo` uses
the newest checkpoint. The CLI runs `ask` and `undo` without requiring `--allow-writes`.
[CLI session commands](../apps/toolkit/src/cli.ts#L238-L270) · [Loopback session routes](../apps/desktop/src/main/backend.ts#L342-L381)

| Authenticated loopback route | What it does |
| --- | --- |
| `GET /v1/books/:bookId/ambient` | Get the chapter, progress, last change and available actions. |
| `POST /v1/books/:bookId/turn` | Run an Edit turn and wait for the answer. Send `{ "prompt": "…" }`. |
| `POST /v1/books/:bookId/undo` | Undo the newest checkpoint by default. An optional `turnId` selects it only while that turn owns the newest checkpoint. A stale turn ID returns `409` before any restoration. |
| `POST /v1/books/:bookId/stop` | Request Stop for this book. The result counts accepted stop requests. |

If a turn reaches a destructive step, the waiting caller gets an error explaining that the
turn is paused for approval in the app. [Desktop turn behavior](../apps/desktop/src/main/agent/runtime.ts#L549-L604)

## Checked chapter saves

`save` and `create-chapter` require `--allow-writes`. For a save, read the chapter before
editing. Set `base_version` and `base_hash` to the saved version and SHA-256 hash from
that read, then pass both values with the revised Markdown.

```bash
bookwriter read book_abc12345 ch_abc12345 --json > chapter.json
bookwriter save book_abc12345 ch_abc12345 --allow-writes \
  --content-file revised.md \
  --base-version "$base_version" \
  --base-hash "$base_hash"
```

For a changed chapter body, a newer saved version or a different hash leads to a conflict
copy of the proposed edit. The library keeps the saved chapter. In text mode, `save` exits `2` on
conflict and reports the copy's location when present. With `--json`, inspect the returned
`status` for `"saved"` or `"conflict"` even when the command exits successfully.
[Saving and conflicts](FORMAT.md#saving-and-conflicts) · [CLI chapter writes](../apps/toolkit/src/cli.ts#L177-L214)

```bash
bookwriter create-chapter book_abc12345 --allow-writes --title "Two" --content-file two.md
```

For `save` and `create-chapter`, supply chapter text with `--content-file` or `--stdin` to keep it
out of the command line.

## MCP server

`bookwriter mcp` speaks MCP over stdio, one JSON-RPC message per line. It is read-only by default:

```json
{
  "mcpServers": {
    "ai-book-studio": {
      "command": "/absolute/path/to/bookwriter",
      "args": ["mcp"]
    }
  }
}
```

To enable write-tier tools such as `append_to_chapter`, start MCP with `--allow-writes`.
Use `--allow-destructive` to explicitly enable the destructive tier as well.

```json
{
  "mcpServers": {
    "ai-book-studio": {
      "command": "/absolute/path/to/bookwriter",
      "args": ["mcp", "--allow-writes"]
    }
  }
}
```

MCP mirrors the enabled tiers of the studio catalog. Each mirrored tool takes a `bookId`,
and its calls are subject to that book's tool settings. Chapter tools such as
`append_to_chapter` read and check the saved revision inside the studio.
[Tool mirroring](../apps/toolkit/src/mcp.ts#L275-L318) · [Checked chapter edits](../apps/desktop/src/main/agent/tools.ts#L178-L198)

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "append_to_chapter",
    "arguments": { "bookId": "book_abc12345", "chapterId": "ch_abc12345", "text": "The lamp turned." }
  }
}
```

`library_info` and `list_books` are callable without a book ID. `tools/list` also advertises
`list_conflicts` and `studio_status` by default, plus `studio_ask`, `studio_undo` and
`studio_stop` when writes are enabled. These five helpers take a `bookId`. The standard
per-book tool catalog omits their names, so the current MCP call check refuses those helpers
on a normal desktop setup. Use the CLI or the authenticated loopback routes for conflicts
and ambient actions.
[Ambient commands and routes](#the-ambient-agent) ·
[MCP call check](../apps/toolkit/src/mcp.ts#L131-L176) ·
[MCP helper definitions](../apps/toolkit/src/mcp.ts#L193-L273)

Successful tool results are JSON text content. Diagnostics go to stderr and stdout carries
only the protocol. [MCP stdio handler](../apps/toolkit/src/mcp.ts#L334-L353)

## Verification scope

The toolkit check runs the built Bun CLI and MCP stdio against an unpackaged desktop app
and a synthetic library. It checks writes and conflict copies on disk and verifies that the
per-book switch blocks calls. The plugin check loads a synthetic plugin folder in the built
app. Both are in the default suite that passed on unpackaged macOS arm64 at `e796143`.
[Default suite](TESTING.md#the-end-to-end-layer) · [Recorded build](../specs/039-reader-continuity-review/tasks.md#L99-L110)

The glasses check uses the desktop-served page in a same-host browser with a stub model
context. A separate opt-in desktop bridge binds to one selected local address. Its fixture
uses a second process on the same computer. The native phone-to-glasses journey stays in
the companion plan. [Glasses page check](../scripts/glasses-check.mjs) · [Desktop bridge](../apps/desktop/src/main/index.ts#L502-L533) · [Bridge probe](../scripts/bridge-probe.mjs) · [Companion plan](../specs/026-glasses/tasks.md#phase-6--the-real-glasses)

Installed builds and named independent clients need evidence for the exact artifact and
target. Remote toolkit access and a hosted MCP endpoint remain deferred.
[Product acceptance gates](PRODUCT-ACCEPTANCE-GATES.md#edge-register) · [Agent toolkit decisions](DECISIONS.md#agent-toolkit-decisions-2026-10-26)
