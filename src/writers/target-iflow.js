// writers/target-iflow.js — 一键写入 iFlow CLI
//
// 目标文件：`<home>\.iflow\settings.json`（本机实测确认的形态 —— 该客户端已装在本机，
// 因此这是所有"其它客户端"里**唯一能被真实回归验证**的一个）。
//
// 实测字段：selectedAuthType / searchApiKey / baseUrl / apiKey / modelName / language
//   · baseUrl  **带 /v1**（本机现值即 `https://apis.iflow.cn/v1`）
//   · apiKey   直接用明文存在该文件里，因此"一键写入"不需要碰任何凭据库
//   · modelName 单个模型名
//
// ⚠ 本机的 `selectedAuthType` 是 `oauth-iflow`（走 OAuth 登录）。把 baseUrl/apiKey 改成
// 自建网关时必须同时把它切成 API Key 模式，否则客户端仍拿 OAuth 走官方端点、本配置不生效。
// 这里写成 `api-key` 并在预览里明确告知；原值有备份可一键恢复。
'use strict';

const os = require('os');
const path = require('path');

const util = require('./util');
const models = require('./models');

const TARGET_ID = 'iflow';

function homeOf(ctx) { return (ctx && ctx.home) || os.homedir(); }
function settingsPath(ctx) { return path.join(homeOf(ctx), '.iflow', 'settings.json'); }

/** baseURL：**带 /v1**（本机实测现值即带 /v1）。 */
function baseUrl(port) { return `http://127.0.0.1:${port}/v1`; }

const MANAGED_KEYS = ['baseUrl', 'apiKey', 'modelName', 'selectedAuthType'];

function detect(ctx) {
  const home = homeOf(ctx);
  const dir = path.join(home, '.iflow');
  const file = settingsPath(ctx);
  const cfg = util.readJson(file, {});
  return {
    id: TARGET_ID,
    installed: util.exists(dir),
    evidence: [
      util.exists(dir) ? `配置目录存在：${dir}` : '未发现 ~/.iflow 目录（iFlow CLI 可能未安装）',
      util.exists(file) ? `settings.json 存在（${util.readText(file).length} B）` : 'settings.json 不存在（写入会新建）',
      cfg.baseUrl ? `当前 baseUrl = ${cfg.baseUrl}` : '当前未设置 baseUrl',
      cfg.selectedAuthType ? `当前鉴权方式 = ${cfg.selectedAuthType}` : '',
      cfg.modelName ? `当前模型 = ${cfg.modelName}` : '',
    ].filter(Boolean),
    configPaths: [file],
    current: {
      baseUrl: cfg.baseUrl || '',
      authType: cfg.selectedAuthType || '',
      model: cfg.modelName || '',
    },
  };
}

function plan(ctx) {
  const names = models.collectModelNames(ctx.config || {});
  const model = String((ctx.options && ctx.options.model) || '').trim() || models.pickDefaultModel(ctx.config || {});
  return { names, model };
}

function buildConfig(cfg, ctx, model) {
  const out = Object.assign({}, cfg);
  delete out.__parseError;
  out.baseUrl = baseUrl(ctx.port);
  out.apiKey = String(ctx.apiKey || '');
  if (model) out.modelName = model;
  out.selectedAuthType = 'api-key';
  return out;
}

function preview(ctx) {
  const file = settingsPath(ctx);
  const before = util.readText(file);
  const cfg = util.readJson(file, {});
  const { names, model } = plan(ctx);
  const guard = [];
  if (cfg.__parseError) guard.push('目标文件当前无法解析（' + cfg.__parseError + '）——请先修好，否则写入会覆盖原内容');
  const keyProblem = util.apiKeyProblem(ctx.apiKey);
  if (keyProblem) guard.push(keyProblem);
  if (names.length === 0) guard.push('网关没有任何启用供应商声明模型');
  const chosenProblem = models.chosenModelProblem(ctx.config || {}, model);
  if (chosenProblem) guard.push(chosenProblem);
  const after = buildConfig(cfg, ctx, model);
  const changed = MANAGED_KEYS.filter((k) => String(cfg[k] || '') !== String(after[k] || ''));
  return {
    id: TARGET_ID,
    name: 'iFlow CLI',
    method: 'file',
    summary: `写入 ${file}（${changed.length} 个键变化）`,
    guard,
    apiKeyMasked: util.maskValue(ctx.apiKey),
    baseUrl: baseUrl(ctx.port),
    files: [{
      path: file,
      action: util.exists(file) ? 'modify' : 'create',
      exists: util.exists(file),
      before,
      after: JSON.stringify(util.redact(after), null, 2) + '\n',
      note: '只改 baseUrl / apiKey / modelName / selectedAuthType 四个键，其余键（language、searchApiKey 等）原样保留',
    }],
    warnings: cfg.selectedAuthType && cfg.selectedAuthType !== 'api-key'
      ? [`原鉴权方式是 ${cfg.selectedAuthType}（OAuth 登录）。不改它的话，客户端仍会走官方端点，本配置不生效 —— 因此会一并切成 api-key。原文件已备份，可一键恢复。`]
      : [],
  };
}

function apply(ctx) {
  const keyProblem = util.apiKeyProblem(ctx.apiKey);
  if (keyProblem) return { ok: false, errors: [keyProblem], files: [] };

  const file = settingsPath(ctx);
  const cur = util.readTarget(file);
  if (!cur.ok) {
    return { ok: false, errors: ['现有 settings.json 存在但读不出来（' + cur.error + '），已中止以免覆盖你的原有内容'], files: [] };
  }
  const parsed = util.parseJsonObject(cur.text);
  if (!parsed.ok) {
    return { ok: false, errors: ['目标文件当前无法解析（' + parsed.error + '），已中止以免覆盖'], files: [] };
  }
  const cfg = parsed.value;
  const { model } = plan(ctx);
  const after = buildConfig(cfg, ctx, model);
  const w = util.writeAtomic(file, JSON.stringify(after, null, 2) + '\n');
  if (!w.ok) return { ok: false, errors: [w.error], files: [] };
  return {
    ok: true,
    errors: [],
    files: [file],
    backup: w.backup || null,
    output: `已写入 ${file}`,
    nextSteps: ['重启 iFlow CLI（新开一个终端）'],
  };
}

function restore(ctx) {
  const file = settingsPath(ctx);
  if (!util.backupInfo(file)) return { ok: false, errors: ['没有找到本程序留下的备份'], results: [] };
  const r = util.restore(file);
  return { ok: r.ok, errors: r.ok ? [] : [r.error], results: [Object.assign({ file }, r)] };
}

module.exports = { id: TARGET_ID, name: 'iFlow CLI', detect, preview, apply, restore, settingsPath, baseUrl, baseUrlHint: '要带 /v1' };
