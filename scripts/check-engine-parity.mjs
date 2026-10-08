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
  process.exit(0);
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
