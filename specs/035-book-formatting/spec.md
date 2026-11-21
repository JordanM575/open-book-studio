# Book formatting and export

**Status:** In progress — Phase 1 (T001–T005: Format journey design, approximate-preview surface, UI contract tests, the DOCX journey and its publication boundary) is implemented; D-108 is accepted, and the Format dialog exports DOCX, PDF, EPUB and Markdown (T015–T017 in part). D-169 and D-170 are accepted (2026-11-04): ordered front and back matter (T007–T013) is edited in the Format dialog, previewed in order and exported by all four targets, and format settings persist per book. The Markdown folder export contract is recorded by D-202 (2026-11-09); its pure planner is implemented and accepted, its host protocol and production policy are specified by D-203 (T014-Q0), and capture, publication and the mounted journey are implemented on the desktop local-folder target. T014 stays open pending T016, T017 and T019; replacing an existing folder and other destination classes remain open.
**Number:** 035
**Depends on:** [002 — AI Book Studio v1](../002-studio-v1/spec.md), [019 — Illustrations](../019-illustrations/spec.md), and the public file-format contract in [`docs/FORMAT.md`](../../docs/FORMAT.md).

## Why

An author needs to shape a saved book for different reading and publishing formats without turning the
export into a second manuscript. The author should be able to edit a book-format model, inspect an
honestly labelled preview, arrange front and back matter, and export a copy while the Markdown source
and image files remain theirs and unchanged.

Spec 002 calls for DOCX, PDF, EPUB and Markdown exports, editable ordered front and back matter, and
formatting settings. The public runtime provides DOCX, Markdown, PDF and EPUB export and a canonical
set of typography settings. This spec defines the separate formatting journey; it does not claim
that print measurements or publisher-ready output exist today.

## Present public behavior

- The workspace flushes the open editor before requesting DOCX export. The main process reads the
  saved book through `Library`, builds a DOCX, and writes the chosen destination atomically.
- The DOCX builder uses `settings.manuscript` for body font, font size, first-line indent, line
  spacing, and chapter-title alignment. It includes a title/description page and separates chapters.
  The current output is not an in-app visual preview.
- The book schema already has `settings.manuscript`, which also contains table-of-contents and
  line-break options. This spec does not claim that every existing option is currently represented in
  the DOCX output.
- `book.frontMatter` is a legacy free-form record keyed by string IDs. It is not an ordered
  sequence and no export reads it. Ordered matter lives in the separate `book.matter` value (D-169);
  the Format dialog lists the record's entries that no export includes and converts them into
  `matter` only when the author asks.
- Spec 019 owns the `images.json` manifest, image files and chapter attachments. The current DOCX
  path can read attached illustrations. This spec consumes those existing attachments for output; it
  does not add image management or generation.
- Markdown, PDF and EPUB manuscript export are available (D-108). The Format dialog exports any of
  the four targets after saving the open chapter; the workspace header keeps its Word and Markdown
  buttons. PDF prints the manuscript's own HTML through Electron's Chromium in a hidden window with
  the canonical typography, a title page, an optional contents page and a page break before each
  chapter. EPUB 3 is one XHTML file per chapter with an OPF manifest, a navigation document and
  `images/` sidecars. Both embed the illustrations the DOCX export embeds, in the same order, and
  publish through the same boundary as DOCX. The single-file Markdown export remains one file. The
  separate Markdown folder target in the Format dialog writes the folder FR-021 describes; it is
  new-folder-only and does not replace an existing folder.

## User stories

### 1. Set a format and inspect an honest preview

As an author, I choose an output format, adjust the supported book typography in one place, and see a
local preview before exporting. The preview tells me that it is approximate and does not imply exact
page breaks, a measured trim size, or compatibility with a publisher.

### 2. Arrange front and back matter

As an author, I add, edit and reorder front-matter and back-matter sections independently. I can start
from editable templates, and the order I see is the order requested for export. Existing book data is
not silently converted or discarded.

### 3. Export a saved version safely

As an author, I choose DOCX, PDF, EPUB or a folder of Markdown and a destination. The export is made
from saved files collected into one frozen bundle, leaves the library source untouched, and tells me
what was written. If saving, rendering, writing or publishing fails—or I cancel—the studio explains
what happened and does not replace a previous export with a partial one.

## Requirements

### Format model and editor

- **FR-001** The format model MUST distinguish the requested output target (`DOCX`, `PDF`, `EPUB`, or
  `Markdown`) from the saved book source. It MUST be a read-only projection for rendering, not a second
  editable copy of chapter prose.
- **FR-002** The editor MUST read and write the existing `settings.manuscript` typography fields as
  their single canonical source. It MUST NOT create duplicate font, font-size, indent, line-spacing or
  chapter-title-alignment settings in a separate format profile.
- **FR-003** The editor MUST show which target is selected and which options are supported for it.
  A target without an implemented renderer MUST be labelled unavailable or planned; it MUST NOT
  appear to export successfully.
- **FR-004** The local preview MUST remain visibly labelled **Approximate preview** while displayed
  and state that final output can differ in the target reader or word processor. It MUST NOT present
  measured pagination, guaranteed page breaks, exact page counts, trim measurements or printer
  compatibility as facts.
- **FR-005** The preview MUST update when the author changes a supported typography setting or matter
  order. It MUST be local-only; previewing MUST NOT call a provider or modify the source book.
- **FR-006** Formatting controls MUST be keyboard operable, use the existing design tokens and provide
  visible focus and sentence-case labels. Preview disclosure MUST not depend on hover or color alone.

### Ordered matter and compatibility

- **FR-007** The proposed book format MUST add a versioned ordered-matter value to `book.json`, separate
  from the existing `frontMatter` record. The additive value MUST represent ordered front sections and
  ordered back sections, with stable section IDs, editable titles and content, and a section kind for
  built-in templates. The export sequence MUST be front sections, chapters in chapter order, then back
  sections. The exact field name and migration contract remain subject to the open decision below.
- **FR-008** The author MUST be able to add, edit, reorder and remove sections in each side. Removing a
  section MUST require confirmation before its saved content is removed. Reordering MUST be available
  without a pointer.
- **FR-009** Built-in disclaimer and other matter templates MUST be editable starting text. Selecting a
  template MUST create author-owned section content; later template changes MUST NOT overwrite it.
  Template copy MUST not claim legal advice or guarantee publisher acceptance.
- **FR-010** The studio MUST preserve the current `frontMatter` record as-is until a public legacy
  conversion decision is accepted. It MUST NOT enumerate that record as if it were an ordered list,
  infer front/back placement, or silently migrate or delete it.
- **FR-011** A Markdown folder export MUST preflight the legacy `frontMatter` record by content, as a
  strengthening after D-169's accepted conversion rather than the former pre-conversion notice. A
  non-empty value counts as represented only when its raw string exactly equals the text of an
  included saved matter section, or when its key identifies the author or subtitle under
  `key.toLowerCase().replace(/[^a-z]/g, "")` (lowercase first, then remove characters outside ASCII
  `a`–`z`; `author` and `authorname` identify the author), the title page is enabled, and the
  corresponding projected value is non-empty, actually emitted and equal to `raw.trim()`. Every other
  non-empty value MUST be listed by safely identified key for an explicit **Continue without them**
  or **Cancel** choice bound to the frozen bundle; an unrendered field alone MUST NOT count as
  inclusion. The stored record and every draft MUST remain unchanged either way, and nothing is
  converted automatically.
- **FR-012** Existing books without the additive matter value MUST continue to open. Adding ordered
  matter MUST be backward-compatible and MUST preserve unknown book fields.

### Saved-source export

- **FR-013** Before export, the workspace MUST flush pending editor input. If the save fails, conflicts
  with another writer, or is cancelled, export MUST not start; the author MUST see the save outcome and
  retain the draft for recovery or conflict review.
- **FR-014** After the flush succeeds, the main process MUST collect saved library data into one
  immutable export bundle and freeze it before rendering. Collection may observe different files at
  different times, so the bundle is a frozen observed set, never a claim that the whole book was read
  at one instant. A render MUST use only the frozen bundle rather than rereading or mutating
  manuscript files partway through the export, and known missing required content or inconsistent
  identities MUST stop the export.
- **FR-015** Export MUST leave `book.json`, chapter Markdown, the image manifest and stored image bytes
  unchanged. The main process MUST be the only writer to any export destination; the renderer MUST NOT
  supply an unchecked filesystem path.
- **FR-016** The destination MUST NOT alias a source file or replace the active book's managed source
  directory. If a chosen target resolves to a source path, the export MUST stop before writing and tell
  the author to choose another destination.
- **FR-017** A destination that already exists MUST be replaced only after the author confirms. The
  exporter MUST detect if that destination changes before publication and preserve the newer bytes
  rather than overwriting them silently.
- **FR-018** Single-file exports MUST be staged before publication. A Markdown folder export MUST be
  assembled in a sibling staging directory before publication. On render, write, rename or publish
  failure, the previous destination MUST remain intact and temporary output MUST be cleaned up where
  possible; any cleanup failure MUST identify the remaining temporary path.
- **FR-019** Cancelling the destination picker MUST leave the source and any prior export unchanged.
  Cancelling an active export MUST stop before publication, clean up staging output, and return the UI
  to an available state. A completed publication MUST be reported as complete, not as cancelled.
- **FR-020** Only on confirmed publication, the studio MUST identify the destination, target format
  and every written file, describing the result as the saved-source bundle collected for this export.
  The notice MUST explain that concurrent changes during collection can mix observations and that
  edits after the bundle froze are not included. If the source changes after the freeze, the export
  MUST still represent the frozen bundle. If publication cannot be confirmed, the studio MUST report
  that uncertainty instead of success.
- **FR-021** Markdown export MUST produce an ordinary folder of readable Markdown files in book order,
  including ordered matter once supported. It MUST not mutate or replace the source chapter files.
- **FR-022** Export MUST work offline and MUST NOT send manuscript content or images to a studio
  service, telemetry endpoint or model provider.

### Illustration boundary

- **FR-023** Export MUST resolve images only through the existing spec 019 image store and attachment
  records. It MUST NOT add a second image manifest or embed image bytes in `book.json`.
- **FR-024** Export MUST copy or embed attached image data into the chosen output as required by the
  output target; it MUST never move, rename, re-encode or delete the source image. A missing or
  unreadable optional image MUST produce an author-visible warning while preserving the text export.
- **FR-025** This spec MUST NOT change image generation, attachment, replacement, deletion, provenance
  or gallery behavior. The format journey owns only how an already attached image is consumed by a
  renderer.

Spec 002 also states that illustrations should follow book order, have their own page in paged exports,
and be accompanied by separate image files. Those are output-packaging requirements, not changes to
spec 019's storage or attachment behavior. Their per-target implementation and acceptance remain
unresolved with D-108; this spec makes no claim about actual pagination.

## Acceptance scenarios

1. **Given** a book with existing typography settings, **when** the author opens Format, **then** each
   typography value comes from `settings.manuscript`, and editing it does not create a second copy.
2. **Given** any preview, **when** it is shown, **then** it says **Approximate preview** and explains
   that final output may differ; no page count, measured trim size or publisher-readiness badge appears.
3. **Given** front and back matter sections, **when** the author reorders them and reopens the book,
   **then** each side retains the chosen order and the preview reflects it.
4. **Given** a book with a non-empty legacy `frontMatter` record, **when** the author exports before
   conversion support exists, **then** the preflight names the excluded legacy values and offers
   **Continue without them** or **Cancel**; the record remains byte-for-byte unchanged.
5. **Given** an unsaved editor draft, **when** the author starts export, **then** the workspace flushes
   first; a save failure or conflict prevents export and leaves the draft available.
6. **Given** a synthetic book in an isolated temporary library, **when** export succeeds, **then** the
   output reflects the frozen saved-source bundle and source hashes are unchanged.
7. **Given** a previous export at the chosen destination, **when** rendering or publication fails or is
   cancelled, **then** the previous bytes remain intact and the author sees a useful next step.
8. **Given** an output path that aliases a book source path, **when** export begins, **then** no source
   or output file is replaced and the author is asked to choose another destination.
9. **Given** an attached image that is missing or unreadable, **when** an export runs, **then** the
   author sees which optional image was skipped and the manuscript text remains exportable.
10. **Given** a destination the author cancels in the picker, **when** the picker closes, **then** no
    file is written and the workspace is usable again.

## Success criteria

- **SC-001** In synthetic isolated-library tests, every supported export preserves the source book and
  chapter hashes, and every injected failure/cancel before publication leaves an existing destination
  unchanged.
- **SC-002** In synthetic fixtures, front and back matter order survives save, reload and export with
  no silent conversion from the legacy record.
- **SC-003** In UI checks, every preview state displays the approximate-preview disclosure, and every
  format control is reachable and operable by keyboard alone.
- **SC-004** An export error or cancellation returns the workspace to an actionable state and never
  reports success for an output that was not published.

## Open decisions and limits

- **D-108 — export libraries and determinism is Accepted (2026-11-03)**
  (`research/export-renderers.md`). DOCX stays on `docx` 9.x, PDF uses Electron's built-in
  `webContents.printToPDF`, and EPUB 3 is assembled with `fflate` with fixed entry dates and no
  remote resources. Determinism is content determinism: the same book gives the same PDF HTML and a
  byte-identical EPUB, but PDF bytes vary with Chromium's creation date. Spec 002's own-page image
  requirement (FR-054) is not met: illustrations follow their chapter's text, as in DOCX. Do not
  claim KDP/KDP Print or Kindle Unlimited eligibility, EPUBCheck validity, PDF/UA, print
  measurement, exact pagination, or publisher readiness.
- **Ordered matter and legacy conversion — D-169 Accepted (2026-11-04, on the author's
  delegation).** A separate optional `matter` value in `book.json` holds the generated title page
  (title, subtitle, author), and ordered sections each with a kind, a front or back position, a
  heading and Markdown text. Absent or empty matter exports exactly as before. Conversion of the
  legacy `frontMatter` record is explicit and reviewed in the Format dialog; the record is never
  changed. The `matterOrder` proposal in `research/matter-schema.md` was rejected.
- **Format profiles and physical-layout options — D-170 Accepted (2026-11-04, on the author's
  delegation).** Typography and matter persist per book in `book.json`; the export target stays a
  per-export choice; no target-specific profile persists (`formatProfiles` stays reserved at the
  top level) and no physical-layout control is modeled.
- **Markdown folder contract — D-202 Accepted for recording (2026-11-09).** A pure planner contract,
  the frozen saved-source bundle above, the content-bound legacy preflight in FR-011 and the retained
  capture, publication, replacement, cancellation and target gates are recorded in
  [DECISIONS.md](../../docs/DECISIONS.md#d-202--markdown-folder-export-pure-planner-contract-and-saved-source-bundle)
  and [the folder format](../../docs/formats/markdown-folder.md). The pure planner is implemented and
  accepted; recording the output contract itself implemented and qualified nothing. Capture,
  publication and the mounted journey are implemented on the desktop local-folder target; replacing an
  existing folder, other destination classes and independent integrated review remain open, so T014,
  T016, T017 and T019 stay unchecked.
- **Markdown folder host protocol — D-203 Accepted for recording (2026-11-09, T014-Q0).** Enumeration
  and observation for building the frozen bundle from a real library, the trusted-construction
  handoff, `Q0 production policy v1` and the per-target capability matrix (the desktop local-folder
  target claims the implemented journey; no other target claims it) are specified in
  [the host contract](../../docs/formats/markdown-folder-host.md). Capture and publication are
  implemented on the desktop local-folder target; replacement, other targets and independent
  integrated review remain open. T014, T016, T017 and T019 stay unchecked; T014-Q0 remains closed at
  `81b474e`.
- **D-115 is about release signing and updates, not export.** It neither approves a renderer nor gates
  this export feature.

## Non-goals

- Editing manuscript prose or chapter order from the Format journey.
- Image generation, image editing, attachment management or a second image-storage system.
- Selecting an export engine or making an output determinism, print-measurement, pagination,
  KDP/KDP Print, Kindle Unlimited or publisher-acceptance claim before the applicable public decision.
- A guarantee that an export looks identical across Word processors, PDF readers, e-readers or printers.
- Library archive export/import, release signing, notarisation or application updates.
