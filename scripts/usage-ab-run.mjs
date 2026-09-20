/**
 * B2b usage-scope A/B driver: >= 8 interleaved pairs of observed/session runs of the
 * same probe in separate processes on this machine, alternating order inside each
 * pair, with full commit/dirty-state provenance. Writes the raw JSON record.
 *
 *   node scripts/usage-ab-run.mjs --pairs=8 --json=docs/performance-b2b-usage-ab.json
 *
 * Synthetic microbenchmark evidence only; the pinned-SDK history measurements and the
 * live-host acceptance are separate records.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cpus, platform, arch, totalmem } from "node:os";

const argument = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const pairs = Number(argument("pairs") ?? 8);
assert.ok(Number.isInteger(pairs) && pairs >= 2 && pairs % 2 === 0, "--pairs must be an even integer >= 2");
const destination = argument("json") ?? "docs/performance-b2b-usage-ab.json";

const sdkLock = ".tmp/sdk/package-lock.json";
const lockHash = existsSync(sdkLock) ? createHash("sha256").update(readFileSync(sdkLock)).digest("hex") : null;
const git = (args) => spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const dirtyFiles = {};
for (const line of git(["status", "--porcelain"]).split("\n").filter(Boolean)) {
  const path = line.slice(3).trim();
  try {
    dirtyFiles[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    dirtyFiles[path] = "unreadable";
  }
}

const run = (label) => {
  const result = spawnSync(process.execPath, ["scripts/usage-ab.mjs", `--label=${label}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${label} probe failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
};

const runs = [];
for (let pair = 0; pair < pairs; pair++) {
  const order = pair % 2 === 0 ? ["observed", "session"] : ["session", "observed"];
  for (const side of order) {
    const report = run(side);
    runs.push({ pair, side, order, report });
    console.error(`pair ${pair + 1}/${pairs} ${side}: ledgerVerify=${report.ledgerVerify.meanUs.toFixed(2)}us fullTurn=${report.fullTurn.meanUs.toFixed(2)}us (flushes ${report.fullTurnFlushes}) widget=${report.renders.widgetFull120.meanUs.toFixed(2)}us`);
  }
}

const metricPaths = [
  ["hooks.messageEnd.p99Us", (r) => r.hooks.messageEnd.p99Us],
  ["hooks.toolPair.p99Us", (r) => r.hooks.toolPair.p99Us],
  ["hooks.turnEndBare.meanUs", (r) => r.hooks.turnEndBare.meanUs],
  ["hooks.turnEndBare.p99Us", (r) => r.hooks.turnEndBare.p99Us],
  ["ledgerVerify.meanUs", (r) => r.ledgerVerify.meanUs],
  ["ledgerVerify.p99Us", (r) => r.ledgerVerify.p99Us],
  ["fullTurn.meanUs", (r) => r.fullTurn.meanUs],
  ["fullTurn.p95Us", (r) => r.fullTurn.p95Us],
  ["fullTurn.p99Us", (r) => r.fullTurn.p99Us],
  ["renders.widgetFull120.meanUs", (r) => r.renders.widgetFull120.meanUs],
  ["renders.widgetFull120.p99Us", (r) => r.renders.widgetFull120.p99Us],
  ["renders.footerFull120.meanUs", (r) => r.renders.footerFull120.meanUs],
  ["renders.footerFull120.p99Us", (r) => r.renders.footerFull120.p99Us],
  ["renders.widgetCached.meanUs", (r) => r.renders.widgetCached.meanUs],
  ["renders.footerCached.meanUs", (r) => r.renders.footerCached.meanUs],
];
const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
const deviation = (values, m) => Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
const summary = {};
for (const [path, read] of metricPaths) {
  const beforeValues = runs.filter((run) => run.side === "observed").map((run) => read(run.report));
  const afterValues = runs.filter((run) => run.side === "session").map((run) => read(run.report));
  const before = mean(beforeValues);
  const after = mean(afterValues);
  // Paired per-run deltas make the direction clearer than the means alone.
  const deltas = runs.filter((run) => run.side === "observed").map((run, index) => {
    const sessionRun = runs.filter((r) => r.side === "session" && r.pair === run.pair)[0];
    return read(sessionRun.report) - read(run.report);
  });
  const deltaMean = mean(deltas);
  summary[path] = {
    observed: before, session: after,
    deltaAbsoluteUs: after - before,
    deltaPercent: before === 0 ? null : ((after - before) / before) * 100,
    pairedDeltaMeanUs: deltaMean,
    pairedDeltaStdDevUs: deviation(deltas, deltaMean),
    pairsPositive: deltas.filter((value) => value > 0).length,
  };
}

const record = {
  generatedAt: new Date().toISOString(),
  methodology: "Interleaved same-machine synthetic microbenchmarks: one flag different (usageScope observed vs session), separate processes, alternating order inside each pair, identical fixtures (2000-entry fake-manager history), sample counts and probe file. ledgerVerify drains only the zero-delay reconciliation (advance(0)); fullTurn drains the 250ms coalesced publication too (advance(250)) and each run fails unless exactly one publication fired per turn, so the full-turn number includes flush+publish. The existing gates (hook p99 <= 250us, uncached render p99 <= 5ms, cached mean <= 5us) are unchanged and remain enforced by bench/run.mjs. NOT a live Pi/provider/terminal A/B.",
  environment: {
    node: runs[0].report.environment.node, platform: platform(), arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, totalMemBytes: totalmem(),
    sdkLockSha256: lockHash,
    commit: git(["rev-parse", "HEAD"]),
    dirtyFilesSha256: dirtyFiles,
  },
  treeStateNote: "dirtyFilesSha256 hashes every modified/untracked file's content before any probe runs; the JSON record is written afterwards. Both sides run the same tree with the same dirty state.",
  pairs, runsPerSide: runs.length / 2,
  summary,
  runs: runs.map((run) => ({ pair: run.pair, side: run.side, report: run.report })),
};
writeFileSync(destination, JSON.stringify(record, null, 2) + "\n");
console.error(`wrote ${destination}`);
console.log(JSON.stringify(summary, null, 2));
