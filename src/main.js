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

const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, dialog, nativeImage, session, powerMonitor } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveDataDir, importGatewayConfig } = require('./datadir');
const { summarizeAsync } = require('./usage');   // 使用记录聚合（阶段 2，异步切片版）
const { Logger, registerSecret, scrubDeepSecrets } = require('./logger');
const { Settings } = require('./settings');
const { GatewayManager, validateConfigText } = require('./gateway-manager');
const writers = require('./writers');
const writersModels = require('./writers/models');   // 模型清单/别名表（与引擎规则一致，有回归测试锁死）
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
      // 打开 Chromium 的渲染进程 OS 级沙箱。旧实现显式关掉它，而这里的防护其实已经齐了
      //（contextIsolation + 无 nodeIntegration + 严格 CSP + 导航白名单），
      // preload 也只用 `require('electron')`、不需要 fs/path —— sandbox: true 下依然可用。
      // 关掉它意味着"渲染层一旦被攻破就是完整用户权限"，而收益只是省掉一层沙箱开销。
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (settings.get('openDevTools')) win.webContents.openDevTools({ mode: 'detach' });
  });

  // ⚠ 2026-11-12 复核修（M9 在 Windows 上其实没生效）：
  // `powerMonitor` 的 `shutdown` 事件在 Electron 的 SDK 里标着 `@platform linux,darwin` ——
  // Windows 上**根本不会触发**。Windows 走的是窗口级事件：
  //   · `query-session-end`：关机/重启/注销**之前**发（可以 preventDefault，我们不去拦）；
  //   · `session-end`：会话真的要结束了，拦也没用，只能记一笔。
  // 两个都挂上，按平台各取所需：Windows 靠这两个，Linux/macOS 靠 installShutdownWatch 里的 powerMonitor。
  win.on('query-session-end', () => noteShutdown('query-session-end'));
  win.on('session-end', () => noteShutdown('session-end'));

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
    // ⚠ 纯 `startsWith` 比路径**缺一个分隔符边界**：`renderer-evil/x.html`、
    // `renderer_evil/`、`rendererX/`、`renderer./` 这些**兄弟目录**都会被放行。
    // 实测（渲染/宿主审计 D7：把函数源码原样抽出来直喂 URL，四种全部返回 true）。
    // 当前不可利用（渲染层无 XSS、没有 `<a>`、`window.open` 一律 deny、webview deny，
    // 要利用得先能在安装目录旁写出一个 `renderer*` 目录且能让窗口导航过去），
    // 但判据本身是错的 —— 补上 `path.sep` 边界。
    const base = path.resolve(rendererDir).toLowerCase();
    const full = path.resolve(p).toLowerCase();
    return full === base || full.startsWith(base + path.sep);
  } catch (_) { return false; }
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * 托盘图标的四种状态。
 *
 * ⚠ 旧实现两个分支都返回 `COLORS.stopped`（灰），于是"正在启动"和"启动失败"看起来
 * 和"已停止"一模一样 —— 用户只能去翻日志才知道出了什么事。
 * `icon.js` 里 `starting`（琥珀）/ `failed`（红）早就定义了却**全项目无人使用**。
 * 现在四态分明：灰=没运行、琥珀=启动中、绿=就绪、红=启动失败。
 */
function trayIcon() {
  const g = gateway;
  const color = (g && g.ready) ? icon.COLORS.ready
    : (g && g.running && g.failed) ? icon.COLORS.failed
      : (g && g.running) ? icon.COLORS.starting
        : icon.COLORS.stopped;
  try { return nativeImage.createFromDataURL(icon.iconDataURL(16, color)); } catch (_) { return appIcon(16); }
}

/** 托盘 tooltip / 菜单第一行的状态文案（与 trayIcon 的四态保持一致）。 */
function trayStateText() {
  const g = gateway;
  if (!g) return { text: '已停止', running: false };
  if (g.ready) return { text: `运行中 · 端口 ${g.port}`, running: true };
  if (g.running && g.failed) return { text: `启动失败 · 端口 ${g.port}（见「日志」页）`, running: true };
  if (g.running) return { text: `启动中 · 端口 ${g.port}`, running: true };
  return { text: '已停止', running: false };
}

function refreshTray() {
  if (!tray) return;
  // ⚠ 整段包 try/catch。这里调的全是原生对象方法（tray.setImage / Menu.buildFromTemplate …），
  // 而它是在 `gateway.on('state')` / `gateway.on('log')` 里被调用的 ——
  // 一旦抛出（托盘被系统销毁后调用、explorer 重启、nativeImage 失败…），
  // 异常会顺着 EventEmitter 冒成**主进程未捕获异常**，代价远大于"托盘图标没刷新"。
  // createTray 本来就有兜底，这里补上。
  try {
    const running = !!(gateway && gateway.running);
    const st = trayStateText();
    tray.setImage(trayIcon());
    tray.setToolTip(`${APP_NAME} · ${st.text}`);
    tray.setContextMenu(Menu.buildFromTemplate([
    { label: st.text, enabled: false },
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
  } catch (err) {
    // 托盘刷新失败不该带走主进程；记一条就够（这条路径可能每 800ms 走一次，别刷屏）
    if (logger) logger.warn('托盘刷新失败（不影响主功能）：' + (err && err.message ? err.message : err));
  }
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
 * 出站请求的目标校验：这些 IPC 通道的 baseURL 来自渲染层，不能只判"是 http(s)"。
 *
 * 2026-11-12 审计 M10（已复现）：三个探测通道（`gw:fetch-catalog` / `gw:fetch-models` /
 * `gw:measure-models`）唯一的闸门是 `/^https?:\/\//i.test(base)`。实测把 baseURL 传成
 * `http://127.0.0.1:<任意端口>/v1` 就能拿到该端口的响应体并**原样回传给渲染层**（4MB 上限），
 * 传 `http://192.168.1.1:8080/v1` 也不拦。渲染进程一旦被攻破（或某个上游把恶意 HTML 塞进
 * 模型名/错误体，而界面某处没转义干净），主进程就成了一台**内网扫描器 / 任意请求发起器**。
 *
 * 这里做两件事：
 *   ① 字面量 IP：拒私有网段（10/8、172.16/12、192.168/16、100.64/10 CGNAT）、
 *      链路本地（169.254/16，含云元数据 169.254.169.254）、唯一本地 IPv6（fc00::/7）、
 *      组播/保留/未指定（0.0.0.0、::、224/4、240/4）；
 *   ② 域名：解析一次，解析结果里**任一**地址落在上面那些段就拒 —— 否则 `foo.example.com`
 *      指到 192.168.1.1 就绕过了 ①（DNS rebinding / 内网别名）。
 *
 * **刻意放行 loopback（127/8、::1）**：README 与界面都支持把本地推理（Ollama / LM Studio /
 * vLLM）当上游，那是用户自己在这台机器上装的服务，路径本来就该通。残余风险是"渲染层被攻破后
 * 可以探本机回环端口"，但它拿不到比"用户自己开个终端 curl"更多的东西，而堵掉它会让本地模型
 * 用户完全没法拉目录 —— 取舍记录在此，不隐藏。
 *
 * @returns {Promise<string>} 空串 = 通过；否则是给界面看的中文原因
 */
async function checkOutboundTarget(base) {
  let u;
  try { u = new URL(base); } catch (_) { return 'Base URL 不是合法 URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Base URL 必须是 http(s) 绝对地址';

  const host = String(u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'Base URL 缺少主机名';

  // 回环判定也要认全形式：URL 会把 `[::ffff:127.0.0.1]` 归一化成 `[::ffff:7f00:1]`，
  // 只测字符串前缀会把本机地址误判成"公网"进而放行（方向上是安全的，但会挡住本地推理用户）。
  const isLoopback = (h) => {
    if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return true;
    if (/^::ffff:127\./.test(h)) return true;
    const e = embeddedIpv4(h);
    return e !== '' && /^127\./.test(e);
  };

  /** 把 IPv6 字面量解成 16 个字节；不是合法 IPv6 返回 null。 */
  const v6Bytes = (h) => {
    if (h.indexOf(':') < 0) return null;
    let s = h;
    const zone = s.indexOf('%');                           // 去掉 zone id（fe80::1%eth0）
    if (zone >= 0) s = s.slice(0, zone);
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const parse = (part) => (part === '' ? [] : part.split(':'));
    const left = parse(halves[0]);
    const right = halves.length === 2 ? parse(halves[1]) : [];
    if (left.concat(right).some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    let groups;
    if (halves.length === 2) {
      const fill = 8 - left.length - right.length;
      if (fill < 1) return null;
      groups = left.concat(new Array(fill).fill('0'), right);
    } else {
      groups = left;
      if (groups.length !== 8) return null;
    }
    const out = [];
    for (const g of groups) {
      const n = parseInt(g, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out.length === 16 ? out : null;
  };

  /**
   * IPv6 里嵌着 IPv4 的几种写法 → 点分 IPv4；没有就返回空串。
   *
   * ⚠ 2026-11-12 复核修（第一次）：`new URL('http://[::ffff:192.168.1.1]/')` 会把 hostname
   * 归一化成**十六进制压缩形式** `[::ffff:c0a8:101]`，所以 `h.replace(/^::ffff:/,'')` 拿到的是
   * `c0a8:101`，点分正则不命中 → 掉进 IPv6 分支 → 三个网段正则都不匹配 → 放行。
   *
   * ⚠ 2026-11-12 复核修（第二次）：只还原 `::ffff:` 一种写法等于只堵了字面量。以下写法当时
   * 全部能绕过（实测 PASS）——它们都是"IPv6 地址，但语义上指向一个 IPv4"：
   *   `[::ffff:0:192.168.1.1]`  IPv4-translated（RFC 2765，::ffff:0:0/96）
   *   `[::192.168.1.1]`         IPv4-compatible（已废弃，但 URL 解析器照收）
   *   `[64:ff9b::192.168.1.1]`  NAT64（64:ff9b::/96）
   *   `[2002:c0a8:101::]`       6to4（2002::/16，内嵌 IPv4 在前 4 字节）
   * 所以现在先解成 16 字节，再把各种内嵌形式统一还原成点分，交给同一套 IPv4 网段判定。
   */
  const embeddedIpv4 = (h) => {
    const b = v6Bytes(h);
    if (!b) return '';
    const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
    const dot = (arr) => arr.join('.');
    if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return dot(b.slice(12, 16));  // ::ffff:a.b.c.d
    if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
      return dot(b.slice(12, 16));                                                     // ::ffff:0:a.b.c.d
    }
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) {
      return dot(b.slice(12, 16));                                                     // 64:ff9b::/96 NAT64
    }
    if (b[0] === 0x20 && b[1] === 0x02) return dot(b.slice(2, 6));                     // 2002::/16 6to4
    if (zero(0, 12)) return dot(b.slice(12, 16));                                      // ::a.b.c.d（含 ::）
    return '';
  };

  /** 私有/链路本地/保留地址判定（只处理字面量，域名先解析再喂进来）。 */
  const isBlocked = (h) => {
    if (isLoopback(h)) return false;                       // 刻意放行，见上
    // 先把"IPv6 里嵌 IPv4"的各种写法还原成点分，再走同一套 IPv4 判定。
    const v = embeddedIpv4(h) || h.replace(/^::ffff:/, '');
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
    if (m) {
      const a = Number(m[1]); const b = Number(m[2]);
      if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false; // 交给 URL 解析去报错
      if (a === 0) return true;                            // 0.0.0.0/8
      if (a === 10) return true;                           // 私有
      if (a === 172 && b >= 16 && b <= 31) return true;    // 私有
      if (a === 192 && b === 168) return true;             // 私有
      if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT（Tailscale 等）
      if (a === 169 && b === 254) return true;             // 链路本地 + 云元数据
      if (a >= 224) return true;                           // 组播 / 保留
      return false;
    }
    if (/^f[cd][0-9a-f]{2}:/.test(v)) return true;         // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(v)) return true;         // fe80::/10 链路本地
    if (/^ff[0-9a-f]{2}:/.test(v)) return true;            // ff00::/8 组播
    if (v === '::') return true;                            // 未指定
    return false;
  };

  if (isBlocked(host)) {
    return `Base URL 指向内网/保留地址（${host}），已拒绝：这类请求只能发往公网或本机回环。`
      + '如果你确实要连局域网里的推理服务，请改用自己的回环端口转发。';
  }

  // 域名宿主要解析后再判一次（字面量 IP 走不到这里）
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(':')) {
    if (host !== 'localhost') {
      try {
        const dns = require('node:dns').promises;
        const addrs = await dns.lookup(host, { all: true });
        for (const a of addrs) {
          const ip = String((a && a.address) || '');
          if (ip && isBlocked(ip)) {
            return `Base URL 的域名 ${host} 解析到了内网/保留地址（${ip}），已拒绝。`;
          }
        }
      } catch (_) {
        // 解析不了就让后面的请求自己去失败并如实报错（例如公司内网域名只在该网段可解析）
      }
    }
  }
  return '';
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
    // save() 现在把落盘成败一起带回来（{ ok, error?, settings }）—— 不能再无条件回 ok:true，
    // 否则写盘失败时界面照样播「已保存」，勾选框也是勾上的，重启就变回去。
    const r = settings.save(patch || {});
    if (!r || !r.ok) {
      // ⚠ 必须在 broadcastState() **之前**回滚，否则广播出去的正是那份没落盘的状态；
      // 也必须在 setLoginItemSettings **之前**返回，否则登录项已经改了、设置却没存上
      // —— 两边分叉的下一个症状就是"重启后自启状态莫名变回去"。
      try { settings.restore(before); } catch (_) { /* 忽略 */ }
      logger.warn('应用设置写入失败，已回滚：' + ((r && r.error) || '未知错误'));
      return { ok: false, error: (r && r.error) || '写入失败', settings: before };
    }
    const next = r.settings;
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
    // ⚠ 2026-11-12 审计 L2：这个通道原来接受**任意路径**，等于把"用资源管理器打开任意位置"
    // 的能力交给了渲染层。渲染层本身是 sandbox + contextIsolation + 无 connect-src 的，
    // 所以这不是"远程可利用"，但它是一条没人需要的能力：界面真正会打开的位置只有两处 ——
    //   ① 数据目录（日志页「打开日志」、仪表盘「打开数据目录」、写入后「打开所在目录」）；
    //   ② 各客户端的配置文件（`~/.claude/settings.json`、`~/.codex/config.toml` …）。
    // 因此收窄成：必须落在数据目录或用户主目录之内。越界直接拒绝并记一条日志，
    // 免得以后有人从渲染层传 `C:\Windows\System32` 时我们连痕迹都没有。
    const roots = [];
    try { if (dataDir) roots.push(path.resolve(dataDir)); } catch (_) { /* 忽略 */ }
    try { roots.push(path.resolve(os.homedir())); } catch (_) { /* 忽略 */ }
    const resolved = path.resolve(target);
    const inside = (child, parent) => {
      const rel = path.relative(parent, child);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    if (!roots.some((r) => inside(resolved, r))) {
      logger.warn('拒绝打开越界路径（只允许数据目录与用户主目录之内）：' + resolved);
      return { ok: false, error: '只允许打开数据目录或用户主目录之内的路径' };
    }
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
        // start() 内部对"端口被占用 / 运行时缺失 / 探测不通过"都是**记日志后正常返回**，不抛错。
        // 旧实现以 `running` 为准 —— 但 running 只表示"子进程对象还在"，**不表示端口在监听**：
        // 子进程活着却没 listen（首启被杀软拖慢、启动慢于 8 次探测）时会回 ok:true，
        // 界面弹「网关已启动」+ 状态点变绿，而每个客户端请求都失败。
        // 改为要求 `running && ready`（ready = _doStart 里那次就绪探测的结果）。
        // `ready` 只在 _doStart 末尾算一次（8 次探测、上界约 21.6s）。引擎慢于这个窗口时
        // 它是 false，但网关随后其实可用 —— 所以这里**不能**直接报失败，
        // 而要如实回一个『启动中』（界面据此显示『启动中…』而不是红色失败 toast）。
        if (gateway.running && gateway.ready) return { ok: true };
        if (gateway.running) {
          return { ok: true, starting: true, error: `网关进程已启动，端口 ${gateway.configPort()} 尚未就绪 —— 通常是启动慢于预期（引擎一般 1-3 秒就绪）。若持续如此请查看「日志」页。` };
        }
        return { ok: false, error: `网关未能启动（端口 ${gateway.configPort()}）——常见原因：端口被其他程序占用、配置有误、运行时缺失。详见「日志」页。` };
      }
      if (a === 'stop') {
        await gateway.stop();
        return gateway.running ? { ok: false, error: '网关仍在运行，停止未完成' } : { ok: true };
      }
      if (a === 'restart') {
        await gateway.restart();
        if (gateway.running && gateway.ready) return { ok: true };
        if (gateway.running) return { ok: true, starting: true, error: `网关进程已重启，端口 ${gateway.configPort()} 尚未就绪（正在启动中）。` };
        return { ok: false, error: `网关重启后未处于运行状态（端口 ${gateway.configPort()}）。详见「日志」页。` };
      }
      if (a === 'get-config') return { ok: true, text: gateway.configText() };
      if (a === 'load-example') return { ok: true, text: gateway.exampleText() };
      if (a === 'clear-log') { gateway.clearLog(); return { ok: true }; }
      // 一键恢复（2026-10-29）：把引擎里所有冷却/熔断状态清空。
      // 网关没运行时**不能**假装成功：那些状态在引擎进程内存里，而进程已经没了 ——
      // 下次启动本来就是干净的。"什么都没做却回 ok"会让用户以为按钮坏了。
      if (a === 'reset-cooldowns') {
        if (!gateway.running) return { ok: false, error: '网关未运行（冷却状态在网关进程内存里，进程没了就是干净的，无需恢复）' };
        return await gateway.resetCooldowns();
      }
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
      // ⚠ 2026-11-12 复核修：这里以前是**直接赋值** r.warning，会把 saveConfig() 里
      // "重启网关失败：<真实原因>" 覆盖成一句更笼统的"重启后未运行" —— 真正的失败原因
      //（比如 taskkill 被拒 / 端口被占 / 配置没被引擎接受）从此消失。改成追加，两条都留。
      if (wasRunning && !gateway.running) {
        const extra = `配置已保存，但网关重启后未运行（端口 ${gateway.configPort()}）——请查看「日志」页。`;
        r.warning = r.warning ? (r.warning + ' ' + extra) : extra;
      }
    }
    broadcastState();
    return r;
  });

  handle('gw:validate', (_e, text) => validateConfigText(String(text == null ? '' : text)));

  /**
   * 使用记录（阶段 2）：聚合 `<data>/logs/usage/*.jsonl`。
   *
   * 聚合本身是**纯读 + 纯计算**（见 src/usage.js），不碰引擎、不碰网络 ——
   * 所以网关没运行时也能看历史记录（用户排查时正需要这个）。
   *
   * ⚠ 用**异步切片**版（2026-10-13 审计后修）：同步版在主进程里会被长冻结
   *（实测 150 万行 2624ms，期间窗口/托盘/菜单全部无响应）。
   * `summarizeAsync` 与同步版共用同一个累加器，结果一致，但会定期让出事件循环。
   */
  /**
   * 模型名归并表（2026-10-16）：把历史使用记录里的**上游 ID** 折回逻辑名。
   *
   * 为什么需要：引擎在 2026-10-16 之前记账写的是上游 ID，于是同一个逻辑模型
   *（如 `deepseek-v4.1-flash`，三家上游分别叫 `deepseek/deepseek-v4.1-flash` /
   * `DeepSeek-V4.1-Flash` / `deepseek-v4.1-flash`）在「模型分布」里被拆成三行。
   * 引擎侧已改为落盘即归一，但**已落盘的历史记录改不了**，只能在这里兜。
   *
   * 缓存 30 秒：聚合会被界面频繁触发（切天数、点刷新），而配置很少变。
   * 缓存的是**纯数据**（Map），不依赖配置对象引用，所以保存配置后最多 30 秒内自动跟上。
   */
  let usageAliasCache = { at: 0, val: null };
  function usageModelAlias() {
    const now = Date.now();
    if (usageAliasCache.val && now - usageAliasCache.at < 30000) return usageAliasCache.val;
    let val = null;
    try {
      const cfg = (gateway && typeof gateway.configObject === 'function' ? gateway.configObject() : null) || {};
      const byProvider = writersModels.buildUpstreamAliasMap(cfg);
      const names = writersModels.collectModelNames(cfg);
      const lower = writersModels.buildLowerIndex(names);
      // logicalSet 让归并**幂等**：新记录里已经是逻辑名，不能再被别名表映射一次
      //（见 src/usage.js 里 logicalOf 的顺序说明）。
      val = { byProvider, lower, logicalSet: new Set(names) };
    } catch (e) {
      // 配置读不到就不归并（原样展示），绝不因为归并失败而让使用记录页白屏
      logger.warn('使用记录：模型归并表构建失败，本次按原样展示：' + ((e && e.message) || e));
      val = { byProvider: new Map(), lower: new Map(), logicalSet: new Set() };
    }
    usageAliasCache = { at: now, val };
    return val;
  }

  handle('gw:usage', async (_e, opts) => {
    try {
      const o = opts && typeof opts === 'object' ? opts : {};
      const days = Math.min(365, Math.max(1, Number(o.days) || 30));
      return await summarizeAsync(path.join(dataDir, 'logs'), {
        days,
        detailLimit: o.detailLimit,
        filter: o.filter && typeof o.filter === 'object' ? o.filter : null,
        // 模型名归并（2026-10-16）：把历史记录里的**上游 ID** 折回逻辑名，详见 src/usage.js 文件头。
        // 表由配置推导，带 30 秒缓存 —— 聚合本身可能被频繁刷新，而配置很少变。
        modelAlias: usageModelAlias(),
      });
    } catch (e) {
      // 读不到/算不出都不该让界面白屏 —— 回一个空结果 + 原因
      return {
        error: (e && e.message) || String(e),
        days: 30, totalRows: 0, rows: 0,
        totals: null, byDay: [], byModel: [], byProvider: [], byEndpoint: [],
        detail: [], options: { models: [], providers: [], endpoints: [], statuses: [] },
      };
    }
  });

  handle('gw:health', async () => {
    if (!gateway.running) return { ok: false, error: '网关未运行' };
    const health = await gateway.healthSnapshot(4000);
    // ⚠ `ready` 原先只在 _doStart 末尾算一次（8 次探测、上界约 21.6s）。引擎慢于那个窗口时它是
    // false，而且**再没有任何机制能把它置回 true** —— 网关其实可用，界面却一直显示"启动中…"、
    // 托盘图标一直是灰的，直到用户手动停止/重启。界面每 5 秒就会调一次这里，正好拿来补。
    // （判据一致：`_doStart` 用的也是同一个 /health 探测。）
    if (health && health.ok && !gateway.ready) gateway.ready = true;
    return health;
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
    // ⚠ 试生成的预算控制。
    //
    // 试生成比目录探测慢一个数量级（nvidia 实测 25–29 秒；目录只要 0.15–1.5 秒）。
    // 11 家串行各跑一次 = 最坏 5 分钟，而整体预算只有 90 秒 —— 直接后果是
    // **只有前 2 家测到了、剩下 9 家全被标"未测"**，比不测更让人困惑。
    //
    // 所以给试生成设一个**独立的、按剩余预算收缩的**上限：
    //   · 剩余预算不足 GEN_MIN_MS 时，跳过试生成，只报目录结果（并明确标注"未验证生成"）
    //   · 单次试生成的超时取 min(45s, 剩余预算 - 余量)，避免它吃掉整个预算
    // 这样"能测就测、测不动就如实说没测"，不会静默退化成只测前两家。
    const GEN_MIN_MS = 12 * 1000;      // 剩余预算低于这个值就不再做试生成
    const GEN_TIMEOUT_MS = 45 * 1000;  // 单次试生成的上限
    for (const p of list.slice(0, 40)) {
      const spent = Date.now() - startedAt;
      if (spent > BUDGET_MS) {
        for (const rest of list.slice(results.length)) {
          results.push({ id: rest.id, ok: null, skipped: true, verdict: '未测（整体时间预算已用完，请稍后重试或单独测试）' });
        }
        logger.warn(`连通性测试：整体预算 ${BUDGET_MS / 1000}s 已用完，剩余 ${list.length - results.length} 家未测。`);
        break;
      }
      const remaining = BUDGET_MS - spent;
      const doGen = remaining >= GEN_MIN_MS;
      // 试生成用**这个供应商配置里已声明的上游模型 ID**（用户已验证过能用），
      // 而不是目录里第一个 —— 后者常常是"这个账号根本无权访问"的模型，
      // 拿它试会得出假失败（实测 nvidia 的 01-ai/yi-large、opencode-zen 的 big-pickle）。
      const declared = Array.isArray(p.models) ? p.models : [];
      const declaredModels = declared
        .map((m) => (typeof m === 'string' ? m : (m && (m.id || m.up))))
        .filter(Boolean);
      const genModel = declaredModels[0] || '';
      // eslint-disable-next-line no-await-in-loop
      const r = await probe.probeProvider(p, {
        proxy,
        noProxy,
        timeoutMs: 12000,
        // 预算不够、或这家没声明任何模型 → 不做试生成（结论里会标注"未验证生成"）
        deepProbe: doGen && !!genModel,
        genModel,
        // 第一个声明模型不可用≠这家不可用（实测 x666：首个模型回"分组里没有这个渠道"，
        // 而这家真实流量 37/37 全成功）。把其余已声明模型也给它，由 probe 决定要不要换着试。
        genModels: declaredModels,
        genTimeoutMs: Math.max(GEN_MIN_MS, Math.min(GEN_TIMEOUT_MS, remaining - 2000)),
        // 必须带上仿真头：有些上游（如 cline）不带自家头一律 403，
        // 用它做探测会把能用的家报成失败。
        headers: clientHeaders.probeHeaders(cfg, p, String(p.apiKey || '')
          || (Array.isArray(p.apiKeys) ? String(p.apiKeys[0] || '') : '')),
      });
      // 预算不够时明确标注，避免"目录可达"被误读成"生成可用"
      if ((!doGen || !genModel) && r && r.ok === true && !r.gen) {
        r.verdict = '可达，凭据格式有效（**未验证生成**：'
          + (!genModel ? '这家没声明任何模型' : '整体时间预算不足')
          + '，可单独测这一家）— ' + r.verdict;
        r.genSkipped = true;
      }

      // ⚠ 多 Key 的供应商要**逐把**试生成。
      //
      // 实测（2026-10-09，nvidia）：`apiKeys` 里 4 把 Key，`/v1/models` 全部 200，
      // 但 `chat/completions` 有 2 把是 403 `Authorization failed`。
      // 而 `probeProvider` 只取 `apiKey || apiKeys[0]` —— 于是：
      //   · 若第 1 把恰好是好的 → 整家显示"通过"，坏 Key 完全看不见；
      //   · 若第 1 把恰好是坏的 → 整家显示"凭据被拒"，而其实还有 3 把能用。
      // 两种情况都在骗用户。这里在有试生成的前提下把**每一把**都过一遍，
      // 并在结论里点名哪几把坏 —— 用户不用去 nvidia 后台也能知道该换哪把。
      const keys = Array.isArray(p.apiKeys) && p.apiKeys.length
        ? p.apiKeys.map((k) => String(k || '').trim()).filter(Boolean)
        : [];
      if (r && r.gen && keys.length > 1) {
        // 逐把体检用**刚刚验证过能出字**的那个模型：上面 probe 可能在模型级失败后换过模型，
        // 拿第一个声明模型逐把打分会让每家都变成"模型级不可用"（凭据好坏反而看不出来）。
        const keyGenModel = (r.gen && r.gen.ok && r.gen.model) ? r.gen.model : genModel;
        const perKey = [];
        for (let ki = 0; ki < keys.length; ki++) {
          // 每把都做一次最小生成；预算见底就停手并如实标注
          if (Date.now() - startedAt > BUDGET_MS - 3000) { perKey.push({ index: ki + 1, skipped: true }); continue; }
          const pOne = Object.assign({}, p, { apiKey: keys[ki], apiKeys: undefined });
          // eslint-disable-next-line no-await-in-loop
          const g = await probe.probeOneKeyGen(pOne, {
            key: keys[ki], model: keyGenModel, path: probe.genPathFor(p),
            proxy, noProxy, headers: clientHeaders.probeHeaders(cfg, p, keys[ki]),
            timeoutMs: Math.max(GEN_MIN_MS, Math.min(GEN_TIMEOUT_MS, BUDGET_MS - (Date.now() - startedAt) - 2000)),
          });
          perKey.push({ index: ki + 1, status: g.status, ms: g.ms, ok: g.ok, kind: g.kind, err: g.detail || '' });
        }
        // 分档聚合交给 probe.summarizeKeyResults（纯函数、有回归用例）：
        // 它区分"真的出字 / 凭据被拒 / 判不出来（限流·模型级·连接）"三档。
        // 旧实现把限流也算"被拒"，sensenova 两把 Key 都撞 429 时界面写「2 把被拒」——
        // 用户去换 Key 也换不出结果。
        r.perKey = perKey;
        const sum = probe.summarizeKeyResults(keys.length, perKey, r.modelCount);
        r.ok = sum.ok;
        r.keySummary = sum.keySummary;
        r.verdict = sum.verdict;
      }
      results.push(r);
    }
    // ⚠ 把**代理决策**一起回给界面。
    //
    // resolveProxy() 在"配置的代理连不上"时会**静默降级直连**（或换用自动探测到的代理）。
    // 降级本身是对的（否则一个不存在的代理会让网关全局不可用），但探测结果会把
    // "需要代理才能到的家"全报成"连不上（直连）" —— 用户看到一片红，自然以为渠道全挂。
    // 实测（2026-11-03）：本机代理没启动时，agentrouter/x666/windhub/nvidia 四家齐刷刷
    // 报"连不上"，而它们的真实调用成功率分别是 137/140、37/37、9/9 —— 全是假失败。
    // 所以这里必须把"本次是直连还是走代理、为什么"如实带出去，由界面写在列表上方。
    return { ok: true, proxy: proxy || '', proxyNote: gateway.proxyNote(), results };
  });

  // 拉取某个（可能是"还没保存的"）供应商的模型目录 —— 编辑抽屉里"拉取上游模型目录"用。
  // 入参来自渲染层，所以只接受白名单字段，且按同一套代理规则请求。
  handle('gw:fetch-catalog', async (_e, provider) => {
    const p = provider && typeof provider === 'object' ? provider : {};
    const base = probe.upstreamBase(String(p.baseURL || ''));
    if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Base URL 必须是 http(s) 绝对地址' };
    const probeBlock = await checkOutboundTarget(base);
    if (probeBlock) return { ok: false, error: probeBlock };
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
    const probeBlock = await checkOutboundTarget(base);
    if (probeBlock) return { ok: false, error: probeBlock };
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
    // ⚠ `_src` / `_matchedBy` 是**给界面看的**来源标注（"这个数字是上游给的还是按同族推测的"），
    // 不是配置字段。`model-meta.js` 的注释明确要求"在 handler 里剔除它再落盘"——
    // 而这里原来原样返回。实际落盘时 `applyModelPicker` 只挑已知字段构造对象，
    // 所以它们**没有**进过配置；但这属于"靠下游自觉"，一旦有人改成整对象展开就会污染配置。
    // 返回给渲染层仍然需要它们（界面要显示来源），所以这里**不删**，而是显式声明边界：
    // 渲染层负责在写回时只取已知字段（见 renderer/js/providers.js 的 applyModelPicker）。
    return {
      ok: true,
      models,
      unknown,
      count: models.length,
      via: r.via,
      ms: r.ms,
      // 上游到底有没有给参数 —— 界面据此决定要不要提示"这些参数得你自己填"
      upstreamRich: models.some((m) => m.contextWindow || m.maxTokens || m.vision),
      // 内部字段清单：告诉渲染层"这些不是配置字段，写回时别带上"
      internalFields: ['_src', '_matchedBy', '_keep', '_tmo'],
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
    const probeBlock = await checkOutboundTarget(base);
    if (probeBlock) return { ok: false, error: probeBlock };
    const list = (Array.isArray(models) ? models : []).slice(0, 60);
    if (!list.length) return { ok: false, error: '没有要测速的模型' };
    const proxy = await gateway.resolveProxy();
    const noProxy = String(gateway.computeNoProxy() || '').split(',').filter(Boolean);
    const out = [];

    // ⚠ 每个模型之间必须留间隔 —— 这是**防封**要求，不是保守起见。
    //
    // 本功能会对**每一个**勾选的模型发一次真实请求（nvidia 的目录有 80 个）。
    // 旧实现没有任何节流：连续打点，几十秒内把几十个请求砸到同一家上游。
    // 而 opencode 这类上游的限流是**静默**的（社区实测 ~15–20 RPM，不返回任何
    // rate-limit 响应头，也不告诉你还剩几次）—— 撞上了才知道，而撞上的代价是
    // **用户自己的正常对话也被连带限流**。
    //
    // 3500ms 间隔 ≈ 17 请求/分钟，正好卡在 15–20 RPM 的安全线内。
    // 代价是最坏耗时变长（每个模型 = 间隔 + 请求耗时），所以下面的预算要同步放宽。
    const SPACING_MS = (() => {
      const n = Number(process.env.DSH_GATEWAY_MEASURE_SPACING_MS);
      return Number.isFinite(n) && n >= 0 ? n : 3500;
    })();

    // 整体时间预算：与 gw:test-providers 同理。入参来自渲染层，若被塞进 60 个必定超时的模型，
    // 串行跑完最坏 60×(3.5s+40s) ≈ 43 分钟，界面会一直转圈。
    // 到点后返回已完成部分并如实说明（下面会把"还剩几个没测"带回渲染层）。
    const BUDGET_MS = 180 * 1000;
    const startedAt = Date.now();
    let lastReqAt = 0;
    let skippedByBudget = 0;
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
        skippedByBudget = list.length - out.length;
        logger.warn(`测速：整体预算 ${BUDGET_MS / 1000}s 已用完，剩余 ${skippedByBudget} 个未测。`);
        break;
      }
      // 防封间隔：距上一次请求不足 SPACING_MS 就等到够。
      // 第一次（lastReqAt=0）不等待 —— 用户刚点了按钮，不该白等 3.5 秒。
      if (lastReqAt) {
        const wait = SPACING_MS - (Date.now() - lastReqAt);
        if (wait > 0) {
          // 若等待会超出整体预算，就别再开新的一轮了，如实收尾
          if (Date.now() - startedAt + wait > BUDGET_MS) {
            skippedByBudget = list.length - out.length;
            logger.warn(`测速：为守住 ${SPACING_MS}ms 防封间隔会超出整体预算，停止；剩余 ${skippedByBudget} 个未测。`);
            break;
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      lastReqAt = Date.now();
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
    // 如实带回"为什么没测完" —— 界面据此提示，避免用户以为"全都测过了"。
    return {
      ok: true,
      results: out,
      spacingMs: SPACING_MS,
      skipped: skippedByBudget,
      note: out.length < list.length
        ? `已测 ${out.length}/${list.length} 个（每个之间留 ${SPACING_MS}ms 间隔以免触发上游限流），`
          + `剩余 ${skippedByBudget} 个因时间预算未测 —— 可再点一次继续。`
        : `已测 ${out.length} 个（每个之间留 ${SPACING_MS}ms 间隔以免触发上游限流）。`,
    };
  });

  /* ---------------- 一键写入 ---------------- */

  handle('write:detect', () => {
    const ctx = writeCtx({});
    // ⚠ 必须和 write:preview 一样脱敏。
    //
    // `detectAll()` 的返回值里带着各目标**当前配置的原始内容**（例如 claude-code 的
    // `current.authToken`、codex 的 `model_providers.*.experimental_bearer_token`）——
    // 那是用户自己的真实凭据。旧实现只把它原样经 IPC 送进渲染进程，而隔壁
    // `write:preview` 走的是 `sanitizePreview`。界面当前不显示 `current`，
    // 但值已经进了渲染进程内存（XSS / devtools / 堆转储都能读）。
    // 审计（2026-10-09 渲染/宿主 D3）实测：detect 返回的 authToken 是明文，
    // 而同一份文件走 preview 已打码成 ***。
    return sanitizePreview({ ok: true, targets: writers.detectAll(ctx) });
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
      // 临时名带 pid + 随机后缀（审计 R9-L5）：固定 `.tmp-import` 在"导入与保存并发"
      // 时会互相踩 —— 后一次 rename 可能 ENOENT（界面报导入失败，其实已写成功），
      // 也可能把另一份内容当成这次的结果。saveConfig 与 writers/util.js 都是这个口径。
      const tmp = gateway.configPath + '.tmp-import-' + process.pid + '-' + Math.random().toString(36).slice(2, 10);
      try {
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, gateway.configPath);
      } catch (e) {
        // 失败清掉临时文件：它含明文供应商密钥
        try { fs.unlinkSync(tmp); } catch (_) { /* 忽略 */ }
        throw e;
      }
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
      // ⚠ 导出的就是配置原文，里面**全是明文密钥**（每个 provider 的 apiKey/apiKeys/accounts）。
      // 2026-11-12 审计 M14：界面只提示「已导出到 <path>」，用户很容易把这份文件贴到群里、
      // 传网盘、发给同事排错。文件本身不能脱敏（导出的用途就是"换台机器还原"），
      // 所以至少要在返回值和界面上把风险说清。
      return {
        ok: true,
        path: r.filePath,
        warning: '该文件含**明文密钥**（所有供应商的 Key 都在里面），请勿外传或提交到代码仓库。',
      };
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
  // ⚠ 失败分支（!r.ok）过去**原样返回**，而 `errors[]` 恰恰是最可能带上游原文的地方
  //（"写入失败：… <上游返回的错误体>"）。预览的承诺是"不把密钥送进渲染进程"，
  // 那条承诺不该因为一次失败就失效 —— 失败路径反而是更容易漏的路径。
  //
  // 2026-11-12 审计 L3：所以两个分支做的是**同一件事**。这里曾经写成
  // `if (!r.ok) return scrubDeepSecrets(r); return scrubDeepSecrets(r);`，
  // 看着像"成功/失败分别处理"，其实只是同一个调用写了两遍 —— 读代码的人会以为
  // 存在差异分支而去找不存在的区别。压成一条语句，语义不变，意图更清楚。
  return r ? scrubDeepSecrets(r) : r;
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
  installShutdownWatch();

  if (settings.get('autoStartGateway') !== false) {
    gateway.start().catch((e) => logger.error('网关自动启动失败：' + (e && e.message ? e.message : e)));
  }

  logger.info(`${APP_NAME} 就绪`);
}

/**
 * 系统关机/注销监听（2026-11-12 审计 M9）。
 *
 * 为什么必须有：这个应用在 2026-11 的每一次"闪退"，事后查下去都是**用户从开始菜单关机**
 * （System 事件 1074 与 app.log 的「网关已退出（1073807364）」逐条毫秒级对齐），但应用自己
 * **完全不知道自己是被关机带走的** —— 全 src 搜 `powerMonitor|session-end` 零命中。
 *
 * 后果有两层，第二层才是真问题：
 *   ① 日志把这次退出记成「**非预期**」并触发一次无效 self-heal（进程马上就没，自愈白设）；
 *   ② 更糟的是**排障方向被带偏**：用户（和我）看到"非预期退出 + 没有堆栈 + 没有 WER"，
 *      只能往崩溃/被杀软杀/内存溢出这些方向猜，而真相是"你自己关的机"。
 *      这是"闪退查不出来"的主要成因之一 —— 证据其实一直都在 Windows 事件日志里，
 *      只是应用从没在自己的日志里说过一句"我是被关机带走的"。
 *
 * 现在：收到关机通知时（Windows 用窗口级的 `query-session-end` / `session-end`；
 * Linux/macOS 用 `powerMonitor` 的 `shutdown`）
 *   · 记一行带时间的日志，明确写明"系统关机/注销触发，本次退出属预期"；
 *   · 把 `gateway._appQuitting` 置真，让引擎 `exit` 归因走「应用正在退出（预期内）」，
 *     不再误记"非预期"、不再触发 self-heal；
 *   · **不** preventDefault：不跟用户的关机流程抢时间（stop() 最坏 22.4s，硬拦会让
 *     "关机卡住"变成新问题），也不指望在关机窗口里还能优雅收尾 —— 被强杀是可以接受的，
 *     只要日志留下了正确的归因。
 */
function noteShutdown(source) {
  try {
    if (logger) {
      logger.info('收到系统关机/注销通知（' + source + '）—— 本次退出属**预期**，'
        + '不是崩溃、也不是被强杀。之后的「网关已退出」若记成因未知，请先查 Windows 事件日志 1074。');
    }
  } catch (_) { /* 日志失败不能影响关机 */ }
  try { if (gateway) gateway._appQuitting = true; } catch (_) { /* 忽略 */ }
}

function installShutdownWatch() {
  try {
    if (!powerMonitor || typeof powerMonitor.on !== 'function') return;
    // Linux/macOS 走这里；Windows 上这个事件不存在（Electron SDK 标 `@platform linux,darwin`），
    // 由 createWindow() 里的 `query-session-end` / `session-end` 负责。
    powerMonitor.on('shutdown', () => noteShutdown('powerMonitor shutdown'));
  } catch (e) {
    try { if (logger) logger.warn('注册关机监听失败（不影响运行）：' + (e && e.message ? e.message : e)); } catch (_) { /* 忽略 */ }
  }
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
 *
 * ⚠⚠ 放行判据必须是 `allowQuit`（收尾**完成**），不能用 `teardownStarted`（收尾**开始**）
 * —— 2026-11-12 审计 H6。旧实现写的是 `if (teardownStarted) return;`，而 teardownStarted
 * 在下面第 1238 行就被置 true，allowQuit 要等 stop() 完成才为 true。二者的时间差就是
 * **整个收尾窗口**（stop() 里要等 `_starting`，最坏 8×(2000+800)≈22.4s，再到
 * killStaleGatewayProcesses 还有 15s PowerShell 上限）。
 * 在这个窗口里任何**第二次** before-quit（用户又点了一次退出 / 关窗 / 托盘退出 /
 * 系统的 session-end 触发 app.quit）都会走到 `return` → 不再 preventDefault →
 * Electron 立刻退出，而 stop() 还在半路 → **引擎成为孤儿并占着端口**。
 * 已用 host2/exp-e-double-quit.js 复现：t=0.2s 第二次 before-quit 就放行了，
 * 而 stop() 到 t≈3.6s 才完成。
 *
 * 现在：`allowQuit` 才放行；`teardownStarted` 只用于"已在收尾中，继续阻止退出"。
 */
app.on('before-quit', (e) => {
  if (allowQuit) return;                   // 收尾已完成 → 放行（这一次不再拦）
  if (!gateway) { allowQuit = true; return; }
  e.preventDefault();                      // 只要还没收尾完，就一直拦着
  if (teardownStarted) return;             // 已在收尾中 → 继续拦，等它完成
  teardownStarted = true;
  // 告诉网关管理器"这次退出是预期的"（2026-10-13 加）：
  // 它在子进程 exit 时据此区分「用户/应用主动停止」与「**非预期**被杀」，
  // 后者会额外记录现场，便于归因"不时自动退出"。
  try { gateway._appQuitting = true; } catch (_) { /* 忽略 */ }
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

// 进程被硬杀（任务管理器结束进程 / 控制台 Ctrl+C / 服务管理器发 SIGTERM）时也尽力收尾。
// 这类信号下 Electron 未必走 before-quit，但至少别让引擎继续占端口。
//
// ⚠⚠ 必须 **await** stop()，不能"发出去就走"（2026-11-12 审计 H5）。
// 旧实现：
//     try { if (gateway) gateway.stop(); } catch (_) {}
//     setTimeout(() => app.exit(0), 1500);
// 两个问题叠在一起：
//   1) `gateway.stop()` 没有被 await —— 它内部第一句是 `if (this._starting) await this._starting`，
//      而 `_starting` 的最坏情况是就绪探测上界 8×(2000+800)≈22.4s。1500ms 时它**还没走到 taskkill**。
//   2) 1500ms 的 `app.exit(0)` 是硬退出，不跑 before-quit、不跑任何收尾 → 引擎一定成孤儿。
// 已用 host2/exp-c-signal-orphan.js 复现：1500ms 时 taskkill 次数 = 0，子进程 exitCode 仍是 null，
// 父进程已 app.exit(0) → 引擎继续占着 3091。
//
// 现在：先 await 收尾，收到信号后**尽快**退；同时保留一个硬上限兜底，避免 stop() 自己卡死时
// 进程永远不退出。上限取 30s（> 22.4s 就绪探测 + 15s killStale 的合理重叠区间），
// 触发时会明确 log 一行"超时强制退出"，便于日后归因。
const SIGNAL_TEARDOWN_DEADLINE_MS = 30_000;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { if (logger) logger.info('收到系统信号 ' + sig + '，开始收尾（这是**外部**要求退出）。'); } catch (_) { /* 忽略 */ }
    allowQuit = true;
    let exited = false;
    const finish = (why) => {
      if (exited) return;
      exited = true;
      try { if (logger) logger.info('收尾完成（' + why + '），退出。'); } catch (_) { /* 忽略 */ }
      app.exit(0);
    };
    // 硬上限：stop() 若自身卡住，也别让进程挂在那里
    setTimeout(() => {
      try { if (logger) logger.warn('收尾超过 ' + (SIGNAL_TEARDOWN_DEADLINE_MS / 1000) + 's 仍未完成 → 强制退出（可能残留引擎进程，下次启动会自动清理）。'); } catch (_) { /* 忽略 */ }
      finish('超时强制');
    }, SIGNAL_TEARDOWN_DEADLINE_MS).unref?.();
    (async () => {
      try { if (gateway) await gateway.stop(); } catch (err) {
        try { if (logger) logger.error('信号收尾时停止网关失败：' + (err && err.message ? err.message : err)); } catch (_) { /* 忽略 */ }
      }
      try { if (gateway) await gateway.killStaleGatewayProcesses(); } catch (_) { /* 忽略 */ }
      finish('信号 ' + sig);
    })();
  });
}

/* ------------------------------------------------------------------ *
 * 主进程级诊断（2026-10-13 加）
 *
 * 起因：用户报"网关不时自动退出"，但日志里**一条异常都没有**、Windows 也没有崩溃事件。
 * 那说明「应用整体被外部终止」的可能性最大 —— 而这种情况此前**完全没有痕迹**：
 * 主进程被 taskkill /F 时不会走 before-quit，也不会有任何日志。
 *
 * 所以这里把主进程自己的生命周期也记下来。判读方法：
 *   · 看到「主进程正在退出」但没有「已退出。」→ 主进程是被**外部**终止的
 *   · 有「捕获到未处理异常」→ 是主进程 JS 报错（真 bug，堆栈就在下面）
 *   · 有「子进程异常退出（非网关）」→ 某个渲染/GPU/工具进程先死
 * ------------------------------------------------------------------ */

// 主进程 JS 层未捕获的错误。
// ⚠ 注册处理器会**取代** Node 的默认行为（崩溃退出）—— 若只是 log 然后继续跑，
// 进程可能带着损坏状态运行，比崩溃更糟（审计 2026-10-13 复核修正：旧版这里
// 注释写"这会导致应用退出"，恰好写反了）。
// 所以这里：记下完整堆栈 → **显式退出 1**。退出语义与旧行为一致，但多了可归因的日志；
// process.on('exit') 会随之以 code=1 记为「非预期」，归因链完整。
let _crashExiting = false;
function crashAfterLog(label, err) {
  if (_crashExiting) return;
  _crashExiting = true;
  try {
    logger.error(label + (err && err.stack ? err.stack : String(err)));
  } catch (_) { /* 日志器不可用也要继续退出，不能吞掉崩溃 */ }
  // 留 300ms 让异步日志落盘，然后按"崩溃"语义退出
  setTimeout(() => app.exit(1), 300).unref?.();
}
process.on('uncaughtException', (err) => crashAfterLog('主进程未捕获异常（按崩溃处理，退出码 1）：', err));
process.on('unhandledRejection', (reason) => crashAfterLog('主进程未处理的 Promise 拒绝（按崩溃处理，退出码 1）：', reason));

// ⚠ 这是**同步**钩子：只能做同步日志，不能 await。
// 它会在正常退出与 process.exit() 时触发；被 taskkill /F 强杀时**不会**触发 ——
// 所以"缺少这一行"本身就是"被强杀"的证据。
process.on('exit', (code) => {
  try {
    const why = teardownStarted || allowQuit ? '（预期内）' : '（**非预期** —— 应用是被外部终止或崩溃的）';
    logger.info('主进程正在退出，退出码 ' + code + ' ' + why);
  } catch (_) { /* 忽略 */ }
});

// Electron 的所有子进程（渲染/GPU/工具）死亡都会到这里 —— 比只监听单个 webContents 更全。
// ⚠ 正常退出时子进程也会死（reason=killed），若一律记 ERROR，每次退出都制造一串假警报
//（审计 2026-10-13 复核修正）：退出中记 INFO，其余才 ERROR。
app.on('child-process-gone', (_e, details) => {
  try {
    const d = details || {};
    const quitting = teardownStarted || allowQuit;
    const note = d.reason === 'killed'
      ? 'reason=killed 表示**被外部杀死**（不是崩溃，也不是内存不足）'
      : 'reason=' + d.reason;
    const line = '子进程退出：type=' + d.type + ' reason=' + d.reason
      + ' exitCode=' + d.exitCode + (d.serviceName ? ' service=' + d.serviceName : '')
      + '｜' + note + (quitting ? '（应用退出中，预期内）' : '');
    if (quitting) logger.info(line);
    else logger.error(line);
  } catch (_) { /* 忽略 */ }
});
