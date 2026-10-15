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
  { name: 'wireOfClientPath', why: '新增：客户端请求路径 → 线协议' },
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
  { name: 'translateMatrixResponse', why: '新增：响应侧矩阵（upstream→chat→client），非流式' },
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
