/**
 * Surface lifecycle, ownership and data-adaptation tests for the optional footer.
 * The fake host mirrors Pi 0.85.1: `setFooter` is a single replacement slot that disposes
 * the previously installed component before running the next factory, and `setStatus`
 * mutates one Map in place and then asks the TUI to render.
 */
import test from "node:test";
import assert from "node:assert/strict";
import registerHud, { HudController } from "../src/extension.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FOOTER_BODY_ROWS, MAX_STATUS_COUNT, MAX_STATUS_ROWS } from "../src/footer.ts";
import { FakeClock, fakeHost, controllerFixture, widgetFixture, assistant, MODEL } from "./helpers.mjs";

const footerFixture = (config = {}, options = {}) => controllerFixture({ config: { surface: "footer", ...config }, ...options });
/** Footer lines are colored by default; text assertions run on stripped output. */
const plain = (lines) => lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));

test("factory registers the session-info event and still one slash command", () => {
  const host = fakeHost();
  const previous = process.env.PI_HUD_DISABLE;
  delete process.env.PI_HUD_DISABLE;
  try {
    registerHud(host.pi);
    assert.ok(host.handlers.has("session_info_changed"), "session title updates arrive on session_info_changed");
    assert.deepEqual([...host.commands.keys()], ["hud"]);
  } finally { if (previous === undefined) delete process.env.PI_HUD_DISABLE; else process.env.PI_HUD_DISABLE = previous; }
});

test("footer is the default surface (owner-approved switch) and mounts no widget", () => {
  const f = controllerFixture();
  assert.equal(f.controller.config.surface, "footer");
  assert.equal(f.controller.effectiveSurface(), "footer");
  assert.ok(f.footer());
  assert.equal(f.widget(), undefined);
  assert.equal(f.calls.footerInstalls, 1);
  f.emit("session_shutdown");
});

test("an explicit widget surface mounts no footer", () => {
  const f = widgetFixture();
  assert.equal(f.controller.config.surface, "widget");
  assert.equal(f.controller.effectiveSurface(), "widget");
  assert.ok(f.widget());
  assert.equal(f.footer(), undefined);
  assert.equal(f.calls.footerInstalls, 0);
  f.emit("session_shutdown");
});

test("footer surface installs only the footer and never the widget", () => {
  const f = footerFixture();
  assert.equal(f.controller.effectiveSurface(), "footer");
  assert.ok(f.footer(), "the footer component is installed");
  assert.equal(f.widget(), undefined, "footer mode must not mount the HUD widget");
  assert.equal(f.calls.footerInstalls, 1);
  assert.equal(f.calls.widget, 0, "no widget factory or removal is ever requested");
  const lines = f.footer().render(120);
  assert.equal(lines.length, FOOTER_BODY_ROWS.balanced);
  assert.match(lines.join("\n"), /Test Model/);
  assert.match(lines.join("\n"), /my-project/);
  f.emit("session_shutdown");
});

test("/hud surface switches live between widget and footer", async () => {
  const f = widgetFixture();
  await f.controller.command("surface footer", f.ctx);
  assert.equal(f.controller.effectiveSurface(), "footer");
  assert.ok(f.footer());
  assert.equal(f.widget(), undefined);
  assert.equal(f.calls.disposed, 1, "the previous widget was removed exactly once");
  await f.controller.command("surface widget", f.ctx);
  assert.equal(f.controller.effectiveSurface(), "widget");
  assert.ok(f.widget());
  assert.equal(f.footer(), undefined);
  assert.equal(f.calls.footerRestores, 1, "the native footer is restored exactly once");
  await f.controller.command("surface nonsense", f.ctx);
  assert.equal(f.controller.config.surface, "widget", "unknown values must not change the surface");
  f.emit("session_shutdown");
});

test("placement only affects the widget, never an installed footer", async () => {
  const f = footerFixture();
  const installs = f.calls.footerInstalls;
  const restores = f.calls.footerRestores;
  await f.controller.command("placement aboveEditor", f.ctx);
  assert.equal(f.calls.footerInstalls, installs, "the footer is not re-installed");
  assert.equal(f.calls.footerRestores, restores, "the native footer is not restored");
  assert.equal(f.controller.config.placement, "aboveEditor");
  assert.ok(f.footer());
  await f.controller.command("placement belowEditor", f.ctx);
  assert.equal(f.calls.footerInstalls, installs);
  f.emit("session_shutdown");
});

test("off restores the native footer while the HUD still owns it, and on re-installs", async () => {
  const f = footerFixture();
  await f.controller.command("off", f.ctx);
  assert.equal(f.calls.footerRestores, 1);
  assert.equal(f.footer(), undefined);
  assert.equal(f.clock.jobs.size, 0, "off cancels pending timers");
  await f.controller.command("on", f.ctx);
  assert.equal(f.calls.footerInstalls, 2);
  assert.ok(f.footer());
  f.emit("session_shutdown");
  assert.equal(f.calls.footerRestores, 2, "shutdown releases the footer it owns");
});

test("HUD-then-other: replacement is never cleared by off, dispose, refresh or plain events", async () => {
  const f = footerFixture();
  const other = f.installOtherFooter();
  assert.equal(f.controller.footer, null, "the HUD no longer holds a component");
  assert.equal(f.footer(), other, "the later footer owns the host slot");
  assert.equal(f.controller.inspect().footerOwnership.suppressed, true);
  assert.equal(other.render(80)[0], "other-footer");
  const restores = f.calls.footerRestores;
  const installs = f.calls.footerInstalls;
  // A plain refresh and ordinary HUD events must not steal the slot back.
  f.emit("agent_start");
  f.clock.advance(250);
  await f.controller.command("refresh", f.ctx);
  f.clock.advance(250);
  assert.equal(f.calls.footerInstalls, installs, "refresh must not re-install the HUD footer");
  await f.controller.command("off", f.ctx);
  assert.equal(f.calls.footerRestores, restores, "off must not clear a later extension footer");
  assert.equal(f.footer().render(80)[0], "other-footer", "the later footer survives off");
  f.emit("session_shutdown");
  assert.equal(f.calls.footerRestores, restores, "shutdown must not clear a later extension footer");
});

test("other-then-HUD: an explicit claim wins, and only then may off restore the native footer", async () => {
  const f = footerFixture();
  const other = f.installOtherFooter();
  assert.equal(f.controller.footer, null);
  assert.equal(f.footer(), other);
  await f.controller.command("surface footer", f.ctx);
  assert.notEqual(f.footer(), other);
  assert.equal(f.controller.effectiveSurface(), "footer");
  assert.equal(f.calls.footerDisposals, 1, "the displaced extension footer was disposed once");
  assert.deepEqual(other.render(80), [], "the displaced component stops rendering");
  assert.ok(f.footer());
  const installs = f.calls.footerInstalls;
  f.clock.advance(250);
  assert.equal(f.calls.footerInstalls, installs, "a refresh keeps the same installation");
  await f.controller.command("off", f.ctx);
  assert.equal(f.calls.footerRestores, 1, "off restores the native footer because the HUD owns it");
  f.emit("session_shutdown");
  assert.equal(f.calls.footerRestores, 1, "shutdown does not restore twice");
});

test("an explicit surface command re-claims a slot taken by another extension", async () => {
  const f = footerFixture();
  f.installOtherFooter();
  assert.equal(f.controller.effectiveSurface(), "suppressed");
  f.clock.advance(250);
  assert.equal(f.controller.effectiveSurface(), "suppressed", "refresh keeps suppression");
  await f.controller.command("surface footer", f.ctx);
  assert.equal(f.controller.effectiveSurface(), "footer");
  assert.notEqual(f.footer().render(80)[0], "other-footer");
  f.emit("session_shutdown");
});

test("host-driven replacement releases the old branch subscription and isolates old callbacks", () => {
  const f = footerFixture();
  const old = f.footer();
  assert.equal(f.controller.inspect().identity.branch, "main");
  f.installOtherFooter();
  assert.deepEqual(old.render(80), [], "a disposed component stops rendering");
  f.setBranch("feature/x");
  assert.equal(f.controller.identity.branch, "main", "the old subscription no longer fires");
  f.clock.advance(250);
  assert.equal(f.controller.identity.branch, "main");
  assert.equal(f.controller.inspect().callbackErrors, 0, "a late callback must not throw into the controller");
  f.emit("session_shutdown");
});

test("session replacement releases the old view, subscriptions and timers before re-installing", () => {
  const f = footerFixture();
  const first = f.footer();
  f.pi.events.emit("pi-hud:update", { version: 1, kind: "agent", source: "s", id: "a", status: "running", ttlMs: 1_000 });
  f.clock.advance(0);
  assert.ok(f.clock.jobs.size > 0);
  f.emit("session_shutdown");
  assert.equal(f.calls.footerRestores, 1);
  assert.deepEqual(first.render(80), [], "the released component cannot render stale state");
  assert.equal(f.bus.get("pi-hud:update").size, 0, "the bridge subscription is gone");
  assert.equal(f.clock.jobs.size, 0, "no timer survives the session");
  f.emit("session_start");
  assert.equal(f.controller.effectiveSurface(), "footer");
  assert.ok(f.footer());
  assert.equal(f.calls.footerInstalls, 2);
  f.emit("session_shutdown");
});

test("reload re-installs after a host reset and the title identity is refreshed", () => {
  const f = footerFixture();
  f.setSessionName("My session");
  f.emit("session_shutdown");
  // The host reset happens before session_start on /reload; the next start reclaims the slot.
  f.emit("session_start");
  assert.equal(f.controller.effectiveSurface(), "footer");
  assert.equal(f.controller.identity.title, "My session");
  f.emit("session_info_changed", { name: "Renamed" });
  assert.equal(f.controller.identity.title, "Renamed");
  f.clock.advance(250);
  assert.match(plain(f.footer().render(120)).join("\n"), /Renamed/);
  f.emit("session_shutdown");
});

test("title, provider, thinking and model updates reach the footer without history reads", () => {
  const f = footerFixture();
  f.emit("session_info_changed", { name: "Goal: footer phase" });
  assert.equal(f.controller.identity.title, "Goal: footer phase");
  f.emit("model_select", { model: { ...MODEL, id: "next-model", name: "Next Model", provider: "other-provider" } });
  assert.equal(f.controller.identity.provider, "other-provider");
  f.emit("thinking_level_select", { level: "minimal" });
  assert.equal(f.controller.state.thinking, "minimal");
  f.clock.advance(250);
  const text = plain(f.footer().render(180)).join("\n");
  assert.match(text, /Next Model/);
  assert.match(text, /other-provider/);
  assert.match(text, /minimal/);
  assert.match(text, /Goal: footer phase/);
  f.emit("session_shutdown");
});

test("branch comes from footerData at install and on onBranchChange, never during render", () => {
  const f = footerFixture();
  const reads = f.calls.branchReads;
  assert.equal(reads, 1, "one read at install");
  const footer = f.footer();
  assert.match(plain(footer.render(120)).join("\n"), /git:main/);
  assert.equal(f.calls.branchReads, reads, "render must not call getGitBranch");
  f.setBranch("feature/footer");
  assert.equal(f.controller.identity.branch, "feature/footer");
  f.clock.advance(250);
  assert.match(plain(footer.render(120)).join("\n"), /git:feature\/footer/);
  assert.equal(f.calls.branchReads, reads + 1, "one read per branch notification, none per render");
  f.emit("session_shutdown");
});

test("the opt-in Git probe still owns the dirty marker", async () => {
  let probes = 0;
  const f = footerFixture({ git: { enabled: true } }, {
    gitFactory: () => {
      probes++;
      return { request: (_cwd, done) => { done({ available: true, branch: "main", dirty: true }); return true; }, cancel() {}, dispose() {} };
    },
  });
  f.setIdle(true);
  f.emit("agent_settled");
  f.clock.advance(250);
  assert.equal(probes, 1);
  assert.match(plain(f.footer().render(120)).join("\n"), /git:main\*/);
  await f.controller.command("git off", f.ctx);
  f.clock.advance(250);
  assert.doesNotMatch(plain(f.footer().render(120)).join("\n"), /git:main\*/);
  f.emit("session_shutdown");
});

test("non-TUI modes perform zero terminal UI operations", () => {
  for (const mode of ["rpc", "json", "print"]) {
    const f = controllerFixture({ mode, config: { surface: "footer" }, loadOnStart: true });
    f.emit("agent_start");
    f.emit("agent_settled");
    f.emit("session_info_changed", { name: "nope" });
    f.clock.advance(10_000);
    assert.equal(f.calls.widget, 0, `${mode}: no widget`);
    assert.equal(f.calls.footerInstalls, 0, `${mode}: no footer`);
    assert.equal(f.calls.footerRestores, 0, `${mode}: native footer untouched`);
    assert.equal(f.calls.paint, 0, `${mode}: no render request`);
  }
});

test("inspect reports surface ownership and the difference from native footer coverage", async () => {
  const f = footerFixture();
  f.emit("message_end", { message: assistant() });
  const status = f.controller.inspect();
  assert.equal(status.surface, "footer");
  assert.equal(status.surfaceEffective, "footer");
  assert.equal(status.footerOwnership.installed, true);
  assert.equal(status.footerOwnership.owned, true);
  assert.equal(status.footerOwnership.suppressed, false);
  assert.equal(status.footerOwnership.nativeRestores, 0);
  assert.equal(status.identity.provider, "mock");
  assert.equal(status.identity.branch, "main");
  assert.equal(status.identity.model, "Test Model");
  assert.equal(status.observedUsage.input, 1_000);
  assert.equal(status.observedUsage.cacheRead, 2_000);
  assert.equal(status.observedUsage.scope, "since attach/reset");
  assert.match(status.coverage.counters, /not a full-session ledger/i);
  assert.match(status.coverage.context, /last observed assistant snapshot/i);
  assert.match(status.coverage.cacheHit, /most recent valid assistant/i);
  assert.match(status.coverage.extensionStatuses, /footer surface/);
  await f.controller.command("status", f.ctx);
  const parsed = JSON.parse(f.calls.notifications.at(-1).message);
  assert.equal(parsed.surfaceEffective, "footer");
  f.emit("session_shutdown");
});

test("observed usage is labelled, split and never claims the full-session totals", () => {
  const f = footerFixture();
  f.emit("message_end", { message: assistant() });
  f.clock.advance(250);
  const text = plain(f.footer().render(120)).join("\n");
  assert.match(text, /obs\*/);
  assert.match(text, /↑1\.0k/);
  assert.match(text, /↓300/);
  assert.match(text, /R2\.0k/);
  assert.match(text, /W400/);
  assert.match(text, /CH58\.8%/);
  f.emit("session_shutdown");
});

test("status map mutations reach the installed footer without any HUD event", () => {
  const f = footerFixture();
  const footer = f.footer();
  assert.equal(footer.render(120).length, FOOTER_BODY_ROWS.balanced);
  f.setStatus("pi-goal", "goal active");
  const withStatus = footer.render(120);
  assert.equal(withStatus.length, FOOTER_BODY_ROWS.balanced + 1);
  assert.match(plain(withStatus).join("\n"), /goal active/);
  f.setStatus("pi-goal", "goal automatic");
  assert.match(plain(footer.render(120)).join("\n"), /goal automatic/);
  assert.doesNotMatch(plain(footer.render(120)).join("\n"), /goal active/);
  f.setStatus("pi-goal", undefined);
  assert.equal(footer.render(120).length, FOOTER_BODY_ROWS.balanced);
  assert.equal(f.controller.inspect().footerOwnership.statusChanges, 3);
  f.emit("session_shutdown");
});

test("status comparison is bounded: a huge status map is sampled, never iterated whole", () => {
  const f = footerFixture();
  const footer = f.footer();
  let iterations = 0;
  const huge = new Map();
  for (let index = 0; index < 50_000; index++) huge.set(`k${index}`, "v");
  const spy = {
    get size() { return huge.size; },
    *[Symbol.iterator]() {
      for (const entry of huge) {
        iterations++;
        if (iterations > MAX_STATUS_COUNT * 4) throw new Error("unbounded status iteration");
        yield entry;
      }
    },
  };
  f.footerData.getExtensionStatuses = () => spy;
  footer.invalidate();
  const lines = footer.render(120);
  // A `for...of` pull reads one entry beyond the cap before the loop body can break.
  assert.ok(iterations <= 2 * (MAX_STATUS_COUNT + 1), `one change check plus one render read ${iterations} entries`);
  assert.ok(lines.length <= FOOTER_BODY_ROWS.balanced + MAX_STATUS_ROWS);
  assert.match(plain(lines).join("\n"), /\+49992/);
  // Unchanged data must reuse the final rendered array.
  const checks = iterations;
  const again = footer.render(120);
  assert.equal(again, lines);
  assert.ok(iterations - checks <= MAX_STATUS_COUNT + 1, "the cached path only runs the bounded comparison");
  f.emit("session_shutdown");
});

test("a footer released by shutdown never renders stale state", () => {
  const f = footerFixture();
  const stale = f.footer();
  f.emit("session_shutdown");
  assert.deepEqual(stale.render(120), []);
  assert.equal(f.controller.ctx, null);
  assert.equal(f.controller.state, null);
});

test("footer surface falls back to the widget when the host lacks setFooter", async () => {
  const host = fakeHost();
  delete host.ctx.ui.setFooter;
  const clock = new FakeClock();
  const controller = new HudController(host.pi, {
    loadOnStart: false, env: {}, config: { surface: "footer" },
    now: clock.now, monotonic: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const emit = (name, payload = {}) => controller.handle(name, payload, host.ctx);
  emit("session_start");
  assert.ok(host.widget(), "the widget surface is mounted as a fallback");
  assert.equal(controller.effectiveSurface(), "widget");
  assert.match(controller.surfaceFallback, /setFooter is unavailable/);
  const status = controller.inspect();
  assert.equal(status.surface, "footer");
  assert.equal(status.surfaceEffective, "widget");
  assert.match(status.surfaceFallback, /setFooter is unavailable/);
  await controller.command("surface footer", host.ctx);
  assert.equal(controller.config.surface, "footer");
  assert.match(host.calls.notifications.at(-1).message, /setFooter is unavailable/);
  assert.equal(host.calls.footerInstalls, 0);
  emit("session_shutdown");
});

test("a configure-time footer surface still falls back silently at startup", () => {
  const host = fakeHost();
  delete host.ctx.ui.setFooter;
  const clock = new FakeClock();
  const controller = new HudController(host.pi, {
    loadOnStart: false, env: {}, config: { surface: "footer" },
    now: clock.now, monotonic: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  controller.handle("session_start", {}, host.ctx);
  assert.ok(host.widget());
  assert.equal(host.calls.notifications.length, 0, "startup must not emit unsolicited error text");
  assert.equal(DEFAULT_CONFIG.surface, "footer");
  controller.stop();
});
