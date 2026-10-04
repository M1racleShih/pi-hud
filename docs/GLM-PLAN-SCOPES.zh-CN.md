# GLM 个人与团队套餐：查询作用域调研

日期：2026-09-19。状态：已核对上游源码与宿主接口；当前个人和团队凭据均已完成真实只读查询，并与对应控制台截图对照；功能尚未实现。

关联：[Provider 额度方案](PROVIDER-LIMITS-PLAN.zh-CN.md)。本文件属于首版 Z.ai / 智谱适配的必需设计输入。

## 结论

Pi 中分成两个 provider，只解决了本地配置选择问题。远端额度查询还必须明确套餐类型、组织、项目及对应凭据；不能只依据 GLM 模型名、相同 base URL 或显示名称判断。

已确认第三方客户端的团队查询实现使用同一 quota 路径，增加 `type=2` 和两个组织/项目请求头。新版个人积分套餐的请求契约尚不能仅凭旧官方脚本确定；需要独立验证 `type=1` 及组织/项目上下文。禁止团队失败后自动回退个人查询。

## 1. 证据与可信边界

| 来源 | 已确认内容 | 不能据此断言的内容 |
| --- | --- | --- |
| [智谱官方查询脚本](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs) | 原有查询为 GET quota/limit，Authorization 为原始 key，无 type 和组织/项目头 | 不能证明该旧路径覆盖当前所有个人积分套餐或团队套餐 |
| [官方 ZCode 连接说明](https://zcode.z.ai/cn/docs/configuration) | 个人套餐、按组织区分的团队套餐、API key 是不同连接方式；用量随连接切换；团队需要分配席位 | 未提供完整第三方额度 HTTP 契约 |
| [CC Switch 查询实现及契约测试](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/coding_plan.rs) | `query_zhipu_team_at` 发出 type=2 + raw Authorization + organization/project；缺项不发请求；测试捕获请求形状 | 本地 mock 测试不证明本次用户账号能成功，也不证明返回值是整个组织总额度 |
| [pi-glm-quota 作者发布说明](https://pi.dev/packages/pi-glm-quota) | 作者报告新版团队积分套餐需要 type/org/project；记录 CREDIT_LIMIT 和重置字段 | 文内把个人 type=1 同时描述为“疑似、未验证”和配置选项，不能提升为已确认接口事实 |

这些来源分别是供应商文档、官方脚本和客户端作者自己的实现/说明，不以转述文章作为请求契约。上游 main 仍会变化；实施前固定版本并补齐账号实测样本。

## 2. 请求差异

以下 URL 仅描述国内 BigModel；国际 Z.ai 的个人查询单独验证，不把国内团队参数直接移植到国际站。

| 查询模式 | URL query | 认证 | 组织 / 项目 | 验证情况 |
| --- | --- | --- | --- | --- |
| 旧个人模式 `personal-legacy` | 不带 type | 原始个人 API key | 旧官方脚本不携带 | 官方脚本与当前个人凭据实测均成功；已与用户提供的个人控制台截图对照百分比 |
| 新个人候选模式 `personal` | `type=1`，待实测确定 | 对应个人 API key | 是否必需、取值来源待测；若已配置则绑定到此个人 profile | 不得在未核对控制台前标为完成 |
| 团队模式 `team` | `type=2` | 对应团队 API key | `bigmodel-organization` + `bigmodel-project` | 当前团队 key + 用户提供 scope 实测成功，返回积分窗口且与截图吻合；未测试其他权限角色 |

团队请求形状（占位符，不含真实凭据）：

```http
GET /api/monitor/usage/quota/limit?type=2 HTTP/1.1
Host: open.bigmodel.cn
Authorization: <team-api-key>
bigmodel-organization: <organization-id>
bigmodel-project: <project-id>
Accept: application/json
```

查询接口按核对的 raw key 方式构造 Authorization，不能照搬推理接口的 Bearer 头。组织/项目头按名称大小写不敏感读取，值保留原样；ID 是不透明标识，不因示例中的连字符或下划线假设严格格式。

type 是 quota 请求参数，不是向模型推理请求随意添加的参数。HUD 不修改 Pi 的实际模型请求或套餐选择。

## 3. 从 Pi 映射到查询 profile

本地锁定 SDK 0.87.1 中，内置 `zai` 对应国际站，`zai-coding-cn` 对应国内站，两者不是“个人/团队”的区分。用户可用自定义 provider 或扩展区分个人/团队。

本次已定位本机 `~/.pi/agent/extensions/zai-providers.ts`，检查扩展时仅核对配置结构，未输出密钥；后续独立查询记录见第 6、8 节：

| 实际 provider ID | 当前注册方式 | 查询信息缺口 |
| --- | --- | --- |
| `zai-coding-cn` | 覆盖内置模型列表，沿用宿主认证；扩展注释说明使用 ZAI_CODING_CN_API_KEY | 已实测不带 type/org/project 成功；当前选择 personal-legacy |
| `zai-coding-cn-team` | 同一国内 Coding base URL，独立注册；apiKey 使用 `$ZAI_CODING_CN_API_KEY_TEAM` 环境变量引用 | 扩展未配置组织/项目；用户已另行提供并完成只读验证，实施时写入本地 HUD profile |

两者共享模型描述与兼容参数，没有把原始 key 写入该扩展。独立 key 能隔离调用身份，但不能从 key 名或 provider ID 反推出组织/项目 ID。

### TS 扩展与 models.json 的取舍

锁定 Pi SDK 随包文档 `docs/custom-provider.md` 明确支持 `pi.registerProvider()`；`docs/models.md` 也支持声明式 provider、模型和 headers 配置。使用 TS 不是绕过宿主的做法。当前扩展复用模型数组和兼容参数，保留它能避免重复维护两份目录。

若以后配置只剩静态 URL、key 引用和 headers，使用 models.json 会更直观；如需要共享模型定义或动态注册，扩展更合适。本任务不迁移用户的 provider 管理方式，也不修改该扩展。套餐订阅本身由服务商管理，扩展这里只是在管理不同调用入口。

推荐职责分工：现有扩展负责模型及实际调用身份；HUD profile 负责额度的 plan/queryMode 与缺失的 organization/project。宿主已有 scope 时校验并复用，避免维护两份冲突值；仅用于额度查询的参数不强行加入模型推理 headers。后续若设计自定义桥接，传递经验证的非敏感套餐元数据，凭据仍由宿主解析，不让 HUD 解析或执行扩展源文件。

核对 `ModelRegistry.getApiKeyAndHeaders(model)`、`ModelRuntime.getAuth(model)` 和 provider composer 后，宿主支持返回解析后的凭据及合并的 provider/model headers。因此查询身份应从当前 **model 对应的有效认证结果** 提取，不能只调用 `getApiKeyForProvider` 丢掉组织/项目上下文，也不能读取原始配置字符串后自行执行凭据命令。

首版增加多个 profile，逐个绑定精确 Pi provider ID；必要时再限定模型或 origin：

1. 用当前 provider ID 匹配显式 profile，profile 指定 `adapter`、`plan`、`queryMode`。
2. 从宿主有效认证结果提取当前 key，仅允许提取两个已知上下文头，不复制全部推理请求头。
3. HUD 中显式配置的组织/项目与宿主结果一致时接受；宿主缺失时可补齐，双方有值却不一致时返回 `scope-conflict`，不静默覆盖。
4. 若 mode=team，必须具有组织、项目和 key；缺项返回 `needs-scope`，不触网、不改查个人。
5. 仅存在组织/项目头不足以证明是团队，新个人模式也可能使用这些头。provider 名含 team 或请求成功同样不能替代套餐绑定。
6. 多个 profile 同时匹配时返回 `ambiguous-profile`；新版个人协议尚未确认时返回 `needs-verification`。只允许明确选定模式，禁止自动遍历 type 值试探。

建议配置结构（设计草案，当前版本不支持；provider ID 对应已检查的本机扩展，组织/项目为占位符）：

```json
{
  "version": 1,
  "quota": {
    "enabled": true,
    "profiles": [
      {
        "id": "glm-personal",
        "providerId": "zai-coding-cn",
        "adapter": "zai",
        "region": "cn",
        "plan": "personal",
        "queryMode": "personal-legacy",
        "source": "pi"
      },
      {
        "id": "glm-team",
        "providerId": "zai-coding-cn-team",
        "adapter": "zai",
        "region": "cn",
        "plan": "team",
        "queryMode": "team",
        "source": "pi",
        "organizationId": "<organization-id>",
        "projectId": "<project-id>"
      }
    ]
  }
}
```

上述配置已按本次个人查询结果采用 `personal-legacy`。新版候选 `personal` 的 type=1 和可选 scope 仍须另有相应账号验证后才能启用；本次不为已成功的个人账号试探其他 type。`plan` 与 `queryMode` 组合做 schema 校验，团队不能配成旧个人查询。个人 profile 也能配置自己的 organizationId/projectId；不能从团队 profile 继承。

一个适配器对应多个 profile，解决同一家服务商多个套餐的共存。实例缓存键至少包括 profile ID、provider ID、origin、plan/queryMode、组织、项目、凭据代次；若能取得账号/成员/席位标识，也纳入。对外只展示脱敏别名。

同账号不同模型仅在上述作用域全部一致时复用额度；模型级 headers 改变组织/项目时必须换缓存。切换 provider 后晚到的个人查询不得覆盖团队快照，反之亦然。

## 4. 返回数据不能直接叫“团队总额度”

团队请求带组织/项目，并不证明响应聚合了所有成员；它可能对应当前 key 所属成员/席位。验收前统一称“团队套餐（当前凭据作用域）”，不标“全团队剩余”。明确区分个人套餐额度、团队席位额度、组织汇总、项目预算及超额按量付费余额。

本次个人响应为 TOKENS_LIMIT，团队积分响应已实测为 CREDIT_LIMIT。按原始类型和单位解析，不把积分改名为 token。同一解析器可复用外层结构，但必须分别测试计量类型、窗口和套餐作用域。HTTP 200、空 data、空 limits 或“无套餐”错误不代表剩余 0，也不代表无限额度。

官方产品说明涉及团队席位与超额按量付费；首版只展示有数据依据的套餐池，不由套餐用尽推断余额或断言模型一定不能继续使用。

## 5. 关闭调研缺口的验收步骤

1. 已完成：找到实际个人/团队 provider 扩展，记录 ID、共同 origin 和缺少组织/项目 headers 的事实；不输出 key 和原始 headers。实施时重新读取宿主有效注册结果，不能只依赖本次静态源码检查。
2. 在同一登录账号的 BigModel 用量页分别选择个人套餐、目标团队，核对 quota 请求的 query、组织/项目和响应字段。只记录脱敏必要字段，不保存包含 cookie/token 的整份 HAR。
3. 用对应 provider 凭据进行只读 API 查询，比较服务端错误、计划档位、窗口、比例和重置时间；与相同 scope 控制台在相近时间核对。不能拿网页会话请求成功替代 API key 鉴权验证。
4. 明确个人当前使用旧模式还是 type=1 模式，个人 scope 是否必需；明确团队返回成员/席位还是组织汇总，以及成员 key 所需权限。
5. 测试个人/团队快速切换、多组织/项目、同 key 不同 scope、模型级 header 覆盖、缺 scope、冲突 scope、401/403、HTTP 200 业务错误和空数据；任何情况都不能回退到另一套餐。

首版验收必须分别有个人和团队的真实记录；国际个人站与国内个人站也分别记录。当前个人 API 查询已成功，个人控制台百分比对照已完成；团队 API 实测及字段对照也已完成。新版个人候选协议、其他角色/多组织、国际站及运行时隔离测试仍未完成。


## 6. 本次真实查询记录

2026-09-19 使用本机 `ZAI_CODING_CN_API_KEY` 对官方 quota/limit 发起一次成功的 GET 请求。未携带 type、组织或项目头，禁止重定向，设置超时和响应体上限；没有生成调用，也未修改宿主配置。首次沙箱网络请求被环境阻止，获得网络执行权限后完成查询；这不是服务商拒绝。

结果为 HTTP 200、业务 success=true、code=200，data 含 limits 与 level，返回三条记录。下表只保留结构，避免在文档中持久保存个人实时用量和绝对时间：

| 记录 | 实际返回的类型/窗口 | 字段特点 |
| --- | --- | --- |
| 5 小时 | TOKENS_LIMIT / unit=3 / number=5 | percentage、nextResetTime；未提供总额、已用数量或剩余数量 |
| 周 | TOKENS_LIMIT / unit=6 / number=1 | percentage、nextResetTime；未提供总额、已用数量或剩余数量 |
| 月工具池 | TIME_LIMIT / unit=5 / number=1 | usage、currentValue、remaining、percentage、nextResetTime、usageDetails |

由此确认：当前个人凭据可以用 personal-legacy 查询；前两个池只能展示服务端百分比与重置时间，不能从 TOKENS_LIMIT 名称推算精确 token 余量。工具池服务端整数百分比与数量直接相除的结果不完全相等，说明展示存在粒度/取整差异；应保留服务端值和原始数量，不擅自用某个字段覆盖另一个。随后用户提供的个人控制台截图中，三个窗口均明确标为“已使用”，百分比与此次 API 返回一致，确认当前个人模式 percentage 为已用百分比。重置时间受截图与查询时刻差异影响，需区分绝对时间与倒计时，不能要求文本逐字一致。

[官方老用户权益说明](https://docs.bigmodel.cn/cn/coding-plan/notice/usage-revision) 说明新旧计量版本并存，并把历史团队窗口额度明确写成“每席位”。因此增加 planVersion/metering（未知也可）作为可选描述；不能以查询模式或字段名强行判断订阅版本。该文档只确认产品按席位分配，不能替代对 quota 响应实际聚合范围的验证。

本机已确认团队 key 环境变量存在，但未找到组织/项目配置。本次没有用团队 key 调个人接口、没有省略 scope 试探团队接口，也没有读取浏览器登录状态。随后用户提供了团队组织/项目，已完成第 8 节所述查询。若新版个人套餐不是当前账号，本次不把其验证缺失当作当前个人查询失败。


## 7. 用户控制台截图对照

用户提供团队与个人用量页面各一张，均显示对应 quota 请求 HTTP 200；未将图片或其中的实时用量保存进仓库。

| 对照项 | 团队页面 | 个人页面 |
| --- | --- | --- |
| 页面上下文 | 团队编程套餐项目、“我的用量” | 默认项目、“用量统计” |
| 浏览器请求 | `https://bigmodel.cn/api/monitor/usage/quota/limit?type=2` | `https://bigmodel.cn/api/monitor/usage/quota/limit` |
| 展示口径 | 5 小时、周额度，标为已使用，数量单位为积分 | 5 小时、周、月度 MCP，标为已使用 |
| 与本次 API 的核对 | 已实测，两个百分比及页面显示的积分数量吻合 | 三个百分比与个人 API 一致 |
| 组织/项目请求头 | 截图未拍到，随后用户补齐且查询验证成功 | 同样未完整展示；已成功的个人 API 查询不需要这些头 |

团队截图的“我的用量”与团队 API 数值吻合，展示按当前成员视角处理，不标组织汇总。接口未返回明确的成员/席位标识，不额外推断其他成员的额度；枚举已由真实响应确认是 CREDIT_LIMIT。

浏览器控制台主机为 bigmodel.cn，之前个人 API key 实测主机是 open.bigmodel.cn。两者有相同路径不意味着鉴权相同；HUD 继续使用已验证的 API 主机，不复制网页 cookie 或切到网页主机请求。团队 API key 在 open.bigmodel.cn 上也已按该路径实测成功。

用户随后补齐了团队请求的 bigmodel-organization 和 bigmodel-project；未提供或使用网页 Authorization、Cookie 或完整 cURL。账号标识不落入仓库文档。


## 8. 团队真实查询结果与最终接入决策

2026-09-19，使用现有团队 key、用户提供的组织/项目以及 type=2，对 open.bigmodel.cn 的 quota/limit 做一次只读 GET。HTTP 200、success=true、code=200，返回两条 CREDIT_LIMIT，分别为 unit=3/number=5 和 unit=6/number=1；对应 5 小时和周窗口。没有返回月工具池，不合成不存在的桶。

两条记录都有 usage、currentValue、remaining、percentage、nextResetTime。已用百分比与团队截图一致，总额及已用积分也与页面精简显示吻合。团队凭据查询与个人查询已分别验证，不需要 cookie、网页 token 或修改现有 provider 扩展。

另发现两个桶均存在 `remaining != usage - currentValue`，相差一个积分单位。原因未确定，不能假定字段有误、通过本地算术“修复”，也不把这一差异判为坏响应。HUD 直接展示 remaining 和服务端 percentage，分别标明剩余积分及已用/剩余比例；若未来缺少 remaining，只有确认数量定义和精度后才考虑显式标记的估算。不可反推套餐总量。

最终当前用户接入映射：

| Pi provider | 查询模式 | 额外 scope | 显示语义 |
| --- | --- | --- | --- |
| zai-coding-cn | personal-legacy，不带 type | 当前实测不需要 | 个人套餐的服务端百分比与重置时间，工具池有数量时另显示 |
| zai-coding-cn-team | team，type=2 | 用户指定组织与项目，绑定此 profile | 团队套餐（我的用量）的积分、比例与重置时间 |

运行时仍须按 key、profile、组织、项目隔离缓存。禁止从默认个人 key 环境变量覆盖当前团队 provider 的有效凭据。组织/项目的实际值仅用于本次请求，未写入仓库或修改用户 Pi 配置；功能实现时通过用户级配置保存。

本轮已关闭“当前个人/团队如何分别查询”的调研缺口。尚未证明其他套餐版本、成员权限、国际站适用性；这些保留为对应适配的独立验收项，不能泛化当前账号成功结果。


## 9. GLM 实施契约

### 请求构造

已验证的国内模式只允许 origin 为 `https://open.bigmodel.cn`，固定 GET 路径 `/api/monitor/usage/quota/limit`；不从 model.baseUrl 直接拼接任意网络目标。

- personal-legacy：省略 type，使用当前个人 provider 有效 key；当前配置不添加组织/项目头。
- team：固定 type=2，使用当前团队 provider 有效 key，并携带绑定 scope 的组织/项目头。
- 两者均采用 raw Authorization；从宿主取原始 apiKey 重新构造，不能复制生成接口中的 Bearer Authorization。
- 缺少原始 key 时返回 needs-auth，不从用户的默认个人环境变量兜底。不读取 auth.json 或执行 provider TS 来绕过宿主解析。
- 不实现“先个人再团队”或遍历 type 的自动发现。首版候选 type=1 只保留配置诊断，未验证前不发送请求。

### 返回映射

| 原始字段 | 归一化字段 | 规则 |
| --- | --- | --- |
| data.limits[].type | meterKind | TOKENS_LIMIT → quota-percent；CREDIT_LIMIT → credits；TIME_LIMIT → tools；不能把 TOKENS_LIMIT 自动解释为 token 数量 |
| unit + number | window | 已核对 unit 3 为小时、6 为周、5 为月，number 为数量；未知组合保留未知窗口，不套用默认值 |
| percentage | usedPercent | 有限数值且位于 0–100 才接受；0 合法；缺失/非法时仅该字段未知 |
| 100 - percentage | remainingPercent | 派生的服务端显示比例补数，不据此推算 remaining 或 limit |
| usage | limit | 已验证 CREDIT_LIMIT 为积分总额，TIME_LIMIT 为工具池计数；其他类型不盲目应用 |
| currentValue | used | 保留原值，不为满足算术关系修改 |
| remaining | remaining | 优先使用原值，缺失时显示未知，不相减补造 |
| nextResetTime | resetAt | 已观察为 epoch 毫秒；必须为有效时间值，缺失不推算；渲染使用本地时区并标明跨日日期 |
| data.level | planLabel | 可选、长度受限及文本净化；不依据档位名决定个人/团队，也不推断套餐版本 |

不保留原始 usageDetails 大对象；首版只显示聚合工具池。相同 type/unit/number 的重复桶不能静默相加；优先采用服务端稳定桶 ID（若有），没有则标记歧义并避免错误合并。未返回的工具池不创建空占位。

### 合成样本要求

将以下结构转为未来 parser fixture；数值为专门构造，非用户数据，不携带账号信息。个人 fixture 至少包含 TOKENS_LIMIT 的小时/周桶、TIME_LIMIT 工具池和缺少数量的情形。团队 fixture 示例：

```json
{
  "code": 200,
  "success": true,
  "data": {
    "limits": [
      {
        "type": "CREDIT_LIMIT",
        "unit": 3,
        "number": 5,
        "usage": 1000,
        "currentValue": 123,
        "remaining": 876,
        "percentage": 13,
        "nextResetTime": 1893456000000
      }
    ]
  }
}
```

上述样本特意保留三个不同值：已用比例 13%、剩余积分 876、总额减已用 877。验收必须得到服务端剩余 876，不得“修正”为 877；显示剩余比例时是服务端百分比补数 87%，不能把积分数量除总额的结果覆盖它。详情说明百分比和数量由服务商分别提供，可能存在精度差异。

### 显示与交互

主 HUD 必须显示套餐身份，例如“GLM 个人”与“GLM 团队”，不能两者都只显示同一模型名。5 小时和周窗口固定排序，工具池放详情。当前团队数据对应“我的用量”，默认不展示组织总额标签。

足够宽时可显示“团队 · 5h 剩余 87% · 周剩余 64%”；详情显示“剩余 876 / 总额 1000 积分”、最后更新时间与重置时间。示例均为合成值。数值较长时使用短格式，完整数字在详情可见。个人没有数量时只显示百分比，不能显示“剩余 token”。

### 必须通过的回归场景

| 场景 | 期望 |
| --- | --- |
| 个人切到团队，个人请求晚到 | 当前 HUD 仍为团队；个人响应不能覆盖 |
| 同一 key、不同组织或项目 | 生成不同身份缓存；不复用额度 |
| 团队 scope 缺失/冲突 | 不触网，显示具体配置状态；不查个人 |
| 宿主模型 headers 覆盖了 scope | 按有效模型身份解析；与显式 profile 冲突则停止 |
| 个人默认环境变量与团队 key 同时存在 | 使用宿主当前团队认证，不采用全局个人兜底 |
| percentage=0 / remaining=0 | 正常显示零，不误判缺失 |
| 数量不满足总额减已用关系 | 保留服务端 remaining，解析仍成功 |
| 200 + success=false、空 data/limits | 明确失败/未知，不能显示满额或 0 |
| 未知类型或畸形单桶 | 忽略该桶并标 partial；全无有效桶则协议错误 |
| 重置已到、超时、401/403/429 | 按主方案的过期与错误规则处理，不自动满额 |
| 配置重载、关闭、退出 | 取消任务，generation 隔离晚到结果 |

上述回归应使用注入的 HTTP/时钟/认证解析器执行；真实账号只用于单独的只读 smoke 验证，不在 CI 中请求线上接口。
