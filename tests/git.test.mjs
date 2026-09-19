import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProbe, GIT_ARGS, parseGitStatus } from "../src/git.mjs";
import { controllerFixture } from "./helpers.mjs";

const config = { enabled: true, ttlMs: 10_000, timeoutMs: 500 };
const run = promisify(execFile);

test("porcelain v2 parsing handles branches, tracked changes and detached HEAD", () => {
  assert.deepEqual(parseGitStatus("# branch.oid abcdef123456\n# branch.head main\n"), { available: true, branch: "main", dirty: false });
  assert.equal(parseGitStatus("# branch.head main\n1 .M details path\n").dirty, true);
  assert.equal(parseGitStatus("# branch.oid abcdef123456\n# branch.head (detached)\n").branch, "detached:abcdef1");
  assert.deepEqual(parseGitStatus(""), { available: false });
  assert.deepEqual(parseGitStatus("x".repeat(16_385)), { available: false });
});
test("Git ref text cannot inject terminal escapes", () => {
  assert.equal(parseGitStatus("# branch.head \x1b[31mmain\x1b[0m\n").branch, "main");
});
test("probe has hard timeout/output limits, no shell, no untracked/submodule traversal", () => {
  let invocation;
  const probe = new GitProbe(config, { exec: (...args) => { invocation = args; return { unref() {}, kill() {} }; }, now: () => 0 });
  assert.equal(probe.request("/work/repo", () => {}), true);
  assert.equal(invocation[0], "git"); assert.deepEqual(invocation[1], [...GIT_ARGS]);
  const options = invocation[2];
  assert.equal(options.timeout, 500); assert.equal(options.maxBuffer, 16_384); assert.equal(options.shell, undefined);
  assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0"); assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
  assert.ok(invocation[1].includes("core.fsmonitor=false"));
  assert.ok(invocation[1].includes("--ignore-submodules=all")); assert.ok(invocation[1].includes("--untracked-files=no"));
  probe.dispose(); invocation[3](new Error("cancelled"), "");
});
test("single-flight, cancellation and cooldown prevent duplicate probes and stale results", () => {
  let now = 0; let complete; let kills = 0; let result = 0; let launches = 0;
  const probe = new GitProbe(config, { now: () => now, exec: (_file, _args, _options, callback) => {
    launches++; complete = callback; return { unref() {}, kill() { kills++; } };
  } });
  probe.request("/tmp", () => { result++; });
  assert.equal(probe.request("/tmp", () => {}), false);
  probe.cancel(); now = 20_000;
  assert.equal(probe.request("/tmp", () => {}), false, "cancel does not free the flight until the callback");
  complete(null, "# branch.head stale\n"); assert.equal(result, 0); assert.equal(kills, 1);
  assert.equal(probe.request("/tmp", () => { result++; }), true);
  complete(null, "# branch.head main\n"); assert.equal(result, 1); assert.equal(launches, 2);
  assert.equal(probe.request("/tmp", () => {}), false); probe.dispose();
});
test("missing Git, timeout and output overflow report unavailable, never clean", () => {
  for (const error of [Object.assign(new Error(), { code: "ENOENT" }), Object.assign(new Error(), { killed: true }), Object.assign(new Error(), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })]) {
    let result;
    const probe = new GitProbe(config, { exec: (_f, _a, _o, done) => { done(error, "# branch.head main\n"); return null; } });
    probe.request("/tmp", (value) => { result = value; });
    assert.deepEqual(result, { available: false }); probe.dispose();
  }
});
test("Git is absent from the default lifecycle and only runs at an opted-in idle boundary", async () => {
  let launches = 0; let cancellations = 0;
  const f = controllerFixture({ gitFactory: () => ({ request() { launches++; }, cancel() { cancellations++; }, dispose() {} }) });
  f.clock.advance(0); assert.equal(launches, 0); assert.equal(f.controller.git, null);
  f.setIdle(false); f.emit("agent_start"); await f.controller.command("git on", f.ctx); f.clock.advance(250);
  assert.equal(launches, 0);
  f.emit("agent_end"); f.clock.advance(250); assert.equal(launches, 0);
  f.setIdle(true); f.emit("agent_settled"); f.clock.advance(250); assert.equal(launches, 1);
  f.setIdle(false); f.emit("agent_start"); assert.equal(cancellations, 1); f.emit("session_shutdown");
});
test("real local Git probe detects tracked changes and deliberately ignores untracked files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi hud git "));
  const read = () => new Promise((resolve) => {
    const probe = new GitProbe(config);
    probe.request(dir, (result) => { probe.dispose(); resolve(result); });
  });
  try {
    await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await writeFile(join(dir, "tracked.txt"), "one\n");
    await run("git", ["add", "tracked.txt"], { cwd: dir });
    await run("git", ["-c", "user.name=HUD test", "-c", "user.email=hud-test@example.invalid", "commit", "-qm", "fixture"], { cwd: dir });
    assert.deepEqual(await read(), { available: true, branch: "main", dirty: false });
    await writeFile(join(dir, "untracked.txt"), "not included\n");
    assert.equal((await read()).dirty, false);
    await writeFile(join(dir, "tracked.txt"), "two\n");
    assert.equal((await read()).dirty, true);
    await run("git", ["checkout", "--detach", "-q"], { cwd: dir });
    assert.match((await read()).branch, /^detached:[a-f0-9]{7}$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
