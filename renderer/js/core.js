/* core.js — 共享状态、配置工作副本、通用 UI 原语
 *
 * 设计要点
 *  · 配置以**对象工作副本**（LG.config）形式在内存里编辑，只有点「保存并生效」才落盘。
 *    好处：可以整体校验、可以「放弃更改」、可以在保存前把校验错误一次列全。
 *  · 每个区块（providers / models / clients / settings / logs）各自注册一个 render 函数，
 *    状态变化时统一重绘——避免旧实现里"某个面板忘了刷新"的半同步状态。
 *  · 渲染一律走 esc() 转义：模型名、供应商 id、上游返回的目录名都是**外来字符串**，
 *    直接拼 HTML 就会被注入。
 */
'use strict';

const LG = {
  state: null,          // 主进程状态快照
  config: null,         // 网关配置工作副本（对象）
  configLoaded: false,
  dirty: false,
  logText: '',
  health: null,
  testResults: {},      // providerId -> 探测结果
  clientDetect: [],     // 一键写入目标的检测结果
  clientDetectError: '', // 检测失败的原因（非空即"失败"，与"检测到 0 个"区分开）
  renders: {},          // view -> render 函数
  activeView: 'dashboard',
};

/* ---------------- DOM 原语 ---------------- */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 把值安全地塞进 HTML 属性（用于 data-* ）。 */
function attr(s) { return esc(s); }

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

/* ---------------- Toast ---------------- */

function toast(msg, kind, ms) {
  const box = $('#toasts');
  const n = el('div', 'toast ' + (kind || ''), esc(msg));
  box.appendChild(n);
  setTimeout(() => {
    n.style.transition = 'opacity .2s, transform .2s';
    n.style.opacity = '0';
    n.style.transform = 'translateY(6px)';
    setTimeout(() => n.remove(), 220);
  }, ms || (kind === 'err' ? 7000 : 3400));
}

/* ---------------- 剪贴板 ---------------- */

async function copy(text) {
  const r = await window.lgw.copyText(String(text == null ? '' : text));
  if (r && r.ok) toast('已复制到剪贴板', 'ok', 1600);
  else toast('复制失败：' + ((r && r.error) || '未知错误'), 'err');
  return r;
}

/* ---------------- 弹窗 ---------------- */

const Modal = {
  open(opts) {
    $('#modalTitle').textContent = opts.title || '';
    $('#modalBody').innerHTML = opts.body || '';
    const foot = $('#modalFoot');
    foot.innerHTML = '';
    (opts.buttons || []).forEach((b) => {
      const btn = el('button', 'btn ' + (b.cls || ''), esc(b.label));
      btn.addEventListener('click', () => {
        if (b.onClick) b.onClick(btn);
        if (b.close !== false) Modal.close();
      });
      foot.appendChild(btn);
    });
    $('#modalMask').classList.remove('hidden');
    if (opts.onOpen) opts.onOpen();
  },
  close() { $('#modalMask').classList.add('hidden'); },
  isOpen() { return !$('#modalMask').classList.contains('hidden'); },
};

/* ---------------- 配置工作副本 ---------------- */

function setConfigFromText(text) {
  try {
    LG.config = JSON.parse(String(text || '{}'));
  } catch (_) {
    LG.config = { port: 3091, apiKey: '', providers: [] };
  }
  if (!Array.isArray(LG.config.providers)) LG.config.providers = [];
  // ⚠ 过滤掉非对象条目。手改 JSON、别的工具写出、或删除条目时留下 `null` 都会出现这种配置，
  // 而**下游全都假设 providers[i] 是对象**：dashboard 读 `p.enabled`、providers 读 `p.id` …
  // 一旦抛错，renderAll 的 try/catch 会**逐视图吞掉**，表现为"概览页统计卡停在 0/0、
  // 接入信息整块不渲染"，界面上没有任何提示（用户只会觉得"这软件坏了"）。
  // 在这里一次性收口，比在十几处渲染代码里各加一个判空可靠。
  LG.config.providers = LG.config.providers.filter((p) => p && typeof p === 'object' && !Array.isArray(p));
  LG.configLoaded = true;
  LG.dirty = false;
  updateDirtyBar();
}

function configText() {
  return JSON.stringify(LG.config, null, 2) + '\n';
}

function markDirty(what) {
  if (!LG.dirty) {
    LG.dirty = true;
    updateDirtyBar(what);
  } else if (what) {
    updateDirtyBar(what);
  }
}

function updateDirtyBar(what) {
  const bar = $('#dirtyBar');
  if (LG.dirty) {
    bar.classList.remove('hidden');
    $('#dirtyText').textContent = what ? ('有未保存的更改：' + what) : '配置有未保存的更改';
  } else {
    bar.classList.add('hidden');
  }
}

async function saveConfig() {
  const text = configText();
  const v = await window.lgw.gwValidate(text);
  if (!v.ok) {
    toast('配置未通过校验：' + v.error, 'err', 9000);
    Modal.open({
      title: '配置校验失败',
      body: `<div class="guard">${esc(v.error)}</div>
        <p class="hint">配置<b>没有</b>写入。修好后可再点「保存并生效」。</p>`,
      buttons: [{ label: '知道了', cls: 'btn-primary' }],
    });
    return false;
  }
  const r = await window.lgw.gwSaveConfig(text);
  if (!r.ok) { toast('保存失败：' + r.error, 'err', 9000); return false; }
  LG.dirty = false;
  updateDirtyBar();
  if (r.warning) toast(r.warning, 'warn', 12000);
  else toast('配置已保存并生效', 'ok');
  return true;
}

async function reloadConfig() {
  const r = await window.lgw.gwAction('get-config');
  if (r && r.ok) setConfigFromText(r.text);
}

function discardConfig() {
  reloadConfig().then(() => {
    renderAll();
    toast('已放弃未保存的更改', 'warn', 2200);
  });
}

/* ---------------- 派生数据 ---------------- */

function enabledProviders() {
  return (LG.config && LG.config.providers || []).filter((p) => p && p.enabled !== false);
}

/**
 * 模型条目（与 writers/models.js 的 modelEntries **同规则**）。
 *
 * ⚠ 这里必须把 `contextWindow` / `maxTokens` 一并带出来，否则会**静默丢数据**：
 * 编辑抽屉是"读 modelEntriesOf → 填进输入框 → readEditorModels 写回"的往返，
 * 这两个字段一旦不在这里出现，输入框就是空的，用户点「应用」时它们就被抹掉了
 * （实测：`{id:'m2', as:'m2-alias', contextWindow:200000, maxTokens:8000, vision:true}`
 *  → 应用后变成 `{id:'m2', as:'m2-alias', vision:true}`）。
 * 连带影响：模型总览页的"上下文/最大输出"两列恒为 —，dsh 写入也拿不到真值、
 * 退回默认的 1024000（等于向上游虚报上下文窗口）。
 */
function modelEntriesOf(p) {
  const out = [];
  for (const m of (p && Array.isArray(p.models) ? p.models : [])) {
    if (typeof m === 'string') { const s = m.trim(); if (s) out.push({ up: s, as: s }); continue; }
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      const up = String(m.id ?? m.up ?? m.upstream ?? m.model ?? '').trim();
      if (!up) continue;
      const as = String(m.as ?? m.alias ?? m.model ?? m.name ?? up).trim() || up;
      const vision = m.vision === true || (Array.isArray(m.input) && m.input.map((x) => String(x).toLowerCase()).includes('image'));
      const e = { up, as };
      if (vision) e.vision = true;
      const ctxWin = Number(m.contextWindow ?? m.context ?? m.ctx);
      const maxTok = Number(m.maxTokens ?? m.maxOutputTokens ?? m.max_output_tokens);
      if (Number.isFinite(ctxWin) && ctxWin > 0) e.contextWindow = ctxWin;
      if (Number.isFinite(maxTok) && maxTok > 0) e.maxTokens = maxTok;
      // 逐模型超时：同样必须原样带出。这个函数的往返（读→填表→写回）正是
      // contextWindow/maxTokens 曾经被静默抹掉的地方，新字段不能再踩同一个坑。
      const tmo = Number(m.timeoutMs);
      if (Number.isFinite(tmo) && tmo > 0) e.timeoutMs = tmo;
      out.push(e);
    }
  }
  return out;
}

function collectModels() {
  const map = new Map();
  for (const p of enabledProviders()) {
    for (const e of modelEntriesOf(p)) {
      let r = map.get(e.as);
      if (!r) { r = { id: e.as, vision: false, contextWindow: null, maxTokens: null, providers: [] }; map.set(e.as, r); }
      if (!r.providers.includes(p.id)) r.providers.push(p.id);
      if (e.vision) r.vision = true;
      const ctx = Number((e.contextWindow || 0));
      const mt = Number((e.maxTokens || 0));
      if (ctx) r.contextWindow = r.contextWindow ? Math.min(r.contextWindow, ctx) : ctx;
      if (mt) r.maxTokens = r.maxTokens ? Math.min(r.maxTokens, mt) : mt;
    }
  }
  return [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true, sensitivity: 'base' }));
}

function modelNames() { return collectModels().map((m) => m.id); }

function fmtNum(n) {
  const v = Number(n || 0);
  if (!v) return '—';
  if (v >= 1048576 && v % 1048576 === 0) return (v / 1048576) + 'M';
  if (v >= 1000) return Math.round(v / 1000) + 'K';
  return String(v);
}

function baseUrlOf(port, withV1) {
  return 'http://127.0.0.1:' + port + (withV1 === false ? '' : '/v1');
}

/* ---------------- 渲染调度 ---------------- */

function renderAll() {
  for (const k of Object.keys(LG.renders)) {
    try { LG.renders[k](); } catch (e) { console.error('render ' + k + ' 失败', e); }
  }
  renderTopbar();
}

function renderTopbar() {
  const st = LG.state;
  if (!st) return;
  const running = st.gateway.running;
  // `ready` = 端口真的在监听。只有 running 时界面说"运行中"会在"子进程活着但没 listen"
  // 的那段时间骗人（每个客户端请求都会失败）。三态：运行中 / 启动中 / 已停止。
  const ready = running && !!st.gateway.ready;
  const pill = $('#statusPill');
  pill.querySelector('.dot').className = 'dot ' + (ready ? 'on' : (running ? 'warn' : 'off'));
  $('#statusText').textContent = ready ? ('运行中 · 端口 ' + st.gateway.port)
    : (running ? '启动中…（端口尚未就绪）' : '已停止');
  $('#endpointText').textContent = running
    ? ('OpenAI ' + baseUrlOf(st.gateway.port, true) + '   ·   Anthropic ' + baseUrlOf(st.gateway.port, false))
    : (st.gateway.configPath || '');
  $('#btnStart').disabled = ready;   // 启动中仍允许再点（幂等），但已就绪就不必了
  $('#btnStop').disabled = !running;
  $('#btnRestart').disabled = !running;
  $('#brandVer').textContent = 'v' + st.app.version;
  $('#navCountProviders').textContent = String(enabledProviders().length);
  $('#navCountModels').textContent = String(modelNames().length);
}

function switchView(name) {
  LG.activeView = name;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (LG.renders[name]) {
    try { LG.renders[name](); } catch (e) { console.error(e); }
  }
}

/* ---------------- 通用：账号池展示 ---------------- */

const COOL_KIND = {
  credit: { text: '额度耗尽', cls: 'bad' },
  session: { text: '登录失效', cls: 'bad' },
  rate: { text: '限流', cls: 'warn' },
  network: { text: '网络错误', cls: 'warn' },
  auth: { text: '鉴权失败', cls: 'bad' },
};

function fmtRemain(untilMs) {
  const ms = Number(untilMs || 0) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '已过期';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟';
  return (m / 60).toFixed(1) + ' 小时';
}

// 这些是**经典脚本的顶层声明**，后续 <script> 直接可见（无需再挂到 window 上）。
// 只把状态对象显式挂出去，方便在开发者工具里查看。
window.LG = LG;
