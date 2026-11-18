import { rewrite, sameValue } from "../library/book-merge";
import {
  AGENT_PART_TYPES,
  AGENT_PLAN_STATUSES,
  AGENT_PLAN_STEP_STATES,
  agentThreadSchema,
  type AgentThread
} from "./messages";

/**
 * Raw conversation documents.
 *
 * Thread files are ordinary JSON the author can read. A checked save must therefore keep every
 * supported unknown plain field and must refuse a document it cannot round-trip rather than silently
 * normalize it. This module owns that raw boundary: exact-byte parsing, the D-113 materialization
 * ceiling, v1 read compatibility, future/unknown semantic refusal and a merge that only rewrites the
 * fields a caller actually changed. It touches no storage; `ThreadStore` commits the bytes it returns.
 */

/** D-113 materialization ceiling for an existing ordinary conversation document. */
export const THREAD_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;
/** Parser depth selected for new workflow records; reused so a hostile thread cannot exhaust it. */
export const THREAD_DOCUMENT_MAX_DEPTH = 64;

export type ThreadDocumentErrorCode = "corrupt" | "newer" | "unsupported" | "too-large" | "io";

export class ThreadDocumentError extends Error {
  constructor(
    readonly code: ThreadDocumentErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ThreadDocumentError";
  }
}

export interface ThreadDocument {
  thread: AgentThread;
  raw: Record<string, unknown>;
  text: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface BuiltThreadDocument {
  raw: Record<string, unknown>;
  text: string;
  bytes: Uint8Array;
  /** True when the request changes no supported content, so the stored file is returned unchanged. */
  unchanged: boolean;
}

const KNOWN_PART_TYPES = new Set<string>(AGENT_PART_TYPES);
const KNOWN_ROLES = new Set(["user", "assistant"]);
const KNOWN_PLAN_STATUSES = new Set<string>(AGENT_PLAN_STATUSES);
const KNOWN_PLAN_STEP_STATES = new Set<string>(AGENT_PLAN_STEP_STATES);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail(code: ThreadDocumentErrorCode, message?: string): never {
  throw new ThreadDocumentError(code, message ?? "That conversation could not be read. The file was left untouched.");
}

/** A thread file is one plain JSON object; arrays, scalars and null are not conversations. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseThreadDocument(raw: unknown): AgentThread {
  if (!isRecord(raw)) fail("corrupt");
  const version = raw.schemaVersion;
  if (version !== undefined && version !== 1) {
    if (typeof version === "number" && Number.isSafeInteger(version) && version > 1) {
      fail(
        "newer",
        "That conversation was written by a newer version of Open Book Studio. Update the app to open it. The file was left untouched."
      );
    }
    fail("corrupt");
  }
  assertSupportedSemantics(raw);
  try {
    return agentThreadSchema.parse(raw);
  } catch {
    fail("corrupt");
  }
}

/**
 * A v1 document may carry unknown plain fields everywhere, and the merge keeps them. An unknown
 * member of a closed semantic union (a message role, a part type, a plan status or a plan step
 * state) is different: this build cannot honestly rewrite it, so the document is read-only and
 * reported rather than relabelled as corrupt. A malformed plan is still plain `corrupt`.
 */
function assertSupportedSemantics(raw: Record<string, unknown>): void {
  const messages = raw.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      if (typeof message.role === "string" && !KNOWN_ROLES.has(message.role)) {
        fail(
          "unsupported",
          "That conversation has a message role this version of Open Book Studio does not understand. Update the app to open it. The file was left untouched."
        );
      }
      if (!Array.isArray(message.parts)) continue;
      for (const part of message.parts) {
        if (!isRecord(part) || typeof part.type !== "string") continue;
        if (!KNOWN_PART_TYPES.has(part.type)) {
          fail(
            "unsupported",
            "That conversation has a part this version of Open Book Studio does not understand. Update the app to open it. The file was left untouched."
          );
        }
      }
    }
  }

  const plans = raw.plans;
  if (!Array.isArray(plans)) return;
  for (const plan of plans) {
    if (!isRecord(plan)) continue;
    if (typeof plan.status === "string" && !KNOWN_PLAN_STATUSES.has(plan.status)) {
      fail(
        "unsupported",
        "That conversation has a plan state this version of Open Book Studio does not understand. Update the app to open it. The file was left untouched."
      );
    }
    if (!Array.isArray(plan.steps)) continue;
    for (const step of plan.steps) {
      if (!isRecord(step) || typeof step.state !== "string") continue;
      if (!KNOWN_PLAN_STEP_STATES.has(step.state)) {
        fail(
          "unsupported",
          "That conversation has a plan step state this version of Open Book Studio does not understand. Update the app to open it. The file was left untouched."
        );
      }
    }
  }
}

export function readThreadDocument(input: {
  bytes: Uint8Array;
  sha256: string;
  maxBytes?: number;
}): ThreadDocument {
  const limit = input.maxBytes ?? THREAD_DOCUMENT_MAX_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 0) fail("io", "The conversation size limit is not valid.");
  if (input.bytes.byteLength > limit) {
    fail(
      "too-large",
      `That conversation is larger than the ${sizeText(limit)} this version can open. The file was left untouched.`
    );
  }
  const text = decodeThreadText(input.bytes);
  const raw = parseThreadJson(text);
  return {
    thread: parseThreadDocument(raw),
    raw: raw as Record<string, unknown>,
    text,
    bytes: input.bytes,
    sha256: input.sha256
  };
}

/**
 * Build the exact bytes for the next revision. When `previous` is present, only fields whose
 * supported value changed are replaced; unknown fields other writers added keep their places. An
 * unchanged body returns the stored bytes and a flag instead of a new timestamp, so a no-op save is
 * not a write.
 */
export function buildThreadDocument(
  previous: ThreadDocument | null,
  next: AgentThread,
  updatedAt: string,
  maxBytes: number = THREAD_DOCUMENT_MAX_BYTES
): BuiltThreadDocument {
  const parsed = agentThreadSchema.parse(next);
  if (!previous) {
    const raw = { ...parsed, updatedAt } as Record<string, unknown>;
    return finish(raw, maxBytes);
  }
  // A body that did not change keeps the stored timestamp and bytes: no write, no timestamp churn.
  const sameBody = rewrite(previous.raw, previous.thread, {
    ...parsed,
    updatedAt: previous.thread.updatedAt
  });
  if (sameValue(previous.raw, sameBody)) {
    return { raw: previous.raw, text: previous.text, bytes: previous.bytes, unchanged: true };
  }
  const raw = rewrite(previous.raw, previous.thread, { ...parsed, updatedAt }) as Record<string, unknown>;
  return finish(raw, maxBytes);
}

function assertWellFormed(value: unknown): void {
  if (typeof value === "string") {
    wellFormed(value);
    return;
  }
  if (typeof value === "number") {
    // The reader refuses these; publishing them would make the conversation unreadable.
    requireValue(Number.isFinite(value) && !Object.is(value, -0) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertWellFormed(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) assertWellFormed(item);
  }
}

function finish(raw: Record<string, unknown>, maxBytes: number): BuiltThreadDocument {
  // A lone surrogate survives JSON escaping but is rejected on read; refuse it before publishing,
  // wherever it sits (title, message text, tool output, metadata).
  assertWellFormed(raw);
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  const bytes = encoder.encode(text);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail("io", "The conversation size limit is not valid.");
  if (bytes.byteLength <= maxBytes) {
    // Publish only bytes this build's own reader accepts: the cheapest proof that a generated
    // document cannot replace a previously readable conversation with an unreadable one.
    try { readThreadDocument({ bytes, sha256: "" }); } catch { fail("corrupt"); }
  }
  if (bytes.byteLength > maxBytes) {
    fail(
      "too-large",
      `That conversation is larger than the ${sizeText(maxBytes)} this version can save. Nothing was written.`
    );
  }
  return { raw, text, bytes, unchanged: false };
}

function sizeText(limit: number): string {
  return limit >= 1024 * 1024 ? `${Math.round(limit / (1024 * 1024))} MiB` : `${limit} bytes`;
}

function decodeThreadText(bytes: Uint8Array): string {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("corrupt", "That conversation starts with a byte-order mark. The file was left untouched.");
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    fail("corrupt", "That conversation is not valid UTF-8. The file was left untouched.");
  }
  if (text.charCodeAt(0) === 0xfeff) {
    fail("corrupt", "That conversation starts with a byte-order mark. The file was left untouched.");
  }
  return text;
}

/* --------------------------------------------------------------- lossless JSON parsing */

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

function requireValue(condition: unknown): void {
  if (!condition) fail("corrupt");
}

function wellFormed(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index);
      requireValue(low >= 0xdc00 && low <= 0xdfff);
    } else {
      requireValue(unit < 0xdc00 || unit > 0xdfff);
    }
  }
}

/** Exact decimal identity for a JSON number token, without first rounding it through a double. */
function decimalValue(token: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const digits = `${match[2] ?? ""}${fraction}`.replace(/^0+/, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/, "");
  const power = Number(match[4] ?? 0) - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(power)) return null;
  return `${match[1] ?? ""}${significant}e${power}`;
}

function losslessNumber(token: string): number {
  const value = Number(token);
  requireValue(
    Number.isFinite(value) &&
      !Object.is(value, -0) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER &&
      decimalValue(token) === decimalValue(String(value))
  );
  return value;
}

class Reader {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.space();
    const value = this.value(0);
    this.space();
    requireValue(this.index === this.source.length);
    return value;
  }

  private space(): void {
    while (WHITESPACE.has(this.source.charCodeAt(this.index))) this.index++;
  }

  private value(depth: number): unknown {
    requireValue(depth <= THREAD_DOCUMENT_MAX_DEPTH);
    this.space();
    const code = this.source.charCodeAt(this.index);
    if (code === 0x7b) return this.object(depth);
    if (code === 0x5b) return this.array(depth);
    if (code === 0x22) return this.string();
    if (code === 0x74) {
      this.literal("true");
      return true;
    }
    if (code === 0x66) {
      this.literal("false");
      return false;
    }
    if (code === 0x6e) {
      this.literal("null");
      return null;
    }
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) return this.number();
    fail("corrupt");
  }

  private object(depth: number): Record<string, unknown> {
    this.index++;
    this.space();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (this.source.charCodeAt(this.index) === 0x7d) {
      this.index++;
      return result;
    }
    for (;;) {
      this.space();
      requireValue(this.source.charCodeAt(this.index) === 0x22);
      const key = this.string();
      // JSON would keep the last duplicate silently; a checked document must not choose for the author.
      requireValue(!keys.has(key));
      keys.add(key);
      this.space();
      requireValue(this.source.charCodeAt(this.index) === 0x3a);
      this.index++;
      const value = this.value(depth + 1);
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      this.space();
      const code = this.source.charCodeAt(this.index);
      if (code === 0x2c) {
        this.index++;
        continue;
      }
      requireValue(code === 0x7d);
      this.index++;
      return result;
    }
  }

  private array(depth: number): unknown[] {
    this.index++;
    this.space();
    const result: unknown[] = [];
    if (this.source.charCodeAt(this.index) === 0x5d) {
      this.index++;
      return result;
    }
    for (;;) {
      result.push(this.value(depth + 1));
      this.space();
      const code = this.source.charCodeAt(this.index);
      if (code === 0x2c) {
        this.index++;
        continue;
      }
      requireValue(code === 0x5d);
      this.index++;
      return result;
    }
  }

  private string(): string {
    requireValue(this.source.charCodeAt(this.index) === 0x22);
    this.index++;
    let result = "";
    for (;;) {
      requireValue(this.index < this.source.length);
      const code = this.source.charCodeAt(this.index++);
      if (code === 0x22) {
        wellFormed(result);
        return result;
      }
      if (code === 0x5c) {
        requireValue(this.index < this.source.length);
        const escapeCode = this.source.charCodeAt(this.index++);
        if (escapeCode === 0x22) result += '"';
        else if (escapeCode === 0x5c) result += "\\";
        else if (escapeCode === 0x2f) result += "/";
        else if (escapeCode === 0x62) result += "\b";
        else if (escapeCode === 0x66) result += "\f";
        else if (escapeCode === 0x6e) result += "\n";
        else if (escapeCode === 0x72) result += "\r";
        else if (escapeCode === 0x74) result += "\t";
        else if (escapeCode === 0x75) {
          requireValue(this.index + 4 <= this.source.length);
          const hex = this.source.slice(this.index, this.index + 4);
          requireValue(/^[0-9a-fA-F]{4}$/.test(hex));
          result += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
        } else fail("corrupt");
      } else {
        requireValue(code >= 0x20);
        result += String.fromCharCode(code);
      }
    }
  }

  private literal(word: string): void {
    requireValue(this.source.startsWith(word, this.index));
    this.index += word.length;
  }

  private number(): number {
    const start = this.index;
    if (this.source.charCodeAt(this.index) === 0x2d) this.index++;
    const first = this.source.charCodeAt(this.index);
    if (first === 0x30) this.index++;
    else {
      requireValue(first >= 0x31 && first <= 0x39);
      while (this.digit(this.source.charCodeAt(this.index))) this.index++;
    }
    if (this.source.charCodeAt(this.index) === 0x2e) {
      this.index++;
      requireValue(this.digit(this.source.charCodeAt(this.index)));
      while (this.digit(this.source.charCodeAt(this.index))) this.index++;
    }
    const exponent = this.source.charCodeAt(this.index);
    if (exponent === 0x65 || exponent === 0x45) {
      this.index++;
      const sign = this.source.charCodeAt(this.index);
      if (sign === 0x2b || sign === 0x2d) this.index++;
      requireValue(this.digit(this.source.charCodeAt(this.index)));
      while (this.digit(this.source.charCodeAt(this.index))) this.index++;
    }
    const token = this.source.slice(start, this.index);
    const next = this.source.charCodeAt(this.index);
    requireValue(
      Number.isNaN(next) || WHITESPACE.has(next) || next === 0x2c || next === 0x5d || next === 0x7d
    );
    return losslessNumber(token);
  }

  private digit(code: number): boolean {
    return code >= 0x30 && code <= 0x39;
  }
}

function parseThreadJson(text: string): unknown {
  try {
    return new Reader(text).parse();
  } catch (error) {
    if (error instanceof ThreadDocumentError) throw error;
    fail("corrupt");
  }
}
