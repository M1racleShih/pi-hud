/**
 * B2b usage-scope A/B probe: identical fixtures and event streams, one configuration
 * flag different (`usageScope: observed` vs `session`). Measured in separate processes
 * by `usage-ab-run.mjs`, alternating order across >= 8 pairs on the same machine.
 *
 * Scenarios:
 *   hooks.messageEnd   - the message_end observer cost (session mode also marks the
 *                        ledger pending; observed mode does not touch any ledger)
 *   hooks.toolPair     - tool start+end pair (identical code both modes; control)
 *   hooks.turnEndBare  - turn_end + full fake-clock drain with nothing appended
 *                        (the idle verify path: cursor==leaf, nothing to commit)
 *   ledgerVerify       - append 1 record + message_end + turn_end + advance(0): the
 *                        zero-delay ledger reconciliation only
 *   fullTurn           - the same turn drained through the 250ms coalesced publication
 *                        (advance(250)); the run fails unless one publication per turn
 *   renders            - uncached widget/footer renders with (session) and without
 *                        (observed) the sess* usage row; cached widget render
 *
 * This is a synthetic microbenchmark against the repo modules with a fake host clock;
 * the pinned-SDK history numbers are in usage-ledger-bench-run.mjs's record.
 * NOT a live Pi/provider/terminal A/B.
 */
import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { controllerFixture, assistant } from "../tests/helpers.mjs";
import { HudView } from "../src/render.ts";
import { HudFooterView } from "../src/footer.ts";
import { normalizeConfig } from "../src/config.ts";
import { buildFixture } from "./usage-fixtures.mjs";

const argument = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const label = argument("label") ?? "unknown";
const scope = label === "session" ? "session" : "observed";

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

// ---------------------------------------------------------------------------
// Controller-level scenarios: the same fixture host, only usageScope differs.
// ---------------------------------------------------------------------------
const HISTORY = 2_000;
const messages = Array.from({ length: 1_024 }, () => ({ message: assistant() }));
const tools = Array.from({ length: 1_024 }, (_, index) => ({ toolCallId: `call-${index}`, toolName: "read", args: { path: "/example/src/main.ts" } }));

// A fake session manager preloaded with the fixture history (same append semantics as
// tests/helpers.mjs's FakeSessionManager).
import { FakeSessionManager } from "../tests/helpers.mjs";
const preload = (count) => {
  const fixture = buildFixture(count, "linear", 0x0b2b_5eed);
  const manager = new FakeSessionManager("bench-session");
  for (const entry of fixture.entries) manager.append({ type: entry.type, message: entry.message, summary: entry.summary, usage: entry.usage, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore });
  return { manager, entries: fixture.entries };
};

const { manager } = preload(HISTORY);
const host = controllerFixture({ usageScope: scope, usageManager: manager, config: { usageScope: scope } });
host.clock.advance(0);
// Drain the session-scope baseline to quiet before measuring hooks.
let guard = 0;
while (host.controller.ledger?.busy() && guard++ < 100) host.clock.advance(0);

const hooks = {
  messageEnd: sample((index) => host.emit("message_end", messages[index % messages.length])),
  toolPair: sample((index) => {
    const event = tools[index % tools.length];
    host.emit("tool_execution_start", event);
    host.emit("tool_execution_end", event);
  }),
  turnEndBare: sample((index) => {
    host.emit("turn_end", {}, host.ctx);
    host.clock.advance(0);
    void index;
  }),
};

// Full-turn scenarios, measured separately per the B2b review:
//   ledgerVerify - append + message_end + turn_end + advance(0): the zero-delay
//                  ledger reconciliation only (a bare advance(0) never fires the
//                  coalescer's 250ms publication - verified by a 100-turn repro:
//                  0 flushes, one pending job at t=250).
//   fullTurn     - the same turn drained through the 250ms coalesced publication
//                  (advance(250) fires the flush; the run asserts exactly one flush
//                  per sample and a non-empty pending-publication count afterwards).
const appendedMessage = {
  role: "assistant", model: "m", provider: "p", stopReason: "stop",
  content: [{ type: "text", text: "turn text" }],
  usage: { input: 1200, output: 90, cacheRead: 4_000, cacheWrite: 40, totalTokens: 5330, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
};
let turnIndex = 0;
const oneTurn = (drainMs) => {
  manager.appendMessage({ ...appendedMessage, timestamp: turnIndex });
  host.emit("message_end", { message: appendedMessage });
  host.emit("turn_end", {}, host.ctx);
  host.clock.advance(drainMs);
  turnIndex++;
};
const ledgerVerify = sample(() => oneTurn(0), 12_000);
const flushesBeforeFullTurn = host.controller.flushes;
const fullTurn = sample(() => oneTurn(250), 3_000);
const fullTurnFlushes = host.controller.flushes - flushesBeforeFullTurn;
// sample() runs 2_000 warmups + 3_000 observations; every one of them must have
// drained exactly one coalesced publication, or the metric is not measuring it.
const FULL_TURN_TURNS = 2_000 + 3_000;
if (fullTurnFlushes !== FULL_TURN_TURNS) {
  throw new Error(`fullTurn drained only ${fullTurnFlushes} publications for ${FULL_TURN_TURNS} turns; the coalesced publication is not being measured`);
}

// ---------------------------------------------------------------------------
// Render scenarios: the snapshot differs exactly by the attached session view.
// ---------------------------------------------------------------------------
const categoryNames = ["bash", "edit", "write", "read", "ls", "find", "grep", "glob", "webfetch", "todo", "task", "subagent", "mcp", "notebook", "patch", "diff"];
const toolCategories = categoryNames.map((name, index) => ({ name, ok: 20 - index, error: index % 4 === 0 ? 1 : 0, interrupted: index % 6 === 0 ? 1 : 0 }));
toolCategories.push({ name: "other", ok: 5, error: 1, interrupted: 1, merged: true });
const sessionUsageView = scope === "session"
  ? {
      status: "ready", updating: false,
      input: 1_234_567_890, output: 234_567_890, cacheRead: 9_876_543_210, cacheWrite: 123_456_789,
      cost: 87.6543, costKnown: true, costMissing: false, usageRecords: 42_000, examined: 100_000,
      missingInput: 0, missingOutput: 3, missingCacheRead: 0, missingCacheWrite: 0,
      assistantMissingUsage: 1, summaryMissingUsage: 2, limited: false, fieldsIncomplete: true,
    }
  : null;
const baseSnapshot = (overrides = {}) => ({
  project: "pi-hud", model: "Benchmark Model", thinking: "high",
  contextWindow: 200_000, contextTokens: 90_000, phase: "tools",
  activeTools: ["edit /workspace/pi-hud/src/render.ts", "bash", "read /workspace/pi-hud/README.md"],
  activeCount: 3, done: 60, errors: 7, interrupted: 3, dropped: 0,
  input: 87_000, output: 3_000, cacheRead: 355_000, cacheWrite: 0, cacheHit: 355_000 / 442_000,
  cost: 0.042, usageReports: 1, costReports: 1, compactions: 0,
  lastTool: "edit render.ts", runningAgents: 1, agentErrors: 0, agentLabel: "Review implementation",
  taskTotal: 7, taskDone: 3, taskLabel: "Build Pi HUD", taskSources: 1,
  toolCategories, sessionUsage: sessionUsageView,
  git: { available: true, branch: "main", dirty: true },
  ...overrides,
});
const snapshot = baseSnapshot();

const measureWidget = () => {
  const view = new HudView({ requestRender() {} }, null, snapshot, normalizeConfig({ preset: "full", usageScope: scope }));
  view.render(120);
  const result = sample(() => { view.invalidate(); view.render(120); }, 3_000);
  view.dispose();
  return result;
};
const renders = { widgetFull120: measureWidget() };

const footerIdentity = { cwd: "~/opensource/pi-hud", provider: "bench", title: "Compare HUDs", branch: "main", branchDirty: true };
const footerData = { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() };
{
  const footer = new HudFooterView({ requestRender() {} }, null, footerData, snapshot, normalizeConfig({ preset: "full", usageScope: scope }), footerIdentity, () => {});
  footer.render(120);
  renders.footerFull120 = sample(() => { footer.invalidate(); footer.render(120); }, 3_000);
  const cached = footer.render(120);
  let hits = 0;
  const frames = 200_000;
  const started = performance.now();
  for (let index = 0; index < frames; index++) if (footer.render(120) === cached) hits++;
  renders.footerCached = { frames, identicalCacheHits: hits, meanUs: (performance.now() - started) * 1_000 / frames };
  footer.dispose();
}
{
  const view = new HudView({ requestRender() {} }, null, snapshot, normalizeConfig({ preset: "full", usageScope: scope }));
  view.render(120);
  const cached = view.render(120);
  let hits = 0;
  const frames = 200_000;
  const started = performance.now();
  for (let index = 0; index < frames; index++) if (view.render(120) === cached) hits++;
  renders.widgetCached = { frames, identicalCacheHits: hits, meanUs: (performance.now() - started) * 1_000 / frames };
  view.dispose();
}

// Structural evidence, collected while the controller and ledger are still live
// (the review found the old script inspected a disposed ledger, yielding zeros).
const structuralDiagnostics = (() => {
  const ledgerDiag = host.controller.ledger?.inspect();
  return {
    ledgerQuiet: !host.controller.ledger?.busy(),
    ledgerStatus: ledgerDiag?.status ?? "absent",
    ledgerPublishedEntries: ledgerDiag?.publishedEntries ?? 0,
    steadyGetEntriesCalls: ledgerDiag?.hostCalls.getEntries ?? 0,
    steadyGetEntryCalls: ledgerDiag?.hostCalls.getEntry ?? 0,
    controllerFlushes: host.controller.flushes,
    controllerPaints: host.calls.paint,
    controllerCallbackErrors: host.controller.callbackErrors,
    pendingClockJobs: [...host.clock.jobs.values()].filter((job) => job.at > host.clock.time).length,
  };
})();

host.emit("session_shutdown");
const report = {
  label, scope,
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown" },
  historyEntries: HISTORY,
  methodology: "Same tree, same fixtures, one flag different (usageScope). Separate processes; the runner alternates order across pairs. ledgerVerify drains only the zero-delay reconciliation (advance(0)); fullTurn additionally drains the 250ms coalesced publication (advance(250)) and the run fails unless exactly one publication fired per turn. The pinned-SDK history numbers live in the ledger benchmark. Synthetic microbenchmark, not a live host A/B.",
  hooks, ledgerVerify, fullTurn, fullTurnFlushes, renders,
  // Collected BEFORE session_shutdown (the review found the old script inspected a
  // disposed ledger, yielding trivial zeros).
  structural: structuralDiagnostics,
};
const destination = argument("json");
if (destination) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report));
