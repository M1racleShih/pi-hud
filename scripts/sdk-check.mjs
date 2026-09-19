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
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { HUD_ROLES, THEME_ROLES } from "../../src/palette.ts";
declare const pi: ExtensionAPI;
// Every HUD role token must stay assignable to Pi's ThemeColor union.
const themeTokens: ThemeColor[] = HUD_ROLES.map((role) => THEME_ROLES[role]);
void themeTokens;
// The structural theme surface used by the widget must exist on the real Theme class.
declare const hostTheme: Theme;
const colorMode: string = hostTheme.getColorMode();
const textAnsi: string = hostTheme.getFgAnsi("text");
const styledText: string = hostTheme.fg("accent", "HUD");
void colorMode; void textAnsi; void styledText;
function terminalContext(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  const idle: boolean = ctx.isIdle();
  const cwd: string = ctx.cwd;
  const thinking: string | undefined = ctx.thinkingLevel;
  const window: number | undefined = ctx.model?.contextWindow;
  ctx.ui.setWidget("pi-hud-contract", (tui, theme) => ({
    invalidate() {}, dispose() {},
    render(width: number): string[] { return [theme.fg("accent", "HUD")]; }
  }), { placement: "belowEditor" });
  ctx.ui.setWidget("pi-hud-contract", undefined);
}
${subscriptions}
pi.on("message_end", (event) => {
  if (event.message.role !== "assistant") return;
  const usage = event.message.usage;
  const tokens: number = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const cost: number = usage.cost.total;
  const model: string = event.message.model;
  const provider: string = event.message.provider;
});
pi.on("tool_execution_start", (event) => { const id: string = event.toolCallId; const name: string = event.toolName; void event.args; });
pi.on("tool_execution_end", (event) => { const id: string = event.toolCallId; const error: boolean = event.isError; });
pi.on("model_select", (event) => { const id: string = event.model.id; });
pi.on("thinking_level_select", (event) => { const level: string = event.level; });
const unsubscribe: () => void = pi.events.on("pi-hud:update", (_data: unknown) => {});
pi.events.emit("pi-hud:update", { version: 1 });
pi.registerCommand("hud-contract", { description: "contract only", handler: async (_args, ctx) => { terminalContext(ctx); } });
`);
copyFileSync("examples/bridge-demo.ts", join(root, "bridge-demo.ts"));
const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
  "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext",
  "--allowImportingTsExtensions",
  join(root, "contract.ts"), join(root, "bridge-demo.ts")], { stdio: "inherit" });
assert.equal(result.status, 0, "Pinned Pi SDK API-contract check failed");
console.log("PASS: actual Pi 0.85.1 SDK event/UI/usage/bridge contracts and example types");
