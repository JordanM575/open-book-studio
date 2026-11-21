import { formatUsd } from "@ai-book-studio/core/providers/usage";
import type { VoiceChargeView, VoiceOperationView } from "@ai-book-studio/core/ipc";

/*
 * The renderer-safe wording for a voice request's receipt.
 *
 * The charged facts come from the host's VoiceOperationView; this module only words them. It
 * never invents a number, never calls an unknown charge zero, and never claims a provider was
 * told to stop. A dispatched request whose charge is unknown stays unknown in every phrasing.
 */

/** The exact charge sentence for a receipt charge view. */
export function voiceChargeCopy(charge: VoiceChargeView): string {
  switch (charge.state) {
    case "pending":
      return "Cost not reported yet.";
    case "none":
      return "No provider charge: no request was sent.";
    case "reported":
      return `Provider-reported cost: ${formatUsd(charge.usd)}.`;
    case "unknown":
      return "Cost unknown: the provider did not report a charge, so whether this request cost anything is unknown.";
    case "mixed":
      return `Provider-reported cost: ${formatUsd(charge.reportedUsd)} for the requests that reported one; ${charge.unknownChunks} did not, so the total is unknown.`;
  }
}

/** Appended when only some planned requests were sent; distinguishes "not sent" from "unpriced". */
function unsentSuffix(view: VoiceOperationView): string {
  if (view.unsentChunks > 0 && view.settledChunks > 0) return ` ${view.unsentChunks} requests were not sent.`;
  return "";
}

function chargeSentence(view: VoiceOperationView): string {
  const charge = view.charge;
  if (charge.state === "reported") return `The provider later reported ${formatUsd(charge.usd)} for it.`;
  if (charge.state === "mixed") {
    return `Provider-reported cost: ${formatUsd(charge.reportedUsd)} for the requests that reported one; ${charge.unknownChunks} did not, so the total is unknown.`;
  }
  if (charge.state === "unknown") {
    if (view.finalChunkOutcome === "failure") {
      return "A later reply failed, so whether it cost anything is unknown.";
    }
    if (view.kind === "tts" && view.dispatchedChunks < view.plannedChunks) {
      return "Whether it cost anything is unknown.";
    }
    return "The local request was aborted, but the provider may still have received it. Whether it cost anything is unknown.";
  }
  if (charge.state === "none") return "No provider charge: no request was sent.";
  return "Cost not reported yet.";
}

/** The receipt line shown under the dictation and speaking controls. */
export function voiceReceiptLine(view: VoiceOperationView): string {
  const unsent = unsentSuffix(view);
  switch (view.status) {
    case null:
      return voiceChargeCopy(view.charge);
    case "success":
      return `${voiceChargeCopy(view.charge)}${unsent}`;
    case "refusal": {
      const reason = view.message?.trim() || "The request was refused.";
      if (view.dispatchedChunks === 0) return `${reason} No request was sent.${unsent}`;
      // Some parts went out before the refusal; say so instead of claiming nothing was sent.
      return `${reason} The parts already made were not played. ${voiceChargeCopy(view.charge)}${unsent}`;
    }
    case "failure": {
      const reason = view.message?.trim() || "The request failed.";
      // A timeout message already carries the unknown-cost caveat; don't stutter.
      if (view.charge.state === "unknown" && /cost is unknown\.?$/i.test(reason)) return `${reason}${unsent}`;
      return `${reason} ${voiceChargeCopy(view.charge)}${unsent}`;
    }
    case "cancellation": {
      if (view.dispatchedChunks === 0) {
        return "Stopped before sending. No request was sent and there is no provider charge.";
      }
      if (view.kind === "tts" && view.dispatchedChunks < view.plannedChunks) {
        const base = `Stopped after ${view.dispatchedChunks} of ${view.plannedChunks} parts were requested. The parts already made were not played.`;
        return `${base} ${chargeSentence(view)}${unsent}`;
      }
      return `Stopped after the request was sent. ${chargeSentence(view)}${unsent}`;
    }
  }
}

/** Playback stopped after the speech had already settled; no new provider request is implied. */
export function playbackStoppedLine(view: VoiceOperationView | null): string {
  const charge = view ? voiceChargeCopy(view.charge) : null;
  return charge
    ? `Stopped playing. No further provider request was made. ${charge}`
    : "Stopped playing. No further provider request was made.";
}

/**
 * True when this receipt describes a request that may have reached a provider.
 * Used to keep "unknown" visible instead of letting a settled receipt read as free.
 */
export function receiptHasUnknownCharge(view: VoiceOperationView): boolean {
  return view.charge.state === "unknown" || view.charge.state === "mixed";
}
