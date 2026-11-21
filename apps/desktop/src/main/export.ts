import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  LineRuleType,
  PageBreak,
  Packer,
  Paragraph,
  TextRun,
  VerticalAlignSection,
  type IParagraphOptions
} from "docx";
import { lstat, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ImageExportNote, ImageExportResult } from "@ai-book-studio/core/ipc";
import { MATTER_STYLE, sectionName, type MatterSection } from "@ai-book-studio/core/matter";
import type { BookDetail, ManuscriptSettings } from "@ai-book-studio/core/schema";
import type { ImageList, ImageRecord, StoredImage } from "@ai-book-studio/core/images";
import { LibraryPortError } from "@ai-book-studio/core/library/errors";
import { LibraryError } from "./library/errors";
import { writeFileAtomic } from "./library/atomic";
import { buildEpub } from "./epub";
import { buildManuscriptHtml, exportPlan } from "./manuscript-html";
import { createExportWriter, DESTINATION_CHANGED, inspectExportDestination, type ExportAtomicOverrides, type ExportInspectionOverrides } from "./export-publication";

const LINE_SPACING: Record<ManuscriptSettings["lineSpacing"], number> = {
  Single: 240,
  "1.15": 276,
  "1.5": 360,
  Double: 480
};

function twips(inches: number): number {
  return Math.round(inches * 1440);
}

export interface DocxImage {
  bytes: Uint8Array;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
  prompt: string;
}

/**
 * Builds a Word manuscript from the book's files.
 *
 * The Markdown body is the source of truth. A paragraph is a line, so each non-empty line becomes
 * its own paragraph with the book's manuscript settings applied. Front matter comes before the
 * chapters and back matter after them, each section on a new page; a generated title page is its
 * own section, centred on the page. A book without matter gets exactly the document it always got.
 * Nothing is written to the library.
 */
export async function buildDocx(detail: BookDetail, illustrations: Map<string, DocxImage> = new Map()): Promise<Buffer> {
  const { book, chapters } = detail;
  const settings = book.settings.manuscript;
  const plan = exportPlan(detail);
  const bodyFont = settings.bodyFont;
  const bodySize = Math.round(settings.bodyFontSize * 2);
  const alignment = settings.chapterTitleAlignment === "Center" ? AlignmentType.CENTER : AlignmentType.LEFT;
  const line = LINE_SPACING[settings.lineSpacing];
  const titlePage: Paragraph[] = [];
  const children: Paragraph[] = [];

  /** One paragraph per line of a chapter or a section, as the Markdown body has them. */
  const bodyLines = (content: string, style: { indent: boolean; center?: boolean }): IParagraphOptions[] =>
    content
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((value) => {
        const text = value.trimEnd();
        if (!text.trim()) return { spacing: { line, lineRule: LineRuleType.AUTO }, children: [] };
        return {
          spacing: { line, lineRule: LineRuleType.AUTO, after: 0 },
          ...(style.center ? { alignment: AlignmentType.CENTER } : {}),
          ...(style.indent && settings.firstLineIndent > 0 ? { indent: { firstLine: twips(settings.firstLineIndent) } } : {}),
          children: [new TextRun({ text, font: bodyFont, size: bodySize })]
        };
      });

  // Whether the next paragraph already starts a page: at the top, and after a page break.
  let fresh = true;
  const addSection = (section: MatterSection): void => {
    const style = MATTER_STYLE[section.kind];
    const title = section.title.trim();
    const paragraphs: IParagraphOptions[] = [
      ...(title
        ? [
            {
              heading: HeadingLevel.HEADING_1,
              alignment: style === "centered" ? AlignmentType.CENTER : alignment,
              spacing: { after: 240 },
              children: [new TextRun({ text: title, bold: true, font: bodyFont, size: 36 })]
            }
          ]
        : []),
      ...(section.text.trim() ? bodyLines(section.text.trimEnd(), { indent: !style, center: style === "centered" }) : [])
    ];
    if (paragraphs.length === 0) paragraphs.push({ children: [] });
    for (const [index, options] of paragraphs.entries()) {
      children.push(new Paragraph(index === 0 && !fresh ? { ...options, pageBreakBefore: true } : options));
    }
    fresh = false;
  };

  if (plan.titlePage) {
    // A generated title page is a section of its own, so Word can centre it on the page.
    (plan.present ? titlePage : children).push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [new TextRun({ text: book.title, bold: true, font: bodyFont, size: 64 })]
      })
    );
    if (plan.subtitle) {
      (plan.present ? titlePage : children).push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: plan.subtitle, italics: true, font: bodyFont, size: 24 })]
        })
      );
    }
    if (plan.author) {
      titlePage.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 480 },
          children: [new TextRun({ text: plan.author, font: bodyFont, size: 28 })]
        })
      );
    }
    if (!plan.present) children.push(new Paragraph({ children: [new PageBreak()] }));
  }
  plan.front.forEach(addSection);

  const ordered = [...chapters].sort((a, b) => a.order - b.order);
  ordered.forEach((chapter, index) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: index > 0 || !fresh,
        alignment,
        spacing: { after: 240 },
        children: [
          new TextRun({
            text: chapter.title || `Chapter ${chapter.order}`,
            bold: true,
            font: bodyFont,
            size: 36
          })
        ]
      })
    );
    fresh = false;

    for (const options of bodyLines(chapter.content, { indent: true })) children.push(new Paragraph(options));

    const illustration = illustrations.get(chapter.id);
    if (illustration) {
      const ratio = Math.min(480 / illustration.width, 640 / illustration.height);
      const caption = illustration.prompt.trim();
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 240, after: 120 },
          children: [
            new ImageRun({
              type: illustration.mimeType === "image/png" ? "png" : "jpg",
              data: illustration.bytes,
              transformation: {
                width: Math.max(1, Math.round(illustration.width * ratio)),
                height: Math.max(1, Math.round(illustration.height * ratio))
              },
              altText: {
                name: chapter.title,
                description: caption || `Illustration for ${chapter.title}`,
                title: chapter.title
              }
            })
          ]
        })
      );
      if (caption) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 240 },
            children: [
              new TextRun({
                text: caption.length > 160 ? `${caption.slice(0, 159)}…` : caption,
                italics: true,
                font: bodyFont,
                size: 20
              })
            ]
          })
        );
      }
    }
  });

  plan.back.forEach(addSection);

  return Packer.toBuffer(
    new Document({
      creator: plan.author || "Open Book Studio",
      title: book.title,
      description: book.description,
      // A title page with nothing after it is the whole document, with no empty page behind it.
      sections: [
        ...(titlePage.length > 0 ? [{ properties: { verticalAlign: VerticalAlignSection.CENTER }, children: titlePage }] : []),
        ...(children.length > 0 || titlePage.length === 0 ? [{ properties: {}, children }] : [])
      ]
    })
  );
}

/** The image-store surface the DOCX and image exports read. The desktop Library satisfies this. */
export interface DocxImageSource {
  listImages(bookId: string): Promise<ImageList>;
  readImage(bookId: string, imageId: string): Promise<StoredImage | null>;
}

/**
 * Resolves the chapter illustrations for a DOCX export through the image store.
 *
 * Illustration problems never fail the export: an unreadable manifest yields no illustrations,
 * and unattached images, WebP images (no Word-compatible variant) and unreadable bytes are
 * skipped with a warning. The first readable image per chapter wins.
 */
export async function collectDocxImages(
  detail: BookDetail,
  images: DocxImageSource
): Promise<Map<string, DocxImage>> {
  const result = await collectManuscriptImages(detail, images);
  for (const warning of result.warnings) console.warn("[export]", warning);
  return result.illustrations;
}

/** Snapshot-specific warnings travel with the rendered images, never via a second renderer read. */
export async function collectManuscriptImages(
  detail: BookDetail,
  images: DocxImageSource,
  target: "embedded" | "markdown" = "embedded"
): Promise<{ illustrations: Map<string, DocxImage>; warnings: string[] }> {
  const collected = new Map<string, DocxImage>();
  const warnings: string[] = [];
  const chapters = new Map(detail.chapters.map((chapter) => [chapter.id, chapter.title]));
  try {
    const { manifest, warning } = await images.listImages(detail.book.id);
    if (warning) warnings.push(`Illustrations were not included because the image list could not be read. ${warning}`);
    for (const record of manifest.images) {
      if (!record.chapterId || !chapters.has(record.chapterId)) continue;
      const name = `${record.fileName} (${chapters.get(record.chapterId)})`;
      if (target === "markdown") {
        warnings.push(`Skipped ${name}: this Markdown export is text only and does not include illustrations.`);
        continue;
      }
      if (record.mimeType === "image/webp") {
        warnings.push(`Skipped ${name}: WebP illustrations are not supported by this export.`);
        continue;
      }
      if (collected.has(record.chapterId)) {
        warnings.push(`Skipped ${name}: only the first readable illustration for each chapter is included.`);
        continue;
      }
      try {
        const stored = await images.readImage(detail.book.id, record.id);
        if (stored) {
          collected.set(record.chapterId, {
            bytes: new Uint8Array(stored.bytes),
            width: record.width,
            height: record.height,
            mimeType: record.mimeType,
            prompt: record.prompt
          });
        } else {
          warnings.push(`Skipped ${name}: the image is no longer in the book's image list.`);
        }
      } catch (error) {
        const reason = error instanceof LibraryError || error instanceof LibraryPortError
          ? error.message : "The image file could not be read.";
        warnings.push(`Skipped ${name}: ${reason}`);
      }
    }
  } catch {
    warnings.push("Illustrations were not included because the image list could not be read.");
  }
  return { illustrations: collected, warnings };
}

/**
 * A file-name stem from author text: lower-case letters and digits joined by hyphens. NFC keeps two
 * spellings of one accented name from becoming two names that a normalising filesystem (APFS) would
 * store as one file. The stem keeps at most 60 whole characters and 180 bytes, so a cut never splits
 * a character and a name with its prefix and suffix stays under the 255-byte limit.
 */
function slugify(text: string, fallback: string): string {
  const slug = text
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  let kept = "";
  let bytes = 0;
  for (const character of Array.from(slug).slice(0, 60)) {
    bytes += Buffer.byteLength(character);
    if (bytes > 180) break;
    kept += character;
  }
  return kept.replace(/-+$/, "") || fallback;
}

/** A safe file name for the export dialog, derived from the book title. */
function suggestStem(title: string): string {
  return slugify(title, "manuscript");
}

/** A safe file name for the export dialog, derived from the book title. */
export function suggestDocxName(title: string): string {
  return `${suggestStem(title)}.docx`;
}

/** A safe file name for the Markdown export dialog, derived from the book title. */
export function suggestMarkdownName(title: string): string {
  return `${suggestStem(title)}.md`;
}

/** A safe file name for the PDF export dialog, derived from the book title. */
export function suggestPdfName(title: string): string {
  return `${suggestStem(title)}.pdf`;
}

/** A safe file name for the EPUB export dialog, derived from the book title. */
export function suggestEpubName(title: string): string {
  return `${suggestStem(title)}.epub`;
}

/**
 * Builds a Markdown manuscript from the book's files.
 *
 * The Markdown body is already the source of truth, so chapters join in reading order under
 * their own headings with their text unchanged, one blank line between blocks. Front matter comes
 * before them and back matter after, each section under its heading, or its kind when it has
 * none. Nothing is written to the library.
 */
export function buildMarkdown(detail: BookDetail): string {
  const { book, chapters } = detail;
  const plan = exportPlan(detail);
  const blocks: string[] = [];
  const add = (heading: string, content: string): void => {
    blocks.push(`## ${heading}`);
    const body = content.replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd();
    if (body) blocks.push(body);
  };
  if (plan.titlePage) {
    if (book.title.trim()) blocks.push(`# ${book.title.trim()}`);
    if (plan.subtitle) blocks.push(`_${plan.subtitle}_`);
    if (plan.author) blocks.push(plan.author);
  }
  for (const section of plan.front) add(sectionName(section), section.text);
  const ordered = [...chapters].sort((a, b) => a.order - b.order);
  for (const chapter of ordered) add(chapter.title || `Chapter ${chapter.order}`, chapter.content);
  for (const section of plan.back) add(sectionName(section), section.text);
  return `${blocks.join("\n\n")}\n`;
}

/**
 * True when the candidate destination is the library root or inside it. An export there could
 * alias a source file or land inside the managed source directory, so the boundary refuses it
 * and asks the author to choose another folder. This is a path-prefix check: it does not
 * resolve symlinks that point back into the library from outside.
 */
export function isInsideLibrary(libraryRoot: string, candidate: string): boolean {
  const comparison = relative(resolve(libraryRoot), resolve(candidate));
  return comparison === "" || (comparison !== ".." && !comparison.startsWith(`..${sep}`) && !isAbsolute(comparison));
}

export interface ExportState {
  mtimeMs: number;
  size: number;
}

/** Kept for the DOCX journey's existing imports; new code uses ExportDeps. */
export type DocxExportState = ExportState;

/** What the author reads when an export is refused because some chapter files could not be read. */
export const UNREADABLE_CHAPTERS_EXPORT_MESSAGE =
  "The manuscript was not exported because some chapter files could not be read. Reopen the book and review the affected files.";

/**
 * A manuscript export is a statement that this is the book. When some chapter files could not be read
 * the readable chapters are only a subset, so every manuscript export refuses before it asks for a
 * destination, builds a file or writes anything, rather than hand over a book with chapters missing.
 */
export function assertNoUnreadableChapters(detail: BookDetail): void {
  if (detail.chapterReadIssues.length > 0) throw new LibraryError("format", UNREADABLE_CHAPTERS_EXPORT_MESSAGE);
}

export interface ExportDeps {
  pickDestination: (suggestedName: string) => Promise<string | null>;
  confirmReplace: (path: string) => Promise<boolean>;
  statDestination: (path: string) => Promise<ExportState | null>;
  writeFile?: (path: string, data: Uint8Array) => Promise<void>;
  /** Scoped filesystem faults for synthetic publication tests; production uses the real writer. */
  atomic?: ExportAtomicOverrides;
  inspection?: ExportInspectionOverrides;
  /** The attempt's cancel signal; checked at each checkpoint and at the pre-rename gate. */
  signal?: AbortSignal;
  /** Called once, in the same synchronous block as the last abort check before rename. */
  onPublishStart?: () => void;
}

/** The author cancelled before publication. Distinct from a LibraryError; nothing was written. */
export class ExportCancelledError extends Error {
  constructor(message = EXPORT_CANCELLED_MESSAGE) {
    super(message);
    this.name = "ExportCancelledError";
  }
}

export const EXPORT_CANCELLED_MESSAGE = "The export was cancelled before it was published. Nothing was written.";

/** The cancelled receipt for a boundary failure, including a temp that could not be removed. */
export function cancelledExportOutcome(
  error: unknown
): { status: "cancelled"; message: string } | null {
  if (error instanceof ExportCancelledError) return { status: "cancelled", message: EXPORT_CANCELLED_MESSAGE };
  if (error instanceof LibraryError && error.cause instanceof ExportCancelledError) {
    const temporary = (error as LibraryError & { temporaryPath?: unknown }).temporaryPath;
    const path = typeof temporary === "string" ? temporary : null;
    return {
      status: "cancelled",
      message: path
        ? `${EXPORT_CANCELLED_MESSAGE} Temporary output could not be removed: ${path}. Remove that file when it is no longer needed.`
        : EXPORT_CANCELLED_MESSAGE
    };
  }
  return null;
}

function throwIfExportCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportCancelledError();
}

/** Kept for the DOCX journey's existing imports; new code uses ExportDeps. */
export type DocxExportDeps = ExportDeps;

function sameExportState(before: ExportState | null, after: ExportState | null): boolean {
  if (!before || !after) return before === after;
  return before.mtimeMs === after.mtimeMs && before.size === after.size;
}

/**
 * Publishes a DOCX export through the safe-publication boundary.
 *
 * A cancelled picker or a declined replacement returns null and writes nothing, exactly like a
 * cancelled save dialog. A destination inside the open library, a file that changed after the
 * replacement consent, or a failed write throws and never leaves a partial file: the write goes
 * through the atomic writer, which stages to a sibling temp file and renames over the target.
 */
export async function exportManuscriptDocx(
  detail: BookDetail,
  illustrations: Map<string, DocxImage>,
  libraryRoot: string,
  deps: ExportDeps
): Promise<string | null> {
  assertNoUnreadableChapters(detail);
  const snapshot = structuredClone(detail);
  const pictures = structuredClone(illustrations);
  return publishManuscript(suggestDocxName(snapshot.book.title), libraryRoot, deps, () => buildDocx(snapshot, pictures));
}

/**
 * Publishes a Markdown export through the same safe-publication boundary as the Word
 * export: a cancelled picker or a declined replacement returns null and writes nothing,
 * a destination inside the open library is refused, and a file that changed after the
 * replacement consent throws without leaving a partial file.
 */
export async function exportManuscriptMarkdown(
  detail: BookDetail,
  libraryRoot: string,
  deps: ExportDeps
): Promise<string | null> {
  assertNoUnreadableChapters(detail);
  const snapshot = structuredClone(detail);
  return publishManuscript(suggestMarkdownName(snapshot.book.title), libraryRoot, deps, async () =>
    new TextEncoder().encode(buildMarkdown(snapshot))
  );
}

/**
 * The Word and Markdown exports' publication boundary, for the PDF and EPUB exports: a cancelled
 * picker or a declined replacement returns null and writes nothing, a destination inside the open
 * library is refused, the file is built before the author is asked to replace anything, a file
 * that changed after the consent is refused, and the write is atomic.
 */
async function publishManuscript(
  suggestedName: string,
  libraryRoot: string,
  deps: ExportDeps,
  build: () => Promise<Uint8Array>
): Promise<string | null> {
  const destination = await deps.pickDestination(suggestedName);
  if (!destination) return null;
  // 1. The picker returned after a cancel: stop before inspection or any build.
  throwIfExportCancelled(deps.signal);
  if (isInsideLibrary(libraryRoot, destination)) {
    throw new LibraryError(
      "invalid",
      "That location is inside the open library. Choose another folder so the export cannot overwrite the book's own files."
    );
  }
  const inspected = await inspectExportDestination(libraryRoot, destination, deps.inspection);
  const observed = await deps.statDestination(destination);
  const data = await build();
  // 2. A long render that was cancelled must not then ask to replace a file.
  throwIfExportCancelled(deps.signal);
  if ((observed || inspected.exists) && !(await deps.confirmReplace(destination))) return null;
  // 3. Replacement consent arrived; stop before any staging write.
  throwIfExportCancelled(deps.signal);
  const validate = async (): Promise<void> => {
    const reread = await deps.statDestination(destination);
    if (!sameExportState(observed, reread) || inspected.fingerprint !== (await inspectExportDestination(libraryRoot, destination, deps.inspection)).fingerprint) {
      throw new LibraryError("io", DESTINATION_CHANGED);
    }
  };
  await validate();
  // The staging write starts only after this last pre-write check.
  throwIfExportCancelled(deps.signal);
  // 4. The atomic decision point: fingerprint, abort check and publish start in one synchronous block.
  const gate = async (): Promise<void> => {
    await validate();
    throwIfExportCancelled(deps.signal);
    deps.onPublishStart?.();
  };
  const write = deps.writeFile ?? createExportWriter(gate, deps.atomic);
  // Anchor staging and cleanup to the checked real parent, not a retargetable alias supplied by the picker.
  await write(inspected.resolvedPath, data);
  return destination;
}

export interface PdfExportDeps extends ExportDeps {
  /** Turns the manuscript HTML into PDF bytes: a hidden window on the desktop, a fake in tests. */
  renderPdf: (html: string) => Promise<Uint8Array>;
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength > 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
}

/**
 * Publishes a PDF of the manuscript. The book's HTML (`buildManuscriptHtml`) is rendered first, so
 * a render that fails or returns something other than a PDF writes nothing and asks nothing.
 */
export async function exportManuscriptPdf(
  detail: BookDetail,
  illustrations: Map<string, DocxImage>,
  libraryRoot: string,
  deps: PdfExportDeps
): Promise<string | null> {
  assertNoUnreadableChapters(detail);
  const snapshot = structuredClone(detail);
  const pictures = structuredClone(illustrations);
  return publishManuscript(suggestPdfName(snapshot.book.title), libraryRoot, deps, async () => {
    let pdf: Uint8Array;
    try {
      pdf = await deps.renderPdf(buildManuscriptHtml(snapshot, pictures));
    } catch (error) {
      if (error instanceof LibraryError) throw error;
      console.warn("[export] The PDF could not be rendered:", (error as Error | undefined)?.message);
      throw new LibraryError("io", "The PDF could not be made. Nothing was written. Try the export again.");
    }
    if (!isPdf(pdf)) throw new LibraryError("io", "The PDF could not be made. Nothing was written. Try the export again.");
    return pdf;
  });
}

/** Publishes an EPUB of the manuscript through the same boundary as the other exports. */
export async function exportManuscriptEpub(
  detail: BookDetail,
  illustrations: Map<string, DocxImage>,
  libraryRoot: string,
  deps: ExportDeps
): Promise<string | null> {
  assertNoUnreadableChapters(detail);
  const snapshot = structuredClone(detail);
  const pictures = structuredClone(illustrations);
  return publishManuscript(suggestEpubName(snapshot.book.title), libraryRoot, deps, async () =>
    buildEpub(snapshot, pictures)
  );
}

/** The folder the image export creates beside the manuscript, named for the book. */
export function suggestImageFolderName(title: string): string {
  return `${slugify(title, "untitled-book")}-images`;
}

export interface PlannedImage {
  record: ImageRecord;
  /** The JPEG's file name: the same for the same book, safe on every filesystem, unique in its folder. */
  name: string;
}

/**
 * Names every image in the manifest for where it appears and what it is.
 *
 * An image attached to a chapter takes the chapter's position in reading order and its title
 * (`01-the-door.jpg`). Any other image is named for its kind: `cover.jpg`, `character-mara.jpg` for
 * a cast member, `illustration.jpg` for a chapter picture that is not attached, and `image.jpg` for
 * anything else. A cutout adds `-cutout`. Names are compared without case, as macOS and Windows
 * compare them, and a repeat takes the next free `-2`, `-3` in manifest order, so the same book
 * always produces the same names.
 */
export function planImageFiles(detail: BookDetail, records: readonly ImageRecord[]): PlannedImage[] {
  const ordered = [...detail.chapters].sort((a, b) => a.order - b.order);
  const width = Math.max(2, String(ordered.length).length);
  const placed = new Map(ordered.map((chapter, index) => [chapter.id, { title: chapter.title, position: index + 1 }]));
  const cast = new Map(detail.book.characters.map((character) => [character.id, character.name]));
  const taken = new Set<string>();
  return records.map((record) => {
    const stem = imageStem(record, placed, cast, width);
    let name = `${stem}.jpg`;
    for (let copy = 2; taken.has(name.toLowerCase()); copy += 1) name = `${stem}-${copy}.jpg`;
    taken.add(name.toLowerCase());
    return { record, name };
  });
}

function imageStem(
  record: ImageRecord,
  placed: Map<string, { title: string; position: number }>,
  cast: Map<string, string>,
  width: number
): string {
  const cutout = record.cutoutOf !== null || record.source === "cutout" ? "-cutout" : "";
  const chapter = record.chapterId ? placed.get(record.chapterId) : undefined;
  if (chapter) {
    return `${String(chapter.position).padStart(width, "0")}-${slugify(chapter.title, "chapter")}${cutout}`;
  }
  if (record.kind === "cover") return `cover${cutout}`;
  if (record.kind === "character") {
    const name = slugify((record.characterId && cast.get(record.characterId)) || "", "");
    return `${name ? `character-${name}` : "character"}${cutout}`;
  }
  return `${record.kind === "chapter" ? "illustration" : "image"}${cutout}`;
}

export interface ImageExportDeps {
  /** The folder to create the images folder in, or null when the author cancels. */
  pickFolder: (folderName: string) => Promise<string | null>;
  /** JPEG bytes for a PNG or WebP image, or null when it cannot be decoded. */
  transcode: (bytes: Uint8Array) => Uint8Array | null | Promise<Uint8Array | null>;
  writeFile?: (path: string, data: Uint8Array) => Promise<void>;
}

const FORMAT_NAMES: Record<ImageRecord["mimeType"], string> = {
  "image/png": "PNG",
  "image/webp": "WebP",
  "image/jpeg": "JPEG"
};

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Exports every image in the book as a JPEG into one new folder, separately from the manuscript.
 *
 * Nothing is written to the library and nothing on disk is overwritten:
 * - a book with no images writes nothing and never opens the picker; a cancelled picker writes
 *   nothing;
 * - a destination inside the open library is refused, by path and by resolved path;
 * - the export creates `<book>-images` in the chosen folder and refuses when that already exists;
 * - JPEG images are copied byte for byte and the others go through the transcoder. An image that
 *   cannot be read or converted is skipped with a note, and the rest still export;
 * - each file is written atomically into a hidden staging folder beside the destination, which is
 *   renamed into place once every file is written. A failure removes the staging folder, so the
 *   author never finds a half-filled folder.
 */
export async function exportBookImages(
  detail: BookDetail,
  images: DocxImageSource,
  libraryRoot: string,
  deps: ImageExportDeps
): Promise<ImageExportResult> {
  const { manifest, warning } = await images.listImages(detail.book.id);
  if (warning) {
    throw new LibraryError("format", `The book's image list could not be read, so nothing was exported. ${warning}`);
  }
  if (manifest.images.length === 0) return { status: "empty" };

  const folderName = suggestImageFolderName(detail.book.title);
  const parent = await deps.pickFolder(folderName);
  if (!parent) return { status: "cancelled" };
  if (await destinationInsideLibrary(libraryRoot, parent, folderName)) {
    throw new LibraryError(
      "invalid",
      "That location is inside the open library. Choose another folder so the export cannot overwrite the book's own files."
    );
  }

  const destination = join(parent, folderName);
  const write = deps.writeFile ?? ((path, bytes) => writeFileAtomic(path, bytes));
  const files: string[] = [];
  const skipped: ImageExportNote[] = [];
  let staging: string | null = null;
  try {
    if (await pathExists(destination)) throw folderExists(folderName);
    for (const { record, name } of planImageFiles(detail, manifest.images)) {
      const converted = await convertToJpeg(detail.book.id, record, images, deps.transcode);
      if (typeof converted === "string") {
        skipped.push({ name, reason: converted });
        continue;
      }
      // Beside the destination, so the final rename stays on one filesystem.
      staging ??= await mkdtemp(join(parent, `.${folderName}-`));
      await write(join(staging, name), converted);
      files.push(name);
    }
    if (!staging) return { status: "unconverted", skipped };
    // The author may have made the folder while the images were converting.
    if (await pathExists(destination)) throw folderExists(folderName);
    await rename(staging, destination);
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw publicationFailure(error, folderName);
  }
  await syncDirectory(parent);
  return { status: "saved", folder: destination, files, skipped };
}

/** The JPEG bytes for one image, or the reason it was skipped. */
async function convertToJpeg(
  bookId: string,
  record: ImageRecord,
  images: DocxImageSource,
  transcode: ImageExportDeps["transcode"]
): Promise<Uint8Array | string> {
  let stored: StoredImage | null;
  try {
    stored = await images.readImage(bookId, record.id);
  } catch (error) {
    // The store's messages already name the file and say what is wrong with it.
    if (error instanceof LibraryError || error instanceof LibraryPortError) return error.message;
    console.warn("[export] Skipping an unreadable image:", (error as Error).message);
    return "The image file could not be read.";
  }
  if (!stored) return "The image is no longer in this book's image list.";
  if (isJpeg(stored.bytes)) return stored.bytes;
  try {
    const jpeg = await transcode(stored.bytes);
    if (jpeg && isJpeg(jpeg)) return jpeg;
  } catch (error) {
    console.warn("[export] Could not convert an image:", (error as Error).message);
  }
  return `The ${FORMAT_NAMES[record.mimeType]} image could not be converted to JPEG.`;
}

/** True when the new folder would land in the library, by path or once symlinks are resolved. */
async function destinationInsideLibrary(libraryRoot: string, parent: string, folderName: string): Promise<boolean> {
  if (isInsideLibrary(libraryRoot, join(parent, folderName))) return true;
  const [root, folder] = await Promise.all([
    realpath(libraryRoot).catch(() => null),
    realpath(parent).catch(() => null)
  ]);
  return root !== null && folder !== null && isInsideLibrary(root, join(folder, folderName));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function folderExists(folderName: string): LibraryError {
  return new LibraryError(
    "invalid",
    `“${folderName}” already exists in that folder. Choose another folder, or rename the existing one first. Nothing was written.`
  );
}

function publicationFailure(error: unknown, folderName: string): LibraryError {
  if (error instanceof LibraryError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EEXIST" || code === "ENOTEMPTY") return folderExists(folderName);
  console.warn("[export] The images could not be written:", (error as Error | undefined)?.message);
  const reason =
    code === "EACCES" || code === "EPERM" || code === "EROFS"
      ? "The studio is not allowed to write in that folder."
      : code === "ENOSPC"
        ? "The disk is full."
        : "The images could not be written to that folder.";
  return new LibraryError("io", `${reason} Nothing was written.`);
}

/** Makes the final rename durable. Best effort, as in writeFileAtomic: not every filesystem allows it. */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The files themselves are already durable.
  }
}
