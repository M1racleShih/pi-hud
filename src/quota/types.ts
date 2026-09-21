/**
 * Provider quota types: identities, normalized buckets, and the state model
 * (docs/PROVIDER-LIMITS-PLAN.zh-CN.md §4/§10, docs/GLM-PLAN-SCOPES.zh-CN.md §9).
 *
 * The state model deliberately separates three concerns that must never collapse
 * into one enum:
 * - `lifecycle` describes the data (idle/loading/ready/stale);
 * - `issue` is the optional structured failure (code, retryability, earliest retry);
 * - `lastSuccess` keeps the last successful snapshot with its own timestamp, so a
 *   failed refresh never rewrites quota values to zero and 401/403 can hide the old
 *   value as "currently valid" without destroying the history.
 *
 * All exported structures are data-only: no I/O, no credentials. A credential
 * fingerprint may be part of an in-memory cache key (`QuotaIdentity.credentialTag`)
 * but must never be rendered or logged.
 */

/** Data lifecycle of one quota identity, independent of any issue. */
export type QuotaLifecycle = "idle" | "loading" | "ready" | "stale";

/** User-visible issue codes; the plan's state names stay stable across adapters. */
export type QuotaIssueCode =
  | "unconfigured"
  | "ambiguous-profile"
  | "unsupported-adapter"
  | "needs-verification"
  | "needs-auth"
  | "needs-scope"
  | "scope-conflict"
  | "rate-limited"
  | "forbidden"
  | "http-error"
  | "timeout"
  | "network-error"
  | "protocol-error"
  | "business-error"
  | "no-data";

/** Structured, redacted failure. `detail` carries only bounded sanitized text
 *  (for example "HTTP 503"), never tokens, headers, or response bodies. */
export interface QuotaIssue {
  code: QuotaIssueCode;
  retryable: boolean;
  /** Earliest epoch-ms time a new query may be attempted (backoff / Retry-After). */
  retryAt: number | null;
  detail: string;
}

/** How the current quota row should be presented on the HUD. */
export type QuotaStatus =
  | "unconfigured"
  | "ambiguous-profile"
  | "idle"
  | "loading"
  | "ready"
  | "stale"
  | "issue";

/** Metering semantics of one bucket, decided per adapter from verified responses. */
export type QuotaMeterKind = "quota-percent" | "credits" | "tools";

export type QuotaWindowUnit = "hour" | "week" | "month";

/** Verified window of one bucket (GLM: unit 3=hour, 6=week, 5=month). */
export interface QuotaWindow {
  unit: QuotaWindowUnit;
  number: number;
}

/**
 * One normalized quota bucket. All quantities are optional: a missing field is
 * unknown, zero is a legal value, and no field is ever recomputed to satisfy an
 * arithmetic relation (the GLM team fixture's remaining 876 stays 876).
 */
export interface QuotaBucket {
  id: string;
  kind: QuotaMeterKind;
  /** `null` keeps a bucket whose unit/number combination was not verified. */
  window: QuotaWindow | null;
  limit?: number;
  used?: number;
  remaining?: number;
  /** Server-provided used percentage (0-100). */
  usedPercent?: number;
  /** Derived display complement of `usedPercent`; never used to recompute values. */
  remainingPercent?: number;
  /** Epoch-ms reset time; absent when the server value is missing or invalid. */
  resetAt?: number;
  /** A second bucket with the same type/unit/number shape; kept, never merged. */
  duplicate?: boolean;
}

/** A future balance item (API adapters); amounts keep their server currency. */
export interface QuotaBalanceItem {
  amountText: string;
  currency: string;
  scope: string;
}

/** Adapter-normalized success data; the service stamps local times. */
export interface QuotaSnapshotData {
  buckets: readonly QuotaBucket[];
  /** Server-provided plan level label (already sanitized), when present. */
  planLabel: string;
  /** Buckets ignored because of an unknown metering type. */
  ignoredBuckets: number;
  truncated: boolean;
  partial: boolean;
  /** Optional balance items (unused by the GLM slice). */
  balances?: readonly QuotaBalanceItem[];
}

/** A published success snapshot with local timing. */
export interface QuotaSnapshot extends QuotaSnapshotData {
  origin: string;
  fetchedAt: number;
  expiresAt: number;
}

/** Cache identity of one queryable account scope. The credential tag is an opaque
 *  in-memory fingerprint: a credential change invalidates cache entries without the
 *  raw key ever being stored, displayed, or logged. */
export interface QuotaIdentity {
  profileId: string;
  providerId: string;
  adapter: string;
  plan: string;
  queryMode: string;
  origin: string;
  organizationId: string | null;
  projectId: string | null;
  credentialTag: string;
}

export const quotaIdentityKey = (identity: QuotaIdentity): string =>
  `${identity.profileId}\\u0000${identity.providerId}\\u0000${identity.origin}\\u0000${identity.plan}\\u0000` +
  `${identity.queryMode}\\u0000${identity.organizationId ?? ""}\\u0000${identity.projectId ?? ""}\\u0000${identity.credentialTag}`;

/** Host-resolved request auth for the current model (Pi `ResolvedRequestAuth` shape). */
export interface QuotaHostAuth {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
}

/** Minimal response header surface used by transport and adapters. */
export interface QuotaHeadersLike {
  get(name: string): string | null;
}

/** Issue codes whose presence must hide old values as "currently valid" (§10). */
export const QUOTA_ISSUE_HIDES_VALUES: readonly QuotaIssueCode[] = Object.freeze([
  "needs-auth", "forbidden", "needs-scope", "scope-conflict",
]);
