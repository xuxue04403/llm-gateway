// src/client-headers.js — 客户端仿真头（**引擎侧的镜像**）
//
// 为什么需要这份镜像：主进程在做"拉取上游目录 / 测速 / 连通性探测"时，需要发出**与网关
// 实际转发时完全相同**的身份头。否则会得到假结论 —— 实测踩到：直连 cline 的
// `/chat/completions` 不带 Cline 仿真头时一律 **403**，而经网关（带仿真头）却正常。
// 用它去测速，会把"能用的模型"报成失败。
//
// ⚠ 这份镜像与引擎的对应函数是**两份实现**，存在漂移风险。因此：
//   · 只镜像"发哪些头"，值尽量从简；
//   · `tests/gateway.test.js` 里有一条测试**从引擎源码提取**这三个函数并逐一比对
//     **头名集合**，漂移会被测试挡住（与 models.js 的做法一致）。
'use strict';

/** 环境/配置里的版本覆盖（与引擎 clientIdentityOverrides 同口径，但只取探测需要的几项）。 */
function identityOverrides(cfg) {
  const c = (cfg && cfg.clientVersions) || {};
  const pick = (envKey, cfgKey, def) => {
    const e = process.env[envKey];
    if (e && String(e).trim()) return String(e).trim();
    const v = c[cfgKey];
    if (v != null && String(v).trim()) return String(v).trim();
    return def;
  };
  return {
    claudeCli: pick('DSH_GATEWAY_CC_VERSION', 'claudeCli', '2.1.270'),
    claudeEntrypoint: pick('DSH_GATEWAY_CC_ENTRYPOINT', 'claudeEntrypoint', 'sdk-cli'),
    stainlessPkg: pick('DSH_GATEWAY_STAINLESS_VERSION', 'stainlessPkg', '0.112.1'),
    codex: pick('DSH_GATEWAY_CODEX_VERSION', 'codex', '0.159.1'),
    codexOriginator: pick('DSH_GATEWAY_CODEX_ORIGINATOR', 'codexOriginator', 'codex_cli_rs'),
    cline: pick('DSH_GATEWAY_CLINE_VERSION', 'cline', '3.0.65'),
    clineCore: pick('DSH_GATEWAY_CLINE_CORE_VERSION', 'clineCore', '0.0.87'),
  };
}

function platformInfo() {
  const p = process.platform;
  const osName = p === 'win32' ? 'Windows' : p === 'darwin' ? 'MacOS' : p === 'linux' ? 'Linux' : p;
  const arch = process.arch === 'x64' ? 'x64'
    : process.arch === 'arm64' ? 'arm64'
      : process.arch === 'ia32' ? 'x32' : process.arch;
  return { osName, arch };
}

function stainlessHeaders(cfg) {
  const { osName, arch } = platformInfo();
  const id = identityOverrides(cfg);
  return {
    'x-stainless-lang': 'js',
    'x-stainless-package-version': id.stainlessPkg,
    'x-stainless-os': osName,
    'x-stainless-arch': arch,
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
  };
}

function claudeHeaders(cfg) {
  const id = identityOverrides(cfg);
  const h = {
    accept: 'application/json',
    'user-agent': `claude-cli/${id.claudeCli} (external, ${id.claudeEntrypoint})`,
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
  };
  Object.assign(h, stainlessHeaders(cfg));
  const betaOff = String(process.env.DSH_GATEWAY_CC_BETA || '') === '0'
    || (cfg && cfg.clientVersions && cfg.clientVersions.claudeBeta === false);
  if (!betaOff) {
    h['anthropic-beta'] = [
      'claude-code-20250219', 'interleaved-thinking-2025-05-14', 'thinking-token-count-2026-05-13',
      'context-management-2025-06-27', 'prompt-caching-scope-2026-01-05',
      'mid-conversation-system-2026-04-07', 'advisor-tool-2026-03-01',
      'advanced-tool-use-2025-11-20', 'effort-2025-11-24',
    ].join(',');
  }
  return h;
}

function clineHeaders(cfg, sessionId) {
  const id = identityOverrides(cfg);
  const h = {
    'user-agent': `Cline/${id.cline}`,
    'http-referer': 'https://cline.bot',
    'x-title': 'Cline',
    'x-is-multiroot': 'false',
    'x-client-type': 'cline-sdk',
    'x-client-version': id.cline,
    'x-platform': 'terminal',
    'x-platform-version': id.cline,
    'x-core-version': id.clineCore,
    accept: 'application/json',
  };
  if (sessionId) h['x-task-id'] = String(sessionId);
  return h;
}

function codexHeaders(cfg) {
  const id = identityOverrides(cfg);
  const { osName, arch } = platformInfo();
  const os = require('os');
  let rel = '';
  try { rel = String(os.release() || ''); } catch (_) { /* 忽略 */ }
  const parts = rel.split('.').filter(Boolean);
  const osVer = (process.platform === 'win32' ? parts.slice(0, 2) : parts.slice(0, 3)).join('.') || 'unknown';
  return {
    originator: id.codexOriginator,
    'user-agent': `${id.codexOriginator}/${id.codex} (${osName} ${osVer}; ${arch})`,
    accept: 'application/json',
  };
}

/** 与引擎 providerClientProfile 同规则：逐家声明优先，其次按 *.cline.bot 主机名推断。 */
function providerProfile(provider) {
  const declared = String((provider && provider.clientProfile) || '').trim().toLowerCase();
  if (declared) return declared;
  try {
    const host = new URL(String((provider && provider.baseURL) || '')).hostname.toLowerCase();
    if (host === 'api.cline.bot' || host.endsWith('.cline.bot')) return 'cline';
  } catch (_) { /* baseURL 非法：不推断 */ }
  return '';
}

function effectiveProfile(cfg, provider) {
  return providerProfile(provider) || String((cfg && cfg.clientProfile) || '').trim();
}

/**
 * 组装探测用的请求头：**与网关实际转发时同一套身份** + 鉴权头。
 * 鉴权默认用 Bearer（OpenAI 兼容路径）；anthropic 协议时用 x-api-key。
 */
function probeHeaders(cfg, provider, apiKey, opts) {
  const o = opts || {};
  const profile = effectiveProfile(cfg, provider);
  const clientUA = String((cfg && cfg.clientUA) || '').trim();
  let out = {};
  if (profile === 'cline') out = clineHeaders(cfg, o.sessionId);
  else if (profile === 'codex') out = codexHeaders(cfg);
  else if (profile === 'claude' || (!profile && clientUA)) out = claudeHeaders(cfg);
  if (clientUA) out['user-agent'] = clientUA;

  const key = String(apiKey || '');
  if (o.anthropic) {
    out['x-api-key'] = key;
    out['anthropic-version'] = out['anthropic-version'] || '2023-06-01';
    delete out.authorization;
  } else if (key) {
    out.authorization = 'Bearer ' + key;
  }
  if (!out.accept) out.accept = 'application/json';
  if (o.json) out['content-type'] = 'application/json';
  return out;
}

module.exports = {
  identityOverrides,
  platformInfo,
  stainlessHeaders,
  claudeHeaders,
  clineHeaders,
  codexHeaders,
  providerProfile,
  effectiveProfile,
  probeHeaders,
};
