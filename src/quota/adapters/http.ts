/**
 * Shared, data-only HTTP adapter helpers (docs/PROVIDER-LIMITS-PLAN.zh-CN.md §10).
 *
 * Everything here is pure: no I/O, no credentials beyond the bounded strings the
 * caller passes in, no node builtins. The three concerns shared by every adapter:
 * - HTTP status → structured issue mapping (401/403/429/other, §10 table);
 * - `Retry-After` parsing (delay-seconds or HTTP-date, bounded);
 * - decimal amount validation that keeps the server's exact text — amounts are
 *   never parsed into floats and never re-summed (§2: 十进制字符串语义).
 */
import type { QuotaHeadersLike } from "../types.ts";
import type { QuotaIssue, QuotaIssueCode } from "../types.ts";

/** Bounded sanitized issue constructor shared by all adapters. */
export const adapterIssue = (
  code: QuotaIssueCode, retryable: boolean, detail = "", retryAt: number | null = null,
): { kind: "issue"; issue: QuotaIssue } =>
  ({ kind: "issue", issue: { code, retryable, retryAt, detail: detail.slice(0, 64) } });

/** Parse a `Retry-After` header (delay-seconds or HTTP-date) into a millisecond
 *  delay; the caller applies the capped backoff. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const trimmed = value.trim();
  if (/^\d{1,10}$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds * 1_000;
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

/** Shared §10 HTTP mapping. 2xx is *not* handled here (business parsing follows);
 *  every other status becomes the table's issue, including 429 + Retry-After. */
export function httpStatusIssue(
  status: number, headers: QuotaHeadersLike | null, now: number,
): { kind: "issue"; issue: QuotaIssue } | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return adapterIssue("needs-auth", false, "HTTP 401");
  if (status === 403) return adapterIssue("forbidden", false, "HTTP 403");
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headers?.get("retry-after") ?? null, now);
    return adapterIssue("rate-limited", true, "HTTP 429", now + (retryAfterMs ?? 30_000));
  }
  return adapterIssue("http-error", true, `HTTP ${status}`);
}

/** Size-guarded JSON parse; the transport already caps bodies at 256 KiB, this is
 *  defense in depth for direct adapter tests. Returns `undefined` on invalid JSON. */
export function parseJsonPayload(body: string): unknown {
  try {
    return JSON.parse(body.length > 512 * 1024 ? "" : body);
  } catch {
    return undefined;
  }
}

/** `value` is an object (not array, not null). */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A server amount kept as exact text (§2): optional sign, 1-17 integer digits,
 * at most 8 fraction digits, at most 32 characters total. A negative value is a
 * legal server value and stays negative (§4); NaN, exponents, thousands
 * separators and overlong strings are invalid, never rounded or repaired.
 */
export function decimalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return null;
  return /^-?\d{1,17}(\.\d{1,8})?$/.test(trimmed) ? trimmed : null;
}

/** ISO-style currency code as sent by the server (CNY, USD, …): 2-10 uppercase
 *  letters. Lowercase input is normalized; anything else is invalid. */
export function currencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{2,10}$/.test(upper) ? upper : null;
}

/** Bearer authorization for the documented-bearer adapters (DeepSeek, SiliconFlow):
 *  a raw key gets the `Bearer ` prefix; an already-prefixed key is passed through
 *  unchanged so the header never doubles. */
export function bearerAuthorization(apiKey: string): string {
  return /^bearer\s/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`;
}
