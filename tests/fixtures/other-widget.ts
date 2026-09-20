/**
 * Live-protocol acceptance fixture: an independent second extension widget.
 *
 * Mounts its own named widget (key "other-widget-live", first row
 * "OTHER-WIDGET-ACTIVE") alongside the HUD's widget, so the concurrent-widget
 * scenario can assert real coexistence, HUD on/off isolation and surface
 * switching without the HUD ever disturbing another extension's widget.
 *
 * `/other-widget off` unmounts it; any other argument mounts it again.
 */
export default function otherWidgetExtension(pi) {
  const KEY = "other-widget-live";
  const mount = (ctx) => {
    if (typeof ctx?.ui?.setWidget !== "function") return;
    ctx.ui.setWidget(KEY, () => {
      return {
        render(width) {
          return ["OTHER-WIDGET-ACTIVE", "other widget row 2"].map((text) => text.slice(0, Math.max(0, width)));
        },
        dispose() {},
      };
    });
  };
  pi.on("session_start", (event, ctx) => mount(ctx));
  pi.registerCommand("other-widget", {
    description: "Control the independent widget used by live-protocol acceptance",
    handler: (args, ctx) => {
      if (String(args ?? "").trim() === "off") {
        try { ctx?.ui?.setWidget(KEY, undefined); } catch { /* already gone */ }
        return;
      }
      mount(ctx);
    },
  });
}
