import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { writeFileSync } from "node:fs";
import { controllerFixture, assistant, MODEL } from "../tests/helpers.mjs";
import { HudState } from "../src/state.ts";
import { HudView } from "../src/render.ts";
import { normalizeConfig } from "../src/config.ts";

const GATES = Object.freeze({ hookP99Us: 250, uncachedRenderP99Us: 5_000, cachedRenderMeanUs: 5 });
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

const report = {
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown" },
  methodology: "Local synthetic microbenchmarks, NOT a live Pi/provider/terminal A/B. Timing includes performance.now overhead; cached mean uses a bulk loop. No history traversal or I/O is included in observer hooks. toolPair measures start + end together.",
  hooks, uncachedRender,
  cachedRender: { frames: cachedFrames, identicalCacheHits: cacheHits, meanUs: cachedRenderMeanUs },
  structural: {
    perTokenSubscriptions: 0, runtimeDependencies: 0,
    burstToolEvents: 100_000, pendingPublicationTimers: 1, burstPublications: 1,
    idleSyntheticMs: 60_000, idleExtraPublications: flood.controller.flushes - beforeIdle,
    retainedToolsAfterBurst: flood.controller.state.tools.size,
    retainedRecentIdsAfterBurst: flood.controller.state.recentIds.size,
    defaultGitEnabled: false,
  },
  gates: GATES,
  passed: Math.max(hooks.messageEnd.p99Us, hooks.toolPair.p99Us) <= GATES.hookP99Us &&
    uncachedRender.p99Us <= GATES.uncachedRenderP99Us && cachedRenderMeanUs <= GATES.cachedRenderMeanUs,
};
f.emit("session_shutdown"); flood.emit("session_shutdown"); view.dispose();
const destination = process.argv.find((arg) => arg.startsWith("--json="))?.slice(7);
if (destination) writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--check") && !report.passed) process.exitCode = 1;
