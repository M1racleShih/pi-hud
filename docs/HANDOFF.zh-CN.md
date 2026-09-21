# pi-hud 开发交接

更新：2026-09-20（视觉验收精简执行：核心项经观察者口述确认并转录收紧，记录见结果文件；仅文档变更，未改生产代码与默认值）。代码基线：B2b review 修复提交 5333c7d 已通过复审；后续各轮均未改生产代码默认值。
仓库：<https://github.com/M1racleShih/pi-hud>，继续使用 `main`。

## 当前完成情况

- 分字段语义片段布局与 pastel/theme/mono 配色，中文、ASCII、主题切换、窄屏上下文保留。
- 有界工具分类：16 个真实工具名与独立 overflow 桶，成功/失败/中断分别计数；真实名为 other 的工具不与溢出桶混用。
- 第三阶段 A：可选 footer 接管、surface 所有权与清理、缓存身份/标题/宿主 Git 分支、分项 token 和 CH、其他扩展状态的有界展示与独立更新。
- 第三阶段 B2a：可选全会话 usage 账本（`usageScope: observed | session`，默认 observed；独立模块 `src/usage.ts`）。
- 第三阶段 B2b（本轮）：**长历史性能实测与真实宿主验收已完成，并经一轮 review 修复四项证据缺陷后重建受影响证据**。1k/10k/100k 线性+分支夹具实测（固定 seed/比例/内容大小）；稳态增量、超限恢复（含恢复再失败）、重建/切换/取消实测；8 组同机交替 observed/session A/B（完整轮含 250ms 合并发布，断言每轮恰好一次发布）；真实 TUI 中 9 场景验收（10k resume、同 summary 双压缩、树导航/回根、模型切换、基线在途时快速切会话、双 footer 两种加载顺序、后置异步 message_end 替换扩展）全部与独立文件 oracle 对齐；20 对 × 2 配置（默认 observed+widget 与可选 session+footer）共 80 组真实 TUI 流式/工具/键盘 A/B，含流中输入与配对噪声包络。原始数据与结论见 [性能证据](PERFORMANCE.md)、[验证记录](VERIFICATION.md) 与 docs/ 下四份 JSON。
- B2b 修复：`accumulateUsage` 每条记录分配元组数组（100k 重建约 24 MiB 垃圾）→ 提升为模块级常量；`/hud status` 诊断新增已发布 totals，便于真实宿主与独立 oracle 对齐。review 两轮共修复七项测量缺陷（A/B 从不触发 250ms 发布、fast-switch 未命中在途基线、流式探针标记/超时/完成语义、组数与负载不足、纯文本字节计数、回显证据可被无关输出满足、缺工具行静默通过），仅重建受影响证据，详见 VERIFICATION.md 的 review round 两节。
- 默认仍为 widget + observed（[默认 footer 决策记录](DEFAULT-FOOTER-DECISION.zh-CN.md) 已完成独立评估，结论：当前不切换，满足条件后重评；未改任何默认/配置）。widget 主体为 1/2/3 行，footer 主体为 2/3/4 行，footer 另有最多 2 行扩展状态。
- B2b 后续：真人视觉验收材料与默认 footer 决策记录已交付（`scripts/visual-demo.mjs`、[VISUAL-ACCEPTANCE.zh-CN.md](VISUAL-ACCEPTANCE.zh-CN.md)、[DEFAULT-FOOTER-DECISION.zh-CN.md](DEFAULT-FOOTER-DECISION.zh-CN.md)）。
- 视觉验收（最新）：**观察者按精简清单执行并口头确认"没问题"，结果已如实转录并收紧**于 [VISUAL-ACCEPTANCE-RESULTS.zh-CN.md](VISUAL-ACCEPTANCE-RESULTS.zh-CN.md)（口述转录、非逐项手写；带推测性的 ✅ 已按观察者指示降级）。通过：深色合成预览 A1–A6/A9/A10、真实会话 B1–B5/B7–B9（日常宽度）。未覆盖（➖）：A7/A8 变体、浅色细节节与真实会话、B6 逐字段对照、40/120/180 档、上下文警戒/partial/waiting/长标题。手册 "CP-C7" 悬空引用已修复。**状态：核心项通过、覆盖度部分；非完整视觉验收，不得宣称完整通过**。
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
- B2b 关键实测结论：附挂 3.1/3.3ms（1k）→ 20.9/23.1ms（10k）→ 202/231ms（100k，含 SDK 自身 2.0–2.9ms 的 O(N) getEntries 同步复制）；分片最大 0.23–0.70ms（预算 2ms 不变）；稳态增量只随新增条数增长且 getEntries 保持 0 次；session 模式稳态边际成本约 +1.0µs 账本核对 + ~0.9µs 发布/轮，另 ~1.0µs/次 sess* 渲染；真实 TUI（两种配置各 20 对）所有时间指标均在同机噪声包络内；按原始终端字节计的确定性成本为每轮约 +0.9–1.0 KiB、每次流式回复 +1.0 KiB（footer）至 +2.6 KiB（widget），另一次约 320–460 字节的合并发布（完成后约 150ms）。
- 仍未验（不得宣称）：完整版真人视觉验收（精简核心项已通过，剩余项被所有者明示接受，见结果文件）、真实付费 provider 流式 A/B（明确不使用付费 provider）、流中 resize/压缩/中止重试等剩余实时场景。跨平台矩阵已通过（35541018928）。
- 默认 footer 切换评估已完成：结论为“当前不切换，有条件重评”，见 [DEFAULT-FOOTER-DECISION.zh-CN.md](DEFAULT-FOOTER-DECISION.zh-CN.md)；widget + observed 保持默认，本轮未改任何默认或用户配置。

## B2b 之后的待验清单（本轮更新）

1. B2b 评审：**已完成**（5333c7d 经三轮复审通过，见 .tmp/review/b2b-review-round3.md；B2b 数据不重做）。
2. 真人深浅色终端视觉验收：**精简核心项已通过（口述转录，见 [VISUAL-ACCEPTANCE-RESULTS.zh-CN.md](VISUAL-ACCEPTANCE-RESULTS.zh-CN.md)）**；宽度逐档、浅色真实会话、B6 逐字段对照与部分状态仍未覆盖。补齐或由所有者明示接受当前覆盖度，均可满足决策记录的重评条件 1。
3. 跨平台矩阵（CI 运行 Linux/macOS/Windows × Node 22.19.0/24）：**已执行通过**（运行 35541018928，8/8 job；Windows CRLF 问题由 `.gitattributes` 修复）。
4. 默认 footer 切换：重评条件 1–4 已全部闭合（视觉验收精简执行+所有者接受；字段缺口书面接受；跨平台矩阵 35541018928 全绿；实时场景 5/5 通过），仅剩条件 5（所有者批准单独的默认切换变更，两步走且不连带），见 [DEFAULT-FOOTER-DECISION.zh-CN.md](DEFAULT-FOOTER-DECISION.zh-CN.md) 追加节。

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

## 下一阶段：观察一个使用周期后评估第二步（session 默认），或继续额度后续阶段

额度功能第一阶段 A 已于 2026-09-21 实现并交付：公共额度基础（src/quota/{types,identity,service,transport}.ts）+ GLM 国内个人/团队两 profile（adapters/zai.ts），默认关闭，306 项测试全绿、门禁未放宽。第二切片（同日）：DeepSeek / 硅基流动余额适配器（adapters/deepseek.ts、siliconflow.ts + 共享 helpers adapters/http.ts）按官方文档契约实现，含中转防护与十进制原值语义，324 项测试全绿；**真实账号 E2E 待完成**（需官方 API key；所有者环境 deepseek key 为空、dgx-deepseek 为中转会被正确拒绝，无 siliconflow provider）——完成前不得宣称账号验证，详见 VERIFICATION 额度章节 slice 2。后续额度顺序：DeepSeek/硅基流动真实 E2E → MiniMax → Codex/Gemini → 六类整体验收，见 [额度方案](PROVIDER-LIMITS-PLAN.zh-CN.md) 与 [GLM 作用域](GLM-PLAN-SCOPES.zh-CN.md)。

B2b（验收轮）与三轮 review 已完成；后续材料已交付；视觉验收精简执行并转录收紧（见上）。下一步依次是：

1. 字段缺口书面取舍（决策记录条件 2）：**已闭合（2026-09-20）**——所有者书面接受缺口（footer 接管模式无 auto/sub/xp，ctx 为快照），见决策记录追加节。
2. 视觉验收覆盖度处置（条件 1）：**已闭合（2026-09-20）**——所有者明示接受精简覆盖度（宽度逐档、浅色真实会话、B6 逐字段对照、部分状态以 ➖ 未覆盖形式被明确接受）。
3. 跨平台矩阵（条件 3）：**已闭合（2026-09-20）**——Actions 运行 35541018928 全部 8 个 job 通过（ubuntu/macos/windows × Node 22.19.0/24、性能门禁、Pi 0.85.1 契约与 RPC）；首轮 Windows CRLF 失败已由 `.gitattributes`（`c0f0948`）修复。
4. 剩余实时协议场景（条件 4）：**已闭合（2026-09-20）**——`scripts/pi-live-scenarios.py` 五场景全部通过（流中 resize × 两 surface、流中 /compact、abort/重试、并发第二扩展 widget），证据 `docs/live-protocol-scenarios.json`；期间修复两项测试基建缺陷（fixture 尊重中止信号；连续 /hud status 的 PTY 陈旧帧解析），生产源码未变更，详见 VERIFICATION 的 live-protocol 节。
5. 全部满足后由所有者批准单独的默认切换变更（条件 5，两步走且不连带，见决策记录）。

B1 契约约束仍然全部有效：

- Pi 原生统计包含所有 session entries 中 assistant、带 usage 的 toolResult、compaction、branch_summary；observed 不是同一口径，两种口径都要显式标注。
- getEntries 的全量数组构建、getContextUsage 的 branch/估算访问不是 O(1)。禁止在 render 或逐 token 路径调用（当前由 scripts/check.mjs 边界强制）。100k 实测：SDK 自身 O(N) 复制约 2.1–2.4ms，是附挂最长停顿的主要成分，分片无法补救这一步（B1 契约已明示）。
- 首次加载与结构变化重建独立于稳态更新；message_end 在追加前且可被后置扩展替换，session 账本在 turn_end/settled 边界读最终记录（真实宿主异步替换场景已验收）。压缩事件存在相同摘要命中旧 entry 的边界（真实宿主同 summary 场景已验收）。
- provider 数量已有公开缓存 getter getAvailableProviderCount；自动压缩设置/订阅等仍缺完整对等的公开来源，不能伪造字段或宣称完全等价替换。
- 数据覆盖与真实验收已通过；默认 footer 评估已完成（结论：保持默认，条件见决策记录），不自动迁移。
- 不扩展到额度功能。后续顺序：公共额度基础 → 国内 GLM 个人/团队 → DeepSeek/硅基流动/MiniMax → Codex/Gemini → 六类整体验收。详见 [额度方案](PROVIDER-LIMITS-PLAN.zh-CN.md) 和 [GLM 作用域](GLM-PLAN-SCOPES.zh-CN.md)。

给新会话的接续提示：

```text
先读 docs/HANDOFF.zh-CN.md，核对 git status、当前代码和相关规划。
默认 surface 已切换为 footer（所有者批准，2026-09-20；usageScope 保持 observed；
surface: "widget" 可恢复旧行为）。不要重复执行重评条件 1–4 的验收。
B2b、三轮 review、B2b 后续材料均已交付，不要重做。视觉验收已精简执行并转录收紧
（docs/VISUAL-ACCEPTANCE-RESULTS.zh-CN.md），所有者已接受当前覆盖度（条件 1 闭合）
并书面接受字段缺口（条件 2 闭合，见决策记录追加节）。保持 observed 与 widget 默认。
条件 1–4 全部闭合（实时场景见 docs/live-protocol-scenarios.json），
仅剩条件 5：所有者单独批准默认切换（两步走，先 surface: footer 保持
observed）。不新增额度功能；发布（release）仍需单独授权。
```
