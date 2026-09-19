import { baseName, safeText } from "./text.mjs";

export const LIMITS = Object.freeze({ tools: 64, recentIds: 128, agents: 16, tasks: 8 });
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
const add = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 160;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only bounded scalar summaries are retained. Incoming payloads are never retained. */
export class HudState {
  constructor(cwd = "", model, now = Date.now()) { this.reset(cwd, model, now); }

  reset(cwd, model, now) {
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
    this.recentIds = new Set();
    this.agents = new Map();
    this.tasks = new Map();
    this.done = 0;
    this.errors = 0;
    this.interrupted = 0;
    this.dropped = 0;
    this.input = 0;
    this.output = 0;
    this.cost = 0;
    this.usageReports = 0;
    this.costReports = 0;
    this.compactions = 0;
    this.lastTool = "";
    this.git = null;
    this.setModel(model);
  }

  setModel(model) {
    const key = `${safeText(model?.provider, 64)}:${safeText(model?.id, 100)}`;
    if (key !== this.modelKey) {
      this.contextTokens = null;
      this.contextAt = null;
    }
    this.modelKey = key;
    this.model = safeText(model?.name || model?.id, 80) || "no model";
    this.contextWindow = number(model?.contextWindow);
  }

  messageEnd(message, now) {
    if (message?.role !== "assistant") return false;
    const usage = message.usage;
    if (!object(usage)) return false;
    const input = number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite);
    const output = number(usage.output);
    this.input = add(this.input, input);
    this.output = add(this.output, output);
    this.usageReports++;
    if (typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0) {
      this.cost = add(this.cost, usage.cost.total);
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
    } else {
      this.contextTokens = add(input, output);
      this.contextAt = now;
    }
    return true;
  }

  startTool(event) {
    const id = event?.toolCallId;
    if (!validId(id)) { this.dropped++; return false; }
    if (this.tools.has(id) || this.recentIds.has(id)) return false;
    if (this.tools.size >= LIMITS.tools) { this.dropped++; return true; }
    const name = safeText(event.toolName, 48) || "tool";
    let target = "";
    // Never show bash commands, search text, model prompts, or tool results.
    if (["read", "write", "edit", "ls"].includes(name)) {
      const path = event.args?.path ?? event.args?.file_path;
      if (typeof path === "string") target = baseName(path, 36);
    }
    this.tools.set(id, { name, target });
    return true;
  }

  endTool(event) {
    const id = event?.toolCallId;
    if (!validId(id)) { this.dropped++; return false; }
    if (this.recentIds.has(id)) return false;
    const tool = this.tools.get(id);
    this.lastTool = tool ? `${tool.name}${tool.target ? ` ${tool.target}` : ""}` : safeText(event.toolName, 48);
    this.tools.delete(id);
    if (this.recentIds.size >= LIMITS.recentIds) this.recentIds.delete(this.recentIds.values().next().value);
    this.recentIds.add(id);
    if (event.isError === true) this.errors = add(this.errors, 1);
    else this.done = add(this.done, 1);
    return true;
  }

  settle() {
    this.phase = "idle";
    this.waiting = false;
    this.interrupted = add(this.interrupted, this.tools.size);
    this.tools.clear();
  }

  compact() {
    this.compactions++;
    this.contextTokens = null;
    this.contextAt = null;
  }

  bridge(payload, now) {
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
    const ttl = payload.ttlMs ?? (payload.kind === "tasks" ? 300_000 : payload.status === "running" ? 60_000 : 10_000);
    if (!Number.isInteger(ttl) || ttl < 1_000 || ttl > 3_600_000) return false;
    const item = { source, label: safeText(payload.label, 100), expires: now + ttl };
    let map;
    let cap;
    if (payload.kind === "agent") {
      if (!["running", "done", "error"].includes(payload.status)) return false;
      item.status = payload.status;
      map = this.agents; cap = LIMITS.agents;
    } else if (payload.kind === "tasks") {
      if (!Number.isInteger(payload.total) || payload.total < 0 || payload.total > 1_000_000 ||
          !Number.isInteger(payload.completed) || payload.completed < 0 || payload.completed > payload.total) return false;
      item.total = payload.total; item.completed = payload.completed;
      map = this.tasks; cap = LIMITS.tasks;
    } else return false;
    if (!map.has(key) && map.size >= cap) { this.dropped++; return false; }
    map.set(key, item);
    return true;
  }

  prune(now) {
    for (const map of [this.agents, this.tasks]) {
      for (const [key, item] of map) if (item.expires <= now) map.delete(key);
    }
  }

  nextExpiry() {
    let next = Infinity;
    for (const map of [this.agents, this.tasks]) for (const item of map.values()) next = Math.min(next, item.expires);
    return next;
  }

  snapshot() {
    const activeTools = [];
    for (const tool of this.tools.values()) {
      activeTools.push(`${tool.name}${tool.target ? ` ${tool.target}` : ""}`);
      if (activeTools.length === 3) break;
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
      taskTotal += item.total; taskDone += item.completed; taskLabel ||= item.label;
    }
    return {
      project: this.project, model: this.model, thinking: this.thinking,
      contextWindow: this.contextWindow, contextTokens: this.contextTokens,
      phase: this.waiting ? "waiting" : this.tools.size ? "tools" : this.phase,
      activeTools, activeCount: this.tools.size, done: this.done, errors: this.errors,
      interrupted: this.interrupted, dropped: this.dropped,
      input: this.input, output: this.output, cost: this.cost,
      usageReports: this.usageReports, costReports: this.costReports,
      compactions: this.compactions, lastTool: this.lastTool,
      runningAgents, agentErrors, agentLabel,
      taskTotal, taskDone, taskLabel, taskSources: this.tasks.size,
      git: this.git,
    };
  }
}
