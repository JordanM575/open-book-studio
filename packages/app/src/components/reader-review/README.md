# Structured reader review leaf

`ReaderReviewPanel` is an isolated, one-book, volatile spec 039 UI under D-193 / corrected ADR 0018.
`ReaderReviewHost` mounts it in the Workspace behind the author's explicit "Open reader review"
action; no provider path starts on mount or on a rerender. Optional explicit Save review uses an
injected validated review-record API and a pre-bound Library/view scope; there are no implicit
writes or ThreadStore calls. Saved-record inspection is mounted separately in Workspace and does not
invent a reader executor.
Import the component from `@ai-book-studio/app/components/reader-review/ReaderReviewPanel`; the
Workspace entry is `ReaderReviewHost` in the same folder. The colocated `contracts.ts` defines its
callback types. Core imports use the `review/*` leaf exports.

## Inputs and lifetime

- `open`, `bookId`, `viewKey`: closing or changing the book/view unmounts the session and drops
  snapshots, profile versions and results. Set `viewKey` for each host view lifetime, including
  returning to the same book. A mounted A→B→A sequence cannot revive A's first session callbacks.
- `disclosureRevision`: change for any selected-scope, profile, destination/endpoint, capability,
  price, terms or consent change, even if the display names remain equal. It cancels in-flight work
  and clears an unsent disclosure, while preserving completed historical runs in the same view.
- `supported`: must be known before source preparation. False disables preparation/Start.
- `persistence`: optional `{ api, scope }` from `StudioApi.reviewRecords` and
  `api.open(bookId, viewKey)`. Use a fresh UUID `viewKey` for each view lifetime, bind the scope when
  opening the view, and never resolve a new Library lazily on Save. A mismatched book/view scope
  disables Save. The button preserves the volatile result on refusal/conflict/failure, displays
  verified conflict-copy paths, and disables another save after an uncertain receipt until the
  author has inspected saved records. A confirmed repeated save uses the existing immutable writer.
- `currentSources`, `editor`: host-supplied current saved snapshots and actual editor identity/
  cleanliness. Missing, malformed, ambiguous or changed evidence cannot enable exact navigation.
  Publish new facts when sources/editor state change. An unavailable prepared source clears its
  disclosure instead of reviving authorization if the old source later returns.

Navigation passes editor facts untouched to the descriptor-first core verifier; it never reads
`clean` to decide whether to validate. Malformed accessors are refused without application getter
effects. This is not a framework-wide promise: React development performance tracks can inspect
changed nested props before or after component code. Hosts must supply plain data facts at the React
boundary; adversarial helper transitions and separate Strict Mode refusal/positive mounts are tested.

Opening, refreshing the host, updating props or resolving a promise never invokes Start. Preparing
or refreshing the disclosure requires a button action; a separate provider-named Start sends the
exact registered immutable envelope displayed. Every accepted preparation needs a new request ID,
including a refreshed or cancelled request. The UI rejects repeated IDs in its session and locks
concurrent actions synchronously. The runtime still owns authoritative single-use request handling.

## Injected callbacks

1. `onPrepare({ bookId, signal, previousRunId })`: check host support first, resolve the author's
   explicit selection, capture saved sources under the existing Library identity rules, and return
   `ready` with `{ envelope, terms }`, or `blocked` with an enumerated refusal. Never send, persist,
   silently trim, select additional sources or include previous feedback implicitly. The first UI
   accepts exactly one book. Selection/profile editing lives in the host; no picker or library reader
   is introduced here. `previousRunId` is a hint for an explicit rerun, not permission to reuse inputs.
2. The envelope must be a core-registered `reader-review` value with its complete immutable profile
   (Alpha, Beta or author identity/version). After an IPC round trip the host must use the core
   validating parser before supplying it. Each book needs matching `termsRevision`, nonempty
   `dataUse` and `training` text from the existing provider policy service. Terms text is detached
    and frozen; it does not grant consent. The UI requires the bound consent/capability facts too.
    A sparse/inherited/accessor terms entry is invalid. Callback data is checked before reading
    discriminants; unknown/prototype-name refusal reasons select a fixed local string.
3. `onStart({ envelope, signal })`: immediately re-resolve selected saved revisions/values and
   revalidate destination, capabilities, price facts, each book's consent and applicable terms after
   asynchronous boundaries. A change returns `blocked`, with zero sends; never dispatch a replacement
   envelope. Consume the unique request once. Invoke only the scoped foreground executor/facade,
   not ordinary conversation prompt/history/SKILLS/tools. Enforce final adapter-wire and streamed
   output limits, no fallback/repair/retry, and zero conversation/report/profile writes on all paths.
4. Return `completed` with the core-built immutable `ReaderRun`, `blocked`, or `failed` with a bounded
   failure category. The leaf rebuilds findings against the disclosed registered envelope with the
   core builder, deriving subjective/evidence labels again rather than trusting returned flags.
   Previously withheld evidence stays withheld/countable; its original private payload is not needed.
   Raw thrown errors are not printed. This display check does not replace runtime validation.
5. `onStop({ requestId })`: best-effort cancellation. Signals are aborted immediately; late results
   are ignored regardless of whether the host honors cancellation. Stop is invoked for active Starts
   on explicit stop/close, book/view changes, disclosure changes, unsupported-host changes and unmount.
    Already-sent text cannot be recalled. Stop failure says confirmation failed, not that dispatch ceased.
    Same-view disclosure/support invalidation retains pending or failed stop confirmation across
    further passive fact changes. Beginning a new explicit operation or closing retires that notice's
    ownership, so an older stop reply cannot replace new progress or revive a closed view.
6. `onNavigate({ run, citation, signal })`: revalidate exact saved identity/version/hash/quote and the
   actual clean destination editor **immediately before selection**, including after awaits. Honor
   abort before touching a new view. Return `selected`, `stale` or `unavailable`; never fuzzy-search
   or select a replacement. A host refusal disables that historical link for this session. Bible
   evidence stays readable but has no current editor navigation in this slice.
7. `onClose`: close the host surface (`open=false`) and restore focus to its opener. The leaf clears
   displayed volatile data immediately and aborts pending work. The host owns the containing dialog
   or panel's focus trap/return; the leaf uses native labelled buttons/details and a focused polite
   status region for preparation, Start and stop transitions.

## Rendering and verification scope

Exact selected text, merged ranges/line labels, saved versions, provider/model/destination, all sent
profile guidance/request/feedback, cost facts (including known zero), unknown context fit and terms/
consent readiness are inspectable before Start. Historical runs retain attribution and quotes;
comparison separates source/profile/destination/request changes from interpretation changes and
labels same-input model variation without improvement scores. Runs remain in memory until close or
book/view change unless explicitly saved. D-199/D-171's saved-review writer retains only feedback,
attribution and bounded quotations, not the full source bodies or provider payload. The UI implements
no writer and does not implicitly authorize retention.

The leaf uses shared tokens/Button and native controls, with no custom motion, blur, CSS or theme
state. Shared base styles own reduced-motion/transparency behavior. Focused DOM tests cover injected
callback behavior and synthetic failures/races. Actual host keyboard navigation, focus return,
light/dark/reduced-preference rendering, supported-platform serialization, transport/writer spies
and integrated acceptance remain coordinator-owned. The scoped-core/UI correction needs fresh
independent exact-head acceptance before mounting; this leaf does not certify host dispatch or storage.

## Saved-record integration (W10 v20 continuation)

`SavedReviewsPanel` is reachable in the real Workspace. It lists and reads reports, keeps named
corrupt/future-file issues visible with separate pagination, shows captured revisions/attribution
and historical verified-at-capture quotations, reads saved disposition history, and keeps local
choices/notes through failed reads, refused saves, filtering and collapse/reopen in the same view.
Its browser adapter uses the current `LibraryService.reviewRecords`.

The host transport binds every request/reply to a nonce, complete request digest, opaque Library
identity, book and view. Reads bind report ID/raw hash; disposition reads additionally bind their
report hash. The receiver verifies exact bytes, profile digest, record semantics and save intent.
Neither transport nor UI retries malformed/foreign/uncertain replies.

Desktop `Library` now forwards its existing service's `reviewRecords`; registered IPC and actual
preload are tested against that real wrapper. The browser and desktop share the validated handler.

`saveDisposition` submits the inspected report bytes/hash and absent or exact disposition
bytes/hash/revision. `recordDispositionChecked` consumes them under the existing Library queue,
builds from the author's baseline, and preserves the complete intended stale history as a conflict
copy. It never invokes the older host-internal append-to-current method. Both transport edges
verify the complete saved output or conflict copy, including supported unknown fields. Drafts bind
to the baseline when editing starts; rereading does not silently rebase them. A submitted draft stays
locked on failure/uncertainty until fresh inspection and explicit “Use inspected history for this
draft”. A late success does not discard text edited during the await or revive a retired view.

Recovery lists at most 50 trash groups per page. Active/trash inspection returns exact report and
disposition content plus a host-issued one-use confirmation bound to the Library/book/view and
group identity/hash. The confirmation UI shows attribution, historical findings/quotes, disposition
history and raw content (including unknown fields), then requires an explicit checkbox and action.
No arbitrary renderer path or copied snapshot grants permission. Confirmation consumes permission
before mutation, rechecks all sources/absent members, and only restores to free destinations.
Partial disposition-only groups can recover beside their exact active report dependency. Unknown,
future or corrupt files remain unavailable and untouched. Multi-file moves are not a transaction;
partial/uncertain outcomes keep their files and demand fresh inspection, never automatic replay.
Collapse, host replacement and A → B → A retire pending replies and recovery permission in the UI.

Focused synthetic API/Library, mounted browser and actual desktop wrapper/preload tests establish
this connected disposition/trash/restore slice. Connected generation, safe Markdown export,
archive/continuation acceptance, provider quality, native keyboard/theme accessibility and release
acceptance remain separate gates. 039 T014/T015 and 038 T022 remain unchecked.

## Mounted selected-source prepare/start (039 T003)

`ReaderReviewHost` owns the Workspace entry, Alpha/Beta lens and saved-chapter picker. It checks
support before reading the chapter list, loads only through the existing book read channel, and
passes whole saved chapters as exact half-open UTF-16 ranges to the one `readerReview:request`
surface. Unreadable chapters are named from `chapterReadIssues` and cannot be selected. There is no
select-all, implicit current chapter, title/path lookup, outline/Bible/SKILLS read or library scan.

The host's Prepare adapter calls `readerReview:request` once, re-validates the returned envelope
through the core parser, and calls `acceptPreparation` before the leaf displays it. Start sends only
the request id and scope digest. Cancel preparation and Close call `cancelPrepare`; Stop calls the
single-use request `stop`. The leaf displays only the host's bounded refusal, detail, failure and
stop result. It never claims a refund, a rollback or recall of text already sent.

The desktop main process derives 011 connection/plan/model readiness and 022 default-off book
consent from existing provider facts, freezes the same envelope used for disclosure and provider
serialization, and keeps the pending request in memory only. Start re-reads the same saved chapters,
re-checks the pinned destination, capabilities, terms, consent and exact revisions, consumes the
request and makes one transport call with no retry, repair, fallback or model change. A changed
source, destination, consent or digest returns blocked with zero sends. No report, profile,
conversation, campaign, checkpoint or manuscript writer is reachable from this path.

Browser and other unsupported hosts expose `unsupportedReaderReviewApi`: support is false and every
operation refuses before a private read. T004–T006, T008–T009 and T010–T019 remain separate work;
039 T003 stays unchecked until independent exact-head review and merge.
