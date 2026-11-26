#!/usr/bin/env node
/**
 * Every end-to-end check in one place.
 *
 * The unit tests cover the library in process. This runs the things that only fail when a real
 * app, a real browser and a real second process are involved, in the order a person would meet
 * them:
 *
 *   smoke       the built desktop app, driven through its own renderer
 *   web         the browser build, over its own storage
 *   audit       the real window at 1440x900, for dead ends and missing controls
 *   phone       the same window at 390x844, because the phone layout is a real surface
 *   glasses     the 600x600 page for Meta Ray-Ban Display, in a browser at that size
 *   ambient     the ambient agent over the control plane and the toolkit
 *   toolkit     the bookwriter CLI and MCP server against the running app, checked on disk
 *   agent       one real agent turn, against a fake provider on loopback (D-184)
 *   plugins     a folder of TypeScript tools, loaded by the built app
 *   bridge      the phone's half: a separate process speaking to the app over the LAN
 *   offline     writing through export with every outbound connection denied (macOS only)
 *   instance    a second copy on the same profile: refused, nothing written, the open copy says so
 *   reader-review  the built reader keyboard journey with an isolated synthetic provider (opt-in, macOS)
 *   reader-review-prestart  the built reader's keyboard cancellation and retired-disclosure refusal (opt-in, macOS)
 *   reader-review-stale  the built reader's refusal after a checked source edit (opt-in, macOS)
 *   reader-review-stop  the built reader's keyboard Stop with a late synthetic response (opt-in, macOS)
 *   reader-review-web  the built browser reader refusal (opt-in)
 *
 *   bun run e2e            build, then run everything
 *   bun run e2e --no-build trust the current build
 *   bun run e2e smoke web  run only the checks named
 *
 * A live check needs keys and costs money, so it is not here. `bun run live:check` is its own gate.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const CHECKS = [
  { id: "smoke", script: "scripts/smoke.mjs", what: "the built app, through its own renderer" },
  { id: "web", script: "scripts/web-smoke.mjs", what: "the browser build and its storage" },
  {
    id: "reader-review-web", script: "scripts/web-smoke.mjs", args: ["--reader-review-refusal"],
    what: "the isolated built browser reader refusal", optIn: true, stampCommit: true
  },
  { id: "audit", script: "scripts/ui-audit.mjs", what: "the real window at 1440x900, for dead ends" },
  {
    id: "phone",
    script: "scripts/ui-audit.mjs",
    args: ["--width", "390", "--height", "844"],
    what: "the same window at phone width, for dead ends"
  },
  { id: "glasses", script: "scripts/glasses-check.mjs", what: "the 600x600 page for the glasses" },
  { id: "ambient", script: "scripts/ambient-check.mjs", what: "the ambient agent and the toolkit" },
  { id: "toolkit", script: "scripts/toolkit-e2e.mjs", what: "the CLI and MCP server, checked on disk" },
  { id: "agent", script: "scripts/agent-check.mjs", what: "a real agent turn, against a fake provider" },
  { id: "plugins", script: "scripts/plugin-probe.mjs", what: "a plugin folder in the built app" },
  { id: "bridge", script: "scripts/bridge-probe.mjs", what: "the phone's half, from another process" },
  {
    id: "offline",
    script: "scripts/offline-check.mjs",
    what: "writing through export with the network denied",
    // The denial is a macOS Seatbelt profile; elsewhere the check proves nothing, so it says so.
    platforms: ["darwin"]
  },
  {
    id: "instance",
    script: "scripts/second-instance-check.mjs",
    what: "a second copy on the same profile, refused with a notice"
  },
  {
    id: "reader-review",
    script: "scripts/reader-review-check.mjs",
    args: ["keyboard-exact-passage"],
    what: "the isolated built desktop reader keyboard journey",
    optIn: true, stampCommit: true
  },
  {
    id: "reader-review-prestart",
    script: "scripts/reader-review-check.mjs",
    args: ["keyboard-prestart-cancel"],
    what: "keyboard cancellation and refusal of a retired reader disclosure",
    optIn: true, stampCommit: true
  },
  {
    id: "reader-review-stale",
    script: "scripts/reader-review-check.mjs",
    args: ["keyboard-changed-source-refusal"],
    what: "the mounted reader refusal after a checked save changes the selected source",
    optIn: true, stampCommit: true
  },
  {
    id: "reader-review-stop",
    script: "scripts/reader-review-check.mjs",
    args: ["keyboard-stop-late-response"],
    what: "keyboard Stop followed by a late synthetic reader response",
    optIn: true, stampCommit: true
  }
];

const argv = process.argv.slice(2);
const build = !argv.includes("--no-build");
const requested = argv.filter((argument) => !argument.startsWith("--"));
const unknown = requested.filter((id) => !CHECKS.some((check) => check.id === id));
if (unknown.length > 0) {
  console.error(`[e2e] Unknown check${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  console.error(`[e2e] Known: ${CHECKS.map((check) => check.id).join(", ")}`);
  process.exit(1);
}
const selection = CHECKS.filter((check) => requested.length > 0 ? requested.includes(check.id) : !check.optIn);

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.on("close", (code) => resolveRun(code ?? 1));
    child.on("error", () => resolveRun(1));
  });
}

if (build) {
  const webOnly = selection.length === 1 && selection[0].id === "reader-review-web";
  const commands = webOnly ? ["build:web"] : ["build", "build:web", "toolkit:build"];
  console.log(webOnly ? "[e2e] building the web app…" : "[e2e] building the desktop app, the web build and the toolkit…");
  const env = { ...process.env };
  if (selection.some((check) => check.stampCommit)) {
    env.GIT_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  }
  for (const command of commands) {
    if (await run("bun", ["run", command], { env }) !== 0) {
      console.error(`[e2e] ${command} failed`);
      process.exit(1);
    }
  }
}

const results = [];
for (const check of selection) {
  if (check.platforms && !check.platforms.includes(process.platform)) {
    results.push({ ...check, ok: true, skipped: true, detail: `skipped: needs ${check.platforms.join(" or ")}` });
    continue;
  }
  const script = join(root, check.script);
  if (!existsSync(script)) {
    results.push({ ...check, ok: false, detail: "the script is missing" });
    continue;
  }
  console.log(`\n[e2e] ── ${check.id}: ${check.what}`);
  const started = Date.now();
  const code = await run(process.execPath, [script, ...(check.args ?? [])]);
  results.push({
    ...check,
    ok: code === 0,
    detail: code === 0 ? `${Math.round((Date.now() - started) / 100) / 10}s` : `exit ${code}`
  });
}

console.log("\n[e2e] ── summary");
for (const result of results) {
  const status = result.skipped ? "skip " : result.ok ? "ok   " : "FAIL ";
  console.log(`[e2e] ${status} ${result.id.padEnd(8)} ${result.what} — ${result.detail}`);
}
const failed = results.filter((result) => !result.ok);
const skipped = results.filter((result) => result.skipped).length;
const ran = results.length - skipped;
const skippedNote = skipped > 0 ? `, ${skipped} skipped` : "";
console.log(
  failed.length === 0
    ? `[e2e] ${ran}/${ran} passed${skippedNote}`
    : `[e2e] ${ran - failed.length}/${ran} passed, ${failed.length} failed${skippedNote}`
);
process.exit(failed.length === 0 ? 0 : 1);
