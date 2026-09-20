# Development, Git history and release workflow

[README](../README.md) · [Contributing](../CONTRIBUTING.md) · [Verification](VERIFICATION.md)

## Local workflow used for this delivery

The repository was initialized with `main`, then developed on actual topic branches: `docs/research`, `feat/event-driven-hud`, `test/performance-and-release`, and a final documentation/release branch. Each logical stage is committed and merged with `--no-ff` to preserve the sequence. The v0.1.0 tag identifies the delivered source. No issue/PR numbers, reviewers, remote approvals or remote CI results are invented.

The source ZIP is directly installable, while `pi-hud-history.bundle` in the delivery root preserves the real Git objects and branch/tag refs. Restore a development clone independently from the installable source directory:

```sh
git clone pi-hud-history.bundle pi-hud-dev
cd pi-hud-dev
git log --graph --oneline --all
git remote remove origin
```

Set a remote belonging to your own repository before pushing:

```sh
git remote add origin git@github.com:YOUR-ACCOUNT/pi-hud.git
git push -u origin main
git push origin v0.1.0
```

Replace `YOUR-ACCOUNT`; no repository with that literal name is assumed to exist. Pushing the tag is optional and triggers a **draft-release** workflow. Pushing source alone does not publish to npm. GitHub repository creation, protected branches, required checks and reviewers remain owner-admin actions.

## Local checks

Use Node 22.19.0 or newer for the supported host profile. No npm dependencies are required for the local source suite.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test -- --experimental-test-coverage
node bench/run.mjs --check --json=performance-result.json
npm run package:check
npm run demo
```

`check` enforces syntax, allowed imports, forbidden core-path APIs, manifest and local documentation links, keeps the JSON schema/example equal to the runtime defaults, and fails if `docs/preview.txt` no longer matches the deterministic renderer output. For `setFooter` it keeps one dedicated exception: the call is allowed only inside the marked boundary section of `src/footer.ts`, with its capability guard and install/release helpers, and every other source file keeps the full forbidden list. Regenerate the preview after an intentional layout change with `npm run demo -- --write docs/preview.txt`; do not hand-edit it. `test` uses Node's test runner with explicit paths for shell-independent Windows execution. Git tests create and remove their own temporary repository. Performance budgets are explicit and machine-sensitive; see the methodology before comparing results. Packaging tests extract only the package's own tarball, perform an empty-cache offline production install and import the actual packed entry.

## Pinned host checks (network-enabled environment)

The SDK is isolated under ignored `.tmp/sdk`, not added to the shipped package's runtime dependencies:

```sh
npm install --prefix .tmp/sdk --ignore-scripts --no-audit --no-fund --save-exact @earendil-works/pi-coding-agent@0.85.1 typescript@5.9.3 @types/node@22.19.19
node scripts/sdk-check.mjs
node scripts/usage-oracle-check.mjs
node scripts/pi-rpc-smoke.mjs
python3 scripts/pi-pty-smoke.py
```

The SDK check type-checks the pinned `ExtensionAPI`/`Theme` contracts, the bridge example, the HUD's theme-role tokens against Pi's `ThemeColor` union, and the footer surface: the HUD's structural `FooterDataLike` must accept Pi's real `ReadonlyFooterDataProvider`, `setFooter(factory)`/`setFooter(undefined)` must match `Component & { dispose? }`, and the session-name/`session_info_changed` surfaces are asserted too. Since phase 3 B2a it also type-checks the session usage ledger contract: `SessionManagerLike` must accept the real `ExtensionContext["sessionManager"]`, `SessionEntryLike` must accept real `SessionEntry` values, and `pi.on("turn_end")` plus the public ledger lifecycle must exist. `usage-oracle-check.mjs` additionally runs the ledger against real `SessionManager.inMemory` histories and compares the totals with the SDK's own `createUsageTotals`/`addUsageToTotals` (no network, model, credentials or file persistence). The PTY script requires a Unix-like environment. SDK checks and examples use the actual pinned TypeScript API; implementation behavior remains covered by separate runtime tests. RPC and PTY smoke use disposable homes/workspaces with no provider credentials and make no model requests. The PTY smoke loads `examples/bridge-demo.ts` and `examples/status-demo.ts`, switches presets/surface/palette, verifies that the built-in footer is replaced and later restored, checks an independent `setStatus` update, and resizes the real TUI, but it is not a streaming A/B. A real streaming A/B is a separate acceptance step.

### B2b reproducible measurement and acceptance tools (pinned SDK required)

```sh
node scripts/usage-ledger-bench-run.mjs --json=docs/performance-b2b-ledger.json   # 1k/10k/100k x linear/branched
node scripts/usage-ab-run.mjs --pairs=8 --json=docs/performance-b2b-usage-ab.json  # interleaved observed/session A/B
python3 scripts/pi-host-acceptance.py --json=docs/host-acceptance-b2b.json          # 9 real-TUI scenarios
python3 scripts/pi-stream-ab.py --pairs=10 --json=docs/pi-stream-ab-b2b.json        # 20 live streaming/tool/keyboard trials
node scripts/usage-session-file.mjs /tmp/s.jsonl --size=10000 --shape=branched      # build a resumable fixture session
node scripts/session-file-oracle.mjs /tmp/s.jsonl                                   # independent file oracle
```

All of them run offline with the deterministic in-process fixture provider
(`tests/fixtures/fixture-provider.ts`, loaded via `pi -e`; zero network, credentials or
billing) in disposable homes/workspaces. The ledger benchmark spawns one child per cell
with `--expose-gc`; every timing is asserted against the fixture oracle before being
recorded, and heap attribution uses settling GCs plus a zero-work control window (see
[PERFORMANCE.md](PERFORMANCE.md)). The host acceptance compares the published ledger
totals (from `/hud status` diagnostics) with `session-file-oracle.mjs` over the live
session file at every checkpoint. Supporting fixtures live in `tests/fixtures/`
(`fixture-provider.ts`, `replacer-extension.ts`, `other-footer.ts`); they are test-only
and not part of the shipped package.

For a new phase, copy `scripts/perf-ab.mjs` into a `git worktree` of the pre-change commit and run `node scripts/perf-ab-run.mjs --before=<worktree> --after=. --pairs=8 --json=docs/performance-phaseN-ab.json`. The probe imports `src/footer.ts` dynamically, so a tree without that module reports the footer scenarios as new instead of failing; the runner records them with `before: null` rather than a fake comparison.

Direct SDK packages are pinned; the network-installed host's transitive dependency tree is not vendored in this source delivery. Review dependency changes and record the resolved `.tmp/sdk/package-lock.json` for reproducible host investigations. The root lockfile intentionally has zero dependencies.

## GitHub workflow

`ci.yml` runs on pull requests, main pushes, manual dispatch and reusable release calls. It contains six OS/Node test combinations, an Ubuntu performance gate with uploaded JSON, and an Ubuntu pinned-SDK/RPC/PTY job. Actions use reviewed commit SHAs, pull-request jobs have only `contents: read`, checkouts do not persist credentials, and the workflow does not use `pull_request_target` or repository secrets to execute contributor code. Dependabot monitors GitHub Actions pins.

Issue forms ask for sanitized environment/reproductions; the PR template requires performance and bilingual-documentation evidence. Repository administrators should require the relevant CI checks, review changes and protect `main`. Those settings are not claimed active merely because YAML is included.

`release.yml` runs on version tags, reuses CI, checks that the tag matches `package.json`, creates source ZIP and npm tarball with SHA-256 sums, then opens a **draft** GitHub release. Only that final job has `contents: write`. It never automatically publishes a release or sends anything to npm. Draft contents still require human review and the real-terminal acceptance evidence described in [PERFORMANCE.md](PERFORMANCE.md).

For subsequent releases: update both READMEs if behavior changed, add changelog notes, rerun verification, open/review/merge the PR, update package and lockfile versions together, tag the reviewed commit, inspect the draft artifacts, and publish only after the acceptance gate is satisfied.
