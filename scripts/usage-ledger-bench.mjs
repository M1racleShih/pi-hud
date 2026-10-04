/**
 * B2b long-history session-ledger benchmark (single size/shape per process).
 *
 * Measures, for one (size, shape) fixture against the REAL pinned Pi 1.0.2
 * SessionManager and the REAL `SessionUsageLedger`:
 *
 *   fixture construction | host manager load | getEntries sync copy   (separately)
 *   HUD attach: wall/CPU, max slice, longest event-loop pause (external probe),
 *               peak & post-release heap/RSS
 *   structural rebuilds (tree, compact), steady increments (1/32/2048),
 *   over-cap (>2048) recovery, catch-up during slicing, fast session switch/cancel.
 *
 * Every phase asserts correctness against the independent fixture oracle, so a timing
 * number can never come from a wrong total. Run through `usage-ledger-bench-run.mjs`
 * (adds --expose-gc, collects all sizes/shapes into one JSON record):
 *
 *   node scripts/usage-ledger-bench.mjs --size=1000 --shape=linear
 *
 * Requires the isolated pinned SDK install under .tmp/sdk. No network, no credentials.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { SessionUsageLedger } from "../src/usage.ts";
import { buildFixture, replayOps, oracleTotals, usageFor } from "./usage-fixtures.mjs";
import { SessionManager } from "../.tmp/sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";

const argument = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const size = Number(argument("size") ?? 1_000);
const shape = argument("shape") ?? "linear";
assert.ok([1_000, 10_000, 100_000].includes(size), "--size must be 1000, 10000 or 100000");
assert.ok(["linear", "branched"].includes(shape), "--shape must be linear or branched");
const gc = typeof globalThis.gc === "function" ? globalThis.gc : null;

/**
 * External event-loop pause probe: a setImmediate loop that measures the gap between
 * successive iterations. Any synchronous block (getEntries copy, aggregation slice,
 * incremental walk) delays the probe; the max gap approximates the longest
 * uninterruptible pause attributable to the workload plus GC. The probe also samples
 * heapUsed/rss. Its own overhead is measured separately over an idle window.
 */
class LoopProbe {
  constructor() {
    this.running = false;
    this.gaps = [];
    this.maxGapMs = 0;
    this.iterations = 0;
    this.heapSamples = [];
    this.rssSamples = [];
    this.last = 0;
    this.cpuStart = null;
  }
  start() {
    this.running = true;
    this.gaps = []; this.maxGapMs = 0; this.iterations = 0; this.heapSamples = []; this.rssSamples = [];
    this.cpuStart = process.cpuUsage();
    this.last = performance.now();
    const step = () => {
      if (!this.running) return;
      const now = performance.now();
      const gap = now - this.last;
      if (gap > this.maxGapMs) this.maxGapMs = gap;
      if (this.gaps.length < 200_000) this.gaps.push(gap);
      if ((this.iterations & 31) === 0) {
        const memory = process.memoryUsage();
        this.heapSamples.push(memory.heapUsed);
        this.rssSamples.push(memory.rss);
      }
      this.iterations++;
      this.last = now;
      setImmediate(step);
    };
    setImmediate(step);
  }
  stop() {
    this.running = false;
    const cpu = process.cpuUsage(this.cpuStart);
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const percentile = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
    return {
      iterations: this.iterations,
      maxGapMs: this.maxGapMs,
      p50GapMs: percentile(0.5), p95GapMs: percentile(0.95), p99GapMs: percentile(0.99),
      cpuMs: (cpu.user + cpu.system) / 1_000,
      heapPeakBytes: this.heapSamples.length ? Math.max(...this.heapSamples) : null,
      rssPeakBytes: this.rssSamples.length ? Math.max(...this.rssSamples) : null,
    };
  }
}

const sleep0 = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Run the loop until the ledger is quiet twice in a row. */
async function quiet(ledger) {
  for (let index = 0; index < 5_000_000; index++) {
    await sleep0();
    if (!ledger.busy()) {
      await sleep0();
      if (!ledger.busy()) return;
    }
  }
  assert.fail("the ledger never reached a quiet state");
}

const totalsOf = (view) => `${view.input}/${view.output}/${view.cacheRead}/${view.cacheWrite}/${view.cost.toFixed(2)}`;
function assertTotals(ledger, oracle, label) {
  const view = ledger.view();
  assert.ok(view, `${label}: no view published`);
  assert.ok(!ledger.busy(), `${label}: ledger must be quiet when compared`);
  assert.equal(view.input, oracle.input, `${label}: input`);
  assert.equal(view.output, oracle.output, `${label}: output`);
  assert.equal(view.cacheRead, oracle.cacheRead, `${label}: cacheRead`);
  assert.equal(view.cacheWrite, oracle.cacheWrite, `${label}: cacheWrite`);
  assert.ok(Math.abs(view.cost - oracle.cost) < 1e-6, `${label}: cost ${view.cost} vs ${oracle.cost}`);
  assert.equal(view.usageRecords, oracle.usageRecords, `${label}: usageRecords`);
}

const nowMs = () => performance.now();
const cpuNow = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1_000; };
const memorySnapshot = () => { const m = process.memoryUsage(); return { heapUsed: m.heapUsed, rss: m.rss }; };

/** Append K assistant entries with deterministic usage to the manager (returns oracle). */
function appendK(manager, ledger, K, seedBase) {
  for (let k = 0; k < K; k++) {
    const n = seedBase + k;
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: `appended entry ${n} with a bounded amount of content text` }],
      api: "openai-completions", provider: "fixture", model: "fixture-alpha",
      usage: usageFor(500_000 + n), stopReason: "stop", timestamp: n,
    });
    if (ledger) ledger.onMessageEnd();
  }
}
const oracleForAppends = (K, seedBase) => {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usageRecords: 0, examined: K };
  for (let k = 0; k < K; k++) {
    const usage = usageFor(500_000 + seedBase + k);
    totals.input += usage.input; totals.output += usage.output;
    totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
    totals.usageRecords++;
  }
  return totals;
};

const addedTotals = (a, b) => ({
  input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost + b.cost, usageRecords: a.usageRecords + b.usageRecords,
  examined: a.examined + b.examined,
});

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------
const report = {
  size, shape, gcAvailable: gc !== null,
  startedAt: new Date().toISOString(),
};

// Warm-up (JIT + allocator) on a small fixture; not measured.
{
  const warm = buildFixture(600, shape, 0xdead);
  const manager = SessionManager.inMemory("/tmp/pi-hud-bench-warm");
  replayOps(manager, warm);
  const ledger = new SessionUsageLedger({});
  ledger.restart(manager, "warmup");
  await quiet(ledger);
  assertTotals(ledger, oracleTotals(warm.entries), "warmup");
  ledger.dispose();
}

// Probe idle noise floor: same instrumentation, no ledger work.
{
  const probe = new LoopProbe();
  probe.start();
  const until = nowMs() + 150;
  while (nowMs() < until) await sleep0();
  report.probeIdle = probe.stop();
}

// Fixture construction (plain objects; the JSONL content a real session would carry).
let fixture;
{
  const t0 = nowMs();
  fixture = buildFixture(size, shape, 0x0b2b5eed);
  report.fixtureBuildMs = nowMs() - t0;
  report.fixtureMeta = fixture.meta;
}

// Host manager load: the real pinned SessionManager ingesting the same op stream.
let manager;
{
  const t0 = nowMs(); const c0 = cpuNow();
  manager = SessionManager.inMemory("/tmp/pi-hud-bench-load");
  replayOps(manager, fixture);
  report.managerLoad = { wallMs: nowMs() - t0, cpuMs: cpuNow() - c0, entryCount: manager.getEntries().length };
  assert.equal(report.managerLoad.entryCount, fixture.entries.length, "manager entry count must match the fixture");
}

// getEntries synchronous copy: standalone, five samples.
{
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = nowMs();
    const entries = manager.getEntries();
    samples.push({ ms: nowMs() - t0, length: entries.length });
  }
  samples.sort((a, b) => a.ms - b.ms);
  report.getEntriesCopy = { samples, medianMs: samples[2].ms, maxMs: samples[4].ms };
}

const oracle = oracleTotals(fixture.entries);

// HUD attach: one baseline over the fully loaded manager, externally probed.
{
  // GC with settling delays lets V8's concurrent sweeper finish the manager-load garbage,
  // so the before/peak/after attribution reflects the ledger itself instead of un-swept
  // pages from the load phase (verified: a single immediate gc, or a single event-loop
  // turn, attributes ~40-56 MiB of load-phase garbage to the 100k attach phase).
  gc?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
  gc?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
  gc?.();
  const before = memorySnapshot();
  const probe = new LoopProbe();
  const ledger = new SessionUsageLedger({});
  probe.start();
  const t0 = nowMs(); const c0 = cpuNow();
  ledger.restart(manager, "bench-attach");
  await quiet(ledger);
  const wallMs = nowMs() - t0; const cpuMs = cpuNow() - c0;
  const probeResult = probe.stop();
  assertTotals(ledger, oracle, `attach ${size}/${shape}`);
  const diag = ledger.inspect();
  assert.equal(diag.hostCalls.getEntries, 1, "exactly one getEntries per baseline");
  await new Promise((resolve) => setTimeout(resolve, 50));
  gc?.();
  const released = memorySnapshot();
  // Control window: the same probe load for the same duration with NO ledger work on the
  // same settled heap. V8 re-grows/fragments old-space pages after a compaction, so the
  // attach peak delta alone would over-attribute; this bounds the measurement noise.
  const controlProbe = new LoopProbe();
  controlProbe.start();
  const controlUntil = nowMs() + wallMs;
  while (nowMs() < controlUntil) await sleep0();
  const control = controlProbe.stop();
  report.attach = {
    wallMs, cpuMs, netCpuMs: cpuMs - (report.probeIdle.cpuMs / 150) * wallMs,
    lastBaselineMs: diag.lastBaselineMs, maxSliceMs: diag.maxChunkMs,
    probe: probeResult,
    heapBeforeBytes: before.heapUsed, rssBeforeBytes: before.rss,
    heapPeakBytes: probeResult.heapPeakBytes, rssPeakBytes: probeResult.rssPeakBytes,
    heapAfterReleaseBytes: released.heapUsed, rssAfterReleaseBytes: released.rss,
    heapDeltaPeakBytes: (probeResult.heapPeakBytes ?? before.heapUsed) - before.heapUsed,
    heapDeltaAfterReleaseBytes: released.heapUsed - before.heapUsed,
    shallowArrayBytes: report.managerLoad.entryCount * 8,
    memoryControl: {
      durationMs: wallMs,
      heapPeakBytes: control.heapPeakBytes,
      heapDeltaPeakBytes: (control.heapPeakBytes ?? released.heapUsed) - released.heapUsed,
      note: "same probe load, same duration, zero ledger work: the V8 peak-growth noise floor after a post-load compaction",
    },
    getEntriesCalls: diag.hostCalls.getEntries, getEntryCalls: diag.hostCalls.getEntry,
  };
  globalThis.__ledger = ledger;
}

const ledger = globalThis.__ledger;

// Structural rebuilds: tree navigation and compaction both re-baseline everything.
for (const reason of ["tree", "compact"]) {
  const probe = new LoopProbe();
  probe.start();
  const t0 = nowMs(); const c0 = cpuNow();
  ledger.onStructural(reason);
  await quiet(ledger);
  const wallMs = nowMs() - t0; const cpuMs = cpuNow() - c0;
  const probeResult = probe.stop();
  assertTotals(ledger, oracle, `rebuild ${reason} ${size}/${shape}`);
  const diag = ledger.inspect();
  report[`rebuild_${reason}`] = { wallMs, cpuMs, lastBaselineMs: diag.lastBaselineMs, maxSliceMs: diag.maxChunkMs, probe: probeResult };
}

// Steady-state increments: 1 / 32 / 2048 added records per reconciliation.
report.steady = {};
{
  let seedBase = 0;
  let running = addedTotals(oracle, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usageRecords: 0, examined: 0 });
  for (const K of [1, 32, 2048]) {
    const getEntriesBefore = ledger.inspect().hostCalls.getEntries;
    const appendStart = nowMs();
    appendK(manager, ledger, K, seedBase);
    const appendMs = nowMs() - appendStart;
    const probe = new LoopProbe();
    probe.start();
    const t0 = nowMs(); const c0 = cpuNow();
    ledger.requestVerify();
    await quiet(ledger);
    const wallMs = nowMs() - t0; const cpuMs = cpuNow() - c0;
    const probeResult = probe.stop();
    running = addedTotals(running, oracleForAppends(K, seedBase));
    assertTotals(ledger, running, `steady +${K} ${size}/${shape}`);
    const diag = ledger.inspect();
    assert.equal(diag.hostCalls.getEntries, getEntriesBefore, `steady +${K}: getEntries must stay at 0 calls`);
    report.steady[`plus_${K}`] = { appendMs, wallMs, cpuMs, verifyPause: probeResult, maxIncrementMs: diag.maxIncrementMs };
    seedBase += K;
  }
}

// Over-cap recovery: 2049 appends exceed the walk cap; the batch is dropped and one
// recovery rebuild covers the gap.
{
  const K = 2049;
  const getEntriesBefore = ledger.inspect().hostCalls.getEntries;
  const recoveriesBefore = ledger.inspect().recoveryRebuilds;
  appendK(manager, ledger, K, 90_000);
  const probe = new LoopProbe();
  probe.start();
  const t0 = nowMs(); const c0 = cpuNow();
  ledger.requestVerify();
  await quiet(ledger);
  const wallMs = nowMs() - t0; const cpuMs = cpuNow() - c0;
  const probeResult = probe.stop();
  const running = addedTotals(addedTotals(oracle, oracleForAppends(1 + 32 + 2048, 0)), oracleForAppends(K, 90_000));
  assertTotals(ledger, running, `over-cap ${size}/${shape}`);
  const diag = ledger.inspect();
  assert.equal(diag.hostCalls.getEntries, getEntriesBefore + 1, "the recovery rebuild adds exactly one getEntries");
  assert.ok(diag.recoveryRebuilds > recoveriesBefore, "the over-cap walk scheduled a recovery rebuild");
  assert.equal(diag.failureReason, null, "the recovered full read clears the failure");
  report.overCap = { wallMs, cpuMs, probe: probeResult, lastBaselineMs: diag.lastBaselineMs, maxSliceMs: diag.maxChunkMs };
}

// Catch-up during slicing: appends that land while a rebuild is still slicing must be
// folded in by the baseline's bounded catch-up walk, never double counted.
{
  const getEntriesBefore = ledger.inspect().hostCalls.getEntries;
  ledger.onStructural("tree");
  await sleep0(); // capture + first slice
  const busy = ledger.busy();
  const K = 100;
  appendK(manager, null, K, 120_000);
  ledger.requestVerify(); // swallowed by the running baseline
  const probe = new LoopProbe();
  probe.start();
  const t0 = nowMs(); const c0 = cpuNow();
  await quiet(ledger);
  const wallMs = nowMs() - t0; const cpuMs = cpuNow() - c0;
  const probeResult = probe.stop();
  const running = addedTotals(
    addedTotals(addedTotals(oracle, oracleForAppends(1 + 32 + 2048, 0)), oracleForAppends(2049, 90_000)),
    oracleForAppends(K, 120_000),
  );
  assertTotals(ledger, running, `catch-up ${size}/${shape}`);
  const diag = ledger.inspect();
  assert.equal(diag.hostCalls.getEntries, getEntriesBefore + 1, "the rebuild added exactly one getEntries");
  report.catchupDuringRebuild = { exercisedMidSlice: busy, wallMs, cpuMs, probe: probeResult, maxIncrementMs: diag.maxIncrementMs };
}

// Recovery-fails-again: appends that keep landing while a baseline AND its own
// recovery are slicing must not self-perpetuate (the anti-loop guard); the gap stays
// recorded and the next event boundary's anchored verify heals it. Appends are spread
// one batch per tick so they deterministically straddle both capture points on a small
// dedicated manager.
{
  const small = buildFixture(300, "linear", 0x77ee);
  const scenarioManager = SessionManager.inMemory("/tmp/pi-hud-bench-rfa");
  replayOps(scenarioManager, small);
  const scenarioOracle = oracleTotals(small.entries);
  const scenarioLedger = new SessionUsageLedger({ chunkEntries: 16 });
  scenarioLedger.restart(scenarioManager, "recovery-fail-probe");
  const appended = [];
  let sawFailure = false;
  let sawCoverageGap = false;
  for (let round = 0; round < 26; round++) {
    await sleep0(); // let capture/slices advance between batches
    appendK(scenarioManager, scenarioLedger, 240, 300_000 + round * 240);
    appended.push(240);
    scenarioLedger.requestVerify(); // event boundaries keep arriving during the churn
    const diag = scenarioLedger.inspect();
    if (diag.failureReason !== null) sawFailure = true;
    if (diag.coverageGap === true) sawCoverageGap = true;
  }
  await quiet(scenarioLedger);
  const afterChurn = scenarioLedger.inspect();
  // The guard: a bounded number of recoveries across the whole churn, and a quiet
  // ledger afterwards (no idle retry loop).
  const guardHeld = afterChurn.recoveryRebuilds <= 4;
  // The next event boundary heals any residual gap without a timer.
  scenarioLedger.requestVerify();
  await quiet(scenarioLedger);
  const healed = scenarioLedger.inspect();
  const healedView = scenarioLedger.view();
  let runningOracle = scenarioOracle;
  for (let round = 0; round < appended.length; round++) {
    runningOracle = addedTotals(runningOracle, oracleForAppends(appended[round], 300_000 + round * 240));
  }
  assert.equal(healedView.input, runningOracle.input, "recovery-fail-again healed input");
  assert.equal(healedView.output, runningOracle.output, "recovery-fail-again healed output");
  assert.ok(Math.abs(healedView.cost - runningOracle.cost) < 1e-6, "recovery-fail-again healed cost");
  assert.equal(healed.failureReason, null, "the healing verify clears the failure");
  assert.equal(healed.coverageGap, false, "the healing verify clears the coverage gap");
  assert.equal(scenarioLedger.busy(), false, "no idle retry loop after healing");
  report.recoveryFailsAgain = {
    sawFailureDuringChurn: sawFailure,
    sawCoverageGapDuringChurn: sawCoverageGap,
    guardHeld,
    recoveryRebuilds: afterChurn.recoveryRebuilds,
    healedByNextEventBoundary: healed.failureReason === null && healed.coverageGap === false,
    totalAppendedDuringChurn: appended.reduce((total, count) => total + count, 0),
    note: "appends straddling a baseline and its own recovery stop at the anti-loop guard; no timer retries; the next anchored verify commits every missing segment exactly once",
  };
  scenarioLedger.dispose();
}

// Fast session switch: restarting onto a second manager mid-baseline must cancel the
// in-flight work synchronously and the stale generation must never publish.
{
  const small = buildFixture(500, "linear", 0x5eed2);
  const second = SessionManager.inMemory("/tmp/pi-hud-bench-second");
  replayOps(second, small);
  const secondOracle = oracleTotals(small.entries);
  ledger.restart(manager, "switch-away"); // starts a fresh baseline
  await sleep0();
  const busy = ledger.busy();
  const t0 = nowMs();
  ledger.restart(second, "fast-switch"); // cancel + rebuild onto the new session
  const syncRestartMs = nowMs() - t0;
  const probe = new LoopProbe();
  probe.start();
  const switchStart = nowMs(); const c0 = cpuNow();
  await quiet(ledger);
  const wallMs = nowMs() - switchStart; const cpuMs = cpuNow() - c0;
  const probeResult = probe.stop();
  assertTotals(ledger, secondOracle, `fast-switch ${size}/${shape}`);
  const diag = ledger.inspect();
  report.fastSwitch = {
    cancelledBusyBaseline: busy, syncRestartMs, wallMs, cpuMs, probe: probeResult,
    lastBaselineMs: diag.lastBaselineMs,
    note: "syncRestartMs is the synchronous cancel+replan cost of the second restart; the stale generation never publishes",
  };
  ledger.dispose();
}

report.finishedAt = new Date().toISOString();
const destination = argument("json");
const output = JSON.stringify(report, null, 2) + "\n";
if (destination) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(destination, output);
}
console.log(output);
