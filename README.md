# pi-hud

Planned provider quota and API balance support: [implementation plan (Chinese)](docs/PROVIDER-LIMITS-PLAN.zh-CN.md). This is a proposal, not a feature available in the current release.

English | [简体中文](README.zh-CN.md)

A passive, event-driven HUD extension for [Pi](https://github.com/earendil-works/pi), inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud). It shows model/context snapshots, native tool activity, observed token/cost counters, and opt-in agent/task progress without replacing Pi's editor or footer.

**No runtime dependencies. No token-stream listeners. No transcript scans. No prompt injection. No network requests. Git probing is off by default.**

## Preview

Balanced, 120 columns; synthetic data rendered by the actual renderer, not a screenshot of a live session:

```text
[Example Model] | ctx(last) █████░░░░░ 45% 90k/200k | pi-hud | high
● edit state.ts | tools* ✓5 !0 | agents 1 | tasks 3/7 | est* $0.042
```

`minimal` uses one row, `balanced` two, `full` three. Row counts stay fixed for a preset, including when tools start or finish. Segments are removed by priority on narrow terminals; text is grapheme-aware and width-bounded. Colors follow Pi's theme. See [all six previews](docs/preview.txt).

## Install

Target host: **Pi 0.85.1**, package `@earendil-works/pi-coding-agent`, with **Node.js 22.19.0 or newer**. The integration was source-reviewed against that release. Older `@mariozechner` releases are not claimed compatible.

Unzip the delivery and keep the `pi-hud` directory in a stable location. From a terminal, register its **absolute** path:

```sh
pi install /absolute/path/to/pi-hud
```

Then start Pi, or run `/reload` in an existing session. For a one-session trial, instead use:

```sh
pi -e /absolute/path/to/pi-hud/index.ts
```

Do not load both ways in the same session. No `npm install`, build step, API key, extra model call, tmux, or terminal font is needed for the HUD. This delivery is **not published to npm**; do not assume `npm:pi-hud` refers to this project. See [verification status](docs/VERIFICATION.md) before relying on host compatibility.

To remove a registered local package, use Pi's package management (`pi remove /absolute/path/to/pi-hud`) and reload. `/hud off` only hides/disables it for the current attachment. To avoid even extension event/command registration at startup, launch with `PI_HUD_DISABLE=1` in your environment.

## Commands

| Command | Effect |
| --- | --- |
| `/hud on`, `/hud off`, `/hud toggle` | Enable or disable the HUD. Enabling starts fresh observation counters. |
| `/hud preset minimal\|balanced\|full` | Select a fixed one-, two-, or three-row layout. |
| `/hud lang en` or `/hud lang zh-CN` | Switch display labels. Command help remains English. |
| `/hud placement aboveEditor\|belowEditor` | Move only the named HUD widget. |
| `/hud git on` or `/hud git off` | Opt in/out of an additional, bounded, tracked-files-only Git probe. |
| `/hud reload` | Asynchronously reread the configuration file. |
| `/hud refresh` | Request a display/idle Git refresh; it does not bypass Git cooldown. |
| `/hud reset` | Reset observation counters, context snapshot, and bridge state. |
| `/hud status` | Show configuration errors and bounded diagnostic counters; no model request. |

Use one alternative, not a literal `|`, in commands. Changes are in-memory and are not written to disk. A new session or `/reload` reattaches the extension and rereads the file. For persistent preferences, create `~/.pi/agent/pi-hud.json` yourself:

```json
{
  "version": 1,
  "preset": "balanced",
  "language": "en",
  "refreshMs": 250,
  "git": { "enabled": false }
}
```

The directory follows `PI_CODING_AGENT_DIR` when set. An absolute `PI_HUD_CONFIG` overrides the full file path. Relative overrides are rejected. Configuration is regular-file-only, read asynchronously with a 32 KiB hard cap, and never watched or rewritten. Unknown fields/types are rejected; a failed reload retains the previous configuration. Startup errors use defaults and remain visible through `/hud status`. See [configuration reference](docs/CONFIGURATION.md), [example](examples/pi-hud.json), and [JSON schema](docs/config.schema.json).

## What the numbers actually mean

**`ctx(last)` is the last completed main-assistant response's usage snapshot**, not a live meter or an exact forecast of the next request. Its numerator is Pi's reported input + cache-read + cache-write + output tokens, divided by the selected model's context window. It does not include subsequent tool results, queued prompts, or a new system prompt. No per-delta approximation is invented. Resume, reset, tree navigation, compaction, a model change, or an error/aborted response can legitimately show `?`. A late response from a previous model never uses the newly selected model's denominator. This HUD is not an automatic-compaction threshold monitor.

**`*` means “observed since this HUD attachment/reset.”** Tool successes/errors, token totals, compaction count, and `est*` cost exclude earlier history. Resuming a long session does not scan it. Tree navigation and re-enabling reset the observation scope; manual compaction invalidates context but retains the observed cumulative counters. Duplicate tool completions are deduplicated within a bounded recent-ID window. Counts can be incomplete when `limited*` appears; unfinished tools are marked interrupted after the run settles, not successful.

**`est*` is a model-pricing estimate**, using Pi's reported `usage.cost.total`, not a bill or subscription allowance. Missing reports display `?`; partly known costs have `+?`. Historical, compaction-model, and unreported child-agent usage are not silently included. No provider credentials or subscription endpoints are read.

**Agents/tasks appear only through an explicit extension bridge.** A native `subagent` tool can appear in tool activity, but that alone does not reveal its internal children. [Bridge protocol and examples](docs/BRIDGE.md) let a subagent or `/goal` extension publish small lifecycle records. There is no universal, preinstalled adapter for every third-party extension.

**Optional Git is a cached, idle-boundary snapshot.** It deliberately ignores untracked files, submodule state, line diffs, and ahead/behind counts. `*` means tracked changes; `git:?` means unavailable, not clean. Leave it off for the strictest low-contention configuration and use Pi's existing footer branch display.

## Core-loop protection

```text
native lifecycle/tool/final-message events
    -> bounded scalar state, synchronous void handlers
    -> one coalesced publication timer (250 ms minimum steady-state spacing)
    -> immutable-size snapshot -> cached widget lines
                                   -> requestRender only when lines change
```

There are no `message_update`/`tool_execution_update` listeners, `getBranch()`/`getEntries()`/`getContextUsage()` calls, synchronous filesystem/child-process calls, shell commands, recurring idle polling, editor/input hooks, LLM tools, message modifications, or session writes. Stream-driven host renders reuse the same cached line array unless width/state/theme invalidation changes. Headless/RPC modes allocate no HUD timers, read no HUD configuration, and attach no UI.

A startup file read is deferred and asynchronous. A bridge record may schedule one bounded expiration timer. The optional Git subprocess has a timeout, output cap, single-flight gate, cooldown, cancellation, and stale-result protection; “asynchronous” does **not** mean it is free of CPU/I/O contention.

The goal is **no perceptible impact**, not a physically impossible promise of zero work. Local synthetic tests and performance gates support the design; they do **not** certify every machine, live provider, terminal, or extension combination. Actual Pi SDK/TUI end-to-end validation could not be run in the delivery sandbox. The exact evidence, prepared CI checks, and real-terminal A/B acceptance procedure are in [verification](docs/VERIFICATION.md) and [performance](docs/PERFORMANCE.md).

## Development

No development dependencies are needed for the local suite:

```sh
npm ci --ignore-scripts
npm run verify
npm run package:check
npm run demo
```

The GitHub workflow additionally installs the pinned Pi SDK in an isolated temporary directory for type-contract and actual-loader/RPC checks. These are separate from the dependency-free package. CI covers Linux, macOS and Windows; see [development workflow](docs/DEVELOPMENT.md) for what is prepared versus actually executed.

Read [upstream research](docs/RESEARCH.md) ([中文](docs/RESEARCH.zh-CN.md)), [architecture](docs/ARCHITECTURE.md), [contributing](CONTRIBUTING.md), [security](SECURITY.md), and [changelog](CHANGELOG.md). MIT licensed; [attribution](THIRD_PARTY_NOTICES.md). No upstream source, screenshots, or fonts are bundled.
