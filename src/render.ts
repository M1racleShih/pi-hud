import { clip, compactNumber, visibleWidth } from "./text.ts";
import { createStyler } from "./palette.ts";
import type { HudRole, HudStyler, HudThemeLike } from "./palette.ts";
import type { HudConfig, HudLanguage } from "./config.ts";
import { SPEED_DISPLAY_CAP } from "./state.ts";
import type { HudSnapshot, ToolCategory, ToolOutcome } from "./state.ts";
import type { SessionUsageView } from "./usage.ts";
import type { QuotaHudView } from "./quota/service.ts";

export interface HudWords {
  context: string;
  ready: string;
  working: string;
  waiting: string;
  agents: string;
  tasks: string;
  compact: string;
  cost: string;
  usage: string;
  /** Label for the optional full-session ledger totals (`usageScope: "session"`). */
  session: string;
  /** Label for the last completed assistant message's average generation speed (`spd*`). */
  speed: string;
  stopped: string;
  other: string;
  /** Label of the opt-in provider-plan quota row (distinct from context usage). */
  quotaPlan: string;
  /** "no quota source configured" marker. */
  quotaUnconfigured: string;
  /** Weekly window suffix (the 5-hour window stays `5h`). */
  quotaWeek: string;
  /** Stale-snapshot marker. */
  quotaStale: string;
}

export const LABELS: Record<HudLanguage, HudWords> = {
  en: { context: "ctx(last)", ready: "ready", working: "working", waiting: "waiting", agents: "agents", tasks: "tasks", compact: "compactions*", cost: "est*", usage: "obs*", session: "sess*", speed: "spd*", stopped: "interrupted", other: "other", quotaPlan: "plan", quotaUnconfigured: "no quota source", quotaWeek: "wk", quotaStale: "stale" },
  "zh-CN": { context: "上下文(上次)", ready: "就绪", working: "工作中", waiting: "等待确认", agents: "代理", tasks: "任务", compact: "压缩*", cost: "估算*", usage: "观测*", session: "全会话*", speed: "速度*", stopped: "已中断", other: "其他", quotaPlan: "套餐", quotaUnconfigured: "未配置额度来源", quotaWeek: "周", quotaStale: "过期" },
};

/** Fixed layout bounds: a row can never grow past these counts, whatever the state. */
export const MAX_ROW_FIELDS = 12;
/** 40 segments cover the widest full row: identity, activity, categories and bridge. */
export const MAX_ROW_SEGMENTS = 40;
/** Names shown from the bounded category ledger; the rest fold into `+N` / `other`. */
export const MAX_TOOL_FIELDS = 3;

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

/** One laid-out unit of a row. Exported so the footer surface reuses the same layout rules. */
export interface HudField {
  priority: number;
  segments: HudSegment[];
  text: string;
  width: number;
}

interface Field extends HudField {}

export const hudSegment = (role: HudRole, text: string): HudSegment => ({ role, text });
const seg = hudSegment;

/* ------------------------------------------------------------------ */
/* Thinking level field (shared by both surfaces)                      */
/* ------------------------------------------------------------------ */

/** Pi's thinking levels, low to high (extensions.md: /thinking selector). */
export const THINKING_LEVELS: readonly string[] = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** Short labels behind the `think:` prefix, matching pi-powerline-footer's footer style. */
const THINKING_SHORT: Readonly<Record<string, string>> = Object.freeze({
  off: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhi", max: "max",
});
/** Each known level styles through its own fixed role (see palette.ts); high tiers rainbow. */
const THINKING_ROLE: Readonly<Record<string, HudRole>> = Object.freeze({
  off: "thinkOff", minimal: "thinkMinimal", low: "thinkLow", medium: "thinkMedium",
  high: "thinkHigh", xhigh: "thinkXhigh", max: "thinkMax",
});

/** Normalize a host thinking-level string to a known level; unknown values stay null. */
export function normalizeThinkingLevel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const level = value.trim().toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(level) ? level : null;
}

/**
 * The thinking level as a `think:<short>` field with per-level coloring (off dim, then
 * brighter; high/xhigh/max get the rainbow pass with its saturation ladder in palette.ts).
 * Unknown or custom level strings degrade to the plain `thinking` role with the raw
 * text, never an error.
 */
export function thinkingField(snapshot: HudSnapshot, config: HudConfig, priority: number): HudField | null {
  if (!config.showThinking || !snapshot.thinking) return null;
  const level = normalizeThinkingLevel(snapshot.thinking);
  if (!level) return field(priority, [seg("thinking", clip(snapshot.thinking, 16, config.ascii))]);
  return field(priority, [seg(THINKING_ROLE[level]!, `think:${THINKING_SHORT[level]}`)]);
}

/** Build a field from optional segments; empty fields disappear instead of leaving gaps. */
export function field(priority: number, candidates: (HudSegment | null | false | "")[]): HudField | null {
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

/**
 * Lay out already-built fields and wrap them into one row. Exported so every surface
 * shares one priority/drop/clip implementation instead of reimplementing layout.
 */
export function assembleRow(candidates: (HudField | null)[], width: number, config: HudConfig): HudRow {
  const separator = config.ascii ? " | " : " · ";
  return toRow(layout(candidates, width, separator, config.ascii));
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
    thinkingField(snapshot, config, 35),
    field(85, [seg("path", clip(snapshot.project, projectBudget, config.ascii))]),
    gitField(snapshot, config),
    context,
    quotaField(snapshot.quota, config, LABELS[config.language]),
  ];
}

function gitField(snapshot: HudSnapshot, config: HudConfig): Field | null {
  if (!snapshot.git) return null;
  if (!snapshot.git.available) return field(30, [seg("git", "git:?")]);
  return field(30, [seg("git", `git:${clip(snapshot.git.branch, 32, config.ascii)}${snapshot.git.dirty ? "*" : ""}`)]);
}

/** Context stays a single droppable field; only the context/alert segments change color. */
export function contextField(snapshot: HudSnapshot, config: HudConfig, width: number, label: string, priority: number): HudField | null {
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
export function activityField(snapshot: HudSnapshot, config: HudConfig, words: HudWords): HudField | null {
  const running = config.ascii ? ">" : "●";
  const check = config.ascii ? "ok" : "✓";
  const phase = snapshot.phase === "idle" ? words.ready
    : snapshot.phase === "waiting" ? words.waiting : words.working;
  if (snapshot.phase === "idle") return field(100, [seg("success", check), seg("phase", ` ${phase}`)]);
  if (snapshot.phase === "waiting") return field(100, [seg("warning", `${running} ${phase}`)]);
  return field(100, [seg("phase", `${running} ${phase}`)]);
}

const outcomeMark: Record<ToolOutcome, string> = { ok: "✓", error: "!", interrupted: "~" };

/**
 * Bounded tool categories: at most three names by activity, plus a `+N` fold marker.
 * The state ledger already merges every name beyond its cap into one `other` bucket,
 * so this field can never iterate an unbounded collection.
 */
export function toolCategoriesField(snapshot: HudSnapshot, config: HudConfig, words: HudWords): HudField | null {
  // The state ledger mirrors every terminal outcome, so an empty ledger means no completions yet.
  if (!snapshot.toolCategories.length) return null;
  const marker = config.ascii ? "ok" : outcomeMark.ok;
  const ranked = snapshot.toolCategories
    .slice()
    .sort((a: ToolCategory, b: ToolCategory) => (b.ok + b.error + b.interrupted) - (a.ok + a.error + a.interrupted));
  const shown = ranked.slice(0, MAX_TOOL_FIELDS);
  const segments: HudSegment[] = [];
  for (const category of shown) {
    if (segments.length) segments.push(seg("separator", config.ascii ? " | " : " · "));
    // Only the synthetic overflow record is localized; a real tool named `other` is not.
    const name = category.merged ? words.other : category.name;
    segments.push(seg("label", `${name} `));
    if (category.ok) segments.push(seg("success", `${marker}${category.ok}`));
    if (category.error) segments.push(seg("error", ` !${category.error}`));
    if (category.interrupted) segments.push(seg("warning", ` ~${category.interrupted}`));
  }
  const hidden = ranked.length - shown.length;
  if (hidden > 0) segments.push(seg("label", ` +${hidden}`));
  return field(85, segments);
}

export function agentsField(snapshot: HudSnapshot, words: HudWords): HudField | null {
  if (!snapshot.runningAgents && !snapshot.agentErrors) return null;
  return field(55, [
    seg("label", `${words.agents} `),
    seg("body", String(snapshot.runningAgents)),
    snapshot.agentErrors ? seg("warning", ` !${snapshot.agentErrors}`) : null,
  ]);
}

export function tasksField(snapshot: HudSnapshot, words: HudWords): HudField | null {
  if (!snapshot.taskSources) return null;
  return field(50, [seg("label", `${words.tasks} `), seg("body", `${snapshot.taskDone}/${snapshot.taskTotal}`)]);
}

export function costField(snapshot: HudSnapshot, config: HudConfig, words: HudWords): HudField | null {
  if (!config.showCost) return null;
  if (config.usageScope === "session" && snapshot.sessionUsage) return sessionCostField(snapshot.sessionUsage, config, words);
  const value = snapshot.costReports ? `$${snapshot.cost.toFixed(3)}${snapshot.costReports < snapshot.usageReports ? "+?" : ""}` : "?";
  return field(60, [seg("label", `${words.cost} `), seg("body", value)]);
}

/**
 * Full-session cost (`usageScope: "session"`). The cost field must stay self-describing:
 * the balanced widget and narrow footers drop the token field, so the session scope
 * label (`sess*`/`全会话*`, whose asterisk keeps the not-a-bill caveat), the updating
 * mark (`↻`/ASCII `~`) and the incompleteness marks (`+?` for anything the value does
 * not already show, `limited*` for a saturated sum) are carried here independently and
 * sit directly behind the label so right-edge truncation removes the number first.
 */
export function sessionCostField(view: SessionUsageView, config: HudConfig, words: HudWords): HudField | null {
  const segments: HudSegment[] = [seg("label", `${words.session} `)];
  const marks: string[] = [];
  if (view.updating) marks.push(config.ascii ? "~" : "↻");
  // `+?` on the value already reports an unknown cost part; the mark covers every other
  // incompleteness (missing token fields) so exactly one hint appears for each distinct
  // problem. The saturation hint always precedes the value it qualifies.
  if (view.fieldsIncomplete && !view.costMissing) marks.push("+?");
  if (view.limited) marks.push("limited*");
  const markWarns = (view.fieldsIncomplete && !view.costMissing) || view.limited;
  if (marks.length) segments.push(seg(markWarns ? "warning" : "label", `${marks.join(" ")} `));
  const value = view.costKnown ? `$${view.cost.toFixed(3)}${view.costMissing ? "+?" : ""}` : "?";
  segments.push(seg("body", value));
  return field(60, segments);
}

/** Bridge agents/tasks are emitted only for valid bridge data; no empty placeholder. */
export function bridgeFields(snapshot: HudSnapshot, config: HudConfig, width: number, words: HudWords, agents: HudField | null, tasks: HudField | null): (HudField | null)[] {
  const summary: HudSegment[] = [];
  for (const item of [agents, tasks]) {
    if (!item) continue;
    if (summary.length) summary.push(seg("separator", config.ascii ? " | " : " · "));
    for (const segment of item.segments) summary.push(segment);
  }
  if (!summary.length) return [];
  const label = snapshot.taskLabel || snapshot.agentLabel;
  return [
    field(70, summary),
    label ? field(40, [seg("body", clip(label, Math.max(8, Math.min(40, Math.floor(width / 3))), config.ascii))]) : null,
  ];
}

/**
 * Average generation speed of the last completed assistant message (docs/TOKEN-SPEED.zh-CN.md).
 * The `spd*` label carries the same caveat style as `obs*`/`est*`: a one-message sample over
 * the generation window only (first content-bearing delta to message_end, provider-reported
 * tokens). Priority 28 drops it before the usage counters (30) and cost (60) on narrow rows.
 */
export function speedField(snapshot: HudSnapshot, config: HudConfig, words: HudWords): HudField | null {
  if (!config.showSpeed || snapshot.speedRate === null) return null;
  const unit = config.language === "zh-CN" ? "tok/s" : "t/s";
  const value = snapshot.speedRate > SPEED_DISPLAY_CAP ? `>${SPEED_DISPLAY_CAP}` : snapshot.speedRate.toFixed(1);
  return field(28, [seg("label", `${words.speed} `), seg("body", `${value} ${unit}`)]);
}

/** Zero compactions or zero observed usage stay hidden instead of padding the row. */
export function compactionField(snapshot: HudSnapshot, words: HudWords): HudField | null {
  if (!snapshot.compactions) return null;
  return field(35, [seg("label", `${words.compact} `), seg("body", String(snapshot.compactions))]);
}

/** Localized plan identity shown next to the quota numbers (GLM 个人 / GLM Team).
 *  Balance adapters show their service brand; both stay distinct from ctx(last). */
export function quotaPlanLabel(planKey: string, language: HudLanguage): string {
  if (planKey === "zai:personal") return language === "zh-CN" ? "GLM 个人" : "GLM Personal";
  if (planKey === "zai:team") return language === "zh-CN" ? "GLM 团队" : "GLM Team";
  if (planKey === "deepseek") return "DeepSeek";
  if (planKey === "siliconflow") return language === "zh-CN" ? "硅基流动" : "SiliconFlow";
  if (planKey === "codex") return "Codex";
  const clean = planKey.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 24);
  return clean || "plan";
}

/** Currency + exact server amount text. The digits are never reformatted; only the
 *  sign moves before the symbol. ASCII mode (and unmapped codes) use the ISO code
 *  so no row ever depends on non-ASCII symbols. */
const balanceText = (amountText: string, currency: string, ascii: boolean): string => {
  const negative = amountText.startsWith("-");
  const magnitude = negative ? amountText.slice(1) : amountText;
  const sign = negative ? "-" : "";
  if (ascii || (currency !== "CNY" && currency !== "USD")) return `${sign}${currency} ${magnitude}`;
  const symbol = currency === "CNY" ? "¥" : "$";
  return `${sign}${symbol}${magnitude}`;
};

const quotaWindowText = (bucket: { unit: string | null; number: number }, words: HudWords): string => {
  if (bucket.unit === "hour") return `${bucket.number || "?"}h`;
  if (bucket.unit === "week") return bucket.number === 1 ? words.quotaWeek : `${bucket.number}${words.quotaWeek}`;
  if (bucket.unit === "month") return String(bucket.number || "?");
  return "?";
};

/**
 * The opt-in provider-plan quota field (docs/PROVIDER-LIMITS-PLAN.zh-CN.md §6).
 * Plan remaining is labelled by the plan identity (for example `GLM 个人`) and shows
 * remaining percentages per window, or — for balance adapters — the exact server
 * amount with its currency, which keeps it explicitly distinct from the
 * context-usage meter (`ctx(last)`). Detail buckets, exact numbers, reset times and
 * issues belong to `/hud quotas`; this row stays bounded: plan identity plus at most
 * the 5-hour and weekly windows (or one balance), a stale marker, or a compact issue
 * code. Priority 70
 * drops the whole field before the path/context on narrow rows; the unconfigured and
 * ambiguity markers use even lower priorities (20/25) so they disappear first.
 */
export function quotaField(quota: QuotaHudView | null, config: HudConfig, words: HudWords): HudField | null {
  if (!quota) return null;
  const language = config.language;
  if (quota.status === "unconfigured") {
    return field(20, [seg("label", `${words.quotaPlan} ${words.quotaUnconfigured}`)]);
  }
  if (quota.status === "ambiguous-profile") {
    return field(25, [seg("label", `${words.quotaPlan} `), seg("warning", "ambiguous-profile")]);
  }
  const plan = quotaPlanLabel(quota.planKey, language);
  // Balance adapters (DeepSeek/SiliconFlow) have no windows; their row is the plan
  // identity plus the exact server amount with its currency.
  const hasValues = quota.buckets.length > 0 || quota.balance !== null;
  const valueSegments = (): HudSegment[] => {
    const segments: HudSegment[] = [];
    for (const bucket of quota.buckets) {
      segments.push(seg("separator", config.ascii ? " | " : " · "));
      const percent = bucket.remainingPercent === undefined ? "?" : `${Math.round(bucket.remainingPercent)}%`;
      segments.push(seg("body", `${quotaWindowText(bucket, words)} ${percent}`));
    }
    if (quota.balance) {
      segments.push(seg("separator", config.ascii ? " | " : " · "));
      segments.push(seg("body", balanceText(quota.balance.amountText, quota.balance.currency, config.ascii)));
    }
    return segments;
  };
  if (quota.status === "issue" && quota.issue) {
    if (!hasValues) {
      return field(70, [seg("label", `${plan} `), seg("warning", `!${quota.issue.code}`)]);
    }
    // Transient failures keep the (possibly expired) last values visible with the issue
    // code beside them (§10); auth/scope failures hide the values entirely.
    const segments: HudSegment[] = [seg("label", plan), ...valueSegments()];
    if (quota.stale) segments.push(seg("warning", ` ${words.quotaStale}`));
    segments.push(seg("warning", ` !${quota.issue.code}`));
    return field(70, segments);
  }
  if (quota.status === "loading" || quota.status === "idle" || !hasValues) {
    return field(70, [seg("label", `${plan} `), seg("body", quota.status === "loading" ? "?" : "…")]);
  }
  const segments: HudSegment[] = [seg("label", plan), ...valueSegments()];
  if (quota.stale) segments.push(seg("warning", ` ${words.quotaStale}`));
  return field(70, segments);
}

/**
 * Observed usage since attachment/reset: input and both cache counters are separate
 * fields, so a cached token is never counted as a fresh input token twice. The `obs*`
 * marker states that this is not a full-session ledger; CH is the latest valid
 * assistant's cacheRead / (input + cacheRead + cacheWrite), or `?` when unknown.
 */
export function tokensField(snapshot: HudSnapshot, config: HudConfig, words: HudWords): HudField | null {
  if (config.usageScope === "session" && snapshot.sessionUsage) return sessionTokensField(snapshot, config, words);
  if (!snapshot.usageReports) return null;
  const arrow = { up: config.ascii ? "in" : "↑", down: config.ascii ? "out" : "↓" };
  // One colored segment per counter keeps the field compact; the arrow and value share the
  // reader-facing group, while the obs* label states the observation scope.
  return field(30, [
    seg("label", `${words.usage} `),
    snapshot.input ? seg("body", `${arrow.up}${compactNumber(snapshot.input)}`) : null,
    snapshot.output ? seg("body", ` ${arrow.down}${compactNumber(snapshot.output)}`) : null,
    snapshot.cacheRead ? seg("body", ` R${compactNumber(snapshot.cacheRead)}`) : null,
    snapshot.cacheWrite ? seg("body", ` W${compactNumber(snapshot.cacheWrite)}`) : null,
    seg("label", " CH"), seg("body", snapshot.cacheHit === null ? "?" : `${(snapshot.cacheHit * 100).toFixed(1)}%`),
  ]);
}

/**
 * Full-session ledger totals (`usageScope: "session"`). The scope label leads and the
 * compact status markers (`↻`/ASCII `~` updating, `+?` incomplete, `?` while loading,
 * `limited*` saturated) sit directly behind it, so right-edge truncation removes the
 * numbers before it can remove the scope, the incompleteness hint or the saturation
 * hint — a clipped value must never lose the signal that it is a capped total, not an
 * exact one. CH keeps its observed meaning: it never describes the session totals.
 */
export function sessionTokensField(snapshot: HudSnapshot, config: HudConfig, words: HudWords): HudField | null {
  const usage = snapshot.sessionUsage!;
  if (usage.status !== "loading" && !usage.usageRecords && !usage.limited) return null;
  const arrow = { up: config.ascii ? "in" : "↑", down: config.ascii ? "out" : "↓" };
  const segments: HudSegment[] = [seg("label", `${words.session} `)];
  const marks: string[] = [];
  if (usage.updating) marks.push(config.ascii ? "~" : "↻");
  if (usage.fieldsIncomplete) marks.push("+?");
  // The saturation hint always precedes every number it qualifies.
  if (usage.limited) marks.push("limited*");
  if (marks.length) segments.push(seg(usage.fieldsIncomplete || usage.limited ? "warning" : "label", `${marks.join(" ")} `));
  if (usage.status === "loading") {
    segments.push(seg("body", "?"));
  } else {
    if (usage.input) segments.push(seg("body", `${arrow.up}${compactNumber(usage.input)}`));
    if (usage.output) segments.push(seg("body", ` ${arrow.down}${compactNumber(usage.output)}`));
    if (usage.cacheRead) segments.push(seg("body", ` R${compactNumber(usage.cacheRead)}`));
    if (usage.cacheWrite) segments.push(seg("body", ` W${compactNumber(usage.cacheWrite)}`));
  }
  segments.push(seg("label", " CH"), seg("body", snapshot.cacheHit === null ? "?" : `${(snapshot.cacheHit * 100).toFixed(1)}%`));
  return field(30, segments);
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
    activityField(snapshot, config, words),
    snapshot.interrupted ? field(93, [seg("warning", `${words.stopped} ${snapshot.interrupted}`)]) : null,
    toolCategoriesField(snapshot, config, words),
    costField(snapshot, config, words),
    config.preset === "balanced" ? agents : null,
    config.preset === "balanced" ? tasks : null,
    snapshot.dropped ? field(45, [seg("warning", "limited*")]) : null,
  ], width, separator, config.ascii)));
  if (config.preset === "full") {
    rows.push(toRow(layout([
      ...bridgeFields(snapshot, config, width, words, agents, tasks),
      compactionField(snapshot, words),
      tokensField(snapshot, config, words),
      speedField(snapshot, config, words),
    ], width, separator, config.ascii)));
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
