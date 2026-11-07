// tests/probe.test.js — 供应商探测（src/probe.js）的归因与判定
//
// 这套用例锁的是 2026-11-03 那轮修复的核心：**「测试」不许把能用的家报成不可用**。
// 现场（用户截图 + 逐家复核）：
//   · sensenova 两把 Key 都回 429 `inference exceeds tpm/rpm limit` → 报「2 把被拒」；
//   · cline 回 403 `only available via Cline product surfaces` → 报「凭据被拒」；
//   · x666 / windhub 回 503 `No available channel for model … under group …` → 报「不可用」，
//     而这两家在真实流量里 37/37、9/9 全成功（走的是配置里别的模型）；
//   · 本机代理没起来时 → 一片「连不上」，其实只是代理没开。
// 全部用一个本地假上游复现，不碰网络。
'use strict';

const http = require('node:http');
const assert = require('node:assert');
const { t, run } = require('./_harness');
const probe = require('../src/probe');

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
  res.end(payload);
}

/**
 * 起一个假上游：`/v1/models` 恒 200；生成端点按 `script` 的顺序回放。
 * script 里每项 `{ status, body }`，用完之后重复最后一项。
 */
function startUp(script, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const st = { models: 0, gens: 0, bodies: [], paths: [] };
    const srv = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        st.paths.push(req.url);
        if (/\/models(\?|$)/.test(req.url)) {
          st.models++;
          sendJson(res, 200, { data: [{ id: 'm-a' }, { id: 'm-b' }] });
          return;
        }
        st.gens++;
        st.bodies.push(buf);
        const step = script[st.gens - 1] || script[script.length - 1] || { status: 200, body: {} };
        if (step.destroy) { req.socket.destroy(); return; }
        sendJson(res, step.status, step.body);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, st, url: 'http://127.0.0.1:' + srv.address().port });
    });
    srv.unref();
    if (o.delayMs) { /* 预留 */ }
  });
}

const closeUp = (up) => { try { up.srv.close(); } catch (_) { /* 忽略 */ } };

const providerOf = (up, extra) => Object.assign({
  id: 'p1',
  baseURL: up.url,
  protocol: 'openai-chat',
  apiKey: 'sk-test',
  models: [{ id: 'm-a', as: 'test-model' }, { id: 'm-b', as: 'test-model' }],
}, extra || {});

const probeOnce = (p, extra) => probe.probeProvider(p, Object.assign({
  timeoutMs: 5000, genTimeoutMs: 5000, deepProbe: true, genModel: 'm-a', genModels: ['m-a', 'm-b'],
}, extra || {}));

(async () => {
  // ── 1. 归因函数本身 ────────────────────────────────────────────────────
  t('classifyGenFailure：限流 / 模型级 / 凭据 / 连接 / 代理 各归各家', () => {
    assert.strictEqual(probe.classifyGenFailure(429, 'inference exceeds tpm/rpm limit'), 'rate');
    assert.strictEqual(probe.classifyGenFailure(400, 'Rate limit reached for requests'), 'rate');
    assert.strictEqual(probe.classifyGenFailure(503, 'No available channel for model x under group level3 (distributor)'), 'model');
    assert.strictEqual(probe.classifyGenFailure(403, 'Error 403: cline-free/mimo-v2.6-flash is only available via Cline product surfaces.'), 'model');
    assert.strictEqual(probe.classifyGenFailure(403, 'model is not available in the current token plan'), 'model');
    assert.strictEqual(probe.classifyGenFailure(403, '{"status":403,"title":"Forbidden","detail":"Authorization failed"}'), 'cred');
    assert.strictEqual(probe.classifyGenFailure(0, 'connect ECONNREFUSED 127.0.0.1:7890'), 'conn');
    assert.strictEqual(probe.classifyGenFailure(0, 'connect ECONNREFUSED 127.0.0.1:7890', '代理'), 'proxy');
    assert.strictEqual(probe.classifyGenFailure(0, '连接代理失败：connect ECONNREFUSED 127.0.0.1:7890'), 'proxy');
    assert.strictEqual(probe.classifyGenFailure(500, 'upstream blew up'), 'busy');
    assert.strictEqual(probe.classifyGenFailure(503, 'This model is currently experiencing high demand. Spikes in demand are usually temporary.'), 'busy');
    assert.strictEqual(probe.classifyGenFailure(402, '{"error":{"message":"Insufficient balance. Your Cline Credits balance is $0.00"}}'), 'pay');
    assert.strictEqual(probe.classifyGenFailure(400, 'some weird rejection we do not understand'), 'other');
    // 「代理通了但目标没回话」不能算代理挂了（2026-11-03 实测 nvidia 被指向去修没坏的代理）
    assert.strictEqual(
      probe.classifyGenFailure(0, '（整体墙钟）超时 20505ms：连响应头都没收到（上游或代理没有回话）', '代理'),
      'conn',
    );
    assert.strictEqual(probe.classifyGenFailure(0, 'Client network socket disconnected before secure TLS connection was established', '代理'), 'conn');
  });

  t('kindOfGen：只有"凭据/余额"才是 false，其余一律"判不出来"', () => {
    assert.strictEqual(probe.kindOfGen('rate').ok, null);
    assert.strictEqual(probe.kindOfGen('model').ok, null);
    assert.strictEqual(probe.kindOfGen('proxy').ok, null);
    assert.strictEqual(probe.kindOfGen('conn').ok, null);
    assert.strictEqual(probe.kindOfGen('busy').ok, null);
    assert.strictEqual(probe.kindOfGen('other').ok, null);
    assert.strictEqual(probe.kindOfGen('cred').ok, false);
    assert.strictEqual(probe.kindOfGen('pay').ok, false);
  });

  // ── 2. 生成成功 ────────────────────────────────────────────────────────
  t('试生成成功 → ok:true，且只发一次生成请求', async () => {
    const up = await startUp([{ status: 200, body: { choices: [{ message: { content: 'hi' } }] } }]);
    try {
      const r = await probeOnce(providerOf(up));
      assert.strictEqual(r.ok, true, '应判可用：' + r.verdict);
      assert.strictEqual(up.st.gens, 1, '成功就不用再试别的模型，实际 ' + up.st.gens);
      assert.ok(/凭据可用于生成/.test(r.verdict), r.verdict);
    } finally { closeUp(up); }
  });

  // ── 3. 限流（sensenova 现场）────────────────────────────────────────────
  t('试生成 429 tpm/rpm → ok:null（限流），不是"凭据被拒"', async () => {
    const up = await startUp([{ status: 429, body: { error: { message: 'inference exceeds tpm/rpm limit' } } }]);
    try {
      const r = await probeOnce(providerOf(up));
      assert.strictEqual(r.ok, null, '限流必须判"不确定"，实际 ' + r.ok + '：' + r.verdict);
      assert.strictEqual(r.gen.kind, 'rate', '归因应为 rate，实际 ' + r.gen.kind);
      assert.ok(/被限流/.test(r.verdict) && /不是凭据问题/.test(r.verdict), r.verdict);
      // 限流时换模型没有意义 —— 不许接着打剩下的模型（省配额、省时间）
      assert.strictEqual(up.st.gens, 1, '限流不该再试别的模型，实际 ' + up.st.gens);
    } finally { closeUp(up); }
  });

  // ── 4. 模型级 503（x666 / windhub 现场）─────────────────────────────────
  t('第一个模型回 503「No available channel…under group」→ 换下一个已声明模型，任一出字即 ok:true', async () => {
    const up = await startUp([
      { status: 503, body: { error: { message: 'No available channel for model m-a under group level3 (distributor)' } } },
      { status: 200, body: { choices: [{ message: { content: 'hi' } }] } },
    ]);
    try {
      const r = await probeOnce(providerOf(up));
      assert.strictEqual(r.ok, true, '换模型成功就该判可用：' + r.verdict);
      assert.strictEqual(up.st.gens, 2, '应恰好试两个模型，实际 ' + up.st.gens);
      assert.strictEqual(r.genTried.length, 2, 'genTried 应记录两次尝试');
      assert.strictEqual(r.genTried[0].kind, 'model', '第一条应是模型级：' + JSON.stringify(r.genTried[0]));
      assert.strictEqual(r.gen.model, 'm-b', '最终成功的应是第二个模型，实际 ' + r.gen.model);
      assert.ok(/m-a/.test(r.verdict) && /注意/.test(r.verdict), '结论里要点名哪个模型不行：' + r.verdict);
    } finally { closeUp(up); }
  });

  t('声明的模型**全都**是模型级不可用 → ok:null（不是凭据问题），并说明都试过了', async () => {
    const up = await startUp([
      { status: 503, body: { error: { message: 'No available channel for model m-a under group auto' } } },
      { status: 503, body: { error: { message: 'No available channel for model m-b under group auto' } } },
    ]);
    try {
      const r = await probeOnce(providerOf(up));
      assert.strictEqual(r.ok, null, '模型级限制不能判成凭据坏，实际 ' + r.ok + '：' + r.verdict);
      assert.ok(/不是凭据问题/.test(r.verdict), r.verdict);
      assert.ok(/都试过了/.test(r.verdict), '应说明配置里的模型都试过：' + r.verdict);
      assert.strictEqual(up.st.gens, 2, '最多试两个（配置里就两个），实际 ' + up.st.gens);
    } finally { closeUp(up); }
  });

  // ── 5. 凭据问题（真该报红的）───────────────────────────────────────────
  t('试生成 403 Authorization failed → ok:false（这才是凭据问题）', async () => {
    const up = await startUp([
      { status: 403, body: { status: 403, title: 'Forbidden', detail: 'Authorization failed' } },
    ]);
    try {
      const r = await probeOnce(providerOf(up));
      assert.strictEqual(r.ok, false, '真正的凭据失败必须报红，实际 ' + r.ok + '：' + r.verdict);
      assert.strictEqual(r.gen.kind, 'cred', '归因应为 cred，实际 ' + r.gen.kind);
      assert.ok(/试生成被拒/.test(r.verdict), r.verdict);
    } finally { closeUp(up); }
  });

  t('目录就 401 → ok:false（连目录都进不去）', async () => {
    const up = await startUp([{ status: 200, body: {} }], {});
    // 覆盖 /models 的返回
    up.srv.removeAllListeners('request');
    up.srv.on('request', (req, res) => sendJson(res, 401, { error: { message: 'invalid api key' } }));
    try {
      const r = await probeOnce(providerOf(up));
      assert.strictEqual(r.ok, false, '目录 401 应判不可用：' + r.verdict);
      assert.ok(/凭据被拒绝/.test(r.verdict), r.verdict);
    } finally { closeUp(up); }
  });

  // ── 6. 本机代理没开（用户现场：一片"连不上"）────────────────────────────
  t('本机代理连不上 → ok:null + proxyDown（是本机环境问题，不是渠道坏了）', async () => {
    // 目标必须**不是回环**（probe 对 127.0.0.1 永远直连，这是对的），
    // 代理指向一个必然拒绝连接的端口 → 连代理这一步就断。
    const mk = (baseURL) => ({ id: 'p1', baseURL, protocol: 'openai-chat', apiKey: 'sk-test' });
    const httpsR = await probe.probeProvider(mk('https://probe-test.invalid'), {
      proxy: 'http://127.0.0.1:1', noProxy: [], timeoutMs: 4000, deepProbe: false,
    });
    assert.strictEqual(httpsR.ok, null, 'https 目标走代理失败不能判成供应商不可用：' + httpsR.ok + ' / ' + httpsR.verdict);
    assert.strictEqual(httpsR.proxyDown, true, '应标记 proxyDown：' + JSON.stringify(httpsR));
    assert.ok(/本机代理连不上/.test(httpsR.verdict), httpsR.verdict);

    // http 目标走代理时是"把绝对 URI 发给代理"，错误是裸的 ECONNREFUSED ——
    // 旧实现只认自造的"连接代理失败"文案，于是这条被当成"供应商连不上"。
    const httpR = await probe.probeProvider(mk('http://probe-test.invalid'), {
      proxy: 'http://127.0.0.1:1', noProxy: [], timeoutMs: 4000, deepProbe: false,
    });
    assert.strictEqual(httpR.ok, null, 'http 目标走代理失败同样是本机问题：' + httpR.ok + ' / ' + httpR.verdict);
    assert.strictEqual(httpR.proxyDown, true, '应标记 proxyDown：' + JSON.stringify(httpR));
  });

  // ── 7. 单 Key 体检的归因（多 Key 聚合靠它）──────────────────────────────
  t('probeOneKeyGen：429→null(rate)、模型级→null(model)、403→false(cred)', async () => {
    const rate = await startUp([{ status: 429, body: { error: { message: 'Too many requests, tpm limit' } } }]);
    const model = await startUp([{ status: 503, body: { error: { message: 'No available channel for model m-a under group auto' } } }]);
    const cred = await startUp([{ status: 403, body: { error: { message: 'invalid api key' } } }]);
    try {
      const g1 = await probe.probeOneKeyGen(providerOf(rate), { key: 'k1', model: 'm-a', timeoutMs: 5000 });
      assert.strictEqual(g1.ok, null); assert.strictEqual(g1.kind, 'rate');
      const g2 = await probe.probeOneKeyGen(providerOf(model), { key: 'k1', model: 'm-a', timeoutMs: 5000 });
      assert.strictEqual(g2.ok, null); assert.strictEqual(g2.kind, 'model');
      const g3 = await probe.probeOneKeyGen(providerOf(cred), { key: 'k1', model: 'm-a', timeoutMs: 5000 });
      assert.strictEqual(g3.ok, false); assert.strictEqual(g3.kind, 'cred');
    } finally { closeUp(rate); closeUp(model); closeUp(cred); }
  });

  // ── 8. 目录可达但明确不做试生成时，不许把"目录 ok"读成"能用" ──────────────
  t('deepProbe:false → 只报目录，不试生成（界面据此标"未验证生成"）', async () => {
    const up = await startUp([{ status: 200, body: {} }]);
    try {
      const r = await probeOnce(providerOf(up), { deepProbe: false });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.gen, null, '不该有试生成结果');
      assert.strictEqual(up.st.gens, 0, '不该发生成请求，实际 ' + up.st.gens);
      assert.ok(/可达/.test(r.verdict), r.verdict);
    } finally { closeUp(up); }
  });

  // ── 9. 多 Key 聚合（sensenova「2 把被拒」现场）──────────────────────────
  t('summarizeKeyResults：全部限流 → ok:null 且不许说"被拒"', () => {
    const rows = [
      { index: 1, status: 429, ok: null, kind: 'rate', err: 'inference exceeds tpm/rpm limit' },
      { index: 2, status: 429, ok: null, kind: 'rate', err: 'inference exceeds tpm/rpm limit' },
    ];
    const s = probe.summarizeKeyResults(2, rows, 8);
    assert.strictEqual(s.ok, null, '限流不能判成不可用：' + s.verdict);
    assert.ok(/被限流/.test(s.keySummary), s.keySummary);
    assert.ok(!/被拒/.test(s.keySummary), '限流不许写成"被拒"：' + s.keySummary);
    assert.ok(/过一两分钟再测/.test(s.verdict), s.verdict);
  });

  t('summarizeKeyResults：一把能用 + 一把限流 → ok:true（这家能用）', () => {
    const s = probe.summarizeKeyResults(2, [
      { index: 1, status: 200, ok: true, kind: 'ok' },
      { index: 2, status: 429, ok: null, kind: 'rate', err: 'tpm limit' },
    ], 15);
    assert.strictEqual(s.ok, true, s.verdict);
    assert.ok(/1 把可用于生成/.test(s.keySummary) && /1 把被限流/.test(s.keySummary), s.keySummary);
    assert.ok(/目录 15 个模型/.test(s.verdict), s.verdict);
  });

  t('summarizeKeyResults：一把凭据被拒 + 一把限流 → ok:null（坏 Key 要点名，但整家不判死）', () => {
    const s = probe.summarizeKeyResults(2, [
      { index: 1, status: 403, ok: false, kind: 'cred', err: 'invalid api key' },
      { index: 2, status: 429, ok: null, kind: 'rate', err: 'tpm limit' },
    ], 8);
    assert.strictEqual(s.ok, null, s.verdict);
    assert.ok(/1 把被拒/.test(s.keySummary) && /1 把被限流/.test(s.keySummary), s.keySummary);
    assert.ok(/还不能判死/.test(s.verdict) && /先把被拒的换掉/.test(s.verdict), s.verdict);
  });

  t('summarizeKeyResults：全部 Key 都被凭据拒 → ok:false（这才是"这家不可用"）', () => {
    const s = probe.summarizeKeyResults(2, [
      { index: 1, status: 403, ok: false, kind: 'cred', err: 'invalid api key' },
      { index: 2, status: 401, ok: false, kind: 'cred', err: 'unauthorized' },
    ], 8);
    assert.strictEqual(s.ok, false, s.verdict);
    assert.ok(/2 把 Key 都无法生成/.test(s.verdict), s.verdict);
  });

  t('classifyGenFailure：max_tokens 到顶不算渠道问题（探测请求太抠）', () => {
    const kind = probe.classifyGenFailure(400, 'Could not finish the message because max_tokens or model output limit was reached. Please try again with higher max_tokens.', '代理');
    assert.strictEqual(kind, 'limit', '应判为探测本身的额度问题，实际 ' + kind);
    assert.strictEqual(probe.kindOfGen(kind).ok, null, '不能判成不可用');
  });

  t('summarizeKeyResults：全是模型级限制 → ok:null 且说明不是凭据问题', () => {
    const s = probe.summarizeKeyResults(2, [
      { index: 1, status: 503, ok: null, kind: 'model', err: 'No available channel' },
      { index: 2, status: 503, ok: null, kind: 'model', err: 'No available channel' },
    ], 8);
    assert.strictEqual(s.ok, null, s.verdict);
    assert.ok(/无法判定/.test(s.verdict) && /模型级限制/.test(s.verdict), s.verdict);
  });

  t('summarizeKeyResults：跳过的 Key 不算"被拒"', () => {
    const s = probe.summarizeKeyResults(3, [
      { index: 1, status: 200, ok: true, kind: 'ok' },
      { index: 2, skipped: true },
      { index: 3, skipped: true },
    ], 8);
    assert.strictEqual(s.ok, true, s.verdict);
    assert.ok(/3 把 Key：1 把可用于生成/.test(s.keySummary), s.keySummary);
    assert.ok(!/无法判定/.test(s.keySummary), '跳过的 Key 不该进"无法判定"：' + s.keySummary);
  });

  await run();
})();
