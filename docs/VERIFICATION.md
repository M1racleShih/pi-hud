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

## What to verify on the first real installation

Load the extension once, inspect `/hud status`, try the three presets, Chinese labels, resizing, compaction, model switching, reload and off/on. Keep Git disabled initially. A loaded extension should not cause tool prompts, network access or extra model messages; the built-in footer and editor should remain intact. With no completed response after attachment, `ctx(last) ?` is expected. Subagent/task rows without adapters are not expected to populate automatically.

For a public stable release, the owner should review passing pinned-SDK/RPC/PTY checks and real-terminal A/B evidence before publishing the generated draft. Source-level compatibility review and microbenchmarks are valuable but not substitutes for that gate.
