/**
 * Phase 3 B2a correctness matrix for the optional full-session usage ledger
 * (contract: docs/SESSION-USAGE-CONTRACT.zh-CN.md).
 *
 * Aggregation results are compared against `oracleTotals`, an independent reducer written
 * against the pinned SDK footer's four-category rule - never against the ledger's own
 * reducer. Lifecycle tests drive the ledger through a one-timer-at-a-time manual clock so
 * slicing, cancellation and generation isolation are observable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SessionUsageLedger, aggregateEntry, LEDGER_LIMITS } from "../src/usage.ts";
import { OBSERVED_EVENTS, HudController } from "../src/extension.ts";
import { normalizeConfig, DEFAULT_CONFIG } from "../src/config.ts";
import { HudState } from "../src/state.ts";
import { formatHud, sessionTokensField, LABELS } from "../src/render.ts";
import { formatFooter, EMPTY_IDENTITY } from "../src/footer.ts";
import {
  FakeClock, FakeSessionManager, ManualClock, controllerFixture, fakeHost, assistant,
  usage, assistantEntry, toolResultEntry, oracleTotals, MODEL,
} from "./helpers.mjs";

// ---------------------------------------------------------------------------
// Ledger-level harness
// ---------------------------------------------------------------------------

const ledgerFixture = (options = {}) => {
  const clock = new ManualClock();
  const manager = options.manager ?? new FakeSessionManager();
  const ledger = new SessionUsageLedger({
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    monotonic: () => 0,
    chunkEntries: options.chunkEntries ?? 2,
    ...options,
  });
  return { clock, manager, ledger };
};

/** Drain queued ledger work one timer at a time (bounded). */
const drain = (fixture, limit = 200) => {
  for (let index = 0; index < limit && fixture.clock.pending > 0; index++) fixture.clock.step();
};

test("aggregation agrees with an independent oracle over every in-scope record kind", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  manager.appendMessage({ role: "user", content: [] });
  manager.appendMessage(toolResultEntry(2));
  manager.appendMessage({ role: "toolResult", toolCallId: "t2", toolName: "t", content: [] }); // no usage: out of scope
  manager.appendCompaction("summary-a", usage(3));
  manager.appendCompaction("summary-b"); // no usage
  manager.appendBranchSummary("branch-a", usage(4));
  manager.appendBranchSummary("branch-b"); // no usage
  manager.appendMessage(assistantEntry(5, { stopReason: "error" }));
  manager.appendMessage(assistantEntry(6, { stopReason: "aborted" }));
  manager.append({ type: "custom", customType: "other-ext", data: {} });
  manager.append({ type: "thinking_level_change", thinkingLevel: "high" });
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  drain(f);
  const view = f.ledger.view();
  const oracle = oracleTotals(manager.getEntries());
  assert.equal(view.status, "partial", "records without usage make the data incomplete");
  assert.equal(view.input, oracle.input);
  assert.equal(view.output, oracle.output);
  assert.equal(view.cacheRead, oracle.cacheRead);
  assert.equal(view.cacheWrite, oracle.cacheWrite);
  assert.equal(view.usageRecords, oracle.records);
  assert.ok(Math.abs(view.cost - oracle.cost) < 1e-9);
  assert.equal(view.assistantMissingUsage, 0);
  assert.equal(view.summaryMissingUsage, 2);
  assert.equal(view.missingInput, 0);
});

test("all-history totals survive tree navigation: the ledger never becomes branch-only", () => {
  const manager = new FakeSessionManager();
  const root = manager.appendMessage(assistantEntry(1));
  const branchPoint = manager.appendMessage(toolResultEntry(2));
  manager.appendMessage(assistantEntry(3));
  manager.navigate(branchPoint); // walk another path
  const other = manager.appendMessage(assistantEntry(4));
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  drain(f);
  const before = f.ledger.view();
  const oracle = oracleTotals(manager.getEntries());
  assert.equal(before.input, oracle.input, "abandoned-branch records stay in the session totals");
  // Simulate the host emitting session_tree after navigating back to the root.
  manager.navigate(root);
  f.ledger.onStructural("tree");
  drain(f);
  const after = f.ledger.view();
  assert.equal(after.input, oracle.input, "rebuild includes every entry, not the active branch");
  assert.equal(after.status, "ready");
  assert.ok(f.ledger.inspect().rebuilds >= 2);
  assert.notEqual(other, null);
});

test("assistant without usage is incomplete data; toolResult without usage is not an unknown charge", () => {
  const totals = { };
  const fresh = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usageRecords: 0, costKnown: 0, costMissing: 0, missingInput: 0, missingOutput: 0, missingCacheRead: 0, missingCacheWrite: 0, assistantMissingUsage: 0, summaryMissingUsage: 0, examined: 0, limited: false });
  {
    totals.t = fresh();
    aggregateEntry({ type: "message", message: { role: "assistant", content: [] } }, totals.t);
    assert.equal(totals.t.assistantMissingUsage, 1);
    assert.equal(totals.t.costMissing, 1, "an assistant without usage has an unknown cost");
    assert.equal(totals.t.usageRecords, 0);
  }
  {
    const t = fresh();
    aggregateEntry({ type: "message", message: { role: "toolResult", content: [] } }, t);
    assert.equal(t.usageRecords, 0);
    assert.equal(t.costMissing, 0, "a usage-less toolResult is out of scope, not an unknown charge");
    assert.equal(t.summaryMissingUsage, 0);
  }
  {
    const t = fresh();
    aggregateEntry({ type: "compaction", summary: "s" }, t);
    aggregateEntry({ type: "branch_summary", summary: "s" }, t);
    assert.equal(t.summaryMissingUsage, 2);
    assert.equal(t.costMissing, 2);
    assert.equal(t.missingInput, 0, "known token subtotals stay unmarked for usage-less summaries");
  }
  {
    const t = fresh();
    aggregateEntry({ type: "message", message: { role: "assistant", usage: { input: -1, output: NaN, cacheRead: Infinity, cacheWrite: 5, cost: { total: 0 } } } }, t);
    assert.equal(t.input, 0);
    assert.equal(t.missingInput, 1); assert.equal(t.missingOutput, 1); assert.equal(t.missingCacheRead, 1);
    assert.equal(t.cacheWrite, 5, "the one valid field still counts");
    assert.equal(t.costKnown, 1, "an explicit zero cost stays a valid zero");
    assert.equal(t.cost, 0);
  }
  {
    const t = fresh();
    aggregateEntry({ type: "message", message: { role: "assistant", usage: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2, cost: { total: "x" } } } }, t);
    assert.equal(t.costKnown, 0); assert.equal(t.costMissing, 1);
  }
  {
    const t = fresh();
    aggregateEntry(undefined, t); aggregateEntry(null, t); aggregateEntry({ type: "message", message: "not-an-object" }, t);
    assert.equal(t.examined, 3);
  }
  void totals;
});

test("saturated sums mark limited instead of pretending precision", () => {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usageRecords: 0, costKnown: 0, costMissing: 0, missingInput: 0, missingOutput: 0, missingCacheRead: 0, missingCacheWrite: 0, assistantMissingUsage: 0, summaryMissingUsage: 0, examined: 0, limited: false };
  for (let index = 0; index < 4; index++) {
    aggregateEntry({ type: "message", message: { role: "assistant", usage: { input: Number.MAX_SAFE_INTEGER / 2, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }, t);
  }
  assert.equal(t.input, LEDGER_LIMITS.maxTotal);
  assert.equal(t.limited, true);
});

// ---------------------------------------------------------------------------
// Baseline lifecycle: slicing, cancellation, identity
// ---------------------------------------------------------------------------

test("baseline slices with one getEntries call and yields between chunks", () => {
  const manager = new FakeSessionManager();
  for (let index = 0; index < 9; index++) manager.appendMessage(assistantEntry(1));
  const f = ledgerFixture({ manager, chunkEntries: 2 });
  f.ledger.restart(manager, "test");
  assert.equal(f.ledger.view()?.status, "loading");
  f.clock.step(); // capture + first slice
  assert.equal(manager.calls.getEntries, 1, "getEntries runs exactly once per baseline");
  assert.equal(f.ledger.view()?.status, "loading", "slicing is still in progress");
  assert.ok(f.clock.pending > 0, "later slices are queued, not run synchronously");
  drain(f);
  const view = f.ledger.view();
  assert.equal(view.status, "ready");
  assert.equal(manager.calls.getEntries, 1, "slicing never re-reads the entry array");
  assert.equal(view.examined, 9);
});

test("appends during slicing are caught up from the captured leaf, never double counted", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  manager.appendMessage(assistantEntry(2));
  const f = ledgerFixture({ manager, chunkEntries: 1 });
  f.ledger.restart(manager, "test");
  f.clock.step(); // capture + first slice; one entry remains
  assert.equal(f.ledger.view()?.status, "loading");
  manager.appendMessage(assistantEntry(3)); // arrives while slicing
  drain(f);
  const view = f.ledger.view();
  const oracle = oracleTotals(manager.order);
  assert.equal(view.input, oracle.input);
  assert.equal(view.usageRecords, 3);
  // A duplicate notification for the same committed leaf adds nothing.
  f.ledger.requestVerify();
  drain(f);
  assert.equal(f.ledger.view().input, oracle.input);
  assert.equal(manager.calls.getEntries, 1);
});

test("empty history baselines to a legal null cursor and verifies later appends", () => {
  const manager = new FakeSessionManager();
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  drain(f);
  assert.equal(f.ledger.view().status, "ready");
  assert.equal(f.ledger.inspect().cursor, null);
  manager.appendMessage(assistantEntry(3));
  f.ledger.onMessageEnd();
  assert.equal(f.ledger.view().updating, true);
  f.ledger.requestVerify();
  drain(f);
  const view = f.ledger.view();
  assert.equal(view.updating, false);
  assert.equal(view.input, 3);
  assert.equal(view.usageRecords, 1);
});

test("a null leaf after tree navigation is a legal cursor: history stays, root appends commit", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  drain(f);
  assert.equal(f.ledger.view().input, 1);
  assert.equal(f.ledger.view().status, "ready");
  // Pi's resetLeaf() (navigate to re-edit the first user message): history is kept,
  // the leaf becomes null and the next append creates a new root entry.
  manager.leaf = null;
  f.ledger.onStructural("tree");
  drain(f);
  const navigated = f.ledger.view();
  assert.equal(navigated.input, 1, "the rebuild keeps the full-history totals");
  assert.equal(navigated.status, "ready", "a null cursor after tree navigation is not an anomaly");
  assert.equal(f.ledger.inspect().cursor, null);
  assert.equal(f.ledger.inspect().failureReason, null);
  manager.appendMessage(assistantEntry(2)); // parentId null: a new root entry
  f.ledger.onMessageEnd();
  f.ledger.requestVerify();
  drain(f);
  const final = f.ledger.view();
  assert.equal(final.input, 3, "the root-level append is counted exactly once");
  assert.equal(final.status, "ready");
  assert.equal(final.updating, false);
  assert.equal(manager.calls.getEntries, 2, "the verify itself walked the chain, not the array");
  // A second append chains onto the first (parent = previous leaf), so a later verify
  // commits both without needing another rebuild.
  manager.appendMessage(assistantEntry(4));
  f.ledger.onMessageEnd();
  f.ledger.requestVerify();
  drain(f);
  assert.equal(f.ledger.view().input, 7, "consecutive root-level appends chain and both count");
  assert.equal(manager.calls.getEntries, 2);
});

test("session replacement discards in-flight work: an old generation never publishes", () => {
  const first = new FakeSessionManager("sess-1");
  for (let index = 0; index < 6; index++) first.appendMessage(assistantEntry(1));
  const f = ledgerFixture({ manager: first, chunkEntries: 1 });
  f.ledger.restart(first, "test");
  f.clock.step(); // capture + slice of the old session
  assert.equal(f.ledger.view()?.status, "loading");
  const second = new FakeSessionManager("sess-2");
  second.appendMessage(assistantEntry(7));
  f.ledger.restart(second, "session-start"); // switch sessions mid-slice
  drain(f);
  const view = f.ledger.view();
  assert.equal(view.input, 7, "only the new manager's totals are published");
  assert.equal(view.usageRecords, 1);
  assert.equal(f.ledger.inspect().sessionId, "sess-2");
});

test("deactivate cancels tasks and releases state; a later restart re-baselines", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(2));
  const f = ledgerFixture({ manager, chunkEntries: 1 });
  f.ledger.restart(manager, "test");
  f.clock.step();
  f.ledger.deactivate();
  assert.equal(f.clock.pending, 0, "no ledger timer survives deactivation");
  assert.equal(f.ledger.view(), null);
  f.ledger.restart(manager, "enable");
  drain(f);
  assert.equal(f.ledger.view().input, 2);
});

// ---------------------------------------------------------------------------
// Incremental reconciliation and failure recovery
// ---------------------------------------------------------------------------

test("turn_end reconciles final committed entries; message_end never adds event usage", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  drain(f);
  // A later extension replaces the message after the HUD saw message_end: the ledger must
  // reflect the final manager entry, not the observed event payload.
  manager.appendMessage(assistantEntry(2));
  f.ledger.onMessageEnd(); // marks pending only
  assert.equal(f.ledger.view().input, 1);
  assert.equal(f.ledger.view().updating, true);
  f.ledger.requestVerify();
  drain(f);
  assert.equal(f.ledger.view().input, 3);
  assert.equal(f.ledger.view().updating, false);
  assert.equal(manager.calls.getEntries, 1, "steady state never calls getEntries");
});

test("duplicate turn_end and agent_settled notifications never double count", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  drain(f);
  manager.appendMessage(toolResultEntry(2));
  for (let index = 0; index < 5; index++) { f.ledger.requestVerify(); drain(f); }
  const view = f.ledger.view();
  assert.equal(view.usageRecords, 2);
  assert.equal(view.input, 3);
  assert.equal(manager.calls.getEntries, 1);
});

test("a broken chain drops the batch, marks partial and schedules exactly one recovery rebuild", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  drain(f);
  assert.equal(f.ledger.view().status, "ready");
  manager.appendMessage(assistantEntry(2));
  manager.dropIndex(manager.order.at(-1).id); // getEntry now fails mid-chain
  f.ledger.requestVerify();
  f.clock.step(); // run the one planned verification
  assert.equal(f.ledger.view().status, "partial", "the uncommitted batch is dropped, not half-applied");
  assert.equal(f.ledger.view().input, 1);
  assert.ok(f.clock.pending > 0, "one recovery rebuild is scheduled");
  drain(f);
  const view = f.ledger.view();
  assert.equal(view.input, 3, "the recovery rebuild folds the whole history again");
  assert.equal(view.status, "ready");
  assert.equal(manager.calls.getEntries, 2);
  assert.ok(f.ledger.inspect().recoveryRebuilds >= 1);
});

test("an over-cap delta fails, recovers via rebuild and does not loop while idle", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = ledgerFixture({ manager, chunkEntries: 64, incrementCap: 3 });
  f.ledger.restart(manager, "test");
  drain(f);
  for (let index = 0; index < 6; index++) manager.appendMessage(assistantEntry(1));
  f.ledger.requestVerify();
  f.clock.step();
  assert.equal(f.ledger.view().status, "partial");
  drain(f);
  assert.equal(f.ledger.view().usageRecords, 7);
  assert.equal(f.ledger.view().status, "ready");
  assert.equal(f.clock.pending, 0, "no idle retry loop remains after recovery");
});

test("tree navigation that strands the cursor recovers through the walk failure path", () => {
  const manager = new FakeSessionManager();
  const root = manager.appendMessage(assistantEntry(1));
  const branchA = manager.appendMessage(assistantEntry(2));
  manager.appendMessage(assistantEntry(3));
  manager.navigate(branchA);
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  drain(f);
  // The host switched branches without emitting session_tree: the walk cannot find the
  // committed cursor on the new path and must recover with one rebuild.
  manager.navigate(root);
  manager.appendMessage(assistantEntry(4));
  f.ledger.requestVerify();
  drain(f);
  const view = f.ledger.view();
  const oracle = oracleTotals(manager.getEntries());
  assert.equal(view.input, oracle.input);
  assert.equal(view.usageRecords, oracle.records);
});

test("compaction rebuilds from the manager, so repeated summaries and event entries never mislead", () => {
  const manager = new FakeSessionManager();
  const anchor = manager.appendMessage(assistantEntry(1));
  manager.appendCompaction("same-summary", usage(2));
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  drain(f);
  assert.equal(f.ledger.view().input, 3);
  // Second compaction with the same summary text (the SDK's event entry lookup can select
  // the old record); the ledger must rebuild from the manager, not trust event payloads.
  manager.appendCompaction("same-summary", usage(3));
  f.ledger.onStructural("compact");
  drain(f);
  const view = f.ledger.view();
  assert.equal(view.input, 6, "both compaction records count");
  assert.equal(view.usageRecords, 3);
  assert.notEqual(anchor, null);
});

// ---------------------------------------------------------------------------
// Controller integration
// ---------------------------------------------------------------------------

test("observed stays the default scope and never creates ledger work", () => {
  const f = controllerFixture();
  assert.equal(f.controller.config.usageScope, "observed");
  f.emit("message_end", { message: assistant() });
  f.emit("turn_end");
  f.clock.advance(0);
  assert.equal(f.clock.jobs.size, 0, "no ledger task exists in observed mode");
  assert.equal(f.controller.inspect().sessionUsage.status, "inactive");
  assert.equal(f.controller.inspect().sessionUsage.rebuilds, 0);
  f.emit("session_shutdown");
});

test("session scope drives the ledger from the controller and renders sess-labelled totals", async () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = controllerFixture({ usageManager: manager, config: { usageScope: "session", preset: "full" } });
  f.clock.advance(0); // drain the baseline
  const view = f.controller.ledger.view();
  assert.equal(view.status, "ready");
  assert.equal(view.input, 1);
  f.clock.advance(250); // publish
  const lines = f.widget().render(120).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
  assert.match(lines.join("\n"), /sess\*/);
  assert.ok(!lines.join("\n").includes("obs*"), "session mode must not keep the observed label");
  // Appends reconcile at turn_end and the widget shows the merged totals.
  manager.appendMessage(assistantEntry(2));
  f.emit("message_end", { message: assistant({ usage: { input: 999, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 9 } } }) });
  assert.equal(f.controller.ledger.view().input, 1, "message_end adds nothing to the session ledger");
  f.emit("turn_end");
  f.clock.advance(0);
  assert.equal(f.controller.ledger.view().input, 3);
  f.clock.advance(250);
  const updated = f.widget().render(120).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
  assert.match(updated.join("\n"), /sess\*/);
  assert.equal(manager.calls.getEntries, 1);
  f.emit("session_shutdown");
});

test("a toolResult message_end repaints for the updating marker without observed changes", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = controllerFixture({ usageManager: manager, config: { usageScope: "session", preset: "full" } });
  f.clock.advance(0);
  f.clock.advance(250);
  let paints = 0;
  const widget = f.widget();
  const original = widget.render.bind(widget);
  widget.render = (width) => { paints++; return original(width); };
  // A toolResult message changes no observed counter but appends to the session.
  manager.appendMessage({ role: "toolResult", toolCallId: "t", toolName: "t", content: [] });
  f.emit("message_end", { message: { role: "toolResult", toolCallId: "t", toolName: "t", content: [] } });
  f.clock.advance(250);
  assert.ok(paints > 0, "the updating marker repaints even without observed counter changes");
  const lines = f.widget().render(120).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
  assert.match(lines.join("\n"), /sess\* ↻/, "the pending append is visible as updating");
  f.emit("turn_end");
  f.clock.advance(0);
  f.clock.advance(250);
  assert.equal(f.controller.ledger.view().updating, false);
  f.emit("session_shutdown");
});

test("a host without the read-only entry surface degrades explicitly to observed labels", async () => {
  const f = controllerFixture({ config: { usageScope: "session", preset: "full" } }); // proxy manager throws on entry access
  f.clock.advance(0);
  const diagnostics = f.controller.inspect();
  assert.equal(diagnostics.sessionUsage.status, "unavailable");
  assert.match(diagnostics.sessionUsage.failureReason ?? "", /read-only entry surface/);
  assert.equal(f.controller.ledger.view(), null);
  f.clock.advance(250);
  f.emit("message_end", { message: assistant() });
  f.clock.advance(250);
  const lines = f.widget().render(120).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
  assert.match(lines.join("\n"), /obs\*/, "the degraded display keeps the observed label");
  assert.ok(!lines.join("\n").includes("sess*"));
  f.emit("session_shutdown");
});

test("scope switching rebuilds from scratch each time; off stops acquisition", async () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(2));
  const f = controllerFixture({ usageManager: manager });
  await f.controller.command("scope session", f.ctx);
  f.clock.advance(0);
  assert.equal(f.controller.ledger.view().input, 2);
  const rebuildsAfterFirst = f.controller.ledger.inspect().rebuilds;
  manager.appendMessage(assistantEntry(1));
  f.emit("turn_end");
  f.clock.advance(0);
  await f.controller.command("scope observed", f.ctx);
  assert.equal(f.controller.ledger.view(), null, "leaving session mode stops acquisition");
  f.clock.advance(1_000);
  assert.equal(f.clock.jobs.size, 0, "after draining, no ledger task remains");
  assert.equal(f.controller.ledger.view(), null);
  await f.controller.command("scope session", f.ctx);
  assert.equal(f.controller.ledger.view()?.status, "loading", "re-entry rebuilds, it never continues a gap");
  f.clock.advance(0);
  assert.equal(f.controller.ledger.view().input, 3);
  assert.ok(f.controller.ledger.inspect().rebuilds > rebuildsAfterFirst);
  await f.controller.command("off", f.ctx);
  assert.equal(f.controller.ledger.view(), null);
  assert.equal(f.clock.jobs.size, 0);
  await f.controller.command("on", f.ctx);
  assert.equal(f.controller.ledger.view()?.status, "loading", "re-enabling re-baselines");
  f.clock.advance(0);
  assert.equal(f.controller.ledger.view().input, 3);
  f.emit("session_shutdown");
});

test("surface switching and theme changes never reset the session ledger", async () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = controllerFixture({ usageManager: manager, config: { usageScope: "session" } });
  f.clock.advance(0);
  const rebuilds = f.controller.ledger.inspect().rebuilds;
  await f.controller.command("surface footer", f.ctx);
  await f.controller.command("palette mono", f.ctx);
  await f.controller.command("surface widget", f.ctx);
  f.clock.advance(300);
  assert.equal(f.controller.ledger.inspect().rebuilds, rebuilds, "view-only changes never rebuild");
  assert.equal(f.controller.ledger.view().input, 1, "the session account survives surface switches");
  f.emit("session_shutdown");
});

test("/hud reset clears observed counters but keeps and re-verifies the session ledger", async () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(2));
  const f = controllerFixture({ usageManager: manager, config: { usageScope: "session" } });
  f.clock.advance(0);
  f.emit("message_end", { message: assistant() });
  f.clock.advance(250);
  await f.controller.command("reset", f.ctx);
  assert.equal(f.controller.state.input, 0, "observed counters reset");
  assert.equal(f.controller.ledger.view().input, 2, "the session ledger keeps its definition");
  f.emit("session_shutdown");
});

test("tree and compact events rebuild the ledger through the controller", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = controllerFixture({ usageManager: manager, config: { usageScope: "session" } });
  f.clock.advance(0);
  const rebuilds = f.controller.ledger.inspect().rebuilds;
  f.emit("session_tree");
  assert.equal(f.controller.ledger.inspect().rebuilds, rebuilds + 1);
  assert.equal(f.controller.ledger.view().updating, true, "the old snapshot is marked updating during the rebuild");
  f.clock.advance(0);
  f.emit("session_compact");
  f.clock.advance(0);
  assert.equal(f.controller.ledger.view().status, "ready");
  assert.equal(f.controller.state.contextTokens, null, "observed ctx/CH invalidation is unchanged");
  f.emit("session_shutdown");
});

test("renders perform zero history reads and idle sessions schedule no ledger work", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = controllerFixture({ usageManager: manager, config: { usageScope: "session" } });
  f.clock.advance(0);
  f.clock.advance(250);
  const calls = { ...manager.calls };
  for (let index = 0; index < 50; index++) f.widget().render(80);
  f.emit("model_select", { model: MODEL });
  f.clock.advance(250);
  for (let index = 0; index < 50; index++) f.widget().render(100);
  assert.deepEqual(manager.calls, calls, "render and stable turns read no history");
  assert.ok(manager.calls.getEntries === 1);
  f.clock.advance(60_000);
  assert.equal(f.clock.jobs.size, 0, "no polling or heartbeat exists");
  f.emit("session_shutdown");
});

test("the footer surface shows session fields and RPC mode reads no history", async () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(2));
  const f = controllerFixture({ usageManager: manager, config: { usageScope: "session", surface: "footer" } });
  f.clock.advance(0); f.clock.advance(250);
  const lines = f.footer().render(120).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
  assert.match(lines[1], /sess\*/);
  assert.ok(!lines.join("\n").includes("obs*"));
  f.emit("session_shutdown");
  const headless = controllerFixture({ usageManager: manager, mode: "rpc", config: { usageScope: "session" } });
  headless.clock.advance(0);
  assert.equal(headless.controller.ledger, null, "non-TUI modes never create the ledger");
  assert.deepEqual(manager.calls, { getEntries: 1, getEntry: 0, getLeafId: 2, getSessionId: 2 }, "only the TUI baseline touched the manager (capture + finish identity check)");
  headless.emit("session_shutdown");
});

test("turn_end is an observed event and reachability is confined to the ledger boundary", () => {
  const f = controllerFixture();
  assert.ok(OBSERVED_EVENTS.includes("turn_end"));
  f.emit("turn_end"); // must not throw or change observed state
  assert.equal(f.controller.state.phase, "idle");
  f.emit("session_shutdown");
});

test("a getEntries failure or non-array return degrades to unavailable without a loop", () => {
  const broken = { getEntries: () => { throw new Error("host exploded"); }, getEntry: () => undefined, getLeafId: () => null, getSessionId: () => "s" };
  const f = ledgerFixture({ manager: broken, chunkEntries: 1 });
  f.ledger.restart(broken, "test");
  f.clock.step();
  assert.equal(f.ledger.view(), null, "the display degrades to observed-labelled data");
  const diag = f.ledger.inspect();
  assert.equal(diag.status, "unavailable");
  assert.match(diag.failureReason ?? "", /getEntries failed/);
  assert.equal(f.clock.pending, 0, "no retry is scheduled");
  const nonArray = { getEntries: () => 42, getEntry: () => undefined, getLeafId: () => null, getSessionId: () => "s" };
  const g = ledgerFixture({ manager: nonArray });
  g.ledger.restart(nonArray, "test");
  g.clock.step();
  assert.equal(g.ledger.inspect().status, "unavailable");
});

test("a malformed parentId fails the walk instead of following garbage", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  drain(f);
  const malformed = { type: "message", message: assistantEntry(2), parentId: 42 };
  manager.append(malformed);
  f.ledger.requestVerify();
  f.clock.step();
  assert.equal(f.ledger.view().status, "partial");
  assert.match(f.ledger.inspect().failureReason ?? "", /malformed-parent/);
  drain(f);
  const view = f.ledger.view();
  assert.equal(view.input, 3, "the recovery rebuild folds the malformed record from getEntries");
  assert.equal(view.status, "ready");
});

test("a second catch-up failure heals through the next successful verify, not a timer", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  manager.appendMessage(assistantEntry(1));
  let publishes = 0;
  const f = ledgerFixture({ manager, chunkEntries: 1, onPublish: () => publishes++ });
  f.ledger.restart(manager, "test");
  f.clock.step(); // capture + first slice
  // First failure: e3 is temporarily un-indexable when the baseline finishes.
  const id3 = manager.appendMessage(assistantEntry(1));
  const record3 = manager.byId.get(id3);
  manager.dropIndex(id3);
  f.clock.step(); // last slice -> catch-up fails -> one recovery scheduled
  // The recovery's own catch-up fails on e4: no further self-perpetuation.
  manager.byId.set(id3, record3);
  const id4 = manager.appendMessage(assistantEntry(1));
  const record4 = manager.byId.get(id4);
  manager.dropIndex(id4);
  drain(f);
  const stuck = f.ledger.view();
  const stuckDiag = f.ledger.inspect();
  assert.equal(stuck.input, 3, "totals stay valid up to the committed cursor");
  assert.equal(stuck.status, "partial");
  assert.equal(stuckDiag.coverageGap, true);
  assert.match(stuckDiag.failureReason ?? "", /catchup:missing-entry/);
  assert.equal(f.clock.pending, 0, "the second failure does not self-perpetuate");
  // The index heals and the next event boundary verifies: the anchored walk commits the
  // exact segment the failures could not reach, so the coverage failure clears.
  manager.byId.set(id4, record4);
  const publishesBeforeHeal = publishes;
  f.ledger.onMessageEnd();
  f.ledger.requestVerify();
  drain(f);
  const healed = f.ledger.view();
  const healedDiag = f.ledger.inspect();
  assert.equal(healed.input, 4, "the healed delta is committed");
  assert.equal(healed.status, "ready", "the confirmed gap clears the coverage partial");
  assert.equal(healedDiag.coverageGap, false);
  assert.equal(healedDiag.failureReason, null);
  assert.ok(publishes > publishesBeforeHeal, "the healed publication notifies the UI");
  assert.equal(f.clock.pending, 0, "no idle retry loop remains");
  // Genuine record incompleteness still keeps the partial mark with no failure reason.
  manager.appendCompaction("no-usage", undefined);
  f.ledger.onMessageEnd();
  f.ledger.requestVerify();
  drain(f);
  const afterSummary = f.ledger.view();
  assert.equal(afterSummary.status, "partial", "a usage-less summary keeps the data incomplete");
  assert.equal(f.ledger.inspect().coverageGap, false, "field incompleteness is not a coverage gap");
  assert.equal(f.ledger.inspect().failureReason, null);
});

test("a healed gap publishes even when nothing was marked pending", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  let publishes = 0;
  const f = ledgerFixture({ manager, onPublish: () => publishes++ });
  f.ledger.restart(manager, "test");
  drain(f);
  // A verify failure (broken chain) creates the gap; the recovery rebuild cannot run
  // because the ledger is drained, so healing must come from a later event boundary.
  const id = manager.appendMessage(assistantEntry(2));
  manager.dropIndex(id);
  f.ledger.requestVerify();
  f.clock.step();
  assert.equal(f.ledger.view().status, "partial");
  drain(f); // the scheduled recovery folds the record and clears the failure
  assert.equal(f.ledger.view().status, "ready");
  // Now create a second gap and heal it with a bare requestVerify (no message_end, no
  // updating flag): the healed publication must still go out.
  const id2 = manager.appendMessage(assistantEntry(3));
  manager.dropIndex(id2);
  f.ledger.requestVerify();
  f.clock.step();
  assert.equal(f.ledger.view().status, "partial");
  manager.byId.set(id2, manager.order.at(-1));
  const before = publishes;
  f.ledger.requestVerify();
  drain(f);
  assert.equal(f.ledger.view().input, 6, "the healed segment is committed");
  assert.equal(f.ledger.view().status, "ready");
  assert.ok(publishes > before, "a bare heal (nothing pending) still notifies the UI");
  assert.equal(f.clock.pending, 0);
});

test("catch-up failure keeps valid totals, records the gap and recovers via one rebuild", () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  manager.appendMessage(assistantEntry(2));
  const f = ledgerFixture({ manager, chunkEntries: 1 });
  f.ledger.restart(manager, "test");
  f.clock.step(); // capture: leaf = e2; first slice done
  manager.appendMessage(assistantEntry(3));
  manager.dropIndex("e3"); // the catch-up walk cannot resolve the new leaf
  f.clock.step(); // last slice -> finishBaseline: catch-up fails, recovery planned
  const view = f.ledger.view();
  assert.equal(view.input, 3, "entries up to the captured leaf stay counted");
  assert.equal(view.status, "partial", "the un-walked delta marks the coverage gap");
  const diag = f.ledger.inspect();
  assert.match(diag.failureReason ?? "", /catchup:/);
  assert.equal(diag.coverageGap, true);
  assert.ok(diag.recoveryRebuilds >= 1, "the swallowed verification is recovered by a rebuild");
  assert.ok(f.clock.pending > 0, "the recovery is scheduled");
  drain(f);
  const recovered = f.ledger.view();
  assert.equal(recovered.input, 6, "the recovery rebuild folds the un-indexed record from getEntries");
  assert.equal(recovered.status, "ready");
  assert.equal(f.ledger.inspect().failureReason, null, "the recovered read clears the failure record");
});

test("an over-cap append burst during slicing is recovered by a catch-up rebuild", () => {
  const manager = new FakeSessionManager();
  for (let index = 0; index < 600; index++) manager.appendMessage(assistantEntry(1));
  const f = ledgerFixture({ manager, chunkEntries: 512 });
  f.ledger.restart(manager, "test");
  f.clock.step(); // capture: 600 entries; first slice of 512 leaves 88 slicing
  assert.ok(f.ledger.busy(), "the baseline is still slicing");
  for (let index = 0; index < 2_049; index++) manager.appendMessage(assistantEntry(1));
  f.ledger.onMessageEnd();
  f.ledger.requestVerify(); // arrives while the baseline is slicing and is swallowed
  drain(f, 500);
  const view = f.ledger.view();
  const diag = f.ledger.inspect();
  assert.equal(view.input, 600 + 2_049, "the recovery rebuild folds the whole burst");
  assert.equal(view.status, "ready");
  assert.equal(view.updating, false);
  assert.ok(diag.recoveryRebuilds >= 1);
  assert.equal(diag.failureReason, null, "a recovered full read clears the failure record");
  assert.equal(f.clock.pending, 0, "no retry loop remains");
});

// ---------------------------------------------------------------------------
// Display: labels, markers, degradation and narrow widths
// ---------------------------------------------------------------------------

const snapshotWith = (sessionUsage, overrides = {}) => {
  const state = new HudState("/tmp/example", MODEL, 0);
  state.messageEnd({ role: "assistant", stopReason: "stop", model: MODEL.id, provider: MODEL.provider, usage: { input: 1_000, output: 300, cacheRead: 2_000, cacheWrite: 400, cost: { total: 0.012 } } }, 1);
  const snapshot = state.snapshot();
  snapshot.sessionUsage = sessionUsage;
  return Object.assign(snapshot, overrides);
};

const sessionView = (overrides = {}) => ({
  status: "ready", updating: false, input: 12_345, output: 3_000, cacheRead: 75_000, cacheWrite: 1_200,
  cost: 0.42, costKnown: true, costMissing: false, usageRecords: 9, examined: 40,
  missingInput: 0, missingOutput: 0, missingCacheRead: 0, missingCacheWrite: 0,
  assistantMissingUsage: 0, summaryMissingUsage: 0, limited: false, fieldsIncomplete: false,
  ...overrides,
});

test("session field renders the sess label, split counters and observed CH", () => {
  const config = normalizeConfig({ usageScope: "session", preset: "full", color: false });
  const snapshot = snapshotWith(sessionView());
  const rows = formatHud(snapshot, config, 120).map((row) => row.text);
  assert.match(rows.at(-1), /sess\* ↑12k ↓3.0k R75k W1.2k CH58\.8%/);
  const zh = formatHud(snapshot, normalizeConfig({ usageScope: "session", preset: "full", color: false, language: "zh-CN" }), 120);
  assert.match(zh.at(-1).text, /全会话\*/);
  const ascii = formatHud(snapshot, normalizeConfig({ usageScope: "session", preset: "full", color: false, ascii: true }), 120);
  assert.match(ascii.at(-1).text, /in12k out3\.0k/);
});

test("loading renders unknown, updating keeps the old snapshot marked, partial renders +?", () => {
  const config = normalizeConfig({ usageScope: "session", preset: "full", color: false });
  const loading = formatHud(snapshotWith(sessionView({ status: "loading", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usageRecords: 0, examined: 0, cost: 0, costKnown: false })), config, 120);
  assert.match(loading.at(-1).text, /sess\* \? CH58\.8%/);
  const updating = formatHud(snapshotWith(sessionView({ updating: true })), config, 120);
  assert.match(updating.at(-1).text, /sess\* ↻ ↑12k/);
  const asciiUpdating = formatHud(snapshotWith(sessionView({ updating: true })), normalizeConfig({ usageScope: "session", preset: "full", color: false, ascii: true }), 120);
  assert.match(asciiUpdating.at(-1).text, /sess\* ~ in12k/);
  const partial = formatHud(snapshotWith(sessionView({ fieldsIncomplete: true, missingOutput: 2, summaryMissingUsage: 1 })), config, 120);
  assert.match(partial.at(-1).text, /sess\* ↻ \+\?|sess\* \+\?/);
  assert.match(partial.at(-1).text, /sess\* \+\? ↑12k/);
  const limited = formatHud(snapshotWith(sessionView({ limited: true })), config, 120);
  assert.match(limited.at(-1).text, /limited\*/);
});

test("session cost rendering: unknown ?, partial <known>+?, valid zero stays zero", () => {
  const config = normalizeConfig({ usageScope: "session", preset: "balanced", color: false });
  const rowsFor = (view) => formatHud(snapshotWith(view), config, 140).map((row) => row.text).join("\n");
  assert.match(rowsFor(sessionView({ cost: 0, costKnown: true })), /sess\* \$0\.000(?!\+\?)/, "an explicit zero stays a valid zero");
  assert.match(rowsFor(sessionView({ costMissing: true })), /sess\* \$0\.420\+\?/, "an unknown cost part shows on the value");
  assert.match(rowsFor(sessionView({ costKnown: false, cost: 0 })), /sess\* \?/, "all-unknown cost shows ?");
  // A summary without usage keeps tokens but marks cost incomplete.
  assert.match(rowsFor(sessionView({ summaryMissingUsage: 1, fieldsIncomplete: true, costMissing: true })), /\$0\.420\+\?/);
});

test("the session cost field carries scope and status marks even without the token field", () => {
  // balanced widget: the token field is not rendered, so the cost field is the only
  // usage information and must be self-describing.
  const config = normalizeConfig({ usageScope: "session", preset: "balanced", color: false });
  const rowsFor = (view, extra = {}) => formatHud(snapshotWith(view), normalizeConfig({ usageScope: "session", preset: "balanced", color: false, ...extra }), 140).map((row) => row.text).join("\n");
  assert.ok(!/sess\* ↑|obs\*/.test(rowsFor(sessionView())), "no token field in balanced");
  assert.match(rowsFor(sessionView({ updating: true })), /sess\* ↻ \$0\.420/, "updating shows in the cost field");
  assert.match(rowsFor(sessionView({ updating: true }), { ascii: true }), /sess\* ~ \$0\.420/, "ASCII updating mark");
  assert.match(rowsFor(sessionView({ fieldsIncomplete: true, missingInput: 2 })), /sess\* \+\? \$0\.420/, "non-cost incompleteness shows as a mark");
  assert.match(rowsFor(sessionView({ fieldsIncomplete: true, costMissing: true })), /sess\* \$0\.420\+\?/, "cost incompleteness stays on the value without a duplicate mark");
  assert.match(rowsFor(sessionView({ limited: true })), /sess\* limited\* \$0\.420/, "saturation precedes the cost value");
  assert.match(rowsFor(sessionView({ status: "loading", costKnown: false })), /sess\* \?/, "loading shows unknown");
  // The footer usage row keeps the same self-describing cost field when narrow width
  // drops the token field.
  const footer = formatFooter(snapshotWith(sessionView({ fieldsIncomplete: true, missingInput: 2, updating: true })), normalizeConfig({ usageScope: "session", preset: "balanced", color: false }), 46, EMPTY_IDENTITY).map((row) => row.text);
  const usageRow = footer[1] ?? "";
  if (!usageRow.includes("↑")) assert.match(usageRow, /sess\*/, "the cost field keeps the session scope when tokens fold");
});

test("an unavailable or inactive ledger renders the observed fields unchanged", () => {
  const config = normalizeConfig({ usageScope: "session", preset: "full", color: false });
  const snapshot = snapshotWith(null);
  const rows = formatHud(snapshot, config, 120).map((row) => row.text);
  assert.match(rows.at(-1), /obs\*/);
  assert.ok(!rows.join("\n").includes("sess*"));
});

test("the saturation marker precedes every saturated number and survives clipping", () => {
  const saturated = sessionView({
    input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER,
    cacheRead: Number.MAX_SAFE_INTEGER, cacheWrite: 0,
    cost: Number.MAX_SAFE_INTEGER, limited: true,
  });
  // Full widget with showCost off at 40 columns is the reported scenario: the counters
  // clip, and the capped-total hint must stay in front of whatever remains visible.
  const full = normalizeConfig({ usageScope: "session", preset: "full", color: false, showCost: false });
  const row = formatHud(snapshotWith(saturated), full, 40).at(-1).text;
  assert.match(row, /sess\* limited\* ↑90/, "the marker precedes the clipped counters");
  assert.match(row, /…$/, "the row is genuinely clipped, not wide enough to fit everything");
  for (const width of [30, 52]) {
    const clipped = formatHud(snapshotWith(saturated), full, width).at(-1).text;
    assert.match(clipped, /sess\* limited\*/, `${width} columns keep the marker with any visible value`);
  }
  const zh = formatHud(snapshotWith(saturated), normalizeConfig({ usageScope: "session", preset: "full", color: false, showCost: false, language: "zh-CN" }), 40).at(-1).text;
  assert.match(zh, /全会话\* limited\* ↑90/);
  const ascii = formatHud(snapshotWith(saturated), normalizeConfig({ usageScope: "session", preset: "full", color: false, showCost: false, ascii: true }), 40).at(-1).text;
  assert.match(ascii, /sess\* limited\* in90/);
  // The footer usage row and the standalone cost field (balanced widget shows no token
  // field): whenever the saturated value is displayed, the marker is displayed first.
  const footerRow = formatFooter(snapshotWith(saturated), normalizeConfig({ usageScope: "session", preset: "balanced", color: false }), 56, EMPTY_IDENTITY)[1].text;
  assert.match(footerRow, /sess\* limited\* \$90/);
  const balancedRow = formatHud(snapshotWith(saturated), normalizeConfig({ usageScope: "session", preset: "balanced", color: false }), 46)[1].text;
  assert.match(balancedRow, /sess\* limited\* \$90/);
});

test("narrow widths keep the scope label and the incompleteness marker ahead of the counters", () => {
  const config = normalizeConfig({ usageScope: "session", preset: "full", color: false });
  const snapshot = snapshotWith(sessionView({ fieldsIncomplete: true, updating: true }));
  // Unconditional: at these widths the field is present (verified layout), so a
  // regression that loses the scope or the marker must fail instead of skipping.
  for (const width of [34, 40, 52]) {
    const row = formatHud(snapshot, config, width).at(-1).text;
    assert.match(row, /^sess\* ↻ \+\? /, `${width} columns keep the scope label and both markers first`);
  }
  // The markers must be adjacent to the label so right-edge truncation removes counters first.
  const field = sessionTokensField(snapshotWith(sessionView({ fieldsIncomplete: true, updating: true })), config, LABELS.en);
  const texts = field.segments.map((segment) => segment.text);
  assert.equal(texts[0].trim(), "sess*");
  assert.match(texts[1], /^↻ \+\? $/);
});

test("footer usage row carries the session field and status markers at narrow widths", () => {
  const config = normalizeConfig({ usageScope: "session", preset: "balanced", color: false });
  const snapshot = snapshotWith(sessionView({ fieldsIncomplete: true, updating: true }));
  const rows = formatFooter(snapshot, config, 120, EMPTY_IDENTITY).map((row) => row.text);
  assert.match(rows[1], /sess\*/);
  assert.match(rows[1], /\+\?/);
  // Unconditional: at 46 columns the token field folds, and the cost field must still
  // carry the session scope plus both status markers (verified layout, no skip path).
  const narrow = formatFooter(snapshot, config, 46, EMPTY_IDENTITY).map((row) => row.text);
  assert.match(narrow[1], /sess\* ↻ \+\? \$0\.420/, "the folded-row cost field stays self-describing");
});

test("empty ready session hides the token counters instead of showing zero totals", () => {
  const config = normalizeConfig({ usageScope: "session", preset: "full", color: false });
  const empty = sessionView({ status: "ready", usageRecords: 0, examined: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false });
  const rows = formatHud(snapshotWith(empty), config, 120);
  const text = rows.map((row) => row.text).join("\n");
  assert.ok(!/sess\* [↑i]/.test(text), "a known-empty session shows no session token counters");
  assert.match(text, /sess\* \?/, "its unknown cost stays honestly unknown");
  const loading = formatHud(snapshotWith(sessionView({ status: "loading" })), config, 120);
  assert.match(loading.at(-1).text, /sess\* \?/, "loading stays visible even before any record exists");
});

test("a session-scope config file activates the ledger after the deferred startup read", async () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(5));
  const host = fakeHost("tui", { usageManager: manager });
  const clock = new FakeClock();
  const controller = new HudController(host.pi, {
    loadOnStart: true, env: {},
    now: clock.now, monotonic: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    configLoader: async () => ({ config: { ...DEFAULT_CONFIG, usageScope: "session" }, found: true }),
  });
  controller.handle("session_start", {}, host.ctx);
  assert.equal(controller.ledger.active, false, "before the read the in-memory default (observed) applies");
  clock.advance(0);
  await Promise.resolve(); await Promise.resolve();
  clock.advance(0);
  assert.equal(controller.config.usageScope, "session");
  assert.equal(controller.ledger.view().input, 5, "the scope switch rebuilt from the manager");
  controller.handle("session_shutdown", {});
  const broken = fakeHost("tui", { usageManager: manager });
  const failing = new HudController(broken.pi, {
    loadOnStart: true, env: {}, now: clock.now, monotonic: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    configLoader: async () => { throw new Error("bad config"); },
  });
  failing.handle("session_start", {}, broken.ctx);
  clock.advance(0); await Promise.resolve(); await Promise.resolve(); clock.advance(0);
  assert.equal(failing.config.usageScope, "observed", "a failed read keeps the previous default");
  assert.equal(failing.ledger.view(), null);
  failing.handle("session_shutdown", {});
});

test("an unavailable ledger retries capture only through a lifecycle event, never a timer", () => {
  const manager = {
    ready: false,
    calls: 0,
    getEntries() { if (!this.ready) throw new Error("not yet"); this.calls++; return [{ id: "e1", parentId: null, type: "message", message: assistantEntry(2) }]; },
    getEntry(id) { return id === "e1" ? { id: "e1", parentId: null, type: "message", message: assistantEntry(2) } : undefined; },
    getLeafId() { return this.ready ? "e1" : null; },
    getSessionId() { return "late"; },
  };
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  f.clock.step();
  assert.equal(f.ledger.inspect().status, "unavailable");
  assert.equal(f.clock.pending, 0, "unavailable schedules nothing on its own");
  manager.ready = true;
  f.ledger.onStructural("tree"); // a lifecycle event is the documented retry path
  drain(f);
  const view = f.ledger.view();
  assert.equal(view.input, 2, "the retried capture succeeds");
  assert.equal(view.status, "ready");
});

test("a hostile entry surface degrades to unavailable instead of throwing into a timer", () => {
  const bomb = {
    get type() { throw new Error("hostile getter"); },
    parentId: null,
  };
  const manager = {
    getEntries: () => [bomb],
    getEntry: () => undefined,
    getLeafId: () => null,
    getSessionId: () => "hostile",
  };
  const f = ledgerFixture({ manager });
  f.ledger.restart(manager, "test");
  assert.doesNotThrow(() => drain(f, 4));
  assert.equal(f.ledger.view(), null, "the ledger degrades instead of crashing");
  const diag = f.ledger.inspect();
  assert.equal(diag.status, "unavailable");
  assert.equal(f.clock.pending, 0);
});

test("/hud scope command and status diagnostics round-trip", async () => {
  const manager = new FakeSessionManager();
  manager.appendMessage(assistantEntry(1));
  const f = controllerFixture({ usageManager: manager });
  await f.controller.command("scope session", f.ctx);
  assert.equal(f.controller.config.usageScope, "session");
  await f.controller.command("scope bogus", f.ctx);
  assert.equal(f.controller.config.usageScope, "session", "unknown values change nothing");
  f.clock.advance(0);
  const status = f.controller.inspect();
  assert.equal(status.usageScope, "session");
  assert.equal(status.sessionUsage.scope, "session");
  assert.equal(status.sessionUsage.status, "ready");
  assert.equal(status.sessionUsage.publishedEntries, 1);
  assert.equal(status.sessionUsage.hostCalls.getEntries, 1);
  // Published totals let a real-host verification compare with an independent oracle.
  assert.deepEqual(status.sessionUsage.totals, {
    input: 1, output: 2, cacheRead: 3, cacheWrite: 4,
    cost: 0.01, costKnown: 1, costMissing: 0,
  });
  assert.equal(status.sessionUsage.totals !== null, true, "an active ledger publishes totals");
  await f.controller.command("scope observed", f.ctx);
  assert.equal(f.controller.inspect().sessionUsage.status, "inactive", "scope exit deactivates the ledger");
  assert.equal(f.controller.inspect().sessionUsage.totals, null, "scope exit drops the published totals");
  await f.controller.command("scope session", f.ctx);
  assert.match(status.coverage.counters, /session ledger totals/);
  f.emit("session_shutdown");
});
