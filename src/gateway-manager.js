// gateway-manager.js — 网关进程托管 / 配置读写 / 健康探测 / 一键写入
//
// 职责边界（与 dsh-app 的版本一致，去掉 dsh 专有耦合）：
//   · 引擎 src/gateway/model-gateway.mjs 是**零依赖单文件**，本模块只负责托管它：
//     进程生命周期、配置文件的读写与校验、代理解析、日志预览、健康快照。
//   · 一键写入各客户端配置（dsh / Claude Code / Codex / …）也在这里统一入口，
//     具体写入逻辑在 src/writers/ 下按目标分包。
//
// 为什么用子进程而不是在主进程内 require 引擎：
//   引擎带 self-watchdog（连续 3 次 /health 自检失败即 `process.exit(1)` 自愈）。
//   在主进程内跑，这个 exit 会把整个桌面程序带走。子进程化还顺带隔离了上游异常。
'use strict';

/**
 * 配置里数值字段的上界。
 *
 * 对 `timeoutMs` 来说这不是"够不够用"，而是**下溢**：`setTimeout` 的延时上限是 2^31-1，
 * 超出的值会被 Node 悄悄改成 **1ms**（`TimeoutOverflowWarning: … does not fit into a
 * 32-bit signed integer. Timeout duration was set to 1.`）。实测 `timeoutMs: 1e308` 时
 * 该模型的每个请求都在 ~5ms 内被 abort，而 AbortError 明确不重试 → 反复失败最终把
 * **整家供应商**熔断。校验器放行这种值，等于让一个配置项变成"让这家彻底不可用"的开关。
 */
const MAX_TIMEOUT_MS = 600 * 1000;             // 逐模型/供应商级超时上限 10 分钟
const MAX_CONTEXT_WINDOW = 10 * 1000 * 1000;   // 上下文长度上限 1000 万

/**
 * 客户端仿真档的**唯一清单**（全局 `clientProfile` 与逐供应商 `clientProfile` 共用）。
 *
 * ⚠ 这份清单必须与引擎 `model-gateway.mjs` 的 `upstreamRequestHeaders()` 分支一一对应。
 * 曾经这里只写了 claude/codex/cline，而引擎那轮已加了 opencode ——
 * 于是**免费通道预设写进去的 `clientProfile: 'opencode'` 被保存校验直接拒掉**，
 * 用户点「保存并生效」只看到一句"非法"，功能等于没做（审计脚本 audit-preset 抓到的）。
 * `tests/unit.js` 有一条守卫测试会拿引擎源码来比这份清单，两边再也漂不了。
 */
const CLIENT_PROFILES = ['claude', 'codex', 'cline', 'opencode'];
const MAX_MAX_TOKENS = 1000 * 1000;            // 单次最大输出上限 100 万

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

const { materialize, resourcePath } = require('./paths');
const { prependPath } = require('./winutil');
const crashReport = require('./crash-report');

const LOG_TAIL_MAX = 128 * 1024;

// 回环地址**永远**直连：Node ≥24 在 NODE_USE_ENV_PROXY=1 下会把连 127.0.0.1 的
// fetch/http.get 也塞进代理（实测：代理端口一死，回环请求 8ms ECONNREFUSED），
// 于是引擎进程内的 watchdog 自检 /health 会把**健康进程**判死并自杀重启。
const LOOPBACK_NO_PROXY = ['127.0.0.1', 'localhost', '::1'];

// 国内端点默认直连（腾讯 CodeBuddy / WorkBuddy）：直连实测可达，挂代理只白挨抖动。
const BUILTIN_DIRECT_HOSTS = ['copilot.tencent.com', 'workbuddy.cn'];

/* ------------------------------------------------------------------ *
 * 代理字符串解析（纯函数，便于单测）
 * ------------------------------------------------------------------ */

/** 补 scheme：`127.0.0.1:7890` → `http://127.0.0.1:7890`。 */
function normalizeProxyUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return s.includes('://') ? s : 'http://' + s;
}

/**
 * 从注册表 `ProxyServer` 里挑出 HTTP 代理。
 *
 * 形如 `"http=127.0.0.1:7890;https=127.0.0.1:7891"`，也可能就是裸的 `"127.0.0.1:7890"`。
 *
 * 旧实现是 `s.split(';')[0].split('=').pop().trim()`，三种真实误解析（实测）：
 *   `https=…:7891;http=…:7890` → 拿 **https 代理**当 http 代理用；
 *   `ftp=…;http=…`             → 拿 **FTP 代理**当 HTTP 代理；
 *   `http://user:pa=ss@host:80` → 在第一个 `=` 处截断，密码残段变成用户名。
 * 这里改为按协议键取值、无 `=` 时整体当 host:port、并只认 http/https 两种键。
 */
function pickProxyFromRegistry(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (!s.includes('=')) return s;
  const map = new Map();
  for (const part of s.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    map.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return map.get('http') || map.get('https') || '';
}

/* ------------------------------------------------------------------ *
 * 子进程工具
 * ------------------------------------------------------------------ */

// 异步跑一段 PowerShell 取回 stdout。超时/出错一律返回已收集输出，绝不抛。
// （旧实现用 spawnSync，在一次启动里会冻住主进程数秒到十几秒，窗口/托盘全部无响应。）
function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let child = null;
    const done = () => resolve(out);
    try {
      child = spawn('powershell', ['-NoProfile', '-Command', script], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_) { return done(); }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* 忽略 */ } done(); }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); done(); });
    child.on('exit', () => { clearTimeout(timer); done(); });
    return undefined;
  });
}

/**
 * 按命令行特征杀进程树。
 *
 * ⚠ **必须同时命中"我们的引擎文件名"才算目标。**
 *
 * 只按"命令行里含配置路径"匹配是不够的（实测踩到）：用户完全可能在编辑器、终端或任何
 * 工具里打开/引用 `gateway.config.json`（`code` 打开它、`type` 它、备份脚本带上它），
 * 那些进程的命令行里同样含这个路径 —— 于是每次启动与每次退出收尾都会把**无关进程的
 * 整棵进程树**用 `/T /F` 强杀。杀错进程是不可逆的。
 *
 * 我们的网关子进程命令行**必然**含 `model-gateway.mjs`（或一次性写入模式的 `--write-dsh`），
 * 所以要求"marker 与引擎标识同时出现"，既精确又不会漏。
 *
 * 性能：`-Filter` 只取三种映像名，且**多特征一次枚举**（旧版逐个调用 → 多次全量 CIM 查询，
 * 退出路径累计能到 20-60 秒）。
 */
async function killProcessesByCommandlines(markers, logLabel, logFn) {
  const list = (Array.isArray(markers) ? markers : [markers])
    .filter((m) => m && String(m).trim())
    .map((m) => String(m));
  if (list.length === 0) return 0;
  try {
    const arr = list.map((m) => "'" + m.replace(/'/g, "''") + "'").join(',');
    const script = '$ms = @(' + arr + '); ' +
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='LLM Gateway.exe' OR Name='electron.exe' OR Name='cmd.exe'\" | " +
      'ForEach-Object { $cl = $_.CommandLine; if (-not $cl) { return }; ' +
      // 引擎标识：我们的子进程必然带这两个之一
      "if (-not ($cl.Contains('model-gateway.mjs') -or $cl.Contains('--write-dsh'))) { return }; " +
      'foreach ($m in $ms) { if ($cl.Contains($m)) { Write-Output $_.ProcessId; break } } }';
    const stdout = await runPowerShell(script, 15000);
    // ⚠ 只接受**完整行**里的纯数字 PID。
    //
    // 旧实现是 `s.split(/\r?\n/).map(s => parseInt(s.trim(), 10))` —— parseInt 会接受
    // 任意数字前缀，于是 `12abc` → 12、`-5` → -5、而且**被截断的末行**会变成一个
    // 真实的 PID 目标。截断是现实存在的：runPowerShell 有 15 秒超时，超时时它返回的是
    // "已经收到的分片"，末行随时可能是半截（实测：伪造 stdout `garbage\r\n45` → `/pid 45`）。
    // 杀错进程是不可逆的，所以这里：
    //   ① stdout 不以换行结尾时，丢掉最后一行（可能是残缺的）；
    //   ② 只认 `^\d+$`；
    //   ③ 加上界，排除自身 PID。
    let text = String(stdout || '');
    if (text && !/[\r\n]$/.test(text)) {
      const cut = text.lastIndexOf('\n');
      text = cut >= 0 ? text.slice(0, cut + 1) : '';
    }
    const seen = new Set();
    const pids = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => Number(s))
      .filter((n) => {
        if (!Number.isInteger(n) || n <= 0 || n > 0x7fffffff) return false;
        if (n === process.pid || seen.has(n)) return false;
        seen.add(n);
        return true;
      });
    if (pids.length === 0) return 0;
    let killed = 0;
    for (const pid of pids) {
      try {
        const r2 = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        if (r2.status === 0) killed++;
      } catch (_) { /* 忽略单个失败 */ }
    }
    if (killed > 0 && logFn) logFn(logLabel + ' ' + killed + ' 个进程树。');
    return killed;
  } catch (_) { return 0; }
}

/* ------------------------------------------------------------------ *
 * 配置文本校验（保存前拦截，与运行期语义对齐）
 * ------------------------------------------------------------------ */

/**
 * 校验网关配置文本。返回 { ok, error }。
 *
 * 设计原则：**校验必须与运行期语义一致**。历史上每一次"校验器漏了某个字段"都变成了
 * 用户可感知的怪现象（字符串 "false" 被当成启用、vision 静默丢失、baseURL 缺 scheme
 * 导致恒 503 等），所以这里逐字段与引擎实现对齐。
 */
function validateConfigText(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: 'JSON 解析失败：' + (err && err.message ? err.message : err) };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: '配置根必须是对象（port / apiKey / providers）' };
  }
  if (!Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    return { ok: false, error: '缺少 providers 数组（至少一个供应商）' };
  }
  // 端口必须显式且合法：缺失/非法时引擎会静默回退 3091，占错端口
  {
    const p = Number(cfg.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return { ok: false, error: '缺少或非法 port（必须是 1-65535 整数）' };
    }
  }
  // 统一 Key 必须能通过运行期鉴权门槛（trim 后 ≥16 字符，fail-closed）。
  // 否则会出现"网关运行中、/health 返回 200、但每个模型请求都 401"。
  if (cfg.apiKey !== undefined && cfg.apiKey !== null && String(cfg.apiKey).trim() !== '') {
    const k = String(cfg.apiKey).trim();
    if (k === 'dsh-gateway-change-me') {
      return { ok: false, error: 'apiKey 仍是示例占位值（dsh-gateway-change-me）：本机任何进程都能白用你的上游额度，请改成自己的随机 Key' };
    }
    if (k.length < 16) {
      return { ok: false, error: 'apiKey 太短（' + k.length + ' 字符）：网关鉴权要求 ≥16 字符，否则所有请求都会 401' };
    }
  }
  // 路由策略（本程序新增校验）：拼错会被引擎静默当成 failover
  if (cfg.routing !== undefined && cfg.routing !== null && String(cfg.routing).trim() !== '') {
    const r = String(cfg.routing).trim();
    if (r !== 'failover' && r !== 'round-robin') {
      return { ok: false, error: 'routing 非法（可选：failover / round-robin），当前：' + JSON.stringify(cfg.routing) };
    }
  }
  // 客户端仿真档（本程序新增校验）：拼错会静默回落成"不透传标识"
  if (cfg.clientProfile !== undefined && cfg.clientProfile !== null && String(cfg.clientProfile).trim() !== '') {
    const c = String(cfg.clientProfile).trim();
    if (!CLIENT_PROFILES.includes(c)) {
      return { ok: false, error: 'clientProfile 非法（可选：' + CLIENT_PROFILES.join(' / ') + '，留空=关闭）当前：' + JSON.stringify(cfg.clientProfile) };
    }
  }
  // 代理（本程序新增校验）：enabled=true 但 url 空会让引擎回退自动探测，
  // 用户以为"指定了代理"其实没有——保存前说清楚
  if (cfg.proxy !== undefined) {
    if (!cfg.proxy || typeof cfg.proxy !== 'object' || Array.isArray(cfg.proxy)) {
      return { ok: false, error: 'proxy 必须是对象（{ enabled, url, noProxy: [] }）' };
    }
    // enabled 必须是真正的布尔。写 "false"/1/[] 这类值，运行期按 `!== false` 判断会当成"启用"，
    // 与用户意图相反（口径与 provider.enabled 的校验保持一致）。
    if (cfg.proxy.enabled !== undefined && typeof cfg.proxy.enabled !== 'boolean') {
      return { ok: false, error: 'proxy.enabled 必须是布尔值（true / false），当前：' + JSON.stringify(cfg.proxy.enabled) };
    }
    const enabled = cfg.proxy.enabled !== false;   // 缺省视为启用（与引擎一致）
    const url = String(cfg.proxy.url || '').trim();
    // ⚠ url 只在**启用时**才校验。停用状态下留着一个不支持的 https:// 残留值很常见
    //（用户先试了 https、失败后把 enabled 关掉）—— 把它当保存错误会把用户卡死，
    // 而它运行时根本不会被使用（实测反馈的误拒）。
    if (enabled && url && !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'proxy.url 必须以 http:// 或 https:// 开头，当前：' + JSON.stringify(cfg.proxy.url) };
    }
    // ⚠ 明确拒绝 https:// 代理。本程序的代理通道（CONNECT 隧道 / 绝对 URI 形式）都是
    // **明文连到代理**的；填 https:// 会被当成普通端口去 net.connect，对端是个 TLS 端点时
    // 只会收到明文 CONNECT 然后不答 → 表现为"连通性测试永久转圈"（这条路径曾经真的没有超时，
    // 现在有超时了，但它仍然永远不可用）。与其让用户对着一个永远失败的配置排查，
    // 不如在保存前直说。
    if (enabled && /^https:\/\//i.test(url)) {
      return { ok: false, error: 'proxy.url 暂不支持 https:// 代理（本程序的代理通道是明文 CONNECT）。请填 http:// 开头的地址；若代理强制 TLS，请在本机跑一个明文入口（如 clash 的混合端口）。' };
    }
    // 启用时代理地址不能为空：否则引擎会回退自动探测，用户以为"指定了代理"其实没有
    if (cfg.proxy.enabled === true && !url) {
      return { ok: false, error: 'proxy.enabled 为 true 时 proxy.url 不能为空（留空会回退到自动探测，等于没指定）。想直连请把 enabled 设为 false。' };
    }
    if (enabled && url) {
      // host / 端口范围：写错的代理比不写代理更难排查（表现为"网关好的但所有模型都不通"）
      let u = null;
      try { u = new URL(url); } catch { return { ok: false, error: 'proxy.url 不是合法 URL：' + JSON.stringify(cfg.proxy.url) }; }
      if (!u.hostname) return { ok: false, error: 'proxy.url 缺少主机名：' + JSON.stringify(cfg.proxy.url) };
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, error: 'proxy.url 端口非法（应在 1–65535）：' + JSON.stringify(cfg.proxy.url) };
      }
    }
    for (const k of ['noProxy', 'forceProxy']) {
      const v = cfg.proxy[k];
      if (v !== undefined && typeof v !== 'string' && !Array.isArray(v)) {
        return { ok: false, error: 'proxy.' + k + ' 必须是数组或逗号分隔字符串' };
      }
    }
  }
  // 供应商 id 必须唯一：运行期一切按 provider.id 为键的状态（熔断、目录缓存、thinking
  // 学习、Responses 亲和）都会在同 id 的两家之间串味——一家 401 会把另一家一起熔断。
  const seenIds = new Set();
  for (const p of cfg.providers) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'providers 中存在非对象条目' };
    if (!p.id || typeof p.id !== 'string') return { ok: false, error: '供应商缺少 id（字符串）' };
    if (seenIds.has(p.id)) {
      return { ok: false, error: '供应商 id 重复："' + p.id + '"（熔断/目录/亲和状态按 id 共享，必须唯一）' };
    }
    seenIds.add(p.id);
    if (!p.baseURL || typeof p.baseURL !== 'string') return { ok: false, error: '供应商 ' + p.id + ' 缺少 baseURL' };
    {
      let u = null;
      try { u = new URL(String(p.baseURL).trim()); } catch (_) { /* 落到下面统一报错 */ }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
        return { ok: false, error: '供应商 ' + p.id + ' 的 baseURL 必须是 http(s) 绝对地址（如 https://api.example.com/v1），当前：' + JSON.stringify(p.baseURL) };
      }
    }
    // 模型映射：每项是字符串（上游 ID = 逻辑名）或 { id, as } 映射对象
    if (p.models !== undefined) {
      const who = '供应商 ' + p.id + ' 的 models';
      if (!Array.isArray(p.models)) return { ok: false, error: who + ' 必须是数组' };
      for (const m of p.models) {
        if (typeof m === 'string') continue;
        const up = (m && typeof m === 'object' && !Array.isArray(m)) ? (m.id ?? m.up ?? m.upstream ?? m.model) : undefined;
        if (typeof up === 'string' && up.trim()) {
          if (m.vision !== undefined && typeof m.vision !== 'boolean') {
            return { ok: false, error: who + ' 的条目 "' + up + '" 的 vision 必须是布尔值（字符串会被忽略 → 图片能力静默丢失）' };
          }
          // 逐模型超时（2026-09-30 新增）：与供应商级同口径校验 —— 非正数会让
          // `Number.isFinite(n) && n > 0` 判假、静默回落到供应商级，用户以为配了却没生效。
          for (const nk of ['contextWindow', 'maxTokens', 'timeoutMs']) {
            if (m[nk] === undefined) continue;
            const n = Number(m[nk]);
            if (!Number.isFinite(n) || n <= 0) {
              return { ok: false, error: who + ' 的条目 "' + up + '" 的 ' + nk + ' 必须是正数（当前：' + JSON.stringify(m[nk]) + '）' };
            }
            // ⚠ 上界不是"够不够用"的问题，而是**下溢**：
            // `setTimeout` 的延时上限是 2^31-1，超出的值会被 Node 悄悄改成 **1ms**
            // 并打 TimeoutOverflowWarning。实测 timeoutMs=1e308 时该模型每个请求在 ~5ms 内
            // 被 abort，而 AbortError 明确不重试 → 反复失败最终把整家供应商熔断。
            // 校验器放行这种值，等于让一个配置项变成"让这家彻底不可用"的开关。
            const cap = nk === 'timeoutMs' ? MAX_TIMEOUT_MS : (nk === 'contextWindow' ? MAX_CONTEXT_WINDOW : MAX_MAX_TOKENS);
            if (n > cap) {
              return { ok: false, error: who + ' 的条目 "' + up + '" 的 ' + nk + ' 太大了（' + n + '），上限 ' + cap };
            }
          }
          if (m.timeoutMs !== undefined && Number(m.timeoutMs) < 1000) {
            return { ok: false, error: who + ' 的条目 "' + up + '" 的 timeoutMs 太小（' + m.timeoutMs + 'ms），至少 1000ms' };
          }
          continue;
        }
        return { ok: false, error: who + ' 存在非法条目——每项应为字符串，或形如 { "id": "上游真实ID", "as": "逻辑模型名" } 的对象' };
      }
    }
    {
      const who = '供应商 ' + p.id;
      // enabled 必须是布尔：运行期用 `p.enabled !== false` 判启用，字符串 "false" 会被当成**启用**
      if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
        return { ok: false, error: who + ' 的 enabled 必须是布尔值（字符串 "false" 会被运行期当成"启用"，语义相反）' };
      }
      if (p.protocol !== undefined) {
        const proto = String(p.protocol).trim().toLowerCase();
        // ⚠ 白名单必须与引擎的 `wireOfName()`（model-gateway.mjs）**逐字对齐**。
        //
        // 旧白名单少了 4 个引擎本来就认的拼法：`chat` / `messages` /
        // **`openai-responses`** / **`responses`** —— 于是用户（和渠道预设）
        // 写出引擎完全支持的协议时，被校验器挡在门外，报「protocol 非法」。
        // 实测（2026-10-09）：Codex 订阅预设填 `openai-responses` 直接保存失败。
        //
        // 这是"两个地方各写一份规则"的经典漂移。渲染层的 `canonicalApiValue()`
        // 也认同一组拼法 —— 三处必须一致。
        if (!['openai-chat', 'openai-completions', 'openai', 'chat',
          'anthropic', 'anthropic-messages', 'messages',
          'openai-responses', 'responses'].includes(proto)) {
          return {
            ok: false,
            error: who + ' 的 protocol 非法（可选：openai-chat / anthropic-messages / openai-responses，'
              + '以及引擎认的简写 chat / messages / responses）',
          };
        }
      }
      if (p.quirks !== undefined) {
        const known = ['force-stream', 'stringify-tool-choice', 'prepend-system', 'drop-thinking'];
        const list = Array.isArray(p.quirks) ? p.quirks : (typeof p.quirks === 'string' ? p.quirks.split(',') : null);
        if (!list) return { ok: false, error: who + ' 的 quirks 必须是数组或逗号分隔字符串' };
        for (const q of list) {
          const v = String(q).trim().toLowerCase();
          if (v && !known.includes(v)) return { ok: false, error: who + ' 的 quirks 含未知项 "' + q + '"（可用：' + known.join(' / ') + '）' };
        }
      }
      if (p.headers !== undefined && (typeof p.headers !== 'object' || Array.isArray(p.headers) || p.headers === null)) {
        return { ok: false, error: who + ' 的 headers 必须是对象（如 { "User-Agent": "…" }）' };
      }
      if (p.timeoutMs !== undefined) {
        const n = Number(p.timeoutMs);
        if (!Number.isFinite(n) || n <= 0) return { ok: false, error: who + ' 的 timeoutMs 必须是正数（毫秒）' };
        // 上界见逐模型那条的说明：超过 2^31-1 会被 setTimeout 下溢成 1ms
        if (n > MAX_TIMEOUT_MS) return { ok: false, error: who + ' 的 timeoutMs 太大了（' + n + '），上限 ' + MAX_TIMEOUT_MS };
      }
      if (p.clientProfile !== undefined && String(p.clientProfile).trim() !== '') {
        const c = String(p.clientProfile).trim();
        if (!CLIENT_PROFILES.includes(c)) {
          return { ok: false, error: who + ' 的 clientProfile 非法（可选：' + CLIENT_PROFILES.join(' / ') + '）' };
        }
      }
      if (p.accounts !== undefined) {
        if (!Array.isArray(p.accounts)) return { ok: false, error: who + ' 的 accounts 必须是数组（账户池）' };
        const workbuddyAuth = String(p.auth || '').trim().toLowerCase() === 'workbuddy';
        for (const a of p.accounts) {
          if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: who + ' 的 accounts 存在非对象条目' };
          const hasFile = typeof a.authFile === 'string' && a.authFile.trim();
          const hasKey = typeof a.apiKey === 'string' && a.apiKey.trim();
          if (!hasFile && !hasKey && !workbuddyAuth) {
            return { ok: false, error: who + ' 的 accounts 条目缺少 authFile 或 apiKey：' + JSON.stringify(a)
              + '（若该供应商 auth 为 workbuddy，可只写 { "id": "…" }，凭据按默认位置自动发现）' };
          }
        }
      }
      // 同一供应商多把 Key（账户池轮换）
      if (p.apiKeys !== undefined && !Array.isArray(p.apiKeys) && typeof p.apiKeys !== 'string') {
        return { ok: false, error: who + ' 的 apiKeys 必须是字符串数组（同一供应商的多把 Key）' };
      }
      if (Array.isArray(p.apiKeys)) {
        for (const k of p.apiKeys) {
          if (typeof k !== 'string') return { ok: false, error: who + ' 的 apiKeys 只能包含字符串' };
        }
      }
      // ⚠ `auth` 白名单。这些值的共同点是**凭据由本机其它程序提供、不在配置里**：
      //   · workbuddy —— 桌面客户端凭据（authFile / 自动发现）
      //   · codex     —— Codex 桌面版/CLI 已登录的 auth.json（含自动刷新）
      // 引擎侧对应 `providerHasCredential()` / `accountUpstreamHeaders()` 里的分支，
      // 渲染层对应 `CREDENTIAL_FREE_AUTH`。**四处必须同步** ——
      // 实测（2026-10-09）这里漏了 codex，预设加进来的条目保存时报
      // 「auth 非法（当前支持：workbuddy）」，而这已经是同一类漂移的**第三处**。
      const KNOWN_AUTH = ['workbuddy', 'codex'];
      if (p.auth !== undefined && !KNOWN_AUTH.includes(String(p.auth).trim().toLowerCase())) {
        return { ok: false, error: who + ' 的 auth 非法（当前支持：' + KNOWN_AUTH.join(' / ') + '）' };
      }
    }
  }
  return { ok: true, error: null };
}

/* ------------------------------------------------------------------ *
 * GatewayManager
 * ------------------------------------------------------------------ */

class GatewayManager extends EventEmitter {
  /**
   * @param {object} opts
   *   dataDir  - 数据目录（gateway.config.json / logs/ 所在）
   *   logger   - Logger 实例
   *   settings - Settings 实例
   */
  constructor(opts) {
    super();
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.settings = opts.settings;
    this.log = (m) => this.logger.info(m);

    this.gatewayDir = path.join(__dirname, 'gateway');
    this.runtimeDir = path.join(this.dataDir, 'gateway');   // 打包后引擎解包到这里执行
    this.mjsPath = path.join(this.gatewayDir, 'model-gateway.mjs');
    this.configPath = path.join(this.dataDir, 'gateway.config.json');
    this.logPath = path.join(this.dataDir, 'logs', 'gateway.log');
    this.crash = new crashReport.CrashReport(this.dataDir, this.log);

    this.proc = null;
    this.running = false;
    // 进程在跑 != 端口在监听。ready 由 _doStart 的就绪探测结果给出，
    // 界面据此判断"真的能用了"（见 main.js 的 gw:action start）。
    this.ready = false;
    // ⚠ 启动**失败**（探测未通过 / 进程起不来）与"启动中"是两回事，托盘要能区分：
    // icon.js 里 `COLORS.starting`（琥珀）与 `COLORS.failed`（红）早就定义了，
    // 却在整个项目里**无人使用** —— 于是托盘图标只有"绿=好 / 灰=没运行"两种，
    // "正在启动"与"启动失败"看起来一模一样，用户只能去翻日志。
    // 这个标志由 _doStart 的就绪探测结果驱动（见下方 healthy 的处理）。
    this.failed = false;
    this.stopping = false;
    this.logTail = '';
    this.port = 3091;
    this.lastActivityAt = 0;
    this._starting = null;
    this._healTimes = [];

    this.ensureRuntime();
  }

  /* ---------------- 路径与运行时 ---------------- */

  /**
   * 解析"用哪个 node 跑引擎"。
   *
   * 首选**本程序自身的 exe** + ELECTRON_RUN_AS_NODE=1：Electron 二进制本身就是纯 Node
   * 运行时，这样"通用"才成立——目标机器不需要预装 Node，也不会踩到"用户装的是 Node 16，
   * 而引擎要求 ≥18"这类版本地雷。
   * 次选 PATH 上的 node.exe：本程序 exe 被杀软拦截/损坏时的逃生通道。
   */
  resolveNode() {
    const self = process.execPath;
    if (self) return { exe: self, env: { ELECTRON_RUN_AS_NODE: '1' }, kind: '内置运行时' };
    return { exe: 'node', env: {}, kind: 'PATH 上的 node' };
  }

  /** 引擎在 asar 内时把它解包到数据目录（外部 node 进程读不了 asar 内的文件）。 */
  ensureRuntime() {
    try {
      this.mjsPath = materialize('src/gateway/model-gateway.mjs', this.runtimeDir, this.log);
      const example = materialize('src/gateway/gateway.config.example.json', this.runtimeDir);
      this.examplePath = example;
    } catch (err) {
      this.log('网关运行时准备失败：' + (err && err.message ? err.message : err));
      this.examplePath = resourcePath('src/gateway/gateway.config.example.json');
    }
  }

  /** 首次使用：配置不存在时从示例生成。 */
  init() {
    try {
      if (!fs.existsSync(this.configPath)) {
        const candidates = [
          path.join(this.runtimeDir, 'gateway.config.example.json'),
          resourcePath('src/gateway/gateway.config.example.json'),
        ];
        const example = candidates.find((p) => fs.existsSync(p));
        if (example) {
          fs.copyFileSync(example, this.configPath);
          this.log('已从示例生成网关配置：' + this.configPath);
        }
      }
    } catch (err) {
      this.log('网关配置初始化失败：' + (err && err.message ? err.message : err));
    }
  }

  /* ---------------- 配置读写 ---------------- */

  configPort() {
    try {
      const cfg = JSON.parse(this.configText());
      const p = Number(cfg && cfg.port);
      return Number.isInteger(p) && p > 0 && p <= 65535 ? p : 3091;
    } catch (_) { return 3091; }
  }

  configText() {
    try { return fs.readFileSync(this.configPath, 'utf8'); } catch (_) { return ''; }
  }

  /** 解析后的配置对象（坏配置返回 null，调用方自行兜底）。 */
  configObject() {
    try { return JSON.parse(this.configText()); } catch (_) { return null; }
  }

  exampleText() {
    try {
      return fs.readFileSync(this.examplePath || path.join(this.runtimeDir, 'gateway.config.example.json'), 'utf8');
    } catch (_) {
      try { return fs.readFileSync(resourcePath('src/gateway/gateway.config.example.json'), 'utf8'); } catch (_) { return ''; }
    }
  }

  /** 保存配置（校验通过才写盘；运行中则重启生效）。 */
  async saveConfig(text, opts) {
    const v = validateConfigText(text);
    if (!v.ok) return v;
    try {
      // ⚠ 保存前留一份**滚动备份**（保留最近 10 份，放在 data\config-backups\）。
      // 起因是一次真实事故（2026-10-08）：构建脚本 `rmSync` 掉整个绿色目录（含 data\），
      // 用户当天新增的 3 个供应商随之消失，而下一次启动又从"既有安装"导入了一份旧配置 ——
      // 用户看到的是"配置自己变回去了"，且**全盘找不到可恢复的副本**。
      // 单靠"改构建脚本"只是堵住了那一条路径；配置本身没有历史，
      // 任何一次误删/误写都不可逆。这里补上历史。
      try { this._backupConfig(); } catch (e) { this.log('配置备份失败（不影响保存）：' + (e && e.message)); }
      const tmp = this.configPath + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, this.configPath);      // 原子写：半截 JSON 会让网关下次起不来
      this.log('网关配置已保存。');
      if (this.running && !(opts && opts.noRestart)) await this.restart();
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: '配置写入失败：' + (err && err.message ? err.message : err) };
    }
  }

  /**
   * 把当前配置复制进 data\config-backups\，只保留最近 10 份。
   * 刻意保留"每次保存前"的版本，而不是"N 分钟一次" —— 用户改配置是低频动作，
   * 按动作留档既能精确回到"上一次保存之前"，也不会把目录撑大。
   */
  _backupConfig() {
    if (!fs.existsSync(this.configPath)) return;
    const dir = path.join(path.dirname(this.configPath), 'config-backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // ⚠ 必须加随机后缀。旧实现只用 ISO 毫秒时间戳，于是**同一毫秒内的两次保存
    // 会写到同一个文件名**，后者直接覆盖前者 —— 而这个目录正是配置事故后唯一的安全网。
    // 实测（渲染/宿主审计 D6，冻结 Date 并发保存 3 次）：目录里只剩 1 个文件，
    // ORIGINAL 那份和中间态全部消失。注意 `ORIGINAL` 之所以能活下来，
    // 是因为它不带时间戳、不参与这个覆盖竞争 —— 这正说明覆盖在悄悄吃掉备份。
    let name = `gateway.config-${stamp}.json`;
    for (let i = 0; i < 8 && fs.existsSync(path.join(dir, name)); i++) {
      name = `gateway.config-${stamp}-${i}.json`;
    }
    fs.copyFileSync(this.configPath, path.join(dir, name));
    const olds = fs.readdirSync(dir).filter((n) => /^gateway\.config-.*\.json$/.test(n)).sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - 10))) {
      try { fs.unlinkSync(path.join(dir, n)); } catch (_) { /* 忽略 */ }
    }
  }

  /* ---------------- 代理 ---------------- */

  async resolveProxy() {
    try {
      const cfg = JSON.parse(this.configText() || '{}');
      if (cfg.proxy && cfg.proxy.enabled === false) {
        this.log('代理已显式关闭（proxy.enabled=false），直连。');
        return null;
      }
      if (cfg.proxy && cfg.proxy.enabled) {
        const u = String(cfg.proxy.url || '').trim();
        if (u) {
          const norm = u.includes('://') ? u : 'http://' + u;
          this.log('使用配置代理 ' + norm);
          return norm;
        }
        this.log('代理已启用但未填地址，回退自动探测…');
      }
    } catch (_) { /* 配置解析失败忽略 */ }
    return this.detectProxy();
  }

  /**
   * 计算 NO_PROXY 直连清单。规则（后面的步骤覆盖前面的）：
   *   · 回环 127.0.0.1 / localhost / ::1 → **永远直连**（自检、就绪探针绝不依赖代理）；
   *   · 国内端点 → 默认直连；
   *   · 供应商条目 `"proxy": false` / `"noProxy": true` → 该家直连；
   *   · 全局 `proxy.noProxy` → 显式列域名；
   *   · 全局 `proxy.forceProxy` → 从清单里剔除（强制走代理；回环除外）。
   */
  computeNoProxy() {
    const hosts = new Set();
    const norm = (v) => {
      const s = String(v || '').trim();
      if (!s) return '';
      let host = s;
      if (/^https?:\/\//i.test(s)) { try { host = new URL(s).hostname; } catch (_) { /* 原样 */ } }
      host = host.replace(/^\./, '').replace(/\/.*$/, '');
      return host;
    };
    const listOf = (v) => (Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []));
    LOOPBACK_NO_PROXY.forEach((h) => hosts.add(h));
    try {
      const cfg = JSON.parse(this.configText() || '{}');
      BUILTIN_DIRECT_HOSTS.forEach((h) => hosts.add(h));
      listOf(cfg.proxy && cfg.proxy.noProxy).forEach((v) => { const h = norm(v); if (h) hosts.add(h); });
      for (const p of Array.isArray(cfg.providers) ? cfg.providers : []) {
        if (!p || p.enabled === false) continue;
        if (p.proxy === false || p.noProxy === true) { const h = norm(p.baseURL); if (h) hosts.add(h); }
      }
      for (const v of listOf(cfg.proxy && cfg.proxy.forceProxy)) {
        const h = norm(v);
        if (h && !LOOPBACK_NO_PROXY.includes(h)) hosts.delete(h);
      }
    } catch (_) { /* 配置解析失败也必须保住回环直连 */ }
    return [...hosts].join(',');
  }

  /**
   * 探测本机代理。优先级：环境变量 > 系统代理设置 > 常用 clash 端口。
   *
   * **所有分支统一走"TCP 探测通过才用"**。代码注释一直宣称这是硬要求，但旧实现只对
   * 猜出来的 clash 端口（7890/7897）做了探测，环境变量与注册表两条路是**裸信**的。
   * 后果很隐蔽：继承来的 `HTTPS_PROXY` 指向一个已经退出/下线的代理时，网关照常显示
   * "运行中、/health 正常"（自检走的是恒直连的回环），而**每一个模型请求都 ECONNREFUSED**
   * —— 因为 Node ≥24 的 undici EnvHttpProxyAgent 没有"代理不可达就回退直连"的机制。
   * 用户侧表现是"网关好的，但所有模型都调不通"，极难定位。
   */
  async detectProxy() {
    const tryUse = async (raw, source) => {
      const norm = normalizeProxyUrl(raw);
      if (!norm) return '';
      if (await this.probeProxyUrl(norm)) return norm;
      this.log(`忽略${source}里的代理 ${norm}：TCP 连不上。`
        + '（不这样做的话，一个已下线的代理会让网关"健康"但所有模型请求都失败）');
      return '';
    };

    const env = process.env;
    const fromEnv = await tryUse(env.HTTPS_PROXY || env.https_proxy, '环境变量');
    if (fromEnv) return fromEnv;

    try {
      const stdout = await runPowerShell(
        "$p = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; "
        + 'if ($p.ProxyEnable -eq 1 -and $p.ProxyServer) { Write-Output $p.ProxyServer }',
        10000,
      );
      const fromReg = await tryUse(pickProxyFromRegistry(String(stdout || '').trim()), '系统设置');
      if (fromReg) return fromReg;
    } catch (_) { /* 忽略 */ }

    // clash/v2ray 常见混合端口兜底（400ms 探测，不阻塞启动）
    for (const port of [7890, 7897]) {
      // eslint-disable-next-line no-await-in-loop
      if (await this.probeTcp('127.0.0.1', port, 400)) return 'http://127.0.0.1:' + port;
    }
    return null;
  }

  /** TCP 连通探测（任何占用者都能检出）。 */
  probeTcp(host, port, timeoutMs) {
    return new Promise((resolve) => {
      const s = net.connect({ host, port }, () => { s.destroy(); resolve(true); });
      s.setTimeout(timeoutMs || 600, () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(false));
    });
  }

  /** 探测一个代理 URL 的 host:port 是否可连。 */
  async probeProxyUrl(url) {
    let host = '';
    let port = 0;
    try {
      const u = new URL(normalizeProxyUrl(url));
      host = u.hostname;
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch (_) { return false; }
    if (!host || !port) return false;
    return this.probeTcp(host, port, 600);
  }

  /* ---------------- 生命周期 ---------------- */

  /** 清理"孤儿网关"：只杀命令行里带**本程序配置文件路径**的引擎进程，绝不误杀别的程序。 */
  async killStaleGatewayProcesses() {
    const marker = this.configPath;
    if (!marker) return 0;
    return await killProcessesByCommandlines([marker], '网关：已清理残留网关进程', this.log);
  }

  /** 等待端口释放（taskkill 后 Windows 释放端口有延迟，否则新进程 EADDRINUSE）。 */
  async waitPortFree(port, timeoutMs) {
    const tryOnce = () => new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(false); });  // 连上=占用
      s.setTimeout(600, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(true));
    });
    const deadline = Date.now() + (timeoutMs || 4000);
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      if (await tryOnce()) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  async start() {
    if (this.proc) return;
    if (this._starting) return this._starting;      // 并发 start/restart 只执行一次
    this._starting = this._doStart();
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async _doStart() {
    if (this.proc) return;
    this.stopping = false;
    this.port = this.configPort();
    const mjs = this.mjsPath;
    if (!fs.existsSync(mjs)) {
      this.log('网关：缺少运行时 ' + mjs);
      this.emit('state');
      return;
    }
    // 每个 await 之后都复查一次 `stopping`：
    // 这段时间里用户完全可能点了「停止」（start 的互斥只防并发 start，不防 start 与 stop 竞争）。
    // 旧实现里 stop() 会因为 `this.proc === null` 直接返回（只置了 stopping/running），
    // 而这次启动不受影响、照常 spawn 并把 running 置回 true —— 结果是**用户点了停止、
    // 网关却处于运行状态**（实测确认）。用户在界面上得再点一次才停得掉。
    await this.killStaleGatewayProcesses();
    if (this.stopping) { this.log('网关：启动过程已取消（用户已请求停止）。'); this.emit('state'); return; }
    const freed = await this.waitPortFree(this.port, 4000);
    if (this.stopping) { this.log('网关：启动过程已取消（用户已请求停止）。'); this.emit('state'); return; }
    if (!freed) {
      this.log('网关：端口 ' + this.port + ' 仍被其他程序占用，请更换端口或释放它。');
      this.emit('state');
      return;
    }

    const node = this.resolveNode();
    this.log('网关：启动（端口 ' + this.port + '，运行时 ' + node.kind + '）…');

    const gwEnv = Object.assign({}, process.env, {
      DSH_GATEWAY_CONFIG: this.configPath,
      DSH_GATEWAY_LOG: this.logPath,
      DSH_GATEWAY_VERBOSE: '1',        // 逐请求日志同时进 stdout，界面日志框才能实时看到
    }, node.env);
    // PATH 就地更新（键名可能是 Path）：旧写法 `env.PATH = …` 在 Windows 上会新建一个
    // 大小写不同的重复键，子进程里完整 PATH 被整份丢掉（实测 19 项 → 3 项）。
    prependPath(gwEnv, [path.dirname(process.execPath)]);

    const proxy = await this.resolveProxy();
    // spawn 之前的最后一道复查（resolveProxy 会做 TCP 探测/注册表查询，可能要几百毫秒到十几秒）
    if (this.stopping) { this.log('网关：启动过程已取消（用户已请求停止）。'); this.emit('state'); return; }
    if (proxy) {
      gwEnv.NODE_USE_ENV_PROXY = '1';
      gwEnv.HTTPS_PROXY = proxy;
      gwEnv.HTTP_PROXY = proxy;
      const noProxy = this.computeNoProxy();
      if (noProxy) {
        gwEnv.NO_PROXY = noProxy;
        gwEnv.no_proxy = noProxy;
        this.log('网关：NO_PROXY 直连 ' + noProxy);
      }
      this.log('网关：进程走代理 ' + proxy);
    } else {
      // 显式直连：把**继承来的**代理变量一并清掉，否则"配置写了直连却仍走代理"，
      // 代理一死就是全网关 ECONNREFUSED（含回环自检）。
      for (const k of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
        delete gwEnv[k];
      }
    }

    this.proc = spawn(node.exe, [
      mjs,
      '--config', this.configPath,
      '--log', this.logPath,
      '--port', String(this.port),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gwEnv,
    });
    const spawned = this.proc;   // 身份快照：restart 期间旧进程迟到的 error/exit 不得改写新状态
    this.running = true;
    // `running` 只表示"子进程对象还在"，不表示"端口真的在监听"。
    // 下面 796 行会算出 `healthy`，但那以前只写一行日志 —— 于是"子进程活着但没 listen"
    //（首启被杀软/磁盘拖慢）时，界面弹「网关已启动」+ 状态点变绿，而每个客户端请求都失败。
    // 这正是本文件注释里说要修的那类"谎报已启动"，只是当时只覆盖了"子进程退出"那一半。
    this.ready = false;
    this.failed = false;   // 启动中：托盘显示琥珀色（见构造函数里 failed 的说明）
    this.emit('state');

    const onData = (chunk) => { this.pushLog(chunk.toString('utf8')); };
    if (this.proc.stdout) this.proc.stdout.on('data', onData);
    if (this.proc.stderr) this.proc.stderr.on('data', onData);

    this.proc.on('error', (err) => {
      if (this.proc !== spawned) return;
      this.log('网关进程错误：' + (err && err.message ? err.message : err));
      // spawn 失败时 Node 只发 'error'（'exit' 可能永不触发）。不清 proc 的话 start() 的
      // `if (this.proc) return` 门闩永久生效——用户点「启动」毫无反应。
      this.proc = null;
      this.running = false;
      this.emit('state');
      this._scheduleHeal();
    });
    this.proc.on('exit', (code) => {
      if (this.proc !== spawned) return;
      this.proc = null;
      this.running = false;
      this.log('网关已退出（退出码 ' + code + '）');
      this.emit('state');
      if (!this.stopping) this._scheduleHeal(code);
    });

    // 就绪确认：引擎 listen 需 1-3 秒，单次探测会在就绪前误报"探测未通过"。
    let healthy = false;
    for (let i = 0; i < 8 && !healthy; i++) {
      // eslint-disable-next-line no-await-in-loop
      healthy = await this.probeHealth(2000);
      // eslint-disable-next-line no-await-in-loop
      if (!healthy) await new Promise((r) => setTimeout(r, 800));
    }
    if (healthy) this.log('网关已就绪：http://127.0.0.1:' + this.port + '/v1');
    else this.log('网关端口探测未通过（可能配置错误，请查看日志）。');
    // 只有真的探测通过才算"就绪"。子进程已经退出时不要把它标成 ready
    //（下面 this.proc !== spawned 说明期间发生了 exit/restart）。
    this.ready = healthy && this.proc === spawned;
    // 探测未通过且子进程还在 = 启动失败（托盘据此变红，见构造函数里 failed 的说明）
    this.failed = !this.ready && this.proc === spawned;
    this.emit('state');
  }

  /**
   * 自愈：引擎意外退出（self-watchdog 自杀/崩溃）且非用户主动停止时自动重启。
   * 上限用**滑动窗口**（10 分钟 5 次）——旧版"一次健康探测通过就清零计数"会把
   * "每 3 分钟自杀一次"判成"每次都健康"，从而无限重启。
   */
  _scheduleHeal(exitCode) {
    const now = Date.now();
    this._healTimes = (this._healTimes || []).filter((t) => now - t < 10 * 60 * 1000);
    if (this._healTimes.length >= 5) {
      this.log('网关：10 分钟内已自愈重启 ' + this._healTimes.length + ' 次仍未稳定，停止自动重启（请检查配置/端口/上游）。');
      this.crash.record('gateway', null, {
        phase: '网关反复异常退出，已停止自愈',
        context: { exitCode, healCount: this._healTimes.length, windowMinutes: 10 },
        config: this.configObject(),
        logTail: this.logTail,
      });
      this.emit('state');
      return;
    }
    this._healTimes.push(now);
    this.log('网关异常退出，3 秒后自动重启（self-heal ' + this._healTimes.length + '/5，10 分钟窗口）…');
    setTimeout(async () => {
      if (this.stopping) return;
      // ⚠ 必须先等"正在飞行的那次启动"落地，再决定要不要重启。
      //
      // 旧实现直接 `this.start()`，而 start() 的互斥是 `if (this._starting) return this._starting;`
      // —— 如果这次退出发生在**首次启动的就绪探测循环期间**（引擎"起来就退"是最常见的故障形态，
      // 探测循环本身最长约 22 秒），这个自愈调用会原样返回那次还在飞的旧启动，
      // 于是**永远不会有第二次 spawn**，也不会有任何提示（实测：heals=1, spawnAttempts=1,
      // running=false，35 秒内再无尝试；而"就绪之后才死"的对照组 5 次上限逻辑完全正常）。
      if (this._starting) {
        try { await this._starting; } catch (_) { /* 忽略：下面的判断才是关键 */ }
      }
      if (this.stopping || this.proc) return;
      this.start().catch((e) => this.log('网关自愈重启失败：' + (e && e.message ? e.message : e)));
    }, 3000);
  }

  async stop() {
    this.stopping = true;
    // 若一次启动正在飞行，先等它落地：它在每个 await 之后都会复查 stopping 并在 spawn 前退出。
    // 不等的话存在一个窗口——stop() 看到 this.proc 还是 null 就返回"已停止"，
    // 而紧接着 _doStart 完成 spawn，网关又跑起来了（用户点了停止，网关却活着）。
    if (this._starting) {
      try { await this._starting; } catch (_) { /* 忽略：下面的收尾才是关键 */ }
    }
    const p = this.proc;
    this.proc = null;
    this.running = false; this.ready = false; this.failed = false;   // 提前返回路径也要复位，否则界面一直显示"运行中"
    if (!p || p.exitCode !== null) { this.emit('state'); return; }
    try {
      const r = spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
      if (r.status !== 0) p.kill();
    } catch (_) {
      try { p.kill(); } catch (_) { /* 忽略 */ }
    }
    this.log('网关已停止。');
    this.emit('state');
  }

  async restart() {
    await this.stop();
    await this.killStaleGatewayProcesses();     // 其他实例/旧版本的残留也会占端口、延续旧熔断状态
    await this.waitPortFree(this.port, 4000);
    await this.start();
  }

  /* ---------------- 健康 ---------------- */

  /** /health 探测：**只认 200**。3xx/4xx 也当健康的话，端口被别的 HTTP 服务占用时会误判。 */
  probeHealth(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/health', timeout: timeoutMs }, (res) => {
        res.resume();
        res.on('error', () => { /* 已在下方按状态码判定 */ });
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  /**
   * 完整健康快照（/health 的 JSON：ok / accounts 账户池 / proxy 代理状态）。
   * 界面用它把"哪把 Key 在冷却、为什么"与"走不走代理"直接显示出来——这些信息
   * 引擎一直在返回，但旧界面从未展示。
   */
  healthSnapshot(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/health', timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 512 * 1024) body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, error: 'HTTP ' + res.statusCode });
          try { resolve(JSON.parse(body)); } catch (e) { resolve({ ok: false, error: '响应不是 JSON' }); }
        });
        res.on('error', (e) => resolve({ ok: false, error: String(e && e.message) }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '探测超时' }); });
      req.on('error', (e) => resolve({ ok: false, error: String(e && e.message) }));
    });
  }

  /** 网关统一 Key（写客户端配置时要用）。 */
  apiKey() {
    const cfg = this.configObject();
    return String((cfg && cfg.apiKey) || '').trim();
  }

  getState() {
    // port 用 **configPort()**（磁盘上的权威值）而不是 this.port（只在 _doStart 时更新）。
    // 旧写法下"停止状态下改了端口"，界面（概览的接入信息、复制出去的 Base URL）会继续显示
    // 旧端口——用户把那个地址粘进客户端就连不上（实测确认）。
    const port = this.running ? this.port : this.configPort();
    return {
      running: this.running,
    // ⚠ `ready` 只在 running 时才有意义。子进程崩溃退出时 exit 处理器只把 running 置 false，
    // 而 ready 会留在 true —— 自愈 5 次耗尽后（不再有下一次 _doStart 来复位）这个矛盾态**永久**保留，
    // 中间还有约 3 秒的 `running=false / ready=true` 窗口。
    // 在这里收口比在 exit/error 里各补一行可靠：任何"子进程没了"的路径都覆盖得到。
    ready: this.running && !!this.ready,
      port,
      configPath: this.configPath,
      baseUrl: 'http://127.0.0.1:' + port + '/v1',
      dataDir: this.dataDir,
    };
  }

  /* ---------------- 日志 ---------------- */

  pushLog(text) {
    this.logTail = (this.logTail + text).slice(-LOG_TAIL_MAX);
    // "网关有输出" ⟺ "有模型请求在流动"：这是"模型正在思考、还没落盘"那段空档里
    // 唯一可观测的信号（托盘/退出保护都依赖它）。
    this.lastActivityAt = Date.now();
    const now = Date.now();
    if (!this._logEmitAt || now - this._logEmitAt > 800) {   // 节流：避免逐字节刷爆 IPC
      this._logEmitAt = now;
      this.emit('log');
    }
  }

  logTailText(maxChars) {
    const n = maxChars || 64 * 1024;
    return this.logTail.slice(-n);
  }

  clearLog() {
    this.logTail = '';
    this.emit('log');
  }
}

module.exports = {
  GatewayManager,
  validateConfigText,
  killProcessesByCommandlines,
  runPowerShell,
  normalizeProxyUrl,
  pickProxyFromRegistry,
  LOOPBACK_NO_PROXY,
  BUILTIN_DIRECT_HOSTS,
};
