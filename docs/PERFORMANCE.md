# Performance objective and evidence

[README](../README.md) · [Verification](VERIFICATION.md) · [Raw baseline](performance-baseline.json)

## Objective, not an absolute guarantee

The requirement is no perceptible marginal effect on streaming, tool dispatch or terminal input. pi-hud cannot guarantee equivalence on every CPU, terminal, provider, filesystem or extension combination. It can remove unnecessary work, bound remaining work, test its structure and provide a repeatable acceptance protocol. A same-process extension necessarily has nonzero load/dispatch/render costs.

The default configuration avoids additional Git processes, all network activity, per-token subscriptions, history traversal, polling and animation. Disabling optional Git is part of the strict low-contention profile. Config is one capped asynchronous read per attachment/reload. Bridge records may keep a single expiration timer alive; no records means no recurring idle work. External event producers still control how often they call the bridge.

## Reproduce the synthetic benchmark

```sh
npm test
node bench/run.mjs --check --json=performance-result.json
```

The committed baseline was captured at `2026-09-19T11:20:01.275Z` on `linux/x64`, Node `v22.16.0`, `AMD EPYC 9V74 80-Core Processor`. Node 22.16.0 is the available sandbox runtime, **older than the Pi target's 22.19.0 minimum**: this measures the standalone extension modules, not a supported Pi host execution. The prepared CI uses Node 22.19.0 and 24.

| Measurement | Baseline | Regression budget |
| --- | ---: | ---: |
| Final assistant-message handler, p99 | 2.724 µs | ≤ 250 µs |
| Tool start + end pair, p99 (combined) | 4.086 µs | ≤ 250 µs |
| Uncached full three-row render, p99 | 0.891 ms | ≤ 5 ms |
| Cached render, bulk-loop mean | 0.0119 µs | ≤ 5 µs |

The hook samples use 2,000 warmups and 12,000 observations. Assistant fixtures include provider/model identity and reported cache/cost usage. Full-layout rendering includes Chinese and emoji at 120 columns, with 3,000 uncached samples. Phase-2 scenarios add a category-saturated full layout (16 retained names plus `other`, three concurrent tools, an interruption) at 120/180 columns and a concurrent-activity balanced layout at 120/40 columns; they run against the same unchanged gates. Phase-3 scenarios render the optional footer surface (full/balanced/narrow/without statuses) through `HudFooterView` and add `cachedFooterRenderMeanUs ≤ 5 µs` for the footer's cached path, where the bounded status comparison runs on every host-invoked render. The cached measures loop one million times and verifies object-identical cache hits. That tiny optimized bulk-loop average is **not an input-to-paint latency**, does not include terminal rendering, and must not be advertised as the TUI response time. Warm JIT, GC, OS scheduling and timing overhead affect all numbers; a single-host microbenchmark is not a deployment guarantee.

The synthetic 100,000-tool-event burst asserts **one pending publication timer and one publication**, bounded recent IDs (128), no retained completed tools, and zero extra publications across 60,000 ms of fake-clock idle time. A separate 50,000-event flood of unique tool names asserts that the retained per-name ledger stays at 16 entries, that the synthetic overflow record stays separate (so a real tool named `other` keeps its own counters). This is a deterministic scheduling/structure test, not a real minute of CPU/RSS sampling. A one-million-frame cache loop proves reuse for unchanged inputs; host invalidation or resizing necessarily changes that condition.

Thresholds in `bench/run.mjs` are regression gates, not perceptual thresholds established by a user study. Results may fluctuate. Investigate a failed runner with repeated controlled trials; do not simply increase the budget to make CI green. Structural tests are at least as important as a noisy timing gate.

## Phase 1 field colors: same-machine before/after

Field colors and bounded semantic segments changed the renderer, so the phase was measured against the pre-change commit on the same host in one session. The gates were **not** changed; the mono, narrow-40 and cached scenarios were added as extra checks. Raw per-run data is in [performance-phase1-ab.json](performance-phase1-ab.json).

Method: `git worktree` of the pre-change commit as the before side, the working tree as the after side, identical fixtures, 12,000 hook samples, 3,000 uncached 120-column full-preset render samples, and a 1,000,000-frame cache loop per run. Four pairs ran before-then-after and four ran after-then-before to expose ordering bias. The numbers below were captured after the narrow-width context fix, so they describe the final renderer.

| Measurement | Before (mean of 8) | After (mean of 8) | Delta |
| --- | ---: | ---: | ---: |
| Final assistant-message handler, p99 | 1.159 µs | 1.219 µs | +5.2% (sub-microsecond noise) |
| Tool start + end pair, p99 | 2.079 µs | 2.020 µs | −2.8% |
| Uncached full render, p50 | 38.0 µs | 22.6 µs | −40.6% |
| Uncached full render, p95 | 68.6 µs | 41.7 µs | −39.3% |
| Uncached full render, p99 | 417.5 µs | 586.4 µs | +40.5% |
| Uncached full render, mean | 50.2 µs | 33.8 µs | −32.7% |
| Cached render, bulk-loop mean | 0.00596 µs | 0.00543 µs | −8.8% |
| Layout-only (mono) render, mean | — | 34.3 µs | new scenario |
| Narrow 40-column render, mean | — | 26.9 µs | new scenario |

The common path improved: field widths are measured once during layout, so segments cost less than the old whole-line packing. Styling itself is not measurable in the mean (34.3 µs layout-only versus 33.8 µs fully styled). The p99 tail is higher and reproduces tightly in this session (after 569–598 µs versus before 410–430 µs) against the unchanged 5 ms gate, leaving roughly eight times of headroom. A separate 200,000-render `--trace-gc` run attributes the tail to garbage collection rather than renderer work: the new renderer produced **fewer** scavenges (1,453 versus 3,196) with a larger mean pause (0.85 ms versus 0.34 ms), for roughly equal total collector time per render (6.1 µs versus 5.5 µs). Forced GC and a larger semi-space did not remove the tail. That 200k-render burst ran at roughly 29,000 renders/s, thousands of times the sustained uncached-render rate of a real session (at most one recompute per 250 ms coalesced publication, with every stream frame taking the cached path). No gate, budget or sample count was relaxed to accommodate this, and the structural burst assertions (one pending timer, one publication, bounded records) still pass.

**These are synthetic microbenchmarks, not a live Pi/provider/terminal A/B.** The real-host streaming, tool-dispatch and keyboard-latency acceptance procedure below is still required before any release claim.

## Phase 2 bounded activity information: same-machine before/after

The per-tool-name category ledger, aggregate error count and recent-completion summary changed `state.ts` and `render.ts`, so the phase was measured against the pre-change commit (`622c949`) on the same host in one session. The gates were **not** changed. The after side also contains a `text.ts` fast path: `visibleWidth`/`clip` now sum code points directly and only fall back to `Intl.Segmenter` when a real grapheme-cluster candidate (mark, ZWJ, variation selector, emoji, regional indicator) is present. The new fields carry the HUD's own `✓`/`~` glyphs, and the segmenter cost on those strings dominated the render. A seeded differential fuzz test asserts the fast path matches the segmenter-based reference; the existing CJK/emoji/cluster width tests are unchanged. Raw per-run data is in [performance-phase2-ab.json](performance-phase2-ab.json).

Method: `git worktree` of the pre-change commit as the before side; the same tree-agnostic probe file (`scripts/perf-ab.mjs`) copied into both worktrees; identical fixtures and sample counts (2,000 warmups + 12,000 hook observations, 3,000 uncached render samples per scenario, a 1,000,000-frame cache loop per run). Eight pairs ran, alternating before-then-after and after-then-before, for 8 runs per side. Render fixtures are plain snapshot objects shared by both trees; the pre-change renderer ignores the phase-2 fields it does not know. `renders.baselineFull120` has no category ledger on either side, so it isolates the shared layout and the text fast path, while `saturatedFull120`/`concurrentBalanced*` exercise the new activity information.

| Measurement | Before (mean of 8) | After (mean of 8) | Delta |
| --- | ---: | ---: | ---: |
| Final assistant-message handler, p99 | 1.208 µs | 1.248 µs | +3.3% (+0.04 µs paired, noise) |
| Tool start + end pair, p99 | 2.287 µs | 2.523 µs | +10.3% (+0.24 µs paired) |
| Uncached full render, baseline fixture, p50 | 24.08 µs | 5.05 µs | −79.0% |
| Uncached full render, baseline fixture, mean | 34.63 µs | 6.27 µs | −81.9% |
| Uncached full render, baseline fixture, p99 | 387.5 µs | 38.3 µs | −90.1% |
| Uncached full render, category-saturated, p50 | 24.19 µs | 7.36 µs | −69.6% |
| Uncached full render, category-saturated, mean | 34.29 µs | 9.16 µs | −73.3% |
| Uncached full render, category-saturated, p95 | 39.61 µs | 12.48 µs | −68.5% |
| Uncached full render, category-saturated, p99 | 677.2 µs | 68.5 µs | −89.9% |
| Uncached full render, category-saturated, 180 columns, mean | 29.27 µs | 8.77 µs | −70.0% |
| Uncached full render, category-saturated, mono, mean | 34.44 µs | 7.55 µs | −78.1% |
| Uncached balanced render, concurrent activity, mean | 26.72 µs | 6.53 µs | −75.6% |
| Uncached balanced render, concurrent activity, p99 | 70.9 µs | 23.5 µs | −66.8% |
| Uncached balanced render, concurrent activity, 40 columns, mean | 17.72 µs | 5.15 µs | −70.9% |
| Uncached full render, empty idle row, mean | 20.56 µs | 2.83 µs | −86.2% |
| Cached render, bulk-loop mean | 0.0050 µs | 0.0050 µs | −1.0% (noise) |

Paired per-run deltas (after − before within one pair) make the direction clearer than the means: every render comparison improved in 8/8 pairs (baseline −28.4 ± 0.9 µs, category-saturated −25.1 ± 1.2 µs, concurrent activity −20.2 ± 0.8 µs, empty idle row −17.7 ± 0.6 µs), the tool-pair hook p99 rose in 7/8 pairs by +0.24 ± 0.43 µs, the final-message hook p99 was +0.04 ± 0.28 µs with 2/8 positive (indistinguishable from noise), and the cached loop was −0.0001 ± 0.0003 µs (also noise). The hook increase is the per-completion category lookup and bounded ring update; its paired-mean cost is 0.24 µs, about 1000× below the 250 µs gate. Within the after side, the category-saturated fixture still costs about +2.9 µs mean over the same-tree fixture without a ledger at 120 columns, while the idle row is cheaper because zero-count and empty bridge fields are no longer drawn.

The worst uncached p99 in this phase (68 µs) leaves roughly 73× headroom against the unchanged 5 ms gate, and the strictest render path (one recompute per 250 ms coalesced publication) spends on the order of 0.004% of one core. **These are synthetic microbenchmarks, not a live Pi/provider/terminal A/B.** The real-host streaming, tool-dispatch and keyboard-latency acceptance procedure below is still required before any release claim.

## Phase 3 optional footer surface: same-machine before/after

The optional `surface: footer` slot, the cached identity data and the bounded extension-status comparison changed `extension.ts`, `state.ts`, `render.ts` and added `footer.ts`, so the phase was measured against the pre-change commit (`af3a5e4`) on the same host in one session. The gates were **not** changed; a cached-footer gate with the existing 5 µs budget was **added** for the new hot path. Raw per-run data is in [performance-phase3-ab.json](performance-phase3-ab.json).

Method: `git worktree` of the pre-change commit (`af3a5e4`) as the before side, the same tree-agnostic probe file (`scripts/perf-ab.mjs`) copied into both worktrees, identical fixtures and sample counts as phase 2. The before tree has no `src/footer.ts`, so the probe imports it dynamically and reports the footer scenarios as **new scenarios without a baseline**; the runner records them as `before: null` instead of inventing a comparison. Eight pairs ran, alternating before-then-after and after-then-before, for 8 runs per side. The after side is the committed phase-3 tree (`d64cbb3`) with a clean working tree at measurement start (`dirtyPathsAtStart: 0`); only the JSON record is written afterwards. The before tree's single listed dirty path is the copied probe file, which is byte-identical in both trees.

| Measurement | Before (mean of 8) | After (mean of 8) | Delta |
| --- | ---: | ---: | ---: |
| Final assistant-message handler, p99 | 1.203 µs | 1.209 µs | +0.5% (paired +0.006 ± 0.07 µs, 6/8 pairs) |
| Tool start + end pair, p99 | 2.485 µs | 2.532 µs | +1.9% (paired +0.047 ± 0.67 µs, 6/8 pairs) |
| Uncached full render, baseline fixture, p50 | 5.136 µs | 5.513 µs | +7.4% |
| Uncached full render, baseline fixture, mean | 6.449 µs | 6.784 µs | +5.2% (paired +0.335 ± 0.19 µs, 7/8 pairs) |
| Uncached full render, baseline fixture, p99 | 40.691 µs | 44.161 µs | +8.5% |
| Uncached full render, category-saturated, p50 | 6.207 µs | 6.639 µs | +7.0% |
| Uncached full render, category-saturated, mean | 7.759 µs | 8.407 µs | +8.4% (paired +0.648 ± 0.33 µs, 8/8 pairs) |
| Uncached full render, category-saturated, p95 | 10.450 µs | 12.207 µs | +16.8% |
| Uncached full render, category-saturated, p99 | 53.779 µs | 49.069 µs | -8.8% (paired -4.710 ± 16.48 µs, 2/8 pairs) |
| Uncached full render, category-saturated, 180 columns, mean | 7.494 µs | 7.904 µs | +5.5% |
| Uncached full render, category-saturated, mono, mean | 6.459 µs | 6.847 µs | +6.0% |
| Uncached balanced render, concurrent activity, mean | 5.570 µs | 5.670 µs | +1.8% |
| Uncached balanced render, concurrent activity, p99 | 17.870 µs | 19.966 µs | +11.7% (paired +2.096 ± 4.55 µs, 5/8 pairs) |
| Uncached balanced render, concurrent activity, 40 columns, mean | 4.149 µs | 4.149 µs | +0.0% |
| Uncached full render, empty idle row, mean | 2.962 µs | 2.885 µs | -2.6% |
| Cached render, bulk-loop mean | 0.005 µs | 0.005 µs | -7.7% (paired -0.000 ± 0.00 µs, 0/8 pairs) |
| Footer full render, category-saturated, mean | n/a | 14.3220 µs | new scenario |
| Footer full render, category-saturated, p99 | n/a | 99.2286 µs | new scenario |
| Footer balanced render, category-saturated, mean | n/a | 12.3578 µs | new scenario |
| Footer balanced render, 40 columns, mean | n/a | 9.6393 µs | new scenario |
| Footer full render without statuses, mean | n/a | 7.9250 µs | new scenario |
| Footer cached render with 12 statuses, bulk-loop mean | n/a | 0.1044 µs | new scenario (new gate ≤ 5 µs) |

The widget path with observed usage is the only comparable scenario that got measurably slower: the usage row now renders four separate counters plus `CH` instead of two merged numbers, which costs about **+0.65 ± 0.33 µs mean** on the saturated fixture (7.76 → 8.41 µs, 8/8 pairs) and +0.33 ± 0.19 µs on the baseline fixture (7/8 pairs). That is a deliberate information increase, not a structural regression: every gate is unchanged, the worst comparable after-side widget render p99 (49.1 µs) still leaves ~102× headroom against the 5 ms gate (the new footer p99 is 99.2 µs, ~50× inside it), the cached path is unchanged to marginally cheaper, and the footer's own cached hot path re-checks up to eight statuses for 0.104 µs per frame — ~48× inside the new 5 µs gate. At the strictest one-recompute-per-250 ms cadence the extra widget work is roughly 0.00026% of one core.

**These are synthetic microbenchmarks, not a live Pi/provider/terminal A/B.** The real-host streaming, tool-dispatch and keyboard-latency acceptance procedure below is still required before any release claim.

## Phase 3 B2b: long-history ledger measurements and live-host A/B

B2b executed the B1 measurement plan against the real pinned Pi 0.85.1 `SessionManager` and
the real ledger, plus the live-TUI acceptance protocol. All raw records are committed:
[performance-b2b-ledger.json](performance-b2b-ledger.json) (1k/10k/100k linear+branched),
[performance-b2b-usage-ab.json](performance-b2b-usage-ab.json) (8 interleaved observed/session pairs),
[host-acceptance-b2b.json](host-acceptance-b2b.json) (9 real-TUI scenarios) and
[pi-stream-ab-b2b.json](pi-stream-ab-b2b.json) (20 live streaming/tool/keyboard trials).
Environment for every record: Linux x64, Node v24.18.0, 11th Gen Intel i7-11800H (8C/16T),
commit `7155af0` plus the B2b working tree (the records list the exact dirty paths), pinned
SDK lock `8a0902c7…fdda`.

### Fixtures and methodology

One seeded builder (`scripts/usage-fixtures.mjs`, seed `0x0b2b5eed`) produces the same op
stream for plain fixtures and real-manager replay: assistant+usage 42%, user 20%,
toolResult+usage 18%, toolResult w/o usage 12%, assistant w/o usage 3%, compaction+usage 2%,
compaction w/o usage 1.5%, ~220-char content, ~400-char summaries; the branched shape adds
~15% of entries on side branches. Fixture build, host manager load and HUD attach are timed
separately. An external `setImmediate` probe measures the gap between loop iterations
(approximating the longest uninterruptible pause, GC included); the same probe over an idle
window is the reported noise floor (~0.8–1.1 ms on this host). Every timing is recorded only
after the phase's totals equal the independent fixture oracle. One child process per cell,
`--expose-gc`, with settling GCs before memory attribution: a naive single-GC snapshot
attributes ~40–56 MiB of load-phase garbage to the attach phase, so each cell also measures
a **control window** (same probe load, same duration, zero ledger work) bounding V8
old-space re-growth noise.

### Long-history measurements (per size/shape; full data in the JSON)

| Measurement | 1k linear/branched | 10k linear/branched | 100k linear/branched |
| --- | ---: | ---: | ---: |
| Fixture build (plain objects) | 3.2 / 3.4 ms | 29 / 37 ms | 277 / 302 ms |
| Host manager load (real append APIs) | 1.7 / 1.9 ms | 17.6 / 15.1 ms | 181 / 206 ms |
| `getEntries()` sync copy (median of 5) | 0.012 / 0.014 ms | 0.118 / 0.225 ms | 1.97 / 2.53 ms |
| HUD attach: wall (yield-inclusive) | 2.5 / 4.1 ms | 20.3 / 23.2 ms | 200 / 231 ms |
| HUD attach: net CPU (probe load subtracted) | 7.5 / 5.6 ms | 11.1 / 16.1 ms | 41 / 54 ms |
| Max aggregation slice (budget 2 ms) | 0.54 / 0.61 ms | 0.25 / 0.45 ms | 0.42 / 0.71 ms |
| Max event-loop pause during attach | 0.76 / 0.79 ms | 0.51 / 0.93 ms | 3.6 / 4.8 ms |
| Rebuild (tree / compact), wall | 2.5–3.8 ms | 20–24 ms | 198–233 ms |
| Heap retained after release (settled) | 0.02 / 0.00 MiB | 0.13 / 0.11 MiB | 1.5 / 2.1 MiB |
| Heap peak delta vs zero-work control | 0.7 vs 0.4 / 1.1 vs 0.9 MiB | 10.3 vs 8.2 / 12.1 vs 9.2 MiB | 56.2 vs 54.9 / 57.2 vs 54.9 MiB |

Reading: slices stay ~0.3–0.7 ms against the unchanged 2 ms budget at every size. At 100k the
longest attach pause (3.3–6.9 ms) is dominated by the SDK's own O(N) `getEntries()` copy
(2.1–2.4 ms standalone) plus first-slice work and one GC — the B1 contract explicitly
acknowledges this step cannot be sliced ("分片不能补救这一步"). The apparent ~56 MiB attach
peak at 100k is V8 old-space re-growth after the post-load compaction: the zero-work control
window on the same heap grows 54.9 MiB, and the settled retained delta is 1.4–2.1 MiB —
consistent with the one shallow O(N) array (~0.76 MiB for 100k entries) plus scalars. RSS
follows the same pattern and never returns fully (documented caveat).

### Steady-state increments, over-cap recovery, catch-up, fast switch

Per history size, appending 1 / 32 / 2048 records and reconciling at `turn_end`:

| Added records | Verify wall | Ledger-internal increment | Max pause | New `getEntries` calls |
| ---: | ---: | ---: | ---: | ---: |
| +1 (all sizes) | 1.1–1.8 ms | 0.065–0.113 ms | 0.06–0.40 ms | 0 |
| +32 (all sizes) | 1.4–1.6 ms | 0.065–0.113 ms | 0.06–0.40 ms | 0 |
| +2048 (all sizes) | 1.2–3.9 ms | 0.32–0.46 ms | 0.75–2.18 ms | 0 |

Cost tracks the added-record count, not the history size; the 2048-entry walk's single
synchronous block does 0.32–0.46 ms of ledger-internal work. Its worst measured loop pause
(2.18 ms, 1k/branched) includes GC of the 2048 freshly appended fixture records plus the
~1 ms probe noise floor — the ledger's own slice of that block remains inside the 2 ms
budget, and the idle-probe floor on this host is 0.8–1.1 ms for comparison. The over-cap
path (2049 appended: walk dropped, exactly one recovery rebuild) costs the same as a fresh
attach at that size (12.1–12.3 ms at 1k, 208–245 ms at 100k) and heals `failureReason`.
Catch-up appends landing mid-slice are folded by the baseline's bounded walk (exercised at
every size). A session switch issued **while the 100k baseline is still slicing** cancels
synchronously in 16–30 µs, the stale generation never publishes, and the new session's
totals are exact.

### Measurement-driven fix

The first 100k run exposed a real defect: `accumulateUsage` allocated a fresh 4-tuple
array per usage record, producing ~24 MiB of garbage per 100k-entry rebuild and inflating
GC pauses during the baseline. The invariant table is now a module-level constant
(`TOKEN_FIELDS`), verified allocation-free (1M calls, 0.03 MiB retained). The same run also
attributed load-phase garbage to the attach phase before the settling-GC methodology above
was adopted; both effects are documented so the numbers can be reproduced.

### Interleaved observed/session A/B (8 pairs, same tree)

`node scripts/usage-ab-run.mjs --pairs=8`: one flag different, separate processes, order
alternated inside each pair, 2000-entry fake-manager history. Gates unchanged; this table
is the session mode's marginal cost, not a gate.

| Metric (mean of 8) | observed | session | Paired delta | Direction |
| --- | ---: | ---: | ---: | --- |
| message_end hook p99 | 1.95 µs | 1.61 µs | −0.34 ± 0.24 µs | 0/8 positive (noise; both ≪ 250 µs gate) |
| tool pair hook p99 | 3.98 µs | 3.20 µs | −0.78 ± 0.57 µs | 1/8 positive (noise) |
| Bare turn_end + drain | 0.119 µs | 0.465 µs | +0.35 ± 0.08 µs | 8/8 (scheduling + idle verify) |
| Full turn (append + walk + publish) | 1.21 µs | 2.42 µs | +1.21 ± 0.18 µs | 8/8 |
| Widget render mean (sess* row) | 11.3 µs | 12.8 µs | +1.49 ± 1.48 µs | 7/8 |
| Footer render mean | 11.8 µs | 13.3 µs | +1.54 ± 1.22 µs | 7/8 |
| Cached render means | 0.022 / 0.039 µs | 0.022 / 0.038 µs | ≤ 0.001 µs | noise |

The session mode's steady marginal cost is ~+1.2 µs per full turn plus ~+1.5 µs per render
of the `sess*` row; hooks stay sub-2 µs and cached paths unchanged.

### Live-TUI streaming / tool / keyboard A/B (20 trials)

`python3 scripts/pi-stream-ab.py --pairs=10`: the real TUI in a disposable PTY, HUD
on/off alternated within and across pairs, deterministic in-process provider streaming
40 deltas × 2 ms. Instrumentation identical on both sides (write→first-output timing from
the harness).

| Metric | HUD off | HUD on | Delta |
| --- | ---: | ---: | ---: |
| Keyboard echo p50 / p95 | 1338 / 2635 µs | 1119 / 2270 µs | −16% / −14% (noise; if anything faster) |
| First token, cold process | 55.7 ms | 54.9 ms | −1.5% |
| First token, warm | 35.4 ms | 35.7 ms | +0.7% |
| Inter-token gap p50 / p95, warm | 15.78 / 16.66 ms | 15.57 / 16.89 ms | −1.4% / +1.4% (identical cadence) |
| Full tool turn (read + follow-up) | 19.8 ms | 19.3 ms | −2.9% (noise) |
| Terminal bytes per tool turn | 2388 B | 2815 B | **+427 B** (one footer publication) |
| Post-turn publication | — | 148 ms after completion, 456 B | designed coalesced repaint |

An earlier draft of this A/B reported a "+450% inter-token p95" stall; that was a metric
bug, not a regression: the ~150–160 ms quiet period between the last streamed frame and the
HUD's coalesced (250 ms budget) post-turn publication was being counted as a token gap.
With gaps restricted to the streaming window the cadences are identical. The HUD's real
per-turn terminal cost is one ~455-byte footer repaint published ~150 ms after completion
(`maxFlushMs` stays in single-digit milliseconds; the ledger's verify adds ~1.3 µs).

### What remains open

These are synthetic-plus-live-PTY measurements on one Linux host. Still open per
[VERIFICATION.md](VERIFICATION.md): human dark/light terminal visual acceptance,
cross-platform matrix, and the default-footer evaluation (explicitly not taken — `widget` +
`observed` remain the defaults).

## Real host checks

The pinned SDK/RPC/PTY checks below are the workflow's real-host gates. They were prepared for CI and, in addition, executed locally in the phase-1 environment; the executed results are recorded in [VERIFICATION.md](VERIFICATION.md).

The pinned SDK type-contract check validates event names and accessed fields against the installed Pi 0.85.1 types, including the HUD's structural footer-data surface against Pi's real `ReadonlyFooterDataProvider`. The RPC smoke launches the actual CLI, verifies `/hud` registration and strict JSON framing, and checks that no terminal widget request leaks into RPC. The PTY smoke launches the real TUI with a clean temporary home and no provider credentials, switches surface, verifies native-footer restoration and an independent extension's `setStatus` update, and switches preset/palette and resizes. It makes **no model request**.

These are prepared checks, not results from this sandbox. Even a passing PTY startup smoke is **not** a live model-stream performance A/B. Their first genuine runner results must be recorded separately rather than replacing this baseline with a claim they already ran.

## Live-stream / tool / keyboard A/B acceptance

Use the same machine, Pi 0.85.1, supported Node version, terminal, font, dimensions, extension set and disposable test worktree. Compare the default HUD to the same installation launched with `PI_HUD_DISABLE=1`; keep Git off in both. Use a deterministic local test provider or a replayed, non-sensitive response fixture so network/provider variance and API billing do not dominate the comparison. Run a warmup and alternate enabled/disabled order across at least 20 paired trials; do not always run the disabled case first.

Exercise a long text stream, tool-call bursts, long tool output, typing/backspace/cursor movement while streaming, terminal resizing, completion/abort/retry, compaction, model switching, `/new`, resume, tree navigation and `/reload`. Include a previously large session: attachment should not trigger a HUD history scan. Test bridge flood/expiry and an unavailable Git binary separately. A monorepo Git probe is a separate **opt-in** profile, not proof about the default.

Record time to first rendered token, inter-token gap distributions, tool dispatch delay, keyboard-to-visible-echo latency, repaint bytes/rows, process CPU/RSS and event-loop lag using the same external instrumentation in both cases. Instrumentation itself must be held constant. Also check that fixed HUD rows do not jitter, editor shortcuts still work, other extension widgets remain visible, and no raw ANSI/control output or RPC noise appears. A genuine perception check needs an observer using the actual terminal, not only logs.

Suggested acceptance policy: no reproducible extra stalls, no visible input lag or layout regressions, and paired p95 deltas within the measured baseline noise envelope. For a project-specific numerical target, start with ≤1 ms added p95 tool dispatch and ≤2 ms added p95 keyboard echo, then report confidence intervals rather than declaring a single run a proof. These are proposed acceptance targets, **not measurements obtained here**. A failed default case blocks a public stable release until explained. Keep CPU cost and terminal latency separate; faster throughput alone does not exclude occasional stutters.

## Diagnostics and failure containment

`/hud status` exposes observation scope, usage scope and session-ledger diagnostics (status, rebuild reasons/counts, host call counts, missing-field counts, timings), flush count, maximum observed flush duration, render requests, callback errors and bounded-record counts. It intentionally does not time every hot-path callback in production. Benchmarks instrument those callbacks externally. Status output can include the local config path; redact it before sharing.

`/hud off` cancels pending publication/expiry work, disables the optional probe and removes only the named widget. If the footer surface is active and the HUD still owns the slot, `off` also restores the built-in footer; if another extension replaced the HUD footer, `off` leaves that footer untouched. The startup kill switch removes event dispatch overhead too. Session shutdown removes the bus listener, the branch subscription and any footer/widget ownership, and suppresses stale async results. A timeout or malformed config is an unavailable diagnostic, not a reason to stop the model or tool loop.
