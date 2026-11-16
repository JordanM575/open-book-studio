export interface TranscriptInsertion {
  text: string;
  caret: number;
}

/**
 * Insert dictated text at the start of a selection and keep the selected characters.
 * Returns null for an empty transcript so the editor can leave the chapter untouched.
 */
export function insertTranscript(
  text: string,
  transcript: string,
  start: number,
  end: number
): TranscriptInsertion | null {
  return placeTranscript(text, transcript, start, end, false);
}

/**
 * Replace only the selected range. An empty selection inserts, using the same spacing rules.
 * Returns null for an empty transcript so the editor can leave the chapter untouched.
 */
export function replaceTranscript(
  text: string,
  transcript: string,
  start: number,
  end: number
): TranscriptInsertion | null {
  return placeTranscript(text, transcript, start, end, true);
}

function placeTranscript(
  text: string,
  transcript: string,
  start: number,
  end: number,
  replace: boolean
): TranscriptInsertion | null {
  const clean = normalizeTranscript(transcript);
  if (clean === null) return null;
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const before = text.slice(0, from);
  const after = replace ? text.slice(to) : text.slice(from);
  const prefix = before && !clean.startsWith("\n") && !/\s$/.test(before) && !/[([{“‘]$/.test(before) ? " " : "";
  const suffix = after && !clean.endsWith("\n") && !/^\s/.test(after) && !/^[.,;:!?…)\]}%]/.test(after) ? " " : "";
  const inserted = `${prefix}${clean}${suffix}`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length
  };
}

/** CR and CRLF become LF. A line break stays; only a transcript with none collapses horizontal space. */
function normalizeTranscript(transcript: string): string | null {
  const normalized = transcript.replace(/\r\n?/g, "\n");
  if (normalized.includes("\n")) {
    const trimmed = normalized.replace(/^[^\S\n]+/, "").replace(/[^\S\n]+$/, "");
    return trimmed.length > 0 ? trimmed : null;
  }
  const clean = normalized.replace(/[^\S\n]+/g, " ").trim();
  return clean.length > 0 ? clean : null;
}
