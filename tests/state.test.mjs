import test from "node:test";
import assert from "node:assert/strict";
import { HudState, LIMITS } from "../src/state.ts";
import { assistant, MODEL } from "./helpers.mjs";

function state() { return new HudState("/tmp/example", MODEL, 100); }

test("fresh attachment has unknown context, not a fictional 0 percent", () => {
  const s = state(); assert.equal(s.contextTokens, null); assert.equal(s.contextWindow, 200_000); assert.equal(s.costReports, 0);
});
test("usage counters stay split: input never absorbs the cache counters", () => {
  const s = state(); s.messageEnd(assistant(), 200);
  assert.equal(s.input, 1_000); assert.equal(s.output, 300);
  assert.equal(s.cacheRead, 2_000); assert.equal(s.cacheWrite, 400);
  // The context snapshot keeps its previous meaning: every prompt token plus the output.
  assert.equal(s.contextTokens, 3_700);
  assert.equal(s.cacheHit, 2_000 / 3_400);
  assert.equal(s.cost, 0.012);
  s.messageEnd(assistant(), 300);
  assert.equal(s.input, 2_000); assert.equal(s.output, 600);
  assert.equal(s.cacheRead, 4_000); assert.equal(s.cacheWrite, 800);
  assert.equal(s.contextTokens, 3_700); assert.equal(s.cost, 0.024);
  const snapshot = s.snapshot();
  assert.equal(snapshot.input + snapshot.cacheRead + snapshot.cacheWrite, 6_800, "no cache token is counted as fresh input twice");
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

// ---------------------------------------------------------------------------
// Cache-hit observation: numerator/denominator source and invalidation
// ---------------------------------------------------------------------------

test("cache-hit rate is the latest valid assistant's cacheRead over the prompt total", () => {
  const s = state();
  s.messageEnd(assistant(), 200);
  assert.equal(s.cacheHit, 2_000 / 3_400);
  s.messageEnd(assistant({ usage: { input: 0, output: 10, cacheRead: 900, cacheWrite: 100, cost: { total: 0 } } }), 300);
  assert.equal(s.cacheHit, 0.9, "the latest valid response replaces the previous rate");
});

test("cache-hit rate is unknown when the denominator is zero or the provider omits cache data", () => {
  const s = state();
  s.messageEnd(assistant({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }), 200);
  assert.equal(s.cacheHit, null, "a zero prompt total cannot be turned into 0%");
  s.messageEnd(assistant({ usage: { input: 50, output: 5 } }), 300);
  assert.equal(s.cacheHit, null, "missing cache counters are unknown, not a real zero");
  s.messageEnd(assistant({ usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }), 400);
  assert.equal(s.cacheHit, 0, "explicit zeros are a measured miss");
});

test("aborted and error responses never replace the last valid cache observation", () => {
  for (const reason of ["error", "aborted"]) {
    const s = state();
    s.messageEnd(assistant(), 200);
    s.messageEnd(assistant({ stopReason: reason, usage: { input: 7, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }), 300);
    assert.equal(s.contextTokens, null, `${reason}: partial context is not trustworthy`);
    assert.equal(s.cacheHit, 2_000 / 3_400, `${reason}: the last valid rate is preserved`);
    assert.equal(s.input, 1_007, `${reason}: reported usage still counts once`);
  }
});

test("model switch, compaction and reset drop a cache observation that no longer applies", () => {
  const byModel = state();
  byModel.messageEnd(assistant(), 200);
  byModel.setModel({ ...MODEL, id: "switched", contextWindow: 100_000 });
  assert.equal(byModel.cacheHit, null);

  const byCompaction = state();
  byCompaction.messageEnd(assistant(), 200);
  byCompaction.compact();
  assert.equal(byCompaction.cacheHit, null);

  const byReset = state();
  byReset.messageEnd(assistant(), 200);
  byReset.reset("/tmp/next", MODEL, 900);
  assert.equal(byReset.cacheHit, null);
});

test("the same model selection keeps the observation and a late response from the old model still counts", () => {
  const s = state();
  s.messageEnd(assistant(), 200);
  s.setModel(MODEL);
  assert.equal(s.cacheHit, 2_000 / 3_400, "selecting the same model invalidates nothing");
  s.setModel({ ...MODEL, id: "new-model", contextWindow: 8_000 });
  assert.equal(s.cacheHit, null);
  s.messageEnd(assistant({ model: MODEL.id, provider: MODEL.provider }), 300);
  assert.equal(s.cacheHit, null, "another model's cache behaviour never becomes the current model's rate");
  assert.equal(s.contextTokens, null);
  s.messageEnd(assistant({ model: "new-model", provider: MODEL.provider }), 400);
  assert.equal(s.cacheHit, 2_000 / 3_400, "a response from the selected model restores the observation");
  assert.equal(s.contextTokens, 3_700);
});

test("snapshot exposes split usage without recombining cache tokens into input", () => {
  const s = state();
  s.messageEnd(assistant(), 200);
  const snapshot = s.snapshot();
  assert.deepEqual(
    { input: snapshot.input, output: snapshot.output, cacheRead: snapshot.cacheRead, cacheWrite: snapshot.cacheWrite },
    { input: 1_000, output: 300, cacheRead: 2_000, cacheWrite: 400 },
  );
  assert.equal(snapshot.cacheHit, 2_000 / 3_400);
  assert.equal(snapshot.contextTokens, 3_700);
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

// ---------------------------------------------------------------------------
// Token speed: first-token bridge and per-message average (docs/TOKEN-SPEED.zh-CN.md)
// ---------------------------------------------------------------------------

import { MIN_SPEED_WINDOW_MS } from "../src/state.ts";

/** Drive one assistant message through the exact event protocol. */
function measured(s, { firstAt = 200, endAt = 10_000, output = 300, ...overrides } = {}) {
  s.messageStart({ role: "assistant" });
  if (firstAt !== null) s.messageUpdate({ type: "text_delta", delta: "H" }, firstAt);
  return s.messageEnd(assistant({ ...overrides, usage: { input: 1_000, output, cacheRead: 2_000, cacheWrite: 400, cost: { total: 0.012 } } }), endAt);
}

test("speed is the reported output over the first-token-to-end window", () => {
  const s = state();
  assert.equal(s.messageUpdate({ type: "text_delta", delta: "x" }, 100), false, "no message_start: ignored");
  assert.equal(measured(s, { firstAt: 2_000, endAt: 62_000, output: 3_000 }), true);
  assert.equal(s.speedRate, 50, "3,000 tokens over a 60s window");
  assert.equal(s.speedTokens, 3_000);
  assert.equal(s.speedMs, 60_000);
  assert.equal(s.snapshot().speedRate, 50);
});

test("the clock starts on the first content delta, never on block opens or empty deltas", () => {
  for (const [type, delta] of [["text_start", undefined], ["thinking_start", undefined], ["text_delta", ""], ["text_delta", undefined], ["done", undefined], ["error", undefined]]) {
    const s = state();
    s.messageStart({ role: "assistant" });
    assert.equal(s.messageUpdate({ type, delta }, 5_000), false, `${type} is not content`);
    measured(s, { firstAt: null, endAt: 20_000, output: 100 });
    assert.equal(s.speedRate, null, `${type} must not become a first token`);
  }
  const thinking = state();
  thinking.messageStart({ role: "assistant" });
  thinking.messageUpdate({ type: "thinking_delta", delta: "推理" }, 1_000);
  thinking.messageEnd(assistant(), 6_000);
  assert.equal(thinking.speedRate, 60, "thinking deltas count as generated tokens");

  const toolcall = state();
  toolcall.messageStart({ role: "assistant" });
  toolcall.messageUpdate({ type: "toolcall_delta", delta: "{\"" }, 1_000);
  toolcall.messageEnd(assistant(), 6_000);
  assert.equal(toolcall.speedRate, 60, "streamed tool-call parameters count too");
});

test("the bridge fuses after the first sample and never moves the timestamp", () => {
  const s = state();
  s.messageStart({ role: "assistant" });
  assert.equal(s.messageUpdate({ type: "text_delta", delta: "a" }, 1_000), true);
  assert.equal(s.messageUpdate({ type: "text_delta", delta: "b" }, 90_000), false, "fused: ignored");
  assert.equal(s.messageUpdate({ type: "text_delta", delta: "c" }, 95_000), false);
  s.messageEnd(assistant(), 91_000);
  assert.equal(s.speedMs, 90_000, "the window still ends at the first sample");
});

test("guards keep a discarded measurement from overwriting the previous valid value", () => {
  const guards = {
    "no first token": (s) => measured(s, { firstAt: null, endAt: 5_000 }),
    "error stop": (s) => measured(s, { stopReason: "error", endAt: 5_000 }),
    "aborted stop": (s) => measured(s, { stopReason: "aborted", endAt: 5_000 }),
    "zero output": (s) => measured(s, { output: 0, endAt: 5_000 }),
    "short window": (s) => measured(s, { firstAt: 2_000, endAt: 2_000 + MIN_SPEED_WINDOW_MS - 1 }),
    "model mismatch": (s) => measured(s, { model: "other", endAt: 5_000 }),
  };
  for (const [name, run] of Object.entries(guards)) {
    const s = state();
    measured(s, { firstAt: 2_000, endAt: 62_000, output: 3_000 });
    assert.equal(s.speedRate, 50, `${name}: baseline`);
    run(s);
    assert.equal(s.speedRate, 50, `${name}: previous value stays`);
  }
});

test("missing usage, non-assistant ends and interleaved starts never produce a rate", () => {
  const s = state();
  s.messageStart({ role: "assistant" });
  assert.equal(s.messageEnd({ role: "assistant" }, 5_000), false, "no usage object at all");
  assert.equal(s.speedRate, null);
  // A toolResult message_end while armed: protocol says this cannot happen; state disarms.
  s.messageStart({ role: "assistant" });
  s.messageUpdate({ type: "text_delta", delta: "x" }, 1_000);
  s.messageStart({ role: "toolResult" });
  assert.equal(s.messageEnd(assistant(), 8_000), true, "usage still counts");
  assert.equal(s.speedRate, null, "the broken pairing published no speed");
  // Usage-less messages keep the meaning of messageEnd's return value.
  assert.equal(s.messageEnd({ role: "user" }, 9_000), false);
});

test("reset and model switch drop the speed observation; compaction keeps it", () => {
  const byReset = state();
  measured(byReset, { firstAt: 2_000, endAt: 62_000, output: 3_000 });
  byReset.reset("/tmp/next", MODEL, 900);
  assert.equal(byReset.speedRate, null);

  const byModel = state();
  measured(byModel, { firstAt: 2_000, endAt: 62_000, output: 3_000 });
  byModel.setModel({ ...MODEL, id: "switched", contextWindow: 100_000 });
  assert.equal(byModel.speedRate, null, "another model's speed is not the new model's");
  byModel.setModel(MODEL);
  assert.equal(byModel.speedRate, null, "switching back does not resurrect the old sample");

  const byCompaction = state();
  measured(byCompaction, { firstAt: 2_000, endAt: 62_000, output: 3_000 });
  byCompaction.compact();
  assert.equal(byCompaction.speedRate, 50, "compaction changes the prompt, not the generation speed");
});

test("each assistant message is measured independently; the display shows the newest", () => {
  const s = state();
  measured(s, { firstAt: 2_000, endAt: 62_000, output: 3_000 });
  measured(s, { firstAt: 70_000, endAt: 130_000, output: 1_500 });
  assert.equal(s.speedRate, 25, "the latest message replaces the previous sample");
});

test("malformed stream events cannot arm, throw or fuse", () => {
  const s = state();
  s.messageStart({ role: "assistant" });
  for (const bad of [undefined, {}, { type: 7 }, { type: "text_delta" }, { type: "text_delta", delta: 5 }]) {
    assert.equal(s.messageUpdate(bad, 1_000), false);
  }
  assert.equal(s.firstTokenAt, null, "nothing fused");
  s.messageUpdate({ type: "thinking_delta", delta: "ok" }, 1_500);
  s.messageEnd(assistant(), 61_500);
  assert.equal(s.speedRate, 5);
});
