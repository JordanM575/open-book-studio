import type { BookDetail } from "@ai-book-studio/core/schema";
import type { Catalogue } from "@ai-book-studio/core/providers/models";
import type { ConnectionSummary, StoredCredential } from "@ai-book-studio/core/providers/types";
import { ProviderError } from "@ai-book-studio/core/providers/types";
import { ReviewContractError } from "@ai-book-studio/core/review/contract";
import {
  buildReviewEnvelope, checkReviewStart, reviewResourceUsage, type CurrentSource, type ReviewEnvelope
} from "@ai-book-studio/core/review/envelope";
import { buildReaderRun } from "@ai-book-studio/core/review/findings";
import { deriveReaderHostFacts, type ReaderReviewConnection, type ReaderReviewPriceFacts, type ReaderReviewTerms } from "@ai-book-studio/core/review/host-facts";
import { builtinReaderProfile } from "@ai-book-studio/core/review/profiles";
import type {
  ReaderReviewCancelPrepareRequest, ReaderReviewCancelResult, ReaderReviewFailure, ReaderReviewPrepareRequest,
  ReaderReviewPrepareResult, ReaderReviewRefusal, ReaderReviewService as ReaderReviewServiceContract,
  ReaderReviewStartRequest, ReaderReviewStartResult, ReaderReviewStopRequest, ReaderReviewStopResult, ReaderReviewSupport
} from "@ai-book-studio/core/review/reader-api";
import { captureReaderSelection, type CapturedReaderSelection, type ReaderSelectionRequest } from "@ai-book-studio/core/review/selection";
import type { ReviewTransport } from "./transport";

/** The only library capability this slice receives. It has no save, create, delete, thread or report method. */
export interface ReviewLibrary {
  readBook(bookId: string): Promise<BookDetail>;
}

/** The existing 011 facts, read-only. Credentials are used only at the transport edge and never stored. */
export interface ReviewProviders {
  list(): Promise<ConnectionSummary[]>;
  credential(connectionId: string): Promise<StoredCredential>;
  models(connectionId: string): Promise<Catalogue>;
}

interface PendingReaderReview {
  readonly prepareId: string;
  readonly requestId: string;
  readonly bookId: string;
  readonly selection: ReaderSelectionRequest;
  readonly prompt: string;
  readonly profileId: "reader-alpha" | "reader-beta";
  readonly envelope: ReviewEnvelope;
  readonly terms: ReaderReviewTerms;
  readonly connection: ReaderReviewConnection;
  readonly priceFacts: ReaderReviewPriceFacts;
  readonly capturedAt: string;
}

interface ActiveReaderReview {
  readonly requestId: string;
  readonly controller: AbortController;
}

export interface ReaderReviewServiceOptions {
  readonly library: () => ReviewLibrary;
  readonly providers: ReviewProviders;
  readonly transport: ReviewTransport;
  readonly now?: () => string;
  readonly supported?: boolean;
}

const OVERFLOW_DETAIL: Record<string, string> = {
  "books-limit": "At most 4 books can be reviewed at once.",
  "source-item-limit": "At most 64 source items can be reviewed at once.",
  "source-byte-limit": "The selected source text is over 65,536 bytes.",
  "content-byte-limit": "The selected text, profile and request are over 131,072 bytes.",
  "request-byte-limit": "The complete request is over 262,144 bytes."
};

function contractCode(error: unknown): string | null {
  return error instanceof ReviewContractError ? error.code : null;
}

function preparedRefusal(error: unknown): { kind: "blocked"; reason: ReaderReviewRefusal; detail?: string } {
  const code = contractCode(error);
  if (code && OVERFLOW_DETAIL[code]) return { kind: "blocked", reason: "scope-too-large", detail: OVERFLOW_DETAIL[code] };
  return { kind: "blocked", reason: "invalid-selection" };
}

function startRefusal(reasons: readonly string[], connectionAvailable: boolean): ReaderReviewRefusal {
  if (reasons.includes("consent-missing")) return "consent";
  if (reasons.some((reason) => reason.startsWith("source-"))) return "changed";
  if (reasons.includes("destination-unavailable")) return connectionAvailable ? "unavailable" : "permission";
  return "changed";
}

function failure(error: unknown, signal: AbortSignal): ReaderReviewFailure | null {
  if (signal.aborted) return null;
  if (error instanceof ProviderError) {
    if (error.code === "refusal") return "refused";
    if (error.code === "context") return "overflow";
    return "provider";
  }
  return "provider";
}

function buildFailure(error: unknown, signal: AbortSignal): ReaderReviewFailure | null {
  if (signal.aborted) return null;
  return contractCode(error) === "output-byte-limit" ? "overflow" : "malformed";
}

/**
 * Volatile, one-book selected-source prepare/start. It holds only the frozen envelope and disclosure
 * facts in memory; there is no writer, store, conversation, report or background reread.
 */
export class ReaderReviewService implements ReaderReviewServiceContract {
  private readonly library: () => ReviewLibrary;
  private readonly providers: ReviewProviders;
  private readonly transport: ReviewTransport;
  private readonly now: () => string;
  private readonly supported: boolean;
  private readonly pendingByRequest = new Map<string, PendingReaderReview>();
  private readonly pendingByPrepare = new Map<string, PendingReaderReview>();
  private readonly starting = new Set<string>();
  private readonly activeRuns = new Map<string, ActiveReaderReview>();

  constructor(options: ReaderReviewServiceOptions) {
    this.library = options.library;
    this.providers = options.providers;
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date().toISOString());
    this.supported = options.supported ?? true;
  }

  async support(): Promise<ReaderReviewSupport> {
    return { supported: this.supported, reason: this.supported ? null : "unsupported-host" };
  }

  async prepare(request: ReaderReviewPrepareRequest): Promise<ReaderReviewPrepareResult> {
    if (!this.supported) return { kind: "blocked", reason: "unavailable" };
    const requestId = `review-${request.prepareId}`;
    if (this.pendingByPrepare.has(request.prepareId) || this.pendingByRequest.has(requestId)) {
      return { kind: "blocked", reason: "changed" };
    }
    let detail: BookDetail;
    try {
      detail = await this.library().readBook(request.bookId);
    } catch {
      return { kind: "blocked", reason: "unavailable" };
    }
    const connectionId = detail.book.defaultConnectionId;
    const modelId = detail.book.defaultModelId;
    if (!connectionId || !modelId) return { kind: "blocked", reason: "no-model" };
    const lens = request.profileId === "reader-alpha" ? "alpha" : "beta";
    const profile = await builtinReaderProfile(lens);

    let captured: CapturedReaderSelection;
    try {
      captured = captureReaderSelection({
        selection: { bookId: request.bookId, chapters: request.chapters },
        book: detail,
        capturedAt: this.now()
      });
    } catch (error) {
      return preparedRefusal(error);
    }

    let connections: readonly ConnectionSummary[];
    try {
      connections = await this.providers.list();
    } catch {
      return { kind: "blocked", reason: "unavailable" };
    }
    const connection = connections.find((candidate) => candidate.id === connectionId);
    if (!connection) return { kind: "blocked", reason: "unavailable" };
    let catalogue: Catalogue;
    try {
      catalogue = await this.providers.models(connectionId);
    } catch {
      return { kind: "blocked", reason: "unavailable" };
    }
    const host = await deriveReaderHostFacts({
      hostSupported: this.supported,
      book: { bookId: request.bookId, title: detail.book.title, allowContributorTraining: detail.book.allowContributorTraining === true },
      destination: { connectionId, model: modelId },
      connections,
      catalogue
    });
    if (host.kind === "blocked") return { kind: "blocked", reason: host.reason };

    let envelope: ReviewEnvelope;
    try {
      envelope = await buildReviewEnvelope({
        contractVersion: 1,
        kind: "reader-review",
        requestId,
        capturedAt: this.now(),
        destination: host.facts.destination,
        environment: host.facts.environment,
        books: [{
          bookId: request.bookId,
          title: detail.book.title,
          consentSatisfied: host.facts.book.consentSatisfied,
          consentRevision: host.facts.book.consentRevision,
          termsRevision: host.facts.book.termsRevision,
          enabledTools: []
        }],
        prompt: request.prompt,
        profile,
        priorFeedback: [],
        sources: [...captured.sources]
      });
    } catch (error) {
      return preparedRefusal(error);
    }

    const pending: PendingReaderReview = {
      prepareId: request.prepareId,
      requestId,
      bookId: request.bookId,
      selection: { bookId: request.bookId, chapters: request.chapters.map((chapter) => ({
        chapterId: chapter.chapterId, ranges: chapter.ranges.map((range) => ({ start: range.start, end: range.end }))
      })) },
      prompt: request.prompt,
      profileId: request.profileId,
      envelope,
      terms: host.facts.terms,
      connection: host.facts.connection,
      priceFacts: host.facts.priceFacts,
      capturedAt: this.now()
    };
    this.pendingByRequest.set(requestId, pending);
    this.pendingByPrepare.set(request.prepareId, pending);
    return {
      kind: "ready",
      prepareId: request.prepareId,
      requestId,
      scopeDigest: envelope.scopeDigest,
      envelope,
      terms: [host.facts.terms],
      connection: host.facts.connection,
      priceFacts: host.facts.priceFacts,
      usage: reviewResourceUsage(envelope)
    };
  }

  async start(request: ReaderReviewStartRequest): Promise<ReaderReviewStartResult> {
    if (!this.supported) return { kind: "blocked", reason: "unavailable" };
    if (this.starting.has(request.requestId)) return { kind: "blocked", reason: "changed" };
    const pending = this.pendingByRequest.get(request.requestId);
    if (!pending || pending.requestId !== request.requestId ||
        pending.envelope.scopeDigest !== request.scopeDigest ||
        pending.envelope.requestId !== request.requestId) {
      return { kind: "blocked", reason: "changed" };
    }
    this.starting.add(request.requestId);
    let active: ActiveReaderReview | null = null;
    try {
      const cancelled = () => this.pendingByRequest.get(request.requestId) !== pending;
      let detail: BookDetail;
      try {
        detail = await this.library().readBook(pending.bookId);
      } catch {
        return cancelled() ? { kind: "stopped" } : { kind: "blocked", reason: "unavailable" };
      }
      if (cancelled()) return { kind: "stopped" };

      let captured: CapturedReaderSelection;
      try {
        captured = captureReaderSelection({ selection: pending.selection, book: detail, capturedAt: this.now() });
      } catch {
        return { kind: "blocked", reason: "changed" };
      }
      if (cancelled()) return { kind: "stopped" };

      let connections: readonly ConnectionSummary[];
      try {
        connections = await this.providers.list();
      } catch {
        return cancelled() ? { kind: "stopped" } : { kind: "blocked", reason: "unavailable" };
      }
      if (cancelled()) return { kind: "stopped" };
      const connection = connections.find((candidate) => candidate.id === pending.envelope.destination.connectionId);
      if (!connection) return { kind: "blocked", reason: "changed" };

      let catalogue: Catalogue;
      try {
        catalogue = await this.providers.models(connection.id);
      } catch {
        return cancelled() ? { kind: "stopped" } : { kind: "blocked", reason: "unavailable" };
      }
      if (cancelled()) return { kind: "stopped" };

      const host = await deriveReaderHostFacts({
        hostSupported: this.supported,
        book: { bookId: pending.bookId, title: detail.book.title, allowContributorTraining: detail.book.allowContributorTraining === true },
        destination: { connectionId: pending.envelope.destination.connectionId, model: pending.envelope.destination.model },
        connections,
        catalogue
      });
      if (cancelled()) return { kind: "stopped" };
      if (host.kind === "blocked") {
        return { kind: "blocked", reason: host.reason === "permission" ? "permission" : host.reason === "no-model" ? "changed" : "unavailable" };
      }

      const currentSources: CurrentSource[] = captured.sources.map((source) => ({
        sourceId: source.sourceId, status: "available", source
      }));
      const currentFacts = {
        destination: host.facts.destination,
        environment: host.facts.environment,
        books: [{
          bookId: pending.bookId,
          title: detail.book.title,
          consentSatisfied: host.facts.book.consentSatisfied,
          consentRevision: host.facts.book.consentRevision,
          termsRevision: host.facts.book.termsRevision,
          enabledTools: [] as string[]
        }],
        profile: pending.envelope.profile
      };
      const reasons = await checkReviewStart(
        pending.envelope,
        { kind: "start", requestId: request.requestId, scopeDigest: request.scopeDigest },
        currentFacts,
        currentSources
      );
      if (cancelled()) return { kind: "stopped" };
      if (reasons.length) {
        return { kind: "blocked", reason: startRefusal(reasons, host.facts.environment.connectionAvailable) };
      }

      // Consume the request once before resolving a credential or making the provider call.
      this.pendingByRequest.delete(pending.requestId);
      this.pendingByPrepare.delete(pending.prepareId);
      active = { requestId: pending.requestId, controller: new AbortController() };
      this.activeRuns.set(pending.requestId, active);
      const stillActive = () => this.activeRuns.get(pending.requestId) === active && !active?.controller.signal.aborted;

      let credential: StoredCredential;
      try {
        credential = await this.providers.credential(pending.envelope.destination.connectionId);
      } catch {
        return stillActive() ? { kind: "blocked", reason: "unavailable" } : { kind: "stopped" };
      }
      if (!stillActive() || !active) return { kind: "stopped" };

      const startedAt = this.now();
      let output: string;
      try {
        output = (await this.transport.run({ envelope: pending.envelope, credential, signal: active.controller.signal })).output;
      } catch (error) {
        if (!stillActive() || !active) return { kind: "stopped" };
        const reason = failure(error, active.controller.signal);
        return reason ? { kind: "failed", reason } : { kind: "stopped" };
      }
      if (!stillActive()) return { kind: "stopped" };

      try {
        const run = await buildReaderRun({
          runId: pending.envelope.requestId,
          startedAt,
          completedAt: this.now(),
          envelope: pending.envelope,
          output
        });
        return { kind: "completed", run };
      } catch (error) {
        if (!stillActive()) return { kind: "stopped" };
        const reason = buildFailure(error, active.controller.signal);
        return reason ? { kind: "failed", reason } : { kind: "stopped" };
      }
    } finally {
      this.starting.delete(request.requestId);
      if (active && this.activeRuns.get(request.requestId) === active) this.activeRuns.delete(request.requestId);
    }
  }

  async stop(request: ReaderReviewStopRequest): Promise<ReaderReviewStopResult> {
    const active = this.activeRuns.get(request.requestId);
    if (active) {
      active.controller.abort();
      this.activeRuns.delete(request.requestId);
      return "stopped";
    }
    const pending = this.pendingByRequest.get(request.requestId);
    if (pending) {
      this.pendingByRequest.delete(pending.requestId);
      this.pendingByPrepare.delete(pending.prepareId);
      return "not-started";
    }
    return "unconfirmed";
  }

  async cancelPrepare(request: ReaderReviewCancelPrepareRequest): Promise<ReaderReviewCancelResult> {
    const pending = this.pendingByPrepare.get(request.prepareId);
    if (!pending) return "not-found";
    this.pendingByRequest.delete(pending.requestId);
    this.pendingByPrepare.delete(pending.prepareId);
    return "cancelled";
  }
}
