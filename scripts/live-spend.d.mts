export declare const DEFAULT_LIVE_SPEND_CAP_CENTS: number;
export declare const LIVE_SPEND_CAP_ENV: string;
export declare const LIVE_PROVIDER_TESTS_ENV: string;
export declare const READ_ONLY_COST_CENTS: number;

export declare class SpendCapError extends Error {
  code: string;
  [key: string]: unknown;
}

export declare function liveProviderTestsEnabled(env?: Record<string, string | undefined>): boolean;
export declare function resolveSpendCapCents(env?: Record<string, string | undefined>, fallback?: number): number;

export interface SpendHold {
  settle(actualCents: number): { spentCents: number; remainingCents: number };
  release(): void;
}

export interface SpendLedger {
  readonly capCents: number;
  readonly spentCents: number;
  readonly reservedCents: number;
  remainingCents(): number;
  entries(): Array<Record<string, unknown>>;
  reserve(estimatedCents: number, label?: string): SpendHold;
}

export declare function createSpendLedger(capCents: number): SpendLedger;
