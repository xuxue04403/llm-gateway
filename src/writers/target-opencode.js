// writers/target-opencode.js — 一键写入 OpenCode
//
// 目标文件：`<home>\.config\opencode\opencode.json`（OpenCode 在 Windows 上也读
// `~/.config/opencode/opencode.json`，与 XDG 惯例一致）。
//
// 形状来自 OpenCode 官方 providers 文档：
//   provider.<id>.npm        = "@ai-sdk/openai-compatible"   ← 走 OpenAI 兼容适配器
//   provider.<id>.options.baseURL / .apiKey
//   provider.<id>.models.<模型 id> = { name }
//   顶层 model = "<providerId>/<模型 id>"
//
// baseURL **要带 /v1**：`@ai-sdk/openai-compatible` 会在其后再拼 `/chat/completions`。
'use strict';

const os = require('os');
const path = require('path');

const util = require('./util');
const models = require('./models');

const TARGET_ID = 'opencode';
const PROVIDER_ID = 'llmgateway';

function homeOf(ctx) { return (ctx && ctx.home) || os.homedir(); }

/** 候选路径：官方位置优先，其次 Windows 上的 %APPDATA% 变体。 */
function configCandidates(ctx) {
  const home = homeOf(ctx);
  const list = [path.join(home, '.config', 'opencode', 'opencode.json')];
  if (!ctx || !ctx.home) {
    const appData = process.env.APPDATA;
    if (appData) list.push(path.join(appData, 'opencode', 'opencode.json'));
  }
  return list;
}

function configPath(ctx) {
  const list = configCandidates(ctx);
  const hit = list.find((p) => util.exists(p));
  return hit || list[0];
}

function baseUrl(port) { return `http://127.0.0.1:${port}/v1`; }

function detect(ctx) {
  const file = configPath(ctx);
  const cfg = util.readJson(file, {});
  const hasProvider = !!(cfg && cfg.provider && cfg.provider[PROVIDER_ID]);
  return {
    id: TARGET_ID,
    installed: configCandidates(ctx).some((p) => util.exists(path.dirname(p))),
    evidence: [
      util.exists(file) ? `配置存在：${file}` : `未发现配置文件（写入会新建 ${file}）`,
      hasProvider ? `已存在 provider.${PROVIDER_ID}` : `尚无 provider.${PROVIDER_ID}`,
    ].concat(cfg.__parseError ? ['⚠ 现有配置无法解析：' + cfg.__parseError] : []),
    configPaths: [file],
    current: {
      baseUrl: (cfg && cfg.provider && cfg.provider[PROVIDER_ID] && cfg.provider[PROVIDER_ID].options
        && cfg.provider[PROVIDER_ID].options.baseURL) || '',
      model: (cfg && cfg.model) || '',
    },
  };
}

function plan(ctx) {
  const list = models.collectModels(ctx.config || {});
  const model = String((ctx.options && ctx.options.model) || '').trim() || models.pickDefaultModel(ctx.config || {});
  return { list, model };
}

function buildConfig(cfg, ctx, model, list) {
  const out = Object.assign({}, cfg);
  delete out.__parseError;
  if (!out.$schema) out.$schema = 'https://opencode.ai/config.json';
  const provider = Object.assign({}, (out.provider && typeof out.provider === 'object') ? out.provider : {});
  const modelMap = {};
  for (const m of list) modelMap[m.id] = { name: m.id };
  provider[PROVIDER_ID] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'LLM Gateway',
    options: { baseURL: baseUrl(ctx.port), apiKey: String(ctx.apiKey || '') },
    models: modelMap,
  };
  out.provider = provider;
  if (model) out.model = `${PROVIDER_ID}/${model}`;
  return out;
}

function preview(ctx) {
  const file = configPath(ctx);
  const before = util.readText(file);
  const cfg = util.readJson(file, {});
  const { list, model } = plan(ctx);
  const guard = [];
  if (cfg.__parseError) guard.push('目标配置当前无法解析（' + cfg.__parseError + '）——请先修好，否则写入会覆盖原内容');
  const keyProblem = util.apiKeyProblem(ctx.apiKey);
  if (keyProblem) guard.push(keyProblem);
  if (list.length === 0) guard.push('网关没有任何启用供应商声明模型');
  const chosenProblem = models.chosenModelProblem(ctx.config || {}, model);
  if (chosenProblem) guard.push(chosenProblem);
  const after = buildConfig(cfg, ctx, model, list);
  return {
    id: TARGET_ID,
    name: 'OpenCode',
    method: 'file',
    summary: `写入 provider.${PROVIDER_ID}（${list.length} 个模型）`,
    guard,
    apiKeyMasked: util.maskValue(ctx.apiKey),
    baseUrl: baseUrl(ctx.port),
    files: [{
      path: file,
      action: util.exists(file) ? 'modify' : 'create',
      exists: util.exists(file),
      before,
      after: JSON.stringify(util.redact(after), null, 2) + '\n',
      note: `只新增/替换 provider.${PROVIDER_ID}，顶层 model 指向它；其它 provider 原样保留`,
    }],
  };
}

function apply(ctx) {
  const keyProblem = util.apiKeyProblem(ctx.apiKey);
  if (keyProblem) return { ok: false, errors: [keyProblem], files: [] };

  const file = configPath(ctx);
  const cur = util.readTarget(file);
  if (!cur.ok) {
    return { ok: false, errors: ['现有 opencode.json 存在但读不出来（' + cur.error + '），已中止以免覆盖你的原有内容'], files: [] };
  }
  const parsed = util.parseJsonObject(cur.text);
  if (!parsed.ok) {
    return { ok: false, errors: ['目标文件当前无法解析（' + parsed.error + '），已中止以免覆盖'], files: [] };
  }
  const cfg = parsed.value;
  const { list, model } = plan(ctx);
  const after = buildConfig(cfg, ctx, model, list);
  const w = util.writeAtomic(file, JSON.stringify(after, null, 2) + '\n');
  if (!w.ok) return { ok: false, errors: [w.error], files: [] };
  return {
    ok: true,
    errors: [],
    files: [file],
    backup: w.backup || null,
    output: `已写入 ${file}`,
    nextSteps: ['重启 OpenCode，或在其中执行 /models 查看 llmgateway 下的模型'],
  };
}

function restore(ctx) {
  const file = configPath(ctx);
  if (!util.backupInfo(file)) return { ok: false, errors: ['没有找到本程序留下的备份'], results: [] };
  const r = util.restore(file);
  return { ok: r.ok, errors: r.ok ? [] : [r.error], results: [Object.assign({ file }, r)] };
}

module.exports = { id: TARGET_ID, name: 'OpenCode', detect, preview, apply, restore, configPath, baseUrl, PROVIDER_ID, baseUrlHint: '要带 /v1' };
