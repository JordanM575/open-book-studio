# Tasks: book formatting and export

**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)
**Status:** In progress. Phase 1 (T001–T005) is done; D-108 is accepted (T006) and PDF and EPUB export
exist, so T015–T017 are partly done. D-169 and D-170 are accepted (T007, T008), and ordered matter is
built and exported (T009–T013). The Markdown folder contract is recorded by D-202; the folder export
(T014) is open.

All tests in this plan use synthetic fixtures in isolated temporary libraries. Do not use real
manuscripts, credentials, live providers, paid services or devices.

## Phase 1 — Unblocked editor, preview and current DOCX contract

- [x] **T001** Design the Format journey around the existing `settings.manuscript` values. Specify the
  target selector, unsupported-target state, accessible control labels and a persistent **Approximate
  preview** disclosure. Do not add persisted format-profile fields or duplicate typography settings.
  Recorded in `specs/035-book-formatting/research/format-journey.md`: toolbar + overflow entry,
  native radio target selector (DOCX available; PDF/EPUB/Markdown disabled with Planned notes),
  typography controls bound to `settings.manuscript` with immediate full-settings-merge saves,
  always-visible disclosure, idle/saving/error/cancel states, saved-chapters content source.
- [x] **T002** Build the local approximate-preview surface from a synthetic saved-book fixture. Verify
  that its disclosure is always visible and that it makes no page-count, trim-measurement, pagination
  or publisher-readiness claim. No export engine or matter schema is needed for this task.
  Built as `FormatDialog` (`packages/app/src/components/FormatDialog.tsx`) wired into
  `WorkspaceView` (toolbar `format-book` + overflow `more-format`); preview renders saved chapter
  bodies with the selected typography and a nondismissible disclosure. Hidden smoke asserts the
  preview and disclosure in the real UI.
- [x] **T003** Add UI contract tests with synthetic content for canonical typography binding, keyboard
  access, preview disclosure, target availability, and idle/error/cancel states. Keep all preview data
  local and assert that opening it causes no provider request or source write.
  Covered by `apps/desktop/tests/format-dialog.test.tsx` (5 pass): settings binding, full-merge
  persistence preserving agent/cache sections, disclosure across idle/change/failure, disabled
  planned targets, schema-enum option parity, failed-save revert + notice, no chapter writes.
- [x] **T004** Characterize the current DOCX journey with a synthetic isolated library: pending editor
  input is flushed first, the main process reads saved book data, current canonical typography is
  applied, and attached images are resolved through the existing 019 store. Assert that source files
  are unchanged. Do not assert PDF/EPUB behavior, exact pagination or publisher compatibility.
  Covered by `apps/desktop/tests/export.test.ts` (typography OOXML anchors for Georgia/14pt/1.5/0.3in/Left,
  whole-library byte-identical snapshot, `collectDocxImages` store/skip rules) and
  `apps/desktop/tests/docx-export-flush.test.tsx` (dirty editor saves before `books.exportDocx`,
  author sees the saved-file note). The illustration step moved verbatim into
  `collectDocxImages` (`apps/desktop/src/main/export.ts`) so the boundary task can reuse it.
  One editor fix: unmount now clears the pending draft timer, which otherwise fired into a
  torn-down bridge after checks.
- [x] **T005** Specify and test the current DOCX safe-publication boundary using synthetic fixtures:
  cancel before destination selection, source-path alias rejection, explicit replacement consent,
  destination recheck, staged output, and preservation of any prior output on injected failure or
  cancellation. This task must not require a new book schema or a new renderer choice.
  Implemented as `exportManuscriptDocx` (`apps/desktop/src/main/export.ts`) with injectable
  picker/consent/stat/writer seams; the initial handler retained its `string | null` contract,
  dialog copy and headless hook. The November 7 integration replaces the result with a shared
  `{ path, warnings } | null` receipt for all four formats. Initial coverage was 10 boundary tests in
  `apps/desktop/tests/export.test.ts` (cancel, in-library alias refusal, decline/accept consent,
  post-consent change and post-consent creation refusal, injected failure preserving prior bytes,
  default atomic staging with no temp debris, name suggestion, root-prefix check).

## Phase 2 — Resolve public decisions before dependent work

- [x] **T006** Research D-108 using public documentation and synthetic test documents; record the
  alternatives, determinism requirements, unresolved publisher-conformance limits, and per-target
  illustration placement/sidecar packaging contract in the public decision record. Do not select a
  DOCX/PDF/EPUB renderer until the decision is accepted. This task blocks renderer selection,
  per-target illustration placement/packaging and conformance work only.
  Research recorded 2026-11-03 (not accepted): `research/export-renderers.md` compares the
  `docx` pipeline (verified deterministic content, fixed entry dates, wall-clock core
  timestamps) against a documentation survey of LibreOffice headless, `pdf-lib`, Typst and EPUB
  assemblers; D-108 proposes the determinism requirements and per-target packaging contract with
  KDP acceptance, pagination/trim, font embedding and validator tooling explicitly unresolved.
  Accepted 2026-11-03 as D-108: DOCX stays on `docx` 9.x, PDF prints the manuscript's own HTML
  through Electron's `webContents.printToPDF`, and EPUB 3 is assembled with `fflate`; determinism is
  content determinism, and no KDP, EPUBCheck, PDF/UA or pagination claim is made.
- [x] **T007** Decide and record the additive ordered-matter schema and explicit legacy-conversion
  behavior. Define how populated `frontMatter` records are classified, ordered, preserved, reviewed
  and rolled back. Until accepted, do not migrate or reinterpret existing records. This task blocks
  persisted matter schema, conversion UI and matter export only.
  Research recorded 2026-11-03 in `research/matter-schema.md`. Accepted 2026-11-04 as D-169, on the
  author's delegation, with a different shape from the research proposal: a separate optional
  `matter` value (save-counter `version`, generated `titlePage`, `author`, `subtitle`, and ordered
  `sections` with a kind, a front or back position, a heading and Markdown text). Absent or empty
  matter exports exactly as before. The `frontMatter` record is never read as matter, never changed,
  and keeps its strict parse; its entries are listed and converted only when the author asks. The
  `matterOrder` proposal was rejected.
- [x] **T008** Decide and record whether target-specific format profiles persist per book or per export
  and which physical-layout controls, if any, are modeled. Do not claim physical measurement. This task
  blocks only persistent target-specific settings and physical-size controls.
  Research recorded 2026-11-03 in `research/format-profiles.md`. Accepted 2026-11-04 as D-170, on the
  author's delegation: format settings persist per book (`settings.manuscript` and `matter` in
  `book.json`), the target stays a per-export choice, no target-specific profile persists
  (`formatProfiles` stays reserved at the top level) and no physical-layout control is modeled.

## Phase 3 — Matter schema and authoring

- [x] **T009** After T007 is accepted, add the approved additive versioned matter schema and
  backward-compatible parsing. Preserve `frontMatter`, unknown fields and old-book readability; add
  round-trip tests using synthetic book files. Update `docs/FORMAT.md` in the implementation change.
  `packages/core/src/matter.ts` (schema with id and size limits, tolerant `readMatter`, export plan,
  templates, conversion, hash); `bookSchema` carries `matter` as it is. `LibraryService.saveMatter`
  checks the version and hash, keeps a stale save as JSON in `conflicts/`, refuses to write over an
  unreadable value or a `book.json` replaced mid-save, and `updateBook` ignores a `matter` patch.
  The `books:saveMatter` channel validates ids and sizes with Zod. Covered by
  `packages/core/tests/matter.test.ts` (22) and `apps/desktop/tests/ipc-handlers.test.ts`.
- [x] **T010** After T007, implement author-reviewed legacy conversion exactly as decided. Show the
  proposed placements before saving, require confirmation, preserve the original record as specified,
  and make cancel or failure leave the book unchanged. Test empty, populated, malformed and repeated
  conversion cases with synthetic records.
  The Format dialog lists every non-empty `frontMatter` entry no export includes, each with where it
  would go, and adds the placeable ones only on **Add to front and back matter**; the record is never
  changed. Covered by `packages/core/tests/matter.test.ts` (empty, populated, whitespace-only and
  unknown keys, two keys of one kind, author already set, converting twice) and
  `apps/desktop/tests/format-matter.test.tsx`. The strict parse of a malformed record is unchanged
  (D-169 defers tolerant carry).
- [x] **T011** Implement add/edit/reorder/remove for front and back sections, including editable
  templates and keyboard-only reordering. Test persistence, confirmation and cancel behavior with
  synthetic fixtures. Do not change chapter files or image records.
  The Format dialog's **Front and back matter** section: title page toggle, author and subtitle,
  sections added by kind with starting text (copyright and disclaimer templates), headings and text
  edited in place, **Move up**/**Move down** buttons that cross the chapters at a side's end and keep
  focus, and removal that asks first. Changes save shortly after the author stops, when the dialog
  closes and before an export; a book opened in place gets its own dialog, and a change still waiting
  saves to the book it was made in. Covered by `apps/desktop/tests/format-matter.test.tsx` (17, with
  axe's structural rules over the section).
- [x] **T012** Connect the approved ordered matter to the approximate preview and its accessible
  structure. Verify front matter, chapters and back matter appear in the selected order without
  claiming measured pages.
  The approximate preview shows the title page, front sections, contents, chapters and back
  sections in export order, from the matter being edited. Covered by
  `apps/desktop/tests/format-matter.test.tsx`.

## Phase 4 — Format outputs and publication

- [x] **T013** Extend the existing DOCX export from the saved snapshot to include only matter that has
  passed the approved conversion/schema flow. Preserve the existing typography source and use the
  renderer decision from T006 before making output-conformance claims. Verify legacy values are never
  silently mapped or omitted.
  Every target exports the matter in order: Word puts each section on its own page and the generated
  title page in its own vertically centred section; the PDF prints the same order; the EPUB gives
  each section its own XHTML document with `epub:type` (`titlepage`, `copyright-page`, `dedication`,
  `epigraph`, `acknowledgments`, or the partition), listed in the spine and navigation in order;
  Markdown lists each under its heading. A book without matter exports exactly as before:
  `apps/desktop/tests/no-matter-identity.test.ts` compares every Word part, the EPUB bytes, the
  Markdown text and the printed HTML with goldens rendered by the exporters at 3a234cc.
  `apps/desktop/tests/export-matter.test.ts` covers the matter in each format, empty matter and
  unreadable matter. Legacy values are never exported and the dialog lists them until converted.
- [ ] **T014** Implement Markdown folder export from the frozen saved-source bundle under the D-202
  contract recorded in [DECISIONS.md](../../docs/DECISIONS.md#d-202--markdown-folder-export-pure-planner-contract-and-saved-source-bundle),
  [FORMAT.md](../../docs/FORMAT.md#markdown-folder-export) and
  [the folder format](../../docs/formats/markdown-folder.md). Write ordinary ordered Markdown files
  and copy verified attached image files to the export destination without changing the 019 source
  files. Test with synthetic text and image fixtures. The subordinate gates below own acceptance;
  this task stays unchecked until they and T016/T017/T019 close. Capture, publication and the mounted
  journey are implemented on the desktop local-folder target. The task stays unchecked until T016,
  T017 and T019 close; replacing an existing folder and other destination classes remain successor
  work.
  - [x] **T014-C** Independent review of the recorded D-202 packet against its exact head. Owner:
    independent reviewer. Evidence: scoped review accepting or revising the decision, format, spec,
    plan and changelog wording at that head. This gate closes no implementation task. Closed:
    independently accepted at `914794f`; merged in PR #49.
  - [x] **T014-P** Pure planner under one owner. Owner: planner implementer. Evidence: focused tests
    asserting complete inventories and exact bytes, the escape notation and its inverse, blank-title
    annotations, parsed-body fidelity, legacy exclusion including the
    `key.toLowerCase().replace(/[^a-z]/g, "")` author/subtitle classification with title-page-off and
    whitespace controls and the paired D1 fixtures (Kelvin-sign `Kauthor` with initial U+212A
    excluded, ordinary `authorname` represented, and `authorname` with title page off excluded),
    per-dimension exact-boundary and plus-one refusals, a complete once-per-file retrieval under all
    budgets, and caller/output mutation isolation. No Library, host or interface change is part of
    this gate. Closed: independently accepted at `fe2d7a3`; merged in PR #51.
  - [x] **T014-Q0** Host protocol and production policy contract. Owner: shared host integration
    owner. Evidence: specified enumeration and observation rules, trusted construction handoff,
    measured acquisition and memory peaks, production limit values and per-target capability matrix,
    including change-and-change-back cases that the bundle wording discloses rather than denies.
    Specified by D-203 in [the host contract](../../docs/formats/markdown-folder-host.md)
    (enumeration and closing-sample observation, §3 verification handoff, `Q0 production policy v1`
    with synthetic planner measurements, and a no-claim capability matrix). This records the
    contract only; the box stays unchecked pending independent review, and implemented acquisition
    counts and host peaks remain T014-Q evidence. Closed: independently accepted at `81b474e`;
    merged in PR #52.
  - [x] **T014-Q** Capture, image verification and publication. Owner: shared host integration owner.
    Evidence: selected records bound to verified private bytes, genuine no-replace publication with
    protected identities and owned staging/cleanup, existing-folder replacement kept as named
    successor work, and injected staging, write, close and permission failures preserving prior
    output and source bytes. Closed: independently accepted at `e91ac11`; merged in PR #53.
  - [x] **T014-U** Mounted journey. Owner: interface integrator after P and Q interfaces agree.
    Evidence: validated transport, bundle-bound **Continue without them** / **Cancel**, accessible
    warnings and written-file lists, destination-picker cancel, accepted pre-commit cancellation
    that actually prevents publication, and truthful late or unknown settlement, each exercised in
    synthetic end-to-end journeys without exposing the folder target before this gate passes. Closed:
    independently accepted at `255fc77`; merged in PR #54. The follow-up commit-window recheck and the
    published-with-cleanup settlement are recorded under T016; they do not reopen this gate or change
    its accepted head.
- [ ] **T015** After T006, implement the selected PDF and EPUB renderer adapters. Validate structural
  output with synthetic books containing ordered matter, verse-like lines and attached synthetic
  images. Keep preview copy approximate and make no eligibility, pagination, measurement or publisher
  readiness claims not supported by the accepted decision.
  Partly done under D-108: `buildManuscriptHtml` (`apps/desktop/src/main/manuscript-html.ts`) feeds
  `renderPdfInHiddenWindow` (`apps/desktop/src/main/pdf.ts`), and `buildEpub`
  (`apps/desktop/src/main/epub.ts`) assembles the container. `manuscript-html.test.ts` and
  `epub.test.ts` validate the structure with synthetic books holding verse-like lines, stanza gaps
  and attached images: settings, escaping, reading order, page breaks, illustrations in the Word
  export's order, stored `mimetype`, OPF, navigation, well-formed XHTML and byte-identical EPUBs.
  `export-matter.test.ts` validates ordered matter in the PDF HTML and the EPUB (T013).
- [ ] **T016** Apply one safe-publication contract to every implemented target: snapshot after successful
  flush, source immutability, destination validation and recheck, replacement consent, cancellation,
  staged publication, cleanup reporting and prior-output preservation. Exercise each failure boundary
  against isolated temporary destinations.
  Partly done under D-108: PDF and EPUB publish through the Word export's boundary
  (`exportManuscriptPdf`, `exportManuscriptEpub`), and `export-pdf-epub.test.ts` exercises cancel,
  a destination inside the library, replace consent, a file changed or created after consent,
  render and write failures and prior-output preservation in temporary folders. The Format dialog
  exports only after the open chapter's save confirms. The header also blocks a failed
  or conflicted flush (`WorkspaceView.exportBook`, with an IO-failure regression in
  `docx-export-flush.test.tsx`); the earlier missing-header-guard note was stale. W05 adds canonical
  destination-alias rejection, publication-time rechecks and cleanup diagnostics for all four
  formats, exercised in `export-safety.test.ts`. The shared underlying filesystem adapter's separate
  containment issue remains tracked with history. The single-file contract now has attempt-bound
  cancellation before publication, and the folder rechecks cancellation, consent currency and plan
  identity at commit-started. Replacement consent is met by the single-file targets; the Markdown
  folder is new-folder-only under D-202's retained successor gate, and no existing folder is deleted,
  merged or renamed. Post-publication staging cleanup is a published warning with the exact leftover
  path, not an unknown settlement. Independent integrated review and full verification are still
  required.
- [ ] **T017** Complete synthetic end-to-end journeys for DOCX, PDF, EPUB and Markdown as each renderer
  becomes available. Verify the author-visible destination/status, source hashes, matter order,
  optional-image warning, save conflict, cancel and failure behavior. Unsupported targets must remain
  clearly unavailable until their renderer task is complete.
  Partly done under D-108: the hidden smoke exports a PDF twice in one session and an EPUB from the
  Format dialog and reads them back (`%PDF-` with the illustration embedded, the stored `mimetype`
  entry, the chapter text in the XHTML), next to its Word and Markdown checks; `format-dialog-export.test.tsx` covers the saved-file note, cancel, refusal
  and a failed save. Matter order is covered by unit tests (T013). W05 and the November 7 integration
  deliver image-snapshot warnings through all four real IPC handlers to the Format and workspace
  receipt displays. `ipc-handlers.test.ts` covers receipts, cancellation, refusal and source bytes;
  the extended hidden smoke asserts the visible Markdown omission warning. The new built-app checks
  and independent review remain pending on the combined candidate. The Format dialog now exposes a
  single-file Cancel export control and a folder-name field for repeat exports; the folder save-conflict,
  refusal and preflight-order tests are added. No built-app journey has been run on this head.

## Phase 5 — Public format and acceptance record

- [ ] **T018** Update `docs/FORMAT.md`, the public decision record and any required ADRs for accepted
  schema and renderer decisions. Keep D-115 separate from export. Update the changelog in the
  implementation change, not in this spec-authoring task.
  D-202, the FORMAT folder section, the folder format and the changelog entry are recorded with this
  packet; the task stays unchecked until the implementation changes complete the remaining format
  and decision updates and T019 reviews them. This slice updates FORMAT.md, the host capability matrix
  and the spec, plan and task status. T018 stays unchecked until T019 reviews the corrected public
  record.
- [ ] **T019** Review the final author-visible journey against spec 002 and spec 019: DOCX/PDF/EPUB/
  Markdown scope, ordered matter, canonical typography, approximate-preview disclosure, saved-source
  safety and image-store ownership. Record remaining gaps without claiming publisher readiness.
  The public status now agrees that the desktop local-folder target is implemented and exposed.
  Replacement, other destination classes, the DOCX contents page, FR-020's full completion notice and
  FR-054 remain open. No publisher, measurement or device readiness is claimed.
