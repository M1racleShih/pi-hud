import test from "node:test";
import assert from "node:assert/strict";
import { HudState, LIMITS } from "../src/state.mjs";
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
