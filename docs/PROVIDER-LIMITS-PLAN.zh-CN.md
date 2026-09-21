# Provider 套餐额度与 API 余额方案

状态：阶段 A 首切片已实现（2026-09-21：公共额度基础 + GLM 国内个人/团队两 profile，默认关闭；证据见 [VERIFICATION](VERIFICATION.md) 的额度章节与 [quota-live-e2e.json](quota-live-e2e.json)、[quota-tui-stream.json](quota-tui-stream.json)）。其余五类适配器仍为设计态。调研日期：2026-09-19。目标宿主：Pi 0.85.1。

本文件确定首版范围、接入方式和验收标准；除已标注实现的切片外，不代表当前版本已具备这些能力。已核对本地源码、Pi SDK 类型、官方文档及部分官方客户端源码；已对当前 GLM 个人和团队凭据分别完成真实只读查询，并与对应控制台截图对照；其他服务尚未完成账号验证。上游 main 分支链接是调研依据，实施时必须记录实际版本或 commit，并保存脱敏响应样本。

## 1. 目标与首版范围

当前 provider 使用 Coding / Token Plan 时显示套餐剩余额度、窗口及重置时间；按量付费 API 在有可信接口时显示账户余额。保持现有上下文快照、已观察 token、估算费用的独立含义。

首版包含六类适配器：**MiniMax Token Plan、Z.ai / 智谱 Coding Plan、Codex 订阅、Gemini CLI / Code Assist、DeepSeek API、硅基流动 API**。Z.ai、Codex、Gemini 均是首版实施和验收任务，不仅是后续候选。

| 首版适配器 | 展示内容 | 接入依据与边界 |
| --- | --- | --- |
| MiniMax Token Plan | 套餐窗口剩余比例、重置时间；有返回时展示额外积分 | 官方 `token_plan/remains`；中国与国际站分别配置，不能混用凭据 |
| Z.ai / 智谱 Coding Plan | 个人、团队套餐各自的窗口、工具配额及比例 | monitor quota 接口；独立 profile 绑定套餐类型及组织/项目；Z.ai 和 BigModel 分别验证 |
| Codex 订阅 | 各 limit bucket 的用量比例、窗口及重置时间 | 首版采用官方 Codex App Server 协议，需要已安装且已登录的 Codex；核对其账号与 Pi 的关联 |
| Gemini CLI / Code Assist | 模型配额桶的剩余比例、重置时间；单位明确时显示剩余数量 | Google 登录 / OAuth 路径；官方 CLI 内部 quota 接口，标记实验性兼容能力 |
| DeepSeek API | 账户余额、币种；可选充值/赠送分项 | 官方 `/user/balance` |
| 硅基流动 API | 可用账户余额及分项 | 官方 `/v1/user/info`；明确各余额字段含义后归一化 |

Gemini 纳入首版的依据是官方 CLI 确有额度查询实现，不代表已证明所有 Google 账号均可访问。**不包含 Gemini Developer API / AI Studio API key 的余额、Vertex AI 账单、Gemini 网页聊天套餐或 Antigravity 额度。**这些产品不得互相代用数据。

OpenRouter 留作下一批：账户 credits 需要 management key，普通 key 的剩余额度只能标为 key 额度。OpenAI / Anthropic API 余额、Claude 订阅、Kimi、其他云平台和中转服务暂不纳入首版。无数据来源时显示“不支持查询”，不从会话费用推算余额。

## 2. 已确认的数据来源

### MiniMax

[官方 FAQ](https://platform.minimax.cn/docs/token-plan/faq) 提供 `GET /v1/token_plan/remains` 和 Bearer API key 示例，说明套餐存在 5 小时与周窗口、额外积分。按当前区域文档锁定完整主机，不跨区域试发 key。实施前验证响应字段、套餐 key 与普通 API key 的差异；未返回的重置时间不得猜测。

### Z.ai / 智谱

个人/团队查询需要独立处理，详见 [GLM 套餐作用域专项调研](GLM-PLAN-SCOPES.zh-CN.md)。已核对的团队实现使用 `?type=2` 和 `bigmodel-organization`、`bigmodel-project` 请求头。新版个人候选 `type=1` 及其上下文要求尚待账号实测；下述官方脚本只证明旧请求模式，不能作为所有套餐的统一实现。当前个人不带 type、团队 type=2 + 组织/项目的查询均已实测成功；团队响应为 CREDIT_LIMIT，remaining 与总额减已用存在微小差异，必须使用服务端原值。首版必须覆盖个人与团队共存、切换及缓存隔离，团队失败不得回退个人查询。

[官方查询脚本](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs) 使用 `GET /api/monitor/usage/quota/limit`，支持 `api.z.ai` 和 `open.bigmodel.cn` 等主机，并把凭据原样放入 Authorization。适配时核对原始 key 格式，不能统一擅加 Bearer。只查询所需 quota，不复制脚本额外的历史用量请求。

脚本展示 `limits`、`type`、`percentage` 等字段；枚举名不能证明其单位就是原始 token。窗口、比例方向、周额度及重置字段需结合真实响应和控制台核对，不把旧脚本中的 5 小时标签套到所有记录。[官方 ZCode 说明](https://zcode.z.ai/en/docs/usage-stats) 确认存在多种配额池，但不是完整第三方 API 契约。

### Codex

[官方 App Server 文档](https://developers.openai.com/zh-Hans/docs/app-server) 定义 `account/rateLimits/read`、`account/rateLimits/updated`，以及 `usedPercent`、`windowDurationMins`、`resetsAt` 等字段。按返回的 limit ID 保存多桶数据，不硬编码仅有 5 小时和一周，也不猜测模型到桶的对应关系。

首版选择官方协议作为稳定接入边界：用户显式选择 Codex 登录源；通过固定参数启动受控的 `codex app-server` stdio 子进程，完成版本对应的初始化、账号读取、额度读取后结束，不创建 thread/turn、不调用模型。每次检查有超时、输出上限及取消机制。缺少可执行文件或登录时给出明确状态。

Pi 的 Codex OAuth 与本机 Codex 登录可能属于不同账号。能验证身份时校验账号；不能验证时要求配置显式绑定，并在详情中标明“Codex 登录源，未自动核验与 Pi 同账号”。不得默默把另一账号的数据挂在当前 provider 下。直接复用 Pi OAuth 请求非公开 usage HTTP 接口不是首版默认方案。

### Gemini

[Google 官方 CLI server 源码](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/server.ts) 包含 `retrieveUserQuota`：向 `cloudcode-pa.googleapis.com` 的 `v1internal` 服务发出查询。[类型定义](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/types.ts) 显示请求需要 project，响应包含模型配额桶及剩余比例、重置时间等可选字段。

首版以 Pi 已配置的 Gemini CLI / Code Assist OAuth 身份为凭据来源，取得对应 access token 与 project 后调用查询；OAuth 刷新由宿主负责，不另写一套刷新与凭据持久化。如果 Pi 的公开认证结果不足以取得这些字段，先实现最小宿主桥接；明确返回缺少身份/project 的状态，不能回退到另一个 Google 账号。

这是官方客户端使用的内部接口，不能称为稳定公开 API。适配器须隔离实现、固定参考版本并具备协议变更降级。仅在服务端返回值有效时显示剩余比例；缺少单位时只显示比例，不把 remainingAmount 自动标成 token，不推算总额度。

[Gemini API 计费文档](https://ai.google.dev/gemini-api/docs/billing) 将余额管理放在 AI Studio Billing；本次未确认可用普通 API key 查询余额的公开接口，因此该路径不承诺余额展示。

### API 余额

[DeepSeek 文档](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/) 提供余额查询；[硅基流动文档](https://siliconflow.readme.io/reference/user-info) 提供用户余额信息。均通过对应 provider 的 API key 认证，保留服务端币种与金额语义。金额采用十进制字符串或明确精度的表示，避免浮点累加与重复加总充值、赠金、总额。

后续 [OpenRouter credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits) 与 [key 信息](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key) 分别映射账户余额和 key 限额，不合并为一个余额值。

## 3. 架构与宿主接入

当前 [extension.ts](../src/extension.ts) 负责生命周期，[state.ts](../src/state.ts) 只保存会话观察量，[render.ts](../src/render.ts) 渲染缓存快照。Pi SDK 的 `modelRegistry` 提供 provider、认证状态、`getProviderAuth` 和 `getApiKeyAndHeaders` 等入口，但这些方法本身不保证包含额度查询需要的全部字段。

新增模块建议：

| 模块 | 职责 |
| --- | --- |
| `src/quota/types.ts` | 身份、能力、额度桶、余额与错误状态 |
| `src/quota/identity.ts` | provider / base URL / 认证方式 / 账号项目解析与显式绑定 |
| `src/quota/service.ts` | 缓存、请求调度、去重、退避、取消、生命周期隔离 |
| `src/quota/transport.ts` | 有界 HTTP 查询；固定端点及重定向策略 |
| `src/quota/codex-process.ts` | 固定协议的短生命周期 App Server 子进程 |
| `src/quota/adapters/*.ts` | 六类服务的检测、查询及响应归一化 |

数据流：低频事件 → 身份匹配 → 后台额度服务 → 有界快照 → 现有合并发布器 → HUD 缓存行。事件回调不 await 网络或子进程；渲染不解析凭据、不做 I/O。

查询身份按 profile ID、provider、规范化 origin、认证类型、套餐/查询模式、账号、组织、项目及凭据代次区分。模型还可能携带覆盖后的组织/项目 headers，必须从当前模型的有效认证结果解析；只有作用域完全相同时才跨模型复用缓存。无法取得稳定账号 ID 时采用挂载期不透明标识，凭据变化使旧缓存失效；不将原始密钥作为可输出的缓存 key。

现有观察计数 reset 与远端账户数据分离：`/hud reset` 不伪造远端额度归零。会话关闭、HUD 关闭、配置重载和身份切换取消相关任务，用 generation token 丢弃晚到结果。

## 4. 数据语义和状态

统一结果允许同时包含套餐窗口与额外 credits，不以“订阅或余额”二选一限制数据模型：

- 身份：provider、来源、账号/项目的不透明标识、认证类型、身份是否已核验。
- 额度桶：稳定 ID、标签、适用模型/共享池、可选 used/remaining/limit、明确单位、可选剩余比例、重置时间及窗口长度。
- 余额项：金额、币种或 credits 单位、作用域（账户/key/项目）、是否可用于当前服务。
- 元数据：服务端数据时间（若有）、本地获取时间、过期时间、来源稳定性、截断标记。
- 状态：`disabled`、`loading`、`ready`、`stale`、`unsupported`、`needs-auth`、`needs-project`、`needs-scope`、`scope-conflict`、`ambiguous-profile`、`needs-verification`、`identity-unverified`、`rate-limited`、`error`。

只在单位及同一配额池关系明确时做换算；多个共享模型桶不相加。已用比例到剩余比例的转换须经各适配器验证。缺少字段就是未知；零是合法值，无限/不适用是独立语义。无余额不等于查询失败；服务端允许负余额时保留其值。

错误状态与最后一次成功数据分别保存。过期值标明旧快照及时间；401/403 时不把旧值显示成当前可用额度。到达重置时间只使该桶失效，不直接显示已恢复 100%。无关桶仍可继续展示。

## 5. 刷新与性能边界

默认关闭。启用后只在 TUI 模式查询；无 UI 模式不解析认证、不创建额度任务。

- 触发点：首次启用、provider/身份切换、`agent_settled`、用户手动刷新。
- 默认缓存 TTL 5 分钟；TTL 到期不主动联网，等待下一事件。无空闲轮询，详情始终显示更新时间。
- 手动刷新可越过 TTL，但仍遵守至少 30 秒冷却和服务端 Retry-After；不通过反复命令绕过限流。
- 全局最多 2 个任务并发，每身份单飞；最多 16 个身份缓存，每身份最多 32 个桶；超出时截断并标注。
- HTTP 默认 5 秒超时、响应体上限 256 KiB；Codex 查询总期限默认 10 秒，协议单帧与总输出分别限额。
- 429/网络错误采用有上限的退避，下次符合条件的事件才重试；401/403 等待身份变更或明确手动重试。
- 超时覆盖认证解析、查询和子进程整个链路；宿主认证调用无法中止时仍需隔离晚到结果并抑制重复调用。
- 快照过期可复用单次失效调度，不为倒计时增加秒级重绘；优先显示绝对重置时间。

本阶段数值是实施默认值，需经过基准验证；不把现有 HUD 的 250 ms 渲染刷新间隔当成查询频率。

## 6. 配置与交互

向现有 version 1 配置增加可选 `quota` 节；旧配置行为不变。下列是设计示意，当前版本会拒绝这些字段，不能当作已支持的配置使用：

```json
{
  "version": 1,
  "quota": {
    "enabled": true,
    "ttlMs": 300000,
    "timeoutMs": 5000,
    "profiles": [
      { "id": "glm-personal", "providerId": "zai-coding-cn", "adapter": "zai", "region": "cn", "plan": "personal", "queryMode": "personal-legacy", "source": "pi" },
      { "id": "glm-team", "providerId": "zai-coding-cn-team", "adapter": "zai", "region": "cn", "plan": "team", "queryMode": "team", "source": "pi", "organizationId": "<organization-id>", "projectId": "<project-id>" },
      { "id": "codex", "providerId": "openai-codex", "adapter": "codex", "source": "codex-app-server" }
    ]
  }
}
```

`adapter` 是逻辑适配器，`providerId` 精确绑定 Pi 原生或自定义 provider；上例 GLM ID 对应本次检查的用户扩展。采用多个 profile 而非每个服务商一个配置，允许个人和团队并存。保留现有 TS provider 注册方式，HUD 不读取其源码，也不改动模型请求。当前个人示例已按真实成功请求选用 personal-legacy；新版个人 queryMode 仍需单独验证，不能假定可直接使用。区域、project、Codex 可执行路径与账号绑定配置在接口验证阶段定稿。配置只保存必要参数或环境变量引用，不写原始 key、refresh token、cookie；组织/项目等账号上下文不提交到公共仓库。

拟新增命令：

| 命令 | 行为 |
| --- | --- |
| `/hud quota on\|off` | 内存中启停额度功能；关闭立即取消任务 |
| `/hud quotas` | 查看已配置身份的缓存、来源、时间和不可用原因；不默认遍历查询所有账号 |
| `/hud quota refresh` | 查询当前身份，遵守冷却与退避 |

HUD 默认只显示当前 provider。保持 minimal/balanced/full 固定 1/2/3 行；窄屏裁剪低优先级信息，详细桶列表放在命令输出。套餐剩余和上下文占用使用不同标签；金额保留币种。示例数值为合成数据：

```text
Z.ai 套餐 · 5h 剩余 72% · 周剩余 41%
Codex 套餐 · 剩余 64% · 16:30 重置
Gemini Pro 配额 · 剩余 82% · 09:00 重置
DeepSeek 余额 ¥128.50
额度快照已过期 · 12 分钟前更新
```

## 7. 凭据与现有约束的调整

凭据优先经 Pi 公共接口解析。只有已匹配的服务商固定 HTTPS 主机可以接收相应凭据；自定义中转地址不自动套用官方适配器。区域按配置选择，不把 key 轮流发送到不同域名。禁止跟随跨主机认证重定向，主机使用 URL 精确匹配而非字符串包含判断。

不读取浏览器 cookie，不发送提示词、代码、transcript，不发模型请求来“探测”额度。诊断仅记录脱敏状态、时间和错误码，不能输出 token、headers、原始认证结果或错误响应全文。Codex 子进程使用固定可执行程序和参数，不拼接 shell，不自动登录、安装或更新 CLI。

实施时同步更新 [架构](ARCHITECTURE.md)、[安全说明](../SECURITY.md)、双语 README、配置 schema 和性能说明：将“无网络/不读取凭据”限定为默认关闭额度功能时的行为。保留零 npm 运行时依赖；启用 Codex 适配器存在外部 CLI 运行前提，需单独说明。

[check.mjs](../scripts/check.mjs) 当前禁止 `fetch` 且仅扫描 src 顶层。实现时改为递归检查并仅为指定 transport/process 模块放行必要能力；不能全局删除网络与热路径限制。配置、认证、网络测试均通过依赖注入，CI 不需要真实凭据。

## 8. 实施阶段与验收

### 阶段 A：六类接口与身份验证

为每个适配器固定上游参考版本、确认 Pi provider ID/认证结构，记录请求方法、主机、权限、响应口径和脱敏样本。优先解决 GLM 个人/团队的 type 与组织/项目作用域、积分单位和比例方向、Codex 登录绑定、Gemini token/project 获取。GLM 当前个人和团队的成功查询已完成，优先据此实现；新版个人 type=1 保持待验证状态，不能借用旧个人结果宣称支持。国际站和其他权限角色分别验收，详见专项调研。

使用专门的只读查询验证，不发生成请求。没有相应测试账号时标记“待实测”，不能据 mock 宣称支持完成，也不能默默移出首版范围。范围变化须明确记录。

### 阶段 B：公共基础设施与 API 余额

实现身份解析、传输层、调度缓存、状态模型；完成 DeepSeek 和硅基流动两条余额链路，用于验证币种、零/负余额、缓存与错误降级。

### 阶段 C：四类套餐适配

实现 MiniMax、Z.ai/智谱、Codex、Gemini。各自验证多窗口/多桶、缺失字段、共享额度、重置、账号切换与认证失效。Codex 验证协议初始化、进程退出、取消、未安装/未登录；Gemini 验证内部接口变化、project 缺失与不支持的 API key 路径。

### 阶段 D：展示、文档及发布验收

- mock/fixture 测试覆盖有效数据、部分数据、坏响应、超时、401/403/429、重定向、超大响应、晚到结果及并发上限。
- 生命周期测试确认 off、shutdown、非 TUI、身份变化后无残留任务；未启用时无认证访问或额外网络/进程。
- 渲染验证固定行数、窄屏、中英标签、零值、过期状态，以及额度与上下文的明确区分。
- 运行 `npm run check`、`npm test`、`npm run bench -- --check`、`npm run package:check`，以及锁定 Pi SDK 契约检查。
- 真实 TUI 验证开启/关闭的流式交互体验；分别记录后台查询开销与渲染开销。
- 六类适配器均需有真实账号查询证据，并与相同账号/项目控制台在相近时间核对。Gemini 即使验收通过，仍标明内部接口兼容性属性。

首版完成标准：六类适配器在各自声明的认证与区域范围内可用，失败能解释且不误报剩余额度；默认关闭时保持现有行为与性能约束。真实账号验证缺失、身份不匹配或接口契约未核实均属于未完成项。


## 9. 配置契约与实例选择

以下为拟实现契约；当前配置 schema 尚不接受 quota。全局 quota.enabled 默认 false；profiles 默认空数组。启用但未配置匹配实例时仅显示“未配置额度来源”，不自动读取所有 provider 的凭据。

| 字段 | 约束与职责 |
| --- | --- |
| profiles[].id | 挂载内唯一，1–64 字符；缓存与诊断使用的实例别名 |
| providerId | 精确匹配 Pi 当前模型的 provider ID，不以字符串前缀猜测 |
| adapter | zai / minimax / codex / gemini-cli / deepseek / siliconflow 之一 |
| source | pi 或 codex-app-server；与适配器做组合校验 |
| enabled | 单个实例默认 true；全局关闭优先 |
| region | 有区域差异的适配器必须明确配置；GLM 当前 cn，国际站 global 单独验证 |
| plan / queryMode | GLM 必填；personal + personal-legacy、team + team 为已验证组合；候选 personal 模式在未验证前不可查询 |
| organizationId / projectId | 仅作为查询上下文；组织/项目缺项与不匹配须显式报错 |
| modelIds | 可选精确模型 ID 列表，用于同 provider 下进一步匹配；不接受可执行表达式 |
| origin | 可选约束当前模型有效 origin，必须与适配器固定域名表吻合；不是任意查询 URL |

最多 16 个 profile，字符串及 modelIds 列表有上限，沿用 32 KiB 配置读取限制。未知字段、重复 ID、非法组合与非法类型拒绝加载；保持上一份有效配置。多个启用 profile 匹配当前模型时不按列表先后选择，而是显示 ambiguous-profile。未启用的实例不参与冲突判断。

GLM 团队可从宿主已解析 headers 取得 scope，也可由 profile 补齐。显式配置与有效 headers 不一致时查询停止；header 名大小写不敏感，重复大小写名称却有不同值也视为冲突。ID 值禁止控制字符，不按 org-/proj_ 等示例前缀猜测有效性。

首版在用户级 pi-hud.json 中保存 profile 配置；不新建第二个认证存储，不自动写入用户配置，不将实际组织/项目放入仓库示例。CLI on/off 等变更仍仅在内存生效。当前团队组织/项目已完成验证，部署配置时使用对应真实值即可，无需更改 zai-providers.ts。

## 10. 解析、错误及缓存契约

一次任务依次完成：选择 profile → 宿主认证解析 → scope 校验 → 身份代次确认 → 缓存/冷却检查 → 查询 → 解析 → 归一化 → 发布。不能仅因 provider ID 相同就在认证解析之前复用另一凭据的缓存；也不能为判断缓存是否过期频繁解析凭据。低频事件只标记待检查，调度器合并后最多执行一次认证解析。

适配器只返回归一化的数据或结构化失败，不把原始请求/响应交给状态层。建议内部结果分离：

- lifecycle：idle / loading / ready / stale；描述数据生命周期。
- issue：可选的错误/缺配置代码、可重试性、最早重试时刻。
- lastSuccess：独立成功快照及时间；失败不把额度重写为 0。
- identityGeneration：请求所绑定的身份代次，必须与当前代次一致才能发布。

第 4 节的状态名是用户可见状态集合，实现时不把“旧数据仍存在”和“本次鉴权失败”挤成互斥枚举。

| 情况 | 处理 |
| --- | --- |
| 无凭据、缺 scope、配置冲突 | 不发送请求，说明缺失项；不回退其他 profile |
| HTTP 401 | needs-auth；隐藏作为当前有效值的旧额度，保留带时间的历史诊断 |
| HTTP 403 | 显示权限或 scope 不可用；不武断认定 key 已过期 |
| HTTP 429 | rate-limited；解析合法 Retry-After，结合本地退避；手动刷新也不能跳过 |
| HTTP 200 但业务 success=false / 非成功 code | 业务失败；使用脱敏分类，不发布 data 为成功快照 |
| 空 data 或空 limits | unknown/no-data 类错误，不能当无限、0 或“没有套餐”的确定结论 |
| 部分合法桶与未知类型 | 保留合法桶，标记 partial；未知类型忽略并计数，不使其他桶失真 |
| 全部桶无效或 JSON/体积不合法 | 协议错误；保留已过期的 lastSuccess，等待事件驱动重试 |
| 重置时间已到 | 该桶失效；下次符合冷却要求的事件重新查询，不把数值改成满额 |

缓存为内存缓存，不持久化账号快照。容量满时淘汰非活动 LRU 项；当前活动查询单飞，队列也有容量上限。未知桶数量超限时记录截断，不能把截断后的列表称为全部额度。敏感凭据只在请求所需期间保留；诊断输出不含其值或稳定凭据指纹。

## 11. GLM 首个实现切片

先完成已实测的两个国内 profile，以验证同 provider 家族多个计费身份共存，再将公共能力用于其余首版适配器。此顺序不改变六类首版范围。

具体字段映射、合成样本和回归验收见 [GLM 实施契约](GLM-PLAN-SCOPES.zh-CN.md#9-glm-实施契约)。这两条成功路径不再依赖新的账号调研即可编码；运行时身份解析、取消和布局仍需测试。未经验证的 type=1 不作为已知个人套餐的替代路径。

## 12. 完成度与后续交付

| 项目 | 当前状态 | 后续交付 |
| --- | --- | --- |
| GLM 国内个人旧查询 | API 成功并与控制台对照 | 身份绑定、解析器、UI 与回归测试 |
| GLM 国内团队查询 | API 成功并与控制台对照 | 独立 scope/profile、积分展示与缓存隔离 |
| GLM 新个人 type=1 / 国际站 | 待相应账号验证 | 独立契约与证据，未完成前明确不可用 |
| MiniMax、Codex、Gemini、DeepSeek、硅基流动 | 已有文档或源码接入依据，未完成本项目账号实测 | 逐项完成阶段 A–D |
| 公共查询框架及配置 | 本文件确定设计，尚未编码 | schema、宿主契约、限流缓存、取消及诊断 |
| 真实 HUD 体验 | 尚未验收 | 固定行数、切换与流式交互 A/B |

方案完成不等于功能完成。实现 PR 应按最终声明的服务、认证方式、区域和套餐模式列出证据；未验证部分保持显式状态，禁止以某个账号的一次成功覆盖所有套餐。
