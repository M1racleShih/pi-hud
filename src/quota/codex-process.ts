/**
 * Bounded codex app-server subprocess transport
 * (docs/PROVIDER-LIMITS-PLAN.zh-CN.md §2 Codex, §5, §7).
 *
 * The codex adapter has no HTTP endpoint: the official protocol runs over the
 * stdio of a short-lived `codex app-server` child (JSON-RPC, newline-delimited).
 * Every process capability of the HUD lives inside the marked boundary below;
 * `scripts/check.mjs` keeps `spawn` confined to this module and `spawnSync`/
 * `exec*` forbidden everywhere.
 *
 * Verified against codex-cli 0.155.1 (2026-09-22, read-only live probe):
 * - `initialize` request with `clientInfo {name, version}` (required) → result
 *   carries platform info; no protocol version is negotiated;
 * - `initialized` notification (the only client notification);
 * - `account/rateLimits/read` request → result with `rateLimits` (required
 *   single-bucket view) and `rateLimitsByLimitId` (multi-bucket map); the server
 *   pushes unrelated notifications (e.g. remoteControl/status/changed) which the
 *   reader skips; a JSON-RPC `error` response is surfaced for the adapter to map;
 * - closing stdin is a shutdown signal, not a drain: the child exits without
 *   answering if EOF arrives before the response (verified live), so the driver
 *   keeps stdin open and kills the child once the answer (or a failure) is
 *   known; the process never outlives the query either way.
 *
 * Bounds (§5): total deadline (floor 10 s — the child boot plus one network
 * round trip does not fit the 5 s HTTP default), 256 KiB per JSON-RPC frame,
 * 1 MiB total stdout, SIGTERM→SIGKILL escalation on deadline, and no shell:
 * fixed command and arguments, never interpolated.
 *
 * The child inherits the host environment unchanged. This is deliberate: the
 * app-server reaches OpenAI endpoints itself, and environments that need an
 * egress proxy must have it in the environment Pi runs in (the HUD never reads,
 * stores or injects proxy configuration).
 */
import type { QuotaTransportResult } from "./transport.ts";
import type { ClearTimer, SetTimer, TimerHandle } from "../scheduler.ts";

/** Total-deadline floor: the protocol needs child boot + handshake + one backend read. */
export const CODEX_MIN_TOTAL_MS = 10_000;
/** One JSON-RPC frame may not exceed this; overlong frames are refused, not truncated. */
export const CODEX_MAX_FRAME_BYTES = 256 * 1024;
/** Total stdout the reader will ever buffer for one query. */
export const CODEX_MAX_TOTAL_BYTES = 1024 * 1024;
/** Grace between SIGTERM and SIGKILL when the deadline fires. */
export const CODEX_KILL_GRACE_MS = 1_500;

/** The minimal child surface the driver needs; Node's ChildProcess satisfies it. */
export interface CodexChildLike {
  stdin: { write(data: string): void; end(): void } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Injectable spawn surface (tests substitute a fake child). */
export type CodexSpawnLike = (command: string, args: readonly string[], options: { stdio: "pipe"; env: NodeJS.ProcessEnv }) => CodexChildLike;

export interface CodexProcessOptions {
  timeoutMs?: number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  spawnImpl?: CodexSpawnLike;
}

const nullHeaders: { get(): string | null } = { get: () => null };

const jsonRpcLine = (message: unknown): string => `${JSON.stringify(message)}\n`;

/**
 * One bounded read-only rate-limits query. Sends exactly three frames
 * (initialize, initialized, account/rateLimits/read) and keeps stdin open —
 * EOF is a shutdown signal that would kill the child before it answers — then
 * returns the first response whose id matches the rate-limits request; server
 * notifications and unrelated responses are skipped. The child is killed as soon
 * as an answer (or failure) is known; the process never outlives the query.
 */
export async function runCodexRateLimitsQuery(options: CodexProcessOptions = {}): Promise<QuotaTransportResult> {
  const timeoutMs = Math.max(CODEX_MIN_TOTAL_MS, Math.floor(options.timeoutMs ?? CODEX_MIN_TOTAL_MS));
  const setTimer = options.setTimer ?? (setTimeout as unknown as SetTimer);
  const clearTimer = options.clearTimer ?? (clearTimeout as unknown as ClearTimer);
  const spawnImpl = options.spawnImpl ?? defaultCodexSpawn;
  const requestId = 1;
  let settled = false;
  let buffer = "";
  let totalBytes = 0;
  let timer: TimerHandle | null = null;
  let killTimer: TimerHandle | null = null;
  let child: CodexChildLike | null = null;

  const finish = (result: QuotaTransportResult): QuotaTransportResult => {
    if (settled) return result;
    settled = true;
    if (timer !== null) clearTimer(timer);
    if (killTimer !== null) clearTimer(killTimer);
    if (child) { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } }
    return result;
  };

  return await new Promise<QuotaTransportResult>((resolve) => {
    try {
      child = spawnImpl("codex", ["app-server"], { stdio: "pipe", env: process.env });
    } catch {
      resolve(finish({ kind: "network", reason: "spawn-error" }));
      return;
    }
    child.once("error", (error: NodeJS.ErrnoException) => {
      // ENOENT is the "codex is not installed" case; the detail names it without
      // echoing the raw system message.
      resolve(finish({ kind: "network", reason: error.code === "ENOENT" ? "spawn-not-found" : "spawn-error" }));
    });
    child.once("close", () => {
      // The child ended before a rate-limits response arrived.
      resolve(finish({ kind: "network", reason: "process-exit" }));
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      totalBytes += text.length;
      if (totalBytes > CODEX_MAX_TOTAL_BYTES) {
        resolve(finish({ kind: "oversized" }));
        return;
      }
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        if (trimmed.length > CODEX_MAX_FRAME_BYTES) {
          resolve(finish({ kind: "oversized" }));
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue; // Not JSON-RPC (banner text, progress noise): skip, never fail.
        }
        if (typeof message !== "object" || message === null) continue;
        const record = message as { id?: unknown; result?: unknown; error?: unknown };
        if (record.id !== requestId) continue; // Notification or unrelated response.
        // The rate-limits answer: a result object, or a JSON-RPC error envelope
        // (mapped by the adapter; its message is never echoed outward).
        const body = record.result !== undefined ? record.result : record;
        resolve(finish({ kind: "response", status: 200, headers: nullHeaders, body: JSON.stringify(body) }));
        return;
      }
    });

    timer = setTimer(() => {
      try { child?.kill("SIGTERM"); } catch { /* Already gone. */ }
      killTimer = setTimer(() => resolve(finish({ kind: "timeout" })), CODEX_KILL_GRACE_MS);
      killTimer?.unref?.();
    }, timeoutMs);
    timer?.unref?.();

    const stdin = child.stdin;
    if (!stdin) {
      resolve(finish({ kind: "network", reason: "spawn-error" }));
      return;
    }
    try {
      stdin.write(jsonRpcLine({ jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: "pi-hud", title: "pi-hud quota read", version: "1.0.0" } } }));
      stdin.write(jsonRpcLine({ jsonrpc: "2.0", method: "initialized", params: {} }));
      stdin.write(jsonRpcLine({ jsonrpc: "2.0", id: requestId, method: "account/rateLimits/read", params: {} }));
      // Deliberately no stdin.end() here: EOF makes the app-server exit before
      // answering (verified live). The kill in finish() reaps the child instead.
    } catch {
      resolve(finish({ kind: "network", reason: "spawn-error" }));
    }
  });
}

/* process-boundary:start */

import { spawn } from "node:child_process";

/** The only place the HUD starts a subprocess: the fixed codex app-server child.
 *  Fixed command and arguments, piped stdio, inherited environment, no shell. */
const defaultCodexSpawn: CodexSpawnLike = (command, args, options) =>
  spawn(command, args, options) as unknown as CodexChildLike;

/* process-boundary:end */
