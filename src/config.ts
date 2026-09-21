import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ZAI_ORIGINS } from "./quota/adapters/zai.ts";

export const CONFIG_LIMIT = 32 * 1024;

export type HudPreset = "minimal" | "balanced" | "full";
export type HudPlacement = "aboveEditor" | "belowEditor";
export type HudLanguage = "en" | "zh-CN";
/** `pastel` uses the HUD's own soft palette, `theme` follows host theme tokens, `mono` is unstyled. */
export type HudPalette = "pastel" | "theme" | "mono";
/**
 * `widget` keeps the named widget above/below the editor next to Pi's native footer.
 * `footer` replaces the native footer through `ui.setFooter` and does not mount the widget.
 */
export type HudSurface = "widget" | "footer";
/**
 * `observed` (default) keeps the low-cost counters since this attachment/reset.
 * `session` additionally builds the optional full-session ledger from the current
 * SessionManager's entries (see src/usage.ts); the display then labels totals `sess*`.
 */
export type HudUsageScope = "observed" | "session";

export interface GitConfig {
  enabled: boolean;
  ttlMs: number;
  timeoutMs: number;
}

/** Logical quota adapters. Only `zai` is implemented in this slice; the others are
 *  reserved names so configurations can be validated (and diagnosed) before their
 *  account-verified implementations land (docs/PROVIDER-LIMITS-PLAN.zh-CN.md §9). */
export type QuotaAdapterName = "zai" | "minimax" | "codex" | "gemini-cli" | "deepseek" | "siliconflow";
export type QuotaSourceName = "pi" | "codex-app-server";
export type QuotaRegionName = "cn" | "global";
export type QuotaPlanName = "personal" | "team";
export type QuotaQueryMode = "personal-legacy" | "personal" | "team";

/** One quota identity binding. Never carries credentials: keys are resolved from the
 *  host at query time, so no profile field can store a raw key or token. */
export interface QuotaProfile {
  id: string;
  providerId: string;
  adapter: QuotaAdapterName;
  source: QuotaSourceName;
  enabled: boolean;
  region?: QuotaRegionName;
  plan?: QuotaPlanName;
  queryMode?: QuotaQueryMode;
  organizationId?: string;
  projectId?: string;
  modelIds?: readonly string[];
  origin?: string;
}

export interface QuotaConfig {
  enabled: boolean;
  ttlMs: number;
  timeoutMs: number;
  profiles: readonly QuotaProfile[];
}

export interface HudConfig {
  version: number;
  enabled: boolean;
  preset: HudPreset;
  surface: HudSurface;
  placement: HudPlacement;
  language: HudLanguage;
  palette: HudPalette;
  /** Which usage numbers the usage fields show; scopes never change acquisition defaults. */
  usageScope: HudUsageScope;
  refreshMs: number;
  color: boolean;
  ascii: boolean;
  showCost: boolean;
  showThinking: boolean;
  /** Show the `spd*` generation-speed field (measurement always runs; see docs/TOKEN-SPEED.zh-CN.md). */
  showSpeed: boolean;
  git: GitConfig;
  /** Optional provider quota support; default off (no auth parsing, network or tasks). */
  quota: QuotaConfig;
}

export interface LoadedConfig {
  config: HudConfig;
  found: boolean;
}

export const DEFAULT_QUOTA: Readonly<QuotaConfig> = Object.freeze({
  enabled: false,
  ttlMs: 300_000,
  timeoutMs: 5_000,
  profiles: Object.freeze([]),
});

export const DEFAULT_CONFIG: Readonly<HudConfig> = Object.freeze({
  version: 1,
  enabled: true,
  preset: "balanced",
  surface: "footer",
  placement: "belowEditor",
  language: "en",
  palette: "pastel",
  usageScope: "observed",
  refreshMs: 250,
  color: true,
  ascii: false,
  showCost: true,
  showThinking: true,
  showSpeed: true,
  git: Object.freeze({ enabled: false, ttlMs: 30_000, timeoutMs: 500 }),
  quota: DEFAULT_QUOTA,
});

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);

const QUOTA_ADAPTERS: readonly QuotaAdapterName[] = ["zai", "minimax", "codex", "gemini-cli", "deepseek", "siliconflow"];
const QUOTA_REGIONAL: readonly QuotaAdapterName[] = ["zai", "minimax"];
/** Verified plan/queryMode combinations (docs/GLM-PLAN-SCOPES.zh-CN.md §2/§9). */
const ZAI_MODES: readonly [QuotaPlanName, QuotaQueryMode][] = [["personal", "personal-legacy"], ["personal", "personal"], ["team", "team"]];
const cleanId = (value: unknown, max: number): string | null => {
  if (typeof value !== "string" || value.length < 1 || value.length > max) return null;
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value;
};

export function normalizeQuotaProfile(input: unknown): Readonly<QuotaProfile> {
  if (!record(input)) throw new Error("quota profile must be an object");
  for (const key of Object.keys(input)) {
    if (!["id", "providerId", "adapter", "source", "enabled", "region", "plan", "queryMode", "organizationId", "projectId", "modelIds", "origin"].includes(key)) {
      throw new Error(`Unknown quota profile key: ${key.slice(0, 80)}`);
    }
  }
  const id = cleanId(input.id, 64);
  const providerId = cleanId(input.providerId, 64);
  if (!id) throw new Error("quota profile id must be 1-64 characters without control characters");
  if (!providerId) throw new Error(`quota profile ${id}: providerId must be 1-64 characters without control characters`);
  const adapter = input.adapter as QuotaAdapterName;
  if (!QUOTA_ADAPTERS.includes(adapter)) throw new Error(`quota profile ${id}: invalid adapter`);
  if (input.source !== "pi" && input.source !== "codex-app-server") throw new Error(`quota profile ${id}: source must be pi or codex-app-server`);
  if ((input.source === "codex-app-server") !== (adapter === "codex")) {
    throw new Error(`quota profile ${id}: source ${input.source} is not valid for adapter ${adapter}`);
  }
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") throw new Error(`quota profile ${id}: enabled must be boolean`);
  const source = input.source;
  const profile: QuotaProfile = { id, providerId, adapter, source, enabled };
  if (input.enabled === undefined) delete (profile as { enabled?: boolean }).enabled;
  if (input.region !== undefined) {
    if (input.region !== "cn" && input.region !== "global") throw new Error(`quota profile ${id}: region must be cn or global`);
    if (!QUOTA_REGIONAL.includes(adapter)) throw new Error(`quota profile ${id}: region is not a valid field for adapter ${adapter}`);
    profile.region = input.region;
  }
  const hasPlan = input.plan !== undefined || input.queryMode !== undefined;
  if (adapter !== "zai" && hasPlan) throw new Error(`quota profile ${id}: plan/queryMode are only valid for the zai adapter`);
  if (adapter === "zai") {
    if (!hasPlan) throw new Error(`quota profile ${id}: plan and queryMode are required for the zai adapter`);
    const plan = input.plan as QuotaPlanName;
    const queryMode = input.queryMode as QuotaQueryMode;
    if (!ZAI_MODES.some(([candidatePlan, candidateMode]) => candidatePlan === plan && candidateMode === queryMode)) {
      throw new Error(`quota profile ${id}: invalid plan/queryMode combination ${String(plan)}/${String(queryMode)}`);
    }
    profile.plan = plan;
    profile.queryMode = queryMode;
    if (!profile.region) throw new Error(`quota profile ${id}: region is required for the zai adapter`);
  }
  if (input.organizationId !== undefined || input.projectId !== undefined) {
    if (adapter !== "zai") throw new Error(`quota profile ${id}: organizationId/projectId are only valid for the zai adapter`);
    if (input.organizationId !== undefined) {
      const organizationId = cleanId(input.organizationId, 128);
      if (!organizationId) throw new Error(`quota profile ${id}: organizationId must be 1-128 characters without control characters`);
      profile.organizationId = organizationId;
    }
    if (input.projectId !== undefined) {
      const projectId = cleanId(input.projectId, 128);
      if (!projectId) throw new Error(`quota profile ${id}: projectId must be 1-128 characters without control characters`);
      profile.projectId = projectId;
    }
  }
  if (input.modelIds !== undefined) {
    if (!Array.isArray(input.modelIds) || input.modelIds.length < 1 || input.modelIds.length > 16) {
      throw new Error(`quota profile ${id}: modelIds must be an array of 1-16 model ids`);
    }
    const modelIds: string[] = [];
    for (const item of input.modelIds) {
      const modelId = cleanId(item, 160);
      if (!modelId) throw new Error(`quota profile ${id}: modelIds entries must be 1-160 characters without control characters`);
      if (modelIds.includes(modelId)) throw new Error(`quota profile ${id}: duplicate model id ${modelId.slice(0, 40)}`);
      modelIds.push(modelId);
    }
    profile.modelIds = Object.freeze(modelIds);
  }
  if (input.origin !== undefined) {
    if (adapter !== "zai") throw new Error(`quota profile ${id}: origin is only valid for the zai adapter`);
    const origin = normalizeQuotaOrigin(input.origin);
    if (!origin) throw new Error(`quota profile ${id}: origin must be an https URL like https://open.bigmodel.cn`);
    // §9: the origin must match the adapter's fixed domain table exactly (per region).
    const tableOrigin = ZAI_ORIGINS[input.region === "global" ? "global" : "cn"];
    if (origin !== tableOrigin) {
      throw new Error(`quota profile ${id}: origin must be ${tableOrigin} for region ${input.region === "global" ? "global" : "cn"}`);
    }
    profile.origin = origin;
  }
  return Object.freeze(profile);
}

/** Adapter-fixed https origins (docs/GLM-PLAN-SCOPES.zh-CN.md §9). The query URL is built
 *  from this table, never from a model baseUrl. */
export function normalizeQuotaOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function normalizeQuota(input: unknown): Readonly<QuotaConfig> {
  if (!record(input)) throw new Error("quota must be an object");
  for (const key of Object.keys(input)) {
    if (!own(DEFAULT_QUOTA, key)) throw new Error(`Unknown quota key: ${key.slice(0, 80)}`);
  }
  const result: QuotaConfig = {
    enabled: input.enabled === undefined ? DEFAULT_QUOTA.enabled : input.enabled as boolean,
    ttlMs: input.ttlMs === undefined ? DEFAULT_QUOTA.ttlMs : input.ttlMs as number,
    timeoutMs: input.timeoutMs === undefined ? DEFAULT_QUOTA.timeoutMs : input.timeoutMs as number,
    profiles: [],
  };
  if (typeof result.enabled !== "boolean") throw new Error("quota.enabled must be boolean");
  for (const [key, min, max] of [["ttlMs", 30_000, 3_600_000], ["timeoutMs", 1_000, 30_000]] as const) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) {
      throw new Error(`quota.${key} must be an integer between ${min} and ${max}`);
    }
  }
  if (input.profiles === undefined) {
    result.profiles = Object.freeze([]);
  } else {
    if (!Array.isArray(input.profiles) || input.profiles.length > 16) {
      throw new Error("quota.profiles must be an array with at most 16 profiles");
    }
    const profiles: QuotaProfile[] = [];
    const seen = new Set<string>();
    for (const item of input.profiles) {
      const profile = normalizeQuotaProfile(item);
      if (seen.has(profile.id)) throw new Error(`Duplicate quota profile id: ${profile.id.slice(0, 64)}`);
      seen.add(profile.id);
      profiles.push(profile);
    }
    result.profiles = Object.freeze(profiles);
  }
  return Object.freeze(result);
}

export function normalizeConfig(input: unknown = {}): Readonly<HudConfig> {
  if (!record(input)) throw new Error("Configuration must be an object");
  for (const key of Object.keys(input)) {
    if (!own(DEFAULT_CONFIG, key) && key !== "$schema") throw new Error(`Unknown configuration key: ${key.slice(0, 80)}`);
  }
  if (own(input, "$schema") && typeof input.$schema !== "string") throw new Error("$schema must be a string");
  const result = { ...DEFAULT_CONFIG, ...input, git: { ...DEFAULT_CONFIG.git } } as HudConfig & Record<string, unknown>;
  delete result.$schema;
  // `quota` is rebuilt from its own validator so a rejected profile list can never leak
  // a partially merged object; the previous configuration stays active on any failure.
  result.quota = own(input, "quota") ? normalizeQuota(input.quota) : Object.freeze({
    enabled: DEFAULT_QUOTA.enabled, ttlMs: DEFAULT_QUOTA.ttlMs, timeoutMs: DEFAULT_QUOTA.timeoutMs, profiles: Object.freeze([]),
  });
  if (result.version !== 1) throw new Error("Unsupported configuration version");
  for (const key of ["enabled", "color", "ascii", "showCost", "showThinking", "showSpeed"]) {
    if (typeof result[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  for (const [key, values] of [
    ["preset", ["minimal", "balanced", "full"]],
    ["surface", ["widget", "footer"]],
    ["placement", ["aboveEditor", "belowEditor"]],
    ["language", ["en", "zh-CN"]],
    ["palette", ["pastel", "theme", "mono"]],
    ["usageScope", ["observed", "session"]],
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
  return Object.freeze({ ...result, git: Object.freeze(result.git), quota: result.quota }) as Readonly<HudConfig>;
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
