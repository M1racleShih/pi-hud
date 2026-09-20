/**
 * Build a real Pi session JSONL file from a deterministic fixture, for the real-host
 * resume acceptance (a long history the TUI must load and the ledger must baseline).
 *
 *   node scripts/usage-session-file.mjs <out.jsonl> [--size=10000] [--shape=linear|branched] [--seed=0x0b2b5eed] [--name=Title] [--sameSummary]
 *
 * `--sameSummary` rewrites every fixture compaction summary to the same fixed text, so a
 * resumed session exercises the pinned SDK's `find(summary === summary)` hazard: the
 * `session_compact` event entry may point at an OLD compaction. The ledger must count
 * the newly appended one exactly once regardless (proved against this file's oracle).
 *
 * The header is a version-3 session header; every entry keeps the fixture's
 * id/parentId/timestamp, so linear and branched shapes load as real trees.
 *
 * Host-safety note: Pi 0.85.1's native footer aggregates every assistant entry with
 * `addUsageToTotals(entry.message.usage)` and crashes when an assistant message has no
 * usage object (real provider sessions always fill it). The written file therefore
 * injects deterministic usage into the fixture's deliberate assistant-without-usage
 * records; the HUD's missing-data paths stay covered by the in-process fixtures,
 * unit tests and the pinned-SDK oracle, which never run the native footer.
 */
import { writeFileSync } from "node:fs";
import { buildFixture, usageFor } from "./usage-fixtures.mjs";

const argument = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const [target] = process.argv.filter((item) => !item.startsWith("--")).slice(2);
if (!target) {
  console.error("usage: node scripts/usage-session-file.mjs <out.jsonl> [--size=10000] [--shape=linear|branched] [--seed=0x0b2b5eed] [--name=Title]");
  process.exit(1);
}
const size = Number(argument("size") ?? 10_000);
const shape = argument("shape") ?? "linear";
const seedRaw = argument("seed") ?? "0x0b2b5eed";
const seed = Number(seedRaw);
const name = argument("name");
const cwd = argument("cwd") ?? process.cwd();
const sameSummary = process.argv.includes("--sameSummary");

const fixture = buildFixture(size, shape, seed);
const header = {
  type: "session",
  version: 3,
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  cwd,
  ...(name ? { name } : {}),
};
const lines = [JSON.stringify(header)];
// Session-name info entry right after the header when a name was requested.
if (name) lines.push(JSON.stringify({ type: "session_info", id: "aa000001", parentId: null, timestamp: new Date().toISOString(), name }));
for (const entry of fixture.entries) {
  const clone = { ...entry };
  // Session-entry fields the loader expects on every tree node.
  if (!("parentId" in clone)) clone.parentId = null;
  if (clone.type === "message" && clone.message?.role === "assistant" && !clone.message.usage) {
    const index = Number(clone.id.slice(1));
    clone.message = { ...clone.message, usage: usageFor(700_000 + index) };
  }
  if (sameSummary && clone.type === "compaction") clone.summary = "FIXTURE-SUMMARY";
  lines.push(JSON.stringify(clone));
}
writeFileSync(target, lines.join("\n") + "\n");
console.log(JSON.stringify({ target, header: header.id, ...fixture.meta }));
