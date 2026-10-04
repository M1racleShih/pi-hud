# 第三阶段 B1：全会话用量统计契约

日期：2026-09-20。项目审查基线：`94676b3`。状态：**B2a 已实现；B2b（长历史性能测量与真实宿主验收）已执行（2026-09-20，见文末）**。实测数据见 [PERFORMANCE.md](PERFORMANCE.md) 与 [VERIFICATION.md](VERIFICATION.md) 的 Phase 3 B2b 一节。

[交接](HANDOFF.zh-CN.md) · [视觉/footer 规划](VISUAL-FOOTER-PLAN.zh-CN.md) · [当前架构](ARCHITECTURE.md) · [验证记录](VERIFICATION.md)

## 决策建议

B2 增加显式选择的 `usageScope: observed | session`，默认 `observed`；`surface` 仍默认 `widget`。统计范围与展示位置独立，切换 widget/footer 不重置会话账本。这是建议的新配置，不是当前已有功能。

- `observed` 保留当前不扫描历史的低开销路径。
- `session` 从当前 SessionManager 的全部 entries 建立汇总，正常追加时只读取新增记录；恢复、树导航、压缩等结构边界允许重建。
- 两种模式都保留 `ctx(last)`、最近有效 assistant 的 CH、观察期工具分类。历史 token 总计不代表历史工具分类、实时上下文或实际账单也已补齐。
- B2 不将 footer 改为默认，不查询额度，不改宿主、不读会话文件、不订阅逐 token/工具输出事件，不恢复 recent、工具名轮换、独立 errors 或 todo 专用桥接。

选择显式模式的原因：首次 `getEntries()` 必然有 O(N) 同步复制，当前 SDK 无法把它变成严格有界的缓存读取。可以把后续汇总分片，不能据此宣称初始化无阻塞或所有模式内存恒定。

## 已核对的 SDK 事实

以下来自本机安装的 `@earendil-works/pi-coding-agent` 实际发布包（0.85.1 首次核对，2026-09-24 对 0.87.1 复核并补充新事实），而非对旧规划的沿用。路径相对该包；行号是首次核对版本的定位提示，符号名为主要依据。

| 来源 | 确认结果 | 对方案的影响 |
| --- | --- | --- |
| `dist/modes/interactive/components/footer.js:77`，`render`；`dist/core/usage-totals.js` | 遍历全部 entries，累计 assistant、带 usage 的 toolResult、带 usage 的 compaction/branch_summary；四项 token 独立相加，cost 取 `usage.cost.total`。**0.87.1 复核**：新增第五类 —— 独立 `usage` 条目（`type: "usage"`，Pi 0.86+ 缓存预热 `appendUsage("cache_warm", …)` 写入）同样无条件折入 footer 总额与 `/session` 的 `getUsageCostBreakdown` | 不可用当前 branch 代替全会话；不把缓存再计入 input；**账本必须折算 usage 条目**（Pi 0.86+），否则 cache warm 后 sess* 与原生 footer 分歧 |
| `dist/core/session-manager.js:995`，`getEntries` | 对 fileEntries 执行 filter，返回不含 header 的新浅数组 | 每次调用都是 O(N)，即使随后只处理数组尾部 |
| 同文件 `getEntry`、`getLeafId`、`getSessionId` | 分别使用 Map 查询或返回标量；都在 `ReadonlySessionManager` 公共类型中 | 可用游标追踪正常追加，无需每轮全量数组 |
| 同文件 `_appendEntry`、`appendMessage` | 先更新内存数组、索引、leaf，再调用持久化；message entry 的 id 是追加时生成的 | message_end payload 不是带最终 entry id 的追加通知；内存账本与文件落盘成功不是同一个保证 |
| `dist/core/agent-session.js:360`，`_handleAgentEvent` | 先 await 扩展事件，再通知监听者，再 appendMessage | HUD 的 message_end 发生在当前消息入账之前 |
| `dist/core/extensions/runner.js:654`，`emitMessageEnd` | 顺序执行扩展，后面的扩展可以返回替换消息；最终替换才进入历史 | 不可把 HUD 收到的 usage 当成最终历史 usage；延迟一个 microtask/定时器也不等于可靠的提交通知 |
| 包内嵌 `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`、`agent.js` | 核心 await message_end，再产生 turn_end；Agent 顺序 await listeners | turn_end 是核对该轮已追加 assistant/toolResult 的可用边界；仍须宿主集成测试验证扩展组合 |
| `dist/core/agent-session.js`，手动/自动压缩路径 | appendCompaction 后才发 session_compact；但用 `newEntries.find(e => e.type === "compaction" && e.summary === summary)` 选事件 entry | 相同 summary 文本可能选中旧 entry。不得只相信 compactionEntry.id/usage 累计；从 manager 重建 |
| 同文件 `navigateTree` | 改 leaf，必要时追加 branch_summary/label，重建 agent context，然后发 session_tree | 树导航后的全量重建包含放弃分支；不能清零会话累计 |
| `dist/core/extensions/types.d.ts:416` | session_start.reason 包含 startup/reload/new/resume/fork；另有 shutdown、before-switch、before-fork | 不假设存在 session_switch/session_fork 完成事件；以新的 session_start 建立账本 |
| `dist/core/session-manager.js`，`createBranchedSession` | fork 可以生成只含所选路径的新 session；`forkFrom` 是另一种全历史复制路径 | 按新 manager 实际 entries 汇总，不继承父会话总数，也不跟踪 parentSession 文件 |
| `dist/core/agent-session.js:2708`，`getContextUsage` | 读取 branch、检查压缩边界并估计消息 token | 不是 O(1) getter；B2 不纳入渲染/逐 token 路径 |
| `dist/core/footer-data-provider.d.ts` | ReadonlyFooterDataProvider **已有** `getAvailableProviderCount()`，实现返回缓存标量 | 修正旧规划把 provider 数量与无公开来源字段一并处理的判断；B2 不必因此增加新显示字段 |
| footer.js、ExtensionContext、ModelRegistry | 原生 auto 标记来自 footer 私有状态；订阅使用内部 ModelRuntime 并含 kimi 特例；公开 isUsingOAuth 不等价于订阅 | 不根据 OAuth/模型名称猜 auto/sub；不宣称完全替代原生 footer。实验标记也不在本轮公共契约中 |

旧视觉规划中“当前 input 合并缓存”的文字描述的是早期实现，阶段 A 已拆分四项。当前架构中 recent ring 的一段文字也已过时，现有 state 不保留该摘要；B2 不得按旧段落恢复它。

## 统计契约

### 范围与时间点

`session` 指**当前 SessionManager 全部可访问 entries**，包括其他分支、压缩前消息、已有错误/取消响应和摘要记录。不是账户、项目、今日、多会话或整条 fork 血缘的消费总量。

历史累计以已进入 manager 的记录为准；实时事件只触发同步，不能再把事件 usage 加到相同账本。UI 在合并发布后更新，正常更新最迟在 turn_end/agent_settled 的同步工作完成后反映。长工具执行过程中可以暂时显示上一提交快照；必须标记正在更新，不能声称逐消息实时或逐帧与原生完全相同。

工具分类、失败/中断、压缩次数继续是当前观察期统计，与 session token 范围分开说明。`/hud reset` 只清观察期数据；session 总计不得清成零，可以触发重新核对。off 期间不采集；on 后 session 模式重新建基线，不能接着使用有缺口的增量。

### 数值与缺失数据

| 项目 | B2 契约 |
| --- | --- |
| input/output/cacheRead/cacheWrite | 对符合条件的记录分别累计；不把缓存并入 input；不使用 totalTokens 代替四项 |
| assistant | 总是属于应检查记录；缺失或无效 usage 标记数据不完整，不默认为一次真实零消费 |
| toolResult | 只有携带 usage 才进入原生累计口径；无 usage 不能凭工具名推算价格，也不将每个普通本地工具视为一次未知收费 |
| compaction/branch_summary | 携带 usage 时累计；缺失时保留已知小计，费用标为不完整（`+?` 或 `?`），并在诊断记录摘要 usage 缺失；不猜测摘要是否实际调用了收费服务 |
| 缺失/非法数值 | 非负有限数才计入已知小计；缺失、负数、NaN、Infinity 记为该字段未知，不能只丢弃后仍展示完整总计 |
| 溢出 | 沿用安全上限思路，但饱和后标记 limited/partial；不把截断值当精确总数 |
| cost | 累计记录中的 cost.total，保留历史上报价格；不按当前模型价格重新计算，不查询余额/账单 |
| cost = 0 | 显式有效零保留；它是记录中的零估算，不能据此认定订阅或免费 |
| 费用缺失 | 全部未知显示 `?`；部分已知显示已知小计加 `+?`。即使记录覆盖完整，费用也可能不完整 |
| error/aborted | 只要有已报告 usage 就累计；不按 stopReason 删除费用，不重复累计重试前后同一 entry；没有持久化 usage 的失败请求无法恢复 |
| 数值比较 | token 使用精确安全整数 fixture；费用用容差比较，展示四舍五入不参与去重或账本校验 |

区分两个维度：**历史记录是否读全**与**记录是否报告了完整数值**。建议诊断公开 `scope`、`status`（loading/ready/partial/unavailable）、`updating`、session identity、已提交游标、重建原因/次数、已检查 entry 数、各字段缺失数、摘要缺失 usage 数、耗时与峰值待处理数量。不要输出消息正文、summary 文本或凭据。

只有记录覆盖完整且字段完整时才能显示没有 partial 标记的 session 数值。loading 显示未知；同一会话重建中可保留明确标成 updating 的旧快照；切到新会话立即撤掉旧值。API 不可用/读取失败时显式降级到带 observed 标签的数据，诊断保留请求范围与实际范围，不静默冒充 session。

### 上下文与 CH

B2 不扩展这两个字段为历史重建或实时估计：保留当前 observed 语义，加载/恢复后先显示 `?`，等待新观察；在帮助和 `/hud status` 明示它们与 session 合计的不同范围。

- `ctx(last)` 是当前模型最近可用 assistant 观察的 input + cacheRead + cacheWrite + output，沿用现有有效性判断；模型切换、压缩、观察期 reset/tree 切换使其失效。不是未发送草稿、工具输出追加后的当前估计。
- CH = cacheRead / (input + cacheRead + cacheWrite)，不是累计命中率；无缓存字段或分母为零显示 `?`。错误/取消观察不替换此前有效 CH，reset/模型切换/压缩清除。
- 原生 footer 的 CH 实际取全部 entries 中最后一个 assistant，未采用 HUD 的这些失效规则。因此即使累计值一致，CH 仍可不同。
- 由于 observed message_end 位于扩展替换链中，它反映 HUD 观察到的消息，不保证等于后续扩展最终写入的消息。B2 的**session 账本**必须读最终 manager entry；本轮不顺带重定义 observed 的既有行为。若后续要让 ctx/CH 也基于最终提交，应作为单独明确的契约变更。

## 更新、去重与生命周期方案

建议引入单独的 usage ledger 模块，不把历史总数塞进会被 reset 的工具状态。只使用公开只读 API，不访问 fileEntries/byId 私有成员、不 monkey-patch append 方法。

### 初始基线

1. session_start、从 observed 切入 session、off→on 安排一次可取消工作；事件回调只设置状态和安排任务，不同步遍历历史。
2. 任务在同一段无 await 的 JavaScript 中确认 session identity/generation，调用一次 getEntries 并读取 leaf，固定本次数组与基线游标。该数组是全部 entries，不是当前 branch。
3. 分片汇总该数组；建议起始参数为每片最多 512 条或约 2ms，先到者让出事件循环，B2 测量后记录实际选择。这些是候选参数，不是已取得的性能结果。
4. 暂时保留 SDK 返回的浅数组是 O(N) 引用内存，也会延长被引用记录的寿命；禁止复制正文、序列化历史、建全量 ID Set。完成、取消、off/shutdown 时释放数组。
5. 基线完成后从捕获的 leaf 追赶正常追加；确认 generation/session 未变后一次性替换汇总。不能把新基线再加到旧总量上。

### 正常追加

在 session 模式下增加 `turn_end` 核对触发，`agent_settled` 补最终核对。message_end 仅标记 pending/updating；不能在这个事件里通过延迟猜测落盘完成。保留现有 observed 消息处理，它写的是另一份观察期状态。

核对任务从当前 leaf 沿 `getEntry(id).parentId` 回走，直到上次已提交 leaf。先在临时标量中求增量，**找到锚点才提交**；成功后更新游标。同一 leaf 的重复事件没有增量。无须永久保存所有历史 ID，也不使用 128 条工具去重窗口来保障全会话正确性。

每次核对固定目标 leaf，后来的追加交给下一次；不按时间戳、内容、工具 call id 或模型名去重。基线已包含的记录被锚点截住，事件未提交的消息自然在下一个提交边界纳入。

候选增量上限 2048 条、按上述分片预算执行；通常成本为 O(新增条数)，不能称为严格 O(1)。缺 entry、链断裂、到达 root 却未遇锚点、循环/超过上限时，丢弃整批未提交增量，标记 partial，安排一次全量恢复重建。重复失败不得变成空闲重试循环；保留失败原因，等待新的生命周期/显式操作。空历史以 null 为合法基线；非空历史却 leaf 为 null 只在已观察树导航/重建后接受。

### 结构事件与取消

| 触发 | 处理 |
| --- | --- |
| session_start（含 resume/fork/reload/new） | 新 generation；丢弃旧任务/游标/快照，按新 manager 实际 entries 建基线 |
| session_tree | 使在途基线/增量失效，重新读取全部 entries；不把旧分支费用减掉；清 observed 的 ctx/CH 与活动统计 |
| session_compact | 使在途任务失效并重建；包含摘要 usage，保留压缩前累计；不直接加事件中的 compactionEntry |
| 压缩取消/失败 | 无成功 entry 就不虚构摘要费用；原账本保持，下一次可靠提交边界核对已有消息 |
| model_select | 累计跨模型保留；只使 observed 上下文/CH 失效；不按新模型重算历史费用 |
| surface/主题/宽度变化 | 只改视图，不重建历史 |
| /hud reset | reset 观察期；session 账本保留其定义，必要时重建核对，不变成 since-reset |
| off/shutdown/模式退出 | generation 递增，取消一次性任务、清临时引用；旧回调不得发布或修改新会话 |

分片期间的普通追加只标记 dirty，不取消整份基线；结构变化才取消并合并安排一个最新重建。事件处理保持快速，工作队列最多一个计划任务/一个活动任务，不建立轮询和空闲心跳。终端 render 只能读取已发布快照。

保证范围是经过锁定 SDK 验证的追加与生命周期。SDK 没有 append revision/所有修改通知；外部代码偷偷修改旧对象、绕过生命周期改树或写其他分支，不在可证明的增量保证内。检测到异常要降级重建，不能声称任意第三方扩展环境下完全一致。

## B2 验收与性能方案

### 正确性矩阵

- 以真实 SDK SessionManager + 按原生四类记录规则编写的独立 oracle 比较；不能仅用新账本自己的 reducer 同时算期望值。
- 首次空会话、已有长历史、resume、两种 fork 来源、新会话、reload、off/on、reset、反复切 surface/usageScope。
- assistant、收费 toolResult、无 usage 工具、压缩/branch summary、错误/取消、重试、未知/部分/零费用、非法数据与安全上限。
- 树导航有/无 summary、回 root、跨分支、多次相同 summary 文本的压缩；验证全部 entries 累计没有变成 branch 累计。
- 在 HUD 前后分别放置异步 message_end 替换扩展，最终账本与 manager 一致；turn_end 和 settled 重复通知不重计。
- 基线分片时追加消息、压缩、切树、切会话、off；旧 generation 永不发布；基线+增量无重叠；增量链异常不会发布半批结果。
- 用 getter 调用计数证明 render/逐 token 为零历史读取；稳定轮次不调 getEntries/getBranch/getContextUsage；无变化时 getEntry 为零，空闲无任务。
- 明确 loading/partial/updating/observed/session 的窄屏降级，不能因截断删掉唯一范围/不完整提示；保留中英、ASCII、配色、主题与固定行数。

### 测量设计

1k/10k/100k 条分别构造线性与分支 fixture，混合四类 usage 及无 usage 元数据。固定 seed、比例、内容大小、Node/CPU/OS、SDK lock hash、前后提交和 dirty 状态。fixture 构造和宿主加载成本单列，不混入 HUD 初始化时间；另测实际 SessionManager 加载后的 HUD 附加成本。

分别报告 getEntries 同步复制、汇总 CPU/总耗时、最大单片耗时、峰值及释放后 heap/RSS、重建和会话切换成本。用事件循环延迟/外部输入探针区分“让出后总耗时”与最长不可中断停顿；RSS 不能在同一繁忙进程里仅取一次前后差便认定为账本内存。

每个规模另测新增 1/32/2048 条的稳定核对。getEntries 调用数应保持零，成本应随新增条数而非已有历史增长；对超过上限的恢复路径单独测量。包括用户迅速切换会话时的取消释放，以及 rebuild 过程中持续追加的追赶成本。

继续执行现有门槛：hook p99 ≤250µs、未缓存渲染 p99 ≤5ms、缓存渲染均值 ≤5µs；后台重建不能藏进这些低耗时数字。参考现有同机交替 A/B 方法至少 8 组，报告绝对变化与相对变化。真实流式/工具/键盘验收仍按 PERFORMANCE.md 的至少 20 组交替方案，不能以微基准通过代替。

初始化尚无经认可的端到端预算：B2 必须公布三档测量和最大停顿，不能临时放宽门槛以宣布“无感”。若 getEntries 本身已超过期望响应预算，保持 session 可选并明确成本；分片不能补救这一步。默认 footer 的评估另开验收，不因 B2 单元测试通过自动切换。

## B1 本轮实际验证与限制（方案轮，2026-09-20）

- Node `v24.18.0`，Linux；隔离安装固定 Pi `0.85.1`、TypeScript `5.9.3`、Node types `22.19.19` 到被忽略的 `.tmp/sdk`。默认 npm cache 只读导致首次失败，改用 `/tmp/pi-hud-npm-cache` 后安装成功；没有修改根 package/lock，也未执行包安装脚本。
- `npm run check` 与 `git diff --check` 通过：仓库边界、语法、配置/schema/示例一致性、文档链接、生成预览和补丁空白检查。本轮无运行时代码改动，未重跑完整测试/性能/打包套件。
- `node scripts/sdk-check.mjs` 通过：现有事件/UI/usage/footer 契约。
- 额外临时 TypeScript 合约通过：getEntries/getEntry/getLeafId/getSessionId、turn_end、session_start reasons、compaction/tree usage、getAvailableProviderCount 的真实公开类型。
- 真实 SDK `SessionManager.inMemory` 探针通过：6 条 usage 记录（权重 1..6，依次为 assistant、toolResult、compaction、assistant、branch_summary、compaction），全历史 input/output/cacheRead/cacheWrite 为 21/42/63/84；切树后当前 branch 只有 3 条；正常追加到锚点的差量为 1 条；getEntries 返回不同数组；相同 summary 的 find 确实选旧压缩记录。探针无网络、模型或文件持久化。
- 上述临时合约/探针位于 `.tmp/sdk/b1-contract.ts`、`.tmp/sdk/b1-probe.mjs`，不作为产品代码交付。**（B2a 更新：探针已转录为仓库内可复现的 `scripts/usage-oracle-check.mjs`，并扩展了真实 SessionManager 生命周期用例；类型断言并入 `scripts/sdk-check.mjs`。）** B2 必须将必要断言转为仓库内可复现测试。本轮没有实现或测量候选 ledger，也未执行真实会话、流式 A/B 或完整长历史验收。

## B2a 实现状态（2026-09-20）

本节描述已交付的实现；性能与真实宿主验收仍未做，见下一节。

- `src/usage.ts`：独立账本模块，历史访问全部限制在 `/* history-boundary */` 标记内；`scripts/check.mjs` 仅对该边界白名单 `getEntries/getEntry/getLeafId/getSessionId`，`getBranch/getContextUsage` 处处禁止。
- 基线：事件回调只调度一次性可取消任务；任务在同一同步块确认 generation/sessionId，调用一次 `getEntries` 并捕获 leaf；每片最多 512 条或约 2 ms（先到者让出）；完成后从捕获 leaf 追赶增量，确认身份后一次性替换发布值；数组引用随即释放。追赶失败（含超过 2048 条）保留有效小计、记录缺口，并安排恰好一次恢复重建（恢复重建自身追赶再失败时不自我延续，缺口保留到下一个事件边界重试）。Pi 的 `resetLeaf()` 树导航（重编第一条用户消息）会保留历史并把 leaf 置空；该空游标是合法锚点，之后根级追加只计一次。
- 增量：`turn_end`/`agent_settled` 触发核对，`message_end` 仅标记 updating；从当前 leaf 沿 `parentId` 回走到已提交游标，临时标量聚合、找到锚点才提交；重复事件不重计；缺 entry、链断裂、到 root 未遇锚点、循环或超过 2048 条时整批丢弃、标记 partial 并安排恰好一次恢复重建，不形成空闲重试循环；恢复成功后清除失败记录。
- 生命周期：session_start（含 resume/fork/reload/new）、off、退出 session 口径都递增 generation 并丢弃任务/游标/快照；session_tree/session_compact 合并为一次重建；切 surface/主题/宽度不重建；`/hud reset` 保留账本并触发一次核对。
- 数值：四项 token 独立累计；非负有限数才计入，否则该字段计为未知（`+?`）；assistant 缺 usage 标记数据不完整；无 usage 的 toolResult 仅口径外；无 usage 的摘要保留 token 小计、费用计不完整；cost=0 为有效零；费用全未知显示 `?`；饱和显示 `limited*`。
- 展示：`sess*`（中文 `全会话*`）标签在最前，随后 `↻`（更新中，ASCII `~`）、`+?`（不完整）、`?`（装载中）、`limited*`（饱和）等紧凑标记**始终位于数值之前**，右缘截断先删数值，被裁剪的饱和值不会丢失提示；费用字段独立携带同样的 sess* 范围与状态标记（balanced widget 与窄屏 footer 不显示 token 字段时仍自描述，费用自身的不完整显示在数值后、其余不完整显示在标记上，不重复）；宿主缺少只读接口时显式降级为 observed 标签；诊断公开 status/updating/重建原因与次数/host 调用次数/字段缺失数/耗时等有界标量。二次追赶失败留下的覆盖缺口在下一次成功锚定核对提交该段记录时确认补齐并清除（真实字段缺失/饱和仍保持 partial）；补齐发布即使无待处理标记也会通知 UI。
- 验证：244 项测试（新增 46 项覆盖正确性矩阵及两轮评审修复）、独立 oracle、`scripts/usage-oracle-check.mjs`（真实 SessionManager + SDK 自带 usage-totals 作为 oracle，含 resetLeaf 回根与超限追加恢复场景）、固定 SDK 类型检查、`npm run verify`、`npm run package:check` 全部通过。详见 [VERIFICATION.md](VERIFICATION.md)。
- B2b 已执行（见文末“B2b 实测结果”）：长历史测量、稳态增量、同机交替 A/B、真实宿主（resume/压缩/树导航/双 footer）与流式验收全部完成；默认 footer 切换评估仍未进行。

## B2b 实测结果（2026-09-20，验收轮）

按“测量设计”全部执行；工具入库（scripts/usage-fixtures.mjs、usage-ledger-bench.mjs、usage-ledger-bench-run.mjs、usage-ab.mjs、usage-ab-run.mjs、usage-session-file.mjs、session-file-oracle.mjs、pi-host-acceptance.py、pi-stream-ab.py、tests/fixtures/*），原始 JSON 在 docs/ 下。

- **附挂成本**（真实 SessionManager，线性/分支）：1k 2.2/3.3ms、10k 20.8/23.9ms、100k 199/234ms（含 SDK 自身 O(N) getEntries 复制 2.05/2.37ms）。最大分片 0.25–0.67ms，预算 2ms 不变。100k 附挂最长事件循环停顿 3.3–6.9ms，主要成分为 SDK 复制+首片+一次 GC；分片不能补救 SDK 复制这一步（契约已明示）。
- **稳态增量**：每档 +1/+32/+2048 条，getEntries 新增调用恒为 0（断言）；账本内部增量 0.065–0.46ms，只随新增条数增长。超 2048 上限路径：丢弃整批、恰好一次恢复重建（1k 12.1–12.3ms、100k 208–245ms），failureReason 恢复后清空。恢复再失败路径在每档单独测量：6240 条跨基线与其恢复重建的追加在扰动期间产生可见失败/覆盖缺口，防自延续守卫保持为恰好一次恢复重建，下一个事件边界的锚定核对一次性补齐全部缺口（与 oracle 对齐）。切片期间的追赶在所有规模均被触发并验证。100k 基线进行中快速切会话：同步取消 16–30µs，旧 generation 不发布。
- **内存**：释放后保留 0.01–2.1MiB（含 V8 碎片影响）；峰值读数需要零工作对照窗口（同探针同时长无账本工作在压缩后堆上同样增长 54.9MiB）与沉淀 GC，单次 GC 前后差会把加载阶段垃圾归因到附挂阶段。
- **A/B**（review 轮重建）：8 组交替 observed/session：账本核对 +1.03µs、含 250ms 合并发布的完整轮 +1.94µs、sess* 渲染 +1.02µs、hook 与缓存路径不变；探针断言每轮恰好一次发布，结构证据在关机前采集；门禁未放宽且全部通过。
- **真实宿主**：9 场景全部通过与独立文件 oracle 精确对齐（10k 分支 resume、真实 read 工具轮次、同 summary 双压缩（SDK find(summary) 命中旧 entry 的边界真实发生）、树导航+回根+重追加、模型切换、快速切会话、双 footer 两种 -e 顺序（HUD 延迟配置挂载总是落在所有 session_start 之后，启动时拥有槽位；启动后手动接管→HUD 抑制不清除；/hud surface footer 重夺）、后置异步 message_end 替换扩展（账本按最终记录计数）。
- **真实 TUI 流式/工具/键盘 A/B**（review 轮重建）：20 对 × 2 配置（默认 observed+widget 与可选 session+footer）共 80 组；首内容/完成标记为原子首尾增量（42/152 个增量整），缺完成或 >25% 键盘超时即判失败；流中输入（8 键回显 + 退格 + 方向键）单独测；所有时间指标均在同机配对噪声包络内；按原始终端字节计，HUD 每轮约 +0.9–1.0 KiB、每次流式回复 +1.0 KiB（footer）至 +2.6 KiB（widget），另一次约 320–460 字节合并发布（完成后约 150ms），maxFlushMs 保持个位数毫秒。
- **修复**：accumulateUsage 每记录元组数组（100k 约 24MiB 垃圾）→ TOKEN_FIELDS 模块常量；/hud status 诊断新增 totals（有界标量，便于真实宿主对 oracle 核对）。
- **发现的上游事实**（非 HUD 缺陷）：Pi 0.85.1 原生 footer 对无 usage 的 assistant 消息会 addUsageToTotals(undefined) 崩溃，真实 provider 会话总是携带 usage，故仅影响含缺失 usage 的合成会话文件；验收夹具对这类记录注入确定性 usage。B2b 期间未放宽任何门槛，未切默认 footer。

核对文件的 SHA-256（用于后续确认审查版本，不替代依赖锁文件）：

```text
SDK package-lock.json  8a0902c7e9563f26eb73f346856a9f3cfc002c94a727ef4338209b96ed64fdda
agent-session.js      fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f
session-manager.js    ccace64949db25379a43971ecea750c1b7ec6344e1bc31b9d5fe596ac2f1c9f3
footer.js             05cc0ab96cbdacf15a34f4e2a9a3ee0395abaeaac638c1c153632cb0befbc9d1
```

## 可直接用于 B2 的 prompt

```text
/goal 实现 pi-hud 第三阶段 B2：显式可选的全会话用量账本。

先读 docs/HANDOFF.zh-CN.md 和 docs/SESSION-USAGE-CONTRACT.zh-CN.md，
核对当前代码、工作区改动和固定 Pi 0.87.1 SDK；按 B1 契约实现。

新增 usageScope: observed|session，默认 observed；保持 widget 默认。
session 覆盖当前 manager 全部 entries 的 assistant、带 usage 的 toolResult、
compaction、branch_summary，四项 token 独立累计，费用保留未知/部分/零语义。
ctx(last)、CH、工具分类保留明确的 observed 范围，不宣称原生 footer 完全等价。

采用独立账本：首次和结构边界全量重建；正常追加从公开 getLeafId/getEntry
追踪至已提交游标。message_end 不直接给 session 账本加 usage；在 turn_end /
agent_settled 等可靠边界核对最终已追加记录。验证后置异步消息替换扩展，
以及 SDK 相同 compaction summary 选旧事件 entry 的情况。

分片工作可取消，generation 隔离会话；基线和增量不重计，找不到锚点不提交
半批结果。保留 loading/partial/updating/降级诊断。不保存全历史 ID 集合、
不复制正文、不读会话文件，不在 render/逐 token/每轮调用 getEntries。
新增历史访问集中在专用模块；只调整 scripts/check.mjs 的精确边界白名单，
其他源文件继续禁止历史访问，增加调用次数和生命周期回归测试。

按 B1 正确性矩阵添加有意义的测试，并转录临时 SDK 探针为可复现验证。
同步配置/schema/example、SDK 合约、生成预览、中英 README/配置/架构/研究/
性能/验证文档，清理与本轮有关的过时统计表述，保留历史测量的适用版本。

运行 npm run verify、npm run package:check、固定 SDK/RPC/PTY 检查；
测量 1k/10k/100k 历史初始化/重建/切换的复制、CPU、最大停顿、内存与取消，
以及固定新增记录数的稳态成本，并完成至少 8 组同机交替微基准 A/B。
遵循 B1 性能边界，不放宽现有门槛，明确尚未执行的真实终端/流式验收。

不新增额度、recent、轮换工具名、独立 errors、todo 专用桥接；不改宿主，
不自动切默认 footer，不发布。实现后 review 并修复本轮引入的问题，
交付改动、验证证据、性能取舍和未解决限制。
```
