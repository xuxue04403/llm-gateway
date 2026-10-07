// writers/index.js — 一键写入的目标注册表与统一入口
//
// 每个目标实现同一组方法（可选实现 restore）：
//   detect(ctx)  → { id, installed, evidence[], configPaths[], current{} }
//   preview(ctx) → { id, name, summary, guard[], files[{path, action, before, after, note}], warnings[] }
//   apply(ctx)   → { ok, errors[], files[], backups[], output, nextSteps[] }
//   restore(ctx) → { ok, errors[], results[] }
//
// ctx 由 makeContext() 统一构造，包含：
//   port / apiKey / config(user) / configPath / dataDir / enginePath / nodeExe / nodeEnv / options / home
// `home` 只在测试里传（把写入指向临时目录）——生产路径一律用真实用户主目录。
'use strict';

const path = require('path');

const dsh = require('./target-dsh');
const claudeCode = require('./target-claude-code');
const codex = require('./target-codex');
const opencode = require('./target-opencode');
const envscript = require('./target-envscript');

// 展示顺序 = 推荐顺序：已在本机实测/验证过的排前面，通用兜底殿后
//
// ⚠ 这里**曾经**还有 iFlow CLI（`target-iflow.js`），已于 2026-10 移除：
// iFlow CLI 官方公告 2026-03-20 停止维护、2026-04-17 正式关闭，
// iFlow API 服务与模型库同步关停（建议迁往 Qoder）。给一个已停服的产品写配置没有意义。
// 若你此前用它写入过，备份仍留在 `~/.iflow/settings.json.bak-llmgateway`，
// 那个文件就是一份普通 JSON，手工改回 `.iflow/settings.json` 即可。
const TARGETS = [dsh, claudeCode, codex, opencode, envscript];

const BY_ID = new Map(TARGETS.map((t) => [t.id, t]));

/**
 * 目标的展示元信息（界面用，不需要 detect）。
 *
 * ⚠ 返回的对象会经 IPC 送到渲染层，**必须全部是可结构化克隆的值**。
 * （踩过的坑：这里曾返回 `baseUrl` 函数本身 → 整个 `app:state` 报
 * "An object could not be cloned"，界面一片空白。函数永远不要放进 IPC 载荷。）
 */
function list() {
  return TARGETS.map((t) => ({
    id: t.id,
    name: t.name,
    method: t.method || 'file',
    // "这家的 baseURL 带不带 /v1" 是最容易填错、也最难自查的一项，界面上直接标出来
    baseUrlHint: t.baseUrlHint || '',
  }));
}

function get(id) {
  return BY_ID.get(String(id || '')) || null;
}

/**
 * 构造 ctx。
 * @param {object} o
 *   gateway    - GatewayManager（提供 configObject / configPath / apiKey / port / mjsPath）
 *   dataDir    - 数据目录
 *   nodeExe / nodeEnv - 引擎子进程运行时
 *   options    - 各目标的目标选项（{ model, smallModel, setDefaultModel, wireApi, writeAuth }）
 *   home       - 覆盖用户主目录（仅测试）
 */
function makeContext(o) {
  const gw = o.gateway;
  const cfg = gw && typeof gw.configObject === 'function' ? gw.configObject() : null;
  return {
    port: Number(o.port) || (gw && gw.configPort ? gw.configPort() : 3091),
    apiKey: o.apiKey !== undefined ? o.apiKey : (gw && gw.apiKey ? gw.apiKey() : ''),
    config: cfg || { providers: [] },
    configPath: (gw && gw.configPath) || path.join(o.dataDir, 'gateway.config.json'),
    dataDir: o.dataDir,
    enginePath: (gw && gw.mjsPath) || '',
    nodeExe: o.nodeExe || process.execPath,
    nodeEnv: o.nodeEnv || {},
    options: o.options || {},
    home: o.home,
  };
}

function detectAll(baseCtx) {
  const out = [];
  for (const t of TARGETS) {
    try {
      out.push(t.detect(baseCtx));
    } catch (e) {
      // ⚠ 兜底对象必须带上 wire。dsh 是唯一"线协议由全局 clientProfile 决定"的目标，
      // 界面专门为它显示"将写入 <协议> / <baseURL>"。旧实现这个分支没有 wire，
      // 于是 detect 一失败（例如 ~/.dsh/settings.yaml 是目录、ACL 拒绝时 statSync 抛），
      // 那行就显示成"（未知）"—— 恰恰是用户最没把握、最需要提示的时候。
      // 其它 4 个目标不读 wire，所以只有 dsh 受影响。
      const one = {
        id: t.id, name: t.name, installed: false,
        evidence: ['检测失败：' + (e && e.message ? e.message : e)],
        configPaths: [], current: {},
      };
      if (typeof t.wireOf === 'function') {
        try { one.wire = t.wireOf((baseCtx && baseCtx.config) || {}, baseCtx && baseCtx.port); } catch (_) { /* 猜不出来就算了 */ }
      }
      out.push(one);
    }
  }
  return out;
}

function preview(id, ctx) {
  const t = get(id);
  if (!t) return { ok: false, errors: ['未知目标：' + id] };
  try {
    const p = t.preview(ctx);
    return Object.assign({ ok: true, errors: [] }, p);
  } catch (e) {
    return { ok: false, errors: ['预览失败：' + (e && e.message ? e.message : e)] };
  }
}

/**
 * 执行写入。
 *
 * ⚠ **永远返回 Promise，并且永不抛**。原因是各目标的 apply 形状不统一：dsh 把写入交给
 * 引擎子进程，所以是 async；其余是同步的。旧实现直接 `return t.apply(ctx)`，于是调用方
 * 拿到 Promise 却在同步地读 `r.ok` —— dsh 的写入**在界面上永远报"失败"**（尽管磁盘上
 * 其实写成功了）。在这里统一成 async 并在内部吞掉异常，调用方就不需要记住这个区别了。
 *
 * @returns {Promise<{ok:boolean, errors:string[], files:string[], backups?:string[], output?:string, nextSteps?:string[]}>}
 */
async function apply(id, ctx) {
  const t = get(id);
  if (!t) return { ok: false, errors: ['未知目标：' + id], files: [] };
  try {
    const r = await t.apply(ctx);
    if (!r || typeof r !== 'object') return { ok: false, errors: ['该目标没有返回有效结果'], files: [] };
    return r;
  } catch (e) {
    return { ok: false, errors: ['写入过程抛出异常：' + (e && e.message ? e.message : e)], files: [] };
  }
}

async function restore(id, ctx) {
  const t = get(id);
  if (!t) return { ok: false, errors: ['未知目标：' + id], results: [] };
  if (typeof t.restore !== 'function') return { ok: false, errors: ['该目标不支持恢复'], results: [] };
  try {
    return await t.restore(ctx);
  } catch (e) {
    return { ok: false, errors: ['恢复失败：' + (e && e.message ? e.message : e)], results: [] };
  }
}

module.exports = { TARGETS, list, get, makeContext, detectAll, preview, apply, restore };
