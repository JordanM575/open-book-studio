/**
 * Disposable in-memory pointers for one caller-supplied scope token.
 * A pointer is a book id, a display timestamp, and that token. This module
 * does not read a library, call a clock, or invoke the caller-supplied writer.
 */

/** Stable book id: `book_` and at least six letters, digits, or hyphens. */
const BOOK_ID = /^book_[A-Za-z0-9-]{6,}$/;

/** UTF-8 budget for the serialized recent-pointer list. Not an authored-record budget. */
export const RECENT_POINTER_BYTES = 2_500_000;

export const RECENT_EXPLICIT_INTENT = "explicit-navigation" as const;

export const RECENT_NON_EXPLICIT_INTENTS = [
  "listing",
  "refresh",
  "import",
  "onboarding",
  "review",
  "background-read",
] as const;

export type RecentIntentKind = typeof RECENT_EXPLICIT_INTENT | (typeof RECENT_NON_EXPLICIT_INTENTS)[number];

export const RECENT_REFUSALS = [
  "malformed",
  "not-explicit-navigation",
  "open-not-current",
  "intent-replayed",
  "missing-writer",
  "invalid-writer",
  "pointer-absent",
  "pointer-exceeds-budget",
  "scope-mismatch",
] as const;

export type RecentRefusal = (typeof RECENT_REFUSALS)[number];

export interface RecentPointer {
  readonly bookId: string;
  readonly openedAt: string;
  readonly scope: string;
}

export interface RecentWorkList {
  readonly scope: string;
  readonly pointers: readonly RecentPointer[];
  readonly consumedIntentIds: readonly string[];
}

export type RecentEmptyResult =
  | { readonly status: "ready"; readonly list: RecentWorkList }
  | { readonly status: "refused"; readonly reason: "malformed" };

export type RecentScopeResult =
  | { readonly status: "retained"; readonly list: RecentWorkList }
  | { readonly status: "replaced"; readonly list: RecentWorkList; readonly previous: RecentWorkList }
  | { readonly status: "refused"; readonly reason: RecentRefusal; readonly list: unknown };

export type RecentRecordResult =
  | { readonly status: "recorded"; readonly list: RecentWorkList }
  | { readonly status: "refused"; readonly reason: RecentRefusal; readonly list: unknown };

export type RecentDismissResult =
  | { readonly status: "dismissed"; readonly list: RecentWorkList }
  | { readonly status: "refused"; readonly reason: RecentRefusal; readonly list: unknown };

const encoder = new TextEncoder();

interface ParsedList {
  scope: string;
  pointers: RecentPointer[];
  consumedIntentIds: string[];
}

/** UTF-8 bytes of the pointer list only. Consumed intent ids are outside this budget. */
export function recentPointerBytes(pointers: readonly RecentPointer[]): number {
  return encoder.encode(serializePointers(pointers)).byteLength;
}

export function emptyRecentWork(scope: unknown): RecentEmptyResult {
  try {
    const token = scopeToken(scope);
    if (!token) return Object.freeze({ status: "refused", reason: "malformed" });
    return Object.freeze({ status: "ready", list: freezeList(token, [], []) });
  } catch {
    return Object.freeze({ status: "refused", reason: "malformed" });
  }
}

export function selectRecentScope(list: unknown, scope: unknown, writer?: unknown): RecentScopeResult {
  try {
    const parsed = parseList(list);
    if (!parsed) return refuse("malformed", list);
    const token = scopeToken(scope);
    if (!token) return refuse("malformed", list);
    if (token === parsed.scope) return Object.freeze({ status: "retained", list: list as RecentWorkList });
    const writerRefusal = inspectWriter(writer);
    if (writerRefusal) return refuse(writerRefusal, list);
    return Object.freeze({
      status: "replaced",
      list: freezeList(token, [], []),
      previous: list as RecentWorkList,
    });
  } catch {
    return refuse("malformed", list);
  }
}

export function recordRecentOpen(
  list: unknown,
  scope: unknown,
  intent: unknown,
  writer: unknown,
): RecentRecordResult {
  try {
    const parsed = parseList(list);
    if (!parsed) return refuse("malformed", list);
    const token = scopeToken(scope);
    if (!token) return refuse("malformed", list);
    if (token !== parsed.scope) return refuse("scope-mismatch", list);
    const writerRefusal = inspectWriter(writer);
    if (writerRefusal) return refuse(writerRefusal, list);
    const opened = parseIntent(intent);
    if (!opened) return refuse("malformed", list);
    if (opened.kind !== RECENT_EXPLICIT_INTENT) return refuse("not-explicit-navigation", list);
    if (!opened.openedSuccessfully || !opened.remainsCurrent) return refuse("open-not-current", list);
    if (parsed.consumedIntentIds.includes(opened.id)) return refuse("intent-replayed", list);
    const pointer: RecentPointer = { bookId: opened.bookId, openedAt: opened.openedAt, scope: parsed.scope };
    const retained = parsed.pointers.filter((entry) => entry.bookId !== pointer.bookId);
    const next = [pointer, ...retained];
    while (next.length > 1 && recentPointerBytes(next) > RECENT_POINTER_BYTES) next.pop();
    if (recentPointerBytes(next) > RECENT_POINTER_BYTES) return refuse("pointer-exceeds-budget", list);
    return Object.freeze({
      status: "recorded",
      list: freezeList(parsed.scope, next, [...parsed.consumedIntentIds, opened.id]),
    });
  } catch {
    return refuse("malformed", list);
  }
}

export function dismissRecentPointer(
  list: unknown,
  scope: unknown,
  bookId: unknown,
  writer: unknown,
): RecentDismissResult {
  try {
    const parsed = parseList(list);
    if (!parsed) return refuse("malformed", list);
    const token = scopeToken(scope);
    if (!token) return refuse("malformed", list);
    if (token !== parsed.scope) return refuse("scope-mismatch", list);
    const writerRefusal = inspectWriter(writer);
    if (writerRefusal) return refuse(writerRefusal, list);
    if (typeof bookId !== "string" || !BOOK_ID.test(bookId)) return refuse("malformed", list);
    if (!parsed.pointers.some((entry) => entry.bookId === bookId)) return refuse("pointer-absent", list);
    const pointers = parsed.pointers.filter((entry) => entry.bookId !== bookId);
    return Object.freeze({
      status: "dismissed",
      list: freezeList(parsed.scope, pointers, parsed.consumedIntentIds),
    });
  } catch {
    return refuse("malformed", list);
  }
}

function refuse(reason: RecentRefusal, list: unknown): {
  readonly status: "refused";
  readonly reason: RecentRefusal;
  readonly list: unknown;
} {
  return Object.freeze({ status: "refused", reason, list });
}

function scopeToken(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function inspectWriter(writer: unknown): "missing-writer" | "invalid-writer" | null {
  if (writer === undefined || writer === null) return "missing-writer";
  if (typeof writer !== "object") return "invalid-writer";
  try {
    const write = (writer as { write?: unknown }).write;
    if (typeof write !== "function") return "invalid-writer";
    return null;
  } catch {
    return "invalid-writer";
  }
}

interface OpenedIntent {
  id: string;
  kind: RecentIntentKind;
  bookId: string;
  openedAt: string;
  openedSuccessfully: boolean;
  remainsCurrent: boolean;
}

function parseIntent(value: unknown): OpenedIntent | null {
  const record = plain(value);
  if (!record) return null;
  if (!isIntentKind(record.kind)) return null;
  const kind = record.kind;
  if (kind !== RECENT_EXPLICIT_INTENT) {
    return {
      id: "",
      kind,
      bookId: "",
      openedAt: "",
      openedSuccessfully: false,
      remainsCurrent: false,
    };
  }
  const id = record.id;
  const bookId = record.bookId;
  const openedAt = record.openedAt;
  const openedSuccessfully = record.openedSuccessfully;
  const remainsCurrent = record.remainsCurrent;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof bookId !== "string" || !BOOK_ID.test(bookId)) return null;
  if (typeof openedAt !== "string") return null;
  if (typeof openedSuccessfully !== "boolean" || typeof remainsCurrent !== "boolean") return null;
  return { id, kind, bookId, openedAt, openedSuccessfully, remainsCurrent };
}

function parseList(value: unknown): ParsedList | null {
  const record = plain(value);
  if (!record) return null;
  if (!sameKeys(record, ["scope", "pointers", "consumedIntentIds"])) return null;
  const scope = scopeToken(record.scope);
  const pointers = record.pointers;
  const consumed = record.consumedIntentIds;
  if (!scope || !Array.isArray(pointers) || !Array.isArray(consumed)) return null;
  const parsedPointers: RecentPointer[] = [];
  const seenBooks = new Set<string>();
  for (const entry of pointers) {
    const pointer = plain(entry);
    if (!pointer || !sameKeys(pointer, ["bookId", "openedAt", "scope"])) return null;
    const bookId = pointer.bookId;
    const openedAt = pointer.openedAt;
    const pointerScope = pointer.scope;
    if (typeof bookId !== "string" || !BOOK_ID.test(bookId)) return null;
    if (typeof openedAt !== "string" || pointerScope !== scope) return null;
    if (seenBooks.has(bookId)) return null;
    seenBooks.add(bookId);
    parsedPointers.push({ bookId, openedAt, scope });
  }
  const consumedIntentIds: string[] = [];
  const seenIntents = new Set<string>();
  for (const id of consumed) {
    if (typeof id !== "string" || id.length === 0 || seenIntents.has(id)) return null;
    seenIntents.add(id);
    consumedIntentIds.push(id);
  }
  return { scope, pointers: parsedPointers, consumedIntentIds };
}

function isIntentKind(value: unknown): value is RecentIntentKind {
  if (value === RECENT_EXPLICIT_INTENT) return true;
  return typeof value === "string" && RECENT_NON_EXPLICIT_INTENTS.some((kind) => kind === value);
}

function plain(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  return value as Record<string, unknown>;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function serializePointers(pointers: readonly RecentPointer[]): string {
  return `[${pointers.map((pointer) =>
    `{"bookId":${JSON.stringify(pointer.bookId)},"openedAt":${JSON.stringify(pointer.openedAt)},"scope":${JSON.stringify(pointer.scope)}}`
  ).join(",")}]`;
}

function freezeList(scope: string, pointers: readonly RecentPointer[], consumedIntentIds: readonly string[]): RecentWorkList {
  return Object.freeze({
    scope,
    pointers: Object.freeze(pointers.map((pointer) => Object.freeze({
      bookId: pointer.bookId,
      openedAt: pointer.openedAt,
      scope: pointer.scope,
    }))),
    consumedIntentIds: Object.freeze([...consumedIntentIds]),
  });
}
