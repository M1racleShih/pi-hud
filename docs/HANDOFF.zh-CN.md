# pi-hud 开发交接

更新：2026-09-20。代码基线：`07ea9d5`（稳定活动状态）；本文件随后的文档提交为交接点。
仓库：<https://github.com/M1racleShih/pi-hud>，继续使用 `main`。

## 当前完成情况

- 分字段语义片段布局与 pastel/theme/mono 配色，中文、ASCII、主题切换、窄屏上下文保留。
- 有界工具分类：16 个真实工具名与独立 overflow 桶，成功/失败/中断分别计数；真实名为 other 的工具不与溢出桶混用。
- 第三阶段 A：可选 footer 接管、surface 所有权与清理、缓存身份/标题/宿主 Git 分支、分项 token 和 CH、其他扩展状态的有界展示与独立更新。
- 默认仍为 widget。widget 主体为 1/2/3 行，footer 主体为 2/3/4 行，footer 另有最多 2 行扩展状态。
- 统计仍为本次观察范围，不扫描历史；上下文是 last 快照，费用是估算。尚未实现全会话历史统计，也没有默认接管 footer。
- 最后一次 review 未发现可操作的回归问题。

## 用户明确的展示偏好（优先于旧规划）

1. 不恢复 recent 最近完成摘要，不新增对应开关或缓存。
2. 活动区只显示工作中 / 等待确认 / 就绪。模型响应、工具执行、收尾统一为工作中，直到 agent_settled 才显示就绪；不轮换 bash、edit 或文件目标，不靠轮询/延时动画维持稳定。
3. 不恢复独立 errors 汇总项。失败计数放在各工具分类的 ! 后；内部错误统计保留。
4. 用户已有 todo 插件显示任务进度，不需要为此新增 pi-goal/todo 专用桥接。footer 保留其他扩展 setStatus 的真实字符串。
5. 用户使用 pi-agent + @narumitw/pi-goal 开发，通常希望按阶段获得可直接粘贴的 /goal prompt，再进行 review 和修复。

旧设计中的“当前文件目标”“最近摘要”“独立 Errors”等要求已被以上偏好覆盖。历史验证记录描述测量当时的代码，不应当作当前 UI 规范。

## 验证证据与边界

- 稳定状态及移除 errors 的代码通过 npm run verify（测试、仓库检查、性能门禁）和 npm run package:check。
- 新增中英文 widget/footer 状态回归：并发工具、等待、完成、收尾、settled；分类失败计数保留且不显示重复 errors。
- 打包检查首次因沙箱嵌套进程 EPERM 失败，沙箱外执行本地离线检查通过。
- 第三阶段 A 的 SDK/RPC/PTY 及同机 A/B 已有记录，见 [验证记录](VERIFICATION.md) 和 [性能说明](PERFORMANCE.md)。最新简化 UI 后未重新做整套宿主或 A/B 验收，不沿用旧数据冒充新测量。
- 真实深浅色终端人工验收、流式/工具/键盘 A/B、真实会话统计对照、两个 footer 扩展的真实宿主共存、跨平台矩阵仍有待验项。

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

宿主 SDK 位于被忽略的 .tmp/sdk，不随 Git 同步。需要宿主检查时按 [开发流程](DEVELOPMENT.md) 安装锁定 Pi 0.85.1 SDK，并执行 sdk-check、pi-rpc-smoke、pi-pty-smoke。
用户级 Pi 配置、provider 凭据、pi-goal 安装和会话状态也不由本仓库同步；不要将这些内容提交到 Git。

## 下一阶段：第三阶段 B，先确定统计契约

先阅读 [视觉/footer 方案](VISUAL-FOOTER-PLAN.zh-CN.md)、[架构](ARCHITECTURE.md)、[验证记录](VERIFICATION.md)，核对 src/footer.ts、src/extension.ts、src/state.ts 及固定 SDK。

下一轮应先明确“完整历史统计”与低开销的取舍，再实现，不能仅为了默认 footer 而抹掉口径差异：

- Pi 原生统计包含所有 session entries 中 assistant、带 usage 的 toolResult、compaction、branch_summary；当前 observed 统计不是同一口径。
- getEntries 的全量数组构建、getContextUsage 的 branch/估算访问不是 O(1)。禁止在 render 或逐 token 路径调用。
- 首次加载与结构变化重建应独立于稳态更新；核对事件和落盘先后，避免基线与增量重复计数。
- 分别验证恢复、压缩、树导航、模型切换、未知费用与取消；测量 1k/10k/100k 条记录初始化/重建成本。
- 宿主尚无某些设置/订阅的可靠公开来源，不能伪造字段或宣称完全等价替换。
- 数据覆盖与真实验收通过之后，再评估默认 footer。未满足前保持 widget 默认，必要时将统计方案设计与实现拆为两轮。
- 不扩展本轮到额度功能。后续顺序：公共额度基础 → 国内 GLM 个人/团队 → DeepSeek/硅基流动/MiniMax → Codex/Gemini → 六类整体验收。详见 [额度方案](PROVIDER-LIMITS-PLAN.zh-CN.md) 和 [GLM 作用域](GLM-PLAN-SCOPES.zh-CN.md)。

给新会话的接续提示：

```text
先读 docs/HANDOFF.zh-CN.md，核对 git status、当前代码和相关规划。
不要重做第三阶段 A，不恢复 recent、轮换工具名称或独立 errors 项。
先总结第三阶段 B 的统计契约、SDK 限制及验收边界，给我下一轮可直接用于 pi-goal 的 prompt；这一步先不修改实现。
```
