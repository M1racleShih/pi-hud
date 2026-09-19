/**
 * Footer surface layout, bounded status area and cached-view tests.
 * These are renderer/component tests only; host integration lives in surface.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HudState } from "../src/state.ts";
import { normalizeConfig } from "../src/config.ts";
import { formatHud } from "../src/render.ts";
import {
  FOOTER_BODY_ROWS, MAX_FOOTER_ROWS, MAX_STATUS_COUNT, MAX_STATUS_KEY, MAX_STATUS_ROWS, MAX_STATUS_TEXT,
  HudFooterView, formatFooter, formatStatusRows,
} from "../src/footer.ts";
import { createStyler } from "../src/palette.ts";
import { MODEL, assistant } from "./helpers.mjs";

const WIDTHS = [40, 80, 120, 180];
const PRESETS = ["minimal", "balanced", "full"];
const identity = (overrides = {}) => ({ cwd: "~/opensource/pi-hud", provider: "zai", title: "Compare HUDs", branch: "main", branchDirty: false, ...overrides });
const config = (extra = {}) => normalizeConfig({ color: false, ...extra });
const strip = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

const state = (overrides = {}) => {
  const value = new HudState(overrides.cwd ?? "/home/yan/opensource/pi-hud", overrides.model ?? { id: "glm-5.3", name: overrides.modelName ?? "GLM-5.3", provider: "zai", contextWindow: 1_000_000 }, 0);
  value.thinking = "max";
  if (overrides.usage !== false) {
    value.messageEnd({
      role: "assistant", model: "glm-5.3", provider: "zai", stopReason: "stop",
      usage: { input: 12_000, output: 1_400, cacheRead: 35_000, cacheWrite: 500, cost: { total: 0.178 } },
    }, 1);
  }
  if (overrides.active) value.startTool({ toolCallId: "active", toolName: "edit", args: { path: "/home/yan/opensource/pi-hud/src/footer.ts" } });
  return value;
};
const rows = (snapshot, preset, width, extra = {}, who = identity()) =>
  formatFooter(snapshot, config({ preset, ...extra }), width, who).map((row) => row.text);

test("footer body rows are fixed per preset and never change with tool activity", () => {
  for (const preset of PRESETS) {
    for (const width of WIDTHS) {
      const value = state();
      const count = () => rows(value.snapshot(), preset, width).length;
      assert.equal(count(), FOOTER_BODY_ROWS[preset], `${preset}/${width} idle`);
      value.startTool({ toolCallId: "a", toolName: "bash" });
      assert.equal(count(), FOOTER_BODY_ROWS[preset], `${preset}/${width} running`);
      value.endTool({ toolCallId: "a", toolName: "bash" });
      assert.equal(count(), FOOTER_BODY_ROWS[preset], `${preset}/${width} completed`);
      value.startTool({ toolCallId: "b", toolName: "edit", args: { path: "/tmp/b.ts" } });
      value.endTool({ toolCallId: "b", toolName: "edit", isError: true });
      assert.equal(count(), FOOTER_BODY_ROWS[preset], `${preset}/${width} failed`);
      value.startTool({ toolCallId: "c", toolName: "read" });
      value.settle();
      value.phase = "working";
      assert.equal(count(), FOOTER_BODY_ROWS[preset], `${preset}/${width} interrupted`);
    }
  }
  assert.deepEqual(FOOTER_BODY_ROWS, { minimal: 2, balanced: 3, full: 4 });
});

test("every footer row stays inside its width and never leaves a dangling separator", () => {
  for (const preset of PRESETS) {
    for (const language of ["en", "zh-CN"]) {
      for (const ascii of [false, true]) {
        for (const width of [...Array(181).keys()]) {
          const built = formatFooter(state({ active: true }).snapshot(), config({ preset, language, ascii }), width, identity());
          assert.equal(built.length, FOOTER_BODY_ROWS[preset]);
          for (const row of built) {
            assert.ok(row.text.length >= 0);
            assert.ok(row.text === row.segments.map((segment) => segment.text).join(""));
            if (!row.text) continue;
            assert.notEqual(row.segments[0].role, "separator", `${preset}/${language}/${width}: leading separator`);
            assert.notEqual(row.segments.at(-1).role, "separator", `${preset}/${language}/${width}: trailing separator`);
            assert.ok(row.segments.every((segment) => segment.text.length > 0));
          }
        }
      }
    }
  }
});

test("the identity row shows model, thinking, provider, cached cwd, branch and title", () => {
  const snapshot = state().snapshot();
  const wide = rows(snapshot, "balanced", 180)[0];
  assert.match(wide, /\[GLM-5\.3\]/);
  assert.match(wide, /max/);
  assert.match(wide, /zai/);
  assert.match(wide, /~\/opensource\/pi-hud/);
  assert.match(wide, /git:main/);
  assert.match(wide, /Compare HUDs/);
  // The title is the first identity field to fold, then the branch, then the provider.
  const narrow = rows(snapshot, "balanced", 40)[0];
  assert.doesNotMatch(narrow, /Compare HUDs/);
  assert.match(narrow, /~\/opensource\/pi-hud/);
});

test("the context snapshot keeps the last label and the percentage at every width", () => {
  const value = state();
  value.contextTokens = 950_000;
  for (const width of WIDTHS) {
    const usage = rows(value.snapshot(), "balanced", width)[1];
    assert.match(usage, /ctx\(last\)/);
    assert.match(usage, /95%!/, `${width}: ${usage}`);
  }
  const zh = rows(value.snapshot(), "balanced", 40, { language: "zh-CN" }, identity())[1];
  assert.match(zh, /上下文\(上次\)/);
  assert.match(zh, /95%!/);
});

test("a long Chinese model name never hides the 95% context warning at 40/80/120", () => {
  const value = state({ modelName: "深度求索中文模型名称特别长版本" });
  value.contextTokens = 950_000;
  for (const width of [40, 80, 120]) {
    for (const language of ["en", "zh-CN"]) {
      const built = rows(value.snapshot(), "balanced", width, { language });
      assert.equal(built.length, FOOTER_BODY_ROWS.balanced);
      assert.match(built.join(" | "), /95%!/, `${language}/${width}: ${built.join(" | ")}`);
    }
  }
});

test("usage fields stay split, labelled observed, and CH is unknown rather than a fake zero", () => {
  const value = state();
  const text = rows(value.snapshot(), "balanced", 180)[1];
  assert.match(text, /obs\* ↑12k ↓1\.4k R35k W500 CH73\.7%/);
  assert.doesNotMatch(text, /↑48k/, "cache tokens must not be folded into input");
  assert.match(text, /est\* \$0\.178/);

  const withoutCache = new HudState("/tmp/p", MODEL, 0);
  withoutCache.messageEnd({ role: "assistant", model: MODEL.id, provider: MODEL.provider, stopReason: "stop", usage: { input: 10, output: 5 } }, 1);
  const noCacheText = rows(withoutCache.snapshot(), "balanced", 180)[1];
  assert.match(noCacheText, /CH\?/, "a zero denominator is unknown, never 0%");

  const unknownCost = new HudState("/tmp/p", MODEL, 0);
  unknownCost.messageEnd({ role: "assistant", model: MODEL.id, provider: MODEL.provider, stopReason: "stop", usage: { input: 10, output: 5 } }, 1);
  assert.match(rows(unknownCost.snapshot(), "balanced", 180)[1], /est\* \?/);

  const noUsage = new HudState("/tmp/p", MODEL, 0);
  assert.doesNotMatch(rows(noUsage.snapshot(), "balanced", 180)[1], /obs\*/);
  assert.doesNotMatch(rows(noUsage.snapshot(), "balanced", 180)[1], /CH/);
});

test("footer keeps the widget's palette roles, ASCII mode and Chinese labels", () => {
  const built = formatFooter(state({ active: true }).snapshot(), config({ preset: "full", ascii: true }), 120, identity());
  for (const row of built) assert.match(row.text, /^[\x20-\x7e]*$/, row.text);
  assert.ok(built.some((row) => /ctx\(last\)/.test(row.text)));
  const zh = formatFooter(state({ active: true }).snapshot(), config({ preset: "full", language: "zh-CN" }), 120, identity());
  assert.ok(zh.some((row) => /上下文\(上次\)/.test(row.text)));
  assert.ok(zh.some((row) => /观测\*/.test(row.text)));
  const roles = new Set(built.flatMap((row) => row.segments.map((segment) => segment.role)));
  for (const role of roles) assert.notEqual(role, undefined);
});

test("status entries are sanitized, bounded and folded with an explicit marker", () => {
  const statuses = new Map();
  statuses.set("pi-goal", "goal active · automatic");
  statuses.set("other", "\u001b[31mred\u001b[0m\u0007 text\nline");
  const rows80 = formatStatusRows(statuses, config(), 80);
  assert.equal(rows80.length, 1);
  assert.match(rows80[0].text, /goal active · automatic/);
  assert.match(rows80[0].text, /red text line/);
  assert.doesNotMatch(rows80[0].text, /[\u0000-\u001f\u001b]/);

  const many = new Map();
  for (let index = 0; index < 40; index++) many.set(`k${String(index).padStart(3, "0")}`, `status-${index}`);
  const capped = formatStatusRows(many, config(), 60);
  assert.ok(capped.length <= MAX_STATUS_ROWS, `${capped.length} rows`);
  assert.match(capped.at(-1).text, /\+\d+$/, `expected an explicit fold marker: ${capped.at(-1).text}`);
  const shown = capped.join(" ").match(/status-\d+/g) ?? [];
  assert.ok(shown.length <= MAX_STATUS_COUNT);
  assert.ok(new Set(shown).size === shown.length, "entries are not duplicated across rows");

  const long = new Map([["k", "x".repeat(10_000)]]);
  const clipped = formatStatusRows(long, config(), 30);
  assert.equal(clipped.length, 1);
  assert.ok(clipped[0].text.length <= 30);
  assert.match(clipped[0].text, /…|\.$/);
  assert.equal(formatStatusRows(new Map(), config(), 80).length, 0);
  assert.equal(formatStatusRows(new Map([["k", ""]]), config(), 80).length, 0);
  assert.equal(formatStatusRows(undefined, config(), 80).length, 0);
  assert.ok(MAX_STATUS_TEXT < 10_000 && MAX_STATUS_KEY === 32);
});

test("status area never exceeds its row budget or the total footer cap", () => {
  const value = state({ active: true });
  const statuses = new Map();
  for (let index = 0; index < 50; index++) statuses.set(`key-${index}`, `goal automatic number ${index} with a long tail`);
  const view = new HudFooterView({ requestRender() {} }, null, {
    getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => statuses,
  }, value.snapshot(), config({ preset: "full" }), identity(), () => {});
  for (const width of [40, 80, 120, 180]) {
    const lines = view.render(width);
    assert.ok(lines.length <= MAX_FOOTER_ROWS, `${width}: ${lines.length} lines`);
    assert.ok(lines.length > FOOTER_BODY_ROWS.full, "statuses are displayed");
    for (const line of lines) assert.ok(strip(line).length <= Math.max(1, width) || width === 0);
  }
  view.dispose();
});

test("in-place status Map mutations are detected without any HUD event or polling", () => {
  const value = state();
  const statuses = new Map([["pi-goal", "goal active"]]);
  let renders = 0;
  const view = new HudFooterView({ requestRender: () => { renders++; } }, null, {
    getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => statuses,
  }, value.snapshot(), config({ preset: "balanced" }), identity(), () => {});
  const first = view.render(120);
  assert.match(strip(first.join("\n")), /goal active/);
  const cached = view.render(120);
  assert.equal(cached, first, "unchanged data reuses the final rendered array");
  const baseline = view.statusChanges;
  assert.equal(baseline, 1, "the first observation is itself a change from the empty baseline");

  statuses.set("pi-goal", "goal automatic");
  const changed = view.render(120);
  assert.notEqual(changed, first);
  assert.match(strip(changed.join("\n")), /goal automatic/);
  assert.equal(view.statusChanges, baseline + 1);

  statuses.set("second", "added later");
  assert.match(strip(view.render(120).join("\n")), /added later/);
  assert.equal(view.statusChanges, baseline + 2);

  statuses.delete("pi-goal");
  const removed = strip(view.render(120).join("\n"));
  assert.doesNotMatch(removed, /goal automatic/);
  assert.match(removed, /added later/);
  assert.equal(view.statusChanges, baseline + 3);

  statuses.clear();
  assert.equal(view.render(120).length, FOOTER_BODY_ROWS.balanced);
  assert.equal(view.statusChanges, baseline + 4);
  view.dispose();
});

test("a throwing status provider or theme never breaks the footer frame", () => {
  let errors = 0;
  const view = new HudFooterView({ requestRender() {} }, null, {
    getGitBranch: () => "main", onBranchChange: () => () => {},
    getExtensionStatuses: () => { throw new Error("host bug"); },
  }, state().snapshot(), config({ preset: "balanced" }), identity(), () => { errors++; });
  const lines = view.render(120);
  assert.equal(lines.length, FOOTER_BODY_ROWS.balanced, "the body still renders");
  assert.ok(errors >= 1, "a status-provider failure is contained and counted for diagnostics");
  view.invalidate();
  assert.equal(view.render(120).length, FOOTER_BODY_ROWS.balanced);
  view.dispose();
});

test("cached footer frames are reused until width, state, theme or statuses change", () => {
  const view = new HudFooterView({ requestRender() {} }, null, {
    getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map(),
  }, state().snapshot(), config({ preset: "full" }), identity(), () => {});
  const first = view.render(120);
  assert.equal(view.render(120), first);
  assert.equal(view.computations, 1);
  assert.equal(view.render(80).length, FOOTER_BODY_ROWS.full);
  assert.equal(view.computations, 2);
  assert.equal(view.render(80), view.render(80));
  assert.equal(view.computations, 2);

  const next = state({ active: true }).snapshot();
  view.publish(next, config({ preset: "full" }), identity({ branch: "next" }));
  const published = view.render(120);
  assert.match(strip(published.join("\n")), /git:next/);
  assert.equal(view.render(120), published);
  const beforeInvalidate = view.computations;
  view.invalidate();
  assert.equal(view.computations, beforeInvalidate, "invalidate only marks the frame dirty");
  view.render(120);
  assert.equal(view.computations, beforeInvalidate + 1, "the next render recomputes exactly once");
  view.dispose();
  assert.deepEqual(view.render(120), [], "a disposed footer renders nothing");
  view.dispose();
});

test("theme switch and mono palette keep footer width stable", () => {
  const light = { getColorMode: () => "truecolor", getFgAnsi: () => "\u001b[38;2;31;35;40m" };
  const view = new HudFooterView({ requestRender() {} }, light, null, state().snapshot(), config({ preset: "balanced", color: true }), identity(), () => {});
  const colored = view.render(120);
  assert.match(colored.join("\n"), /\u001b\[38;2;/);
  view.theme = { getColorMode: () => "truecolor", getFgAnsi: () => "\u001b[38;2;212;212;212m" };
  view.invalidate();
  const dark = view.render(120);
  assert.notDeepEqual(dark, colored);
  assert.deepEqual(dark.map(strip), colored.map(strip), "color never changes layout");
  view.config = config({ preset: "balanced", palette: "mono" });
  view.invalidate();
  assert.doesNotMatch(view.render(120).join("\n"), /\u001b\[38;/);
  assert.equal(view.computations, 3);
  view.dispose();
});

test("footer body and status rows never fabricate a completion ratio from a status string", () => {
  const statuses = new Map([["pi-goal", "active (3/7 tasks)"]]);
  const lines = formatStatusRows(statuses, config(), 120);
  assert.equal(lines.length, 1);
  assert.equal(strip(lines[0].text), "active (3/7 tasks)");
  const snapshot = state().snapshot();
  const text = rows(snapshot, "full", 180).join("\n");
  assert.doesNotMatch(text, /3\/7/, "no parsed progress is invented");
});

test("footer never reintroduces a recent-completion summary", () => {
  for (const preset of PRESETS) {
    for (const width of WIDTHS) {
      const text = rows(state({ active: true }).snapshot(), preset, width).join("\n");
      assert.doesNotMatch(text, /recent|最近|preview\.txt|lastTool/);
    }
  }
});

test("widget rows are unchanged in count and keep their own layout contract", () => {
  const snapshot = state({ active: true }).snapshot();
  for (const preset of PRESETS) {
    for (const width of WIDTHS) {
      assert.equal(formatHud(snapshot, config({ preset }), width).length, { minimal: 1, balanced: 2, full: 3 }[preset]);
    }
  }
});

test("the palette styler used by the footer is bounded and pure", () => {
  const styler = createStyler(null, config({ palette: "pastel" }));
  const text = "goal active";
  assert.equal(strip(styler.style("body", text)), text);
  assert.equal(assistant().role, "assistant");
});
