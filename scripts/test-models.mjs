// test-models.mjs — 网关模型全量体检
//
// 目的：把"网关到底能不能用某个模型"从"用户遇到再说"变成**可以主动跑一遍**的事。
//
// 两阶段（第二阶段的诊断价值最高）：
//   阶段一：逐个逻辑模型，经**正常路由**发一次最小请求 —— 回答"这个模型能用吗"。
//   阶段二：对阶段一失败的模型，**逐个供应单独起一个只启用该家的网关**再试一次 ——
//           回答"到底是谁的问题"（同一逻辑模型常被多家提供，正常路由只会告诉你"全部失败"，
//           分不出是某一家挂了还是所有家都挂了）。
//
// 分类刻意做得细，因为不同的失败对应的处置完全不同：
//   超时         → 该家首字节太慢，给它配 timeoutMs 或换掉
//   HTTP 401/403 → 凭据无效或没有该模型权限
//   HTTP 402     → 余额/额度问题
//   HTTP 404/400 + "model not found" → 该家没有这个模型（配置里的映射写错了）
//   HTTP 429     → 限流（稍后重试或换账户）
//   HTTP 5xx     → 上游故障
//   空响应       → 上游返回 200 但没有内容（常见于 max_tokens 太小 + 该模型先思考）
//
// 用法：
//   node scripts/test-models.mjs                 # 两阶段全跑
//   node scripts/test-models.mjs --phase1        # 只跑阶段一（快）
//   node scripts/test-models.mjs --model glm-5.2 # 只测指定模型（可多次）
//   node scripts/test-models.mjs --concurrency 2 # 并发（默认 1，串行最温和）
//   node scripts/test-models.mjs --json out.json # 落一份机器可读结果
'use strict';

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'src', 'gateway', 'model-gateway.mjs');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);
const MODEL_FILTER = argv.reduce((acc, a, i) => (a === '--model' && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), []);
const CONCURRENCY = Math.max(1, Number(flag('--concurrency', '1')) || 1);
const TIMEOUT_MS = Number(flag('--timeout', '60000')) || 60000;
const JSON_OUT = flag('--json', '');
const PHASE1_ONLY = has('--phase1');
const VERBOSE = has('--verbose');

/** 从哪读配置：默认取上一次跑过的数据目录（绿目录/源码树），可用 --config 指定。 */
function findConfig() {
  const explicit = flag('--config', '');
  if (explicit) return explicit;
  const cands = [
    process.env.LLM_GATEWAY_CONFIG,
    path.join(ROOT, 'data', 'gateway.config.json'),
    path.join(ROOT, 'out', 'LLM-Gateway', 'data', 'gateway.config.json'),
    path.join(ROOT, '..', 'dsh-app', 'out', 'DSH-App', 'data', 'gateway.config.json'),
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) || '';
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 HTTP 客户端（Node 内置；engines 里也用同一套，保持行为一致）。 */
function postJson(port, urlPath, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': payload.length }, headers),
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 256 * 1024) text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
      res.on('error', (e) => resolve({ status: 0, error: String(e && e.message) }));
    });
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) { /* 忽略 */ } resolve({ status: 0, error: '客户端超时 ' + timeoutMs + 'ms' }); });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.message) }));
    req.end(payload);
  });
}

/** 起一个网关子进程（临时配置 + 临时日志），返回 { port, stop, logTail }。 */
async function startGateway(configObj) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lgw-modeltest-'));
  const cfgPath = path.join(dir, 'gateway.config.json');
  const logPath = path.join(dir, 'gateway.log');
  const port = await freePort();
  configObj.port = port;
  writeFileSync(cfgPath, JSON.stringify(configObj, null, 2), 'utf8');

  const child = spawn(process.execPath, [ENGINE, '--config', cfgPath, '--log', logPath, '--port', String(port)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '' }),
  });
  let log = '';
  const onData = (c) => { log += c.toString('utf8'); };
  if (child.stdout) child.stdout.on('data', onData);
  if (child.stderr) child.stderr.on('data', onData);

  // 等就绪：探 /health
  const deadline = Date.now() + 12000;
  let ready = false;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
      r.on('timeout', () => { r.destroy(); resolve(false); });
      r.on('error', () => resolve(false));
    });
    if (ok) { ready = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await sleep(300);
  }
  const stop = () => new Promise((resolve) => {
    try { child.kill(); } catch (_) { /* 忽略 */ }
    setTimeout(resolve, 300);
  });
  return { port, stop, ready, logPath, getLog: () => { try { return readFileSync(logPath, 'utf8'); } catch (_) { return log; } } };
}

/** 从网关日志里抽出"这次请求为什么失败"的关键行。 */
function explainLog(log) {
  const lines = String(log || '').split(/\r?\n/);
  const keep = lines.filter((l) => /\[route\]|try |skip .*breaker|breaker|abort|timeout|超时|fail|error|unavailable|upstream|HTTP \d|no providers|not offered|no-model|拒绝/.test(l));
  // 只保留最后一次请求相关的那一段（日志里可能有更早的探测）
  return keep.slice(-14).map((l) => l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 220));
}
function classify(res, model) {
  if (res.status === 0) {
    const e = String(res.error || '');
    if (/超时|timeout/i.test(e)) return { kind: 'timeout', detail: e };
    return { kind: 'network', detail: e };
  }
  const text = String(res.body || '');
  const low = text.toLowerCase();
  const errMsg = (() => {
    try {
      const j = JSON.parse(text);
      return String((j.error && (j.error.message || j.error.type)) || j.message || '').slice(0, 300);
    } catch (_) { return text.slice(0, 300); }
  })();

  if (res.status >= 200 && res.status < 300) {
    let j = null;
    try { j = JSON.parse(text); } catch (_) { /* 不是 JSON */ }
    if (!j) return { kind: 'bad-body', detail: 'HTTP 200 但不是 JSON：' + text.slice(0, 160) };
    // 有可能 200 + 体内带 error（部分中转的形态）
    if (j.error) return { kind: 'body-error', detail: errMsg };
    const hasContent = (() => {
      const ch = j.choices && j.choices[0];
      if (!ch) return false;
      const msg = ch.message || {};
      return !!(msg.content || msg.reasoning || msg.reasoning_content || (msg.tool_calls && msg.tool_calls.length));
    })();
    if (!hasContent) {
      const fr = (j.choices && j.choices[0] && j.choices[0].finish_reason) || '';
      return { kind: 'empty', detail: 'HTTP 200 但没有任何内容（finish_reason=' + fr + '）——常见原因：max_tokens 太小而该模型先输出思考' };
    }
    return { kind: 'ok', detail: '' };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'auth', detail: errMsg };
  if (res.status === 402) return { kind: 'quota', detail: errMsg };
  if (res.status === 429) return { kind: 'rate', detail: errMsg };
  if (res.status === 404 || (res.status === 400 && /model/i.test(low) && /(not found|not exist|unsupport|unknown|no access|不存在|不支持)/i.test(low))) {
    return { kind: 'no-model', detail: errMsg };
  }
  if (res.status >= 500) return { kind: 'upstream', detail: errMsg };
  return { kind: 'http-' + res.status, detail: errMsg };
}

const KIND_LABEL = {
  ok: '✅ 可用',
  timeout: '⏱ 超时',
  network: '🔌 网络不通',
  auth: '🔑 凭据被拒',
  quota: '💰 额度/余额',
  rate: '🚦 限流',
  'no-model': '❓ 该家没有此模型',
  upstream: '🔥 上游故障',
  empty: '⬜ 空响应',
  'body-error': '⚠️ 200 但体内报错',
  'bad-body': '⚠️ 非 JSON 响应',
};

async function runOne(gw, model, apiKey) {
  const t0 = Date.now();
  const res = await postJson(gw.port, '/v1/chat/completions', {
    model,
    messages: [{ role: 'user', content: '只回复两个字：你好' }],
    max_tokens: 64,          // 别用 1-8：很多模型会先输出思考，太小会得到"空响应"而误判
    stream: false,
  }, { authorization: 'Bearer ' + apiKey }, TIMEOUT_MS);
  const ms = Date.now() - t0;
  const c = classify(res, model);
  return Object.assign({ model, ms, status: res.status }, c);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      // eslint-disable-next-line no-await-in-loop
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

(async () => {
  const cfgPath = findConfig();
  if (!cfgPath) { console.error('找不到网关配置，请用 --config 指定'); process.exit(1); }
  if (!existsSync(ENGINE)) { console.error('找不到引擎：' + ENGINE); process.exit(1); }
  const baseCfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  console.log('配置来源: ' + cfgPath);
  console.log(`供应商 ${(baseCfg.providers || []).length} 家 / 统一 Key ${String(baseCfg.apiKey || '').slice(0, 6)}…`);
  console.log('');

  // 逻辑模型 → 提供它的供应商
  const byModel = new Map();
  for (const p of (baseCfg.providers || [])) {
    if (!p || p.enabled === false) continue;
    for (const m of (p.models || [])) {
      const logical = typeof m === 'string' ? m : String(m.as || m.id || '');
      const up = typeof m === 'string' ? m : String(m.id || m.up || '');
      if (!logical) continue;
      if (!byModel.has(logical)) byModel.set(logical, []);
      if (!byModel.get(logical).some((x) => x.provider === p.id)) byModel.get(logical).push({ provider: p.id, up });
    }
  }
  let models = [...byModel.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
  if (MODEL_FILTER.length) models = models.filter((m) => MODEL_FILTER.includes(m));
  const enabledProviders = (baseCfg.providers || []).filter((p) => p && p.enabled !== false);
  console.log(`待测逻辑模型 ${models.length} 个（启用供应商 ${enabledProviders.length} 家）`);
  console.log('');

  const report = { at: new Date().toISOString(), configPath: cfgPath, phase1: [], phase2: [] };

  /* ---------------- 阶段一：正常路由 ---------------- */
  console.log('======== 阶段一：经正常路由逐个测试 ========');
  const gw1 = await startGateway(JSON.parse(JSON.stringify(baseCfg)));
  if (!gw1.ready) { console.error('网关未就绪：' + gw1.getLog().slice(-800)); await gw1.stop(); process.exit(1); }
  const t1 = Date.now();
  const r1 = await mapLimit(models, CONCURRENCY, async (m, i) => {
    const r = await runOne(gw1, m, baseCfg.apiKey);
    console.log(`  [${String(i + 1).padStart(2)}/${models.length}] ${m.padEnd(38)} ${(KIND_LABEL[r.kind] || r.kind).padEnd(14)} ${String(r.ms).padStart(6)}ms  ${r.detail ? r.detail.slice(0, 90) : ''}`);
    return r;
  });
  report.phase1 = r1;
  await gw1.stop();
  const okN = r1.filter((x) => x.kind === 'ok').length;
  console.log('');
  console.log(`阶段一完成：${okN}/${models.length} 可用，用时 ${Math.round((Date.now() - t1) / 1000)}s`);
  console.log('');

  const failed = r1.filter((x) => x.kind !== 'ok');
  if (PHASE1_ONLY || failed.length === 0) {
    if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(report, null, 2), 'utf8'); console.log('结果已写入 ' + JSON_OUT); }
    printSummary(report);
    return;
  }

  /* ---------------- 阶段二：逐家隔离诊断 ---------------- */
  console.log('======== 阶段二：对失败模型逐个供应商隔离诊断 ========');
  console.log('（每个"模型 × 供应商"组合单独起一个只启用该家的网关，因此结论是确定的）');
  console.log('');
  for (const f of failed) {
    const provs = byModel.get(f.model) || [];
    console.log(`\n── ${f.model}  （阶段一：${KIND_LABEL[f.kind] || f.kind} ${f.detail ? '｜' + f.detail.slice(0, 100) : ''}）`);
    console.log(`   提供它的供应商 ${provs.length} 家：${provs.map((x) => x.provider).join(', ')}`);
    for (const { provider, up } of provs) {
      const oneCfg = JSON.parse(JSON.stringify(baseCfg));
      oneCfg.providers = oneCfg.providers.map((p) => Object.assign({}, p, { enabled: p.id === provider }));
      if (!oneCfg.providers.some((p) => p.id === provider)) continue;
      // eslint-disable-next-line no-await-in-loop
      const gw = await startGateway(oneCfg);
      if (!gw.ready) {
        console.log(`     ${provider.padEnd(18)} 网关未能启动`);
        report.phase2.push({ model: f.model, provider, kind: 'gw-fail' });
        // eslint-disable-next-line no-await-in-loop
        await gw.stop();
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await runOne(gw, f.model, baseCfg.apiKey);
      const log = gw.getLog();
      const via = (log.match(/served .* via (\S+)/g) || []).slice(-1)[0] || '';
      // eslint-disable-next-line no-await-in-loop
      await gw.stop();
      console.log(`     ${provider.padEnd(18)} 上游ID=${String(up).padEnd(34)} ${(KIND_LABEL[r.kind] || r.kind).padEnd(14)} ${String(r.ms).padStart(6)}ms ${via ? '｜' + via : ''}`);
      if (r.detail) console.log(`       └ ${r.detail.slice(0, 160)}`);
      // 失败时把网关日志的关键行贴出来 —— 这才是"为什么失败"的直接证据
      if (r.kind !== 'ok') {
        const why = explainLog(log);
        if (why.length) {
          console.log('       ┌ 网关日志：');
          for (const l of why) console.log('       │ ' + l);
        }
      }
      report.phase2.push(Object.assign({ model: f.model, provider, up }, r, r.kind === 'ok' ? {} : { log: explainLog(log) }));
    }
  }

  if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(report, null, 2), 'utf8'); console.log('\n结果已写入 ' + JSON_OUT); }
  printSummary(report);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });

function printSummary(report) {
  const all = report.phase1;
  const okN = all.filter((x) => x.kind === 'ok').length;
  console.log('');
  console.log('======== 汇总 ========');
  console.log(`阶段一：${okN}/${all.length} 个逻辑模型可用`);
  const byKind = new Map();
  for (const x of all) if (x.kind !== 'ok') byKind.set(x.kind, (byKind.get(x.kind) || 0) + 1);
  if (byKind.size) {
    console.log('失败分类：');
    for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${(KIND_LABEL[k] || k).padEnd(16)} ${n}`);
  }
  if (report.phase2.length) {
    console.log('阶段二（逐家隔离）：');
    const p2ok = report.phase2.filter((x) => x.kind === 'ok');
    console.log(`  在单独启用某一家时**可用**的组合有 ${p2ok.length} 个 —— 说明这些家在正常路由下被别的（更慢/更差的）家拖累了，或熔断/冷却把它误伤了`);
    for (const x of p2ok) console.log(`    ${x.model} ← ${x.provider}`);
  }
}
