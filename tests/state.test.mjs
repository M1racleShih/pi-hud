import test from "node:test";
import assert from "node:assert/strict";
import { HudState, LIMITS } from "../src/state.ts";
import { assistant, MODEL } from "./helpers.mjs";

function state() { return new HudState("/tmp/example", MODEL, 100); }

test("fresh attachment has unknown context, not a fictional 0 percent", () => {
  const s = state(); assert.equal(s.contextTokens, null); assert.equal(s.contextWindow, 200_000); assert.equal(s.costReports, 0);
});
test("context includes input, both caches and output exactly once", () => {
  const s = state(); s.messageEnd(assistant(), 200);
  assert.equal(s.contextTokens, 3_700); assert.equal(s.input, 3_400); assert.equal(s.output, 300); assert.equal(s.cost, 0.012);
  s.messageEnd(assistant(), 300);
  assert.equal(s.contextTokens, 3_700); assert.equal(s.input, 6_800); assert.equal(s.cost, 0.024);
});
for (const reason of ["error", "aborted"]) {
  test(`${reason} invalidates possibly partial context but preserves reported spend`, () => {
    const s = state(); s.messageEnd(assistant({ stopReason: reason }), 200);
    assert.equal(s.contextTokens, null); assert.equal(s.cost, 0.012);
  });
}
test("unknown and malformed usage cannot produce NaN, negative or infinite metrics", () => {
  const s = state();
  s.messageEnd(assistant({ usage: { input: NaN, cacheRead: -4, output: Infinity, cost: { total: "7" } } }), 200);
  assert.equal(s.contextTokens, null); assert.equal(s.input, 0); assert.equal(s.costReports, 0);
  assert.equal(s.messageEnd({ role: "user" }, 300), false);
  assert.equal(s.messageEnd({ role: "assistant" }, 300), false);
});
test("compaction and model selection invalidate context without erasing observed costs", () => {
  const s = state(); s.messageEnd(assistant(), 200); s.compact();
  assert.equal(s.contextTokens, null); assert.equal(s.compactions, 1); assert.equal(s.cost, 0.012);
  s.messageEnd(assistant(), 300); s.setModel({ ...MODEL, id: "other", contextWindow: 100_000 });
  assert.equal(s.contextTokens, null); assert.equal(s.cost, 0.024);
});
test("tool identity handles concurrency, errors and repeated recent end events", () => {
  const s = state();
  for (const id of ["a", "b"]) s.startTool({ toolCallId: id, toolName: "read", args: { path: "/secret/work/file.ts" } });
  assert.equal(s.tools.size, 2); assert.deepEqual(s.snapshot().activeTools, ["read file.ts", "read file.ts"]);
  s.endTool({ toolCallId: "b", toolName: "read", isError: true });
  s.endTool({ toolCallId: "a", toolName: "read", isError: false });
  assert.equal(s.endTool({ toolCallId: "a", toolName: "read" }), false);
  assert.equal(s.done, 1); assert.equal(s.errors, 1); assert.equal(s.tools.size, 0);
});
test("tools never inspect bash commands, tool result payloads, or assistant text", () => {
  const s = state();
  const bomb = () => { throw new Error("Payload content was touched"); };
  s.startTool({ toolCallId: "a", toolName: "bash", args: Object.defineProperty({}, "command", { get: bomb }) });
  s.endTool(Object.defineProperty({ toolCallId: "a", toolName: "bash" }, "result", { get: bomb }));
  s.messageEnd(Object.defineProperty(assistant(), "content", { get: bomb }), 100);
  assert.equal(s.done, 1);
});
test("tool maps, dedup IDs and visible activity stay bounded under a flood", () => {
  const s = state();
  for (let i = 0; i < 10_000; i++) s.startTool({ toolCallId: String(i), toolName: "x".repeat(100_000) });
  assert.equal(s.tools.size, LIMITS.tools); assert.equal(s.snapshot().activeTools.length, 3); assert.ok(s.dropped > 0);
  for (let i = 0; i < 10_000; i++) s.endTool({ toolCallId: String(i), toolName: "read" });
  assert.equal(s.tools.size, 0); assert.equal(s.recentIds.size, LIMITS.recentIds); assert.equal(s.done, 10_000);
});
test("invalid identity cannot fill the active map", () => {
  const s = state();
  for (const id of [undefined, 12, "", "a".repeat(161)]) s.startTool({ toolCallId: id, toolName: "read" });
  assert.equal(s.tools.size, 0); assert.equal(s.dropped, 4);
});
test("settled run clears interrupted active tools without crediting success", () => {
  const s = state(); s.startTool({ toolCallId: "a", toolName: "bash" }); s.phase = "working"; s.settle();
  assert.equal(s.phase, "idle"); assert.equal(s.tools.size, 0); assert.equal(s.done, 0); assert.equal(s.interrupted, 1);
});
test("bridge validates version, identity, TTL, kind and task counts", () => {
  const s = state();
  const good = { version: 1, kind: "tasks", source: "test", id: "one", label: "Build HUD", completed: 2, total: 5 };
  assert.equal(s.bridge(good, 100), true);
  for (const changed of [{ version: 2 }, { source: "bad source" }, { id: "" }, { completed: 7 }, { total: -1 }, { ttlMs: 1 }, { kind: "unknown" }, { completed: "2" }]) {
    assert.equal(s.bridge({ ...good, ...changed }, 100), false);
  }
  assert.equal(s.snapshot().taskDone, 2); assert.equal(s.snapshot().taskTotal, 5);
});
test("bridge channels are source-scoped, bounded and expire", () => {
  const s = state();
  for (let i = 0; i < 100; i++) s.bridge({ version: 1, kind: "agent", source: "one", id: String(i), status: "running", label: "worker", ttlMs: 1_000 }, 0);
  for (let i = 0; i < 100; i++) s.bridge({ version: 1, kind: "tasks", source: "two", id: String(i), completed: 0, total: 1, ttlMs: 1_000 }, 0);
  assert.equal(s.agents.size, LIMITS.agents); assert.equal(s.tasks.size, LIMITS.tasks);
  s.bridge({ version: 1, kind: "clear", source: "one" }, 100);
  assert.equal(s.agents.size, 0); assert.equal(s.tasks.size, LIMITS.tasks);
  assert.equal(s.nextExpiry(), 1_000); s.prune(1_000);
  assert.equal(s.tasks.size, 0); assert.equal(s.nextExpiry(), Infinity);
});
test("reset starts a new honest observation epoch and drops all old counters", () => {
  const s = state(); s.messageEnd(assistant(), 200); s.compact();
  s.reset("/tmp/new", MODEL, 500);
  assert.equal(s.since, 500); assert.equal(s.cost, 0); assert.equal(s.contextTokens, null); assert.equal(s.compactions, 0); assert.equal(s.project, "new");
});

test("late response from previous model counts usage but not current context", () => {
  const state = new HudState("/tmp/project", MODEL, 0);
  state.messageEnd(assistant({ model: MODEL.id, provider: MODEL.provider }), 1);
  assert.equal(state.contextTokens, 3_700);
  state.setModel({ ...MODEL, id: "new-model", contextWindow: 8_000 });
  state.messageEnd(assistant({ model: MODEL.id, provider: MODEL.provider }), 2);
  assert.equal(state.contextTokens, null);
  assert.equal(state.output, 600);
  state.messageEnd(assistant({ model: "new-model", provider: MODEL.provider }), 3);
  assert.equal(state.contextTokens, 3_700);
});

// ---------------------------------------------------------------------------
// Phase 2: bounded tool categories
// ---------------------------------------------------------------------------

test("tool categories count only real completions and keep success, failure and interruption apart", () => {
  const s = state();
  for (let i = 0; i < 3; i++) s.startTool({ toolCallId: `bash-${i}`, toolName: "bash" });
  assert.deepEqual(s.snapshot().toolCategories, [], "starting a tool is not a completion");
  assert.equal(s.endTool({ toolCallId: "bash-0", toolName: "bash" }), true);
  assert.equal(s.endTool({ toolCallId: "bash-1", toolName: "bash", isError: true }), true);
  assert.equal(s.endTool({ toolCallId: "bash-0", toolName: "bash" }), false, "a duplicate completion event is ignored");
  assert.deepEqual(s.snapshot().toolCategories, [{ name: "bash", ok: 1, error: 1, interrupted: 0 }]);
  assert.equal(s.done, 1); assert.equal(s.errors, 1); assert.equal(s.interrupted, 0);
  s.settle();
  assert.deepEqual(s.snapshot().toolCategories, [{ name: "bash", ok: 1, error: 1, interrupted: 1 }]);
  assert.equal(s.done, 1, "an interrupted tool is never credited as a success");
  assert.equal(s.errors, 1); assert.equal(s.interrupted, 1);
});

test("concurrent tool instances share one category and never double count", () => {
  const s = state();
  for (const id of ["a", "b", "c"]) s.startTool({ toolCallId: id, toolName: "read", args: { path: "/tmp/dir/file.ts" } });
  assert.equal(s.snapshot().activeCount, 3);
  s.endTool({ toolCallId: "a", toolName: "read" });
  s.endTool({ toolCallId: "b", toolName: "read", isError: true });
  s.endTool({ toolCallId: "c", toolName: "read" });
  assert.deepEqual(s.snapshot().toolCategories, [{ name: "read", ok: 2, error: 1, interrupted: 0 }]);
  assert.equal(s.done, 2); assert.equal(s.errors, 1);
});

test("unknown, empty and oversized tool names still get a bounded safe category", () => {
  const s = state();
  for (const [id, name] of [["u1", "made-up-tool"], ["u2", undefined], ["u3", "x".repeat(100_000)], ["u4", "\u001b[31mweird\u001b[0m name"]]) {
    s.startTool({ toolCallId: id, toolName: name });
    s.endTool({ toolCallId: id, toolName: name });
  }
  assert.deepEqual(s.snapshot().toolCategories.map((item) => item.name), ["made-up-tool", "tool", "x".repeat(48), "weird name"]);
});

test("category retention is capped at 16 names plus one merged other bucket", () => {
  const s = state();
  for (let i = 0; i < 40; i++) {
    s.startTool({ toolCallId: `c${i}`, toolName: `tool-${i}` });
    s.endTool({ toolCallId: `c${i}`, toolName: `tool-${i}` });
  }
  const categories = s.snapshot().toolCategories;
  assert.equal(s.toolStats.size, LIMITS.toolCategories);
  assert.equal(categories.filter((item) => !item.merged).length, LIMITS.toolCategories);
  const merged = categories.filter((item) => item.merged);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "other");
  assert.equal(merged[0].ok, 40 - LIMITS.toolCategories);
  assert.equal(categories.reduce((total, item) => total + item.ok, 0), 40);
  // A retained name keeps updating after the cap was reached.
  s.startTool({ toolCallId: "again", toolName: "tool-0" });
  s.endTool({ toolCallId: "again", toolName: "tool-0" });
  assert.equal(s.snapshot().toolCategories.find((item) => item.name === "tool-0").ok, 2);
  assert.equal(s.toolStats.size, LIMITS.toolCategories, "the per-name ledger never grows past the cap");
});

test("a real tool named other keeps its own counters and never becomes the overflow bucket", () => {
  const s = state();
  for (const id of ["real-1", "real-2"]) {
    s.startTool({ toolCallId: id, toolName: "other" });
    s.endTool({ toolCallId: id, toolName: "other" });
  }
  for (let i = 0; i < 20; i++) {
    s.startTool({ toolCallId: `x${i}`, toolName: `tool-${i}` });
    s.endTool({ toolCallId: `x${i}`, toolName: `tool-${i}` });
  }
  const categories = s.snapshot().toolCategories;
  const real = categories.find((item) => item.name === "other" && !item.merged);
  const merged = categories.find((item) => item.merged);
  assert.ok(real, "the real `other` tool keeps a retained category");
  assert.ok(merged, "unrelated names still get the separate synthetic bucket");
  assert.equal(real.ok, 2);
  assert.equal(merged.name, "other");
  // 21 distinct names total: the real `other` plus tool-0..tool-19. The first 16 are
  // retained (`other` and tool-0..tool-14), so only tool-15..tool-19 merge.
  assert.equal(merged.ok, 5);
  assert.equal(categories.reduce((total, item) => total + item.ok, 0), 22);
  assert.equal(s.toolStats.size, LIMITS.toolCategories);
  // Another real `other` completion must not land in the synthetic bucket.
  s.startTool({ toolCallId: "real-3", toolName: "other" });
  s.endTool({ toolCallId: "real-3", toolName: "other" });
  assert.equal(s.snapshot().toolCategories.find((item) => item.name === "other" && !item.merged).ok, 3);
  assert.equal(s.snapshot().toolCategories.find((item) => item.merged).ok, 5);
});

test("interrupted categories are bounded by the active-tool cap and never counted as starts", () => {
  const s = state();
  for (let i = 0; i < LIMITS.tools + 20; i++) s.startTool({ toolCallId: `t${i}`, toolName: "bash" });
  s.settle();
  assert.deepEqual(s.snapshot().toolCategories, [{ name: "bash", ok: 0, error: 0, interrupted: LIMITS.tools }]);
  assert.equal(s.done, 0); assert.equal(s.errors, 0); assert.equal(s.interrupted, LIMITS.tools);
});


test("file targets are sanitized basenames and non-file tool arguments are never inspected", () => {
  const s = state();
  s.startTool({ toolCallId: "a", toolName: "edit", args: { path: "/tmp/fi\u001b[31mle\u001b[0m.ts" } });
  s.startTool({ toolCallId: "b", toolName: "read", args: { path: `/very/deep/${"d/".repeat(200)}file.ts` } });
  s.startTool({ toolCallId: "c", toolName: "bash", args: Object.defineProperty({}, "command", { get() { throw new Error("shell commands must never be read"); } }) });
  assert.deepEqual(s.snapshot().activeTools, ["edit file.ts", "read file.ts", "bash"]);
  s.startTool({ toolCallId: "long", toolName: "read", args: { path: `/tmp/${"目".repeat(60)}.ts` } });
  assert.equal(s.tools.get("long").target.length, 36, "a long basename is capped by the existing length limit");
  s.endTool({ toolCallId: "a", toolName: "edit" });
});

test("reset and a late settle cannot revive activity from the previous epoch", () => {
  const s = state();
  s.startTool({ toolCallId: "a", toolName: "bash" });
  s.endTool({ toolCallId: "a", toolName: "bash" });
  s.startTool({ toolCallId: "b", toolName: "edit", args: { path: "/tmp/x.ts" } });
  assert.equal(s.toolStats.size, 1);
  s.reset("/tmp/next", MODEL, 900);
  assert.equal(s.toolStats.size, 0);
  assert.deepEqual(s.snapshot().toolCategories, []);
  s.settle();
  assert.deepEqual(s.snapshot().toolCategories, [], "a late settle must not credit the old epoch");
});
