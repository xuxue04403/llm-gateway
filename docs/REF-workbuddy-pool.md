# 参考评估：`dsh-connect-workbuddy-models`（WorkBuddy 多账号模型池）

> 评估对象：https://github.com/DragonHorizon-xtihc/dsh-connect-workbuddy-models
> 版本 0.1.1 / MIT / 2026-10-30 拉取（commit 为当时 `main`）。本地下了一份只读副本在 `_scratch/wb-pool-repo/`。
> 结论一句话：**它不是本网关的竞品，而是一份「把上游额度当资源来经营」的成熟实现**——
> 值得抄的是账号池的排序/冷却/判断生死的口径，以及「每个失败都给出不同、可执行的出口」这条纪律；
> 不值得抄的是它为了接进 DSH 而必须存在的插件脚手架与第二层回环代理。

## 1. 它是什么

DSH 插件（peer 依赖 `@deepseek-ai/dsh-llm` / `dsh-llm-pi-ai` / `dsh-settings` / `dsh-host-webserver`，0.1.7-rc 线）：
把本机 WorkBuddy 桌面端的**所有历史登录**收成一个账号池，注册成 DSH 的两个 provider
（`workbuddy-models` 国内 / `workbuddy-models-global` 国际），池内自动换号，并附带签到、积分、
到期、倍率、促销徽标、输入框下方读数。

规模与质量证据（这些数字比功能列表更能说明问题）：

| 项 | 值 | 出处 |
| --- | --- | --- |
| `src/` 代码量 | 12,868 行 / 25 个文件 | `Get-ChildItem src -Recurse` |
| 测试量 | 37 个文件 / 12,091 行（≈1:1） | `tests/` |
| 构建产物 | `lib/index.js` 300 KB、`lib/client.js` 156 KB **直接入库** | `package.json` / `lib/` |
| 文档 | `README.md` 272 行 + `DESIGN.md` 289 行，每条结论标注参考插件路径与行号 | `DESIGN.md:1-6` |

它的 `DESIGN.md` 开头写着「本文档是团队成员的共享契约……不要凭记忆修改任何一条，改动前先回源核对」，
并且绝大多数函数上方注释都在说明**这个写法挡住了哪个已发生的缺陷**（例如
`src/status-paths.ts:798-812` 解释为什么临期窗口必须来自用户配置、`src/scheduler.ts:1-20`
解释日界必须先于消费滚动）。这是我们 `docs/AUDIT.md` 的写法，但密度更高。

## 2. 与 llm-gateway 的关系

| 维度 | 本插件 | 本网关 |
| --- | --- | --- |
| 入口 | DSH 进程内 provider（pi-ai 适配器 + 回环 shim） | 独立进程 + HTTP 端口（OpenAI/Anthropic 两种协议） |
| 覆盖 | 只有 WorkBuddy 一家 | 十几家供应商（视配置）、模型映射、两个协议互转 |
| 账号层 | 池 + 5 种使用方式 + 积分/到期 | 池 + 轮询 + 冷却/熔断（**无积分概念**） |
| 失败处置 | 10 类 kind，每类一句可执行建议 | 状态码 + 正则分类，按供应商 quirks 分叉 |
| 视角 | 消费端（少花冤枉钱、别浪费额度） | 代理端（别让请求失败、别让上游被打爆） |

**可同时安装**：它的 provider id（`workbuddy-models` / `workbuddy-models-global`）与
`dsh-connect-workbuddy`（`workbuddy` / `workbuddy-global`）刻意不重叠。

**但两者都做账号池时会互相看不见**：插件里的冷却、判死、当前选号只活在它自己的进程里，
网关里的 `accountPool` 也只活在网关进程里。同一个人两份状态，最坏的表现是
「插件认为 A 号可用 → 让 DSH 直连打 A → 撞 429；网关同时在给 A 记冷却」。
装它 = 让 DSH 绕过网关直连 WorkBuddy；用网关 = 多供应商容灾但不能用它的积分视图。
这是一个产品取舍，不是技术缺陷，但必须在文档里说清，否则用户会以为是 bug。

## 3. 值得借鉴（按性价比排序）

### P0-① 把「额度」当成一等公民：余额 + 到期，而不是等 402 才反应

- 证据：`src/upstream.ts:1570` `POST {billingBase}/v2/billing/meter/get-user-resource`
  （body `{PageNumber:1, PageSize:100, ProductCode:'p_tcaca', Status:[0,3]}`）；
  `src/status-paths.ts:271-283` 明确 **`remain` 必须取 `CycleCapacityRemainPrecise` 家族**，
  因为 `CapacityRemain` 是 pool 家族，整月额度花完时仍报满额（高报）；
  `src/shim.ts:1079-1107` 每次成功请求后**后台**刷余额，每账号 10 分钟一次（`BALANCE_REFRESH_MS`），
  失败静默吞掉（「一次抖动的余额查询绝不能变成失败的用户请求」）。
- 我们现状：`model-gateway.mjs` 里 `get-user-resource` / `CycleCapacityRemain` **零命中**。
  额度耗尽只能靠上游错误文本事后识别（`ACCOUNT_CREDIT_COOLDOWN_MS` 30 分钟，`model-gateway.mjs:3400`）。
- 改法：给 WorkBuddy 车道加一个后台余额探测（10 分钟 + 成功/失败都计入），
  `/health` 的账号行带 `remain` / `nearestExpiryMs`，并让账号轮询按「最先到期先服务」排序。
  收益：把「撞 402 再冷却 30 分钟」变成「提前把快过期的额度用掉」。

### P0-② 排序键要「全序」且每种使用方式真正分支

- 证据：`src/status-paths.ts:871-944` `rankAccounts`，键顺序
  `_usable → _atRisk → _order(手写序) → _expiring → _expiringAmount → score → _tokenExpiresAtMs → id`，
  末键用 `id` 保证同一份输入永远排出同一个顺序（注释明说「否则同一份池两次排队可能不同，既难推理也没法测」）。
  `distribution` 只改**一个**键（`expiry` 把「有到期信息」提到 `atRisk` 之前），
  其余四种用同一份顺序、差别在「怎么消费它」（`src/accounts.ts:936-1021`）。
  `balanced` 的权重是 `Math.max(1, score)`——注释解释为什么不能是 `score`：
  「余额为 0 的账号仍要有一点被选中的机会，否则它永久失去被探测的机会」。
  `sticky` 新会话取「当前绑定最少」的号，并给 affinity 表设 LRU 上限。
- 我们现状：`accountRR`（`model-gateway.mjs:3399`）是纯游标轮询，没有排序概念，
  也没有「谁更该先上」的可解释理由。
- 改法：把 `rankAccounts` 这套纯函数搬进来（它是无依赖纯函数，直接可用），
  在 `providersForModel` 产出的顺序上做**同分内的**账号排序；`round-robin` 保留为默认，
  新增 `expiry` / `balanced` 两种（配置项）。注意别把 `distribution` 塞进比较器。

### P1-③ 冷却键带通配，把「判死」与「冷却」分开

- 证据：`src/shim.ts:1051-1068` 冷却表键是 `账号\0模型`，`*` 表示整号不可用；
  过滤时**按本次请求的模型**展开，注释点名「否则会把『A 在 hy4-preview 上被限流』
  错算成『A 在所有模型上都不可用』」。
  `src/shim.ts:1254-1277`：401/403 且 `retryable !== true` → `pool.markCredentialDead`
  （**判死**，不再重试），可重试的走冷却（60 秒 / `hard_credit` 5 分钟）。
  `src/accounts.ts:755-766`：判死只在「重新扫描发现 token 变了」（`credentialRotated`）时清除——
  判死不是永久，但恢复入口只有一个，结构上不会出现「成功一次就自我复活」的假恢复。
  `src/shim.ts:123-131` `parseRateLimitReset`：从 body 里读 13 位 epoch（`resetAt` 家族）或中文
  「将在 2024-01-01 12:00:00」，读不到才回落到 60 秒兜底。
- 我们现状：已经有 `accountModelKey`（`provider#acct@model`，模型名截断 128）与
  `providerBreakerRecordFail` 的 30 分钟长熔断（`model-gateway.mjs:3400-3412` 一带），
  11128 的处理也已从「≈2% 随机风控」纠正为「手里那份 token 不认了→作废缓存」（`model-gateway.mjs:154-164, 4042-4062`）。
- 可补的差距只有两点：① `soft_rate` 的窗口**优先读上游给的 reset 时间**（我们目前只有固定 90 秒 + 退避）；
  ② 「判死」与「冷却」分开存，判死只在凭据真正换过之后才清除。

### P1-④ 失败分类表 + 每类一句可执行建议

- 证据：`src/upstream.ts:83-135` 10 类 kind（`hard_credit` / `soft_rate` / `authentication` /
  `session_dead` / `client_reject` / `channel_reject` / `local_gate_oversize` / `local_gate_unattributed` /
  `client` / `server`），并写明「只保留本插件会**分支**的种类：每一类都对应一句不同的用户可执行建议，
  没有分支的种类留在这里只会让每种失败退化成同一句话」。
  `classifyUpstreamError`（`src/upstream.ts:234-257`）的判定顺序有理由（先状态码，再 body 标记，
  402/`14018` 排在 429 之前，因为同时带「耗尽」与「节流」的 body 该给「去充值/换号」而不是「等一会」）。
  `src/shim.ts:1359+` `exhaustedReason`：池空时分别回答「没登录 / 全判死 / 全在冷却 / 全被排除」，
  每种带不同状态码与动作。
- 我们现状：分类散在若干正则 + quirk 分支里（`isModelUnavailableByProvider`、
  `MODEL_UNSUPPORTED_BY_PROVIDER_RE`、各供应商特殊分支），失败终态常见 `failover stopped` /
  `all-providers fail`。功能上够用，但「为什么没得选」这一层解释得比它差。
- 改法：抽一张 `kind → 状态码 → 文案` 表，`/health` 与日志都从表里取；
  池空时用 `exhaustedReason` 的四种分支替代现在的一句话。

### P1-⑤ 发现层要「诚实」：双源、按目录语义收后缀、跳过的文件必须列出来

- 证据：`src/accounts.ts:1-60` 说明只扫桌面端目录曾让本机 4 个账号里 2 个消失，而 vault 里明明有明文；
  后缀**按目录语义**收（桌面端目录只收 `.info`，同目录的 `*.observation.json` 是诊断产物；
  vault 目录只收 `.json`）；`WbSkippedFile{path, reason:'encrypted'|'unreadable'|'malformed'}`——
  「否则『2 个账号』与『4 个文件里 2 个读不了』看起来一样」。
  同一 `uin` 在桌面端与 vault 各有一份时按账号 id 折叠成一个池成员，取哪份由 `compareFreshness`
  四键决定（`src/accounts.ts:421`：`refreshExpired` → 活文件优先 → `lastRefreshAtMs` → `expiresAtMs`）。
- 我们现状：`workbuddyDefaultAuthFiles()`（`model-gateway.mjs:3369`）已经正确探测
  Local + Roaming 两处 AppData、国内/国际两个文件名、macOS/Linux 兜底，并且尊重
  `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE`（:3383）——这一条我们是对的。
  **缺的是**：① DSH vault（`$DSH_HOME/workbuddy-vault/{cn,global}/*.json`）这个第二来源（零命中）；
  ② 读不了的文件不上报（零命中，账号数变少时用户无从判断）；③ 多来源时的折叠与新鲜度比较。
- 改法：加 vault 来源 + 在 `/health` 与「账户池与冷却」表格里加一列「被跳过的凭据（原因）」。

### P2-⑥ 内容闸门的三级自救梯子（只在真的撞上时才有意义）

- 证据：`src/shim.ts:1220-1232` 渠道闸门（11128 家族里「未授权通道」那一支）在**同一个账号上**连打三级：
  ① 把 system 正文搬到 user（默认形态，`relocateScannedContent`）
  ② 还原 system 角色（只留 span 改写）
  ③ 每条被扫描消息前置中性占位（`forceNeutralHead`）
  每级与上一级逐字节相同就**不发**；三级都失败才报错，且**不换号**（「闸门读请求不读账号，换号只会用另一份凭据发同一份被拒的请求体」）。
- 我们现状：已经把 11128 的真因定位为 system 里的宿主身份句，并做了渠道身份改写（`model-gateway.mjs:154-164`
  一带的注释 + 改写实现），也把「工具裁剪不能解 11128」这个误判纠正了。
- 可借的点：**「换号对这类拒绝无意义」这个判断要显式写进代码**（我们现在靠 failover 全跑一遍才发现），
  以及「逐字节相同就不重发」。

### P2-⑦ 零额外请求的派生信息 + 渲染时判定的时钟窗口

- 证据：促销徽标来自**已经在读的** `/v3/config`（`modelPromotions` / `modelTiers`），
  `src/promo.ts:1-30`：解析器保留**全部候选**，由渲染方在画的那一刻判「现在哪个窗口成立」——
  「22:59 读到的夜间折扣不能到次日 08:00 还自称夜间」。
  同一份 UA 通道还能拿到 `/v2/chat/busy` 的六态拥挤度（`src/upstream.ts:836-896`，批量 50、超时 5 秒、
  「装饰性信息，不能为它把名册刷新拖慢十秒」）。
- 对我们的意义：如果要显示「本模型当前倍率/折扣」，正确做法是存原始窗口、渲染时判定，
  而不是取数时定死。拥挤度这类装饰信息不值得进关键路径。

## 4. 我们已经做到、不必回头的

- 回环安全模型：`hostIsLoopback` / `originIsLoopback` / 常量时间 bearer 比对 / 随机端口 —— 我们 `authorized()` 与 DNS-rebinding 守卫等价。
- 每模型冷却键与截断上界：我们已有 `accountModelKey` + 128 字符截断 + 512 条上限（还能防 `/health` 被撑爆）。
- 一过性失败后的「学习」路径：`retryWithoutThinking`、`noteModelNotOffered` + 队尾降级、`resetAllCooldowns` 一键恢复。
- 平台路径探测（Local + Roaming + 两个文件名 + 环境变量覆盖）。
- 「同一个供应商只记一次」的日志纪律、日志分级、`docs/AUDIT.md` 规模的审计记录。

## 5. 不建议照搬

1. **插件脚手架**（cordis inject 形状、settings 双线、`unwrapVolatileDeep`、client bundle externalize）——
   这些坑是 DSH 0.1.5/0.1.7 API 差异的产物，与网关无关，`README.md:243-253` 那两条「必须记住的坑」只对插件作者有意义。
2. **第二层回环代理**：它在插件内起 http server 再转发。我们已经是独立进程 + 端口，再套一层只会多一次错误映射。
3. **`lib/` 入库**：那是为了绕过 pnpm 的安装期脚本拦截，我们的分发是打包 `out/`，逻辑不同。
4. **把余额/签到做成关键路径**：签到是「锦上添花」（`Asia/Shanghai` 自然日幂等、60 秒 tick、
   账号间 800 ms 间隔，见 `src/scheduler.ts`），失败绝不能影响转发。若要加，只做后台任务 + 手动按钮。

## 6. 落地建议（若要做，按此顺序）

| 优先级 | 事项 | 成本 | 收益 |
| --- | --- | --- | --- |
| P0 | WorkBuddy 车道读余额与到期（`get-user-resource`，10 分钟后台刷新） | 中 | 提前用掉快过期额度，少撞 402 |
| P0 | `rankAccounts` 纯函数移植 + `expiry` 排序（配置开关） | 低（纯函数直接搬） | 选号从「游标」变成「可解释」 |
| P1 | vault 第二来源 + 「被跳过的凭据」上报 | 低 | 账号变多、账号少了能自证 |
| P1 | 失败分类表化（kind → 状态码 → 文案）+ 池空四分法 | 中 | 日志与 `/health` 可读性 |
| P1 | `soft_rate` 优先读上游 reset 时间 | 低 | 少等 29 分钟或早 29 分钟恢复 |
| P2 | 「判死」状态与冷却分离（换 token 才复活） | 中 | 少白试死 token |
| P2 | 签到/领权益（后台任务 + 手动按钮） | 中 | 额度自增，但与转发无关 |
| — | `/v2/chat/busy` 拥挤度 | 低 | 装饰性，不建议进关键路径 |

## 7. 风险

- 上游（WorkBuddy / codebuddy.cn）接口**无公开契约**，所有端点是逆向所得；本插件已注明「回源核对」，
  我们照抄时同样要留一份「实测日期 + 原始响应」的证据，否则下次上游改字段会变成静默少数据。
- 加密凭据（`$wbEncrypted` 信封）依赖**本机装着的桌面端**提供密钥（`src/at-rest.ts` 用
  `ELECTRON_RUN_AS_NODE=1` 调它的 binding）。这意味着「没装桌面端 → 解不开」，是协议性质而非缺陷；
  我们若实现，必须把这条写进错误文案，而不是让用户以为账号被封。
- 内容闸门（11128 家族）的对抗是**持续博弈**：本插件自述零宽扰动已被上游字符剥离挡死（`src/shim.ts:1216-1217`）。
  借鉴它的「三级梯子 + 不换号」结构可以，但别把某一级的有效性当常量写死。

## 8. 我读了什么（可复核）

- `README.md`（272 行，全文）
- `DESIGN.md`（289 行，全文）
- `src/status-paths.ts:763-964`（`expiryFactsOf` / `rankAccounts` / `pickRankedAccount`）
- `src/accounts.ts:920-1029`（`pick` 的五种分布）、`:421` `compareFreshness`、`:755-766` 判死恢复
- `src/shim.ts:1041-1200`（冷却键与选号）、`:1200-1369`（失败分支与 `exhaustedReason`）、`:98-131`（冷却常量与 reset 解析）
- `src/upstream.ts:60-259`（10 类 kind 与 `classifyUpstreamError`）、`:836-896`（拥挤度）、`:1570` 积分端点
- `src/probe.ts`、`src/catalog.ts`、`src/promo.ts`、`src/scheduler.ts`、`src/at-rest.ts`、`src/adapter.ts` 的模块头注释
- `package.json`、`tests/` 的文件与行数统计
