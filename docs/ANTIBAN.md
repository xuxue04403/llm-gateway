# 客户端仿真与防封禁（第三轮专项）

本文记录"让请求看起来像官方客户端"这件事的**现状、依据、改动**，以及**本程序做不到什么**。
所有结论都尽量落到一手证据（官方 SDK/CLI 源码、抓包比对、本机实测），
不确定的一律标注"未证实"。

---

## 一、先说天花板：分两种，agentrouter 不是 TLS 那一种

> **2026-09-30 实测更正**：本节最初写的是"agentrouter 属于 TLS 指纹型，本程序过不去"。
> 那是**转述第三方报告**（一个开源代理项目的 README）得出的结论，**没有自己验证**。
> 本机实测把它推翻了 —— 见下面的证据。原文保留在"其它站点"那一段。

上游做"客户端白名单"有两类实现，判据完全不同：

| 类型 | 判据 | 本程序 |
|---|---|---|
| **UA / 头部白名单** | 看 `User-Agent` 等头的**字面量** | **能过** —— 把头发对就行 |
| **TLS / 连接层指纹** | 看 TLS ClientHello 的字节形态 | **不能过** —— Node 无公开 API 定制 ClientHello |

### agentrouter：实测是**纯头部**白名单（不是 TLS）

同一个 Node TLS 栈（`https.request`，什么都不改），**只换请求头**：

| 请求头 | `GET /v1/models` | `POST /v1/messages`（真实对话） |
|---|---|---|
| 只有鉴权、无 UA | **401** `unauthorized client detected` | — |
| 浏览器 UA | **401** | — |
| `Anthropic/JS 0.129.0` + 全套 `x-stainless-*`（= **dsh 真实发的头**） | **401** | **401** |
| 同上，**只把 UA 换成 `claude-cli/2.1.270 (external, sdk-cli)`** | **200** | **200 + 真实回复** |
| Codex CLI 形态（`codex_cli_rs/…`） | **200** | — |
| Cline 形态 | **200** | — |

**结论**：TLS 完全一样，只换 UA 就 200/401 翻转 —— 判据在**头部**，
而且窄到**只认 UA 里的 `claude-cli/…` / `codex_cli_rs/…` / Cline 那几个字面量**：
去掉 `x-stainless-*` 仍 200，留着 `x-stainless-*` 但 UA 不对仍 401。

所以本文档原先那句"头改得再对也过不去"**对 agentrouter 是错的**（已更正）。
这也解释了为什么 `dsh → agentrouter` 直连会 401 而 `dsh → 网关 → agentrouter` 反而成功：
**网关的 claude 仿真正是让它通过的那个东西**（见第五节）。

### 其它站点：TLS 型确实存在，但本程序无法验证也无法解决

第三方证据（一个开源代理项目的 README，**未证实**为普适规律）称：某些中转前置的
WAF 在连接层做指纹 —— 同一把 key，Anthropic SDK 200 而 `AsyncAnthropic` 401，
只有同步 httpx 的握手在白名单里。**那条证据没有在本机复现过，本程序也无法通过它。**

若真的遇到这类站点：Node 没有公开 API 定制 ClientHello（需要原生绑定 / 自实现 TLS 栈），
与"零依赖单文件引擎"的架构根本冲突。**这一项写进文档而不是假装能解决。**
能做的是**识别它、立刻止损**（见第四节"客户端指纹被拒"），而不是反复换 Key 硬打。

---

## 二、改之前的样子（以及为什么不够）

| profile | 改之前发的头 | 问题 |
|---|---|---|
| `claude` | `user-agent: claude-cli/2.0.0 (external, cli)` + `accept` | 只 2 个自建头。真实 Claude Code 发 ~15 个 |
| `codex` | `user-agent: codex/0.49.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 … Chrome/126.0.0.0 Safari/537.36` + `accept` | **把 Codex 前缀粘在一条 Chrome 浏览器 UA 上** —— Codex CLI 是 Rust 程序，UA 里不可能有 `AppleWebKit`/`Chrome`/`Safari` |
| `cline` | 9 个头（实测收敛版） | 最完整，但版本号写死且已过期；缺 `X-Task-ID` |

三个 profile 全都**缺 `x-stainless-*`**（Anthropic SDK 必发的 SDK 指纹头），
`x-app` / `anthropic-beta` / `originator` 一处都没有。

另外两个**非头部**的显眼特征：

- `accept-encoding: identity` —— 真实客户端发 `gzip, deflate, br, zstd`；
- `connection: close` —— 真实客户端复用连接（并复用 TLS 会话票据）。

---

## 三、改了什么（依据逐条给出）

### 3.1 `claude` profile

依据：`@anthropic-ai/sdk` 编译产物 `client.js` 的 `buildHeaders()` 第一层是
`Accept` / `User-Agent` / `X-Stainless-Retry-Count` / `X-Stainless-Timeout` /
`getPlatformHeaders()` / `anthropic-version` —— 也就是说**任何**真实的 Anthropic SDK 客户端
（Claude Code 就是用它调的）都会带这些。

现在补上：

```
x-stainless-lang: js
x-stainless-package-version: <可配置>
x-stainless-os / -arch / -runtime / -runtime-version   ← 取自当前进程，保证自洽
x-stainless-retry-count: 0
x-stainless-timeout: 600
x-app: cli
anthropic-beta: <Claude Code 的 flag 全集，可关>
user-agent: claude-cli/<版本> (external, sdk-cli)
accept: application/json
```

两处细节修正：

- UA 的入口点语义由 `cli` 改为 `sdk-cli`。官方 issue 明确区分"交互式终端"与"通过 Agent SDK
  程序化调用"，程序化调用写 `cli` 对不上事实。
- `accept` 由 `application/json, text/event-stream` 改为 `application/json`（真实 CC 发这个）。

### 3.2 `codex` profile

依据：`openai/codex` 的 `codex-rs/login/src/auth/default_client.rs`（Rust 源码）。

```
UA = `${originator}/${version} (${os_type} ${os_version}; ${arch})`
originator 是**独立的一等身份头**，服务端对它做白名单：
  codex_cli_rs | codex-tui | codex_vscode | 以 "Codex " 开头
```

现在发的就是 `codex_cli_rs/0.159.1 (Windows 10.0; x64)` + `originator: codex_cli_rs`，
浏览器指纹字样全部去掉。

**刻意不加 `ChatGPT-Account-ID`**：它的值要从真实 OAuth token 的 JWT 里推，
编一个假的比不发更像机器人。

### 3.3 `cline` profile

依据：`cline/cline` 的 `sdk/packages/llms/src/providers/request-headers.ts`。

- 版本号改为**可配置**（env / `cfg.clientVersions`）。服务端另有一道**最低版本门禁**
  （cline#13128：`If you are using an old version of Cline, please update to the latest version`），
  写死的版本号过几个月就会开始被拒。
- 补 `X-Task-ID`（= 会话 id）。同一会话内保持稳定 —— 每请求换一个反而是"会话抖动"特征。
- UA / `X-CLIENT-VERSION` / `X-PLATFORM-VERSION` 三者强制同值（测试里钉死）。

**保留** `x-platform: terminal` 与 `x-client-type: cline-sdk`：这是原实现**实测收敛**出来的
最小充分集，理论上的"形态自洽"说法（SDK 形态下 `x-platform` 应等于 `x-client-type`）
不足以让我在没有实测的情况下改动一个已知能用的值。

### 3.4 版本号可配置（不再写死）

环境变量或 `cfg.clientVersions` 覆盖（env 优先）：

| env | 配置键 | 默认值 |
|---|---|---|
| `DSH_GATEWAY_CC_VERSION` | `claudeCli` | `2.1.270` |
| `DSH_GATEWAY_CC_ENTRYPOINT` | `claudeEntrypoint` | `sdk-cli` |
| `DSH_GATEWAY_STAINLESS_VERSION` | `stainlessPkg` | `0.112.1` |
| `DSH_GATEWAY_CODEX_VERSION` | `codex` | `0.159.1` |
| `DSH_GATEWAY_CODEX_ORIGINATOR` | `codexOriginator` | `codex_cli_rs` |
| `DSH_GATEWAY_CLINE_VERSION` | `cline` | `3.0.65` |
| `DSH_GATEWAY_CLINE_CORE_VERSION` | `clineCore` | `0.0.87` |
| `DSH_GATEWAY_CC_BETA=0` | `claudeBeta: false` | 发全集 |
| `DSH_GATEWAY_ENCODING` | `upstreamAcceptEncoding` | `gzip, deflate, br, zstd` |

**设计原则：自洽优先于"最新"。** UA 的版本、`x-stainless-*` 的 OS/arch/runtime、
平台头之间必须互相说得通。宁可整体偏旧，也不要只把某一项改新 ——
不自洽的组合比固定值更容易被识破。

### 3.5 `accept-encoding` 改成真实值

原实现强制 `identity`，注释说是为了治 SSE 乱码。真实客户端发
`gzip, deflate, br, zstd`，`identity` 是极少数客户端才有的值。

改的依据 + 风险控制：

- Node 的 `fetch`（undici）会**自动解压**，引擎读到的是解压后的流；
- 新增了一条**真的用 gzip 压缩 SSE** 的端到端测试（`tests/gateway.test.js`），
  把"压缩后还能不能正确解析"这件事钉死 —— 这条测试就是原顾虑的答案；
- 留了回退开关：`DSH_GATEWAY_ENCODING=identity` 或 `cfg.upstreamAcceptEncoding`。

### 3.6 `connection: close` 保留，但可关

它治的是"undici 连接池里的死连接被复用 → 网关假死"（真实的、很难查的故障）。
代价是 TLS 会话复用归零，而真实客户端会复用连接与票据 —— 这确实是个连接层特征。

**这两者不能两全**，所以把选择权交给用户，默认保持可靠性：

```jsonc
{ "upstreamKeepAlive": true }   // 不发 connection 头（适用于不用不稳定代理、更在意指纹一致性的场景）
```

### 3.7 WorkBuddy 版本缓存加 TTL

原实现把版本号永久缓存。客户端**自动更新**后，网关会一直发旧版本号（`X-IDE-Version` 与 chat 的 UA），
直到进程重启 —— 这正好造成"身份头与客户端实际版本不一致"的自相矛盾。现在 10 分钟重读一次。

---

## 四、防封禁的其它机制

### 4.1 识别"客户端指纹被拒"并**停止消耗账号**（新增）

这是本轮**收益最直接**的一条。

上游明确说"你这个客户端不被允许"时（`unauthorized client detected` /
`only available via … product surfaces` / `invalid client` …）：

| | 普通 401/403 | 指纹类拒绝 |
|---|---|---|
| 是谁的问题 | **账户**（Key 无效/额度） | **客户端**（与账号无关） |
| 换 Key 有用吗 | 有用 | **完全没用** |
| 重试有用吗 | 可能 | **没用，且继续打会加剧风控** |
| 正确动作 | 换下一把 Key | **长熔断该家 + 明确告知用户** |

旧实现把两者混在一起：指纹拒绝会被当成账户失败 → **逐把冷却用户所有可用的 Key
并继续往上打**，是最坏的画像行为。现在会识别出来、长熔断该家、并在日志里说明原因
（包括"本程序无法伪装 TLS 指纹"这个上限）。

### 4.2 遵循 `Retry-After` + 抖动（新增）

- **遵循 `Retry-After`**：真实客户端确实遵循它（Codex 的 Rust HTTP 客户端里
  `retry-after.rs` 是一等模块）。无视它会让上游看到"刚被限流就立刻回来接着打" ——
  这是限流场景下最典型的滥用特征，也正是把短期限流升级成封禁的常见路径。
  旧实现**全文件 0 处**引用它。现在账户冷却与供应商熔断都会遵循（带上限夹取）。
- **抖动**：429 的冷却时长在指数增长的基础上加 ±20% 抖动。不加抖动时多个账户会在
  **同一时刻**集体复活、再一起撞墙，形成"冷却→撞墙→冷却"的锯齿。

### 4.3 原有机制（质量本来就高，未改动）

- **多账户池 + 轮询**：`rate` 按「供应商+账户+**模型**」记（实测 amd 两把 Key 因模型级并发上限被连坐），
  `credit`/`session` 按账户级 —— 粒度选得对。
- **供应商熔断三态状态机**：`breakerIsOpen` 纯读（不会产生探测风暴）、
  `breakerAcquire` 唯一转换点、half-open 单飞、遗弃名额回收。
- **指数退避**：90s × 2^(opens-1)，封顶 30 分钟。
- **401/403 立即长熔断**：不自愈的失败不必等连续 3 次，避免固定失败模式被画像。
- **请求体降敏**：规避平台"疑似密钥"内容过滤，含自适应重试。
- **上游错误体"够快才重试"**：只对快速失败的网络错重试一次。

### 4.4 明确**不做**的事

| 不做 | 为什么 |
|---|---|
| 随机 UA 轮换 | UA 与 `x-stainless-*`/OS/arch/版本不同步 = 一眼假，比固定值更糟 |
| 编造 `ChatGPT-Account-ID` | 从假 JWT 推不出、格式会被校验，是强负向信号 |
| 默认注入 `metadata.user_id` / billing 段 / `?beta=true` | 会改写用户的请求体语义（插入用户没写的内容）；只对 first-party OAuth 端点有意义，对中转站收益未证实 |
| 发 `anthropic-dangerous-direct-browser-access: true` | 两处证据冲突，`dangerously` 字样对风控负向 |
| 试图在 Node 里做 uTLS 级 ClientHello 伪装 | 无公开 API，需原生绑定，违背"零依赖单文件"；已写进本文档而非硬做 |
| 伪造 `X-Forwarded-For` / 客户端 IP | 引擎已主动剔除，这是正确的，不加回来 |

### 4.5 已知未做（收益不确定或有代价）

- **粘性会话**：一个会话固定用一个账户/连接，更接近真实客户端。代价是单账户更快撞额度上限
  （现在的轮询能摊平）。未证实具体站点如何判定，故不做。
- **最小请求间隔 / RPM 限速**：需要引入排队，会改变延迟特性。未做。
- **连接复用 + TLS 会话票据**：见 3.6，用开关让用户选。

---

## 五、为什么"直接透传"反而行不通（2026-09-30 实测）

一个很自然的问题：既然 agentrouter 官方说支持 Claude Code / Codex / dsh，
**为什么不干脆把客户端请求原样透传，让上游看到"真的 dsh"？**

引擎确实有这个模式（清空 `clientProfile` 与 `clientUA` 即进入透传，只换鉴权头）。
但实测结果是：**透传会被拒。**

### 5.1 dsh 真实发的是什么

dsh 走 `@earendil-works/pi-ai`。它的 Anthropic 通道分两个分支
（`pi-ai/dist/api/anthropic-messages.js`）：

| 分支 | 设了什么 |
|---|---|
| **OAuth token** | `user-agent: claude-cli/${claudeCodeVersion}` + `x-app: cli` |
| **普通 API Key**（你的情况） | 只加 `accept: application/json` + `anthropic-dangerous-direct-browser-access: true`，其余交给 `@anthropic-ai/sdk` |

也就是说，**用 API Key 时 dsh 发出去的 UA 是 `Anthropic/JS <版本>`**，
而不是 `claude-cli/…`。

### 5.2 实测：dsh 的真实身份被 agentrouter 拒绝

同一把 key、同一个 Node TLS 栈，只改请求头：

| 请求头 | `GET /v1/models` | `POST /v1/messages` |
|---|---|---|
| **dsh 真实头**（`Anthropic/JS 0.129.0` + 全套 `x-stainless-*` + `anthropic-dangerous-direct-browser-access`） | **401** | **401** |
| 同上，**只把 UA 换成 `claude-cli/2.1.270 (external, sdk-cli)`** | **200** | **200 + 真实回复** |
| 只有 SDK UA，无 `x-stainless-*` | **401** | — |
| 有 `x-stainless-*`，无 UA | **401** | — |
| 去掉 `anthropic-dangerous-direct-browser-access` | **401** | — |

→ **判据就是 UA 里的 `claude-cli/…` 字面量**，其余头（`x-stainless-*`、
`anthropic-dangerous-direct-browser-access`、`x-api-key` vs `Bearer`）都不改变结果。

### 5.3 所以结论是反过来的

```
dsh（Anthropic/JS） ──直连──▶ agentrouter          ✗ 401 unauthorized client detected
dsh（Anthropic/JS） ──▶ 网关（透传）──▶ agentrouter  ✗ 401（透传 = 把被拒的身份原样送过去）
dsh（Anthropic/JS） ──▶ 网关（claude 仿真）──▶ agentrouter  ✓ 200
```

**网关的 claude 仿真不是"多此一举的伪装"，而是让 dsh 能通过的唯一原因。**
把 `clientProfile` 清空改成透传，会让本来能用的调用立刻变成 401。

### 5.4 那"agentrouter 支持 dsh"是什么意思

最可能是**分支差异**：pi-ai 在 **OAuth token** 模式下会发 `user-agent: claude-cli/…`
+ `x-app: cli`（见 5.1），那种形态是能过的；而**普通 API Key 模式不发**。
所以"支持 dsh"成立与否，取决于 dsh 用的是 OAuth 还是 API Key。

（另一种可能是 agentrouter 的白名单后来加了 `Anthropic/JS`，但这个通道上没生效 —— 未证实。）

### 5.5 什么情况下透传才是对的

透传适合**单客户端 + 该客户端的身份确实在白名单里**的场景。对多客户端网关它有两个问题：

1. **身份取决于"谁在调"**：dsh 调会带 `Anthropic/JS`（被拒），Claude Code 调会带
   `claude-cli`（通过）—— 同一个网关时好时坏，极难排查。
2. **非白名单客户端会被连累**：opencode 等客户端经过网关时，
   它们的身份同样会被送上去。

**当前配置（`clientProfile: "claude"` 全局仿真）对这个组合是对的**：它把**所有**入口
统一成"能过 agentrouter 的那个身份"，谁在调都一样。

> 逐家覆盖仍然可用：`provider.clientProfile` 可以对某一家单独指定，
> `*.cline.bot` 还会自动推断成 cline 仿真。这两条路径不受影响。

---

## 六、怎么验证

```powershell
npm test          # 217 项，其中 gateway 套件专测仿真与熔断
npm run parity    # 引擎相对 dsh-app 基线的差异是否与声明清单一致
```

新增的回归测试（都在 `tests/gateway.test.js`）：

| 测试 | 钉住什么 |
|---|---|
| codex UA 形态 + `originator` | UA 必须是 `codex_cli_rs/<ver> (<os>; <arch>)`，且**不得**含 `AppleWebKit`/`Chrome`/`Safari` |
| claude SDK 指纹头成套 | 8 个 `x-stainless-*` 都在，且 `runtime-version` 等于 `process.version`（fake 值一眼假） |
| cline 版本三者自洽 | UA / `X-CLIENT-VERSION` / `X-PLATFORM-VERSION` 同值 |
| **gzip 压缩的 SSE** | 上游压缩时仍能正确解压转发（`accept-encoding` 改动的直接风险） |
| `accept-encoding` 可回退 | 配置开关能强制回 `identity` |
| 客户端指纹被拒 | 长熔断该家、说明原因、**不**标记用户账户、熔断期间不再打上游 |
| 限流遵循 `Retry-After` | 冷却按上游给的秒数（而不是默认 90 秒） |

---

## 七、未证实 / 存疑

- AgentRouter 的 Aliyun WAF 是否对**所有**此类站点普适 —— 只确认了这一个案例的机理。
- 真实 Claude Code 请求体侧的 billing 段 / `metadata.user_id` 格式（来自逆向贴，二手）。
- `anthropic-dangerous-direct-browser-access` 是否该发（两处证据冲突，故默认不发）。
- HTTP 头**顺序**是否被某些 WAF 用作指纹：本引擎的头顺序逐请求恒定，
  真实 SDK 的顺序不同。未证实有站点按顺序判定，故未改动。
- HTTPS 代理（`https://` 开头的代理地址）本程序不支持，已在保存时明确拒绝并解释原因。
