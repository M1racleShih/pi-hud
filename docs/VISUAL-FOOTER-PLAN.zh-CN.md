# 视觉层次与原生 footer 整合方案

状态：待实现；2026-09-19。依据：用户对比截图、当前 pi-hud 源码、本地 Pi 0.85.1 SDK 的实际实现。本文是优化设计，不代表功能已经上线或性能已经验证。

## 目标与结论

优先改善分字段配色、信息组织和活动可读性，再让 pi-hud 成为统一 footer。最终默认安装后只出现一套状态信息；关闭 HUD 恢复 Pi 原生 footer。保留 widget 兼容模式供其他 footer 扩展共存。

颜色以用户随后提供的 Codex status line 截图为明确参考：模型浅黄、路径浅绿、分支浅蓝、阶段淡紫、上下文桃橙，使用灰色圆点分隔。下面色值是接近截图的候选值，不是对 Codex 或终端配置的源码取值；最终以用户终端的实际显示验收。

## 截图中的差距

| 维度 | 当前 pi-hud | 建议 |
| --- | --- | --- |
| 色彩层次 | 首行整体跟随 context 色；历史工具错误使第二行整体变黄 | 模型、正文、标签、分隔符、状态分别着色；警告仅作用于相关字段 |
| 状态重复 | HUD 与原生 footer 同时展示模型、上下文、费用 | 使用正式 footer 替换接口，只展示一次 |
| 活动可读性 | `tools* ✓20 !1` 只有总数，难以看出做了什么 | 增加有上限的工具分类计数与当前目标，优先显示活动工具 |
| 数据覆盖 | 只有项目短名，缺会话标题、provider、独立缓存统计 | 合并原生 footer 的身份和用量字段 |
| 信息口径 | `ctx(last)`、`est*`、`tools*` 多处星号占据视线 | 保留必要的 `last`/`observed`/`partial` 标记，解释放入帮助和诊断 |
| 宽度利用 | 只用竖线拼接，优先级和分组不明显 | 按身份、上下文、活动、用量组织；宽屏可左右对齐，窄屏按优先级折叠 |
| 完整布局 | 无桥接活动仍显示空占位、零压缩等低价值内容 | 无数据时不输出虚假能力；预留固定行可显示最近活动摘要 |

Claude HUD 截图值得借鉴的是局部色彩、工具分类和活动目标，不必复制所有内容。截图中的部分次要文字对比度也偏低；MCP/hooks 数量和权限模式属于宿主能力，Pi 未提供可靠数据时不模拟。

截图中耗时对比衡量的是不同执行路径，不能据此证明视觉升级后无延迟，也不能把进程启动时间当成终端输入延迟。

## 配色与排版

将 `HudRow { text, tone }` 演进为有上限的语义片段，例如 `{ text, role, priority }`。先按纯文本显示宽度分配空间、截断，再对最终片段着色。缓存最终 ANSI 行，不能在每个流式帧重新拼装片段。

| 角色 | 建议视觉 |
| --- | --- |
| 模型与 thinking | 浅黄，候选 `#E5C890` |
| 项目/路径 | 浅绿，候选 `#A6D189` |
| Git 分支 | 浅蓝，候选 `#8CAAEE` |
| 正常阶段、当前活动 | 淡紫，候选 `#CA9EE6` |
| 正常上下文 | 桃橙，候选 `#EF9F76`；表示字段身份，不表示告警 |
| 普通正文、用量数值 | 灰白，候选 `#C6D0F5` |
| 标签、provider、分隔符 | 次要灰色，候选 `#838BA7`；不把主要数值全部 dim |
| 完成标记 | 局部绿色 |
| 等待确认、上下文高占用 | 局部黄色 |
| 当前失败、错误计数 | 局部红色；历史错误不染黄整行 |
| 上下文进度条 | 已用段桃橙、未用段弱灰；低占用仍有清晰百分比；高占用加文字/符号提示并切换警告色 |

提供 `palette: pastel | theme | mono` 的候选配置：默认 `pastel` 按截图分配柔和多色，`theme` 跟随宿主，`mono` 无颜色。保留 `color: false` 和 ASCII 路径。上述色值针对截图的深色背景；浅色背景需要更深的同色系变体，不修改终端背景或全局 Pi 主题。分组优先用灰色 `·` 与留白，减少连续竖线。

统一 footer 的 balanced 草图如下，数值仅作示意：

```text
GLM-5.3 max · ~/opensource/pi-hud · main             Compare HUDs
Context(last) ░░░░░░░░░░ 2.8% / 1.0M    ↑35k ↓8.3k R355k CH98.1% $0.178
✓ Ready · Bash ✓14 · Edit ✓3 · Write ✓2 · Errors 1
```

活动时最后一行以 `● Bash` 或 `● Edit src/render.ts` 开头。默认不显示 shell 命令、提示词和工具输出；文件目标沿用现有净化和长度限制。

参考截图的单行视觉顺序为 `模型 thinking · 路径 · 分支 · 阶段 · 上下文`。三行布局沿用相同的字段颜色与阅读顺序，再容纳会话标题、provider 和用量；不因增加信息而回到整行统一色。正常阶段保持淡紫，只有成功标记为绿、等待为黄、失败为红。

统一 footer 的 balanced 为 3 行，替代目前 2 行 HUD 加 2 行原生 footer。minimal 采用 2 行精选信息，full 最多 4 行并容纳已接入的 agents/tasks；其他扩展状态另有明确的有界展示区。widget 模式保留原来的 1/2/3 行规格。行数在活动切换时保持稳定。

80 列优先保留模型、项目、上下文、当前活动和错误提示；会话长标题、完整路径、provider、缓存细分逐级折叠。40 列保留短模型名、上下文和状态。隐藏的细节可从 `/hud status` 查询。中文、emoji、ANSI、零宽字符都按显示列宽处理。

## 黄色框：正式接管原生 footer

Pi 0.85.1 的 `ctx.ui.setFooter(factory)` 会替换默认 footer；`setFooter(undefined)` 恢复默认。无需清屏技巧或修改 Pi 安装文件。

候选配置为 `surface: footer | widget`。完成数据覆盖和验收后默认 `footer`，此时不再注册重复 widget；`placement` 只对 widget 模式有效。运行时不支持该接口则退回 widget，保留原生 footer 并报告原因。

| 原生信息 | 获取与更新策略 | 注意事项 |
| --- | --- | --- |
| 工作目录 | 生命周期中的 cwd，缓存缩略路径 | 不在 render 查询文件系统 |
| Git 分支 | `footerData.getGitBranch()`，订阅 `onBranchChange()` | 复用宿主缓存，不为显示分支另启 Git；dirty 状态仍是独立可选探测 |
| 会话标题 | 初始化快照 + `session_info_changed` | `getSessionName()` 当前也会访问历史，禁止逐帧调用 |
| 模型/provider/thinking | ctx.model、现有切换事件 | provider 字段不要只保存为内部 modelKey |
| input/output/cacheRead/cacheWrite/cost | 见下文统一用量快照 | 不能沿用当前包含缓存的 input 再另外累加缓存 |
| CH 命中率 | 最近 assistant 的 cacheRead / (input + cacheRead + cacheWrite) | 分母为零显示未知；不是累计 token 的命中率 |
| 上下文 | 默认保留明确标记的 last 快照；完整宿主估计需缓存接口 | 不把 last 快照标成与原生估计完全相同 |
| auto-compaction、subscription、实验标记 | 经核对的宿主只读快照/通知 | 当前扩展上下文没有完整对等接口，不能硬编码 `(auto)` 或猜测订阅 |
| 其他扩展 `setStatus` | `footerData.getExtensionStatuses()` | 接管后仍需展示；必须验证独立状态更新能使 HUD 缓存失效 |

`setFooter` 是单一替换槽，并非可叠加注册器。兼容模式用于用户已有其他 footer 的情况；释放时通过 factory 返回组件的 dispose 管理所有权、取消订阅，避免旧控制器恢复默认时覆盖后来安装的 footer。实际覆盖、关闭、重载顺序必须在真实宿主测试。

## 数据完整性与性能的真实约束

本地 SDK 已确认：

1. 原生 `FooterComponent.render()` 遍历所有 `sessionManager.getEntries()`，累计 assistant、带 usage 的 toolResult、compaction、branch_summary。
2. `getEntries()` 本身执行 filter 并创建数组；“每次取全量数组、只处理新增尾部”仍有 O(N) 成本。
3. `getContextUsage()` 访问 branch 并估算上下文，不能当成 O(1) getter。
4. 当前 pi-hud 只累计启用后观察到的 assistant usage，且 input 已合并 cacheRead/cacheWrite。其数值不是原生 footer 全会话统计。

因此，不存在“直接换 UI 就能零成本无损接管所有字段”的结论。推荐采用以下两层方案：

**严格低开销路径：宿主提供缓存摘要。** 在 Pi 内维护带 revision 的 footer 快照，包含分项用量、上下文来源与估计值、标题、设置标志、扩展状态变化通知。历史加载时建立汇总，记录追加时增量维护，切换会话时替换快照。pi-hud 只读摘要，在合并发布时更新。此接口属于拟议的宿主改进，Pi 0.85.1 尚未提供，不能在当前实现里假设存在。

**现有 SDK 兼容路径：明确有限的重建。** 首次接入/恢复会话时在非渲染路径读取一次历史并建立标量汇总，随后由经过核对的事件增量更新，必要时在会话结构变化后重建。原生口径包含所有记录，不可改用当前 branch 冒充全会话。要核对事件与落盘顺序、compaction/branch summary/tool usage 的覆盖，防止基线与事件重复计数。

兼容路径会放宽项目当前“不扫描历史”的约束，需要在实现和架构文档中明确记录。异步调度或分块循环不能消除 `getEntries()` 首次同步复制的成本；长历史下若超过预算，就不能作为严格性能配置的默认路径。完整累计尚不可用时显示 loading/partial/observed，不能显示伪精确数值或零值。

第一版视觉优化不依赖宿主改动。默认接管 footer 的最终验收则要求：需要保留的原生字段有可靠来源，历史口径明确，扩展状态不会因缓存丢更新。宿主接口暂不可用时可先交付明确标识的兼容模式，不将它宣传为完全等价替换。

## 保持低开销的实现边界

- 不增加逐 token/逐工具输出监听、动画、轮询、网络请求或默认 Git 进程。
- 沿用 250ms 合并发布；终端 render 不读取历史、不做 I/O。宽度、主题、状态版本均未变时返回同一缓存数组。
- 工具分类最多 16 个名称，其他合并为 other；活动记录沿用已有上限，最多展示 3 个目标。无历史工具重放。
- 每行片段数量有固定上限；预先缓存净化字符串与显示宽度。历史错误只更新对应片段。
- footer 的 extension status 变化必须有独立失效策略。现有 readonly provider 没有 status-change 订阅；不能仅凭 Map 身份判断未变，也不能假设 branch 通知涵盖 status。先验证宿主 invalidate 路径，否则需要宿主 revision/通知或明确有界的比较策略。
- 禁用、重载、会话切换清理计时器、订阅和旧视图；主题失效正确重算。RPC 保持零终端 UI 操作。

## 实施顺序与验收

1. **P0：分字段配色。** 修改 render 的中间表示和纯文本布局，提供 pastel/theme/mono 预览，默认 pastel 对齐用户 Codex 截图。修复整行警告色、弱对比和重复标签。保留现有 widget 行为，先验证视觉与渲染成本。
2. **P1：数据适配与 footer 接管。** 扩展 PiUi 类型、增加 surface 生命周期、缓存 Git/标题/provider，拆分用量字段，保留其他扩展状态。完成历史统计和设置字段的数据来源后，将 footer 设为默认；off 恢复原生。
3. **P2：活动表现。** 有界工具分类统计、当前文件目标、最近完成摘要；有桥接活动才展示 agents/tasks。与已存在的套餐额度方案共用布局优先级，余额/额度依旧使用独立数据源，不与会话 cost 混合。

相关变更预计涉及 `src/render.ts`、`src/state.ts`、`src/extension.ts`、`src/config.ts`、配置 schema、SDK 合约检查、生命周期/渲染测试、bench 和中英文使用文档。

验收要求：

- 色板：真实深色/浅色终端下检查 40/80/120/180 列；覆盖长路径、中文、emoji、颜色关闭、ASCII、主题切换。无越界、状态抖动和关键信息低对比。
- 数据：对同一会话逐项核对原生与整合后统计，包括恢复旧会话、压缩、树导航、tool usage、改模型、改标题、未知费用；不同口径必须明确标记。
- 生命周期：安装后只一套 footer；off 恢复原生；reload 无重复订阅；其他扩展 setStatus 独立更新；已有 footer 覆盖顺序；不支持接口时正确回退。
- 微基准：保留 hook p99 ≤250µs、完整未缓存渲染 p99 ≤5ms、缓存渲染均值 ≤5µs 的现有门槛。对新增三/四行 footer 单独建场景；同机交替运行修改前后，报告绝对值与相对变化，不能仅以低于宽松门槛判定无回退。
- 长会话：1k/10k/100k 记录分别测初始化、重建和切换的事件循环停顿、CPU/RSS。完整历史模式的启动成本单列，不混入 steady-state render。
- 真实 TUI：按照 PERFORMANCE.md 做至少 20 组交替 A/B，测流式输出、工具调度、输入回显和重绘字节；p95 输入/调度差异应在噪声范围内，暂沿用新增 ≤2ms/≤1ms 的候选目标。数值是验收目标，不是已取得的结果。

## 依据

- 项目：`src/render.ts`、`src/state.ts`、`src/extension.ts`、`docs/PERFORMANCE.md`。
- 本地安装的 `@earendil-works/pi-coding-agent@0.85.1`：`dist/core/extensions/types.d.ts`、`dist/core/footer-data-provider.d.ts`、`dist/core/session-manager.js`、`dist/core/agent-session.js`、`dist/modes/interactive/components/footer.js`、`examples/extensions/custom-footer.ts`。这些本地包文件用于核对，不提交到仓库。
- [Pi footer 扩展槽的组合性讨论](https://github.com/earendil-works/pi/issues/4262)：辅助说明多个 footer 扩展的覆盖问题；具体 API 以本地固定版本为准。

本方案将改变 ARCHITECTURE.md 中“保留原生 footer、不扫描历史”的既有决策。实施时必须同步修订该文档及 RESEARCH/CONFIGURATION/README，区分严格缓存路径和兼容重建路径，避免对外仍宣称所有模式完全不访问历史。
