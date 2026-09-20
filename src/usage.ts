/**
 * Optional full-session usage ledger (phase 3 B2a, contract: docs/SESSION-USAGE-CONTRACT.zh-CN.md).
 *
 * `observed` (the default) keeps the low-cost path in `state.ts`: counters for what this
 * attachment actually saw. `usageScope: "session"` additionally builds this ledger from the
 * current SessionManager's *entire* entry list - all branches, pre-compaction messages,
 * already-reported error/aborted responses and summary records - matching the native
 * footer's four record categories (assistant, toolResult-with-usage, compaction,
 * branch_summary), never the current branch only.
 *
 * Cost model follows the B1 contract exactly:
 * - the four token counters stay separate; cache is never folded into input;
 * - only non-negative finite numbers enter a known subtotal; a missing, negative, NaN or
 *   Infinity value marks that field unknown instead of being silently dropped;
 * - `cost.total` keeps the historically reported price; zero stays an explicit valid zero;
 *   unknown cost renders `?`, partially known renders `<known>+?`;
 * - a toolResult without usage is simply out of the native scope (never an unknown charge);
 * - a compaction/branch_summary without usage keeps the known token subtotals and marks
 *   the cost incomplete; an assistant without usage marks the data incomplete;
 * - saturated sums (MAX_SAFE_INTEGER) set `limited` instead of pretending precision.
 *
 * Acquisition is event-driven and cancelable: a baseline is built from one `getEntries()`
 * snapshot in bounded slices (entries and wall-clock budget, whichever comes first), then
 * normal appends are reconciled at `turn_end`/`agent_settled` by walking
 * `getEntry(id).parentId` from the current leaf back to the committed cursor. An increment
 * is aggregated into temporary scalars and committed only when the anchor is found, so
 * baselines and increments can never overlap or double count. Broken chains, cycles,
 * over-cap deltas and structural changes (tree navigation, compaction) drop uncommitted
 * work and schedule exactly one recovery rebuild; failures never become an idle retry
 * loop. Every task carries the generation and session id it was created for, and a stale
 * task can neither publish nor mutate newer state.
 *
 * All host history access lives inside the marked history boundary below; `scripts/check.mjs`
 * keeps it forbidden everywhere else. Render paths never touch this module's host reads:
 * the terminal only sees the immutable published snapshot.
 */
import type { ClearTimer, SetTimer, TimerHandle } from "./scheduler.ts";
import type { MessageLike, UsageLike } from "./state.ts";

/** Candidate budgets from the B1 contract; B2b measurements may tune them, B2a records them. */
export const LEDGER_LIMITS = Object.freeze({
  /** Baseline slice size: at most this many entries per chunk. */
  chunkEntries: 512,
  /** Baseline slice wall-clock budget in milliseconds; the first limit reached yields. */
  chunkBudgetMs: 2,
  /** Hard cap on one incremental reconciliation walk (and baseline catch-up). */
  incrementCap: 2048,
  maxTotal: Number.MAX_SAFE_INTEGER,
});

export type SessionUsageStatus = "loading" | "ready" | "partial" | "unavailable";

/**
 * Immutable published view for rendering and diagnostics. `null` from the controller when
 * the ledger is inactive or the host API is unavailable (the explicit degradation to the
 * observed-labelled data); `status: "loading"` renders unknown values.
 */
export interface SessionUsageView {
  status: SessionUsageStatus;
  /** True while appended-but-not-yet-reconciled records exist or a rebuild is running. */
  updating: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** At least one record reported a valid cost.total. */
  costKnown: boolean;
  /** At least one in-scope record's cost is unknown (missing usage, invalid cost, ...). */
  costMissing: boolean;
  usageRecords: number;
  /** Entries examined for the published totals (baseline + committed increments). */
  examined: number;
  missingInput: number;
  missingOutput: number;
  missingCacheRead: number;
  missingCacheWrite: number;
  /** Assistant records without (valid) usage: the data is incomplete, not zero spend. */
  assistantMissingUsage: number;
  /** compaction/branch_summary records without usage: cost incomplete, tokens kept. */
  summaryMissingUsage: number;
  /** A token or cost sum saturated at MAX_SAFE_INTEGER. */
  limited: boolean;
  /** Any incompleteness besides saturation: renders the `+?` marker. */
  fieldsIncomplete: boolean;
}

/** Structural read-only session-manager surface (Pi `ReadonlySessionManager` subset). */
export interface SessionManagerLike {
  getSessionId?(): string;
  getEntries?(): unknown[];
  getEntry?(id: string): unknown;
  getLeafId?(): string | null;
}

/** Structural entry shape; every field is validated before use. */
export interface SessionEntryLike {
  type?: unknown;
  parentId?: unknown;
  message?: MessageLike;
  usage?: UsageLike;
}

interface LedgerApi {
  getEntries(): unknown[];
  getEntry(id: string): unknown;
  getLeafId(): string | null;
  getSessionId(): string | null;
}

/** Bounded scalar totals. `examined` counts entries inspected for these totals. */
interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  usageRecords: number;
  costKnown: number;
  costMissing: number;
  missingInput: number;
  missingOutput: number;
  missingCacheRead: number;
  missingCacheWrite: number;
  assistantMissingUsage: number;
  summaryMissingUsage: number;
  examined: number;
  limited: boolean;
}

interface BaselineWork {
  kind: "baseline";
  generation: number;
  sessionId: string | null;
  entries: readonly SessionEntryLike[] | null;
  index: number;
  totals: SessionTotals;
  leaf: string | null;
  startedAt: number;
  chunkMs: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
type TokenField = "input" | "output" | "cacheRead" | "cacheWrite";
type MissingKey = "missingInput" | "missingOutput" | "missingCacheRead" | "missingCacheWrite";
/** Non-negative finite numbers only; everything else is an unknown field value. */
const counter = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const add = (totals: SessionTotals, key: "input" | "output" | "cacheRead" | "cacheWrite" | "cost", value: number): void => {
  const sum = totals[key] + value;
  if (sum > LEDGER_LIMITS.maxTotal) {
    totals[key] = LEDGER_LIMITS.maxTotal;
    totals.limited = true;
  } else totals[key] = sum;
};

function newTotals(): SessionTotals {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    usageRecords: 0, costKnown: 0, costMissing: 0,
    missingInput: 0, missingOutput: 0, missingCacheRead: 0, missingCacheWrite: 0,
    assistantMissingUsage: 0, summaryMissingUsage: 0,
    examined: 0, limited: false,
  };
}

function fieldsIncomplete(totals: SessionTotals): boolean {
  return totals.missingInput > 0 || totals.missingOutput > 0 || totals.missingCacheRead > 0 ||
    totals.missingCacheWrite > 0 || totals.assistantMissingUsage > 0 || totals.summaryMissingUsage > 0 ||
    totals.costMissing > 0;
}

/**
 * Fold one usage object into the totals under the B1 value rules. Called only for records
 * that are in the native scope (assistant always, toolResult only when it carries usage,
 * compaction/branch_summary only when they carry usage).
 */
function accumulateUsage(usage: UsageLike, totals: SessionTotals): void {
  const tokenFields: [TokenField, MissingKey][] = [
    ["input", "missingInput"], ["output", "missingOutput"],
    ["cacheRead", "missingCacheRead"], ["cacheWrite", "missingCacheWrite"],
  ];
  for (const [field, missing] of tokenFields) {
    const value = counter(usage[field]);
    if (value === null) totals[missing]++;
    else add(totals, field, value);
  }
  totals.usageRecords++;
  const costTotal = object(usage.cost) ? counter(usage.cost.total) : null;
  if (costTotal === null) totals.costMissing++;
  else { totals.costKnown++; add(totals, "cost", costTotal); }
}

/**
 * Aggregate one session entry under the native footer's four-category rule, extended with
 * the B1 missing-data semantics. Returns whether the entry was in scope at all.
 */
export function aggregateEntry(entry: SessionEntryLike | undefined | null, totals: SessionTotals): boolean {
  if (!object(entry)) { totals.examined++; return false; }
  const type = entry.type;
  if (type === "message") {
    const message = entry.message;
    if (!object(message)) { totals.examined++; return false; }
    const role = message.role;
    if (role !== "assistant" && role !== "toolResult") { totals.examined++; return false; }
    totals.examined++;
    const usage = message.usage;
    if (!object(usage)) {
      // A toolResult without usage is simply out of the native scope - not an unknown
      // charge. An assistant without usage is in scope with incomplete data.
      if (role === "assistant") { totals.assistantMissingUsage++; totals.costMissing++; }
      return role === "assistant";
    }
    accumulateUsage(usage, totals);
    return true;
  }
  if (type === "compaction" || type === "branch_summary") {
    totals.examined++;
    const usage = entry.usage;
    if (!object(usage)) {
      // Summary records without usage keep the known token subtotals, mark the cost
      // incomplete and are counted in diagnostics; never guessed into a charge.
      totals.summaryMissingUsage++;
      totals.costMissing++;
      return true;
    }
    accumulateUsage(usage, totals);
    return true;
  }
  totals.examined++;
  return false;
}

export interface SessionLedgerOptions {
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  monotonic?: () => number;
  chunkEntries?: number;
  chunkBudgetMs?: number;
  incrementCap?: number;
  /** Notified after every published snapshot change so the UI can refresh. */
  onPublish?: () => void;
}

/**
 * The session usage ledger. One planned task and at most one active task exist at any
 * time; every entry callback only flips scalars and schedules work, it never walks
 * history synchronously.
 */
export class SessionUsageLedger {
  declare options: SessionLedgerOptions;
  declare setTimer: SetTimer;
  declare clearTimer: ClearTimer;
  declare monotonic: () => number;
  declare chunkEntries: number;
  declare chunkBudgetMs: number;
  declare incrementCap: number;
  declare onPublish: () => void;
  declare manager: SessionManagerLike | null;
  declare api: LedgerApi | null;
  declare active: boolean;
  declare status: SessionUsageStatus | "inactive";
  declare sessionId: string | null;
  declare generation: number;
  declare planned: "baseline" | "verify" | null;
  declare work: BaselineWork | null;
  declare timer: TimerHandle | null;
  declare published: SessionTotals | null;
  declare publishedStatus: "ready" | "partial";
  declare cursor: string | null;
  /** True when entries exist that the ledger could not fold in (catch-up/walk failure). */
  declare coverageGap: boolean;
  declare updating: boolean;
  declare pendingSinceCommit: number;
  declare rebuilds: number;
  declare recoveries: number;
  declare lastRebuildReason: string | null;
  declare failureReason: string | null;
  declare readErrors: number;
  declare getEntriesCalls: number;
  declare getEntryCalls: number;
  declare getLeafIdCalls: number;
  declare examinedTotal: number;
  declare lastBaselineMs: number;
  declare maxChunkMs: number;
  declare maxIncrementMs: number;
  declare peakPending: number;

  constructor(options: SessionLedgerOptions = {}) {
    this.options = options;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? (clearTimeout as unknown as ClearTimer);
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.chunkEntries = Math.max(1, options.chunkEntries ?? LEDGER_LIMITS.chunkEntries);
    this.chunkBudgetMs = Math.max(0.05, options.chunkBudgetMs ?? LEDGER_LIMITS.chunkBudgetMs);
    this.incrementCap = Math.max(1, options.incrementCap ?? LEDGER_LIMITS.incrementCap);
    this.onPublish = options.onPublish ?? (() => {});
    this.manager = null;
    this.api = null;
    this.active = false;
    this.status = "inactive";
    this.sessionId = null;
    this.generation = 0;
    this.planned = null;
    this.work = null;
    this.timer = null;
    this.published = null;
    this.publishedStatus = "ready";
    this.cursor = null;
    this.coverageGap = false;
    this.updating = false;
    this.pendingSinceCommit = 0;
    this.rebuilds = 0;
    this.recoveries = 0;
    this.lastRebuildReason = null;
    this.failureReason = null;
    this.readErrors = 0;
    this.getEntriesCalls = 0;
    this.getEntryCalls = 0;
    this.getLeafIdCalls = 0;
    this.examinedTotal = 0;
    this.lastBaselineMs = 0;
    this.maxChunkMs = 0;
    this.maxIncrementMs = 0;
    this.peakPending = 0;
  }

  /* history-boundary:start */
  // The only place in the package that may call the host's read-only session-manager
  // entry APIs. `scripts/check.mjs` enforces this boundary; getContextUsage/getBranch
  // remain forbidden everywhere, including here.
  private captureApi(manager: SessionManagerLike | null | undefined): LedgerApi | null {
    if (!object(manager)) return null;
    try {
      const getEntries = manager.getEntries;
      const getEntry = manager.getEntry;
      const getLeafId = manager.getLeafId;
      const getSessionId = manager.getSessionId;
      if (typeof getEntries !== "function" || typeof getEntry !== "function" || typeof getLeafId !== "function") return null;
      return {
        getEntries: getEntries.bind(manager) as () => unknown[],
        getEntry: getEntry.bind(manager) as (id: string) => unknown,
        getLeafId: getLeafId.bind(manager) as () => string | null,
        getSessionId: typeof getSessionId === "function"
          ? (() => { try { const id = (getSessionId as () => unknown).call(manager); return typeof id === "string" ? id : null; } catch { this.readErrors++; return null; } })
          : (() => null),
      };
    } catch { this.readErrors++; return null; }
  }

  private readEntries(): readonly SessionEntryLike[] | null {
    if (!this.api) return null;
    try {
      this.getEntriesCalls++;
      const entries = this.api.getEntries();
      return Array.isArray(entries) ? (entries as readonly SessionEntryLike[]) : null;
    } catch { this.readErrors++; return null; }
  }

  private readLeaf(): string | null {
    if (!this.api) return null;
    try {
      this.getLeafIdCalls++;
      const leaf = this.api.getLeafId();
      return typeof leaf === "string" ? leaf : null;
    } catch { this.readErrors++; return null; }
  }

  private readEntry(id: string): SessionEntryLike | undefined {
    if (!this.api) return undefined;
    try {
      this.getEntryCalls++;
      const entry = this.api.getEntry(id);
      return object(entry) ? (entry as SessionEntryLike) : undefined;
    } catch { this.readErrors++; return undefined; }
  }

  private readSessionId(): string | null {
    if (!this.api) return null;
    try { return this.api.getSessionId(); } catch { this.readErrors++; return null; }
  }
  /* history-boundary:end */

  /**
   * (Re)build from scratch: a new session, scope entry, or re-enable. Discards every
   * in-flight task, cursor and snapshot, then schedules one cancelable baseline. Never
   * continues an incremental series across a gap.
   */
  restart(manager: SessionManagerLike | null | undefined, reason: string): void {
    this.generation++;
    this.work = null;
    this.planned = null;
    this.cancelTimer();
    this.manager = manager ?? null;
    this.api = this.captureApi(this.manager);
    this.sessionId = this.readSessionId();
    this.published = null;
    this.publishedStatus = "ready";
    this.cursor = null;
    this.coverageGap = false;
    this.updating = false;
    this.pendingSinceCommit = 0;
    this.failureReason = null;
    this.active = true;
    if (!this.api) {
      this.status = "unavailable";
      this.failureReason = "session manager does not expose the read-only entry surface";
      this.onPublish();
      return;
    }
    this.status = "loading";
    this.planBaseline(reason);
    this.onPublish();
  }

  /** Off, scope exit, shutdown or dispose: cancel tasks and release all references. */
  deactivate(): void {
    this.generation++;
    this.active = false;
    this.planned = null;
    this.work = null;
    this.cancelTimer();
    this.manager = null;
    this.api = null;
    this.sessionId = null;
    this.published = null;
    this.cursor = null;
    this.coverageGap = false;
    this.updating = false;
    this.pendingSinceCommit = 0;
    this.status = "inactive";
    this.failureReason = null;
  }

  dispose(): void { this.deactivate(); }

  /**
   * Structural boundary (tree navigation, compaction): abandon in-flight work and merge
   * into exactly one fresh rebuild. The old snapshot stays visible, explicitly marked
   * updating, until the rebuild replaces it.
   */
  onStructural(reason: "tree" | "compact"): void {
    if (!this.active) return;
    this.generation++;
    this.work = null;
    if (this.status === "unavailable") {
      // The host API may have appeared (or the failure was transient); retry once via
      // this lifecycle event, never on a timer.
      this.api = this.captureApi(this.manager);
      this.sessionId = this.readSessionId();
      if (!this.api) { this.failureReason = "session manager does not expose the read-only entry surface"; return; }
    }
    this.status = this.published ? this.publishedStatus : "loading";
    this.updating = true;
    this.planBaseline(reason);
    this.onPublish();
  }

  /**
   * `message_end` only marks pending work; it never adds event usage to this ledger.
   * Returns whether the published view changed (so the caller can repaint for the
   * updating marker even when the observed counters did not change).
   */
  onMessageEnd(): boolean {
    if (!this.active || this.status === "unavailable") return false;
    this.updating = true;
    this.pendingSinceCommit++;
    this.peakPending = Math.max(this.peakPending, this.pendingSinceCommit);
    return true;
  }

  /**
   * Schedule one incremental reconciliation (`turn_end`, `agent_settled`, `/hud reset`).
   * Subsumed by a pending/active baseline; duplicate notifications coalesce into the same
   * single planned task.
   */
  requestVerify(): void {
    if (!this.active || this.status === "unavailable") return;
    if (this.work || this.planned === "baseline" || !this.published) return;
    this.planned = "verify";
    this.ensureTimer();
  }

  /** True while a baseline or verification task is planned or active. */
  busy(): boolean { return this.work !== null || this.planned !== null; }

  /** Immutable rendering/diagnostic view; null means "degrade to observed labels". */
  view(): SessionUsageView | null {
    if (!this.active || this.status === "unavailable") return null;
    if (!this.published) {
      return {
        status: "loading", updating: false,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
        costKnown: false, costMissing: false, usageRecords: 0, examined: 0,
        missingInput: 0, missingOutput: 0, missingCacheRead: 0, missingCacheWrite: 0,
        assistantMissingUsage: 0, summaryMissingUsage: 0, limited: false, fieldsIncomplete: false,
      };
    }
    const t = this.published;
    return {
      status: this.publishedStatus,
      updating: this.updating,
      input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, cost: t.cost,
      costKnown: t.costKnown > 0, costMissing: t.costMissing > 0,
      usageRecords: t.usageRecords, examined: t.examined,
      missingInput: t.missingInput, missingOutput: t.missingOutput,
      missingCacheRead: t.missingCacheRead, missingCacheWrite: t.missingCacheWrite,
      assistantMissingUsage: t.assistantMissingUsage, summaryMissingUsage: t.summaryMissingUsage,
      limited: t.limited, fieldsIncomplete: fieldsIncomplete(t) || this.coverageGap,
    };
  }

  /** Bounded scalar diagnostics for `/hud status`; no message text or summaries. */
  inspect() {
    return {
      scope: this.active ? "session" : "observed",
      status: this.status,
      updating: this.updating,
      sessionId: this.sessionId,
      cursor: this.cursor,
      rebuilds: this.rebuilds,
      recoveryRebuilds: this.recoveries,
      lastRebuildReason: this.lastRebuildReason,
      failureReason: this.failureReason,
      examinedEntries: this.examinedTotal,
      publishedEntries: this.published?.examined ?? 0,
      usageRecords: this.published?.usageRecords ?? 0,
      missingFields: this.published ? {
        input: this.published.missingInput, output: this.published.missingOutput,
        cacheRead: this.published.missingCacheRead, cacheWrite: this.published.missingCacheWrite,
        cost: this.published.costMissing,
      } : null,
      assistantMissingUsage: this.published?.assistantMissingUsage ?? 0,
      summaryMissingUsage: this.published?.summaryMissingUsage ?? 0,
      limited: this.published?.limited ?? false,
      coverageGap: this.coverageGap,
      lastBaselineMs: this.lastBaselineMs,
      maxChunkMs: this.maxChunkMs,
      maxIncrementMs: this.maxIncrementMs,
      peakPending: this.peakPending,
      busy: this.busy(),
      budget: { chunkEntries: this.chunkEntries, chunkBudgetMs: this.chunkBudgetMs, incrementCap: this.incrementCap },
      hostCalls: { getEntries: this.getEntriesCalls, getEntry: this.getEntryCalls, getLeafId: this.getLeafIdCalls },
      readErrors: this.readErrors,
    };
  }

  // -----------------------------------------------------------------------
  // Task queue: one planned + one active task, driven only by one-shot timers.
  // -----------------------------------------------------------------------

  private planBaseline(reason: string): void {
    this.rebuilds++;
    this.lastRebuildReason = reason;
    if (this.planned !== "baseline") this.planned = "baseline";
    this.ensureTimer();
  }

  private planRecovery(reason: string): void {
    this.recoveries++;
    this.planBaseline(reason);
  }

  private ensureTimer(): void {
    if (this.timer !== null || !this.active) return;
    this.timer = this.setTimer(() => { this.timer = null; this.tick(); }, 0);
    this.timer?.unref?.();
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.active) return;
    try {
      if (this.work) {
        if (this.work.generation !== this.generation) { this.work = null; }
        else { this.runBaselineChunk(); if (this.work) { this.ensureTimer(); return; } }
      }
      if (!this.work && this.planned) {
        const kind = this.planned;
        this.planned = null;
        if (kind === "baseline") {
          const work = this.captureBaseline();
          if (!work) return; // unavailable; recorded, no timer rescheduled
          this.work = work;
          this.runBaselineChunk();
          if (this.work) { this.ensureTimer(); return; }
        } else {
          this.runVerify();
        }
      }
      if (this.planned) this.ensureTimer();
    } catch {
      // A ledger bug or a hostile host surface must degrade, never throw into a timer.
      this.readErrors++;
      this.status = "unavailable";
      this.failureReason = "ledger task failed";
      this.work = null;
      this.planned = null;
      this.cancelTimer();
      this.onPublish();
    }
  }

  /**
   * Capture phase: one synchronous block confirms identity, calls `getEntries()` once and
   * fixes the baseline cursor. The returned shallow array is released as soon as the
   * baseline completes, is cancelled or goes stale.
   */
  private captureBaseline(): BaselineWork | null {
    const generation = this.generation;
    const sessionId = this.sessionId;
    const entries = this.readEntries();
    if (entries === null) {
      this.status = "unavailable";
      this.failureReason = "getEntries failed or returned a non-array";
      this.updating = false;
      this.onPublish();
      return null;
    }
    return {
      kind: "baseline", generation, sessionId,
      entries, index: 0, totals: newTotals(),
      leaf: this.readLeaf(), startedAt: this.monotonic(), chunkMs: 0,
    };
  }

  private runBaselineChunk(): void {
    const work = this.work!;
    const entries = work.entries!;
    const deadline = this.monotonic() + this.chunkBudgetMs;
    let processed = 0;
    while (work.index < entries.length) {
      aggregateEntry(entries[work.index], work.totals);
      work.index++;
      processed++;
      if (processed >= this.chunkEntries || this.monotonic() >= deadline) break;
    }
    work.chunkMs = Math.max(work.chunkMs, this.monotonic() - (deadline - this.chunkBudgetMs));
    if (work.index < entries.length) return; // more slices in later ticks
    this.finishBaseline(work);
  }

  private finishBaseline(work: BaselineWork): void {
    this.work = null;
    work.entries = null; // release the O(N) reference before anything can fail
    if (work.generation !== this.generation) return; // a newer task owns the session now
    const count = work.totals.examined;
    let cursor = work.leaf;
    this.coverageGap = false; // a fresh full read re-covers everything unless it fails below
    const leafNow = this.readLeaf();
    if (leafNow !== work.leaf) {
      // Catch up appends that happened while the baseline was slicing. Bounded by the
      // same cap; on failure the totals stay valid up to the captured leaf and the gap
      // is recorded, never silently counted.
      const started = this.monotonic();
      const walk = this.walkChain(leafNow, work.leaf);
      this.maxIncrementMs = Math.max(this.maxIncrementMs, this.monotonic() - started);
      if (walk.ok) { for (const entry of walk.chain) aggregateEntry(entry, work.totals); cursor = leafNow; }
      else {
        this.failureReason = `catchup:${walk.reason}`;
        this.coverageGap = true;
        cursor = work.leaf;
        // The catch-up failure also swallowed any requestVerify() that arrived while
        // this baseline was slicing, so arrange exactly one recovery rebuild: a fresh
        // getEntries() covers the gap without a walk. To keep a pathological append
        // stream from self-perpetuating timer chains, a baseline that was itself a
        // catch-up recovery does not schedule another one: the gap stays recorded and
        // the next event boundary (turn_end/settled) retries through the verify path.
        if (!this.lastRebuildReason?.startsWith("catchup:")) this.planRecovery(`catchup:${walk.reason}`);
      }
    }
    // A null leaf with non-empty history is Pi's documented state after navigating to
    // re-edit the first user message (`resetLeaf()`): the next append creates a new root
    // entry with parentId null. The null cursor is therefore a legal anchor - a verify
    // walk from a later root-level leaf commits only entries appended after the reset,
    // never the already-counted history.
    if (work.generation !== this.generation || this.readSessionId() !== work.sessionId) return;
    // A full read that re-covered everything supersedes the previous failure record;
    // a catch-up that failed again keeps its reason alongside the coverage gap.
    if (!this.coverageGap) this.failureReason = null;
    this.published = work.totals;
    this.publishedStatus = fieldsIncomplete(work.totals) || work.totals.limited || this.coverageGap ? "partial" : "ready";
    this.status = this.publishedStatus;
    this.cursor = cursor;
    this.updating = false;
    this.pendingSinceCommit = 0;
    this.examinedTotal += count;
    this.lastBaselineMs = this.monotonic() - work.startedAt;
    this.maxChunkMs = Math.max(this.maxChunkMs, work.chunkMs);
    this.onPublish();
    if (this.planned) this.ensureTimer();
  }

  /**
   * Incremental reconciliation: aggregate the not-yet-committed chain into temporary
   * totals and commit only when the committed cursor anchors the walk. Any anomaly drops
   * the whole batch (nothing partial is committed) and schedules one recovery rebuild.
   */
  private runVerify(): void {
    if (!this.published) return;
    const started = this.monotonic();
    const leaf = this.readLeaf();
    if (leaf === null && this.cursor === null) { this.commitIdle(); return; }
    const walk = this.walkChain(leaf, this.cursor);
    this.maxIncrementMs = Math.max(this.maxIncrementMs, this.monotonic() - started);
    if (!walk.ok) {
      // Drop the uncommitted increment, mark partial, and arrange exactly one full
      // recovery rebuild. No idle retry loop: the next attempt is another event.
      this.failureReason = `verify:${walk.reason}`;
      this.publishedStatus = "partial";
      this.status = "partial";
      this.planRecovery(`recovery:${walk.reason}`);
      this.onPublish();
      return;
    }
    if (walk.chain.length) {
      const temp = newTotals();
      for (const entry of walk.chain) aggregateEntry(entry, temp);
      // Commit only now, after the anchor was found: the whole batch or nothing.
      this.addTotals(this.published, temp);
      this.published.examined += temp.examined;
      this.examinedTotal += temp.examined;
      this.cursor = leaf;
      // The anchored walk covered exactly the segment a previous catch-up or verify
      // failure could not reach, so the coverage gap is confirmed healed here - not on
      // a timer. Genuine field incompleteness and saturation are re-evaluated in
      // commitIdle and keep their partial mark; only the coverage failure is cleared.
      this.coverageGap = false;
      this.failureReason = null;
      this.commitIdle(true);
      return;
    }
    this.commitIdle();
  }

  private addTotals(target: SessionTotals, delta: SessionTotals): void {
    const sums: ["input" | "output" | "cacheRead" | "cacheWrite" | "cost", number][] = [
      ["input", delta.input], ["output", delta.output], ["cacheRead", delta.cacheRead],
      ["cacheWrite", delta.cacheWrite], ["cost", delta.cost],
    ];
    for (const [key, value] of sums) add(target, key, value);
    target.usageRecords += delta.usageRecords;
    target.costKnown += delta.costKnown;
    target.costMissing += delta.costMissing;
    target.missingInput += delta.missingInput;
    target.missingOutput += delta.missingOutput;
    target.missingCacheRead += delta.missingCacheRead;
    target.missingCacheWrite += delta.missingCacheWrite;
    target.assistantMissingUsage += delta.assistantMissingUsage;
    target.summaryMissingUsage += delta.summaryMissingUsage;
    // Saturation flag from either side persists; a committed increment can undo neither.
    target.limited = target.limited || delta.limited;
  }

  private commitIdle(healed = false): void {
    // `healed` marks the case where a previously failed coverage segment was just
    // committed: the publication must go out even when nothing was pending, so a
    // long-stuck partial snapshot visibly returns to ready.
    const had = this.updating || this.pendingSinceCommit > 0 || healed;
    this.updating = false;
    this.pendingSinceCommit = 0;
    this.publishedStatus = fieldsIncomplete(this.published!) || this.published!.limited || this.coverageGap ? "partial" : "ready";
    this.status = this.publishedStatus;
    if (had) this.onPublish();
  }

  /**
   * Walk the parent chain from `leaf` back to the committed `anchor` (a null anchor is the
   * root, legal only for an empty baseline). Bounded by `incrementCap`; a missing entry,
   * malformed parent, cycle, over-cap chain or a root reached without the anchor fails
   * the whole batch.
   */
  private walkChain(leaf: string | null, anchor: string | null): { ok: true; chain: SessionEntryLike[] } | { ok: false; reason: string } {
    const chain: SessionEntryLike[] = [];
    let id: string | null = leaf;
    while (true) {
      if (id === anchor) return { ok: true, chain };
      if (id === null) return { ok: false, reason: "root-without-anchor" };
      if (chain.length >= this.incrementCap) return { ok: false, reason: "cap-exceeded" };
      const entry = this.readEntry(id);
      if (!entry) return { ok: false, reason: `missing-entry:${id.slice(0, 12)}` };
      chain.push(entry);
      const parent = entry.parentId;
      if (typeof parent === "string") { if (parent === id) return { ok: false, reason: "cycle" }; id = parent; continue; }
      if (parent === null || parent === undefined) { id = null; continue; }
      return { ok: false, reason: "malformed-parent" };
    }
  }
}
