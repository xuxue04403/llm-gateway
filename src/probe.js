// probe.js — 供应商连通性探测（直连 / 走 HTTP 代理隧道，零依赖）
//
// 为什么需要：网关用户最常问的两句话是"这家到底通不通"和"是 key 的问题还是网络的问题"。
// 引擎只在**真实请求**发生时才暴露上游状态（而且失败会被熔断/切换掩盖），界面无从回答。
// 这里做一次**与网关同规则的轻量探测**：GET <baseURL>/models，看得到 HTTP 状态码与耗时。
//
// 为什么不复用 fetch：Node ≥24 的 env-proxy 支持只在**进程启动时**读 NODE_USE_ENV_PROXY，
// 运行期再设环境变量对全局 dispatcher 无效；而主进程又不能为了探测去改全局代理状态
// （会连带影响窗口自身的网络）。所以这里自己实现一个最小可用的代理通道：
//   · http 目标  → 直接向代理发**绝对 URI** 形式的请求（RFC 7230 §5.3.2，clash 等都支持）；
//   · https 目标 → 先 CONNECT 建隧道，再在隧道上做 TLS。
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

/** 规范化 baseURL：允许不带 /vN（补 /v1），带其它后缀则收敛到 /vN。与引擎 upstreamBase 同规则。 */
function upstreamBase(baseURL) {
  let b = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!b) return b;
  const m = b.match(/\/(v\d+)(?:\/.*)?$/i);
  if (m) return b.slice(0, b.length - m[0].length + m[1].length + 1);
  return b + '/v1';
}

function hostInList(host, list) {
  const h = String(host || '').toLowerCase();
  return (list || []).some((entry) => {
    const e = String(entry || '').trim().toLowerCase().replace(/^\./, '');
    if (!e) return false;
    return h === e || h.endsWith('.' + e);
  });
}

/** 在代理上开一条到 targetHost:targetPort 的 CONNECT 隧道，回传裸 socket。 */
function connectViaProxy(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = new URL(proxyUrl.includes('://') ? proxyUrl : 'http://' + proxyUrl); } catch (e) {
      return reject(new Error('代理地址无法解析：' + proxyUrl));
    }
    const proxyPort = Number(p.port) || (p.protocol === 'https:' ? 443 : 80);
    const sock = net.connect({ host: p.hostname, port: proxyPort });
    let done = false;
    const fail = (e) => { if (!done) { done = true; try { sock.destroy(); } catch (_) { /* 忽略 */ } reject(e); } };
    sock.setTimeout(timeoutMs || 12000, () => fail(new Error('连接代理超时')));
    sock.on('error', (e) => fail(new Error('连接代理失败：' + (e && e.message ? e.message : e))));
    sock.on('connect', () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) { if (buf.length > 8192) fail(new Error('代理响应异常')); return; }
      sock.removeListener('data', onData);
      sock.setTimeout(0);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      const code = m ? Number(m[1]) : 0;
      if (code !== 200) return fail(new Error('代理拒绝 CONNECT：HTTP ' + (code || '?') + '（请检查代理类型/是否需要认证）'));
      done = true;
      resolve(sock);
    };
    sock.on('data', onData);
  });
}

/**
 * 发一次 GET，返回 { ok, status, ms, body, error, via }。
 * body 最多读 limit 字节。
 */
function getJson(urlStr, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 12000;
  const limit = o.limit || 64 * 1024;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, error: 'URL 非法：' + urlStr }); }
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const headers = Object.assign({ accept: 'application/json' }, o.headers || {});
    if (o.apiKey) headers.authorization = 'Bearer ' + o.apiKey;

    // baseURL 里可能带 userinfo（`https://user:token@host/v1`）——校验器允许这种写法。
    // 两条路径要分别处理（旧实现在两条路上都是错的，实测）：
    //   · 直连：必须转成 `auth` 选项（Node 会发 Authorization: Basic），否则凭据被静默丢弃
    //     → 用户看到 401 却完全不知道为什么；
    //   · 走代理：必须从请求行里**剔除** userinfo，否则 token 明文出现在
    //     `GET http://user:token@host/… HTTP/1.1` 里，白白暴露给代理。
    const hasUserinfo = !!(u.username || u.password);
    const basicAuth = hasUserinfo
      ? decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)
      : undefined;
    const bareUrl = u.origin + u.pathname + u.search;

    const useProxy = !!o.proxy
      && !hostInList(u.hostname, ['127.0.0.1', 'localhost', '::1'])
      && !hostInList(u.hostname, o.noProxy || []);
    const via = useProxy ? '代理' : '直连';

    const base = {
      method: o.method === 'POST' ? 'POST' : 'GET',
      headers,
      timeout: timeoutMs,
    };
    let reqOpts;
    if (useProxy && !isHttps) {
      // http 目标走代理：绝对 URI 形式直接发给代理
      const p = new URL(o.proxy.includes('://') ? o.proxy : 'http://' + o.proxy);
      reqOpts = Object.assign({}, base, {
        host: p.hostname,
        port: Number(p.port) || 80,
        path: bareUrl,                       // 不含 userinfo
        headers: Object.assign({ host: u.host }, headers),
      });
    } else {
      reqOpts = Object.assign({}, base, {
        host: u.hostname,
        port,
        path: u.pathname + u.search,
      });
      if (basicAuth) reqOpts.auth = basicAuth;   // 直连时把凭据真正带上
      if (useProxy && isHttps) {
        reqOpts.createConnection = (opts2, cb) => {
          connectViaProxy(o.proxy, u.hostname, port, timeoutMs)
            .then((sock) => cb(null, tls.connect({ socket: sock, servername: u.hostname })))
            .catch((e) => cb(e));
        };
      }
    }

    const t0 = Date.now();
    const mod = (useProxy && !isHttps) ? http : (isHttps ? https : http);
    let req;
    const finish = (obj) => resolve(Object.assign({ ms: Date.now() - t0, via }, obj));
    try {
      req = mod.request(reqOpts, (res) => {
        let body = '';
        let bytes = 0;                 // 已累计的**字节**数
        let truncated = false;
        res.setEncoding('utf8');
        res.on('data', (c) => {
          // ⚠ 上限必须是**字节**上限，不能按 `body.length`（UTF-16 码元数）算。
          // `res.setEncoding('utf8')` 之后 `body.length` 是字符数，一个汉字算 1，
          // 但实际传输是 3 字节 —— 实测 limit=1024 收到 1024 个汉字 = 3040 字节（2.97×），
          // limit=4096 收到 12256 字节（2.99×）。而本文件上面写着"上限必须是真的上限"。
          // 影响：`gw:fetch-models` 的 4MB 上限对 CJK 目录实际可到 ~12MB；
          // 且会在字节数没超时就置 `truncated`。
          //
          // 同时仍要**按剩余额度切片**：上游一次 write 可以吐 ~64KB，
          // 只判 `bytes < limit` 就整块追加的话，limit=1024 会收到 60 多倍。
          if (bytes >= limit) { truncated = true; return; }
          const room = limit - bytes;
          const cb = Buffer.byteLength(c, 'utf8');
          if (cb > room) {
            // 按字节截断，再按字符边界收尾（不让多字节字符被劈成半个 → 避免替换字符）
            let s = Buffer.from(c, 'utf8').slice(0, room).toString('utf8');
            if (s.endsWith('\uFFFD')) s = s.slice(0, -1);
            body += s;
            bytes += Buffer.byteLength(s, 'utf8');
            truncated = true;
          } else {
            body += c;
            bytes += cb;
          }
        });
        res.on('end', () => finish({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body,
          bytes,
          truncated,
        }));
        res.on('error', (e) => finish({ ok: false, error: String(e && e.message) }));
      });
    } catch (e) {
      return resolve({ ok: false, via, ms: Date.now() - t0, error: String(e && e.message ? e.message : e) });
    }

    // ⚠ 必须**显式**给请求挂超时，不能只依赖 `timeout: timeoutMs` + `req.on('timeout')`。
    //
    // 实测（HTTPS 目标经自定义 createConnection 建隧道）：`https.request({timeout})` 在这条
    // 路径上**不会**给 socket 挂 setTimeout —— 建完隧道后 `req.socket.timeout === undefined`，
    // 于是 `req.on('timeout')` 是**死代码**。后果是"代理 CONNECT 成功但 TLS 数据不回来"
    // （恶意/黑洞/TLS-only 代理）时 Promise 永不 settle：界面"测试连通性"永久转圈、
    // 每挂一次泄漏一条 TCP+TLS 句柄，而 gw:test-providers 是串行遍历最多 40 家的。
    // 手动 setTieout 已被实测证明有效（直连路径本来就有超时，两者现在一致）。
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(); } catch (_) { /* 忽略 */ }
      finish({ ok: false, error: '超时 ' + timeoutMs + 'ms' });
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) { /* 忽略 */ }
      finish({ ok: false, error: '超时 ' + timeoutMs + 'ms' });
    });
    req.on('error', (e) => finish({ ok: false, error: String(e && e.message ? e.message : e) }));
    // POST 体（测速要发一次最小 chat 请求）。Content-Length 必须显式给，
    // 否则 Node 会走 chunked，而部分中转对 chunked 处理不好。
    if (reqOpts.method === 'POST' && o.body !== undefined) {
      const payload = Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body), 'utf8');
      req.setHeader('content-type', 'application/json');
      req.setHeader('content-length', payload.length);
      req.end(payload);
    } else {
      req.end();
    }
  });
}

/**
 * 探测一个供应商是否可达 + 凭据是否被接受。
 *
 * @param {object} provider - 网关配置里的供应商条目
 * @param {object} ctx - { proxy, noProxy[], timeoutMs }
 * @returns {Promise<object>} 结构化结果（含人话结论）
 */
async function probeProvider(provider, ctx) {
  const o = ctx || {};
  const id = String(provider && provider.id || '?');
  const raw = String(provider && provider.baseURL || '').trim();
  if (!raw) return { id, ok: false, verdict: '配置里没有 baseURL', error: 'missing baseURL' };
  if (String(provider.auth || '').toLowerCase() === 'workbuddy') {
    return {
      id, ok: null, skipped: true,
      verdict: 'WorkBuddy 供应商用桌面客户端凭据（authFile）鉴权，不走 API Key——请改用 /health 的账户池状态判断',
    };
  }
  const base = upstreamBase(raw);
  const key = String(provider.apiKey || '').trim()
    || (Array.isArray(provider.apiKeys) ? String(provider.apiKeys[0] || '').trim() : '');

  // 供应商条目可声明 proxy:false / noProxy:true → 该家直连
  const directOnly = provider.proxy === false || provider.noProxy === true;
  const res = await getJson(base + '/models', {
    apiKey: key,
    proxy: directOnly ? null : o.proxy,
    noProxy: o.noProxy || [],
    timeoutMs: o.timeoutMs || 12000,
  });

  if (!res.status) {
    return {
      id, ok: false, via: res.via, ms: res.ms,
      baseUrl: base,
      verdict: `连不上（${res.via}）：${res.error}`,
      hint: /ENOTFOUND|EAI_AGAIN/.test(String(res.error)) ? '域名解析失败——检查 baseURL 是否写错'
        : /ECONNREFUSED|ETIMEDOUT|超时/.test(String(res.error)) ? '该地址不可达——若这家需要代理，请在「设置 → 网络代理」里启用并填地址'
          : '',
    };
  }

  let modelCount = null;
  let sample = [];
  try {
    const j = JSON.parse(res.body);
    const arr = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : null);
    if (arr) { modelCount = arr.length; sample = arr.slice(0, 5).map((m) => String(m && (m.id || m.name) || '')); }
  } catch (_) { /* 不是 JSON：下面按状态码给结论 */ }

  let verdict;
  let ok = res.ok;
  if (res.status === 401 || res.status === 403) {
    verdict = `凭据被拒绝（HTTP ${res.status}）——这一家的 API Key 不对或没有权限`;
    ok = false;
  } else if (res.status === 404) {
    verdict = `HTTP 404 —— 该地址没有 /models 端点（有些中转不提供）；**这不一定代表不可用**，请以网关日志里的真实调用结果为准`;
    ok = null;
  } else if (res.status >= 500) {
    verdict = `上游故障（HTTP ${res.status}）`;
    ok = false;
  } else if (res.ok) {
    verdict = modelCount === null
      ? `可达（HTTP ${res.status}，${res.ms}ms）`
      : `可达且凭据有效（HTTP ${res.status}，${res.ms}ms，目录 ${modelCount} 个模型）`;
  } else {
    verdict = `HTTP ${res.status}（${res.ms}ms）`;
    ok = false;
  }

  return {
    id, ok, via: res.via, ms: res.ms, status: res.status, baseUrl: base,
    modelCount, sample, verdict,
  };
}

module.exports = { probeProvider, getJson, upstreamBase, hostInList, connectViaProxy };
