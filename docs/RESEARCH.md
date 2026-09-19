# Source research and porting decisions

[简体中文](RESEARCH.zh-CN.md) · [Architecture](ARCHITECTURE.md)

Reviewed on **2026-09-19**. This is a source-level review, not a benchmark of Claude HUD. The source revisions are recorded in [upstream-lock.json](upstream-lock.json). Pi's old `badlogic/pi-mono` URL now redirects to `earendil-works/pi`; the implementation targets the published **v0.85.1** contract, not arbitrary unreleased `main` APIs.

## 1. Claude HUD is a status-line program, not an agent-loop extension

The [README](https://github.com/jarrodwatts/claude-hud/blob/939eb66485832dead1b0a28a954f76f7aa2bdb06/README.md) describes Claude Code invoking a program with JSON on stdin and rendering its stdout beneath the input area. It reports a 300 ms host debounce. This is a different execution boundary from a long-lived Pi extension in the same JavaScript process as the agent and TUI.

The [entry point](https://github.com/jarrodwatts/claude-hud/blob/939eb66485832dead1b0a28a954f76f7aa2bdb06/src/index.ts) reads stdin, parses the transcript, counts configuration resources, loads configuration, resolves VCS state, combines available usage data and renders a `RenderContext`. Feature switches gate some optional work. Errors are caught at the top level. Current usage data prefers host-provided stdin and can fall back to an explicitly configured local snapshot; this review does **not** assume every historical Claude HUD implementation still polls a subscriber endpoint.

**Keep:** the information hierarchy, compact contextual presentation, configurable density and honest unavailable states. **Do not copy:** the external invocation and transcript acquisition pipeline into Pi's process.

## 2. Transcript reconstruction and cache behavior

[`src/transcript.ts`](https://github.com/jarrodwatts/claude-hud/blob/939eb66485832dead1b0a28a954f76f7aa2bdb06/src/transcript.ts) reconstructs tool/agent/todo state and other session details from JSONL records. Its cache keys include canonical path, modification time, size and a version. Identical file state can reuse a serialized snapshot. On cache miss it opens a stream from the beginning and iterates lines; this is not an append-offset incremental tailer. The module also uses synchronous realpath/stat/cache reads and cache writes. Tool identities, agent associations and task semantics depend on Claude transcript conventions.

That design can be appropriate across short-lived status-line invocations, but a continuously changing transcript defeats the unchanged-file cache and makes input work proportional to history on misses. **This is a complexity observation, not a claim that Claude HUD is observably slow in practice.**

**Pi decision:** observe finalized native events once, keep bounded in-memory summaries, never open transcripts and never walk `sessionManager.getBranch()` in render or event callbacks. Counters explicitly start at HUD attachment/reset; history is not secretly reconstructed. Resume/tree changes start a new observation epoch.

## 3. VCS acquisition is optional work with a real cost

[`src/git.ts`](https://github.com/jarrodwatts/claude-hud/blob/939eb66485832dead1b0a28a954f76f7aa2bdb06/src/git.ts) resolves the ref and can execute status, numstat diff, upstream ahead/behind and remote lookup, using the git runner and command timeouts. It handles detached refs and missing upstreams. Those features are useful but not free on large worktrees.

**Pi decision:** keep the existing native footer, including its branch display. Additional HUD Git status is **off by default**. An opt-in probe uses one asynchronous `git status --porcelain=v2 --branch` command, no shell, no untracked traversal, no submodule inspection, no optional locks and no fsmonitor hooks. It runs only when the agent is idle at a natural refresh boundary, has a timeout, bounded output, cooldown and a single-flight cancellation mechanism. It does not periodically poll. This optional mode cannot promise zero disk/CPU contention.

## 4. Rendering details matter

Claude HUD's [renderer](https://github.com/jarrodwatts/claude-hud/blob/939eb66485832dead1b0a28a954f76f7aa2bdb06/src/render/index.ts) is modular and includes ANSI-aware width handling, grapheme segmentation and hyperlink-closing logic for truncation. The README exposes layouts, presets, language and numerous toggles.

**Pi decision:** a named `setWidget` component below the editor by default, rather than a custom footer or editor replacement. Fixed 1/2/3-row layouts reduce vertical churn. The renderer consumes only bounded snapshots, lays out plain text before coloring bounded semantic segments, caches final lines by width, published state and theme invalidation, strips untrusted terminal controls, and defaults to its own pastel field palette (`theme` follows host tokens, `mono`/`color: false` stay plain). Chinese and emoji clipping is tested; an ASCII-glyph mode is available for ambiguous-width terminals. No raw terminal writes or mouse/keyboard hooks are installed.

## 5. Pi's public integration boundary

The published [v0.85.1 extension types](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/extensions/types.ts) provide `mode`, `setWidget`, component disposal, finalized message/tool events, session shutdown and other lifecycle notifications. `hasUI` also covers RPC, so terminal-only code must check `mode === "tui"`. The [lifecycle reference](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md) distinguishes `agent_end` from `agent_settled`: automatic retry/compaction/follow-up can continue after a low-level run ends. Session replacement/reload tears down and starts a new extension runtime.

The [custom-footer example](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/examples/extensions/custom-footer.ts) is useful for API discovery but illustrates scanning the branch inside render; pi-hud deliberately does not adopt that approach. Package discovery follows the [official package manifest](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md).

**Pi decision:** no `message_update`, `tool_execution_update`, input interception, `tool_call`, `tool_result`, context rewriting, custom model tool or prompt injection. Hooks synchronously update small scalars/maps and request one coalesced callback, then return `undefined`. Expensive/optional work is outside those hooks. All callbacks are fail-open.

## 6. Data semantics, not feature-shaped guesses

- **Context:** `input + cacheRead + cacheWrite + output` from the last completed successful assistant response, divided by that model's context window. It is labelled **ctx(last)**, not exact live context. New user/tool text is not counted until a later response reports usage. Compaction/model change/reset invalidates it. Unknown remains unknown.
- **Cost:** sum of observed assistant `usage.cost.total`, explicitly estimated and since attachment. Not an invoice, account balance, subscription quota, cross-session ledger or complete session bill. Compaction/subagent costs are not silently added.
- **Tools:** native start/end IDs and error flags; no transcript, output-text parsing or shell-command display.
- **Agents/tasks:** a versioned opt-in event-bus bridge. An arbitrary third-party `subagent` tool is visible as a tool, but its children are not invented. Adapters emit actual lifecycle/progress facts. Bounded expiry prevents abandoned running badges living forever.
- **Subscription quota:** not implemented. Claude-specific credential access or provider endpoints are not a portable Pi API.

## 7. Performance acceptance and remaining evidence

A shared event loop means literal zero overhead is impossible. The enforceable goal is bounded marginal work, no per-token subscription, a maximum four scheduled HUD publications per second by default, unchanged-frame reuse and no recurring idle polling. Module loading and first widget paint still cost something. Optional config I/O is asynchronous, once per attachment/reload, and capped at 32 KiB. Bridge expiry is a one-shot timer, not an animation loop.

See [PERFORMANCE.md](PERFORMANCE.md) for reproducible tests, budgets and A/B instructions. Mock/event benchmarks prove specific local properties; they do not prove perceptual equivalence across every terminal, OS, worktree and extension combination. The delivery verification record must distinguish actual runs from prepared but unexecuted upstream SDK/PTY checks.
