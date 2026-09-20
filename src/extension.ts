import { DEFAULT_CONFIG, configPath, isDisabled, normalizeConfig, readConfigFile } from "./config.ts";
import type { GitConfig, HudConfig, LoadedConfig } from "./config.ts";
import { Coalescer } from "./scheduler.ts";
import type { ClearTimer, SetTimer, TimerHandle } from "./scheduler.ts";
import { HudState } from "./state.ts";
import type { MessageLike, ModelLike, ToolEventLike } from "./state.ts";
import { HudView } from "./render.ts";
import type { HudTheme, WidgetTui } from "./render.ts";
import { HudFooterView, installFooter as mountFooterSurface, releaseFooter as unmountFooterSurface } from "./footer.ts";
import type { FooterDataLike, HudFooterComponent } from "./footer.ts";
import { GitProbe } from "./git.ts";
import type { GitProbeLike, GitStatus } from "./git.ts";
import { SessionUsageLedger } from "./usage.ts";
import type { SessionManagerLike } from "./usage.ts";
import { displayPath, safeText } from "./text.ts";

export const WIDGET_KEY = "pi-hud";
export const BRIDGE_EVENT = "pi-hud:update";
export const OBSERVED_EVENTS: readonly string[] = Object.freeze([
  "session_start", "session_shutdown", "session_info_changed", "agent_start", "agent_end", "agent_settled",
  "turn_end", "message_end", "tool_execution_start", "tool_execution_end", "session_compact",
  "session_tree", "model_select", "thinking_level_select", "ui_prompt_start", "ui_prompt_end",
]);
const sameGit = (a: GitConfig, b: GitConfig) => a.enabled === b.enabled && a.ttlMs === b.ttlMs && a.timeoutMs === b.timeoutMs;
const MAX_TITLE = 80;
const MAX_PROVIDER = 64;
const MAX_CWD = 72;

/** Structural host surface used by the HUD; payloads are still validated at runtime. */
export interface HudWidget {
  render(width: number): string[];
  invalidate?(): void;
  dispose?(): void;
}

export interface PiUi {
  theme?: HudTheme;
  setWidget(key: string, factory?: ((tui: WidgetTui, theme: HudTheme) => HudWidget) | undefined, options?: { placement: string }): void;
  /** Present on Pi 0.85.1; optional so a limited host can fall back to the widget surface. */
  setFooter?(factory?: ((tui: WidgetTui, theme: HudTheme, footerData: FooterDataLike) => HudFooterComponent) | undefined): void;
  notify(message: string, type?: string): void;
}

export interface PiContext {
  mode: string;
  hasUI: boolean;
  cwd: string;
  model?: ModelLike;
  thinkingLevel?: string;
  ui: PiUi;
  isIdle(): boolean;
  /** Read at lifecycle boundaries only (never in render); the session ledger additionally
   *  uses the read-only entry surface inside its own marked boundary in src/usage.ts. */
  sessionManager?: {
    getSessionName?(): string | undefined;
    getSessionId?(): string;
    getEntries?(): unknown[];
    getEntry?(id: string): unknown;
    getLeafId?(): string | null;
  };
  /** Some hosts expose the name directly; also read only at lifecycle boundaries. */
  getSessionName?(): string | undefined;
}

export interface PiEventPayload extends ToolEventLike {
  message?: MessageLike;
  model?: ModelLike;
  level?: string;
  /** Payload of `session_info_changed`. */
  name?: string;
}

export interface ExtensionApi {
  on(name: string, handler: (event: PiEventPayload, ctx: PiContext) => void): void;
  registerCommand(name: string, command: { description: string; handler: (args: string, ctx: PiContext) => unknown }): void;
  events?: { on(name: string, handler: (payload: unknown) => void): () => void };
}

export interface HudControllerOptions {
  env?: Record<string, string | undefined>;
  now?: () => number;
  monotonic?: () => number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  configLoader?: (path: string) => Promise<LoadedConfig>;
  config?: unknown;
  gitFactory?: (config: GitConfig) => GitProbeLike;
  loadOnStart?: boolean;
}

/** Exported for deterministic tests; normal users load the default extension factory. */
export class HudController {
  declare pi: ExtensionApi;
  declare options: HudControllerOptions;
  declare env: Record<string, string | undefined>;
  declare now: () => number;
  declare monotonic: () => number;
  declare setTimer: SetTimer;
  declare clearTimer: ClearTimer;
  declare configLoader: (path: string) => Promise<LoadedConfig>;
  declare config: HudConfig;
  declare ctx: PiContext | null;
  declare state: HudState | null;
  declare scheduler: Coalescer | null;
  declare view: HudView | null;
  declare footer: HudFooterView | null;
  declare footerOwned: boolean;
  declare footerSuppressed: boolean;
  declare footerData: FooterDataLike | null;
  declare footerBranchUnsubscribe: (() => void) | null;
  declare identity: { cwd: string; provider: string; title: string; branch: string | null; branchDirty: boolean };
  declare surfaceFallback: string | null;
  declare footerInstallations: number;
  declare footerReleases: number;
  declare git: GitProbeLike | null;
  declare ledger: SessionUsageLedger | null;
  declare unsubscribe: (() => void) | null;
  declare configTimer: TimerHandle | null;
  declare expiryTimer: TimerHandle | null;
  declare expiryAt: number;
  declare epoch: number;
  declare loadToken: number;
  declare ready: boolean;
  declare attached: boolean;
  declare wantGit: boolean;
  declare configurationError: string | null;
  declare configurationPath: string | null;
  declare callbackErrors: number;
  declare flushes: number;
  declare maxFlushMs: number;

  constructor(pi: ExtensionApi, options: HudControllerOptions = {}) {
    this.pi = pi;
    this.options = options;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? (clearTimeout as unknown as ClearTimer);
    this.configLoader = options.configLoader ?? readConfigFile;
    this.config = normalizeConfig(options.config ?? {});
    this.ctx = null;
    this.state = null;
    this.scheduler = null;
    this.view = null;
    this.footer = null;
    this.footerOwned = false;
    this.footerSuppressed = false;
    this.footerData = null;
    this.footerBranchUnsubscribe = null;
    this.identity = { cwd: "", provider: "", title: "", branch: null, branchDirty: false };
    this.surfaceFallback = null;
    this.footerInstallations = 0;
    this.footerReleases = 0;
    this.git = null;
    this.ledger = null;
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

  handle(name: string, event: PiEventPayload | undefined, ctx?: PiContext) {
    try {
      if (name === "session_shutdown") { this.stop(); return; }
      if (name === "session_start") { this.start(ctx); return; }
      if (!this.enabled || ctx?.mode !== "tui") return;
      this.ctx = ctx;
      let changed = true;
      switch (name) {
        case "agent_start": this.state!.phase = "working"; this.git?.cancel(); break;
        case "agent_end": this.state!.phase = "settling"; break;
        case "agent_settled": this.state!.settle(); this.wantGit = true; this.ledger?.requestVerify(); break;
        case "turn_end": this.ledger?.requestVerify(); changed = false; break;
        case "message_end":
          // Observed counters keep their meaning; the session ledger only marks pending
          // work here and reads the final committed entry at the next reliable boundary.
          // A pending mark repaints too, so the updating marker shows even when the
          // observed counters (for example on a toolResult message) did not change.
          changed = this.ledger?.onMessageEnd() === true;
          changed = this.state!.messageEnd(event?.message, this.now()) || changed;
          break;
        case "tool_execution_start": changed = this.state!.startTool(event); break;
        case "tool_execution_end": changed = this.state!.endTool(event); break;
        case "session_compact": this.state!.compact(); this.ledger?.onStructural("compact"); break;
        case "session_tree": this.resetEpoch(); this.ledger?.onStructural("tree"); break;
        case "session_info_changed": this.identity.title = safeText(event?.name, MAX_TITLE); break;
        case "model_select":
          this.state!.setModel(event?.model ?? ctx.model);
          this.state!.thinking = safeText(ctx.thinkingLevel, 16);
          this.identity.provider = safeText((event?.model ?? ctx.model)?.provider, MAX_PROVIDER);
          break;
        case "thinking_level_select": this.state!.thinking = safeText(event?.level ?? ctx.thinkingLevel, 16); break;
        case "ui_prompt_start": this.state!.waiting = true; break;
        case "ui_prompt_end": this.state!.waiting = false; break;
        default: changed = false;
      }
      if (changed) this.request();
    } catch { this.callbackErrors++; }
    // Always undefined. Never replace messages/results or block the core loop.
  }

  start(ctx?: PiContext) {
    this.stop();
    // hasUI is true in RPC too: terminal UI must check mode explicitly.
    if (ctx?.mode !== "tui" || !ctx.hasUI) return;
    this.ctx = ctx;
    this.epoch++;
    this.state = new HudState(ctx.cwd, ctx.model, this.now());
    this.state.thinking = safeText(ctx.thinkingLevel, 16);
    this.state.phase = ctx.isIdle() ? "idle" : "working";
    // Identity is captured once per session and refreshed by events, never during render.
    this.footerSuppressed = false;
    this.surfaceFallback = null;
    this.identity = {
      cwd: displayPath(ctx.cwd, this.env.HOME ?? this.env.USERPROFILE, MAX_CWD),
      provider: safeText(ctx.model?.provider, MAX_PROVIDER),
      title: safeText(this.readSessionName(ctx), MAX_TITLE),
      branch: null,
      branchDirty: false,
    };
    this.scheduler = new Coalescer(() => this.flush(), {
      intervalMs: this.config.refreshMs, now: this.monotonic,
      setTimer: this.setTimer, clearTimer: this.clearTimer,
    });
    // The optional full-session ledger shares the injected timers so tests stay
    // deterministic; it never runs history work inside this lifecycle callback.
    this.ledger = new SessionUsageLedger({
      setTimer: this.setTimer, clearTimer: this.clearTimer, monotonic: this.monotonic,
      onPublish: () => this.request(),
    });
    if (this.config.usageScope === "session") this.ledger.restart(this.readUsageManager(ctx), "session-start");
    if (this.pi.events?.on) {
      this.unsubscribe = this.pi.events.on(BRIDGE_EVENT, (payload) => {
        if (!this.enabled) return;
        try { if (this.state!.bridge(payload, this.now())) this.request(); }
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

  /**
   * Pi resolves the session name by walking session history, so this runs once at session
   * start (and on `session_info_changed`), never from render and never per frame.
   */
  readSessionName(ctx: PiContext): string | undefined {
    try {
      if (typeof ctx.getSessionName === "function") return ctx.getSessionName();
      if (typeof ctx.sessionManager?.getSessionName === "function") return ctx.sessionManager.getSessionName();
      return undefined;
    } catch { this.callbackErrors++; return undefined; }
  }

  /** Structural cast for the ledger; property access stays guarded inside its boundary. */
  readUsageManager(ctx?: PiContext): SessionManagerLike | null {
    const manager = ctx?.sessionManager;
    return manager && typeof manager === "object" ? manager : null;
  }

  request() {
    if (this.enabled && this.ready) this.scheduler?.request();
  }

  attachWidget() {
    if (!this.enabled || !this.ready || this.attached) return;
    const ctx = this.ctx!;
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      this.view = new HudView(tui, () => this.ctx?.ui.theme ?? theme, this.state!.snapshot(), this.config, () => { this.callbackErrors++; });
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

  /**
   * Mount exactly one surface. `surface: footer` never mounts the widget, and `placement`
   * only affects the widget. A host without `setFooter` falls back to the widget and records
   * the reason for `/hud status`.
   */
  attachSurface(claim = false) {
    if (!this.enabled || !this.ready) return;
    if (claim) this.footerSuppressed = false;
    const wantsFooter = this.config.surface === "footer";
    const supported = typeof this.ctx?.ui.setFooter === "function";
    this.surfaceFallback = wantsFooter && !supported
      ? "host ui.setFooter is unavailable; fell back to the widget surface"
      : null;
    if (wantsFooter && supported) {
      this.detachWidget();
      this.attachFooter();
      return;
    }
    this.releaseFooter();
    this.attachWidget();
  }

  attachFooter() {
    if (!this.enabled || this.footer || this.footerSuppressed) return;
    const ui = this.ctx?.ui;
    if (!ui) return;
    const installed = mountFooterSurface(ui, (tui, theme, footerData) => {
      const component = new HudFooterView(
        tui,
        () => this.ctx?.ui.theme ?? theme,
        footerData,
        this.state!.snapshot(),
        this.config,
        this.identity,
        () => { this.callbackErrors++; },
        (disposed) => { this.onFooterDisposed(disposed); },
      );
      this.footer = component;
      this.footerOwned = true;
      this.footerInstallations++;
      this.attachFooterData(footerData);
      return component;
    });
    if (!installed) this.surfaceFallback = "host ui.setFooter is unavailable; fell back to the widget surface";
  }

  /**
   * The host's footer slot is a single replacement slot. The branch subscription belongs to
   * the installed component, so it is created here and dropped with the component.
   */
  attachFooterData(footerData: FooterDataLike) {
    this.detachFooterData();
    this.footerData = footerData;
    try {
      // Cached by the host provider; no extra Git process is started for the branch name.
      this.identity.branch = typeof footerData.getGitBranch === "function" ? footerData.getGitBranch() : null;
      this.footerBranchUnsubscribe = typeof footerData.onBranchChange === "function"
        ? footerData.onBranchChange(() => {
          try {
            this.identity.branch = this.footerData?.getGitBranch?.() ?? null;
            this.request();
          } catch { this.callbackErrors++; }
        })
        : null;
    } catch { this.callbackErrors++; }
  }

  detachFooterData() {
    this.footerData = null;
    try { this.footerBranchUnsubscribe?.(); } catch { this.callbackErrors++; }
    this.footerBranchUnsubscribe = null;
  }

  /**
   * The host replaced or reset our footer component (another extension took the slot, or the
   * host rebuilt extension UI). Ownership is gone: never clear the slot later, and never
   * steal it back on a plain refresh.
   */
  onFooterDisposed(component: HudFooterView) {
    if (this.footer !== component) return;
    this.footer = null;
    this.footerOwned = false;
    this.footerSuppressed = true;
    this.detachFooterData();
  }

  /**
   * Release our own footer: unsubscribe first, then restore the native footer only while we
   * still own the slot. The component's own `dispose()` runs before the host's follow-up
   * dispose, so a self-release and a host release can never restore twice or recurse.
   */
  releaseFooter() {
    const component = this.footer;
    const owned = this.footerOwned;
    this.footer = null;
    this.footerOwned = false;
    this.detachFooterData();
    if (component) {
      try { component.dispose(); } catch { this.callbackErrors++; }
    }
    if (owned) {
      if (unmountFooterSurface(this.ctx?.ui)) this.footerReleases++;
    }
  }

  /** Dirty marker comes from the existing opt-in probe, never from a new Git query. */
  syncBranchDirty() {
    const git = this.state?.git;
    this.identity.branchDirty = !!(this.config.git.enabled && git?.available && git.dirty);
  }

  applyConfig(next: unknown, claim = false) {
    const previous = this.config;
    this.config = normalizeConfig(next);
    this.loadToken++; // In-flight file reads cannot overwrite a later user command.
    this.ready = true;
    if (!this.ctx) return;
    this.scheduler?.setIntervalMs(this.config.refreshMs);
    if (!this.config.enabled || !this.config.git.enabled) {
      this.git?.dispose(); this.git = null; this.state!.git = null;
    } else if (!this.git || !sameGit(previous.git, this.config.git)) {
      this.git?.dispose();
      this.git = this.options.gitFactory ? this.options.gitFactory(this.config.git) : new GitProbe(this.config.git, { now: this.now });
      this.wantGit = true;
    }
    if (!this.config.enabled) {
      this.ledger?.deactivate();
      this.scheduler?.cancel(); this.clearExpiry(); this.releaseFooter(); this.detachWidget();
      return;
    }
    if (!previous.enabled) this.resetEpoch();
    // Scope transitions rebuild the session ledger from scratch: an observed gap is never
    // continued incrementally, and leaving `session` stops all acquisition immediately.
    if (this.config.usageScope === "session") {
      if (previous.usageScope !== "session" || !previous.enabled) {
        this.ledger?.restart(this.readUsageManager(this.ctx ?? undefined), previous.enabled ? "scope" : "enable");
      }
    } else if (previous.usageScope === "session") {
      this.ledger?.deactivate();
    }
    // `placement` is a widget-only option: changing it must not disturb an installed footer.
    if (previous.placement !== this.config.placement && this.config.surface === "widget") this.detachWidget();
    this.attachSurface(claim);
    this.request();
  }

  async reloadConfig(notify: boolean) {
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
      this.configurationError = safeText((error as Error | null)?.message, 160) || "Could not load configuration";
      this.ready = true;
      this.attachWidget(); this.request();
      if (notify) this.notify(`pi-hud: ${this.configurationError}`, "warning");
    }
  }

  resetEpoch() {
    this.epoch++;
    this.git?.cancel();
    this.clearExpiry();
    this.state!.reset(this.ctx!.cwd, this.ctx!.model, this.now());
    this.state!.thinking = safeText(this.ctx!.thinkingLevel, 16);
    this.state!.phase = this.ctx!.isIdle() ? "idle" : "working";
    // A disabled HUD ignores model_select, so re-read the cheap identity fields here.
    this.identity.provider = safeText(this.ctx!.model?.provider, MAX_PROVIDER);
    this.wantGit = true;
  }

  flush() {
    if (!this.enabled || !this.ready) return;
    const started = this.monotonic();
    try {
      this.flushes++;
      this.state!.prune(this.now());
      this.attachSurface();
      this.syncBranchDirty();
      const snapshot = this.state!.snapshot();
      // The published ledger view is attached here, never re-read during render.
      if (this.config.usageScope === "session") snapshot.sessionUsage = this.ledger?.view() ?? null;
      this.view?.publish(snapshot, this.config);
      this.footer?.publish(snapshot, this.config, this.identity);
      this.scheduleExpiry();
      if (this.wantGit && this.git && this.state!.phase === "idle" && !this.state!.waiting && this.ctx!.isIdle()) {
        this.wantGit = false;
        const epoch = this.epoch;
        this.git.request(this.ctx!.cwd, (status: GitStatus) => {
          if (epoch !== this.epoch || !this.enabled || !this.config.git.enabled) return;
          this.state!.git = status;
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
    const next = this.state!.nextExpiry();
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

  notify(message: string, type = "info") {
    try { this.ctx?.ui.notify(message, type); } catch { this.callbackErrors++; }
  }

  /**
   * Which surface is actually live. `suppressed` means the user asked for the footer but a
   * later footer (another extension) owns the slot, so the HUD deliberately stays silent.
   */
  effectiveSurface(): string {
    if (this.footer) return "footer";
    if (this.attached) return "widget";
    if (this.config.surface === "footer" && this.footerSuppressed) return "suppressed";
    return "inactive";
  }

  inspect() {
    const statuses = this.footerData?.getExtensionStatuses?.();
    return {
      version: "0.1.0", targetPi: "0.85.1", enabled: this.enabled,
      mode: this.ctx?.mode ?? "inactive", preset: this.config.preset,
      surface: this.config.surface, surfaceEffective: this.effectiveSurface(),
      usageScope: this.config.usageScope,
      placement: this.config.placement, surfaceFallback: this.surfaceFallback,
      palette: this.config.palette, color: this.config.color, ascii: this.config.ascii,
      configurationPath: this.configurationPath, configurationError: this.configurationError,
      refreshMs: this.config.refreshMs, gitEnabled: this.config.git.enabled,
      observedEvents: [...OBSERVED_EVENTS],
      countersSince: this.state?.since ?? null,
      flushes: this.flushes, maxFlushMs: this.maxFlushMs,
      renderRequests: this.view?.paintRequests ?? 0,
      footerRenderRequests: this.footer?.paintRequests ?? 0,
      callbackErrors: this.callbackErrors,
      droppedActivity: this.state?.dropped ?? 0,
      boundedState: { tools: this.state?.tools.size ?? 0, agents: this.state?.agents.size ?? 0, tasks: this.state?.tasks.size ?? 0 },
      footerOwnership: {
        installed: this.footer !== null, owned: this.footerOwned, suppressed: this.footerSuppressed,
        installations: this.footerInstallations, nativeRestores: this.footerReleases,
        statusChecks: this.footer?.statusChecks ?? 0, statusChanges: this.footer?.statusChanges ?? 0,
        extensionStatuses: statuses && typeof statuses.size === "number" ? statuses.size : 0,
      },
      identity: {
        cwd: this.identity.cwd, provider: this.identity.provider, model: this.state?.model ?? "",
        thinking: this.state?.thinking ?? "", title: this.identity.title, branch: this.identity.branch,
      },
      observedUsage: {
        scope: "since attach/reset", input: this.state?.input ?? 0, output: this.state?.output ?? 0,
        cacheRead: this.state?.cacheRead ?? 0, cacheWrite: this.state?.cacheWrite ?? 0,
        cacheHitRate: this.state?.cacheHit ?? null, cost: this.state?.cost ?? 0,
      },
      sessionUsage: this.ledger?.inspect() ?? null,
      coverage: {
        counters: this.config.usageScope === "session"
          ? "session ledger totals over every SessionManager entry (all branches, pre-compaction, summaries); observed counters stay since attach/reset"
          : "observed since attach/reset; NOT a full-session ledger (the native footer aggregates every session entry)",
        context: "last observed assistant snapshot, labelled ctx(last); not the host's live context estimate; identical scope in observed and session modes",
        cacheHit: "most recent valid assistant: cacheRead / (input + cacheRead + cacheWrite); ? when unknown; stays observed-scope even in session mode",
        sessionLedger: this.config.usageScope === "session"
          ? (this.ledger?.view() ? "full-session ledger active; status/rebuild/host-call diagnostics above" : "requested but unavailable; explicitly degraded to observed-labelled data")
          : "inactive; usageScope: session opts in",
        title: "read at session start and on session_info_changed; never in render",
        branch: "footerData.getGitBranch() at install and on onBranchChange; no extra Git process",
        extensionStatuses: "footerData.getExtensionStatuses(); shown only by the footer surface, bounded to 8 entries / 64 chars / 2 rows",
      },
    };
  }

  async command(args: unknown, ctx?: PiContext) {
    if (ctx?.mode !== "tui" || !ctx.hasUI) return;
    try {
      if (!this.ctx) this.start(ctx);
      this.ctx = ctx;
      const input = typeof args === "string" ? args.slice(0, 256).trim().split(/\s+/) : [];
      const [command = "", value] = input;
      if (command === "status") { this.notify(JSON.stringify(this.inspect(), null, 2)); return; }
      if (command === "reload") { await this.reloadConfig(true); return; }
      if (command === "reset") {
        this.resetEpoch();
        // The session ledger keeps its definition (not since-reset); a cheap reconciliation
        // is requested so committed records stay verified after the observation reset.
        this.ledger?.requestVerify();
        this.request(); this.notify("pi-hud observation counters reset"); return;
      }
      if (command === "refresh") { this.wantGit = true; this.request(); return; }
      let next: HudConfig | undefined;
      let claim = false;
      if (["on", "off", "toggle"].includes(command)) {
        next = { ...this.config, enabled: command === "toggle" ? !this.config.enabled : command === "on" };
        claim = next.enabled;
      } else if (command === "surface" && ["widget", "footer"].includes(value as string)) {
        next = { ...this.config, surface: value as HudConfig["surface"] };
        // An explicit surface request is the documented way to re-claim a replaced slot.
        claim = true;
      } else if (command === "scope" && ["observed", "session"].includes(value as string)) {
        next = { ...this.config, usageScope: value as HudConfig["usageScope"] };
      } else if (command === "preset" && ["minimal", "balanced", "full"].includes(value as string)) {
        next = { ...this.config, preset: value as HudConfig["preset"] };
      } else if (command === "lang" && ["en", "zh-CN"].includes(value as string)) {
        next = { ...this.config, language: value as HudConfig["language"] };
      } else if (command === "git" && ["on", "off"].includes(value as string)) {
        next = { ...this.config, git: { ...this.config.git, enabled: value === "on" } };
      } else if (command === "palette" && ["pastel", "theme", "mono"].includes(value as string)) {
        next = { ...this.config, palette: value as HudConfig["palette"] };
      } else if (command === "placement" && ["aboveEditor", "belowEditor"].includes(value as string)) {
        next = { ...this.config, placement: value as HudConfig["placement"] };
      }
      if (!next) {
        this.notify("/hud on|off|toggle · surface widget|footer · scope observed|session · preset minimal|balanced|full · palette pastel|theme|mono · lang en|zh-CN · git on|off · placement aboveEditor|belowEditor · reload · refresh · reset · status\nChanges are in-memory. Edit pi-hud.json for persistence.");
        return;
      }
      // A pending startup load must not overwrite an explicit command.
      if (this.configTimer !== null) this.clearTimer(this.configTimer);
      this.configTimer = null;
      if (next.enabled && command !== "off") this.identity.title = safeText(this.readSessionName(ctx), MAX_TITLE);
      this.applyConfig(next, claim);
      if (command === "scope") {
        this.notify(`pi-hud scope ${value} (in-memory; session mode reads full history after this point)`);
        return;
      }
      if (command === "surface") {
        this.notify(this.surfaceFallback
          ? `pi-hud surface ${value}: ${this.surfaceFallback}`
          : `pi-hud surface ${value} (${this.effectiveSurface()}, in-memory)`);
        return;
      }
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
    this.ledger?.dispose();
    this.ledger = null;
    try { this.unsubscribe?.(); } catch { this.callbackErrors++; }
    this.unsubscribe = null;
    // Release our own surfaces in order: footer ownership first, then the widget.
    this.releaseFooter();
    this.detachWidget();
    this.footerSuppressed = false;
    this.surfaceFallback = null;
    this.ctx = null;
    this.state = null;
  }
}

export default function piHud(pi: ExtensionApi): void {
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
