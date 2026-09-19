/**
 * Interleaved same-machine phase-2 A/B driver.
 *
 * Copies the tree-agnostic probe (`scripts/perf-ab.mjs`) into both worktrees, then runs
 * alternating pairs so ordering bias is visible, aggregates per-metric means and writes a
 * raw JSON record. Usage:
 *
 *   node scripts/perf-ab-run.mjs --before=.tmp/phase2-before --after=. --pairs=8 --json=docs/performance-phase2-ab.json
 *
 * This produces synthetic microbenchmark evidence only; it is not a live terminal A/B.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const argument = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const beforeDirectory = resolve(argument("before") ?? ".tmp/phase2-before");
const afterDirectory = resolve(argument("after") ?? ".");
const pairs = Number(argument("pairs") ?? 8);
assert.ok(Number.isInteger(pairs) && pairs >= 2 && pairs % 2 === 0, "--pairs must be an even integer >= 2");
const destination = argument("json");
const probe = resolve("scripts/perf-ab.mjs");
assert.ok(existsSync(join(beforeDirectory, "src/render.ts")), `No pre-change worktree at ${beforeDirectory}`);
assert.ok(existsSync(probe), `Missing probe ${probe}`);
copyFileSync(probe, join(beforeDirectory, "scripts/perf-ab.mjs"));
mkdirSync(join(beforeDirectory, ".tmp"), { recursive: true });

const run = (directory, label) => {
  const result = spawnSync(process.execPath, ["scripts/perf-ab.mjs", `--label=${label}`], { cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${label} probe failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
};

const runs = [];
for (let pair = 0; pair < pairs; pair++) {
  const order = pair % 2 === 0 ? ["before", "after"] : ["after", "before"];
  for (const side of order) {
    const report = run(side === "before" ? beforeDirectory : afterDirectory, side);
    runs.push({ pair, side, order, report });
    console.error(`pair ${pair + 1}/${pairs} ${side}: saturatedFull120 p50=${report.renders.saturatedFull120.p50Us.toFixed(1)}us p99=${report.renders.saturatedFull120.p99Us.toFixed(1)}us`);
  }
}

const metricPaths = [
  ["hooks.messageEnd.p99Us", (report) => report.hooks.messageEnd.p99Us],
  ["hooks.toolPair.p99Us", (report) => report.hooks.toolPair.p99Us],
  ["renders.baselineFull120.p50Us", (report) => report.renders.baselineFull120.p50Us],
  ["renders.baselineFull120.meanUs", (report) => report.renders.baselineFull120.meanUs],
  ["renders.baselineFull120.p99Us", (report) => report.renders.baselineFull120.p99Us],
  ["renders.saturatedFull120.p50Us", (report) => report.renders.saturatedFull120.p50Us],
  ["renders.saturatedFull120.meanUs", (report) => report.renders.saturatedFull120.meanUs],
  ["renders.saturatedFull120.p95Us", (report) => report.renders.saturatedFull120.p95Us],
  ["renders.saturatedFull120.p99Us", (report) => report.renders.saturatedFull120.p99Us],
  ["renders.saturatedFull180.meanUs", (report) => report.renders.saturatedFull180.meanUs],
  ["renders.saturatedMono120.meanUs", (report) => report.renders.saturatedMono120.meanUs],
  ["renders.concurrentBalanced120.meanUs", (report) => report.renders.concurrentBalanced120.meanUs],
  ["renders.concurrentBalanced120.p99Us", (report) => report.renders.concurrentBalanced120.p99Us],
  ["renders.concurrentBalanced40.meanUs", (report) => report.renders.concurrentBalanced40.meanUs],
  ["renders.emptyIdle120.meanUs", (report) => report.renders.emptyIdle120.meanUs],
  ["cachedRender.meanUs", (report) => report.cachedRender.meanUs],
];

const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
const summary = {};
for (const [path, read] of metricPaths) {
  const before = mean(runs.filter((run) => run.side === "before").map((run) => read(run.report)));
  const after = mean(runs.filter((run) => run.side === "after").map((run) => read(run.report)));
  summary[path] = { before, after, deltaPercent: before === 0 ? null : ((after - before) / before) * 100 };
}

const record = {
  generatedAt: new Date().toISOString(),
  methodology: "Interleaved same-machine synthetic microbenchmarks across pairs of before/after runs, alternating order inside each pair. The pre-change worktree ignores the phase-2 snapshot fields; both sides use identical fixtures, sample counts and the copied probe file. Gates are unchanged (hook p99 <= 250 us, uncached render p99 <= 5 ms, cached mean <= 5 us). NOT a live Pi/provider/terminal A/B.",
  before: { directory: beforeDirectory, commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: beforeDirectory, encoding: "utf8" }).stdout.trim() },
  after: { directory: afterDirectory, commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: afterDirectory, encoding: "utf8" }).stdout.trim(), workingTree: true },
  pairs, runsPerSide: runs.length / 2,
  environment: runs[0].report.environment,
  summary,
  runs: runs.map((run) => ({ pair: run.pair, side: run.side, report: run.report })),
};
const output = JSON.stringify(record, null, 2) + "\n";
if (destination) writeFileSync(destination, output);
console.log(JSON.stringify(summary, null, 2));
