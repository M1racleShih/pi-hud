# Changelog

## Unreleased — bounded activity information (phase 2)

Added a bounded per-tool-name category ledger: success (`✓`), failure (`!`) and interruption (`~`) are counted separately, a tool start is never a completion, duplicate completion events stay deduplicated. At most 16 tool names are retained and every further name is merged into a separate overflow record, so the ledger cannot grow with the number of distinct tools and a real tool literally named `other` keeps its own counters; the renderer shows the three most active categories plus a `+N` fold marker, and the overflow record is the only category that is localized. The activity row now prioritizes the running tool and any safe file target (basename of `read`/`write`/`edit`/`ls` only), then the error alert, then the categories, so narrow terminals fold activity detail instead of the context percentage, the current tool or an error.

Removed the empty `no bridged activity` placeholder: bridge agents/tasks appear only with valid bridge data, and the fixed row otherwise retains available usage information (or stays blank). Zero-compaction and zero-usage fields are no longer drawn. The widget keeps its fixed minimal/balanced/full 1/2/3 rows across tool start, completion, failure, settlement and idle transitions, and pastel/theme/mono, `color: false`, ASCII, English/Chinese labels and theme switching are unchanged. No pi-goal or todo-specific adapter was added.

Also added a width fast path: `visibleWidth`/`clip` now sum code points directly and fall back to `Intl.Segmenter` only for real grapheme-cluster candidates (marks, ZWJ, variation selectors, emoji, regional indicators). A seeded differential fuzz test asserts equivalence with the segmenter-based reference. The new activity fields therefore cost less than the old `tools*` line.

Verification for this phase: 149 tests, `npm run verify`, `npm run package:check`, and an 8-pair same-machine A/B against the pre-change commit (category-saturated uncached render p50 24.2→7.4 µs, mean 34.3→9.2 µs, p99 677→68 µs; concurrent activity mean 26.7→6.5 µs; empty idle row 20.6→2.8 µs; tool-pair hook p99 +0.24 µs; cached mean unchanged within noise; gates unchanged). The pinned Pi 0.85.1 SDK contract check, the real RPC smoke and the real PTY smoke passed; the PTY smoke now loads the bridge demo and verifies the full-preset summary row through a resize. Real-terminal visual acceptance, a live tool-stream A/B and the real rendering of native tool categories remain pending.

## Unreleased — per-field colors and semantic segments (phase 1)

Replaced the per-row `tone` with a bounded list of semantic segments (`{ role, text }`). Plain text is laid out and truncated to the terminal's visible width first; each surviving segment is colored afterwards, so a color can never change the layout. Row fields are capped at 12 and segments at 32, and lower-priority fields are dropped before overflow.

Added `palette: pastel | theme | mono` (default `pastel`) plus the in-memory `/hud palette` command. `pastel` gives model, thinking, path, branch, phase, context, body, label and separator their own candidates, with deeper same-family variants when the host theme indicates a light background; `theme` maps each role to a host theme token; `mono` and `color: false` stay plain. Alerts recolor only their own field: a high context value, a failed-tool count, interrupted work, bridge errors and `limited*` no longer tint a whole row, and zero counts stay neutral. `color: false`, ASCII mode, English/Chinese labels and the fixed 1/2/3-row widget layouts are unchanged.

Updated the final-line cache to clear its memoized styler on `invalidate()`, so a theme light/dark switch is re-detected while an unchanged width/state/theme still returns the identical array. Narrow identity rows reserve the measured context field (label, percentage and any warning) before spending width on the model, and rank the context meter above the model name below 45 columns; a long model name is clipped instead of pushing a high-usage warning out of the row. Synced configuration validation, `docs/config.schema.json`, the example config, a renderer-generated `docs/preview.txt` (now asserted by `npm run check`), and the bilingual README/CONFIGURATION/ARCHITECTURE/VERIFICATION/PERFORMANCE documents.

Verification for this phase: 126 tests, `npm run verify`, `npm run package:check`, an 8-pair same-machine A/B against the pre-change commit (uncached render mean −32.7%, p50 −40.6%, p95 −39.3%, cached mean −8.8%, uncached p99 +40.5% at 0.59 ms against the unchanged 5 ms gate), the pinned Pi 0.85.1 SDK contract check (now covering the theme-role tokens), the real RPC smoke and the real PTY smoke with live palette switching. Real dark/light terminal visual acceptance and live-stream A/B remain pending; footer takeover, quota data and historical usage totals were out of scope.

## 0.1.0 — 2026-09-19

Initial source delivery, inspired by Claude HUD and designed around Pi 0.85.1's native extension contract.

Added a passive named widget with fixed minimal/balanced/full layouts, English/Simplified Chinese labels, bounded tool tracking, honest last-response context snapshots, observed usage estimates, a versioned opt-in agent/task bridge, async capped config reads, an optional idle-only Git probe, and `/hud` commands. No runtime dependencies, token-stream listeners, history scans, model requests or prompt injection were added.

Added deterministic state/lifecycle/render/config/Git tests, local real-Git tests, synthetic performance budgets, offline package/import smoke checks, source research, bilingual READMEs, CI/release workflows, and explicit pinned-SDK/RPC/PTY checks for a network-enabled runner.

Known verification gap at delivery: the actual Pi SDK, real Pi RPC/TUI smoke and live-stream terminal A/B could not be executed in the offline sandbox. Cross-platform GitHub CI and draft release are prepared, not remotely executed. See [verification](docs/VERIFICATION.md). The performance objective is bounded, imperceptible marginal overhead; this is not an unconditional zero-overhead certification.
