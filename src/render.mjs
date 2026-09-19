import { clip, compactNumber, visibleWidth } from "./text.mjs";

const LABELS = {
  en: { context: "ctx(last)", ready: "ready", working: "working", settling: "settling", waiting: "waiting", tools: "tools*", agents: "agents", tasks: "tasks", empty: "no bridged activity", compact: "compactions*", cost: "est*", stopped: "interrupted" },
  "zh-CN": { context: "上下文(上次)", ready: "就绪", working: "工作中", settling: "收尾中", waiting: "等待确认", tools: "工具*", agents: "代理", tasks: "任务", empty: "暂无桥接活动", compact: "压缩*", cost: "估算*", stopped: "已中断" },
};

function pack(parts, width, ascii) {
  const present = parts.filter((part) => part !== "" && part !== null && part !== undefined);
  if (!present.length) return "";
  let line = clip(present[0], width, ascii);
  for (const part of present.slice(1)) {
    const next = `${line} | ${part}`;
    if (visibleWidth(next) <= width) line = next;
  }
  return clip(line, width, ascii);
}

function contextText(snapshot, config, width, label) {
  const valid = snapshot.contextTokens !== null && snapshot.contextWindow > 0;
  if (!valid) return { text: `${label} ?`, tone: "dim" };
  const ratio = snapshot.contextTokens / snapshot.contextWindow;
  const percent = ratio * 100;
  const tone = percent >= 90 ? "error" : percent >= 70 ? "warning" : "accent";
  const percentage = percent > 999 ? ">999%" : `${Math.round(percent)}%`;
  const size = width >= 100 ? 10 : width >= 70 ? 6 : 0;
  const fill = Math.max(0, Math.min(size, Math.round(ratio * size)));
  const bar = size ? `${(config.ascii ? "#" : "█").repeat(fill)}${(config.ascii ? "." : "░").repeat(size - fill)} ` : "";
  const tokens = width >= 120 ? ` ${compactNumber(snapshot.contextTokens)}/${compactNumber(snapshot.contextWindow)}` : "";
  return { text: `${label} ${bar}${percentage}${tokens}`, tone };
}

/** Pure, bounded renderer. Input is already sanitized by the state boundary. */
export function formatHud(snapshot, config, rawWidth) {
  const width = Math.max(0, Math.min(4_096, Math.floor(Number.isFinite(rawWidth) ? rawWidth : 0)));
  const words = LABELS[config.language];
  const context = contextText(snapshot, config, width, words.context);
  const model = `[${clip(snapshot.model, Math.max(4, Math.min(32, Math.floor(width / 3))), config.ascii)}]`;
  const git = snapshot.git ? snapshot.git.available ? `git:${snapshot.git.branch}${snapshot.git.dirty ? "*" : ""}` : "git:?" : "";
  const first = width < 45 ? [context.text, model] : [model, context.text, snapshot.project, git, config.showThinking ? snapshot.thinking : ""];
  const rows = [{ text: pack(first, width, config.ascii), tone: context.tone }];
  if (config.preset === "minimal") return rows;

  const running = config.ascii ? ">" : "●";
  const check = config.ascii ? "ok" : "✓";
  const phase = snapshot.phase === "idle" ? words.ready : snapshot.phase === "tools" ? words.working : words[snapshot.phase] || words.working;
  const active = snapshot.activeTools.length ? `${running} ${snapshot.activeTools.join(", ")}${snapshot.activeCount > 3 ? ` +${snapshot.activeCount - 3}` : ""}` : phase;
  const agents = snapshot.runningAgents || snapshot.agentErrors ? `${words.agents} ${snapshot.runningAgents}${snapshot.agentErrors ? ` !${snapshot.agentErrors}` : ""}` : "";
  const tasks = snapshot.taskSources ? `${words.tasks} ${snapshot.taskDone}/${snapshot.taskTotal}` : "";
  const costValue = snapshot.costReports ? `$${snapshot.cost.toFixed(3)}${snapshot.costReports < snapshot.usageReports ? "+?" : ""}` : "?";
  const second = [
    clip(active, Math.max(0, Math.min(width, Math.floor(width * 0.6))), config.ascii),
    `${words.tools} ${check}${snapshot.done} !${snapshot.errors}`,
    config.preset === "balanced" ? agents : "",
    config.preset === "balanced" ? tasks : "",
    config.showCost ? `${words.cost} ${costValue}` : "",
    snapshot.interrupted ? `${words.stopped} ${snapshot.interrupted}` : "",
    snapshot.dropped ? "limited*" : "",
  ];
  rows.push({ text: pack(second, width, config.ascii), tone: snapshot.errors ? "warning" : snapshot.phase === "idle" ? "dim" : "accent" });
  if (config.preset === "full") {
    const activity = [agents, tasks].filter(Boolean).join(" | ") || words.empty;
    const label = snapshot.taskLabel || snapshot.agentLabel;
    rows.push({
      text: pack([activity, label, `${words.compact} ${snapshot.compactions}`, `${config.ascii ? "in" : "↑"}${compactNumber(snapshot.input)} ${config.ascii ? "out" : "↓"}${compactNumber(snapshot.output)}`], width, config.ascii),
      tone: snapshot.agentErrors ? "warning" : "dim",
    });
  }
  return rows;
}

/** Pi may render on every stream delta. An unchanged width/state is O(1) here. */
export class HudView {
  constructor(tui, theme, snapshot, config, onError = () => {}) {
    this.tui = tui;
    this.theme = theme;
    this.snapshot = snapshot;
    this.config = config;
    this.onError = onError;
    this.width = -1;
    this.dirty = true;
    this.lines = [];
    this.disposed = false;
    this.paintRequests = 0;
    this.computations = 0;
  }

  render(width) {
    if (this.disposed) return [];
    width = Math.max(0, Math.min(4_096, Math.floor(Number.isFinite(width) ? width : 0)));
    if (!this.dirty && width === this.width) return this.lines;
    this.width = width;
    this.dirty = false;
    this.computations++;
    try {
      const theme = typeof this.theme === "function" ? this.theme() : this.theme;
      this.lines = formatHud(this.snapshot, this.config, width).map(({ text, tone }) =>
        this.config.color && theme?.fg ? theme.fg(tone, text) : text);
    } catch {
      this.lines = [clip("pi-hud unavailable", width, true)];
      try { this.onError(); } catch { /* Never propagate observer failures. */ }
    }
    return this.lines;
  }

  publish(snapshot, config) {
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

  invalidate() { this.dirty = true; }
  dispose() { this.disposed = true; this.lines = []; this.snapshot = null; }
}
