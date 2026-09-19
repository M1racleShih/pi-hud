# Agent and task bridge v1

[README](../README.md) · [中文首页](../README.zh-CN.md)

Pi extensions vary in their subagent and task APIs. pi-hud does not scrape their prompts, command text or terminal output. The bridge accepts small facts over Pi's existing event bus, does not register model-callable tools, and writes nothing to the session.

## Publish actual lifecycle events

Inside the extension that owns a child agent, emit after it really starts:

```ts
pi.events.emit("pi-hud:update", {
  version: 1,
  source: "my-subagents",
  kind: "agent",
  id: childId,
  status: "running",
  label: "Review authentication", // User-safe summary, not a prompt or secret
  ttlMs: 60_000,
});
```

Emit the same source/id with `status: "done"` or `status: "error"` when its real operation settles. Cancellation can use `error` plus a safe label; v1 has no separate cancelled state. Do not assert success merely because a child process was launched. If existing progress events occur during a long run, renew its TTL through those events. Do not introduce a new high-frequency heartbeat just for the HUD.

For task progress, publish a **complete snapshot for that task group**, not a delta:

```ts
pi.events.emit("pi-hud:update", {
  version: 1, source: "my-goal", kind: "tasks", id: goalId,
  completed: 3, total: 7, label: "Implement and verify Pi HUD",
  ttlMs: 300_000,
});
```

After cancellation or session replacement, clear that producer's records:

```ts
pi.events.emit("pi-hud:update", { version: 1, source: "my-goal", kind: "clear" });
```

Publishers own their subscription/disposal lifecycle; do not make pi-hud call their tools or await their operations. Display TTL expiry only means the observation became stale, not that the underlying job succeeded or stopped. A running badge may disappear before a silent long-running job ends; publishers should use an appropriate bounded TTL or renew on real progress.

## Contract

`version` must be `1`. `source` matches `[a-zA-Z0-9._/-]{1,64}` and should be a stable extension identifier. Agent/task `id` is a nonempty string of at most 160 characters. Their storage keys are source/id pairs. Labels are sanitized and capped. Agents allow `running`, `done`, `error`; task counters must be integers satisfying `0 <= completed <= total <= 1,000,000`.

TTL must be an integer from 1,000 to 3,600,000 ms. Defaults are 60,000 ms for running agents, 10,000 ms for terminal agent states, and 300,000 ms for tasks. Expiration uses a single one-shot timer for the earliest bounded record; empty activity has no timer. Maximum retained records: 16 agents, 8 task groups. Unknown versions/kinds, invalid values and over-cap new IDs are rejected. Do not send huge nested payloads: ignored keys do not make a shared event bus a safe transport for arbitrary data.

Multiple task groups are summed for the displayed fraction. Use disjoint groups to avoid double-counting the same underlying tasks. Clearing one source does not clear another. Session changes and `/hud reset` clear everything. No history is loaded on resume; publishers must emit new snapshots if appropriate.

The bus is **not an authentication boundary**: any trusted extension can impersonate a source. Labels must be safe for a shared terminal. The bridge intentionally provides neither billing aggregation nor a mechanism for executing commands. With no valid bridge data the HUD renders no placeholder: the fixed summary row retains available usage information or stays blank, so an idle HUD never claims synthetic agents or tasks.

## Try the included explicit demo

```sh
pi -e /absolute/path/to/pi-hud/index.ts -e /absolute/path/to/pi-hud/examples/bridge-demo.ts
```

Run `/hud preset full`, then `/hud-demo`, `/hud-demo done`, or `/hud-demo clear`. These display clearly labelled **synthetic demo records**, do not start agents/tasks, and do not call a model. Do not load a second copy of the HUD when it is already globally installed; in that case add only `bridge-demo.ts`.

The footer surface's bounded status area shows `ctx.ui.setStatus` values from any extension. `examples/status-demo.ts` is a separate, equally explicit demo for that path:

```sh
pi -e /absolute/path/to/pi-hud/index.ts -e /absolute/path/to/pi-hud/examples/status-demo.ts
```

Run `/hud surface footer`, then `/hud-status-demo two`: the footer status line must update without any HUD event. The demo registers one status key and makes no model call.

No adapters for specific subagent forks or `/goal` packages are bundled in v0.1.0. Their actual start/progress/finish events must be mapped deliberately to this protocol.
