import { sameOwner, validateOwner, type Owner } from './contracts';
import { digest, freeze, id, integer, requireValue, type Immutable } from './value';
import { canonicalWorkflowJson, parseWorkflowJsonBytes } from './wire';

/**
 * Schema-1 host-permission descriptor. No filesystem, library, clock, timer, or execution grant.
 * `canonicalWorkflowJson` and `parseWorkflowJsonBytes` come from the workflow codec and are not modified.
 */
export const HOST_PERMISSION_SCHEMA_VERSION = 1 as const;
export const HOST_PERMISSION_BYTE_LIMIT = 4096;

const RECORD_KEYS = [
  'expiresAt', 'generation', 'hostId', 'id', 'kind', 'owner', 'policyDigest', 'resume', 'revocation',
  'schemaVersion',
] as const;
const OWNER_KEYS = ['bookId', 'libraryRegistration', 'runId'] as const;

export type HostPermissionRevocation = 'none' | 'revoked' | 'persist-failed';
export type HostPermissionResume = 'continue' | 'same-host';

export interface HostPermission {
  readonly schemaVersion: 1;
  readonly kind: 'host-permission';
  readonly id: string;
  readonly owner: Owner;
  readonly hostId: string;
  readonly policyDigest: string;
  readonly generation: number;
  readonly expiresAt: string;
  readonly revocation: HostPermissionRevocation;
  readonly resume: HostPermissionResume;
}

export interface HostPermissionDecodeOptions {
  readonly owner: Owner;
  readonly hostId: string;
  readonly expectedHash?: string;
}

export type HostPermissionRead =
  | { readonly outcome: 'continue-required' }
  | { readonly outcome: 'fresh-work-only' }
  | { readonly outcome: 'refused'; readonly reason: 'revoked' | 'revoke-persist-failed' | 'expired' };

const encoder = new TextEncoder();

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** SHA-256 of the exact bytes. Synchronous and allocation-bounded; no host crypto import. */
function sha256(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const blocks = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(blocks);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(blocks - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(blocks - 4, bitLength >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < blocks; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const earlier = words[index - 15] ?? 0;
      const near = words[index - 2] ?? 0;
      const small = rotr(earlier, 7) ^ rotr(earlier, 18) ^ (earlier >>> 3);
      const large = rotr(near, 17) ^ rotr(near, 19) ^ (near >>> 10);
      words[index] = (((words[index - 16] ?? 0) + small + (words[index - 7] ?? 0) + large) >>> 0);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + sum1 + choose + (SHA256_K[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((part) => part.toString(16).padStart(8, '0')).join('');
}

function plainObject(value: unknown, code: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null, 'non-plain-value');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const own = Reflect.ownKeys(value);
  for (const key of keys) requireValue(Object.hasOwn(value, key), 'missing-field');
  for (const key of own) {
    requireValue(typeof key === 'string', 'symbol-property');
    requireValue((keys as readonly string[]).includes(key), 'unexpected-field');
  }
}

function data(value: Record<string, unknown>, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  requireValue(property && 'value' in property && property.enumerable, 'non-data-property');
  return property.value;
}

function timestamp(value: unknown): string {
  requireValue(typeof value === 'string', 'invalid-timestamp');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(value);
  requireValue(match !== null, 'invalid-timestamp');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const length = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  requireValue(month >= 1 && month <= 12 && day >= 1 && day <= length &&
    Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59, 'invalid-timestamp');
  return value;
}

/** Days since 1970-01-01. No clock and no `Date`. */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.trunc((shiftedYear >= 0 ? shiftedYear : shiftedYear - 399) / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function utcMilliseconds(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(value);
  requireValue(match !== null, 'invalid-timestamp');
  const days = daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3]));
  return integer(days * 86_400_000 + Number(match[4]) * 3_600_000 + Number(match[5]) * 60_000 +
    Number(match[6]) * 1_000 + Number(match[7]), Number.MIN_SAFE_INTEGER);
}

function closedRecord(value: unknown): HostPermission {
  const record = plainObject(value, 'invalid-record');
  exactKeys(record, RECORD_KEYS);
  const version = data(record, 'schemaVersion');
  requireValue(typeof version === 'number' && Number.isSafeInteger(version) && !Object.is(version, -0),
    'invalid-record');
  requireValue(version === HOST_PERMISSION_SCHEMA_VERSION, 'unsupported-schema');
  const kind = data(record, 'kind');
  requireValue(typeof kind === 'string', 'invalid-kind');
  requireValue(kind === 'host-permission', 'foreign-kind');
  const recordId = data(record, 'id');
  requireValue(typeof recordId === 'string' && recordId.startsWith('permit_'), 'invalid-id');
  id(recordId);
  const ownerRecord = plainObject(data(record, 'owner'), 'invalid-owner');
  exactKeys(ownerRecord, OWNER_KEYS);
  const owner: Owner = {
    libraryRegistration: ownerRecord.libraryRegistration as string,
    bookId: ownerRecord.bookId as string,
    runId: ownerRecord.runId as string,
  };
  validateOwner(owner);
  const hostId = data(record, 'hostId');
  requireValue(typeof hostId === 'string', 'invalid-id');
  id(hostId);
  const policyDigest = data(record, 'policyDigest');
  requireValue(typeof policyDigest === 'string', 'invalid-digest');
  digest(policyDigest);
  const generation = integer(data(record, 'generation'), 1);
  const expiresAt = timestamp(data(record, 'expiresAt'));
  const revocation = data(record, 'revocation');
  requireValue(revocation === 'none' || revocation === 'revoked' || revocation === 'persist-failed',
    'invalid-revocation');
  const resume = data(record, 'resume');
  requireValue(resume === 'continue' || resume === 'same-host', 'invalid-resume');
  return {
    schemaVersion: 1,
    kind: 'host-permission',
    id: recordId,
    owner,
    hostId,
    policyDigest,
    generation,
    expiresAt,
    revocation,
    resume,
  };
}

/** Parse one descriptor. A returned record is not execution permission. */
export function decodeHostPermission(bytes: Uint8Array,
  options: HostPermissionDecodeOptions): Immutable<HostPermission> {
  requireValue(bytes instanceof Uint8Array, 'invalid-bytes');
  requireValue(bytes.byteLength <= HOST_PERMISSION_BYTE_LIMIT, 'record-overflow');
  validateOwner(options.owner);
  requireValue(typeof options.hostId === 'string', 'invalid-id');
  id(options.hostId);
  if (options.expectedHash !== undefined) {
    requireValue(typeof options.expectedHash === 'string', 'invalid-digest');
    digest(options.expectedHash);
    requireValue(sha256(bytes) === options.expectedHash, 'changed');
  }
  const record = closedRecord(parseWorkflowJsonBytes(bytes));
  requireValue(sameOwner(record.owner, options.owner), 'foreign-owner');
  requireValue(record.hostId === options.hostId, 'foreign-host');
  return freeze(record);
}

/** Canonical compact JSON. Writes no file. */
export function encodeHostPermission(record: HostPermission): Uint8Array {
  const closed = closedRecord(record);
  const bytes = encoder.encode(canonicalWorkflowJson(closed));
  requireValue(bytes.byteLength <= HOST_PERMISSION_BYTE_LIMIT, 'record-overflow');
  return bytes;
}

/**
 * Restart reading only. Revocation closes the gate before expiry.
 * `fresh-work-only` is not a retry and not an execution grant.
 */
export function readHostPermission(record: HostPermission, nowMs: number): Immutable<HostPermissionRead> {
  const revocation = record.revocation;
  requireValue(revocation === 'none' || revocation === 'revoked' || revocation === 'persist-failed',
    'invalid-revocation');
  if (revocation === 'revoked') return freeze({ outcome: 'refused', reason: 'revoked' });
  if (revocation === 'persist-failed') return freeze({ outcome: 'refused', reason: 'revoke-persist-failed' });
  const resume = record.resume;
  requireValue(resume === 'continue' || resume === 'same-host', 'invalid-resume');
  const now = integer(nowMs, Number.MIN_SAFE_INTEGER);
  if (now >= utcMilliseconds(timestamp(record.expiresAt))) {
    return freeze({ outcome: 'refused', reason: 'expired' });
  }
  if (resume === 'continue') return freeze({ outcome: 'continue-required' });
  return freeze({ outcome: 'fresh-work-only' });
}
