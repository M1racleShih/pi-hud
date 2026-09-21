import { baseName, safeText } from "./text.ts";
import type { GitStatus } from "./git.ts";
import type { SessionUsageView } from "./usage.ts";
import type { QuotaHudView } from "./quota/service.ts";

export const LIMITS = Object.freeze({ tools: 64, recentIds: 128, agents: 16, tasks: 8, toolCategories: 16 });
/** Display name of the synthetic bucket that merges tool names beyond the retention cap. */
export const OTHER_CATEGORY = "other";
/** Shortest generation window that can be measured honestly (see docs/TOKEN-SPEED.zh-CN.md). */
export const MIN_SPEED_WINDOW_MS = 50;
/** Rate above which the display saturates instead of printing an ever-growing number. */
export const SPEED_DISPLAY_CAP = 999;
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
const add = (a: number, b: number): number => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 160;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Structural views of host payloads; every field is still validated at runtime. */
export interface ModelLike {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
}

export interface UsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
}

export interface MessageLike {
  role?: string;
  model?: string;
  provider?: string;
  stopReason?: string;
  usage?: UsageLike;
}

export interface ToolEventLike {
  toolCallId?: unknown;
  toolName?: unknown;
  args?: { path?: unknown; file_path?: unknown };
  isError?: unknown;
}

interface BridgeItem {
  source: string;
  label: string;
  expires: number;
  status?: string;
  total?: number;
  completed?: number;
}

/** A lifecycle outcome. Starting a tool is never a completion. */
export type ToolOutcome = "ok" | "error" | "interrupted";

/** Bounded per-tool-name counters. Success, failure and interruption never share a field. */
export interface ToolCategory {
  name: string;
  ok: number;
  error: number;
  interrupted: number;
  /** True only for the synthetic overflow bucket, never for a real tool name. */
  merged?: boolean;
}

export interface HudSnapshot {
  project: string;
  model: string;
  thinking: string;
  contextWindow: number;
  contextTokens: number | null;
  phase: string;
  activeTools: string[];
  activeCount: number;
  done: number;
  errors: number;
  interrupted: number;
  dropped: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Cache-hit rate of the most recent assistant response with valid usage:
   * `cacheRead / (input + cacheRead + cacheWrite)`. `null` while the denominator
   * is zero or the observation has been invalidated by reset, model switch or compaction.
   */
  cacheHit: number | null;
  /**
   * Average generation speed of the most recent completed assistant message:
   * provider-reported `usage.output` divided by the wall-clock window from the first
   * content-bearing streaming delta to `message_end` (algorithm: docs/TOKEN-SPEED.zh-CN.md).
   * `null` before the first measurement and after reset or a model switch; a discarded
   * measurement never overwrites the previous valid value.
   */
  speedRate: number | null;
  /** Exact numerator/denominator of `speedRate`, kept for `/hud status` diagnostics. */
  speedTokens: number;
  speedMs: number;
  cost: number;
  usageReports: number;
  costReports: number;
  compactions: number;
  lastTool: string;
  runningAgents: number;
  agentErrors: number;
  agentLabel: string;
  taskTotal: number;
  taskDone: number;
  taskLabel: string;
  taskSources: number;
  toolCategories: ToolCategory[];
  git: GitStatus | null;
  /** Published provider-quota row view, attached by the controller only while the
   *  opt-in quota feature is enabled (`config.quota.enabled`). `null` renders nothing. */
  quota: QuotaHudView | null;
  /**
   * Published full-session ledger view. Attached by the controller in `usageScope:
   * "session"`; `null` keeps the observed rendering (including the explicit degradation
   * when the ledger is inactive or the host API is unavailable).
   */
  sessionUsage: SessionUsageView | null;
}

/** Only bounded scalar summaries are retained. Incoming payloads are never retained. */
export class HudState {
  declare project: string;
  declare model: string;
  declare modelKey: string;
  declare contextWindow: number;
  declare contextTokens: number | null;
  declare contextAt: number | null;
  declare thinking: string;
  declare since: number;
  declare phase: string;
  declare waiting: boolean;
  declare tools: Map<string, { name: string; target: string }>;
  declare toolStats: Map<string, ToolCategory>;
  declare overflowStats: ToolCategory | null;
  declare recentIds: Set<string>;
  declare agents: Map<string, BridgeItem>;
  declare tasks: Map<string, BridgeItem>;
  declare done: number;
  declare errors: number;
  declare interrupted: number;
  declare dropped: number;
  declare input: number;
  declare output: number;
  declare cacheRead: number;
  declare cacheWrite: number;
  declare cacheHit: number | null;
  declare speedRate: number | null;
  declare speedTokens: number;
  declare speedMs: number;
  declare streamArmed: boolean;
  declare firstTokenAt: number | null;
  declare cost: number;
  declare usageReports: number;
  declare costReports: number;
  declare compactions: number;
  declare lastTool: string;
  declare git: GitStatus | null;

  constructor(cwd = "", model?: ModelLike, now = Date.now()) { this.reset(cwd, model, now); }

  reset(cwd: string, model: ModelLike | undefined, now: number) {
    this.project = baseName(cwd);
    this.model = "no model";
    this.modelKey = "";
    this.contextWindow = 0;
    this.contextTokens = null;
    this.contextAt = null;
    this.thinking = "";
    this.since = now;
    this.phase = "idle";
    this.waiting = false;
    this.tools = new Map();
    this.toolStats = new Map();
    this.overflowStats = null;
    this.recentIds = new Set();
    this.agents = new Map();
    this.tasks = new Map();
    this.done = 0;
    this.errors = 0;
    this.interrupted = 0;
    this.dropped = 0;
    this.input = 0;
    this.output = 0;
    this.cacheRead = 0;
    this.cacheWrite = 0;
    this.cacheHit = null;
    this.speedRate = null;
    this.speedTokens = 0;
    this.speedMs = 0;
    this.streamArmed = false;
    this.firstTokenAt = null;
    this.cost = 0;
    this.usageReports = 0;
    this.costReports = 0;
    this.compactions = 0;
    this.lastTool = "";
    this.git = null;
    this.setModel(model);
  }

  setModel(model: ModelLike | undefined) {
    const key = `${safeText(model?.provider, 64)}:${safeText(model?.id, 100)}`;
    if (key !== this.modelKey) {
      this.contextTokens = null;
      this.contextAt = null;
      // A cache-hit rate measured for another model is not applicable to this one, and the
      // same holds for its generation speed, which would otherwise ride along next to the
      // new model's name.
      this.cacheHit = null;
      this.speedRate = null;
      this.speedTokens = 0;
      this.speedMs = 0;
    }
    this.modelKey = key;
    this.model = safeText(model?.name || model?.id, 80) || "no model";
    this.contextWindow = number(model?.contextWindow);
  }

  /**
   * Arm (assistant) or disarm (any other role) one speed measurement. A `message_start`
   * of a non-assistant message while armed means the pairing is already broken: discard
   * rather than risk pairing a first-token timestamp with the wrong message.
   */
  messageStart(message: MessageLike | undefined): boolean {
    const armed = message?.role === "assistant";
    const changed = armed !== this.streamArmed || (armed && this.firstTokenAt !== null);
    this.streamArmed = armed;
    this.firstTokenAt = null;
    return changed;
  }

/* stream-boundary:start */
  /**
   * The single high-frequency bridge (see docs/TOKEN-SPEED.zh-CN.md). It records exactly
   * one timestamp per assistant message - the arrival of the first content-bearing delta
   * - and then fuses: every further `message_update` of that message leaves through the
   * first comparison without touching the payload. `*_start` events do not count (their
   * blocks are empty by contract), non-string or empty deltas do not count, and nothing
   * from the delta string is ever retained.
   */
  messageUpdate(streamEvent: { type?: unknown; delta?: unknown } | undefined, now: number): boolean {
    if (!this.streamArmed || this.firstTokenAt !== null) return false;
    if (streamEvent?.type !== "text_delta" && streamEvent?.type !== "thinking_delta" && streamEvent?.type !== "toolcall_delta") return false;
    if (typeof streamEvent.delta !== "string" || streamEvent.delta.length === 0) return false;
    this.firstTokenAt = now;
    return true;
  }
/* stream-boundary:end */

  messageEnd(message: MessageLike | undefined, now: number) {
    const speed = this.settleSpeed(message, now);
    if (message?.role !== "assistant") return speed;
    const usage = message.usage;
    if (!object(usage)) return speed;
    // Input, output and both cache counters stay separate: adding the cache counters to
    // `input` again is exactly the double count the native footer avoids.
    const input = number(usage.input);
    const output = number(usage.output);
    const cacheRead = number(usage.cacheRead);
    const cacheWrite = number(usage.cacheWrite);
    // A provider that omits both cache counters reports no cache data at all; that is
    // unknown, not a real 0% hit rate.
    const hasCacheData = usage.cacheRead !== undefined || usage.cacheWrite !== undefined;
    this.input = add(this.input, input);
    this.output = add(this.output, output);
    this.cacheRead = add(this.cacheRead, cacheRead);
    this.cacheWrite = add(this.cacheWrite, cacheWrite);
    this.usageReports++;
    const costTotal = (usage.cost as { total?: unknown } | null | undefined)?.total;
    if (typeof costTotal === "number" && Number.isFinite(costTotal) && costTotal >= 0) {
      this.cost = add(this.cost, costTotal);
      this.costReports++;
    }
    // A response may finish after model selection changes. Its usage still counts,
    // but must not be divided by the newly selected model's context window.
    const responseKey = `${safeText(message.provider, 64)}:${safeText(message.model, 100)}`;
    const mismatch = message.model && message.provider && responseKey !== this.modelKey;
    // Error/abort usage may be partial; never portray it as a trustworthy context snapshot.
    if (mismatch || message.stopReason === "error" || message.stopReason === "aborted" || input + output <= 0) {
      this.contextTokens = null;
      this.contextAt = null;
      // Partial usage is not a valid cache observation, so the previous valid rate stays
      // authoritative rather than being replaced by a half-reported denominator.
    } else {
      // The last context snapshot keeps its previous meaning: every token the request
      // processed (prompt + both cache counters) plus its output, now summed from
      // separate fields instead of one already-merged input counter.
      this.contextTokens = add(add(input, cacheRead), add(cacheWrite, output));
      this.contextAt = now;
      const promptTokens = input + cacheRead + cacheWrite;
      this.cacheHit = hasCacheData && promptTokens > 0 ? cacheRead / promptTokens : null;
    }
    return true;
  }
  /**
   * Settle the armed speed measurement (guards G1-G5 in docs/TOKEN-SPEED.zh-CN.md). A
   * discarded measurement never overwrites the previous valid value, matching the
   * cache-hit rule for partial observations.
   */
  private settleSpeed(message: MessageLike | undefined, now: number): boolean {
    const armed = this.streamArmed;
    const firstTokenAt = this.firstTokenAt;
    this.streamArmed = false;
    this.firstTokenAt = null;
    if (message?.role !== "assistant" || !armed || firstTokenAt === null) return false;
    if (message.stopReason === "error" || message.stopReason === "aborted") return false;
    const usage = message.usage;
    if (!object(usage)) return false;
    const output = number(usage.output);
    if (output <= 0) return false;
    // A response finishing after a model switch still counts toward usage, but its speed
    // belongs to the old model and must not be displayed next to the new selection.
    const responseKey = `${safeText(message.provider, 64)}:${safeText(message.model, 100)}`;
    if (message.model && message.provider && responseKey !== this.modelKey) return false;
    const elapsed = now - firstTokenAt;
    if (elapsed < MIN_SPEED_WINDOW_MS) return false;
    this.speedTokens = output;
    this.speedMs = elapsed;
    this.speedRate = output / (elapsed / 1_000);
    return true;
  }

  startTool(event: ToolEventLike | undefined) {
    const id = event?.toolCallId;
    if (!validId(id)) { this.dropped++; return false; }
    if (this.tools.has(id) || this.recentIds.has(id)) return false;
    if (this.tools.size >= LIMITS.tools) { this.dropped++; return true; }
    const name = safeText(event!.toolName, 48) || "tool";
    let target = "";
    // Never show bash commands, search text, model prompts, or tool results.
    if (["read", "write", "edit", "ls"].includes(name)) {
      const path = event!.args?.path ?? event!.args?.file_path;
      if (typeof path === "string") target = baseName(path, 36);
    }
    this.tools.set(id, { name, target });
    return true;
  }

  /**
   * Resolve the retained category for a tool name. The first `LIMITS.toolCategories` names
   * are kept verbatim; any further name is merged into a separate overflow record, so the
   * per-name map cannot grow with the number of distinct tools seen. Because the overflow
   * bucket is not stored under a tool name, a real tool named `other` keeps its own counters.
   */
  categoryFor(name: string): ToolCategory {
    // Retained names are already sanitized, so the common path is one map lookup.
    const existing = this.toolStats.get(name);
    if (existing) return existing;
    const key = safeText(name, 48) || "tool";
    const sanitized = this.toolStats.get(key);
    if (sanitized) return sanitized;
    if (this.toolStats.size >= LIMITS.toolCategories) {
      this.overflowStats ??= { name: OTHER_CATEGORY, ok: 0, error: 0, interrupted: 0, merged: true };
      return this.overflowStats;
    }
    const category: ToolCategory = { name: key, ok: 0, error: 0, interrupted: 0 };
    this.toolStats.set(key, category);
    return category;
  }

  /** Record one terminal outcome in its category. */
  countCompletion(name: string, status: ToolOutcome) {
    const category = this.categoryFor(name);
    if (status === "error") category.error = add(category.error, 1);
    else if (status === "interrupted") category.interrupted = add(category.interrupted, 1);
    else category.ok = add(category.ok, 1);
  }

  endTool(event: ToolEventLike | undefined) {
    const id = event?.toolCallId;
    if (!validId(id)) { this.dropped++; return false; }
    if (this.recentIds.has(id)) return false;
    const tool = this.tools.get(id);
    const name = tool?.name || safeText(event!.toolName, 48) || "tool";
    this.lastTool = `${name}${tool?.target ? ` ${tool.target}` : ""}`;
    this.tools.delete(id);
    if (this.recentIds.size >= LIMITS.recentIds) this.recentIds.delete(this.recentIds.values().next().value as string);
    this.recentIds.add(id);
    if (event!.isError === true) { this.errors = add(this.errors, 1); this.countCompletion(name, "error"); }
    else { this.done = add(this.done, 1); this.countCompletion(name, "ok"); }
    return true;
  }

  settle() {
    this.phase = "idle";
    this.waiting = false;
    this.interrupted = add(this.interrupted, this.tools.size);
    // Interrupted tools are counted separately per category: never as success or failure.
    for (const tool of this.tools.values()) this.countCompletion(tool.name, "interrupted");
    this.tools.clear();
  }

  compact() {
    this.compactions++;
    this.contextTokens = null;
    this.contextAt = null;
    // The host may rewrite the context on the next request; the previous prompt's
    // cache-hit rate would then describe a context that no longer applies.
    this.cacheHit = null;
  }

  bridge(payload: unknown, now: number) {
    if (!object(payload) || payload.version !== 1) return false;
    const source = payload.source;
    if (typeof source !== "string" || !/^[a-zA-Z0-9._/-]{1,64}$/.test(source)) return false;
    if (payload.kind === "clear") {
      let changed = false;
      for (const map of [this.agents, this.tasks]) {
        for (const [key, item] of map) if (item.source === source) { map.delete(key); changed = true; }
      }
      return changed;
    }
    if (!validId(payload.id)) return false;
    const key = `${source}:${payload.id}`;
    const ttl = (payload.ttlMs ?? (payload.kind === "tasks" ? 300_000 : payload.status === "running" ? 60_000 : 10_000)) as number;
    if (!Number.isInteger(ttl) || ttl < 1_000 || ttl > 3_600_000) return false;
    const item: BridgeItem = { source, label: safeText(payload.label, 100), expires: now + ttl };
    let map: Map<string, BridgeItem>;
    let cap: number;
    if (payload.kind === "agent") {
      if (!["running", "done", "error"].includes(payload.status as string)) return false;
      item.status = payload.status as string;
      map = this.agents; cap = LIMITS.agents;
    } else if (payload.kind === "tasks") {
      if (!Number.isInteger(payload.total) || (payload.total as number) < 0 || (payload.total as number) > 1_000_000 ||
          !Number.isInteger(payload.completed) || (payload.completed as number) < 0 || (payload.completed as number) > (payload.total as number)) return false;
      item.total = payload.total as number; item.completed = payload.completed as number;
      map = this.tasks; cap = LIMITS.tasks;
    } else return false;
    if (!map.has(key) && map.size >= cap) { this.dropped++; return false; }
    map.set(key, item);
    return true;
  }

  prune(now: number) {
    for (const map of [this.agents, this.tasks]) {
      for (const [key, item] of map) if (item.expires <= now) map.delete(key);
    }
  }

  nextExpiry(): number {
    let next = Infinity;
    for (const map of [this.agents, this.tasks]) for (const item of map.values()) next = Math.min(next, item.expires);
    return next;
  }

  snapshot(): HudSnapshot {
    const activeTools: string[] = [];
    for (const tool of this.tools.values()) {
      activeTools.push(`${tool.name}${tool.target ? ` ${tool.target}` : ""}`);
      if (activeTools.length === 3) break;
    }
    // Snapshot copies stay bounded: at most 16 names plus the synthetic overflow record.
    const toolCategories: ToolCategory[] = [];
    for (const category of this.toolStats.values()) {
      toolCategories.push({ name: category.name, ok: category.ok, error: category.error, interrupted: category.interrupted });
    }
    if (this.overflowStats) {
      toolCategories.push({
        name: this.overflowStats.name, ok: this.overflowStats.ok,
        error: this.overflowStats.error, interrupted: this.overflowStats.interrupted, merged: true,
      });
    }
    let runningAgents = 0;
    let agentErrors = 0;
    let agentLabel = "";
    for (const item of this.agents.values()) {
      if (item.status === "running") { runningAgents++; agentLabel ||= item.label; }
      if (item.status === "error") agentErrors++;
    }
    let taskTotal = 0;
    let taskDone = 0;
    let taskLabel = "";
    for (const item of this.tasks.values()) {
      // Task items always carry counters; they are set before insertion in bridge().
      taskTotal += item.total!; taskDone += item.completed!; taskLabel ||= item.label;
    }
    return {
      project: this.project, model: this.model, thinking: this.thinking,
      contextWindow: this.contextWindow, contextTokens: this.contextTokens,
      phase: this.waiting ? "waiting" : this.tools.size ? "tools" : this.phase,
      activeTools, activeCount: this.tools.size, done: this.done, errors: this.errors,
      interrupted: this.interrupted, dropped: this.dropped,
      input: this.input, output: this.output, cacheRead: this.cacheRead, cacheWrite: this.cacheWrite,
      cacheHit: this.cacheHit, cost: this.cost,
      speedRate: this.speedRate, speedTokens: this.speedTokens, speedMs: this.speedMs,
      usageReports: this.usageReports, costReports: this.costReports,
      compactions: this.compactions, lastTool: this.lastTool,
      runningAgents, agentErrors, agentLabel,
      taskTotal, taskDone, taskLabel, taskSources: this.tasks.size,
      toolCategories,
      git: this.git,
      quota: null,
      sessionUsage: null,
    };
  }
}
