# The writing agent's capabilities

The agent inside Open Book Studio is the author's own. This page is what it can be told, what it can
be shown, and what it can be extended with. Everything here is per book, so two books in one
library can behave differently.

## The cache prefix

The system instructions and the tool definitions do not change between the turns of one
conversation, so they are the stable prefix of every request. Where the provider has an explicit
cache marker, the app marks that prefix: the system message and the last tool definition (the
provider caches the whole tool block as one prefix, and it allows few breakpoints, so marking
every tool would waste them).

The app shows the hit rate for the book:

- The share of input tokens the provider served from its cache.
- How many turns hit the cache at all.
- How many tokens were served from the cache and how many were sent.

A provider that does not report a cache — OpenAI and the OpenAI-compatible providers included — is
shown as **"This provider does not report a prompt cache."** That is not a rate of zero. The
difference matters: a zero would say the cache did nothing, when the truth is that nothing was
measured. The usage log records whether the provider reported its cache at all, so a measured zero
and a missing measurement never look the same.

The prefix can be turned off for a book, in **More → Agent**. The setting is
`settings.cache.prefixMode`, either `auto` or `off`.

## The tool metrics

Every tool call is counted per book: how many times the agent called the tool, how many succeeded
and how many failed. The numbers live beside the usage log in the library's derived `.studio`
folder, and they are derived data: losing them loses the metrics, never the prose.

**More → Agent** shows the totals and the per-tool numbers, next to the cache rate. Each tool row
shows how many times the agent called it, how many succeeded and how many failed.

## Turning a tool off

**More → Agent → Tools** lists every built-in tool with its safety tier, and a switch for each.

A tool that is off:

- is never offered to the model, so the agent cannot call it;
- is refused by the loopback backend, so the command line cannot call it;
- is refused by the MCP server, so another agent cannot call it;
- is left out of the per-book catalog the toolkit reads.

The setting is per book (`settings.agent.disabledTools`), so it travels with the book.

## The book's own instructions

A book folder may hold a `SKILLS.md` file. When it does, its text is given to the agent as the
author's own instructions, in the trusted part of the system prompt — the same place the studio's
own instructions sit, not inside the untrusted block that holds the book's content.

That placement is deliberate. Everything inside `<untrusted_context>` is data the agent must read
but not obey: the Story Bible, the chapters, the tool results. A `SKILLS.md` is the author's own
file in their own library, so it is a rule, not a quotation. It is bounded to 8,000 characters, so a
long file cannot crowd out the book.

The file is read through the library, so it is part of the book and is visible in the file browser.

## Plugins

The author can point the app at a folder of TypeScript tools. The folder is a library-level
setting, not a book setting, because it points at code on this computer: a book that travels to
another machine never carries the path with it. The tools the folder provides are still filtered
per book by the withdrawn list.

**More → Agent → Plugins** picks the folder and shows what loaded, what it provides, and what
failed.

### The contract

A plugin file exports a plugin. It needs no imports:

```ts
export default {
  name: "word-count",
  tools: [
    {
      name: "count_words",
      description: "Count the words in a chapter.",
      parameters: {
        type: "object",
        properties: { chapterId: { type: "string" } },
        required: ["chapterId"]
      },
      handler: async ({ chapterId }, ctx) => {
        const chapter = await ctx.library.readChapter(ctx.bookId, chapterId);
        return { words: chapter.wordCount };
      }
    }
  ]
};
```

The arguments are a JSON Schema, because a plugin folder usually sits outside the app, where the
app's own `zod` cannot be resolved. A plugin with its own `node_modules` may use a Zod schema
instead.

The handler's context has the book id and the library, and nothing else:

| Member | What it does |
| --- | --- |
| `ctx.bookId` | The book the agent is working on |
| `ctx.library.readBook` | The title, description, cast and memories |
| `ctx.library.readChapter` | One chapter's full text |
| `ctx.library.listChapters` | The chapters with their ids and word counts |
| `ctx.library.saveChapter` | A whole-chapter write, with the version and hash guard |
| `ctx.library.appendToChapter` | An append, with the version and hash guard |

The handler context exposes book data and checked `Library` operations. Chapter writes through
`ctx.library` use the same atomic save and version guard as built-in tools.
[Plugin library adapter](../apps/desktop/src/main/agent/tool-set.ts#L147-L186)

### The rules

- A plugin may not shadow a built-in tool. When the names collide, the built-in tool wins.
- A plugin that fails to load is reported and skipped. The built-in tools keep working.
- The toolkit classifies plugin tools as `write`. CLI calls and MCP invocation require the
  write opt-in described in the [toolkit guide](TOOLKIT.md#safety-tiers).
- The folder is read on demand. Restart the app, or ask for a reload, after adding a file.

### Proving it

`bun run plugin:probe` runs the built app against a throwaway library and a folder of TypeScript
plugins, then asks the app's own backend for its catalog and for one plugin call. The pass is
recorded in [`docs/research/plugins-2026-10-26.md`](research/plugins-2026-10-26.md).

### What a plugin is not

It runs **inside the app's own process**, in the app's Node runtime. It is code the author chose
to run, on the author's own computer, with the author's own books. There is no sandbox and no
separate process in this release, and the app says so plainly wherever plugins are enabled. Only
point at code you trust.
