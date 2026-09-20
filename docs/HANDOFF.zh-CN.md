# pi-hud 开发交接

更新：2026-09-20（B2b 验收轮 + review 修复轮）。代码基线：B2b 交付提交之上叠加 review 修复（四项证据缺陷重建，src 无需改动）；修复后停在 B2b 评审点。
仓库：<https://github.com/M1racleShih/pi-hud>，继续使用 `main`。

## 当前完成情况

- 分字段语义片段布局与 pastel/theme/mono 配色，中文、ASCII、主题切换、窄屏上下文保留。
- 有界工具分类：16 个真实工具名与独立 overflow 桶，成功/失败/中断分别计数；真实名为 other 的工具不与溢出桶混用。
- 第三阶段 A：可选 footer 接管、surface 所有权与清理、缓存身份/标题/宿主 Git 分支、分项 token 和 CH、其他扩展状态的有界展示与独立更新。
- 第三阶段 B2a：可选全会话 usage 账本（`usageScope: observed | session`，默认 observed；独立模块 `src/usage.ts`）。
- 第三阶段 B2b（本轮）：**长历史性能实测与真实宿主验收已完成，并经一轮 review 修复四项证据缺陷后重建受影响证据**。1k/10k/100k 线性+分支夹具实测（固定 seed/比例/内容大小）；稳态增量、超限恢复（含恢复再失败）、重建/切换/取消实测；8 组同机交替 observed/session A/B（完整轮含 250ms 合并发布，断言每轮恰好一次发布）；真实 TUI 中 9 场景验收（10k resume、同 summary 双压缩、树导航/回根、模型切换、基线在途时快速切会话、双 footer 两种加载顺序、后置异步 message_end 替换扩展）全部与独立文件 oracle 对齐；20 对 × 2 配置（默认 observed+widget 与可选 session+footer）共 80 组真实 TUI 流式/工具/键盘 A/B，含流中输入与配对噪声包络。原始数据与结论见 [性能证据](PERFORMANCE.md)、[验证记录](VERIFICATION.md) 与 docs/ 下四份 JSON。
- B2b 修复：`accumulateUsage` 每条记录分配元组数组（100k 重建约 24 MiB 垃圾）→ 提升为模块级常量；`/hud status` 诊断新增已发布 totals，便于真实宿主与独立 oracle 对齐。review 轮另修复四项测量缺陷（A/B 从不触发 250ms 发布、fast-switch 未命中在途基线、流式探针标记/超时/完成语义、组数与负载不足），仅重建受影响证据，详见 VERIFICATION.md 的 review round 一节。
- 默认仍为 widget + observed。widget 主体为 1/2/3 行，footer 主体为 2/3/4 行，footer 另有最多 2 行扩展状态。
- 最后一次 review 未发现可操作的回归问题。

## 用户明确的展示偏好（优先于旧规划）

1. 不恢复 recent 最近完成摘要，不新增对应开关或缓存。
2. 活动区只显示工作中 / 等待确认 / 就绪。模型响应、工具执行、收尾统一为工作中，直到 agent_settled 才显示就绪；不轮换 bash、edit 或文件目标，不靠轮询/延时动画维持稳定。
3. 不恢复独立 errors 汇总项。失败计数放在各工具分类的 ! 后；内部错误统计保留。
4. 用户已有 todo 插件显示任务进度，不需要为此新增 pi-goal/todo 专用桥接。footer 保留其他扩展 setStatus 的真实字符串。
5. 用户使用 pi-agent + @narumitw/pi-goal 开发，通常希望按阶段获得可直接粘贴的 /goal prompt，再进行 review 和修复。

旧设计中的“当前文件目标”“最近摘要”“独立 Errors”等要求已被以上偏好覆盖。历史验证记录描述测量当时的代码，不应当作当前 UI 规范。

## 验证证据与边界

- B2b（本轮）已通过：npm run verify（244 项测试、仓库检查、性能门禁全不变）、npm run package:check、固定 SDK 检查（sdk-check、usage-oracle-check）、RPC/PTY 冒烟、长历史基准（docs/performance-b2b-ledger.json）、8 组交替 A/B（docs/performance-b2b-usage-ab.json）、真实宿主 9 场景（docs/host-acceptance-b2b.json）、20 组真实 TUI 流式/工具/键盘 A/B（docs/pi-stream-ab-b2b.json）。
- B2b 关键实测结论：附挂 3.1/3.3ms（1k）→ 20.9/23.1ms（10k）→ 202/231ms（100k，含 SDK 自身 2.0–2.9ms 的 O(N) getEntries 同步复制）；分片最大 0.23–0.70ms（预算 2ms 不变）；稳态增量只随新增条数增长且 getEntries 保持 0 次；session 模式稳态边际成本约 +1.0µs 账本核对 + ~0.9µs 发布/轮，另 ~1.0µs/次 sess* 渲染；真实 TUI（两种配置各 20 对）所有时间指标均在同机噪声包络内，唯一确定性成本为每轮一次约 185–235 字节的合并 footer 发布（完成后约 150ms）。
- 仍未验（不得宣称）：真人深浅色终端视觉验收、跨平台矩阵、真实付费 provider 流式 A/B（明确不使用付费 provider）、流中 resize/压缩/中止重试等剩余实时场景。
- 默认 footer 切换评估仍未进行：widget + observed 保持默认，B2b 数据只是该决策的输入。

## B2b 之后的待验清单（评审点）

1. B2b 评审：本轮改动（验收工具入库、TOKEN_FIELDS 修复、totals 诊断、文档与原始数据）与人观察项清单。
2. 真人深浅色终端视觉验收（需要人工观察，PTY 不能替代）。
3. 跨平台矩阵（CI 运行 Linux/macOS/Windows × Node 22.19.0/24）。
4. 默认 footer 切换单独评估（不自动迁移配置；输入为 B2b 实测数据）。

## 另一台电脑恢复

首次拉取：

```sh
git clone git@github.com:M1racleShih/pi-hud.git
cd pi-hud
```

已有 checkout：先检查并妥善保存本机改动，再更新，不使用 reset --hard：

```sh
git status --short
git switch main
git pull --ff-only origin main
```

要求 Node >=22.19.0；本机最近使用 Node 24.19.0。验证与试用：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
npm run package:check
pi -e /absolute/path/to/pi-hud/index.ts
```

将绝对路径替换为新电脑实际路径。已经用 pi install 注册时不要再以 -e 重复加载；已有 Pi 会话执行 /reload。
Pi 内可用 `/hud surface footer`、`/hud surface widget`、`/hud off`、`/hud status`。
命令修改仅在内存中，持久配置参考 [配置说明](CONFIGURATION.md)。

宿主 SDK 位于被忽略的 .tmp/sdk，不随 Git 同步。需要宿主检查时按 [开发流程](DEVELOPMENT.md) 安装锁定 Pi 0.85.1 SDK，并执行 sdk-check、usage-oracle-check、pi-rpc-smoke、pi-pty-smoke。
用户级 Pi 配置、provider 凭据、pi-goal 安装和会话状态也不由本仓库同步；不要将这些内容提交到 Git。

## 下一阶段：B2b 评审，之后是视觉验收与默认 footer 评估

B2b（验收轮）已完成：全部测量与真实宿主验收脚本入库可复现（见“验证证据与边界”），两处最小 src 修复（TOKEN_FIELDS 分配、totals 诊断）。B1 契约约束仍然全部有效：

- Pi 原生统计包含所有 session entries 中 assistant、带 usage 的 toolResult、compaction、branch_summary；observed 不是同一口径，两种口径都要显式标注。
- getEntries 的全量数组构建、getContextUsage 的 branch/估算访问不是 O(1)。禁止在 render 或逐 token 路径调用（当前由 scripts/check.mjs 边界强制）。100k 实测：SDK 自身 O(N) 复制约 2.1–2.4ms，是附挂最长停顿的主要成分，分片无法补救这一步（B1 契约已明示）。
- 首次加载与结构变化重建独立于稳态更新；message_end 在追加前且可被后置扩展替换，session 账本在 turn_end/settled 边界读最终记录（真实宿主异步替换场景已验收）。压缩事件存在相同摘要命中旧 entry 的边界（真实宿主同 summary 场景已验收）。
- provider 数量已有公开缓存 getter getAvailableProviderCount；自动压缩设置/订阅等仍缺完整对等的公开来源，不能伪造字段或宣称完全等价替换。
- 数据覆盖与真实验收已通过；默认 footer 评估单独进行，不自动迁移，当前保持 widget 默认。
- 不扩展到额度功能。后续顺序：公共额度基础 → 国内 GLM 个人/团队 → DeepSeek/硅基流动/MiniMax → Codex/Gemini → 六类整体验收。详见 [额度方案](PROVIDER-LIMITS-PLAN.zh-CN.md) 和 [GLM 作用域](GLM-PLAN-SCOPES.zh-CN.md)。

给新会话的接续提示：

```text
先读 docs/HANDOFF.zh-CN.md，核对 git status、当前代码和相关规划。
B2b 验收轮已完成：长历史/稳态/A-B/真实宿主/流式验收全部入库可复现，
见 PERFORMANCE.md 与 VERIFICATION.md 的 Phase 3 B2b 一节；不要重做。
下一步是 B2b 评审、真人深浅色终端视觉验收与默认 footer 单独评估；
保持 observed 与 widget 默认，不新增额度功能，不发布不推送。
```
