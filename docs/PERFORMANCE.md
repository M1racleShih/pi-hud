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

The hook samples use 2,000 warmups and 12,000 observations. Assistant fixtures include provider/model identity and reported cache/cost usage. Full-layout rendering includes Chinese and emoji at 120 columns, with 3,000 uncached samples. The cached measure loops one million times and verifies object-identical cache hits. That tiny optimized bulk-loop average is **not an input-to-paint latency**, does not include terminal rendering, and must not be advertised as the TUI response time. Warm JIT, GC, OS scheduling and timing overhead affect all numbers; a single-host microbenchmark is not a deployment guarantee.

The synthetic 100,000-tool-event burst asserts **one pending publication timer and one publication**, bounded recent IDs (128), no retained completed tools, and zero extra publications across 60,000 ms of fake-clock idle time. This is a deterministic scheduling test, not a real minute of CPU/RSS sampling. A one-million-frame cache loop proves reuse for unchanged inputs; host invalidation or resizing necessarily changes that condition.

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

## Real host checks

The pinned SDK/RPC/PTY checks below are the workflow's real-host gates. They were prepared for CI and, in addition, executed locally in the phase-1 environment; the executed results are recorded in [VERIFICATION.md](VERIFICATION.md).

The pinned SDK type-contract check validates event names and accessed fields against the installed Pi 0.85.1 types. The RPC smoke launches the actual CLI, verifies `/hud` registration and strict JSON framing, and checks that no terminal widget request leaks into RPC. The PTY smoke launches the real TUI with a clean temporary home and no provider credentials, switches preset, resizes and toggles the HUD. It makes **no model request**.

These are prepared checks, not results from this sandbox. Even a passing PTY startup smoke is **not** a live model-stream performance A/B. Their first genuine runner results must be recorded separately rather than replacing this baseline with a claim they already ran.

## Live-stream / tool / keyboard A/B acceptance

Use the same machine, Pi 0.85.1, supported Node version, terminal, font, dimensions, extension set and disposable test worktree. Compare the default HUD to the same installation launched with `PI_HUD_DISABLE=1`; keep Git off in both. Use a deterministic local test provider or a replayed, non-sensitive response fixture so network/provider variance and API billing do not dominate the comparison. Run a warmup and alternate enabled/disabled order across at least 20 paired trials; do not always run the disabled case first.

Exercise a long text stream, tool-call bursts, long tool output, typing/backspace/cursor movement while streaming, terminal resizing, completion/abort/retry, compaction, model switching, `/new`, resume, tree navigation and `/reload`. Include a previously large session: attachment should not trigger a HUD history scan. Test bridge flood/expiry and an unavailable Git binary separately. A monorepo Git probe is a separate **opt-in** profile, not proof about the default.

Record time to first rendered token, inter-token gap distributions, tool dispatch delay, keyboard-to-visible-echo latency, repaint bytes/rows, process CPU/RSS and event-loop lag using the same external instrumentation in both cases. Instrumentation itself must be held constant. Also check that fixed HUD rows do not jitter, editor shortcuts still work, other extension widgets remain visible, and no raw ANSI/control output or RPC noise appears. A genuine perception check needs an observer using the actual terminal, not only logs.

Suggested acceptance policy: no reproducible extra stalls, no visible input lag or layout regressions, and paired p95 deltas within the measured baseline noise envelope. For a project-specific numerical target, start with ≤1 ms added p95 tool dispatch and ≤2 ms added p95 keyboard echo, then report confidence intervals rather than declaring a single run a proof. These are proposed acceptance targets, **not measurements obtained here**. A failed default case blocks a public stable release until explained. Keep CPU cost and terminal latency separate; faster throughput alone does not exclude occasional stutters.

## Diagnostics and failure containment

`/hud status` exposes observation scope, flush count, maximum observed flush duration, render requests, callback errors and bounded-record counts. It intentionally does not time every hot-path callback in production. Benchmarks instrument those callbacks externally. Status output can include the local config path; redact it before sharing.

`/hud off` cancels pending publication/expiry work, disables the optional probe and removes only the named widget. The startup kill switch removes event dispatch overhead too. Session shutdown removes the bus listener and suppresses stale async results. A timeout or malformed config is an unavailable diagnostic, not a reason to stop the model or tool loop.
