/**
 * Tree-agnostic phase-2 performance probe. It imports `../src` and `../tests/helpers.mjs`
 * relative to its own location, so the exact same file can be copied into a pre-change
 * worktree and measured there. Render fixtures are plain snapshot objects shared by both
 * trees; a pre-change renderer simply ignores the phase-2 fields it does not know.
 *
 * Usage: node scripts/perf-ab.mjs --label=before|after [--json=path]
 * This is a synthetic microbenchmark, not a live Pi/provider/terminal A/B.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { writeFileSync } from "node:fs";
import { controllerFixture, assistant } from "../tests/helpers.mjs";
import { HudView } from "../src/render.ts";
import { normalizeConfig } from "../src/config.ts";

const argument = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const label = argument("label") ?? "unknown";
const destination = argument("json");

function sample(callback, count = 12_000) {
  for (let i = 0; i < 2_000; i++) callback(i);
  const times = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const start = performance.now(); callback(i); times[i] = (performance.now() - start) * 1_000;
  }
  times.sort();
  return {
    samples: count,
    meanUs: times.reduce((a, b) => a + b, 0) / count,
    p50Us: times[Math.floor(count * 0.50)], p95Us: times[Math.floor(count * 0.95)], p99Us: times[Math.floor(count * 0.99)],
  };
}

// Observer hooks: identical event streams on both trees.
const host = controllerFixture();
host.clock.advance(0);
const messages = Array.from({ length: 1_024 }, () => ({ message: assistant() }));
const tools = Array.from({ length: 1_024 }, (_, index) => ({ toolCallId: `call-${index}`, toolName: "read", args: { path: "/example/src/main.ts" } }));
const hooks = {
  messageEnd: sample((index) => host.emit("message_end", messages[index % messages.length])),
  toolPair: sample((index) => {
    const event = tools[index % tools.length];
    host.emit("tool_execution_start", event);
    host.emit("tool_execution_end", event);
  }),
};

// One shared fixture: the pre-change renderer reads the phase-1 fields, the phase-2
// renderer additionally reads the bounded category ledger.
const categoryNames = ["bash", "edit", "write", "read", "ls", "find", "grep", "glob", "webfetch", "todo", "task", "subagent", "mcp", "notebook", "patch", "diff"];
const toolCategories = categoryNames.map((name, index) => ({
  name, ok: 20 - index, error: index % 4 === 0 ? 1 : 0, interrupted: index % 6 === 0 ? 1 : 0,
}));
toolCategories.push({ name: "other", ok: 5, error: 1, interrupted: 1, merged: true });
const fixture = (overrides = {}) => ({
  project: "pi-hud", model: "Benchmark Model", thinking: "high",
  contextWindow: 200_000, contextTokens: 90_000, phase: "tools",
  activeTools: ["edit /workspace/pi-hud/src/render.ts", "bash", "read /workspace/pi-hud/README.md"],
  activeCount: 3, done: 60, errors: 7, interrupted: 3, dropped: 0,
  input: 87_000, output: 3_000, cacheRead: 355_000, cacheWrite: 0, cacheHit: 355_000 / 442_000,
  cost: 0.042, usageReports: 1, costReports: 1, compactions: 0,
  lastTool: "edit render.ts",
  runningAgents: 1, agentErrors: 0, agentLabel: "Review implementation",
  taskTotal: 7, taskDone: 3, taskLabel: "Build Pi HUD", taskSources: 1,
  toolCategories,
  git: { available: true, branch: "main", dirty: true },
  ...overrides,
});
const baseline = fixture({ toolCategories: [] });
const saturated = fixture();

const measure = (snapshot, config, width, count = 3_000) => {
  const view = new HudView({ requestRender() {} }, null, snapshot, normalizeConfig(config));
  view.render(width);
  const result = sample(() => { view.invalidate(); view.render(width); }, count);
  view.dispose();
  return result;
};
const renders = {
  baselineFull120: measure(baseline, { preset: "full" }, 120),
  saturatedFull120: measure(saturated, { preset: "full" }, 120),
  saturatedFull180: measure(saturated, { preset: "full" }, 180),
  saturatedMono120: measure(saturated, { preset: "full", color: false }, 120),
  concurrentBalanced120: measure(fixture({ activeTools: ["bash", "edit /workspace/pi-hud/src/render.ts", "read /workspace/pi-hud/README.md"], activeCount: 4 }), { preset: "balanced" }, 120),
  concurrentBalanced40: measure(saturated, { preset: "balanced" }, 40),
  emptyIdle120: measure(fixture({ activeTools: [], activeCount: 0, phase: "idle", toolCategories: [], done: 0, errors: 0, interrupted: 0, usageReports: 0, costReports: 0, cost: 0, taskSources: 0, taskTotal: 0, taskDone: 0, runningAgents: 0 }), { preset: "full" }, 120),
};

// ---------------------------------------------------------------------------
// Phase-3 footer surface and bounded status comparison.
// The pre-change tree has no `src/footer.ts`, so the module is imported dynamically and the
// footer scenarios are reported as unavailable there instead of failing the probe.
// ---------------------------------------------------------------------------
let footerModule = null;
try { footerModule = await import("../src/footer.ts"); } catch { footerModule = null; }
const footer = footerModule ? (() => {
  const identity = { cwd: "~/opensource/pi-hud", provider: "bench", title: "Compare HUDs", branch: "main", branchDirty: true };
  const statuses = new Map();
  for (let index = 0; index < 12; index++) statuses.set(`ext-${index}`, `status text number ${index} with a bounded tail`);
  const data = { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => statuses };
  const emptyData = { ...data, getExtensionStatuses: () => new Map() };
  const make = (snapshot, preset, width, footerData = data) => {
    const instance = new footerModule.HudFooterView({ requestRender() {} }, null, footerData, snapshot, normalizeConfig({ preset }), identity, () => {});
    instance.render(width);
    return instance;
  };
  const full = make(saturated, "full", 120);
  const balanced = make(saturated, "balanced", 120);
  const narrow = make(saturated, "balanced", 40);
  const noStatus = make(saturated, "full", 120, emptyData);
  const renders = {
    footerFull120: sample(() => { full.invalidate(); full.render(120); }, 3_000),
    footerBalanced120: sample(() => { balanced.invalidate(); balanced.render(120); }, 3_000),
    footerNarrow40: sample(() => { narrow.invalidate(); narrow.render(40); }, 3_000),
    footerNoStatus120: sample(() => { noStatus.invalidate(); noStatus.render(120); }, 3_000),
  };
  const cached = full.render(120);
  let hits = 0;
  const frames = 1_000_000;
  const started = performance.now();
  for (let index = 0; index < frames; index++) if (full.render(120) === cached) hits++;
  const cachedRender = { frames, identicalCacheHits: hits, statusChecks: full.statusChecks, statusChanges: full.statusChanges, meanUs: (performance.now() - started) * 1_000 / frames };
  full.dispose(); balanced.dispose(); narrow.dispose(); noStatus.dispose();
  return {
    bodyRows: {
      minimal: footerModule.formatFooter(saturated, normalizeConfig({ preset: "minimal" }), 120, identity).length,
      balanced: footerModule.formatFooter(saturated, normalizeConfig({ preset: "balanced" }), 120, identity).length,
      full: footerModule.formatFooter(saturated, normalizeConfig({ preset: "full" }), 120, identity).length,
    },
    renders, cachedRender,
  };
})() : null;

const cachedView = new HudView({ requestRender() {} }, null, saturated, normalizeConfig({ preset: "full" }));
const cached = cachedView.render(120);
let cacheHits = 0;
const cachedFrames = 1_000_000;
const cachedStart = performance.now();
for (let i = 0; i < cachedFrames; i++) if (cachedView.render(120) === cached) cacheHits++;
const cachedRenderMeanUs = (performance.now() - cachedStart) * 1_000 / cachedFrames;
assert.equal(cacheHits, cachedFrames);
cachedView.dispose();

host.emit("session_shutdown");
const report = {
  label,
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown" },
  methodology: "Synthetic same-tree microbenchmarks. Shared fixtures; the pre-change tree ignores the phase-2 snapshot fields. Timing includes performance.now overhead; the cached mean uses a bulk loop. NOT a live Pi/provider/terminal A/B.",
  hooks, renders, footer,
  cachedRender: { frames: cachedFrames, identicalCacheHits: cacheHits, meanUs: cachedRenderMeanUs },
};
if (destination) writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
