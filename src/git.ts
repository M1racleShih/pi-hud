import { execFile } from "node:child_process";
import { safeText } from "./text.ts";

export const GIT_ARGS: readonly string[] = Object.freeze([
  "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
  "-c", "maintenance.auto=false", "-c", "status.aheadBehind=false",
  "status", "--porcelain=v2", "--branch", "--no-ahead-behind",
  "--untracked-files=no", "--ignore-submodules=all",
]);

export type GitStatus = { available: false } | { available: true; branch: string; dirty: boolean };

export function parseGitStatus(output: unknown): GitStatus {
  if (typeof output !== "string" || Buffer.byteLength(output) > 16_384) return { available: false };
  let branch = "";
  let oid = "";
  let dirty = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = safeText(line.slice(14), 80);
    else if (line.startsWith("# branch.oid ")) oid = safeText(line.slice(13), 12);
    else if (/^[12u?] /.test(line)) dirty = true;
  }
  if (branch === "(detached)") branch = `detached:${oid.slice(0, 7) || "?"}`;
  return branch ? { available: true, branch, dirty } : { available: false };
}

export interface GitProbeConfig {
  enabled: boolean;
  ttlMs: number;
  timeoutMs: number;
}

/** Minimal child-process shape used by the probe; real or injected implementations. */
export interface GitChild {
  unref?(): void;
  kill(signal?: string): void;
}

export interface GitExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  killSignal: string;
  windowsHide: boolean;
}

export type GitExec = (
  file: string,
  args: string[],
  options: GitExecOptions,
  callback: (error: Error | null, stdout: string) => void,
) => GitChild | null;

/** The probe contract the controller depends on; satisfied by GitProbe or test fakes. */
export interface GitProbeLike {
  request(cwd: string, onResult: (status: GitStatus) => void): boolean;
  cancel(): void;
  dispose(): void;
}

/** Opt-in, idle-boundary-only, cancellable, single-flight probe. No polling. */
export class GitProbe implements GitProbeLike {
  declare config: GitProbeConfig;
  declare exec: GitExec;
  declare now: () => number;
  declare lastAttempt: number;
  declare flight: { cancelled: boolean; child: GitChild | null } | null;
  declare closed: boolean;
  declare attempts: number;

  constructor(config: GitProbeConfig, options: { exec?: GitExec; now?: () => number } = {}) {
    this.config = config;
    this.exec = options.exec ?? (execFile as unknown as GitExec);
    this.now = options.now ?? Date.now;
    this.lastAttempt = -Infinity;
    this.flight = null;
    this.closed = false;
    this.attempts = 0;
  }

  request(cwd: string, onResult: (status: GitStatus) => void) {
    if (this.closed || !this.config.enabled || this.flight || this.now() - this.lastAttempt < this.config.ttlMs) return false;
    this.lastAttempt = this.now();
    this.attempts++;
    const flight: { cancelled: boolean; child: GitChild | null } = { cancelled: false, child: null };
    this.flight = flight;
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
    try {
      flight.child = this.exec("git", [...GIT_ARGS], {
        cwd, env, encoding: "utf8", timeout: this.config.timeoutMs,
        maxBuffer: 16_384, killSignal: "SIGKILL", windowsHide: true,
      }, (error, stdout) => {
        if (this.flight === flight) this.flight = null;
        if (this.closed || flight.cancelled) return;
        try { onResult(error ? { available: false } : parseGitStatus(stdout)); } catch { /* Observer only. */ }
      });
      flight.child?.unref?.();
    } catch {
      this.flight = null;
      try { onResult({ available: false }); } catch { /* Observer only. */ }
    }
    return true;
  }

  cancel() {
    if (!this.flight) return;
    this.flight.cancelled = true;
    try { this.flight.child?.kill("SIGKILL"); } catch { /* Already exited. */ }
    // Keep the flight occupied until its callback: no overlapping subprocesses.
  }

  dispose() { this.closed = true; this.cancel(); }
}
