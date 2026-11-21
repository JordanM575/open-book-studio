import { describe, expect, test } from "bun:test";
import type { VoiceOperationView } from "@ai-book-studio/core/ipc";
import { voiceChargeCopy, voiceReceiptLine, playbackStoppedLine, receiptHasUnknownCharge } from "@ai-book-studio/app/lib/voice-receipt";

/*
 * The exact words the author reads under the mic and the speaker. These strings are part of
 * the product: unknown must never render as zero, and a stop is never dressed up as a failure.
 */

function view(overrides: Partial<VoiceOperationView> = {}): VoiceOperationView {
  return {
    operationId: 1,
    viewRevision: 1,
    kind: "stt",
    phase: "settled",
    status: "success",
    cancelled: false,
    connectionLabel: "Meta",
    model: "muse-voice-transcribe-1.0",
    voice: null,
    plannedChunks: 1,
    dispatchedChunks: 1,
    settledChunks: 1,
    unsentChunks: 0,
    charge: { state: "reported", usd: 0 },
    message: null,
    finalChunkOutcome: "success",
    ...overrides
  };
}

describe("charge copy", () => {
  test("pending, none, reported, unknown and mixed render exactly", () => {
    expect(voiceChargeCopy({ state: "pending" })).toBe("Cost not reported yet.");
    expect(voiceChargeCopy({ state: "none" })).toBe("No provider charge: no request was sent.");
    expect(voiceChargeCopy({ state: "reported", usd: 0 })).toBe("Provider-reported cost: $0.00.");
    expect(voiceChargeCopy({ state: "reported", usd: 1.25 })).toBe("Provider-reported cost: $1.25.");
    expect(voiceChargeCopy({ state: "unknown" })).toBe(
      "Cost unknown: the provider did not report a charge, so whether this request cost anything is unknown."
    );
    expect(voiceChargeCopy({ state: "mixed", reportedUsd: 1.5, unknownChunks: 2 })).toBe(
      "Provider-reported cost: $1.50 for the requests that reported one; 2 did not, so the total is unknown."
    );
  });

  test("unknown and mixed copy never reads as free or capped", () => {
    for (const charge of [
      { state: "unknown" } as const,
      { state: "mixed", reportedUsd: 0.5, unknownChunks: 1 } as const
    ]) {
      expect(voiceChargeCopy(charge)).not.toMatch(/free|\$0\.00|cap|budget/i);
    }
  });

  test("a reported zero is rendered as a reported zero, never as free", () => {
    const line = voiceReceiptLine(view({ charge: { state: "reported", usd: 0 } }));
    expect(line).toBe("Provider-reported cost: $0.00.");
    expect(line).not.toMatch(/free/i);
  });
});

describe("receipt lines", () => {
  test("a success prints the charge and nothing invented", () => {
    expect(voiceReceiptLine(view({ charge: { state: "reported", usd: 0.013 } }))).toBe(
      "Provider-reported cost: $0.013."
    );
    expect(voiceReceiptLine(view({ charge: { state: "none" } }))).toBe(
      "No provider charge: no request was sent."
    );
    expect(voiceReceiptLine(view({ charge: { state: "unknown" } }))).toBe(
      "Cost unknown: the provider did not report a charge, so whether this request cost anything is unknown."
    );
  });

  test("a before-send stop is a no-request, no-charge line", () => {
    const line = voiceReceiptLine(view({
      status: "cancellation",
      cancelled: true,
      phase: "settled",
      dispatchedChunks: 0,
      settledChunks: 0,
      unsentChunks: 1,
      charge: { state: "none" }
    }));
    expect(line).toBe("Stopped before sending. No request was sent and there is no provider charge.");
  });

  test("an after-send stop with no late report stays unknown", () => {
    const line = voiceReceiptLine(view({
      status: "cancellation",
      cancelled: true,
      finalChunkOutcome: "success",
      charge: { state: "unknown" }
    }));
    expect(line).toBe(
      "Stopped after the request was sent. The local request was aborted, but the provider may still have received it. Whether it cost anything is unknown."
    );
  });

  test("an after-send stop with a late report names the amount", () => {
    const line = voiceReceiptLine(view({
      status: "cancellation",
      cancelled: true,
      finalChunkOutcome: "success",
      charge: { state: "reported", usd: 0.25 }
    }));
    expect(line).toBe("Stopped after the request was sent. The provider later reported $0.250 for it.");
  });

  test("an after-send stop with a late failure says the reply failed", () => {
    const line = voiceReceiptLine(view({
      status: "cancellation",
      cancelled: true,
      finalChunkOutcome: "failure",
      charge: { state: "unknown" },
      message: null
    }));
    expect(line).toBe("Stopped after the request was sent. A later reply failed, so whether it cost anything is unknown.");
  });

  test("a tts run stopped between parts names the split and keeps the charge honest", () => {
    const line = voiceReceiptLine(view({
      kind: "tts",
      status: "cancellation",
      cancelled: true,
      plannedChunks: 3,
      dispatchedChunks: 1,
      settledChunks: 1,
      unsentChunks: 2,
      charge: { state: "unknown" },
      finalChunkOutcome: "success"
    }));
    expect(line).toBe(
      "Stopped after 1 of 3 parts were requested. The parts already made were not played. Whether it cost anything is unknown. 2 requests were not sent."
    );
  });

  test("a partial failure reports the shortfall without claiming the rest was sent", () => {
    const line = voiceReceiptLine(view({
      kind: "tts",
      status: "failure",
      plannedChunks: 3,
      dispatchedChunks: 2,
      settledChunks: 1,
      unsentChunks: 2,
      charge: { state: "unknown" },
      message: "The provider rejected this connection. Reconnect or check the key."
    }));
    expect(line).toContain("The provider rejected this connection. Reconnect or check the key.");
    expect(line).toContain("2 requests were not sent.");
  });

  test("a refusal after nothing was dispatched says no request was sent", () => {
    const line = voiceReceiptLine(view({
      status: "refusal",
      dispatchedChunks: 0,
      settledChunks: 0,
      unsentChunks: 1,
      charge: { state: "none" },
      message: "That transcription connection is unavailable. Choose another in Settings."
    }));
    expect(line).toBe("That transcription connection is unavailable. Choose another in Settings. No request was sent.");
  });

  test("a refusal after some parts went out never claims nothing was sent", () => {
    const line = voiceReceiptLine(view({
      kind: "tts",
      status: "refusal",
      plannedChunks: 3,
      dispatchedChunks: 1,
      settledChunks: 1,
      unsentChunks: 2,
      charge: { state: "unknown" },
      message: "The speaking selection or connection changed before the next part. Nothing more was sent."
    }));
    expect(line).toContain("Nothing more was sent.");
    expect(line).toContain("The parts already made were not played.");
    expect(line).not.toMatch(/No request was sent/);
    expect(line).toContain("2 requests were not sent.");
  });

  test("a timeout failure keeps the unknown-charge caveat exactly once", () => {
    const line = voiceReceiptLine(view({
      status: "failure",
      charge: { state: "unknown" },
      message: "The request timed out. It may have reached the provider; the cost is unknown."
    }));
    expect(line).toBe("The request timed out. It may have reached the provider; the cost is unknown.");
  });

  test("a reported zero on a failure is still a reported charge", () => {
    const line = voiceReceiptLine(view({
      status: "failure",
      charge: { state: "reported", usd: 0 },
      message: "The provider rejected this connection. Reconnect or check the key."
    }));
    expect(line).toBe("The provider rejected this connection. Reconnect or check the key. Provider-reported cost: $0.00.");
  });

  test("mixed charges never collapse into a single unknown", () => {
    const line = voiceReceiptLine(view({
      kind: "tts",
      status: "success",
      plannedChunks: 2,
      dispatchedChunks: 2,
      settledChunks: 2,
      unsentChunks: 0,
      charge: { state: "mixed", reportedUsd: 0.5, unknownChunks: 1 }
    }));
    expect(line).toBe("Provider-reported cost: $0.500 for the requests that reported one; 1 did not, so the total is unknown.");
    expect(receiptHasUnknownCharge(view({ charge: { state: "mixed", reportedUsd: 0.5, unknownChunks: 1 } }))).toBe(true);
  });

  test("playback stop keeps the settled receipt and says nothing new was sent", () => {
    const settled = view({ charge: { state: "reported", usd: 0.75 } });
    expect(playbackStoppedLine(settled)).toBe(
      "Stopped playing. No further provider request was made. Provider-reported cost: $0.750."
    );
    expect(playbackStoppedLine(null)).toBe("Stopped playing. No further provider request was made.");
  });
});
