// datadir.js — 数据目录解析（便携优先，与 DSH App 同一套策略）
//
// 优先级：
//   1) 环境变量 LLM_GATEWAY_DATA_DIR 显式覆盖（可写性探测通过才用）；
//   2) 便携目录 <base>\data\：
//        · 打包后 base = exe 所在目录（绿目录随程序走，复制即迁移）
//        · 源码直跑 base = 应用根（避免写进 node_modules\electron\dist）
//   3) 回退 %APPDATA%\llm-gateway
//
// 数据内容：settings.json、gateway.config.json、logs\ 全部在这里。
//
// 首次运行还会做一次**网关配置导入**：从 dsh-app / DSH 桌面助手的历史位置找一份真实
// gateway.config.json（用户已经配好的 12 家供应商 + 密钥），复制过来，免得重填。
'use strict';

const fs = require('fs');
const path = require('path');
const { APP_ROOT, exeDir } = require('./paths');

function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test-' + process.pid);
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 收集"应用自身所在目录树"的各级基目录（最多向上 6 层）。
 *
 * ⚠ **刻意不用 `process.cwd()`**。旧实现沿 cwd 向上找 12 层，于是绿色版被放在下载目录、
 * 共享目录，或者用快捷方式把"起始位置"指到某个临时目录时，只要那个目录里摆一份
 * `dsh-app/out/DSH-App/data/gateway.config.json`，首次运行就会被当成"用户的真实配置"导入
 * ——里面的供应商 baseURL/Key 由别人指定，随后还会被一键写进 dsh/Claude Code/Codex 的配置，
 * 把模型流量指向攻击者端点（实测确认过这条链路）。
 * 现在只从"程序自己所在的目录"往上找：这仍然覆盖了"绿目录放在 dsh-app 源码树里"这个真实场景，
 * 但攻击者要利用就得先能往程序的安装位置写文件（那时他已经赢了）。
 */
function appBases() {
  const roots = [];
  for (const start of [APP_ROOT, exeDir()]) {
    let cur = start;
    for (let i = 0; i < 6 && cur; i++) {
      if (!roots.includes(cur)) roots.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return roots;
}

/**
 * 网关配置的**导入来源**候选（按优先级）。全部指向"别处已经配好的真实配置"。
 * 每一项是惰性求值函数，返回绝对路径。
 */
function importSources() {
  const list = [];
  const push = (fn) => list.push(fn);
  // 显式指定
  push(() => process.env.LLM_GATEWAY_IMPORT_CONFIG || '');
  // 同目录树里的 dsh-app（源码树开发时最常用）
  for (const base of appBases()) {
    push(() => path.join(base, 'dsh-app', 'out', 'DSH-App', 'data', 'gateway.config.json'));
    push(() => path.join(base, 'dsh-app', 'out', 'DSH-App-UAT', 'data', 'gateway.config.json'));
    push(() => path.join(base, 'dsh-app', 'data', 'gateway.config.json'));
  }
  // DSH 桌面助手 / dsh-app 的历史数据目录
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const appData = process.env.APPDATA || '';
  for (const base of [home, appData]) {
    if (!base) continue;
    push(() => path.join(base, 'DSH-App', 'gateway.config.json'));
    push(() => path.join(base, 'DSHDesktop', 'gateway.config.json'));
    push(() => path.join(base, 'dsh-desktop', 'data', 'gateway.config.json'));
    push(() => path.join(base, 'dsh-desktop-github', 'data', 'gateway.config.json'));
    push(() => path.join(base, 'DSH App', 'gateway.config.json'));
  }
  return list;
}

/** 单个供应商条目是否"看起来是真的"（用户自己填的），而不是模板里的占位。 */
function looksReal(p) {
  if (!p || typeof p !== 'object') return false;
  const id = String(p.id || '');
  const url = String(p.baseURL || '');
  if (/^provider-[a-z]\d*$/i.test(id)) return false;
  if (/^mock/i.test(id)) return false;
  if (/api\.example\d?\.com/i.test(url)) return false;
  if (/127\.0\.0\.1:319\d/.test(url)) return false;
  // 凭据像真的：够长，且不是示例里的占位串
  const keys = [p.apiKey].concat(Array.isArray(p.apiKeys) ? p.apiKeys : []).filter(Boolean).map(String);
  if (keys.some((k) => k.trim().length >= 16 && !/change[-_]?me|xxxx|yyyy|在此填入|your[_-]?key|placeholder/i.test(k))) return true;
  if (String(p.auth || '').trim().toLowerCase() === 'workbuddy') return true;
  if (Array.isArray(p.accounts) && p.accounts.length > 0) return true;
  return false;
}

/**
 * 判断一份网关配置是不是"示例/占位"而不是用户的真实配置。
 *
 * 规则：**只看启用的供应商里有没有一家看起来是真的**。
 * 这样处理是必须的 —— 示例文件里除了 provider-a/provider-b 还带着 workbuddy 与 cline
 * 两个"示范条目"（enabled: false，密钥是 `sk_在此填入…` 这类占位）。旧实现要求
 * "每一个条目都像占位"才算占位，于是示例文件因为这两个条目被误判成"真实配置"，
 * 首次运行的导入被直接跳过（实测踩到：用户那 12 家供应商没被导进来）。
 */
function isPlaceholderConfig(text) {
  if (!text) return true;
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (_) {
    return true;      // 解析不了 → 当作占位，允许被导入覆盖
  }
  const ps = Array.isArray(cfg.providers) ? cfg.providers : [];
  if (ps.length === 0) {
    // 空 providers：只要没有像样的统一 Key，就算占位
    return !/"apiKey"\s*:\s*"(?!dsh-gateway-change-me)[^"]{16,}"/.test(text);
  }
  const enabled = ps.filter((p) => p && p.enabled !== false);
  if (enabled.length === 0) return true;
  return !enabled.some(looksReal);
}

/**
 * 首次运行导入网关配置。
 *   · 目标不存在 → 从第一个"非占位"来源复制；
 *   · 目标是占位配置且存在真实来源 → 备份后覆盖；
 *   · 目标是真实配置 → 一律不动。
 *
 * @returns {{action:'imported'|'upgraded'|'skipped', from?:string, reason?:string}}
 */
function importGatewayConfig(dataDir, sources) {
  const target = path.join(dataDir, 'gateway.config.json');
  const exists = fs.existsSync(target);
  let targetText = '';
  if (exists) {
    try { targetText = fs.readFileSync(target, 'utf8'); } catch (_) { targetText = ''; }
    if (!isPlaceholderConfig(targetText)) return { action: 'skipped', reason: '已有真实配置' };
  }
  const list = sources || importSources();
  for (const src of list) {
    let from = '';
    try { from = typeof src === 'function' ? src() : String(src || ''); } catch (_) { continue; }
    if (!from || !fs.existsSync(from)) continue;
    if (path.resolve(from) === path.resolve(target)) continue;
    let text = '';
    try { text = fs.readFileSync(from, 'utf8'); } catch (_) { continue; }
    if (isPlaceholderConfig(text)) continue;                 // 来源也是占位 → 找下一个
    if (!probeWritable(dataDir)) return { action: 'skipped', reason: '数据目录不可写' };
    if (exists) {
      const bak = target + '.bak-import';
      // 备份失败就**中止覆盖**：覆盖不可逆，不能赌
      try { if (!fs.existsSync(bak)) fs.copyFileSync(target, bak); }
      catch (e) { return { action: 'skipped', reason: '备份失败已中止：' + (e && e.message ? e.message : e) }; }
    }
    const tmpTarget = target + '.tmp-import-' + process.pid;
    try {
      // 原子落地：直接 copyFileSync 到目标的话，中途失败/断电会留下**半截 JSON**，
      // 网关下次启动拿它当配置解析就会失败（表现为"配置突然不可用了"）。
      // 与 gateway-manager.saveConfig 的 tmp+rename 保持一致。
      fs.copyFileSync(from, tmpTarget);
      fs.renameSync(tmpTarget, target);
    } catch (e) {
      try { fs.unlinkSync(tmpTarget); } catch (_) { /* 忽略 */ }
      return { action: 'skipped', reason: '复制失败：' + (e && e.message ? e.message : e) };
    }
    return { action: exists ? 'upgraded' : 'imported', from };
  }
  return { action: 'skipped', reason: '未找到可导入的真实配置' };
}

function resolveDataDir(opts) {
  const options = opts || {};
  // 1) 显式覆盖
  const override = process.env.LLM_GATEWAY_DATA_DIR;
  if (override && probeWritable(override)) return override;

  // 2) 便携目录
  const packaged = options.packaged !== undefined ? options.packaged : false;
  const base = packaged ? exeDir() : APP_ROOT;
  const portable = path.join(base, 'data');
  if (probeWritable(portable)) return portable;

  // 3) %APPDATA%\llm-gateway
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
  const fallback = path.join(appData, 'llm-gateway');
  probeWritable(fallback);
  return fallback;
}

module.exports = { resolveDataDir, importGatewayConfig, importSources, isPlaceholderConfig, probeWritable };
