/**
 * Diagnostic-only fixture: logs event order, SessionManager entry counts and the
 * live session-file line count per event, to establish the commit ordering for
 * aborted turns. Test-only; never shipped.
 */
import { appendFileSync, readFileSync } from "node:fs";

export default function eventLogger(pi) {
  const path = process.env.EVENT_LOG;
  const log = (record) => {
    try { appendFileSync(path, JSON.stringify({ at: Date.now(), ...record }) + "\n"); } catch { /* diagnostics */ }
  };
  const events = ["session_start", "session_shutdown", "session_info_changed", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_end", "session_compact", "session_tree"];
  for (const name of events) {
    pi.on(name, (event, ctx) => {
      const record = { ev: name };
      try {
        const mgr = ctx?.sessionManager;
        if (mgr) {
          record.entries = mgr.getEntries().length;
          record.leaf = typeof mgr.getLeafId === "function" ? mgr.getLeafId() : "?";
        }
      } catch (error) { record.mgrErr = String(error); }
      try {
        const file = process.env.EVENT_SESSION_FILE;
        if (file) record.fileLines = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
      } catch { /* file may not exist yet */ }
      if (name === "turn_end") record.stopReason = event?.message?.stopReason;
      if (name === "message_end") record.role = event?.message?.role;
      if (name === "agent_end") record.msgCount = Array.isArray(event?.messages) ? event.messages.length : -1;
      log(record);
    });
  }
}
