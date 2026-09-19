import { DEFAULT_CONFIG, configPath, isDisabled, normalizeConfig, readConfigFile } from "./config.mjs";
import { Coalescer } from "./scheduler.mjs";
import { HudState } from "./state.mjs";
import { HudView } from "./render.mjs";
import { GitProbe } from "./git.mjs";
import { safeText } from "./text.mjs";

export const WIDGET_KEY = "pi-hud";
export const BRIDGE_EVENT = "pi-hud:update";
export const OBSERVED_EVENTS = Object.freeze([
  "session_start", "session_shutdown", "agent_start", "agent_end", "agent_settled",
  "message_end", "tool_execution_start", "tool_execution_end", "session_compact",
  "session_tree", "model_select", "thinking_level_select", "ui_prompt_start", "ui_prompt_end",
]);
const sameGit = (a, b) => a.enabled === b.enabled && a.ttlMs === b.ttlMs && a.timeoutMs === b.timeoutMs;

/** Exported for deterministic tests; normal users load the default extension factory. */
export class HudController {
  constructor(pi, options = {}) {
    this.pi = pi;
    this.options = options;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.configLoader = options.configLoader ?? readConfigFile;
    this.config = normalizeConfig(options.config ?? {});
    this.ctx = null;
    this.state = null;
    this.scheduler = null;
    this.view = null;
    this.git = null;
    this.unsubscribe = null;
    this.configTimer = null;
    this.expiryTimer = null;
    this.expiryAt = Infinity;
    this.epoch = 0;
    this.loadToken = 0;
    this.ready = false;
    this.attached = false;
    this.wantGit = false;
    this.configurationError = null;
    this.configurationPath = null;
    this.callbackErrors = 0;
    this.flushes = 0;
    this.maxFlushMs = 0;
  }

  get enabled() { return !!this.ctx && this.config.enabled; }

  handle(name, event, ctx) {
    try {
      if (name === "session_shutdown") { this.stop(); return; }
      if (name === "session_start") { this.start(ctx); return; }
      if (!this.enabled || ctx?.mode !== "tui") return;
      this.ctx = ctx;
      let changed = true;
      switch (name) {
        case "agent_start": this.state.phase = "working"; this.git?.cancel(); break;
        case "agent_end": this.state.phase = "settling"; break;
        case "agent_settled": this.state.settle(); this.wantGit = true; break;
        case "message_end": changed = this.state.messageEnd(event?.message, this.now()); break;
        case "tool_execution_start": changed = this.state.startTool(event); break;
        case "tool_execution_end": changed = this.state.endTool(event); break;
        case "session_compact": this.state.compact(); break;
        case "session_tree": this.resetEpoch(); break;
        case "model_select": this.state.setModel(event?.model ?? ctx.model); this.state.thinking = safeText(ctx.thinkingLevel, 16); break;
        case "thinking_level_select": this.state.thinking = safeText(event?.level ?? ctx.thinkingLevel, 16); break;
        case "ui_prompt_start": this.state.waiting = true; break;
        case "ui_prompt_end": this.state.waiting = false; break;
        default: changed = false;
      }
      if (changed) this.request();
    } catch { this.callbackErrors++; }
    // Always undefined. Never replace messages/results or block the core loop.
  }

  start(ctx) {
    this.stop();
    // hasUI is true in RPC too: terminal UI must check mode explicitly.
    if (ctx?.mode !== "tui" || !ctx.hasUI) return;
    this.ctx = ctx;
    this.epoch++;
    this.state = new HudState(ctx.cwd, ctx.model, this.now());
    this.state.thinking = safeText(ctx.thinkingLevel, 16);
    this.state.phase = ctx.isIdle() ? "idle" : "working";
    this.scheduler = new Coalescer(() => this.flush(), {
      intervalMs: this.config.refreshMs, now: this.monotonic,
      setTimer: this.setTimer, clearTimer: this.clearTimer,
    });
    if (this.pi.events?.on) {
      this.unsubscribe = this.pi.events.on(BRIDGE_EVENT, (payload) => {
        if (!this.enabled) return;
        try { if (this.state.bridge(payload, this.now())) this.request(); }
        catch { this.callbackErrors++; }
      });
    }
    this.wantGit = true;
    if (this.options.loadOnStart === false) {
      this.ready = true;
      this.applyConfig(this.config);
    } else {
      // No filesystem access or Promise is awaited by session_start.
      this.configTimer = this.setTimer(() => {
        this.configTimer = null;
        void this.reloadConfig(false);
      }, 0);
      this.configTimer?.unref?.();
    }
  }

  request() {
    if (this.enabled && this.ready) this.scheduler?.request();
  }

  attachWidget() {
    if (!this.enabled || !this.ready || this.attached) return;
    const ctx = this.ctx;
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      this.view = new HudView(tui, () => this.ctx?.ui.theme ?? theme, this.state.snapshot(), this.config, () => { this.callbackErrors++; });
      return this.view;
    }, { placement: this.config.placement });
    this.attached = true;
  }

  detachWidget() {
    this.view?.dispose();
    this.view = null;
    if (this.attached) {
      try { this.ctx?.ui.setWidget(WIDGET_KEY, undefined); } catch { this.callbackErrors++; }
    }
    this.attached = false;
  }

  applyConfig(next) {
    const previous = this.config;
    this.config = normalizeConfig(next);
    this.loadToken++; // In-flight file reads cannot overwrite a later user command.
    this.ready = true;
    if (!this.ctx) return;
    this.scheduler?.setIntervalMs(this.config.refreshMs);
    if (!this.config.enabled || !this.config.git.enabled) {
      this.git?.dispose(); this.git = null; this.state.git = null;
    } else if (!this.git || !sameGit(previous.git, this.config.git)) {
      this.git?.dispose();
      this.git = this.options.gitFactory ? this.options.gitFactory(this.config.git) : new GitProbe(this.config.git, { now: this.now });
      this.wantGit = true;
    }
    if (!this.config.enabled) {
      this.scheduler?.cancel(); this.clearExpiry(); this.detachWidget();
      return;
    }
    if (!previous.enabled) this.resetEpoch();
    if (previous.placement !== this.config.placement) this.detachWidget();
    this.attachWidget();
    this.request();
  }

  async reloadConfig(notify) {
    if (!this.ctx) return;
    const token = ++this.loadToken;
    try {
      const path = configPath(this.env);
      this.configurationPath = path;
      const loaded = await this.configLoader(path);
      if (token !== this.loadToken || !this.ctx) return;
      this.configurationError = null;
      this.applyConfig(loaded.config);
      if (notify) this.notify(loaded.found ? "pi-hud configuration reloaded" : "No pi-hud.json found; defaults loaded");
    } catch (error) {
      if (token !== this.loadToken || !this.ctx) return;
      this.configurationError = safeText(error?.message, 160) || "Could not load configuration";
      this.ready = true;
      this.attachWidget(); this.request();
      if (notify) this.notify(`pi-hud: ${this.configurationError}`, "warning");
    }
  }

  resetEpoch() {
    this.epoch++;
    this.git?.cancel();
    this.clearExpiry();
    this.state.reset(this.ctx.cwd, this.ctx.model, this.now());
    this.state.thinking = safeText(this.ctx.thinkingLevel, 16);
    this.state.phase = this.ctx.isIdle() ? "idle" : "working";
    this.wantGit = true;
  }

  flush() {
    if (!this.enabled || !this.ready) return;
    const started = this.monotonic();
    try {
      this.flushes++;
      this.state.prune(this.now());
      this.attachWidget();
      this.view?.publish(this.state.snapshot(), this.config);
      this.scheduleExpiry();
      if (this.wantGit && this.git && this.state.phase === "idle" && !this.state.waiting && this.ctx.isIdle()) {
        this.wantGit = false;
        const epoch = this.epoch;
        this.git.request(this.ctx.cwd, (status) => {
          if (epoch !== this.epoch || !this.enabled || !this.config.git.enabled) return;
          this.state.git = status;
          this.request();
        });
      }
    } catch { this.callbackErrors++; }
    finally { this.maxFlushMs = Math.max(this.maxFlushMs, this.monotonic() - started); }
  }

  clearExpiry() {
    if (this.expiryTimer !== null) this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    this.expiryAt = Infinity;
  }

  scheduleExpiry() {
    const next = this.state.nextExpiry();
    if (next === this.expiryAt) return;
    this.clearExpiry();
    if (!Number.isFinite(next)) return;
    this.expiryAt = next;
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null;
      this.expiryAt = Infinity;
      this.request();
    }, Math.max(250, next - this.now()));
    this.expiryTimer?.unref?.();
  }

  notify(message, type = "info") {
    try { this.ctx?.ui.notify(message, type); } catch { this.callbackErrors++; }
  }

  inspect() {
    return {
      version: "0.1.0", targetPi: "0.85.1", enabled: this.enabled,
      mode: this.ctx?.mode ?? "inactive", preset: this.config.preset,
      configurationPath: this.configurationPath, configurationError: this.configurationError,
      refreshMs: this.config.refreshMs, gitEnabled: this.config.git.enabled,
      observedEvents: [...OBSERVED_EVENTS],
      countersSince: this.state?.since ?? null,
      flushes: this.flushes, maxFlushMs: this.maxFlushMs,
      renderRequests: this.view?.paintRequests ?? 0,
      callbackErrors: this.callbackErrors,
      droppedActivity: this.state?.dropped ?? 0,
      boundedState: { tools: this.state?.tools.size ?? 0, agents: this.state?.agents.size ?? 0, tasks: this.state?.tasks.size ?? 0 },
    };
  }

  async command(args, ctx) {
    if (ctx?.mode !== "tui" || !ctx.hasUI) return;
    try {
      if (!this.ctx) this.start(ctx);
      this.ctx = ctx;
      const input = typeof args === "string" ? args.slice(0, 256).trim().split(/\s+/) : [];
      const [command = "", value] = input;
      if (command === "status") { this.notify(JSON.stringify(this.inspect(), null, 2)); return; }
      if (command === "reload") { await this.reloadConfig(true); return; }
      if (command === "reset") { this.resetEpoch(); this.request(); this.notify("pi-hud observation counters reset"); return; }
      if (command === "refresh") { this.wantGit = true; this.request(); return; }
      let next;
      if (["on", "off", "toggle"].includes(command)) {
        next = { ...this.config, enabled: command === "toggle" ? !this.config.enabled : command === "on" };
      } else if (command === "preset" && ["minimal", "balanced", "full"].includes(value)) {
        next = { ...this.config, preset: value };
      } else if (command === "lang" && ["en", "zh-CN"].includes(value)) {
        next = { ...this.config, language: value };
      } else if (command === "git" && ["on", "off"].includes(value)) {
        next = { ...this.config, git: { ...this.config.git, enabled: value === "on" } };
      } else if (command === "placement" && ["aboveEditor", "belowEditor"].includes(value)) {
        next = { ...this.config, placement: value };
      }
      if (!next) {
        this.notify("/hud on|off|toggle · preset minimal|balanced|full · lang en|zh-CN · git on|off · placement aboveEditor|belowEditor · reload · refresh · reset · status\nChanges are in-memory. Edit pi-hud.json for persistence.");
        return;
      }
      // A pending startup load must not overwrite an explicit command.
      if (this.configTimer !== null) this.clearTimer(this.configTimer);
      this.configTimer = null;
      this.applyConfig(next);
      this.notify(`pi-hud ${command}${value ? ` ${value}` : ""} (in-memory)`);
    } catch { this.callbackErrors++; this.notify("pi-hud command failed; the agent was not changed", "warning"); }
  }

  stop() {
    this.epoch++;
    this.loadToken++;
    this.ready = false;
    if (this.configTimer !== null) this.clearTimer(this.configTimer);
    this.configTimer = null;
    this.clearExpiry();
    this.scheduler?.dispose();
    this.scheduler = null;
    this.git?.dispose();
    this.git = null;
    try { this.unsubscribe?.(); } catch { this.callbackErrors++; }
    this.unsubscribe = null;
    this.detachWidget();
    this.ctx = null;
    this.state = null;
  }
}

export default function piHud(pi) {
  if (isDisabled(process.env.PI_HUD_DISABLE)) return;
  const controller = new HudController(pi);
  for (const name of OBSERVED_EVENTS) {
    pi.on(name, (event, ctx) => { controller.handle(name, event, ctx); });
  }
  pi.registerCommand("hud", {
    description: "Configure the passive Pi HUD (no model calls)",
    handler: (args, ctx) => controller.command(args, ctx),
  });
}
