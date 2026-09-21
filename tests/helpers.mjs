import assert from "node:assert/strict";
import { HudController } from "../src/extension.ts";

export class FakeClock {
  time = 0;
  nextId = 1;
  jobs = new Map();
  now = () => this.time;
  setTimer = (callback, delay) => {
    const id = this.nextId++;
    this.jobs.set(id, { callback, at: this.time + Math.max(0, delay) });
    return id;
  };
  clearTimer = (id) => { this.jobs.delete(id); };
  advance(ms = 0) {
    const end = this.time + ms;
    let guard = 0;
    while (true) {
      let selected = null;
      for (const [id, job] of this.jobs) {
        if (job.at <= end && (!selected || job.at < selected[1].at)) selected = [id, job];
      }
      if (!selected) break;
      assert.ok(++guard < 50_000, "Timer loop did not quiesce");
      this.jobs.delete(selected[0]);
      this.time = selected[1].at;
      selected[1].callback();
    }
    this.time = end;
  }
}

export const MODEL = Object.freeze({ id: "test-model", name: "Test Model", provider: "mock", contextWindow: 200_000 });
export const assistant = (overrides = {}) => ({
  role: "assistant", model: MODEL.id, provider: MODEL.provider, stopReason: "stop", content: [],
  usage: { input: 1_000, output: 300, cacheRead: 2_000, cacheWrite: 400, cost: { total: 0.012 } },
  ...overrides,
});

/**
 * Session-manager fixture mirroring the pinned SDK's semantics where the ledger depends on
 * them: entries get an id and `parentId` at append time, `getEntries()` returns a fresh
 * shallow array of every entry (all branches), `getEntry` is a Map lookup and `getLeafId`
 * is the last appended (or navigated) entry. Usage fixtures use the native Usage shape.
 */
export class FakeSessionManager {
  constructor(sessionId = "sess-1") {
    this.sessionId = sessionId;
    this.name = undefined;
    this.byId = new Map();
    this.order = [];
    this.leaf = null;
    this.seq = 0;
    this.calls = { getEntries: 0, getEntry: 0, getLeafId: 0, getSessionId: 0 };
  }
  getSessionId() { this.calls.getSessionId++; return this.sessionId; }
  getSessionName() { return this.name; }
  getLeafId() { this.calls.getLeafId++; return this.leaf; }
  getEntry(id) { this.calls.getEntry++; return this.byId.get(id); }
  getEntries() { this.calls.getEntries++; return this.order.slice(); }
  append(entry) {
    const id = `e${++this.seq}`;
    const full = Object.freeze({ id, parentId: this.leaf, timestamp: "2026-09-20T00:00:00.000Z", ...entry });
    this.byId.set(id, full);
    this.order.push(full);
    this.leaf = id;
    return id;
  }
  appendMessage(message) { return this.append({ type: "message", message }); }
  appendCompaction(summary, usage) { return this.append({ type: "compaction", summary, firstKeptEntryId: null, tokensBefore: 0, usage }); }
  appendBranchSummary(summary, usage) { return this.append({ type: "branch_summary", fromId: null, summary, usage }); }
  /** Simulate a navigated tree position without appending anything. */
  navigate(leafId) { this.leaf = leafId; }
  /** Break the id index only; getEntries keeps the record (chain-walk failure fixture). */
  dropIndex(id) { this.byId.delete(id); }
}

export const usage = (n) => ({
  input: n, output: n * 2, cacheRead: n * 3, cacheWrite: n * 4, totalTokens: n * 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: n / 100 },
});
export const assistantEntry = (n, overrides = {}) => ({ role: "assistant", model: "m", provider: "p", stopReason: "stop", content: [], usage: usage(n), ...overrides });
export const toolResultEntry = (n) => ({ role: "toolResult", toolCallId: "t", toolName: "t", content: [], isError: false, usage: usage(n) });

/**
 * Independent oracle for the native footer's aggregation rule (assistant, toolResult with
 * usage, compaction/branch_summary with usage; four token fields and cost.total summed
 * separately). Written against the SDK's footer.js/usage-totals.js behaviour, not against
 * the ledger's reducer, so agreement is evidence and not a tautology.
 */
export function oracleTotals(entries) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, records: 0 };
  for (const entry of entries) {
    let u = null;
    if (entry.type === "message" && entry.message) {
      if (entry.message.role === "assistant") u = entry.message.usage;
      else if (entry.message.role === "toolResult" && entry.message.usage) u = entry.message.usage;
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) u = entry.usage;
    if (!u) continue;
    totals.input += u.input; totals.output += u.output;
    totals.cacheRead += u.cacheRead; totals.cacheWrite += u.cacheWrite;
    totals.cost += u.cost ? u.cost.total : 0;
    totals.records++;
  }
  return totals;
}

/** One-timer-at-a-time manual clock for observing ledger slicing boundaries. */
export class ManualClock {
  jobs = [];
  setTimer = (callback) => { const job = { callback, cancelled: false }; this.jobs.push(job); return job; };
  clearTimer = (job) => { job.cancelled = true; };
  step() {
    while (this.jobs.length && this.jobs[0].cancelled) this.jobs.shift();
    const job = this.jobs.shift();
    if (job) job.callback();
  }
  get pending() { return this.jobs.filter((job) => !job.cancelled).length; }
}

export function fakeHost(mode = "tui", options = {}) {
  const handlers = new Map();
  const bus = new Map();
  const commands = new Map();
  const calls = { widget: 0, paint: 0, notifications: [], disposed: 0, footerInstalls: 0, footerRestores: 0, footerDisposals: 0, branchReads: 0 };
  let widget;
  let footer;
  let sessionName;
  let idle = true;
  const theme = { fg: (_tone, text) => text };
  const branchListeners = new Set();
  const footerData = {
    branch: "main",
    statuses: new Map(),
    getGitBranch() { calls.branchReads++; return footerData.branch; },
    getExtensionStatuses() { return footerData.statuses; },
    onBranchChange(callback) { branchListeners.add(callback); return () => { branchListeners.delete(callback); }; },
  };
  const tui = { requestRender: () => { calls.paint++; } };
  const ui = {
    theme,
    setWidget(key, factory, options) {
      assert.equal(key, "pi-hud");
      calls.widget++;
      widget?.dispose?.();
      if (factory) {
        assert.ok(["aboveEditor", "belowEditor"].includes(options.placement));
        widget = factory({ requestRender: () => { calls.paint++; } }, theme);
      } else { widget = undefined; calls.disposed++; }
    },
    // Mirrors the real host: the previously installed component is disposed first, then the
    // new factory runs (or the built-in footer is restored).
    setFooter(factory) {
      footer?.dispose?.();
      footer = undefined;
      if (factory) { calls.footerInstalls++; footer = factory(tui, theme, footerData); }
      else calls.footerRestores++;
    },
    notify(message, level) { calls.notifications.push({ message, level }); },
  };
  if (mode !== "tui" && mode !== "rpc") delete ui.setFooter;
  const ctx = {
    mode, hasUI: ["tui", "rpc"].includes(mode), cwd: "/tmp/my-project",
    model: MODEL, thinkingLevel: "high", ui, isIdle: () => idle,
    modelRegistry: options.modelRegistry,
    getContextUsage: () => { throw new Error("History/context scans forbidden"); },
    // Only the session name is readable by default; every other history access fails the
    // test. Fixtures that exercise the session ledger pass a FakeSessionManager instead.
    sessionManager: options.usageManager ?? new Proxy({
      getSessionName: () => sessionName,
    }, {
      get(target, property) {
        if (property in target) return target[property];
        throw new Error(`No session history access permitted: ${String(property)}`);
      },
    }),
  };
  const pi = {
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand(name, command) { commands.set(name, command); },
    events: {
      on(name, handler) {
        const list = bus.get(name) ?? new Set(); list.add(handler); bus.set(name, list);
        return () => { list.delete(handler); };
      },
      emit(name, payload) { for (const handler of bus.get(name) ?? []) handler(payload); },
    },
  };
  return {
    pi, ctx, calls, handlers, bus, commands, footerData,
    widget: () => widget,
    footer: () => footer,
    /** Simulate a different extension claiming the single footer slot. */
    installOtherFooter(component) {
      let disposed = false;
      const other = component ?? { render: () => (disposed ? [] : ["other-footer"]), dispose() { disposed = true; calls.footerDisposals++; } };
      ui.setFooter(() => other);
      return other;
    },
    setBranch(branch) { footerData.branch = branch; for (const callback of branchListeners) callback(); },
    /** Mirrors `setExtensionStatus`: in-place map mutation followed by a host render request. */
    setStatus(key, value) {
      if (value === undefined) footerData.statuses.delete(key); else footerData.statuses.set(key, value);
      tui.requestRender();
    },
    setSessionName(name) {
      sessionName = name;
      const manager = options.usageManager;
      if (manager && "name" in manager) manager.name = name;
    },
    setIdle(value) { idle = value; },
    emit(name, payload = {}) { return (handlers.get(name) ?? []).map((handler) => handler(payload, ctx)); },
  };
}

export function controllerFixture(options = {}) {
  const host = fakeHost(options.mode ?? "tui", options);
  const clock = new FakeClock();
  const controller = new HudController(host.pi, {
    loadOnStart: false, env: {},
    now: clock.now, monotonic: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...options,
  });
  const emit = (name, payload = {}) => controller.handle(name, payload, host.ctx);
  emit("session_start");
  return { ...host, clock, controller, emit, manager: options.usageManager ?? null };
}

/** Pin the widget surface for tests about widget behavior (the default is footer). */
export const widgetFixture = (config = {}, options = {}) =>
  controllerFixture({ config: { surface: "widget", ...config }, ...options });
