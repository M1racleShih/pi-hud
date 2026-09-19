import { clip, compactNumber, visibleWidth } from "./text.ts";
import { createStyler } from "./palette.ts";
import type { HudRole, HudStyler, HudThemeLike } from "./palette.ts";
import type { HudConfig, HudLanguage } from "./config.ts";
import type { HudSnapshot } from "./state.ts";

interface HudWords {
  context: string;
  ready: string;
  working: string;
  settling: string;
  waiting: string;
  tools: string;
  agents: string;
  tasks: string;
  empty: string;
  compact: string;
  cost: string;
  stopped: string;
}

const LABELS: Record<HudLanguage, HudWords> = {
  en: { context: "ctx(last)", ready: "ready", working: "working", settling: "settling", waiting: "waiting", tools: "tools*", agents: "agents", tasks: "tasks", empty: "no bridged activity", compact: "compactions*", cost: "est*", stopped: "interrupted" },
  "zh-CN": { context: "上下文(上次)", ready: "就绪", working: "工作中", settling: "收尾中", waiting: "等待确认", tools: "工具*", agents: "代理", tasks: "任务", empty: "暂无桥接活动", compact: "压缩*", cost: "估算*", stopped: "已中断" },
};

/** Fixed layout bounds: a row can never grow past these counts, whatever the state. */
export const MAX_ROW_FIELDS = 12;
export const MAX_ROW_SEGMENTS = 32;

/** One already-laid-out piece of a row. Layout happens before this becomes ANSI. */
export interface HudSegment {
  role: HudRole;
  text: string;
}

/** A rendered row: plain text for measurement/tests plus its semantic segments. */
export interface HudRow {
  text: string;
  segments: HudSegment[];
}

/** TUI surface and color theme supplied by the host widget factory. */
export interface WidgetTui {
  requestRender(): void;
}

/** Structural host theme kept for compatibility with the previous renderer API. */
export interface HudTheme extends HudThemeLike {
  fg(tone: string, text: string): string;
}

interface Field {
  priority: number;
  segments: HudSegment[];
  text: string;
  width: number;
}

const seg = (role: HudRole, text: string): HudSegment => ({ role, text });

/** Build a field from optional segments; empty fields disappear instead of leaving gaps. */
function field(priority: number, candidates: (HudSegment | null | false | "")[]): Field | null {
  const segments: HudSegment[] = [];
  let text = "";
  for (const candidate of candidates) {
    if (!candidate || !candidate.text) continue;
    segments.push(candidate);
    text += candidate.text;
  }
  // Measure once here so layout never re-walks graphemes for fields that fit.
  return segments.length ? { priority, segments, text, width: visibleWidth(text) } : null;
}

/** Cap field count by priority while preserving the reading order. Exported for regression tests. */
export function capRowFields<T extends { priority: number }>(fields: T[]): T[] {
  if (fields.length <= MAX_ROW_FIELDS) return fields;
  const keep = new Set(fields.slice().sort((a, b) => b.priority - a.priority).slice(0, MAX_ROW_FIELDS));
  return fields.filter((item) => keep.has(item));
}

/** Hard segment bound per row. Exported for regression tests. */
export function capRowSegments(segments: HudSegment[]): HudSegment[] {
  return segments.length > MAX_ROW_SEGMENTS ? segments.slice(0, MAX_ROW_SEGMENTS) : segments;
}

const totalWidth = (fields: Field[], separatorWidth: number): number => {
  let total = separatorWidth * Math.max(0, fields.length - 1);
  for (const item of fields) total += item.width;
  return total;
};

/**
 * Width-first layout: drop the least important fields, then clip the remainder at the
 * right edge with grapheme-aware truncation. No styling decisions are made here.
 */
function layout(candidates: (Field | null)[], width: number, separator: string, ascii: boolean): HudSegment[] {
  const fields = capRowFields(candidates.filter((item): item is Field => item !== null));
  const separatorWidth = visibleWidth(separator);
  while (fields.length > 1 && totalWidth(fields, separatorWidth) > width) {
    let drop = 0;
    for (let index = 1; index < fields.length; index++) {
      if (fields[index].priority < fields[drop].priority) drop = index;
    }
    fields.splice(drop, 1);
  }
  const segments: HudSegment[] = [];
  let used = 0;
  for (const item of fields) {
    const gap = segments.length ? separator : "";
    const gapWidth = gap ? separatorWidth : 0;
    if (used + gapWidth + item.width <= width) {
      if (gap) segments.push(seg("separator", gap));
      for (const segment of item.segments) segments.push(segment);
      used += gapWidth + item.width;
      continue;
    }
    let available = width - used - gapWidth;
    if (available > 0) {
      if (gap) segments.push(seg("separator", gap));
      for (const segment of item.segments) {
        if (available <= 0) break;
        if (visibleWidth(segment.text) <= available) {
          segments.push(segment);
          available -= visibleWidth(segment.text);
        } else {
          const clipped = clip(segment.text, available, ascii);
          if (clipped) segments.push(seg(segment.role, clipped));
          available = 0;
        }
      }
    }
    break;
  }
  return capRowSegments(segments);
}

function toRow(segments: HudSegment[]): HudRow {
  let text = "";
  for (const segment of segments) text += segment.text;
  return { text, segments };
}

/** Below this width the context meter outranks the model name in the identity row. */
const CONTEXT_FIRST_WIDTH = 45;
const MODEL_PRIORITY = 100;
const NARROW_MODEL_PRIORITY = 90;
const CONTEXT_PRIORITY = 95;
const NARROW_CONTEXT_PRIORITY = 110;

function identityFields(snapshot: HudSnapshot, config: HudConfig, width: number, label: string, separatorWidth: number): (Field | null)[] {
  const narrow = width < CONTEXT_FIRST_WIDTH;
  const context = contextField(snapshot, config, width, label, narrow ? NARROW_CONTEXT_PRIORITY : CONTEXT_PRIORITY);
  // Reserve the already-measured context field (and its separator) before spending width
  // on the model, so a long model name can never push the percentage, and any high-usage
  // warning, out of a narrow row.
  const modelRoom = width - (context ? context.width + separatorWidth : 0) - 2;
  const modelBudget = Math.max(4, Math.min(32, Math.floor(width / 2), modelRoom));
  const projectBudget = Math.max(8, Math.min(32, Math.floor(width / 4)));
  return [
    field(narrow ? NARROW_MODEL_PRIORITY : MODEL_PRIORITY, [seg("model", `[${clip(snapshot.model, modelBudget, config.ascii)}]`)]),
    config.showThinking && snapshot.thinking ? field(35, [seg("thinking", clip(snapshot.thinking, 16, config.ascii))]) : null,
    field(85, [seg("path", clip(snapshot.project, projectBudget, config.ascii))]),
    gitField(snapshot, config),
    context,
  ];
}

function gitField(snapshot: HudSnapshot, config: HudConfig): Field | null {
  if (!snapshot.git) return null;
  if (!snapshot.git.available) return field(30, [seg("git", "git:?")]);
  return field(30, [seg("git", `git:${clip(snapshot.git.branch, 32, config.ascii)}${snapshot.git.dirty ? "*" : ""}`)]);
}

/** Context stays a single droppable field; only the context/alert segments change color. */
function contextField(snapshot: HudSnapshot, config: HudConfig, width: number, label: string, priority: number): Field | null {
  if (snapshot.contextTokens === null || snapshot.contextWindow <= 0) {
    return field(priority, [seg("label", `${label} ?`)]);
  }
  const ratio = snapshot.contextTokens / snapshot.contextWindow;
  const percent = ratio * 100;
  // The plan keeps high context usage a local warning (never red) plus a symbol hint.
  const level: HudRole = percent >= 70 ? "warning" : "context";
  const barRole: HudRole = level === "context" ? "barUsed" : "warning";
  const percentages = `${percent > 999 ? ">999" : Math.round(percent)}%${percent >= 90 ? "!" : ""}`;
  const size = width >= 100 ? 10 : width >= 70 ? 6 : 0;
  const fill = Math.max(0, Math.min(size, Math.round(ratio * size)));
  const segments: HudSegment[] = [seg("label", `${label} `)];
  if (size) {
    if (fill) segments.push(seg(barRole, (config.ascii ? "#" : "█").repeat(fill)));
    if (size - fill) segments.push(seg("barEmpty", (config.ascii ? "." : "░").repeat(size - fill)));
    segments.push(seg(level, ` ${percentages}`));
  } else {
    segments.push(seg(level, percentages));
  }
  if (width >= 120) {
    segments.push(seg("label", ` ${compactNumber(snapshot.contextTokens)}/${compactNumber(snapshot.contextWindow)}`));
  }
  return field(priority, segments);
}

/** Activity is the phase marker plus its label; only waiting switches this field to warning. */
function activityField(snapshot: HudSnapshot, config: HudConfig, width: number, words: HudWords): Field | null {
  const running = config.ascii ? ">" : "●";
  const check = config.ascii ? "ok" : "✓";
  if (snapshot.activeTools.length) {
    const names = snapshot.activeTools.join(", ") + (snapshot.activeCount > 3 ? ` +${snapshot.activeCount - 3}` : "");
    const budget = Math.max(0, Math.min(width, Math.floor(width * 0.6)) - visibleWidth(running) - 1);
    const role: HudRole = snapshot.phase === "waiting" ? "warning" : "phase";
    return field(100, [seg(role, `${running} ${clip(names, budget, config.ascii)}`)]);
  }
  const phase = snapshot.phase === "idle" ? words.ready
    : snapshot.phase === "tools" ? words.working
    : words[snapshot.phase as keyof HudWords] || words.working;
  if (snapshot.phase === "idle") return field(100, [seg("success", check), seg("phase", ` ${phase}`)]);
  if (snapshot.phase === "waiting") return field(100, [seg("warning", `${running} ${phase}`)]);
  return field(100, [seg("phase", `${running} ${phase}`)]);
}

function toolsField(snapshot: HudSnapshot, config: HudConfig, words: HudWords): Field | null {
  const check = config.ascii ? "ok" : "✓";
  // Zero successes/failures stay neutral; alerts color only their own count.
  return field(90, [
    seg("label", `${words.tools} `),
    seg(snapshot.done ? "success" : "label", `${check}${snapshot.done}`),
    seg(snapshot.errors ? "error" : "label", ` !${snapshot.errors}`),
  ]);
}

function agentsField(snapshot: HudSnapshot, words: HudWords): Field | null {
  if (!snapshot.runningAgents && !snapshot.agentErrors) return null;
  return field(55, [
    seg("label", `${words.agents} `),
    seg("body", String(snapshot.runningAgents)),
    snapshot.agentErrors ? seg("warning", ` !${snapshot.agentErrors}`) : null,
  ]);
}

function tasksField(snapshot: HudSnapshot, words: HudWords): Field | null {
  if (!snapshot.taskSources) return null;
  return field(50, [seg("label", `${words.tasks} `), seg("body", `${snapshot.taskDone}/${snapshot.taskTotal}`)]);
}

function costField(snapshot: HudSnapshot, config: HudConfig, words: HudWords): Field | null {
  if (!config.showCost) return null;
  const value = snapshot.costReports ? `$${snapshot.cost.toFixed(3)}${snapshot.costReports < snapshot.usageReports ? "+?" : ""}` : "?";
  return field(60, [seg("label", `${words.cost} `), seg("body", value)]);
}

function summaryFields(snapshot: HudSnapshot, config: HudConfig, width: number, words: HudWords, agents: Field | null, tasks: Field | null): (Field | null)[] {
  const summary: HudSegment[] = [];
  for (const item of [agents, tasks]) {
    if (!item) continue;
    if (summary.length) summary.push(seg("separator", config.ascii ? " | " : " · "));
    for (const segment of item.segments) summary.push(segment);
  }
  const label = snapshot.taskLabel || snapshot.agentLabel;
  const arrow = { up: config.ascii ? "in" : "↑", down: config.ascii ? "out" : "↓" };
  return [
    field(70, summary.length ? summary : [seg("label", words.empty)]),
    label ? field(40, [seg("body", clip(label, Math.max(8, Math.min(40, Math.floor(width / 3))), config.ascii))]) : null,
    field(35, [seg("label", `${words.compact} `), seg("body", String(snapshot.compactions))]),
    field(30, [
      seg("label", arrow.up), seg("body", compactNumber(snapshot.input)),
      seg("label", ` ${arrow.down}`), seg("body", compactNumber(snapshot.output)),
    ]),
  ];
}

/** Pure, bounded renderer. Input is already sanitized by the state boundary. */
export function formatHud(snapshot: HudSnapshot, config: HudConfig, rawWidth: number): HudRow[] {
  const width = Math.max(0, Math.min(4_096, Math.floor(Number.isFinite(rawWidth) ? rawWidth : 0)));
  const words = LABELS[config.language];
  const separator = config.ascii ? " | " : " · ";
  const rows: HudRow[] = [toRow(layout(identityFields(snapshot, config, width, words.context, visibleWidth(separator)), width, separator, config.ascii))];
  if (config.preset === "minimal") return rows;

  const agents = agentsField(snapshot, words);
  const tasks = tasksField(snapshot, words);
  rows.push(toRow(layout([
    activityField(snapshot, config, width, words),
    snapshot.interrupted ? field(92, [seg("warning", `${words.stopped} ${snapshot.interrupted}`)]) : null,
    toolsField(snapshot, config, words),
    costField(snapshot, config, words),
    config.preset === "balanced" ? agents : null,
    config.preset === "balanced" ? tasks : null,
    snapshot.dropped ? field(45, [seg("warning", "limited*")]) : null,
  ], width, separator, config.ascii)));
  if (config.preset === "full") {
    rows.push(toRow(layout(summaryFields(snapshot, config, width, words, agents, tasks), width, separator, config.ascii)));
  }
  return rows;
}

/** Apply the resolved palette to already-laid-out segments. Never changes visible width. */
export function styleRows(rows: HudRow[], styler: HudStyler): string[] {
  return rows.map((row) => {
    let line = "";
    for (const segment of row.segments) line += styler.style(segment.role, segment.text);
    return line;
  });
}

/** Pi may render on every stream delta. An unchanged width/state/theme is O(1) here. */
export class HudView {
  declare tui: WidgetTui;
  declare theme: HudThemeLike | (() => HudThemeLike | undefined) | null | undefined;
  declare snapshot: HudSnapshot | null;
  declare config: HudConfig;
  declare onError: () => void;
  declare width: number;
  declare dirty: boolean;
  declare lines: string[];
  declare styler: HudStyler | null;
  declare stylerTheme: unknown;
  declare stylerKey: string;
  declare disposed: boolean;
  declare paintRequests: number;
  declare computations: number;

  constructor(tui: WidgetTui, theme: HudThemeLike | (() => HudThemeLike | undefined) | null | undefined, snapshot: HudSnapshot, config: HudConfig, onError: () => void = () => {}) {
    this.tui = tui;
    this.theme = theme;
    this.snapshot = snapshot;
    this.config = config;
    this.onError = onError;
    this.width = -1;
    this.dirty = true;
    this.lines = [];
    this.styler = null;
    this.stylerTheme = undefined;
    this.stylerKey = "";
    this.disposed = false;
    this.paintRequests = 0;
    this.computations = 0;
  }

  /** Rebuild only when the palette inputs change; a theme switch clears it via invalidate(). */
  stylerFor(theme: HudThemeLike | null | undefined): HudStyler {
    const key = `${this.config.palette}|${this.config.color}`;
    if (!this.styler || this.stylerTheme !== theme || this.stylerKey !== key) {
      this.styler = createStyler(theme, this.config);
      this.stylerTheme = theme;
      this.stylerKey = key;
    }
    return this.styler;
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    width = Math.max(0, Math.min(4_096, Math.floor(Number.isFinite(width) ? width : 0)));
    // Width, published state and theme validity are the whole cache key.
    if (!this.dirty && width === this.width) return this.lines;
    this.width = width;
    this.dirty = false;
    this.computations++;
    try {
      const theme = typeof this.theme === "function" ? this.theme() : this.theme;
      this.lines = styleRows(formatHud(this.snapshot!, this.config, width), this.stylerFor(theme));
    } catch {
      this.lines = [clip("pi-hud unavailable", width, true)];
      try { this.onError(); } catch { /* Never propagate observer failures. */ }
    }
    return this.lines;
  }

  publish(snapshot: HudSnapshot, config: HudConfig) {
    if (this.disposed) return;
    const previous = this.lines;
    this.snapshot = snapshot;
    this.config = config;
    this.dirty = true;
    const next = this.render(this.width < 0 ? 80 : this.width);
    if (previous.length === next.length && previous.every((line, index) => line === next[index])) return;
    this.paintRequests++;
    try { this.tui.requestRender(); } catch { try { this.onError(); } catch { /* No throw. */ } }
  }

  invalidate() { this.dirty = true; this.styler = null; }
  dispose() { this.disposed = true; this.lines = []; this.snapshot = null; this.styler = null; }
}
