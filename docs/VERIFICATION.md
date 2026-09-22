# Delivery verification record

[README](../README.md) · [中文首页](../README.zh-CN.md) · [Performance evidence](PERFORMANCE.md)

Date: **2026-09-19**. This document distinguishes actual evidence from executable checks that are only prepared. There is no blanket “production proven” claim.

## Executed in the delivery sandbox

| Check | Status and scope |
| --- | --- |
| Native regression suite | **90 tests passed**, zero failed/skipped on the local Linux run. Includes state, configuration, lifecycle, render, cancellation and bridge limits. |
| Local real-Git integration | Passed using a temporary repository: tracked changes, untracked exclusion, detached HEAD and failure handling. This is not a Pi host test. |
| Synthetic performance gates | Passed; exact environment, methodology and timings are in [performance-baseline.json](performance-baseline.json). |
| Coverage run | Executed with Node's test coverage. Source line coverage ranged from 95.71% to 100% in the captured run; branch coverage is lower. The log includes test files as well, so its aggregate percentage is not promoted as source-only coverage. |
| Syntax and boundary checks | Executed for runtime module syntax, forbidden core-path APIs/imports, manifest and bilingual/relative documentation links. |
| Packaging smoke | Executed with `npm pack`, empty-cache production `npm install --offline --omit=dev --ignore-scripts`, and native Node import of the packed `index.ts`. This verifies package completeness, not Pi's loader. |
| Source review | Claude HUD pinned commit and Pi v0.85.1 public types, lifecycle, widget, package and RPC contracts reviewed. [Source locks](upstream-lock.json). |
| Git workflow | Actual local topic branches, commits and non-fast-forward merges. The delivery's Git bundle retains history. No GitHub pull request or remote run is fabricated. |

Local execution used Linux x64, Node **22.16.0**, npm 10.9.2 and Git 2.47.3. The available Node is below Pi 0.85.1's supported minimum (22.19.0), so standalone module success must not be described as validated host compatibility. The shipped package requires Node ≥22.19.0 for use with Pi.

## Prepared, but NOT executed here

| Check | How to run / remaining limitation |
| --- | --- |
| Actual Pi SDK contract | `.github/workflows/ci.yml` installs Pi 0.85.1 in `.tmp/sdk`, then runs `scripts/sdk-check.mjs`. Requires package/network access. This checks accessed API contracts, not static typing of every implementation path. |
| Actual Pi extension loader/RPC | `node scripts/pi-rpc-smoke.mjs` after the isolated SDK install. No model calls or credentials. |
| Actual Pi TUI/PTY smoke | `python3 scripts/pi-pty-smoke.py` on Linux/macOS after the SDK install. Tests mount/layout/resize/toggle, not streamed model performance. |
| Cross-platform matrix | GitHub CI prepares Linux/macOS/Windows × Node 22.19.0/24. Only local Linux execution happened in this delivery. |
| Live provider/tool/keyboard A/B | Follow [PERFORMANCE.md](PERFORMANCE.md). No measured claim of end-to-end perceptual equivalence has been made. |
| Remote review and release | Workflows/templates are included, but no remote repository was created, no PR was opened, no branch protection configured, no action run triggered and no release/npm package published. |

The sandbox could read upstream source through connected retrieval, but direct npm/Git downloads needed to execute the host were unavailable. Rather than substitute mocks and call them integration, the implementation includes explicit runnable checks and this gap remains visible.

> The pinned SDK/RPC/PTY checks listed as prepared above were later **executed** in the phase-1 environment; see the record below.

## Phase 1: per-field colors and semantic segments (2026-09-20)

The v0.1.0 record above is kept unchanged as the historical delivery record. This phase replaced the whole-row tone with bounded semantic segments (`{ role, text }`), added the `pastel`/`theme`/`mono` palettes, and re-ran the gates. Unlike the original sandbox, the pinned Pi 0.85.1 host was installed locally, so the SDK, RPC and PTY checks below are **executed results**, not prepared instructions.

Environment: Linux x64, Node **v24.19.0**, npm 11.17.0, AMD Ryzen 7 9700X, Pi `@earendil-works/pi-coding-agent@0.85.1` installed under ignored `.tmp/sdk`. Node 24 is above the package minimum; the pinned host itself still targets Node ≥22.19.0.

| Check | Result |
| --- | --- |
| `npm test` | **126 tests passed**, zero failed/skipped (36 more than the 90 in the v0.1.0 record). The new and rewritten tests cover layouts at 0–180 columns, 40/80/120/180 expectations, CJK/emoji/long-path/narrow widths, segment caps, per-field alert scoping, palette mapping and 256-color conversion, ASCII purity, theme invalidation and cache identity. A review-driven regression test covers long model names with Chinese labels at 20–44 columns and fails against the pre-fix layout. |
| Coverage run | `render.ts` and `palette.ts` reached 100% line coverage (branch coverage 93.60% / 98.72%). |
| `npm run check` | Passed. Now also asserts that the JSON schema and example equal the runtime defaults and that `docs/preview.txt` matches the deterministic renderer output. |
| `npm run verify` | Passed end to end: check, tests, synthetic performance gates. |
| `npm run package:check` | Passed: `pi-hud-0.1.0.tgz`, 33 files, 89,356 bytes, empty-cache offline production install and packed entry import. `src/palette.ts` is now a required packed file. |
| Same-machine A/B | 8 interleaved before/after runs on the final renderer; gates unchanged. Uncached render mean −32.7%, p50 −40.6%, p95 −39.3%, cached render mean −8.8%, hook p99 within sub-microsecond noise, uncached p99 +40.5% (0.42 ms → 0.59 ms against the unchanged 5 ms gate; traced to GC pause, not renderer work). Full data: [performance-phase1-ab.json](performance-phase1-ab.json), discussion: [PERFORMANCE.md](PERFORMANCE.md). |
| `node scripts/sdk-check.mjs` | Passed against the real pinned package. Extended to type-check every HUD theme-role token against Pi's `ThemeColor` union and the `Theme.fg`/`getFgAnsi`/`getColorMode` surface used by the renderer. A negative control (`"notAColor"`) was confirmed to fail the same compiler invocation. |
| `node scripts/pi-rpc-smoke.mjs` | Passed: real Pi loads `index.ts`, registers `/hud`, and emits no HUD UI output in RPC. |
| `python3 scripts/pi-pty-smoke.py` | Passed in a disposable PTY: the real TUI mounts the HUD with pastel field colors, switches to `mono` (no field colors), back to `pastel`, switches preset, resizes 120→70 columns, and toggles off/on. No model request or credentials. |
| Generated preview | `docs/preview.txt` regenerated from the renderer and asserted by `npm run check`; it is not hand-written and is no longer a six-line approximation. It includes narrow-width identity rows with a long model name to document the context-warning retention. |

### Pending, not executed

| Item | Why it remains open |
| --- | --- |
| Real dark/light terminal visual acceptance | No interactive terminal session with both a dark and a light theme was driven by a human observer. The palette's light/dark variants were only verified through synthetic themes (unit tests) and one PTY run with the default dark theme. 40/80/120/180-column appearance, contrast and alert legibility still need an observer. |
| Live model-stream / tool-dispatch / keyboard A/B | Requires a deterministic provider fixture and external instrumentation per [PERFORMANCE.md](PERFORMANCE.md). Not run. |
| Cross-platform matrix | Only local Linux was executed; the workflow still prepares macOS/Windows and Node 22.19.0/24. |
| Footer takeover, quota data, historical usage totals | Out of scope for this phase; see [VISUAL-FOOTER-PLAN.zh-CN.md](VISUAL-FOOTER-PLAN.zh-CN.md). The default surface is still a widget and no history is scanned. |

Passing the checks above must not be described as human visual acceptance or as live-stream performance equivalence. Those two claims are still unproven.

## Phase 2: bounded activity information (2026-09-20)

This phase added the bounded per-tool-name category ledger (16 names plus one `other` bucket; success, failure and interruption counted separately), the running-tool/file-target priority display, the bounded recent-completion summary, removal of the empty bridge placeholder, and a width fast path in `text.ts`. Footer takeover, quota data and the usage aggregation rules were not touched. The environment is the same as the phase-1 record above: Linux x64, Node **v24.19.0**, npm 11.17.0, AMD Ryzen 7 9700X, Pi `@earendil-works/pi-coding-agent@0.85.1` installed under ignored `.tmp/sdk`.

| Check | Result |
| --- | --- |
| `npm test` | **149 tests passed**, zero failed/skipped (23 more than the 126 in the phase-1 record). New coverage: concurrent instances of one category, duplicate completion events, success/failure/interruption separation, unknown/empty/oversized tool names, the 16-name retention cap with a collision-free overflow record (including a real tool literally named `other`), the interruption cap, target sanitization and non-file-argument isolation, the bounded newest-first recent ring shown exactly once per frame, reset/off-on/session-replacement/disposed-view isolation, 40/80/120/180 columns with saturated activity, ASCII marks, all three palettes, hidden zero-count fields, and fixed 1/2/3 row counts across idle/running/completed/settled transitions. Source line coverage stayed at 100% for `render.ts`, `state.ts`, `text.ts` and `palette.ts` (branch coverage 94.04% / 94.96% / 88.51% / 98.72%). |
| Phase-1 narrow regression retained | The zh-CN 40-column case with `Claude Sonnet 4.5 (200k)`, 95% context, three running tools, 17 distinct categories, errors and an interruption still shows the context label, the `95%!` warning and the current tool; the test additionally asserts the error alert survives while categories and history fold. The preview generator emits the same case. |
| `visibleWidth` differential test | A seeded 400-string fuzz corpus plus fixed CJK/emoji/ZWJ/flag/keycap/mark/ANSI strings assert that the new code-point fast path equals an independent `Intl.Segmenter`-based reference. |
| `npm run check` | Passed; `docs/preview.txt` was regenerated from the renderer and matches. |
| `npm run verify` | Passed end to end with the new bench scenarios and unchanged gates (hook p99 ≤ 250 µs, uncached render p99 ≤ 5 ms, cached mean ≤ 5 µs). |
| `npm run package:check` | Passed: `pi-hud-0.1.0.tgz`, 34 files (the new phase-2 A/B record adds one), about 107.3 kB — the check prints the exact byte count, which moves by one byte when this record itself is edited — with an empty-cache offline production install and packed entry import. |
| Same-machine A/B | 8 interleaved pairs against `622c949`, the identical probe file copied into both worktrees and shared fixtures. Uncached renders improved 67–90% (category-saturated p50 24.2→7.4 µs, mean 34.3→9.2 µs, p99 677→68 µs; concurrent activity mean 26.7→6.5 µs; empty idle row 20.6→2.8 µs), the tool-pair hook p99 rose by +0.24 µs in paired means (individual pairs up to 1.1 µs absolute, still far below the 250 µs gate), cached mean unchanged within noise. Full data: [performance-phase2-ab.json](performance-phase2-ab.json). |
| `node scripts/sdk-check.mjs` | Passed against the real pinned package. No new SDK surface was needed; the pinned contract is re-checked anyway. |
| `node scripts/pi-rpc-smoke.mjs` | Passed: real Pi loads `index.ts`, registers `/hud`, strict JSON framing, no HUD UI output in RPC. |
| `python3 scripts/pi-pty-smoke.py` | Passed in a disposable PTY. The script now also loads `examples/bridge-demo.ts`, runs `/hud-demo`, verifies the full-preset bridge summary label (`DEMO: build Pi HUD`), resizes 120→70 columns with that row still present, and switches palette/off/on. No model request, no credentials, and therefore no native tool execution. |

### Pending, not executed

| Item | Why it remains open |
| --- | --- |
| Real terminal rendering of native tool categories and the recent-completion summary | The PTY smoke makes no model/tool call, so it cannot produce real `tool_execution_start`/`tool_execution_end` events; the category ledger is covered by unit tests, the generated preview and the synthetic A/B only. A live or fixture-driven tool session still needs an observer. |
| Real dark/light terminal visual acceptance | Unchanged from phase 1: no human observer drove both a dark and a light theme, and 40/80/120/180-column appearance was checked through the renderer and one 120→70-column PTY run, not by eye. |
| Live model-stream / tool-dispatch / keyboard A/B | Requires a deterministic provider fixture and external instrumentation per [PERFORMANCE.md](PERFORMANCE.md). Not run. |
| Cross-platform matrix | Only local Linux was executed; the workflow still prepares macOS/Windows and Node 22.19.0/24. |
| Footer takeover, quota data, historical usage totals | Out of scope for this phase; the default surface is still a widget and no history is scanned. |

Passing the checks above must not be described as human visual acceptance or as live-stream performance equivalence. Those two claims are still unproven.

## Phase 3: optional footer surface (2026-09-20)

This phase added the opt-in `surface: footer` slot (Pi 0.85.1 `ctx.ui.setFooter`), its ownership
lifecycle, cached identity data (display cwd, provider, session title, host Git branch), split
usage counters with a cache-hit rate, and a separate bounded extension-status area. The default
surface is still `widget`; no history is scanned and the counters keep their observed scope. The
environment is the same as the phase-1/2 records: Linux x64, Node **v24.19.0**, npm 11.17.0,
AMD Ryzen 7 9700X, Pi `@earendil-works/pi-coding-agent@0.85.1` under ignored `.tmp/sdk`.

| Check | Result |
| --- | --- |
| `npm test` | **197 tests passed**, zero failed/skipped (48 more than the 149 in the phase-2 record). New coverage: surface configuration defaults/validation and `/hud surface`; footer-only mounting; live widget↔footer switching; `placement` never touching the footer; host-without-`setFooter` fallback with a recorded reason; off/on, shutdown and session replacement releasing views, subscriptions and timers; both ownership orders for two footer extensions (a later footer is never cleared by `off`/dispose/refresh, and only an explicit surface command re-claims); host-driven disposal isolating old branch callbacks; identity updates for title/provider/thinking/model; branch reads only at install and on `onBranchChange` (never in render); non-TUI modes performing zero terminal UI operations; footer body rows fixed at 2/3/4 for 0–180 columns × three presets × two languages × ASCII; the bounded status area (sanitize, 8-entry sample, 64-char text, 2 rows, `+N` fold, total ≤ 6 rows); in-place status `Map` add/change/delete detection with no HUD event; a 50,000-entry status map sampled rather than iterated; a throwing status provider still rendering the body; cached-array reuse with 12 statuses; the split usage/cache-hit lifecycle (zero denominator, missing cache data, explicit zeros, aborted/error, model switch, compaction, reset); and narrow footer alert retention at 40/80/120/180 columns for every preset. |
| `npm run check` | Passed. The forbidden-API group now allows `setFooter` **only** inside the marked boundary section of `src/footer.ts`, and asserts that both the capability guard and the install/release helpers stay inside it; every other source file keeps the full list. Schema/example/preview checks were updated for `surface` and the new footer previews. |
| `npm run verify` | Passed end to end with the new footer scenarios and one added gate (`cachedFooterRenderMeanUs ≤ 5 µs`); every existing gate is unchanged. |
| `npm run package:check` | Passed: `pi-hud-0.1.0.tgz`, 37 files, 129,803 bytes, empty-cache offline production install and packed entry import. |
| Same-machine A/B | 8 interleaved pairs against `af3a5e4`, re-run against the committed phase-3 tree (`d64cbb3`, clean working tree at measurement start) with the identical probe file and shared fixtures. The widget path with observed usage is +0.65 ± 0.33 µs mean slower (7.76 → 8.41 µs, 8/8 pairs) because the usage row now renders four separate counters plus `CH`; the cached path is unchanged to marginally cheaper, hooks are within noise (+0.047 ± 0.67 µs paired tool-pair p99), and all gates pass unchanged. Footer scenarios are new and have no pre-change baseline: full 14.32 µs mean / 99.2 µs p99 uncached, balanced 12.36 µs, 40-column 9.64 µs, and 0.104 µs per cached frame with 12 statuses against the new 5 µs gate. Full data: [performance-phase3-ab.json](performance-phase3-ab.json). |
| `node scripts/sdk-check.mjs` | Passed against the real pinned package. Extended to type-check the footer contract: the HUD's `FooterDataLike` must accept Pi's real `ReadonlyFooterDataProvider`, `ctx.ui.setFooter(factory)`/`setFooter(undefined)` must type-check against `Component & { dispose? }`, `ctx.sessionManager.getSessionName()` must exist, and `pi.on("session_info_changed")` must expose `name`. |
| `node scripts/pi-rpc-smoke.mjs` | Passed: real Pi loads `index.ts`, registers `/hud`, strict JSON framing, and no HUD UI output in RPC mode (so no `setWidget`/`setFooter` call leaks into a headless session). |
| `python3 scripts/pi-pty-smoke.py` | Passed in a disposable PTY. It now also loads `examples/status-demo.ts`, switches to the footer surface, asserts that no native-footer-only marker (`(auto)`, one-decimal `%/`) is rendered — including after a forced full repaint — verifies that an independent extension's `setStatus` reaches the footer without any HUD event, switches back and confirms the built-in footer returns, then exercises `/hud off` in footer mode and confirms the native footer is restored. No model request or credentials. |

### Pending, not executed

| Item | Why it remains open |
| --- | --- |
| Real dark/light terminal visual acceptance of the footer | No human observer drove the footer surface in a real terminal, on either background. The layout is covered by 0–180-column renderer tests, the generated preview and one PTY run at 100–102 columns; contrast, line stability and legibility still need an observer at 40/80/120/180 columns. |
| Live model-stream / tool-dispatch / keyboard A/B | Unchanged from phase 1: requires a deterministic provider fixture and external instrumentation per [PERFORMANCE.md](PERFORMANCE.md). Not run. |
| Real-session footer data parity | The PTY smoke makes no model or tool call, so the footer's usage split, `CH`, session title and branch are verified by unit tests, the generated preview and the synthetic A/B, not by a live comparison against the built-in footer's full-session aggregation. |
| Two footer extensions in a real host | Ownership is covered by deterministic tests that mirror Pi's single-slot semantics (`setExtensionFooter` disposes the previous component first). A second real footer extension was not loaded in the PTY run. |
| Cross-platform matrix | Only local Linux was executed; the workflow still prepares macOS/Windows and Node 22.19.0/24. |

Passing the checks above must not be described as human visual acceptance, as live-stream
performance equivalence, or as a byte-for-byte replacement of the built-in footer.

## What to verify on the first real installation

Load the extension once, inspect `/hud status`, try the three presets, Chinese labels, resizing, compaction, model switching, reload and off/on. Keep Git disabled initially. A loaded extension should not cause tool prompts, network access or extra model messages; the editor and, in the default widget surface, the built-in footer should remain intact. With no completed response after attachment, `ctx(last) ?` is expected. Subagent/task rows without adapters are not expected to populate automatically.

For a first look at the optional footer surface, run `/hud surface footer` in a real terminal, compare it against the built-in footer side by side (model, provider, context, tokens, cache, cost, branch, session title, other extensions' statuses), resize to 40/80/120/180 columns, switch theme and palette, then `/hud surface widget` or `/hud off` and confirm the built-in footer returns exactly once. That side-by-side comparison is the visual acceptance that this record still lists as pending.

For a public stable release, the owner should review passing pinned-SDK/RPC/PTY checks and real-terminal A/B evidence before publishing the generated draft. Source-level compatibility review and microbenchmarks are valuable but not substitutes for that gate.

## Recent-summary removal (2026-09-20)

Removed the recent-completion display and its dedicated state from every preset. Earlier phase-2 evidence above describes the pre-removal implementation; its recent-ring coverage and timings are historical, not measurements of this revision. Category accounting, completion-ID deduplication, current activity and fixed row counts remain.

Validation for this removal: `npm run verify` passed (regression suite and performance gates); `npm run package:check` passed after rerunning outside the sandbox because its nested npm process initially failed with EPERM. Preview regenerated with the production renderer. No new live-terminal acceptance was performed.

## Phase 3 B2a: optional full-session usage ledger (2026-09-20)

Implemented the B1 contract ([SESSION-USAGE-CONTRACT.zh-CN.md](SESSION-USAGE-CONTRACT.zh-CN.md)) as an explicit
`usageScope: observed | session` (default `observed`) plus the ledger module `src/usage.ts`: one sliced,
cancelable baseline per rebuild (512 entries / ~2 ms per slice), incremental reconciliation of committed
records at `turn_end`/`agent_settled` via `getLeafId`/`getEntry` parent-chain walks to the committed cursor,
generation/session-id isolation, exactly one recovery rebuild per chain anomaly, the B1 missing-cost
semantics (`?`, `+?`, valid zero, `limited*`), `sess*` rendering with loading/updating/partial markers, and
the explicit degradation to observed-labelled data when the host lacks the read-only entry surface.
`ctx(last)`, `CH` and tool categories keep their observed scope in both modes. The default surface is still
`widget`; the default scope is still `observed`. This is B2a only — see the pending list for what B2b still
owes. Environment: Linux x64, Node **v24.18.0**, Pi `@earendil-works/pi-coding-agent@0.85.1` isolated under
ignored `.tmp/sdk` (TypeScript 5.9.3, `@types/node` 22.19.19; npm cache redirected to `/tmp` in the earlier
B1 setup, unchanged).

| Check | Result |
| --- | --- |
| `npm test` | **244 tests passed**, zero failed/skipped (46 more than the 198 pre-B2a baseline; new file `tests/usage.test.mjs`, extended by review rounds 2 and 3). Coverage of the B1 correctness matrix: an independent oracle reducer over every in-scope record kind (assistant, toolResult with/without usage, compaction/branch_summary with/without usage, user/custom/thinking entries, error/aborted); assistant-without-usage incompleteness vs usage-less toolResult out-of-scope; invalid numeric fields marking that field unknown while valid siblings still count; explicit zero cost; MAX_SAFE_INTEGER saturation; sliced baseline (exactly one `getEntries` per rebuild, loading visible mid-slice); catch-up of appends during slicing without double counting (and a failed catch-up keeping valid totals, recording the gap and recovering via one rebuild); empty-history null cursor; a `resetLeaf()`-style null leaf after tree navigation accepted as a legal anchor with root-level appends counted once; an over-cap append burst during slicing recovered by a catch-up rebuild; session replacement mid-slice (stale generation never publishes); deactivate/restart; turn_end reconciliation with a post-`message_end` replaced entry (event usage never enters the ledger); duplicate turn_end/agent_settled; broken-chain drop + one recovery rebuild + no idle loop; over-cap delta recovery; stranded-cursor tree walk; repeated same-summary compaction rebuilt from the manager; malformed parentId and getEntries failure/non-array degradation; the updating marker repainting on a toolResult message_end with no observed change; the deferred startup config read activating (and a failed read not activating) the session scope; controller integration (default observed never creates ledger work, `sess*` rendering, unavailable-host degradation with observed labels, scope/off/on transitions, surface+palette never resetting the account, `/hud reset` keeping and re-verifying the ledger, tree/compact rebuilds, footer session fields, RPC creating no ledger and reading no history, zero history reads during 100 renders, no idle timers); display tests for labels/markers/cost states/narrow truncation/footer row/zh-CN/ASCII; `/hud scope` command and diagnostics round-trip. |
| Coverage | Line coverage: `render.ts` 100%, `state.ts` 100%, `usage.ts` 100%, `footer.ts` 98.78%, `extension.ts` 99.42%. |
| `npm run check` | Passed. The history-boundary whitelist is precise: `getEntries`/`getEntry`/`getLeafId`/`getSessionId` may be called only inside the marked section of `src/usage.ts`; `getBranch`/`getContextUsage` remain forbidden everywhere including inside the boundary; every other source file keeps the full forbidden list. Review-driven fix: all forbidden-API matchers (including the pre-existing ones) now also catch optional-chained calls (`x.getEntries?.()`); method-form names require a receiver dot so interface members like `setFooter?(...)` do not false-positive. Verified with four negative controls (optional-chained `getEntries` in `state.ts`, plain `getLeafId` in `extension.ts`, `getContextUsage` inside the boundary, optional-chained `setFooter` in `render.ts`) — each fails the check exactly as intended, and the clean tree passes. Schema/example/preview checks updated for `usageScope` and the new session previews. |
| `npm run verify` | Passed end to end; every performance gate is unchanged (hook p99 ≤ 250 µs, uncached render p99 ≤ 5 ms, cached means ≤ 5 µs). |
| `npm run package:check` | Passed: `pi-hud-0.1.0.tgz`, 40 files (the count moves by a few bytes when this record itself is edited), empty-cache offline production install and packed entry import. |
| `node scripts/sdk-check.mjs` | Passed against the real pinned package. Extended to type-check the ledger contract: `SessionManagerLike` accepts `ExtensionContext["sessionManager"]` (`ReadonlySessionManager`), `SessionEntryLike` accepts real `SessionEntry` values, the `Usage` token/cost surface (extracted from the pinned `compaction` entry type, since `Usage` is not re-exported from the package root), `pi.on("turn_end")`, and the full public ledger lifecycle. |
| `node scripts/usage-oracle-check.mjs` | **New, executed.** Transcribes the B1 probe into a reproducible pinned-SDK check: the ledger is run against real `SessionManager.inMemory` histories and compared with the SDK's own `createUsageTotals`/`addUsageToTotals` under the native footer scoping. Covers the six-record probe history (including the repeated `same-summary` compaction), full-history vs branch-only totals after `branchWithSummary`, incremental catch-up with `getEntries` staying at one call, session replacement with no leakage, compaction rebuild preserving pre-compaction totals, and a manager-level `branch()` tree switch recovering through the stranded-walk path. No network, model, credentials or file persistence. |
| `node scripts/pi-rpc-smoke.mjs` | Not re-run this round (no host-boundary change: the ledger only adds in-process reads of the read-only entry surface in TUI mode). The pinned contract is covered by `sdk-check` above. |
| Generated preview | `docs/preview.txt` regenerated from the renderer: session ready/updating/partial/loading, unknown-cost, `limited*`, 30/38-column marker-surviving truncation, ASCII, zh-CN and footer usage-row sections. |
| Implementation review | A dedicated review pass over this round's diff found and fixed four issues before delivery (external review rounds 2 and 3 later found five more; see the review-round sections below): `deactivate()` never cleared the active flag; the diagnostic `status` field was not synced when a baseline published; a toolResult `message_end` did not repaint for the `↻` updating marker (the observed counters were unchanged); and the forbidden-API matchers — including the pre-existing ones — missed optional-chained calls (`x.getEntries?.()`), now hardened with receiver-dot anchoring for method-form names and verified by the four negative controls above. |

### Review round 2 (2026-09-20): three externally reported fixes

A review of commit `6f7c1c3` against `94676b3` reported three issues; each was reproduced
against the real pinned SDK before fixing, covered by new tests and new oracle scenarios.

| # | Issue (reported) | Fix and evidence |
| --- | --- | --- |
| P1 | After tree navigation back to the root, the ledger stopped accumulating (`leaf == null` with history was unconditionally treated as an anomaly; `cursorValid` blocked all later commits, keeping the totals frozen and `updating` forever). | `resetLeaf()` is Pi's documented re-edit-the-first-message state: history kept, leaf null, next append a new root entry (`parentId` null). The ledger now accepts the null cursor as a legal anchor — a verify walk from a later root-level leaf commits only entries appended after the reset, never the already-counted history — and the `cursorValid` machinery was removed. Real-SDK repro went from `{input:1, updating:true}` to `{input:3, status:"ready", updating:false}`; the same scenario is now `usage-oracle-check.mjs` case 4 and a unit test. |
| P2 | A failed baseline catch-up did not schedule a recovery rebuild (an over-cap append burst during slicing left the totals frozen: 2 entries + 2049 appended stayed at 2, zero recoveries). | `finishBaseline` now schedules exactly one recovery rebuild on a catch-up failure (a fresh `getEntries()` covers the gap without a walk); a recovery whose own catch-up fails again does not self-perpetuate — the gap stays recorded and the next event boundary retries through the verify path; a recovered full read also clears `failureReason`. Real-SDK repro went from `{input:2, recoveries:0}` to `{input:2051, recoveries:1, reason:null}`; unit tests cover the burst and the un-indexed-entry catch-up gap; `usage-oracle-check.mjs` case 5 covers the burst. |
| P2 | The session cost field showed only `est* $…` — no session scope, updating, coverage or saturation marks — while the balanced widget renders no token field and narrow footers drop it, so an incomplete/updating ledger looked like a complete current value. | The session cost field is now self-describing: it carries the `sess*`/`全会话*` scope label, `↻`/ASCII `~` when updating, `+?` for incompleteness the value does not already show (cost-missing stays `+?` on the value so exactly one hint appears per distinct problem), `limited*` for saturation and `?` while loading, with the marks adjacent to the label so truncation removes the number first. Covered by new rendering tests (balanced preset without a token field, footer narrow row) and regenerated preview sections. |

All previous gates re-run green after the fixes: `npm run verify` (241 tests), `npm run package:check`, `sdk-check.mjs`, `usage-oracle-check.mjs` (now five scenario groups). The B2b pending list below is unchanged.

### Review round 3 (2026-09-20): two more externally reported fixes

A second review pass against `8993100` (241 tests and the real-SDK oracle green at that
point) reported two issues with minimal reproductions (`.tmp/review/b2a-round2.mjs`); each
was reproduced and independently confirmed before fixing.

| # | Issue (reported) | Fix and evidence |
| --- | --- | --- |
| P2 | After a **second** catch-up failure (where the anti-self-perpetuation guard correctly stops rescheduling), the next successful incremental verification committed the missing records but never cleared `coverageGap`/`failureReason`; `commitIdle` kept the snapshot `partial` forever even though the input totals were correct (repro: input 4 correct, `status:"partial"`, `coverageGap:true`, stale `catchup:missing-entry` reason). | A successful **anchored** walk covers exactly the segment the failed catch-up/verify could not reach, so `runVerify` now clears the coverage failure (`coverageGap=false`, `failureReason=null`) only on that confirmed commit — genuine field incompleteness and saturation are re-evaluated in `commitIdle` and keep their `partial` mark (asserted: a usage-less summary appended after healing stays `partial` with no failure reason and no coverage gap). `commitIdle(healed)` also publishes the healed snapshot even when nothing was pending. No timer is involved: the healing attempt is the event-driven verify itself, and the tests assert `clock.pending === 0` throughout. New regression test drives the exact second-failure-then-heal sequence (two temporarily un-indexable entries, index restored, verify heals, publish count asserted). |
| P2 | `limited*` was appended after all counters and `CH`, so a saturated 40-column row clipped the marker while still showing the truncated value (`sess* ↑9007199254.7m ↓9007199254.7m R90…` with no imprecision hint), notably with `full` + `showCost:false`. | `limited*` moved into the compact mark group directly behind the `sess*`/`全会话*` label in both the token and the standalone cost field, so whenever any saturated number is displayed its hint is displayed before it. New unconditional narrow assertions (no "if the marker exists" skip paths): full widget 30/40/52 columns with `showCost:false` (marker before the clipped counters, row genuinely clipped), zh-CN and ASCII at 40, footer usage row at 56 and the balanced widget's standalone cost field at 46 (`sess* limited* $…`). The two older narrow tests with conditional assertions were rewritten to unconditional matches against the verified layout. Preview sections regenerated with a saturated+updating+incomplete 30/38-column demonstration. |

Gates after this round: `npm run verify` (244 tests), `npm run package:check`, `sdk-check.mjs`, `usage-oracle-check.mjs` all green and unchanged. The B2b pending list below is unchanged.

### Pending for B2b, not executed in B2a

| Item | Why it remains open |
| --- | --- |
| 1k/10k/100k long-history measurements | The B1 measurement plan (linear and branched fixtures, `getEntries` copy vs aggregation CPU vs max slice vs heap/RSS before/after release, rebuild and session-switch cost, event-loop-latency probe for the longest uninterruptible pause) has **not** been executed. The 512-entry / ~2 ms / 2048-walk parameters are the contract's candidates, not measured results. |
| Steady-state cost by added-record count | Adding 1/32/2048 records between turns was not measured. The tests assert `getEntries` stays at zero calls in steady state, not a timing budget. |
| Same-machine interleaved A/B (≥8 pairs) | Not run for the session scope; the phase-3 A/B covers the observed path only. |
| Real-host acceptance | No live Pi session ran with `usageScope: "session"` (resume with real long history, real compaction, real tree navigation, two footer extensions, model switching). The pinned-SDK oracle above is in-process, not a live host. |
| Real streaming/tool/keyboard acceptance | Unchanged from phase 3; at least 20 alternating pairs per [PERFORMANCE.md](PERFORMANCE.md) are still required. |
| Default-footer evaluation | Explicitly out of scope: `widget` + `observed` remain the defaults; no switch was made and none is implied by these tests. |

Passing the checks above must not be described as phase-3-B acceptance as a whole, as a performance
result for long histories, or as live-host validation of the session ledger.

## Phase 3 B2b: long-history measurements and real-host acceptance (2026-09-20)

Executed the B1 measurement plan and the live-host acceptance protocol, then rebuilt the affected
evidence in a review round (below). Environment: Linux x64,
Node **v24.18.0**, 11th Gen Intel i7-11800H, Pi `@earendil-works/pi-coding-agent@0.85.1` isolated
under ignored `.tmp/sdk` (unchanged from B2a). Every regenerated record carries its actual
measurement identity in a `provenance`/`environment` field: the commit, the SHA-256 of each
modified or untracked file at measurement time, and the SDK lock hash. All numbers live in
[PERFORMANCE.md](PERFORMANCE.md); this section records what was executed, fixed and what remains open.

| Check | Result |
| --- | --- |
| `npm test` | **244 tests passed**, zero failed/skipped (the B2a suite plus extended diagnostics assertions for the new published-totals field). |
| `npm run verify` | Passed end to end; every gate unchanged (hook p99 ≤ 250 µs, uncached render p99 ≤ 5 ms, cached means ≤ 5 µs). |
| `npm run package:check` | Passed: `pi-hud-0.1.0.tgz`, 44 files, empty-cache offline production install and packed entry import. |
| `node scripts/sdk-check.mjs` | Passed against the pinned package (no SDK surface change this round; re-run anyway). |
| `node scripts/usage-oracle-check.mjs` | Passed (real `SessionManager` oracle, unchanged scenarios, re-run after the `TOKEN_FIELDS` fix). |
| `node scripts/pi-rpc-smoke.mjs` | Passed (re-run: loader registration, strict JSON framing, no HUD UI output in RPC). |
| `python3 scripts/pi-pty-smoke.py` | Passed (re-run: widget/footer mounting, ownership, native-footer restore, resize, no model call). |
| Long-history benchmark | **New, executed.** `node scripts/usage-ledger-bench-run.mjs --json=docs/performance-b2b-ledger.json`: 1k/10k/100k × linear/branched against the real pinned `SessionManager`, one child per cell (`--expose-gc`), fixture/host-load/attach timed separately, external `setImmediate` pause probe with an idle noise floor, settling GCs plus a zero-work control window for heap attribution, and oracle equality asserted before any timing is recorded. Headline: attach 2.2/3.3 ms (1k) → 20.8/23.9 ms (10k) → 199/234 ms (100k); max slice 0.25–0.67 ms against the unchanged 2 ms budget; max pause at 100k 3.3–6.9 ms, dominated by the SDK's own 2.1–2.4 ms O(N) `getEntries()` copy; retained-after-release ≤ 2.1 MiB. |
| Steady-state increments | **New, executed.** +1/+32/+2048 per size: `getEntries` delta exactly 0 (asserted), ledger-internal increment 0.065–0.46 ms, cost tracks added records not history size. Over-cap (2049): walk dropped, exactly one recovery rebuild (12.1–12.3 ms at 1k; 208–245 ms at 100k), `failureReason` healed. The recovery-fails-again path is measured in every cell: 6,240 records straddling a baseline and its own recovery produce visible failures/coverage gaps, the anti-loop guard holds at one recovery rebuild, and the next event boundary's anchored verify heals every missing segment (oracle-verified). Mid-slice catch-up exercised at every size; fast switch during the 100k baseline cancels in 16–30 µs with the stale generation never publishing. |
| Usage-scope A/B | **Executed, rebuilt in the review round.** `node scripts/usage-ab-run.mjs --pairs=8 --json=docs/performance-b2b-usage-ab.json`: interleaved observed/session pairs, order alternated, per-file provenance. The review found the full-turn scenario never fired the coalescer's 250 ms publication (a 100-turn repro drained 0 flushes); it now drains the deadline and **fails unless exactly one publication fired per turn** (5,000/5,000 asserted). Session marginal cost: +1.03 µs ledger reconciliation, +1.94 µs full turn incl. publication, +1.02 µs per `sess*` render; hooks/cached unchanged. Structural evidence (21,000 published entries, one `getEntries`, 5,001 flushes/paints, 0 errors) is collected while the ledger is live. |
| Real-host acceptance | **Executed, fast-switch rebuilt in the review round.** `python3 scripts/pi-host-acceptance.py --json=docs/host-acceptance-b2b.json`: **9/9 scenarios passed** in the real TUI with the deterministic in-process fixture provider (zero network/credentials/billing), isolated HOME/workspace, per-file provenance. Covers: 10k-entry branched resume (ledger == independent file oracle, exact integers), a live read-tool turn (getEntries stays at 1), two live `/compact`s with identical summary text over an all-same-summary resumed history (the SDK `find(summary)` hazard live; both counted exactly once), `/tree` branch navigation + back-to-root leaf reset + re-append, model switch fixture-alpha→fixture-beta with totals accumulating, dual-footer coexistence in **both** `-e` orders (startup ownership, post-startup takeover, suppression without clearing, `/hud surface footer` re-claim), and a **post-HUD async `message_end` replacer** that doubles usage — the ledger counts the final committed record, matching the file oracle. The fast-switch scenario was rebuilt after the review showed the old 10k variant always switched after the baseline had finished (~44 ms) — it now uses a 100k session, switches the moment the footer's **loading marker** renders (byte evidence of an in-flight baseline, ~0.3 s window), confirms the switch took effect ("New session started"), and fails unless the race was exercised; it also watches every post-switch frame and asserts no stale-generation totals ever render. |
| Live streaming/tool/keyboard A/B | **Executed, rebuilt in the review round.** `python3 scripts/pi-stream-ab.py --pairs=20 --json=docs/pi-stream-ab-b2b.json`: **20 pairs × 2 profiles = 80 real-TUI trials** (default `observed`+`widget` and opt-in `session`+`footer`, reported separately), zero measurement failures. The review found the old probe's first-token marker needed 12 deltas, keyboard timeouts were silently dropped and completions could be invented from the last frame; the rebuilt protocol uses an atomic first-content prefix (`«word-START»`, one delta), an atomic completion terminator (`«END»`, fails if missing), exactly 42/152 deltas per reply, failure counting with a 25% cap, char-verified typing DURING a 152-delta stream (8 keys + 2 backspaces + 2 cursor keys per trial), isolated tool-row visibility, preserved raw per-key latencies and frame timestamps, and true paired deltas with a same-side noise envelope; `--self-test` verifies the failure paths deterministically. Result: every timing metric within the measured noise envelope on both profiles; see the round-2 section for the raw-byte terminal costs that replaced the earlier plain-text byte accounting. |

### Issues found and fixed this round

| # | Finding | Fix and evidence |
| --- | --- | --- |
| P1 | `accumulateUsage` allocated a fresh 4-tuple array per usage record: ~24 MiB of garbage per 100k-entry rebuild, inflating GC pauses during the baseline (found by the first 100k measurement run). | The invariant table is now the module-level `TOKEN_FIELDS` constant; `addTotals` unrolled. Verified allocation-free (1M `aggregateEntry` calls retain 0.03 MiB); the 100k attach heap peak delta dropped from ledger-attributable garbage to parity with the zero-work control. 244 tests and the pinned-SDK oracle re-run green. |
| P3 | `/hud status` diagnostics exposed counters but not the published totals, so a real-host verification could not compare the ledger with an independent oracle without parsing the abbreviated footer display. | `inspect().totals` now publishes the bounded scalars (input/output/cacheRead/cacheWrite/cost/costKnown/costMissing, `null` when inactive). Covered by the extended round-trip test; used by every host-acceptance scenario. |
| — (methodology) | A single immediate GC after the manager-load phase attributes ~40–56 MiB of un-swept load-phase garbage to the attach phase; V8 old-space re-growth after compaction further inflates "peak heap" readings. | The benchmark settles with two spaced GCs and measures a zero-work control window under identical probe load; both numbers are reported and the retained-after-release figure is the attribution anchor. |
| — (fixture) | Pi 0.85.1's native footer crashes (`addUsageToTotals` on undefined) when resuming a session containing assistant messages without `usage`; real provider sessions always carry usage, so this is an upstream robustness gap, not an HUD bug. | The session-file builder injects deterministic usage into those records (`--sameSummary` fixtures likewise); the HUD's own missing-usage semantics stay covered by unit tests and the pinned-SDK oracle, which never run the native footer. |

### Review round (post-B2b): four P2 evidence defects found and fixed

An external review of `6f466c7` (`.tmp/review/b2b-review.md`) reported four P2 findings; each
was reproduced independently before fixing, and only the affected evidence was rerun.

| # | Finding (reported) | Fix and evidence |
| --- | --- | --- |
| R1 | The usage-scope A/B's full-turn sample used `clock.advance(0)`, so the coalescer's 250 ms publication never fired — 100 full turns produced 0 flushes with one pending job at t=250 — and the structural diagnostics were collected after `session_shutdown` disposed the ledger. | The probe now drains the publication deadline (`advance(250)`) and hard-fails unless exactly one publication fired per turn (5,000/5,000 asserted per run); structural evidence (published entries, host call counts, flush/paint counts, pending jobs) is collected while the controller and ledger are live. The split scenarios report ledger-verify-only vs full-turn-including-publication separately. 8 pairs rerun; the full record and the PERFORMANCE table were regenerated. |
| R2 | The fast-switch host scenario sent `/new` ~200 ms after startup with a 10k fixture whose baseline completes in ~44 ms — a read-only status probe showed `updating=false`, all 11,649 records examined — so an ordinary settled switch was labelled as cancellation. | Rebuilt on a 100k session (~0.3 s in-flight window measured): the harness waits for the footer's **loading marker** (`sess* ?`, rendered only while the baseline is in flight), sends `/new` in the same burst, requires the pre-switch buffer to contain no published totals (else it fails: race not exercised), confirms the switch took effect ("New session started" — a back-to-back Escape+/new burst was found to no-op and is now avoided), and watches every post-switch frame for any stale-generation totals. Recorded evidence: loading marker at 0.96 s, switch at 1.01 s, switch confirmed, zero stale publications, new-session totals zero. Full 9/9 scenario file rerun with per-file provenance. |
| R3 | The stream probe's first-token marker required 12 deltas to render, the advertised delta count (40) did not match the actual (≈30), keyboard timeouts were silently discarded biasing p95, an unobserved stream completion silently used the last frame, and frame gaps mixed editor repaints with token cadence. | The fixture now emits one atomic first-content prefix (`«word-START»`), exactly N body deltas (even split) and one atomic terminator (`«END»`) — 42 total for the standard stream, 152 for the long one, both reported. `analyze_stream`/`analyze_keyboard` are pure functions that **raise** on missing prefix/terminator or a >25% timeout ratio; intervals are computed strictly inside the first-content→completion window and labeled as render-frame intervals (terminal cadence, not provider token gaps); raw per-key latencies and frame timestamps are preserved. `python3 scripts/pi-stream-ab.py --self-test` exercises the failure paths deterministically (missing markers, timeout ratios, window exclusion, pre-write frames). 80 trials rerun with zero measurement failures. |
| R4 | Only 10 pairs were delivered against the required ≥20; keyboard was measured only before streaming; the tool metric was the full turn, not isolated dispatch; no paired p95/noise analysis; only the session+footer profile ran although observed+widget is the default profile. | The protocol now runs 20 pairs × 2 profiles (default `observed`+`widget` and opt-in `session`+`footer`, evidence separated), types 8 char-verified keys plus 2 backspaces and 2 cursor-left keys DURING a 152-delta stream, detects the transcript's tool row separately from the follow-up reply, and computes true per-pair deltas with a same-side adjacent-pair repeatability envelope for every metric. Uncovered scenarios (resize during streaming, live compaction mid-A/B, abort/retry, concurrent extension widget) are listed as pending rather than claimed. |

Bookkeeping corrected alongside: every regenerated record now embeds the commit, SHA-256 of all
dirty/untracked measurement inputs and the SDK lock hash (the earlier claim of uniform provenance
was not true of the committed records); the ledger record was rerun once on the final tree so its
provenance matches; historical numbers in PERFORMANCE.md were replaced by the corresponding final
records, not edited in place as if remeasured.

### Review round 2 (post-B2b): three more P2 measurement-correctness defects fixed

A second external review of `2b9fe93` reported three P2 findings; each was reproduced with
the review's synthetic cases before fixing, the negative paths are now covered by
`pi-stream-ab.py --self-test`, and only the affected measurement was rerun.

| # | Finding (reported) | Fix and evidence |
| --- | --- | --- |
| R1 | Byte accounting stripped ANSI before counting: a synthetic payload of 100 color escapes + one character + 100 resets (901 raw bytes) contributed 1 byte, so the "185–235 B per turn" claim measured plain-text size, not terminal traffic; the publication window was also capped at an arbitrary `post[:3]` read chunk. | Frames now carry `(timestamp, raw byte count, plain text)`; every byte metric (`rawBytesInWindow`, `publicationWindowRawBytes`, tool `rawBytes`) sums raw bytes, and the publication window counts every frame in the defined interval. The 901-raw-byte synthetic is a self-test assertion. Rerun (80 trials): the true deterministic costs are **+914 B (default/widget) and +945 B (opt-in/footer) of raw terminal bytes per tool turn**, **+2692 B (widget) / +956 B (footer) per streamed reply**, and a 318/456 B coalesced publication ~150 ms after completion — materially larger than the withdrawn plain-text claim. |
| R2 | The during-stream echo predicate searched for the typed character anywhere in the last 400 characters of accumulated transcript — a fake trial emitting only unrelated transcript text passed all 8 keys with 0 failures, and nothing established that the keys were typed before the reply completed. | Echo keys now use a distinct marker alphabet (Greek letters verified absent from the ASCII reply bodies and the TUI chrome), each key is matched only in post-write frames, the accumulated marker sequence must render contiguously (editor-state evidence), and every key — echo and control — must be written while the terminator is still absent (recorded per key; any violation fails the trial). `streamedSeconds` is now computed from the frame scan. Negative coverage in `--self-test`: a marker present only in pre-write/unrelated output does not satisfy the echo evidence. |
| R3 | A tool turn whose follow-up reply (`FIXTURE:DONE`) arrived without the tool row returned success with `toolVisibleMs=None`; aggregation then silently filtered nonnumeric values; and `analyze_keyboard([1,2,None,1.5])` reported p95=2 despite a 2-second censoring ceiling. | `analyze_tool` is a pure function that **raises** when DONE is present without the tool row (the DONE-only synthetic is a self-test assertion); `tool_turn` gives the row a bounded 0.5 s grace and then fails; a `require_mandatory` pass verifies every mandatory metric yields a number in every trial before aggregation; and required keyboard measurements fail on ANY timeout, while optional ones report explicit censored statistics (responded-only percentiles, censoring ceiling, upper bounds) instead of an unlabelled all-key p95. |

While fixing R2 a further self-inflicted defect was found and removed: the long-stream
completion timestamp used the trailing `frames[-1]` after a wait instead of the frame
containing the terminator, and a 2 s settle between the echo and control keys pushed the
control keys past the end of the stream — together these had produced a phantom +242 ms
"session+footer stream delay" (20/20 pairs) that vanished once timings came from the frame
scan (both profiles now measure the provider's exact 1.53 s script duration). The rerun
carries per-file provenance (commit, SHA-256, SDK lock hash).

### Still pending (evidence gaps with concrete blockers)

| Item | Blocker |
| --- | --- |
| Human dark/light terminal visual acceptance | Requires a human observer driving the footer/widget in a real terminal on both background colors at 40/80/120/180 columns. A PTY harness can capture bytes but cannot make a perceptual judgment; per the phase contract this must not be claimed from PTY output alone. **Partially executed** (2026-09-20): the observer ran a condensed checklist and verbally confirmed “no problems”; the report was transcribed verbatim with provenance into `docs/VISUAL-ACCEPTANCE-RESULTS.zh-CN.md` and then tightened (speculative ✅ demoted). Core checkpoints pass; the width sweep, light real session, per-field B6 comparison and several states remain ➖ not covered — a partial pass, not a complete visual acceptance. |
| Cross-platform matrix | **Executed and green** (2026-09-20): Actions run 35541018928 passed all 8 jobs (ubuntu/macos/windows × Node 22.19.0/24, plus the performance budget and the pinned Pi 0.85.1 contract/RPC loader). The first post-push run failed the two Windows jobs: the runner's default autocrlf converted `docs/preview.txt` to CRLF against the byte-exact LF assertion. Fixed by enforcing LF checkout via `.gitattributes` (`* text=auto eol=lf`, matching the existing `.editorconfig` policy; no renormalization was needed). |
| Live-provider streaming A/B | Deliberately not run: no paid provider may be used for acceptance calls. The deterministic in-process provider covers the TUI pipeline; provider-network variance is out of scope for this repository's acceptance. |
| Default-footer evaluation | **Evaluation completed as a separate record** ([DEFAULT-FOOTER-DECISION.zh-CN.md](DEFAULT-FOOTER-DECISION.zh-CN.md)): conclusion “do not switch now; re-evaluate after the human visual acceptance, an explicit field-gap decision (auto/sub/xp/live-context), the cross-platform matrix, the remaining live scenarios and owner approval”. `widget` + `observed` remain the defaults; no default, config, schema or code default was changed by that record. |
| Remaining live-TUI protocol scenarios | **Executed and green** (2026-09-20): `scripts/pi-live-scenarios.py` runs resize-mid-stream (120→47→92, four SIGWINCH) during a measured ~5.5s stream on BOTH surfaces, compact-mid-measure, abort-retry and concurrent-widget in the real Pi 0.85.1 TUI; every ledger state equals the independent file oracle (`docs/live-protocol-scenarios.json`, 5/5 scenarios). See the live-protocol section below for the harness findings this round produced. |

Passing everything above is still not a human visual acceptance, a cross-machine guarantee, or
an instruction to switch the default surface; those remain the listed gaps.

## Visual acceptance preparation and default-footer evaluation (2026-09-20)

Stage after the B2b review rounds: prepare the human-executable real-terminal visual acceptance
materials and produce the independent default-footer decision record. **No production source file,
default, schema or user configuration was changed** (`src/` untouched; `scripts/preview.mjs` gained
exports only). The deliverables are `scripts/visual-demo.mjs`, `docs/VISUAL-ACCEPTANCE.zh-CN.md`
and `docs/DEFAULT-FOOTER-DECISION.zh-CN.md`, plus the handoff/plan updates. Environment: Linux x64,
Node v24.18.0, same pinned Pi 0.85.1 SDK under ignored `.tmp/sdk`.

| Check | Result |
| --- | --- |
| `scripts/preview.mjs` refactor | `fixtureState`/`sessionView`/`FOOTER_IDENTITY` exported so the colored demo shares one fixture source; `renderPreview()` output is byte-identical (diff against the committed `docs/preview.txt` empty before and after the change; `npm run check` re-asserts it). |
| `node scripts/visual-demo.mjs` | Executed in these modes, all completing with the built-in technical self-check (every rendered row within its requested width): `--background dark` and `--light`, `--width 40/80/120/180` (default and narrowed), `--surface widget`/`footer`, `--language zh-CN`, `--preset` variants, `--ascii` (ASCII marks verified in output), `--mode 256color` (`38;5;…` escapes verified) and `--plain` (zero ANSI escapes verified). The dark/light variants are forced through the real `createStyler` detection path via stub theme text colors; a mismatch between the stub and the requested variant fails the script. Coverage rendered: palette role samples, widget/footer × presets × widths, ready/working/waiting/interrupted states, 96% context warning, long Chinese model name, footer long-title folding, 20-status `+N` folding, session ready/updating/partial/loading/limited, the unavailable degradation to `obs*` labels, and 40-column marker-surviving truncation. |
| Human-observation boundary | The script is a viewing aid only: it prints an explicit “NOT an acceptance record” header and a technical-only self-check footer; no checkpoint anywhere is marked passed by this stage. `docs/VISUAL-ACCEPTANCE.zh-CN.md` carries the command list, the CP-A1..A10 / CP-B1..B9 checkpoints, the native-footer field comparison table and a result template that only the human observer fills in (`未覆盖` is a legal result; agent pre-filling is prohibited). |
| Default-footer decision record | `docs/DEFAULT-FOOTER-DECISION.zh-CN.md` lists the public-SDK field sources and the native gaps (`auto`/`sub`/`xp`, live context estimate), the observed/session scopes, ownership/compatibility, the B2b performance and raw-terminal-byte inputs, migration impact, missing evidence and an explicit conditional recommendation (“do not switch now”). No default, config, schema, `DEFAULT_CONFIG`, example or preview was modified. |
| `npm run check` | Passed: syntax/boundaries, docs links (including the two new documents), schema/example/defaults sync, and `docs/preview.txt` still matching the renderer byte-for-byte. |
| `npm test` / `npm run verify` | Passed: 244 tests, zero failed/skipped; every performance gate unchanged. |
| `npm run package:check` | Passed: packed, production offline install and packed entry import; the two new `docs/` files ship with the package. |

### Pending for this stage

| Item | Blocker |
| --- | --- |
| Execution of the visual acceptance runbook | **Condensed execution recorded** (`docs/VISUAL-ACCEPTANCE-RESULTS.zh-CN.md`): core checkpoints verbally confirmed by the observer and transcribed with provenance, then tightened on the observer's instruction (light limited to A1/A2, B6 and waiting demoted to ➖). The full runbook (width sweep, light real session, per-field comparison) remains unexecuted, so the visual acceptance is **partially passed**; the default-footer re-evaluation condition stays unmet until the owner completes the runbook or explicitly accepts the current coverage. |
| Everything in the B2b pending table above | Updated: the cross-platform matrix is now executed and green (run 35541018928); live-provider A/B stays deliberately out of scope; the remaining live-TUI protocol scenarios are now executed and green too (see the live-protocol section). |

### Condensed visual acceptance execution (2026-09-20, later the same day)

The observer executed a condensed checklist — the synthetic colored preview on dark and light backgrounds, plus one real-session pass at the observer's daily width covering the surface switch flow, palette switching, `scope session`, a working→ready transition, an Esc interruption and the extension-status area — and verbally confirmed “都试了，没问题” (tried them all, no problems). The agent transcribed the attestation into `docs/VISUAL-ACCEPTANCE-RESULTS.zh-CN.md` with explicit provenance (transcribed verbal report, not per-item handwriting), then tightened the entries on the observer's instruction: light-background ✅ limited to A1/A2, B6 → ➖ (overall “no problems” but no per-field record), waiting → ➖ (conditional step not confirmed). Still ➖: the A7/A8 variants, the 40/120/180 width rows, the light real session, context warning, usage partial and long title. The dangling “CP-C7” reference in `VISUAL-ACCEPTANCE.zh-CN.md` was fixed to point at the CP-B1 remarks column. Status: **core items pass, partial coverage — not a complete visual acceptance and not claimed as one**. No source file, default, gate or schema was changed in this round.

### Owner decisions on the default-footer re-evaluation conditions (2026-09-20)

Recorded in the addendum of [DEFAULT-FOOTER-DECISION.zh-CN.md](DEFAULT-FOOTER-DECISION.zh-CN.md): **condition 1 closed** (the owner explicitly accepted the condensed visual-acceptance coverage; uncovered items — width sweep, light real session, per-field B6 comparison, several states — are “explicitly accepted” per the condition's own wording), **condition 2 closed** (the owner accepts in writing that footer takeover shows no `auto`/`sub`/`xp` markers and context is a `ctx(last)` snapshot, not a live estimate; no fields are faked, no upstream request filed), **condition 3 closed** (the owner lifted the “do not push” constraint; after a CRLF-induced Windows failure fixed by `.gitattributes`, Actions run 35541018928 passed all 8 jobs), conditions 4 and 5 remain open. Defaults stay `surface: widget` + `usageScope: observed`; this round again changed documentation only.

## Live-protocol scenarios: resize-mid-stream, compact-mid-measure, abort-retry, concurrent-widget (2026-09-20)

Closes the remaining live-TUI protocol items (default-footer re-evaluation condition 4). `scripts/pi-live-scenarios.py` drives the real pinned Pi 0.85.1 TUI in disposable PTYs with the deterministic fixture provider and the B2b file oracle; the committed evidence is `docs/live-protocol-scenarios.json` (5/5 scenarios, offline, zero network).

| Scenario | What it proves | Result |
| --- | --- | --- |
| resize-mid-stream (widget AND footer) | 120→47→92 columns (four SIGWINCHes) during a measured ~5.5 s stream: the stream completes, HUD rows never exceed the current width (mid-stream frame at 47 cols and settled frame at 92), the activity row was `working` during the resize window, the process stays alive and the ledger equals the file oracle afterwards | PASS both surfaces |
| compact-mid-measure | `/compact` submitted while a measured stream is in flight: the observed host behavior is that the submission interrupts the running stream (no terminator) and runs the compaction; the compaction is counted exactly once, `compactions* 1` renders and the ledger stays oracle-equal | PASS |
| abort-retry | Escape aborts a measured stream mid-flight (the terminator is provably never reached); after the abort the ledger equals the file oracle (whatever the host committed for the partial), and a full retry completes and re-equals the oracle | PASS |
| concurrent-widget | an independent second extension widget (`tests/fixtures/other-widget.ts`) coexists with the HUD widget through `/hud off|on`, `surface footer|widget` and `/other-widget off`; neither extension ever disturbs the other's widget | PASS |

Harness findings this round (recorded honestly; no production change was needed):

- **The session ledger itself is correct under abort/interrupt.** An initial suspicion of a reconciliation gap was disproven by temporary env-gated tracing (removed before the evidence run): the ledger's verify commits the interrupted turn's records and never regresses. The apparent “stale totals” came from the harness: back-to-back `/hud status` calls can parse a totals frame still queued in the kernel PTY buffer (the Python-side `clear()` does not drain it). The new `LiveHost.status_totals` drains first, closes any open popup and parses the LAST totals/field match. The B2b `status_totals` is unchanged (its scenarios interleave other interactions, and its committed records are unaffected).
- **The fixture provider ignored the host abort signal.** `tests/fixtures/fixture-provider.ts` now honors `options.signal` mid-stream: an aborted stream stops without its terminator and ends with the `error`/`aborted` event a real provider emits. Before this, Escape-interrupt attempts silently ran the scripted stream to completion (`stopReason: "stop"`). Test-fixture change only; committed B2b evidence pins its own fixture hashes and is unaffected.
- **Mid-stream command submission interrupts the stream.** Submitting `/compact` while a reply streams does not queue behind the turn in 0.85.1 — it aborts the in-flight stream and then runs the compaction. The scenario records both the observed behavior and the fallback path if a future host changes it.

Gates after this round: `npm run verify` (244 tests, all performance gates unchanged), `npm run package:check`, `sdk-check.mjs`, `usage-oracle-check.mjs` all green; `src/` is untouched by this round (the tracked changes are the new scenario script, the two test fixtures and documentation).

## Owner-approved default switch: `surface: footer` (2026-09-20)

The owner approved condition 5, and the decision record's two-step recommendation executed step one: `DEFAULT_CONFIG.surface` is now `"footer"`; `usageScope` stays `"observed"` (the default still reads no session history). Step two — a `session` usage-scope default — is deliberately excluded and will be re-evaluated after a usage cycle.

| Check | Result |
| --- | --- |
| `src/config.ts` default | `surface: "footer"`; schema default, example config and runtime defaults stay in sync (`npm run check` asserts it). |
| Tests | 245 pass / 0 fail. The default-surface tests now pin the footer default (deferred startup install, no widget mounted); widget-behavior tests pin `surface: "widget"` explicitly via a `widgetFixture` helper instead of relying on the default. |
| PTY smoke (restructured) | Startup now expects the footer surface: the default pastel `ctx(last)` renders in the footer, a fresh repaint window contains no native-footer text, `/hud surface widget` restores the built-in footer beside the HUD widget, `/hud surface footer` re-takes the slot, resize and extension-status checks pass. PASS. |
| RPC smoke | PASS (`/hud` registration, JSON RPC, no HUD UI output). |
| Live-protocol spot-check | concurrent-widget scenario re-run green on the new default startup path (the suite pins surfaces explicitly). |
| Docs | Both READMEs, CONFIGURATION and ARCHITECTURE describe the footer default and the `surface: "widget"` escape hatch; the decision record addendum and HANDOFF record the approval. `docs/preview.txt` is unaffected (the preview pins explicit surfaces per section). |

No gate was relaxed; the performance gates are unchanged.

## Provider quota phase A: shared base + GLM first slice (2026-09-21)

Design: [PROVIDER-LIMITS-PLAN.zh-CN.md](PROVIDER-LIMITS-PLAN.zh-CN.md) (§9 config contract, §10 parse/cache contract), GLM contract: [GLM-PLAN-SCOPES.zh-CN.md](GLM-PLAN-SCOPES.zh-CN.md) §9. **Default off; no gate was relaxed.**

| Check | Status and scope |
| --- | --- |
| Regression suite | **306 tests pass / 0 fail** (46 new quota tests: §9 synthetic fixtures incl. the 876/877 remaining trap, percentage/window/units mapping, business/empty/protocol failures, 401/403/429 with Retry-After, timeout, redirects, oversized/streamed bodies, late-result discard, concurrency cap + queue, cancellation and lifecycle residue, LRU/32-bucket truncation, manual cooldown, config validation incl. keep-previous-on-reject, HUD rendering in both languages with fixed row counts and narrow-drop priorities). All network/clock/auth surfaces are injected; no test touches a live account. |
| `npm run verify` | PASS: recursive `src/**` boundary scan (fetch confined to the marked `src/quota/transport.ts` boundary; surface/history/stream limits unchanged), schema/example/defaults in sync, preview unchanged, 306 tests, performance gates unchanged (`hookP99≤250µs`, uncached render p99 ≤5ms, cached means ≤5µs). |
| `npm run package:check` | PASS: 54 files packed, offline production install, packed entry import. Zero npm runtime dependencies kept. |
| Pinned SDK contract (`sdk-check`) | PASS against Pi 0.85.1, now including the quota surface: `ctx.modelRegistry.getApiKeyAndHeaders` results flow into the quota host-auth shape, and the `QuotaService` public surface type-checks against the real SDK context types. |
| RPC smoke | PASS unchanged. |
| PTY smoke | PASS unchanged (default footer path). |
| Live-protocol suite | **5/5 green** (resize/compact/abort/concurrent-widget with the new source tree). |
| Real-TUI quota on/off streaming | **10/10 checks green** ([quota-tui-stream.json](quota-tui-stream.json)): quota marker with an enabled-but-unmatched profile, mid-stream typing, rows within width, `/hud quota off` mid-stream (ack + marker gone + stream completes), `/hud quota on` restore, `/hud quotas` output, narrow 42-col folding. Fixture provider (zero network); the networked path is covered below. |
| Real-account personal E2E | **Green** ([quota-live-e2e.json](quota-live-e2e.json)): real Pi TUI + real `zai-coding-cn` credential (resolved by the host, never printed), HUD row `GLM Personal · 5h 100% · wk 67%`, `/hud quotas` JSON matching a **same-minute raw read-only query** exactly (0%→100%, 33%→67%, tools 999/1000, identical reset timestamps, the null 5h reset kept unknown). on/off/refresh commands verified live; no credential material in any captured output. |
| Team live E2E | **Green** ([quota-live-e2e.json](quota-live-e2e.json) `team`, 2026-09-22): real Pi TUI + `zai-coding-team/glm-5.3`, key resolved by the host from the `$ZAI_API_KEY_TEAM` env reference, org/project provided live for the run only (redacted in the record, deliberately not persisted). HUD row `GLM Team · 5h 84% · wk 20%`; counters 1 check → 1 auth → 1 request → 1 published; on/off/refresh verified live; explicit substring leak checks of the key and raw scope values (0 occurrences). A raw read-only `?type=2` query 58 s later matched both reset timestamps to the millisecond and confirmed the §9 field mapping live (`usage` is the limit; `currentValue`→used; server `remaining` kept verbatim); the +40-credit drift across both windows in the gap is live consumption, not a mapping error. The 2026-09-19 research records (request shape, console comparison) remain the scope/console-side basis ([GLM-PLAN-SCOPES.zh-CN.md §7-8](GLM-PLAN-SCOPES.zh-CN.md)). |

Explicitly **not verified** in this slice (kept out of any support claim): `region: "global"` (international site), other member/permission roles or multi-organization setups, and the MiniMax/Codex/Gemini/DeepSeek/SiliconFlow adapters (interface only at phase-A time; `unsupported-adapter` without requests). The `queryMode: "personal"` (type=1) candidate was **dropped from scope** by owner decision 2026-09-22 and is rejected at config load (see the scope-adjustment section below); it is no longer a pending verification item.

## Provider quota slice 2: DeepSeek + SiliconFlow balance adapters (2026-09-21)

Design: [PROVIDER-LIMITS-PLAN.zh-CN.md](PROVIDER-LIMITS-PLAN.zh-CN.md) §2 API 余额 (implementation-status note), §9/§10. **Default off; no gate was relaxed.**

| Check | Status and scope |
| --- | --- |
| Contract basis | DeepSeek: official `GET https://api.deepseek.com/user/balance` reference (`is_available`, `balance_infos[]` with `currency` CNY/USD and `total_balance`/`granted_balance`/`topped_up_balance` decimal strings; Bearer auth). SiliconFlow: official openapi.yaml in `siliconflow/siliconcloud` (`GET https://api.siliconflow.cn/v1/user/info`; envelope `code: 20000`/`status: true`; `data.balance`/`chargeBalance`/`totalBalance`; Bearer auth). Both re-read on 2026-09-21 during implementation. |
| Regression suite | **324 tests pass / 0 fail** (18 new: official-sample normalization for both adapters, exact-text amounts never re-summed, zero/negative/USD values, invalid-amount partial/protocol/no-data classification, business-envelope failures without message echo, §10 HTTP mapping incl. Retry-After, Bearer prefix never doubled, relay-guard refusals (relay/http/unparsable base URLs), helper unit tests, service end-to-end with injected fetch (request shape, HUD balance view, cache/TTL, `/hud quotas` balance details, business-failure-keeps-values, 401-hides-values), balance rendering both languages/ASCII/negative/unmapped-currency, config validation for the two adapters). No test touches a live account. |
| `npm run verify` | PASS: boundary scan (three new data-only adapter modules added to the enforced no-builtin list; fetch still confined to the transport boundary), schema/example/defaults in sync, preview unchanged, performance gates unchanged. |
| `npm run package:check` | PASS: 59 files packed, offline production install, packed entry import. Zero npm runtime dependencies kept. |
| Pinned SDK contract (`sdk-check`) | PASS against Pi 0.85.1 (quota surface type-check incl. the updated `QuotaService`/view shape). |
| Usage oracle / RPC / PTY smoke | PASS unchanged (`usage-oracle-check`, RPC smoke, PTY smoke re-run on the new tree). |
| Real-account E2E (DeepSeek) | **Green** ([quota-live-e2e.json](quota-live-e2e.json) `deepseek`, 2026-09-22): real Pi TUI + Pi's built-in `deepseek` provider, key resolved by the host from the `DEEPSEEK_API_KEY` env fallback (auth.json entry empty; never printed). HUD row `DeepSeek · ¥66.90`; `/hud quotas` ready with account 66.90 / granted 0.00 / topped-up 66.90 CNY as separate exact-text items; counters 1 check → 1 auth resolution → 1 request → 1 published; on/off/refresh verified live; explicit substring leak check of the live key against the full captured output (0 occurrences). A raw read-only `GET /user/balance` 32 s later returned 66.85 (live 0.05 CNY consumption between reads — real-time billing, not a mapping error); both values recorded verbatim. |
| Real-account E2E (SiliconFlow) | **Not executed — owner decision 2026-09-22 (no official API key available; deliberately not attempted this round).** Stays recorded as pending, not claimed. |
| Real-TUI balance row | **DeepSeek covered live** (the `DeepSeek · ¥66.90` row above, rendered in the real TUI footer alongside the identity row; fixed row counts/narrow widths/both languages remain covered by injected tests). SiliconFlow's live row pending with its E2E. |

Explicitly **not verified** in this slice (kept out of any support claim): real-account responses for SiliconFlow (no official key; owner decision 2026-09-22), the SiliconFlow field-meaning inference (`balance` = granted, `chargeBalance` = topped-up, derived from the official example arithmetic; `totalBalance` used verbatim regardless) and the CNY currency normalization for SiliconFlow, and the MiniMax/Codex/Gemini adapters (still `unsupported-adapter` without requests). DeepSeek's real-account verification is limited to one CNY account reading on 2026-09-22 (the USD `balance_infos` variant remains covered by official-sample injected tests only).

## Provider quota scope adjustment: GLM type=1 dropped, team live E2E completed (2026-09-22)

Owner decisions this round: the GLM `queryMode: "personal"` (type=1) candidate is dropped from scope entirely, and the GLM team live E2E was completed from live-provided scope values (recorded above in the phase-A table row; evidence in [quota-live-e2e.json](quota-live-e2e.json) `team`).

| Check | Status and scope |
| --- | --- |
| Code change | `queryMode: "personal"` removed from the accepted enum (`src/config.ts` type + `ZAI_MODES`, `docs/config.schema.json`) — a config naming it is rejected at load with `invalid plan/queryMode combination` and the previous valid configuration stays active; the zai adapter's former needs-verification branch for it is deleted (unreachable by construction). `region: "global"` keeps its diagnostic-only needs-verification refusal. |
| Regression suite | **337 tests pass / 0 fail** (the former "type=1 refuses with needs-verification" assertion is replaced by a config-load rejection assertion; the region-global refusal assertion is unchanged). |
| `npm run verify` | PASS: schema/example/defaults in sync after the enum change, boundary scan unchanged, performance gates unchanged. |
| Live evidence | Team E2E + same-minute raw `?type=2` cross-check and the DeepSeek balance E2E are recorded in [quota-live-e2e.json](quota-live-e2e.json) (sections `team`, `deepseek`); no credential or scope material persisted (redaction verified by substring checks). |

Not a claim of new adapter capability: the set of queryable configurations shrank by one never-verified candidate; no previously working configuration changed behavior.

## Provider quota slice 3: Codex subscription adapter via the app-server protocol (2026-09-22)

Design: [PROVIDER-LIMITS-PLAN.zh-CN.md](PROVIDER-LIMITS-PLAN.zh-CN.md) §2 Codex, §5/§7/§9/§10. **Default off; no gate was relaxed.**

| Check | Status and scope |
| --- | --- |
| Contract basis | codex-cli **0.155.1** (the installed upstream; JSON Schema generated by `codex app-server generate-json-schema`): newline-delimited JSON-RPC over stdio; `initialize` (clientInfo required) → `initialized` (the only client notification) → `account/rateLimits/read`; response `rateLimits` (required single-bucket view) + `rateLimitsByLimitId` (multi-bucket map); window = `{usedPercent int (required), resetsAt unix-seconds, windowDurationMins}`; `planType` enum (free/go/plus/pro/prolite/team/…). Read-only: no thread/turn, no model request, no `rateLimitResetCredit/consume`. |
| Regression suite | **355 tests pass / 0 fail** (18 new in `tests/codex.test.mjs`: probe-shape normalization incl. seconds→ms resets and the week-window mapping, primary/secondary as separate buckets, single-bucket fallback, unknown-duration windows staying unknown, clamped display complement, JSON-RPC error envelopes → needs-auth/business-error without message echo, missing/windowless → protocol/no-data, prepare refusals, config combo validation, the fake-child driver (exact three frames, id disambiguation, notification skipping, stdin kept open, spawn ENOENT/throw/early-exit classification, SIGTERM→SIGKILL deadline escalation, frame/total overflow, the 10 s floor), service end-to-end with an injected runner (no host-auth resolution, HUD view + `Codex · wk 21%` rendering, spawn-not-found issue detail)). |
| Boundary scan (`npm run verify`) | PASS: `spawn` (async) confined to the marked `src/quota/codex-process.ts` boundary; the sync variants stay forbidden everywhere; the module must import `node:child_process` (guards the runtime-ReferenceError class found live); fetch confinement unchanged; schema/example/defaults in sync; performance gates unchanged. |
| `npm run package:check` | PASS: 61 files packed, offline production install, packed entry import. Zero npm runtime dependencies kept. |
| Pinned SDK contract (`sdk-check`) | PASS against Pi 0.85.1 (the extended `QuotaService` options and adapter registry type-check). |
| Real-account E2E | **Green** ([quota-live-e2e.json](quota-live-e2e.json) `codex`, 2026-09-22): real Pi TUI + `openai-codex/gpt-6-astra`, the spawned `codex app-server` child using the local codex login (host env inherited; egress-proxy requirements are the host environment's, generically documented). HUD row `Codex · wk 21%`; `/hud quotas` ready with planLabel `prolite`, bucket `codex:primary` 1week used 79% → 21% remaining, reset 2026-09-26T13:57:31Z; counters 1 check → **0 auth resolutions** (no Pi credential read) → 1 request → 1 published; on/off/refresh verified live; substring leak checks of accountId/email (0 occurrences). A standalone read-only probe 29 s later returned identical values (usedPercent 79, resetsAt 1790431051, planType prolite). |
| Protocol findings | Recorded in the evidence file: stdin-EOF-before-answer is a shutdown signal (driver keeps stdin open, kills after the answer — unit-tested); unsolicited notifications skipped by id; the missing-import runtime failure class is now a check.mjs assertion. |

Explicitly **not verified** in this slice (kept out of any support claim): other plan types (the live account is `prolite`; free/go/plus/team and the edu/enterprise enums are covered by schema-derived handling only), accounts where `secondary` (the 5-hour window) is non-null (covered by synthetic tests only), a not-logged-in codex (the needs-auth mapping is pattern-based on error envelopes, not observed live), codex versions other than 0.155.1, the `credits`/`rateLimitResetCredits`/`ordinaryUsageAllowed` fields (read but not displayed), automatic verification that the local codex login matches Pi's openai-codex account (recorded as matching during research; the adapter does not claim it), and the MiniMax/Gemini adapters (still `unsupported-adapter` without requests).
