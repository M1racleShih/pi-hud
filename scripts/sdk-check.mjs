/** Optional network-enabled CI step. The shipped extension has no SDK dependency. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { OBSERVED_EVENTS } from "../src/extension.ts";

const root = resolve(".tmp/sdk");
const sdk = join(root, "node_modules/@earendil-works/pi-coding-agent");
assert.equal(JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version, "0.85.1");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}\n');
const subscriptions = OBSERVED_EVENTS.map((name) => `pi.on(${JSON.stringify(name)}, (_event, ctx) => { terminalContext(ctx); });`).join("\n");
writeFileSync(join(root, "contract.ts"), `
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, SessionEntry, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { HUD_ROLES, THEME_ROLES } from "../../src/palette.ts";
import type { FooterDataLike, HudFooterComponent, HudIdentity } from "../../src/footer.ts";
import type { SessionEntryLike, SessionManagerLike } from "../../src/usage.ts";
import { SessionUsageLedger } from "../../src/usage.ts";
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
const structuralEntry: SessionEntryLike = sessionEntry;
const entryType: unknown = structuralEntry.type;
const entryParent: unknown = structuralEntry.parentId;
const entryUsage = structuralEntry.usage;
const tokenFields: number[] = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost.total];
void entryType; void entryParent; void entryUsage; void tokenFields;
const unsubscribe: () => void = pi.events.on("pi-hud:update", (_data: unknown) => {});
pi.events.emit("pi-hud:update", { version: 1 });
pi.registerCommand("hud-contract", { description: "contract only", handler: async (_args, ctx) => { terminalContext(ctx); } });
`);
copyFileSync("examples/bridge-demo.ts", join(root, "bridge-demo.ts"));
copyFileSync("examples/status-demo.ts", join(root, "status-demo.ts"));
const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
  "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext",
  "--allowImportingTsExtensions",
  join(root, "contract.ts"), join(root, "bridge-demo.ts"), join(root, "status-demo.ts")], { stdio: "inherit" });
assert.equal(result.status, 0, "Pinned Pi SDK API-contract check failed");
console.log("PASS: actual Pi 0.85.1 SDK event/UI/usage/bridge contracts and example types");
