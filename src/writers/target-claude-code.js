// writers/target-claude-code.js — 一键写入 Claude Code（Anthropic 官方 CLI）
//
// 目标文件：`<home>\.claude\settings.json` 的 `env` 段（本机实测确认的形态）。
//
// 三个必须同时做的动作（少一个就用不起来）：
//   ① `ANTHROPIC_BASE_URL` = http://127.0.0.1:<port> —— **不带 /v1**。
//      Anthropic 的网关协议规定：这个变量选中的是"Anthropic Messages 格式"的服务，
//      客户端自己会去 POST `/v1/messages`。写成带 /v1 会变成 `/v1/v1/messages` → 404。
//      （本机实测同向佐证：用户原本填的就是 `https://agentrouter.org/`，无 /v1。）
//   ② `ANTHROPIC_AUTH_TOKEN` = 网关统一 Key（Claude Code 以 `Authorization: Bearer` 发出；
//      网关两种鉴权都收，所以这个变量名比 ANTHROPIC_API_KEY 更贴合第三方网关）。
//   ③ **模型别名必须一起改**。Claude Code 默认会请求 `opus` / `sonnet` / `haiku` 这些
//      厂商别名，而网关的模型清单里没有这些名字 → 一调用就 "model not found"。
//      因此要把 ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL 指向
//      网关里真实存在的逻辑模型名（`ANTHROPIC_SMALL_FAST_MODEL` 是老版本的等价键，一并写）。
//
// 写完之后 settings.json 里**其它键一个都不动**（用户还有 enabledPlugins / statusLine /
// extraKnownMarketplaces 等一大堆自有配置），只做 `env` 段内的定点 upsert。
'use strict';

const os = require('os');
const path = require('path');

const util = require('./util');
const models = require('./models');

const TARGET_ID = 'claude-code';
const MANAGED_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

function homeOf(ctx) { return (ctx && ctx.home) || os.homedir(); }
function settingsPath(ctx) { return path.join(homeOf(ctx), '.claude', 'settings.json'); }

/** baseURL：**不带 /v1**（见文件头 ①）。 */
function baseUrl(port) { return `http://127.0.0.1:${port}`; }

/** 探测 Claude Code 是否装过（看 ~/.claude 目录 + 常见 CLI 位置）。 */
function detect(ctx) {
  const home = homeOf(ctx);
  const dir = path.join(home, '.claude');
  const file = path.join(dir, 'settings.json');
  const cfg = util.readJson(file, {});
  const env = (cfg && !cfg.__parseError && cfg.env && typeof cfg.env === 'object') ? cfg.env : {};
  const cliCandidates = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
  ];
  const cli = cliCandidates.find((p) => util.exists(p)) || '';
  return {
    id: TARGET_ID,
    installed: util.exists(dir),
    evidence: [
      util.exists(dir) ? `配置目录存在：${dir}` : '未发现 ~/.claude 目录（Claude Code 可能未安装）',
      cli ? `CLI：${cli}` : '未在常见位置找到 claude CLI（不影响写入，配置对 CLI 与 VS Code 扩展都生效）',
      util.exists(file) ? `settings.json 存在（${util.readText(file).length} B）` : 'settings.json 不存在（写入会新建）',
      env.ANTHROPIC_BASE_URL ? `当前 ANTHROPIC_BASE_URL = ${env.ANTHROPIC_BASE_URL}` : '当前未设置 ANTHROPIC_BASE_URL',
      env.ANTHROPIC_AUTH_TOKEN ? `当前 ANTHROPIC_AUTH_TOKEN = ${util.maskValue(env.ANTHROPIC_AUTH_TOKEN)}` : '当前未设置 ANTHROPIC_AUTH_TOKEN',
    ].concat(cfg.__parseError ? ['⚠ settings.json 解析失败：' + cfg.__parseError] : []),
    configPaths: [file],
    current: {
      baseUrl: env.ANTHROPIC_BASE_URL || '',
      authToken: env.ANTHROPIC_AUTH_TOKEN || '',
      model: env.ANTHROPIC_MODEL || '',
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
    },
  };
}

/** 依据选项算出要写入的 env 键值对。 */
function envPatch(ctx) {
  const names = models.collectModelNames(ctx.config || {});
  const main = String((ctx.options && ctx.options.model) || '').trim() || models.pickDefaultModel(ctx.config || {});
  const small = String((ctx.options && ctx.options.smallModel) || '').trim() || main;
  const setDefaultModel = !(ctx.options && ctx.options.setDefaultModel === false);
  const patch = {
    ANTHROPIC_BASE_URL: baseUrl(ctx.port),
    ANTHROPIC_AUTH_TOKEN: String(ctx.apiKey || ''),
  };
  if (setDefaultModel && main) {
    patch.ANTHROPIC_MODEL = main;
    // 三个别名槽全部指向网关模型：否则 Claude Code 仍会去要 opus/sonnet/haiku
    patch.ANTHROPIC_DEFAULT_OPUS_MODEL = main;
    patch.ANTHROPIC_DEFAULT_SONNET_MODEL = main;
    patch.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
    patch.ANTHROPIC_SMALL_FAST_MODEL = small;
  }
  return { patch, main, small, setDefaultModel, names };
}

/** 检查进程环境里有没有会与本次写入"打架"的同名变量（settings.json 的 env 优先级更高，但值得说清）。 */
function shellEnvConflicts(ctx) {
  if (ctx && ctx.home) return [];              // 测试环境不读真实 shell 环境
  const out = [];
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    const v = process.env[k];
    if (v) out.push(`${k} 已在系统环境变量里设置为 ${util.maskValue(v)}（settings.json 的 env 段优先级更高，本程序写入的值会生效；但建议确认它不是你有意留下的）`);
  }
  return out;
}

function preview(ctx) {
  const file = settingsPath(ctx);
  const before = util.readText(file);
  const cfg = util.readJson(file, {});
  const guard = [];
  if (cfg.__parseError) guard.push('目标 settings.json 当前无法解析（' + cfg.__parseError + '）——请先修好它，否则写入会覆盖掉原内容');
  const { patch, main, small, setDefaultModel, names } = envPatch(ctx);
  const keyProblem = util.apiKeyProblem(ctx.apiKey);
  if (keyProblem) guard.push(keyProblem);
  if (setDefaultModel && names.length === 0) guard.push('网关没有任何启用供应商声明模型 —— Claude Code 会请求一个网关不认识的名字');
  // 界面上的选择是有状态的：模型被改名/删除后，旧名字必须拦下，否则会写进客户端导致 404
  for (const [label, val] of [['主模型', main], ['小快模型', small]]) {
    const p = models.chosenModelProblem(ctx.config || {}, val);
    if (p) guard.push(label + '：' + p);
  }

  const after = buildSettings(cfg, patch, setDefaultModel ? main : '');
  const envBefore = (cfg.env && typeof cfg.env === 'object') ? cfg.env : {};
  const changedKeys = MANAGED_KEYS.filter((k) => String(envBefore[k] || '') !== String(patch[k] || ''));

  return {
    id: TARGET_ID,
    name: 'Claude Code',
    method: 'file',
    summary: `写入 ${settingsPath(ctx)} 的 env 段（${changedKeys.length} 个键变化）`,
    guard,
    apiKeyMasked: util.maskValue(ctx.apiKey),
    baseUrl: patch.ANTHROPIC_BASE_URL,
    changedKeys,
    envBefore: util.redact(envBefore),
    envAfter: util.redact(patch),
    files: [{
      path: file,
      action: util.exists(file) ? 'modify' : 'create',
      exists: util.exists(file),
      before,
      after,
      note: '只改 env 段内本程序管理的键；其余键（plugins / statusLine / model 等）原样保留',
    }],
    warnings: shellEnvConflicts(ctx),
  };
}

/** 在保留其它键的前提下，把 env 段内的受管键 upsert 进去，序列化成新文本。 */
function buildSettings(cfg, patch, defaultModel) {
  const out = Object.assign({}, cfg);
  delete out.__parseError;
  const env = Object.assign({}, (out.env && typeof out.env === 'object') ? out.env : {});
  for (const k of MANAGED_KEYS) {
    if (patch[k] === undefined) continue;
    env[k] = patch[k];
  }
  // 键按字母序排（与 Claude Code 自己写出来的顺序一致，diff 更好读）
  const sorted = {};
  for (const k of Object.keys(env).sort()) sorted[k] = env[k];
  out.env = sorted;
  // 顶层 `model` 是**独立于** env.ANTHROPIC_MODEL 的另一个设置，用户本来可能写着
  // "opus[1m]" 这类厂商别名 —— 指向本网关时它解析不到任何模型，必须一起改写。
  if (defaultModel) out.model = defaultModel;
  return JSON.stringify(out, null, 2) + '\n';
}

function apply(ctx) {
  // 写前前置检查（与 preview 的 guard 同源；main.js 的 write:apply 也会统一跑一遍，
  // 这里是纵深防御 —— apply 被单独调用时同样不能把用户原有凭据写成空串）。
  const keyProblem = util.apiKeyProblem(ctx.apiKey);
  if (keyProblem) return { ok: false, errors: [keyProblem], files: [] };

  const file = settingsPath(ctx);
  // 精确读：文件存在但读不出来时必须中止（readText/readJson 会把读错误静默变成空串，
  // 于是合成出的新文本只剩受管键，用户原有的 plugins/statusLine 会被整份抹掉）。
  const cur = util.readTarget(file);
  if (!cur.ok) {
    return { ok: false, errors: ['现有 settings.json 存在但读不出来（' + cur.error + '），已中止以免覆盖你的原有内容'], files: [] };
  }
  const parsed = util.parseJsonObject(cur.text);
  if (!parsed.ok) {
    return { ok: false, errors: ['目标文件当前无法解析（' + parsed.error + '），已中止以免覆盖原内容'], files: [] };
  }
  const cfg = parsed.value;
  const { patch, main, setDefaultModel } = envPatch(ctx);
  const after = buildSettings(cfg, patch, setDefaultModel ? main : '');
  const w = util.writeAtomic(file, after);
  if (!w.ok) return { ok: false, errors: [w.error], files: [] };
  return {
    ok: true,
    errors: [],
    files: [file],
    backup: w.backup || null,
    output: `已写入 ${file}`,
    nextSteps: [
      '重启 Claude Code（已在运行的会话不会重新读取配置）',
      '用 `claude doctor` 复核配置；状态栏里应能看到新的 base URL 与模型',
    ],
  };
}

function restore(ctx) {
  const file = settingsPath(ctx);
  if (!util.backupInfo(file)) return { ok: false, errors: ['没有找到本程序留下的备份（' + file + util.BACKUP_SUFFIX + '）'], results: [] };
  const r = util.restore(file);
  return { ok: r.ok, errors: r.ok ? [] : [r.error], results: [Object.assign({ file }, r)] };
}

module.exports = { id: TARGET_ID, name: 'Claude Code', detect, preview, apply, restore, settingsPath, baseUrl, MANAGED_KEYS, baseUrlHint: '不带 /v1' };
