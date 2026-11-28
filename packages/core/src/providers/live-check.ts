import { endpointFor, type ProviderEndpoint } from "./keys";
import { redact, redactDeep } from "./redact";
import { normalizeProviderError, isProviderErrorCode } from "./errors";
import { providerById } from "./registry";
import { ProviderError, type ProviderErrorCode, type ProviderId, PROVIDER_IDS } from "./types";

/**
 * Spec 012 Phase 6 — opt-in live provider checks.
 *
 * Pure logic only: which providers are configured, whether a single cheapest read-only call fits
 * inside the spend cap, how an error is classified, and how a redacted failure artifact is shaped.
 * The network itself lives in `scripts/live-provider-check.ts`; nothing here reads or prints a key.
 *
 * FR-019: opt-in, skips cleanly without keys, never prints or persists a key.
 * FR-020: cheapest read-only call, configurable spend cap, stop before exceeding it.
 * FR-021: auth, quota, network and provider errors reported distinctly.
 */

/** The single switch. Live checks run only when this is exactly `1`. */
export const LIVE_PROVIDER_TESTS_ENV = "LIVE_PROVIDER_TESTS";
/** Hard spend ceiling for a run, in US cents. */
export const LIVE_SPEND_CAP_CENTS_ENV = "LIVE_SPEND_CAP_CENTS";
/** Default cap in US cents, matching `.env.example`. */
export const DEFAULT_LIVE_SPEND_CAP_CENTS = 5;

/** Where a redacted live-test failure artifact is written (relative to the repo root). */
export const LIVE_FAILURE_ARTIFACT_DIR_ENV = "LIVE_FAILURE_ARTIFACT_DIR";
export const DEFAULT_LIVE_FAILURE_ARTIFACT_DIR = "out/live-provider-check";

/* ------------------------------------------------------------------ outcomes */

/** `ok` ran and was accepted; `skipped` not attempted; `blocked` stopped before spending; `failed` rejected. */
export type LiveOutcome = "ok" | "skipped" | "blocked" | "failed";

/** FR-021: the four distinct classes. `auth` covers rejected keys and missing scope. */
export type LiveErrorClass = "auth" | "quota" | "network" | "provider";

/* ------------------------------------------------------- configured providers */

/** How each model provider is configured from the environment. Keys are read, never printed. */
export interface LiveProviderSource {
  provider: ProviderId;
  providerName: string;
  /** Env var holding the secret key. */
  keyEnv: string;
  /** Env vars holding the base URL, first non-empty wins. Required providers are skipped when absent. */
  baseUrlEnvs: string[];
  /** Whether a base URL is required to form the endpoint. */
  baseUrlRequired: boolean;
}

export const LIVE_PROVIDER_SOURCES: readonly LiveProviderSource[] = [
  { provider: "openrouter", providerName: providerById("openrouter").name, keyEnv: "OPENROUTER_API_KEY", baseUrlEnvs: [], baseUrlRequired: false },
  { provider: "openai", providerName: providerById("openai").name, keyEnv: "OPENAI_API_KEY", baseUrlEnvs: [], baseUrlRequired: false },
  { provider: "anthropic", providerName: providerById("anthropic").name, keyEnv: "ANTHROPIC_API_KEY", baseUrlEnvs: [], baseUrlRequired: false },
  { provider: "gemini", providerName: providerById("gemini").name, keyEnv: "GEMINI_API_KEY", baseUrlEnvs: [], baseUrlRequired: false },
  {
    provider: "meta",
    providerName: providerById("meta").name,
    keyEnv: "META_API_KEY",
    baseUrlEnvs: ["META_API_BASE_URL", "META_BASE_URL"],
    baseUrlRequired: true
  }
];

/** A provider whose key (and required base URL) is present. The secret is carried, never exposed. */
export interface ConfiguredProvider {
  provider: ProviderId;
  providerName: string;
  /** Secret. Internal only; never logged, printed, persisted or returned in any artifact. */
  secret: string;
  baseUrl: string | undefined;
  /** Which env var the key came from (name only, never the value). */
  keyEnv: string;
}

/** The result of inspecting one provider source. A missing key is `skipped`, never `failed`. */
export type ProviderConfigResult =
  | { kind: "configured"; configured: ConfiguredProvider }
  | { kind: "skipped"; provider: ProviderId; providerName: string; reason: string };

/**
 * Read configuration for one provider from an environment map. A provider with no key is skipped;
 * a configured provider that still cannot form an endpoint (Meta without a base URL) is skipped with
 * a reason, not failed.
 */
export function readProviderConfig(
  source: LiveProviderSource,
  env: Record<string, string | undefined>
): ProviderConfigResult {
  const secret = (env[source.keyEnv] ?? "").trim();
  if (!secret) {
    return { kind: "skipped", provider: source.provider, providerName: source.providerName, reason: `${source.keyEnv} is not set` };
  }
  let baseUrl: string | undefined;
  for (const name of source.baseUrlEnvs) {
    const value = (env[name] ?? "").trim();
    if (value) {
      baseUrl = value;
      break;
    }
  }
  if (source.baseUrlRequired && !baseUrl) {
    return {
      kind: "skipped",
      provider: source.provider,
      providerName: source.providerName,
      reason: `${source.baseUrlEnvs[0] ?? "base URL"} is not set`
    };
  }
  return {
    kind: "configured",
    configured: { provider: source.provider, providerName: source.providerName, secret, baseUrl, keyEnv: source.keyEnv }
  };
}

/** Every provider source. */
export function providerSources(): readonly LiveProviderSource[] {
  return LIVE_PROVIDER_SOURCES;
}

/* ------------------------------------------------------------------ spend cap */

/** Running spend. All figures in US cents. */
export interface SpendCap {
  capCents: number;
  spentCents: number;
}

export class SpendCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendCapError";
  }
}

/**
 * Parse `LIVE_SPEND_CAP_CENTS`. Unset/blank falls back to the default; a value that is not a
 * non-negative integer fails closed (throws) so a typo cannot silently lift the cap. `0` allows
 * only zero-cost read-only calls.
 */
export function parseSpendCapCents(raw: string | undefined, fallback: number = DEFAULT_LIVE_SPEND_CAP_CENTS): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  // Strict decimal integer only: reject scientific notation, hex, signs, decimals and junk.
  if (!/^\d+$/.test(text)) {
    throw new SpendCapError(`${LIVE_SPEND_CAP_CENTS_ENV} must be a non-negative integer number of cents, got ${JSON.stringify(text)}`);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new SpendCapError(`${LIVE_SPEND_CAP_CENTS_ENV} must be a non-negative integer number of cents, got ${JSON.stringify(text)}`);
  }
  return value;
}

/** A fresh cap. */
export function newSpendCap(capCents: number): SpendCap {
  return { capCents, spentCents: 0 };
}

export type Admission = { admitted: true } | { admitted: false; reason: string };

/**
 * FR-020 / D-116: refuse to start a request that could exceed the cap, or whose cost cannot be
 * bounded. `maxCostCents` is the provider-enforceable upper bound for this call; `null`/unknown
 * blocks. Stops *before* exceeding: `spent + maxCostCents` must stay `<= cap`.
 */
export function admitRequest(cap: SpendCap, maxCostCents: number | null): Admission {
  if (maxCostCents === null || !Number.isFinite(maxCostCents) || maxCostCents < 0) {
    return { admitted: false, reason: "the call's maximum cost is not known, which blocks capped work" };
  }
  if (cap.spentCents + maxCostCents > cap.capCents) {
    return {
      admitted: false,
      reason: `would exceed spend cap: ${cap.spentCents + maxCostCents}c > ${cap.capCents}c`
    };
  }
  return { admitted: true };
}

/** Record actual cost after a call. Never below zero. */
export function commitCost(cap: SpendCap, actualCents: number): SpendCap {
  const safe = Number.isFinite(actualCents) && actualCents > 0 ? actualCents : 0;
  return { capCents: cap.capCents, spentCents: cap.spentCents + safe };
}

/* ------------------------------------------------------------- request shape */

const SECRET_HEADERS = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key)$/i;

/** A request shape safe to print: secret headers are replaced, URLs are redacted. */
export interface RedactedRequestShape {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export function redactedRequestShape(endpoint: ProviderEndpoint, method: string = "GET"): RedactedRequestShape {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(endpoint.headers)) {
    headers[name] = SECRET_HEADERS.test(name) ? "[redacted]" : redact(value);
  }
  return { method, url: redact(endpoint.url), headers };
}

/* ----------------------------------------------------------- error classes */

const CODE_TO_CLASS: Record<ProviderErrorCode, LiveErrorClass> = {
  auth: "auth",
  permission: "auth",
  "rate-limit": "quota",
  quota: "quota",
  context: "provider",
  refusal: "provider",
  offline: "network",
  "invalid-request": "provider",
  "not-found": "provider",
  unsupported: "provider",
  unknown: "provider"
};

/** The one cheapest read-only call for a provider, as a redacted request shape. No model is called. */
export function cheapestReadOnlyRequest(configured: ConfiguredProvider): RedactedRequestShape {
  const endpoint = endpointFor(configured.provider, configured.secret, configured.baseUrl);
  return redactedRequestShape(endpoint, "GET");
}

/** The real endpoint for fetch. Internal; the secret is in the headers and must not be logged. */
export function cheapestReadOnlyEndpoint(configured: ConfiguredProvider): ProviderEndpoint {
  return endpointFor(configured.provider, configured.secret, configured.baseUrl);
}

export interface LiveErrorReport {
  errorClass: LiveErrorClass;
  providerCode: ProviderErrorCode;
  message: string;
}

const NETWORK_HINT = /fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|abort|timeout|timed out/i;

/** Classify any thrown value into one of FR-021's four classes, with a redacted message. */
export function classifyLiveError(error: unknown, provider: ProviderId): LiveErrorReport {
  if (error instanceof ProviderError) {
    return {
      errorClass: CODE_TO_CLASS[error.code] ?? "provider",
      providerCode: error.code,
      message: redact(error.message)
    };
  }
  // A thrown provider error code from elsewhere, or a bare network failure.
  if (isProviderErrorCode(typeof (error as { code?: unknown })?.code === "string" ? ((error as { code: string }).code) : "")) {
    const code = (error as { code: ProviderErrorCode }).code;
    return { errorClass: CODE_TO_CLASS[code] ?? "provider", providerCode: code, message: redact(error instanceof Error ? error.message : String(error)) };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (NETWORK_HINT.test(message)) {
    return { errorClass: "network", providerCode: "offline", message: redact(message) };
  }
  return { errorClass: "provider", providerCode: "unknown", message: redact(message) };
}

/** Turn a non-OK HTTP response into a normalized, classified error (body is never retained verbatim). */
export function classifyHttpResponse(provider: ProviderId, status: number, body: string, retryAfterSeconds?: number): LiveErrorReport {
  const error = normalizeProviderError({ provider, status, body, retryAfterSeconds });
  return { errorClass: CODE_TO_CLASS[error.code] ?? "provider", providerCode: error.code, message: redact(error.message) };
}

/* ----------------------------------------------------- T026 failure artifact */

/** A redacted live-test failure artifact. Contains no key, no authorization header, no prose. */
export interface LiveFailureArtifact {
  kind: "live-provider-check";
  provider: ProviderId;
  providerName: string;
  /** Model id when a model call was made; null for a read-only catalogue check. */
  model: string | null;
  errorClass: LiveErrorClass;
  providerCode: ProviderErrorCode | null;
  /** FR-021 status class kept distinct from the transport outcome. */
  statusClass: LiveErrorClass;
  latencyMs: number;
  /** Request shape with authorization redacted. */
  requestShape: RedactedRequestShape;
  /** Redacted human message. */
  message: string;
  /** HTTP status when known. */
  httpStatus: number | null;
  createdAt: string;
}

export interface FailureArtifactInput {
  provider: ProviderId;
  providerName: string;
  model?: string | null;
  errorClass: LiveErrorClass;
  providerCode?: ProviderErrorCode | null;
  latencyMs: number;
  requestShape: RedactedRequestShape;
  message: string;
  httpStatus?: number | null;
  createdAt: string;
}

/** Build a T026 artifact, redacting every string and dropping anything secret-shaped. */
export function buildFailureArtifact(input: FailureArtifactInput): LiveFailureArtifact {
  const artifact: LiveFailureArtifact = {
    kind: "live-provider-check",
    provider: input.provider,
    providerName: input.providerName,
    model: input.model ?? null,
    errorClass: input.errorClass,
    providerCode: input.providerCode ?? null,
    statusClass: input.errorClass,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    requestShape: input.requestShape,
    message: redact(input.message),
    httpStatus: input.httpStatus ?? null,
    createdAt: input.createdAt
  };
  // Belt and braces: run the whole thing through deep redaction before it can be persisted.
  return redactDeep(artifact);
}

/* --------------------------------------------------------------- opt-in gate */

/** Whether live checks are enabled. Only the exact string `1`. */
export function liveTestsEnabled(env: Record<string, string | undefined>): boolean {
  return env[LIVE_PROVIDER_TESTS_ENV] === "1";
}

/** Are we scanning a repo with a top-level `.env`? Callers load it; this never reads the file. */
export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
