import { HudState } from "../src/state.ts";
import { formatHud } from "../src/render.ts";
import { normalizeConfig } from "../src/config.ts";

// Synthetic fixture rendered by the production renderer; not a captured Pi session.
const state = new HudState("/workspace/pi-hud", { id: "example-model", name: "Example Model", provider: "demo", contextWindow: 200_000 }, 0);
state.thinking = "high";
state.messageEnd({ role: "assistant", stopReason: "stop", usage: { input: 12_000, cacheRead: 75_000, cacheWrite: 0, output: 3_000, cost: { total: 0.042 } } }, 1);
for (let i = 0; i < 5; i++) state.endTool({ toolCallId: String(i), toolName: "read", isError: false });
state.startTool({ toolCallId: "active", toolName: "edit", args: { path: "/workspace/pi-hud/src/state.ts" } });
state.bridge({ version: 1, source: "demo", kind: "agent", id: "review", status: "running", label: "Review implementation" }, 0);
state.bridge({ version: 1, source: "demo", kind: "tasks", id: "goal", completed: 3, total: 7, label: "Build Pi HUD" }, 0);
for (const language of ["en", "zh-CN"]) {
  for (const preset of ["minimal", "balanced", "full"]) {
    console.log(`\n${language} / ${preset} / 120 columns (synthetic fixture)`);
    for (const row of formatHud(state.snapshot(), normalizeConfig({ preset, language, color: false }), 120)) console.log(row.text);
  }
}
