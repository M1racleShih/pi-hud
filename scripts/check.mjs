import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { OBSERVED_EVENTS, STREAM_EVENTS } from "../src/extension.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.ts";
import { renderPreview } from "./preview.mjs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, "Runtime dependencies are forbidden");
assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
for (const event of ["tool_execution_update", "before_agent_start", "context", "input", "tool_call", "tool_result"]) {
  assert.ok(!OBSERVED_EVENTS.includes(event), `Forbidden core-path listener: ${event}`);
}
// `message_update` is the one deliberate high-frequency bridge (docs/TOKEN-SPEED.zh-CN.md):
// outside OBSERVED_EVENTS, pinned to exactly one stream event, and its handler must fuse
// after the first sample. The state boundary below keeps the hot path honest.
assert.deepEqual(STREAM_EVENTS, ["message_update"], "the stream bridge must stay exactly the first-token sample");
assert.ok(!OBSERVED_EVENTS.includes("message_update"), "message_update must not join the low-frequency event list");
const STREAM_FILE = "state.ts";
const STREAM_START = "/* stream-boundary:start */";
const STREAM_END = "/* stream-boundary:end */";
const streamFileSource = readFileSync(join("src", STREAM_FILE), "utf8");
const streamSection = streamFileSource.includes(STREAM_START) && streamFileSource.includes(STREAM_END)
  ? streamFileSource.split(STREAM_START)[1].split(STREAM_END)[0]
  : "";
assert.ok(streamSection.length > 0, `${STREAM_FILE} must contain the stream boundary section`);
assert.ok(
  streamSection.includes("if (!this.streamArmed || this.firstTokenAt !== null) return false;"),
  "the stream boundary must open with the fused early-return guard",
);
assert.ok(
  !/\.partial\b|\.message\b|\.content\b/.test(streamSection),
  "the stream boundary may only read the delta event's type and delta string",
);
const allowedBuiltins = {
  "config.ts": new Set(["node:fs", "node:fs/promises", "node:os", "node:path"]),
  "git.ts": new Set(["node:child_process"]),
  "text.ts": new Set(["node:util"]),
};
// `setFooter` is a single-replacement host slot. The full forbidden-API group still applies
// to every source file; only the dedicated surface module may call the slot, and only inside
// its marked boundary section, so an accidental footer grab elsewhere still fails this check.
const SURFACE_FILE = "footer.ts";
const SURFACE_START = "/* surface-boundary:start */";
const SURFACE_END = "/* surface-boundary:end */";
const surfaceFileSource = existsSync(join("src", SURFACE_FILE)) ? readFileSync(join("src", SURFACE_FILE), "utf8") : "";
const surfaceSection = surfaceFileSource.includes(SURFACE_START) && surfaceFileSource.includes(SURFACE_END)
  ? surfaceFileSource.split(SURFACE_START)[1].split(SURFACE_END)[0]
  : "";
// Call sites may use plain or optional-chained invocation (`x.foo(` / `x.foo?.(`), so every
// matcher below accepts an optional `?.` before the argument list. Method-form names
// additionally require a receiver dot, because an interface member like `setFooter?(...)`
// must not count as an optional-chained call.
const countSurfaceCalls = (source) => (source.match(/\.\s*setFooter\s*(?:\?\.\s*)?\(/g) ?? []).length;
assert.ok(surfaceSection.includes("setFooter"), `${SURFACE_FILE} must own the setFooter boundary`);
assert.equal(
  countSurfaceCalls(surfaceFileSource), countSurfaceCalls(surfaceSection),
  "setFooter may only be called inside the marked surface boundary section",
);
assert.ok(surfaceSection.includes("typeof ui.setFooter !== \"function\""), "the surface boundary must keep its capability guard");
assert.ok(surfaceSection.includes("installFooter") && surfaceSection.includes("releaseFooter"), "install and release must both live in the boundary");
// Same pattern for host history reads: only the optional session-usage ledger module may
// call the read-only entry APIs, only inside its marked boundary. The render-path history
// APIs (getBranch/getContextUsage) stay forbidden everywhere, boundary included.
const HISTORY_FILE = "usage.ts";
const HISTORY_START = "/* history-boundary:start */";
const HISTORY_END = "/* history-boundary:end */";
const historyFileSource = existsSync(join("src", HISTORY_FILE)) ? readFileSync(join("src", HISTORY_FILE), "utf8") : "";
const historySection = historyFileSource.includes(HISTORY_START) && historyFileSource.includes(HISTORY_END)
  ? historyFileSource.split(HISTORY_START)[1].split(HISTORY_END)[0]
  : "";
const countHistoryCalls = (source) => (source.match(/\.\s*(?:getEntries|getEntry|getLeafId|getSessionId)\s*(?:\?\.\s*)?\(/g) ?? []).length;
assert.ok(historySection.length > 0, `${HISTORY_FILE} must contain the history boundary section`);
assert.equal(
  countHistoryCalls(historyFileSource), countHistoryCalls(historySection),
  "read-only entry APIs may only be called inside the marked history boundary section",
);
assert.ok(
  ["getEntries", "getEntry", "getLeafId"].every((method) => historySection.includes(method)),
  "the history boundary must wrap the read-only entry reads",
);
const forbiddenBase = /\b(?:execSync|execFileSync|spawnSync|readFileSync|writeFileSync|setInterval|fetch)\s*(?:\?\.\s*)?\(|\.\s*(?:getBranch|getContextUsage|registerTool|sendMessage|sendUserMessage|appendEntry|setEditorComponent|onTerminalInput)\s*(?:\?\.\s*)?\(|\bconsole\s*\./;
const forbiddenSurface = /\.\s*setFooter\s*(?:\?\.\s*)?\(/;
const forbiddenHistory = /\.\s*(?:getEntries|getEntry|getLeafId|getSessionId)\s*(?:\?\.\s*)?\(/;
for (const file of readdirSync("src").filter((file) => file.endsWith(".ts"))) {
  const source = readFileSync(join("src", file), "utf8");
  assert.ok(!forbiddenBase.test(source), `Forbidden hot-path API or direct output in ${file}`);
  if (file !== SURFACE_FILE) assert.ok(!forbiddenSurface.test(source), `setFooter is only allowed in the ${SURFACE_FILE} surface boundary`);
  if (file !== HISTORY_FILE) assert.ok(!forbiddenHistory.test(source), `read-only entry APIs are only allowed in the ${HISTORY_FILE} history boundary`);
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

// Configuration, schema and example must describe exactly the runtime defaults.
const schema = JSON.parse(readFileSync("docs/config.schema.json", "utf8"));
const example = JSON.parse(readFileSync("examples/pi-hud.json", "utf8"));
assert.equal(schema.additionalProperties, false, "Schema must reject unknown keys like the runtime validator");
for (const key of Object.keys(DEFAULT_CONFIG)) assert.ok(schema.properties[key], `Schema is missing ${key}`);
assert.deepEqual(Object.keys(example).sort(), Object.keys(DEFAULT_CONFIG).sort(), "Example must list exactly the runtime keys");
for (const [key, spec] of Object.entries(schema.properties)) {
  if (spec.enum) for (const value of spec.enum) assert.doesNotThrow(() => normalizeConfig({ [key]: value }), `Schema enum ${key}=${value} is rejected at runtime`);
  if (spec.type === "boolean") assert.doesNotThrow(() => normalizeConfig({ [key]: true }), `Schema boolean ${key} is rejected at runtime`);
}
assert.deepEqual(normalizeConfig(example), normalizeConfig(), "Example must stay equal to runtime defaults");
console.log("PASS: configuration defaults, JSON schema and example are in sync");

// The committed preview is generated from the real renderer, so it cannot drift.
const preview = readFileSync("docs/preview.txt", "utf8");
assert.equal(preview, renderPreview(), "docs/preview.txt is stale; run: npm run demo -- --write docs/preview.txt");
console.log("PASS: docs/preview.txt matches the deterministic renderer output");
