/** Actual Pi CLI/loader smoke. No prompts, provider calls, credentials or billing. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";

const sdk = resolve(".tmp/sdk/node_modules/@earendil-works/pi-coding-agent");
const metadata = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
assert.equal(metadata.version, "1.0.2");
const bin = join(sdk, typeof metadata.bin === "string" ? metadata.bin : metadata.bin.pi);
mkdirSync(".tmp", { recursive: true });
const work = mkdtempSync(resolve(".tmp/pi-rpc-"));
mkdirSync(join(work, "agent"));
const env = { PATH: process.env.PATH ?? "", HOME: work, USERPROFILE: work,
  SYSTEMROOT: process.env.SYSTEMROOT ?? "", TEMP: work, TMP: work, TERM: "dumb", CI: "true",
  PI_CODING_AGENT_DIR: join(work, "agent"), PI_HUD_CONFIG: join(work, "missing-hud.json") };
const child = spawn(process.execPath, [bin, "--mode", "rpc", "--no-session", "--no-extensions", "-e", resolve("index.ts")],
  { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
let output = "", errors = "", total = 0;
const responses = new Map();
try {
  await new Promise((fulfill, reject) => {
    let complete = false;
    const timeout = setTimeout(() => finish(new Error("Pi RPC smoke timed out")), 30_000);
    function finish(error) {
      if (complete) return;
      complete = true; clearTimeout(timeout);
      if (error) reject(error); else fulfill();
    }
    child.once("error", finish);
    child.once("exit", (code, signal) => finish(new Error(`Pi exited early (${code}/${signal}): ${errors}`)));
    child.stderr.on("data", (data) => { errors = (errors + data.toString()).slice(-100_000); });
    child.stdout.on("data", (data) => {
      try {
        total += data.length; assert.ok(total <= 2_000_000, "Unexpected unbounded RPC output");
        output += data.toString();
        let newline;
        while ((newline = output.indexOf("\n")) >= 0) {
          const line = output.slice(0, newline).replace(/\r$/, ""); output = output.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line); // Any non-JSON HUD output fails the smoke.
          assert.notEqual(message.type, "extension_ui_request", "HUD must remain silent in RPC");
          if (message.type !== "response") continue;
          assert.equal(message.success, true, JSON.stringify(message));
          responses.set(message.id, message);
          if (responses.has("hud-commands") && responses.has("hud-state")) {
            assert.ok(responses.get("hud-commands").data.commands.some((command) => command.name === "hud"), "Pi did not load/register the HUD extension");
            finish();
          }
        }
      } catch (error) { finish(error); }
    });
    child.stdin.on("error", finish);
    child.stdin.write('{"id":"hud-commands","type":"get_commands"}\n{"id":"hud-state","type":"get_state"}\n');
  });
  console.log("PASS: real Pi 1.0.2 loads index.ts, registers /hud, serves JSON RPC with no HUD UI output");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) await new Promise((done) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 2_000);
    child.once("close", () => { clearTimeout(timer); done(); });
  });
  rmSync(work, { recursive: true, force: true });
}
