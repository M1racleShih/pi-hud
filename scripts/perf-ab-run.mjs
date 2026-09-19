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

const treeState = (directory) => {
  const git = (args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" }).stdout.trim();
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  return { directory, commit: git(["rev-parse", "HEAD"]), dirtyPathsAtStart: dirty.length };
};
const beforeState = treeState(beforeDirectory);
const afterState = treeState(afterDirectory);

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
  // Phase 3: present only on a tree that has the footer surface module.
  ["footer.renders.footerFull120.meanUs", (report) => report.footer?.renders?.footerFull120?.meanUs],
  ["footer.renders.footerFull120.p99Us", (report) => report.footer?.renders?.footerFull120?.p99Us],
  ["footer.renders.footerBalanced120.meanUs", (report) => report.footer?.renders?.footerBalanced120?.meanUs],
  ["footer.renders.footerNarrow40.meanUs", (report) => report.footer?.renders?.footerNarrow40?.meanUs],
  ["footer.renders.footerNoStatus120.meanUs", (report) => report.footer?.renders?.footerNoStatus120?.meanUs],
  ["footer.cachedRender.meanUs", (report) => report.footer?.cachedRender?.meanUs],
];

const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
const summary = {};
const unavailable = [];
for (const [path, read] of metricPaths) {
  const beforeValues = runs.filter((run) => run.side === "before").map((run) => read(run.report));
  const afterValues = runs.filter((run) => run.side === "after").map((run) => read(run.report));
  // A scenario added in this phase exists only on the after side; it is reported as new
  // instead of being compared against an absent baseline.
  if (!beforeValues.every((value) => Number.isFinite(value)) || !afterValues.every((value) => Number.isFinite(value))) {
    summary[path] = { before: null, after: Number.isFinite(afterValues[0]) ? mean(afterValues.filter(Number.isFinite)) : null, deltaPercent: null, note: "new scenario; no pre-change baseline" };
    unavailable.push(path);
    continue;
  }
  const before = mean(beforeValues);
  const after = mean(afterValues);
  summary[path] = { before, after, deltaPercent: before === 0 ? null : ((after - before) / before) * 100 };
}

const record = {
  generatedAt: new Date().toISOString(),
  methodology: "Interleaved same-machine synthetic microbenchmarks across pairs of before/after runs, alternating order inside each pair. The pre-change worktree ignores the phase-2 snapshot fields; both sides use identical fixtures, sample counts and the copied probe file. Gates are unchanged (hook p99 <= 250 us, uncached render p99 <= 5 ms, cached mean <= 5 us). NOT a live Pi/provider/terminal A/B.",
  before: beforeState,
  after: afterState,
  treeStateNote: "dirtyPathsAtStart is measured before any probe runs. The before tree's one dirty path is the copied probe file, which is byte-identical in both trees; the after tree must be clean at measurement start. The runner writes only its JSON record afterwards.",
  pairs, runsPerSide: runs.length / 2,
  newScenariosWithoutBaseline: unavailable,
  environment: runs[0].report.environment,
  summary,
  runs: runs.map((run) => ({ pair: run.pair, side: run.side, report: run.report })),
};
const output = JSON.stringify(record, null, 2) + "\n";
if (destination) writeFileSync(destination, output);
console.log(JSON.stringify(summary, null, 2));
