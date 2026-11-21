import type { TransportLedger } from "../../../../packages/core/src/voice-session";
import type { VoiceOperationView, VoiceCancelReceipt } from "@ai-book-studio/core/ipc";
import {
  chargeViewOfReceipt,
  initialTransportLedger,
  reduceTransport,
  type TransportFacts,
  type TransportKind,
  type TransportOutcome
} from "../../../../packages/core/src/voice-session";
import { redact } from "@ai-book-studio/core/providers/redact";

/*
 * Main-process registry of cancellable speech-to-text and text-to-speech ids.
 *
 * The pure ledger decides identity, backpressure, the route and permission recheck, and the
 * settlement record. This owner executes the local half: one AbortController per chunk that the
 * ledger has actually admitted for send. The controller is created only after that send effect.
 * Begin, route, permission and clock stay with the host; the renderer can only cancel an id this
 * host minted.
 *
 * Public ids are minted by the host (`VoiceRequestHost`); the internal ledger id never crosses
 * the IPC boundary. This registry keeps the public-to-internal binding and projects the
 * renderer-safe view. Cancellation is best-effort and local. The owned slot stays until the
 * local outcome is recorded. Nothing here claims a remote provider observed the cancel, and an
 * unknown charge is never rewritten to unsent or zero.
 */

export interface VoiceDispatch {
  /** True only when the ledger emitted a send and this host created a local abort signal. */
  readonly sent: boolean;
  readonly signal: AbortSignal | null;
}

export interface VoiceSettlement {
  readonly outcome: Extract<TransportOutcome, "success" | "refusal" | "failure" | "cancellation">;
  readonly costUsd?: number | null;
  readonly failure?: string;
}

/** Safe metadata recorded at bind time, so the view never reaches back into settings. */
export interface VoiceRequestBinding {
  readonly ownerWindowId: number;
  readonly kind: TransportKind;
  /** Safe display labels only; never an endpoint, secret, session id or draft text. */
  readonly connectionLabel: string;
  readonly model: string;
  readonly voice: string | null;
}

const DEFAULT_REASON = "Cancelled.";
const MAX_VIEW_MESSAGE = 512;

function boundedMessage(failure: string | null | undefined): string | null {
  if (!failure) return null;
  const redacted = redact(failure).trim();
  if (!redacted) return null;
  return redacted.length > MAX_VIEW_MESSAGE ? `${redacted.slice(0, MAX_VIEW_MESSAGE - 1)}…` : redacted;
}

export class VoiceCancelRegistry {
  private ledger: TransportLedger = initialTransportLedger();
  private readonly controllers = new Map<string, AbortController>();
  /** Public id to internal binding. Bounded by the ledger's own receipt cap plus two live slots. */
  private readonly bindings = new Map<number, { internalId: number } & VoiceRequestBinding>();
  private viewClock = 0;

  /** Frozen local accounting. It holds no abort handle and no provider claim. */
  accounting(): TransportLedger {
    return this.ledger;
  }

  /** Monotonic per process; the renderer keeps the highest per operation. */
  mintViewRevision(): number {
    this.viewClock += 1;
    return this.viewClock;
  }

  /** Mint one operation for a host-supplied route, permission and clock. Null when refused. */
  begin(kind: TransportKind, planned: number, facts: TransportFacts): number | null {
    const minted = this.ledger.sequence + 1;
    const transition = reduceTransport(this.ledger, { type: "begin", kind, planned, facts });
    this.ledger = transition.ledger;
    return this.ledger.slots[kind]?.operationId === minted ? minted : null;
  }

  /** Why the last begin refused, for the host to explain without guessing. */
  beginRefusal(): string | null {
    return this.ledger.reason;
  }

  /** Bind a public host-minted id to an internal ledger id. Called once, right after begin. */
  bind(requestId: number, operationId: number, meta: VoiceRequestBinding): void {
    if (this.bindings.has(requestId)) return;
    this.bindings.set(requestId, { internalId: operationId, ...meta });
  }

  /** The owner recorded at bind time, or null when the id is unknown here. */
  ownerOf(requestId: number): number | null {
    return this.bindings.get(requestId)?.ownerWindowId ?? null;
  }

  /** Queue the next chunk. Null when the ledger refuses another outstanding chunk. */
  queue(operationId: number): number | null {
    const before = this.operation(operationId)?.chunks.length ?? 0;
    const transition = reduceTransport(this.ledger, { type: "chunk", operationId });
    this.ledger = transition.ledger;
    const chunks = this.operation(operationId)?.chunks;
    if (!chunks || chunks.length !== before + 1) return null;
    const chunk = chunks[chunks.length - 1];
    return chunk?.state === "queued" ? chunk.chunkId : null;
  }

  /**
   * Recheck the host facts, then create one local signal only if the ledger emits send.
   * A refused dispatch sends nothing and creates no controller.
   */
  dispatch(operationId: number, chunkId: number, facts: TransportFacts): VoiceDispatch {
    const transition = reduceTransport(this.ledger, {
      type: "dispatch", operationId, chunkId, facts
    });
    this.ledger = transition.ledger;
    const effect = transition.effects.find((entry) => entry.type === "send");
    if (!effect || effect.type !== "send") return { sent: false, signal: null };
    const controller = new AbortController();
    this.controllers.set(this.key(effect.operationId, effect.chunkId), controller);
    return { sent: true, signal: controller.signal };
  }

  /** Record the local outcome. A cancelled operation stays a cancellation. */
  settle(operationId: number, chunkId: number, settlement: VoiceSettlement): void {
    const transition = reduceTransport(this.ledger, {
      type: "settle",
      operationId,
      chunkId,
      outcome: settlement.outcome,
      ...(settlement.costUsd !== undefined ? { costUsd: settlement.costUsd } : {}),
      ...(settlement.failure !== undefined ? { failure: settlement.failure } : {})
    });
    this.ledger = transition.ledger;
    const chunk = this.operation(operationId)?.chunks.find((entry) => entry.chunkId === chunkId);
    if (chunk?.state !== "dispatched") this.controllers.delete(this.key(operationId, chunkId));
  }

  /**
   * Close a pre-dispatch operation as a refusal. Nothing was sent, no abort is emitted and every
   * planned chunk is recorded as unsent. A dispatched or unknown operation is a no-op.
   */
  refuse(operationId: number, reason: string): void {
    const transition = reduceTransport(this.ledger, { type: "refuse", operationId, reason });
    this.ledger = transition.ledger;
  }

  /**
   * Cancel one live operation. An unknown or already-cancelled id is an honest no-op.
   * Abort is local, and only for a chunk that was already dispatched.
   */
  cancel(operationId: number, reason = DEFAULT_REASON): VoiceCancelReceipt {
    const before = this.operation(operationId);
    const transition = reduceTransport(this.ledger, { type: "cancel", operationId, reason });
    this.ledger = transition.ledger;
    const after = this.operation(operationId);
    const accepted = before !== null && !before.cancelled && (after === null || after.cancelled);
    let abortedLocally = false;
    for (const effect of transition.effects) {
      if (effect.type !== "abort" || abortedLocally) continue;
      const controller = this.controllers.get(this.key(effect.operationId, effect.chunkId));
      if (!controller || controller.signal.aborted) continue;
      controller.abort();
      abortedLocally = true;
    }
    return {
      operationId,
      accepted,
      abortedLocally,
      released: accepted && after === null
    };
  }

  /**
   * Cancel by public request id. The owner check happens here; a foreign window's id is an
   * honest no-op. The receipt echoes the public id.
   */
  cancelRequest(requestId: number, ownerWindowId: number, reason?: string): VoiceCancelReceipt {
    const binding = this.bindings.get(requestId);
    if (!binding || binding.ownerWindowId !== ownerWindowId) {
      return { operationId: requestId, accepted: false, abortedLocally: false, released: false };
    }
    const receipt = reason === undefined
      ? this.cancel(binding.internalId)
      : this.cancel(binding.internalId, reason);
    return { ...receipt, operationId: requestId };
  }

  /**
   * Project the renderer-safe view for a public id, or null when the id is unknown. Active
   * operations project from the live slot; settled ones from the bounded receipt history.
   */
  view(requestId: number): VoiceOperationView | null {
    const binding = this.bindings.get(requestId);
    if (!binding) return null;
    const { internalId } = binding;
    const live = this.operation(internalId);
    if (live) {
      const chunks = live.chunks;
      const dispatched = chunks.filter((chunk) => chunk.state === "dispatched" || chunk.state === "settled").length;
      const settled = chunks.filter((chunk) => chunk.state === "settled").length;
      return {
        operationId: requestId,
        viewRevision: this.mintViewRevision(),
        kind: live.kind,
        phase: live.cancelled ? "cancelling" : dispatched > 0 ? "in-flight" : "starting",
        status: null,
        cancelled: live.cancelled,
        connectionLabel: binding.connectionLabel,
        model: binding.model,
        voice: binding.voice,
        plannedChunks: live.planned,
        dispatchedChunks: dispatched,
        settledChunks: settled,
        unsentChunks: live.planned - settled,
        charge: { state: "pending" },
        message: null,
        finalChunkOutcome: null
      };
    }
    const receipt = [...this.ledger.receipts].reverse().find((entry) => entry.operation.operationId === internalId);
    if (!receipt) return null;
    const settled = receipt.operation.chunks.filter((chunk) => chunk.state === "settled").length;
    return {
      operationId: requestId,
      viewRevision: this.mintViewRevision(),
      kind: receipt.operation.kind,
      phase: "settled",
      status: receipt.outcome,
      cancelled: receipt.operation.cancelled || receipt.outcome === "cancellation",
      connectionLabel: binding.connectionLabel,
      model: binding.model,
      voice: binding.voice,
      plannedChunks: receipt.operation.planned,
      dispatchedChunks: settled,
      settledChunks: settled,
      unsentChunks: receipt.unsentChunks,
      charge: chargeViewOfReceipt(receipt),
      message: boundedMessage(receipt.failure),
      finalChunkOutcome: receipt.finalChunkOutcome
    };
  }

  private operation(operationId: number) {
    if (this.ledger.slots.stt?.operationId === operationId) return this.ledger.slots.stt;
    if (this.ledger.slots.tts?.operationId === operationId) return this.ledger.slots.tts;
    return null;
  }

  private key(operationId: number, chunkId: number): string {
    return `${operationId}:${chunkId}`;
  }
}
