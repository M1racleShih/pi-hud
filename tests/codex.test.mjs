/**
 * Codex adapter tests: profile validation, response normalization against the
 * 0.155.1 app-server contract, the bounded subprocess driver (fake child), and
 * service integration through the injectable process runner. All process, clock
 * and auth surfaces are injected; no test spawns a real codex CLI. Samples follow
 * the verified shapes from the 2026-09-22 read-only probe with synthetic values.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQuota } from "../src/config.ts";
import { codexParse, codexPrepare, CODEX_QUOTA_ORIGIN } from "../src/quota/adapters/codex.ts";
import { runCodexRateLimitsQuery, CODEX_MIN_TOTAL_MS, CODEX_MAX_FRAME_BYTES } from "../src/quota/codex-process.ts";
import { QuotaService } from "../src/quota/service.ts";
import { quotaField, LABELS } from "../src/render.ts";
import { normalizeConfig as normalize } from "../src/config.ts";
import { FakeClock } from "./helpers.mjs";

const noHeaders = { get: () => null };
const flush = async (times = 8) => { for (let index = 0; index < times; index++) await new Promise((resolve) => setImmediate(resolve)); };

const codexProfile = {
  id: "codex-main", providerId: "openai-codex", adapter: "codex", source: "codex-app-server",
};

// ---------------------------------------------------------------------------
// The verified 0.155.1 response shape (synthetic values, probe structure)
// ---------------------------------------------------------------------------

const probeShapeResult = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex", limitName: null, normalModelSlug: null,
    primary: { usedPercent: 79, windowDurationMins: 10080, resetsAt: 1790431051 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null, spendControlReached: false,
    planType: "prolite", rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex", limitName: null, normalModelSlug: null,
      primary: { usedPercent: 79, windowDurationMins: 10080, resetsAt: 1790431051 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      individualLimit: null, spendControlReached: false,
      planType: "prolite", rateLimitReachedType: null,
    },
  },
  rateLimitResetCredits: { availableCount: 2, credits: [] },
  accountId: "00000000-0000-0000-0000-000000000000",
  rateLimitUpsell: null,
};

// ---------------------------------------------------------------------------
// codexPrepare
// ---------------------------------------------------------------------------

test("codexPrepare returns the fixed process spec and needs no host credential", () => {
  const prepared = codexPrepare({ profile: codexProfile, auth: null });
  assert.deepEqual(prepared, { kind: "process", command: "codex", args: ["app-server"] });
});

test("codexPrepare refuses an https origin field and a mismatched source", () => {
  assert.equal(codexPrepare({ profile: { ...codexProfile, origin: "https://api.openai.com" }, auth: null }).issue?.code, "needs-verification");
  assert.equal(codexPrepare({ profile: { ...codexProfile, source: "pi" }, auth: null }).issue?.code, "needs-verification");
});

test("config accepts the codex profile and rejects origin for it", () => {
  const quota = normalizeQuota({ profiles: [codexProfile] });
  assert.equal(quota.profiles[0].source, "codex-app-server");
  assert.throws(() => normalizeQuota({ profiles: [{ ...codexProfile, origin: "https://api.openai.com" }] }), /origin is not a valid field for adapter codex/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...codexProfile, source: "pi" }] }), /source pi is not valid for adapter codex/);
});

// ---------------------------------------------------------------------------
// codexParse
// ---------------------------------------------------------------------------

test("codexParse maps the verified probe shape: week window, seconds reset, plan label", () => {
  const parsed = codexParse(200, noHeaders, JSON.stringify(probeShapeResult), { now: 0 });
  assert.equal(parsed.kind, "snapshot");
  const snapshot = parsed.snapshot;
  assert.equal(snapshot.planLabel, "prolite");
  assert.equal(snapshot.buckets.length, 1);
  const bucket = snapshot.buckets[0];
  assert.equal(bucket.id, "codex:primary");
  assert.deepEqual(bucket.window, { unit: "week", number: 1 });
  assert.equal(bucket.usedPercent, 79);
  assert.equal(bucket.remainingPercent, 21);
  assert.equal(bucket.resetAt, 1790431051_000);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.ignoredBuckets, 0);
});

test("codexParse maps primary and secondary as separate buckets, never merged", () => {
  const result = {
    rateLimits: {},
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex", planType: "pro",
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1790431051 },
        secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: 1790600000 },
      },
    },
  };
  const parsed = codexParse(200, noHeaders, JSON.stringify(result), { now: 0 });
  assert.equal(parsed.kind, "snapshot");
  const [fiveHour, week] = parsed.snapshot.buckets;
  assert.deepEqual(fiveHour.window, { unit: "hour", number: 5 });
  assert.equal(fiveHour.remainingPercent, 88);
  assert.deepEqual(week.window, { unit: "week", number: 1 });
  assert.equal(week.remainingPercent, 36);
  assert.equal(parsed.snapshot.planLabel, "pro");
});

test("codexParse falls back to the single-bucket view when the map is absent", () => {
  const single = { ...probeShapeResult, rateLimitsByLimitId: null };
  const parsed = codexParse(200, noHeaders, JSON.stringify(single), { now: 0 });
  assert.equal(parsed.kind, "snapshot");
  assert.equal(parsed.snapshot.buckets.length, 1);
  assert.equal(parsed.snapshot.buckets[0].id, "codex:primary");
});

test("unknown window durations and invalid resets stay unknown, never guessed", () => {
  const result = {
    rateLimits: { limitId: "codex", planType: "free", primary: { usedPercent: 3, windowDurationMins: 720, resetsAt: -5 } },
  };
  const parsed = codexParse(200, noHeaders, JSON.stringify(result), { now: 0 });
  assert.equal(parsed.kind, "snapshot");
  const bucket = parsed.snapshot.buckets[0];
  assert.equal(bucket.window, null);
  assert.equal(bucket.resetAt, undefined);
  assert.equal(bucket.remainingPercent, 97);
});

test("usedPercent outside 0-100 is clamped for the display complement only", () => {
  const result = { rateLimits: { primary: { usedPercent: 140, windowDurationMins: 10080 } } };
  const parsed = codexParse(200, noHeaders, JSON.stringify(result), { now: 0 });
  assert.equal(parsed.snapshot.buckets[0].usedPercent, 100);
  assert.equal(parsed.snapshot.buckets[0].remainingPercent, 0);
});

test("a JSON-RPC error envelope maps to needs-auth or business-error without echoing the message", () => {
  const authError = codexParse(200, noHeaders, JSON.stringify({ id: 1, error: { code: -32000, message: "Not logged in: SECRET-MSG-1" } }), { now: 0 });
  assert.equal(authError.issue?.code, "needs-auth");
  assert.ok(!JSON.stringify(authError).includes("SECRET-MSG-1"));
  const other = codexParse(200, noHeaders, JSON.stringify({ id: 1, error: { code: -32601, message: "SECRET-MSG-2" } }), { now: 0 });
  assert.equal(other.issue?.code, "business-error");
  assert.ok(!JSON.stringify(other).includes("SECRET-MSG-2"));
  assert.equal(other.issue?.detail, "app-server request error");
});

test("missing or windowless rate limits are protocol / no-data errors, never zero", () => {
  assert.equal(codexParse(200, noHeaders, JSON.stringify({}), { now: 0 }).issue?.code, "protocol-error");
  assert.equal(codexParse(200, noHeaders, "not json", { now: 0 }).issue?.code, "protocol-error");
  assert.equal(codexParse(200, noHeaders, JSON.stringify({ rateLimits: {} }), { now: 0 }).issue?.code, "no-data");
  const windowless = codexParse(200, noHeaders, JSON.stringify({ rateLimits: { primary: {} } }), { now: 0 });
  assert.equal(windowless.issue?.code, "no-data");
});

// ---------------------------------------------------------------------------
// runCodexRateLimitsQuery (fake child)
// ---------------------------------------------------------------------------

/** Minimal fake child: records writes, lets the test push stdout chunks. */
class FakeChild {
  constructor() {
    this.writes = [];
    this.ended = false;
    this.listeners = { data: [], error: [], close: [] };
    this.signals = [];
    this.stdin = {
      write: (data) => this.writes.push(data),
      end: () => { this.ended = true; },
    };
    this.stdout = { on: (event, listener) => { this.listeners[event].push(listener); } };
  }
  once(event, listener) { this.listeners[event].push(listener); }
  kill(signal) { this.signals.push(signal ?? "SIGTERM"); return true; }
  emitData(chunk) { for (const listener of this.listeners.data) listener(chunk); }
  emitError(error) { for (const listener of this.listeners.error) listener(error); }
  emitClose(code) { for (const listener of this.listeners.close) listener(code); }
  requestLines() { return this.writes.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
}

const makeRunner = () => {
  const children = [];
  const spawnImpl = (command, args, options) => {
    const child = new FakeChild();
    children.push({ child, command, args, options });
    return child;
  };
  return { children, spawnImpl };
};

test("the driver sends exactly initialize/initialized/read, closes stdin, and skips noise", async () => {
  const { children, spawnImpl } = makeRunner();
  const clock = new FakeClock();
  const promise = runCodexRateLimitsQuery({ spawnImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await flush(2);
  const { child, command, args, options } = children[0];
  assert.equal(command, "codex");
  assert.deepEqual(args, ["app-server"]);
  assert.equal(options.stdio, "pipe");
  assert.equal(options.env, process.env); // Inherited environment (egress proxy stays the host's).
  const lines = child.requestLines();
  assert.equal(lines.length, 3);
  assert.equal(lines[0].method, "initialize");
  assert.equal(lines[0].params.clientInfo.name, "pi-hud");
  assert.equal(lines[1].method, "initialized");
  assert.equal(lines[2].method, "account/rateLimits/read");
  assert.notEqual(lines[0].id, lines[2].id); // The initialize response must never match the read id.
  assert.ok(!child.ended); // stdin stays open: EOF would kill the child before it answers.
  // Startup banner, initialize response, unsolicited notification: all skipped.
  child.emitData("codex app-server 0.155.1\n");
  child.emitData(JSON.stringify({ id: lines[0].id, result: { platformOs: "linux" } }) + "\n");
  child.emitData(JSON.stringify({ method: "remoteControl/status/changed", params: { status: "disabled" } }) + "\n");
  child.emitData(JSON.stringify({ id: lines[2].id, result: probeShapeResult }) + "\n");
  const result = await promise;
  assert.equal(result.kind, "response");
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body).rateLimitsByLimitId.codex.planType, "prolite");
  assert.ok(child.signals.includes("SIGKILL")); // The child never outlives the query.
});

test("the driver surfaces a JSON-RPC error envelope as the response body", async () => {
  const { children, spawnImpl } = makeRunner();
  const clock = new FakeClock();
  const promise = runCodexRateLimitsQuery({ spawnImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await flush(2);
  const child = children[0].child;
  const readId = child.requestLines()[2].id;
  child.emitData(JSON.stringify({ id: readId, error: { code: -32000, message: "Not logged in" } }) + "\n");
  const result = await promise;
  assert.equal(result.kind, "response");
  assert.equal(JSON.parse(result.body).error.message, "Not logged in");
});

test("spawn ENOENT, spawn throw and early exit classify distinctly", async () => {
  const clock = new FakeClock();
  const enotFound = runCodexRateLimitsQuery({ spawnImpl: () => { const c = new FakeChild(); queueMicrotask(() => c.emitError(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }))); return c; }, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.deepEqual(await enotFound, { kind: "network", reason: "spawn-not-found" });
  const threw = runCodexRateLimitsQuery({ spawnImpl: () => { throw new Error("nope"); }, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.deepEqual(await threw, { kind: "network", reason: "spawn-error" });
  const { children, spawnImpl } = makeRunner();
  const early = runCodexRateLimitsQuery({ spawnImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await flush(2);
  children[0].child.emitClose(1);
  assert.deepEqual(await early, { kind: "network", reason: "process-exit" });
});

test("the total deadline escalates SIGTERM -> SIGKILL and reports timeout", async () => {
  const { children, spawnImpl } = makeRunner();
  const clock = new FakeClock();
  const promise = runCodexRateLimitsQuery({ timeoutMs: 3_000, spawnImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await flush(2);
  assert.equal(clock.jobs.size, 1); // Only the deadline timer until it fires.
  clock.advance(CODEX_MIN_TOTAL_MS); // The floor applies even to a 3 s request.
  await flush(2);
  assert.ok(children[0].child.signals.includes("SIGTERM"));
  assert.equal(clock.jobs.size, 1); // The kill-grace timer.
  clock.advance(2_000);
  const result = await promise;
  assert.deepEqual(result, { kind: "timeout" });
  assert.ok(children[0].child.signals.includes("SIGKILL"));
});

test("an overlong frame and total overflow are refused as oversized", async () => {
  const clock = new FakeClock();
  const { children, spawnImpl } = makeRunner();
  const frame = runCodexRateLimitsQuery({ spawnImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await flush(2);
  children[0].child.emitData("x".repeat(CODEX_MAX_FRAME_BYTES + 1) + "\n");
  assert.deepEqual(await frame, { kind: "oversized" });
});

test("the effective deadline never drops below the codex floor", async () => {
  const clock = new FakeClock();
  const { spawnImpl } = makeRunner();
  const promise = runCodexRateLimitsQuery({ timeoutMs: 1, spawnImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await flush(2);
  const job = [...clock.jobs.values()][0];
  assert.equal(job.at, CODEX_MIN_TOTAL_MS);
  clock.advance(CODEX_MIN_TOTAL_MS - 1);
  await flush(2);
  assert.equal(clock.jobs.size, 1); // Not fired yet.
  clock.advance(1); // Deadline fires; the kill-grace timer is scheduled.
  await flush(2);
  clock.advance(2_000); // Grace elapses.
  assert.deepEqual(await promise, { kind: "timeout" });
});

// ---------------------------------------------------------------------------
// Service integration (injected process runner)
// ---------------------------------------------------------------------------

test("codex end-to-end through the service: no host auth, HUD view and rendering", async () => {
  const clock = new FakeClock();
  const specs = [];
  const service = new QuotaService({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    resolveAuth: async () => { throw new Error("must not resolve host auth for codex"); },
    runProcess: async (spec, options) => {
      specs.push({ spec, options });
      return { kind: "response", status: 200, headers: noHeaders, body: JSON.stringify(probeShapeResult) };
    },
  });
  service.configure(normalizeQuota({ enabled: true, profiles: [codexProfile] }));
  service.onModel({ provider: "openai-codex", id: "gpt-6-astra" });
  await flush(2);
  clock.advance(0); // Fire the merged debounce.
  await flush(8);
  assert.equal(service.counters.authResolutions, 0); // The subprocess owns its login.
  assert.equal(service.counters.requests, 1);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].spec.command, "codex");
  assert.equal(specs[0].options.timeoutMs, 5_000); // Config timeout passes through (the runner floors it).
  const view = service.view();
  assert.equal(view.status, "ready");
  assert.equal(view.planKey, "codex");
  assert.equal(view.profileId, "codex-main");
  assert.equal(view.buckets.length, 1);
  assert.equal(view.buckets[0].remainingPercent, 21);
  const field = quotaField(view, normalize({ language: "en" }), LABELS.en);
  const text = JSON.stringify(field);
  assert.ok(text.includes("Codex"));
  assert.ok(text.includes("21%"));
  service.dispose();
});

test("spawn-not-found renders as a clear network issue on the HUD", async () => {
  const clock = new FakeClock();
  const service = new QuotaService({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    runProcess: async () => ({ kind: "network", reason: "spawn-not-found" }),
  });
  service.configure(normalizeQuota({ enabled: true, profiles: [codexProfile] }));
  service.onModel({ provider: "openai-codex", id: "gpt-6-astra" });
  await flush(2);
  clock.advance(0);
  await flush(8);
  const view = service.view();
  assert.equal(view.status, "issue");
  assert.equal(view.issue.code, "network-error");
  assert.equal(view.issue.detail, "codex executable not found on PATH");
  service.dispose();
});
