/**
 * Deterministic long-history fixtures for B2b ledger measurements and host acceptance.
 *
 * One builder produces two artifacts from the same seeded op stream:
 *  - `ops`:   replayable against a real pinned SessionManager (appendMessage /
 *             appendCompaction / branch / branchWithSummary), and
 *  - `entries`: the derived plain entry list (id/parentId assigned with the manager's
 *             semantics), usable directly as a JSONL session fixture or for array work.
 *
 * An independent oracle reducer (the native footer's four-category rule: assistant
 * always; toolResult only with usage; compaction/branch_summary only with usage) is
 * computed from `entries` - never from the ledger's own reducer.
 *
 * Record ratios are fixed by entry count:
 *   assistant+usage 42% | user 20% | toolResult+usage 18% | toolResult w/o usage 12%
 *   assistant w/o usage 3% | compaction+usage 2% | branch_summary+usage ~1.5% (branched)
 *   compaction w/o usage 1.5%
 *
 * Content blocks are ~220-character strings so entries carry realistic weight. Token
 * numbers are exact integers derived from the entry index, so repeated runs produce
 * identical fixtures and safe-integer sums. `shape: "linear"` keeps one parent chain;
 * `shape: "branched"` additionally places side branches (~15% of entries) by branching
 * back to earlier anchors, exactly like a tree-navigated real session.
 */

/** Deterministic PRNG (mulberry32); the seed is part of the measurement record. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");

export const usageFor = (n) => {
  const usage = {
    input: 900 + n,
    output: 300 + ((n * 7) % 400),
    cacheRead: 5_000 + ((n * 13) % 900),
    cacheWrite: 60 + (n % 97),
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number(((n % 997) + 1) / 100) },
  };
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
};

export function contentText(random, length = 220) {
  let text = "";
  while (text.length < length) text += WORDS[Math.floor(random() * WORDS.length)] + " ";
  return text.slice(0, length);
}

export const RATIOS = Object.freeze({
  assistantUsage: 0.42, user: 0.20, toolResultUsage: 0.18, toolResultPlain: 0.12,
  assistantNoUsage: 0.03, compactionUsage: 0.02, compactionNoUsage: 0.015, branchSide: 0.15,
});

/** Replay one fixture's op stream against a real SessionManager. */
export function replayOps(manager, fixture) {
  // The manager generates its own entry ids; map the fixture's simulated ids onto them
  // so later branch ops can reference earlier entries exactly as built.
  const idOf = new Map();
  let seq = 0;
  for (const op of fixture.ops) {
    if (op.op === "message") idOf.set(`f${++seq}`, manager.appendMessage(op.message));
    else if (op.op === "compaction") idOf.set(`f${++seq}`, manager.appendCompaction(op.summary, op.firstKeptEntryId ?? "", op.tokensBefore ?? 0, undefined, false, op.usage));
    else if (op.op === "branch") manager.branch(idOf.get(op.id));
    else if (op.op === "branchWithSummary") idOf.set(`f${++seq}`, manager.branchWithSummary(idOf.get(op.id), op.summary, undefined, false, op.usage));
    else throw new Error(`Unknown fixture op ${op.op}`);
  }
}

export function buildFixture(size, shape, seed = 0x0b2b_5eed) {
  if (shape !== "linear" && shape !== "branched") throw new Error(`Unknown shape ${shape}`);
  const random = prng((seed ^ (size * 0x9e37) ^ (shape === "branched" ? 0x51ed : 0x7c3d)) >>> 0);
  const ops = [];
  const entries = [];
  let seq = 0;
  let leaf = null;

  const simulate = (entry) => {
    const full = { id: `f${++seq}`, parentId: leaf, timestamp: "2026-09-20T00:00:00.000Z", ...entry };
    entries.push(full);
    leaf = full.id;
    return full.id;
  };
  const emit = (op) => {
    ops.push(op);
    if (op.op === "message") simulate({ type: "message", message: op.message });
    else if (op.op === "compaction") simulate({ type: "compaction", summary: op.summary, firstKeptEntryId: op.firstKeptEntryId, tokensBefore: op.tokensBefore, usage: op.usage });
    else if (op.op === "branchWithSummary") {
      const fromId = leaf ?? "root";
      leaf = op.id;
      simulate({ type: "branch_summary", fromId, summary: op.summary, usage: op.usage });
    } else if (op.op === "branch") leaf = op.id;
    else throw new Error(`Unknown fixture op ${op.op}`);
  };
  const assistantMessage = (n, usage) => ({
    role: "assistant",
    content: [{ type: "text", text: contentText(random) }],
    api: "openai-completions", provider: "fixture", model: random() < 0.5 ? "fixture-alpha" : "fixture-beta",
    usage, stopReason: "stop", timestamp: n,
  });

  // Fixed interleaving of record kinds, deterministically shuffled for a given key.
  const count = (fraction) => Math.round(size * fraction);
  const kinds = [];
  for (const [kind, fraction] of [
    ["assistant", RATIOS.assistantUsage], ["user", RATIOS.user],
    ["toolResultUsage", RATIOS.toolResultUsage], ["toolResultPlain", RATIOS.toolResultPlain],
    ["assistantNoUsage", RATIOS.assistantNoUsage], ["compaction", RATIOS.compactionUsage],
    ["compactionNoUsage", RATIOS.compactionNoUsage],
  ]) kinds.push(...Array(count(fraction)).fill(kind));
  while (kinds.length < size) kinds.push("user");
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }

  let appended = 0;
  const userAnchors = [];
  for (let n = 0; appended < size && n < size * 3; n++) {
    const kind = kinds[appended % kinds.length];
    if (kind === "user") { const before = entries.length; emit({ op: "message", message: { role: "user", content: [{ type: "text", text: contentText(random) }], timestamp: n } }); if (entries[entries.length - 1]?.type === "message" && entries.length > before) userAnchors.push(entries[entries.length - 1].id); }
    else if (kind === "assistant") emit({ op: "message", message: assistantMessage(n, usageFor(n)) });
    else if (kind === "assistantNoUsage") emit({ op: "message", message: assistantMessage(n, undefined) });
    else if (kind === "toolResultUsage") emit({ op: "message", message: { role: "toolResult", toolCallId: `call-${n}`, toolName: "read", content: [{ type: "text", text: contentText(random) }], usage: usageFor(n), isError: false, timestamp: n } });
    else if (kind === "toolResultPlain") emit({ op: "message", message: { role: "toolResult", toolCallId: `call-${n}`, toolName: "bash", content: [{ type: "text", text: contentText(random) }], isError: false, timestamp: n } });
    else if (kind === "compaction") emit({ op: "compaction", summary: contentText(random, 400), firstKeptEntryId: null, tokensBefore: 50_000 + n, usage: usageFor(n) });
    else if (kind === "compactionNoUsage") emit({ op: "compaction", summary: contentText(random, 400), firstKeptEntryId: null, tokensBefore: 50_000 + n, usage: undefined });
    appended++;
    // Branched shape: every ~40 main entries, branch back to an earlier anchor with a
    // summary, append 3-8 side entries, then return to the main tip (a second branch op).
    if (shape === "branched" && appended % 40 === 0 && entries.length > 60) {
      const anchorId = userAnchors[Math.floor(random() * userAnchors.length)] ?? entries[0].id;
      const mainTip = leaf;
      emit({ op: "branchWithSummary", id: anchorId, summary: contentText(random, 400), usage: usageFor(n) });
      const sideCount = 3 + Math.floor(random() * 6);
      for (let s = 0; s < sideCount; s++) {
        emit({ op: "message", message: assistantMessage(n + s + 1, s % 3 === 0 ? undefined : usageFor(n + s + 1)) });
      }
      emit({ op: "branch", id: mainTip });
    }
  }
  return {
    ops, entries,
    meta: {
      size, shape, seed,
      entryCount: entries.length,
      usageRecordCount: oracleTotals(entries).usageRecords,
      contentChars: 220, summaryChars: 400,
      ratios: RATIOS,
    },
  };
}

/**
 * Independent oracle reducer over plain entries: the native footer's four-category
 * rule with four separate token fields and cost.total summed separately.
 */
export function oracleTotals(entries) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usageRecords: 0, examined: 0 };
  for (const entry of entries) {
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
  return totals;
}
