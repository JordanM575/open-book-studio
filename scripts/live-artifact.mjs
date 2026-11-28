/**
 * Live-test failure artifact (spec 012 T026 / FR-021).
 *
 * Pure: builds a JSON-safe record of a failed live provider check.
 * Authorization and any key-shaped string are REDACTED before this returns;
 * nothing secret is persisted or printed. Reuses the shared redactor from
 * `failure-artifacts.mjs` (lockstep with packages/core/src/providers/redact.ts).
 *
 * Record shape (all fields optional except provider + errorClass + latencyMs):
 *   {
 *     provider, model, requestShape, latencyMs, errorClass, message,
 *     status, at, artifactVersion
 *   }
 */

import { redactLine } from "./failure-artifacts.mjs";

export const LIVE_ARTIFACT_VERSION = 1;

/** Error classes T024 requires to be distinct. */
export const LIVE_ERROR_CLASSES = ["auth", "quota", "network", "provider", "cap", "skipped", "unknown"];

const AUTH = /invalid.*(key|token)|unauthor|forbidden|authentication|expired|\b401\b|\b403\b/i;
const QUOTA = /quota|insufficient.*credit|billing|payment required|\b402\b|insufficient_quota/i;
const NETWORK = /fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|abort|timed out|timeout|\b429\b|rate limit|too many requests|slow down/i;
const CAP = /spend-cap-exceeded|spend cap|would exceed the .* cap/i;

/**
 * Classify a live-check error. `status` is an HTTP status if known.
 * Order matters: cap first (our own refusal), then auth, then quota, then network, then provider.
 */
export function classifyLiveError(error, status) {
  const message = String(error?.message ?? error ?? "");
  const code = String(error?.code ?? error?.name ?? "");
  const haystack = `${code} ${message}`;
  const http = Number(status ?? error?.status ?? error?.statusCode);
  const httpStatus = Number.isFinite(http) ? http : undefined;

  if (error?.code === "spend-cap-exceeded" || error?.name === "SpendCapError" || CAP.test(haystack)) return "cap";
  if (httpStatus === 401 || httpStatus === 403 || AUTH.test(haystack)) return "auth";
  if (httpStatus === 402 || QUOTA.test(haystack)) return "quota";
  if (httpStatus === 429 || NETWORK.test(haystack) || !Number.isFinite(httpStatus) && /network|fetch|timeout|abort/i.test(haystack)) {
    return "network";
  }
  if (httpStatus !== undefined && httpStatus >= 400) return "provider";
  if (httpStatus === undefined) return "network";
  return "provider";
}

/** Deep-redact any string values in a JSON-safe structure. Never throws. */
export function redactDeep(value, depth = 0) {
  if (depth > 8) return "[redacted]";
  if (typeof value === "string") return redactLine(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Drop authorization headers entirely; redact everything else stringly.
      if (/^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api[_-]?key|secret|password|token)$/i.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redactDeep(v, depth + 1);
      }
    }
    return out;
  }
  return value ?? null;
}

/**
 * Build a redacted live failure artifact. `requestShape` describes the request
 * (method, url shape, header NAMES, body keys) — any accidental secret in it is redacted.
 */
export function liveFailureArtifact(input = {}) {
  const {
    provider,
    model = null,
    requestShape = null,
    latencyMs = null,
    errorClass = undefined,
    message = "",
    status = undefined,
    error = undefined,
    at = new Date().toISOString(),
    extra = {}
  } = input;

  const klass = errorClass ?? classifyLiveError(error ?? message, status);
  return {
    artifactVersion: LIVE_ARTIFACT_VERSION,
    kind: "live-test-failure",
    provider: provider ? redactLine(String(provider)) : null,
    model: model ? redactLine(String(model)) : null,
    requestShape: redactDeep(requestShape),
    latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    errorClass: LIVE_ERROR_CLASSES.includes(klass) ? klass : "unknown",
    message: redactLine(String(message || error?.message || "")),
    status: status ?? error?.status ?? error?.statusCode ?? null,
    at,
    extra: redactDeep(extra)
  };
}
