import { describe, expect, test } from "bun:test";
import {
  createSpendLedger,
  liveProviderTestsEnabled,
  resolveSpendCapCents,
  SpendCapError,
  DEFAULT_LIVE_SPEND_CAP_CENTS
} from "../../../scripts/live-spend.mjs";

describe("LIVE_PROVIDER_TESTS opt-in", () => {
  test("off unless explicitly enabled", () => {
    expect(liveProviderTestsEnabled({})).toBe(false);
    expect(liveProviderTestsEnabled({ LIVE_PROVIDER_TESTS: "" })).toBe(false);
    expect(liveProviderTestsEnabled({ LIVE_PROVIDER_TESTS: "0" })).toBe(false);
    expect(liveProviderTestsEnabled({ LIVE_PROVIDER_TESTS: "no" })).toBe(false);
    expect(liveProviderTestsEnabled({ LIVE_PROVIDER_TESTS: "1" })).toBe(true);
    expect(liveProviderTestsEnabled({ LIVE_PROVIDER_TESTS: "true" })).toBe(true);
    expect(liveProviderTestsEnabled({ LIVE_PROVIDER_TESTS: "TRUE" })).toBe(true);
  });
});

describe("LIVE_SPEND_CAP_CENTS resolution", () => {
  test("unset/empty -> default", () => {
    expect(resolveSpendCapCents({})).toBe(DEFAULT_LIVE_SPEND_CAP_CENTS);
    expect(resolveSpendCapCents({ LIVE_SPEND_CAP_CENTS: "" })).toBe(DEFAULT_LIVE_SPEND_CAP_CENTS);
    expect(resolveSpendCapCents({ LIVE_SPEND_CAP_CENTS: "   " })).toBe(DEFAULT_LIVE_SPEND_CAP_CENTS);
  });

  test("reads a configurable whole-cent cap; 0 allowed (read-only only)", () => {
    expect(resolveSpendCapCents({ LIVE_SPEND_CAP_CENTS: "0" })).toBe(0);
    expect(resolveSpendCapCents({ LIVE_SPEND_CAP_CENTS: "250" })).toBe(250);
  });

  test("malformed is rejected loudly, never silently 'no cap'", () => {
    for (const bad of ["-1", "1.5", "abc", "Infinity", "NaN", "1e3", "5 cents", "0x10"]) {
      expect(() => resolveSpendCapCents({ LIVE_SPEND_CAP_CENTS: bad })).toThrow(SpendCapError);
    }
  });
});

describe("spend ledger hard stop", () => {
  test("reserve refuses a request that would exceed the cap BEFORE sending", () => {
    const ledger = createSpendLedger(5);
    expect(ledger.remainingCents()).toBe(5);
    // 6 > 5 cap -> refused
    expect(() => ledger.reserve(6, "paid call")).toThrow(SpendCapError);
    // nothing was reserved on a refused request
    expect(ledger.reservedCents).toBe(0);
    expect(ledger.spentCents).toBe(0);
    // read-only (0) is always allowed
    const hold = ledger.reserve(0, "read-only");
    hold.settle(0);
    expect(ledger.spentCents).toBe(0);
  });

  test("unknown / unbounded worst case is refused", () => {
    const ledger = createSpendLedger(100);
    for (const bad of [Number.NaN, Infinity, -1, 1.5, undefined, null]) {
      // @ts-expect-error intentionally invalid
      expect(() => ledger.reserve(bad)).toThrow(SpendCapError);
    }
    expect(ledger.reservedCents).toBe(0);
  });

  test("settle re-checks cap against actual; over-run is recorded and stops further spending", () => {
    const ledger = createSpendLedger(5);
    const hold = ledger.reserve(3, "call");
    expect(() => hold.settle(10)).toThrow(SpendCapError);
    // honestly recorded
    expect(ledger.spentCents).toBe(10);
    // and no further reservation can proceed
    expect(() => ledger.reserve(0, "next")).toThrow(SpendCapError);
  });

  test("cumulative committed total cannot exceed cap across requests", () => {
    const ledger = createSpendLedger(5);
    ledger.reserve(2, "a").settle(2);
    ledger.reserve(3, "b").settle(3);
    expect(ledger.spentCents).toBe(5);
    expect(ledger.remainingCents()).toBe(0);
    expect(() => ledger.reserve(1, "c")).toThrow(SpendCapError);
  });

  test("in-flight reservations count against the cap", () => {
    const ledger = createSpendLedger(5);
    const hold = ledger.reserve(4, "a"); // reserved, not yet settled
    expect(ledger.remainingCents()).toBe(1);
    expect(() => ledger.reserve(2, "b")).toThrow(SpendCapError);
    hold.release();
    expect(ledger.reservedCents).toBe(0);
    const hold2 = ledger.reserve(2, "b");
    expect(ledger.remainingCents()).toBe(3);
    hold2.release();
  });

  test("release drops a hold without charging", () => {
    const ledger = createSpendLedger(5);
    const hold = ledger.reserve(4, "a");
    hold.release();
    expect(ledger.reservedCents).toBe(0);
    expect(ledger.spentCents).toBe(0);
  });

  test("invalid cap rejected", () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createSpendLedger(bad)).toThrow(SpendCapError);
    }
  });
});
