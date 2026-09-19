import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const CONFIG_LIMIT = 32 * 1024;

export type HudPreset = "minimal" | "balanced" | "full";
export type HudPlacement = "aboveEditor" | "belowEditor";
export type HudLanguage = "en" | "zh-CN";
/** `pastel` uses the HUD's own soft palette, `theme` follows host theme tokens, `mono` is unstyled. */
export type HudPalette = "pastel" | "theme" | "mono";

export interface GitConfig {
  enabled: boolean;
  ttlMs: number;
  timeoutMs: number;
}

export interface HudConfig {
  version: number;
  enabled: boolean;
  preset: HudPreset;
  placement: HudPlacement;
  language: HudLanguage;
  palette: HudPalette;
  refreshMs: number;
  color: boolean;
  ascii: boolean;
  showCost: boolean;
  showThinking: boolean;
  git: GitConfig;
}

export interface LoadedConfig {
  config: HudConfig;
  found: boolean;
}

export const DEFAULT_CONFIG: Readonly<HudConfig> = Object.freeze({
  version: 1,
  enabled: true,
  preset: "balanced",
  placement: "belowEditor",
  language: "en",
  palette: "pastel",
  refreshMs: 250,
  color: true,
  ascii: false,
  showCost: true,
  showThinking: true,
  git: Object.freeze({ enabled: false, ttlMs: 30_000, timeoutMs: 500 }),
});

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);

export function normalizeConfig(input: unknown = {}): Readonly<HudConfig> {
  if (!record(input)) throw new Error("Configuration must be an object");
  for (const key of Object.keys(input)) {
    if (!own(DEFAULT_CONFIG, key) && key !== "$schema") throw new Error(`Unknown configuration key: ${key.slice(0, 80)}`);
  }
  if (own(input, "$schema") && typeof input.$schema !== "string") throw new Error("$schema must be a string");
  const result = { ...DEFAULT_CONFIG, ...input, git: { ...DEFAULT_CONFIG.git } } as HudConfig & Record<string, unknown>;
  delete result.$schema;
  if (result.version !== 1) throw new Error("Unsupported configuration version");
  for (const key of ["enabled", "color", "ascii", "showCost", "showThinking"]) {
    if (typeof result[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  for (const [key, values] of [
    ["preset", ["minimal", "balanced", "full"]],
    ["placement", ["aboveEditor", "belowEditor"]],
    ["language", ["en", "zh-CN"]],
    ["palette", ["pastel", "theme", "mono"]],
  ] as const) {
    if (!(values as readonly string[]).includes(result[key] as string)) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(result.refreshMs) || result.refreshMs < 250 || result.refreshMs > 2_000) {
    throw new Error("refreshMs must be an integer between 250 and 2000");
  }
  if (own(input, "git")) {
    if (!record(input.git)) throw new Error("git must be an object");
    for (const key of Object.keys(input.git)) {
      if (!own(DEFAULT_CONFIG.git, key)) throw new Error(`Unknown git key: ${key.slice(0, 80)}`);
    }
    Object.assign(result.git, input.git);
  }
  if (typeof result.git.enabled !== "boolean") throw new Error("git.enabled must be boolean");
  for (const [key, min, max] of [["ttlMs", 10_000, 600_000], ["timeoutMs", 100, 1_000]] as const) {
    if (!Number.isInteger(result.git[key]) || result.git[key] < min || result.git[key] > max) {
      throw new Error(`git.${key} must be an integer between ${min} and ${max}`);
    }
  }
  return Object.freeze({ ...result, git: Object.freeze(result.git) }) as Readonly<HudConfig>;
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.PI_HUD_CONFIG;
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error("PI_HUD_CONFIG must be an absolute path");
    return explicit;
  }
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (agentDir && !isAbsolute(agentDir)) throw new Error("PI_CODING_AGENT_DIR must be an absolute path");
  return join(agentDir || join(homedir(), ".pi", "agent"), "pi-hud.json");
}

/** Read at most 32 KiB + one overflow byte. Never runs in an event hook. */
export async function readConfigFile(path: string): Promise<LoadedConfig> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("HUD configuration must be a regular file");
    if (stat.size > CONFIG_LIMIT) throw new Error("HUD configuration exceeds 32 KiB");
    const buffer = Buffer.alloc(CONFIG_LIMIT + 1);
    // A file can grow after stat; the hard read limit still applies.
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > CONFIG_LIMIT) throw new Error("HUD configuration exceeds 32 KiB");
    return { config: normalizeConfig(JSON.parse(buffer.toString("utf8", 0, length))), found: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return { config: normalizeConfig(), found: false };
    throw error;
  } finally {
    await file?.close();
  }
}

export function isDisabled(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}
