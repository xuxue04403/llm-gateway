// writers/target-codex.js — 一键写入 Codex（OpenAI 官方 CLI）
//
// 目标文件（本机实测确认的形态）：
//   `<home>\.codex\config.toml`   —— 顶层 model_provider / model + `[model_providers.<id>]` 表
//   `<home>\.codex\auth.json`     —— `{"OPENAI_API_KEY": "…"}`（默认凭据方式）
//
// 四个关键点（都来自本机实测或官方文档，不是推测）：
//   ① **base_url 必须带 `/v1`**（与 Claude Code 恰好相反）。Codex 把 `/responses` 拼在
//      base_url 之后，写成裸 host 会请求 `http://127.0.0.1:PORT/responses` → 404。
//      本机实测同向佐证：`base_url = "https://yansd666.top/v1"`。
//   ② **`wire_api` 现在实际只有 `"responses"`**。OpenAI 已弃用 Codex 的 chat/completions
//      通道（openai/codex#7782），官方配置参考的 wire_api 取值只剩 responses。
//      => **硬约束：网关必须能服务 `/v1/responses`**（本网关支持，含取回/取消/删除子路由）。
//   ③ **凭据有三条路**，界面里可选，默认走用户本机已验证可用的那条：
//        · authJson   —— 写 `auth.json` 的 `OPENAI_API_KEY`（本机现状，默认）
//        · bearer     —— 写 provider 表的 `experimental_bearer_token`（密钥全在 config.toml）
//        · envKey     —— 写 provider 表的 `env_key`，指向环境变量 `LLM_GATEWAY_API_KEY`
//   ④ **`preferred_auth_method` 是 0.158 已移除的遗留键**（本机 codex.exe 二进制里零命中，
//      `--strict-config` 会报错）。本程序**不再写入**它；检测到就提示用户，但不擅自删除
//      ——不替用户改他文件里与本程序无关的内容。
//
// 只动 `[model_providers.llmgateway]` 这一张表 + 几个顶层标量；用户已有的
// `[model_providers.anyrouter]`、`[mcp_servers.*]`、`[projects.*]` 等一律原样保留。
'use strict';

const os = require('os');
const path = require('path');

const util = require('./util');
const models = require('./models');

const TARGET_ID = 'codex';
const PROVIDER_ID = 'llmgateway';
const ENV_VAR = 'LLM_GATEWAY_API_KEY';

/** 0.158 已移除、写进去会让 --strict-config 报错的键 */
const LEGACY_KEYS = ['preferred_auth_method'];

function homeOf(ctx) { return (ctx && ctx.home) || os.homedir(); }
function configPath(ctx) { return path.join(homeOf(ctx), '.codex', 'config.toml'); }
function authPath(ctx) { return path.join(homeOf(ctx), '.codex', 'auth.json'); }

/** baseURL：**要带 /v1**（见文件头 ①）。 */
function baseUrl(port) { return `http://127.0.0.1:${port}/v1`; }

function wireApi(ctx) {
  const v = String((ctx.options && ctx.options.wireApi) || 'responses').trim().toLowerCase();
  return v === 'chat' ? 'chat' : 'responses';
}

function authMode(ctx) {
  const v = String((ctx.options && ctx.options.authMode) || 'authJson').trim();
  return ['authJson', 'bearer', 'envKey'].includes(v) ? v : 'authJson';
}

function topKeyValue(text, key) {
  const lines = String(text || '').split(/\r?\n/);
  const i = util.tomlTopKeyLine(lines, key);
  return i >= 0 ? util.tomlUnquote(String(lines[i].split('=')[1] || '')) : '';
}

function detect(ctx) {
  const home = homeOf(ctx);
  const dir = path.join(home, '.codex');
  const file = configPath(ctx);
  const text = util.readText(file);
  const table = util.tomlReadTable(text, 'model_providers.' + PROVIDER_ID);
  const hasProvider = Object.keys(table).length > 0;
  const auth = util.readJson(authPath(ctx), {});

  // Codex 常被装进 AppData 而不是 PATH（本机实测：where codex 找不到，
  // 实际在 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe）——所以这里显式搜目录。
  let cli = '';
  try {
    const base = path.join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
    if (util.exists(base)) {
      for (const sub of fsList(base)) {
        const p = path.join(base, sub, 'codex.exe');
        if (util.exists(p)) { cli = p; break; }
      }
    }
  } catch (_) { /* 忽略 */ }

  const legacy = LEGACY_KEYS.filter((k) => util.tomlTopKeyLine(text.split(/\r?\n/), k) >= 0);

  return {
    id: TARGET_ID,
    installed: util.exists(dir),
    evidence: [
      util.exists(dir) ? `配置目录存在：${dir}` : '未发现 ~/.codex 目录（Codex 可能未安装）',
      cli ? `CLI：${cli}（不在 PATH 上是正常的）` : '未在 %LOCALAPPDATA%\\OpenAI\\Codex 下找到 CLI',
      util.exists(file) ? `config.toml 存在（${text.length} B）` : 'config.toml 不存在（写入会新建）',
      hasProvider
        ? `已存在 [model_providers.${PROVIDER_ID}]（base_url = ${util.tomlUnquote(table.base_url || '')}）`
        : `尚无 [model_providers.${PROVIDER_ID}] 表`,
      auth.OPENAI_API_KEY ? `auth.json 已有 OPENAI_API_KEY（${util.maskValue(auth.OPENAI_API_KEY)}）` : 'auth.json 尚无 OPENAI_API_KEY',
    ].concat(legacy.length ? [`⚠ 检测到 0.158 已移除的遗留键：${legacy.join(' / ')}（可用 codex --strict-config 复核；本程序不会擅自删除它）`] : []),
    configPaths: [file, authPath(ctx)],
    current: {
      modelProvider: topKeyValue(text, 'model_provider'),
      model: topKeyValue(text, 'model'),
      baseUrl: util.tomlUnquote(table.base_url || ''),
      wireApi: util.tomlUnquote(table.wire_api || ''),
      legacyKeys: legacy,
    },
  };
}

function fsList(dir) {
  try { return require('fs').readdirSync(dir); } catch (_) { return []; }
}

function plan(ctx) {
  const names = models.collectModelNames(ctx.config || {});
  const model = String((ctx.options && ctx.options.model) || '').trim() || models.pickDefaultModel(ctx.config || {});
  const mode = authMode(ctx);
  const api = wireApi(ctx);

  const tableBody = [
    'name = "LLM Gateway"',
    `base_url = ${util.tomlString(baseUrl(ctx.port))}`,
    `wire_api = ${util.tomlString(api)}`,
  ];
  if (mode === 'bearer') {
    tableBody.push(`experimental_bearer_token = ${util.tomlString(String(ctx.apiKey || ''))}`);
  } else if (mode === 'envKey') {
    tableBody.push(`env_key = ${util.tomlString(ENV_VAR)}`);
  }
  return { names, model, mode, api, tableBody };
}

/** 生成新的 config.toml 文本。 */
function buildConfig(ctx, before) {
  const { model, mode, tableBody } = plan(ctx);
  let text = before || '';
  // 顺序有讲究：TOML 要求**顶层键写在任何表头之前**。先插表再插顶层键的话，
  // tomlUpsertTopKey 只能把键挤到表头前面并留一个空行（对空白文件尤其难看，实测踩到）。
  // 先写顶层键、再追加表，得到的就是最自然的形式。
  text = util.tomlUpsertTopKey(text, 'model_provider', util.tomlString(PROVIDER_ID));
  if (model) text = util.tomlUpsertTopKey(text, 'model', util.tomlString(model));
  // 凭据落文件：否则新版 Codex 可能把凭据放进 OS 凭据库，外部程序既写不进也读不到
  if (mode === 'authJson') text = util.tomlUpsertTopKey(text, 'cli_auth_credentials_store', util.tomlString('file'));
  text = util.tomlUpsertTable(text, 'model_providers.' + PROVIDER_ID, tableBody);
  return text;
}

function preview(ctx) {
  const file = configPath(ctx);
  const authFile = authPath(ctx);
  const before = util.readText(file);
  const { names, model, mode, api } = plan(ctx);
  const cfg = util.readJson(authFile, {});
  const legacy = LEGACY_KEYS.filter((k) => util.tomlTopKeyLine(before.split(/\r?\n/), k) >= 0);

  const guard = [];
  const keyProblem = util.apiKeyProblem(ctx.apiKey);
  if (keyProblem) guard.push(keyProblem);
  if (!model) guard.push('网关没有任何启用供应商声明模型 —— Codex 会去请求一个网关不认识的名字');
  if (names.length === 0) guard.push('网关没有任何可用模型');
  const chosenProblem = models.chosenModelProblem(ctx.config || {}, model);
  if (chosenProblem) guard.push(chosenProblem);

  const after = buildConfig(ctx, before);
  // 自检：改完的 TOML 必须仍是合法 TOML。不合法就拦下 —— 我们改的是用户**已有的**
  // config.toml，写坏了会把他自己的 provider / mcp_servers / projects 一起废掉。
  const tomlError = util.tomlValidate(after);
  if (tomlError) {
    guard.push('改完的 config.toml 不是合法 TOML（' + tomlError + '）—— 已拦下，未写入。'
      + '这通常是原文件里出现了本程序尚未覆盖的 TOML 写法（表头行尾注释、多行字符串、dotted key 等），'
      + '请手工添加 provider，或把该文件反馈给我们。');
  }
  const files = [{
    path: file,
    action: util.exists(file) ? 'modify' : 'create',
    exists: util.exists(file),
    before,
    after,
    note: `新增/替换 [model_providers.${PROVIDER_ID}] 表，并把顶层 model_provider 指向它`,
  }];

  if (mode === 'authJson') {
    const authObj = Object.assign({}, cfg);
    delete authObj.__parseError;
    authObj.OPENAI_API_KEY = String(ctx.apiKey || '');
    files.push({
      path: authFile,
      action: util.exists(authFile) ? 'modify' : 'create',
      exists: util.exists(authFile),
      before: util.exists(authFile) ? JSON.stringify(util.redact(cfg), null, 2) : null,
      after: JSON.stringify(util.redact(authObj), null, 2),
      note: cfg.OPENAI_API_KEY
        ? '⚠ 将替换现有的 OPENAI_API_KEY（原值会先备份为 .bak-llmgateway，可一键恢复）'
        : '写入网关统一 Key',
    });
  }

  const warnings = [
    'Codex 现在只走 Responses 协议（POST /v1/responses）。网关支持它，但**上游**也得支持——否则该请求会失败并自动切下一家。',
    mode === 'authJson'
      ? '写入 auth.json 会把 Codex 切成 "API Key 认证"（auth_mode=ApiKey），ChatGPT 登录态的云端功能会受限。原文件已备份，可一键恢复。'
      : '',
    mode === 'envKey'
      ? `这条路线要求在环境变量里提供 ${ENV_VAR}（可在「通用（环境变量脚本）」目标里生成设置脚本），否则 Codex 会报缺少凭据。`
      : '',
    mode === 'bearer'
      ? 'experimental_bearer_token 是 Codex 的"实验性"字段，未来版本可能改名——升级 Codex 后请复核。'
      : '',
    legacy.length ? `config.toml 里还有 0.158 已移除的遗留键：${legacy.join(' / ')}。本程序不会删它；若 codex --strict-config 报错，请手工清掉。` : '',
  ].filter(Boolean);

  return {
    id: TARGET_ID,
    name: 'Codex',
    method: 'file',
    summary: `写入 [model_providers.${PROVIDER_ID}]（wire_api=${api}，凭据方式：${mode}）`,
    guard,
    apiKeyMasked: util.maskValue(ctx.apiKey),
    baseUrl: baseUrl(ctx.port),
    wireApi: api,
    authMode: mode,
    files,
    warnings,
    envVarHint: ENV_VAR,
  };
}

function apply(ctx) {
  // 写前前置检查（与 preview 的 guard 同源；main.js 的 write:apply 也会统一跑一遍，
  // 这里是纵深防御 —— apply 被单独调用时同样不能把用户原有凭据写成空串）。
  const keyProblem = util.apiKeyProblem(ctx.apiKey);
  if (keyProblem) return { ok: false, errors: [keyProblem], files: [] };

  const file = configPath(ctx);
  const authFile = authPath(ctx);
  const { mode } = plan(ctx);

  // 读原文件：**读不到就中止**（readText 会把读错误静默变成空串，那样合成出来的新文本
  // 只剩本程序受管的键，用户原有的 mcp_servers / projects 会被整份抹掉）。
  const cur = util.readTarget(file);
  if (!cur.ok) {
    return { ok: false, errors: ['现有 config.toml 存在但读不出来（' + cur.error + '），已中止以免覆盖你的原有内容'], files: [] };
  }

  const text = buildConfig(ctx, cur.text);

  // 写前自检：不合法就不写（宁可不写，也不写坏）。
  const preError = util.tomlValidate(text);
  if (preError) {
    return { ok: false, errors: ['改完的 config.toml 不是合法 TOML（' + preError + '），已中止写入。原文件未改动。'], files: [] };
  }

  const w = util.writeAtomic(file, text);
  if (!w.ok) return { ok: false, errors: [w.error], files: [] };

  // 写后复核：落盘的内容必须仍是合法 TOML。不合法就用备份回滚 ——
  // 这是最后一道闸门，用户自己的 provider / mcp_servers 不该被我们写坏。
  const written = util.readText(file);
  const postError = util.tomlValidate(written);
  if (postError) {
    let rolledBack = false;
    if (w.backup) { try { require('fs').copyFileSync(w.backup, file); rolledBack = true; } catch (_) { /* 回滚失败也要如实报 */ } }
    return {
      ok: false,
      errors: ['写入后的 config.toml 不是合法 TOML（' + postError + '）——'
        + (rolledBack ? '已用备份回滚，原文件未受影响。' : '且自动回滚失败，请用 ' + (w.backup || '备份文件') + ' 手工恢复。')],
      files: [],
      backups: w.backup ? [w.backup] : [],
    };
  }

  const done = [file];
  const backups = w.backup ? [w.backup] : [];

  if (mode === 'authJson') {
    const curAuth = util.readTarget(authFile);
    if (!curAuth.ok) {
      return { ok: false, errors: ['config.toml 已写入，但 auth.json 读不出来（' + curAuth.error + '），已跳过凭据写入'], files: done, backups };
    }
    const parsed = util.parseJsonObject(curAuth.text);
    if (!parsed.ok) {
      return { ok: false, errors: ['config.toml 已写入，但 auth.json 无法解析（' + parsed.error + '），已跳过凭据写入'], files: done, backups };
    }
    const authObj = parsed.value;
    authObj.OPENAI_API_KEY = String(ctx.apiKey || '');
    const wa = util.writeAtomic(authFile, JSON.stringify(authObj, null, 2) + '\n');
    if (!wa.ok) return { ok: false, errors: ['config.toml 已写入，但 auth.json 写入失败：' + wa.error], files: done, backups };
    done.push(authFile);
    if (wa.backup) backups.push(wa.backup);
  }

  return {
    ok: true,
    errors: [],
    files: done,
    backups,
    output: `已写入 ${done.join(' 与 ')}`,
    nextSteps: [
      '重启 Codex（新开一个终端）',
      '用 `codex --strict-config` 复核配置是否被接受，再一次实际提问确认连通',
      '网关日志（「日志」页）里会看到对应的 [route] 行',
    ],
  };
}

function restore(ctx) {
  const results = [];
  for (const f of [configPath(ctx), authPath(ctx)]) {
    if (util.backupInfo(f)) results.push(Object.assign({ file: f }, util.restore(f)));
  }
  return {
    ok: results.length > 0 && results.every((r) => r.ok),
    results,
    errors: results.length === 0 ? ['没有找到本程序留下的备份'] : results.filter((r) => !r.ok).map((r) => r.file + '：' + r.error),
  };
}

module.exports = {
  id: TARGET_ID, name: 'Codex', detect, preview, apply, restore,
  configPath, authPath, baseUrl, PROVIDER_ID, ENV_VAR,
  baseUrlHint: '要带 /v1',
};
