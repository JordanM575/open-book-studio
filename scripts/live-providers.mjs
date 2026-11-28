#!/usr/bin/env node
/**
 * Opt-in live provider checks (spec 012 T024, FR-019/020/021).
 *
 *   LIVE_PROVIDER_TESTS=1 LIVE_SPEND_CAP_CENTS=5 bun scripts/live-providers.mjs
 *
 * Behaviour:
 *   - Opt-in. Unless LIVE_PROVIDER_TESTS is `1`, nothing runs and nothing is spent.
 *   - Hard spend cap in CENTS from LIVE_SPEND_CAP_CENTS (default 5). The cap is
 *     enforced BEFORE any request; anything that cannot be bounded is refused.
 *   - One CHEAPEST READ-ONLY call per configured provider (list models / read key
 *     status). No generation, no audio, no chat. Read-only calls are priced 0
 *     cents, but still go through the ledger. Any paid call would have to be
 *     reserved first and would be refused if it could exceed the cap.
 *   - Absent keys are SKIPPED with a reason. Never prints, persists or logs key
 *     material; Authorization headers are stripped from any artifact.
 *   - Errors are classified distinctly: auth / quota / network / provider / cap.
 *   - On a live-check FAILURE, a redacted artifact is written under
 *     out/live-failure-artifacts/ (provider, model, request shape, latency,
 *     error class) and its path is printed. Green runs leave nothing behind.
 *
 * Secrets are read from the environment (e.g. a top-level .env loaded by the
 * caller) ONLY. Nothing is written back.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSpendLedger, liveProviderTestsEnabled, resolveSpendCapCents, READ_ONLY_COST_CENTS } from "./live-spend.mjs";
import { liveFailureArtifact, classifyLiveError } from "./live-artifact.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TIMEOUT_MS = 15_000;

// One cheapest read-only call per provider. No provider spend on these endpoints.
const PROVIDERS = [
  {
    id: "openrouter",
    label: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    kind: "list-models"
  },
  {
    id: "openai",
    label: "OpenAI",
    env: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    kind: "list-models"
  },
  {
    id: "anthropic",
    label: "Anthropic",
    env: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/models",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    kind: "list-models"
  },
  {
    id: "gemini",
    label: "Gemini",
    env: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: (key) => ({ "x-goog-api-key": key }),
    kind: "list-models"
  },
  {
    id: "meta",
    label: "Meta",
    env: "META_API_KEY",
    url: (key) => null, // built per-call from META_API_BASE_URL; see checkMeta()
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    kind: "meta-models",
    requiresBaseUrlEnv: "META_API_BASE_URL"
  }
];

/** Request SHAPE only — header NAMES, never values. Used for artifacts. */
function requestShape(provider, url) {
  const headerNames = Object.keys(provider.headers("REDACTED") ?? {});
  return {
    method: "GET",
    url: safeUrl(url),
    headerNames,
    body: null,
    readOnly: true,
    kind: provider.kind
  };
}

/** Strip any userinfo/query secrets from a URL for logging. */
function safeUrl(url) {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "[url redacted]";
  }
}

async function oneReadOnly(provider, key, ledger) {
  const started = Date.now();

  let url;
  if (provider.kind === "meta-models") {
    const base = process.env[provider.requiresBaseUrlEnv];
    if (!base) {
      return { outcome: "skipped", reason: `${provider.requiresBaseUrlEnv} is not set`, name: provider.id };
    }
    url = `${base.replace(/\/+$/, "")}/models`;
  } else {
    url = typeof provider.url === "function" ? provider.url(key) : provider.url;
  }

  const shape = requestShape(provider, url);

  // Price the cheapest read-only call at 0 cents — still reserved through the hard-stop ledger.
  let hold;
  try {
    hold = ledger.reserve(READ_ONLY_COST_CENTS, `${provider.id} read-only ${provider.kind}`);
  } catch (error) {
    return {
      outcome: "failed",
      name: provider.id,
      errorClass: "cap",
      detail: error.message,
      artifact: liveFailureArtifact({
        provider: provider.id,
        requestShape: shape,
        latencyMs: Date.now() - started,
        error,
        errorClass: "cap"
      })
    };
  }

  let status;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: provider.headers(key),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    status = response.status;
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      const body = await safeText(response);
      const message = `HTTP ${response.status} in ${latencyMs} ms${body ? ` — ${truncate(body)}` : ""}`;
      hold.settle(READ_ONLY_COST_CENTS);
      return {
        outcome: "failed",
        name: provider.id,
        errorClass: classifyLiveError(message, status),
        detail: message,
        artifact: liveFailureArtifact({
          provider: provider.id,
          requestShape: shape,
          latencyMs,
          message,
          status,
          errorClass: classifyLiveError(message, status)
        })
      };
    }

    // Free-model preference (FREE OPENROUTER): read-only, verify availability at runtime.
    let extra = {};
    if (provider.id === "openrouter") {
      try {
        const body = await response.clone().json();
        extra.freeModels = countFreeModels(body);
      } catch {
        extra.freeModels = null;
      }
    }

    hold.settle(READ_ONLY_COST_CENTS);
    return { outcome: "ok", name: provider.id, detail: `read-only ok in ${latencyMs} ms`, latencyMs, ...extra };
  } catch (error) {
    const latencyMs = Date.now() - started;
    try {
      hold.settle(READ_ONLY_COST_CENTS);
    } catch {
      hold.release();
    }
    const message = error?.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS} ms` : `network error: ${truncate(error?.message ?? String(error))}`;
    return {
      outcome: "failed",
      name: provider.id,
      errorClass: classifyLiveError(error, status),
      detail: `${message} in ${latencyMs} ms`,
      artifact: liveFailureArtifact({
        provider: provider.id,
        requestShape: shape,
        latencyMs,
        message,
        status,
        error,
        errorClass: classifyLiveError(error, status)
      })
    };
  }
}

async function safeText(response) {
  try {
    return truncate(await response.text());
  } catch {
    return "";
  }
}

function truncate(s, n = 200) {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/** Count models whose pricing is free (0) in an OpenRouter /models body. */
function countFreeModels(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  let free = 0;
  for (const m of list) {
    const id = String(m?.id ?? "");
    const prompt = Number(m?.pricing?.prompt ?? NaN);
    const completion = Number(m?.pricing?.completion ?? NaN);
    const isFreeTag = id.endsWith(":free");
    const isZeroPriced = Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
    if (isFreeTag || isZeroPriced) free += 1;
  }
  return free;
}

async function main() {
  if (!liveProviderTestsEnabled(process.env)) {
    console.log("[live] LIVE_PROVIDER_TESTS is not 1 — opt-in live checks are OFF; nothing run, nothing spent.");
    return 0;
  }

  let capCents;
  try {
    capCents = resolveSpendCapCents(process.env);
  } catch (error) {
    console.error(`[live] ${error.message}`);
    return 2;
  }
  const ledger = createSpendLedger(capCents);
  console.log(`[live] spend cap: ${capCents} cents (hard stop, refuse-before-send). Read-only checks cost 0.`);

  const results = [];
  for (const provider of PROVIDERS) {
    const key = process.env[provider.env];
    if (!key) {
      results.push({ outcome: "skipped", name: provider.id, reason: `${provider.env} is not set` });
      continue;
    }
    // Never print the key. Pass it only in the Authorization header of the read-only call.
    const result = await oneReadOnly(provider, key, ledger);
    results.push(result);
  }

  // Persist redacted failure artifacts; green/skipped leave nothing.
  const artifactDir = join(root, "out", "live-failure-artifacts");
  const failed = results.filter((r) => r.outcome === "failed");
  if (failed.length > 0) {
    await mkdir(artifactDir, { recursive: true });
    for (const r of failed) {
      const file = join(artifactDir, `${r.name}-${Date.now()}.json`);
      await writeFile(file, JSON.stringify(r.artifact, null, 2), "utf8");
      console.error(`[live] failure artifact (redacted): ${file}`);
    }
  }

  for (const r of results) {
    const mark = r.outcome === "ok" ? "ok    " : r.outcome === "skipped" ? "skip  " : "FAIL  ";
    const why = r.outcome === "skipped" ? r.reason : r.detail ?? "";
    const cls = r.outcome === "failed" ? ` [${r.errorClass}]` : "";
    const free = typeof r.freeModels === "number" ? ` (free models: ${r.freeModels})` : "";
    console.log(`[live] ${mark} ${r.name}${cls}${free} — ${why}`);
  }

  const ok = results.filter((r) => r.outcome === "ok").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  console.log("");
  console.log(`[live] ${ok} passed, ${skipped} skipped, ${failed.length} failed; spent ${ledger.spentCents}/${ledger.capCents} cents`);
  return failed.length === 0 ? 0 : 1;
}

const code = await main();
process.exit(code);
