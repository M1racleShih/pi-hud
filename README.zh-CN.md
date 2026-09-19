# pi-hud

[English](README.md) | 简体中文

为 [Pi](https://github.com/earendil-works/pi) 实现的被动、事件驱动 HUD，借鉴 [claude-hud](https://github.com/jarrodwatts/claude-hud) 的信息组织方式，而不是照搬它的 transcript 解析架构。显示模型、上下文快照、原生工具活动、已观察到的 token/费用，以及显式接入的子代理和任务进度；不替换 Pi 的编辑器或 footer。

**零运行时依赖；不监听逐 token 事件；不扫描 transcript；不注入提示词；不发起网络请求。额外 Git 探测默认关闭。**

## 预览

以下是生产渲染器在 120 列下生成的合成数据，不是真实 Pi 会话截图：

```text
[Example Model] · high · pi-hud · git:main* · 上下文(上次) █████░░░░░ 45% 90k/200k
● edit state.ts · 工具* ✓4 !1 · 估算* $0.042 · 代理 1 · 任务 3/7
```

`minimal` 一行、`balanced` 两行、`full` 三行。工具开始或结束不会改变选定布局的行数，避免额外的纵向跳动。窄终端按优先级省略片段，但上下文字段会先预留自己的宽度：长模型名只能被截断，不会让高占用警告消失。中文、emoji 和长路径按终端显示列宽（而非码元）测量、截断。全部预览见 [布局预览](docs/preview.txt)。

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
| `/hud preset minimal\|balanced\|full` | 切换固定的一、二、三行布局。 |
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
  "language": "zh-CN",
  "palette": "pastel",
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

`palette: pastel`（默认）使用上述深色终端候选值；当宿主主题的正文色表明是浅色背景时，自动改用同色系的加深色。`palette: theme` 使用宿主主题 token，让 HUD 跟随用户主题。`palette: mono` 与 `color: false` 输出纯文本；`ascii: true` 把 `·`、`█`、`░`、`✓`、`↑`、`↓`、`…` 换成 ASCII 符号，但中文标签照常显示。完整角色表由渲染器生成在 [preview.txt](docs/preview.txt)。

## 数据的真实含义

**“上下文(上次)”是主助手上一次完整响应的 usage 快照，不是实时上下文，也不是下次请求的精确预测。** 计算方式为 Pi 报告的 input + cacheRead + cacheWrite + output，除以当前模型上下文窗口。之后的工具结果、排队输入、新系统提示词不包含在这个快照中；没有为了“实时感”而猜测逐 token 数量。恢复会话、重置、树导航、压缩、切换模型、出错或中止后显示 `?` 是正常行为。旧模型的延迟响应不会套用新模型的窗口大小。本 HUD 也不用于判断自动压缩的准确触发阈值。

**`*` 表示“自本次 HUD 挂载/重置以来观察到”。** 工具、token、压缩次数与费用不回扫历史，因此不是完整会话账本。树导航、重新开启会重置观察范围；压缩只使上下文失效，保留已经观察到的累计计数。近期工具完成事件在有界 ID 窗口内去重。出现 `limited*` 表示发生过容量截断；真正收尾后仍未完成的工具归为中断，不伪装成成功。

**“估算*”来自 Pi 的 `usage.cost.total`，不是实际账单或套餐额度。** 缺失数据显示 `?`，部分已知显示 `+?`。历史调用、压缩模型调用、没有进入主助手事件流的子代理费用不会被悄悄算入。不会读取服务商凭据，也不会请求套餐额度接口。

**代理和任务需要显式桥接。** 原生 `subagent` 工具会作为工具活动显示，但单凭工具名无法知道其内部每个子代理的状态。[桥接协议](docs/BRIDGE.md) 允许 subagent 或 `/goal` 扩展发布小型生命周期记录。本版没有宣称自动适配所有第三方插件。

**可选 Git 只是在空闲边界采集的缓存快照。** 它不检查 untracked 文件、子模块状态、行级 diff、ahead/behind；星号只代表 tracked 变更，`git:?` 代表不可用而不是干净。追求最低额外争用时保持关闭，继续看 Pi 原有 footer 中的分支即可。

## 为什么不照搬 claude-hud

claude-hud 通过独立状态行进程消费 stdin JSON，并解析 transcript、读取配置、探测 Git。Pi 已经提供原生事件和 widget 接口，因此可以去掉这条重复采集链。研究中还确认，claude-hud 的 transcript 缓存按版本、路径、mtime 和 size 命中；缓存未命中时从头读取文件，并非基于字节偏移的增量 tail。详细源码依据和版本锁定见 [中文研究](docs/RESEARCH.zh-CN.md) / [English research](docs/RESEARCH.md)。

pi-hud 的路径是：

```text
原生生命周期 / 工具 / 最终消息事件
  → 有界标量状态（同步返回 undefined）
  → 一个合并发布定时器（稳态刷新间隔至少 250 ms）
  → 小型快照 → 缓存 widget 行 → 只有行变了才 requestRender
```

不监听 `message_update`、`tool_execution_update`；不调用 `getBranch()`、`getEntries()`、`getContextUsage()`；不做同步文件/进程操作；不轮询空闲状态；不接管输入、编辑器或 footer；不注册 LLM 工具、不改消息、不写会话。每行由数量有上限的语义片段组成；最终 ANSI 行会被缓存，宿主随模型流重绘时，只要宽度、已发布状态和主题失效均未变化就复用同一数组。RPC、JSON、print 模式不创建 HUD 定时器、不读 HUD 配置、不挂 UI。

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
