/**
 * Quota service: cache, scheduling, concurrency and lifecycle isolation
 * (docs/PROVIDER-LIMITS-PLAN.zh-CN.md §5/§10).
 *
 * Event callbacks only *mark* a pending check (`notify`); the merged check itself
 * runs on a one-shot timer, so no host event ever awaits network or auth work, and
 * at most one auth resolution happens per merged trigger batch.
 *
 * Invariants enforced here:
 * - default off: with `configure({enabled:false})` the service creates no timers,
 *   resolves no credentials and starts no tasks;
 * - TTL (default 5 min) never triggers network access; expiry only turns a display
 *   stale and waits for the next event;
 * - manual refresh respects a >=30 s per-identity cooldown and the server's
 *   Retry-After / local backoff (retryAt) and cannot bypass either;
 * - at most 2 concurrent queries globally, one per identity (single-flight), with a
 *   bounded queue (overflow drops are counted);
 * - every network task carries the identity generation it was created for; off,
 *   shutdown, configure and identity switches bump the generation so late results
 *   are discarded (a late personal response can never overwrite the team snapshot);
 * - failures never rewrite quota values: `lastSuccess` is a separate snapshot, and
 *   auth/scope failures hide old values as currently valid instead of deleting them;
 * - the cache is an in-memory LRU of at most 16 identities; snapshots keep at most
 *   32 buckets, truncated with a marker;
 * - credentials exist only inside a request's local scope: the resolved key is
 *   passed to the adapter and the transport, and only an opaque fingerprint stays.
 */
import type { QuotaConfig, QuotaProfile } from "../config.ts";
import type { ClearTimer, SetTimer, TimerHandle } from "../scheduler.ts";
import { matchProfiles, reconcileScope, buildIdentity } from "./identity.ts";
import type { QuotaHostAuth, QuotaIdentity, QuotaIssue, QuotaIssueCode, QuotaSnapshot } from "./types.ts";
import { QUOTA_ISSUE_HIDES_VALUES, quotaIdentityKey } from "./types.ts";
import { quotaFetch, globalQuotaFetch } from "./transport.ts";
import type { QuotaFetchLike, QuotaTransportResult } from "./transport.ts";
import { zaiParse, zaiPrepare, ZAI_ORIGINS } from "./adapters/zai.ts";
import { deepseekParse, deepseekPrepare, DEEPSEEK_QUOTA_ORIGIN } from "./adapters/deepseek.ts";
import { siliconflowParse, siliconflowPrepare, SILICONFLOW_QUOTA_ORIGIN } from "./adapters/siliconflow.ts";

/** The implemented adapter registry. Structural prepare/parse shapes keep every
 *  adapter data-only; a name outside this table reports `unsupported-adapter`
 *  without any request (the remaining plan adapters stay diagnostics-only). */
interface QuotaAdapterImpl {
  usesScope: boolean;
  originFor: (profile: QuotaProfile) => string;
  prepare: (input: { profile: QuotaProfile; auth: QuotaHostAuth | null; scope: { organizationId: string | null; projectId: string | null; conflict: boolean } }) =>
    { kind: "request"; url: string; headers: Record<string, string> } | { kind: "issue"; issue: QuotaIssue };
  parse: (status: number, headers: { get(name: string): string | null } | null, body: string, context: { now: number }) =>
    { kind: "snapshot"; snapshot: import("./types.ts").QuotaSnapshotData } | { kind: "issue"; issue: QuotaIssue };
}

const NO_SCOPE = Object.freeze({ organizationId: null, projectId: null, conflict: false });

const ADAPTERS: Readonly<Record<string, QuotaAdapterImpl>> = Object.freeze({
  zai: {
    usesScope: true,
    originFor: (profile) => ZAI_ORIGINS[profile.region ?? "cn"] ?? ZAI_ORIGINS.cn,
    prepare: zaiPrepare,
    parse: zaiParse,
  },
  deepseek: {
    usesScope: false,
    originFor: () => DEEPSEEK_QUOTA_ORIGIN,
    prepare: deepseekPrepare,
    parse: deepseekParse,
  },
  siliconflow: {
    usesScope: false,
    originFor: () => SILICONFLOW_QUOTA_ORIGIN,
    prepare: siliconflowPrepare,
    parse: siliconflowParse,
  },
});

export const QUOTA_LIMITS = Object.freeze({
  maxIdentities: 16,
  maxBuckets: 32,
  concurrency: 2,
  queueCap: 8,
  manualCooldownMs: 30_000,
  backoffBaseMs: 30_000,
  backoffCapMs: 600_000,
  maxBodyBytes: 256 * 1024,
});

export type QuotaTrigger = "enable" | "identity" | "settled" | "manual";

/** Auth resolver injected by the controller (host `modelRegistry.getApiKeyAndHeaders`). */
export type QuotaAuthResolver = (model: { provider: string; id: string }) => Promise<QuotaHostAuth | null>;

export interface QuotaServiceOptions {
  now?: () => number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  fetch?: QuotaFetchLike;
  resolveAuth?: QuotaAuthResolver;
  onPublish?: () => void;
}

interface QuotaEntry {
  identity: QuotaIdentity;
  lifecycle: "idle" | "loading" | "ready" | "stale";
  issue: QuotaIssue | null;
  lastSuccess: QuotaSnapshot | null;
  /** Manual-refresh cooldown anchor (last accepted manual trigger). */
  lastManualAt: number;
  /** Consecutive retryable failures, driving the capped backoff. */
  failures: number;
  inflight: boolean;
}

type ModelStatus =
  | { kind: "none" }
  | { kind: "unconfigured" }
  | { kind: "ambiguous"; count: number }
  | { kind: "unsupported"; adapter: string };

/** Published HUD row view; details live in `inspect()`. */
export interface QuotaHudView {
  status: "unconfigured" | "ambiguous-profile" | "idle" | "loading" | "ready" | "stale" | "issue";
  profileId: string;
  planKey: string;
  issue: { code: QuotaIssueCode; detail: string } | null;
  stale: boolean;
  updatedAt: number | null;
  /** Display buckets: at most the hour and week windows, hour first. */
  buckets: Array<{ unit: "hour" | "week" | "month" | null; number: number; remainingPercent?: number; resetAt?: number }>;
  /** Main account balance (API adapters): the `account`-scope item, never re-summed. */
  balance: { amountText: string; currency: string; scope: string } | null;
  truncated: boolean;
}

export class QuotaService {
  declare readonly now: () => number;
  declare readonly setTimer: SetTimer;
  declare readonly clearTimer: ClearTimer;
  declare readonly fetchLike: QuotaFetchLike;
  declare resolveAuth: QuotaAuthResolver;
  declare onPublish: () => void;
  declare config: QuotaConfig | null;
  declare model: { provider: string; id: string } | null;
  declare entries: Map<string, QuotaEntry>;
  declare currentKey: string | null;
  declare generation: number;
  declare timer: TimerHandle | null;
  declare pending: QuotaTrigger | null;
  declare queue: string[];
  declare queuedGenerations: number[];
  declare inflight: number;
  declare closed: boolean;
  declare modelStatus: ModelStatus;
  declare counters: { checks: number; authResolutions: number; requests: number; published: number; discarded: number; queuedDrops: number; evictions: number };

  constructor(options: QuotaServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? (clearTimeout as unknown as ClearTimer);
    this.fetchLike = options.fetch ?? globalQuotaFetch;
    this.resolveAuth = options.resolveAuth ?? (async () => null);
    this.onPublish = options.onPublish ?? (() => {});
    this.config = null;
    this.model = null;
    this.entries = new Map();
    this.currentKey = null;
    this.generation = 0;
    this.timer = null;
    this.pending = null;
    this.queue = [];
    this.queuedGenerations = [];
    this.inflight = 0;
    this.closed = false;
    this.modelStatus = { kind: "none" };
    this.counters = { checks: 0, authResolutions: 0, requests: 0, published: 0, discarded: 0, queuedDrops: 0, evictions: 0 };
  }

  get enabled(): boolean {
    return !!this.config?.enabled && !this.closed;
  }

  /** Apply a new configuration. Disabling cancels every task immediately; a changed
   *  profile set bumps the generation so in-flight work for the old list is dropped. */
  configure(config: QuotaConfig) {
    const wasEnabled = this.enabled;
    const changed = !this.config || this.config.profiles !== config.profiles ||
      this.config.enabled !== config.enabled || this.config.ttlMs !== config.ttlMs;
    this.config = config;
    if (!config.enabled) {
      this.cancelTasks();
      return;
    }
    if (!wasEnabled || changed) this.notify("enable");
  }

  /** Track the current model; a provider/id change is an identity trigger. */
  onModel(model: { provider: string; id: string } | null) {
    const next = model && model.provider ? { provider: model.provider, id: model.id } : null;
    const changed = (next?.provider ?? "") !== (this.model?.provider ?? "") || (next?.id ?? "") !== (this.model?.id ?? "");
    this.model = next;
    if (changed && this.enabled) {
      // Identity switch: drop in-flight tasks for the previous identity immediately.
      this.generation++;
      this.queue = [];
      this.queuedGenerations = [];
      this.notify("identity");
    }
  }

  /** Mark a pending check. Event handlers never await anything here. */
  notify(trigger: QuotaTrigger) {
    if (!this.enabled || this.closed) return;
    if (trigger === "enable" || trigger === "identity") this.generation++;
    this.pending = trigger;
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.runPending();
    }, 0);
    this.timer?.unref?.();
  }

  /** Manual refresh entry point: synchronous cooldown/retryAt gate, then a check. */
  refreshManual(): { ok: boolean; message: string } {
    if (!this.enabled) return { ok: false, message: "quota support is disabled" };
    const entry = this.currentKey !== null ? this.entries.get(this.currentKey) : undefined;
    const now = this.now();
    if (entry) {
      if (entry.lastManualAt > 0 && now - entry.lastManualAt < QUOTA_LIMITS.manualCooldownMs) {
        return { ok: false, message: `manual refresh cooldown: ${Math.ceil((entry.lastManualAt + QUOTA_LIMITS.manualCooldownMs - now) / 1000)}s remaining` };
      }
      const retryAt = entry.issue?.retryAt ?? null;
      if (retryAt !== null && now < retryAt) {
        return { ok: false, message: `refresh blocked by Retry-After/backoff until ${new Date(retryAt).toISOString()}` };
      }
      entry.lastManualAt = now;
    }
    this.notify("manual");
    return { ok: true, message: "quota refresh requested" };
  }

  /** Cancel timers/queue and invalidate all in-flight results. */
  cancelTasks() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = null;
    this.queue = [];
    this.queuedGenerations = [];
    this.generation++;
  }

  private runPending() {
    const trigger = this.pending;
    this.pending = null;
    if (!this.enabled || trigger === null) return;
    this.counters.checks++;
    void this.check(trigger);
  }

  private async check(trigger: QuotaTrigger): Promise<void> {
    try {
      const config = this.config;
      if (!config || !this.enabled || !this.model) return;
      const generationAtStart = this.generation;
      const { matches } = matchProfiles(config.profiles, this.model);
      if (matches.length === 0) {
        this.modelStatus = { kind: "unconfigured" };
        this.publishCurrent();
        return;
      }
      if (matches.length > 1) {
        // Ambiguity is never resolved by list order (§9).
        this.modelStatus = { kind: "ambiguous", count: matches.length };
        this.publishCurrent();
        return;
      }
      const profile = matches[0];
      const impl = ADAPTERS[profile.adapter];
      if (!impl) {
        this.modelStatus = { kind: "unsupported", adapter: profile.adapter };
        this.publishCurrent();
        return;
      }
      this.modelStatus = { kind: "none" };
      // One auth resolution per merged check (§10). The raw key stays in this frame.
      this.counters.authResolutions++;
      let auth: QuotaHostAuth | null = null;
      try {
        auth = await this.resolveAuth(this.model);
      } catch {
        auth = null;
      }
      if (generationAtStart !== this.generation || !this.enabled) {
        // A configure/identity change landed during the auth resolution; this check
        // describes a superseded state and must not query or publish.
        this.counters.discarded++;
        return;
      }
      const scope = impl.usesScope ? reconcileScope(profile, auth, profile.queryMode ?? "") : NO_SCOPE;
      const origin = profile.origin ?? impl.originFor(profile);
      const identity = buildIdentity(profile, origin, scope, auth);
      const key = quotaIdentityKey(identity);
      if (key !== this.currentKey) {
        // Credential or scope change: previous in-flight work must not publish.
        this.generation++;
        this.currentKey = key;
      }
      const entry = this.entryFor(identity, key);
      const generation = this.generation;
      const now = this.now();
      const snapshot = entry.lastSuccess;
      if (snapshot && snapshot.expiresAt > now && trigger !== "manual") {
        // Fresh cache: publish without any network access. A transient issue from an
        // earlier manual refresh keeps its own record; the lifecycle stays as published.
        if (!entry.issue) entry.lifecycle = "ready";
        this.publishCurrent();
        return;
      }
      const retryAt = entry.issue?.retryAt ?? null;
      if (retryAt !== null && now < retryAt) {
        this.publishCurrent();
        return;
      }
      if (entry.inflight) return; // Per-identity single-flight.
      if (this.inflight >= QUOTA_LIMITS.concurrency) {
        if (this.queue.length >= QUOTA_LIMITS.queueCap) { this.counters.queuedDrops++; return; }
        this.queue.push(key);
        this.queuedGenerations.push(generation);
        return;
      }
      await this.query(profile, auth, scope, origin, entry, key, generation);
    } finally {
      this.drainQueue();
    }
  }

  private drainQueue() {
    if (this.closed) return;
    while (this.queue.length > 0 && this.inflight < QUOTA_LIMITS.concurrency) {
      const key = this.queue.shift() as string;
      const generation = this.queuedGenerations.shift() as number;
      if (generation !== this.generation || key !== this.currentKey) {
        this.counters.discarded++;
        continue;
      }
      void this.check("settled");
      break;
    }
  }

  private async query(
    profile: QuotaProfile, auth: QuotaHostAuth | null,
    scope: { organizationId: string | null; projectId: string | null; conflict: boolean },
    origin: string, entry: QuotaEntry, key: string, generation: number,
  ): Promise<void> {
    const impl = ADAPTERS[profile.adapter];
    if (!impl) return;
    const prepared = impl.prepare({ profile, auth, scope });
    if (prepared.kind === "issue") {
      this.finishIssue(entry, prepared.issue);
      return;
    }
    entry.inflight = true;
    this.inflight++;
    this.counters.requests++;
    entry.lifecycle = "loading";
    entry.issue = null;
    this.publishCurrent();
    let result: QuotaTransportResult;
    try {
      result = await quotaFetch(this.fetchLike, prepared.url, prepared.headers, {
        timeoutMs: this.config?.timeoutMs ?? 5_000,
        maxBodyBytes: QUOTA_LIMITS.maxBodyBytes,
        setTimer: this.setTimer,
        clearTimer: this.clearTimer,
      });
    } catch {
      result = { kind: "network", reason: "Error" };
    } finally {
      entry.inflight = false;
      this.inflight = Math.max(0, this.inflight - 1);
    }
    if (this.closed || !this.enabled || generation !== this.generation || key !== this.currentKey) {
      // Late result: neither published nor cached (a late personal response must
      // never touch the team snapshot, and vice versa).
      this.counters.discarded++;
      return;
    }
    const parsed = result.kind === "response"
      ? impl.parse(result.status, result.headers, result.body, { now: this.now() })
      : transportIssue(result);
    if (parsed.kind === "issue") {
      this.finishIssue(entry, parsed.issue);
      return;
    }
    const now = this.now();
    const ttl = this.config?.ttlMs ?? 300_000;
    entry.lastSuccess = Object.freeze({
      ...parsed.snapshot,
      buckets: Object.freeze(parsed.snapshot.buckets.slice(0, QUOTA_LIMITS.maxBuckets)),
      truncated: parsed.snapshot.truncated || parsed.snapshot.buckets.length > QUOTA_LIMITS.maxBuckets,
      origin,
      fetchedAt: now,
      expiresAt: now + ttl,
    });
    entry.lifecycle = "ready";
    entry.issue = null;
    entry.failures = 0;
    this.counters.published++;
    this.publishCurrent();
  }

  private finishIssue(entry: QuotaEntry, raw: QuotaIssue) {
    const now = this.now();
    let retryAt: number | null = null;
    if (raw.retryable) {
      entry.failures++;
      const backoff = Math.min(QUOTA_LIMITS.backoffCapMs, QUOTA_LIMITS.backoffBaseMs * 2 ** (Math.min(entry.failures, 5) - 1));
      retryAt = now + backoff;
      if (raw.retryAt !== null) {
        // Retry-After combines with the local backoff: the longer wait wins, capped.
        retryAt = now + Math.min(Math.max(raw.retryAt - now, backoff), QUOTA_LIMITS.backoffCapMs);
      }
    } else {
      entry.failures = 0;
    }
    entry.issue = { ...raw, retryAt };
    // A failure never rewrites quota values; auth/scope failures additionally hide
    // the old snapshot as currently valid (§10).
    const hides = QUOTA_ISSUE_HIDES_VALUES.includes(entry.issue.code);
    entry.lifecycle = entry.lastSuccess && !hides ? "stale" : "idle";
    this.publishCurrent();
  }

  private entryFor(identity: QuotaIdentity, key: string): QuotaEntry {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key); // LRU refresh.
      this.entries.set(key, existing);
      existing.identity = identity;
      return existing;
    }
    const entry: QuotaEntry = { identity, lifecycle: "idle", issue: null, lastSuccess: null, lastManualAt: 0, failures: 0, inflight: false };
    this.entries.set(key, entry);
    while (this.entries.size > QUOTA_LIMITS.maxIdentities) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.counters.evictions++;
    }
    return entry;
  }

  private publishCurrent() {
    this.onPublish();
  }

  /** Bounded view for the HUD row. `null` when disabled or never enabled. */
  view(): QuotaHudView | null {
    if (!this.enabled || !this.config) return null;
    const status = this.modelStatus;
    if (status.kind === "unconfigured") {
      return { status: "unconfigured", profileId: "", planKey: "", issue: null, stale: false, updatedAt: null, buckets: [], balance: null, truncated: false };
    }
    if (status.kind === "ambiguous") {
      return {
        status: "ambiguous-profile", profileId: "", planKey: "", stale: false, updatedAt: null, buckets: [], balance: null, truncated: false,
        issue: { code: "ambiguous-profile", detail: `${status.count} profiles match the current model` },
      };
    }
    if (status.kind === "unsupported") {
      return {
        status: "issue", profileId: "", planKey: "", stale: false, updatedAt: null, buckets: [], balance: null, truncated: false,
        issue: { code: "unsupported-adapter", detail: `adapter ${status.adapter} is not implemented` },
      };
    }
    const entry = this.currentKey !== null ? this.entries.get(this.currentKey) : undefined;
    if (!entry) return { status: "idle", profileId: "", planKey: "", issue: null, stale: false, updatedAt: null, buckets: [], balance: null, truncated: false };
    const now = this.now();
    const snapshot = entry.lastSuccess;
    const hides = entry.issue !== null && QUOTA_ISSUE_HIDES_VALUES.includes(entry.issue.code);
    const stale = !!snapshot && snapshot.expiresAt <= now;
    let viewStatus: QuotaHudView["status"];
    if (entry.issue) viewStatus = "issue";
    else if (entry.lifecycle === "loading") viewStatus = "loading";
    else if (snapshot) viewStatus = stale ? "stale" : "ready";
    else viewStatus = "idle";
    const issue = entry.issue ? { code: entry.issue.code, detail: entry.issue.detail } : null;
    const buckets: QuotaHudView["buckets"] = [];
    let balance: QuotaHudView["balance"] = null;
    if (snapshot && !hides) {
      // Fixed order: the 5-hour window first, then the weekly window (§9). The tools
      // pool and every further bucket stay in the `/hud quotas` details.
      for (const unit of ["hour", "week"] as const) {
        const bucket = snapshot.buckets.find((item) => item.window?.unit === unit && item.kind !== "tools");
        if (bucket && bucket.remainingPercent !== undefined) {
          buckets.push({ unit, number: bucket.window?.number ?? 0, remainingPercent: bucket.remainingPercent, resetAt: bucket.resetAt });
        }
      }
      // Balance adapters: the row shows only the account-scope total; granted and
      // topped-up parts stay in `/hud quotas` (never re-summed here).
      const items = snapshot.balances ?? [];
      balance = items.find((item) => item.scope === "account") ?? items[0] ?? null;
      if (balance) balance = { amountText: balance.amountText, currency: balance.currency, scope: balance.scope };
    }
    return {
      status: viewStatus,
      profileId: entry.identity.profileId,
      planKey: planKeyFromIdentity(entry.identity),
      issue,
      stale: stale || entry.lifecycle === "stale",
      updatedAt: snapshot?.fetchedAt ?? null,
      buckets,
      balance,
      truncated: snapshot?.truncated ?? false,
    };
  }

  /** Next epoch-ms time the HUD row changes on its own (TTL expiry) for the single
   *  invalidation schedule; `Infinity` when nothing is pending. No idle network. */
  nextExpiry(): number {
    if (!this.enabled) return Infinity;
    const entry = this.currentKey !== null ? this.entries.get(this.currentKey) : undefined;
    return entry?.lastSuccess ? entry.lastSuccess.expiresAt : Infinity;
  }

  /** Bounded diagnostics for `/hud quotas` and `/hud status`. No credentials, no
   *  credential fingerprints, no raw responses. */
  inspect(): Record<string, unknown> {
    const config = this.config;
    const profiles = config?.profiles ?? [];
    const profileViews = profiles.map((profile) => {
      let entry: QuotaEntry | undefined;
      for (const candidate of this.entries.values()) {
        if (candidate.identity.profileId !== profile.id || candidate.identity.providerId !== profile.providerId) continue;
        if (!entry || (candidate.lastSuccess && !entry.lastSuccess)) entry = candidate;
      }
      const snapshot = entry?.lastSuccess ?? null;
      return {
        id: profile.id,
        providerId: profile.providerId,
        adapter: profile.adapter,
        source: profile.source,
        enabled: profile.enabled !== false,
        region: profile.region ?? null,
        plan: profile.plan ?? null,
        queryMode: profile.queryMode ?? null,
        organizationConfigured: profile.organizationId !== undefined,
        projectConfigured: profile.projectId !== undefined,
        origin: profile.origin ?? (ADAPTERS[profile.adapter]?.originFor(profile) ?? ""),
        status: entry
          ? entry.issue ? entry.issue.code : entry.lifecycle
          : this.model && profile.enabled !== false && profile.providerId === this.model.provider &&
              (!profile.modelIds || profile.modelIds.includes(this.model.id))
            ? (this.view()?.status ?? "idle")
            : "idle",
        cache: entry
          ? {
            lifecycle: entry.lifecycle,
            issue: entry.issue
              ? { code: entry.issue.code, detail: entry.issue.detail, retryable: entry.issue.retryable, retryAt: entry.issue.retryAt }
              : null,
            lastSuccess: snapshot
              ? {
                fetchedAt: snapshot.fetchedAt,
                fetchedAtIso: new Date(snapshot.fetchedAt).toISOString(),
                expiresAt: snapshot.expiresAt,
                stale: snapshot.expiresAt <= this.now(),
                planLabel: snapshot.planLabel,
                balances: snapshot.balances
                  ? snapshot.balances.map((item) => ({ amountText: item.amountText, currency: item.currency, scope: item.scope }))
                  : null,
                buckets: snapshot.buckets.map((bucket) => ({
                  id: bucket.id, kind: bucket.kind,
                  window: bucket.window ? `${bucket.window.number}${bucket.window.unit}` : null,
                  limit: bucket.limit ?? null, used: bucket.used ?? null, remaining: bucket.remaining ?? null,
                  usedPercent: bucket.usedPercent ?? null, remainingPercent: bucket.remainingPercent ?? null,
                  resetAt: bucket.resetAt ?? null, resetAtIso: bucket.resetAt ? new Date(bucket.resetAt).toISOString() : null,
                  duplicate: bucket.duplicate === true,
                })),
                truncated: snapshot.truncated,
                ignoredBuckets: snapshot.ignoredBuckets,
                partial: snapshot.partial,
              }
              : null,
          }
          : null,
      };
    });
    const view = this.view();
    return {
      enabled: this.enabled,
      ttlMs: config?.ttlMs ?? null,
      timeoutMs: config?.timeoutMs ?? null,
      profiles: profileViews.length,
      current: this.model ? { provider: this.model.provider, model: this.model.id } : null,
      currentProfileId: view?.profileId || null,
      status: view?.status ?? "disabled",
      reason: view?.issue ? `${view.issue.code}${view.issue.detail ? ` (${view.issue.detail})` : ""}` : null,
      cacheIdentities: this.entries.size,
      tasks: { inflight: this.inflight, queued: this.queue.length },
      counters: { ...this.counters },
      profileList: profileViews,
    };
  }

  dispose() {
    this.closed = true;
    this.cancelTasks();
    this.entries.clear();
  }
}

const transportIssue = (result: QuotaTransportResult): { kind: "issue"; issue: QuotaIssue } => {
  switch (result.kind) {
    case "timeout": return { kind: "issue", issue: { code: "timeout", retryable: true, retryAt: null, detail: "request timeout" } };
    case "redirect": return { kind: "issue", issue: { code: "protocol-error", retryable: false, retryAt: null, detail: `redirect refused (${result.status})` } };
    case "oversized": return { kind: "issue", issue: { code: "protocol-error", retryable: false, retryAt: null, detail: "response body exceeds 256 KiB" } };
    case "network": return { kind: "issue", issue: { code: "network-error", retryable: true, retryAt: null, detail: "network failure" } };
    default: return { kind: "issue", issue: { code: "http-error", retryable: true, retryAt: null, detail: `HTTP ${result.status}` } };
  }
};

const planKeyFromIdentity = (identity: QuotaIdentity): string =>
  identity.plan ? `${identity.adapter}:${identity.plan}` : identity.adapter;
