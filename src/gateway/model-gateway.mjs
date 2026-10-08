#!/usr/bin/env node
/**
 * DSH Model Gateway
 * OpenAI-compatible unified model proxy with multi-provider routing.
 *
 * Features:
 *  - GET  /v1/models            merged, de-duplicated model list from all providers (sorted by name)
 *  - POST /v1/chat/completions  route by model availability -> provider list order -> failover
 *  - POST /v1/messages          Anthropic protocol (same routing)
 *  - POST /v1/responses         passthrough (same routing)
 *  - GET  /health               liveness probe for the desktop assistant
 *  - unified Bearer auth (config.apiKey) on all /v1 routes
 *  - SSE streaming passthrough (node fetch ReadableStream -> res)
 *  - per-provider model-catalog cache with TTL, cleared on failure
 *
 * Zero npm dependencies; requires Node >= 18 (fetch, streams).
 *
 * Config file (JSON):
 *   {
 *     "port": 3091,
 *     "apiKey": "dsh-gateway-xxxxxxxx",
 *     "providers": [
 *       {
 *         "id": "provider-a",
 *         "baseURL": "https://example.com/v1",
 *         "apiKey": "sk-...",
 *         // 字符串 = 上游 ID 与逻辑名相同；对象 = 映射（as 为逻辑名）+ 可选 vision（图片输入）
 *         "models": ["deepseek-v4-flash", { "id": "v/vision-up", "as": "deepseek-v4-flash", "vision": true }],
 *         "priority": 1,          // 数值小者先尝试；同 priority 内按本数组顺序
 *         "enabled": true
 *       }
 *     ]
 *   }
 *
 * 选路顺序（2026-09-17 用户要求）：**先 priority 升序，同级内按 providers 数组顺序**。
 * 配置页 ▲▼ 仍然只改数组顺序、不改 priority（同级内调整先后）。
 * Config path: %APPDATA%\DSHDesktop\gateway.config.json (or DSH_GATEWAY_CONFIG).
 * A template is created on first run if the file is missing.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ⚠ 本文件是 dsh-app 网关引擎的**原样副本**（llm-gateway 拆分时整体搬入，功能一字未减）。
// 与 dsh-app 版本的**唯一差异**是下面这一行的目录名：默认回退目录由 'DSHDesktop' 改为
// 'llm-gateway'，避免独立程序在没传 --config 时误读写 DSH 桌面助手的数据目录。
// 宿主（src/gateway-manager.js）始终显式传 --config/--log 并注入 DSH_GATEWAY_CONFIG/DSH_GATEWAY_LOG，
// 因此这一行只影响"裸跑 CLI"。差异可用 `node scripts/check-engine-parity.mjs` 复核。
const APP_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.dsh'), 'llm-gateway');
let CONFIG_PATH = process.env.DSH_GATEWAY_CONFIG || path.join(APP_DIR, 'gateway.config.json');
const MODEL_CACHE_TTL_MS = 60_000;
// 上游请求超时（time-to-headers）。可用 DSH_GATEWAY_UPSTREAM_TIMEOUT_MS 覆盖，
// 或按供应商用配置项 timeoutMs 单独放宽（如 x666/amd 这类慢速中转）。
const UPSTREAM_TIMEOUT_MS = (() => {
  const n = Number(process.env.DSH_GATEWAY_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();
/** 供应商级超时：provider.timeoutMs > 全局默认；**半开探测**用短超时（见 BREAKER_PROBE_TIMEOUT_MS）。
 *
 * 例外（2026-09-22 实测事故：amd 的 DeepSeek-V4.1-Flash 永远选不上）：
 * 供应商**显式声明** `timeoutMs` 时，半开探测也照它来，不再压到 10 秒。
 * 旧实现用 `Math.min(base, PROBE)` 一刀切，于是"首字节稳定 >10s"的家**探测必然超时**
 * → 熔断重新 open → 退避 2m→3m→6m→12m→30m → 再探测又超时，**永远无法恢复**；
 * 实测 amd 该模型首字节 13.7–15.5s（同家 DeepSeek-V4-Flash 只要 0.7–1.1s），
 * 结果每个请求都 `skip amd (breaker open)` 落到 workbuddy——配了 timeoutMs 也没用。
 * 未声明 timeoutMs 的家仍走 10 秒探测上限（探测是在替全家人试错，不该占满用户 60 秒）。 */
/**
 * **逐模型**超时：模型条目上的 `timeoutMs` 优先。
 *
 * 为什么需要它（2026-09-30，用户要求）：同一家供应商里不同模型的速度能差一个数量级。
 * 实测 amd：`DeepSeek-V4.1-Flash` 首字节 13.7–15.5s，而 `DeepSeek-V4-Flash` 只要 0.7–1.1s。
 * 只配供应商级超时时只能按最慢的那个定（否则慢模型永远选不上），于是一个挂住的慢模型
 * 就能吃掉整个请求预算、把该家快的模型一起拖累；反过来按最快的定又会误杀慢模型。
 * 逐模型配置让两者各自拿到合适的值。
 *
 * 匹配时**同时看上游 ID 与逻辑名** —— 调用方传进来的可能是任一个
 *（请求入口处是逻辑名，failover 改写后是上游 ID）。
 *
 * @returns {number} 命中且 >0 时返回该值；否则 0（= 该条目未声明，交回供应商级）
 */
function modelTimeoutMs(provider, model) {
  const m = String(model || '').trim();
  if (!m || !provider || !Array.isArray(provider.models)) return 0;
  for (const e of provider.models) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const up = String(e.id ?? e.up ?? e.upstream ?? e.model ?? '').trim();
    const as = String(e.as ?? e.alias ?? e.model ?? e.name ?? up).trim();
    if (up !== m && as !== m) continue;
    const n = Number(e.timeoutMs);
    return (Number.isFinite(n) && n > 0) ? n : 0;   // 命中条目但没配 → 用供应商级
  }
  return 0;
}

function providerTimeoutMs(provider, model) {
  const perModel = modelTimeoutMs(provider, model);
  const n = perModel > 0 ? perModel : Number(provider && provider.timeoutMs);
  const declared = Number.isFinite(n) && n > 0;
  const base = declared ? n : UPSTREAM_TIMEOUT_MS;
  // 2026-09-17 优化：半开探测不放满 60s——该请求同时在替所有人生死探测，不能让用户等满。
  try {
    const b = breaker.get(String((provider && provider.id) || ''));
    if (b && b.state === 'half-open') {
      return declared ? base : Math.min(base, BREAKER_PROBE_TIMEOUT_MS);
    }
  } catch (_) { /* 模块初始化早期（const 尚未就绪）→ 退回常规超时 */ }
  return base;
}
// 瞬时网络错重试（2026-09-16）：仅当失败**够快**时才重试——慢失败（如 60s 超时）重试只会翻倍等待
const NET_RETRY_MAX_ELAPSED_MS = (() => {
  const n = Number(process.env.DSH_GATEWAY_NET_RETRY_MAX_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * 把 fetch 的异常链压成一行可读文本（undici 的网络错误 message 恒为 "fetch failed"，
 * 真正原因在 cause 链里：ECONNRESET / ENOTFOUND / UND_ERR_SOCKET / 代理连接失败…）。
 */
function describeFetchError(e) {
  if (!e) return '';
  const parts = [];
  let cur = e.cause;
  let depth = 0;
  while (cur && depth < 3) {
    const t = cur.code || cur.errno || cur.message || String(cur);
    if (t) parts.push(String(t));
    cur = cur.cause;
    depth++;
  }
  return [...new Set(parts)].join(' < ');
}

/**
 * 是否"瞬时网络层错误"（值得原地重试一次）。
 * 排除我们自己的超时中止（AbortError）：那类失败重试只会把等待翻倍。
 */
function isTransientNetError(e) {
  if (!e) return false;
  const msg = String(e.message || '');
  if (e.name === 'AbortError' || /aborted/i.test(msg)) return false;
  if (/fetch failed|socket|network|ECONN|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(msg)) return true;
  let cur = e.cause;
  let depth = 0;
  while (cur && depth < 4) {
    const code = String(cur.code || cur.errno || '');
    if (TRANSIENT_NET_CODES.has(code)) return true;
    cur = cur.cause;
    depth++;
  }
  return false;
}

/**
 * 本进程的代理状态（v1.8.2）：宿主 gateway-manager 会注入 NODE_USE_ENV_PROXY=1 +
 * HTTP(S)_PROXY + NO_PROXY；这里只做**可见性**，便于 /health 与日志一眼看清
 * "到底走没走代理、哪些域名直连"。排障时不必再去翻宿主的 app.log。
 */
function proxyStatus() {
  const env = process.env;
  const url = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  const noProxy = env.NO_PROXY || env.no_proxy || '';
  return { url: url || null, noProxy: noProxy || null, envProxy: env.NODE_USE_ENV_PROXY === '1' };
}

/** host 是否命中 NO_PROXY 清单（精确或后缀——实测 `tencent.com` 命中 copilot.tencent.com）。 */
function hostInNoProxy(host, noProxy) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  for (const raw of String(noProxy || '').split(',')) {
    const e = raw.trim().toLowerCase().replace(/^\./, '').replace(/^\*\./, '');
    if (!e) continue;
    if (h === e || h.endsWith('.' + e)) return true;
  }
  return false;
}

/**
 * 网络错误归因（v1.8.2）。2026-09-16 19:19–19:23 事故：clash 的 7890 端口没在监听，
 * 网关所有上游请求（含 workbuddy）在 12–31ms 内 ECONNREFUSED——undici 报的是**代理地址**
 * 连不上，可日志里只有 "fetch failed"，于是熔断器写"保护上游账号"，把环境问题记成上游故障。
 * 这里在"本进程走代理且该域名不在 NO_PROXY"时补一句人话，直接指向代理。
 */
function proxyHintFor(url, causeText) {
  // 只在**确实拿到连接层错误码**时才提示代理（ENOTFOUND/证书类错误与代理无关，别误导）。
  // 2026-09-17 修正：旧判断写成"causeText 存在才校验"→ causeText 为空时无条件放行，而
  // AbortError（我方 60s 超时 / 客户端取消）的 cause 链恰好为空 → 把"超时"误报成"代理未运行"
  // （当天实测 6 次，误导排查方向）。现在必须非空且命中连接层错误码。
  if (!causeText || !/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT/i.test(String(causeText))) return '';
  const st = proxyStatus();
  if (!st.url) return '';
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { return ''; }
  if (hostInNoProxy(host, st.noProxy)) return '';
  return `（本进程走代理 ${st.url}：ECONNREFUSED/ECONNRESET 极可能是**代理未运行**（Clash 退出/切换节点/重启中），不是上游故障；请检查代理，或在网关配置里把该域名加入 noProxy 直连）`;
}
// R2 防封：catalog 探测失败后的冷却期（30s 内不重试探测，防请求风暴触发风控）
const CATALOG_FAIL_COOLDOWN_MS = 30_000;
let LOG_PATH = process.env.DSH_GATEWAY_LOG || path.join(APP_DIR, 'logs', 'gateway.log');

/* ---------------- logging ---------------- */
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 日志轮转上限 5MB（修复 G3：防止长期运行磁盘膨胀）

/* 日志时间口径（时区可移植性修复，2026-09-11）：
 * 旧版 localStamp 用 getHours() 等**系统时区**字段；把绿色目录复制到一台时区为 UTC 的
 * 电脑（镜像/克隆的 Windows 很常见）后，网关日志比北京时间早 8 小时，与宿主 app.log 的
 * 口径也可能不一致，排查时序会误导。现在缺省固定北京时区（UTC+8），与机器设置无关；
 * DSH_LOG_TZ 可覆盖：local|system（跟随系统）或 ±HH:MM。
 * 注：网关是零依赖单文件（会被解包到 data\gateway\ 单独运行），故这里内联同一套逻辑
 *（与 src/timestamp.js 语义一致，改动时两边必须同步）。 */
function logTzOffsetMin() {
  const v = String(process.env.DSH_LOG_TZ || '').trim().toLowerCase();
  if (v === 'local' || v === 'system') return null;
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(v);
  if (m) { const mins = Number(m[2]) * 60 + Number(m[3] || 0); return m[1] === '-' ? -mins : mins; }
  return 480;   // 缺省：北京时间
}
const LOG_TZ_MIN = logTzOffsetMin();

// 时间戳：YYYY-MM-DD HH:mm:ss.SSS（口径见上）
function localStamp(d) {
  const t = d || new Date();
  const p = (n, w) => String(n).padStart(w, '0');
  const x = LOG_TZ_MIN === null ? t : new Date(t.getTime() + LOG_TZ_MIN * 60000);
  const Y = LOG_TZ_MIN === null ? x.getFullYear() : x.getUTCFullYear();
  const Mo = (LOG_TZ_MIN === null ? x.getMonth() : x.getUTCMonth()) + 1;
  const D = LOG_TZ_MIN === null ? x.getDate() : x.getUTCDate();
  const H = LOG_TZ_MIN === null ? x.getHours() : x.getUTCHours();
  const Mi = LOG_TZ_MIN === null ? x.getMinutes() : x.getUTCMinutes();
  const S = LOG_TZ_MIN === null ? x.getSeconds() : x.getUTCSeconds();
  const Ms = LOG_TZ_MIN === null ? x.getMilliseconds() : x.getUTCMilliseconds();
  return Y + '-' + p(Mo, 2) + '-' + p(D, 2) + ' ' + p(H, 2) + ':' + p(Mi, 2) + ':' + p(S, 2) + '.' + p(Ms, 3);
}

function log(msg) {
  const line = `[${localStamp()}] ${msg}`;
  try {
    // 轮转：超过上限时重置文件
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > LOG_MAX_BYTES) fs.writeFileSync(LOG_PATH, '');
    } catch { /* 日志文件可能还不存在 */ }
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch { /* ignore */ }
  if (process.env.DSH_GATEWAY_VERBOSE === '1') process.stdout.write(line + '\n');
}

/* ---------------- config ---------------- */
// 顶层 argv 工具：--config / --log 等（服务启动与 write-dsh 共用）
function argvGet(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function defaultConfig() {
  return {
    port: 3091,
    apiKey: 'dsh-gateway-change-me',
    providers: [
      {
        id: 'example-provider',
        baseURL: 'https://example.com/v1',
        apiKey: 'sk-xxxxxxxx',
        models: ['deepseek-v4-flash'],
        priority: 1,
        enabled: true,
      },
    ],
  };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(), null, 2), 'utf8');
    log(`config template created at ${CONFIG_PATH} — edit it, then restart the gateway`);
    console.log(`[gateway] config template created: ${CONFIG_PATH}`);
    return null; // caller exits: nothing to serve until configured
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!Array.isArray(cfg.providers)) throw new Error('providers must be an array');
    // R25（审计修复）：port 兜底——手改配置缺/坏 port 时 listen(undefined) 会随机端口
    const p = Number(cfg.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      log(`config port invalid (${cfg.port}), falling back to 3091`);
      cfg.port = 3091;
    }
    // Anthropic 缓存断点的全局开关（'auto' 默认开；'off' 完全不动请求体）。
    // 放在这里而不是当参数传：forward() 的签名里没有 cfg（见 CACHE_BREAKPOINT_MODE 注释）。
    if (cfg.cacheBreakpoints !== undefined) CACHE_BREAKPOINT_MODE = cfg.cacheBreakpoints;
    return cfg;
  } catch (e) {
    log(`config parse error: ${e.message}`);
    console.error(`[gateway] invalid config: ${e.message}`);
    return null;
  }
}

/* ---------------- upstream catalog cache ---------------- */
const catalogCache = new Map(); // providerId -> { models:Set, ts }

// S1 轮询计数器：model -> 下次起始偏移（round-robin 路由模式用）
const rrCounters = new Map();

/* ---------------- OpenAI Responses 协议：会话/资源亲和性 ----------------
 * Responses 协议是**有状态**的：客户端拿到 response.id 后会用
 *   GET    /v1/responses/{id}
 *   DELETE /v1/responses/{id}
 *   POST   /v1/responses/{id}/cancel
 *   GET    /v1/responses/{id}/input_items
 * 以及 POST /v1/responses 带 previous_response_id 继续多轮。
 * 这些后续请求的 body 里**没有 model**（子路由连 body 都没有），无法按模型路由；
 * 而 response 对象只存在于**创建它的那家上游**——发错家必然 404。
 * 因此：创建成功后记下 id → providerId，后续请求优先回到原供应商；
 * 同时 previous_response_id 也用于把多轮对话钉在同一家（缓存命中/上下文一致）。
 * 容量有界（LRU 淘汰），避免客户端可控 id 造成无界增长。
 */
const RESPONSE_AFFINITY_MAX = 512;
const responseAffinity = new Map();   // responseId -> providerId

function affinitySet(id, providerId) {
  if (!id || !providerId) return;
  if (responseAffinity.has(id)) responseAffinity.delete(id);   // 重插 = 最近使用
  responseAffinity.set(id, providerId);
  while (responseAffinity.size > RESPONSE_AFFINITY_MAX) {
    const oldest = responseAffinity.keys().next();
    if (oldest.done) break;
    responseAffinity.delete(oldest.value);
  }
}

function affinityGet(id) {
  if (!id) return null;
  const pid = responseAffinity.get(id);
  if (!pid) return null;
  responseAffinity.delete(id);   // LRU 触碰
  responseAffinity.set(id, pid);
  return pid;
}

/* ---------------- 会话亲和（缓存友好，2026-10-08） ----------------
 * 动机：Anthropic 的 prompt cache 绑定在**上游账号**上。dsh-factory-provider 实测同一段前缀，
 * 不打 0% 命中、打好 99.79%；而缓存读 ×0.1、未缓存输入 ×1 —— 反复换家等于把缓存全部作废。
 * 本网关原本的 failover 是"这家失败换下一家"，但**下一轮请求仍按 priority 回到第一家**，
 * 于是一个发生过故障的会话会在两家之间来回跳，缓存永远热不起来（而且每次都要重付全量输入）。
 *
 * 与上面 Responses 亲和的分工（语义不同，所以用**独立的表**，混在一起早晚出错）：
 *   · Responses 亲和是"**必须**回去" —— response 对象只存在于创建它的那家，发错必然 404；
 *   · 会话亲和只是"**优先**回去" —— 纯粹为了缓存热度，任何一家都能服务，因此仍可 failover。
 *
 * 会话键怎么来（按可信度取，取不到就返回 null = 不做亲和，**绝不猜**）：
 *   ① Anthropic `metadata.user_id`（Claude Code 会发）/ OpenAI `user`
 *   ② 客户端显式给的信头 x-session-id / x-session-affinity / x-opencode-session
 *   ③ 兜底：哈希「模型 + system + 首条用户消息」—— 同一段对话的稳定前缀不变，跨轮稳定；
 *      客户端主动截断历史时会失效（退化成"本轮无亲和"，只影响命中率，不影响正确性）
 * 表里只存哈希不存原文：这张表会被客户端可控的内容填充，不该在里面留用户内容。
 */
const SESSION_AFFINITY_MAX = 512;
/** 兜底键（前缀哈希）的最低门槛：低于它没有值得保护的缓存，见 sessionKeyOf 的说明。 */
const SESSION_AFFINITY_MIN_TOKENS = 512;
const sessionAffinity = new Map();   // sessionKey -> { pid, ts }

/** 取前 16 位十六进制（够用且不占内存；碰撞概率对本用途可忽略）。 */
function sha16(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

function sessionAffinitySet(key, providerId) {
  if (!key || !providerId) return;
  // 审计口径同 rrCounters：key 客户端可控 → 必须容量有界（LRU 淘汰）
  if (sessionAffinity.has(key)) sessionAffinity.delete(key);
  sessionAffinity.set(key, { pid: providerId, ts: Date.now() });
  while (sessionAffinity.size > SESSION_AFFINITY_MAX) {
    const oldest = sessionAffinity.keys().next();
    if (oldest.done) break;
    sessionAffinity.delete(oldest.value);
  }
}

function sessionAffinityGet(key) {
  if (!key) return null;
  const e = sessionAffinity.get(key);
  if (!e) return null;
  sessionAffinity.delete(key);   // LRU 触碰
  sessionAffinity.set(key, e);
  return e.pid;
}

/**
 * 只做**派生**，不设任何门槛。
 * @returns {{key:string, prefixTokens:number}|null} 取不到任何可用标识时返回 null。
 */
function deriveSessionKey(body, req) {
  if (!body || typeof body !== 'object') return null;
  const meta = body.metadata && typeof body.metadata === 'object' ? body.metadata.user_id : null;
  if (typeof meta === 'string' && meta.trim()) return { key: 'u:' + sha16(meta.trim()), prefixTokens: Infinity };
  if (typeof body.user === 'string' && body.user.trim()) return { key: 'u:' + sha16(body.user.trim()), prefixTokens: Infinity };
  const hdr = req && req.headers
    ? (req.headers['x-session-id'] || req.headers['x-session-affinity'] || req.headers['x-opencode-session'])
    : null;
  if (typeof hdr === 'string' && hdr.trim()) return { key: 'h:' + sha16(hdr.trim()), prefixTokens: Infinity };
  // 兜底：稳定前缀（system + 首条用户消息）。两者都取不到就没得派生。
  const sys = typeof body.system === 'string' ? body.system
    : (Array.isArray(body.system)
      ? body.system.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
      : '');
  let firstUser = '';
  const msgs = Array.isArray(body.messages) ? body.messages : (Array.isArray(body.input) ? body.input : []);
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role !== 'user' && m.role !== 'human') continue;
    firstUser = typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content)
        ? m.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
        : '');
    break;
  }
  if (!sys && !firstUser) return null;
  return {
    key: 'p:' + sha16(`${body.model || ''}\u0000${sys}\u0000${firstUser}`),
    prefixTokens: roughTokens(sys) + roughTokens(firstUser),
  };
}

/**
 * 会话键（给**会话亲和**用）。
 *
 * 兜底键只在"确实有值得保护的缓存"时才用。理由：亲和的**唯一动机**是别让长前缀的缓存作废；
 * 前缀本身就很短的会话没有可缓存的内容，用它做键只会带来副作用 —— 不相干的会话因为开头
 * 恰好相同而被绑到同一家，而且被钉住的那家再也不被尝试，其它家的熔断计数永远攒不够
 *（实测踩到："半开探测用短超时"用例因此不再触发 HALF-OPEN）。
 * 512 token 与 Anthropic 的最小可缓存长度同量级。
 *
 * ⚠ 这个门槛**只对亲和成立**。别拿它去给别的东西派生会话 id —— 见 opencodeSessionId。
 */
function sessionKeyOf(body, req) {
  const d = deriveSessionKey(body, req);
  if (!d) return null;
  if (d.prefixTokens < SESSION_AFFINITY_MIN_TOKENS) return null;
  return d.key;
}

/**
 * OpenCode 车道的 `x-opencode-session`。
 *
 * ⚠ 与 sessionKeyOf **必须分开**：上游对这条头是**无条件**要求的，少了直接
 * `400 MissingSessionID`。而 sessionKeyOf 带 512 token 门槛（那是"值不值得钉缓存"的启发式），
 * 短对话（"你好"这种最常见的）会被它判成 null ——
 * 实测踩到：**四种短对话全部拿不到会话头**，等于把这条车道在真实用法上全废掉。
 *
 * 所以这里**永远返回一个 id**：优先按对话内容派生（同一对话跨轮稳定，上游才好做路由）；
 * 实在没有任何可用前缀时退化成**进程级常量**（所有会话共用一个 id —— 仍然满足上游，
 * 只是它的路由聚合度低一些，不会 400）。
 */
function opencodeSessionId(body, providerId) {
  const d = deriveSessionKey(body, null);
  const hex = sha16(d ? d.key : `opencode-fallback\u0000${providerId || ''}`);
  return 'ses_' + hex.slice(0, 12) + hex;   // ses_ + 28 位，形态与上游一致
}

/**
 * 会话亲和是否启用。
 * 'auto'（默认）：failover 模式下开（正是缓存会来回失效的场景），round-robin 模式下关
 *（用户显式要分摊流量，亲和会跟它对着干）。
 */
function sessionAffinityEnabled(cfg) {
  const m = cfg && cfg.sessionAffinity;
  if (m === false || m === 'off') return false;
  if (m === true || m === 'on') return true;
  return !(cfg && cfg.routing === 'round-robin');
}

/** 从响应字节（JSON 或 SSE）里嗅探 Responses 的 response.id。
 * 三种形态，按可信度取：
 *   ① `"id":"resp_…"`（官方/new-api 惯例前缀，最可靠）
 *   ② SSE 的 `event: response.created` → `"response":{"id":"…"`（前缀不规范也认）
 *   ③ JSON 体里 `"id":"…","object":"response"`（明确声明 object 才认）
 * 只认这三类，避免把 output item 的 msg_/item/函数调用 id 误当成 response id。取不到返回 null。 */
const RESP_ID_RE = /"id"\s*:\s*"(resp[_-][A-Za-z0-9_-]{3,})"/;
const RESP_NESTED_ID_RE = /"response"\s*:\s*\{\s*"id"\s*:\s*"([A-Za-z0-9_.:-]{4,})"/;
const RESP_OBJECT_ID_RE = /"id"\s*:\s*"([A-Za-z0-9_.:-]{4,})"\s*,\s*"object"\s*:\s*"response"/;
function sniffResponseId(text) {
  if (!text || typeof text !== 'string') return null;
  const direct = RESP_ID_RE.exec(text);
  if (direct) return direct[1];
  const nested = RESP_NESTED_ID_RE.exec(text);
  if (nested) return nested[1];
  const obj = RESP_OBJECT_ID_RE.exec(text);
  return obj ? obj[1] : null;
}

const catalogInflight = new Map(); // providerId -> Promise（并发去重）

/* ---------------- V1/V2 防封：连续失败分级熔断 ----------------
 * 同一 provider 连续 N 次转发失败 → 熔断（期间路由跳过，不发任何上游请求）。
 * 分级（V2）：
 *  - 鉴权/业务拒绝（401/403）：长熔断 30 分钟——"Deposit required"类业务性
 *    拒绝非临时状态，重试无意义且徒增风控画像，等用户处理（充值/换key）后自然恢复
 *  - 网络错误/5xx：短熔断 5 分钟——可能是瞬时故障，较快半开试探
 * 冷却结束后半开（下一个请求允许试探一次），成功即清零计数。
 * 目的：上游临时风控/限流时，避免持续打点加剧封禁，保护账号。
 */
const BREAKER_THRESHOLD = 3;                    // 连续失败次数阈值
/** 熔断时长可用环境变量覆盖（缺省不变，仅用于测试/极端调试场景）。 */
function envMs(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}
const BREAKER_SHORT_MS = envMs('DSH_GATEWAY_BREAKER_SHORT_MS', 90_000);      // R20：短熔断 90 秒（网络错/5xx——
                                                // clash 抖动很常见，5 分钟误伤过大：全家熔断期间请求
                                                // 全部 404/503，用户以为网关坏了）
const BREAKER_LONG_MS = envMs('DSH_GATEWAY_BREAKER_LONG_MS', 30 * 60_000);  // 长熔断 30 分钟（401/403 业务拒绝）
// 2026-09-17 优化（实测事故：坏家长期霸占候选首位）：
//  ① 短熔断按"连续开闸次数"指数退避 90s→3m→6m→12m→24m→30m（封顶 30 分钟）。
//     旧实现固定 90 秒：windhub 当天被放了 28 次探测、x666 12 次，每次都在用户请求路径上白等。
//  ② 半开探测用**短超时**（默认 10 秒，而不是 60 秒）：冷却到点后的那一次请求是在替全家人
//     试错，不该占满用户 60 秒（实测 14:35:05 探 x666 → 14:36:05 放弃 = 正好 60s → 再转
//     agentrouter 18s → 该请求 78.5s；同模型正常只要 14–26s）。
const BREAKER_BACKOFF_MAX_MS = envMs('DSH_GATEWAY_BREAKER_BACKOFF_MAX_MS', 30 * 60_000);
const BREAKER_PROBE_TIMEOUT_MS = envMs('DSH_GATEWAY_BREAKER_PROBE_TIMEOUT_MS', 10_000);

/* 2026-09-23（审计 D1 修复）：半开探测名额的**兜底回收期**。
 * half-open 是"单飞"状态——占了名额的那个请求必须最终调用 breakerRecordFail 或
 * breakerRecordSuccess 之一才会释放。审计确认 forward() 里存在**漏释放的 early return**
 *（账户级失败交回账户池那一支）。一旦命中，该家就永久卡在 half-open：breakerIsOpen() 对任何
 * 请求都返回 true → 该家再也不会被选中，直到进程重启，而日志里只有满屏 `skip X (breaker …)`，
 * 用户完全无从判断。现在给 half-open 加时间兜底：超期仍未结算的探测名额视为"遗弃"，
 * 允许重新占用。这条兜底不依赖"把所有 return 都改对"——即使将来又漏一处也不会永久卡死。
 *（env 名刻意取短，避免自身被降敏成占位符而无法在源码里检索。） */
const BREAKER_STALE_MS = envMs('DSH_GW_BREAKER_STALE_MS', 180_000);

/* 熔断状态机（审计修复 P2，本次）：closed / open / half-open
 * 旧版 breakerIsOpen() 带**副作用**（冷却到点即把 fails 重置、openUntil 清零），而同一个请求会
 * 调用它 2 次以上（预过滤 + 候选过滤）→ 冷却到点时 N 个并发请求**同时**判定"已恢复"，一起打向
 * 刚恢复（很可能仍然坏）的上游，正是熔断要避免的探测风暴/风控画像。
 * 新实现：
 *  - breakerIsOpen()  **纯读**（无副作用，可被同一请求任意次调用）：当前是否应跳过该 provider
 *  - breakerAcquire() 唯一的状态转换入口：forward() 准备发请求时调用；冷却到点才把状态推进到
 *    half-open 并**占用唯一一个**探测名额（单飞），抢占失败 = 本次不发任何上游请求
 *  - 探测失败 → 回 open（半开时不看阈值，立即回 open）；探测成功/上游正常应答 → closed
 * 保底性质（与旧实现一致，必须保住）：冷却到点必然放行一次探测 → 熔断**不会永久卡死**。
 */
const breaker = new Map();                      // providerId -> { state, fails, openUntil, opens }

/**
 * 空名 tool_use 告警计数器（2026-09-17）：见 anthropicToOpenAIRequest 里的去重日志。
 */
let emptyToolUseDropHits = 0;

/**
 * thinking 回传需求"学习"标记（2026-09-17 优化）。某些上游（实测 agentrouter/air-outer）对
 * "带 tool_use 但缺 thinking 块"的 assistant 轮回 400/500，网关补一次空占位即可通过。旧实现
 * **每次请求都要先失败一次**才知道（当天实测 13 次白打上游；失败调用上游通常照样计费）。
 * 现在记住"该家需要补位"，后续请求首次就带上。命中即记、成功不撤销（结构需求是稳定属性）。
 */
const thinkingPassbackProviders = new Set();

/**
 * 上游"**不支持** extended thinking"的学习标记（2026-09-17）。实测 amd/GLM-5.3-Flash 会拒收顶层
 * `thinking` 参数（客户端按模型推理档位自动带上）→ SSE 首事件报 `"thinking" is not supported`。
 * 命中一次即记住该家：后续请求**首次就剥掉** thinking，不再白失败一轮（与 thinkingPassbackProviders 对称）。
 * 不想等学习、或想强制某家永不发 thinking，可在配置里写 `quirks: ["drop-thinking"]`。
 */
const thinkingUnsupportedProviders = new Set();

/** 该家是否应去掉顶层 thinking 参数：已学习，或显式声明了 drop-thinking quirk。 */
function shouldDropThinking(provider) {
  return thinkingUnsupportedProviders.has(provider.id) || providerQuirks(provider).has('drop-thinking');
}

/**
 * 去掉顶层 `thinking` 参数（上游明确说不支持时）。返回 { body }，本来就没有则返回 null。
 * 只动**顶层参数**：历史消息里的 thinking 内容块属于"回传结构"，与此无关，不在此处处理。
 */
function stripThinkingParam(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('thinking' in body)) return null;
  const out = { ...body };
  delete out.thinking;
  return { body: out };
}

/** 去掉 thinking 后的"复活重试"（4xx 与 SSE 首事件两种错误形态共用）；返回新 Response 或 null。 */
async function retryWithoutThinking(provider, upstreamPath, upstreamHeaders, body, timeoutMs) {
  const stripped = stripThinkingParam(body);
  if (!stripped) return null;
  thinkingUnsupportedProviders.add(provider.id);   // 先学习：即使本次重试也失败，下次首次就剥掉
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(`${upstreamBase(provider.baseURL)}${upstreamPath}`, {
      method: 'POST', headers: upstreamHeaders, body: JSON.stringify(stripped.body), signal: c.signal,
    });
  } catch (e) {
    log(`upstream ${provider.id} 去 thinking 重试失败: ${e.message}`);
    return null;
  } finally { clearTimeout(t); }
}

/** D1：半开探测名额是否已被"遗弃"（占用超过兜底期仍未调用 recordFail/recordSuccess）。纯读。 */
function probeSlotStale(b) {
  if (!b || b.state !== 'half-open') return false;
  return !!b.probeAt && (Date.now() - b.probeAt) > BREAKER_STALE_MS;
}

/** 纯读：该 provider 当前是否不可用（冷却窗口内，或半开探测名额已被别的请求占用）。 */
function breakerIsOpen(providerId) {
  const b = breaker.get(providerId);
  if (!b) return false;
  if (b.state === 'open') return Date.now() < b.openUntil;   // 冷却中 → 跳过
  // D1：半开名额若已被占用且超过兜底期仍未结算 → 视为遗弃，放行新探测（否则永久卡死）
  if (b.state === 'half-open') return !probeSlotStale(b);    // 已有探测在途 → 其它并发请求跳过
  return false;                                              // closed
}

/** 准备向上游发起请求前调用：占用半开探测名额（唯一的 open → half-open 转换点）。 */
function breakerAcquire(providerId) {
  const b = breaker.get(providerId);
  if (!b || !b.state || b.state === 'closed') return true;
  // D1：单飞——但"遗弃名额"（超过 BREAKER_STALE_MS 未结算）允许被回收，否则该家永久失联
  if (b.state === 'half-open' && !probeSlotStale(b)) return false;
  if (b.state !== 'half-open' && Date.now() < b.openUntil) return false;   // 冷却未到点（并发窗口内）
  if (b.state === 'half-open') {
    log(`breaker HALF-OPEN: ${providerId} 上一个探测名额已超期（${Math.round(BREAKER_STALE_MS / 1000)}s）未结算，回收后重新放行`);
  }
  b.state = 'half-open';
  b.probeAt = Date.now();                                    // D1：结算兜底的时间基准
  b.fails = BREAKER_THRESHOLD - 1;                           // 探测失败 → 立刻回到 open
  breaker.set(providerId, b);
  log(`breaker HALF-OPEN: ${providerId} 冷却到点，放行一次探测（single-flight）`);
  return true;
}

function breakerRecordFail(providerId, httpStatus, serverRetryMs) {
  const b = breaker.get(providerId) || { state: 'closed', fails: 0, openUntil: 0, opens: 0 };
  b.fails += 1;
  // V2b：401/403 业务性拒绝（鉴权失败/需充值/禁用）不会自愈——首次出现即长熔断 30 分钟，
  // 不必等连续 3 次（避免固定失败模式被风控画像）；网络错/5xx 仍按 3 次阈值短熔断
  const immediate = (httpStatus === 401 || httpStatus === 403);
  // half-open 探测失败必须回到 open（否则名额永远被占 → 熔断卡死），故不看阈值
  if (b.fails >= BREAKER_THRESHOLD || immediate || b.state === 'half-open') {
    const long = immediate;
    // 2026-09-17：网络/5xx 类短熔断按连续开闸次数指数退避（成功后 breakerRecordSuccess 清零 opens）
    b.opens = (b.opens || 0) + 1;
    const base = long ? BREAKER_LONG_MS : BREAKER_SHORT_MS;
    let ms = long ? base : Math.min(base * 2 ** (b.opens - 1), BREAKER_BACKOFF_MAX_MS);
    // 上游明确说了 Retry-After 就至少等那么久 —— 否则"刚被限流就回来接着打"，
    // 正是把短期限流升级成封禁的常见路径（真实客户端会遵循它）。
    if (serverRetryMs > 0 && !long) ms = Math.max(ms, Math.min(serverRetryMs, BREAKER_BACKOFF_MAX_MS));
    b.state = 'open';
    b.openUntil = Date.now() + ms;
    log(`breaker OPEN: ${providerId} 失败（${httpStatus || 'network'}），熔断 ${
      ms >= 60_000 ? Math.round(ms / 60_000) + ' 分钟' : ms + 'ms'}`
      + `${long ? '' : `（第 ${b.opens} 次开闸，退避递增；上限 ${Math.round(BREAKER_BACKOFF_MAX_MS / 60_000)} 分钟）`}`
      + `${serverRetryMs > 0 ? '（已遵循上游 Retry-After）' : ''}（保护上游账号）`);
  }
  breaker.set(providerId, b);
}
function breakerRecordSuccess(providerId) {
  const b = breaker.get(providerId);
  if (!b) return;
  // ⚠ **不要整条删除**。`opens`（连续开闸次数）存在这个条目里，而退避阶梯是
  // `base * 2**(opens-1)` —— 删掉条目就等于把阶梯历史清零。
  // 后果实测（2026-10-08 审计）：一个"3 次失败 → 冷却 → 探活成功 → 又 3 次失败"的
  // **抖动型坏家**永远停在第一档 90s；只有一路坏到底、中途一次都没成功的家才升到 30m。
  // 而抖动型恰恰是最该退避的那一类（反复打扰正在限流的上游）。
  // 改成只清"失败计数 + 开闸状态"，保留 opens 让阶梯继续爬。
  // 安全性：`breakerIsOpen` 对 state==='closed' 返回 false，`breaker.has` 全文件只有这一处用过。
  b.fails = 0;
  b.state = 'closed';
  b.openUntil = 0;
  b.probeAt = 0;
}

/** 熔断冷却剩余秒数（客户端重试提示用）。 */
function breakerCooldownSecs(providers) {
  // ⚠ 必须过滤掉非对象条目。配置里出现 `providers: [null]`（手改 JSON / 别的工具写出）时，
  // 旧实现直接 `p.id` 抛 TypeError —— 而它是在**构造 503 响应体**的过程中被调用的，
  // 于是真正的信息（"全部候选都在熔断"）被 startServer 的兜底 catch 换成了不透明的
  // `500 gateway internal error`，用户看到的是一句和事实无关的报错。
  const list = (Array.isArray(providers) ? providers : []).filter((p) => p && p.id);
  const until = Math.max(0, ...list.map((p) => {
    const b = breaker.get(p.id);
    return b ? b.openUntil - Date.now() : 0;
  }));
  return Math.max(1, Math.ceil((until || BREAKER_SHORT_MS) / 1000));
}

/**
 * 半开探测的代价控制（2026-09-17 评估结论，注意这里**没有**把探测挪到候选末尾）：
 * 曾实现过"待探测的家排到最后"，但那样只要备选一直可用，**首选家恢复后也不会再被用到**——
 * 等于静默改变优先级语义（用户把 x666 放第一是有意的）。因此只做两件事：
 *   ① 探测超时单独设短（BREAKER_PROBE_TIMEOUT_MS，默认 10s，而不是 60s）；
 *   ② 网络类熔断按连续开闸次数指数退避（90s→3m→6m→12m→24m→30m）。
 * 合起来：用户最多为探测多等 10 秒，且第 5 次之后基本每 30 分钟才会撞上一次。
 *（若要进一步做到"零用户代价"，需要后台恢复探测 + 只缩短冷却不直接解除熔断，属后续可选优化。）
 */


// V1 防封：日志脱敏——catalog/上游错误体可能回显 key，统一打码各类凭证片段
// R25（审计）：补 Bearer/JWT(eyJ)/统一网关 key（dsh-gateway-）与 api-key 头形态
// P1（二次复核修复）：旧规则只认 4 类前缀（sk- / dsh-gateway- / eyJ / api-key 头），
// 而本网关聚合的供应商里大量 key **不属于这 4 类**——nvidia 的 `nvapi-…`、amd 的 `rc-…`、
// x666/windhub/agentrouter 的纯随机串、WorkBuddy 的 OAuth token。上游在 401/403/400
// 响应体里回显收到的凭证是常见实现，一旦命中就会**明文落进 logs/gateway.log，并经免鉴权的
// /health 的 reason 字段对外可见**（/health 必须保持免鉴权：网关进程内自检 watchdog 就是
// 无鉴权 GET /health，加鉴权会让它把自己判死并自杀重启）。
// 因此这里补三类兜底：可识别前缀（nvapi-/rc-）、带关键词的赋值形态、裸 Bearer/Basic。
function maskSecrets(text) {
  return String(text || '')
    .replace(/\bsk[-_][A-Za-z0-9_\-]{8,}/g, (m) => `sk-***${m.slice(-4)}`)
    .replace(/\bnvapi-[A-Za-z0-9_\-]{8,}/g, (m) => `nvapi-***${m.slice(-4)}`)   // NVIDIA NIM
    .replace(/\brc-[A-Za-z0-9]{8,}/g, (m) => `rc-***${m.slice(-4)}`)            // AMD Radeon Cloud
    .replace(/dsh-gateway-[A-Za-z0-9_\-]{8,}/g, (m) => `dsh-gateway-***${m.slice(-4)}`)
    .replace(/eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/g, 'eyJ***.***.***')  // JWT
    // 关键词赋值形态（不限前缀）：apiKey/token/secret/password … = <长串>
    .replace(/((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*["']?)([A-Za-z0-9._+/=\-]{12,})/gi, '$1***')
    .replace(/((?:x-api-key|api-key|authorization)["':\s=]+)(Bearer\s+)?([^\s"',}]+)/gi, (m, p1, p2) => p1 + (p2 || '') + '***')
    // 裸 Bearer/Basic 兜底：上游回显鉴权头时未必带 "authorization" 关键词
    //（实测语境形如 `Authorization failed for key <token>`）
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._+/=\-]{12,}/gi, '$1 ***')
    // 无前缀、无关键词的**裸高熵串**兜底。
    // 实测（2026-10-08 审计）：上游 401 时把收到的凭据裸回显
    //（`auth rejected for credential aB3xK9mQ2pL7wR4tY6uI8oP0sD5fG1hJ2k`），
    // 前面所有规则都不命中 → 明文进 gateway.log，并经 accountPool.reason 进入**免鉴权**的 /health。
    //
    // ⚠ 这条必须**保守**，否则会把正常内容糊掉。同时满足四个条件才打码：
    //   ① ≥28 字符  ② 同时含字母和数字  ③ 不含 `/` `.` `:`（排除路径/URL/域名/文件名）
    //   ④ 不是纯 hex（排除 sha256 / 长 id —— 它们常见且不是凭据）
    .replace(/\b[A-Za-z0-9_\-]{28,}\b/g, (m) => {
      if (!/[A-Za-z]/.test(m) || !/[0-9]/.test(m)) return m;
      if (/^[0-9a-f]+$/i.test(m)) return m;
      return m.slice(0, 4) + '***' + m.slice(-4) + '（已打码:' + m.length + '）';
    });
}

async function fetchCatalog(provider, force, clientUA, clientProfile, cfg) {
  // 审计修复（P1-5）：熔断期间**不再向上游发任何请求**（含 /models 探测）。旧版在熔断
  // 过滤之前就 Promise.all 探测，401/403 触发 30 分钟长熔断后仍每 30 秒带同一个坏 key
  // 打一次 /models（约 60 次）——正是防封模块要避免的持续打点。返回 null 表示"目录未知"，
  // 后续的熔断过滤仍会把该 provider 排除在候选之外。
  if (breakerIsOpen(provider.id)) return null;
  const cached = catalogCache.get(provider.id);
  if (!force && cached && Date.now() - cached.ts < (cached.failed ? CATALOG_FAIL_COOLDOWN_MS : MODEL_CACHE_TTL_MS)) return cached.models;
  // 并发去重：同一 provider 已有在途目录请求时直接复用（修复 G5）
  if (!force && catalogInflight.has(provider.id)) return catalogInflight.get(provider.id);
  const promise = doFetchCatalog(provider, clientUA, clientProfile, cfg);
  catalogInflight.set(provider.id, promise);
  try {
    return await promise;
  } finally {
    catalogInflight.delete(provider.id);
  }
}

async function doFetchCatalog(provider, clientUA, clientProfile, cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // Q1：catalog 探测同样走上游请求头构造（clientUA/clientProfile 配置时完全仿真，
    // 否则 new-api 客户端白名单会拦 catalog 导致模型列表为空）
    const headers = upstreamRequestHeaders({}, provider.apiKey, clientUA, false, clientProfile, cfg);
    const res = await fetch(`${upstreamBase(provider.baseURL)}/models`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      // 记录响应体开头（前 300 字符，脱敏），方便诊断 401/404 等鉴权与端点问题
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { }
      log(`catalog ${provider.id} HTTP ${res.status}: ${maskSecrets(detail)}`);
      // R10b：HTTP 错误同样写失败冷却缓存（防每次请求都重探测形成风暴）
      catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
      return null;
    }
    const body = await res.json();
    const ids = new Set((body.data || []).map((m) => m && m.id).filter(Boolean));
    if (ids.size === 0) throw new Error('empty catalog');
    catalogCache.set(provider.id, { models: ids, ts: Date.now(), failed: false });
    log(`catalog ${provider.id}: ${ids.size} models`);
    // 目录 × 配置声明 一致性提示（2026-09-15 实测事故：chiyi-ds 目录里只有 Claude 模型，
    // 却声明了 deepseek-v4.1-flash → 每次请求都被上游拒（503/400），而配置页看不出问题）。
    // 只记日志、不作拦截依据（上游目录常滞后/不完整，声明仍以配置为准）。
    try {
      const entries = modelEntries(provider);
      const declared = logicalModelNames(provider);
      if (entries.length && declared.length) {
        const missing = declared.filter((as) => {
          const ups = entries.filter((e) => e.as === as).map((e) => e.up);
          return !ids.has(as) && !ups.some((u) => ids.has(u));   // 逻辑名或其上游 ID 都不在目录里
        });
        if (missing.length) {
          log(`[提示] ${provider.id} 的上游目录里没有这些已声明模型：${missing.join(', ')}`
            + '（目录可能滞后；若请求持续被上游拒绝，请核对该模型 ID 是否为其真实 ID）');
        }
      }
    } catch { /* 提示失败不影响探测 */ }
    return ids;
  } catch (e) {
    // 失败冷却（R2 防封加固）：不立即删除缓存，而是缓存 30 秒的"失败态"，
    // 避免每个客户端请求都触发 catalog 重探测造成上游请求风暴/风控
    catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
    log(`catalog ${provider.id} FAILED: ${e.message}`);
    return null;
  } finally {
    // 审计修复（P3）：失败路径原本跳过 clearTimeout → 每次探测失败都留下一个悬挂
    // 10 秒定时器（fetch 已抛错，abort 仍会触发）。
    clearTimeout(timer);
  }
}

/* ---------------- auth ---------------- */
// 审计修复（P1，安全）：旧实现直接 `x === cfg.apiKey`。当配置里 apiKey 为空串（UI 保存
// 或手改都可能）时，`x-api-key:`（空值头，Node 解析为 ''）恰好相等 → **鉴权被完全绕过**：
// 本机任何进程都能免 key 白用已充值的上游额度。现在：配置侧 key 必须是非空字符串且
// 长度 ≥ 16，否则一律判伪（fail-closed，宁可 401 也不放行）；比较用摘要 + 恒定时间。
function authorized(req, cfg) {
  const expect = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  if (expect.length < 16) return false;
  const h = String(req.headers['authorization'] || '');
  let given = '';
  if (h.toLowerCase().startsWith('bearer ')) given = h.slice(7).trim();
  else if (typeof req.headers['x-api-key'] === 'string') given = req.headers['x-api-key'].trim();
  else return false;
  if (given.length === 0) return false;
  try {
    const a = crypto.createHash('sha256').update(given, 'utf8').digest();
    const b = crypto.createHash('sha256').update(expect, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  // socket 可能已被客户端断开：writeHead/end 抛错不能带崩进程（H2）
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length,
      'access-control-allow-origin': '*',
    });
    res.end(buf);
  } catch (e) {
    log(`client already gone when sending ${status}: ${e.message}`);
  }
}

/* ---------------- routing ---------------- */
const MAX_BODY_BYTES = 16 * 1024 * 1024; // 16MB 请求体上限防御

async function bodyOf(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let guard = false;
    req.on('data', (c) => {
      if (guard) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        guard = true;
        req.removeAllListeners('data');
        // 审计修复（P1-2）：旧版 req.pause() 保留连接并回 400 —— 但请求体没被消费，
        // 该 keep-alive 连接上**后续请求永远不会被解析**（server.requestTimeout=0 无兜底），
        // 客户端连接池复用它时表现为"请求永久挂起"。改为带 code 的错误，由调用方回 413
        // 并关闭连接（Connection: close + 响应冲完后 destroy）。
        const err = new Error('request body too large');
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** 统一的请求体错误响应：超限 → 413 + 关闭连接；其它 → 400（协议对应的错误体形状） */
function replyBodyError(res, req, e, anthropic) {
  if (e && e.code === 'BODY_TOO_LARGE') {
    try {
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
      res.end(JSON.stringify(anthropic
        ? { type: 'error', error: { type: 'invalid_request_error', message: 'request body too large (max 16MB)' } }
        : { error: { message: 'request body too large (max 16MB)' } }));
    } catch { /* 忽略 */ }
    // 响应冲完再销毁连接：既不毒化 keep-alive，也不让响应被 RST 截断
    try { res.once('finish', () => { try { req.destroy(); } catch { /* 忽略 */ } }); } catch { /* 忽略 */ }
    return;
  }
  json(res, 400, anthropic
    ? { type: 'error', error: { type: 'invalid_request_error', message: `invalid JSON body: ${e && e.message}` } }
    : { error: { message: `invalid JSON body: ${e && e.message}` } });
}

/**
 * 候选顺序（2026-09-17 用户要求，**规则变更**）：
 *   ① 先按 `priority` **升序**（数值小者先尝试）；缺省 / 非法 / ≤0 → 视为 1
 *   ② 同一 priority 内按 **providers 数组顺序**（= 配置页列表顺序；▲▼ 调整的就是它）
 *
 * 历史（避免以后又被"改回去"时不知道为什么）：
 *   · 2026-09-16 之前：按 priority 排序，但配置页 ▲▼ 为保持"界面顺序=实际选路"会把 priority
 *     重编号成 1…N —— 静默改写用户手写的优先级。用户当时要求"移动只改先后顺序、不要动优先级"，
 *     于是当天改成"完全不看 priority，纯数组顺序"。
 *   · 2026-09-17：用户明确要求"同一模型下先看供应商优先级，相同优先级再看排序"，即本实现。
 *     两者现在并存：▲▼ 只改数组顺序（**不触碰 priority**），而 priority 重新参与排序 ——
 *     因此**列表位置只决定同一优先级内的先后**。
 *
 * 注意：层级（tier）仍优先于 priority —— selectCandidates() 会把"配置里声明承载该模型"的家
 * 排在"一个模型都没配、只能靠上游目录兜底"的家之前。那是配置权威性规则（2026-09-15 事故），
 * 不是排序偏好；本函数只负责同一层级内的顺序。
 */
function providersForModel(cfg) {
  const list = cfg.providers.filter((p) => p.enabled !== false);
  // 稳定排序：同 priority 用原始下标兜底（不依赖引擎的排序稳定性）
  return list
    .map((p, i) => ({ p, i, pri: providerPriority(p) }))
    .sort((a, b) => (a.pri - b.pri) || (a.i - b.i))
    .map((x) => x.p);
}

/** priority 归一化：缺省 / 非数字 / ≤0 → 1（与历史默认一致，避免旧配置被排到末尾） */
function providerPriority(provider) {
  const n = Number(provider && provider.priority);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/* ---------------- 模型映射（上游真实 ID ↔ 逻辑模型名） ----------------
 * 背景（2026-09-11）：同一个逻辑模型在不同供应商的上游 ID 往往不同
 *（如 `deepseek-ai/deepseek-v4-flash` 与 `deepseek-v4-flash0731` 都是 deepseek-v4-flash）。
 * 旧配置只能写一串 ID，于是同一个模型被当成两个不同模型，按逻辑名路由就匹配不上。
 *
 * provider.models 每项支持两种形态（**向后兼容**）：
 *   "glm-5.3"                                    —— 字符串：上游 ID 与逻辑名相同
 *   { id: "deepseek-ai/deepseek-v4-flash",       —— 对象：id = 上游真实 ID（发给上游用）
 *     as: "deepseek-v4-flash" }                     as = 逻辑模型名（dsh 请求用；网关按它路由）
 * 同义字段：as / alias / model / name 任一都当逻辑名（手写配置容错）；as 缺省 = id。
 * 同一 provider 允许多条 as 相同的映射（该逻辑模型在该家有多个上游 ID 变体，取第一条命中）。
 */
function modelEntries(provider) {
  const out = [];
  const list = provider && Array.isArray(provider.models) ? provider.models : [];
  for (const m of list) {
    if (typeof m === 'string') {
      const s = m.trim();
      if (s) out.push({ up: s, as: s });
      continue;
    }
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      // 上游真实 ID：id（规范写法），同义键 up / upstream；都没有时兜底取 model
      //（配置页对 `{model,as}` 这种手写形态也这么读，两侧语义必须一致）
      const up = String(m.id ?? m.up ?? m.upstream ?? m.model ?? '').trim();
      if (!up) continue;
      const as = String(m.as ?? m.alias ?? m.model ?? m.name ?? up).trim();
      // 多模态声明（2026-09-16）：vision: true 或 input: ['text','image'] 都表示该条支持图片输入。
      // 只会影响两件事：① 写进 dsh settings.yaml 的 input 字段（否则 harness 直接拦下图片：
      // "当前模型不支持图片"）；② 带图片的请求只发给声明了图片的家。
      // 只在为真时附带该字段——保持条目 JSON 形状稳定（既有调用方/测试按 {up, as} 比对）。
      const vision = m.vision === true
        || (Array.isArray(m.input) && m.input.map((x) => String(x).toLowerCase()).includes('image'));
      const entry = { up, as: as || up };
      if (vision) entry.vision = true;
      // 逐模型的**上游线协议**（可选）：`api: 'openai-chat' | 'anthropic-messages' | 'openai-responses'`。
      // 协议矩阵靠它工作 —— 同一个供应商里不同模型可能分属不同协议（实测 opencode-go：
      // 29 个 chat + 2 个 anthropic + 4 个 responses），只有供应商级 protocol 时只能挑一种。
      // 只在实际写得出来时才附带，保持条目 JSON 形状稳定（既有调用方/测试按 {up, as} 比对）。
      const api = wireOfName(m.api ?? m.protocol ?? m.wire);
      if (api) entry.api = api;
      // 上下文/输出上限（可选）：write-dsh 用它给 dsh 写准确的 contextWindow/maxTokens，
      // 避免"全部按 1M 虚报"导致长对话在上游上下文超限。
      const ctxWin = Number(m.contextWindow ?? m.context ?? m.ctx);
      const maxTok = Number(m.maxTokens ?? m.maxOutputTokens ?? m.max_output_tokens);
      if (Number.isFinite(ctxWin) && ctxWin > 0) entry.contextWindow = ctxWin;
      if (Number.isFinite(maxTok) && maxTok > 0) entry.maxTokens = maxTok;
      out.push(entry);
    }
  }
  return out;
}

/**
 * 逻辑模型名 → 该 provider 的上游真实 ID（未声明该逻辑名 → null，表示原样透传请求里的 model）。
 * `hasImage`：请求里带图片时**优先选声明了 `vision: true` 的那条映射** —— 同一逻辑名可能同时映射到
 * 普通变体与 vision 变体（如实测 amd：`DeepSeek-V4-Flash` 与 `DeepSeek-V4-Flash-Vision-Exp`），
 * 若按声明顺序取第一条，图片会被发到不支持图片的普通变体上（上游报错或忽略图片）。
 */
function upstreamIdFor(provider, logical, hasImage) {
  const hit = upstreamEntryFor(provider, logical, hasImage);
  return hit ? hit.up : null;
}

/**
 * 与 `upstreamIdFor` 同一套选择规则，但返回**整个条目** —— 调用方要读的字段不止 `up`：
 * 逐模型的线协议 `api`（协议矩阵要用）、`vision`、以及将来可能加的其它按模型声明。
 *
 * ⚠ 选择规则必须**只有这一份**。这个项目的审计里出过好几次"同一件事在两处各写一遍、
 * 然后漂移"（clientProfile 三份清单、打包命令两条路径…），所以让 `upstreamIdFor`
 * 直接走这里，而不是各挑各的。
 */
function upstreamEntryFor(provider, logical, hasImage) {
  const list = modelEntries(provider).filter((e) => e.as === logical);
  if (!list.length) return null;
  return (hasImage && list.find((e) => e.vision === true)) || list[0];
}

/** 该 provider 声明的逻辑模型名（去重，保序） */
function logicalModelNames(provider) {
  const seen = new Set();
  const out = [];
  for (const e of modelEntries(provider)) {
    if (!seen.has(e.as)) { seen.add(e.as); out.push(e.as); }
  }
  return out;
}

/** 把一个逻辑模型名换成该 provider 的上游 ID（无需替换时原样返回传入对象；hasImage 见 upstreamIdFor） */
function bodyForProvider(body, provider, logical, hasImage) {
  const up = upstreamIdFor(provider, logical, hasImage);
  if (!up || up === logical) return body;
  return Object.assign({}, body, { model: up });
}

/* ---------------- 候选收敛：**以配置的模型列表为唯一权威** ----------------
 * 用户明确要求（2026-09-15）：*"不应该以目录命中（上游 /models 里有）为准，而应该以我配置的
 * 模型列表为准"*。因此规则简化为：
 *
 *   ① **配置声明了该逻辑名**（provider.models 里某条的 as / 字符串本身等于请求名）
 *        → 第一层候选（唯一可信的归属声明；轮询/优先级都只在这一层内进行）
 *   ② 该 provider **一个模型都没配**（models 缺失/空数组）
 *        → 第二层候选：没有可遵循的配置，只能按它的上游目录兜底（历史行为，保证"没配也不误杀"）
 *        · 目录里有该模型 → 候选（reason: no-models-declared,catalog-hit）
 *        · 目录探测失败/未知 → 也候选（无法判断，保持宽容）
 *        · 目录已知且没有 → 不是候选
 *   ③ 该 provider **配了别的模型但没配这个** → **不是候选**（即使上游目录里有！）
 *        这正是 2026-09-15 的事故形态：b.ai 目录里列着 deepseek-v4.1-flash，配置却只声明了
 *        mimo/glm-flash/qwen，转发过去上游回 400（欠费/不可用）→ 用户明明配了 chiyi-ds 承载它，
 *        却被"目录里有"的那家抢走。配置是用户意图的唯一来源，目录只用来兜底未配置的服务商。
 *
 * 顺序：本函数**不重排**，按传入 candidates 的既有顺序分层收集 —— 而 candidates 已由
 * providersForModel() 按"priority 升序、同级数组顺序"排好，因此每个层级内部都保持该顺序。
 * 最终 eligible = [配置声明的家（按 priority/数组序）] ++ [目录兜底的家（同序）]。
 *（层级优先于 priority：配置声明的家永远排在"只能靠目录兜底"的家前面。）
 *
 * 另：本函数同时返回 needCatalogFor（哪些 provider 需要查目录）——调用方据此**只为"没配模型"
 * 的 provider 探测目录**，配置齐全时请求路径上不再有任何目录探测（省掉每次请求 ~1.5s）。
 * 返回 { eligible, reasons, tierSizes }
 */
function selectCandidates(candidates, catalogResults, model) {
  const declaredTier = [];
  const fallbackTier = [];
  const reasons = [];
  candidates.forEach((p, i) => {
    const set = catalogResults ? catalogResults[i] : null;
    const entries = modelEntries(p);
    const declared = entries.filter((e) => e.as === model);   // 声明承载该逻辑名的条目（可能多条）
    if (declared.length) {
      declaredTier.push(p);
      reasons.push({ id: p.id, reason: 'models-declared' });
      return;
    }
    if (entries.length > 0) {
      // 配置了模型但没这个 → 配置权威：不是候选（无论上游目录里有没有）
      reasons.push({ id: p.id, reason: 'not-declared(config-authoritative)' });
      return;
    }
    // 一个模型都没配 → 目录兜底
    const catalogKnown = set !== null && set !== undefined;
    if (!catalogKnown) { fallbackTier.push(p); reasons.push({ id: p.id, reason: 'no-models-declared,catalog-unknown' }); return; }
    if (set.has(model)) { fallbackTier.push(p); reasons.push({ id: p.id, reason: 'no-models-declared,catalog-hit' }); return; }
    reasons.push({ id: p.id, reason: 'no-models-declared,catalog-miss' });
  });
  return { eligible: [...declaredTier, ...fallbackTier], reasons, tierSizes: [declaredTier.length, fallbackTier.length] };
}

/** 该 provider 是否需要查上游目录才能判定候选（= 它一个模型都没配） */
function needsCatalog(provider) {
  return modelEntries(provider).length === 0;
}

/* ---------------- 多模态（图片输入）支持判定 ----------------
 * 背景（2026-09-16 用户反馈）：第三方 deepseek-v4.1-flash 本身支持图片，但 harness 仍拦下并提示
 * "当前模型不支持图片"——因为写进 settings.yaml 的模型条目没有声明 input 能力，harness 按纯文本
 * 处理（dsh-llm-pi-ai: `input: declaredInput(entry.input) ?? base?.input ?? defaultInput`，
 * 遇到图片时 `!model.input.includes("image")` 直接抛 UNSUPPORTED_CONTENT）。
 * 现在：provider.models 条目可写 `vision: true`（或 `input: ['text','image']`）显式声明；
 * ① writeDshConfig 据此写 input；② 带图片的请求只发给声明了图片能力的家（避免路由到纯文本家后上游报错）。
 */

/** 该 provider 对该逻辑模型是否声明了图片能力 */
function providerSupportsVision(provider, logical) {
  return modelEntries(provider).some((e) => e.as === logical && e.vision === true);
}

/** 请求体里是否含图片块（兼容 Anthropic / OpenAI chat / Responses 三种形状） */
function bodyHasImage(body) {
  return imageBlockStats(body).total > 0;
}

/**
 * 图片块计数（2026-09-18 用户排查"我明明没发图片"）：
 * 客户端**每轮都会重发完整历史**，所以一张早期的截图会让之后每一轮请求都"含图片"
 * （实测：14:43 用户贴的控制台截图，导致 14:57 起每一轮都命中多模态路由）；
 * 只报"请求含图片"会让人误以为是自己**本轮**附了图 → 日志区分"本轮 / 历史"。
 * 判定只看 content 块类型（不会把正文里提到 "image" 的文字误判成图片）。
 */
function imageBlockStats(body) {
  if (!body || typeof body !== 'object') return { total: 0, lastTurn: 0, history: 0 };
  const countImg = (content) => (Array.isArray(content)
    ? content.filter((b) => b && (b.type === 'image' || b.type === 'image_url' || b.type === 'input_image' || b.image_url != null)).length
    : 0);
  const list = Array.isArray(body.messages) ? body.messages : (Array.isArray(body.input) ? body.input : []);   // body.input = Responses API
  let total = 0;
  let lastTurn = 0;
  let lastUserSeen = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] || {};
    const n = countImg(m.content);
    total += n;
    if (!lastUserSeen && String(m.role || '').toLowerCase() === 'user') { lastTurn = n; lastUserSeen = true; }
  }
  return { total, lastTurn, history: Math.max(0, total - lastTurn) };
}

/**
 * 带图片的请求：只保留声明了图片能力的候选。
 * 若**没有任何候选声明图片能力**，则保持原候选（宁可原样转给上游拿明确报错，也不要凭空 404）。
 */
function filterVisionCandidates(eligible, reasons, model) {
  const visionOk = eligible.filter((p) => providerSupportsVision(p, model));
  if (visionOk.length === 0) return { eligible, reasons, dropped: 0 };
  const dropped = eligible.length - visionOk.length;
  const keptReasons = reasons.filter((r) => visionOk.some((p) => p.id === r.id));
  return { eligible: visionOk, reasons: keptReasons, dropped };
}

/** 该逻辑模型是否**任一**启用的家声明了图片能力（writeDshConfig 写 input 用） */
function logicalModelSupportsVision(cfg, logical) {
  return (cfg.providers || []).some((p) => p && p.enabled !== false && providerSupportsVision(p, logical));
}

/* ================= 供应商能力 / 账户池 / WorkBuddy 凭据（2026-09-16） =================
 * 背景：WorkBuddy（腾讯 CodeBuddy）桌面 App 的内置模型只有**客户端私有接口**可用：
 *   POST {base}/v2/chat/completions            —— OpenAI chat 线格式，但强制 stream:true
 *   POST {base}/v2/plugin/auth/token/refresh   —— 刷新 OAuth access token
 *   GET  {base}/console/enterprises/personal/models
 * 鉴权是**桌面 App 的 OAuth access token**（会过期）+ 一组身份头（X-User-Id / X-Enterprise-Id /
 * X-Domain / X-Product: SaaS）。用户可能登录多个账号（多份凭据文件）→ 需要账户池：
 * 轮询分配 + 额度耗尽/会话失效时切下一个账户。
 *
 * 全部以**可选配置项**提供，未配置的供应商行为完全不变：
 *   "protocol": "openai-chat"        上游线协议（缺省 = 跟随客户端请求路径，现有行为）
 *   "auth":     "workbuddy"          启用 WorkBuddy 凭据适配（解析 / 刷新 / 身份头）
 *   "accounts": [{ "id": "a1", "authFile": "…workbuddy-desktop.info" }, { "id": "a2", "apiKey": "…" }]
 *   "headers":  { "X-Product": "SaaS" }   附加静态头
 *   "quirks":   ["force-stream", "stringify-tool-choice", "prepend-system"]
 */

/** 上游线协议：'openai-chat' | 'anthropic-messages' | 'openai-responses' | null（null = 跟随客户端请求路径） */
function providerProtocol(provider) {
  const v = String((provider && provider.protocol) || '').trim().toLowerCase();
  if (v === 'openai-chat' || v === 'openai-completions' || v === 'openai') return 'openai-chat';
  if (v === 'anthropic' || v === 'anthropic-messages') return 'anthropic-messages';
  // ⚠ 这一行是协议矩阵的前提：旧实现只认前两种，`protocol: 'openai-responses'` 落到
  // `return null` → 调用方以为"跟随客户端" → **矩阵翻译根本不触发**，
  // 客户端拿到 200 但响应体是上游的原形状（实测：chat 客户端收到 Responses 体）。
  if (v === 'openai-responses' || v === 'responses') return 'openai-responses';
  return null;
}

/** 兼容性开关（quirk）集合 */
function providerQuirks(provider) {
  const raw = provider && provider.quirks;
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  return new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
}

/** 附加静态头（值必须是字符串/数字；其它类型忽略） */
function providerExtraHeaders(provider) {
  const raw = provider && provider.headers;
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    out[String(k)] = String(v);
  }
  return out;
}

/** 供应商的多把 Key（`apiKeys: [...]`；也兼容逗号/空白/分号分隔的字符串），去空去重。 */
function apiKeysOf(provider) {
  const raw = provider && provider.apiKeys;
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/[\s,;]+/) : []);
  const out = [];
  for (const v of list) {
    const k = String(v == null ? '' : v).trim();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * 账户池条目（id + authFile 或 apiKey）。
 *  ① 显式 `accounts` 优先（含 workbuddy 的 authFile / 只写 { id } 的自动发现）；
 *  ② 否则 `apiKeys: ["k1","k2",…]`（2026-09-17 新增：同一供应商配多把 Key）→ 映射成 key1/key2…
 *     直接复用**已验证的账户池**：轮询分流 + 额度耗尽/密钥失效/限流时自动换下一把 + /health 可见；
 *  ③ 都没有 → 空数组（沿用顶层单个 apiKey 的老路径）。
 */
function providerAccounts(provider) {
  const raw = provider && provider.accounts;
  const isWorkBuddy = String((provider && provider.auth) || '').toLowerCase() === 'workbuddy';
  if (!Array.isArray(raw) || raw.length === 0) {
    const keys = apiKeysOf(provider);
    if (keys.length) return keys.map((k, i) => ({ id: 'key' + (i + 1), authFile: '', apiKey: k }));
    // auth=workbuddy 但没写 accounts → 视为"自动发现本机凭据"的单个账户（开箱即用）
    return isWorkBuddy ? [{ id: 'auto', authFile: '', apiKey: '' }] : [];
  }
  const out = [];
  raw.forEach((a, i) => {
    if (!a || typeof a !== 'object') return;
    const id = String(a.id || a.name || ('acct' + (i + 1))).trim();
    const authFile = String(a.authFile || a.file || '').trim();
    const apiKey = String(a.apiKey || '').trim();
    // auth=workbuddy 时允许只写 { id }：authFile 留空 → 运行时按平台默认路径自动发现
    if (!authFile && !apiKey && !isWorkBuddy) return;
    out.push({ id, authFile, apiKey });
  });
  return out;
}

/**
 * WorkBuddy 桌面 App 凭据文件的平台默认位置（按优先级）。
 * 与插件实现一致：Windows 依次探测 Local/Roaming 两处 AppData；国内版与国际版文件名不同；
 * macOS / Linux 各有一条兜底。这样配置里**不必写死用户名路径**，换机也不用改。
 */
function workbuddyDefaultAuthFiles() {
  const home = os.homedir();
  const rel = ['CodeBuddyExtension', 'Data', 'Public', 'auth'];
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const names = ['workbuddy-desktop.info', 'workbuddy-desktop-ai.info'];   // 国内版 / 国际版
  const out = [];
  for (const root of [local, roaming]) for (const n of names) out.push(path.join(root, ...rel, n));
  for (const n of names) out.push(path.join(home, 'Library', 'Application Support', ...rel, n));   // macOS
  for (const n of names) out.push(path.join(home, '.config', ...rel, n));                          // Linux
  return out;
}

/** 自动发现第一个存在的 WorkBuddy 凭据文件（找不到返回 null） */
function findWorkbuddyAuthFile() {
  // 1) 环境变量显式指定（与 dsh-workbuddy-connect 插件一致，便于非标准安装位置）
  for (const name of ['WORKBUDDY_AUTH_FILE', 'WORKBUDDY_AI_AUTH_FILE']) {
    const v = String(process.env[name] || '').trim();
    if (!v) continue;
    try { if (fs.statSync(v).isFile()) return v; } catch { /* 指了但不存在 → 继续探测 */ }
  }
  // 2) 平台默认位置
  for (const p of workbuddyDefaultAuthFiles()) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 不存在 → 下一个 */ }
  }
  return null;
}

/* ---------------- 账户池状态（轮询 + 冷却） ---------------- */
const accountPool = new Map();     // `${providerId}#${acctId}` → { state, until, reason, fails }
const accountRR = new Map();       // providerId → 轮询游标
const ACCOUNT_CREDIT_COOLDOWN_MS = envMs('DSH_GATEWAY_ACCOUNT_CREDIT_COOLDOWN_MS', 30 * 60_000);  // 额度耗尽：长冷却
const ACCOUNT_SESSION_COOLDOWN_MS = envMs('DSH_GATEWAY_ACCOUNT_SESSION_COOLDOWN_MS', 60 * 60_000); // 会话失效：等重新登录
const ACCOUNT_RATE_COOLDOWN_MS = envMs('DSH_GATEWAY_ACCOUNT_RATE_COOLDOWN_MS', 90_000);            // 限流：短冷却（基准值）
const ACCOUNT_RATE_COOLDOWN_MAX_MS = envMs('DSH_GATEWAY_ACCOUNT_RATE_COOLDOWN_MAX_MS', 30 * 60_000); // 限流冷却上限（含 Retry-After 的夹取）
// 账户池容量上界。键含上游模型 ID（provider#acct@model），"上游逐模型限流"时每模型一条 ——
// 没有上界就会被客户端逐个模型撑大，而 accountPoolSnapshot 会把它全量列进**免鉴权**的 /health。
// 取 512 与 sessionAffinity / responseAffinity 同一量级（它们在无界增长那次审计里已经加过界）。
const ACCOUNT_POOL_MAX = Number(process.env.DSH_GATEWAY_ACCOUNT_POOL_MAX) > 0
  ? Number(process.env.DSH_GATEWAY_ACCOUNT_POOL_MAX) : 512;

function accountKey(providerId, acctId) { return providerId + '#' + acctId; }
/** 模型作用域的冷却键（仅限流类用，见 markAccountFailure 的 model 参数说明）。 */
function accountModelKey(providerId, acctId, model) {
  return providerId + '#' + acctId + '@' + String(model || '');
}

/** 冷却条目是否已过冷却期（纯读，无副作用） */
function coolEntryUsable(st) {
  if (!st) return true;
  if (st.state === 'ok') return true;
  return Date.now() >= st.until;
}

/**
 * 该账户当前是否可用（纯读；冷却到点即视为可用，不清状态）。
 * `model` 传入时会**同时**看账户级与模型级两条冷却记录。
 */
function accountUsable(providerId, acct, model) {
  if (!coolEntryUsable(accountPool.get(accountKey(providerId, acct.id)))) return false;
  if (model && !coolEntryUsable(accountPool.get(accountModelKey(providerId, acct.id, model)))) return false;
  return true;
}

/**
 * 解析上游的 `Retry-After`（秒数或 HTTP-date）。拿不到/非法返回 0。
 *
 * 为什么值得做：真实客户端**确实遵循**它（Codex 的 Rust HTTP 客户端里 `retry-after.rs`
 * 是一等模块）。无视它会让上游看到"刚被限流就立刻回来接着打"——这是限流场景下最典型的
 * 滥用特征，也正是把短期限流升级成封禁的常见路径。旧实现全文件 0 处引用它。
 */
function retryAfterMs(resp) {
  try {
    const raw = resp && resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('retry-after') : null;
    if (!raw) return 0;
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, ACCOUNT_RATE_COOLDOWN_MAX_MS);
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return 0;
    return Math.min(Math.max(0, t - Date.now()), ACCOUNT_RATE_COOLDOWN_MAX_MS);
  } catch { return 0; }
}

/**
 * 429 的冷却时长：优先信任服务端给的 `Retry-After`；否则按该键的**连续失败次数**指数增长，
 * 并加 ±20% 抖动。
 *
 * 抖动的意义：不加抖动时，多个账户会在**同一时刻**集体复活、再一起撞墙，形成"冷却→撞墙→冷却"
 * 的锯齿；抖动把它们错开。旧实现是固定 90 秒、全文件 0 处 jitter。
 * 旧值 90 秒也偏短：多数上游 429 的窗口是 1 分钟，但"模型级并发上限"这类恢复取决于
 * 在途请求结束，持续负载下 90 秒后立刻重试往往还是撞墙，所以让它随失败次数递增。
 */
function rateCooldownMs(prevFails, serverMs) {
  const cap = ACCOUNT_RATE_COOLDOWN_MAX_MS;
  // 上游明确给了 Retry-After 就听它的 —— 但仍要夹取：
  // 一条畸形的 `Retry-After: 999999999` 不该变成"这把 Key 永久不可用"。
  // （旧写法 `if (serverMs > 0) return serverMs;` 不夹取，`Infinity` 会原样返回 = 永久冷却。）
  if (Number.isFinite(serverMs) && serverMs > 0) return Math.min(serverMs, cap);
  const exp = Math.min(ACCOUNT_RATE_COOLDOWN_MS * 2 ** Math.min(prevFails || 0, 5), cap);
  const jitter = 0.8 + Math.random() * 0.4;
  // ⚠ 抖动必须在**夹取之后**再夹一次。旧写法里 exp 已经夹过，`exp * jitter` 最大到 1.2×cap ——
  // 20 万次采样实测上限 2159999ms（36 分钟），而常量 `ACCOUNT_RATE_COOLDOWN_MAX_MS` 写的是
  // 30 分钟。常量与真实行为不一致，会让"到底冷却多久"这类排查凭空多出 6 分钟误差。
  return Math.round(Math.min(exp * jitter, cap));
}

/**
 * 标记账户失败：额度耗尽 / 会话失效 / 限流 → 冷却并切下一个账户。
 *
 * 冷却粒度（2026-09-22 实测修复：amd 的两把 Key 被 429 连坐）：
 *  · `rate`（429）**按「供应商+账户+模型」记** —— 上游的限流常常是**模型级**的
 *    （实测 amd：`Model 'DeepSeek-V4.1-Flash' is at its concurrency limit (32)`），
 *    而两把 Key 打的是同一个模型、共享该上限，换 Key 无用。旧实现按账户级记，
 *    于是 V4.1-Flash 的一次 429 把该 Key 上**本来正常的其它模型**（如 V4-Flash）也冷却 90 秒。
 *  · `credit` / `session`（额度耗尽 / 登录失效）仍是**账户级** —— 这两类确实整把 Key 都不能用。
 */
function markAccountFailure(providerId, acct, kind, detail, model, serverMs) {
  // D13 + 第七轮审计：账户池必须有**硬上界**。
  // 旧实现只在 size > 64 时清一次，而且判据是 `now >= st.until`（**已过期**才删）——
  // 正在冷却的模型级条目（最长 30 分钟）一个都不删，于是"上游逐模型限流"时每个模型留一条，
  // 表只增不减；`accountPoolSnapshot` 又会把它**全量**列进**免鉴权**的 /health。
  // 实测：300 次请求（每模型一次）→ 301 条 / 47 KB；两把 Key → 602 条 / 125 KB；
  // 进程内直测 2000 个模型 → 254 KB。客户端可以逐个模型把它撑起来。
  {
    const now = Date.now();
    for (const [k, st] of accountPool) {
      if (st && st.state !== 'ok' && now >= st.until) accountPool.delete(k);
    }
    // 仍然超上界 → 按 until 升序淘汰（最该忘记的先走）。用 LRU 而不是"直接清空"：
    // 清空会让所有正在冷却的账户立刻复活、又去撞刚被限流的上游。
    if (accountPool.size > ACCOUNT_POOL_MAX) {
      const byUntil = [...accountPool.entries()].sort((a, b) =>
        ((a[1] && a[1].until) || 0) - ((b[1] && b[1].until) || 0));
      for (let i = 0; i < byUntil.length && accountPool.size > ACCOUNT_POOL_MAX; i++) {
        accountPool.delete(byUntil[i][0]);
      }
    }
  }
  const scoped = kind === 'rate' && model;
  const key = scoped ? accountModelKey(providerId, acct.id, model) : accountKey(providerId, acct.id);
  const prev = accountPool.get(key);
  const ms = kind === 'credit' ? ACCOUNT_CREDIT_COOLDOWN_MS
    : kind === 'session' ? ACCOUNT_SESSION_COOLDOWN_MS
      : rateCooldownMs(prev ? prev.fails : 0, serverMs);
  accountPool.set(key, {
    state: kind, until: Date.now() + ms, fails: (prev ? prev.fails : 0) + 1,
    // D6（安全）：必须过 maskSecrets —— 上游鉴权失败时回显收到的 Authorization 是常见实现，
    // 不过滤会让用户的统一网关 key 明文进 /health（免鉴权）与日志。这是同文件里唯一的裸输出点。
    reason: maskSecrets(String(detail || kind)).replace(/\s+/g, ' ').slice(0, 120),
    ...(scoped ? { model: String(model) } : {}),
  });
  // D6（安全）：同上——日志与 /health 的 reason 是两个出口，都要脱敏
  log(`account ${providerId}#${acct.id}${scoped ? ' 模型 ' + model : ''} 标记为 ${kind}（冷却 ${Math.round(ms / 1000)}s`
    + `${serverMs > 0 ? '，遵循上游 Retry-After' : ''}）：${maskSecrets(String(detail || '')).slice(0, 120)}`);
}

/** 账户成功一次 → 清掉失败状态（含该模型的模型级冷却；不动其它模型的冷却） */
function markAccountOk(providerId, acct, model) {
  if (!acct) return;
  accountPool.delete(accountKey(providerId, acct.id));
  if (model) accountPool.delete(accountModelKey(providerId, acct.id, model));
}

/** 最近一次实际使用的账户（providerId → acctId）；日志里以 `#acct` 标注，便于核对多账户分流 */
const accountLastUsed = new Map();

/** 日志用的 via 标签：provider 无账户池时就是 provider id；有则附上本次账户 `provider#acct` */
function viaTag(providerId) {
  const acct = accountLastUsed.get(providerId);
  return acct ? `${providerId}#${acct}` : providerId;
}

/**
 * 账户池快照（诊断用：/health 的 accounts 字段）。
 * 不仅列出"冷却中"的，而是**按配置列出全部账户**及其当前状态 —— 多账户场景下
 * "到底有几个账户、哪个被额度耗尽、还剩多久恢复"必须一眼可见。
 * @param {object} [cfg] 传入配置则连同未进入过冷却的账户一起列出（state='ok'）
 */
function accountPoolSnapshot(cfg) {
  // 顺带清理过期条目。旧实现什么都不清，于是 /health（**免鉴权**）的响应体
  // 与 accountPool 的规模完全同步增长 —— 审计实测连打 200 次 /health，
  // 每次都要序列化 300 条 / 47 KB，而表里绝大多数是早已过期的冷却记录。
  {
    const now = Date.now();
    for (const [k, st] of accountPool) {
      if (st && st.state !== 'ok' && now >= st.until) accountPool.delete(k);
    }
  }
  const out = [];
  const seen = new Set();
  const modelScoped = [];   // 模型级冷却条目（rate）单独列出，不混进账户级状态
  if (cfg && Array.isArray(cfg.providers)) {
    for (const p of cfg.providers) {
      if (!p || p.enabled === false) continue;
      for (const acct of providerAccounts(p)) {
        const key = accountKey(p.id, acct.id);
        seen.add(key);
        const st = accountPool.get(key);
        // 账户级只反映账户级记录；模型级记录另列（否则 /health 会把"某模型限流"误报成"整把 Key 不可用"）
        const usable = coolEntryUsable(st);
        out.push({
          key,
          provider: p.id,
          id: acct.id,
          state: st && !usable ? st.state : 'ok',
          remainMs: st && !usable ? Math.max(0, st.until - Date.now()) : 0,
          ...(st && !usable ? { reason: st.reason } : {}),
          ...(accountLastUsed.get(p.id) === acct.id ? { lastUsed: true } : {}),
        });
      }
    }
  }
  // 模型级冷却（如 amd#key1 的 DeepSeek-V4.1-Flash 限流）——按 key 逐条列出，便于排查"为什么这个模型不走这家"
  for (const [k, st] of accountPool) {
    if (!st || !st.model) continue;
    if (Date.now() >= st.until) continue;
    modelScoped.push({
      key: k,
      provider: k.split('#')[0],
      model: st.model,
      state: st.state,
      remainMs: Math.max(0, st.until - Date.now()),
      reason: st.reason,
      modelScoped: true,
    });
  }
  // 兜底：配置里已删除、但进程内仍有冷却记录的账户也列出来（便于发现"配置改了仍被冷却"）
  for (const [key, st] of accountPool) {
    if (seen.has(key)) continue;
    if (st && st.model) continue;   // 模型级已在上方列出
    out.push({
      key,
      state: st.state,
      remainMs: Math.max(0, st.until - Date.now()),
      reason: st.reason,
      orphan: true,
    });
  }
  return out.concat(modelScoped);
}

/**
 * 取该供应商本次要用的账户（轮询）。
 * 返回 null 表示"无账户池"（沿用顶层 apiKey 的旧路径）；返回 {accounts:[], allCooling:true}
 * 由调用方决定是否整体跳过。
 */
/**
 * 取该供应商本次要用的账户（轮询）。
 * 返回 null 表示"无账户池"（沿用顶层 apiKey 的旧路径）；返回 {accounts:[], allCooling:true}
 * 由调用方决定是否整体跳过。
 * `model` 传入时会额外排除"该模型正在限流冷却"的账户（模型级冷却，见 markAccountFailure）。
 */
function pickAccount(provider, model) {
  const accounts = providerAccounts(provider);
  if (accounts.length === 0) return { acct: null, accounts, cooling: 0 };
  const usable = accounts.filter((a) => accountUsable(provider.id, a, model));
  if (usable.length === 0) return { acct: null, accounts, cooling: accounts.length };
  const n = accountRR.get(provider.id) || 0;
  accountRR.set(provider.id, n + 1);
  return { acct: usable[n % usable.length], accounts, cooling: 0 };
}

/* ---------------- WorkBuddy 凭据：解析 / 刷新 / 身份头 ---------------- */

/** 解析桌面 App 的 auth 文件（两种形态：{auth,account} 嵌套 与 扁平） */
function parseWorkBuddyAuth(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const nested = doc.auth && typeof doc.auth === 'object' && !Array.isArray(doc.auth);
  const auth = nested ? doc.auth : doc;
  const account = nested && doc.account && typeof doc.account === 'object' ? doc.account : doc;
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : '';
  if (!accessToken) return null;
  const toMs = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e12 ? n : n * 1000;   // 秒 / 毫秒两种上游写法
  };
  const str = (v) => (typeof v === 'string' && v !== '' ? v : undefined);
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: toMs(auth.expiresAt ?? auth.expires_at),
    refreshExpiresAtMs: toMs(auth.refreshExpiresAt),
    domain: str(auth.domain) || '',
    uid: str(account.uid) || '',
    enterpriseId: str(account.enterpriseId),
    nickname: str(account.nickname),
  };
}

/** 自留副本路径（网关自己的目录，绝不写桌面 App 的文件） */
function workbuddyOwnPath(provider, acct) {
  const dir = path.join(path.dirname(CONFIG_PATH), 'workbuddy-auth');
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, `${safe(provider.id)}-${safe(acct.id)}.json`);
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 该凭据是否需要在本次请求前刷新（5 分钟余量） */
const WORKBUDDY_REFRESH_MARGIN_MS = 5 * 60_000;
function workbuddyNeedsRefresh(cred) {
  if (!cred || cred.expiresAtMs <= 0) return true;
  return Date.now() + WORKBUDDY_REFRESH_MARGIN_MS >= cred.expiresAtMs;
}

/** 刷新 OAuth token：POST {base}/plugin/auth/token/refresh（base 已含 /v2） */
async function refreshWorkBuddyToken(provider, acct, cred) {
  if (!cred.refreshToken) throw new Error('无 refreshToken，需在 WorkBuddy 桌面 App 重新登录');
  const base = upstreamBase(provider.baseURL);
  const origin = workbuddyOrigin(cred.domain);
  const res = await fetch(`${base}/plugin/auth/token/refresh`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: origin,
      Referer: origin + '/',
      'User-Agent': providerExtraHeaders(provider)['User-Agent'] || 'CLI/2.63.2 CodeBuddy/2.63.2',
      'X-Refresh-Token': cred.refreshToken,
      'X-Auth-Refresh-Source': 'workbuddy',
      ...(cred.enterpriseId ? { 'X-Enterprise-Id': cred.enterpriseId } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let doc = null;
  try { doc = JSON.parse(text); } catch { /* 非 JSON：下面按失败处理 */ }
  const data = doc && typeof doc === 'object' && doc.data && typeof doc.data === 'object' ? doc.data : {};
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
  if (!res.ok || (doc && typeof doc.code === 'number' && doc.code !== 0) || !accessToken) {
    const msg = (doc && typeof doc.msg === 'string' && doc.msg) || text.slice(0, 160);
    throw new Error(`刷新失败（HTTP ${res.status}）：${msg}`);
  }
  const next = {
    ...cred,
    accessToken,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken ? data.refreshToken : cred.refreshToken,
    expiresAtMs: typeof data.expiresIn === 'number' && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1000 : cred.expiresAtMs,
    domain: typeof data.domain === 'string' && data.domain ? data.domain : cred.domain,
  };
  try {
    fs.mkdirSync(path.dirname(workbuddyOwnPath(provider, acct)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(workbuddyOwnPath(provider, acct), JSON.stringify({ version: 1, credential: next }, null, 2), { mode: 0o600 });
  } catch (e) {
    log(`account ${provider.id}#${acct.id} 凭据副本写入失败（不影响本次使用）：${e && e.message}`);
  }
  return next;
}

const workbuddyCredCache = new Map();      // key → { cred, ts }
const workbuddyInflight = new Map();       // key → Promise（单飞：并发请求共享一次刷新）

/** 解析该账户当前可用的凭据（缓存 → 自留副本 → 桌面 auth 文件），必要时单飞刷新 */
async function resolveWorkBuddyCredential(provider, acct) {
  if (acct.apiKey) return { accessToken: acct.apiKey, refreshToken: '', expiresAtMs: Date.now() + 3600_000, domain: '', uid: '' };
  const key = accountKey(provider.id, acct.id);
  const cached = workbuddyCredCache.get(key);
  if (cached && !workbuddyNeedsRefresh(cached.cred)) return cached.cred;
  if (workbuddyInflight.has(key)) return workbuddyInflight.get(key);
  const task = (async () => {
    const ownRaw = readJsonSafe(workbuddyOwnPath(provider, acct));
    const own = ownRaw && ownRaw.credential ? ownRaw.credential : null;
    let desktop = null;
    // authFile 留空 → 按平台默认位置自动发现（配置里不必写死机器相关路径）
    const authFile = acct.authFile || findWorkbuddyAuthFile();
    try {
      if (authFile) desktop = parseWorkBuddyAuth(fs.readFileSync(authFile, 'utf8'));
    } catch (e) {
      if (!own) throw new Error(`读凭据文件失败：${authFile}（${e && e.message}）`);
    }
    // 身份优先：桌面文件是"当前登录的是谁"的权威；自留副本可能是旧账号
    let cred = desktop || own;
    if (!cred) {
      throw new Error(authFile
        ? `账户 ${acct.id} 无可用凭据：${authFile} 未登录或已失效`
        : `账户 ${acct.id} 未找到 WorkBuddy 登录凭据——请先安装并登录 WorkBuddy 桌面 App`
          + `（已探测：${workbuddyDefaultAuthFiles().slice(0, 2).join('、')} 等）`);
    }
    if (desktop && own && desktop.uid !== own.uid) cred = desktop;
    // 区域守卫（2026-09-20，参照 dsh-workbuddy-connect 的安全红线）：国内版与国际版
    // 凭据**互不通用**，且共用同一个 CodeBuddyExtension auth 目录、只差文件名——
    // 配置里写错 authFile / 端点就会把一国账号的 token 发到另一国端点（实测 401，
    // 且属跨产品泄漏）。这里在发请求前就拒绝，并说清该改哪个文件/环境变量。
    {
      const providerRegion = workbuddyProviderRegion(provider);
      const credRegion = workbuddyRegionOf(cred.domain);
      // providerRegion === null 表示"区域未知"（自定义/自建中转端点）→ 不据此拦截，
      // 否则会误伤 test 假上游与内网代理这类合法组合。
      if (providerRegion !== null && credRegion !== providerRegion) {
        const expectFile = providerRegion === 'global' ? 'workbuddy-desktop-ai.info' : 'workbuddy-desktop.info';
        const expectEnv = providerRegion === 'global' ? 'WORKBUDDY_AI_AUTH_FILE' : 'WORKBUDDY_AUTH_FILE';
        throw new Error(
          `${provider.id} 是${providerRegion === 'global' ? '国际版（WorkBuddy AI）' : '国内版（WorkBuddy）'}供应商，`
          + `但取到的凭据属于${credRegion === 'global' ? '国际版' : '国内版'}（domain=${JSON.stringify(cred.domain)}）——`
          + `两个区域的凭据互不通用。请把该供应商的 authFile 指向本机 ${expectFile}，`
          + `或用环境变量 ${expectEnv} 指定；若该区域未安装/未登录，请先在对应 App 里登录。`,
        );
      }
    }
    if (workbuddyNeedsRefresh(cred)) {
      try {
        cred = await refreshWorkBuddyToken(provider, acct, cred);
      } catch (e) {
        if (cred.expiresAtMs > Date.now() + 30_000) {
          log(`account ${provider.id}#${acct.id} 刷新失败但 token 未过期，继续使用：${e && e.message}`);
        } else {
          throw e;
        }
      }
    }
    workbuddyCredCache.set(key, { cred, ts: Date.now() });
    return cred;
  })().finally(() => workbuddyInflight.delete(key));
  workbuddyInflight.set(key, task);
  return task;
}

/** WorkBuddy 的区域 origin（身份头 Origin/Referer 用） */
function workbuddyOrigin(domain) {
  const d = String(domain || '').toLowerCase();
  return d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai') ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
}

/**
 * 凭据所属区域：`workbuddy.ai` → 国际版（WorkBuddy AI），其余（含空域）→ 国内版。
 * 与参照实现 corrinehu/dsh-workbuddy-connect 的 `regionOf()` 行为一致（它也只认 workbuddy.ai）。
 */
function workbuddyRegionOf(domain) {
  const d = String(domain || '').trim().toLowerCase();
  return (d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai')) ? 'global' : 'cn';
}

/**
 * 供应商条目声明的区域（可选）：`region: "global" | "cn"`。
 * 未声明时返回 null —— 由端点/凭据推断，而不是把"没写"当成国内版。
 */
function workbuddyDeclaredRegion(provider) {
  const r = String((provider && provider.region) || '').trim().toLowerCase();
  if (r === 'global' || r === 'ai' || r === 'international') return 'global';
  if (r === 'cn' || r === 'china') return 'cn';
  return null;
}

/**
 * 供应商的区域判定（用于跨区守卫），优先级：
 *   ① 显式 `region` 字段（自定义/测试端点无法从 URL 看出区域时用这个）
 *   ② baseURL 主机名（`*.workbuddy.ai` = 国际版，官方端点）
 *   ③ 都没有 → 不判定（返回 null，守卫只按凭据域做正向检查）
 *
 * 注意：**不能**把"URL 不是 workbuddy.ai"直接当成国内版——测试与自建中转
 * （如本地假上游、内网代理）都走非官方域名，那样会把合法组合误判为跨区。
 * 参照实现的 `chatBase(credential)` 本身就是用凭据域决定端点的，区域的正主是凭据。
 */
function workbuddyProviderRegion(provider) {
  const declared = workbuddyDeclaredRegion(provider);
  if (declared) return declared;
  try {
    const host = new URL(String((provider && provider.baseURL) || '')).host.toLowerCase();
    if (host === 'www.workbuddy.ai' || host === 'workbuddy.ai' || host.endsWith('.workbuddy.ai')) return 'global';
    if (host.endsWith('workbuddy.cn') || host === 'copilot.tencent.com' || host.endsWith('codebuddy.cn')) return 'cn';
  } catch { /* 非法 URL → 不判定 */ }
  return null;   // 自定义端点：区域未知，不据此拦截
}

/* ---------------- WorkBuddy 客户端身份仿真（2026-09-16） ----------------
 * 官方桌面客户端的 chat 请求带 `WorkBuddy/<appVer> WorkBuddy/<appVer> CLI/<cliVer>` 形态 UA
 *（国际版产品名 `WorkBuddy AI`），而刷新/目录接口用 CLI 形态 UA。上游按客户端身份套用不同的
 * 模型能力/参数规则 —— 用 CLI 形态打 chat 会被判"参数不符合模型要求"
 *（实测 HTTP 400 code 11133 model_param_invalid）。这里按本机真实版本合成桌面 UA。
 * 版本来源（沿用 dsh-workbuddy-connect 的取值规则，并补上 Windows 路径）：
 *   · App：<安装目录>\resources\install-manifest.json 的 appVersion（Windows 实测可得）
 *   · CLI：<安装目录>\resources\app.asar.unpacked\cli\package.json —— version 为 0.0.0 占位时
 *     取 publishConfig.customPackage.version
 * 读不到就退回 CLI 形态常量（不阻塞请求），与插件"降级但不失败"的策略一致。
 */
const WORKBUDDY_FALLBACK_APP_VERSION = '5.5.6';           // 与插件 FALLBACK_CN_APP_VERSION 一致
const WORKBUDDY_CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';   // 刷新/目录用（插件同款常量）

/** 候选安装目录（Windows / macOS），env WORKBUDDY_APP_DIR 可覆盖 */
function workbuddyAppDirs() {
  const out = [];
  const env = String(process.env.WORKBUDDY_APP_DIR || '').trim();
  if (env) out.push(env);
  if (process.platform === 'win32') {
    for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (root) out.push(path.join(root, 'Programs', 'WorkBuddy'), path.join(root, 'WorkBuddy'));
    }
  } else {
    out.push(path.join(os.homedir(), 'Applications', 'WorkBuddy.app'), '/Applications/WorkBuddy.app');
  }
  return out;
}

const workbuddyVersionCache = new Map();   // dir → { appVersion, cliVersion, ts }
// 缓存必须有 TTL：客户端**自动更新**后，旧实现会把旧版本号当身份头一直发出去
//（`X-IDE-Version` 与 chat 的 UA），直到网关进程重启 —— 这正好造成
// "身份头与客户端实际版本不一致"的自相矛盾，是仿真里最不该有的破绽。
// 10 分钟重读一次两个小 JSON，代价可忽略。
const WORKBUDDY_VERSION_TTL_MS = 10 * 60_000;

/** 读一个安装目录里的 App / CLI 版本（带 TTL 缓存） */
function readWorkbuddyVersions(dir) {
  const hit = workbuddyVersionCache.get(dir);
  if (hit && Date.now() - hit.ts < WORKBUDDY_VERSION_TTL_MS) return hit;
  let appVersion = '';
  let cliVersion = '';
  const resDir = path.join(dir, 'resources');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(resDir, 'install-manifest.json'), 'utf8'));
    if (manifest && typeof manifest.appVersion === 'string' && /^\d+(\.\d+){1,3}$/.test(manifest.appVersion)) {
      appVersion = manifest.appVersion;
    }
  } catch { /* 该目录没有 → 试下一个 */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(resDir, 'app.asar.unpacked', 'cli', 'package.json'), 'utf8'));
    const declared = typeof pkg.version === 'string' ? pkg.version : '';
    const custom = pkg.publishConfig && pkg.publishConfig.customPackage
      && typeof pkg.publishConfig.customPackage.version === 'string' ? pkg.publishConfig.customPackage.version : '';
    const valid = (v) => /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/.test(v);
    if (valid(declared) && declared !== '0.0.0') cliVersion = declared;
    else if (valid(custom)) cliVersion = custom;
  } catch { /* CLI 版本可选 */ }
  const out = { appVersion, cliVersion, ts: Date.now() };
  workbuddyVersionCache.set(dir, out);
  return out;
}

/** 本机 WorkBuddy 的 App / CLI 版本（找不到返回空串） */
function workbuddyVersions() {
  for (const dir of workbuddyAppDirs()) {
    const v = readWorkbuddyVersions(dir);
    if (v.appVersion) return v;
  }
  return { appVersion: '', cliVersion: '' };
}

/** 合成 chat 的桌面身份 UA：`WorkBuddy/<app> WorkBuddy/<app> [CLI/<cli>]` */
function workbuddyChatUserAgent(domain) {
  const { appVersion, cliVersion } = workbuddyVersions();
  if (!appVersion) return WORKBUDDY_CLI_UA;
  const d = String(domain || '').toLowerCase();
  const product = (d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai')) ? 'WorkBuddy AI' : 'WorkBuddy';
  const parts = [`WorkBuddy/${appVersion}`, `${product}/${appVersion}`];
  if (cliVersion) parts.push(`CLI/${cliVersion}`);
  return parts.join(' ');
}

/**
 * 桌面端身份头（**使用端归属**，2026-09-18 用户实测发现）：
 * 官方桌面端启动内置 CLI 时注入 `CLIENT_INFO_IDE_TYPE/PLATFORM = "WorkBuddy"`、
 * `CLIENT_INFO_PLATFORM_VERSION = <桌面版本>`（见 app.asar buildWorkbuddyClientInfoEnv），
 * CLI 再把它们写成 `X-IDE-Type` / `X-IDE-Name` / `X-IDE-Version` 三个请求头
 * （codebuddy.js：`ey[IDE_TYPE_HEADER]=ideType`、`ey[IDE_NAME_HEADER]=platform`、
 * `ey[IDE_VERSION_HEADER]=platformVersion`；桌面端 banner 请求同款三头 + `X-Product: WorkBuddy`）。
 * 只发 UA 时上游认不出使用端——腾讯控制台「积分消耗明细 → 使用端」显示为 `-`（网关调用全被记成无归属）。
 */
function workbuddyIdeHeaders() {
  const { appVersion } = workbuddyVersions();
  return {
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': appVersion || '0.0.0',
  };
}

/**
 * 用凭据构造上游请求头（Authorization + 身份头 + 客户端仿真头）
 * @param {boolean} [forChat] true = chat 请求（用桌面身份 UA）；缺省 = 刷新/目录（CLI 形态 UA）
 */
function workbuddyHeaders(provider, cred, extra, forChat) {
  const origin = workbuddyOrigin(cred.domain);
  const h = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: origin + '/',
    'Content-Type': 'application/json',
    'X-Product': 'SaaS',
    Authorization: 'Bearer ' + cred.accessToken,
    ...(cred.uid ? { 'X-User-Id': cred.uid } : { 'X-No-User-Id': '1' }),
    ...(cred.enterpriseId ? { 'X-Enterprise-Id': cred.enterpriseId } : { 'X-No-Enterprise-Id': '1' }),
    ...(cred.domain ? { 'X-Domain': cred.domain } : { 'X-No-Department-Info': '1' }),
    ...(extra || {}),
  };
  // 身份仿真（关键）：chat 用桌面形态 UA + X-IDE-* 三头（使用端归属）；刷新/目录保持 CLI 形态。
  // 配置里的 headers.User-Agent 只作为刷新路径的覆盖，不参与 chat（chat 必须是桌面身份）。
  if (forChat) {
    h['User-Agent'] = workbuddyChatUserAgent(cred.domain);
    Object.assign(h, workbuddyIdeHeaders());
  } else h['User-Agent'] = WORKBUDDY_CLI_UA;
  return h;
}

/**
 * 由网关独占的"凭据/身份"类请求头（大小写不敏感）。
 * 翻译路径重建上游头时先剔除它们，避免与账户凭据头重复（重复会变成 "Bearer A, Bearer B" 的坏值）。
 */
const RESERVED_UPSTREAM_HEADERS = new Set([
  'authorization', 'x-api-key', 'anthropic-version',
  'x-user-id', 'x-enterprise-id', 'x-domain', 'x-product',
  'x-no-user-id', 'x-no-enterprise-id', 'x-no-department-info',
  'x-ide-type', 'x-ide-name', 'x-ide-version',
  'origin', 'referer', 'x-requested-with',
]);

/** 大小写不敏感地删除某个头（Node 会把大小写不同的同名头用 ", " 合并成脏值） */
function dropHeaderCI(obj, name) {
  for (const k of Object.keys(obj)) if (k.toLowerCase() === name) delete obj[k];
}
/** 大小写不敏感地取某个头 */
function pickHeaderCI(obj, name) {
  for (const [k, v] of Object.entries(obj || {})) if (k.toLowerCase() === name) return v;
  return undefined;
}

/**
 * 构造"用某个账户发上游请求"的完整请求头（翻译路径与直通路径共用，避免两处漂移）：
 *  ① 剔除网关独占的凭据/身份头（防重复 Authorization）；
 *  ② auth=workbuddy → 解析凭据 + 身份头 + **桌面客户端形态 UA**（chat）/CLI 形态 UA（刷新）；
 *  ③ 否则用账户自带 apiKey（OpenAI 线上游发 Bearer；Anthropic 线上游发 x-api-key）；
 *  ④ 合并供应商 `headers` 自定义头。
 * 凭据不可用时抛错，由调用方决定"换账户"还是"放弃该供应商"。
 */
async function accountUpstreamHeaders(provider, acct, baseHeaders, { anthropicUpstream }) {
  const extra = providerExtraHeaders(provider);
  const base = { ...(baseHeaders || {}) };
  for (const k of Object.keys(base)) {
    if (RESERVED_UPSTREAM_HEADERS.has(k.toLowerCase())) delete base[k];
  }
  // User-Agent 必须**只有一个**：供应商显式配置优先，其次沿用 base（Claude 仿真）；
  // 先记录再删除所有大小写变体，最后由下面按需写回唯一一个（WorkBuddy 分支写桌面身份）。
  const ua = pickHeaderCI(extra, 'user-agent') ?? pickHeaderCI(base, 'user-agent');
  const out = { ...base, ...extra };
  dropHeaderCI(out, 'user-agent');
  if (acct && acct.id) accountLastUsed.set(provider.id, acct.id);   // 日志/health 标注本次账户
  if (String(provider.auth || '').toLowerCase() === 'workbuddy') {
    const cred = await resolveWorkBuddyCredential(provider, acct || { id: 'default' });
    Object.assign(out, workbuddyHeaders(provider, cred, out, true));   // 内部设置唯一的桌面身份 UA
    return out;
  }
  if (ua) out['User-Agent'] = ua;
  const key = (acct && acct.apiKey) || provider.apiKey;
  if (key) {
    if (anthropicUpstream) {
      out['x-api-key'] = key;
      out['anthropic-version'] = out['anthropic-version'] || '2023-06-01';
    } else {
      out.authorization = 'Bearer ' + key;
    }
  }
  return out;
}

/**
 * 带账户池的上游转发（2026-09-16）：供应商配了 accounts 时，先用轮询选中的账户发；
 * 若失败属于**账户级**（额度耗尽 / 会话失效 / 限流），标记该账户并换下一个账户重试；
 * 全部账户都不可用（或失败与账户无关）才按 forward() 的原契约返回，交给下一家供应商。
 *
 * 实现要点：不改写 forward() 的主流程，只借 opts.failureSink 拿回"上游状态码 + 错误体"，
 * 由本函数做账户级判定 —— 这样流式透传 / SSE 首事件嗅探 / 熔断等既有行为完全复用。
 */
async function forwardWithAccounts(provider, upstreamPath, baseHeaders, body, res, opts) {
  const accounts = providerAccounts(provider);
  // 限流冷却的作用域用**上游模型 ID**（body 已经过 bodyForProvider 映射）——上游限流
  // 就是按这个 ID 判的（实测 amd：`Model 'DeepSeek-V4.1-Flash' is at its concurrency limit`）。
  const scopeModel = (body && typeof body.model === 'string') ? body.model : '';
  // 无账户池：仍要走一遍账户头构造 —— 否则供应商 `headers`（自定义 UA/品牌头）在直通路径上会被丢掉
  if (accounts.length === 0) {
    const anthropicUpstream = upstreamPath === '/messages' || upstreamPath === '/v1/messages';
    let headers = baseHeaders;
    try {
      headers = await accountUpstreamHeaders(provider, null, baseHeaders, { anthropicUpstream });
    } catch (e) {
      log(`provider ${provider.id} 头部构造失败：${e && e.message}`);
      return false;
    }
    return forward(provider, upstreamPath, headers, body, res, opts);
  }
  const usable = accounts.filter((a) => accountUsable(provider.id, a, scopeModel));
  if (usable.length === 0) {
    log(`provider ${provider.id}: ${accounts.length} 个账户全部冷却中 → 交给下一家`);
    return false;
  }
  // 轮询起点（与翻译路径共用同一游标，保证多账户分流均匀）
  const n = accountRR.get(provider.id) || 0;
  accountRR.set(provider.id, n + 1);
  const ordered = [...usable.slice(n % usable.length), ...usable.slice(0, n % usable.length)];
  const anthropicUpstream = upstreamPath === '/messages' || upstreamPath === '/v1/messages';
  let lastOut = false;
  for (let i = 0; i < ordered.length; i++) {
    const acct = ordered[i];
    let headers;
    try {
      // eslint-disable-next-line no-await-in-loop
      headers = await accountUpstreamHeaders(provider, acct, baseHeaders, { anthropicUpstream });
    } catch (e) {
      log(`account ${provider.id}#${acct.id} 凭据不可用：${e && e.message}`);
      markAccountFailure(provider.id, acct, 'session', e && e.message);
      continue;
    }
    const sink = {};
    // eslint-disable-next-line no-await-in-loop
    const out = await forward(provider, upstreamPath, headers, body, res, { ...(opts || {}), failureSink: sink, accountScoped: true });
    if (out === true) { markAccountOk(provider.id, acct, scopeModel); return true; }
    if (res.headersSent) return out;                     // 已经写给客户端了，不能再重试
    // ⚠ "这家不提供该模型"/"客户端指纹被拒"是**与账号无关**的拒绝（forward 会打上这个标记）。
    // 换下一把 Key 打同一个模型，上游还是同样的拒绝 —— 只会白白冷却用户所有账户。
    // 实测：不带这个判断时，一个地区受限的模型会把该家 2 把 Key 全部标成 session（冷却 1 小时），
    // 随后同家另一个完全正常的模型在路由阶段就被"全部冷却中"挡掉。
    if (sink.modelScopeOnly) return out;
    const kind = classifyAccountFailure(sink.status || 0, sink.detail || '');
    if (kind && i + 1 < ordered.length) {
      markAccountFailure(provider.id, acct, kind, sink.detail, scopeModel, sink.retryMs || 0);
      continue;                                          // 换下一个账户
    }
    if (kind) markAccountFailure(provider.id, acct, kind, sink.detail, scopeModel, sink.retryMs || 0);   // 最后一个账户也要标记
    lastOut = out;
    if (!kind) return out;                               // 与账户无关的失败 → 原样返回
  }
  return lastOut;
}

/**
 * 直通路径（客户端说 OpenAI 协议）也要应用供应商 quirks —— 2026-09-16 实测：
 * 同一份配置里的 `stringify-tool-choice` 只在**翻译路径**生效，于是 OpenAI 客户端把
 * `tool_choice` 以对象形态透传，上游直接 400
 *（`11101: cannot unmarshal object into Go struct field Request.tool_choice of type string`）。
 * 这里统一在发请求前改写 body；返回 { body, forceStreamForNonStream } 供调用方决定是否聚合流。
 */
function applyOpenAIQuirks(body, provider, opts) {
  const responsesMode = !!(opts && opts.responses);
  const quirks = providerQuirks(provider);
  if (!body || typeof body !== 'object' || quirks.size === 0) return { body, needAggregate: false };
  let out = body;
  const detach = () => { if (out === body) out = { ...body }; return out; };
  // ① tool_choice 必须是字符串（对象形态会被上游拒绝）
  if (quirks.has('stringify-tool-choice') && out.tool_choice && typeof out.tool_choice === 'object') {
    const tc = detach().tool_choice;
    out.tool_choice = (tc.function && tc.function.name) || tc.name || 'auto';
  }
  // ② 首条必须是 system：缺失时补一条（仅当确实没有 system 时才补，顺序不动）
  if (quirks.has('prepend-system')) {
    const msgs = Array.isArray(out.messages) ? out.messages : null;
    if (msgs && !(msgs[0] && msgs[0].role === 'system')) {
      detach().messages = [{ role: 'system', content: 'You are a helpful assistant.' }, ...msgs];
    }
  }
  // ③ 上游只接受流式：强制 stream=true；客户端要非流式 → 由调用方聚合后回单条 JSON
  let needAggregate = false;
  // D7：Responses 协议的流式聚合会产出 chat.completion 形状（错），故该路径不用 force-stream；
  // stringify-tool-choice 是纯请求侧改写，对 Responses 同样安全有效，照常生效。
  if (!responsesMode && quirks.has('force-stream') && out.stream !== true) {
    needAggregate = !out.stream;   // 客户端本来要非流式 → 需要聚合
    detach().stream = true;
  }
  return { body: out, needAggregate };
}

/**
 * 从上游的 delta / message 中提取推理（思维链）文本。
 * 2026-09-23（审计 D5 修复）：旧实现只认 `reasoning_content`（DeepSeek 系写法），而 OpenRouter
 * 系（含 Cline）用的是 `reasoning`（字符串或对象）与 `reasoning_details`
 *（`[{type:'reasoning.text',text:'…'}]`）。实测 Cline 的 SSE 分片同时带这两个字段且内容相同，
 * 因此**按优先级取第一个非空者**，不能相加（否则思维链会重复两遍）。
 * 只认一个字段名的后果是思维链被静默丢弃——客户端只看到最终答案，不报错也不告警，最难排查。
 * 返回 '' 表示本次分片不含推理内容。
 */
function reasoningTextOf(src) {
  if (!src || typeof src !== 'object') return '';
  if (typeof src.reasoning_content === 'string' && src.reasoning_content) return src.reasoning_content;
  if (typeof src.reasoning === 'string' && src.reasoning) return src.reasoning;
  if (src.reasoning && typeof src.reasoning === 'object' && !Array.isArray(src.reasoning)) {
    const t = src.reasoning.text !== undefined ? src.reasoning.text : src.reasoning.content;
    if (typeof t === 'string' && t) return t;
  }
  if (Array.isArray(src.reasoning_details)) {
    let out = '';
    for (const d of src.reasoning_details) {
      if (d && typeof d === 'object' && typeof d.text === 'string' && d.text) out += d.text;
    }
    return out;
  }
  return '';
}

/**
 * OpenAI SSE → 单个 chat.completion（聚合）：用于"上游强制流式、而客户端要非流式"的直通路径。
 * 只聚合文本/推理/工具调用分片与 finish_reason/usage，不做协议翻译。
 */
async function aggregateOpenAIStream(upstream, headBytes) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let id = '';
  let model = '';
  let content = '';
  let reasoning = '';
  let finish = null;
  let usage = null;
  const toolCalls = new Map();
  const toolCallState = { last: 0 };   // 第二轮审计修复：缺 index 的分片按"新调用/续片"分流，不再一律落 0
  const feed = (text) => {
    buf += text;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      const m = /^data:\s*(.*)$/.exec(line);
      if (!m) continue;
      const payload = m[1].trim();
      if (payload === '[DONE]') continue;
      let json = null;
      try { json = JSON.parse(payload); } catch { continue; }
      if (json.id) id = json.id;
      if (json.model) model = json.model;
      if (json.usage) usage = json.usage;
      const choice = (Array.isArray(json.choices) ? json.choices[0] : null) || {};
      const d = choice.delta || {};
      if (typeof d.content === 'string') content += d.content;
      reasoning += reasoningTextOf(d);   // D5：兼容 reasoning_content / reasoning / reasoning_details
      for (const call of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const idx = toolCallSlot(call, toolCalls, toolCallState);
        const entry = toolCalls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (call.id) entry.id = call.id;
        if (call.function && call.function.name) entry.function.name = call.function.name;
        if (call.function && call.function.arguments) entry.function.arguments += call.function.arguments;
        toolCalls.set(idx, entry);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  };
  try {
    // 注意：forward() 为识别"首事件即错误"已偷看过首个事件，那些字节必须原样喂回来，否则丢内容
    if (headBytes && headBytes.length) feed(Buffer.from(headBytes).toString('utf8'));
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    log(`上游流聚合失败：${e && e.message}`);
  } finally {
    try { reader.releaseLock(); } catch { /* 忽略 */ }
  }
  const message = { role: 'assistant', content: content === '' && toolCalls.size ? null : content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) message.tool_calls = [...toolCalls.values()].map((t) => ({
    ...t, id: t.id || 'call_' + Math.random().toString(36).slice(2, 10),
  }));
  return {
    id: id || 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish || 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

/** 账户级失败判定（额度耗尽 / 会话失效 / 限流）——决定"换账户"而不是"换供应商" */
// 第三轮审计补强：补上真实中转常见的**词序变体与形态** ——
// 实测事故（2026-09-15）是 b.ai 回 `credit insufficient balance: balance=0`，
// 而原正则只有 `insufficient credit`（词序相反）；另有 `insufficient_balance`、
// `insufficient_user_quota`、`You exceeded your current quota` 等 new-api/one-api 措辞。
const WORKBUDDY_CREDIT_RE = /insufficient credit|credit insufficient|no credit|credit exhausted|credits exhausted|out of credit|quota exceeded|quota exhaust|payment required|credit not enough|not enough credit|insufficient[_ ]?balance|insufficient[_a-z]*quota|exceeded\s+your\s+(?:current\s+)?quota|积分不足|额度不足|余额不足|积分用完|额度用尽|没有积分/i;
const WORKBUDDY_SESSION_RE = /Offline user session not found|12153|session not found|login expired|重新登录/i;
function classifyAccountFailure(status, detail) {
  // 客户端指纹类拒绝**不是账户的问题** → 不能冷却账户（换 Key 一点用都没有），
  // 交给上层按"熔断该供应商"处理（见 failover 里的 CLIENT_FINGERPRINT_RE 分支）。
  // 否则会白白把用户所有可用的 Key 逐把冷却掉，还继续往上打 —— 最坏的画像行为。
  if (CLIENT_FINGERPRINT_RE.test(String(detail || ''))) return null;
  if (status === 402) return 'credit';
  if (WORKBUDDY_CREDIT_RE.test(detail)) return 'credit';
  if (WORKBUDDY_SESSION_RE.test(detail)) return 'session';
  // 2026-09-18（用户要求：**每把 Key 都要轮换，只有全部 Key 都不可用才换下一家**）：
  // 「裸 401/403」= 这把 Key 未授权/被禁用（实测 nvidia 某把 Key：
  //   `403 {"status":403,"title":"Forbidden","detail":"Authorization failed"}`）→ 属**账户级**失败：
  // 标记该 Key（session 冷却）并换下一把；只有所有 Key 都失败才交回上层（下一家供应商）。
  // 旧实现只认 402/429/特定文案，于是这种 403 被当成"供应商级 403" → **整家熔断 30 分钟**，
  // 用户特意配的多把 Key 被连坐（实测 nvidia 4 把 Key 全废）。
  // 例外：内容/敏感词拦截（换 Key 无用，属请求本身的问题）不在此列。
  if ((status === 401 || status === 403) && !CONTENT_BLOCK_RE.test(String(detail || ''))) return 'session';
  if (status === 429) return 'rate';
  return null;
}

/** 每个 provider 的判定原因（日志/错误详情用；只含网关自身的判定码，不含上游内容）。 */
function routeReasonsText(reasons) {
  return reasons.map((r) => `${r.id}=${r.reason}`).join(' ');
}
function routeReasonsDetail(reasons) {
  return reasons.map((r) => `${r.id}: ${r.reason}`);
}

// 404 文案：提示用户检查网关配置里该模型所属供应商的 models 列表（不回显上游内容）
const MODEL_NOT_OFFERED_HINT = '请检查网关配置里该模型所属供应商的 models 列表';

/**
 * 读上游**错误响应体**（带超时，审计修复 P2-3）。
 * 旧版在这里 `await upstream.text()`：错误响应的计时器刚被 clearTimeout，body 又没有任何
 * 中止点——上游返回 429/5xx 响应头后卡住不结束 body（代理卡死/LB 半开）时 forward 永不返回，
 * 客户端**永久挂起**（此时 90s 空闲看门狗尚未创建，也没有兜底）。
 */
async function readTextWithTimeout(resp, ms = 5000, limit = 500) {
  let timer = null;
  try {
    // D11（审计修复）：改为**边读边截断**。旧实现 `resp.text().then(t => t.slice(0, limit))`
    // 是"读完整个响应体再截断"——limit=500 时仍可能先把数十 MB 读进内存（Buffer + String 双份峰值），
    // 调用点之一更是 limit=4MB。触发极简：上游回一个超大 JSON 体即可。现在读满 limit 即停并取消。
    const bodyPromise = (async () => {
      const reader = (resp.body && typeof resp.body.getReader === 'function') ? resp.body.getReader() : null;
      if (!reader) return String(await resp.text()).slice(0, limit);
      const chunks = [];
      let total = 0;
      try {
        while (total < limit) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          chunks.push(buf);
          total += buf.length;
        }
      } finally {
        try { await reader.cancel(); } catch { /* 已读完或已取消 */ }
      }
      return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
    })();
    const timeoutPromise = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    const out = await Promise.race([bodyPromise, timeoutPromise]);
    if (out === null) {                      // 超时：取消 body，避免 socket 悬挂
      try { await resp.body?.cancel(); } catch { /* 忽略 */ }
      return '';
    }
    return out;
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ---------------- 上游客户端仿真（Q1 加固） ----------------
 * 目标：完全仿真 Claude Code / OpenAI SDK 客户端的访问特征，
 * 规避 new-api/one-api 的“unauthorized client detected”客户端白名单检测，
 * 且不向任何上游泄露 dsh/网关自身的请求特征（防指纹封禁）。
 *  - 当 config.clientUA 为空 → 旧行为：透传 dsh 原始标识（K1 防屏蔽）
 *  - 当 config.clientUA 有值 → 完全仿真：丢弃客户端透传头，仅发固定仿真头集
 */

/* ------------------------------------------------------------------ *
 * 客户端仿真：版本号与 SDK 指纹
 *
 * 设计原则（来自 2026-09-30 的专项审计，依据是官方 SDK/CLI 的**一手源码**）：
 *   ① **自洽优先于"最新"**。UA 里的版本、`x-stainless-*` 里的 OS/arch/runtime、
 *      平台头之间必须互相说得通。宁可整体偏旧，也不要只把某一项改新——
 *      不自洽的组合比固定值更容易被一眼识破（"随机 UA 轮换"同理，故不做）。
 *   ② **版本号必须能不改代码就更新**。上游会做最低版本门禁（实测 cline#13128：
 *      "If you are using an old version of Cline, please update to the latest version"），
 *      写死的版本号过几个月就会开始被拒。故一律走 env / 配置覆盖。
 *   ③ 判据是**真实客户端到底发什么**，不是"看起来像"。
 * ------------------------------------------------------------------ */

/** 统一的版本/身份覆盖入口：env > 配置 > 内置默认值。 */
function clientIdentityOverrides(cfg) {
  const c = (cfg && cfg.clientVersions) || {};
  const pick = (envKey, cfgKey, def) => {
    const e = process.env[envKey];
    if (e && String(e).trim()) return String(e).trim();
    const v = c[cfgKey];
    if (v != null && String(v).trim()) return String(v).trim();
    return def;
  };
  return {
    claudeCli: pick('DSH_GATEWAY_CC_VERSION', 'claudeCli', '2.1.270'),
    claudeEntrypoint: pick('DSH_GATEWAY_CC_ENTRYPOINT', 'claudeEntrypoint', 'sdk-cli'),
    stainlessPkg: pick('DSH_GATEWAY_STAINLESS_VERSION', 'stainlessPkg', '0.112.1'),
    codex: pick('DSH_GATEWAY_CODEX_VERSION', 'codex', '0.159.1'),
    codexOriginator: pick('DSH_GATEWAY_CODEX_ORIGINATOR', 'codexOriginator', 'codex_cli_rs'),
    cline: pick('DSH_GATEWAY_CLINE_VERSION', 'cline', '3.0.65'),
    clineCore: pick('DSH_GATEWAY_CLINE_CORE_VERSION', 'clineCore', '0.0.87'),
  };
}

/** os.release() 的安全包装（拿不到就返回空串，调用方会退回 'unknown'）。 */
function osRelease() {
  try { return os.release(); } catch { return ''; }
}

/** 当前进程运行平台的规范名（与 @anthropic-ai/sdk 的 detect-platform 同口径）。 */
function platformInfo() {
  const p = process.platform;
  const osName = p === 'win32' ? 'Windows' : p === 'darwin' ? 'MacOS' : p === 'linux' ? 'Linux' : p;
  const arch = process.arch === 'x64' ? 'x64'
    : process.arch === 'arm64' ? 'arm64'
      : process.arch === 'ia32' ? 'x32' : process.arch;
  return { osName, arch };
}

/**
 * `@anthropic-ai/sdk` 的 `buildHeaders()` **必发**的 SDK 指纹头。
 *
 * 实测依据：`@anthropic-ai/sdk` 编译产物 `client.js` 的 `buildHeaders([...])` 第一层就是
 * `Accept` / `User-Agent` / `X-Stainless-Retry-Count` / `X-Stainless-Timeout` /
 * `getPlatformHeaders()` / `anthropic-version`。也就是说**任何**真实的 Anthropic SDK 客户端
 * （Claude Code 就是用它调的）都会带这六个平台头。
 * 旧实现一个都没有 —— 只发 UA + accept 的"Anthropic 客户端"是不存在的。
 *
 * 值必须与运行环境自洽：OS/arch/runtime/版本都取自当前进程。
 */
function stainlessHeaders(cfg, retryCount) {
  const { osName, arch } = platformInfo();
  const id = clientIdentityOverrides(cfg);
  return {
    'x-stainless-lang': 'js',
    'x-stainless-package-version': id.stainlessPkg,
    'x-stainless-os': osName,
    'x-stainless-arch': arch,
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-retry-count': String(retryCount || 0),
    'x-stainless-timeout': '600',
  };
}

/**
 * Claude Code 的 `anthropic-beta` flag 全集。
 *
 * 依据：对真实 Claude Code 2.1.270 的抓包逐字节比对（见审计报告引用的 pi-cc-compat）。
 * 风险提示：极少数中转会对**未知 beta flag** 直接 400，所以这一项做成可关
 * （`clientVersions.claudeBeta: false` 或 env `DSH_GATEWAY_CC_BETA=0`）——
 * 逐个 flag 试错比无条件硬编码全集安全。
 */
const CC_BETA_FLAGS = [
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advisor-tool-2026-03-01',
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
].join(',');

/**
 * Claude Code 风格请求头。
 *
 * 历史沿革：最早只有 `user-agent: claude-cli/2.0.0 (external, cli)` + `accept`——那是按
 * agentrouter(new-api) 的**UA 白名单**实测收敛出来的最小集，对"只认 UA"的中转够用。
 * 但对做**客户端指纹**校验的站（会看 SDK 指纹头、beta flag、入口点语义）就不够了，
 * 所以补成真实 Claude Code 的头集。
 *
 * 注意 `(external, sdk-cli)` 里的入口点语义：官方 issue 明确区分 `cli`（交互式终端）
 * 与 `sdk-cli`（通过 Agent SDK 调用），旧实现写的 `cli` 对不上"程序化调用"这个事实。
 */
function claudeClientHeaders(cfg) {
  const id = clientIdentityOverrides(cfg);
  const h = {
    accept: 'application/json',
    'user-agent': `claude-cli/${id.claudeCli} (external, ${id.claudeEntrypoint})`,
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
  };
  Object.assign(h, stainlessHeaders(cfg, 0));
  // beta flag 可关：某些中转对未知 flag 直接 400
  const betaOff = String(process.env.DSH_GATEWAY_CC_BETA || '') === '0'
    || (cfg && cfg.clientVersions && cfg.clientVersions.claudeBeta === false);
  if (!betaOff) h['anthropic-beta'] = CC_BETA_FLAGS;
  return h;
}

/* ---------------- OpenCode 免费车道：客户端身份仿真（2026-10-08） ----------------
 * 依据：dsh-our-free-model 的 src/upstream.js —— 它把每条都对着活网关直接请求核对过
 *（2026-09-24）：公共池凭据、指纹头、按模型的端点分流、免费档的工具指纹门（缺了 403
 * FreeTierError）、**按会话计费**（每请求新铸一个 session 就直接 429 FreeUsageLimitError）、
 * 以及地区门（403 RegionError）。
 *
 * 三条硬性要求：
 *   ① `authorization: Bearer public` —— 公共池凭据，不是用户自己的 key；
 *   ② UA 版本 ≥ 1.17，否则被网关的版本门拒掉；
 *   ③ `x-opencode-session` **同一对话必须稳定**，`x-opencode-request` 每轮一个。
 *
 * ⚠ 这说明白了一件事：这条车道的本质是**让上游把本网关的流量认成官方客户端**，
 *    用的是它给自家用户的公共额度。所以它只作为**用户手动添加的预设**存在，
 *    默认不添加、界面上带风险说明（见 renderer/js/providers.js 的预设区）。
 *    该上游在模型卡里声明 prompt 可能被记录 —— 别拿它跑敏感内容。
 */
const OPENCODE_DEFAULT_VERSION = '1.18.31';   // 上游要求 ≥ 1.17

/** 版本号可覆盖（走 clientVersions / env，与 cline/codex 同套路，不写死）。 */
function opencodeVersion(cfg) {
  const id = clientIdentityOverrides(cfg);
  const v = String((id && id.opencode) || process.env.DSH_GATEWAY_OPENCODE_VERSION || OPENCODE_DEFAULT_VERSION).trim();
  return /^\d+\.\d+/.test(v) ? v : OPENCODE_DEFAULT_VERSION;
}

/** 静态头部分（动态的 session/request id 在 forward 里按对话内容补，见 opencodeSessionId）。 */
function opencodeClientHeaders(cfg) {
  return {
    'user-agent': `opencode/${opencodeVersion(cfg)}`,
    'x-opencode-client': 'desktop',
    'x-opencode-project': 'global',
    accept: 'application/json, text/event-stream',
  };
}

/** 每轮一个请求 id。 */
function opencodeRequestId() {
  return 'msg_' + sha16(Date.now() + '\u0000' + Math.random());
}

/**
 * 把 OpenCode 车道的**动态头**补到一组上游请求头上（幂等）。
 *
 * ⚠⚠ 必须**两条转发路径都调**，否则会出现"有的模型能用、有的 400"这种极难查的现象：
 *   · `forward()`                        —— OpenAI 入口、以及 Anthropic 直通（provider 未声明 protocol）
 *   · `forwardAnthropicViaOpenAI()`       —— Anthropic→OpenAI 翻译路径（provider 声明了 openai-chat）
 * 实测踩到：只在 `forward()` 里加，于是 `opencode-go`（声明了 openai-chat、走翻译路径）
 * 的 29 个模型全部 400 `MissingSessionID`，而 `opencode-go-claude`（走直通）正常 —— 一样是上游，
 * 一半能跑一半不能，日志里只看得到"上游 400"。
 *
 * 幂等：会话 id 由内容确定，重复调用结果相同；已存在时不覆盖，避免把已发出的请求 id 换掉。
 * @returns {boolean} 本次是否真的写入了头
 */
function applyOpencodeLaneHeaders(headers, body, providerId) {
  if (!headers || !headers['x-opencode-client']) return false;
  if (headers['x-opencode-session']) return false;   // 两条路径都经过时只加一次
  headers['x-opencode-session'] = opencodeSessionId(body, providerId);
  headers['x-opencode-request'] = opencodeRequestId();
  return true;
}

/**
 * 免费档的**工具指纹门**：body.tools 里必须出现全小写的 bash/glob/grep/read，
 * 否则上游 403 FreeTierError。
 *
 * ⚠ 与 dsh-our-free-model 的做法**有意不同**：它在 DSH 进程内、知道该拿哪个真实工具去顶替，
 * 所以能把 pwsh"提拔"进 bash 槽位（它实测过 —— 纯占位的假工具会被模型调用 24 次，每次都失败）。
 * 网关是纯转发方，**无从知道客户端有什么工具**，因此只做"缺哪个补哪个"的占位声明，
 * 并把补进去的名字记进日志，让用户能看出哪些调用可能不是自己声明的工具。
 *
 * ⚠⚠ `style` 必须传对：**三种协议的 tools 形状完全不同**，补错形状比不补更糟 ——
 * Anthropic 要 `{name, description, input_schema}`，OpenAI/Responses 要
 * `{type:'function', function:{name, description, parameters}}`。
 * 实测踩到：不分形状地往 Anthropic 的 tools 里推 OpenAI 形状，上游直接 400
 *（`out/_fpbug.cjs` 复现：tools 里 5 条，4 条是 OpenAI 形状）。
 *
 * @param {object} body 请求体（**不改原对象**）
 * @param {'chat'|'messages'|'responses'} style 该请求当前所处的线协议形状
 * @returns {{body:object, added:string[]}|null} 无需补齐时返回 null。
 */
const OPENCODE_FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read'];

function ensureFingerprintTools(body, style) {
  if (!body || typeof body !== 'object') return null;
  const anthropicShape = style === 'messages';
  // ⚠ Responses 的 tools 是**扁平**的 `{type, name, description, parameters}`，
  // 与 chat 的嵌套 `{type, function:{…}}` 不同。实测踩到：按 chat 形状往 Responses 体里推，
  // 上游直接 422/400（同一个形状错误在本项目里已经犯过三次：Anthropic 一次、Responses 一次）。
  const flatShape = style === 'responses';
  const list = Array.isArray(body.tools) ? body.tools.slice() : [];
  const have = new Set();
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    // 三种形状都要能读出名字：Anthropic 是 t.name；chat 是 t.function.name；Responses 也是 t.name
    const n = typeof t.name === 'string' ? t.name
      : (t.function && typeof t.function.name === 'string' ? t.function.name : '');
    if (n) have.add(n.trim().toLowerCase());
  }
  // 大小写变体不算数：上游把 Bash + bash 当成重复项直接拒
  const added = [];
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (have.has(name)) continue;
    const desc = 'Declared for client fingerprint compatibility. '
      + name + ' is not provided by this gateway.';
    if (anthropicShape) {
      list.push({ name, description: desc, input_schema: { type: 'object', properties: {} } });
    } else if (flatShape) {
      list.push({ type: 'function', name, description: desc, parameters: { type: 'object', properties: {} } });
    } else {
      list.push({ type: 'function', function: { name, description: desc, parameters: { type: 'object', properties: {}, additionalProperties: true } } });
    }
    added.push(name);
  }
  if (added.length === 0) return null;
  return { body: { ...body, tools: list }, added };
}

/**
 * Cline 完全仿真。
 *
 * 上游 api.cline.bot 只对"Cline 产品面"开放：**完全裸头**会被拒
 *   403 {"code":"API_REQUEST_ERROR_CODE","message":"Error 403: <model> is only available via Cline product surfaces…"}
 * 实测最小充分集是单个 `X-CLIENT-TYPE: cline-sdk`（仅它即可 200）；UA 内容不校验但**存在性必需**。
 *
 * ⚠ 但"能过 403"不等于"能调新模型"：服务端另有一道**最低版本门禁**
 * （cline#13128：`If you are using an old version of Cline, please update to the latest version`）。
 * 所以版本号必须能随 Cline 发布更新 —— 走 `clientVersions` / env，不再写死。
 *
 * 真实头集对照 `cline/cline` 的 `sdk/packages/llms/src/providers/request-headers.ts`：
 * 那里还有一个 `X-Task-ID`（= 会话 id）。缺它不会 403，但补上更自洽；
 * 同一会话内必须**保持稳定**，每请求换一个反而是"会话抖动"特征。
 */
function clineClientHeaders(cfg, sessionId) {
  const id = clientIdentityOverrides(cfg);
  const h = {
    'user-agent': `Cline/${id.cline}`,
    'http-referer': 'https://cline.bot',
    'x-title': 'Cline',
    'x-is-multiroot': 'false',
    'x-client-type': 'cline-sdk',
    'x-client-version': id.cline,
    'x-platform': 'terminal',
    'x-platform-version': id.cline,
    'x-core-version': id.clineCore,
    accept: 'application/json',
  };
  if (sessionId) h['x-task-id'] = String(sessionId);
  return h;
}

/**
 * Codex CLI 完全仿真。
 *
 * 旧实现是 `codex/0.49.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 … Chrome/126… Safari/537.36`
 * —— 把 Codex 前缀硬粘在一条 **Chrome 的浏览器 UA** 上。Codex CLI 是 **Rust** 程序，
 * 它的 UA 里**不可能**出现 `AppleWebKit`/`Chrome`/`Safari`；这是最容易被一眼识破的自相矛盾。
 *
 * 真实形态（一手依据：`openai/codex` 的 `codex-rs/login/src/auth/default_client.rs`）：
 *   UA = `${originator}/${version} (${os_type} ${os_version}; ${arch}) ${terminal_ua}`
 * 且 **`originator` 是一个独立的一等身份头**，服务端对它做白名单：
 *   `codex_cli_rs` | `codex-tui` | `codex_vscode` | 以 `Codex ` 开头。
 * 旧实现完全没有这个头。
 *
 * 刻意**不**加 `ChatGPT-Account-ID`：它的值要从真实 OAuth token 的 JWT 里推，
 * 编一个假的比不发更像机器人。
 */
function codexClientHeaders(cfg) {
  const id = clientIdentityOverrides(cfg);
  const { osName, arch } = platformInfo();
  // 真实客户端这两段来自 Rust 的 os_info（如 "Windows 11" / "MacOS 15.3.1"）；
  // 取不到精确值时用 os.release() 的段数兜底，保证形态正确。
  const rel = String(osRelease() || '').split('.').filter(Boolean);
  const osVer = (process.platform === 'win32' ? rel.slice(0, 2) : rel.slice(0, 3)).join('.') || 'unknown';
  const osTag = osName === 'MacOS' ? 'MacOS' : osName;
  return {
    originator: id.codexOriginator,
    'user-agent': `${id.codexOriginator}/${id.codex} (${osTag} ${osVer}; ${arch})`,
    accept: 'application/json',
  };
}

/**
 * 该供应商实际应使用的客户端仿真档（2026-09-23，需求："cline 调用时默认使用 cline 客户端仿真"）。
 *  ① 供应商显式声明 `clientProfile` → 用它（可逐家覆盖，如同时接 Cline 与 new-api）；
 *  ② 否则按 baseURL 主机推断：*.cline.bot 只认 Cline 产品面，自动套用 cline 仿真，
 *     用户无需在每家的 headers 里手抄那 9 个头；
 *  ③ 都没有 → 返回 ''（由调用方回落到全局 cfg.clientProfile，保持既有行为不变）。
 * 刻意不改全局 clientProfile 的语义：它是**下行协议**与**上行仿真**的双重开关
 *（见 writeDshConfig），全局改成 cline 会连带把 dsh 的 api 改成 openai-completions。
 */
function providerClientProfile(provider) {
  const declared = String((provider && provider.clientProfile) || '').trim().toLowerCase();
  if (declared) return declared;
  try {
    const host = new URL(String((provider && provider.baseURL) || '')).hostname.toLowerCase();
    if (host === 'api.cline.bot' || host.endsWith('.cline.bot')) return 'cline';
  } catch { /* baseURL 非法：不推断 */ }
  return '';
}

/** 构造发往上游的最终请求头。
 * clientProfile='cline'  → Cline 完全仿真（api.cline.bot 的硬性要求）
 * clientProfile='codex' → Codex 完全仿真（不留任何客户端透传痕迹）
 * clientProfile='claude' 或仅 clientUA → Claude Code 完全仿真（UA 可被 clientUA 覆盖）
 * 两者皆空             → 透传 dsh 客户端标识（K1 防屏蔽）
 * anthropic=true    → Anthropic 协议模式（T5）：x-api-key 替代 Bearer + anthropic-version
 */
function upstreamRequestHeaders(reqHeaders, apiKey, clientUA, anthropic, clientProfile, cfg) {
  const out = {};
  const skip = new Set([
    'authorization', 'host', 'content-length', 'connection',
    'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade',
    'te', 'trailer', 'content-type', 'accept', 'accept-encoding',
    'x-api-key', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
    'cookie', 'origin', 'referer',
  ]);

  // Cline 的 `x-task-id` 用客户端的会话 id（有就带、没有就不带）。
  // 取的是**入站请求里本来就有**的会话标识，同一会话内保持稳定 —— 每请求换一个反而是
  // "会话抖动"特征。注意大小写不敏感。
  const sessionId = clientProfile === 'cline' ? pickHeaderCI(reqHeaders, 'x-session-id') || '' : '';

  if (clientProfile === 'cline') {
    // Cline 完全仿真：不透传任何 dsh 头；clientUA 仍允许覆盖具体 UA 值
    Object.assign(out, clineClientHeaders(cfg, sessionId));
    if (clientUA) out['user-agent'] = clientUA;
  } else if (clientProfile === 'codex') {
    // Codex 完全仿真：不透传任何 dsh 头
    Object.assign(out, codexClientHeaders(cfg));
    if (clientUA) out['user-agent'] = clientUA;
  } else if (clientProfile === 'opencode') {
    // OpenCode 免费车道：完全仿真官方桌面客户端。
    // 动态的 session/request id 不在这里给（这里拿不到 body）—— 由 forward 按对话内容补。
    Object.assign(out, opencodeClientHeaders(cfg));
    if (clientUA) out['user-agent'] = clientUA;
  } else if (clientProfile === 'claude' || (!clientProfile && clientUA)) {
    // Claude Code 完全仿真（兼容旧配置：仅 clientUA 时按 Claude 仿真）
    Object.assign(out, claudeClientHeaders(cfg));
    if (clientUA) out['user-agent'] = clientUA;
  } else {
    // 透传模式：保留 dsh 客户端标识
    for (const [k, v] of Object.entries(reqHeaders || {})) {
      const lk = k.toLowerCase();
      if (skip.has(lk)) continue;
      if (lk.startsWith('sec-') || lk.startsWith('proxy-') || lk.startsWith('cf-')) continue;
      out[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
  }

  if (anthropic) {
    // T5：Anthropic 协议（Claude Code 等）—— x-api-key + anthropic-version
    out['x-api-key'] = apiKey;
    out['anthropic-version'] = out['anthropic-version'] || '2023-06-01';
    delete out['authorization'];
  } else {
    out['authorization'] = `Bearer ${apiKey}`;
  }
  // accept 只在仿真档没给的时候兜底：真实 Claude Code 发 `application/json`，
  // 而旧实现无条件覆盖成 `application/json, text/event-stream` —— 又一个对不上的地方。
  if (!out['accept']) out['accept'] = 'application/json, text/event-stream';
  out['content-type'] = 'application/json';

  // ---- 非头部指纹（2026-09-30 审计）----------------------------------------
  //
  // K7 的 `accept-encoding: identity`：真实客户端发的是 `gzip, deflate, br, zstd`，
  // `identity` 是极少数客户端才会有的值。但它当初是为了治 SSE 乱码，所以做成**可回退**：
  // 仿真档默认发真实值（Node 的 fetch/undici 会自动解压，SSE 解析拿到的是解压后的流），
  // 一旦上游出现编码相关的异常，可用 `DSH_GATEWAY_ENCODING=identity` 或
  // `cfg.upstreamAcceptEncoding` 立刻退回。
  const realistic = !(cfg && cfg.upstreamAcceptEncoding)
    ? (process.env.DSH_GATEWAY_ENCODING || 'gzip, deflate, br, zstd')
    : String(cfg.upstreamAcceptEncoding);
  out['accept-encoding'] = realistic;

  // R16 的 `Connection: close`：治的是"undici 连接池里的死连接被复用 → 网关假死"。
  // 代价是 TLS 会话复用归零（每次全新握手），而这本身是连接层特征。
  // 可靠性优先，故**默认保留**；`cfg.upstreamKeepAlive=true` 可关掉它（适用于不用
  // 不稳定代理、更在意指纹一致性的用户）。这一项无法两全，把选择权交给用户。
  if (cfg && cfg.upstreamKeepAlive === true) delete out['connection'];
  else out['connection'] = 'close';
  return out;
}

/**
 * 防屏蔽透传（K1，兼容保留）：保留 dsh 客户端的原始请求标识（尤其是 User-Agent，
 * dsh 的 attribution 机制强制带 `deepseek-harness/<版本> (+url)`），
 * 仅替换鉴权头与必要的协议头，其余原样转发——让上游看到的就是"dsh 直连"。
 * 扩展（P3/Q1）：配置了 clientUA 时完全仿真 Claude Code，不透传任何 dsh 特征。
 */
function passthroughHeaders(reqHeaders, apiKey, clientUA, clientProfile, cfg) {
  return upstreamRequestHeaders(reqHeaders, apiKey, clientUA, false, clientProfile, cfg);
}

/** 逐家仿真档优先于全局档（providerClientProfile 为空时回落 cfg.clientProfile，行为不变）。 */
function effectiveClientProfile(cfg, provider) {
  return providerClientProfile(provider) || String((cfg && cfg.clientProfile) || '').trim();
}

/** 请求体统一翻译（R5）：转发前修正各上游不兼容字段。
 * 1) role 兼容：dsh 新版可能发送 `developer` 角色（OpenAI 协议演进），但许多上游
 *    （sensenova 等）只接受 system/assistant/user/tool → developer 合并为 system。
 * 2) 推理档位翻译：见 translateReasoningBody（reasoningEffortMap）。
 * 3) 密钥脱敏（R9）：会话历史常含真实 token（github_pat_/sk- 等样式），上游 new-api
 *    平台会以"防密钥泄露"内容过滤拦截整个请求（sensitive words / content-blocked），
 *    且真实 key 也不应发给第三方模型。转发前把这类串打码（保留前缀+长度标记+尾 4 位），
 *    语义基本无损，绕开平台误拦，同时保护密钥不外泄。
 * @returns 翻译后的 body（无变化时返回原对象）
 */

// R9：识别并打码真实 token 样式串 + 超长技术串（仅处理消息文本内容，不动 tool_calls 参数）
// 背景（dump 实证）：上游 new-api 的"疑似密钥"过滤会拦截 ≥32 位连续字母数字/横线串——
// 包括 sha256 校验和、长英文 slug、带日期的文件名等无害技术串；打码为占位符（保留长度
// 与类型提示）后语义基本无损，且不再触发平台防泄露拦截。
function maskSecretTokens(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // GitHub PAT（43+ 位，形如 github_pat_11AA...）
    .replace(/(github_pat_[A-Za-z0-9_]{20,})/g, (m) => 'github_pat_***' + m.slice(-4))
    // GitHub classic token（ghp_gho_ghu_ghs_ghr_ + 36）
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{30,})/g, (m) => m.slice(0, 4) + '***' + m.slice(-4))
    // OpenAI 风格密钥 sk-（≥16 位值）
    .replace(/\b(sk-[A-Za-z0-9]{16,})/g, (m) => 'sk-***' + m.slice(-4))
    // Anthropic 风格密钥 sk-ant-...
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{20,})/g, (m) => 'sk-ant-***' + m.slice(-4))
    // R9b：≥32 位连续 [字母数字_-] 的"疑似密钥样式长串"→ 占位符（保留长度；64 位纯 hex
    // 标记为 sha256，含横线的长 slug 标记为 slug）。URL 协议头不受影响（含 :// 不匹配）。
    .replace(/[A-Za-z0-9_-]{32,}/g, (m) => {
      if (/^[0-9a-f]{32,}$/i.test(m)) return '[sha256:' + m.length + ']';
      if (m.includes('-')) return '[slug:' + m.length + ']';
      return '[token:' + m.length + ']';
    });
}

function translateBody(body, provider) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let out = translateReasoningBody(body, provider);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  let changed = false;
  if (Array.isArray(out.messages)) {
    const msgs = out.messages.map((m) => {
      if (!m) return m;
      let n = m;
      if (n.role === 'developer') { n = { ...n, role: 'system' }; changed = true; }
      // 文本内容打码（跳过 tool_calls 参数与 tool 结果中的结构化值）
      // D9：旧实现只处理**字符串** content，而块数组（[{type:'text',text}]）完全不处理 ——
      // 同一份会话内容走 /v1/chat/completions（块格式）时不打码、走 /v1/messages 时打码，
      // 等于防泄露过滤在一个入口失效。与 handleMessages / translateResponsesBody 对齐。
      if (typeof n.content === 'string') {
        const masked = maskSecretTokens(n.content);
        if (masked !== n.content) { n = { ...n, content: masked }; changed = true; }
      } else if (Array.isArray(n.content)) {
        let blocksChanged = false;
        const blocks = n.content.map((b) => {
          if (b && typeof b === 'object' && typeof b.text === 'string') {
            const masked = maskSecretTokens(b.text);
            if (masked !== b.text) { blocksChanged = true; return { ...b, text: masked }; }
          }
          return b;
        });
        if (blocksChanged) { n = { ...n, content: blocks }; changed = true; }
      }
      return n;
    });
    if (changed) out = { ...out, messages: msgs };
  }
  return out;
}

/* ---------------- OpenAI Responses 协议（POST /v1/responses）请求体处理 ----------------
 * Responses 与 chat/completions 是同一家上游的两种协议，字段结构不同：
 *   messages[]（chat）        → input（字符串 / item 数组）+ instructions（系统提示）
 *   reasoning_effort/thinking → reasoning.effort
 * 因此 chat 路径的 translateBody / desensitizeBodyMessages **在 Responses 上完全不生效**
 *（它们只认 body.messages）——密钥打码、role 兼容、推理档位翻译在 Responses 路径等于全缺失。
 * 这里补齐同一套语义（与 chat 路径共用 reasoningEffortMap 和 maskSecretTokens，
 * 保证两种协议的网关行为一致）。
 * @returns 翻译后的 body（无变化时返回原对象）
 */
function translateResponsesBody(body, provider) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let out = body;
  const detach = () => { if (out === body) out = { ...body }; return out; };

  // 1) 推理档位（R4）：Responses 只认 reasoning.effort 字符串。
  //    对象形态映射（chat 用 { thinking: 'disabled'|'enabled' }）在 Responses 里的等价物是
  //    "有没有 reasoning 字段"：disabled → 整段移除；enabled → 保留原档位。
  //    字符串形态中的 off 语义（off/none/disabled）同样按"移除 reasoning"处理：
  //    Responses 协议没有"关闭"枚举值（官方就是靠不发该字段来关闭），照抄 chat 的
  //    `effort: "disabled"` 会被严格校验的上游直接 400；其余档位照抄映射值。
  const map = provider && provider.reasoningEffortMap && typeof provider.reasoningEffortMap === 'object'
    ? provider.reasoningEffortMap : null;
  const r = body.reasoning;
  const OFF_LIKE_RE = /^(off|none|disabled|false)$/i;
  if (map && r && typeof r === 'object' && !Array.isArray(r) && typeof r.effort === 'string') {
    const want = r.effort;
    const mapped = map[want];
    if (typeof mapped === 'string') {
      if (OFF_LIKE_RE.test(mapped) || OFF_LIKE_RE.test(want)) delete detach().reasoning;
      else if (mapped !== want) detach().reasoning = { ...r, effort: mapped };
    } else if (mapped && typeof mapped === 'object') {
      if (typeof mapped.effort === 'string') {
        if (OFF_LIKE_RE.test(mapped.effort)) delete detach().reasoning;
        else if (mapped.effort !== want) detach().reasoning = { ...r, effort: mapped.effort };
      } else if (mapped.thinking === 'disabled') {
        // 关闭推理：上游收到未知的 thinking 字段会 400，直接不发 reasoning
        delete detach().reasoning;
      }
    }
  }

  // 2) 打码（R9）：instructions（等价 chat 的 system 消息）与 input（等价 messages）
  if (typeof out.instructions === 'string') {
    const m = maskSecretTokens(out.instructions);
    if (m !== out.instructions) detach().instructions = m;
  }
  if (typeof out.input === 'string') {
    const m = maskSecretTokens(out.input);
    if (m !== out.input) detach().input = m;
  } else if (Array.isArray(out.input)) {
    const items = maskResponsesItems(out.input);
    if (items) detach().input = items;
  }
  return out;
}

/** Responses input item 数组：developer→system（R5 role 兼容）+ 文本打码（R9）。
 * 覆盖 { role, content: '…' }、{ role, content: [{ type:'input_text', text }] }、
 * { type:'function_call_output', output }（等价 chat 的 tool 消息 = 长串重灾区）。
 * @returns 新数组；无改动返回 null */
function maskResponsesItems(items) {
  let changed = false;
  const next = items.map((it) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
    let n = it;
    const detach = () => { if (n === it) { n = { ...it }; changed = true; } return n; };
    if (n.role === 'developer' && (!n.type || n.type === 'message')) detach().role = 'system';
    if (typeof n.content === 'string') {
      const m = maskSecretTokens(n.content);
      if (m !== n.content) detach().content = m;
    } else if (Array.isArray(n.content)) {
      const parts = n.content.map((pt) => {
        if (pt && typeof pt === 'object' && !Array.isArray(pt) && typeof pt.text === 'string') {
          const m = maskSecretTokens(pt.text);
          if (m !== pt.text) { changed = true; return { ...pt, text: m }; }
        }
        return pt;
      });
      if (parts.some((pt, i) => pt !== n.content[i])) detach().content = parts;
    }
    if (typeof n.output === 'string') {
      const m = maskSecretTokens(n.output);
      if (m !== n.output) detach().output = m;
    }
    return n;
  });
  return changed ? next : null;
}

/** 推理档位统一翻译（R4 新）：把 dsh 发来的统一推理档位，翻译成各上游自己的词汇。
 * 背景：上游 deepseek-v4-flash 的推理字段词汇各不相同——
 *   sensenova 接受 reasoning_effort: low|medium|high|xhigh|none（拒绝 max）；
 *   new-api(agentrouter/air-outer) 接受 low/high/max；
 * dsh 官方按 off/low/high/max 发统一档位。网关在 provider 配置可选字段
 * `reasoningEffortMap`（如 {"low":"low","medium":"medium","high":"high","max":"xhigh","off":"none"}）
 * 缺省时恒等透传（与桌面助手行为一致，不破坏旧配置）。
 * @returns 翻译后的 body（无变化时返回原对象）
 */
function translateReasoningBody(body, provider) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const map = provider && provider.reasoningEffortMap && typeof provider.reasoningEffortMap === 'object'
    ? provider.reasoningEffortMap : null;
  if (!map) return body;                      // 无映射配置：原样透传

  const out = { ...body };
  const effort = body.reasoning_effort;
  const thinking = body.thinking;
  // 当前请求的推理意图：off / 具体档位 / 未指定
  let want = null;                            // null=未指定
  if (thinking && typeof thinking === 'object' && thinking.type === 'disabled') want = 'off';
  else if (typeof effort === 'string') want = effort;

  if (want === null) return out;              // 未指定推理 → 不加戏
  const mapped = map[want];
  if (mapped === undefined) return out;       // 档位不在映射表 → 原样（宁可不改，不丢档）

  // 依据映射表值形态决定发送方式：
  //   - 字符串 → reasoning_effort=<值>（同时清理 thinking 或保留语义由值决定）
  //   - 对象 { thinking: 'disabled'|'enabled' } → 仅 thinking.type
  delete out.reasoning_effort;
  delete out.thinking;
  if (typeof mapped === 'object' && mapped !== null) {
    if (mapped.thinking === 'disabled') out.thinking = { type: 'disabled' };
    else if (mapped.thinking === 'enabled') out.thinking = { type: 'enabled' };
    if (typeof mapped.effort === 'string') out.reasoning_effort = mapped.effort;
  } else if (typeof mapped === 'string') {
    if (mapped === 'disabled' || mapped === 'off' || mapped === 'none') {
      // off 语义：sensenova 用 reasoning_effort: none；deepseek 系用 thinking disabled——
      // 字符串 none/off/disabled 直接作为 reasoning_effort 值发送（sensenova 认 none，
      // 若上游只认 thinking.type 的，可改用对象映射）
      out.reasoning_effort = mapped;
    } else {
      out.reasoning_effort = mapped;
      out.thinking = { type: 'enabled' };     // 开启推理（deepseek 系惯例）
    }
  }
  return out;
}

// R9c：长串降敏——把文本中 ≥32 位连续 [字母数字_-] 的"疑似密钥样式长串"替换为
// 类型占位符（[sha256:64] / [slug:45] / [token:34]），语义基本无损（模型不需要读
// hash 全文），绕开 new-api 平台的"疑似密钥泄露"内容过滤（sensitive words / content-blocked）。
function desensitizeLongTokens(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/[A-Za-z0-9_-]{32,}/g, (m) => {
    if (/^[0-9a-f]{32,}$/i.test(m)) return '[sha256:' + m.length + ']';
    if (m.includes('-')) return '[slug:' + m.length + ']';
    return '[token:' + m.length + ']';
  });
}

// 对消息体做深度降敏（messages 的字符串 content；tool 消息内容也降敏——历史工具
// 结果正是长串重灾区；tool_calls 参数不动，避免破坏工具调用的 JSON）
// R14：兼容 Anthropic blocks 数组（[{type:'text',text:'…'}]）——对 text 块降敏
function desensitizeBodyMessages(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) return body;
  let changed = false;
  const msgs = body.messages.map((m) => {
    if (!m) return m;
    if (typeof m.content === 'string') {
      const d = desensitizeLongTokens(m.content);
      if (d !== m.content) { changed = true; return { ...m, content: d }; }
      return m;
    }
    if (Array.isArray(m.content)) {
      let bc = false;
      const blocks = m.content.map((b) => {
        if (b && b.type === 'text' && typeof b.text === 'string') {
          const d = desensitizeLongTokens(b.text);
          if (d !== b.text) { bc = true; return { ...b, text: d }; }
        }
        return b;
      });
      if (bc) { changed = true; return { ...m, content: blocks }; }
    }
    return m;
  });
  return changed ? { ...body, messages: msgs } : body;
}

// R9c：Responses 协议的降敏重试（对应 desensitizeBodyMessages）——对 instructions / input
// 的文本与文本块降敏；function_call 的 arguments（JSON 结构）不动，避免破坏工具调用。
function desensitizeResponsesBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let out = body;
  const detach = () => { if (out === body) out = { ...body }; return out; };
  if (typeof body.instructions === 'string') {
    const d = desensitizeLongTokens(body.instructions);
    if (d !== body.instructions) detach().instructions = d;
  }
  if (typeof body.input === 'string') {
    const d = desensitizeLongTokens(body.input);
    if (d !== body.input) detach().input = d;
  } else if (Array.isArray(body.input)) {
    let changed = false;
    const next = body.input.map((it) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
      let n = it;
      if (typeof n.content === 'string') {
        const d = desensitizeLongTokens(n.content);
        if (d !== n.content) { n = { ...n, content: d }; changed = true; }
      } else if (Array.isArray(n.content)) {
        const parts = n.content.map((pt) => {
          if (pt && typeof pt === 'object' && !Array.isArray(pt) && typeof pt.text === 'string') {
            const d = desensitizeLongTokens(pt.text);
            if (d !== pt.text) return { ...pt, text: d };
          }
          return pt;
        });
        if (parts.some((pt, i) => pt !== n.content[i])) { n = { ...n, content: parts }; changed = true; }
      }
      if (typeof n.output === 'string') {
        const d = desensitizeLongTokens(n.output);
        if (d !== n.output) { n = { ...n, output: d }; changed = true; }
      }
      return n;
    });
    if (changed) detach().input = next;
  }
  return out;
}

/* ---------------- 上游错误分类（审计修复 P1，本次） ----------------
 * 上游内容拦截（new-api/one-api 的"疑似密钥泄露"过滤）：换一家供应商 + R9c 降敏重试**确实可能成功**，
 * 这是有意保留的 failover 行为。
 */
const CONTENT_BLOCK_RE = /sensitive\s*words|content[-_]blocked|content_blocked/i;

/**
 * 404 的细分特征（审计补充）：只有**明确指向模型**的 404（模型不存在/不支持/无权限）
 * 才算确定性错误、终止 failover；其余 404（路由不存在：某些供应商没有 /responses 之类
 * 的端点，返回通用 Not Found 或空体）仍换下一家——否则"Codex 仿真"用户会被优先级最高
 * 的那家直接打死。判不出来时按"路由不存在"处理（保守，保持旧行为）。
 */
const MODEL_MISSING_RE = /model[^.\n]{0,60}(not\s+found|does\s+not\s+exist|doesn'?t\s+exist|not\s+exist|unsupported|unknown|invalid|no\s+access|permission|不存在|不支持)/i;

/**
 * 404 的第二种细分（2026-09-11 实测补充）：**整条路由都没实现**。
 * 实测证据：new-api / one-api 系上游只实现了 `POST /v1/responses`（生成），对 Responses
 * 资源子路由一律回 `{"error":{"message":"Invalid URL (GET /v1/responses/resp_…)"}}`。
 * 这与"资源确实不存在/已过期"是两件不同的事：前者重试、换供应商、等一会儿都不会好，
 * 是供应商能力缺失。网关据此给出可操作的提示，而不是笼统地说"可能被删了"。
 */
const ROUTE_MISSING_RE = /invalid\s+url|not\s+implemented|unsupported\s+(method|route|endpoint|operation)|no\s+such\s+route|method\s+not\s+allowed|cannot\s+(get|post|delete|put)|unknown\s+(method|endpoint|route)/i;

/** 确定性 4xx → 回给客户端的状态码（只映射到这几个"语义明确且不泄露上游信息"的状态码）。 */
/**
 * 「**这家**没有这个模型」——与"请求本身有错"必须区分开（2026-09-23 实测事故）。
 * 现场：amd 回 400 `Requested model DeepSeek-V4.1-Flash not supported`，旧实现把它当确定性
 * 4xx **终止 failover**，用户直接拿到 400 —— 而同一逻辑模型在 workbuddy/cline 上完全可用。
 * 判据（都取自实测形态，措辞会变，故覆盖多种）：
 *   · "Requested model X not supported"        （amd，400；注意是 not supported 不是 unsupported）
 *   · "Model X is not available" / model_not_found（amd，404）
 *   · "unsupported model" / "model not offered" / "does not offer this model"
 * 只用于**继续 failover**，不用于判定"整个请求无解"。
 */
const MODEL_UNSUPPORTED_BY_PROVIDER_RE = /requested\s+model[^\n]{0,120}?not\s+supported|model[^\n]{0,60}?is\s+not\s+available|model_not_found|unsupported\s+model|model\s+not\s+(?:offered|supported|found)|does\s+not\s+(?:offer|support)[^\n]{0,40}?model|is\s+not\s+available\s+in\s+your\s+(?:region|country|area|location)|not\s+available\s+in\s+your\s+(?:region|country|area|location)|(?:region|country|area)[-_\s]?(?:not\s+supported|restricted|blocked)|not\s+available\s+(?:for|on|in)\s+your\s+(?:plan|tier|subscription|account\s+level)|不提供[^\n]{0,20}?模型|模型[^\n]{0,20}?不支持|(?:地区|区域)[^\n]{0,10}?(?:不支持|不可用|受限)/i;

/**
 * 「**你这个客户端不被允许**」——上游在**客户端指纹**维度拒绝了这次请求。
 *
 * 与普通 401/403 的处置**完全相反**，必须单独识别：
 *   · 普通 403（Key 无效/额度）→ 是**账户**的问题，换一把 Key 有意义；
 *   · 指纹 403 → 换 Key、换账户、重试**全都没用**，而且**继续打只会加剧风控**
 *     （在一个已被判定为"非白名单客户端"的 IP 上反复尝试，是最坏的画像行为）。
 *
 * 实测依据：agentrouter 前置的 Aliyun WAF 在**连接层/TLS 层**做指纹校验 ——
 * 同一把 key：OpenAI SDK → 401 `unauthorized client detected`，Anthropic SDK → 200；
 * 甚至 `AsyncAnthropic` 被拒而同步 httpx 放行（判据就是握手本身）。
 * 本程序跑在 Node 上**无法**伪装 ClientHello（无公开 API，需原生绑定），
 * 所以遇到这类拒绝时的正确动作是：**认出它、立刻长熔断该家、停止无谓的账号消耗**。
 */
const CLIENT_FINGERPRINT_RE = /unauthorized\s+client\s+detected|unauthorized_client_error|only\s+available\s+via[^\n]{0,60}?product\s+surface|client\s+(?:is\s+)?not\s+(?:allowed|permitted|recognized|supported)|invalid\s+client|unsupported\s+client|not\s+a\s+(?:supported|recognized)\s+client|客户端[^\n]{0,10}?(?:未授权|不被允许|不支持)/i;

const DETERMINISTIC_4XX_STATUS = { 400: 400, 404: 404, 413: 413, 422: 422 };

/**
 * 「**上游自己坏了**」但被包在 4xx 里回给我们 —— 与"请求本身有错"处置相反，必须继续 failover。
 *
 * 最典型的是 new-api / one-api 系的 `bad_response_status_code`：字面意思就是
 * "我转发出去的那个上游返回了坏状态码"，属于**供应商侧**故障。
 *
 * 实测（2026-10-08，本机真实配置）：`h-e.top`（priority 1）对 `glm-5.3-flash` 回
 * `{"error":{"message":"openai_error","type":"bad_response_status_code",...}}` 的 400，
 * 而 `opencode-go`（priority 3）明明能服务该模型 —— 旧判据把它当"确定性 4xx"终止了 failover，
 * 用户直接拿到 400，后面能用的家一个都没试。
 *
 * 与 `MODEL_UNSUPPORTED_BY_PROVIDER_RE` 同一类修正：**别把供应商侧问题当成请求侧问题**。
 */
const UPSTREAM_BROKEN_4XX_RE = /bad_response_status_code|bad_response|upstream\s+(?:error|request\s+failed|returned)|invalid\s+response\s+from\s+upstream|上游[^\n]{0,10}?(?:错误|失败|异常)/i;

/**
 * 「供应商侧」4xx（账号/额度/权限/套餐）——**不是**请求本身有错，而是"这家现在不能给你服务"。
 * 实测事故（2026-09-15）：b.ai 余额为 0 时回 HTTP **400** `credit insufficient balance: balance=0`，
 * 旧实现按"确定性 4xx"终止 failover → 用户明明还有可用的 chiyi-ds，却被欠费的那家直接打死
 * （客户端拿到 400「请求本身无效」，误导排查方向）。
 * 语义上它与 401/403 同类：冷却该家 + 计入熔断 + **继续换下一家**。
 * 注意：必须在"内容拦截"判定之后使用，且不能吞掉真正的客户端错误（参数/size/不可处理）。
 */
const PROVIDER_SIDE_4XX_RE = /credit|balance|insufficient|quota|deposit|billing|unpaid|arrears|recharge|top\s*up|account\s+(?:suspended|disabled|locked|deactivated|banned)|no\s+available\s+(?:channel|quota|balance)|exceeded\s+your\s+(?:current\s+)?quota|not\s+available\s+(?:for|on)\s+your\s+(?:plan|account)|欠费|余额|额度|充值|未开通|无可用(?:渠道|额度)/i;
/** 其中"余额/欠费"类属于长期状态（充值前不会自愈）→ 用长熔断，避免反复打点 */
const PERSISTENT_ACCOUNT_RE = /credit|balance|deposit|billing|unpaid|arrears|欠费|余额|充值|budget\s*pool|quota|额度|预算|套餐/i;

/**
 * thinking 回传要求（2026-09-16 实测事故：air-outer / agentrouter）。
 *
 * Claude 的扩展思考语义：请求开了 thinking（或历史里出现过 thinking）时，**带 tool_use 的
 * assistant 轮必须把 thinking 块一起回传**，否则上游回
 *   HTTP 400 {"error":{"message":"The `content[].thinking` in the thinking mode must be
 *   passed back to the API. ..."}}
 * 实测触发条件（见下）与内容无关，**只看结构**：
 *   · assistant 轮里只有 tool_use（或 text+tool_use）→ 400；
 *   · 补一个 thinking 块（哪怕 thinking:'' + signature:''，甚至不带 signature 字段）→ 200。
 * 客户端（pi-ai）在"thinking 无签名"时会把该块降级成普通 text（allowEmptySignature 未开），
 * 于是上游只看到 text+tool_use → 400。两条对应修复：
 *   ① 客户端侧：dsh settings.yaml 的模型加 compat.allowEmptySignature: true（writeDshConfig 写入）；
 *   ② 网关侧：命中该 400 时补空占位 thinking 块重试一次（下面的 withThinkingPlaceholders），
 *      兜住任何未开该开关的客户端。实测 chiyi-ds / amd 等不要求该结构的家接受占位块，无副作用。
 */
const THINKING_PASSBACK_RE = /content\[\]\.thinking|thinking[^.\n]{0,40}must be passed back|thinking mode must be passed back/i;

/**
 * 同一规则的**另一种上游措辞**（2026-09-16 实测补充）：agentrouter 不解释原因，只回
 *   HTTP 500 {"error":{"message":"Upstream rejected the request as invalid","type":"invalid_request_error"}}
 * 实测同一请求体（带 tool_use 的 assistant 轮缺 thinking 块）补空占位后即 200，故该措辞也纳入
 * 补位触发条件。**注意**：该措辞本身很泛，所以只在"确实存在可补位的轮次"
 *（withThinkingPlaceholders 返回非 null）时才真正重试，不会对无关的 500 盲目重发。
 */
const THINKING_REJECTED_GENERIC_RE = /rejected the request as invalid/i;

/**
 * 上游**不支持** extended thinking（与上面"必须回传 thinking"正好相反，2026-09-17 实测）。
 * 形态：客户端按模型声明的推理档位带了顶层 `thinking` 参数，而该家的这个模型不支持：
 *   amd/GLM-5.3-Flash → HTTP 200 + SSE 首事件 error：`"thinking" is not supported for this model.
 *   Remove the "thinking" parameter or use a model that supports extended thinking.`
 * 处理：去掉顶层参数重试一次，并**记住该家**（下次首次就剥掉）；也可显式声明 quirks: ["drop-thinking"]。
 */
const THINKING_UNSUPPORTED_RE = /"thinking"\s+is not supported|thinking\b[^.\n]{0,30}\bnot supported|does not support[^.\n]{0,24}thinking|不支持[^。\n]{0,10}(?:思考|thinking)/i;

/* ==================================================================================
 * 工具调用配对修复（三种协议共用一处）
 *
 * 来源：dsh-our-free-model / dsh-factory-provider 的实战教训（两个项目独立记了同一个坑）：
 *   「缺少对应结果的工具调用在重放时，上游返回 400 invalid_request_error，
 *     此后该会话中的每一次请求都会失败。」
 *
 * 为什么会发生：用户在工具执行到一半时点了「停止」、客户端崩了、或网络断了 ——
 * assistant 轮里已经记下 tool_calls，但对应的 tool_result 从来没写回历史。
 * 这条残缺记录**永久留在会话里**，之后每一轮重放都带着它，于是整条会话报废。
 *
 * 这是网关的天然职责：客户端各修各的，不如在转发前统一修一次；
 * 三种协议（chat / messages / responses）形态不同，但配对语义完全一致。
 * ================================================================================== */

/** 补位用的占位结果：明确说明"结果不可得"，不伪造任何内容。 */
const TOOL_PAIR_PLACEHOLDER = '[tool result unavailable: the call was interrupted before a result was recorded]';

/** 只做配对的**结构性**修复：不编造结果、不改动已有的工具输出。 */

/**
 * chat 协议：`assistant.tool_calls[].id` ↔ 紧邻的 `role:'tool'.tool_call_id`。
 * @returns {{messages:Array, added:number, dropped:number}|null} 无需修复时返回 null。
 */
function repairToolPairingChat(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const out = [];
  let added = 0;
  let dropped = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) { out.push(m); continue; }
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter((c) => c && typeof c === 'object' && c.id) : [];
    if (m.role !== 'assistant' || calls.length === 0) {
      // 孤儿 tool 消息：没有任何 assistant 轮声明过它 → 上游会 400，丢弃
      if (m.role === 'tool') { dropped += 1; continue; }
      out.push(m);
      continue;
    }
    out.push(m);
    // 收集紧跟其后的连续 tool 消息
    const answered = new Set();
    let j = i + 1;
    while (j < messages.length && messages[j] && typeof messages[j] === 'object' && messages[j].role === 'tool') {
      const tid = String(messages[j].tool_call_id ?? '');
      if (tid && !answered.has(tid)) { answered.add(tid); out.push(messages[j]); }
      else dropped += 1;   // 重复应答 / 无 id
      j += 1;
    }
    // 缺结果的补一条占位，保持"每个 tool_call 必有 tool 应答"
    for (const c of calls) {
      const id = String(c.id);
      if (answered.has(id)) continue;
      out.push({ role: 'tool', tool_call_id: id, content: TOOL_PAIR_PLACEHOLDER });
      added += 1;
    }
    i = j - 1;
  }
  if (added === 0 && dropped === 0) return null;
  return { messages: out, added, dropped };
}

/**
 * Anthropic messages 协议：`assistant.content[type=tool_use].id` ↔ 下一条
 * `user.content[type=tool_result].tool_use_id`。
 * content 既可能是字符串也可能是块数组，两种都要处理。
 * @returns {{messages:Array, added:number, dropped:number}|null}
 */
function repairToolPairingAnthropic(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const out = [];
  let added = 0;
  let dropped = 0;
  const declared = new Set();   // 全局已声明的 tool_use id（用于识别孤儿 tool_result）
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) { out.push(m); continue; }
    const blocks = Array.isArray(m.content) ? m.content : null;

    // ① 孤儿 tool_result：tool_use_id 不在任何已声明的集合里 → 剔除该块
    if (blocks && m.role === 'user') {
      const kept = [];
      let removedHere = 0;
      for (const b of blocks) {
        if (b && typeof b === 'object' && b.type === 'tool_result') {
          const tid = String(b.tool_use_id ?? '');
          if (!tid || !declared.has(tid)) { removedHere += 1; continue; }
        }
        kept.push(b);
      }
      if (removedHere > 0) {
        dropped += removedHere;
        if (kept.length === 0) continue;   // 整条消息只剩被剔的块 → 丢弃整条
        out.push({ ...m, content: kept });
        continue;
      }
    }

    out.push(m);

    // ② assistant 轮：记下声明的 tool_use，并检查紧随的 user 轮是否都给回了结果
    if (!blocks || m.role !== 'assistant') continue;
    const uses = blocks.filter((b) => b && typeof b === 'object' && b.type === 'tool_use' && b.id);
    if (uses.length === 0) continue;
    for (const u of uses) declared.add(String(u.id));

    const next = messages[i + 1];
    const nextBlocks = next && next.role === 'user' && Array.isArray(next.content) ? next.content : null;
    const answered = new Set();
    if (nextBlocks) {
      for (const b of nextBlocks) {
        if (b && typeof b === 'object' && b.type === 'tool_result' && b.tool_use_id) answered.add(String(b.tool_use_id));
      }
    }
    const missing = uses.filter((u) => !answered.has(String(u.id)));
    if (missing.length === 0) continue;
    const filler = missing.map((u) => ({ type: 'tool_result', tool_use_id: String(u.id), content: TOOL_PAIR_PLACEHOLDER }));
    added += filler.length;
    if (nextBlocks) {
      // 已有 user 轮：把占位块并进去（放在最前，保持"结果紧跟调用"的顺序）
      out[out.length - 1] = next;
      messages[i + 1] = { ...next, content: [...filler, ...nextBlocks] };
      out.push(messages[i + 1]);
      i += 1;
    } else {
      // 没有紧随的 user 轮（会话末尾就是一次未完成的调用）→ 补一条
      out.push({ role: 'user', content: filler });
    }
  }
  if (added === 0 && dropped === 0) return null;
  return { messages: out, added, dropped };
}

/**
 * Responses 协议：`input[type=function_call].call_id` ↔ `input[type=function_call_output].call_id`。
 * @returns {{input:Array, added:number, dropped:number}|null}
 */
function repairToolPairingResponses(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const seenCalls = new Set();
  const seenOutputs = new Set();
  for (const it of input) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'function_call' && it.call_id) seenCalls.add(String(it.call_id));
    if (it.type === 'function_call_output' && it.call_id) seenOutputs.add(String(it.call_id));
  }
  const out = [];
  let added = 0;
  let dropped = 0;
  for (const it of input) {
    if (it && typeof it === 'object' && it.type === 'function_call_output' && it.call_id
      && !seenCalls.has(String(it.call_id))) { dropped += 1; continue; }
    out.push(it);
  }
  const pending = [];
  for (const it of out) {
    if (it && typeof it === 'object' && it.type === 'function_call' && it.call_id) {
      const id = String(it.call_id);
      if (!seenOutputs.has(id)) pending.push(id);
    }
  }
  for (const id of pending) {
    out.push({ type: 'function_call_output', call_id: id, output: TOOL_PAIR_PLACEHOLDER });
    added += 1;
  }
  if (added === 0 && dropped === 0) return null;
  return { input: out, added, dropped };
}

/**
 * 统一入口：按协议分发。返回 null 表示配对完好、无需改动（调用方据此跳过日志）。
 * @param {object} body 请求体（**不改原对象**，返回新的 body）
 * @param {'chat'|'messages'|'responses'} proto
 * @returns {{body:object, added:number, dropped:number}|null}
 */
function repairToolPairing(body, proto) {
  if (!body || typeof body !== 'object') return null;
  if (proto === 'messages') {
    const r = repairToolPairingAnthropic(body.messages);
    if (!r) return null;
    return { body: { ...body, messages: r.messages }, added: r.added, dropped: r.dropped };
  }
  if (proto === 'responses') {
    const r = repairToolPairingResponses(body.input);
    if (!r) return null;
    return { body: { ...body, input: r.input }, added: r.added, dropped: r.dropped };
  }
  const r = repairToolPairingChat(body.messages);
  if (!r) return null;
  return { body: { ...body, messages: r.messages }, added: r.added, dropped: r.dropped };
}

/* ==================================================================================
 * Anthropic 缓存断点自动放置
 *
 * 来源：dsh-factory-provider 的实测 —— 同一段长前缀，不打断点时缓存命中 **0%**，
 * 打好断点后 **99.79%**（首轮写 8919，后两轮读 8919/8934，新增各 15 token）。
 * 计费权重上缓存读 ×0.1、未缓存输入 ×1 —— 这是十倍量级的差别。
 *
 * 什么时候不动：
 *   · 客户端自己带了 cache_control（它有自己的策略，别去覆盖）
 *   · body 太小（低于最小可缓存长度，打了也是白打，还多花一次缓存写入 ×1.25）
 *   · 供应商或全局显式关掉
 * ================================================================================== */

/** Anthropic 单请求最多 4 个断点；多数模型最小可缓存 1024 token（低于它打了也是白打）。 */
const CACHE_BP_MAX = 4;
// ⚠ 单位是 **token** 不是字符：roughTokens() 返回的是字符数/4 的估算值。
// 曾经写成 4096 并直接和 roughTokens 比 —— 6000 字符的 system 只有 1500 token，
// 被误判成"太短"而跳过断点（测试 T=cachebp 抓到的）。
const CACHE_MIN_TOKENS = 1024;

/**
 * 全局默认（`config.cacheBreakpoints`，在 loadConfig 里赋值）。
 * ⚠ 这里必须是**模块级**而不是函数参数：`forward()` 的签名是
 * (provider, upstreamPath, upstreamHeaders, body, res, opts)，**拿不到 cfg** ——
 * 曾经把 cfg 当第三个参数传进去，抛 ReferenceError 被外层 catch 吞掉，
 * 表现成"这家供应商失败"，把一次本来正常的请求变成 503（测试 T=det422 抓到的）。
 */
let CACHE_BREAKPOINT_MODE = 'auto';

/** 被打断点后仍报错的供应商（学习结果）：下次直接跳过，不再白失败一轮。 */
const cacheBpBlocked = new Set();

/** 粗略 token 估算（只用于"值不值得打断点"的门槛判断，不参与计费）。 */
function roughTokens(v) {
  if (typeof v === 'string') return Math.ceil(v.length / 4);
  if (Array.isArray(v)) return v.reduce((n, x) => n + roughTokens(x), 0);
  if (v && typeof v === 'object') return Object.values(v).reduce((n, x) => n + roughTokens(x), 0);
  return 0;
}

/** 该请求里客户端是否自己用了缓存断点。 */
function hasClientCacheControl(body) {
  const scan = (v) => {
    if (Array.isArray(v)) return v.some(scan);
    if (v && typeof v === 'object') return ('cache_control' in v) || Object.values(v).some(scan);
    return false;
  };
  return scan(body && body.system) || scan(body && body.messages) || scan(body && body.tools);
}

/**
 * 在 Anthropic 请求体上放置缓存断点（**返回新对象**）。
 * 位置策略：工具表末尾 → system 末尾 → 倒数第二条消息末尾 → 最后一条消息末尾。
 * 前两个是"稳定前缀"（几乎每轮不变），后两个是"移动前缀"（本轮缓存、下轮命中）。
 * @param {object} body 请求体
 * @param {object} provider 供应商配置（读 provider.cacheBreakpoints 覆盖全局）
 * @returns {{body:object, placed:number}|null} 未放置时返回 null。
 */
function placeAnthropicCacheBreakpoints(body, provider) {
  if (!body || typeof body !== 'object') return null;
  const perProvider = provider && provider.cacheBreakpoints;
  const mode = perProvider !== undefined ? perProvider : CACHE_BREAKPOINT_MODE;
  if (mode === false || mode === 'off') return null;
  if (provider && cacheBpBlocked.has(provider.id)) return null;
  if (hasClientCacheControl(body)) return null;
  if (roughTokens(body) < CACHE_MIN_TOKENS) return null;

  const out = { ...body };
  let placed = 0;
  const mark = () => ({ type: 'ephemeral' });

  // ① 工具表末尾（缓存 tools + 其后的 system）
  if (Array.isArray(out.tools) && out.tools.length > 0 && placed < CACHE_BP_MAX) {
    const last = out.tools[out.tools.length - 1];
    if (last && typeof last === 'object') {
      out.tools = out.tools.slice(0, -1).concat([{ ...last, cache_control: mark() }]);
      placed += 1;
    }
  }
  // ② system 末尾
  if (placed < CACHE_BP_MAX && out.system !== undefined && out.system !== null) {
    if (typeof out.system === 'string') {
      out.system = [{ type: 'text', text: out.system, cache_control: mark() }];
      placed += 1;
    } else if (Array.isArray(out.system) && out.system.length > 0) {
      const last = out.system[out.system.length - 1];
      if (last && typeof last === 'object') {
        out.system = out.system.slice(0, -1).concat([{ ...last, cache_control: mark() }]);
        placed += 1;
      }
    }
  }
  // ③④ 最后两条消息的末尾块（"移动断点"：本轮写、下轮读）
  if (Array.isArray(out.messages) && out.messages.length > 0) {
    const idxs = out.messages.length >= 2 ? [out.messages.length - 2, out.messages.length - 1] : [out.messages.length - 1];
    const msgs = out.messages.slice();
    for (const idx of idxs) {
      if (placed >= CACHE_BP_MAX) break;
      const m = msgs[idx];
      if (!m || typeof m !== 'object') continue;
      if (typeof m.content === 'string') {
        msgs[idx] = { ...m, content: [{ type: 'text', text: m.content, cache_control: mark() }] };
        placed += 1;
      } else if (Array.isArray(m.content) && m.content.length > 0) {
        const last = m.content[m.content.length - 1];
        if (!last || typeof last !== 'object') continue;
        if ('cache_control' in last) continue;   // 已有点（理论上前面已拦，双保险）
        msgs[idx] = { ...m, content: m.content.slice(0, -1).concat([{ ...last, cache_control: mark() }]) };
        placed += 1;
      }
    }
    out.messages = msgs;
  }

  if (placed === 0) return null;
  return { body: out, placed };
}

/* ==================================================================================
 * 按响应体形状判定是不是 SSE（而不是只信 Content-Type）
 *
 * 来源：dsh-our-free-model 的实测 —— 「该车道会在高负载下以 **200 + application/json**
 * 返回完整的 SSE 帧序列」。旧实现依赖 header，于是把整条流当 JSON 读、parse 失败、整轮报废；
 * 更糟的是这个错误对象还带 status:200，会让可用性探测把**完全可用的模型**判成不可路由。
 *
 * 这里先嗅探首块（≤4KB）按形状分流，再把已读字节原样补发 —— 不缓冲、不改变实时性。
 * ================================================================================== */

/** 只看首个非空 token，判定形状。 */
function shapeOfHead(text) {
  const t = String(text || '').replace(/^\uFEFF/, '').replace(/^[\s\r\n]+/, '');
  if (t === '') return 'unknown';
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  // SSE 的行起始：data: / event: / id: / retry: / 注释行 ":"
  if (/^(?:data|event|id|retry)\s*:/.test(t) || t.startsWith(':')) return 'sse';
  return 'unknown';
}

/* ==================================================================================
 * 解码速度计量（只统计"真正流出正文"的那段时间）
 *
 * 来源：dsh-our-free-model 记录的一次事故 —— 一条实际 ~40 tok/s 的车道被报成 **2941 tok/s**。
 * 原因不在网关，而在分子分母量的不是同一段时间：一次调用计费 422 个输出 token，
 * 其中 291 个是**未流出任何帧**的 reasoning token（它们在第一个可见 token 之前就已生成完毕），
 * 而窗口起点正是那个首 token。
 *
 * 因此这里只做三件事：
 *   ① 首字时刻取**正文**帧（reasoning 帧不算"字"）；
 *   ② 分子剔除未流出的 reasoning token；
 *   ③ 窗口过短时不报速度 —— 宁可留空，也不给一个假数字。
 * ================================================================================== */

const MIN_DECODE_WINDOW_MS = 500;

/** 建一个计量器：喂进上游字节，最后取一次读数。 */
function makeDecodeMeter() {
  return { tail: '', firstContentAt: 0, endAt: 0, usage: null };
}

/** 尾部保留窗口：usage 帧可能跨 chunk 到达，保留尾部即可拼出完整 JSON。 */
const DECODE_TAIL_CHARS = 8192;

/**
 * 增量喂入一个上游 chunk。
 * 识别两类帧：正文（content / text_delta）与 usage。
 * 只做字符串扫描，不 JSON.parse 整帧 —— 转发热路径上不能有额外开销。
 * 内存上界是 DECODE_TAIL_CHARS（不随流长度增长）。
 */
function feedDecodeMeter(meter, chunkText) {
  if (!meter || !chunkText) return;
  const fresh = meter.tail + chunkText;
  // 首字：OpenAI 的 delta.content 有非空值，或 Anthropic 的 text_delta
  if (!meter.firstContentAt) {
    const openaiContent = /"content"\s*:\s*"(?:[^"\\]|\\.)+"/.test(fresh);
    const anthContent = /"type"\s*:\s*"text_delta"/.test(fresh);
    if (openaiContent || anthContent) meter.firstContentAt = Date.now();
  }
  // usage：从起点做括号配平取完整对象（配平失败说明还没收全，等下一块）
  const um = /"usage"\s*:\s*\{/.exec(fresh);
  if (um) {
    const start = fresh.indexOf('{', um.index);
    let depth = 0;
    let end = -1;
    for (let i = start; i < fresh.length; i += 1) {
      const c = fresh[i];
      if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    if (end > 0) {
      try { meter.usage = JSON.parse(fresh.slice(start, end)); } catch { /* 形状异常：忽略 */ }
    }
  }
  meter.tail = fresh.length > DECODE_TAIL_CHARS ? fresh.slice(-DECODE_TAIL_CHARS) : fresh;
}

/**
 * 取读数。返回 null 表示"没有可测量的解码窗口"（调用方应留空而不是编一个数）。
 * 关键：outputTokens 里剔除 reasoning_tokens（它们可能一个帧都没流出）。
 */
function readDecodeMeter(meter, startedAt) {
  if (!meter || !meter.firstContentAt) return null;
  const end = meter.endAt || Date.now();
  const windowMs = end - meter.firstContentAt;
  if (windowMs < MIN_DECODE_WINDOW_MS) return null;
  const u = meter.usage || {};
  const outRaw = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const reason = Number((u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens)
    ?? (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) ?? 0) || 0;
  const decodeTokens = Math.max(0, outRaw - reason);
  if (decodeTokens <= 0) return null;
  const tps = decodeTokens / (windowMs / 1000);
  if (!Number.isFinite(tps) || tps <= 0) return null;
  return {
    ttfbMs: meter.firstContentAt - startedAt,
    windowMs,
    decodeTokens,
    reasoningExcluded: reason,
    tps: Math.round(tps * 10) / 10,
  };
}

/** 速度读数的日志片段（无可测窗口时如实说"—"，不编数字）。 */
function decodeMeterText(m) {
  if (!m) return 'ttfb=— decode=—';
  return `ttfb=${m.ttfbMs}ms decode=${m.tps}tok/s(${m.decodeTokens} tok/${m.windowMs}ms`
    + (m.reasoningExcluded > 0 ? `, 已剔除未流出 reasoning ${m.reasoningExcluded}` : '') + ')';
}

/**
 * 给"带 tool_use 但缺 thinking 块"的 assistant 轮补一个空占位 thinking 块。
 * 只做**结构性补齐**：thinking 正文与签名都为空（不伪造推理内容）。
 * @returns {{body:object, repaired:number}|null} 无需修复时返回 null。
 */
function withThinkingPlaceholders(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  let repaired = 0;
  const messages = body.messages.map((msg) => {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
    if (msg.content.some((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'))) return msg;
    const firstTool = msg.content.findIndex((b) => b && b.type === 'tool_use');
    if (firstTool < 0) return msg;
    const content = msg.content.slice();
    content.splice(firstTool, 0, { type: 'thinking', thinking: '', signature: '' });
    repaired++;
    return { ...msg, content };
  });
  return repaired ? { body: { ...body, messages }, repaired } : null;
}

/**
 * 确定性 4xx 的客户端文案：**不回显上游错误体原文**（防泄露上游信息/供应商指纹），
 * 只说明"请求本身有问题 + 已停止 failover（重发给别家不会有帮助）"。
 */
function stopFailoverMessage(providerId, model, upstreamStatus) {
  const hint = upstreamStatus === 404
    ? 'the provider does not offer this model'
    : 'the request itself is invalid (parameters / size / unprocessable)';
  return `upstream provider "${providerId}" rejected model "${model}" with HTTP ${upstreamStatus} — ${hint}; `
    + 'failover stopped on purpose (re-sending the same request to other providers would not help). '
    + 'See the gateway log for the upstream detail.';
}

/* ---------------- 内容拦截诊断 dump（审计修复 P3，本次） ----------------
 * 旧版：内容拦截时**无条件**写 logs/dump/blocked-<Date.now()>.json（永不清理 → 无界增长），
 * 且摘要里 longTokens.head 记录原始长串的**前 20 字符**（可能是真密钥前缀）。
 * 现在：① 缺省不落盘，只有 DSH_GATEWAY_DUMP_BLOCKED=1 或 DSH_GATEWAY_DUMP_DIR=<dir> 才写；
 *       ② 目录内只保留最近 DUMP_KEEP_FILES 个 blocked-*.json，超出删最旧；
 *       ③ longTokens 只记 {len, kind}，不记任何原文前缀。
 */
const DUMP_KEEP_FILES = 20;

/** 内容拦截 dump 目录；未显式开启时返回 null（缺省不落盘）。 */
function blockedDumpDir() {
  const explicit = String(process.env.DSH_GATEWAY_DUMP_DIR || '').trim();
  if (explicit) return explicit;
  if (process.env.DSH_GATEWAY_DUMP_BLOCKED === '1') return path.join(path.dirname(LOG_PATH), 'dump');
  return null;
}

/** 长串类型（诊断用；绝不记录原文）。 */
function longTokenKind(s) {
  if (/^[0-9a-f]+$/i.test(s)) return 'hex';
  if (/^[0-9]+$/.test(s)) return 'digits';
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s.includes('-') ? 'slug' : 'alnum';
  return 'opaque';
}

/** 保留策略：目录内按 mtime（同秒用文件名兜底）保留最近 keep 个匹配文件，其余删除。 */
function pruneDumpDir(dir, nameRe, keep) {
  try {
    const rows = fs.readdirSync(dir)
      .filter((f) => nameRe.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch { /* 忽略：并发删除等 */ }
        return { p, f, mtime };
      })
      .sort((a, b) => (b.mtime - a.mtime) || (a.f < b.f ? 1 : -1));
    for (const r of rows.slice(keep)) {
      try { fs.unlinkSync(r.p); } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在/无权限：不影响服务 */ }
}

function writeBlockedDump(provider, status, body) {
  const dir = blockedDumpDir();
  if (!dir) return;                                  // 缺省不落盘（旧版无条件写，导致 logs/dump 无界增长）
  try {
    fs.mkdirSync(dir, { recursive: true });
    const digest = {
      at: localStamp(), provider: provider.id, status,
      model: body && body.model, stream: !!(body && body.stream),
      reasoning_effort: body && body.reasoning_effort,
      thinking: body && body.thinking,
      hasTools: Array.isArray(body && body.tools) ? body.tools.length : 0,
      msgCount: Array.isArray(body && body.messages) ? body.messages.length : 0,
      totalChars: Array.isArray(body && body.messages)
        ? body.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
        : 0,
      longTokens: Array.isArray(body && body.messages)
        ? body.messages.flatMap((m) => {
            const t = typeof m.content === 'string' ? m.content : '';
            // 找出 ≥32 位连续非空白字符段（疑似 hash/key/随机串）
            const re = /[^\s，。；：！？、,.;:!?'"()\[\]{}<>\/\\|=+*^$#@~`]{32,}/g;
            const hits = [];
            let mm; let cnt = 0;
            // 只记长度与类型：旧版记 head=原文前 20 字符（可能是真密钥前缀）
            while ((mm = re.exec(t)) && cnt < 8) { hits.push({ len: mm[0].length, kind: longTokenKind(mm[0]) }); cnt++; }
            return hits;
          }).slice(0, 20)
        : [],
    };
    const tag = String(provider.id).replace(/[^A-Za-z0-9_.-]/g, '_');   // 防 provider id 里的路径字符
    const f = path.join(dir, `blocked-${Date.now()}-${tag}.json`);
    fs.writeFileSync(f, JSON.stringify(digest, null, 2), 'utf8');
    log(`[dump] 被拦请求摘要 -> ${f}`);
    pruneDumpDir(dir, /^blocked-.*\.json$/i, DUMP_KEEP_FILES);
  } catch (_) { /* dump 失败不影响服务 */ }
}

/** Forward to one provider.
 *  返回值契约（审计修复 P1，本次）：
 *    true             → 响应已写回客户端
 *    false            → 本次失败但**可以**继续 failover（网络错/5xx/401/403/429/内容拦截）
 *    {stop:{status,upstreamStatus}} → 确定性 4xx：**立即终止**该模型的 failover 循环，由调用方
 *                        按 status 回复客户端（旧版把 400/404 也当"可切换"，同一个错误请求被
 *                        原样重发给每一家供应商 = N 倍计费 + N 倍风控）。
 */
async function forward(provider, upstreamPath, upstreamHeaders, body, res, opts) {
  const responsesMode = !!(opts && opts.responses);
  // raw 模式（Responses 资源子路由 GET/DELETE/cancel）：无请求体、不做协议翻译、方法可变，
  // 只把上游响应原样流回。有 body 的转发一律走 POST + 翻译路径。
  const rawMode = !!(opts && opts.raw);
  const method = (opts && opts.method) || 'POST';
  // 2026-09-17 修复：SSE「首事件即错误」的偷看块在 **try 块之外**，块内的 `isAnthropicPath`
  // 在那里不可见——引用它会抛 ReferenceError 并被偷看逻辑的 catch 吞掉，等于让该防线静默失效
  //（测试实测：`upstream p1 首事件偷看失败：isAnthropicPath is not defined`）。
  // 因此这里在外层也留一个同义常量，专供 try 块之外的判定使用。
  const isAnthropicWire = upstreamPath === '/messages';
  // 审计修复（P2，本次）：发请求前先占用熔断半开探测名额（唯一的状态转换点）。抢不到
  //（冷却未到点 / 已有探测在途）→ 本次不发任何上游请求，直接交给下一家。
  if (!breakerAcquire(provider.id)) {
    log(`skip ${provider.id} (breaker: cooldown or half-open probe already in flight)`);
    return false;
  }
  const startedAt = Date.now();   // 网络错"够快才重试"的判定基准
  const timeoutMs = providerTimeoutMs(provider, body && body.model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let upstream;
  let init = null;   // 首次请求的 fetch init（网络错原地重试用；见下方 catch）
  let firstDetail = null;   // 首次响应体（若已读取，后续分支复用，避免 body 二次消费报错）
  let needAggregate = false;   // 上游被强制流式、客户端要非流式 → 成功路径需聚合（见 applyOpenAIQuirks）
  try {
    // baseURL 允许“带 /v1”或“不带 /v1”两种写法（OpenAI SDK 惯例 / 用户习惯）：
    // upstreamBase() 统一规范化，upstreamPath 始终是相对 /v1 的路径（如 /chat/completions、/messages）
    // 注：Anthropic 协议（T5）下 upstreamHeaders 由 upstreamRequestHeaders(..., anthropic=true) 构造，
    // 含 x-api-key + anthropic-version、无 authorization Bearer；展开覆盖时不会被注入 Bearer。
    // R14：translateBody（role 兼容/推理翻译）是 OpenAI 协议专用——Anthropic 路径
    // 误用会破坏协议语义（如 thinking:{type:'disabled'} 被换成 reasoning_effort 字段，
    // 导致"关闭推理"失效——上游收到非 Anthropic 字段而按默认开推理处理）。
    // Anthropic 请求的 R9 打码已在 handleMessages 完成，这里原样透传。
    const isAnthropicPath = upstreamPath === '/messages';
    let outBody = rawMode ? null
      : (isAnthropicPath
        ? body
        : (responsesMode ? translateResponsesBody(body, provider) : translateBody(body, provider)));   // R5：role 兼容 + 推理档位翻译（Responses 走对应实现）
    // 直通路径也要应用供应商 quirks（2026-09-16 实测：stringify-tool-choice 只在翻译路径生效，
    // OpenAI 客户端把 tool_choice 对象透传 → 上游 11101 拒绝）
    // D7（审计修复）：旧门控 `&& !responsesMode` 让 /v1/responses 的 quirks **全部失效**
    //（stringify-tool-choice 失效 → 上游 400；实测该 quirk 就是为这个 400 加的）。
    // 现在纳入 Responses：其中 force-stream 需要 Responses 形状的聚合，暂不在该路径启用
    //（由 applyOpenAIQuirks 内部跳过），避免回错响应形状。
    if (!rawMode && !isAnthropicPath) {
      const q = applyOpenAIQuirks(outBody, provider, { responses: responsesMode });
      outBody = q.body;
      needAggregate = q.needAggregate;
    }
    // 2026-09-17 优化（P2）：该家已"学会"需要 thinking 回传 → **首次请求就补齐**，
    // 不再先打一次注定失败的 400/500（实测当天 13 次白打上游，失败调用通常照样计费）。
    if (!rawMode && isAnthropicPath && thinkingPassbackProviders.has(provider.id)) {
      const pre = withThinkingPlaceholders(outBody);
      if (pre) {
        outBody = pre.body;
        log(`upstream ${provider.id}（已学习）预先补齐 ${pre.repaired} 处空占位 thinking 块，省掉一次失败往返`);
      }
    }
    // 2026-09-17：该家不支持 extended thinking（已学习，或显式 quirks: ["drop-thinking"]）
    // → 首次请求就去掉顶层 thinking 参数，不再白失败一轮
    if (!rawMode && isAnthropicPath && shouldDropThinking(provider)) {
      const stripped = stripThinkingParam(outBody);
      if (stripped) {
        outBody = stripped.body;
        log(`upstream ${provider.id}（不支持 thinking）→ 去掉顶层 thinking 参数后发送`);
      }
    }
    // ── 转发前的最后一道整形（两个能力，都是"网关才做得了"的事）──
    // ① 工具调用配对修复：残缺的调用记录（用户中途点停止/客户端崩溃）留在历史里，
    //    上游会 400 invalid_request_error 并让**该会话此后每一轮都失败**。三种协议共用一处修复。
    // ② Anthropic 缓存断点：实测同一段前缀，不打 0% 命中、打好 99.79%（缓存读 0.1x vs 未缓存 1x）。
    if (!rawMode && outBody) {
      const proto = isAnthropicPath ? 'messages' : (responsesMode ? 'responses' : 'chat');
      const fixed = repairToolPairing(outBody, proto);
      if (fixed) {
        outBody = fixed.body;
        log(`工具调用配对修复（${proto}）：补 ${fixed.added} 处缺结果、剔除 ${fixed.dropped} 处孤儿`
          + '（残缺记录会让上游 400 并永久污染该会话）');
      }
      if (isAnthropicPath) {
        // ⚠ 只传 provider：forward() 拿不到 cfg（见 CACHE_BREAKPOINT_MODE 的注释）
        const bp = placeAnthropicCacheBreakpoints(outBody, provider);
        if (bp) {
          outBody = bp.body;
          log(`Anthropic 缓存断点：放置 ${bp.placed} 处（缓存读 ×0.1 vs 未缓存输入 ×1）`);
        }
      }
      // ③ OpenCode 免费车道：两件只有网关才知道怎么做的事。
      // 用**标记头**判断车道，而不是再穿一个 cfg 进来（上游请求头里已经有 x-opencode-client）。
      if (upstreamHeaders && upstreamHeaders['x-opencode-client']) {
        // ① 会话/请求 id 必须由**对话内容**派生（静态头做不到），且同一对话跨轮稳定 ——
        //    上游按会话计费，每请求新铸一个会直接把额度打光并 429。
        //    ⚠ 抽成辅助函数：翻译路径（forwardAnthropicViaOpenAI）也必须调 —— 见该函数的注释。
        applyOpencodeLaneHeaders(upstreamHeaders, outBody, provider.id);
        // ② 免费档的工具指纹门：缺 bash/glob/grep/read 直接 403 FreeTierError。
        //    ⚠ 形状必须按**上游实际收到的协议**给，而不是按客户端路径 ——
        //    矩阵翻译之后 body 已经是上游的形状了（实测踩到：Anthropic 客户端 → Responses 上游时
        //    按 chat 形状推 tools，上游 422）。
        const fpStyle = (opts && opts.matrix && opts.matrix.upstreamWire)
          ? (opts.matrix.upstreamWire === 'openai-responses' ? 'responses'
            : (opts.matrix.upstreamWire === 'anthropic-messages' ? 'messages' : 'chat'))
          : proto;
        const fp = ensureFingerprintTools(outBody, fpStyle);
        if (fp) {
          outBody = fp.body;
          log(`OpenCode 免费档工具指纹：补声明 ${fp.added.join('/')}`
            + '（缺了上游会 403 FreeTierError；它们只是指纹占位，本网关并不提供这些工具，'
            + '模型若真的调用会失败——这正是网关只能"补声明"、无法像进程内插件那样拿真实工具顶替的局限）');
        }
      }
    }
    // raw 模式不带 body：显式传 undefined，避免 fetch 在没有 content-length 时挂起等待请求体
    init = { method, headers: upstreamHeaders, signal: controller.signal };
    if (!rawMode) init.body = JSON.stringify(outBody);
    upstream = await fetch(`${upstreamBase(provider.baseURL)}${upstreamPath}`, init);
    clearTimeout(timer);
    // R9c 自适应降敏：上游内容拦截（sensitive words / content-blocked）时，用降敏后的
    // 消息体**重试一次**（换新连接；历史里的 32+ 位技术串占位符化后不再命中平台
    // "疑似密钥"过滤）。重试成功则继续走正常流式转发；仍失败则按原逻辑处理。
    if (!rawMode && !upstream.ok) {
      firstDetail = await readTextWithTimeout(upstream, 5000, 500);
      if (CONTENT_BLOCK_RE.test(firstDetail)) {
        const deBody = responsesMode ? desensitizeResponsesBody(outBody) : desensitizeBodyMessages(outBody);
        if (deBody !== outBody) {
          log(`upstream ${provider.id} 内容拦截，已降敏重试一次…`);
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), timeoutMs);
          try {
            upstream = await fetch(`${upstreamBase(provider.baseURL)}${upstreamPath}`, {
              method: 'POST',
              headers: upstreamHeaders,
              body: JSON.stringify(deBody),
              signal: c2.signal,
            });
          } finally {
            // 重试 fetch 抛错时旧版跳过 clearTimeout → 悬挂 60s 定时器（本次一并清理）
            clearTimeout(t2);
          }
          firstDetail = null;   // 换了新响应，detail 需重读
        }
      } else if (isAnthropicPath && THINKING_UNSUPPORTED_RE.test(firstDetail) && stripThinkingParam(body)) {
        // 上游明确说"不支持 thinking"（与实际形态相反的另一种 thinking 规则）→ 去掉顶层参数重试一次。
        // 与"必须回传 thinking"的补位重试对称：命中即记住该家，后续请求首次就剥掉。
        const originalStatus = upstream.status;
        const revived = await retryWithoutThinking(provider, upstreamPath, upstreamHeaders, body, timeoutMs);
        if (revived) {
          log(`upstream ${provider.id} 不支持 thinking（HTTP ${originalStatus}）`
            + ` → 去掉顶层 thinking 参数后重试（HTTP ${revived.status}，已记住该家）`);
          upstream = revived;
          firstDetail = null;
        }
      } else if (isAnthropicPath
        && (THINKING_PASSBACK_RE.test(firstDetail) || THINKING_REJECTED_GENERIC_RE.test(firstDetail))) {
        // Anthropic 协议专属：上游要求"带 tool_use 的 assistant 轮必须回传 thinking 块"。
        // 客户端没开 allowEmptySignature 时会把无签名的 thinking 降级成 text → 上游只看到
        // text+tool_use → 报错。这里补空占位块重试一次（实测上游只做结构检查，空占位即可通过）。
        // 两种上游措辞：明确点名 thinking 的 400；以及 agentrouter 的笼统 500
        // "Upstream rejected the request as invalid"（同一规则，实测补位后即 200）。
        // 笼统措辞下**只有确实存在可补位轮次时才重试**（fix 非空），避免无谓重发。
        const fix = withThinkingPlaceholders(body);
        if (fix) {
          thinkingPassbackProviders.add(provider.id);   // 学习：后续请求首次就带上（见文件顶部说明）
          log(`upstream ${provider.id} 要求 thinking 回传（HTTP ${upstream.status}）`
            + ` → 补齐 ${fix.repaired} 处空占位 thinking 块后重试一次（已记住该家需求）`);
          const c3 = new AbortController();
          const t3 = setTimeout(() => c3.abort(), timeoutMs);
          try {
            const retried = await fetch(`${upstreamBase(provider.baseURL)}${upstreamPath}`, {
              method: 'POST',
              headers: upstreamHeaders,
              body: JSON.stringify(fix.body),
              signal: c3.signal,
            });
            upstream = retried;
            firstDetail = null;   // 换了新响应，detail 需重读
          } catch (e) {
            // 重试本身失败：保留原始 4xx 响应与已读到的 detail，走下面的既有判定
            log(`upstream ${provider.id} thinking 占位重试失败: ${e.message}`);
          } finally {
            clearTimeout(t3);
          }
        }
      }
    }
  } catch (e) {
    clearTimeout(timer);
    // 2026-09-16 修复（日志可诊断性）：undici 的网络层错误 message 恒为 "fetch failed"，
    // 真正的原因在 e.cause（ECONNRESET / ENOTFOUND / UND_ERR_SOCKET / 代理连接失败…）。
    // 旧实现只记 e.message → 一整天 170 条 "fetch failed" 完全无法定位（实测根因是本机
    // Clash TUN 的 TLS 被重置，日志里看不出来）。现在把 cause 链一并落盘。
    const causeText = describeFetchError(e);
    // 2026-09-16 修复（瞬时网络错重试）：实测 clash/代理节点抖动会让**单次**请求
    // ECONNRESET（5s 内失败），而同一家下一次就好。旧实现首次失败即 90s 熔断 ——
    // 单候选模型（如 deepseek-v4.1-flash → chiyi-ds）会因此整段不可用 1.5 分钟。
    // 现在：**仅对"快速失败的网络层错误"重试一次**（本地超时中止不重试，否则白白翻倍等待）。
    const elapsed = Date.now() - startedAt;
    const upstreamUrl = `${upstreamBase(provider.baseURL)}${upstreamPath}`;
    if (isTransientNetError(e) && elapsed < NET_RETRY_MAX_ELAPSED_MS) {
      log(`upstream ${provider.id} 网络错误（${causeText}，${elapsed}ms）→ 原地重试一次`);
      const c2 = new AbortController();
      const t2 = setTimeout(() => c2.abort(), providerTimeoutMs(provider, body && body.model));
      try {
        const retried = await fetch(upstreamUrl, {
          ...init,
          signal: c2.signal,
        });
        upstream = retried;
        log(`upstream ${provider.id} 重试成功（网络抖动已恢复）`);
      } catch (e2) {
        log(`upstream ${provider.id} 重试仍失败：${describeFetchError(e2)}`);
      } finally {
        clearTimeout(t2);
      }
    }
    if (!upstream) {
      // R3 防封：失败冷却而非立即删缓存（防每个请求都重试上游形成风暴）
      catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
      breakerRecordFail(provider.id, 0);   // V2：网络错误 → 短熔断
      log(`upstream ${provider.id} request error: ${e.message}${causeText ? ' (' + causeText + ')' : ''}${proxyHintFor(upstreamUrl, causeText)}`);
      return rawMode ? { retryable: 0 } : false;
    }
  }
  clearTimeout(timer);
  if (!upstream.ok) {
    // surface upstream error body if small（复用 firstDetail：body 只能读一次，
    // 之前 text() 已消费时再读会抛 "body already consumed" 丢失详情）
    let detail = firstDetail;
    if (detail === null) {
      detail = await readTextWithTimeout(upstream, 5000, 500);
    }
    log(`upstream ${provider.id} HTTP ${upstream.status}: ${maskSecrets(detail)}`);   // V1：日志脱敏
    // 账户池（2026-09-16）：把状态码与错误体回传给包装函数，由它判定"该换账户还是换供应商"
    if (opts && opts.failureSink) {
      opts.failureSink.status = upstream.status;
      opts.failureSink.detail = detail;
      // 429 的 Retry-After 也带回去 —— 账户池要按它冷却（真实客户端会遵循）
      opts.failureSink.retryMs = retryAfterMs(upstream);
    }
    // 账户池场景（opts.accountScoped）：额度耗尽 / 会话失效 / 限流属于**账户**问题，不是供应商问题 ——
    // 直接交回账户池换账户，**不计供应商熔断**（否则第一次额度耗尽就会把整家熔断 30 分钟，
    // 换账户的重试会被 breakerAcquire 挡在门外 → 客户端拿到 503，账户池形同虚设）。
    if (opts && opts.accountScoped) {
      // ⚠ 先摘掉**与账号无关**的拒绝，再判"是不是账户级失败"。
      // 否则一个"地区受限"的模型会被 `classifyAccountFailure(403, 地区文案)` 判成 `session`
      //（裸 401/403 → session 是该函数的既定规则），把该家**所有 Key** 逐个标记冷却 1 小时。
      // 连坐效果与"熔断整家"等价：实测随后请求同家另一个完全正常的模型，路由阶段就是
      // `provider p1: 2 个账户全部冷却中 → 交给下一家` —— 一个模型坏掉 = 这家对所有模型静默停用。
      if (MODEL_UNSUPPORTED_BY_PROVIDER_RE.test(detail)) {
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"这家不提供该模型"（含地区/套餐受限）`
          + ' → 继续 failover（**不熔断该家、不冷却账户**；该家对别的模型仍然正常。'
          + '若长期如此，请从配置的 models 里移除该映射）');
        // ⚠ 必须**显式告诉账户池**"这不是账户问题"。
        // 光在这里 return 是不够的：调用方 forwardWithAccounts 拿到 false 之后会**自己**再跑一遍
        // `classifyAccountFailure(sink.status, sink.detail)` —— 那个函数看到裸 403 仍会判成
        // `session`，照样 markAccountFailure。实测日志：这里刚打完"不冷却账户"，
        // 紧接着就是 `account acctgeo#key1 标记为 session（冷却 3600s）`，
        // 然后 2 个 Key 全冷却 → healthy-model 直接被"全部冷却中"挡掉。
        if (opts.failureSink) opts.failureSink.modelScopeOnly = true;
        breakerRecordSuccess(provider.id);
        return rawMode ? { retryable: upstream.status } : false;
      }
      const acctKind = classifyAccountFailure(upstream.status, detail);
      if (acctKind) {
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为账户级失败（${acctKind}）→ 交回账户池处理（不计供应商熔断）`);
        // D1（审计修复）：账户级失败说明"这家上游是健康的、只是这个账户不行"，**不计供应商失败**，
        // 因此必须把刚占用的半开探测名额交还。旧实现直接 return 不释放 → 该家永久卡在
        // half-open（breakerIsOpen 恒真）再也不会被选中，直到进程重启。
        breakerRecordSuccess(provider.id);
        return rawMode ? { retryable: upstream.status } : false;
      }
    }
    const contentBlocked = CONTENT_BLOCK_RE.test(detail);
    // R8：上游内容拦截时，把触发请求的"结构摘要"落盘（不含明文 key、不含原文前缀），
    // 用于定位是什么特征触发了上游过滤（sensitive words / content-blocked）。
    // 审计修复（P3，本次）：受 env 开关控制（缺省不落盘）+ 目录保留上限，见 writeBlockedDump。
    if (contentBlocked && !rawMode) writeBlockedDump(provider, upstream.status, body);
    // ⚠ 下面两条必须排在"通配 4xx/5xx → 熔断该家"之前。全文件有**三处**这样的通配分支
    //（这个函数、forwardAnthropicViaOpenAI、以及"全部账户不可用"的收尾），三处都要判，
    // 否则同一个 403 走不同路径会有不同后果 —— 这正是 2026-09-30 模型全量测试里
    // "地区受限的模型把整家 13 个正常模型一起封掉"的成因。
    if (MODEL_UNSUPPORTED_BY_PROVIDER_RE.test(detail)) {
      log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"这家不提供该模型"（含地区/套餐受限）`
        + ' → 继续 failover（**不熔断该家**；该家对别的模型仍然正常。若长期如此，请从配置的 models 里移除该映射）');
      return rawMode ? { retryable: upstream.status } : false;
    }
    if (CLIENT_FINGERPRINT_RE.test(String(detail || ''))) {
      log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"客户端指纹被拒" → 熔断该家并停止重试。`
        + '这类拒绝与账号无关（换 Key/重试都没用），继续请求只会加剧风控；'
        + '本程序运行在 Node 上，无法伪装 TLS/HTTP 客户端指纹，这是已知上限。');
      catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
      breakerRecordFail(provider.id, 403);
      return rawMode ? { retryable: upstream.status } : false;
    }
    if (upstream.status === 401 || upstream.status === 403 || upstream.status === 429 || upstream.status >= 500) {
      // likely stale/misconfigured key, rate-limited, or dead endpoint —— 冷却缓存，防风暴（R3）
      // R25：429（限流）计入熔断——不熔断会加剧限流；短熔断（90s）已足够退避
      catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
      // 429 时把服务端的 Retry-After 传下去（真实客户端会遵循它）
      breakerRecordFail(provider.id, upstream.status, upstream.status === 429 ? retryAfterMs(upstream) : 0);   // V2：按状态码分级熔断（401/403 → 30 分钟）
      // raw 模式（资源子路由）：这不是"资源不存在"而是"这家上游暂时不可用"，
      // 把状态码带回去让调用方回 502，避免误导客户端以为 response 已被删除
      return rawMode ? { retryable: upstream.status } : false;
    }
    // 审计修复（P1，本次）：确定性 4xx（401/403/429 之外的 4xx）**立即终止该模型的 failover**。
    // 旧版把 400/404 也归入"可切换"分支（有意为之的注释），结果是同一个"请求本身有错"的 body
    // 被原样重发给每一家供应商（N 倍计费 + N 倍风控画像），客户端最终拿到可重试的 503
    //（误导用户/客户端反复重试同一个必然失败的请求）。
    // 保留的例外：上游**内容拦截**（sensitive words / content_blocked）——换一家供应商 +
    // R9c 降敏重试可能成功，继续 failover（见上方的降敏重试）。
    // 这两种 4xx 都说明上游**能正常应答**（策略性拒绝，连接性是健康的）→ 释放熔断半开探测
    // 名额；否则"确定性 4xx 不记失败"会让半开名额永远被占（熔断卡死）。
    breakerRecordSuccess(provider.id);
    if (!contentBlocked) {
      // 审计补充：404 要分两种——
      //  · 上游**不实现该路由**（如某些供应商没有 /responses，返回通用 404/空体）：
      //    换下一家是有意义的，否则"Codex 仿真"用户会被优先级最高的那家直接打死；
      //  · 上游**明确说模型不存在/不支持**：这是确定性错误，重发给每一家只是 N 倍计费。
      // 用响应体特征区分，判不出来时保守按"路由不存在"继续 failover。
      if (upstream.status === 404 && !MODEL_MISSING_RE.test(detail)) {
        const routeMissing = ROUTE_MISSING_RE.test(detail);
        log(`upstream ${provider.id} HTTP 404（未见"模型不存在"特征，按路由不存在处理）→ 继续 failover`);
        // raw 模式（Responses 资源子路由）：把"整条路由没实现"与"资源不存在"的区别带回调用方，
        // 让它能给客户端一句能照着排查的提示（实测 new-api 对 GET/DELETE/cancel 回 Invalid URL）
        return rawMode ? { notFound: true, routeMissing } : false;
      }
      // 2026-09-15 实测修复：**供应商侧 4xx（账号/额度/权限/套餐）不属于"请求本身有错"**——
      // 实测 b.ai 余额为 0 时回 HTTP 400 `credit insufficient balance: balance=0`，旧实现
      // 把它当确定性错误终止 failover，用户明明还有可用的 chiyi-ds 却直接失败（且客户端被告知
      // "请求无效"，排查方向全错）。现在按"这家暂时不能服务"处理：冷却 + 熔断 + 继续换下一家，
      // 与 401/403 同类（余额/欠费类状态在充值前不会自愈 → 长熔断，避免反复打点）。
      if (PROVIDER_SIDE_4XX_RE.test(detail)) {
        const persistent = PERSISTENT_ACCOUNT_RE.test(detail);
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"供应商账号/额度/权限"类错误`
          + `（${persistent ? '长期状态' : '临时'}）→ 冷却该家并继续 failover`);
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, persistent ? 403 : 0);   // 403 → 长熔断（30 分钟）；0 → 短熔断
        return rawMode ? { retryable: upstream.status } : false;
      }
      // ⚠ 指纹类拒绝必须排在"供应商账号/额度"判定**之前**：它长得像 403（也会被
      // PROVIDER_SIDE_4XX_RE 或裸 403 规则吃掉），但处置完全相反 —— 不是这个账号有问题，
      // 而是"你这个客户端不被允许"。换 Key 没用，重试没用，继续打只会加剧风控。
      // 实测事故：cline 对一个**地区受限的模型**回 403 "is not available in your region"，
      // 旧实现把它当供应商级 403 → **整家熔断 30 分钟**，把该家另外 13 个完全正常的模型
      // 一起封掉（模型全量测试里 4 个 nvidia/nex 模型瞬间失败就是这个原因）。
      // 现在：地区/套餐受限 → 归入"这家没有该模型"（不熔断该家）；
      //       真正的客户端指纹拒绝 → 长熔断该家并明确告知用户原因。
      if (CLIENT_FINGERPRINT_RE.test(detail)) {
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"客户端指纹被拒" → 熔断该家并停止重试。`
          + '这类拒绝与账号无关（换 Key/重试都没用），继续请求只会加剧风控；'
          + '本程序运行在 Node 上，无法伪装 TLS/HTTP 客户端指纹，这是已知上限。');
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, 403);
        return rawMode ? { retryable: upstream.status } : false;
      }
      // 2026-09-23 修复：**这家没有这个模型**不是"请求本身有错" —— 换下一家有意义，
      // 必须继续 failover（旧实现归入下面的"确定性 4xx"而终止，用户拿到 400 而非可用的下一家）。
      // 实测事故：amd 回 400 "Requested model DeepSeek-V4.1-Flash not supported"，
      // 而同一逻辑模型在 workbuddy/cline 上都可用，用户却直接拿到 400。
      // 刻意**不调 breakerRecordFail**：熔断器是按供应商粒度，该家对别的模型完全正常，
      // 记失败会连坐整家（正是上方 :2536 注释所警告的情形）。半开名额已在上方交还。
      // 2026-09-30 扩充：**地区/套餐受限**（"is not available in your region"/"for your plan"）
      // 也属这一类 —— 它同样是**模型级**事实，不该连坐整家。
      if (MODEL_UNSUPPORTED_BY_PROVIDER_RE.test(detail)) {
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"这家不提供该模型"`
          + `（含地区/套餐受限）→ 继续 failover（不熔断该家；若长期如此，请从配置的 models 里移除该映射）`);
        return rawMode ? { retryable: upstream.status } : false;
      }
      // 2026-10-08 新增：**上游自己坏了**，但被包在 4xx 里回给我们 → 同样要继续 failover。
      //
      // `bad_response_status_code` 是 new-api / one-api 系的错误码，语义是
      // "**我转发出去的那个上游**返回了坏状态码" —— 这是**供应商侧**故障，
      // 换一家重试完全有意义；而下面的"确定性 4xx 一律终止 failover"会把它当成
      // "你的请求有问题"，于是优先级更高但坏掉的那家**直接把请求打死**。
      //
      // 实测（本机真实配置）：h-e.top（priority 1）对 `glm-5.3-flash` 回这个 400，
      // 而 opencode-go（priority 3）明明能服务该模型，却根本没被尝试 —— 用户拿到 400。
      // 这与 :3915 那条"这家没有这个模型"是同一类错误：**把供应商侧问题误判成请求侧问题**。
      // 同样刻意不调 breakerRecordFail（可能是该模型个例，不该连坐整家）。
      if (UPSTREAM_BROKEN_4XX_RE.test(detail)) {
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"上游侧故障被包成 4xx"`
          + `（${String(detail || '').slice(0, 80)}）→ 继续 failover（不熔断该家）`);
        return rawMode ? { retryable: upstream.status } : false;
      }
      const status = DETERMINISTIC_4XX_STATUS[upstream.status] || 400;
      log(`upstream ${provider.id} 确定性 4xx HTTP ${upstream.status} → 终止 failover（回 ${status}，不回显上游原文）`);
      return { stop: { status, upstreamStatus: upstream.status } };
    }
    log(`upstream ${provider.id} HTTP ${upstream.status} 判定为内容拦截 → 继续 failover（换供应商/降敏）`);
    return false;
  }
  // D2（审计修复）：成功清零**移到 SSE 首事件偷看之后**。
  // 旧实现在此处（2xx 即清零）就删掉熔断条目，而"200 + 首事件是错误"的判定在其后 ——
  // 于是那条路径上的 breakerRecordFail 用 breaker.get(id) || {fails:0} 取到**全新**条目，
  // fails 恒为 1、state 恒为 'closed' → `fails >= 3` 永不成立 → **熔断器完全失效**。
  // 对恒回 200 + event:error 的上游（实测 api.chiyi.cc 形态），每个请求都白打一轮上游
  //（延迟 + 计费），设计意图（连续 3 次即退避保护账号）完全落空。
  let bodyStream = upstream.body;
  let ctype = String(upstream.headers.get('content-type') || 'application/json');
  // —— SSE「首事件就是错误」识别（2026-09-15 实测事故）——
  // 部分上游（实测 api.chiyi.cc）对失败的请求回 **HTTP 200 + text/event-stream**，流里第一件事
  // 就是 `event: error` + `data: {"error":{"message":"Service temporarily unavailable",...}}`。
  // 旧实现按"成功"直接透传：日志记 status=ok（说谎）、不计熔断、不 failover，客户端拿到的是
  // **上游的错误原文**（用户看到的那句就是这个）。
  // 现在：写响应头之前先偷看首个 SSE 事件——若它是 error，就当作该供应商失败（冷却+熔断+换下一家）。
  // 关键点：此时**还没向客户端写任何字节**，所以 failover 是安全的（客户端最终收到的是
  // 下一家的正常流，或全部失败时网关自己的 503 文案）。
  // 形状判定（③）：Content-Type 会说谎 —— 实测有上游在高负载下用 **200 + application/json**
  // 返回完整的 SSE 帧序列。旧实现只信 header，于是把整条流当 JSON 读、解析失败、整轮报废；
  // 更糟的是那个错误对象还带 status:200，会让可用性探测把**完全可用的模型**判成不可路由。
  // 现在：客户端要流式、header 却说 JSON 时，先偷看首块按**响应体形状**定夺。
  const ctypeSaysSse = /event-stream/i.test(ctype);
  const wantsStream = !!(body && typeof body === 'object' && body.stream === true);
  const mayLieAboutJson = !ctypeSaysSse && /json/i.test(ctype) && wantsStream;
  let pendingHead = null;   // 偷看得到的首事件字节（未判失败时原样补发给客户端）
  if (bodyStream && (ctypeSaysSse || mayLieAboutJson)) {
    try {
      const peekReader = bodyStream.getReader();
      const chunks = [];
      let total = 0;
      while (total < 8192) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await peekReader.read();
        if (done) break;
        const buf = Buffer.from(value);
        chunks.push(buf);
        total += buf.length;
        const txt = Buffer.concat(chunks).toString('utf8');
        if (/\n\n|\r\n\r\n/.test(txt)) break;   // 首个事件已完整
      }
      const head = Buffer.concat(chunks).toString('utf8');
      pendingHead = Buffer.concat(chunks);
      // header 与响应体形状不一致时，以**形状**为准（③，见上方说明）。
      // 已读字节原样保留在 pendingHead 里，稍后补发 —— 实时性不受影响。
      if (!ctypeSaysSse && shapeOfHead(head) === 'sse') {
        log(`upstream ${provider.id} 的 Content-Type 是「${ctype}」但响应体形状是 SSE`
          + ' → 按流式处理（旧实现会把整轮当 JSON 解析而报废）');
        ctype = 'text/event-stream';
      }
      const hasRealEvent = /event:\s*(message_start|content_block_start|content_block_delta|response\.created|response\.in_progress|response\.output_item)/i.test(head)
        || /"type"\s*:\s*"(message_start|content_block_start|response\.created)"/.test(head);
      const looksError = !hasRealEvent && (/event:\s*error/i.test(head) || /"type"\s*:\s*"error"/.test(head.slice(0, 2048)));
      if (looksError) {
        // ① 上游说"不支持 thinking"（实测 amd/GLM-5.3-Flash：HTTP 200 + SSE 首事件 error）
        //    → 去掉顶层 thinking 参数重试一次。此刻尚未向客户端写任何字节，重试是安全的。
        let revived = null;
        if (isAnthropicWire && THINKING_UNSUPPORTED_RE.test(head) && stripThinkingParam(body)) {
          try { await peekReader.cancel(); } catch { /* 忽略 */ }
          revived = await retryWithoutThinking(provider, upstreamPath, upstreamHeaders, body, timeoutMs);
          if (revived && revived.ok) {
            log(`upstream ${provider.id} 不支持 thinking（HTTP 200 + SSE 首事件错误）`
              + ' → 去掉顶层 thinking 参数后重试成功（已记住该家）');
            upstream = revived;
            bodyStream = revived.body;
            ctype = String(revived.headers.get('content-type') || 'application/json');
            pendingHead = null;
          } else if (revived) {
            log(`upstream ${provider.id} 去 thinking 重试仍非 2xx：HTTP ${revived.status}`);
          }
        }
        // ② 重试无效 → 按既有规则判该家失败并换下一家
        if (!(revived && revived.ok)) {
          const detail = head.replace(/\s+/g, ' ').slice(0, 200);
          log(`upstream ${provider.id} HTTP 200 但 SSE 首事件是错误 → 判定该家失败并换下一家：${maskSecrets(detail)}`);
          catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
          breakerRecordFail(provider.id, 0);   // 短熔断（连续 3 次 / 或半开探测失败）
          try { await peekReader.cancel(); } catch { /* 忽略 */ }
          return rawMode ? { retryable: 0 } : false;
        }
      }
      peekReader.releaseLock();   // 未判失败：把流交回下面的正常消费路径
    } catch (peekErr) {
      log(`upstream ${provider.id} 首事件偷看失败（按正常流继续）：${peekErr && peekErr.message}`);
      pendingHead = null;
    }
  }
  // D2（审计修复）：到这里才确认"上游确实给出了正常事件"（用了流式则已通过首事件偷看），
  // 此时清零熔断计数才是诚实的；提前到 2xx 处会让"200 + 错误 SSE"永远无法熔断。
  breakerRecordSuccess(provider.id);
  // ── 协议矩阵：上游线协议 ≠ 客户端协议 → 翻译后再写给客户端 ──
  // 位置是刻意的：**晚于**首事件偷看（那时才确认上游给的是正常流，否则会把"上游 200 +
  // 错误 SSE"翻译成一条客户端看不懂的成功响应），**早于**任何 res.writeHead
  //（响应头一写，形状就改不了了）。
  // 同协议时 mx 为空或两值相等 → 完全走原来的透传路径，一个字节都不多绕。
  {
    const mx = opts && opts.matrix;
    if (mx && mx.upstreamWire && mx.upstreamWire !== mx.clientWire) {
      log(`[matrix] ${mx.model}: 客户端 ${mx.clientWire} ← 上游 ${mx.upstreamWire}（翻译${mx.clientStream ? '流式' : '非流式'}）`);
      return await forwardMatrixResponse({ res, upstream, bodyStream, ctype, pendingHead, mx });
    }
  }
  // 上游被强制流式、而客户端要非流式 → 聚合后回单条 JSON（2026-09-16：直通路径补齐 quirk 语义）
  if (needAggregate && bodyStream && /event-stream/i.test(ctype)) {
    const completion = await aggregateOpenAIStream(upstream, pendingHead);
    if (res.destroyed || res.writableEnded) return false;
    json(res, 200, completion);
    return true;
  }
  // ── 直通路径的"上游 200 但不是我们要的东西"检测 ──
  // 真实高频形态：上游前面挂了反代/CDN，它自己出错时回 **200 + text/html 错误页**。
  // 直通路径不解析响应体，于是旧实现把这页 HTML 原样配 200 发给客户端 ——
  // 客户端拿到"成功"却解析失败，而网关日志一片干净。
  //
  // ⚠⚠ 判据**必须只认 text/html**，不能写成"content-type 不是 JSON 就算错"。
  // 实测踩到（2026-10-08，本轮修复引入又修掉）：`agentrouter` 是**合法供应商**，
  // 它的正常响应就是 `200 + text/plain; charset=utf-8`，body 完全合法的 JSON ——
  // 按"不是 JSON 就拦"会把一家**本来能用**的供应商打成 502，
  // 比原来那个"HTML 被透传"的问题严重得多（后者至少客户端能看出不对）。
  // 反代/CDN 的错误页无一例外用 text/html，所以只认它既够用又不误伤。
  if (!wantsStream && upstream.status === 200 && !ctypeSaysSse && /text\/html|application\/xhtml/i.test(ctype)) {
    log(`upstream ${provider.id} 返回 200 但 content-type=${ctype}（客户端要 JSON）→ 判定为上游/反代错误页，不再透传`);
    try { await upstream.body?.cancel(); } catch { /* 忽略 */ }
    return {
      stop: {
        status: 502,
        upstreamStatus: upstream.status,
        reason: `上游返回 200 但内容是 HTML（Content-Type: ${ctype}）—— 通常是上游前面有反代/网关插了错误页`,
      },
    };
  }
  // success: stream through
  try {
    res.writeHead(upstream.status, {
      'content-type': ctype,
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
  } catch (writeHeadErr) {
    log(`client disconnected before headers: ${writeHeadErr.message}`);
    try { await upstream.body?.cancel(); } catch { }
    res.destroy();
    return false;
  }
  // ④ 解码速度计量：只统计"真正流出正文"的那段时间（reasoning token 剔除，见上方说明）。
  // 内存上界 8KB，不随流长度增长；失败绝不影响转发。
  // ⚠ 必须建在 pendingHead 补发**之前**：偷看过的首事件是直接写给客户端的，
  // 不经过下面的读循环 —— 少喂这一口，"首字"就会被算到第二个 chunk 上，
  // 窗口变成 ~0ms，速度永远测不出来（测试 T=decodemeter 抓到的）。
  const meter = makeDecodeMeter();
  if (pendingHead && pendingHead.length) {
    // 偷看过的首事件原样补发（客户端不该察觉这一步）
    try { feedDecodeMeter(meter, pendingHead.toString('utf8')); } catch { /* 计量失败绝不影响转发 */ }
    if (opts && typeof opts.onSniff === 'function') {
      try { opts.onSniff(pendingHead.toString('utf8')); } catch { /* 忽略 */ }
    }
    try { res.write(pendingHead); } catch { /* 客户端可能已断开，下面循环会兜住 */ }
  }
  if (bodyStream) {
    const reader = bodyStream.getReader();
    // R7 强壮性：读流加"空闲超时"——上游已连接但长时间不吐数据（挂起/代理卡死）时
    // 主动断开，避免 dsh 客户端无限等待后重连（表现为"经常重连模型请求"）。
    const IDLE_READ_MS = 90_000;
    let lastRead = Date.now();
    let idleTimer = setInterval(() => {
      if (Date.now() - lastRead > IDLE_READ_MS) {
        log('upstream stream idle timeout (' + IDLE_READ_MS + 'ms)，断开。');
        clearInterval(idleTimer);
        try { reader.cancel(); } catch { }
        try { res.destroy(); } catch { }
      }
    }, 5000);
    // 审计修复（P1-3）：客户端断开必须**立即取消上游流**。旧版只 try/catch 包 res.write，
    // 但客户端 socket 销毁后 write 既不抛错也不发 error（只返回 false）——catch 是死代码，
    // 循环会一直读到上游结束：用户点"停止"后上游继续生成（重复计费/占额度），
    // 而且最终 return true → 日志与统计记成 status=ok。
    let clientGone = false;
    // Responses 亲和性：从响应字节里嗅探 response.id（JSON 与 SSE 都含 "id":"resp_…"），
    // 只嗅探头部有限字节，取到即停（回调返回 true）。绝不影响转发本身。
    let sniff = (opts && typeof opts.onSniff === 'function') ? { fn: opts.onSniff, text: '' } : null;
    const SNIFF_MAX = 8192;
    const onClientClose = () => {
      if (clientGone) return;
      clientGone = true;
      log('client closed connection, cancelling upstream stream');
      try { reader.cancel(); } catch { /* 忽略 */ }
      clearInterval(idleTimer);
    };
    try { res.once('close', onClientClose); } catch { /* 忽略 */ }
    try {
      while (true) {
        if (clientGone || res.destroyed || res.writableEnded) {
          try { await reader.cancel(); } catch { /* 忽略 */ }
          return false;   // 客户端已走：不能记 ok，也不必 failover（调用方有 headersSent 守卫）
        }
        const { done, value } = await reader.read();
        if (done) break;
        lastRead = Date.now();
        try { feedDecodeMeter(meter, Buffer.from(value).toString('utf8')); } catch { /* 计量失败绝不影响转发 */ }
        if (sniff) {
          try {
            sniff.text += Buffer.from(value).toString('utf8');
            if (sniff.fn(sniff.text) === true || sniff.text.length >= SNIFF_MAX) sniff = null;
          } catch { sniff = null; }   // 嗅探失败绝不影响转发
        }
        // 客户端可能随时断开（点停止/超时/关页）：write 抛 EPIPE 必须捕获，
        // 否则未处理异常会经 async 回调炸掉整个网关进程（C1）
        try {
          // D10（审计修复）：write 返回 false = 下游内部缓冲已满（慢客户端 + 快上游）。
          // 旧实现丢弃返回值继续读上游 → 缓冲无上限增长（网关内存暴涨直至 OOM）。
          // 现在等待 drain 或客户端断开后再继续读，把背压如实传回上游。
          if (res.write(Buffer.from(value)) === false) {
            await new Promise((resolve) => {
              const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
              res.once('drain', done);
              res.once('close', done);
            });
          }
        } catch (writeErr) {
          log(`client disconnected during stream: ${writeErr.message}`);
          try { await reader.cancel(); } catch { }
          res.destroy();
          clearInterval(idleTimer);
          return false;
        }
      }
    } catch (readErr) {
      // 上游流异常：断开客户端，避免悬挂
      log(`upstream stream error: ${readErr.message}`);
      try { res.destroy(); } catch { }
      return false;
    } finally {
      clearInterval(idleTimer);
      try { res.removeListener('close', onClientClose); } catch { /* 忽略 */ }
      try { reader.releaseLock(); } catch { }
    }
    if (clientGone) return false;   // 收尾阶段才发现断开 → 同样不记成功
    // ④ 解码速度：无可测窗口时**不打印**（宁可留空，也不给一个假数字 —— 曾有一条实际
    // ~40 tok/s 的车道被"整段耗时 ÷ 正文落地耗时"报成 2941 tok/s）。
    meter.endAt = Date.now();
    const dec = readDecodeMeter(meter, startedAt);
    if (dec) log(`[decode] ${(body && body.model) || '(no model)'} via=${provider.id} ${decodeMeterText(dec)}`);
  }
  if (res.destroyed || res.writableEnded) return false;
  try {
    res.end();
  } catch { }
  return true;
}

/* ================= 协议翻译：Anthropic ↔ OpenAI（2026-09-16） =================
 * 用途：客户端（dsh，clientProfile=claude）说 Anthropic 协议，而部分上游只会 OpenAI chat
 *（WorkBuddy 的 /v2/chat/completions；sensenova 也是——它此前每次 401，正是因为网关把
 * /v1/messages 原样转给了只认 OpenAI 路径的上游）。
 * 声明方式：供应商配置 `"protocol": "openai-chat"` —— 只影响该供应商，其它家不变。
 */

/** Anthropic content 块数组 → OpenAI content 部分（text / image_url） */
function anthropicPartsToOpenAI(content) {
  const parts = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source && typeof b.source === 'object') {
      const src = b.source;
      const url = src.type === 'base64'
        ? `data:${src.media_type || 'image/png'};base64,${src.data || ''}`
        : (typeof src.url === 'string' ? src.url : '');
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return parts;
}

/** tool_result 的 content（字符串 / 块数组）→ 纯文本 */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // 第二轮审计修复：非文本块旧实现映射成空串 → 工具返回图片时模型只看到"空结果"，
    // 会误判工具失败或反复重试。用占位符保留"有内容但不是文本"这一信息。
    return content.map((b) => {
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'image') return '[image]';
      return '';
    }).join('');
  }
  return '';
}

/**
 * 解析 tool_calls 分片应落入的槽位（第二轮审计修复）。
 *
 * 背景：OpenAI 规范要求**每个**分片都带 `index`，但自建/中转上游常只在首个分片带 `id`、
 * 后续参数分片既无 index 也无 id。旧实现是 `Number.isInteger(call.index) ? call.index : 0`，
 * 把这类分片**一律归到槽位 0**：多个工具调用会挤进同一条（id/name 被后来者覆盖、arguments
 * 拼成非法 JSON），聚合路径解析失败后还会退化成空 input，客户端拿到参数错乱的 tool_use。
 *
 * 规则（按可靠性排序）：
 *   ① `index` 是整数（或纯数字字符串）→ 直接用它，并记为"上次槽位"；
 *   ② 分片带非空 `id` → 视为**新调用**，分配下一个未占用槽位；
 *   ③ 两者都没有 → 视为**上一个槽位的续片**（首个分片之前则用 0）。
 *
 * @param {object} call - 单个 tool_calls 分片。
 * @param {Map<number, object>} toolCalls - 已建立的槽位表。
 * @param {{ last: number }} state - 跨分片状态（记录上次落位的槽位）。
 * @returns {number} 槽位下标。
 */
function toolCallSlot(call, toolCalls, state) {
  const raw = call && call.index;
  const n = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  if (Number.isInteger(n) && n >= 0) { state.last = n; return n; }
  const id = call && typeof call.id === 'string' ? call.id : '';
  if (id) {
    // 第三轮审计修复：**先按 id 归并**。只判断"有没有 id"是不够的 —— 上游在**续片**里
    // 重复发同一个非空 id 时（规范只要求首片带 id，但并非所有上游都遵守），旧逻辑会
    // 把它当成"新调用"而分配新槽位，同一次调用的 arguments 被切进多个槽：
    // 聚合路径产出多条 id 相同、参数各半截的 tool_calls（JSON.parse 必失败），
    // 流式路径还会给空名槽开出 `unknown tool ""`。按 id 归并即可让续片回到自己的槽位。
    for (const [k, e] of toolCalls) {
      if (e && e.id === id) { state.last = k; return k; }
    }
    let next = 0;
    for (const k of toolCalls.keys()) { if (k >= next) next = k + 1; }
    state.last = next;
    return next;
  }
  return Number.isInteger(state.last) ? state.last : 0;
}

/**
 * Anthropic Messages 请求体 → OpenAI chat/completions 请求体。
 * 覆盖：system、多模态 content、tool_use/tool_result ↔ tool_calls/role:tool、tools、tool_choice、
 * stop_sequences、thinking(budget)→reasoning_effort（再交由 translateBody 按家映射档位）。
 */
function anthropicToOpenAIRequest(body, provider) {
  const messages = [];
  // 2026-09-16 防御：历史里若存在**名字为空的 tool_use**（修复前产生的坏数据、或上游协议异常），
  // 原样回传会让上游 400（`tool_calls[].function.name` 非法）→ 之后每一轮都被打死。
  // 这里把这类 tool_use 连同它对应的 tool_result 一起丢弃（保留其余历史），并记一条日志。
  const droppedToolIds = new Set();
  let droppedCount = 0;
  const sysText = typeof body.system === 'string'
    ? body.system
    : (Array.isArray(body.system) ? body.system.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : '');
  if (sysText.trim()) messages.push({ role: 'system', content: sysText });

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = msg.content;
    if (typeof content === 'string') { messages.push({ role, content }); continue; }
    if (!Array.isArray(content)) continue;

    if (role === 'assistant') {
      const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      const calls = [];
      for (const b of content) {
        if (!b || b.type !== 'tool_use') continue;
        const name = String(b.name || '').trim();
        if (!name) {   // 空名工具调用：丢弃（连它的 tool_result 一起），否则整轮 400
          if (b.id) droppedToolIds.add(String(b.id));
          droppedCount++;
          continue;
        }
        calls.push({
          id: String(b.id || 'call_' + Math.random().toString(36).slice(2, 10)),
          type: 'function',
          function: { name, arguments: JSON.stringify(b.input === undefined ? {} : b.input) },
        });
      }
      const out = { role: 'assistant', content: text === '' && calls.length ? null : text };
      if (calls.length) out.tool_calls = calls;
      if (calls.length || text !== '') messages.push(out);
      continue;
    }
    // user：tool_result 必须拆成独立的 role:'tool' 消息（顺序要紧：紧跟发起调用的 assistant 轮）
    for (const b of content) {
      if (b && b.type === 'tool_result') {
        if (droppedToolIds.has(String(b.tool_use_id || ''))) continue;   // 对应的 tool_use 已被丢弃 → 不留孤儿子消息
        // 第二轮审计修复：保留 is_error 语义。OpenAI 的 role:'tool' 没有该字段，旧实现直接
        // 丢掉 → 模型可能把**失败的工具调用当成成功**（然后基于错误结果继续推理）。
        // 约定俗成的降级做法是把错误标记前置到 content 里。
        const text = toolResultText(b.content);
        messages.push({
          role: 'tool',
          tool_call_id: String(b.tool_use_id || ''),
          content: b.is_error ? '[tool_error] ' + (text || '(no output)') : text,
        });
      }
    }
    const parts = anthropicPartsToOpenAI(content);
    if (parts.length) {
      messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    }
  }

  const out = {
    model: body.model,
    messages,
  };
  // 第二轮审计修复：Anthropic 协议规定 max_tokens 必填，但网关只校验 model；
  // 客户端漏传时 `max_tokens: undefined` 会被 JSON.stringify **整个丢掉该键**，
  // 而部分 OpenAI 上游对缺键直接 400。给一个保守兜底（4096），仅缺失时生效。
  const maxTokens = Number(body.max_tokens);
  out.max_tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096;
  if (droppedCount) {
    // 去重（2026-09-17）：同一段坏历史会在**每个请求**上重复命中（实测 165 行/天，淹没有效日志）。
    // 丢弃行为不受影响，只是告警改成"首次 + 每 100 次汇总一行"。
    emptyToolUseDropHits += 1;
    if (emptyToolUseDropHits === 1 || emptyToolUseDropHits % 100 === 0) {
      log(`翻译告警：历史里有 ${droppedCount} 个**名字为空**的 tool_use（及其 tool_result）已丢弃——`
        + `否则回传给上游会 400（该轮可能由此前版本的空名 bug 产生）；本进程累计命中 ${emptyToolUseDropHits} 次请求`
        + `${emptyToolUseDropHits === 1 ? '' : '（同类告警已静默，每 100 次汇总一行）'}`);
    }
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: String(t && t.name || ''),
        ...(t && t.description ? { description: String(t.description) } : {}),
        parameters: (t && t.input_schema) || { type: 'object', properties: {} },
      },
    }));
  }
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    const tc = body.tool_choice;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: String(tc.name) } };
  }
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  // thinking(budget_tokens) → reasoning_effort 粗映射；再由 translateBody 按 provider.reasoningEffortMap 归一
  const th = body.thinking;
  if (th && typeof th === 'object' && th.type !== 'disabled') {
    const budget = Number(th.budget_tokens) || 0;
    // 第二轮审计修复：budget 缺失/为 0 时旧实现落到 'low'，把"未指定预算"显式降成**最低档**
    // （配了 reasoningEffortMap 的家会真的把这个档位发出去，而不是让上游用默认）。
    // 语义上"未指定"就该不下发该字段 —— 只有真给了正数预算才映射档位。
    if (budget > 0) {
      out.reasoning_effort = budget >= 16384 ? 'max' : budget >= 8192 ? 'high' : budget >= 2048 ? 'medium' : 'low';
    }
  }
  return out;
}

/** Anthropic stop_reason 映射（OpenAI finish_reason → Anthropic） */
function stopReasonFromFinish(finish) {
  switch (String(finish || '').toLowerCase()) {
    case 'tool_calls': case 'function_call': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'refusal';
    default: return 'end_turn';
  }
}

/** 粗略 token 估算（上游不给 usage 时兜底：约 4 字符/token）——好过报 0 让客户端以为上下文为空 */
const estimateTokens = (s) => Math.max(1, Math.ceil(String(s || '').length / 4));

/* ==================================================================================
 * 协议矩阵：**任意客户端协议 × 任意上游协议**
 *
 * 用户要求（2026-10-08）：*"不论上游模型是什么协议，llm-gateway 对外需要同时提供
 * openai 和 Anthropic 协议，同时 openai 还得支持 responses"*。
 *
 * 现状实测（`out/_matrix.cjs` 用假上游逐格探过）—— 9 格里 5 格是坏的，
 * 而且**不是报错，是返回 200 带着错的响应体形状**：
 *
 *     上游 \ 客户端      chat            anthropic        responses
 *     openai-chat       ✅              ✅               ❌ 返回 chat 形状
 *     anthropic-msgs    ❌ 返回 message  ✅               ❌
 *     openai-responses  ❌              ❌               ✅
 *
 * 静默错形状比报错更难查：客户端拿到 200，解析时才炸。
 *
 * ## 架构：以 **OpenAI chat** 为轴做双向归一
 *
 * 不写 6 对互相翻译（那是 12 个函数且组合爆炸），而是：
 *   请求：  client 体 --decode--> **canonical(chat)** --encode--> 上游体
 *   响应：  上游体 --decode--> **canonical(chat)** --encode--> 客户端体
 *   流式：  上游帧 --decode--> **canonical 事件** --encode--> 客户端帧
 *
 * 这样只需要：请求 3 个 encode + 3 个 decode（chat 侧是恒等，实际 4 个函数）、
 * 响应同理、流式 3 个解码器 + 3 个编码器 —— **共 ~14 个函数覆盖全部 9 格**，
 * 而且"两次翻译"的格子（如 responses 客户端 → anthropic 上游）自动由串联得到。
 *
 * 为什么轴选 chat 而不是 Anthropic：chat 的形状最通用（tools 自带 JSON Schema、
 * 工具调用与结果都在 messages 里），Anthropic 与 Responses 都能无损落到它上面。
 * 现有的 `anthropicToOpenAIRequest` / `openaiToAnthropicMessage` 正好就是轴的两侧，
 * 直接复用，一点不浪费。
 * ================================================================================== */

/** 线协议名的归一化（配置里可能写别名）。 */
function wireOfName(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  if (s === 'openai-chat' || s === 'openai-completions' || s === 'openai' || s === 'chat') return 'openai-chat';
  if (s === 'anthropic' || s === 'anthropic-messages' || s === 'messages') return 'anthropic-messages';
  if (s === 'openai-responses' || s === 'responses') return 'openai-responses';
  return null;
}

/** 客户端请求路径 → 线协议。 */
function wireOfClientPath(pathname) {
  const p = String(pathname || '');
  if (p === '/v1/messages') return 'anthropic-messages';
  if (p === '/v1/responses') return 'openai-responses';
  if (p === '/v1/chat/completions') return 'openai-chat';
  return null;
}

/**
 * 该模型这次该用哪条上游线协议。
 * 优先级：**模型条目的 `api`** → `provider.protocol` → null（null = 跟随客户端，纯透传）。
 *
 * 为什么必须支持**逐模型**：同一个供应商的模型可能分属不同协议 —— 实测 opencode-go
 * 的 37 个模型里 29 个走 chat、2 个走 anthropic、4 个走 responses。只有供应商级
 * `protocol` 时，37 个只能挑一种，另外两种必然 400。
 */
function resolveUpstreamWire(provider, logical, hasImage) {
  const e = upstreamEntryFor(provider, logical, hasImage);
  const fromModel = e ? wireOfName(e.api) : null;
  if (fromModel) return fromModel;
  return wireOfName(providerProtocol(provider));
}

/* ---------------- 请求侧：canonical(=OpenAI chat) ↔ 另外两种协议 ---------------- */

/** Responses `input` 项 → chat messages。 */
function responsesInputToChatMessages(input) {
  const out = [];
  // ⚠ 三种形态都要接住：字符串 / 数组 / **单个对象**。
  // 旧实现只认前两种（`Array.isArray(input) ? input : []`），于是 `input` 是单个对象时
  // 整段用户输入被丢光 —— 实测（2026-10-08 审计复现）：上游收到 `messages: []`，
  // 客户端却拿到 **HTTP 200**，模型对空输入作答。这种"200 + 默默答错"最难排查。
  const items = typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }]
    : Array.isArray(input) ? input
      : (input && typeof input === 'object' ? [input] : []);
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'function_call') {
      out.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: String(it.call_id || it.id || 'call_' + Math.random().toString(36).slice(2, 10)),
          type: 'function',
          function: { name: String(it.name || ''), arguments: String(it.arguments == null ? '{}' : it.arguments) },
        }],
      });
      continue;
    }
    if (it.type === 'function_call_output') {
      out.push({
        role: 'tool',
        tool_call_id: String(it.call_id || ''),
        content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output == null ? '' : it.output),
      });
      continue;
    }
    if (it.type === 'reasoning') continue;   // 推理项不回灌给上游（各家自己会重算）
    // message / 其它：把 content 块拍平成文本（图片按 OpenAI 的 image_url 块保留）
    const role = it.role === 'assistant' ? 'assistant' : (it.role === 'system' || it.role === 'developer' ? 'system' : 'user');
    let text = '';
    const parts = [];
    if (typeof it.content === 'string') text = it.content;
    else if (Array.isArray(it.content)) {
      for (const b of it.content) {
        if (!b || typeof b !== 'object') continue;
        if (typeof b.text === 'string') { text += b.text; parts.push({ type: 'text', text: b.text }); continue; }
        // ⚠ 图片**必须原样映射成 image_url**，不能塞一个字面量占位符。
        // 旧实现在这里 `return '[image]'` —— 等于把图换成四个字母：模型再也看不到图，
        // 而 imageBlockStats 仍按图片计数（"带图请求只发给声明了 vision 的家"那套逻辑
        // 照常生效），于是路由到支持图片的家、却发过去一句 "[image]"，两头都不对。
        // 同项目的 anthropicPartsToOpenAI 对同义块是正确产出 image_url 的，这里补齐。
        if (b.type === 'input_image' || b.type === 'image_url') {
          const url = typeof b.image_url === 'string' ? b.image_url
            : (b.image_url && b.image_url.url) || b.image_url || '';
          if (url) parts.push({ type: 'image_url', image_url: { url: String(url) } });
          continue;
        }
      }
    }
    out.push({ role, content: parts.some((p) => p.type === 'image_url') ? parts : text });
  }
  return out;
}

/** Responses 请求体 → canonical(chat) 请求体。 */
function responsesToChatRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const messages = responsesInputToChatMessages(b.input);
  if (typeof b.instructions === 'string' && b.instructions.trim()) {
    messages.unshift({ role: 'system', content: b.instructions });
  }
  const out = { model: b.model, messages, stream: !!b.stream };
  // ⚠ 两者的 tools 形状不同：Responses 是**扁平**的 {type,name,description,parameters}，
  //   chat 是嵌套的 {type,function:{name,description,parameters}}。实测踩过：直接把
  //   Responses 的 tools 塞进 chat 请求，上游把 function 当成 undefined → 400。
  if (Array.isArray(b.tools) && b.tools.length) {
    out.tools = b.tools.map((t) => {
      if (!t || typeof t !== 'object') return null;
      if (t.function && typeof t.function === 'object') return t;   // 已经是 chat 形状
      return {
        type: 'function',
        function: {
          name: String(t.name || ''),
          description: String(t.description || ''),
          parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
        },
      };
    }).filter(Boolean);
  }
  if (b.tool_choice !== undefined) {
    // Responses 的 tool_choice 是字符串或 {type:'function',name}；chat 要 {type,function:{name}}
    const tc = b.tool_choice;
    out.tool_choice = (tc && typeof tc === 'object' && tc.type === 'function' && tc.name)
      ? { type: 'function', function: { name: String(tc.name) } }
      : tc;
  }
  if (b.max_output_tokens !== undefined) out.max_tokens = b.max_output_tokens;
  if (b.temperature !== undefined) out.temperature = b.temperature;
  if (b.top_p !== undefined) out.top_p = b.top_p;
  if (b.metadata !== undefined) out.metadata = b.metadata;
  if (b.reasoning && typeof b.reasoning === 'object' && b.reasoning.effort) out.reasoning_effort = b.reasoning.effort;
  // 停止序列：三种协议叫法不同，但都得带上 —— 这是**唯一**一格漏掉它的地方
  //（chatToAnthropicRequest 与 chatToResponsesRequest 都处理了，只有这一支漏了）。
  // 漏掉的后果是"用户设了停止词却没生效"，不报错、只是行为不对，最难察觉。
  if (b.stop !== undefined) out.stop = b.stop;
  if (b.seed !== undefined) out.seed = b.seed;
  if (b.presence_penalty !== undefined) out.presence_penalty = b.presence_penalty;
  if (b.frequency_penalty !== undefined) out.frequency_penalty = b.frequency_penalty;
  // ⚠ 这几个是 Responses 的**有状态**字段，chat 上游没有对应概念（它靠客户端把历史重发过来）。
  // 静默丢掉它们会让"多轮只带 previous_response_id、不带 input"变成一次空对话且回 200 ——
  // 与其装作无事发生，不如明确记一条，让用户在日志里看到"这段历史没能带过去"。
  for (const k of ['previous_response_id', 'store', 'include', 'truncation', 'parallel_tool_calls']) {
    if (b[k] !== undefined && b[k] !== null) {
      log(`[matrix] Responses 的有状态字段 ${k} 在 chat 上游无对应概念，已丢弃（如需多轮请把历史放进 input）`);
    }
  }
  return out;
}

/** canonical(chat) 请求体 → Anthropic 请求体。 */
function chatToAnthropicRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const msgs = Array.isArray(b.messages) ? b.messages : [];
  const systemParts = [];
  const out = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof m.content === 'string' && m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      // chat 的 role:tool → Anthropic 的 user + tool_result 块
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(m.tool_call_id || ''),
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content),
        }],
      });
      continue;
    }
    const blocks = [];
    if (typeof m.content === 'string') {
      if (m.content) blocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
        else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
          const url = String(part.image_url.url);
          const mm = /^data:([^;]+);base64,(.*)$/.exec(url);
          blocks.push(mm
            ? { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } }
            : { type: 'image', source: { type: 'url', url } });
        }
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        let input = {};
        try { input = JSON.parse((c.function && c.function.arguments) || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: String(c.id || 'toolu_' + Math.random().toString(36).slice(2, 10)), name: String((c.function && c.function.name) || ''), input });
      }
    }
    // Anthropic 不接受 assistant 轮的空 content 数组
    if (!blocks.length) continue;
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks });
  }
  const req = {
    model: b.model,
    // ⚠ max_tokens 在 Anthropic 是**必填**；chat 里可缺省 → 给一个保守值而不是让上游 400
    max_tokens: Number(b.max_tokens) > 0 ? Number(b.max_tokens) : 4096,
    messages: out,
    stream: !!b.stream,
  };
  if (systemParts.length) req.system = systemParts.join('\n\n');
  if (Array.isArray(b.tools) && b.tools.length) {
    req.tools = b.tools.map((t) => {
      const fn = (t && t.function) || {};
      return {
        name: String(fn.name || ''),
        description: String(fn.description || ''),
        input_schema: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
      };
    }).filter((t) => t.name);
  }
  if (b.tool_choice !== undefined) {
    const tc = b.tool_choice;
    if (tc === 'auto') req.tool_choice = { type: 'auto' };
    else if (tc === 'required') req.tool_choice = { type: 'any' };
    else if (tc === 'none') req.tool_choice = { type: 'none' };
    else if (tc && typeof tc === 'object' && tc.function && tc.function.name) req.tool_choice = { type: 'tool', name: String(tc.function.name) };
    else if (tc && typeof tc === 'object' && tc.name) req.tool_choice = { type: 'tool', name: String(tc.name) };
  }
  if (b.temperature !== undefined) req.temperature = b.temperature;
  if (b.top_p !== undefined) req.top_p = b.top_p;
  if (Array.isArray(b.stop) && b.stop.length) req.stop_sequences = b.stop.map(String);
  else if (typeof b.stop === 'string' && b.stop) req.stop_sequences = [b.stop];
  return req;
}

/** canonical(chat) 请求体 → Responses 请求体。 */
function chatToResponsesRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const input = [];
  let instructions = '';
  for (const m of (Array.isArray(b.messages) ? b.messages : [])) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof m.content === 'string' && m.content) instructions = instructions ? instructions + '\n\n' + m.content : m.content;
      continue;
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(m.tool_call_id || ''), output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content) });
      continue;
    }
    if (Array.isArray(m.tool_calls)) {
      if (typeof m.content === 'string' && m.content) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      for (const c of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: String(c.id || ''),
          name: String((c.function && c.function.name) || ''),
          arguments: String((c.function && c.function.arguments) || '{}'),
        });
      }
      continue;
    }
    const text = typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('') : '');
    input.push({
      type: 'message',
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text }],
    });
  }
  const out = { model: b.model, input, stream: !!b.stream };
  if (instructions) out.instructions = instructions;
  if (Array.isArray(b.tools) && b.tools.length) {
    // chat 的嵌套形状 → Responses 的**扁平**形状（实测：不拍平上游认不出工具）
    out.tools = b.tools.map((t) => {
      if (t && t.type === 'function' && t.name) return t;   // 已是扁平
      const fn = (t && t.function) || {};
      return {
        type: 'function',
        name: String(fn.name || ''),
        description: String(fn.description || ''),
        parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
      };
    }).filter((t) => t.name);
  }
  if (b.tool_choice !== undefined) {
    const tc = b.tool_choice;
    out.tool_choice = (tc && typeof tc === 'object' && tc.function && tc.function.name)
      ? { type: 'function', name: String(tc.function.name) }
      : tc;
  }
  if (b.max_tokens !== undefined) out.max_output_tokens = b.max_tokens;
  if (b.temperature !== undefined) out.temperature = b.temperature;
  if (b.top_p !== undefined) out.top_p = b.top_p;
  if (b.reasoning_effort) out.reasoning = { effort: b.reasoning_effort };
  // 停止序列（chat 的 `stop` → Responses 的... Responses 规范里没有 stop 字段，
  // 但多数兼容实现认 `stop`；带上它比丢掉更接近用户意图，且不影响不认它的上游）
  if (b.stop !== undefined) out.stop = b.stop;
  if (b.seed !== undefined) out.seed = b.seed;
  return out;
}

/**
 * 把客户端请求体翻译成上游要的形状（**矩阵的请求侧**）。
 * @param {object} body 客户端请求体
 * @param {string} clientWire 客户端协议
 * @param {string} upstreamWire 上游协议
 * @param {object} provider 供应商（多数转换器用不到，留给将来按家微调）
 * @returns {object} 上游请求体（同协议时原样返回）
 */
function translateMatrixRequest(body, clientWire, upstreamWire, provider) {
  if (!upstreamWire || upstreamWire === clientWire) return body;
  // ① 解码：client → canonical(chat)
  let canon;
  if (clientWire === 'openai-chat') canon = body;
  else if (clientWire === 'anthropic-messages') canon = anthropicToOpenAIRequest(body, provider);
  else if (clientWire === 'openai-responses') canon = responsesToChatRequest(body);
  else return body;   // 未知客户端协议：不动
  // ② 编码：canonical(chat) → upstream
  let out;
  if (upstreamWire === 'openai-chat') out = canon;
  else if (upstreamWire === 'anthropic-messages') out = chatToAnthropicRequest(canon);
  else if (upstreamWire === 'openai-responses') out = chatToResponsesRequest(canon);
  else out = canon;
  // ③ ⚠ `stream` 必须按**客户端原始请求**对齐，不能被中间翻译弄丢。
  // 实测踩到：`anthropicToOpenAIRequest` 不复制 stream 字段，于是
  // 「Anthropic 客户端要流式 → Responses 上游」这条路上游收到 stream:false 回了 JSON，
  // 而客户端在等 SSE —— 表现为 **HTTP 200 + 空事件流**（最难看的一种失败：
  // 状态码是好的人却什么都没收到）。各家的翻译函数对 stream 的处理本来就该由这一层统一兜住。
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    out = Object.assign({}, out, { stream: !!body.stream });
  }
  return out;
}

/* ---------------- 响应侧（非流式）：canonical(=OpenAI chat) ↔ 另外两种 ---------------- */

/** chat 的 finish_reason → Anthropic stop_reason（已有 stopReasonFromFinish 的逆） */
function finishFromStopReason(sr) {
  switch (String(sr || '').toLowerCase()) {
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'length';
    case 'refusal': return 'content_filter';
    default: return 'stop';
  }
}

/** Anthropic message → canonical(chat) completion。 */
function anthropicMessageToChatCompletion(json, model) {
  const j = json && typeof json === 'object' ? json : {};
  const blocks = Array.isArray(j.content) ? j.content : [];
  const msg = { role: 'assistant', content: '' };
  let text = '';
  let thinking = '';
  const calls = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') text += b.text;
    else if (b.type === 'thinking' && typeof b.thinking === 'string') thinking += b.thinking;
    else if (b.type === 'tool_use') {
      calls.push({
        id: String(b.id || 'call_' + Math.random().toString(36).slice(2, 10)),
        type: 'function',
        function: { name: String(b.name || ''), arguments: JSON.stringify(b.input === undefined ? {} : b.input) },
      });
    }
  }
  msg.content = text;
  if (thinking) msg.reasoning_content = thinking;
  if (calls.length) msg.tool_calls = calls;
  const u = j.usage || {};
  return {
    id: String(j.id || 'chatcmpl-' + Math.random().toString(36).slice(2, 12)),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: finishFromStopReason(j.stop_reason) }],
    usage: {
      prompt_tokens: Number(u.input_tokens) || 0,
      completion_tokens: Number(u.output_tokens) || 0,
      total_tokens: (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0),
    },
  };
}

/** Responses 响应 → canonical(chat) completion。 */
function responsesToChatCompletion(json, model) {
  const j = json && typeof json === 'object' ? json : {};
  const out = Array.isArray(j.output) ? j.output : [];
  let text = '';
  let thinking = '';
  const calls = [];
  for (const item of out) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'reasoning') {
      const t = (Array.isArray(item.summary) ? item.summary : []).map((s) => (s && s.text) || '').join('');
      if (t) thinking += t;
      continue;
    }
    if (item.type === 'function_call') {
      calls.push({
        id: String(item.call_id || item.id || 'call_' + Math.random().toString(36).slice(2, 10)),
        type: 'function',
        function: { name: String(item.name || ''), arguments: String(item.arguments == null ? '{}' : item.arguments) },
      });
      continue;
    }
    if (Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && typeof c.text === 'string' && (c.type === 'output_text' || c.type === 'text')) text += c.text;
        else if (c && typeof c.refusal === 'string') text += c.refusal;
      }
    }
  }
  const msg = { role: 'assistant', content: text };
  if (thinking) msg.reasoning_content = thinking;
  if (calls.length) msg.tool_calls = calls;
  const u = j.usage || {};
  const inTok = Number(u.input_tokens) || 0;
  const outTok = Number(u.output_tokens) || 0;
  // Responses 的终态是 status + incomplete_details，不是 finish_reason
  let finish = 'stop';
  if (calls.length) finish = 'tool_calls';
  else if (j.status === 'incomplete') {
    const reason = (j.incomplete_details && j.incomplete_details.reason) || '';
    finish = /max/i.test(String(reason)) ? 'length' : 'stop';
  }
  return {
    id: String(j.id || 'chatcmpl-' + Math.random().toString(36).slice(2, 12)),
    object: 'chat.completion',
    created: Math.floor((Number(j.created_at) || (Date.now() / 1000))),
    model,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: Number(u.total_tokens) || (inTok + outTok) },
  };
}

/** canonical(chat) completion → Responses 响应。 */
function chatToResponsesResponse(json, model) {
  const j = json && typeof json === 'object' ? json : {};
  const choice = (Array.isArray(j.choices) ? j.choices[0] : null) || {};
  const msg = choice.message || {};
  const output = [];
  const reasoning = reasoningTextOf(msg);
  if (reasoning) output.push({ id: 'rs_' + Math.random().toString(36).slice(2, 12), type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] });
  if (typeof msg.content === 'string' && msg.content) {
    output.push({
      id: 'msg_' + Math.random().toString(36).slice(2, 12),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: msg.content, annotations: [] }],
    });
  }
  for (const c of (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])) {
    output.push({
      id: 'fc_' + Math.random().toString(36).slice(2, 12),
      type: 'function_call',
      status: 'completed',
      call_id: String(c.id || ''),
      name: String((c.function && c.function.name) || ''),
      arguments: String((c.function && c.function.arguments) || '{}'),
    });
  }
  const u = j.usage || {};
  const inTok = Number(u.prompt_tokens) || 0;
  const outTok = Number(u.completion_tokens) || 0;
  const incomplete = choice.finish_reason === 'length';
  return {
    id: String(j.id && /^resp/.test(j.id) ? j.id : 'resp_' + Math.random().toString(36).slice(2, 14)),
    object: 'response',
    created_at: Number(j.created) || Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    model,
    output,
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    usage: { input_tokens: inTok, output_tokens: outTok, total_tokens: Number(u.total_tokens) || (inTok + outTok) },
  };
}

/**
 * 把上游响应翻译成客户端要的形状（**矩阵的响应侧，非流式**）。
 * 与 `translateMatrixRequest` 对称：上游 → canonical(chat) → 客户端。
 */
function translateMatrixResponse(json, upstreamWire, clientWire, model, inputTokens) {
  if (!upstreamWire || upstreamWire === clientWire) return json;
  let canon;
  if (upstreamWire === 'openai-chat') canon = json;
  else if (upstreamWire === 'anthropic-messages') canon = anthropicMessageToChatCompletion(json, model);
  else if (upstreamWire === 'openai-responses') canon = responsesToChatCompletion(json, model);
  else return json;

  if (clientWire === 'openai-chat') return canon;
  if (clientWire === 'anthropic-messages') {
    return openaiToAnthropicMessage(canon, model, inputTokens);
  }
  if (clientWire === 'openai-responses') return chatToResponsesResponse(canon, model);
  return canon;
}

/* ==================================================================================
 * 流式矩阵：canonical 事件管线
 *
 * 三种协议的 SSE 帧形状完全不同，但**语义**是同一套：开始 → 文本增量 / 思考增量 /
 * 工具调用（开始+参数增量）→ 结束原因 → 用量 → 结束。
 *
 * 所以不写"每对协议一个翻译器"（那是 6 个单体函数、组合爆炸），而是：
 *     上游帧 --decode--> **canonical 事件** --encode--> 客户端帧
 * 三个解码器 + 三个编码器覆盖全部 9 格；"跨两次"的格子（responses 客户端 → anthropic 上游）
 * 自动由同一根管子得到，不需要另写代码。
 *
 * canonical 事件（就这几个，多了没用）：
 *   {t:'start'}                              流开始
 *   {t:'think', d}                           思考/推理增量
 *   {t:'text',  d}                           正文增量
 *   {t:'tool',  i, id?, name?}               工具调用开始（i = 槽位）
 *   {t:'args',  i, d}                        工具参数增量
 *   {t:'stop',  r}                           结束原因（canonical 用 chat 的措辞）
 *   {t:'usage', in, out}                     用量
 *   {t:'end'}                                流结束
 * ================================================================================== */

/** 上游线协议 → 上游请求路径（相对 /v1）。 */
function upstreamPathOfWire(wire) {
  if (wire === 'anthropic-messages') return '/messages';
  if (wire === 'openai-responses') return '/responses';
  return '/chat/completions';
}

/** 建一个上游 SSE 解码器：帧 → canonical 事件。 */
function makeStreamDecoder(wire) {
  const st = { tools: new Map(), nextSlot: 0 };

  const toolSlot = (key, id, name) => {
    // 有些上游不给 index，只给 id；两种都要能落槽，否则参数会串到别的调用上
    const k = key !== undefined && key !== null && key !== '' ? String(key) : (id ? 'id:' + id : 'n:' + st.nextSlot);
    if (!st.tools.has(k)) st.tools.set(k, st.nextSlot++);
    return st.tools.get(k);
  };

  return {
    feed(evtName, json) {
      const ev = [];
      const j = json && typeof json === 'object' ? json : {};

      if (wire === 'openai-chat') {
        if (j.usage && (j.usage.prompt_tokens || j.usage.completion_tokens)) {
          ev.push({ t: 'usage', in: Number(j.usage.prompt_tokens) || 0, out: Number(j.usage.completion_tokens) || 0 });
        }
        const choice = (Array.isArray(j.choices) ? j.choices[0] : null) || {};
        const d = choice.delta || {};
        const think = reasoningTextOf(d);
        if (think) ev.push({ t: 'think', d: think });
        if (typeof d.content === 'string' && d.content) ev.push({ t: 'text', d: d.content });
        for (const c of (Array.isArray(d.tool_calls) ? d.tool_calls : [])) {
          const slot = toolSlot(c.index, c.id);
          const name = (c.function && c.function.name) || '';
          if (name) ev.push({ t: 'tool', i: slot, id: String(c.id || ''), name: String(name) });
          const args = (c.function && c.function.arguments) || '';
          if (args) ev.push({ t: 'args', i: slot, d: String(args) });
        }
        if (choice.finish_reason) ev.push({ t: 'stop', r: finishFromStopReason(choice.finish_reason) === 'tool_calls' ? 'tool_calls' : String(choice.finish_reason) });
        return ev;
      }

      if (wire === 'anthropic-messages') {
        const type = String(evtName || j.type || '');
        if (type === 'message_start') {
          const u = (j.message && j.message.usage) || {};
          if (u.input_tokens) ev.push({ t: 'usage', in: Number(u.input_tokens) || 0, out: 0 });
          return ev;
        }
        if (type === 'content_block_start') {
          const b = j.content_block || {};
          if (b.type === 'tool_use') ev.push({ t: 'tool', i: Number(j.index) || 0, id: String(b.id || ''), name: String(b.name || '') });
          return ev;
        }
        if (type === 'content_block_delta') {
          const d = j.delta || {};
          if (d.type === 'text_delta' && d.text) ev.push({ t: 'text', d: String(d.text) });
          else if (d.type === 'thinking_delta' && d.thinking) ev.push({ t: 'think', d: String(d.thinking) });
          else if (d.type === 'input_json_delta' && d.partial_json) ev.push({ t: 'args', i: Number(j.index) || 0, d: String(d.partial_json) });
          return ev;
        }
        if (type === 'message_delta') {
          const d = j.delta || {};
          if (d.stop_reason) ev.push({ t: 'stop', r: finishFromStopReason(d.stop_reason) });
          const u = j.usage || {};
          if (u.output_tokens !== undefined) ev.push({ t: 'usage', in: 0, out: Number(u.output_tokens) || 0 });
          return ev;
        }
        return ev;
      }

      if (wire === 'openai-responses') {
        const type = String(evtName || j.type || '');
        if (type === 'response.output_text.delta' && typeof j.delta === 'string') { ev.push({ t: 'text', d: j.delta }); return ev; }
        if (type === 'response.reasoning_summary_text.delta' && typeof j.delta === 'string') { ev.push({ t: 'think', d: j.delta }); return ev; }
        if (type === 'response.output_item.added') {
          const it = j.item || {};
          if (it.type === 'function_call') ev.push({ t: 'tool', i: Number(j.output_index) || 0, id: String(it.call_id || it.id || ''), name: String(it.name || '') });
          return ev;
        }
        if (type === 'response.function_call_arguments.delta' && typeof j.delta === 'string') { ev.push({ t: 'args', i: Number(j.output_index) || 0, d: j.delta }); return ev; }
        if (type === 'response.completed' || type === 'response.incomplete') {
          const r = j.response || {};
          const u = r.usage || {};
          if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
            ev.push({ t: 'usage', in: Number(u.input_tokens) || 0, out: Number(u.output_tokens) || 0 });
          }
          const hasCall = (Array.isArray(r.output) ? r.output : []).some((x) => x && x.type === 'function_call');
          ev.push({ t: 'stop', r: hasCall ? 'tool_calls' : (/incomplete/.test(type) ? 'length' : 'stop') });
          ev.push({ t: 'end' });
          return ev;
        }
        return ev;
      }
      return ev;
    },
  };
}

/**
 * 建一个客户端 SSE 编码器：canonical 事件 → 客户端帧。
 * @param {object} ctx { res, model, inputTokens } —— inputTokens 用于 Anthropic 的 message_start
 */
function makeStreamEncoder(wire, ctx) {
  const res = ctx.res;
  let started = false;
  let blockIndex = -1;
  let openKind = null;         // 'text' | 'think' | 'tool'
  let stopReason = 'end_turn';
  const toolSlots = new Map(); // canonical slot → { blockIndex, id }
  let usageIn = ctx.inputTokens || 0;
  let usageOut = 0;
  let ended = false;
  // ⚠ Responses 的 id 必须**整条流共用一个**。旧实现在 response.created 和 response.completed
  // 里各调一次 randomUUID()，于是同一条响应出现两个 id（实测 resp_2537c6… vs resp_008f6f…），
  // 客户端拿 created.id 去做 previous_response_id / GET /v1/responses/{id} 会找不到。
  // 同时把 output 累积起来回填到 completed —— 旧实现恒为 []，客户端拿不到最终内容。
  const respId = 'resp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  let outText = '';
  let outThink = '';
  const outTools = [];
  const toolBySlot = new Map();   // canonical 槽位 → outTools 里的对象（用于把参数增量拼回同一个调用）

  const start = () => {
    if (started) return;
    started = true;
    if (wire === 'anthropic-messages') {
      sseWrite(res, 'message_start', {
        type: 'message_start',
        message: {
          id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
          type: 'message', role: 'assistant', model: ctx.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: usageIn, output_tokens: 0 },
        },
      });
      return;
    }
    if (wire === 'openai-responses') {
      sseWrite(res, 'response.created', {
        type: 'response.created',
        response: { id: respId, object: 'response', status: 'in_progress', model: ctx.model, output: [] },
      });
      return;
    }
    // openai-chat
    sseWrite(res, 'message', {
      id: 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20),
      object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: ctx.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
  };

  const closeAnthropicBlock = () => {
    if (wire !== 'anthropic-messages' || openKind === null) return;
    sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    openKind = null;
  };

  return {
    /** 收尾：写出结束帧。**幂等** —— 上游给了结束帧、pump 收尾又调一次也不会重复写。 */
    finish() {
      if (ended) return;
      ended = true;
      start();
      if (wire === 'anthropic-messages') {
        closeAnthropicBlock();
        sseWrite(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usageOut } });
        sseWrite(res, 'message_stop', { type: 'message_stop' });
        return;
      }
      if (wire === 'openai-responses') {
        // 与 response.created 用**同一个** respId，并回填真实 output
        const output = [];
        if (outThink) output.push({ id: 'rs_out', type: 'reasoning', summary: [{ type: 'summary_text', text: outThink }] });
        if (outText) output.push({ id: 'msg_out', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: outText, annotations: [] }] });
        for (const t of outTools) {
          output.push({ id: t.id || 'fc_out', type: 'function_call', status: 'completed', call_id: t.id || '', name: t.name || '', arguments: t.args || '{}' });
        }
        sseWrite(res, 'response.completed', {
          type: 'response.completed',
          response: {
            id: respId,
            object: 'response', status: 'completed', model: ctx.model, output,
            usage: { input_tokens: usageIn, output_tokens: usageOut, total_tokens: usageIn + usageOut },
          },
        });
        return;
      }
      sseWrite(res, 'message', {
        id: 'chatcmpl', object: 'chat.completion.chunk', created: 0, model: ctx.model,
        choices: [{ index: 0, delta: {}, finish_reason: stopReason || 'stop' }],
        usage: { prompt_tokens: usageIn, completion_tokens: usageOut, total_tokens: usageIn + usageOut },
      });
      try { res.write('data: [DONE]\n\n'); } catch { /* 客户端已断开 */ }
    },
    emit(events) {
      for (const e of events) {
        if (!e) continue;
        // 累积最终内容（供 Responses 的 completed.output 回填；顺带让收尾帧不依赖上游再给一次全量）
        if (e.t === 'text') outText += e.d;
        else if (e.t === 'think') outThink += e.d;
        else if (e.t === 'tool') {
          const t = { id: e.id, name: e.name, args: '' };
          outTools.push(t);
          toolBySlot.set(e.i, t);
        } else if (e.t === 'args') {
          const t = toolBySlot.get(e.i);
          if (t) t.args += e.d;
        }
        start();
        if (wire === 'anthropic-messages') {
          if (e.t === 'text' || e.t === 'think') {
            const kind = e.t === 'text' ? 'text' : 'think';
            if (openKind !== kind) {
              closeAnthropicBlock();
              blockIndex++;
              openKind = kind;
              sseWrite(res, 'content_block_start', {
                type: 'content_block_start', index: blockIndex,
                content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
              });
            }
            sseWrite(res, 'content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: kind === 'text' ? { type: 'text_delta', text: e.d } : { type: 'thinking_delta', thinking: e.d },
            });
          } else if (e.t === 'tool') {
            closeAnthropicBlock();
            blockIndex++;
            openKind = 'tool';
            toolSlots.set(e.i, { blockIndex, id: e.id });
            sseWrite(res, 'content_block_start', {
              type: 'content_block_start', index: blockIndex,
              content_block: { type: 'tool_use', id: e.id || ('toolu_' + Math.random().toString(36).slice(2, 10)), name: e.name || '' },
            });
          } else if (e.t === 'args') {
            const slot = toolSlots.get(e.i);
            if (slot) sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: slot.blockIndex, delta: { type: 'input_json_delta', partial_json: e.d } });
          } else if (e.t === 'stop') {
            stopReason = e.r === 'tool_calls' ? 'tool_use' : stopReasonFromFinish(e.r);
            if (e.r === 'tool_calls') stopReason = 'tool_use';
            else if (e.r === 'length') stopReason = 'max_tokens';
            else stopReason = 'end_turn';
          } else if (e.t === 'usage') {
            if (e.in) usageIn = e.in;
            if (e.out) usageOut = e.out;
          } else if (e.t === 'end') {
            this.finish();
          }
          continue;
        }
        if (wire === 'openai-responses') {
          if (e.t === 'text') sseWrite(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_out', output_index: 0, delta: e.d });
          else if (e.t === 'think') sseWrite(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: 'rs_out', output_index: -1, delta: e.d });
          else if (e.t === 'tool') sseWrite(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: e.i, item: { id: e.id || 'fc_out', type: 'function_call', status: 'in_progress', call_id: e.id || '', name: e.name || '', arguments: '' } });
          else if (e.t === 'args') sseWrite(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_out', output_index: e.i, delta: e.d });
          else if (e.t === 'usage') { if (e.in) usageIn = e.in; if (e.out) usageOut = e.out; }
          else if (e.t === 'stop') stopReason = e.r;
          else if (e.t === 'end') this.finish();
          continue;
        }
        // openai-chat
        if (e.t === 'text' || e.t === 'think') {
          const delta = e.t === 'text' ? { content: e.d } : { reasoning_content: e.d };
          sseWrite(res, 'message', { id: 'chatcmpl', object: 'chat.completion.chunk', created: 0, model: ctx.model, choices: [{ index: 0, delta, finish_reason: null }] });
        } else if (e.t === 'tool') {
          sseWrite(res, 'message', {
            id: 'chatcmpl', object: 'chat.completion.chunk', created: 0, model: ctx.model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: e.i, id: e.id || '', type: 'function', function: { name: e.name || '', arguments: '' } }] }, finish_reason: null }],
          });
        } else if (e.t === 'args') {
          sseWrite(res, 'message', {
            id: 'chatcmpl', object: 'chat.completion.chunk', created: 0, model: ctx.model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: e.i, function: { arguments: e.d } }] }, finish_reason: null }],
          });
        } else if (e.t === 'usage') {
          if (e.in) usageIn = e.in;
          if (e.out) usageOut = e.out;
        } else if (e.t === 'stop') {
          stopReason = e.r;
        } else if (e.t === 'end') {
          this.finish();
        }
      }
    },
  };
}

/** 把上游 SSE 逐帧喂给解码器，再编码给客户端。 */
async function pumpMatrixStream({ res, upstream, upstreamWire, clientWire, model, inputTokens, headBytes }) {
  const decoder = makeStreamDecoder(upstreamWire);
  const encoder = makeStreamEncoder(clientWire, { res, model, inputTokens });
  const reader = upstream.body.getReader();
  const td = new TextDecoder();
  let buf = headBytes ? Buffer.from(headBytes).toString('utf8') : '';
  let curEvent = '';
  let sawEnd = false;

  // ⚠ 必须做成**可重复调用**的：forward 里的"首事件偷看"会把开头那段（对流式短响应来说
  // 往往就是**全部**）先读进 headBytes，于是下面的 read 循环第一次就拿到 done:true ——
  // 如果只在循环体里解析缓冲区，那些已读字节**永远不会被解析**，客户端收到 200 + 空 body。
  // 实测就是这个现象：5 个跨协议格子全部 200/0 字节。
  const flush = () => {
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('event:')) { curEvent = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) { if (line === '') curEvent = ''; continue; }
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { sawEnd = true; encoder.finish(); continue; }
      let json = null;
      try { json = JSON.parse(payload); } catch { continue; }
      encoder.emit(decoder.feed(curEvent, json));
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += td.decode(value, { stream: true });
      flush();
    }
    flush();   // 收尾：偷看过的字节可能整条都在 buf 里（见上面的说明）
  } finally {
    try { reader.releaseLock(); } catch { /* 忽略 */ }
  }
  // 上游没有明确的结束帧时（如 Anthropic 的 message_stop 不映射成事件）也要收尾，
  // 否则客户端会一直等 message_stop / response.completed / [DONE]。
  if (!sawEnd) encoder.finish();
}

/** canonical 事件 → chat 的完整响应（用于"上游流式、客户端要非流式"）。 */
function canonicalToChatCompletion(acc, model) {
  const msg = { role: 'assistant', content: acc.text || '' };
  if (acc.thinking) msg.reasoning_content = acc.thinking;
  if (acc.tools.length) {
    msg.tool_calls = acc.tools.map((t) => ({
      id: t.id || ('call_' + Math.random().toString(36).slice(2, 10)),
      type: 'function',
      function: { name: t.name || '', arguments: t.args || '{}' },
    }));
  }
  let finish = 'stop';
  if (acc.tools.length) finish = 'tool_calls';
  else if (acc.stop === 'length' || acc.stop === 'max_tokens') finish = 'length';
  else if (acc.stop === 'content_filter') finish = 'content_filter';
  const inTok = acc.usageIn || 0;
  const outTok = acc.usageOut || 0;
  return {
    id: 'chatcmpl-' + Math.random().toString(36).slice(2, 14),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

/** 把 canonical 事件累积成完整响应（不写任何东西到 res）。 */
function makeCanonicalCollector() {
  const acc = { text: '', thinking: '', tools: [], stop: 'stop', usageIn: 0, usageOut: 0 };
  const bySlot = new Map();
  return {
    acc,
    feed(events) {
      for (const e of events) {
        if (!e) continue;
        if (e.t === 'text') acc.text += e.d;
        else if (e.t === 'think') acc.thinking += e.d;
        else if (e.t === 'tool') {
          const t = { id: e.id, name: e.name, args: '' };
          bySlot.set(e.i, t);
          acc.tools.push(t);
        } else if (e.t === 'args') {
          const t = bySlot.get(e.i);
          if (t) t.args += e.d;
        } else if (e.t === 'stop') acc.stop = e.r;
        else if (e.t === 'usage') { if (e.in) acc.usageIn = e.in; if (e.out) acc.usageOut = e.out; }
      }
    },
  };
}

/** 从上游流里按 canonical 管线读干净（用于聚合）。 */
async function drainCanonicalStream({ upstream, upstreamWire, collector, headBytes }) {
  const decoder = makeStreamDecoder(upstreamWire);
  const reader = upstream.body.getReader();
  const td = new TextDecoder();
  let buf = headBytes ? Buffer.from(headBytes).toString('utf8') : '';
  let curEvent = '';
  // ⚠ 与 `pumpMatrixStream` 同一个坑，必须同样的修法：flush 要能重复调用，
  // 且**循环结束后再调一次**。原因：forward 的"首事件偷看"会把开头那段先读进 headBytes，
  // 流短的时候循环第一次就可能拿到 done:true，只在循环体里解析会让那些字节永远不被解析。
  // （审计发现：本函数当初漏了这一手，而上游流式 + 客户端非流式的组合正好走这里，
  //   表现为**最后一帧被静默吞掉**、usage 记 0。）
  const flush = () => {
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('event:')) { curEvent = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) { if (line === '') curEvent = ''; continue; }
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json = null;
      try { json = JSON.parse(payload); } catch { continue; }
      collector.feed(decoder.feed(curEvent, json));
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += td.decode(value, { stream: true });
      flush();
    }
    flush();
  } finally {
    // 尾部还剩着不成帧的残句 → 记一条，否则"少了一帧"永远没人知道
    if (buf.trim()) log(`[matrix] 上游流结束时仍有未成帧的残句（${buf.length}B），已丢弃：${buf.slice(0, 80)}`);
    try { reader.releaseLock(); } catch { /* 忽略 */ }
  }
}

/**
 * 矩阵响应分支：上游协议 ≠ 客户端协议时，翻译后再写给客户端。
 *
 * 调用位置很关键（在 forward 里）：**必须晚于"首事件偷看"**（那时才确认上游给的是正常流），
 * 又**必须早于任何 res.writeHead** —— 一旦写了响应头，形状就改不了了。
 */
async function forwardMatrixResponse({ res, upstream, bodyStream, ctype, pendingHead, mx }) {
  const isSse = !!bodyStream && /event-stream/i.test(ctype);
  log(`[matrix] 进入响应翻译：upstream=${mx.upstreamWire} client=${mx.clientWire} `
    + `isSse=${isSse} clientStream=${mx.clientStream} ctype=${ctype} head=${pendingHead ? pendingHead.length : 0}B`);
  const headers = {
    'content-type': mx.clientStream ? 'text/event-stream' : 'application/json',
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*',
  };

  // ① 客户端要流式 + 上游是流式 → 真正的逐帧翻译
  if (isSse && mx.clientStream) {
    try { res.writeHead(200, headers); } catch (e) { log(`client disconnected before headers: ${e.message}`); return false; }
    await pumpMatrixStream({
      res, upstream, upstreamWire: mx.upstreamWire, clientWire: mx.clientWire,
      model: mx.model, inputTokens: mx.inputTokens, headBytes: pendingHead,
    });
    if (!res.destroyed && !res.writableEnded) { try { res.end(); } catch { /* 忽略 */ } }
    return true;
  }

  // ② 其余情况：先把上游读成 canonical，再整体编成客户端要的形状
  //    （上游流式而客户端要非流式时，这一步顺便完成了聚合）
  let canon;
  if (isSse) {
    const col = makeCanonicalCollector();
    // 客户端要非流式，但上游已经在流了：把偷看过的首块也喂回去
    await drainCanonicalStream({ upstream, upstreamWire: mx.upstreamWire, collector: col, headBytes: pendingHead });
    canon = canonicalToChatCompletion(col.acc, mx.model);
  } else {
    let text = '';
    try {
      text = pendingHead && pendingHead.length ? Buffer.from(pendingHead).toString('utf8') : '';
      if (upstream.body) {
        const rd = upstream.body.getReader();
        const td = new TextDecoder();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          text += td.decode(value, { stream: true });
        }
        try { rd.releaseLock(); } catch { /* 忽略 */ }
      }
    } catch (e) {
      log(`matrix: 读上游响应失败：${e && e.message}`);
      // ⚠ 返回 false 在 forward 的契约里是「**这家**失败，换下一家」。
      // 但"读不出上游响应"不是换一家就能好的 —— 上游已经处理了这次请求（可能已计费），
      // 一路 failover 只会 N 倍计费，而用户最终拿到的是网关自己的
      // `all providers ... are unavailable`，真实原因只躺在日志里。
      // 所以要 stop 并把上游状态透出去。
      return { stop: { status: 502, upstreamStatus: upstream.status, reason: '上游响应读取失败' } };
    }
    let json = null;
    try { json = JSON.parse(text); } catch (e) {
      // 最常见的真实形态：反代/网关插在中间，上游 200 但返回 HTML 错误页。
      log(`matrix: 上游响应不是合法 JSON（${mx.upstreamWire} → ${mx.clientWire}）：${String(text).slice(0, 120)}`);
      return {
        stop: {
          status: 502,
          upstreamStatus: upstream.status,
          reason: `上游返回的不是 JSON（Content-Type: ${ctype || '未声明'}）—— 通常是上游前面有反代/网关插了错误页`,
        },
      };
    }
    // 已经是 canonical(chat) 就不用再过一遍 collector
    if (mx.upstreamWire === 'openai-chat') canon = json;
    else canon = mx.upstreamWire === 'anthropic-messages'
      ? anthropicMessageToChatCompletion(json, mx.model)
      : responsesToChatCompletion(json, mx.model);
  }

  if (res.destroyed || res.writableEnded) return false;
  // ⚠ 客户端要流式、而上游给了完整 JSON（上游不支持流式 / 我们翻译时没带上 stream）：
  // **仍然要按客户端协议合成一条 SSE 流**，不能回非流式 JSON ——
  // 流式客户端拿到 application/json 会解析失败或一直等 message_stop。
  if (mx.clientStream) {
    try { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' }); }
    catch (e) { log(`client disconnected before headers: ${e.message}`); return false; }
    const enc = makeStreamEncoder(mx.clientWire, { res, model: mx.model, inputTokens: mx.inputTokens });
    enc.emit(chatCompletionToCanonicalEvents(canon));
    enc.finish();
    if (!res.destroyed && !res.writableEnded) { try { res.end(); } catch { /* 忽略 */ } }
    return true;
  }
  const payload = mx.clientWire === 'openai-chat'
    ? canon
    : (mx.clientWire === 'anthropic-messages'
      ? openaiToAnthropicMessage(canon, mx.model, mx.inputTokens)
      : chatToResponsesResponse(canon, mx.model));
  // ⚠ 不要在这里先 res.writeHead()：json() 内部自己会 writeHead，
  // 重复写头会抛 ERR_HTTP_HEADERS_SENT，而这句抛错被 json 自己的 try/catch 吞掉 →
  // **响应永远不 end，客户端一路挂到超时**（实测：网关日志记 status=ok，客户端却 TIMEOUT）。
  json(res, 200, payload);
  return true;
}

/** 把一条完整的 chat completion 拆成 canonical 事件（用于"上游非流式、客户端要流式"）。 */
function chatCompletionToCanonicalEvents(json) {
  const ev = [];
  const j = json && typeof json === 'object' ? json : {};
  const choice = (Array.isArray(j.choices) ? j.choices[0] : null) || {};
  const msg = choice.message || {};
  const think = reasoningTextOf(msg);
  if (think) ev.push({ t: 'think', d: think });
  if (typeof msg.content === 'string' && msg.content) ev.push({ t: 'text', d: msg.content });
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  calls.forEach((c, i) => {
    ev.push({ t: 'tool', i, id: String(c.id || ''), name: String((c.function && c.function.name) || '') });
    const args = (c.function && c.function.arguments) || '';
    if (args) ev.push({ t: 'args', i, d: String(args) });
  });
  const u = j.usage || {};
  if (u.prompt_tokens !== undefined || u.completion_tokens !== undefined) {
    ev.push({ t: 'usage', in: Number(u.prompt_tokens) || 0, out: Number(u.completion_tokens) || 0 });
  }
  ev.push({ t: 'stop', r: calls.length ? 'tool_calls' : (choice.finish_reason === 'length' ? 'length' : 'stop') });
  ev.push({ t: 'end' });
  return ev;
}

/** OpenAI 非流式响应 → Anthropic message */
function openaiToAnthropicMessage(json, model, fallbackInTokens) {
  const choice = (json && Array.isArray(json.choices) ? json.choices[0] : null) || {};
  const msg = choice.message || {};
  const content = [];
  // D5：兼容 reasoning_content / reasoning / reasoning_details（旧实现只认第一个）
  const msgReasoning = reasoningTextOf(msg);
  if (msgReasoning) {
    content.push({ type: 'thinking', thinking: msgReasoning, signature: '' });
  }
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    let input = {};
    try { input = JSON.parse((call.function && call.function.arguments) || '{}'); } catch { input = {}; }
    content.push({
      type: 'tool_use',
      id: String(call.id || 'call_' + Math.random().toString(36).slice(2, 10)),
      name: String((call.function && call.function.name) || ''),
      input,
    });
  }
  const usage = json && json.usage ? json.usage : {};
  const inTok = Number(usage.prompt_tokens) > 0 ? Number(usage.prompt_tokens) : (fallbackInTokens || 0);
  const outTok = Number(usage.completion_tokens) > 0
    ? Number(usage.completion_tokens)
    : estimateTokens(content.map((c) => c.text || c.thinking || JSON.stringify(c.input || '')).join(''));
  // ⚠ 有 tool_calls 就必须是 tool_use，**不能**看 finish_reason。
  // OpenAI 世界里"给了 tool_calls 却把 finish_reason 写成 stop"是被普遍容忍的写法，
  // 而 Anthropic 客户端见到 end_turn 就**不执行工具**、直接把这轮当最终答案收尾。
  // 实测（2026-10-08 审计复现）：同一个上游、同一份 body，
  //   流式 → stop_reason:"tool_use"（工具照常执行）
  //   非流式 → stop_reason:"end_turn"（工具被丢掉）
  // ——同一条翻译链的两条路径给出相反结论，属于必须消除的自相矛盾。
  // 对齐 `canonicalToChatCompletion` 与 `responsesToChatCompletion` 里同样的写法。
  const stopReason = content.some((c) => c.type === 'tool_use')
    ? 'tool_use'
    : stopReasonFromFinish(choice.finish_reason);
  return {
    id: (json && json.id) || ('msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)),
    type: 'message',
    role: 'assistant',
    model,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

/** 写一个 Anthropic SSE 事件 */
function sseWrite(res, type, payload) {
  try {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch { /* 客户端已断开：由调用方的写失败检查兜住 */ }
}

/**
 * OpenAI SSE → Anthropic SSE 流翻译。
 * 逐块解析 `data: {...}`，把 delta.content / delta.reasoning_content / delta.tool_calls 映射成
 * Anthropic 的 content_block_start/delta/stop 事件序列。
 * @param {object} o { res, upstream, model, inputTokens, onDone }
 * @returns {Promise<{ok:boolean, usage?:object, text?:string}>} 聚合结果（非流式客户端用它拼完整消息）
 */
async function translateOpenAIStreamToAnthropic({ res, upstream, model, inputTokens, aggregateOnly, headBytes }) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let started = false;
  let blockIndex = -1;          // 当前打开的 content block 下标
  let openKind = null;          // 'text' | 'thinking' | 'tool_use'
  let finished = false;
  let stopReason = 'end_turn';
  let outText = '';
  let outThinking = '';
  const toolCalls = new Map();  // index → { id, name, args }
  const toolCallState = { last: 0 };   // 第二轮审计修复：缺 index 的分片按"新调用/续片"分流，不再一律落 0
  let usage = null;

  const startBlock = (kind, block) => {
    blockIndex++;
    openKind = kind;
    if (!aggregateOnly) {
      sseWrite(res, 'content_block_start', { type: 'content_block_start', index: blockIndex, content_block: block });
    }
  };
  const closeBlock = () => {
    if (openKind === null) return;
    if (!aggregateOnly) sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    openKind = null;
  };
  const ensureStart = () => {
    if (started) return;
    started = true;
    if (!aggregateOnly) {
      sseWrite(res, 'message_start', {
        type: 'message_start',
        message: {
          id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
          type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: inputTokens || 0, output_tokens: 0 },
        },
      });
    }
  };

  const handleChunk = (json) => {
    ensureStart();
    if (json && json.usage && (json.usage.prompt_tokens || json.usage.completion_tokens)) usage = json.usage;
    const choice = (Array.isArray(json.choices) ? json.choices[0] : null) || {};
    const delta = choice.delta || {};
    // D5：兼容 reasoning_content / reasoning / reasoning_details（旧实现只认第一个）
    const deltaReasoning = reasoningTextOf(delta);
    if (deltaReasoning) {
      if (openKind !== 'thinking') { closeBlock(); startBlock('thinking', { type: 'thinking', thinking: '' }); }
      outThinking += deltaReasoning;
      if (!aggregateOnly) {
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: deltaReasoning } });
      }
    }
    if (typeof delta.content === 'string' && delta.content) {
      if (openKind !== 'text') { closeBlock(); startBlock('text', { type: 'text', text: '' }); }
      outText += delta.content;
      if (!aggregateOnly) {
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } });
      }
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const idx = toolCallSlot(call, toolCalls, toolCallState);
      let entry = toolCalls.get(idx);
      if (!entry) {
        // 第三轮审计修复：这里**只累积，不开块**（开块统一延到流结束的 flushToolCalls）。
        // 原因见 flushToolCalls 的注释：边到边写会用"当前块号"，交错分片必然串台。
        // 顺带保留了 2026-09-16 事故的修复意图——名字未到就不开块，客户端不会拿到空名 tool_use。
        entry = { id: call.id || ('call_' + Math.random().toString(36).slice(2, 10)), name: '', args: '', started: false, sent: 0 };
        toolCalls.set(idx, entry);
      }
      if (call.id) entry.id = call.id;
      if (call.function && typeof call.function.name === 'string' && call.function.name) entry.name = call.function.name;
      const frag = (call.function && call.function.arguments) || '';
      if (frag) entry.args += frag;
    }
    if (choice.finish_reason) { stopReason = stopReasonFromFinish(choice.finish_reason); finished = true; }
  };

  /**
   * 把**全部**工具调用按槽位升序补成 content block（流结束时统一调用）。
   *
   * 第三轮审计修复（并行工具调用参数串台 —— 既存缺陷）：
   * 旧实现在分片到达时就开块、并**立即**写 `input_json_delta`，而写入用的是"当前打开的块号"
   * `blockIndex`。当上游交错发送两个工具调用的参数分片时（并行工具调用是常规形态）：
   *   A(块0) → B(块1，closeBlock 关掉 A 的块) → A 的续片 → 参数被写进 **B 的块**
   * 双方参数 JSON 都被污染（客户端 parse 失败 → 工具入参为空/报错），且这个顺序在真实
   * 上游里很常见。现有测试只覆盖单调用（index 恒为 0），所以一直没暴露。
   *
   * 现在改为**延迟到流结束统一开块**：参数先在各 entry 里累积，收尾时按槽位升序逐块发出，
   * 每块一次性带上自己的完整参数 —— 每个 tool_use 块天然连续、完整、与自己的 id/name 对齐。
   * 代价：工具块统一出现在文本之后（Anthropic 的一个 message 内 text 与 tool_use 的先后
   * 不影响语义；客户端本就要等 stop_reason=tool_use 才会执行工具）。
   *
   * 同时保留 2026-09-16 事故的修复意图：名字始终未到的条目以空名透传并记日志（绝不静默丢调用）。
   */
  const flushToolCalls = () => {
    for (const [idx, entry] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (entry.started) continue;
      if (!entry.name) log(`上游工具调用缺少 name（index=${idx}）→ 以空名透传（上游协议异常）`);
      closeBlock();
      startBlock('tool_use', { type: 'tool_use', id: entry.id, name: entry.name, input: {} });
      entry.started = true;
      if (entry.args && !aggregateOnly) {
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: entry.args } });
        entry.sent = entry.args.length;
      }
    }
  };

  let clientGone = false;
  const onClose = () => { clientGone = true; try { reader.cancel(); } catch { /* 忽略 */ } };
  try { res.once('close', onClose); } catch { /* 忽略 */ }
  // 把"行切分 + data: 解析"抽成闭包：偷看过的首事件字节（headBytes）先喂进来，再读流
  const feed = (text) => {
    buf += text;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      const m = /^data:\s*(.*)$/.exec(line);
      if (!m) continue;
      const payload = m[1].trim();
      if (payload === '[DONE]') { finished = true; continue; }
      try { handleChunk(JSON.parse(payload)); } catch { /* 非 JSON 心跳/注释：跳过 */ }
    }
  };
  try {
    if (headBytes && headBytes.length) feed(Buffer.from(headBytes).toString('utf8'));
    for (;;) {
      if (clientGone || res.destroyed || res.writableEnded) { try { await reader.cancel(); } catch { /* 忽略 */ } return { ok: false }; }
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    log(`流翻译读取失败：${e && e.message}`);
  } finally {
    try { res.removeListener('close', onClose); } catch { /* 忽略 */ }
    try { reader.releaseLock(); } catch { /* 忽略 */ }
  }
  if (clientGone) return { ok: false };

  ensureStart();
  flushToolCalls();   // 延迟开块：全部工具调用在此一次性、连续地补出（并行调用不会串台）
  closeBlock();
  const outTok = usage && Number(usage.completion_tokens) > 0
    ? Number(usage.completion_tokens)
    : estimateTokens(outText + outThinking + [...toolCalls.values()].map((t) => t.args).join(''));
  if (!aggregateOnly) {
    sseWrite(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: toolCalls.size && stopReason === 'end_turn' ? 'tool_use' : stopReason, stop_sequence: null },
      usage: { output_tokens: outTok },
    });
    sseWrite(res, 'message_stop', { type: 'message_stop' });
    try { res.end(); } catch { /* 忽略 */ }
  }
  return {
    ok: true,
    usage: { input_tokens: (usage && Number(usage.prompt_tokens)) || inputTokens || 0, output_tokens: outTok },
    stopReason: toolCalls.size && stopReason === 'end_turn' ? 'tool_use' : stopReason,
    text: outText,
    thinking: outThinking,
    // 第四轮审计修复：按**槽位序**返回，而不是 Map 插入序。插入序 = "分片首次出现的顺序"，
    // 当上游先发 index=5 再发 index=0 时，聚合出的 tool_use 顺序会颠倒（与流式路径的
    // flushToolCalls 排序不一致）。客户端虽按 id 区分调用，但顺序应与上游 index 一致。
    toolCalls: [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    finished,
  };
}

/**
 * 把"Anthropic 协议的客户端请求"转发给"只支持 OpenAI chat 的上游"。
 * 返回值与 forward() 契约一致：true / false / {stop:{status,upstreamStatus}}。
 * 账户池：额度耗尽 / 会话失效 / 限流 → 换**同供应商的下一个账户**；全部不可用才交给下一家供应商。
 */
async function forwardAnthropicViaOpenAI(provider, upstreamBaseHeaders, body, res, opts) {
  if (!breakerAcquire(provider.id)) {
    log(`skip ${provider.id} (breaker: cooldown or half-open probe already in flight)`);
    return false;
  }
  const quirks = providerQuirks(provider);
  const wantsStream = !!body.stream;
  // 限流冷却的作用域用**上游模型 ID**（body 已由 bodyForProvider 映射），与直通路径一致
  const scopeModel = (body && typeof body.model === 'string') ? body.model : '';
  const picked = pickAccount(provider, scopeModel);
  if (picked.acct === null && picked.cooling > 0) {
    log(`provider ${provider.id}: ${picked.cooling} 个账户全部冷却中 → 交给下一家`);
    // 第二轮审计修复（P1）：这里占用了 breakerAcquire 的半开探测名额，却直接 return ——
    // 名额悬空后该家会被 `skip ... (breaker: cooldown or half-open probe already in flight)`
    // 挡到 BREAKER_STALE_MS（180s）才回收，**且影响该家的所有模型**；客户端还会拿到
    // "all providers ... breaker cooldown"（把"账户全冷却"误报成"供应商熔断"）。
    // 本函数其余所有 return/continue 路径都已结算（见各分支处的 breakerRecordSuccess/
    // breakerRecordFail），只有这一条遗漏。语义上"账户冷却"不构成供应商故障 → 交还名额。
    breakerRecordSuccess(provider.id);
    return false;
  }
  const attemptAccounts = picked.acct ? [picked.acct, ...picked.accounts.filter((a) => a !== picked.acct && accountUsable(provider.id, a, scopeModel))] : [null];
  const upstreamPath = '/chat/completions';
  let lastDetail = '';
  let lastStatus = 0;

  for (const acct of attemptAccounts) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), providerTimeoutMs(provider, scopeModel));
    let headers;
    try {
      // 与直通路径共用同一套账户头构造（凭据 / 身份头 / Bearer / 自定义头，避免两处漂移）
      headers = await accountUpstreamHeaders(provider, acct, upstreamBaseHeaders, { anthropicUpstream: false });
    } catch (e) {
      log(`provider ${provider.id} 凭据不可用（${acct ? acct.id : '-'}）：${e && e.message}`);
      if (acct) { clearTimeout(timer); markAccountFailure(provider.id, acct, 'session', e && e.message); continue; }
      clearTimeout(timer);
      breakerRecordFail(provider.id, 401);
      return false;
    }

    const openaiBody = anthropicToOpenAIRequest(body, provider);
    if (quirks.has('force-stream')) openaiBody.stream = true;
    else openaiBody.stream = wantsStream;
    if (quirks.has('stringify-tool-choice') && openaiBody.tool_choice && typeof openaiBody.tool_choice === 'object') {
      openaiBody.tool_choice = (openaiBody.tool_choice.function && openaiBody.tool_choice.function.name) || 'auto';
    }
    if (quirks.has('prepend-system') && Array.isArray(openaiBody.messages)
      && !(openaiBody.messages[0] && openaiBody.messages[0].role === 'system')) {
      openaiBody.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
    }
    // 复用 OpenAI 路径的角色/推理档位归一（developer→system、reasoning_effort 按家映射）
    let finalBody = translateBody(openaiBody, provider);
    // OpenCode 车道的工具指纹门：这条路径上 body 已经是 OpenAI 形状，style 用 'chat'。
    // ⚠ 工具配对修复 / 指纹门都写在 forward() 里，而**这条路径不经过 forward()** ——
    // 少了这一处，"声明了 openai-chat 的家"就缺了免费档要求的工具声明。
    //（会话头不在这里补：它由调用方 applyOpencodeLaneHeaders 统一处理，两条路径共用一份 headers。）
    if (headers && headers['x-opencode-client']) {
      const fp = ensureFingerprintTools(finalBody, 'chat');
      if (fp) {
        finalBody = fp.body;
        log(`OpenCode 免费档工具指纹（翻译路径）：补声明 ${fp.added.join('/')}`);
      }
    }

    let upstream = null;
    const upstreamUrl = `${upstreamBase(provider.baseURL)}${upstreamPath}`;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST', headers, body: JSON.stringify(finalBody), signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const causeText = describeFetchError(e);
      const elapsed = Date.now() - startedAt;
      if (isTransientNetError(e) && elapsed < NET_RETRY_MAX_ELAPSED_MS) {
        log(`upstream ${provider.id} 网络错误（${causeText}，${elapsed}ms）→ 原地重试一次`);
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), providerTimeoutMs(provider, scopeModel));
        try {
          upstream = await fetch(upstreamUrl, {
            method: 'POST', headers, body: JSON.stringify(finalBody), signal: c2.signal,
          });
        } catch (e2) {
          log(`upstream ${provider.id} 重试仍失败：${describeFetchError(e2)}`);
        } finally { clearTimeout(t2); }
      }
      if (!upstream) {
        log(`upstream ${provider.id} request error: ${e.message}${causeText ? ' (' + causeText + ')' : ''}${proxyHintFor(upstreamUrl, causeText)}`);
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, 0);
        return false;
      }
    }
    clearTimeout(timer);

    if (!upstream.ok) {
      lastStatus = upstream.status;
      lastDetail = await readTextWithTimeout(upstream, 5000, 500);
      log(`upstream ${provider.id} HTTP ${upstream.status}: ${maskSecrets(lastDetail)}`);
      // ⚠ 这两类判定必须排在**账户级**判定与**状态码通配**之前，理由各有不同：
      //  ① 排在账户级之后 → 一个"地区受限"的模型会被 `classifyAccountFailure(403, …)` 判成
      //     `session`，把该家**所有 Key** 逐个标记冷却 1 小时。连坐效果与"熔断整家"等价：
      //     实测随后请求同家另一个完全正常的模型，路由阶段就是
      //     `provider p1: 2 个账户全部冷却中 → 交给下一家`。
      //  ② 排在 `401||403||429||>=500` 分支**之内** → 400/404 形态的"这家不提供该模型"
      //    （`Requested model X not supported`）永远走不到这一行，落到下面的
      //     `DETERMINISTIC_4XX_STATUS → {stop}` 直接回客户端 400。
      //     直通路径对同一种响应是继续 failover 的（2026-09-23 修过那一处），翻译路径当时漏了。
      if (MODEL_UNSUPPORTED_BY_PROVIDER_RE.test(lastDetail)) {
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"这家不提供该模型"（含地区/套餐受限）`
          + ' → 继续 failover（**不熔断该家、不冷却账户**；该家对别的模型仍然正常。'
          + '若长期如此，请从配置的 models 里移除该映射）');
        return false;
      }
      // 与直通路径同一条判据（见 UPSTREAM_BROKEN_4XX_RE 的定义处）：
      // **上游自己坏了却包成 4xx** 不是"请求有错"，继续 failover 才有意义。
      // 这条路径是 Anthropic 客户端 → chat 上游（DSH 走得最多的那条），
      // 少了它，"优先级更高但坏掉的家"照样能把请求打死。
      if (UPSTREAM_BROKEN_4XX_RE.test(String(lastDetail || ''))) {
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"上游侧故障被包成 4xx"`
          + `（${String(lastDetail || '').slice(0, 80)}）→ 继续 failover（不熔断该家、不冷却账户）`);
        return false;
      }
      if (CLIENT_FINGERPRINT_RE.test(String(lastDetail || ''))) {
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"客户端指纹被拒" → 熔断该家并停止重试。`
          + '这类拒绝与账号无关（换 Key/重试都没用），继续请求只会加剧风控；'
          + '本程序运行在 Node 上，无法伪装 TLS/HTTP 客户端指纹，这是已知上限。');
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, 403);
        return false;
      }
      const acctKind = acct ? classifyAccountFailure(upstream.status, lastDetail) : null;
      if (acctKind) {
        // F11：把 Retry-After 一并传下去。直通路径早就传了（见 forward 里的 failureSink.retryMs），
        // 翻译路径一直漏着 —— 上游明确说"600 秒后再来"时，这里只按指数退避冷却（90s 起）。
        markAccountFailure(provider.id, acct, acctKind, lastDetail, scopeModel, retryAfterMs(upstream));
        continue;   // 换下一个账户（此时尚未向客户端写任何字节）
      }
      if (upstream.status === 401 || upstream.status === 403 || upstream.status === 429 || upstream.status >= 500) {
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, upstream.status, upstream.status === 429 ? retryAfterMs(upstream) : 0);
        return false;
      }
      breakerRecordSuccess(provider.id);
      if (PROVIDER_SIDE_4XX_RE.test(lastDetail)) {
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, PERSISTENT_ACCOUNT_RE.test(lastDetail) ? 403 : 0);
        return false;
      }
      const status = DETERMINISTIC_4XX_STATUS[upstream.status] || 400;
      log(`upstream ${provider.id} 确定性 4xx HTTP ${upstream.status} → 终止 failover（回 ${status}，不回显上游原文）`);
      return { stop: { status, upstreamStatus: upstream.status } };
    }

    // 成功：OpenAI 响应 → Anthropic
    if (acct) markAccountOk(provider.id, acct, scopeModel);
    breakerRecordSuccess(provider.id);
    const ctype = String(upstream.headers.get('content-type') || '');
    const inputTokens = estimateTokens(JSON.stringify(finalBody.messages || []));
    try {
      if (/event-stream/i.test(ctype)) {
        // —— SSE「首事件就是 error」识别（2026-09-16，与 forward() 同规则）——
        // 实测部分上游/中转对失败请求回 HTTP 200 + text/event-stream，流里第一件事就是
        // `data: {"error":…}`（chiyi-ds 形态）。若不识别就按成功往客户端写头，客户端会拿到
        // 一条**空回复**而不是"换下一家"。这里在写响应头之前偷看首个事件：是错误就当作该家失败，
        // 依账户池/供应商顺序继续；此时尚未向客户端写任何字节，failover 是安全的。
        let headBytes = null;
        try {
          const peekReader = upstream.body.getReader();
          const chunks = [];
          let total = 0;
          while (total < 8192) {
            // eslint-disable-next-line no-await-in-loop
            const { done, value } = await peekReader.read();
            if (done) break;
            const buf = Buffer.from(value);
            chunks.push(buf);
            total += buf.length;
            if (/\n\n|\r\n\r\n/.test(Buffer.concat(chunks).toString('utf8'))) break;
          }
          headBytes = Buffer.concat(chunks);
          const head = headBytes.toString('utf8');
          const looksError = /"error"\s*:/.test(head) && !/"choices"\s*:/.test(head);
          if (looksError) {
            const detail = head.replace(/\s+/g, ' ').slice(0, 200);
            log(`upstream ${provider.id} HTTP 200 但 SSE 首事件是错误 → 判定该家失败并换下一家：${maskSecrets(detail)}`);
            // 第二轮审计修复（严重）：这里原本是
            //     classifyAccountFailure(200, detail) || classifyAccountFailure(402, detail)
            // 而 `classifyAccountFailure` 第一句就是 `if (status === 402) return 'credit'`
            //（只看状态码、不看文案）→ **或运算的后半段恒为真**，于是任何"HTTP 200 + 首事件是
            // 错误"（瞬时 503、上下文超限、不支持 thinking……）都会把该 Key 按"额度耗尽"标记，
            // 走 ACCOUNT_CREDIT_COOLDOWN_MS = 30 分钟的**账户级**冷却 —— 该 Key 上**所有模型**
            // 连坐半小时（真实上游确实以 200+SSE 返回这些错误，见 cline/amd 的历史日志）。
            // 正确语义：只按**文案**判额度/会话类失败（WORKBUDDY_CREDIT_RE / SESSION_RE 已覆盖
            // "insufficient credit / quota exceeded / 余额不足 / 额度用尽"等），
            // 其它 200+SSE 错误交给下面的 breakerRecordFail 做**供应商级**短熔断就够了。
            // 分类用**未截断**的 head（额度文案可能排在 error 对象靠后处，200 字符会把它截掉）；
            // 截断值只留给日志。与下方非 2xx 分支（500 字符、同一套正则）保持一致。
            const classifyText = head.replace(/\s+/g, ' ').slice(0, 500);
            const kind = acct ? classifyAccountFailure(200, classifyText) : null;
            if (kind) {
              // 账户级失败（额度/会话）→ 换**同供应商的下一把 Key**，且不计供应商熔断。
              // 第三轮审计修复：原实现在这里一律 `return false`，只换下一家供应商 —— 与函数契约
              //（"额度耗尽/会话失效/限流 → 换同供应商的下一个账户；全部不可用才交给下一家"）
              // 以及上方非 2xx 分支的 `continue` 都不一致，等于把多 Key 容灾在这条路径上废掉。
              // 这里尚未向客户端写任何字节、上游流已取消，continue 是安全的。
              markAccountFailure(provider.id, acct, kind, classifyText, scopeModel);
              log(`upstream ${provider.id} HTTP 200 但 SSE 首事件报账户级失败（${kind}）→ 换同供应商的下一把 Key`);
              try { await peekReader.cancel(); } catch { /* 忽略 */ }
              continue;
            }
            catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
            breakerRecordFail(provider.id, 0);
            try { await peekReader.cancel(); } catch { /* 忽略 */ }
            return false;   // 未写任何字节 → 交给下一家供应商
          }
          peekReader.releaseLock();
        } catch (peekErr) {
          log(`上游首事件偷看失败（按正常流继续）：${peekErr && peekErr.message}`);
          headBytes = null;
        }
        if (wantsStream && !opts?.aggregateOnly) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            'access-control-allow-origin': '*',
          });
          const r = await translateOpenAIStreamToAnthropic({ res, upstream, model: body.model, inputTokens, aggregateOnly: false, headBytes });
          return r.ok ? true : false;
        }
        // 客户端要非流式（或下游是 Responses 聚合）：把流收完再回一条完整 message
        const agg = await translateOpenAIStreamToAnthropic({ res, upstream, model: body.model, inputTokens, aggregateOnly: true, headBytes });
        if (!agg.ok) return false;
        const content = [];
        if (agg.thinking) content.push({ type: 'thinking', thinking: agg.thinking, signature: '' });
        if (agg.text) content.push({ type: 'text', text: agg.text });
        for (const t of agg.toolCalls || []) {
          let input = {};
          try { input = JSON.parse(t.args || '{}'); } catch { input = {}; }
          content.push({ type: 'tool_use', id: t.id, name: t.name, input });
        }
        json(res, 200, {
          id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
          type: 'message', role: 'assistant', model: body.model,
          content: content.length ? content : [{ type: 'text', text: '' }],
          stop_reason: agg.stopReason, stop_sequence: null,
          usage: agg.usage,
        });
        return true;
      }
      const text = await readTextWithTimeout(upstream, 30_000, 4 * 1024 * 1024);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* 非 JSON：见下 */ }
      if (!parsed) {
        // ⚠ `return false` 的契约是「**这家**失败，换下一家」。
        // 但"上游 200 却给了非 JSON"不是换一家能解决的 —— 上游已经处理过这次请求（可能已计费），
        // 一路 failover 只是 N 倍计费，而用户最终拿到的是网关自己的
        // `all providers ... are unavailable`，真正的原因（反代插了 HTML 错误页）只躺在日志里。
        // 实测（2026-10-08）：这是 Anthropic 客户端 → chat 上游这条**最常用**路径上的行为，
        // 与矩阵路径的 502 处置不一致。
        log(`upstream ${provider.id} 非 JSON 响应（anthropic→openai 翻译路径，Content-Type: ${ctype || '未声明'}）：${String(text).slice(0, 120)}`);
        return {
          stop: {
            status: 502,
            upstreamStatus: upstream.status,
            reason: `上游返回的不是 JSON（Content-Type: ${ctype || '未声明'}）—— 通常是上游前面有反代/网关插了错误页`,
          },
        };
      }
      json(res, 200, openaiToAnthropicMessage(parsed, body.model, inputTokens));
      return true;
    } catch (e) {
      log(`anthropic→openai 响应翻译失败：${e && e.message}`);
      if (!res.headersSent) return false;
      try { res.destroy(); } catch { /* 忽略 */ }
      return false;
    }
  }
  // 所有账户都不行。
  // 契约（2026-09-18 用户要求，gateway.test.js 有对应回归）：Key 级失败先在**家内**轮换，
  // 只有该家**所有** Key 都不可用，才判该家不可用（长熔断）并换下一家 —— 所以这里**必须**
  // 记供应商级熔断，不能因为"失败原因属于账户级"就跳过，否则坏家会被每个请求重复打点。
  //
  // D4（审计修复，已按上述契约收敛）：审计原文建议"这里不记供应商熔断"，但那与既有契约冲突，
  // 故**不采纳**。审计真正说对的是另一半：**半开探测名额会在这里泄漏** ——
  // 本函数开头调用了 breakerAcquire()（占用半开名额），若循环内每次都 continue/耗尽后走到这里，
  // 旧实现只在 lastStatus 命中 401/403/429/5xx 时才写熔断条目；**凭据不可用**那条路径
  // 不赋值 lastStatus（保持 0）→ 既不写条目也不释放名额 → 该家永久卡在 half-open。
  // 现在：无论是否达到"整家熔断"的条件，都先确保半开名额被结算（记失败或交还），不留悬挂。
  log(`provider ${provider.id} 全部账户不可用（最后 HTTP ${lastStatus}）：${maskSecrets(lastDetail).slice(0, 160)}`);
  // ⚠ 收尾这处通配必须与上面两处（forward / forwardAnthropicViaOpenAI）一样先摘掉两类
  // **与账号无关**的拒绝，否则会出现"同一份上游响应、换个路径就换个后果"：
  //   · 地区/套餐受限（`… is not available in your region`）—— 换 Key 无用；
  //   · 客户端指纹被拒 —— 换 Key 更无用。
  // 2026-09-30 审计实测：翻译路径 + 账户池下，一个地区受限的模型会顺着这个收尾
  // `breakerRecordFail(provider.id, 403)` 把**整家**熔断 30 分钟，随后同家另一个完全
  // 正常的模型在路由阶段就被 `skip p1 (breaker open)` 挡掉。直通路径因为豁免在最顶层，
  // 所以只有翻译路径复现 —— 这正是"三处都要判"里漏掉的第三处。
  if (MODEL_UNSUPPORTED_BY_PROVIDER_RE.test(String(lastDetail || ''))) {
    log(`provider ${provider.id} 的失败原因是"这家不提供该模型"（含地区/套餐受限）→ 交还半开名额，**不熔断该家**`
      + '（该家对别的模型仍然正常；若长期如此，请从配置的 models 里移除该映射）');
    breakerRecordSuccess(provider.id);
    return false;
  }
  // 同 UPSTREAM_BROKEN_4XX_RE 的定义处：上游自己坏了却包成 4xx → 该家不算"请求有错"，
  // 交还半开名额、不熔断，让 failover 继续。
  if (UPSTREAM_BROKEN_4XX_RE.test(String(lastDetail || ''))) {
    log(`provider ${provider.id} 的失败原因是"上游侧故障被包成 4xx"（${String(lastDetail || '').slice(0, 80)}）`
      + ' → 交还半开名额，**不熔断该家**，继续 failover');
    breakerRecordSuccess(provider.id);
    return false;
  }
  if (CLIENT_FINGERPRINT_RE.test(String(lastDetail || ''))) {
    log(`provider ${provider.id} 的失败原因是"客户端指纹被拒" → 熔断该家（换 Key 无用）`);
    catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
    breakerRecordFail(provider.id, 403);
    return false;
  }
  if (lastStatus === 401 || lastStatus === 403 || lastStatus === 429 || lastStatus >= 500) {
    catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
    breakerRecordFail(provider.id, lastStatus);
  } else {
    // 未拿到可判定的上游状态码（如凭据解析失败、账户全部处于冷却而直接跳过）：
    // 该家这轮没被证明是坏的，但半开名额已占用 —— 交还名额，避免永久 half-open。
    breakerRecordSuccess(provider.id);
  }
  return false;
}

// 诊断 dump（R8）：env DSH_GATEWAY_DUMP_BODY=<dir> 时，把每个 chat/messages 请求的
// 结构摘要落盘（不存明文 key；摘要里的样本先经 maskSecretTokens 打码再落盘），
// 用于定位上游敏感词拦截的触发特征。
// env DSH_GATEWAY_DUMP_FULL=1 时额外把完整请求体落盘（脱敏 key），用于取证真实请求。
// 审计修复（P3，本次）：目录内 gw-*.json 摘要同样受保留上限约束（旧版无清理策略 → 无界增长）；
// full-*.json 是用户显式开启 DSH_GATEWAY_DUMP_FULL 才产生的取证文件，不做自动删除。
function dumpBodyDigest(body, tag) {
  try {
    const dir = process.env.DSH_GATEWAY_DUMP_BODY;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    // Responses 协议（tag='responses'）没有 messages：input 才是"消息"（字符串 / item 数组）
    const items = Array.isArray(body && body.input) ? body.input
      : (Array.isArray(body && body.messages) ? body.messages : null);
    // 完整请求体（脱敏后落盘，供逐字节对比/取证——明文 key/长串经 maskSecretTokens 打码）
    if (process.env.DSH_GATEWAY_DUMP_FULL === '1' && body && (body.messages || body.input)) {
      const sanitized = { ...body };
      if (typeof sanitized.instructions === 'string') sanitized.instructions = maskSecretTokens(sanitized.instructions);
      if (typeof body.input === 'string') {
        sanitized.input = maskSecretTokens(body.input);
      } else if (Array.isArray(body.input)) {
        sanitized.input = body.input.map((it) => {
          if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
          const n = { ...it };
          if (typeof n.content === 'string') n.content = maskSecretTokens(n.content);
          if (Array.isArray(n.content)) {
            n.content = n.content.map((b) =>
              (b && typeof b.text === 'string') ? { ...b, text: maskSecretTokens(b.text) } : b);
          }
          if (typeof n.output === 'string') n.output = maskSecretTokens(n.output);
          if (n.arguments) n.arguments = '<arguments>';   // 不落工具参数细节
          return n;
        });
      }
      if (Array.isArray(body.messages)) {
        sanitized.messages = body.messages.map((m) => {
          if (!m) return m;
          const n = { ...m };
          if (typeof n.content === 'string') n.content = maskSecretTokens(n.content);
          if (Array.isArray(n.content)) {
            n.content = n.content.map((b) =>
              (b && b.type === 'text' && typeof b.text === 'string')
                ? { ...b, text: maskSecretTokens(b.text) } : b);
          }
          if (n.tool_calls) n.tool_calls = '<tool_calls>';   // 不落工具参数细节
          return n;
        });
      }
      const fullF = path.join(dir, 'full-' + Date.now() + '-' + tag + '.json');
      fs.writeFileSync(fullF, JSON.stringify(sanitized), 'utf8');
      log(`[dump] 完整请求体(脱敏) -> ${fullF} (${(items || []).length} 条消息)`);
    }
    const digest = {
      at: localStamp(),
      tag,
      model: body && body.model,
      stream: !!(body && body.stream),
      // R4：Responses 用 reasoning.effort 表达推理档位（chat 用 reasoning_effort/thinking）
      reasoning_effort: (body && body.reasoning_effort) ?? (body && body.reasoning && body.reasoning.effort),
      thinking: body && body.thinking,
      previous_response_id: body && body.previous_response_id,
      hasTools: Array.isArray(body && body.tools) ? body.tools.length : 0,
      msgCount: items ? items.length : 0,
      // R10：记录消息结构取证（roles 空说明 role 字段缺失/结构异常）
      msg0Keys: (items && items[0]) ? Object.keys(items[0]) : [],
      msg0Role: (items && items[0]) ? items[0].role : undefined,
      msg0ContentType: (items && items[0] && items[0].content) ? (Array.isArray(items[0].content) ? 'array:' + items[0].content.length : typeof items[0].content) : (items && items[0] && typeof items[0].output === 'string' ? 'output:string' : undefined),
      msg0Sample: (items && items[0] && typeof items[0].content === 'string')
        ? maskSecretTokens(items[0].content).slice(0, 80)   // 审计修复：样本先打码（旧版可能落真密钥前缀）
        : undefined,
      roles: items
        ? items.slice(0, 50).map((m) => (m && (m.role || m.type)) || '?').join(',')
        : '',
      tools: Array.isArray(body && body.tools)
        ? body.tools.map((t) => (t && t.function && t.function.name) || '?').join(',')
        : '',
    };
    const f = path.join(dir, 'gw-' + Date.now() + '-' + tag + '.json');
    fs.writeFileSync(f, JSON.stringify(digest, null, 2), 'utf8');
    log(`[dump] 请求摘要 -> ${f}`);
    pruneDumpDir(dir, /^gw-.*\.json$/i, DUMP_KEEP_FILES);
  } catch (_) { /* dump 失败不影响服务 */ }
}

async function handleCompletion(cfg, req, res, body, upstreamPath, opts) {
  const responsesMode = !!(opts && opts.responses);          // POST /v1/responses
  const search = (opts && opts.search) || '';                // 查询串原样带给上游（?api-version= 等）
  dumpBodyDigest(body, responsesMode ? 'responses' : 'chat');   // R8：诊断用（env 控制）
  const model = body && body.model;
  if (!model) return json(res, 400, { error: { message: 'model is required' } });
  const reqStart = Date.now();   // 调用计时（T1 调用日志）
  const client = req.socket?.remoteAddress || 'local';
  const stream = !!(body && body.stream);
  const logCall = (via, status) =>
    log(`[call] ${model} ${via} status=${status} stream=${stream ? 1 : 0} dur=${Date.now() - reqStart}ms from=${client}${responsesMode ? ' proto=responses' : ''}`);

  const candidates = providersForModel(cfg, model);
  if (candidates.length === 0) {
    return json(res, 404, { error: { message: `no providers configured for model "${model}"` } });
  }

  // 1) 候选收敛（**配置列表为唯一权威**，见 selectCandidates）：
  //    只为"一个模型都没配"的 provider 探测上游目录 —— 配置齐全时请求路径上零探测
  //    （旧版对每个候选都探测，实测每次请求要多等 ~1.5s；而且探测结果会把
  //     "目录里有但其实不能服务"的供应商拉进候选，正是 2026-09-15 事故的来源）。
  const catalogResults = await Promise.all(candidates.map((p) => (needsCatalog(p)
    ? fetchCatalog(p, false, cfg.clientUA, effectiveClientProfile(cfg, p), cfg)
    : null)));
  let { eligible, reasons, tierSizes } = selectCandidates(candidates, catalogResults, model);
  // 多模态（2026-09-16）：请求里带图片时，只保留声明了图片能力的候选
  //（否则会被路由到纯文本家，上游报错或图片被忽略）
  const imgStats = imageBlockStats(body);
  if (imgStats.total > 0) {
    const vf = filterVisionCandidates(eligible, reasons, model);
    if (vf.dropped > 0) {
      log(`[route] ${model}: 请求含图片（本轮 ${imgStats.lastTurn} 张 / 历史 ${imgStats.history} 张）`
        + ` → 跳过未声明图片能力的 ${vf.dropped} 家`);
      eligible = vf.eligible;
      reasons = vf.reasons;
    }
  }
  const reasonsText = routeReasonsText(reasons);
  // 选路决策日志（2026-09-15 加）：**每次请求都记**——"为什么发给了这家"必须能在日志里
  // 直接看到（此前只在失败时才记原因，用户遇到"该走 A 却走了 B"时无从判断）。
  log(`[route] ${model}: ${eligible.length} 个候选（配置声明 ${tierSizes[0]} / 未配置按目录兜底 ${tierSizes[1]}）｜${reasonsText}`);

  // V1 防封：跳过熔断中的 provider（连续失败保护期，不发起上游请求）
  const breakerOpen = (p) => { if (breakerIsOpen(p.id)) { log(`skip ${p.id} (breaker open)`); return true; } return false; };
  const ordered = eligible.filter((p) => !breakerOpen(p));
  if (ordered.length === 0) {
    if (eligible.length === 0 && candidates.length > 0 && candidates.every((p) => breakerIsOpen(p.id))) {
      // 全部候选都熔断中（catalog 因熔断未探测 → 归属无法判定）：暂时状态 → 503 + 重试提示（R20）
      log(`[route] ${model}: 全部候选熔断，归属无法判定（${reasonsText}）`);
      logCall('breaker-all', 'fail');
      return json(res, 503, { error: { message: `all providers for model "${model}" are temporarily in breaker cooldown (network/upstream failures); retry in ~${breakerCooldownSecs(candidates)}s or restart the gateway` } });
    }
    if (eligible.length === 0) {
      // 没有任何候选承载该模型：catalog 未收录 / models 列表不含 → 404 + 排查提示
      //（只回网关自身的判定码，不回显上游内容）
      log(`[route] ${model}: 无候选 provider（${reasonsText}）`);
      logCall('no-provider', 'fail');
      return json(res, 404, { error: {
        message: `model "${model}" is not offered by any configured provider — ${MODEL_NOT_OFFERED_HINT}`,
        details: routeReasonsDetail(reasons),
      } });
    }
    // 候选存在但全部处于熔断冷却：暂时状态 → 503 + 重试提示（R20）
    log(`[route] ${model}: 候选全部熔断（${reasonsText}）`);
    logCall('breaker-all', 'fail');
    return json(res, 503, { error: { message: `all providers for model "${model}" are temporarily in breaker cooldown (network/upstream failures); retry in ~${breakerCooldownSecs(eligible)}s or restart the gateway` } });
  }

  // 路由模式（S1）：
  //  - 缺省 / "failover"：主备——固定从候选头开始尝试，失败切下一家（传统行为）；
  //    候选顺序 = priority 升序、同级按配置数组顺序（见 providersForModel）
  //  - "round-robin"：轮询——同一模型每次请求从不同起点开始，流量分摊到各家；失败同样切下一家
  let tryOrder = ordered;
  if (cfg.routing === 'round-robin' && ordered.length > 1) {
    // 审计修复（P3）：rrCounters 的 key 是**客户端可控**的 model 字符串——无界增长。
    // 加一个粗粒度上限（超限即整体重置，轮询起点偏差可忽略）。
    if (rrCounters.size > 1000) rrCounters.clear();
    let n = rrCounters.get(model) || 0;
    rrCounters.set(model, n + 1);
    const start = n % ordered.length;
    if (start > 0) tryOrder = [...ordered.slice(start), ...ordered.slice(0, start)];
  }
  // Responses 有状态：多轮请求（previous_response_id）必须回到持有该上下文的原供应商，
  // 否则上游不认识这个 id（404）或上下文丢失。命中亲和表 → 提到尝试序列最前（其余仍可 failover）。
  if (responsesMode && typeof body.previous_response_id === 'string' && body.previous_response_id) {
    const owner = affinityGet(body.previous_response_id);
    if (owner) {
      const i = tryOrder.findIndex((x) => x.id === owner);
      if (i > 0) {
        tryOrder = [tryOrder[i], ...tryOrder.slice(0, i), ...tryOrder.slice(i + 1)];
        log(`responses affinity: previous_response_id ${body.previous_response_id} → ${owner} 优先`);
      } else if (i < 0) {
        log(`responses affinity: previous_response_id 属于 ${owner}，但它不是 "${model}" 的候选 → 忽略`);
      }
    }
  }
  // 会话亲和（缓存友好）：同一会话优先回到上次成功的那家。
  // Anthropic 的 prompt cache 绑定在上游账号上 —— 反复换家 = 缓存永远命中不了 = 成本翻几倍。
  // 与上面 Responses 亲和的区别：那条是"必须回去"（否则 404），这条只是"优先回去"，
  // 命中不了就照常按 priority 走，**不改变任何失败语义**。
  const sessKey = sessionAffinityEnabled(cfg) ? sessionKeyOf(body, req) : null;
  if (sessKey) {
    const owner = sessionAffinityGet(sessKey);
    if (owner) {
      const i = tryOrder.findIndex((x) => x.id === owner);
      if (i > 0) {
        tryOrder = [tryOrder[i], ...tryOrder.slice(0, i), ...tryOrder.slice(i + 1)];
        log(`[route] ${model}: 会话亲和 → ${owner} 提到首位（缓存热度；失败仍照常 failover）`);
      } else if (i < 0) {
        // 上次成功的那家这次不在候选里（被停用 / 不再声明该模型）→ 本轮重新学习即可
        log(`[route] ${model}: 会话亲和的 ${owner} 已不在候选中 → 本轮重新选路`);
      }
    }
  }
  for (const p of tryOrder) {
    // 模型映射：把逻辑名换成该供应商的上游真实 ID（未声明映射 → 原样透传）；
    // 带图片时优先选声明了 vision 的那条上游 ID（见 upstreamIdFor）
    const attemptBody = bodyForProvider(body, p, model, bodyHasImage(body));
    const upModel = attemptBody.model;
    log(`try ${p.id} for ${model}${upModel !== model ? ' → ' + upModel : ''}`);
    // 透传 dsh 原始请求标识（K1 防屏蔽）/ 仿真模式（V2: clientProfile）：clientHeaders = req.headers
    // Responses：记录 response.id → provider 亲和（后续 GET/DELETE/cancel/input_items 与多轮都靠它）
    let sniffed = false;
    // ── 协议矩阵：这家上游对这个模型说的是哪条线协议？──
    // 逐模型优先（`models: [{id, as, api}]`），其次供应商级 `protocol`，都没有就跟随客户端。
    // 同协议 → 完全走原来的透传路径（一个字节都不多绕）；不同协议 → 翻译请求体 + 换上游路径，
    // 并把 matrix 传给 forward，由它把响应翻回客户端的形状。
    const clientWire = responsesMode ? 'openai-responses' : 'openai-chat';
    const upWire = resolveUpstreamWire(p, model, bodyHasImage(body)) || clientWire;
    const translating = upWire !== clientWire;
    let sendBody = attemptBody;
    let sendPath = upstreamPath.replace(/^\/v1/, '');
    if (translating) {
      sendBody = translateMatrixRequest(attemptBody, clientWire, upWire, p);
      sendPath = upstreamPathOfWire(upWire);
      log(`try ${p.id} for ${model} [matrix ${clientWire} → ${upWire}]`);
    }
    const fwdOpts = translating
      // ⚠ 翻译后**不能**再传 responses:true —— 那会让 forward 按 Responses 形状去处理
      // 一个已经变成别的协议的请求体（实测会在 translateResponsesBody 里把 input 拍平）。
      ? { matrix: {
        clientWire,
        upstreamWire: upWire,
        model,
        inputTokens: estimateTokens(JSON.stringify((attemptBody && (attemptBody.messages || attemptBody.input)) || '')),
        clientStream: stream,
      } }
      : (responsesMode ? {
        responses: true,
        onSniff: (text) => {
          if (sniffed) return true;
          const id = sniffResponseId(text);
          if (!id) return false;
          sniffed = true;
          affinitySet(id, p.id);
          log(`responses affinity: ${id} → ${p.id}`);
          return true;
        },
      } : undefined);
    const out = await forwardWithAccounts(p, sendPath + search, passthroughHeaders(req.headers, p.apiKey, cfg.clientUA, effectiveClientProfile(cfg, p), cfg), sendBody, res, fwdOpts);
    if (out === true) {
      log(`served ${model} via ${viaTag(p.id)}`);
      // 会话亲和记档：记的是**实际成功的那家**（可能是 failover 之后的一家），
      // 下一轮就优先回到它 —— 缓存热度跟着真实服务方走，而不是跟着配置优先级走。
      if (sessKey) sessionAffinitySet(sessKey, p.id);
      logCall(`via=${viaTag(p.id)}`, 'ok');
      return;
    }
    // 审计修复（P1，本次）：确定性 4xx → 立即终止 failover，按映射后的状态码回复客户端
    if (out && out.stop) {
      log(`failover stopped (${model} via ${p.id} HTTP ${out.stop.upstreamStatus} → ${out.stop.status})`);
      logCall(`via=${viaTag(p.id)}`, 'fail:' + out.stop.status);
      // 矩阵分支会带 `reason`（例如"上游返回的不是 JSON"）—— 那种情况下
      // stopFailoverMessage 的"请求本身有问题"是**错的**文案，会把用户引向排查自己的请求。
      // 有 reason 就用 reason，并把上游状态附上。
      const msg = out.stop.reason
        ? `${out.stop.reason}（上游 ${p.id} 返回 HTTP ${out.stop.upstreamStatus}）`
        : stopFailoverMessage(p.id, model, out.stop.upstreamStatus);
      return json(res, out.stop.status, { error: { message: msg } });
    }
    // R25（审计修复）：响应头已发出（流中途失败/客户端断开）→ failover 无意义，
    // 继续只会对剩余供应商重复计费/风控
    if (res.headersSent || res.destroyed) {
      logCall('stream-broken', 'fail');
      return;
    }
  }
  logCall('all-providers', 'fail');
  json(res, 503, { error: { message: `all providers for model "${model}" are unavailable` } });
}

/* ---------------- OpenAI Responses 协议：资源子路由（GET/DELETE/cancel/input_items） ----------------
 * Responses 是**有状态**协议：response 对象只存在于创建它的那家上游。客户端（Codex、OpenAI
 * SDK、dsh 的 responses 模式）在 POST 之后会用 response.id 继续操作：
 *   GET    /v1/responses/{id}               取回响应对象
 *   GET    /v1/responses/{id}/input_items   取回输入条目（分页 ?limit=&after=&order=）
 *   DELETE /v1/responses/{id}               删除
 *   POST   /v1/responses/{id}/cancel        取消进行中的响应
 * 旧版这些路径全部落到 `404 unsupported route`（网关只认 POST /v1/responses）——
 * 客户端表现为"会话无法恢复/取消无效"，而 Codex 这类客户端会真的用到它们。
 *
 * 路由规则：
 *   ① 亲和表命中（本进程创建过）→ 只发原供应商（唯一持有该资源的家）；失败不再猜别家；
 *   ② 未知 id（网关重启后、或别的实例创建）→ **只读**操作（GET/input_items）按 priority
 *      逐家试探：每家对不属于自己的 id 都回 404，换家无副作用；**写**操作（DELETE/cancel）
 *      不猜，直接 404——避免把删除/取消误发给无关供应商；
 *   ③ 查询串原样透传；上游 JSON 响应原样回传（含状态码）。
 */
async function handleResponsesResource(cfg, req, res, url, tail) {
  const segs = String(tail || '').split('/').filter((s) => s !== '');
  const rawId = segs[0] || '';
  const action = segs[1] || '';
  if (!rawId) return json(res, 404, { error: { message: `unsupported route ${url.pathname}` } });
  let id;
  try { id = decodeURIComponent(rawId); } catch { id = rawId; }   // 畸形百分号编码 → 原样
  const method = req.method;
  const base = '/responses/' + encodeURIComponent(id);
  let upstreamPath = null;
  if (method === 'GET' && !action) upstreamPath = base;
  else if (method === 'GET' && action === 'input_items') upstreamPath = base + '/input_items';
  else if (method === 'DELETE' && !action) upstreamPath = base;
  else if (method === 'POST' && action === 'cancel') upstreamPath = base + '/cancel';
  if (!upstreamPath) {
    return json(res, 404, { error: { message: `unsupported route ${url.pathname}` } });
  }
  // cancel 可能带 body（通常为空）：读完丢弃，避免 keep-alive 下未消费的请求体影响连接
  if (method === 'POST') {
    try { await bodyOf(req); } catch (e) { return replyBodyError(res, req, e, false); }
  }

  const readOnly = method === 'GET';
  // 候选供应商：与模型路由一致，按 priority 升序、同级按配置数组顺序（见 providersForModel）
  const enabled = (cfg.providers || []).filter((p) => p && p.enabled !== false);
  let targets = null;
  const owner = affinityGet(id);
  if (owner) {
    const p = enabled.find((x) => x.id === owner);
    if (p) targets = [p];
    else log(`responses ${method} ${id}: 亲和供应商 ${owner} 已不在配置中，改走探测`);
  }
  if (!targets) {
    if (!readOnly) {
      log(`responses ${method} ${id}: 未知 id 且为写操作 → 不试探供应商（避免误删/误取消别家资源）`);
      return json(res, 404, { error: {
        message: `response "${id}" is not known to this gateway instance; `
          + `refusing to guess which provider owns it for ${method} (re-create it via POST /v1/responses)`,
      } });
    }
    targets = enabled;
  }
  if (targets.length === 0) {
    return json(res, 404, { error: { message: 'no providers configured' } });
  }

  const reqStart = Date.now();
  const client = req.socket?.remoteAddress || 'local';
  const callLog = (via, status) =>
    log(`[call] responses ${method} ${id} ${via} status=${status} dur=${Date.now() - reqStart}ms from=${client} proto=responses`);
  const upPath = upstreamPath + (url.search || '');
  // 上游"故障"（≠ 资源不存在）：502=上游不可用/报错，503=熔断冷却中。
  // 关键点：不能回 404 —— 那等于告诉客户端"response 已被删除"（客户端会丢弃上下文）。
  let failStatus = 0;
  let upstreamNote = '';
  let sawNotFound = false;      // 上游确实回了 404（资源/路由不存在）
  let sawRouteMissing = false;  // 其中至少一家是"整条子路由没实现"（供应商能力缺失）
  for (const p of targets) {
    if (breakerIsOpen(p.id)) {
      log(`skip ${p.id} (breaker open)`);
      if (owner) { failStatus = 503; upstreamNote = 'provider in breaker cooldown'; }
      continue;
    }
    const out = await forward(p, upPath, passthroughHeaders(req.headers, p.apiKey, cfg.clientUA, effectiveClientProfile(cfg, p), cfg), null, res, { raw: true, method });
    if (out === true) {
      callLog(`via=${p.id}`, 'ok');
      return;
    }
    if (out && out.stop) {   // 确定性 4xx（400/413/422/404…）：请求本身有问题，不再换家
      callLog(`via=${p.id}`, 'fail:' + out.stop.status);
      // 注意：不能复用 stopFailoverMessage——那句文案是"模型"语境（model "…"），
      // 而这里的主语是 response 资源，照抄会把 response id 说成模型名，越看越糊涂。
      return json(res, out.stop.status, { error: {
        message: `provider "${p.id}" rejected ${method} /v1/responses/{id} with HTTP ${out.stop.upstreamStatus} — `
          + 'the request itself was rejected upstream (e.g. the response already completed / is not cancellable, '
          + 'or the provider validates this endpoint differently); see the gateway log for the upstream detail.',
      } });
    }
    if (out && out.notFound) {
      sawNotFound = true;
      if (out.routeMissing) sawRouteMissing = true;
    }
    if (out && out.retryable !== undefined) {
      failStatus = 502;
      upstreamNote = out.retryable ? 'upstream HTTP ' + out.retryable : 'upstream request failed';
    }
    if (res.headersSent || res.destroyed) { callLog('stream-broken', 'fail'); return; }
  }
  if (failStatus) {
    callLog(owner ? 'owner-unavailable' : 'probe-unavailable', 'fail:' + failStatus);
    return json(res, failStatus, { error: {
      message: `provider unavailable while handling response "${id}" (${upstreamNote}); the resource is not necessarily gone — retry shortly`,
    } });
  }
  callLog((owner ? 'owner-miss' : 'probe-miss') + (sawRouteMissing ? '/route-missing' : ''), 'fail');
  const ep = `${method} /v1/responses/{id}${upstreamPath.endsWith('/input_items') ? '/input_items' : (upstreamPath.endsWith('/cancel') ? '/cancel' : '')}`;
  const routeHint = sawRouteMissing
    ? ` — the provider does not implement the Responses resource endpoint "${ep}" `
      + '(many new-api/one-api style gateways only support response creation via POST /v1/responses); '
      + 'this is a provider capability limit, not a deletion'
    : (owner ? ` (owner ${owner} returned no such resource — it may have expired or been deleted)` : '');
  json(res, 404, { error: {
    message: `response "${id}" was not found on any configured provider` + routeHint,
  } });
}

/**
 * T5：Anthropic Messages 协议（Claude Code 等客户端）。
 * - 端点 POST /v1/messages，鉴权 x-api-key（authorized() 已支持）
 * - 转发到上游 {upstreamBase}/messages（agentrouter 等的 Anthropic 端点与 OpenAI 同享 /v1 前缀）
 * - 响应（JSON/SSE）原样透传——上游本身输出 Anthropic 格式
 * - 模型名清洗：Claude Code 选择器会显示 "glm-5.3[1m]" 这类带 [标记] 的名字，
 *   匹配与转发时剥离 [xxx] 后缀（T5 宽容匹配）
 */
async function handleMessages(cfg, req, res, body) {
  dumpBodyDigest(body, 'messages');   // R8/R10：诊断 dump（env 控制）
  const rawModel = body && body.model;
  if (!rawModel) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'model is required' } });
  const model = String(rawModel).replace(/\[[^\]]*\]\s*$/, '').trim() || String(rawModel);
  if (model !== String(rawModel)) log(`model name cleaned: "${rawModel}" -> "${model}"`);

  const reqStart = Date.now();
  const client = req.socket?.remoteAddress || 'local';
  const stream = !!(body && body.stream);
  const logCall = (via, status) =>
    log(`[call] ${model} ${via} status=${status} stream=${stream ? 1 : 0} dur=${Date.now() - reqStart}ms from=${client} proto=anthropic`);

  // body.model 替换为清洗后的名字（上游按真实模型 ID 路由）
  // R9：Anthropic content blocks 的 text 字段同样做密钥打码（与 OpenAI 路径一致）
  let outBody;
  if (body && Array.isArray(body.messages)) {
    let changed = false;
    const msgs = body.messages.map((m) => {
      if (!m) return m;
      // content 为字符串
      if (typeof m.content === 'string') {
        const d = maskSecretTokens(m.content);
        if (d !== m.content) { changed = true; return { ...m, content: d }; }
        return m;
      }
      // content 为 blocks 数组（[{type:'text',text:'…'}]）
      if (Array.isArray(m.content)) {
        let bc = false;
        const blocks = m.content.map((b) => {
          if (b && b.type === 'text' && typeof b.text === 'string') {
            const d = maskSecretTokens(b.text);
            if (d !== b.text) { bc = true; return { ...b, text: d }; }
          }
          return b;
        });
        if (bc) { changed = true; return { ...m, content: blocks }; }
      }
      return m;
    });
    outBody = changed ? { ...body, messages: msgs, model } : { ...body, model };
  } else {
    outBody = { ...body, model };
  }

  const candidates = providersForModel(cfg, model);
  if (candidates.length === 0) {
    logCall('no-provider', 'fail');
    return json(res, 404, { type: 'error', error: { type: 'invalid_request_error', message: `model "${model}" is not configured on this gateway` } });
  }

  // 候选收敛（**配置列表为唯一权威**，见 selectCandidates）：只探测"没配模型"的 provider
  const catalogResults = await Promise.all(candidates.map((p) => (needsCatalog(p)
    ? fetchCatalog(p, false, cfg.clientUA, effectiveClientProfile(cfg, p), cfg)
    : null)));
  let { eligible, reasons, tierSizes } = selectCandidates(candidates, catalogResults, model);
  // 多模态（2026-09-16）：请求里带图片时，只保留声明了图片能力的候选
  const imgStats = imageBlockStats(body);
  if (imgStats.total > 0) {
    const vf = filterVisionCandidates(eligible, reasons, model);
    if (vf.dropped > 0) {
      log(`[route] ${model}: 请求含图片（本轮 ${imgStats.lastTurn} 张 / 历史 ${imgStats.history} 张）`
        + ` → 跳过未声明图片能力的 ${vf.dropped} 家`);
      eligible = vf.eligible;
      reasons = vf.reasons;
    }
  }
  const reasonsText = routeReasonsText(reasons);
  // 选路决策日志（2026-09-15 加）：**每次请求都记**——"为什么发给了这家"必须能在日志里
  // 直接看到（此前只在失败时才记原因，用户遇到"该走 A 却走了 B"时无从判断）。
  log(`[route] ${model}: ${eligible.length} 个候选（配置声明 ${tierSizes[0]} / 未配置按目录兜底 ${tierSizes[1]}）｜${reasonsText}`);

  // V1 防封：跳过熔断中的 provider（连续失败保护期，不发起上游请求）
  const breakerOpen = (p) => { if (breakerIsOpen(p.id)) { log(`skip ${p.id} (breaker open)`); return true; } return false; };
  const ordered = eligible.filter((p) => !breakerOpen(p));
  if (ordered.length === 0) {
    if (eligible.length === 0 && candidates.length > 0 && candidates.every((p) => breakerIsOpen(p.id))) {
      // 全部候选都熔断中（catalog 因熔断未探测 → 归属无法判定）：暂时状态 → 503（R20），不再误报 404
      log(`[route] ${model}: 全部候选熔断，归属无法判定（${reasonsText}）`);
      logCall('breaker-all', 'fail');
      return json(res, 503, { type: 'error', error: { type: 'api_error', message: `all providers for model "${model}" are temporarily in breaker cooldown; retry in ~${breakerCooldownSecs(candidates)}s or restart the gateway` } });
    }
    if (eligible.length === 0) {
      // catalog 未收录且 models 列表不含 → 404 + 排查提示（只回网关自身的判定码，不回显上游内容）
      log(`[route] ${model}: 无候选 provider（${reasonsText}）`);
      logCall('no-provider', 'fail');
      return json(res, 404, { type: 'error', error: {
        type: 'invalid_request_error',
        message: `model "${model}" is not offered by any configured provider — ${MODEL_NOT_OFFERED_HINT}`,
        details: routeReasonsDetail(reasons),
      } });
    }
    // 候选存在但全部处于熔断冷却：暂时状态 → 503（R20）
    log(`[route] ${model}: 候选全部熔断（${reasonsText}）`);
    logCall('breaker-all', 'fail');
    return json(res, 503, { type: 'error', error: { type: 'api_error', message: `all providers for model "${model}" are temporarily in breaker cooldown; retry in ~${breakerCooldownSecs(eligible)}s or restart the gateway` } });
  }

  let tryOrder = ordered;
  if (cfg.routing === 'round-robin' && ordered.length > 1) {
    // 审计修复（P3）：rrCounters 的 key 是**客户端可控**的 model 字符串——无界增长。
    // 加一个粗粒度上限（超限即整体重置，轮询起点偏差可忽略）。
    if (rrCounters.size > 1000) rrCounters.clear();
    let n = rrCounters.get(model) || 0;
    rrCounters.set(model, n + 1);
    const start = n % ordered.length;
    if (start > 0) tryOrder = [...ordered.slice(start), ...ordered.slice(0, start)];
  }

  for (const p of tryOrder) {
    // 模型映射：逻辑名 → 该供应商的上游真实 ID（Anthropic 路径同样处理）；
    // 带图片时优先选声明了 vision 的那条上游 ID（见 upstreamIdFor）
    const attemptBody = bodyForProvider(outBody, p, model, bodyHasImage(body));
    const upModel = attemptBody.model;
    // 上游线协议：**逐模型 `api`** → 供应商 `protocol` → 跟随客户端（即 Anthropic 直通）。
    // 逐模型这一层是协议矩阵的前提：同一个供应商里不同模型可能分属不同协议
    //（实测 opencode-go：29 个 chat + 2 个 anthropic + 4 个 responses）。
    const upWire = resolveUpstreamWire(p, model, bodyHasImage(body)) || 'anthropic-messages';
    const toOpenAI = upWire === 'openai-chat';
    const toResponses = upWire === 'openai-responses';
    // 日志措辞刻意保持原样：直通时仍是 `(anthropic)`，只有真的跨协议才加 `→xxx`。
    // 已有用例与用户的排查习惯都建立在这行日志上，措辞churn 没有收益。
    const wireLabel = toOpenAI ? 'anthropic→openai' : (toResponses ? 'anthropic→responses' : 'anthropic');
    log(`try ${p.id} for ${model} (${wireLabel})${upModel !== model ? ' → ' + upModel : ''}`);
    // 认证头按**上游协议**选：Anthropic 路径发 x-api-key，chat/responses 发 Bearer
    const baseHeaders = upstreamRequestHeaders(req.headers, p.apiKey, cfg.clientUA, !toOpenAI && !toResponses, effectiveClientProfile(cfg, p), cfg);
    // OpenCode 车道的动态会话头：**两条路径共用这一份 headers，就必须在这里补**
    //（只在 forward() 里补会让声明了 openai-chat 的那批模型全部 400 MissingSessionID）。
    applyOpencodeLaneHeaders(baseHeaders, attemptBody, p.id);
    let out;
    if (toResponses) {
      // 协议矩阵：Anthropic 客户端 ← Responses 上游。
      // 请求体 Anthropic→chat→Responses 在这里翻；响应由 forward 里的矩阵分支翻回 Anthropic
      //（客户端仍收到标准的 message_start / content_block_delta 事件序列）。
      out = await forwardWithAccounts(p, '/responses',
        baseHeaders,
        translateMatrixRequest(attemptBody, 'anthropic-messages', 'openai-responses', p),
        res,
        { matrix: {
          clientWire: 'anthropic-messages',
          upstreamWire: 'openai-responses',
          model,
          inputTokens: estimateTokens(JSON.stringify(attemptBody.messages || '')),
          clientStream: !!body.stream,
        } });
    } else if (toOpenAI) {
      out = await forwardAnthropicViaOpenAI(p, baseHeaders, attemptBody, res, undefined);
    } else {
      out = await forwardWithAccounts(p, '/messages', baseHeaders, attemptBody, res);
    }
    if (out === true) {
      log(`served ${model} via ${viaTag(p.id)} (anthropic)`);
      logCall(`via=${viaTag(p.id)}`, 'ok');
      return;
    }
    // 审计修复（P1，本次）：确定性 4xx → 立即终止 failover，按映射后的状态码回复客户端
    //（Anthropic 错误体形状：{type:'error',error:{type,message}}；不回显上游原文）
    if (out && out.stop) {
      log(`failover stopped (${model} via ${p.id} HTTP ${out.stop.upstreamStatus} → ${out.stop.status}, anthropic)`);
      logCall(`via=${viaTag(p.id)}`, 'fail:' + out.stop.status);
      return json(res, out.stop.status, { type: 'error', error: {
        // 与 handleCompletion 对齐：矩阵分支会带 `reason`（如"上游返回的不是 JSON"）。
        // 那种情况下 `stopFailoverMessage` 的"请求本身有问题"是**错的**文案 ——
        // 会把用户引向反复排查自己的请求，而真正的问题在上游前面的反代。
        type: out.stop.status >= 500 ? 'api_error' : 'invalid_request_error',
        message: out.stop.reason
          ? `${out.stop.reason}（上游 ${p.id} 返回 HTTP ${out.stop.upstreamStatus}）`
          : stopFailoverMessage(p.id, model, out.stop.upstreamStatus),
      } });
    }
    // R25（审计修复）：响应头已发出（流中途失败/客户端断开）→ failover 无意义
    if (res.headersSent || res.destroyed) {
      logCall('stream-broken', 'fail');
      return;
    }
  }
  logCall('all-providers', 'fail');
  json(res, 503, { type: 'error', error: { type: 'api_error', message: `all providers for model "${model}" are unavailable` } });
}

async function handleModels(cfg, req, res) {
  const seen = new Set();
  const rows = [];
  const push = (id, owner) => {
    const name = String(id || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    // T5：同时携带 Anthropic 模型发现字段（display_name/type）——Claude Code 等
    // Anthropic 客户端可读；OpenAI 客户端忽略多余字段，互不影响
    rows.push({ id: name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: owner, type: 'model', display_name: name, created_at: new Date().toISOString() });
  };
  const providers = providersForModel(cfg);
  // 1) 先列**配置里声明的逻辑模型名**（模型映射后，dsh 请求的是逻辑名，目录里可能根本没有它）
  for (const p of providers) for (const as of logicalModelNames(p)) push(as, p.id);
  // 2) 只对**一个模型都没配**的服务商补目录（配置列表是权威：配了就不看目录，
  //    否则会列出网关根本不会路由的模型——dsh 选中后才 404，体验更差）
  await Promise.all(providers.filter((p) => needsCatalog(p)).map((p) => fetchCatalog(p, false, cfg.clientUA, effectiveClientProfile(cfg, p), cfg)));
  for (const p of providers) {
    if (!needsCatalog(p)) continue;
    const entry = catalogCache.get(p.id);
    // 失败冷却期（models=null）或无缓存：跳过（R10：不能对 null models 迭代）
    if (!entry || !entry.models) continue;
    const alias = new Map(modelEntries(p).map((e) => [e.up, e.as]));
    for (const id of entry.models) push(alias.get(id) || id, p.id);
  }
  // 2026-09-16：按模型名排序输出（选择器/客户端列表不再杂乱无章；此前是"供应商配置顺序+去重"）
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true, sensitivity: 'base' }));
  json(res, 200, { object: 'list', data: rows });
}

/* ---------------- server ---------------- */
function trimSlash(u) { return u.replace(/\/+$/, ''); }

/**
 * 规范化供应商 baseURL（P1 修复）：
 * - 允许带 /v1（OpenAI SDK 惯例）或不带（用户常直接填域名）
 * - 不带时自动补 /v1；带其他后缀（如 /v1/chat/completions 误填）则收敛到 /v1
 * 返回以 /v1 结尾的 base（不含尾斜杠）
 */
function upstreamBase(baseURL) {
  let b = trimSlash(String(baseURL || ''));
  if (!b) return b;
  // 2026-09-16：泛化到任意 /vN —— WorkBuddy 的接口在 /v2（旧实现只认 /v1，会拼成 /v1/chat/completions）。
  // 带版本号（/v1、/v2…）→ 收敛到该版本；不带 → 补 /v1（OpenAI SDK 惯例，保持旧行为）。
  const m = b.match(/\/(v\d+)(?:\/.*)?$/i);
  if (m) return b.slice(0, b.length - m[0].length + m[1].length + 1);
  return b + '/v1';
}

function startServer(cfg) {
  const server = http.createServer((req, res) => {
    // 审计修复（P2）：路由整体兜底。旧版 handler 是 async 但返回的 promise 被丢弃——
    // 任何未预期抛出（畸形 Host 让 new URL 抛错、提供应商条目非法等）只进
    // unhandledRejection 日志，**客户端永远收不到响应**（requestTimeout=0 无兜底）。
    routeRequest(cfg, req, res).catch((err) => {
      log(`request handler error: ${err && err.message ? err.message : err}`);
      try {
        if (!res.headersSent) json(res, 500, { error: { message: 'gateway internal error' } });
        else res.destroy();
      } catch { /* 忽略 */ }
    });
  });
  installShutdown(server);

  // R7 强壮性：SSE 流可能持续数十秒（sensenova 等上游慢时 30-60s），
  // 关闭 Node 默认的 requestTimeout(300s 内请求必须结束) 上限，避免长流被掐断导致 dsh 重连；
  // headersTimeout 保留 60s（防慢速头攻击）。
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  server.listen(cfg.port, '127.0.0.1', () => {
    log(`gateway listening on http://127.0.0.1:${cfg.port}`);
    // 代理状态自述（v1.8.2）：每次启动都留一行"走不走代理 / 哪些域名直连"，
    // 于是"上游 ECONNREFUSED 到底是代理挂了还是上游挂了"一眼可判。
    {
      const st = proxyStatus();
      log(`proxy: ${st.url ? '走 ' + st.url + (st.envProxy ? '（NODE_USE_ENV_PROXY=1）' : '') : '直连（未注入代理）'}；NO_PROXY=${st.noProxy || '(空)'}`);
    }
    console.log(`[gateway] listening on http://127.0.0.1:${cfg.port}`);
  });
  server.on('error', (e) => {
    log(`server error: ${e.message}`);
    console.error(`[gateway] server error: ${e.message}`);
    // 端口占用等致命错误：直接退出，让宿主(助手)能明确感知进程终止（C2）
    process.exit(1);
  });

  // R17（假死自愈）：进程内自检 watchdog——每 60s 自请求 /health；事件循环卡死或
  // server 假死（表现：无调用一段时间后无法连接，重启才恢复）时自检超时，连续 3 次
  // 失败即自杀退出（宿主 gateway-manager 的 exit 处理会自动重启，清空全部状态复活）。
  //
  // v1.8.2 加固（2026-09-16 事故：**健康进程自杀**）：
  //   旧实现用 http.get 探 127.0.0.1——而 NODE_USE_ENV_PROXY=1 时 Node 连回环请求也走代理，
  //   clash 端口一没监听就 8ms ECONNREFUSED，三次自检全败 → 自杀 → 宿主当崩溃重启（19:22:40）。
  //   两处修正：① 改成**裸 socket 发最小 HTTP 请求**，不经过任何代理层——自检只测"本进程
  //   server 是否还能应答"，代理死活与此无关；② 每次自检**最多记一次失败**（旧实现
  //   timeout 后 destroy 又触发 error，一次超时记两笔，两分钟就能凑够 3 次）；并把失败
  //   原因/耗时写进日志，不再只写"连续 3 次失败"。
  {
    let fails = 0;
    const probe = () => new Promise((resolve) => {
      const t0 = Date.now();
      let done = false;
      const finish = (ok, why) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch (_) { /* 已关 */ }
        if (ok) { fails = 0; return; }
        fails += 1;
        log(`self-watchdog: /health ${why}（${Date.now() - t0}ms，连续失败 ${fails}/3）`);
        if (fails >= 3) {
          log('self-watchdog: 连续 3 次自检失败，进程自杀重启（宿主会自动拉起，属自愈行为）。');
          process.exit(1);
        }
      };
      const sock = net.connect({ host: '127.0.0.1', port: cfg.port });
      sock.setTimeout(8000);
      let buf = '';
      sock.on('connect', () => sock.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
        if (m) finish(m[1] === '200', `返回 HTTP ${m[1]}`);
      });
      sock.on('timeout', () => finish(false, '超时 8s（事件循环疑似卡死）'));
      sock.on('error', (e) => finish(false, `连接错误 ${e && e.code ? e.code : e.message}`));
      sock.on('close', () => finish(false, '连接被关闭且无响应'));
    });
    setInterval(() => { probe().catch(() => { /* 自检本身绝不抛 */ }); }, 60_000);
  }
  return server;
}

/** 请求路由（独立函数：由 createServer 的 handler 兜底 catch，见 startServer） */
async function routeRequest(cfg, req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (_) {
      // `Host: [` 或畸形绝对形式 request-URI 会让 new URL 抛 ERR_INVALID_URL
      json(res, 400, { error: { message: 'bad request target' } });
      try { req.destroy(); } catch { /* 忽略 */ }
      return;
    }
    const p = url.pathname;
    if (p === '/health') {
      // 账户池可见性（2026-09-16）：WorkBuddy 这类按账户计费/限流的供应商，出问题时必须能
      // 一眼看出"哪个账户在冷却、为什么"。无账户池时该字段为空数组，不影响旧客户端解析。
      // 代理可见性（v1.8.2）：把"是否走代理 / 哪些域名直连"也放进来——2026-09-16 事故里
      // 上游 ECONNREFUSED 的真凶是 clash 端口没在监听，而 /health 当时只有 accounts。
      json(res, 200, { ok: true, accounts: accountPoolSnapshot(cfg), proxy: proxyStatus() });
      return;
    }

    // CORS 预检（OPTIONS）：**必须放在鉴权之前**。
    // 按 CORS 规范，浏览器的预检请求**不携带凭据**（没有 Authorization / x-api-key），
    // 所以把它放在 authorized() 后面必然 401 → 任何浏览器端客户端都永远发不出请求。
    // 实测（2026-10-08 全面测试）：OPTIONS 无凭据 → 401 invalid x-api-key；
    // 带凭据 → 落在 404（根本没写 OPTIONS 分支）—— 两种都不是合法的预检响应。
    // 另外原来所有响应只回了 `access-control-allow-origin`，没有 `allow-headers`，
    // 于是即使预检侥幸过了，浏览器也不会允许发 `anthropic-version` 这类自定义头。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        // 回显客户端声明的头最省事也最不容易漏（本地网关，不存在跨站滥用面）
        'access-control-allow-headers': req.headers['access-control-request-headers']
          || 'authorization, x-api-key, anthropic-version, anthropic-beta, content-type, accept',
        'access-control-max-age': '86400',
      });
      // ⚠ **必须 end**。只 writeHead 不 end 的话响应永不结束 —— 客户端一路挂到超时
      //（实测：OPTIONS 拿到 st=0 / TIMEOUT，而 POST 正常 401，很容易误判成"预检被拒"）。
      // 204 本身不能带 body，所以 end() 不带参数，也不要手写 content-length。
      res.end();
      return;
    }

    if (p.startsWith('/v1/')) {
      const anthropicRoute = (p === '/v1/messages');
      if (!authorized(req, cfg)) {
        return anthropicRoute
          ? json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
          : json(res, 401, { error: { message: 'invalid or missing API key' } });
      }
      if (req.method === 'GET' && p === '/v1/models') return await handleModels(cfg, req, res);
      if (req.method === 'POST' && p === '/v1/messages') {
        // T5：Anthropic Messages 协议（Claude Code 等）
        try {
          const body = await bodyOf(req);
          return await handleMessages(cfg, req, res, body);
        } catch (e) {
          return replyBodyError(res, req, e, true);
        }
      }
      if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/v1/responses')) {
        try {
          const body = await bodyOf(req);
          // Responses 与 chat/completions 共用同一个处理器（同一家上游的两种协议）：
          // Responses 走自己的体翻译（instructions/input/reasoning.effort）与亲和路由
          return await handleCompletion(cfg, req, res, body, p, {
            responses: p === '/v1/responses',
            search: url.search || '',
          });
        } catch (e) {
          return replyBodyError(res, req, e, false);
        }
      }
      // Responses 资源子路由（有状态协议：客户端用 response.id 取回/删除/取消/取输入）
      if (p.startsWith('/v1/responses/')) {
        return await handleResponsesResource(cfg, req, res, url, p.slice('/v1/responses/'.length));
      }
      return json(res, 404, { error: { message: `unsupported route ${p}` } });
    }

    json(res, 404, { error: { message: 'not found' } });
}

// —— 进程级优雅关停（审计 P3）：宿主 taskkill /T /F 之前会先尝试正常终止；
// 这里停止接收新请求并让在途请求有机会收尾，避免 SSE 直接被硬杀截断。 ——
function installShutdown(server) {
  let closing = false;
  const bye = (sig) => {
    if (closing) return;
    closing = true;
    try { log(`received ${sig}, shutting down gracefully`); } catch { /* 忽略 */ }
    try { server.close(() => process.exit(0)); } catch { /* 忽略 */ }
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('SIGINT', () => bye('SIGINT'));
}

/* ---------------- write-dsh: register gateway into dsh host config ---------------- */
/**
 * 在 settings.yaml 中「按层级」upsert `llm-pi-ai.providers.gateway`（审计修复 P1-7）。
 *
 * 只动 llm-pi-ai → providers → gateway 这一条路径，绝不触碰文件里其它位置同名/同缩进的键。
 * 返回新文本（无改动时返回原文本）。
 */
/**
 * 宽松判断"某个键已在该层级出现过"（允许尾随注释 / flow 风格 `{}` / 引号别名）。
 *
 * 第四轮审计修复：写 settings.yaml 时的定位正则都要求"键独占一行、无尾随内容"
 *（`/^ {2}providers:\s*$/` 之类）。命中不了时旧实现会**追加第二个同名键**，而 YAML 解析器
 * 默认 `uniqueKeys: true`，重复键直接报错；宿主是"先 rename 再 parse"，一抛错则该文件
 * **所有 section 都不导入**（模型全丢）。这里用宽松匹配兜底：既然存在却改不动，就明确中止，
 * 而不是写出一个必然解析失败的文件。
 *
 * @param {string[]} lines - 文件行。
 * @param {number} from - 起（含）。
 * @param {number} to - 止（不含）。
 * @param {number} indent - 期望缩进空格数。
 * @param {string} name - 键名。
 * @returns {boolean} true = 该层级已存在同名键。
 */
function hasLooseKey(lines, from, to, indent, name) {
  const re = new RegExp('^' + ' '.repeat(indent) + name + '\\s*:');
  for (let i = from; i < to; i++) {
    if (re.test(lines[i])) return true;
  }
  return false;
}

function upsertGatewayInSettings(settings, block) {
  const lines = settings.split('\n');
  const at = (i) => lines[i].replace(/\r$/, '');
  // 1) 顶层 llm-pi-ai: 块范围（第 0 列的键，块到下一个第 0 列非空行为止）
  let pi = -1;
  let piEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^llm-pi-ai:\s*$/.test(at(i))) {
      pi = i;
      piEnd = i + 1;
      for (; piEnd < lines.length; piEnd++) {
        const l = at(piEnd);
        if (l.trim() !== '' && !/^\s/.test(l)) break;
      }
      break;
    }
  }
  if (pi < 0) {
    // 整个 llm-pi-ai 段都不存在 → 追加（但若它以改不动的形式存在，宁可中止，见 hasLooseKey）
    if (hasLooseKey(lines, 0, lines.length, 0, 'llm-pi-ai')) {
      throw new Error('settings.yaml 已含 llm-pi-ai，但不是可安全改写的形式（需该键独占一行、无尾随内容）。已中止，以免写出重复键导致整份配置无法解析。');
    }
    const suffix = settings.trimEnd().length > 0 ? '\n' : '';
    return settings + suffix + 'llm-pi-ai:\n  providers:\n' + block + '\n';
  }
  // 2) 块内的 `  providers:`（缩进 2）
  let pIdx = -1;
  for (let i = pi + 1; i < piEnd; i++) {
    if (/^ {2}providers:\s*$/.test(at(i))) { pIdx = i; break; }
  }
  if (pIdx < 0) {
    if (hasLooseKey(lines, pi + 1, piEnd, 2, 'providers')) {
      throw new Error('settings.yaml 的 llm-pi-ai 段已含 providers，但不是可安全改写的形式。已中止，以免写出重复键。');
    }
    lines.splice(piEnd, 0, '  providers:', ...block.split('\n'));
    return lines.join('\n');
  }
  // 3) providers 子块范围（缩进 > 2 的行）
  let pEnd = pIdx + 1;
  for (; pEnd < piEnd; pEnd++) {
    const l = at(pEnd);
    if (l.trim() === '') continue;
    if (/^ {0,2}\S/.test(l)) break;
  }
  // 4) 子块内的 `    gateway:`（缩进 4）
  let g = -1;
  let gEnd = -1;
  for (let i = pIdx + 1; i < pEnd; i++) {
    if (/^ {4}gateway:\s*$/.test(at(i))) {
      g = i;
      gEnd = i + 1;
      for (; gEnd < pEnd; gEnd++) {
        const l = at(gEnd);
        if (l.trim() === '') continue;
        if (/^ {0,4}\S/.test(l)) break;      // 缩进 ≤4 → 该 provider 条目结束
      }
      while (gEnd > g + 1 && at(gEnd - 1).trim() === '') gEnd--;   // 尾部空行留在块外
      break;
    }
  }
  const blockLines = block.split('\n');
  if (g >= 0) {
    if (lines.slice(g, gEnd).join('\n') === blockLines.join('\n')) return settings;   // 内容一致 → 不动
    lines.splice(g, gEnd - g, ...blockLines);
  } else {
    if (hasLooseKey(lines, pIdx + 1, pEnd, 4, 'gateway')) {
      throw new Error('settings.yaml 的 llm-pi-ai.providers 段已含 gateway，但不是可安全改写的形式。已中止，以免写出重复键。');
    }
    let ins = pEnd;
    while (ins > pIdx + 1 && at(ins - 1).trim() === '') ins--;
    lines.splice(ins, 0, ...blockLines);
  }
  return lines.join('\n');
}

/**
 * Usage: node model-gateway.mjs --write-dsh [--config <cfg>] [--settings <settings.yaml>] [--credentials <credentials.yaml>] [--port <n>] [--key <unified key>]
 *
 * Inserts/updates an `llm-pi-ai.providers.gateway` entry in the dsh settings.yaml
 * (models merged from the gateway config) and ensures `DSH_GATEWAY_API_KEY` exists
 * in the credentials refs so dsh's llm layer can resolve apiKeyEnv.
 */
/**
 * 原子写文件 + 首次备份 + 自动建目录（第四轮审计修复）。
 *
 * 为什么必须原子：write-dsh 直接覆写 dsh 的 `settings.yaml` / `.credentials.yaml`，而宿主是
 * **先 rename 再 parse**（dsh-settings 的 importLegacyDocument）——半截写入会让 YAML 解析抛错，
 * 后果是**该文件所有 section 一个都不导入**（模型全丢），且原文件已被改名，不会自愈。
 * 同项目的 gateway-manager.saveConfig 早已用 tmp+rename，这里对齐。
 * 顺带修掉"父目录不存在即 ENOENT"（新机器上 `~/.dsh` 还没被 dsh 创建时点「写入 dsh 配置」）。
 *
 * @param {string} file - 目标文件。
 * @param {string} text - 完整内容。
 * @param {string} [backupSuffix] - 首次备份后缀（`.bak-gateway`）；备份已存在则不覆盖，保留最原始那份。
 */
function writeFileAtomicDsh(file, text, backupSuffix) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (backupSuffix && fs.existsSync(file)) {
    const bak = file + backupSuffix;
    try { if (!fs.existsSync(bak)) fs.copyFileSync(file, bak); } catch { /* 备份失败不阻断主流程 */ }
  }
  const tmp = file + '.tmp-write-dsh';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 把一段 YAML 块整体缩进 `n` 个空格（每行都加，空行不加）。
 * settings.yaml 里 `gateway:` 在 4 空格，profile patch 里在 6 空格（多一层 `- id:` 数组项）。
 */
function reindentBlock(block, n) {
  const pad = ' '.repeat(n);
  return String(block).split('\n').map((l) => (l.trim() === '' ? l : pad + l)).join('\n');
}

/**
 * 在 dsh **profile patch**（`<profiles>/<name>/cordis.patch.yml`）里 upsert
 * `- id: llm-pi-ai` 这一项的 `config.providers.gateway`。
 *
 * 为什么需要它（2026-10-07 实测）：官方 dsh 已经把 `settings.yaml` 标记为 **removed** ——
 * 启动时只把它**导入一次**然后改名成 `settings.yaml.imported`，而且必须重启才生效。
 * 当前真正生效的载体是 profile 的 patch 文件（`cordis.patch.yml`），文件头自己写着
 * "Your patch layer for this dsh profile, applied after every bundle layer"，
 * Web 界面的 Models 页也是写这里。只写 settings.yaml 的话，用户会遇到
 * "命令报成功、dsh 里却看不到网关"，而且**过一段时间还会凭空消失**（导入失败只在改名后的文件里留痕）。
 *
 * 定位方式与 upsertGatewayInSettings 同款：**逐行、按缩进层级**，不用全局正则 ——
 * 数组里可能有别的项也叫 gateway，全局正则会把它们一起改掉。
 *
 * @param {string} text  patch 文件原文（可为空 = 文件不存在）
 * @param {string} block 要写入的 `gateway:` 块（缩进按 patch 层级，6 空格起）
 * @returns {string} 改写后的文本
 */
function upsertGatewayInPatch(text, block) {
  const src = String(text == null ? '' : text);
  const lines = src.split(/\r?\n/);
  const indentOf = (l) => (/^(\s*)/.exec(l) || ['', ''])[1].length;
  const isBlank = (l) => String(l).trim() === '';

  // 找顶层数组项 `- id: llm-pi-ai`（引号可选，id 后可跟注释）
  const idRe = /^(\s*)-\s*id:\s*['"]?llm-pi-ai['"]?\s*(?:#.*)?$/;
  let start = -1;
  let itemIndent = '';
  for (let i = 0; i < lines.length; i++) {
    const m = idRe.exec(lines[i]);
    if (m) { start = i; itemIndent = m[1]; break; }
  }

  // 找"属于某个块"的结束位置：从 from 行往下，第一行**非空且缩进 <= indent** 的就结束
  const blockEnd = (from, indent) => {
    let end = lines.length;
    for (let i = from; i < lines.length; i++) {
      if (!isBlank(lines[i]) && indentOf(lines[i]) <= indent) { end = i; break; }
    }
    // 不要吞掉块尾的空行（那是与下一项之间的分隔）
    while (end > from && isBlank(lines[end - 1])) end--;
    return end;
  };

  if (start < 0) {
    // 文件里没有这一项（或文件根本不存在）→ 追加一个**完整的数组项**。
    // ⚠ 不能只追加 `gateway:` 那个块：patch 的顶层是 YAML **数组**，
    // 光有 providers 块的话整份文件会变成一个 mapping，dsh 直接加载不了
    //（实测：只写块时 js-yaml 解析出来的不是数组，`- id:` 项全丢）。
    const entry = [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      block,
    ].join('\n');
    const body = src.trim() === '' ? entry : src.replace(/\s*$/, '') + '\n' + entry;
    return body.replace(/\s*$/, '') + '\n';
  }

  const pad = ' '.repeat(indentOf(lines[start]));
  // 本项的结束：下一个同缩进的 `- ` 项
  let itemEnd = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s/.test(lines[i]) && indentOf(lines[i]) === pad.length) { itemEnd = i; break; }
  }

  // 在本项内找 `config:`（缩进 = pad + 2）
  const cfgIndent = pad.length + 2;
  let cfgLine = -1;
  for (let i = start + 1; i < itemEnd; i++) {
    if (/^\s*config:\s*(?:#.*)?$/.test(lines[i]) && indentOf(lines[i]) === cfgIndent) { cfgLine = i; break; }
  }

  // 在 config 内找 `providers:`（缩进 = pad + 4）
  const provIndent = pad.length + 4;
  const gwIndent = provIndent + 2;

  // 把 gateway 块并进 providers —— **只动 gateway 这一个键**。
  // ⚠ 绝不能整段替换 providers：用户可能在里面配了别的供应商（实测踩到：
  // 整段替换会把它们全部抹掉，那是不可逆的数据丢失）。
  const mergeIntoProviders = (provLine, provEnd) => {
    // providers 带内联值（`providers: {}`）时先展开成块形式，否则后面插缩进行会写出非法 YAML。
    const inline = lines[provLine].replace(/^\s*providers:\s*/, '').replace(/#.*$/, '').trim();
    if (inline) {
      if (inline !== '{}') {
        // 有内容的内联表无法在文本层面安全合并 → 拒绝改写，交给上层如实报告
        throw new Error('patch 里 llm-pi-ai.config.providers 是带内容的内联映射（' + inline
          + '），无法安全合并。请手工把 gateway 加进去，或把它改写成块形式后重试。');
      }
      lines[provLine] = ' '.repeat(provIndent) + 'providers:';
      provEnd = provLine + 1;
    }
    // providers 里已经有 gateway 吗
    let gwLine = -1;
    for (let i = provLine + 1; i < provEnd; i++) {
      if (/^\s*gateway:\s*(?:#.*)?$/.test(lines[i]) && indentOf(lines[i]) === gwIndent) { gwLine = i; break; }
    }
    if (gwLine >= 0) {
      const gwEnd = Math.min(blockEnd(gwLine + 1, gwIndent), provEnd);
      lines.splice(gwLine, gwEnd - gwLine, ...block.split('\n'));
    } else {
      // 插到 providers 段末尾（跳过尾部的空行，别把分隔空行顶开）
      const ins = (provEnd > provLine + 1 && isBlank(lines[provEnd - 1])) ? provEnd - 1 : provEnd;
      lines.splice(ins, 0, ...block.split('\n'));
    }
    return lines.join('\n');
  };

  if (cfgLine >= 0) {
    const cfgEnd = Math.min(blockEnd(cfgLine + 1, cfgIndent), itemEnd);
    let provLine = -1;
    for (let i = cfgLine + 1; i < cfgEnd; i++) {
      if (/^\s*providers:/.test(lines[i]) && indentOf(lines[i]) === provIndent) { provLine = i; break; }
    }
    if (provLine < 0) {
      // 有 config 但没有 providers → 在 config 下建一个
      lines.splice(cfgLine + 1, 0, ' '.repeat(provIndent) + 'providers:', ...block.split('\n'));
      return lines.join('\n');
    }
    return mergeIntoProviders(provLine, Math.min(blockEnd(provLine + 1, provIndent), itemEnd));
  }

  // 连 config 都没有 → 在本项末尾补一个
  const ins = (isBlank(lines[itemEnd - 1]) ? itemEnd - 1 : itemEnd);
  lines.splice(ins, 0, ' '.repeat(cfgIndent) + 'config:', ' '.repeat(provIndent) + 'providers:', ...block.split('\n'));
  return lines.join('\n');
}

function writeDshConfig(args) {
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const cfgPath = get('--config') || CONFIG_PATH;
  // 第四轮审计修复：尊重 DSH_HOME（与 plugin-snapshot / default-plugins / market / watchdog 一致）。
  // 旧实现硬编码 `os.homedir()/.dsh` —— 用户设了 DSH_HOME 时配置会被写进**另一个目录**，
  // 命令报告成功、dsh 却完全不认（宿主侧 dsh-credentials-local 同样按 DSH_HOME 解析）。
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const settingsPath = get('--settings') || process.env.DSH_SETTINGS || path.join(dshHome, 'settings.yaml');
  const credsPath = get('--credentials') || process.env.DSH_CREDENTIALS || path.join(dshHome, '.credentials.yaml');
  if (!fs.existsSync(cfgPath)) {
    console.error(`[write-dsh] gateway config not found: ${cfgPath}`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // R25（审计修复）：端口优先级 --port > cfg.port > 3091——旧版硬编码 3091，
  // 该文件随应用原样分发，直跑不传 --port 且配置为其他端口（如桌面助手 3090）时写错 baseURL
  const port = Number(get('--port') || cfg.port || 3091);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[write-dsh] invalid port: ${get('--port') || cfg.port}`);
    process.exit(1);
  }
  const key = get('--key') || '';

  const apiKey = key || cfg.apiKey || '';
  if (!apiKey || apiKey === 'dsh-gateway-change-me') {
    console.error('[write-dsh] unified apiKey is not set (edit gateway.config.json first)');
    process.exit(1);
  }
  // R11：协议与仿真一致——clientProfile=claude → Anthropic 协议（与 Claude Code 同形态，
  // 经实测可避开 new-api 对 OpenAI 超长请求的内容拦截）；codex/缺省 → OpenAI 协议。
  // 写入 dsh 的 api 字段必须与网关服务路径一致：
  //   anthropic-messages → dsh 调 /v1/messages（网关 T5 转发 /messages + x-api-key）
  //   openai-completions → dsh 调 /v1/chat/completions（Bearer）
  // R12：baseURL 惯例按协议——anthropic-messages 的 SDK 期望 baseURL 不含 /v1
  // （SDK 自拼 /v1/messages；否则会出现 /v1/v1/messages 双前缀 404）。
  const clientProfile = String(cfg.clientProfile || '').trim();
  const wireApi = clientProfile === 'claude' ? 'anthropic-messages' : 'openai-completions';
  const baseURL = wireApi === 'anthropic-messages'
    ? `http://127.0.0.1:${port}`
    : `http://127.0.0.1:${port}/v1`;
  console.log(`[write-dsh] clientProfile="${clientProfile}" → api=${wireApi} baseURL=${baseURL}`);

  // merge models across enabled providers, dedup, keep order
  // 模型映射（2026-09-11）：写进 dsh 的必须是**逻辑模型名**（dsh 请求用它，网关按它路由并改写为
  // 各供应商的上游真实 ID）；配置里 `{id, as}` 时取 as，字符串则取本身。
  const modelMap = new Map();
  for (const p of cfg.providers || []) {
    if (p.enabled === false) continue;
    for (const as of logicalModelNames(p)) if (!modelMap.has(as)) modelMap.set(as, as);
  }
  const models = [...modelMap.values()].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' }));
  if (models.length === 0) {
    console.error('[write-dsh] no models in gateway config providers');
    process.exit(1);
  }

  // YAML 安全转义：模型 ID / key 可能含特殊字符（#、冒号、引号等），
  // 统一用单引号包裹并把内部单引号加倍（YAML 单引号语法），防注入/破坏配置。
  //
  // 第四轮审计修复：**换行必须压掉**。单引号标量里不允许裸换行，而值可能来自 JSON 转义
  // （key 或模型名含 \n）——直接写会得到一个跨行标量，续行落在第 0 列（远小于节点缩进），
  // 结果是 YAML 报错或被折叠成别的值。凭据文件被写坏影响面尤其大（dsh 解析不出任何 key）。
  // 换行在 key/模型名里没有任何合法用途，压成空格即可（与 settings.html 的请求头处理一致）。
  const yamlQuote = (s) => `'${String(s).replace(/[\r\n]+/g, ' ').replace(/'/g, "''")}'`;
  const apiKeyYaml = yamlQuote(apiKey);

  // R12：模型条目统一声明 reasoningEfforts（否则 pi-ai 回退已安装目录能力——
  // glm-5.3 等无 max 档会报 "does not support reasoning effort max"）。
  // off=null（不发字段）、其余档位 wire 值同档名；声明后选择器提供全部档位。
  // 2026-09-16 实测修复（air-outer / agentrouter 的 thinking 回传 400）：
  // 上游对"带 tool_use 的 assistant 轮"要求必须回传 thinking 块。pi-ai 在 thinking **无签名**
  // 时（上游不回 signature_delta，或流被中断）默认把该块降级成普通 text，于是下一轮请求里
  // 只剩 text+tool_use → 上游 400「content[].thinking ... must be passed back」。
  // compat.allowEmptySignature: true 让 pi-ai 保留为 thinking 块（签名为空），实测上游接受。
  // 该字段由 dsh-llm-pi-ai 的 COMPAT_GATES["anthropic-messages"] 门控为 "offer"（本版本支持）。
  const compatLines = wireApi === 'anthropic-messages'
    ? `\n          compat:\n            allowEmptySignature: true`
    : '';
  // 2026-09-16 用户反馈修复（图片输入被拦）：harness 按模型条目的 input 判断能否收图，
  // 未声明即按纯文本处理 → 附件入口直接提示"当前模型不支持图片，请切换支持图片的模型"。
  // 这里对**任一启用供应商声明了图片能力（vision: true / input: ['text','image']）**的逻辑模型
  // 写出 input: [text, image]；其余不写（保持纯文本，避免"声称能收图但上游不支持"）。
  const inputLines = (m) => (logicalModelSupportsVision(cfg, m)
    ? `\n          input:\n            - text\n            - image`
    : '');
  // 2026-09-16：模型条目可显式声明 contextWindow / maxTokens —— 各家上游实际窗口差异很大
  //（WorkBuddy 实测：hy3 192K、minimax-m3 512K、glm-5.3 1M…）。对全部模型统一写 1M 属于**虚报**，
  // 会让 dsh 以为还能塞很多 → 长对话在上游直接报上下文超限。取该逻辑模型在所有启用供应商里的
  // **最小值**（保守：任一家装不下就按装不下的算），没声明才退回默认。
  const modelLimits = (() => {
    const ctx = new Map();
    const out = new Map();
    for (const p of cfg.providers || []) {
      if (!p || p.enabled === false) continue;
      for (const e of modelEntries(p)) {
        const c = Number(e.contextWindow) > 0 ? Number(e.contextWindow) : 0;
        const o = Number(e.maxTokens) > 0 ? Number(e.maxTokens) : 0;
        if (c) ctx.set(e.as, ctx.has(e.as) ? Math.min(ctx.get(e.as), c) : c);
        if (o) out.set(e.as, out.has(e.as) ? Math.min(out.get(e.as), o) : o);
      }
    }
    return { ctx, out };
  })();
  const modelLines = models
    .map((m) => {
      const ctxWin = modelLimits.ctx.get(m) || 1024000;
      const maxTok = modelLimits.out.get(m);
      return `        - id: ${yamlQuote(m)}\n          name: ${yamlQuote(m)}\n          contextWindow: ${ctxWin}`
        + (maxTok ? `\n          maxTokens: ${maxTok}` : '')
        + `\n          reasoningEfforts:\n            off: null\n            low: low\n            medium: medium\n            high: high\n            max: max${inputLines(m)}${compatLines}`;
    })
    .join('\n');
  const block =
`    gateway:
      displayName: DSH Model Gateway
      apiKeyEnv: DSH_GATEWAY_API_KEY
      api: ${wireApi}
      baseURL: ${baseURL}
      models:
${modelLines}`;

  // settings.yaml: insert/replace the gateway provider under llm-pi-ai.providers
  // 审计修复（P1-7）：旧实现用两条**全局**正则（`/\n    gateway:…/s` 与 `/\n  providers:…/s`）
  // 定位——文件里任何位置出现 4 空格缩进的 `gateway:`（例如某个 MCP server 就叫 gateway）
  // 都会被整段替换掉；`providers:` 后面跟同级键时还会把网关块插进那个键内部（层级错误，
  // dsh 看不到）。现在改为**逐行、按层级定位**：先找顶层 `llm-pi-ai:` 块，再在其内找
  // `  providers:`，再在其内找 `    gateway:`。写前留一份首次备份。
  let settings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
  const before = settings;
  settings = upsertGatewayInSettings(settings, block);
  if (settings === before) console.log('[write-dsh] settings.yaml: no change needed');
  else {
    // 第四轮审计修复：原子写 + 建目录（见 writeFileAtomicDsh 注释）
    writeFileAtomicDsh(settingsPath, settings, '.bak-gateway');
    console.log('[write-dsh] settings.yaml: llm-pi-ai.providers.gateway upserted');
  }

  // profile patch：**当前官方版本真正生效的载体**。settings.yaml 已被官方标记为 removed
  // （启动时导入一次就改名），只写它的话用户会遇到"报成功但 dsh 里看不到"。
  // 两个都写：老版本认 settings.yaml，新版本认 patch，互相兜底。
  // ⚠ 只在 profile 目录**真实存在**时才写 —— 否则会凭空造出一个 dsh 根本不加载的 profile 目录。
  //
  // ⚠⚠ `--settings` 一旦显式给出，**它所在目录就是本次操作的 dsh home**，profile 必须从这里派生，
  // 不能再回退去读 `DSH_PROFILES_DIR` / `DSH_PROFILE` / `DSH_PROFILE_DIR` 环境变量。
  // 实测事故（2026-10-07）：单元测试把 `--settings` 指向临时目录，但开发机 shell 里带着
  // `DSH_PROFILE_DIR=C:\Users\<user>\.dsh\profiles\desktop` —— 于是测试**往用户的真实 DSH
  // profile 里写了夹具模型**。调用方既然指明了 home，环境变量就必须让位。
  const explicitSettings = get('--settings') || process.env.DSH_SETTINGS || '';
  const homeDir = explicitSettings ? path.dirname(explicitSettings) : dshHome;
  const envProfilesRoot = explicitSettings ? '' : (process.env.DSH_PROFILES_DIR || '');
  const envProfileName = explicitSettings ? '' : (process.env.DSH_PROFILE || '');
  // DSH_PROFILE_DIR 给的是绝对目录，只在"没显式指定 home"时才认（同上）
  const envProfileDir = explicitSettings ? '' : String(process.env.DSH_PROFILE_DIR || '').trim();
  const profilesRoot = get('--profiles-dir') || envProfilesRoot || path.join(homeDir, 'profiles');
  const profileName = get('--profile') || envProfileName || 'desktop';
  const patchPath = get('--patch') || (envProfileDir
    ? path.join(envProfileDir, 'cordis.patch.yml')
    : path.join(profilesRoot, profileName, 'cordis.patch.yml'));
  const profileDir = path.dirname(patchPath);
  if (fs.existsSync(profileDir)) {
    let patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
    const patchBefore = patch;
    try {
      // patch 比 settings.yaml 多一层（`- id:` 数组项 → config → providers），整体 +2 缩进
      patch = upsertGatewayInPatch(patch, reindentBlock(block, 2));
    } catch (e) {
      // 改不了就**如实说**，绝不静默跳过 —— 否则用户以为网关已经注册好了。
      // settings.yaml 那边已经写成功（老版本仍可用），所以这里不整体失败。
      console.error(`[write-dsh] ⚠ profile patch 未写入：${e && e.message ? e.message : e}`);
      console.error(`[write-dsh]   文件：${patchPath}`);
      console.error('[write-dsh]   settings.yaml 已写入；新版 dsh 还需你手工把 gateway 加进 profile patch。');
      patch = patchBefore;
    }
    if (patch !== patchBefore) {
      writeFileAtomicDsh(patchPath, patch, '.bak-gateway');
      console.log(`[write-dsh] profile patch (${profileName}): llm-pi-ai.config.providers.gateway upserted → ${patchPath}`);
    } else {
      console.log(`[write-dsh] profile patch (${profileName}): no change needed`);
    }
  } else {
    console.log(`[write-dsh] profile patch skipped: ${profileDir} 不存在（只写了 settings.yaml）`);
  }

  // credentials.yaml: upsert DSH_GATEWAY_API_KEY under refs（key 使用 YAML 转义）
  let creds = fs.existsSync(credsPath) ? fs.readFileSync(credsPath, 'utf8') : '';
  const keyRe = new RegExp('^  DSH_GATEWAY_API_KEY:.*$', 'm');
  if (keyRe.test(creds)) {
    creds = creds.replace(keyRe, `  DSH_GATEWAY_API_KEY: ${apiKeyYaml}`);
  } else {
    if (/^refs:\s*$/m.test(creds)) {
      creds = creds.replace(/^refs:\s*$/m, `refs:\n  DSH_GATEWAY_API_KEY: ${apiKeyYaml}`);
    } else if (creds.trim().length > 0) {
      creds = creds.trimEnd() + `\nrefs:\n  DSH_GATEWAY_API_KEY: ${apiKeyYaml}\n`;
    } else {
      creds = `version: 1\nrefs:\n  DSH_GATEWAY_API_KEY: ${apiKeyYaml}\n`;
    }
  }
  // 第四轮审计修复：原子写 + 建目录 + 首次备份（credentials 此前**完全没有备份**，
  // 而它装着用户全部供应商密钥）
  writeFileAtomicDsh(credsPath, creds, '.bak-gateway');
  console.log(`[write-dsh] credentials.yaml: DSH_GATEWAY_API_KEY set`);
  console.log(`[write-dsh] OK — gateway registered at ${baseURL} with ${models.length} models`);
}

/* ---------------- main ---------------- */
// 进程级兜底：任何未捕获的异步/同步异常都记录日志而非崩溃（H3）
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err.stack || err.message}`);
});
// 有条件退出前再落一次日志
process.on('exit', (code) => {
  try { fs.appendFileSync(LOG_PATH, `[${localStamp()}] exit code=${code}\n`); } catch { }
});

if (process.argv.includes('--write-dsh')) {
  // 第四轮审计修复（严重）：失败必须**以非零退出码结束**。
  // 旧实现里 writeDshConfig 的裸抛（配置被手改坏/BOM → JSON.parse 抛；写文件 ENOENT/EACCES/
  // 被编辑器独占 → writeFileSync 抛）会冒泡到上面那个只记日志、既不 exit 也不设 exitCode 的
  // uncaughtException 处理器 → 进程"正常"收尾、**退出码 0、stdout 为空**。
  // 而调用方正是按退出码判定成败（gateway-manager.js: `if (code === 0)`）→ UI 弹
  // "已写入 dsh 配置"，实际一个字节都没写。这里捕获取代兜底，明确返回 2。
  try {
    writeDshConfig(process.argv.slice(2));
  } catch (err) {
    const msg = err && err.stack ? err.stack : String(err);
    log(`[write-dsh] 失败：${msg}`);
    console.error(`[write-dsh] FAILED: ${err && err.message ? err.message : err}`);
    process.exit(2);
  }
} else {
  // 服务启动：--config / --log 可覆盖默认的 %APPDATA%\DSHDesktop 路径，
  // 使 dsh-app/桌面助手能把配置与日志指向自己的数据目录（否则误读/写旧位置）
  const cfgFromArg = argvGet('--config');
  if (cfgFromArg) CONFIG_PATH = cfgFromArg;
  const logFromArg = argvGet('--log');
  if (logFromArg) LOG_PATH = logFromArg;
  const cfg = loadConfig();
  if (cfg) startServer(cfg);
}

// 来源：dsh-desktop-github/gateway/model-gateway.mjs（DSH 桌面助手模型网关，随本应用原样分发）
