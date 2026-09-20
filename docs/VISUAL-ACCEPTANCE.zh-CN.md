# 真实终端视觉验收手册（B2b 后续阶段）

状态：**准备完成，等待真人执行**（2026-09-20）。本手册整理可由用户独立执行的材料：准确命令、预期检查点与结果记录模板。本文档本身不是验收结果；在下表某条被真人实际观察并记录之前，该条保持**未通过**。

[交接](HANDOFF.zh-CN.md) · [视觉/footer 规划](VISUAL-FOOTER-PLAN.zh-CN.md) · [默认 footer 决策记录](DEFAULT-FOOTER-DECISION.zh-CN.md) · [验证记录](VERIFICATION.md)

## 证据等级与禁止事项

| 证据类型 | 已覆盖内容 | 不能替代的内容 |
| --- | --- | --- |
| 合成纯文本预览（`docs/preview.txt`，`npm run check` 断言与渲染器一致） | 布局、折叠、标签、ASCII、宽度的确定性快照 | 任何颜色、对比度、观感 |
| 合成着色预览（`scripts/visual-demo.mjs`，本阶段新增，第 1 部分） | 生产渲染器 + 生产配色在真实终端上的着色输出 | 真实 Pi 会话行为（事件、原生 footer、闪烁、resize） |
| PTY 冒烟 / 真实宿主 9 场景 / 80 组流式 A/B（B2b 已完成） | 挂载、切换、恢复、数据对齐、时序噪声包络、原始终端字节 | 感知判断：对比度、可读性、颜色区分、布局稳定性、与原生 footer 的主观对照 |

明确禁止：由 agent 或脚本**代填**上表任何检查点为通过；把合成预览或 PTY 输出记录为"真人观察"。脚本自带的行宽断言只证明布局正确，不证明观感。

## 准备

1. Node ≥ 22.19.0（本仓库近期验证用 24.x）；仓库位于 `/home/shq/opensource/agents/pi-hud`。
2. 一个可以切换深色/浅色背景的终端。**切换背景由你自己在终端配置里完成**；pi-hud 与本流程不会修改你的终端主题、配置或其他 pane。
3. 每个宽度档位在**启动 pi 之前**用 `tput cols`（或 `stty size` 的第二列）确认当前列数是 40/80/120/180 之一；调整窗口大小后需重新确认。终端字体/字号自由，但请在结果中记录。
4. 不要求网络、模型调用或凭据。第 1 部分完全离线；第 2 部分用你自己的正常会话顺带观察（不要为验收专门发起付费调用）。
5. 工作目录建议用本仓库或任一测试目录；Git 分支显示依赖该目录是 Git 仓库（`/hud git off` 可关闭）。

## 第 1 部分：合成着色预览（真实渲染器，无 Pi 宿主）

这些命令把与 `docs/preview.txt` 相同的 fixture 通过同一渲染器与配色输出为 ANSI 着色行，用于在你的真实终端背景上检查配色。深/浅两遍都要做（先切好终端背景再运行对应命令）：

```sh
cd /home/shq/opensource/agents/pi-hud

# 深色背景终端：
node scripts/visual-demo.mjs --background dark
# 浅色背景终端：
node scripts/visual-demo.mjs --background light

# 可选补充：
node scripts/visual-demo.mjs --background dark  --language zh-CN            # 中文标签 + 长中文模型名
node scripts/visual-demo.mjs --background dark  --preset minimal,balanced,full
node scripts/visual-demo.mjs --background dark  --ascii                    # ASCII 标记与分隔符
node scripts/visual-demo.mjs --background dark  --mode 256color            # 256 色终端
node scripts/visual-demo.mjs --background dark  --width 40                 # 只看窄屏
```

输出分节：14 个语义角色的色样；widget 与 footer 的 minimal/balanced/full × 40/80/120/180；ready/working/waiting/中断计数；上下文 96% 警戒；长中文模型名；footer 长标题折行与 20 条扩展状态的 `+N` 折叠；`usageScope: session` 的 ready/↻ updating/+? partial/? loading/limited*/不可用降级（回退 obs* 标签）与 40 列截断保留标记。

### 第 1 部分检查点

| 编号 | 检查点 | 对应输出节 |
| --- | --- | --- |
| CP-A1 | 每一行都不超过终端宽度：无自动换行、无横向滚动 | 所有节 |
| CP-A2 | pastel 深色（或浅色）14 个角色色样在你的背景上全部可读、彼此可区分；`separator/label` 次要但不至于看不清 | palette roles |
| CP-A3 | 上下文 96% 场景：只有上下文字段与进度条变黄（`96%!`），模型/路径/分支/分隔符颜色不变 | context-warning |
| CP-A4 | 40 列：上下文百分比与当前活动优先保留；会话标题在分支之前折叠；扩展状态区折叠为 `+N` | 窄屏各节、long title |
| CP-A5 | `sess*` 范围与 `↻`/`+?`/`?`/`limited*` 标记始终位于数值之前，被截断时仍可辨认 | usageScope: session |
| CP-A6 | 不可用降级段显示 obs*/est* 标签（不是伪精确 session 数值） | unavailable |
| CP-A7 | zh-CN 标签、中文模型名、`·` 分隔符宽度正确，无溢出或错位 | zh-CN 相关节 |
| CP-A8 | ASCII 模式信息等价（`ok`/`!`/`~`、`|`、`#.`），mono/--plain 无任何转义序列 | --ascii 运行 |
| CP-A9 | working/waiting/ready 三态活动行稳定：工具开始/结束不改变行数，waiting 用黄色 | acceptance states |
| CP-A10 | 工具分类失败 `!1`、中断 `~1` 只着色自己的计数，不染整行 | acceptance states |

## 第 2 部分：真实 Pi 会话（真人观察，widget/footer 与原生 footer 对照）

启动（已用 `pi install` 注册过的安装不需要 `-e`；已开的会话 `/reload` 即可）：

```sh
cd /home/shq/opensource/agents/pi-hud
pi -e "$PWD/index.ts"
```

对每个背景（深/浅）× 每个宽度（40/80/120/180）执行以下流程。宽度档之间退出 pi、调整窗口、`tput cols` 确认后再进入（也鼓励顺手观察运行中 resize，结果记入 CP-B1 的备注列）。

### 2.1 surface 对照流程

```text
1. 默认启动（surface: widget, usageScope: observed）
   观察：HUD widget 固定行数（minimal 1 / balanced 2 / full 3）；
         原生 footer 同时在场（cwd/分支/标题、↑↓RW/CH/$/ctx%、模型/provider）。
2. /hud preset full        （或 minimal，两档都看）
3. /hud lang zh-CN         （中文标签一遍）
4. /hud surface footer     观察接管：原生 footer 消失，HUD footer 主体 2/3/4 行
                           + 最多 2 行扩展状态；与第 1 步的原生 footer 逐字段对照
                           （对照表见第 3 节）。
5. /hud surface widget     原生 footer 恢复（恰好一次），widget 回来。
6. /hud off                footer 模式下原生恢复；widget 模式下 widget 消失。
7. /hud on                 恢复。
```

### 2.2 状态观察（用正常会话顺带完成）

| 状态 | 触发方式 | 预期 |
| --- | --- | --- |
| working | 任何工具执行期间 | 活动行 `● working`；工具名不轮换；行数不变 |
| waiting | 出现权限确认提示（如 bash 命令确认） | `● waiting` 黄色；确认后恢复 |
| ready | agent_settled 后 | `✓ ready` |
| interrupted | Esc 中断一轮 | 工具分类出现 `~N`，只着色该计数 |
| 上下文警戒 | 真实长上下文会话 >70% 变黄、≥90% 加 `!` | 若手边没有长会话，记"未覆盖"；颜色语义已由 CP-A3 覆盖，真实场景留待自然出现 |
| 扩展状态 | pi-goal 等扩展 setStatus | 状态区显示真实字符串，有界（≤2 行、8 条、64 字符），多余折叠 `+N` |
| 长标题 | `/name 一个特别长特别长特别长的会话标题`（Pi 原生命令） | footer 标题更新，窄屏在分支/provider 之前折叠 |
| usage loading | `/hud scope session` 后 resume 一个大会话 | 短暂 `sess* ?`，随后出数；`/hud status` 可看 ledger 诊断 |
| usage partial | 真实 provider 通常都报 usage；若出现 `+?` 即记录 | 无法构造就记"未覆盖" |
| usage unavailable | Pi 0.85.1 提供只读接口，真实宿主**不应**降级 | 若真实观察到 obs* 降级标签，记录为异常 |

### 2.3 第 2 部分检查点

| 编号 | 检查点 |
| --- | --- |
| CP-B1 | 40/80/120/180 列 × 深/浅：HUD 行无换行、无错位、无闪烁抖动；行数在工具开始/结束间稳定 |
| CP-B2 | 深浅两背景下 pastel 配色可读、可区分（与 CP-A2 呼应，但这里是宿主真实主题检测路径） |
| CP-B3 | `/hud palette theme` 后颜色跟随宿主主题；`mono` 无颜色；切换后 invalidate 生效 |
| CP-B4 | widget 模式：原生 footer 完整在场，与 HUD 无重叠/互相覆盖 |
| CP-B5 | footer 模式：接管后无第二套 footer；`/hud surface widget`、`/hud off` 后原生恰好恢复一次 |
| CP-B6 | footer 模式与原生 footer 的字段对照结论（第 3 节表逐行：哪些等价、哪些口径不同、哪些 HUD 缺失） |
| CP-B7 | working/waiting/ready/interrupted 在真实会话中的表现与第 1 部分一致 |
| CP-B8 | `/hud scope session`：sess* 标记、loading→出数、`/hud status` totals 与肉眼读数一致 |
| CP-B9 | 扩展状态区显示 pi-goal 真实状态字符串；长/多状态折叠可读 |

### 2.4 剩余实时协议场景（本阶段仍未覆盖，顺带观察即可，不要求构造）

流式回复进行中的 resize、A/B 测量中的实时压缩、abort/重试、第二个并发扩展 widget。这些仍列在 [VERIFICATION.md](VERIFICATION.md) 的待办清单，不因本手册完成而关闭。

## 第 3 部分：HUD footer 与原生 footer 字段对照速查

详细口径与缺口分析见 [默认 footer 决策记录](DEFAULT-FOOTER-DECISION.zh-CN.md)。观察时用此表逐行对照：

| 原生 footer 字段 | HUD footer 对应 | 预期差异 |
| --- | --- | --- |
| cwd（~ 缩写） | identity cwd | 等价 |
| git 分支（cwd 行括号） | `git:分支*` | 等价数据源；dirty 来自可选探测 |
| 会话标题（cwd 行 • 后） | identity 标题 | 等价数据源；折叠优先级不同 |
| ↑↓RW 四项 token | obs*（观察期）或 sess*（scope session） | observed 口径不含挂载前历史；session 口径=原生口径（含 partial 语义） |
| CH | CH（最近有效 assistant） | 失效规则不同（模型切换/压缩/reset 清除） |
| $cost | est*（观察期）或 sess* 费用 | 同上口径差异 |
| ctx% / window（实时估计） | ctx(last) 快照 | **口径不同**：HUD 是最近一次请求的观察值，非实时估计 |
| `(auto)` 自动压缩标记 | 无 | HUD 缺失（无公开来源） |
| `(sub)` 订阅标记 | 无 | HUD 缺失（无公开来源） |
| `xp` 实验标记 | 无 | HUD 缺失（无公开来源） |
| provider（多 provider 时） | identity provider | HUD 始终显示；原生仅 provider 数 >1 时显示 |
| 模型 + thinking | 模型 + thinking | 等价 |
| 扩展状态（单行拼接） | 独立状态区（≤2 行） | HUD 有界折叠，原生截断 |
| —（原生没有） | 工具分类、活动状态、中断计数、bridge agents/tasks、压缩次数、palette | HUD 独有 |

## 第 4 部分：结果记录模板

复制以下模板到新文件（建议 `docs/VISUAL-ACCEPTANCE-RESULTS.zh-CN.md` 或 issue/PR 描述），**由观察者本人填写**。agent 不得代填；`未覆盖` 是合法结果。

```markdown
## pi-hud 视觉验收结果

- 观察者：（姓名/账号）
- 日期：（YYYY-MM-DD）
- 终端 + 字体 + 字号：
- Node / Pi 版本：
- 执行的手册版本：docs/VISUAL-ACCEPTANCE.zh-CN.md @ <commit>

### 第 1 部分（合成着色预览）

| 背景 | CP-A1 | CP-A2 | CP-A3 | CP-A4 | CP-A5 | CP-A6 | CP-A7 | CP-A8 | CP-A9 | CP-A10 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 深色 |  |  |  |  |  |  |  |  |  |  |  |
| 浅色 |  |  |  |  |  |  |  |  |  |  |  |

（通过 ✅ / 不通过 ❌ / 未覆盖 ➖；不通过与未覆盖必须写明原因）

### 第 2 部分（真实会话，每宽度一行）

| 背景 | 宽度 | CP-B1 | CP-B2 | CP-B3 | CP-B4 | CP-B5 | CP-B6 | CP-B7 | CP-B8 | CP-B9 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 深色 | 40 |  |  |  |  |  |  |  |  |  |  |
| 深色 | 80 |  |  |  |  |  |  |  |  |  |  |
| 深色 | 120 |  |  |  |  |  |  |  |  |  |  |
| 深色 | 180 |  |  |  |  |  |  |  |  |  |  |
| 浅色 | 40 |  |  |  |  |  |  |  |  |  |  |
| 浅色 | 80 |  |  |  |  |  |  |  |  |  |  |
| 浅色 | 120 |  |  |  |  |  |  |  |  |  |  |
| 浅色 | 180 |  |  |  |  |  |  |  |  |  |  |

### 状态观察记录

| 状态 | 背景/宽度 | 结果 | 备注 |
| --- | --- | --- | --- |
| working |  |  |  |
| waiting |  |  |  |
| ready |  |  |  |
| interrupted |  |  |  |
| 上下文警戒 |  |  |  |
| usage loading |  |  |  |
| usage partial |  |  |  |
| usage unavailable |  |  |  |
| 扩展状态 |  |  |  |
| 长标题 |  |  |  |

### 总体结论（由观察者填写）

- 是否存在阻断问题：
- 非阻断问题清单：
- 对默认 footer 决策的输入意见：
```

## 边界

- 本手册不改变任何默认配置（widget + observed 保持默认），不要求网络/模型调用，不修改终端主题或其他 pane。
- 第 1 部分是合成 fixture 的渲染器真实输出，不是 Pi 会话；第 2 部分才是真实宿主观察。两者都完成后，本手册对应的待办才能关闭。
- 结果记录中的任何 ✅ 都必须来自真人实际观察；`tput cols`、`/hud status` 等命令输出可以粘贴为佐证。
