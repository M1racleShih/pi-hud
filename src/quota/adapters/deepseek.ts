/**
 * DeepSeek API balance adapter (docs/PROVIDER-LIMITS-PLAN.zh-CN.md §2 API 余额).
 *
 * Contract (official https://api-docs.deepseek.com/api/get-user-balance/):
 * `GET https://api.deepseek.com/user/balance` with `Authorization: Bearer <key>`:
 * { "is_available": boolean, "balance_infos": [{ "currency": "CNY"|"USD",
 *    "total_balance": string, "granted_balance": string, "topped_up_balance": string }] }
 * Amounts are decimal strings. Normalization rules:
 * - every amount keeps the server's exact text; nothing is parsed into a float,
 *   rounded, or re-summed (total is never recomputed from granted + topped-up);
 * - `total_balance` is the account balance shown on the HUD row; granted/topped-up
 *   stay detail items for `/hud quotas`;
 * - a missing/empty `balance_infos` is `no-data` (unknown), never zero or
 *   unlimited; a negative or zero amount is a legal server value and stays as-is;
 * - `is_available` (balance sufficient for API calls) is documented but not
 *   displayed in this slice — it is data about sufficiency, not an amount.
 *
 * Credential safety (§7): the query host is the fixed official origin, never the
 * model's base URL. If the host-resolved auth carries a base URL whose origin is
 * a different host (a custom relay provider), the key is *this relay's* key and
 * must never be sent to api.deepseek.com — the adapter refuses with
 * `needs-verification` before any request.
 */
import type { QuotaProfile } from "../../config.ts";
import type { QuotaHeadersLike, QuotaHostAuth, QuotaIssue, QuotaSnapshotData } from "../types.ts";
import { originOfBaseUrl } from "../identity.ts";
import { adapterIssue, bearerAuthorization, currencyCode, decimalText, httpStatusIssue, isObject, parseJsonPayload } from "./http.ts";

/** Verified official origin; the query URL is built from this constant only. */
export const DEEPSEEK_QUOTA_ORIGIN = "https://api.deepseek.com";
/** Fixed query path from the official API reference. */
export const DEEPSEEK_QUOTA_PATH = "/user/balance";
/** At most this many balance_infos items are kept; further ones are truncated. */
export const DEEPSEEK_MAX_BALANCE_INFOS = 4;

export interface DeepSeekPrepareInput {
  profile: QuotaProfile;
  auth: QuotaHostAuth | null;
}

export type DeepSeekPrepareResult =
  | { kind: "request"; url: string; headers: Record<string, string> }
  | { kind: "issue"; issue: QuotaIssue };

export interface DeepSeekParseContext {
  now: number;
}

export type DeepSeekParseResult =
  | { kind: "snapshot"; snapshot: QuotaSnapshotData }
  | { kind: "issue"; issue: QuotaIssue };

/** Build the verified request, or refuse with a structured issue before any network. */
export function deepseekPrepare(input: DeepSeekPrepareInput): DeepSeekPrepareResult {
  const { profile, auth } = input;
  if (profile.origin && profile.origin !== DEEPSEEK_QUOTA_ORIGIN) {
    return adapterIssue("needs-verification", false, "profile origin does not match the adapter origin table");
  }
  // Relay guard: a key resolved for a relay provider must never reach the official
  // host. A present base URL whose origin is not exactly the official origin (a
  // relay, plain http, or unparsable) refuses before any request.
  const baseUrl = auth?.baseUrl;
  if (typeof baseUrl === "string" && baseUrl.length > 0 && originOfBaseUrl(baseUrl) !== DEEPSEEK_QUOTA_ORIGIN) {
    return adapterIssue("needs-verification", false, "model base URL is a different origin; relay keys are never sent to the official host");
  }
  const apiKey = auth?.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return adapterIssue("needs-auth", false, "no api key resolved for the current provider");
  }
  return {
    kind: "request",
    url: `${DEEPSEEK_QUOTA_ORIGIN}${DEEPSEEK_QUOTA_PATH}`,
    headers: { Accept: "application/json", Authorization: bearerAuthorization(apiKey) },
  };
}

/** Normalize one verified response. Transport-level failures are handled by the
 *  caller; this function owns the business and mapping semantics. */
export function deepseekParse(status: number, headers: QuotaHeadersLike | null, body: string, context: DeepSeekParseContext): DeepSeekParseResult {
  const httpIssue = httpStatusIssue(status, headers, context.now);
  if (httpIssue !== null) return httpIssue;
  const parsed = parseJsonPayload(body);
  if (!isObject(parsed)) return adapterIssue("protocol-error", true, "invalid JSON");
  const infos = parsed.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    // Empty data is unknown, never zero, unlimited, or "no balance".
    return adapterIssue("no-data", true, "empty balance_infos");
  }
  const balances: NonNullable<QuotaSnapshotData["balances"]>[number][] = [];
  let ignored = 0;
  let truncated = false;
  let partial = false;
  for (const raw of infos) {
    if (!isObject(raw)) { ignored++; partial = true; continue; }
    const currency = currencyCode(raw.currency);
    if (currency === null) { ignored++; partial = true; continue; }
    const total = decimalText(raw.total_balance);
    if (total === null) {
      // The account total is unknown; parts may still be valid details (never summed).
      partial = true;
    }
    const granted = decimalText(raw.granted_balance);
    const topped = decimalText(raw.topped_up_balance);
    if (granted === null && raw.granted_balance !== undefined) partial = true;
    if (topped === null && raw.topped_up_balance !== undefined) partial = true;
    if (total === null && granted === null && topped === null) { ignored++; continue; }
    if (total !== null) balances.push({ amountText: total, currency, scope: "account" });
    if (granted !== null) balances.push({ amountText: granted, currency, scope: "granted" });
    if (topped !== null) balances.push({ amountText: topped, currency, scope: "topped-up" });
    if (balances.length >= DEEPSEEK_MAX_BALANCE_INFOS * 3) { truncated = true; break; }
  }
  if (balances.length === 0) {
    return adapterIssue(ignored > 0 ? "protocol-error" : "no-data", true, ignored > 0 ? "no valid balance item" : "empty balance_infos");
  }
  const snapshot: QuotaSnapshotData = {
    buckets: Object.freeze([]),
    planLabel: "",
    ignoredBuckets: ignored,
    truncated,
    partial,
    balances: Object.freeze(balances),
  };
  return { kind: "snapshot", snapshot };
}
