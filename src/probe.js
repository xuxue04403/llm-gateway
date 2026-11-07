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
  // ⚠ Codex 订阅后端**不能**补 `/v1` —— 与引擎里的同名函数是同一条规则，
  // 两处必须一致（这里是主进程用的副本，引擎是子进程里的另一份）。
  // 实测：不处理时探测会拼成 `/backend-api/codex/v1/responses` → 404，
  // 「测试」把一家**能用**的供应商报成失败。
  // 后端很严格：/backend-api/codex/responses → 200；带 /v1 → 404。
  if (/\/codex$/i.test(b)) return b;
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
    let hardTimer = null;
    // ⚠ 这两个必须是**外层**变量，不能藏在下面的响应回调里。
    //
    // 旧实现把 `bytes` 声明在 `mod.request(...)` 的响应回调内部，而墙钟兜底
    //（`hardTimer`）在外层 —— 它**根本读不到** `bytes`，于是无论实际收没收到数据，
    // 一律打印"对端持续有数据流入但始终读不完"（旧文案）。实测（2026-10-27 全量复核）：
    // 打 nvidia / h-e.top / windhub 的超时用例 `bytes=0`（一个字节都没来），
    // 报错却断言"持续有数据流入" —— 排查时按这个文案去找"上游在流式吐垃圾"，
    // 方向直接跑偏（这次就是这样被带偏的）。
    // 超时报错必须只说**它量到的事实**：收没收到响应头、收了多少字节。
    let gotHeaders = false;
    let gotBytes = 0;
    // finish 现在负责清掉下面的绝对墙钟。`resolve` 天然幂等，重复调用无副作用。
    const finish = (obj) => {
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
      resolve(Object.assign({ ms: Date.now() - t0, via }, obj));
    };
    try {
      req = mod.request(reqOpts, (res) => {
        gotHeaders = true;
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
          gotBytes = bytes;
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
    // ⚠⚠ **绝对墙钟**兜底（与"有没有数据在流"无关）。
    //
    // 上面那个 `req.setTimeout` 是**不活动**超时：任何一次 `res.on('data')` 都会重置它。
    // 于是对端只要每隔 < timeoutMs 吐一个**字节**，这个 Promise 就永不 settle ——
    // 实测（2026-10-08 审计）：timeoutMs=500 的情况下一路读到 4 秒仍未返回，
    // 而"连上后不发数据"的对照组如期 504ms 超时。
    // 后果有三个，都不轻：
    //   ① 「测试全部连通性」的 90 秒预算只在**两次探测之间**检查，管不了正在飞行的这一次；
    //   ② 「⚡一键获取全部模型」的按钮靠 finally 复位 `disabled`，永不复位；
    //   ③ 每挂死一次泄漏一条 TCP/TLS 句柄。
    // 这里补一个不看数据流的截止时间。+500ms 是留给"刚好卡在边界上的正常慢响应"。
    // ⚠ 超时归因**只在一处**产生（下面是 timeoutText()），所有分支共用。
    //
    // 旧实现有两个失败出口，文案各写各的：墙钟那条带了一大段归因（而且是凭空断言的），
    // `req.setTimeout` / `req.on('timeout')` 这两条只写 `超时 600ms`。
    // 后果实测（2026-10-27 复核）：连"响应头都不回"的服务端走的是**不活动超时**分支，
    // 于是最需要归因的那种情形（上游根本不回话）反而只得到一句光秃秃的"超时 600ms"。
    // 三条出口现在共用同一个函数，不会再出现"有的情形有归因、有的没有"。
    const timeoutText = (elapsed) => {
      const state = !gotHeaders
        ? '连响应头都没收到（上游或代理没有回话）'
        : (gotBytes === 0
          ? '收到响应头但一个字节的响应体都没来（上游接了单却不回内容）'
          : `已收到 ${gotBytes} 字节但始终读不完`);
      return `超时 ${elapsed}ms：${state}`;
    };

    hardTimer = setTimeout(() => {
      try { req.destroy(); } catch (_) { /* 忽略 */ }
      // 报**实际经过时间**：写 timeoutMs 会和界面「测试连通性」里显示的耗时对不上
      //（实测：文案说 2500ms，用户看到 3008ms），排查时会以为是两回事。
      //
      // 三种情况的处置方向完全不同，绝不能混成一句话：
      //   · 连响应头都没来 → 上游/代理没回话，可能是网络、黑洞、TLS 后无响应；
      //   · 头来了但 0 字节 → 上游接了单在"思考"或者干脆不回，**不是**在流式吐数据；
      //   · 头来了且有字节 → 数据在流但读不完（这才是旧文案描述的场景，也是唯一适用的场景）。
      finish({ ok: false, error: '（整体墙钟）' + timeoutText(Date.now() - t0) });
    }, timeoutMs + 500);
    if (hardTimer && typeof hardTimer.unref === 'function') hardTimer.unref();

    req.setTimeout(timeoutMs, () => {
      try { req.destroy(); } catch (_) { /* 忽略 */ }
      finish({ ok: false, error: timeoutText(Date.now() - t0) });
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) { /* 忽略 */ }
      finish({ ok: false, error: timeoutText(Date.now() - t0) });
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

// ── 失败归因 ────────────────────────────────────────────────────────────────
//
// 「测试」按钮要回答的其实是三个**不同**的问题：
//   ① 这台机器能不能连上这家（网络/代理）；
//   ② 这把凭据能不能用（401/403）；
//   ③ 这个模型对这个账号能不能用（模型级/策略级限制）。
// 旧实现只分"通/不通"，把 ②③ 和限流全都算成"凭据不可用"，于是把**能用**的家报成红的。
// 实测（2026-11-03 用户反馈 + 逐家复核）：
//   · sensenova：两把 Key 都回 `429 inference exceeds tpm/rpm limit` —— Key 明明是好的，
//     只是被限流了；报成"2 把被拒"会让用户去换 Key，方向完全错；
//   · cline：`403 … is only available via Cline product surfaces` —— 产品面限制，与凭据无关；
//   · x666 / windhub：`503 No available channel for model X under group Y` ——
//     该模型在这个账号的分组里没有渠道，**同一家的别的模型照样能用**（实测 37/37 成功）；
//   · 本机代理没开时：`connect ECONNREFUSED 127.0.0.1:7890` —— 是本机环境问题，
//     与供应商毫无关系，却被打成"连不上（代理）"的红色结论。
// 这四类必须分开说，否则"测试"比不测更误导。
const RATE_LIMIT_RE = /(?:\b429\b|rate limit|rate-limit|tpm|rpm|too many requests|concurrenc|exceeds .{0,24}limit|限流|请求过于频繁)/i;
const MODEL_SCOPED_RE = new RegExp([
  'not found for account',
  'not found for',
  'model.*not.*(?:support|available|found)',
  'no available channel',            // new-api / one-api 系：分组里没有这个模型的渠道
  'under group',
  'free tier',
  'contributor',
  'only available via',              // cline：只在自家产品面可用
  'product surface',
  'not available in the current token plan',  // sensenova 系：当前套餐不含该模型
  'deprecated',
  'ModelDeprecated',
  'ModelProtocolUnsupported',
  'MissingSessionID',
].join('|'), 'i');
// 代理连不上：这是**本机**的事，绝不能算到供应商头上。
const PROXY_DOWN_RE = /连接代理失败|连接代理超时|代理拒绝 CONNECT|代理地址无法解析/;

/**
 * 这次失败是不是"代理那条腿断了"。
 *
 * ⚠ 判据的核心是：**走代理时，TCP 连的是代理**，所以 `ECONNREFUSED`/`ETIMEDOUT`
 * 这类传输层错误必然是代理侧的问题（代理开着但目标不通时，代理会回一个 HTTP 502，
 * 那种情况有 status，不会走到这里）。旧实现只认自造的"连接代理失败"文案，
 * 于是 http 目标走代理失败时会包装成一句 `connect ECONNREFUSED 127.0.0.1:7890`，
 * 被判成"供应商连不上"（实测 2026-11-03）。
 */
/**
 * 「代理侧自己就连不上」的判据（与"代理通了、目标没回话"必须分开）。
 *
 * 2026-11-03 实测踩坑：nvidia 走代理时**探测超时**，旧判据把任何传输层错误都算
 * `proxyDown`，界面于是写「本机代理连不上 … 把代理开起来再测」—— 而代理明明是好的，
 * 用户被指去修一个没坏的东西。区分办法：
 *   · 连接代理本身被拒 / 代理拒绝 CONNECT / 代理地址解析不了 → **代理挂了**；
 *   · 隧道建好之后超时、被 RST、TLS 握手失败 → **上游/链路的问题**，代理没坏。
 */
function proxyLinkDown(errorText) {
  const s = String(errorText || '');
  if (PROXY_DOWN_RE.test(s)) return true;
  return /ECONNREFUSED|EAI_AGAIN|ENOTFOUND/i.test(s);
}

function isProxyFailure(r) {
  if (!r || r.via !== '代理' || r.status) return false;
  return proxyLinkDown(r.error);
}

/** 把一次失败的生成请求归因：conn / proxy / rate / model / cred / pay / busy / limit / other。 */
function classifyGenFailure(status, blob, via) {
  const s = String(blob || '');
  const code = Number(status) || 0;
  // 走代理时：只有"代理侧自己连不上"才算 proxy，隧道通了之后的超时/RST 算 conn。
  // 直连时 ECONNREFUSED 是目标端口不通，仍是 conn。文案自带"连接代理失败"的直接认。
  if (!status) return (PROXY_DOWN_RE.test(s) || (via === '代理' && proxyLinkDown(s))) ? 'proxy' : 'conn';
  // 试生成被"输出额度"卡住 —— 这是我们发 `max_tokens:16` 的副作用（带推理的模型会把它
  // 全花在思考上），不是凭据问题，也不是渠道问题。必须排在 429/模型级之前判，
  // 因为上游常把它写在 400 里，旧实现会落到 `upstream` → 整家报红。
  if (/max_tokens or model output limit|max_output_tokens|model output limit was reached/i.test(s)) return 'limit';
  if (code === 429 || RATE_LIMIT_RE.test(s)) return 'rate';
  // 模型级限制要排在 401/403 之前：上游常把"这个模型对你的套餐不可用"写成 403
  //（实测 cline `only available via Cline product surfaces`、sensenova `model is not
  // available in the current token plan`）—— 判成凭据问题会让人白换 Key。
  if (MODEL_SCOPED_RE.test(s)) return 'model';
  // 凭据类：401/403 且没有命中模型级文案 → 这才是"该换 Key"。
  if (code === 401 || code === 403) return 'cred';
  // 402 / 余额为 0 / 额度耗尽 —— 真·用不了（换 Key 或充值才解决），判红是对的。
  if (code === 402 || /insufficient balance|insufficient credit|quota exceeded|exceeded your current quota|余额不足|额度已用尽|欠费/i.test(s)) return 'pay';
  // 5xx / "繁忙"：上游过载、维护、临时无渠道 —— 换一刻钟再试就好，不能判成"这家不可用"。
  // 实测 gemini 2026-11-03：503 `This model is currently experiencing high demand`。
  if (code >= 500 || /high demand|overloaded|temporarily unavailable|service unavailable|try again later|请稍后重试/i.test(s)) return 'busy';
  return 'other';
}

/** 每种归因对应的一句人话（`ok` 语义：true 可用 / false 不可用 / null 判不出来）。 */
function kindOfGen(kind) {
  if (kind === 'rate') return { ok: null, label: '被限流（TPM/RPM）' };
  if (kind === 'model') return { ok: null, label: '该模型对这个账号不可用' };
  if (kind === 'proxy') return { ok: null, label: '本机代理连不上' };
  if (kind === 'conn') return { ok: null, label: '连接失败' };
  if (kind === 'limit') return { ok: null, label: '试生成被输出额度卡住（模型把 token 花在推理上）' };
  if (kind === 'busy') return { ok: null, label: '上游繁忙/临时故障' };
  if (kind === 'other') return { ok: null, label: '没看懂原因的拒绝（请以真实调用为准）' };
  if (kind === 'pay') return { ok: false, label: '余额/额度不足' };
  return { ok: false, label: '凭据被上游拒绝' };
}

/**
 * 多 Key 体检结果的聚合（纯函数 —— 逻辑都在这里，主进程只负责发请求）。
 *
 * ⚠ 必须分清三档，否则会把能用的家报成红的（实测 2026-11-03）：
 *   · `ok === true`  —— 真的出字了；
 *   · `ok === false` —— 上游**因凭据**拒绝（401/403 之类）→ 这才是"该换 Key"；
 *   · `ok === null`  —— 判不出来：限流（429 tpm/rpm）、模型级限制、本机代理没开、超时。
 * sensenova 现场：两把 Key 都回 `429 inference exceeds tpm/rpm limit`，
 * 旧实现归到"被拒"→ 界面写「0 把可用于生成，2 把被拒」→ 用户去换 Key 换到天亮也没用。
 *
 * @param {number} total  Key 总数
 * @param {Array} rows    每把的结果 [{index,status,ms,ok,kind,err,skipped}]
 * @param {number|null} modelCount 目录里的模型数（可为 null）
 * @returns {{ok: boolean|null, keySummary: string, verdict: string}}
 */
function summarizeKeyResults(total, rows, modelCount) {
  const tested = (Array.isArray(rows) ? rows : []).filter((x) => x && !x.skipped);
  const good = tested.filter((x) => x.ok === true);
  const bad = tested.filter((x) => x.ok === false);
  const throttled = tested.filter((x) => x.ok === null && x.kind === 'rate');
  const unknown = tested.filter((x) => x.ok === null && x.kind !== 'rate');
  const list = (arr) => arr.map((x) => x.index).join('、');
  const parts = [`${total} 把 Key：${good.length} 把可用于生成`];
  if (throttled.length) parts.push(`${throttled.length} 把被限流（第 ${list(throttled)} 把：${throttled[0].err || 'TPM/RPM'}）`);
  if (bad.length) parts.push(`${bad.length} 把被拒（第 ${list(bad)} 把：${bad[0].err || 'HTTP ' + bad[0].status}）`);
  if (unknown.length) parts.push(`${unknown.length} 把无法判定（第 ${list(unknown)} 把：${unknown[0].err || '连接失败'}）`);
  const keySummary = parts.join('，');
  const catalog = modelCount === null || modelCount === undefined ? '?' : modelCount;

  if (good.length) {
    return { ok: true, keySummary, verdict: `凭据可用于生成（${keySummary}）；目录 ${catalog} 个模型` };
  }
  if (!bad.length && throttled.length && !unknown.length) {
    // 全部只是被限流：限流是**用量**问题，不是凭据坏了，也不是渠道坏了。
    return {
      ok: null, keySummary,
      verdict: `**${total} 把 Key 全部被限流**（TPM/RPM 或并发上限），不是凭据问题 —— 过一两分钟再测，或降低并发`,
    };
  }
  if (!bad.length) {
    return {
      ok: null, keySummary,
      verdict: `无法判定这几把 Key 是否可用（${keySummary}）—— 多是限流/连接/模型级限制，请以网关日志里的真实调用为准`,
    };
  }
  // 有 Key 被拒，但另外几把没测出结果（超时/限流/模型级）→ 只能说"这几把里有坏的"，
  // 不能断言"整家不可用"。实测 nvidia（2026-11-03）：4 把里 2 把 403、2 把超时，
  // 报成整家红是过度断言。
  if (throttled.length || unknown.length) {
    return {
      ok: null, keySummary,
      verdict: `**有 Key 确实被拒，但整家还不能判死** —— ${keySummary}。先把被拒的换掉，剩下的过一会儿再测`,
    };
  }
  return { ok: false, keySummary, verdict: `**${total} 把 Key 都无法生成** —— ${keySummary}` };
}

/**
 * 探测一个供应商是否可达 + 凭据是否被接受。
 *
 * @param {object} provider - 网关配置里的供应商条目
 * @param {object} ctx - { proxy, noProxy[], timeoutMs, genModel, genModels[], deepProbe, headers, genTimeoutMs }
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

  // ⚠ Codex 订阅供应商**可以**正常探测 —— 但要先把凭据读出来。
  //
  // 它的凭据在 `$CODEX_HOME/auth.json`（或 `~/.codex/auth.json`）里，配置里没有 Key。
  // 不处理的话 `provider.apiKey || apiKeys[0]` 是空串 → 带空 Bearer 打上游 → 401，
  // 「测试」会把一家**本来能用**的供应商报成"凭据被拒"。
  //
  // 这里只读文件、**不刷新**（刷新是引擎的职责，探测不该有副作用）——
  // 令牌过期时如实报"请先运行一次 Codex 让它刷新"，而不是伪造一个结论。
  //
  // ⚠⚠ 这段必须放在 `base` / `directOnly` **声明之后**。
  // 第一版放在了它们前面，直接 TDZ 崩：
  //   `Cannot access 'directOnly' before initialization`
  //（面板上表现为「内部错误（gw:test-providers）」）。
  // 同一个坑本轮已经踩过第二次（另一次是引擎里的 `isSseStream`）——
  // **在函数中间插代码时，先确认用到的每个变量都已声明。**
  if (String(provider.auth || '').toLowerCase() === 'codex') {
    const codexCred = readCodexCredForProbe();
    if (!codexCred.ok) return { id, ok: false, verdict: 'Codex 凭据不可用：' + codexCred.error };
    // Codex 后端**没有 /models 端点**（实测 GET /backend-api/codex/models → 404），
    // 所以不能走"先探目录再试生成"的常规流程 —— 直接做一次最小生成验证。
    // 判据与常规路径一致：只有真拿到 2xx 才算通过，并带出上游原文。
    const genModel = String(o.genModel || '').trim()
      || (Array.isArray(provider.models) ? String(
        (typeof provider.models[0] === 'string' ? provider.models[0] : (provider.models[0] || {}).id) || '') : '');
    if (!genModel) {
      return { id, ok: null, skipped: true, baseUrl: base, verdict: 'Codex 供应商没声明任何模型 —— 请先填模型（如 gpt-5.6-luna）再测试' };
    }
    const g = await probeOneKeyGen(provider, {
      key: codexCred.accessToken,
      model: genModel,
      path: '/responses',                       // Codex 的生成端点是 /responses（不带 /v1）
      proxy: directOnly ? null : o.proxy,
      noProxy: o.noProxy || [],
      timeoutMs: o.genTimeoutMs || 45000,
      headers: codexProbeHeaders(codexCred),
    });
    if (g.ok) {
      return { id, ok: true, ms: g.ms, status: g.status, baseUrl: base, modelCount: null, sample: [],
        verdict: `凭据可用于生成（试生成 ${genModel} 成功，HTTP ${g.status}，${g.ms}ms）` };
    }
    if (g.ok === null) {
      return { id, ok: null, ms: g.ms, status: g.status, baseUrl: base, modelCount: null, sample: [],
        verdict: `无法判定（${g.detail || '连接失败'}）—— 请以网关日志里的真实调用为准` };
    }
    return { id, ok: false, ms: g.ms, status: g.status, baseUrl: base, modelCount: null, sample: [],
      verdict: `试生成被拒（HTTP ${g.status}）：${g.detail}` };
  }

  const res = await getJson(base + '/models', {
    apiKey: key,
    headers: o.headers || undefined,   // 仿真头（cline 不带 Cline 头一律 403 这类）
    proxy: directOnly ? null : o.proxy,
    noProxy: o.noProxy || [],
    timeoutMs: o.timeoutMs || 12000,
  });

  if (!res.status) {
    // 代理自己连不上 ≠ 供应商不可用。这类结论必须给 **null**（界面黄色"判不出来"），
    // 否则用户会以为渠道坏了，去改配置、换 Key，全都没用 —— 真正要做的只是把代理开起来。
    if (isProxyFailure(res)) {
      return {
        id, ok: null, via: res.via, ms: res.ms, baseUrl: base, proxyDown: true,
        verdict: `本机代理连不上（${res.error}）—— 这是**本机网络环境**问题，不代表这家不可用：`
          + '代理没启动/端口写错/被防火墙挡住时都会这样。把代理开起来（或在这家条目里勾"直连"）再测一次。',
        hint: '检查「设置 → 网络代理」里的地址与端口，或在本供应商条目里声明 proxy:false 直连',
      };
    }
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
    // 目录端点 5xx 通常是临时过载/维护：判"判不出来"，别让一次抖动就把整家标红。
    verdict = `上游故障（HTTP ${res.status}）—— 多半是临时的（过载/维护），过几分钟再测`;
    ok = null;
  } else if (res.ok) {
    verdict = modelCount === null
      ? `可达（HTTP ${res.status}，${res.ms}ms）`
      : `可达，目录 ${modelCount} 个模型（HTTP ${res.status}，${res.ms}ms）`;
  } else {
    verdict = `HTTP ${res.status}（${res.ms}ms）`;
    ok = false;
  }

  // ⚠ 目录能读 **≠** 凭据能用于生成。
  //
  // 实测（2026-10-09，nvidia）：4 把 Key 打 `GET /v1/models` **全部 200**（含两把已失效的），
  // 而打 `POST /v1/chat/completions` 其中两把是 **403 `Authorization failed`**。
  // 目录端点只校验"Key 格式合法"，生成端点才校验真实权限/额度。
  //
  // ⚠⚠ 但**不能拿目录里第一个模型去试**。第一版实现就是这么干的，实测两处假失败：
  //   · nvidia：目录第一个是 `01-ai/yi-large` → 404
  //     `Function '01-ai/yi-large': Not found for account '…'` —— 那是**该模型对这个账号
  //     不可用**，与凭据无关；
  //   · opencode-zen：目录第一个是 `big-pickle` → 403
  //     `OpenCode's free tier can only be used from within OpenCode` —— 而这家的
  //     `space-bunny-free` 实测 200，属于**免费层的客户端校验**，同样与凭据无关。
  // 拿这种结果去判"这家不可用"，会比不测**更误导**。
  //
  // 所以：**只用调用方显式给的模型**（`o.genModel` / `o.genModels[]`，通常取该供应商
  // 配置里已声明的上游模型 ID —— 那是用户已经验证过能用的），拿不到就**不做**试生成。
  //
  // ⚠ 2026-11-03 追加：**第一个模型不可用 ≠ 这家不可用**。
  // 实测 x666：声明的第一个模型 `deepseek-v4.1-flash` 回
  // `503 No available channel for model … under group level3`（该分组没这个渠道），
  // 而这家在真实流量里 37 次调用**全部成功**（走的是别的模型）。
  // 所以遇到"模型级"失败时，把配置里其余已声明模型再试一两个：
  // 只要有一个能出字，这家的凭据就是好的 —— 用户需要知道的是"这家能用、那个模型不行"。
  const genCandidates = (() => {
    const first = String(o.genModel || '').trim();
    const rest = Array.isArray(o.genModels)
      ? o.genModels.map((m) => String(typeof m === 'string' ? m : (m && (m.id || m.up)) || '').trim()).filter(Boolean)
      : [];
    const all = [first, ...rest].filter(Boolean);
    return [...new Set(all)].slice(0, 3);   // 最多试 3 个，别把 90 秒预算吃光
  })();
  const genTried = [];
  let gen = null;
  if (res.ok && o.deepProbe !== false && genCandidates.length) {
    const path = genPathFor(provider);
    for (const genModelId of genCandidates) {
      // eslint-disable-next-line no-await-in-loop
      const r2 = await getJson(base + path, {
        method: 'POST',
        body: genBodyFor(provider, path, genModelId),
        headers: Object.assign({}, o.headers || {}, { 'content-type': 'application/json' }),
        apiKey: key,
        proxy: directOnly ? null : o.proxy,
        noProxy: o.noProxy || [],
        // 生成比目录慢得多（nvidia 实测 25–29 秒），给足时间；仍受"整体墙钟"兜底保护
        timeoutMs: o.genTimeoutMs || 45000,
        limit: 256 * 1024,
      });
      const detail = extractUpstreamError(r2.body);
      const blob = String(r2.body || '') + ' ' + String(r2.error || '');
      const kind = r2.ok ? 'ok' : classifyGenFailure(r2.status, blob, r2.via);
      genTried.push({ model: genModelId, status: r2.status, ms: r2.ms, kind, detail });
      gen = { path, model: genModelId, status: r2.status, ms: r2.ms, ok: r2.ok, body: String(r2.body || r2.error || '').slice(0, 200), via: r2.via, detail, kind };

      if (r2.ok) {
        ok = true;
        const others = genTried.slice(0, -1).map((t) => `${t.model}（${t.kind === 'model' ? '该模型不可用' : 'HTTP ' + t.status}）`);
        verdict = `凭据可用于生成（目录 ${modelCount === null ? '?' : modelCount} 个模型；试生成 ${genModelId} 成功，HTTP ${r2.status}，${r2.ms}ms）`
          + (others.length ? ` —— 注意：${others.join('、')} 用不了，与凭据无关` : '');
        break;
      }

      // 模型级失败 → 换下一个已声明模型再试；限流/网络/凭据问题换模型也没用，立刻停。
      if (kind === 'model' && genTried.length < genCandidates.length) {
        verdict = `试生成 ${genModelId} 是模型级限制（HTTP ${r2.status}：${detail}），换下一个已声明模型再试…`;
        continue;
      }

      if (kind === 'rate') {
        ok = null;
        verdict = `目录可读、凭据有效，但试生成 ${genModelId} **被限流**（HTTP ${r2.status}：${detail}）`
          + ' —— 这是 TPM/RPM 或并发上限，**不是凭据问题**，过一两分钟单独重测这一家即可';
      } else if (kind === 'model') {
        ok = null;
        verdict = `目录可读、凭据格式有效；试生成 ${genModelId} 被拒（HTTP ${r2.status}）：${detail}`
          + ' —— 这看着是**该模型对这个账号/这条链路**的限制，**不是凭据问题**'
          + (genCandidates.length > 1 ? '（配置里声明的模型都试过了）' : '；建议在编辑抽屉里换一个该账号能用的模型');
      } else if (kind === 'proxy') {
        ok = null;
        verdict = `目录可读（HTTP ${res.status}）但试生成时**本机代理连不上**：${r2.error}`
          + ' —— 这是**本机网络环境**问题，不等于凭据不可用；把代理开起来再测';
      } else if (kind === 'conn') {
        ok = null;
        verdict = `目录可读（HTTP ${res.status}）但**试生成超时/连接失败**（${r2.via}）：${r2.error} —— 无法据此判断凭据好坏，请以网关日志里的真实调用为准`;
      } else if (kind === 'limit') {
        // 上游把错误写成"max_tokens 到了"：是我们自己发的 body 太抠（带推理的模型
        // 会把 16 个 token 全花在思考上）。这不是凭据问题，也不是渠道问题。
        ok = null;
        verdict = `目录可读、凭据有效；试生成 ${genModelId} 回了「输出额度到顶」（HTTP ${r2.status}：${detail}）`
          + ' —— 这是**探测请求本身太小**（带推理的模型把 token 花在思考上），不是凭据或渠道问题；'
          + '请以网关日志里的真实调用为准';
      } else if (kind === 'busy') {
        ok = null;
        verdict = `目录可读，但试生成时**上游繁忙/临时故障**（HTTP ${r2.status}：${detail}）`
          + ' —— 这类 5xx 通常是过载或维护，与凭据无关，过几分钟再测一次';
      } else if (kind === 'other') {
        ok = null;
        verdict = `目录可读，但试生成被拒（HTTP ${r2.status}：${detail}）—— 这条拒绝没看懂属于哪一类，`
          + '**不据此判这家不可用**，请以网关日志里的真实调用结果为准';
      } else if (kind === 'pay') {
        ok = false;
        verdict = `目录可读，但试生成被拒（HTTP ${r2.status}：${detail}）—— 这家**余额/额度不足**，充值或换 Key 才能用`;
      } else {
        ok = false;
        verdict = `目录可读（HTTP ${res.status}）但**试生成被拒**（HTTP ${r2.status}）：${detail}`;
      }
      break;
    }
  }

  return {
    id, ok, via: res.via, ms: res.ms, status: res.status, baseUrl: base,
    modelCount, sample, verdict, gen, genTried,
  };
}

/** 生成端点路径：按供应商声明的协议选，缺省按 OpenAI chat。 */
function genPathFor(provider) {
  const w = String((provider && provider.protocol) || '').toLowerCase();
  if (w === 'anthropic' || w === 'anthropic-messages' || w === 'messages') return '/messages';
  if (w === 'openai-responses' || w === 'responses') return '/responses';
  return '/chat/completions';
}

/** 试生成的最小请求体（按端点形状给，尽量便宜：1 个 token）。 */
function genBodyFor(provider, path, model) {
  // ⚠ `max_tokens` 不能是 1（2026-11-03 实测 agentrouter）。
  // 带推理的模型（thinking / reasoner）会把这 1 个 token 花在推理上，正文被截断，
  // 上游回 **HTTP 400 `Could not finish the message because max_tokens or model output
  // limit was reached.`** —— 那是**我们自己发的 body 太抠**，不是凭据坏了、也不是渠道坏了。
  // 实测：agentrouter 两把 Key 因此被报成「2 把被拒」，而它的真实调用 137/140 成功。
  // 16 个 token 的成本可以忽略，却能让这类模型正常吐字。
  const probeMaxTokens = 16;
  if (path === '/messages') {
    return { model, max_tokens: probeMaxTokens, messages: [{ role: 'user', content: 'hi' }] };
  }
  if (path === '/responses') {
    // ⚠ `input` 必须是**数组**。标准 Responses API 两种都收（字符串会被当成一条用户消息），
    // 但 **Codex 订阅后端只收数组** —— 传字符串直接
    //   HTTP 400 {"detail":"Input must be a list"}
    //（实测 2026-10-09：探测因此把一家能用的供应商报成失败）。
    // 形状照 Codex 官方客户端：message + input_text 内容块。
    // `store:false` 与 `stream:true` 都是它的硬要求（见引擎里同名注释）——
    // 缺任一个都是 400：`Store must be set to false` / `Stream must be set to true`。
    return {
      model,
      max_output_tokens: 16,
      instructions: 'You are a helpful assistant.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      store: false,
      stream: true,
    };
  }
  return { model, max_tokens: probeMaxTokens, messages: [{ role: 'user', content: 'hi' }] };
}

/**
 * 从上游错误体里抠出**给人看的**原因。
 * 上游常见的形状：{status:403,title:"Forbidden",detail:"Authorization failed"}、
 * {error:{message:"..."}}、{message:"..."}。抠不出来就返回原文前 120 字。
 */
function extractUpstreamError(bodyText) {
  const s = String(bodyText || '').replace(/\s+/g, ' ').trim();
  if (!s) return '(上游未给原因)';
  // ⚠ 有些上游把 message 写成**对象**（例如 amd 的 429：`{"error":{"message":{...}}}`）。
  // 直接 join 会得到 `[object Object]`，界面上一句人话都不是（2026-11-03 实测）。
  const str = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' ? JSON.stringify(v) : (v == null ? '' : String(v))));
  try {
    const j = JSON.parse(s);
    const cand = str((j && (j.detail || (j.error && (j.error.message || j.error.type)) || j.message || j.title)) || '');
    const title = str((j && j.title) || '');
    const parts = [title, cand].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
    if (parts.length) return parts.join(' — ').slice(0, 160);
  } catch (_) { /* 不是 JSON：下面回原文 */ }
  return s.slice(0, 120);
}

/**
 * 用**指定的一把 Key** 做一次最小生成请求（多 Key 供应商逐把体检用）。
 *
 * 与 `probeProvider` 里的试生成共用同一套端点/请求体/错误解析，
 * 差别只在于"用哪把 Key"—— 那边取 `apiKey || apiKeys[0]`，这边由调用方指定。
 *
 * 返回 `{ ok, status, ms, detail, body }`；`ok` 为 null 表示"判不出来"（超时/连不上），
 * 与 `false`（上游明确拒绝）区分开 —— 这个区分对避免误导很重要。
 */
async function probeOneKeyGen(provider, ctx) {
  const o = ctx || {};
  const base = upstreamBase(String((provider && provider.baseURL) || ''));
  const path = o.path || genPathFor(provider);
  const r = await getJson(base + path, {
    method: 'POST',
    body: genBodyFor(provider, path, o.model),
    headers: Object.assign({}, o.headers || {}, { 'content-type': 'application/json' }),
    apiKey: o.key,
    proxy: o.proxy,
    noProxy: o.noProxy || [],
    timeoutMs: o.timeoutMs || 45000,
    limit: 256 * 1024,
  });
  const detail = extractUpstreamError(r.body || r.error);
  if (r.ok) return { ok: true, status: r.status, ms: r.ms, detail: '', kind: 'ok' };
  const blob = String(r.body || '') + ' ' + String(r.error || '');
  const kind = classifyGenFailure(r.status, blob, r.via);
  const ko = kindOfGen(kind);
  // `ok:null` 表示"判不出来 / 不是凭据的事"（限流、模型级限制、本机代理、连接失败），
  // 与 `ok:false`（上游明确因凭据拒绝）必须分开 —— 多 Key 聚合时全靠这个区分。
  return {
    ok: ko.ok, status: r.status, ms: r.ms, detail, kind, label: ko.label,
    body: String(r.body || r.error || '').slice(0, 200),
  };
}

/**
 * 探测用的 Codex 凭据读取（**只读，不刷新**）。
 *
 * 与引擎里的同名逻辑同源，但这里是独立模块（主进程用它，引擎是子进程）——
 * 所以只能各读一份。两边的**候选顺序必须一致**：`CODEX_HOME` 优先，
 * 再退回 `~/.codex`（实测本机 CODEX_HOME 指向别处，只读后者会读到没用的文件）。
 *
 * 不在这里刷新令牌：探测是只读操作，不该产生副作用（引擎负责刷新并写回）。
 */
function readCodexCredForProbe() {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const cands = [];
  const envHome = String(process.env.CODEX_HOME || '').trim();
  if (envHome) cands.push(path.join(envHome, 'auth.json'));
  cands.push(path.join(os.homedir(), '.codex', 'auth.json'));
  let file = '';
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) { file = c; break; } } catch { /* 试下一个 */ }
  }
  if (!file) return { ok: false, error: '未找到 auth.json（请先登录 Codex 桌面版/CLI）' };
  let auth = null;
  try { auth = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, error: 'auth.json 不是合法 JSON：' + (e && e.message) }; }
  const t = (auth && auth.tokens) || {};
  if (!t.access_token) {
    return {
      ok: false,
      error: String(auth && auth.auth_mode) === 'apikey'
        ? '当前是 API Key 登录方式，不是 ChatGPT 订阅（请在 Codex 里改用 ChatGPT 账号登录）'
        : '凭据里没有 access_token（请先登录 Codex）',
    };
  }
  let accountId = String(t.account_id || '').trim();
  if (!accountId) {
    try {
      const claims = JSON.parse(Buffer.from(String(t.access_token).split('.')[1], 'base64url').toString('utf8'));
      accountId = String((claims['https://api.openai.com/auth'] || {}).chatgpt_account_id || '').trim();
    } catch { /* 忽略 */ }
  }
  if (!accountId) return { ok: false, error: '推不出 chatgpt-account-id' };
  // 过期就如实说 —— 不刷新、也不假装能用
  let exp = 0;
  try {
    const claims = JSON.parse(Buffer.from(String(t.access_token).split('.')[1], 'base64url').toString('utf8'));
    exp = Number(claims.exp) * 1000 || 0;
  } catch { /* 忽略 */ }
  if (exp && Date.now() >= exp) {
    return { ok: false, error: 'access_token 已过期 —— 请运行一次 Codex（或让网关发一次请求）以触发刷新' };
  }
  return { ok: true, accessToken: t.access_token, accountId, file };
}

/** Codex 后端的必需请求头（探测用）。与引擎的 codexUpstreamHeaders 同源。 */
function codexProbeHeaders(cred) {
  const sid = require('node:crypto').randomUUID();
  return {
    authorization: 'Bearer ' + cred.accessToken,
    'chatgpt-account-id': cred.accountId,
    originator: 'codex_cli_rs',
    'OpenAI-Beta': 'responses=experimental',
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'session-id': sid,
    'x-client-request-id': sid,
    'user-agent': 'codex_cli_rs/0.162.0 (Windows 10; x64)',
  };
}

module.exports = {
  probeProvider, getJson, upstreamBase, hostInList, connectViaProxy, extractUpstreamError,
  genPathFor, probeOneKeyGen, readCodexCredForProbe, classifyGenFailure, kindOfGen, summarizeKeyResults,
};
