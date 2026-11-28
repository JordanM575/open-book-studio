import { normalizeProviderError } from "./errors";
import { redact } from "./redact";
import type { ProviderErrorCode, ProviderId } from "./types";

/**
 * Opt-in live provider checks (spec 012, Phase 6 T024; FR-019/FR-020/FR-021; plan §"Live providers").
 *
 * A live check performs ONE cheapest available read-only call per configured provider key. It never
 * creates content, never runs unless `LIVE_PROVIDER_TESTS=1`, never prints or persists a key, and
 * stops before any request that could exceed `LIVE_SPEND_CAP_CENTS`. Auth, quota, network and
 * provider errors are classified distinctly. A failing check produces a redacted artifact (T026).
 *
 * Read-only calls cost nothing, so the spend ledger normally stays at zero; the cap still refuses
 * any request whose reserved estimate would cross it, and a request is never started if reserving
 * its estimate would exceed the cap. Any paid fallback is out of scope here and stays under the cap.
 */

/** Where live checks read keys from. Values are never printed, logged, copied or committed. */
export type LiveCheckEnv = Record<string, string | undefined>;

/** The four error classes T024/FR-021 require, distinct from the provider's own code. */
export type LiveCheckStatusClass = "auth" | "quota" | "network" | "provider";

export type LiveCheckOutcome = "ok" | "skipped" | "failed";

/** Per-run spend ledger in US cents. `capCents` is a hard stop. */
export interface SpendCap {
  capCents: number;
  spentCents: number;
}

/** A provider we can live-check. The key name is listed; the key value never appears in output. */
export interface LiveCheckProvider {
  id: ProviderId;
  name: string;
  /** Environment variable that holds the API key. */
  envKey: string;
  /** Environment variable for a required base URL (Meta); absent for hosted providers. */
  envBaseUrlKey?: string;
  /** The cheapest read-only request path appended to the base, e.g. `/models`. */
  readOnlyPath: string;
  /** Fixed hosted base URL; Meta reads its base URL from the environment. */
  hostedBaseUrl?: string;
  /** How the key is attached. Recorded by NAME only in artifacts; the value is never serialized. */
  authHeader: (key: string) => Record<string, string>;
  /** Extra non-secret headers. */
  extraHeaders?: Record<string, string>;
  /** OpenRouter exposes free `:free` models; we verify availability at runtime, we never bill. */
  prefersFreeModels?: boolean;
}

/** Request shape recorded in artifacts. Authorization is always redacted; no value is kept. */
export interface RedactedRequestShape {
  method: "GET";
  /** URL with any key query parameters redacted. */
  url: string;
  /** Header NAMES only; no header values are ever recorded. */
  headerNames: string[];
  authorizationRedacted: true;
  /** No request body is sent for a read-only call. */
  body: null;
}

/** T026 live-test failure artifact. Contains no key material and no authorization header value. */
export interface LiveCheckFailureArtifact {
  schemaVersion: 1;
  kind: "live-check-failure";
  generatedAt: string;
  provider: string;
  model: string | null;
  requestShape: RedactedRequestShape;
  latencyMs: number;
  errorClass: LiveCheckStatusClass;
  errorCode: ProviderErrorCode | "network-error" | "timeout";
  message: string;
}

export interface LiveCheckResult {
  provider: string;
  model: string | null;
  outcome: LiveCheckOutcome;
  /** Set when outcome is "skipped". */
  skipReason?: string;
  /** Set when outcome is "failed". */
  errorClass?: LiveCheckStatusClass;
  errorCode?: ProviderErrorCode | "network-error" | "timeout";
  message?: string;
  latencyMs?: number;
  requestShape?: RedactedRequestShape;
  /** Estimated spend reserved for this request, in US cents. Read-only calls reserve 0. */
  spendCentsEstimate: number;
  /** True for OpenRouter when at least one `:free` model is visible at runtime. */
  freeModelsAvailable?: boolean;
  /** Present when outcome is "failed"; safe to persist. */
  artifact?: LiveCheckFailureArtifact;
}

export interface LiveChecksRun {
  optedIn: boolean;
  cap: SpendCap;
  results: LiveCheckResult[];
  /** Counts for the unified summary. */
  passed: number;
  skipped: number;
  failed: number;
  /** Failure artifacts (T026), already redacted. */
  artifacts: LiveCheckFailureArtifact[];
}

export interface LiveCheckOptions {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected clock; defaults to Date.now. */
  now?: () => number;
  /** ISO timestamp source for artifacts; defaults to new Date().toISOString(). */
  isoNow?: () => string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Estimated cost in cents to reserve per read-only request. Cheapest read-only call is 0. */
  readOnlyCostCents?: number;
}

/** The providers that can be live-checked, in registry order. ChatGPT plan is manual (T025), not automated. */
export const LIVE_CHECK_PROVIDERS: LiveCheckProvider[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    readOnlyPath: "/models",
    hostedBaseUrl: "https://openrouter.ai/api/v1",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    prefersFreeModels: true
  },
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    readOnlyPath: "/models",
    hostedBaseUrl: "https://api.openai.com/v1",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` })
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    readOnlyPath: "/models",
    hostedBaseUrl: "https://api.anthropic.com/v1",
    authHeader: (key) => ({ "x-api-key": key }),
    extraHeaders: { "anthropic-version": "2023-06-01" }
  },
  {
    id: "gemini",
    name: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    readOnlyPath: "/models",
    hostedBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authHeader: (key) => ({ "x-goog-api-key": key })
  },
  {
    id: "meta",
    name: "Meta",
    envKey: "META_API_KEY",
    envBaseUrlKey: "META_API_BASE_URL",
    readOnlyPath: "/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` })
  }
];

/** Default hard cap in US cents when `LIVE_SPEND_CAP_CENTS` is unset. */
export const DEFAULT_SPEND_CAP_CENTS = 5;

/** The env flag that opts in. Anything other than exactly "1" leaves live checks off. */
export const LIVE_PROVIDER_TESTS_FLAG = "LIVE_PROVIDER_TESTS";
export const LIVE_SPEND_CAP_CENTS_ENV = "LIVE_SPEND_CAP_CENTS";

export function isLiveProviderTestsEnabled(env: LiveCheckEnv): boolean {
  return env[LIVE_PROVIDER_TESTS_FLAG]?.trim() === "1";
}

/**
 * Parse `LIVE_SPEND_CAP_CENTS` as a non-negative number of US cents. A missing value uses the
 * default. An invalid value is a hard stop: we refuse to run rather than guess a cap.
 */
export function parseSpendCapCents(raw: string | undefined, fallback = DEFAULT_SPEND_CAP_CENTS): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${LIVE_SPEND_CAP_CENTS_ENV} must be a non-negative number of US cents, got "${raw}".`);
  }
  return value;
}

export type SpendReservation = { ok: true; cap: SpendCap } | { ok: false; cap: SpendCap; reason: string };

/**
 * Reserve `estimateCents` against the cap. Refuses (without mutating) when the estimate would push
 * spending past the cap; a request that could exceed the cap is never started. FR-020.
 */
export function reserveSpend(cap: SpendCap, estimateCents: number): SpendReservation {
  if (!Number.isFinite(estimateCents) || estimateCents < 0) {
    return { ok: false, cap, reason: "Spend estimate must be a non-negative number of cents." };
  }
  if (cap.spentCents + estimateCents > cap.capCents) {
    return {
      ok: false,
      cap,
      reason: `Spend cap reached: ${cap.spentCents}c spent + ${estimateCents}c estimated would exceed ${cap.capCents}c.`
    };
  }
  return { ok: true, cap: { capCents: cap.capCents, spentCents: cap.spentCents + estimateCents } };
}

/** Map a provider error code to one of the four required classes. */
export function statusClassFor(code: ProviderErrorCode | "network-error" | "timeout"): LiveCheckStatusClass {
  switch (code) {
    case "auth":
    case "permission":
      return "auth";
    case "quota":
      return "quota";
    case "offline":
    case "network-error":
    case "timeout":
      return "network";
    default:
      return "provider";
  }
}

/** Build the cheapest read-only request for a provider, or say why it can't be made. Key stays out of output. */
export function buildReadOnlyRequest(
  provider: LiveCheckProvider,
  key: string,
  env: LiveCheckEnv
): { ok: true; request: { method: "GET"; url: string; headers: Record<string, string> } } | { ok: false; reason: string } {
  const base = provider.envBaseUrlKey
    ? (env[provider.envBaseUrlKey]?.trim() ?? "")
    : (provider.hostedBaseUrl ?? "");
  if (!base) {
    return { ok: false, reason: `${provider.envBaseUrlKey ?? "base URL"} is not set; cannot build a read-only request.` };
  }
  const url = `${base.replace(/\/+$/, "")}${provider.readOnlyPath}`;
  const headers = { ...provider.authHeader(key), ...(provider.extraHeaders ?? {}) };
  return { ok: true, request: { method: "GET", url, headers } };
}

/** Redacted request shape for artifacts. Header values (including authorization) are dropped; URL keys redacted. */
export function redactedRequestShape(request: {
  method: "GET";
  url: string;
  headers: Record<string, string>;
}): RedactedRequestShape {
  return {
    method: "GET",
    url: redact(request.url),
    headerNames: Object.keys(request.headers).sort(),
    authorizationRedacted: true,
    body: null
  };
}

interface ProbeFailure {
  errorClass: LiveCheckStatusClass;
  errorCode: ProviderErrorCode | "network-error" | "timeout";
  message: string;
}

function classifyThrown(error: unknown): ProbeFailure {
  const name = error instanceof Error ? error.name : "";
  const message = redact(error instanceof Error ? error.message : String(error));
  if (name === "TimeoutError" || name === "AbortError" || /timed out|abort/i.test(message)) {
    return { errorClass: "network", errorCode: "timeout", message };
  }
  // A request that got no answer is a network problem; normalizeProviderError agrees.
  const normalized = normalizeProviderError({ provider: "openrouter", message });
  return { errorClass: statusClassFor(normalized.code), errorCode: normalized.code, message };
}

/** Classify a non-OK HTTP response. Body is redacted before it is kept. */
function classifyHttp(provider: ProviderId, status: number, body: string): ProbeFailure {
  const normalized = normalizeProviderError({ provider, status, body: redact(body.slice(0, 2000)) });
  return { errorClass: statusClassFor(normalized.code), errorCode: normalized.code, message: normalized.message };
}

/** Detect whether OpenRouter lists any `:free` model at runtime. Never bills; reads the catalogue only. */
function freeModelsAvailable(body: unknown): boolean {
  const list = (body as { data?: unknown })?.data;
  if (!Array.isArray(list)) return false;
  return list.some((model) => typeof (model as { id?: unknown })?.id === "string" && (model as { id: string }).id.endsWith(":free"));
}

/**
 * Run one cheapest read-only call per configured provider key.
 *
 * Opt-in: returns immediately with `optedIn:false` and no requests unless `LIVE_PROVIDER_TESTS=1`.
 * Missing keys are skipped with a reason. Spend cap is a hard stop. Never prints keys.
 */
export async function runLiveProviderChecks(env: LiveCheckEnv, options: LiveCheckOptions = {}): Promise<LiveChecksRun> {
  const capCents = parseSpendCapCents(env[LIVE_SPEND_CAP_CENTS_ENV]);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const isoNow = options.isoNow ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? 15_000;
  const readOnlyCostCents = options.readOnlyCostCents ?? 0;

  const run: LiveChecksRun = {
    optedIn: isLiveProviderTestsEnabled(env),
    cap: { capCents, spentCents: 0 },
    results: [],
    passed: 0,
    skipped: 0,
    failed: 0,
    artifacts: []
  };

  if (!run.optedIn) return run;

  for (const provider of LIVE_CHECK_PROVIDERS) {
    const key = env[provider.envKey]?.trim() ?? "";
    if (!key) {
      run.results.push({
        provider: provider.id,
        model: null,
        outcome: "skipped",
        skipReason: `No key in ${provider.envKey}; provider not configured.`,
        spendCentsEstimate: 0
      });
      run.skipped += 1;
      continue;
    }

    const built = buildReadOnlyRequest(provider, key, env);
    if (!built.ok) {
      run.results.push({ provider: provider.id, model: null, outcome: "skipped", skipReason: built.reason, spendCentsEstimate: 0 });
      run.skipped += 1;
      continue;
    }

    const requestShape = redactedRequestShape(built.request);

    // FR-020 hard stop: never start a request whose estimate would exceed the cap.
    const reservation = reserveSpend(run.cap, readOnlyCostCents);
    if (!reservation.ok) {
      run.results.push({
        provider: provider.id,
        model: null,
        outcome: "skipped",
        skipReason: reservation.reason,
        spendCentsEstimate: readOnlyCostCents,
        requestShape
      });
      run.skipped += 1;
      continue;
    }
    run.cap = reservation.cap;

    const started = now();
    try {
      const response = await fetchImpl(built.request.url, {
        method: "GET",
        headers: built.request.headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const latencyMs = now() - started;
      const text = await response.text().catch(() => "");

      if (!response.ok) {
        const failure = classifyHttp(provider.id, response.status, text);
        pushFailure(run, provider, requestShape, latencyMs, failure, isoNow);
        continue;
      }

      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // A successful read-only call does not require JSON.
      }

      const result: LiveCheckResult = {
        provider: provider.id,
        model: null,
        outcome: "ok",
        latencyMs,
        requestShape,
        spendCentsEstimate: readOnlyCostCents
      };
      if (provider.prefersFreeModels) {
        // OpenRouter free `:free` models are preferred where possible; verify availability at runtime
        // from the same single read-only catalogue call. Never bills.
        result.freeModelsAvailable = freeModelsAvailable(body);
      }

      run.results.push(result);
      run.passed += 1;
    } catch (error) {
      const latencyMs = now() - started;
      pushFailure(run, provider, requestShape, latencyMs, classifyThrown(error), isoNow);
    }
  }

  return run;
}

function pushFailure(
  run: LiveChecksRun,
  provider: LiveCheckProvider,
  requestShape: RedactedRequestShape,
  latencyMs: number,
  failure: ProbeFailure,
  isoNow: () => string
): void {
  const artifact: LiveCheckFailureArtifact = {
    schemaVersion: 1,
    kind: "live-check-failure",
    generatedAt: isoNow(),
    provider: provider.id,
    model: null,
    requestShape,
    latencyMs,
    errorClass: failure.errorClass,
    errorCode: failure.errorCode,
    message: redact(failure.message)
  };
  run.results.push({
    provider: provider.id,
    model: null,
    outcome: "failed",
    errorClass: failure.errorClass,
    errorCode: failure.errorCode,
    message: artifact.message,
    latencyMs,
    requestShape,
    spendCentsEstimate: 0,
    artifact
  });
  run.artifacts.push(artifact);
  run.failed += 1;
}
