// main.js — LLM Gateway 桌面版主进程
//
// 结构：
//   bootstrap()  解析数据目录 → 日志 → 设置 → 网关管理器 → 窗口/托盘
//   IPC          gw:*   网关状态与动作
//                write:* 一键写入（探测 / 预览 / 执行 / 恢复）
//                app:*   设置、剪贴板、打开路径、自启
//
// 一条硬规则：**主进程不做重活**。所有可能阻塞的操作（spawn 引擎、探测上游、跑 PowerShell）
// 都是异步的；窗口创建与快捷输入绝不能等它们（历史事故：spawnSync 冻住主进程数秒，
// 窗口/托盘全无响应）。
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, dialog, nativeImage, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveDataDir, importGatewayConfig } = require('./datadir');
const { Logger, registerSecret, scrubDeepSecrets } = require('./logger');
const { Settings } = require('./settings');
const { GatewayManager, validateConfigText } = require('./gateway-manager');
const writers = require('./writers');
const probe = require('./probe');
const modelMeta = require('./model-meta');
const clientHeaders = require('./client-headers');
const icon = require('./icon');

const APP_NAME = 'LLM Gateway';

let dataDir = '';
let logger = null;
let settings = null;
let gateway = null;
let win = null;
let tray = null;

/**
 * 退出状态机。**两个标志是必要的，不能合成一个**：
 *
 *   teardownStarted —— "收尾已经开始"，防止 before-quit 被重入时重复 stop/重复 preventDefault。
 *   allowQuit       —— "这次是真的要退"，让窗口的 close 处理器不再拦（否则 minimizeToTray
 *                       开着时 app.quit() 会被自己的 close 拦截器取消，程序退不掉）。
 *
 * 曾经的实现只有一个 `quitting`，于是出现两个真实缺陷：
 *   ① 托盘「退出」先置 quitting=true 再 app.quit() → before-quit 看到 quitting 就 return
 *      → **gateway.stop() 从未执行**，网关子进程成为孤儿、继续占着端口；父进程退出并不
 *      自动带走子进程（Windows 上 spawn 的子进程不随父进程消亡）。
 *   ② minimizeToTray 关掉后点窗口 × → 窗口关了但 window-all-closed 里因为 `!settings`
 *      为假而**不退出**，程序变成没窗口的幽灵进程（只剩托盘）。
 */
let teardownStarted = false;
let allowQuit = false;

/* ------------------------------------------------------------------ *
 * 单实例
 * ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

/* ------------------------------------------------------------------ *
 * 窗口 / 托盘
 * ------------------------------------------------------------------ */

function appIcon(size) {
  try { return nativeImage.createFromDataURL(icon.iconDataURL(size || 256, icon.COLORS.brand)); } catch (_) { return undefined; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1319',
    title: APP_NAME,
    icon: appIcon(256),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (settings.get('openDevTools')) win.webContents.openDevTools({ mode: 'detach' });
  });

  // 渲染层的报错也要进日志：界面白屏/按钮没反应时，用户唯一能提供的证据就是日志文件。
  // （限速：同一秒内最多 20 条，防止某个循环错误把日志刷爆。）
  //
  // ⚠ 事件签名随 Electron 版本变过：旧版是 (event, level, message, line, sourceId)，
  // 新版把负载收进单个事件对象（event.level / event.message / event.lineNumber / event.sourceId）。
  // 这里两种都认 —— 只按旧签名取值的话，日志里会出现 `[界面] undefined (x.js:0)`，
  // 等于渲染层报错根本没被记下来（实测踩到）。
  let consoleBurst = 0;
  let consoleBurstAt = 0;
  win.webContents.on('console-message', (...args) => {
    let level;
    let message;
    let line;
    let sourceId;
    const first = args[0];
    if (first && typeof first === 'object' && typeof first.message === 'string') {
      level = first.level;
      message = first.message;
      line = first.lineNumber;
      sourceId = first.sourceId;
    } else {
      [, level, message, line, sourceId] = args;
    }
    const now = Date.now();
    if (now - consoleBurstAt > 1000) { consoleBurstAt = now; consoleBurst = 0; }
    if (consoleBurst++ > 20) return;
    // 新版 level 是字符串（'info'|'warning'|'error'|'debug'），旧版是数字
    const isErr = level === 'error' || Number(level) >= 2;
    const isWarn = level === 'warning' || level === 'warn' || Number(level) === 1;
    const where = sourceId ? ` (${String(sourceId).split(/[\\/]/).pop()}:${line})` : '';
    const text = String(message == null ? '' : message) + where;
    if (isErr) logger.error('[界面] ' + text);
    else if (isWarn) logger.warn('[界面] ' + text);
    else logger.info('[界面] ' + text);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('[界面] 渲染进程退出：' + JSON.stringify(details));
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error(`[界面] 页面加载失败 ${code} ${desc} ${url}`);
  });

  // 开发期无头冒烟：LLM_GATEWAY_SMOKE=<png 路径> 时逐个视图截屏 + 落一份可核对的事实 JSON，
  // 然后退出。打包产物里不生效（`!app.isPackaged`）。写这段是因为界面问题不能只靠肉眼——
  // 冒烟产物里的 state/health 能直接证明"网关真的起来了、/health 真的通了、配置真的导入了"。
  if (!app.isPackaged && process.env.LLM_GATEWAY_SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const out = process.env.LLM_GATEWAY_SMOKE;
        const views = ['dashboard', 'providers', 'models', 'clients', 'settings', 'logs'];
        try {
          const snap = stateSnapshot();
          if (snap.gateway) snap.gateway.apiKey = maskKey(snap.gateway.apiKey);
          const facts = {
            at: new Date().toISOString(),
            state: snap,
            health: gateway.running ? await gateway.healthSnapshot(4000) : null,
            models: require('./writers/models').collectModelNames(gateway.configObject() || {}),
            views: {},
          };
          for (const v of views) {
            // eslint-disable-next-line no-await-in-loop
            await win.webContents.executeJavaScript(`(function(){ if (typeof switchView === 'function') switchView(${JSON.stringify(v)}); return document.querySelectorAll('.view.active').length; })()`);
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 450));
            // eslint-disable-next-line no-await-in-loop
            const png = (await win.webContents.capturePage()).toPNG();
            const p = out.replace(/\.png$/i, '') + '-' + v + '.png';
            fs.writeFileSync(p, png);
            facts.views[v] = { png: p, bytes: png.length };
          }
          fs.writeFileSync(out + '.json', JSON.stringify(facts, null, 2), 'utf8');
          logger.info('[冒烟] 已截屏 ' + views.length + ' 个视图 → ' + out);
        } catch (e) {
          logger.error('[冒烟] 失败：' + (e && e.message ? e.message : e));
        }
        // LLM_GATEWAY_SMOKE_QUIT=1：走**正常退出路径**（app.quit()），用于回归
        // "退出后不得留下孤儿网关进程"这条。默认走快速退出（app.exit）。
        if (process.env.LLM_GATEWAY_SMOKE_QUIT) {
          logger.info('[冒烟] 触发正常退出路径（app.quit）…');
          app.quit();
          return;
        }
        try { await gateway.stop(); } catch (_) { /* 忽略 */ }
        allowQuit = true;
        app.exit(0);
      }, Number(process.env.LLM_GATEWAY_SMOKE_DELAY || 4000));
    });
  }

  // 关闭按钮 → 最小化到托盘（保持网关继续跑）；真正退出走托盘菜单。
  // allowQuit 为真时必须放行，否则 app.quit() 会被这里拦掉、程序退不掉。
  win.on('close', (e) => {
    if (allowQuit) return;
    if (settings.get('minimizeToTray') !== false) {
      e.preventDefault();
      win.hide();
    }
  });

  // 同窗口导航一律拒绝：preload 桥是挂在 webContents 上的，**任何**被加载进这个窗口的
  // 页面都会拿到 window.lgw（含读配置、写文件、执行写入的能力）。只拦 setWindowOpenHandler
  // 是不够的——那只管新窗口，同一窗口的 location.href / <a href> / 表单提交走的是 will-navigate。
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppPage(url)) return;
    e.preventDefault();
    logger.warn('[界面] 已拦截页面内导航：' + url);
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  // 禁止在本窗口里挂 webview（同样是"外部内容拿到 preload 桥"的口子）
  win.webContents.on('will-attach-webview', (e) => {
    e.preventDefault();
    logger.warn('[界面] 已拦截 webview 挂载');
  });

  // 外部链接一律交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** 是否为本应用自带的渲染页（只有它允许被加载/导航到）。 */
function isAppPage(url) {
  const u = String(url || '');
  if (!u) return false;
  if (u.startsWith('devtools://')) return true;      // 开发者工具自身
  if (/^https?:\/\//i.test(u)) return false;
  try {
    const rendererDir = path.join(__dirname, '..', 'renderer');
    const p = decodeURIComponent(u.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, ''))
      .replace(/\//g, path.sep).split('?')[0].split('#')[0];
    return path.resolve(p).toLowerCase().startsWith(path.resolve(rendererDir).toLowerCase());
  } catch (_) { return false; }
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayIcon() {
  const color = gateway && gateway.running ? icon.COLORS.ready : icon.COLORS.stopped;
  try { return nativeImage.createFromDataURL(icon.iconDataURL(16, color)); } catch (_) { return appIcon(16); }
}

function refreshTray() {
  if (!tray) return;
  const running = !!(gateway && gateway.running);
  tray.setImage(trayIcon());
  tray.setToolTip(`${APP_NAME} · ${running ? '运行中 :' + gateway.port : '已停止'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? `运行中 · 端口 ${gateway.port}` : '已停止', enabled: false },
    { type: 'separator' },
    { label: '打开面板', click: () => showWindow() },
    { label: '启动网关', enabled: !running, click: () => gateway.start().catch(() => {}) },
    { label: '停止网关', enabled: running, click: () => gateway.stop().catch(() => {}) },
    { label: '重启网关', enabled: running, click: () => gateway.restart().catch(() => {}) },
    { type: 'separator' },
    { label: '复制统一 Key', click: () => { try { clipboard.writeText(gateway.apiKey()); } catch (_) { /* 忽略 */ } } },
    { label: '打开数据目录', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]));
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.on('double-click', () => showWindow());
    refreshTray();
  } catch (err) {
    logger.warn('托盘创建失败（不影响主功能）：' + (err && err.message ? err.message : err));
  }
}

/* ------------------------------------------------------------------ *
 * 状态快照（推给渲染层）
 * ------------------------------------------------------------------ */

function stateSnapshot() {
  const gw = gateway.getState();
  return {
    app: { name: APP_NAME, version: app.getVersion(), electron: process.versions.electron, node: process.versions.node },
    dataDir,
    gateway: Object.assign({}, gw, {
      // 统一 Key 明文也一并回传：这是用户**自己的**本机凭据，同一台机器上从
      // gateway.config.json 本来就能读到；而"复制 Key 粘到别的客户端"正是本程序的核心用法，
      // 藏起来只会把可用性换成一文不值的"安全感"。预览 diff 里仍然打码（那些内容会被截图/分享）。
      apiKey: gateway.apiKey(),
      apiKeyMasked: maskKey(gateway.apiKey()),
      autoStart: settings.get('autoStartGateway'),
      minimizeToTray: settings.get('minimizeToTray'),
      autoStartApp: settings.get('autoStartApp'),
      loginItem: app.getLoginItemSettings().openAtLogin,
    }),
    settings: settings.snapshot(),
    // 磁盘上的配置能不能解析。坏掉时界面要明确告诉用户（否则他只会看到"0 个供应商"，
    // 以为是程序坏了，实际上是自己的配置文件被改坏了）。
    configOk: !!gateway.configObject(),
  };
}

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 10) return '••••';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

/**
 * 把网关统一 Key **和全部上游 Key** 登记为"精确敏感串"，之后的日志/崩溃现场里它们一律被打码。
 *
 * 为什么必须做：统一 Key 是本程序自己生成的 `dsh-gateway-<随机>` / `lgw-<hex>`，
 * **不符合任何已知的密钥前缀**，正则一个字都拦不住。上游 Key（`sk-` 之外还有各种中转的
 * 自定义前缀）同理。而它们确实有泄漏路径——例如某个上游把收到的 `Authorization` 头回显进
 * 错误体，那串文本会经由引擎 stdout 流进我们的 app.log。
 * 每次配置变化都重新登记（用户可以在界面上"重新生成统一 Key"、导入配置、改供应商）。
 */
function registerGatewaySecret() {
  try {
    registerSecret(gateway && gateway.apiKey());
    const cfg = gateway && typeof gateway.configObject === 'function' ? gateway.configObject() : null;
    for (const p of ((cfg && cfg.providers) || [])) {
      if (!p || typeof p !== 'object') continue;
      registerSecret(p.apiKey);
      for (const k of (Array.isArray(p.apiKeys) ? p.apiKeys : [])) registerSecret(k);
      for (const a of (Array.isArray(p.accounts) ? p.accounts : [])) registerSecret(a && a.apiKey);
    }
  } catch (_) { /* 忽略 */ }
}

function broadcastState() {
  refreshTray();
  if (win && !win.isDestroyed()) win.webContents.send('gw:state', stateSnapshot());
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  /**
   * IPC 兜底包装：**任何 handler 抛出都不许变成 rejected promise**。
   *
   * 为什么必须做（2026-09-30，用户报"一键拉取基本都失败"之后复查发现的系统性问题）：
   * 21 个 handler 里有 **12 个没有 try/catch**。任何一个内部抛出（上游数据畸形、文件被占用、
   * 解析失败…）都会让 `ipcRenderer.invoke` 的 promise **reject**，渲染层那句 `await` 直接抛。
   * 如果抛出点在用户点按钮的那条链路上，表现就是**"点了没反应"** —— 没有任何提示，
   * 用户只能猜。这与渲染层那个 `dup is not defined` 是**同一种失败形态**，
   * 只不过一个在渲染层、一个在主进程。
   *
   * 所以在这里单点收口：捕获 → 记日志（这样 app.log 里一定有线索）→ 按该通道的形状返回：
   *   · 绝大多数通道是 `{ok, error}` 形 → 返回 `{ok:false, error}`
   *   · 少数通道返回的是**原始快照对象**（见 PLAIN_CHANNELS）→ 返回 `null`，
   *     由渲染层按"没拿到状态"处理（那里也要能容忍 null，见 app.js 的 loadState）
   *
   * 这是**结构性**修复：以后新增 handler 自动获得同样的保护，不必逐个记得写 try。
   */
  const PLAIN_CHANNELS = new Set([
    'app:state',   // 返回 stateSnapshot() 原始对象，没有 ok 字段
    'gw:state',    // 同上（多带一个 log）
  ]);
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (ev, ...args) => {
      try {
        return await fn(ev, ...args);
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        try { logger.error(`IPC ${channel} 处理失败：${msg}`); } catch (_) { /* 忽略 */ }
        return PLAIN_CHANNELS.has(channel)
          ? null
          : { ok: false, error: `内部错误（${channel}）：${msg}` };
      }
    });
  };

  handle('app:state', () => stateSnapshot());

  handle('app:save-settings', (_e, patch) => {
    const before = settings.snapshot();
    const next = settings.save(patch || {});
    // 开机自启要走 Electron 的登录项，不能只写进 settings.json
    if (before.autoStartApp !== next.autoStartApp) {
      try { app.setLoginItemSettings({ openAtLogin: !!next.autoStartApp, args: [] }); }
      catch (err) { logger.warn('设置开机自启失败：' + (err && err.message ? err.message : err)); }
    }
    broadcastState();
    return { ok: true, settings: next };
  });

  handle('app:clipboard', (_e, text) => {
    try { clipboard.writeText(String(text == null ? '' : text)); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e && e.message) }; }
  });

  handle('app:open-path', async (_e, p) => {
    const target = String(p || '');
    if (!target) return { ok: false, error: '空路径' };
    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        await shell.openPath(target);
      } else if (fs.existsSync(target)) {
        shell.showItemInFolder(target);
      } else {
        // 不存在就打开它的父目录（"看看会写到哪"比报错有用）
        const dir = path.dirname(target);
        if (fs.existsSync(dir)) await shell.openPath(dir);
        else return { ok: false, error: '路径不存在：' + target };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message) }; }
  });

  // （原先这里有个 app:open-url → shell.openExternal 的通道，渲染层从未调用过，已删除：
  //   "能让主进程打开任意 http(s) 链接"是一条没人用的攻击面。）

  /* ---------------- 网关 ---------------- */

  // 带日志尾部的完整快照。渲染层在启动时用它把**上一次会话的网关日志**填进日志页 ——
  // 旧实现里这个通道没在 preload 上绑定，日志页于是永远是空的（只能靠"打开日志文件"看）。
  handle('gw:state', () => Object.assign({}, stateSnapshot(), { log: gateway.logTailText(200000) }));

  handle('gw:action', async (_e, action) => {
    const a = String(action || '');
    try {
      if (a === 'start') {
        await gateway.start();
        // start() 内部对"端口被占用 / 运行时缺失 / 探测不通过"都是**记日志后正常返回**，
        // 不抛错。旧实现无论成败一律回 ok:true，界面于是显示"网关已启动"而实际没起来。
        // 这里以 running 为准如实回报。
        return gateway.running
          ? { ok: true }
          : { ok: false, error: `网关未能启动（端口 ${gateway.configPort()}）——常见原因：端口被其他程序占用、配置有误、运行时缺失。详见「日志」页。` };
      }
      if (a === 'stop') {
        await gateway.stop();
        return gateway.running ? { ok: false, error: '网关仍在运行，停止未完成' } : { ok: true };
      }
      if (a === 'restart') {
        await gateway.restart();
        return gateway.running
          ? { ok: true }
          : { ok: false, error: `网关重启后未处于运行状态（端口 ${gateway.configPort()}）。详见「日志」页。` };
      }
      if (a === 'get-config') return { ok: true, text: gateway.configText() };
      if (a === 'load-example') return { ok: true, text: gateway.exampleText() };
      if (a === 'clear-log') { gateway.clearLog(); return { ok: true }; }
      return { ok: false, error: '未知动作：' + a };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  handle('gw:save-config', async (_e, text) => {
    const wasRunning = gateway.running;
    const r = await gateway.saveConfig(String(text == null ? '' : text));
    if (r && r.ok) {
      registerGatewaySecret();   // 统一 Key 可能被换过
      // 保存会顺带重启网关；重启失败时不能只回 ok —— 否则界面显示"配置已保存并生效"，
      // 而实际上网关已经停了，用户下一个请求才发现。
      if (wasRunning && !gateway.running) {
        r.warning = `配置已保存，但网关重启后未运行（端口 ${gateway.configPort()}）——请查看「日志」页。`;
      }
    }
    broadcastState();
    return r;
  });

  handle('gw:validate', (_e, text) => validateConfigText(String(text == null ? '' : text)));

  handle('gw:health', async () => {
    if (!gateway.running) return { ok: false, error: '网关未运行' };
    return await gateway.healthSnapshot(4000);
  });

  // 供应商连通性探测：走与网关同规则的 baseURL 归一 + 代理/直连判定
  handle('gw:test-providers', async (_e, ids) => {
    const cfg = gateway.configObject() || { providers: [] };
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const list = (cfg.providers || []).filter((p) => p && (!wanted || wanted.has(p.id)));
    const proxy = await gateway.resolveProxy();
    const noProxy = String(gateway.computeNoProxy() || '').split(',').filter(Boolean);
    const results = [];
    // 整体时间预算：单家 12 秒、最多 40 家 —— 如果用户选中的一批上游全都挂在
    // "连得上但不回数据"的代理后面，串行跑完最坏要十几分钟，界面就一直是转圈。
    // 到点后返回**已完成的部分**并如实说明还剩几家没测，比无限等下去有用。
    const BUDGET_MS = 90 * 1000;
    const startedAt = Date.now();
    // 串行且有上限：并发探测几十家会把本机连接表打满，也会让上游看到突发的目录请求
    for (const p of list.slice(0, 40)) {
      if (Date.now() - startedAt > BUDGET_MS) {
        for (const rest of list.slice(results.length)) {
          results.push({ id: rest.id, ok: null, skipped: true, verdict: '未测（整体时间预算已用完，请稍后重试或单独测试）' });
        }
        logger.warn(`连通性测试：整体预算 ${BUDGET_MS / 1000}s 已用完，剩余 ${list.length - results.length} 家未测。`);
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await probe.probeProvider(p, { proxy, noProxy, timeoutMs: 12000 });
      results.push(r);
    }
    return { ok: true, proxy: proxy || '', results };
  });

  // 拉取某个（可能是"还没保存的"）供应商的模型目录 —— 编辑抽屉里"拉取上游模型目录"用。
  // 入参来自渲染层，所以只接受白名单字段，且按同一套代理规则请求。
  handle('gw:fetch-catalog', async (_e, provider) => {
    const p = provider && typeof provider === 'object' ? provider : {};
    const base = probe.upstreamBase(String(p.baseURL || ''));
    if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Base URL 必须是 http(s) 绝对地址' };
    const proxy = await gateway.resolveProxy();
    const noProxy = String(gateway.computeNoProxy() || '').split(',').filter(Boolean);
    const r = await probe.getJson(base + '/models', {
      // ⚠ 必须带**与网关转发时相同**的仿真头：实测直连 cline 不带 Cline 头一律 403，
      // 用它做目录探测/测速会把能用的模型报成失败。
      headers: clientHeaders.probeHeaders(gateway.configObject(), p, String(p.apiKey || '')),
      apiKey: String(p.apiKey || ''),
      proxy: p.proxy === false ? null : proxy,
      noProxy,
      timeoutMs: 15000,
      limit: 4 * 1024 * 1024,
    });
    if (!r.status) return { ok: false, error: (r.via ? r.via + '：' : '') + (r.error || '请求失败') };
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}（${r.ms}ms）` };
    // 截断要说出来：否则"上游返回的不是 JSON"会把用户引向错误的排查方向
    if (r.truncated) return { ok: false, error: '上游目录超过 4MB 已被截断，无法解析。该上游的 /models 可能异常，请手工填写模型列表。' };
    let json;
    try { json = JSON.parse(r.body); } catch (_) { return { ok: false, error: '上游返回的不是 JSON' }; }
    const arr = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : null);
    if (!arr) return { ok: false, error: '响应里没有 data[] / models[] 数组' };
    const models = [...new Set(arr.map((m) => String((m && (m.id || m.name)) || '').trim()).filter(Boolean))].sort();
    return { ok: true, models, count: models.length, via: r.via, ms: r.ms };
  });

  /**
   * 一键获取全部模型：拉上游目录，并把每个模型的参数（上下文 / 最大输出 / 图片 / 超时）
   * 尽量补齐，同时给出"客户端用的短名"（自动去掉厂商前缀）。
   *
   * 补不齐的**留空**而不是编一个值 —— 虚报上下文长度会让客户端真的按那个数字发包
   *（有前车之鉴：dsh 写入曾因拿不到值而退回默认 1024000，等于向上游虚报 5 倍）。
   */
  handle('gw:fetch-models', async (_e, provider, options) => {
    const p = provider && typeof provider === 'object' ? provider : {};
    const o = options && typeof options === 'object' ? options : {};
    const base = probe.upstreamBase(String(p.baseURL || ''));
    if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Base URL 必须是 http(s) 绝对地址' };
    const proxy = await gateway.resolveProxy();
    const noProxy = String(gateway.computeNoProxy() || '').split(',').filter(Boolean);
    const r = await probe.getJson(base + '/models', {
      headers: clientHeaders.probeHeaders(gateway.configObject(), p, String(p.apiKey || '')),
      apiKey: String(p.apiKey || ''),
      proxy: p.proxy === false ? null : proxy,
      noProxy,
      timeoutMs: 20000,
      limit: 4 * 1024 * 1024,
    });
    if (!r.status) return { ok: false, error: (r.via ? r.via + '：' : '') + (r.error || '请求失败') };
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}（${r.ms}ms）` };
    if (r.truncated) return { ok: false, error: '上游目录超过 4MB 已被截断，无法解析。请手工填写模型列表。' };
    let json;
    try { json = JSON.parse(r.body); } catch (_) { return { ok: false, error: '上游返回的不是 JSON' }; }
    const arr = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : null);
    if (!arr) return { ok: false, error: '响应里没有 data[] / models[] 数组' };

    const { models, unknown } = modelMeta.enrichAll(arr, { keepVendor: o.keepVendor === true });
    return {
      ok: true,
      models,
      unknown,
      count: models.length,
      via: r.via,
      ms: r.ms,
      // 上游到底有没有给参数 —— 界面据此决定要不要提示"这些参数得你自己填"
      upstreamRich: models.some((m) => m.contextWindow || m.maxTokens || m.vision),
    };
  });

  /**
   * 给选中的模型**实测**一个建议超时。
   *
   * 为什么不猜：超时主要取决于本机到上游的网络，跟模型本身关系不大，猜一个数字只会让用户
   * 以为配好了（这正是"不编数字"原则的一部分）。这里对每个模型发一次最小请求
   *（`max_tokens: 1`），按实测耗时 ×4 取整并夹在 10s–120s：下限保证正常抖动不被误杀，
   * 上限保证某个模型挂死时不会吃掉整个客户端预算。
   */
  handle('gw:measure-models', async (_e, provider, models) => {
    const p = provider && typeof provider === 'object' ? provider : {};
    const base = probe.upstreamBase(String(p.baseURL || ''));
    if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Base URL 必须是 http(s) 绝对地址' };
    const list = (Array.isArray(models) ? models : []).slice(0, 60);
    if (!list.length) return { ok: false, error: '没有要测速的模型' };
    const proxy = await gateway.resolveProxy();
    const noProxy = String(gateway.computeNoProxy() || '').split(',').filter(Boolean);
    const out = [];
    // 整体时间预算：与 gw:test-providers 同理。入参来自渲染层，若被塞进 60 个必定超时的模型，
    // 串行跑完最坏 60×40s = 40 分钟，界面会一直转圈。到点后返回已完成部分并如实说明。
    const BUDGET_MS = 180 * 1000;
    const startedAt = Date.now();
    for (const m of list) {
      // ⚠ 只接受**真正的字符串 id**。
      // 旧写法 `String((m && (m.id || m.up)) || m || '')` 在 m 是 `{}` 时得到 `'[object Object]'`，
      // 于是它会拿这个假 id 真的去打一次上游（实测：日志里出现 `测速 ? → [object Object]`）。
      // 入参来自渲染层，不能假设形状。
      const upstreamId = typeof m === 'string' ? m.trim()
        : (m && typeof m === 'object' && typeof m.id === 'string') ? m.id.trim()
          : (m && typeof m === 'object' && typeof m.up === 'string') ? m.up.trim()
            : '';
      if (!upstreamId) continue;
      if (Date.now() - startedAt > BUDGET_MS) {
        logger.warn(`测速：整体预算 ${BUDGET_MS / 1000}s 已用完，剩余 ${list.length - out.length} 个未测。`);
        break;
      }
      const t0 = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const res = await probe.getJson(base + '/chat/completions', {
        method: 'POST',
        // 同上传真头 —— 否则 cline/agentrouter 这类按客户端白名单放行的上游会一律 403
        headers: clientHeaders.probeHeaders(gateway.configObject(), p, String(p.apiKey || ''), { json: true }),
        apiKey: String(p.apiKey || ''),
        proxy: p.proxy === false ? null : proxy,
        noProxy,
        timeoutMs: 40000,
        limit: 64 * 1024,
        body: {
          model: upstreamId,
          messages: [{ role: 'user', content: 'hi' }],
          // ⚠ 不能设 1。很多模型会先输出"思考" token，content 为空 —— cline 这类中转会直接
          // 回 500 `empty response content`，看起来像"模型不可用"，其实只是 max_tokens 给得太少。
          //（实测踩到：max_tokens=1 时 cline 十四个模型里十一个报 500，改成 16 后大多正常。）
          max_tokens: 16,
          stream: false,
        },
      });
      const ms = Date.now() - t0;
      // 只把"确实拿到了 2xx"的计入建议值；失败的不给建议（否则会把"超时"当成"很慢"）
      const usable = res.status >= 200 && res.status < 300;
      const suggested = usable ? Math.min(120000, Math.max(10000, Math.round(ms * 4 / 1000) * 1000)) : 0;
      out.push({
        id: upstreamId,
        ms,
        status: res.status || 0,
        ok: usable,
        suggestedTimeoutMs: suggested,
        error: usable ? '' : (res.error || ('HTTP ' + res.status)),
      });
      logger.info(`测速 ${p.id || '?'} → ${upstreamId}：HTTP ${res.status || 0} ${ms}ms`
        + (suggested ? ` → 建议超时 ${suggested}ms` : ''));
    }
    return { ok: true, results: out };
  });

  /* ---------------- 一键写入 ---------------- */

  handle('write:detect', () => {
    const ctx = writeCtx({});
    return { ok: true, targets: writers.detectAll(ctx) };
  });

  handle('write:preview', (_e, id, options) => {
    const ctx = writeCtx(options || {});
    const r = writers.preview(String(id), ctx);
    // 预览里只保留展示需要的字段，避免把密钥原文经 IPC 送到渲染层
    return sanitizePreview(r);
  });

  handle('write:apply', async (_e, id, options) => {
    const target = String(id || '');
    const ctx = writeCtx(options || {});
    // 写入前**强制**跑一次预览并检查 guard。
    //
    // guard 是各目标给出的"现在不能写"的理由（Key 为空/过短/仍是占位值、一个可用模型都没有、
    // 选择的模型已不在清单里、目标文件坏掉…）。旧实现只把它当界面提示，apply 完全不看 ——
    // 于是"空 Key"时会把用户**原本可用的凭据写成空串**，还回一句"写入成功"（实测确认：
    // claude 的 ANTHROPIC_AUTH_TOKEN 变成 ""、codex 的 auth.json 里 OPENAI_API_KEY 变成 ""）。
    // 这是不可逆的破坏（对方的客户端从此不可用），必须在写入前拦死。
    //
    // ⚠ 必须 **fail-closed**：`preview` 抛异常/返回 ok:false 时，它**给不出**"可以写"的结论，
    // 此时也一律不写。旧写法是 `if (pre && pre.ok && guard.length)` —— preview 失败时
    // 整个条件短路，apply 照常执行，guard 形同不存在（实测：故障注入下 config.toml 真的被改了）。
    // 结构性理由：preview 与 apply 是两套实现，任何分叉都会让"检查过"变成空话。
    const pre = writers.preview(target, ctx);
    const guard = (pre && Array.isArray(pre.guard)) ? pre.guard.slice() : [];
    if (!pre || !pre.ok) {
      const why = (pre && Array.isArray(pre.errors) && pre.errors.length)
        ? pre.errors.join('；')
        : '预览没有返回有效结果';
      guard.unshift('写入前的检查未能完成（' + why + '），为安全起见已中止写入。');
    }
    if (guard.length) {
      logger.warn(`一键写入[${target}]：被前置检查拦下 —— ${guard.join('；')}`);
      return {
        ok: false,
        blocked: true,
        errors: guard,
        files: [],
        backups: [],
        output: '',
        nextSteps: ['请在「设置」或「概览」页修好上述问题后重试。'],
      };
    }

    const r = await writers.apply(target, ctx);
    logger.info(`一键写入[${target}]：${r.ok ? '成功' : '失败'} ${r.output || ''} ${(r.errors || []).join('；')}`);
    broadcastState();
    return {
      ok: !!r.ok,
      errors: r.errors || [],
      files: r.files || [],
      // 各目标的返回形状不完全一致：dsh/envscript 用 backups（复数），
      // claude-code/codex/opencode 用 backup（单数）。这里归一到 backups，
      // 否则界面的"写入成功"弹窗里永远看不到备份路径（备份其实已经生成了）。
      backups: (r.backups && r.backups.length ? r.backups : (r.backup ? [r.backup] : [])),
      output: r.output || '',
      nextSteps: r.nextSteps || [],
    };
  });

  handle('write:restore', async (_e, id) => {
    const target = String(id || '');
    const ctx = writeCtx({});
    // ⚠ 必须 await：writers.restore 是 async，返回 Promise。
    // 漏了 await 时 `r.ok` 恒为 undefined → 日志**永远**记「恢复失败」，
    // 哪怕恢复实际成功了（审计实测：await 后 r.ok=true，不 await 时是 undefined）。
    // 排错时这条日志会把方向带反。apply 那边一直是 await 的，这里当初漏了。
    const r = await writers.restore(target, ctx);
    logger.info(`一键写入[${target}]：恢复${r && r.ok ? '成功' : '失败'}`);
    return r;
  });

  /* ---------------- 配置导入导出 ---------------- */

  handle('cfg:import', () => {
    const r = importGatewayConfig(dataDir);
    if (r.action === 'imported' || r.action === 'upgraded') {
      logger.info(`网关配置已${r.action === 'upgraded' ? '升级' : '导入'}：${r.from}`);
      registerGatewaySecret();
      broadcastState();
      return { ok: true, action: r.action, from: r.from, text: gateway.configText() };
    }
    return { ok: false, action: r.action, reason: r.reason || '' };
  });

  // 从**用户指定的文件**导入。自动导入只能猜几个常见位置；绿色版被复制到别处、
  // 或者旧安装在一个说不清的地方时，只有让用户自己指路才靠得住。
  handle('cfg:import-file', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要导入的 gateway.config.json',
      properties: ['openFile'],
      filters: [{ name: '网关配置', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    const src = r.filePaths[0];
    try {
      const text = fs.readFileSync(src, 'utf8');
      const v = validateConfigText(text);
      if (!v.ok) return { ok: false, error: '该文件不是合法的网关配置：' + v.error };
      // 覆盖前先备份现有配置（不覆盖已有备份，保留最原始那份）
      if (fs.existsSync(gateway.configPath)) {
        const bak = gateway.configPath + '.bak-import';
        if (!fs.existsSync(bak)) fs.copyFileSync(gateway.configPath, bak);
      }
      fs.writeFileSync(gateway.configPath + '.tmp-import', text, 'utf8');
      fs.renameSync(gateway.configPath + '.tmp-import', gateway.configPath);
      logger.info('网关配置已从指定文件导入：' + src);
      registerGatewaySecret();
      // 运行中则重启，让新配置立即生效
      if (gateway.running) await gateway.restart();
      broadcastState();
      return { ok: true, from: src, text: gateway.configText() };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  handle('cfg:export', async (_e, suggested) => {
    // ⚠ 这里有三处会抛，且都真实发生过（真 Electron 冒烟测出来的）：
    //   · `suggested` 不是字符串 → `Default path must be a string`
    //   · `app.getPath('desktop')` 在某些环境（无桌面会话 / home 被重定向）抛
    //     `Failed to get 'desktop' path`
    //   · `dialog` 本身在极端情况下也会抛
    // 兜底包装会把它们变成 {ok:false,error}，但**导出是个正常功能，不该动不动就失败** ——
    // 所以这里逐级降级：suggested → desktop → home → documents → temp → cwd。
    let defaultPath = (typeof suggested === 'string') ? suggested.trim() : '';
    if (!defaultPath) {
      let dir = '';
      for (const key of ['desktop', 'home', 'documents', 'temp']) {
        try { dir = app.getPath(key); if (dir) break; } catch (_) { /* 换下一个 */ }
      }
      if (!dir) dir = process.cwd();
      defaultPath = path.join(dir, 'gateway.config.json');
    }
    let r;
    try {
      r = await dialog.showSaveDialog(win, {
        title: '导出网关配置',
        defaultPath,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    } catch (e) {
      return { ok: false, error: '打开保存对话框失败：' + String(e && e.message) };
    }
    if (!r || r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r.filePath, gateway.configText(), 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, error: String(e && e.message) }; }
  });

  handle('cfg:generate-key', () => {
    const key = 'lgw-' + require('crypto').randomBytes(24).toString('hex');
    return { ok: true, key };
  });
}

/** 构造写入上下文（渲染层永远拿不到 Key 原文）。 */
function writeCtx(options) {
  return writers.makeContext({
    gateway,
    dataDir,
    // 端口口径必须与 getState() 一致：运行中用**真实监听端口**，停止时用配置端口。
    // 只取 configPort() 的话，用户在网关运行期间手改配置文件端口，一键写入会指向新端口，
    // 而网关其实还监听在旧端口上——写出去的客户端配置连不上。
    port: gateway.running ? gateway.port : gateway.configPort(),
    nodeExe: process.execPath,
    nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    options: options || {},
  });
}

/**
 * 预览脱敏：把**整份**预览载荷里的密钥换成打码值再送渲染层。
 *
 * 旧实现只擦"网关统一 Key"一处 —— 但预览里还带着**别的客户端配置文件的原文**：
 * opencode 其它 provider 的 `apiKey`、Codex 的 `model_providers.*` 表
 * （`experimental_bearer_token` 是明文）、Claude Code 的 `env` 段等等。
 * 那些是用户自己填在别处的真实密钥，没有任何理由为了显示一份 diff 而把它们送进渲染进程。
 * 现在走"深扫 + 全量打码"：所有登记过的密钥（启动时已把配置里全部上游 Key 登记进去）
 * 与所有已知密钥形态都会被整串抹掉。
 */
function sanitizePreview(r) {
  if (!r || !r.ok) return r;
  return scrubDeepSecrets(r);
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function bootstrap() {
  dataDir = resolveDataDir({ packaged: app.isPackaged });
  logger = new Logger(path.join(dataDir, 'logs'));
  logger.info(`==== ${APP_NAME} ${app.getVersion()} 启动（electron ${process.versions.electron} / node ${process.versions.node}）====`);
  logger.info('数据目录：' + dataDir);

  settings = new Settings(dataDir, (m) => logger.warn(m));

  gateway = new GatewayManager({ dataDir, logger, settings });

  // 顺序很重要：**先尝试导入，再从示例生成**。
  // 反过来的话（先 init 生成示例、再导入）会平白多出一份占位配置和 `.bak-import` 备份，
  // 而且一旦导入判定出问题，用户看到的就永远是那份示例。
  const imp = importGatewayConfig(dataDir);
  if (imp.action === 'imported' || imp.action === 'upgraded') {
    logger.info(`网关配置已从既有安装${imp.action === 'upgraded' ? '升级' : '导入'}：${imp.from}`);
  } else if (imp.reason) {
    logger.info('未导入既有网关配置（' + imp.reason + '）');
  }

  gateway.init();
  registerGatewaySecret();   // 统一 Key 一就位就登记脱敏，之后的日志里它都会被打码

  gateway.on('state', () => broadcastState());
  gateway.on('log', () => {
    if (win && !win.isDestroyed()) win.webContents.send('gw:log', gateway.logTailText(200000));
    refreshTray();
  });

  registerIpc();
  createWindow();
  createTray();

  if (settings.get('autoStartGateway') !== false) {
    gateway.start().catch((e) => logger.error('网关自动启动失败：' + (e && e.message ? e.message : e)));
  }

  logger.info(`${APP_NAME} 就绪`);
}

app.whenReady().then(() => {
  // 只允许加载本地渲染页：把 file:// 之外的一切导航挡掉（防第三方页面拿到 preload 桥）
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  bootstrap().catch((err) => {
    const msg = err && err.stack ? err.stack : String(err);
    try { if (logger) logger.error('启动失败：' + msg); } catch (_) { /* 忽略 */ }
    dialog.showErrorBox(APP_NAME + ' 启动失败', msg);
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // 托盘常驻模式（默认）：窗口关了继续跑，用户从托盘再打开。
  // 但用户**关掉**「关闭窗口时最小化到托盘」时，点 × 就该退出——旧实现只在
  // `!settings`（几乎不可能成立）时才 quit，于是程序会变成"没有窗口的幽灵进程"。
  if (settings && settings.get('minimizeToTray') !== false) return;
  app.quit();
});

/**
 * 退出前收尾：**必须**先把网关子进程停掉。
 * Windows 上 spawn 出来的子进程不随父进程消亡，漏掉这一步会留下一个占着端口的
 * 孤儿网关；用户下次启动就会看到"端口被占用"。
 *
 * 流程：第一次 before-quit → preventDefault + 异步收尾 → 置 allowQuit → 再 quit 一次
 * （这一次不再 preventDefault，正常退出）。
 */
app.on('before-quit', (e) => {
  if (teardownStarted) return;             // 已在收尾 / 已收尾完毕 → 放行
  if (!gateway) { allowQuit = true; return; }
  e.preventDefault();
  teardownStarted = true;
  (async () => {
    try { await gateway.stop(); } catch (err) {
      try { logger.error('退出时停止网关失败：' + (err && err.message ? err.message : err)); } catch (_) { /* 忽略 */ }
    }
    // 兜底：网关管理器有自愈重启逻辑，stop() 内部已置 stopping 标记；
    // 这里再确认一次端口没有被本程序的引擎残留占用，避免"下次启动端口被占"。
    try { await gateway.killStaleGatewayProcesses(); } catch (_) { /* 忽略 */ }
    try { if (logger) logger.info('已退出。'); } catch (_) { /* 忽略 */ }
    allowQuit = true;
    app.quit();
  })();
});

// 进程被硬杀（任务管理器结束进程 / 控制台 Ctrl+C）时也尽力收尾。
// 这类信号下 Electron 未必走 before-quit，但至少别让引擎继续占端口。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    allowQuit = true;
    try { if (gateway) gateway.stop(); } catch (_) { /* 忽略 */ }
    setTimeout(() => app.exit(0), 1500);
  });
}
