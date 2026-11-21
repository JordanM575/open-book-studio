import type { ManuscriptExportOutcome, ManuscriptExportReceipt } from "@ai-book-studio/core/ipc";
import type { SaveStatus } from "../components/ManuscriptEditor";

export type { ManuscriptExportOutcome, ManuscriptExportReceipt } from "@ai-book-studio/core/ipc";

/** A single-file export the author cancelled before publication; no file was written. */
export function isCancelledOutcome(
  outcome: string | ManuscriptExportOutcome | null
): outcome is Extract<ManuscriptExportOutcome, { status: "cancelled" }> {
  return typeof outcome === "object" && outcome !== null && "status" in outcome && outcome.status === "cancelled";
}

/** Retain path-only fixture compatibility; production IPC returns the shared receipt. */
export function exportReceipt(
  result: string | ManuscriptExportOutcome | null
): ManuscriptExportReceipt | null {
  if (result === null) return null;
  if (typeof result === "string") return { path: result, warnings: [] };
  if (isCancelledOutcome(result)) return null;
  return result;
}

/**
 * Why an export did not start: the open chapter's save did not confirm. One wording,
 * shared by the Format dialog and the workspace header export, so the author reads
 * the same sentence wherever they exported from.
 */
export function exportBlockedMessage(status: Exclude<SaveStatus, { kind: "saved" }>): string {
  switch (status.kind) {
    case "conflict":
      return "This chapter has a conflicting copy, so nothing was exported. Resolve the conflict, then export again.";
    case "error":
      return `Your latest change couldn't be saved, so nothing was exported. ${status.message}`;
    default:
      return "The chapter has not finished saving, so nothing was exported. Try the export again in a moment.";
  }
}
