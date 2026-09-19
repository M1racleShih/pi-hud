/**
 * Explicit demo for the HUD footer's bounded extension-status area.
 *
 * Pi's `ctx.ui.setStatus(key, text)` mutates one Map and asks the TUI to render; it is not a
 * HUD bridge event. This extension exists so the PTY smoke can prove that the installed HUD
 * footer picks up an independent extension's status change without any HUD event.
 *
 * It performs no I/O, no timers and no model calls.
 */
interface StatusUi {
  setStatus(key: string, text: string | undefined): void;
}

interface StatusContext {
  ui: StatusUi;
}

interface StatusApi {
  on(name: string, handler: (event: unknown, ctx: StatusContext) => void): void;
  registerCommand(name: string, command: { description: string; handler: (args: string, ctx: StatusContext) => void }): void;
}

const KEY = "pi-hud-status-demo";

export default function statusDemo(pi: StatusApi): void {
  pi.on("session_start", (_event, ctx) => { ctx.ui.setStatus(KEY, "DEMO status ready"); });
  pi.registerCommand("hud-status-demo", {
    description: "Set one extension status value to verify the HUD footer status area",
    handler: (args, ctx) => {
      const value = typeof args === "string" && args.trim() ? args.trim().slice(0, 40) : "changed";
      ctx.ui.setStatus(KEY, `DEMO status ${value}`);
    },
  });
}
