import { execFile } from "node:child_process";
import { safeText } from "./text.mjs";

export const GIT_ARGS = Object.freeze([
  "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
  "-c", "maintenance.auto=false", "-c", "status.aheadBehind=false",
  "status", "--porcelain=v2", "--branch", "--no-ahead-behind",
  "--untracked-files=no", "--ignore-submodules=all",
]);

export function parseGitStatus(output) {
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

/** Opt-in, idle-boundary-only, cancellable, single-flight probe. No polling. */
export class GitProbe {
  constructor(config, options = {}) {
    this.config = config;
    this.exec = options.exec ?? execFile;
    this.now = options.now ?? Date.now;
    this.lastAttempt = -Infinity;
    this.flight = null;
    this.closed = false;
    this.attempts = 0;
  }

  request(cwd, onResult) {
    if (this.closed || !this.config.enabled || this.flight || this.now() - this.lastAttempt < this.config.ttlMs) return false;
    this.lastAttempt = this.now();
    this.attempts++;
    const flight = { cancelled: false, child: null };
    this.flight = flight;
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
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
