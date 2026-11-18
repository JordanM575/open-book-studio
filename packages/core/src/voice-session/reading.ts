/**
 * In-memory paragraph cursor for one caller-supplied source.
 *
 * Paragraphs are the spoken text from `toSpeechText`, split on blank lines. The cursor keeps that
 * frozen list, an index, the source id, the revision, and a speed. It does not speak, select a voice,
 * or qualify a device or local engine. A refusal returns no cursor, so the caller keeps the previous one.
 */

import { toSpeechText } from "../speech-text";

/** The existing speaking-rate bounds, not a device measurement. */
export const MIN_READING_SPEED = 0.25;
/** The existing speaking-rate bounds, not a device measurement. */
export const MAX_READING_SPEED = 4;

const DEFAULT_READING_SPEED = 1;
const MAX_IDENTITY_UNITS = 2048;
const MAX_MARKDOWN_UNITS = 65_536;
const PARAGRAPH_BREAK = /\n(?:[ \t]*\n)+/;

export interface ReadingSource {
  readonly sourceId: string;
  readonly revision: string;
  readonly markdown: string;
}

export interface ReadingCursor {
  readonly sourceId: string;
  readonly revision: string;
  readonly paragraphs: readonly string[];
  readonly index: number;
  readonly speed: number;
}

export type ReadingBoundary = "start" | "end" | "none";

export type ReadingRefusal =
  | "empty-identity"
  | "oversize-identity"
  | "oversize-markdown"
  | "no-paragraph"
  | "invalid-speed"
  | "source-mismatch";

export type ReadingCursorResult =
  | { readonly ok: true; readonly cursor: ReadingCursor }
  | { readonly ok: false; readonly reason: ReadingRefusal };

export interface ReadingStep {
  readonly cursor: ReadingCursor;
  readonly boundary: ReadingBoundary;
}

function refuse(reason: ReadingRefusal): ReadingCursorResult {
  return { ok: false, reason };
}

/** Opaque identities are kept as supplied: not trimmed and not hashed. */
function identityReason(value: unknown): "empty-identity" | "oversize-identity" | null {
  if (typeof value !== "string" || value.length === 0) return "empty-identity";
  if (value.length > MAX_IDENTITY_UNITS) return "oversize-identity";
  return null;
}

function markdownReason(value: unknown): "oversize-markdown" | null {
  if (typeof value !== "string" || value.length > MAX_MARKDOWN_UNITS) return "oversize-markdown";
  return null;
}

function isQualifiedSpeed(speed: number): boolean {
  return Number.isFinite(speed) && speed >= MIN_READING_SPEED && speed <= MAX_READING_SPEED;
}

function spokenParagraphs(markdown: string): string[] {
  return toSpeechText(markdown)
    .split(PARAGRAPH_BREAK)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function sameParagraphs(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sourceProblem(source: ReadingSource): ReadingRefusal | null {
  return identityReason(source.sourceId) ?? identityReason(source.revision) ?? markdownReason(source.markdown);
}

function cursorAt(cursor: ReadingCursor, index: number, speed: number = cursor.speed): ReadingCursor {
  return Object.freeze({
    sourceId: cursor.sourceId,
    revision: cursor.revision,
    paragraphs: cursor.paragraphs,
    index,
    speed,
  });
}

export function startReading(source: ReadingSource, speed: number = DEFAULT_READING_SPEED): ReadingCursorResult {
  const problem = sourceProblem(source);
  if (problem) return refuse(problem);
  if (!isQualifiedSpeed(speed)) return refuse("invalid-speed");
  const paragraphs = spokenParagraphs(source.markdown);
  if (paragraphs.length === 0) return refuse("no-paragraph");
  return {
    ok: true,
    cursor: Object.freeze({
      sourceId: source.sourceId,
      revision: source.revision,
      paragraphs: Object.freeze(paragraphs),
      index: 0,
      speed,
    }),
  };
}

/** Moves inside the frozen list. The ends stay put and never wrap. */
export function stepReading(cursor: ReadingCursor, direction: "next" | "previous"): ReadingStep {
  if (direction === "previous") {
    if (cursor.index <= 0) return { cursor: cursorAt(cursor, cursor.index), boundary: "start" };
    return { cursor: cursorAt(cursor, cursor.index - 1), boundary: "none" };
  }
  const last = cursor.paragraphs.length - 1;
  if (cursor.index >= last) return { cursor: cursorAt(cursor, cursor.index), boundary: "end" };
  return { cursor: cursorAt(cursor, cursor.index + 1), boundary: "none" };
}

/** A speed outside the speaking-rate bounds is refused. It is not clamped. */
export function setReadingSpeed(cursor: ReadingCursor, speed: number): ReadingCursorResult {
  if (!isQualifiedSpeed(speed)) return refuse("invalid-speed");
  return { ok: true, cursor: cursorAt(cursor, cursor.index, speed) };
}

/**
 * Continues only when the source id, revision, and every paragraph string match.
 * A mismatch does not retarget or rebuild the cursor.
 */
export function followReading(cursor: ReadingCursor, source: ReadingSource): ReadingCursorResult {
  const problem = sourceProblem(source);
  if (problem) return refuse(problem);
  const paragraphs = spokenParagraphs(source.markdown);
  if (paragraphs.length === 0) return refuse("no-paragraph");
  const sameSource = source.sourceId === cursor.sourceId && source.revision === cursor.revision;
  if (!sameSource || !sameParagraphs(cursor.paragraphs, paragraphs)) return refuse("source-mismatch");
  return { ok: true, cursor };
}
