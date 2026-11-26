#!/usr/bin/env node
/**
 * The coverage ratchet.
 *
 * Coverage was never measured, which means nobody could tell whether a change made it worse. It
 * is measured now, and the floor only moves up: a change that drops it below the floor fails, and
 * a change that raises it is expected to raise the floor in the same commit.
 *
 *   bun run coverage            check against the floor
 *   bun run coverage --raise    print what the floor should become
 *
 * Bun's coverage does not fail a run by itself, so this reads the table it prints and decides.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { devNull } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactLine } from "./failure-artifacts.mjs";

/**
 * The floor, kept a little under the current numbers so a refactor does not fail for noise.
 *
 * 2026-10-26: raised from 80/87 to 85/92 after a pass that took the measured numbers from 81.4/88.3
 * to 86.0/93.0. The floor moves up with the numbers, which is the whole point of having one.
 */
export const FLOOR = { functions: 85, lines: 92 };

/*
 * What is counted, and how it is averaged.
 *
 * Bun's "All files" line averages every file the run loaded, and not all of them are the
 * repository's. The plugin tests write TypeScript fixtures into temporary folders and load them,
 * so rows such as `$TMPDIR/studio-capabilities-<random>/demo.ts` join the table, most of them at 0%
 * of functions, and a different set on every run. They moved the summary with the fixtures, not
 * with the code.
 *
 * So the check reads bun's per-file rows, keeps the files inside the repository root and says how
 * many it left out. The average is the one bun's summary uses: the unweighted mean of the per-file
 * percentages, where every file counts once whatever its size. The floor is the same one. Leaving
 * the fixtures out does not lower the bar; it stops counting code that is not the repository's.
 *
 * The method is checked, not assumed: the mean of every row must match bun's own summary first, so
 * a bun that averages or prints differently fails the check instead of quietly moving the number.
 */

/** Bun rounds each row and its summary to two decimals, so the two means agree to about 0.01. */
const SUMMARY_SLACK = 0.05;

/**
 * Bun's coverage table, read row by row.
 *
 *   File        | % Funcs | % Lines | Uncovered Line #s
 *   All files   |   84.83 |   90.69 |
 *    apps/a.ts  |   77.78 |   77.05 | 58-68,70
 *
 * The columns are found by their headings, so a column bun adds later does not shift the numbers.
 * Every row between the heading and the closing rule must read, or the check fails: a row skipped
 * quietly would be a file the average no longer counts.
 */
export function parseCoverageTable(output) {
  const lines = output.split(/\r?\n/);
  // The last table wins: bun prints its own after every test file has run.
  const headingAt = lines.findLastIndex((line) => cells(line)[0] === "File");
  if (headingAt === -1) throw new Error("there is no coverage table in the output");
  const heading = cells(lines[headingAt]);
  const functionsAt = heading.indexOf("% Funcs");
  const linesAt = heading.indexOf("% Lines");
  if (functionsAt === -1 || linesAt === -1) {
    throw new Error(`the coverage table has no functions or lines column: ${lines[headingAt].trim()}`);
  }
  if (!isRule(lines[headingAt + 1])) throw new Error("the coverage table heading is not followed by a rule");

  let summary = null;
  const files = [];
  let index = headingAt + 2;
  for (; index < lines.length && !isRule(lines[index]); index += 1) {
    const row = cells(lines[index]);
    const functions = percent(row[functionsAt]);
    const covered = percent(row[linesAt]);
    if (!row[0] || functions === null || covered === null) {
      throw new Error(`could not read the coverage row: ${lines[index].trim() || "(an empty line)"}`);
    }
    if (row[0] === "All files") summary = { functions, lines: covered };
    else files.push({ file: row[0], functions, lines: covered });
  }
  if (index === lines.length) throw new Error("the coverage table never closes, so the output was cut short");
  if (!summary) throw new Error("the coverage table has no All files row");
  if (files.length === 0) throw new Error("the coverage table lists no files");
  return { summary, files };
}

/** Whether a row names a file inside the repository. Bun prints paths relative to where it ran. */
export function insideRoot(root, file) {
  const path = relative(root, resolve(root, file));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** The repository's own numbers from bun's table, and the files it left out. */
export function measure(output, root) {
  const table = parseCoverageTable(output);
  const all = mean(table.files);
  const drift = Math.max(
    Math.abs(all.functions - table.summary.functions),
    Math.abs(all.lines - table.summary.lines)
  );
  if (drift > SUMMARY_SLACK) {
    throw new Error(
      `bun's summary (functions ${table.summary.functions}%, lines ${table.summary.lines}%) is not the mean of its rows (functions ${shown(all.functions)}%, lines ${shown(all.lines)}%), so bun averages differently now`
    );
  }
  const inside = table.files.filter((row) => insideRoot(root, row.file));
  if (inside.length === 0) throw new Error("no file in the coverage table is inside the repository");
  return {
    ...mean(inside),
    files: inside.length,
    outside: table.files.filter((row) => !insideRoot(root, row.file)).map((row) => row.file),
    bun: table.summary
  };
}

/** The numbers under the floor, as the check reports them. A number that is not one is under it. */
export function belowFloor(measured, floor = FLOOR) {
  const below = [];
  if (!(measured.functions >= floor.functions)) below.push(`functions ${shown(measured.functions)}% < ${floor.functions}%`);
  if (!(measured.lines >= floor.lines)) below.push(`lines ${shown(measured.lines)}% < ${floor.lines}%`);
  return below;
}

const MAX_FAILURES = 5;
const MAX_TEST_NAME = 120;
const MAX_TEST_PATH = 160;
const TEST_PATH = /^(?:apps|packages)\/[\w-]+\/tests\/(?:[\w-]+\/)*[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const BUN_FOOTER = /\r?\n[ ]*([1-9]\d*) fail\r?\n(?:[ ]*\d+ (?:errors?|expect\(\) calls?)\r?\n)*Ran \d+ tests? across \d+ files?\. \[\d+(?:\.\d+)?(?:ms|s)\]\r?\n$/;

function failedTests(stderr, root) {
  const footer = BUN_FOOTER.exec(stderr);
  if (!footer) return [];
  try {
    parseCoverageTable(stderr);
  } catch {
    return [];
  }

  const candidates = [];
  let file = "";
  let count = 0;
  for (const line of stderr.slice(0, footer.index).split(/\r?\n/)) {
    const header = /^(.+\.[cm]?[jt]sx?):$/.exec(line);
    if (header) file = header[1];
    if (!line.startsWith("(fail)")) continue;
    const failure = /^\(fail\) (.+) \[\d+(?:\.\d+)?(?:ms|s)\]$/.exec(line);
    if (!failure) return [];
    count += 1;
    if (candidates.length === MAX_FAILURES || file.length > MAX_TEST_PATH || !TEST_PATH.test(file)) continue;
    const label = failure[1];
    if (/[\p{C}\p{Zl}\p{Zp}]/u.test(label) || redactLine(label) !== label || redactLine(file) !== file) continue;
    candidates.push({ file, name: label.split(" > ").at(-1) });
  }
  // An assertion or console write can look exactly like a result on stderr.
  if (count !== Number(footer[1])) return [];

  const sources = new Map();
  return candidates.flatMap(({ file, name }) => {
    // Use a committed test declaration as the output source. A plausible stderr line or a
    // test-created file alone cannot authorize printing its text.
    if (!sources.has(file)) {
      const source = spawnSync("git", ["--git-dir=.git", "cat-file", "blob", `HEAD:${file}`], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: devNull,
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1"
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 256 * 1024
      });
      sources.set(file, source.status === 0 && !source.error ? source.stdout : "");
    }
    const declarations = sources.get(file).matchAll(
      /^[ \t]*(?:test|it)(?:\.(?:concurrent|serial|failing))?\([ \t]*(?:"([^"\\\r\n]+)"|'([^'\\\r\n]+)')[ \t]*,/gm
    );
    for (const declaration of declarations) {
      const title = declaration[1] ?? declaration[2];
      if (title !== name) continue;
      const characters = [...title];
      const displayed = characters.length > MAX_TEST_NAME ? `${characters.slice(0, MAX_TEST_NAME - 1).join("")}…` : title;
      return [`[coverage] failed test in ${file} · ${displayed}`];
    }
    return [];
  });
}

/**
 * The verdict on one run: what to print, on which stream, and the exit code.
 *
 * Bun prints the coverage table on stderr, and a failing suite still prints it, so both streams
 * are read and the exit code is judged separately.
 */
export function judge(run, root, { raise = false, floor = FLOOR } = {}) {
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.status !== 0) {
    const message = output.includes("All files")
      ? "[coverage] the test suite failed, which matters more than the number"
      : "[coverage] the test run did not complete";
    const messages = [["error", message]];
    if (run.status === 1 && !run.error && !run.signal && run.stderr) {
      for (const identity of failedTests(run.stderr, root)) messages.push(["error", identity]);
    }
    return { code: 1, messages };
  }

  let measured;
  try {
    measured = measure(output, root);
  } catch (error) {
    return { code: 1, messages: [["error", `[coverage] ${error.message}`]] };
  }

  const messages = [
    [
      "log",
      `[coverage] functions ${shown(measured.functions)}% (floor ${floor.functions}%), lines ${shown(measured.lines)}% (floor ${floor.lines}%), over ${measured.files} files in the repository`
    ]
  ];
  if (measured.outside.length > 0) {
    messages.push([
      "log",
      `[coverage] left out ${measured.outside.length} ${measured.outside.length === 1 ? "file" : "files"} outside the repository; bun's summary with them is functions ${measured.bun.functions}%, lines ${measured.bun.lines}%`
    ]);
    for (const file of measured.outside) messages.push(["log", `[coverage]   ${file}`]);
  }

  if (raise) {
    messages.push([
      "log",
      `[coverage] the floor could be { functions: ${Math.floor(measured.functions)}, lines: ${Math.floor(measured.lines)} }`
    ]);
    return { code: 0, messages };
  }

  const below = belowFloor(measured, floor);
  if (below.length > 0) {
    messages.push(
      ["error", `[coverage] below the floor: ${below.join(", ")}`],
      ["error", "[coverage] add a test, or explain in the commit why the floor should drop"]
    );
    return { code: 1, messages };
  }
  messages.push(["log", "[coverage] at or above the floor"]);
  return { code: 0, messages };
}

function cells(line) {
  return (line ?? "").split("|").map((cell) => cell.trim());
}

function isRule(line) {
  return /^-+(?:\|-+)+\|?$/.test((line ?? "").trim());
}

function percent(cell) {
  if (cell === undefined || !/^\d+(?:\.\d+)?$/.test(cell)) return null;
  const value = Number(cell);
  return value <= 100 ? value : null;
}

function mean(rows) {
  const sum = rows.reduce(
    (total, row) => ({ functions: total.functions + row.functions, lines: total.lines + row.lines }),
    { functions: 0, lines: 0 }
  );
  return { functions: sum.functions / rows.length, lines: sum.lines / rows.length };
}

/**
 * Two decimals, cut rather than rounded, so 91.996 never prints as a passing 92.00. The nudge keeps
 * a float such as 92.29 * 100 = 9228.999… from printing as 92.28.
 */
function shown(value) {
  return (Math.floor(value * 100 + 1e-6) / 100).toFixed(2);
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const run = spawnSync("bun", ["test", "--coverage"], { cwd: root, encoding: "utf8" });
  const verdict = judge(run, root, { raise: process.argv.includes("--raise") });
  for (const [stream, text] of verdict.messages) console[stream](text);
  process.exitCode = verdict.code;
}

/*
 * Run only as a script. The tests import the parser, and a check that ran the suite from inside
 * the suite would never finish. Both paths go through realpath: compared as written, a symlinked
 * path to this file would skip the check and exit 0, which reads as a pass.
 */
const invokedAsScript = (() => {
  try {
    return realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsScript) main();
