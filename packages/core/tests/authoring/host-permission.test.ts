import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  AuthoringError, decodeHostPermission, encodeHostPermission, readHostPermission,
  type HostPermission, type HostPermissionDecodeOptions,
} from '../../src/authoring';

const owner = {
  libraryRegistration: 'lib_1',
  bookId: 'book_1',
  runId: 'run_1',
};
const hostId = 'host_1';
const policyDigest = 'ab'.repeat(32);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AuthoringError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

function descriptor(resume: HostPermission['resume'], patch: Partial<HostPermission> = {}): HostPermission {
  return {
    schemaVersion: 1,
    kind: 'host-permission',
    id: 'permit_1',
    hostId,
    policyDigest,
    generation: 1,
    expiresAt: '2026-11-07T00:00:00.000Z',
    revocation: 'none',
    resume,
    ...patch,
    owner: patch.owner ?? { ...owner },
  };
}

function options(extra: Partial<HostPermissionDecodeOptions> = {}): HostPermissionDecodeOptions {
  return { owner, hostId, ...extra };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('host permission descriptor', () => {
  test('round-trips continue and same-host in canonical bytes', () => {
    for (const resume of ['continue', 'same-host'] as const) {
      const bytes = encodeHostPermission(descriptor(resume));
      const encoded = text(bytes);
      expect(encoded.endsWith('\n')).toBe(false);
      expect(/\s/.test(encoded)).toBe(false);
      expect(encoded.startsWith('{"expiresAt":')).toBe(true);
      expect(encoded).toContain('"owner":{"bookId":"book_1","libraryRegistration":"lib_1","runId":"run_1"}');
      const decoded = decodeHostPermission(bytes, options({ expectedHash: sha256(bytes) }));
      expect(decoded).toEqual(descriptor(resume));
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(decoded.owner)).toBe(true);
      expect(text(encodeHostPermission(decoded))).toBe(encoded);
    }
  });

  test('accepts a non-canonical spelling and re-encodes canonically', () => {
    const canonical = encodeHostPermission(descriptor('continue'));
    const loose = `{
      "resume": "continue",
      "revocation": "none",
      "schemaVersion": 1,
      "kind": "host-permission",
      "id": "permit_1",
      "hostId": "host_1",
      "policyDigest": "${policyDigest}",
      "generation": 1,
      "expiresAt": "2026-11-07T00:00:00.000Z",
      "owner": { "runId": "run_1", "libraryRegistration": "lib_1", "bookId": "book_1" }
    }`;
    const looseBytes = new TextEncoder().encode(loose);
    expect(text(looseBytes)).not.toBe(text(canonical));
    const decoded = decodeHostPermission(looseBytes, options({ expectedHash: sha256(looseBytes) }));
    expect(decoded).toEqual(decodeHostPermission(canonical, options()));
    expect(text(encodeHostPermission(decoded))).toBe(text(canonical));
    expect(refusal(() => decodeHostPermission(looseBytes, options({ expectedHash: sha256(canonical) }))))
      .toBe('changed');
  });

  test('continue-required is not a refusal or an execution grant', () => {
    const record = decodeHostPermission(encodeHostPermission(descriptor('continue')), options());
    const instant = Date.parse(record.expiresAt);
    const reading = readHostPermission(record, instant - 1);
    expect(reading).toEqual({ outcome: 'continue-required' });
    expect(Object.keys(reading)).toEqual(['outcome']);
    expect(reading).not.toHaveProperty('execute');
    expect(reading).not.toHaveProperty('authorized');
    expect(reading).not.toHaveProperty('permission');
    expect(reading.outcome).not.toBe('refused');
  });

  test('fresh-work-only does not grant execution or a retry', () => {
    const record = decodeHostPermission(encodeHostPermission(descriptor('same-host')), options());
    const reading = readHostPermission(record, Date.parse(record.expiresAt) - 1);
    expect(reading).toEqual({ outcome: 'fresh-work-only' });
    expect(Object.keys(reading)).toEqual(['outcome']);
    expect(JSON.stringify(reading)).not.toContain('retry');
    expect(reading).not.toHaveProperty('execute');
    expect(reading).not.toHaveProperty('authorized');
    expect(reading).not.toHaveProperty('permission');
  });

  test('persist-failed refuses same-host auto-resume, including after expiry', () => {
    const record = decodeHostPermission(encodeHostPermission(descriptor('same-host', {
      revocation: 'persist-failed',
    })), options());
    const instant = Date.parse(record.expiresAt);
    expect(readHostPermission(record, instant - 1)).toEqual({
      outcome: 'refused', reason: 'revoke-persist-failed',
    });
    expect(readHostPermission(record, instant)).toEqual({
      outcome: 'refused', reason: 'revoke-persist-failed',
    });
  });

  test('refuses expiry at the instant, revocation, a foreign host or owner, and a changed hash', () => {
    const bytes = encodeHostPermission(descriptor('continue'));
    const record = decodeHostPermission(bytes, options());
    const instant = Date.parse(record.expiresAt);
    expect(readHostPermission(record, instant - 1).outcome).toBe('continue-required');
    expect(readHostPermission(record, instant)).toEqual({ outcome: 'refused', reason: 'expired' });
    expect(readHostPermission(record, instant + 1)).toEqual({ outcome: 'refused', reason: 'expired' });
    const revoked = decodeHostPermission(encodeHostPermission(descriptor('continue', {
      revocation: 'revoked',
    })), options());
    expect(readHostPermission(revoked, instant - 1)).toEqual({ outcome: 'refused', reason: 'revoked' });
    expect(refusal(() => decodeHostPermission(bytes, options({ hostId: 'host_2' })))).toBe('foreign-host');
    expect(refusal(() => decodeHostPermission(bytes, options({
      owner: { ...owner, bookId: 'book_2' },
    })))).toBe('foreign-owner');
    expect(refusal(() => decodeHostPermission(bytes, options({ expectedHash: 'cd'.repeat(32) }))))
      .toBe('changed');
    expect(decodeHostPermission(bytes, options()).id).toBe('permit_1');
  });

  test('refuses an extra key, a future schema, a duplicate key, a lossy number, a bad digest, a bad id, and a missing field', () => {
    const encoded = text(encodeHostPermission(descriptor('continue')));
    const withExtra = encoded.replace('"schemaVersion":1', '"schemaVersion":1,"prose":"no"');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(withExtra), options())))
      .toBe('unexpected-field');
    const nested = encoded.replace('"bookId":"book_1"', '"bookId":"book_1","credential":"no"');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(nested), options())))
      .toBe('unexpected-field');
    const future = encoded.replace('"schemaVersion":1', '"schemaVersion":2');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(future), options())))
      .toBe('unsupported-schema');
    const duplicate = encoded.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(duplicate), options())))
      .toBe('duplicate-key');
    const lossy = encoded.replace('"generation":1', '"generation":9007199254740993');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(lossy), options())))
      .toBe('lossy-number');
    const negativeZero = encoded.replace('"generation":1', '"generation":-0');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(negativeZero), options())))
      .toBe('lossy-number');
    const nan = encoded.replace('"generation":1', '"generation":NaN');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(nan), options())))
      .toBe('invalid-json');
    const infinity = encoded.replace('"generation":1', '"generation":Infinity');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(infinity), options())))
      .toBe('invalid-json');
    const badDigest = encoded.replace(policyDigest, 'ab');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(badDigest), options())))
      .toBe('invalid-digest');
    const badId = encoded.replace('"permit_1"', '"grant_1"');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(badId), options())))
      .toBe('invalid-id');
    const missing = encoded.replace('"generation":1,', '');
    expect(refusal(() => decodeHostPermission(new TextEncoder().encode(missing), options())))
      .toBe('missing-field');
  });

  test('refuses more than 4096 bytes before acceptance, including a supplied hash', () => {
    const over = new Uint8Array(4097);
    expect(refusal(() => decodeHostPermission(over, options({ expectedHash: sha256(over) }))))
      .toBe('record-overflow');
    const canonical = encodeHostPermission(descriptor('continue'));
    const padded = new Uint8Array(4096);
    padded.set(canonical);
    padded.fill(0x20, canonical.byteLength);
    expect(padded.byteLength).toBe(4096);
    expect(decodeHostPermission(padded, options()).id).toBe('permit_1');
    const tooWide = new Uint8Array(4097);
    tooWide.set(padded);
    tooWide[4096] = 0x20;
    expect(refusal(() => decodeHostPermission(tooWide, options({ expectedHash: 'ab'.repeat(32) }))))
      .toBe('record-overflow');
  });

  test('hashes the exact input bytes and does not claim unchanged bytes when the hash is omitted', () => {
    const empty = new Uint8Array();
    const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(refusal(() => decodeHostPermission(empty, options({ expectedHash: emptyHash }))))
      .toBe('invalid-json');
    expect(refusal(() => decodeHostPermission(empty, options({ expectedHash: 'ab'.repeat(32) }))))
      .toBe('changed');
    const bytes = encodeHostPermission(descriptor('same-host'));
    expect(decodeHostPermission(bytes, options()).resume).toBe('same-host');
    expect(sha256(bytes)).toMatch(/^[a-f0-9]{64}$/);
  });
});
