# 模型体检报告（2026-09-30）

对配置里**全部逻辑模型**逐个真跑了一遍，失败的逐个供应商隔离诊断。
每条结论都附**上游返回的原文** —— 没有"看起来可能是"，只有"上游是这么说的"。

> **本文档已两次更正，请看最新结论。** 两次都是我先给了结论、后来实测推翻：
> ① "agentrouter 连不上、建议删掉那两个模型" —— 当时 DNS 回了 Meta 的 IP，实际可用；
> ② "nvidia 的 glm-5.3 不可用、建议删除" —— 实际只是慢（15s），加逐模型超时后**可用**。
> 教训：单次测量不足以定论，尤其是对**波动大**的上游。

复跑命令：

```powershell
node scripts/test-models.mjs                  # 两阶段全跑
node scripts/test-models.mjs --phase1         # 只跑阶段一
node scripts/test-models.mjs --config <路径>  # 指定配置（建议先用副本，别直接指实时配置）
node scripts/test-models.mjs --json out.json  # 落机器可读结果
```

---

## 一、结论

**改动后 13/19 可用**（改动前 13/24，但模型数因删除死映射而减少）。
关键变化：`glm-5.3` 从"永远失败"变成**可用**（加逐模型超时后 21.6s 返回）。

| 状态 | 数量 | 模型 |
|---|---|---|
| ✅ 可用 | 13 | claude-opus-5 / gpt-6-astra / deepseek-v4-flash / deepseek-v4-pro / deepseek-v4.1-flash / dots-3-note-preview:free / glm-5.2 / **glm-5.3** / kimi-k3 / laguna-s-2.1:free / mimo-v2.6-flash / nemotron-3-ultra:free / nemotron-3.5-lightning:free / qwen3.8-flash / sensenova-6.8-flash-lite |
| ⏱ 超时 | 1 | glm-5.3-flash（路由链最坏情况超出客户端预算） |
| 🔥 上游故障 | 3 | kimi-k3（只剩 sensenova 一家且被限流）、mimo-v2.5（b.ai 余额 0）、qwen3.8-flash（波动） |
| ⬜ 上游限流 | 2 | gemma-4-26a4b:free / gemma-4-31b-it:free（OpenRouter 共享池） |

### 顺带发现两个**引擎真 bug**（已修，与你改不改配置无关）

1. **一个地区受限的模型会把整家封掉 30 分钟**。`muse-spark` 失败后，同一家另外 13 个模型
   在 1–3ms 内全部 `temporarily in breaker cooldown`。根因：通配分支
   `if (401‖403‖429‖≥500) breakerRecordFail(403)` **排在**"这家不提供该模型"判定**之前**，
   把**模型级**的地区限制升级成了**供应商级**长熔断。全文件有**三处**这样的通配分支。

2. **`amd` 的超时吃掉了整个客户端预算**（60s 且 priority=2 被优先尝试）。
   已改为供应商级 20s + 逐模型 12s。

---

## 二、最重要的一条：**x666 / windhub 的问题不是性能，是模型 ID 对不上**

这两家**所有**声明的模型都回 `No available channel`，但它们自己活得好好的
（`/models` 都是 200）。逐条比对后发现根本原因：

| 供应商 | 你声明的 | 上游**实际**提供的 |
|---|---|---|
| **x666** | `deepseek-ai/deepseek-v4-flash-0731`、`grok-4.6`、`moonshotai/kimi-k3`、`glm-5.3-200k` | `ministral-14b-latest`、**`grok-4.7`**、`glm-5.3-200k`、`ministral-3b-latest`、`glm-5.2-200k`、`ministral-8b-latest` |
| **windhub** | `glm-5.3-flash`、`grok-4.6`、`kimi-k3` | `deepseek-r1-distill-qwen-32b`、`gemma-4-26b-a4b-it`、`glm-4.7-flash`、`llama-3.3-70b-instruct-fp8-fast`、`nemotron-3-120b-a12b`、`qwen2.5-coder-32b-instruct`、**`glm-5.3`**、**`glm-5.2`**、**`grok-4.7`**、`gpt-oss-20b` |

**上游已经把 `grok-4.6` 换成了 `grok-4.7`、`kimi-k3` 整个下架了**，而配置里还指着旧名字。

已完成：删掉这些对不上的映射（windhub 因此变成 0 个模型，x666 剩 1 个）。
**建议用新增的「⚡ 一键获取全部模型」重新填充这两家** —— 它会拉出上面那张"实际提供"的表，
自动映射短名、补参数，你勾选要哪些即可。

### b.ai：余额为 0

```
mimo-v2.5  HTTP 400  {"error":{"message":"credit insufficient balance: balance=0 required=58",…}}
```

`/models` 有 58 个模型，但账户没余额。充值前这家用不了。

### agentrouter：**可用**（本节第二次更正）

```
claude-opus-5    ✅ 3512ms      gpt-6-astra ✅ 9000ms      deepseek-v4-flash ✅ 1414ms
目录（共 4 个）：claude-opus-4-8 / claude-opus-5 / deepseek-v4-flash / gpt-6-astra
```

第一版报告判它们 `UND_ERR_CONNECT_TIMEOUT` 是**当时 DNS 返回了 Meta 的 IP**
（`31.13.91.6` / `2a03:2880:…:face:b00c`），而 Clash TUN 的正确答案是 fake-IP `198.18.0.11`。
再遇到超时先跑这条确认 DNS：

```powershell
node -e "require('dns').lookup('agentrouter.org',{all:true},(e,a)=>console.log(a))"
# 正常应看到 198.18.0.x（Clash fake-IP）；看到 31.13.91.x 或 2a03:2880:… 就是 DNS 又被污染了
```

### nvidia：`glm-5.3` **可用，不要删**（本节第二次更正）

三次实测分别 **15.0s / 21.6s / 45s+** —— 它只是**慢且波动大**，不是不可用。
加逐模型超时 60s 后能正常返回。第一版报告据一次 45s 测量就建议删除，是草率的。

---

## 三、已应用的改动

> 原文件备份在 `gateway.config.json.bak-before-modelopt`，随时可还原。

**① 供应商级超时**

| 供应商 | 改前 | 改后 | 依据 |
|---|---|---|---|
| amd | 60000 | **20000** | 实测 1.3–2.8s；但它会**间歇性挂死**。60s 时 `glm-5.3-flash` 每次都超时 |
| nvidia | 未设(60s) | **20000** | 兜底；慢模型另有逐模型超时覆盖 |
| cline | 60000 | **30000** | 实测成功模型 1.2–31.4s |
| sensenova | 未设(60s) | **20000** | 实测 1.0–1.7s |

**② 逐模型超时**（按实测值定，见每条的括号）

| 供应商 | 模型 | 超时 | 实测 |
|---|---|---|---|
| amd | 全部 4 个 | 12000 | 1.3 / 1.8 / 2.0 / 2.8s（网关内 7–8s） |
| nvidia | `z-ai/glm-5.3` | 60000 | 15.0s（波动到 45s+） |
| nvidia | `z-ai/glm-5.3-flash` | 30000 | 9.4s（另一次 32.6s） |
| cline | `nvidia/nemotron-3.5-lightning:free` | 60000 | 31.4s |

**为什么 amd 是 12s 而不是更大**：`glm-5.3-flash` 依次在 amd → nvidia → cline 上尝试，
**链上求和不能超过客户端预算**。12 + 30 = 42s < 45s。这是"最坏链"约束，不是单点最优。

**③ 删除 10 条已被上游证实不可用的映射**

| 供应商 | 删掉的 | 上游原文 |
|---|---|---|
| x666 | `deepseek-ai/deepseek-v4-flash-0731` | `503 No available channel … under group level3`（且不在目录里） |
| x666 | `grok-4.6` | 同上（目录里是 `grok-4.7`） |
| x666 | `moonshotai/kimi-k3` | 同上（不在目录里） |
| windhub | `glm-5.3-flash` | `503 No available channel … under group auto`（目录里是 `glm-5.3`） |
| windhub | `grok-4.6` | 同上（目录里是 `grok-4.7`） |
| windhub | `kimi-k3` | 同上（不在目录里） |
| cline | `cline-free/solar-pro4` | `404 {"error":"model not found"}`（连续三次，从未成功） |
| cline | `cline-free/muse-spark-1.3-contributor` | `403 … is not available in your region`（从未成功） |
| cline | `nex-agi/nex-n2.5-pro:free` | `402 insufficient_credits "Your Cline Credits balance is $0.00"` |
| cline | `nex-agi/nex-n2.5-mini:free` | 同上 |

**判据是"两个条件同时满足"**：上游 `/models` 目录里没有它 **且** 调用回明确的
no-available-channel / 404 / 402。只满足其一的**一律保留** ——
比如 `cline-free/*` 大多不在目录里，但实测可用（目录不全 ≠ 不能用）。

---

## 四、还没解决 / 需要你决定的

| 项 | 说明 |
|---|---|
| **x666 / windhub 需要重新填模型** | 两家现在分别剩 1 个和 0 个模型。用「⚡ 一键获取全部模型」按上游实际提供的重填 |
| **`glm-5.3-flash` 仍会超时** | 链路最坏 42s，仍在 45s 边缘。要么把它在 amd/nvidia 上的顺序调后，要么接受偶发超时 |
| **`kimi-k3` 现在只剩 sensenova 一家** | 另两家的映射是死的（已删）。sensenova 对它有限流（实测 429） |
| **b.ai 需要充值** | 余额 0 |
| **高波动模型无法根治** | nvidia 的 `glm-5.3` 在 15s–45s+ 之间跳。逐模型超时能减小影响，但消除不了上游本身的波动 |

---

## 五、未证实 / 说明

- 体检只测 **OpenAI 协议的非流式 chat completions**（每模型一次最小请求、`max_tokens: 16`）。
  Anthropic / Responses 两条协议另有端到端测试覆盖，但没有对每个模型逐个跑 ——
  那会把上游调用量放大三倍。
- **`max_tokens` 不能设太小**：实测设成 1 时，很多模型只输出"思考" token、`content` 为空，
  cline 会直接回 `500 empty response content`，看起来像"模型不可用"。
  这是本报告第一版把 cline 十一个模型误判为失败的原因。
- 每次体检消耗极少量上游额度（每模型 1 次请求）。

---

## 三、建议的改动（逐条，可直接照改）

> 全部改动只涉及：**2 处超时** + **8 条已被上游证实为无效的模型映射**。
> 不新增任何东西，不改任何逻辑名，不动其它字段。

### 1. `amd.timeoutMs`：`60000` → `20000`

```jsonc
{ "id": "amd", "priority": 2, "timeoutMs": 20000, ... }
```

**为什么**：它 priority=2（第二个被尝试），而实测首字节 4.7–15.5s、有时直接不返回。
60s 会独占整个客户端超时预算，让排在它后面、**本来可用**的家轮不到。
实测改成 20s 后 `glm-5.3-flash` 从"超时"变为"可用（8.2s）"。

### 2. 给 `nvidia` / `cline` 补显式超时（当前未设，默认 60s）

```jsonc
{ "id": "nvidia", "timeoutMs": 30000, ... }   // 实测 13s 可用，30s 留余量
{ "id": "cline",  "timeoutMs": 30000, ... }    // 免费模型首字节 0.6–8.4s，30s 足够
```

### 3. 删除这 8 条映射

| # | 供应商 | 删掉哪一条（按现配置里的实际写法） |
|---|---|---|
| 1 | x666 | `{"id":"grok-4.6","as":"grok-4.6","vision":true}` |
| 2 | windhub | `"grok-4.6"`（字符串形态那条） |
| 3 | cline | `{"id":"cline-free/solar-pro4","as":"solar-pro4","contextWindow":262144}` |
| 4 | cline | `{"id":"cline-free/muse-spark-1.3-contributor","as":"muse-spark-1.3-contributor","vision":true,"contextWindow":1048576}` |
| 5 | cline | `{"id":"nex-agi/nex-n2.5-pro:free","as":"nex-n2.5-pro:free","vision":true,"contextWindow":262144,"maxTokens":235929}` |
| 6 | cline | `{"id":"nex-agi/nex-n2.5-mini:free","as":"nex-n2.5-mini:free","vision":true,"contextWindow":262144,"maxTokens":235929}` |
| 7 | nvidia | `{"id":"z-ai/glm-5.3","as":"glm-5.3","vision":true}` |
| 8 | x666 | `{"id":"glm-5.3-200k","as":"glm-5.3"}` |

> 第 5、6 条也可以**改成付费 slug**（上游自己给了：`nex-agi/nex-n2.5-pro` /
> `nex-agi/nex-n2.5-mini`），但要先有 Cline Credits 余额，否则仍然是 402。
> 若不打算充值，直接删掉更干净。

### 不建议改的

- **`gemma-*:free` 保留**。它们只是被共享池临时限流，改配置没有意义。
- **`agentrouter` 的三个模型保留**（`claude-opus-5` / `gpt-6-astra` / `deepseek-v4-flash`）：
  它们**实测可用**。第一版报告说"连不上"是当时 DNS 返回了 Meta 的 IP，已更正。
- **`b.ai` 的 `mimo-v2.5` 先观察**：它在同一次体检里失败，但不排除也是瞬时问题 ——
  单独复测一次再决定，别急着删。
- **不要改任何逻辑名**（`as`）。你的客户端里（dsh / Claude Code / Codex 等）已经配了这些名字，
  改名会让它们全部失效 —— 这份清单里一条都没改。

---

## 四、怎么改

三种方式，任选：

1. **界面里改**（推荐）：打开 LLM Gateway → 「供应商」页，逐家编辑模型列表。
2. **原始 JSON**：「设置」→ 原始 JSON，改完点保存（会走完整校验）。
3. **手工改文件**：`dsh-app/out/DSH-App/data/gateway.config.json`
   （改前建议先复制一份；程序自己也会在写入时留 `.bak-gateway`）。

改完建议复跑一次：

```powershell
cd <llm-gateway>
node scripts/test-models.mjs --phase1
```

---

## 五、未证实 / 说明

- `agentrouter` 与 `b.ai` 的不可达是**本机网络现状**，不是永久结论；代理起来后需重测。
- `gemma-*:free` 的 429 是共享池状态，会随时间变化。
- 体检只测了 **OpenAI 协议的非流式 chat completions**（每模型一次最小请求）。
  Anthropic / Responses 两条协议另有端到端测试覆盖（`tests/gateway.test.js`），
  但没有对每个模型逐个跑 —— 那会把上游调用量放大三倍。
- 每次体检都会消耗极少量上游额度（每模型 1 次请求、`max_tokens: 64`）。
