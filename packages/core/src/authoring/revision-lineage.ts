import {
  ADOPTION_RECEIPT_LIMITS, validateAdoptionReceipt, type AdoptionReceipt,
} from './adoption-receipt';
import { sameOwner, sameReference, validateOwner, type Owner } from './contracts';
import { AuthoringError, copyValue, requireValue, type Immutable } from './value';
import { decodeWorkflowRecord, WORKFLOW_LIMITS, type WorkflowReference } from './wire';

export interface SavedChapterToken {
  readonly chapterId: string;
  /** Exact library-relative path, in the same form as the effect target. */
  readonly path: string;
  readonly version: number;
  readonly hash: string;
}

function evidenceAt<T>(items: readonly T[], index: number): T {
  const item = Object.getOwnPropertyDescriptor(items, index);
  requireValue(item?.enumerable && 'value' in item, 'invalid-lineage-evidence');
  return item.value as T;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;

// Use the intrinsic view metadata and pin the length before passing bytes to the codec.
function boundedEffectBytes(bytes: Uint8Array): Uint8Array {
  requireValue(typedArrayTag?.call(bytes) === 'Uint8Array', 'invalid-bytes');
  const length = typedArrayByteLength.call(bytes) as number;
  requireValue(length > 0, 'invalid-bytes');
  requireValue(length <= WORKFLOW_LIMITS.recordBytes, 'record-overflow');
  const buffer = typedArrayBuffer.call(bytes) as ArrayBufferLike;
  const offset = typedArrayByteOffset.call(bytes) as number;
  return new Uint8Array(buffer, offset, length);
}

/**
 * Check supplied publication evidence for one chapter and run. Supply the
 * current saved token, every publication in its lineage, any unresolved
 * publication for the target, and the corresponding adoption receipts.
 * List order is immaterial. A match establishes lineage for this token only.
 */
export function verifyRevisionLineage(
  owner: Owner,
  current: SavedChapterToken,
  effects: readonly Uint8Array[],
  adoptions: readonly AdoptionReceipt[],
): boolean {
  try {
    const expectedOwner = copyValue(owner);
    validateOwner(expectedOwner);
    const token = copyValue(current);
    if (!Array.isArray(effects) || !Array.isArray(adoptions)) return false;
    const count = effects.length;
    // A chapter starts at version 1 and each published revision advances it by one.
    if (count === 0 || count > ADOPTION_RECEIPT_LIMITS.maxReceiptsPerRun ||
        count !== adoptions.length || count !== token?.version) return false;

    const adoptionsByVersion = new Map<number, Immutable<AdoptionReceipt>>();
    const adoptionIds = new Set<string>();
    const adoptedCandidates = new Set<string>();
    for (let index = 0; index < count; index++) {
      const adoption = validateAdoptionReceipt(evidenceAt(adoptions, index));
      // The validator binds the artifact kind and owner. The remaining fields identify its exact revision.
      const { id, revision, hash } = adoption.candidate;
      const candidateKey = JSON.stringify([id, revision, hash]);
      if (!sameOwner(adoption.owner, expectedOwner) || adoption.chapterId !== token.chapterId ||
          Object.hasOwn(adoption, 'conflictMetadata') || adoptedCandidates.has(candidateKey) ||
          adoption.resultVersion > count || adoptionsByVersion.has(adoption.resultVersion) ||
          adoptionIds.has(adoption.id)) return false;
      adoptionsByVersion.set(adoption.resultVersion, adoption);
      adoptionIds.add(adoption.id);
      adoptedCandidates.add(candidateKey);
    }
    if (adoptionsByVersion.get(count)?.resultHash !== token.hash) return false;

    const effectIds = new Set<string>();
    const confirmedVersions = new Set<number>();
    for (let index = 0; index < count; index++) {
      const bytes = boundedEffectBytes(evidenceAt(effects, index));
      const effect = decodeWorkflowRecord(bytes, { kind: 'effect', owner: expectedOwner });
      if (Object.hasOwn(effect, 'conflictMetadata') || effect.phase !== 'confirmed' ||
          effect.intent === null || effectIds.has(effect.id)) return false;

      // The effect codec checks these fields, including the confirmed outcome and result token.
      const target = effect.target as { kind: 'new-chapter' | 'replace-chapter'; chapterId: string; path: string };
      const intent = effect.intent as { baseVersion: number; baseHash: string | null; intendedHash: string };
      const receipt = effect.receipt as { resultVersion: number; resultHash: string; savedAs?: string };

      const adoption = adoptionsByVersion.get(receipt.resultVersion);
      if (!adoption || confirmedVersions.has(receipt.resultVersion) ||
          target.chapterId !== token.chapterId || target.path !== token.path ||
          (receipt.savedAs !== undefined && receipt.savedAs !== target.path) ||
          !sameReference(effect.candidate as WorkflowReference<'artifact'>, adoption.candidate) ||
          receipt.resultHash !== adoption.resultHash || receipt.resultHash !== intent.intendedHash) return false;

      const previous = adoptionsByVersion.get(receipt.resultVersion - 1);
      if (target.kind !== (previous ? 'replace-chapter' : 'new-chapter') ||
          intent.baseVersion !== (previous?.resultVersion ?? 0) ||
          intent.baseHash !== (previous?.resultHash ?? null) ||
          (previous && adoption.sequence <= previous.sequence)) return false;
      confirmedVersions.add(receipt.resultVersion);
      effectIds.add(effect.id);
    }
    return true;
  } catch (error) {
    if (error instanceof AuthoringError) return false;
    throw error;
  }
}
