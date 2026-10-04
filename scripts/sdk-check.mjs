/** Optional network-enabled CI step. The shipped extension has no SDK dependency. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { OBSERVED_EVENTS } from "../src/extension.ts";

const root = resolve(".tmp/sdk");
const sdk = join(root, "node_modules/@earendil-works/pi-coding-agent");
assert.equal(JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version, "1.0.2");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}\n');
const subscriptions = OBSERVED_EVENTS.map((name) => `pi.on(${JSON.stringify(name)}, (_event, ctx) => { terminalContext(ctx); });`).join("\n");
writeFileSync(join(root, "contract.ts"), `
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, SessionEntry, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { HUD_ROLES, THEME_ROLES } from "../../src/palette.ts";
import type { FooterDataLike, HudFooterComponent, HudIdentity } from "../../src/footer.ts";
import type { SessionEntryLike, SessionManagerLike } from "../../src/usage.ts";
import { SessionUsageLedger } from "../../src/usage.ts";
import { QuotaService } from "../../src/quota/service.ts";
import type { QuotaHostAuth } from "../../src/quota/types.ts";
declare const pi: ExtensionAPI;
// Every HUD role token must stay assignable to Pi's ThemeColor union.
const themeTokens: ThemeColor[] = HUD_ROLES.map((role) => THEME_ROLES[role]);
void themeTokens;
// The structural theme surface used by the widget and footer must exist on the real Theme class.
declare const hostTheme: Theme;
const colorMode: string = hostTheme.getColorMode();
const textAnsi: string = hostTheme.getFgAnsi("text");
const styledText: string = hostTheme.fg("accent", "HUD");
void colorMode; void textAnsi; void styledText;
// The HUD's structural footer data surface must accept the real read-only provider.
declare const provider: ReadonlyFooterDataProvider;
const footerData: FooterDataLike = provider;
const branch: string | null = footerData.getGitBranch();
const statuses: ReadonlyMap<string, string> = footerData.getExtensionStatuses();
const unsubscribeBranch: () => void = footerData.onBranchChange(() => {});
void branch; void statuses; void unsubscribeBranch;
declare const identity: HudIdentity;
function terminalContext(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  const idle: boolean = ctx.isIdle();
  const cwd: string = ctx.cwd;
  const thinking: string | undefined = ctx.thinkingLevel;
  const window: number | undefined = ctx.model?.contextWindow;
  // Pi resolves the session name from history, so the HUD caches it at lifecycle boundaries.
  const sessionName: string | undefined = ctx.sessionManager.getSessionName();
  void idle; void cwd; void thinking; void window; void sessionName;
  ctx.ui.setWidget("pi-hud-contract", (tui, theme) => ({
    invalidate() {}, dispose() {},
    render(width: number): string[] { return [theme.fg("accent", "HUD")]; }
  }), { placement: "belowEditor" });
  ctx.ui.setWidget("pi-hud-contract", undefined);
  // The footer slot is a single replacement slot; undefined restores the native footer.
  ctx.ui.setFooter((tui, theme, data) => {
    const component: HudFooterComponent = {
      invalidate() {}, dispose() {},
      render(width: number): string[] {
        const branchName: string | null = data.getGitBranch();
        for (const [, text] of data.getExtensionStatuses()) void text;
        return [theme.fg("dim", branchName ?? "")];
      },
    };
    void identity;
    return component;
  });
  ctx.ui.setFooter(undefined);
}
${subscriptions}
pi.on("session_info_changed", (event) => { const name: string | undefined = event.name; void name; });
// Pi 0.86+: pi.on returns an unsubscribe function; the HUD keeps its handlers for the
// extension lifetime, but the surface is pinned so a removal would be caught.
const offHandler: () => void = pi.on("session_info_changed", () => {});
void offHandler;
// Pi 0.87: turn_end carries required boundary entry ids; the HUD reads only, so the
// fields must stay present and assignable.
pi.on("turn_end", (event) => { const entryId: string = event.messageEntryId; const resultIds: string[] = event.toolResultEntryIds; void entryId; void resultIds; void event.turnIndex; void event.message; void event.toolResults; });
pi.on("message_end", (event) => {
  if (event.message.role !== "assistant") return;
  const usage = event.message.usage;
  const tokens: number = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const cost: number = usage.cost.total;
  const model: string = event.message.model;
  const provider: string = event.message.provider;
  void tokens; void cost; void model; void provider;
});
pi.on("tool_execution_start", (event) => { const id: string = event.toolCallId; const name: string = event.toolName; void event.args; void id; void name; });
pi.on("tool_execution_end", (event) => { const id: string = event.toolCallId; const error: boolean = event.isError; void id; void error; });
pi.on("model_select", (event) => { const id: string = event.model.id; const provider: string = event.model.provider; void id; void provider; });
pi.on("thinking_level_select", (event) => { const level: string = event.level; void level; });
// Phase 3 B2a: the session usage ledger reads the read-only entry surface at lifecycle
// boundaries. The structural HUD types must accept the real pinned SDK surfaces.
pi.on("turn_end", (event) => { const index: number = event.turnIndex; void index; void event.message; void event.toolResults; });
type SdkReadonlySessionManager = ExtensionContext["sessionManager"];
type SdkUsage = NonNullable<Extract<SessionEntry, { type: "compaction" }>["usage"]>;
declare const readonlyManager: SdkReadonlySessionManager;
const usageManager: SessionManagerLike = readonlyManager;
const ledger: SessionUsageLedger = new SessionUsageLedger({});
ledger.restart(usageManager, "contract");
ledger.onStructural("tree");
ledger.onStructural("compact");
ledger.onMessageEnd();
ledger.requestVerify();
ledger.deactivate();
declare const sessionEntry: SessionEntry;
declare const usage: SdkUsage;
// Pi 0.86/0.87 grew the SessionEntry union: standalone usage records (cache warming,
// folded into the session ledger) and append-only context_edit records (structurally
// ignored by the ledger). Both must stay assignable to the HUD's structural entry shape.
type SdkUsageEntry = Extract<SessionEntry, { type: "usage" }>;
type SdkContextEditEntry = Extract<SessionEntry, { type: "context_edit" }>;
declare const sdkUsageEntry: SdkUsageEntry;
declare const sdkContextEditEntry: SdkContextEditEntry;
const usageEntryLike: SessionEntryLike = sdkUsageEntry;
const contextEditLike: SessionEntryLike = sdkContextEditEntry;
const usageEntryUsage = usageEntryLike.usage;
void contextEditLike; void usageEntryUsage;
const structuralEntry: SessionEntryLike = sessionEntry;
const entryType: unknown = structuralEntry.type;
const entryParent: unknown = structuralEntry.parentId;
const entryUsage = structuralEntry.usage;
const tokenFields: number[] = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost.total];
void entryType; void entryParent; void entryUsage; void tokenFields;
const unsubscribe: () => void = pi.events.on("pi-hud:update", (_data: unknown) => {});
pi.events.emit("pi-hud:update", { version: 1 });
pi.registerCommand("hud-contract", { description: "contract only", handler: async (_args, ctx) => { terminalContext(ctx); } });
// Phase quota A: the opt-in quota service resolves credentials through the pinned
// SDK's model registry. The structural types must accept the real surfaces, and a
// resolved request auth must flow into the quota host-auth shape without secrets.
declare const registry: ExtensionContext["modelRegistry"];
const quotaAuth = async (model: ExtensionContext["model"]): Promise<QuotaHostAuth | null> => {
  if (!model) return null;
  const resolved = await registry.getApiKeyAndHeaders(model);
  if (!resolved.ok) return null;
  return { apiKey: resolved.apiKey, headers: resolved.headers, baseUrl: resolved.baseUrl };
};
const quotaService: QuotaService = new QuotaService({ resolveAuth: () => quotaAuth(hostModel) });
declare const hostModel: NonNullable<ExtensionContext["model"]>;
quotaService.configure({ enabled: true, ttlMs: 300_000, timeoutMs: 5_000, profiles: [] });
quotaService.onModel({ provider: hostModel.provider, id: hostModel.id });
quotaService.notify("settled");
quotaService.refreshManual();
const quotaView: ReturnType<QuotaService["view"]> = quotaService.view();
const quotaExpiry: number = quotaService.nextExpiry();
const quotaInspect: Record<string, unknown> = quotaService.inspect();
quotaService.cancelTasks();
quotaService.dispose();
void quotaView; void quotaExpiry; void quotaInspect;
`);
copyFileSync("examples/bridge-demo.ts", join(root, "bridge-demo.ts"));
copyFileSync("examples/status-demo.ts", join(root, "status-demo.ts"));
const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
  "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext",
  "--allowImportingTsExtensions",
  join(root, "contract.ts"), join(root, "bridge-demo.ts"), join(root, "status-demo.ts")], { stdio: "inherit" });
assert.equal(result.status, 0, "Pinned Pi SDK API-contract check failed");
console.log("PASS: actual Pi 1.0.2 SDK event/UI/usage/bridge contracts and example types");
