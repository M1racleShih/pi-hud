/**
 * Semantic role colors. `render.ts` lays out plain text and decides the terminal-cell
 * width first; this module only turns an already-laid-out role into a styled segment.
 * Pure and bounded: no I/O, no host mutation, no runtime dependencies.
 *
 * `pastel` uses the HUD's own candidates from the visual plan, with a deeper same-family
 * variant for light terminals. `theme` reuses host theme tokens so the HUD blends into a
 * user theme. `mono` (and `color: false`) returns the text unchanged.
 */
import type { HudConfig, HudPalette } from "./config.ts";

export type HudRole =
  | "model" | "thinking" | "path" | "git" | "phase" | "context" | "body"
  | "label" | "separator" | "success" | "warning" | "error" | "barUsed" | "barEmpty"
  | "thinkOff" | "thinkMinimal" | "thinkLow" | "thinkMedium" | "thinkHigh" | "thinkXhigh" | "thinkMax";

/** Fixed role set: the renderer cannot invent roles, so styling stays bounded. */
export const HUD_ROLES: readonly HudRole[] = Object.freeze([
  "model", "thinking", "path", "git", "phase", "context", "body",
  "label", "separator", "success", "warning", "error", "barUsed", "barEmpty",
  "thinkOff", "thinkMinimal", "thinkLow", "thinkMedium", "thinkHigh", "thinkXhigh", "thinkMax",
]);

export type TerminalVariant = "dark" | "light";
export type ColorMode = "truecolor" | "256color";

/** Thinking-level ramp for dark terminals (Catppuccin Macchiato family). The four
 * single colors deliberately alternate hue families — gray, rosewater, sky, pink — so
 * adjacent levels stay distinguishable even on lossy terminals; the three high tiers
 * render as the per-character rainbow instead (THINKING_RAINBOW_*), and their hexes here
 * exist only for table completeness. */
export const PASTEL_DARK: Readonly<Record<HudRole, string>> = Object.freeze({
  model: "#e5c890", thinking: "#d8c39a", path: "#a6d189", git: "#8caaee",
  phase: "#ca9ee6", context: "#ef9f76", body: "#c6d0f5",
  label: "#838ba7", separator: "#838ba7", success: "#a6d189", warning: "#f9e2af",
  error: "#e78284", barUsed: "#ef9f76", barEmpty: "#6c7086",
  thinkOff: "#8087a2", thinkMinimal: "#f4dbd6", thinkLow: "#91d7e3", thinkMedium: "#ed8796",
  thinkHigh: "#ca9ee6", thinkXhigh: "#ed8796", thinkMax: "#eed49f",
});

/** Deeper same-family variants for light terminals (Catppuccin Latte family). */
export const PASTEL_LIGHT: Readonly<Record<HudRole, string>> = Object.freeze({
  model: "#df8e1d", thinking: "#c08a2e", path: "#40a02b", git: "#1e66f5",
  phase: "#8839ef", context: "#fe640b", body: "#4c4f69",
  label: "#9ca0b0", separator: "#9ca0b0", success: "#40a02b", warning: "#9a6700",
  error: "#d20f39", barUsed: "#fe640b", barEmpty: "#ccd0da",
  thinkOff: "#7c7f93", thinkMinimal: "#dc8a78", thinkLow: "#04a5e5", thinkMedium: "#ea76cb",
  thinkHigh: "#8839ef", thinkXhigh: "#ea76cb", thinkMax: "#df8e1d",
});

/** Host theme tokens keep per-field distinction without overriding the user's theme. */
export type ThemeColorName =
  | "accent" | "thinkingText" | "success" | "mdLink" | "customMessageLabel"
  | "mdHeading" | "text" | "muted" | "dim" | "warning" | "error"
  | "thinkingOff" | "thinkingMinimal" | "thinkingLow" | "thinkingMedium"
  | "thinkingHigh" | "thinkingXhigh" | "thinkingMax";

export const THEME_ROLES: Readonly<Record<HudRole, ThemeColorName>> = Object.freeze({
  model: "accent", thinking: "thinkingText", path: "success", git: "mdLink",
  phase: "customMessageLabel", context: "mdHeading", body: "text",
  label: "muted", separator: "dim", success: "success", warning: "warning",
  error: "error", barUsed: "mdHeading", barEmpty: "dim",
  thinkOff: "thinkingOff", thinkMinimal: "thinkingMinimal", thinkLow: "thinkingLow",
  thinkMedium: "thinkingMedium", thinkHigh: "thinkingHigh", thinkXhigh: "thinkingXhigh",
  thinkMax: "thinkingMax",
});

/** Structural host theme surface; only the fields the renderer actually needs. */
export interface HudThemeLike {
  fg?(color: string, text: string): string;
  getColorMode?(): string;
  getFgAnsi?(color: string): string;
}

export interface HudStyler {
  readonly palette: HudPalette;
  readonly variant: TerminalVariant;
  readonly mode: ColorMode;
  style(role: HudRole, text: string): string;
}

const RESET_FG = "\x1b[39m";
const CUBE = [0, 95, 135, 175, 215, 255];
const GRAY = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

export function hexToRgb(hex: unknown): [number, number, number] | null {
  if (typeof hex !== "string" || !/^#?[0-9a-fA-F]{6}$/.test(hex)) return null;
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

const closest = (value: number, values: number[]): number => {
  let best = 0;
  let distance = Infinity;
  for (let index = 0; index < values.length; index++) {
    const next = Math.abs(value - values[index]);
    if (next < distance) { distance = next; best = index; }
  }
  return best;
};

/** Same 6×6×6 cube plus grayscale ramp convention Pi uses for 256-color terminals. */
export function rgbTo256(r: number, g: number, b: number): number {
  const rIdx = closest(r, CUBE);
  const gIdx = closest(g, CUBE);
  const bIdx = closest(b, CUBE);
  const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
  const cubeDistance = Math.abs(r - CUBE[rIdx]) + Math.abs(g - CUBE[gIdx]) + Math.abs(b - CUBE[bIdx]);
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const grayIndex = 232 + closest(gray, GRAY);
  const grayDistance = Math.abs(gray - GRAY[closest(gray, GRAY)]);
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return spread < 10 && grayDistance < cubeDistance ? grayIndex : cubeIndex;
}

/** Prefix-only so a styled segment can reset just the foreground, like `theme.fg`. */
export function ansiForHex(hex: string, mode: ColorMode): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "";
  const [r, g, b] = rgb;
  return mode === "256color" ? `\x1b[38;5;${rgbTo256(r, g, b)}m` : `\x1b[38;2;${r};${g};${b}m`;
}

/* The three high thinking tiers render as a per-character rainbow (pi-powerline-footer's
 * ultrathink homage). Both tables stay inside the HUD's Catppuccin family; the fixed hexes
 * are also used for the `theme` palette, which has no rainbow token to follow. */
export const THINKING_RAINBOW_ROLES: ReadonlySet<HudRole> = Object.freeze(new Set<HudRole>(["thinkHigh", "thinkXhigh", "thinkMax"]));
/** Macchiato accents for dark terminals: mauve, pink, yellow, green, teal, blue. */
export const THINKING_RAINBOW_DARK: readonly string[] = Object.freeze(["#ca9ee6", "#ed8796", "#eed49f", "#a6d189", "#81c8be", "#8caaee"]);
/** Latte accents for light terminals: mauve, pink, yellow, green, teal, blue. */
export const THINKING_RAINBOW_LIGHT: readonly string[] = Object.freeze(["#8839ef", "#ea76cb", "#df8e1d", "#40a02b", "#179299", "#1e66f5"]);

/** Saturation ladder for the three rainbow tiers: high pastel, xhigh richer, max vivid. */
export const THINKING_RAINBOW_SATURATION: Readonly<Record<string, number>> = Object.freeze({ high: 1, xhigh: 1.4, max: 1.9 });
/** Role -> ladder step; every rainbow role maps to exactly one tier. */
export const THINKING_RAINBOW_TIER: Readonly<Record<string, number>> = Object.freeze({
  thinkHigh: THINKING_RAINBOW_SATURATION.high!,
  thinkXhigh: THINKING_RAINBOW_SATURATION.xhigh!,
  thinkMax: THINKING_RAINBOW_SATURATION.max!,
});

/* HSL helpers for the saturation ladder: pure hex math, no I/O, results cached per tier. */
const rgbToHsl = ([r, g, b]: [number, number, number]): [number, number, number] => {
  const red = r / 255, green = g / 255, blue = b / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  let hue = 0, saturation = 0;
  const delta = max - min;
  if (delta > 0) {
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue /= 6;
  }
  return [hue, saturation, lightness];
};
const hueToRgbChannel = (p: number, q: number, t: number): number => {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};
const saturateHex = (hex: string, factor: number): string => {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [hue, saturation, lightness] = rgbToHsl(rgb);
  const next = Math.min(1, saturation * factor);
  if (lightness >= 1 || next <= 0) return hex; // achromatic: nothing to saturate
  const q = lightness < 0.5 ? lightness * (1 + next) : lightness + next - lightness * next;
  const p = 2 * lightness - q;
  const channel = (offset: number) => Math.round(hueToRgbChannel(p, q, (hue + offset) % 1) * 255);
  // Standard HSL->RGB channel order: red at h+1/3, green at h, blue at h+2/3.
  return `#${[channel(1 / 3), channel(0), channel(2 / 3)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

/* Eager, immutable tier tables (2 variants x 3 tiers x 6 hues): tiny and pure. */
const RAINBOW_TABLES: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(
  (["dark", "light"] as const).flatMap((variant) =>
    Object.values(THINKING_RAINBOW_SATURATION).map((factor) => [
      `${variant}:${factor}`,
      Object.freeze((variant === "light" ? THINKING_RAINBOW_LIGHT : THINKING_RAINBOW_DARK).map((hex) => saturateHex(hex, factor))),
    ]),
  ),
));
export const thinkingRainbowColors = (variant: TerminalVariant, saturation: number): readonly string[] =>
  RAINBOW_TABLES[`${variant}:${saturation}`] ?? (variant === "light" ? THINKING_RAINBOW_LIGHT : THINKING_RAINBOW_DARK);

/**
 * One rainbow pass over an already-laid-out thinking label. Separators (spaces, colons)
 * keep the surrounding color cycle instead of consuming a hue, and every character is
 * prefixed independently, so the visible width never changes. Bounded: the field is at
 * most 16 cells, the cycle at most 6 hexes. The three high tiers share one hue cycle but
 * climb a saturation ladder (high = pastel, xhigh richer, max near-vivid), so the tier
 * stays readable without any extra marker.
 */
export function thinkingRainbow(text: string, variant: TerminalVariant, mode: ColorMode, saturation = 1): string {
  if (!text) return text;
  const colors = thinkingRainbowColors(variant, saturation);
  let result = "";
  let index = 0;
  for (const char of text) {
    if (char === " " || char === ":") { result += char; continue; }
    result += ansiForHex(colors[index % colors.length]!, mode) + char;
    index++;
  }
  return result + RESET_FG;
}

const xterm256ToRgb = (index: number): [number, number, number] => {
  if (index >= 232) { const value = GRAY[Math.min(23, index - 232)]; return [value, value, value]; }
  if (index >= 16) {
    const offset = index - 16;
    return [CUBE[Math.floor(offset / 36) % 6], CUBE[Math.floor(offset / 6) % 6], CUBE[offset % 6]];
  }
  const basic: [number, number, number][] = [
    [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128],
    [0, 128, 128], [192, 192, 192], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
    [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
  ];
  return basic[index] ?? [255, 255, 255];
};

const toLinear = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, matching Pi's own background detection. */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function parseAnsiRgb(ansi: unknown): [number, number, number] | null {
  if (typeof ansi !== "string") return null;
  const truecolor = /38;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
  if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
  const indexed = /38;5;(\d{1,3})m/.exec(ansi);
  return indexed ? xterm256ToRgb(Number(indexed[1])) : null;
}

/**
 * The host footer/theme does not expose a light/dark flag directly, so the terminal
 * variant is inferred from the theme's text color: light text implies a dark background.
 * Unknown themes default to the dark candidates without throwing.
 */
export function detectTerminalVariant(theme: HudThemeLike | null | undefined): TerminalVariant {
  try {
    const rgb = parseAnsiRgb(theme?.getFgAnsi?.("text"));
    if (!rgb) return "dark";
    return relativeLuminance(rgb) >= 0.5 ? "dark" : "light";
  } catch {
    return "dark";
  }
}

function detectColorMode(theme: HudThemeLike | null | undefined): ColorMode {
  try {
    return theme?.getColorMode?.() === "256color" ? "256color" : "truecolor";
  } catch {
    return "truecolor";
  }
}

const plainStyler = (palette: HudPalette): HudStyler => ({
  palette, variant: "dark", mode: "truecolor", style: (_role, text) => text,
});

/** The four pastel prefix tables are immutable, so build each at most once. */
const prefixCache = new Map<string, ReadonlyMap<HudRole, string>>();
function pastelPrefixes(variant: TerminalVariant, mode: ColorMode): ReadonlyMap<HudRole, string> {
  const key = `${variant}:${mode}`;
  let table = prefixCache.get(key);
  if (!table) {
    const colors = variant === "light" ? PASTEL_LIGHT : PASTEL_DARK;
    const map = new Map<HudRole, string>();
    for (const role of HUD_ROLES) map.set(role, ansiForHex(colors[role], mode));
    table = map;
    prefixCache.set(key, table);
  }
  return table;
}

/**
 * Resolve one palette for the current theme. The returned styler is pure and reusable;
 * callers must rebuild it when `invalidate()` reports a theme change so a light/dark
 * switch is re-detected.
 */
export function createStyler(theme: HudThemeLike | null | undefined, config: Pick<HudConfig, "color" | "palette">): HudStyler {
  const palette: HudPalette = config.palette === "theme" || config.palette === "mono" ? config.palette : "pastel";
  if (config.color === false || palette === "mono") return plainStyler(palette);
  if (palette === "theme") {
    const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : null;
    const variant = detectTerminalVariant(theme);
    const mode = detectColorMode(theme);
    return {
      palette, variant, mode,
      style: (role, text) => {
        if (!text) return text;
        // The rainbow is palette-fixed: the host theme has no per-tier rainbow token, so
        // high tiers reuse the same Catppuccin cycle (with its own saturation ladder) as
        // the pastel palette.
        if (THINKING_RAINBOW_ROLES.has(role)) return thinkingRainbow(text, variant, mode, THINKING_RAINBOW_TIER[role] ?? 1);
        if (!fg) return text;
        // A custom theme missing one token must degrade that field, not the whole HUD.
        try { return fg(THEME_ROLES[role], text); } catch { return text; }
      },
    };
  }
  const variant = detectTerminalVariant(theme);
  const mode = detectColorMode(theme);
  const prefixes = pastelPrefixes(variant, mode);
  return {
    palette, variant, mode,
    style: (role, text) => {
      if (!text) return text;
      if (THINKING_RAINBOW_ROLES.has(role)) return thinkingRainbow(text, variant, mode, THINKING_RAINBOW_TIER[role] ?? 1);
      const prefix = prefixes.get(role);
      return prefix ? `${prefix}${text}${RESET_FG}` : text;
    },
  };
}
