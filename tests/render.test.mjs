import test from "node:test";
import assert from "node:assert/strict";
import { clip, safeText, baseName, visibleWidth } from "../src/text.ts";
import { normalizeConfig } from "../src/config.ts";
import { HudState } from "../src/state.ts";
import { HudView, formatHud } from "../src/render.ts";
import { MODEL, assistant } from "./helpers.mjs";

const snapshot = () => {
  const state = new HudState("/tmp/中文项目", { ...MODEL, name: "测试 Model 👩‍💻" }, 0);
  state.messageEnd(assistant(), 1);
  state.startTool({ toolCallId: "a", toolName: "read", args: { path: "/tmp/中文文件.ts" } });
  state.bridge({ version: 1, kind: "tasks", source: "test", id: "task", completed: 1, total: 3, label: "验证组合字符 é" }, 0);
  return state.snapshot();
};

test("terminal control, OSC clipboard, hyperlinks, C1 and bidi injection are stripped", () => {
  for (const value of ["\x1b[31mred\x1b[0m", "\x1b]52;c;PAYLOAD\x07label", "\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\", "\x9b31mred", "text\r\nnext", "a\u202eb\u2066c"]) {
    assert.doesNotMatch(safeText(value), /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  }
  assert.equal(safeText("\x1b]52;c;PAYLOAD\x07label"), "label");
});
test("strings are bounded before sanitizing, and no raw surrogate is introduced", () => {
  assert.equal(safeText("x".repeat(1_000_000), 80).length, 80);
  assert.equal(safeText("😀", 1), "");
  assert.equal(baseName("C:\\work\\file.ts"), "file.ts");
});
for (const [text, cells] of [["abc", 3], ["中文", 4], ["e\u0301", 1], ["😀", 2], ["👩‍💻", 2], ["🇨🇳", 2], ["1️⃣", 2]]) {
  test(`terminal-cell width for ${text}`, () => assert.equal(visibleWidth(text), cells));
}
test("clipping does not split grapheme clusters", () => {
  assert.equal(clip("👩‍💻hello", 3), "👩‍💻…");
  assert.equal(clip("éhello", 2), "é…");
  assert.equal(clip("中文", 1), "…");
  assert.equal(clip("anything", 0), "");
});
for (const language of ["en", "zh-CN"]) for (const preset of ["minimal", "balanced", "full"]) {
  test(`${language}/${preset}: fixed row count and width safety at every width 0..180`, () => {
    const config = normalizeConfig({ language, preset });
    const s = snapshot();
    for (let width = 0; width <= 180; width++) {
      const rows = formatHud(s, config, width);
      assert.equal(rows.length, { minimal: 1, balanced: 2, full: 3 }[preset]);
      for (const row of rows) assert.ok(visibleWidth(row.text) <= width, `${width}: ${row.text}`);
    }
  });
}
test("unknown context is explicitly unknown", () => {
  const s = snapshot(); s.contextTokens = null;
  assert.match(formatHud(s, normalizeConfig(), 100)[0].text, /ctx\(last\) \?/);
  assert.doesNotMatch(formatHud(s, normalizeConfig(), 100)[0].text, /0%/);
});
test("context overflow does not create an oversized progress bar", () => {
  const s = snapshot(); s.contextTokens = Number.MAX_SAFE_INTEGER; s.contextWindow = 1;
  const row = formatHud(s, normalizeConfig(), 100)[0];
  assert.equal(row.tone, "error"); assert.match(row.text, />999%/); assert.ok(visibleWidth(row.text) <= 100);
});
test("cached render is object-identical across 100,000 stream frames", () => {
  const view = new HudView({ requestRender() {} }, null, snapshot(), normalizeConfig());
  const first = view.render(100);
  for (let i = 0; i < 100_000; i++) assert.equal(view.render(100), first);
  assert.equal(view.computations, 1);
});
test("unchanged publications do not request a terminal repaint", () => {
  let paints = 0;
  const s = snapshot(); const config = normalizeConfig();
  const view = new HudView({ requestRender() { paints++; } }, null, s, config);
  view.render(100); view.publish(s, config); view.publish({ ...s }, config);
  assert.equal(paints, 0);
  view.publish({ ...s, done: 999 }, config); assert.equal(paints, 1);
});
test("theme invalidation recomputes once, disposal prevents further renders", () => {
  let style = "one";
  const view = new HudView({ requestRender() {} }, () => ({ fg: (_tone, text) => `${style}:${text}` }), snapshot(), normalizeConfig());
  assert.ok(view.render(100)[0].startsWith("one:"));
  style = "two"; view.invalidate(); assert.ok(view.render(100)[0].startsWith("two:"));
  view.dispose(); assert.deepEqual(view.render(100), []);
});
test("renderer failure is isolated from the TUI", () => {
  let errors = 0;
  const view = new HudView({ requestRender() {} }, { fg() { throw new Error("theme failed"); } }, snapshot(), normalizeConfig(), () => { errors++; });
  assert.doesNotThrow(() => view.render(4)); assert.ok(visibleWidth(view.render(4)[0]) <= 4); assert.equal(errors, 1);
});
