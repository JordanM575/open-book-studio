import { describe, expect, test } from "bun:test";
import {
  buildReadOnlyRequest,
  isLiveProviderTestsEnabled,
  LIVE_CHECK_PROVIDERS,
  parseSpendCapCents,
  redactedRequestShape,
  reserveSpend,
  runLiveProviderChecks,
  statusClassFor,
  type LiveCheckEnv,
  type SpendCap
} from "../src/providers/live-checks";

const SECRET = "sk-or-supersecretkey-0123456789abcdef";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("opt-in", () => {
  test("live checks do nothing unless LIVE_PROVIDER_TESTS=1", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const run = await runLiveProviderChecks({ OPENROUTER_API_KEY: SECRET }, { fetchImpl });
    expect(run.optedIn).toBe(false);
    expect(run.results).toEqual([]);
    expect(called).toBe(0);
  });

  test("any value other than exactly '1' leaves live checks off", () => {
    expect(isLiveProviderTestsEnabled({ LIVE_PROVIDER_TESTS: "true" })).toBe(false);
    expect(isLiveProviderTestsEnabled({ LIVE_PROVIDER_TESTS: "0" })).toBe(false);
    expect(isLiveProviderTestsEnabled({ LIVE_PROVIDER_TESTS: "1" })).toBe(true);
    expect(isLiveProviderTestsEnabled({ LIVE_PROVIDER_TESTS: " 1 " })).toBe(true);
  });
});

describe("spend cap (FR-020)", () => {
  test("parseSpendCapCents defaults and validates", () => {
    expect(parseSpendCapCents(undefined)).toBe(5);
    expect(parseSpendCapCents("")).toBe(5);
    expect(parseSpendCapCents("0")).toBe(0);
    expect(parseSpendCapCents("12.5")).toBe(12.5);
    expect(() => parseSpendCapCents("-1")).toThrow();
    expect(() => parseSpendCapCents("nope")).toThrow();
    expect(() => parseSpendCapCents("Infinity")).toThrow();
  });

  test("reserveSpend refuses a request that could exceed the cap and never mutates", () => {
    const cap: SpendCap = { capCents: 5, spentCents: 4 };
    expect(reserveSpend(cap, 1)).toEqual({ ok: true, cap: { capCents: 5, spentCents: 5 } });
    const refused = reserveSpend(cap, 2);
    expect(refused.ok).toBe(false);
    expect(cap.spentCents).toBe(4); // unchanged
    // zero-cost read-only call is always allowed, even at a zero cap
    expect(reserveSpend({ capCents: 0, spentCents: 0 }, 0).ok).toBe(true);
    expect(reserveSpend({ capCents: 0, spentCents: 0 }, 0.0001).ok).toBe(false);
    expect(reserveSpend(cap, -1).ok).toBe(false);
  });

  test("a request that could exceed the cap is refused before it starts", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const env: LiveCheckEnv = { LIVE_PROVIDER_TESTS: "1", LIVE_SPEND_CAP_CENTS: "0", OPENROUTER_API_KEY: SECRET };
    // cap 0, but read-only cost reserved as 1c for this run → refused, no fetch
    const run = await runLiveProviderChecks(env, { fetchImpl, readOnlyCostCents: 1 });
    expect(called).toBe(0);
    expect(run.results.every((r) => r.outcome === "skipped")).toBe(true);
    expect(run.skipped).toBe(run.results.length);
  });

  test("an invalid spend cap is a hard stop", async () => {
    await expect(runLiveProviderChecks({ LIVE_PROVIDER_TESTS: "1", LIVE_SPEND_CAP_CENTS: "-3" })).rejects.toThrow();
    await expect(runLiveProviderChecks({ LIVE_PROVIDER_TESTS: "1", LIVE_SPEND_CAP_CENTS: "abc" })).rejects.toThrow();
  });
});

describe("configured vs skipped", () => {
  test("a missing key is skipped with a reason, not failed", async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof fetch;
    const run = await runLiveProviderChecks({ LIVE_PROVIDER_TESTS: "1" }, { fetchImpl });
    expect(run.passed).toBe(0);
    expect(run.failed).toBe(0);
    expect(run.skipped).toBe(LIVE_CHECK_PROVIDERS.length);
    for (const result of run.results) {
      expect(result.outcome).toBe("skipped");
      expect(result.skipReason).toBeTruthy();
    }
  });

  test("Meta with a key but no base URL is skipped with a reason", async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof fetch;
    const run = await runLiveProviderChecks(
      { LIVE_PROVIDER_TESTS: "1", META_API_KEY: SECRET },
      { fetchImpl }
    );
    const meta = run.results.find((r) => r.provider === "meta")!;
    expect(meta.outcome).toBe("skipped");
    expect(meta.skipReason).toMatch(/META_API_BASE_URL/);
  });
});

describe("one cheapest read-only call per configured provider", () => {
  test("performs exactly one read-only GET per configured key", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method, body: init?.body });
      return jsonResponse({ data: [{ id: "x:free" }], models: [] });
    }) as unknown as typeof fetch;

    const run = await runLiveProviderChecks(
      { LIVE_PROVIDER_TESTS: "1", OPENROUTER_API_KEY: SECRET, OPENAI_API_KEY: SECRET },
      { fetchImpl, now: () => 1000 }
    );

    expect(run.passed).toBe(2);
    expect(run.failed).toBe(0);
    expect(seen.length).toBe(2); // one call per configured provider, no extras
    for (const call of seen) {
      expect(call.method).toBe("GET");
      expect(call.body ?? null).toBeNull(); // no content created
    }
    // no key material in any output
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain(SECRET);
  });

  test("OpenRouter verifies free `:free` model availability at runtime from the same call", async () => {
    const fetchImpl = (async () => jsonResponse({ data: [{ id: "meta:free" }, { id: "paid/model" }] })) as unknown as typeof fetch;
    const run = await runLiveProviderChecks(
      { LIVE_PROVIDER_TESTS: "1", OPENROUTER_API_KEY: SECRET },
      { fetchImpl }
    );
    const or = run.results.find((r) => r.provider === "openrouter")!;
    expect(or.freeModelsAvailable).toBe(true);
  });
});

describe("error classification (FR-021)", () => {
  test("auth, quota, network and provider are distinct", () => {
    expect(statusClassFor("auth")).toBe("auth");
    expect(statusClassFor("permission")).toBe("auth");
    expect(statusClassFor("quota")).toBe("quota");
    expect(statusClassFor("offline")).toBe("network");
    expect(statusClassFor("network-error")).toBe("network");
    expect(statusClassFor("timeout")).toBe("network");
    expect(statusClassFor("rate-limit")).toBe("provider");
    expect(statusClassFor("unknown")).toBe("provider");
  });

  test("401 → auth, 402 → quota, 429 → provider, 500 → provider", async () => {
    const make = (status: number) =>
      (async () => jsonResponse({ error: { message: "no" } }, status)) as unknown as typeof fetch;
    const cases: Array<[number, string]> = [
      [401, "auth"],
      [403, "auth"],
      [402, "quota"],
      [429, "provider"],
      [500, "provider"]
    ];
    for (const [status, cls] of cases) {
      const run = await runLiveProviderChecks(
        { LIVE_PROVIDER_TESTS: "1", OPENAI_API_KEY: SECRET },
        { fetchImpl: make(status) }
      );
      const r = run.results.find((x) => x.provider === "openai")!;
      expect(r.outcome).toBe("failed");
      expect(r.errorClass).toBe(cls);
    }
  });

  test("a thrown network error is classified as network", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
    const run = await runLiveProviderChecks(
      { LIVE_PROVIDER_TESTS: "1", OPENAI_API_KEY: SECRET },
      { fetchImpl }
    );
    const r = run.results.find((x) => x.provider === "openai")!;
    expect(r.outcome).toBe("failed");
    expect(r.errorClass).toBe("network");
  });
});

describe("redaction and artifacts (T026)", () => {
  test("authorization is always redacted; only header NAMES are recorded", () => {
    const shape = redactedRequestShape({
      method: "GET",
      url: `https://x.test/models?api_key=${SECRET}`,
      headers: { Authorization: `Bearer ${SECRET}`, "x-goog-api-key": SECRET, "anthropic-version": "2023-06-01" }
    });
    const json = JSON.stringify(shape);
    expect(json).not.toContain(SECRET);
    expect(shape.headerNames).toEqual(["Authorization", "anthropic-version", "x-goog-api-key"]);
    expect(shape.authorizationRedacted).toBe(true);
    expect(shape.body).toBeNull();
    expect(json).not.toContain("Bearer");
  });

  test("a failing check produces a redacted artifact with provider, model, request shape, latency, error class", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: { message: `bad key ${SECRET}` } }, 401)) as unknown as typeof fetch;
    const run = await runLiveProviderChecks(
      { LIVE_PROVIDER_TESTS: "1", OPENAI_API_KEY: SECRET },
      { fetchImpl, now: () => 1000, isoNow: () => "2026-11-28T00:00:00.000Z" }
    );
    expect(run.failed).toBe(1);
    expect(run.artifacts.length).toBe(1);
    const artifact = run.artifacts[0]!;
    expect(artifact.kind).toBe("live-check-failure");
    expect(artifact.provider).toBe("openai");
    expect(artifact.model).toBeNull();
    expect(artifact.errorClass).toBe("auth");
    expect(artifact.requestShape.authorizationRedacted).toBe(true);
    expect(typeof artifact.latencyMs).toBe("number");
    const json = JSON.stringify(artifact);
    expect(json).not.toContain(SECRET);
    expect(json.toLowerCase()).not.toContain(`bearer ${SECRET.toLowerCase()}`);
  });

  test("buildReadOnlyRequest never embeds the key in the URL", () => {
    const provider = LIVE_CHECK_PROVIDERS.find((p) => p.id === "openrouter")!;
    const built = buildReadOnlyRequest(provider, SECRET, {});
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.request.url).not.toContain(SECRET);
      // key lives only in a header value, which is never serialized
      expect(redactedRequestShape(built.request).headerNames).toContain("Authorization");
      expect(JSON.stringify(redactedRequestShape(built.request))).not.toContain(SECRET);
    }
  });
});
