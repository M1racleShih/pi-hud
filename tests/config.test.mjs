import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_LIMIT, DEFAULT_CONFIG, configPath, isDisabled, normalizeConfig, readConfigFile } from "../src/config.ts";

for (const value of [null, [], "x", 3, true]) {
  test(`rejects non-object config ${JSON.stringify(value)}`, () => assert.throws(() => normalizeConfig(value)));
}
for (const value of [{ version: 2 }, { surprise: true }, { enabled: 1 }, { color: "true" }, { preset: "maximum" }, { language: "zh" }, { palette: "rainbow" }, { palette: true }, { placement: "footer" }, { refreshMs: 249 }, { refreshMs: 2001 }, { refreshMs: NaN }, { git: null }, { git: { enabled: 1 } }, { git: { ttlMs: 9999 } }, { git: { timeoutMs: 1001 } }, { git: { shell: true } }]) {
  test(`rejects invalid config ${JSON.stringify(value)}`, () => assert.throws(() => normalizeConfig(value)));
}
test("palette defaults to pastel and accepts exactly the three documented modes", () => {
  assert.equal(normalizeConfig().palette, "pastel");
  assert.equal(DEFAULT_CONFIG.palette, "pastel");
  for (const palette of ["pastel", "theme", "mono"]) assert.equal(normalizeConfig({ palette }).palette, palette);
  assert.ok(Object.isFrozen(normalizeConfig({ palette: "theme" })));
});
test("configuration defaults are immutable and never enable Git", () => {
  const config = normalizeConfig({ preset: "full", git: { ttlMs: 10_000 } });
  assert.equal(config.git.enabled, false);
  assert.equal(DEFAULT_CONFIG.git.ttlMs, 30_000);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.git));
});
test("schema annotations are accepted, prototype keys are rejected", () => {
  assert.equal(normalizeConfig({ $schema: "./schema.json" }).version, 1);
  assert.throws(() => normalizeConfig({ $schema: 42 }));
  assert.throws(() => normalizeConfig(JSON.parse('{"__proto__":{"enabled":false}}')));
});
test("configuration paths respect an absolute user override", () => {
  const dir = resolve("config-test");
  assert.equal(configPath({ PI_HUD_CONFIG: join(dir, "hud.json") }), join(dir, "hud.json"));
  assert.equal(configPath({ PI_CODING_AGENT_DIR: dir }), join(dir, "pi-hud.json"));
  assert.throws(() => configPath({ PI_HUD_CONFIG: "relative.json" }));
  assert.throws(() => configPath({ PI_CODING_AGENT_DIR: "relative" }));
});
test("environment kill switch supports explicit negatives", () => {
  for (const value of [undefined, "", " ", "0", "false", "OFF", "no"]) assert.equal(isDisabled(value), false);
  for (const value of ["1", "true", "yes", "anything"]) assert.equal(isDisabled(value), true);
});
test("bounded asynchronous config loading handles missing, valid, invalid and oversized files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-hud-config-"));
  const file = join(dir, "hud.json");
  try {
    assert.equal((await readConfigFile(file)).found, false);
    await writeFile(file, '{"language":"zh-CN","git":{"enabled":false}}');
    assert.equal((await readConfigFile(file)).config.language, "zh-CN");
    await writeFile(file, "not-json");
    await assert.rejects(readConfigFile(file));
    await writeFile(file, " ".repeat(CONFIG_LIMIT + 1));
    await assert.rejects(readConfigFile(file), /32 KiB/);
    const sub = join(dir, "directory"); await mkdir(sub);
    await assert.rejects(readConfigFile(sub));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("read-only symlink configuration supports a synced configuration repository", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-hud-symlink-"));
  try {
    const target = join(dir, "target.json"); const link = join(dir, "hud.json");
    await writeFile(target, '{"preset":"minimal"}'); await symlink(target, link);
    assert.equal((await readConfigFile(link)).config.preset, "minimal");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
