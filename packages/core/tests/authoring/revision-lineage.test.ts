import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AdoptionReceipt } from '../../src/authoring/adoption-receipt';
import type { Owner, ReferenceKind } from '../../src/authoring/contracts';
import { verifyRevisionLineage, type SavedChapterToken } from '../../src/authoring/revision-lineage';
import { encodeWorkflowRecord, WORKFLOW_LIMITS, type WorkflowRecord } from '../../src/authoring/wire';
import { hash, owner, ref } from './fixtures';

const at = '2026-11-26T12:00:00.000Z';
const chapterId = 'ch_1';
const path = 'books/book_1/chapters/0001-bell.md';

function chapter(version: number, body: string) {
  const bytes = new TextEncoder().encode(`---\nid: ${chapterId}\nversion: ${version}\n---\n\n${body}\n`);
  const token: SavedChapterToken = {
    chapterId, path, version, hash: createHash('sha256').update(bytes).digest('hex'),
  };
  return { token, byteLength: bytes.byteLength };
}

function reference<K extends ReferenceKind>(kind: K, id: string, recordOwner: Owner) {
  return { ...ref(kind, id, 1), owner: recordOwner };
}

function confirmedEffect(
  saved: ReturnType<typeof chapter>, previous: SavedChapterToken | null, recordOwner: Owner = owner,
) {
  const { version, hash: resultHash } = saved.token;
  return {
    schemaVersion: 1, kind: 'effect', id: `effect_${version}`, owner: recordOwner, revision: 3,
    base: { kind: 'sha256', value: hash(version + 10), revision: 2 }, generation: 1,
    attempt: reference('attempt', `attempt_${version}`, recordOwner),
    candidate: reference('artifact', `artifact_${version}`, recordOwner),
    phase: 'confirmed',
    target: { kind: previous ? 'replace-chapter' : 'new-chapter', chapterId, path },
    intent: {
      at, baseVersion: previous?.version ?? 0, baseHash: previous?.hash ?? null,
      intendedHash: resultHash, intendedBytes: saved.byteLength,
      safety: previous ? reference('artifact', `artifact_safety_${version}`, recordOwner) : null,
    },
    receipt: { outcome: 'confirmed', at, resultVersion: version, resultHash },
    createdAt: at, updatedAt: at,
  } satisfies WorkflowRecord;
}

function adoption(effect: ReturnType<typeof confirmedEffect>): AdoptionReceipt {
  const { owner: recordOwner, candidate, receipt: { resultVersion, resultHash } } = effect;
  return {
    schemaVersion: 1, kind: 'adoption-receipt', id: `adoption_${resultVersion}`, owner: recordOwner,
    chapterId, candidate, resultVersion, resultHash,
    grant: reference('grant', 'grant_1', recordOwner),
    direction: reference('direction', 'direction_1', recordOwner),
    sequence: 2 * resultVersion, adoptedAt: at,
  };
}

const created = chapter(1, 'The bells rang.');
const revised = chapter(2, 'The bells fell.');
const origin = confirmedEffect(created, null);
const replacement = confirmedEffect(revised, created.token);
const originBytes = encodeWorkflowRecord(origin);
const replacementBytes = encodeWorkflowRecord(replacement);
const originAdoption = adoption(origin);
const replacementAdoption = adoption(replacement);
const effects = [originBytes, replacementBytes] as const;
const adoptions = [originAdoption, replacementAdoption] as const;

describe('revision lineage', () => {
  test('matches the exact saved token through confirmed creation and replacement', () => {
    expect(verifyRevisionLineage(owner, revised.token, effects, adoptions)).toBe(true);
    expect(verifyRevisionLineage(owner, revised.token, [replacementBytes, originBytes], adoptions)).toBe(true);
    expect(verifyRevisionLineage(owner, revised.token, effects, [replacementAdoption, originAdoption])).toBe(true);
  });

  test('requires a creation at version 1', () => {
    expect(verifyRevisionLineage(owner, created.token, [originBytes], [originAdoption])).toBe(true);
    expect(verifyRevisionLineage(owner, revised.token, [replacementBytes], [replacementAdoption])).toBe(false);
    const replacementWithoutCreation = confirmedEffect(created, created.token);
    expect(verifyRevisionLineage(owner, created.token,
      [encodeWorkflowRecord(replacementWithoutCreation)], [originAdoption])).toBe(false);
    const secondCreation = confirmedEffect(revised, null);
    expect(verifyRevisionLineage(owner, revised.token,
      [originBytes, encodeWorkflowRecord(secondCreation)], adoptions)).toBe(false);
    expect(verifyRevisionLineage(owner, created.token, [], [])).toBe(false);
  });

  test('requires one adoption for every version through the current token', () => {
    expect(verifyRevisionLineage(owner, revised.token, effects, [originAdoption])).toBe(false);
    expect(verifyRevisionLineage(owner, revised.token, [originBytes], adoptions)).toBe(false);
    const third = chapter(3, 'The bells broke.');
    const last = confirmedEffect(third, revised.token);
    const lastBytes = encodeWorkflowRecord(last);
    expect(verifyRevisionLineage(owner, third.token,
      [...effects, lastBytes], [...adoptions, adoption(last)])).toBe(true);
    expect(verifyRevisionLineage(owner, third.token, [originBytes, lastBytes],
      [originAdoption, adoption(last)])).toBe(false);
  });

  test('requires both predecessor version and predecessor raw hash', () => {
    for (const base of [{ baseVersion: 2 }, { baseHash: hash(91) }]) {
      const broken = { ...replacement, intent: { ...replacement.intent, ...base } };
      expect(verifyRevisionLineage(owner, revised.token,
        [originBytes, encodeWorkflowRecord(broken)], adoptions)).toBe(false);
    }
  });

  test('requires the same library registration, book and run in effects and adoptions', () => {
    for (const foreignOwner of [
      { ...owner, libraryRegistration: 'host_2' },
      { ...owner, bookId: 'book_2' },
      { ...owner, runId: 'run_2' },
    ]) {
      const foreign = confirmedEffect(revised, created.token, foreignOwner);
      expect(verifyRevisionLineage(owner, revised.token,
        [originBytes, encodeWorkflowRecord(foreign)], adoptions)).toBe(false);
      expect(verifyRevisionLineage(owner, revised.token, effects,
        [originAdoption, adoption(foreign)])).toBe(false);
    }
  });

  test('requires exact chapter ID and path at every link', () => {
    for (const change of [{ chapterId: 'ch_2' }, { path: path.replace('bell', 'Bell') }]) {
      const otherTarget = { ...replacement, target: { ...replacement.target, ...change } };
      expect(verifyRevisionLineage(owner, revised.token,
        [originBytes, encodeWorkflowRecord(otherTarget)], adoptions)).toBe(false);
      expect(verifyRevisionLineage(owner, { ...revised.token, ...change }, effects, adoptions)).toBe(false);
    }
    expect(verifyRevisionLineage(owner, revised.token, effects,
      [originAdoption, { ...replacementAdoption, chapterId: 'ch_2' }])).toBe(false);
  });

  test('requires a confirmed receipt path, when supplied, to match the target', () => {
    for (const savedAs of [path, path.replace('bell', 'other')]) {
      const effect = { ...replacement, receipt: { ...replacement.receipt, savedAs } };
      expect(verifyRevisionLineage(owner, revised.token,
        [originBytes, encodeWorkflowRecord(effect)], adoptions)).toBe(savedAs === path);
    }
  });

  test('matches the exact candidate reference in each adoption', () => {
    for (const change of [{ id: 'artifact_other' }, { revision: 2 }, { hash: hash(31) }]) {
      const different = { ...replacementAdoption, candidate: { ...replacementAdoption.candidate, ...change } };
      expect(verifyRevisionLineage(owner, revised.token, effects, [originAdoption, different])).toBe(false);
    }
  });

  test('requires distinct candidate references for different saved versions', () => {
    const repeated = { ...replacement, candidate: origin.candidate };
    expect(verifyRevisionLineage(owner, revised.token,
      [originBytes, encodeWorkflowRecord(repeated)], [originAdoption, adoption(repeated)])).toBe(false);

    const later = { ...replacement, candidate: { ...origin.candidate, revision: 2, hash: hash(30) } };
    expect(verifyRevisionLineage(owner, revised.token,
      [originBytes, encodeWorkflowRecord(later)], [originAdoption, adoption(later)])).toBe(true);
  });

  test('excludes preserved conflict copies from publication evidence', () => {
    const preservedEffect = { ...replacement, conflictMetadata: { preserved: true } };
    const preservedAdoption = { ...replacementAdoption, conflictMetadata: { preserved: true } };
    expect(verifyRevisionLineage(owner, revised.token,
      [originBytes, encodeWorkflowRecord(preservedEffect)], adoptions)).toBe(false);
    expect(verifyRevisionLineage(owner, revised.token, effects,
      [originAdoption, preservedAdoption])).toBe(false);

    const futureEffect = { ...replacement, futureField: 'retained' };
    const futureAdoption = { ...replacementAdoption, futureField: 'retained' };
    expect(verifyRevisionLineage(owner, revised.token,
      [originBytes, encodeWorkflowRecord(futureEffect)], [originAdoption, futureAdoption])).toBe(true);
  });

  test('pins the actual bounded typed-array window before decoding', () => {
    const backing = new Uint8Array(WORKFLOW_LIMITS.recordBytes + 2);
    const window = backing.subarray(1, -1);
    window.fill(0x20);
    window.set(originBytes);
    let reads = 0;
    for (const field of ['buffer', 'byteOffset', 'byteLength']) {
      Object.defineProperty(window, field, { get() { reads++; throw new Error('Unexpected metadata access'); } });
    }
    expect(verifyRevisionLineage(owner, created.token, [window], [originAdoption])).toBe(true);
    expect(reads).toBe(0);
    expect(verifyRevisionLineage(owner, created.token,
      [new Uint8Array(WORKFLOW_LIMITS.recordBytes + 1)], [originAdoption])).toBe(false);
  });

  test('matches the confirmed result to both adoption and publish intent', () => {
    const differentAdoption = { ...originAdoption, resultHash: hash(33) };
    expect(verifyRevisionLineage(owner, revised.token, effects, [differentAdoption, replacementAdoption]))
      .toBe(false);
    const differentIntent = { ...replacement, intent: { ...replacement.intent, intendedHash: hash(34) } };
    expect(verifyRevisionLineage(owner, revised.token,
      [originBytes, encodeWorkflowRecord(differentIntent)], adoptions)).toBe(false);
  });

  test('refuses ambiguous adoption versions, IDs and sequence order', () => {
    const duplicateVersion = { ...originAdoption, id: 'adoption_other', sequence: 3 };
    const duplicateId = { ...replacementAdoption, id: originAdoption.id };
    const duplicateSequence = { ...replacementAdoption, sequence: originAdoption.sequence };
    const reversedSequence = { ...replacementAdoption, sequence: originAdoption.sequence - 1 };
    for (const ambiguous of [duplicateVersion, duplicateId, duplicateSequence, reversedSequence]) {
      expect(verifyRevisionLineage(owner, revised.token, effects, [originAdoption, ambiguous])).toBe(false);
    }
  });

  test('refuses multiple effect records for a version or a repeated effect ID', () => {
    const duplicateVersion = { ...origin, id: 'effect_other' };
    const duplicateId = { ...replacement, id: origin.id };
    for (const ambiguous of [duplicateVersion, duplicateId]) {
      expect(verifyRevisionLineage(owner, revised.token,
        [originBytes, encodeWorkflowRecord(ambiguous)], adoptions)).toBe(false);
    }
  });

  test('refuses a matching observed result after uncertain publication', () => {
    const uncertain = { ...replacement, phase: 'uncertain',
      receipt: { ...replacement.receipt, outcome: 'uncertain', savedAs: path } };
    expect(verifyRevisionLineage(owner, revised.token,
      [originBytes, encodeWorkflowRecord(uncertain)], adoptions)).toBe(false);
  });

  test('requires both confirmation and retained publish intent', () => {
    const unconfirmed = { ...replacement, phase: 'publish-intent', receipt: null };
    const noIntent = { ...replacement, intent: null };
    for (const incomplete of [unconfirmed, noIntent]) {
      expect(verifyRevisionLineage(owner, revised.token,
        [originBytes, encodeWorkflowRecord(incomplete)], adoptions)).toBe(false);
    }
  });

  test('refuses the prior saved version and an equal-length manual edit at the same version', () => {
    expect(verifyRevisionLineage(owner, created.token, effects, adoptions)).toBe(false);
    const manual = chapter(2, 'The bells toll.');
    expect(manual.byteLength).toBe(revised.byteLength);
    expect(manual.token.hash).not.toBe(revised.token.hash);
    expect(verifyRevisionLineage(owner, manual.token, effects, adoptions)).toBe(false);
  });

  test('refuses malformed raw effects and adoption receipts', () => {
    const validJson = new TextDecoder().decode(replacementBytes);
    const duplicateKey = new TextEncoder().encode(`{"kind":"effect",${validJson.slice(1)}`);
    expect(verifyRevisionLineage(owner, revised.token, [originBytes, duplicateKey], adoptions)).toBe(false);
    expect(verifyRevisionLineage(owner, revised.token, effects,
      [originAdoption, { ...replacementAdoption, resultHash: 'invalid' }])).toBe(false);
  });

  test('refuses evidence stored behind an accessor without invoking it', () => {
    let reads = 0;
    const supplied = [originBytes, replacementBytes];
    Object.defineProperty(supplied, 1, { get() { reads++; return replacementBytes; } });
    expect(verifyRevisionLineage(owner, revised.token, supplied, adoptions)).toBe(false);
    expect(reads).toBe(0);
  });
});
