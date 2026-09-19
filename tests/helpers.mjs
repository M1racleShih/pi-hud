import assert from "node:assert/strict";
import { HudController } from "../src/extension.mjs";

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

export function fakeHost(mode = "tui") {
  const handlers = new Map();
  const bus = new Map();
  const commands = new Map();
  const calls = { widget: 0, paint: 0, notifications: [], disposed: 0 };
  let widget;
  let idle = true;
  const theme = { fg: (_tone, text) => text };
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
    notify(message, level) { calls.notifications.push({ message, level }); },
  };
  const ctx = {
    mode, hasUI: ["tui", "rpc"].includes(mode), cwd: "/tmp/my-project",
    model: MODEL, thinkingLevel: "high", ui, isIdle: () => idle,
    getContextUsage: () => { throw new Error("History/context scans forbidden"); },
    sessionManager: new Proxy({}, { get() { throw new Error("No session history access permitted"); } }),
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
    pi, ctx, calls, handlers, bus, commands,
    widget: () => widget,
    setIdle(value) { idle = value; },
    emit(name, payload = {}) { return (handlers.get(name) ?? []).map((handler) => handler(payload, ctx)); },
  };
}

export function controllerFixture(options = {}) {
  const host = fakeHost(options.mode ?? "tui");
  const clock = new FakeClock();
  const controller = new HudController(host.pi, {
    loadOnStart: false, env: {},
    now: clock.now, monotonic: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...options,
  });
  const emit = (name, payload = {}) => controller.handle(name, payload, host.ctx);
  emit("session_start");
  return { ...host, clock, controller, emit };
}
