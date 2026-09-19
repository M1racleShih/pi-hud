# Configuration reference

[README](../README.md) · [中文首页](../README.zh-CN.md)

Only user-controlled global configuration is read. There is no project-local configuration execution, directory discovery, environment interpolation, arbitrary command, or automatic write.

Resolution order: absolute `PI_HUD_CONFIG`; otherwise `pi-hud.json` beneath absolute `PI_CODING_AGENT_DIR`; otherwise `~/.pi/agent/pi-hud.json`. A symlink to a regular file is supported for dotfile synchronization. Non-regular files, oversized files (>32 KiB), malformed JSON, arrays, unknown keys and wrong field types are rejected. The read is limited even if the file grows after `stat`. Symlinks are not a trust sandbox: configure only files you control.

| Field | Default | Allowed values |
| --- | --- | --- |
| `version` | `1` | `1` |
| `enabled` | `true` | boolean |
| `preset` | `balanced` | `minimal`, `balanced`, `full` |
| `surface` | `widget` | `widget` (named widget next to the built-in footer), `footer` (replace the built-in footer through `ui.setFooter`; no HUD widget is mounted) |
| `placement` | `belowEditor` | `aboveEditor`, `belowEditor` |
| `language` | `en` | `en`, `zh-CN` |
| `palette` | `pastel` | `pastel` (HUD soft field colors), `theme` (host theme tokens), `mono` (no color) |
| `refreshMs` | `250` | integer 250–2000 |
| `color` | `true` | boolean; `false` disables all styling regardless of `palette` |
| `ascii` | `false` | boolean; ASCII symbols/ellipsis, not translation of arbitrary model names or labels |
| `showCost` | `true` | boolean |
| `showThinking` | `true` | boolean |
| `git.enabled` | `false` | boolean |
| `git.ttlMs` | `30000` | integer 10000–600000 |
| `git.timeoutMs` | `500` | integer 100–1000 |
| `$schema` | absent | optional string for editor tooling; ignored at runtime |

Fields may be omitted; defaults fill them. There are no Full/Minimal presets that secretly enable extra I/O: all presets change rendering only. `git.enabled` must always be opted into separately.

`surface` is an explicit opt-in. `widget` is the default and keeps the current behavior: a named widget is mounted above/below the editor and Pi's built-in footer stays untouched. `footer` uses the official `ctx.ui.setFooter` slot, mounts no widget, and shows the identity/usage/status rows the built-in footer used to show. `placement` only affects the widget. If the host does not provide `ui.setFooter`, `footer` falls back to the widget and `/hud status` records the reason; startup never emits unsolicited error text for that fallback. `/hud surface footer` is also the documented way to re-claim the slot after another extension replaced the HUD footer.

The footer is **not** a byte-for-byte replacement of the built-in footer. It does not read session history in this round: its counters stay "observed since this attachment/reset", its context value stays the labelled `ctx(last)` snapshot, and the host's full-session totals, live context estimate, auto-compaction/subscription flags and provider count are not imitated. `/hud status` prints this coverage difference explicitly. Git branch display uses Pi's cached `footerData.getGitBranch()`/`onBranchChange()` and starts no Git process; the `*` dirty marker still requires `git.enabled`.

`palette` never changes data collection or layout, only the color of already-laid-out segments. `pastel` picks the soft dark-terminal candidates and automatically switches to deeper same-family variants when the host theme's text color indicates a light background. `theme` maps each field role to a host theme token (`accent`, `mdLink`, `mdHeading`, `customMessageLabel`, `success`, `warning`, `error`, `text`, `muted`, `dim`, `thinkingText`). `mono` is equivalent to `color: false` and is useful when a theme or terminal makes field colors unreadable. The command `/hud palette pastel|theme|mono` changes this in memory only, like every other `/hud` control.

On a failed explicit reload, the last configuration remains active and a warning appears. Startup failure falls back to the previous/default configuration and records the reason in `/hud status`; it does not emit unsolicited error text into the terminal. Concurrent reads have generation tokens so a late read cannot overwrite `/hud off`, a placement change, or a new session.

`PI_HUD_DISABLE=1` is a startup kill switch. Any nonblank value other than `0`, `false`, `off`, or `no` (case-insensitive) disables factory registration. Changing that variable after loading has no effect on the already-created extension.

Use [the complete example](../examples/pi-hud.json) or [the schema](config.schema.json). Persistent preferences belong in that JSON file; `/hud` changes are intentionally ephemeral to avoid disk activity and cross-machine write conflicts.
