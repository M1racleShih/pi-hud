/**
 * Pinned-SDK runtime oracle for the optional full-session usage ledger (phase 3 B2a).
 *
 * Unlike `tests/usage.test.mjs` (in-repo fixtures + an independent reducer), this script
 * runs the ledger against the REAL pinned `SessionManager` from the isolated
 * `.tmp/sdk` install and compares the published totals with the SDK's own
 * `createUsageTotals`/`addUsageToTotals` under the native footer's four-category rule.
 * It transcribes the B1 probe (`.tmp/sdk/b1-probe.mjs`) into a reproducible check and
 * adds the B2a lifecycle matrix. Requires the network-enabled pinned environment:
 *
 *   npm install --prefix .tmp/sdk --ignore-scripts --no-audit --no-fund --save-exact \
 *     @earendil-works/pi-coding-agent@0.85.1
 *   node scripts/usage-oracle-check.mjs
 *
 * No network, model, provider credentials or file persistence are involved: every manager
 * is `SessionManager.inMemory`.
 */
import assert from "node:assert/strict";
import { SessionUsageLedger } from "../src/usage.ts";
import { SessionManager } from "../.tmp/sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { createUsageTotals, addUsageToTotals } from "../.tmp/sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/usage-totals.js";

const usage = (n) => ({
  input: n, output: n * 2, cacheRead: n * 3, cacheWrite: n * 4, totalTokens: n * 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: n / 100 },
});
const assistant = (n, extra = {}) => ({
  role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "fixture",
  usage: usage(n), stopReason: "stop", timestamp: 0, ...extra,
});
const toolResult = (n) => ({
  role: "toolResult", toolCallId: "fixture", toolName: "fixture", content: [], isError: false,
  timestamp: 0, usage: usage(n),
});

/** The SDK's own aggregation over its own scoping rule: the strongest available oracle. */
function sdkOracle(manager) {
  const totals = createUsageTotals();
  for (const entry of manager.getEntries()) {
    let u;
    if (entry.type === "message" && ["assistant", "toolResult"].includes(entry.message.role)) u = entry.message.usage;
    else if (["compaction", "branch_summary"].includes(entry.type)) u = entry.usage;
    if (u) addUsageToTotals(totals, u);
  }
  return totals;
}

/** Run the real event loop until the ledger has no planned or active task left. */
async function quiet(ledger) {
  for (let index = 0; index < 100_000; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!ledger.busy()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!ledger.busy()) return;
    }
  }
  assert.fail("the ledger never reached a quiet state");
}

const compare = (label, ledger, manager) => {
  const view = ledger.view();
  const oracle = sdkOracle(manager);
  assert.ok(view, `${label}: a view must be published`);
  assert.ok(!ledger.busy(), `${label}: the ledger must be quiet when compared`);
  assert.equal(view.input, oracle.input, `${label}: input`);
  assert.equal(view.output, oracle.output, `${label}: output`);
  assert.equal(view.cacheRead, oracle.cacheRead, `${label}: cacheRead`);
  assert.equal(view.cacheWrite, oracle.cacheWrite, `${label}: cacheWrite`);
  assert.ok(Math.abs(view.cost - oracle.cost) < 1e-9, `${label}: cost`);
};

// ---------------------------------------------------------------------------
// 1. The B1 probe history: all four record kinds, repeated summary text, tree switch.
// ---------------------------------------------------------------------------
{
  const manager = SessionManager.inMemory("/tmp/pi-hud-b2a-probe");
  const a = manager.appendMessage(assistant(1));
  manager.appendMessage(toolResult(2));
  manager.appendCompaction("same-summary", a, 100, undefined, false, usage(3));
  manager.appendMessage(assistant(4));
  manager.branchWithSummary(a, "branch", undefined, false, usage(5));
  manager.appendCompaction("same-summary", a, 100, undefined, false, usage(6));
  const ledger = new SessionUsageLedger({});
  ledger.restart(manager, "probe");
  await quiet(ledger);
  compare("probe history", ledger, manager);
  // The same-summary find in the SDK can select the old compaction record; the ledger
  // rebuilds from the manager, so both records are folded in exactly once.
  const view = ledger.view();
  assert.equal(view.usageRecords, 6);
  assert.equal(view.status, "ready");
  assert.equal(manager.getBranch().length, 3, "the active branch is a subset; totals stay full-history");
  // Steady state: appending one message reconciles through the cursor walk only.
  manager.appendMessage(assistant(7));
  ledger.onMessageEnd();
  ledger.requestVerify();
  await quiet(ledger);
  compare("after increment", ledger, manager);
  const diag = ledger.inspect();
  assert.equal(diag.hostCalls.getEntries, 1, "increments never call getEntries");
  ledger.dispose();
}

// ---------------------------------------------------------------------------
// 2. Session replacement, structural rebuilds and scope exit on the real manager.
// ---------------------------------------------------------------------------
{
  const first = SessionManager.inMemory("/tmp/pi-hud-b2a-first");
  first.appendMessage(assistant(2));
  const second = SessionManager.inMemory("/tmp/pi-hud-b2a-second");
  second.appendMessage(toolResult(3));
  second.appendCompaction("c", second.getLeafId(), 10, undefined, false, usage(4));
  const ledger = new SessionUsageLedger({});
  ledger.restart(first, "session-start");
  await quiet(ledger);
  compare("first session", ledger, first);
  ledger.restart(second, "session-start");
  await quiet(ledger);
  compare("second session", ledger, second);
  assert.equal(ledger.view().usageRecords, 2, "no totals leaked from the first session");
  // Compaction invalidates and rebuilds; the pre-compaction totals survive.
  const before = ledger.view().input;
  const leaf = second.getLeafId();
  second.appendMessage(assistant(5));
  second.appendCompaction("c2", leaf, 10, undefined, false, usage(1));
  ledger.onStructural("compact");
  await quiet(ledger);
  compare("after compaction", ledger, second);
  assert.ok(ledger.view().input > before, "compaction keeps the pre-compaction cumulative totals");
  ledger.deactivate();
  assert.equal(ledger.view(), null, "scope exit releases the snapshot");
}

// ---------------------------------------------------------------------------
// 3. Tree navigation strands the cursor on the real manager: recovery rebuild keeps
//    the totals equal to the full-history oracle (never a branch-only aggregate).
// ---------------------------------------------------------------------------
{
  const manager = SessionManager.inMemory("/tmp/pi-hud-b2a-tree");
  const root = manager.appendMessage(assistant(1));
  manager.appendMessage(assistant(2));
  const ledger = new SessionUsageLedger({});
  ledger.restart(manager, "tree");
  await quiet(ledger);
  compare("before tree switch", ledger, manager);
  // Manager-level tree navigation (what AgentSession.navigateTree drives): the leaf moves
  // without any event reaching the HUD first, so the cursor is stranded on the old path.
  manager.branch(root);
  manager.appendMessage(assistant(3));
  ledger.requestVerify(); // no session_tree event: the walk fails and recovers
  await quiet(ledger);
  compare("after stranded walk", ledger, manager);
  assert.ok(ledger.inspect().recoveryRebuilds >= 1, "the stranded walk recovered via one rebuild");
  ledger.dispose();
}

// ---------------------------------------------------------------------------
// 4. Tree navigation back to the root: resetLeaf() keeps history, nulls the leaf and
//    the next append becomes a new root entry. The null cursor must stay a legal
//    anchor and the root-level append must be counted exactly once (review fix 1).
// ---------------------------------------------------------------------------
{
  const manager = SessionManager.inMemory("/tmp/pi-hud-b2a-root");
  manager.appendMessage(assistant(1));
  const ledger = new SessionUsageLedger({});
  ledger.restart(manager, "start");
  await quiet(ledger);
  compare("before root navigation", ledger, manager);
  manager.resetLeaf();
  ledger.onStructural("tree");
  await quiet(ledger);
  const navigated = ledger.view();
  assert.equal(navigated.status, "ready", "a null leaf with history is Pi's documented re-edit state");
  assert.equal(ledger.inspect().failureReason, null);
  manager.appendMessage(assistant(2)); // parentId null: a new root entry
  ledger.onMessageEnd();
  ledger.requestVerify();
  await quiet(ledger);
  compare("after root re-append", ledger, manager);
  assert.equal(ledger.view().input, 3, "1 (history) + 2 (new root) with no double count");
  assert.equal(ledger.view().updating, false);
  ledger.dispose();
}

// ---------------------------------------------------------------------------
// 5. An over-cap append burst during baseline slicing: the failed catch-up must
//    recover through one rebuild instead of leaving the totals frozen (review fix 2).
// ---------------------------------------------------------------------------
{
  const manager = SessionManager.inMemory("/tmp/pi-hud-b2a-burst");
  manager.appendMessage(assistant(1));
  manager.appendMessage(assistant(1));
  const ledger = new SessionUsageLedger({ chunkEntries: 1 });
  ledger.restart(manager, "start");
  await new Promise((resolve) => setTimeout(resolve, 0)); // capture + first slice
  assert.ok(ledger.busy(), "the baseline is still slicing");
  for (let index = 0; index < 2049; index++) manager.appendMessage(assistant(1));
  ledger.onMessageEnd();
  ledger.requestVerify(); // swallowed by the running baseline
  await quiet(ledger);
  compare("after the burst recovery", ledger, manager);
  assert.equal(ledger.view().input, 2 + 2049);
  assert.ok(ledger.inspect().recoveryRebuilds >= 1, "the catch-up failure scheduled a rebuild");
  assert.equal(ledger.inspect().failureReason, null, "the recovered full read clears the failure");
  ledger.dispose();
}

console.log("PASS: pinned Pi 0.85.1 SessionManager oracle agrees with the session usage ledger");
