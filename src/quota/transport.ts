/**
 * Bounded HTTP transport for quota queries (docs/PROVIDER-LIMITS-PLAN.zh-CN.md §5/§10).
 *
 * Every network capability of the HUD lives inside the marked transport boundary
 * below; `scripts/check.mjs` keeps `fetch` forbidden in every other source file.
 * The transport enforces, independently of any adapter:
 * - a fixed per-request timeout (default 5 s) with abort;
 * - a 256 KiB response-body cap, applied before the body is ever parsed;
 * - `redirect: "error"` plus an explicit 3xx refusal, so credentials can never be
 *   re-sent to another host (the URL itself is adapter-fixed and exact);
 * - `credentials: "omit"` (no cookies are read or sent);
 * - redaction: only error *names* and status codes are classified outward. Error
 *   messages, headers, and response bodies never reach diagnostics.
 *
 * The module is data-driven and fully injectable: tests pass a fake `QuotaFetchLike`.
 */
import type { QuotaHeadersLike } from "./types.ts";
import type { ClearTimer, SetTimer, TimerHandle } from "../scheduler.ts";

/** Default HTTP timeout (ms). */
export const QUOTA_TIMEOUT_MS = 5_000;
/** Default response-body cap (bytes). */
export const QUOTA_MAX_BODY_BYTES = 256 * 1024;

export interface QuotaFetchInit {
  method: "GET";
  headers: Record<string, string>;
  redirect: "error";
  credentials: "omit";
  signal?: AbortSignal;
}

/** The injectable fetch surface; the global `fetch` satisfies this shape. */
export interface QuotaFetchLike {
  (url: string, init: QuotaFetchInit): Promise<QuotaFetchResponse>;
}

export interface QuotaFetchResponse {
  status: number;
  ok: boolean;
  headers: QuotaHeadersLike;
  /** Full body text; the transport applies the byte cap before returning a response. */
  text(): Promise<string>;
  /** Optional streaming body, used for the byte cap when available. */
  readonly body?: unknown;
}

export type QuotaTransportResult =
  | { kind: "response"; status: number; headers: QuotaHeadersLike; body: string }
  | { kind: "timeout" }
  | { kind: "redirect"; status: number }
  | { kind: "oversized" }
  | { kind: "network"; reason: string };

export interface QuotaTransportOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** Injectable timers keep cancellation deterministic in tests. */
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
}

/** Read a response body with a hard byte cap. Streams are consumed incrementally so
 *  an oversized body is refused without being fully buffered; plain `text()` bodies
 *  (test fakes) are measured afterwards. */
export async function boundedBody(response: QuotaFetchResponse, maxBytes: number): Promise<string | null> {
  const stream = response.body as { getReader?: () => { read(): Promise<{ done: boolean; value?: unknown }> } } | undefined;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let text = "";
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value as Uint8Array | undefined;
        if (!chunk || typeof chunk.length !== "number") continue;
        bytes += chunk.length;
        if (bytes > maxBytes) return null;
        text += decoder.decode(chunk, { stream: true });
        if (text.length > maxBytes * 2) return null;
      }
      text += decoder.decode();
    } catch {
      return null;
    }
    return text;
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  return byteLengthOf(text) > maxBytes ? null : text;
}

const byteLengthOf = (text: string): number => {
  // ASCII fast path; the JSON quota payloads are ASCII with CJK only in labels.
  let ascii = true;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) { ascii = false; break; }
  }
  if (ascii) return text.length;
  return new TextEncoder().encode(text).length;
};

/* transport-boundary:start */
/** The only network entry of the extension. Reaching the global `fetch` happens
 *  exclusively here, inside the audited boundary. */
export const globalQuotaFetch: QuotaFetchLike = (url, init) => fetch(url, init);
/* transport-boundary:end */

/** One bounded GET. Never follows redirects; classifies failures without echoing
 *  error messages, headers, or body content. */
export async function quotaFetch(
  fetchLike: QuotaFetchLike,
  url: string,
  headers: Record<string, string>,
  options: QuotaTransportOptions = {},
): Promise<QuotaTransportResult> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? QUOTA_TIMEOUT_MS));
  const maxBytes = Math.max(1, Math.floor(options.maxBodyBytes ?? QUOTA_MAX_BODY_BYTES));
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const setTimer = options.setTimer ?? (setTimeout as unknown as SetTimer);
  const clearTimer = options.clearTimer ?? (clearTimeout as unknown as ClearTimer);
  let timedOut = false;
  const timer: TimerHandle = setTimer(() => {
    timedOut = true;
    try { controller?.abort(); } catch { /* Already settled. */ }
  }, timeoutMs);
  timer?.unref?.();
  try {
    const response = await fetchLike(url, {
      method: "GET",
      headers,
      redirect: "error",
      credentials: "omit",
      signal: controller?.signal,
    });
    if (response.status >= 300 && response.status < 400) return { kind: "redirect", status: response.status };
    const body = await boundedBody(response, maxBytes);
    if (body === null) return { kind: "oversized" };
    return { kind: "response", status: response.status, headers: response.headers, body };
  } catch (error) {
    if (timedOut) return { kind: "timeout" };
    // Only the error *class* is reported; messages can embed URLs or system detail.
    const reason = error instanceof Error ? error.name : "Error";
    return { kind: "network", reason };
  } finally {
    clearTimer(timer);
  }
}
