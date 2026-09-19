import { stripVTControlCharacters } from "node:util";

let segmenter: Intl.Segmenter | undefined;
const mark = /^\p{Mark}$/u;
const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

/** Cap BEFORE parsing controls; never retain tool output or unbounded strings. */
export function safeText(value: unknown, limit = 100): string {
  if (typeof value !== "string") return "";
  const cap = Math.max(0, Math.min(512, limit));
  const text = stripVTControlCharacters(value.slice(0, Math.min(1_024, cap * 4 + 64)))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ").trim();
  // Do not split a UTF-16 surrogate pair.
  let result = text.slice(0, cap);
  if (/[\ud800-\udbff]$/.test(result)) result = result.slice(0, -1);
  return result;
}

export function baseName(value: unknown, limit = 48): string {
  // Keep the TAIL, so a long path still shows its basename; the retained input is bounded.
  const raw = typeof value === "string" ? value.slice(-512) : "";
  const parts = raw.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return safeText(parts.at(-1), limit) || "/";
}

/**
 * Abbreviate an absolute path for display without touching the filesystem. The home
 * prefix becomes `~`; an over-long path keeps its tail (the innermost directory) because
 * that is the part a reader can identify. Called at lifecycle boundaries, never in render.
 */
export function displayPath(value: unknown, home: unknown, limit = 72): string {
  const raw = typeof value === "string" ? value.slice(0, 1_024).replace(/\\/g, "/") : "";
  if (!raw) return "";
  let candidate = raw;
  const base = typeof home === "string" ? home.slice(0, 1_024).replace(/\\/g, "/").replace(/\/+$/, "") : "";
  if (base && (raw === base || raw.startsWith(`${base}/`))) candidate = `~${raw.slice(base.length)}`;
  return safeText(candidate.slice(-Math.max(1, limit) * 2), limit);
}

function wide(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1b000 && code <= 0x1b2ff) || (code >= 0x20000 && code <= 0x3fffd)
  );
}

function graphemes(text: string): Intl.Segments {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return segmenter.segment(text);
}

/**
 * A code point that can merge with a neighbour into one grapheme cluster, or whose
 * cluster needs the emoji rule. Anything else is its own grapheme, so the plain
 * per-code-point sum below is already exact and no segmenter run is needed.
 */
const cluster = /[\p{Mark}\u200d\ufe0f\ufe0e\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

function cells(grapheme: string): number {
  if (emoji.test(grapheme)) return 2;
  let count = 0;
  for (const char of grapheme) {
    if (mark.test(char) || char === "\u200d" || char === "\ufe0f" || char === "\ufe0e") continue;
    const point = char.codePointAt(0) ?? 0;
    if (point < 32 || (point >= 0x7f && point < 0xa0)) continue;
    count += wide(point) ? 2 : 1;
  }
  return count;
}

function graphemeWidth(text: string): number {
  let count = 0;
  for (const item of graphemes(text)) count += cells(item.segment);
  return count;
}

/**
 * Common terminal-cell convention: CJK/emoji wide, ambiguous characters narrow.
 * Pure ASCII and simple mixed text (for example the HUD's own `✓`/`↑`/`░` glyphs)
 * take the per-code-point path; only real cluster candidates pay for `Intl.Segmenter`.
 */
export function visibleWidth(text: string): number {
  const plain = stripVTControlCharacters(text);
  if (/^[\x20-\x7e]*$/.test(plain)) return plain.length;
  let count = 0;
  for (const char of plain) {
    if (cluster.test(char)) return graphemeWidth(plain);
    const point = char.codePointAt(0) ?? 0;
    if (point < 32 || (point >= 0x7f && point < 0xa0)) continue;
    count += wide(point) ? 2 : 1;
  }
  return count;
}

export function clip(text: string, width: number, ascii = false): string {
  width = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
  if (!width) return "";
  if (visibleWidth(text) <= width) return text;
  const suffix = ascii ? "." : "…";
  const available = width - 1;
  // ASCII code points are all single-width, so assignment cannot split a cluster.
  if (/^[\x20-\x7e]*$/.test(text)) return text.slice(0, available) + suffix;
  let out = "";
  let used = 0;
  for (const item of graphemes(text)) {
    const size = cells(item.segment);
    if (used + size > available) break;
    out += item.segment;
    used += size;
  }
  return out + suffix;
}

export function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return String(Math.round(value));
}
