/**
 * B2b real-host acceptance fixture: an independent second footer extension.
 *
 * Claims Pi's single footer slot with its own two-line component (marking text
 * "OTHER-FOOTER-ACTIVE"). Together with load order this exercises the dual-footer
 * coexistence matrix: whichever extension installs later owns the slot, the HUD must
 * stay suppressed (never clear another extension's footer), and an explicit
 * `/hud surface footer` must re-claim the slot.
 *
 * `/other-footer off` releases the slot back to the native footer so the harness can
 * also observe what the HUD does when the slot becomes free without claiming it.
 */
export default function otherFooterExtension(pi) {
  let installed = null;
  let disposed = false;
  const install = (ctx) => {
    if (typeof ctx?.ui?.setFooter !== "function") return;
    disposed = false;
    ctx.ui.setFooter(() => {
      const component = {
        render(width) {
          return ["OTHER-FOOTER-ACTIVE", "other footer row 2"].map((text) => text.slice(0, Math.max(0, width)));
        },
        dispose() { disposed = true; },
      };
      installed = component;
      return component;
    });
  };
  pi.on("session_start", (event, ctx) => install(ctx));
  pi.registerCommand("other-footer", {
    description: "Control the independent footer used by B2b acceptance",
    handler: (args, ctx) => {
      const action = String(args ?? "").trim();
      if (action === "off") {
        if (typeof ctx?.ui?.setFooter === "function") ctx.ui.setFooter(undefined);
        installed = null;
        return;
      }
      install(ctx);
    },
  });
}
