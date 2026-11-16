import { z } from "zod";
import { LibraryError } from "../library/errors";
import { libraryPathToArchivePath, type LibraryPath } from "../library/path";
import { collectionsFilePath, rootConflictPath, rootConflictsPath } from "../library/paths";
import type { CommitFileResult, FileExpectation, LibraryPort, LibraryRuntime } from "../library/port";
import {
  bookIdSchema, checkBytes, decoder, encoder, hashSchema, increment, parseJson, RECOVERY_BYTES,
  revisionSchema, SIDECAR_BYTES, sourceSchema, type SidecarSource
} from "../planning/schema";
import {
  newSidecarAttempt, sidecarAttemptSchema, SidecarRefusalError, SidecarWriteError, type SidecarAttempt
} from "../planning/checked-sidecar";

/** Library-level queue. Not a book id, and not the book sidecar writer. */
export interface CollectionHost {
  storage: Pick<LibraryPort, "readFile" | "stat" | "ensureDirectory">;
  runtime: LibraryRuntime;
  deviceId: string;
  withCollections<T>(work: () => Promise<T>): Promise<T>;
  commitFile(path: LibraryPath, bytes: Uint8Array, expected: Exclude<FileExpectation, { kind: "any" }>): Promise<CommitFileResult>;
}

const collectionIdSchema = z.string().regex(/^col_[A-Za-z0-9-]{6,40}$/);
const displayName = z.string().refine((value) => value.length <= 200 && value.trim().length > 0 && value.trim().length <= 200);

export const collectionRecordSchema = z.looseObject({
  id: collectionIdSchema,
  revision: revisionSchema,
  name: displayName,
  archived: z.boolean(),
  bookIds: z.array(bookIdSchema)
}).superRefine((record, ctx) => {
  if (new Set(record.bookIds).size !== record.bookIds.length) {
    ctx.addIssue({ code: "custom", message: "A collection lists the same book more than once." });
  }
});
export type CollectionRecord = z.infer<typeof collectionRecordSchema>;

export const collectionsSchema = z.looseObject({
  schemaVersion: z.literal(1),
  revision: revisionSchema,
  collections: z.array(collectionRecordSchema)
}).superRefine((data, ctx) => {
  if (new Set(data.collections.map((record) => record.id)).size !== data.collections.length) {
    ctx.addIssue({ code: "custom", message: "Collection IDs must be unique." });
  }
});
export type CollectionsFile = z.infer<typeof collectionsSchema>;

const memberDraft = z.strictObject({
  kind: z.enum(["add-members", "remove-members"]),
  id: collectionIdSchema,
  bookIds: z.array(bookIdSchema)
});
export const collectionSaveSchema = z.strictObject({
  source: sourceSchema,
  baselineJson: z.string().refine((value) => encoder.encode(value).byteLength <= SIDECAR_BYTES).nullable(),
  draft: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("create"), name: displayName }),
    z.strictObject({ kind: z.literal("rename"), id: collectionIdSchema, name: displayName }),
    memberDraft,
    z.strictObject({ kind: z.literal("archive"), id: collectionIdSchema }),
    z.strictObject({ kind: z.literal("restore"), id: collectionIdSchema }),
    z.strictObject({ kind: z.literal("rename-and-restore"), id: collectionIdSchema, name: displayName })
  ])
});
export type CollectionSaveRequest = z.infer<typeof collectionSaveSchema>;
export type CollectionDraft = CollectionSaveRequest["draft"];

export interface CollectionRead {
  data: CollectionsFile | null;
  source: SidecarSource;
  baselineJson: string | null;
}
export type CollectionSave = (
  | { status: "saved" | "unchanged"; current: CollectionRead }
  | { status: "conflict"; reason: "external-edit" | "missing-file"; savedAs: string; observed: SidecarSource;
      preserved: { rawJson: string; hash: string } }) & { attempt?: SidecarAttempt };

/** Active uniqueness is NFC, then locale-independent lowercase of the trimmed display spelling. */
export function collectionNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

export function applyCollectionDraft(
  base: CollectionsFile | null,
  draft: CollectionDraft,
  newId: () => string
): { data: CollectionsFile; changed: boolean } {
  const data: CollectionsFile = base ?? { schemaVersion: 1, revision: 1, collections: [] };
  if (draft.kind === "create") {
    const name = draft.name.trim();
    if (activeNameTaken(data, name)) throw new LibraryError("invalid", "An active collection already uses this name. Nothing was written.");
    const id = newId();
    if (!collectionIdSchema.safeParse(id).success || data.collections.some((record) => record.id === id)) {
      throw new LibraryError("invalid", "The host could not assign a unique collection ID. Nothing was written.");
    }
    return { changed: true, data: { ...data, collections: [...data.collections, {
      id, revision: 1, name, archived: false, bookIds: []
    }] } };
  }
  const record = data.collections.find((entry) => entry.id === draft.id);
  if (!record) throw new LibraryError("not-found", "The collection is not in the original document. Editing cannot create it.");
  if (draft.kind === "add-members" || draft.kind === "remove-members") {
    if (record.archived) throw new LibraryError("invalid", "Restore this archived collection before changing its books. Nothing was written.");
    const present = new Set(record.bookIds);
    const incoming = [...new Set(draft.bookIds)];
    if (draft.kind === "add-members" && incoming.every((id) => present.has(id))) {
      return { data, changed: false };
    }
    const next = draft.kind === "add-members"
      ? [...record.bookIds, ...incoming.filter((id) => !present.has(id))].sort()
      : record.bookIds.filter((id) => !incoming.includes(id));
    if (next.length === record.bookIds.length && next.every((id, index) => id === record.bookIds[index])) {
      return { data, changed: false };
    }
    return { changed: true, data: replace(data, { ...record, bookIds: next, revision: increment(record.revision) }) };
  }
  if (draft.kind === "archive") {
    if (record.archived) return { data, changed: false };
    return { changed: true, data: replace(data, { ...record, archived: true, revision: increment(record.revision) }) };
  }
  if (draft.kind === "rename") {
    if (record.archived) throw new LibraryError("invalid", "Restore this archived collection before renaming it. Nothing was written.");
    const name = draft.name.trim();
    if (name === record.name) return { data, changed: false };
    if (activeNameTaken(data, name, record.id)) throw new LibraryError("invalid", "An active collection already uses this name. Nothing was written.");
    return { changed: true, data: replace(data, { ...record, name, revision: increment(record.revision) }) };
  }
  const name = draft.kind === "rename-and-restore" ? draft.name.trim() : record.name;
  if (!record.archived && name === record.name) return { data, changed: false };
  if (activeNameTaken(data, name, record.id)) {
    throw new LibraryError("invalid", "Restore needs a name no active collection uses. Nothing was written.");
  }
  const changed = record.archived || name !== record.name;
  return { changed, data: changed ? replace(data, { ...record, name, archived: false, revision: increment(record.revision) }) : data };
}

function activeNameTaken(data: CollectionsFile, name: string, exceptId?: string): boolean {
  const key = collectionNameKey(name);
  return data.collections.some((record) => !record.archived && record.id !== exceptId && collectionNameKey(record.name) === key);
}

function replace(data: CollectionsFile, record: CollectionRecord): CollectionsFile {
  return { ...data, collections: data.collections.map((entry) => entry.id === record.id ? record : entry) };
}

/** Checked library-root collections. Membership never moves or rewrites a book. */
export class CollectionService {
  constructor(private readonly host: CollectionHost) {}

  read(): Promise<CollectionRead> {
    return this.host.withCollections(() => this.readCurrent());
  }

  save(input: unknown, suppliedAttempt?: SidecarAttempt): Promise<CollectionSave> {
    const request = parseCollectionRequest(input);
    const attempt = suppliedAttempt ? sidecarAttemptSchema.parse(suppliedAttempt) : newSidecarAttempt();
    return this.host.withCollections(async () => {
      const base = await this.baseline(request);
      const current = await this.readCurrent();
      let proposed: { data: CollectionsFile; changed: boolean };
      let bytes: Uint8Array;
      try {
        proposed = applyCollectionDraft(base, request.draft, () => `col_${attempt.publicationId}`);
        if (proposed.changed) proposed.data = { ...proposed.data, revision: increment(base?.revision ?? 0) };
        validateCollections(proposed.data);
        if (sameSource(request.source, current.source) && !proposed.changed) return { status: "unchanged", current, attempt };
        bytes = serializeCollections(proposed.data);
      } catch (error) {
        if (error instanceof LibraryError) throw new SidecarRefusalError(error.message);
        throw error;
      }
      if (!sameSource(request.source, current.source)) return this.preserve(request, bytes, current.source, attempt);
      let result: CommitFileResult;
      try {
        result = await this.host.commitFile(collectionsFilePath(), bytes.slice(), expectation(request.source));
        if (result.status === "changed" && result.publication === "uncertain") throw new SidecarWriteError("uncertain", "active");
        if (result.status === "written" && !await this.verifies(bytes, result.snapshot)) throw new SidecarWriteError("uncertain", "active");
      } catch { throw new SidecarWriteError("uncertain", "active"); }
      if (result.status === "changed") {
        const observed = await this.readCurrent();
        return this.preserve(request, bytes, observed.source, attempt);
      }
      return {
        status: "saved", attempt,
        current: {
          data: proposed.data, baselineJson: decoder.decode(bytes),
          source: { kind: "sha256", value: result.snapshot.sha256, revision: proposed.data.revision }
        }
      };
    });
  }

  private async readCurrent(): Promise<CollectionRead> {
    const path = collectionsFilePath();
    const stat = await this.host.storage.stat(path);
    if (stat && stat.size > SIDECAR_BYTES) throw new LibraryError("invalid", "The sidecar exceeds 2,500,000 UTF-8 bytes.");
    const snapshot = await this.host.storage.readFile(path);
    if (!snapshot) return { data: null, source: { kind: "absent", revision: 0 }, baselineJson: null };
    checkBytes(snapshot.bytes);
    const data = validateCollections(parseJson(snapshot.bytes));
    if (!hashSchema.safeParse(snapshot.sha256).success || await this.host.runtime.sha256(snapshot.bytes) !== snapshot.sha256) {
      throw new LibraryError("io", "The sidecar read could not be verified.");
    }
    return { data, source: { kind: "sha256", value: snapshot.sha256, revision: data.revision }, baselineJson: decoder.decode(snapshot.bytes) };
  }

  private async baseline(request: CollectionSaveRequest): Promise<CollectionsFile | null> {
    if (request.source.kind === "absent") {
      if (request.baselineJson !== null) throw new LibraryError("invalid", "An absent baseline cannot contain a document.");
      return null;
    }
    if (request.baselineJson === null) throw new LibraryError("invalid", "The original baseline document is required.");
    const bytes = checkBytes(encoder.encode(request.baselineJson));
    if (await this.host.runtime.sha256(bytes) !== request.source.value) throw new LibraryError("invalid", "The baseline hash does not match its exact bytes.");
    const data = validateCollections(parseJson(bytes));
    if (data.revision !== request.source.revision) throw new LibraryError("invalid", "The baseline revision does not match.");
    return data;
  }

  private async preserve(
    request: CollectionSaveRequest, bytes: Uint8Array, observed: SidecarSource, attempt: SidecarAttempt
  ): Promise<CollectionSave> {
    const reason = observed.kind === "absent" && request.source.kind !== "absent" ? "missing-file" : "external-edit";
    const data = validateCollections(parseJson(bytes));
    const requestHash = await this.host.runtime.sha256(encoder.encode(JSON.stringify({ source: request.source, draft: request.draft })));
    const copy = serializeCollections(
      { ...data, conflictMetadata: { reason, baseline: request.source, observed, requestHash, attempt } },
      RECOVERY_BYTES
    );
    const device = this.host.deviceId;
    const stamp = this.host.runtime.now().replace(/[:.]/g, "-");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(device) || !/^[0-9TZ-]{1,100}$/.test(stamp)) {
      throw new SidecarWriteError("not-kept", "recovery");
    }
    try {
      await this.host.storage.ensureDirectory(rootConflictsPath());
      for (let index = 0; index < 100; index += 1) {
        const name = `collections.conflict-${reason}.${device}.${stamp}${index === 0 ? "" : `-${index + 1}`}.json`;
        const path = rootConflictPath(name);
        const result = await this.host.commitFile(path, copy.slice(), { kind: "absent" });
        if (result.status === "changed" && result.publication === "uncertain") throw new SidecarWriteError("uncertain", "recovery");
        if (result.status === "changed") continue;
        if (!await this.verifies(copy, result.snapshot)) throw new SidecarWriteError("uncertain", "recovery");
        return {
          status: "conflict", reason, savedAs: libraryPathToArchivePath(path), observed, attempt,
          preserved: { rawJson: decoder.decode(copy), hash: result.snapshot.sha256 }
        };
      }
      throw new SidecarWriteError("not-kept", "recovery");
    } catch (error) {
      if (error instanceof SidecarWriteError) throw error;
      throw new SidecarWriteError("uncertain", "recovery");
    }
  }

  private async verifies(bytes: Uint8Array, snapshot: { bytes: Uint8Array; sha256: string }): Promise<boolean> {
    return bytes.length === snapshot.bytes.length && bytes.every((byte, index) => byte === snapshot.bytes[index]) &&
      await this.host.runtime.sha256(bytes) === snapshot.sha256;
  }
}

function parseCollectionRequest(request: unknown): CollectionSaveRequest {
  const result = collectionSaveSchema.safeParse(request);
  if (!result.success) throw new LibraryError("invalid", "The save request is invalid or exceeds the field limits. Keep the draft; nothing was written.");
  checkBytes(encoder.encode(JSON.stringify({ draft: result.data.draft })));
  return result.data;
}

function serializeCollections(data: object, limit = SIDECAR_BYTES): Uint8Array {
  return checkBytes(encoder.encode(`${JSON.stringify(data, null, 2)}\n`), limit);
}

function validateCollections(raw: unknown): CollectionsFile {
  if (typeof raw === "object" && raw !== null && "schemaVersion" in raw &&
      typeof raw.schemaVersion === "number" && raw.schemaVersion > 1) {
    throw new LibraryError("newer-schema", "This sidecar needs a newer version of the studio. Nothing was written.");
  }
  if (typeof raw === "object" && raw !== null && "bookId" in raw) {
    throw new LibraryError("invalid", "Collections are a library record, not a book sidecar. Nothing was written.");
  }
  if (!collectionsSchema.safeParse(raw).success) throw new LibraryError("format", "The sidecar has unsupported or invalid fields. Nothing was written.");
  const data = raw as CollectionsFile;
  if (Object.hasOwn(data, "conflictMetadata")) throw new LibraryError("invalid", "A recovery copy cannot be used as an active sidecar.");
  return data;
}

function expectation(source: SidecarSource): Exclude<FileExpectation, { kind: "any" }> {
  return source.kind === "absent" ? { kind: "absent" } : { kind: "sha256", value: source.value };
}

function sameSource(a: SidecarSource, b: SidecarSource): boolean {
  return a.kind === b.kind && a.revision === b.revision && (a.kind === "absent" || (b.kind === "sha256" && a.value === b.value));
}
