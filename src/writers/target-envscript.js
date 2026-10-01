// writers/target-envscript.js — 通用目标：环境变量脚本 + 端点速查
//
// 用途：覆盖那些**没有稳定可写配置文件**、或本程序不便直接改写配置的客户端。例如
//   · Aider      —— 读 OPENAI_API_BASE / OPENAI_API_KEY（或 ~/.aider.conf.yml）
//   · Gemini CLI —— 只认环境变量（官方没提供 settings.json 里写 baseURL 的键）
//   · Cline / Roo Code（VS Code 扩展）—— 密钥存在 VS Code SecretStorage 的 DPAPI 密文里，
//     外部程序写入**不安全也不可靠**（要触碰凭据库），因此这里只给字段值让用户在界面里填
//   · Chatbox / Cherry Studio / LobeChat 等 GUI 客户端 —— 同上，界面里粘贴即可
//
// 产物写在**数据目录**（不是用户主目录）：<dataDir>\clients\
//   llm-gateway-env.cmd    Windows 命令行：直接 set 好全部变量
//   llm-gateway-env.ps1    PowerShell
//   llm-gateway-env.sh     bash/zsh（WSL / Git Bash）
//   endpoints.txt          端点与字段速查（给人看的）
//
// ⚠ 这些文件里含网关统一 Key（本机凭据）。放在数据目录而不是主目录，是为了让"连数据目录
// 一起删掉"就能清理干净。
'use strict';

const path = require('path');

const util = require('./util');
const models = require('./models');

const TARGET_ID = 'envscript';
const REL_DIR = path.join('clients');

function dirOf(ctx) { return path.join(ctx.dataDir, REL_DIR); }

function endpoints(port, key, model) {
  const base = `http://127.0.0.1:${port}`;
  return {
    openai: base + '/v1',
    anthropic: base,
    modelsUrl: base + '/v1/models',
    healthUrl: base + '/health',
    apiKey: key,
    model: model || '',
  };
}

function detect(ctx) {
  const dir = dirOf(ctx);
  return {
    id: TARGET_ID,
    installed: util.exists(dir),
    evidence: [
      util.exists(dir) ? `已生成过：${dir}` : `尚未生成（将写入 ${dir}）`,
      '适用于 Aider / Gemini CLI / Cline / Roo Code / Chatbox / Cherry Studio 等一切 OpenAI 或 Anthropic 兼容客户端',
    ],
    configPaths: [
      path.join(dir, 'llm-gateway-env.cmd'),
      path.join(dir, 'llm-gateway-env.ps1'),
      path.join(dir, 'llm-gateway-env.sh'),
      path.join(dir, 'endpoints.txt'),
    ],
    current: {},
  };
}

/* ---------------- 各 shell 的转义 ----------------
 * 这些文件是要被**用户拿去执行**的脚本，里面拼进了密钥与模型名（模型名可能来自上游
 * 返回的目录，属于外来字符串）。裸拼的话，一个含 `&` 的模型名就能在 .cmd 里追加一条命令，
 * 一个含 `"` 的 Key 能提前闭合 `set "…"` 的引号。所以每种 shell 都要按它自己的规则转义。
 */

/** cmd：`set "NAME=value"` 的引号内 & | < > ^ 是字面量，但 `%` 仍会展开、`"` 会闭合引号。 */
function qCmd(s) {
  const v = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ');
  if (v.includes('"')) return null;          // 这种形态无法安全表示 → 由调用方降级处理
  return v.replace(/%/g, '%%');
}

/** cmd 的**展示文本**（echo 后面）：不转义一定会被当成命令分隔符，直接去掉元字符。 */
function dispCmd(s) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ')
    .replace(/[&|<>^%"()]/g, '').trim();
}

/** PowerShell 单引号串：只有 `'` 需要翻倍；`$`、反引号在单引号里都是字面量。 */
function qPs(s) {
  return "'" + String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/'/g, "''") + "'";
}

/** POSIX sh 单引号串：`'` 用 `'\''` 逃逸；其余全是字面量。 */
function qSh(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'";
}

function buildFiles(ctx) {
  const e = endpoints(ctx.port, String(ctx.apiKey || ''), models.pickDefaultModel(ctx.config || {}, ctx.options && ctx.options.model));
  const skipped = [];

  /** cmd 的一条 set：无法安全表示时降级为注释 + 记录，绝不写出会被注入的行。 */
  const setLine = (name, value) => {
    const q = qCmd(value);
    if (q === null) {
      skipped.push(`${name} 含双引号，无法安全写进 .cmd（该值已省略，请在其它脚本或手工设置中使用）`);
      return `REM ${name} 含双引号，已省略以免破坏脚本`;
    }
    return `set "${name}=${q}"`;
  };

  const cmd = [
    '@echo off',
    'REM LLM Gateway 环境变量（在本窗口执行一次，或放进自己的启动脚本里）',
    'REM 由 LLM Gateway 一键写入生成 —— 内含本机网关 Key，请勿分享该文件',
    setLine('OPENAI_BASE_URL', e.openai),
    setLine('OPENAI_API_BASE', e.openai),
    setLine('OPENAI_API_KEY', e.apiKey),
    setLine('ANTHROPIC_BASE_URL', e.anthropic),
    setLine('ANTHROPIC_AUTH_TOKEN', e.apiKey),
    setLine('ANTHROPIC_API_KEY', e.apiKey),
    setLine('LLM_GATEWAY_API_KEY', e.apiKey),
    '',
    'echo LLM Gateway 环境变量已就绪：',
    `echo   OpenAI    兼容端点  ${dispCmd(e.openai)}`,
    `echo   Anthropic 兼容端点  ${dispCmd(e.anthropic)}`,
    e.model ? `echo   建议默认模型        ${dispCmd(e.model)}` : 'echo   （网关当前没有可用模型）',
    '',
  ].join('\r\n');

  const ps1 = [
    '# LLM Gateway 环境变量（PowerShell：. .\\llm-gateway-env.ps1）',
    '# 由 LLM Gateway 一键写入生成 —— 内含本机网关 Key，请勿分享该文件',
    `$env:OPENAI_BASE_URL      = ${qPs(e.openai)}`,
    `$env:OPENAI_API_BASE      = ${qPs(e.openai)}`,
    `$env:OPENAI_API_KEY       = ${qPs(e.apiKey)}`,
    `$env:ANTHROPIC_BASE_URL   = ${qPs(e.anthropic)}`,
    `$env:ANTHROPIC_AUTH_TOKEN = ${qPs(e.apiKey)}`,
    `$env:ANTHROPIC_API_KEY    = ${qPs(e.apiKey)}`,
    `$env:LLM_GATEWAY_API_KEY  = ${qPs(e.apiKey)}`,
    '',
    'Write-Host "LLM Gateway 环境变量已就绪："',
    `Write-Host ('  OpenAI    兼容端点  ' + ${qPs(e.openai)})`,
    `Write-Host ('  Anthropic 兼容端点  ' + ${qPs(e.anthropic)})`,
    e.model
      ? `Write-Host ('  建议默认模型        ' + ${qPs(e.model)})`
      : 'Write-Host "  （网关当前没有可用模型）"',
    '',
  ].join('\n');

  const sh = [
    '#!/usr/bin/env sh',
    '# LLM Gateway 环境变量（source ./llm-gateway-env.sh）',
    '# 由 LLM Gateway 一键写入生成 —— 内含本机网关 Key，请勿分享该文件',
    `export OPENAI_BASE_URL=${qSh(e.openai)}`,
    `export OPENAI_API_BASE=${qSh(e.openai)}`,
    `export OPENAI_API_KEY=${qSh(e.apiKey)}`,
    `export ANTHROPIC_BASE_URL=${qSh(e.anthropic)}`,
    `export ANTHROPIC_AUTH_TOKEN=${qSh(e.apiKey)}`,
    `export ANTHROPIC_API_KEY=${qSh(e.apiKey)}`,
    `export LLM_GATEWAY_API_KEY=${qSh(e.apiKey)}`,
    '',
  ].join('\n');

  const modelNames = models.collectModelNames(ctx.config || {});
  // endpoints.txt 是纯文本，但要防换行把版式撑坏
  const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ');
  /**
   * 模型名进"给人照抄的命令"时的净化。
   *
   * 这个文件的用途就是**复制粘贴到终端**。模型名可能来自上游 /models 返回的目录（外来字符串），
   * 一个含 `&` / `|` / `^` 的名字粘进 cmd 就是"第二条命令"（实测：`aider --model openai/x&calc`
   * 会真的把 calc 跑起来）。所以这里把所有非安全字符替换掉 —— 只保留模型名里真正会出现的
   * 字符集；被替换过就加一条脚注说明，用户仍能从「模型」页复制到原始名字。
   */
  const safeName = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9._:\/-]/g, '_');
  const hasUnsafeName = modelNames.some((n) => safeName(n) !== n);
  const txt = [
    'LLM Gateway 端点速查',
    '='.repeat(60),
    '',
    '【OpenAI 兼容】（客户端里选 "OpenAI Compatible" / "自定义 OpenAI"）',
    '  Base URL : ' + oneLine(e.openai),
    '  API Key  : ' + oneLine(e.apiKey),
    '  模型      : ' + (modelNames.length ? modelNames.map(safeName).join(', ') : '(无)'),
    '',
    '【Anthropic 兼容】（客户端里选 "Anthropic" / Claude）',
    '  Base URL : ' + oneLine(e.anthropic) + '    ← 注意：不带 /v1',
    '  API Key  : ' + oneLine(e.apiKey),
    '  模型      : ' + (modelNames.length ? modelNames.map(safeName).join(', ') : '(无)'),
    '',
    '【自检】浏览器/curl 打开：' + oneLine(e.healthUrl),
    '【模型列表】' + oneLine(e.modelsUrl),
    '',
    '【常见客户端的填法】',
    '  Aider          : 执行 llm-gateway-env.cmd 后直接跑；模型名要带前缀，如',
    '                   aider --model openai/' + (safeName(e.model) || '<模型>'),
    '  Continue       : config.yaml 里 provider: openai + apiBase: ' + oneLine(e.openai) + ' + apiKey',
    '                   若它默认走 /responses，请显式加 useResponsesApi: false',
    '  Cline / Roo    : 设置 → API Provider 选 "OpenAI Compatible"，填上面的 Base URL 与 Key',
    '                   （它们的 Key 存在 VS Code 凭据库里，本程序不代为写入）',
    '  Chatbox/Cherry : 设置里选 OpenAI 兼容，填 Base URL 与 Key',
    '  iFlow CLI      : 建议用「客户端接入」里的 iFlow 一键写入，比手改稳',
    '  Gemini CLI     : 走 Gemini 原生 API（/v1beta），本网关不提供该协议 —— 接不进来',
    '',
    '⚠ 本文件含本机网关 Key，请勿分享。',
    '',
  ].join('\r\n');

  return {
    files: [
      { name: 'llm-gateway-env.cmd', text: cmd },
      { name: 'llm-gateway-env.ps1', text: ps1 },
      { name: 'llm-gateway-env.sh', text: sh },
      { name: 'endpoints.txt', text: txt },
    ],
    skipped,
  };
}

function preview(ctx) {
  const dir = dirOf(ctx);
  const built = buildFiles(ctx);
  const files = built.files.map((f) => {
    const p = path.join(dir, f.name);
    return {
      path: p,
      action: util.exists(p) ? 'modify' : 'create',
      exists: util.exists(p),
      before: util.exists(p) ? '(已有，将被覆盖)' : null,
      after: f.text,
      note: '可安全覆盖：本文件完全由本程序生成',
    };
  });
  const guard = [];
  const keyProblem = util.apiKeyProblem(ctx.apiKey);
  if (keyProblem) guard.push(keyProblem);
  const warnings = ['生成的文件含本机网关 Key，请勿分享或提交到代码仓库。'].concat(built.skipped);
  // 这个目标**不需要**模型（端点与 Key 本身就够用），所以只提示不拦。
  // 但要说清楚：脚本里的"建议默认模型"是空的，客户端那边得自己填。
  if (!models.collectModelNames(ctx.config || {}).length) {
    warnings.push('网关当前没有任何可用模型 —— 脚本仍可正常生成（端点与 Key 有效），'
      + '但里面不会给出建议模型；等配好供应商后重新生成一次即可。');
  }
  return {
    id: TARGET_ID,
    name: '通用（环境变量脚本 + 端点速查）',
    method: 'file',
    summary: `生成 ${files.length} 个文件到 ${dir}`,
    guard,
    apiKeyMasked: util.maskValue(ctx.apiKey),
    endpoints: endpoints(ctx.port, util.maskValue(ctx.apiKey), ''),
    files,
    warnings,
  };
}

function apply(ctx) {
  // 与 preview 的 guard 同源（纵深防御：main.js 的 write:apply 也会统一跑一遍）。
  // 生成的脚本里会写入统一 Key —— 占位值/空值写出去只会让用户以为配好了。
  const keyProblem = util.apiKeyProblem(ctx.apiKey);
  if (keyProblem) return { ok: false, errors: [keyProblem], files: [] };

  const dir = dirOf(ctx);
  const files = [];
  const backups = [];
  for (const f of buildFiles(ctx).files) {
    const p = path.join(dir, f.name);
    const w = util.writeAtomic(p, f.text);
    if (!w.ok) return { ok: false, errors: [p + '：' + w.error], files, backups };
    files.push(p);
    if (w.backup) backups.push(w.backup);
  }
  return {
    ok: true,
    errors: [],
    files,
    backups,
    output: `已生成 ${files.length} 个文件到 ${dir}`,
    nextSteps: [
      '命令行里执行 llm-gateway-env.cmd（或 PowerShell 里 . .\\llm-gateway-env.ps1）即可带上全部变量',
      'GUI 客户端按 endpoints.txt 里的字段手工填写',
    ],
  };
}

function restore(ctx) {
  // 这些文件是本程序生成的产物，备份意义不大；但保持一致：有备份就恢复
  const dir = dirOf(ctx);
  const results = [];
  for (const f of buildFiles(ctx).files) {
    const p = path.join(dir, f.name);
    if (util.backupInfo(p)) results.push(Object.assign({ file: p }, util.restore(p)));
  }
  return {
    ok: results.length > 0 && results.every((r) => r.ok),
    results,
    errors: results.length === 0 ? ['这些文件由本程序生成，没有需要恢复的备份'] : [],
  };
}

module.exports = { id: TARGET_ID, name: '通用（环境变量脚本）', detect, preview, apply, restore, dirOf, buildFiles, endpoints, baseUrlHint: '两种都给' };
