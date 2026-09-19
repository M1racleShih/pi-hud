/** Optional, explicitly user-triggered demo. Not loaded by the pi-hud manifest. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function bridgeDemo(pi: ExtensionAPI) {
  pi.registerCommand("hud-demo", {
    description: "Emit synthetic HUD bridge data (run '/hud-demo clear' to remove)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const source = "pi-hud/demo";
      if (args.trim() === "clear") {
        pi.events.emit("pi-hud:update", { version: 1, source, kind: "clear" });
        return;
      }
      const done = args.trim() === "done";
      pi.events.emit("pi-hud:update", {
        version: 1, source, kind: "agent", id: "review",
        status: done ? "done" : "running", label: "DEMO: review implementation", ttlMs: 60_000,
      });
      pi.events.emit("pi-hud:update", {
        version: 1, source, kind: "tasks", id: "goal",
        completed: done ? 3 : 1, total: 3, label: "DEMO: build Pi HUD", ttlMs: 60_000,
      });
      ctx.ui.notify("Synthetic HUD data only; no agent or task was actually started.", "info");
    },
  });
}
