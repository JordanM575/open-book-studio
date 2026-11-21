# Plan: book formatting and export

**Spec:** [spec.md](spec.md) · **Tasks:** [tasks.md](tasks.md)
**Status:** In progress. Phase 1, the D-108 renderers and ordered matter (T007–T013, D-169 and D-170 accepted 2026-11-04) are implemented; the Markdown folder contract is recorded by D-202 (2026-11-09), its pure planner is implemented and accepted, its host protocol and production policy are specified by D-203 (T014-Q0), and capture, publication and the journey are implemented on the desktop local-folder target; T014 remains open pending T016/T017/T019, and replacement, other targets and the rest of Phase 4 remain open.

## Constraints

- Preserve the public local-first architecture: the main process reads and writes files through
  `Library`; the renderer uses the validated preload/IPC surface and never receives filesystem access.
- Treat saved Markdown and book files as canonical. Rendering is a read-only projection of a saved
  snapshot; output is a separate copy.
- Reuse `book.settings.manuscript` for canonical typography. Do not add a parallel set of typography
  values to an export profile.
- Keep the existing `book.frontMatter` record intact and semantically unchanged. Ordered matter is
  the additive D-169 `matter` value; conversion stays explicit, and the folder export adds only the
  content-bound FR-011 preflight.
- Reuse spec 019's image store and attachment records. This feature reads attached images for output;
  it does not modify their lifecycle.
- Use only synthetic, isolated library fixtures for tests in this feature. Live manuscripts,
  credentials, providers and paid services are not test inputs.

## Proposed architecture

### 1. Read-only export model

Introduce a pure export projection after a save succeeds. Its inputs are the saved `BookDetail`,
`settings.manuscript`, the proposed ordered-matter value when available, and attachment references
resolved through the image store. Its output is a stable in-memory snapshot containing the selected
target, book metadata, ordered matter, chapter IDs/titles/order/Markdown, canonical typography, and
attached image bytes or explicit missing-image warnings. It contains no mutable filesystem paths from
the renderer and no second copy of typography state.

The bundle is collected once and frozen before rendering. Collection may observe different files at
different times, so it is never described as the book at one instant. Every renderer uses that same
frozen bundle even if a later save occurs. The success message identifies the destination, format and
written files as that collected bundle and explains the collection interval and post-freeze isolation;
an unconfirmed publication is reported as uncertain, never as success.

### 2. Additive matter schema — accepted as D-169

Accepted as D-169 (2026-11-04): the value is named `matter`, with a generated title page and one
ordered list of sections, each placed `front` or `back`; see `docs/FORMAT.md`. The earlier
`orderedMatter` working proposal was not selected and is not an accepted schema.

The legacy record must never be cast to an array or automatically assigned a side or order. Existing
books continue to open with no new value. Conversion is explicit under D-169. Independently, the
Markdown folder export applies FR-011's content-bound preflight: only an exact included-section-body
match or the narrow actually emitted title-page match counts as represented, and every other
non-empty value needs an explicit continue or cancel for that frozen bundle.

### 3. Format editor and approximate preview

Add a Format journey in the shared app shell. The editor presents target selection and the currently
supported canonical typography controls. Target-specific physical-layout settings remain absent until
the format-profile decision is accepted. The preview is rendered locally from the projection, stays
visibly labelled **Approximate preview**, and states that final appearance can differ. It must not
simulate or report measured pages, print trim or publisher eligibility.

Use the existing design tokens and keyboard patterns. Keep the preview separate from the manuscript
editor and the spec 019 illustration management UI.

### 4. Export boundary and safe publication

The workspace flushes pending editor input before it requests an export. A failed or conflicted save
stops the operation and preserves the draft. Main-process code then reads the saved book and attached
image records through `Library`, captures the export snapshot and renders from it.

The main process obtains the destination through a native picker or a separately validated destination
contract. It rejects source-path aliases before creating output. Existing output requires explicit
replacement consent and a pre-publication recheck. Single-file output is staged and atomically
published. Markdown folder output is assembled in a sibling staging directory before a safe directory
publication. Cancellation and failures remove staging output when possible and preserve any previous
destination. Cleanup failures identify the remaining temporary path.

The workspace reports the chosen destination and selected format only after publication succeeds.
Cancel, failure, missing optional images and an unconverted legacy matter record have distinct,
author-readable states.

### 5. Renderer strategy

D-108 was accepted on 2026-11-03, so renderer selection is settled and no new DOCX/PDF/EPUB library is
chosen here. The existing single-file Markdown export keeps its behavior. The Markdown folder is a
separate target with its own recorded packaging contract (D-202); until its planner and host work
land, it stays visibly unavailable rather than represented as complete.

The D-108 renderers now exist: `manuscript-html.ts` and `pdf.ts`
(Chromium print-to-PDF in a hidden window) and `epub.ts` (`fflate`), all in `apps/desktop/src/main`,
behind `exportManuscriptPdf` and `exportManuscriptEpub` in `export.ts`. They read the same saved
`BookDetail` and the same collected illustrations as DOCX; no export-model package was added.

## Likely files in a future implementation

These paths are planning references, not files changed by this authoring task.

```text
packages/core/src/schema.ts                   additive ordered-matter schema after decision
packages/core/src/export/model.ts              target and read-only snapshot types
packages/core/src/export/index.ts               pure export projection and validation
packages/core/tests/export/                     synthetic model and format-contract tests
packages/app/src/views/FormatView.tsx            editor and target selection
packages/app/src/components/FormatPreview.tsx    labelled approximate local preview
packages/app/src/views/WorkspaceView.tsx         flush, navigation and export status
apps/desktop/src/main/export.ts                  renderer seam and staged publication
apps/desktop/src/main/ipc.ts                     validated export requests and destination flow
apps/desktop/src/preload/index.ts                narrow export methods
apps/desktop/tests/export/                       isolated library and failure-path tests
docs/FORMAT.md                                  public file-format change after schema acceptance
docs/DECISIONS.md and docs/adr/                 public decision record when accepted
```

Exact module names may follow the repository structure when implementation begins. No schema,
renderer library or destination behavior is considered accepted by this file alone.

## Markdown folder delivery order (D-202)

Recording (this packet) comes first; implementation then splits into two independent branches that
join only at the mounted journey:

```text
C: recorded public contract (D-202, FORMAT, folder format, this spec)
   ├─ P: one pure planner owner — deterministic plan, notation, budgets, legacy analysis
   └─ Q0: host protocol contract — capture, verification, production policy, target capability
        └─ Q: capture and publication implementation with qualified targets
P + Q ──> U: validated mounted journey ──> I: integrated evidence and fresh exact-head review
```

- **P** owns only the pure planner and its focused expected-byte and inventory tests. It has no
  Library, writer, host or interface authority, and package-export wiring is coordinated rather than
  separately owned.
- **Q0** must separately establish the actual enumeration and observation protocol, the trusted
  construction handoff, measured production limits and host memory peaks, and per-target publication
  capability before **Q** implementation. Specified by D-203 in
  [the host contract](../../docs/formats/markdown-folder-host.md): enumeration and closing-sample
  observation with the change-and-change-back disclosure, the §3 verification handoff,
  `Q0 production policy v1` with synthetic planner measurements, and a capability matrix claiming the
  implemented desktop local-folder journey and no other target. Implemented acquisition counts and real
  host peaks remain **Q** evidence. One shared host integration owner coordinates the Library,
  image-store and editor seams; there are no competing writers. Existing-folder replacement and
  later-change preservation remain named successor work inside this branch.
- **U/I** begin only after the P and Q interfaces are agreed: validated transport, content-bound
  consent, destination choice, accessible warnings and file lists, real pre-commit cancellation and
  truthful late or unknown settlement, followed by integrated positive and failure evidence on each
  qualified target. Pure-planner success alone never exposes the journey, and no branch's evidence
  substitutes for another's.

## Decision gates

| Decision | Needed before | Does not block |
| --- | --- | --- |
| D-108: renderer choices, deterministic-output scope and per-target illustration packaging | Selecting or adding DOCX/PDF/EPUB renderers; illustration placement/sidecar packaging; any output-conformance claim | Editor design, approximate preview, synthetic UI tests, image reads through spec 019, and characterization/safety work for the existing DOCX path |
| Ordered-matter schema and legacy conversion (D-169, accepted 2026-11-04) | Persisted schema, conversion UI, ordered-matter export | Editor shell, preview disclosure, canonical typography controls, current DOCX safety work |
| Format-profile persistence and physical-layout options (D-170, accepted 2026-11-04) | Persisting target-specific settings or exposing physical-size controls | Existing typography controls and format-target selection |

Each decision is a scoped gate. An unresolved decision does not stop unrelated editor or safety work.
D-115 is limited to release signing and updates and is not an export dependency.

## Verification approach

- Pure tests use synthetic saved books and image attachments in isolated temporary libraries.
- UI tests cover target availability, canonical typography binding, persistent approximate-preview copy,
  keyboard reordering, save/cancel/error states and no false success.
- Export boundary tests assert source hashes and bytes remain unchanged; source-path alias rejection;
  destination replacement consent and recheck; and previous-output preservation on injected render,
  write, rename, cancellation and cleanup failures.
- DOCX tests first characterize only current public behavior and the safe saved-source contract. They
  do not assert publisher acceptance or exact pagination.
- PDF and EPUB tests and renderer selection wait for D-108. Matter tests wait for the schema and legacy
  conversion decision. All test books and image bytes are synthetic; no live provider or real manuscript
  is used.
- After implementation, update `docs/FORMAT.md` with any accepted on-disk schema and the applicable
  public decision/ADR. This authoring task does not edit those files.

## November 7 W05 safety slice

The bounded existing-format implementation and its preimplementation rationale are recorded in
[the current safety note](research/export-safety-2026-11-07.md). It strengthens canonical-path
validation, near-publication destination checks, snapshot ownership, cleanup diagnostics and
chapter/format/matter save gating without altering D-108/D-169/D-170 or the shared atomic writer.
Structured warning delivery awaits the coordinator-owned IPC seam. T016/T017 remain partial until
that integration and the corresponding hidden journeys are verified; T014 packaging is separate.
