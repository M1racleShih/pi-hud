# pi-hud

[English](README.md) | 简体中文

为 [Pi](https://github.com/earendil-works/pi) 实现的被动、事件驱动 HUD，借鉴 [claude-hud](https://github.com/jarrodwatts/claude-hud) 的信息组织方式，而不是照搬它的 transcript 解析架构。显示模型、上下文快照、有界工具分类活动、已观察到的 token/费用、可选的**全会话用量账本**，以及显式接入的子代理和任务进度。默认仍是编辑器旁的命名 widget；可显式启用 **footer 接管模式**，用它替换 Pi 原生 footer，避免同一份信息重复显示。

**零运行时依赖；不监听逐 token 事件；不注入提示词；不发起网络请求。额外 Git 探测默认关闭。** 历史读取仅存在于显式开启的 `usageScope: "session"` 背后，并限制在一个可审计模块内。

## 预览

以下是生产渲染器在 120 列下生成的合成数据，不是真实 Pi 会话截图：

```text
[Example Model] · high · pi-hud · git:main* · 上下文(上次) █████░░░░░ 45% 90k/200k
● working · 已中断 1 · 错误 1 · bash ✓14 !1 ~1 · edit ✓3 · write ✓2 +1 · 估算* $0.042 · 代理 1 · 任务 3/7
```

`minimal` 一行、`balanced` 两行、`full` 三行。工具开始、结束、失败或收尾都不会改变选定布局的行数，避免额外的纵向跳动。窄终端按优先级省略片段：先保住上下文百分比、稳定的阶段状态，再折叠工具分类。上下文字段会先预留自己的宽度：长模型名只能被截断，不会让高占用警告消失。中文、emoji 和长路径按终端显示列宽（而非码元）测量、截断。全部预览见 [布局预览](docs/preview.txt)。

## 显示位置：widget（默认）与 footer

`surface` 决定 HUD 画在哪里，默认 `widget`，因此现有安装的行为不变。设为 `footer` 时使用 Pi 0.85.1 的正式 `ctx.ui.setFooter` 槽位替换内置 footer，并且**不再挂载 HUD widget**，从而消除模型、上下文、费用的重复显示：

```text
[Example Model] · high · demo · ~/opensource/pi-hud · git:main* · Compare HUDs
ctx(last) ██░░░░░░░░ 45% 90k/200k · obs* ↑12k ↓3.0k R75k CH86.2% · est* $0.042
● 工作中 · interrupted 1 · bash ✓14 !1 ~1 · edit ✓3 · write ✓2 +1
```

footer 主体固定为 **minimal 2 行、balanced 3 行、full 4 行**。其他扩展通过 `ctx.ui.setStatus` 发布的状态显示在独立的、有界区域内：最多 8 条、每条净化后 64 字符、最多 2 行，footer 总行数上限 6 行。状态变化在 footer 自己的 render 过程中被检测到，不需要轮询、HUD 事件或修改宿主。

footer 还会显示 widget 没有的身份信息：工作目录（家目录缩写为 `~`）、模型、provider、thinking、会话标题，以及宿主缓存的 Git 分支。分支复用 Pi 的 `footerData.getGitBranch()`/`onBranchChange()`，不会为显示分支额外启动 Git 进程；额外的 dirty 标记仍由独立的 `git.enabled` 探测提供。

footer **不是**原生 footer 的逐字节等价替换。默认不读会话历史，计数口径仍是“本次挂载/重置以来观察到”，上下文仍是明确标注的 `ctx(last)` 快照；设为 `usageScope: "session"` 后用量字段切换为下节的全会话账本；两种模式下都不模仿原生 footer 的实时上下文估计、自动压缩/订阅标记和 provider 数量。`/hud status` 会打印这些覆盖差异。

`minimal` 的活动摘要在第二行与上下文、用量共用空间：如果 40 列终端放不下，优先级更高的上下文留到最后，活动字段整体折叠；`balanced`（默认）与 `full` 为活动单列一行，因此 40 列下上下文百分比、稳定的阶段状态都能保留。

## 用量口径：observed（默认）与 session

`usageScope` 决定用量字段显示哪组数字。默认 `observed` 保持本次挂载/重置以来的低开销计数，完全不访问历史。设为 `session` 时额外建立可选的全会话账本，覆盖当前 SessionManager 的全部 entries（含其他分支、压缩前消息、已出错/中止的响应和摘要记录），与原生 footer 的四类记录规则一致：assistant、带 usage 的 toolResult、compaction、branch_summary。

```text
ctx(last) ██░░░░░░░░ 45% 90k/200k · 全会话* ↻ ↑61k ↓15k R312k W9.4k CH86.2% · 全会话* $0.384
```

`全会话*` 标签在两个用量字段最前，紧随的紧凑标记始终在数值之前：`↻` 表示有已追加记录等待下一个可靠提交边界，`+?` 表示存在不完整数据，`?` 表示首次基线仍在装载，饱和截断后显示 `limited*`——被裁剪的数值不会丢失“这是封顶值而非精确值”的提示。费用字段独立携带同样的范围与状态标记：balanced widget 和窄屏 footer 不显示 token 字段，`全会话* ↻ $0.384+?` 必须自描述。费用保留已记录小计：有未知部分显示 `+?`，全部未知显示 `?`，显式报告的零仍视为有效零。两种模式下 `ctx(last)`、`CH` 和工具分类都保持观察口径：全会话合计从不冒充实时上下文估计、累计命中率或本次挂载的活动账本。

账本事件驱动且可取消：一次基线重建分片读取历史（每片 512 条或约 2 毫秒），稳定轮次只沿已提交父链回走新增记录（不再重读全量数组），树导航和压缩各触发一次重建，会话切换或 `/hud off` 立即取消全部任务。宿主缺少只读 entry 接口时显式降级为带 observed 标签的数据，`/hud status` 记录请求范围与实际范围。`usageScope` 与 `surface` 独立：切换 widget/footer 不重置会话账本。完整契约（含缺失数据语义）见 [全会话统计契约](docs/SESSION-USAGE-CONTRACT.zh-CN.md)。

所有权规则：HUD 仍拥有槽位时，`/hud off` 恢复原生 footer；如果其他扩展后来覆盖了 HUD footer，HUD 既不会在 `off`/dispose 时清除对方的 footer，也不会在普通刷新时抢回，只有显式的 `/hud surface footer` 才会重新接管。宿主不提供 `ui.setFooter` 时回退到 widget，并在 `/hud status` 中记录原因。

## 活动信息

- **只显示稳定的大状态。** 活动区显示工作中、等待确认或就绪。模型响应、工具执行与收尾统一为工作中，直到 `agent_settled` 才显示就绪，不随单个工具名称或目标切换。失败次数只显示在工具分类的 `!` 后，不再重复显示 errors 汇总项。
- **工具分类有界。** 按工具名分别计数，例如 `bash ✓14 !1 ~1 · edit ✓3 · write ✓2 +1`。成功（`✓`）、失败（`!`）、中断（`~`）分开计数；开始不算完成。最多保留 16 个工具名分类，超出的名称合并到一条与工具名分开存放的 `other` 记录，因此账本不会随工具种类增长，真正名为 `other` 的工具也仍保留自己的计数。界面只展示活动量最高的三个分类，其余用 `+N` 标记。
- **代理和任务必须来自桥接数据。** 没有有效桥接数据时不显示空占位：固定行保留可用的用量信息（没有内容时保持空白）。不内置针对某个 subagent、`/goal` 或 todo 插件的专用适配。

## 安装

目标版本：**Pi 0.85.1**，包名 `@earendil-works/pi-coding-agent`，**Node.js ≥ 22.19.0**。接口已按该发布版源码核对；不宣称兼容旧版 `@mariozechner` 包。

解压后，把 `pi-hud` 目录放到准备长期保留的位置，使用它的**绝对路径**安装：

```sh
pi install /absolute/path/to/pi-hud
```

随后启动 Pi，或在现有会话执行 `/reload`。仅试用一个会话时，改用：

```sh
pi -e /absolute/path/to/pi-hud/index.ts
```

不要在同一个会话里同时用两种方式加载。HUD 本身不需要 `npm install`、编译、API key、额外模型调用、tmux 或专用字体。交付包**尚未发布到 npm**，请勿假定 `npm:pi-hud` 就是本项目。真实宿主的验证边界见 [验证记录](docs/VERIFICATION.md)。

移除已注册的本地包，可使用 `pi remove /absolute/path/to/pi-hud` 后重新加载。`/hud off` 只在当前扩展挂载期间关闭 HUD。要让启动时连事件和命令都不注册，在启动 Pi 的环境中设置 `PI_HUD_DISABLE=1`。

## 命令

| 命令 | 效果 |
| --- | --- |
| `/hud on`、`/hud off`、`/hud toggle` | 开关 HUD；重新开启时重新计算观察范围。 |
| `/hud preset minimal\|balanced\|full` | 切换固定布局：widget 一、二、三行；footer 主体二、三、四行。 |
| `/hud surface widget\|footer` | 切换显示位置；`footer` 替换原生 footer 且不挂载 widget，显式执行该命令可重新接管被其他扩展占用的槽位。 |
| `/hud scope observed\|session` | 切换用量口径；`observed`（默认）保持挂载以来的计数，`session` 建立全会话账本，每次切换都重建基线。 |
| `/hud palette pastel\|theme\|mono` | 切换字段配色：HUD 柔和色板（默认）、跟随宿主主题、或不着色。 |
| `/hud lang en`、`/hud lang zh-CN` | 切换 HUD 标签语言；命令帮助仍为英文。 |
| `/hud placement aboveEditor\|belowEditor` | 只移动 pi-hud 自己的 widget。 |
| `/hud git on`、`/hud git off` | 开关有界、仅检查 tracked 文件的额外 Git 探测。 |
| `/hud reload` | 异步重读配置。 |
| `/hud refresh` | 请求刷新；不会跳过 Git 冷却期。 |
| `/hud reset` | 清空观察计数、上下文快照和桥接状态。 |
| `/hud status` | 显示配置错误与诊断计数，不调用模型。 |

命令里的 `|` 表示任选其一，不要原样输入。命令修改只保存在内存，不写文件；新会话或 `/reload` 重新挂载扩展时会重读配置。需要持久保存时，手动创建 `~/.pi/agent/pi-hud.json`：

```json
{
  "version": 1,
  "preset": "balanced",
  "surface": "widget",
  "language": "zh-CN",
  "palette": "pastel",
  "usageScope": "observed",
  "refreshMs": 250,
  "git": { "enabled": false }
}
```

设置了 `PI_CODING_AGENT_DIR` 时，配置目录随之变化；绝对路径 `PI_HUD_CONFIG` 优先覆盖完整文件路径，相对路径会被拒绝。配置只允许普通文件，异步读取且硬性限制为 32 KiB；没有文件监听，也不会自行写入。未知字段、错误类型会被拒绝。重载失败保留上一份有效配置，首次启动失败使用默认配置，错误可通过 `/hud status` 查看。详见 [配置说明](docs/CONFIGURATION.md)、[完整示例](examples/pi-hud.json) 和 [JSON schema](docs/config.schema.json)。

## 配色

颜色作用在语义片段上，而不是整行。先按纯文本完成宽度布局与截断，再逐片段着色，因此颜色不会影响排版。告警只改变自己所在的字段：上下文高占用不会把模型名染黄，单个工具失败也不会让整行变色。

| 字段 | 角色 | 深色终端柔和色 | 浅色终端加深色 | `theme` 色板 token |
| --- | --- | --- | --- | --- |
| 模型 | `model` | `#e5c890` | `#df8e1d` | `accent` |
| thinking 等级 | `thinking` | `#d8c39a` | `#c08a2e` | `thinkingText` |
| 项目/路径 | `path` | `#a6d189` | `#40a02b` | `success` |
| Git 分支 | `git` | `#8caaee` | `#1e66f5` | `mdLink` |
| 阶段/当前活动 | `phase` | `#ca9ee6` | `#8839ef` | `customMessageLabel` |
| 上下文数值与进度条 | `context`、`barUsed` | `#ef9f76` | `#fe640b` | `mdHeading` |
| 数值、费用、标签 | `body`、`label` | `#c6d0f5`、`#838ba7` | `#4c4f69`、`#9ca0b0` | `text`、`muted` |
| 分隔符、未用进度条 | `separator`、`barEmpty` | `#838ba7`、`#6c7086` | `#9ca0b0`、`#ccd0da` | `dim` |
| 完成/等待/失败 | `success`、`warning`、`error` | `#a6d189`、`#f9e2af`、`#e78284` | `#40a02b`、`#9a6700`、`#d20f39` | `success`、`warning`、`error` |

`palette: pastel`（默认）使用上述深色终端候选值；当宿主主题的正文色表明是浅色背景时，自动改用同色系的加深色。`palette: theme` 使用宿主主题 token，让 HUD 跟随用户主题。`palette: mono` 与 `color: false` 输出纯文本；`ascii: true` 把 `·`、`█`、`░`、`✓`、`●`、`↑`、`↓`、`…` 换成 ASCII 符号（中断标记 `~` 本身是 ASCII），但中文标签照常显示。完整角色表由渲染器生成在 [preview.txt](docs/preview.txt)。

## 数据的真实含义

**“上下文(上次)”是主助手上一次完整响应的 usage 快照，不是实时上下文，也不是下次请求的精确预测。** 计算方式为 Pi 报告的 input + cacheRead + cacheWrite + output，除以当前模型上下文窗口。之后的工具结果、排队输入、新系统提示词不包含在这个快照中；没有为了“实时感”而猜测逐 token 数量。恢复会话、重置、树导航、压缩、切换模型、出错或中止后显示 `?` 是正常行为。旧模型的延迟响应不会套用新模型的窗口大小。本 HUD 也不用于判断自动压缩的准确触发阈值。

**`*` 表示“自本次 HUD 挂载/重置以来观察到”。** 工具结果、token、压缩次数与费用不回扫历史，因此不是完整会话账本。树导航、重新开启会重置观察范围；压缩只使上下文失效，保留已经观察到的累计计数。分类账本随观察范围一起清空，旧活动不会残留到新会话。近期工具完成事件在有界 ID 窗口内去重。出现 `limited*` 表示因固定上限丢弃过记录；真正收尾后仍未完成的工具归为中断，不伪装成成功；分类上的 `!`/`~` 标记使这种不完整可见。

**`obs*` 把 input、output、cacheRead、cacheWrite 分开呈现。** 缓存 token 不会被重复计入新的 input：显示的是 `↑输入`、`↓输出`、`R缓存读`、`W缓存写` 四个独立字段，而不是一个已经合并的数字。`CH` 取最近一次有效 assistant 响应的缓存命中率 `cacheRead / (input + cacheRead + cacheWrite)`；分母为零或 provider 未报告缓存字段时显示 `?`。重置、切换模型和压缩会清除不再适用的命中率，出错或中止的响应也不会覆盖上一次有效值。`obs*`、`last`、`est*` 含义一致：都是本次挂载范围内的有界观察，不是原生 footer 的全会话账本。

**`全会话*`（显式 `usageScope: "session"`）是当前 SessionManager 全部 entries 的账本。** assistant 消息、带 usage 的 toolResult、compaction 和 branch_summary 分别贡献四项 token 和记录中的 `cost.total`；出错/中止响应只要报告了 usage 就计入，重试不会重复计入同一记录。缺失或非法数值会把数据标为不完整（`+?`）而不是被静默丢弃；不带 usage 的 toolResult 只是口径外，不当作未知收费；无 usage 的摘要保留已知 token 小计并把费用标为不完整；饱和求和显示 `limited*`。`/hud reset` 只清观察计数，保留这本账。完整的范围、生命周期与缺失数据语义见 [契约](docs/SESSION-USAGE-CONTRACT.zh-CN.md)。

**“估算*”来自 Pi 的 `usage.cost.total`，不是实际账单或套餐额度。** 缺失数据显示 `?`，部分已知显示 `+?`。历史调用、压缩模型调用、没有进入主助手事件流的子代理费用不会被悄悄算入。不会读取服务商凭据，也不会请求套餐额度接口。

**代理和任务需要显式桥接。** 原生 `subagent` 工具会作为有界分类显示，但单凭工具名无法知道其内部每个子代理的状态。[桥接协议](docs/BRIDGE.md) 允许 subagent 或 `/goal` 扩展发布小型生命周期记录。本版没有宣称自动适配所有第三方插件。

**可选 Git 只是在空闲边界采集的缓存快照。** 它不检查 untracked 文件、子模块状态、行级 diff、ahead/behind；星号只代表 tracked 变更，`git:?` 代表不可用而不是干净。追求最低额外争用时保持关闭；footer 接管模式仍会显示 Pi 自己缓存的分支名，widget 模式也可以继续看原生 footer 的分支。

## 为什么不照搬 claude-hud

claude-hud 通过独立状态行进程消费 stdin JSON，并解析 transcript、读取配置、探测 Git。Pi 已经提供原生事件和 widget 接口，因此可以去掉这条重复采集链。研究中还确认，claude-hud 的 transcript 缓存按版本、路径、mtime 和 size 命中；缓存未命中时从头读取文件，并非基于字节偏移的增量 tail。详细源码依据和版本锁定见 [中文研究](docs/RESEARCH.zh-CN.md) / [English research](docs/RESEARCH.md)。

pi-hud 的路径是：

```text
原生生命周期 / 工具 / 最终消息事件
  → 有界标量状态（同步返回 undefined）
  → 一个合并发布定时器（稳态刷新间隔至少 250 ms）
  → 小型快照 → 缓存的 widget / footer 行 → 只有行变了才 requestRender
```

不监听 `message_update`、`tool_execution_update`；不调用 `getBranch()`、`getContextUsage()`；不做同步文件/进程操作；不轮询空闲状态；不接管输入或编辑器。`getEntries()`、`getEntry()`、`getLeafId()` 只允许可选的全会话账本模块（`src/usage.ts`）在其标记的历史边界内调用，且只能来自生命周期事件调度的可取消后台任务，绝不在 render 或逐 token 路径；其他源文件一旦调用会被 `scripts/check.mjs` 直接判失败。`ctx.ui.setFooter` 只在专门的 footer 模块（`src/footer.ts`）里调用，带能力检测和 `tui` 模式判断，同一检查也强制该边界。不注册 LLM 工具、不改消息、不写会话。每行由有界的语义片段组成（字段 ≤ 12、片段 ≤ 40）；最终 ANSI 行会被缓存，宿主随模型流重绘时，只要宽度、已发布状态、状态变化和主题失效均未变化就复用同一数组。RPC、JSON、print 模式不创建 HUD 定时器、不读 HUD 配置、不挂 UI。

启动配置读取异步延后；桥接活动最多使用一个过期定时器；可选 Git 具备超时、输出上限、单飞、冷却、取消与过期结果隔离。异步 Git 仍可能争用 CPU 或磁盘，不能把“异步”等同于“没有成本”。

目标是**不可感知的影响**，不是声称物理意义上的零开销。交付环境中已完成本地测试和合成性能门禁，但它们不能证明所有电脑、终端、模型服务商和扩展组合均无差异；真实 Pi SDK/TUI 端到端验证在本次沙箱中未能执行。请阅读 [验证记录](docs/VERIFICATION.md) 与 [性能说明及实机 A/B 验收流程](docs/PERFORMANCE.md)。

## 开发与仓库工作流

计划中的套餐额度与 API 余额功能见 [Provider 额度方案](docs/PROVIDER-LIMITS-PLAN.zh-CN.md)；该文档描述待实现能力，不改变当前版本的数据获取行为。

```sh
npm ci --ignore-scripts
npm run verify
npm run package:check
npm run demo
```

本地测试不需要开发依赖。GitHub CI 另外在隔离的临时目录安装锁定的 Pi SDK，执行类型契约和真实 loader/RPC 检查，且准备了 Linux、macOS、Windows 矩阵。远程 CI 尚未实际运行；真实本地分支、提交、合并记录随交付中的 Git bundle 保存，不虚构 GitHub PR。详见 [开发流程](docs/DEVELOPMENT.md)。

更多内容：[架构](docs/ARCHITECTURE.md)、[贡献指南](CONTRIBUTING.md)、[安全说明](SECURITY.md)、[变更记录](CHANGELOG.md)。采用 MIT 协议，[来源声明](THIRD_PARTY_NOTICES.md)。未打包上游源码、截图或字体。
