// usage.js —— 使用记录聚合（阶段 2）
//
// 数据源：引擎写的 `<logs>/usage/YYYY-MM-DD.jsonl`（见 model-gateway.mjs 的 recordUsage）。
// 每行一条调用记录，字段：
//   ts, model, provider, endpoint, status, stream, durMs, ttfbMs,
//   inTok, outTok, cacheRead, cacheWrite
//
// ⚠ `inTok` 已被引擎**归一化为"非缓存输入"**（Anthropic 语义）——
// 所以「总输入 = inTok + cacheRead + cacheWrite」在两种协议下都成立，
// 这里**不要**再去做协议判断（那是引擎的职责，做两遍必然漂移）。
//
// ── 模型名归并（2026-10-16）────────────────────────────────────────────────
//
// 2026-10-16 之前引擎记账写的是**上游 ID**，于是同一个逻辑模型在使用记录里被拆成好几行：
//   commandcode 的 `deepseek/deepseek-v4.1-flash`、amd 的 `DeepSeek-V4.1-Flash`、
//   x666 的 `deepseek-v4.1-flash` —— 三家的 up 各不相同，但 `as` 都是 `deepseek-v4.1-flash`。
//   实测 10-15 的 2365 条记录被拆成 605 / 149 / 113 三行，看着像三个模型。
//
// 引擎侧已改成"落盘即归一"（新记录直接是逻辑名）。**但已经写进 jsonl 的历史记录改不了** ——
// 所以这里还要再兜一层：按记录里的 provider 字段查"上游 ID → 逻辑名"映射表，把旧记录也归并掉。
//
// ⚠ 归并表由**调用方传入**（`opts.modelAlias`，纯数据 `{ byProvider: Map, lower: Map }`），
//   而不是本模块去 require 配置模块 —— 本文件刻意保持"只用 node: 内置模块"。
//   表的构建见 src/writers/models.js 的 buildUpstreamAliasMap()。
//
// ⚠ 归并**宁可不动也不能猜**：查不到的一律原样保留（用户改过配置/删过供应商/本来就没声明过的
//   模型）。猜错会把两个不相干的模型合成一行，比拆开更误导人。
//
// ── 同步 / 异步两条入口（2026-10-13 审计后补）──────────────────────────────
//
// **为什么要有异步版**：`summarize()` 是纯同步的，而它被 main.js 的 IPC 直接调用 ——
// 主进程单线程，实测 15 万行 265ms、**150 万行 2624ms**，期间界面完全冻住。
// `summarizeAsync()` 把「读文件 + 逐行解析」切片执行并定期让出事件循环，
// 把一次长冻结变成若干短停顿。
//
// **两者共用同一个累加器 `makeAggregator()`** —— 这是刻意的：
// 聚合规则（过滤/分桶/明细/筛选项）只写一遍，两条读取路径不可能算出不同结果。
// 本项目已经吃过多次"同一逻辑多处实现 → 悄悄漂移"的亏（见引擎侧的审计记录）。
//
// ⚠ 聚合本身与**行的读取顺序无关**（求和、集合并集、明细按 ts 排序），
// 所以 sync/async 结果天然一致，回归测试对此有断言。
//
// 零依赖（只用 node:），与引擎同一风格。

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** 用量目录：与引擎的 usageDir() 保持一致（<logs>/usage） */
function usageDirOf(logsDir) {
  return path.join(logsDir, 'usage');
}

/** 本地日期字符串 YYYY-MM-DD（与引擎写文件时的口径一致） */
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 用量文件名 → 日期毫秒；不是用量文件则返回 null */
function dayOfUsageFile(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
  if (!m) return null;
  return { name, t: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() };
}

/**
 * 读最近 N 天的用量行（**同步**，返回全量数组）。
 *
 * ⚠ 这是给测试与外部脚本用的便利接口；`summarize()` 自己**不再**用它 ——
 * 聚合走"逐行喂累加器"的流式路径，不把全部行堆在内存里（见文件头说明）。
 */
function readUsage(logsDir, days) {
  const dir = usageDirOf(logsDir);
  const out = [];
  const files = listUsageFilesSync(dir);
  const cutoff = days > 0 ? Date.now() - days * 86400_000 : 0;
  for (const it of files) {
    if (it.t < cutoff) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, it.name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r.ts === 'number') out.push(r);
      } catch { /* 半截行（正在写）：跳过 */ }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** 列出用量文件并按日期升序（同步） */
function listUsageFilesSync(dir) {
  const files = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      const d = dayOfUsageFile(f);
      if (d) files.push(d);
    }
  } catch { return files; }               // 目录不存在 = 还没有数据
  files.sort((a, b) => a.t - b.t);
  return files;
}

/** 空桶（所有聚合维度共用的形状） */
function newBucket() {
  return { requests: 0, ok: 0, fail: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, durSum: 0, ttfbSum: 0, ttfbN: 0 };
}

function addTo(b, r) {
  b.requests++;
  if (r.status === 'ok') b.ok++; else b.fail++;
  b.inTok += r.inTok || 0;
  b.outTok += r.outTok || 0;
  b.cacheRead += r.cacheRead || 0;
  b.cacheWrite += r.cacheWrite || 0;
  b.durSum += r.durMs || 0;
  if (r.ttfbMs > 0) { b.ttfbSum += r.ttfbMs; b.ttfbN++; }
}

/** 桶 → 前端友好形状（把 sum 换算成均值，并算缓存命中率） */
function finish(b) {
  const totalIn = b.inTok + b.cacheRead + b.cacheWrite;
  return {
    requests: b.requests,
    ok: b.ok,
    fail: b.fail,
    inTok: b.inTok,
    outTok: b.outTok,
    cacheRead: b.cacheRead,
    cacheWrite: b.cacheWrite,
    totalIn,
    totalTok: totalIn + b.outTok,
    avgDurMs: b.requests ? Math.round(b.durSum / b.requests) : 0,
    avgTtfbMs: b.ttfbN ? Math.round(b.ttfbSum / b.ttfbN) : 0,
    // 缓存命中率 = 缓存读 / 总输入。0 输入时给 0（不给 NaN）
    cacheHitRate: totalIn > 0 ? b.cacheRead / totalIn : 0,
  };
}

/**
 * 聚合累加器 —— **sync 与 async 两条路径共用的唯一实现**。
 *
 * `add(row)` 逐行喂入；`result()` 出最终形状。
 * 与行的喂入顺序无关（求和、集合、明细按 ts 排序都是顺序无关的）。
 *
 * 内存：明细只保留"最大的 detailLimit 条 ts"（有界缓冲），
 * 不再像旧实现那样把**全部行**留在数组里只为最后 slice 一次 ——
 * 实测 150 万行时旧实现额外占 425MB，这是主要来源之一。
 */
function makeAggregator(opts) {
  const o = opts || {};
  const days = Number.isFinite(Number(o.days)) ? Number(o.days) : 30;
  const detailLimit = Math.min(5000, Math.max(1, Number(o.detailLimit) || 500));
  const f = o.filter || {};
  // 模型名归并表（可选）。形状：{ byProvider: Map<providerId, Map<up, logical>>, lower: Map<lower, logical> }
  const alias = o.modelAlias || null;

  /**
   * 把记录里的模型名归并到逻辑名（详见文件头「模型名归并」）。
   * 查不到就原样返回 —— 不猜。
   *
   * ⚠ 顺序很关键，**必须是幂等的**：新记录里已经是逻辑名，再跑一次不能把它改掉。
   *   反例（会出错的那种）：某家声明了 `{id:'A', as:'B'}` 与 `{id:'B', as:'C'}` 两条 ——
   *   若先查别名表，逻辑名 `B` 会被再次映射成 `C`，同一条记录越归越偏。
   *   所以①先判"是不是已经就是某个声明的逻辑名"，是就原样返回。
   */
  const logicalOf = (provider, name) => {
    const raw = String(name || '');
    if (!raw || !alias) return raw;
    // ① 已经是声明的逻辑名 → 原样返回（保证幂等）
    if (alias.logicalSet && alias.logicalSet.has(raw)) return raw;
    // ② 按 (provider, 上游 ID) 查别名表 —— 历史记录里那种"上游 ID"的解法
    const per = alias.byProvider && alias.byProvider.get(String(provider || ''));
    if (per && per.has(raw)) return per.get(raw);
    // ③ 上游大小写不同但逻辑名相同（实测 glm-5.3-flash / GLM-5.3-Flash）
    const low = alias.lower && alias.lower.get(raw.toLowerCase());
    if (low) return low;
    return raw;
  };

  const totals = newBucket();
  const byDay = new Map();
  const byModel = new Map();
  const byProvider = new Map();
  const byEndpoint = new Map();
  // 筛选项用**未过滤**的全量算（否则选了一个就看不到别的了）
  const seenModels = new Set();
  const seenProviders = new Set();
  const seenEndpoints = new Set();
  const seenStatuses = new Set();

  let totalRows = 0;   // 未过滤行数
  let rowCount = 0;    // 过滤后行数
  // 有界明细缓冲：超过 2×detailLimit 就排序截断，保证留下的永远是"最新的那批"
  const detailBuf = [];
  const COMPACT_AT = detailLimit * 2;

  const keep = (r, model) => (!f.model || model === f.model)
    && (!f.provider || r.provider === f.provider)
    && (!f.endpoint || r.endpoint === f.endpoint)
    && (!f.status || r.status === f.status);

  return {
    days,
    detailLimit,
    add(r) {
      if (!r || typeof r.ts !== 'number') return;
      // ⚠ 先归并再参与**任何**判断：分桶、筛选项、过滤器、明细全都用同一个逻辑名，
      //   否则会出现"下拉框里选不到、选了又筛不出"这类自相矛盾的表现。
      const model = logicalOf(r.provider, r.model);
      totalRows++;
      if (model) seenModels.add(model);
      if (r.provider) seenProviders.add(r.provider);
      if (r.endpoint) seenEndpoints.add(r.endpoint);
      if (r.status) seenStatuses.add(r.status);
      if (!keep(r, model)) return;
      rowCount++;
      addTo(totals, r);
      const dims = [
        [byDay, dayKey(r.ts)],
        [byModel, model || '(未知)'],
        [byProvider, r.provider || '(未知)'],
        [byEndpoint, r.endpoint || '(未知)'],
      ];
      for (const [map, key] of dims) {
        if (!map.has(key)) map.set(key, newBucket());
        addTo(map.get(key), r);
      }
      detailBuf.push(r);
      if (detailBuf.length >= COMPACT_AT) {
        detailBuf.sort((a, b) => a.ts - b.ts);
        detailBuf.splice(0, detailBuf.length - detailLimit);
      }
    },
    result() {
      const dump = (map, keyName) => [...map.entries()]
        .map(([k, b]) => Object.assign({ [keyName]: k }, finish(b)))
        .sort((a, b) => b.totalTok - a.totalTok || b.requests - a.requests);

      // 明细：**倒序**（最近的在最前）
      detailBuf.sort((a, b) => a.ts - b.ts);
      const detail = detailBuf.slice(-detailLimit).reverse().map((r) => ({
        ts: r.ts,
        day: dayKey(r.ts),
        time: new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false }),
        // 明细也显示**逻辑名**：否则用户在下拉框里选 `deepseek-v4.1-flash` 筛出来的明细
        // 却写着 `deepseek/deepseek-v4.1-flash`，看起来像筛错了。
        // 上游原名不丢 —— 放进 `upstream` 字段，需要时能看到"这条到底走的哪个上游 ID"。
        model: logicalOf(r.provider, r.model),
        upstream: r.model && logicalOf(r.provider, r.model) !== r.model ? r.model : undefined,
        provider: r.provider,
        endpoint: r.endpoint,
        status: r.status,
        stream: r.stream ? 1 : 0,
        durMs: r.durMs || 0,
        ttfbMs: r.ttfbMs || 0,
        inTok: r.inTok || 0,
        outTok: r.outTok || 0,
        cacheRead: r.cacheRead || 0,
        cacheWrite: r.cacheWrite || 0,
        totalTok: (r.inTok || 0) + (r.outTok || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0),
      }));

      return {
        days,
        generatedAt: Date.now(),
        totalRows,
        rows: rowCount,
        totals: finish(totals),
        byDay: dump(byDay, 'day').sort((a, b) => (a.day < b.day ? -1 : 1)),
        byModel: dump(byModel, 'model'),
        byProvider: dump(byProvider, 'provider'),
        byEndpoint: dump(byEndpoint, 'endpoint'),
        detail,
        detailLimit,
        options: {
          models: [...seenModels].sort(),
          providers: [...seenProviders].sort(),
          endpoints: [...seenEndpoints].sort(),
          statuses: [...seenStatuses].sort(),
        },
      };
    },
  };
}

/** 逐行解析一段 JSONL 文本并喂给累加器；返回已处理的最后位置（便于切片续读） */
function feedLines(text, agg) {
  let start = 0;
  const len = text.length;
  while (start < len) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? len : nl;
    if (end > start) {
      const line = text.slice(start, end);
      try {
        const r = JSON.parse(line);
        if (r && typeof r.ts === 'number') agg.add(r);
      } catch { /* 半截行（正在写）：跳过 */ }
    }
    start = end + 1;
  }
}

/**
 * 聚合（**同步**）。给测试与小数据量调用方用。
 * 大文件场景请用 `summarizeAsync()` —— 这个版本会阻塞调用线程。
 */
function summarize(logsDir, opts) {
  const agg = makeAggregator(opts);
  const dir = usageDirOf(logsDir);
  const files = listUsageFilesSync(dir);
  const cutoff = agg.days > 0 ? Date.now() - agg.days * 86400_000 : 0;
  for (const it of files) {
    if (it.t < cutoff) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, it.name), 'utf8'); } catch { continue; }
    feedLines(text, agg);
  }
  return agg.result();
}

/** 让出事件循环一次（把长任务切成短片，避免冻住界面） */
function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 聚合（**异步、切片**）—— main.js 的 IPC 用这个。
 *
 * 与 `summarize()` 共用同一个累加器，因此**结果完全一致**（回归测试有断言）。
 * 区别只在"怎么读"：读文件用异步 API，解析按行切片，每片之后让出事件循环。
 *
 * @param {number} sliceLines 每处理这么多行让出一次（默认 4000）
 */
async function summarizeAsync(logsDir, opts, sliceLines) {
  const agg = makeAggregator(opts);
  const dir = usageDirOf(logsDir);
  const step = Math.max(200, Number(sliceLines) || 4000);

  let names = [];
  try { names = await fsp.readdir(dir); } catch { return agg.result(); }   // 目录不存在 = 还没有数据
  const files = names.map(dayOfUsageFile).filter(Boolean).sort((a, b) => a.t - b.t);

  const cutoff = agg.days > 0 ? Date.now() - agg.days * 86400_000 : 0;
  for (const it of files) {
    if (it.t < cutoff) continue;
    let text = '';
    try { text = await fsp.readFile(path.join(dir, it.name), 'utf8'); } catch { continue; }

    // 逐行喂入，每 step 行让出一次事件循环。
    // ⚠ 这里不用 feedLines() 一次到底 —— 那等于没有切片，长文件照样冻住。
    let start = 0;
    let sinceYield = 0;
    const len = text.length;
    while (start < len) {
      const nl = text.indexOf('\n', start);
      const end = nl < 0 ? len : nl;
      if (end > start) {
        const line = text.slice(start, end);
        try {
          const r = JSON.parse(line);
          if (r && typeof r.ts === 'number') agg.add(r);
        } catch { /* 半截行（正在写）：跳过 */ }
      }
      start = end + 1;
      if (++sinceYield >= step) {
        sinceYield = 0;
        // eslint-disable-next-line no-await-in-loop
        await yieldToLoop();
      }
    }
    // 文件之间也停一下：单个文件很小但文件很多时，同样可能长时间不让出
    // eslint-disable-next-line no-await-in-loop
    await yieldToLoop();
  }
  return agg.result();
}

module.exports = { summarize, summarizeAsync, readUsage, makeAggregator, usageDirOf, dayKey };
