/**
 * B2b long-history ledger benchmark driver: runs every (size, shape) combination in its
 * own --expose-gc child process (clean memory attribution per cell) and collects the raw
 * records into one JSON document with the full environment provenance.
 *
 *   node scripts/usage-ledger-bench-run.mjs --json=docs/performance-b2b-ledger.json
 *
 * Requires the isolated pinned SDK install under .tmp/sdk (see DEVELOPMENT.md).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cpus, platform, arch, totalmem } from "node:os";

const argument = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const destination = argument("json") ?? "docs/performance-b2b-ledger.json";
const sizes = (argument("sizes") ?? "1000,10000,100000").split(",").map(Number);
const shapes = (argument("shapes") ?? "linear,branched").split(",");

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

const cells = [];
for (const size of sizes) {
  for (const shape of shapes) {
    const result = spawnSync(process.execPath, ["--expose-gc", "scripts/usage-ledger-bench.mjs", `--size=${size}`, `--shape=${shape}`], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `bench failed for ${size}/${shape}: ${result.stderr || result.stdout}`);
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1) === "}" ? result.stdout.slice(result.stdout.indexOf("{")) : result.stdout);
    cells.push(report);
    const attach = report.attach;
    console.error(`${size}/${shape}: attach wall=${attach.wallMs.toFixed(1)}ms netCpu=${attach.netCpuMs.toFixed(1)}ms maxSlice=${attach.maxSliceMs.toFixed(2)}ms maxPause=${attach.probe.maxGapMs.toFixed(2)}ms heapPeakDelta=${(attach.heapDeltaPeakBytes / 1_048_576).toFixed(1)}MiB`);
  }
}

const record = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version, platform: platform(), arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, totalMemBytes: totalmem(),
    sdkLockSha256: lockHash,
    commit: git(["rev-parse", "HEAD"]),
    dirtyFilesSha256: dirtyFiles,
  },
  methodology: [
    "One child process per (size, shape) with --expose-gc so per-cell heap attribution is not polluted by earlier cells.",
    "Real pinned Pi 1.0.2 SessionManager (inMemory) loaded from the same seeded op stream the plain fixture derives from; fixture build, manager load and HUD attach are timed separately.",
    "External pause probe: a setImmediate loop measures the gap between iterations (approximates the longest uninterruptible pause including GC); the same probe over an idle window is reported as its noise floor. It also samples heapUsed/rss every 32 iterations.",
    "CPU deltas include the probe; attach.netCpuMs subtracts the measured idle probe rate. Wall times include yield waits by design (the contract distinguishes yield-inclusive total time from the max pause).",
    "Every phase asserts the published totals against the independent fixture oracle before its timing is recorded; steady-state phases additionally assert zero new getEntries calls.",
    "getEntries copy timings are five standalone samples over the fully loaded manager (median/max reported).",
  ].join(" "),
  gates: "hook p99 <= 250us, uncached render p99 <= 5ms, cached render mean <= 5us are unchanged and measured separately in bench/run.mjs; this record covers ledger history work only.",
  fixture: cells[0]?.fixtureMeta?.ratios ? { seed: 0x0b2b5eed, ratios: cells[0].fixtureMeta.ratios, contentChars: 220, summaryChars: 400 } : null,
  cells,
};
writeFileSync(destination, JSON.stringify(record, null, 2) + "\n");
console.error(`wrote ${destination} (${cells.length} cells)`);
