import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIVE_SPEND_CAP_CENTS,
  LIVE_PROVIDER_SOURCES,
  SpendCapError,
  admitRequest,
  buildFailureArtifact,
  cheapestReadOnlyRequest,
  classifyHttpResponse,
  classifyLiveError,
  commitCost,
  liveTestsEnabled,
  newSpendCap,
  parseSpendCapCents,
  providerSources,
  readProviderConfig,
  redactedRequestShape
} from "../src/providers/live-check";
import { ProviderError } from "../src/providers/types";

const SECRET = "sk-or-v1-0123456789abcdef0123456789abcdef";

/* ------------------------------------------------------------------ opt-in */

describe("live checks are opt-in (FR-019)", () => {
  test("only the exact string 1 enables them", () => {
    expect(liveTestsEnabled({ LIVE_PROVIDER_TESTS: "1" })).toBe(true);
    expect(liveTestsEnabled({ LIVE_PROVIDER_TESTS: "true" })).toBe(false);
    expect(liveTestsEnabled({ LIVE_PROVIDER_TESTS: "0" })).toBe(false);
    expect(liveTestsEnabled({ LIVE_PROVIDER_TESTS: "" })).toBe(false);
    expect(liveTestsEnabled({})).toBe(false);
  });
});

/* ------------------------------------------------------------------ spend cap */

describe("spend cap (FR-020 / LIVE_SPEND_CAP_CENTS)", () => {
  test("unset or blank falls back to the documented default", () => {
    expect(parseSpendCapCents(undefined)).toBe(DEFAULT_LIVE_SPEND_CAP_CENTS);
    expect(parseSpendCapCents("")).toBe(DEFAULT_LIVE_SPEND_CAP_CENTS);
    expect(parseSpendCapCents("   ")).toBe(DEFAULT_LIVE_SPEND_CAP_CENTS);
    expect(parseSpendCapCents(undefined, 9)).toBe(9);
  });

  test("accepts a non-negative integer, including zero", () => {
    expect(parseSpendCapCents("0")).toBe(0);
    expect(parseSpendCapCents("5")).toBe(5);
    expect(parseSpendCapCents(" 250 ")).toBe(250);
  });

  test("fails closed on a malformed cap so a typo cannot lift the ceiling", () => {
    for (const bad of ["-1", "1.5", "abc", "1e3", "Infinity", "NaN", "0x10"]) {
      expect(() => parseSpendCapCents(bad)).toThrow(SpendCapError);
    }
  });

  test("refuses a request that could exceed the cap, stopping before exceeding", () => {
    const cap = newSpendCap(5);
    expect(admitRequest(cap, 0)).toEqual({ admitted: true });
    expect(admitRequest(cap, 5)).toEqual({ admitted: true }); // exactly at the ceiling is allowed
    expect(admitRequest(cap, 6)).toMatchObject({ admitted: false });
    expect(admitRequest(commitCost(cap, 4), 2)).toMatchObject({ admitted: false }); // spent + max > cap
    expect(admitRequest(commitCost(cap, 4), 1)).toEqual({ admitted: true });
  });

  test("unknown or unbounded cost blocks capped work (D-116)", () => {
    const cap = newSpendCap(100);
    expect(admitRequest(cap, null)).toMatchObject({ admitted: false });
    expect(admitRequest(cap, Number.POSITIVE_INFINITY)).toMatchObject({ admitted: false });
    expect(admitRequest(cap, -1)).toMatchObject({ admitted: false });
    expect(admitRequest(cap, Number.NaN)).toMatchObject({ admitted: false });
  });

  test("a zero cap allows only zero-cost read-only calls", () => {
    const cap = newSpendCap(0);
    expect(admitRequest(cap, 0)).toEqual({ admitted: true });
    expect(admitRequest(cap, 1)).toMatchObject({ admitted: false });
  });

  test("commitCost accumulates real spend and ignores negative or non-finite", () => {
    let cap = newSpendCap(10);
    cap = commitCost(cap, 3);
    cap = commitCost(cap, -5);
    cap = commitCost(cap, Number.NaN);
    expect(cap.spentCents).toBe(3);
    expect(commitCost(cap, 2).spentCents).toBe(5);
  });
});

/* ----------------------------------------------------------- configured keys */

describe("configured providers", () => {
  test("every model provider has a source; a missing key is skipped, not failed", () => {
    expect(providerSources().map((s) => s.provider).sort()).toEqual(["anthropic", "gemini", "meta", "openai", "openrouter"]);
    expect(LIVE_PROVIDER_SOURCES.length).toBe(5);
    for (const source of providerSources()) {
      expect(readProviderConfig(source, {}).kind).toBe("skipped");
    }
  });

  test("a configured key is carried internally under its env name, never the value in output", () => {
    const source = providerSources().find((s) => s.provider === "openrouter")!;
    const result = readProviderConfig(source, { OPENROUTER_API_KEY: `  ${SECRET}  ` });
    expect(result.kind).toBe("configured");
    if (result.kind !== "configured") throw new Error("unreachable");
    expect(result.configured.secret).toBe(SECRET); // trimmed, internal only
    expect(result.configured.keyEnv).toBe("OPENROUTER_API_KEY");
    expect(result.configured.providerName).toBe("OpenRouter");
  });

  test("a blank key is not configured", () => {
    const source = providerSources().find((s) => s.provider === "openai")!;
    expect(readProviderConfig(source, { OPENAI_API_KEY: "   " }).kind).toBe("skipped");
  });

  test("Meta needs a base URL; either env name works; key without base is skipped not failed", () => {
    const meta = providerSources().find((s) => s.provider === "meta")!;
    expect(readProviderConfig(meta, { META_API_KEY: SECRET }).kind).toBe("skipped");
    const a = readProviderConfig(meta, { META_API_KEY: SECRET, META_API_BASE_URL: "https://api.meta.example/v1" });
    const b = readProviderConfig(meta, { META_API_KEY: SECRET, META_BASE_URL: "https://api.meta.example/v1" });
    expect(a.kind).toBe("configured");
    expect(b.kind).toBe("configured");
    if (a.kind === "configured") expect(a.configured.baseUrl).toBe("https://api.meta.example/v1");
  });
});

/* ----------------------------------------------------------- request shape */

describe("request shape redaction", () => {
  test("authorization and provider key headers are replaced; secret never appears", () => {
    const shape = redactedRequestShape(
      { url: "https://api.example.com/v1/models", headers: { authorization: `Bearer ${SECRET}`, "x-api-key": SECRET, "x-goog-api-key": SECRET, "anthropic-version": "2023-06-01" } },
      "GET"
    );
    expect(shape.method).toBe("GET");
    expect(shape.headers.authorization).toBe("[redacted]");
    expect(shape.headers["x-api-key"]).toBe("[redacted]");
    expect(shape.headers["x-goog-api-key"]).toBe("[redacted]");
    expect(shape.headers["anthropic-version"]).toBe("2023-06-01"); // non-secret header kept
    expect(JSON.stringify(shape)).not.toContain(SECRET);
  });

  test("a secret-shaped URL is redacted", () => {
    const shape = redactedRequestShape({ url: `https://api.example.com/v1/models?key=${SECRET}`, headers: {} });
    expect(shape.url).not.toContain(SECRET);
  });

  test("the cheapest read-only request is a keyed GET with no secret exposed", () => {
    const source = providerSources().find((s) => s.provider === "openrouter")!;
    const cfg = readProviderConfig(source, { OPENROUTER_API_KEY: SECRET });
    if (cfg.kind !== "configured") throw new Error("unreachable");
    const shape = cheapestReadOnlyRequest(cfg.configured);
    expect(shape.method).toBe("GET");
    expect(shape.url).toBe("https://openrouter.ai/api/v1/key"); // cheapest read-only; no model called
    expect(shape.headers.authorization).toBe("[redacted]");
    expect(JSON.stringify(shape)).not.toContain(SECRET);
  });
});

/* ------------------------------------------------------------- error classes */

describe("FR-021 error classification", () => {
  const p = "openrouter" as const;

  test("ProviderError codes map to auth / quota / network / provider", () => {
    expect(classifyLiveError(new ProviderError("auth", "no"), p).errorClass).toBe("auth");
    expect(classifyLiveError(new ProviderError("permission", "no"), p).errorClass).toBe("auth");
    expect(classifyLiveError(new ProviderError("quota", "no"), p).errorClass).toBe("quota");
    expect(classifyLiveError(new ProviderError("rate-limit", "no"), p).errorClass).toBe("quota");
    expect(classifyLiveError(new ProviderError("offline", "no"), p).errorClass).toBe("network");
    expect(classifyLiveError(new ProviderError("unknown", "no"), p).errorClass).toBe("provider");
    expect(classifyLiveError(new ProviderError("invalid-request", "no"), p).errorClass).toBe("provider");
    // providerCode is preserved alongside the 4-class view
    expect(classifyLiveError(new ProviderError("rate-limit", "no"), p).providerCode).toBe("rate-limit");
  });

  test("bare network failures are network; other throwables are provider", () => {
    expect(classifyLiveError(new Error("fetch failed: ECONNREFUSED"), p).errorClass).toBe("network");
    expect(classifyLiveError(new Error("ETIMEDOUT"), p).errorClass).toBe("network");
    expect(classifyLiveError(new Error("weird"), p).errorClass).toBe("provider");
    expect(classifyLiveError("boom", p).errorClass).toBe("provider");
  });

  test("HTTP responses are classified; no body is echoed; message is redacted", () => {
    expect(classifyHttpResponse(p, 401, `unauthorized ${SECRET}`).errorClass).toBe("auth");
    expect(classifyHttpResponse(p, 403, "forbidden").errorClass).toBe("auth");
    expect(classifyHttpResponse(p, 402, "payment required").errorClass).toBe("quota");
    expect(classifyHttpResponse(p, 429, "rate limit").errorClass).toBe("quota");
    expect(classifyHttpResponse(p, 500, "oops").errorClass).toBe("provider");
    expect(classifyHttpResponse(p, 400, "bad").errorClass).toBe("provider");
    const leaked = classifyHttpResponse(p, 401, `unauthorized ${SECRET}`);
    expect(leaked.message).not.toContain(SECRET);
  });
});

/* -------------------------------------------------------------- T026 artifact */

describe("T026 live-test failure artifact", () => {
  test("captures provider, model, error class, latency and redacted request shape — no secrets", () => {
    const artifact = buildFailureArtifact({
      provider: "openai",
      providerName: "OpenAI",
      model: null,
      errorClass: "auth",
      providerCode: "auth",
      latencyMs: 123.7,
      requestShape: { method: "GET", url: "https://api.openai.com/v1/models", headers: { authorization: "[redacted]" } },
      message: `The provider rejected this connection. ${SECRET} Bearer ${SECRET}`,
      httpStatus: 401,
      createdAt: "2026-11-28T00:00:00.000Z"
    });
    expect(artifact.kind).toBe("live-provider-check");
    expect(artifact.provider).toBe("openai");
    expect(artifact.model).toBeNull();
    expect(artifact.errorClass).toBe("auth");
    expect(artifact.statusClass).toBe("auth");
    expect(artifact.providerCode).toBe("auth");
    expect(artifact.latencyMs).toBe(124); // rounded
    expect(artifact.httpStatus).toBe(401);
    expect(artifact.requestShape.headers.authorization).toBe("[redacted]");
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(SECRET);
    expect(serialized.toLowerCase()).not.toContain("bearer " + SECRET.toLowerCase());
    expect(artifact.message).not.toContain(SECRET);
  });

  test("model is recorded when a model call was made", () => {
    const artifact = buildFailureArtifact({
      provider: "openrouter",
      providerName: "OpenRouter",
      model: "vendor/model:free",
      errorClass: "provider",
      providerCode: "unknown",
      latencyMs: 0,
      requestShape: { method: "POST", url: "https://openrouter.ai/api/v1/chat/completions", headers: {} },
      message: "nope",
      createdAt: "2026-11-28T00:00:00.000Z"
    });
    expect(artifact.model).toBe("vendor/model:free");
  });
});
