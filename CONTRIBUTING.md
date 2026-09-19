# Contributing

Use a short-lived branch from `main` (`feat/`, `fix/`, `docs/`, `test/`). Describe the problem in an issue, add a regression test, and open a pull request. Keep event processing, rendering and optional acquisition separated. Use conventional commit subjects without inventing issue/PR references.

Run `npm run verify` and `npm run package:check`. Changes touching rendering, state or scheduling require benchmark JSON and an explanation of bounds. Tests must cover failure/cancellation, narrow widths, Unicode, repeated lifecycle transitions and headless operation. Do not call mocked-host tests real Pi integration.

Preserve zero runtime dependencies, the lack of per-token/core-mutation listeners, bounded state and no recurring idle work. Keep `README.md` and `README.zh-CN.md` consistent. Do not add a provider/network client, credential read, prompt injection, history scan, subprocess or editor replacement without an explicit design decision and evidence supporting its cost.

CI uses read-only permissions, commit-pinned actions, no secrets on pull requests, and a separate draft-release job. Actual branch protection, required reviewers and GitHub security settings must be enabled by the repository owner; repository files cannot enforce those administrative settings by themselves.

See [development and release workflow](docs/DEVELOPMENT.md), [performance acceptance](docs/PERFORMANCE.md), and [security reporting](SECURITY.md).
