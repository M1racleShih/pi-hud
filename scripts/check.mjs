import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { OBSERVED_EVENTS } from "../src/extension.ts";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, "Runtime dependencies are forbidden");
assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
for (const event of ["message_update", "tool_execution_update", "before_agent_start", "context", "input", "tool_call", "tool_result"]) {
  assert.ok(!OBSERVED_EVENTS.includes(event), `Forbidden core-path listener: ${event}`);
}
const allowedBuiltins = {
  "config.ts": new Set(["node:fs", "node:fs/promises", "node:os", "node:path"]),
  "git.ts": new Set(["node:child_process"]),
  "text.ts": new Set(["node:util"]),
};
const forbidden = /\b(?:execSync|execFileSync|spawnSync|readFileSync|writeFileSync|setInterval|fetch)\s*\(|\.(?:getBranch|getEntries|getContextUsage|registerTool|sendMessage|sendUserMessage|appendEntry|setFooter|setEditorComponent|onTerminalInput)\s*\(|\bconsole\s*\./;
for (const file of readdirSync("src").filter((file) => file.endsWith(".ts"))) {
  const source = readFileSync(join("src", file), "utf8");
  assert.ok(!forbidden.test(source), `Forbidden hot-path API or direct output in ${file}`);
  for (const match of source.matchAll(/from\s+["'](node:[^"']+)["']/g)) {
    assert.ok(allowedBuiltins[file]?.has(match[1]), `Unexpected builtin import ${match[1]} in ${file}`);
  }
  const result = spawnSync(process.execPath, ["--check", join("src", file)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
assert.ok(readFileSync("README.md", "utf8").includes("README.zh-CN.md"));
assert.ok(readFileSync("README.zh-CN.md", "utf8").includes("README.md"));
for (const file of ["README.md", "README.zh-CN.md", ...readdirSync("docs").filter((file) => file.endsWith(".md")).map((file) => `docs/${file}`)]) {
  const content = readFileSync(file, "utf8");
  for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
    if (/^(?:https?:|#|mailto:)/.test(match[1])) continue;
    const path = match[1].split("#")[0];
    if (path) assert.ok(existsSync(join(file.includes("/") ? "docs" : ".", path)), `Broken relative link in ${file}: ${path}`);
  }
}
console.log("PASS: syntax, runtime boundaries, package manifest, bilingual links and documentation paths");
