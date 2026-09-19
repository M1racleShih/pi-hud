# Configuration reference

[README](../README.md) · [中文首页](../README.zh-CN.md)

Only user-controlled global configuration is read. There is no project-local configuration execution, directory discovery, environment interpolation, arbitrary command, or automatic write.

Resolution order: absolute `PI_HUD_CONFIG`; otherwise `pi-hud.json` beneath absolute `PI_CODING_AGENT_DIR`; otherwise `~/.pi/agent/pi-hud.json`. A symlink to a regular file is supported for dotfile synchronization. Non-regular files, oversized files (>32 KiB), malformed JSON, arrays, unknown keys and wrong field types are rejected. The read is limited even if the file grows after `stat`. Symlinks are not a trust sandbox: configure only files you control.

| Field | Default | Allowed values |
| --- | --- | --- |
| `version` | `1` | `1` |
| `enabled` | `true` | boolean |
| `preset` | `balanced` | `minimal`, `balanced`, `full` |
| `placement` | `belowEditor` | `aboveEditor`, `belowEditor` |
| `language` | `en` | `en`, `zh-CN` |
| `refreshMs` | `250` | integer 250–2000 |
| `color` | `true` | boolean; uses the current Pi theme |
| `ascii` | `false` | boolean; ASCII symbols/ellipsis, not translation of arbitrary model names or labels |
| `showCost` | `true` | boolean |
| `showThinking` | `true` | boolean |
| `git.enabled` | `false` | boolean |
| `git.ttlMs` | `30000` | integer 10000–600000 |
| `git.timeoutMs` | `500` | integer 100–1000 |
| `$schema` | absent | optional string for editor tooling; ignored at runtime |

Fields may be omitted; defaults fill them. There are no Full/Minimal presets that secretly enable extra I/O: all presets change rendering only. `git.enabled` must always be opted into separately.

On a failed explicit reload, the last configuration remains active and a warning appears. Startup failure falls back to the previous/default configuration and records the reason in `/hud status`; it does not emit unsolicited error text into the terminal. Concurrent reads have generation tokens so a late read cannot overwrite `/hud off`, a placement change, or a new session.

`PI_HUD_DISABLE=1` is a startup kill switch. Any nonblank value other than `0`, `false`, `off`, or `no` (case-insensitive) disables factory registration. Changing that variable after loading has no effect on the already-created extension.

Use [the complete example](../examples/pi-hud.json) or [the schema](config.schema.json). Persistent preferences belong in that JSON file; `/hud` changes are intentionally ephemeral to avoid disk activity and cross-machine write conflicts.
