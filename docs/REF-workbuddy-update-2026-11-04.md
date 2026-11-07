# WorkBuddy 插件 2026-11-04 更新分析（0.1.1 → 0.1.2）

> 对象：https://github.com/DragonHorizon-xtihc/dsh-connect-workbuddy-models
> 目的：判断这次更新对 **llm-gateway 适配 WorkBuddy** 是否有借鉴价值。
> 性质：只读分析，**本轮未修改任何代码**。所有断言都标了 `file:line`，见第 7 节。

---

## 0. 结论

**中等价值，方向相邻但不对口。**

- 这次更新只做了一件事：**别把上下文窗口报大，以及超窗时快速给出可执行的错误**。
- 它**没有**碰 11128、凭据刷新、并发 429、可用性排序、额度——也就是 WorkBuddy "时好时坏"真正的那条线。网关在这几项上仍领先它（见 3.6）。
- 真正值得拿过来的只有两条半：
  1. **窗口值要"实测真实值封顶 + 安全边际"**，而不是照抄目录声明；未声明时**不能**默认 1M。
  2. **超窗要单独归类**：不要当成普通确定性 4xx 去烧完全部候选，直接回 `400 context_length_exceeded` + 一句人能照做的建议。
  3. （半条）"从上游 `/models` 学窗口"可以作为第三来源，但它自己默认是关的。
- **不建议**把它的 `trimToWindow` 搬进网关：网关静默删用户历史，语义风险比插件大得多；窗口值准了 + 全候选装不下时明确报错，收益相同而风险小一个量级。

当前它修的那个故障，我们**暂时没有真实撞上**（日志零命中，见 4 节），所以是"补一个已知会踩的坑"，不是"救火"。

---

## 1. 更新是什么

| 项 | 值 |
|---|---|
| 提交 | `533b0e10`，作者时间 2026-11-04T03:42:29Z（北京时间 11-04 11:42） |
| 父提交 | `aecb5550`（0.1.1） |
| message | `feat: update catalog, shim and add context-window support` |
| 版本 | `0.1.1` → `0.1.2` |
| 规模 | 531 additions / 20 deletions，1 个提交 |

改动文件：

| 文件 | 变化 |
|---|---|
| `src/catalog.ts` | +76 / -4：窗口计算 |
| `src/shim.ts` | +166 / -2：发前裁剪 + 超窗识别 + 400 文案 |
| `lib/index.js` | +163 / -4（构建产物，跟随源码） |
| `lib/index.d.ts` | +1 / -1 |
| `tests/context-window.test.ts` | 新增，+109 |
| `tests/adapter.test.ts`、`tests/catalog.test.ts` | 期望值同步 |
| `package.json` | 版本号 |

### 1.1 窗口计算（`src/catalog.ts`）

```ts
const CATALOG_DEFAULT_CONTEXT_WINDOW = 128_000
const CONTEXT_WINDOW_SAFETY_MARGIN = 0.9
const CONTEXT_WINDOW_FLOOR = 8_000
const KNOWN_REAL_CONTEXT_WINDOWS = { hy3: 144_000 }

export function effectiveContextWindow(raw: number | undefined, id?: string): number
// = min(raw ?? 128000, KNOWN_REAL_CONTEXT_WINDOWS[id] ?? ∞) × 0.9，下限 8000
```

三处生效：`fallbackModelsFor()`、`toModelInfo()`、`WbCatalog.applyFetch` 的 live 名册（`src/catalog.ts:75`）。所以 `hy3` 广告 129600，默认模型广告 115200。

### 1.2 发前裁剪（`src/shim.ts:272` `trimToWindow`）

- 预算 `floor(window * 0.85)`；保留首条（system）与最近 8 条（`MIN_KEEP_RECENT_MESSAGES = 8`）。
- 只丢"纯文本 user/assistant"；`tool` 角色、带 `tool_calls` 的 assistant **一律不丢**（保护工具调用配对）。
- 裁不动 / JSON 解析失败 → 返回 `undefined`（不改写）。
- token 估算走 `estimateTokens`：CJK/全角（`charCode > 0x2E80`）1 token/字，其余 0.25 token/字符，故意偏保守。

### 1.3 超窗识别与快速失败（`src/shim.ts:194`、`:1406-1416`）

`isContextTooLong` 新增三类指纹：

```ts
if (body.includes('preflight_compress_failed')) return true
if (body.toLowerCase().includes('not forwarded')) return true
if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true
if (/exceeds?\s+(the\s+)?model\s+window/iu.test(body)) return true
```

命中后**不再笼统回 502**，而是：

```
400  context_length_exceeded
"这个模型的上下文窗口放不下当前对话（…）；即使本地裁剪历史后仍超出。
 请减少历史、或换一个更大窗口的模型。"
```

注释写明了动机：笼统 502 会让 DSH 在**注定失败**的请求上以 8080ms 延迟反复重试。

---

## 2. 它修的那个真实故障（机制链，值得记住）

1. 目录把 `hy3` 的窗口写成 **192_000**，上游真实硬上限是 **144_000**。
   实测报错原文：`context ~248379 tokens exceeds the model window 144000 (model=hy3)`。
2. 窗口报大 → DSH 一直把历史堆到 192k+ 才触发压缩。
3. 上游的 preflight 压缩层在真正窗口之上还有自己的开销，此时已经溢出 ~104k token；它的紧急摘要子调用被 **429 限流**。
4. 于是回 `preflight_compress_failed` / `The over-window payload was NOT forwarded.`，请求被**直接丢弃**（不是截断重试）。

所以这是"一个错误的元数据 → 一连串上游自救失败 → 用户看到请求消失"的典型链条。两根杠杆都指向同一件事：**广告窗口必须 ≤ 真实窗口**。

---

## 3. 与 llm-gateway 的对照

### 3.1 窗口写入：同样按目录声明，且没有边际

`src/gateway/model-gateway.mjs:13864-13886`（`--write-dsh`）：

```js
const c = Number(e.contextWindow) > 0 ? Number(e.contextWindow) : 0;
if (c) ctx.set(e.as, ctx.has(e.as) ? Math.min(ctx.get(e.as), c) : c);
...
const ctxWin = modelLimits.ctx.get(m) || 1024000;
```

- 取所有**启用**供应商声明值的**最小值**（这点比插件更保守，方向是对的）；
- 但**没有 0.9 安全边际**；
- **未声明就写 1_024_000**。`space-bunny`（workbuddy 启用中）正是这种情况——它会被当 1M 模型写给 DSH。

### 3.2 内置元数据里躺着同一个"乐观值"

`src/model-meta.js:99`：

```js
'hy3': { contextWindow: 192000, maxTokens: 64000, vision: true },
```

与插件修掉的那个 192000 一字不差。目前 `hy3` 只在 `workbuddy-global`（**enabled=false**）里出现，所以还没生效；一旦启用就是同一个坑。

### 3.3 超窗文本：零识别

引擎里对 `preflight_compress_failed|model window|NOT forwarded|context_length_exceeded|input length too long` **零命中**（全文件 grep）。也就是说：

- 上游说"你超窗了"，网关只会把它当**一家候选的普通失败**；
- 继续 failover 到下一家，把同一份 40 万 token 的 body 再发一遍；
- 全部候选都失败后，回一个**不含窗口语义**的 400。

### 3.4 那个 400 具体怎么来的

- `model-gateway.mjs:6983`：`DETERMINISTIC_4XX_STATUS = { 400, 404, 413, 422 }`
- `:12041-12048`：确定性 4xx → 记候选失败、**继续 failover**，返回 `{ deterministic4xx: … }`
- `:12653-12660`（chat 路径）/ `:13067-13073`（messages 路径）：全失败后用 `stopFailoverMessage(...)` 回 400，Anthropic 侧 `type: 'invalid_request_error'`

后果：一个必然失败的请求要烧掉"候选数 × 上游往返"，最后客户端拿到的错误里**没有"窗口"两个字**，DSH 很可能原样重试。

### 3.5 roomy 只"排后"，不会拦

- `DEFAULT_ROOMY = true`（`:2140`），日志里确认 `上下文窗口过滤=on（窗口学自上游目录=off）`；
- `roomyOrder(tryOrder, model, body)`：`:12509-12516`、`:12942-12946`；
- 语义是"装不下的候选**排到最后、不删除**"。

所以当**所有**候选都装不下时，请求照样发出去——这正是插件用"发前裁剪 + 快速失败"兜住的那一格。注意 roomy 依赖的也是**声明值**，声明虚高则 roomy 形同虚设。

### 3.6 网关明显领先的地方（不要因为这次更新动摇）

| 维度 | 插件 0.1.2 | 本网关 |
|---|---|---|
| 11128 渠道校验 | 无 | 身份句 + 句式两级改写 + 中性 system 自救（`model-gateway.mjs:5986-6021`、`:11602-11606`、`:11716-11723`） |
| 凭据被顶掉 | 判死/冷却 | 作废缓存 → 强制刷新 → **原地重发同一账户** |
| 多上游 failover | 只有单家 shim | 15 个逻辑模型、按候选池路由 + 短期"不提供该模型"记忆 |

即：**它擅长的窗口诚实度，恰恰是我们缺的；我们擅长的可用性，它没有。**

---

## 4. 现在有多急（数据）

`out/LLM-Gateway/data/logs/usage/2026-11-03..05.jsonl`，按 provider|model 聚合 prompt（`inTok + cacheRead + cacheWrite`）：

| 组合 | 次数 | ok | 最大 prompt | >144k | >192k | >500k |
|---|---|---|---|---|---|---|
| workbuddy\|deepseek-v4.1-flash | 1410 | 1410 | 336,370 | 728 | 317 | 0 |
| opencode\|deepseek-v4.1-flash | 28 | 28 | 232,535 | 28 | 26 | 0 |
| amd\|deepseek-v4.1-flash | 16 | 16 | 228,793 | 16 | 16 | 0 |
| amd\|mimo-v2.6-flash | 2 | 2 | 281,077 | 2 | 1 | 0 |

- `gateway.log` / `gateway.log.1` 对 `preflight_compress|model window|NOT forwarded|context_length_exceeded|input length too long` **零命中** → 目前没撞上过。
- 但 **>144k 已有 728 次、>192k 317 次**，说明长会话是常态。当前主用模型 `deepseek-v4.1-flash` 声明 1M 且插件目录同样写 1M（一致，暂时安全），所以问题被"模型选得大"掩盖了。
- 风险点很具体：**一旦切到 `hy3`（192k 声明 / 144k 真实）或 `space-bunny`（未声明 → 网关写 1M）**，就是插件遇到过的同一条链。

结论：**优先级中**，不是当前故障源，属于"已知会在下一次换模型时爆"的定时炸弹。

---

## 5. 借鉴清单

### 5.1 值得做（两条）

**① 窗口值改成"实测封顶 × 0.9"，并且未声明时不要假装 1M**

- 加一张"实测真实窗口"表（`KNOWN_REAL_WINDOWS`），优先级：实测值 > 配置声明 > 目录学习值 > 兜底（128k，而不是 1024000）；
- 对外写出的值 = `min(上述) × 0.9`（下限 8000）；
- 顺带修 `model-meta.js:99` 的 `hy3: 192000`；
- 这个改动**同时**修好 `write-dsh`（`:13864-13886`）与 roomy（`:2504 windowOf` 读的是配置值）两条路径——所以配置里那几个 `1000000` 也该按同一张表复核。

**② 把"超窗"从"确定性 4xx"里单独摘出来，快速失败**

- 新增判据（照抄插件的指纹，再补几家常见措辞）：`preflight_compress_failed`、`not forwarded`、`exceeds … model window`、`context_length_exceeded`、`maximum context length`、`input length too long`；
- 命中后**不**继续 failover、**不**记"这家不提供该模型"、**不**熔断该家（这是请求的问题，不是供应商的问题）；
- 直接以 400 `context_length_exceeded` 返回，文案带可执行动作（"减少历史 / 换更大窗口的模型"），并把 `provider/model/估算 tokens/声明窗口` 写进日志，方便事后定位是哪家的声明错了。

> 为什么值得：现在这条路要烧掉 N 家候选的上游往返（每家可能 10–60s），最后给客户端的错误还不可执行。插件实测 8080ms 的重试放大，就是这个成本的下界。

### 5.2 不建议做

- **`trimToWindow`（网关侧裁剪历史）**：网关是"透明代理"，静默删用户对话会让 DSH 的压缩决策与实际上下文脱节，还会破坏 tool 配对之外的一些隐式约定（缓存前缀、审计）。窗口值准了 + 装不下时明确报错，已经足够。
- **抄它的 catalog 结构**：它是"插件内自用"的名册；我们已经有 `model-meta.js` + `/models` 学习 + 配置声明三层，缺的只是"封顶 + 边际"，不是架构。

### 5.3 半条（可选）

`roomyLearn`（从上游 `/models` 学 `context_length`）目前默认关（`DEFAULT_ROOMY_LEARN = false`，`model-gateway.mjs:2155`）。如果 WorkBuddy 的 `/models` 真返回窗口，打开它能自动纠正声明虚高；但**不能**替代实测表——插件遇到的正是"目录本身就报大了"。

---

## 6. 如果批准动手，建议顺序

| 步骤 | 改动 | 成本 | 验证 |
|---|---|---|---|
| 1 | 新增 `KNOWN_REAL_WINDOWS` + `effectiveWindow()`；接入 `write-dsh`、`model-meta.js`、`windowOf`；兜底 1M → 128k×0.9 | 低（纯函数 + 3 处调用） | 单测：`hy3 → 129600`；未声明 → 115200；配置 1M 且实测 144k → 129600 |
| 2 | 超窗归类 + 快速 400 | 中（两条翻译/直通路径都要接） | 假上游回 `preflight_compress_failed` → 断言只打一次上游、返回 400 且 `type=invalid_request_error`、日志含窗口信息 |
| 3 | 配置体检：启动时对"未声明窗口的启用模型"打一行 warn，并在概览页提示 | 低 | 现有配置应命中 `space-bunny` |

第 1 步不依赖第 2 步，可以先做；两步都不改路由算法，回滚面很小。

---

## 7. 证据附录

### 插件（head = 533b0e10）

- `src/catalog.ts:27` `CATALOG_DEFAULT_CONTEXT_WINDOW`；`:40` 安全边际；`:43` 下限；`:56-58` `KNOWN_REAL_CONTEXT_WINDOWS = { hy3: 144_000 }`；`:75` `effectiveContextWindow`
- `src/shim.ts:82` `SHIM_DEFAULT_CONTEXT_WINDOW`；`:194-204` `isContextTooLong`；`:213` `estimateTokens`；`:270` `MIN_KEEP_RECENT_MESSAGES`；`:272` `trimToWindow`；`:1403-1416` 超窗 400 分支
- `tests/context-window.test.ts`（新增）：`effectiveContextWindow(192000,'hy3') === 129600`，以及"裁剪保留 tool 配对""裁不动返回 undefined"

### 本仓库

- `src/gateway/model-gateway.mjs:13864-13886` 窗口写入（min 声明值 / 兜底 1024000）
- `src/model-meta.js:99` `hy3` 192000；`:90` deepseek-v4.1-flash 1048576
- `src/gateway/model-gateway.mjs:6983` `DETERMINISTIC_4XX_STATUS`；`:12041-12048` 确定性 4xx 继续 failover；`:12653-12660` / `:13067-13073` 最终 400
- `src/gateway/model-gateway.mjs:2140` / `:2155` / `:2504` / `:12509-12516` / `:12942-12946` roomy
- 配置：`out/LLM-Gateway/data/gateway.config.json`（workbuddy 启用、`space-bunny` 无 `contextWindow`、`workbuddy-global` 关闭且含 hy3 192000）

### 取证方式

- GitHub 直连：`web_fetch` / curl / git 在本机均失败（`SEC_E_NO_CREDENTIALS`、non-public IP），最终用 **Node 的 `fetch` 直连 raw.githubusercontent.com** 抓取 diff 与 head 文件；补丁落在 `_scratch/wb-pool-update/`。
- 日志与用量：直接读 `out/LLM-Gateway/data/logs/`（`gateway.log*`、`usage/*.jsonl`）。
