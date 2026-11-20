import { z } from "zod";
import type { Result } from "../ipc";
import { redact } from "../providers/redact";
import { bookIdSchema, chapterIdSchema, hashSchema, idSchema, REVIEW_LIMITS, spanSchema, textSchema } from "./contract";
import type { ReviewEnvelope, ReviewResourceUsage } from "./envelope";
import type { ReaderRun } from "./findings";
import type { ReaderReviewConnection, ReaderReviewPriceFacts, ReaderReviewTerms } from "./host-facts";
export type { ReaderReviewConnection, ReaderReviewPriceFacts, ReaderReviewTerms } from "./host-facts";

export const readerReviewChannel = "readerReview:request";

export type ReaderReviewRefusal =
  | "unavailable" | "permission" | "no-model" | "invalid-selection" | "scope-too-large" | "consent" | "terms" | "changed";
export type ReaderReviewFailure = "provider" | "overflow" | "malformed" | "refused";
export type ReaderReviewStopResult = "stopped" | "not-started" | "unconfirmed";
export type ReaderReviewCancelResult = "cancelled" | "not-found";
export interface ReaderReviewSupport {
  readonly supported: boolean;
  readonly reason: "unsupported-host" | null;
}

export const readerProfileIdSchema = z.enum(["reader-alpha", "reader-beta"]);
const prepareIdSchema = idSchema.max(120);

export const readerReviewPrepareRequestSchema = z.strictObject({
  operation: z.literal("prepare"),
  prepareId: prepareIdSchema,
  bookId: bookIdSchema,
  profileId: readerProfileIdSchema,
  chapters: z.array(z.strictObject({
    chapterId: chapterIdSchema,
    ranges: z.array(spanSchema).min(1).max(REVIEW_LIMITS.items * 4)
  })).min(1).max(REVIEW_LIMITS.items),
  prompt: textSchema.max(REVIEW_LIMITS.requestBytes)
});
export const readerReviewStartRequestSchema = z.strictObject({
  operation: z.literal("start"), requestId: idSchema.max(200), scopeDigest: hashSchema
});
export const readerReviewStopRequestSchema = z.strictObject({
  operation: z.literal("stop"), requestId: idSchema.max(200)
});
export const readerReviewCancelPrepareRequestSchema = z.strictObject({
  operation: z.literal("cancelPrepare"), prepareId: prepareIdSchema
});
export const readerReviewRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("support") }),
  readerReviewPrepareRequestSchema,
  readerReviewStartRequestSchema,
  readerReviewStopRequestSchema,
  readerReviewCancelPrepareRequestSchema
]);
export type ReaderReviewPrepareRequest = z.infer<typeof readerReviewPrepareRequestSchema>;
export type ReaderReviewStartRequest = z.infer<typeof readerReviewStartRequestSchema>;
export type ReaderReviewStopRequest = z.infer<typeof readerReviewStopRequestSchema>;
export type ReaderReviewCancelPrepareRequest = z.infer<typeof readerReviewCancelPrepareRequestSchema>;
export type ReaderReviewRequest = z.infer<typeof readerReviewRequestSchema>;

export type ReaderReviewPrepareResult =
  | {
      readonly kind: "ready";
      readonly prepareId: string;
      readonly requestId: string;
      readonly scopeDigest: string;
      readonly envelope: ReviewEnvelope;
      readonly terms: readonly ReaderReviewTerms[];
      readonly connection: ReaderReviewConnection;
      readonly priceFacts: ReaderReviewPriceFacts;
      readonly usage: ReviewResourceUsage;
    }
  | { readonly kind: "blocked"; readonly reason: ReaderReviewRefusal; readonly detail?: string };
export type ReaderReviewStartResult =
  | { readonly kind: "completed"; readonly run: ReaderRun }
  | { readonly kind: "blocked"; readonly reason: ReaderReviewRefusal; readonly detail?: string }
  | { readonly kind: "failed"; readonly reason: ReaderReviewFailure }
  | { readonly kind: "stopped" };

/** The one bounded service the channel speaks to. No renderer data becomes a path or a credential. */
export interface ReaderReviewService {
  support(): Promise<ReaderReviewSupport>;
  prepare(request: ReaderReviewPrepareRequest): Promise<ReaderReviewPrepareResult>;
  start(request: ReaderReviewStartRequest): Promise<ReaderReviewStartResult>;
  stop(request: ReaderReviewStopRequest): Promise<ReaderReviewStopResult>;
  cancelPrepare(request: ReaderReviewCancelPrepareRequest): Promise<ReaderReviewCancelResult>;
}

export const UNSUPPORTED_READER_REVIEW_COPY =
  "Reader review is unavailable on this host. No source preparation or provider request can start.";
export const INVALID_READER_REVIEW_COPY = "The reader review request is invalid. Nothing was submitted.";

export interface ReaderReviewApi {
  support(): Promise<Result<ReaderReviewSupport>>;
  prepare(request: Omit<ReaderReviewPrepareRequest, "operation">): Promise<Result<ReaderReviewPrepareResult>>;
  start(request: Omit<ReaderReviewStartRequest, "operation">): Promise<Result<ReaderReviewStartResult>>;
  stop(request: Omit<ReaderReviewStopRequest, "operation">): Promise<Result<ReaderReviewStopResult>>;
  cancelPrepare(request: Omit<ReaderReviewCancelPrepareRequest, "operation">): Promise<Result<ReaderReviewCancelResult>>;
}

function invalidResult<T>(): Result<T> {
  return { ok: false, error: { code: "invalid", message: INVALID_READER_REVIEW_COPY } };
}

/** Main-process boundary: strict schemas before the service sees any field; failures are redacted. */
export function readerReviewHandler(service: ReaderReviewService) {
  return async (payload: unknown): Promise<Result<unknown>> => {
    let request: ReaderReviewRequest;
    try {
      request = readerReviewRequestSchema.parse(payload);
    } catch {
      return invalidResult();
    }
    try {
      if (request.operation === "support") return { ok: true, data: await service.support() };
      if (request.operation === "prepare") return { ok: true, data: await service.prepare(request) };
      if (request.operation === "start") return { ok: true, data: await service.start(request) };
      if (request.operation === "stop") return { ok: true, data: await service.stop(request) };
      return { ok: true, data: await service.cancelPrepare(request) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { code: "internal", message: redact(message) || "Reader review failed. Nothing was sent." } };
    }
  };
}

/** Preload/client bridge. It parses its own outbound payload and never invents authority. */
export function createReaderReviewApi(invoke: (payload: unknown) => Promise<Result<unknown>>): ReaderReviewApi {
  const call = async <T>(payload: ReaderReviewRequest): Promise<Result<T>> => {
    let request: ReaderReviewRequest;
    try {
      request = readerReviewRequestSchema.parse(payload);
    } catch {
      return invalidResult();
    }
    try {
      return await invoke(request) as Result<T>;
    } catch {
      return { ok: false, error: { code: "internal", message: "Reader review failed. Nothing was sent." } };
    }
  };
  return {
    support: () => call({ operation: "support" }),
    prepare: (request) => call({ ...request, operation: "prepare" }),
    start: (request) => call({ ...request, operation: "start" }),
    stop: (request) => call({ ...request, operation: "stop" }),
    cancelPrepare: (request) => call({ ...request, operation: "cancelPrepare" })
  };
}

/** Browser/unsupported hosts expose the same surface and refuse before any private read. */
export function unsupportedReaderReviewApi(): ReaderReviewApi {
  const refuse = <T>(): Promise<Result<T>> => Promise.resolve({
    ok: false, error: { code: "unsupported", message: UNSUPPORTED_READER_REVIEW_COPY }
  });
  return {
    support: () => Promise.resolve({ ok: true, data: { supported: false, reason: "unsupported-host" } }),
    prepare: () => refuse(),
    start: () => refuse(),
    stop: () => refuse(),
    cancelPrepare: () => refuse()
  };
}
