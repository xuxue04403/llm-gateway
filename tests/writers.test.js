// tests/writers.test.js — 一键写入的回归测试
//
// 每一个目标都在**临时 HOME** 里跑完整的 preview → apply → restore 流程，并逐条断言：
//   ① baseURL 形态正确（Claude Code 不带 /v1、Codex 带 /v1 —— 这两家恰好相反，最容易写错）；
//   ② **用户原有的其它配置一个字节都不能动**（真实用户的 settings.json 里有几十个插件、
//      config.toml 里有 mcp_servers/projects；整份重写会毁掉它们）；
//   ③ 写入前留备份、恢复后内容与原始**逐字节一致**；
//   ④ 目标文件坏掉时**拒绝写入**而不是覆盖。
//
// 运行：node tests/writers.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { t, run } = require('./_harness');

const writers = require('../src/writers');
const util = require('../src/writers/util');
const claude = require('../src/writers/target-claude-code');
const codex = require('../src/writers/target-codex');
const opencode = require('../src/writers/target-opencode');
const envscript = require('../src/writers/target-envscript');
const dshTarget = require('../src/writers/target-dsh');

const KEY = 'dsh-gateway-test-0123456789abcdef';
const PORT = 3091;

const CFG = {
  port: PORT,
  apiKey: KEY,
  clientProfile: '',
  providers: [
    {
      id: 'p1',
      baseURL: 'https://relay.example.org/v1',
      apiKey: 'sk-' + 'a'.repeat(30),
      models: ['glm-5.2', { id: 'up/ds', as: 'deepseek-v4-flash', vision: true }],
      enabled: true,
    },
  ],
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lgw-writers-'));

function newHome(tag) {
  const dir = fs.mkdtempSync(path.join(tmp, tag + '-'));
  return dir;
}

function ctxFor(home, options, configOverride) {
  const configPath = path.join(home, 'gateway.config.json');
  const cfg = configOverride || CFG;
  // dsh 的写入是**引擎子进程**干的（--write-dsh --config <path>），它读的是**磁盘上的**配置。
  // 所以测试里改了 config 就必须同步落盘 —— 否则会出现"预览按内存配置、写入按磁盘配置"
  // 的分叉（生产环境里两者都读磁盘，是一致的；界面在配置有未保存更改时会另行提示）。
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  return {
    port: PORT,
    apiKey: KEY,
    config: cfg,
    configPath,
    dataDir: home,
    enginePath: path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs'),
    nodeExe: process.execPath,
    nodeEnv: {},
    options: options || {},
    home,
  };
}

/* ================================================================
 * Claude Code
 * ================================================================ */

const REAL_CLAUDE_SETTINGS = {
  enabledPlugins: { 'superpowers@claude-plugins-official': true, 'skill-creator@awesome-claude-skills': true },
  env: { ANTHROPIC_AUTH_TOKEN: 'sk-old-old-old-old', ANTHROPIC_BASE_URL: 'https://agentrouter.org/' },
  extraKnownMarketplaces: { ponytail: { source: { repo: 'x/y', source: 'github' } } },
  language: 'Chinese',
  model: 'opus[1m]',
  statusLine: { command: 'bash "/root/.claude/plugins/x.sh"', type: 'command' },
};

t('Claude Code：baseURL 必须**不带 /v1**（官方网关协议：客户端自己拼 /v1/messages）', () => {
  const home = newHome('cc-url');
  const p = claude.preview(ctxFor(home));
  assert.strictEqual(p.baseUrl, `http://127.0.0.1:${PORT}`);
  assert.ok(!/\/v1$/.test(p.baseUrl), '绝不能以 /v1 结尾');
});

t('Claude Code：写入 env 段 + 顶层 model，其它键逐字节保留', () => {
  const home = newHome('cc-apply');
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const original = JSON.stringify(REAL_CLAUDE_SETTINGS, null, 2) + '\n';
  fs.writeFileSync(file, original, 'utf8');

  const r = claude.apply(ctxFor(home, { model: 'glm-5.2', smallModel: 'deepseek-v4-flash' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${PORT}`, '不带 /v1');
  assert.strictEqual(after.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.strictEqual(after.env.ANTHROPIC_MODEL, 'glm-5.2');
  assert.strictEqual(after.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.2');
  assert.strictEqual(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.2');
  assert.strictEqual(after.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');
  assert.strictEqual(after.model, 'glm-5.2', '顶层 model 的厂商别名也要改写（否则解析不到模型）');

  // 用户原有的配置必须原样还在
  assert.deepStrictEqual(after.enabledPlugins, REAL_CLAUDE_SETTINGS.enabledPlugins);
  assert.deepStrictEqual(after.extraKnownMarketplaces, REAL_CLAUDE_SETTINGS.extraKnownMarketplaces);
  assert.deepStrictEqual(after.statusLine, REAL_CLAUDE_SETTINGS.statusLine);
  assert.strictEqual(after.language, 'Chinese');

  // 备份 + 恢复逐字节一致
  assert.ok(fs.existsSync(file + '.bak-llmgateway'), '必须留备份');
  const rest = claude.restore(ctxFor(home));
  assert.strictEqual(rest.ok, true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original, '恢复后必须与原始内容逐字节一致');
});

t('Claude Code：关掉"改写模型别名"时不碰 top-level model 与别名键', () => {
  const home = newHome('cc-nomodel');
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(REAL_CLAUDE_SETTINGS, null, 2), 'utf8');
  const r = claude.apply(ctxFor(home, { setDefaultModel: false }));
  assert.strictEqual(r.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.model, 'opus[1m]', '不该动顶层 model');
  assert.strictEqual(after.env.ANTHROPIC_MODEL, undefined, '不该写 ANTHROPIC_MODEL');
  assert.strictEqual(after.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${PORT}`);
});

t('Claude Code：目标文件是坏 JSON 时**拒绝写入**（不覆盖用户原内容）', () => {
  const home = newHome('cc-bad');
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const p = claude.preview(ctxFor(home));
  assert.ok(p.guard.some((g) => g.includes('无法解析')), '预览应给出拦截理由');
  const r = claude.apply(ctxFor(home));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ this is not json', '原内容必须原封不动');
});

t('Claude Code：Key 过短时预览里给出拦截（网关鉴权要求 ≥16 字符）', () => {
  const home = newHome('cc-shortkey');
  const ctx = ctxFor(home);
  ctx.apiKey = 'short';
  const p = claude.preview(ctx);
  assert.ok(p.guard.some((g) => g.includes('16')), '应提示 Key 太短');
});

/* ================================================================
 * Codex
 * ================================================================ */

const REAL_CODEX_TOML = [
  'model = "gpt-5-codex"',
  'model_provider = "anyrouter"',
  'preferred_auth_method = "apikey"',
  'windows_wsl_setup_acknowledged = true',
  'model_reasoning_effort = "medium"',
  '',
  '',
  '[model_providers.anyrouter]',
  'name = "Any Router"',
  'base_url = "https://yansd666.top/v1"',
  'wire_api = "responses"',
  '',
  '[mcp_servers.context7]',
  'command = "npx.cmd"',
  'args = ["-y", "@upstash/context7-mcp"]',
  '',
  "[projects.'D:\\IDE\\CoinTrade']",
  'trust_level = "trusted"',
  '',
].join('\n');

function setupCodex(home) {
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), REAL_CODEX_TOML, 'utf8');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-' + 'o'.repeat(45) }, null, 2) + '\n', 'utf8');
  return dir;
}

t('Codex：base_url 必须**带 /v1**，且 wire_api=responses（Codex 已弃用 chat 通道）', () => {
  const home = newHome('cx-url');
  const p = codex.preview(ctxFor(home));
  assert.strictEqual(p.baseUrl, `http://127.0.0.1:${PORT}/v1`);
  assert.ok(p.baseUrl.endsWith('/v1'), '必须以 /v1 结尾');
  assert.strictEqual(p.wireApi, 'responses');
});

t('Codex：写入 provider 表 + 顶层 model_provider/model；anyrouter 与 mcp_servers/projects 全部保留', () => {
  const home = newHome('cx-apply');
  setupCodex(home);
  const file = path.join(home, '.codex', 'config.toml');
  const r = codex.apply(ctxFor(home, { model: 'glm-5.2' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const text = fs.readFileSync(file, 'utf8');

  assert.ok(text.includes('[model_providers.llmgateway]'), '应有自己的 provider 表');
  assert.ok(/base_url = "http:\/\/127\.0\.0\.1:3091\/v1"/.test(text), 'base_url 要带 /v1');
  assert.ok(/wire_api = "responses"/.test(text));
  assert.ok(/^model_provider = "llmgateway"$/m.test(text));
  assert.ok(/^model = "glm-5\.2"$/m.test(text));
  assert.ok(/^cli_auth_credentials_store = "file"$/m.test(text), '凭据要落文件');

  // 用户原有的东西一个都不能少
  assert.ok(text.includes('[model_providers.anyrouter]'), 'anyrouter 表必须保留');
  assert.ok(text.includes('https://yansd666.top/v1'), 'anyrouter 的地址必须保留');
  assert.ok(text.includes('[mcp_servers.context7]'), 'mcp_servers 必须保留');
  assert.ok(text.includes("[projects.'D:\\IDE\\CoinTrade']"), 'projects 必须保留');
  assert.ok(text.includes('windows_wsl_setup_acknowledged = true'), '无关顶层键必须保留');
  assert.ok(/^model_reasoning_effort = "medium"$/m.test(text));

  // 遗留键：**只提示、不擅自删除**
  assert.ok(text.includes('preferred_auth_method = "apikey"'), '不该擅自删除用户的遗留键');
  const p = codex.preview(ctxFor(home));
  assert.ok(p.warnings.some((w) => w.includes('preferred_auth_method')), '但要在预览里提示它是遗留键');

  // 不得出现重复表头
  assert.strictEqual((text.match(/\[model_providers\.llmgateway\]/g) || []).length, 1);
});

t('Codex：auth.json 被写入并备份；恢复后逐字节一致', () => {
  const home = newHome('cx-auth');
  setupCodex(home);
  const authFile = path.join(home, '.codex', 'auth.json');
  const original = fs.readFileSync(authFile, 'utf8');
  const r = codex.apply(ctxFor(home));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(authFile, 'utf8')).OPENAI_API_KEY, KEY);
  assert.ok(fs.existsSync(authFile + '.bak-llmgateway'));
  const rest = codex.restore(ctxFor(home));
  assert.strictEqual(rest.ok, true);
  assert.strictEqual(fs.readFileSync(authFile, 'utf8'), original, '恢复后逐字节一致');
});

t('Codex：凭据方式=bearer 时写 experimental_bearer_token，且**不碰 auth.json**', () => {
  const home = newHome('cx-bearer');
  setupCodex(home);
  const authFile = path.join(home, '.codex', 'auth.json');
  const originalAuth = fs.readFileSync(authFile, 'utf8');
  const r = codex.apply(ctxFor(home, { authMode: 'bearer' }));
  assert.strictEqual(r.ok, true);
  const text = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(text.includes('experimental_bearer_token'), '应写 bearer token');
  assert.strictEqual(fs.readFileSync(authFile, 'utf8'), originalAuth, 'auth.json 不得被改动');
});

t('Codex：凭据方式=envKey 时写 env_key，且不碰 auth.json', () => {
  const home = newHome('cx-env');
  setupCodex(home);
  const authFile = path.join(home, '.codex', 'auth.json');
  const originalAuth = fs.readFileSync(authFile, 'utf8');
  const r = codex.apply(ctxFor(home, { authMode: 'envKey' }));
  assert.strictEqual(r.ok, true);
  const text = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(text.includes(`env_key = "${codex.ENV_VAR}"`));
  assert.strictEqual(fs.readFileSync(authFile, 'utf8'), originalAuth);
});

t('Codex：重复写入是幂等的（不产生重复表头，第二次内容不变）', () => {
  const home = newHome('cx-idem');
  setupCodex(home);
  codex.apply(ctxFor(home, { model: 'glm-5.2' }));
  const f = path.join(home, '.codex', 'config.toml');
  const first = fs.readFileSync(f, 'utf8');
  codex.apply(ctxFor(home, { model: 'glm-5.2' }));
  const second = fs.readFileSync(f, 'utf8');
  assert.strictEqual(first, second, '第二次写入应得到完全相同的结果');
  assert.strictEqual((second.match(/\[model_providers\.llmgateway\]/g) || []).length, 1);
});

t('Codex：config.toml 不存在时能新建（新机器/未初始化）', () => {
  const home = newHome('cx-fresh');
  const r = codex.apply(ctxFor(home, { model: 'glm-5.2' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const text = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(!text.startsWith('\n'), '不得以空行开头');
  // TOML 的硬要求：所有顶层键必须在第一个表头之前
  const lines = text.split('\n');
  const firstHeader = lines.findIndex((l) => /^\s*\[/.test(l));
  const firstKey = lines.findIndex((l) => /^[A-Za-z_][\w-]*\s*=/.test(l));
  assert.ok(firstKey >= 0 && firstKey < firstHeader, `顶层键(${firstKey})必须在表头(${firstHeader})之前`);
  assert.ok(/^model_provider = "llmgateway"$/m.test(text));
  assert.ok(text.includes('[model_providers.llmgateway]'));
});

/* ================================================================
 * iFlow CLI —— 已于 2026-10 移除
 *
 * iFlow CLI 官方公告：2026-03-20 停止维护、2026-04-17 正式关闭，
 * iFlow API 服务与模型库同步关停（建议迁往 Qoder）。
 * 给一个已停服的产品写配置没有意义，相关目标与用例一并移除。
 * ================================================================ */

t('Codex：等价表头写法不能被追加成重复表（会把整份 config.toml 写成非法）', () => {
  // TOML 里下面几种是**同一张表**：`[a.b]`、`[a . b]`、`["a"."b"]`。
  // 旧实现拿原始字符串比较，认不出已存在的表 → upsert 再追加一张同名的 →
  // 整份文件解析失败（用户自己的 provider / mcp_servers / projects 一起失效），
  // 而程序报"写入成功"、自检也放过。差分测试（349 个 tomllib 判合法的文件）实测有 3 例踩到。
  const EQUIV = [
    '[model_providers . llmgateway]',
    '[model_providers. llmgateway]',
    '[ model_providers  .  llmgateway ]',
    '["model_providers"."llmgateway"]',
    "['model_providers'.'llmgateway']",
    '["model_providers".llmgateway]',
  ];
  for (const head of EQUIV) {
    const before = head + '\nname = "用户自己的"\nkeep = 1\n';
    const after = util.tomlUpsertTable(before, 'model_providers.llmgateway',
      ['name = "LLM Gateway"', 'base_url = "http://127.0.0.1:3091/v1"', 'wire_api = "responses"']);
    const n = (after.match(/^\s*\[\s*["']?model_providers["']?\s*\.\s*["']?llmgateway["']?\s*\]\s*$/gm) || []).length;
    assert.strictEqual(n, 1, '「' + head + '」应被认成已存在的表，实际写成了 ' + n + ' 张：\n' + after);
    assert.ok(!util.tomlValidate(after), '自检也要通过：' + util.tomlValidate(after));
  }
  // 整串引号是**另一张表**（TOML 认为它是一个名字里带点的键），必须各自保留
  const other = util.tomlUpsertTable('["model_providers.llmgateway"]\nname = "x"\n',
    'model_providers.llmgateway', ['name = "LLM Gateway"']);
  assert.ok(other.includes('["model_providers.llmgateway"]'), '不该动用户那张同名但不同层级的表');
  assert.ok(other.includes('[model_providers.llmgateway]'), '应当另加正确的嵌套表');
});

t('Codex：写回只动自己那一块 —— 多行字符串里的连续空行不得被折叠', () => {
  // 旧实现 `lines.join('\n').replace(/\n{3,}/g,'\n\n')` 对**整份文本**做全局替换，
  // 用户在 """ 里写的空行会被悄悄改掉（line1\n\n\n\nline5 → line1\n\nline5）。
  // 文件仍然合法，所以任何闸门都不会察觉 —— 但它违反了 util.js 自己的铁律③
  //「只动自己那一小块」。
  const before = [
    'model_provider = "llmgateway"',
    '',
    '[mcp_servers.keepme]',
    'command = "x"',
    'prompt = """',
    'line1',
    '',
    '',
    '',
    'line5',
    '"""',
    '',
    '',
    '',
    '[other]',
    'k = 1',
    '',
  ].join('\n');
  const after = util.tomlUpsertTable(before, 'model_providers.llmgateway', ['name = "LLM Gateway"']);
  assert.ok(after.includes('line1\n\n\n\nline5'),
    '多行字符串内部的连续空行必须原样保留。实际片段：'
    + JSON.stringify(after.slice(after.indexOf('"""'), after.indexOf('line5') + 6)));
  assert.ok(after.includes('[mcp_servers.keepme]') && after.includes('command = "x"'), '用户原有内容不得丢');
  assert.ok(!/\n\n\n+\[other\]/.test(after), '代码区的多余空行仍应被折叠（这是原本的意图）');
});

t('注册表：目标清单里**不含**已停服的 iFlow CLI', () => {
  // iFlow CLI 官方公告 2026-03-20 停止维护、2026-04-17 正式关闭，API 与模型库同步关停。
  // 这条测试是"回归钉"：防止以后有人从旧文档里把它加回来。
  const ids = writers.list().map((t) => t.id);
  assert.ok(!ids.includes('iflow'), 'iFlow CLI 已停服，不该再作为写入目标。当前清单：' + ids.join(', '));
  assert.strictEqual(writers.get('iflow'), null, 'writers.get("iflow") 应返回 null');
  // 且未知目标要给出明确错误而不是抛（界面按这个分支提示）
  const p = writers.preview('iflow', {});
  assert.strictEqual(p.ok, false);
  assert.ok(/未知目标/.test(p.errors.join('')), '应提示未知目标');
});

/* ================================================================
 * OpenCode
 * ================================================================ */

t('OpenCode：新增 provider 并指向顶层 model；其它 provider 保留、baseURL 带 /v1', () => {
  const home = newHome('oc-apply');
  const dir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'opencode.json');
  const original = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { existing: { npm: '@ai-sdk/openai', name: 'Existing' } },
    theme: 'dark',
  }, null, 2) + '\n';
  fs.writeFileSync(file, original, 'utf8');

  const r = opencode.apply(ctxFor(home, { model: 'glm-5.2' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const prov = after.provider.llmgateway;
  assert.ok(prov, '应新增 llmgateway provider');
  assert.strictEqual(prov.npm, '@ai-sdk/openai-compatible');
  assert.strictEqual(prov.options.baseURL, `http://127.0.0.1:${PORT}/v1`);
  assert.strictEqual(prov.options.apiKey, KEY);
  assert.ok(prov.models['glm-5.2'], '应列出网关模型');
  assert.strictEqual(after.model, 'llmgateway/glm-5.2');
  assert.ok(after.provider.existing, '用户原有的 provider 必须保留');
  assert.strictEqual(after.theme, 'dark', '无关顶层键必须保留');
});

/* ================================================================
 * 通用环境变量脚本
 * ================================================================ */

t('通用脚本：生成四个文件，端点区分 OpenAI（带 /v1）与 Anthropic（不带 /v1）', () => {
  const home = newHome('env-apply');
  const r = envscript.apply(ctxFor(home));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.files.length, 4);

  const cmd = fs.readFileSync(path.join(envscript.dirOf(ctxFor(home)), 'llm-gateway-env.cmd'), 'utf8');
  assert.ok(cmd.includes(`set "OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1"`));
  assert.ok(cmd.includes(`set "ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT}"`));
  assert.ok(cmd.includes(`set "OPENAI_API_KEY=${KEY}"`));

  const txt = fs.readFileSync(path.join(envscript.dirOf(ctxFor(home)), 'endpoints.txt'), 'utf8');
  assert.ok(txt.includes('不带 /v1'), '速查里要写明 Anthropic 端点不带 /v1');
  assert.ok(txt.includes('Cline'), '要说明 Cline 这类不能代写的客户端怎么办');
});

/* ================================================================
 * dsh（走引擎自己的 --write-dsh）
 * ================================================================ */

t('dsh：写入走引擎 --write-dsh，成功后 settings.yaml 与 credentials 都就位', async () => {
  const home = newHome('dsh-apply');
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
  const ctx = ctxFor(home);
  const p = dshTarget.preview(ctx);
  assert.ok(p.files.length >= 2, '至少预览 settings.yaml 与 .credentials.yaml');
  assert.ok(p.warnings.some((w) => w.includes('重启 dsh')), '必须提示要重启 dsh 才生效');

  const r = await dshTarget.apply(ctx);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors) + ' ' + r.output);

  const settings = fs.readFileSync(path.join(home, '.dsh', 'settings.yaml'), 'utf8');
  assert.ok(settings.includes('llm-pi-ai:'), '应有 llm-pi-ai 段');
  assert.ok(settings.includes('    gateway:'), '应有 gateway 条目');
  assert.ok(settings.includes(`baseURL: http://127.0.0.1:${PORT}/v1`), '默认（非 claude 仿真）协议应带 /v1');
  assert.ok(settings.includes(`- id: 'glm-5.2'`), '应写入逻辑模型名');

  const creds = fs.readFileSync(path.join(home, '.dsh', '.credentials.yaml'), 'utf8');
  assert.ok(creds.includes('DSH_GATEWAY_API_KEY:'), '凭据里应有统一 Key 的 ref');
  assert.ok(creds.includes(KEY));
});

t('dsh：clientProfile=claude 时协议切成 anthropic-messages 且 baseURL **不带 /v1**', async () => {
  const home = newHome('dsh-claude');
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
  const claudeCfg = Object.assign({}, CFG, { clientProfile: 'claude' });
  const ctx = ctxFor(home, {}, claudeCfg);
  const p = dshTarget.preview(ctx);
  assert.strictEqual(p.wire.api, 'anthropic-messages');
  assert.strictEqual(p.wire.baseURL, `http://127.0.0.1:${PORT}`, 'Anthropic SDK 自拼 /v1/messages，这里不能再带 /v1');
  const r = await dshTarget.apply(ctx);
  assert.strictEqual(r.ok, true, r.output);
  const settings = fs.readFileSync(path.join(home, '.dsh', 'settings.yaml'), 'utf8');
  assert.ok(settings.includes('api: anthropic-messages'));
  assert.ok(settings.includes(`baseURL: http://127.0.0.1:${PORT}\n`), '不应出现 /v1 后缀');
  assert.ok(settings.includes('compat:'), 'anthropic 协议应带上 allowEmptySignature 兼容声明');
});

t('dsh：重复写入是幂等的，且不破坏文件里已有的其它 section', async () => {
  const home = newHome('dsh-idem');
  const dir = path.join(home, '.dsh');
  fs.mkdirSync(dir, { recursive: true });
  const setPath = path.join(dir, 'settings.yaml');
  fs.writeFileSync(setPath, [
    'locale: zh-CN',
    'llm-pi-ai:',
    '  providers:',
    '    kingrouter:',
    '      apiKeyEnv: KINGROUTER_API_KEY',
    '      models:',
    "        - id: 'kimi-k3'",
    '',
  ].join('\n'), 'utf8');

  const ctx = ctxFor(home);
  const r1 = await dshTarget.apply(ctx);
  assert.strictEqual(r1.ok, true, r1.output);
  const text1 = fs.readFileSync(setPath, 'utf8');
  assert.ok(text1.includes('kingrouter:'), '用户已有的其它供应商必须保留');
  assert.ok(text1.includes('locale: zh-CN'), '其它 section 必须保留');

  const r2 = await dshTarget.apply(ctx);
  assert.strictEqual(r2.ok, true, r2.output);
  const text2 = fs.readFileSync(setPath, 'utf8');
  assert.strictEqual(text2, text1, '第二次写入结果应完全相同');
  assert.strictEqual((text2.match(/^ {4}gateway:$/gm) || []).length, 1, '不得出现重复 gateway 条目');
});

/* ================================================================
 * 注册表
 * ================================================================ */

t('dsh：**绝不写真实主目录** —— 写入位置严格由 ctx.home 决定（回归：曾污染过真实 ~/.dsh）', async () => {
  const home = newHome('dsh-sandbox');
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
  const ctx = ctxFor(home);
  const r = await dshTarget.apply(ctx);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors) + ' ' + r.output);
  // 引擎在不传 --settings/--credentials 时会用 os.homedir() 自己解析路径 —— 那样测试就会
  // 写进用户的真实 ~/.dsh（本次实测踩到，还改掉了 .credentials.yaml 里的统一 Key）。
  // 这条断言把"传入的路径 == 实际写出的路径"钉死。
  for (const f of [ctx.configPath, path.join(home, '.dsh', 'settings.yaml'), path.join(home, '.dsh', '.credentials.yaml')]) {
    assert.ok(f.startsWith(os.tmpdir()), '测试产物必须落在临时目录：' + f);
  }
  assert.deepStrictEqual(r.files.sort(), [
    path.join(home, '.dsh', '.credentials.yaml'),
    path.join(home, '.dsh', 'settings.yaml'),
  ].sort());
  // 真实主目录不得被这次测试触碰
  const realSettings = path.join(os.homedir(), '.dsh', 'settings.yaml');
  const realExists = fs.existsSync(realSettings);
  if (realExists) {
    const t = fs.readFileSync(realSettings, 'utf8');
    assert.ok(!t.includes('dsh-gateway-test-0123456789abcdef'), '真实主目录的 settings.yaml 不得含测试 Key');
  }
});

t('通用脚本：生成的 shell 脚本必须正确转义（防"外来字符串跳出引号执行命令"）', () => {
  const home = newHome('env-escape');
  // 构造恶意输入：模型名可能来自上游返回的目录（外来字符串）；Key 也可能被手工改成怪字符
  const evil = Object.assign({}, CFG, {
    providers: [{
      id: 'p1',
      baseURL: 'https://relay.example.org/v1',
      apiKey: 'k',
      models: ['m&del /f /q C:\\important', 'm" & calc', "m'$(calc)"],
      enabled: true,
    }],
  });
  const ctx = ctxFor(home, {}, evil);
  ctx.apiKey = "lgw-" + 'a'.repeat(30) + "'$(calc)'";   // 含单引号（cmd 里无害，sh/ps1 里必须逃逸）
  const r = envscript.apply(ctx);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const dir = envscript.dirOf(ctx);

  // ---- cmd ----
  const cmd = fs.readFileSync(path.join(dir, 'llm-gateway-env.cmd'), 'utf8');
  for (const l of cmd.split('\r\n').filter((x) => /^echo\s/i.test(x.trim()))) {
    assert.ok(!/[&|<>^]/.test(l), 'cmd 的 echo 行不得含命令元字符：' + l);
  }
  for (const l of cmd.split('\r\n').filter((x) => /^set "/.test(x))) {
    assert.ok(l.endsWith('"') && (l.match(/"/g) || []).length === 2, 'set 行引号必须成对：' + l);
    assert.ok(!/%(?!%)/.test(l), 'set 行里单个 % 必须被转义成 %%：' + l);
  }

  // ---- PowerShell ----
  const ps1 = fs.readFileSync(path.join(dir, 'llm-gateway-env.ps1'), 'utf8');
  for (const l of ps1.split('\n').filter((x) => /^\$env:/.test(x))) {
    assert.ok(/=\s*'/.test(l), 'ps1 赋值必须用单引号串（$ 在单引号里才是字面量）：' + l);
  }
  assert.ok(ps1.includes("''$(calc)''"), 'ps1 里 Key 的单引号必须翻倍：' + (ps1.match(/\$env:OPENAI_API_KEY.*/) || [''])[0]);
  assert.ok(ps1.includes("m''$(calc)"), 'ps1 里模型名的单引号必须翻倍');
  // 动态内容不得出现在双引号串里（PowerShell 双引号会展开 $）；静态提示行可以
  for (const l of ps1.split('\n').filter((x) => /Write-Host\s+"/.test(x))) {
    assert.ok(!/\$\(|\$\{|\$env|calc/.test(l), 'Write-Host 的双引号串里不得含动态内容：' + l);
  }
  assert.ok(!/Write-Host\s+"[^"]*"\s*\+/.test(ps1), '动态内容必须改用单引号串拼接');

  // ---- POSIX sh ----
  const sh = fs.readFileSync(path.join(dir, 'llm-gateway-env.sh'), 'utf8');
  for (const l of sh.split('\n').filter((x) => /^export /.test(x))) {
    assert.ok(/='/.test(l) && l.endsWith("'"), 'sh 赋值必须整体单引号包裹：' + l);
  }
  assert.ok(sh.includes("'\\''"), "sh 里 Key 的单引号必须用 '\\'' 逃逸");
});

t('通用脚本：Key 含双引号时 .cmd 必须降级为注释并给出警告，而不是写出会被注入的行', () => {
  const home = newHome('env-badkey');
  const ctx = ctxFor(home);
  ctx.apiKey = 'lgw-' + 'a'.repeat(30) + '" & echo PWNED';
  const p = envscript.preview(ctx);
  assert.ok(p.warnings.some((w) => w.includes('.cmd')), '必须警告 .cmd 有省略项：' + JSON.stringify(p.warnings));
  const r = envscript.apply(ctx);
  assert.strictEqual(r.ok, true);
  const cmd = fs.readFileSync(path.join(envscript.dirOf(ctx), 'llm-gateway-env.cmd'), 'utf8');
  assert.ok(!/echo PWNED/.test(cmd), '.cmd 里绝不能出现注入的命令');
  assert.ok(/已省略/.test(cmd), '应留下"已省略"的注释说明');
  // 其它两个 shell 能安全表示，应正常写入
  const sh = fs.readFileSync(path.join(envscript.dirOf(ctx), 'llm-gateway-env.sh'), 'utf8');
  assert.ok(sh.includes('echo PWNED'), 'sh 单引号串能安全容纳任意字符');
});

t('注册表：list() 的返回值可被结构化克隆（不得含函数——那会让整个 IPC 挂掉）', () => {
  const list = writers.list();
  // 5 个目标：dsh / claude-code / codex / opencode / envscript
  //（原为 6 个，iFlow CLI 停服后于 2026-10 移除）
  assert.ok(list.length >= 5, '目标数应 ≥ 5，实际 ' + list.length);
  for (const tgt of list) {
    for (const [k, v] of Object.entries(tgt)) {
      assert.notStrictEqual(typeof v, 'function', `${tgt.id}.${k} 不能是函数`);
    }
  }
  // 模拟 structuredClone（Electron IPC 用的就是它）
  assert.doesNotThrow(() => structuredClone(list));
});

t('注册表：每个目标都能 detect / preview 而不抛', () => {
  const home = newHome('all-detect');
  const ctx = ctxFor(home);
  const all = writers.detectAll(ctx);
  assert.strictEqual(all.length, writers.TARGETS.length);
  for (const tgt of writers.TARGETS) {
    const d = all.find((x) => x.id === tgt.id);
    assert.ok(d, tgt.id + ' 应有 detect 结果');
    assert.ok(Array.isArray(d.evidence));
    const p = writers.preview(tgt.id, ctx);
    assert.strictEqual(p.ok, true, tgt.id + ' preview 不该失败：' + JSON.stringify(p.errors));
    assert.ok(Array.isArray(p.files));
    // 预览必须能被结构化克隆（要经 IPC 送到界面）
    assert.doesNotThrow(() => structuredClone(p), tgt.id + ' 的预览必须可结构化克隆');
  }
});

t('注册表：未知目标返回错误而不是抛', () => {
  const r = writers.preview('nope', ctxFor(newHome('unk')));
  assert.strictEqual(r.ok, false);
});

/* ================================================================
 * 第五轮审计修复的回归钉子
 * ================================================================ */

// —— F2：写入失败时也必须把"已经生成的备份"报出来 ——
// 失败通常发生在最后的 rename，而备份在那之前就生成了。界面拿不到这个路径的话，
// 用户会在"写入失败"的困惑里把旁边那份唯一的原始备份当垃圾删掉。
t('F2：写入失败时仍返回 backup（备份已生成，不能被丢弃）', () => {
  const home = newHome('f2');
  const p = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const original = JSON.stringify({ env: { OLD: '1' }, keep: 1 }, null, 2);
  fs.writeFileSync(p, original, 'utf8');
  const bak = p + util.BACKUP_SUFFIX;

  // 让 rename 必然失败：把目标文件设为只读
  fs.chmodSync(p, 0o444);
  const r = util.writeAtomic(p, '{"new":true}');

  assert.strictEqual(r.ok, false, '只读目标上的写入应当失败');
  assert.ok(fs.existsSync(bak), '备份应当已经生成');
  assert.strictEqual(r.backup, bak, '失败返回里必须带回 backup 路径');
  assert.strictEqual(fs.readFileSync(bak, 'utf8'), original, '备份内容必须是原始文件');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), original, '失败时原文件不得被改动');
  fs.chmodSync(p, 0o644);
});

t('F2：各目标在写入失败时都把 backups 带出来', async () => {
  const cases = [
    ['claude-code', '.claude/settings.json', '{"env":{"OLD":"1"}}'],
    ['codex', '.codex/config.toml', 'model = "old"\n'],
    ['opencode', '.config/opencode/opencode.json', '{"keep":1}'],
    // envscript 写的是 <home>/clients/ 下的四个文件，名字由它自己决定 ——
    // 这里用 buildFiles 拿真实名字，别写死（写死过一次，测试因此假通过）
    ['envscript', null, '# old\n'],
  ];
  for (const [id, rel, body] of cases) {
    const home = newHome('f2-' + id);
    const ctx = ctxFor(home);
    const mod = writers.get(id);
    const realRel = rel || path.relative(home, path.join(mod.dirOf(ctx), mod.buildFiles(ctx).files[0].name));
    const p = path.join(home, realRel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
    fs.chmodSync(p, 0o444);
    const r = await writers.apply(id, ctx);
    assert.strictEqual(r.ok, false, id + ' 在只读目标上应当失败（检查路径：' + realRel + '）');
    const baks = (r.backups && r.backups.length ? r.backups : (r.backup ? [r.backup] : []));
    assert.ok(baks.length > 0, id + ' 失败返回必须带出备份路径（界面要靠它提示用户别删）');
    assert.ok(baks.some((b) => b.startsWith(p)), id + ' 备份路径应当指向目标文件');
    fs.chmodSync(p, 0o644);
  }
});

// —— F1：目标 config.toml 本身不合法时必须拦下 ——
// 旧实现只校验"改完的"文本，从不看原文件；于是用户手工编辑漏个等号，
// 我们照样写进去并弹"写入成功"，而 Codex 自己的解析器读不了这份文件。
t('F1：codex 目标在现有 config.toml 不合法时拦下，且不写入', async () => {
  const BAD = [
    'this line has no equals sign\n',
    '[unclosed table\n',
    '{ this is not json \n',
    '[t]\nk = 1\nnot_a_kv\n',
    'model = "unterminated\n',
    'model = "a"\nmodel = "b"\n',
  ];
  for (const bad of BAD) {
    const home = newHome('f1');
    const p = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bad, 'utf8');

    const pv = await writers.preview('codex', ctxFor(home));
    assert.ok((pv.guard || []).length > 0, 'preview 必须给出 guard：' + JSON.stringify(bad));

    const ap = await writers.apply('codex', ctxFor(home));
    assert.strictEqual(ap.ok, false, 'apply 必须失败：' + JSON.stringify(bad));
    assert.strictEqual(fs.readFileSync(p, 'utf8'), bad, '原文件必须一字未动');
  }
});

t('F1 反向：合法的 config.toml 不能被误伤（含跨行数组、多行字符串、注释）', async () => {
  const GOOD = [
    'model = "gpt-5"\n',
    'args = [\n  "-y",\n  "pkg",\n]\n',
    'txt = """\n[brackets]\nno equals\n"""\nk = 1\n',
    '[a.b] # comment\nk = 1\n',
    '# only a comment\n',
    '',
    '[[srv]]\nname = "a"\n',
    'x = "]" \ny = "["\n',
  ];
  for (const good of GOOD) {
    assert.strictEqual(util.tomlValidate(good), '', '不该被误判：' + JSON.stringify(good));
    const home = newHome('f1ok');
    const p = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, good, 'utf8');
    const ap = await writers.apply('codex', ctxFor(home));
    assert.strictEqual(ap.ok, true, '合法文件应当写成功：' + JSON.stringify(good) + ' → ' + JSON.stringify(ap.errors));
    const after = fs.readFileSync(p, 'utf8');
    assert.ok(after.includes('model_providers.llmgateway'), '应写入 gateway 表');
    assert.strictEqual(util.tomlValidate(after), '', '写完后仍须合法');
  }
});

// —— F8：envscript.restore 部分失败时 errors 不能是空的 ——
t('F8：envscript 恢复部分失败时 errors 带出真实原因', async () => {
  const home = newHome('f8');
  const ctx = ctxFor(home);
  const first = await writers.apply('envscript', ctx);
  assert.strictEqual(first.ok, true, '首次写入应成功');
  const second = await writers.apply('envscript', ctx);
  assert.strictEqual(second.ok, true, '二次写入应成功（生成 before-restore 备份）');

  // 让其中一个目标文件无法写回 → 恢复时该条必失败
  const one = first.files[0];
  fs.chmodSync(one, 0o444);
  const r = await writers.restore('envscript', ctx);
  fs.chmodSync(one, 0o644);

  assert.strictEqual(r.ok, false, '应当报告失败');
  assert.ok((r.errors || []).length > 0, 'errors 不能为空 —— 否则界面只能显示"未知错误"');
  assert.ok(r.errors.some((e) => e.includes(one) || /EPERM|denied|permitted/i.test(e)),
    'errors 里应当能看到是哪个文件、什么原因：' + JSON.stringify(r.errors));
});

// —— F5：detectAll 的兜底分支必须带 wire（dsh 的线协议提示靠它）——
t('F5：detect 抛异常时，dsh 的兜底结果仍带 wire', () => {
  const dsh = writers.get('dsh');
  const orig = dsh.detect;
  const base = { config: { clientProfile: 'claude' }, port: PORT, home: process.env.USERPROFILE };
  dsh.detect = () => { throw new Error('注入故障：模拟 settings.yaml 不可读'); };
  try {
    const d = writers.detectAll(base).find((x) => x.id === 'dsh');
    assert.ok(d, '兜底分支仍应产出一条 dsh 记录');
    assert.strictEqual(d.installed, false);
    assert.ok(d.wire, '兜底分支必须带 wire —— 否则界面显示"（未知）"，用户无法预判线协议');
    assert.strictEqual(d.wire.api, 'anthropic-messages', 'clientProfile=claude 应为 anthropic');
    assert.ok(!/\/v1$/.test(d.wire.baseURL), 'claude 形态的 baseURL 不带 /v1');
  } finally {
    dsh.detect = orig;
  }
  // 正常运行路径不受影响
  const normal = writers.detectAll({ config: { clientProfile: '' }, port: PORT, home: process.env.USERPROFILE })
    .find((x) => x.id === 'dsh');
  assert.ok(normal.wire, '正常路径本来就有 wire');
});

// —— 目标显示名必须一致（卡片标题与预览弹窗标题是同一个）——
t('显示名一致：注册表的 name 与 preview.name 必须相同', () => {
  for (const item of writers.list()) {
    const mod = writers.get(item.id);
    const pv = mod.preview(ctxFor(newHome('nm-' + item.id)));
    if (pv && pv.name) {
      assert.strictEqual(item.name, pv.name, item.id + ' 的卡片名与预览名不一致');
    }
  }
});

run();
