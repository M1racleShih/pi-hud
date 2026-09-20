# 默认 footer 决策记录（独立评估）

状态：**评估完成，结论为"当前不切换；有条件重评"**（2026-09-20）。本记录只整理证据与建议，未修改任何默认值、用户配置、schema 或代码。当前默认保持 `surface: widget` + `usageScope: observed`。

[交接](HANDOFF.zh-CN.md) · [视觉/footer 规划](VISUAL-FOOTER-PLAN.zh-CN.md) · [统计契约](SESSION-USAGE-CONTRACT.zh-CN.md) · [视觉验收手册](VISUAL-ACCEPTANCE.zh-CN.md) · [性能证据](PERFORMANCE.md)

## 问题

是否把 pi-hud 的默认 surface 从 `widget`（HUD widget + 原生 footer 并存）切换为 `footer`（接管原生 footer 槽位），以及是否连带把默认 `usageScope` 从 `observed` 切到 `session`。

## 结论

**基于当前证据，不建议现在切换默认。** 支持切换的技术面证据已经比较充分（数据口径可对齐、所有权生命周期已验证、稳态成本在噪声内），但存在两类未闭合项：感知层面（真人深浅色视觉验收未执行）与信息层面（原生 footer 的 `auto`/`sub`/`xp` 标记与实时上下文估计没有公开来源，接管后默认用户会少这些信息）。默认值影响所有安装，不应在缺口未获用户明确取舍前自动生效。

满足以下**全部**条件后重评（每一项都有明确的责任与证据形式）：

1. [视觉验收手册](VISUAL-ACCEPTANCE.zh-CN.md) 由真人执行完毕：深/浅 × 40/80/120/180 的 CP-A/CP-B 检查点通过，或未通过项被明确接受并有后续处理。
2. 对字段缺口做出**书面取舍**：要么接受"HUD footer 不显示 auto/sub/xp、上下文为 ctx(last) 快照"并写入文档；要么等待上游 Pi 提供公开来源后再补。
3. 跨平台矩阵（CI Linux/macOS/Windows × Node 22.19.0/24）至少运行一轮通过。
4. 剩余实时协议场景（流中 resize、测量中实时压缩、abort/重试、第二并发扩展 widget）补齐或明确豁免。
5. 由用户/所有者明确批准默认值变更（默认值变化属于发布决策，不是代码改进）。

若未来批准切换，建议**两步走且不连带**：第一步只切 `surface: footer`（保持 `observed` 默认），发布说明逐字段列出与原生 footer 的信息差异；观察一个使用周期后，再单独评估 `usageScope: session` 是否成为默认（它改变"默认不读历史"的既有承诺，见下文迁移影响）。本记录不包含任何自动迁移逻辑。

## 评估输入

### 1. 公开 SDK 字段来源与原生功能缺口

以下按 Pi 0.85.1 实际发布包核对（`dist/modes/interactive/components/footer.js`、`dist/core/footer-data-provider.d.ts`、`dist/core/session-manager.js`；核对哈希见 [统计契约](SESSION-USAGE-CONTRACT.zh-CN.md)）：

| 原生 footer 字段 | 公开来源 | HUD footer 现状 |
| --- | --- | --- |
| cwd（`~` 缩写） | `sessionManager.getCwd()` | 已接入（生命周期缓存，render 不查文件系统） |
| git 分支 | `footerData.getGitBranch()` / `onBranchChange()` | 已接入（复用宿主缓存；dirty 为独立可选探测） |
| 会话标题 | `getSessionName()` + `session_info_changed` | 已接入（初始化快照 + 事件，不逐帧调用） |
| 模型 / provider / thinking | `ctx.model` + 切换事件 | 已接入 |
| 四项 token + cost（全会话） | 仅遍历 `getEntries()`（原生 footer 自己每帧遍历） | `usageScope: session` 账本已对齐原生口径（oracle 验证）；`observed` 默认不含挂载前历史 |
| CH | 最后一个 assistant 的 cacheRead/(input+cacheRead+cacheWrite) | 已接入；失效规则比原生严格（模型切换/压缩/reset 清除），数值可能不同 |
| 实时上下文估计 | `getContextUsage()`（branch 访问 + 估算，非 O(1)） | **不接入 render 路径**；显示明确标记的 `ctx(last)` 快照，口径不同 |
| `(auto)` 自动压缩标记 | footer 私有状态（`setAutoCompactEnabled`），无公开 getter/事件 | **缺口**：无公开来源，不能伪造 |
| `(sub)` 订阅标记 | 内部 `modelRuntime.isUsingSubscription` + kimi 特例 | **缺口**：公开 `isUsingOAuth` 不等价订阅 |
| `xp` 实验标记 | `core/experimental` 的 `areExperimentalFeaturesEnabled()` | **缺口**：不在扩展公开契约中 |
| provider 数量 | `getAvailableProviderCount()`（公开、缓存标量） | 有来源但 HUD 未显示（原生仅在 >1 时显示 provider 名） |

结论：接管后 HUD 严格缺失 `auto`/`sub`/`xp` 三个标记与实时上下文估计；`ctx(last)` 与 CH 的口径差异只能靠显式标记传达，不能伪称等价替换。这正是 [视觉规划](VISUAL-FOOTER-PLAN.zh-CN.md) 一直坚持"显式启用、不宣称完全等价"的原因。

### 2. observed / session 口径

- `observed`（默认）：只累计挂载后观察到的 assistant usage；input/cacheRead/cacheWrite/output 四项分列；CH、ctx(last)、工具分类都是观察期口径。
- `session`（可选）：当前 manager 全部 entries 的 assistant、带 usage 的 toolResult、compaction、branch_summary，四项独立累计，费用保留未知/部分/零/饱和语义；与原生 footer 口径一致（B2b 以 SDK 自带 `createUsageTotals` 作独立 oracle 对齐；含相同 summary 压缩、树导航回根、异步消息替换等边界）。
- 两种口径都会继续存在的差异：CH 失效规则、`ctx(last)` vs 实时估计、工具分类永远是观察期。切换 surface 不改变账本，切换 scope 不重置账本。

### 3. 所有权与兼容性

- `ctx.ui.setFooter(factory)` 是单一替换槽。HUD 的所有权生命周期已验证：安装/释放、off/dispose 不清别人、刷新不抢回、显式 `/hud surface footer` 重夺、宿主 dispose 隔离旧回调；真实宿主两种 `-e` 顺序的双 footer 场景（9 场景中 2 项）通过。
- 风险：**默认接管会系统性提高槽位冲突概率**。现在默认 widget 不碰 footer 槽；一旦默认 footer，任何装有其他 footer 扩展的用户在升级后都会发现原生/对方 footer 被 HUD 替换。"显式启用"正是对该冲突的规避，切换默认等于放弃这层保护。
- 兜底：宿主无 `setFooter` 时回退 widget 并在 `/hud status` 记录原因；`/hud off` 在 HUD 仍持有槽位时恢复原生 footer。

### 4. B2b 性能与终端输出成本（实测输入）

- 挂载/重建（真实 SessionManager，session 模式）：1k ≈ 3 ms、10k ≈ 21–23 ms、100k ≈ 199–234 ms，全部后台分片执行；最大分片 0.23–0.70 ms（预算 2 ms）；100k 最长事件循环停顿 3.3–6.9 ms，主要成分是 SDK 自身 O(N) `getEntries()` 同步复制（独立实测 2.0–2.9 ms）。
- 稳态（session 模式边际）：每轮约 +1.0 µs 账本核对 + ~0.9 µs 合并发布，`sess*` 渲染 +1.0 µs；hook 与缓存路径不变；所有现有门槛未放宽。
- 每帧视角的一个 sourced 分析（非直接测量）：原生 footer 每次 `render()` 都遍历全部 entries 并调用 `getContextUsage()`——100k 历史下每帧仅 `getEntries()` 复制就要 ~2 ms 量级。HUD footer 接管后该每帧成本消失，改为事件边界的一次性/增量账本与缓存行渲染。即：在长历史上，HUD footer 的每帧成本低于原生 footer；但这是接管后的对比，不影响"是否默认"的感知验收要求。
- 原始终端字节（HUD 开 vs 关；关 = 原生 footer 在场）：每工具轮 +0.9–1.0 KiB；每次流式回复 +1.0 KiB（footer 配置）至 +2.6 KiB（widget 配置）；完成后约 150 ms 一次 320–460 B 的合并发布。注意 widget 模式是叠加输出（HUD widget 与原生 footer 同时重绘），footer 模式是替换输出，净字节不一定更高。
- 80 组真实 TUI 流式/工具/键盘 A/B（两种配置各 20 对）：所有时间指标在同机配对噪声包络内。

### 5. 迁移影响（若未来切换）

- **信息变化（所有默认用户可感知）**：新增工具分类、活动状态、分项 token/CH、palette、扩展状态区、（可选）session 口径；缺失 `auto`/`sub`/`xp`、实时上下文估计；`ctx(last)`/CH 口径差异需要用户重新理解。
- **垂直空间**：原生 footer 2 行（有扩展状态时 3 行）；HUD footer 主体 minimal 2 / balanced 3 / full 4 行 + 最多 2 行状态区（上限 6 行）。minimal 与原生相当，full 明显更高。
- **槽位冲突**：见上文第 3 节；装有其他 footer 扩展的用户需要显式设置回 `surface: widget`（兼容模式保留）。
- **工程面**：默认值变化会同步 `DEFAULT_CONFIG`、`docs/config.schema.json`、`examples/pi-hud.json`（`scripts/check.mjs` 断言三者一致）、`docs/preview.txt`、中英文 README/CONFIGURATION 与发布说明；无用户配置迁移（显式配置自然覆盖默认）。
- **usageScope 连带切换的额外代价**：默认引入历史读取（放宽项目"默认不扫描历史"的既有承诺）；100k 历史挂载约 0.2 s 后台成本与 2–3 ms 的首次同步复制停顿；即使批准 footer 默认，也建议 session 默认另评、不连带。

### 6. 尚缺证据（阻断项即结论第 1–4 条）

- 真人深/浅色 × 40/80/120/180 的视觉验收（含 footer 模式与原生对照）：手册已备好（[VISUAL-ACCEPTANCE.zh-CN.md](VISUAL-ACCEPTANCE.zh-CN.md)），未执行。pastel 浅色变体目前只有合成检查，没有真实浅色终端观察。
- 跨平台矩阵未运行（仅本机 Linux）。
- 剩余实时协议场景未覆盖：流中 resize、测量中实时压缩、abort/重试、第二并发扩展 widget。
- 订阅（`(sub)`）用户的实际缺失影响无法本地复现（不使用付费 provider、无法构造订阅态）。
- 长期使用下的观感（数周尺度）没有任何数据。

### 7. 建议行动（均不自动执行）

1. 用户执行视觉验收手册并填写结果记录；结果作为重评的直接输入。
2. 对 `auto`/`sub`/`xp`/实时上下文缺口做书面取舍；如选择等待上游，向上游提出公开来源需求（宿主提供缓存摘要/设置通知是 [视觉规划](VISUAL-FOOTER-PLAN.zh-CN.md) 已描述的严格路径）。
3. 运行 CI 跨平台矩阵。
4. 补齐或豁免剩余实时协议场景。
5. 全部满足后由所有者批准单独的"默认切换"变更：先 `surface: footer`（保持 observed），发布说明逐字段列出信息差异；一个使用周期后再单独评估 `session` 默认。

## 与其他文档的关系

- [HANDOFF](HANDOFF.zh-CN.md) 的"默认仍为 widget + observed"在本记录后继续有效。
- [VERIFICATION](VERIFICATION.md) 的待办清单继续把默认切换列为未执行事项；本记录是其"Default-footer evaluation"条目的展开。
- 本记录不伴随任何代码、配置、schema 或生成预览的变更。

## 追加：重评条件处置记录（2026-09-20，所有者决定）

- **条件 1（视觉验收）：闭合。** 观察者精简执行核心项并确认无问题（转录见 [VISUAL-ACCEPTANCE-RESULTS.zh-CN.md](VISUAL-ACCEPTANCE-RESULTS.zh-CN.md)）；所有者明示接受当前覆盖度，未覆盖项（宽度逐档、浅色真实会话、B6 逐字段对照、部分状态）按"未通过项被明确接受"处理。
- **条件 2（字段缺口）：闭合。** 所有者书面接受：HUD footer 接管模式下不显示 `auto`/`sub`/`xp` 标记，上下文为 `ctx(last)` 快照而非实时估计。不伪造字段；未选择向上游提需求，如未来改变主意可另行提出。
- **条件 3（跨平台矩阵）：闭合。** 所有者授权解除"不推送"约束后推送；首轮 Windows 两 job 因 CRLF 检出导致 preview 字节校验失败，`c0f0948` 以 `.gitattributes` 强制 LF 检出修复；运行 35541018928 全部 8 个 job 通过（ubuntu/macos/windows × Node 22.19.0/24、性能门禁、Pi 0.85.1 契约与 RPC 检查）。
- **条件 4（剩余实时协议场景）：已闭合（2026-09-20）。** `scripts/pi-live-scenarios.py` 在真实 TUI 中验证流中 resize（两种 surface）、流中 /compact、Esc 中止/重试与第二扩展并发 widget 共 5 个场景，全部与文件 oracle 对齐（`docs/live-protocol-scenarios.json`）；期间发现并修复的是测试基建问题（fixture 现在尊重宿主中止信号；连续 /hud status 的 PTY 陈旧帧解析陷阱），生产源码无需变更。
- **条件 5（所有者批准默认切换）：未闭合。** 默认保持 `surface: widget` + `usageScope: observed` 不变；满足后仍需单独的批准变更（两步走且不连带）。
