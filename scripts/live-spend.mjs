/**
 * Spend-cap accounting for opt-in live provider checks (spec 012 FR-020 / T024).
 *
 * Pure: no I/O, no secrets, no provider calls. A hard stop in CENTS.
 *
 *   LIVE_SPEND_CAP_CENTS   configurable cap; default 5. Not a secret.
 *
 * The contract, in order of strictness:
 *   - The cap is a hard stop. A request whose worst-case cost is unknown, or whose
 *     estimated cost would take the running total past the cap, is REFUSED before
 *     it is sent. "Stop before exceeding it" — never "stop after noticing".
 *   - The cap can never be raised implicitly. An unset, empty, negative, NaN or
 *     Infinity value falls back to the default; a malformed value is rejected
 *     loudly rather than silently treated as "no cap".
 *   - Cheapest read-only checks (e.g. listing models, reading key status) are
 *     priced at 0 cents, but they still go through `reserve(0)`.
 *
 * All amounts are whole cents of USD. No currency conversion is performed.
 */

export const DEFAULT_LIVE_SPEND_CAP_CENTS = 5;
export const LIVE_SPEND_CAP_ENV = "LIVE_SPEND_CAP_CENTS";
export const LIVE_PROVIDER_TESTS_ENV = "LIVE_PROVIDER_TESTS";

/** Thrown when a request would exceed the cap, or a cost cannot be bounded. */
export class SpendCapError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SpendCapError";
    this.code = "spend-cap-exceeded";
    Object.assign(this, details);
  }
}

/**
 * Whether opt-in live checks are enabled. Off unless explicitly `1`/`true`.
 * Anything else (including unset/empty) means skip.
 */
export function liveProviderTestsEnabled(env = process.env) {
  const raw = String(env?.[LIVE_PROVIDER_TESTS_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Resolve the cap in whole cents from `LIVE_SPEND_CAP_CENTS`.
 * Unset/empty -> default. Non-integer, negative, NaN, Infinity or garbage -> throw.
 * `0` is allowed: it means "refuse anything that costs anything" (read-only only).
 */
export function resolveSpendCapCents(env = process.env, fallback = DEFAULT_LIVE_SPEND_CAP_CENTS) {
  const raw = env?.[LIVE_SPEND_CAP_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new SpendCapError(
      `${LIVE_SPEND_CAP_ENV} must be a non-negative whole number of cents, got ${JSON.stringify(text)}`,
      { env: LIVE_SPEND_CAP_ENV, value: text }
    );
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SpendCapError(`${LIVE_SPEND_CAP_ENV} is out of range: ${JSON.stringify(text)}`, {
      env: LIVE_SPEND_CAP_ENV,
      value: text
    });
  }
  return value;
}

/**
 * Create a ledger. `capCents` must be a non-negative whole number.
 * `spentCents` tracks settled actual cost; `reservedCents` tracks in-flight holds.
 */
export function createSpendLedger(capCents) {
  if (!Number.isSafeInteger(capCents) || capCents < 0) {
    throw new SpendCapError(`capCents must be a non-negative whole number, got ${capCents}`);
  }

  const state = { capCents, spentCents: 0, reservedCents: 0, entries: [] };

  function committed() {
    return state.spentCents + state.reservedCents;
  }

  return {
    get capCents() {
      return state.capCents;
    },
    get spentCents() {
      return state.spentCents;
    },
    get reservedCents() {
      return state.reservedCents;
    },
    /** Cents left before the cap, never negative. */
    remainingCents() {
      return Math.max(0, state.capCents - committed());
    },
    entries() {
      return state.entries.slice();
    },
    /**
     * Reserve `estimatedCents` for a request BEFORE sending it.
     * `estimatedCents` must be a known, finite, non-negative whole number —
     * an unknown worst case cannot be bounded, so it is refused.
     * Throws SpendCapError if committed + estimated would exceed the cap.
     * Returns a `settle(actualCents)` / `release()` handle.
     */
    reserve(estimatedCents, label = "request") {
      if (!Number.isSafeInteger(estimatedCents) || estimatedCents < 0) {
        throw new SpendCapError(
          `cannot bound cost for ${label}: estimated cost must be a known non-negative whole number of cents, got ${estimatedCents}`,
          { label, estimatedCents }
        );
      }
      if (committed() + estimatedCents > state.capCents) {
        throw new SpendCapError(
          `refusing ${label}: ${estimatedCents} cents would exceed the ${state.capCents}-cent cap ` +
            `(${committed()} already committed; ${this.remainingCents()} remaining)`,
          { label, estimatedCents, committedCents: committed(), capCents: state.capCents, remainingCents: this.remainingCents() }
        );
      }
      state.reservedCents += estimatedCents;
      const hold = { estimatedCents, label, settled: false };
      const entry = { kind: "reserve", label, estimatedCents, at: entriesLengthSnapshot() };
      state.entries.push(entry);

      let done = false;
      return {
        /** Settle with the real cost. Actual is still re-checked against the cap. */
        settle(actualCents) {
          if (done) throw new SpendCapError(`hold for ${label} already closed`);
          done = true;
          if (!Number.isSafeInteger(actualCents) || actualCents < 0) {
            // Cannot confirm cost — charge the worst case we reserved.
            actualCents = estimatedCents;
          }
          state.reservedCents -= estimatedCents;
          // The provider billed more than estimated: the cap is a hard stop, so re-check.
          if (state.spentCents + actualCents + state.reservedCents > state.capCents) {
            // Record honestly, then refuse to continue.
            state.spentCents += actualCents;
            state.entries.push({ kind: "settle", label, actualCents, at: state.entries.length });
            throw new SpendCapError(
              `${label} settled at ${actualCents} cents, exceeding the ${state.capCents}-cent cap ` +
                `(total ${state.spentCents}); refusing further live checks`,
              { label, actualCents, capCents: state.capCents, totalCents: state.spentCents }
            );
          }
          state.spentCents += actualCents;
          state.entries.push({ kind: "settle", label, actualCents, at: state.entries.length });
          hold.settled = true;
          return { spentCents: state.spentCents, remainingCents: state.capCents - committed() };
        },
        /** Release a hold without charging (e.g. request never sent). */
        release() {
          if (done) return;
          done = true;
          state.reservedCents -= estimatedCents;
          state.entries.push({ kind: "release", label, estimatedCents, at: state.entries.length });
        }
      };
    }
  };

  function entriesLengthSnapshot() {
    return state.entries.length;
  }
}

/** Cheapest read-only checks cost nothing; still routed through `reserve(0)`. */
export const READ_ONLY_COST_CENTS = 0;
