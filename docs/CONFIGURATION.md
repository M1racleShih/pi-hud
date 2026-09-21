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
| `usageScope` | `observed` | `observed` (counters since attach/reset; no history access), `session` (additionally build the optional full-session ledger over every SessionManager entry; labelled `sess*` with loading/updating/partial markers) |
| `refreshMs` | `250` | integer 250–2000 |
| `color` | `true` | boolean; `false` disables all styling regardless of `palette` |
| `ascii` | `false` | boolean; ASCII symbols/ellipsis, not translation of arbitrary model names or labels |
| `showCost` | `true` | boolean |
| `showThinking` | `true` | boolean |
| `showSpeed` | `true` | boolean; hide the `spd*` field without stopping the measurement |
| `git.enabled` | `false` | boolean |
| `git.ttlMs` | `30000` | integer 10000–600000 |
| `git.timeoutMs` | `500` | integer 100–1000 |
| `quota.enabled` | `false` | boolean; the opt-in provider quota feature (see below). With `false` (default) no credentials are parsed, no network or subprocess tasks exist and nothing is rendered |
| `quota.ttlMs` | `300000` | integer 30000–3600000; cache lifetime. Expiry never triggers network access — the next qualifying event refreshes |
| `quota.timeoutMs` | `5000` | integer 1000–30000; per-request HTTP timeout |
| `quota.profiles` | `[]` | array, at most 16 quota identity profiles (see below) |
| `$schema` | absent | optional string for editor tooling; ignored at runtime |

Fields may be omitted; defaults fill them. There are no Full/Minimal presets that secretly enable extra I/O: all presets change rendering only. `git.enabled` and `quota.enabled` must always be opted into separately.

### Quota profiles

Each profile binds one quota identity to an exact Pi provider. Only `zai` (GLM, region `cn`) is implemented; the other adapter names load for forward compatibility and report `unsupported-adapter` at query time without any request. Credentials are never part of the configuration: the key is resolved from the provider's own auth at query time.

```json
{
  "version": 1,
  "quota": {
    "enabled": true,
    "profiles": [
      { "id": "glm-personal", "providerId": "zai-coding-cn", "adapter": "zai", "source": "pi", "region": "cn", "plan": "personal", "queryMode": "personal-legacy" },
      { "id": "glm-team", "providerId": "zai-coding-cn-team", "adapter": "zai", "source": "pi", "region": "cn", "plan": "team", "queryMode": "team", "organizationId": "<your-organization-id>", "projectId": "<your-project-id>" }
    ]  }
}
```

| Field | Rules |
| --- | --- |
| `id` | 1–64 characters, unique, no control characters; the profile alias used by diagnostics |
| `providerId` | exact Pi provider id (never matched by prefix) |
| `adapter` | one of `zai`, `minimax`, `codex`, `gemini-cli`, `deepseek`, `siliconflow` |
| `source` | `pi`, or `codex-app-server` for the `codex` adapter |
| `enabled` | optional boolean, default `true`; disabled profiles never match or conflict |
| `region` | required for `zai`/`minimax` (`cn` or `global`); `global` is unverified for GLM and reports `needs-verification` without requests |
| `plan` / `queryMode` | required for `zai`; verified combinations: `personal`+`personal-legacy`, `team`+`team`; the `personal` (type=1) candidate is unverified and reports `needs-verification` without requests |
| `organizationId` / `projectId` | optional account context (1–128 characters, no control characters); a team profile without a complete scope reports `needs-scope` before any request; values conflicting with host-resolved headers report `scope-conflict` |
| `modelIds` | optional exact model ids (1–16) narrowing the profile inside its provider |
| `origin` | optional; must equal the adapter's fixed origin for the region (`https://open.bigmodel.cn` for GLM `cn`) |

Unknown fields, duplicate ids, invalid combinations and wrong types reject the whole configuration load; the previous valid configuration stays active. Multiple enabled profiles matching the current model show `ambiguous-profile` instead of picking by list order. `/hud quota on|off|refresh` and `/hud quotas` change or inspect this in memory only.

`surface` defaults to `footer` (the owner-approved switch; see DEFAULT-FOOTER-DECISION.zh-CN.md): the HUD replaces Pi's built-in footer. `widget` restores the passive named widget above/below the editor with Pi's built-in footer untouched. `footer` uses the official `ctx.ui.setFooter` slot, mounts no widget, and shows the identity/usage/status rows the built-in footer used to show. `placement` only affects the widget. If the host does not provide `ui.setFooter`, `footer` falls back to the widget and `/hud status` records the reason; startup never emits unsolicited error text for that fallback. `/hud surface footer` is also the documented way to re-claim the slot after another extension replaced the HUD footer.

The footer is **not** a byte-for-byte replacement of the built-in footer. By default it reads no session history: its counters stay "observed since this attachment/reset", its context value stays the labelled `ctx(last)` snapshot, and the host's live context estimate, auto-compaction/subscription flags and provider count are not imitated. `usageScope: "session"` switches the usage fields to the full-session ledger (see below); the other coverage limits still apply, and `/hud status` prints every difference explicitly. Git branch display uses Pi's cached `footerData.getGitBranch()`/`onBranchChange()` and starts no Git process; the `*` dirty marker still requires `git.enabled`.

`usageScope` is an explicit opt-in, independent of `surface`. The default `observed` never reads history: counters describe what this attachment actually saw. `session` builds the optional full-session usage ledger in `src/usage.ts` from the current SessionManager's entries — all branches, pre-compaction messages, error/aborted responses and summary records — matching the built-in footer's four record categories (assistant, tool results carrying usage, compaction, branch summaries). The first baseline is sliced (512 entries or ~2 ms per slice) in cancelable background tasks; steady turns reconcile only newly committed records by walking the parent chain, so `getEntries()` runs once per rebuild and never per turn; tree navigation and compaction rebuild once; a session switch, `/hud off` or leaving `session` cancels all work immediately. Missing or invalid numbers mark the data incomplete (`+?`, `?`, `limited*`) instead of being dropped: an assistant without usage is incomplete data, a usage-less tool result is out of scope (never an unknown charge), a summary without usage keeps token subtotals and marks cost incomplete, and an explicit zero cost stays a valid zero. `ctx(last)`, `CH` and tool categories keep their observed scope in both modes. A host without the read-only entry surface degrades explicitly to observed-labelled data and records the reason. The full semantics are specified in the [session usage contract](SESSION-USAGE-CONTRACT.zh-CN.md) (Chinese). `/hud scope observed|session` changes this in memory only and re-baselines on every switch.

`palette` never changes data collection or layout, only the color of already-laid-out segments. `pastel` picks the soft dark-terminal candidates and automatically switches to deeper same-family variants when the host theme's text color indicates a light background. `theme` maps each field role to a host theme token (`accent`, `mdLink`, `mdHeading`, `customMessageLabel`, `success`, `warning`, `error`, `text`, `muted`, `dim`, `thinkingText`). `mono` is equivalent to `color: false` and is useful when a theme or terminal makes field colors unreadable. The command `/hud palette pastel|theme|mono` changes this in memory only, like every other `/hud` control.

`showSpeed` only hides or shows the `spd*` field; the measurement itself always runs because its cost is one timestamp per assistant message. The displayed value is the average generation speed of the last completed assistant message — provider-reported `usage.output` over the first-content-bearing-delta-to-`message_end` window — with no live estimation while streaming. The full algorithm, its five discard guards and the O(1) stream-bridge contract are specified in [the token-speed document](TOKEN-SPEED.zh-CN.md) (Chinese).

On a failed explicit reload, the last configuration remains active and a warning appears. Startup failure falls back to the previous/default configuration and records the reason in `/hud status`; it does not emit unsolicited error text into the terminal. Concurrent reads have generation tokens so a late read cannot overwrite `/hud off`, a placement change, or a new session.

`PI_HUD_DISABLE=1` is a startup kill switch. Any nonblank value other than `0`, `false`, `off`, or `no` (case-insensitive) disables factory registration. Changing that variable after loading has no effect on the already-created extension.

Use [the complete example](../examples/pi-hud.json) or [the schema](config.schema.json). Persistent preferences belong in that JSON file; `/hud` changes are intentionally ephemeral to avoid disk activity and cross-machine write conflicts.
