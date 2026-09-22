import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
  HUD_ROLES, PASTEL_DARK, PASTEL_LIGHT, THEME_ROLES, THINKING_RAINBOW_DARK, THINKING_RAINBOW_LIGHT, THINKING_RAINBOW_SATURATION,
  ansiForHex, createStyler, detectTerminalVariant, hexToRgb, relativeLuminance, rgbTo256, thinkingRainbowColors,
} from "../src/palette.ts";

const DARK_TEXT = "\u001b[38;2;212;212;212m";
const LIGHT_TEXT = "\u001b[38;2;31;35;40m";
const theme = (mode = "truecolor", text = DARK_TEXT) => ({ getColorMode: () => mode, getFgAnsi: () => text });
const ANSI = /^\u001b\[38;(?:2;\d{1,3};\d{1,3};\d{1,3}|5;\d{1,3})m/;

test("every role exists in every palette table with a usable value", () => {
  assert.equal(HUD_ROLES.length, 21);
  for (const role of HUD_ROLES) {
    assert.ok(hexToRgb(PASTEL_DARK[role]), `dark ${role}`);
    assert.ok(hexToRgb(PASTEL_LIGHT[role]), `light ${role}`);
    assert.match(THEME_ROLES[role], /^[a-zA-Z][a-zA-Z0-9]*$/, `theme ${role}`);
  }
  assert.deepEqual(Object.keys(PASTEL_DARK).sort(), [...HUD_ROLES].sort());
  assert.deepEqual(Object.keys(PASTEL_LIGHT).sort(), [...HUD_ROLES].sort());
  assert.deepEqual(Object.keys(THEME_ROLES).sort(), [...HUD_ROLES].sort());
});
test("model, path, git, phase, context and separators are visually distinct", () => {
  const fields = ["model", "path", "git", "phase", "context"];
  for (const table of [PASTEL_DARK, PASTEL_LIGHT, THEME_ROLES]) {
    const used = new Set(fields.map((role) => table[role]));
    assert.equal(used.size, fields.length, `duplicate field color in ${JSON.stringify(table)}`);
    assert.ok(!used.has(table.separator));
  }
  assert.notEqual(PASTEL_DARK.label, PASTEL_DARK.body);
  assert.equal(PASTEL_DARK.barUsed, PASTEL_DARK.context, "the used bar shares the context field color");
  assert.notEqual(PASTEL_DARK.barEmpty, PASTEL_DARK.barUsed);
  assert.equal(PASTEL_DARK.error, "#e78284");
  assert.equal(PASTEL_DARK.success, "#a6d189");
});
test("pastel palettes use the approved dark candidates and deeper light variants", () => {
  assert.equal(PASTEL_DARK.model, "#e5c890");
  assert.equal(PASTEL_DARK.path, "#a6d189");
  assert.equal(PASTEL_DARK.git, "#8caaee");
  assert.equal(PASTEL_DARK.phase, "#ca9ee6");
  assert.equal(PASTEL_DARK.context, "#ef9f76");
  assert.notEqual(PASTEL_DARK.model, PASTEL_LIGHT.model);
  assert.ok(relativeLuminance(hexToRgb(PASTEL_LIGHT.model)) < relativeLuminance(hexToRgb(PASTEL_DARK.model)));
});
test("hex parsing and 256-color conversion follow the xterm cube and gray ramp", () => {
  assert.deepEqual(hexToRgb("#e5c890"), [229, 200, 144]);
  assert.deepEqual(hexToRgb("e5c890"), [229, 200, 144]);
  for (const bad of ["", "#fff", "#gggggg", 12, null, undefined, "rgb(1,2,3)"]) assert.equal(hexToRgb(bad), null);
  assert.equal(rgbTo256(229, 200, 144), 186);
  assert.equal(rgbTo256(128, 128, 128), 244, "neutral colors prefer the grayscale ramp");
  assert.equal(ansiForHex("#e5c890", "truecolor"), "\u001b[38;2;229;200;144m");
  assert.equal(ansiForHex("#e5c890", "256color"), "\u001b[38;5;186m");
  assert.equal(ansiForHex("nope", "truecolor"), "");
});
test("terminal variant is inferred from the host text color, defaulting to dark", () => {
  assert.equal(detectTerminalVariant(theme("truecolor", DARK_TEXT)), "dark");
  assert.equal(detectTerminalVariant(theme("truecolor", LIGHT_TEXT)), "light");
  assert.equal(detectTerminalVariant(theme("256color", "\u001b[38;5;231m")), "dark");
  assert.equal(detectTerminalVariant(theme("256color", "\u001b[38;5;16m")), "light");
  assert.equal(detectTerminalVariant(theme("256color", "\u001b[38;5;9m")), "light", "basic red is a dark text color");
  assert.equal(detectTerminalVariant(theme("256color", "\u001b[38;5;15m")), "dark", "basic white is a light text color");
  assert.equal(detectTerminalVariant(theme("256color", "\u001b[38;5;244m")), "light", "the grayscale ramp is parsed too");
  assert.equal(detectTerminalVariant(null), "dark");
  assert.equal(detectTerminalVariant({}), "dark");
  assert.equal(detectTerminalVariant({ getFgAnsi() { throw new Error("boom"); } }), "dark");
  assert.equal(detectTerminalVariant({ getFgAnsi: () => "\u001b[39m" }), "dark");
});
test("color:false and mono never colorize, whatever the theme offers", () => {
  const fg = () => { throw new Error("must not be called"); };
  for (const config of [{ color: false, palette: "pastel" }, { color: true, palette: "mono" }, { color: false, palette: "mono" }]) {
    const styler = createStyler({ fg, getColorMode: fg, getFgAnsi: fg }, config);
    assert.equal(styler.palette, config.palette);
    assert.equal(styler.style("model", "[M]"), "[M]");
    assert.equal(styler.style("error", "!1"), "!1");
  }
});
test("pastel styling wraps each segment with the role color and a foreground reset", () => {
  const styler = createStyler(theme(), { color: true, palette: "pastel" });
  assert.equal(styler.variant, "dark");
  assert.equal(styler.mode, "truecolor");
  assert.equal(styler.style("model", "[M]"), "\u001b[38;2;229;200;144m[M]\u001b[39m");
  assert.equal(styler.style("path", "pi-hud"), "\u001b[38;2;166;209;137mpi-hud\u001b[39m");
  assert.equal(styler.style("separator", " · "), "\u001b[38;2;131;139;167m · \u001b[39m");
  assert.equal(styler.style("model", ""), "");
  const light = createStyler(theme("truecolor", LIGHT_TEXT), { color: true, palette: "pastel" });
  assert.equal(light.variant, "light");
  assert.equal(light.style("model", "[M]"), "\u001b[38;2;223;142;29m[M]\u001b[39m");
  const indexed = createStyler(theme("256color"), { color: true, palette: "pastel" });
  assert.equal(indexed.mode, "256color");
  assert.equal(indexed.style("model", "[M]"), "\u001b[38;5;186m[M]\u001b[39m");
});
test("pastel styling survives a theme without mode or color queries", () => {
  const styler = createStyler({}, { color: true, palette: "pastel" });
  assert.equal(styler.mode, "truecolor");
  assert.equal(styler.variant, "dark");
  const throwing = createStyler({ getColorMode() { throw new Error("x"); }, getFgAnsi() { throw new Error("x"); } }, { color: true, palette: "pastel" });
  assert.equal(throwing.mode, "truecolor");
  assert.equal(throwing.variant, "dark");
});
test("theme palette maps each role to a host token and degrades field-by-field", () => {
  const calls = [];
  const styler = createStyler({ fg: (color, text) => { calls.push(color); return `<${color}>${text}`; }, getColorMode: () => "truecolor", getFgAnsi: () => DARK_TEXT }, { color: true, palette: "theme" });
  assert.equal(styler.style("model", "[M]"), "<accent>[M]");
  assert.equal(styler.style("path", "p"), "<success>p");
  assert.equal(styler.style("git", "g"), "<mdLink>g");
  assert.equal(styler.style("phase", "●"), "<customMessageLabel>●");
  assert.equal(styler.style("context", "45%"), "<mdHeading>45%");
  assert.equal(styler.style("separator", " · "), "<dim> · ");
  assert.deepEqual(calls, ["accent", "success", "mdLink", "customMessageLabel", "mdHeading", "dim"]);
  assert.equal(createStyler(null, { color: true, palette: "theme" }).style("model", "[M]"), "[M]");
  const broken = createStyler({ fg() { throw new Error("no such token"); } }, { color: true, palette: "theme" });
  assert.equal(broken.style("model", "[M]"), "[M]");
  assert.equal(broken.style("error", "!1"), "!1");
});
test("deep pastel roles use distinct alert colors that do not leak into normal fields", () => {
  const styler = createStyler(theme(), { color: true, palette: "pastel" });
  const model = styler.style("model", "x");
  for (const role of ["success", "warning", "error"]) {
    const styled = styler.style(role, "x");
    assert.match(styled, ANSI);
    assert.notEqual(styled, model);
  }
  assert.notEqual(styler.style("error", "x"), styler.style("warning", "x"));
});

// ---------------------------------------------------------------------------
// Thinking-level roles: per-level colors through medium, rainbow above.
// ---------------------------------------------------------------------------

const RESET = "\u001b[39m";
const LEVEL_ROLES = { off: "thinkOff", minimal: "thinkMinimal", low: "thinkLow", medium: "thinkMedium", high: "thinkHigh", xhigh: "thinkXhigh", max: "thinkMax" };

test("thinking levels map to distinct single colors through medium in both variants", () => {
  for (const table of [PASTEL_DARK, PASTEL_LIGHT]) {
    const singles = ["thinkOff", "thinkMinimal", "thinkLow", "thinkMedium"].map((role) => table[role]);
    assert.equal(new Set(singles).size, 4, `duplicate level color in ${JSON.stringify(table)}`);
  }
  assert.equal(PASTEL_DARK.thinkOff, "#8087a2");
  assert.equal(PASTEL_DARK.thinkMedium, "#ed8796");
  assert.equal(PASTEL_LIGHT.thinkLow, "#04a5e5");
  // Adjacent levels alternate hue families (sky vs pink) so low and medium stay
  // distinguishable even on lossy terminals — a channel distance well beyond the
  // sky/teal pair this test replaced (which differed by ~40 in one channel only).
  for (const table of [PASTEL_DARK, PASTEL_LIGHT]) {
    const low = hexToRgb(table.thinkLow);
    const medium = hexToRgb(table.thinkMedium);
    const distance = Math.abs(low[0] - medium[0]) + Math.abs(low[1] - medium[1]) + Math.abs(low[2] - medium[2]);
    assert.ok(distance > 120, `low/medium too close in ${JSON.stringify(table)}: ${distance}`);
  }
  assert.deepEqual(
    Object.values(LEVEL_ROLES).map((role) => THEME_ROLES[role]),
    ["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax"],
  );
});
test("known low thinking levels style as one single-color segment", () => {
  const styler = createStyler(theme(), { color: true, palette: "pastel" });
  assert.equal(styler.style("thinkOff", "think:off"), `${ansiForHex(PASTEL_DARK.thinkOff, "truecolor")}think:off${RESET}`);
  assert.equal(styler.style("thinkMedium", "think:med"), `${ansiForHex(PASTEL_DARK.thinkMedium, "truecolor")}think:med${RESET}`);
});
test("high thinking tiers render the per-character rainbow, separators excluded", () => {
  const R = THINKING_RAINBOW_DARK.map((hex) => ansiForHex(hex, "truecolor"));
  const styler = createStyler(theme(), { color: true, palette: "pastel" });
  // t h i n k : h i g h -> the colon keeps the cycle going without consuming a hue.
  assert.equal(
    styler.style("thinkHigh", "think:high"),
    `${R[0]}t${R[1]}h${R[2]}i${R[3]}n${R[4]}k:${R[5]}h${R[0]}i${R[1]}g${R[2]}h${RESET}`,
  );
  // xhigh/max share the hue cycle at higher saturation steps (tested below).
  assert.equal(styler.style("thinkMax", ""), "");
  const light = createStyler(theme("truecolor", LIGHT_TEXT), { color: true, palette: "pastel" });
  const L = thinkingRainbowColors("light", THINKING_RAINBOW_SATURATION.high).map((hex) => ansiForHex(hex, "truecolor"));
  assert.equal(light.style("thinkHigh", "hi"), `${L[0]}h${L[1]}i${RESET}`);
});
test("the rainbow downconverts per character on 256-color terminals and never changes width", () => {
  const styler = createStyler(theme("256color"), { color: true, palette: "pastel" });
  const M = thinkingRainbowColors("dark", THINKING_RAINBOW_SATURATION.max).map((hex) => ansiForHex(hex, "256color"));
  assert.equal(
    styler.style("thinkMax", "think:max"),
    `${M[0]}t${M[1]}h${M[2]}i${M[3]}n${M[4]}k:${M[5]}m${M[0]}a${M[1]}x${RESET}`,
  );
  assert.match(styler.style("thinkHigh", "t"), /^\u001b\[38;5;\d{1,3}m/);
  const strip = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");
  for (const role of Object.values(LEVEL_ROLES)) {
    const line = styler.style(role, "think:med");
    assert.equal(strip(line), "think:med");
    assert.equal(stripVTControlCharacters(line), "think:med");
  }
});
test("theme palette maps levels to host thinking tokens and rainbows the high tiers", () => {
  const calls = [];
  const styler = createStyler({ fg: (color, text) => { calls.push(color); return `<${color}>${text}`; }, getColorMode: () => "truecolor", getFgAnsi: () => DARK_TEXT }, { color: true, palette: "theme" });
  assert.equal(styler.style("thinkOff", "think:off"), "<thinkingOff>think:off");
  assert.equal(styler.style("thinkLow", "think:low"), "<thinkingLow>think:low");
  assert.equal(styler.style("thinkMedium", "think:med"), "<thinkingMedium>think:med");
  assert.deepEqual(calls, ["thinkingOff", "thinkingLow", "thinkingMedium"]);
  // The rainbow is palette-fixed (the host theme has no rainbow token), so theme.fg is
  // never called for the high tiers; each tier climbs the saturation ladder.
  const R = THINKING_RAINBOW_DARK.map((hex) => ansiForHex(hex, "truecolor"));
  const tier = (name) => thinkingRainbowColors("dark", THINKING_RAINBOW_SATURATION[name]).map((hex) => ansiForHex(hex, "truecolor"));
  assert.equal(styler.style("thinkHigh", "hi"), `${R[0]}h${R[1]}i${RESET}`);
  assert.equal(styler.style("thinkXhigh", "hi"), `${tier("xhigh")[0]}h${tier("xhigh")[1]}i${RESET}`);
  assert.equal(styler.style("thinkMax", "hi"), `${tier("max")[0]}h${tier("max")[1]}i${RESET}`);
  assert.deepEqual(calls, ["thinkingOff", "thinkingLow", "thinkingMedium"]);
  // A theme without the tokens degrades that field only; the rainbow still works.
  const broken = createStyler({ fg() { throw new Error("no such token"); } }, { color: true, palette: "theme" });
  assert.equal(broken.style("thinkOff", "think:off"), "think:off");
  assert.equal(broken.style("thinkHigh", "hi"), `${R[0]}h${R[1]}i${RESET}`);
});
test("mono and color:false never colorize thinking roles, rainbow included", () => {
  const fg = () => { throw new Error("must not be called"); };
  for (const config of [{ color: false, palette: "pastel" }, { color: true, palette: "mono" }]) {
    const styler = createStyler({ fg, getColorMode: fg, getFgAnsi: fg }, config);
    assert.equal(styler.style("thinkOff", "think:off"), "think:off");
    assert.equal(styler.style("thinkMax", "think:max"), "think:max");
  }
});

test("the three rainbow tiers share hues but climb a visible saturation ladder", () => {
  const dark = createStyler(theme(), { color: true, palette: "pastel" });
  const tiers = [dark.style("thinkHigh", "think:high"), dark.style("thinkXhigh", "think:xhi"), dark.style("thinkMax", "think:max")];
  for (const styled of tiers) {
    assert.match(styled, ANSI);
    // Per-character prefixing survives in every tier.
    assert.ok(styled.match(/\u001b\[38;2;/g).length >= 3);
  }
  // Pairwise distinct: same hue cycle, different saturation steps.
  assert.notEqual(tiers[0], tiers[1]);
  assert.notEqual(tiers[1], tiers[2]);
  assert.notEqual(tiers[0], tiers[2]);
  // The ladder is monotonic: the xhigh and max first prefixes are the saturated
  // variants of the same mauve hue, never a hue change.
  const first = (styled) => styled.match(/\d{1,3};\d{1,3};\d{1,3}/)[0].split(";").map(Number);
  const [r1, g1, b1] = first(tiers[0]);
  const [r2, g2, b2] = first(tiers[1]);
  const [r3, g3, b3] = first(tiers[2]);
  const maxChroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);
  assert.ok(maxChroma([r2, g2, b2]) > maxChroma([r1, g1, b1]), "xhigh is more saturated than high");
  assert.ok(maxChroma([r3, g3, b3]) > maxChroma([r2, g2, b2]), "max is more saturated than xhigh");
  // The theme palette climbs the same ladder.
  const themed = createStyler({ fg: () => { throw new Error("rainbow must not call theme.fg"); }, getColorMode: () => "truecolor", getFgAnsi: () => DARK_TEXT }, { color: true, palette: "theme" });
  assert.notEqual(themed.style("thinkHigh", "think:high"), themed.style("thinkXhigh", "think:xhi"));
  assert.notEqual(themed.style("thinkXhigh", "think:xhi"), themed.style("thinkMax", "think:max"));
});
