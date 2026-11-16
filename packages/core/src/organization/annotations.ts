import { z } from "zod";
import type { BookDetail, Chapter } from "../schema";
import { LibraryError } from "../library/errors";
import { chapterPath } from "../library/paths";
import { readHistoryEnvelope } from "../library/history";
import { normalizeBody } from "../markdown";
import { isScalarBoundary } from "../review/contract";
import { bookIdSchema, hashSchema, increment, prose, recordIdSchema, revisionSchema, shortText } from "../planning/schema";
import {
  assertSidecarOwner, CheckedSidecar, envelopeFields, parseRequest, SidecarRefusalError,
  type SidecarAttempt, type SidecarHost, type SidecarRead, type SidecarSave
} from "../planning/checked-sidecar";
import type { GoalHost } from "./goals";

const chapterIdSchema = z.string().regex(/^ch_[A-Za-z0-9-]{6,}$/);
const offsetSchema = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0);

/** The caller names the chapter, the half-open span and the excerpt. The service fills the rest. */
export const anchorRequestSchema = z.strictObject({
  chapterId: chapterIdSchema,
  startOffset: offsetSchema,
  endOffset: offsetSchema,
  excerpt: shortText.refine((value) => value.length > 0, "An excerpt is required.")
});
export type AnchorRequest = z.infer<typeof anchorRequestSchema>;

export const savedSpanSchema = z.looseObject({
  kind: z.literal("saved-body-span"),
  bookId: bookIdSchema,
  chapterId: chapterIdSchema,
  chapterVersion: z.number().refine((value) => Number.isSafeInteger(value) && value >= 0),
  chapterHash: hashSchema,
  startOffset: offsetSchema,
  endOffset: offsetSchema,
  excerpt: shortText
});
export type SavedSpan = z.infer<typeof savedSpanSchema>;

const recordFields = {
  id: recordIdSchema("ann"),
  revision: revisionSchema,
  bookId: bookIdSchema,
  archived: z.boolean(),
  anchor: savedSpanSchema
};
export const bookmarkSchema = z.looseObject({ ...recordFields, kind: z.literal("bookmark") });
export const noteSchema = z.looseObject({ ...recordFields, kind: z.literal("note"), note: prose });
export const annotationRecordSchema = z.union([bookmarkSchema, noteSchema]);
export type AnnotationRecord = z.infer<typeof annotationRecordSchema>;

export const annotationsSchema = z.looseObject({
  schemaVersion: z.literal(1),
  bookId: bookIdSchema,
  revision: revisionSchema,
  annotations: z.array(annotationRecordSchema)
}).superRefine((data, ctx) => {
  if (data.annotations.some((record) => record.bookId !== data.bookId || record.anchor.bookId !== data.bookId)) {
    ctx.addIssue({ code: "custom", message: "Every annotation must belong to this book." });
  }
  if (new Set(data.annotations.map((record) => record.id)).size !== data.annotations.length) {
    ctx.addIssue({ code: "custom", message: "Annotation IDs must be unique." });
  }
});
export type Annotations = z.infer<typeof annotationsSchema>;

export const annotationSaveSchema = z.strictObject({
  ...envelopeFields,
  draft: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("create-bookmark"), anchor: anchorRequestSchema }),
    z.strictObject({ kind: z.literal("create-note"), anchor: anchorRequestSchema, note: prose }),
    z.strictObject({ kind: z.literal("edit-note"), id: recordIdSchema("ann"), note: prose }),
    z.strictObject({ kind: z.literal("re-anchor"), id: recordIdSchema("ann"), anchor: anchorRequestSchema }),
    z.strictObject({ kind: z.literal("archive"), id: recordIdSchema("ann"), archived: z.boolean() })
  ])
});
export type AnnotationSaveRequest = z.infer<typeof annotationSaveSchema>;
export type AnnotationDraft = AnnotationSaveRequest["draft"];

export class AnnotationService {
  private readonly sidecar: CheckedSidecar<Annotations>;
  constructor(private readonly host: GoalHost) { this.sidecar = new CheckedSidecar(host, "annotations", annotationsSchema); }

  read(bookId: string): Promise<SidecarRead<Annotations>> { return this.sidecar.read(bookId); }

  async save(input: unknown, attempt?: SidecarAttempt): Promise<SidecarSave<Annotations>> {
    const request = parseRequest(annotationSaveSchema, input);
    const verified = await this.verifiedAnchor(request);
    return this.sidecar.save(request, (base) => applyAnnotationDraft(base, request, verified, () => (
      attempt ? `ann_${attempt.publicationId}` : this.host.runtime.newId("ann")
    )), attempt);
  }

  /** Create and re-anchor only. A failed check selects nothing and writes nothing. */
  private async verifiedAnchor(request: AnnotationSaveRequest): Promise<SavedSpan | null> {
    if (request.draft.kind !== "create-bookmark" && request.draft.kind !== "create-note" && request.draft.kind !== "re-anchor") {
      return null;
    }
    const asked = request.draft.anchor;
    try {
      return await this.host.withBook(request.bookId, async () => {
        await assertSidecarOwner(this.host, request.bookId);
        const detail = await this.host.readSavedBook(request.bookId);
        const chapter = oneChapter(detail, request.bookId, asked.chapterId);
        if (!await this.chapterMatches(chapter, request.bookId)) {
          throw new LibraryError("invalid", "The saved chapter could not be confirmed. Nothing was selected or written.");
        }
        const span = bodySpan(chapter.content, asked.startOffset, asked.endOffset);
        if (!span || chapter.content.slice(asked.startOffset, asked.endOffset) !== asked.excerpt) {
          throw new LibraryError("invalid", "The excerpt is not that saved span. Nothing was selected or written.");
        }
        return {
          kind: "saved-body-span" as const, bookId: request.bookId, chapterId: chapter.id,
          chapterVersion: chapter.version, chapterHash: chapter.hash,
          startOffset: asked.startOffset, endOffset: asked.endOffset, excerpt: asked.excerpt
        };
      });
    } catch (error) {
      if (error instanceof LibraryError) throw new SidecarRefusalError(error.message);
      throw error;
    }
  }

  private async chapterMatches(chapter: Chapter, bookId: string): Promise<boolean> {
    const snapshot = await this.host.storage.readFile(chapterPath(bookId, chapter.path));
    if (!snapshot || snapshot.sha256 !== chapter.hash || await this.host.runtime.sha256(snapshot.bytes) !== chapter.hash) return false;
    let raw: string;
    try { raw = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes); }
    catch { return false; }
    let content: string;
    if (/^---[ \t]*\r?\n/.test(raw)) {
      try {
        const envelope = readHistoryEnvelope(raw);
        const meta = envelope.metadata;
        if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
        if ("bookId" in meta && meta.bookId !== bookId) return false;
        if (("id" in meta && meta.id !== chapter.id) || ("version" in meta && meta.version !== chapter.version)) return false;
        content = envelope.content;
      } catch (error) {
        if (error instanceof LibraryError) return false;
        throw new LibraryError("format", "The saved chapter could not be read. Nothing was selected or written.");
      }
    } else content = normalizeBody(raw);
    return content === chapter.content;
  }
}

export function applyAnnotationDraft(
  base: Annotations | null,
  request: AnnotationSaveRequest,
  verified: SavedSpan | null,
  newId: () => string
): { data: Annotations; changed: boolean } {
  const data: Annotations = base ?? { schemaVersion: 1, bookId: request.bookId, revision: 1, annotations: [] };
  const draft = request.draft;
  if (draft.kind === "create-bookmark" || draft.kind === "create-note") {
    if (!verified) throw new LibraryError("invalid", "A new annotation needs a confirmed saved span. Nothing was written.");
    const id = newId();
    if (!recordIdSchema("ann").safeParse(id).success || data.annotations.some((record) => record.id === id)) {
      throw new LibraryError("invalid", "The host could not assign a unique annotation ID. Nothing was written.");
    }
    const record = draft.kind === "create-note"
      ? { id, revision: 1, bookId: request.bookId, archived: false, kind: "note" as const, note: draft.note, anchor: verified }
      : { id, revision: 1, bookId: request.bookId, archived: false, kind: "bookmark" as const, anchor: verified };
    return { changed: true, data: { ...data, annotations: [...data.annotations, record] } };
  }
  const record = data.annotations.find((entry) => entry.id === draft.id);
  if (!record) throw new LibraryError("not-found", "The annotation is not in the original document. Editing cannot create it.");
  if (draft.kind === "edit-note") {
    if (record.kind !== "note") throw new LibraryError("invalid", "Only a note has text to edit. Nothing was written.");
    if (record.archived) throw new LibraryError("invalid", "Restore this archived note before editing it. Nothing was written.");
    if (record.note === draft.note) return { data, changed: false };
    const updated = { ...record, note: draft.note, revision: increment(record.revision) };
    return { changed: true, data: { ...data, annotations: data.annotations.map((entry) => entry.id === record.id ? updated : entry) } };
  }
  if (draft.kind === "re-anchor") {
    if (!verified) throw new LibraryError("invalid", "Re-anchor needs a confirmed saved span. Nothing was written.");
    if (record.archived) throw new LibraryError("invalid", "Restore this archived annotation before re-anchoring it. Nothing was written.");
    if (sameAnchor(record.anchor, verified)) return { data, changed: false };
    const updated = { ...record, anchor: { ...record.anchor, ...verified }, revision: increment(record.revision) };
    return { changed: true, data: { ...data, annotations: data.annotations.map((entry) => entry.id === record.id ? updated : entry) } };
  }
  if (record.archived === draft.archived) return { data, changed: false };
  const updated = { ...record, archived: draft.archived, revision: increment(record.revision) };
  return { changed: true, data: { ...data, annotations: data.annotations.map((entry) => entry.id === record.id ? updated : entry) } };
}

function oneChapter(detail: BookDetail, bookId: string, chapterId: string): Chapter {
  if (detail.book.id !== bookId) throw new LibraryError("invalid", "The saved book does not match. Nothing was selected or written.");
  const matches = detail.chapters.filter((chapter) => chapter.id === chapterId);
  const chapter = matches[0];
  if (!chapter || matches.length !== 1) throw new LibraryError("invalid", "The saved chapter is not available. Nothing was selected or written.");
  return chapter;
}

/** Nonempty half-open UTF-16 span that does not split a surrogate pair. */
function bodySpan(content: string, start: number, end: number): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= content.length &&
    isScalarBoundary(content, start) && isScalarBoundary(content, end);
}

function sameAnchor(left: SavedSpan, right: SavedSpan): boolean {
  return left.kind === right.kind && left.bookId === right.bookId && left.chapterId === right.chapterId &&
    left.chapterVersion === right.chapterVersion && left.chapterHash === right.chapterHash &&
    left.startOffset === right.startOffset && left.endOffset === right.endOffset && left.excerpt === right.excerpt;
}

export type AnnotationHost = SidecarHost & Pick<GoalHost, "readSavedBook">;
