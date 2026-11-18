# Agentic coverage audit

## Current reconciliation — November 18, 2026

The October audit below is preserved as history. Its missing/unspecified rows and suggested spec
numbers are not current instructions. Reconciliation uses merged PRs through #63, the `320defb` expanded
requirements audit, exact candidate reports and the merged ordinary agent-interaction plan slices; it
is not a new live-provider or release audit.

| Area | Current evidence | Remaining owned work |
| --- | --- | --- |
| Discuss/Edit, request guidance and attribution | Reviewed PR #32 merged; ordinary plan proposal, guidance refresh, visible lifecycle, pause/resume, cancel, restart expiry and the synthetic journey are delivered at the source/test level | Separate 037 graph under ADR 0019; live provider, real manuscript, device and packaged-build acceptance remain |
| Word/length, memory and search | Tools expose saved counts, memory CRUD and scoped chapter search; the old “no search” claim is obsolete | Complete constraint reporting/context evaluation, independently of tool presence; no implicit cross-book access |
| Conversations | V1 files and compaction exist | D-113 now selects checked writes, explicit backed-up migration, recoverable deletion and replay exclusion; all-caller implementation remains |
| History | PR #33 merged verified saved-only core; exact restore/UI correction accepted and merged in PR #34 | Real API/Workspace mount, restore confirmation/recovery controls and cleanup |
| Planning/organization | `320defb` core/UI independently accepted | Library/API/Workspace integration and full Bible/series/collections/notes scope |
| Review | Local count report exists; D-193 scoped leaves require corrections; continuation seams merged through PR #63 | D-197–D-199 exact-current underlines, explicit saved feedback/application and full-book campaigns; coordinator execution remains, with no real coordinator session yet |
| Autonomous authoring | D-194–D-196 explicitly select authority, graph, direction, recovery and admission; check-in presenter shows counted inputs only | 037 T018–T042; actual brief→full-book pipeline, independent attempts and separate literary evaluation; no word-count source for check-in targets and no cadence contract; a campaign stage kind is refused as an authoring role and is not mapped onto one |
| Hands-free | PTT/spoken reply and 038 routes exist; D-200 selects sessions | 017 T013–T024 including original local input/read-following; 038 T022 remains unchecked |
| Verification | 012 has tasks and substantial contract/e2e/quality gates; candidate results are recorded separately | Unfinished adversarial/quality/platform/live gates remain; the old “no tasks” statement is obsolete |

Spec 017 is voice/background, 031 owns ordinary interaction and 037 owns full-book workflows; do not
create the historical proposed `017-agent-suite`. [Retained follow-through](RETAINED-DELIVERY.md)
assigns the original omissions. Accepted contracts and isolated leaves do not establish an integrated
full agentic product. The check-in channel and presenter refuse truthfully because no real coordinator
session exists yet. Two gate failures predate the presenter and stay with their owners: the browser
editor-focus check and bundle baseline drift. All 039, 037 and 038 task boxes for their gate owners
remain unchecked. The original audit follows unchanged.

## Historical October audit

**Checked:** 2026-10-26, branch `015-web-target`, commit `5ea08e9` (a pre-event commit); prompt, context, approval,
per-turn model and untrusted-data rows updated after that audit.
**Question:** do the specs cover the full agentic suite?

## Verdict

The specs describe a solid v1 agentic *writing assistant*. They do not describe the full agentic
*suite*, and the implementation is narrower than the text in two consequential places: approvals
(library replacement is still ungated) and safety/evaluation. Conversation persistence, history
compaction and the editing surface are now implemented; the spec's conversation lifecycle remains
unspecified.

Three labels are used below:

- **Covered** — the requirement exists and the code satisfies it.
- **Gap** — the requirement exists but the code does not satisfy it.
- **Unspecified** — no requirement exists, so nobody has decided the behaviour.

## Covered and implemented

| Requirement | Where | Implementation |
| --- | --- | --- |
| Manuscript changes only through tools | 002 FR-021 | `createChapterTools` and `ToolLoopAgent`; no prose-paste path |
| Untrusted author data | 002 FR-023a | The prompt wraps author, Story Bible and chapter data in `<untrusted_context>` and forbids following instructions inside it; chapter, Story Bible and search tools repeat the data warning |
| Untrusted material guard | 002 FR-023a | The prompt wraps book, Story Bible and chapter data in `<untrusted_context>` with a data-not-instructions rule; chapter, Story Bible and search tool descriptions repeat the warning |
| One stated limit per tool | 002 FR-022 | Zod input limits in `apps/desktop/src/main/agent/tools.ts` |
| Stop a turn coherently | 002 FR-025 | `AbortController`, `stopped` event, checkpoint before exit |
| Approval survives a reload | 002 FR-024/FR-024a | The approval part is stored on the turn message, updated on allow, deny and stop, and reloaded into the same Allow/Deny card |
| Preserve the author's concurrent edits | 002 FR-026 | `baseVersion`/`baseHash` save protocol and conflict copies |
| Checkpoint and one-action undo | 002 FR-027 | `CheckpointStore`, `agent.undoLast`, undo survives reload |
| Friendly tool summaries | 002 FR-028 | `ChatPanel` `toolLabel` keeps the main line plain; raw input/output sits behind a closed Details disclosure |
| Provider usage and unknown cost | 002 FR-029 | `UsageStore`, `stream.totalUsage`, OpenRouter reported cost, context percentage and a per-section estimated prompt breakdown |
| Refuse models without tool support | 002 FR-031 | Provider registry and model picker gate |
| Author-facing language | 002 FR-033 | Prompt "How to reply" rules; no tool names or ids |
| Book default connection and model | 011 FR-028 | `book.defaultConnectionId`, `book.defaultModelId` |
| Record model per turn | 011 FR-030 | `done` event carries provider, model and connection label |
| One-off model override | 011 FR-029 | `AgentTurnInput` carries an optional connection/model; the runtime validates it, records it on the turn and leaves the book default unchanged; the chat composer opens the picker in turn mode |
| Usage totals across all steps | 011 FR-034 | `stream.totalUsage`, not the last step |
| Failed turn keeps its request | 011 FR-039 | Retry map; retry withheld when the turn changed chapters |
| Model change visible | 011 FR-031 | `model-change` separator in the conversation |
| Shorten history before sending | 002 FR-030 | `compactHistory` keeps the last six user turns verbatim and summarizes older tool activity; the stored thread is unchanged |
| Story Bible reaches the agent; instructions snapshot-checked | 002 FR-020 | Prompt carries book description, saved memories and character description/motivations/notes; `read_story_bible` returns every field; snapshot test added |
| Base prompt under 4,000 tokens | 002 FR-032 | `gpt-tokenizer` o200k_base budget test on a 120-chapter, 30-character, 20-memory book; worst case 3,384 tokens |
| Full editing surface | 002 FR-023 | 22 tools cover read, find, insert, delete lines, replace, overwrite, append, create, move, split, merge, delete chapter and Story Bible read/update |
| Context overflow remedy | 011 FR-042 | The error reports the model's context limit and offers a larger model or a new conversation |

## Covered but missing

| Requirement | Gap | Evidence |
| --- | --- | --- |
| 002 FR-024 — destructive actions need in-turn approval | `remove_memory`, `overwrite_chapter`, `delete_chapter`, `delete_lines_in_chapter`, `move_chapter`, `split_chapter` and `merge_chapters` pause with the AI SDK user-approval protocol, an IPC answer and an Allow/Deny card. The request and decision are stored on the turn message. Library replacement is not gated yet. | `runtime.ts`, `ChatPanel.tsx`, ADR 0014 |
| 002 FR-027 — checkpoint history not pruned below a useful history | Only the latest checkpoint is read, and undo deletes it. One level, then nothing. | `CheckpointStore.latest`, `remove` |
| 002 FR-034 — check a word or length constraint after a rewrite | Tools return `wordCount`; nothing compares it with a requested constraint or reports the saved count. | `tools.ts` |
| 011 FR-035/036 — cost display and plan attribution | OpenRouter's reported final-step cost is displayed; other providers remain unknown and plan attribution is blocked by 011 tasks. | `runtime.ts`, `openrouter.ts` |


## Unspecified by any spec

- **Conversation persistence and lifecycle.** 002 lists "Conversation and turn" as an entity and FR-030
  says "stored conversation". The studio now stores, reloads, renames, branches and deletes threads
  (ADR 0013), but no requirement defines export.
- **Approval protocol.** FR-024 requires approval. The studio uses the AI SDK user-approval protocol
  (ADR 0014), stores each request and decision on its turn, and reloads it into the same card. A full
  app restart cannot resume a paused turn; answering the old card reports that it expired. No spec
  defines batching, timeouts, remembering a choice or automatic expiry after a restart.
- **Context assembly.** `compactHistory` shortens old turns, but no per-section budget, retrieval
  rule, summarisation policy or memory ranking is specified.
- **Prompt-injection evaluation.** The prompt now labels author/Story Bible data and tool results as
  data, not instructions, and escapes its own delimiters. There is no adversarial transcript or
  evaluation suite yet.
- **Evaluation of agent quality.** 012 is Draft with no `tasks.md`; there are no golden transcripts,
  tool-selection evals, edit-fidelity checks or refusal tests.
- **Planning and step visibility.** No plan/todo tool or progress surface; FR-028 only forbids
  "Analysis / Plan" headings.
- **Memory lifecycle.** Author-side CRUD exists (FR-019), but agent-side read, update, remove, dedupe and
  importance ranking are unspecified.
- **Spend caps.** Usage is recorded, but no per-turn or per-book budget can stop a run.
- **Library-wide agent search.** Book search exists for the author (FR-009); the agent has no search tool
  and cannot find text outside the chapter it reads.

Out of v1 scope but part of a "full agentic suite": subagents, background or scheduled runs,
multi-book reasoning, and voice/illustration tools. 002 treats illustration and read-aloud as separate
product features, not agent tools.

## Recommended shape

1. **Amend 002** with requirements for conversation persistence, the approval protocol, prompt-injection
   safety, memory lifecycle and a token-based prompt budget.
2. **Write `017-agent-suite`** if those become one capability: conversation storage, complete tool
   surface, approvals, context assembly, safety and evaluation. Keep 002 as the product contract.
3. **Give 012 a `tasks.md`** and an agent-eval section: recorded provider exchanges, golden transcripts,
   tool-choice accuracy, edit fidelity, refusal and injection cases.
4. **Two ADRs**: conversation storage (files under `threads/`, per book, rebuildable index) and approval
   ownership (main-process policy, renderer prompt, auditable outcome).

## Suggested implementation batches

| Batch | Work | Requirements |
| --- | --- | --- |
| A | **Done** — 22 tools cover the editing surface; library replacement remains a separate approval-gated action | 002 FR-023 |
| B | **Partly done** — `remove_memory` has request, allow/deny and checkpoint-first; batch summary, other destructive tools and a smoke journey remain | 002 FR-024, ADR 0014 |
| C | **Partly done** — threads persist, reload, rename, branch and delete, `compactHistory` shortens old turns; full tool-part replay remains | 002 FR-030/FR-031, 011 FR-031 |
| D | **Done** — prompt carries memories and character detail; `read_story_bible` returns the full bible; snapshot and 4,000-token budget tests added | 002 FR-020/FR-032 |
| E | Plan cost (the injection guard, per-turn model override, context use, breakdown and overflow remedy are done) | 002 FR-023a/FR-034, 011 FR-035 |
| F | Agent evals and contract fixtures | 012 |

## Verification baseline

- `bun test` — 308 pass.
- Desktop hidden smoke — 16/16.
- Web hidden smoke — 11/11.
- Chromium real-storage matrix — 12/12; Firefox/WebKit OPFS findings recorded.
- Packaged desktop smoke — 16/16.
