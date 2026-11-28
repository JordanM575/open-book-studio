#!/usr/bin/env bun
/**
 * Opt-in live provider checks (spec 012 T024, FR-019/FR-020/FR-021, T026).
 *
 * One cheapest read-only call per configured provider key. No content is created. No key material,
 * authorization header or secret value is ever printed, logged or persisted; only key NAMES appear.
 *
 *   LIVE_PROVIDER_TESTS=1 LIVE_SPEND_CAP_CENTS=5 bun scripts/live-providers.mjs
 *
 * Keys are read from the product root `.env` (and `.env.local`, the repo's own convention) plus the
 * process environment. If `.env` is absent and no keys are set, every provider is skipped with a
 * reason. `LIVE_SPEND_CAP_CENTS` is a hard stop in US cents; a request that could exceed it is
 * refused before it starts. Failing checks write a redacted artifact (T026) under
 * `out/live-checks/`.
 *
 * This command is never part of the fast `bun run verify` path; it runs only when explicitly opted in.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLiveProviderChecks, LIVE_PROVIDER_TESTS_FLAG } from "../packages/core/src/providers/live-checks.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Parse a dotenv file into memory. Values are never printed. Missing file → {}. */
async function readDotenv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const dotenvLocal = await readDotenv(join(root, ".env.local"));
const dotenv = await readDotenv(join(root, ".env"));
const env = { ...dotenvLocal, ...dotenv, ...process.env };

if (env[LIVE_PROVIDER_TESTS_FLAG]?.trim() !== "1") {
  console.log(`[live-providers] skipped: set ${LIVE_PROVIDER_TESTS_FLAG}=1 to opt in. No provider calls were made.`);
  console.log(`[live-providers] passed 0, skipped 0, failed 0`);
  process.exit(0);
}

if (!existsSync(join(root, ".env")) && !existsSync(join(root, ".env.local"))) {
  console.log("[live-providers] note: no .env at the product root; only keys already in the environment can be checked.");
}

const run = await runLiveProviderChecks(env, {});

for (const result of run.results) {
  if (result.outcome === "ok") {
    const free = result.freeModelsAvailable === undefined ? "" : ` · free-models ${result.freeModelsAvailable ? "yes" : "no"}`;
    const ms = result.latencyMs === undefined ? "" : ` · ${result.latencyMs}ms`;
    console.log(`[live-providers] ok       ${result.provider}${ms}${free}`);
  } else if (result.outcome === "skipped") {
    console.log(`[live-providers] skipped  ${result.provider} — ${result.skipReason ?? "no reason recorded"}`);
  } else {
    console.log(
      `[live-providers] FAIL     ${result.provider} — ${result.errorClass ?? "provider"}/${result.errorCode ?? "unknown"} · ${result.latencyMs ?? 0}ms`
    );
    // The message is already redacted by the core module; print no request body or header value.
    if (result.message) console.log(`[live-providers]          ${result.message}`);
  }
}

const artifactDir = join(root, "out", "live-checks");
if (run.artifacts.length > 0) {
  await mkdir(artifactDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const artifact of run.artifacts) {
    const file = join(artifactDir, `${stamp}-${artifact.provider}.json`);
    // artifact is redacted; assert no secret leaks defensively before writing.
    const json = JSON.stringify(artifact, null, 2);
    await writeFile(file, json + "\n", "utf8");
    console.log(`[live-providers] artifact ${file}`);
  }
}

console.log(
  `[live-providers] passed ${run.passed}, skipped ${run.skipped}, failed ${run.failed} · ` +
    `spend ${run.cap.spentCents}c / cap ${run.cap.capCents}c · ` +
    `keys read from environment; no key material printed.`
);

process.exit(run.failed === 0 ? 0 : 1);
