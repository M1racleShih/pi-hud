import { stripVTControlCharacters } from "node:util";

let segmenter;
const mark = /^\p{Mark}$/u;
const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

/** Cap BEFORE parsing controls; never retain tool output or unbounded strings. */
export function safeText(value, limit = 100) {
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

export function baseName(value, limit = 48) {
  // Keep the TAIL, so a long path still shows its basename; the retained input is bounded.
  const raw = typeof value === "string" ? value.slice(-512) : "";
  const parts = raw.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return safeText(parts.at(-1), limit) || "/";
}

function wide(code) {
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1b000 && code <= 0x1b2ff) || (code >= 0x20000 && code <= 0x3fffd)
  );
}

function graphemes(text) {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return segmenter.segment(text);
}

function cells(grapheme) {
  if (emoji.test(grapheme)) return 2;
  let count = 0;
  for (const char of grapheme) {
    if (mark.test(char) || char === "\u200d" || char === "\ufe0f" || char === "\ufe0e") continue;
    const point = char.codePointAt(0);
    if (point < 32 || (point >= 0x7f && point < 0xa0)) continue;
    count += wide(point) ? 2 : 1;
  }
  return count;
}

/** Common terminal-cell convention: CJK/emoji wide, ambiguous characters narrow. */
export function visibleWidth(text) {
  const plain = stripVTControlCharacters(text);
  if (/^[\x20-\x7e]*$/.test(plain)) return plain.length;
  let count = 0;
  for (const item of graphemes(plain)) count += cells(item.segment);
  return count;
}

export function clip(text, width, ascii = false) {
  width = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
  if (!width) return "";
  if (visibleWidth(text) <= width) return text;
  const suffix = ascii ? "." : "…";
  const available = width - 1;
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

export function compactNumber(number) {
  if (!Number.isFinite(number) || number < 0) return "?";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}m`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number < 10_000 ? 1 : 0)}k`;
  return String(Math.round(number));
}
