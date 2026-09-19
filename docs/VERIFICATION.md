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
| Same-machine A/B | 8 interleaved pairs against `af3a5e4` with the identical probe file and shared fixtures. The widget path with observed usage is ~+0.47 µs mean slower (7.06 → 7.54 µs) because the usage row now renders four separate counters plus `CH`; the cached path is slightly cheaper, hooks are within noise (+0.06 µs paired tool-pair p99), and all gates pass unchanged. Footer scenarios are new and have no pre-change baseline: full 12.9 µs mean / 86.6 µs p99 uncached, balanced 11.5 µs, 40-column 8.8 µs, and 0.095 µs per cached frame with 12 statuses against the new 5 µs gate. Full data: [performance-phase3-ab.json](performance-phase3-ab.json). |
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
