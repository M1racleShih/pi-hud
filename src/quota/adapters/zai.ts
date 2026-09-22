/**
 * Z.ai / BigModel GLM plan adapter — first implemented slice
 * (docs/GLM-PLAN-SCOPES.zh-CN.md §9 implementation contract).
 *
 * Only the two account-verified domestic query modes are implemented:
 * - `personal-legacy`: no `type` parameter, raw `Authorization`, no organization or
 *   project headers (the request shape verified against the personal console);
 * - `team`: `type=2` plus the `bigmodel-organization`/`bigmodel-project` scope
 *   headers bound to this profile (verified against the team "my usage" console).
 *
 * The unverified candidate — `region: "global"` — is configuration-diagnostic
 * only: it is refused with `needs-verification` and never sends a request. The
 * type=1 `personal` query mode was dropped from scope (owner decision
 * 2026-09-22) and is rejected at config load, so it never reaches the adapter.
 * Team failures never fall back to a personal query, and no `type` values are
 * ever probed.
 *
 * Response normalization follows the §9 mapping table exactly:
 * `TOKENS_LIMIT` is a percentage (never a token count); unit 3/6/5 maps to
 * hour/week/month (unknown combinations keep an unknown window); `remaining` is
 * the server value as-is (the synthetic 876/877 trap must stay 876);
 * `remainingPercent` is only the display complement of the server percentage;
 * `nextResetTime` is epoch milliseconds.
 */
import { safeText } from "../../text.ts";
import type { QuotaProfile } from "../../config.ts";
import type {
  QuotaBucket, QuotaHeadersLike, QuotaHostAuth, QuotaIssue, QuotaMeterKind, QuotaSnapshotData, QuotaWindow, QuotaWindowUnit,
} from "../types.ts";
import { adapterIssue, httpStatusIssue, isObject, parseJsonPayload } from "./http.ts";

export { parseRetryAfter } from "./http.ts";

/** Verified domestic origin. The international site is a separate, unverified scope. */
export const ZAI_QUOTA_ORIGIN = "https://open.bigmodel.cn";
/** Fixed query path; never built from a model baseUrl. */
export const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";
/** Origins accepted per region. `global` is listed for configuration diagnostics only. */
export const ZAI_ORIGINS: Readonly<Record<string, string>> = Object.freeze({ cn: ZAI_QUOTA_ORIGIN, global: "https://api.z.ai" });

export interface ZaiPrepareInput {
  profile: QuotaProfile;
  auth: QuotaHostAuth | null;
  scope: { organizationId: string | null; projectId: string | null; conflict: boolean };
}

export type ZaiPrepareResult =
  | { kind: "request"; url: string; headers: Record<string, string> }
  | { kind: "issue"; issue: QuotaIssue };

export interface ZaiParseContext {
  now: number;
}

export type ZaiParseResult =
  | { kind: "snapshot"; snapshot: QuotaSnapshotData }
  | { kind: "issue"; issue: QuotaIssue };

// Shared constructor from ./http.ts (bounded sanitized detail); the alias keeps the
// call sites below reading as adapter-local decisions.
const issue = adapterIssue;

/** Build the verified request, or refuse with a structured issue before any network. */
export function zaiPrepare(input: ZaiPrepareInput): ZaiPrepareResult {
  const { profile, auth, scope } = input;
  const region = profile.region ?? "cn";
  const origin = ZAI_ORIGINS[region] ?? ZAI_QUOTA_ORIGIN;
  if (profile.origin && profile.origin !== origin) {
    return issue("needs-verification", false, "profile origin does not match the adapter origin table");
  }
  if (region !== "cn") {
    // The international site has its own, unverified contract.
    return issue("needs-verification", false, "region global is not verified for the GLM quota API");
  }
  const queryMode = profile.queryMode ?? "";
  if (scope.conflict) {
    return issue("scope-conflict", false, "profile scope disagrees with host-resolved headers");
  }
  const apiKey = auth?.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return issue("needs-auth", false, "no api key resolved for the current provider");
  }
  const headers: Record<string, string> = { Accept: "application/json", Authorization: apiKey };
  if (queryMode === "team") {
    if (!scope.organizationId || !scope.projectId) {
      return issue("needs-scope", false, "team mode requires organization and project");
    }
    // The verified team shape: type=2 plus both scope headers, raw Authorization.
    headers["bigmodel-organization"] = scope.organizationId;
    headers["bigmodel-project"] = scope.projectId;
    return { kind: "request", url: `${origin}${ZAI_QUOTA_PATH}?type=2`, headers };
  }
  if (queryMode === "personal-legacy") {
    // The verified personal shape: no type parameter, no scope headers.
    return { kind: "request", url: `${origin}${ZAI_QUOTA_PATH}`, headers };
  }
  return issue("needs-verification", false, `unsupported queryMode ${queryMode}`);
}

/** Verified unit mapping (§9): 3=hour, 6=week, 5=month. */
const UNIT_MAP: Readonly<Record<number, QuotaWindowUnit>> = Object.freeze({ 3: "hour", 6: "week", 5: "month" });

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;

/** A reset time must be a plausible epoch-ms instant; second-precision values or
 *  garbage mark the field unknown instead of being rescaled or guessed. */
const resetTime = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (parsed === undefined) return undefined;
  if (parsed < 946684800000 || parsed > 7258118400000) return undefined; // 2001..2200
  return Math.floor(parsed);
};

const METER_KINDS: Readonly<Record<string, QuotaMeterKind>> = Object.freeze({
  TOKENS_LIMIT: "quota-percent",
  CREDIT_LIMIT: "credits",
  TIME_LIMIT: "tools",
});

/** `usage` (the total) is only a quantity for the verified credit/tools pools; a
 *  TOKENS_LIMIT percentage pool has no token total, whatever its name suggests. */
const totalFor = (kind: QuotaMeterKind, value: unknown): number | undefined =>
  (kind === "credits" || kind === "tools") ? finite(value) : undefined;

const object = isObject;

export const ZAI_MAX_BUCKETS = 32;

/** Normalize one verified response. HTTP-level and transport failures are handled
 *  by the caller; this function owns the business and mapping semantics. */
export function zaiParse(status: number, headers: QuotaHeadersLike | null, body: string, context: ZaiParseContext): ZaiParseResult {
  const httpIssue = httpStatusIssue(status, headers, context.now);
  if (httpIssue !== null) return httpIssue;
  const parsed = parseJsonPayload(body);
  if (!isObject(parsed)) return issue("protocol-error", true, "invalid JSON");
  const data = parsed.data;
  if (parsed.success !== true || parsed.code !== 200) {
    // Business failure: sanitized classification only; `data` is never published.
    return issue("business-error", true, "business success=false");
  }
  if (!object(data) || !Array.isArray(data.limits) || data.limits.length === 0) {
    // Empty data is unknown, never zero, unlimited, or "no plan".
    return issue("no-data", true, "empty limits");
  }
  const buckets: QuotaBucket[] = [];
  const seenShapes = new Map<string, number>();
  let ignored = 0;
  let truncated = false;
  for (const raw of data.limits) {
    if (!object(raw)) { ignored++; continue; }
    const kind = METER_KINDS[raw.type as string];
    if (!kind) { ignored++; continue; } // Unknown metering type: ignored, counted, partial.
    const unitRaw = raw.unit;
    const numberRaw = raw.number;
    const unit = typeof unitRaw === "number" && Number.isFinite(unitRaw) ? UNIT_MAP[unitRaw] : undefined;
    const window: QuotaWindow | null = unit && typeof numberRaw === "number" && Number.isFinite(numberRaw) && numberRaw >= 1 && numberRaw <= 1000
      ? { unit, number: Math.floor(numberRaw) }
      : null;
    const shape = `${raw.type}:${String(unitRaw)}:${String(numberRaw)}`;
    const seen = seenShapes.get(shape) ?? 0;
    seenShapes.set(shape, seen + 1);
    const percentageRaw = raw.percentage;
    const usedPercent = typeof percentageRaw === "number" && Number.isFinite(percentageRaw) && percentageRaw >= 0 && percentageRaw <= 100
      ? percentageRaw
      : undefined;
    const bucket: QuotaBucket = {
      id: seen === 0 ? shape : `${shape}#${seen + 1}`,
      kind,
      window,
      limit: totalFor(kind, raw.usage),
      used: finite(raw.currentValue),
      remaining: finite(raw.remaining),
      usedPercent,
      // Display complement only; never used to recompute any quantity (the fixture's
      // 876 remaining over 1000 total must not be overwritten by 87% of 1000 either).
      remainingPercent: usedPercent === undefined ? undefined : 100 - usedPercent,
      resetAt: resetTime(raw.nextResetTime),
    };
    if (seen > 0) bucket.duplicate = true; // Same-shape buckets are kept apart, never summed.
    if (buckets.length >= ZAI_MAX_BUCKETS) { truncated = true; break; }
    buckets.push(bucket);
  }
  if (buckets.length === 0) {
    return issue(ignored > 0 ? "protocol-error" : "no-data", true, ignored > 0 ? "no valid bucket" : "empty limits");
  }
  const planLabel = safeText(data.level, 32);
  const snapshot: QuotaSnapshotData = {
    buckets: Object.freeze(buckets),
    planLabel,
    ignoredBuckets: ignored,
    truncated,
    partial: ignored > 0 || truncated,
  };
  return { kind: "snapshot", snapshot };
}
