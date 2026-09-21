/**
 * SiliconFlow (硅基流动) balance adapter (docs/PROVIDER-LIMITS-PLAN.zh-CN.md §2 API 余额).
 *
 * Contract (official openapi.yaml in github.com/siliconflow/siliconcloud, and
 * docs.siliconflow.com/cn/api-reference/userinfo/get-user-info, read 2026-09-21):
 * `GET https://api.siliconflow.cn/v1/user/info` with `Authorization: Bearer <key>`:
 * { "code": 20000, "message": "OK", "status": true, "data": { ..., "balance": string,
 *    "chargeBalance": string, "totalBalance": string } }
 * The official examples (balance "0.88", chargeBalance "88.00", totalBalance
 * "88.88") fix the arithmetic balance + chargeBalance = totalBalance, so
 * `balance` is the granted (赠送) part and `chargeBalance` the topped-up (充值)
 * part; `totalBalance` is the account total. The field meanings are derived from
 * those official examples (the docs page has no per-field prose) and await
 * real-account confirmation — recorded as such in the plan document.
 *
 * Normalization rules (mirroring the DeepSeek adapter):
 * - amounts keep the server's exact text; nothing is float-parsed, rounded or
 *   re-summed (totalBalance is used as sent, never recomputed from the parts);
 * - the response carries no currency field; SiliconFlow billing is CNY-denominated,
 *   so items are normalized with currency "CNY" (documented inference);
 * - `code !== 20000 || status !== true` is a business failure (sanitized detail
 *   only, the server message is never echoed);
 * - a missing `data` object is `no-data`; zero and negative amounts are legal
 *   server values and stay as-is.
 *
 * Credential safety (§7): same relay guard as DeepSeek — a key resolved for a
 * provider whose base URL is a different origin is never sent to
 * api.siliconflow.cn; the adapter refuses with `needs-verification` instead.
 */
import type { QuotaProfile } from "../../config.ts";
import type { QuotaHeadersLike, QuotaHostAuth, QuotaIssue, QuotaSnapshotData } from "../types.ts";
import { originOfBaseUrl } from "../identity.ts";
import { adapterIssue, bearerAuthorization, decimalText, httpStatusIssue, isObject, parseJsonPayload } from "./http.ts";

/** Verified official origin; the query URL is built from this constant only. */
export const SILICONFLOW_QUOTA_ORIGIN = "https://api.siliconflow.cn";
/** Fixed query path from the official openapi.yaml (`servers: …/v1`). */
export const SILICONFLOW_QUOTA_PATH = "/v1/user/info";
/** Documented business-success envelope values (openapi.yaml examples). */
const SILICONFLOW_SUCCESS_CODE = 20000;
/** The response has no currency field; CNY is the documented billing currency. */
const SILICONFLOW_CURRENCY = "CNY";

export interface SiliconFlowPrepareInput {
  profile: QuotaProfile;
  auth: QuotaHostAuth | null;
}

export type SiliconFlowPrepareResult =
  | { kind: "request"; url: string; headers: Record<string, string> }
  | { kind: "issue"; issue: QuotaIssue };

export interface SiliconFlowParseContext {
  now: number;
}

export type SiliconFlowParseResult =
  | { kind: "snapshot"; snapshot: QuotaSnapshotData }
  | { kind: "issue"; issue: QuotaIssue };

/** Build the verified request, or refuse with a structured issue before any network. */
export function siliconflowPrepare(input: SiliconFlowPrepareInput): SiliconFlowPrepareResult {
  const { profile, auth } = input;
  if (profile.origin && profile.origin !== SILICONFLOW_QUOTA_ORIGIN) {
    return adapterIssue("needs-verification", false, "profile origin does not match the adapter origin table");
  }
  // Relay guard: a key resolved for a relay provider must never reach the official
  // host. A present base URL whose origin is not exactly the official origin (a
  // relay, plain http, or unparsable) refuses before any request.
  const baseUrl = auth?.baseUrl;
  if (typeof baseUrl === "string" && baseUrl.length > 0 && originOfBaseUrl(baseUrl) !== SILICONFLOW_QUOTA_ORIGIN) {
    return adapterIssue("needs-verification", false, "model base URL is a different origin; relay keys are never sent to the official host");
  }
  const apiKey = auth?.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return adapterIssue("needs-auth", false, "no api key resolved for the current provider");
  }
  return {
    kind: "request",
    url: `${SILICONFLOW_QUOTA_ORIGIN}${SILICONFLOW_QUOTA_PATH}`,
    headers: { Accept: "application/json", Authorization: bearerAuthorization(apiKey) },
  };
}

/** Normalize one verified response. Transport-level failures are handled by the
 *  caller; this function owns the business and mapping semantics. */
export function siliconflowParse(status: number, headers: QuotaHeadersLike | null, body: string, context: SiliconFlowParseContext): SiliconFlowParseResult {
  const httpIssue = httpStatusIssue(status, headers, context.now);
  if (httpIssue !== null) return httpIssue;
  const parsed = parseJsonPayload(body);
  if (!isObject(parsed)) return adapterIssue("protocol-error", true, "invalid JSON");
  if (parsed.code !== SILICONFLOW_SUCCESS_CODE || parsed.status !== true) {
    // Business failure: sanitized classification only; `message` is never echoed.
    return adapterIssue("business-error", true, "business envelope failure");
  }
  const data = parsed.data;
  if (!isObject(data)) return adapterIssue("no-data", true, "missing data object");
  const total = decimalText(data.totalBalance);
  const charge = decimalText(data.chargeBalance);
  const granted = decimalText(data.balance);
  let partial = false;
  if (total === null && data.totalBalance !== undefined) partial = true;
  if (charge === null && data.chargeBalance !== undefined) partial = true;
  if (granted === null && data.balance !== undefined) partial = true;
  if (total === null && charge === null && granted === null) {
    // Every field present was invalid: protocol error, not an empty account.
    const anyPresent = data.totalBalance !== undefined || data.chargeBalance !== undefined || data.balance !== undefined;
    return adapterIssue(anyPresent ? "protocol-error" : "no-data", true, anyPresent ? "no valid balance item" : "no balance fields");
  }
  const balances: NonNullable<QuotaSnapshotData["balances"]>[number][] = [];
  if (total !== null) balances.push({ amountText: total, currency: SILICONFLOW_CURRENCY, scope: "account" });
  if (granted !== null) balances.push({ amountText: granted, currency: SILICONFLOW_CURRENCY, scope: "granted" });
  if (charge !== null) balances.push({ amountText: charge, currency: SILICONFLOW_CURRENCY, scope: "topped-up" });
  const snapshot: QuotaSnapshotData = {
    buckets: Object.freeze([]),
    planLabel: "",
    ignoredBuckets: 0,
    truncated: false,
    partial,
    balances: Object.freeze(balances),
  };
  return { kind: "snapshot", snapshot };
}
