// src/model-meta.js — 模型元数据：名称自动映射 + 参数补全
//
// 用途：给「一键获取全部模型」提供"上游没告诉我们的那些参数"。
//
// **设计原则：不编数字。**
// 上游 `/models` 只回 `{id, object, created, owned_by}` 时（new-api/one-api 中转的常见形态），
// 我们**不知道**上下文长度、最大输出、图片能力。此时正确的做法是**留空**，让用户自己决定 ——
// 而不是填一个看起来合理的值。这条原则有前车之鉴：早先 dsh 写入因为拿不到 contextWindow
// 而退回默认的 1024000，等于**向上游虚报 5 倍上下文**，客户端会真的按 100 万发包。
//
// 数据来源与优先级：
//   ① 上游 `/models` 自己带的字段（OpenRouter 系会带 context_length / architecture…）
//   ② 本文件的 KNOWN 表（按归一化名字匹配；这些值是实际见过的，不是估的）
//   ③ 留空
'use strict';

/**
 * 数值字段的上界。不是"业务上够不够用"的问题，而是**下溢成 1ms / 溢出成 Infinity** 的安全阀：
 *  · `setTimeout` 延时上限是 2^31-1（2147483647），超出的值会被 Node 改成 **1ms** 并打
 *    `TimeoutOverflowWarning`。实测上游给 `timeout_ms: 1e308` 时，该模型每个请求都在 ~1ms 被 abort，
 *    而 AbortError 明确不重试 → 反复失败最终把整家供应商熔断。
 *  · 上下文/输出长度没有运行时溢出问题，但虚报会让客户端真的按那个数字发包（见文件头的前车之鉴）。
 */
const MAX_CONTEXT_WINDOW = 10 * 1000 * 1000;   // 1000 万 token，远超任何真实模型
const MAX_MAX_TOKENS = 1000 * 1000;            // 单次最大输出 100 万
const MAX_MODEL_TIMEOUT_MS = 600 * 1000;       // 逐模型超时 10 分钟（全局默认才 60 秒）

/* ------------------------------------------------------------------ *
 * 名称归一化与自动映射
 * ------------------------------------------------------------------ */

/** 拿掉厂商前缀与 `:free` 之类后缀，用于"这是不是同一个模型"的比较。 */
function normalizeModelName(id) {
  let s = String(id == null ? '' : id).trim().toLowerCase();
  s = s.replace(/^[a-z0-9._-]+\//, '');        // 去掉 `vendor/`
  s = s.replace(/:(free|beta|preview|latest|extended|nitro|online)$/i, '');
  s = s.replace(/-20\d{6}$/, '');              // 去掉 `-20250514` 这类日期后缀
  return s.trim();
}

/**
 * 自动把上游 ID 映射成"客户端用的短名"。
 *
 * 规则：去掉厂商前缀，**保留** `:free` 这类有语义的后缀 —— 它决定了走免费池还是付费。
 *
 *   deepseek-ai/deepseek-v4.1-flash          → deepseek-v4.1-flash
 *   z-ai/glm-5.3-flash                       → glm-5.3-flash
 *   google/gemma-4-26b-a4b-it:free           → gemma-4-26b-a4b-it:free
 *   Qwen3.8-Flash-Next                       → Qwen3.8-Flash-Next（没有前缀，原样）
 *
 * 为什么敢去掉前缀：映射是**逐供应商**的，短名只要在不同供应商之间不冲突就行；
 * 而"同一逻辑名的多条映射"恰恰是网关做 failover 的依据（同一个模型多家提供时自动轮换），
 * 所以去前缀是**想要的行为**，不是副作用。
 */
function autoMapName(upstreamId) {
  const s = String(upstreamId == null ? '' : upstreamId).trim();
  if (!s) return '';
  const i = s.indexOf('/');
  if (i <= 0 || i === s.length - 1) return s;
  const tail = s.slice(i + 1);
  if (!tail) return s;
  // ⚠ 结果要**真的像一个模型名**才采用。
  // 上游目录里混进畸形 ID 时，朴素的"取第一个斜杠之后的部分"会产出垃圾，
  // 而这些垃圾会**真的写进客户端配置**当逻辑名：
  //   'a//b'              → '/b'          （前导斜杠）
  //   '../../etc/passwd'  → '../etc/passwd'
  //   '.../...'           → '...'
  //   'vendor/'           → 已被上面的 i===len-1 挡住
  // 不合格就退回原始 id —— 宁可名字长一点，也不要写个看不懂的东西进去。
  if (/[/\\]/.test(tail)) return s;          // 还含路径分隔符
  if (/^\.+$/.test(tail)) return s;          // 纯点号
  if (/^\W/.test(tail)) return s;            // 以非单词字符开头
  return tail;
}

/* ------------------------------------------------------------------ *
 * 已知模型元数据
 *
 * ⚠ 这些值是**实际见过的**（来自既有配置与公开目录），不是估算。
 *   上游 `/models` 给出的值永远优先于本表。
 *   `timeoutMs` **刻意全部不填** —— 超时取决于本机到上游的网络，只能实测，
 *   猜一个数字会让用户以为配好了。一键获取里可以勾选"顺便测速"来实测。
 * ------------------------------------------------------------------ */

/** key = normalizeModelName() 的结果 */
const KNOWN = {
  // —— DeepSeek 系 ——
  'deepseek-v4-flash': { contextWindow: 131072, maxTokens: 65536 },
  'deepseek-v4-pro': { contextWindow: 1000000, maxTokens: 128000, vision: true },
  'deepseek-v4.1-flash': { contextWindow: 1048576, maxTokens: 384000, vision: true },

  // —— 智谱 GLM ——
  'glm-5.2': { contextWindow: 1000000, maxTokens: 64000, vision: true },
  'glm-5.3': { contextWindow: 200000, maxTokens: 64000 },
  'glm-5.3-flash': { contextWindow: 200000, maxTokens: 64000, vision: true },

  // —— 月之暗面 / 阶跃 / 百川 ——
  'kimi-k3': { contextWindow: 262144, maxTokens: 65536, vision: true },
  'hy3': { contextWindow: 192000, maxTokens: 64000, vision: true },
  'hy4-preview': { contextWindow: 1000000, maxTokens: 64000, vision: true },

  // —— 阿里 Qwen ——
  'qwen3.8-flash-next': { contextWindow: 262144, maxTokens: 65536 },
  'qwen3.8-flash': { contextWindow: 262144, maxTokens: 65536 },

  // —— 商汤 ——
  'sensenova-6.8-flash-lite': { contextWindow: 131072, maxTokens: 32768, vision: true },

  // —— Google Gemma ——
  'gemma-4-26b-a4b-it': { contextWindow: 262144, maxTokens: 32768, vision: true },
  'gemma-4-31b-it': { contextWindow: 262144, maxTokens: 32768, vision: true },

  // —— NVIDIA Nemotron ——
  'nemotron-3-ultra-550b-a55b': { contextWindow: 1000000, maxTokens: 65536 },
  'nemotron-3.5-lightning': { contextWindow: 1000000, maxTokens: 65536 },

  // —— Nex AGI ——
  'nex-n2.5-pro': { contextWindow: 262144, maxTokens: 235929, vision: true },
  'nex-n2.5-mini': { contextWindow: 262144, maxTokens: 235929, vision: true },

  // —— Poolside / Dots / Stealth ——
  'laguna-s-2.1': { contextWindow: 262144, maxTokens: 32768 },
  'dots-3-note-preview': { contextWindow: 512000, maxTokens: 460800, vision: true },
  'union-alpha': { contextWindow: 200000, maxTokens: 65536 },

  // —— xAI Grok ——
  'grok-4.6': { contextWindow: 256000, maxTokens: 64000, vision: true },

  // —— 小米 MiMo ——
  'mimo-v2.6-flash': { contextWindow: 262144, maxTokens: 32768 },
  'mimo-v2.5': { contextWindow: 262144, maxTokens: 32768 },

  // —— Anthropic Claude ——
  'claude-opus-5': { contextWindow: 200000, maxTokens: 64000, vision: true },
  'claude-opus-4-8': { contextWindow: 200000, maxTokens: 32000, vision: true },
  'claude-sonnet-4-5': { contextWindow: 200000, maxTokens: 64000, vision: true },
  'claude-haiku-4-5': { contextWindow: 200000, maxTokens: 32000, vision: true },

  // —— OpenAI ——
  'gpt-5': { contextWindow: 400000, maxTokens: 128000, vision: true },
  'gpt-5-mini': { contextWindow: 400000, maxTokens: 128000, vision: true },
  'gpt-4o': { contextWindow: 128000, maxTokens: 16384, vision: true },
  'gpt-4o-mini': { contextWindow: 128000, maxTokens: 16384, vision: true },
};

/** 查表（归一化后精确匹配；再退一步做"去后缀"匹配）。 */
function lookupKnown(upstreamId) {
  const n = normalizeModelName(upstreamId);
  if (!n) return null;
  if (KNOWN[n]) return Object.assign({ matchedBy: 'exact' }, KNOWN[n]);
  // 退一步：`xxx-20250514` / `xxx-latest` 这类，normalize 已经去过一次；
  // 再试试"前缀命中"（例如表里是 nex-n2.5-pro，而来的是 nex-n2.5-pro-thinking）
  for (const k of Object.keys(KNOWN)) {
    if (n.startsWith(k + '-') || n.startsWith(k + '.')) return Object.assign({ matchedBy: 'prefix:' + k }, KNOWN[k]);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 上游 /models 条目的解析
 * ------------------------------------------------------------------ */

/** 从各种中转的 /models 条目里尽力挖出可用参数。挖不到就返回空对象。 */
function parseUpstreamMeta(entry) {
  const out = {};
  if (!entry || typeof entry !== 'object') return out;

  /**
   * 数值字段的统一收敛。三条都不可少：
   *  ① **类型严格**：只接受 number 或十进制数字字符串。
   *     旧写法 `Number.isFinite(Number(v))` 会把 `true→1`、`[5]→5`、`'0x10'→16` 全都当真 ——
   *     上游返回畸形数据时就会写出一个谁也不认识的值。
   *  ② **上界**：`setTimeout` 的延时上限是 2^31-1，超出会被 Node 悄悄改成 1ms
   *     （`TimeoutOverflowWarning: … does not fit into a 32-bit signed integer`）。
   *     实测 `timeout_ms: 1e308` 一路穿到引擎，该模型每个请求都在 ~1ms 被 abort，
   *     AbortError 又不重试 → 反复失败最终把整家供应商熔断。
   *  ③ 必须是正数。
   */
  const pickNum = (v, max) => {
    let n;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
    else return 0;
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), max);
  };
  const pos = (v) => pickNum(v, MAX_CONTEXT_WINDOW);

  // OpenRouter 形态：context_length / top_provider.max_completion_tokens / architecture.input_modalities
  let ctx = pos(entry.context_length ?? entry.contextLength ?? entry.context_window ?? entry.contextWindow);
  let maxTok = pickNum(entry.max_completion_tokens ?? entry.max_output_tokens ?? entry.maxOutputTokens, MAX_MAX_TOKENS);
  if (entry.top_provider && typeof entry.top_provider === 'object') {
    maxTok = maxTok || pickNum(entry.top_provider.max_completion_tokens, MAX_MAX_TOKENS);
  }
  if (entry.top_provider && pos(entry.top_provider.context_length)) {
    ctx = ctx || pos(entry.top_provider.context_length);
  }
  // 有些中转把参数塞在 `metadata` / `config` 里
  for (const k of ['metadata', 'config', 'limits']) {
    const o = entry[k];
    if (!o || typeof o !== 'object') continue;
    ctx = ctx || pos(o.context_length ?? o.context_window ?? o.max_context_length ?? o.contextLength);
    maxTok = maxTok || pickNum(o.max_output_tokens ?? o.max_completion_tokens ?? o.maxTokens, MAX_MAX_TOKENS);
  }
  if (ctx) out.contextWindow = ctx;
  if (maxTok) out.maxTokens = maxTok;

  // 图片能力：OpenRouter 的 architecture.input_modalities、或直接的 vision/modalities 标记
  let vision = false;
  const mods = (entry.architecture && Array.isArray(entry.architecture.input_modalities))
    ? entry.architecture.input_modalities
    : (Array.isArray(entry.input_modalities) ? entry.input_modalities : null);
  if (mods) vision = mods.map((x) => String(x).toLowerCase()).includes('image');
  if (!vision && entry.vision === true) vision = true;
  if (!vision && Array.isArray(entry.modalities)) {
    vision = entry.modalities.map((x) => String(x).toLowerCase()).includes('image');
  }
  if (!vision && Array.isArray(entry.input) && entry.input.map((x) => String(x).toLowerCase()).includes('image')) vision = true;
  if (vision) out.vision = true;

  // 少数中转会直接给建议超时；有就用，没有不猜。上界同样必要（见 pickNum 的 ②）。
  const t = pickNum(entry.timeoutMs ?? entry.timeout_ms, MAX_MODEL_TIMEOUT_MS);
  if (t >= 1000) out.timeoutMs = t;

  return out;
}

/**
 * 把一个上游模型条目补全成可写进配置的模型条目。
 *
 * @param {string|object} raw            上游 /models 里的一项（字符串 id 或对象）
 * @param {object} [opts]
 * @param {boolean} [opts.keepVendor=true] 是否保留厂商前缀（默认不保留）
 * @returns {{id:string, as:string, vision?:boolean, contextWindow?:number, maxTokens?:number, timeoutMs?:number, _src:object}}
 */
function enrichModel(raw, opts) {
  const o = opts || {};
  const upstreamId = typeof raw === 'string' ? raw.trim() : String(raw && (raw.id ?? raw.model ?? raw.name) || '').trim();
  if (!upstreamId) return null;

  const fromUpstream = parseUpstreamMeta(raw);
  const known = lookupKnown(upstreamId) || {};

  const entry = { id: upstreamId, as: o.keepVendor ? upstreamId : autoMapName(upstreamId) };
  if (entry.as === entry.id) delete entry.as;

  // 优先级：上游明说 > 已知表。两边都没有 → 留空（不编数字）
  const vision = fromUpstream.vision === true ? true : (known.vision === true ? true : undefined);
  const ctx = fromUpstream.contextWindow || known.contextWindow;
  const maxTok = fromUpstream.maxTokens || known.maxTokens;
  const tmo = fromUpstream.timeoutMs || known.timeoutMs;

  if (vision) entry.vision = true;
  if (ctx) entry.contextWindow = ctx;
  if (maxTok) entry.maxTokens = maxTok;
  if (tmo) entry.timeoutMs = tmo;

  // 给界面用：这个条目的参数是从哪来的（便于用户判断可信度）
  // `matchedBy` 是 'exact' 或 'prefix:xxx' —— 只有后者才该说"推测"：
  // 前缀命中意味着"同族参数通常一致"，属于**推断**而非实测，用户有权知道这个区别。
  const approx = typeof known.matchedBy === 'string' && known.matchedBy.startsWith('prefix:');
  const knownLabel = approx ? '已知表·按同族推测' : '已知表';
  const src = {};
  if (fromUpstream.contextWindow) src.contextWindow = '上游';
  else if (known.contextWindow) src.contextWindow = knownLabel;
  if (fromUpstream.maxTokens) src.maxTokens = '上游';
  else if (known.maxTokens) src.maxTokens = knownLabel;
  if (fromUpstream.vision) src.vision = '上游';
  else if (known.vision) src.vision = knownLabel;
  if (!ctx && !maxTok && !vision) src.note = '上游未提供参数，且不在已知表里 —— 留空由你决定';

  // ⚠ 必须是**可枚举**的普通属性。
  // 旧实现用 `defineProperty(..., {enumerable:false})`，而 Electron 的 IPC 走结构化克隆 ——
  // 不可枚举属性**过不去**。结果"参数来源"这一列在生产里恒为空，
  // 用户永远看不到哪些数字是上游给的、哪些是按同族推测的。
  //（测试没抓到是因为 tests/renderer.test.js 在同一进程里直调 enrichAll，从不跨 IPC。）
  // 记得在 handler 里剔除它再落盘（见 main.js 的 gw:fetch-models）。
  entry._src = src;
  if (known.matchedBy) entry._matchedBy = known.matchedBy;
  return entry;
}

/**
 * 批量补全。返回 { models, unknown }：
 *   models  —— 可直接写进配置的数组
 *   unknown —— 完全没拿到参数的上游 ID（界面要提示用户"这些得你自己填"）
 */
function enrichAll(list, opts) {
  const models = [];
  const unknown = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const e = enrichModel(raw, opts);
    if (!e) continue;
    if (seen.has(e.id)) continue;       // 上游目录里偶有重复
    seen.add(e.id);
    if (e._src && e._src.note) unknown.push(e.id);
    models.push(e);
  }
  return { models, unknown };
}

module.exports = {
  normalizeModelName,
  autoMapName,
  parseUpstreamMeta,
  enrichModel,
  enrichAll,
  lookupKnown,
  KNOWN,
};
