# pi-hud

Planned provider quota and API balance support: [implementation plan (Chinese)](docs/PROVIDER-LIMITS-PLAN.zh-CN.md). This is a proposal, not a feature available in the current release.

English | [简体中文](README.zh-CN.md)

A passive, event-driven HUD extension for [Pi](https://github.com/earendil-works/pi), inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud). It shows model/context snapshots, bounded tool-category activity, observed token/cost counters, an **opt-in full-session usage ledger**, and opt-in agent/task progress. The default surface is a named widget next to Pi's built-in footer; an **opt-in footer surface** can replace that footer instead so the same information is not shown twice.

**No runtime dependencies. No token-stream listeners. No prompt injection. No network requests. Git probing is off by default.** History reads exist only behind the opt-in `usageScope: "session"` and are confined to one audited module.

## Preview

Balanced, 120 columns; synthetic data rendered by the actual renderer, not a screenshot of a live session:

```text
[Example Model] · high · pi-hud · git:main* · ctx(last) █████░░░░░ 45% 90k/200k
● working · interrupted 1 · bash ✓14 !1 ~1 · edit ✓3 · write ✓2 +1 · est* $0.042 · agents 1 · tasks 3/7
```

`minimal` uses one row, `balanced` two, `full` three. Row counts stay fixed for a preset, including while tools start, finish, fail or settle. Segments are removed by priority on narrow terminals: the context percentage, the stable phase survive first, then tool categories fold away. The context meter keeps its space, so a long model name is clipped before a high-usage warning can disappear. Text is grapheme-aware and width-bounded — Chinese, emoji and long paths are measured in terminal cells, not code units. See [all generated previews](docs/preview.txt).

## Surfaces: widget (default) or footer

`surface` selects where the HUD is drawn. The default is `widget`, so nothing changes for an existing installation. `footer` replaces Pi's built-in footer through the official `ctx.ui.setFooter` slot and does **not** mount the HUD widget, which removes the duplicate model/context/cost display:

```text
[Example Model] · high · demo · ~/opensource/pi-hud · git:main* · Compare HUDs
ctx(last) ██░░░░░░░░ 45% 90k/200k · obs* ↑12k ↓3.0k R75k CH86.2% · est* $0.042
● working · interrupted 1 · bash ✓14 !1 ~1 · edit ✓3 · write ✓2 +1
```

The footer body uses **2 rows for `minimal`, 3 for `balanced` and 4 for `full`**. Statuses published by other extensions (`ctx.ui.setStatus`) are displayed in a separate bounded area: at most 8 entries, 64 sanitized characters each, at most 2 rows, and at most 6 footer rows in total. A status change is detected inside the footer's own render pass — no polling, no HUD event and no host patch is required.

The footer adds identity data that the widget does not show: the working directory (home is abbreviated to `~`), the model, the provider, the thinking level, the session title, and the host's Git branch. The branch comes from Pi's own `footerData.getGitBranch()`/`onBranchChange()` cache, so no extra Git process is started for it; the optional dirty marker still requires the separate `git.enabled` probe.

The footer is **not** a byte-for-byte replacement of the built-in footer. By default it does not read session history, so its counters remain "observed since this attachment/reset" and its context value stays the labelled `ctx(last)` snapshot. With `usageScope: "session"` the usage fields switch to the full-session ledger described above; the host's live context estimate, auto-compaction/subscription flags and provider count are intentionally not imitated in either mode. `/hud status` prints the exact data-coverage differences.

In `minimal`, the activity summary shares the second row with the context meter and usage. If a 40-column terminal cannot fit both, the higher-priority context meter wins and the activity fields fold; `balanced` (the default) and `full` give activity its own row, so the context percentage, the stable phase all survive at 40 columns.

## Usage scope: observed (default) or session

`usageScope` selects which numbers the usage fields show. The default `observed` keeps the low-cost counters since this attachment/reset — no history access at all. `session` additionally builds an optional full-session ledger over the current SessionManager's entries (all branches, pre-compaction messages, error/aborted responses and summary records), matching the built-in footer's four record categories: assistant, tool results that carry usage, compaction and branch summaries.

```text
ctx(last) ██░░░░░░░░ 45% 90k/200k · sess* ↻ ↑61k ↓15k R312k W9.4k CH86.2% · sess* $0.384
```

The `sess*` label leads both usage fields, followed by compact markers that always precede the numbers: `↻` while appended records wait for the next reliable commit boundary, `+?` when any record reported incomplete data, `?` while the first baseline is still loading, and `limited*` after a saturated sum — a clipped value never loses the hint that it is a capped total. The cost field carries the same scope and markers on its own — the balanced widget and narrow footers drop the token field, so `sess* ↻ $0.384+?` must stay self-describing. Cost keeps its recorded subtotal with `+?` for unknown parts and `?` when nothing is known; an explicit reported zero stays a valid zero. `ctx(last)`, `CH` and the tool categories keep their observed scope in both modes — the session totals never claim to be a live context estimate, a cumulative cache-hit rate or a per-session activity ledger.

The ledger is event-driven and cancelable: one baseline rebuild slices the history (512 entries or ~2 ms per slice), normal turns reconcile only the new records by walking the committed parent chain (never re-reading the whole array), tree navigation and compaction rebuild once, and a session switch or `/hud off` cancels everything immediately. Measured on the pinned SDK (see [performance evidence](docs/PERFORMANCE.md)): the baseline costs ~2–3 ms of wall time at 1k entries, ~21–24 ms at 10k and ~0.2 s at 100k (the SDK's own O(N) `getEntries()` copy — ~2.1–2.4 ms at 100k — is the largest single pause and cannot be sliced); every aggregation slice stays under 0.7 ms, a steady turn adds ~1.2 µs plus ~1.5 µs per `sess*` render, and the real TUI pays one ~455-byte footer repaint per turn. This is why the mode stays opt-in. A host without the read-only entry surface degrades explicitly to the observed-labelled fields; `/hud status` records the requested and actual scope. `usageScope` is independent of `surface`: switching widget/footer never resets the session account. The full contract, including the missing-data semantics, is in the [session usage contract](docs/SESSION-USAGE-CONTRACT.zh-CN.md) (Chinese).

Ownership rules: `/hud off` restores the built-in footer while the HUD still owns the slot; if another extension replaced the HUD footer, the HUD neither clears that footer on `off`/dispose nor takes the slot back during a refresh — only an explicit `/hud surface footer` re-claims it. A host without `ui.setFooter` falls back to the widget and records the reason for `/hud status`.

## Activity information

- **Stable activity states.** The activity field shows working, waiting for confirmation, or ready. Model responses, tool execution and settling all remain working until `agent_settled`; individual tool names and targets do not rotate through this field. Failure counts appear only on tool categories (`!`), without a duplicate errors item.
- **Tool categories are bounded.** Completed work is counted per tool name, for example `bash ✓14 !1 ~1 · edit ✓3 · write ✓2 +1`. Success (`✓`), failure (`!`) and interruption (`~`) are counted separately. Starting a tool is not a completion. At most 16 tool names are retained; every further name shares one `other` record that is stored separately from tool names, so the ledger cannot grow with the number of distinct tools and a real tool literally named `other` keeps its own counters. Only the three most active categories are displayed, with a `+N` marker for the rest.
- **Agents and tasks require the bridge.** Without valid bridge data there is no empty placeholder: the fixed row retains available usage information (or stays blank). No adapter for a specific subagent, `/goal` or todo plugin is bundled.

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
| `/hud preset minimal\|balanced\|full` | Select a fixed one-, two-, or three-row widget layout, or a two-, three-, or four-row footer body. |
| `/hud surface widget\|footer` | Select the surface. `footer` replaces the built-in footer and mounts no widget; an explicit command re-claims a slot taken by another extension. |
| `/hud scope observed\|session` | Select the usage scope. `observed` (default) keeps since-attach counters; `session` builds the full-session ledger and re-baselines on every switch. |
| `/hud palette pastel\|theme\|mono` | Select the field colors: the HUD's pastel palette (default), host theme tokens, or no color. |
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
  "surface": "widget",
  "language": "en",
  "palette": "pastel",
  "usageScope": "observed",
  "refreshMs": 250,
  "git": { "enabled": false }
}
```

The directory follows `PI_CODING_AGENT_DIR` when set. An absolute `PI_HUD_CONFIG` overrides the full file path. Relative overrides are rejected. Configuration is regular-file-only, read asynchronously with a 32 KiB hard cap, and never watched or rewritten. Unknown fields/types are rejected; a failed reload retains the previous configuration. Startup errors use defaults and remain visible through `/hud status`. See [configuration reference](docs/CONFIGURATION.md), [example](examples/pi-hud.json), and [JSON schema](docs/config.schema.json).

## Colors

Styling is semantic and per field, not per row. Plain text is laid out and truncated to the visible width first; only then is each segment colored, so a color can never change the layout. An alert recolors only its own field: a high context percentage does not tint the model, and one failed tool does not tint the whole line.

| Field | Role | Dark pastel | Light pastel | `theme` palette token |
| --- | --- | --- | --- | --- |
| Model | `model` | `#e5c890` | `#df8e1d` | `accent` |
| Thinking level | `thinking` | `#d8c39a` | `#c08a2e` | `thinkingText` |
| Project / path | `path` | `#a6d189` | `#40a02b` | `success` |
| Git branch | `git` | `#8caaee` | `#1e66f5` | `mdLink` |
| Phase / active tool | `phase` | `#ca9ee6` | `#8839ef` | `customMessageLabel` |
| Context value and bar | `context`, `barUsed` | `#ef9f76` | `#fe640b` | `mdHeading` |
| Numbers, cost, labels | `body`, `label` | `#c6d0f5`, `#838ba7` | `#4c4f69`, `#9ca0b0` | `text`, `muted` |
| Separators, empty bar | `separator`, `barEmpty` | `#838ba7`, `#6c7086` | `#9ca0b0`, `#ccd0da` | `dim` |
| Completion / waiting / failure | `success`, `warning`, `error` | `#a6d189`, `#f9e2af`, `#e78284` | `#40a02b`, `#9a6700`, `#d20f39` | `success`, `warning`, `error` |

`palette: pastel` (default) selects the soft dark-terminal candidates, or their deeper same-family variants when the host theme reports light text. `palette: theme` uses host theme tokens so the HUD follows a user theme. `palette: mono` and `color: false` render plain text; `ascii: true` swaps `·`, `█`, `░`, `✓`, `●`, `↑`, `↓` and `…` for ASCII equivalents while keeping translated labels and the `~` interruption mark. The full generated role table is in [preview.txt](docs/preview.txt).

## What the numbers actually mean

**`ctx(last)` is the last completed main-assistant response's usage snapshot**, not a live meter or an exact forecast of the next request. Its numerator is Pi's reported input + cache-read + cache-write + output tokens, divided by the selected model's context window. It does not include subsequent tool results, queued prompts, or a new system prompt. No per-delta approximation is invented. Resume, reset, tree navigation, compaction, a model change, or an error/aborted response can legitimately show `?`. A late response from a previous model never uses the newly selected model's denominator. This HUD is not an automatic-compaction threshold monitor.

**`*` means “observed since this HUD attachment/reset.”** Tool outcomes, token totals, compaction count, and `est*` cost exclude earlier history. Resuming a long session does not scan it. Tree navigation and re-enabling reset the observation scope; manual compaction invalidates context but retains the observed cumulative counters. The category ledger follows that same observation scope — it is cleared on reset, tree navigation and re-enabling, so old activity never leaks into a new session. Duplicate tool completions are deduplicated within a bounded recent-ID window. `limited*` means a record was dropped because a fixed cap was reached; unfinished tools are counted as interrupted after the run settles, never as success. Counts can be incomplete in that case and the per-category marks make it visible.

**`obs*` reports input, output and both cache counters separately.** Cached tokens are never added to fresh input again, so `↑in`, `↓out`, `RcacheRead` and `WcacheWrite` are the four reported fields instead of one merged number. `CH` is the cache-hit rate of the most recent assistant response with valid usage: `cacheRead / (input + cacheRead + cacheWrite)`, shown as `?` when that denominator is zero or the provider reported no cache data. Reset, a model switch and compaction clear a rate that no longer applies; aborted or errored responses never replace the last valid one. `obs*`, `last` and `est*` all mean the same thing: a bounded observation from this attachment, not the built-in footer's full-session ledger.

**`sess*` (opt-in `usageScope: "session"`) is the full-session ledger** over every entry the current SessionManager holds. Assistant messages, tool results that report usage, compaction and branch summaries each contribute their four token fields and their recorded `cost.total`; error/aborted responses count when they reported usage, and a retry never double counts the same record. Records with missing or invalid numbers mark the data incomplete (`+?`) instead of being silently dropped; a usage-less tool result is simply out of scope, never an unknown charge; a summary without usage keeps the known token subtotals and marks the cost incomplete; saturated sums show `limited*`. `/hud reset` clears the observed counters but keeps this account. See [the contract](docs/SESSION-USAGE-CONTRACT.zh-CN.md) for the exact scope, lifecycle and missing-data semantics.

**`est*` is a model-pricing estimate**, using Pi's reported `usage.cost.total`, not a bill or subscription allowance. Missing reports display `?`; partly known costs have `+?`. Historical, compaction-model, and unreported child-agent usage are not silently included. No provider credentials or subscription endpoints are read.

**Agents/tasks appear only through an explicit extension bridge.** A native `subagent` tool can appear as a bounded tool category, but that alone does not reveal its internal children. [Bridge protocol and examples](docs/BRIDGE.md) let a subagent or `/goal` extension publish small lifecycle records. There is no universal, preinstalled adapter for every third-party extension.

**Optional Git is a cached, idle-boundary snapshot.** It deliberately ignores untracked files, submodule state, line diffs, and ahead/behind counts. `*` means tracked changes; `git:?` means unavailable, not clean. Leave it off for the strictest low-contention configuration; the footer surface still shows Pi's own cached branch name, and the widget can keep using Pi's existing footer branch display.

## Core-loop protection

```text
native lifecycle/tool/final-message events
    -> bounded scalar state, synchronous void handlers
    -> one coalesced publication timer (250 ms minimum steady-state spacing)
    -> immutable-size snapshot -> cached widget lines
                                   -> requestRender only when lines change
```

There are no `message_update`/`tool_execution_update` listeners, `getBranch()`/`getContextUsage()` calls, synchronous filesystem/child-process calls, shell commands, recurring idle polling, editor/input hooks, LLM tools, message modifications, or session writes. `getEntries()`/`getEntry()`/`getLeafId()` may be called only by the optional session usage ledger (`src/usage.ts`) inside its marked history boundary, and only in cancelable background tasks scheduled from lifecycle events — never in render or per-token paths; `scripts/check.mjs` fails the build if any other file calls them. `ctx.ui.setFooter` is called only from the dedicated footer surface module (`src/footer.ts`), behind a capability check and a `tui`-mode guard; the same check enforces that boundary. A row is a bounded list of semantic segments (at most 12 fields and 40 segments); the final ANSI lines are cached and reused by stream-driven host renders unless width, published state, a status change or a theme invalidation changes. Headless/RPC modes allocate no HUD timers, read no HUD configuration, and attach no UI.

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
