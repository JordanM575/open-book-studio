# Manuscript review: an evidence-linked report on saved text

**Status:** In progress — saved-count/coverage report exists; D-198 selects repetition v1 and D-199 selects explicit retention, with implementation and remaining-host evidence open
**Number:** 034
**Depends on:** [002](../002-studio-v1/spec.md) for the book, chapter and shared-count contracts; the existing storage boundary for confirmed saved chapter text.

## Why

An author can see word counts and ask the writing agent questions, but there is no distinct place to
run a repeatable review and inspect what in the manuscript supports each result. A report should help
an author notice patterns without pretending to judge the book, changing the manuscript, or hiding
how much text it could actually inspect.

The first milestone is deliberately small: an author explicitly starts a deterministic, local,
read-only analysis of the current book's confirmed saved chapter text. It produces a disposable,
structured report with the existing studio word counts, the accepted repeated-phrase signal, visible
definitions and coverage, and links to the exact saved text behind each finding.

## Present public behavior and proposed behavior

**Present:** The desktop report, library, chapter rail and editor show word counts. Spec 002 FR-016 requires word,
character and paragraph counts to use the shared counter. The public word-count contract trims the
text, returns zero for empty text, and otherwise counts whitespace-separated tokens; punctuation is
not stripped (`one — two` is three words). The writing agent can answer in a conversation, while
[025](../025-agent-capabilities/spec.md) covers operational cache and tool metrics. The report has
coverage and fixture-tested evidence plumbing; the repetition scanner has shipped (T008, repetition-v1,
worker-cancelled, paginated) and evidence navigation remains partially open (T016).

**Proposed:** A separate **Review manuscript** action runs only when the author asks. It reads the
current book's saved chapter bodies, never an unsaved editor buffer, Story Bible text, agent thread,
image, or provider. It creates an in-memory report for that run only. This is a new product surface;
it does not change the existing count contract or manuscript format.

## Product boundary

- **034 is a report.** Its first milestone is deterministic and local. It has no chat, model request,
  edit tool, rewrite, correction, or quality score.
- **037 is a separate conversational foreground agent review journey.** A conversation is not this
  structured report, and this report does not start or continue an agent turn. Neither journey
  silently writes to a chapter.
- **025 is operational agent telemetry** (cache and tool-use metrics), not analysis of manuscript
  prose. **028 is integration health** for locations and providers, not manuscript review.
- Later, separately specified phases may add explicitly requested model critique, reader personas,
  rereads, or series analysis. They are not part of this milestone. Any such phase must disclose the
  provider, model, text sent, price or unknown price, and applicable training/data-use terms before a
  request; require the author's explicit consent; honor the book-level default-off consent gate for
  training-eligible models in [022](../022-provider-compatibility/spec.md) / D-138; never silently
  switch models; and return suggestions only, without rewriting or correcting text.

## Author scenarios

1. **Run on what is saved.** I open a book, save any edits I want included, choose Review manuscript,
   and see which saved chapters the report inspected.
2. **Inspect evidence.** I open a finding and the studio takes me to the exact matching words in the
   saved chapter, with enough surrounding text to recognize the passage.
3. **Know what the report means.** I can see the definition of each measure and distinguish “no
   matches” from “not enough saved text” or “some chapters were skipped.”
4. **Stay in control.** I can cancel a run. If a chapter changes after the run, the report says it is
   stale and will not take me to a different passage as if it were the original evidence.

## First milestone requirements

- **FR-001 — Explicit run.** The author MUST start each review with an explicit action. The report
  MUST identify the book, run time, scope and source snapshot. It MUST NOT run in the background, on
  every save, or merely because the author opened the view.
- **FR-002 — Saved source.** The run MUST use only chapter bodies read from the current library's
  saved files. It MUST include all chapters in the current book in reading order; it MUST exclude
  Story Bible fields, book metadata, front/back matter stored outside chapter files, conversations,
  checkpoints, images and unsaved editor buffers. If any chapter in scope has unsaved edits, the
  author MUST save it through the existing save flow or cancel before the run starts. A save conflict
  or failure MUST stop the run and identify the chapter; the review action MUST NOT resolve a
  conflict or save text silently.
- **FR-003 — Read-only and local.** Analysis MUST NOT change chapter text, metadata, versions, hashes,
  conflicts, checkpoints, usage records, caches or any other library file. The first milestone MUST
  make no provider request, network request or telemetry event. It MUST NOT create a checkpoint.
- **FR-004 — Existing word count.** The report MUST reuse the public shared word-count semantics, not
  define a second word count. Empty or whitespace-only text is zero; otherwise each whitespace
  separated token counts once, including punctuation-only tokens. The report MUST label this as the
  studio word count, not as a linguistic or editorial judgment. The book total MUST be the sum of
  the included chapters' counts.
- **FR-005 — Repetition v1 (D-198).** Scan overlapping three-token windows independently within each
  saved chapter. Tokens use Unicode letters/numbers with combining marks and internal straight/curly
  apostrophes. Comparison keys use NFC, locale-independent lowercase and U+2019→U+0027; keep original
  UTF-16 source spans. Punctuation separates tokens; windows may cross sentence punctuation, never
  chapters. List sequences occurring at least twice across the selected book, counting every overlap
  and retaining every location. No stemming, stopwords, ideal threshold or overuse verdict. Version
  the analyzer, show exact evidence and paginated complete coverage. Implemented by T008 (repetition-v1).
- **FR-006 — Definitions and coverage.** The report MUST make each metric's definition available
  beside its result. It MUST show the number of chapters in scope, included, empty and skipped, and
  give a plain-language reason for every skipped chapter. It MUST distinguish a complete report
  with no phrase matches from partial coverage and from insufficient evidence. When worker findings
  are checked only as passages are opened, zero findings MUST also be labeled as an unverified
  worker result, not confirmation that no repetitions exist. Saved-source freshness alone does not
  verify aggregate completeness. Worker-derived studio word counts, coverage classifications and
  insufficient-text conclusions MUST also be attributed and labeled unverified until checked against
  saved text. This includes nonzero counts and empty classifications, not just zero findings.
  Skipped chapters and insufficient text keep their own explanations; the report MUST NOT imply that
  skipped chapters are empty. Opening one verified passage does not verify the remaining metadata.
- **FR-007 — Exact evidence navigation.** Every phrase finding MUST be tied to its chapter identity,
  source version/hash and exact span in the saved body, and MUST show its chapter title/order and a
  short excerpt. Selecting a finding MUST open that chapter and highlight the exact span if the
  source is still current. If the chapter has changed or the span cannot be verified, the studio
  MUST mark the report stale and MUST NOT highlight a different passage.
- **FR-008 — Stale report.** The app MUST compare the report's source versions/hashes with the
  current saved chapters when the report is shown and before evidence navigation. If a source changed,
  the report MUST remain visibly marked **Stale**, identify affected chapters, disable navigation to
  changed evidence, and offer a new run. It MUST NOT silently update findings against new text.
- **FR-009 — Cancellation.** The author MUST be able to cancel an in-progress run. Cancellation MUST
  discard partial output and show a stopped state with an option to run again. It MUST leave the
  manuscript and all files unchanged and MUST NOT present partial output as a completed review.
- **FR-010 — Insufficient evidence and errors.** If no readable in-scope chapter contains saved
  prose, show **Not enough saved text to review**, not a successful “no findings” result. If some
  chapters cannot be read or verified but others can, show a partial report with the omitted chapters
  and reasons. If no source can be verified, show a failure state with the next safe action; do not
  display an empty report as success. Keep the fresh run's available skipped filenames and reasons
  in that failure view without replacing the live editor. Distinguish source-read issues from
  unverified worker classifications, including an all-skipped conclusion. Infrastructure failures
  give worker-appropriate retry guidance rather than assuming unreadable chapter files.
- **FR-011 — Disposable report.** The first milestone MUST keep report data in volatile run-local
  state only. It MUST NOT write a report, excerpt, run history or retention metadata to the library,
  app profile, index, conversation store or usage log. A new run replaces the current report; changing
  books, closing the window or restarting the app discards unsaved state. D-199/ADR 0020 separately
  permits explicit Save review/export with recoverable ordinary files; formats/storage tests precede
  those writers. An ordinary run remains write-free.
- **FR-012 — Repeatability.** Given identical saved chapter bodies and the same analyzer version,
  repeated runs MUST return the same counts, phrase set, occurrence order and source spans.

## Acceptance scenarios

1. **Saved text only.** Given a chapter with an unsaved edit, when I choose Review manuscript, then
   the run is blocked until I explicitly save through the normal save path or cancel. A conflict or
   save error leaves the review unstarted and the author's text preserved by the existing save
   contract.
2. **Counts agree.** Given a saved body `one — two`, when I run the review, then its studio word
   count is three and matches the count shown elsewhere in the app.
3. **Repeatable phrase.** Given synthetic saved chapters containing the same three-token sequence
   twice, when I run twice without changing the files, then both reports list the same phrase, count
   and exact locations. A sequence split across two chapters is not a match.
4. **Coverage.** Given an empty chapter, an unreadable chapter and one readable chapter, when I run,
   then the report names all three statuses and the reason for the unreadable chapter; it does not
   imply that omitted text had no findings.
5. **Exact evidence.** Given a phrase finding in an unchanged chapter, when I select it, then the
   editor opens the correct chapter and highlights exactly the source span shown in the report.
6. **Stale evidence.** Given a completed report and a later edit to one source chapter, when I view
   the report or select its finding, then the report is marked stale and does not navigate to an
   unverified span in the new text.
7. **Cancel.** Given an in-progress review, when I cancel, then partial findings are discarded, a
   stopped state is shown, and no library or report file is written.
8. **Insufficient evidence.** Given a book with no readable saved prose, when I run, then the studio
   says there is not enough saved text; it does not report “no findings.”
9. **Disposable.** Given a completed report, when I switch books, close the app or start a new run,
   then the prior report is no longer available and no review history is written.
10. **No inference or edits.** With no provider connected, the deterministic review still runs. No
    provider is called and no manuscript text changes.

## Non-goals

- Conversational foreground review, model-generated critique, personas, rereads or series analysis.
- Grammar correction, rewrite, auto-fix, style grading, quality score, or silent text changes.
- Comparing drafts, unsaved text, Story Bible content, non-chapter files or a second book in the
  first milestone.
- Automatic saving, retention or eviction. Explicit saved feedback follows D-199/039 T014–T015.
- Agent cache/tool performance, provider/location health, or usage/cost dashboards.

## Assumptions

- The first run is book-wide and includes all chapter files that the existing library can read and
  verify. There is no chapter picker in this milestone.
- The shared public count contract remains authoritative. Any future change to it belongs in the
  existing shared counter and its own tests, not in this feature's analyzer.
- Unsaved excerpts remain volatile. Explicit saved reports retain bounded quotes under D-199, never
  a second complete source-body copy.
- Deterministic review is available without a provider key and performs no network access.

## Decisions and remaining implementation

Open decisions block only the tasks that depend on them; they do not block independent work on the
read-only source contract or saved-count reuse.

1. **Initial metric set — historical November 3 outcome; expanded November 7.** The first report
   measured saved words and coverage only; repetition was then deferred.
   The decision used synthetic examples: case/punctuation folding, hyphen matching and chapter
   boundaries behaved as proposed, while curly and straight apostrophes did not match under the
   retain-apostrophes rule. D-198 / ADR 0020 now selects the exact FR-005 algorithm including
   apostrophe unification; T008 and report copy can proceed. This is policy, not scanner evidence.
2. **Initial host surfaces — decided 2026-11-03.** Desktop ships first; the browser and mobile
   targets reuse the shared app component and follow later. Each host must still prove saved chapter
   text plus version/hash revalidation before it ships the review.
3. **Persistence and retention — accepted D-199/D-171, November 7.** ADR 0020 selects volatile
   default, explicit immutable save, checked dispositions/profiles, recoverable trash, no pruning
   and ordinary archive/sync inclusion. Field-level/continuation formats precede writers. The old
   20-report eviction/sync-exclusion proposal in `research/report-retention.md` is historical only.
4. **AI-assisted phases.** Decide the scope and disclosure flow in a separate follow-on spec before
   adding model critique, personas, rereads or series analysis. That spec must resolve provider/model
   display, exactly what text is sent, cost/unknown-price presentation, applicable data-use and
   training consent, refusal/no-fallback behavior, and the no-write boundary. These questions block
   only future provider-backed tasks; they do not block this deterministic milestone. D-193 and
   D-197–D-199 now define those follow-ons in 037/039; model generation remains read-only.
