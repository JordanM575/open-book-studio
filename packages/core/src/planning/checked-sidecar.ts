import { z } from "zod";
import { bookSchema } from "../schema";
import { LibraryError } from "../library/errors";
import { toLibraryPath, libraryPathToArchivePath } from "../library/path";
import { bookFilePath, conflictPath, conflictsPath } from "../library/paths";
import type { CommitFileResult, FileExpectation, LibraryPath, LibraryPort, LibraryRuntime } from "../library/port";
import { assertSchemaVersion } from "../library/schema-guard";
import {
  bookIdSchema, checkBytes, decoder, encoder, hashSchema, increment, parseJson, RECOVERY_BYTES,
  serializeDocument, SIDECAR_BYTES, sourceSchema, validateDocument,
  type SidecarDocument, type SidecarSource
} from "./schema";

/** Supplied ONLY by the owning LibraryService. There is deliberately no opener or local queue. */
export interface SidecarHost {
  storage: Pick<LibraryPort, "readFile" | "stat" | "ensureDirectory">;
  runtime: LibraryRuntime;
  deviceId: string;
  /** The SAME queue used by chapter/book saves, trash and restore, including queued reads. */
  withBook<T>(bookId: string, work: () => Promise<T>): Promise<T>;
  /** Delegate to the existing service's journal-aware checked commit, never an unchecked writer. */
  commitFile(path: LibraryPath, bytes: Uint8Array, expected: Exclude<FileExpectation, { kind: "any" }>): Promise<CommitFileResult>;
}

export interface SidecarRead<T> {
  bookId: string;
  data: T | null;
  source: SidecarSource;
  baselineJson: string | null;
}
export const sidecarAttemptIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const sidecarAttemptSchema = z.strictObject({ requestId: sidecarAttemptIdSchema, publicationId: sidecarAttemptIdSchema });
export type SidecarAttempt = z.infer<typeof sidecarAttemptSchema>;
/** The handler issues a fresh publication identity even if a caller repeats its request token. */
export function newSidecarAttempt(requestId: string = globalThis.crypto.randomUUID()): SidecarAttempt {
  return sidecarAttemptSchema.parse({ requestId, publicationId: globalThis.crypto.randomUUID() });
}
export type SidecarSave<T> = (
  | { status: "saved" | "unchanged"; current: SidecarRead<T> }
  | { status: "conflict"; bookId: string; reason: "external-edit" | "missing-file"; savedAs: string; observed: SidecarSource;
      /** Exact complete recovery bytes verified by the commit, not an echoed request token. */
      preserved: { rawJson: string; hash: string } }) & { attempt?: SidecarAttempt };

/** Constructed only in the deterministic preparation stage, before any publication attempt. */
export class SidecarRefusalError extends LibraryError {
  readonly outcome = "refused";
  constructor(message: string) { super("invalid", message); }
}

/** An exception after publication is not proof that storage kept the old file. Never auto-replay. */
export class SidecarWriteError extends LibraryError {
  constructor(readonly outcome: "uncertain" | "not-kept", readonly phase: "active" | "recovery") {
    super("io", phase === "active"
      ? "The save outcome is uncertain. Keep the exact draft in the editor and reread storage before another save."
      : "No durable conflict copy could be verified; the draft is still only in the editor. Keep it and reread storage before another save.");
  }
}

export const envelopeFields = {
  bookId: bookIdSchema,
  source: sourceSchema,
  baselineJson: z.string().refine((value) => encoder.encode(value).byteLength <= SIDECAR_BYTES).nullable()
};

export function parseRequest<T extends { bookId: string; draft: unknown }>(schema: z.ZodType<T>, request: unknown): T {
  const result = schema.safeParse(request);
  if (!result.success) throw new LibraryError("invalid", "The save request is invalid or exceeds the field limits. Keep the draft; nothing was written.");
  // The scoped intent is the second bounded document; token/control keys are strictly validated.
  checkBytes(encoder.encode(JSON.stringify({ bookId: result.data.bookId, draft: result.data.draft })));
  return result.data;
}

export function sidecarPath(bookId: string, kind: "planning" | "goals" | "annotations"): LibraryPath {
  return toLibraryPath(["books", bookId, `${kind}.json`]);
}

export function sameSource(a: SidecarSource, b: SidecarSource): boolean {
  return a.kind === b.kind && a.revision === b.revision && (a.kind === "absent" || (b.kind === "sha256" && a.value === b.value));
}

/** The exact baseline hash commits its raw bytes; the receipt also binds the scoped typed intent. */
export function sidecarIntentBytes(request: { bookId: string; source: SidecarSource; draft: unknown }): Uint8Array {
  return encoder.encode(JSON.stringify({ bookId: request.bookId, source: request.source, draft: request.draft }));
}

/** The general book guard alone tolerates missing/malformed books: this leaf must not. */
export async function assertSidecarOwner(host: SidecarHost, bookId: string): Promise<void> {
  if (!bookIdSchema.safeParse(bookId).success) throw new LibraryError("invalid", "Invalid owning book ID.");
  const snapshot = await host.storage.readFile(bookFilePath(bookId));
  if (!snapshot) throw new LibraryError("not-found", "The owning book is unavailable. Nothing was written.");
  let raw: unknown;
  try { raw = JSON.parse(decoder.decode(snapshot.bytes)) as unknown; }
  catch { throw new LibraryError("format", "The owning book is unreadable. Nothing was written."); }
  assertSchemaVersion((raw as { schemaVersion?: unknown } | null)?.schemaVersion, "book.json");
  const parsed = bookSchema.safeParse(raw);
  if (!parsed.success) throw new LibraryError("format", "The owning book is invalid. Nothing was written.");
  if (parsed.data.id !== bookId) throw new LibraryError("invalid", "The actual book ID does not match its requested owner. Nothing was written.");
}

/** Internal checked policy, composed by leaf services; the host owns all scheduling/publication. */
export class CheckedSidecar<T extends SidecarDocument> {
  constructor(readonly host: SidecarHost, readonly kind: "planning" | "goals" | "annotations", readonly schema: z.ZodType<T>) {}

  async readCurrent(bookId: string): Promise<SidecarRead<T>> {
    const path = sidecarPath(bookId, this.kind);
    const stat = await this.host.storage.stat(path);
    if (stat && stat.size > SIDECAR_BYTES) throw new LibraryError("invalid", "The sidecar exceeds 2,500,000 UTF-8 bytes.");
    const snapshot = await this.host.storage.readFile(path);
    if (!snapshot) return { bookId, data: null, source: { kind: "absent", revision: 0 }, baselineJson: null };
    checkBytes(snapshot.bytes);
    const data = validateDocument(this.schema, parseJson(snapshot.bytes), bookId);
    if (!hashSchema.safeParse(snapshot.sha256).success || await this.host.runtime.sha256(snapshot.bytes) !== snapshot.sha256) {
      throw new LibraryError("io", "The sidecar read could not be verified.");
    }
    return { bookId, data, source: { kind: "sha256", value: snapshot.sha256, revision: data.revision }, baselineJson: decoder.decode(snapshot.bytes) };
  }

  read(bookId: string): Promise<SidecarRead<T>> {
    return this.host.withBook(bookId, async () => {
      await assertSidecarOwner(this.host, bookId);
      return this.readCurrent(bookId);
    });
  }

  async baseline(request: { bookId: string; source: SidecarSource; baselineJson: string | null }): Promise<T | null> {
    if (request.source.kind === "absent") {
      if (request.baselineJson !== null) throw new LibraryError("invalid", "An absent baseline cannot contain a document.");
      return null;
    }
    if (request.baselineJson === null) throw new LibraryError("invalid", "The original baseline document is required.");
    const bytes = checkBytes(encoder.encode(request.baselineJson));
    if (await this.host.runtime.sha256(bytes) !== request.source.value) throw new LibraryError("invalid", "The baseline hash does not match its exact bytes.");
    const data = validateDocument(this.schema, parseJson(bytes), request.bookId);
    if (data.revision !== request.source.revision) throw new LibraryError("invalid", "The baseline revision does not match.");
    return data;
  }

  save(
    request: { bookId: string; source: SidecarSource; baselineJson: string | null; draft: unknown },
    apply: (base: T | null) => { data: T; changed: boolean },
    attempt?: SidecarAttempt
  ): Promise<SidecarSave<T>> {
    const receipt = attempt ? { attempt: sidecarAttemptSchema.parse(attempt) } : {};
    return this.host.withBook(request.bookId, async () => {
      await assertSidecarOwner(this.host, request.bookId);
      const base = await this.baseline(request);
      const current = await this.readCurrent(request.bookId);
      let proposed: { data: T; changed: boolean };
      let bytes: Uint8Array;
      try {
        proposed = apply(base);
        if (proposed.changed) proposed.data = { ...proposed.data, revision: increment(base?.revision ?? 0) };
        validateDocument(this.schema, proposed.data, request.bookId);
        if (sameSource(request.source, current.source) && !proposed.changed) return { status: "unchanged", current, ...receipt };
        // Bound the complete draft even for stale requests, before any layout/journal writes.
        bytes = serializeDocument(proposed.data);
      } catch (error) {
        // Only this pure preparation stage proves zero active/recovery publication attempts.
        if (error instanceof LibraryError) throw new SidecarRefusalError(error.message);
        throw error;
      }
      if (!sameSource(request.source, current.source)) return this.preserve(request, bytes, current.source, receipt);
      await assertSidecarOwner(this.host, request.bookId);
      let result: CommitFileResult;
      try {
        result = await this.host.commitFile(sidecarPath(request.bookId, this.kind), bytes.slice(), expectation(request.source));
        if (result.status === "changed" && result.publication === "uncertain") throw new SidecarWriteError("uncertain", "active");
        if (result.status === "written" && !await this.verifies(bytes, result.snapshot)) {
          throw new SidecarWriteError("uncertain", "active");
        }
      } catch { throw new SidecarWriteError("uncertain", "active"); }
      if (result.status === "changed") {
        // Revalidate supported data/ownership rather than trusting an arbitrary conflict snapshot.
        const observed = await this.readCurrent(request.bookId);
        return this.preserve(request, bytes, observed.source, receipt);
      }
      return {
        status: "saved",
        ...receipt,
        current: { bookId: request.bookId, data: proposed.data, baselineJson: decoder.decode(bytes),
          source: { kind: "sha256", value: result.snapshot.sha256, revision: proposed.data.revision } }
      };
    });
  }

  private async verifies(bytes: Uint8Array, snapshot: { bytes: Uint8Array; sha256: string }): Promise<boolean> {
    return bytes.length === snapshot.bytes.length && bytes.every((byte, index) => byte === snapshot.bytes[index]) &&
      await this.host.runtime.sha256(bytes) === snapshot.sha256;
  }

  private async preserve(
    request: { bookId: string; source: SidecarSource; draft: unknown }, bytes: Uint8Array, observed: SidecarSource,
    receipt: { attempt?: SidecarAttempt }
  ): Promise<SidecarSave<T>> {
    const reason = observed.kind === "absent" && request.source.kind !== "absent" ? "missing-file" : "external-edit";
    const data = validateDocument(this.schema, parseJson(bytes), request.bookId);
    const requestHash = await this.host.runtime.sha256(sidecarIntentBytes(request));
    const copy = serializeDocument({ ...data, conflictMetadata: { reason, baseline: request.source, observed, requestHash, ...receipt } }, RECOVERY_BYTES);
    const device = this.host.deviceId;
    const stamp = this.host.runtime.now().replace(/[:.]/g, "-");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(device) || !/^[0-9TZ-]{1,100}$/.test(stamp)) {
      throw new SidecarWriteError("not-kept", "recovery");
    }
    try {
      await assertSidecarOwner(this.host, request.bookId);
      await this.host.storage.ensureDirectory(conflictsPath(request.bookId));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await assertSidecarOwner(this.host, request.bookId);
        const name = `${this.kind}.conflict-${reason}.${device}.${stamp}${attempt === 0 ? "" : `-${attempt + 1}`}.json`;
        const path = conflictPath(request.bookId, name);
        const result = await this.host.commitFile(path, copy.slice(), { kind: "absent" });
        if (result.status === "changed" && result.publication === "uncertain") throw new SidecarWriteError("uncertain", "recovery");
        if (result.status === "changed") continue;
        if (!await this.verifies(copy, result.snapshot)) throw new SidecarWriteError("uncertain", "recovery");
        return { status: "conflict", bookId: request.bookId, reason, savedAs: libraryPathToArchivePath(path), observed,
          ...receipt,
          preserved: { rawJson: decoder.decode(copy), hash: result.snapshot.sha256 } };
      }
      throw new SidecarWriteError("not-kept", "recovery");
    } catch (error) {
      if (error instanceof SidecarWriteError) throw error;
      throw new SidecarWriteError("uncertain", "recovery");
    }
  }
}

function expectation(source: SidecarSource): Exclude<FileExpectation, { kind: "any" }> {
  return source.kind === "absent" ? { kind: "absent" } : { kind: "sha256", value: source.value };
}
