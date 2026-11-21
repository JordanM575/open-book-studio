# Markdown folder host protocol and production policy

**Status:** Specified contract by [D-203](../DECISIONS.md#d-203--markdown-folder-host-protocol-and-production-policy);
output contract in [the folder format](markdown-folder.md) under
[D-202](../DECISIONS.md#d-202--markdown-folder-export-pure-planner-contract-and-saved-source-bundle).
This document specifies how a host builds the frozen saved-source bundle from a real library, how it
hands that bundle to the accepted pure planner, which production limits it passes, and which target
capabilities exist today. It **implements nothing and captures nothing from a real library**: no
capture, publisher or journey exists yet, and no task closes. Implementation remains
[T014-Q](../../specs/035-book-formatting/tasks.md) and the mounted journey remains T014-U in
[spec 035](../../specs/035-book-formatting/spec.md).

The planner this protocol feeds is the pure module `packages/core/src/markdown-folder/`
(`createMarkdownFolderBundle`, `planMarkdownFolderExport`, `retrieveMarkdownFolderFile`), accepted at
`fe2d7a368bf0f7d34ac0964a62cd862625207e05`. The planner performs no I/O, capture, verification or
publication. Everything below that touches a library is host work that a later change must build and
qualify; every limit below is a value the host passes explicitly, because the planner has no implicit
production default.

## 1. Ownership and callers

- The shared host integration owner (spec 035 T014-Q) owns the one capture implementation. There are
  no competing writers or second library openers: capture reads only through the already-open
  `LibraryService` and its `LibraryPort`, and image bytes only through the spec 019 image store's
  data. The renderer, the `bookwriter` toolkit and agent tools never capture and never construct a
  bundle.
- Capture runs only in trusted host code: the desktop main process, or the browser host that owns the
  open library port. It starts only after every required editor, matter and settings save has
  succeeded and any host admission hold is clear (folder format §1). A failed or conflicted save
  means capture does not start.
- Capture never writes to the library. Source `book.json`, chapter files, `images.json` and stored
  image bytes are read, never changed, by this protocol.

## 2. Enumeration and observation

### 2.1 What is enumerated, in what order

One capture performs these steps in this order. Counts in parentheses are the component maxima of §4;
exceeding one refuses the capture whole, before bulk reads where the count is known from a listing.

1. **Book record.** Read `book.json` once through the port as a bounded snapshot (bytes and SHA-256).
   Book identity, title, description, canonical `settings.manuscript.includeTableOfContents`, the raw
   saved `matter` value and the legacy `frontMatter` record all come from this one snapshot's parsed
   value. No field is reread from a second observation of the file.
2. **Chapter membership.** List the chapters directory, and where the port offers inspected entries,
   require the complete-set check the library already defines: every candidate `.md` name must be a
   readable regular file, with no online-only placeholder or unsupported entry. On a port without
   `inspectDirectory`, completeness must still be proven from listing kinds plus the closing
   name-and-kind set — or the capture refuses — rather than the conditional acting as a waiver.
   Conflict copies are never candidates. If the candidate count exceeds the chapter maximum, refuse
   before reading bodies.
3. **Chapter files.** Read each candidate file once as a bounded snapshot, in ranked file-name order
   (the library's `compareChapterFileNames` ranking). Parse each with the library's chapter parser:
   the parsed metadata (`id`, `title`, `order`, `version`) and the parsed body (canonical body text,
   not raw file bytes) are the captured values, bound to that snapshot's SHA-256. A file with no
   front matter uses the library's existing file-name fallback metadata. The bundle's chapter order
   is the canonical Library order (saved `order`, ties by file name); captured order is never
   re-sorted by title, ID or locale.
4. **Image membership.** Read `images.json` once as a bounded snapshot (bytes, SHA-256, parsed
   manifest, store warning state) and list the `images/` directory names for the cross-check in §2.2.
5. **Selected images.** Selection is every distinct manifest record attached to a captured chapter
   through the existing attachment relation (the record's `chapterId` names a captured chapter), in
   captured per-chapter manifest order: chapters in canonical order, records in manifest array order
   within a chapter. Multiple records on one chapter are all selected, including distinct records
   with identical bytes. Unattached, cover and character images (no captured-chapter attachment) are
   outside the selection. Selected-record positions count every selected record for the chapter,
   including ones that become omissions. Read each selected record's image file once as a bounded
   snapshot from the record's own file name, in selection order, and verify it under §3.
6. **Closing observation.** Repeat the observations as a second sample: `book.json` hash, chapter
   candidate name-and-kind set plus each chapter file's hash, manifest hash and state, the
   `images/` directory name set, and each selected image file's hash, in the same order.
7. **Freeze.** Only after §2.2 admits the membership complete and §2.3 finds the two samples in
   agreement are the projected values computed (`readMatter`/`matterPlan` semantics over the captured
   raw matter), legacy pairs taken in parsed-record enumeration order, warnings ordered (list-level
   first, then omissions by chapter and selected position), and the bundle constructed under §3. The
   click and the start of collection are not the freeze point.

### 2.2 How membership is admitted complete

A capture is admitted complete only when all of the following hold. Any other outcome refuses the
whole capture with a bounded host reason; there is no partial bundle and no subset export.

- The chapter candidate set is fully readable: zero unreadable or missing candidates, zero duplicate
  chapter IDs (a second readable file carrying an admitted ID is a copy, and its presence refuses
  rather than being silently dropped), and every parsed chapter ID and image record ID satisfies the
  planner's ID shapes. Known missing required content, duplicate or ambiguous identities and an
  unsupported required schema stop the export, as the folder format §1 already requires.
- `book.json` parses under the current book schema at a supported schema version, and the captured
  raw `matter` value is readable (`readMatter` reports no issue). An unreadable required matter
  value refuses.
- The manifest state is exactly one of: **read** (parses at a supported schema version; selection
  proceeds), **known empty** (no manifest file and no files in `images/`; selection is empty with no
  warning), or **unreadable** (a manifest file is present but unparseable or misshapen, or image
  files exist with no readable manifest naming them; selection is empty with exactly one list-level
  warning, code `image-list-unreadable`, never the appearance of a valid empty manifest). A manifest
  at a newer schema version refuses: its selection semantics are unsupported. Raw store warning text
  and raw adapter errors never enter the bundle; only the bounded code does.
- Every selected image outcome is resolved as captured-and-verified (§3) or as an omission with one
  bounded code: `image-missing` (file absent), `image-unreadable` (read or permission failure) or
  `image-mismatch` (any §3 verification disagreement, including an empty file). Duplicate selected
  record IDs, or a record whose bytes cannot be bound to its manifest entry, refuse instead: an
  ambiguous selection is never reclassified as an omission or an empty list.

### 2.3 Change during capture, disclosed honestly

Each file observation is the port snapshot's SHA-256 of the exact bytes read; parsed values are
derived from those bytes and from no other read. The opening and closing samples are compared as
hashes and name sets. If any compared value differs (a compared file changed, appeared or
disappeared, or the manifest state changed), the capture is discarded whole, nothing freezes, and
the author is told the source changed during collection and to try again.

Agreeing samples are only samples. The following remain undetected by design and must be disclosed,
not denied, in the consent and completion wording the journey shows (T014-U owns the exact copy;
this contract owns the content):

- A change that leaves and returns to identical bytes between or within samples is indistinguishable
  from no change. It cannot affect the bundle's bytes, but the protocol does not claim it did not
  happen.
- A change outside a sampled interval, and any change after the closing sample, is outside the
  evidence. Edits after the freeze cannot change the package, because rendering and publication use
  only frozen bytes; they are simply not included.
- The bundle is therefore always described as saved data collected over an interval whose start and
  end samples agreed, never as the book at a single instant, a simultaneous snapshot, or proof that
  nothing changed in between.

File watching, where a port offers it, is advisory only and is never change evidence for this
protocol.

### 2.4 Freeze identity and consent invalidation

Each admitted capture gets a host capture sequence number for its book. The frozen bundle's identity
for consent binding is the tuple of: book ID, capture sequence, `book.json` SHA-256, the ordered
per-chapter (ID, file SHA-256) pairs, the manifest SHA-256 or unreadable state, the ordered
per-selected-image (record ID, SHA-256 or omission code) pairs, the planner's frozen warnings and
excluded-legacy references, and the production policy label of §4. Legacy consent (folder format §5)
binds to that tuple and its plan.

A new capture is a new bundle and invalidates consent given for an earlier one, even if every digest
agrees: starting a new capture for the book supersedes any pending consent, and publication must
re-check that the consent's capture sequence is still the latest admitted capture. A changed
destination or projection likewise needs a new choice, as the folder format already states.

## 3. Trusted-construction handoff

### 3.1 Who may call, and with what

Only the §1 capture code may call `createMarkdownFolderBundle`, in the same trusted host process
that holds the open library. It must never be called with renderer-supplied values, IPC payload
objects, toolkit or agent data, or any object obtained from an untrusted producer; if such a
producer were ever involved, a separately specified serialization or isolation boundary would be
required first, as the folder format §6 states.

The input is built fresh by the capturing side as plain own-data values copied out of validated
saved data (parsed book and chapter values, the single manifest snapshot, verified image bytes),
with no getters, callbacks, proxies or class instances, exactly as the planner's construction seam
requires. Matter is the captured raw JSON value from the single `book.json` snapshot. Image bytes
enter as the exact verified file bytes; the capturing side does not pass a mutable view it will
reuse, and keeps no expectation that mutating its copy later affects the bundle (construction copies
again into private storage). A construction throw is a capture failure with a bounded host reason;
there is no fallback construction path. Planning refusals are returned structured by the planner and
are shown as refusals, never narrowed into a partial plan.

### 3.2 What the capturing side must verify before handoff

The planner trusts the bundle. For each selected image the capturing side binds the record to its
privately captured bytes before planning, against the one manifest snapshot of §2.1 step 4 (never a
per-image manifest reread that could observe a different manifest):

| Binding | Verification required before handoff |
| --- | --- |
| Membership | The record appears in the captured manifest for this book; its `chapterId` names a captured chapter; its selected position is its index among that chapter's selected records |
| Identity | Record ID is used as the outcome's `recordId`; duplicate selected IDs refuse (§2.2) |
| Location | Bytes were read from that record's own manifest file name under this book's `images/`; no substituted record or file is admitted |
| Length | Byte length equals the record's declared byte count and is non-zero |
| Digest | SHA-256 of the exact bytes equals the record's declared digest |
| Header and format | Header inspection detects a format; the record has no separate format field, so the declared format is defined as both the format implied by the record's `mimeType` (`image/png` → `png`, `image/jpeg` → `jpg`, `image/webp` → `webp`) and the format implied by the record's `fileName` extension (`.png` → `png`, `.jpg` → `jpg`, `.webp` → `webp`) under the `jpeg` → `jpg` mapping; the detected format, mapped to the planner's `png`/`jpg`/`webp`, must equal both, and any other or missing extension is a disagreement |
| MIME | The record's `mimeType` equals the detected format's MIME type (`image/png`, `image/jpeg`, `image/webp`); this check is defined from `mimeType` alone and is independently breakable from the `fileName`-extension format check (changing `mimeType` breaks MIME without renaming the file; renaming the extension breaks format without changing `mimeType`) |
| Dimensions | Detected width and height are positive and equal the record's declared width and height |

Any disagreement is the `image-mismatch` omission of §2.2, naming chapter and selected position;
the manuscript text still exports. The same binding discipline applies to text: chapter ID, title,
saved order and parsed body in one outcome all derive from one file snapshot; book title,
description, the contents setting, matter and legacy pairs all derive from the one `book.json`
snapshot; bundle chapter order is the canonical order of §2.1 step 3.

### 3.3 What remains unverified

Neither capture nor the planner proves any of the following, and no wording may claim them:
provenance or authenticity of bytes (digest agreement binds bytes to a record, never a supplier to
bytes); that an image decodes completely, is sanitized, or is supported by every reader (header
inspection parses headers only; payload damage beyond the header, decompression abuse and embedded
metadata are not assessed, and copied metadata is disclosed rather than stripped); that author body
links resolve or that body Markdown is safe in any reader; semantics of unknown `book.json` fields;
or any simultaneous-snapshot, publication, no-replace, cancellation or target property (§5).

## 4. Production policy (Q0 production policy v1)

The host passes this exact policy object to `planMarkdownFolderExport` and labels consent and
diagnostics with `Q0 production policy v1`. The planner defines no defaults (its tests use unbounded
stand-ins), so every value below is derived here: from hard file and format constraints where they
exist, from the planner's counting definitions, and from the synthetic measurements in §4.2. Exceeding
any dimension refuses the whole plan by that dimension; input is never trimmed, narrowed or dropped
to fit, and a larger legitimate book is future work under a revised policy, not a silent subset.

| Planner dimension | Production value | Derivation |
| --- | --- | --- |
| `maxInputStringCodeUnits` | 26,214,400 (25 Mi) | Total retained text (titles, bodies, matter strings, legacy pairs, IDs, codes). One chapter saved through the studio's IPC may hold 20,000,000 code units; the envelope admits that chapter plus 6,214,400 units of remaining book text |
| `maxInputStringUtf8Bytes` | 78,643,200 (75 MiB) | Exactly 3× the code-unit value. UTF-8 uses at most 3 bytes per code unit (BMP) and 2 per unit (astral pairs), so this dimension is a non-binding backstop behind the code-unit limit, counted anyway |
| `maxInputCollectionItems` | 4,096 | Component maxima below sum to 4,065 (2,000 chapters + 40 sections + 1,024 image outcomes + 1,000 legacy pairs + 1 list warning), with 31 of headroom; the planner counts chapters + parsed sections + legacy pairs + image outcomes + list warnings |
| `maxPerImageBytes` | 20,971,520 (20 MiB) | The image store's hard admission maximum (`MAX_IMAGE_BYTES`); header inspection likewise accepts nothing larger, so no stored image can legitimately exceed it |
| `maxTotalImageBytes` | 134,217,728 (128 MiB) | Bounded copied payload for one folder; identical bytes in distinct records count separately, as the planner counts. Roughly six maximum-size images, or 128 images of 1 MiB; beyond it the book refuses whole |
| `maxGeneratedUtf8Bytes` | 104,857,600 (100 MiB) | Policy cap with prose overhead measured in §4.2: generated text re-emits admitted input bytes (bodies verbatim; titles and labels are escape-expanded), plus generated syntax and repeated navigation labels. Escape expansion and label repetition mean generated bytes can exceed input bytes — a control or punctuation title expands per emission and repeats across the README link, the contents link and the chapter heading (and illustration labels) — so an admitted book can exceed this cap while within the 75 MiB input envelope and then refuses on the generated dimension. Matter titles and names are per-field bounded; book and chapter titles are bounded only by the retained-text envelope |
| `maxTotalOutputBytes` | 239,075,328 (228 MiB) | Exactly generated maximum + total-image maximum (100 MiB + 128 MiB), so the total-output dimension binds only after its two parts do |
| `maxRegularFiles` | 4,091 | 1 README + at most 3,066 reading files (1 title + 40 sections + 1 contents + 2,000 chapters + 1,024 illustrations) + at most 1,024 copied images |
| `maxDirectoryEntries` | 4,092 | Regular-file maximum + the single `images/` directory, the planner's counting definition |
| `maxRetrievalRequests` | 4,091 | One retrieval per regular file in a complete once-per-file publication pass |
| `maxRetrievalBytes` | 239,075,328 | One full retrieval returns exactly the total output bytes |
| `maxAccountedPayloadBytes` | 769,654,784 | The planner's envelope at the other maxima together: retained charge (2 × 26,214,400 = 52,428,800) + total images (134,217,728) + total output (239,075,328) + temporary payload (104,857,600) + one full retrieval (239,075,328). Overlaps are charged even where storage could be shared |

Component maxima the capture enforces alongside the planner totals: 2,000 chapters; 40 matter
sections (already the matter schema's hard maximum, not a host choice); 1,024 selected image
outcomes (captured plus omitted); 1,000 legacy pairs; 1 list-level warning (the manifest-state
warning is the only list warning this protocol emits). A fresh plan must still leave room to retrieve
every output file once under the retrieval and accounted limits at the same time; the values above
satisfy that by construction, and later repeat retrievals may exhaust the remaining headroom, as the
planner charges.

Companion bounded-read caps (capture refuses rather than reading without bound; these bound
acquisition memory before the planner runs): `book.json` 16,777,216 bytes (the matter value inside
it is already capped at 2,500,000 bytes on save); one chapter file 83,886,080 bytes (parsed body
within the text envelope, plus front matter); `images.json` 16,777,216 bytes; one image file
20,971,520 bytes (the store maximum above). A source file beyond its cap is required content the
production envelope cannot observe completely, so capture refuses whole and says so.

### 4.1 Acquisition counts

Per admitted capture, the protocol of §2 performs, for C chapters and S selected images: file reads
= 2 × (1 `book.json` + C chapter files + 1 manifest + S image files), the second pass being the
closing sample (image closing reads compare hashes of the same files), plus 6 listing operations
(chapter list, chapter inspection and image-directory list, twice). Planning then retrieves each
planned file once for publication: `regularFileCount` retrievals totalling `totalOutputBytes`.
These are protocol-step counts for a fixture's shape, not observations of a host that does not exist
yet; T014-Q must report the implemented counts against them.

### 4.2 Measured synthetic evidence

Measured by executing synthetic in-memory bundles through the accepted planner under the production
policy above (Bun 1.4.4, this worktree; fixtures: ASCII bodies of repeated synthetic prose,
PNG-signature image bytes, every planned file then retrieved once). Commands: `bun run
/tmp/q0-measure.ts` (fixture script, synthetic data only, kept outside the repository) and
`bun test packages/core/tests/markdown-folder/` (32 pass, 0 fail, 235 expect() calls). Heap deltas
are single-run `heapUsed` differences around planning plus full retrieval: an indicator, not a peak,
and never a substitute for the accounted envelope or for host peak measurement in T014-Q.

| Fixture | Input code units | Images | Generated / total output bytes | Files (retrievals / bytes) | Accounted (with one full retrieval) | Protocol file reads | Plan ms | Heap delta bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Representative: 2 chapters, 2 images | 308 | 8 B | 1,085 / 1,093 | 11 / 1,093 | 2,802 (3,895) | 12 | 15.8 | 412,672 |
| Novel: 120 chapters × 5,500 chars, 12 × 256 KiB | 663,259 | 3,145,728 B | 674,656 / 3,820,384 | 151 / 3,820,384 | 8,967,286 (12,787,670) | 268 | 19.2 | 6,480,551 |
| Large: 300 chapters × 20,000 chars, 24 × 1 MiB | 6,007,759 | 25,165,824 B | 6,035,524 / 31,201,348 | 355 / 31,201,348 | 74,418,214 (105,619,562) | 652 | 34.1 | 81,882,475 |
| Text-heavy: 50 chapters × 100,000 chars, no images | 5,001,335 | 0 B | 5,005,646 / 5,005,646 | 55 / 5,005,646 | 20,013,962 (25,019,608) | 104 | 20.2 | 0 (collected before reading) |

All four fixtures plan successfully under the production policy, and in each the generated bytes stay
within a small overhead of the admitted body bytes (for example 6,035,524 generated from 6,007,759
input units in the large fixture). That small overhead is prose-fixture evidence only: it does not
bound escape-expanded, repeatedly emitted titles, which can push generated bytes well beyond input
bytes and refuse on the generated dimension (see §4). The accounted payload is a logical envelope,
not measured heap or memory use (folder format §6): real
acquisition bounds and host memory peaks at production-boundary synthetic books must still be
measured on each admitted target before exposure, and changing any value above requires a decision
update with new measurements, never an unrecorded host constant.

## 5. Per-target capability matrix (today)

Q capabilities are: **capture** (§2 enumeration and freeze), **verify** (§3 image binding),
**plan** (planner under §4), **stage** (assemble the folder in owned sibling staging), **commit**
(genuine no-replace publication to a new destination), **replace** (existing-folder replacement),
**cancel/settle** (attempt-bound cancellation and truthful settlement) and **deliver** (mounted
journey showing destination, files and warnings). The desktop author-chosen local-folder target claims
capture, verify, plan, stage, no-replace commit, cancel/settle and delivery, with synthetic evidence
only. No other target claims the folder journey. Replacement is refused.

| Capability | Desktop, author-chosen local folder | Desktop, removable / network / synced folder | Browser, author-picked folder | Browser, origin storage (OPFS) |
| --- | --- | --- | --- | --- |
| Capture | Implemented: complete bounded reads and opening/closing samples; synthetic evidence only. | Cannot claim: same code path, consistency over sync unqualified | Cannot claim: port implements library reads; capture unimplemented | Cannot claim: same port class; capture unimplemented |
| Verify | Implemented: §3 image binding; synthetic evidence only. | Cannot claim: same primitives, unimplemented | Cannot claim: hashing needs Web Crypto; binding unimplemented | Cannot claim: same, unimplemented |
| Plan | Implemented: wired through the host; synthetic evidence only. | Pure planner available; not wired | Pure planner available; not wired | Pure planner available; not wired |
| Stage | Implemented: owned sibling staging; synthetic evidence only. | Cannot claim: partial staging may be synced or cross a volume boundary | Cannot claim: no atomic directory staging primitive | Cannot claim: no author-visible folder to stage for |
| Commit (no-replace) | Implemented: exclusive destination creation and per-file moves; synthetic evidence only. | Cannot claim: rename and durability semantics vary by volume and sync client | Cannot claim: directory move is copy-then-remove, not atomic | Cannot claim: no destination publication exists |
| Replace | Refused: named successor work; no destination is deleted or merged. | Cannot claim: successor work | Cannot claim: successor work | Cannot claim: successor work |
| Cancel / settle | Implemented: attempt-bound cancel before commit; accepted cancel prevents publication; late cancel is too late; post-publication cleanup is a published warning, not unknown. | Cannot claim: no folder attempt lifecycle | Cannot claim: manuscript exports are refused on web today | Cannot claim: no export exists |
| Deliver | Implemented: mounted Format journey with destination, files and warnings; synthetic evidence only. | Cannot claim: no mounted journey | Cannot claim: journey unavailable (folder format §8) | Cannot claim: no folder delivery surface |

The desktop local-folder target now claims the implemented Q journey above; the single-file exports
gain attempt-bound cancellation. The other destination classes and replacement gain nothing. The
single-file DOCX, PDF, EPUB and Markdown exports and the separate all-images action remain desktop
publication under their own contracts; web manuscript exports remain refused as desktop-only. The
browser build's manuscript exports being unavailable is a current product fact this matrix records,
not a folder capability. Native and mobile surfaces have no spec 035 export journey today and claim
nothing.
Each desktop destination class (local, removable, network, synced) and each browser storage class
needs its own qualification evidence before any cell above changes; crash and restart recovery of an
interrupted publication needs its own claim and evidence as well.

## 6. What T014-Q must prove against this contract

Paired positive and adversarial tests, all on synthetic fixtures in isolated temporary libraries:
complete enumeration admitted (§2.2) and each completeness failure refused (placeholder or
unsupported chapter entry, unreadable chapter, duplicate-ID copy, unreadable matter, newer manifest);
opening/closing disagreement discarded whole, with the change-and-change-back disclosure present in
consent wording rather than denied; manifest read / known-empty / unreadable states, including image
files with no readable manifest; each image binding of §3.2 broken in turn (length, digest, header
(no detected format), file-name extension (format), MIME type, dimensions, substituted record)
producing its omission while text still exports, and a record substituted after capture refusing;
construction with anything but fresh validated data
refused without fallback; each production dimension at its exact boundary accepted and one beyond
refused under `Q0 production policy v1`, with implemented acquisition counts and measured host peaks
reported against §4; and per-target qualification for whichever §5 target is first admitted, with
genuine no-replace evidence (a destination created during staging prevents publication). No folder
target is exposed before its column of §5 is qualified end to end.

## 7. Limits

This contract implements nothing, captures nothing from a real library, publishes nothing and exposes
no journey. It does not advance typography, pagination, paged-target illustration placement, the
all-images action, the portable archive, image-generation validation or word-processor captions,
which keep their existing owners. Production values above bound the first host implementation; they
are policy the planner receives, so revising them needs a decision update and new measurements, not
a planner change.
