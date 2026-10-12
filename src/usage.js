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
// 零依赖（只用 node:），与引擎同一风格。

'use strict';

const fs = require('node:fs');
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

/**
 * 读最近 N 天的用量行。
 * 只读文件名在范围内的文件（不解析内容判断日期 —— 文件名就是日期，便宜且准）。
 */
function readUsage(logsDir, days) {
  const dir = usageDirOf(logsDir);
  const out = [];
  const files = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
      if (m) files.push({ f, day: f.slice(0, 10), t: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() });
    }
  } catch { return out; }                       // 目录不存在 = 还没有数据
  files.sort((a, b) => a.t - b.t);
  const cutoff = days > 0 ? Date.now() - days * 86400_000 : 0;
  for (const it of files) {
    if (it.t < cutoff) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, it.f), 'utf8'); } catch { continue; }
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
 * 聚合成使用记录页需要的全部形状。
 *
 * @param {string} logsDir 数据目录下的 logs
 * @param {object} opts {days=30, detailLimit=500, filter:{model,provider,status,endpoint}}
 */
function summarize(logsDir, opts) {
  const o = opts || {};
  const days = Number.isFinite(Number(o.days)) ? Number(o.days) : 30;
  const detailLimit = Math.min(5000, Math.max(1, Number(o.detailLimit) || 500));
  const all = readUsage(logsDir, days);

  const f = o.filter || {};
  const keep = (r) => (!f.model || r.model === f.model)
    && (!f.provider || r.provider === f.provider)
    && (!f.endpoint || r.endpoint === f.endpoint)
    && (!f.status || r.status === f.status);
  const rows = all.filter(keep);

  const totals = newBucket();
  const byDay = new Map();
  const byModel = new Map();
  const byProvider = new Map();
  const byEndpoint = new Map();
  for (const r of rows) {
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
  }

  const dump = (map, keyName) => [...map.entries()]
    .map(([k, b]) => Object.assign({ [keyName]: k }, finish(b)))
    .sort((a, b) => b.totalTok - a.totalTok || b.requests - a.requests);

  // 明细：**倒序**（最近的在最前），带上便于前端筛选的原始字段
  const detail = rows.slice(-detailLimit).reverse().map((r) => ({
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

  // 筛选项的可选值（用**未过滤**的全量算，否则选了一个就看不到别的了）
  const options = {
    models: [...new Set(all.map((r) => r.model).filter(Boolean))].sort(),
    providers: [...new Set(all.map((r) => r.provider).filter(Boolean))].sort(),
    endpoints: [...new Set(all.map((r) => r.endpoint).filter(Boolean))].sort(),
    statuses: [...new Set(all.map((r) => r.status).filter(Boolean))].sort(),
  };

  return {
    days,
    generatedAt: Date.now(),
    totalRows: all.length,
    rows: rows.length,
    totals: finish(totals),
    byDay: dump(byDay, 'day').sort((a, b) => (a.day < b.day ? -1 : 1)),
    byModel: dump(byModel, 'model'),
    byProvider: dump(byProvider, 'provider'),
    byEndpoint: dump(byEndpoint, 'endpoint'),
    detail,
    detailLimit,
    options,
  };
}

module.exports = { summarize, readUsage, usageDirOf, dayKey };
