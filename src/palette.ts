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
  | "label" | "separator" | "success" | "warning" | "error" | "barUsed" | "barEmpty";

/** Fixed role set: the renderer cannot invent roles, so styling stays bounded. */
export const HUD_ROLES: readonly HudRole[] = Object.freeze([
  "model", "thinking", "path", "git", "phase", "context", "body",
  "label", "separator", "success", "warning", "error", "barUsed", "barEmpty",
]);

export type TerminalVariant = "dark" | "light";
export type ColorMode = "truecolor" | "256color";

/** Dark-terminal pastel candidates from the approved visual plan (Catppuccin Macchiato family). */
export const PASTEL_DARK: Readonly<Record<HudRole, string>> = Object.freeze({
  model: "#e5c890", thinking: "#d8c39a", path: "#a6d189", git: "#8caaee",
  phase: "#ca9ee6", context: "#ef9f76", body: "#c6d0f5",
  label: "#838ba7", separator: "#838ba7", success: "#a6d189", warning: "#f9e2af",
  error: "#e78284", barUsed: "#ef9f76", barEmpty: "#6c7086",
});

/** Deeper same-family variants for light terminals (Catppuccin Latte family). */
export const PASTEL_LIGHT: Readonly<Record<HudRole, string>> = Object.freeze({
  model: "#df8e1d", thinking: "#c08a2e", path: "#40a02b", git: "#1e66f5",
  phase: "#8839ef", context: "#fe640b", body: "#4c4f69",
  label: "#9ca0b0", separator: "#9ca0b0", success: "#40a02b", warning: "#9a6700",
  error: "#d20f39", barUsed: "#fe640b", barEmpty: "#ccd0da",
});

/** Host theme tokens keep per-field distinction without overriding the user's theme. */
export type ThemeColorName =
  | "accent" | "thinkingText" | "success" | "mdLink" | "customMessageLabel"
  | "mdHeading" | "text" | "muted" | "dim" | "warning" | "error";

export const THEME_ROLES: Readonly<Record<HudRole, ThemeColorName>> = Object.freeze({
  model: "accent", thinking: "thinkingText", path: "success", git: "mdLink",
  phase: "customMessageLabel", context: "mdHeading", body: "text",
  label: "muted", separator: "dim", success: "success", warning: "warning",
  error: "error", barUsed: "mdHeading", barEmpty: "dim",
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
    return {
      palette, variant: detectTerminalVariant(theme), mode: detectColorMode(theme),
      style: (role, text) => {
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
      const prefix = prefixes.get(role);
      return text && prefix ? `${prefix}${text}${RESET_FG}` : text;
    },
  };
}
