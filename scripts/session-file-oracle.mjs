/**
 * Independent full-history oracle over a real Pi session JSONL file.
 *
 * Applies the native footer's four-category aggregation rule (assistant always;
 * toolResult only with usage; compaction/branch_summary only with usage) with the
 * four token fields and cost.total summed separately. Written against the documented
 * session format, not against the HUD's reducer, so agreement with the ledger is
 * evidence. Reads EVERY entry in the file, which is exactly the ledger's contract
 * scope (all branches, pre-compaction messages, summaries).
 *
 *   node scripts/session-file-oracle.mjs <session.jsonl>
 */
import { readFileSync } from "node:fs";

const [target] = process.argv.filter((item) => !item.startsWith("--")).slice(2);
if (!target) {
  console.error("usage: node scripts/session-file-oracle.mjs <session.jsonl>");
  process.exit(1);
}

const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usageRecords: 0, examined: 0, entries: 0 };
const text = readFileSync(target, "utf8");
for (const line of text.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let entry;
  try { entry = JSON.parse(trimmed); } catch { continue; }
  if (entry.type === "session") continue;
  totals.entries++;
  totals.examined++;
  let usage = null;
  if (entry.type === "message" && entry.message) {
    if (entry.message.role === "assistant") usage = entry.message.usage ?? null;
    else if (entry.message.role === "toolResult") usage = entry.message.usage ?? null;
  } else if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage ?? null;
  if (!usage) continue;
  totals.input += usage.input; totals.output += usage.output;
  totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost ? usage.cost.total : 0;
  totals.usageRecords++;
}
console.log(JSON.stringify(totals));
