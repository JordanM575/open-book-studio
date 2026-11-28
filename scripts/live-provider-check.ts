#!/usr/bin/env bun
/**
 * Spec 012 Phase 6 — opt-in live provider checks.
 *
 * Runs ONLY when LIVE_PROVIDER_TESTS=1. Otherwise it prints a skip and exits 0.
 *
 *   LIVE_PROVIDER_TESTS=1 LIVE_SPEND_CAP_CENTS=5 bun run live:providers
 *
 * Per configured model provider it makes ONE cheapest read-only call (a keyed GET on the provider's
 * catalogue/key endpoint — no model is called, nothing is written to any provider). Keys are read
 * from the environment (Bun loads a top-level `.env`); a key is never printed, logged, copied or
 * persisted. A missing key is skipped, not failed. LIVE_SPEND_CAP_CENTS is a hard stop: a request
 * that could exceed it is refused before it is sent. On failure a redacted T026 artifact is written
 * (no secrets, authorization redacted) under LIVE_FAILURE_ARTIFACT_DIR.
 *
 * `bun run keys:check` remains the separate no-spend status command.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_LIVE_FAILURE_ARTIFACT_DIR,
  LIVE_FAILURE_ARTIFACT_DIR_ENV,
  LIVE_PROVIDER_TESTS_ENV,
  LIVE_SPEND_CAP_CENTS_ENV,
  admitRequest,
  buildFailureArtifact,
  cheapestReadOnlyEndpoint,
  cheapestReadOnlyRequest,
  classifyHttpResponse,
  classifyLiveError,
  commitCost,
  liveTestsEnabled,
  newSpendCap,
  parseSpendCapCents,
  providerSources,
  readProviderConfig,
  type LiveErrorClass,
  type LiveOutcome,
  type LiveProviderSource,
  type RedactedRequestShape,
  type SpendCap
} from "../packages/core/src/providers/live-check";
import { parseRetryAfter } from "../packages/core/src/providers/errors";
import type { ProviderEndpoint } from "../packages/core/src/providers/keys";
import type { ProviderErrorCode, ProviderId } from "../packages/core/src/providers/types";

const REQUEST_TIMEOUT_MS = 15_000;
/** Our calls are read-only catalogue/key reads with a provider-enforceable zero bound. */
const READ_ONLY_MAX_COST_CENTS = 0;

interface LiveResult {
  provider: ProviderId;
  providerName: string;
  outcome: LiveOutcome;
  detail: string;
  errorClass?: LiveErrorClass;
  providerCode?: ProviderErrorCode;
  latencyMs?: number;
  artifact?: string;
}

const env = process.env;
const root = resolve(process.cwd());

function say(line: string): void {
  console.log(line);
}

async function main(): Promise<number> {
  if (!liveTestsEnabled(env)) {
    say(`[live] skipped: ${LIVE_PROVIDER_TESTS_ENV} is not "1". Live provider checks are opt-in; nothing ran.`);
    return 0;
  }

  let capCents: number;
  try {
    capCents = parseSpendCapCents(env[LIVE_SPEND_CAP_CENTS_ENV]);
  } catch (error) {
    say(`[live] FAIL ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const artifactDir = (env[LIVE_FAILURE_ARTIFACT_DIR_ENV]?.trim() || DEFAULT_LIVE_FAILURE_ARTIFACT_DIR).toString();
  const artifactRoot = resolve(root, artifactDir);

  let cap: SpendCap = newSpendCap(capCents);
  const createdAt = new Date().toISOString();
  const results: LiveResult[] = [];

  const sources: readonly LiveProviderSource[] = providerSources();
  for (const source of sources) {
    const config = readProviderConfig(source, env);
    if (config.kind === "skipped") {
      results.push({ provider: config.provider, providerName: config.providerName, outcome: "skipped", detail: config.reason });
      continue;
    }

    const { provider, providerName, secret: _secret, ...rest } = config.configured;
    void _secret; // never logged

    let requestShape: RedactedRequestShape;
    let endpoint: ProviderEndpoint;
    try {
      requestShape = cheapestReadOnlyRequest(config.configured);
      endpoint = cheapestReadOnlyEndpoint(config.configured);
    } catch (error) {
      // Could not even form the request (e.g. bad base URL). Not a provider rejection; no artifact secret.
      const cls = classifyLiveError(error, provider);
      results.push({ provider, providerName, outcome: "skipped", detail: cls.message, errorClass: cls.errorClass, providerCode: cls.providerCode });
      continue;
    }

    // FR-020 hard stop: refuse to start a request that could exceed the cap.
    const admission = admitRequest(cap, READ_ONLY_MAX_COST_CENTS);
    if (!admission.admitted) {
      results.push({ provider, providerName, outcome: "blocked", detail: `spend cap ${cap.capCents}c: ${admission.reason}` });
      continue;
    }

    const started = Date.now();
    try {
      const response = await fetch(endpoint.url, {
        method: "GET",
        headers: endpoint.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const latencyMs = Date.now() - started;

      if (response.ok) {
        cap = commitCost(cap, 0); // read-only call, no charge
        results.push({ provider, providerName, outcome: "ok", detail: `accepted in ${latencyMs}ms`, latencyMs });
      } else {
        const body = await response.text().catch(() => ""); // inspected for class, never printed or kept
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
        const cls = classifyHttpResponse(provider, response.status, body, retryAfterSeconds);
        const artifactPath = await writeArtifact(artifactRoot, provider, providerName, {
          provider,
          providerName,
          errorClass: cls.errorClass,
          providerCode: cls.providerCode,
          latencyMs,
          requestShape,
          message: cls.message,
          httpStatus: response.status,
          createdAt
        });
        results.push({ provider, providerName, outcome: "failed", detail: cls.message, errorClass: cls.errorClass, providerCode: cls.providerCode, latencyMs, artifact: artifactPath });
      }
    } catch (error) {
      const latencyMs = Date.now() - started;
      const cls = classifyLiveError(error, provider);
      const artifactPath = await writeArtifact(artifactRoot, provider, providerName, {
        provider,
        providerName,
        errorClass: cls.errorClass,
        providerCode: cls.providerCode,
        latencyMs,
        requestShape,
        message: cls.message,
        httpStatus: null,
        createdAt
      });
      results.push({ provider, providerName, outcome: "failed", detail: cls.message, errorClass: cls.errorClass, providerCode: cls.providerCode, latencyMs, artifact: artifactPath });
    }
    void rest;
  }

  // ---- summary ----
  const count = (o: LiveOutcome): number => results.filter((r) => r.outcome === o).length;
  for (const r of results) {
    const mark = r.outcome === "ok" ? "ok   " : r.outcome === "skipped" ? "skip " : r.outcome === "blocked" ? "block" : "FAIL ";
    const cls = r.errorClass ? ` [${r.errorClass}/${r.providerCode ?? "?"}]` : "";
    const art = r.artifact ? ` → ${r.artifact}` : "";
    say(`[live] ${mark} ${r.providerName.padEnd(12)} ${r.detail}${cls}${art}`);
  }
  const failed = count("failed");
  const blocked = count("blocked");
  say("");
  say(
    `[live] ${count("ok")} passed, ${count("skipped")} skipped, ${blocked} blocked, ${failed} failed · ` +
      `spend ${cap.spentCents}c / cap ${cap.capCents}c · keys are read from the environment and were not printed`
  );
  return failed === 0 && blocked === 0 ? 0 : 1;
}

async function writeArtifact(
  dir: string,
  provider: ProviderId,
  providerName: string,
  fields: {
    provider: ProviderId;
    providerName: string;
    errorClass: LiveErrorClass;
    providerCode: ProviderErrorCode;
    latencyMs: number;
    requestShape: RedactedRequestShape;
    message: string;
    httpStatus: number | null;
    createdAt: string;
  }
): Promise<string> {
  const artifact = buildFailureArtifact({
    provider,
    providerName,
    model: null,
    errorClass: fields.errorClass,
    providerCode: fields.providerCode,
    latencyMs: fields.latencyMs,
    requestShape: fields.requestShape,
    message: fields.message,
    httpStatus: fields.httpStatus,
    createdAt: fields.createdAt
  });
  await mkdir(dir, { recursive: true });
  const safeStamp = fields.createdAt.replace(/[:.]/g, "-");
  const file = join(dir, `${provider}-${safeStamp}.json`);
  await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return file;
}

const code = await main();
process.exit(code);
