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

## What to verify on the first real installation

Load the extension once, inspect `/hud status`, try the three presets, Chinese labels, resizing, compaction, model switching, reload and off/on. Keep Git disabled initially. A loaded extension should not cause tool prompts, network access or extra model messages; the built-in footer and editor should remain intact. With no completed response after attachment, `ctx(last) ?` is expected. Subagent/task rows without adapters are not expected to populate automatically.

For a public stable release, the owner should review passing pinned-SDK/RPC/PTY checks and real-terminal A/B evidence before publishing the generated draft. Source-level compatibility review and microbenchmarks are valuable but not substitutes for that gate.
