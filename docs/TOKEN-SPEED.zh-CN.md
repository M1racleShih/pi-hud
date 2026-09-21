# Token speed（生成速率）算法规范

[架构](ARCHITECTURE.md) · [配置](CONFIGURATION.md) · [中文首页](../README.zh-CN.md)

状态：已实现（`spd*` 字段，默认开启，`showSpeed: false` 关闭）。

## 1. 指标定义

HUD 显示的 `spd*` 是**最近一条已完成 assistant 消息的平均生成速率**：

```text
rate (tokens/s) = usage.output / ((t_end - t_first_token) / 1000)
```

| 量 | 来源 | 性质 |
| --- | --- | --- |
| 分子 `usage.output` | `message_end` 事件的最终 assistant usage，由 provider 上报 | **精确值**（含 reasoning/thinking tokens；与观测计数器读取的是同一个字段） |
| 分母 `t_end - t_first_token` | `message_end` 处理时刻 − 该消息**第一个携带内容的流式 delta** 到达时刻，均为宿主事件回调中的 `Date.now()`（毫秒） | 测量窗口 |

它回答的问题是"**模型生成 token 有多快**"。两个刻意不回答的问题：

- **不是实时速率**：流式过程中不更新任何数值，没有滑动窗口、没有每 delta 计数、没有平滑。显示值只在每条 assistant 消息结束时更新一次。
- **不是端到端吞吐**：分母从第一个内容 delta 起算，**不含 prefill/TTFT 等待**。一条 2s prefill + 10s 生成 500 token 的消息显示 50 t/s（生成速率），而不是 41.7 t/s（端到端）。工具执行时间天然不在窗口内：Pi 中工具执行发生在两条 assistant 消息之间，而窗口只覆盖单条消息内部。

### 为什么这是"最真实"的取法

1. 分子是 provider 上报的精确 token 数，不存在估算误差（chars/4 估算对中文约低估 2–3×；"每 delta 计 1 token"在 provider 批量 flush 时严重失真——两者都被否决）。
2. 分母排除 prefill：从 `message_start` 起表会把等待时间放进分母，短消息可低报 3× 以上，且偏差随上下文增长。
3. 网络抖动在长窗口上被首尾对消：首 token 和末 token 走同一条推送连接，延迟近似常数，对差值的影响 ≈ 0。

代价：单条消息内的速率波动（例如 thinking 阶段与正文阶段速度不同）不可见。这是有意的取舍——实时窗口方案（参考 `pi-token-speed`、`pi-tps`）的显示值依赖到达抖动修正与 token 数估算，不满足本项目的"不做误导性估算"原则。

## 2. 事件协议与状态机

新增订阅两个原生事件（`message_end` 原已订阅）：

| 事件 | 频率 | 用途 |
| --- | --- | --- |
| `message_start` | 低频（每条消息一次） | assistant 消息开始时**布防**（arm）一次测量 |
| `message_update` | 高频（每个流式 delta 一次） | **只记一个时间戳**：第一个携带内容的 delta 到达时刻。此后立即熔断，本条消息内所有后续 delta 都被 O(1) 早退忽略 |

状态机（`HudState` 内 3 个标量：`streamArmed: boolean`、`firstTokenAt: number | null`，加上已发布的 `speedRate/speedTokens/speedMs`）：

```text
message_start   role=assistant   → streamArmed=true, firstTokenAt=null   （布防）
message_start   role=其他         → streamArmed=false                    （解除布防；见 §4 交错防御）
message_update  布防中 && firstTokenAt===null
                && type ∈ {text_delta, thinking_delta, toolcall_delta}
                && typeof delta === "string" && delta.length > 0
                                 → firstTokenAt=now                     （记录一次，熔断）
                其他一切情况      → 立即返回，状态不变
message_end     role=assistant   → 尝试结算（§3），然后 streamArmed=false, firstTokenAt=null
```

**"携带内容"的判定**：只有 `text_delta` / `thinking_delta` / `toolcall_delta` 且 `delta` 为非空字符串。依据 Pi 的 `AssistantMessageEvent` 契约：`*_start` 事件发出时对应块是空的（token 尚未到达）；`start`、`*_end`、`done`、`error` 同样不携带新 token。`toolcall_delta` 计入：流式工具调用参数也是模型生成的 token。

**熔断规则**：一旦 `firstTokenAt` 被记录，`message_update` 处理路径在读取布防状态后立即返回。每条消息的高频成本 = 每 delta 一次布尔比较。不保留任何 delta 字符串（只读 `delta.length`），不累计内容，不申请定时器。

## 3. 结算（`message_end`，assistant）

按顺序执行以下守卫，任何一条不满足则**丢弃本次测量并保留上一次的已发布值**（与 `cacheHit` 对 error/aborted 的"上一个有效值保持权威"规则一致）：

| # | 守卫 | 理由 |
| --- | --- | --- |
| G1 | `streamArmed && firstTokenAt !== null` | 未见任何内容 delta：可能是 redacted thinking（块在 start 时即完整、无 delta）、deferred 流，或 HUD 在消息中途才挂载（错过 `message_start`）。无诚实分母。 |
| G2 | `stopReason ∉ {error, aborted}` | 中断消息的 usage 可能是部分的；且分母被截断。 |
| G3 | usage 为对象且 `usage.output > 0` | provider 未上报或零输出：无从计算。 |
| G4 | `elapsed = now - firstTokenAt ≥ 50ms` | 低于毫秒时钟分辨率的窗口（单次 flush、时钟粒度）只产生噪声。50ms 是声明的测量下限：更短的**完整**消息不显示速率。 |
| G5 | 消息的 `(provider, model)` 与当前选中模型一致 | 用户中途切换模型后完成的旧模型响应，其速率不能展示在新模型名旁边。注意：观测 token/费用计数器**仍然照常累计**（与既有规则相同），只有速率展示被跳过。 |

全部通过则发布：

```text
speedTokens = usage.output          （精确分子，供 /hud status 诊断）
speedMs     = elapsed               （精确分母，同上）
speedRate   = usage.output / (elapsed / 1000)
```

`stopReason ∈ {stop, length, toolUse, deferred}` 均可结算：它们都是完成了真实生成的正常终止。

## 4. 边界情形

| 情形 | 行为 |
| --- | --- |
| 消息中途才挂载/重载（错过 `message_start`） | G1 丢弃；下一条消息恢复 |
| redacted thinking、无任何 delta 的消息 | G1 丢弃 |
| 同一 turn 内多条 assistant 消息（工具循环） | 每条独立布防/结算；显示**最新一条**的值 |
| 布防后先到达非 assistant 的 `message_start` | 解除布防（协议上不会发生；防御状态错乱时宁可无值也不错配分母） |
| 未布防就收到 `message_update` | 忽略（返回 false，不触发重绘） |
| `assistantMessageEvent` 畸形（type 缺失、delta 非字符串） | 忽略；永不抛出 |
| 用户中断（abort）、provider 错误 | G2 丢弃，上一次有效值保留 |
| `/hud reset`、会话切换/替换/fork、重新挂载 | 速率清空：这是观测数据，属于旧纪元 |
| `model_select` 切换到不同模型 | `speedRate` 置空（与 `cacheHit` 相同的失效规则）；切回同一模型不恢复 |
| 上下文压缩（`session_compact`） | **保留**：速率是时间测量而非上下文断言，压缩不改变它的含义（与 `cacheHit` 的差异是有意的，因为压缩会重写 prompt 从而作废缓存率） |
| 树导航（`session_tree`） | 随 `reset()` 清空（观测纪元重置） |
| 速率显示上限 | `rate ≥ 1000` 显示 `>999`；G4 已排除最极端的窗口，上限只防显示溢出 |

## 5. 渲染与配置

- 字段：`spd* 42.3 t/s`（en）/ `速度* 42.3 tok/s`（zh-CN）。`*` 沿用本项目"带保留说明"的标签惯例——含义是"最近一条 assistant 消息的样本，仅生成窗口"。
- 位置：widget 的 `full` 预设第 3 行（usage 字段之后）；footer 的 usage 行（row 2，cost 之后）。
- 丢弃优先级 28：低于观测 token 字段（30）与 cost（60），窄宽度下先被折叠——速率是性能样本，账目与上下文优先。
- `showSpeed: false` 完全隐藏字段（仍照常记录，`/hud status` 可查）。
- 无值（`speedRate === null`）时字段整体消失，不留占位。

## 6. 成本声明

| 维度 | 上限 |
| --- | --- |
| `message_update` 处理 | 每 delta 一次布尔比较（已熔断时）；首个内容 delta 为 O(1) 记录。不保留字符串、不触发重绘（`changed=false` 不进 coalescer） |
| 状态 | 5 个标量（armed、firstTokenAt、rate、tokens、ms），不随消息数增长 |
| 定时器 | 零。不存在刷新 interval、动画或 spinner；数值更新走既有 `message_end` 路径的 trailing coalescer |
| 渲染 | 每 assistant 消息至多一次新帧 |

## 7. 与参考实现的对比

调研过的 Pi 生态实现（`pi-token-speed`、`pi-tps`、`pi-pulse`、`pi-tps-status`、`pi-metrics`、`@pi-plugins/speed`、`token-rate-pi`）中，实时方案全部依赖 `message_update` 的逐 delta 计数 + 估算（chars/4 或 1-delta-1-token）+ 滑动窗口/EMA 平滑，部分还需要 `setInterval` ticker 与 spinner。本实现取它们的**完成态平均值**（`pi-tps` 的 final 统计同源：首内容 delta 起表 + 最终 `usage.output` 对账），但显式拒绝估算与动画：这是唯一一个分子精确、且不引入任何高频状态或定时器的方案。

## 8. 已知局限（诚实清单）

- 单条消息内部的速度结构不可见（thinking 慢、正文快之类的波动被平均掉）。
- 生成窗口 < 50ms 的极短消息不显示速率。
- 首 token 与消息结束之间的网络重排（连接级 stall-then-burst）无法与真实的生成暂停区分，会低估该条消息的速率；窗口越长影响越小。
- provider 在 `message_end` 报告的 `usage.output` 若本身不含 reasoning tokens（罕见契约），分子会小于真实生成量——HUD 不修正，只如实使用上报值。
