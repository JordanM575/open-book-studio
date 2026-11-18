import { LibraryPortError } from "../library/errors";
import { sameValue } from "../library/book-merge";
import {
  libraryPathFromArchivePath,
  libraryPathToArchivePath,
  toLibraryFilePath,
  type LibraryPath
} from "../library/path";
import { conflictPath, conflictsPath, threadsPath, threadsTrashPath } from "../library/paths";
import type {
  CommitFileResult,
  FileExpectation,
  LibraryFileSnapshot,
  LibraryPort,
  LibraryRuntime,
  LibraryWriteHost
} from "../library/port";
import { assertBookWritable } from "../library/schema-guard";
import { noteMovedPrefix, noteRemovedFiles, noteWrittenFiles } from "../sync/journal";
import {
  agentThreadSchema,
  lastMessageText,
  type AgentApprovalStatus,
  type AgentMessage,
  type AgentPlan,
  type AgentThread
} from "./messages";
import {
  AGENT_PLAN_LIMITS,
  applyAgentPlanEvent,
  refreshAgentPlanProposal,
  type AgentPlanEvent,
  type AgentPlanRefusal,
  type AgentPlanStatus
} from "./plan-state";
import {
  buildThreadDocument,
  readThreadDocument,
  ThreadDocumentError,
  THREAD_DOCUMENT_MAX_BYTES,
  type ThreadDocument
} from "./thread-document";

export type ThreadStoreErrorCode =
  | "invalid-id"
  | "not-found"
  | "exists"
  | "missing-base"
  | "corrupt"
  | "plan-state"
  | "conflict"
  | "uncertain"
  | "newer"
  | "unsupported"
  | "too-large"
  | "io";

export class ThreadStoreError extends Error {
  constructor(
    readonly code: ThreadStoreErrorCode,
    message: string,
    /** Library-relative path of the kept copy, when the failure preserved the author's version. */
    readonly savedAs?: string
  ) {
    super(message);
    this.name = "ThreadStoreError";
  }
}

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export type ThreadTrashResult = { status: "trashed"; trashedAt: string } | { status: "missing" };

/** The caller-supplied part of a new proposal. The store owns status, revision and timestamps. */
export interface NewAgentPlan {
  id: string;
  purpose: string;
  steps: readonly string[];
  parent: { messageId: string; turnId: string };
  guidance?: string;
}

const TERMINAL_PLAN_STATUSES: ReadonlySet<AgentPlanStatus> = new Set<AgentPlanStatus>([
  "completed",
  "cancelled",
  "failed",
  "expired"
]);

const PLAN_REFUSAL_MESSAGES: Record<AgentPlanRefusal, string> = {
  "terminal-plan": "That plan has finished and cannot change. Nothing was written.",
  "wrong-status": "That plan is not in a state that allows this change. Nothing was written.",
  "stale-revision": "The plan changed since this update was prepared. Nothing was written.",
  "step-out-of-range": "That plan step does not exist. Nothing was written.",
  "step-order": "Plan steps must finish in order. Nothing was written.",
  "step-already-in-progress": "Another plan step is already in progress. Nothing was written.",
  "step-backward": "A finished plan step cannot change. Nothing was written.",
  "no-completed-step": "A completed plan needs at least one completed step. Nothing was written.",
  "invalid-revision": "That plan revision is not valid. Nothing was written.",
  "invalid-guidance": "That plan guidance is blank or too long. Nothing was written."
};

/** Validate a plan-bearing thread at the store boundary so a bad change is `plan-state`, not a raw error. */
function assertPlanDocument(thread: AgentThread): AgentThread {
  const parsed = agentThreadSchema.safeParse(thread);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") ?? "plans";
    throw new ThreadStoreError(
      "plan-state",
      `That plan could not be stored (${path}). The file was left untouched.`
    );
  }
  return parsed.data;
}

/** Terminal plans are retained and cannot change; a save may never remove one. */
function assertPlanHistory(current: AgentThread, next: AgentThread): void {
  for (const plan of current.plans) {
    const kept = next.plans.find((entry) => entry.id === plan.id);
    if (!kept) {
      throw new ThreadStoreError(
        "plan-state",
        "A plan cannot be removed from a conversation. Nothing was written."
      );
    }
    if (TERMINAL_PLAN_STATUSES.has(plan.status) && !sameValue(plan, kept)) {
      throw new ThreadStoreError("plan-state", "A finished plan cannot change. Nothing was written.");
    }
  }
}

export interface ThreadStoreOptions {
  /** Test/forward-compatible override; never raises above the D-113 ceiling. */
  maxBytes?: number;
}

/**
 * Conversations are files beside the manuscript. Every write joins the Library's per-book queue and
 * takes the library's journal-aware checked commit: the save names the exact raw hash it started from,
 * verifies the bytes the adapter published and keeps the author's version in `conflicts/` when the
 * file moved underneath it. There is no second queue and no unchecked overwrite.
 *
 * A store opened without a host (pure core tests, a future non-Library host) still commits through the
 * same `LibraryPort` primitive, but production construction in the desktop Library always passes the
 * service's `writeHost`.
 */
export class ThreadStore {
  private notedDeviceId: string | null = null;
  /** The exact raw hash this process last read or wrote, so a later save is checked against its base. */
  private readonly hashes = new Map<string, string>();

  constructor(
    private readonly storage: LibraryPort,
    private readonly runtime: LibraryRuntime,
    private readonly host?: LibraryWriteHost,
    private readonly options: ThreadStoreOptions = {}
  ) {}

  private get maxBytes(): number {
    return Math.min(this.options.maxBytes ?? THREAD_DOCUMENT_MAX_BYTES, THREAD_DOCUMENT_MAX_BYTES);
  }

  async create(bookId: string, title?: string, messages: AgentMessage[] = []): Promise<AgentThread> {
    assertBookId(bookId);
    const now = this.runtime.now();
    const thread: AgentThread = {
      schemaVersion: 1,
      id: this.runtime.newId("thread"),
      bookId,
      title: cleanTitle(title),
      createdAt: now,
      updatedAt: now,
      messages,
      plans: [],
      checkpointTurns: []
    };
    return this.withBook(bookId, () => this.writeDocument(thread, "create"));
  }

  /**
   * Save a conversation from an exact copy this caller read. The `baseHash` must come from that
   * read (`readSnapshot`), so a store that never read the file — or a caller holding an older copy —
   * cannot quietly overwrite a newer or externally edited conversation. The commit is checked against
   * the exact raw bytes, not a version number.
   */
  async save(thread: AgentThread, options: { baseHash: string }): Promise<AgentThread> {
    const parsed = agentThreadSchema.parse(thread);
    const baseHash = options?.baseHash;
    if (typeof baseHash !== "string" || !/^[0-9a-f]{64}$/.test(baseHash)) {
      throw new ThreadStoreError("missing-base",
        "Save a conversation from the copy you read, so another edit is noticed instead of overwritten.");
    }
    return this.withBook(parsed.bookId, async () => {
      const current = await this.readDocument(parsed.bookId, parsed.id);
      return this.writeDocument(parsed, "save", baseHash, current);
    });
  }

  async read(bookId: string, threadId: string): Promise<AgentThread | null> {
    const document = await this.readDocument(bookId, threadId);
    return document?.thread ?? null;
  }

  /** The conversation and the exact raw hash a later `save` must present as its base. */
  async readSnapshot(bookId: string, threadId: string): Promise<{ thread: AgentThread; baseHash: string } | null> {
    const document = await this.readDocument(bookId, threadId);
    return document ? { thread: document.thread, baseHash: document.sha256 } : null;
  }

  /** Newest first. A corrupt, newer or unsupported file is skipped here; `read` reports it when opened. */
  async list(bookId: string): Promise<ThreadSummary[]> {
    assertBookId(bookId);
    const directory = threadsPath(bookId);
    const summaries: ThreadSummary[] = [];
    for (const entry of await this.storage.listDirectory(directory)) {
      if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
      try {
        const path = toLibraryFilePath([...directory, entry.name]);
        const snapshot = await this.storage.readFile(path);
        if (!snapshot) continue;
        const document = readThreadDocument({
          bytes: snapshot.bytes,
          sha256: snapshot.sha256,
          maxBytes: this.maxBytes
        });
        if (document.thread.bookId !== bookId) continue;
        summaries.push(summarize(document.thread));
      } catch {
        // A half-written, foreign, newer or unsupported file is not a conversation to rewrite or hide.
      }
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** Add a checkpoint turn through the checked mutate path, never a blind whole-document save. */
  async addCheckpointTurn(bookId: string, threadId: string, turnId: string): Promise<AgentThread> {
    return this.mutate(bookId, threadId, (thread) => thread.checkpointTurns.includes(turnId)
      ? thread
      : { ...thread, checkpointTurns: [...thread.checkpointTurns, turnId] });
  }

  async appendMessage(bookId: string, threadId: string, message: AgentMessage): Promise<AgentThread> {
    return this.mutate(bookId, threadId, (thread) => ({
      ...thread,
      messages: [...thread.messages, message]
    }));
  }

  /**
   * Write the assistant message for a turn, replacing it when the same id is already stored. A turn
   * that pauses for approval writes once at the pause and again when it finishes, so the conversation
   * keeps one message per turn rather than a partial copy beside the final one.
   */
  async upsertMessage(bookId: string, threadId: string, message: AgentMessage): Promise<AgentThread> {
    return this.mutate(bookId, threadId, (thread) => {
      const index = thread.messages.findIndex((entry) => entry.id === message.id);
      const messages =
        index >= 0
          ? thread.messages.map((entry, position) =>
              position === index ? carryMessageExtras(entry, message) : entry
            )
          : [...thread.messages, message];
      return { ...thread, messages };
    });
  }

  /**
   * Append a proposal. The assistant proposal message must already be stored: a plan never exists
   * before its parent turn. One non-terminal plan at a time; terminal plans are retained.
   */
  async addPlan(bookId: string, threadId: string, input: NewAgentPlan): Promise<AgentThread> {
    return this.mutate(bookId, threadId, (thread) => {
      if (thread.plans.some((plan) => !TERMINAL_PLAN_STATUSES.has(plan.status))) {
        throw new ThreadStoreError(
          "plan-state",
          "Finish or cancel the current plan before proposing another."
        );
      }
      if (thread.plans.some((plan) => plan.id === input.id)) {
        throw new ThreadStoreError(
          "plan-state",
          "A plan with that id is already in this conversation. Nothing was written."
        );
      }
      if (thread.plans.length >= AGENT_PLAN_LIMITS.plansPerThread) {
        throw new ThreadStoreError(
          "plan-state",
          `This conversation already has ${AGENT_PLAN_LIMITS.plansPerThread} plans. Nothing was written.`
        );
      }
      const now = this.runtime.now();
      const guidance =
        typeof input.guidance === "string" && input.guidance.trim().length > 0
          ? input.guidance
          : undefined;
      const plan: AgentPlan = {
        id: input.id,
        mode: "edit",
        status: "proposed",
        purpose: input.purpose,
        steps: input.steps.map((text) => ({ text, state: "pending" as const })),
        revision: 1,
        ...(guidance !== undefined ? { guidance } : {}),
        parent: { messageId: input.parent.messageId, turnId: input.parent.turnId },
        createdAt: now,
        updatedAt: now
      };
      return assertPlanDocument({ ...thread, plans: [...thread.plans, plan] });
    });
  }

  /**
   * Apply one lifecycle event. A refusal is `plan-state` and writes nothing; an unchanged event
   * keeps the stored bytes and timestamp. The caller creates a turn only on `applied`.
   */
  async applyPlanEvent(
    bookId: string,
    threadId: string,
    planId: string,
    event: AgentPlanEvent
  ): Promise<{ thread: AgentThread; outcome: "applied" | "unchanged" }> {
    let outcome: "applied" | "unchanged" = "unchanged";
    const thread = await this.mutate(
      bookId,
      threadId,
      (current) => {
        const index = current.plans.findIndex((plan) => plan.id === planId);
        if (index < 0) {
          throw new ThreadStoreError(
            "plan-state",
            "That plan is not in this conversation. Nothing was written."
          );
        }
        const result = applyAgentPlanEvent(current.plans[index]!, event, this.runtime.now());
        if (result.outcome === "refused") {
          throw new ThreadStoreError("plan-state", PLAN_REFUSAL_MESSAGES[result.reason]);
        }
        if (result.outcome === "unchanged") return null;
        const plans = current.plans.map((plan, position) =>
          position === index ? result.plan : plan
        );
        outcome = "applied";
        return assertPlanDocument({ ...current, plans });
      },
      { allowNoChange: true }
    );
    return { thread, outcome };
  }

  /** T012's guidance refresh: a proposed plan's next revision, with the previous array kept. */
  async refreshPlanProposal(
    bookId: string,
    threadId: string,
    planId: string,
    input: { revision: number; guidance?: string }
  ): Promise<AgentThread> {
    return this.mutate(
      bookId,
      threadId,
      (current) => {
        const index = current.plans.findIndex((plan) => plan.id === planId);
        if (index < 0) {
          throw new ThreadStoreError(
            "plan-state",
            "That plan is not in this conversation. Nothing was written."
          );
        }
        const result = refreshAgentPlanProposal(current.plans[index]!, input, this.runtime.now());
        if (result.outcome === "refused") {
          throw new ThreadStoreError("plan-state", PLAN_REFUSAL_MESSAGES[result.reason]);
        }
        if (result.outcome === "unchanged") return null;
        const plans = current.plans.map((plan, position) =>
          position === index ? result.plan : plan
        );
        return assertPlanDocument({ ...current, plans });
      },
      { allowNoChange: true }
    );
  }

  /** Record the author's answer on a stored approval. Returns null when the part is not there. */
  async updateApproval(
    bookId: string,
    threadId: string,
    messageId: string,
    approvalId: string,
    status: AgentApprovalStatus,
    resolvedAt: string = this.runtime.now()
  ): Promise<AgentThread | null> {
    let found = false;
    const saved = await this.mutate(
      bookId,
      threadId,
      (thread) => {
        const message = thread.messages.find((entry) => entry.id === messageId);
        if (!message) return null;
        let changed = false;
        const parts = message.parts.map((part) => {
          if (part.type !== "approval" || part.approvalId !== approvalId) return part;
          changed = true;
          return { ...part, status, resolvedAt };
        });
        if (!changed) return null;
        found = true;
        return {
          ...thread,
          messages: thread.messages.map((entry) => (entry.id === messageId ? { ...message, parts } : entry))
        };
      },
      { allowNoChange: true }
    );
    if (!found) return null;
    return saved;
  }

  async rename(bookId: string, threadId: string, title: string): Promise<AgentThread> {
    return this.mutate(bookId, threadId, (thread) => ({ ...thread, title: cleanTitle(title) }));
  }

  /** Copy a conversation up to and including one assistant turn into a new thread. */
  async fork(bookId: string, threadId: string, turnId: string): Promise<AgentThread> {
    const source = await this.read(bookId, threadId);
    if (!source) throw new ThreadStoreError("not-found", "That conversation no longer exists.");
    const index = source.messages.findIndex(
      (message) => message.role === "assistant" && message.turnId === turnId
    );
    if (index < 0) {
      throw new ThreadStoreError("not-found", "That turn is no longer in the conversation.");
    }
    const messages = source.messages.slice(0, index + 1);
    const branch = await this.create(bookId, `${source.title} (branch)`, messages);
    const keptTurns = new Set(messages.flatMap((message) => (message.turnId ? [message.turnId] : [])));
    // Undo takes the newest checkpoint first. A branch that leaves the newest turn out could only
    // offer an older turn's undo while undoing the newer one, so it keeps none.
    const newest = source.checkpointTurns.at(-1);
    return this.mutate(bookId, branch.id, (thread) => ({
      ...thread,
      checkpointTurns: newest !== undefined && keptTurns.has(newest) ? source.checkpointTurns : []
    }));
  }

  /**
   * Forget a turn's checkpoint once undo has used it, in every conversation of the book that names
   * it (a branch can name its source's turns), so no reopened conversation offers the same undo
   * twice. Oldest first, so the conversations it touches keep their order in the list.
   */
  async forgetCheckpointTurn(bookId: string, turnId: string): Promise<void> {
    for (const summary of (await this.list(bookId)).reverse()) {
      const thread = await this.read(bookId, summary.id);
      if (!thread?.checkpointTurns.includes(turnId)) continue;
      await this.mutate(bookId, thread.id, (current) => ({
        ...current,
        checkpointTurns: current.checkpointTurns.filter((turn) => turn !== turnId)
      }));
    }
  }

  /**
   * Move a conversation file to this book's recoverable trash. The source must exist and the chosen
   * destination must be free; a collision gets the next suffix rather than overwriting. Nothing is
   * unlinked, and a missing source is reported as such rather than treated as success.
   */
  async remove(bookId: string, threadId: string): Promise<ThreadTrashResult> {
    assertBookId(bookId);
    assertThreadId(threadId);
    return this.withBook(bookId, async () => {
      await assertBookWritable(this.storage, bookId);
      const source = this.filePath(bookId, threadId);
      const snapshot = await this.storage.readFile(source);
      if (!snapshot) {
        this.hashes.delete(threadKey(bookId, threadId));
        return { status: "missing" };
      }
      await this.storage.ensureDirectory(threadsTrashPath(bookId));
      const stamp = this.stamp();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
        const destination = toLibraryFilePath([
          ...threadsTrashPath(bookId),
          `${stamp}-${threadId}${suffix}.json`
        ]);
        // Checked before the move: a file already at the destination is a different deletion.
        if (await this.storage.readFile(destination)) continue;
        try {
          await this.moveFile(source, destination);
        } catch (error) {
          if (error instanceof LibraryPortError && error.code === "already-exists") continue;
          throw error;
        }
        await this.noteMoved(source, destination);
        this.hashes.delete(threadKey(bookId, threadId));
        return { status: "trashed", trashedAt: libraryPathToArchivePath(destination) };
      }
      throw new ThreadStoreError(
        "io",
        "Could not find a free name in the conversation trash. Nothing was deleted."
      );
    });
  }

  /**
   * Move the very file `remove` trashed back to `threads/<threadId>.json`. The source must be a
   * conversation in this book's trash, the destination must be absent, and the file must still name
   * this book and conversation. Nothing is migrated or rewritten by a restore.
   */
  async restore(bookId: string, threadId: string, trashedAt: string): Promise<AgentThread> {
    assertBookId(bookId);
    assertThreadId(threadId);
    return this.withBook(bookId, async () => {
      await assertBookWritable(this.storage, bookId);
      const source = trashedThreadPath(bookId, trashedAt);
      const destination = this.filePath(bookId, threadId);
      if (await this.storage.readFile(destination)) {
        throw new ThreadStoreError("exists", "That conversation is already in the book. Nothing was moved.");
      }
      const snapshot = await this.storage.readFile(source);
      if (!snapshot) throw new ThreadStoreError("not-found", "That conversation is no longer in the trash.");
      const document = await this.readDocumentFrom(snapshot, bookId, threadId);
      try {
        await this.moveFile(source, destination);
      } catch (error) {
        if (error instanceof LibraryPortError && error.code === "already-exists") {
          throw new ThreadStoreError("exists", "That conversation is already in the book. Nothing was moved.");
        }
        throw error;
      }
      await this.noteMoved(source, destination);
      this.hashes.set(threadKey(bookId, threadId), document.sha256);
      return document.thread;
    });
  }

  private async mutate(
    bookId: string,
    threadId: string,
    change: (thread: AgentThread) => AgentThread | null,
    options: { allowNoChange?: boolean } = {}
  ): Promise<AgentThread> {
    assertBookId(bookId);
    assertThreadId(threadId);
    return this.withBook(bookId, async () => {
      const current = await this.readDocument(bookId, threadId);
      if (!current) throw new ThreadStoreError("not-found", "That conversation no longer exists.");
      const next = change(current.thread);
      if (!next) {
        if (options.allowNoChange) return current.thread;
        throw new ThreadStoreError("corrupt", "That conversation could not be updated. The file was left untouched.");
      }
      return this.writeDocument(next, "save", current.sha256, current);
    });
  }

  private async writeDocument(
    thread: AgentThread,
    mode: "create" | "save",
    baseHash?: string,
    currentInput?: ThreadDocument | null
  ): Promise<AgentThread> {
    const parsed = agentThreadSchema.parse(thread);
    const path = this.filePath(parsed.bookId, parsed.id);
    const key = threadKey(parsed.bookId, parsed.id);
    const current = currentInput === undefined ? await this.readDocument(parsed.bookId, parsed.id) : currentInput;

    if (mode === "create") {
      if (current) throw new ThreadStoreError("exists", "That conversation already exists.");
    } else {
      if (!current) {
        if (baseHash) return this.keepConflict(parsed, "missing-file");
        throw new ThreadStoreError("not-found", "That conversation no longer exists.");
      }
      if (baseHash && baseHash !== current.sha256) return this.keepConflict(parsed, "external-edit");
    }

    // Completed, cancelled, failed and expired plans are history: a whole-document save may add a
    // plan or change a live one, but never drop a plan or rewrite a terminal one.
    if (mode === "save" && current) assertPlanHistory(current.thread, parsed);

    // A book another device upgraded to a newer schema gets no new conversation file either.
    await assertBookWritable(this.storage, parsed.bookId);
    const built = buildThreadDocument(
      mode === "save" ? current : null,
      parsed,
      this.runtime.now(),
      this.maxBytes
    );
    if (mode === "save" && built.unchanged && current) {
      this.hashes.set(key, current.sha256);
      return current.thread;
    }

    const expected: FileExpectation = current ? { kind: "sha256", value: current.sha256 } : { kind: "absent" };
    const result = await this.commit(path, built.bytes, expected);
    if (result.status === "changed") {
      if (result.publication === "uncertain") {
        return this.uncertain(parsed, built.bytes, "publication");
      }
      if (mode === "create" && result.current) {
        throw new ThreadStoreError("exists", "That conversation already exists. Nothing was replaced.");
      }
      // The reason comes from what is actually on disk now, not from what the pre-commit read saw.
      return this.keepConflict(parsed, result.current ? "external-edit" : "missing-file");
    }

    const verified = await this.verify(result, built.bytes);
    if (!verified) return this.uncertain(parsed, built.bytes, "readback");
    this.hashes.set(key, result.snapshot.sha256);
    if (!this.host) {
      await this.noteFiles({ written: [libraryPathToArchivePath(path)], removed: [] });
    }
    return agentThreadSchema.parse(built.raw);
  }

  /** Keep the caller's whole intended document beside the active file and report where it went. */
  private async keepConflict(
    thread: AgentThread,
    reason: "external-edit" | "missing-file"
  ): Promise<never> {
    const built = buildThreadDocument(null, thread, this.runtime.now(), this.maxBytes);
    const savedAs = await this.writeConflictCopy(thread.bookId, thread.id, built.bytes, reason);
    throw new ThreadStoreError(
      "conflict",
      "That conversation changed since it was read. Your version was kept as a copy; nothing was overwritten.",
      savedAs
    );
  }

  /**
   * The adapter published but the exact readback differed, or it reported an uncertain publication.
   * Never report success; preserve the intended bytes and say the outcome is uncertain.
   */
  private async uncertain(thread: AgentThread, bytes: Uint8Array, cause: "readback" | "publication"): Promise<never> {
    let savedAs: string | undefined;
    try {
      savedAs = await this.writeConflictCopy(thread.bookId, thread.id, bytes, "external-edit");
    } catch {
      // The copy is best-effort here; the uncertain outcome still must be reported.
    }
    throw new ThreadStoreError(
      "uncertain",
      cause === "publication"
        ? "The conversation file may have been published, but the adapter could not confirm it. Check the conversation and the kept copy before retrying."
        : "The conversation file was written but did not read back exactly. Check the conversation and the kept copy before retrying.",
      savedAs
    );
  }

  private async writeConflictCopy(
    bookId: string,
    threadId: string,
    bytes: Uint8Array,
    reason: "external-edit" | "missing-file"
  ): Promise<string> {
    await this.ensureDirectory(conflictsPath(bookId));
    const deviceId = await this.deviceId();
    const stamp = this.runtime.now().replace(/[:.]/g, "-");
    const base = `${threadId}.conflict-${reason}.${deviceId}.${stamp}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const path = conflictPath(bookId, `${base}${suffix}.json`);
      const result = await this.commit(path, bytes, { kind: "absent" });
      if (result.status === "written") {
        if (!(await this.verify(result, bytes))) {
          throw new ThreadStoreError("uncertain", "The kept conversation copy could not be verified. Keep your version and try again.");
        }
        if (!this.host) {
          await this.noteFiles({ written: [libraryPathToArchivePath(path)], removed: [] });
        }
        return libraryPathToArchivePath(path);
      }
    }
    throw new ThreadStoreError("io", "Could not keep a copy of your conversation. Nothing was overwritten.");
  }

  private async verify(result: Extract<CommitFileResult, { status: "written" }>, bytes: Uint8Array): Promise<boolean> {
    if (!sameBytes(result.snapshot.bytes, bytes)) return false;
    return result.snapshot.sha256 === (await this.runtime.sha256(bytes));
  }

  private async readDocument(bookId: string, threadId: string): Promise<ThreadDocument | null> {
    const path = this.filePath(bookId, threadId);
    const snapshot = await this.storage.readFile(path);
    if (!snapshot) return null;
    const document = await this.readDocumentFrom(snapshot, bookId, threadId);
    this.hashes.set(threadKey(bookId, threadId), document.sha256);
    return document;
  }

  private async readDocumentFrom(
    snapshot: LibraryFileSnapshot,
    bookId: string,
    threadId: string
  ): Promise<ThreadDocument> {
    try {
      const document = readThreadDocument({
        bytes: snapshot.bytes,
        sha256: snapshot.sha256,
        maxBytes: this.maxBytes
      });
      if (document.thread.bookId !== bookId || document.thread.id !== threadId) {
        throw new ThreadStoreError("corrupt", "That file belongs to a different conversation.");
      }
      return document;
    } catch (error) {
      if (error instanceof ThreadStoreError) throw error;
      if (error instanceof ThreadDocumentError) throw new ThreadStoreError(error.code, error.message);
      throw error;
    }
  }

  private withBook<T>(bookId: string, work: () => Promise<T>): Promise<T> {
    if (this.host) return this.host.withBook(bookId, work);
    return work();
  }

  private commit(path: LibraryPath, bytes: Uint8Array, expected: FileExpectation): Promise<CommitFileResult> {
    return this.host ? this.host.commitFile(path, bytes, expected) : this.storage.commitFile(path, bytes, expected);
  }

  private moveFile(from: LibraryPath, to: LibraryPath): Promise<void> {
    return this.host ? this.host.moveFile(from, to) : this.storage.moveFile(from, to);
  }

  private ensureDirectory(path: LibraryPath): Promise<void> {
    return this.storage.ensureDirectory(path);
  }

  /**
   * Fold this store's writes into the sync baseline so the next drift scan reads them as local.
   * Best-effort: the device id resolves lazily and a note failure never fails the write.
   */
  private async noteFiles(input: { written: string[]; removed: string[] }): Promise<void> {
    try {
      const deviceId = await this.deviceId();
      const now = this.runtime.now();
      await noteWrittenFiles({ storage: this.storage, deviceId, paths: input.written, now });
      await noteRemovedFiles({ storage: this.storage, deviceId, paths: input.removed, now });
    } catch {
      // Detection degrades to a reviewable report.
    }
  }

  private async noteMoved(from: LibraryPath, to: LibraryPath): Promise<void> {
    try {
      const deviceId = await this.deviceId();
      await noteMovedPrefix({
        storage: this.storage,
        deviceId,
        from: libraryPathToArchivePath(from),
        to: libraryPathToArchivePath(to),
        now: this.runtime.now()
      });
    } catch {
      // Detection degrades to a reviewable report.
    }
  }

  private async deviceId(): Promise<string> {
    this.notedDeviceId ??= (await this.storage.deviceInfo()).id;
    return this.notedDeviceId;
  }

  private stamp(): string {
    const millis = Date.parse(this.runtime.now());
    return Number.isFinite(millis) ? millis.toString(36) : this.runtime.now().replace(/\D/g, "").slice(-10);
  }

  private filePath(bookId: string, threadId: string): LibraryPath {
    assertBookId(bookId);
    assertThreadId(threadId);
    return toLibraryFilePath([...threadsPath(bookId), `${threadId}.json`]);
  }
}

function threadKey(bookId: string, threadId: string): string {
  return `${bookId}/${threadId}`;
}

/** Fields this build reads and writes on a message or part. Everything else is supported unknown data. */
/**
 * Deep carry for replacement: every field the new value does not name is kept from the previous
 * message, at any depth (including unknown members inside `model`, `usage`, `context` and a part).
 */
function carryUnknown(previous: unknown, next: unknown): unknown {
  if (!next || typeof next !== "object" || Array.isArray(next)) return next;
  const old = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as Record<string, unknown>
    : null;
  if (!old) return next;
  const merged: Record<string, unknown> = { ...(next as Record<string, unknown>) };
  for (const [key, value] of Object.entries(old)) {
    // Define rather than assign: a `__proto__` key must become an own data property, not the
    // inherited prototype setter, or the merged object stops being plain data.
    Object.defineProperty(merged, key, {
      value: Object.hasOwn(merged, key) ? carryUnknown(value, merged[key]) : value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return merged;
}

function carryMessageExtras(previous: AgentMessage, next: AgentMessage): AgentMessage {
  const parts = next.parts.map((part, index) => {
    const old =
      previous.parts.find(
        (entry) =>
          (part.type === "tool-call" || part.type === "tool-result") &&
          entry.type === part.type &&
          entry.id === part.id
      ) ??
      previous.parts.find(
        (entry) => part.type === "approval" && entry.type === "approval" && entry.approvalId === part.approvalId
      ) ??
      previous.parts[index];
    if (!old || old.type !== part.type) return part;
    return carryUnknown(old, part) as typeof part;
  });
  return carryUnknown(previous, { ...next, parts }) as AgentMessage;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** The trash file `remove` moved a conversation to, from the path it returned. */
function trashedThreadPath(bookId: string, trashedAt: string): LibraryPath {
  const refused = () =>
    new ThreadStoreError("invalid-id", "That is not a conversation in this book's trash. Nothing was moved.");
  let path: LibraryPath;
  try {
    path = libraryPathFromArchivePath(trashedAt);
  } catch {
    throw refused();
  }
  const trash = threadsTrashPath(bookId);
  const inTrash = path.length === trash.length + 1 && trash.every((segment, index) => path[index] === segment);
  if (!inTrash || !path[trash.length]?.endsWith(".json")) throw refused();
  return path;
}

function summarize(thread: AgentThread): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messageCount: thread.messages.length,
    preview: truncate(lastMessageText(thread).replace(/\s+/g, " ").trim(), 140)
  };
}

function cleanTitle(title: string | undefined): string {
  const clean = title?.trim().replace(/\s+/g, " ") ?? "";
  return clean ? clean.slice(0, 200) : "New conversation";
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function assertBookId(value: string): void {
  if (!/^book_[A-Za-z0-9-]{6,}$/.test(value)) {
    throw new ThreadStoreError("invalid-id", "That book id is not valid.");
  }
}

function assertThreadId(value: string): void {
  if (!/^thread_[A-Za-z0-9-]{6,}$/.test(value)) {
    throw new ThreadStoreError("invalid-id", "That conversation id is not valid.");
  }
}
