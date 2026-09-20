# pi-hud 开发交接

更新：2026-09-20（B2a 实现轮）。代码基线：B2a 提交 `feat: optional full-session usage ledger (phase 3 B2a)`（本提交即交接点）。
仓库：<https://github.com/M1racleShih/pi-hud>，继续使用 `main`。

## 当前完成情况

- 分字段语义片段布局与 pastel/theme/mono 配色，中文、ASCII、主题切换、窄屏上下文保留。
- 有界工具分类：16 个真实工具名与独立 overflow 桶，成功/失败/中断分别计数；真实名为 other 的工具不与溢出桶混用。
- 第三阶段 A：可选 footer 接管、surface 所有权与清理、缓存身份/标题/宿主 Git 分支、分项 token 和 CH、其他扩展状态的有界展示与独立更新。
- 第三阶段 B2a（本轮）：可选全会话 usage 账本。新增 `usageScope: observed | session`，默认 observed；`surface` 仍默认 widget。session 口径由独立模块 `src/usage.ts` 覆盖当前 SessionManager 全部 entries（assistant、带 usage 的 toolResult、compaction、branch_summary），分片可取消基线 + 已提交游标增量去重 + generation/会话隔离，缺失费用与 loading/partial/updating 显式标记，历史访问限制在标记边界内。详见 [全会话统计契约](SESSION-USAGE-CONTRACT.zh-CN.md) 与 [验证记录](VERIFICATION.md)。
- 默认仍为 widget + observed。widget 主体为 1/2/3 行，footer 主体为 2/3/4 行，footer 另有最多 2 行扩展状态。
- **B2a 只是实现轮**：长历史性能测量、真实宿主验收、默认 footer 评估都未做（见下方 B2b 待验清单）；不得把 B2a 完成表述为第三阶段 B 已全部验收。
- 最后一次 review 未发现可操作的回归问题。

## 用户明确的展示偏好（优先于旧规划）

1. 不恢复 recent 最近完成摘要，不新增对应开关或缓存。
2. 活动区只显示工作中 / 等待确认 / 就绪。模型响应、工具执行、收尾统一为工作中，直到 agent_settled 才显示就绪；不轮换 bash、edit 或文件目标，不靠轮询/延时动画维持稳定。
3. 不恢复独立 errors 汇总项。失败计数放在各工具分类的 ! 后；内部错误统计保留。
4. 用户已有 todo 插件显示任务进度，不需要为此新增 pi-goal/todo 专用桥接。footer 保留其他扩展 setStatus 的真实字符串。
5. 用户使用 pi-agent + @narumitw/pi-goal 开发，通常希望按阶段获得可直接粘贴的 /goal prompt，再进行 review 和修复。

旧设计中的“当前文件目标”“最近摘要”“独立 Errors”等要求已被以上偏好覆盖。历史验证记录描述测量当时的代码，不应当作当前 UI 规范。

## 验证证据与边界

- B2a 代码通过 npm run verify（239 项测试、仓库检查、性能门禁全不变）和 npm run package:check。
- 固定 SDK 检查全部通过：`node scripts/sdk-check.mjs`（含账本契约类型）、新增 `node scripts/usage-oracle-check.mjs`（真实 SessionManager + SDK 自带 usage-totals 作为独立 oracle，转录自 B1 探针）。RPC/PTY 冒烟本轮未重跑（无宿主边界变化）。
- B2a 覆盖 B1 正确性矩阵的仓库内测试与真实 SDK oracle；**未做** 1k/10k/100k 长历史测量、稳态增量成本测量、同机交替 A/B、真实宿主（resume/压缩/树导航/双 footer）验收与流式验收。
- 真实深浅色终端人工验收、流式/工具/键盘 A/B、真实会话统计对照、两个 footer 扩展的真实宿主共存、跨平台矩阵仍有待验项。

## B2b 待验清单（下一轮目标）

1. 长历史测量：1k/10k/100k 线性与分支 fixture，分别报告 getEntries 复制、汇总 CPU/总耗时、最大单片、峰值与释放后 heap/RSS、重建/切换成本、事件循环最长停顿（方案见契约“测量设计”）。
2. 稳态增量：每档新增 1/32/2048 条的核对成本；getEntries 保持 0 次；超上限恢复路径单独测。
3. ≥8 组同机交替微基准 A/B（session on/off）。
4. 真实宿主验收：长历史 resume、真实压缩（含相同 summary）、树导航、模型切换、双 footer 共存、快速切会话的取消释放；核对 /hud status 诊断。
5. 真实流式/工具/键盘验收：按 PERFORMANCE.md 至少 20 组交替。
6. 全部通过后再单独评估默认 footer 切换（不自动迁移配置）。

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

## 下一阶段：第三阶段 B2b，长历史性能与真实宿主验收

B2a（实现轮）已完成：`usageScope: observed | session`、独立账本模块 `src/usage.ts`、B1 正确性矩阵的仓库内测试与真实 SDK oracle、配置/schema/示例/SDK 合约/预览/中英文文档同步，以及 npm run verify、npm run package:check、固定 SDK 检查。契约与实现状态见 [全会话统计契约](SESSION-USAGE-CONTRACT.zh-CN.md)（含 B2b 待验清单）。

B2b 只欠测量与真实宿主验收，不再改口径设计；若实现问题暴露，按 B1 契约修复并同步测试与文档。上述 B1 约束仍然全部有效：

- Pi 原生统计包含所有 session entries 中 assistant、带 usage 的 toolResult、compaction、branch_summary；observed 不是同一口径，两种口径都要显式标注。
- getEntries 的全量数组构建、getContextUsage 的 branch/估算访问不是 O(1)。禁止在 render 或逐 token 路径调用（当前由 scripts/check.mjs 边界强制）。
- 首次加载与结构变化重建独立于稳态更新；message_end 在追加前且可被后置扩展替换，session 账本应在 turn_end/settled 边界读取已追加记录，用 getLeafId/getEntry 游标去重。压缩事件存在相同摘要命中旧 entry 的边界，采用 manager 重建。
- 分别验证恢复、压缩、树导航、模型切换、未知费用与取消；测量 1k/10k/100k 条记录初始化/重建成本（本轮未做）。
- provider 数量已有公开缓存 getter getAvailableProviderCount；自动压缩设置/订阅等仍缺完整对等的公开来源，不能伪造字段或宣称完全等价替换。
- 数据覆盖与真实验收通过之后，再评估默认 footer。未满足前保持 widget 默认。
- 不扩展到额度功能。后续顺序：公共额度基础 → 国内 GLM 个人/团队 → DeepSeek/硅基流动/MiniMax → Codex/Gemini → 六类整体验收。详见 [额度方案](PROVIDER-LIMITS-PLAN.zh-CN.md) 和 [GLM 作用域](GLM-PLAN-SCOPES.zh-CN.md)。

给新会话的接续提示：

```text
先读 docs/HANDOFF.zh-CN.md，核对 git status、当前代码和相关规划。
B2a 已实现并验证（见验证记录 Phase 3 B2a 一节），不要重做实现。
按 SESSION-USAGE-CONTRACT.zh-CN.md 的“B2b 待验清单”执行长历史测量、
稳态增量测量、≥8 组同机 A/B 和真实宿主验收；保持 observed 与 widget 默认，
不把测量计划当作已完成的性能结论，不切默认 footer，不新增额度功能。
```
