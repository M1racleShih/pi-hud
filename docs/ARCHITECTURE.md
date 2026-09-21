# Architecture and invariants

[README](../README.md) · [Research](RESEARCH.md) · [Performance](PERFORMANCE.md)

## Decision: the footer surface by default (owner-approved), with the passive widget as the explicit alternative

`index.ts` re-exports a native-ESM implementation. Pi loads this as an extension. The package manifest declares only that extension: no tools, skills, prompt templates, provider hooks, or agent instructions. Module initialization imports small modules but does not read files or create timers. A startup environment kill switch exits before registering events or `/hud`.

The normal factory registers 17 observational lifecycle/event callbacks, one pinned high-frequency stream listener (`message_update`, sampling exactly one first-token timestamp per assistant message for the `spd*` generation-speed field; algorithm in [TOKEN-SPEED.zh-CN.md](TOKEN-SPEED.zh-CN.md)) and one user command. A TUI `session_start` creates `HudController`, whose surface is chosen by `surface`:

- `widget` mounts the named `pi-hud` widget, which coexists with the editor, Pi's built-in footer and other widgets; select it explicitly with `surface: "widget"`.
- `footer` calls `ctx.ui.setFooter` from the dedicated `src/footer.ts` boundary and mounts no widget, so the same information is not drawn twice.

`mode === "tui" && hasUI` is required; RPC having UI capability does not make it a terminal. No headless mode calls `setWidget` or `setFooter`.

```text
Pi event handlers -> HudState (bounded summaries)  +  cached identity (cwd/provider/title)
                          |
                          v
                  Coalescer (one timer)
                          |
                          v
        snapshot -> HudView.publish (widget)   -> compare cached lines
                 -> HudFooterView.publish (footer) -> compare cached lines
                                                |
                                                v
                                     TUI.requestRender (only changed)

Pi's own stream/keyboard render -> HudView.render(width) / HudFooterView.render(width)
                                 cache hit: return existing string[]
```

## Separation of costs

`state.ts` sanitizes only selected bounded strings and retains scalars/maps. No callback retains an event, output block, prompt, transcript or session manager reference. Finalized assistant usage is accepted once per native `message_end`, not parsed from accumulated history. The native contract is expected to deliver each final assistant event once; arbitrary replay of historical message events is not deduplicated as a transcript ingestion feature.

The same module owns the single high-frequency acquisition path, wrapped in its marked `stream-boundary` section: `messageUpdate` arms on `message_start` (assistant), records the arrival time of the first content-bearing delta (`text_delta`/`thinking_delta`/`toolcall_delta` with a non-empty string), and then fuses — every further delta of that message returns after one boolean comparison, no string is retained beyond the `length > 0` check, and no repaint is scheduled from the fused path. `message_end` settles the sample into three scalars (`speedRate/speedTokens/speedMs`) behind the five documented discard guards (error/abort, missing usage, unobserved first token, sub-50 ms window, model mismatch); a discarded measurement keeps the previous valid value, reset and a model switch clear it, and compaction deliberately keeps it. `scripts/check.mjs` pins `STREAM_EVENTS` to exactly `message_update` and requires the fused early-return inside the boundary.

`usage.ts` is the optional full-session usage ledger (`usageScope: "session"`, phase 3 B2a; contract in [SESSION-USAGE-CONTRACT.zh-CN.md](SESSION-USAGE-CONTRACT.zh-CN.md)). It is deliberately separate from the resettable observed state so `/hud reset` cannot zero history totals. All host history access lives inside its marked history boundary: `getEntries()` runs exactly once per baseline rebuild, captured together with the leaf and session id in one synchronous block, and `getEntry()`/`getLeafId()` serve the incremental reconciliation. A baseline aggregates the captured shallow array in slices (at most 512 entries or ~2 ms, whichever comes first) on one-shot cancelable timers, catches up appends that happened meanwhile by walking the parent chain, and publishes only after re-checking its generation and session id — a stale task can never publish or mutate newer state. Steady turns are reconciled at `turn_end`/`agent_settled`: the walk aggregates into temporary scalars and commits only when the committed cursor anchors the chain, so baselines and increments cannot overlap and duplicate notifications cannot double count. Broken chains, cycles, over-cap deltas (2048), a failed baseline catch-up, tree navigation and compaction drop uncommitted work and schedule exactly one recovery rebuild (a catch-up recovery that fails again does not self-perpetuate: the gap stays recorded and the next event boundary retries); failures record their reason, are cleared by a recovered full read, and never become an idle retry loop. Pi's `resetLeaf()` tree navigation (re-editing the first user message) keeps history while nulling the leaf; that null cursor is a legal anchor, and a later root-level append commits exactly once. `message_end` only marks the snapshot updating; the ledger reads final committed entries, so a later extension replacing the observed message cannot skew the account. Missing or invalid numbers mark the data incomplete instead of being dropped; usage-less tool results are out of scope; usage-less summaries keep token subtotals and mark cost incomplete; saturated sums set `limited`. Off/scope-exit/session-switch bump the generation, cancel the timer and release the O(N) array reference. Render paths only see the immutable published view (`sess*` fields with loading/updating/partial/saturation markers, all placed before the numbers and carried independently by the token and cost fields so layouts without the token field — and clipped narrow rows — stay self-describing); a coverage gap created by a failed catch-up or walk is cleared only when a later anchored verification commits exactly that segment; an unavailable host surface degrades explicitly to observed-labelled data.

`scheduler.ts` is a trailing coalescer with non-starving throttling. The first dirty publication can be immediate; subsequent scheduled publications are at least `refreshMs` apart. Multiple events share one pending timer. No `setInterval`, animation clock or idle heartbeat exists. Cancellation is idempotent and timers are unreferenced when supported.

The bounded activity ledger keeps at most 16 sanitized tool names in its per-name map and merges every further name into one separate overflow record (never stored under a tool name, so a real tool called `other` is unaffected). Success, failure and interruption are counted separately per category; a tool start is never a completion, and a duplicate completion ID is ignored. A three-entry ring of the newest terminal outcomes feeds the idle summary and changes only when a real lifecycle event changes it — there is no TTL, timer or animation. `settle()` records still-active tools as interrupted rather than successful. `reset`, tree navigation, off/on and a new session replace the ledger, so no previous-scope activity can leak into the next one.

`render.ts` consumes an already-sanitized snapshot, uses fixed row counts, and drops lower-priority fields before overflowing. Each row is a bounded list of semantic segments (`role`, plain `text`): widths are measured and truncation happens on the plain text first, and `palette.ts` styles the surviving segments afterwards, so color can never change the layout. The identity row measures the context field first and reserves it (plus its separator) before clipping the model name; below 45 columns the context meter outranks the model, so a long model name cannot hide a high-usage warning. On the activity row the stable phase outranks the tool categories; failure counts remain on categories without a duplicate aggregate field. A field-level alert recolors only its own segments. `text.ts` measures a row with a per-code-point fast path and falls back to `Intl.Segmenter` only when a real grapheme-cluster candidate (mark, ZWJ, variation selector, emoji or regional indicator) is present; a differential test asserts equivalence with the segmenter-based reference. Cached unchanged frames reuse the same array. Width changes and host theme invalidation legitimately recompute; both clear the memoized styler so a light/dark switch or palette change is re-detected. Publishing an unchanged visual result makes no render request. Host `invalidate()` behavior can cause extra recomputation; the cache is not a claim that a host never invalidates on its own.

`footer.ts` reuses the same field layout through `assembleRow` and the same semantic roles. The footer body is fixed at 2/3/4 rows (`minimal`/`balanced`/`full`), and tool start, completion, failure or settling never changes that count. Identity values (display cwd, provider, session title) are cached on the controller at lifecycle boundaries; the Git branch is read from `footerData.getGitBranch()` when the footer is installed and from `onBranchChange()`, which is why no Git process is started for the branch name. Render never calls `getGitBranch()`, `getSessionName()`, `getEntries()` or `getContextUsage()`.

### Footer ownership

`ctx.ui.setFooter` is a single replacement slot, not a stack. The controller therefore tracks ownership instead of assuming it:

| Event | Controller reaction |
| --- | --- |
| HUD installs the footer | remembers the component and marks itself owner |
| Host calls `component.dispose()` (another extension or a host reset took the slot) | forgets ownership, unsubscribes `onBranchChange`, sets a suppression flag, and does **not** call `setFooter(undefined)` |
| `/hud off`, surface switch, session shutdown, session replacement while still owner | disposes its own component, unsubscribes, then calls `setFooter(undefined)` exactly once to restore the built-in footer |
| Plain refresh, tool event, config change while suppressed | re-attaches nothing; only an explicit `/hud surface footer` (or a new session) clears suppression |

Self-release disposes the component before restoring the native footer, so the host's follow-up `dispose()` is a no-op and a release can never restore twice or recurse. `scripts/check.mjs` requires every `setFooter` call to live inside the marked boundary section of `src/footer.ts` and keeps the full forbidden-API list for every other file; the same check confines `getEntries()`/`getEntry()`/`getLeafId()`/`getSessionId()` to the marked history boundary of `src/usage.ts`, while `getBranch()`/`getContextUsage()` stay forbidden everywhere, boundary included; and it pins the stream bridge: `message_update` stays out of `OBSERVED_EVENTS`, `STREAM_EVENTS` must equal exactly `["message_update"]`, and `src/state.ts`'s stream boundary must open with the fused early-return guard and may only read the delta event's `type` and `delta`.

### Bounded extension-status comparison

Pi's `ctx.ui.setStatus(key, text)` mutates one `Map` in place and then calls `requestRender()`. There is no revision counter and no change notification, and `getExtensionStatuses()` returns that same live map, so identity comparison cannot detect a change. The HUD therefore compares values, at the only place the host guarantees to call after `setStatus`:

- **Location:** `HudFooterView.render()`, before the cached-frame early return. The host renders the footer after `setStatus` -> `requestRender`, so a change is visible in the same frame without any HUD event, timer or polling.
- **Capacity:** at most `MAX_STATUS_COUNT` (8) entries are read per check, keys are compared as plain strings (never sanitized unless they changed), and the map's `size` is compared as well. A status added, changed or deleted beyond the sample still changes `size` or the sampled values, so every display-affecting change invalidates the frame.
- **Cost:** at most nine map pulls plus at most 16 string comparisons per render, independent of the number of statuses and of session length; sanitization (`safeText`) runs only while building the display rows. Cached frames do not allocate when nothing changed, and the final rendered array is reused.

Status display is bounded separately: `MAX_STATUS_TEXT` 64 sanitized characters per entry, `MAX_STATUS_ROWS` 2 rows, `MAX_STATUS_COUNT` 8 displayed entries, folding into an explicit `+N` marker, and `MAX_FOOTER_ROWS` 6 total rows. Control characters and ANSI sequences are stripped by `safeText`; status strings are never parsed into progress or completion claims. The status area is supplementary: if a provider throws, the body still renders and the failure is counted in `/hud status`.

`config.ts` reads one bounded regular file asynchronously after the lifecycle hook has returned, or on an explicit reload command. `git.ts` is an optional, isolated, asynchronous child-process wrapper. Neither runs during rendering. Async operations still involve completion callbacks on the shared event loop; only the synchronous acquisition/CPU-heavy paths are eliminated.

## State bounds

| State | Hard bound | Overflow behavior |
| --- | --- | --- |
| Active native tools | 64 | Extra active records are dropped; diagnostic count increases. |
| Recent completion IDs | 128 | Oldest ID is evicted. This is not full-history deduplication. |
| Retained tool categories | 16 names plus one separate overflow record | Further names update the overflow record. A real tool named `other` keeps its own counters; the renderer displays at most three names plus a `+N` mark. |
| Bridged agents | 16 | New unique IDs beyond the cap are dropped; existing IDs can update. |
| Bridged task groups | 8 | Same bounded policy. |
| Activity label | 100 characters after bounded sanitization | Truncated; control/bidi sequences removed. |
| Config file | 32 KiB | Rejected, including growth beyond the stat size. |
| Git stdout/stderr buffer | 16 KiB | Probe fails to unknown rather than treating truncated status as clean. |
| Display | widget 1/2/3 rows, footer body 2/3/4 rows plus at most 2 status rows (6 total), at most 4096 columns accepted | Smaller widths clip safely; width zero returns empty row text. |
| Row segments | `MAX_ROW_FIELDS` 12 fields, `MAX_ROW_SEGMENTS` 40 segments | Lower-priority fields are dropped, then the row is clipped at the right edge. |
| Extension statuses | 8 entries displayed from an 8-entry sample, 64 characters each, 2 rows | Extra entries fold into `+N`; control/ANSI sequences are stripped; keys/texts are truncated. |
| Token speed | 5 scalars (armed flag, first-token timestamp, rate, tokens, ms) | Per assistant message: one timestamp, then the bridge fuses; discarded samples never overwrite the previous value. |
| Session usage ledger | one planned + one active task; baseline slices of 512 entries / ~2 ms; incremental walks capped at 2048 entries | A baseline keeps one shallow entries array for its duration and releases it afterwards; increments keep no per-record state; failures schedule one recovery rebuild, never a retry loop. |
| Cached identity | cwd 72, provider 64, title 80, branch 32 characters | Truncated at the lifecycle boundary, never re-read during render. |
| Tool activity | widget 1/2/3 rows, footer body row count independent of activity | Tool start, completion, failure and settling never change a selected preset's row count. |

Snapshot iteration is over these fixed caps, never over session length. Diagnostic scalars and totals do not create a growing ledger. A high-rate malicious extension can still spend CPU invoking the shared bus; a HUD cannot isolate arbitrary code already trusted inside Pi's process.

## Lifecycle and race protection

Session shutdown, replacement, fork/resume, reload and surface switching release the widget or footer, pending publication/config/expiry timers, the optional child process, the optional session usage ledger and event-bus listener. Late asynchronous results are ignored with generation tokens, and a host-driven footer disposal unsubscribes the branch listener immediately. Tree navigation resets the observation epoch because history scanning is deliberately absent from the observed counters; the optional session ledger instead rebuilds once from the manager's entries. Model changes, compaction and reset invalidate context and the cached cache-hit observation. Responses arriving from a previously selected model count toward observed usage but do not populate context or the cache-hit rate for the new model.

`agent_end` displays settling; only `agent_settled` returns to idle and clears unfinished tools, counting each one as interrupted in its category. UI prompts temporarily show waiting. The optional Git probe is cancelled when the agent starts and is allowed only at actual idle refresh boundaries. Its previous cached status can remain visible until the next successful refresh; it is not live state.

The extension never returns message/result replacements, never blocks a tool, never invokes compaction, and never waits for I/O in a core event callback. Exceptions are contained and counted in `/hud status`, with no raw console output that could corrupt the terminal or RPC framing. This is best-effort error containment, not process-level isolation from host bugs, out-of-memory conditions, or hostile third-party code.

## Intentional exclusions and data-coverage limits

There is no subscriber quota fetcher, arbitrary command segment, memory/process probe, daily billing ledger, plugin/skill directory scanner, transcript tailer, **live** token speed estimator, animated spinner, input interception or full-session replay. These are excluded because they either require new data acquisition, misleading estimates, unbounded work, or ownership of core UI behavior. New features must identify a native low-frequency event or an explicit bounded bridge before adding acquisition code — the `spd*` generation-speed field is the worked example: it reuses the low-frequency `message_start`/`message_end` pair and adds exactly one pinned stream-sample timestamp (`STREAM_EVENTS`, stream boundary, fused guard) instead of a per-delta counter, sliding window or smoothing; its spec and cost analysis live in [TOKEN-SPEED.zh-CN.md](TOKEN-SPEED.zh-CN.md).

The footer surface keeps the same exclusions. In the default `observed` scope it does not call `getEntries()`, `getBranch()` or `getContextUsage()`, does not rebuild history, and does not guess the host's auto-compaction setting, subscription flag or provider count. Its usage counters remain an observation from the current attachment/reset, its `CH` value describes the most recent valid assistant response, and its context field remains the labelled `ctx(last)` snapshot. With the explicit `usageScope: "session"` opt-in, the dedicated ledger module reads the read-only entry surface within the limits above; it still never calls `getBranch()` or `getContextUsage()`, never reads session files, and never re-prices history with current model prices. The built-in footer's live context estimate is therefore **not** reproduced in any mode; `/hud status` reports the exact coverage instead of hiding it.

The displayed phase groups model work, tool execution and settling as working; waiting remains distinct and only settlement returns to ready. Tool names/targets do not change the activity label. Internal tool tracking and failure totals remain available to state and diagnostics.
