/**
 * Quota feature tests: config validation, adapter mapping, transport hardening,
 * scheduling/cache/lifecycle invariants and HUD rendering. All network, clock and
 * auth surfaces are injected; no test touches a real account. Synthetic samples
 * follow docs/GLM-PLAN-SCOPES.zh-CN.md §9 (including the 876/877 trap) and carry
 * no account information.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, normalizeQuota } from "../src/config.ts";
import { zaiParse, zaiPrepare, parseRetryAfter, ZAI_QUOTA_ORIGIN } from "../src/quota/adapters/zai.ts";
import { deepseekParse, deepseekPrepare, DEEPSEEK_QUOTA_ORIGIN } from "../src/quota/adapters/deepseek.ts";
import { siliconflowParse, siliconflowPrepare, SILICONFLOW_QUOTA_ORIGIN } from "../src/quota/adapters/siliconflow.ts";
import { decimalText, currencyCode, bearerAuthorization } from "../src/quota/adapters/http.ts";
import { quotaFetch, globalQuotaFetch, boundedBody } from "../src/quota/transport.ts";
import { matchProfiles, reconcileScope, credentialTag, originOfBaseUrl } from "../src/quota/identity.ts";
import { QuotaService, QUOTA_LIMITS } from "../src/quota/service.ts";
import { quotaField, quotaPlanLabel, LABELS } from "../src/render.ts";
import { formatFooter } from "../src/footer.ts";
import { formatHud } from "../src/render.ts";
import { normalizeConfig as normalize } from "../src/config.ts";
import { controllerFixture, FakeClock, MODEL } from "./helpers.mjs";

// ---------------------------------------------------------------------------
// Fixtures (synthetic, §9 shapes)
// ---------------------------------------------------------------------------

const noHeaders = { get: () => null };

/** Personal-legacy sample: TOKENS_LIMIT hour/week (percentages only) plus a tools pool. */
const personalBody = JSON.stringify({
  code: 200, success: true,
  data: {
    level: "Pro 合成",
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 28, nextResetTime: 1893456000000 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 59, nextResetTime: 1893542400000 },
      { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 12, remaining: 88, percentage: 12, nextResetTime: 1893542400000 },
    ],
  },
});

/** Team sample: exactly the §9 fixture — 876 remaining must never become 877. */
const teamBody = JSON.stringify({
  code: 200, success: true,
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 1000, currentValue: 123, remaining: 876, percentage: 13, nextResetTime: 1893456000000 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 500, currentValue: 180, remaining: 320, percentage: 36, nextResetTime: 1893542400000 },
    ],
  },
});

const jsonResponse = (body, status = 200, headers = noHeaders) => ({
  status, ok: status >= 200 && status < 300, headers, text: async () => body,
});

/** Fake fetch with per-call scripted responses and captured requests. */
class FakeFetch {
  constructor() {
    this.calls = [];
    this.queue = [];
    this.defaultResponse = () => jsonResponse("{}", 500);
  }
  get fetch() {
    return async (url, init) => {
      this.calls.push({ url, init, authorization: init.headers.Authorization ?? null });
      const next = this.queue.length > 0 ? this.queue.shift() : null;
      const handler = next ?? this.defaultResponse;
      const result = typeof handler === "function" ? await handler(url, init, this.calls.length - 1) : handler;
      if (result === null) {
        // Hang until the transport's abort signal fires.
        return new Promise((_, reject) => {
          const abort = () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); };
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return result;
    };
  }
  get requestCount() { return this.calls.length; }
}

const flush = async (times = 8) => { for (let index = 0; index < times; index++) await new Promise((resolve) => setImmediate(resolve)); };

const personalProfile = {
  id: "glm-personal", providerId: "zai-coding-cn", adapter: "zai", source: "pi",
  region: "cn", plan: "personal", queryMode: "personal-legacy",
};
const teamProfile = {
  id: "glm-team", providerId: "zai-coding-cn-team", adapter: "zai", source: "pi",
  region: "cn", plan: "team", queryMode: "team", organizationId: "org-synth", projectId: "proj-synth",
};

const quotaConfig = (overrides = {}, profiles = [personalProfile]) => normalizeQuota({
  enabled: true, ttlMs: 300_000, timeoutMs: 5_000, profiles, ...overrides,
});

/** A fixture with quota enabled; `model` selects the current provider/model.
 *  `fetchLike` is either a bare fake fetch or a FakeFetch instance. */
function quotaFixture({ config, auth = { ok: true, apiKey: "key-synth" }, fetchLike, model } = {}) {
  const clock = new FakeClock();
  const fakeFetch = fetchLike ?? new FakeFetch();
  const fetchFunction = typeof fakeFetch === "function" ? fakeFetch : fakeFetch.fetch;
  const registry = { getApiKeyAndHeaders: async () => auth };
  const host = controllerFixture({
    modelRegistry: registry,
    quotaFetch: fetchFunction,
    config: { quota: config ?? quotaConfig() },
    now: clock.now, monotonic: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  host.emit("model_select", { model: model ?? { provider: "zai-coding-cn", id: "glm-4.7", name: "GLM 4.7" } });
  const requestCount = () => (typeof fakeFetch === "object" ? fakeFetch.requestCount : fakeFetch.calls.length);
  return { ...host, clock, controller: host.controller, fakeFetch, requestCount, emit: host.emit };
}

/** Drive: timer tick -> check -> auth -> fetch -> publish, then flush microtasks. */
async function settle(fixture, ms = 0) {
  await flush(2);
  fixture.clock.advance(ms);
  await flush(6);
}

// ---------------------------------------------------------------------------
// §9 mapping tests (pure adapter functions)
// ---------------------------------------------------------------------------

test("zaiParse maps the §9 personal sample: percentages, windows, tools pool", () => {
  const result = zaiParse(200, noHeaders, personalBody, { now: 0 });
  assert.equal(result.kind, "snapshot");
  const snapshot = result.snapshot;
  assert.equal(snapshot.buckets.length, 3);
  const [hour, week, tools] = snapshot.buckets;
  // TOKENS_LIMIT is a percentage pool: no token total is invented from the name.
  assert.equal(hour.kind, "quota-percent");
  assert.equal(hour.window.unit, "hour");
  assert.equal(hour.window.number, 5);
  assert.equal(hour.usedPercent, 28);
  assert.equal(hour.remainingPercent, 72);
  assert.equal(hour.limit, undefined);
  assert.equal(hour.used, undefined);
  assert.equal(hour.remaining, undefined);
  assert.equal(hour.resetAt, 1893456000000);
  assert.equal(week.window.unit, "week");
  assert.equal(week.remainingPercent, 41);
  assert.equal(tools.kind, "tools");
  assert.equal(tools.window.unit, "month");
  assert.equal(tools.limit, 100);
  assert.equal(tools.used, 12);
  assert.equal(tools.remaining, 88);
  assert.equal(snapshot.planLabel, "Pro 合成");
  assert.equal(snapshot.partial, false);
});

test("zaiParse keeps the team fixture's server remaining 876 — never corrected to 877", () => {
  const result = zaiParse(200, noHeaders, teamBody, { now: 0 });
  assert.equal(result.kind, "snapshot");
  const [hour] = result.snapshot.buckets;
  assert.equal(hour.kind, "credits");
  assert.equal(hour.limit, 1000);
  assert.equal(hour.used, 123);
  // The arithmetic complement would be 877; the server value wins.
  assert.equal(hour.remaining, 876);
  // 13% used -> 87% remaining is the display complement, not 87.7 credits.
  assert.equal(hour.usedPercent, 13);
  assert.equal(hour.remainingPercent, 87);
});

test("zaiParse rejects business failures, empty data and invalid payloads", () => {
  assert.deepEqual(zaiParse(200, noHeaders, JSON.stringify({ code: 400, success: false }), { now: 0 }).issue?.code, "business-error");
  assert.deepEqual(zaiParse(200, noHeaders, JSON.stringify({ code: 200, success: true, data: {} }), { now: 0 }).issue?.code, "no-data");
  assert.deepEqual(zaiParse(200, noHeaders, JSON.stringify({ code: 200, success: true, data: { limits: [] } }), { now: 0 }).issue?.code, "no-data");
  assert.deepEqual(zaiParse(200, noHeaders, "<html>not json</html>", { now: 0 }).issue?.code, "protocol-error");
  const allUnknown = zaiParse(200, noHeaders, JSON.stringify({ code: 200, success: true, data: { limits: [{ type: "SOMETHING_ELSE", unit: 3, number: 5 }] } }), { now: 0 });
  assert.deepEqual(allUnknown.issue?.code, "protocol-error");
});

test("zaiParse maps partial data: unknown types ignored and counted, unknown windows kept", () => {
  const body = JSON.stringify({
    code: 200, success: true,
    data: { limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 50 },
      { type: "MYSTERY", unit: 3, number: 5, percentage: 1 },
      { type: "TOKENS_LIMIT", unit: 9, number: 7, percentage: 40 },   // unknown unit combination
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 200 },  // out of range -> unknown field only
    ] },
  });
  const result = zaiParse(200, noHeaders, body, { now: 0 });
  assert.equal(result.kind, "snapshot");
  const snapshot = result.snapshot;
  assert.equal(snapshot.buckets.length, 3);
  assert.equal(snapshot.ignoredBuckets, 1);
  assert.equal(snapshot.partial, true);
  const unknownWindow = snapshot.buckets.find((bucket) => bucket.id.includes(":9:"));
  assert.ok(unknownWindow);
  assert.equal(unknownWindow.window, null);
  const outOfRange = snapshot.buckets[2];
  assert.equal(outOfRange.usedPercent, undefined);
  assert.equal(outOfRange.remainingPercent, undefined);
});

test("zaiParse: percentage 0 and remaining 0 are legal values, not missing", () => {
  const body = JSON.stringify({ code: 200, success: true, data: { limits: [
    { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 100, currentValue: 100, remaining: 0, percentage: 0 },
  ] } });
  const result = zaiParse(200, noHeaders, body, { now: 0 });
  assert.equal(result.kind, "snapshot");
  const [bucket] = result.snapshot.buckets;
  assert.equal(bucket.usedPercent, 0);
  assert.equal(bucket.remainingPercent, 100);
  assert.equal(bucket.remaining, 0);
});

test("zaiParse: duplicate same-shape buckets are kept apart, never summed", () => {
  const body = JSON.stringify({ code: 200, success: true, data: { limits: [
    { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 100, currentValue: 10, remaining: 90, percentage: 10 },
    { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 100, currentValue: 20, remaining: 80, percentage: 20 },
  ] } });
  const result = zaiParse(200, noHeaders, body, { now: 0 });
  assert.equal(result.kind, "snapshot");
  const [first, second] = result.snapshot.buckets;
  assert.equal(second.duplicate, true);
  assert.equal(second.id.endsWith("#2"), true);
  assert.notEqual(first.remaining, second.remaining);
});

test("zaiParse: an invalid reset time marks only that field unknown", () => {
  const body = JSON.stringify({ code: 200, success: true, data: { limits: [
    { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10, nextResetTime: 1234567890 },
  ] } });
  const result = zaiParse(200, noHeaders, body, { now: 0 });
  assert.equal(result.kind, "snapshot");
  assert.equal(result.snapshot.buckets[0].resetAt, undefined);
});

test("zaiParse maps HTTP status codes per §10 and parses Retry-After", () => {
  assert.deepEqual(zaiParse(401, noHeaders, "", { now: 0 }).issue?.code, "needs-auth");
  assert.deepEqual(zaiParse(403, noHeaders, "", { now: 0 }).issue?.code, "forbidden");
  const rateLimited = zaiParse(429, { get: (name) => name === "retry-after" ? "120" : null }, "", { now: 1_000 });
  assert.deepEqual(rateLimited.issue?.code, "rate-limited");
  assert.deepEqual(rateLimited.issue?.retryAt, 121_000);
  assert.deepEqual(zaiParse(503, noHeaders, "", { now: 0 }).issue?.code, "http-error");
  assert.equal(parseRetryAfter("30", 0), 30_000);
  assert.equal(parseRetryAfter(null, 0), null);
  assert.equal(parseRetryAfter("garbage", 0), null);
});

test("zaiPrepare builds the two verified request shapes and refuses unverified modes", () => {
  const personal = zaiPrepare({ profile: personalProfile, auth: { apiKey: "raw-key" }, scope: { organizationId: null, projectId: null, conflict: false } });
  assert.equal(personal.kind, "request");
  assert.equal(personal.url, `${ZAI_QUOTA_ORIGIN}/api/monitor/usage/quota/limit`);
  assert.deepEqual(personal.headers, { Accept: "application/json", Authorization: "raw-key" });
  assert.ok(!("bigmodel-organization" in personal.headers));

  const team = zaiPrepare({ profile: teamProfile, auth: { apiKey: "raw-key" }, scope: { organizationId: "org-synth", projectId: "proj-synth", conflict: false } });
  assert.equal(team.kind, "request");
  assert.equal(team.url, `${ZAI_QUOTA_ORIGIN}/api/monitor/usage/quota/limit?type=2`);
  assert.equal(team.headers["bigmodel-organization"], "org-synth");
  assert.equal(team.headers["bigmodel-project"], "proj-synth");

  // Unverified candidates never send requests.
  assert.deepEqual(zaiPrepare({ profile: { ...personalProfile, region: "global" }, auth: { apiKey: "k" }, scope: { organizationId: null, projectId: null, conflict: false } }).issue?.code, "needs-verification");
  // The dropped type=1 candidate is rejected at config load (keep-previous-on-reject), never reaching the adapter.
  assert.throws(() => normalizeQuota({ profiles: [{ ...personalProfile, queryMode: "personal" }] }), /invalid plan\/queryMode combination personal\/personal/);
  // Missing key and missing scope refuse before any network.
  assert.deepEqual(zaiPrepare({ profile: personalProfile, auth: null, scope: { organizationId: null, projectId: null, conflict: false } }).issue?.code, "needs-auth");
  assert.deepEqual(zaiPrepare({ profile: teamProfile, auth: { apiKey: "k" }, scope: { organizationId: "org-synth", projectId: null, conflict: false } }).issue?.code, "needs-scope");
  assert.deepEqual(zaiPrepare({ profile: teamProfile, auth: { apiKey: "k" }, scope: { organizationId: null, projectId: null, conflict: true } }).issue?.code, "scope-conflict");
});

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

test("profile matching is exact by provider id and honors modelIds", () => {
  const profiles = [
    { ...personalProfile },
    { ...teamProfile },
    { ...personalProfile, id: "narrow", providerId: "zai-coding-cn", modelIds: ["glm-4.7"], enabled: false },
  ];
  const none = matchProfiles(profiles, { provider: "other", id: "x" });
  assert.equal(none.matches.length, 0);
  const personal = matchProfiles(profiles, { provider: "zai-coding-cn", id: "glm-4.7" });
  assert.equal(personal.matches.length, 1);
  assert.equal(personal.matches[0].id, "glm-personal");
  const narrow = matchProfiles([profiles[2]], { provider: "zai-coding-cn", id: "glm-4.7" });
  assert.equal(narrow.matches.length, 0); // disabled profiles never match
  const enabledNarrow = matchProfiles([{ ...profiles[2], enabled: true }], { provider: "zai-coding-cn", id: "glm-4.7" });
  assert.equal(enabledNarrow.matches.length, 1);
  assert.equal(matchProfiles([{ ...profiles[2], enabled: true }], { provider: "zai-coding-cn", id: "other-model" }).matches.length, 0);
});

test("scope reconciliation: host headers complete, conflict on mismatch or duplicate casing", () => {
  const auth = { apiKey: "k", headers: { "Bigmodel-Organization": "org-host", "bigmodel-project": "proj-host" } };
  const withoutExplicit = { ...teamProfile, organizationId: undefined, projectId: undefined };
  const fromHost = reconcileScope(withoutExplicit, auth, "team");
  assert.deepEqual(fromHost, { organizationId: "org-host", projectId: "proj-host", conflict: false });
  const conflict = reconcileScope(teamProfile, { apiKey: "k", headers: { "bigmodel-organization": "org-other" } }, "team");
  assert.equal(conflict.conflict, true);
  const duplicated = reconcileScope(withoutExplicit, { apiKey: "k", headers: { "Bigmodel-Organization": "a", "bigmodel-organization": "b" } }, "team");
  assert.equal(duplicated.conflict, true);
  // personal-legacy ignores host scope headers entirely.
  const personal = reconcileScope(personalProfile, auth, "personal-legacy");
  assert.deepEqual(personal, { organizationId: null, projectId: null, conflict: false });
});

test("credential fingerprints and origin extraction stay bounded and stable", () => {
  assert.equal(credentialTag("a", "o", "p"), credentialTag("a", "o", "p"));
  assert.notEqual(credentialTag("a", "o", "p"), credentialTag("b", "o", "p"));
  assert.equal(originOfBaseUrl("https://open.bigmodel.cn/api/coding/paas/v4"), "https://open.bigmodel.cn");
  assert.equal(originOfBaseUrl("HTTPS://Open.BigModel.cn/api"), "https://open.bigmodel.cn");
  assert.equal(originOfBaseUrl("http://open.bigmodel.cn"), null);
  assert.equal(originOfBaseUrl(null), null);
});

// ---------------------------------------------------------------------------
// Transport hardening (injected fakes)
// ---------------------------------------------------------------------------

test("transport: timeout aborts and classifies without message leakage", async () => {
  const timers = [];
  const fakeSet = (callback, delay) => { timers.push({ callback, delay }); return { unref() {} }; };
  const fakeClear = () => {};
  // A fetch that hangs until the transport's abort signal fires.
  const hangsUntilAbort = (url, init) => new Promise((_, reject) => {
    const abort = () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); };
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
  });
  const promise = quotaFetch(hangsUntilAbort, "https://open.bigmodel.cn/x", {}, { timeoutMs: 5_000, setTimer: fakeSet, clearTimer: fakeClear });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 5_000);
  timers[0].callback();
  const result = await promise;
  assert.deepEqual(result, { kind: "timeout" });
});

test("transport: redirects are refused regardless of host, network errors classified by name", async () => {
  const redirect = { status: 302, ok: false, headers: noHeaders, text: async () => "" };
  assert.deepEqual(await quotaFetch(async () => redirect, "https://open.bigmodel.cn/x", {}), { kind: "redirect", status: 302 });
  const failure = new Error("getaddrinfo ENOTFOUND secret.internal"); failure.name = "TypeError";
  const network = await quotaFetch(async () => { throw failure; }, "https://open.bigmodel.cn/x", {});
  assert.deepEqual(network.kind, "network");
  assert.equal(network.reason, "TypeError");
  assert.ok(!JSON.stringify(network).includes("secret.internal"), "error messages must not leak into diagnostics");
});

test("transport: response bodies above the byte cap are refused", async () => {
  const big = "x".repeat(256 * 1024 + 1);
  const oversized = await quotaFetch(async () => jsonResponse(big), "https://open.bigmodel.cn/x", {});
  assert.deepEqual(oversized, { kind: "oversized" });
  const exact = await quotaFetch(async () => jsonResponse("x".repeat(256 * 1024)), "https://open.bigmodel.cn/x", {});
  assert.equal(exact.kind, "response");
  // Multi-byte content counts bytes, not characters.
  const wide = await quotaFetch(async () => jsonResponse("中".repeat(256 * 1024 / 3 + 1)), "https://open.bigmodel.cn/x", {});
  assert.deepEqual(wide, { kind: "oversized" });
});

test("transport: requests carry the fixed safety flags", async () => {
  const fake = new FakeFetch();
  fake.queue.push(jsonResponse(personalBody));
  const result = await quotaFetch(fake.fetch, "https://open.bigmodel.cn/api/monitor/usage/quota/limit", { Authorization: "k" }, { timeoutMs: 1_000 });
  assert.equal(result.kind, "response");
  const call = fake.calls[0];
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.credentials, "omit");
  assert.ok(call.init.signal instanceof AbortSignal);
});

test("transport: streaming bodies are capped incrementally", async () => {
  const chunk = new TextEncoder().encode("x".repeat(1024));
  const streamResponse = {
    status: 200, ok: true, headers: noHeaders, text: async () => { throw new Error("should stream"); },
    body: { getReader: () => {
      let sent = 0;
      return { read: async () => (sent++ < 300 ? { done: false, value: chunk } : { done: true }) };
    } },
  };
  const result = await quotaFetch(async () => streamResponse, "https://open.bigmodel.cn/x", {}, { maxBodyBytes: 64 * 1024 });
  assert.deepEqual(result, { kind: "oversized" });
  assert.ok(await boundedBody(jsonResponse("ok"), 1_000) === "ok");
});

test("the global fetch boundary export exists and is the production default", async () => {
  assert.equal(typeof globalQuotaFetch, "function");
  assert.equal(globalQuotaFetch.name, "globalQuotaFetch");
});

// ---------------------------------------------------------------------------
// Service: scheduling, cache, lifecycle
// ---------------------------------------------------------------------------

test("default-off quota creates no service, timers or requests", async () => {
  const fixture = quotaFixture({ config: quotaConfig({ enabled: false }) });
  await settle(fixture);
  assert.equal(fixture.controller.quota, null);
  assert.equal(fixture.requestCount(), 0);
  assert.equal(fixture.clock.jobs.size, 0);
  const snapshot = fixture.controller.state.snapshot();
  assert.equal(snapshot.quota, null);
});

test("personal-legacy end-to-end: request shape, HUD view, cache and TTL", async () => {
  const fixture = quotaFixture({});
  fixture.fakeFetch.queue.push(jsonResponse(personalBody));
  await settle(fixture);
  assert.equal(fixture.requestCount(), 1);
  const call = fixture.fakeFetch.calls[0];
  assert.equal(call.url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  assert.ok(!call.url.includes("type="));
  assert.equal(call.authorization, "key-synth");
  const view = fixture.controller.quota.view();
  assert.equal(view.status, "ready");
  assert.equal(view.planKey, "zai:personal");
  assert.deepEqual(view.buckets.map((bucket) => [bucket.unit, bucket.remainingPercent]), [["hour", 72], ["week", 41]]);
  // Within TTL, further events reuse the cache without network.
  fixture.emit("agent_settled");
  await settle(fixture);
  assert.equal(fixture.requestCount(), 1);
  // After TTL expiry, no idle network happens until the next event.
  fixture.clock.advance(300_001);
  await flush(4);
  assert.equal(fixture.requestCount(), 1);
  assert.equal(fixture.controller.quota.view().status, "stale");
  fixture.fakeFetch.queue.push(jsonResponse(personalBody));
  fixture.emit("agent_settled");
  await settle(fixture);
  assert.equal(fixture.requestCount(), 2);
});

test("team end-to-end: type=2, scope headers, credits view; values never zeroed on failure", async () => {
  const fixture = quotaFixture({
    config: quotaConfig({}, [teamProfile]),
    model: { provider: "zai-coding-cn-team", id: "glm-4.7", name: "GLM team" },
  });
  fixture.fakeFetch.queue.push(jsonResponse(teamBody));
  await settle(fixture);
  const call = fixture.fakeFetch.calls[0];
  assert.equal(call.url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2");
  assert.equal(call.init.headers["bigmodel-organization"], "org-synth");
  assert.equal(call.init.headers["bigmodel-project"], "proj-synth");
  const view = fixture.controller.quota.view();
  assert.equal(view.planKey, "zai:team");
  assert.equal(view.buckets[0].remainingPercent, 87);
  // A later 401 hides the old values as current but keeps the snapshot in diagnostics.
  fixture.clock.advance(300_001);
  fixture.fakeFetch.queue.push(jsonResponse("", 401));
  fixture.emit("agent_settled");
  await settle(fixture);
  const after = fixture.controller.quota.view();
  assert.equal(after.status, "issue");
  assert.equal(after.issue.code, "needs-auth");
  assert.deepEqual(after.buckets, []);
  const inspect = fixture.controller.quota.inspect();
  const cached = inspect.profileList[0].cache.lastSuccess;
  assert.ok(cached, "lastSuccess survives an auth failure");
  assert.equal(cached.buckets[0].remaining, 876);
  assert.equal(cached.stale, true);
});

test("team failure never falls back to a personal query", async () => {
  const fixture = quotaFixture({
    config: quotaConfig({}, [teamProfile]),
    model: { provider: "zai-coding-cn-team", id: "glm-4.7", name: "GLM team" },
  });
  fixture.fakeFetch.queue.push(jsonResponse("", 500));
  await settle(fixture);
  assert.equal(fixture.requestCount(), 1);
  assert.equal(fixture.controller.quota.view().issue.code, "http-error");
  // The second attempt also only ever targets the team query.
  fixture.clock.advance(60_001);
  fixture.fakeFetch.queue.push(jsonResponse("", 500));
  fixture.emit("agent_settled");
  await settle(fixture);
  assert.equal(fixture.requestCount(), 2);
  assert.ok(fixture.fakeFetch.calls.every((call) => call.url.includes("type=2")));
});

test("ambiguous profiles are reported, not resolved by list order", async () => {
  const duplicate = { ...personalProfile, id: "glm-personal-2" };
  const fixture = quotaFixture({ config: quotaConfig({}, [personalProfile, duplicate]) });
  await settle(fixture);
  assert.equal(fixture.requestCount(), 0);
  assert.equal(fixture.controller.quota.counters.authResolutions, 0);
  const view = fixture.controller.quota.view();
  assert.equal(view.status, "ambiguous-profile");
  assert.equal(view.issue.code, "ambiguous-profile");
});

test("enabled quota without a matching profile shows the unconfigured state", async () => {
  const fixture = quotaFixture({
    config: quotaConfig({}, [teamProfile]),
    model: { provider: "other-provider", id: "m1", name: "Other" },
  });
  await settle(fixture);
  assert.equal(fixture.requestCount(), 0);
  assert.equal(fixture.controller.quota.view().status, "unconfigured");
});

test("unimplemented adapters report unsupported-adapter without any request", async () => {
  const profile = { id: "mm", providerId: "minimax-cn", adapter: "minimax", source: "pi", region: "cn" };
  const fixture = quotaFixture({
    config: quotaConfig({}, [profile]),
    model: { provider: "minimax-cn", id: "abab", name: "MiniMax" },
  });
  await settle(fixture);
  assert.equal(fixture.requestCount(), 0);
  const view = fixture.controller.quota.view();
  assert.equal(view.status, "issue");
  assert.equal(view.issue.code, "unsupported-adapter");
});

test("missing credentials produce needs-auth; no request is sent", async () => {
  const fixture = quotaFixture({ auth: { ok: false, error: "unconfigured" } });
  await settle(fixture);
  assert.equal(fixture.requestCount(), 0);
  assert.equal(fixture.controller.quota.view().issue.code, "needs-auth");
});

test("team scope from host headers is used; conflict stops the query", async () => {
  const teamHostScope = {
    ok: true, apiKey: "team-key",
    headers: { "bigmodel-organization": "org-host", "bigmodel-project": "proj-host" },
  };
  const fixtureNoProfileScope = quotaFixture({
    config: quotaConfig({}, [{ ...teamProfile, organizationId: undefined, projectId: undefined }]),
    auth: teamHostScope,
    model: { provider: "zai-coding-cn-team", id: "glm-4.7", name: "GLM team" },
  });
  fixtureNoProfileScope.fakeFetch.queue.push(jsonResponse(teamBody));
  await settle(fixtureNoProfileScope);
  assert.equal(fixtureNoProfileScope.fakeFetch.calls[0].init.headers["bigmodel-organization"], "org-host");

  const fixtureConflict = quotaFixture({
    config: quotaConfig({}, [teamProfile]), // org-synth vs host's org-host
    auth: teamHostScope,
    model: { provider: "zai-coding-cn-team", id: "glm-4.7", name: "GLM team" },
  });
  await settle(fixtureConflict);
  assert.equal(fixtureConflict.fakeFetch.requestCount, 0);
  assert.equal(fixtureConflict.controller.quota.view().issue.code, "scope-conflict");
});

test("same key with a different scope uses a separate cache identity", async () => {
  const auth = { ok: true, apiKey: "same-key" };
  const teamA = { ...teamProfile, organizationId: "org-a", projectId: "p-a" };
  const teamB = { ...teamProfile, id: "glm-team-b", providerId: "zai-coding-cn-team-b", organizationId: "org-b", projectId: "p-b" };
  const fixture = quotaFixture({
    config: quotaConfig({}, [teamA, teamB]),
    auth,
    model: { provider: "zai-coding-cn-team", id: "glm-4.7", name: "GLM team A" },
  });
  fixture.fakeFetch.queue.push(jsonResponse(teamBody));
  await settle(fixture);
  assert.equal(fixture.controller.quota.entries.size, 1);
  fixture.emit("model_select", { model: { provider: "zai-coding-cn-team-b", id: "glm-4.7", name: "GLM team B" } });
  fixture.fakeFetch.queue.push(jsonResponse(teamBody));
  await settle(fixture);
  // Same key, different organization/project: two identities, two snapshots.
  assert.equal(fixture.controller.quota.entries.size, 2);
  assert.equal(fixture.controller.quota.view().profileId, "glm-team-b");
});

test("identity switch discards late results; the current identity stays authoritative", async () => {
  let releasePersonal;
  const gate = new Promise((resolve) => { releasePersonal = resolve; });
  const fetchLike = async (url) => {
    if (!url.includes("type=2")) await gate; // personal query hangs until released
    return jsonResponse(teamBody);
  };
  const fixture = quotaFixture({ fetchLike, config: quotaConfig({}, [personalProfile, teamProfile]) });
  await flush(4);
  fixture.clock.advance(0); // start the personal query (pending)
  await flush(2);
  assert.equal(fixture.controller.quota.inflight, 1);
  // Switch to the team provider while the personal query is in flight.
  fixture.emit("model_select", { model: { provider: "zai-coding-cn-team", id: "glm-4.7", name: "GLM team" } });
  await settle(fixture);
  assert.equal(fixture.controller.quota.view().planKey, "zai:team");
  const before = fixture.controller.quota.view();
  releasePersonal();
  await flush(8);
  const after = fixture.controller.quota.view();
  assert.equal(after.planKey, "zai:team");
  assert.equal(after.updatedAt, before.updatedAt, "late personal result did not publish");
  assert.ok(fixture.controller.quota.counters.discarded >= 1);
});

test("429 applies capped Retry-After backoff that manual refresh cannot bypass", async () => {
  const fixture = quotaFixture({});
  fixture.fakeFetch.queue.push(jsonResponse("", 429, { get: (name) => name === "retry-after" ? "120" : null }));
  await settle(fixture);
  const service = fixture.controller.quota;
  const entry = service.entries.get(service.currentKey);
  assert.equal(entry.issue.retryAt, 120_000);
  const blocked = service.refreshManual();
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /Retry-After/);
  // Events during the backoff window neither fetch nor clear the issue.
  fixture.emit("agent_settled");
  await settle(fixture);
  assert.equal(fixture.requestCount(), 1);
  // After the window the next event retries.
  fixture.clock.advance(120_001);
  fixture.fakeFetch.queue.push(jsonResponse(personalBody));
  fixture.emit("agent_settled");
  await settle(fixture);
  assert.equal(fixture.requestCount(), 2);
  assert.equal(service.view().status, "ready");
});

test("manual refresh enforces the 30s cooldown per identity", async () => {
  const fixture = quotaFixture({});
  fixture.fakeFetch.queue.push(jsonResponse(personalBody));
  await settle(fixture);
  const service = fixture.controller.quota;
  fixture.clock.advance(1_000); // cooldown anchor at t=1000
  fixture.fakeFetch.queue.push(jsonResponse(personalBody));
  assert.equal(service.refreshManual().ok, true);
  await settle(fixture);
  assert.equal(fixture.requestCount(), 2);
  const second = service.refreshManual();
  assert.equal(second.ok, false);
  assert.match(second.message, /cooldown/);
  fixture.clock.advance(30_001);
  fixture.fakeFetch.queue.push(jsonResponse(personalBody));
  assert.equal(service.refreshManual().ok, true);
  await settle(fixture);
  assert.equal(fixture.requestCount(), 3);
});

test("timeout and network errors take capped exponential backoff, not tight retries", async () => {
  const fetchLike = async () => jsonResponse("nope", 504);
  const clock = new FakeClock();
  const service = new QuotaService({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, fetch: fetchLike, resolveAuth: async () => ({ apiKey: "k" }) });
  service.configure(quotaConfig());
  service.onModel({ provider: "zai-coding-cn", id: "glm" });
  await settle({ clock });
  let entry = service.entries.get(service.currentKey);
  assert.equal(entry.issue.retryAt, 30_000);
  for (let round = 2; round <= 10; round++) {
    clock.time = entry.issue.retryAt + 1;
    service.notify("settled");
    await settle({ clock });
    entry = service.entries.get(service.currentKey);
    const expected = Math.min(QUOTA_LIMITS.backoffCapMs, QUOTA_LIMITS.backoffBaseMs * 2 ** (Math.min(round, 5) - 1));
    assert.equal(entry.issue.retryAt - clock.time, expected, `round ${round}`);
  }
  service.dispose();
});

test("concurrency: at most 2 in flight; a third identity queues and runs when a slot frees", async () => {
  const gates = new Map();
  const fetchLike = async (url, init) => {
    const key = init.headers.Authorization;
    if (!gates.has(key)) gates.set(key, Promise.withResolvers());
    await gates.get(key).promise;
    return jsonResponse(personalBody);
  };
  const profiles = [0, 1, 2].map((index) => ({ ...personalProfile, id: `p${index}`, providerId: `prov-${index}` }));
  const clock = new FakeClock();
  const service = new QuotaService({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, fetch: fetchLike,
    resolveAuth: async (model) => ({ apiKey: `key-${model.provider}` }),
  });
  service.configure(quotaConfig({}, profiles));
  for (const index of [0, 1]) {
    service.onModel({ provider: `prov-${index}`, id: "glm" });
    clock.advance(0);
    await flush(4);
  }
  assert.equal(service.inflight, 2);
  // A third identity cannot start; its check is queued and starts when a slot frees.
  service.onModel({ provider: "prov-2", id: "glm" });
  clock.advance(0);
  await flush(4);
  assert.equal(service.inflight, 2);
  assert.equal(service.queue.length, 1);
  gates.get("key-prov-0").resolve();
  await flush(8);
  assert.equal(service.inflight, 2);
  assert.equal(service.queue.length, 0);
  assert.equal(service.view().profileId, "p2");
  for (const gate of gates.values()) gate.resolve();
  await flush(8);
  service.dispose();
});

test("off/shutdown/identity switch leave no timers behind; late results publish nothing", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchLike = async () => { await gate; return jsonResponse(personalBody); };
  const fixture = quotaFixture({ fetchLike });
  await flush(4);
  fixture.clock.advance(0); // the check starts and blocks inside the gated fetch
  await flush(2);
  assert.equal(fixture.controller.quota.inflight, 1);
  await fixture.controller.command("quota off", fixture.ctx);
  assert.equal(fixture.controller.config.quota.enabled, false);
  assert.equal(fixture.controller.quota.timer, null, "quota off must clear the check timer");
  assert.equal(fixture.controller.quota.queue.length, 0);
  assert.equal(fixture.controller.quota.pending, null);
  release();
  await flush(6);
  assert.equal(fixture.controller.quota.view(), null, "disabled service renders nothing");
  assert.equal(fixture.controller.state.snapshot().quota, null);
  // Shutdown while enabled also disposes everything.
  const second = quotaFixture({});
  second.fakeFetch.queue.push(jsonResponse(personalBody));
  await settle(second);
  second.emit("session_shutdown");
  assert.equal(second.controller.quota, null);
  assert.equal(second.clock.jobs.size, 0);
});

test("non-TUI sessions never create the quota service", async () => {
  const host = controllerFixture({
    mode: "rpc",
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
    quotaFetch: async () => { throw new Error("no network allowed"); },
    config: { quota: quotaConfig() },
  });
  host.emit("session_start");
  await flush(4);
  assert.equal(host.controller.quota, null);
  await host.controller.command("quota on", host.ctx);
  await flush(4);
  assert.equal(host.controller.quota, null);
});

test("LRU cache holds at most 16 identities and evicts the least recently used", async () => {
  const clock = new FakeClock();
  let keySeq = 0;
  const service = new QuotaService({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetch: async () => jsonResponse(personalBody),
    resolveAuth: async () => ({ apiKey: `key-${++keySeq}` }), // a rotated key is a new identity
  });
  service.configure(quotaConfig()); // one profile, many credential generations
  service.onModel({ provider: "zai-coding-cn", id: "glm" });
  for (let index = 0; index < 18; index++) {
    service.notify("settled"); // same model: each check resolves a fresh key
    await settle({ clock });
  }
  assert.equal(service.entries.size, QUOTA_LIMITS.maxIdentities);
  assert.ok(service.counters.evictions >= 2);
  service.dispose();
});

test("snapshots keep at most 32 buckets, truncated and marked", () => {
  const limits = Array.from({ length: 40 }, () => ({ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10 }));
  const body = JSON.stringify({ code: 200, success: true, data: { limits } });
  const parsed = zaiParse(200, noHeaders, body, { now: 0 });
  assert.equal(parsed.snapshot.buckets.length, 32);
  assert.equal(parsed.snapshot.truncated, true);
  // Through the service, the stored snapshot is also capped.
  const clock = new FakeClock();
  const service = new QuotaService({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, fetch: async () => jsonResponse(body), resolveAuth: async () => ({ apiKey: "k" }) });
  service.configure(quotaConfig());
  service.onModel({ provider: "zai-coding-cn", id: "glm" });
  clock.advance(0);
  return flush(6).then(() => {
    const entry = service.entries.get(service.currentKey);
    assert.equal(entry.lastSuccess.buckets.length, 32);
    assert.equal(entry.lastSuccess.truncated, true);
    assert.equal(service.view().truncated, true);
    service.dispose();
  });
});

test("/hud quota on|off|refresh and /hud quotas round-trip through the controller", async () => {
  const fixture = quotaFixture({ config: quotaConfig({ enabled: false }) });
  await settle(fixture);
  assert.equal(fixture.controller.quota, null);
  await fixture.controller.command("quota on", fixture.ctx);
  assert.equal(fixture.controller.quota.enabled, true);
  fixture.fakeFetch.queue.push(jsonResponse(personalBody));
  await settle(fixture);
  const notifications = fixture.calls.notifications;
  assert.ok(notifications.some((item) => item.message.includes("pi-hud quota on")));
  await fixture.controller.command("quota refresh", fixture.ctx);
  await flush(2);
  assert.ok(notifications.some((item) => item.message.includes("quota refresh")));
  await fixture.controller.command("quotas", fixture.ctx);
  const quotas = notifications.at(-1).message;
  const parsed = JSON.parse(quotas);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.profileList.length, 1);
  assert.equal(parsed.profileList[0].cache.lastSuccess.buckets.length, 3);
  assert.ok(!quotas.includes("key-synth"), "diagnostics must not contain credentials");
  await fixture.controller.command("quota off", fixture.ctx);
  assert.equal(fixture.controller.quota.queue.length, 0);
  assert.equal(fixture.controller.quota.timer, null);
  assert.equal(fixture.controller.quota.pending, null);
  assert.ok(notifications.some((item) => item.message.includes("quota tasks cancelled")));
});

test("agent_settled and model_select are the only recurring triggers; auth resolves once per batch", async () => {
  const fixture = quotaFixture({});
  fixture.fakeFetch.queue.push(jsonResponse(personalBody));
  await settle(fixture);
  const before = fixture.controller.quota.counters.authResolutions;
  fixture.emit("agent_settled");
  fixture.emit("agent_settled");
  fixture.emit("agent_settled");
  await settle(fixture);
  // One merged check for the burst (cache fresh -> publish only).
  assert.equal(fixture.controller.quota.counters.authResolutions, before + 1);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const quotaView = (overrides = {}) => ({
  status: "ready", profileId: "glm-personal", planKey: "zai:personal", issue: null,
  stale: false, updatedAt: 1_000, truncated: false, balance: null,
  buckets: [
    { unit: "hour", number: 5, remainingPercent: 87, resetAt: 1893456000000 },
    { unit: "week", number: 1, remainingPercent: 64, resetAt: 1893542400000 },
  ],
  ...overrides,
});

const snapshotWith = (quota) => ({
  project: "demo", model: "GLM", thinking: "", contextWindow: 200_000, contextTokens: 90_000,
  phase: "idle", activeTools: [], activeCount: 0, done: 0, errors: 0, interrupted: 0, dropped: 0,
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHit: null, speedRate: null, speedTokens: 0, speedMs: 0,
  cost: 0, usageReports: 0, costReports: 0, compactions: 0, lastTool: "", runningAgents: 0, agentErrors: 0,
  agentLabel: "", taskTotal: 0, taskDone: 0, taskLabel: "", taskSources: 0, toolCategories: [], git: null,
  quota, sessionUsage: null,
});

test("quota field renders plan identity, windows and both languages with fixed rows", () => {
  const snapshot = snapshotWith(quotaView());
  const en = formatHud(snapshot, normalize({ language: "en", preset: "full" }), 160);
  const zh = formatHud(snapshot, normalize({ language: "zh-CN", preset: "full" }), 160);
  assert.match(en[0].text, /GLM Personal · 5h 87% · wk 64%/);
  assert.match(zh[0].text, /GLM 个人 · 5h 87% · 周 64%/);
  // Plan remaining is labelled by the plan identity, explicitly distinct from ctx(last).
  assert.match(en[0].text, /ctx\(last\)/);
  assert.match(zh[0].text, /上下文\(上次\)/);
  // Fixed row counts: widget 1/2/3 by preset, unchanged by quota data.
  assert.equal(formatHud(snapshot, normalize({ preset: "minimal" }), 160).length, 1);
  assert.equal(formatHud(snapshot, normalize({ preset: "balanced" }), 160).length, 2);
  assert.equal(formatHud(snapshot, normalize({ preset: "full" }), 160).length, 3);
  // Footer body rows stay 2/3/4.
  const identity = { cwd: "~/demo", provider: "zai", title: "", branch: null, branchDirty: false };
  assert.equal(formatFooter(snapshot, normalize({ preset: "full" }), 160, identity).length, 4);
  assert.match(formatFooter(snapshot, normalize({ language: "zh-CN" }), 160, identity)[0].text, /GLM 个人/);
});

test("quota field states: stale marker, issue codes, loading and unconfigured", () => {
  const words = LABELS["zh-CN"];
  const stale = quotaField(quotaView({ stale: true }), normalize({ language: "zh-CN" }), words);
  assert.match(stale.text, /过期/);
  const issue = quotaField(quotaView({ status: "issue", issue: { code: "needs-auth", detail: "" }, buckets: [] }), normalize({ language: "en" }), LABELS.en);
  assert.equal(issue.text, "GLM Personal !needs-auth");
  const transient = quotaField(quotaView({ status: "issue", issue: { code: "rate-limited", detail: "" }, stale: true }), normalize({ language: "en" }), LABELS.en);
  assert.match(transient.text, /5h 87%/);
  assert.match(transient.text, /!rate-limited/);
  assert.match(transient.text, /stale/);
  const loading = quotaField(quotaView({ status: "loading", buckets: [] }), normalize({ language: "en" }), LABELS.en);
  assert.equal(loading.text, "GLM Personal ?");
  const unconfigured = quotaField(quotaView({ status: "unconfigured" }), normalize({ language: "zh-CN" }), words);
  assert.equal(unconfigured.text, "套餐 未配置额度来源");
  const ambiguous = quotaField(quotaView({ status: "ambiguous-profile", issue: { code: "ambiguous-profile", detail: "" } }), normalize({ language: "en" }), LABELS.en);
  assert.match(ambiguous.text, /ambiguous-profile/);
  assert.equal(quotaField(null, normalize(), LABELS.en), null);
});

test("narrow rows drop the quota field before context and model, by priority", () => {
  const snapshot = snapshotWith(quotaView());
  const rows = formatHud(snapshot, normalize({ preset: "balanced" }), 46);
  assert.ok(!rows[0].text.includes("GLM Personal"), "quota drops before context at narrow widths");
  assert.match(rows[0].text, /ctx/);
  const wide = formatHud(snapshot, normalize({ preset: "balanced" }), 120);
  assert.match(wide[0].text, /GLM Personal/);
  // The unconfigured marker drops even earlier than the path field.
  const narrowUnconfigured = formatHud(snapshotWith(quotaView({ status: "unconfigured" })), normalize({ preset: "balanced" }), 42);
  assert.ok(!narrowUnconfigured[0].text.includes("no quota source"));
  assert.match(narrowUnconfigured[0].text, /demo/);
});

test("plan identity labels cover both GLM plans and unknown adapters safely", () => {
  assert.equal(quotaPlanLabel("zai:personal", "zh-CN"), "GLM 个人");
  assert.equal(quotaPlanLabel("zai:team", "zh-CN"), "GLM 团队");
  assert.equal(quotaPlanLabel("zai:team", "en"), "GLM Team");
  assert.equal(quotaPlanLabel("minimax:token", "en"), "minimax:token");
  assert.equal(quotaPlanLabel("", "en"), "plan");
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test("quota config accepts the verified combinations and rejects invalid ones", () => {
  const good = normalizeQuota({ enabled: true, profiles: [personalProfile, teamProfile] });
  assert.equal(good.profiles.length, 2);
  assert.equal(good.profiles[1].organizationId, "org-synth");
  assert.deepEqual(normalizeQuota({}), { enabled: false, ttlMs: 300_000, timeoutMs: 5_000, profiles: [] });
  // Unknown fields and duplicated ids reject the whole quota node.
  assert.throws(() => normalizeQuota({ profiles: [{ ...personalProfile, extra: 1 }] }), /Unknown quota profile key/);
  assert.throws(() => normalizeQuota({ bogus: true }), /Unknown quota key/);
  assert.throws(() => normalizeQuota({ profiles: [personalProfile, { ...personalProfile }] }), /Duplicate quota profile id/);
  // Invalid combinations.
  assert.throws(() => normalizeQuota({ profiles: [{ ...teamProfile, queryMode: "personal-legacy" }] }), /invalid plan\/queryMode/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...personalProfile, queryMode: "team" }] }), /invalid plan\/queryMode/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...personalProfile, plan: undefined, queryMode: undefined }] }), /plan and queryMode are required/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...personalProfile, region: undefined }] }), /region is required/);
  assert.throws(() => normalizeQuota({ profiles: [{ id: "x", providerId: "p", adapter: "zai", source: "codex-app-server", region: "cn", plan: "team", queryMode: "team" }] }), /source/);
  assert.throws(() => normalizeQuota({ profiles: [{ id: "x", providerId: "p", adapter: "deepseek", source: "pi", region: "cn" }] }), /not a valid field for adapter/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...personalProfile, origin: "https://evil.example.com" }] }), /origin/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...personalProfile, origin: "http://open.bigmodel.cn" }] }), /origin/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...personalProfile, modelIds: ["a", "a"] }] }), /duplicate model id/);
  assert.throws(() => normalizeQuota({ profiles: Array.from({ length: 17 }, (_, index) => ({ ...personalProfile, id: `p${index}` })) }), /at most 16/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...personalProfile, id: "bad id\u0007" }] }), /control characters/);
  assert.throws(() => normalizeQuota({ ttlMs: 1_000 }), /ttlMs/);
  assert.throws(() => normalizeQuota({ timeoutMs: 100 }), /timeoutMs/);
  // A valid origin equals the adapter table exactly.
  const withOrigin = normalizeQuota({ profiles: [{ ...personalProfile, origin: "https://open.bigmodel.cn/" }] });
  assert.equal(withOrigin.profiles[0].origin, "https://open.bigmodel.cn");
});

test("a rejected quota node keeps the previous configuration active", async () => {
  const fixture = quotaFixture({});
  fixture.fakeFetch.queue.push(jsonResponse(personalBody));
  await settle(fixture);
  const before = fixture.controller.config.quota;
  const previousConfigLoader = fixture.controller.configLoader;
  fixture.controller.configLoader = async () => ({ config: { quota: { profiles: [{ ...personalProfile, extra: 1 }] } }, found: true });
  await fixture.controller.reloadConfig(false);
  fixture.controller.configLoader = previousConfigLoader;
  assert.equal(fixture.controller.config.quota, before, "a rejected reload keeps the previous quota configuration");
  assert.match(fixture.controller.configurationError, /quota/);
  assert.equal(fixture.controller.quota.enabled, true);
});

test("normalizeConfig round-trips quota defaults and deep-freezes profiles", () => {
  const config = normalizeConfig({ quota: { enabled: true, profiles: [teamProfile] } });
  assert.equal(config.quota.enabled, true);
  assert.equal(config.quota.profiles.length, 1);
  assert.ok(Object.isFrozen(config.quota.profiles));
  assert.ok(Object.isFrozen(config.quota.profiles[0]));
  const again = normalizeConfig(config);
  assert.deepEqual(again.quota.profiles[0], config.quota.profiles[0]);
  assert.equal(normalizeConfig().quota.enabled, false);
});

// ---------------------------------------------------------------------------
// DeepSeek / SiliconFlow balance adapters (API 余额; official contracts, synthetic samples)
// ---------------------------------------------------------------------------

/** Official DeepSeek sample shape (api-docs.deepseek.com get-user-balance). */
const deepseekBody = JSON.stringify({
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
  ],
});

/** Official SiliconFlow sample shape (openapi.yaml /user/info examples). */
const siliconflowBody = JSON.stringify({
  code: 20000, message: "OK", status: true,
  data: {
    id: "userid", name: "username", image: "https://img.example/a.png", email: "u@example.com",
    isAdmin: false, balance: "0.88", status: "normal", introduction: "", role: "user",
    chargeBalance: "88.00", totalBalance: "88.88",
  },
});

const deepseekProfile = { id: "ds-balance", providerId: "deepseek", adapter: "deepseek", source: "pi" };
const siliconflowProfile = { id: "sf-balance", providerId: "siliconflow", adapter: "siliconflow", source: "pi" };

test("deepseekParse maps the documented sample: exact amounts kept, never re-summed", () => {
  const result = deepseekParse(200, noHeaders, deepseekBody, { now: 0 });
  assert.equal(result.kind, "snapshot");
  const snapshot = result.snapshot;
  assert.equal(snapshot.buckets.length, 0);
  assert.equal(snapshot.planLabel, "");
  assert.deepEqual(snapshot.balances, [
    { amountText: "110.00", currency: "CNY", scope: "account" },
    { amountText: "10.00", currency: "CNY", scope: "granted" },
    { amountText: "100.00", currency: "CNY", scope: "topped-up" },
  ]);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.truncated, false);
  // The total stays the server text; granted+topped-up are never added up into it.
  assert.notEqual(snapshot.balances[0].amountText, String(10 + 100));
});

test("deepseekParse keeps zero, negative and USD amounts as legal server values", () => {
  const body = JSON.stringify({
    is_available: false,
    balance_infos: [
      { currency: "USD", total_balance: "-1.20", granted_balance: "0.00", topped_up_balance: "-1.20" },
    ],
  });
  const result = deepseekParse(200, noHeaders, body, { now: 0 });
  assert.equal(result.kind, "snapshot");
  assert.deepEqual(result.balances === undefined ? result.snapshot.balances : [], [
    { amountText: "-1.20", currency: "USD", scope: "account" },
    { amountText: "0.00", currency: "USD", scope: "granted" },
    { amountText: "-1.20", currency: "USD", scope: "topped-up" },
  ]);
});

test("deepseekParse: invalid items are skipped or partial; totals are never recomputed from parts", () => {
  // Total invalid but parts valid: the main balance stays absent (never 10+100), parts kept.
  const partialBody = JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: "1,100.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
  });
  const partial = deepseekParse(200, noHeaders, partialBody, { now: 0 });
  assert.equal(partial.kind, "snapshot");
  assert.equal(partial.snapshot.balances.find((item) => item.scope === "account"), undefined);
  assert.equal(partial.snapshot.balances.length, 2);
  assert.equal(partial.snapshot.partial, true);
  // An invalid currency skips the whole item.
  const badCurrency = deepseekParse(200, noHeaders, JSON.stringify({
    balance_infos: [{ currency: "元", total_balance: "1.00" }],
  }), { now: 0 });
  assert.equal(badCurrency.kind, "issue");
  assert.equal(badCurrency.issue.code, "protocol-error");
  // Lowercase currency is normalized.
  const lower = deepseekParse(200, noHeaders, JSON.stringify({
    balance_infos: [{ currency: "cny", total_balance: "5.00" }],
  }), { now: 0 });
  assert.equal(lower.kind, "snapshot");
  assert.equal(lower.snapshot.balances[0].currency, "CNY");
});

test("deepseekParse rejects empty or malformed payloads without inventing values", () => {
  const empty = deepseekParse(200, noHeaders, JSON.stringify({ is_available: true, balance_infos: [] }), { now: 0 });
  assert.equal(empty.issue.code, "no-data");
  const missing = deepseekParse(200, noHeaders, JSON.stringify({ is_available: true }), { now: 0 });
  assert.equal(missing.issue.code, "no-data");
  const array = deepseekParse(200, noHeaders, JSON.stringify([{ currency: "CNY" }]), { now: 0 });
  assert.equal(array.issue.code, "protocol-error");
  const invalid = deepseekParse(200, noHeaders, "not-json", { now: 0 });
  assert.equal(invalid.issue.code, "protocol-error");
});

test("deepseekParse maps HTTP status per §10 and parses Retry-After", () => {
  assert.equal(deepseekParse(401, noHeaders, "", { now: 0 }).issue.code, "needs-auth");
  assert.equal(deepseekParse(403, noHeaders, "", { now: 0 }).issue.code, "forbidden");
  const limited = deepseekParse(429, { get: (name) => name === "retry-after" ? "2" : null }, "", { now: 1_000 });
  assert.equal(limited.issue.code, "rate-limited");
  assert.equal(limited.issue.retryAt, 3_000);
  const noHeader = deepseekParse(429, noHeaders, "", { now: 1_000 });
  assert.equal(noHeader.issue.retryAt, 31_000);
  assert.equal(deepseekParse(500, noHeaders, "", { now: 0 }).issue.code, "http-error");
});

test("deepseekPrepare builds the Bearer request and refuses missing keys or foreign origins", () => {
  const ok = deepseekPrepare({ profile: deepseekProfile, auth: { apiKey: "sk-synth" } });
  assert.equal(ok.kind, "request");
  assert.equal(ok.url, `${DEEPSEEK_QUOTA_ORIGIN}/user/balance`);
  assert.equal(ok.headers.Authorization, "Bearer sk-synth");
  assert.equal(ok.headers.Accept, "application/json");
  // An already-prefixed key is never doubled.
  assert.equal(deepseekPrepare({ profile: deepseekProfile, auth: { apiKey: "Bearer sk-synth" } }).headers.Authorization, "Bearer sk-synth");
  assert.equal(deepseekPrepare({ profile: deepseekProfile, auth: { apiKey: "bearer sk-synth" } }).headers.Authorization, "bearer sk-synth");
  assert.equal(deepseekPrepare({ profile: deepseekProfile, auth: null }).issue.code, "needs-auth");
  assert.equal(deepseekPrepare({ profile: deepseekProfile, auth: { apiKey: "" } }).issue.code, "needs-auth");
  assert.equal(deepseekPrepare({ profile: { ...deepseekProfile, origin: "https://evil.example.com" }, auth: { apiKey: "sk" } }).issue.code, "needs-verification");
  // The official base URL (with any path) passes the guard.
  const official = deepseekPrepare({ profile: deepseekProfile, auth: { apiKey: "sk", baseUrl: "https://api.deepseek.com/v1" } });
  assert.equal(official.kind, "request");
});

test("deepseekPrepare refuses relay providers: the relay key never reaches the official host", () => {
  const relay = deepseekPrepare({ profile: { ...deepseekProfile, providerId: "dgx-relay" }, auth: { apiKey: "relay-key", baseUrl: "https://newapi.qpanda.cn/v1" } });
  assert.equal(relay.issue.code, "needs-verification");
  // Plain http or unparsable base URLs are treated as unverified too, never skipped.
  assert.equal(deepseekPrepare({ profile: deepseekProfile, auth: { apiKey: "k", baseUrl: "http://api.deepseek.com/v1" } }).issue.code, "needs-verification");
  assert.equal(deepseekPrepare({ profile: deepseekProfile, auth: { apiKey: "k", baseUrl: "::bad::" } }).issue.code, "needs-verification");
  // An absent base URL (host did not provide one) still allows the fixed-origin query.
  assert.equal(deepseekPrepare({ profile: deepseekProfile, auth: { apiKey: "k" } }).kind, "request");
});

test("siliconflowParse maps the official example in CNY, parts never re-summed", () => {
  const result = siliconflowParse(200, noHeaders, siliconflowBody, { now: 0 });
  assert.equal(result.kind, "snapshot");
  assert.deepEqual(result.snapshot.balances, [
    { amountText: "88.88", currency: "CNY", scope: "account" },
    { amountText: "0.88", currency: "CNY", scope: "granted" },
    { amountText: "88.00", currency: "CNY", scope: "topped-up" },
  ]);
  assert.equal(result.snapshot.buckets.length, 0);
  assert.equal(result.snapshot.partial, false);
  // 0.88 + 88.00 equals 88.88 here, but the total is the server text, not a sum.
  assert.equal(result.snapshot.balances[0].amountText, "88.88");
});

test("siliconflowParse rejects business-envelope failures without echoing the message", () => {
  const wrongCode = siliconflowParse(200, noHeaders, JSON.stringify({ code: 20001, message: "secret reason", status: true, data: {} }), { now: 0 });
  assert.equal(wrongCode.issue.code, "business-error");
  assert.ok(!wrongCode.issue.detail.includes("secret"));
  const statusFalse = siliconflowParse(200, noHeaders, JSON.stringify({ code: 20000, message: "OK", status: false, data: {} }), { now: 0 });
  assert.equal(statusFalse.issue.code, "business-error");
  const missingEnvelope = siliconflowParse(200, noHeaders, JSON.stringify({ data: { totalBalance: "1.00" } }), { now: 0 });
  assert.equal(missingEnvelope.issue.code, "business-error");
});

test("siliconflowParse: missing data is no-data; present-but-invalid amounts are protocol errors", () => {
  const missing = siliconflowParse(200, noHeaders, JSON.stringify({ code: 20000, status: true }), { now: 0 });
  assert.equal(missing.issue.code, "no-data");
  const noFields = siliconflowParse(200, noHeaders, JSON.stringify({ code: 20000, status: true, data: { id: "u" } }), { now: 0 });
  assert.equal(noFields.issue.code, "no-data");
  const invalid = siliconflowParse(200, noHeaders, JSON.stringify({ code: 20000, status: true, data: { totalBalance: "8.8.8" } }), { now: 0 });
  assert.equal(invalid.issue.code, "protocol-error");
  // A valid part with an invalid total keeps the part and marks the snapshot partial.
  const partial = siliconflowParse(200, noHeaders, JSON.stringify({ code: 20000, status: true, data: { totalBalance: "x", chargeBalance: "3.00" } }), { now: 0 });
  assert.equal(partial.kind, "snapshot");
  assert.deepEqual(partial.snapshot.balances, [{ amountText: "3.00", currency: "CNY", scope: "topped-up" }]);
  assert.equal(partial.snapshot.partial, true);
  // HTTP mapping is the shared §10 table.
  assert.equal(siliconflowParse(401, noHeaders, "", { now: 0 }).issue.code, "needs-auth");
  assert.equal(siliconflowParse(429, noHeaders, "", { now: 1_000 }).issue.retryAt, 31_000);
});

test("siliconflowPrepare builds the Bearer request and applies the same relay guard", () => {
  const ok = siliconflowPrepare({ profile: siliconflowProfile, auth: { apiKey: "sk-synth" } });
  assert.equal(ok.kind, "request");
  assert.equal(ok.url, `${SILICONFLOW_QUOTA_ORIGIN}/v1/user/info`);
  assert.equal(ok.headers.Authorization, "Bearer sk-synth");
  assert.equal(siliconflowPrepare({ profile: siliconflowProfile, auth: null }).issue.code, "needs-auth");
  assert.equal(siliconflowPrepare({ profile: siliconflowProfile, auth: { apiKey: "k", baseUrl: "https://relay.example.com/v1" } }).issue.code, "needs-verification");
  const official = siliconflowPrepare({ profile: siliconflowProfile, auth: { apiKey: "k", baseUrl: "https://api.siliconflow.cn/v1" } });
  assert.equal(official.kind, "request");
});

test("shared http helpers: bounded exact-text amounts, currency codes, Bearer prefix", () => {
  assert.equal(decimalText("110.00"), "110.00");
  assert.equal(decimalText(" -0.5 "), "-0.5");
  assert.equal(decimalText("0"), "0");
  assert.equal(decimalText("1e5"), null);
  assert.equal(decimalText("1,100.00"), null);
  assert.equal(decimalText(1.5), null);
  assert.equal(decimalText("Infinity"), null);
  assert.equal(decimalText(".".repeat(40)), null);
  assert.equal(decimalText("0.".repeat(1) + "123456789"), null);
  assert.equal(currencyCode("cny"), "CNY");
  assert.equal(currencyCode("USD"), "USD");
  assert.equal(currencyCode("CNY元"), null);
  assert.equal(currencyCode(1), null);
  assert.equal(bearerAuthorization("sk-1"), "Bearer sk-1");
  assert.equal(bearerAuthorization("Bearer sk-1"), "Bearer sk-1");
  assert.equal(bearerAuthorization("bearer sk-1"), "bearer sk-1");
});

test("deepseek end-to-end: Bearer request, HUD balance row, cache, TTL and details", async () => {
  const fixture = quotaFixture({
    config: quotaConfig({}, [deepseekProfile]),
    fetchLike: (() => {
      const fake = new FakeFetch();
      fake.queue.push(jsonResponse(deepseekBody));
      return fake;
    })(),
    model: { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  });
  await settle(fixture);
  const request = fixture.fakeFetch.calls[0];
  assert.equal(request.url, "https://api.deepseek.com/user/balance");
  assert.equal(request.authorization, "Bearer key-synth");
  const view = fixture.controller.quota.view();
  assert.equal(view.status, "ready");
  assert.equal(view.planKey, "deepseek");
  assert.deepEqual(view.balance, { amountText: "110.00", currency: "CNY", scope: "account" });
  assert.equal(view.buckets.length, 0);
  // Cached within TTL: no second request on the next trigger.
  fixture.controller.quota.notify("settled");
  await settle(fixture);
  assert.equal(fixture.requestCount(), 1);
  // TTL expiry only marks stale; the next event-driven check refreshes.
  fixture.clock.advance(300_001);
  fixture.fakeFetch.queue.push(jsonResponse(deepseekBody));
  fixture.controller.quota.notify("settled");
  await settle(fixture);
  assert.equal(fixture.requestCount(), 2);
  // Details carry the granted/topped-up parts.
  const details = fixture.controller.quota.inspect();
  const cached = details.profileList[0].cache.lastSuccess;
  assert.deepEqual(cached.balances.map((item) => `${item.scope}:${item.amountText}`), ["account:110.00", "granted:10.00", "topped-up:100.00"]);
});

test("siliconflow end-to-end: business failure keeps the last values; 401 hides them", async () => {
  const fake = new FakeFetch();
  fake.queue.push(jsonResponse(siliconflowBody));
  fake.queue.push(jsonResponse(JSON.stringify({ code: 20001, message: "x", status: true, data: null })));
  fake.queue.push(jsonResponse("", 401));
  const fixture = quotaFixture({
    config: quotaConfig({}, [siliconflowProfile]),
    fetchLike: fake,
    model: { provider: "siliconflow", id: "Qwen/Qwen3-235B-A22B", name: "Qwen3 235B" },
  });
  await settle(fixture);
  let view = fixture.controller.quota.view();
  assert.equal(view.status, "ready");
  assert.deepEqual(view.balance, { amountText: "88.88", currency: "CNY", scope: "account" });
  // A business failure keeps the old snapshot visible (stale), never zeroes it.
  fixture.clock.advance(300_001);
  fixture.controller.quota.notify("settled");
  await settle(fixture);
  view = fixture.controller.quota.view();
  assert.equal(view.status, "issue");
  assert.deepEqual(view.balance, { amountText: "88.88", currency: "CNY", scope: "account" });
  assert.equal(view.issue.code, "business-error");
  // 401 hides the values as currently valid (§10) without deleting the history.
  fixture.clock.advance(300_001);
  fixture.controller.quota.notify("settled");
  await settle(fixture);
  view = fixture.controller.quota.view();
  assert.equal(view.status, "issue");
  assert.equal(view.issue.code, "needs-auth");
  assert.equal(view.balance, null);
  const details = fixture.controller.quota.inspect().profileList[0].cache.lastSuccess;
  assert.equal(details.balances[0].amountText, "88.88");
});

test("relay-bound profiles never query: needs-verification without any request", async () => {
  const fixture = quotaFixture({
    config: quotaConfig({}, [{ ...deepseekProfile, providerId: "dgx-deepseek" }]),
    auth: { ok: true, apiKey: "relay-key", baseUrl: "https://newapi.qpanda.cn/v1" },
    model: { provider: "dgx-deepseek", id: "deepseek-v4-pro", name: "DeepSeek (relay)" },
  });
  await settle(fixture);
  assert.equal(fixture.requestCount(), 0);
  const view = fixture.controller.quota.view();
  assert.equal(view.status, "issue");
  assert.equal(view.issue.code, "needs-verification");
});

test("balance rows render with exact currency text in both languages and ASCII", () => {
  const balanceView = (overrides = {}) => quotaView({ planKey: "deepseek", buckets: [], balance: { amountText: "110.00", currency: "CNY", scope: "account" }, ...overrides });
  const en = quotaField(balanceView(), normalize({ language: "en" }), LABELS.en);
  assert.equal(en.text, "DeepSeek · ¥110.00");
  const zh = quotaField(balanceView({ planKey: "siliconflow" }), normalize({ language: "zh-CN" }), LABELS["zh-CN"]);
  assert.equal(zh.text, "硅基流动 · ¥110.00");
  const ascii = quotaField(balanceView(), normalize({ ascii: true }), LABELS.en);
  assert.equal(ascii.text, "DeepSeek | CNY 110.00");
  const usd = quotaField(balanceView({ balance: { amountText: "88.88", currency: "USD", scope: "account" } }), normalize(), LABELS.en);
  assert.equal(usd.text, "DeepSeek · $88.88");
  const negative = quotaField(balanceView({ balance: { amountText: "-1.20", currency: "CNY", scope: "account" } }), normalize(), LABELS.en);
  assert.equal(negative.text, "DeepSeek · -¥1.20");
  const other = quotaField(balanceView({ balance: { amountText: "5.00", currency: "EUR", scope: "account" } }), normalize(), LABELS.en);
  assert.equal(other.text, "DeepSeek · EUR 5.00");
  // Stale and transient-issue states keep the amount visible.
  assert.match(quotaField(balanceView({ stale: true }), normalize(), LABELS.en).text, /stale/);
  const transient = quotaField(balanceView({ status: "issue", issue: { code: "rate-limited", detail: "" }, stale: true }), normalize(), LABELS.en);
  assert.match(transient.text, /¥110\.00/);
  assert.match(transient.text, /!rate-limited/);
  // Loading and no-value states stay bounded.
  assert.equal(quotaField(balanceView({ status: "loading", balance: null }), normalize(), LABELS.en).text, "DeepSeek ?");
  assert.equal(quotaField(balanceView({ balance: null }), normalize(), LABELS.en).text, "DeepSeek …");
});

test("balance plan labels cover the two API adapters in both languages", () => {
  assert.equal(quotaPlanLabel("deepseek", "zh-CN"), "DeepSeek");
  assert.equal(quotaPlanLabel("deepseek", "en"), "DeepSeek");
  assert.equal(quotaPlanLabel("siliconflow", "zh-CN"), "硅基流动");
  assert.equal(quotaPlanLabel("siliconflow", "en"), "SiliconFlow");
});

test("quota config accepts the balance adapters and rejects their invalid fields", () => {
  const deepseek = normalizeQuota({ enabled: true, profiles: [deepseekProfile] });
  assert.equal(deepseek.profiles[0].adapter, "deepseek");
  assert.equal(deepseek.profiles[0].region, undefined);
  const withOrigin = normalizeQuota({ profiles: [{ ...deepseekProfile, origin: "https://api.deepseek.com/" }] });
  assert.equal(withOrigin.profiles[0].origin, "https://api.deepseek.com");
  const siliconflow = normalizeQuota({ profiles: [{ ...siliconflowProfile, origin: "https://api.siliconflow.cn" }] });
  assert.equal(siliconflow.profiles[0].origin, "https://api.siliconflow.cn");
  // Balance adapters reject plan/queryMode, scope and region.
  assert.throws(() => normalizeQuota({ profiles: [{ ...deepseekProfile, plan: "personal" }] }), /only valid for the zai adapter/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...deepseekProfile, queryMode: "team" }] }), /only valid for the zai adapter/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...deepseekProfile, organizationId: "o" }] }), /only valid for the zai adapter/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...deepseekProfile, projectId: "p" }] }), /only valid for the zai adapter/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...siliconflowProfile, region: "cn" }] }), /not a valid field for adapter/);
  // The origin must equal the adapter's fixed domain exactly.
  assert.throws(() => normalizeQuota({ profiles: [{ ...deepseekProfile, origin: "https://api.siliconflow.cn" }] }), /origin must be/);
  assert.throws(() => normalizeQuota({ profiles: [{ ...siliconflowProfile, origin: "https://api.deepseek.com" }] }), /origin must be/);
  // codex-app-server stays bound to the codex adapter.
  assert.throws(() => normalizeQuota({ profiles: [{ ...deepseekProfile, source: "codex-app-server" }] }), /source/);
});
