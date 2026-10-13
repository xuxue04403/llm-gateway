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

  const keep = (r) => (!f.model || r.model === f.model)
    && (!f.provider || r.provider === f.provider)
    && (!f.endpoint || r.endpoint === f.endpoint)
    && (!f.status || r.status === f.status);

  return {
    days,
    detailLimit,
    add(r) {
      if (!r || typeof r.ts !== 'number') return;
      totalRows++;
      if (r.model) seenModels.add(r.model);
      if (r.provider) seenProviders.add(r.provider);
      if (r.endpoint) seenEndpoints.add(r.endpoint);
      if (r.status) seenStatuses.add(r.status);
      if (!keep(r)) return;
      rowCount++;
      addTo(totals, r);
      const dims = [
        [byDay, dayKey(r.ts)],
        [byModel, r.model || '(未知)'],
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
        model: r.model,
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
