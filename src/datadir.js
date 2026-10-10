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
  // ⚠ 凭据由**本机其它程序**提供的鉴权方式：配置里本来就没有 Key，但这是**合法**配置。
  // 漏掉它们 → 该供应商被当成"示例占位"，整个配置被判为占位而**被覆盖**（数据丢失）。
  // 实测（2026-10-09）：这里只有 workbuddy，于是 codex 供应商会被误判。
  // 与 gateway-manager.js 的 KNOWN_AUTH、引擎的 providerHasCredential()、
  // 渲染层的 CREDENTIAL_FREE_AUTH 是同一组值 —— **四处必须同步**。
  const credFreeAuth = String(p.auth || '').trim().toLowerCase();
  if (credFreeAuth === 'workbuddy' || credFreeAuth === 'codex') return true;
  if (Array.isArray(p.accounts) && p.accounts.length > 0) return true;
  return false;
}

/** 出厂示例里出现过的供应商 id（只有它们同时出现在示例中）。 */
const SAMPLE_PROVIDER_IDS = new Set(['provider-a', 'provider-b', 'provider-c', 'workbuddy', 'cline']);
/** 出厂示例里出现过的 baseURL 形态。 */
const SAMPLE_URL_RE = /^https?:\/\/(api\.example\d?\.com|copilot\.tencent\.com|api\.cline\.bot)(\/|$)/i;
/** 示例专属 id：真实用户不会这么命名（这是判定的**锚点**）。 */
const SAMPLE_ANCHOR_RE = /^provider-[a-z]\d*$/i;

/**
 * 判断一份网关配置是不是"出厂示例"而不是用户的真实配置。
 *
 * ## 为什么改成"正向识别示例"，而不是"启发式判断真假"
 *
 * 旧实现是 `!enabled.some(looksReal)` —— 从"有没有一家看起来是真的"反推。
 * 这条路会**把真实配置误判成示例**，而后果是**启动时静默覆盖用户配置（不可逆数据丢失）**。
 * 实测（2026-10-09 渲染/宿主审计 D1，两条都能复现）：
 *   · 用户**临时停用全部供应商** → `enabled.length===0` → 判为占位 → 下次启动被覆盖
 *   · 用户用**自建中转 / Ollama / 本地代理**，Key 短于 16 字符（如 `localkey123`）
 *     → `looksReal` 为假 → 判为占位 → 被覆盖
 * 两者都只剩一份 `.bak-import`，且该备份只在第一次生成。
 *
 * 判据现在改成**正向匹配出厂示例的特征**，并保守到底：
 *   ① 必须**含示例专属锚点**（`provider-a` 这类 id）—— 真实用户不会这么命名；
 *     这条锚点让"用户只用 cline"这种巧合不会被误判（他们的配置里没有 provider-a）；
 *   ② **每一个**供应商的 id 与 baseURL 都必须落在示例的取值范围内；
 *   ③ 缺任何一条 → 判为"真实配置"，**宁可不去导入，也绝不覆盖**。
 *
 * 取舍是不对称的：误判成"真实"的代价只是示例没被替换掉（用户看得见、随手能删）；
 * 误判成"占位"的代价是**用户数据没了**。
 */
function isPlaceholderConfig(text) {
  if (!text) return true;
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (_) {
    // 解析不了 → 仍按占位处理（允许被导入覆盖）。此时文件本来也**用不了**，
    // 且 importGatewayConfig 覆盖前会先备份成 .bak-import，可人工找回。
    return true;
  }
  const ps = Array.isArray(cfg.providers) ? cfg.providers : [];
  if (ps.length === 0) {
    // 一条供应商都没有（字段缺失或空数组）→ **没有任何可丢的数据**，
    // 允许被导入替换（首次运行、或用户把配置清空了想重新导入）。
    // ⚠ 注意与"有供应商但全停用"的区别：那才是有数据、必须保护（见下方 every 判定）。
    return true;
  }
  // ① 锚点：没有示例专属 id，就不是出厂示例
  if (!ps.some((p) => p && SAMPLE_ANCHOR_RE.test(String(p.id || '')))) return false;
  // ② 每一项都必须落在示例范围内
  return ps.every((p) => p && typeof p === 'object'
    && SAMPLE_PROVIDER_IDS.has(String(p.id || ''))
    && SAMPLE_URL_RE.test(String(p.baseURL || '')));
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
