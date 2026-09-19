import test from "node:test";
import assert from "node:assert/strict";
import registerHud, { OBSERVED_EVENTS, BRIDGE_EVENT } from "../src/extension.mjs";
import { Coalescer } from "../src/scheduler.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { FakeClock, fakeHost, controllerFixture, assistant } from "./helpers.mjs";

test("factory registers only approved observational events and one slash command", () => {
  const host = fakeHost(); const previous = process.env.PI_HUD_DISABLE;
  delete process.env.PI_HUD_DISABLE;
  try {
    assert.equal(registerHud(host.pi), undefined);
    assert.deepEqual([...host.handlers.keys()], [...OBSERVED_EVENTS]);
    assert.deepEqual([...host.commands.keys()], ["hud"]);
    for (const name of ["message_update", "tool_execution_update", "tool_call", "tool_result", "context", "input", "before_agent_start"]) assert.equal(host.handlers.has(name), false);
    assert.equal(host.calls.widget, 0);
  } finally { if (previous === undefined) delete process.env.PI_HUD_DISABLE; else process.env.PI_HUD_DISABLE = previous; }
});
test("environment kill switch registers nothing", () => {
  const host = fakeHost(); const previous = process.env.PI_HUD_DISABLE; process.env.PI_HUD_DISABLE = "1";
  try { registerHud(host.pi); assert.equal(host.handlers.size, 0); assert.equal(host.commands.size, 0); }
  finally { if (previous === undefined) delete process.env.PI_HUD_DISABLE; else process.env.PI_HUD_DISABLE = previous; }
});
for (const mode of ["rpc", "json", "print"]) {
  test(`${mode} mode never reads configuration, mounts a widget, starts a timer, or probes Git`, () => {
    let reads = 0; let probes = 0;
    const f = controllerFixture({ mode, loadOnStart: true, configLoader: () => { reads++; }, gitFactory: () => { probes++; } });
    f.emit("agent_start"); f.emit("message_end", { message: assistant() }); f.clock.advance(10_000);
    assert.equal(reads, 0); assert.equal(probes, 0); assert.equal(f.calls.widget, 0); assert.equal(f.clock.jobs.size, 0);
  });
}
test("event handlers are synchronous void observers and never mutate incoming payloads", () => {
  const f = controllerFixture();
  const payload = Object.freeze({ message: Object.freeze(assistant()) });
  assert.equal(f.emit("message_end", payload), undefined);
  assert.equal(f.controller.state.contextTokens, 3700);
  assert.equal(f.controller.inspect().callbackErrors, 0); f.emit("session_shutdown");
});
test("configuration I/O is deferred beyond session_start and never awaited by a core hook", async () => {
  let reads = 0;
  const f = controllerFixture({ loadOnStart: true, configLoader: async () => { reads++; return { config: DEFAULT_CONFIG, found: false }; } });
  assert.equal(reads, 0); assert.equal(f.calls.widget, 0);
  f.clock.advance(0); assert.equal(reads, 1);
  await Promise.resolve(); await Promise.resolve(); f.clock.advance(0);
  assert.equal(f.calls.widget, 1); f.emit("session_shutdown");
});
test("late config completion cannot resurrect a stopped session", async () => {
  let resolve;
  const f = controllerFixture({ loadOnStart: true, configLoader: () => new Promise((done) => { resolve = done; }) });
  f.clock.advance(0); f.emit("session_shutdown");
  resolve({ config: DEFAULT_CONFIG, found: true }); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.widget, 0); assert.equal(f.clock.jobs.size, 0); assert.equal(f.controller.ctx, null);
});
test("explicit commands win races against the startup config read", async () => {
  let resolve;
  const f = controllerFixture({ loadOnStart: true, configLoader: () => new Promise((done) => { resolve = done; }) });
  f.clock.advance(0); await f.controller.command("preset minimal", f.ctx);
  resolve({ config: { ...DEFAULT_CONFIG, preset: "full" }, found: true }); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.controller.config.preset, "minimal"); f.emit("session_shutdown");
});
test("invalid reload keeps the last good settings and reports the error only to the user command", async () => {
  const f = controllerFixture({ config: { preset: "minimal" }, configLoader: async () => { throw new Error("Invalid preset"); } });
  await f.controller.command("reload", f.ctx);
  assert.equal(f.controller.config.preset, "minimal"); assert.equal(f.controller.configurationError, "Invalid preset");
  assert.ok(f.calls.notifications.length > 0); f.emit("session_shutdown");
});
test("agent_end is settling, not a false idle state before agent_settled", () => {
  const f = controllerFixture(); f.setIdle(false); f.emit("agent_start"); f.emit("agent_end");
  assert.equal(f.controller.state.phase, "settling"); f.setIdle(true); f.emit("agent_settled");
  assert.equal(f.controller.state.phase, "idle"); f.emit("session_shutdown");
});
test("tree navigation starts fresh counters and invalidates previous context", () => {
  const f = controllerFixture(); f.emit("message_end", { message: assistant() }); f.clock.advance(100);
  f.emit("session_tree"); assert.equal(f.controller.state.cost, 0); assert.equal(f.controller.state.contextTokens, null);
  f.emit("session_shutdown");
});
test("off cancels work, on starts a fresh observation epoch", async () => {
  const f = controllerFixture(); f.emit("message_end", { message: assistant() });
  await f.controller.command("off", f.ctx);
  assert.equal(f.clock.jobs.size, 0); assert.equal(f.widget(), undefined);
  f.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" });
  await f.controller.command("on", f.ctx);
  assert.equal(f.controller.state.cost, 0); assert.equal(f.controller.state.tools.size, 0); f.emit("session_shutdown");
});
test("shutdown clears all timers, event-bus listeners and widget ownership", () => {
  const f = controllerFixture();
  f.pi.events.emit(BRIDGE_EVENT, { version: 1, kind: "agent", source: "test", id: "x", status: "running", ttlMs: 1_000 });
  f.clock.advance(0); assert.ok(f.clock.jobs.size > 0); f.emit("session_shutdown");
  assert.equal(f.clock.jobs.size, 0); assert.equal(f.bus.get(BRIDGE_EVENT).size, 0); assert.equal(f.widget(), undefined);
  assert.equal(f.controller.state, null); assert.doesNotThrow(() => f.emit("session_shutdown"));
});
test("bridge expiry uses one-shot cleanup and becomes completely idle afterwards", () => {
  const f = controllerFixture();
  f.pi.events.emit(BRIDGE_EVENT, { version: 1, kind: "agent", source: "test", id: "x", status: "running", ttlMs: 1_000 });
  f.clock.advance(2_000);
  assert.equal(f.controller.state.agents.size, 0); assert.equal(f.clock.jobs.size, 0);
  const flushes = f.controller.flushes; f.clock.advance(60_000); assert.equal(f.controller.flushes, flushes); f.emit("session_shutdown");
});
test("a malformed observer payload fails open instead of throwing into Pi", () => {
  const f = controllerFixture();
  const payload = Object.defineProperty({}, "message", { get() { throw new Error("bad getter"); } });
  assert.doesNotThrow(() => f.emit("message_end", payload));
  assert.equal(f.controller.callbackErrors, 1); f.emit("session_shutdown");
});
test("one coalescer timer absorbs a burst and has no trailing idle poll", () => {
  const clock = new FakeClock(); let calls = 0;
  const scheduler = new Coalescer(() => { calls++; }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  for (let i = 0; i < 100_000; i++) scheduler.request();
  assert.equal(clock.jobs.size, 1); clock.advance(0); assert.equal(calls, 1); assert.equal(clock.jobs.size, 0);
  scheduler.request(); clock.advance(249); assert.equal(calls, 1); clock.advance(1); assert.equal(calls, 2);
  clock.advance(10_000); assert.equal(calls, 2);
});
test("continuous activity cannot starve trailing updates or exceed the 250 ms cadence", () => {
  const clock = new FakeClock(); const at = [];
  const scheduler = new Coalescer(() => { at.push(clock.now()); }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  for (let i = 0; i < 100; i++) { scheduler.request(); clock.advance(10); }
  assert.deepEqual(at, [0, 250, 500, 750, 1000]);
  scheduler.dispose(); assert.equal(clock.jobs.size, 0);
});
test("tool event flood is coalesced into one scheduled UI publication", () => {
  const f = controllerFixture();
  for (let i = 0; i < 10_000; i++) {
    f.emit("tool_execution_start", { toolCallId: String(i), toolName: "read" });
    f.emit("tool_execution_end", { toolCallId: String(i), toolName: "read" });
  }
  assert.equal(f.clock.jobs.size, 1); f.clock.advance(0);
  assert.equal(f.controller.flushes, 1); assert.equal(f.controller.state.done, 10_000);
  f.clock.advance(60_000); assert.equal(f.controller.flushes, 1); f.emit("session_shutdown");
});
