// check-engine-parity.mjs — 引擎与 dsh-app 版本的差异校验（**声明式**）
//
// 背景：llm-gateway 的引擎最初是 dsh-app 版本的**原样副本**，靠"逐行完全一致"来证明
// "现有网关功能全部保留"。后来为了提升客户端仿真/防封禁能力，确实改了若干处 ——
// 于是"零差异"这句话不再成立。
//
// 与其让一句已经不成立的话继续挂在文档里，不如把它换成**可复核的声明式差异**：
//   · 逐块（顶层 function/const/class）比对两个文件；
//   · 变化过的块**必须**在下面的 DECLARED 清单里，且每条都写明理由；
//   · 清单里挂着但实际没变的条目也会报错（防止清单腐烂成"历史遗留"）。
// 这样"哪些地方动了、为什么动"是可机器校验的，而不是靠人记。
//
// 用法：node scripts/check-engine-parity.mjs [--verbose]
// 找不到 dsh-app 的基线时（例如只拿到本程序源码）会明确说明并跳过，不算失败。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT = path.join(ROOT, 'src', 'gateway', 'model-gateway.mjs');

const BASELINE_CANDIDATES = [
  process.env.DSH_GATEWAY_ENGINE_BASELINE,
  path.join(ROOT, '..', 'dsh-app', 'src', 'gateway', 'model-gateway.mjs'),
  path.join(ROOT, '..', '..', 'dsh-app', 'src', 'gateway', 'model-gateway.mjs'),
].filter(Boolean);

/**
 * **声明过的**改动。每一处都必须回答"改了什么、为什么"。
 * 新增改动时务必同时加进这里 —— 脚本会因为"有未声明的变化"而失败，这是故意的。
 */
const DECLARED = [
  { name: '<文件头>', why: '顶部注明本文件是 dsh-app 引擎的副本，并指向本脚本复核差异' },
  { name: 'APP_DIR', why: '默认数据目录名 DSHDesktop → llm-gateway（只影响不传 --config 的裸跑）' },

  // —— 2026-10-14：限流措辞被误判成欠费（本机 sensenova 连续 5 天不可用）——
  { name: 'TRANSIENT_QUOTA_429_RE', why: '新增：「限流被写成额度/配额措辞」的判据。实测商汤对 **RPM/TPM 限流**回 `429 …"code":"insufficient_quota"`，该码命中 WORKBUDDY_CREDIT_RE 的 `insufficient[_a-z]*quota` → 判成欠费 → **冷却 1800 秒**；而它几十秒即恢复，于是两把 Key 轮流被锁、整家静默失能（最后一次成功停在 10-09 09:55）。这条正则把「正文含 tpm/rpm/rate-limit/每分钟」或「错误码是 insufficient_quota / 429003」的 429 先摘出来判成短期限流' },
  { name: 'PERSISTENT_ACCOUNT_RE', why: '改动：不再让"长期欠费"的判定单独承担 insufficient_quota —— 该措辞已由 TRANSIENT_QUOTA_429_RE 在 classifyAccountFailure **最前面**（必须早于 WORKBUDDY_CREDIT_RE，否则那条分支先 return）翻案成短期限流。正文含 credit/balance/insufficient_user_quota 等真·欠费措辞的仍判长期，语义不变' },
  { name: 'classifyAccountFailure', why: '改动：在函数**最前面**加 `if (status === 429 && TRANSIENT_QUOTA_429_RE.test(detail)) return \'rate\'`。位置是生死线 —— 放在末尾没用，WORKBUDDY_CREDIT_RE 分支在它之前就 return 了（这是本次修复的第一版错法，已改正）' },

  // —— 2026-10-14：模型"不在这个端点上"被当成"请求有错"，终止整轮 failover ——
  { name: 'MODEL_NOT_ON_ENDPOINT_RE', why: '新增：判据「这家有这个模型，但不在这个端点上」。实测 commandcode（baseURL=https://api.commandcode.ai/provider/v1）回 400 `"Model \\"…\\" is not supported on this endpoint. Use /provider/v1/chat/completions for OpenAI and OSS models."` —— 它**七个豁免判据全不命中**（措辞与模型缺失/路由缺失都不相交），于是掉进"确定性 4xx → 终止 failover"，客户端整轮任务拿到 400 而死，而同模型还有 8 家候选可用' },
  { name: 'isModelNotOnThisEndpoint', why: '新增：MODEL_NOT_ON_ENDPOINT_RE 的判定入口（只认文案，不看状态码）' },
  { name: 'isEndpointMismatchByProvider', why: '新增：把上面的文案判据限制在 **4xx** 上（同一句话若出现在 200 的 SSE 错误帧里语义不同），并在四条路径（直通账户池 / 直通非账户池 / 翻译路径 / 全部账户耗尽收尾）接入：继续 failover + **不熔断整家** + 交还半开名额，但**记一次模型级失败**（baseURL 写错是持续性配置错误，否则每轮都白打一次必然 400 的端点 —— 实测 dur=25064ms）' },
  { name: 'suggestedEndpointHint', why: '新增：从这类错误体里抠出上游建议的路径（如 `/provider/v1/chat/completions`）写进日志 —— 否则用户只看到"这家坏了"，根本不知道该改 baseURL 的哪一段' },

  // —— 2026-10-14：模型级冷却首档 30 分钟 + 503 文案报错时长 ——
  { name: 'modelBreakerRecordFail', why: '改动（用户报「ling-3.1-flash 调用失败 503」）：模型级冷却**首档改为短冷却**并接上指数退避阶梯。旧实现 `let ms = MODEL_BREAKER_COOLDOWN_MS` —— 首次开闸就直接 30 分钟；而上游当时回的是 429「Upstream model provider is temporarily unavailable. Please try again in a moment.」（明说"稍后重试"），我们却把该模型锁死半小时。该模型只有一家候选 → 用户整轮任务直接死掉。现在与**供应商级**熔断的既有设计对齐：90s → 3m → 6m → 12m → 24m → **上限 30 分钟**（`breaker.cooldownMs` 仍是上限，规则 3 语义不变）。每次冷却到点后半开探测放行一次 → 上游恢复后最多 90 秒即可重新用上' },
  { name: 'breakerCooldownSecs', why: '改动（同一个 503 事故）：必须**两级都看**。旧实现只读 `breaker`（供应商级），而规则 2 的模型级冷却存在 `modelBreaker` 里 → 模型级冷却时算出 until=0 → 落到兜底 BREAKER_SHORT_MS → **503 文案写 "retry in ~90s"，实际要等 30 分钟**。用户照提示重试仍然 503，只会判定"网关坏了"，而这句提示本是他唯一的线索。新增第二个参数 `model`，四处调用点都传入当前模型' },

  // —— 2026-10-14：瞬时 429「上游自己忙」原地重试（ling-3.1-flash 仍不可用）——
  { name: 'TRANSIENT_NET_CODES', why: '改动：紧随其后新增了 UPSTREAM_BUSY_429_RE / INLINE_429_* 三个常量（429 原地重试），本清单按邻近符号记账' },
  { name: 'UPSTREAM_BUSY_429_RE', why: '新增：判据「上游**自己**忙」（temporarily unavailable / try again / overloaded / 上游忙…）。实测 commandcode 的 `inclusionai/ling-3.1-flash:free` 回 `429 "Upstream model provider is temporarily unavailable. Please try again in a moment."` —— 上游明说"稍后重试"。间隔 6 秒、三种请求形态各 3 次的实测：该模型只有约 **1/3 成功率**、随机 200/429，而同家 deepseek 一直 200。旧实现一次 429 就记一次模型级失败 → 3 次开闸；且半开探测**只放行一次**，撞上 2/3 的失败率极易再次开闸 → 该模型在用户看来"永远不可用"' },
  { name: 'INLINE_429_RETRY_DELAY_MS', why: '新增：429 原地重试前的等待（默认 400ms，DSH_GW_429_RETRY_DELAY_MS 可调）。**刻意不用 `envMs()`** —— 它定义在 L714 而本常量在 L169，`const` 的 TDZ 会让模块加载时直接抛 ReferenceError（实测：写成 envMs 后 import 即崩）' },
  { name: 'INLINE_429_MAX_RETRIES', why: '新增：一次客户端请求内对"上游忙"429 的重试预算（默认 2 次，DSH_GW_429_MAX_RETRIES 可调，上限 5）。默认 2 而非 1 的理由：成功率约 1/3 时，1 次重试只能把整体拉到 ~55%，2 次可到 ~70%；代价仅是失败路径多等 2×400ms，且只在命中这一窄判据时发生' },
  { name: 'INLINE_429_RETRY_MAX_WAIT_MS', why: '新增：429 原地重试的**等待上限**（默认 3 秒，DSH_GW_429_RETRY_MAX_WAIT_MS 可调）。等待时长改为 `max(400ms, 上游 Retry-After)` —— 实测 amd 对 `concurrency limit (16)` 回 `Retry-After: 1`（秒），旧实现固定等 400ms **必然再撞同一个并发上限**，日志满屏"429 原地重试仍失败"、重试形同虚设。封顶是因为上游偶尔给几百秒的 Retry-After，照等会把用户请求挂死（那种量级该交给熔断/换家，而非原地干等）' },
  { name: 'forward', why: '改动：`upstreamErrBlock` 内新增"上游忙 429 → 原地重发同一上游请求"，成功后 `break upstreamErrBlock` 按 2xx 继续。**不递归 `forward()`** —— 那会在 L5482 再走一次 `breakerAcquire`，重复占用半开探测名额；`opts` 在本函数可能为 undefined，故用 `opts && opts.retried429` 读取、写入前判空（否则 TypeError 会被 startServer 兜底 catch 包装成一句无关的 `400 invalid JSON body: Cannot read property …`，实测踩到）' },
  { name: 'forwardAnthropicViaOpenAI', why: '改动（同一需求的第二处，**必须有**）：DSH 走的就是这条翻译路径。实测只在 `forward()` 加、没加这里时，一次 429 仍然直接判失败（日志只有 `upstream p1 HTTP 429` 然后 `all-providers status=fail`，重试根本没发生）。实现要点：循环改为带下标的 `for (let ai …)`，重试时 `ai -= 1` **重跑同一个账户** —— 用 `continue` 会走到下一个账户，只有一个账户时直接"全部账户不可用"（实测踩到：日志说"原地重试一次"，紧接着上游仍只被调用 1 次）；预算变量必须在循环**外**声明，否则每次迭代被重置成死循环' },

  // —— 2026-10-14：模型被上游下架的 403 把整家连坐 30 分钟 ——
  { name: 'MODEL_RETIRED_403_RE', why: '新增：判据「**这个模型**被下架/退役了」（has been retired / now a paid model / no longer available…）。实测 commandcode 退役 `inclusionai/ling-3.1-flash:free` 时回 `403 permission_error`，正文点名该模型并给出替代 id；旧实现一律按"鉴权/欠费/权限类 → 与具体模型无关 → 冷却**整家** 30 分钟"，把同家 deepseek-v4.1-flash / glm-5.3-flash（curl 实测都还是 200）一起停了半小时，日志紧接着一片 `skip commandcode (breaker open)`' },
  { name: 'isModelRetired403', why: '新增：把上面的正则与 `permission_error` **同时**要求 —— 判据刻意收窄，避免把真正的整家鉴权失败（裸 `403 Authorization failed` / `account suspended` / `invalid api key`）误判成"只是这个模型的问题"。7 条正负例逐一验证过（含 sensenova 的 `permission_denied_error` 仍走原路径）' },
  { name: 'isProviderWideFailure', why: '改动：文档注释补充"模型退役 403"这一例外说明；判定逻辑本身不变（仍是 401/402/403 → 整家），例外在 `breakerRecordFail` 里按 detail 收窄 —— 这样**不传 detail 的既有调用点语义完全不变**' },
  { name: 'breakerRecordFail', why: '改动：新增可选第 6 个参数 `detail`，用于识别"该模型被下架"的 403 → 降级为**模型级**冷却（不连坐整家）。不传时行为与旧版逐字一致。同时在"全部账户耗尽"的收尾分支（原来写死空模型名 → 必然整家）加了同一判定 —— 账户池只剩一个账户时，一次 403 就会落到那里，实测正是这条路径把 commandcode 整家熔断的' },

  // —— 2026-10-16：请求体过大 → 当次调用跳过该家（commandcode 的 JSON 节点数上限）——
  { name: 'JSON_NODE_LIMIT_DEFAULT', why: '新增：上游"请求体 JSON 节点数"上限的默认值（32768，DSH_GW_JSON_NODE_LIMIT 可调）。实测 commandcode 在 DSH 声明 366 个工具时稳定回 `400 Invalid request JSON: JSON node count cannot exceed 32768`，是**确定性**失败（重试无用），但每次要白等约 3.3 秒才 failover。⚠ 它**只**用于日志展示与 `jsonNodeLimit` 比例的基准 —— 判定线不再由它推导（见下）' },
  { name: 'JSON_NODE_LIMITS', why: '新增：**按请求体形状分列的实测边界表**，每条含 passMax（实测仍通过的最大口径）与 rejectMin（实测被拒的最小口径）。为什么必须分形状：同一个上游对不同结构的 body 会在不同口径处开始拒绝 —— translated（Anthropic→chat，**DSH 走这条**）是 46152/46452，passthrough（客户端本就是 chat）是 47884/48384，两者差约 2000。⚠⚠ 这里记录一个**被实测推翻的设计**：早期版本只用一个全局阈值（由 passMax 48429 推出），结果它**比 translated 的真实边界还高** → 生产场景（366 个工具那条）完全不会被跳过，**功能对它要修的 bug 失效**。改为分形状、且判定线取 rejectMin 后修复' },
  { name: 'JSON_NODE_SAFETY_NOTE', why: '新增：把"判定线取 rejectMin 而非 passMax"这条决定写成常量文本，避免后来者看到本文件里没有 SAFETY 系数而误以为漏了余量 —— 余量的语义已由 rejectMin 本身承担（rejectMin 就是"实测会被拒"的那条线，取它天然不误跳）' },
  { name: 'jsonNodeFootprint', why: '新增：计算请求体的本地节点口径（标量值数 + 对象键数）。刻意不用 `JSON.stringify(body).length` —— 字节数在实测中边界间隔宽达 6575 字节，而本口径只有 500，后者能更紧地贴住真实边界。用显式栈而非递归，避免深层工具 schema 爆栈；每个候选都要付这次遍历（大请求实测毫秒级，相对一次上游往返可忽略）' },
  { name: 'providerJsonNodeBudget', why: '改动：新增 `shape` 参数，按形状取判定线；并按 `声明值/32768` **等比缩放**（不另立系数，保持与实测证据同源）。⚠ 默认语义是**不检查**（返回 Infinity）——这不是保守，而是实测结论：逐家探测发现只有 commandcode 有节点数上限，而 x666 / muyuan.do / aihubmix.com **能吃下 140012 个节点（2.83 MB）的请求并回 200**，对它们套用任何阈值都是**纯误跳**。初版是"默认全局生效、用 jsonNodeLimit:0 关闭"，方向反了，已改为 opt-in' },
  { name: 'providerChecksJsonNodes', why: '新增：判断该家是否配了 `jsonNodeLimit`（供调用方跳过无谓的遍历开销）。没配的家不该为一项它用不到的检查白跑全量遍历' },
  { name: 'providerJsonNodeLimitForLog', why: '新增：把该家有效上限按**上游口径**格式化，仅用于日志展示（避免把内部口径的数字写进用户可见日志造成困惑）' },
  { name: 'exceedsJsonNodeBudget', why: '改动：新增 `shape` 参数并把比较从 `> budget` 改为 `>= budget`（判定线语义是"实测被拒的最小口径"，故等于它就该跳）。估算失败一律返回 false（安全侧：绝不影响转发）' },
  { name: 'forward', why: '改动：在 `if (!rawMode) { lastSentBody = JSON.stringify(outBody); … }` 之后、`fetch` 之前新增"请求体过大 → 本次调用跳过该家"（形状 passthrough）。⚠⚠ **必须量 `outBody`（真正要发出去的那份），不能量入参 `body`**：本函数在 fetch 前会对 body 做一长串变换（translateBody / 剥参数 / 补指纹…），两者不是同一份，而上限卡的是**上游真正解析的 JSON**。这也是该判定不能放在函数开头的原因（初版放错了位置，且一度引用尚未声明的 `rawMode` 触发 TDZ）。结算沿用既有约定：本函数开头已 `breakerAcquire`，故"跳过"必须 `breakerReleaseSlot` 交还半开名额，否则该家被挡到 BREAKER_STALE_MS(180s)。返回 false = "这家不可用、换下一家"，**不记熔断、不冷却账户、不写用量**，从而满足用户"不影响对该供应商后续调用"的要求' },
  { name: 'forwardAnthropicViaOpenAI', why: '改动（同上，**必须有**）：DSH 走的正是这条翻译路径，只改 `forward()` 对 DSH 完全无效（与本月早些时候 429 原地重试踩过的同一个坑）。判定点同理放在 `finalBody` 定稿之后、`fetch` 之前、形状用 translated —— `finalBody` 才是真正 `JSON.stringify` 发出去的那份（`anthropicToOpenAIRequest` 有诊断计数副作用，故不能为了提前判定而多调一次）。结算同理：`clearTimeout(timer)` + `breakerReleaseSlot` 后 `return false`' },
  { name: 'forwardAnthropicViaOpenAI', why: '改动（同上，**必须有**）：DSH 走的正是这条翻译路径，只改 `forward()` 对 DSH 完全无效（与本月早些时候 429 原地重试踩过的同一个坑）。同样放在 `noteToolFingerprint` 之后、`breakerAcquire` 之前' },

  // —— 2026-09-30：客户端仿真 / 防封禁专项改进（依据是官方 SDK/CLI 一手源码）——
  { name: 'clientIdentityOverrides', why: '新增：版本/身份统一覆盖入口（env > 配置 > 默认），避免版本号写死后被上游最低版本门禁拒掉' },
  { name: 'osRelease', why: '新增：os.release() 安全包装，供 UA 与平台头构造使用' },
  { name: 'platformInfo', why: '新增：运行平台规范名（与 @anthropic-ai/sdk 的 detect-platform 同口径）' },
  { name: 'stainlessHeaders', why: '新增：@anthropic-ai/sdk buildHeaders() 必发的 8 个 X-Stainless-*（旧实现一个都没有，"只发 UA+accept 的 Anthropic 客户端"并不存在）' },
  { name: 'CC_BETA_FLAGS', why: '新增：真实 Claude Code 的 anthropic-beta flag 全集（可关，防个别中转对未知 flag 直接 400）' },
  { name: 'claudeClientHeaders', why: '补 x-app/x-stainless-*/anthropic-beta；UA 版本与入口点语义修正（cli → sdk-cli）；accept 改为真实值 application/json' },
  { name: 'clineClientHeaders', why: '版本号改为可配置（服务端有最低版本门禁）；新增 X-Task-ID；版本三者自洽' },
  { name: 'codexClientHeaders', why: 'UA 由"Codex 前缀 + Chrome 浏览器 UA"（Rust CLI 不可能有 AppleWebKit/Safari，最易识破）改为真实形态 codex_cli_rs/<ver> (<os> <ver>; <arch>)；补一等身份头 originator' },
  { name: 'upstreamRequestHeaders', why: 'accept-encoding 由 identity 改为真实值并留回退开关；connection 保持 close 但可配置关闭；按 profile 传 cfg 与 cline 会话 id' },
  { name: 'passthroughHeaders', why: '透传 cfg（供上面的仿真选项使用）' },
  { name: 'fetchCatalog', why: '透传 cfg（目录探测同样走上游请求头构造）' },
  { name: 'doFetchCatalog', why: '透传 cfg' },

  // —— 失效分类与限流遵循 ——
  { name: 'MODEL_UNSUPPORTED_BY_PROVIDER_RE', why: '扩充：把"地区/套餐受限"归入"这家不提供该模型"。实测事故：cline 对一个地区受限模型回 403，旧实现按供应商级 403 熔断整家 30 分钟，把它家另外 13 个正常模型一起封掉' },
  { name: 'CLIENT_FINGERPRINT_RE', why: '新增：识别"客户端指纹被拒"。这类拒绝换 Key/重试都没用，继续打只会加剧风控，必须与普通 403 区分开' },
  { name: 'classifyAccountFailure', why: '指纹类拒绝不得判为账户失败（否则会把用户所有可用 Key 逐把冷却掉还继续往上打）' },
  { name: 'ACCOUNT_RATE_COOLDOWN_MAX_MS', why: '新增：限流冷却上限（含 Retry-After 的夹取）' },
  { name: 'rateCooldownMs', why: '新增：429 冷却优先遵循服务端 Retry-After，否则按连续失败次数指数增长并加 ±20% 抖动（旧实现固定 90 秒、无抖动 → 多账户同刻复活再一起撞墙）' },
  { name: 'retryAfterMs', why: '新增：解析 Retry-After（秒数或 HTTP-date）。旧实现全文件 0 处引用它 —— 无视限流头是升级为封禁的常见路径' },
  { name: 'ACCOUNT_RATE_COOLDOWN_MS', why: '注释更新（由基准值改为基准值+上限）' },
  { name: 'markAccountFailure', why: '接受并应用上游 Retry-After' },
  { name: 'breakerRecordFail', why: '接受可选的服务端 Retry-After 作为短熔断下限（不再"刚被限流就立刻回来接着打"）' },
  { name: 'forwardWithAccounts', why: '把 failureSink 里的 Retry-After 透传给 markAccountFailure' },
  { name: 'forward', why: '接入指纹拒绝/地区受限分支（**在通配 4xx/5xx 熔断之前**判定，否则地区受限的模型会把整家 13 个正常模型一起封掉）；429 冷却传入 Retry-After；failureSink 带 retryMs' },
  { name: 'forwardAnthropicViaOpenAI', why: '同上（Anthropic 翻译路径保持一致）' },
  { name: 'handleModels', why: '透传 cfg 到 fetchCatalog' },
  { name: 'handleCompletion', why: '透传 cfg 到 header 构造' },
  { name: 'handleMessages', why: '同上' },
  { name: 'handleResponsesResource', why: '同上' },

  // —— 逐模型超时（2026-09-30，用户要求）——
  { name: 'modelTimeoutMs', why: '新增：逐模型超时。同一家里不同模型速度能差一个数量级（实测 amd 的 DeepSeek-V4.1-Flash 首字节 13.7–15.5s，同家 DeepSeek-V4-Flash 只要 0.7–1.1s）；只配供应商级时只能按最慢的定，于是一个挂住的慢模型就能把该家快的模型一起拖累' },
  { name: 'providerTimeoutMs', why: '超时优先级改为 模型级 > 供应商级 > 全局默认（新增可选的 model 参数）' },
  { name: 'UPSTREAM_TIMEOUT_MS', why: '仅前导注释块位置变化（常量值一字未改）' },

  // —— 缓存时效 ——
  { name: 'workbuddyVersionCache', why: '缓存加时间戳' },
  { name: 'WORKBUDDY_VERSION_TTL_MS', why: '新增：版本缓存 TTL。客户端自动更新后旧实现会一直发旧版本号（身份头与实际版本不一致，正是仿真里最不该有的破绽）' },
  { name: 'readWorkbuddyVersions', why: '按 TTL 重读版本' },

  // —— 与上游无差异但块边界受上面注释影响的（脚本按"块"比对，注释归属会让相邻块显示为变化）——
  { name: 'accountUsable', why: '仅前导注释块位置变化（函数体一字未改）' },
  { name: 'readTextWithTimeout', why: '仅前导注释块位置变化（函数体一字未改）' },

  // —— 2026-10-07：dsh 写入目标跟进官方新格式（profile patch）——
  // 实测背景：官方 dsh 已把 settings.yaml 标记为 **removed** —— 启动时 importLegacyDocument()
  // 只把它导入一次然后改名成 .imported，而且必须重启才生效。当前真正生效的载体是
  // `<dshHome>/profiles/<profile>/cordis.patch.yml` 里 `- id: llm-pi-ai` 项的 config。
  // 只写 settings.yaml 的话，用户会遇到"命令报成功、dsh 里看不到网关"，而且过一阵还会消失。
  { name: 'reindentBlock', why: '新增：把 gateway 块整体缩进（settings.yaml 里是 4 空格，profile patch 里多一层 `- id:` 数组项、要 6 空格）' },
  { name: 'upsertGatewayInPatch', why: '新增：在 profile patch 里按缩进层级 upsert `- id: llm-pi-ai → config.providers.gateway`。只合并 gateway 一个键（实测踩到：整段替换会把用户已配的其它供应商全部抹掉）' },
  { name: 'writeDshConfig', why: '除 settings.yaml 外**同时**写 profile patch（新老版本互相兜底）；profile 目录不存在时跳过，patch 无法安全合并时如实报错而不是静默跳过' },
  { name: 'writeFileAtomicDsh', why: '仅前导注释块位置变化（函数体一字未改）—— 新增的两个函数插在它前面，脚本按"块"比对会把注释归属算进来' },

  // —— 2026-10-08：从 dsh-our-free-model / dsh-factory-provider 借来的四项能力 ——
  // 两个插件各自踩过的坑，这里做成网关级能力（详见 docs/AUDIT.md 的 M 节）。
  { name: 'TOOL_PAIR_PLACEHOLDER', why: '新增：工具配对修复用的占位应答文案（明确写"结果不可得"，不伪造内容）' },
  { name: 'repairToolPairingChat', why: '新增：chat 协议配对修复 —— assistant.tool_calls[] ↔ role:tool.tool_call_id' },
  { name: 'repairToolPairingAnthropic', why: '新增：messages 协议配对修复 —— content[type=tool_use].id ↔ 下一条的 tool_result.tool_use_id' },
  { name: 'repairToolPairingResponses', why: '新增：responses 协议配对修复 —— input[type=function_call] ↔ function_call_output' },
  { name: 'repairToolPairing', why: '新增：三协议统一入口（残缺的调用记录会让上游 400 并**永久污染该会话**，这是网关的天然职责）' },
  { name: 'CACHE_BP_MAX', why: '新增：Anthropic 单请求最多 4 个缓存断点' },
  { name: 'CACHE_MIN_TOKENS', why: '新增：低于 1024 token 不值得打断点（打了也是白花一次缓存写入 ×1.25）' },
  { name: 'CACHE_BREAKPOINT_MODE', why: '新增：缓存断点全局开关（模块级 —— forward() 的签名里没有 cfg，当参数传会抛 ReferenceError，见该常量注释）' },
  { name: 'cacheBpBlocked', why: '新增：被打断点后仍报错的供应商（学习结果，下次直接跳过）' },
  { name: 'roughTokens', why: '新增：粗略 token 估算（只用于"值不值得打断点"的门槛判断，不参与计费）' },
  { name: 'hasClientCacheControl', why: '新增：检测客户端是否自带 cache_control —— 带了就一个字节都不动（尊重客户端自己的缓存策略）' },
  { name: 'placeAnthropicCacheBreakpoints', why: '新增：缓存断点自动放置。实测同一段前缀不打 0% 命中、打好 99.79%（缓存读 ×0.1 vs 未缓存 ×1，十倍量级）' },
  { name: 'shapeOfHead', why: '新增：只看首个非空 token 判定响应体形状（SSE / JSON）' },
  { name: 'MIN_DECODE_WINDOW_MS', why: '新增：解码窗口下限 —— 短于此不报速度（宁可留空，也不给一个假数字）' },
  { name: 'makeDecodeMeter', why: '新增：解码速度计量器工厂' },
  { name: 'DECODE_TAIL_CHARS', why: '新增：尾部保留窗口（usage 帧可能跨 chunk，保留尾部即可拼出完整 JSON；内存上界不随流长度增长）' },
  { name: 'feedDecodeMeter', why: '新增：增量喂入上游 chunk，识别首字与 usage（只做字符串扫描，转发热路径上不加 JSON.parse）' },
  { name: 'readDecodeMeter', why: '新增：取读数 —— 分子剔除未流出的 reasoning token（实测事故：实际 ~40 tok/s 被报成 2941 tok/s）' },
  { name: 'decodeMeterText', why: '新增：速度读数的日志片段（无可测窗口时如实说"—"）' },
  { name: 'loadConfig', why: '新增一行：把 cfg.cacheBreakpoints 存进模块级 CACHE_BREAKPOINT_MODE（在 port 兜底之后，不影响原有解析）' },
  { name: 'THINKING_UNSUPPORTED_RE', why: '仅前导注释块位置变化（正则一字未改）—— 新增的函数插在它前面，脚本按"块"比对会把注释归属算进来' },

  // —— 2026-10-08 第二批：会话亲和 + OpenCode 免费车道仿真 ——
  { name: 'SESSION_AFFINITY_MAX', why: '新增：会话亲和表容量上限（key 客户端可控，必须 LRU 有界，口径同 rrCounters）' },
  { name: 'SESSION_AFFINITY_MIN_TOKENS', why: '新增：兜底键（前缀哈希）的最低门槛 —— 低于它没有值得保护的缓存，见 sessionKeyOf 的说明' },
  { name: 'sessionAffinity', why: '新增：会话亲和表。与既有 responseAffinity **分开**：那条是"必须回去"（否则 404），这条只是"优先回去"（缓存热度），语义不同不能混用一张表' },
  { name: 'sha16', why: '新增：取 sha256 前 16 位十六进制（会话键/会话 id 都用它）' },
  { name: 'sessionAffinitySet', why: '新增：记档实际成功的那家（不是配置优先级那家）' },
  { name: 'sessionAffinityGet', why: '新增：取亲和（LRU 触碰）' },
  { name: 'sessionKeyOf', why: '新增：会话键派生 —— metadata.user_id / body.user / 信头 / 稳定前缀哈希，取不到就返回 null（绝不猜）。只存哈希不存原文' },
  { name: 'sessionAffinityEnabled', why: '新增：开关语义（auto 在 failover 下开、round-robin 下关 —— 用户显式要分摊流量时亲和会跟它对着干）' },
  { name: 'affinityGet', why: '仅前导注释块位置变化（函数体一字未改）—— 新增的会话亲和代码插在它后面，脚本按"块"比对会把注释归属算进来' },
  { name: 'OPENCODE_DEFAULT_VERSION', why: '新增：OpenCode 车道 UA 版本（上游要求 ≥1.17），走 clientVersions/env 可覆盖，不写死' },
  { name: 'opencodeVersion', why: '新增：版本号解析（与 cline/codex 同套路）' },
  { name: 'opencodeClientHeaders', why: '新增：OpenCode 桌面客户端的静态仿真头（动态的 session/request id 在 forward 里按对话内容补）' },
  { name: 'opencodeSessionId', why: '新增：会话 id —— **必须由对话内容派生且跨轮稳定**，上游按会话计费，每请求新铸一个会直接 429' },
  { name: 'opencodeRequestId', why: '新增：每轮一个请求 id' },
  { name: 'OPENCODE_FINGERPRINT_TOOLS', why: '新增：免费档要求的工具四元组 bash/glob/grep/read' },
  { name: 'ensureFingerprintTools', why: '新增：补齐工具四元组（缺了上游 403 FreeTierError）。只"补声明"不"顶替"——纯转发网关无从知道客户端有什么真实工具，这一点与进程内插件的做法有意不同，日志里如实说明' },

  // —— 2026-10-08 审计轮：三个实测出来的 bug 修复（详见 docs/AUDIT.md 的 O 节）——
  { name: 'deriveSessionKey', why: '新增：把"派生会话键"与"是否值得用"拆开。原来 sessionKeyOf 既派生又带 512 token 门槛，被 opencode 车道复用后，**四种短对话全部拿不到会话头** → 上游 400 MissingSessionID' },
  { name: 'applyOpencodeLaneHeaders', why: '新增：把 OpenCode 车道的动态会话头抽成辅助函数，**两条转发路径都要调** —— 只在 forward() 里加会让声明了 openai-chat 的那 29 个模型全部 400（翻译路径不经过 forward）' },

  // —— 2026-10-08 协议矩阵：任意客户端协议 × 任意上游协议 ——
  // 用户要求："不论上游模型是什么协议，对外需要同时提供 openai 和 Anthropic，openai 还得支持 responses"。
  // 实测（out/_matrix.cjs / _smatrix.cjs）：改之前 9 格里 5 格坏，而且是**200 + 错的响应体形状**。
  { name: 'wireOfName', why: '新增：线协议名归一化（含别名），矩阵的地基' },
  // ⚠ 2026-10-25 第八轮审计：原条目 `wireOfClientPath`（"新增：客户端请求路径 → 线协议"）**已删除**。
  //   那个函数从来没有被调用过（全文件 0 调用点）—— 真正的 clientWire 由两处调用方各自显式决定：
  //   handleCompletion 的 `responsesMode ? 'openai-responses' : 'openai-chat'`、handleMessages 的常量
  //   `'anthropic-messages'`，分派依据是 routeRequest 按路径的 if 分支。把死映射登记成"功能"，
  //   等于在账本上给一段没人跑的代码记了一笔。函数已删，这里只留说明。
  { name: 'resolveUpstreamWire', why: '新增：逐模型 api → 供应商 protocol → 跟随客户端。**逐模型这一层是矩阵的前提**（实测 opencode-go 37 个模型分属三种协议）' },
  { name: 'upstreamEntryFor', why: '新增：返回整个模型条目（调用方要读 api）；upstreamIdFor 改为走它 —— 选择规则只留一份，避免"两处各写一遍然后漂移"' },
  { name: 'upstreamIdFor', why: '改为委托 upstreamEntryFor（行为不变）' },
  { name: 'modelEntries', why: '新增：解析逐模型 `api` 字段（也接受 protocol / wire 别名）；只在写得出来时才附带，保持条目 JSON 形状稳定' },
  { name: 'providerProtocol', why: '新增一行：认识 openai-responses。旧实现只认前两种 → `protocol: "openai-responses"` 落到 return null → 调用方以为"跟随客户端" → **矩阵翻译根本不触发**（实测：chat 客户端收到 Responses 体）' },
  { name: 'logicalModelSupportsVision', why: '仅前导注释块位置变化（函数体一字未改）' },
  { name: 'estimateTokens', why: '仅前导注释块位置变化（函数体一字未改）' },
  { name: 'responsesInputToChatMessages', why: '新增：Responses input（字符串/数组/function_call/function_call_output）→ chat messages' },
  { name: 'responsesToChatRequest', why: '新增：Responses 请求 → canonical(chat)。含 tools 扁平↔嵌套的转换（实测不做会 400）' },
  { name: 'chatToAnthropicRequest', why: '新增：canonical(chat) → Anthropic 请求。含 role:tool→tool_result、max_tokens 必填兜底' },
  { name: 'chatToResponsesRequest', why: '新增：canonical(chat) → Responses 请求。含 tools 嵌套→扁平' },
  { name: 'translateMatrixRequest', why: '新增：请求侧矩阵（client→chat→upstream）。末尾统一对齐 stream 字段 —— 实测 anthropicToOpenAIRequest 不复制它，漏了会让上游回非流式而客户端在等 SSE' },
  { name: 'finishFromStopReason', why: '新增：Anthropic stop_reason → chat finish_reason（既有 stopReasonFromFinish 的逆）' },
  { name: 'anthropicMessageToChatCompletion', why: '新增：Anthropic message → canonical(chat)' },
  { name: 'responsesToChatCompletion', why: '新增：Responses 响应 → canonical(chat)。含 status/incomplete_details → finish_reason 的映射（Responses 没有 finish_reason 字段）' },
  { name: 'chatToResponsesResponse', why: '新增：canonical(chat) → Responses 响应' },
  // ⚠ 2026-10-25 第八轮审计：原条目 `translateMatrixResponse`（"新增：响应侧矩阵，非流式"）**已删除**。
  //   该函数同样 0 调用点 —— 非流式响应翻译实际由 forwardMatrixResponse 的 ② 分支完成
  //   （先把上游读成 canon(chat)，再按 mx.clientWire 用 openaiToAnthropicMessage / chatToResponsesResponse
  //   成形，见该函数 :10308-10312）。那里的映射与本函数是同一套的两份实现，函数已删，只留说明。
  { name: 'upstreamPathOfWire', why: '新增：线协议 → 上游请求路径' },
  { name: 'makeStreamDecoder', why: '新增：上游 SSE 帧 → canonical 事件（三种协议各一个分支）。缺 index 的上游按 id 兜底落槽，否则工具参数会串到别的调用上' },
  { name: 'makeStreamEncoder', why: '新增：canonical 事件 → 客户端 SSE 帧（三种协议各一个分支）+ 幂等 finish()' },
  { name: 'pumpMatrixStream', why: '新增：流式泵。⚠ flush 必须可重复调用 —— forward 的"首事件偷看"会把开头那段（对流式短响应来说往往就是全部）先读走，只在循环体里解析会让那些字节**永远不被解析**，客户端收到 200 + 空 body' },
  { name: 'canonicalToChatCompletion', why: '新增：canonical 事件 → chat 完整响应（上游流式而客户端要非流式时用）' },
  { name: 'makeCanonicalCollector', why: '新增：canonical 事件累积器' },
  { name: 'drainCanonicalStream', why: '新增：把上游流读成 canonical（聚合用）' },
  { name: 'chatCompletionToCanonicalEvents', why: '新增：完整 chat completion → canonical 事件（上游非流式而客户端要流式时，合成一条 SSE 流回给客户端）' },
  { name: 'forwardMatrixResponse', why: '新增：矩阵响应分支的总入口。位置刻意在"首事件偷看之后、任何 writeHead 之前"' },

  // —— 2026-10-08 第七轮全面审计（4 路并行子代理 + 自查）的修复 ——
  { name: 'openaiToAnthropicMessage', why: '修：有 tool_calls 时必须报 tool_use，不能看 finish_reason。旧实现在"上游给了 tool_calls 却把 finish_reason 写成 stop"（OpenAI 世界里被普遍容忍）时报 end_turn，Anthropic 客户端据此**不执行工具**；而同一份代码的流式路径报的是 tool_use —— 同一条翻译链自相矛盾' },
  { name: 'routeRequest', why: '修：新增 CORS 预检（OPTIONS）分支，且**放在鉴权之前**。预检请求按规范不带凭据，放在 authorized() 后面必然 401；旧实现根本没有 OPTIONS 分支（无凭据 401 / 带凭据 404），浏览器端客户端一律用不了。同时补 access-control-allow-headers —— 原来只回 allow-origin，即便预检通过了浏览器也不允许发 anthropic-version 这类自定义头' },
  { name: 'responsesInputToChatMessages', why: '修：input 是**单个对象**时整段输入被丢光（旧实现 `Array.isArray(input) ? input : []`），客户端却拿到 200、模型对空输入作答' },
  { name: 'drainCanonicalStream', why: '修：补收尾 flush（与 pumpMatrixStream 同一个坑的未修版本）。偷看过的字节可能整条都在缓冲区里，只在循环体内解析会静默吞掉最后一帧' },
  { name: 'forwardAnthropicViaOpenAI', why: '修：上游 200 却返回非 JSON（反代 HTML 错误页）时不再 `return false` 而是 `{stop:{status:502,reason}}`。`false` 的契约是"换下一家"，但这不是换一家能解决的 —— 上游已处理过请求（可能已计费），failover 只是 N 倍计费，用户最终拿到网关自己的 503 而真因只在日志里。这是 Anthropic→chat 这条**最常用**路径' },

  // —— 2026-10-08 第七轮审计的"未修项"补齐 ——
  { name: 'breakerRecordSuccess', why: '修：不再整条 delete。`opens`（连续开闸次数）存在条目里，而退避是 `base * 2**(opens-1)` —— 删掉等于把阶梯历史清零，于是"3 次失败→冷却→探活成功→又 3 次失败"的**抖动型坏家**永远停在第一档 90s（而它恰恰最该退避）。改成只清 fails/state/openUntil' },
  { name: 'breakerCooldownSecs', why: '修：过滤掉非对象条目。配置里出现 `providers: [null]` 时旧实现直接 `p.id` 抛 TypeError，而它是在**构造 503 响应体**时被调用的 → 真正的信息"全部候选都在熔断"被兜底 catch 换成不透明的 500' },
  { name: 'maskSecrets', why: '修：补"裸高熵串"兜底。实测上游 401 时裸回显收到的凭据（无前缀、无关键词），前面所有规则都不命中 → 明文进 gateway.log，并经 accountPool.reason 进入**免鉴权**的 /health。兜底刻意保守：≥28 字符 + 同时含字母数字 + 不是纯 hex 才打码' },
  { name: 'accountPoolSnapshot', why: '修：顺带清理过期条目。旧实现什么都不清，而它渲染的是**免鉴权**的 /health —— 响应体与 accountPool 规模同步增长（实测连打 200 次 /health，每次序列化 300 条 / 47KB）' },
  { name: 'ACCOUNT_POOL_MAX', why: '新增：账户池容量上界 512（与 sessionAffinity/responseAffinity 同量级）。键含上游模型 ID，"上游逐模型限流"时每模型一条 → 客户端可逐个模型把它撑大' },
  { name: 'responsesInputToChatMessages', why: '（同上）另修两处：input 为单个对象时不再丢光；`input_image` 不再被降级成字面量 "[image]" —— 那等于把图换成四个字母，而 imageBlockStats 仍按图片计数（路由到支持图片的家却发过去一句占位符）' },
  { name: 'chatToResponsesRequest', why: '修：补回停止序列（唯一漏掉它的一格）；对 previous_response_id/store/include/truncation/parallel_tool_calls 这些 chat 上游没有对应概念的**有状态字段**记日志，而不是静默丢弃' },
  { name: 'forward', why: '修：直通路径新增"上游 200 但 content-type 既不是 JSON 也不是 SSE"检测 → 502。真实高频形态是反代插的 HTML 错误页，旧实现把它原样配 200 透传，客户端拿到"成功"却解析失败而网关日志一片干净（四条路径里只有这条不一致）' },
  { name: 'UPSTREAM_BROKEN_4XX_RE', why: '新增：识别「上游自己坏了却包成 4xx」。bad_response_status_code 是 new-api/one-api 系的错误码，语义就是「我转发出去的那个上游返回了坏状态码」，属供应商侧故障；旧的「确定性 4xx 一律终止 failover」把它当成请求侧问题，于是优先级更高但坏掉的那家直接把请求打死。实测：h-e.top 优先级 1 对 glm-5.3-flash 回这个 400，而 opencode-go 优先级 3 明明能服务该模型却根本没被尝试。三处判据都已加。' },
  { name: 'DETERMINISTIC_4XX_STATUS', why: '仅前导注释块位置变化（常量本身一字未改）' },
  { name: 'resolveWorkBuddyCredential', why: '修：分辨「没登录」与「格式变了」。WorkBuddy 桌面版新版把 accessToken/refreshToken 改成 AES-GCM 加密存储（{ $wbEncrypted: 1, envelope }），而本程序读的是明文字段 → 必然 null。旧实现一律报「未登录或已失效」，把用户引向反复重新登录（徒劳）。现在检测到加密形态就明说：密钥不在本机、重新登录没用、可选处置有哪三条。' },
  { name: 'WORKBUDDY_AT_REST_HELPER', why: '新增：喂给 WorkBuddy 自带 Electron 的一行脚本（ELECTRON_RUN_AS_NODE=1 下取 loggerGet()）。它是拿到 atRestSecretKey 的唯一途径' },
  { name: 'WORKBUDDY_ELECTRON_BIN_ENV', why: '新增：环境变量 WORKBUDDY_ELECTRON_BIN，装机位置不标准时显式指定 WorkBuddy 主程序' },
  { name: 'workbuddyElectronCandidates', why: '新增：WorkBuddy 主程序的候选路径（Windows 两个 Program Files + LOCALAPPDATA\Programs，macOS /Applications），环境变量优先' },
  { name: 'workbuddyAtRestKeys', why: '新增：keyId → atRestSecretKey 的**内存**缓存（绝不落盘）' },
  { name: 'workbuddyAtRestProbe', why: '新增：取密钥的单飞状态，并发请求共享一次探测' },
  { name: 'probeWorkBuddyAtRest', why: '新增：以 ELECTRON_RUN_AS_NODE=1 跑 WorkBuddy 自己的 exe，取回 {version:1,atRestSecretKey} 并校验（base64 32 字节、非全零），派生 protectorKey=sha256(secret) 与 keyId=sha256(key).hex[0:16]。只记 keyId，绝不记密钥' },
  { name: 'workbuddyAad', why: '新增：逐字节照抄 WorkBuddy 5.6.2 的 buildAuthenticatedContextAad（WB-AAD\0 | 0x01 | LP(WBEV1) | LP(sym-v1) | u32(suite) | LP(keyId) | 0x02 | 0x00 | 0x00）' },
  { name: 'workbuddyIsWrapped', why: '新增：判定 {$wbEncrypted:1,envelope} 信封形态' },
  { name: 'openWorkBuddyField', why: '新增：用 AES-256-GCM 解一个信封；GCM 校验失败即返回 null（不重试、不猜别的 framing）' },
  { name: 'openWorkBuddyAuthText', why: '新增：把加密文档解成**明文 JSON 文本**再交给 parseWorkBuddyAuth —— 下游解析逻辑完全不用改；非加密文档零开销直通' },
  { name: 'parseWorkBuddyAuth', why: '无改动（重新格式化导致块指纹变化）—— 解密在 openWorkBuddyAuthText 里完成，本函数仍只读明文' },
  { name: 'describeAbortIfOurs', why: '新增：区分「我们自己的超时中止」与「上游/代理主动断开」。undici 在 abort 时 message 恒为 This operation was aborted，两者完全同形；旧实现只记这一句，17 条一模一样的日志既看不出是主动放弃、也看不出阈值与实际等待时长 —— 而这三件事正是判断「上游慢」/「请求没发出去」/「阈值配太小」的全部依据。现在记为「上游无响应，超时，阈值 Nms，已等 Mms」，并在 M 明显小于 N 时点明「未到阈值就被中止，调大阈值无用」' },
  { name: 'describeFetchError', why: '无改动（附近插入了新函数导致块指纹变化）' },
  { name: 'workbuddyAtRestCooldownUntil', why: '新增：探测失败后的冷却截止时刻。没有它时成功路径靠 keyId 缓存跳过探测，而**失败路径什么都不留** —— "装了 WorkBuddy 但候选路径都不对"的用户每个请求都会把全部候选串行重跑一遍（在请求热路径上同步等待）。默认 5 分钟，可用 DSH_GATEWAY_WB_KEY_COOLDOWN_MS 调整' },
  { name: 'workbuddyAtRestLastError', why: '新增：上次探测失败的原因，冷却期内直接抛它（不再 spawn）' },
  { name: 'WORKBUDDY_AT_REST_FAIL_COOLDOWN_MS', why: '新增：失败冷却时长，默认 5 分钟（DSH_GATEWAY_WB_KEY_COOLDOWN_MS 可覆盖，设 0 关闭）' },
  { name: 'WORKBUDDY_AT_REST_TIMEOUT_MS', why: '修：单候选超时 60s → 15s。实测本机取 payload 只要 146–537ms，60s 是三个数量级的余量，而它乘上候选数就是最坏等待（一个卡住的候选挡住后面全部）。15s 仍是实测值的 30 倍以上，最坏路径从 3 分钟降到 45 秒。DSH_GATEWAY_WB_KEY_TIMEOUT_MS 可覆盖' },
  { name: 'LOOPBACK_HOSTS', why: '新增：回环主机名白名单。网关监听 127.0.0.1 且 /health 必须免鉴权（watchdog 自检，加鉴权会自杀重启），故只剩"校验 Host/Origin"这一条 DNS rebinding 防线。依据 corrinehu/dsh-workbuddy-connect 的 src/loopback.ts' },
  { name: 'hostnameOfHost', why: '新增：从 Host 头剥端口（IPv6 方括号感知）。不能用 split(":")[0] —— [::1]:3091 会被切坏、裸 ::1 的冒号不是端口分隔符，切错会拒绝合法的 IPv6 回环' },
  { name: 'hostIsLoopback', why: '新增：Host 是否指向回环。缺失/为空 → false（fail-closed）' },
  { name: 'originIsLoopback', why: '新增：浏览器发的 Origin（存在该头时）是否回环。非浏览器客户端不发 Origin → 放行（否则正常流量全被挡）' },
  { name: 'MAX_BODY_BYTES', why: '无改动（附近插入了新函数导致块指纹变化）' },
  { name: 'SESSION_AFFINITY_MAX_MSGS', why: '新增：会话亲和的对话长度上限（默认 300，DSH_GATEWAY_AFFINITY_MAX_MSGS 可覆盖，0 关闭）。亲和的动机是别让长前缀缓存作废，但上下文单调增长 → 被钉住的那家反复接收越来越大的请求体 → 越容易断连、断连触发重试、请求被拖长。即**亲和本身会喂养它想避免的问题**。参照实现实测 333 个请求：<150 条断连率 0%、150-300 3.4%、300-400 7.8%、400-500 10.0%（它们取 400，我们代理 15 家形态各异的上游故取更保守的 300）。A/B 已验：上限=300 时长对话不再"提到首位"，上限=0 时恢复' },
  { name: 'conversationItemCount', why: '新增：请求里对话条目数（兼容 chat 的 messages[] 与 Responses 的 input[]），供亲和上限判定' },
  { name: 'providerHasCredential', why: '新增：该家是否至少有一份凭据来源。用作 /v1/models 的门槛。依据 corrinehu/dsh-workbuddy-connect 的 catalog.ts:104-110（"没凭据就该暴露**零**个模型，给一份只能失败的兜底列表比什么都不显示更糟"）。实测：apiKey 为空/占位值的家，模型照样被列出，选中必然 503。只判**结构性**缺失，不因账户暂时冷却就隐藏（那会让列表闪烁）' },
  { name: 'upstreamKeyMissing', why: '新增：上游 Key 是否"没填/还是模板值"。占位清单与 src/writers/util.js 的 PLACEHOLDER_KEYS 保持一致（引擎是独立 .mjs 不能 require，故复制一份，改一处要改两处）' },
  { name: 'PLACEHOLDER_UPSTREAM_KEYS', why: '新增：占位 Key 清单（同 writers/util.js）' },
  { name: 'apiKeysOf', why: '无改动（附近插入了新函数导致块指纹变化）' },
  { name: 'proxyStatus', why: '修（安全 V2）：抹掉代理 URL 里的 user:password 再外露。这个对象进**免鉴权**的 /health（watchdog 要用它自检，不能加鉴权），而代理 URL 是应用自己注入的且允许带 userinfo —— 实测带 userinfo 的代理会原文出现在 /health 里，任何本机进程读一次就拿到代理口令。只保留 host:port，口令换成 ***' },
  { name: 'log', why: '修（安全 V5）：日志消息转义换行。消息里带客户端可控内容（model 名、URL 路径、上游错误体），不转义时一条请求就能**伪造出完整的日志行**（含伪造时间戳与级别）—— 实测 model="nope\n[时间戳] breaker OPEN: ..." 一次写出 3 行。宿主 logger.js:161 早有这条转义并写明理由，引擎这份一直漏着。顺带挡住 16MB 级单行日志的写放大' },
  { name: 'json', why: '修（正确性 D3/D5/D6 的公共放大器）：headersSent 时 catch 里**必须 destroy**。典型情形是流式响应中途出错、兜底 catch 又想回一个 JSON 错误 —— 此时一个字节也写不出去，而也没有别人负责收尾（pumpMatrixStream → forward → handleCompletion → routeRequest catch → replyBodyError → 这里），旧实现静默 return 导致**客户端永远等不到终止**（实测矩阵路径悬挂 4s+ 不关，直通路径 202ms 就关）' },
  { name: 'accountKey', why: '无改动（附近插入新常量导致块指纹变化）' },
  { name: 'accountModelKey', why: '修（安全 V3）：model 必须截断到 128 字符。它是客户端可控的，而这个键会 ① 成为 accountPool 的键 → 512 条 × 16MB ≈ 8GB 常驻内存；② 被 accountPoolSnapshot 原样列进免鉴权的 /health。实测 4 个 20 万字符的 model 名 → GET /health 返回 801KB。条目数早有上界，漏的正是"值"这一维。三个调用点传同一个 model 值，截断后仍自洽' },
  { name: 'ACCOUNT_MODEL_KEY_MAX', why: '新增：模型级冷却键里 model 部分的长度上限（128）' },
  { name: 'translateOpenAIStreamToAnthropic', why: '两处改动。①（v0.8.4）修正确性 D7：message_delta 必须带上**真实**的 input_tokens —— 紧邻的返回值里已经优先用了上游的 prompt_tokens，但收尾帧只带 output_tokens，客户端（Claude Code 等）只看流里的 usage，于是同一轮请求非流式看到真值、流式看到 message_start 里的本地估算（len/4），两个口径自相矛盾。实测修后 message_delta.usage = {"output_tokens":56,"input_tokens":1234}，与非流式一致。②（v0.8.6）**流式也能构造 tool_use 了**：把 DSML 解析出的调用喂进**已有的** toolCalls 映射（槽位用负数，与上游 index≥0 不冲突），由流结束的 flushToolCalls() 补成真正的 tool_use 块 —— 与结构化 tool_calls 同一个出口，刻意不新造流式状态机；同时接上 dsmlStreamFlush 归还残余。实测：标记跨分片（<|DSM / L|calls>）+ 字节级切断下，客户端收到 text + tool_use(run_shell) + stop_reason=tool_use，标记零泄漏' },
  { name: 'cachedTokensOf', why: '新增：从 OpenAI 风格 usage 里取缓存命中 token。各家字段名不一（prompt_tokens_details.cached_tokens / prompt_cache_hit_tokens / cached_tokens），统一收口。**这是"缓存命中率全变成 0%"的根因** —— 引擎里原先搜 cached_tokens / cache_read_input_tokens 零命中，上游明明报了也被丢掉' },
  { name: 'cacheWriteTokensOf', why: '新增：取缓存写入 token（Anthropic 的 cache_creation_input_tokens）' },
  { name: 'anthropicUsage', why: '新增：构造**含缓存字段**的 Anthropic usage。实测（2026-10-09 用户报"缓存命中率全变成 0%"）：上游 opencode-go 对同一段长前缀返回 prompt_tokens_details.cached_tokens 2048（首轮）→ 2944（次轮），**上游缓存是好的**；而引擎翻译时把整个字段丢掉，客户端（DSH/Claude Code）算命中率读的正是 cache_read_input_tokens，于是恒为 0%。只在有值时附加，不凭空声明 0（否则客户端无法区分"确实没命中"与"上游没报这个字段"）' },
  { name: 'CODEX_OAUTH_CLIENT_ID', why: '新增：Codex 订阅集成。OAuth client_id / 刷新端点 / scope 从**官方 codex.exe**（318MB Rust 二进制）字符串提取，非猜测。配套：CODEX_OAUTH_TOKEN_URL / CODEX_OAUTH_SCOPE / CODEX_DEFAULT_BASE_URL' },
  { name: 'codexAuthFileCandidates', why: '新增：凭据文件候选位置。**CODEX_HOME 优先** —— 实测本机该变量指向 D:\IDE\stockbase\.codex，而 ~/.codex/auth.json 里只有 API Key（只读后者会读到一个没用的文件）' },
  { name: 'findCodexAuthFile', why: '新增：按候选顺序找存在的 auth.json' },
  { name: 'readCodexAuth', why: '新增：按 mtime 缓存读凭据 —— 官方客户端刷新令牌后我们能立刻看到新值' },
  { name: 'jwtExpMs', why: '新增：从 JWT 取过期时间（秒→毫秒）' },
  { name: 'codexNeedsRefresh', why: '新增：提前 5 分钟算过期，避免刚好在边界上被上游 401。读不出 exp 时不盲目刷新（交给上游判定）' },
  { name: 'refreshCodexToken', why: '新增：用 refresh_token 换新令牌并**原子写回**凭据文件。写回是必须的 —— 官方客户端也用同一个文件，不回写会导致两边各自刷新、互相把对方的 refresh_token 作废。保留其它字段（auth_mode/last_refresh），只更新 tokens；refresh_token 缺失时**沿用旧的**而非置空' },
  { name: 'resolveCodexCredential', why: '新增：解析可用凭据（必要时自动刷新）。account_id 优先取文件里的 tokens.account_id，缺失才从 JWT 的 https://api.openai.com/auth claim 推（pi-ai 用的是后者）' },
  { name: 'codexPlanOf', why: '新增：从 JWT 读订阅档位（仅日志/界面显示，不参与鉴权）' },
  { name: 'codexUpstreamHeaders', why: '新增：Codex 后端必需请求头。逐个来自实测：authorization / chatgpt-account-id / originator / OpenAI-Beta / session-id / x-client-request-id。少任何一个都会被拒' },
  { name: 'isCodexProvider', why: '新增：判据 auth === "codex"' },
  { name: 'accountUpstreamHeaders', why: '改：新增 Codex 分支（走它自己的头集合 —— 用普通 Bearer apiKey 打这个端点会 401）' },
  { name: 'upstreamBase', why: '改：**Codex 路径不补 /v1**。实测后端很严格：/backend-api/codex/responses → 200；/backend-api/codex/v1/responses 与 /backend-api/v1/responses → 404。判据用 /codex 结尾，足够窄不误伤普通供应商' },
  { name: 'pickHeaderCI', why: '改（连带）：Codex 分支用到它，函数体未变，仅位置/块指纹变化' },
  { name: 'aggregateOpenAIStream', why: '改（连带）：本块内新增了截断检测（见上一条相关声明），Codex 集成未改它' },
  { name: 'CODEX_OAUTH_TOKEN_URL', why: '新增：Codex OAuth 刷新端点（从官方 codex.exe 提取）' },
  { name: 'CODEX_OAUTH_SCOPE', why: '新增：Codex OAuth scope（从官方 codex.exe 提取：openid profile email offline_access api）' },
  { name: 'CODEX_DEFAULT_BASE_URL', why: '新增：Codex 后端默认基址 https://chatgpt.com/backend-api（来源：pi-ai 的 DEFAULT_CODEX_BASE_URL）' },
  { name: 'codexAuthCache', why: '新增：凭据读缓存（按 mtime 失效）' },
  { name: 'CODEX_REFRESH_SKEW_MS', why: '新增：提前 5 分钟算过期' },
  { name: 'codexRefreshInflight', why: '新增：刷新去重（并发请求只刷一次，避免把一次性 refresh_token 用废）' },
  { name: 'WORKBUDDY_CHANNEL_BLOCK_RE', why: '新增：WorkBuddy 软性渠道拦截识别（实测原文 HTTP 400 code:11128 "Illegal API invocation from an unapproved channel" / displayMsg.en "Request blocked. Please send it again"）。上游自己要求重发 = 瞬时风控，不是请求有错。实测 52 次成功夹 1 次（≈2%），用户侧表现为 Claude Code 任务"不时"中止。两处判定（直通路径 + 矩阵路径）都要用它 —— 第一次只改了直通那处，矩阵路径当场没生效' },
  { name: 'CONFIG_PATH', why: '改（连带）：在同一处新增了 LOADED_CFG，块指纹变化' },
  { name: 'thinkingPassbackProviders', why: '改（连带）：在其后新增了 clientSimulationProviders 的声明与说明，块指纹变化' },
  { name: 'retryWithoutThinking', why: '改（连带）：新函数插在它旁边，块指纹变化' },
  { name: 'providerClientProfile', why: '改：新增"学到的仿真"分支 —— 该家曾被指纹拒绝且仿真重试成功过 → 后续请求首次就返回 claude 仿真，不再白挨一次 401' },
  { name: 'LOADED_CFG', why: '新增：模块级配置引用。加载配置时的 const cfg 是**函数内局部变量**，模块级辅助函数拿不到；客户端仿真头需要 cfg（claudeClientHeaders 要用 clientVersions 覆盖版本号）。直接写 cfg 会抛 ReferenceError: cfg is not defined，且异常被上层吞掉 → 表现为"分支进了、什么都没发生、客户端拿到 400"' },
  { name: 'clientSimulationProviders', why: '新增："该家需要客户端身份仿真"的学习标记（与 thinkingPassbackProviders 同一套模式）。实测 agentrouter 按**请求头指纹**准入：默认 Node/Chrome/curl/python → 401 unauthorized client detected；Claude Code 头/Codex 头 → 200 通过。旧实现只熔断并写"无法伪装指纹，这是已知上限"—— 对这类家是错的' },
  { name: 'retryWithClientSimulation', why: '新增：指纹被拒时换 Claude Code 身份仿真重试一次（照 retryWithoutThinking 的模式：先学习、再重试；只改仿真身份头，认证头保持）' },
  { name: 'writeBlockedDump', why: '改（连带）：在其附近插入了用量记录模块，块指纹变化' },
  { name: 'USAGE_KEEP_DAYS', why: '新增：用量文件保留 30 天（用户选择 C）。按文件名里的日期清理，不依赖 mtime' },
  { name: 'usageDir', why: '新增：用量目录（<logs>/usage，可用 DSH_GATEWAY_USAGE_DIR 覆盖）' },
  { name: 'usageFileFor', why: '新增：当天用量文件路径 YYYY-MM-DD.jsonl（本地日期，与用户看的"每天"一致）' },
  { name: 'pruneUsageFiles', why: '新增：清理超期用量文件（按文件名日期判断）' },
  { name: 'usagePrunedAt', why: '新增：清理节流（每天最多 readdir 一次，不该每请求都跑）' },
  { name: 'recordUsage', why: '新增：每次调用收尾追加一行 JSONL。**整个函数体在 try 里** —— 统计是旁路，失败绝不影响转发。只记结构化数字，不记请求/响应正文' },
  { name: 'usageFromTail', why: '新增：从 8KB 尾部窗口提取用量（直通路径用）。直通是字节透明的、不解析整个响应，但为截断检测已滚了尾部窗口 → 顺带解析零额外成本。⚠ 必须**逐字段**取最后一次出现的值，不能"取最后一个 usage 对象"：anthropic 的 input_tokens 在首帧 message_start、output_tokens 在尾帧 message_delta，只取最后一个会把输入 token 与缓存读全丢成 0（单元测试当场抓到）' },
  { name: 'matrixUsage', why: '新增（2026-10-13 审计）：矩阵流式路径的用量快照 + 输入语义标记。encoder 只知道客户端 wire，而"inTok 含不含缓存"取决于**上游** wire（anthropic 不含、chat/responses 含），所以在这里补' },
    // —— 2026-10-13：404 failover 收敛 + 工具调用可观测性 ——
    { name: 'isModelUnavailableByProvider', why: '新增：把"这家不提供这个模型"收敛成**唯一判定**（5 处调用点共用）。同一漏洞此前复发三次（09-23 修 400 侧、09-30 补指纹、10-13 cline 事故才补 404 侧），注释里留着"翻译路径当时漏了""三处都要判里漏掉的第三处"。判据 = 窄正则命中 或 (404 且宽正则命中)：后者是本次关键 —— cline 走翻译路径时 sensenova 回 404"模型不存在"，旧实现掉进确定性分支**终止 failover**，而 opencode-go 本可服务。' },
    { name: 'DSML_MARKER_RE', why: '新增（可观测性）：识别 DeepSeek 原生工具标记。用户报"输出被截断"，实为上游把 DSML 当纯文本返回、网关原样转发，客户端当正文显示。引擎此前**完全没有** DSML 相关处理。' },
    { name: 'noteDsml', why: '新增（可观测性）：响应正文出现 DSML 标记时留痕（每家 30s 限频，避免一个流几十个分片刷屏）。这是"上游没解析"与"网关丢了 tools"两种原因的**唯一区分手段** —— 此前日志里 tool_calls/tool_use 零命中。' },
    { name: 'noteDsmlFromMessage', why: '新增（可观测性）：从 Anthropic 形状 message 的 text 块里查 DSML（非流式翻译路径用）。' },
    { name: 'noteToolFingerprint', why: '新增（可观测性）：记录向上游声明的工具数量与名字（30s 限频）。用于分辨"网关有没有把 tools 传下去"。' },
    { name: 'dsmlReportedAt', why: '新增：DSML 上报限频表（provider → 上次上报时间）。' },
    { name: 'toolReportedAt', why: '新增：工具指纹上报限频表（provider → 上次上报时间）。' },
    // —— 2026-10-13：DSML 解析（把原生工具标记转成结构化 tool_use）——
    { name: 'DSML_ANY_RE', why: '新增：DSML 解析（2026-10-13）：上游把 DeepSeek 原生工具标记当纯文本回，网关此前原样转发，客户端显示乱码且工具不执行。本正则只做"有没有标记"的快速判断。容忍半角 | 与全角 ｜ 及标记内空白（不同上游清洗程度不同）' },
    { name: 'DSML_CALLS_RE', why: '新增：匹配**完整**的 <|DSML|calls>…</|DSML|calls> 块。必须要求闭合 —— 流式下未闭合的块要扣住不能发' },
    { name: 'DSML_INVOKE_RE', why: '新增：从 calls 块里取出每个 invoke 的 name 与体' },
    { name: 'DSML_PARAM_RE', why: '新增：从 invoke 体里取出 parameter name/value' },
    { name: 'parseDsmlInvokes', why: '新增：解析出 {name, args} 列表；无名调用跳过（无法执行）' },
    { name: 'parseDsmlToolCalls', why: '新增：解析完整块并返回 {剩余正文, calls}。**解析不出调用时原样返回** —— 宁可显示乱码也不能吞掉用户正文' },
    { name: 'dsmlStreamState', why: '新增：按 res 存的流式过滤状态（WeakMap，随响应释放，不跨请求串味）' },
    { name: 'dsmlStreamFeed', why: '新增：流式过滤器。两处关键：① 未闭合的 calls 块**整段扣住**（实测踩到：分片2 是 \'<|DSML|calls> <|DSML|invoke …>\'，只扣"未闭合的 <"会因尾部含 > 而漏发整个标记），上限 8000 字符防上游永不闭合时吞正文；② 后缀保留，处理标记被切成 \'<|DSM\' / \'L|calls>\' 的最坏情况' },
    { name: 'dsmlStreamFlush', why: '新增（v0.8.4）：流结束时吐出扣住的残余（防吞正文）。**v0.8.6 已接线**到流结束点（原先只是定义了没用）—— 不接线的话，模型正常写出的最后一个 \'<\' 会被静默吞掉。接线处还会再解析一次残余：上游没写 </|DSML|calls> 时退一步只按 invoke 解析，把"调用完整但外层没闭合"的那些照样转成 tool_use' },
    { name: 'applyDsmlToAnthropicMessage', why: '新增：把 Anthropic message 里的 DSML 文本块换成真正的 tool_use 块并把 stop_reason 置为 tool_use。**非流式路径用它**（实测：客户端收到 text+tool_use，工具名与参数均正确）' },
    { name: 'providerTimeoutMs', why: '改动（2026-10-13）：半开探测改为**探测超时阶梯** —— 默认仍按 BREAKER_PROBE_TIMEOUT_MS 快速放弃，但 `b.probeFull`（上一次探测是被短阈值掐掉的）时放行完整超时。旧行为"声明了 timeoutMs 的家，探测也照它来"（2026-09-22 为 amd 加的例外）会让**每一次**探测都吃满整个声明值：用户实测 h-e.top（声明 60s）冷却到点后被选中，这一次探测白等 60 秒（`dur=60009ms`）。慢家的恢复能力由阶梯第二步保住（旧用例仍绿）' },
    { name: 'UPSTREAM_PREFLIGHT_MS', why: '新增：死家 TCP 预检的超时（默认 4s，可用 DSH_GW_UPSTREAM_PREFLIGHT_MS 覆盖）。"连都连不上"的家（端口关闭/DNS 黑洞/TCP 被丢包）旧实现要花掉整个 HTTP 超时才判定失败，而 TCP 层几毫秒就有答案' },
    { name: 'preflightTargetOf', why: '新增：决定预检**谁** —— 走代理时检代理、否则检上游（命中 NO_PROXY 视为直连）。为什么不直接检上游：被墙的上游直连本来就必然失败，拿它当判据会把好家误判成死家（用户那台没装 Clash 的机器正是这个形态）' },
    { name: 'tcpReachable', why: '新增：纯 TCP 握手探测（只 connect，不发任何数据），带去重结算的 settled 标志' },
    { name: 'upstreamSuspect', why: '新增：判定"该家可疑到值得先做一次 TCP 预检"。三条判据：half-open（正在探测）→ 是；open → 否（轮不到发请求）；closed 但 `opens>0 && lastNetFailAt > lastOkAt`（开过闸且此后只有网络失败没有成功应答）→ 是。**健康家一律不检**，不引入额外拨号延迟。刻意**不**用"把待探测的家排到候选末尾"（2026-09-17 已否掉：那样首选家恢复后再也轮不到）' },
    { name: 'upstreamPreflight', why: '新增：预检的执行体，返回 {ok, detail} 供日志写明"检的是谁、耗时多久、阈值多少"。baseURL 解析不了时放行（交给正常路径报错，不改变既有行为）' },
    { name: 'breakerRecordFail', why: '改动（2026-10-13）：新增第 4 个参数 `timedOutByUs`（= 这次失败是**我们自己的超时**掐掉的）与两个状态位：① `lastNetFailAt`（只有网络类失败才更新，供 upstreamSuspect 判定）；② `probeFull`（探测超时阶梯：被短阈值掐掉 → 下次放完整超时；完整超时仍失败/快速失败 → 回到短阈值）' },
    { name: 'breakerRecordSuccess', why: '改动（2026-10-13）：交还名额时同时置 `lastOkAt`（"最近一次确实应答过"）并把 `probeFull` 归零（该家已能正常应答，下次探测重新从短阈值开始）' },
    { name: 'BREAKER_BACKOFF_MAX_MS', why: '改动（2026-10-13）：默认 30 分钟 → **120 分钟**。一个永不恢复的死家每 30 分钟就被重新放行一次探测，而"冷却到点必然放行一次探测"是必须保留的保底性质（否则恢复后永远选不上），所以只能降低频率。用户实测：h-e.top 当天 9 次超时、18 次熔断跳过。env 覆盖（DSH_GATEWAY_BREAKER_BACKOFF_MAX_MS）不变' },
    { name: 'BREAKER_LONG_MS', why: '**仅注释**改动：上方那段说明退避阶梯的注释（90s→…→封顶值）随上限调整一起重写，常量值本身未变（仍为 30 分钟长熔断，401/403 业务拒绝用）' },
    { name: 'forward', why: '改动（2026-10-13）：发请求前加"死家预检"分支（upstreamSuspect → upstreamPreflight，不通则记网络失败、一个 HTTP 请求都不发）；并把 `describeAbortIfOurs` 提前到 `breakerRecordFail` 之前，把"是不是我们自己的超时"传给探测超时阶梯' },
    { name: 'forwardAnthropicViaOpenAI', why: '改动（2026-10-13）：同一条死家预检（放在选账户**之前**：账号池的冷却/轮换不该被一个死家牵动），并把 abortInfo 传给探测超时阶梯。这条路径（Anthropic 客户端 → openai-chat 上游）是 dsh/cline 走得最多的一条，只修直通路径等于没修。**2026-10-14 又改**：① 顶部加 bModel（= logicalModelOf(provider, body.model)），所有熔断调用都带它（规则2 模型级冷却）；② 网络错误里先按规则1 尝试把该 host 切直连、**再**原地重试；③ "所有账户都不行"的收尾显式传空模型名 → 走供应商级（账户池耗尽与模型无关）' },
    // ============ 2026-10-14：用户确认的三条规则（代理自动切直连 / 模型级冷却 / 参数可配）============
    { name: 'isTransientNetError', why: '块边界变化（非逻辑改动）：紧接其后的位置插入了规则1 的状态常量（PROXY_PROBE_MS / BASE_NO_PROXY / runtimeDirectHosts）与 proxyStatus 的注释，块内容因此变长' },
    { name: 'BREAKER_STALE_MS', why: '块边界变化 + 其后新增"模型级冷却"整段注释与 4 个可配置常量（envInt / MODEL_BREAKER_THRESHOLD / MODEL_BREAKER_COOLDOWN_MS / ESCALATE_* / modelCooledLog）' },
    { name: 'envInt', why: '新增：正整数 env 读取（次数阈值用）。与 envMs 并列，避免每处都手写 Number.isFinite 判断' },
    { name: 'MODEL_BREAKER_THRESHOLD', why: '新增（规则3）：模型级冷却的连续失败阈值，默认 3。env DSH_GW_MODEL_BREAKER_THRESHOLD 优先，其次配置文件 breaker.threshold' },
    { name: 'MODEL_BREAKER_COOLDOWN_MS', why: '新增（规则3）：模型级冷却时长，默认 30 分钟。env DSH_GW_MODEL_BREAKER_COOLDOWN_MS 优先，其次配置文件 breaker.cooldownMs。**刻意不指数退避**（用户选"可预期"）——与供应商级的阶梯形成分工' },
    { name: 'MODEL_BREAKER_ESCALATE_MODELS', why: '新增（规则2 护栏）：同一家多少个**不同**模型相继冷却就升级为整家冷却，默认 3' },
    { name: 'MODEL_BREAKER_ESCALATE_WINDOW_MS', why: '新增（规则2 护栏）：升级判定的时间窗口，默认 5 分钟（"相继"的界限）' },
    { name: 'modelCooledLog', why: '新增（规则2 护栏）：providerId -> 最近被冷却的模型列表（带时间戳），用于判断"是不是整家都坏了"' },
    { name: 'breaker', why: '块边界变化：其后新增 modelBreaker / MODEL_BREAKER_SEP / modelBreakerKey / logicalModelOf' },
    { name: 'modelBreaker', why: '新增（规则2）：模型级冷却表（providerId\\u0000逻辑模型 -> 与供应商级同形状的状态）。路由与半开探测**两层都看**' },
    { name: 'MODEL_BREAKER_SEP', why: '新增：模型级键的分隔符（\\u0000 —— 正常供应商 id / 模型名不会含它，避免 provider="a" + model="b\\u0000c" 这类拼接歧义）' },
    { name: 'modelBreakerKey', why: '新增：模型级冷却键。没有模型信息时返回空串 → 调用方退回"只走供应商级"的旧行为（向后兼容）' },
    { name: 'logicalModelOf', why: '新增：把**上游模型 ID** 折回逻辑模型名。必须折的理由：路由筛候选用的是逻辑名（selectCandidates 里 e.as === model），冷却若记在上游 ID 上就永远命中不了 —— 表现为"冷却记了但完全没用"，日志里还看不出哪里不对' },
    { name: 'probeSlotStale', why: '块边界变化：其后紧接着是改写的两级状态机' },
    { name: 'slotIsOpen', why: '新增：**两级共用**的状态判定（原 breakerIsOpen 的纯读逻辑抽出来）。抽出来的理由：模型级与供应商级的转移逻辑完全一样，写两份必然漂移' },
    { name: 'slotAcquire', why: '新增：两级共用的半开探测放行（原 breakerAcquire 的核心），多一个 threshold 参数（两级阈值不同）' },
    { name: 'slotRecordSuccess', why: '新增：两级共用的名额交还/清零（保留 opens 让退避阶梯继续爬的契约不变），并更新 lastOkAt（"确实正常应答过"的证据，upstreamSuspect 靠它）' },
    { name: 'slotRelease', why: '新增（2026-10-14）：**只**清 state/probeAt/fails/probeFull，**不动 lastOkAt**。区别只有一条但是要害：breakerRecordSuccess 会刷新 lastOkAt，等于替"从没成功过的家"伪造了一次成功应答 → 死家预检判据永远为假。配套见 breakerReleaseSlot' },
    { name: 'breakerReleaseSlot', why: '新增（2026-10-14）："交还半开探测名额"的正确入口。十几个"这家没坏、只是这一发不算数"的早退分支（不提供该模型 / 账户级失败 / 上游侧故障被包成 4xx / 软性渠道拦截）原来都调 breakerRecordSuccess —— 它会**清零 fails**，与超时/网络失败记的模型级失败**交替清零** → 永远攒不到阈值。现场证据：amd 当天 7 次失败（4×429 + 3×超时）、0 次成功、0 次熔断，每个请求白等它 12 秒' },
    { name: 'isOpaqueProvider4xx', why: '新增（2026-10-14）：判定"上游回了一个不带任何错误说明的 4xx"（400/422 且响应体里没有任何 error/message/detail/code/… 字样）。实测 opencode-go 回 `400 {"model":"deepseek-v4.1-flash"}` 绕过了全部豁免正则，直落"确定性 4xx → 终止 failover"，客户端整轮任务拿到 400 而死；而同一家同一模型 30 分钟后连续两次成功（请求侧毫无问题）。判据刻意保守：有 message 的 400 仍然终止' },
    { name: 'isProviderWideFailure', why: '新增（规则2 的核心判据，用户确认）：鉴权/欠费/权限（401/402/403）+ "连接根本没建立"（网络层失败**且不是我们自己的超时**）→ 冷却整家；其余（超时、上游 4xx/5xx/429）→ 只冷却该模型。把"我们自己的超时"排除在整家之外，正是用户要的"别让一个慢模型拖垮整家"（实测事故：amd 慢模型把同家快模型一起熔断）' },
    { name: 'fmtMs', why: '新增：人读时长的统一格式（日志与测试断言共用一份，避免"1500ms / 2 分钟"两种写法在三处各写一遍）' },
    { name: 'breakerIsOpen', why: '改写：签名加 model，**两级任一开着就跳过**（规则2 之前只看供应商级）' },
    { name: 'breakerAcquire', why: '改写：两级都要占名额。顺序先判模型级；若模型级抢不到，把供应商级**精确还原**到调用前的快照（不能留下刚被推进到 half-open 的悬挂名额 —— 那会让该家所有模型在 BREAKER_STALE_MS 内全被跳过）' },
    { name: 'providerBreakerRecordFail', why: '新增（原 breakerRecordFail 的供应商级部分抽出来）：鉴权/欠费立即长熔断；连接类按连续开闸次数指数退避（既有语义未改）' },
    { name: 'modelBreakerRecordFail', why: '新增（规则2/3）：连续 N 次 → **只冷却该模型** M 分钟（N/M 可配置）。日志写明"仅该模型冷却"+"连续几次"+"规则值"，并触发升级护栏' },
    { name: 'noteModelCooled', why: '新增（规则2 护栏）：同家 ≥3 个不同模型在 5 分钟内相继冷却 → 判定整家故障、冷却整家。这是模型级冷却唯一的真实代价（整家坏掉被当成 N 个模型分别失败、白打上游 N 倍）的对冲' },
    { name: 'PROXY_PROBE_MS', why: '新增（规则1）：代理可达性探测的 TCP 超时（默认 2500ms）' },
    { name: 'PROXY_RESTORE_PROBE_MS', why: '新增（规则1）：代理恢复复查的间隔（默认 60s）—— 没有"切回"会让 clash 重启后被墙的家继续直连、全部失败，而日志只在很久以前写过一次' },
    { name: 'BASE_NO_PROXY', why: '新增（规则1）：**启动时**注入的 NO_PROXY 原值。运行期直连清单每次都从它重建（幂等），否则清不干净、且反复追加会让变量无限变长' },
    { name: 'runtimeDirectHosts', why: '新增（规则1）：运行期被切成直连的 host 集合（也在 /health 的 proxy.runtimeDirect 里可见）。存在的前提是实测结论：Node 的 EnvHttpProxyAgent **每个请求都重读 process.env.NO_PROXY**' },
    { name: 'runtimeDirectProbedAt', why: '新增（规则1）：上次复查代理的时间（限频，避免每个请求都去探测）' },
    { name: 'envProxyUrl', why: '新增（规则1）：当前注入且启用的代理 URL（未注入/未启用返回空串）' },
    { name: 'proxyReachable', why: '新增（规则1）：代理 host:port 的 TCP 可达性（net.connect 探测，不走 env 代理）' },
    { name: 'syncRuntimeNoProxy', why: '新增（规则1）：把运行期直连清单写进 process.env.NO_PROXY（同时写小写 no_proxy，Node 两种都认）' },
    { name: 'switchHostToDirect', why: '新增（规则1 的核心）：走代理失败 + **该上游直连可达** → 把这一家的 host 加进 NO_PROXY 改直连。两个条件缺一不可：只判"代理不可用"会把被墙的上游误判成"代理坏了"，切直连只会全部失败。返回 true 让调用方原地重试一次（那次就走直连）' },
    { name: 'maybeRestoreProxy', why: '新增（规则1 的自动恢复）：代理活过来就清空运行期直连清单（切回代理）。没有它会怎样：clash 重启后被墙的家仍然直连、全部失败，而日志只在很久以前写过一次"已切直连"' },
    { name: 'startServer', why: '改动（规则1）：60s 的自检定时器里顺带调用 maybeRestoreProxy()（不新开定时器；清单为空时是零开销 early return）' },

  // —— 2026-10-21：WorkBuddy 系统提示词指纹（11128 的第四种成因）——
  { name: 'WB_CHANNEL_IDENTITY_RE', why: '新增：2026-10-20 傍晚起 copilot.tencent.com/v2/chat/completions 对**请求体**做系统提示词指纹校验，system 里出现 "You are an AI agent powered by DeepSeek Harness." 即回 400 / code 11128（unapproved channel）。本机受控实测：该句在 system 首行 → 400；放到第 2 行 → 200；换中性开场白 → 200 且流式正常。凭据、会话三头、出口 IP、工具体量早已逐条排除（366 个富 schema 工具加到 1.5MB 仍 200）。正则容忍 `,`/`，`/`—`/`-` 分隔符：桌面版渲染出来是 "You are an AI coding agent, powered by …"（chengshenyangtai/dsh-workbuddy-trae-qoder-connect 的 CHANGELOG.md 记录过只认直连形态会漏这一种）' },
  { name: 'WB_NEUTRAL_IDENTITY', why: '新增：改写后的中性开场白（"You are an AI agent."）—— 只去掉宿主可识别的品牌段，保留"你是 AI 代理"这层语义' },
  { name: 'WB_BRAND_RE', why: '新增：品牌词兜底正则 `(?<![\\\\/])DeepSeek[\\s_-]*Harness(?![\\\\/])`。⚠ 前后负向断言是硬要求：DSH 的 runtime context 里就写着安装目录 `…\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\`，在路径里替换品牌词 = 交给模型一个不存在的路径 → 工具调用全坏（simlerick/dsh-wb400-fix 的 lexicon.mjs 同样用 `(?<![\\\\/])…(?![\\\\/])` 跳过路径语境）。这一层的定性是**防御性加固**而非必需：ardeyouxipianyi/workbuddy2api-hub 的 PR #540 逐句二分实测显示单独出现 `DeepSeek Harness` 不触发（只有带完整 system prompt 的整句触发），加固是为了防上游把指纹从"整句匹配"退化成"关键词匹配"' },
  { name: 'WB_BRAND_NEUTRAL', why: '新增：品牌词替换值 `DeepSeekRuntime`。选它是因为纯 ASCII、无引号，替换进 JSON 字符串（如 tool_calls.arguments）后仍是合法 JSON' },
  { name: 'isWorkBuddyAuth', why: '新增：`auth: "workbuddy"` 判定的小工具（模块级，避免各处重复写 String(...).toLowerCase()）' },
  { name: 'wbIdentityScrubScope', why: '新增：改写范围三档 —— `off` / `identity`（默认，只 system+developer）/ `all`（全角色，含 user/assistant/tool 与 tool_calls.arguments）。两份参照实现在这里**有实质分歧**：misakano7545/workbuddy2api-panel 实测"user 里同一句不触发拦截"→ 只改 system；而 dsh-workbuddy-trae-qoder-connect 主张"校验是文本匹配、不认角色，只改 system 会漏掉工具结果里的复述"。把选择权交给配置而不是替用户选边。供应商写 `"identityScrub": "all"`，或 DSH_GATEWAY_WB_IDENTITY=all' },
  { name: 'scrubWorkbuddyIdentityText', why: '新增：把一段文本里的身份句**逐处**替换成中性开场白，再用 WB_BRAND_RE 抹掉残留品牌词；返回 { text, n }（n = 改写处数，日志用）。⚠ 位置无关是关键：宿主会在身份段前面渲染问候语、长会话还会重发多个 system 消息，只匹配行首会漏（参照实现 Hourz26/dsh-workbuddy-connect-patched 的第二版补丁专门纠正过这点）。⚠ 有 `indexOf("Harness") < 0` 快路径：绝大多数消息根本不含这个词，不该为它跑两趟正则' },
  { name: 'scrubWorkbuddyMessage', why: '新增：把一条 chat 消息过一遍身份改写 —— content 的 `string` 与 `[{type:"text",text}]` 两种形态，外加 `tool_calls[].function.arguments`（JSON 字符串里也可能带品牌词，替换成纯 ASCII 词不破坏 JSON）。返回 { msg, n }' },
  { name: 'translateBody', why: '改动（渠道身份改写）：在既有 messages 遍历里加一段 —— 角色归一（developer→system）**之后**，按 wbIdentityScrubScope 决定改哪些 role。选 translateBody 是因为它是**两条转发路径的共同入口**（forward() 与 forwardAnthropicViaOpenAI() 都调它），一处实现即可避免"同一判定两处实现漏一处"的历史坑。默认（identity 档）**不碰** user/assistant —— 实测那句只出现在 user 里时上游 200，改了反而损语义；要全改必须显式配 all' },
  { name: 'translateResponsesBody', why: '改动（渠道身份改写，**第二份实现**）：Responses 协议把 system 提示放顶层 `instructions`、会话放 `input`，与 chat 的 `messages[]` 形状完全不同 —— chat 路径的改写对它零作用。漏掉这一份就等于 /v1/responses 客户端继续撞 400/11128（本项目"同一判定两处实现漏一处"的老坑）。`instructions` 会被上游当作最靠前的 system，正是首行指纹的高危位置' },
  { name: 'scrubResponsesItems', why: '新增：Responses `input` item 数组的身份改写。默认只改 role 为 system/developer 的项（与 chat 路径口径一致），scope=all 时逐个 item 全改（含 `function_call_output` 的工具结果与 `function_call` 的 arguments）。覆盖 `content: string`、`content: [{type:"input_text",text}]`、`output`、`arguments` 四个文本位。返回 { items, n } 或 null（无改动）' },
  { name: 'workbuddyConversationHeaders', why: '改动（会话渠道头由三改四）：国际版 WorkBuddy AI **5.7** 起要求四个头，多出 `X-Root-Request-ID`，缺它同样回 400/11128 且 msg 还是 "conversation id missing"（同一个码、同一句文案，第四种触发面；来源 chengshenyangtai/dsh-workbuddy-trae-qoder-connect 的 CHANGELOG.md）。它与 `X-Conversation-Request-ID` **同值**（同一个请求的根 id），因为 X-Root-Request-ID 表达的就是"这条请求链的根"，重铸一个新 UUID 反而把两者割裂。国内版 copilot.tencent.com 实测不要求这四个头（带/不带都 200），统一加是为了不按域名分叉' },

  // ── magpie 三项（2026-10-25 吸收自 yetone/magpie）────────────────────────────
  { name: 'DEFAULT_LOOP_GUARD', why: '新增：流式循环守卫缺省值 true。与 maxTools（默认关，会改变"发给上游什么"）不同，这一项不改变请求内容、只是提前止损，所以默认开' },
  { name: 'DEFAULT_TOOL_LOOP', why: '新增：工具死循环拦截缺省值 true。拦下的都是"本来必然白烧钱"的请求（magpie 现场：半小时 308 次同一调用、537 credits），默认开' },
  { name: 'DEFAULT_ROOMY', why: '新增：上下文窗口过滤缺省值 true。它只调换尝试顺序、不删除候选，默认开无风险' },
  { name: 'DEFAULT_ROOMY_LEARN', why: '新增：是否允许 roomy 去上游 /models 学上下文窗口，**缺省 false**。理由：实测 15 个启用家里只有 commandcode / commandcode-haiku / sensenova / amd 四家的目录带 context_length，其余 11 家只回 {id,object,created,owned_by}；且它与"配置齐全时请求路径零探测"（needsCatalog）的既有承诺相冲，探测还是真实上游请求（x666 2.7s / muyuan.do 3.0s / aihubmix 3.2s，agentrouter 401、workbuddy 404）' },
  { name: 'ACTIVE_LOOP_GUARD', why: '新增：模块级生效值，由 startServer 从 cfg.loopGuard 初始化 —— forward() 与各 handler 拿不到 cfg，沿用本项目 ACTIVE_MAX_TOOLS 的既有模式' },
  { name: 'ACTIVE_TOOL_LOOP', why: '新增：同上，cfg.toolLoop 的模块级生效值' },
  { name: 'ACTIVE_ROOMY', why: '新增：同上，cfg.roomy 的模块级生效值' },
  { name: 'ACTIVE_ROOMY_LEARN', why: '新增：同上，cfg.roomyLearn 的模块级生效值（缺省关，见 DEFAULT_ROOMY_LEARN）' },
  { name: 'catalogCache', why: '改动（2026-10-25）：本块内容未变，是它**后面**紧接了新的 catalogMetaCache 声明，块边界因此移动才被判为"发生变化"。catalogCache 仍只存 id 集合与 ts（60s TTL，服务路由正确性）；窗口信息刻意不塞进它，理由见 catalogMetaCache' },
  { name: 'catalogMetaCache', why: '新增：从上游目录学到的上下文窗口表 providerId -> {ctx: Map<上游ID, 窗口>, ts}。为什么不复用 catalogCache：两者刷新节奏完全不同 —— 模型列表是路由正确性的一部分（60s TTL），窗口只是排序提示、学到一次可长期用，而探测可能很慢（x666 2.7s / muyuan.do 3.0s），按 60s 刷等于每 60 秒打一次慢家' },
  { name: 'CATALOG_META_TTL_MS', why: '新增：窗口缓存 30 分钟。窗口是模型属性、不是运行时状态，半小时内不会变' },
  { name: 'ctxWindowFromCatalogEntry', why: '新增：从上游 /models 条目挖窗口（context_length / context_window / max_context_length / top_provider.context_length / metadata|config|limits 里的同名键）。**引擎不能 require src/model-meta.js**（那是宿主侧 CommonJS，本引擎是零依赖 ESM 只 import node:），所以只实现 roomy 需要的这一小块，口径与 model-meta.js 的 parseUpstreamMeta 保持一致但不取 maxTokens/vision（对排序没意义）' },
  { name: 'catalogMetaInflight', why: '新增：学窗口的在途 Promise 表，与 catalogInflight 同思路防重复探测' },
  { name: 'learnCatalogMeta', why: '新增：去上游 /models 学一次窗口。三条纪律：① 熔断期不探测（与 fetchCatalog 同一条）② 10s 超时 ③ 任何失败只打一行日志、绝不影响路由。学不到就保持"不可知"' },
  { name: 'cfgBool', why: '新增：三态布尔解析（true/false/"on"/"off"/1/0/yes/no/enabled/disabled 都认，未设 → 缺省值）。三个开关共用，避免各写一份口径' },
  { name: 'LOOP_WINDOW', why: '新增：滚动窗口 256 个单元（照抄 magpie loopWindow）。为什么是 256：正常答复（含代码/表格）在 256 个单元里通常有上百种不同单元，真的陷进循环时只剩个位数' },
  { name: 'LOOP_DISTINCT', why: '新增：窗口内不同单元 ≤24 即判循环（magpie loopDistinct）' },
  { name: 'LOOP_UNIT_MAX', why: '新增：单单元最长 4096 字符，超长整段当单元 —— 防"无断行的重复"（`mcp mcp mcp…`）漏判' },
  { name: 'loopUnitHasWord', why: '新增：判定单元里有没有"词"（至少一段有字母且无数字）。magpie 同口径：`0x00`、`v2`、纯 hash 不算单元，否则表格/日志类正文会被误判成循环' },
  { name: 'loopUnitKey', why: '新增：单元归一（折叠空白、去尾部标点、小写、截断），与 magpie `unitKey` 同口径 —— 归一不到位，同一句带不同标点就会被当成不同单元，循环永远判不出来' },
  { name: 'makeLoopGuard', why: '新增：循环守卫本体（`feed(delta) → 文案 | null`）。256 格 ring + counts Map 精确滑窗（滑出就减），`\\n` 与中文句末标点立即结束单元，`.`/`!`/`?` **后跟空白**才结束（否则 `Step. 1` 会被切开）。边转发边判是关键：等流结束再判等于钱已经烧完' },
  { name: 'loopGuardWordsOf', why: '新增：四协议统一取**正文**增量（Anthropic text_delta / Responses output_text.delta / Chat delta.content / Gemini parts，thought:true 跳过）。reasoning 一律不取 —— 模型反复权衡同一个决定时 reasoning 天然高重复，拿它判会切断正常回复（magpie 用 think/text 两路分开跑验证过）' },
  { name: 'TOOL_LOOP_REPEATS', why: '新增：连续 8 轮工具交换完全相同即判死循环（照抄 magpie toolLoopRepeats）' },
  { name: 'TOOL_LOOP_TAIL', why: '新增：只看对话最后 64 条（magpie tailItems = 8×8）。1.5MB 的轮次每轮整体解码要吃几十毫秒，magpie 修过这条' },
  { name: 'TOOL_NOISE_RES', why: '新增：抹掉"每轮都会变但语义无关"的运行噪声 —— `Wall time: N seconds`、`Chunk ID: xxx`、`"duration_seconds": N`。不抹的话同一调用两轮永远不相等，死循环判不出来（magpie `steadyResult` 同口径）' },
  { name: 'steadyText', why: '新增：给一段工具结果抹噪声 + 截断到 4096（超长结果只留前缀，避免 20MB 轮次拖慢判定）' },
  { name: 'stableJson', why: '新增：JSON 键重排序列化 —— 两轮写法不同（键序不同）也该算"同一个调用"。这是判重复的必要条件' },
  { name: 'maybeJson', why: '新增：工具参数既可能是 JSON 字符串也可能是对象，统一解成对象再交给 stableJson' },
  { name: 'fnv1a', why: '新增：FNV-1a 32 位哈希（magpie 用 FNV-64a）。这里只要"相等性"，32 位够用且更快' },
  { name: 'toolExchanges', why: '新增：把三协议对话尾部归一成 `[{callsKey, resultsKey, hash, names}]`。只处理最后 64 条（性能），callsOf 认 `tool_calls[]`/`tool_use` 块/`function_call`，resultsOf 认 `role:"tool"`/`tool_result` 块/`function_call_output`' },
  { name: 'detectToolLoop', why: '新增：最后 8 轮 hash 全等 → 返回详情。**为什么在请求体上判**：agent 每轮都携带整段对话，循环在请求体里就看得见 —— 等上游回话再判，那一轮的钱已经花了' },
  { name: 'lenOfRepeats', why: '新增：往前数真实重复轮数（文案里给"连续 14 次"比"8 次"更有说服力，也便于用户判断严重程度）' },
  { name: 'toolLoopNotice', why: '新增：给用户看的中文文案 —— 说清"拦了什么、没花额度、通常意味着什么、该怎么办"，并强调这一轮**没有发给模型**' },
  { name: 'localWholeBody', why: '新增：本地作答的**非流式**响应体，三协议各一份形状（anthropic message / responses output / chat choices），usage 里 inTok 恒 0（真的一个字都没发给上游，不能虚报）' },
  { name: 'serveLocalAnswer', why: '新增：本地作答的**流式**路径，**复用 makeStreamEncoder** 而不是另写一份 SSE 拼装 —— 三协议编码器只该有一份，否则又是一处"同一语义多份实现"。' },
  { name: 'windowOf', why: '新增：取某候选对该逻辑模型声明的 contextWindow（不可知返回 0）。注意 modelEntries 里的 contextWindow 此前**只被 write-dsh 用来写 dsh 配置**，请求路径上从未使用 —— 这是它第一次参与路由' },
  { name: 'roomyOrder', why: '新增：把"装不下这次请求"的候选**排到最后**（不删除）。与 magpie 的差别：magpie 移出候选表再在特定条件下"回补"，那套回补要在主循环维护状态；本工程直接排到最后 —— 主循环按序尝试，装得下的先跑，全都失败后自然轮到它们，语义等价、零状态。四条不做事的边界（窗口不可知/体解析不出/只有一个候选/没有候选装得下）与 magpie 一致' },
  { name: 'startServer', why: '改动：初始化 magpie 三开关（ACTIVE_LOOP_GUARD / ACTIVE_TOOL_LOOP / ACTIVE_ROOMY）。**配置优先、env 次之、缺省值最后**：`out/data` 下的 gateway.config.json 会被界面保存整份覆写，临时关一项不该逼用户改配置（与 DSH_GATEWAY_BREAKER_* 等既有开关同一套习惯）。沿用 ACTIVE_MAX_TOOLS 的模块级持有模式 —— forward() 与各 handler 拿不到 cfg' },

  // —— 2026-10-25 第八轮审计（引擎内核）：三个缺陷修复 ——
  { name: 'MODEL_BREAKER_MAX', why: '新增（审计 R8-3）：模型级冷却表的**硬上界**（默认 512，DSH_GW_MODEL_BREAKER_MAX 可调）。旧实现 `modelBreaker` 是只增不减的 Map —— 全文 0 处 `.delete(` / `.clear(`、无任何容量判断，而键的右半边是 `model`，即**客户端可控的请求体字段**。这与本文件自己写下的三条口径直接矛盾：`:839` responseAffinity「容量有界（LRU 淘汰），避免客户端可控 id 造成无界增长」、`:940` sessionAffinity（SESSION_AFFINITY_MAX=512）、`ACCOUNT_POOL_MAX=512 + 按 until 升序淘汰`。属"同一类问题只修了三处、漏了第四处"' },
  { name: 'MODEL_BREAKER_MODEL_MAX', why: '新增（审计 R8-3）：键里 model 部分的截断长度（128，与 ACCOUNT_MODEL_KEY_MAX 同值）。该键会被拼进 `[${model}]` 日志与 noteModelCooled 的升级护栏，超长 model 名既浪费内存又把日志行撑爆' },
  { name: 'trimModelBreaker', why: '新增（审计 R8-3）：把 modelBreaker 收口到硬上界，**只在 modelBreakerRecordFail 写表时调用**（读路径 slotIsOpen 等保持零副作用 —— 这是本文件熔断状态机的既定契约）。两轮淘汰：① 先删已过冷却且无在途探测的条目（state==="closed"）；② 仍超上界则按最近活动时间升序淘汰。刻意不直接 clear —— 那会让所有正在冷却的模型立刻复活、又去撞刚把它们限流的上游（与 accountPool 同一理由）' },
  { name: 'modelBreakerKey', why: '改动（审计 R8-3）：model 部分截断到 MODEL_BREAKER_MODEL_MAX(128)。旧实现原样拼接客户端可控的 model 字段；三个调用点传同一个 model 值，截断后仍自洽（与 accountModelKey 在 2026-10-09 V3 审计里做的同一件事）' },
  { name: 'modelBreakerRecordFail', why: '改动（审计 R8-3）：末尾加 trimModelBreaker()，让表有硬上界' },
  { name: 'accountFailureRule', why: '改动（审计 R8-2）：这个函数此前是**死代码**（全文件 0 调用点，注释却写着"日志/诊断用"），而它与 classifyAccountFailure 各持一份**逐字相同**的规则遍历循环 —— 典型的"同一判定两处实现"，两份迟早漂移。现在反过来：遍历只有 accountFailureRule 一份（含"规则抛异常不影响主流程"的保护），classifyAccountFailure 委托它取 kind。两处日志（直通 :7879、翻译 :11302 一带）改为读 rule 对象，并把**命中的规则 id** 写进日志 —— 同一个 kind 可能来自三条规则（裸 401/403、session 措辞、内容拦截排除后），只说 kind 排障时分不清是哪条' },
  { name: 'classifyAccountFailure', why: '改动（审计 R8-2）：函数体改为委托 accountFailureRule 再取 kind，消除两份重复的遍历循环。**判定顺序与语义完全不变**（ACCOUNT_FAILURE_RULES 数组顺序即契约，未动）' },

  // ---- 审计 R8-4：日志轮转 ----
  { name: 'LOG_KEEP_FILES', why: '新增（审计 R8-4）：保留几份历史日志，与宿主 src/logger.js 的 KEEP_FILES=3 同口径。旧实现的"轮转"其实是 fs.writeFileSync(LOG_PATH, "")，超过 5MB 直接把历史抹掉 —— 而出问题后想回看的恰恰是那段，排障取证是日志存在的第一理由' },
  { name: 'rotateLogIfNeeded', why: '新增（审计 R8-4）：真轮转（gateway.log → .1 → .2 → .3，超出的丢弃），10 秒节流对齐 logger.js:131，失败只记一次 WARN 并用 appendFileSync 避免递归。log() 改调它 —— 旧实现是**每条日志**都 statSync（全文件 259 个 log() 调用点都在热路径上）' },
  { name: 'lastRotateCheck', why: '新增（审计 R8-4）：节流状态，配合 rotateLogIfNeeded' },
  { name: 'rotateFailed', why: '新增（审计 R8-4）：轮转失败只报一次，避免文件被占用时每 10 秒刷一条 WARN 把日志撑爆' },
  { name: 'dumpWorkbuddy11128', why: '接线（审计 R8-1）：该函数从引入起就没被调用过（git log --all -S 只有引入那一次），但引擎注释、日志与 README 排错表**四处**都在承诺"开 DSH_GATEWAY_DUMP_WB11128=1 就能转储比对" —— 用户照做时一个字节都不会落盘，且没有任何提示，偏偏发生在唯一还在猫鼠游戏里的功能上。现在直通 forward() 与翻译 forwardAnthropicViaOpenAI() 两处 11128 分支各补一行调用（同一判定两处实现的老坑）' },

  // ⚠ 待办：本清单在 v1.0.7 之后就没再维护，v1.0.8–v1.0.17 的改动（OpenCode 车道、
  //   出口轮换等）大量未登记，`node scripts/check-engine-parity.mjs`
  //   因此恒报 FAIL（本次改动之前就已经是红的）。这是清单腐烂，不是功能回退，
  //   需要单独做一次全量登记；本次只登记自己新增的块，不代填别人的理由。
];

/** 把源码切成"顶层块"：以列 0 开始的 function/const/let/var/class 声明为界。 */
function blocks(src) {
  const lines = src.split(/\r?\n/);
  const out = new Map();
  let name = '<文件头>';
  let buf = [];
  const flush = () => { out.set(name, (out.get(name) || '') + buf.join('\n')); buf = []; };
  for (const l of lines) {
    const m = /^(?:async\s+)?(?:function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)|class\s+([A-Za-z0-9_$]+))/.exec(l);
    if (m) { flush(); name = m[1] || m[2] || m[3]; }
    buf.push(l);
  }
  flush();
  return out;
}

const norm = (s) => s.replace(/\r/g, '').replace(/[ \t]+$/gm, '').trim();

const verbose = process.argv.includes('--verbose');
const baselinePath = BASELINE_CANDIDATES.find((p) => existsSync(p));

if (!baselinePath) {
  console.log('[SKIP] 找不到 dsh-app 的引擎基线，无法做差异校验。');
  console.log('       可设 DSH_GATEWAY_ENGINE_BASELINE 指向基线文件后重跑。');
  console.log('       候选位置：');
  for (const p of BASELINE_CANDIDATES) console.log('         ' + p);
  // ⚠ 2026-10-14 修正：原来这里是 exit(0)。**退出码 0 会被 CI / 构建脚本当成"通过"**，
  // 而这个脚本的全部价值就是那句断言 ——「除 DECLARED 外引擎没有别的块被改动」。
  // 一个块都没比就报通过，是最坏的一种假阳性：它让"没比"看起来像"比过了"。
  // 找不到基线 = 没验证；显式承认"跳过"要走 --allow-skip，不能混进"通过"里。
  if (process.argv.includes('--allow-skip')) {
    console.log('[SKIP] 已用 --allow-skip 显式接受：本次不做差异校验。');
    process.exit(0);
  }
  console.log('[FAIL] 没有基线 = 没有校验。确认要跳过请加 --allow-skip。');
  process.exit(2);
}

const a = blocks(readFileSync(baselinePath, 'utf8'));
const b = blocks(readFileSync(CURRENT, 'utf8'));

const changed = [];
const removed = [];
const added = [];
for (const n of new Set([...a.keys(), ...b.keys()])) {
  const x = a.get(n);
  const y = b.get(n);
  if (x === undefined) { added.push(n); continue; }
  if (y === undefined) { removed.push(n); continue; }
  if (norm(x) !== norm(y)) changed.push(n);
}

console.log('基线：' + baselinePath);
console.log('当前：' + CURRENT);
console.log(`块总数：基线 ${a.size} / 当前 ${b.size}；有变化的块 ${changed.length} 个，新增 ${added.length} 个，删除 ${removed.length} 个`);
console.log('');

// 声明清单的索引。⚠ 这一行曾经被一次误插入覆盖掉（用脚本改本文件时插错了位置），
// 表现是运行时报 `declaredNames is not defined` —— 改这个文件时请跑一次 `node --check`
// 并**实际执行一次**，别只看语法。
const declaredNames = new Set(DECLARED.map((d) => d.name));
const problems = [
];

// ① 所有变化都必须被声明
for (const n of [...changed, ...added, ...removed]) {
  if (!declaredNames.has(n)) problems.push(`「${n}」发生了变化但**没有**在 DECLARED 清单里声明`);
}
// ② 声明了但实际没变 → 清单腐烂
for (const d of DECLARED) {
  const existsNow = b.has(d.name);
  const existsBefore = a.has(d.name);
  const isChanged = changed.includes(d.name) || added.includes(d.name) || removed.includes(d.name);
  if (!isChanged) {
    problems.push(`「${d.name}」在清单里声明为"已改动"，但实际上与基线一致（清单已过期）`);
  } else if (!existsNow && !existsBefore) {
    problems.push(`「${d.name}」在两边都不存在`);
  }
}

if (verbose) {
  console.log('==== 已声明的改动 ====');
  for (const d of DECLARED) console.log(`  · ${d.name}\n      ${d.why}`);
  console.log('');
}

if (problems.length) {
  console.log('[FAIL] 引擎差异与声明不符：');
  for (const p of problems) console.log('  ✗ ' + p);
  console.log('');
  console.log('  如果这是有意改动：请在 scripts/check-engine-parity.mjs 的 DECLARED 里补一条，');
  console.log('  并写清"改了什么、为什么"。如果这是无意改动 —— 那就是**功能回退**，请撤回。');
  process.exit(1);
}

console.log(`[OK] 差异与声明一致：共 ${DECLARED.length} 处已声明改动，无未声明变化。`);
console.log('     每一处的理由见 scripts/check-engine-parity.mjs 的 DECLARED（用 --verbose 打印）。');
console.log('     ⇒ 「除这些块之外，引擎没有别的块被改动」这句话可机器复核。');
console.log('     ⚠ 粒度是**块**不是行：一旦某个块进了 DECLARED，之后对它内部的修改');
console.log('       （包括整段删功能）就不会再被发现 —— 那由 tests/gateway.test.js 等测试守。');
