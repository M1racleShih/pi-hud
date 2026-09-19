import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { clip, safeText, baseName, visibleWidth } from "../src/text.ts";
import { normalizeConfig } from "../src/config.ts";
import { HudState } from "../src/state.ts";
import { HudView, MAX_ROW_FIELDS, MAX_ROW_SEGMENTS, MAX_TOOL_FIELDS, capRowFields, capRowSegments, formatHud, styleRows } from "../src/render.ts";
import { createStyler } from "../src/palette.ts";
import { MODEL, assistant } from "./helpers.mjs";

const ESC = /\u001b\[[0-9;]*m/;
const strip = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");
const WIDTHS = [40, 80, 120, 180];

const snapshot = () => {
  const state = new HudState("/tmp/中文项目", { ...MODEL, name: "测试 Model 👩‍💻" }, 0);
  state.messageEnd(assistant(), 1);
  state.startTool({ toolCallId: "a", toolName: "read", args: { path: "/tmp/中文文件.ts" } });
  state.bridge({ version: 1, kind: "tasks", source: "test", id: "task", completed: 1, total: 3, label: "验证组合字符 é" }, 0);
  return state.snapshot();
};

/** Deterministic double: dark text color in truecolor, no host theme mutation. */
const darkTheme = { getColorMode: () => "truecolor", getFgAnsi: () => "\u001b[38;2;212;212;212m" };
const lightTheme = { getColorMode: () => "truecolor", getFgAnsi: () => "\u001b[38;2;31;35;40m" };

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
  assert.equal(clip("éhello", 2), "é…");
  assert.equal(clip("中文", 1), "…");
  assert.equal(clip("anything", 0), "");
  assert.equal(clip("plain ascii text", 8), "plain a…");
});

// The width fast path must stay exactly equivalent to a per-grapheme reference.
const isWide = (code) => code >= 0x1100 && (
  code <= 0x115f || code === 0x2329 || code === 0x232a ||
  (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
  (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
  (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1b000 && code <= 0x1b2ff) || (code >= 0x20000 && code <= 0x3fffd)
);
const referenceWidth = (text) => {
  const plain = stripVTControlCharacters(text);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let total = 0;
  for (const { segment } of segmenter.segment(plain)) {
    if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(segment)) { total += 2; continue; }
    for (const char of segment) {
      if (/^\p{Mark}$/u.test(char) || char === "\u200d" || char === "\ufe0f" || char === "\ufe0e") continue;
      const point = char.codePointAt(0) ?? 0;
      if (point < 32 || (point >= 0x7f && point < 0xa0)) continue;
      total += isWide(point) ? 2 : 1;
    }
  }
  return total;
};
test("visibleWidth fast path matches the grapheme reference on mixed text and a seeded fuzz corpus", () => {
  const fixed = [
    "", "abc", "plain ascii", "中文", "日本語テキスト", "e\u0301", "a\u200bb", "a\ufe0fb",
    "😀", "👩‍💻", "🇨🇳", "1️⃣", "✓14", "● edit", "↑↓…", "\u001b[31mred\u001b[0m",
    "क्ष", "한글", "각", "🏳️‍🌈", "👨‍👩‍👧‍👦", "٠١٢", "ＡＢ", "Ω≈ç√", "\u0301", "a\r\nb", "▒▓█",
  ];
  const pool = [0x41, 0x7a, 0x20, 0x2713, 0x25cf, 0x2588, 0x4e2d, 0x6587, 0x1f600, 0x1f469, 0x200d, 0x1f4bb, 0x0301, 0xfe0f, 0x20e3, 0x1f1e8, 0x1f1f3, 0x0a, 0x7f, 0x2191, 0x2026, 0xac00];
  let seed = 0x2f6e2b1;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  const generated = Array.from({ length: 400 }, () => {
    let text = "";
    for (let index = 0, length = 1 + Math.floor(random() * 12); index < length; index++) {
      text += String.fromCodePoint(pool[Math.floor(random() * pool.length)]);
    }
    return text;
  });
  for (const text of [...fixed, ...generated]) {
    assert.equal(visibleWidth(text), referenceWidth(text), JSON.stringify(text));
  }
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

// ---------------------------------------------------------------------------
// Semantic segments: layout is plain text first, styling happens afterwards.
// ---------------------------------------------------------------------------

test("rows expose bounded semantic segments, never a whole-row tone", () => {
  const s = snapshot();
  for (const preset of ["minimal", "balanced", "full"]) {
    for (const row of formatHud(s, normalizeConfig({ preset }), 120)) {
      assert.ok(row.segments.length > 0 && row.segments.length <= MAX_ROW_SEGMENTS);
      assert.equal(row.segments.map((segment) => segment.text).join(""), row.text);
      assert.ok(row.segments.every((segment) => typeof segment.role === "string" && segment.text.length > 0));
    }
  }
});
test("identity row colors model, path, git, thinking, context and separators separately", () => {
  const state = new HudState("/workspace/pi-hud", { ...MODEL, name: "Example Model" }, 0);
  state.messageEnd(assistant(), 1);
  state.contextTokens = 90_000;
  state.git = { available: true, branch: "main", dirty: true };
  const [row] = formatHud(state.snapshot(), normalizeConfig({ preset: "minimal" }), 180);
  const role = (text) => row.segments.find((segment) => segment.text.includes(text))?.role;
  assert.equal(role("[Example Model]"), "model");
  assert.equal(role("pi-hud"), "path");
  assert.equal(role("git:main*"), "git");
  assert.equal(role("ctx(last)"), "label");
  assert.match(row.segments.find((segment) => segment.role === "context")?.text ?? "", /^\s*\d+%$/);
  assert.ok(row.segments.some((segment) => segment.role === "separator" && segment.text === " · "));
  assert.ok(row.segments.some((segment) => segment.role === "barUsed"));
  assert.ok(row.segments.some((segment) => segment.role === "barEmpty"));
});
test("field colors are capped by the fixed field and segment budgets", () => {
  const s = snapshot();
  s.taskLabel = "x".repeat(200);
  s.agentLabel = "y".repeat(200);
  s.activeTools = Array.from({ length: 3 }, () => "a-very-long-tool-name-with-target.ts");
  for (const width of [0, 10, 40, 120, 180]) {
    for (const row of formatHud(s, normalizeConfig({ preset: "full" }), width)) {
      // Each field may contribute a small, fixed number of colored segments (a label and a
      // value); the hard per-row bound is MAX_ROW_SEGMENTS below.
      assert.ok(row.segments.filter((segment) => segment.role !== "separator").length <= MAX_ROW_FIELDS + 4);
      assert.ok(row.segments.length <= MAX_ROW_SEGMENTS);
      assert.ok(visibleWidth(row.text) <= width);
    }
  }
});
test("the hard field and segment caps drop by priority and keep readability order", () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ priority: index + 1, text: `f${index}` }));
  const capped = capRowFields(many);
  assert.equal(capped.length, MAX_ROW_FIELDS);
  assert.deepEqual(capped.map((item) => item.priority), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const few = many.slice(0, 3);
  assert.equal(capRowFields(few), few, "under the cap the array is reused");
  const segments = Array.from({ length: MAX_ROW_SEGMENTS + 8 }, (_, index) => ({ role: index % 2 ? "body" : "label", text: String(index) }));
  assert.equal(capRowSegments(segments).length, MAX_ROW_SEGMENTS);
  assert.equal(capRowSegments(segments)[0].text, "0");
  const short = segments.slice(0, 4);
  assert.equal(capRowSegments(short), short, "under the cap the array is reused");
});
test("narrow, CJK, emoji and long-path input stays grapheme-safe and width-bounded", () => {
  const state = new HudState("/very/long/中文/目录/名称/" + "长路径".repeat(30), { ...MODEL, name: "中文 Model 👩‍💻🧪", contextWindow: 100_000 }, 0);
  state.messageEnd(assistant(), 1);
  state.startTool({ toolCallId: "a", toolName: "edit", args: { path: "/tmp/👩‍💻/文件.ts" } });
  const s = state.snapshot();
  for (const width of [0, 1, 5, 15, 40, 80, 120, 180]) {
    for (const preset of ["minimal", "balanced", "full"]) {
      for (const row of formatHud(s, normalizeConfig({ preset }), width)) {
        assert.ok(visibleWidth(row.text) <= width, `${width}: ${row.text}`);
        assert.doesNotMatch(row.text, /[\ud800-\udfff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/u, `split surrogate at ${width}`);
        assert.equal(row.segments.map((segment) => segment.text).join(""), row.text);
      }
    }
  }
});
test("narrow widths keep the context meter and a high-usage warning beside a long model name", () => {
  const longName = "Claude Sonnet 4.5 (200k)";
  for (const language of ["en", "zh-CN"]) {
    const label = language === "zh-CN" ? "上下文(上次)" : "ctx(last)";
    for (const ratio of [0.45, 0.95]) {
      const state = new HudState("/tmp/中文项目", { ...MODEL, name: longName }, 0);
      state.messageEnd(assistant(), 1);
      state.contextTokens = Math.round(state.contextWindow * ratio);
      const config = normalizeConfig({ language });
      for (const width of [20, 24, 30, 40, 44]) {
        const [row] = formatHud(state.snapshot(), config, width);
        assert.ok(visibleWidth(row.text) <= width, `${language}/${width}: ${row.text}`);
        assert.ok(row.text.includes(label), `${language}/${width} dropped the context meter: ${row.text}`);
        const percent = row.segments.find((segment) => segment.role === "warning" || segment.role === "context");
        assert.ok(percent, `${language}/${width} dropped the percentage: ${row.text}`);
        assert.match(percent.text, new RegExp(`^\\s?${Math.round(ratio * 100)}%${ratio > 0.9 ? "!" : ""}$`));
        assert.equal(percent.role, ratio > 0.9 ? "warning" : "context", `${language}/${width}`);
      }
      // The reservation clips the model instead of discarding the context field.
      const [wide] = formatHud(state.snapshot(), config, 40);
      assert.match(wide.text, /^\[.*…\]/, `${language}: expected a clipped model name: ${wide.text}`);
      assert.ok(wide.text.includes(label), `${language}: ${wide.text}`);
    }
  }
});
test("40 columns keeps the short model, context percentage and activity", () => {
  const s = snapshot();
  const [first, second] = formatHud(s, normalizeConfig(), 40);
  assert.ok(first.text.includes("[测试 Model"));
  assert.ok(first.text.includes("ctx(last)"));
  assert.ok(/ctx\(last\) \d+%/.test(first.text));
  assert.match(second.text, /^● /);
  assert.ok(second.text.includes("read"));
  assert.ok(!second.text.includes("tools*"), "zero counters must not fabricate a tools field");
  assert.ok(visibleWidth(first.text) <= 40 && visibleWidth(second.text) <= 40);
});
for (const width of WIDTHS) {
  test(`${width} columns: unknown fields fold by priority without overflow`, () => {
    const state = new HudState("/workspace/pi-hud", { ...MODEL, name: "A".repeat(64) }, 0);
    state.messageEnd(assistant(), 1);
    const s = state.snapshot();
    for (const row of formatHud(s, normalizeConfig({ preset: "full" }), width)) {
      assert.ok(visibleWidth(row.text) <= width, `${width}: ${row.text}`);
    }
    const first = formatHud(s, normalizeConfig({ preset: "full" }), width)[0].text;
    assert.ok(first.includes("ctx(last)"), `context must survive at ${width}`);
    if (width >= 120) assert.ok(first.includes("/200k"), `token detail appears at ${width}`);
    if (width < 120) assert.ok(!first.includes("/200k"), `token detail folds below 120 at ${width}`);
  });
}
test("unknown context is explicitly unknown and not a zero percent", () => {
  const s = snapshot(); s.contextTokens = null;
  const [row] = formatHud(s, normalizeConfig(), 100);
  assert.match(row.text, /ctx\(last\) \?/);
  assert.doesNotMatch(row.text, /0%/);
  assert.equal(row.segments.find((segment) => segment.text.includes("ctx(last)"))?.role, "label");
});
test("context overflow and high usage switch only the context field to a warning", () => {
  const overflow = snapshot(); overflow.contextTokens = Number.MAX_SAFE_INTEGER; overflow.contextWindow = 1;
  const [row] = formatHud(overflow, normalizeConfig(), 100);
  assert.match(row.text, />999%!/);
  assert.ok(visibleWidth(row.text) <= 100);
  assert.equal(row.segments.find((segment) => segment.role === "model").text, `[${clip(overflow.model, 32)}]`);
  assert.ok(row.segments.filter((segment) => segment.role === "warning").every((segment) => /[█░]|>999%/.test(segment.text)));
  assert.equal(row.segments.some((segment) => segment.role === "error"), false, "high usage is a warning, not a failure");
  const high = snapshot(); high.contextTokens = 95_000; high.contextWindow = 100_000;
  const alert = formatHud(high, normalizeConfig(), 100)[0];
  assert.match(alert.text, /95%!/);
  assert.equal(alert.segments.find((segment) => segment.text.includes("95%"))?.role, "warning");
  assert.ok(alert.segments.some((segment) => segment.role === "warning" && /^█+$/.test(segment.text)), "the used bar turns into the alert color");
  assert.equal(alert.segments.find((segment) => segment.text.startsWith("["))?.role, "model");
  const medium = snapshot(); medium.contextTokens = 75_000; medium.contextWindow = 100_000;
  const warn = formatHud(medium, normalizeConfig(), 100)[0];
  assert.match(warn.text, /75%/);
  assert.doesNotMatch(warn.text, /75%!/, "the symbol hint is reserved for very high usage");
  assert.equal(warn.segments.find((segment) => segment.text.includes("75%"))?.role, "warning");
});
test("phase colors: idle marker is success, phases stay accent, waiting is a local warning", () => {
  const state = new HudState("/tmp/p", MODEL, 0);
  const role = (snapshot, preset = "balanced") => formatHud(snapshot, normalizeConfig({ preset }), 180)[1].segments.map((segment) => segment.role);
  assert.deepEqual(role(state.snapshot()).slice(0, 2), ["success", "phase"]);
  state.phase = "working";
  assert.equal(role(state.snapshot())[0], "phase");
  state.phase = "settling";
  assert.equal(role(state.snapshot())[0], "phase");
  state.waiting = true;
  assert.equal(role(state.snapshot())[0], "warning");
  state.waiting = false;
  state.startTool({ toolCallId: "a", toolName: "edit", args: { path: "/tmp/file.ts" } });
  const active = formatHud(state.snapshot(), normalizeConfig(), 180)[1];
  assert.equal(active.segments[0].role, "phase");
  assert.match(active.text, /^● edit file\.ts/);
  state.waiting = true;
  assert.equal(formatHud(state.snapshot(), normalizeConfig(), 180)[1].segments[0].role, "warning");
});
test("tool errors, interrupted work and dropped activity color only their own field", () => {
  const state = new HudState("/tmp/p", MODEL, 0);
  state.messageEnd(assistant(), 1);
  state.startTool({ toolCallId: "a", toolName: "bash" });
  state.endTool({ toolCallId: "a", toolName: "bash", isError: true });
  state.endTool({ toolCallId: "b", toolName: "read", isError: false });
  state.interrupted = 2;
  state.dropped = 1;
  const rows = formatHud(state.snapshot(), normalizeConfig(), 180);
  const segments = rows[1].segments;
  assert.equal(segments.find((segment) => segment.text.includes("!1"))?.role, "error");
  assert.notEqual(segments.find((segment) => segment.text.includes("✓1"))?.role, "error");
  assert.equal(segments.find((segment) => segment.text === "limited*")?.role, "warning");
  assert.equal(rows[1].text.includes("interrupted"), true);
  assert.equal(segments.find((segment) => segment.text.includes("interrupted"))?.role, "warning");
  assert.equal(segments.find((segment) => segment.text === "est* ")?.role, "label");
  assert.equal(segments.find((segment) => segment.text.includes("$"))?.role, "body");
});
test("agent and task alerts never recolor the phase or model fields", () => {
  const state = new HudState("/tmp/p", MODEL, 0);
  state.bridge({ version: 1, source: "s", kind: "agent", id: "a", status: "error" }, 0);
  state.bridge({ version: 1, source: "s", kind: "tasks", id: "t", completed: 1, total: 2 }, 0);
  const rows = formatHud(state.snapshot(), normalizeConfig({ preset: "balanced" }), 180);
  const agentWarning = rows[1].segments.find((segment) => segment.text.includes("!1"));
  assert.equal(agentWarning?.role, "warning");
  assert.equal(rows[1].segments.find((segment) => segment.text.startsWith("●") || segment.text.startsWith("✓"))?.role, "success");
  assert.equal(rows[0].segments.find((segment) => segment.role === "model")?.role, "model");
});

// ---------------------------------------------------------------------------
// Phase 2: bounded tool categories
// ---------------------------------------------------------------------------

/** 15 bash completions (one failed), 3 edits and 1 write: a saturated but bounded ledger. */
const activityState = () => {
  const state = new HudState("/workspace/pi-hud", { ...MODEL, name: "Example Model" }, 0);
  state.messageEnd(assistant(), 1);
  for (let index = 0; index < 15; index++) {
    state.startTool({ toolCallId: `bash-${index}`, toolName: "bash" });
    state.endTool({ toolCallId: `bash-${index}`, toolName: "bash", isError: index === 14 });
  }
  for (let index = 0; index < 3; index++) {
    state.startTool({ toolCallId: `edit-${index}`, toolName: "edit", args: { path: "/workspace/pi-hud/src/render.ts" } });
    state.endTool({ toolCallId: `edit-${index}`, toolName: "edit" });
  }
  state.startTool({ toolCallId: "write-0", toolName: "write", args: { path: "/workspace/pi-hud/docs/preview.txt" } });
  state.endTool({ toolCallId: "write-0", toolName: "write" });
  return state;
};

test("tool categories render bounded per-name counts and a separate aggregate error field", () => {
  const state = activityState();
  const rows = formatHud(state.snapshot(), normalizeConfig({ preset: "balanced" }), 180);
  assert.match(rows[1].text, /bash ✓14 !1/);
  assert.match(rows[1].text, /edit ✓3/);
  assert.match(rows[1].text, /write ✓1/);
  assert.match(rows[1].text, /errors 1/);
  // Only the failed-category mark and the aggregate count carry the error role.
  assert.deepEqual(rows[1].segments.filter((segment) => segment.role === "error").map((segment) => segment.text).sort(), [" !1", "1"].sort());
  assert.equal(rows[0].segments.some((segment) => segment.role === "error"), false, "historical failures must not tint the identity row");
  assert.ok(rows[1].segments.filter((segment) => segment.role === "success").length >= 3, "each successful category keeps its own success mark");
});

test("category display is capped, ranked by activity, and overflow folds into a marker plus other", () => {
  const state = activityState();
  for (const [name, count] of [["read", 5], ["find", 4], ["grep", 3], ["ls", 2]]) {
    for (let index = 0; index < count; index++) {
      state.startTool({ toolCallId: `${name}-${index}`, toolName: name });
      state.endTool({ toolCallId: `${name}-${index}`, toolName: name });
    }
  }
  const categories = state.snapshot().toolCategories;
  const ranked = categories.slice().sort((a, b) => (b.ok + b.error + b.interrupted) - (a.ok + a.error + a.interrupted));
  const row = formatHud(state.snapshot(), normalizeConfig({ preset: "balanced" }), 240)[1];
  for (const category of ranked.slice(0, MAX_TOOL_FIELDS)) assert.ok(row.text.includes(`${category.name} ✓`), `${category.name} should be shown: ${row.text}`);
  assert.ok(!row.text.includes(`${ranked[MAX_TOOL_FIELDS].name} ✓`), `categories beyond the display cap must fold: ${row.text}`);
  assert.match(row.text, new RegExp(`\\+${ranked.length - MAX_TOOL_FIELDS}`));

  // More than 16 distinct names: the retained ledger stays bounded and the rest share `other`.
  const wide = new HudState("/workspace/pi-hud", MODEL, 0);
  for (let index = 0; index < 36; index++) {
    wide.startTool({ toolCallId: `n${index}`, toolName: `tool-${index}` });
    wide.endTool({ toolCallId: `n${index}`, toolName: `tool-${index}` });
  }
  assert.equal(wide.snapshot().toolCategories.length, 17);
  assert.equal(wide.snapshot().toolCategories.filter((item) => item.name !== "other").length, 16);
  const zh = formatHud(wide.snapshot(), normalizeConfig({ preset: "balanced", language: "zh-CN" }), 200)[1];
  assert.ok(zh.text.includes("其他 ✓20"), zh.text);
});

test("zero-compaction and zero-usage fields stay hidden, and appear once observed", () => {
  const state = new HudState("/tmp/p", MODEL, 0);
  const config = normalizeConfig({ preset: "full" });
  assert.equal(formatHud(state.snapshot(), config, 120)[2].text, "", "an empty summary row stays blank instead of inventing fields");
  state.messageEnd(assistant(), 1);
  state.compact();
  const observed = formatHud(state.snapshot(), config, 120)[2];
  assert.match(observed.text, /compactions\* 1/);
  assert.match(observed.text, /obs\* ↑1\.0k ↓300 R2\.0k W400 CH\?/, "compaction invalidates the cached hit-rate observation");
  assert.equal(observed.segments.find((segment) => segment.text.includes("compactions"))?.role, "label");
});


test("a real tool named other is not localized as the synthetic overflow bucket", () => {
  const state = new HudState("/tmp/p", MODEL, 0);
  for (const [id, name] of [["a", "other"], ["b", "bash"]]) {
    state.startTool({ toolCallId: id, toolName: name });
    state.endTool({ toolCallId: id, toolName: name });
  }
  const zh = formatHud(state.snapshot(), normalizeConfig({ preset: "balanced", language: "zh-CN" }), 120)[1];
  assert.match(zh.text, /other ✓1/);
  assert.doesNotMatch(zh.text, /其他/);
  for (let index = 0; index < 20; index++) {
    state.startTool({ toolCallId: `t${index}`, toolName: `tool-${index}` });
    state.endTool({ toolCallId: `t${index}`, toolName: `tool-${index}` });
  }
  const capped = formatHud(state.snapshot(), normalizeConfig({ preset: "balanced", language: "zh-CN" }), 200)[1];
  assert.match(capped.text, /其他 ✓6/, capped.text);
  assert.match(capped.text, /other ✓1/, capped.text);
});

test("bridge agents/tasks appear only with real bridge data", () => {
  const state = activityState();
  const config = normalizeConfig({ preset: "full" });
  const withoutBridge = formatHud(state.snapshot(), config, 120);
  assert.equal(withoutBridge.length, 3);
  for (const row of withoutBridge) assert.doesNotMatch(row.text, /no bridged activity|暂无桥接活动/);
  assert.match(withoutBridge[2].text, /obs\* ↑1\.0k ↓300 R2\.0k W400 CH58\.8%/);

  state.bridge({ version: 1, source: "s", kind: "agent", id: "a", status: "running", label: "Review implementation" }, 0);
  state.bridge({ version: 1, source: "s", kind: "tasks", id: "t", completed: 2, total: 5, label: "Bridge goal" }, 0);
  const withBridge = formatHud(state.snapshot(), config, 120);
  assert.match(withBridge[2].text, /agents 1/);
  assert.match(withBridge[2].text, /tasks 2\/5/);
  assert.match(withBridge[2].text, /Bridge goal/);
});


test("row count is fixed across tool start, completion, interruption and idle transitions", () => {
  for (const preset of ["minimal", "balanced", "full"]) {
    const expected = { minimal: 1, balanced: 2, full: 3 }[preset];
    for (const width of WIDTHS) {
      const state = new HudState("/workspace/pi-hud", MODEL, 0);
      const config = normalizeConfig({ preset });
      const rowCount = () => formatHud(state.snapshot(), config, width).length;
      assert.equal(rowCount(), expected, `${preset}/${width} idle`);
      state.startTool({ toolCallId: "one", toolName: "bash" });
      assert.equal(rowCount(), expected, `${preset}/${width} while running`);
      state.startTool({ toolCallId: "two", toolName: "edit", args: { path: "/tmp/a.ts" } });
      state.endTool({ toolCallId: "one", toolName: "bash", isError: true });
      state.endTool({ toolCallId: "two", toolName: "edit" });
      assert.equal(rowCount(), expected, `${preset}/${width} after completion`);
      state.startTool({ toolCallId: "three", toolName: "write", args: { path: "/tmp/b.ts" } });
      state.settle();
      assert.equal(rowCount(), expected, `${preset}/${width} after settle`);
      state.phase = "working";
      assert.equal(rowCount(), expected, `${preset}/${width} while working`);
    }
  }
});

test("phase-2 activity cannot crowd the 40-column context warning out of the identity row", () => {
  const state = new HudState("/tmp/中文项目", { ...MODEL, name: "Claude Sonnet 4.5 (200k)" }, 0);
  state.messageEnd(assistant(), 1);
  state.contextTokens = 190_000; // 95%
  for (let index = 0; index < 17; index++) {
    state.startTool({ toolCallId: `t${index}`, toolName: `tool-${index}` });
    state.endTool({ toolCallId: `t${index}`, toolName: `tool-${index}`, isError: index % 3 === 0 });
  }
  for (const id of ["a", "b", "c", "d"]) state.startTool({ toolCallId: id, toolName: "edit", args: { path: "/tmp/中文文件.ts" } });
  const config = normalizeConfig({ language: "zh-CN", preset: "full" });
  for (const width of [40, 44, 80]) {
    const rows = formatHud(state.snapshot(), config, width);
    assert.equal(rows.length, 3, `${width}: fixed rows`);
    assert.ok(rows[0].text.includes("上下文(上次)"), `${width}: ${rows[0].text}`);
    const context = rows[0].segments.find((segment) => segment.text.trim() === "95%!");
    assert.ok(context, `${width}: the context warning must survive: ${rows[0].text}`);
    assert.equal(context.role, "warning");
    assert.match(rows[1].text, /^● edit 中文文件\.ts/, `${width}: current activity must survive`);
    assert.ok(rows[1].segments.some((segment) => segment.role === "error"), `${width}: the error alert must survive: ${rows[1].text}`);
    assert.ok(rows[1].segments.filter((segment) => segment.role === "error" || segment.role === "warning").length <= 3, "historical failures stay local");
    assert.ok(visibleWidth(rows[1].text) <= width);
  }
  // Narrow rows fold the categories and history instead of the alerts.
  const narrow = formatHud(state.snapshot(), config, 40)[1];
  assert.ok(!narrow.text.includes("tool-0"), narrow.text);
  assert.ok(!narrow.text.includes("最近"), narrow.text);
});

test("ASCII mode keeps every category mark printable", () => {
  const state = activityState();
  const rows = formatHud(state.snapshot(), normalizeConfig({ preset: "full", ascii: true }), 120);
  for (const row of rows) assert.match(row.text, /^[\x20-\x7e]*$/, row.text);
  assert.match(rows[1].text, /bash ok14 !1/);
  assert.match(rows[1].text, /errors 1/);
});

test("all palettes style the new activity fields without changing the layout", () => {
  const snapshotValue = activityState().snapshot();
  const rows = formatHud(snapshotValue, normalizeConfig({ preset: "full" }), 120);
  for (const palette of ["pastel", "mono"]) {
    const config = normalizeConfig({ preset: "full", palette });
    const styled = styleRows(rows, createStyler(darkTheme, config));
    assert.deepEqual(styled.map(strip), rows.map((row) => row.text));
    assert.deepEqual(styled.map(visibleWidth), rows.map((row) => visibleWidth(row.text)));
    if (palette === "mono") assert.ok(styled.every((line) => !ESC.test(line)));
  }
  const uncolored = styleRows(rows, createStyler(darkTheme, normalizeConfig({ preset: "full", color: false })));
  assert.deepEqual(uncolored.map(strip), rows.map((row) => row.text));
  assert.ok(uncolored.every((line) => !ESC.test(line)), "color:false must stay escape-free with activity data");
  const theme = { fg: (color, text) => `<${color}>${text}`, getColorMode: () => "truecolor", getFgAnsi: () => "\u001b[38;2;212;212;212m" };
  const themed = styleRows(rows, createStyler(theme, normalizeConfig({ preset: "full", palette: "theme" })));
  assert.ok(themed[1].includes("<success>✓14"), "category successes use the host success token");
  assert.ok(themed[1].includes("<error> !1"), "category failures use the host error token");
});

// ---------------------------------------------------------------------------
// Styling: palettes, color:false, ASCII, theme invalidation, cache
// ---------------------------------------------------------------------------

test("palette styling never changes visible width and color:false adds no escapes", () => {
  const s = snapshot();
  for (const width of WIDTHS) {
    const rows = formatHud(s, normalizeConfig({ preset: "full" }), width);
    const plain = styleRows(rows, createStyler(darkTheme, normalizeConfig({ color: false })));
    const styled = styleRows(rows, createStyler(darkTheme, normalizeConfig({ preset: "full" })));
    assert.deepEqual(styled.map(strip), plain);
    assert.deepEqual(styled.map(visibleWidth), plain.map(visibleWidth));
    assert.ok(styled.some((line) => ESC.test(line)));
    assert.ok(plain.every((line) => !ESC.test(line)));
  }
});
test("ASCII mode never emits non-ASCII glyphs of its own and keeps the same row count", () => {
  const state = new HudState("/tmp/ascii-project", { ...MODEL, name: "Ascii Model" }, 0);
  state.messageEnd(assistant(), 1);
  state.startTool({ toolCallId: "a", toolName: "read", args: { path: "/tmp/ascii.ts" } });
  state.bridge({ version: 1, source: "t", kind: "tasks", id: "task", completed: 1, total: 3, label: "Ascii goal" }, 0);
  const s = state.snapshot();
  for (const width of WIDTHS) {
    const rows = formatHud(s, normalizeConfig({ preset: "full", ascii: true }), width);
    const lines = styleRows(rows, createStyler(null, normalizeConfig({ ascii: true })));
    for (const line of lines) {
      assert.match(strip(line), /^[\x20-\x7e]*$/, `${width}: ${line}`);
      assert.ok(!strip(line).includes("·") && !strip(line).includes("█"));
    }
    assert.equal(rows.length, 3);
    assert.ok(lines[0].includes("#") || lines[0].includes("ctx(last)"));
    assert.ok(lines[1].includes("ok") || lines[1].includes(">"));
  }
  // zh-CN keeps its translated labels but still uses ASCII bar/separator/ellipsis glyphs.
  const zh = formatHud(snapshot(), normalizeConfig({ preset: "full", ascii: true, language: "zh-CN" }), 60);
  for (const row of zh) assert.ok(!/[█░·↑↓✓●…]/.test(row.text), row.text);
  assert.ok(zh[0].text.includes("上下文(上次)"));
});
test("theme invalidation re-detects the palette variant and recomputes once", () => {
  let theme = darkTheme;
  const view = new HudView({ requestRender() {} }, () => theme, snapshot(), normalizeConfig({ preset: "minimal" }));
  const dark = view.render(120);
  assert.equal(view.computations, 1);
  assert.ok(dark[0].includes("\u001b[38;2;229;200;144m"));
  theme = lightTheme;
  assert.equal(view.render(120), dark, "an un-invalidated theme must reuse the cache");
  assert.equal(view.computations, 1);
  view.invalidate();
  const light = view.render(120);
  assert.equal(view.computations, 2);
  assert.ok(light[0].includes("\u001b[38;2;223;142;29m"), "light variant must be re-detected");
  assert.notEqual(light[0], dark[0]);
});
test("palette changes invalidate the styled cache through publish", () => {
  let paints = 0;
  const s = snapshot();
  const theme = { fg: (color, text) => `<${color}>${text}`, getColorMode: () => "truecolor", getFgAnsi: () => "\u001b[38;2;212;212;212m" };
  const view = new HudView({ requestRender() { paints++; } }, theme, s, normalizeConfig({ preset: "minimal", palette: "pastel" }));
  const pastel = view.render(120);
  view.publish(s, normalizeConfig({ preset: "minimal", palette: "mono" }));
  assert.equal(paints, 1);
  assert.equal(view.render(120)[0], strip(pastel[0]));
  view.publish(s, normalizeConfig({ preset: "minimal", palette: "theme" }));
  assert.equal(paints, 2);
  assert.ok(view.render(120)[0].includes("<accent>"));
});
test("cached render is object-identical across 100,000 stream frames", () => {
  const view = new HudView({ requestRender() {} }, darkTheme, snapshot(), normalizeConfig());
  const first = view.render(100);
  for (let i = 0; i < 100_000; i++) assert.equal(view.render(100), first);
  assert.equal(view.computations, 1);
});
test("width changes recompute and returning to a width reproduces the same lines", () => {
  const view = new HudView({ requestRender() {} }, darkTheme, snapshot(), normalizeConfig());
  const narrow = view.render(40);
  const wide = view.render(120);
  assert.equal(view.computations, 2);
  const narrowAgain = view.render(40);
  assert.equal(view.computations, 3);
  assert.deepEqual(narrowAgain, narrow);
  assert.notDeepEqual(wide, narrow);
  assert.equal(view.render(40), narrowAgain, "cache is reused after recomputation");
  assert.equal(view.computations, 3);
});
test("unchanged publications do not request a terminal repaint", () => {
  let paints = 0;
  const s = snapshot(); const config = normalizeConfig();
  const view = new HudView({ requestRender() { paints++; } }, null, s, config);
  view.render(100); view.publish(s, config); view.publish({ ...s }, config);
  assert.equal(paints, 0);
  view.publish({ ...s, done: 999, toolCategories: [{ name: "bash", ok: 999, error: 0, interrupted: 0 }] }, config); assert.equal(paints, 1);
});
test("theme palette uses host theme tokens per field", () => {
  const calls = [];
  const theme = { fg: (color, text) => { calls.push(color); return `<${color}>${text}`; }, getColorMode: () => "truecolor", getFgAnsi: () => "\u001b[38;2;212;212;212m" };
  const view = new HudView({ requestRender() {} }, theme, snapshot(), normalizeConfig({ preset: "minimal", palette: "theme" }));
  const [line] = view.render(180);
  assert.ok(line.includes("<accent>["));
  assert.ok(line.includes("<success>") || line.includes("<mdHeading>"));
  assert.ok(calls.includes("muted") || calls.includes("dim"));
});
test("a broken theme degrades to plain text instead of replacing the HUD", () => {
  let errors = 0;
  const view = new HudView({ requestRender() {} }, { fg() { throw new Error("theme failed"); } }, snapshot(), normalizeConfig({ palette: "theme" }), () => { errors++; });
  const [line] = view.render(180);
  assert.doesNotMatch(line, /pi-hud unavailable/);
  assert.equal(line, strip(line));
  assert.equal(errors, 0);
});
test("renderer failure is isolated from the TUI", () => {
  let errors = 0;
  const broken = { ...snapshot(), activeTools: null };
  const view = new HudView({ requestRender() {} }, null, broken, normalizeConfig(), () => { errors++; });
  assert.doesNotThrow(() => view.render(4));
  assert.ok(visibleWidth(view.render(4)[0]) <= 4);
  assert.equal(errors, 1);
});
test("disposal prevents further renders", () => {
  const view = new HudView({ requestRender() {} }, null, snapshot(), normalizeConfig());
  view.render(80);
  view.dispose();
  assert.deepEqual(view.render(80), []);
});

test("completed tool targets are absent from every preset and language", () => {
  const state = activityState();
  for (const language of ["en", "zh-CN"]) {
    for (const [preset, count] of [["minimal", 1], ["balanced", 2], ["full", 3]]) {
      const rows = formatHud(state.snapshot(), normalizeConfig({ preset, language }), 180);
      assert.equal(rows.length, count);
      for (const row of rows) assert.doesNotMatch(row.text, /recent|最近|preview\.txt|render\.ts/);
      if (preset !== "minimal") assert.match(rows[1].text, /bash ✓14 !1/);
    }
  }
});
