import type { VoiceCancelReceipt } from "@ai-book-studio/core/ipc";
import {
  initialTransportLedger,
  reduceTransport,
  type TransportFacts,
  type TransportKind,
  type TransportLedger,
  type TransportOutcome
} from "../../../../packages/core/src/voice-session";

/*
 * Main-process registry of cancellable speech-to-text and text-to-speech ids.
 *
 * The pure ledger decides identity, backpressure, the route and permission recheck, and the
 * settlement record. This owner executes the local half: one AbortController per chunk that the
 * ledger has actually admitted for send. The controller is created only after that send effect.
 * Begin, route, permission and clock stay with the host; the renderer can only cancel an id this
 * host minted.
 *
 * Cancellation is best-effort and local. The owned slot stays until the local outcome is
 * recorded. Nothing here claims a remote provider observed the cancel, and an unknown charge is
 * never rewritten to unsent or zero.
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

const DEFAULT_REASON = "Cancelled.";

export class VoiceCancelRegistry {
  private ledger: TransportLedger = initialTransportLedger();
  private readonly controllers = new Map<string, AbortController>();

  /** Frozen local accounting. It holds no abort handle and no provider claim. */
  accounting(): TransportLedger {
    return this.ledger;
  }

  /** Mint one operation for a host-supplied route, permission and clock. Null when refused. */
  begin(kind: TransportKind, planned: number, facts: TransportFacts): number | null {
    const minted = this.ledger.sequence + 1;
    const transition = reduceTransport(this.ledger, { type: "begin", kind, planned, facts });
    this.ledger = transition.ledger;
    return this.ledger.slots[kind]?.operationId === minted ? minted : null;
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

  private operation(operationId: number) {
    if (this.ledger.slots.stt?.operationId === operationId) return this.ledger.slots.stt;
    if (this.ledger.slots.tts?.operationId === operationId) return this.ledger.slots.tts;
    return null;
  }

  private key(operationId: number, chunkId: number): string {
    return `${operationId}:${chunkId}`;
  }
}
