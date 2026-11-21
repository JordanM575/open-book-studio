import {
  identifier, immutable, type Route, safeCounter, sameRoute, sameToken, type SessionToken, validRoute,
} from "./contracts";

/*
 * Host-owned cancellable voice transport (017 T016, D-200 / ADR 0021 item 6).
 *
 * This is the pure accounting/identity half of STT and TTS dispatch. It owns monotonic operation and
 * chunk IDs, the exact session/route/permission check performed immediately before every send, the
 * one-outstanding-operation-per-kind backpressure rule and an honest settlement record. It performs
 * no request, holds no audio/text and returns descriptions only; the trusted host executes them.
 *
 * Charge honesty (D-116/D-192): a dispatched request that the provider did not price stays
 * `unknown`. A never-dispatched request is `unsent`, which is a local fact and not a provider
 * claim. Reported amounts are added into `reportedUsd`; unknown chunks are counted separately so a
 * caller can never read an unreported request as a fabricated zero.
 */

export type TransportKind = "stt" | "tts";

/** What a settlement says happened. Charge is a separate axis, never inferred from the outcome. */
export type TransportOutcome = "success" | "refusal" | "failure" | "cancellation";

export type TransportCharge =
  | { readonly state: "unsent" }
  | { readonly state: "reported"; readonly usd: number }
  | { readonly state: "unknown" };

export type TransportChunkState = "queued" | "dispatched" | "settled" | "unsent";

export interface TransportChunk {
  readonly chunkId: number;
  readonly state: TransportChunkState;
  readonly charge: TransportCharge;
  /** The actual settlement, even if the operation was cancelled while this chunk was in flight. */
  readonly outcome: TransportOutcome | null;
  readonly failure: string | null;
}

/** One bounded STT request or one TTS speaking run, pinned to the route chosen at `begin`. */
export interface TransportOperation extends SessionToken {
  readonly operationId: number;
  readonly kind: TransportKind;
  readonly route: Route;
  /** Chunks the host expects to send (STT: 1; TTS: the sentence chunks it will synthesise). */
  readonly planned: number;
  readonly cancelled: boolean;
  readonly cancelReason: string | null;
  readonly chunks: readonly TransportChunk[];
}

export interface TransportReceipt extends SessionToken {
  readonly operation: TransportOperation;
  readonly outcome: TransportOutcome;
  readonly failure: string | null;
  /** Actual final dispatched-chunk settlement, independent of a prior cancellation request. */
  readonly finalChunkOutcome: TransportOutcome | null;
  readonly finalChunkFailure: string | null;
  /** Sum of provider-reported charges only. Unknown chunks are counted below, never added as 0. */
  readonly reportedUsd: number;
  readonly unknownChunks: number;
  readonly unsentChunks: number;
}

export interface TransportLedger {
  readonly sequence: number;
  readonly slots: Readonly<Record<TransportKind, TransportOperation | null>>;
  readonly receipts: readonly TransportReceipt[];
  readonly reason: string | null;
}

/** Facts the trusted host derives afresh from real permission, route and session state. */
export interface TransportFacts {
  readonly now: number;
  readonly session: SessionToken;
  readonly route: Route;
  readonly permitted: boolean;
}

/**
 * Renderer-safe projection of what a request cost. Unknown never becomes zero: a dispatched
 * chunk without a provider-reported amount counts as unknown, and a reported zero only produces
 * `reported` when nothing is unknown. `pending` is only for requests that have not settled yet and
 * is produced by the host, never from a receipt.
 */
import type { VoiceChargeView } from "../ipc";

function roundUsd6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Project the charge facts onto the shared view. `dispatched` counts settled chunks. */
export function chargeViewOfCounts(dispatched: number, reportedUsd: number, unknownChunks: number): VoiceChargeView {
  if (dispatched === 0) return { state: "none" };
  if (unknownChunks === 0) return { state: "reported", usd: roundUsd6(reportedUsd) };
  if (reportedUsd > 0) return { state: "mixed", reportedUsd: roundUsd6(reportedUsd), unknownChunks };
  return { state: "unknown" };
}

/** Project a settled receipt onto the shared charge view. */
export function chargeViewOfReceipt(receipt: TransportReceipt): VoiceChargeView {
  const settled = receipt.operation.chunks.filter((chunk) => chunk.state === "settled").length;
  return chargeViewOfCounts(settled, receipt.reportedUsd, receipt.unknownChunks);
}

export type TransportEffect =
  | {
      readonly type: "send";
      readonly operationId: number;
      readonly chunkId: number;
      readonly kind: TransportKind;
      readonly route: Route;
    }
  /** Best-effort abort. The host keeps the slot until an actual settlement arrives. */
  | {
      readonly type: "abort";
      readonly operationId: number;
      readonly chunkId: number;
      readonly reason: string;
    };

export interface TransportTransition {
  readonly ledger: TransportLedger;
  readonly effects: readonly TransportEffect[];
}

export type TransportEvent =
  | {
      readonly type: "begin";
      readonly kind: TransportKind;
      readonly planned: number;
      readonly facts: TransportFacts;
    }
  | { readonly type: "chunk"; readonly operationId: number }
  | {
      readonly type: "dispatch";
      readonly operationId: number;
      readonly chunkId: number;
      readonly facts: TransportFacts;
    }
  | {
      readonly type: "settle";
      readonly operationId: number;
      readonly chunkId: number;
      readonly outcome: "success" | "refusal" | "failure" | "cancellation";
      readonly costUsd?: number | null;
      readonly failure?: string;
    }
  | { readonly type: "cancel"; readonly operationId: number; readonly reason: string }
  | {
      /**
       * Close a pre-dispatch operation with outcome `refusal`. No abort is emitted, every chunk
       * that has not been dispatched is recorded as unsent and the slot is released. A dispatched
       * or settled chunk, or an unknown operation, makes this a no-op.
       */
      readonly type: "refuse";
      readonly operationId: number;
      readonly reason: string;
    };

const CHUNK_LIMIT = 256;
const RECEIPT_LIMIT = 256;
const TEXT_LIMIT = 65_536;
const FALLBACK_FAILURE = "The external operation failed. Review its host receipt before continuing.";

export function initialTransportLedger(): TransportLedger {
  return immutable({ sequence: 0, slots: { stt: null, tts: null }, receipts: [], reason: null });
}

function operationIn(ledger: TransportLedger, operationId: number): TransportOperation | null {
  for (const kind of ["stt", "tts"] as const) {
    const operation = ledger.slots[kind];
    if (operation && operation.operationId === operationId) return operation;
  }
  return null;
}

function chargeFor(costUsd: number | null | undefined): TransportCharge {
  // Only a finite, non-negative provider-reported amount is a report. Missing, negative or
  // non-finite values stay unknown; nothing becomes an assumed free request.
  return typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0
    ? { state: "reported", usd: costUsd }
    : { state: "unknown" };
}

function failureText(failure: string | undefined): string {
  return typeof failure === "string" && failure.trim() && failure.length <= TEXT_LIMIT
    ? failure
    : FALLBACK_FAILURE;
}

/** Recheck immediately before EACH external send. Never cache: the host calls it after every await. */
export function mayDispatch(
  ledger: TransportLedger, operationId: number, chunkId: number, facts: TransportFacts,
): boolean {
  const operation = operationIn(ledger, operationId);
  if (!operation || operation.cancelled) return false;
  const chunk = operation.chunks.find((entry) => entry.chunkId === chunkId);
  if (chunk?.state !== "queued") return false;
  return safeCounter(facts.now) && facts.permitted && safeCounter(facts.session.generation) &&
    identifier(facts.session.sessionId) && sameToken(operation, facts.session) &&
    validRoute(facts.route) && sameRoute(operation.route, facts.route);
}

export function reduceTransport(ledger: TransportLedger, event: TransportEvent): TransportTransition {
  let state = ledger;
  const effects: TransportEffect[] = [];
  const update = (patch: Partial<TransportLedger>) => { state = { ...state, ...patch }; };
  const result = (): TransportTransition => immutable({ ledger: state, effects });

  const finish = (
    operation: TransportOperation, outcome: TransportOutcome, failure: string | null,
  ) => {
    if (state.receipts.length >= RECEIPT_LIMIT) {
      update({ reason: "Settlement history is full. The host must retain its own accounting record before continuing." });
      return;
    }
    const chunks = operation.chunks.map((chunk) => chunk.state === "queued"
      ? { ...chunk, state: "unsent" as const, charge: { state: "unsent" as const } }
      : chunk);
    const settled = chunks.filter((chunk) => chunk.state === "settled");
    const reportedUsd = settled.reduce(
      (total, chunk) => total + (chunk.charge.state === "reported" ? chunk.charge.usd : 0), 0,
    );
    const unknownChunks = settled.filter((chunk) => chunk.charge.state === "unknown").length;
    const unsentChunks = operation.planned - settled.length;
    const lastChunk = settled.at(-1);
    const snapshot: TransportOperation = { ...operation, chunks };
    update({
      slots: { ...state.slots, [operation.kind]: null },
      receipts: [...state.receipts, {
        sessionId: operation.sessionId, generation: operation.generation,
        operation: snapshot, outcome, failure, finalChunkOutcome: lastChunk?.outcome ?? null,
        finalChunkFailure: lastChunk?.failure ?? null, reportedUsd, unknownChunks, unsentChunks,
      }],
      reason: null,
    });
  };

  switch (event.type) {
    case "begin": {
      const { facts, kind, planned } = event;
      // Every admitted operation must be able to record its receipt, including one already running
      // of the other kind. Reserve that space now; a settlement that cannot be recorded would leave
      // its slot occupied forever.
      const outstanding = (state.slots.stt ? 1 : 0) + (state.slots.tts ? 1 : 0);
      if (state.receipts.length + outstanding + 1 > RECEIPT_LIMIT) {
        update({ reason: "Settlement history is full. The host must retain its own accounting record before continuing." });
        return result();
      }
      if (state.slots[kind]) {
        update({ reason: "Another operation of this kind is still settling. Wait for its exact receipt." });
        return result();
      }
      if (!safeCounter(planned) || planned < 1 || planned > CHUNK_LIMIT) {
        update({ reason: "The planned request count is outside the local bound." });
        return result();
      }
      if (!safeCounter(facts.now) || !facts.permitted || !safeCounter(facts.session.generation) ||
          !identifier(facts.session.sessionId) || !validRoute(facts.route) || state.sequence >= Number.MAX_SAFE_INTEGER) {
        update({ reason: "The session, route or audio permission is not ready for dispatch." });
        return result();
      }
      const operation: TransportOperation = {
        sessionId: facts.session.sessionId, generation: facts.session.generation,
        operationId: state.sequence + 1, kind, route: { ...facts.route }, planned,
        cancelled: false, cancelReason: null, chunks: [],
      };
      update({
        sequence: operation.operationId, slots: { ...state.slots, [kind]: operation }, reason: null,
      });
      return result();
    }
    case "chunk": {
      const operation = operationIn(state, event.operationId);
      if (!operation || operation.cancelled) return result();
      if (operation.chunks.some((chunk) => chunk.state === "queued" || chunk.state === "dispatched")) {
        update({ reason: "The previous chunk is still outstanding. Send one request at a time." });
        return result();
      }
      if (operation.chunks.length >= operation.planned) {
        update({ reason: "Every planned chunk has already been allocated." });
        return result();
      }
      const chunk: TransportChunk = {
        chunkId: operation.chunks.length + 1, state: "queued", charge: { state: "unsent" }, outcome: null, failure: null,
      };
      update({
        slots: { ...state.slots, [operation.kind]: { ...operation, chunks: [...operation.chunks, chunk] } },
        reason: null,
      });
      return result();
    }
    case "dispatch": {
      const operation = operationIn(state, event.operationId);
      if (!operation) return result();
      const chunk = operation.chunks.find((entry) => entry.chunkId === event.chunkId);
      if (chunk?.state !== "queued") return result();
      if (!mayDispatch(state, event.operationId, event.chunkId, event.facts)) {
        const outcome: TransportOutcome = operation.cancelled ? "cancellation" : "refusal";
        const closed: TransportOperation = {
          ...operation,
          chunks: operation.chunks.map((entry) => entry.chunkId === chunk.chunkId
            ? { ...entry, state: "unsent" as const, charge: { state: "unsent" as const } }
            : entry),
        };
        update({ slots: { ...state.slots, [operation.kind]: closed } });
        finish(closed, outcome, outcome === "cancellation"
          ? "Cancelled before dispatch."
          : "The route, session or audio permission changed before dispatch. No request was sent.");
        if (outcome === "refusal") {
          update({ reason: "The route, session or audio permission changed before dispatch. No request was sent." });
        }
        return result();
      }
      const dispatched: TransportOperation = {
        ...operation,
        chunks: operation.chunks.map((entry) => entry.chunkId === chunk.chunkId
          ? { ...entry, state: "dispatched" as const, charge: { state: "unknown" as const } }
          : entry),
      };
      update({ slots: { ...state.slots, [operation.kind]: dispatched }, reason: null });
      effects.push({
        type: "send", operationId: operation.operationId, chunkId: chunk.chunkId,
        kind: operation.kind, route: { ...operation.route },
      });
      return result();
    }
    case "settle": {
      const operation = operationIn(state, event.operationId);
      if (!operation) return result();
      const chunk = operation.chunks.find((entry) => entry.chunkId === event.chunkId);
      // Duplicate, late or foreign settlements change nothing: another slot is never released.
      if (chunk?.state !== "dispatched") return result();
      const charge = chargeFor(event.costUsd);
      const settled: TransportOperation = {
        ...operation,
        chunks: operation.chunks.map((entry) => entry.chunkId === chunk.chunkId
          ? { ...entry, state: "settled" as const, charge, outcome: event.outcome,
            failure: event.outcome === "failure" ? failureText(event.failure) : null }
          : entry),
      };
      if (!operation.cancelled && event.outcome === "success" && chunk.chunkId < operation.planned) {
        update({ slots: { ...state.slots, [operation.kind]: settled }, reason: null });
        return result();
      }
      const outcome: TransportOutcome = operation.cancelled ? "cancellation" : event.outcome;
      update({ slots: { ...state.slots, [operation.kind]: settled } });
      finish(settled, outcome, outcome === "failure" ? failureText(event.failure) : null);
      return result();
    }
    case "refuse": {
      const operation = operationIn(state, event.operationId);
      if (!operation) return result();
      // A refusal is only honest when nothing is mid-flight. Settled chunks keep their charge;
      // queued (never dispatched) chunks close out as unsent.
      if (operation.chunks.some((entry) => entry.state === "dispatched")) return result();
      const reason = failureText(event.reason);
      finish(operation, "refusal", reason);
      return result();
    }
    case "cancel": {
      const operation = operationIn(state, event.operationId);
      if (!operation || operation.cancelled) return result();
      const reason = identifier(event.reason) ? event.reason : "Cancelled.";
      const outstanding = operation.chunks.find((chunk) => chunk.state === "dispatched");
      const queued = operation.chunks.find((chunk) => chunk.state === "queued");
      if (outstanding) {
        const cancelled: TransportOperation = {
          ...operation, cancelled: true, cancelReason: reason,
          chunks: operation.chunks.map((entry) => entry === queued
            ? { ...entry, state: "unsent" as const, charge: { state: "unsent" as const } }
            : entry),
        };
        update({ slots: { ...state.slots, [operation.kind]: cancelled }, reason });
        effects.push({
          type: "abort", operationId: operation.operationId, chunkId: outstanding.chunkId, reason,
        });
        return result();
      }
      const closed: TransportOperation = {
        ...operation, cancelled: true, cancelReason: reason,
        chunks: operation.chunks.map((entry) => entry.state === "queued"
          ? { ...entry, state: "unsent" as const, charge: { state: "unsent" as const } }
          : entry),
      };
      update({ slots: { ...state.slots, [operation.kind]: closed } });
      finish(closed, "cancellation", null);
      return result();
    }
  }
}
