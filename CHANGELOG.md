# Changelog

## 0.1.0 — 2026-09-19

Initial source delivery, inspired by Claude HUD and designed around Pi 0.85.1's native extension contract.

Added a passive named widget with fixed minimal/balanced/full layouts, English/Simplified Chinese labels, bounded tool tracking, honest last-response context snapshots, observed usage estimates, a versioned opt-in agent/task bridge, async capped config reads, an optional idle-only Git probe, and `/hud` commands. No runtime dependencies, token-stream listeners, history scans, model requests or prompt injection were added.

Added deterministic state/lifecycle/render/config/Git tests, local real-Git tests, synthetic performance budgets, offline package/import smoke checks, source research, bilingual READMEs, CI/release workflows, and explicit pinned-SDK/RPC/PTY checks for a network-enabled runner.

Known verification gap at delivery: the actual Pi SDK, real Pi RPC/TUI smoke and live-stream terminal A/B could not be executed in the offline sandbox. Cross-platform GitHub CI and draft release are prepared, not remotely executed. See [verification](docs/VERIFICATION.md). The performance objective is bounded, imperceptible marginal overhead; this is not an unconditional zero-overhead certification.
