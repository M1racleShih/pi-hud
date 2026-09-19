import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { writeFileSync } from "node:fs";
import { controllerFixture, assistant, MODEL } from "../tests/helpers.mjs";
import { HudState } from "../src/state.ts";
import { HudView } from "../src/render.ts";
import { HudFooterView, formatFooter } from "../src/footer.ts";
import { normalizeConfig } from "../src/config.ts";

const GATES = Object.freeze({ hookP99Us: 250, uncachedRenderP99Us: 5_000, cachedRenderMeanUs: 5, cachedFooterRenderMeanUs: 5 });
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

const f = controllerFixture();
f.clock.advance(0);
const messages = Array.from({ length: 1_024 }, () => ({ message: assistant() }));
const tools = Array.from({ length: 1_024 }, (_, i) => ({ toolCallId: `call-${i}`, toolName: "read", args: { path: "/example/src/main.ts" } }));
const hooks = {
  messageEnd: sample((i) => f.emit("message_end", messages[i % messages.length])),
  toolPair: sample((i) => {
    const event = tools[i % tools.length]; f.emit("tool_execution_start", event); f.emit("tool_execution_end", event);
  }),
};

const state = new HudState("/example/中文项目", { ...MODEL, name: "Benchmark Model 👩‍💻" });
state.messageEnd(assistant(), 1);
state.startTool({ toolCallId: "one", toolName: "read", args: { path: "/example/中文文件.ts" } });
state.bridge({ version: 1, source: "bench", kind: "agent", id: "a", status: "running", label: "Review implementation" }, 0);
state.bridge({ version: 1, source: "bench", kind: "tasks", id: "t", completed: 3, total: 7, label: "Build HUD" }, 0);
const view = new HudView({ requestRender() {} }, null, state.snapshot(), normalizeConfig({ preset: "full" }));
view.render(120);
const uncachedRender = sample(() => { view.invalidate(); view.render(120); }, 3_000);
const monoView = new HudView({ requestRender() {} }, null, state.snapshot(), normalizeConfig({ preset: "full", color: false }));
monoView.render(120);
const uncachedRenderMono = sample(() => { monoView.invalidate(); monoView.render(120); }, 3_000);
const narrowView = new HudView({ requestRender() {} }, null, state.snapshot(), normalizeConfig({ preset: "balanced" }));
narrowView.render(40);
const uncachedRenderNarrow = sample(() => { narrowView.invalidate(); narrowView.render(40); }, 3_000);

// Phase-2 scenario: the category ledger at its 16-name cap plus `other`, three concurrent
// tools, an interrupted run, with bridge data attached.
const saturated = new HudState("/example/中文项目", { ...MODEL, name: "Benchmark Model 👩‍💻" });
saturated.messageEnd(assistant(), 1);
for (let i = 0; i < 24; i++) {
  saturated.startTool({ toolCallId: `cat-${i}`, toolName: `tool-${i}`, args: { path: "/example/src/main.ts" } });
  saturated.endTool({ toolCallId: `cat-${i}`, toolName: `tool-${i}`, isError: i % 5 === 0 });
}
saturated.startTool({ toolCallId: "stopped", toolName: "bash" });
saturated.settle();
for (const [index, name] of ["bash", "edit", "write"].entries()) {
  saturated.startTool({ toolCallId: `active-${index}`, toolName: name, args: { path: "/example/src/main.ts" } });
}
saturated.bridge({ version: 1, source: "bench", kind: "agent", id: "a", status: "running", label: "Review implementation" }, 0);
saturated.bridge({ version: 1, source: "bench", kind: "tasks", id: "t", completed: 3, total: 7, label: "Build HUD" }, 0);
const saturatedSnapshot = saturated.snapshot();
const saturatedView = new HudView({ requestRender() {} }, null, saturatedSnapshot, normalizeConfig({ preset: "full" }));
saturatedView.render(120);
const uncachedRenderSaturated = sample(() => { saturatedView.invalidate(); saturatedView.render(120); }, 3_000);
const saturatedWideView = new HudView({ requestRender() {} }, null, saturatedSnapshot, normalizeConfig({ preset: "full" }));
saturatedWideView.render(180);
const uncachedRenderSaturatedWide = sample(() => { saturatedWideView.invalidate(); saturatedWideView.render(180); }, 3_000);

// Phase-2 scenario: concurrent running tools with recent failures and an interruption.
const concurrent = new HudState("/example/中文项目", { ...MODEL, name: "Benchmark Model 👩‍💻" });
concurrent.messageEnd(assistant(), 1);
for (const [index, name] of ["bash", "edit", "read"].entries()) {
  concurrent.startTool({ toolCallId: `run-${index}`, toolName: name, args: { path: "/example/src/main.ts" } });
}
concurrent.startTool({ toolCallId: "failed", toolName: "bash" });
concurrent.endTool({ toolCallId: "failed", toolName: "bash", isError: true });
concurrent.startTool({ toolCallId: "stopped", toolName: "write" });
concurrent.settle();
for (const [index, name] of ["bash", "edit", "read"].entries()) {
  concurrent.startTool({ toolCallId: `live-${index}`, toolName: name, args: { path: "/example/src/main.ts" } });
}
const concurrentView = new HudView({ requestRender() {} }, null, concurrent.snapshot(), normalizeConfig({ preset: "balanced" }));
concurrentView.render(120);
const uncachedRenderConcurrent = sample(() => { concurrentView.invalidate(); concurrentView.render(120); }, 3_000);
const concurrentNarrowView = new HudView({ requestRender() {} }, null, concurrent.snapshot(), normalizeConfig({ preset: "balanced" }));
concurrentNarrowView.render(40);
const uncachedRenderConcurrentNarrow = sample(() => { concurrentNarrowView.invalidate(); concurrentNarrowView.render(40); }, 3_000);
// ---------------------------------------------------------------------------
// Phase 3: footer surface and bounded status comparison
// ---------------------------------------------------------------------------
const FOOTER_IDENTITY = Object.freeze({ cwd: "~/opensource/pi-hud", provider: "bench", title: "Compare HUDs", branch: "main", branchDirty: true });
const footerStatuses = new Map();
for (let index = 0; index < 12; index++) footerStatuses.set(`ext-${index}`, `status text number ${index} with a bounded tail`);
const footerData = {
  getGitBranch: () => "main",
  onBranchChange: () => () => {},
  getExtensionStatuses: () => footerStatuses,
};
const footerView = (snapshot, preset, width, data = footerData) => {
  const instance = new HudFooterView({ requestRender() {} }, null, data, snapshot, normalizeConfig({ preset }), FOOTER_IDENTITY, () => {});
  instance.render(width);
  return instance;
};
const footerFull = footerView(saturatedSnapshot, "full", 120);
const uncachedFooterFull = sample(() => { footerFull.invalidate(); footerFull.render(120); }, 3_000);
const footerBalanced = footerView(saturatedSnapshot, "balanced", 120);
const uncachedFooterBalanced = sample(() => { footerBalanced.invalidate(); footerBalanced.render(120); }, 3_000);
const footerNarrow = footerView(saturatedSnapshot, "balanced", 40);
const uncachedFooterNarrow = sample(() => { footerNarrow.invalidate(); footerNarrow.render(40); }, 3_000);
const footerNoStatus = footerView(saturatedSnapshot, "full", 120, { ...footerData, getExtensionStatuses: () => new Map() });
const uncachedFooterNoStatus = sample(() => { footerNoStatus.invalidate(); footerNoStatus.render(120); }, 3_000);
// The status comparison runs on every host-invoked render, including cached frames, so its
// cost is measured on the hot cached path with 12 statuses attached.
const footerStatusCompare = footerView(saturatedSnapshot, "full", 120);
const cachedFooterLines = footerStatusCompare.render(120);
let footerCacheHits = 0;
const footerFrames = 1_000_000;
const footerStatusStart = performance.now();
for (let index = 0; index < footerFrames; index++) if (footerStatusCompare.render(120) === cachedFooterLines) footerCacheHits++;
const cachedFooterRenderMeanUs = (performance.now() - footerStatusStart) * 1_000 / footerFrames;
assert.equal(footerCacheHits, footerFrames, "an unchanged footer frame reuses the same array");
assert.equal(footerStatusCompare.statusChanges, 1, "the bounded comparison detects the initial statuses once");
assert.equal(footerStatusCompare.statusChecks, footerFrames + 2, "every host render runs the bounded comparison");

const cached = view.render(120);
let cacheHits = 0;
const cachedFrames = 1_000_000;
const cachedStart = performance.now();
for (let i = 0; i < cachedFrames; i++) if (view.render(120) === cached) cacheHits++;
const cachedRenderMeanUs = (performance.now() - cachedStart) * 1_000 / cachedFrames;
assert.equal(cacheHits, cachedFrames);

const flood = controllerFixture();
for (let i = 0; i < 50_000; i++) {
  flood.emit("tool_execution_start", { toolCallId: `${i}`, toolName: "read" });
  flood.emit("tool_execution_end", { toolCallId: `${i}`, toolName: "read" });
}
assert.equal(flood.clock.jobs.size, 1);
flood.clock.advance(0);
assert.equal(flood.controller.flushes, 1);
const beforeIdle = flood.controller.flushes;
flood.clock.advance(60_000);
assert.equal(flood.controller.flushes, beforeIdle);

// Phase-2 structural bound: distinct tool names can never grow the retained category ledger.
const categoryFlood = controllerFixture();
for (let i = 0; i < 50_000; i++) {
  categoryFlood.emit("tool_execution_start", { toolCallId: `f${i}`, toolName: `tool-${i}` });
  categoryFlood.emit("tool_execution_end", { toolCallId: `f${i}`, toolName: `tool-${i}` });
}
assert.equal(categoryFlood.clock.jobs.size, 1);
assert.equal(categoryFlood.controller.state.toolStats.size, 16);
assert.equal(categoryFlood.controller.state.overflowStats.ok, 50_000 - 16);
assert.equal(categoryFlood.controller.state.tools.size, 0);

const report = {
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown" },
  methodology: "Local synthetic microbenchmarks, NOT a live Pi/provider/terminal A/B. Timing includes performance.now overhead; cached mean uses a bulk loop. No history traversal or I/O is included in observer hooks. toolPair measures start + end together.",
  hooks, uncachedRender,
  uncachedRenderMono, uncachedRenderNarrow,
  uncachedRenderSaturated, uncachedRenderSaturatedWide,
  uncachedRenderConcurrent, uncachedRenderConcurrentNarrow,
  uncachedFooterFull, uncachedFooterBalanced, uncachedFooterNarrow, uncachedFooterNoStatus,
  cachedRender: { frames: cachedFrames, identicalCacheHits: cacheHits, meanUs: cachedRenderMeanUs },
  cachedFooterRender: {
    frames: footerFrames, identicalCacheHits: footerCacheHits, statusChecks: footerStatusCompare.statusChecks,
    statusChanges: footerStatusCompare.statusChanges, meanUs: cachedFooterRenderMeanUs,
  },
  footerShape: {
    bodyRows: { minimal: formatFooter(saturatedSnapshot, normalizeConfig({ preset: "minimal" }), 120, FOOTER_IDENTITY).length,
      balanced: formatFooter(saturatedSnapshot, normalizeConfig({ preset: "balanced" }), 120, FOOTER_IDENTITY).length,
      full: formatFooter(saturatedSnapshot, normalizeConfig({ preset: "full" }), 120, FOOTER_IDENTITY).length },
    statusEntries: footerStatuses.size,
    footerFullLines: footerFull.render(120).length,
    footerNarrowLines: footerNarrow.render(40).length,
  },
  structural: {
    perTokenSubscriptions: 0, runtimeDependencies: 0,
    burstToolEvents: 100_000, pendingPublicationTimers: 1, burstPublications: 1,
    idleSyntheticMs: 60_000, idleExtraPublications: flood.controller.flushes - beforeIdle,
    retainedToolsAfterBurst: flood.controller.state.tools.size,
    retainedRecentIdsAfterBurst: flood.controller.state.recentIds.size,
    distinctToolNamesInCategoryFlood: 50_000,
    retainedCategoriesAfterFlood: categoryFlood.controller.state.toolStats.size,
    retainedOverflowBucketsAfterFlood: categoryFlood.controller.state.overflowStats ? 1 : 0,
    defaultGitEnabled: false,
  },
  gates: GATES,
  passed: Math.max(hooks.messageEnd.p99Us, hooks.toolPair.p99Us) <= GATES.hookP99Us &&
    Math.max(uncachedRender.p99Us, uncachedRenderMono.p99Us, uncachedRenderNarrow.p99Us,
      uncachedRenderSaturated.p99Us, uncachedRenderSaturatedWide.p99Us,
      uncachedRenderConcurrent.p99Us, uncachedRenderConcurrentNarrow.p99Us) <= GATES.uncachedRenderP99Us &&
    cachedRenderMeanUs <= GATES.cachedRenderMeanUs &&
    cachedFooterRenderMeanUs <= GATES.cachedFooterRenderMeanUs,
};
f.emit("session_shutdown"); flood.emit("session_shutdown"); categoryFlood.emit("session_shutdown");
view.dispose(); monoView.dispose(); narrowView.dispose();
footerFull.dispose(); footerBalanced.dispose(); footerNarrow.dispose(); footerNoStatus.dispose(); footerStatusCompare.dispose();
saturatedView.dispose(); saturatedWideView.dispose(); concurrentView.dispose(); concurrentNarrowView.dispose();
const destination = process.argv.find((arg) => arg.startsWith("--json="))?.slice(7);
if (destination) writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--check") && !report.passed) process.exitCode = 1;
