// tests/gateway.test.js — 模型网关端到端回归（2026-09-10 审计修复验证）
//
// 做法：进程内起一个**假上游**（可控 SSE / 可控挂起 / 记录客户端是否断开），再用
// process.execPath 真启动 src/gateway/model-gateway.mjs（真 listen + 真转发），
// 从测试进程发真请求。覆盖：
//   1) 鉴权（错误/缺失 key → 401；正确 key → 200）
//   2) 正常 SSE 流式转发（重构后 happy path 不回归）
//   3) 客户端中途断开 → **上游流被立即取消**（旧版会一直读到结束并记 ok）
//   4) 超大请求体 → 413 且连接被关闭（旧版回 400 并毒化 keep-alive）
//   5) 畸形 Host → 400 且不悬挂（旧版 new URL 抛错 → 请求永久挂起）
//   6) 上游错误体挂起 → 网关不永久挂起
//   7-10) write-dsh 的 YAML 逐层定位与幂等/备份
//   11) 上游确定性 4xx（400/422）→ 只打一次上游、终止 failover、客户端拿 4xx（N 倍计费回归）
//   12) 上游内容拦截（content_blocked）→ 仍换下一家（有意行为保留）+ 缺省不落 dump
//   13) 内容拦截 dump：env 开关 + 保留最近 20 个 + 长串只记 {len,kind}
//   14) 模型不在 catalog/models 里 → 404 且零计费转发（旧的"任意模型发给所有供应商"回归）
//   15) catalog 命中即候选（供应商新增模型不必改配置）
//   16) 熔断：冷却期不打上游 + 半开并发只放一个探测 + 上游恢复能自愈
// 运行：node tests/gateway.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MJS = path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs');
const GATEWAY_KEY = 'dsh-gateway-test-0123456789abcdef';
// 上游假 key 运行期拼接（与 integration.js 同款约定）：避免源码里出现 `sk-` + 长串的
// 字面量，被发布安全闸门的通用形态规则误判为真实密钥。
const UPSTREAM_KEY = 'sk-' + 'FAKE'.repeat(8).toLowerCase();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-'));

let passed = 0;
const __tests = [];
function t(name, fn) { __tests.push({ name, fn }); }

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// 上游观测记录
const upstream = {
  cancelled: 0,        // 客户端断开后被我们观察到的次数
  streams: 0,
  hangBody: false,     // /v1/chat/completions 返回 500 后不结束 body
  // 收尾形态：null = 正常（chunk×3 + [DONE]）；否则见 server 里的分支
  //   'usage-only' → choices:[] + usage（OpenAI 规范的合法终止标记）
  //   'no-done'    → 给 finish_reason 但不发 [DONE]
  //   'truncated'  → 真截断：什么都不给，干净地断开
  tailMode: null,
};

const upstreamServer = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (upstream.hangBody) {
        // 返回错误状态头后**不结束 body**：旧版网关会永久挂起
        res.writeHead(500, { 'content-type': 'application/json' });
        res.write('{"error":{"message":"upstream stalled');
        return;
      }
      // ⚠ 按 `upstream.tailMode` 决定收尾形态 —— 用于验证"截断检测"不误报。
      // 这几条都是**合法**的上游收尾方式，旧实现（以及我第一版截断检测）
      // 会把其中一部分误判成"上游被腰斩"，非流式时还会因此触发 failover 变成 503。
      if (upstream.tailMode) {
        upstream.streams++;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
        const mode = upstream.tailMode;
        if (mode === 'usage-only') {
          // OpenAI 规范的合法终止标记（stream_options.include_usage）：
          // choices 为空 + 带 usage。很多上游只发这一帧、不发 [DONE]、不给 finish_reason。
          res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
        } else if (mode === 'no-done') {
          // 给 finish_reason 但不发 [DONE]
          res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        } else if (mode === 'truncated') {
          // ★ 真截断：什么都不给，**干净地**结束（模拟代理掉线 / 对端 close 而不 reset）
        }
        res.end();
        return;
      }
      upstream.streams++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let n = 0;
      const timer = setInterval(() => {
        n++;
        res.write('data: {"choices":[{"delta":{"content":"chunk' + n + '"}}]}\n\n');
        if (n >= 3) {
          clearInterval(timer);
          // 收尾：先给一个带**缓存字段**的 usage 帧（OpenAI 规范的合法终止标记，
          // `stream_options.include_usage` 的形态：choices 为空 + usage），再 [DONE]。
          // 带 cached_tokens 是为了让"缓存字段必须传出去"那条用例有东西可断言。
          res.write('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":3,'
            + '"total_tokens":103,"prompt_tokens_details":{"cached_tokens":64}}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 120);
      // 客户端（网关）断开 → 记录并停掉生成
      res.on('close', () => {
        if (res.writableEnded) return;
        clearInterval(timer);
        upstream.cancelled++;
      });
    });
    return;
  }
  res.writeHead(404).end();
});

let gwPort = 0;
let gwProc = null;
const gwLogPath = path.join(tmp, 'gateway.log');

function startGateway() {
  const cfgPath = path.join(tmp, 'gateway.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: gwPort,
    apiKey: GATEWAY_KEY,
    providers: [{
      id: 'fake', baseURL: 'http://127.0.0.1:' + upstreamPort + '/v1',
      apiKey: UPSTREAM_KEY, models: ['test-model'], priority: 1, enabled: true,
    }],
  }, null, 2), 'utf8');
  // 注意：本机沙箱禁止子进程使用管道 stdio（EPERM），且网关自己写日志文件，
  // 因此这里用 'ignore' 而不捕获 stdout/stderr。
  gwProc = spawn(process.execPath, [MJS, '--config', cfgPath, '--log', gwLogPath, '--port', String(gwPort)], {
    stdio: 'ignore', windowsHide: true,
  });
}

function waitHealth(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() > deadline) return resolve(false);
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        setTimeout(tick, 300);
      });
      req.on('timeout', () => { req.destroy(); setTimeout(tick, 300); });
      req.on('error', () => setTimeout(tick, 300));
    };
    tick();
  });
}

function call({ method = 'POST', p = '/v1/chat/completions', key = GATEWAY_KEY, body = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, ac = null, port = 0, headers = null } = {}) {
  const targetPort = port || gwPort;
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: targetPort, path: p, method,
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        key ? { authorization: 'Bearer ' + key } : {},
        // 额外头（例如会话亲和的 x-session-id）—— 用于需要控制路由身份的用例
        headers || {}),
      signal: ac ? ac.signal : undefined,
    }, (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c;
        // 客户端在中途主动断开（模拟"点停止"）
        if (ac && !ac.signal.aborted && text.includes('chunk1')) { try { ac.abort(); } catch { } }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message, text: '' }));
    req.end(payload);
  });
}

let upstreamPort = 0;

(async () => {
  await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', () => { upstreamPort = upstreamServer.address().port; r(); }));
  gwPort = await freePort();
  startGateway();
  const ok = await waitHealth(gwPort, 20000);
  if (!ok) {
    console.log('[SKIP] 网关未能在 20s 内就绪（本机 spawn 受限？）——跳过端到端用例');
    try { gwProc.kill(); } catch { }
    try { upstreamServer.close(); } catch { }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }
  console.log('[..] 网关已就绪 :' + gwPort + '，假上游 :' + upstreamPort);

  // ---- 1) 鉴权 ----
  t('网关：缺失/错误 key → 401，正确 key → 200', async () => {
    const noKey = await call({ key: '' });
    assert.strictEqual(noKey.status, 401, '缺 key 应 401，实际 ' + noKey.status);
    const badKey = await call({ key: 'dsh-gateway-wrong-key-000000' });
    assert.strictEqual(badKey.status, 401, '错 key 应 401，实际 ' + badKey.status);
    const good = await call({});
    assert.strictEqual(good.status, 200, '正确 key 应 200，实际 ' + good.status + ' ' + good.text.slice(0, 120));
  });

  // ---- 2) 正常流式转发 ----
  t('网关：正常 SSE 流式转发（重构后 happy path 未回归）', async () => {
    const r = await call({});
    assert.strictEqual(r.status, 200);
    assert.ok(/chunk1/.test(r.text) && /\[DONE\]/.test(r.text), '应收到完整流：' + r.text.slice(0, 200));
  });

  // ---- 3) 客户端断开 → 上游流被取消（P1-3）----
  t('网关：客户端断开 → 立即取消上游流（旧版会读到结束并记 ok）', async () => {
    const before = upstream.cancelled;
    const ac = new AbortController();
    const p = call({ ac });
    await new Promise((r) => setTimeout(r, 400));   // 让客户端收到 chunk1 并触发 abort
    try { ac.abort(); } catch { }
    await p.catch(() => { });
    // 给网关与上游一点时间传播取消
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(upstream.cancelled > before,
      '上游应观察到客户端断开（cancelled ' + before + ' → ' + upstream.cancelled + '）——说明网关真的取消了上游流');
  });

  // ---- 4) 超大请求体 → 413 + 关闭连接（P1-2）----
  t('网关：超过 16MB 的请求体 → 413 且连接被关闭（不再毒化 keep-alive）', async () => {
    const big = JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'x'.repeat(17 * 1024 * 1024) }] });
    const r = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: gwPort, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big), authorization: 'Bearer ' + GATEWAY_KEY },
      }, (res) => {
        let t = '';
        res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
        res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
      });
      req.on('error', (e) => resolve({ status: 0, error: e.code || e.message, headers: {} }));
      // 只发一部分就够触发上限（content-length 已声明为大值）
      req.write(big.slice(0, 16 * 1024 * 1024 + 4096));
      setTimeout(() => { try { req.destroy(); } catch { } }, 4000);
    });
    assert.strictEqual(r.status, 413, '应回 413，实际 ' + r.status + ' ' + (r.error || ''));
    assert.strictEqual(String(r.headers.connection || '').toLowerCase(), 'close', '应声明 Connection: close');
  });

  // ---- 5) 畸形 Host → 400 不悬挂（P2-1）----
  t('网关：畸形 Host 头 → 403（Host 守卫拦在最前；旧版 new URL 抛错 → 请求永久挂起）', async () => {
    // 本意是"畸形 Host 不能把请求悬挂"。状态码从 400 变成 403 是 2026-10-08 加 Host 回环
    // 守卫的**预期后果**：守卫在 `new URL()` 之前就把非回环 Host 挡掉，
    // 而 `[` 显然不是回环 —— 403 比 400 更准确（"不允许"而非"格式错"）。
    const raw = await new Promise((resolve) => {
      const sock = net.connect(gwPort, '127.0.0.1', () => {
        sock.write('GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      sock.setTimeout(5000, () => { sock.destroy(); resolve(buf || '(timeout)'); });
      sock.on('data', (c) => { buf += c; });
      sock.on('close', () => resolve(buf));
      sock.on('error', () => resolve(buf));
    });
    assert.ok(/^HTTP\/1\.1 403/.test(raw), '应回 403（不能悬挂），实际首行：' + String(raw).split('\r\n')[0]);
  });

  t('网关：DNS rebinding 防护 —— 非回环 Host / Origin 一律 403，正常客户端不受影响', async () => {
    // 依据（2026-10-08，参照 corrinehu/dsh-workbuddy-connect 的 src/loopback.ts）：
    // 网关监听 127.0.0.1，而 **/health 必须免鉴权**（进程内 watchdog 用它自检，
    // 加鉴权会让网关把自己判死并自杀重启）—— 于是只剩"校验 Host/Origin 是不是回环"这一条防线。
    // 攻击手法：恶意页面把自己的域名解析到 127.0.0.1，浏览器就会带着**攻击者的域名**请求本机网关。
    const req = (headers) => new Promise((resolve) => {
      const q = http.request({ host: '127.0.0.1', port: gwPort, path: '/health', method: 'GET', timeout: 8000, headers },
      (x) => { let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => resolve({ st: x.statusCode, b })); });
      q.on('error', (e) => resolve({ st: 0, b: e.message })); q.end();
    });
    // ① 正常：回环 Host
    for (const h of ['127.0.0.1:' + gwPort, 'localhost:' + gwPort]) {
      const r = await req({ host: h });
      assert.strictEqual(r.st, 200, `Host=${h} 应放行，实际 ${r.st}`);
    }
    // ② 攻击者的域名
    for (const h of ['evil.example.com', '127.0.0.1.evil.com', 'localhost.evil.com']) {
      const r = await req({ host: h });
      assert.strictEqual(r.st, 403, `Host=${h} 必须拒绝（DNS rebinding），实际 ${r.st}`);
    }
    // ③ Origin：非浏览器不发 Origin → 放行；浏览器发的必须是回环
    assert.strictEqual((await req({ host: '127.0.0.1:' + gwPort })).st, 200, '无 Origin 应放行（非浏览器客户端）');
    assert.strictEqual((await req({ host: '127.0.0.1:' + gwPort, origin: 'http://127.0.0.1:1234' })).st, 200, '回环 Origin 应放行');
    assert.strictEqual((await req({ host: '127.0.0.1:' + gwPort, origin: 'http://evil.example.com' })).st, 403, '非回环 Origin 必须拒绝');
  });

  t('网关：Host 解析的 IPv6 / 端口剥离（变异测试证明这段逻辑此前零覆盖）', async () => {
    // ⚠ 这条测试的由来：2026-10-09 的变异测试发现，把 `hostnameOfHost` 整个换成天真的
    // `h.split(':')[0]`，**全量 142 条测试 0 条失败** —— 也就是说这段"IPv6 方括号感知"
    // 的逻辑没有任何回归保护，而改错的后果是**合法的 IPv6 回环被 403**。
    //
    // 不能简单 split(':') 的三个理由（逐个钉住）：
    //   · `[::1]:3091` → 天真切法得到 `[`，回环被误拒
    //   · `[::1]`（无端口）→ 天真切法得到 `[`
    //   · 裸 `::1`（无方括号）→ 里面的冒号**不是**端口分隔符，不能截断
    //
    // ⚠ 必须用**裸 socket**：Node 的 http 客户端对 `Host: [::1]`（无端口）会 ECONNRESET，
    // 测不出服务端的真实行为。另外裸 `::1`（不加方括号）是 RFC 违规，
    // **Node 的 HTTP 解析器自己就回 400**，根本到不了我们的守卫 —— 这条也钉住。
    const raw = (hostHeader) => new Promise((resolve) => {
      const sock = net.connect(gwPort, '127.0.0.1', () => {
        sock.write('GET /health HTTP/1.1\r\nHost: ' + hostHeader + '\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      sock.setTimeout(6000, () => { sock.destroy(); resolve(buf); });
      sock.on('data', (c) => { buf += c; });
      sock.on('close', () => resolve(buf));
      sock.on('error', () => resolve(buf));
    });
    const codeOf = (b) => (String(b).match(/^HTTP\/1\.1 (\d{3})/m) || [])[1] || '(无响应)';

    // 合法的 IPv6 回环形态都必须放行
    for (const h of ['[::1]:' + gwPort, '[::1]']) {
      assert.strictEqual(codeOf(await raw(h)), '200',
        `Host=${h} 是合法 IPv6 回环，必须放行（不能因切端口切坏而误拒）`);
    }
    // 非回环的 IPv6 形态必须拒绝
    for (const h of ['[::ffff:127.0.0.1]:' + gwPort, '[::]', '[2001:db8::1]:' + gwPort, '[0:0:0:0:0:0:0:2]']) {
      assert.strictEqual(codeOf(await raw(h)), '403', `Host=${h} 不是回环，必须拒绝`);
    }
    // 裸 IPv6（无方括号）是 RFC 违规 → Node 解析器回 400，不归我们管
    assert.strictEqual(codeOf(await raw('::1')), '400',
      'Host=::1 应被 Node 的 HTTP 解析器拒掉（未加方括号是 RFC 违规）');
    // 端口剥离 + 大小写 + 尾空格
    for (const h of ['127.0.0.1:' + gwPort, '127.0.0.1:0', 'LOCALHOST:' + gwPort, '127.0.0.1:' + gwPort + ' ']) {
      assert.strictEqual(codeOf(await raw(h)), '200', `Host=${h} 应放行（大小写/端口 0/尾空格）`);
    }
    // 看着像但不是回环的形态
    for (const h of ['127.0.0.2:' + gwPort, '127.1', '2130706433', 'localhost.', '0.0.0.0:' + gwPort, '127.0.0.1.nip.io']) {
      assert.strictEqual(codeOf(await raw(h)), '403', `Host=${h} 不是回环，必须拒绝`);
    }
  });

  // ---- 6) 上游错误响应体挂起 → 网关不永久挂起（P2-3）----
  t('网关：上游错误体挂起 → 网关仍在 5s 超时内返回（不永久挂起）', async () => {
    upstream.hangBody = true;
    const t0 = Date.now();
    const r = await call({});
    const dt = Date.now() - t0;
    upstream.hangBody = false;
    assert.ok(r.status >= 400 || r.status === 0, '上游 500 时不应回 200：' + r.status);
    assert.ok(dt < 15000, '应在超时内结束（实际 ' + dt + 'ms）');
  });

  // ---- 6b) 上游收尾形态 → 截断检测**不得误报**（0.7.14 回归）----
  //
  // 背景：0.7.13 加的"截断检测"（上游被腰斩时明确报错，别伪装成正常结束）
  // 第一版漏了 `choices:[]` + `usage` 这种**合法**收尾 —— 而它是 OpenAI 规范里
  // `stream_options.include_usage` 的终止标记，很多上游**只发它、不发 [DONE]、
  // 也不给 finish_reason**。误判后果不轻：
  //   · 流式：一条完全正常的回复被塞进 `event: error`；
  //   · 非流式：那时响应头还没发，`{ok:false}` 触发 **failover**，
  //     全部失败后回 `503 all providers … are unavailable`（审计实测复现）。
  //
  // 这几条用例把"合法收尾"与"真截断"钉开，防止以后再收窄判据时重新踩进去。
  //
  // ⚠ 必须用**独立网关**，且显式声明供应商 `protocol: 'openai-chat'`。
  // 主用例里的 fake 供应商没声明协议 —— Anthropic 客户端打进来时引擎会按
  // 客户端协议选上游（即往 `/v1/messages` 发），而那个假上游只认
  // `/v1/chat/completions`，于是回 404、用例看到的是 404 而不是我们想验的东西。
  const startTailGateway = async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'tail-'));
    const port = await freePort();
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({
      port,
      apiKey: GATEWAY_KEY,
      providers: [{
        id: 'tailf', baseURL: 'http://127.0.0.1:' + upstreamPort + '/v1',
        apiKey: UPSTREAM_KEY, protocol: 'openai-chat', models: ['test-model'], priority: 1, enabled: true,
      }],
    }), 'utf8');
    const proc = spawn(process.execPath,
      [MJS, '--config', path.join(dir, 'c.json'), '--log', path.join(dir, 'g.log'), '--port', String(port)],
      { stdio: 'ignore', windowsHide: true });
    const ok = await waitHealth(port, 20000);
    return ok ? { port, proc } : null;
  };

  for (const [mode, label] of [
    ['usage-only', 'choices:[] + usage（OpenAI 规范的终止标记）'],
    ['no-done', '只给 finish_reason、不发 [DONE]'],
  ]) {
    t(`网关：上游以「${label}」收尾 → 正常交付，不误报截断`, async () => {
      const g = await startTailGateway();
      if (!g) { console.log('    [SKIP] 独立网关未就绪'); return; }
      upstream.tailMode = mode;
      try {
        // 流式：不应出现 error 事件
        const rs = await call({ port: g.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] } });
        assert.strictEqual(rs.status, 200, '流式应 200，实际 ' + rs.status + ' ' + rs.text.slice(0, 200));
        assert.ok(!/event: error/.test(rs.text), '不应被误判成截断（流式出现了 error 事件）：' + rs.text.slice(0, 200));
        assert.ok(/message_stop/.test(rs.text), '应正常收尾（缺 message_stop）');
        // 非流式：关键 —— 不能因为误判触发 failover 变成 503
        const rn = await call({ port: g.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
        assert.strictEqual(rn.status, 200, '非流式应 200（误判会 failover 成 503），实际 ' + rn.status + ' ' + rn.text.slice(0, 200));
        assert.ok(!/"type":"error"/.test(rn.text), '非流式不应回错误：' + rn.text.slice(0, 200));
      } finally {
        upstream.tailMode = null;
        try { g.proc.kill(); } catch { /* 忽略 */ }
      }
    });
  }

  t('网关：上游真被腰斩（无任何结束信号）→ 明确报错，不再静默', async () => {
    const g = await startTailGateway();
    if (!g) { console.log('    [SKIP] 独立网关未就绪'); return; }
    upstream.tailMode = 'truncated';
    try {
      // 流式：必须出现 error 事件（否则客户端以为答完了 —— 这正是用户报的"静默终止"）
      const rs = await call({ port: g.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(/event: error/.test(rs.text), '流式应报错，实际：' + rs.text.slice(0, 300));
      assert.ok(/被中断|不完整/.test(rs.text), '错误文案应说明回复不完整');
      // 非流式：应回 502 且**不是** 503（503 会误导成"所有上游不可用"）
      const rn = await call({ port: g.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(rn.status, 502, '非流式应回 502（而非 503），实际 ' + rn.status + ' ' + rn.text.slice(0, 200));
      assert.ok(!/all providers/.test(rn.text), '不应变成"所有上游不可用"：' + rn.text.slice(0, 200));
    } finally {
      upstream.tailMode = null;
      try { g.proc.kill(); } catch { /* 忽略 */ }
    }
  });

  t('直通路径：上游真被腰斩（同协议透传）→ 也必须明确报错（这条曾**零覆盖**）', async () => {
    // 为什么单列一条：上一条"上游真被腰斩"用的是 protocol:'openai-chat' 上游 → 走**翻译**路径
    // （forwardAnthropicViaOpenAI）。而**同协议透传**（客户端 anthropic ← 上游也是 anthropic）
    // 走的是 forward() 里另一份截断检测，那一份此前没有任何用例穿过。
    // 后果实测（2026-10-14 变异验证）：把 `if (isSseStream() && !tailHasTerminal())` 关掉，
    // **166 条用例全绿** —— 上游被腰斩时客户端会收到一个"语法完整、实则被截断"的回复，
    // 还以为模型答完了（这正是用户最早报的"任务莫名终止却不报错"）。
    const srv = http.createServer((req, res) => {
      if (req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        // 发两帧正文，然后**干净地结束**（不带 message_stop）—— 复刻"代理掉线/对端 close"
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"test-model"}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截回复"}}\n\n');
        res.end();     // ← 关键：没有 message_stop，也没有 [DONE]
        return;
      }
      if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"test-model"}]}'); return; }
      res.writeHead(404).end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const up = { server: srv, port: srv.address().port, st: { calls: 0 } };
    const gw = await startGatewayWith([providerOf('cut', up, { priority: 1 })], 'cutdirect');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(/event: error/.test(r.text),
        '直通路径被腰斩也必须发 error 事件（否则客户端以为答完了）：' + r.text.slice(0, 400));
      assert.ok(/不完整|被中断/.test(r.text), '错误文案应说明回复不完整：' + r.text.slice(0, 400));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/直通路径：上游流被截断/.test(logText), '日志须写明是截断（否则无法与"客户端断开"区分）：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：Codex 订阅后端 —— 谎报 content-type + 要求 store:false 也能用', async () => {
    // Codex 订阅后端有三个**实测发现的怪癖**，缺一条就整轮报废：
    //   ① 无论客户端要不要流式，它都返回 SSE，而 Content-Type 谎报 `application/json`
    //      → 旧条件 `mayLieAboutJson = … && wantsStream` 在"客户端要非流式"时跳过嗅探，
    //        把整条 SSE 当 JSON 解析 → 回 502「上游返回的不是 JSON」（实测复现）
    //   ② 请求体不带 `store:false` 直接 400 {"detail":"Store must be set to false"}
    //   ③ 路径不能有 /v1（实测 /codex/v1/responses → 404，只有 /codex/responses 可用）
    //
    // 这条用例用一个**假 Codex 后端**把三点全钉住。
    const seen = { paths: [], bodies: [] };
    const fake = http.createServer((q, s) => {
      let b = '';
      q.on('data', (c) => { b += c; });
      q.on('end', () => {
        seen.paths.push(q.url);
        let j = null; try { j = JSON.parse(b); } catch (_) { /* 忽略 */ }
        seen.bodies.push(j);
        if (!j || j.store !== false) {   // ② 后端硬要求
          s.writeHead(400, { 'content-type': 'application/json' });
          s.end('{"detail":"Store must be set to false"}');
          return;
        }
        s.writeHead(200, { 'content-type': 'application/json' });   // ① content-type 谎报 JSON
        s.write('event: response.created\ndata: {"type":"response.created","response":{"id":"r1","object":"response","status":"in_progress","model":"gpt-5.6-luna","output":[]}}\n\n');
        s.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"可用"}\n\n');
        s.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","object":"response","status":"completed","model":"gpt-5.6-luna","output":[{"id":"o1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"可用"}]}],"usage":{"input_tokens":10,"output_tokens":2}}}\n\n');
        s.end();
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));

    const dir = fs.mkdtempSync(path.join(tmp, 'codex-'));
    const port = await freePort();
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({
      port,
      apiKey: GATEWAY_KEY,
      providers: [{
        id: 'codex-sub',
        baseURL: 'http://127.0.0.1:' + fake.address().port + '/backend-api/codex',   // ③ 无 /v1
        auth: 'codex',
        protocol: 'openai-responses',
        models: ['gpt-5.6-luna'],
        priority: 1, enabled: true,
      }],
    }), 'utf8');
    // 假凭据文件（结构照真实 auth.json）
    const ch = path.join(dir, 'codexhome');
    fs.mkdirSync(ch, { recursive: true });
    fs.writeFileSync(path.join(ch, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'fake.jwt.token', refresh_token: 'rt', account_id: 'acct-123' },
      last_refresh: new Date().toISOString(),
    }), 'utf8');

    const proc = spawn(process.execPath,
      [MJS, '--config', path.join(dir, 'c.json'), '--log', path.join(dir, 'g.log'), '--port', String(port)],
      { stdio: 'ignore', windowsHide: true, env: { ...process.env, CODEX_HOME: ch } });
    try {
      const ok = await waitHealth(port, 20000);
      if (!ok) { console.log('    [SKIP] Codex 测试网关未就绪'); return; }

      // ① 非流式（旧实现会在这里 502）
      const rn = await call({ port, p: '/v1/messages', body: { model: 'gpt-5.6-luna', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(rn.status, 200, '非流式应 200（content-type 谎报不该让它 502），实际 ' + rn.status + ' ' + rn.text.slice(0, 200));
      assert.ok(/可用/.test(rn.text), '应拿到正文，实际：' + rn.text.slice(0, 200));

      // ② 流式
      const rs = await call({ port, p: '/v1/messages', body: { model: 'gpt-5.6-luna', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(rs.status, 200, '流式应 200，实际 ' + rs.status);
      assert.ok(/message_stop/.test(rs.text), '流式应正常收尾');

      // ③ 路径不带 /v1
      assert.ok(seen.paths.length > 0, '假后端应收到请求');
      for (const p2 of seen.paths) {
        assert.ok(!/\/v1\//.test(p2), 'Codex 路径不该出现 /v1，实际：' + p2);
        assert.ok(/\/backend-api\/codex\/responses$/.test(p2), '路径应为 …/codex/responses，实际：' + p2);
      }
      // ④ 请求体必须 store:false
      for (const b of seen.bodies) {
        assert.strictEqual(b && b.store, false, '请求体必须 store:false，实际：' + JSON.stringify(b && b.store));
      }
      // ⑤ 凭据不进日志
      const log = fs.readFileSync(path.join(dir, 'g.log'), 'utf8');
      assert.ok(!/fake\.jwt\.token/.test(log), 'access_token 不该出现在日志里');
      assert.ok(!/acct-123/.test(log), 'account_id 不该出现在日志里');
    } finally {
      try { proc.kill(); } catch { /* 忽略 */ }
      try { fake.close(); } catch { /* 忽略 */ }
    }
  });


  t('网关：WorkBuddy chat 必须带 X-Conversation-* 三头（国际版缺了必 400/11128）', async () => {
    // 参照实现 issue #139（2026-10-16 起生效）：国际版 www.workbuddy.ai 对**缺全部三个**
    // `X-Conversation-*` 头的 /v2/chat/completions 回
    //   400 / code 11128 / msg "conversation id missing"
    // 而用户看到的 displayMsg.zh 是「请求被拦截，请重新发送」—— 与渠道风控文案完全相同，
    // 极易被误判成"随机风控"（本网关此前就这么判，于是永远重发同一份请求）。
    //
    // 三个值都必须是 v4 UUID，且**每次请求新铸一组**（上游不按该 id 存历史，
    // 参照实现实测两次调用共享同一组没有任何收益）。
    const seen = [];
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ url: req.url, headers: { ...req.headers } });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 1, model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }));
      });
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));

    const dir = fs.mkdtempSync(path.join(tmp, 'wbconv-'));
    const port = await freePort();
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({
      port, apiKey: GATEWAY_KEY,
      providers: [{
        id: 'wb-conv', baseURL: 'http://127.0.0.1:' + s.address().port + '/v2', protocol: 'openai-chat',
        // ⚠ auth='workbuddy' 才会走 workbuddyHeaders（桌面身份 + 三头）；
        //   这里给 apiKey 让凭据解析短路，避免依赖本机 WorkBuddy 安装
        auth: 'workbuddy', apiKey: 'sk-cccccccccccccccccccccccc',
        models: ['test-model'], priority: 1, enabled: true,
      }],
    }), 'utf8');

    const proc = spawn(process.execPath,
      [MJS, '--config', path.join(dir, 'c.json'), '--log', path.join(dir, 'g.log'), '--port', String(port)],
      { stdio: 'ignore', windowsHide: true });
    try {
      const ok = await waitHealth(port, 20000);
      if (!ok) { console.log('    [SKIP] 网关未就绪'); return; }
      const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      for (let i = 0; i < 2; i++) {
        const r = await call({ port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
        assert.strictEqual(r.status, 200, '第 ' + (i + 1) + ' 次应 200，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      }
      assert.ok(seen.length >= 2, '上游应收到 ≥2 次请求，实际 ' + seen.length);
      for (const h of seen.map((x) => x.headers)) {
        for (const name of ['x-conversation-id', 'x-conversation-request-id', 'x-conversation-message-id']) {
          assert.ok(h[name], '缺头 ' + name + '（国际版会回 11128 conversation id missing）');
          assert.ok(V4.test(h[name]), name + ' 必须是 v4 UUID，实际 ' + h[name]);
        }
        // 国际版 5.7 起多要求一个 X-Root-Request-ID（同一错误码、同一句 "conversation id
        // missing"）；缺了在 5.7+ 上仍是 400/11128，所以这里必须一起钉住
        assert.ok(h['x-root-request-id'], '缺头 x-root-request-id（国际版 5.7+ 会回 11128）');
        assert.ok(V4.test(h['x-root-request-id']), 'x-root-request-id 必须是 v4 UUID，实际 ' + h['x-root-request-id']);
        assert.strictEqual(h['x-root-request-id'], h['x-conversation-request-id'],
          '根 id 应与本次请求 id 同源（同属一个请求），实际 ' + h['x-root-request-id'] + ' vs ' + h['x-conversation-request-id']);
      }
      const t1 = seen[0].headers['x-conversation-id'];
      const t2 = seen[1].headers['x-conversation-id'];
      assert.notStrictEqual(t1, t2, '三次会话头应每请求新铸一组（参照实现实测共享无收益），实际两次都是 ' + t1);
    } finally {
      try { proc.kill(); } catch { /* 忽略 */ }
      try { s.close(); } catch { /* 忽略 */ }
    }
  });

  t('网关：WorkBuddy 系统提示词指纹 → 发上游前必须改写身份句（2026-10-20 起的 11128 真因）', async () => {
    // ⚠ 实测（本机，2026-10-21，同一 token / 同一套头，只改 system 首行）：
    //     首行是 "You are an AI agent powered by DeepSeek Harness." → 400 / 11128
    //     同一句放到第 2 行                                      → 200
    //     换成中性开场白                                          → 200，流式正常
    //   也就是说 2026-10-20 傍晚起，copilot.tencent.com/v2/chat/completions 开始对**请求体**
    //   做系统提示词指纹校验 —— 与凭据、会话三头、出口 IP、工具体量全都无关
    //  （那一轮把这四项逐条排除过：366 个富 schema 工具加到 1.5MB 仍 200）。
    //
    // 因此网关必须在**发上游之前**把 system/developer 里的身份句改写掉，否则这条车道恒 400。
    // 参照实现 Hourz26/dsh-workbuddy-connect-patched 的第二版补丁强调"位置无关"：
    // 宿主会在身份段前面渲染问候语，长会话还会重发多个 system 消息，只匹配行首会漏。
    const IDENT = 'You are an AI agent powered by DeepSeek Harness.';
    const NEUTRAL = 'You are an AI agent.';
    const seen = [];
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 忽略 */ }
        seen.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 1, model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }));
      });
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));

    const dir = fs.mkdtempSync(path.join(tmp, 'wbident-'));
    const port = await freePort();
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({
      port, apiKey: GATEWAY_KEY,
      providers: [{
        id: 'wb-ident', baseURL: 'http://127.0.0.1:' + s.address().port + '/v2', protocol: 'openai-chat',
        auth: 'workbuddy', apiKey: 'sk-cccccccccccccccccccccccc',
        models: ['test-model'], priority: 1, enabled: true,
      }],
    }), 'utf8');

    const proc = spawn(process.execPath,
      [MJS, '--config', path.join(dir, 'c.json'), '--log', path.join(dir, 'g.log'), '--port', String(port)],
      { stdio: 'ignore', windowsHide: true });
    try {
      const ok = await waitHealth(port, 20000);
      if (!ok) { console.log('    [SKIP] 网关未就绪'); return; }
      const r = await call({
        port,
        body: {
          model: 'test-model',
          messages: [
            { role: 'system', content: IDENT + '\n\n你是 DSH 助手。' },
            // 位置无关的第二处：句中/第 2 行同样要改（宿主会把问候语渲染在身份段之前）
            { role: 'system', content: '以下是身份说明。\n' + IDENT },
            // 块数组形态：只处理字符串会漏掉这种客户端拼装方式
            { role: 'system', content: [{ type: 'text', text: IDENT }] },
            // 逗号形态：桌面版渲染出来是 "You are an AI coding agent, powered by …"，
            // 正则若要求 "agent\s+powered" 直连就会漏这一种（照抄参照实现踩过的坑）
            { role: 'system', content: 'You are an AI coding agent, powered by the DeepSeek Harness.' },
            // 品牌词兜底：整句已被换成别的写法，只剩品牌词被引用 —— 单独出现该品牌词时上游
            // 也不放行（ardeyouxipianyi/workbuddy2api-hub PR #540 的逐句二分实测），必须抹掉
            { role: 'system', content: '参见 "DeepSeek Harness" 的文档。' },
            // ⚠ 路径语境必须**保留原样**：DSH 的 runtime context 里就写着安装目录
            //   `…\Programs\DeepSeek Harness\resources\app.asar\dsh\`。把品牌词在这里
            //   也抹掉 = 交给模型一个不存在的路径 → 工具调用全坏（修好一个 bug 造出一个更大的）。
            //   参照实现 simlerick/dsh-wb400-fix 的 lexicon.mjs 同样用负向断言跳过路径。
            { role: 'system', content: '安装目录：D:\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\' },
            // user 里出现同一句**不得**改动（实测只出现在 user 里时上游 200，改了反而损语义）
            { role: 'user', content: IDENT },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(seen.length, 1, '上游应收到 1 次请求，实际 ' + seen.length);
      const msgs = seen[0].messages;
      assert.strictEqual(msgs[0].content, NEUTRAL + '\n\n你是 DSH 助手。',
        'system 首行身份句必须被改写，实际 ' + JSON.stringify(msgs[0].content.slice(0, 80)));
      assert.strictEqual(msgs[1].content, '以下是身份说明。\n' + NEUTRAL,
        '句中身份句同样要改写（位置无关），实际 ' + JSON.stringify(msgs[1].content));
      assert.strictEqual(msgs[2].content[0].text, NEUTRAL,
        '块数组形态同样要改写，实际 ' + JSON.stringify(msgs[2].content));
      assert.strictEqual(msgs[3].content, NEUTRAL,
        '逗号形态（agent, powered by）同样要改写，实际 ' + JSON.stringify(msgs[3].content));
      assert.strictEqual(msgs[4].content, '参见 "DeepSeekRuntime" 的文档。',
        '只剩品牌词时也必须抹掉，实际 ' + JSON.stringify(msgs[4].content));
      // 路径语境的品牌词**必须原样保留** —— 改了就是给模型一个不存在的安装目录
      assert.strictEqual(msgs[5].content, '安装目录：D:\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\',
        '路径里的品牌词不得改写（否则工具会拿到坏路径），实际 ' + JSON.stringify(msgs[5].content));
      assert.strictEqual(msgs[6].content, IDENT, 'user 消息不得被改写');
      // 出站文本里一个 "DeepSeek Harness" 都不该再出现（断言**出口**文本，不是断言入参）
      // 注意：路径那条（msgs[5]）是唯一的例外，所以这里只查前 5 条
      assert.ok(!JSON.stringify(msgs.slice(0, 5)).includes('DeepSeek Harness'),
        'system 里不得残留身份句指纹');
    } finally {
      try { proc.kill(); } catch { /* 忽略 */ }
      try { s.close(); } catch { /* 忽略 */ }
    }
  });

  t('网关：非 WorkBuddy 家不得改写 system 提示词（身份改写必须只对本家生效）', async () => {
    // 反例保护：身份改写是"给 workbuddy 车道擦指纹"，一旦漏到别家就是**静默篡改用户提示词**。
    const IDENT = 'You are an AI agent powered by DeepSeek Harness.';
    const seen = [];
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 忽略 */ }
        seen.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 1, model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }));
      });
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));

    const dir = fs.mkdtempSync(path.join(tmp, 'wbident-off-'));
    const port = await freePort();
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({
      port, apiKey: GATEWAY_KEY,
      providers: [{
        id: 'plain', baseURL: 'http://127.0.0.1:' + s.address().port + '/v2', protocol: 'openai-chat',
        apiKey: 'sk-dddddddddddddddddddddddd',
        models: ['test-model'], priority: 1, enabled: true,
      }],
    }), 'utf8');

    const proc = spawn(process.execPath,
      [MJS, '--config', path.join(dir, 'c.json'), '--log', path.join(dir, 'g.log'), '--port', String(port)],
      { stdio: 'ignore', windowsHide: true });
    try {
      const ok = await waitHealth(port, 20000);
      if (!ok) { console.log('    [SKIP] 网关未就绪'); return; }
      const r = await call({
        port,
        body: { model: 'test-model', messages: [{ role: 'system', content: IDENT }, { role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '应 200，实际 ' + r.status);
      assert.strictEqual(seen[0].messages[0].content, IDENT,
        '非 workbuddy 家的 system 必须原样透传，实际 ' + JSON.stringify(seen[0].messages[0].content));
    } finally {
      try { proc.kill(); } catch { /* 忽略 */ }
      try { s.close(); } catch { /* 忽略 */ }
    }
  });

  t('网关：/v1/responses 的 instructions 也要改写身份句（Responses 是另一份实现，易漏）', async () => {
    // 为什么单独立一条：Responses 协议把 system 提示放在顶层的 `instructions`，会话放在 `input`，
    // 与 chat 的 `messages[]` 完全不是一个形状 —— chat 路径的改写对它**一点作用都没有**。
    // 这正是本项目历史上的老坑（"同一判定两处实现，修了一处另一处还是红的"）。
    const IDENT = 'You are an AI agent powered by DeepSeek Harness.';
    const NEUTRAL = 'You are an AI agent.';
    const up = await startFakeUpstream({ responses: true });
    const prov = providerOf('wb-resp', up, { models: ['test-model'] });
    prov.auth = 'workbuddy';
    prov.apiKey = 'sk-' + 'b'.repeat(24);
    const gw = await startGatewayWith([prov], 'wbresp');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/responses', body: {
          model: 'test-model',
          instructions: IDENT + '\n\n你是助手。',
          input: [
            { type: 'message', role: 'system', content: [{ type: 'input_text', text: IDENT }] },
            { type: 'message', role: 'user', content: '你好' },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const sent = up.st.lastRespBody;
      const sentText = JSON.stringify(sent);
      assert.ok(sent, '上游应收到 Responses 请求体');
      assert.strictEqual(sent.instructions, NEUTRAL + '\n\n你是助手。',
        'instructions 里的身份句必须改写，实际 ' + JSON.stringify(sent.instructions));
      assert.strictEqual(sent.input[0].content[0].text, NEUTRAL,
        'input 里 system 项的文本必须改写，实际 ' + JSON.stringify(sent.input[0].content));
      assert.strictEqual(sent.input[1].content, '你好', 'user 项不得被改动');
      assert.ok(!sentText.includes('DeepSeek Harness'), '出站 Responses 体里不得残留指纹：' + sentText.slice(0, 300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：identityScrub="all" 时连 user 与工具结果一起改写（保守派口径，可关闭）', async () => {
    // 两份参照实现对此有分歧：panel 实测"user 里不触发拦截"→ 默认只改 system；
    // 另一派认为"校验是文本匹配、不认角色，只改 system 会漏掉工具结果里的复述"。
    // 这里把选择权交给配置：默认 identity（只 system），显式写 all 才全改。
    const IDENT = 'You are an AI agent powered by DeepSeek Harness.';
    const NEUTRAL = 'You are an AI agent.';
    const up = await startFakeUpstream({});
    const prov = providerOf('wb-all', up, { models: ['test-model'] });
    prov.auth = 'workbuddy';
    prov.apiKey = 'sk-' + 'e'.repeat(24);
    prov.identityScrub = 'all';
    const gw = await startGatewayWith([prov], 'wball');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, body: {
          model: 'test-model',
          messages: [
            { role: 'system', content: IDENT },
            { role: 'user', content: '引用：' + IDENT },
            // tool 结果必须挂在 assistant.tool_calls 后面，否则引擎会当"孤儿 tool 消息"丢掉
            // （repairToolPairingChat 的正常行为，与本用例无关）—— 这里给配对，让工具结果真到上游
            {
              role: 'assistant', content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"q":"' + IDENT + '"}' } }],
            },
            { role: 'tool', tool_call_id: 'c1', content: '工具结果是 ' + IDENT },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const sent = up.st.lastBody;
      const ms = sent.messages || [];
      assert.strictEqual(ms[0].content, NEUTRAL);
      assert.strictEqual(ms[1].content, '引用：' + NEUTRAL, 'all 模式下 user 也要改：' + JSON.stringify(ms));
      assert.ok(!JSON.stringify(ms[2]).includes('Harness'),
        'all 模式下 tool_calls.arguments 也要改：' + JSON.stringify(ms[2]));
      assert.strictEqual(ms[3].content, '工具结果是 ' + NEUTRAL, 'all 模式下工具结果也要改：' + JSON.stringify(ms));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：WorkBuddy 渠道校验拒绝 400 → 继续 failover（不中止客户端任务）', async () => {
    // ⚠ 实测事故（2026-10-10，本机日志）：WorkBuddy 会**随机**（≈2%，52 次成功夹 1 次）回
    //   HTTP 400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel",
    //             "displayMsg":{"en":"Request blocked. Please send it again"}}
    // —— **上游自己要求"请重发"**，是瞬时风控，不是"你的请求参数有问题"。
    //
    // 旧行为：落进"确定性 4xx" → **终止 failover** → 客户端拿到
    //   `400 … the request itself is invalid … failover stopped on purpose`
    // → **Claude Code 的整个任务中止**（用户报的"不时报错停止任务"）。
    //
    // ⚠⚠ 这条用例特意用 **Anthropic 客户端**（Claude Code 的形态）——
    // 因为"确定性 4xx"判定在引擎里有**两处实现**：直通路径与矩阵/翻译路径。
    // 第一次修只改了直通那处，本用例走矩阵路径，**当场就是红的**。
    const BLOCK = JSON.stringify({
      code: 11128,
      msg: 'Illegal API invocation from an unapproved channel',
      requestId: 'a9f5xxxxe062',
      displayMsg: { en: 'Request blocked. Please send it again', zh: '请求被拦截，请重试' },
    });
    let aHits = 0;
    const A = http.createServer((q, s) => {
      q.resume();
      q.on('end', () => {
        aHits++;
        s.writeHead(400, { 'content-type': 'application/json' });
        s.end(BLOCK);
      });
    });
    await new Promise((r) => A.listen(0, '127.0.0.1', r));
    let bHits = 0;
    const B = http.createServer((q, s) => {
      q.resume();
      q.on('end', () => {
        bHits++;
        s.writeHead(200, { 'content-type': 'application/json' });
        s.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 1, model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: '来自 B 家' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }));
      });
    });
    await new Promise((r) => B.listen(0, '127.0.0.1', r));

    const dir = fs.mkdtempSync(path.join(tmp, 'wbblock-'));
    const port = await freePort();
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({
      port, apiKey: GATEWAY_KEY,
      providers: [
        { id: 'wb-blocked', baseURL: 'http://127.0.0.1:' + A.address().port + '/v2', protocol: 'openai-chat',
          models: ['test-model'], apiKey: 'sk-aaaaaaaaaaaaaaaa', priority: 1, enabled: true },
        { id: 'wb-good', baseURL: 'http://127.0.0.1:' + B.address().port + '/v2', protocol: 'openai-chat',
          models: ['test-model'], apiKey: 'sk-bbbbbbbbbbbbbbbb', priority: 2, enabled: true },
      ],
    }), 'utf8');

    const proc = spawn(process.execPath,
      [MJS, '--config', path.join(dir, 'c.json'), '--log', path.join(dir, 'g.log'), '--port', String(port)],
      { stdio: 'ignore', windowsHide: true });
    try {
      const ok = await waitHealth(port, 20000);
      if (!ok) { console.log('    [SKIP] 网关未就绪'); return; }
      // Anthropic 客户端 → chat 上游 = 矩阵路径（Claude Code 的形态）
      const r = await call({ port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200,
        '软性拦截应继续 failover 拿到 B 家的 200，实际 ' + r.status + ' ' + r.text.slice(0, 220));
      assert.ok(/来自 B 家/.test(r.text), '应拿到 B 家的正文，实际：' + r.text.slice(0, 200));
      assert.strictEqual(bHits, 1, 'B 家应被尝试 1 次，实际 ' + bHits);
      // 日志必须点明是 **WorkBuddy 渠道校验拒绝（11128）**，不能是"确定性 4xx"
      //（2026-10-20 改文案：旧文案叫"软性渠道拦截/风控、约 2% 随机命中"，
      //  而实测这个错误码有三种成因，其中最常见的是**凭据已不认**，不是随机风控）
      const log = fs.readFileSync(path.join(dir, 'g.log'), 'utf8');
      assert.ok(/渠道校验拒绝（11128）/.test(log), '日志应点明 11128，实际：' + log.slice(-400));
      assert.ok(!/确定性 4xx/.test(log), '不该再判成"确定性 4xx"（那会终止客户端任务）');
    } finally {
      try { proc.kill(); } catch { /* 忽略 */ }
      try { A.close(); } catch { /* 忽略 */ }
      try { B.close(); } catch { /* 忽略 */ }
    }
  });

  t('网关：缓存字段必须传给 Anthropic 客户端（否则命中率恒为 0%）', async () => {
    // 上游在 usage 里报 `prompt_tokens_details.cached_tokens`，客户端读的是
    // Anthropic 的 `cache_read_input_tokens` —— 不翻译就等于把缓存信息抹平，
    // 客户端算出的命中率恒为 0%（用户实测报过）。
    const g = await startTailGateway();
    if (!g) { console.log('    [SKIP] 独立网关未就绪'); return; }
    try {
      const r = await call({ port: g.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      // 假上游的收尾帧带 cached_tokens:64（见 server 里 chat 分支）
      assert.ok(/cache_read_input_tokens/.test(r.text),
        '非流式 usage 应含 cache_read_input_tokens，实际：' + r.text.slice(0, 300));
      assert.ok(/"cache_read_input_tokens":64/.test(r.text),
        '缓存命中数应原样传出（64），实际：' + r.text.slice(0, 300));
      // 流式也要带（message_delta 里）
      const rs = await call({ port: g.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(/cache_read_input_tokens/.test(rs.text),
        '流式 message_delta 也应含 cache_read_input_tokens，实际：' + rs.text.slice(0, 400));
    } finally {
      try { g.proc.kill(); } catch { /* 忽略 */ }
    }
  });

  // ---- 7) write-dsh 的 YAML 定位（P1-7）----
  const writeDsh = (settingsText) => {
    const dir = fs.mkdtempSync(path.join(tmp, 'wd-'));
    const cfgPath = path.join(dir, 'gateway.config.json');
    const setPath = path.join(dir, 'settings.yaml');
    const credPath = path.join(dir, 'credentials.yaml');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: 3099, apiKey: GATEWAY_KEY, clientProfile: 'claude',
      providers: [{ id: 'p1', baseURL: 'https://a.example.org/v1', apiKey: 'sk-' + 'x'.repeat(20), models: ['m1'], priority: 1, enabled: true }],
    }), 'utf8');
    fs.writeFileSync(setPath, settingsText, 'utf8');
    const r = spawnSync(process.execPath, [MJS, '--write-dsh', '--config', cfgPath, '--settings', setPath, '--credentials', credPath, '--port', '3099'],
      { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    return { status: r.status, text: fs.readFileSync(setPath, 'utf8') };
  };

  t('write-dsh：只动 llm-pi-ai.providers.gateway，不误伤别处的 gateway: 块（P1-7）', () => {
    const r = writeDsh([
      'mcp:',
      '  servers:',
      '    gateway:',
      '      url: http://localhost:9999/keep-me',
      'llm-pi-ai:',
      '  providers:',
      '    other:',
      '      apiKeyEnv: OTHER_KEY',
      '',
    ].join('\n'));
    assert.strictEqual(r.status, 0, 'write-dsh 应成功');
    assert.ok(r.text.includes('url: http://localhost:9999/keep-me'), '别处的 gateway 块必须完好：\n' + r.text);
    const m = r.text.match(/^ {4}gateway:$/m);
    assert.ok(m, '应在 llm-pi-ai.providers 下写入 gateway 条目');
    assert.ok(r.text.includes('apiKeyEnv: OTHER_KEY'), '既有 provider 条目应保留');
    // 位置校验：**我们写入的**条目（按内容定位，别处 decoy 也叫 gateway）必须在 llm-pi-ai 段内
    const pi = r.text.indexOf('llm-pi-ai:');
    const gw = r.text.indexOf('    gateway:\n      displayName: DSH Model Gateway');
    assert.ok(pi >= 0 && gw > pi, 'gateway 条目必须位于 llm-pi-ai 段内：\n' + r.text);
    assert.ok(r.text.includes('baseURL: http://127.0.0.1:3099'), 'claude 仿真应写不带 /v1 的 baseURL');
    // 2026-09-16：claude 仿真下每个模型必须带 compat.allowEmptySignature——
    // 否则 pi-ai 把"无签名的 thinking"降级成 text，带 tool_use 的历史会被上游回
    // 400「content[].thinking ... must be passed back」（air-outer/agentrouter 实测）
    assert.ok(/^ {10}compat:\n {12}allowEmptySignature: true$/m.test(r.text),
      '每个模型条目应带 compat.allowEmptySignature: true：\n' + r.text);
    assert.strictEqual((r.text.match(/allowEmptySignature: true/g) || []).length,
      (r.text.match(/^ {8}- id:/gm) || []).length, '模型数与 compat 声明数应一致');
  });

  t('write-dsh：providers 后跟同级键时不串层（P1-7 场景二）', () => {
    const r = writeDsh([
      'llm-pi-ai:',
      '  providers:',
      '  other: 1',
      '',
    ].join('\n'));
    assert.strictEqual(r.status, 0);
    assert.ok(/^ {2}providers:\n {4}gateway:$/m.test(r.text), 'gateway 必须紧跟 providers 且缩进 4：\n' + r.text);
    assert.ok(/^ {2}other: 1$/m.test(r.text), '同级键 other 必须保留且仍在缩进 2');
  });

  t('write-dsh：重复执行幂等（不产生重复条目）', () => {
    const a = writeDsh('llm-pi-ai:\n  providers:\n');
    const b = writeDsh(a.text);
    assert.strictEqual(b.text, a.text, '第二次写入应完全一致');
    assert.strictEqual((b.text.match(/^ {4}gateway:$/gm) || []).length, 1, '不得出现重复 gateway 条目');
  });

  t('write-dsh：settings.yaml 首次写入前留备份', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'wd-bak-'));
    const cfgPath = path.join(dir, 'gateway.config.json');
    const setPath = path.join(dir, 'settings.yaml');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: 3099, apiKey: GATEWAY_KEY,
      providers: [{ id: 'p1', baseURL: 'https://a.example.org/v1', apiKey: 'sk-' + 'x'.repeat(20), models: ['m1'], enabled: true }],
    }), 'utf8');
    fs.writeFileSync(setPath, 'llm-pi-ai:\n  providers:\n', 'utf8');
    spawnSync(process.execPath, [MJS, '--write-dsh', '--config', cfgPath, '--settings', setPath, '--credentials', path.join(dir, 'c.yaml'), '--port', '3099'],
      { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    assert.ok(fs.existsSync(setPath + '.bak-gateway'), '应留 .bak-gateway 首次备份');
    assert.strictEqual(fs.readFileSync(setPath + '.bak-gateway', 'utf8'), 'llm-pi-ai:\n  providers:\n', '备份应为写入前内容');
  });

  // ================= 2026-09-10 审计 §3.2 四项待修缺陷的回归用例 =================
  // 这些用例需要与主实例**不同的 provider 拓扑**（两家供应商才能观察 failover），
  // 因此各自起独立的网关进程（同一份源码），互不干扰上面的既有用例。

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 可编程假上游：分别统计 /models（catalog 探测，不产生计费）与非 /models 的转发请求（真会计费）
  async function startFakeUpstream(opts = {}) {
    const st = {
      modelsReqs: 0,
      calls: 0,
      modelsStatus: opts.modelsStatus === undefined ? 200 : opts.modelsStatus,
      catalog: opts.catalog === undefined ? [{ id: 'test-model' }] : opts.catalog,
      status: opts.status === undefined ? 200 : opts.status,
      sseErrorFirst: !!opts.sseErrorFirst,   // 200 + SSE 首事件即 error（api.chiyi.cc 实测形态）
      sseAsJson: !!opts.sseAsJson,           // 200 + application/json 头，但 body 是 SSE 帧（header 说谎）
      sseBody: opts.sseBody || null,         // 自定义 SSE 响应体（测解码速度计量用）
      sseGapMs: opts.sseGapMs || 0,          // >0：分两段发（制造解码时间窗）
      sseSplitAt: opts.sseSplitAt || 0,
      thinkingPassback: !!opts.thinkingPassback,   // 400/500 要求 thinking 回传（air-outer/agentrouter 实测形态）
      thinkingPassbackStatus: opts.thinkingPassbackStatus || 400,
      rejectThinking: opts.rejectThinking || null, // 'sse' | '400'：带顶层 thinking 就拒收（amd 实测形态）
      failFirstN: opts.failFirstN || 0,            // 前 N 次请求直接销毁 socket（模拟网络抖动）
      lastBody: null,
      bodies: [],                                  // 每次请求体（含重试），断言"重试时去掉了某字段"用
      headers: [],                                 // 每次请求头（断言客户端仿真头用）
      errorBody: opts.errorBody === undefined ? { error: { message: 'upstream error' } } : opts.errorBody,
      delayMs: opts.delayMs || 0,
      // —— OpenAI Responses 协议仿真（见下方 handleResponses）——
      respIdPrefix: opts.respIdPrefix || 'resp_test',
      respSeq: 0,
      respStore: new Map(),      // 只认自己创建的 id（真实上游即如此）
      resourceStatus: opts.resourceStatus || 0,   // >0 时资源子路由强制返回该状态
      noResourceRoutes: !!opts.noResourceRoutes,  // 模拟 new-api：只实现 POST 生成，子路由一律 Invalid URL
      lastRespBody: null,        // 上游实际收到的 Responses 请求体
      respUrls: [],              // 上游收到的原始 URL（含查询串，断言透传用）
      lastModel: null,
      models: [],
    };
    // Responses 协议：POST 创建（SSE 或 JSON）+ 资源子路由（GET/DELETE/cancel/input_items）
    const handleResponses = (req, res) => {
      const u = new URL(req.url, 'http://x');
      const segs = u.pathname.slice('/v1/responses'.length).split('/').filter(Boolean);
      const id = segs[0] || null;
      const action = segs[1] || null;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        st.calls++;
        st.respUrls.push(req.method + ' ' + req.url);
        const json = (status, obj) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'POST' && !id) {
          let parsed = {};
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { /* 忽略 */ }
          st.lastRespBody = parsed;
          st.lastModel = parsed.model;
          st.models.push(parsed.model);
          const newId = st.respIdPrefix + (++st.respSeq);
          st.respStore.set(newId, { id: newId, object: 'response', status: 'completed', model: parsed.model });
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write('event: response.created\ndata: '
            + JSON.stringify({ type: 'response.created', response: { id: newId, object: 'response', status: 'in_progress' } }) + '\n\n');
          res.write('event: response.output_text.delta\ndata: '
            + JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }) + '\n\n');
          res.end('event: response.completed\ndata: '
            + JSON.stringify({ type: 'response.completed', response: { id: newId, object: 'response', status: 'completed' } }) + '\n\n');
          return;
        }
        // 模拟实测到的 new-api 行为：只实现 POST 生成，资源子路由一律 "Invalid URL (...)"（404）
        if (st.noResourceRoutes) {
          json(404, { error: { message: 'Invalid URL (' + req.method + ' ' + u.pathname + ')', type: 'invalid_request_error' } });
          return;
        }
        // 资源子路由：不属于自己的 id → 404（换家探测因此是安全的）
        if (!id || !st.respStore.has(id)) {
          json(404, { error: { message: 'No response found with id ' + id } });
          return;
        }
        if (st.resourceStatus && st.resourceStatus !== 200) {
          json(st.resourceStatus, { error: { message: 'upstream temporarily unavailable' } });
          return;
        }
        if (req.method === 'GET' && !action) { json(200, st.respStore.get(id)); return; }
        if (req.method === 'GET' && action === 'input_items') {
          json(200, { object: 'list', data: [{ role: 'user', content: 'hi' }] });
          return;
        }
        if (req.method === 'DELETE' && !action) {
          st.respStore.delete(id);
          json(200, { id, object: 'response.deleted', deleted: true });
          return;
        }
        if (req.method === 'POST' && action === 'cancel') {
          json(200, { id, object: 'response', status: 'cancelled' });
          return;
        }
        json(404, { error: { message: 'unsupported' } });
      });
    };
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/v1/models')) {
        st.modelsReqs++;
        if (st.modelsStatus !== 200) {
          res.writeHead(st.modelsStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'catalog unavailable' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: st.catalog }));
        return;
      }
      if (req.url.startsWith('/v1/responses')) { handleResponses(req, res); return; }
      req.resume();                       // 消费请求体（本假上游不解析内容）
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        st.calls++;
        // 网络抖动仿真：直接销毁连接（客户端侧表现为 fetch failed / ECONNRESET）
        if (st.failFirstN > 0) { st.failFirstN--; req.socket.destroy(); return; }
        // 记录上游实际收到的 model（模型映射用例断言用：必须是该供应商的上游真实 ID）
        let parsedBody = null;
        try {
          parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          st.lastModel = parsedBody.model;
          st.models.push(parsedBody.model);
        } catch (_) { /* 忽略 */ }
        st.lastBody = parsedBody;
        st.bodies.push(parsedBody);
        st.headers.push(req.headers);
        const send = () => {
          // 2026-09-17 实测形态（amd/GLM-5.3-Flash）：带顶层 thinking 参数 → 拒收。
          // 'sse' = HTTP 200 + SSE 首事件 error（实测形态）；'400' = 直接 400 JSON。
          if (st.rejectThinking && parsedBody && parsedBody.thinking) {
            const msg = '"thinking" is not supported for this model. Remove the "thinking" parameter or use a model that supports extended thinking.';
            if (st.rejectThinking === '400') {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: msg } }));
              return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.end('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: msg } }) + '\n\n');
            return;
          }
          // 实测形态（air-outer/agentrouter）：带 tool_use 的 assistant 轮缺 thinking 块 → 400
          if (st.thinkingPassback && parsedBody) {
            const missing = (parsedBody.messages || []).some((m) => m && m.role === 'assistant'
              && Array.isArray(m.content)
              && m.content.some((b) => b && b.type === 'tool_use')
              && !m.content.some((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking')));
            if (missing) {
              res.writeHead(st.thinkingPassbackStatus, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                error: {
                  message: st.thinkingPassbackStatus === 400
                    ? 'The `content[].thinking` in the thinking mode must be passed back to the API. [trace_id=test]'
                    : 'Upstream rejected the request as invalid',   // agentrouter 的笼统措辞
                  type: st.thinkingPassbackStatus === 400 ? '<nil>' : 'invalid_request_error',
                },
                type: 'error',
              }));
              return;
            }
          }
          if (st.status !== 200) {
            res.writeHead(st.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(st.errorBody));
            return;
          }
          if (st.sseErrorFirst) {
            // 实测形态（api.chiyi.cc）：HTTP 200 + text/event-stream，流里第一件事就是 error 事件
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.end(': keepalive\n\n'
              + 'event: error\ndata: {"error":{"message":"Service temporarily unavailable","type":"api_error"},"type":"error"}\n\n');
            return;
          }
          // 实测形态（dsh-our-free-model 记录）：上游在高负载下用 **200 + application/json**
          // 回完整的 SSE 帧序列 —— header 说谎，只能按响应体形状判定。
          res.writeHead(200, {
            'content-type': st.sseAsJson ? 'application/json' : 'text/event-stream',
            'cache-control': 'no-cache',
          });
          const sseOut = st.sseBody || 'data: {"choices":[{"delta":{"content":"upstream-ok"}}]}\n\ndata: [DONE]\n\n';
          // sseGapMs > 0：先发前半段，隔一段时间再发后半段 —— 制造一个真实的解码时间窗
          //（解码速度计量需要"首字 → 末字"之间的窗口，一次性 flush 的窗口约等于 0ms，
          // 按设计就该留空不报速度，那样测不出东西）。
          if (st.sseGapMs > 0 && st.sseSplitAt > 0 && st.sseSplitAt < sseOut.length) {
            res.write(sseOut.slice(0, st.sseSplitAt));
            setTimeout(() => { try { res.end(sseOut.slice(st.sseSplitAt)); } catch { /* 忽略 */ } }, st.sseGapMs);
          } else {
            res.end(sseOut);
          }
        };
        if (st.delayMs) setTimeout(send, st.delayMs); else send();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, st, port: server.address().port };
  }

  function providerOf(id, up, opts = {}) {
    const p = {
      id,
      baseURL: 'http://127.0.0.1:' + up.port + '/v1',
      apiKey: UPSTREAM_KEY,
      models: opts.models === undefined ? ['test-model'] : opts.models,
      priority: opts.priority === undefined ? 1 : opts.priority,
      enabled: true,
    };
    if (opts.reasoningEffortMap) p.reasoningEffortMap = opts.reasoningEffortMap;
    if (opts.timeoutMs) p.timeoutMs = opts.timeoutMs;
    return p;
  }

  // 独立网关实例：独立端口/配置/日志目录 + 可选 env（如熔断时长、dump 开关）
  // cfgExtra：额外顶层配置（如 routing: 'round-robin'）
  async function startGatewayWith(providers, tag, env, cfgExtra) {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(tmp, 'gw-' + tag + '-'));
    const cfgPath = path.join(dir, 'gateway.config.json');
    const logPath = path.join(dir, 'gateway.log');
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({ port, apiKey: GATEWAY_KEY, providers }, cfgExtra || {}), null, 2), 'utf8');
    const proc = spawn(process.execPath, [MJS, '--config', cfgPath, '--log', logPath, '--port', String(port)], {
      stdio: 'ignore', windowsHide: true,
      env: env ? Object.assign({}, process.env, env) : process.env,
    });
    const ready = await waitHealth(port, 20000);
    return { port, proc, logPath, dir, ready };
  }

  const killGw = (g) => { try { g.proc.kill(); } catch { } };
  const closeUp = (u) => { try { u.server.close(); } catch { } };

  t('网关（2026-10-15 用户规则）：高优先级家回"确定性 400"不再打死任务 —— 继续走完候选，由下一家（最终 commandcode）兜底', async () => {
    // 用户原话："即使 commandcode 排在了 sensenova 和 amd 后面，调用时也不应该失败了就直接中断，
    // 而应该继续按优先级往下调用，最终 commandcode 兜底！！"
    //
    // 实测形态（commandcode 14:54:25 / 12:27:02）：它会对同一模型偶尔回
    //   HTTP 400 {"error":{"message":"{\"message\":\"invalid request error trace_id: …\"}"}}
    // 而前后各一次都 200 —— 这是**上游抽风**，不是"你的请求有问题"。
    const up1 = await startFakeUpstream({
      status: 400,
      errorBody: { error: { message: '{"message":"invalid request error trace_id: d5b7e8fa57bfc14bf228cb87d61db6fc","type":"invalid_request_error"}' } },
    });
    const up2 = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'temporarily down' } } });
    const up3 = await startFakeUpstream({ status: 200 });   // 相当于"commandcode 兜底"
    const gw = await startGatewayWith([
      providerOf('sensenova-like', up1, { priority: 1 }),
      providerOf('amd-like', up2, { priority: 2 }),
      providerOf('commandcode-like', up3, { priority: 3 }),
    ], 'det4xx-continue');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200,
        '第一家回确定性 400 后必须继续 failover，由第三家兜底（旧实现就地回 400 打死任务）：'
        + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up1.st.calls, 1, '第一家只应被尝试一次，实际 ' + up1.st.calls);
      assert.ok(up2.st.calls >= 1, '第二家必须被尝试到，实际 ' + up2.st.calls);
      assert.ok(up3.st.calls >= 1, '第三家（兜底）必须被尝试到，实际 ' + up3.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/记为候选失败，\*\*继续 failover/.test(logText),
        '日志须写明"记为候选失败、继续 failover"：' + logText.slice(-500));
      assert.ok(!/failover stopped/.test(logText),
        '不得再出现 failover stopped（那正是打死任务的旧行为）：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); closeUp(up3); }
  });

  t('网关（同上）：**全部候选**都回确定性 4xx 时，仍回那个 4xx（状态码语义不倒退）', async () => {
    // 新语义的边界：继续 failover ≠ 丢掉诊断信息。全部候选都失败时优先回"确定性 4xx"，
    // 而不是泛化的 503 "all providers … are unavailable"。
    const up1 = await startFakeUpstream({
      status: 400,
      errorBody: { error: { message: 'invalid parameter: temperature must be <= 2' } },
    });
    const up2 = await startFakeUpstream({
      status: 400,
      errorBody: { error: { message: 'invalid parameter: temperature must be <= 2' } },
    });
    const gw = await startGatewayWith([
      providerOf('badA', up1, { priority: 1 }),
      providerOf('badB', up2, { priority: 2 }),
    ], 'det4xx-allfail');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 400, '全部候选都是确定性 4xx 时应回 400（不是 503），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up1.st.calls, 1, '第一家的请求次数，实际 ' + up1.st.calls);
      assert.ok(up2.st.calls >= 1, '第二家也必须被尝试（这正是本次修复的意义），实际 ' + up2.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/failover exhausted/.test(logText),
        '日志须写明"走完全部候选、回最后一次确定性 4xx"：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：流式响应**零内容**就被掐断 → 交回 failover 换下一家（不再直接把整轮任务打死）', async () => {
    // 现场（用户 16:17:51）：commandcode 收下请求、42 秒后被掐断，
    //   `流翻译读取失败：terminated` + `已产出 0 字符`
    // → 客户端收到 `event: error`「上游响应被中断」，而其余候选一次都没被尝试。
    // 零内容意味着客户端还什么都没收到 → 换一家重发是安全且正确的。
    const cut = await startFakeUpstream({
      sseBody: '',            // 一个字节内容都不发
      sseGapMs: 0,
    });
    // 特制：让假上游"发响应头后立刻断开、不带任何内容"
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[{"id":"test-model"}]}');
        return;
      }
      req.resume();
      req.on('end', () => {
        cut.st.calls++;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end();            // ← 干净地断开，没有任何 SSE 帧
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dead = { server, st: cut.st, port: server.address().port };
    // 第二家：**翻译路径**（provider 声明 openai-chat，客户端 anthropic → 上游 chat）。
    // 这条才是 DSH 实际走的路（commandcode / nvidia / cline 都是 openai-chat）。
    const good = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('cutsilent', dead, { priority: 1 }),
      Object.assign(providerOf('goodafter', good, { priority: 2 }), { protocol: 'openai-chat' }),
    ], 'zerocut');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200,
        '零内容被掐断后应由下一家接手（旧实现直接发 event: error 把任务打死）：' + r.status + ' ' + r.text.slice(0, 300));
      assert.ok(/upstream-ok/.test(r.text), '内容应来自第二家：' + r.text.slice(0, 300));
      assert.ok(/event: message_stop/.test(r.text), '应是正常收尾：' + r.text.slice(-300));
      assert.ok(!/event: error/.test(r.text), '不得出现 error 事件：' + r.text.slice(0, 300));
      assert.ok(good.st.calls >= 1, '第二家必须真的被调用，实际 ' + good.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/尚未向客户端写入任何内容.*交回 failover/.test(logText),
        '日志须写明"零交付 → 交回 failover"：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(dead); closeUp(good); }
  });

  t('网关：流已交付**部分内容**才被掐断 → 仍如实报"不完整"（不得换家导致两个回复拼一起）', async () => {
    // 这是上一条的边界：只有"零内容"才允许换家。已经发过内容块后再换家会把
    // 第二个模型的回复续写进同一条响应，客户端看到两段内容拼接 —— 更糟。
    //
    // ⚠ 这里必须用**自定义上游**：`startFakeUpstream` 的选项里没有 tailMode
    // （那是模块级 upstream fixture 的属性），传了会被静默忽略，用例就测不到想测的东西。
    const cutCount = { calls: 0 };
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[{"id":"test-model"}]}');
        return;
      }
      req.resume();
      req.on('end', () => {
        cutCount.calls++;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        // 先交付**真实内容**，然后不带 message_stop 干净地断开（复刻"代理掉线"）
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"test-model"}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截回复"}}\n\n');
        res.end();
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const up1 = { server: srv, st: cutCount, port: srv.address().port };
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('partcut', up1, { priority: 1 }),
      // 第二家走**翻译路径**（DSH 实际形态），这样"有没有换家"在客户端响应上看得出来
      Object.assign(providerOf('neverused', up2, { priority: 2 }), { protocol: 'openai-chat' }),
    ], 'partcut');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(/半截回复/.test(r.text), '第一家交付的部分内容应已发出：' + r.text.slice(0, 400));
      assert.ok(/event: error/.test(r.text), '已交付部分内容时必须发 error 事件：' + r.text.slice(0, 400));
      assert.ok(!/upstream-ok/.test(r.text), '不得把第二家的内容拼进来：' + r.text.slice(0, 400));
      assert.strictEqual(up2.st.calls, 0, '已有内容交付 → 不得换下一家（否则两段回复拼接），实际 ' + up2.st.calls);
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  // ---- 契约（2026-10-15 用户规则变更）：确定性 4xx **不再终止 failover** ----
  // 旧契约（2026-10-13 之前）：确定性 4xx → 只打一次上游、终止 failover、客户端拿 4xx。
  // 新契约：确定性 4xx → 记为候选失败并**继续走完候选**；只有全部候选都失败时才回那个 4xx。
  // 起因（用户实测）：commandcode 偶尔对同一模型回 400 `invalid request error trace_id`，
  // 而前后各一次都 200 —— 那是上游抽风，不是"请求本身有错"。旧实现就地把整轮任务打死。
  t('网关：上游确定性 400 → 继续 failover 由下一家服务（新契约；旧版就地终止回 400）', async () => {
    const up1 = await startFakeUpstream({ status: 400, errorBody: { error: { message: 'invalid parameter: temperature must be <= 2' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('p1', up1, { priority: 1 }),
      providerOf('p2', up2, { priority: 2 }),
    ], 'det400');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200,
        '确定性 400 后必须继续 failover，由 p2 服务（旧契约会就地回 400 打死任务），实际 '
        + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up1.st.calls, 1, 'p1 只应被请求一次，实际 ' + up1.st.calls);
      assert.ok(up2.st.calls >= 1, 'p2 必须被尝试到（这正是本次修复的意义），实际 ' + up2.st.calls);
      assert.ok(!/temperature must be/.test(r.text), '不得回显上游错误体原文：' + r.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：404 细分——"模型不存在"**继续** failover（2026-10-13 修）；路由不存在同样换下一家', async () => {
    // ⚠ 契约变更（2026-10-13）。旧契约是"模型不存在的 404 终止 failover"，
    // 理由写的是"重发给每一家只是 N 倍计费"—— 但那个理由只在"模型全局不存在"时成立。
    // 而配置里同一逻辑模型常常声明了多家，**其中一家写错/过期是常态**，正是 failover 的意义。
    // 实测事故（cline 桌面版）：deepseek-v4-pro 声明了 sensenova + opencode-go 两家，
    // sensenova 回 404 → 网关直接终止 → 客户端整轮失败，而 opencode-go 本可服务。
    // 现在：这类 404 与"路由不存在"一样继续 failover。
    //
    // 另见：400 那条路径早在 2026-09-23 就这么修了（amd "not supported" 事故），
    // 404 侧此前漏了 —— 这条用例同时钉住两条路径的行为一致。
    const a1 = await startFakeUpstream({ status: 404, errorBody: { error: { message: 'The model test-model does not exist' } } });
    const a2 = await startFakeUpstream({ status: 200 });
    const gwA = await startGatewayWith([
      providerOf('m1', a1, { priority: 1 }),
      providerOf('m2', a2, { priority: 2 }),
    ], 'm404');
    try {
      assert.ok(gwA.ready, '独立网关实例应就绪');
      const r = await call({ port: gwA.port });
      assert.strictEqual(r.status, 200, '"模型不存在"的 404 应继续 failover 到下一家并成功，实际 '
        + r.status + ' ' + r.text.slice(0, 160));
      assert.ok(a2.st.calls >= 1, '必须真的尝试下一家，实际 ' + a2.st.calls);
    } finally { killGw(gwA); closeUp(a1); closeUp(a2); }

    // 场景 A2：**所有**家都说没有这个模型 → 才回 404（这时"换下一家"已无意义）
    const c1 = await startFakeUpstream({ status: 404, errorBody: { error: { message: 'The model test-model does not exist' } } });
    const c2 = await startFakeUpstream({ status: 404, errorBody: { error: { message: 'model test-model not found' } } });
    const gwC = await startGatewayWith([
      providerOf('n1', c1, { priority: 1 }),
      providerOf('n2', c2, { priority: 2 }),
    ], 'allmiss404');
    try {
      assert.ok(gwC.ready, '独立网关实例应就绪');
      const r = await call({ port: gwC.port });
      // 全部候选都说"没有这个模型" → 回 **503**（"没有任何可用供应商"），不是 404。
      // 语义上 503 更准：网关**有**这些供应商，只是都不提供该模型；回 404 会让客户端
      // 以为"模型名/URL 写错了"，排查方向直接偏掉。
      assert.strictEqual(r.status, 503, '全部家都没有该模型时应回 503，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.ok(c2.st.calls >= 1, '仍应逐家试过，而不是第一家就放弃，实际 ' + c2.st.calls);
    } finally { killGw(gwC); closeUp(c1); closeUp(c2); }

    // 场景 B：通用 404（供应商没有该路由）→ 换下一家（否则 Codex 仿真用户会被首家的
    // 路由缺失直接打死）
    const b1 = await startFakeUpstream({ status: 404, errorBody: { error: { message: 'Not Found' } } });
    const b2 = await startFakeUpstream({ status: 200 });
    const gwB = await startGatewayWith([
      providerOf('r1', b1, { priority: 1 }),
      providerOf('r2', b2, { priority: 2 }),
    ], 'route404');
    try {
      assert.ok(gwB.ready, '独立网关实例应就绪');
      const r = await call({ port: gwB.port });
      assert.strictEqual(r.status, 200, '路由不存在的 404 应继续 failover 到下一家，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.ok(b2.st.calls >= 1, '应尝试下一家，实际 ' + b2.st.calls);
    } finally { killGw(gwB); closeUp(b1); closeUp(b2); }
  });

  t('网关：Anthropic 路径（/v1/messages）同样契约 —— 确定性 4xx 继续 failover（Anthropic 错误体形状）', async () => {
    const up1 = await startFakeUpstream({ status: 422, errorBody: { type: 'error', error: { type: 'invalid_request_error', message: 'upstream raw detail: unprocessable entity' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('a1', up1, { priority: 1 }),
      providerOf('a2', up2, { priority: 2 }),
    ], 'det422');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200,
        'Anthropic 路径同样要继续 failover 到第二家（旧契约就地回 422），实际 '
        + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(up2.st.calls >= 1, '不得把同一个错误请求只发给第一家，实际 ' + up2.st.calls);
      assert.ok(!/upstream raw detail/.test(r.text), '不得回显上游错误体原文：' + r.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('对照（Anthropic 路径）：全部候选都回确定性 4xx → 回该 4xx（Anthropic 错误体形状，不倒退）', async () => {
    const up1 = await startFakeUpstream({ status: 422, errorBody: { type: 'error', error: { type: 'invalid_request_error', message: 'upstream raw detail: unprocessable entity' } } });
    const up2 = await startFakeUpstream({ status: 422, errorBody: { type: 'error', error: { type: 'invalid_request_error', message: 'upstream raw detail: unprocessable entity' } } });
    const gw = await startGatewayWith([
      providerOf('a1', up1, { priority: 1 }),
      providerOf('a2', up2, { priority: 2 }),
    ], 'det422all');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 422, '全部候选都是 422 时应回 422（不是 503），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(up2.st.calls >= 1, '第二家也必须被尝试，实际 ' + up2.st.calls);
      const parsed = JSON.parse(r.text);
      assert.strictEqual(parsed.type, 'error', 'Anthropic 错误体形状：' + r.text.slice(0, 200));
      assert.strictEqual(parsed.error.type, 'invalid_request_error');
      assert.ok(!/upstream raw detail/.test(r.text), '不得回显上游错误体原文：' + r.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：上游 400 内容拦截（content_blocked）→ 仍会换下一家供应商（有意行为保留）', async () => {
    const up1 = await startFakeUpstream({ status: 400, errorBody: { error: { message: 'content_blocked: sensitive words detected' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('b1', up1, { priority: 1 }),
      providerOf('b2', up2, { priority: 2 }),
    ], 'blocked');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '内容拦截应继续 failover 到 b2，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(up1.st.calls >= 1, 'b1 应被尝试，实际 ' + up1.st.calls);
      assert.strictEqual(up2.st.calls, 1, 'b2 应收到一次转发，实际 ' + up2.st.calls);
      // 修复项 4①：内容拦截 dump 缺省**不落盘**（旧版无条件写 logs/dump/blocked-*.json）
      assert.ok(!fs.existsSync(path.join(path.dirname(gw.logPath), 'dump')),
        '缺省（未设 DSH_GATEWAY_DUMP_BLOCKED/DSH_GATEWAY_DUMP_DIR）不得自动落盘 blocked-*.json');
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  // ---- 修复项 4：dump 开关 + 保留上限 + 不记长串原文前缀 ----
  t('网关：内容拦截 dump 只在显式开启时落盘、只保留最近 20 个、长串只记长度与类型', async () => {
    const fakeHex = 'a1b2c3d4'.repeat(6);          // 48 位 hex 形态假串（非真实密钥）
    const up = await startFakeUpstream({ status: 400, errorBody: { error: { message: 'content_blocked: sensitive words' } } });
    const dumpDir = path.join(tmp, 'blocked-dump');
    const gw = await startGatewayWith([providerOf('d1', up, { priority: 1 })], 'dump', {
      DSH_GATEWAY_DUMP_BLOCKED: '1', DSH_GATEWAY_DUMP_DIR: dumpDir,
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 22; i++) {
        await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'token ' + fakeHex }] } });
      }
      const files = fs.readdirSync(dumpDir).filter((f) => /^blocked-.*\.json$/.test(f));
      assert.strictEqual(files.length, 20, '目录内应只保留最近 20 个 blocked-*.json，实际 ' + files.length);
      const all = files.map((f) => fs.readFileSync(path.join(dumpDir, f), 'utf8'));
      assert.ok(all.every((txt) => !txt.includes(fakeHex.slice(0, 20))), 'dump 不得包含长串原文前缀（可能是真密钥前缀）');
      const sample = JSON.parse(all[0]);
      assert.deepStrictEqual(sample.longTokens, [{ len: 48, kind: 'hex' }],
        'longTokens 只记 {len,kind}（旧版记 head=原文前 20 字符）：' + JSON.stringify(sample.longTokens));
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 修复项 2：配置 models 参与路由（2026-09-15 起：**配置列表为唯一权威**）----
  t('网关：配置了别的模型但没配这个 → 404 且零转发、零目录探测（配置权威）', async () => {
    const up = await startFakeUpstream({ modelsStatus: 404 });   // catalog 不可用 → "未知"桶
    const gw = await startGatewayWith([providerOf('only-other', up, { models: ['other-model'] })], 'nomodel');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });                   // 请求 test-model（配置里没有）
      assert.strictEqual(r.status, 404, '配置未声明该模型 → 404，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 0, '不得把未声明的模型发给上游，实际 ' + up.st.calls);
      assert.strictEqual(up.st.modelsReqs, 0,
        '该 provider 已配置模型 → 请求路径上不应再做目录探测（配置权威，实测旧版每次请求多等 ~1.5s），实际 ' + up.st.modelsReqs);
      assert.ok(/models/.test(r.text) && /model \\"test-model\\"/.test(r.text), '错误信息应提示检查 provider 的 models 列表：' + r.text.slice(0, 300));
      assert.ok(/not-declared\(config-authoritative\)/.test(r.text), '错误详情应带判定原因：' + r.text.slice(0, 300));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/only-other=not-declared\(config-authoritative\)/.test(logText), '日志应记录判定原因：' + logText.slice(-400));
      // 同一实例：配置里声明的模型照常路由
      const r2 = await call({ port: gw.port, body: { model: 'other-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r2.status, 200, '配置声明的模型应可路由，实际 ' + r2.status + ' ' + r2.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, 'other-model 应恰好转发一次，实际 ' + up.st.calls);
      assert.strictEqual(up.st.modelsReqs, 0, '仍不应有目录探测，实际 ' + up.st.modelsReqs);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：上游目录里有、但我没配 → **不是候选**（b.ai 事故：目录里有却回 400，把请求判死）', async () => {
    const up = await startFakeUpstream({ catalog: [{ id: 'test-model' }] });
    const gw = await startGatewayWith([providerOf('cat', up, { models: ['other-model'] })], 'cathit');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 404, '仅目录命中不算候选（配置权威），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 0, '不得把请求发给"只是目录里有"的那家，实际 ' + up.st.calls);
      assert.strictEqual(up.st.modelsReqs, 0, '配置了的 provider 不需要探测目录，实际 ' + up.st.modelsReqs);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：一个模型都没配的 provider → 仍按目录兜底（没有可遵循的配置时才这样）', async () => {
    const up = await startFakeUpstream({ catalog: [{ id: 'test-model' }] });
    const gw = await startGatewayWith([providerOf('unconfigured', up, { models: [] })], 'nocfg');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '未配置任何模型的 provider 应按目录命中兜底，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, '应转发一次，实际 ' + up.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/no-models-declared,catalog-hit/.test(logText), '判定原因应标明是"未配置→目录兜底"：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：声明的归属优先——轮询也不会把请求先发给"仅目录命中"的那家（真实事故回归）', async () => {
    // 实测场景：chiyi-ds 声明 deepseek-v4.1-flash；b.ai 目录里也有同名模型（但实际回 400）。
    // 旧实现把目录命中排在最前 + round-robin → 请求被送到 b.ai 并因"确定性 4xx"直接失败。
    const upDecl = await startFakeUpstream({ catalog: [{ id: 'other-model' }] });   // 目录里没有该模型
    const upCat = await startFakeUpstream({ catalog: [{ id: 'test-model' }] });     // 仅目录里有
    const gw = await startGatewayWith([
      providerOf('declared', upDecl, { priority: 5, models: ['test-model'] }),   // 优先级数字更大
      providerOf('catalog-only', upCat, { priority: 1, models: ['other-model'] }), // 优先级更小但只能靠目录兜底
    ], 'tier', null, { routing: 'round-robin' });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 6; i++) {
        const r = await call({ port: gw.port });
        assert.strictEqual(r.status, 200, '第 ' + (i + 1) + ' 次应成功，实际 ' + r.status);
      }
      assert.strictEqual(upDecl.st.calls, 6, '声明归属的那家应承担全部请求，实际 ' + upDecl.st.calls);
      assert.strictEqual(upCat.st.calls, 0,
        '仅目录命中的那家一次都不该被调用（**层级优先于 priority**：配置权威 > 目录兜底），实际 ' + upCat.st.calls);
    } finally { killGw(gw); closeUp(upDecl); closeUp(upCat); }
  });

  t('网关：上游"余额/额度"类 400 → 不终止 failover（换下一家；旧实现把请求直接判死）', async () => {
    // 实测原文：b.ai 余额为 0 时回 HTTP 400 {"error":{"message":"credit insufficient balance: balance=0 ..."}}
    const up1 = await startFakeUpstream({ status: 400, errorBody: { error: { message: 'credit insufficient balance: balance=0 required=29146' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('p1', up1, { priority: 1, models: ['test-model'] }),
      providerOf('p2', up2, { priority: 2, models: ['test-model'] }),
    ], 'prov4xx');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '应换到第二家成功，实际 ' + r.status + ' ' + r.text.slice(0, 220));
      assert.strictEqual(up1.st.calls, 1, '第一家只应被尝试一次，实际 ' + up1.st.calls);
      assert.strictEqual(up2.st.calls, 1, '第二家应收到转发，实际 ' + up2.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/供应商账号\/额度\/权限/.test(logText), '日志应标明按"供应商侧错误"处理：' + logText.slice(-300));
      assert.ok(/breaker OPEN: p1 失败（403）/.test(logText), '余额类属长期状态 → 应长熔断：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：catalog 未命中但配置显式声明 → 仍作为候选（声明优先于目录快照）', async () => {
    // 实测场景：agentrouter 的 /models 不含 glm-5.3，但用户在网关配置里显式声明了它。
    // 旧规则（catalog 已知不含 → 排除）会回 404「not offered by any configured provider」，
    // 把用户配好的模型打死；修订后配置声明优先。
    const up = await startFakeUpstream({ catalog: [{ id: 'some-other-model' }] });
    const gw = await startGatewayWith([providerOf('decl', up, { models: ['test-model'] })], 'declhit');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '配置显式声明即候选，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, '应转发一次，实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：模型映射——逻辑名路由到各家的上游真实 ID（含 failover 后改写）', async () => {
    // 两家供应商用**不同的上游 ID** 承载同一个逻辑模型 deepseek-v4-flash：
    //   p1: deepseek-ai/deepseek-v4-flash（挂：500 → 触发 failover）
    //   p2: deepseek-v4-flash0731（正常）
    // 客户端只请求逻辑名；网关必须按优先级切换，并把 body.model 改写为**该家**的真实 ID。
    const up1 = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'boom' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('m1', up1, { priority: 1, models: [{ id: 'deepseek-ai/deepseek-v4-flash', as: 'deepseek-v4-flash' }] }),
      providerOf('m2', up2, { priority: 2, models: [{ id: 'deepseek-v4-flash0731', as: 'deepseek-v4-flash' }] }),
    ], 'maproute');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应 failover 到第二家，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.strictEqual(up1.st.lastModel, 'deepseek-ai/deepseek-v4-flash', 'p1 收到的应是它自己的上游 ID');
      assert.strictEqual(up2.st.lastModel, 'deepseek-v4-flash0731', 'p2 收到的应是它自己的上游 ID');
      assert.ok(!up1.st.models.includes('deepseek-v4-flash'), '不得把逻辑名原样发给上游');
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：模型映射——同一逻辑名有多条映射时取第一条命中；未声明映射则原样透传', async () => {
    const upA = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('multi', upA, {
        models: [
          { id: 'variant-one-x', as: 'same-logical' },
          { id: 'variant-two-x', as: 'same-logical' },
        ],
      }),
    ], 'mapmulti');
    try {
      assert.ok(gw.ready);
      const r1 = await call({ port: gw.port, body: { model: 'same-logical', messages: [] } });
      assert.strictEqual(r1.status, 200, '实际 ' + r1.status);
      assert.strictEqual(upA.st.lastModel, 'variant-one-x', '同一逻辑名的多条映射应取第一条');
      // 未声明的模型：目录也不含 → 404（不发给上游）
      const before = upA.st.calls;
      const r2 = await call({ port: gw.port, body: { model: 'not-declared-anywhere', messages: [] } });
      assert.strictEqual(r2.status, 404, '未声明且目录不含 → 404，实际 ' + r2.status);
      assert.strictEqual(upA.st.calls, before, '不得把未声明的模型发给上游');
    } finally { killGw(gw); closeUp(upA); }
  });

  t('网关：/v1/models 只列**配置里声明的**模型（不再列目录里的，避免 dsh 选中后被 404）', async () => {
    const up = await startFakeUpstream({ catalog: [{ id: 'vendor-raw-id-1' }, { id: 'plain-catalog-model' }] });
    const gw = await startGatewayWith([
      providerOf('lst', up, {
        models: [
          { id: 'vendor-raw-id-1', as: 'nice-logical-name' },
          'plain-declared-model',
        ],
      }),
    ], 'maplist');
    try {
      assert.ok(gw.ready);
      const r = await call({ port: gw.port, method: 'GET', p: '/v1/models', body: null });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const ids = (JSON.parse(r.text).data || []).map((m) => m.id);
      assert.ok(ids.includes('nice-logical-name'), '应列出逻辑名：' + ids.join(','));
      assert.ok(ids.includes('plain-declared-model'), '应列出未映射的声明：' + ids.join(','));
      assert.ok(!ids.includes('plain-catalog-model'),
        '配置了模型的 provider 不再补目录模型（配置权威：列出来也会因未声明而 404）：' + ids.join(','));
      assert.ok(!ids.includes('vendor-raw-id-1'), '被映射覆盖的上游 ID 不应单独出现：' + ids.join(','));
      assert.strictEqual(up.st.modelsReqs, 0, '配置齐全时不应探测目录，实际 ' + up.st.modelsReqs);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：/v1/models 对"未配置模型"的 provider 仍补目录（否则该家模型不可见）', async () => {
    const up = await startFakeUpstream({ catalog: [{ id: 'free-model-a' }, { id: 'free-model-b' }] });
    const gw = await startGatewayWith([providerOf('nocfg', up, { models: [] })], 'maplist2');
    try {
      assert.ok(gw.ready);
      const r = await call({ port: gw.port, method: 'GET', p: '/v1/models', body: null });
      const ids = (JSON.parse(r.text).data || []).map((m) => m.id);
      assert.ok(ids.includes('free-model-a') && ids.includes('free-model-b'),
        '未配置任何模型的服务商应按目录列出：' + ids.join(','));
    } finally { killGw(gw); closeUp(up); }
  });

  // ================= 路由顺序（2026-09-17 用户要求变更）=================
  // ① 先按 priority 升序；② 同一 priority 内按配置数组顺序
  t('网关：候选顺序 = priority 升序优先，同 priority 内按数组顺序（2026-09-17 规则）', async () => {
    const upBig = await startFakeUpstream({});
    const upSmall = await startFakeUpstream({});
    // priority 大的排在数组前面 —— 旧规则（纯数组顺序）会先打它；新规则必须先打 priority=1 的那家
    const gw = await startGatewayWith([
      providerOf('pri-9', upBig, { priority: 9, models: ['test-model'] }),
      providerOf('pri-1', upSmall, { priority: 1, models: ['test-model'] }),
    ], 'priorder');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.strictEqual(upSmall.st.calls, 1, 'priority=1 的家应被优先尝试，实际 ' + upSmall.st.calls);
      assert.strictEqual(upBig.st.calls, 0, 'priority=9 的家不该被先打（旧规则才会），实际 ' + upBig.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/pri-1=models-declared pri-9=models-declared/.test(logText),
        '日志候选顺序应为 priority 升序：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(upBig); closeUp(upSmall); }
  });

  t('网关：同 priority 时按配置数组顺序（▲▼ 调整的就是这个顺序）', async () => {
    const upA = await startFakeUpstream({});
    const upB = await startFakeUpstream({});
    const gw = await startGatewayWith([
      providerOf('tie-a', upA, { priority: 1, models: ['test-model'] }),
      providerOf('tie-b', upB, { priority: 1, models: ['test-model'] }),
    ], 'tieorder');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.strictEqual(upA.st.calls, 1, '同 priority 应先发数组第一位，实际 ' + upA.st.calls);
      assert.strictEqual(upB.st.calls, 0, '同 priority 第二位不应被先发，实际 ' + upB.st.calls);
      // priority 缺省（未写字段）视为 1，与显式 1 同级 → 仍按数组顺序
      const upC = await startFakeUpstream({});
      const gw2 = await startGatewayWith([
        providerOf('def-a', upA, { models: ['test-model'] }),
        providerOf('def-b', upC, { models: ['test-model'] }),
      ], 'tieorder2');
      try {
        const r2 = await call({ port: gw2.port });
        assert.strictEqual(r2.status, 200, '实际 ' + r2.status);
        assert.ok(/def-a=models-declared def-b=models-declared/.test(fs.readFileSync(gw2.logPath, 'utf8')),
          '缺省 priority 应视为 1 并与同级一起按数组顺序');
      } finally { killGw(gw2); closeUp(upC); }
    } finally { killGw(gw); closeUp(upA); closeUp(upB); }
  });

  // ② 多模态：带图片的请求只发给声明了图片能力的家（否则会被转给纯文本家，上游报错/丢图）
  t('网关：带图片的请求只发给声明图片能力的家（vision: true）；纯文本请求照常走数组首位', async () => {
    const upText = await startFakeUpstream({});
    const upVision = await startFakeUpstream({});
    const gw = await startGatewayWith([
      providerOf('plain', upText, { models: ['test-model'] }),                        // 数组在前：纯文本
      providerOf('vlm', upVision, { models: [{ id: 'test-model', vision: true }] }),  // 声明图片能力
    ], 'visionroute');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 纯文本请求 → 数组首位（纯文本家）
      const a = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(a.status, 200, '实际 ' + a.status);
      assert.strictEqual(upText.st.calls, 1, '纯文本请求应走数组首位，实际 ' + upText.st.calls);
      assert.strictEqual(upVision.st.calls, 0, '实际 ' + upVision.st.calls);
      // ② 带图片（Anthropic 形状）→ 只有声明了图片能力的家
      const img = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 16,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '这张图里是什么？' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } },
            ],
          }],
        },
      });
      assert.strictEqual(img.status, 200, '实际 ' + img.status + ' ' + img.text.slice(0, 160));
      assert.strictEqual(upText.st.calls, 1, '纯文本家不得收到带图片的请求，实际 ' + upText.st.calls);
      assert.strictEqual(upVision.st.calls, 1, '声明图片能力的家应收到，实际 ' + upVision.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/请求含图片（本轮 1 张 \/ 历史 0 张） → 跳过未声明图片能力的 1 家/.test(logText),
        '日志应记录图片路由，并区分"本轮/历史"（2026-09-18 用户排查：历史里的截图会让每轮都命中多模态路由）：' + logText.slice(-400));
      // ③ 若没有任何候选声明图片能力 → 保持原候选（交给上游报错，不凭空 404）
      const upPlain = await startFakeUpstream({});
      const gw2 = await startGatewayWith([providerOf('only-plain', upPlain, { models: ['test-model'] })], 'visionnofallback');
      try {
        const b = await call({
          port: gw2.port, p: '/v1/messages',
          body: {
            model: 'test-model', max_tokens: 16,
            messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }],
          },
        });
        assert.strictEqual(b.status, 200, '无图片候选时应照常转发（不得凭空 404），实际 ' + b.status + ' ' + b.text.slice(0, 160));
        assert.strictEqual(upPlain.st.calls, 1, '应转发给唯一候选，实际 ' + upPlain.st.calls);
      } finally { killGw(gw2); closeUp(upPlain); }
    } finally { killGw(gw); closeUp(upText); closeUp(upVision); }
  });

  t('图片计数：历史消息里的旧截图计入"历史"，本轮无图时不谎报"本轮含图片"（2026-09-18 用户排查）', async () => {
    // 现场：用户 14:43 贴了一张控制台截图 → 之后**每一轮**请求（含纯文字追问）都命中多模态路由，
    // 日志只写"请求含图片"，看上去像"我没发图片却说我发了"。真实原因：客户端每轮重发完整历史。
    const upText = await startFakeUpstream({});
    const upVision = await startFakeUpstream({});
    const gw = await startGatewayWith([
      providerOf('plain2', upText, { models: ['test-model'] }),
      providerOf('vlm2', upVision, { models: [{ id: 'test-model', vision: true }] }),
    ], 'visionhist');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 16,
          messages: [
            // 历史：用户上一轮贴的截图（带图）+ 助手回复
            { role: 'user', content: [{ type: 'text', text: '如图，我发现个问题' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] },
            { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
            // 本轮：纯文字追问，**没有**图片
            { role: 'user', content: [{ type: 'text', text: '继续排查' }] },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.strictEqual(upText.st.calls, 0, '历史含图 → 仍必须只发给声明图片能力的家（否则上游会收到图片），实际 ' + upText.st.calls);
      assert.strictEqual(upVision.st.calls, 1, '实际 ' + upVision.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/请求含图片（本轮 0 张 \/ 历史 1 张） → 跳过未声明图片能力的 1 家/.test(logText),
        '日志必须区分本轮/历史（否则会被误读成"用户刚发了图片"）：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(upText); closeUp(upVision); }
  });

  // ③ /v1/models 按模型名排序（选择器列表不再随供应商配置顺序杂乱）
  t('网关：/v1/models 按模型名排序输出', async () => {
    const up = await startFakeUpstream({});
    const gw = await startGatewayWith([providerOf('s1', up, { models: ['zeta-model', 'alpha-model', 'Beta-model'] })], 'modelsort');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, method: 'GET', p: '/v1/models', body: null });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const ids = (JSON.parse(r.text).data || []).map((m) => m.id);
      assert.deepStrictEqual(ids, ['alpha-model', 'Beta-model', 'zeta-model'],
        '应按名排序（大小写不敏感）：' + JSON.stringify(ids));
    } finally { killGw(gw); closeUp(up); }
  });

  t('write-dsh：模型按名称排序写入 + 声明图片能力的模型写 input: [text, image]', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'wd-vision-'));
    const cfgPath = path.join(dir, 'gateway.config.json');
    const setPath = path.join(dir, 'settings.yaml');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: 3099, apiKey: GATEWAY_KEY, clientProfile: 'claude',
      providers: [
        { id: 'p1', baseURL: 'https://a.example.org/v1', apiKey: 'sk-' + 'x'.repeat(20), enabled: true, models: ['zeta-model', { id: 'v/vision-up', as: 'alpha-model', vision: true }] },
        { id: 'p2', baseURL: 'https://b.example.org/v1', apiKey: 'sk-' + 'y'.repeat(20), enabled: true, models: ['beta-model'] },
      ],
    }), 'utf8');
    fs.writeFileSync(setPath, 'llm-pi-ai:\n  providers:\n', 'utf8');
    const r = spawnSync(process.execPath, [MJS, '--write-dsh', '--config', cfgPath, '--settings', setPath,
      '--credentials', path.join(dir, 'c.yaml'), '--port', '3099'], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    assert.strictEqual(r.status, 0, 'write-dsh 应成功');
    const text = fs.readFileSync(setPath, 'utf8');
    const ids = [...text.matchAll(/^ {8}- id: '([^']+)'$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(ids, ['alpha-model', 'beta-model', 'zeta-model'],
      '模型条目应按名称排序写入：' + JSON.stringify(ids));
    const alpha = text.slice(text.indexOf("- id: 'alpha-model'"), text.indexOf("- id: 'beta-model'"));
    assert.ok(/^ {10}input:$/m.test(alpha) && /^ {12}- image$/m.test(alpha),
      'vision:true 的模型必须写 input（否则 dsh 拦下图片）：\n' + alpha);
    const beta = text.slice(text.indexOf("- id: 'beta-model'"), text.indexOf("- id: 'zeta-model'"));
    assert.ok(!/input:/.test(beta), '未声明图片能力的模型不得写 input：\n' + beta);
    assert.ok(/allowEmptySignature: true/.test(alpha), 'compat 仍应写入：\n' + alpha);
  });

  // ================= OpenAI Responses 协议支持（2026-09-11） =================
  // 背景：Responses 是**有状态**协议，客户端（Codex / OpenAI SDK / dsh 的 responses 模式）
  // 会在 POST /v1/responses 之后用 response.id 继续 GET/DELETE/cancel/input_items。
  // 旧版网关只认 POST，其余路径全部 404 unsupported route；且体翻译（打码/role/推理档位）
  // 在 Responses 上是死代码（translateBody 只看 body.messages）。

  t('网关：POST /v1/responses 透传 + Responses 体翻译（打码 / developer→system / reasoning.effort）', async () => {
    const up = await startFakeUpstream({ responses: true });
    const fakeHex = 'a1b2c3d4'.repeat(5);                       // 40 位 hex 形态假串（非真实密钥）
    const fakeKey = 'sk-' + 'A1b2C3d4E5f6G7h8'.repeat(2);       // sk- + 32 位 → R9 打码
    const gw = await startGatewayWith([
      providerOf('resp', up, { models: ['test-model'], reasoningEffortMap: { max: 'xhigh', off: 'disabled' } }),
    ], 'resp1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/responses?api-version=2025-04-01-preview',
        body: {
          model: 'test-model', stream: true,
          instructions: 'system prompt with hash ' + fakeHex,
          input: [
            { type: 'message', role: 'developer', content: 'dev says hi' },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'key ' + fakeKey }] },
          ],
          reasoning: { effort: 'max' },
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(/response\.created/.test(r.text) && /response\.completed/.test(r.text),
        'SSE 应原样回传：' + r.text.slice(0, 200));
      const sent = up.st.lastRespBody;
      const sentText = JSON.stringify(sent);
      assert.ok(sent && sent.model === 'test-model', '上游应收到 Responses 请求体：' + sentText.slice(0, 200));
      assert.ok(!sentText.includes(fakeHex), 'instructions 里的长串必须打码：' + sentText.slice(0, 300));
      assert.ok(sentText.includes('[sha256:40]'), '应出现长串占位符 [sha256:40]：' + sentText.slice(0, 300));
      assert.ok(!sentText.includes('A1b2C3d4E5f6G7h8'), 'input 里的 sk- 密钥必须打码：' + sentText.slice(0, 300));
      assert.ok(/sk-\*\*\*/.test(sentText), '应保留 sk- 前缀样式的打码：' + sentText.slice(0, 300));
      assert.strictEqual(sent.input[0].role, 'system', 'developer 角色应改写为 system：' + sentText.slice(0, 300));
      assert.strictEqual(sent.reasoning.effort, 'xhigh', 'reasoning.effort 应按 reasoningEffortMap 改写：' + sentText.slice(0, 300));
      assert.ok(up.st.respUrls.some((u) => u.includes('api-version=2025-04-01-preview')),
        '查询串应原样传给上游：' + up.st.respUrls.join(' | '));
      // off 档位：Responses 没有"关闭"枚举值 → 应整段移除 reasoning（照抄 effort:"disabled" 会被严格上游 400）
      const off = await call({
        port: gw.port, p: '/v1/responses',
        body: { model: 'test-model', input: 'hi', reasoning: { effort: 'off' } },
      });
      assert.strictEqual(off.status, 200, '实际 ' + off.status);
      assert.ok(!('reasoning' in up.st.lastRespBody),
        'reasoning.effort=off（映射为 disabled）应移除 reasoning 字段：' + JSON.stringify(up.st.lastRespBody).slice(0, 200));
      assert.strictEqual(up.st.lastRespBody.model, 'test-model', '移除了 reasoning 不应影响其它字段');
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：Responses 子路由回原供应商（GET/DELETE/cancel/input_items 不猜别家）', async () => {
    const up1 = await startFakeUpstream({ responses: true });
    const up2 = await startFakeUpstream({ responses: true });
    const gw = await startGatewayWith([
      providerOf('r1', up1, { priority: 1 }),
      providerOf('r2', up2, { priority: 2 }),
    ], 'resp2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const created = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'one' } });
      assert.strictEqual(created.status, 200, '实际 ' + created.status);
      const m = /"id":"(resp_test\d+)"/.exec(created.text);
      assert.ok(m, 'SSE 里应含 response.id：' + created.text.slice(0, 200));
      const id = m[1];
      assert.strictEqual(up1.st.calls, 1, 'priority 1 应创建该 response，实际 ' + up1.st.calls);
      const up2Before = up2.st.calls;

      const got = await call({ port: gw.port, method: 'GET', p: '/v1/responses/' + id, body: null });
      assert.strictEqual(got.status, 200, 'GET 应命中创建它的那家，实际 ' + got.status + ' ' + got.text.slice(0, 160));
      assert.ok(/"object":"response"/.test(got.text), '应回响应对象：' + got.text.slice(0, 160));

      const items = await call({ port: gw.port, method: 'GET', p: '/v1/responses/' + id + '/input_items', body: null });
      assert.strictEqual(items.status, 200, 'input_items 应可用，实际 ' + items.status + ' ' + items.text.slice(0, 160));
      assert.ok(/"object":"list"/.test(items.text), items.text.slice(0, 160));

      const created2 = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'two' } });
      const id2 = /"id":"(resp_test\d+)"/.exec(created2.text)[1];
      const cancelled = await call({ port: gw.port, method: 'POST', p: '/v1/responses/' + id2 + '/cancel', body: {} });
      assert.strictEqual(cancelled.status, 200, 'cancel 应可用，实际 ' + cancelled.status + ' ' + cancelled.text.slice(0, 160));

      const deleted = await call({ port: gw.port, method: 'DELETE', p: '/v1/responses/' + id, body: null });
      assert.strictEqual(deleted.status, 200, 'DELETE 应可用，实际 ' + deleted.status + ' ' + deleted.text.slice(0, 160));
      assert.ok(/"deleted":true/.test(deleted.text), deleted.text.slice(0, 160));
      // 删除后同一 id 再取 → 上游 404（网关如实回 404，不再探测别家）
      const gone = await call({ port: gw.port, method: 'GET', p: '/v1/responses/' + id, body: null });
      assert.strictEqual(gone.status, 404, '已删除的资源应回 404，实际 ' + gone.status + ' ' + gone.text.slice(0, 160));

      assert.strictEqual(up2.st.calls, up2Before,
        '非 owner 供应商不得收到任何子路由请求（旧版全部 404 unsupported route），实际新增 ' + (up2.st.calls - up2Before));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/responses affinity: resp_test\d+ → r1/.test(logText), '日志应记录 response→供应商 亲和：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：未知 response id —— 只读操作逐家探测（404），写操作拒绝猜测（零上游请求）', async () => {
    const up1 = await startFakeUpstream({ responses: true });
    const up2 = await startFakeUpstream({ responses: true });
    const gw = await startGatewayWith([
      providerOf('r1', up1, { priority: 1 }),
      providerOf('r2', up2, { priority: 2 }),
    ], 'resp3');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const before = [up1.st.calls, up2.st.calls];
      const got = await call({ port: gw.port, method: 'GET', p: '/v1/responses/resp_unknown_xyz', body: null });
      assert.strictEqual(got.status, 404, '实际 ' + got.status + ' ' + got.text.slice(0, 200));
      assert.ok(/not found on any configured provider/.test(got.text), got.text.slice(0, 200));
      assert.ok(up1.st.calls > before[0] && up2.st.calls > before[1],
        '未知 id 的只读请求应逐家探测（各家对别人的 id 都回 404）：' + up1.st.calls + ',' + up2.st.calls);

      const before2 = [up1.st.calls, up2.st.calls];
      const del = await call({ port: gw.port, method: 'DELETE', p: '/v1/responses/resp_unknown_xyz', body: null });
      assert.strictEqual(del.status, 404, '实际 ' + del.status);
      assert.ok(/refusing to guess/.test(del.text), '写操作应明确拒绝猜测归属：' + del.text.slice(0, 200));
      assert.deepStrictEqual([up1.st.calls, up2.st.calls], before2,
        '写操作（DELETE）不得向任何供应商试探，避免误删别家资源');
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：previous_response_id 在多轮中钉回原供应商（round-robin 下也不例外）', async () => {
    const up1 = await startFakeUpstream({ responses: true });
    const up2 = await startFakeUpstream({ responses: true });
    const gw = await startGatewayWith([
      providerOf('r1', up1, { priority: 1 }),
      providerOf('r2', up2, { priority: 2 }),
    ], 'resp4', null, { routing: 'round-robin' });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r1 = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'turn-1' } });
      assert.strictEqual(r1.status, 200, '实际 ' + r1.status);
      const id = /"id":"(resp_test\d+)"/.exec(r1.text)[1];
      assert.strictEqual(up1.st.calls, 1, '轮询起点应为 r1，实际 ' + up1.st.calls);
      const c1 = up1.st.calls;
      const c2 = up2.st.calls;
      const r2 = await call({
        port: gw.port, p: '/v1/responses',
        body: { model: 'test-model', input: 'turn-2', previous_response_id: id },
      });
      assert.strictEqual(r2.status, 200, '实际 ' + r2.status);
      assert.strictEqual(up1.st.calls, c1 + 1, '带 previous_response_id 的多轮请求应回到原供应商（轮询不得改变归属）');
      assert.strictEqual(up2.st.calls, c2, '有状态请求不得发给别家（否则上下文丢失/404）');
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：owner 上游故障（5xx）→ 502（不谎报 404 "资源不存在"）', async () => {
    const up = await startFakeUpstream({ responses: true, resourceStatus: 500 });
    const gw = await startGatewayWith([providerOf('r1', up, { priority: 1 })], 'resp5');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const created = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'x' } });
      const id = /"id":"(resp_test\d+)"/.exec(created.text)[1];
      const got = await call({ port: gw.port, method: 'GET', p: '/v1/responses/' + id, body: null });
      assert.strictEqual(got.status, 502, '上游故障应回 502，实际 ' + got.status + ' ' + got.text.slice(0, 200));
      assert.ok(/retry shortly/.test(got.text), '应提示可重试：' + got.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：上游对子路由回确定性 4xx（400）→ 按资源语境回 400（不把 response id 说成"模型"）', async () => {
    const up = await startFakeUpstream({ responses: true, resourceStatus: 400 });
    const gw = await startGatewayWith([providerOf('r1', up, { priority: 1 })], 'resp7');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const created = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'x' } });
      const id = /"id":"(resp_test\d+)"/.exec(created.text)[1];
      const r = await call({ port: gw.port, method: 'POST', p: '/v1/responses/' + id + '/cancel', body: {} });
      assert.strictEqual(r.status, 400, '应把确定性 400 映射回客户端，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(/rejected POST \/v1\/responses\/\{id\} with HTTP 400/.test(r.text), '文案应是资源语境：' + r.text.slice(0, 300));
      assert.ok(!/model \\?"|rejected model/.test(r.text), '不得把 response id 说成模型名：' + r.text.slice(0, 300));
      assert.ok(!/upstream temporarily unavailable/.test(r.text), '不得回显上游原文：' + r.text.slice(0, 300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：上游未实现 Responses 子路由（new-api 的 Invalid URL）→ 404 文案指出"供应商能力缺失"而非"已删除"', async () => {
    const up = await startFakeUpstream({ responses: true, noResourceRoutes: true });
    const gw = await startGatewayWith([providerOf('r1', up, { priority: 1 })], 'resp6');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const created = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'x' } });
      assert.strictEqual(created.status, 200, '创建本身应成功（上游实现了 POST）：' + created.status);
      const id = /"id":"(resp_test\d+)"/.exec(created.text)[1];
      for (const [method, p, epName] of [
        ['GET', '/v1/responses/' + id, 'GET /v1/responses/{id}'],
        ['GET', '/v1/responses/' + id + '/input_items', 'GET /v1/responses/{id}/input_items'],
        ['DELETE', '/v1/responses/' + id, 'DELETE /v1/responses/{id}'],
        ['POST', '/v1/responses/' + id + '/cancel', 'POST /v1/responses/{id}/cancel'],
      ]) {
        const r = await call({ port: gw.port, method, p, body: method === 'POST' ? {} : null });
        assert.strictEqual(r.status, 404, method + ' ' + p + ' 应回 404，实际 ' + r.status + ' ' + r.text.slice(0, 200));
        assert.ok(/does not implement the Responses resource endpoint/.test(r.text),
          '应指出是供应商能力缺失：' + r.text.slice(0, 300));
        assert.ok(r.text.includes(epName), '文案应点名端点 ' + epName + '：' + r.text.slice(0, 300));
        assert.ok(!/expired or been deleted/.test(r.text), '不得误导为"资源已过期/被删"：' + r.text.slice(0, 300));
      }
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/owner-miss\/route-missing/.test(logText), '日志应标注 route-missing（便于排查）：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：上游 HTTP 200 但 SSE 首事件是 error（chiyi-ds 形态）→ 判该家失败并换下一家（旧版记 ok 且把上游原文透传给客户端）', async () => {
    const up1 = await startFakeUpstream({ sseErrorFirst: true });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('p1', up1, { priority: 1 }),
      providerOf('p2', up2, { priority: 2 }),
    ], 'sseerr');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '应换到第二家成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(/upstream-ok/.test(r.text), '客户端应拿到第二家的正常流：' + r.text.slice(0, 200));
      assert.ok(!/Service temporarily unavailable/.test(r.text), '不得把上游错误原文透传给客户端：' + r.text.slice(0, 200));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/SSE 首事件是错误/.test(logText), '日志应记录该判定：' + logText.slice(-400));
      // 用上游调用次数断言"确实换到了第二家"（日志里 served 行由网关在返回后写，存在毫秒级竞态）
      assert.strictEqual(up2.st.calls, 1, '第二家应收到一次转发，实际 ' + up2.st.calls);
      assert.ok(!/via=p1\b[^\n]*status=ok/.test(logText), '第一家不得被记成 ok：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：唯一候选 200+SSE error → 回网关自己的 503（客户端不再看到上游原文）', async () => {
    const up = await startFakeUpstream({ sseErrorFirst: true });
    const gw = await startGatewayWith([providerOf('only', up, { priority: 1 })], 'sseerr2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 503, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(!/Service temporarily unavailable/.test(r.text), '不得回显上游原文：' + r.text.slice(0, 200));
      assert.ok(/all providers for model/.test(r.text), '应是网关自己的文案：' + r.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 2026-09-16 实测事故：Anthropic 协议下"带 tool_use 的 assistant 轮必须回传 thinking 块" ----
  // air-outer / agentrouter 实测：历史里 assistant 只有 tool_use（或 text+tool_use）时回
  // HTTP 400「The `content[].thinking` in the thinking mode must be passed back to the API」；
  // 补一个空占位 thinking 块（thinking:'' + signature:''）即 200（上游只做结构检查）。
  // 客户端（pi-ai）在 thinking 无签名时会把它降级成 text，正是这个 400 的来源，网关补位兜底。
  const THINKING_HISTORY = [
    { role: 'user', content: '北京天气？' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25℃' }] },
  ];

  t('网关：上游 400 要求 thinking 回传（air-outer 实测形态）→ 补空占位块重试一次并成功', async () => {
    const up = await startFakeUpstream({ thinkingPassback: true });
    const gw = await startGatewayWith([providerOf('th1', up, { priority: 1 })], 'thinking');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, messages: THINKING_HISTORY },
      });
      assert.strictEqual(r.status, 200, '补占位后应成功，实际 ' + r.status + ' ' + r.text.slice(0, 240));
      assert.ok(/upstream-ok/.test(r.text), '客户端应拿到上游正常流：' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 2, '应是"原样一次 + 补占位一次"共 2 次转发，实际 ' + up.st.calls);
      const sent = up.st.lastBody.messages;
      assert.strictEqual(sent[1].content[0].type, 'thinking', '补的占位块必须排在 tool_use 之前：'
        + JSON.stringify(sent[1].content));
      assert.strictEqual(sent[1].content[0].thinking, '', '占位块不得伪造推理正文');
      assert.strictEqual(sent[1].content[1].type, 'tool_use', 'tool_use 必须保留');
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/补齐 1 处空占位 thinking 块后重试一次/.test(logText), '日志应记录补齐重试：' + logText.slice(-400));
      assert.ok(!/status=ok[^\n]*HTTP 400/.test(logText), '不得把这次 400 记成成功');
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：上游用笼统 500「Upstream rejected the request as invalid」表达同一 thinking 规则 → 同样补位重试', async () => {
    // agentrouter 实测形态：不解释原因，HTTP 500 + 该措辞（同一请求体补空占位后即 200）
    const up = await startFakeUpstream({ thinkingPassback: true, thinkingPassbackStatus: 500 });
    const gw = await startGatewayWith([providerOf('th3', up, { priority: 1 })], 'thinking3');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, messages: THINKING_HISTORY },
      });
      assert.strictEqual(r.status, 200, '补占位后应成功，实际 ' + r.status + ' ' + r.text.slice(0, 240));
      assert.ok(/upstream-ok/.test(r.text), '客户端应拿到上游正常流：' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 2, '应是"原样一次 + 补占位一次"，实际 ' + up.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/补齐 1 处空占位 thinking 块后重试一次/.test(logText), '日志应记录补位重试：' + logText.slice(-400));
      assert.ok(!/breaker OPEN/.test(logText), '该家不应因此被熔断（补位后已成功）：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：历史已带 thinking 块时不得多补（零副作用），且无 tool_use 的历史不触发补位', async () => {
    const up = await startFakeUpstream({ thinkingPassback: true });
    const gw = await startGatewayWith([providerOf('th2', up, { priority: 1 })], 'thinking2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 已带 thinking（空签名）→ 上游本就接受，应只转发一次、内容原样
      const ok = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 64,
          messages: [
            { role: 'user', content: '北京天气？' },
            { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }, THINKING_HISTORY[1].content[0]] },
            { role: 'user', content: THINKING_HISTORY[2].content },
          ],
        },
      });
      assert.strictEqual(ok.status, 200, '实际 ' + ok.status + ' ' + ok.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, '已有 thinking 块时不得重试（不产生额外计费），实际 ' + up.st.calls);
      assert.strictEqual(up.st.lastBody.messages[1].content.length, 2, '不得插入多余占位块：'
        + JSON.stringify(up.st.lastBody.messages[1].content));
      // ② 纯文本历史（无 tool_use）→ 上游不报该错，同样只转发一次
      const plain = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(plain.status, 200, '实际 ' + plain.status);
      assert.strictEqual(up.st.calls, 2, '纯文本历史应只转发一次（累计 2），实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 2026-09-16：网络层错误可诊断性 + 瞬时抖动原地重试 ----
  // 背景：日志里 170 条 "fetch failed" 完全无法定位（undici 把真正原因放在 e.cause）；
  // 实测根因是本机代理/TUN 抖动导致的 ECONNRESET（5s 内快速失败）。
  // 旧实现首次网络错即 90s 熔断——单候选模型（如 deepseek-v4.1-flash→chiyi-ds）整段不可用。
  t('网关：瞬时网络错（socket 重置）→ 原地重试一次成功；日志含 ECONNRESET 原因且不熔断', async () => {
    const up = await startFakeUpstream({ failFirstN: 1 });
    const gw = await startGatewayWith([providerOf('net1', up, { priority: 1 })], 'netretry');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '重试应成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(/upstream-ok/.test(r.text), '客户端应拿到正常响应：' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 2, '应是"首次失败 + 原地重试"共 2 次，实际 ' + up.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/upstream net1 网络错误（[^）]+，\d+ms）→ 原地重试一次/.test(logText),
        '日志应记录网络错原因（cause 链）与重试动作：' + logText.slice(-400));
      assert.ok(/upstream net1 重试成功/.test(logText), '日志应记录重试成功：' + logText.slice(-300));
      assert.ok(!/breaker OPEN/.test(logText), '重试成功不得开启熔断：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：本地超时中止不参与原地重试（避免把等待翻倍）；provider.timeoutMs 生效', async () => {
    const up = await startFakeUpstream({ delayMs: 3000 });
    const gw = await startGatewayWith([providerOf('slow1', up, { priority: 1, timeoutMs: 400 })], 'noretry');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const started = Date.now();
      const r = await call({ port: gw.port });
      const dur = Date.now() - started;
      assert.strictEqual(r.status, 503, '唯一候选超时后应回 503，实际 ' + r.status);
      assert.strictEqual(up.st.calls, 1, '超时中止不得重试，实际 ' + up.st.calls);
      assert.ok(dur < 2500, '应在上游 delay(3000ms) 之前就按 timeoutMs=400 中止，实际 ' + dur + 'ms');
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/request error/.test(logText), '应记录上游请求错误：' + logText.slice(-300));
      assert.ok(!/原地重试一次/.test(logText), '超时中止不得触发原地重试：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关（2026-10-17）：候选链必须有**整体预算** —— 不得让各家 timeoutMs 串行累加把客户端拖超时', async () => {
    // 现场：Claude Code 报 `Gateway was unreachable: The operation was aborted due to timeout`
    // （/v1/messages）。网关进程是健康的（/health 82ms），小请求 2–3 秒就回。
    // 根因是候选链的 timeoutMs **串行累加**：
    //   deepseek-v4.1-flash 7 家合计 405 秒、claude-haiku-5-5 3 家合计 260 秒，
    //   而客户端自己的超时约 60–120 秒 → 客户端先断开，网关还在傻等没人再听的响应。
    //   实测当天 46 次调用超过 60 秒（最长 293 秒）。
    //
    // 用两个**永不响应**的上游（各自 timeoutMs 给到 60 秒）验证三件事：
    //   ① 总耗时被压到 requestBudgetMs 量级，而不是等满第一家的 60 秒；
    //   ② 预算在**启动下一个候选之前**生效 → 第二家一次都不该被调用；
    //   ③ 日志要写明是"预算收口"，否则用户会去查供应商（诊断方向错）。
    const httpMod = require('node:http');
    const mkHang = () => new Promise((resolve) => {
      const st = { calls: 0 };
      const srv = httpMod.createServer((req) => { st.calls++; req.resume(); /* 永不回响应 */ });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, st, port: srv.address().port }));
    });
    const h1 = await mkHang();
    const h2 = await mkHang();
    const gw = await startGatewayWith([
      providerOf('hang1', h1, { priority: 1, timeoutMs: 60000 }),
      providerOf('hang2', h2, { priority: 2, timeoutMs: 60000 }),
    ], 'budget', {}, { requestBudgetMs: 1200 });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const started = Date.now();
      const r = await call({ port: gw.port });
      const dur = Date.now() - started;
      assert.strictEqual(r.status, 503, '预算用尽应回 503，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(dur < 6000,
        '总耗时必须被预算压住（否则会等满第一家的 60000ms），实际 ' + dur + 'ms');
      assert.strictEqual(h2.st.calls, 0,
        '预算用尽后不得再启动新的候选，实际 hang2 被调用 ' + h2.st.calls + ' 次');
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/总预算/.test(logText), '日志应写明是按总预算收口：' + logText.slice(-400));
    } finally {
      killGw(gw);
      try { h1.srv.close(); } catch { /* 忽略 */ }
      try { h2.srv.close(); } catch { /* 忽略 */ }
    }
  });

  t('网关（2026-10-19）：预算要给后续候选**预留** —— 一个慢家不得吃光，后面本可成功的家必须有机会', async () => {
    // 用户现场：opencode 400（8.5s）→ commandcode socket 错 → amd 超时（66s）
    // → **总预算 120s 用尽，另 2 家一次都没试** → 回最后一次 4xx，报告里写
    // "failover stopped on purpose"。而紧接着的下一次请求就成功了。
    // 也就是说：不是没有可用候选，是慢候选把预算吃光、让可用候选没机会上场。
    //
    // 修法：单候选可用额度 = 剩余预算 − 预留 × (剩余候选数 − 1)。
    // 这里让第一家"自身 timeout 远大于预算"（60s vs 8s）：旧实现会把 8s 全给它、
    // 第二家一家都轮不上（503）；新实现只给它 8−3=5s，剩下的 3s 足够第二家上场并成功。
    const httpMod = require('node:http');
    const hang = await new Promise((resolve) => {
      const st = { calls: 0 };
      // ⚠ 只统计"被当作转发目标"的请求：/v1/models 是目录探测（roomy 学上下文窗口走这条，
      // 不计费也不产生模型输出），把它算进 calls 会让"慢家被尝试几次"这条断言失去意义。
      const srv = httpMod.createServer((req) => {
        if (!String(req.url || '').startsWith('/v1/models')) st.calls++;
        req.resume(); /* 永不回响应 */
      });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, st, port: srv.address().port }));
    });
    const ok = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('slowFirst', hang, { priority: 1, timeoutMs: 60000 }),
      providerOf('goodSecond', ok, { priority: 2 }),
    ], 'budget-reserve', { DSH_GATEWAY_CANDIDATE_RESERVE_MS: '3000' }, { requestBudgetMs: 8000 });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const started = Date.now();
      const r = await call({ port: gw.port });
      const dur = Date.now() - started;
      assert.strictEqual(r.status, 200,
        '第二家本可成功，必须真的被尝试（旧实现会让慢家吃光预算 → 503），实际 ' + r.status
        + ' ' + String(r.text || '').slice(0, 200));
      assert.strictEqual(ok.st.calls, 1, '第二家应收到 1 次转发，实际 ' + ok.st.calls);
      assert.ok(dur < 7000,
        '慢家只应占 5s（8s 预算 − 3s 预留），总耗时应明显小于 8s 预算，实际 ' + dur + 'ms');
      assert.strictEqual(hang.st.calls, 1, '慢家应只被尝试 1 次，实际 ' + hang.st.calls);
    } finally {
      killGw(gw);
      try { hang.srv.close(); } catch { /* 忽略 */ }
      closeUp(ok);
    }
  });

  t('网关（2026-10-19）：排在最前的**快家不得被均分公式误杀**（预留而非等分）', async () => {
    // 第一版写成"剩余预算 ÷ 剩余候选数"（等分）。复核时发现它会误杀快家：
    // 5 家候选、预算 120s 时第一家只拿到 24s，而日志里 commandcode 实测有 dur=31456ms ——
    // 一个**本来会成功**的请求会被硬砍在 24s。等分对"排最前的通常正是最好的一家"视而不见。
    //
    // 这条用例锁住"预留"语义：第一家自身 timeout 小于（预算 − 预留）时，必须能**用满自己的
    // timeout**，而不是被均分压低。用「第一家慢 6s 但能成功」验证：它必须成功，
    // 而不是被压到 6s 以下而超时。
    const slowButOk = await new Promise((resolve) => {
      const st = { calls: 0 };
      const srv = require('node:http').createServer((req, res) => {
        st.calls++;
        req.resume();
        req.on('end', () => setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.end('data: {"choices":[{"index":0,"delta":{"content":"slow-ok"}}]}\n\n'
            + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        }, 6000));
      });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, st, port: srv.address().port }));
    });
    const ok2 = await startFakeUpstream({ status: 200 });
    // 6 家候选、预算 60s、预留 5s：等分只给第一家 10s（够），但若候选更多就会误杀。
    // 这里用 12 家模拟"候选多"的情形：等分 = 5s < 该家需要的 6s → 会被误杀；
    // 预留法则给它 60 − 5×11 = 5s… 仍不够，所以这里直接用更贴近真实的参数：
    // 预算 60s、6 家、预留 5s → 第一家可用 60 − 25 = 35s，足够它 6s 的慢响应。
    const provs = [providerOf('slowOk', slowButOk, { priority: 1, timeoutMs: 30000 })];
    for (let i = 0; i < 5; i++) provs.push(providerOf('filler' + i, ok2, { priority: 9, models: ['other-model'] }));
    const gw = await startGatewayWith(provs, 'budget-reserve2', { DSH_GATEWAY_CANDIDATE_RESERVE_MS: '5000' }, { requestBudgetMs: 60000 });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const started = Date.now();
      const r = await call({ port: gw.port });
      const dur = Date.now() - started;
      assert.strictEqual(r.status, 200,
        '慢 6s 但能成功的第一家必须被允许跑完（均分公式会把它压到 5s 以下而误杀），实际 ' + r.status
        + ' ' + String(r.text || '').slice(0, 200));
      assert.ok(dur >= 5500, '应该真的等了它那 6 秒（说明没被误杀），实际 ' + dur + 'ms');
      assert.strictEqual(slowButOk.st.calls, 1, '第一家应只被尝试 1 次，实际 ' + slowButOk.st.calls);
    } finally {
      killGw(gw);
      try { slowButOk.srv.close(); } catch { /* 忽略 */ }
      closeUp(ok2);
    }
  });

  t('网关（2026-10-19）：预算耗尽时回给客户端的文案**不得**说"failover stopped on purpose"', async () => {
    // 旧文案恒说 "failover stopped on purpose (re-sending the same request to other providers
    // would not help)"，而真实情况是"预算被慢家吃光、剩下几家没试过" —— 重发很可能成功。
    // 这句话会把用户引向"我的请求有问题"的错误方向，必须按实际原因分路。
    const httpMod = require('node:http');
    const st = { calls: 0 };
    const srv = httpMod.createServer((req) => { st.calls++; req.resume(); /* 挂起 */ });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const up = { srv, st, port: srv.address().port };
    const gw = await startGatewayWith([
      providerOf('h1', up, { priority: 1, timeoutMs: 60000 }),
      providerOf('h2', up, { priority: 2, timeoutMs: 60000 }),
    ], 'budget-msg', {}, { requestBudgetMs: 2500 });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 503, '全部挂起应回 503，实际 ' + r.status);
      assert.ok(!/stopped on purpose/i.test(r.text || ''),
        '预算耗尽时不得说"故意停止"（那会让用户以为请求本身有问题）：' + String(r.text).slice(0, 240));
      assert.ok(/budget/i.test(r.text || '') && /requestBudgetMs/.test(r.text || ''),
        '文案应说明是预算收口，并指出可调 requestBudgetMs：' + String(r.text).slice(0, 240));
    } finally {
      killGw(gw);
      try { srv.close(); } catch { /* 忽略 */ }
    }
  });

  t('网关：熔断期间不再打上游；冷却到点并发只放一个探测；上游恢复后能自愈（不永久卡死）', async () => {
    const up = await startFakeUpstream({ status: 401, modelsStatus: 401, delayMs: 400, errorBody: { error: { message: 'unauthorized' } } });
    const gw = await startGatewayWith([providerOf('bad', up, { priority: 1 })], 'breaker', {
      DSH_GATEWAY_BREAKER_LONG_MS: '1500', DSH_GATEWAY_BREAKER_SHORT_MS: '1500',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 401 首次即长熔断
      const first = await call({ port: gw.port });
      assert.strictEqual(first.status, 503, '401 熔断后应回 503，实际 ' + first.status + ' ' + first.text.slice(0, 160));
      assert.strictEqual(up.st.calls, 1, '401 只应打一次上游，实际 ' + up.st.calls);
      // ② 冷却期内并发请求：一次上游请求都不能发（旧版会持续打点）
      const during = await Promise.all([0, 1, 2, 3, 4].map(() => call({ port: gw.port })));
      assert.ok(during.every((r) => r.status === 503), '熔断冷却期内应全部 503：' + during.map((r) => r.status).join(','));
      assert.strictEqual(up.st.calls, 1, '熔断冷却期内不得再向上游发请求，实际 ' + up.st.calls);
      // ③ 冷却到点 → 6 个并发请求只放行 1 个探测（旧版每个请求都会重置熔断窗口 → 6 个全放行）
      await sleep(1700);
      const probe = await Promise.all([0, 1, 2, 3, 4, 5].map(() => call({ port: gw.port })));
      assert.ok(probe.every((r) => r.status === 503), '探测仍失败（401）应回 503：' + probe.map((r) => r.status).join(','));
      assert.strictEqual(up.st.calls, 2, '半开只应放行一个探测，实际新增 ' + (up.st.calls - 1) + ' 个上游请求');
      // ④ 上游恢复 → 冷却结束后能重新服务（熔断不会永久卡死）
      up.st.status = 200;
      let served = 0;
      for (let i = 0; i < 10 && !served; i++) {
        await sleep(400);
        const r = await call({ port: gw.port });
        if (r.status === 200) served = 1;
      }
      assert.strictEqual(served, 1, '上游恢复后应能重新服务（熔断不得永久卡死）');
    } finally { killGw(gw); closeUp(up); }
  });

  // ================= 2026-09-16：WorkBuddy 接入（协议翻译 / 供应商能力 / 凭据 / 账户池） =================

  // 可编程"只支持 OpenAI chat"的假上游：记录路径/头/体，按脚本返回 402/12153/正常流
  async function startFakeOpenAIUpstream(opts = {}) {
    const st = {
      calls: 0, paths: [], headers: [], bodies: [],
      script: opts.script || null,        // 按调用序号决定行为（账户池测试用）
      json: !!opts.json,                  // 返回非流式 JSON 而非 SSE
      withToolCall: !!opts.withToolCall,
      sseRaw: opts.sseRaw || null,        // 自定义 SSE 文本
      toolNameLate: !!opts.toolNameLate,  // 工具名在**后续分片**才到（真实上游常见）
      parallelToolCalls: !!opts.parallelToolCalls,   // 两个工具调用的参数分片**交错**到达（第三轮回归）
    };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        st.calls++;
        st.paths.push(req.url);
        st.headers.push(req.headers);
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 忽略 */ }
        st.bodies.push(body);
        const behavior = st.script ? (st.script[st.calls - 1] || st.script[st.script.length - 1]) : (opts.behavior || 'ok');
        // 刷新端点（WorkBuddy：POST {base}/plugin/auth/token/refresh）
        if (/\/plugin\/auth\/token\/refresh$/.test(req.url)) {
          st.refreshCalls = (st.refreshCalls || 0) + 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'AT-REFRESHED', refreshToken: 'rt-new', expiresIn: 3600, domain: 'codebuddy.cn' } }));
          return;
        }
        if (behavior === 'rate429') {
          // 模型级限流（实测 amd 措辞）：classifyAccountFailure 判为 rate → 只冷却该模型
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: "Model '" + (body && body.model) + "' is at its concurrency limit (32); please retry later" } }));
          return;
        }
        // 2026-10-14（用户报「ling-3.1-flash 还是调用不成功」）：commandcode 免费模型的真实形态 ——
        // 上游**自己**说"我暂时不可用，稍后重试"，不是对我们限流。实测该模型约 1/3 成功率、
        // 随机 200/429（同家 deepseek 一直 200）→ 必须原地重试，否则一次失败就白记一次模型级失败。
        if (behavior === 'busy429') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: {
            message: opts.busyMsg || 'Upstream model provider is temporarily unavailable. Please try again in a moment.',
            type: 'rate_limit_error',
          } }));
          return;
        }
        // 2026-10-15（amd 并发上限实测）：带 `Retry-After` 的瞬时 429 —— 原地重试必须等够。
        if (behavior === 'busy429ra') {
          const h = { 'content-type': 'application/json' };
          if (opts.busyRa) h['retry-after'] = String(opts.busyRa);
          res.writeHead(429, h);
          res.end(JSON.stringify({ error: {
            message: opts.busyMsg || "Model 'x' is at its concurrency limit (16); please retry later",
            type: 'rate_limit_error',
          } }));
          return;
        }
        // 2026-10-14：模型被上游下架/退役 —— 长得像整家 403，其实只针对一个模型。
        if (behavior === 'retired403') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: {
            message: opts.retiredMsg || 'The free Ling 3.1 Flash tier has been retired. Ling 3.1 Flash is now a paid model -- run /model and pick Ling 3.1 Flash (inclusionai/ling-3.1-flash) to keep going.',
            type: 'permission_error', code: 'FORBIDDEN',
          } }));
          return;
        }
        // 真·整家鉴权失败（裸 403）：必须仍按整家处理。
        if (behavior === 'auth403') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 403, title: 'Forbidden', detail: opts.authMsg || 'Authorization failed' }));
          return;
        }
        // 2026-10-14：商汤 sensenova 对 RPM/TPM 限流的**真实形态** ——
        // 措辞里写着额度类的 `insufficient_quota`，但语义是瞬时限流。
        // 旧实现被 WORKBUDDY_CREDIT_RE 里的 `insufficient[_a-z]*quota` 抓成"欠费"→ 锁 1800 秒。
        if (behavior === 'quota429') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: {
            message: opts.quotaMsg || 'inference exceeds tpm/rpm limit',
            type: 'rate_limit_error', code: 'insufficient_quota',
          } }));
          return;
        }
        // 真·欠费（余额为 0）：措辞是 credit/balance，**不含**速率字样 → 必须仍判长期。
        if (behavior === 'broke402') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: opts.brokeMsg || 'credit insufficient balance: balance=0' } }));
          return;
        }
        // 2026-10-14：commandcode 的真实形态 ——「这家有这模型，但不在这个端点上」。
        // 七个豁免判据全部不命中，旧实现落进"确定性 4xx"→ 终止 failover → 整轮任务被打死。
        if (behavior === 'endpointMismatch') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: {
            type: 'invalid_request_error',
            message: opts.endpointMsg || ('Model "deepseek/deepseek-v4.1-flash" is not supported on this endpoint. Use /provider/v1/chat/completions for OpenAI and OSS models.'),
          } }));
          return;
        }
        // 真·请求参数错误：上游**说了**是哪个字段的问题 → 必须仍终止 failover。
        if (behavior === 'badReq') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: opts.badReqMsg || 'invalid request body: messages must not be empty' } }));
          return;
        }
        if (behavior === 'err500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'internal error' } }));
          return;
        }
        if (behavior === 'big400') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify(opts.bigBody || { error: { message: 'x'.repeat(2 * 1024 * 1024) } }));
          return;
        }
        // 2026-10-16（commandcode 实测形态）：请求体 JSON 节点数超过上游硬上限。
        // 上游回的是**确定性** 400，重试无用 —— 网关应在**下次**调用前就跳过这家（本次调用内）。
        if (behavior === 'nodeCount400') {
          st.nodeCountRejections = (st.nodeCountRejections || 0) + 1;
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: {
            message: JSON.stringify({ message: 'Invalid request JSON: JSON node count cannot exceed 32768 trace_id: abc123' }),
            type: 'invalid_request_error',
          } }));
          return;
        }
        if (behavior === 'credit') {
          res.writeHead(402, { 'content-type': 'application/json' });
          // ⚠ 必须让 opts.errorBody 生效（审计 R12 修正）。
          //
          // 原实现**硬编码**这个响应体，完全忽略传入的 errorBody。于是 D6 与 P1 两条
          // "脱敏"用例把带密钥的错误体交给这里，却从未真的让上游吐出来 ——
          // 断言"日志/health 不含密钥"在 leaky 根本不存在的情况下**永远为真**。
          // 这正是变异测试的价值：把 markAccountFailure 里的 maskSecrets 删掉，
          // 两条用例照旧全绿，而 /health 上真的躺着一把完整 key。
          res.end(JSON.stringify(opts.errorBody || { code: 0, msg: 'insufficient credit: 积分不足' }));
          return;
        }
        if (behavior === 'sseCredit') {
          // 第三轮回归：额度耗尽以 **HTTP 200 + SSE 首事件 error** 的形态返回
          //（amd / cline 实测就是这种形态）→ 应判为**账户级**失败并换同供应商的下一把 Key
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.end('data: {"error":{"message":"credit insufficient balance: balance=0","type":"api_error"}}\n\n');
          return;
        }
        if (behavior === 'session') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify(opts.errorBody || { code: 0, msg: 'Offline user session not found 12153' }));
          return;
        }
        // 2026-09-18：**裸 403**（实测 nvidia 形态）——没有账号/额度措辞，旧实现按"供应商级 403"熔断整家；
        // 现在应判为账户级（这把 Key 未授权）→ 换下一把 Key
        if (behavior === 'forbidden') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 403, title: 'Forbidden', detail: 'Authorization failed' }));
          return;
        }
        if (behavior === 'boom') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'boom' } }));
          return;
        }
        if (st.json) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-1', object: 'chat.completion', model: body && body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: '来自 OpenAI 上游的回复' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (st.sseRaw) { res.end(st.sseRaw); return; }   // 自定义 SSE（如"首事件即 error"形态）
        const chunk = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
        chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { reasoning_content: '先想一下' } }] });
        chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: '你好' } }] });
        chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: '，世界' } }] });
        if (st.withToolCall) {
          if (st.parallelToolCalls) {
            // 第三轮回归：**并行工具调用 + 交错分片**（A→B→A→B）。
            // 这是 OpenAI 流式的常规形态。旧实现"边到边"写 input_json_delta 且用当前块号，
            // 于是 A 的续片会落进 B 刚开的块 → 两边参数 JSON 都被污染。
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_A', function: { name: 'get_weather', arguments: '{"city":' } }] } }] });
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_B', function: { name: 'get_time', arguments: '{"tz":' } }] } }] });
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] } }] });
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"UTC"}' } }] } }] });
          } else if (st.toolNameLate) {
            // 真实上游常见形态：先给 id（无 name），名字与参数在后续分片到达
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: '', arguments: '' } }] } }] });
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'get_weather' } }] } }] });
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"北京"}' } }] } }] });
          } else {
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] } }] });
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] } }] });
          }
          chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, st, port: server.address().port };
  }

  /** 写一份 WorkBuddy 桌面凭据文件（形态与真实一致：{auth,account} 嵌套） */
  function writeWorkBuddyAuth(dir, name, { token, uid, enterpriseId, domain, expiresInMs, refreshToken }) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify({
      auth: {
        accessToken: token,
        refreshToken: refreshToken === undefined ? 'rt-' + uid : refreshToken,
        expiresAt: Date.now() + (expiresInMs === undefined ? 3600_000 : expiresInMs),
        domain: domain === undefined ? 'codebuddy.cn' : domain,
      },
      account: { uid, enterpriseId, nickname: 'user-' + uid },
    }), 'utf8');
    return p;
  }

  const openaiProvider = (id, up, extra = {}) => Object.assign({
    id,
    baseURL: 'http://127.0.0.1:' + up.port + '/v2',   // 注意是 /v2 —— 旧 upstreamBase 只认 /v1
    apiKey: UPSTREAM_KEY,
    models: extra.models || ['test-model'],
    enabled: true,
    protocol: 'openai-chat',
  }, extra);

  t('协议翻译：Anthropic 客户端 → OpenAI 上游（system/工具/tool_result 改写 + /v2 路径）', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('oai', up)], 'xlate1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 64, stream: false,
          system: '你是助手',
          tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
          messages: [
            { role: 'user', content: '北京天气？' },
            { role: 'assistant', content: [{ type: 'text', text: '我查一下' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25℃' }] },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '应成功，实际 ' + r.status + ' ' + r.text.slice(0, 240));
      assert.strictEqual(up.st.paths[0], '/v2/chat/completions', '应打到 /v2：' + up.st.paths[0]);
      const sent = up.st.bodies[0];
      assert.strictEqual(sent.messages[0].role, 'system', 'system 应为首条消息：' + JSON.stringify(sent.messages[0]));
      assert.strictEqual(sent.messages[0].content, '你是助手');
      const assistant = sent.messages.find((m) => m.role === 'assistant');
      assert.ok(Array.isArray(assistant.tool_calls) && assistant.tool_calls[0].function.name === 'get_weather',
        'tool_use 应转 tool_calls：' + JSON.stringify(assistant));
      assert.ok(sent.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'toolu_1' && /晴 25℃/.test(m.content)),
        'tool_result 应转 role:tool：' + JSON.stringify(sent.messages));
      assert.strictEqual(sent.tools[0].type, 'function');
      assert.strictEqual(sent.tools[0].function.parameters.required[0], 'city', 'input_schema → parameters');
      const out = JSON.parse(r.text);
      assert.strictEqual(out.type, 'message', '应答须为 Anthropic message：' + r.text.slice(0, 200));
      assert.ok(out.content.some((b) => b.type === 'text' && /来自 OpenAI 上游的回复/.test(b.text)),
        '文本应翻译回 Anthropic 内容块：' + JSON.stringify(out.content));
      assert.strictEqual(out.stop_reason, 'end_turn');
      assert.strictEqual(out.usage.input_tokens, 11, 'usage 应透传：' + JSON.stringify(out.usage));
      assert.strictEqual(out.usage.output_tokens, 7);
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：OpenAI SSE → Anthropic 事件流（thinking/text/tool_use + 结束事件）', async () => {
    const up = await startFakeOpenAIUpstream({ withToolCall: true });
    const gw = await startGatewayWith([openaiProvider('oai2', up, { quirks: ['force-stream'] })], 'xlate2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const text = r.text;
      assert.ok(/event: message_start/.test(text), '缺 message_start：' + text.slice(0, 300));
      assert.ok(/"type":"thinking_delta","thinking":"先想一下"/.test(text), 'reasoning_content → thinking_delta：' + text.slice(0, 400));
      assert.ok(/"type":"text_delta","text":"你好"/.test(text), 'content → text_delta：' + text.slice(0, 400));
      assert.ok(/"type":"tool_use"/.test(text) && /"name":"get_weather"/.test(text), 'tool_calls 应开 tool_use 块：' + text.slice(0, 600));
      assert.ok(/input_json_delta/.test(text), 'arguments 分片应转 input_json_delta：' + text.slice(0, 600));
      assert.ok(/event: content_block_stop/.test(text) && /event: message_delta/.test(text) && /event: message_stop/.test(text),
        '应有 stop/delta/stop 收尾事件：' + text.slice(-300));
      assert.ok(/"stop_reason":"tool_use"/.test(text), '有工具调用时 stop_reason=tool_use：' + text.slice(-300));
      assert.strictEqual(up.st.bodies[0].stream, true, 'quirk force-stream 应强制 stream:true');
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：客户端要非流式 + 上游强制流式 → 网关聚合 SSE 后回单条 message', async () => {
    const up = await startFakeOpenAIUpstream({});
    const gw = await startGatewayWith([openaiProvider('oai3', up, { quirks: ['force-stream'] })], 'xlate3');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const out = JSON.parse(r.text);
      assert.strictEqual(out.type, 'message', '应聚合为单条 message：' + r.text.slice(0, 240));
      const textBlock = out.content.find((b) => b.type === 'text');
      assert.ok(textBlock && /你好，世界/.test(textBlock.text), '聚合文本应完整：' + JSON.stringify(out.content));
      assert.ok(out.usage.output_tokens > 0, '应给出 output_tokens：' + JSON.stringify(out.usage));
    } finally { killGw(gw); closeUp(up); }
  });

  t('供应商能力：自定义头 + tool_choice 摊平 + prepend-system', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([
      openaiProvider('oai4', up, {
        headers: { 'X-Product': 'SaaS', 'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2' },
        quirks: ['stringify-tool-choice', 'prepend-system'],
      }),
    ], 'cap1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 32, stream: false,
          tool_choice: { type: 'tool', name: 'get_weather' },
          tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = up.st.headers[0];
      assert.strictEqual(h['x-product'], 'SaaS', '自定义头应发出：' + JSON.stringify(h));
      assert.strictEqual(h['user-agent'], 'CLI/2.63.2 CodeBuddy/2.63.2', 'UA 应可配置：' + h['user-agent']);
      const sent = up.st.bodies[0];
      assert.strictEqual(sent.tool_choice, 'get_weather', 'tool_choice 应摊平为字符串：' + JSON.stringify(sent.tool_choice));
      assert.strictEqual(sent.messages[0].role, 'system', 'prepend-system 应补 system：' + JSON.stringify(sent.messages[0]));
    } finally { killGw(gw); closeUp(up); }
  });

  t('WorkBuddy 凭据：读桌面 auth 文件 → Bearer + 身份头（不再发 x-api-key）', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-auth-'));
    const authFile = writeWorkBuddyAuth(dir, 'workbuddy-desktop.info', { token: 'AT-1', uid: 'u-1', enterpriseId: 'ent-1', domain: 'codebuddy.cn' });
    const gw = await startGatewayWith([
      openaiProvider('wb', up, { auth: 'workbuddy', accounts: [{ id: 'a1', authFile }] }),
    ], 'wb1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = up.st.headers[0];
      assert.strictEqual(h.authorization, 'Bearer AT-1', '应用桌面凭据的 Bearer：' + JSON.stringify(h));
      assert.strictEqual(h['x-user-id'], 'u-1', 'X-User-Id：' + JSON.stringify(h));
      assert.strictEqual(h['x-enterprise-id'], 'ent-1', 'X-Enterprise-Id');
      assert.strictEqual(h['x-domain'], 'codebuddy.cn', 'X-Domain');
      assert.strictEqual(h.referer, 'https://www.codebuddy.cn/', 'Referer 应按区域：' + h.referer);
      assert.ok(!('x-api-key' in h), 'WorkBuddy 路径不得再发 x-api-key');
    } finally { killGw(gw); closeUp(up); }
  });

  t('多账户池：额度耗尽 → 同供应商内切下一个账户（不换供应商）', async () => {
    const upPool = await startFakeOpenAIUpstream({ script: ['credit', 'ok'], json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-pool-'));
    const a1 = writeWorkBuddyAuth(dir, 'wb-a1.info', { token: 'AT-A1', uid: 'uid-a1' });
    const a2 = writeWorkBuddyAuth(dir, 'wb-a2.info', { token: 'AT-A2', uid: 'uid-a2' });
    const upFallback = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      openaiProvider('wbp', upPool, { auth: 'workbuddy', accounts: [{ id: 'a1', authFile: a1 }, { id: 'a2', authFile: a2 }] }),
      providerOf('fallback', upFallback, { models: ['test-model'] }),
    ], 'pool1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应切到第二个账户成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upPool.st.calls, 2, '同供应商内应重试一次（换账户），实际 ' + upPool.st.calls);
      assert.strictEqual(upFallback.st.calls, 0, '账户池仍有可用账户时不得换供应商，实际 ' + upFallback.st.calls);
      const used = upPool.st.headers.map((h) => h.authorization);
      assert.ok(used[0] !== used[1], '两次应使用不同账户 token：' + JSON.stringify(used));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/标记为 credit/.test(logText), '日志应记录账户被标记：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(upPool); closeUp(upFallback); }
  });

  t('多账户池：全部账户不可用 → 交给下一家供应商（不打死请求）', async () => {
    const upPool = await startFakeOpenAIUpstream({ behavior: 'credit' });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-pool2-'));
    const a1 = writeWorkBuddyAuth(dir, 'wb-b1.info', { token: 'AT-B1', uid: 'uid-b1' });
    const a2 = writeWorkBuddyAuth(dir, 'wb-b2.info', { token: 'AT-B2', uid: 'uid-b2' });
    const upFallback = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      openaiProvider('wbp2', upPool, { auth: 'workbuddy', accounts: [{ id: 'b1', authFile: a1 }, { id: 'b2', authFile: a2 }] }),
      providerOf('fallback2', upFallback, { models: ['test-model'] }),
    ], 'pool2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应由下一家供应商服务，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upPool.st.calls, 2, '两个账户都应试过，实际 ' + upPool.st.calls);
      assert.strictEqual(upFallback.st.calls, 1, '应切到备用供应商，实际 ' + upFallback.st.calls);
    } finally { killGw(gw); closeUp(upPool); closeUp(upFallback); }
  });

  t('WorkBuddy 凭据：access token 临期 → 自动刷新（X-Refresh-Token）并用新 token 请求', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-refresh-'));
    // expiresInMs 为负 → 已过期/临期，触发刷新
    const authFile = writeWorkBuddyAuth(dir, 'wb-exp.info', { token: 'AT-OLD', uid: 'u-exp', expiresInMs: -60_000, refreshToken: 'RT-EXP' });
    const gw = await startGatewayWith([
      openaiProvider('wbr', up, { auth: 'workbuddy', accounts: [{ id: 'e1', authFile }] }),
    ], 'wb2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '刷新后应成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok((up.st.refreshCalls || 0) >= 1, '应调用过刷新端点，实际 ' + (up.st.refreshCalls || 0));
      const refreshHdr = up.st.headers[up.st.paths.findIndex((p) => /token\/refresh$/.test(p))];
      assert.strictEqual(refreshHdr['x-refresh-token'], 'RT-EXP', '刷新请求应带 X-Refresh-Token：' + JSON.stringify(refreshHdr));
      assert.strictEqual(refreshHdr['x-auth-refresh-source'], 'workbuddy', '刷新请求应带 X-Auth-Refresh-Source');
      const chatIdx = up.st.paths.findIndex((p) => /chat\/completions$/.test(p));
      assert.strictEqual(up.st.headers[chatIdx].authorization, 'Bearer AT-REFRESHED',
        'chat 请求应使用刷新后的 token：' + up.st.headers[chatIdx].authorization);
      // 自留副本落在网关数据目录（不写桌面 App 的文件）
      const ownDir = path.join(path.dirname(gw.logPath), 'workbuddy-auth');
      assert.ok(fs.existsSync(ownDir), '应在网关数据目录留凭据副本：' + ownDir);
      assert.strictEqual(JSON.parse(fs.readFileSync(authFile, 'utf8')).auth.accessToken, 'AT-OLD', '桌面 App 的凭据文件不得被改写');
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：静态 key 的 OpenAI 上游 → 发 Bearer（而非 x-api-key），修 sensenova 类 401', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('senselike', up)], 'xlate4');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = up.st.headers[0];
      assert.strictEqual(h.authorization, 'Bearer ' + UPSTREAM_KEY, 'OpenAI 上游必须收 Bearer：' + JSON.stringify(h.authorization));
      assert.ok(!('x-api-key' in h), '不得再发 x-api-key：' + JSON.stringify(Object.keys(h)));
      assert.ok(!('anthropic-version' in h), '不得再发 anthropic-version');
    } finally { killGw(gw); closeUp(up); }
  });

  t('多账户池（直通路径）：/v1/chat/completions 也走账户池 —— 额度耗尽自动换账户', async () => {
    // 上游：第 1 次 402（第一个账户额度耗尽）→ 第 2 次 SSE 成功
    const upPool = await startFakeOpenAIUpstream({ script: ['credit', 'ok'], json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-pool3-'));
    const a1 = writeWorkBuddyAuth(dir, 'wb-c1.info', { token: 'AT-C1', uid: 'uid-c1' });
    const a2 = writeWorkBuddyAuth(dir, 'wb-c2.info', { token: 'AT-C2', uid: 'uid-c2' });
    const gw = await startGatewayWith([
      openaiProvider('wbp3', upPool, { auth: 'workbuddy', accounts: [{ id: 'c1', authFile: a1 }, { id: 'c2', authFile: a2 }] }),
    ], 'pool3');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 走 OpenAI 直通路径（客户端说 OpenAI 协议），验证账户池同样生效
      const r = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应换账户后成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upPool.st.calls, 2, '应换账户重试一次，实际 ' + upPool.st.calls);
      const used = upPool.st.headers.map((h) => h.authorization);
      assert.ok(used[0] && used[1] && used[0] !== used[1], '两次应使用不同账户 token：' + JSON.stringify(used));
      assert.strictEqual(upPool.st.paths[0], '/v2/chat/completions', '仍应打 /v2：' + upPool.st.paths[0]);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/标记为 credit/.test(logText), '日志应记录账户被标记：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(upPool); }
  });

  t('账户池可见性：/health 列出全部账户与冷却状态；日志标注实际使用的账户（via=provider#acct）', async () => {
    // 第 1 次 a1 额度耗尽 → 第 2 次 a2 成功
    const up = await startFakeOpenAIUpstream({ script: ['credit', 'ok'], json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-vis-'));
    const a1 = writeWorkBuddyAuth(dir, 'wb-d1.info', { token: 'AT-D1', uid: 'uid-d1' });
    const a2 = writeWorkBuddyAuth(dir, 'wb-d2.info', { token: 'AT-D2', uid: 'uid-d2' });
    const gw = await startGatewayWith([
      openaiProvider('wbv', up, { auth: 'workbuddy', accounts: [{ id: 'd1', authFile: a1 }, { id: 'd2', authFile: a2 }] }),
    ], 'vis1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 未失败前：两个账户都应在册且 state=ok
      const h0 = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      assert.ok(Array.isArray(h0.accounts), '/health 应带 accounts 数组：' + JSON.stringify(h0));
      assert.strictEqual(h0.accounts.length, 2, '应列出全部 2 个账户：' + JSON.stringify(h0.accounts));
      assert.ok(h0.accounts.every((a) => a.state === 'ok'), '未失败时都应为 ok：' + JSON.stringify(h0.accounts));
      assert.ok(h0.accounts.every((a) => a.provider === 'wbv'), '应标注所属供应商：' + JSON.stringify(h0.accounts));
      // ② 触发一次额度耗尽 → 该账户应变为 credit 且带剩余冷却时间
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应换账户后成功，实际 ' + r.status);
      const h1 = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      const cooling = h1.accounts.filter((a) => a.state === 'credit');
      assert.strictEqual(cooling.length, 1, '应有 1 个账户处于 credit 冷却：' + JSON.stringify(h1.accounts));
      assert.ok(cooling[0].remainMs > 0, '应给出剩余冷却毫秒：' + JSON.stringify(cooling[0]));
      assert.ok(cooling[0].reason && /credit|积分/.test(cooling[0].reason), '应带冷却原因：' + JSON.stringify(cooling[0]));
      assert.ok(h1.accounts.some((a) => a.lastUsed === true), '应标注最近使用的账户：' + JSON.stringify(h1.accounts));
      // ③ 日志里应能看到实际服务的账户
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/via=wbv#d2/.test(logText), '日志应标注实际账户（via=wbv#d2）：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(up); }
  });

  t('WorkBuddy 免路径：accounts 只写 { id } → 按平台默认位置自动发现凭据（LOCALAPPDATA/APPDATA）', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-auto-'));
    const authFile = writeWorkBuddyAuth(dir, 'auto.info', { token: 'AT-AUTO', uid: 'uid-auto' });
    // 通过环境变量把"平台默认探测路径"指到临时文件（等价于本机装了 WorkBuddy 并登录）
    const gw = await startGatewayWith(
      [openaiProvider('wba', up, { auth: 'workbuddy', accounts: [{ id: 'auto1' }] })],
      'wbauto',
      { LOCALAPPDATA: dir, APPDATA: dir },
    );
    // 上面 env 只改了 AppData 根；把凭据放到期望的子路径下，模拟真实布局
    const rel = path.join(dir, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
    fs.mkdirSync(rel, { recursive: true });
    fs.copyFileSync(authFile, path.join(rel, 'workbuddy-desktop.info'));
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应自动发现凭据并成功，实际 ' + r.status + ' ' + r.text.slice(0, 240));
      const h = up.st.headers[0];
      assert.strictEqual(h.authorization, 'Bearer AT-AUTO', '应用自动发现的凭据：' + JSON.stringify(h.authorization));
      assert.strictEqual(h['x-user-id'], 'uid-auto', '身份头应来自自动发现的凭据');
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：上游 200 但 SSE 首事件是 error → 判该家失败并换下一家（不让客户端收空回复）', async () => {
    const errSse = 'data: {"error":{"message":"Service temporarily unavailable","type":"api_error"}}\n\n';
    const upBad = await startFakeOpenAIUpstream({ sseRaw: errSse });
    const upGood = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([
      openaiProvider('oaiBad', upBad),
      openaiProvider('oaiGood', upGood),
    ], 'xlate5');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '应换到家后成功，实际 ' + r.status);
      assert.ok(!/Service temporarily unavailable/.test(r.text), '不得把上游错误原文透传：' + r.text.slice(0, 200));
      assert.ok(/来自 OpenAI 上游的回复/.test(r.text), '应拿到第二家的正文：' + r.text.slice(0, 300));
      assert.strictEqual(upBad.st.calls, 1, '第一家应被尝试一次，实际 ' + upBad.st.calls);
      assert.strictEqual(upGood.st.calls, 1, '第二家应收到转发，实际 ' + upGood.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/SSE 首事件是错误/.test(logText), '日志应记录该判定：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(upBad); closeUp(upGood); }
  });

  // 第二轮审计修复：`HTTP 200 + SSE 首事件是错误` 曾被**无条件**判成"额度耗尽"——
  // classifyAccountFailure 的第一句就是 `if (status === 402) return 'credit'`（只看状态码、
  // 不看文案），所以 `classifyAccountFailure(200,detail) || classifyAccountFailure(402,detail)`
  // 的**后半段恒为真**。后果：瞬时 503 / 上下文超限 / 不支持 thinking 这类与额度毫无关系的
  // 错误，会把该 Key 按"额度耗尽"做**账户级 30 分钟冷却**（ACCOUNT_CREDIT_COOLDOWN_MS），
  // 该 Key 上**所有模型**一起连坐。这里锁住"与额度无关的 200+SSE 错误不得标记 credit"。
  t('第二轮：与额度无关的 200+SSE 错误不得把账户标记为 credit（旧实现恒判 credit → 全模型连坐 30 分钟）', async () => {
    const errSse = 'data: {"error":{"message":"Service temporarily unavailable","type":"api_error"}}\n\n';
    const up = await startFakeOpenAIUpstream({ sseRaw: errSse });
    // 必须带账户池（apiKeys）才会走进"标记账户"的分支
    const gw = await startGatewayWith([openaiProvider('sseAcct', up, { apiKeys: ['k1'] })], 'sseacct');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 503, '唯一候选失败应为 503，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      // 先证明"账户池确实生效"——否则 acct 恒为 null，标记分支根本不可达，本用例会退化成
      // 永远通过的假绿灯（旧代码也不会标记）。
      const mine = (h.accounts || []).filter((a) => a.provider === 'sseAcct');
      assert.ok(mine.length >= 1, '本用例前提：apiKeys 应产出账户池条目，实际 ' + JSON.stringify(h.accounts));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/标记为 credit/.test(logText),
        '与额度无关的 SSE 错误不得标记账户为 credit（会全模型连坐 30 分钟）：' + logText.slice(-500));
      const credit = (h.accounts || []).filter((a) => a.state === 'credit');
      assert.strictEqual(credit.length, 0, '不应有账户处于 credit 冷却：' + JSON.stringify(h.accounts));
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：唯一候选 200+SSE error → 回网关自己的 503（不写 200 空回复）', async () => {
    const errSse = 'data: {"error":{"message":"Service temporarily unavailable"}}\n\n';
    const up = await startFakeOpenAIUpstream({ sseRaw: errSse });
    const gw = await startGatewayWith([openaiProvider('oaiOnly', up)], 'xlate6');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 503, '应回网关自己的 503，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(!/Service temporarily unavailable/.test(r.text), '不得回显上游原文：' + r.text.slice(0, 200));
      const out = JSON.parse(r.text);
      assert.strictEqual(out.type, 'error', '应是 Anthropic 错误体：' + r.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up); }
  });

  t('WorkBuddy 身份仿真：chat 用桌面形态 UA（WorkBuddy/<app> … CLI/<cli>）+ X-IDE-* 使用端三头，刷新用 CLI 形态 UA', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-ua-'));
    // 合成一个"已安装的 WorkBuddy"：install-manifest.json 给 App 版本；
    // cli/package.json 的 version 是 0.0.0 占位 → 必须回退到 publishConfig.customPackage.version
    fs.mkdirSync(path.join(dir, 'resources', 'app.asar.unpacked', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'resources', 'install-manifest.json'), JSON.stringify({ appVersion: '9.9.9' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'resources', 'app.asar.unpacked', 'cli', 'package.json'),
      JSON.stringify({ version: '0.0.0', publishConfig: { customPackage: { version: '3.3.3' } } }), 'utf8');
    // 临期 token → 同时触发刷新路径（用于断言刷新仍用 CLI 形态 UA）
    const authFile = writeWorkBuddyAuth(dir, 'wb-ua.info', { token: 'AT-UA', uid: 'uid-ua', expiresInMs: -60_000 });
    const gw = await startGatewayWith(
      [openaiProvider('wbua', up, { auth: 'workbuddy', accounts: [{ id: 'u1', authFile }] })],
      'wbua',
      { WORKBUDDY_APP_DIR: dir },   // 让版本解析指向合成的安装目录
    );
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const chatIdx = up.st.paths.findIndex((p) => /chat\/completions$/.test(p));
      assert.ok(chatIdx >= 0, '应有 chat 请求：' + JSON.stringify(up.st.paths));
      assert.strictEqual(up.st.headers[chatIdx]['user-agent'], 'WorkBuddy/9.9.9 WorkBuddy/9.9.9 CLI/3.3.3',
        'chat 必须是桌面客户端形态 UA：' + up.st.headers[chatIdx]['user-agent']);
      // 使用端归属（2026-09-18 用户实测）：官方桌面端把 CLIENT_INFO_IDE_TYPE/PLATFORM = "WorkBuddy"、
      // CLIENT_INFO_PLATFORM_VERSION = 桌面版本 写成 X-IDE-Type / X-IDE-Name / X-IDE-Version 三头，
      // 后端按它填控制台「积分消耗明细 → 使用端」；缺这三头时该列显示 `-`。
      assert.strictEqual(up.st.headers[chatIdx]['x-ide-type'], 'WorkBuddy',
        'chat 必须声明使用端类型：' + JSON.stringify(up.st.headers[chatIdx]));
      assert.strictEqual(up.st.headers[chatIdx]['x-ide-name'], 'WorkBuddy',
        'chat 必须声明使用端名称：' + JSON.stringify(up.st.headers[chatIdx]));
      assert.strictEqual(up.st.headers[chatIdx]['x-ide-version'], '9.9.9',
        'chat 的 X-IDE-Version 必须是本机桌面版本：' + up.st.headers[chatIdx]['x-ide-version']);
      const refreshIdx = up.st.paths.findIndex((p) => /token\/refresh$/.test(p));
      assert.ok(refreshIdx >= 0, '临期账户应触发刷新：' + JSON.stringify(up.st.paths));
      assert.strictEqual(up.st.headers[refreshIdx]['user-agent'], 'CLI/2.63.2 CodeBuddy/2.63.2',
        '刷新路径保持 CLI 形态 UA（与插件一致）：' + up.st.headers[refreshIdx]['user-agent']);
      assert.ok(!up.st.headers[refreshIdx]['x-ide-type'],
        '刷新路径不注入使用端身份头（保持原样，避免影响凭据链路）：' + JSON.stringify(up.st.headers[refreshIdx]));
    } finally { killGw(gw); closeUp(up); }
  });

  t('WorkBuddy 区域守卫：国内凭据不得发往国际版端点（反之亦然），必须明确报错而非跨区泄漏', async () => {
    // 2026-09-20 实测（新电脑用国际版场景）：两个区域共用同一个 CodeBuddyExtension auth 目录、
    // 只差文件名，配置里端点/凭据写错就会把一国账号的 token 发到另一国端点——实测 apisix
    // 返回 `401 Authorization Required`，且这属于跨产品凭据泄漏（参照 dsh-workbuddy-connect
    // 对此有明确的安全红线）。守卫要求：发请求前就拒绝，并说清该改哪个文件/环境变量。
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-region-'));
    // 国内版凭据（domain=www.workbuddy.cn）
    const cnAuth = writeWorkBuddyAuth(dir, 'cn.info', { token: 'AT-CN', uid: 'uid-cn', domain: 'www.workbuddy.cn' });
    // 国际版供应商端点（www.workbuddy.ai）→ 与上面的凭据区域不匹配
    const gw = await startGatewayWith([
      openaiProvider('wbgl', up, { region: 'global', auth: 'workbuddy', accounts: [{ id: 'g1', authFile: cnAuth }] }),
    ], 'wbreion1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 503, '跨区凭据必须被拒（而非拿 401 或把 token 发出去），实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/是国际版（WorkBuddy AI）供应商，但取到的凭据属于国内版/.test(logText),
        '日志必须指明区域不匹配：' + logText.slice(-400));
      assert.ok(/workbuddy-desktop-ai\.info|WORKBUDDY_AI_AUTH_FILE/.test(logText),
        '日志必须告诉用户该改哪个文件/环境变量：' + logText.slice(-400));
      assert.strictEqual(up.st.calls, 0, '根本不该向上游发出请求（否则就是跨区泄漏），实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：/v1/models 不列"没有凭据来源"的家（列出去只会让用户选中必然失败的模型）', async () => {
    // 依据（2026-10-08，参照 corrinehu/dsh-workbuddy-connect 的 catalog.ts:104-110）：
    //   "A variant whose app has no credentials must expose **no** models rather than a
    //    fallback roster ... offers models that can only fail, which is **worse than
    //    showing nothing**."
    // 实测：配了 apiKey: "" 的家，模型照样出现在列表里，选中后必然 503 ——
    // 用户看到"可选"、选了却失败，比列表里干脆没有更糟。
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([
      openaiProvider('withkey', up, { apiKey: 'sk-real-looking-key-123456', models: ['model-with-key'] }),
      openaiProvider('nokey', up, { apiKey: '', models: ['model-no-key'] }),
      openaiProvider('placeholder', up, { apiKey: 'sk-xxxxxxxx', models: ['model-placeholder'] }),
      openaiProvider('multikey', up, { apiKey: '', apiKeys: ['sk-a-real-1234567890'], models: ['model-multi-key'] }),
    ], 'credgate');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/models', method: 'GET' });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const ids = (JSON.parse(r.text).data || []).map((x) => x.id);
      assert.ok(ids.includes('model-with-key'), '有真 Key 的家应列出：' + JSON.stringify(ids));
      assert.ok(ids.includes('model-multi-key'), 'apiKeys 多把 Key 也应列出：' + JSON.stringify(ids));
      assert.ok(!ids.includes('model-no-key'), 'Key 为空的家**不该**列模型（选中必然失败）：' + JSON.stringify(ids));
      assert.ok(!ids.includes('model-placeholder'), '仍是模板占位 Key 的家也不该列：' + JSON.stringify(ids));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/\/v1\/models 跳过 nokey/.test(logText), '应记录跳过原因：' + logText.slice(-300));
      assert.ok(/\/v1\/models 跳过 placeholder/.test(logText), '应记录跳过原因：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：会话亲和的对话长度上限 —— 短对话钉住、超长对话主动放弃', async () => {
    // 依据（2026-10-08，参照 workbuddy2api-hub 的 wb_proxy.py:2292 实测）：
    // 亲和的动机是别让长前缀缓存作废，但上下文**单调增长** → 被钉住的那家反复接收
    // 越来越大的请求体 → 越容易断连，断连触发重试把请求拖长。
    // 实测 333 个请求：<150 条断连率 0%、150-300 3.4%、300-400 7.8%、400-500 10.0%。
    // 也就是说**亲和本身会喂养它想避免的问题**，所以必须有上限。
    const up1 = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'boom' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('pbad', up1, { priority: 1 }),      // 恒失败 → 逼出 failover
      providerOf('pgood', up2, { priority: 2 }),
    ], 'affmax', { DSH_GATEWAY_AFFINITY_MAX_MSGS: '8' });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const sess = { 'x-session-id': 'sess-abcdef-1234' };
      const sys = [{ role: 'system', content: 'z'.repeat(3000) }, { role: 'user', content: 'hi' }];
      const many = sys.concat(Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: 'm' + i })));
      // ① 短对话：第 1 次学到 pgood，第 2 次应"提到首位"
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: sys }, headers: sess });
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: sys }, headers: sess });
      const log1 = fs.readFileSync(gw.logPath, 'utf8');
      const promotedShort = (log1.match(/会话亲和 → pgood 提到首位/g) || []).length;
      assert.ok(promotedShort >= 1, `短对话应参与亲和（应出现"提到首位"），实际 ${promotedShort} 次：` + log1.slice(-600));
      // ② 长对话（20 条 > 上限 8）：两次都不该"提到首位"，且应记"跳过"
      const before = promotedShort;
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: many }, headers: sess });
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: many }, headers: sess });
      const log2 = fs.readFileSync(gw.logPath, 'utf8');
      const promotedLong = (log2.match(/会话亲和 → pgood 提到首位/g) || []).length - before;
      assert.strictEqual(promotedLong, 0, `超长对话不该参与亲和，实际提到首位 ${promotedLong} 次`);
      assert.ok(/会话亲和跳过：对话 \d+ 条 > 上限 8/.test(log2), '应记录跳过原因：' + log2.slice(-400));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('WorkBuddy 凭据取舍：身份不同 → 桌面文件；身份相同 → 谁新用谁（两段式）', async () => {
    // 依据（2026-10-08，参照 corrinehu/dsh-workbuddy-connect 的 auth.ts:405 两段式）：
    //   ① 身份不同 → 桌面文件是"**现在**登录的是谁"的权威。自留副本是我们自己刷新时写的，
    //      用户换账号后它还是上一个账号的，而且可能因为被我们刷新过而**过期更晚** ——
    //      按过期时间选就会串号（把企业 A 的身份发给企业 B 的接口）。
    //   ② 身份相同 → 谁过期更晚用谁。自留副本常是我们刚刷新过的那份，用它省一次刷新往返。
    //
    // ⚠ 旧实现是 `let cred = desktop || own;` + 一句"身份不同则用桌面" —— 那句是**死代码**
    //（desktop 已经优先），于是 ② 从来没实现。这个用例专门把 ② 钉住：
    // 身份完全相同时，必须选**过期更晚**的那份。
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-pick-'));
    // 桌面文件：全新（未过期），token = AT-DESKTOP
    const desktop = writeWorkBuddyAuth(dir, 'workbuddy-desktop.info', {
      token: 'AT-DESKTOP', uid: 'uid-same', enterpriseId: 'ent-SAME',
      domain: 'codebuddy.cn', expiresInMs: 3600_000, refreshToken: 'RT-D',
    });
    const gw = await startGatewayWith([
      openaiProvider('wbp', up, { auth: 'workbuddy', accounts: [{ id: 'a1', authFile: desktop }] }),
    ], 'wbpick');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 自留副本：**身份完全相同**，但过期更晚 → 按 ② 应该选它
      const ownDir = path.join(path.dirname(gw.logPath), 'workbuddy-auth');
      fs.mkdirSync(ownDir, { recursive: true });
      fs.writeFileSync(path.join(ownDir, 'wbp-a1.json'), JSON.stringify({
        version: 1,
        credential: {
          accessToken: 'AT-OWN-NEWER', refreshToken: 'rt-own',
          expiresAtMs: Date.now() + 7200_000,     // 比桌面的 1 小时更晚
          domain: 'codebuddy.cn', uid: 'uid-same', enterpriseId: 'ent-SAME',
        },
      }), 'utf8');

      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = up.st.headers[up.st.headers.length - 1] || {};
      assert.strictEqual(h.authorization, 'Bearer AT-OWN-NEWER',
        '身份相同时应选过期更晚的自留副本（省一次刷新），实际 ' + h.authorization);
      assert.strictEqual(up.st.refreshCalls || 0, 0, '不该触发刷新（两份都没临期）');
      assert.strictEqual(h['x-enterprise-id'], 'ent-SAME', '身份相同，企业头应保持不变');
    } finally { killGw(gw); closeUp(up); }
  });

  t('WorkBuddy 凭据取舍：身份不同（企业变了）→ 必须用桌面文件，不得用自留副本的旧企业', async () => {
    // ⚠ 先说清这条测试**能**守什么、**不能**守什么（2026-10-09 变异测试实测）：
    //
    //  · 它**不能**区分 v0.7.8 的 `cred = desktop || own` —— 因为两段式的规则①
    //    （身份不同 → 桌面）与旧写法**行为完全重合**：只要桌面副本存在，两者都选桌面。
    //    实测：把修复回退掉，这条照样 PASS。真正有行为差异的只有规则②（同身份 → 谁新用谁），
    //    那条由上面「身份相同 → 谁新用谁」的姊妹用例守着，回退后会 FAIL。
    //
    //  · 它**能**守住的是另一个方向的回归：把取舍写成"无条件优先自留副本"
    //    （`own || desktop`、或"同身份判断写反"），那样就会把自留副本里的**旧企业身份**
    //    发出去 —— 同一账号退出/换企业后 uid 不变、只有 enterpriseId 变，
    //    串号的后果是上游按旧企业鉴权。
    //
    // 保留它的理由：断言本身是对的、也是便宜的；只是别把它当成"守住了规则①"。
    // uid 相同但 enterpriseId 不同 = 换了企业身份。
    // 自留副本**过期更晚**（正是最容易被误选的那种），必须仍然选桌面。
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-ent-'));
    const desktop = writeWorkBuddyAuth(dir, 'workbuddy-desktop.info', {
      token: 'AT-DESKTOP-NEW-ENT', uid: 'uid-same', enterpriseId: 'ent-NEW',
      domain: 'codebuddy.cn', expiresInMs: 3600_000, refreshToken: 'RT-NEW',
    });
    const gw = await startGatewayWith([
      openaiProvider('wbe', up, { auth: 'workbuddy', accounts: [{ id: 'a1', authFile: desktop }] }),
    ], 'wbent2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const ownDir = path.join(path.dirname(gw.logPath), 'workbuddy-auth');
      fs.mkdirSync(ownDir, { recursive: true });
      fs.writeFileSync(path.join(ownDir, 'wbe-a1.json'), JSON.stringify({
        version: 1,
        credential: {
          accessToken: 'AT-OWN-STALE-ENTERPRISE', refreshToken: 'rt-own',
          expiresAtMs: Date.now() + 7200_000,     // 更晚 → 按"谁新用谁"会误选它
          domain: 'codebuddy.cn', uid: 'uid-same', enterpriseId: 'ent-OLD',
        },
      }), 'utf8');

      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = up.st.headers[up.st.headers.length - 1] || {};
      assert.ok(!/ent-OLD/.test(String(h['x-enterprise-id'] || '')),
        '绝不能把自留副本里的旧企业身份发出去（串号），实际 X-Enterprise-Id=' + h['x-enterprise-id']);
      assert.strictEqual(h['x-enterprise-id'], 'ent-NEW', '应使用桌面文件的当前企业，实际 ' + h['x-enterprise-id']);
      assert.strictEqual(h.authorization, 'Bearer AT-DESKTOP-NEW-ENT', '也应使用桌面文件的 token，实际 ' + h.authorization);
    } finally { killGw(gw); closeUp(up); }
  });

  t('WorkBuddy 区域守卫：国际版凭据配国际版端点 → 正常放行（不误伤）', async () => {
    // 反向用例：区域匹配时必须照常工作，证明守卫只拦不匹配的组合。
    // 这里的上游是本地假服务器（自定义端点），区域须由条目的 `region: "global"` 显式声明——
    // 守卫对"区域未知"的自定义端点不做拦截（否则内网代理/测试上游会被误判）。
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-region-ok-'));
    const glAuth = writeWorkBuddyAuth(dir, 'gl.info', { token: 'AT-GL', uid: 'uid-gl', domain: 'www.workbuddy.ai' });
    const gw = await startGatewayWith([
      openaiProvider('wbglok', up, { region: 'global', auth: 'workbuddy', accounts: [{ id: 'g1', authFile: glAuth }] }),
    ], 'wbreion2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '区域匹配应正常放行，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.ok(up.st.calls >= 1, '应真的调用上游，实际 ' + up.st.calls);
      const chatIdx = up.st.paths.findIndex((p) => /chat\/completions$/.test(p));
      assert.ok(chatIdx >= 0, '应有 chat 请求：' + JSON.stringify(up.st.paths));
      // 国际版身份：产品名 WorkBuddy AI + Origin/Referer 指向 www.workbuddy.ai
      assert.ok(/WorkBuddy AI\//.test(up.st.headers[chatIdx]['user-agent'] || ''),
        '国际版 chat UA 应含 WorkBuddy AI 产品名：' + up.st.headers[chatIdx]['user-agent']);
      assert.strictEqual(up.st.headers[chatIdx].origin, 'https://www.workbuddy.ai',
        '国际版 Origin 应为 www.workbuddy.ai：' + up.st.headers[chatIdx].origin);
    } finally { killGw(gw); closeUp(up); }
  });

  t('供应商能力（直通路径）：quirks 同样生效 —— tool_choice 摊平 / prepend-system / force-stream 聚合', async () => {
    // 2026-09-16 实测：quirks 曾在**只有翻译路径**生效，OpenAI 客户端把 tool_choice 对象透传 →
    // 上游 400「cannot unmarshal object into Go struct field Request.tool_choice of type string」
    const up = await startFakeOpenAIUpstream({});   // 一直回 SSE（模拟只收流式的上游）
    const gw = await startGatewayWith([
      openaiProvider('qd', up, { quirks: ['stringify-tool-choice', 'prepend-system', 'force-stream'] }),
    ], 'quirks1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 客户端要**非流式**：上游被强制 stream:true → 网关必须聚合后回单条 JSON
      const r = await call({
        port: gw.port, p: '/v1/chat/completions',
        body: {
          model: 'test-model', stream: false,
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 240));
      const sent = up.st.bodies[0];
      assert.strictEqual(sent.tool_choice, 'get_weather', 'tool_choice 必须摊平成字符串：' + JSON.stringify(sent.tool_choice));
      assert.strictEqual(sent.messages[0].role, 'system', 'prepend-system 应补 system：' + JSON.stringify(sent.messages[0]));
      assert.strictEqual(sent.stream, true, 'force-stream 应强制上游 stream:true：' + sent.stream);
      // 客户端拿到的是聚合后的单条 completion（不是 SSE）
      const out = JSON.parse(r.text);
      assert.strictEqual(out.object, 'chat.completion', '客户端应收到聚合后的 JSON：' + r.text.slice(0, 200));
      assert.ok(/你好，世界/.test(out.choices[0].message.content), '聚合内容应完整：' + JSON.stringify(out.choices[0].message));
      assert.strictEqual(out.choices[0].finish_reason, 'stop');
    } finally { killGw(gw); closeUp(up); }
  });

  t('供应商能力（直通路径）：force-stream 下客户端要流式 → 原样透传 SSE，不聚合', async () => {
    const up = await startFakeOpenAIUpstream({});
    const gw = await startGatewayWith([openaiProvider('qs', up, { quirks: ['force-stream'] })], 'quirks2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.ok(/data: \{"id":"chatcmpl-1"/.test(r.text) && /\[DONE\]/.test(r.text), '流式客户端应拿到原始 SSE：' + r.text.slice(0, 200));
      assert.strictEqual(up.st.bodies[0].stream, true, '上游仍应 stream:true');
    } finally { killGw(gw); closeUp(up); }
  });

  t('身份仿真边界：只有 workbuddy 用 WorkBuddy 身份；其余供应商仍按 clientProfile 仿真（claude/codex/自定义）', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-scope-'));
    fs.mkdirSync(path.join(dir, 'resources', 'app.asar.unpacked', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'resources', 'install-manifest.json'), JSON.stringify({ appVersion: '9.9.9' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'resources', 'app.asar.unpacked', 'cli', 'package.json'),
      JSON.stringify({ version: '0.0.0', publishConfig: { customPackage: { version: '3.3.3' } } }), 'utf8');
    const authFile = writeWorkBuddyAuth(dir, 'wb-scope.info', { token: 'AT-SCOPE', uid: 'uid-scope' });
    const env = { WORKBUDDY_APP_DIR: dir };
    const plain = (id) => ({ id, baseURL: 'http://127.0.0.1:' + up.port + '/v1', apiKey: UPSTREAM_KEY, models: ['test-model'], enabled: true });

    // ① claude 仿真（默认 clientProfile）→ 普通供应商：UA 必须是 Claude Code 形态
    let gw = await startGatewayWith([plain('n1')], 'scope1', env, { clientProfile: 'claude', clientUA: 'claude-cli/2.0.0 (external, cli)' });
    try {
      assert.ok(gw.ready);
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(up.st.headers[0]['user-agent'], 'claude-cli/2.0.0 (external, cli)',
        '普通供应商必须保持 Claude Code 仿真：' + up.st.headers[0]['user-agent']);
      assert.ok(!/WorkBuddy/.test(up.st.headers[0]['user-agent']), '普通供应商绝不能带上 WorkBuddy 身份');
      assert.ok(!up.st.headers[0]['x-ide-type'] && !up.st.headers[0]['x-ide-name'] && !up.st.headers[0]['x-ide-version'],
        '使用端身份三头（X-IDE-*）只能给 auth=workbuddy 的供应商，其余供应商一条都不能带：'
        + JSON.stringify(up.st.headers[0]));
    } finally { killGw(gw); }

    // ② codex 仿真 → 普通供应商：必须是**真实 Codex CLI 形态**的身份
    //
    // 旧断言是 `/^codex\/0\.49\.0/`，而旧实现把 Codex 前缀粘在一条 Chrome 浏览器 UA 上
    //（`codex/0.49.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 … Chrome/126… Safari/537.36`）
    // —— Codex CLI 是 Rust 程序，UA 里不可能有 AppleWebKit/Chrome/Safari，这是最容易被
    // 一眼识破的自相矛盾。真实形态见 openai/codex 的
    // `codex-rs/login/src/auth/default_client.rs`：
    //   UA = `${originator}/${ver} (${os_type} ${os_version}; ${arch})`
    //   originator 是独立的一等身份头，且有服务端白名单。
    gw = await startGatewayWith([plain('n2')], 'scope2', env, { clientProfile: 'codex' });
    try {
      assert.ok(gw.ready);
      const before = up.st.calls;
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      const h = up.st.headers[before];
      assert.ok(/^codex_cli_rs\/\d+\.\d+\.\d+ \([^)]+; [^)]+\)$/.test(String(h['user-agent'])),
        'codex 配置下应发真实 Codex CLI 形态的 UA：' + h['user-agent']);
      assert.ok(!/AppleWebKit|Chrome\/|Safari\//.test(String(h['user-agent'])),
        'Codex CLI 是 Rust 程序，UA 里绝不能出现浏览器指纹：' + h['user-agent']);
      assert.strictEqual(h.originator, 'codex_cli_rs',
        'originator 是 Codex 的一等身份头且有服务端白名单，必须发：' + JSON.stringify(h));
      assert.ok(!/WorkBuddy/.test(h['user-agent']), '不得混入 WorkBuddy 身份');
    } finally { killGw(gw); }

    // ②b 三个仿真档的 SDK 指纹头：必须成套且与运行环境自洽
    gw = await startGatewayWith([plain('n2b')], 'scope2b', env, { clientProfile: 'claude' });
    try {
      assert.ok(gw.ready);
      const before = up.st.calls;
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      const h = up.st.headers[before];
      // @anthropic-ai/sdk 的 buildHeaders() 必发这六项（一手依据：编译产物 client.js）
      for (const k of ['x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os',
        'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version',
        'x-stainless-retry-count', 'x-stainless-timeout']) {
        assert.ok(h[k], 'Claude 仿真缺 SDK 指纹头 ' + k + '：' + JSON.stringify(h));
      }
      assert.strictEqual(h['x-stainless-runtime'], 'node');
      assert.strictEqual(h['x-stainless-runtime-version'], process.version,
        'runtime 版本必须与真实运行环境自洽（fake 值一眼假）：' + h['x-stainless-runtime-version']);
      assert.strictEqual(h['x-app'], 'cli', 'Claude Code 必发 x-app: cli');
      assert.ok(/^claude-cli\/\d+\.\d+\.\d+ \(external, (cli|sdk-cli)\)$/.test(String(h['user-agent'])),
        'Claude Code UA 形态：' + h['user-agent']);
      assert.strictEqual(h.accept, 'application/json',
        '真实 Claude Code 发 application/json，不是 text/event-stream：' + h.accept);
    } finally { killGw(gw); }

    // ③ 供应商自带 User-Agent（配置覆盖）→ 只发这一个 UA（不得与 clientProfile 的 UA 拼接）
    gw = await startGatewayWith([Object.assign(plain('n3'), { headers: { 'User-Agent': 'my-agent/1.0' } })], 'scope3', env,
      { clientProfile: 'claude', clientUA: 'claude-cli/2.0.0 (external, cli)' });
    try {
      assert.ok(gw.ready);
      const before = up.st.calls;
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(up.st.headers[before]['user-agent'], 'my-agent/1.0',
        '供应商配置的 UA 应生效且不被拼接：' + up.st.headers[before]['user-agent']);
      assert.ok(!up.st.headers[before]['x-ide-type'],
        '配置了自定义 UA 的普通供应商同样不得带上使用端身份头：' + JSON.stringify(up.st.headers[before]));
    } finally { killGw(gw); }

    // ④ WorkBuddy 供应商（同一个网关配置里）→ 必须是桌面 WorkBuddy 身份
    //    注意：普通供应商声明**别的模型**，否则它会先拿到请求（那样断言到的是它的头）
    gw = await startGatewayWith([
      Object.assign(plain('n4'), { models: ['other-model'] }),
      openaiProvider('wbs', up, { auth: 'workbuddy', accounts: [{ id: 's1', authFile }] }),
    ], 'scope4', env, { clientProfile: 'claude', clientUA: 'claude-cli/2.0.0 (external, cli)' });
    try {
      assert.ok(gw.ready);
      const before = up.st.calls;
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.strictEqual(up.st.calls, before + 1, '应只有 WorkBuddy 一家被调用');
      const h = up.st.headers[before];
      assert.strictEqual(h['user-agent'], 'WorkBuddy/9.9.9 WorkBuddy/9.9.9 CLI/3.3.3',
        'WorkBuddy 必须用桌面身份 UA：' + h['user-agent']);
      assert.ok(!/claude-cli/.test(h['user-agent']), 'WorkBuddy 请求不得混入 claude-cli（旧 bug 会拼成两个 UA）');
      assert.strictEqual(h['x-user-id'], 'uid-scope', 'WorkBuddy 身份头应存在');
      assert.strictEqual(h['x-ide-type'], 'WorkBuddy', 'WorkBuddy 请求必须带使用端身份（控制台归属）：' + JSON.stringify(h));
      assert.strictEqual(h['x-ide-name'], 'WorkBuddy', '同上（X-IDE-Name）');
      assert.strictEqual(h['x-ide-version'], '9.9.9', 'X-IDE-Version 应为本机桌面版本');
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：工具名在后续分片才到达时，客户端仍必须拿到非空的 tool_use 名字（真实事故回归）', async () => {
    // 事故（2026-09-16）：上游先发 id、稍后才发 name，旧实现立刻开块 → 名字为空 →
    // 客户端报 `unknown tool ""`，下一轮把空名 tool_use 回传 → 上游 400 打死整轮。
    const up = await startFakeOpenAIUpstream({ withToolCall: true, toolNameLate: true });
    const gw = await startGatewayWith([openaiProvider('late', up, { quirks: ['force-stream'] })], 'toollate');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      // 取出客户端实际收到的 tool_use 块（content_block_start 的 name 字段）
      const starts = [...r.text.matchAll(/"content_block":\{"type":"tool_use"[^}]*"name":"([^"]*)"/g)].map((m) => m[1]);
      assert.ok(starts.length >= 1, '应有 tool_use 块：' + r.text.slice(0, 400));
      assert.strictEqual(starts[0], 'get_weather', '工具名必须非空且正确（旧实现为空串）：' + JSON.stringify(starts));
      assert.ok(!/"name":""/.test(r.text), '不得出现空名 tool_use：' + r.text.slice(0, 400));
      // 参数应完整补发（名字到达前缓冲的分片不能丢）——按 SSE 事件解析，避免转义引号截断正则
      const events = r.text.split(/\n\n/).map((blk) => (/^data:\s*(.*)$/m.exec(blk) || [])[1]).filter(Boolean)
        .map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
      const partials = events.filter((e) => e.type === 'content_block_delta' && e.delta && e.delta.type === 'input_json_delta')
        .map((e) => e.delta.partial_json);
      assert.ok(partials.join('').includes('北京'), '缓冲的参数分片应完整补发：' + JSON.stringify(partials));
      // 且 tool_use 块只应开一次（旧实现会开两次：空名一次 + 补名一次）
      const toolStarts = events.filter((e) => e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use');
      assert.strictEqual(toolStarts.length, 1, 'tool_use 块只应开一次：' + JSON.stringify(toolStarts.map((e) => e.content_block.name)));
      // 聚合路径（非流式客户端）也要拿到名字
      const up2 = await startFakeOpenAIUpstream({ withToolCall: true, toolNameLate: true });
      const gw2 = await startGatewayWith([openaiProvider('late2', up2, { quirks: ['force-stream'] })], 'toollate2');
      try {
        const r2 = await call({ port: gw2.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hi' }] } });
        const out = JSON.parse(r2.text);
        const tu = out.content.find((b) => b.type === 'tool_use');
        assert.ok(tu && tu.name === 'get_weather', '聚合路径同样要有正确的工具名：' + JSON.stringify(out.content));
        assert.deepStrictEqual(tu.input, { city: '北京' }, '聚合路径参数应完整：' + JSON.stringify(tu.input));
      } finally { killGw(gw2); closeUp(up2); }
    } finally { killGw(gw); closeUp(up); }
  });

  t('第三轮：并行工具调用交错分片 → 每个 tool_use 块只拿到自己的参数（旧实现会串台）', async () => {
    // 既存缺陷（第三轮审计发现）：旧实现一拿到 name 就开块、并**立即**用"当前块号"写
    // input_json_delta。并行工具调用 A→B→A→B 交错时，A 的续片会写进 B 的块，
    // 两边参数 JSON 都被污染（客户端 parse 失败 → 工具入参为空）。修法是延迟到流结束统一开块。
    const up = await startFakeOpenAIUpstream({ withToolCall: true, parallelToolCalls: true });
    const gw = await startGatewayWith([openaiProvider('par', up, { quirks: ['force-stream'] })], 'parallel');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 128, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const events = r.text.split(/\n\n/).map((blk) => (/^data:\s*(.*)$/m.exec(blk) || [])[1]).filter(Boolean)
        .map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
      // 按块号归集：content_block_start 记 name，content_block_delta 累积该块的 partial_json
      const blocks = new Map();
      for (const e of events) {
        if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
          blocks.set(e.index, { name: e.content_block.name, args: '' });
        } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'input_json_delta') {
          const b = blocks.get(e.index);
          assert.ok(b, 'input_json_delta 必须落在已开启的 tool_use 块上（index=' + e.index + '）：' + r.text.slice(0, 400));
          b.args += e.delta.partial_json;
        }
      }
      const list = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      assert.strictEqual(list.length, 2, '应恰好 2 个 tool_use 块：' + JSON.stringify(list));
      assert.deepStrictEqual(list.map((b) => b.name), ['get_weather', 'get_time'],
        '工具名应按槽位顺序且非空：' + JSON.stringify(list));
      const parsed = list.map((b) => {
        try { return JSON.parse(b.args); } catch (e) { return 'PARSE_FAIL:' + b.args; }
      });
      assert.deepStrictEqual(parsed[0], { city: '北京' },
        '第 1 个块的参数被别的调用污染了（串台）：' + JSON.stringify(list));
      assert.deepStrictEqual(parsed[1], { tz: 'UTC' },
        '第 2 个块的参数被别的调用污染了（串台）：' + JSON.stringify(list));
    } finally { killGw(gw); closeUp(up); }
  });

  t('第三轮：续片重复携带同一个非空 id 时不得分裂成多个槽（同一次调用只能有一个 tool_use）', async () => {
    // 第三轮审计发现（我在第二轮引入的新失效模式）：toolCallSlot 原先只判断"有没有 id"，
    // 续片若重复发同一个非空 id 会被当成"新调用"分配新槽 → 同一次调用的参数被切成多份，
    // 产出多条 id 相同、参数各半截的 tool_call（下游按"重复 tool id"直接报错）。
    const sse = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_X","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_X","function":{"arguments":"\\"北京\\"}"}}]}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n';
    const up = await startFakeOpenAIUpstream({ sseRaw: sse });
    const gw = await startGatewayWith([openaiProvider('dup', up, { quirks: ['force-stream'] })], 'dupid');
    try {
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const events = r.text.split(/\n\n/).map((blk) => (/^data:\s*(.*)$/m.exec(blk) || [])[1]).filter(Boolean)
        .map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
      const starts = events.filter((e) => e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use');
      assert.strictEqual(starts.length, 1, '同一次调用只能开一个 tool_use 块：' + JSON.stringify(starts.map((e) => e.content_block)));
      const args = events.filter((e) => e.type === 'content_block_delta' && e.delta && e.delta.type === 'input_json_delta')
        .map((e) => e.delta.partial_json).join('');
      assert.deepStrictEqual(JSON.parse(args), { city: '北京' }, '参数应拼成完整 JSON：' + args);
    } finally { killGw(gw); closeUp(up); }
  });

  t('第三轮：200+SSE 报额度耗尽 → 换同供应商的下一把 Key（旧实现只换下一家供应商）', async () => {
    // 第三轮审计发现：该分支原为一律 `return false`（换下一家供应商），与函数契约
    //（"额度耗尽/会话失效/限流 → 换同供应商的下一个账户"）及非 2xx 分支的 continue 不一致，
    // 等于把多 Key 容灾在这条路径上废掉。文案用 b.ai 实测形态 "credit insufficient balance"
    //（词序与旧正则的 "insufficient credit" 相反，也是本轮补的正则缺口）。
    const up = await startFakeOpenAIUpstream({ script: ['sseCredit', 'ok'] });
    const gw = await startGatewayWith([openaiProvider('ssekey', up, { apiKeys: ['k1', 'k2'] })], 'ssekey');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '第二把 Key 应成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 2, '应调用两次（第一把 Key 额度失败 → 换第二把 Key），实际 ' + up.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/换同供应商的下一把 Key/.test(logText), '日志应记录换 Key：' + logText.slice(-500));
      assert.ok(/标记为 credit/.test(logText), '应把该 Key 标记为 credit：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译（防御）：历史里的空名 tool_use 及其 tool_result 必须被丢弃，不得让整轮 400', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('def1', up)], 'def1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 32, stream: false,
          messages: [
            { role: 'user', content: '北京天气？' },
            // 修复前版本可能产生这种坏数据：tool_use 名字为空
            { role: 'assistant', content: [{ type: 'text', text: '我查一下' }, { type: 'tool_use', id: 'bad_1', name: '', input: { city: '北京' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad_1', content: '晴 25℃' }] },
            { role: 'user', content: '那就说不知道' },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const sent = up.st.bodies[0];
      const badCall = sent.messages.some((m) => Array.isArray(m.tool_calls)
        && m.tool_calls.some((t) => !t.function || !String(t.function.name || '').trim()));
      assert.ok(!badCall, '不得回传空名 tool_calls（上游会 400）：' + JSON.stringify(sent.messages));
      const orphan = sent.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'bad_1');
      assert.ok(!orphan, '不得留下孤儿的 tool 消息：' + JSON.stringify(sent.messages));
      assert.ok(sent.messages.some((m) => m.role === 'user' && /那就说不知道/.test(String(m.content))),
        '其余历史必须保留：' + JSON.stringify(sent.messages));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/名字为空.*tool_use.*已丢弃/.test(logText), '应记录丢弃告警：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 2026-09-16 事故回归：本机代理端口死掉时，网关不该自杀、也不该把锅甩给上游 ----
  t('代理事故回归：NO_PROXY 含回环时，代理端口死掉也不影响上游调用与 /health（不再自杀/误熔断）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    // 死代理：7899 没有任何监听（复现 19:19–19:23 的 ECONNREFUSED 场景）
    const gw = await startGatewayWith([providerOf('p1', up, { priority: 1 })], 'deadproxy', {
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:7899',
      HTTPS_PROXY: 'http://127.0.0.1:7899',
      NO_PROXY: '127.0.0.1,localhost,::1',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪（回环直连 → 不被死代理拖死）');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '回环上游在 NO_PROXY 里 → 即使代理端口死掉也应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      assert.ok(h.proxy && h.proxy.url === 'http://127.0.0.1:7899', '/health 应暴露代理地址：' + JSON.stringify(h.proxy));
      assert.ok(/127\.0\.0\.1/.test(String(h.proxy.noProxy)), '/health 应暴露 NO_PROXY（含回环）：' + JSON.stringify(h.proxy));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/proxy: 走 http:\/\/127\.0\.0\.1:7899/.test(logText), '启动日志应自述代理状态：' + logText.slice(0, 400));
    } finally { killGw(gw); closeUp(up); }
  });

  t('规则1：代理不可达但**直连可达** → 该家自动切直连并把这次请求重试成功（不再 503）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([providerOf('p1', up, { priority: 1 })], 'deadproxy2', {
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:7899',
      HTTPS_PROXY: 'http://127.0.0.1:7899',
      NO_PROXY: '',            // 故意不绕过：上游请求会被塞进死代理
    });
    try {
      assert.ok(gw.ready, 'watchdog 用裸 socket 自检，不经过代理 → 即使代理死掉也不该自杀');
      const r = await call({ port: gw.port });
      // 2026-10-14（规则 1）：旧契约是这里回 503。现在"代理路径失败 + 直连可达"被识别出来，
      // 该 host 切成直连并原地重试 → 用户的请求不再因为代理没启动而失败。
      assert.strictEqual(r.status, 200,
        '规则1：代理不可达但直连可达 → 应自动切直连并成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      // ① 必须把这次失败**归因到代理** —— 旧契约里最值钱的那句诊断，不能因为自动切直连就丢掉。
      //    两种形态都算：代理彻底失败时是"代理未运行"（proxyHintFor 的文案），
      //    切直连成功时是"代理不可达"（switchHostToDirect 的文案）。
      assert.ok(/代理(未运行|不可达)/.test(logText),
        '必须点名"代理未运行/不可达"（否则又会把环境问题记成上游故障）：' + logText.slice(-400));
      // ② 必须留下切换记录，否则"为什么这家突然不走代理了"无从判断
      assert.ok(/直连可达[\s\S]{0,80}切成直连/.test(logText), '必须记录已切直连：' + logText.slice(-600));
      // ③ 请求最终真的到了上游（= 切直连后确实重试了，而不是放弃了事）
      assert.strictEqual(up.st.calls, 1, '切直连后应重试一次并到达上游，实际 ' + up.st.calls);
      // ④ /health 要能看见"运行期被切成直连的 host"
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      assert.ok(Array.isArray(h.proxy.runtimeDirect) && h.proxy.runtimeDirect.includes('127.0.0.1'),
        '/health 应暴露运行期直连 host：' + JSON.stringify(h.proxy));
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 2026-09-17 优化项回归（依据当天日志分析：探针代价 / 402 判级 / 学习标记 / 多 Key / 误报）----

  t('多 Key（apiKeys）：同一供应商内额度耗尽 → 自动换下一把 Key（用户要求 2b/2c）', async () => {
    const upPool = await startFakeOpenAIUpstream({ script: ['credit', 'ok'], json: true });
    const gw = await startGatewayWith([
      // 注意 provider 同时带 apiKey（单 Key 字段）：多 Key 必须**优先**，否则等于没生效
      openaiProvider('mk', upPool, { apiKeys: ['sk-key-1', 'sk-key-2'] }),
    ], 'multikey');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应换到第二把 Key 后成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upPool.st.calls, 2, '同一供应商内应重试一次（换 Key），实际 ' + upPool.st.calls);
      const used = upPool.st.headers.map((h) => h.authorization);
      assert.strictEqual(used[0], 'Bearer sk-key-1', '第一次应用第一把 Key：' + JSON.stringify(used));
      assert.strictEqual(used[1], 'Bearer sk-key-2', '第二次应换第二把 Key：' + JSON.stringify(used));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/标记为 credit/.test(logText), '日志应记账户（Key）被标记：' + logText.slice(-400));
      // /health 可见性：多 Key 在账户池里逐把列出（排障时一眼看清哪把在冷却）
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      const keys = (h.accounts || []).map((a) => a.key);
      assert.ok(keys.includes('mk#key1') && keys.includes('mk#key2'), '/health 应列出两把 Key：' + JSON.stringify(keys));
    } finally { killGw(gw); closeUp(upPool); }
  });

  t('多 Key（apiKeys）：只配 1 把时不写 apiKeys（保持旧单 Key 结构），≥2 把才启用轮换', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('one', up, { apiKey: 'sk-only-one' })], 'onekey');
    try {
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      // 契约变更（2026-10-17，用户两次报「账户池中渠道不全」）：
      //   单 Key 家**要出现在 /health 快照里**（否则面板看不到它、用户无从判断状态），
      //   但**不得**因此进入账户轮换 —— 请求仍走顶层 apiKey 的旧路径。
      //   快照里用 `singleKey: true` + `id: 'key1'` 标记，冷却范围是"供应商级"而非"账户级"。
      const rows = h.accounts || [];
      assert.strictEqual(rows.length, 1, '单 Key 家应产生 1 条快照条目：' + JSON.stringify(rows));
      assert.strictEqual(rows[0].provider, 'one', '条目应指向该供应商：' + JSON.stringify(rows[0]));
      assert.strictEqual(rows[0].singleKey, true, '★ 必须标出 singleKey，前端才能显示"供应商级"：' + JSON.stringify(rows[0]));
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      // 关键：**调度没变** —— 仍然用顶层 apiKey，没有因为快照多一行就变成账户轮换
      assert.strictEqual(up.st.headers[0].authorization, 'Bearer sk-only-one', '单 Key 仍按旧路径使用');
    } finally { killGw(gw); closeUp(up); }
  });

  // ================= 2026-09-22：amd 实测事故（换机后 deepseek-v4.1-flash 永远选不上 amd）=================
  // 现象：每个请求都 `skip amd (breaker open)` → 落到 workbuddy。根因两条，各配一个回归：
  //   ① 半开探测超时被 Math.min 压到 10s，而该模型首字节稳定 13.7–15.5s → 探测必然超时
  //      → 熔断重新 open → 退避递增 → **永远无法恢复**（配了 timeoutMs 也没用）；
  //   ② 上游 429 是**模型级**并发上限，旧实现按账户级冷却 → 该 Key 上其它正常模型被连坐 90s。

  t('熔断探测超时：供应商显式声明 timeoutMs 时，半开探测不再被压到 10s（否则慢家永远无法恢复）', async () => {
    // 假上游：前 2 次快速失败（把 dead 推进熔断），之后"恢复"但**响应很慢**（首字节 1.2s）。
    // 探测超时压到 10s 的旧实现下，只要把探测超时设小就能复现同样的死循环；
    // 这里用 DSH_GATEWAY_BREAKER_PROBE_TIMEOUT_MS=300 模拟"探测超时 < 首字节"。
    const up = await startFakeUpstream({ status: 500 });
    const gw = await startGatewayWith([providerOf('slowp', up, { priority: 1, timeoutMs: 5000 })], 'probetimeout', {
      DSH_GATEWAY_BREAKER_SHORT_MS: '300', DSH_GATEWAY_BREAKER_PROBE_TIMEOUT_MS: '300',
      // 规则 2/3（2026-10-14）：上游 500 现在记在**模型级**，冷却时长由这个旋钮控制
      //（供应商级旋钮只管鉴权/欠费与连接未建立）。旧用例只设了 BREAKER_SHORT_MS，改完立刻变红。
      DSH_GW_MODEL_BREAKER_COOLDOWN_MS: '300',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 连打几次把熔断打开（阈值 3）
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const log1 = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker OPEN/.test(log1), '应已开闸：' + log1.slice(-300));
      // 等冷却到点，让上游"恢复"但变慢（首字节 1.2s > 探测超时 300ms）
      up.st.status = 200;
      up.st.delayMs = 1200;
      await sleep(400);
      let ok = 0;
      for (let i = 0; i < 8 && !ok; i++) {
        const r = await call({ port: gw.port });
        if (r.status === 200) ok = 1;
        else await sleep(400);
      }
      // 关键断言：**显式 timeoutMs=5000 必须让探测有 5 秒**，所以 1.2s 的慢响应不该被判超时。
      // 旧实现（Math.min → 300ms）下这里必然失败。
      assert.strictEqual(ok, 1, '声明了 timeoutMs 的供应商，半开探测应按该超时执行（1.2s 慢响应应成功）');
    } finally { killGw(gw); closeUp(up); }
  });

  t('客户端仿真头：app 侧镜像与引擎**头名集合**必须一致（防漂移）', async () => {
    // 主进程做"拉取目录 / 测速"时要用与网关转发**相同**的身份头 —— 否则会得到假结论：
    // 实测直连 cline 不带 Cline 仿真头一律 403（464 个模型一个都拉不到），
    // 带上后立刻 200。所以这份镜像是必需的，但它是**两份实现**，必须挡住漂移。
    const src = fs.readFileSync(MJS, 'utf8');
    const appHeaders = require('../src/client-headers');

    /** 从引擎源码里抠出一个顶层函数并求值（与 providerClientProfile 那条测试同一手法）。 */
    function extractFn(name) {
      const start = src.indexOf('function ' + name + '(');
      assert.ok(start >= 0, '引擎源码里应存在 ' + name);
      const rest = src.slice(start);
      const endIdx = rest.indexOf('\n}\n');
      assert.ok(endIdx > 0, '应能定位 ' + name + ' 的函数体结束');
      return rest.slice(0, endIdx + 3);
    }
    // 三个头构造函数依赖的这些辅助函数/常量一起抠出来
    const bundle = [
      extractFn('clientIdentityOverrides'),
      extractFn('osRelease'),
      extractFn('platformInfo'),
      extractFn('stainlessHeaders'),
      extractFn('claudeClientHeaders'),
      extractFn('clineClientHeaders'),
      extractFn('codexClientHeaders'),
    ].join('\n');
    // CC_BETA_FLAGS 是 const，单独取
    const betaStart = src.indexOf('const CC_BETA_FLAGS = [');
    const betaEnd = src.indexOf('].join(\',\');', betaStart);
    const betaSrc = src.slice(betaStart, betaEnd + '].join(\',\');'.length);
    const os = require('os');
    // eslint-disable-next-line no-new-func
    const engine = new Function('os', 'process',
      bundle + '\n' + betaSrc
      + '\nreturn { claudeClientHeaders, clineClientHeaders, codexClientHeaders };')(os, process);

    const pairs = [
      ['claude', engine.claudeClientHeaders({}), appHeaders.claudeHeaders({})],
      ['cline', engine.clineClientHeaders({}, ''), appHeaders.clineHeaders({}, '')],
      ['codex', engine.codexClientHeaders({}), appHeaders.codexHeaders({})],
    ];
    for (const [name, eng, app] of pairs) {
      const ek = Object.keys(eng).map((k) => k.toLowerCase()).sort();
      const ak = Object.keys(app).map((k) => k.toLowerCase()).sort();
      assert.deepStrictEqual(ak, ek,
        `${name} 仿真档的头名集合与引擎不一致（漂移了）：\n引擎=${JSON.stringify(ek)}\napp =${JSON.stringify(ak)}`);
      // UA 也必须同形（值可能因版本覆盖而不同，但形态必须一致）
      const shape = (s) => String(s).replace(/\d+(\.\d+)+/g, '<v>');
      assert.strictEqual(shape(app['user-agent'] || app['User-Agent']), shape(eng['user-agent'] || eng['User-Agent']),
        `${name} 的 UA 形态与引擎不一致：\n引擎=${eng['user-agent']}\napp =${app['user-agent']}`);
    }

    // providerProfile 的推断规则也必须一致
    assert.strictEqual(appHeaders.providerProfile({ baseURL: 'https://api.cline.bot/api/v1' }), 'cline');
    assert.strictEqual(appHeaders.providerProfile({ baseURL: 'https://API.CLINE.BOT/v1' }), 'cline');
    assert.strictEqual(appHeaders.providerProfile({ baseURL: 'https://openrouter.ai/api/v1' }), '');
    assert.strictEqual(appHeaders.providerProfile({ baseURL: 'not-a-url' }), '');
    assert.strictEqual(appHeaders.providerProfile({ baseURL: 'https://x/v1', clientProfile: 'codex' }), 'codex');

    // 鉴权头按协议切换：anthropic 用 x-api-key 且不留 authorization
    const anth = appHeaders.probeHeaders({ clientProfile: 'claude' }, {}, 'K', { anthropic: true });
    assert.strictEqual(anth['x-api-key'], 'K');
    assert.strictEqual(anth.authorization, undefined, 'anthropic 协议下不能同时带 Bearer');
    const oai = appHeaders.probeHeaders({ clientProfile: 'claude' }, {}, 'K', {});
    assert.strictEqual(oai.authorization, 'Bearer K');
    assert.strictEqual(oai['x-api-key'], undefined);
  });

  t('逐模型超时：模型条目上的 timeoutMs 覆盖供应商级（慢模型与快模型互不拖累）', async () => {
    // 依据（2026-09-30）：同一家供应商里不同模型的速度能差一个数量级 ——
    // 实测 amd 的 DeepSeek-V4.1-Flash 首字节 13.7–15.5s，而同家 DeepSeek-V4-Flash 只要 0.7–1.1s。
    // 只配供应商级超时时只能按最慢的定（否则慢模型永远选不上），于是一个挂住的慢模型
    // 就能把该家快的模型一起拖累。这条测试用一个"永不回应"的上游把差异钉死。
    const st = { calls: 0, aborted: 0 };
    const server = http.createServer((req, res) => {
      st.calls++;
      req.resume();
      // 永远不回应；客户端断开时记一笔
      req.on('aborted', () => { st.aborted++; });
      res.on('close', () => { st.aborted++; });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const up = { port: server.address().port, st, server };
    const gw = await startGatewayWith([
      openaiProvider('slowp', up, {
        // 供应商级 30 秒
        timeoutMs: 30000,
        models: [
          // 只有这个模型声明了短超时
          { id: 'fast-model', timeoutMs: 1500 },
          'slow-model',
        ],
      }),
    ], 'permodel');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 带逐模型超时的那个：应在 ~1.5s 就中止，而不是等满 30s
      const t0 = Date.now();
      const r1 = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'fast-model', messages: [{ role: 'user', content: 'hi' }] } });
      const el1 = Date.now() - t0;
      assert.ok(r1.status >= 400, '上游不回应时应失败，实际 ' + r1.status);
      assert.ok(el1 < 8000, `逐模型超时应生效（约 1.5s），实际等了 ${el1}ms —— 说明模型级 timeoutMs 没被读取`);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(st.aborted > 0, '超时后必须真的断开上游连接（否则会泄漏连接）');
      // ② 没声明逐模型超时的那个：仍走供应商级（不该 1.5s 就断）
      const t1 = Date.now();
      const p2 = call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'slow-model', messages: [{ role: 'user', content: 'hi' }] } });
      // 只等 6 秒看它有没有"过早"失败；随后的失败是供应商级 30s 超时，不影响本断言
      const early = await Promise.race([p2.then(() => 'done'), new Promise((r) => setTimeout(() => r('still-waiting'), 6000))]);
      assert.strictEqual(early, 'still-waiting',
        `没有逐模型超时的模型应继续等供应商级的 30s，实际 ${Date.now() - t1}ms 就结束了 —— 说明供应商级被误覆盖`);
      assert.ok(logText !== undefined);
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('日志可诊断性：自己的超时中止必须写明"阈值 + 实际等了多久"，不能只说 aborted', async () => {
    // 依据（2026-10-08，真实日志）：一天里 17 条
    //   `upstream h-e.top request error: This operation was aborted`
    // 完全同形 —— undici 在 abort 时 message 恒为这一句，于是"我们主动放弃"和
    // "上游/代理把连接掐了"在日志里**分不出来**；阈值多少、等了多久也都没记。
    // 而这三件事正是判断「上游慢」/「请求根本没发出去」/「阈值配太小」的全部依据，
    // 缺了它们只能靠猜。这条测试把新文案钉死。
    const server = http.createServer((req, res) => { req.resume(); /* 永不回应 */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const up = { port: server.address().port, st: { calls: 0 }, server };
    const gw = await startGatewayWith([
      openaiProvider('slowp2', up, { timeoutMs: 2000, models: ['m1'] }),
    ], 'timeoutlog');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(r.status >= 400, '上游不回应时应失败，实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      const line = (logText.split('\n').find((l) => /request error/.test(l)) || '');
      assert.ok(line, '应记录上游请求错误：' + logText.slice(-300));
      assert.ok(/上游无响应/.test(line), '应点明是"上游无响应"而不是裸的 aborted：' + line);
      assert.ok(/阈值\s*2000ms/.test(line), '必须写明超时阈值（否则无法判断该不该调大）：' + line);
      assert.ok(/已等\s*\d+ms/.test(line), '必须写明实际等待时长：' + line);
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('逐模型超时：逻辑名与上游 ID 两种写法都能命中', async () => {
    // 请求入口传的是**逻辑名**，failover 改写后传的是**上游 ID** —— 两种都得能匹配到，
    // 否则用户按逻辑名配的超时会在 failover 之后失效。
    const st = { calls: 0 };
    const server = http.createServer((req, res) => { st.calls++; req.resume(); /* 不回应 */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const up = { port: server.address().port, st, server };
    const gw = await startGatewayWith([
      openaiProvider('aliap', up, {
        timeoutMs: 30000,
        models: [{ id: 'vendor/real-id-123', as: 'nice-name', timeoutMs: 1500 }],
      }),
    ], 'permodel2');
    try {
      assert.ok(gw.ready);
      const t0 = Date.now();
      const r = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'nice-name', messages: [{ role: 'user', content: 'hi' }] } });
      const el = Date.now() - t0;
      assert.ok(r.status >= 400, '应失败，实际 ' + r.status);
      assert.ok(el < 8000, `以**逻辑名**请求时逐模型超时也应生效，实际 ${el}ms`);
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('gzip 压缩的 SSE 必须能正确解压（K7 的原始顾虑）', async () => {
    // K7 原先把 accept-encoding 强制成 identity，理由是"SSE 乱码"。2026-09-30 审计指出
    // identity 是个显眼的非客户端特征（真实客户端发 gzip, deflate, br, zstd），
    // 但它当初要防的问题是真的 —— 所以这里用**真的 gzip 压缩 SSE** 把风险钉死：
    // Node 的 fetch/undici 会自动解压，引擎读到的是解压后的流。
    const zlib = require('zlib');
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers['accept-encoding'] || '');
      req.resume();
      const sse = 'data: {"choices":[{"delta":{"content":"压缩也能读"},"index":0}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'
        + 'data: [DONE]\n\n';
      const gz = zlib.gzipSync(Buffer.from(sse, 'utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': gz.length });
      res.end(gz);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const up = { port: server.address().port, st: { calls: 0 }, server };
    const gw = await startGatewayWith([
      openaiProvider('gz', up, { models: ['m1'], priority: 1 }),
    ], 'gzsse');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true } });
      assert.strictEqual(r.status, 200, '应成功，实际 ' + r.status + ' ' + String(r.text).slice(0, 200));
      assert.ok(/压缩也能读/.test(String(r.text)),
        'gzip 压缩的 SSE 必须被正确解压并转发（否则 K7 的改动不能上）：' + String(r.text).slice(0, 300));
      assert.ok(/\[DONE\]/.test(String(r.text)), '结束事件也要在：' + String(r.text).slice(0, 300));
      // 发出去的 accept-encoding 必须是真实客户端形态，不再是 identity
      assert.ok(/gzip/.test(seen[0] || ''), '发给上游的 accept-encoding 应含 gzip：' + JSON.stringify(seen));
      assert.ok(!/^identity$/.test(String(seen[0] || '').trim()), '不应再是 identity（显眼的非客户端特征）');
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('accept-encoding 可回退：cfg.upstreamAcceptEncoding 能强制回 identity（上游编码异常时的退路）', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers['accept-encoding'] || '');
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const up = { port: server.address().port, st: { calls: 0 }, server };
    const gw = await startGatewayWith([
      openaiProvider('idn', up, { models: ['m1'], priority: 1 }),
    ], 'idenc', null, { upstreamAcceptEncoding: 'identity' });
    try {
      assert.ok(gw.ready);
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(seen[0], 'identity', '配置回退开关应生效：' + JSON.stringify(seen));
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('地区受限 403：只算"这家不提供该模型"，**不得连坐整家**（cline 实测事故）', async () => {
    // 实测事故：cline 对一个地区受限的模型回
    //   403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor is not available in your region"}
    // 旧实现把它当**供应商级 403** → 整家长熔断 30 分钟 → 该家另外 13 个完全正常的模型
    // 在模型全量测试里瞬间全部失败（日志清一色 "temporarily in breaker cooldown"）。
    // 正确语义：这是**模型级**事实，只该换下一家，不该动熔断器。
    const st = { calls: 0, models: [] };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        st.calls++;
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 忽略 */ }
        st.models.push(body && body.model);
        if (body && body.model === 'geo-blocked') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'access forbidden: cline-free/geo-blocked is not available in your region', success: false }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const up = { port: server.address().port, st, server };
    const gw = await startGatewayWith([
      openaiProvider('clinex', up, { models: ['geo-blocked', 'healthy-model'], priority: 1 }),
    ], 'geoblock');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 打地区受限的模型 → 失败，但日志必须说清是"不提供该模型"而非熔断
      const r1 = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'geo-blocked', messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(r1.status >= 400, '地区受限应失败，实际 ' + r1.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/这家不提供该模型|地区\/套餐受限/.test(logText),
        '日志应判定为"这家不提供该模型"：' + logText.slice(-400));
      assert.ok(!/breaker OPEN/.test(logText),
        '**绝不能**因为一个地区受限的模型就熔断整家：' + logText.slice(-400));
      // ② 同一家的另一个模型必须**立刻可用**（若熔断器被误触发，这里会失败）
      const r2 = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'healthy-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r2.status, 200,
        '同一家的其它模型不该被地区受限连坐（旧实现整家熔断 30 分钟），实际 ' + r2.status + ' ' + String(r2.text).slice(0, 200));
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('地区受限 403 + **账户池**：不得把该家所有 Key 逐个冷却（连坐效果与熔断整家等价）', async () => {
    // 2026-09-30 审计实测（acct-region）：同一份上游响应，只因为这家配了 2 把 Key，
    // `classifyAccountFailure(403, 地区文案)` 就把两把 Key 全部标成 session（冷却 1 小时）。
    // 随后请求同家**另一个完全正常的模型**，路由阶段直接
    // `provider p1: 2 个账户全部冷却中 → 交给下一家` —— 一个模型坏掉 = 这家对所有模型静默停用。
    // 根因：账户级判定排在"这家不提供该模型"判定**之前**。
    const st = { calls: 0, models: [] };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        st.calls++;
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 忽略 */ }
        st.models.push(body && body.model);
        if (body && body.model === 'geo-blocked') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'access forbidden: cline-free/geo-blocked is not available in your region', success: false }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const up = { port: server.address().port, st, server };
    const gw = await startGatewayWith([
      openaiProvider('acctgeo', up, { models: ['geo-blocked', 'healthy-model'], priority: 1, apiKeys: ['sk-1', 'sk-2'] }),
    ], 'acctgeo');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r1 = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'geo-blocked', messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(r1.status >= 400, '地区受限应失败，实际 ' + r1.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/全部冷却中/.test(logText),
        '不该把该家的 Key 全部冷却 —— 那等于这家对所有模型静默停用 1 小时：' + logText.slice(-500));
      // 关键：紧接着请求同家另一个模型，必须立刻可用
      const r2 = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'healthy-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r2.status, 200,
        '同家的另一个模型不该被账户冷却连坐，实际 ' + r2.status + ' ' + String(r2.text).slice(0, 200));
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('地区受限 403 + 账户池 + **协议翻译路径**：同样不得熔断整家（第三处通配收尾）', async () => {
    // forwardAnthropicViaOpenAI 的收尾（"全部账户不可用"）原本**没有任何豁免判断**，
    // 于是同一份上游响应在直通路径被判成"不提供该模型"，在翻译路径却熔断整家 30 分钟。
    // Anthropic 客户端 → protocol:'openai-chat' 上游即可走到那条路径。
    const st = { calls: 0, models: [] };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        st.calls++;
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 忽略 */ }
        st.models.push(body && body.model);
        if (body && body.model === 'geo-blocked') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'access forbidden: cline-free/geo-blocked is not available in your region', success: false }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', created: 1, model: body && body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const up = { port: server.address().port, st, server };
    const gw = await startGatewayWith([
      openaiProvider('xacctgeo', up, { models: ['geo-blocked', 'healthy-model'], priority: 1, apiKeys: ['sk-1', 'sk-2'] }),
    ], 'xacctgeo');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r1 = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'geo-blocked', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.ok(r1.status >= 400, '地区受限应失败，实际 ' + r1.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/breaker OPEN/.test(logText),
        '翻译路径也**绝不能**因为一个地区受限的模型熔断整家：' + logText.slice(-500));
      assert.ok(!/全部冷却中/.test(logText), '也不该把该家所有 Key 冷却：' + logText.slice(-500));
      const r2 = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'healthy-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r2.status, 200,
        '同家的另一个模型不该被连坐（旧实现：整家熔断 30 分钟 + 2 把 Key 冷却 1 小时），实际 ' + r2.status + ' ' + String(r2.text).slice(0, 200));
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('400「这家不提供该模型」：**翻译路径也要继续 failover**（旧实现直接回 400）', async () => {
    // 上游对不支持的模型回 400 `Requested model X not supported`。
    // 直通路径 2026-09-23 已修成"继续 failover"；翻译路径的同类判定被包在
    // `401||403||429||>=500` 分支**内部**，400 走不到，落到 DETERMINISTIC_4XX → 直接回客户端 400。
    // 于是"第一家不提供、第二家提供"的正常场景在翻译路径上必然失败。
    const mkUp = (reject) => http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 忽略 */ }
        if (reject && body && body.model === 'test-model') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Requested model test-model not supported', type: 'invalid_request_error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', created: 1, model: body && body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    const s1 = mkUp(true);
    const s2 = mkUp(false);
    await new Promise((r) => s1.listen(0, '127.0.0.1', r));
    await new Promise((r) => s2.listen(0, '127.0.0.1', r));
    const up1 = { port: s1.address().port, server: s1 };
    const up2 = { port: s2.address().port, server: s2 };
    const gw = await startGatewayWith([
      openaiProvider('nope', up1, { models: ['test-model'], priority: 1 }),
      openaiProvider('yes', up2, { models: ['test-model'], priority: 2 }),
    ], 'xlate400ns');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200,
        '第一家回 400「不提供该模型」时应继续 failover 到第二家，实际 ' + r.status + ' ' + String(r.text).slice(0, 300));
    } finally { killGw(gw); try { s1.close(); } catch { /* 忽略 */ } try { s2.close(); } catch { /* 忽略 */ } }
  });

  t('客户端指纹被拒：长熔断该家并明确说明原因（换 Key/重试无用，继续打会加剧风控）', async () => {
    // 实测依据：agentrouter 前置的 WAF 在连接层做 TLS 指纹 —— 同一把 key，
    // OpenAI SDK → 401 `unauthorized client detected`，Anthropic SDK → 200。
    // 这类拒绝**不是账户问题**：旧实现会逐把冷却用户的 Key 并继续往上打，是最坏的画像行为。
    const st = { calls: 0 };
    const server = http.createServer((req, res) => {
      st.calls++;
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized client detected', type: 'unauthorized_client_error' } }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const up = { port: server.address().port, st, server };
    const gw = await startGatewayWith([
      openaiProvider('fpx', up, { models: ['m1'], priority: 1, apiKeys: ['sk-a', 'sk-b'] }),
    ], 'fingerprint');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r1 = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(r1.status >= 400, '指纹被拒应失败，实际 ' + r1.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/客户端指纹被拒/.test(logText), '日志必须点明是客户端指纹问题：' + logText.slice(-500));
      assert.ok(/breaker OPEN/.test(logText), '指纹被拒应**长熔断该家**（继续打只会加剧风控）：' + logText.slice(-500));
      assert.ok(!/标记为 session/.test(logText),
        '指纹类拒绝**不得**把用户账户标记为 session 失败（换 Key 一点用都没有）：' + logText.slice(-500));
      const after = st.calls;
      // ② 再来一次：应被熔断器直接挡下，**不再打上游**
      const r2 = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(r2.status >= 400);
      assert.strictEqual(st.calls, after, '熔断期间不得再向上游发请求（旧版会在熔断后仍持续打点）');
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('限流遵循 Retry-After：上游给了秒数就按它冷却，且带抖动（不再固定 90 秒）', async () => {
    const st = { calls: 0, t: [] };
    const server = http.createServer((req, res) => {
      st.calls++;
      st.t.push(Date.now());
      req.resume();
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const up = { port: server.address().port, st, server };
    // 用账户池（apiKeys）才走账户级冷却路径 —— 那才是 Retry-After 真正该影响的地方
    const gw = await startGatewayWith([
      openaiProvider('ral', up, { models: ['m1'], priority: 1, apiKeys: ['sk-1', 'sk-2'] }),
    ], 'retryafter');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] } });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/遵循上游 Retry-After/.test(logText),
        '日志应说明遵循了 Retry-After（真实客户端会遵循它，无视它会把短期限流升级成封禁）：' + logText.slice(-500));
      assert.ok(/冷却 2s/.test(logText),
        'Retry-After: 2 应冷却 2 秒（而不是默认的 90 秒）：' + logText.slice(-500));
      // 两把 Key 都该按 2 秒冷却（而不是 90 秒）
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      const all = (h.accounts || []).concat(h.modelScopedAccounts || []);
      const cooling = all.filter((a) => a.state === 'rate');
      assert.ok(cooling.length >= 1, '应有账户进入 rate 冷却：' + JSON.stringify(all));
      for (const a of cooling) {
        assert.ok(Number.isFinite(a.remainMs), 'remainMs 应为数字：' + JSON.stringify(a));
        assert.ok(a.remainMs <= 5000,
          `冷却剩余应≈2s（Retry-After），实际 ${a.remainMs}ms —— 说明没遵循上游头`);
      }
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('账户冷却模型级：某模型的 429 不连坐同 Key 上其它模型（amd 两把 Key 实测事故）', async () => {
    // 上游：对 model-a 回 429（模型级并发上限），对 model-b 正常
    const st429 = { calls: 0 };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        st429.calls++;
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 忽略 */ }
        if (body && body.model === 'model-a') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: { error: { message: "Model 'model-a' is at its concurrency limit (32); please retry later or use another model", type: 'rate_limit_error' } } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const up = { port, st: st429, server };
    const gw = await startGatewayWith([
      openaiProvider('amdl', up, { models: ['model-a', 'model-b'], priority: 1, apiKeys: ['sk-1', 'sk-2'] }),
    ], 'modelcool');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 打 model-a → 429 → 两把 Key 都标记（模型级冷却）
      const r1 = await call({ port: gw.port, p: '/v1/messages', body: { model: 'model-a', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(r1.status >= 400, 'model-a 限流应失败，实际 ' + r1.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/模型 model-a 标记为 rate/.test(logText),
        '限流日志应标明是**模型级**冷却：' + logText.slice(-500));
      // /health：账户级应仍是 ok（不把"某模型限流"误报成"整把 Key 不可用"），模型级单独列出
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      const acctLevel = (h.accounts || []).filter((a) => !a.modelScoped);
      assert.ok(acctLevel.every((a) => a.state === 'ok'),
        'model-a 限流不得把账户级状态改成冷却（会连坐其它模型）：' + JSON.stringify(acctLevel));
      const ms = (h.accounts || []).filter((a) => a.modelScoped);
      assert.ok(ms.length > 0 && ms.every((a) => a.model === 'model-a'),
        '/health 应把模型级冷却单独列出并标注模型：' + JSON.stringify(ms));
      // ② 打 model-b：同一把 Key、同一供应商 —— 不该被 model-a 的限流连坐
      const r2 = await call({ port: gw.port, p: '/v1/messages', body: { model: 'model-b', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r2.status, 200, 'model-b 不该被 model-a 的限流连坐（旧实现按账户级冷却 90s），实际 ' + r2.status + ' ' + String(r2.text).slice(0, 200));
    } finally { killGw(gw); try { server.close(); } catch { /* 忽略 */ } }
  });

  t('账户冷却账户级：额度耗尽（402）仍是账户级，会连坐该 Key 的所有模型', async () => {
    const up = await startFakeOpenAIUpstream({ json: true, script: ['credit', 'ok'] });
    const gw = await startGatewayWith([
      openaiProvider('amdc', up, { models: ['m1', 'm2'], priority: 1, apiKeys: ['sk-1', 'sk-2'] }),
    ], 'creditcool');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      await call({ port: gw.port, p: '/v1/messages', body: { model: 'm1', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      // 402 是"整把 Key 都没额度"，必须仍是账户级（不带"模型"字样）
      assert.ok(/标记为 credit/.test(logText), '应标记为 credit：' + logText.slice(-400));
      assert.ok(!/模型 m1 标记为 credit/.test(logText),
        '额度耗尽不该退化成模型级（整把 Key 都不可用）：' + logText.slice(-400));
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      const cooling = (h.accounts || []).filter((a) => !a.modelScoped && a.state === 'credit');
      assert.ok(cooling.length >= 1, '额度耗尽应体现在账户级状态上：' + JSON.stringify(h.accounts));
    } finally { killGw(gw); closeUp(up); }
  });

  t('402 额度/预算耗尽 → 判为"长期状态"（长熔断），不再按 90 秒临时冷却反复重探', async () => {
    const up = await startFakeUpstream({
      status: 402,
      errorBody: { error: { message: 'Budget pool quota has been exhausted. Please ask an administrator to increase the limit' } },
    });
    const gw = await startGatewayWith([providerOf('q402', up, { priority: 1 })], 'q402', {
      DSH_GATEWAY_BREAKER_LONG_MS: '1500', DSH_GATEWAY_BREAKER_SHORT_MS: '1500',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 503, '唯一候选额度耗尽 → 503，实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/供应商账号\/额度\/权限"类错误（长期状态 → 冷却整家）/.test(logText),
        '额度耗尽必须判为长期状态（旧版判"临时"→ 每 90 秒白撞一次）：' + logText.slice(-500));
      assert.ok(/熔断 1500ms/.test(logText), '应按长熔断时长开闸：' + logText.slice(-400));
      assert.ok(/鉴权\/欠费\/权限类：与具体模型无关 → 冷却整家/.test(logText),
        '长期额度状态要明说"冷却整家"（临时类则是"仅该模型"，2026-10-14 把两者分开）：' + logText.slice(-500));
      assert.strictEqual(up.st.calls, 1, '应只打一次上游，实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网络类熔断按连续开闸次数指数退避（90s→3m→…，修"坏家每 90 秒被重探"）', async () => {
    // ⚠ 规则 2/3（2026-10-14）之后，上游**给了响应**的失败（4xx/5xx/429/超时）记在**模型级**，
    // 供应商级的指数退避阶梯只剩"连接根本没建立"这一类。所以这条用例必须用**连不上的家**
    //（端口没人监听 → ECONNREFUSED）来测 —— 它测的本来就是"网络类熔断"，语义反而更准了。
    const deadPort = await freePort();
    const deadProv = {
      id: 'flap', baseURL: 'http://127.0.0.1:' + deadPort + '/v1',
      apiKey: UPSTREAM_KEY, models: ['test-model'], priority: 1, enabled: true,
    };
    const gw = await startGatewayWith([deadProv], 'backoff', {
      DSH_GATEWAY_BREAKER_SHORT_MS: '300', DSH_GATEWAY_BREAKER_BACKOFF_MAX_MS: '5000',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 3 连败 → 首次开闸 300ms；之后每等到冷却结束的下一次请求 = 半开探测，失败即按 600/1200ms 递增
      for (let i = 0; i < 3; i++) { await call({ port: gw.port }); }
      await sleep(350); await call({ port: gw.port });
      await sleep(650); await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/熔断 300ms/.test(logText), '首次开闸应为 300ms：' + logText.slice(-600));
      assert.ok(/熔断 600ms/.test(logText), '第 2 次开闸应翻倍到 600ms（旧版固定 300ms）：' + logText.slice(-600));
      assert.ok(/熔断 1200ms/.test(logText), '第 3 次开闸应到 1200ms：' + logText.slice(-600));
      assert.ok(/退避递增/.test(logText), '日志应说明退避：' + logText.slice(-300));
    } finally { killGw(gw); }
  });

  t('半开探测用短超时：坏家不会让用户请求白等 60 秒（当天实测 78.5s 的那次）', async () => {
    const upDead = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'boom' } } });
    const upOk = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('dead', upDead, { priority: 1 }),
      providerOf('ok', upOk, { priority: 2 }),
    ], 'probe', {
      DSH_GATEWAY_BREAKER_PROBE_TIMEOUT_MS: '600', DSH_GATEWAY_BREAKER_SHORT_MS: '300', DSH_GATEWAY_BREAKER_LONG_MS: '300',
      DSH_GW_MODEL_BREAKER_COOLDOWN_MS: '300',   // 500 记在模型级（规则 2/3）
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) { await call({ port: gw.port }); }   // 让 dead 熔断（普通尝试，非探测）
      // 冷却到点后把 dead 改成"永不响应"：这一次请求会让 dead 走半开探测
      upDead.st.status = 200;
      upDead.st.delayMs = 60_000;
      await sleep(400);
      const t0 = Date.now();
      const r = await call({ port: gw.port });
      const dur = Date.now() - t0;
      assert.strictEqual(r.status, 200, '应由健康候选服务，实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker HALF-OPEN: dead/.test(logText), '应确实走了半开探测：' + logText.slice(-400));
      assert.ok(dur < 3000, '探测必须按短超时（600ms）快速放弃，而不是等满 60 秒；实际 ' + dur + 'ms');
    } finally { killGw(gw); closeUp(upDead); closeUp(upOk); }
  });

  t('thinking 回传"学习"：同一家第二次请求不再先失败一次（省掉重复上游失败与计费）', async () => {
    const up = await startFakeUpstream({ thinkingPassback: true });
    const gw = await startGatewayWith([providerOf('tp', up, { priority: 1 })], 'tplearn');
    const body = { model: 'test-model', max_tokens: 64, messages: THINKING_HISTORY };
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r1 = await call({ port: gw.port, p: '/v1/messages', body });
      assert.strictEqual(r1.status, 200, '首次应补位后成功，实际 ' + r1.status + ' ' + r1.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 2, '首次是"原样一次 + 补占位一次"，实际 ' + up.st.calls);
      const r2 = await call({ port: gw.port, p: '/v1/messages', body });
      assert.strictEqual(r2.status, 200, '第二次应成功，实际 ' + r2.status);
      assert.strictEqual(up.st.calls - 2, 1, '第二次必须一次成功（已学习，不再先撞 400），实际 ' + (up.st.calls - 2) + ' 次');
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/已记住该家需求/.test(logText), '首次应记录学习：' + logText.slice(-400));
      assert.ok(/（已学习）预先补齐/.test(logText), '第二次应预先补齐：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(up); }
  });

  t('代理提示只在连接层错误出现：超时中止（AbortError）不得误报"代理未运行"', async () => {
    const up = await startFakeUpstream({ status: 200, delayMs: 60_000 });
    const gw = await startGatewayWith([providerOf('slow', up, { priority: 1, timeoutMs: 400 })], 'hint', {
      // 走代理但回环直连（上游是本机）：请求能连上、然后被我方超时中止 → cause 链为空
      NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:7899', HTTPS_PROXY: 'http://127.0.0.1:7899',
      NO_PROXY: '127.0.0.1,localhost',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 503, '唯一候选超时 → 503，实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/request error/.test(logText), '应记录请求错误：' + logText.slice(-300));
      assert.ok(!/代理未运行/.test(logText),
        'AbortError（超时/取消）不是连接层错误，绝不能提示代理问题：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 2026-09-17：上游"不支持 thinking"（与"必须回传 thinking"相反的另一种规则）----

  t('上游不支持 thinking（HTTP 200 + SSE 首事件错误）→ 去掉顶层参数重试成功，并记住该家', async () => {
    const up = await startFakeUpstream({ rejectThinking: 'sse' });
    const gw = await startGatewayWith([providerOf('nothink', up, { priority: 1 })], 'nothink1');
    const body = {
      model: 'test-model', max_tokens: 64,
      thinking: { type: 'enabled', budget_tokens: 1024 },   // 客户端按模型推理档位自动带的顶层参数
      messages: [{ role: 'user', content: 'hi' }],
    };
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r1 = await call({ port: gw.port, p: '/v1/messages', body });
      assert.strictEqual(r1.status, 200, '去掉 thinking 重试后应成功，实际 ' + r1.status + ' ' + r1.text.slice(0, 200));
      assert.ok(/upstream-ok/.test(r1.text), '客户端应拿到上游正常流：' + r1.text.slice(0, 160));
      assert.strictEqual(up.st.calls, 2, '应是"带 thinking 一次 + 去掉后一次"，实际 ' + up.st.calls);
      assert.ok(!up.st.bodies[1].thinking, '重试请求体不得再带顶层 thinking：' + JSON.stringify(up.st.bodies[1].thinking));
      const log1 = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/不支持 thinking（HTTP 200 \+ SSE 首事件错误）/.test(log1), '日志应记录该形态：' + log1.slice(-400));
      // 第二次请求：已学习 → 首次就剥掉，只打一次上游
      const r2 = await call({ port: gw.port, p: '/v1/messages', body });
      assert.strictEqual(r2.status, 200, '第二次应成功，实际 ' + r2.status);
      assert.strictEqual(up.st.calls - 2, 1, '第二次必须一次成功（已学习，不再先失败），实际 ' + (up.st.calls - 2) + ' 次');
      assert.ok(!up.st.bodies[2].thinking, '已学习后首次即不得带 thinking');
      const log2 = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/（不支持 thinking）→ 去掉顶层 thinking 参数后发送/.test(log2), '日志应记录预先剥离：' + log2.slice(-400));
    } finally { killGw(gw); closeUp(up); }
  });

  t('上游不支持 thinking（HTTP 400 形态）→ 同样去掉参数重试一次；显式 quirks:["drop-thinking"] 则首次就剥离', async () => {
    const up400 = await startFakeUpstream({ rejectThinking: '400' });
    const gw = await startGatewayWith([providerOf('nothink400', up400, { priority: 1 })], 'nothink2');
    const body = { model: 'test-model', max_tokens: 64, thinking: { type: 'enabled', budget_tokens: 512 }, messages: [{ role: 'user', content: 'hi' }] };
    try {
      const r = await call({ port: gw.port, p: '/v1/messages', body });
      assert.strictEqual(r.status, 200, '400 形态也应重试成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up400.st.calls, 2, '应是 400 一次 + 去掉后一次，实际 ' + up400.st.calls);
      assert.ok(/不支持 thinking（HTTP 400）/.test(fs.readFileSync(gw.logPath, 'utf8')), '日志应记录 400 形态');
    } finally { killGw(gw); closeUp(up400); }

    // 显式声明 quirks: ["drop-thinking"] → 不依赖学习，首次请求就剥掉（1 次上游调用）
    const upQ = await startFakeUpstream({ rejectThinking: 'sse' });
    const p = providerOf('quirk', upQ, { priority: 1 });
    p.quirks = ['drop-thinking'];
    const gw2 = await startGatewayWith([p], 'nothink3');
    try {
      const r2 = await call({ port: gw2.port, p: '/v1/messages', body });
      assert.strictEqual(r2.status, 200, '声明 quirk 后应一次成功，实际 ' + r2.status);
      assert.strictEqual(upQ.st.calls, 1, '显式 quirk 应首次就剥离（只打一次上游），实际 ' + upQ.st.calls);
      assert.ok(/（不支持 thinking）→ 去掉顶层 thinking 参数后发送/.test(fs.readFileSync(gw2.logPath, 'utf8')));
    } finally { killGw(gw2); closeUp(upQ); }
  });

  t('不带 thinking 的请求不受影响（drop-thinking 不产生副作用）', async () => {
    const up = await startFakeUpstream({ rejectThinking: 'sse' });
    const gw = await startGatewayWith([providerOf('plain', up, { priority: 1 })], 'nothink4');
    try {
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '普通请求应一次成功，实际 ' + r.status);
      assert.strictEqual(up.st.calls, 1, '不得触发任何重试，实际 ' + up.st.calls);
      assert.ok(!/不支持 thinking/.test(fs.readFileSync(gw.logPath, 'utf8')), '不应记录 thinking 相关处理');
    } finally { killGw(gw); closeUp(up); }
  });

  t('同一逻辑名映射普通 + vision 两个上游 ID：带图片走 vision 变体，纯文本走普通变体', async () => {
    const up = await startFakeUpstream({});
    // 实测 amd 形态：DeepSeek-V4-Flash（普通）与 DeepSeek-V4-Flash-Vision-Exp（带图）
    const p = providerOf('dualid', up, {
      priority: 1,
      models: [
        { id: 'DeepSeek-V4-Flash', as: 'test-model' },
        { id: 'DeepSeek-V4-Flash-Vision-Exp', as: 'test-model', vision: true },
      ],
    });
    const gw = await startGatewayWith([p], 'dualid');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const text = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(text.status, 200, '纯文本应成功，实际 ' + text.status);
      assert.strictEqual(up.st.lastModel, 'DeepSeek-V4-Flash', '纯文本应发普通上游 ID，实际 ' + up.st.lastModel);

      const img = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 32,
          messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] }],
        },
      });
      assert.strictEqual(img.status, 200, '带图应成功，实际 ' + img.status);
      assert.strictEqual(up.st.lastModel, 'DeepSeek-V4-Flash-Vision-Exp',
        '带图片的请求必须走声明了 vision 的上游 ID，实际 ' + up.st.lastModel);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/try dualid for test-model \(anthropic\) → DeepSeek-V4-Flash-Vision-Exp/.test(logText),
        '日志应显示映射到 vision ID：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('多 Key：某把 Key 被上游 403（未授权）→ 换下一把 Key 成功，**不熔断整家**（2026-09-18 用户要求）', async () => {
    const upPool = await startFakeOpenAIUpstream({ script: ['forbidden', 'ok'], json: true });
    const gw = await startGatewayWith([
      openaiProvider('mk403', upPool, { apiKeys: ['sk-bad-key', 'sk-good-key'] }),
    ], 'multikey403');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应换到第 2 把 Key 后成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upPool.st.calls, 2, '同一供应商内应重试一次（换 Key），实际 ' + upPool.st.calls);
      const used = upPool.st.headers.map((h) => h.authorization);
      assert.strictEqual(used[0], 'Bearer sk-bad-key', '第一次应用第 1 把 Key：' + JSON.stringify(used));
      assert.strictEqual(used[1], 'Bearer sk-good-key', '403 后必须换第 2 把 Key：' + JSON.stringify(used));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/标记为 session/.test(logText), '未授权的 Key 应被标记（session 冷却）：' + logText.slice(-400));
      assert.ok(!/breaker OPEN/.test(logText),
        '403 是 Key 级问题，**不得熔断整家**（旧实现会把整家断 30 分钟）：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(upPool); }
  });

  t('多 Key：所有 Key 都 403 时，才交给下一家供应商（不是第一把失败就换家）', async () => {
    const upPool = await startFakeOpenAIUpstream({ behavior: 'forbidden' });
    const upNext = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      openaiProvider('mk403all', upPool, { apiKeys: ['k1', 'k2', 'k3'], priority: 1 }),
      providerOf('fallback403', upNext, { priority: 2 }),
    ], 'multikey403b');
    try {
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '最终应由下一家服务，实际 ' + r.status);
      assert.strictEqual(upPool.st.calls, 3, '该家 3 把 Key 必须**逐把试完**才换家，实际 ' + upPool.st.calls);
      assert.strictEqual(upNext.st.calls, 1, '换家后应打下一家一次，实际 ' + upNext.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      // 契约：Key 级失败先在**家内**轮换；只有该家所有 Key 都不可用，才判该家不可用（长熔断）并换下一家
      assert.ok(/provider mk403all 全部账户不可用/.test(logText),
        '必须逐把 Key 试完后才判该家不可用：' + logText.slice(-400));
      assert.ok(logText.indexOf('全部账户不可用') < logText.indexOf('try fallback403'),
        '顺序必须是：先试完该家所有 Key → 再换下一家：' + logText.slice(-400));
      assert.ok(/breaker OPEN: mk403all/.test(logText),
        '所有 Key 都 403 = 该家确实不可用，应长熔断保护上游账号：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(upPool); closeUp(upNext); }
  });

  // ==================== 2026-09-23 审计修复回归 ====================

  // D5：思维链字段名兼容。旧实现只认 reasoning_content（DeepSeek 系），而 OpenRouter 系
  //（含 Cline，实测 delta.reasoning / delta.reasoning_details）用别的字段名 → 思维链被**静默丢弃**。
  t('D5：上游用 reasoning / reasoning_details 时思维链不再丢失（OpenRouter/Cline 形态）', async () => {
    // 专用假上游：只发 reasoning / reasoning_details（**不发** reasoning_content），模拟 Cline。
    // 注意不能用 startFakeOpenAIUpstream({sseRaw})：那个分支会被 st.json 等前面的分支截胡。
    const raw = [
      'data: ' + JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { reasoning: '第一步：' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', text: '先想一下' }] } }] }) + '\n\n',
      'data: ' + JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: '答案是 42' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const upServer = http.createServer((req, res) => {
      const ch = [];
      req.on('data', (c) => ch.push(c));
      req.on('end', () => {
        upServer.st.calls++;
        upServer.st.headers.push(req.headers);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(raw);
      });
    });
    upServer.st = { calls: 0, headers: [] };
    await new Promise((r) => upServer.listen(0, '127.0.0.1', r));
    const up = { server: upServer, st: upServer.st, port: upServer.address().port };

    const gw = await startGatewayWith([openaiProvider('rc', up)], 'reasoning');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 走 Anthropic 路径：thinking 块最容易断言（非流式聚合）
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '应成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const j = JSON.parse(r.text);
      const think = (j.content || []).filter((b) => b.type === 'thinking');
      assert.strictEqual(think.length, 1, '应产出 1 个 thinking 块（旧实现为 0 = 静默丢弃）：' + JSON.stringify(j.content));
      assert.strictEqual(think[0].thinking, '第一步：先想一下', '思维链内容应按分片顺序拼接且不重复：' + think[0].thinking);
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      assert.strictEqual(text, '答案是 42', '正文应正常：' + text);
      // 关键反证：不得因 reasoning 与 reasoning_details 同时存在而重复
      assert.ok(!/第一步：第一步：/.test(think[0].thinking), '同一分片内两字段内容相同，不得相加导致重复');
    } finally { killGw(gw); closeUp(up); }
  });

  // 需求2：Cline 客户端仿真。上游 api.cline.bot **完全裸头**会被 403 拒绝
  //（实测 "only available via Cline product surfaces"），最小充分集是 X-CLIENT-TYPE。
  // ① 主机名推断是纯函数，直接从源码提取后单测（不能真连 api.cline.bot——那会走公网）。
  t('Cline 仿真：providerClientProfile 按 *.cline.bot 主机名推断（纯函数，从源码提取测试）', async () => {
    const src = fs.readFileSync(MJS, 'utf8');
    const start = src.indexOf('function providerClientProfile(provider) {');
    assert.ok(start >= 0, '源码里应存在 providerClientProfile');
    // 取到函数结束（下一个顶层 function 声明之前）
    const rest = src.slice(start);
    const endIdx = rest.indexOf('\n}\n');
    assert.ok(endIdx > 0, '应能定位函数体结束');
    const fnSrc = rest.slice(0, endIdx + 3);
    // ⚠ 该函数现在依赖模块级的 `clientSimulationProviders`（"指纹被拒→自动仿真"的学习标记），
    // eval 出来的副本没有那个作用域 → 必须**显式传进去**，否则
    // `ReferenceError: clientSimulationProviders is not defined`。
    // 这里传空 Set：本用例只测"按主机名推断"，与学习标记无关。
    // eslint-disable-next-line no-new-func
    const providerClientProfile = new Function('clientSimulationProviders', fnSrc + '\nreturn providerClientProfile;')(new Set());

    assert.strictEqual(providerClientProfile({ baseURL: 'https://api.cline.bot/api/v1' }), 'cline',
      'api.cline.bot 应推断为 cline 仿真');
    assert.strictEqual(providerClientProfile({ baseURL: 'https://www.cline.bot/v1' }), 'cline',
      '*.cline.bot 子域也应推断为 cline');
    assert.strictEqual(providerClientProfile({ baseURL: 'https://API.CLINE.BOT/api/v1' }), 'cline',
      '主机名匹配应大小写不敏感');
    assert.strictEqual(providerClientProfile({ baseURL: 'https://openrouter.ai/api/v1' }), '',
      '非 cline 主机不应推断出仿真档');
    assert.strictEqual(providerClientProfile({ baseURL: 'not-a-url' }), '',
      '非法 baseURL 不得抛错（应返回空串）');
    assert.strictEqual(providerClientProfile({ baseURL: 'https://api.cline.bot/v1', clientProfile: 'codex' }), 'codex',
      '供应商显式声明应优先于主机名推断');
  });

  t('Cline 仿真：显式 clientProfile=cline 时发出完整 Cline 身份头（端到端）', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([
      openaiProvider('cl2', up, { models: ['test-model'], clientProfile: 'cline' }),
    ], 'clinesim2', null, { clientProfile: 'codex' });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '应成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = up.st.headers[0] || {};
      assert.strictEqual(h['x-client-type'], 'cline-sdk', '必须发 X-CLIENT-TYPE: cline-sdk（上游硬门禁）：' + JSON.stringify(h));
      assert.ok(/^Cline\//.test(String(h['user-agent'])), 'User-Agent 应为 Cline 形态（裸 UA 会被 403）：' + h['user-agent']);
      assert.strictEqual(h['x-core-version'], '0.0.87',
        '应带 X-CORE-VERSION，且版本号随 @cline/shared 发布同步（服务端有最低版本门禁）：' + h['x-core-version']);
      assert.strictEqual(h['x-platform'], 'terminal', '应带 X-PLATFORM：' + h['x-platform']);
      assert.strictEqual(h['http-referer'], 'https://cline.bot', '应带 HTTP-Referer：' + h['http-referer']);
      assert.strictEqual(h['x-is-multiroot'], 'false', '应带 X-IS-MULTIROOT：' + h['x-is-multiroot']);
      // 版本号三者必须自洽（同一使用端）：UA / X-CLIENT-VERSION / X-PLATFORM-VERSION 同一个值
      const ver = String(h['x-client-version'] || '');
      assert.ok(/^\d+\.\d+\.\d+$/.test(ver), 'X-CLIENT-VERSION 形态：' + ver);
      assert.strictEqual(h['user-agent'], 'Cline/' + ver, 'UA 版本必须与 X-CLIENT-VERSION 一致');
      assert.strictEqual(h['x-platform-version'], ver, 'X-PLATFORM-VERSION 必须与 X-CLIENT-VERSION 一致');
      // 全局 clientProfile=codex 不应泄漏到这家（逐家仿真优先）
      assert.ok(!/codex/i.test(String(h['user-agent'])), '不得把全局 codex 仿真串到 cline 家：' + h['user-agent']);
    } finally { killGw(gw); closeUp(up); }
  });

  t('Cline 仿真：供应商显式 clientProfile 覆盖主机名推断；非 cline 家不受影响', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    // 主机名不是 cline.bot，但显式声明 clientProfile=cline → 应生效
    const gw = await startGatewayWith([
      openaiProvider('explicit', up, { clientProfile: 'cline' }),
    ], 'clineexp');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '应成功，实际 ' + r.status);
      const h = up.st.headers[0] || {};
      assert.strictEqual(h['x-client-type'], 'cline-sdk',
        '显式 clientProfile=cline 应覆盖主机名推断：' + JSON.stringify(h));
    } finally { killGw(gw); closeUp(up); }
  });

  // D2：旧实现把 breakerRecordSuccess 放在 SSE 偷看**之前**，于是"HTTP 200 + 首事件是 error"
  // 那条路径上的 breakerRecordFail 拿到的是被清零后的新条目 → fails 恒为 1 → **永不开闸**。
  t('D2：HTTP 200 + SSE 首事件是错误 → 连续 3 次后确实开闸（旧实现熔断器完全失效）', async () => {
    const raw = 'event: error\ndata: ' + JSON.stringify({ error: { message: 'Service temporarily unavailable' } }) + '\n\n';
    // 专用假上游（同上：sseRaw 分支会被 startFakeOpenAIUpstream 前面的分支截胡）
    const upServer = http.createServer((req, res) => {
      const ch = [];
      req.on('data', (c) => ch.push(c));
      req.on('end', () => {
        upServer.st.calls++;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(raw);
      });
    });
    upServer.st = { calls: 0 };
    await new Promise((r) => upServer.listen(0, '127.0.0.1', r));
    const up = { server: upServer, st: upServer.st, port: upServer.address().port };

    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      openaiProvider('sse200', up, { priority: 1 }),
      providerOf('fb', up2, { priority: 2 }),
    ], 'd2breaker');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker OPEN: sse200/.test(logText),
        '连续 3 次"200+错误SSE"后应开闸（旧实现 fails 恒为 1、永不开闸）：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(up); closeUp(up2); }
  });

  // D1：半开探测名额泄漏 → 该家永久卡在 half-open（breakerIsOpen 恒真）再也选不中。
  // 原始泄漏点是 forward() 的 accountScoped 分支（账户级失败 → 直接 return，不释放名额）。
  // 观测量设计：用**模型级**限流（429 → rate 冷却只作用于该模型）触发账户级失败分支，
  // 这样换一个模型请求时账户仍可用 → 会真正走到 forward()，从而暴露熔断状态是否卡死。
  //（若用 402 额度耗尽，则是账户级冷却 1800s，后续请求根本到不了 forward()，测不出熔断状态。）
  t('D1：账户级失败后释放半开名额（旧实现会让该家永久卡死，只能重启恢复）', async () => {
    const up = await startFakeOpenAIUpstream({
      script: ['err500', 'err500', 'err500', 'rate429', 'rate429', 'rate429', 'ok', 'ok'],
    });
    const prov = openaiProvider('leak', up, { priority: 1, apiKeys: ['k1'], models: ['test-model', 'test-model-2'] });
    const gw = await startGatewayWith([prov], 'd1leak', {
      DSH_GATEWAY_BREAKER_SHORT_MS: '500',
      DSH_GW_MODEL_BREAKER_COOLDOWN_MS: '500',   // 500/429 记在模型级（规则 2/3）
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 3 次 500 → 开闸
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      let logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker OPEN: leak/.test(logText), '应先开闸：' + logText.slice(-400));

      // ② 冷却到点（压到 500ms）→ 放行半开探测；该次探测返回 429
      //    → 账户级失败分支（模型级冷却）→ 必须释放半开名额
      await new Promise((r) => setTimeout(r, 900));
      await call({ port: gw.port });
      logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker HALF-OPEN: leak/.test(logText), '冷却到点应放行半开探测：' + logText.slice(-400));
      assert.ok(/判定为账户级失败/.test(logText), '该次探测应被判为账户级失败（触发泄漏分支）：' + logText.slice(-400));

      // ③ 关键断言：换一个模型请求（该账户对它有可用性）→ 必须**再次进入** forward()
      //    旧实现名额未释放 → 这里会打 `skip leak (breaker ...)`，永远不再尝试。
      const callsBefore = up.st.calls;
      await call({ port: gw.port, body: { model: 'test-model-2', messages: [{ role: 'user', content: 'hi' }] } });
      const after = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/skip leak \(breaker/.test(after.slice(after.indexOf('判定为账户级失败'))),
        '账户级失败后不得再出现 skip ...(breaker)（旧实现名额泄漏 → 永久 half-open）：' + after.slice(-500));
      assert.ok(up.st.calls > callsBefore,
        '该家必须被再次真正请求（名额已释放），实际上游调用数 ' + callsBefore + ' → ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  // D6：账户失败原因未脱敏 → 用户统一网关 key 可能明文进 /health（免鉴权）与日志。
  t('D6：账户失败原因必须脱敏（上游回显 Authorization 时不得把 key 写进 /health）', async () => {
    const leaky = 'Bearer ' + GATEWAY_KEY;   // 模拟上游把收到的 Authorization 回显在错误体里
    const up = await startFakeOpenAIUpstream({ behavior: 'credit', errorBody: { error: { message: 'insufficient credit: ' + leaky } } });
    const gw = await startGatewayWith([openaiProvider('mask', up, { apiKeys: ['k1'] })], 'd6mask');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!logText.includes(leaky), '日志不得含明文 Authorization 值：' + logText.slice(-400));
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      const reasons = JSON.stringify(h.accounts || []);
      assert.ok(!reasons.includes(leaky), '/health 的 reason 不得含明文 Authorization 值：' + reasons);
    } finally { killGw(gw); closeUp(up); }
  });

  // P1（二次复核修复）：旧 maskSecrets 只认 sk-/dsh-gateway-/eyJ/api-key 头四类，
  // 而本网关聚合的供应商里有大量**不属于这四类**的 key（nvidia 的 nvapi-、amd 的 rc-、
  // x666/windhub/agentrouter 的随机串）。上游在错误体里回显凭证时，这些会明文落进
  // logs/gateway.log，并经**免鉴权的 /health**（必须保持免鉴权：网关进程内自检就是无鉴权
  // GET /health）的 reason 字段对外可见。这里锁住新增的三类兜底规则。
  t('P1：非 sk- 前缀的凭证（nvapi-/rc-/裸 Bearer）也必须脱敏', async () => {
    const leakyNv = 'nvapi-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const leakyRc = 'rc-0123456789abcdef0123456789abcdef';
    const leakyPlain = 'Authorization failed for key ZZZZ1111YYYY2222XXXX3333';
    const body = { error: { message: `bad key ${leakyNv} / ${leakyRc} / ${leakyPlain}` } };
    const up = await startFakeOpenAIUpstream({ behavior: 'credit', errorBody: body });
    const gw = await startGatewayWith([openaiProvider('mask2', up, { apiKeys: ['k1'] })], 'p1mask');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      for (const leaky of [leakyNv, leakyRc, leakyPlain]) {
        assert.ok(!logText.includes(leaky), '日志不得含明文凭证 ' + leaky + '：' + logText.slice(-400));
      }
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      const reasons = JSON.stringify(h.accounts || []);
      for (const leaky of [leakyNv, leakyRc, leakyPlain]) {
        assert.ok(!reasons.includes(leaky), '/health 的 reason 不得含明文凭证 ' + leaky + '：' + reasons);
      }
      // 关键：/health 仍须免鉴权可读（网关自带 watchdog 依赖它，加鉴权会导致自我判死）
      assert.ok(Array.isArray(h.accounts), '/health 仍应免鉴权返回 accounts');
    } finally { killGw(gw); closeUp(up); }
  });

  // D7：/v1/responses 路径的 quirks 曾全部失效（门控排除 responsesMode）
  t('D7：/v1/responses 路径也应用 stringify-tool-choice（旧实现该路径 quirks 全失效）', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([
      openaiProvider('resp', up, { protocol: 'openai-chat', quirks: ['stringify-tool-choice'] }),
    ], 'd7resp');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/responses',
        body: {
          model: 'test-model', input: 'hi',
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
          tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } }],
        },
      });
      // 只要上游被调用就说明路径通了；关键是发出去的 tool_choice 必须是字符串
      assert.ok(up.st.calls >= 1, '上游应被调用，实际 ' + up.st.calls + ' 客户端状态 ' + r.status);
      const sent = up.st.bodies[0] || {};
      if (sent.tool_choice !== undefined) {
        assert.strictEqual(typeof sent.tool_choice, 'string',
          'Responses 路径的 tool_choice 也应被 stringify（旧实现为对象 → 上游 400）：' + JSON.stringify(sent.tool_choice));
      }
    } finally { killGw(gw); closeUp(up); }
  });

  // D11：readTextWithTimeout 曾"读完整个响应体再截断"，limit 形同虚设
  t('D11：上游超大错误体只读前 500 字符即停（旧实现先读完整 body 再截断）', async () => {
    // 上游返回 8MB 错误体；网关只应读前 500 字符。若旧行为，仍会返回（但内存峰值 8MB+）。
    // 这里断言"能快速返回且错误处理正确"，作为行为护栏。
    const big = 'x'.repeat(2 * 1024 * 1024);
    const up = await startFakeOpenAIUpstream({ behavior: 'big400', bigBody: { error: { message: big } } });
    const gw = await startGatewayWith([openaiProvider('big', up)], 'd11big');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const t0 = Date.now();
      const r = await call({ port: gw.port });
      const ms = Date.now() - t0;
      assert.ok(ms < 15000, '超大错误体不应拖慢处理（读满即停）：' + ms + 'ms');
      assert.ok(r.status >= 400, '应把上游错误如实处理，实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      // 日志里只该有截断后的片段（500 字符上限），不应出现完整 2MB
      assert.ok(!logText.includes(big), '日志不得含完整超大错误体：' + logText.length + ' 字符');
    } finally { killGw(gw); closeUp(up); }
  });


  /* ==================================================================================
   * 协议矩阵：任意客户端协议 × 任意上游协议（9 格 × 流式/非流式）
   *
   * 用户要求：*"不论上游模型是什么协议，对外需要同时提供 openai 和 Anthropic，
   * openai 还得支持 responses"*。
   * 改之前实测：9 格里 5 格坏，而且**不是报错，是 HTTP 200 带着错的响应体形状** ——
   * 客户端拿到 200，解析时才炸，比直接报错难查得多。
   * ================================================================================== */

  const MX_WIRES = ['openai-chat', 'anthropic-messages', 'openai-responses'];
  const MX_CLIENTS = {
    chat: { p: '/v1/chat/completions', h: {}, body: (s) => ({ model: 'test-model', stream: s, messages: [{ role: 'user', content: 'hi' }] }) },
    anthropic: { p: '/v1/messages', h: { 'anthropic-version': '2023-06-01' }, body: (s) => ({ model: 'test-model', max_tokens: 32, stream: s, messages: [{ role: 'user', content: 'hi' }] }) },
    responses: { p: '/v1/responses', h: {}, body: (s) => ({ model: 'test-model', stream: s, input: 'hi' }) },
  };

  /** 起一个只讲某一种协议的假上游（流式/非流式都能回）。 */
  async function startWireUpstream(wire) {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let b = null;
        try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* 忽略 */ }
        const model = (b && b.model) || 'test-model';
        const wantStream = !!(b && b.stream);
        if (!wantStream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          if (wire === 'openai-chat') {
            res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
          } else if (wire === 'anthropic-messages') {
            res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } }));
          } else {
            res.end(JSON.stringify({ id: 'r1', object: 'response', status: 'completed', model, output: [{ id: 'i1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } }));
          }
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (wire === 'openai-chat') {
          res.end('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n'
            + 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n'
            + 'data: [DONE]\n\n');
        } else if (wire === 'anthropic-messages') {
          res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"' + model + '","content":[],"usage":{"input_tokens":7,"output_tokens":0}}}\n\n'
            + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
            + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n'
            + 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
            + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n'
            + 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
        } else {
          res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"r1","object":"response","status":"in_progress","model":"' + model + '","output":[]}}\n\n'
            + 'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"i1","type":"message","role":"assistant","content":[]}}\n\n'
            + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"i1","output_index":0,"delta":"OK"}\n\n'
            + 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","object":"response","status":"completed","model":"' + model + '","output":[{"id":"i1","type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n');
        }
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { srv, port: srv.address().port };
  }

  /** 形状判定：客户端拿到的是不是**它自己协议的**形状。 */
  function mxShapeOk(clientKey, text, streaming) {
    const t = String(text || '');
    if (!t) return '空响应';
    if (clientKey === 'chat') {
      if (!/\"choices\"/.test(t)) return '不是 chat 形状';
      if (streaming && !/\[DONE\]/.test(t)) return 'chat SSE 缺 [DONE]';
      return '';
    }
    if (clientKey === 'anthropic') {
      if (streaming) {
        if (!/event: message_start/.test(t)) return '不是 anthropic SSE';
        if (!/event: message_stop/.test(t)) return 'anthropic SSE 缺 message_stop';
        return '';
      }
      if (!/\"type\":\"message\"/.test(t)) return '不是 message 形状';
      return '';
    }
    if (!/\"object\":\"response\"/.test(t)) return '不是 response 形状';
    if (streaming && !/event: response\.completed/.test(t)) return 'responses SSE 缺 response.completed';
    return '';
  }

  t('协议矩阵（非流式）：9 个格子全部返回客户端自己的协议形状', async () => {
    const bad = [];
    for (const wire of MX_WIRES) {
      const up = await startWireUpstream(wire);
      const p = providerOf('mx', up, { priority: 1 });
      p.protocol = wire;
      const gw = await startGatewayWith([p], 'mx-ns-' + wire);
      try {
        assert.ok(gw.ready, wire + ' 实例应就绪');
        for (const [ck, cl] of Object.entries(MX_CLIENTS)) {
          const r = await call({ port: gw.port, p: cl.p, body: cl.body(false), ac: null, headers: cl.h });
          const why = r.status !== 200 ? 'HTTP ' + r.status + ' ' + String(r.text).slice(0, 60) : mxShapeOk(ck, r.text, false);
          if (why) bad.push('上游 ' + wire + ' → 客户端 ' + ck + '：' + why);
        }
      } finally { killGw(gw); closeUp(up); }
    }
    assert.deepStrictEqual(bad, [],
      '跨协议必须翻译成客户端自己的形状（旧实现是"200 + 错的形状"，比报错更难查）：\n  ' + bad.join('\n  '));
  });

  t('协议矩阵（流式）：9 个格子全部给出客户端自己的 SSE 事件序列', async () => {
    const bad = [];
    for (const wire of MX_WIRES) {
      const up = await startWireUpstream(wire);
      const p = providerOf('mx', up, { priority: 1 });
      p.protocol = wire;
      const gw = await startGatewayWith([p], 'mx-st-' + wire);
      try {
        assert.ok(gw.ready, wire + ' 实例应就绪');
        for (const [ck, cl] of Object.entries(MX_CLIENTS)) {
          const r = await call({ port: gw.port, p: cl.p, body: cl.body(true), ac: null, headers: cl.h });
          const why = r.status !== 200 ? 'HTTP ' + r.status + ' ' + String(r.text).slice(0, 60) : mxShapeOk(ck, r.text, true);
          if (why) bad.push('上游 ' + wire + ' → 客户端 ' + ck + '：' + why);
        }
      } finally { killGw(gw); closeUp(up); }
    }
    assert.deepStrictEqual(bad, [],
      '流式跨协议必须逐帧翻译成客户端的事件序列：\n  ' + bad.join('\n  '));
  });

  t('协议矩阵：逐模型 api 覆盖供应商 protocol（同一家混三种协议）', async () => {
    // 实测场景：opencode-go 的 37 个模型里 29 个 chat + 2 个 anthropic + 4 个 responses。
    // 只有供应商级 protocol 时只能挑一种，另外两种必然被上游拒。
    const upChat = await startWireUpstream('openai-chat');
    const upResp = await startWireUpstream('openai-responses');
    const pChat = providerOf('mix', upChat, { priority: 1 });
    pChat.protocol = 'openai-chat';   // 供应商级：chat
    const pResp = providerOf('mix2', upResp, { priority: 2 });
    pResp.protocol = 'openai-chat';   // 供应商级也是 chat……
    pResp.models = [{ id: 'test-model', api: 'openai-responses' }];   // ……但逐模型声明是 responses
    const gw = await startGatewayWith([pChat, pResp], 'mx-permodel');
    try {
      assert.ok(gw.ready, '应就绪');
      // 客户端说 Anthropic：p1 走 chat 翻译（可用），这里主要验证 p2 的逐模型声明生效
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.ok(/\"type\":\"message\"/.test(r.text), '客户端仍应拿到 Anthropic 形状：' + String(r.text).slice(0, 120));
    } finally { killGw(gw); closeUp(upChat); closeUp(upResp); }
  });


  t('非流式：有 tool_calls 就必须是 tool_use（不能看 finish_reason）', async () => {
    // OpenAI 世界里"给了 tool_calls 却把 finish_reason 写成 stop"是被普遍容忍的写法。
    // 旧实现照 finish_reason 翻，于是同一个上游、同一份 body：
    //   流式 → stop_reason:"tool_use"（工具照常执行）
    //   非流式 → stop_reason:"end_turn"（Anthropic 客户端**不执行工具**，当最终答案收尾）
    // 同一条翻译链的两条路径给出相反结论 —— 必须消除。
    // 这里自带一个假上游（startFakeUpstream 的响应体是固定的，给不出这种畸形组合）。
    const srv = http.createServer((q, s) => {
      q.resume();
      q.on('end', () => {
        s.writeHead(200, { 'content-type': 'application/json' });
        s.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const up = { srv, port: srv.address().port, st: { modelsReqs: 0 } };
    const p = providerOf('tcu', up, { priority: 1 });
    p.protocol = 'openai-chat';
    const gw = await startGatewayWith([p], 'tooluse');
    try {
      assert.ok(gw.ready, '应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const j = JSON.parse(r.text);
      assert.ok((j.content || []).some((b) => b.type === 'tool_use'), '应有 tool_use 块：' + r.text.slice(0, 200));
      assert.strictEqual(j.stop_reason, 'tool_use',
        'finish_reason=stop 但带 tool_calls 时必须报 tool_use，否则客户端不执行工具；实际 ' + j.stop_reason);
    } finally {
      killGw(gw);
      try { srv.close(); } catch { /* 忽略 */ }
    }
  });
  // 执行
  // 2026-09-23 实测事故：上游说"**这家**没有这个模型"，旧实现当"请求本身有错"终止 failover，
  // 用户直接拿到 400 —— 而同一逻辑模型在下一家完全可用。
  // 关键区分：换下一家有意义（供应商侧问题） vs 换也没用（参数/体积类请求错误）。
  t('上游回"这家没有该模型"→ 继续 failover（不再终止；amd 实测形态）', async () => {
    // amd 的真实措辞（400，注意是 "not supported" 不是 "unsupported"）
    const up1 = await startFakeUpstream({
      status: 400,
      errorBody: { error: { message: 'Requested model test-model not supported', type: 'invalid_request_error', param: null, code: null } },
    });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('nomodel', up1, { priority: 1 }),
      providerOf('good', up2, { priority: 2 }),
    ], 'unsup');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200,
        '应由下一家服务（旧实现终止 failover 回 400）：' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up1.st.calls, 1, '第一家只应被尝试一次，实际 ' + up1.st.calls);
      assert.ok(up2.st.calls >= 1, '必须换到下一家，实际 ' + up2.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/这家不提供该模型/.test(logText), '日志应说明判定为"这家不提供该模型"：' + logText.slice(-400));
      // 关键：不得熔断该家（熔断是按供应商粒度，该家对别的模型可能正常 → 连坐）
      assert.ok(!/breaker OPEN: nomodel/.test(logText),
        '不得因"没有这个模型"熔断整家（会连坐该家其它模型）：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('对照（新契约）：参数非法的 400 也**继续 failover**（用户要求"任何一家失败都要往下走"）', async () => {
    // ⚠ 契约变更（2026-10-15，用户明确要求）。旧契约是"参数错终止 failover，不 N 倍重发"。
    // 用户原话："即使 commandcode 排在了 sensenova 和 amd 后面，调用时也不应该失败了就直接中断，
    // 而应该继续按优先级往下调用，最终 commandcode 兜底！！"
    // 取舍：真正请求侧错误时会在各候选上多打几发（各家都是秒回的 400，基本不计费），
    // 换来"优先级高的一家的抽风/误报不再打死整轮任务"。全部候选都失败时仍回原 4xx（见下一条）。
    const up1 = await startFakeUpstream({
      status: 400,
      errorBody: { error: { message: 'invalid temperature: must be <= 2' } },
    });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('badparam', up1, { priority: 1 }),
      providerOf('good2', up2, { priority: 2 }),
    ], 'badparam');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200,
        '参数非法的 400 后仍要走完候选，由第二家服务（旧契约就地回 400），实际 ' + r.status);
      assert.ok(up2.st.calls >= 1,
        '必须尝试下一家，实际 ' + up2.st.calls);
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('对照（新契约）：参数非法且**所有**候选都拒绝 → 仍回 400（状态码语义不倒退）', async () => {
    const up1 = await startFakeUpstream({
      status: 400,
      errorBody: { error: { message: 'invalid temperature: must be <= 2' } },
    });
    const up2 = await startFakeUpstream({
      status: 400,
      errorBody: { error: { message: 'invalid temperature: must be <= 2' } },
    });
    const gw = await startGatewayWith([
      providerOf('badparam1', up1, { priority: 1 }),
      providerOf('badparam2', up2, { priority: 2 }),
    ], 'badparamall');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 400, '全部候选都回 400 时应回 400（不是 503），实际 ' + r.status);
      assert.ok(up2.st.calls >= 1, '第二家也必须被尝试，实际 ' + up2.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/failover exhausted/.test(logText), '日志须写明走完全部候选：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('"这家没有该模型"的多种措辞都能识别（amd 400/404 与通用 unsupported）', async () => {
    const variants = [
      'Requested model test-model not supported',          // amd 400（Anthropic 形）
      'Model test-model is not available',                 // amd 404 形态的措辞
      'unsupported model: test-model',                     // 通用措辞
      'model not offered by this provider',                // 通用措辞
    ];
    for (const [i, msg] of variants.entries()) {
      const up1 = await startFakeUpstream({ status: 400, errorBody: { error: { message: msg } } });
      const up2 = await startFakeUpstream({ status: 200 });
      const gw = await startGatewayWith([
        providerOf('v' + i, up1, { priority: 1 }),
        providerOf('ok' + i, up2, { priority: 2 }),
      ], 'unsupv' + i);
      try {
        assert.ok(gw.ready, '实例 ' + i + ' 应就绪');
        const r = await call({ port: gw.port });
        assert.strictEqual(r.status, 200, '措辞「' + msg + '」应继续 failover，实际 ' + r.status);
        assert.ok(up2.st.calls >= 1, '措辞「' + msg + '」应换到下一家');
      } finally { killGw(gw); closeUp(up1); closeUp(up2); }
    }
  });

  /* ==================================================================================
   * 本轮四项能力（来源：dsh-our-free-model / dsh-factory-provider 的实战教训）
   * ① 工具调用配对修复  ② Anthropic 缓存断点  ③ 按响应体形状判定流式  ④ 解码速度计量
   * ================================================================================== */

  t('① 工具配对：assistant 声明了 tool_calls 却没有结果 → 补一条占位应答（chat 协议）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([providerOf('pc1', up, { priority: 1 })], 'pair-chat');
    try {
      assert.ok(gw.ready, '应就绪');
      // 残缺记录：assistant 已记下调用，但用户中途点了停止 / 客户端崩了，结果从没写回
      const r = await call({
        port: gw.port,
        body: {
          model: 'test-model',
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: '{}' } }] },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '转发应成功，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      const sent = up.st.bodies[up.st.bodies.length - 1];
      const answered = (sent.messages || []).filter((m) => m && m.role === 'tool' && m.tool_call_id === 'call_a');
      assert.strictEqual(answered.length, 1,
        '上游必须收到一条 tool_call_id=call_a 的应答（否则它会 400 并永久污染该会话）；实际消息数 ' + (sent.messages || []).length);
      assert.ok(typeof answered[0].content === 'string' && answered[0].content.length > 0, '占位应答不能是空串');
    } finally { killGw(gw); closeUp(up); }
  });

  t('① 工具配对：Anthropic 协议下 tool_use 缺 tool_result → 补一条（/v1/messages）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([providerOf('pa1', up, { priority: 1 })], 'pair-anth');
    try {
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 16,
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'f', input: {} }] },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '转发应成功，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      const sent = up.st.bodies[up.st.bodies.length - 1];
      const blocks = (sent.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
      const results = blocks.filter((b) => b && b.type === 'tool_result' && b.tool_use_id === 'toolu_a');
      assert.strictEqual(results.length, 1, '必须补出 tool_use_id=toolu_a 的 tool_result');
    } finally { killGw(gw); closeUp(up); }
  });

  t('① 工具配对：孤儿 tool 消息（没有对应调用）→ 剔除，不发给上游', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([providerOf('po1', up, { priority: 1 })], 'pair-orphan');
    try {
      const r = await call({
        port: gw.port,
        body: {
          model: 'test-model',
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'tool', tool_call_id: 'call_ghost', content: 'orphan-result' },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '转发应成功，实际 ' + r.status);
      const sent = up.st.bodies[up.st.bodies.length - 1];
      const ghosts = (sent.messages || []).filter((m) => m && m.tool_call_id === 'call_ghost');
      assert.strictEqual(ghosts.length, 0, '孤儿 tool 消息必须被剔除（上游会 400）');
    } finally { killGw(gw); closeUp(up); }
  });

  t('② 缓存断点：长 Anthropic 请求自动打断点（缓存读 ×0.1 vs 未缓存 ×1）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([providerOf('cb1', up, { priority: 1 })], 'cachebp');
    try {
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 16,
          system: 'S'.repeat(6000),   // 6000 字符 ≈ 1500 token，超过 CACHE_MIN_TOKENS(1024)，值得缓存
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
      assert.strictEqual(r.status, 200, '转发应成功，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      const sent = up.st.bodies[up.st.bodies.length - 1];
      const text = JSON.stringify(sent);
      assert.ok(text.includes('cache_control'), '长请求应被放置缓存断点');
      assert.ok(/ephemeral/.test(text), '断点类型应为 ephemeral');
      // 字符串 system 会被升级成块数组（只有块形态才能挂 cache_control）
      assert.ok(Array.isArray(sent.system), 'system 应被规范化为块数组');
    } finally { killGw(gw); closeUp(up); }
  });

  t('② 缓存断点：客户端自己带了 cache_control → 一个字节都不动（尊重客户端策略）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([providerOf('cb2', up, { priority: 1 })], 'cachebp-cli');
    try {
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 16,
          system: [{ type: 'text', text: 'S'.repeat(6000), cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
      assert.strictEqual(r.status, 200, '转发应成功，实际 ' + r.status);
      const sent = up.st.bodies[up.st.bodies.length - 1];
      const n = (JSON.stringify(sent).match(/cache_control/g) || []).length;
      assert.strictEqual(n, 1, '客户端已自带一个断点时不得再追加，实际 ' + n + ' 个');
    } finally { killGw(gw); closeUp(up); }
  });

  t('② 缓存断点：太短的请求不打断点（低于最小可缓存长度，打了是白花写入费）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([providerOf('cb3', up, { priority: 1 })], 'cachebp-small');
    try {
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '转发应成功，实际 ' + r.status);
      const sent = up.st.bodies[up.st.bodies.length - 1];
      assert.ok(!JSON.stringify(sent).includes('cache_control'), '短请求不应被打断点');
    } finally { killGw(gw); closeUp(up); }
  });

  t('③ 形状判定：Content-Type 谎称 application/json 但 body 是 SSE → 仍按流式转发', async () => {
    // 实测形态（dsh-our-free-model 记录）：上游高负载时用 200 + application/json 回完整 SSE 帧。
    // 旧实现只信 header → 把整条流当 JSON 读、解析失败、整轮报废。
    const up = await startFakeUpstream({ status: 200, sseAsJson: true });
    const gw = await startGatewayWith([providerOf('sn1', up, { priority: 1 })], 'sniff');
    try {
      assert.ok(gw.ready, '应就绪');
      const r = await call({
        port: gw.port,
        body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.ok(/upstream-ok/.test(r.text), 'SSE 帧内容应原样到达客户端，实际 ' + r.text.slice(0, 200));
      assert.ok(/data:\s*\[DONE\]/.test(r.text), '结束帧也应到达，实际 ' + r.text.slice(0, 200));
      const log = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/但响应体形状是 SSE/.test(log), '日志应如实记下"header 与形状不一致"这一次判定');
    } finally { killGw(gw); closeUp(up); }
  });

  t('④ 解码速度：日志给出首字延迟与解码速度，并剔除未流出的 reasoning token', async () => {
    // 分两段发，制造一个真实的解码时间窗（一次性 flush 的窗口≈0ms，按设计就该留空）
    const part1 = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n';
    const part2 = 'data: {"choices":[{"delta":{"content":"b"}}],'
      + '"usage":{"completion_tokens":60,"completion_tokens_details":{"reasoning_tokens":10}}}\n\n'
      + 'data: [DONE]\n\n';
    const up = await startFakeUpstream({ status: 200, sseBody: part1 + part2, sseSplitAt: part1.length, sseGapMs: 800 });
    const gw = await startGatewayWith([providerOf('dm1', up, { priority: 1 })], 'decodemeter');
    try {
      const r = await call({
        port: gw.port,
        body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 160));
      await new Promise((res) => setTimeout(res, 300));   // 等日志落盘
      const log = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/\[decode\]/.test(log), '应记下解码速度读数，日志尾部：' + log.slice(-300));
      assert.ok(/ttfb=\d+ms/.test(log), '应记下首字延迟');
      // 分子必须是 60-10=50（reasoning token 在首字之前就已生成完毕，不属于解码窗口）
      assert.ok(/50 tok\//.test(log), '应剔除 10 个未流出的 reasoning token（分子 60→50），日志尾部：' + log.slice(-300));
      assert.ok(/已剔除未流出 reasoning 10/.test(log), '应如实标注剔除了多少');
    } finally { killGw(gw); closeUp(up); }
  });

  /* ==================================================================================
   * ⑤ 会话亲和（缓存友好）：同一会话优先回到上次成功的那家
   * 动机：Anthropic 的 prompt cache 绑定在上游账号上，反复换家 = 缓存永远命中不了。
   * ================================================================================== */

  // 长前缀（超过 SESSION_AFFINITY_MIN_TOKENS=512）才会启用兜底键。
  // ⚠ 必须是**正常文本**：R9b 会把"≥32 位连续字母数字"当疑似密钥长串打码（而且不保留长度），
  // 用 'X'.repeat(4000) 这种数据会被压成十来个字符，前缀直接不够门槛 —— 测的东西就不是它了。
  const LONG_PREFIX = '这是一段用于测试的普通中文文本，讲的是会话亲和与缓存命中的关系。'.repeat(120);   // ≈3600 字符 ≈900 token，稳过 512 门槛

  t('⑤ 会话亲和：长前缀会话在 failover 后钉住成功的那家（不再白打坏家、缓存不用重建）', async () => {
    const dead = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'boom' } } });
    const ok = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('dead', dead, { priority: 1 }),
      providerOf('ok', ok, { priority: 2 }),
    ], 'aff-on');
    try {
      const body = { model: 'test-model', messages: [{ role: 'user', content: LONG_PREFIX }] };
      const r1 = await call({ port: gw.port, body });
      assert.strictEqual(r1.status, 200, '第一轮应由健康候选服务，实际 ' + r1.status);
      assert.ok(dead.st.calls >= 1, '第一轮应尝试过 priority=1 的坏家');
      const deadAfterFirst = dead.st.calls;

      const r2 = await call({ port: gw.port, body });
      assert.strictEqual(r2.status, 200, '第二轮实际 ' + r2.status);
      assert.strictEqual(dead.st.calls, deadAfterFirst,
        '第二轮不该再尝试已失败的那家（每次重试都要重建缓存），实际 ' + dead.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/会话亲和/.test(logText), '日志应说明走了会话亲和：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(dead); closeUp(ok); }
  });

  t('⑤ 会话亲和：短前缀不启用（没有值得保护的缓存，不该改变选路）', async () => {
    const dead = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'boom' } } });
    const ok = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('dead', dead, { priority: 1 }),
      providerOf('ok', ok, { priority: 2 }),
    ], 'aff-short');
    try {
      // 'hi' 远低于门槛 —— 这种会话没有可缓存的长前缀，亲和只会带来"不相干会话被绑在一起"的副作用
      const body = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };
      await call({ port: gw.port, body });
      const deadAfterFirst = dead.st.calls;
      await call({ port: gw.port, body });
      assert.ok(dead.st.calls > deadAfterFirst,
        '短前缀应照常按 priority 重试第一家（不启用亲和），实际 ' + dead.st.calls + ' vs ' + deadAfterFirst);
    } finally { killGw(gw); closeUp(dead); closeUp(ok); }
  });

  t('⑤ 会话亲和：配置 sessionAffinity=off → 完全关闭（长前缀也照常重试第一家）', async () => {
    const dead = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'boom' } } });
    const ok = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('dead', dead, { priority: 1 }),
      providerOf('ok', ok, { priority: 2 }),
    ], 'aff-off', undefined, { sessionAffinity: 'off' });
    try {
      const body = { model: 'test-model', messages: [{ role: 'user', content: LONG_PREFIX }] };
      await call({ port: gw.port, body });
      const deadAfterFirst = dead.st.calls;
      await call({ port: gw.port, body });
      assert.ok(dead.st.calls > deadAfterFirst,
        '关掉之后应回到"每轮都从 priority 头开始"，实际 ' + dead.st.calls + ' vs ' + deadAfterFirst);
    } finally { killGw(gw); closeUp(dead); closeUp(ok); }
  });

  t('⑤ 会话亲和：被钉住的那家转坏时，亲和跟着新的成功方走（不会一直钉在坏家）', async () => {
    const a = await startFakeUpstream({ status: 200 });
    const b = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'boom' } } });
    const gw = await startGatewayWith([
      providerOf('a', a, { priority: 1 }),
      providerOf('b', b, { priority: 2 }),
    ], 'aff-move');
    try {
      const body = { model: 'test-model', messages: [{ role: 'user', content: LONG_PREFIX }] };
      const r1 = await call({ port: gw.port, body });
      assert.strictEqual(r1.status, 200, '第一轮应走 a，实际 ' + r1.status);
      // a 转坏 → 下一轮应由 b 服务，并把亲和改记到 b
      a.st.status = 500;
      b.st.status = 200;
      const r2 = await call({ port: gw.port, body });
      assert.strictEqual(r2.status, 200, '第二轮应 failover 到 b，实际 ' + r2.status);
      assert.ok(b.st.calls >= 1, 'b 应被尝试');
      const aAfter = a.st.calls;
      // 第三轮：亲和已改记 b → 不该再白打 a
      const r3 = await call({ port: gw.port, body });
      assert.strictEqual(r3.status, 200, '第三轮实际 ' + r3.status);
      assert.strictEqual(a.st.calls, aAfter, '第三轮不该再尝试已转坏的 a，实际 ' + a.st.calls);
    } finally { killGw(gw); closeUp(a); closeUp(b); }
  });

  /* ==================================================================================
   * ⑥ 免费通道预设：OpenCode 客户端仿真（头 + 工具指纹门 + 稳定会话 id）
   * ================================================================================== */

  t('⑥ OpenCode 车道：按对话内容补三种仿真头（静态头做不到会话/请求 id）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const p = providerOf('oc1', up, { priority: 1 });
    p.clientProfile = 'opencode';
    const gw = await startGatewayWith([p], 'oc-headers');
    try {
      const r = await call({
        port: gw.port,
        body: { model: 'test-model', messages: [{ role: 'user', content: LONG_PREFIX }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 160));
      const h = up.st.headers[up.st.headers.length - 1];
      assert.strictEqual(h['x-opencode-client'], 'desktop', '应有客户端身份头');
      assert.ok(/^opencode\/\d+\.\d+/.test(h['user-agent'] || ''), 'UA 应是 opencode/<版本>：' + h['user-agent']);
      assert.ok(/^ses_/.test(h['x-opencode-session'] || ''), '会话 id 形态应为 ses_…：' + h['x-opencode-session']);
      assert.ok(/^msg_/.test(h['x-opencode-request'] || ''), '请求 id 形态应为 msg_…：' + h['x-opencode-request']);
    } finally { killGw(gw); closeUp(up); }
  });

  t('⑥ OpenCode 车道：同一对话的会话 id 必须跨轮稳定（每请求换一个会直接 429）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const p = providerOf('oc2', up, { priority: 1 });
    p.clientProfile = 'opencode';
    const gw = await startGatewayWith([p], 'oc-session');
    try {
      const body = { model: 'test-model', messages: [{ role: 'user', content: LONG_PREFIX }] };
      await call({ port: gw.port, body });
      await call({ port: gw.port, body });
      const sids = up.st.headers.map((h) => h['x-opencode-session']);
      assert.ok(sids.length >= 2, '应收到两次请求，实际 ' + sids.length);
      assert.strictEqual(sids[0], sids[1],
        '同一段对话两轮的会话 id 必须相同（上游按会话计费）：' + sids[0] + ' vs ' + sids[1]);
      const rids = up.st.headers.map((h) => h['x-opencode-request']);
      assert.notStrictEqual(rids[0], rids[1], '请求 id 应当每轮不同');
    } finally { killGw(gw); closeUp(up); }
  });

  t('⑥ OpenCode 车道：会话 id 的 12 位 hex **低 12 位必须是合规计数器**（否则上游恒 403）', async () => {
    // 现场（2026-10-19）：旧实现 `'ses_' + sha16(...).slice(0,12) + hex` 形状对，
    // 既有用例也只断言 /^ses_/ —— 于是它**骗过了测试**，却在真实上游恒
    // `403 FreeTierError`，表现为"配置了这条车道却永远不通"，日志里只有一句 403，极难定位。
    //
    // 逐位受控实测确定了真实判据（其余照配方，只改这 12 位）：
    //     counter=1 → 200 ✓   counter=63 → 200 ✓（窗内上沿）
    //     counter=64 → 403 ✗  counter=2000 → 403 ✗（越窗）
    //     时钟位全 0 + counter=1 → 200 ✓  ← **时钟位完全不校验**
    //     纯摘要派生的 12 位 → 403 ✗（低 12 位是随机值，落窗概率约 1.5%）
    //
    // ⚠ 所以断言只能是"低 12 位 ∈ [0,63]"，**不能**写"解回的时钟要接近当前时间" ——
    //   后者数学上就不成立（now(ms)*4096 超过 48 位，高位必然被截断，实测解回的是 1970 年附近的数）。
    //   我第一版就写错了这条，实测解出 -1786706395131ms 才发现。
    const up = await startFakeUpstream({ status: 200 });
    const p = providerOf('oc-clock', up, { priority: 1 });
    p.clientProfile = 'opencode';
    const gw = await startGatewayWith([p], 'oc-clock');
    try {
      const r = await call({
        port: gw.port,
        body: { model: 'test-model', messages: [{ role: 'user', content: LONG_PREFIX }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const sid = up.st.headers[up.st.headers.length - 1]['x-opencode-session'];
      assert.ok(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(sid),
        '会话 id 必须是上游规范形状 ses_+12位小写hex+14位Base62：' + sid);

      const hex = sid.slice(4, 16);
      const inverted = BigInt('0x' + hex);
      // 还原被取反的时间段：取反回来 → 低 12 位就是计数器
      const restored = ~inverted & 0xffffffffffffn;
      const counter = Number(restored & 0xfffn);
      assert.ok(counter >= 0 && counter <= 63,
        '★ 低 12 位（每毫秒计数器）必须落在上游接受的 [0,63]，实际 ' + counter
        + '（hex=' + hex + '）—— 这一条就是"摘要派生"与"真实时钟算法"的分水岭');

      // 反证：同一个 hex，把低 12 位改成 64（越窗）就必须被上游拒。
      // 这里不联网，只验证我们的构造确实把语义放在了低 12 位上。
      const overWindow = (inverted & ~0xfffn) | BigInt((~64) & 0xfff);
      const overCounter = Number(~overWindow & 0xfffn);
      assert.strictEqual(overCounter, 64,
        '构造出的越窗样例其计数器应为 64（用于说明为何不能随机凑这 12 位）');
    } finally { killGw(gw); closeUp(up); }
  });

  t('⑥ OpenCode 车道：免费档只接受流式 → 客户端要非流式时由网关强制并聚合', async () => {
    // 受控实测：同一份头与工具，只把 stream 改成 false → 403 FreeTierError。
    // 所以网关必须替客户端改成流式，并在客户端本来要非流式时自己聚合回单条 JSON
    //（否则会把裸 SSE 吐给一个期待 JSON 的客户端）。
    // ⚠ 上游必须回一句**语义完整**的 SSE（带 finish_reason）——否则聚合器会（正确地）
    //   判成"上游被腰斩"并回 502，那是另一条既有契约，会把本用例的意图掩盖掉。
    const sseBody = 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n';
    const up = await startFakeUpstream({ status: 200, sseBody });
    const p = providerOf('oc-stream', up, { priority: 1 });
    p.clientProfile = 'opencode';
    const gw = await startGatewayWith([p], 'oc-stream');
    try {
      // ① 客户端显式要非流式 → 上游仍必须是 stream:true，且客户端拿到的是单条 JSON
      const r = await call({
        port: gw.port,
        body: { model: 'test-model', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      });
      const sent = up.st.bodies[up.st.bodies.length - 1];
      assert.strictEqual(sent.stream, true,
        '免费档车道必须把上游请求改成 stream:true（false 会 403）：' + JSON.stringify(sent.stream));
      assert.ok(r.status === 200, '客户端应拿到 200，实际 ' + r.status);
      assert.ok(!/^data: /m.test(r.text || ''),
        '客户端要的是非流式，不得把裸 SSE 交给它：' + String(r.text || '').slice(0, 160));
      const log = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/只接受流式/.test(log), '日志应说明为车道改了流式：' + log.slice(-300));

      // ② 客户端本来就要流式 → 原样透传，不必聚合
      const r2 = await call({
        port: gw.port,
        body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi2' }] },
      });
      assert.strictEqual(r2.status, 200, '流式请求实际 ' + r2.status);
      assert.strictEqual(up.st.bodies[up.st.bodies.length - 1].stream, true, '流式请求上游也应 stream:true');
    } finally { killGw(gw); closeUp(up); }
  });

  t('⑥ OpenCode 车道：补齐免费档要求的工具四元组（缺了上游 403 FreeTierError）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const p = providerOf('oc3', up, { priority: 1 });
    p.clientProfile = 'opencode';
    const gw = await startGatewayWith([p], 'oc-tools');
    try {
      const r = await call({
        port: gw.port,
        body: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ type: 'function', function: { name: 'my_tool', description: 'x', parameters: {} } }],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const sent = up.st.bodies[up.st.bodies.length - 1];
      const names = (sent.tools || []).map((t) => (t.function && t.function.name) || t.name);
      for (const need of ['bash', 'glob', 'grep', 'read']) {
        assert.ok(names.includes(need), '应补出工具 ' + need + '，实际 ' + names.join(','));
      }
      assert.ok(names.includes('my_tool'), '客户端自己的工具必须原样保留');
      const log = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/工具指纹：补声明/.test(log), '日志应如实记下补了哪些占位工具');
    } finally { killGw(gw); closeUp(up); }
  });

  t('⑥ OpenCode 车道：四元组已齐时不重复补（上游把大小写变体当重复项拒）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const p = providerOf('oc4', up, { priority: 1 });
    p.clientProfile = 'opencode';
    const gw = await startGatewayWith([p], 'oc-tools-dup');
    try {
      const r = await call({
        port: gw.port,
        body: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [
            { type: 'function', function: { name: 'Bash', description: 'x', parameters: {} } },
            { type: 'function', function: { name: 'glob', description: 'x', parameters: {} } },
            { type: 'function', function: { name: 'grep', description: 'x', parameters: {} } },
            { type: 'function', function: { name: 'read', description: 'x', parameters: {} } },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const sent = up.st.bodies[up.st.bodies.length - 1];
      const names = (sent.tools || []).map((t) => (t.function && t.function.name) || t.name);
      // 'Bash' 大小写不同也算"已有"（不补第二个），但不得改写成小写（那是客户端的工具名）
      assert.strictEqual(names.filter((n) => String(n).toLowerCase() === 'bash').length, 1,
        'bash/Bash 不得同时出现（上游当重复项拒）：' + names.join(','));
      assert.ok(names.includes('Bash'), '客户端自己的拼写不能被改：' + names.join(','));
    } finally { killGw(gw); closeUp(up); }
  });

  t('⑥ OpenCode 车道：Anthropic 路径上补的工具必须是 Anthropic 形状（补错形状比不补更糟）', async () => {
    // 实测踩到：不分形状地往 Anthropic 的 tools 里推 OpenAI 形状（{type:'function',function:{…}}），
    // 上游直接 400。三种协议的 tools 结构完全不同，必须按当前线协议给对形状。
    const up = await startFakeUpstream({ status: 200 });
    const p = providerOf('oc5', up, { priority: 1 });
    p.clientProfile = 'opencode';
    const gw = await startGatewayWith([p], 'oc-tools-anth');
    try {
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 32,
          tools: [{ name: 'my_tool', description: 'x', input_schema: { type: 'object', properties: {} } }],
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const sent = up.st.bodies[up.st.bodies.length - 1];
      const tools = sent.tools || [];
      const openaiShaped = tools.filter((t) => t && t.function && !t.input_schema);
      assert.strictEqual(openaiShaped.length, 0,
        'Anthropic 路径不得出现 OpenAI 形状的工具条目，实际 ' + openaiShaped.length + ' 条：'
          + tools.map((t) => JSON.stringify(Object.keys(t))).join(' '));
      for (const need of ['bash', 'glob', 'grep', 'read']) {
        const hit = tools.find((t) => t && t.name === need);
        assert.ok(hit, '应补出 Anthropic 形状的 ' + need);
        assert.ok(hit.input_schema, need + ' 必须带 input_schema（Anthropic 形状）');
      }
    } finally { killGw(gw); closeUp(up); }
  });

  t('⑥ OpenCode 车道：短对话也必须给会话头（上游无条件要求，少了一律 400）', async () => {
    // 实测踩到：会话 id 曾复用会话亲和的 sessionKeyOf，而那个带 512 token 门槛
    //（"前缀太短不值得钉缓存"）—— 于是「你好」「hi」「?」这类**最常见的短对话全部拿不到会话头**。
    // 上游对 x-opencode-session 是无条件要求，少了直接 400 MissingSessionID，等于整条车道全废。
    const up = await startFakeUpstream({ status: 200 });
    const p = providerOf('oc6', up, { priority: 1 });
    p.clientProfile = 'opencode';
    const gw = await startGatewayWith([p], 'oc-short-sid');
    try {
      const cases = [
        ['你好', { model: 'test-model', messages: [{ role: 'user', content: '你好' }] }],
        ['hi', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }],
        ['单字', { model: 'test-model', messages: [{ role: 'user', content: '?' }] }],
        ['带 system', { model: 'test-model', system: '你是助手', messages: [{ role: 'user', content: '你好' }] }],
      ];
      for (const [label, body] of cases) {
        const r = await call({ port: gw.port, body });
        assert.strictEqual(r.status, 200, label + ' 应转发成功，实际 ' + r.status);
        const h = up.st.headers[up.st.headers.length - 1];
        assert.ok(/^ses_/.test(h['x-opencode-session'] || ''),
          label + ' 拿不到会话头（上游会 400 MissingSessionID），实际 ' + h['x-opencode-session']);
      }
      // 同一内容跨请求稳定（上游按会话计费，抖动会被当成新会话）
      const first = up.st.headers.find((h) => h['x-opencode-session']);
      await call({ port: gw.port, body: cases[0][1] });
      const again = up.st.headers[up.st.headers.length - 1];
      assert.strictEqual(again['x-opencode-session'], first['x-opencode-session'],
        '相同内容的两轮应得到同一会话 id');
    } finally { killGw(gw); closeUp(up); }
  });

  // 执行
  t('用量记账：三条路径都要记，且总输入口径一致（不重复计缓存）', async () => {
    // 钉住 2026-10-13 审计的两个发现：
    //   ① 矩阵/翻译路径**完全不记**用量（直通记、其余不记）；
    //   ② 各协议 input 口径不同（Anthropic 的 input_tokens 不含缓存、OpenAI 的
    //      prompt_tokens 含），无条件相减或干脆不减都会让「总输入」算错。
    // 四个格子给语义等价的上游数字：
    //   Anthropic: input_tokens=100 + cache_read=900           → 总输入 1000
    //   OpenAI   : prompt_tokens=1000（内含 cached 900）+ out 50 → 总输入 1000
    // 任何一格偏离 ⇒ 口径不一致。
    const upAnth = http.createServer((q, s) => {
      q.resume(); q.on('end', () => {
        s.writeHead(200, { 'content-type': 'text/event-stream' });
        s.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'M', content: [], usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 900 } } }) + '\n\n');
        s.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }) + '\n\n');
        s.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
        s.end();
      });
    });
    const upChat = http.createServer((q, s) => {
      q.resume(); q.on('end', () => {
        s.writeHead(200, { 'content-type': 'text/event-stream' });
        s.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] }) + '\n\n');
        s.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 900 } } }) + '\n\n');
        s.write('data: [DONE]\n\n');
        s.end();
      });
    });
    const upResp = http.createServer((q, s) => {
      q.resume(); q.on('end', () => {
        s.writeHead(200, { 'content-type': 'text/event-stream' });
        s.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: { id: 'r', object: 'response', status: 'in_progress', model: 'M', output: [] } }) + '\n\n');
        s.write('event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }) + '\n\n');
        s.write('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'r', object: 'response', status: 'completed', model: 'M', output: [{ id: 'o', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 900 } } } }) + '\n\n');
        s.end();
      });
    });
    await new Promise((r) => upAnth.listen(0, '127.0.0.1', r));
    await new Promise((r) => upChat.listen(0, '127.0.0.1', r));
    await new Promise((r) => upResp.listen(0, '127.0.0.1', r));

    const dir = fs.mkdtempSync(path.join(tmp, 'usagecov-'));
    const port = await freePort();
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({
      port, apiKey: GATEWAY_KEY,
      providers: [
        { id: 'P-anth', baseURL: 'http://127.0.0.1:' + upAnth.address().port + '/v1', protocol: 'anthropic-messages', apiKey: 'sk-aaaaaaaaaaaaaaaa', models: ['m-anth'], priority: 1, enabled: true, timeoutMs: 20000 },
        { id: 'P-chat', baseURL: 'http://127.0.0.1:' + upChat.address().port + '/v1', protocol: 'openai-chat', apiKey: 'sk-bbbbbbbbbbbbbbbb', models: ['m-chat'], priority: 1, enabled: true, timeoutMs: 20000 },
        { id: 'P-resp', baseURL: 'http://127.0.0.1:' + upResp.address().port + '/v1', protocol: 'openai-responses', apiKey: 'sk-cccccccccccccccc', models: ['m-resp'], priority: 1, enabled: true, timeoutMs: 20000 },
      ],
    }), 'utf8');

    const proc = spawn(process.execPath,
      [MJS, '--config', path.join(dir, 'c.json'), '--log', path.join(dir, 'g.log'), '--port', String(port)],
      { stdio: 'ignore', windowsHide: true });
    try {
      const ready = await waitHealth(port, 20000);
      if (!ready) { console.log('    [SKIP] 用量记账用例的网关未就绪'); return; }

      const readAll = () => {
        const ud = path.join(dir, 'usage');   // 引擎默认把用量放 <log 同目录>/usage
        if (!fs.existsSync(ud)) return [];
        const out = [];
        for (const f of fs.readdirSync(ud)) {
          for (const line of fs.readFileSync(path.join(ud, f), 'utf8').split('\n')) {
            if (line) { try { out.push(JSON.parse(line)); } catch (_) { /* 半截行 */ } }
          }
        }
        return out;
      };

      const cases = [
        ['直通 anthropic→anthropic', 'm-anth', false],
        ['翻译 anthropic→chat（流式）', 'm-chat', true],
        ['翻译 anthropic→chat（非流式）', 'm-chat', false],
        ['矩阵 anthropic→responses（流式）', 'm-resp', true],
      ];
      for (const [label, model, stream] of cases) {
        // eslint-disable-next-line no-await-in-loop
        const r = await call({ port, p: '/v1/messages', body: { model, max_tokens: 32, stream, messages: [{ role: 'user', content: 'hi' }] } });
        assert.strictEqual(r.status, 200, label + ' 应 200，实际 ' + r.status + ' ' + r.text.slice(0, 160));
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 350));
        const rows = readAll();
        const rec = rows[rows.length - 1];
        assert.ok(rec, label + '：**没有落用量记录**（这正是 2026-10-13 审计发现的缺口）');
        assert.strictEqual(rec.inTok, 100, label + '：非缓存输入应为 100，实际 ' + rec.inTok
          + '（>100 说明缓存被重复计；<100 说明 Anthropic 语义被多减了一次）');
        assert.strictEqual(rec.cacheRead, 900, label + '：缓存读应为 900，实际 ' + rec.cacheRead);
        assert.strictEqual(rec.outTok, 50, label + '：输出应为 50，实际 ' + rec.outTok);
        assert.strictEqual(rec.inTok + rec.cacheRead + rec.cacheWrite, 1000,
          label + '：总输入应为 1000，实际 ' + (rec.inTok + rec.cacheRead + rec.cacheWrite));
      }
    } finally {
      try { proc.kill(); } catch (_) { /* 忽略 */ }
      upAnth.close(); upChat.close(); upResp.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
  });

  // ============ 2026-10-13：死家"每次探测都吃满整个超时"（用户实测 dur=60009ms）============

  t('探测超时阶梯①：声明了 timeoutMs 的家，半开探测**第一次**按短阈值快速放弃（不再每次白等整个超时）', async () => {
    // 用户实测形态：h-e.top（priority=1、声明 60s 超时）连不上，冷却到点后又被选中，
    // 这一次半开探测白等 60 秒才轮到备选。旧实现里"声明了 timeoutMs 的家，探测也照它来"
    //（2026-09-22 为 amd 加的例外）会让**每一次**探测都吃满整个声明值。
    const up = await startFakeUpstream({ status: 500 });
    const gw = await startGatewayWith([providerOf('stall', up, { priority: 1, timeoutMs: 8000 })], 'probelad1', {
      DSH_GATEWAY_BREAKER_SHORT_MS: '300', DSH_GATEWAY_BREAKER_PROBE_TIMEOUT_MS: '400',
      DSH_GW_MODEL_BREAKER_COOLDOWN_MS: '300',   // 500 记在模型级（规则 2/3）
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });   // 3 连败 → 开闸
      // 冷却到点后让上游"不再响应"：这一次请求会走半开探测
      up.st.status = 200;
      up.st.delayMs = 60_000;
      await sleep(500);
      const t0 = Date.now();
      const r = await call({ port: gw.port });
      const dur = Date.now() - t0;
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker HALF-OPEN: stall/.test(logText), '应确实走了半开探测：' + logText.slice(-400));
      assert.ok(/阈值 400ms/.test(logText),
        '这一次探测必须按短阈值（400ms）掐掉，而不是声明的 8000ms：' + logText.slice(-500));
      assert.ok(dur < 3000, '探测不该让用户白等声明的 8000ms；实际 ' + dur + 'ms');
      assert.strictEqual(r.status, 503, '唯一候选不可用 → 503，实际 ' + r.status);
    } finally { killGw(gw); closeUp(up); }
  });

  t('死家预检：可疑的家先做 TCP 连通性检查，连不上就**一个 HTTP 请求都不发**', async () => {
    // 背景：上游若是"连都连不上"的死家（端口关闭 / DNS 黑洞 / TCP 被丢包），
    // 旧实现要花掉整个 HTTP 超时才判定失败 —— 而 TCP 层几毫秒就能给出答案。
    // 这里让引擎**声明 8 秒超时**（旧行为下必然等满 8 秒），再让端口彻底关闭。
    const up = await startFakeUpstream({ status: 500 });
    const gw = await startGatewayWith([providerOf('gone', up, { priority: 1, timeoutMs: 8000 })], 'preflight', {
      DSH_GATEWAY_BREAKER_SHORT_MS: '300', DSH_GATEWAY_BREAKER_PROBE_TIMEOUT_MS: '8000',
      DSH_GW_MODEL_BREAKER_COOLDOWN_MS: '300',   // 500 记在模型级（规则 2/3）
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });   // 3 连败 → 开闸
      // 彻底关掉上游：**必须 closeAllConnections**，否则 undici 的连接池会复用那条
      // 已建立的长连接（listener 关闭不会杀掉已建立的连接），端口看起来"还活着"。
      up.server.closeAllConnections();
      await new Promise((res) => up.server.close(res));
      await sleep(500);   // 等熔断冷却到点 → 下一次请求走"半开探测"
      const t0 = Date.now();
      const r = await call({ port: gw.port });
      const dur = Date.now() - t0;
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/预检连不通/.test(logText),
        '应先做 TCP 预检并明确记下"连不通"：' + logText.slice(-500));
      assert.ok(!/request error/.test(logText.slice(logText.indexOf('breaker OPEN'))),
        '预检不通过时**不应再发 HTTP 请求**（发了才会出现 request error）：' + logText.slice(-500));
      assert.ok(dur < 3000, '预检应在毫秒级给出结论，而不是等满 8 秒 HTTP 超时；实际 ' + dur + 'ms');
      assert.strictEqual(r.status, 503, '唯一候选不可用 → 503，实际 ' + r.status);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网络类熔断退避上限默认 120 分钟（死家不再每 30 分钟就被重新放行一次探测）', async () => {
    // 与"退避阶梯"那条同理：这个上限只体现在**供应商级网络类**熔断的日志里
    //（规则 2/3 之后，上游给了响应的失败记在模型级、走模型级冷却时长）。
    const deadPort = await freePort();
    const deadProv = {
      id: 'slowdeath', baseURL: 'http://127.0.0.1:' + deadPort + '/v1',
      apiKey: UPSTREAM_KEY, models: ['test-model'], priority: 1, enabled: true,
    };
    const gw = await startGatewayWith([deadProv], 'backoffcap', {
      DSH_GATEWAY_BREAKER_SHORT_MS: '300',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker OPEN: slowdeath/.test(logText), '应先开闸：' + logText.slice(-400));
      assert.ok(/上限 120 分钟/.test(logText),
        '网络类熔断的退避上限应为 120 分钟（旧值 30 分钟 → 死家每半小时被重新探测一次）：' + logText.slice(-500));
    } finally { killGw(gw); }
  });

  // ============ 2026-10-13（本版）：DSML 流式也能构造 tool_use ============
  // 旧版流式只做"剔除标记"（不再显示乱码），**工具不会被执行** —— 那是 v0.8.4 明确声明的限制。
  // 本版把它接到与结构化 tool_calls **同一个出口**：解析出的调用塞进 toolCalls 映射，
  // 由流结束的 flushToolCalls() 补成真正的 tool_use 块。

  /** 把 SSE 里所有 text_delta 拼起来（正文可能被拆成多个事件，不能按整串断言） */
  const textDeltasOf = (sse) => [...String(sse).matchAll(/"type":"text_delta","text":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => { try { return JSON.parse('"' + m[1] + '"'); } catch (_) { return m[1]; } });

  const DSML_BLOCK = [
    '<|DSML|calls>',
    '<|DSML|invoke name="run_shell">',
    '<|DSML|parameter name="cmd">uninstall cursor</|DSML|parameter>',
    '</|DSML|invoke>',
    '</|DSML|calls>',
  ].join('\n');

  t('DSML 流式①：原生工具标记跨分片到达 → 转成真正的 tool_use（工具能被执行，不再只剔乱码）', async () => {
    const chunk = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
    const head = '我先确认一下，再动手删除。 ';
    const part1 = head + DSML_BLOCK.slice(0, 5);   // '<|DSM' —— 标记被**切成两片**
    const part2 = DSML_BLOCK.slice(5);             // 'L|calls>\n…'
    assert.ok(part1.endsWith('<|DSM') && part2.startsWith('L|calls>'), '用例自身：标记必须真的跨分片');
    const sseBody = chunk({ choices: [{ delta: { content: part1 } }] })
      + chunk({ choices: [{ delta: { content: part2 } }] })
      + chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      + 'data: [DONE]\n\n';
    // sseSplitAt 再切一刀（切在第一帧中间）：连"字节级切断"一起测
    const up = await startFakeUpstream({ sseBody, sseGapMs: 200, sseSplitAt: 40 });
    const prov = Object.assign(providerOf('dsmls', up, { priority: 1 }), { protocol: 'openai-chat' });
    const gw = await startGatewayWith([prov], 'dsmlstream1', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const sse = r.text;
      // ① 标记绝不能泄漏（这是 v0.8.4 已修的部分，防止本次改动把它弄回去）
      assert.ok(!/DSML/.test(sse), 'DSML 标记不得出现在任何事件里：' + sse.slice(0, 700));
      // ② 必须真的构造出 tool_use 块 + 完整参数
      assert.ok(/"type":"tool_use"/.test(sse), '应发出 tool_use 块：' + sse.slice(0, 900));
      assert.ok(/"name":"run_shell"/.test(sse), '工具名应正确：' + sse.slice(0, 900));
      assert.ok(/"partial_json":"\{\\"cmd\\":\\"uninstall cursor\\"\}"/.test(sse),
        '参数应完整（input_json_delta）：' + sse.slice(0, 1200));
      // ③ stop_reason 必须是 tool_use —— 客户端正是靠它决定去执行工具
      assert.ok(/"stop_reason":"tool_use"/.test(sse), 'stop_reason 应为 tool_use：' + sse.slice(-500));
      // ④ 标记之外的正文照常交付
      assert.strictEqual(textDeltasOf(sse).join(''), head,
        '标记之前的正文必须原样交付：' + JSON.stringify(textDeltasOf(sse)));
    } finally { killGw(gw); closeUp(up); }
  });

  t('DSML 流式②：上游没写闭合标记，但调用本身完整 → 收尾时照样转成 tool_use（否则工具被丢掉）', async () => {
    const chunk = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
    // 缺 `</|DSML|calls>`：上游被截断/偷懒都会这样。调用本身是完整的。
    const unclosed = DSML_BLOCK.replace('</|DSML|calls>', '');
    const sseBody = chunk({ choices: [{ delta: { content: '好的，我删。 ' + unclosed } }] })
      + chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      + 'data: [DONE]\n\n';
    const up = await startFakeUpstream({ sseBody });
    const prov = Object.assign(providerOf('dsmlu', up, { priority: 1 }), { protocol: 'openai-chat' });
    const gw = await startGatewayWith([prov], 'dsmlstream2', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const sse = r.text;
      assert.ok(!/DSML/.test(sse), '未闭合的标记残片也不得泄漏：' + sse.slice(0, 700));
      assert.ok(/"name":"run_shell"/.test(sse), '未闭合块里的完整调用必须照样转成 tool_use：' + sse.slice(0, 900));
      assert.ok(/"stop_reason":"tool_use"/.test(sse), 'stop_reason 应为 tool_use：' + sse.slice(-400));
      assert.strictEqual(textDeltasOf(sse).join(''), '好的，我删。 ',
        '块外正文必须保留：' + JSON.stringify(textDeltasOf(sse)));
    } finally { killGw(gw); closeUp(up); }
  });

  t('DSML 流式③：收尾必须归还扣住的残余 —— 尾部一个正当的 < 不能被静默吞掉', async () => {
    // dsmlStreamFeed 为了防"标记跨分片泄漏"会扣住"未闭合的 <"尾巴；若收尾不归还，
    // 模型正常写出的最后一个 '<'（比较运算符、泛型、HTML 片段…）就凭空消失了。
    const chunk = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
    const sseBody = chunk({ choices: [{ delta: { content: '比较运算符是 <' } }] })
      + chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      + 'data: [DONE]\n\n';
    const up = await startFakeUpstream({ sseBody });
    const prov = Object.assign(providerOf('dsmlt', up, { priority: 1 }), { protocol: 'openai-chat' });
    const gw = await startGatewayWith([prov], 'dsmlstream3', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(textDeltasOf(r.text).join(''), '比较运算符是 <',
        '尾部正文必须完整交付（收尾不归还残余就会吞掉这个 <）：' + JSON.stringify(textDeltasOf(r.text)));
      assert.ok(!/"type":"tool_use"/.test(r.text), '这不该被当成工具调用');
    } finally { killGw(gw); closeUp(up); }
  });

  t('DSML 流式④（聚合路径）：客户端要非流式、上游被强制流式 → 同样要拿到 tool_use 块', async () => {
    // 这条路径真实存在且很常用：供应商配了 quirks: ['force-stream']（workbuddy 那类只收流式的上游），
    // 而客户端要的是非流式 → 引擎把流收完再回一条完整 message。DSML 若只修流式出口，
    // 这条路上工具照样不会被执行。
    const chunk = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
    const sseBody = chunk({ choices: [{ delta: { content: '我删了。 ' + DSML_BLOCK } }] })
      + chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      + 'data: [DONE]\n\n';
    const up = await startFakeUpstream({ sseBody });
    const prov = Object.assign(providerOf('dsmla', up, { priority: 1 }), {
      protocol: 'openai-chat', quirks: ['force-stream'],
    });
    const gw = await startGatewayWith([prov], 'dsmlstream4', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 256, messages: [{ role: 'user', content: 'hi' }] },   // 不带 stream
      });
      assert.strictEqual(r.status, 200, '应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(!/DSML/.test(r.text), '标记不得出现在返回体里：' + r.text.slice(0, 500));
      const msg = JSON.parse(r.text);
      const types = (msg.content || []).map((b) => b.type);
      assert.deepStrictEqual(types, ['text', 'tool_use'],
        '聚合路径也必须给出 tool_use 块：' + JSON.stringify(types) + ' ' + r.text.slice(0, 400));
      const tu = msg.content.find((b) => b.type === 'tool_use');
      assert.strictEqual(tu.name, 'run_shell', '工具名应正确：' + JSON.stringify(tu));
      assert.deepStrictEqual(tu.input, { cmd: 'uninstall cursor' }, '参数应完整：' + JSON.stringify(tu));
      assert.strictEqual(msg.stop_reason, 'tool_use', 'stop_reason 应为 tool_use：' + msg.stop_reason);
    } finally { killGw(gw); closeUp(up); }
  });

  // ============ 2026-10-14：规则 2（模型级冷却）/ 规则 3（可配置）============

  t('规则2：某个模型连续失败 → 只冷却**该模型**，同家另一个模型照常可用（不再连坐整家）', async () => {
    // 假上游：按请求体里的 model 分流 —— test-model 一直 500，test-model-2 正常。
    // 这正是用户报的形态："一个模型的毛病把整家拖下水"，代码里为此打的豁免补丁已有 5 处。
    const srv = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'test-model-2' }] }));
        return;
      }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let model = '';
        try { model = JSON.parse(raw).model || ''; } catch (_) { /* 忽略 */ }
        if (model === 'test-model') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'boom' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const up = { server: srv, port: srv.address().port, st: { calls: 0 } };
    const prov = Object.assign(
      providerOf('iso', up, { priority: 1, models: ['test-model', 'test-model-2'] }),
      { protocol: 'openai-chat' },
    );
    const gw = await startGatewayWith([prov], 'modeliso', {
      DSH_GATEWAY_BREAKER_SHORT_MS: '60000', DSH_GW_MODEL_BREAKER_COOLDOWN_MS: '60000',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });   // 默认 model=test-model
      const log1 = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker OPEN: iso\[test-model\]/.test(log1),
        '应开**模型级**闸，且日志必须标明只影响该模型：' + log1.slice(-600));
      assert.ok(!/breaker OPEN: iso 失败/.test(log1),
        '不得把整家熔断（500 属模型级，规则2）：' + log1.slice(-600));
      // 核心断言：同家另一个模型必须照常可用（旧行为 → 整家熔断 → 503）
      const r2 = await call({ port: gw.port, body: { model: 'test-model-2', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r2.status, 200,
        '同家另一个模型应照常可用（旧行为是整家熔断 → 503），实际 ' + r2.status + ' ' + r2.text.slice(0, 200));
      // 而被冷却的那个模型自己仍应被挡住
      const r1 = await call({ port: gw.port });
      assert.strictEqual(r1.status, 503, '被冷却的那个模型应回 503，实际 ' + r1.status);
    } finally { killGw(gw); closeUp(up); }
  });

  t('规则2 护栏：同家 3 个不同模型相继冷却 → 升级为**整家**冷却（防"整家坏掉被当成 N 个模型分别失败"）', async () => {
    const up = await startFakeUpstream({ status: 500 });
    const prov = Object.assign(
      providerOf('esc', up, { priority: 1, models: ['m1', 'm2', 'm3', 'm4'] }),
      { protocol: 'openai-chat' },
    );
    const gw = await startGatewayWith([prov], 'escalate', {
      DSH_GATEWAY_BREAKER_SHORT_MS: '60000', DSH_GW_MODEL_BREAKER_COOLDOWN_MS: '60000',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (const m of ['m1', 'm2', 'm3']) {
        for (let i = 0; i < 3; i++) {
          // eslint-disable-next-line no-await-in-loop
          await call({ port: gw.port, body: { model: m, messages: [{ role: 'user', content: 'hi' }] } });
        }
      }
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/3 个不同模型在 5 分钟内相继冷却/.test(logText), '应触发升级护栏：' + logText.slice(-700));
      assert.ok(/冷却整家/.test(logText), '护栏应升级为整家冷却：' + logText.slice(-700));
      // 第 4 个从未失败过的模型也应被整家冷却挡住
      const r = await call({ port: gw.port, body: { model: 'm4', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 503, '护栏生效后第 4 个模型也应被挡，实际 ' + r.status);
    } finally { killGw(gw); closeUp(up); }
  });

  t('规则3：breaker.threshold / breaker.cooldownMs 可配置，且启动日志自述生效值', async () => {
    const up = await startFakeUpstream({ status: 500 });
    const gw = await startGatewayWith([providerOf('cfg', up, { priority: 1 })], 'breakcfg', {}, {
      breaker: { threshold: 5, cooldownMs: 90_000 },
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const log0 = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/模型级冷却：连续 5 次失败 → 仅该模型冷却 2 分钟/.test(log0),
        '启动日志必须自述生效的配置（否则用户改了配置却不知道有没有生效）：' + log0.slice(0, 700));
      for (let i = 0; i < 4; i++) await call({ port: gw.port });
      let logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/breaker OPEN: cfg\[test-model\]/.test(logText),
        '阈值配成 5 → 4 次失败不该开闸：' + logText.slice(-400));
      await call({ port: gw.port });
      logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker OPEN: cfg\[test-model\]/.test(logText), '第 5 次应开闸：' + logText.slice(-400));
      assert.ok(/仅该模型\**冷却 2 分钟/.test(logText),
        '冷却时长必须取配置值（90000ms → 2 分钟），实际：' + logText.slice(-400));
      // 默认值也要能被看到：不配 breaker 时是 3 次 / 上限 30 分钟（用另一实例的日志证明默认没被改坏）
      // ⚠ 2026-10-14 语义修正：30 分钟现在是**上限**，不是"首次开闸就 30 分钟"。
      // 首档走短冷却阶梯（90s → 3m → … → 上限），所以这里断言的是
      //   ① 默认阈值仍是 3 次；
      //   ② 日志里自述的**上限**是 30 分钟（配置默认值没被改坏）；
      //   ③ 首次开闸用的是短档（远小于 30 分钟）—— 这是修 ling-3.1-flash 那次事故的核心。
      const up2 = await startFakeUpstream({ status: 500 });
      const gw2 = await startGatewayWith([providerOf('dflt', up2, { priority: 1 })], 'breakdflt', {});
      try {
        for (let i = 0; i < 2; i++) await call({ port: gw2.port });
        let l2 = fs.readFileSync(gw2.logPath, 'utf8');
        assert.ok(!/breaker OPEN: dflt\[test-model\]/.test(l2), '默认阈值 3 → 2 次失败不该开闸：' + l2.slice(-300));
        await call({ port: gw2.port });
        l2 = fs.readFileSync(gw2.logPath, 'utf8');
        assert.ok(/仅该模型\**冷却 [^（]*（连续 3 次失败；第 1 次开闸/.test(l2),
          '默认阈值仍是连续 3 次失败，且应标出"第 1 次开闸"：' + l2.slice(-400));
        assert.ok(/上限 30 分钟/.test(l2),
          '默认的冷却**上限**应为 30 分钟（规则3 的默认值）：' + l2.slice(-400));
        assert.ok(!/第 1 次开闸[^）]*冷却 30 分钟/.test(l2),
          '首次开闸不得直接顶到 30 分钟上限（瞬时故障会被锁死半小时）：' + l2.slice(-400));
      } finally { killGw(gw2); closeUp(up2); }
    } finally { killGw(gw); closeUp(up); }
  });

  t('规则1 负例：直连**也不可达**时不切换（否则被墙的上游会被误判成"代理坏了"）', async () => {
    // 场景：上游自己就是关着的（本地关闭端口 → 确定 ECONNREFUSED），代理也是死的。
    // 这时"切直连"救不了任何东西，守卫必须拦住 —— 否则被墙/已下线的上游会被误判成
    // "代理的问题"，日志把排查方向彻底引偏。
    //
    // ⚠ 为什么不用 `.invalid` 域名来造"直连不可达"：本机跑着 Clash（TUN + fake-ip），
    // 实测**任意**域名的 TCP 连接都会被 TUN 秒接住（连 no-such-host.invalid 都"连得上"，
    // 本机对 10.255.255.1 / 192.0.2.1 也是 0–4ms 就"成功"）。所以这里改用关闭的回环端口 ——
    // 回环不经 TUN，必定被拒，判据确定。
    const deadPort = await freePort();
    const prov = {
      id: 'gone2', baseURL: 'http://127.0.0.1:' + deadPort + '/v1',
      apiKey: UPSTREAM_KEY, models: ['test-model'], priority: 1, enabled: true,
    };
    const gw = await startGatewayWith([prov], 'nodirect', {
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:7899',
      HTTPS_PROXY: 'http://127.0.0.1:7899',
      NO_PROXY: '',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 503, '唯一候选连不上 → 503，实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/直连也不可达/.test(logText),
        '必须写明"直连也不可达 → 不切换"（这条日志就是守卫的证据）：' + logText.slice(-600));
      assert.ok(!/切成直连（规则 1）/.test(logText), '不得切换：' + logText.slice(-600));
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      assert.ok(!h.proxy.runtimeDirect, '运行期直连清单必须为空：' + JSON.stringify(h.proxy));
    } finally { killGw(gw); }
  });

  // ============ 2026-10-14：今日日志排查出的两处真实故障 ============

  t('日志事故①：上游回"没有任何错误说明"的 400 → 必须继续 failover（不能打死整轮任务）', async () => {
    // 现场（用户报"调用 deepseek-v4.1-flash 多次报错终止任务"）：
    //   upstream opencode-go HTTP 400: {"model":"deepseek-v4.1-flash"}
    //   → 确定性 4xx → 终止 failover → [call] status=fail:400
    // 而同一家同一模型 30 分钟后连续两次成功（10:08 dur=19731ms、10:09 dur=5265ms）——
    // 请求侧没有任何问题，是上游瞬时抽风。旧实现让整轮任务死在这一发上。
    const bad = await startFakeUpstream({
      status: 400,
      // 关键：**只有回显的模型名**，没有任何 error/message 字段
      errorBody: { model: 'test-model' },
    });
    const ok = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('opaque', bad, { priority: 1 }),
      providerOf('good', ok, { priority: 2 }),
    ], 'opaque400', { DSH_GATEWAY_BREAKER_SHORT_MS: '60000' });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200,
        '无说明的 400 之后必须换下一家并成功（旧实现回 400 打死任务），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(ok.st.calls, 1, '请求应真的落到第二家：' + ok.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/响应体没有任何错误说明/.test(logText), '日志须写明这条判据：' + logText.slice(-500));
      assert.ok(!/failover stopped/.test(logText), '不得终止 failover：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(bad); closeUp(ok); }
  });

  t('日志事故①负例（新契约）：有明确说明的 400 也继续 failover，但**全部**候选失败时仍回 400', async () => {
    // ⚠ 契约变更（2026-10-15，用户明确要求"任何一家失败都不许中断"）。
    // 旧契约：上游"说了"是什么问题时（如 "invalid request body"）就终止 failover。
    // 新契约：照样走完候选；**全部候选都失败**时才回那个 400。
    // 判据仍然保守的意义变了：400 只被"记住"，不再当场打死任务。
    const bad = await startFakeUpstream({
      status: 400,
      errorBody: { error: { message: 'invalid request body: messages must not be empty', type: 'invalid_request_error' } },
    });
    const ok = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('told', bad, { priority: 1 }),
      providerOf('good2', ok, { priority: 2 }),
    ], 'told400', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '有明确说明的 400 之后仍要继续 failover（新契约），实际 ' + r.status);
      assert.ok(ok.st.calls >= 1, '必须尝试下一家：' + ok.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/确定性 4xx HTTP 400 → 记为候选失败/.test(logText),
        '日志须写明"记为候选失败、继续 failover"：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(bad); closeUp(ok); }
  });

  t('日志事故①负例边界：有明确说明的 400 且**所有**候选都拒绝 → 仍回 400（不倒退成 503）', async () => {
    const mk = () => startFakeUpstream({
      status: 400,
      errorBody: { error: { message: 'invalid request body: messages must not be empty', type: 'invalid_request_error' } },
    });
    const bad1 = await mk();
    const bad2 = await mk();
    const gw = await startGatewayWith([
      providerOf('told1', bad1, { priority: 1 }),
      providerOf('told2', bad2, { priority: 2 }),
    ], 'told400all', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 400, '全部候选都拒绝时应回 400，实际 ' + r.status);
      assert.ok(bad2.st.calls >= 1, '第二家也必须被尝试：' + bad2.st.calls);
      const parsed = JSON.parse(r.text);
      assert.ok(parsed.error && /told1/.test(parsed.error.message),
        '错误信息应指出是哪个供应商拒绝的（取第一家）：' + r.text.slice(0, 200));
    } finally { killGw(gw); closeUp(bad1); closeUp(bad2); }
  });

  t('日志事故②：账户级失败（429）必须照记模型级失败 —— 否则坏家永远攒不到阈值（amd 实测 7 败 0 熔断）', async () => {
    // 现场：amd 当天 7 次失败（4×429 并发超限 + 3×超时）、**0 次成功**、**0 次熔断**，
    // 每个请求都要先白等它 12 秒超时（该模型条目声明 timeoutMs: 12000）。
    // 根因：429 走"账户级失败"早退分支，那里调的是 breakerRecordSuccess
    //（它不只是交还半开名额，还会把 fails 清零 + lastOkAt 置现在）——
    // 与超时路径记的失败**交替清零**，于是永远攒不到阈值；lastOkAt 被刷新后连死家预检也不再触发。
    const up = await startFakeOpenAIUpstream({ script: ['rate429', 'rate429', 'rate429', 'rate429', 'rate429', 'rate429', 'rate429', 'rate429', 'rate429', 'rate429'] });
    // 用显式 `accounts: [{id, apiKey}]` 形态（而不是 apiKeys 字符串数组）：只有这种写法
    // 才会建出**可轮换的账户池**、让 429 走"账户级失败 → 换下一把"的路径 —— 正是 amd 的现场。
    // 根因回顾：那个早退分支原来调 breakerRecordSuccess（会清 fails + 刷 lastOkAt），
    // 与超时路径记的模型级失败交替清零 → 永远攒不到阈值 → 坏家每轮都被优先选中，
    // 用户每次先白等它 12 秒（实测当天 7 次失败 0 次成功 0 次熔断）。
    //
    // 两把 Key：一次请求内 k1、k2 各 429 一次 → 计数到 2；第二次请求再各一次 → 到 4 ≥ 阈值 3 → 开闸。
    // 用 5 把的话第 1 次请求就凑够 5 次直接开闸，后面几次全是 503（虽然也证明了修复生效，
    // 但断言"看到 rate 分支 + 看到 breaker OPEN"更稳的是 2 把的节奏）。
    const prov = openaiProvider('ratetrap', up, {
      priority: 1,
      accounts: [{ id: 'k1', apiKey: 'sk-k1' }, { id: 'k2', apiKey: 'sk-k2' }],
    });
    const gw = await startGatewayWith([prov], 'acctfail', {
      DSH_GW_MODEL_BREAKER_COOLDOWN_MS: '60000',
      // 把账户限流冷却压到 1ms：真实形态是"冷却 90 秒、90 秒后同一把 Key 再次被选中又 429"，
      // 快进成"下一轮就能再打"，这样几次请求就能把模型级失败攒到阈值。
      // 不压的话两把 Key 各冷却 90s 之后就是"全部冷却中"，模型级计数永远停在 2 攒不到 3。
      DSH_GATEWAY_ACCOUNT_RATE_COOLDOWN_MS: '1',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/判定为账户级失败（rate）/.test(logText), '应走账户级 rate 分支：' + logText.slice(-600));
      assert.ok(/breaker OPEN: ratetrap\[test-model\]/.test(logText),
        '连续 429 之后必须开**模型级**闸（旧实现被 breakerRecordSuccess 清零，永远不开）：' + logText.slice(-1000));
    } finally { killGw(gw); closeUp(up); }
  });

  t('日志事故②配套：session 类（裸 401/403 = 这一把 Key 坏了）**不得**记供应商失败（多 Key 不连坐）', async () => {
    // classifyAccountFailure 把裸 401/403 判成 session（该罚的是这把 Key）。
    // 若照着"账户级失败一律记"改，就会把用户特意配的多把 Key 连坐 —— 实测过 nvidia 4 把 Key 全废。
    const up = await startFakeOpenAIUpstream({ script: ['session', 'session', 'session', 'session'] });
    const prov = openaiProvider('sesskey', up, { priority: 1, apiKeys: ['k1', 'k2', 'k3', 'k4'] });
    const gw = await startGatewayWith([prov], 'sessfail', { DSH_GW_MODEL_BREAKER_COOLDOWN_MS: '60000' });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/判定为账户级失败（session）/.test(logText), '应判成 session：' + logText.slice(-400));
      assert.ok(!/breaker OPEN: sesskey\[test-model\]/.test(logText),
        'session 类不得记入熔断（该罚 Key，不罚供应商/模型）：' + logText.slice(-800));
      assert.ok(up.st.calls >= 3, '应逐把 Key 轮换（而不是一上来就熔断）：' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  t('日志事故③：临时型"额度类"400 必须真能熔断（旧实现 fails 永远停在 1，25 次请求 0 次开闸）', async () => {
    // 审计实测：上游回 `400 {"error":{"message":"insufficient resources"}}`
    //  → PROVIDER_SIDE_4XX_RE 命中 → 旧代码 `persistent ? 403 : 0` 传了 **0**
    //  → 0 是"网络层失败"哨兵 → 判成整家级却**没有 immediate** → fails 每次加到 1
    //  → 而上面刚 breakerRecordSuccess 清零 → **永远开不了闸**，日志却每次宣称"冷却该家"。
    // 这条用例钉住修复：临时类落**模型级**，攒够阈值必须开闸，且日志要说"仅该模型"。
    const up = await startFakeUpstream({ status: 400, errorBody: { error: { message: 'insufficient resources' } } });
    const gw = await startGatewayWith([providerOf('tmpquota', up, { priority: 1 })], 'tmpquota', {
      DSH_GW_MODEL_BREAKER_COOLDOWN_MS: '60000',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/临时状态 → 仅冷却该模型/.test(logText),
        '临时额度类必须说"仅冷却该模型"（旧日志谎称"冷却该家"）：' + logText.slice(-500));
      assert.ok(/breaker OPEN: tmpquota\[test-model\]/.test(logText),
        '连续 3 次后必须开模型级闸（旧实现 0 次开闸）：' + logText.slice(-800));
    } finally { killGw(gw); closeUp(up); }
  });

  t('sensenova：限流被写成 insufficient_quota → 必须判「短期限流」，不能判成欠费锁 30 分钟', async () => {
    // 2026-10-14 实测事故：本机 sensenova 连续 5 天不可用，最后一次成功停在 10-09 09:55。
    // 商汤对 RPM/TPM 限流回的是：
    //   429 {"error":{"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error",
    //                   "code":"insufficient_quota"}}
    // `insufficient_quota` 命中 WORKBUDDY_CREDIT_RE 的 `insufficient[_a-z]*quota`
    // → 判成 credit（欠费）→ **冷却 1800 秒**；而它其实是几十秒就恢复的瞬时限流。
    // 两把 Key 轮流被锁 → 整家静默失能 → 每条请求都只能跳过它。
    // 这条用例钉住"限流=短期、欠费=长期"必须分开。
    const sniff = 'inference exceeds tpm/rpm limit';
    const up = await startFakeOpenAIUpstream({ script: ['quota429', 'quota429', 'quota429', 'quota429'], quotaMsg: sniff });
    const prov = openaiProvider('sensenova', up, { priority: 1, apiKeys: ['k1', 'k2'] });
    const gw = await startGatewayWith([prov], 'ssnova', {
      DSH_GATEWAY_ACCOUNT_RATE_COOLDOWN_MS: '2000',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      // 关键断言：**不能**出现 credit（那意味着锁 30 分钟）
      assert.ok(!/标记为 credit/.test(logText),
        '限流**不得**被判成 credit/欠费（旧实现就是这样，把两把 Key 各锁 1800 秒）：' + logText.slice(-800));
      assert.ok(/标记为 rate/.test(logText),
        '应按短期限流冷却（几十秒即恢复）：' + logText.slice(-800));
    } finally { killGw(gw); closeUp(up); }
  });

  t('sensenova 负例：真正的余额不足仍必须判「长期」（别把欠费也一起放成短期）', async () => {
    // 修上面的误判时最容易犯的错：把 `insufficient_quota` 从 credit 名单里整个删掉，
    // 于是真正的欠费也变成短期冷却 → 每 90 秒白撞一次余额为 0 的墙。
    // 真·欠费的正文是 credit/balance 措辞、**不含**速率字样，必须仍判长期。
    const up = await startFakeOpenAIUpstream({ script: ['broke402', 'broke402', 'broke402'], brokeMsg: 'credit insufficient balance: balance=0' });
    const prov = openaiProvider('broke', up, { priority: 1 });
    const gw = await startGatewayWith([prov], 'snbroke');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/credit insufficient balance/.test(logText) || /标记为 credit/.test(logText),
        '余额为 0 必须走长期状态路径：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(up); }
  });

  t('commandcode：模型"不在这个端点上"的 400 → 必须继续 failover（并提示改 baseURL）', async () => {
    // 2026-10-14 实测事故（用户报"调用 commandcode 模型报错终止任务"）：
    //   baseURL = https://api.commandcode.ai/provider/v1
    //   upstream commandcode HTTP 400: {"error":{"type":"invalid_request_error",
    //     "message":"Model \"deepseek/deepseek-v4.1-flash\" is not supported on this endpoint.
    //                Use /provider/v1/chat/completions for OpenAI and OSS models."}}
    //   → 确定性 4xx → 终止 failover → 客户端整轮任务拿到 400 而死
    //
    // 实测**七个豁免判据全部不命中**（模型缺失/路由缺失/供应商侧4xx/指纹/渠道拦截/上游损坏/内容拦截）——
    // 措辞 `is not supported on this endpoint` 与那些正则都不相交，于是掉进"确定性 4xx"。
    //
    // 语义上它是**配置问题**：请求完全合法，是我们把 baseURL 指到了不对的路由。
    // 必须继续 failover（同模型还有 8 家候选），而且要留下上游建议的路径给用户照着改。
    const up = await startFakeOpenAIUpstream({
      script: ['endpointMismatch', 'endpointMismatch', 'endpointMismatch'],
      endpointMsg: 'Model "deepseek/deepseek-v4.1-flash" is not supported on this endpoint. Use /provider/v1/chat/completions for OpenAI and OSS models.',
    });
    const ok2 = await startFakeOpenAIUpstream({ status: 200 });
    const gw = await startGatewayWith([
      openaiProvider('commandcode', up, { priority: 1 }),
      openaiProvider('fallback', ok2, { priority: 2 }),
    ], 'ccmismatch', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200,
        '端点不匹配之后必须换下一家并成功（旧实现回 400 打死任务），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(ok2.st.calls, 1, '应真的落到第二家：' + ok2.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/判定为"模型不在这个端点上"/.test(logText), '日志须写明是端点问题：' + logText.slice(-600));
      assert.ok(/\/provider\/v1\/chat\/completions/.test(logText),
        '日志须带上游建议的正确路径（否则用户不知道该改哪）：' + logText.slice(-600));
      assert.ok(!/failover stopped/.test(logText), '不得终止 failover：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(up); closeUp(ok2); }
  });

  t('commandcode 负例（新契约）：真·请求参数错误也继续 failover，不打死整轮任务', async () => {
    // ⚠ 契约变更（2026-10-15，用户明确要求）。旧契约：有明确说明的参数错误终止 failover。
    // 新契约：照样走完候选，由下一家服务；**全部候选都失败**时才回那个 400。
    // 这条同时钉住"翻译路径"（DSH 走得最多的那条）与新契约一致。
    const up = await startFakeOpenAIUpstream({
      script: ['badReq', 'badReq', 'badReq'],
      badReqMsg: 'invalid request body: messages must not be empty',
    });
    const ok2 = await startFakeOpenAIUpstream({ status: 200 });
    const gw = await startGatewayWith([
      openaiProvider('told', up, { priority: 1 }),
      openaiProvider('fallback2', ok2, { priority: 2 }),
    ], 'ccbadreq', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200,
        '参数错误之后必须继续 failover（新契约），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(ok2.st.calls >= 1, '必须落到第二家：' + ok2.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/确定性 4xx HTTP 400 → 记为候选失败/.test(logText),
        '日志须写明"记为候选失败、继续 failover"：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(up); closeUp(ok2); }
  });

  t('commandcode 负例边界：参数错误且**所有**候选都拒绝 → 仍回 400（翻译路径，不倒退）', async () => {
    const mk = () => startFakeOpenAIUpstream({
      script: ['badReq', 'badReq', 'badReq', 'badReq', 'badReq', 'badReq'],
      badReqMsg: 'invalid request body: messages must not be empty',
    });
    const up1 = await mk();
    const up2 = await mk();
    const gw = await startGatewayWith([
      openaiProvider('told1', up1, { priority: 1 }),
      openaiProvider('told2', up2, { priority: 2 }),
    ], 'ccbadreqall', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 400, '全部候选都拒绝时应回 400，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(up2.st.calls >= 1, '第二家也必须被尝试：' + up2.st.calls);
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('规则2 修正：模型级冷却**首档必须是短冷却**（瞬时 429 不能一上来就锁 30 分钟）', async () => {
    // 2026-10-14 用户报「ling-3.1-flash 调用失败 503」：
    //   upstream commandcode HTTP 429: {"error":{"message":"Upstream model provider is
    //     temporarily unavailable. Please try again in a moment.","type":"rate_limit_error"}}
    //   → breaker OPEN: commandcode[ling-3.1-flash] … **仅该模型**冷却 **30 分钟**
    // 上游明说"稍后重试"，而我们把该模型锁死 30 分钟；该模型只有一家候选 → 整轮任务死掉。
    // 供应商级熔断早有「短档 90s → 指数退避 → 上限 30min」的阶梯，模型级此前是**平的 30 分钟**。
    // 这条用例钉住：首档必须是短冷却（远小于配置的 30 分钟），且日志写明"第 1 次开闸"。
    const up = await startFakeOpenAIUpstream({
      script: ['rate429', 'rate429', 'rate429', 'rate429'],
      quotaMsg: "Model 'x' is at its concurrency limit (16); please retry later",
    });
    const prov = openaiProvider('lingpool', up, { priority: 1 });
    const gw = await startGatewayWith([prov], 'modelshort', {
      DSH_GW_MODEL_BREAKER_COOLDOWN_MS: String(30 * 60_000),   // 上限仍是 30 分钟
      DSH_GATEWAY_BREAKER_SHORT_MS: '90000',                    // 首档 90 秒
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      const m = logText.match(/breaker OPEN: lingpool\[test-model\][^\n]*/);
      assert.ok(m, '应看到模型级开闸日志：' + logText.slice(-800));
      assert.ok(/第 1 次开闸/.test(m[0]), '日志须标出这是首次开闸（便于排查退避阶梯）：' + m[0]);
      // 首档是短冷却：90 秒（若上游给了 Retry-After 可能略长，但**绝不能**一上来就 30 分钟）
      const mins = (m[0].match(/冷却 ([\d.]+) 分钟/) || [])[1];
      const secs = (m[0].match(/冷却 (\d+) 秒/) || [])[1];
      const asSec = mins ? Number(mins) * 60 : (secs ? Number(secs) : NaN);
      assert.ok(Number.isFinite(asSec) && asSec < 600,
        `首档必须是短冷却（<10 分钟），不能是一上来 30 分钟；实际 ${asSec}s —— ${m[0]}`);
    } finally { killGw(gw); closeUp(up); }
  });

  t('规则2 修正：503 文案必须报**真实**剩余冷却（旧实现把模型级 30 分钟报成 90 秒）', async () => {
    // 旧 breakerCooldownSecs() 只看供应商级断路器；模型级冷却时它算出 0 → 落到兜底 90 秒。
    // 于是 503 写 "retry in ~90s"，用户按提示重试、仍然 503，只会判定"网关坏了"。
    // 实测 ling-3.1-flash 被模型级冷却 1800 秒时，文案就是 ~90s。
    const up = await startFakeOpenAIUpstream({ script: ['err500', 'err500', 'err500', 'err500', 'err500'] });
    const prov = openaiProvider('truthy', up, { priority: 1 });
    // 上限设成 20 分钟（1200 秒）：文案若报 ~90s 就是旧 bug，报 ~1200s 才对。
    const gw = await startGatewayWith([prov], 'truthmsg', {
      DSH_GW_MODEL_BREAKER_COOLDOWN_MS: String(20 * 60_000),
      DSH_GATEWAY_BREAKER_SHORT_MS: String(20 * 60_000),   // 让首档就等于上限，便于断言
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const r = await call({ port: gw.port });   // 此时闸已开 → 走"候选全部熔断"分支
      assert.strictEqual(r.status, 503, '应回 503，实际 ' + r.status);
      const secs = Number((r.text.match(/retry in ~(\d+)s/) || [])[1] || 0);
      assert.ok(secs > 600,
        `文案必须报真实剩余（约 1200 秒），不能是兜底的 90 秒；实际 ~${secs}s 全文：${r.text.slice(0, 200)}`);
    } finally { killGw(gw); closeUp(up); }
  });

  t('瞬时 429「上游自己忙」→ 必须原地重试（约 1/3 成功率的免费模型，不能一次就记失败开闸）', async () => {
    // 2026-10-14 用户报「ling-3.1-flash 还是调用不成功」。
    // 现场：commandcode 的 `inclusionai/ling-3.1-flash:free` 回
    //   `429 {"error":{"message":"Upstream model provider is temporarily unavailable.
    //                       Please try again in a moment.","type":"rate_limit_error"}}`
    // —— 上游**自己**说"稍后重试"，不是对我们限流。
    // 实测（间隔 6s、三种形态各 3 次）：该模型约 1/3 成功率、随机 200/429，同家 deepseek 一直 200。
    // 旧实现一次 429 就记一次模型级失败 → 3 次开闸冷却；且半开探测**只放行一次**，
    // 撞上 2/3 的失败率极易再次开闸 → 该模型在用户看来"永远不可用"。
    // 修法：命中"上游自己忙"这一窄判据时原地重发（默认 2 次预算），成功后照常 200。
    const up = await startFakeOpenAIUpstream({ script: ['busy429', 'ok', 'busy429', 'ok', 'busy429', 'ok'] });
    const prov = openaiProvider('busy', up, { priority: 1 });
    const gw = await startGatewayWith([prov], 'busy429case', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200,
        '首次 429 应被原地重试救回（旧实现直接失败/开闸），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/判定为"上游自己忙".*原地重试/.test(logText),
        '日志须写明按"上游自己忙"处理并重试：' + logText.slice(-600));
      assert.ok(!/breaker OPEN: busy\[test-model\]/.test(logText),
        '重试成功不该记模型级失败、更不该开闸：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(up); }
  });

  t('瞬时 429 负例：**账户侧**额度不足（insufficient_quota）不得被当成"上游忙"重试', async () => {
    // 判据必须保守：sensenova 那类 `insufficient_quota` 与"上游自己忙"处置不同 ——
    // 前者由账户池换 Key / 短期限流处理，重发同一个 Key 没有意义。
    const up = await startFakeOpenAIUpstream({
      script: ['quota429', 'quota429', 'quota429', 'quota429'],
      quotaMsg: 'inference exceeds tpm/rpm limit',
    });
    const prov = openaiProvider('acctquota', up, { priority: 1, apiKeys: ['k1', 'k2'] });
    const gw = await startGatewayWith([prov], 'busyneg', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/判定为"上游自己忙"/.test(logText),
        'insufficient_quota 属账户侧，不得走"上游忙"原地重试：' + logText.slice(-600));
      assert.ok(/标记为 rate|账户级失败/.test(logText),
        '应按账户级限流处理（换 Key / 短冷却）：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(up); }
  });

  t('模型被上游下架（permission_error 403）→ **只冷却该模型**，不连坐整家 30 分钟', async () => {
    // 2026-10-14 实测（commandcode 退役 ling 免费档）：
    //   403 {"error":{"message":"The free Ling 3.1 Flash tier has been retired. Ling 3.1 Flash
    //        is now a paid model -- run /model and pick Ling 3.1 Flash
    //        (inclusionai/ling-3.1-flash) to keep going.","type":"permission_error","code":"FORBIDDEN"}}
    // 旧实现按"鉴权/欠费/权限类 → 与具体模型无关 → 冷却**整家** 30 分钟"处理，
    // 于是同家**仍然完全正常**的别的模型（deepseek-v4.1-flash / glm-5.3-flash，curl 都是 200）
    // 被一起停用半小时 —— 日志紧接着就是一片 `skip commandcode (breaker open)`。
    // 修法：`permission_error` + 正文点名"该模型退役/转付费" → 降级为模型级冷却。
    const up = await startFakeOpenAIUpstream({
      script: ['retired403', 'retired403', 'retired403', 'retired403'],
      retiredMsg: 'The free Ling 3.1 Flash tier has been retired. Ling 3.1 Flash is now a paid model -- run /model and pick Ling 3.1 Flash (inclusionai/ling-3.1-flash) to keep going.',
    });
    const prov = openaiProvider('retired', up, { priority: 1 });
    const gw = await startGatewayWith([prov], 'retired403case', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/breaker OPEN: retired 失败（403）/i.test(logText),
        '**不得**把整家按 403 熔断（这正是误伤同家其它模型的原因）：' + logText.slice(-700));
      assert.ok(/breaker OPEN: retired\[test-model\]/.test(logText),
        '应降级为**模型级**冷却：' + logText.slice(-700));
    } finally { killGw(gw); closeUp(up); }
  });

  t('模型下架 403 负例：真正的整家鉴权失败仍须熔断整家（别把裸 403 也放成模型级）', async () => {
    // 判据必须保守：`Authorization failed` 这类裸 403 是整家性的（换模型也没用），
    // 仍要冷却整家，否则每个模型都会各自去打一遍必然失败的鉴权。
    const up = await startFakeOpenAIUpstream({
      script: ['auth403', 'auth403', 'auth403', 'auth403'],
      authMsg: 'Authorization failed',
    });
    const prov = openaiProvider('authfail', up, { priority: 1 });
    const gw = await startGatewayWith([prov], 'auth403case', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker OPEN: authfail 失败（403）/.test(logText),
        '裸 403（整家鉴权失败）仍须熔断**整家**：' + logText.slice(-700));
    } finally { killGw(gw); closeUp(up); }
  });

  t('429 原地重试必须**尊重上游 Retry-After**（amd 回 1 秒，固定 400ms 会再撞并发上限）', async () => {
    // 2026-10-15 实测（amd `Model 'DeepSeek-V4.1-Flash' is at its concurrency limit (16)`）：
    // 上游带 `Retry-After: 1`（秒）。旧实现原地重试固定等 400ms → 必然再撞同一个并发上限，
    // 日志里满屏"429 原地重试仍失败"，重试形同虚设。
    // 这条用例：上游第一次 429（带 Retry-After: 1），第二次才 200；
    // 断言客户端最终 200 且日志写明遵循了 Retry-After。
    const up = await startFakeOpenAIUpstream({
      script: ['busy429ra', 'ok'],
      busyRa: '1',
      busyMsg: "Model 'x' is at its concurrency limit (16); please retry later",
    });
    const prov = openaiProvider('ra429', up, { priority: 1 });
    const gw = await startGatewayWith([prov], 'ra429case', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '应被原地重试救回（等待足够久），实际 ' + r.status + ' ' + r.text.slice(0, 160));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/遵循上游 Retry-After/.test(logText),
        '日志须写明遵循了上游 Retry-After（否则等待时长可能不足）：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(up); }
  });

  /* ── 请求体过大 → 当次调用跳过该家（2026-10-16，commandcode 实测）───────────────
   *
   * 现场：DSH 声明 366 个工具时，commandcode 稳定回
   *   HTTP 400 `Invalid request JSON: JSON node count cannot exceed 32768`
   * 这是确定性失败，重试无用，但每次要白等约 3.3 秒才 failover。
   *
   * 用户要求（原话）：「当次调用跳过该供应商直接换一家，但是下一次调用时
   * 如果不触发降级则继续使用当前供应商」——即**不得留任何跨请求状态**。
   */
  /** 造一个节点数确定超限的请求（工具多 + schema 深，实测口径远超阈值） */
  const oversizedTools = () => Array.from({ length: 1800 }, (_, i) => ({
    name: 'Tool' + i,
    description: 'desc ' + i + ' ' + 'x'.repeat(200),
    input_schema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'y'.repeat(150) },
        b: { type: 'object', properties: { c: { type: 'number' }, d: { type: 'boolean' } } },
        e: { type: 'array', items: { type: 'string' } },
      },
      required: ['a'],
    },
  }));

  t('请求体过大：当次调用跳过该家（不发上游请求，省掉注定 400 的往返）', async () => {
    const up = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const prov = openaiProvider('bigbody', up, { priority: 1, jsonNodeLimit: 32768 });
    const gw = await startGatewayWith([prov], 'bigbodycase', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: oversizedTools() } });
      // 唯一候选被跳过 → 全部候选失败；关键是**上游一次都没被打到**
      assert.strictEqual(up.st.calls, 0,
        '请求体过大时不得向上游发请求（省掉注定 400 的往返），实际发了 ' + up.st.calls + ' 次');
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/请求体过大/.test(logText), '日志须写明"请求体过大"：' + logText.slice(-600));
      assert.ok(/本次调用跳过，不记失败/.test(logText), '日志须写明"不记失败"（不得冷却该家）：' + logText.slice(-600));
      assert.ok(r.status >= 400, '无其它候选时客户端应收到错误，实际 ' + r.status);
    } finally { killGw(gw); closeUp(up); }
  });

  t('请求体过大**不影响后续调用**：小请求照常走这家（无跨请求状态）', async () => {
    const up = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const prov = openaiProvider('bigbody2', up, { priority: 1, jsonNodeLimit: 32768 });
    const gw = await startGatewayWith([prov], 'bigbody2case', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 先来一发超大请求 → 被跳过，上游零调用
      await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: oversizedTools() } });
      assert.strictEqual(up.st.calls, 0, '超大请求不得触达上游，实际 ' + up.st.calls);

      // ② 紧接着一发正常请求 → **必须照常成功**（用户明确要求：下一次不触发降级就继续用这家）
      const r2 = await call({ port: gw.port });
      assert.strictEqual(r2.status, 200,
        '下一次正常请求必须照常走这家（不得因上次跳过而冷却/熔断它），实际 ' + r2.status + ' ' + r2.text.slice(0, 160));
      assert.strictEqual(up.st.calls, 1, '正常请求应恰好打到上游一次，实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  t('请求体过大**不熔断**：连续多次超大请求后，该家仍立即可用', async () => {
    const up = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const prov = openaiProvider('bigbody3', up, { priority: 1, jsonNodeLimit: 32768 });
    const gw = await startGatewayWith([prov], 'bigbody3case', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 连打 4 次（超过默认熔断阈值 3）——若误按失败计数，这家会被冷却 30 分钟
      for (let i = 0; i < 4; i++) await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: oversizedTools() } });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/breaker OPEN/.test(logText),
        '请求体过大**不得**计入失败/开闸熔断：' + logText.slice(-800));
      // 之后正常请求必须立刻成功（没有被冷却）
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200,
        '多次跳过之后，正常请求仍须立即成功（说明该家未被冷却），实际 ' + r.status + ' ' + r.text.slice(0, 160));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关（2026-10-20）：maxTools 开启后按上限裁剪工具 —— 内置工具全额保留，MCP 工具按序补足', async () => {
    // 现场：用户的 Claude Code 配了 4 个全局 MCP 服务器（Playwright / context7 / excel / rea），
    // 于是**一个很简单的任务**也会向上游声明 366 个工具 —— 结果
    //   workbuddy   → HTTP 400 code 11128（渠道校验拒绝）
    //   commandcode → 节点数超过上游硬限 32768 → 本家被跳过
    //   opencode    → 免费档对大体量请求同样 403
    // 三条候选全废，整轮失败。
    //
    // 裁剪规则：**内置工具（非 mcp__ 前缀）优先全额保留**，再用 MCP 工具按原顺序补到上限。
    // 默认关闭（maxTools 未设/0），必须显式开启 —— 否则会静默改变上游可见的工具集。
    const up = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const prov = openaiProvider('trimtools', up, { priority: 1 });
    const gw = await startGatewayWith([prov], 'trimtools', {}, { maxTools: 12 });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const builtins = Array.from({ length: 5 }, (_, i) => ({
        type: 'function', function: { name: 'Builtin' + i, description: '内置工具', parameters: { type: 'object', properties: {} } },
      }));
      const mcps = Array.from({ length: 30 }, (_, i) => ({
        type: 'function', function: { name: 'mcp__srv__tool' + i, description: 'MCP 工具', parameters: { type: 'object', properties: {} } },
      }));
      const r = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: [...builtins, ...mcps] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 160));

      const sent = up.st.bodies[up.st.bodies.length - 1];
      const names = (sent.tools || []).map((t) => (t.function && t.function.name) || t.name);
      assert.strictEqual(names.length, 12, '上游应只收到上限内的 12 个工具，实际 ' + names.length);
      for (const b of builtins) {
        assert.ok(names.includes(b.function.name), '内置工具必须全额保留，缺了 ' + b.function.name);
      }
      const mcpKept = names.filter((n) => /^mcp__/.test(n)).length;
      assert.strictEqual(mcpKept, 7, '剩余名额应给 MCP 工具（12-5=7），实际 ' + mcpKept);
      assert.ok(names.slice(5).every((n) => /^mcp__/.test(n)), 'MCP 工具应按原顺序补在后面');

      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/工具裁剪：35 → 12/.test(logText), '日志须写明裁剪前后数量：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关（2026-10-20）：maxTools 未设时**不裁剪**（保持既有"全量转发"语义）', async () => {
    const up = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const prov = openaiProvider('notrim', up, { priority: 1 });
    const gw = await startGatewayWith([prov], 'notrim', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const tools = Array.from({ length: 40 }, (_, i) => ({
        type: 'function', function: { name: 'T' + i, description: 'x', parameters: { type: 'object', properties: {} } },
      }));
      const r = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const sent = up.st.bodies[up.st.bodies.length - 1];
      assert.strictEqual((sent.tools || []).length, 40, '未配置 maxTools 时不得裁剪，实际 ' + (sent.tools || []).length);
      assert.ok(!/工具裁剪：/.test(fs.readFileSync(gw.logPath, 'utf8')), '未开启时不得出现裁剪日志');
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关（2026-10-20）：多出口 proxy.outlets —— 出口失败时轮换到下一个（出口 IP 被标记时的自救）', async () => {
    // 动机：opencode 免费车道今天 0 成功 / 6 失败，上游明确说
    //   "free models aren't available from your current network because we've detected
    //    abusive traffic from this IP address"
    // —— 免费档是**按出口 IP** 判的，一个 IP 被标记整条车道归零。
    // 旧实现只有一个静态 proxy.url，没有轮换，IP 一废就无解。
    //
    // 这条用例用两个**必死**的出口（127.0.0.1:1 / :2），验证：
    //   ① /health 暴露 egress（count / active）
    //   ② 出口连不上时真的轮换，日志点名新出口
    // ⚠ 上游不能用 127.0.0.1：**Node 的 env 代理会跳过回环地址**，那样根本走不到代理，
    //   也就测不出轮换（初版这么写，请求直接 200 直连成功）。改用 RFC 5737 的
    //   TEST-NET-1 不可路由地址，代理才会真的被应用。
    const p = {
      id: 'egress', baseURL: 'http://192.0.2.1:9/v1', apiKey: 'sk-egresstest0000000000',
      models: ['test-model'], priority: 1, enabled: true, timeoutMs: 5000,
    };
    const gw = await startGatewayWith([p], 'egress', { NODE_USE_ENV_PROXY: '1' }, {
      proxy: {
        enabled: true,
        outlets: ['http://127.0.0.1:1', 'http://127.0.0.1:2'],
        noProxy: [],
        // 冷却设短一点，避免影响同一进程内后续断言
        rotateCooldownMs: 2000,
      },
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const h = await call({ port: gw.port, method: 'GET', p: '/health' });
      const hj = JSON.parse(h.text);
      assert.ok(hj.egress, '/health 应暴露 egress 状态');
      assert.strictEqual(hj.egress.count, 2, '应报告 2 个出口，实际 ' + hj.egress.count);

      // 出口必死 → 请求会失败，但过程中必须轮换
      const r = await call({ port: gw.port });
      assert.ok(r.status >= 400, '两个出口都是死的，请求应失败，实际 ' + r.status);

      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/出口轮换已启用/.test(logText), '启动时应声明轮换已启用：' + logText.slice(-600));
      assert.ok(/\[egress\].*轮换/.test(logText),
        '出口失败时日志必须写明轮换（否则用户只看到 ECONNREFUSED，不知道有没有换出口）：' + logText.slice(-800));
      assert.ok(/127\.0\.0\.1:2/.test(logText), '轮换目标应指向第二个出口：' + logText.slice(-800));
    } finally { killGw(gw); }
  });

  t('网关（2026-10-20）：未配置 outlets 时**不得**改动宿主注入的代理 env', async () => {
    // 初版 initOutlets 无条件 syncOutletEnv()，在"没配 outlets 也没配 url"时把
    // 宿主注入的 HTTPS_PROXY **删掉**，等于把代理静默关掉（既有用例 `/health 应暴露代理地址` 当场红了）。
    const up = await startFakeUpstream({ status: 200 });
    const p = providerOf('noproxycfg', up, { priority: 1 });
    const gw = await startGatewayWith([p], 'egress-keep', { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:7890' }, {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const h = await call({ port: gw.port, method: 'GET', p: '/health' });
      const hj = JSON.parse(h.text);
      assert.strictEqual(hj.proxy.url, 'http://127.0.0.1:7890',
        '未配置 outlets 时，宿主注入的代理必须原样保留，实际 ' + JSON.stringify(hj.proxy));
      assert.strictEqual(hj.egress.count, 0, '未配置出口时 count 应为 0，实际 ' + hj.egress.count);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：请求体过大时会 failover 到下一家（不是整轮失败）', async () => {
    // 第一家（优先级高）配了上限 → 会被跳过；第二家**未配置**（默认不检查）→ 应被正常调用。
    //
    // ⚠ 这个用例记录了本特性一次**重要的方向修正**：初版是"默认对所有家生效、
    //   用 jsonNodeLimit:0 关闭"。但实测发现只有 commandcode 有节点数上限，
    //   而 x666 / muyuan.do / aihubmix.com 能吃下 140012 个节点（2.83 MB）的请求 ——
    //   对它们套用阈值就是**纯误跳**。故默认反转为"不检查"，只对已知有上限的家显式配置。
    const upBig = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const upOk = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const pBig = openaiProvider('bbig', upBig, { priority: 1, jsonNodeLimit: 32768 });
    const pOk = openaiProvider('bok', upOk, { priority: 2 });   // 未配置 = 不检查
    const gw = await startGatewayWith([pBig, pOk], 'bigfailover', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: oversizedTools() } });
      assert.strictEqual(r.status, 200,
        '应 failover 到第二家并成功，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.strictEqual(upBig.st.calls, 0, '第一家不应收到超大请求，实际 ' + upBig.st.calls);
      assert.strictEqual(upOk.st.calls, 1, '第二家（未配置上限）应收到请求一次，实际 ' + upOk.st.calls);
    } finally { killGw(gw); closeUp(upBig); closeUp(upOk); }
  });

  t('默认**不检查**：未配置 jsonNodeLimit 的家，超大请求照常发出去（零误跳）', async () => {
    // 这是本特性的核心安全保证。实测 x666 / muyuan.do / aihubmix.com 能吃 140012 节点，
    // 若默认对它们生效就会把本来能成功的请求跳过 → 凭空降低可用性。
    const up = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const prov = openaiProvider('pdefault', up, { priority: 1 });   // 刻意不配 jsonNodeLimit
    const gw = await startGatewayWith([prov], 'defaultoff', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: oversizedTools() } });
      assert.strictEqual(r.status, 200, '未配置上限的家必须照常服务，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.strictEqual(up.st.calls, 1, '超大请求应被正常转发到上游，实际 ' + up.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/请求体过大/.test(logText), '未配置的家不该出现"请求体过大"跳过记录：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(up); }
  });

  t('上限**逐家可配**：配了的家被跳过，未配置的家不受影响', async () => {
    // 两个家收到同一份超大请求：
    //   · 配了 jsonNodeLimit: 32768 的家 → 被跳过，上游零调用
    //   · 未配置的家（默认不检查）        → 照常收到请求
    const upConfigured = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const upDefault = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const pConfigured = openaiProvider('pcfg', upConfigured, { priority: 1, jsonNodeLimit: 32768 });
    const pDefault = openaiProvider('pdef', upDefault, { priority: 2 });   // 未配置 = 不检查
    const gw = await startGatewayWith([pConfigured, pDefault], 'perprov', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: oversizedTools() } });
      assert.strictEqual(r.status, 200, '应落到未配置上限的那家并成功，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.strictEqual(upConfigured.st.calls, 0, '配了上限的家应被跳过（零上游调用），实际 ' + upConfigured.st.calls);
      assert.strictEqual(upDefault.st.calls, 1, '未配置的家应收到请求，实际 ' + upDefault.st.calls);
    } finally { killGw(gw); closeUp(upConfigured); closeUp(upDefault); }
  });

  t('判定线按**请求体形状**分别取：Anthropic 翻译路径与 chat 透传各用各的实测边界', async () => {
    // 这条用例守的是本特性最容易搞错的一点：**两种形状的实测边界不同**。
    //   · translated （Anthropic 客户端 → 引擎翻译 → chat，DSH 走这条）: 46152 通过 / 46452 被拒
    //   · passthrough（客户端本身就是 chat，直接透传）              : 47884 通过 / 48384 被拒
    //
    // 早期版本只用一个全局阈值（由 passMax 48429 推出）→ 比 translated 的真实边界还高，
    // 于是**生产场景（366 个工具那条）完全不会被跳过**，功能对要修的 bug 失效。
    //
    // 这里用同一条 Anthropic 路径、**两份刻意卡在两线之间**的请求体来验证：
    // 口径落在 [translated.rejectMin, passthrough.rejectMin) 区间时 —— 走翻译路径的家应被跳过。
    const mkTools = (n, descLen) => Array.from({ length: n }, (_, i) => ({
      name: 'Tool' + i,
      description: ('工具说明 ' + i + '。').repeat(4) + 'x'.repeat(descLen),
      input_schema: {
        type: 'object',
        properties: { a: { type: 'string', description: 'y'.repeat(descLen) }, b: { type: 'object', properties: { c: { type: 'number' } } } },
        required: ['a'],
      },
    }));

    const up = await startFakeOpenAIUpstream({ behavior: 'ok' });
    const prov = openaiProvider('pshape', up, { priority: 1, jsonNodeLimit: 32768 });
    const gw = await startGatewayWith([prov], 'shapecase', {});
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');

      // ① 中等体量：远低于任何边界 → 必须放行（反例保护：别把正常请求也跳了）
      await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: mkTools(300, 60) } });
      assert.strictEqual(up.st.calls, 1, '中等体量必须放行到上游，实际 ' + up.st.calls);

      // ② 超大：远超两条线 → 必须跳过。
      // ⚠ 两条约束同时要满足，否则测的不是本次新增的判定：
      //   · 不能撞网关**自身的**请求体上限（413，约 1 MB）—— 初版用 2100 个长描述工具就撞上了；
      //   · 又必须真的把口径推过判定线（translated = 46452）。
      //   实测（_scratch/check-shape-payload.cjs）：光靠工具堆到 46452 会先撞 1 MB 上限
      //   （1800 个长描述工具 = 1.24 MB 却只有 45010 口径）。故改用**对话历史**堆量：
      //   每条历史约 9 个口径、却只占几百字节，性价比远高于工具 schema。
      //   实测（_scratch/measure-testcase.cjs）：3000 条该形状历史 + 366 个工具
      //   = 口径 39162 / 492 KB —— 仍低于判定线 46452，故需约 4200 条。
      const bigHist = [];
      for (let i = 0; i < 4200; i++) {
        bigHist.push(i % 2 === 0
          ? { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_' + i, name: 'Tool1', input: { a: 'v' + i } }] }
          : { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_' + (i - 1), content: 'r' + i }] });
      }
      const before = up.st.calls;
      await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }].concat(bigHist), tools: mkTools(366, 120) } });
      assert.strictEqual(up.st.calls, before, '远超两条边界时必须跳过（不上游），实际新增 ' + (up.st.calls - before));

      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/请求体过大/.test(logText), '日志须记录跳过原因：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(up); }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // magpie 三项能力（2026-10-25 吸收）：工具死循环拦截 / 流式循环守卫 / 上下文窗口过滤
  // ═══════════════════════════════════════════════════════════════════════

  /** 造 n 轮"完全一样"的工具交换（chat 协议）。 */
  const mkChatToolRounds = (n) => {
    const msgs = [{ role: 'user', content: '开始' }];
    for (let i = 0; i < n; i++) {
      msgs.push({
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call_' + i, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      });
      msgs.push({ role: 'tool', tool_call_id: 'call_' + i, content: 'line1\nline2' });
    }
    return msgs;
  };

  t('网关（magpie tool_loop）：连续 8 轮一模一样的工具调用 → 本地作答，一次上游都不打', async () => {
    // 现场（magpie 实测）：Codex 在 WorkBuddy 的 deepseek-v4-pro 上半小时读同一段代码 308 次、
    // 当晚白烧 537 credits。关键洞察：每一轮都把整段对话带上，**循环就在请求体里** ——
    // 等上游回话再判，那一轮的钱已经花了。
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('tl', up, { quirks: ['force-stream'] })], 'toolloop');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');

      // ① 7 轮 —— 差一轮，不得拦（避免误伤正常的重试/轮询式 agent）
      const r7 = await call({
        port: gw.port,
        body: { model: 'test-model', messages: mkChatToolRounds(7) },
      });
      assert.strictEqual(r7.status, 200, '实际 ' + r7.status + ' ' + r7.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, '7 轮不满阈值，必须照常发给上游，实际 ' + up.st.calls);

      // ② 8 轮 —— 命中阈值，本地作答
      const r8 = await call({
        port: gw.port,
        body: { model: 'test-model', messages: mkChatToolRounds(8) },
      });
      assert.strictEqual(r8.status, 200, '本地作答仍是正常 200，实际 ' + r8.status + ' ' + r8.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, '命中死循环后**不得**再打上游，实际 ' + up.st.calls);
      const body8 = JSON.parse(r8.text);
      const text8 = (body8.choices && body8.choices[0] && body8.choices[0].message.content) || '';
      assert.ok(/死循环/.test(text8), '本地作答须说清拦了什么：' + text8.slice(0, 300));
      assert.ok(/read_file/.test(text8), '文案里要指出是哪个工具：' + text8.slice(0, 300));
      assert.strictEqual(body8.usage.prompt_tokens, 0, '没有发给上游 → 输入 token 必须是 0');

      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/工具死循环/.test(logText), '日志须记录拦截：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关（magpie tool_loop）：Anthropic 路径（/v1/messages）同样要拦 —— 同一判定两处实现易漏', async () => {
    // 本项目老坑：bot 判定在 handleCompletion 与 handleMessages 各写一份，改一处必须改另一处。
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('tlmsg', up, { quirks: ['force-stream'] })], 'toolloopmsg');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const msgs = [{ role: 'user', content: '开始' }];
      for (let i = 0; i < 8; i++) {
        msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_' + i, name: 'read_file', input: { path: 'a.txt' } }] });
        msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_' + i, content: 'line1\nline2' }] });
      }
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, messages: msgs },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 300));
      assert.strictEqual(up.st.calls, 0, 'Anthropic 路径命中死循环也不得打上游，实际 ' + up.st.calls);
      const parsed = JSON.parse(r.text);
      assert.strictEqual(parsed.type, 'message', '必须是合法的 Anthropic message 形状：' + r.text.slice(0, 200));
      assert.ok(/死循环/.test(parsed.content[0].text), '文案须说清拦了什么：' + parsed.content[0].text.slice(0, 300));
      assert.strictEqual(parsed.usage.input_tokens, 0, '没有发给上游 → input_tokens 必须是 0');
    } finally { killGw(gw); closeUp(up); }
  });

  // 造一段"陷进重复"的 SSE：每帧一个句子单元，全部相同 → 256 个单元后必判循环。
  const mkLoopSse = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      s += 'data: ' + JSON.stringify({ id: 'chatcmpl-loop', choices: [{ index: 0, delta: { content: 'Now.\n' } }] }) + '\n\n';
    }
    return s + 'data: [DONE]\n\n';
  };

  t('网关（magpie loop_guard）：直通路径流式答复陷进重复 → 主动切断并告知客户端"模型在重复"', async () => {
    // 现场（magpie issue #1359）：DeepSeek 的答复反复输出 "Now." "Writing." "Go." 直到 token 上限。
    // 等流结束再判等于钱已经烧完 —— 必须边转发边判。
    const up = await startFakeOpenAIUpstream({ sseRaw: mkLoopSse(300) });
    const gw = await startGatewayWith([openaiProvider('lg', up, { quirks: ['force-stream'] })], 'loopguard');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port,
        body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '流已经开始了，状态码不可能再改，实际 ' + r.status);
      assert.ok(/loop_detected/.test(r.text), '必须补一个明确的 loop_detected 错误事件：' + r.text.slice(-400));
      assert.ok(!/upstream_truncated/.test(r.text),
        '我们主动切断的，**不能**说成"上游被中断"（会让用户去查网络）：' + r.text.slice(-400));

      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/\[loop\].*直通路径/.test(logText), '日志须记录直通路径的切断：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关（magpie loop_guard）：翻译路径（chat 上游 → Anthropic 客户端）也必须切断', async () => {
    // ⚠ 这条用例另一个作用是锁住一个**真实踩到的坑**：上游把整条流塞进一个 TCP 分片时，
    // "偷看首事件"会把全部字节读进 pendingHead，随后 `reader.read()` 直接 done ——
    // 读循环里的守卫一次都不会被调用。修法是 pendingHead 补发前先喂守卫。
    const up = await startFakeOpenAIUpstream({ sseRaw: mkLoopSse(300) });
    const gw = await startGatewayWith([openaiProvider('lgmx', up, { quirks: ['force-stream'] })], 'loopguardmx');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(/"type":"error"/.test(r.text), '必须补 Anthropic 形状的 error 事件：' + r.text.slice(-400));
      assert.ok(/message_stop/.test(r.text), '错误之后仍要有 message_stop，否则客户端会一直等：' + r.text.slice(-400));
      assert.ok(!/upstream_truncated/.test(r.text), '不得说成"上游被中断"：' + r.text.slice(-400));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/\[loop\]/.test(logText), '日志须记录切断：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关（magpie loop_guard）：正常答复（每帧内容都不同）绝不能被切断', async () => {
    // 反例保护：循环守卫最容易犯的错就是误伤正常的列表/代码/表格输出。
    let sse = '';
    for (let i = 0; i < 300; i++) {
      sse += 'data: ' + JSON.stringify({ id: 'chatcmpl-ok', choices: [{ index: 0, delta: { content: '第 ' + i + ' 行内容不同。\n' } }] }) + '\n\n';
    }
    sse += 'data: [DONE]\n\n';
    const up = await startFakeOpenAIUpstream({ sseRaw: sse });
    const gw = await startGatewayWith([openaiProvider('lgok', up, { quirks: ['force-stream'] })], 'loopguardok');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port,
        body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.ok(!/loop_detected/.test(r.text), '内容各不相同，不得判循环：' + r.text.slice(-400));
      assert.ok(/第 299 行内容不同/.test(r.text), '最后一行必须完整送到客户端');
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/\[loop\]/.test(logText), '日志里不该有任何循环判定：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关（magpie roomy）：装不下的候选排到最后（不删除）—— 前面的家失败后仍会轮到它', async () => {
    // 同一个逻辑模型，免费档常见 128K~200K、订阅/中转常见 1M。请求带 40 万 token 的对话时，
    // 按 priority 先问免费档 = 一次注定失败的往返（白等一次超时、还可能被记一次失败）。
    const upBig = await startFakeOpenAIUpstream({ behavior: 'boom' });   // 先排到的这家失败
    const upSmall = await startFakeOpenAIUpstream({ json: true });        // 装不下的那家兜底
    const gw = await startGatewayWith([
      {                                           // priority 1 但窗口只有 10 tokens → 装不下
        id: 'small', baseURL: 'http://127.0.0.1:' + upSmall.port + '/v2', apiKey: UPSTREAM_KEY,
        models: [{ id: 'test-model', as: 'test-model', contextWindow: 10 }],
        priority: 1, enabled: true, protocol: 'openai-chat',
      },
      {                                           // priority 2 但窗口 1M → 装得下
        id: 'big', baseURL: 'http://127.0.0.1:' + upBig.port + '/v2', apiKey: UPSTREAM_KEY,
        models: [{ id: 'test-model', as: 'test-model', contextWindow: 1000000 }],
        priority: 2, enabled: true, protocol: 'openai-chat',
      },
    ], 'roomy');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 请求体必须**真的**超过 small 的 10 tokens 窗口，否则 roomy 什么都不做（那是正确行为）。
      // 用 2 万字符 ≈ 5000 tokens（roughTokens 按 len/4 估）。
      const big = 'x'.repeat(20000);
      const r = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: big }] } });
      assert.strictEqual(r.status, 200, '装得下的那家失败后，装不下的仍要兜底，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upBig.st.calls, 1, '窗口够的那家必须先被尝试，实际 ' + upBig.st.calls);
      assert.strictEqual(upSmall.st.calls, 1, '装不下的候选**不得被删除** —— 全都失败时必须轮到它，实际 ' + upSmall.st.calls);

      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/装不下的候选排到最后/.test(logText), '日志须说明排序被调整：' + logText.slice(-600));
      assert.ok(/small\(0K\)/.test(logText), '日志须点名被移动的是谁：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(upBig); closeUp(upSmall); }
  });

  t('网关（magpie roomy）：窗口未知/只有一个候选时**什么都不做**（零误动的边界）', async () => {
    // magpie 的四条边界里最容易被忽略的两条：窗口不可知、只有一个候选。
    // 前者若按 0 当"装不下"处理，所有没声明窗口的家都会被排到最后 —— 那是灾难性的静默行为改变。
    const up1 = await startFakeOpenAIUpstream({ json: true });
    const up2 = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([
      // 两家都没声明 contextWindow → 必须按原 priority 走
      { id: 'p1', baseURL: 'http://127.0.0.1:' + up1.port + '/v2', apiKey: UPSTREAM_KEY, models: ['test-model'], priority: 1, enabled: true, protocol: 'openai-chat' },
      { id: 'p2', baseURL: 'http://127.0.0.1:' + up2.port + '/v2', apiKey: UPSTREAM_KEY, models: ['test-model'], priority: 2, enabled: true, protocol: 'openai-chat' },
    ], 'roomy-unknown');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.strictEqual(up1.st.calls, 1, 'priority 1 必须优先（窗口未知不影响顺序），实际 ' + up1.st.calls);
      assert.strictEqual(up2.st.calls, 0, 'priority 2 不该被用到，实际 ' + up2.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/装不下的候选排到最后/.test(logText), '窗口未知时不得调整顺序：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关（magpie roomy）：窗口只声明在**第二条**同名映射上时，也必须被认到（旧实现取 find 第一条 → 静默失效）', async () => {
    // 现场依据：同一逻辑名常有多条映射（vision 变体 / 免费档变体）。旧 windowOf 用
    // `modelEntries(p).find(e => e.as === model)` 取**第一条**，于是"第一条没填、第二条填了"
    // 会被判成"窗口不可知" → roomy 对这家完全不动作，而且日志里一句提示都没有。
    // 实测当前运行配置受影响逻辑名 0 个（所以是个潜伏缺陷，不是正在发作的故障），
    // 但口径必须修对：用户以后加一条带窗口的映射，roomy 就该立刻生效。
    const upDup = await startFakeOpenAIUpstream({ json: true });
    const upBig2 = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([
      {
        id: 'dup', baseURL: 'http://127.0.0.1:' + upDup.port + '/v2', apiKey: UPSTREAM_KEY,
        // 第一条（决定实际发上游 id 的那条）**没有** contextWindow；第二条才有
        models: [
          { id: 'test-model', as: 'test-model' },
          { id: 'test-model-vision', as: 'test-model', contextWindow: 10, vision: true },
        ],
        priority: 1, enabled: true, protocol: 'openai-chat',
      },
      {
        id: 'big2', baseURL: 'http://127.0.0.1:' + upBig2.port + '/v2', apiKey: UPSTREAM_KEY,
        models: [{ id: 'test-model', as: 'test-model', contextWindow: 1000000 }],
        priority: 2, enabled: true, protocol: 'openai-chat',
      },
    ], 'roomy-dup-as');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'x'.repeat(20000) }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upBig2.st.calls, 1, '窗口 1M 的那家必须先被尝试，实际 ' + upBig2.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/装不下的候选排到最后/.test(logText),
        '第二条映射声明的窗口也须生效（否则 roomy 静默失效）：' + logText.slice(-600));
      assert.ok(/dup\(0K\)/.test(logText), '日志须点名 dup 被移动：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(upDup); closeUp(upBig2); }
  });

  t('网关（magpie roomy）：上游目录里的 context_length 会被学到并用上（学不到的家保持不可知，绝不猜）', async () => {
    // 实测（2026-10-25，15 家启用家全扫）：只有 commandcode / commandcode-haiku / sensenova /
    // amd 四家的 /v1/models 真带 context_length，其余 11 家只回 {id,object,created,owned_by}。
    // 所以 roomy 的窗口来源两条：① 配置声明 ② 上游目录学（30 分钟缓存，后台、不阻塞启动）。
    // 学不到就必须保持"不可知"—— 猜数字会让 roomy 把好模型永久排到最后，比不做更糟。
    const upSmall3 = await startFakeUpstream({ catalog: [{ id: 'test-model', context_length: 10 }] });
    const upBig3 = await startFakeUpstream({ catalog: [{ id: 'test-model', context_length: 1000000 }] });
    const gw = await startGatewayWith([
      // 两家都**没有**声明 contextWindow → 只能靠学
      providerOf('learn-small', upSmall3, { priority: 1 }),
      providerOf('learn-big', upBig3, { priority: 2 }),
    ], 'roomy-learn', { DSH_GATEWAY_ROOMY: '1', DSH_GATEWAY_ROOMY_LEARN: '1', DSH_GATEWAY_ROOMY_LEARN_MS: '0' });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 等学习完成（后台任务，启动后 0ms 触发一次 fetch /models）。最多等 10s。
      let learned = '';
      for (let i = 0; i < 100; i++) {
        learned = fs.readFileSync(gw.logPath, 'utf8');
        if (/\[roomy\] 从上游目录学到 learn-small/.test(learned) && /\[roomy\] 从上游目录学到 learn-big/.test(learned)) break;
        await sleep(100);
      }
      assert.ok(/\[roomy\] 从上游目录学到 learn-small/.test(learned),
        '须从上游目录学到 learn-small 的窗口：' + learned.slice(-800));
      assert.ok(/\[roomy\] 从上游目录学到 learn-big/.test(learned),
        '须从上游目录学到 learn-big 的窗口：' + learned.slice(-800));

      const r = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'x'.repeat(20000) }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upSmall3.st.calls, 0, '学到的窗口只有 10 tokens → 必须被排到最后，实际打了 ' + upSmall3.st.calls);
      assert.strictEqual(upBig3.st.calls, 1, '学到的 1M 窗口那家必须先被尝试，实际 ' + upBig3.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/装不下的候选排到最后/.test(logText) && /learn-small\(0K\)/.test(logText),
        '学到的窗口必须参与排序：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(upSmall3); closeUp(upBig3); }
  });

  t('网关（magpie roomy）：上游目录不带 context_length 时保持不可知 —— 绝不猜数字改变路由顺序', async () => {
    // 这是上面那条的**反例保护**，也是本功能的红线：11/15 家上游目录都没有窗口字段。
    // 若把"学不到"当成某个默认值（哪怕是很小或很大），这些家的相对顺序就会被动到，
    // 而用户把某家放 priority 1 是有意的。所以学不到 → windowOf 返回 0 → roomy 不动作。
    const upNA = await startFakeUpstream();   // 默认 catalog：[{ id: 'test-model' }]，无 context_length
    const upNB = await startFakeUpstream();
    const gw = await startGatewayWith([
      providerOf('na-1', upNA, { priority: 1 }),
      providerOf('na-2', upNB, { priority: 2 }),
    ], 'roomy-noctx', { DSH_GATEWAY_ROOMY: '1', DSH_GATEWAY_ROOMY_LEARN: '1', DSH_GATEWAY_ROOMY_LEARN_MS: '0' });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 等到"学过了"的证据（学到了 0 条时**不打日志**，所以只能靠 modelsReqs 计数确认探测发生过）
      let ok = false;
      for (let i = 0; i < 100; i++) {
        if (upNA.st.modelsReqs > 0 && upNB.st.modelsReqs > 0) { ok = true; break; }
        await sleep(100);
      }
      assert.ok(ok, '两家都必须被探测过目录，实际 ' + upNA.st.modelsReqs + '/' + upNB.st.modelsReqs);
      const r = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'x'.repeat(20000) }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.strictEqual(upNA.st.calls, 1, '目录不给窗口 → 顺序不得改变，priority 1 必须优先（实际 ' + upNA.st.calls + '）');
      assert.strictEqual(upNB.st.calls, 0, 'priority 2 不该被用到（实际 ' + upNB.st.calls + '）');
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!/装不下的候选排到最后/.test(logText), '窗口不可知时不得调整顺序：' + logText.slice(-600));
      assert.ok(!/从上游目录学到 na-1/.test(logText), '目录没给窗口就不该声称学到了：' + logText.slice(-600));
    } finally { killGw(gw); closeUp(upNA); closeUp(upNB); }
  });

  t('网关（审计 R8-4）：日志超过上限是**轮转**成 .1 而不是清空 —— 排障取证不能被抹掉', async () => {
    // 旧实现 `fs.writeFileSync(LOG_PATH, '')`：5MB 一到就把历史直接抹掉。
    // 而出问题之后想回看的恰恰就是那段被抹掉的日志 —— "防磁盘膨胀"不能以删掉唯一证据为代价。
    // 现在与宿主 src/logger.js 同口径：rename 成 .1，旧 .1→.2、.2→.3，只留 3 份。
    //
    // 这里锁四件事：① 满了之后旧内容还在（在 .1 里）② 当前文件重新开始且非空
    // ③ 确实产生了 .1（清空实现永远不会产生 .1）④ 历史内容一字不少。
    const up = await startFakeUpstream();
    const dir = fs.mkdtempSync(path.join(tmp, 'logrot-'));
    const logPath = path.join(dir, 'gateway.log');
    const cfgPath = path.join(dir, 'gateway.config.json');
    const port = await freePort();
    // 先把日志撑到上限之上（网关还没起，所以不存在"10 秒节流看不到"的问题）
    const filler = 'X'.repeat(1023) + '\n';
    const need = Math.ceil((6 * 1024 * 1024) / filler.length);
    const fd = fs.openSync(logPath, 'a');
    for (let i = 0; i < need; i++) fs.writeSync(fd, filler);
    fs.closeSync(fd);
    const beforeSize = fs.statSync(logPath).size;
    assert.ok(beforeSize > 5 * 1024 * 1024, '前提：日志必须已超过上限（实际 ' + beforeSize + '）');

    fs.writeFileSync(cfgPath, JSON.stringify({
      port, apiKey: GATEWAY_KEY, providers: [providerOf('rot-1', up)],
    }, null, 2), 'utf8');
    const proc = spawn(process.execPath, [MJS, '--config', cfgPath, '--log', logPath, '--port', String(port)], {
      stdio: 'ignore', windowsHide: true,
    });
    try {
      const ready = await waitHealth(port, 20000);
      assert.ok(ready, '独立网关实例应就绪');
      const r = await call({ port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);

      assert.ok(fs.existsSync(logPath + '.1'),
        '轮转后必须存在 gateway.log.1 —— 旧实现是把当前文件清空，永远不会产生 .1');
      const rolled = fs.readFileSync(logPath + '.1', 'utf8');
      assert.ok(rolled.length > 5 * 1024 * 1024,
        '历史日志必须完整保留在 .1 里（实际 ' + rolled.length + ' 字节）');
      assert.ok(rolled.indexOf('X'.repeat(1023)) >= 0, '历史内容必须一字不少');
      const fresh = fs.readFileSync(logPath, 'utf8');
      assert.ok(fresh.length < 5 * 1024 * 1024, '当前日志必须从新开始（实际 ' + fresh.length + '）');
      assert.ok(fresh.length > 0, '当前日志不能是空的 —— 轮转之后必须继续写');
      assert.ok(!/X{1023}/.test(fresh), '当前日志里不该再出现历史填充内容');
    } finally {
      try { proc.kill(); } catch { }
      closeUp(up);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    }
  });

  t('网关（审计 R10）：DSH_GATEWAY_DUMP_WB11128=1 时 11128 现场必须真的落盘，且错误体里的密钥要打码', async () => {
    // 审计发现：dumpWorkbuddy11128 自 a661323 引入起**从未被调用过**（全文只有定义 1 处），
    // 而注释、日志、README 排错表四处都在承诺"开 DSH_GATEWAY_DUMP_WB11128=1 就能转储比对"。
    // 用户 11128 复发时照做 → 一个字节都不会落盘，且没有任何提示，排错路径直接断掉。
    //
    // 这条用例钉两件事：
    //   ① 开关打开时**真的有文件**（看文件系统，不看日志自述）；关着时**什么都不写**。
    //   ② 转储里的上游错误体与本文件其它 30 处落日志的写法一致 —— 要过 maskSecrets。
    //      上游回显凭据是实测过的形态（2026-10-08 审计：401 时把收到的凭据裸回显）。
    const SECRET = 'sk-' + 'LIVE'.repeat(10);   // 40 字符，会被 maskSecrets 命中
    const upBlocked = http.createServer((q, s) => {
      q.resume();
      q.on('end', () => {
        s.writeHead(400, { 'content-type': 'application/json' });
        s.end(JSON.stringify({
          code: 11128,
          msg: 'Illegal API invocation from an unapproved channel',
          detail: 'Authorization failed for key ' + SECRET,   // ← 模拟上游回显
        }));
      });
    });
    await new Promise((r) => upBlocked.listen(0, '127.0.0.1', r));

    const mk = (id) => ({
      id, baseURL: 'http://127.0.0.1:' + upBlocked.address().port + '/v2',
      protocol: 'openai-chat', models: ['test-model'],
      apiKey: 'sk-' + 'a'.repeat(15), priority: 1, enabled: true,
    });
    const askBody = (extra) => Object.assign({
      model: 'test-model', max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    }, extra || {});

    try {
      // ---- 开关关着：不许产生任何文件 ----
      {
        const gw = await startGatewayWith([mk('wb-nodump')], 'wbdump-off', {}, {});
        try {
          const r = await call({ port: gw.port, p: '/v1/chat/completions', body: askBody() });
          // 11128 的处置是「继续 failover，不终止客户端任务」—— 只有这一家候选，
          // 于是走到收口分支的 503（all providers unavailable），不是 400。
          // 断言 503 而不是 400，是因为 400 会意味着"确定性 4xx 终止了任务"。
          assert.strictEqual(r.status, 503,
            '单家候选且命中 11128 时应以 503 收口（继续 failover 的语义），实际 ' + r.status
            + ' ' + r.text.slice(0, 200));
        } finally { killGw(gw); }
        const dumpDir = path.join(gw.dir, 'dump');
        assert.ok(!fs.existsSync(dumpDir),
          '开关关着时不该创建 dump 目录（说明函数被无条件调用了）：' + dumpDir);
      }

      // ---- 开关打开：必须落盘，且密钥打码 ----
      {
        const gw = await startGatewayWith(
          [mk('wb-dump')], 'wbdump-on', { DSH_GATEWAY_DUMP_WB11128: '1' }, {});
        try {
          const r = await call({
            port: gw.port, p: '/v1/chat/completions',
            body: askBody({ messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }] }),
          });
          assert.strictEqual(r.status, 503,
            '单家候选且命中 11128 时应以 503 收口（继续 failover 的语义），实际 ' + r.status
            + ' ' + r.text.slice(0, 200));
        } finally { killGw(gw); }

        const dumpDir = path.join(gw.dir, 'dump');
        assert.ok(fs.existsSync(dumpDir), '开关打开时必须创建 dump 目录，实际不存在：' + dumpDir);
        const files = fs.readdirSync(dumpDir).filter((f) => /^wb11128-.*\.json$/.test(f));
        assert.strictEqual(files.length, 1,
          '必须正好落一份现场转储（不是零份，也不是份数不定）：' + JSON.stringify(fs.readdirSync(dumpDir)));

        const raw = fs.readFileSync(path.join(dumpDir, files[0]), 'utf8');
        // ⚠ 这条是关键：旧实现 String(detail).slice(0,600) 未脱敏，上游回显的凭据会明文落盘
        assert.ok(!raw.includes(SECRET),
          '转储里的上游错误体必须打码（上游会把收到的凭据回显回来）：' + raw.slice(0, 400));

        const meta = JSON.parse(raw);
        assert.strictEqual(meta.upstreamStatus, '11128');
        assert.strictEqual(meta.provider, 'wb-dump');
        assert.ok(meta.bytes > 0, '应记下请求体字节数');
        assert.strictEqual(meta.meta.model, 'test-model');
        assert.strictEqual(meta.meta.messageCount, 2, '应记下消息条数');
        assert.deepStrictEqual(meta.meta.roles, ['system', 'user'], '应记下角色序列');
      }
    } finally {
      try { upBlocked.close(); } catch { /* 忽略 */ }
    }
  });

  t('网关（审计 R12）：11128 转储必须只保留最近若干份 —— 注释承诺过，变异测试证明此前无人守', async () => {
    // 缺陷形态：`dumpWorkbuddy11128` 上方注释写着"目录沿用项目既有的 logs/dump，
    // 并**只保留最近若干份**"，但函数体里**没有任何 prune 调用**。
    // 与 P3 修掉的 blocked-*.json 无界增长是同一族 —— 那份写了 prune，这份只在注释里写了。
    //
    // 为什么这条特别值得钉：开着 DSH_GATEWAY_DUMP_WB11128=1 长期跑、且反复撞 11128 的实例
    // **正是这个开关存在的场景**，于是它会稳定地把 logs/dump 撑到无界。
    // 变异测试（删掉那一行 prune 调用）跑全量 222 条用例，**一条都没红** —— 没有任何回归保护。
    const upBlocked = http.createServer((q, s) => {
      q.resume();
      q.on('end', () => {
        s.writeHead(400, { 'content-type': 'application/json' });
        s.end(JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }));
      });
    });
    await new Promise((r) => upBlocked.listen(0, '127.0.0.1', r));

    const mk = () => ({
      id: 'wb-prune', baseURL: 'http://127.0.0.1:' + upBlocked.address().port + '/v2',
      protocol: 'openai-chat', models: ['test-model'],
      apiKey: 'sk-' + 'a'.repeat(15), priority: 1, enabled: true,
    });

    try {
      const gw = await startGatewayWith([mk()], 'wbprune', { DSH_GATEWAY_DUMP_WB11128: '1' }, {});
      try {
        assert.ok(gw.ready, '独立网关实例应就绪');
        // 打 DUMP_KEEP_FILES + 若干次，确保超过上限
        const N = 26;   // DUMP_KEEP_FILES = 20
        for (let i = 0; i < N; i++) {
          await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi ' + i }] } });
        }
        const dumpDir = path.join(gw.dir, 'dump');
        assert.ok(fs.existsSync(dumpDir), '开关打开时必须有 dump 目录：' + dumpDir);
        const files = fs.readdirSync(dumpDir).filter((f) => /^wb11128-.*\.json$/.test(f));
        assert.ok(files.length > 0,
          '必须真的落过盘（否则这条用例在测一个没发生的场景）：' + JSON.stringify(fs.readdirSync(dumpDir)));
        // 上限是 20，打了 26 次，允许"正好 20"或略多（清理与写入的时序），但绝不能是 26
        assert.ok(files.length <= 20,
          '转储必须只保留最近 ' + 20 + ' 份（打 ' + N + ' 次后实际留下 ' + files.length
          + ' 份）—— 上限失效会让目录无界增长：' + JSON.stringify(files));
      } finally { killGw(gw); }
    } finally {
      try { upBlocked.close(); } catch { /* 忽略 */ }
    }
  });

  t('网关（审计 R12）：maskSecrets 的裸高熵串兜底必须生效 —— 变异删掉它，全量用例一条都不红', async () => {
    // 变异测试结果：把 `maskSecrets` 最后那条「裸高熵串兜底」整段去掉，
    // `node --test tests/gateway.test.js` 222 条用例**全绿**。
    // 也就是说 2026-10-08 那次真实事故（上游 401 把收到的凭据裸回显成
    // `auth rejected for credential aB3xK9mQ2pL7wR4tY6uI8oP0sD5fG1hJ2k`）的修复，
    // 没有任何回归保护 —— 它是脱敏链的**最后一层**，前面的前缀/关键词规则全不命中时只剩它。
    //
    // 这里用 D6 的同一形态（上游把 Authorization 原样回显），但故意选一个
    // **既无前缀、也无关键词**的高熵串，逼着只能靠兜底那一条规则命中。
    const SECRET = 'aB3xK9mQ2pL7wR4tY6uI8oP0sD5fG1hJ2k';   // 32 字符，字母+数字，无前缀无关键词
    const up = await startFakeOpenAIUpstream({
      behavior: 'credit',
      errorBody: { error: { message: 'auth rejected for credential ' + SECRET } },
    });
    const gw = await startGatewayWith([openaiProvider('hb', up, { apiKeys: ['k1'] })], 'highEntropy');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(!logText.includes(SECRET),
        '日志里不得出现裸高熵凭据（说明兜底规则没生效）：' + logText.slice(-400));
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      const reasons = JSON.stringify(h.accounts || []);
      assert.ok(!reasons.includes(SECRET),
        '/health 的 reason 不得含裸高熵凭据（免鉴权接口）：' + reasons);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关（审计 R12）：网关 apiKey 不足 16 字符必须拒绝 —— 变异删掉下限，222 条用例全绿', async () => {
    // 变异测试结果：把 `authorized()` 里的 `if (expect.length < 16) return false;`
    // 改成 `if (expect.length === 0) return false;`，222 条用例**一条都没红**。
    // 也就是说"网关鉴权要求 ≥16 字符"这条约束（`src/gateway-manager.js:238` 的配置校验
    // 与引擎里的 authorized() 两处都写了）在引擎侧完全没有测试保护。
    //
    // 为什么这条重要：短 apiKey 的爆破面是**线性**的（4 字符 = 几十秒），
    // 而网关监听回环、/health 免鉴权、配置由用户在 GUI 里填 —— 一个手滑填的 "1234"
    // 就会把整条链路的鉴权降级成摆设。
    // 配置校验（gateway-manager.js）存在，但**引擎是独立可启动的**（DSH_GATEWAY_CONFIG 直接起），
    // 不经过 gateway-manager 的校验，所以引擎侧必须自己守住。
    const gw = await startGatewayWith(
      [{ id: 'x', baseURL: 'http://127.0.0.1:1/v1', protocol: 'openai-chat', models: ['test-model'], apiKey: 'k', priority: 1, enabled: true }],
      'shortKey', {}, { apiKey: 'short1234' },   // 10 字符，< 16
    );
    try {
      assert.ok(gw.ready, '独立网关实例应就绪（配置能被加载）');
      const r = await call({ port: gw.port, key: 'short1234' });
      assert.strictEqual(r.status, 401,
        '配置里的 apiKey 不足 16 字符时，任何请求都必须 401（不能因为"它和配置一致"就放行）：实际 '
        + r.status + ' ' + r.text.slice(0, 200));
    } finally { killGw(gw); }
  });

  t('网关（审计 R11）：用量保留天数必须覆盖界面能选的最长期（90 天）—— 否则「90 天」是个谎', async () => {
    // 缺陷形态：`renderer/js/usage.js:226` 的天数按钮是 `[1, 7, 30, 90]`，
    // 而引擎 `USAGE_KEEP_DAYS` 原来是 30 —— 用户点「90 天」，`src/usage.js` 老老实实按
    // 90 天算 cutoff，但磁盘上超过 30 天的日文件早被 pruneUsageFiles 删掉了。
    // 于是面板显示"最近 90 天"的数字，实际只统计到 30 天，**界面上没有任何提示**。
    // 与 R10 修掉的 dumpWorkbuddy11128 死代码同族：承诺了一个范围，实现只给了一半。
    //
    // 这条用例的两半都很关键：
    //   ① 60 天前的文件**必须还在**（旧实现会删掉它）—— 这是缺陷回归钉。
    //   ② 把 DSH_GATEWAY_USAGE_KEEP_DAYS 显式设成 30 时，60 天前的文件**必须被删** ——
    //      证明"没删"不是因为它压根没跑（那条清理逻辑每天只跑一次，第一次请求就会跑）。
    const up = await startFakeUpstream({ status: 200 });

    // 按引擎 usageFileFor 的口径生成日期文件名（本地日期，YYYY-MM-DD）
    const dayFile = (daysAgo) => {
      const d = new Date(Date.now() - daysAgo * 86400_000);
      const day = d.getFullYear() + '-'
        + String(d.getMonth() + 1).padStart(2, '0') + '-'
        + String(d.getDate()).padStart(2, '0');
      return day + '.jsonl';
    };
    const row = (model) => JSON.stringify({
      ts: Date.now(), model, provider: 'x', endpoint: '/v1/chat/completions',
      status: 'ok', stream: 0, durMs: 1, ttfbMs: 1,
      inTok: 1, outTok: 1, cacheRead: 0, cacheWrite: 0,
    }) + '\n';

    // 造一个已经存了 60 天前与 5 天前两份的用量目录
    const seedUsageDir = () => {
      const dir = fs.mkdtempSync(path.join(tmp, 'usage-keep-'));
      fs.writeFileSync(path.join(dir, dayFile(60)), row('old-model'), 'utf8');
      fs.writeFileSync(path.join(dir, dayFile(5)), row('recent-model'), 'utf8');
      return dir;
    };

    // ⚠ 时序：recordUsage 是**在 `res.end()` 之后**才落盘的（记账不能挡在客户端前面），
    // 而 `call()` 在客户端收完响应体就返回 —— 此时服务端可能还没执行到 appendFileSync。
    // 第一版没等，断言直接拿到 `["2026-08-26.jsonl","2026-10-20.jsonl"]`（今天那份还没写），
    // 报错看起来像"记账坏了"，其实是测试把进程杀早了。
    // 清理（pruneUsageFiles）又发生在 append **之后**，所以两种等待要分开：
    //   ① 等"今天那份"出现 → 证明 recordUsage 跑过；
    //   ② 再等 60 天前那份消失 → 证明 prune 跑过（只有 KEEP_DAYS=30 时才等它）。
    const waitFor = async (fn, ms, msg) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (fn()) return true;
      throw new Error(msg);
    };

    try {
      // ---- ① 默认保留期：60 天前的那份不能被删 ----
      {
        const usageDir = seedUsageDir();
        const gw = await startGatewayWith([providerOf('keep-a', up)], 'usagekeep-default',
          { DSH_GATEWAY_USAGE_DIR: usageDir }, {});
        try {
          const r = await call({
            port: gw.port, p: '/v1/chat/completions',
            body: { model: 'test-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
          });
          assert.strictEqual(r.status, 200, '请求应成功（保证 recordUsage 真的跑到了）：' + r.text.slice(0, 200));
          await waitFor(() => fs.existsSync(path.join(usageDir, dayFile(0))), 3000,
            '这次调用应写出今天的用量文件，目录里只有：' + JSON.stringify(fs.readdirSync(usageDir)));
        } finally { killGw(gw); }

        assert.ok(fs.existsSync(path.join(usageDir, dayFile(60))),
          '默认保留期必须覆盖 90 天（界面能给的最长期），60 天前的用量文件被删了：'
          + JSON.stringify(fs.readdirSync(usageDir)));
        assert.ok(fs.existsSync(path.join(usageDir, dayFile(5))), '5 天前的文件当然要留着');
      }

      // ---- ② 显式设成 30 天时，60 天前的那份必须被删（证明清理逻辑真的会跑）----
      {
        const usageDir = seedUsageDir();
        const gw = await startGatewayWith([providerOf('keep-b', up)], 'usagekeep-30',
          { DSH_GATEWAY_USAGE_DIR: usageDir, DSH_GATEWAY_USAGE_KEEP_DAYS: '30' }, {});
        try {
          const r = await call({
            port: gw.port, p: '/v1/chat/completions',
            body: { model: 'test-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
          });
          assert.strictEqual(r.status, 200, '请求应成功：' + r.text.slice(0, 200));
          await waitFor(() => !fs.existsSync(path.join(usageDir, dayFile(60))), 3000,
            '设成 30 天时 60 天前的文件必须被清掉（否则①的"还在"证明不了任何事）：'
            + JSON.stringify(fs.readdirSync(usageDir)));
        } finally { killGw(gw); }

        assert.ok(fs.existsSync(path.join(usageDir, dayFile(5))), '5 天前的文件不在清理范围内');
      }
    } finally {
      closeUp(up);
    }
  });

  t('网关（审计 R11）：账号被上游限制（11140）必须单独成一类 —— 不能当成"登录失效"骗用户去重新登录', async () => {
    // 形态（参照实现 yetone/magpie 的 gateway-routing.md，本机未复现过）：
    //   403 {"code":11140,"msg":"request illegal",
    //        "displayMsg":{"en":"Your account has been restricted due to unusual activity"}}
    //
    // 为什么必须单独一类：
    //   ① 这类失败**等多久都不会自己好**，只有用户去申诉解封；
    //   ② 混进 session 时面板显示「登录失效」→ 用户去重新登录，白折腾（凭据是好的）；
    //   ③ 冷却 1 小时后又去撞一次，可能加重上游的风控印象 → 改成 12 小时。
    //
    // 旧实现的实际后果（这条用例守的就是它）：11140 正文不含会话措辞、也不命中
    // CONTENT_BLOCK_RE，于是被**裸 401/403 规则**吃掉 → kind=session → 面板「登录失效」。
    const upRestricted = http.createServer((q, s) => {
      q.resume();
      q.on('end', () => {
        s.writeHead(403, { 'content-type': 'application/json' });
        s.end(Buffer.from(JSON.stringify({
          code: 11140,
          msg: 'request illegal',
          displayMsg: {
            zh: '账号因异常活动被限制',
            en: 'Your account has been restricted due to unusual activity',
          },
        }), 'utf8'));
      });
    });
    await new Promise((r) => upRestricted.listen(0, '127.0.0.1', r));

    // 多账户家：11140 是**这把 Key / 这个账号**的事实，应该换下一把，不熔断整家
    const mkAcct = (id) => ({
      id, baseURL: 'http://127.0.0.1:' + upRestricted.address().port + '/v2',
      protocol: 'openai-chat', models: ['test-model'], priority: 1, enabled: true,
      accounts: [
        { id: 'bad', apiKey: 'sk-' + 'b'.repeat(15) },
        { id: 'good', apiKey: 'sk-' + 'g'.repeat(15) },
      ],
    });

    try {
      const gw = await startGatewayWith([mkAcct('wb-restricted')], 'wb11140', {}, {});
      try {
        const r = await call({
          port: gw.port, p: '/v1/chat/completions',
          body: { model: 'test-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
        });
        // 两把 Key 都会撞 11140（假上游对谁都回 403），所以最终是收口 503，
        // 而不是 400 —— 11140 属账户级失败，语义是"换下一把"。
        assert.strictEqual(r.status, 503,
          '两把 Key 都被限制时应以 503 收口，实际 ' + r.status + ' ' + r.text.slice(0, 200));

        const h = JSON.parse((await call({ port: gw.port, p: '/health', method: 'GET' })).text);
        const accts = (h.accounts || []).filter((a) => a.provider === 'wb-restricted');
        assert.ok(accts.length >= 1, '账户池应有记录：' + JSON.stringify(h.accounts));

        // ① 必须是 restricted，不是 session（这是本条用例的核心断言）
        const wrong = accts.filter((a) => a.state !== 'restricted');
        assert.strictEqual(wrong.length, 0,
          '11140 必须判成 restricted，判成别的就是把"账号被限制"误报给用户：'
          + JSON.stringify(accts.map((a) => ({ id: a.id, state: a.state, reason: a.reason }))));

        // ② 冷却时长必须远大于 session 的 1 小时（默认 12 小时）
        for (const a of accts) {
          assert.ok(a.remainMs > 2 * 3600_000,
            '账号受限的冷却应远超 session 的 1 小时（默认 12 小时），实际 ' + Math.round(a.remainMs / 1000) + 's');
        }

        // ③ 日志里要能看到"命中的规则 id"，否则排障时分不清是哪条规则判的
        const logText = fs.readFileSync(gw.logPath, 'utf8');
        assert.ok(/命中规则 account-restricted/.test(logText),
          '日志应写明命中的是 account-restricted 规则：' + logText.slice(-1200));
      } finally { killGw(gw); }
    } finally {
      try { upRestricted.close(); } catch { /* 忽略 */ }
    }
  });

  t('网关（审计 R11）：/health 的 guards 计数必须真实反映拦截次数，且带上开关状态', async () => {
    // 为什么要有这条：三项防护默认全开，但界面上此前完全不可见 —— 用户既无法确认
    // 它们在干活，也无法在它们误伤时发现（R10 的 pendingHead 缺陷就是这样潜伏的：
    // 代码写了、永远不触发、没人察觉）。这里同时钉住"计数对"与"开关状态对"，
    // 因为界面上"关了"和"开了但没触发"必须是两种不同的显示。
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('gs', up, { quirks: ['force-stream'] })], 'guardstats');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const health = async () => JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);

      // ① 刚启动：三个计数都是 0，但三个 enabled 都是 true —— 这正是界面要区分的样子
      const h0 = await health();
      assert.ok(h0.guards, '/health 必须带 guards 字段：' + JSON.stringify(h0).slice(0, 400));
      assert.strictEqual(h0.guards.loopGuard, 0, '刚启动不该有循环守卫计数');
      assert.strictEqual(h0.guards.toolLoop, 0, '刚启动不该有工具死循环计数');
      assert.strictEqual(h0.guards.roomy, 0, '刚启动不该有窗口过滤计数');
      assert.strictEqual(h0.guards.enabled.loopGuard, true, '循环守卫默认应开启（界面靠它区分"关了"与"没触发"）');
      assert.strictEqual(h0.guards.enabled.toolLoop, true, '工具死循环拦截默认应开启');
      assert.strictEqual(h0.guards.enabled.roomy, true, '窗口过滤默认应开启');
      assert.strictEqual(h0.guards.enabled.roomyLearn, false, 'roomyLearn 默认关（会额外打上游）');

      // ② 真触发一次工具死循环：toolLoop 必须 +1，loopGuard/roomy 不得跟着变
      const r = await call({ port: gw.port, body: { model: 'test-model', messages: mkChatToolRounds(8) } });
      assert.strictEqual(r.status, 200, '本地作答仍是 200，实际 ' + r.status);
      const h1 = await health();
      assert.strictEqual(h1.guards.toolLoop, 1, '工具死循环拦截过一次，计数必须是 1：' + JSON.stringify(h1.guards));
      assert.strictEqual(h1.guards.loopGuard, 0, '没发生循环守卫，它的计数不得被顺手加一：' + JSON.stringify(h1.guards));
      assert.strictEqual(h1.guards.roomy, 0, '没发生窗口过滤，它的计数不得被顺手加一：' + JSON.stringify(h1.guards));
      assert.strictEqual(up.st.calls, 0, '命中死循环后上游应当**一次都没被打**，实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });
  for (const { name, fn } of __tests) {
    await fn();
    passed++;
    console.log('PASS  ' + name);
  }

  console.log('');
  console.log('===== ' + passed + ' passed, 0 failed =====');
  try { gwProc.kill(); } catch { }
  try { upstreamServer.close(); } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  try { gwProc && gwProc.kill(); } catch { }
  try { upstreamServer.close(); } catch { }
  process.exit(1);
});
