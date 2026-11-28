import { describe, expect, test } from "bun:test";
import { classifyLiveError, liveFailureArtifact, redactDeep, LIVE_ERROR_CLASSES } from "../../../scripts/live-artifact.mjs";

// Secrets are assembled at runtime so this file contains no key-shaped string.
function joinParts(...parts: string[]): string {
  return parts.join("");
}

describe("classifyLiveError (FR-021 distinct classes)", () => {
  test("auth", () => {
    expect(classifyLiveError(new Error("Unauthorized"), 401)).toBe("auth");
    expect(classifyLiveError(new Error("forbidden"), 403)).toBe("auth");
    expect(classifyLiveError(new Error("invalid api key"))).toBe("auth");
  });
  test("quota", () => {
    expect(classifyLiveError(new Error("quota exceeded"), 402)).toBe("quota");
    expect(classifyLiveError(new Error("insufficient credit"))).toBe("quota");
    expect(classifyLiveError(new Error("billing"), 402)).toBe("quota");
  });
  test("network", () => {
    expect(classifyLiveError(new Error("fetch failed"))).toBe("network");
    expect(classifyLiveError(new Error("ECONNRESET"))).toBe("network");
    expect(classifyLiveError(new Error("timed out"))).toBe("network");
    expect(classifyLiveError(new Error("rate limit"), 429)).toBe("network");
    expect(classifyLiveError(new Error("no status"))).toBe("network");
  });
  test("provider", () => {
    expect(classifyLiveError(new Error("HTTP 500"), 500)).toBe("provider");
    expect(classifyLiveError(new Error("HTTP 400"), 400)).toBe("provider");
  });
  test("cap is its own class", () => {
    const e = new Error("would exceed the 5-cent cap");
    (e as { code?: string }).code = "spend-cap-exceeded";
    expect(classifyLiveError(e)).toBe("cap");
  });
  test("results are always in the known set", () => {
    expect(LIVE_ERROR_CLASSES).toContain(classifyLiveError(new Error("???"), 999));
  });
});

describe("liveFailureArtifact (T026)", () => {
  test("records provider, model, request shape, latency, error class", () => {
    const a = liveFailureArtifact({
      provider: "openai",
      model: "gpt-4o-mini",
      requestShape: { method: "GET", url: "https://api.openai.com/v1/models", headerNames: ["Authorization"] },
      latencyMs: 123.6,
      errorClass: "auth",
      message: "Unauthorized",
      status: 401
    });
    expect(a.provider).toBe("openai");
    expect(a.model).toBe("gpt-4o-mini");
    expect(a.requestShape).toEqual({ method: "GET", url: "https://api.openai.com/v1/models", headerNames: ["Authorization"] });
    expect(a.latencyMs).toBe(124);
    expect(a.errorClass).toBe("auth");
    expect(a.status).toBe(401);
    expect(a.kind).toBe("live-test-failure");
    expect(typeof a.at).toBe("string");
  });

  test("authorization header value is stripped; key-shaped strings redacted", () => {
    const bearer = joinParts("Bea", "rer ", "abcdefgh12345678");
    const apiKey = joinParts("sk", "-", "proj", "-", "1234567890abcdef12345678");
    const a = liveFailureArtifact({
      provider: "openai",
      requestShape: {
        method: "GET",
        headers: { Authorization: bearer, "x-api-key": apiKey, Accept: "application/json" },
        api_key: apiKey
      },
      message: `401 with header ${bearer}`,
      status: 401
    });
    const json = JSON.stringify(a);
    expect(json).not.toContain("abcdefgh12345678");
    expect(json).not.toContain("1234567890abcdef12345678");
    const shape = a.requestShape as { headers: Record<string, string>; api_key: string };
    expect(shape.headers.Authorization).toBe("[redacted]");
    expect(shape.headers["x-api-key"]).toBe("[redacted]");
    expect(shape.headers.Accept).toBe("application/json");
    expect(shape.api_key).toBe("[redacted]");
  });

  test("classifies from error when errorClass not given", () => {
    const a = liveFailureArtifact({ provider: "gemini", error: new Error("fetch failed"), latencyMs: 5 });
    expect(a.errorClass).toBe("network");
  });

  test("redactDeep removes secrets in nested structures, never throws", () => {
    const secret = joinParts("sk", "-", "or-v1", "-", "Q7mZ2vN8pR4sT6xY9aB3cD5eF7gH1jK2");
    const out = redactDeep({ a: [{ b: `x ${secret}` }], token: secret, ok: 1, nil: null }) as {
      a: Array<{ b: string }>;
      token: string;
      ok: number;
    };
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.token).toBe("[redacted]");
    expect(out.ok).toBe(1);
  });
});
