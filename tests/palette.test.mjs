import test from "node:test";
import assert from "node:assert/strict";
import {
  HUD_ROLES, PASTEL_DARK, PASTEL_LIGHT, THEME_ROLES,
  ansiForHex, createStyler, detectTerminalVariant, hexToRgb, relativeLuminance, rgbTo256,
} from "../src/palette.ts";

const DARK_TEXT = "\u001b[38;2;212;212;212m";
const LIGHT_TEXT = "\u001b[38;2;31;35;40m";
const theme = (mode = "truecolor", text = DARK_TEXT) => ({ getColorMode: () => mode, getFgAnsi: () => text });
const ANSI = /^\u001b\[38;(?:2;\d{1,3};\d{1,3};\d{1,3}|5;\d{1,3})m/;

test("every role exists in every palette table with a usable value", () => {
  assert.equal(HUD_ROLES.length, 14);
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
