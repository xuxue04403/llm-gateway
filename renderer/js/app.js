/* app.js — 启动引导与全局接线 */
'use strict';

let healthTimer = null;

/**
 * 取主进程状态。
 *
 * ⚠ 必须把形状**补齐**，而且不能只判 `s.gateway` 真值：
 * 旧写法 `Object.assign({默认}, s || {})` 在 `s = {gateway: null}` 时会把 null **又覆盖回去**，
 * 而 `renderTopbar()` 直接读 `st.gateway.running` → 整个界面在 boot 阶段抛错、
 * 被 catch 换成"界面启动失败"红字（网关/供应商/设置全看不到）。
 * `s.app = null` 同理（`st.app.version`）。
 * 主进程正常不会给这种形状，但 preload 与主进程版本不匹配时就会。
 */
function normalizeState(s) {
  const src = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
  const gwIn = (src.gateway && typeof src.gateway === 'object' && !Array.isArray(src.gateway)) ? src.gateway : {};
  const appIn = (src.app && typeof src.app === 'object' && !Array.isArray(src.app)) ? src.app : {};
  return Object.assign({
    dataDir: '', settings: {}, configOk: true,
  }, src, {
    gateway: Object.assign({
      running: false, port: 0, baseUrl: '', apiKey: '', apiKeyMasked: '',
      autoStart: false, minimizeToTray: false, autoStartApp: false, loginItem: false,
    }, gwIn),
    app: Object.assign({ name: 'LLM Gateway', version: '', electron: '', node: '' }, appIn),
    settings: (src.settings && typeof src.settings === 'object') ? src.settings : {},
    dataDir: typeof src.dataDir === 'string' ? src.dataDir : '',
  });
}

async function loadState() {
  let s = null;
  try {
    s = await window.lgw.state();
  } catch (_) { /* 走下面的兜底形状 */ }
  LG.state = normalizeState(s);
}

async function loadConfig() {
  const r = await window.lgw.gwAction('get-config');
  setConfigFromText(r && r.ok ? r.text : '{}');
}

function wireNav() {
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

function wireTopbar() {
  $('#btnStart').addEventListener('click', async () => {
    toast('正在启动网关…', '', 2000);
    const r = await window.lgw.gwAction('start');
    if (!r.ok) toast('启动失败：' + r.error, 'err');
    else { toast('网关已启动', 'ok'); refreshHealth(); }
  });
  $('#btnStop').addEventListener('click', async () => {
    const r = await window.lgw.gwAction('stop');
    if (!r.ok) toast('停止失败：' + r.error, 'err');
    else { toast('网关已停止', 'warn'); LG.health = null; }
  });
  $('#btnRestart').addEventListener('click', async () => {
    toast('正在重启网关…', '', 2000);
    const r = await window.lgw.gwAction('restart');
    if (!r.ok) toast('重启失败：' + r.error, 'err');
    else { toast('网关已重启', 'ok'); refreshHealth(); }
  });
}

function wireDirtyBar() {
  $('#btnSaveConfig').addEventListener('click', () => saveConfig());
  $('#btnDiscard').addEventListener('click', () => discardConfig());
}

function wireModal() {
  $('#btnModalClose').addEventListener('click', () => Modal.close());
  $('#modalMask').addEventListener('click', (e) => { if (e.target === $('#modalMask')) Modal.close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && Modal.isOpen()) Modal.close();
    if (e.key === 'Escape') closeEditor();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (LG.dirty) saveConfig();
    }
  });
  // 抽屉与弹窗互斥：打开抽屉时若弹窗开着，先收起来
  $('#editorMask').addEventListener('click', () => closeEditor());
}

function startHealthLoop() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    if (LG.state && LG.state.gateway.running) refreshHealth();
  }, 5000);
  refreshHealth();
}

function renderEverything() {
  renderAll();
}

async function boot() {
  wireNav();
  wireTopbar();
  wireDirtyBar();
  wireModal();

  // 各区块初始化（DOM 已就绪）
  LG.initDashboard();
  LG.initProviders();
  LG.initModels();
  LG.initSettings();
  LG.initLogs();

  // 日志页要能立刻看到"上一次会话"的网关日志（进程重启后内存缓冲是空的，但日志文件有货）。
  // 旧实现里 gw:state 没在 preload 上绑定，这段是空操作 → 日志页启动后永远是空的。
  try {
    const full = await window.lgw.gwState();
    if (full && typeof full.log === 'string') setLogText(full.log);
    if (full && full.app) LG.state = full;
  } catch (_) { /* 拿不到就算了，后面的 onState 会补 */ }

  await loadState();
  await loadConfig();
  renderEverything();
  switchView('dashboard');

  // 配置文件坏掉时明确告知：否则用户只看到"0 个供应商"，会以为是程序的问题
  if (LG.state && LG.state.configOk === false) {
    toast('配置文件不是合法 JSON，已按空配置显示。修好或从备份恢复后才能保存（磁盘上的原文件没有被覆盖）。', 'err', 20000);
  }

  // 一键写入的目标检测（子进程 + 读磁盘，异步做，不挡首屏）
  // ⚠ 必须包 try/catch：这是**可选**功能，它失败不该把已经渲染好的整个界面干掉
  //（旧实现没有保护，检测一挂就走到最外层 catch → 整页变红字）。
  // 同时保留"没检测过"与"检测到 0 个"的区别：null = 还没检测，[] = 检测了但没有目标。
  LG.clientDetect = null;
  try {
    const det = await window.lgw.writeDetect();
    if (det && det.ok === false && !(det.targets || []).length) {
      LG.clientDetect = [];
      toast('客户端检测失败：' + (det.error || '未知原因'), 'warn', 8000);
    } else {
      LG.clientDetect = (det && Array.isArray(det.targets)) ? det.targets : [];
    }
  } catch (e) {
    LG.clientDetect = [];
    toast('客户端检测失败：' + ((e && e.message) || e), 'warn', 8000);
  }
  LG.initClients();

  // 订阅主进程推送
  window.lgw.onState((snap) => {
    const wasRunning = LG.state && LG.state.gateway.running;
    const portChanged = LG.state && LG.state.gateway.port !== snap.gateway.port;
    LG.state = snap;
    renderAll();
    if (LG.activeView === 'settings') LG.renders.settings();
    if (!wasRunning && snap.gateway.running) refreshHealth();
    if (portChanged) {
      toast('网关端口已变为 ' + snap.gateway.port, 'warn', 5000);
      refreshHealth();
    }
  });
  window.lgw.onLog((text) => setLogText(text));

  startHealthLoop();
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((e) => {
    // ⚠ 用 textContent 而不是 innerHTML：错误栈里可能带外部字符串（文件路径、上游回显的文本），
    // 拼进 innerHTML 等于给自己留一条"只剩 CSP 一道防线"的注入路径。
    const box = document.createElement('div');
    box.style.cssText = 'padding:40px;color:#ff9c9c;font:13px Consolas;white-space:pre-wrap';
    box.textContent = '界面启动失败：\n' + String((e && e.stack) || e);
    document.body.replaceChildren(box);
  });
});
