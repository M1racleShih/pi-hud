## Problem and approach

Describe the issue and why this is the smallest safe change.

## Evidence

- [ ] `npm run verify` and `npm run package:check` pass.
- [ ] No per-token listener, history scan, synchronous I/O, unbounded state, or recurring idle timer was added.
- [ ] Benchmark JSON is attached for state/render/scheduling changes.
- [ ] Native Pi loader/RPC CI passes; real-terminal A/B results are attached for TUI changes.
- [ ] Resume, tree navigation, compaction, model changes, off/on and shutdown were considered.
- [ ] README.md and README.zh-CN.md explain any changed behavior consistently.
- [ ] No credentials, conversation content, private paths, or unverifiable performance claims are included.

## Limitations / unexecuted checks

State these explicitly; do not mark mocked tests as host integration.
