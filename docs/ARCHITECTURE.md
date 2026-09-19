# Architecture and invariants

[README](../README.md) · [Research](RESEARCH.md) · [Performance](PERFORMANCE.md)

## Decision: a passive widget, not a replacement UI

`index.ts` re-exports a native-ESM implementation. Pi loads this as an extension. The package manifest declares only that extension: no tools, skills, prompt templates, provider hooks, or agent instructions. Module initialization imports small modules but does not read files or create timers. A startup environment kill switch exits before registering events or `/hud`.

The normal factory registers 14 observational lifecycle/event callbacks and one user command. A TUI `session_start` creates `HudController`, whose named widget `pi-hud` coexists with the existing editor/footer/other widgets. `mode === "tui" && hasUI` is required; RPC having UI capability does not make it a terminal.

```text
Pi event handlers -> HudState (bounded summaries)
                          |
                          v
                  Coalescer (one timer)
                          |
                          v
              snapshot -> HudView.publish -> compare cached lines
                                                |
                                                v
                                    TUI.requestRender (only changed)

Pi's own stream/keyboard render -> HudView.render(width)
                                 cache hit: return existing string[]
```

## Separation of costs

`state.ts` sanitizes only selected bounded strings and retains scalars/maps. No callback retains an event, output block, prompt, transcript or session manager reference. Finalized assistant usage is accepted once per native `message_end`, not parsed from accumulated history. The native contract is expected to deliver each final assistant event once; arbitrary replay of historical message events is not deduplicated as a transcript ingestion feature.

`scheduler.ts` is a trailing coalescer with non-starving throttling. The first dirty publication can be immediate; subsequent scheduled publications are at least `refreshMs` apart. Multiple events share one pending timer. No `setInterval`, animation clock or idle heartbeat exists. Cancellation is idempotent and timers are unreferenced when supported.

`render.ts` consumes an already-sanitized snapshot, uses fixed row counts, and drops lower-priority segments before overflowing. Cached unchanged frames reuse the same array. Width changes and host theme invalidation legitimately recompute. Publishing an unchanged visual result makes no render request. Host `invalidate()` behavior can cause extra recomputation; the cache is not a claim that a host never invalidates on its own.

`config.ts` reads one bounded regular file asynchronously after the lifecycle hook has returned, or on an explicit reload command. `git.ts` is an optional, isolated, asynchronous child-process wrapper. Neither runs during rendering. Async operations still involve completion callbacks on the shared event loop; only the synchronous acquisition/CPU-heavy paths are eliminated.

## State bounds

| State | Hard bound | Overflow behavior |
| --- | --- | --- |
| Active native tools | 64 | Extra active records are dropped; diagnostic count increases. |
| Recent completion IDs | 128 | Oldest ID is evicted. This is not full-history deduplication. |
| Bridged agents | 16 | New unique IDs beyond the cap are dropped; existing IDs can update. |
| Bridged task groups | 8 | Same bounded policy. |
| Activity label | 100 characters after bounded sanitization | Truncated; control/bidi sequences removed. |
| Config file | 32 KiB | Rejected, including growth beyond the stat size. |
| Git stdout/stderr buffer | 16 KiB | Probe fails to unknown rather than treating truncated status as clean. |
| Display | 1/2/3 rows, at most 4096 columns accepted | Smaller widths clip safely; width zero returns empty row text. |

Snapshot iteration is over these fixed caps, never over session length. Diagnostic scalars and totals do not create a growing ledger. A high-rate malicious extension can still spend CPU invoking the shared bus; a HUD cannot isolate arbitrary code already trusted inside Pi's process.

## Lifecycle and race protection

Session shutdown, replacement, fork/resume and reload release the widget, pending publication/config/expiry timers, optional child process and event-bus listener. Late asynchronous results are ignored with generation tokens. Tree navigation resets the observation epoch because history scanning is deliberately absent. Model changes and compaction invalidate context. Responses arriving from a previously selected model count toward observed usage but do not populate context for the new model.

`agent_end` displays settling; only `agent_settled` returns to idle and clears unfinished tools as interrupted. UI prompts temporarily show waiting. The optional Git probe is cancelled when the agent starts and is allowed only at actual idle refresh boundaries. Its previous cached status can remain visible until the next successful refresh; it is not live state.

The extension never returns message/result replacements, never blocks a tool, never invokes compaction, and never waits for I/O in a core event callback. Exceptions are contained and counted in `/hud status`, with no raw console output that could corrupt the terminal or RPC framing. This is best-effort error containment, not process-level isolation from host bugs, out-of-memory conditions, or hostile third-party code.

## Intentional exclusions

There is no subscriber quota fetcher, arbitrary command segment, memory/process probe, daily billing ledger, plugin/skill directory scanner, transcript tailer, live token speed estimator, animated spinner, input interception or full-session replay. These are excluded because they either require new data acquisition, misleading estimates, unbounded work, or ownership of core UI behavior. New features must identify a native low-frequency event or an explicit bounded bridge before adding acquisition code.
