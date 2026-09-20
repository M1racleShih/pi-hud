/**
 * Human visual-acceptance demo (synthetic, colored).
 *
 * `scripts/demo.mjs` prints the deterministic plain-text preview asserted by the repo
 * checks; this script renders the SAME production fixtures through the SAME renderer,
 * but with ANSI field colors, so a human can eyeball the palettes on a real terminal
 * background at the acceptance widths (40/80/120/180). The dark/light variant is forced
 * through the real `createStyler` detection path via a stub theme whose text color
 * mirrors a dark (light text) or light (dark text) terminal.
 *
 * This is a viewing aid, not an acceptance result: contrast, legibility, flicker and
 * layout-on-real-terminal judgments stay with the human observer following
 * docs/VISUAL-ACCEPTANCE.zh-CN.md. Nothing here touches the filesystem, host, or config.
 */
import assert from "node:assert/strict";
import { visibleWidth } from "../src/text.ts";
import { formatHud, styleRows } from "../src/render.ts";
import { formatFooter, formatStatusRows } from "../src/footer.ts";
import { normalizeConfig } from "../src/config.ts";
import { HUD_ROLES, PASTEL_DARK, PASTEL_LIGHT, createStyler } from "../src/palette.ts";
import { FOOTER_IDENTITY, fixtureState, sessionView } from "./preview.mjs";

const USAGE = `usage: node scripts/visual-demo.mjs [options]
  --background dark|light|both   terminal background to assume (default both)
  --width 40,80,120,180          column widths to render (default 40,80,120,180)
  --surface widget|footer|both   which surface to render (default both)
  --preset minimal,balanced,full widget/footer presets (default balanced)
  --language en,zh-CN            label languages (default en)
  --mode truecolor|256color      ANSI color mode (default truecolor)
  --ascii                        ASCII marks and separators (same information)
  --plain                        no ANSI colors at all (layout only)
Run it in a real terminal whose background matches --background.`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const list = (name, fallback, valid) =>
  flag(name, fallback).split(",").map((value) => value.trim()).filter((value) => {
    if (!valid.includes(value)) { console.error(`invalid --${name} value: ${value}\n${USAGE}`); process.exit(1); }
    return true;
  });

const backgrounds = list("background", "both", ["dark", "light", "both"]).flatMap((value) => (value === "both" ? ["dark", "light"] : [value]));
const widths = list("width", "40,80,120,180", ["40", "80", "120", "180", "30", "46", "56", "60", "70", "100", "200"]).map(Number);
const surfaces = list("surface", "both", ["widget", "footer", "both"]).flatMap((value) => (value === "both" ? ["widget", "footer"] : [value]));
const presets = list("preset", "balanced", ["minimal", "balanced", "full"]);
const languages = list("language", "en", ["en", "zh-CN"]);
const colorMode = flag("mode", "truecolor");
assert.ok(["truecolor", "256color"].includes(colorMode), `invalid --mode: ${colorMode}`);
const ascii = args.includes("--ascii");
const plain = args.includes("--plain");

// Light text implies a dark background and vice versa; the stub feeds Pi's own detection.
const THEME_STUBS = Object.freeze({
  dark: Object.freeze({ getFgAnsi: () => "\x1b[38;2;198;208;245m", getColorMode: () => colorMode }),
  light: Object.freeze({ getFgAnsi: () => "\x1b[38;2;76;79;105m", getColorMode: () => colorMode }),
});

/** Live-state variants for the acceptance states; every one is a documented display state. */
const stateFor = (name) => {
  switch (name) {
    case "ready": {
      const state = fixtureState({ active: false });
      return state.snapshot();
    }
    case "working":
      return fixtureState().snapshot();
    case "waiting": {
      const state = fixtureState({ active: false });
      state.waiting = true;
      return state.snapshot();
    }
    case "context-warning":
      return fixtureState({ contextRatio: 0.96 }).snapshot();
    case "long-model-zh":
      return fixtureState({ modelName: "深度求索中文模型名称特别长版本", contextRatio: 0.95 }).snapshot();
    default:
      assert.fail(`unknown state ${name}`);
  }
};
const STATES = ["ready", "working", "waiting", "context-warning", "long-model-zh"];

/** Session-ledger display states (usageScope: session); `unavailable` degrades to obs*. */
const SESSION_VIEWS = Object.freeze([
  ["ready", sessionView()],
  ["updating (rebuild in flight, old snapshot kept)", sessionView({ updating: true })],
  ["partial (missing fields/cost)", sessionView({ fieldsIncomplete: true, costMissing: true, summaryMissingUsage: 2 })],
  ["loading (no totals yet)", sessionView({ status: "loading", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false, usageRecords: 0, examined: 0 })],
  ["limited (saturated sums)", sessionView({ limited: true })],
]);

const LONG_TITLE = "一个特别长的会话标题用于验收折行场景-visual-acceptance-long-session-title";
const DEMO_STATUSES = new Map([
  ["pi-goal", "goal active · automatic"],
  ["pi-hud", "surface footer"],
]);

const lines = [];
let rendered = 0;
const push = (...values) => lines.push(...values);
const header = (text) => push("", `== ${text} ==`);

/** Render through the production path, style with the production styler, verify width. */
const emit = (rows, styler, width, styled) => {
  const output = styled ? styleRows(rows, styler) : rows.map((row) => row.text);
  for (const line of output) {
    assert.ok(visibleWidth(line) <= width, `row exceeds ${width} columns: ${JSON.stringify(line)}`);
    rendered++;
    push(line);
  }
};
const widgetRows = (snapshot, config, width, styler, styled) => emit(formatHud(snapshot, config, width), styler, width, styled);
const footerRowsWith = (snapshot, config, width, styler, styled, statuses, identity = FOOTER_IDENTITY) => {
  emit(formatFooter(snapshot, config, width, identity), styler, width, styled);
  if (statuses) emit(formatStatusRows(statuses, config, width), styler, width, styled);
};

for (const background of backgrounds) {
  const base = { preset: "balanced", color: !plain, ascii };
  const styler = createStyler(THEME_STUBS[background], { color: !plain, palette: "pastel" });
  if (!plain) assert.equal(styler.variant, background, "the stub theme must select the requested variant");
  const palette = background === "light" ? PASTEL_LIGHT : PASTEL_DARK;

  push(
    `pi-hud visual demo — synthetic fixtures rendered by the production renderer`,
    `assumed terminal background: ${background} ${background === "dark" ? "(light theme text drives the real detection path)" : "(dark theme text drives the real detection path)"}`,
    `palette: pastel ${background} · mode: ${colorMode}${ascii ? " · ASCII marks" : ""}${plain ? " · plain (no colors)" : ""}`,
    `This is a viewing aid for a human observer; it is NOT an acceptance record (see docs/VISUAL-ACCEPTANCE.zh-CN.md).`,
  );

  header(`palette roles (${background} background)`);
  push("Each field color must be readable on your actual terminal background:");
  for (const role of HUD_ROLES) {
    const sample = `${role} sample text`;
    push(`  ${plain ? sample : styler.style(role, sample)}  ${palette[role]}`);
  }

  if (surfaces.includes("widget")) {
    for (const language of languages) {
      for (const preset of presets) {
        const config = normalizeConfig({ ...base, preset, language });
        header(`widget / ${language} / ${preset} / ${widths.join(",")} columns / working state`);
        const snapshot = stateFor("working");
        for (const width of widths) {
          push(`-- ${width} columns`);
          widgetRows(snapshot, config, width, styler, !plain);
        }
      }
    }
  }

  if (surfaces.includes("footer")) {
    for (const language of languages) {
      for (const preset of presets) {
        const config = normalizeConfig({ ...base, preset, language });
        header(`footer / ${language} / ${preset} / ${widths.join(",")} columns / working state / extension statuses`);
        const snapshot = stateFor("working");
        for (const width of widths) {
          push(`-- ${width} columns`);
          footerRowsWith(snapshot, config, width, styler, !plain, DEMO_STATUSES);
        }
      }
    }
  }

  header(`acceptance states / balanced / ${widths.join(",")} columns / en${languages.includes("zh-CN") ? " + zh-CN where noted" : ""}`);
  for (const name of STATES) {
    const snapshot = stateFor(name);
    const language = name === "long-model-zh" ? (languages.includes("zh-CN") ? "zh-CN" : "en") : "en";
    const config = normalizeConfig({ ...base, language });
    push(`-- ${name}${name === "long-model-zh" && language === "en" ? " (labels en; run --language zh-CN for zh-CN labels)" : ""}`);
    if (surfaces.includes("widget")) widgetRows(snapshot, config, widths[0], styler, !plain);
    if (surfaces.includes("footer")) footerRowsWith(snapshot, config, widths[0], styler, !plain, DEMO_STATUSES);
  }

  header(`footer long session title and status folding / balanced / 80 columns`);
  {
    const config = normalizeConfig({ ...base });
    const snapshot = stateFor("working");
    if (surfaces.includes("footer")) {
      footerRowsWith(snapshot, config, 80, styler, !plain, DEMO_STATUSES, { ...FOOTER_IDENTITY, title: LONG_TITLE });
      const many = new Map();
      for (let index = 0; index < 20; index++) many.set(`ext-${index}`, `status text number ${index}`);
      push("-- 20 extension statuses fold into +N");
      footerRowsWith(snapshot, config, 80, styler, !plain, many);
    }
    if (surfaces.includes("widget")) {
      push("-- widget rows are unaffected by the session title");
      widgetRows(snapshot, config, 80, styler, !plain);
    }
  }

  header(`usageScope: session display states / full preset / 120 columns / en`);
  {
    const sessionConfig = normalizeConfig({ ...base, preset: "full", usageScope: "session" });
    for (const [name, view] of SESSION_VIEWS) {
      const snapshot = stateFor("working");
      snapshot.sessionUsage = view;
      push(`-- ${name}`);
      if (surfaces.includes("widget")) widgetRows(snapshot, sessionConfig, 120, styler, !plain);
      if (surfaces.includes("footer")) footerRowsWith(snapshot, sessionConfig, 120, styler, !plain, DEMO_STATUSES);
    }
    push("-- unavailable (host lacks the read-only surface): explicitly degrades to obs* labels");
    const degraded = stateFor("working");
    if (surfaces.includes("widget")) widgetRows(degraded, sessionConfig, 120, styler, !plain);
    if (surfaces.includes("footer")) footerRowsWith(degraded, sessionConfig, 120, styler, !plain, DEMO_STATUSES);
    push("-- narrow truncation keeps the sess* scope and ↻/+?/limited* markers (40 columns)");
    const clipped = stateFor("working");
    clipped.sessionUsage = sessionView({ fieldsIncomplete: true, updating: true, limited: true });
    const narrow = normalizeConfig({ ...base, preset: "full", usageScope: "session" });
    if (surfaces.includes("widget")) widgetRows(clipped, narrow, 40, styler, !plain);
    if (surfaces.includes("footer")) footerRowsWith(clipped, narrow, 40, styler, !plain, DEMO_STATUSES);
  }

  push(
    "",
    `technical self-check: ${rendered} rows rendered, every row within its requested width.`,
    `Contrast, legibility, color distinctness and real-terminal behavior are NOT checked here;`,
    `record those judgments yourself per docs/VISUAL-ACCEPTANCE.zh-CN.md.`,
    "",
  );
}

const output = lines.join("\n") + "\n";
if (!plain) assert.ok(output.includes("\x1b["), "colored mode must emit ANSI escapes");
else assert.ok(!output.includes("\x1b["), "plain mode must not emit ANSI escapes");
process.stdout.write(output);
